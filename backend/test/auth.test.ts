import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

test('signup, login, me', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx, 'alice@test.dev');

  const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().email, 'alice@test.dev');

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'alice@test.dev', password: 'password123' },
  });
  assert.equal(login.statusCode, 200);
  assert.ok(login.json().token);
});

test('rejects wrong password and bad tokens', async () => {
  const ctx = testApp();
  await signup(ctx, 'bob@test.dev');

  const bad = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'bob@test.dev', password: 'wrong-password' },
  });
  assert.equal(bad.statusCode, 401);

  const noToken = await ctx.app.inject({ method: 'GET', url: '/v1/me' });
  assert.equal(noToken.statusCode, 401);

  const garbage = await ctx.app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: auth('garbage.token.here'),
  });
  assert.equal(garbage.statusCode, 401);
});

test('rejects weak passwords and duplicate accounts', async () => {
  const ctx = testApp();
  const weak = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'c@test.dev', password: 'short' },
  });
  assert.equal(weak.statusCode, 400);

  await signup(ctx, 'dup@test.dev');
  const dup = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'dup@test.dev', password: 'password123' },
  });
  assert.equal(dup.statusCode, 409);
});

test('per-user data isolation', async () => {
  const ctx = testApp();
  const a = await signup(ctx);
  const b = await signup(ctx);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(a.token),
    payload: { rawText: 'secret task of A' },
  });
  const id = created.json().id;
  const stolen = await ctx.app.inject({
    method: 'GET',
    url: `/v1/items/${id}`,
    headers: auth(b.token),
  });
  assert.equal(stolen.statusCode, 404);
});
