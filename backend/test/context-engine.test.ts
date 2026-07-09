/**
 * Phase 8 — Context engine: learning that grows awareness with ZERO token growth.
 * Learned priors live only in `learned_signals`, applied in code, never in prompts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';
import { learnFromCorrection, learnedVocabulary } from '../src/ai/learning.js';
import { deleteAllUserData, verifyDeletion } from '../src/lib/db.js';
import type { ItemType } from '../src/types.js';

const grantChatImport = (ctx: Awaited<ReturnType<typeof testApp>>, token: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'chat_import', policyVersion: 'v1' },
  });

test('correcting a pattern twice teaches the learned provider — the next similar capture short-circuits at zero tokens', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await grantChatImport(ctx, token);

  for (const id of ['g1', 'g2']) {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth(token),
      payload: { id, rawText: 'gym session', source: 'typed' },
    });
    await ctx.jobs.onIdle();
    const item = (await ctx.app.inject({ method: 'GET', url: `/v1/items/${id}`, headers: auth(token) })).json();
    assert.equal(item.type, 'task', 'heuristic default is task with no priors yet');
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/items/${id}/retype`,
      headers: auth(token),
      payload: { type: 'reminder' },
    });
  }

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'g3', rawText: 'gym session', source: 'typed' },
  });
  await ctx.jobs.onIdle();
  const g3 = (await ctx.app.inject({ method: 'GET', url: '/v1/items/g3', headers: auth(token) })).json();
  assert.equal(g3.type, 'reminder', 'learned prior overrides the heuristic default — accuracy grew');

  const classifyCalls = ctx.orchestrator.recentMetrics(500).filter((m) => m.capability === 'classify');
  const last = classifyCalls[classifyCalls.length - 1]!;
  assert.equal(last.provider, 'learned');
  assert.equal(last.ok, true);
  assert.equal(last.inputTokens, undefined, 'the learned provider never touches an LLM — zero tokens');
  assert.ok(!classifyCalls.some((m) => m.provider === 'anthropic'), 'no anthropic call needed for a confident pattern');
});

test('prior disagreement falls through the chain instead of guessing', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token, userId } = await signup(ctx);
  const now = Date.now();
  const insert = ctx.db.prepare(
    'INSERT INTO learned_signals (id, user_id, kind, key, value, weight, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  await insert.run('s1', userId, 'type_prior', 'ambiguous', 'reminder', 3, now);
  await insert.run('s2', userId, 'type_prior', 'ambiguous', 'idea', 2, now);

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'amb1', rawText: 'ambiguous note here', source: 'typed' },
  });
  await ctx.jobs.onIdle();

  const classifyCalls = ctx.orchestrator.recentMetrics(500).filter((m) => m.capability === 'classify');
  const last = classifyCalls[classifyCalls.length - 1]!;
  assert.equal(last.provider, 'heuristic', 'evidence is only 60/40 — below the confidence threshold');
  assert.equal(last.fellBack, true);
});

test('token invariance: the classify wire payload is unaffected by learned_signals or profile size', async () => {
  const ctx = await testApp();
  const { userId } = await signup(ctx);

  const wirePayload = (recentTypes: ItemType[], text: string) =>
    JSON.stringify({ transcript: text, localHour: 9, recentTypes });

  const before = wirePayload(['task', 'idea', 'reminder', 'task', 'idea'], 'plan the offsite retro');

  const insert = ctx.db.prepare(
    'INSERT INTO learned_signals (id, user_id, kind, key, value, weight, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 500; i++) await insert.run(`sig${i}`, userId, 'type_prior', `term${i}`, 'reminder', 1, Date.now());

  const after = wirePayload(['task', 'idea', 'reminder', 'task', 'idea'], 'plan the offsite retro');
  assert.equal(after.length, before.length, 'the actual Claude wire payload never grows with learned evidence');
  assert.ok((await learnedVocabulary(ctx.db, userId)).length <= 15, 'vocabulary fed back to the profile stays capped at 15');
});

test('prune enforces the 200-row-per-user cap as evidence accumulates', async () => {
  const ctx = await testApp();
  const { userId } = await signup(ctx);
  for (let i = 0; i < 300; i++) {
    await learnFromCorrection(ctx.db, userId, `unique item number ${i} distinct words`, 'task', 'reminder');
  }
  const { c } = (await ctx.db.prepare('SELECT COUNT(*) c FROM learned_signals WHERE user_id = ?').get(userId)) as {
    c: number;
  };
  assert.ok(c <= 200, `expected the table capped at <=200 rows, got ${c}`);
});

test('learning is consent-gated; profile deletion and account deletion purge learned_signals', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token, userId } = await signup(ctx);

  // No chat_import consent yet — corrections must not teach anything.
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'cg1', rawText: 'water the plants', source: 'typed' },
  });
  await ctx.jobs.onIdle();
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items/cg1/retype',
    headers: auth(token),
    payload: { type: 'reminder' },
  });
  assert.equal(
    ((await ctx.db.prepare('SELECT COUNT(*) c FROM learned_signals WHERE user_id = ?').get(userId)) as { c: number }).c,
    0,
    'no consent, no learning',
  );

  await grantChatImport(ctx, token);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'cg2', rawText: 'water the plants', source: 'typed' },
  });
  await ctx.jobs.onIdle();
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items/cg2/retype',
    headers: auth(token),
    payload: { type: 'reminder' },
  });
  assert.ok(
    ((await ctx.db.prepare('SELECT COUNT(*) c FROM learned_signals WHERE user_id = ?').get(userId)) as { c: number }).c > 0,
    'consent granted — correction recorded',
  );

  // The transparency section attaches to whatever profile exists; give this user one.
  await ctx.db
    .prepare('INSERT INTO profiles (user_id, attributes, updated_at) VALUES (?, ?, ?)')
    .run(userId, '{"tone":"brief"}', Date.now());
  const profile = (await ctx.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(token) })).json();
  assert.ok(profile.learned.patterns.length > 0, 'transparency endpoint shows the learned pattern in plain language');

  const del = await ctx.app.inject({ method: 'DELETE', url: '/v1/profile', headers: auth(token) });
  assert.ok(del.json().counts.learned_signals > 0);
  assert.equal(
    ((await ctx.db.prepare('SELECT COUNT(*) c FROM learned_signals WHERE user_id = ?').get(userId)) as { c: number }).c,
    0,
    'profile delete purges learned_signals',
  );

  // Re-teach, then verify the account-deletion sweep also purges it.
  await learnFromCorrection(ctx.db, userId, 'water the plants', 'task', 'reminder');
  assert.ok(
    ((await ctx.db.prepare('SELECT COUNT(*) c FROM learned_signals WHERE user_id = ?').get(userId)) as { c: number }).c > 0,
  );
  await deleteAllUserData(ctx.db, userId);
  assert.equal((await verifyDeletion(ctx.db, userId)).learned_signals, 0, 'account deletion purges learned_signals');
});

test('app-alias learning: a manual appTrigger teaches; a similar capture inherits it; server-origin updates never teach', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token, userId } = await signup(ctx);
  await grantChatImport(ctx, token);

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'al1', rawText: 'update the icon set', source: 'typed' },
  });
  await ctx.jobs.onIdle();
  await ctx.app.inject({
    method: 'PATCH',
    url: '/v1/items/al1',
    headers: auth(token),
    payload: { appTrigger: 'figma' },
  });

  const aliasRows = await ctx.db
    .prepare("SELECT * FROM learned_signals WHERE user_id = ? AND kind = 'app_alias'")
    .all(userId);
  assert.ok(aliasRows.length > 0, 'manual appTrigger edit taught an alias');

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'al2', rawText: 'polish icon set spacing', source: 'typed' },
  });
  await ctx.jobs.onIdle();
  const al2 = (await ctx.app.inject({ method: 'GET', url: '/v1/items/al2', headers: auth(token) })).json();
  assert.equal(al2.appTrigger, 'figma', 'the learned alias was inherited on a similar capture');

  const countAliasRows = async () =>
    (
      (await ctx.db
        .prepare("SELECT COUNT(*) c FROM learned_signals WHERE user_id = ? AND kind = 'app_alias'")
        .get(userId)) as { c: number }
    ).c;
  const before = await countAliasRows();

  // Enrichment itself derives an appTrigger from phrasing here — a server-originated
  // write. It must never teach the learner (only genuine user edits do).
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'al3', rawText: 'when I open slack check messages', source: 'typed' },
  });
  await ctx.jobs.onIdle();
  const al3 = (await ctx.app.inject({ method: 'GET', url: '/v1/items/al3', headers: auth(token) })).json();
  assert.equal(al3.appTrigger, 'slack', 'heuristic still derives the trigger from explicit phrasing');
  assert.equal(await countAliasRows(), before, 'server-originated appTrigger writes do not teach the learner');
});
