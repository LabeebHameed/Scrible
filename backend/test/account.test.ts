import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';
import { USER_DATA_TABLES } from '../src/lib/db.js';

test('account deletion removes every trace of the user', async () => {
  const ctx = testApp();
  const { token, userId } = await signup(ctx, 'deleteme@test.dev');

  // Populate data across the model.
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'd1', rawText: 'a task to be erased' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/sync/ops',
    headers: auth(token),
    payload: {
      ops: [
        { opId: 'x1', ts: Date.now(), kind: 'subtask.create', entityId: 'dst1', data: { itemId: 'd1', title: 'step' } },
        { opId: 'x2', ts: Date.now(), kind: 'item.complete', entityId: 'd1' },
      ],
    },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'analytics', policyVersion: 'v1' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: auth(token),
    payload: { platform: 'ios', capabilities: { canRecordAudio: true } },
  });

  const res = await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(token) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, true);
  assert.match(res.json().confirmation, /deleted/);

  // Verify zero rows remain for this user in every user-data table.
  for (const table of USER_DATA_TABLES) {
    const col = table === 'users' ? 'id' : 'user_id';
    const row = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`)
      .get(userId) as { c: number };
    assert.equal(row.c, 0, `expected 0 rows in ${table}`);
  }

  // Token is dead; login is dead.
  const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
  assert.equal(me.statusCode, 401);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'deleteme@test.dev', password: 'password123' },
  });
  assert.equal(login.statusCode, 401);
});

test('deletion does not touch other users', async () => {
  const ctx = testApp();
  const a = await signup(ctx);
  const b = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(b.token),
    payload: { rawText: 'b keeps this' },
  });
  await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: auth(a.token) });
  const items = await ctx.app.inject({ method: 'GET', url: '/v1/items', headers: auth(b.token) });
  assert.equal(items.json().length, 1);
});
