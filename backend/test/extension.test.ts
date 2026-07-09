import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

test('computer-action tasks surface at extension check-in; others do not', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'x1', rawText: 'post the beta announcement on x when I get to my laptop', source: 'voice' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'x2', rawText: 'water the garden plants', source: 'voice' },
  });
  await ctx.jobs.onIdle();

  const device = await ctx.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: auth(token),
    payload: { platform: 'extension', capabilities: { canShowPopups: true } },
  });

  const checkin = await ctx.app.inject({
    method: 'POST',
    url: '/v1/extension/checkin',
    headers: auth(token),
    payload: { deviceId: device.json().id },
  });
  const items = checkin.json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'x1');
  assert.equal(items[0].contextTag, 'computer-action');
});

test('completing in the popup clears it everywhere; completing on phone withdraws the popup', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'x3', rawText: 'reply to the github issue about onboarding', source: 'voice' },
  });
  await ctx.jobs.onIdle();

  // Popup completes via the normal op path…
  await ctx.app.inject({ method: 'POST', url: '/v1/items/x3/complete', headers: auth(token) });
  // …and the item is gone from the next check-in (and from the phone's queue).
  const checkin = await ctx.app.inject({
    method: 'POST',
    url: '/v1/extension/checkin',
    headers: auth(token),
    payload: {},
  });
  assert.equal(checkin.json().items.length, 0);
  const queue = (await ctx.app.inject({ method: 'GET', url: '/v1/queue', headers: auth(token) })).json();
  assert.ok(!queue.some((i: { id: string }) => i.id === 'x3'));
});

test('user can toggle computer-action per item ("show me this on my laptop")', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'x4', rawText: 'renew the domain' },
  });
  await ctx.app.inject({
    method: 'PATCH',
    url: '/v1/items/x4',
    headers: auth(token),
    payload: { contextTag: 'computer-action' },
  });
  const checkin = await ctx.app.inject({
    method: 'POST',
    url: '/v1/extension/checkin',
    headers: auth(token),
    payload: {},
  });
  assert.equal(checkin.json().items[0].id, 'x4');
});
