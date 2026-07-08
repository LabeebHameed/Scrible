import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

test('consent grant, list, revoke lifecycle', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);

  const initial = await ctx.app.inject({ method: 'GET', url: '/v1/consents', headers: auth(token) });
  assert.equal(initial.json().voice_processing.granted, false);

  const grant = await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'voice_processing', policyVersion: '2026-07-01' },
  });
  assert.equal(grant.statusCode, 201);

  const after = await ctx.app.inject({ method: 'GET', url: '/v1/consents', headers: auth(token) });
  assert.equal(after.json().voice_processing.granted, true);
  assert.equal(after.json().voice_processing.policyVersion, '2026-07-01');

  const revoke = await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents/voice_processing/revoke',
    headers: auth(token),
  });
  assert.equal(revoke.statusCode, 200);

  const final = await ctx.app.inject({ method: 'GET', url: '/v1/consents', headers: auth(token) });
  assert.equal(final.json().voice_processing.granted, false);
});

test('revoking chat_import purges profile and import jobs', async () => {
  const ctx = testApp();
  const { token, userId } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'chat_import', policyVersion: 'v1' },
  });
  ctx.db
    .prepare('INSERT INTO profiles (user_id, attributes, updated_at) VALUES (?, ?, ?)')
    .run(userId, '{"tone":"brief"}', Date.now());
  ctx.db
    .prepare(
      "INSERT INTO import_jobs (id, user_id, source, consent_id, retention_deadline, created_at) VALUES ('ij1', ?, 'claude', 'c1', ?, ?)",
    )
    .run(userId, Date.now(), Date.now());

  const revoke = await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents/chat_import/revoke',
    headers: auth(token),
  });
  assert.deepEqual(revoke.json().purged, { profiles: 1, import_jobs: 1, learned_signals: 0 });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM profiles').get()!.c, 0);
});

test('unknown category rejected', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'telepathy', policyVersion: 'v1' },
  });
  assert.equal(res.statusCode, 400);
});
