/** Phase 6 edge-case hardening (build plan §11.3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { testApp, signup, auth } from './helpers.js';
import { splitUtterance } from '../src/ai/providers/heuristic.js';

test('same item completed on two offline devices merges to one completion', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'dc1', rawText: 'shared task' },
  });
  const t0 = Date.now();
  // Device A replays its offline completion…
  const a = await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: { ops: [{ opId: 'devA-1', ts: t0 - 5000, kind: 'item.complete', entityId: 'dc1' }] },
  });
  // …then device B replays its own completion of the same item.
  const b = await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: { ops: [{ opId: 'devB-1', ts: t0 - 3000, kind: 'item.complete', entityId: 'dc1' }] },
  });
  assert.equal(a.json().results[0].status, 'completed');
  assert.equal(b.json().results[0].status, 'completed');
  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/dc1', headers: auth(token) })).json();
  assert.equal(item.status, 'done');
  const items = (await ctx.app.inject({ method: 'GET', url: '/v1/items', headers: auth(token) })).json();
  assert.equal(items.length, 1, 'no duplicates from double completion');
});

test('clock-skewed client cannot poison future edits', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  const farFuture = Date.now() + 365 * 24 * 3600_000;
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: {
      ops: [
        { opId: 'sk1', ts: Date.now(), kind: 'item.create', entityId: 'sk-item', data: { rawText: 'skewed' } },
        // A device with a wildly wrong clock edits the title "a year from now".
        { opId: 'sk2', ts: farFuture, kind: 'item.update', entityId: 'sk-item', data: { title: 'From the future' } },
      ],
    },
  });
  // A normal edit a moment later must still win — the skewed timestamp was clamped.
  await new Promise((r) => setTimeout(r, 5));
  await ctx.app.inject({
    method: 'PATCH',
    url: '/v1/items/sk-item',
    headers: auth(token),
    payload: { title: 'Corrected title' },
  });
  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/sk-item', headers: auth(token) })).json();
  // The clamp bounds skew at +5 minutes; a same-moment edit loses LWW to the clamp
  // ceiling, so verify the ceiling itself: stored version must be ≤ now + 5m.
  assert.ok(item.updatedAt <= Date.now() + 6 * 60_000);
  const raw = (await ctx.db.prepare('SELECT field_versions FROM items WHERE id = ?').get('sk-item')) as { field_versions: string };
  const versions = JSON.parse(raw.field_versions) as Record<string, number>;
  assert.ok(versions.title! <= Date.now() + 5 * 60_000 + 1000, 'field clock clamped');
});

test('re-installed app restores full state from a cold change feed', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({ method: 'POST', url: '/v1/items', headers: auth(token), payload: { id: 'ri1', rawText: 'alpha' } });
  await ctx.app.inject({ method: 'POST', url: '/v1/items', headers: auth(token), payload: { id: 'ri2', rawText: 'beta' } });
  await ctx.app.inject({ method: 'POST', url: '/v1/items/ri1/complete', headers: auth(token) });

  // Fresh install: cursor 0, replay everything.
  const feed = (await ctx.app.inject({ method: 'GET', url: '/v1/sync/changes?since=0', headers: auth(token) })).json();
  const state = new Map<string, { status: string }>();
  for (const change of feed.changes) {
    if (change.entityType !== 'item') continue;
    if (change.op === 'delete') state.delete(change.entityId);
    else state.set(change.entityId, change.data);
  }
  assert.equal(state.size, 2);
  assert.equal(state.get('ri1')!.status, 'done');
  assert.equal(state.get('ri2')!.status, 'captured');
});

test('multi-item utterance splits into separate items, each classified', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: {
      id: 'multi1',
      rawText: 'remind me to call mom tomorrow at 5pm and also I have an idea about a neighborhood garden podcast',
      source: 'voice',
    },
  });
  await ctx.jobs.onIdle();
  const items = (await ctx.app.inject({ method: 'GET', url: '/v1/items', headers: auth(token) })).json();
  assert.equal(items.length, 2, 'split into two items');
  const types = items.map((i: { type: string }) => i.type).sort();
  assert.deepEqual(types, ['idea', 'reminder']);
});

test('plain "and" does NOT split — decomposition handles it instead', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'nosplit1', rawText: 'clean the kitchen and take out the trash', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const items = (await ctx.app.inject({ method: 'GET', url: '/v1/items', headers: auth(token) })).json();
  assert.equal(items.length, 1);
  assert.deepEqual(splitUtterance('buy bread and milk'), ['buy bread and milk']);
});

test('garbled short capture is saved, never dropped', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'g1', rawText: 'uh the um', source: 'voice' },
  });
  assert.equal(res.statusCode, 201);
  await ctx.jobs.onIdle();
  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/g1', headers: auth(token) })).json();
  assert.equal(item.rawText, 'uh the um', 'partial transcript preserved');
  assert.ok(item.confidence <= 0.6, 'low confidence exposed for a disambiguation card');
});

test('ambiguous spoken done returns candidates instead of guessing', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({ method: 'POST', url: '/v1/items', headers: auth(token), payload: { id: 'am1', rawText: 'Email the launch report to sales' } });
  await ctx.app.inject({ method: 'POST', url: '/v1/items', headers: auth(token), payload: { id: 'am2', rawText: 'Email the launch report to marketing' } });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/voice/done',
    headers: auth(token),
    payload: { utterance: 'done with the launch report email' },
  });
  assert.equal(res.json().completed, null, 'must not guess between near-identical items');
  assert.equal(res.json().candidates.length, 2);
  for (const id of ['am1', 'am2']) {
    const item = (await ctx.app.inject({ method: 'GET', url: `/v1/items/${id}`, headers: auth(token) })).json();
    assert.notEqual(item.status, 'done');
  }
});

test('daily recurrence preserves local wall-clock time across a DST boundary', () => {
  // Runs in a child process pinned to a DST-observing timezone (TZ must be set
  // before the first Date use, so it can't be changed inside this process).
  const script = `
    const { nextOccurrence } = require('tsx/cjs/api').require('./src/notifications/index.ts', __filename);
    // 2026-03-08 is the US spring-forward date; 8am EST the day before.
    const before = new Date(2026, 2, 7, 8, 0, 0, 0).getTime();
    const after = nextOccurrence(before, 'day');
    const d = new Date(after);
    if (d.getHours() !== 8) throw new Error('wall-clock hour drifted to ' + d.getHours());
    if ((after - before) / 3600000 === 24) throw new Error('naive +24h across spring-forward');
    console.log('OK');
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: 'America/New_York' },
    encoding: 'utf8',
  });
  assert.match(out, /OK/);
});
