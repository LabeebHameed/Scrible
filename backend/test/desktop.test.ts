/** Phase 7: desktop app-launch triggers. Matching happens ON DEVICE — the server
 *  only stores the trigger name and serves app-triggered items at check-in. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';
import { parseAppTrigger } from '../src/ai/providers/heuristic.js';

test('parseAppTrigger extracts explicit app-launch phrasing only', () => {
  assert.equal(parseAppTrigger('when I open photoshop remind me to export the banner'), 'photoshop');
  assert.equal(parseAppTrigger("next time I'm in figma update the icon set"), 'figma');
  assert.equal(parseAppTrigger('remind me to export the banner when I launch Premiere Pro'), 'premiere pro');
  assert.equal(parseAppTrigger('whenever I start slack, check the design channel'), 'slack');
  assert.equal(parseAppTrigger('buy milk and eggs'), null, 'no app phrasing → no trigger');
  assert.equal(parseAppTrigger('when I open it later'), null, 'too short / pronoun rejected');
});

test('capture with app phrasing gets appTrigger + computer-action tag', async () => {
  const ctx = testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'dt1', rawText: 'when I open photoshop remind me to export the launch banner', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/dt1', headers: auth(token) })).json();
  assert.equal(item.appTrigger, 'photoshop');
  assert.equal(item.contextTag, 'computer-action');
});

test('desktop checkin returns only open app-triggered items; completion withdraws them', async () => {
  const ctx = testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'dt2', rawText: "next time I'm in figma update the onboarding icons", source: 'voice' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'dt3', rawText: 'water the plants', source: 'voice' },
  });
  await ctx.jobs.onIdle();

  const device = await ctx.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: auth(token),
    payload: { platform: 'desktop', capabilities: { canWatchApps: true } },
  });
  assert.equal(device.statusCode, 201);

  const checkin = await ctx.app.inject({
    method: 'POST',
    url: '/v1/desktop/checkin',
    headers: auth(token),
    payload: { deviceId: device.json().id },
  });
  const items = checkin.json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'dt2');
  assert.equal(items[0].appTrigger, 'figma');

  // Completing (from any surface) withdraws it from the next check-in.
  await ctx.app.inject({ method: 'POST', url: '/v1/items/dt2/complete', headers: auth(token) });
  const after = await ctx.app.inject({
    method: 'POST',
    url: '/v1/desktop/checkin',
    headers: auth(token),
    payload: {},
  });
  assert.equal(after.json().items.length, 0);
});

test('appTrigger can be set and cleared manually and syncs like any field', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'dt4', rawText: 'polish the pitch deck' },
  });
  await ctx.app.inject({
    method: 'PATCH',
    url: '/v1/items/dt4',
    headers: auth(token),
    payload: { appTrigger: 'keynote' },
  });
  let item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/dt4', headers: auth(token) })).json();
  assert.equal(item.appTrigger, 'keynote');

  await ctx.app.inject({
    method: 'PATCH',
    url: '/v1/items/dt4',
    headers: auth(token),
    payload: { appTrigger: null },
  });
  item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/dt4', headers: auth(token) })).json();
  assert.equal(item.appTrigger, null);
});

test('app_watcher consent grant/revoke roundtrip', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);
  const grant = await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'app_watcher', policyVersion: 'v1' },
  });
  assert.equal(grant.statusCode, 201);
  let consents = (await ctx.app.inject({ method: 'GET', url: '/v1/consents', headers: auth(token) })).json();
  assert.equal(consents.app_watcher.granted, true);
  await ctx.app.inject({ method: 'POST', url: '/v1/consents/app_watcher/revoke', headers: auth(token) });
  consents = (await ctx.app.inject({ method: 'GET', url: '/v1/consents', headers: auth(token) })).json();
  assert.equal(consents.app_watcher.granted, false);
});
