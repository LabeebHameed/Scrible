import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

test('reminder with explicit time gets a trigger and is delivered exactly once', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token, userId } = await signup(ctx);

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'r1', rawText: 'remind me to take the medicine in 1 minute', source: 'voice' },
  });
  await ctx.jobs.onIdle();

  const reminders = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  assert.equal(reminders.length, 1);
  assert.ok(reminders[0].fireAt > Date.now());

  // Not due yet.
  assert.equal(await ctx.reminders.tick(Date.now()), 0);
  // Due: delivered once…
  const fireTime = reminders[0].fireAt + 1000;
  assert.equal(await ctx.reminders.tick(fireTime), 1);
  // …and never again (dedup across ticks/channels).
  assert.equal(await ctx.reminders.tick(fireTime + 60_000), 0);

  const outbox = await ctx.db.prepare('SELECT * FROM push_outbox WHERE user_id = ?').all(userId);
  assert.equal(outbox.length, 1);
});

test('completing an item suppresses its pending reminder', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token, userId } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'r2', rawText: 'remind me to submit the form in 1 minute', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  await ctx.app.inject({ method: 'POST', url: '/v1/items/r2/complete', headers: auth(token) });

  const [trigger] = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  assert.equal(await ctx.reminders.tick(trigger.fireAt + 1000), 0, 'no notification for a done item');
  assert.equal(((await ctx.db.prepare('SELECT COUNT(*) c FROM push_outbox WHERE user_id = ?').get(userId)) as { c: number }).c, 0);
});

test('snooze re-arms delivery at the later time', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'r3', rawText: 'remind me to stretch in 1 minute', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const [trigger] = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  await ctx.reminders.tick(trigger.fireAt + 1000); // delivered

  const snooze = await ctx.app.inject({
    method: 'POST',
    url: `/v1/reminders/${trigger.id}/snooze`,
    headers: auth(token),
    payload: { minutes: 10 },
  });
  assert.equal(snooze.statusCode, 200);
  assert.equal(await ctx.reminders.tick(Date.now()), 0, 'not due during snooze');
  assert.equal(await ctx.reminders.tick(Date.now() + 11 * 60_000), 1, 'fires after snooze');
});

test('recurring reminder schedules the next occurrence after firing', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'r4', rawText: 'remind me to review the inbox every day at 8am', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const [first] = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  assert.equal(first.recurrence, 'day');

  await ctx.reminders.tick(first.fireAt + 1000);
  const after = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  const pending = after.filter((r: { deliveredAt: number | null }) => !r.deliveredAt);
  assert.equal(pending.length, 1, 'next occurrence queued');
  assert.equal(pending[0].fireAt - first.fireAt, 24 * 3600_000);
});

test('reminder re-nags every 5 minutes until the 2h cap, then stops', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'r5', rawText: 'remind me to check the oven in 1 minute', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const [trigger] = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  const fireTime = trigger.fireAt + 1000;

  assert.equal(await ctx.reminders.tick(fireTime), 1, 'first delivery');
  assert.equal(await ctx.reminders.tick(fireTime + 60_000), 0, 'no re-nag within 5 minutes');
  assert.equal(await ctx.reminders.tick(fireTime + 5 * 60_000 + 1000), 1, 're-nags after 5 minutes');
  assert.equal(await ctx.reminders.tick(fireTime + 5 * 60_000 + 2000), 0, 'no re-nag immediately after re-nagging');
  assert.equal(await ctx.reminders.tick(fireTime + 2 * 3600_000 + 60_000), 0, 'stops nagging past the 2h cap');
});

test('POST /v1/reminders/:id/seen acknowledges a reminder and stops further re-nagging', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'r6', rawText: 'remind me to water the plants in 1 minute', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const [trigger] = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  const fireTime = trigger.fireAt + 1000;
  assert.equal(await ctx.reminders.tick(fireTime), 1, 'first delivery');

  const seen = await ctx.app.inject({
    method: 'POST',
    url: `/v1/reminders/${trigger.id}/seen`,
    headers: auth(token),
  });
  assert.equal(seen.statusCode, 200);
  assert.equal(await ctx.reminders.tick(fireTime + 5 * 60_000 + 1000), 0, 'acknowledged reminder never re-nags');
});

test('completing an item after first delivery stops further re-nagging', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'r7', rawText: 'remind me to call mom in 1 minute', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const [trigger] = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  const fireTime = trigger.fireAt + 1000;
  assert.equal(await ctx.reminders.tick(fireTime), 1, 'first delivery');

  await ctx.app.inject({ method: 'POST', url: '/v1/items/r7/complete', headers: auth(token) });
  assert.equal(await ctx.reminders.tick(fireTime + 5 * 60_000 + 1000), 0, 'completed reminder never re-nags');
});

test('confirmation notifications respect quiet hours but reminders do not', async () => {
  const ctx = await testApp();
  const { token, userId } = await signup(ctx);
  const hour = new Date().getHours();
  await ctx.app.inject({
    method: 'PATCH',
    url: '/v1/me',
    headers: auth(token),
    payload: { notificationPrefs: { quietHours: { start: hour, end: (hour + 2) % 24 } } },
  });
  const suppressed = await ctx.dispatcher.notify(userId, 'k1', 'Scrible', 'confirmation', {
    respectQuietHours: true,
  });
  assert.equal(suppressed, false);
  const fired = await ctx.dispatcher.notify(userId, 'k2', 'Scrible', 'reminder');
  assert.equal(fired, true);
});
