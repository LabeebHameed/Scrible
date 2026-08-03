import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

const grantAnalytics = (ctx: Awaited<ReturnType<typeof testApp>>, token: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'analytics', policyVersion: 'v1' },
  });

test('consent-off users generate zero analytics rows', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/analytics/events',
    headers: auth(token),
    payload: { events: [{ name: 'app.opened', props: { surface: 'ios' } }] },
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().stored, 0);
  assert.equal(((await ctx.db.prepare('SELECT COUNT(*) c FROM analytics_events').get()) as { c: number }).c, 0);
  assert.equal(
    ((await ctx.db.prepare('SELECT COUNT(*) c FROM analytics_ids').get()) as { c: number }).c,
    0,
    'no pseudo id minted',
  );
});

test('events are stored under a pseudonymous id, never the account id', async () => {
  const ctx = await testApp();
  const { token, userId } = await signup(ctx);
  await grantAnalytics(ctx, token);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/analytics/events',
    headers: auth(token),
    payload: {
      events: [
        { name: 'app.opened', props: { surface: 'android' } },
        { name: 'capture.completed', props: { surface: 'android', source: 'voice', durationMs: 2100 } },
      ],
    },
  });
  const rows = (await ctx.db.prepare('SELECT * FROM analytics_events').all()) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.pseudo_id, userId);
    assert.ok(!JSON.stringify(row).includes(userId), 'account id must not appear in any event row');
  }
});

test('taxonomy enforcement: unknown events, unknown props, and free text are rejected', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await grantAnalytics(ctx, token);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/analytics/events',
    headers: auth(token),
    payload: {
      events: [
        { name: 'made.up.event', props: {} },
        { name: 'item.created', props: { type: 'task', source: 'voice', surface: 'ios', title: 'buy milk' } },
        { name: 'item.created', props: { type: 'novel-type', source: 'voice', surface: 'ios' } },
        { name: 'item.created', props: { type: 'task', source: 'voice', surface: 'ios' } },
      ],
    },
  });
  assert.equal(res.json().stored, 1, 'only the fully-conformant event lands');
  assert.equal(res.json().dropped, 3);
  const rows = (await ctx.db.prepare('SELECT props FROM analytics_events').all()) as Array<{ props: string }>;
  assert.ok(!rows.some((r) => r.props.includes('milk')), 'no content text stored');
});

test('revoking analytics consent stops emission and unlinks history', async () => {
  const ctx = await testApp();
  const { token, userId } = await signup(ctx);
  await grantAnalytics(ctx, token);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/analytics/events',
    headers: auth(token),
    payload: { events: [{ name: 'app.opened', props: { surface: 'web' } }] },
  });
  const revoke = await ctx.app.inject({ method: 'POST', url: '/v1/consents/analytics/revoke', headers: auth(token) });
  assert.equal(revoke.json().purged.analytics_ids, 1, 'mapping erased');

  const after = await ctx.app.inject({
    method: 'POST',
    url: '/v1/analytics/events',
    headers: auth(token),
    payload: { events: [{ name: 'app.opened', props: { surface: 'web' } }] },
  });
  assert.equal(after.json().stored, 0);
  assert.equal(
    ((await ctx.db.prepare('SELECT COUNT(*) c FROM analytics_ids WHERE user_id = ?').get(userId)) as { c: number }).c,
    0,
  );
  // Historical event rows survive but are anonymous — nothing maps them back.
  assert.equal(((await ctx.db.prepare('SELECT COUNT(*) c FROM analytics_events').get()) as { c: number }).c, 1);
});

test('account deletion also unlinks analytics via USER_DATA_TABLES', async () => {
  const ctx = await testApp();
  const { token, userId } = await signup(ctx);
  await grantAnalytics(ctx, token);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/analytics/events',
    headers: auth(token),
    payload: { events: [{ name: 'app.opened', props: { surface: 'ios' } }] },
  });
  await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(token) });
  assert.equal(
    ((await ctx.db.prepare('SELECT COUNT(*) c FROM analytics_ids WHERE user_id = ?').get(userId)) as { c: number }).c,
    0,
  );
});

test('server-side instrumentation flows through the same consent gate', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  // No consent: enrichment happens, but no analytics row.
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'a1', rawText: 'water the plants', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  assert.equal(((await ctx.db.prepare('SELECT COUNT(*) c FROM analytics_events').get()) as { c: number }).c, 0);

  await grantAnalytics(ctx, token);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'a2', rawText: 'buy stamps', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const rows = await ctx.db.prepare("SELECT event FROM analytics_events WHERE event = 'item.created'").all();
  assert.equal(rows.length, 1);
});

test('data export contains the user data and only theirs', async () => {
  const ctx = await testApp();
  const a = await signup(ctx);
  const b = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(a.token),
    payload: { id: 'ex1', rawText: 'my exported task' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(b.token),
    payload: { id: 'ex2', rawText: 'someone elses secret' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(a.token),
    payload: { category: 'voice_processing', policyVersion: 'v1' },
  });

  const res = await ctx.app.inject({ method: 'GET', url: '/v1/me/export', headers: auth(a.token) });
  const body = res.json();
  assert.equal(body.format, 'scrible-export.v1');
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].rawText, 'my exported task');
  assert.equal(body.consents.voice_processing.granted, true);
  assert.ok(!JSON.stringify(body).includes('someone elses secret'), 'strict per-user isolation');
});

test('export never contains OAuth token material', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'calendar_access', policyVersion: 'v1' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/calendar/links',
    headers: auth(token),
    payload: { provider: 'google', tokens: { access_token: 'ya29.SECRET', refresh_token: 'REFRESH.SECRET' } },
  });
  const res = await ctx.app.inject({ method: 'GET', url: '/v1/me/export', headers: auth(token) });
  const raw = JSON.stringify(res.json());
  assert.ok(!raw.includes('SECRET'), 'token material excluded from export');
  assert.equal(res.json().calendarLinks[0].provider, 'google');
});
