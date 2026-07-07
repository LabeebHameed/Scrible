import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncStore, type KV } from '../src/store';
import type { ApiClient } from '../src/api';
import type { ChangeRow, Item, SyncOp } from '../src/types';

function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async getItem(k) {
      return data.get(k) ?? null;
    },
    async setItem(k, v) {
      data.set(k, v);
    },
  };
}

function fakeApi(): ApiClient & {
  pushed: SyncOp[];
  feed: ChangeRow[];
  online: boolean;
} {
  return {
    pushed: [],
    feed: [],
    online: true,
    async pushOps(ops) {
      if (!this.online) throw new Error('network down');
      this.pushed.push(...ops);
      return ops.map((o) => ({ opId: o.opId, status: 'created' }));
    },
    async changesSince(seq) {
      if (!this.online) throw new Error('network down');
      const changes = this.feed.filter((c) => c.seq > seq);
      return { changes, latest: changes.length ? changes[changes.length - 1]!.seq : seq };
    },
    async signup() {
      return { token: 't' };
    },
    async login() {
      return { token: 't' };
    },
    async voiceDone() {
      return { completed: null, message: '' };
    },
    async getConsents() {
      return {};
    },
    async grantConsent() {},
    async revokeConsent() {},
    async deleteAccount() {
      return { confirmation: '' };
    },
  };
}

test('offline capture is queued and survives restart, then syncs', async () => {
  const kv = memoryKV();
  const api = fakeApi();
  api.online = false;

  const store = new SyncStore(kv, api);
  await store.load();
  const item = await store.capture('captured in airplane mode', 'voice');
  assert.equal(store.queue()[0]?.id, item.id, 'usable immediately offline');
  assert.equal(store.pendingOps.length, 1);

  // App restarts — the op queue must be durable.
  const store2 = new SyncStore(kv, api);
  await store2.load();
  assert.equal(store2.pendingOps.length, 1);
  assert.equal(store2.queue()[0]?.rawText, 'captured in airplane mode');

  api.online = true;
  const ok = await store2.sync();
  assert.equal(ok, true);
  assert.equal(store2.pendingOps.length, 0);
  assert.equal(api.pushed[0]?.kind, 'item.create');
});

test('offline completion is optimistic and never lost', async () => {
  const kv = memoryKV();
  const api = fakeApi();
  const store = new SyncStore(kv, api);
  await store.load();
  const item = await store.capture('write the report', 'typed');
  api.online = false;
  await store.complete(item.id);
  assert.equal(store.items[item.id]!.status, 'done');
  assert.equal(store.queue().length, 0, 'completed item leaves the queue immediately');

  api.online = true;
  await store.sync();
  assert.ok(api.pushed.some((op) => op.kind === 'item.complete' && op.entityId === item.id));
});

test('server enrichment flows back through the change feed', async () => {
  const kv = memoryKV();
  const api = fakeApi();
  const store = new SyncStore(kv, api);
  await store.load();
  const item = await store.capture('remind me friday', 'voice');
  await store.sync();

  const enriched: Item = {
    ...store.items[item.id]!,
    type: 'reminder',
    status: 'active',
    summary: 'Reminder set.',
    timeIntent: { at: Date.now() + 86400000, phrase: 'friday' },
  };
  api.feed.push({ seq: 1, entityType: 'item', entityId: item.id, op: 'upsert', data: enriched, ts: Date.now() });

  await store.sync();
  assert.equal(store.items[item.id]!.type, 'reminder');
  assert.equal(store.items[item.id]!.summary, 'Reminder set.');
  assert.equal(store.cursor, 1);
});

test('queue puts timed items first, capped at 5', async () => {
  const store = new SyncStore(memoryKV(), fakeApi());
  await store.load();
  for (let i = 0; i < 6; i++) await store.capture(`item ${i}`, 'typed');
  const timed = await store.capture('timed item', 'typed');
  store.items[timed.id]!.timeIntent = { at: Date.now() + 1000 };

  const queue = store.queue();
  assert.equal(queue.length, 5);
  assert.equal(queue[0]!.id, timed.id);
});
