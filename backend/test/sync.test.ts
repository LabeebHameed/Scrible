import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

test('offline op replay is idempotent', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  const ops = [
    {
      opId: 'op-1',
      ts: Date.now(),
      kind: 'item.create',
      entityId: 'item-1',
      data: { rawText: 'buy milk', source: 'voice' },
    },
  ];
  const first = await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: { ops },
  });
  assert.equal(first.json().results[0].status, 'created');

  // Client crashed before receiving ack and replays the same batch.
  const replay = await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: { ops },
  });
  assert.equal(replay.json().results[0].status, 'duplicate');

  const items = await ctx.app.inject({ method: 'GET', url: '/v1/items', headers: auth(token) });
  assert.equal(items.json().length, 1);
});

test('completions always survive conflicting edits', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  const t0 = Date.now();
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: {
      ops: [
        { opId: 'c1', ts: t0, kind: 'item.create', entityId: 'i1', data: { rawText: 'write report' } },
        // Device A completed the item offline at t0+1000.
        { opId: 'c2', ts: t0 + 1000, kind: 'item.complete', entityId: 'i1' },
        // Device B, with a LATER timestamp, tries to set it back to active via edit.
        { opId: 'c3', ts: t0 + 5000, kind: 'item.update', entityId: 'i1', data: { status: 'active', title: 'Write the report' } },
      ],
    },
  });
  const item = await ctx.app.inject({ method: 'GET', url: '/v1/items/i1', headers: auth(token) });
  assert.equal(item.json().status, 'done'); // completion survived
  assert.equal(item.json().title, 'Write the report'); // non-status field LWW applied
});

test('offline capture merges alongside concurrent online edits', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  // Online device creates an item.
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'online-1', rawText: 'online item' },
  });
  // Offline device replays a capture made hours earlier.
  const replay = await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: {
      ops: [
        {
          opId: 'off-1',
          ts: Date.now() - 3 * 3600_000,
          kind: 'item.create',
          entityId: 'offline-1',
          data: { rawText: 'captured in airplane mode', source: 'voice' },
        },
      ],
    },
  });
  assert.equal(replay.json().results[0].status, 'created');
  const items = await ctx.app.inject({ method: 'GET', url: '/v1/items', headers: auth(token) });
  assert.equal(items.json().length, 2);
});

test('LWW per field: stale edit does not overwrite newer edit', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  const t0 = Date.now();
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: {
      ops: [
        { opId: 'l1', ts: t0, kind: 'item.create', entityId: 'i2', data: { rawText: 'draft post' } },
        { opId: 'l2', ts: t0 + 2000, kind: 'item.update', entityId: 'i2', data: { title: 'Newer title' } },
        { opId: 'l3', ts: t0 + 1000, kind: 'item.update', entityId: 'i2', data: { title: 'Older title' } },
      ],
    },
  });
  const item = await ctx.app.inject({ method: 'GET', url: '/v1/items/i2', headers: auth(token) });
  assert.equal(item.json().title, 'Newer title');
});

test('change feed delivers catch-up after offline period', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  const before = await ctx.app.inject({
    method: 'GET',
    url: '/v1/sync/changes?since=0',
    headers: auth(token),
  });
  const cursor = before.json().latest;

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'feed-1', rawText: 'created while other device offline' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items/feed-1/complete',
    headers: auth(token),
  });

  const catchUp = await ctx.app.inject({
    method: 'GET',
    url: `/v1/sync/changes?since=${cursor}`,
    headers: auth(token),
  });
  const changes = catchUp.json().changes;
  assert.ok(changes.length >= 2);
  const last = changes[changes.length - 1];
  assert.equal(last.entityId, 'feed-1');
  assert.equal(last.data.status, 'done');
});

test('subtask lifecycle syncs through ops', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: {
      ops: [
        { opId: 's1', ts: Date.now(), kind: 'item.create', entityId: 'i3', data: { rawText: 'plan party' } },
        { opId: 's2', ts: Date.now(), kind: 'subtask.create', entityId: 'st1', data: { itemId: 'i3', title: 'book venue', position: 0 } },
        { opId: 's3', ts: Date.now(), kind: 'subtask.complete', entityId: 'st1' },
      ],
    },
  });
  const item = await ctx.app.inject({ method: 'GET', url: '/v1/items/i3', headers: auth(token) });
  assert.equal(item.json().subtasks.length, 1);
  assert.ok(item.json().subtasks[0].completedAt);
});
