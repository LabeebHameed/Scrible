import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';
import { parseImport } from '../src/imports/parsers.js';

const CLAUDE_EXPORT = JSON.stringify([
  {
    name: 'planning chat',
    chat_messages: [
      { sender: 'human', text: 'plan sprint' },
      { sender: 'assistant', text: 'Sure, here is a long plan...' },
      { sender: 'human', text: 'shorter pls' },
      { sender: 'human', text: 'ok do the roadmap deck for the offsite meeting with the analytics dashboard mockups' },
    ],
  },
  {
    name: 'second chat',
    chat_messages: [
      { sender: 'human', text: 'fix bug' },
      { sender: 'human', text: 'draft launch tweet' },
      { sender: 'human', text: 'analytics dashboard analytics dashboard analytics' },
    ],
  },
]);

test('parsers extract only user messages per format', () => {
  const claude = parseImport('claude', CLAUDE_EXPORT);
  assert.equal(claude.userMessages.length, 6);
  assert.ok(!claude.userMessages.some((m) => m.includes('long plan')), 'assistant text excluded');

  const chatgpt = parseImport(
    'chatgpt',
    JSON.stringify([
      {
        mapping: {
          a: { message: { author: { role: 'user' }, content: { parts: ['hello world'] } } },
          b: { message: { author: { role: 'assistant' }, content: { parts: ['hi!'] } } },
          c: { message: null },
        },
      },
    ]),
  );
  assert.deepEqual(chatgpt.userMessages, ['hello world']);

  const gemini = parseImport(
    'gemini',
    JSON.stringify([{ title: 'Prompted write me a haiku' }, { title: 'Searched something' }]),
  );
  assert.deepEqual(gemini.userMessages, ['write me a haiku']);

  const genericText = parseImport('generic', 'first message\nsecond message here');
  assert.equal(genericText.userMessages.length, 2);
});

test('import requires chat_import consent', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: auth(token),
    payload: { source: 'claude', content: CLAUDE_EXPORT },
  });
  assert.equal(res.statusCode, 403);
});

test('claude import derives a profile; raw is never retained', async () => {
  const ctx = testApp();
  const { token, userId } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'chat_import', policyVersion: 'v1' },
  });

  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: auth(token),
    payload: { source: 'claude', content: CLAUDE_EXPORT },
  });
  assert.equal(res.statusCode, 201);
  assert.ok(res.json().profile.tone, 'profile derived');
  assert.match(res.json().rawRetention, /discarded/);

  // Job row records counts only; raw_ref empty, deletion timestamped.
  const job = ctx.db.prepare('SELECT * FROM import_jobs WHERE user_id = ?').get(userId) as Record<string, unknown>;
  assert.equal(job.state, 'done');
  assert.equal(job.raw_ref, null);
  assert.ok(job.deleted_at);

  // Nothing in the database contains the conversation text.
  for (const table of ['profiles', 'import_jobs', 'audit_log', 'activity']) {
    const rows = ctx.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      assert.ok(!JSON.stringify(row).includes('roadmap deck'), `${table} must not contain chat text`);
    }
  }

  const profile = (await ctx.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(token) })).json();
  assert.ok(profile.attributes.vocabulary.includes('analytics'), 'domain vocabulary extracted');
  assert.deepEqual(profile.overrides, {});
});

test('manual edits win over derived values and survive re-import', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'chat_import', policyVersion: 'v1' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: auth(token),
    payload: { source: 'claude', content: CLAUDE_EXPORT },
  });

  // User corrects the machine's read of them.
  await ctx.app.inject({
    method: 'PATCH',
    url: '/v1/profile',
    headers: auth(token),
    payload: { tone: 'warm' },
  });
  let profile = (await ctx.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(token) })).json();
  assert.equal(profile.attributes.tone, 'warm');

  // A new import refreshes derived values but never clobbers manual edits.
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: auth(token),
    payload: { source: 'claude', content: CLAUDE_EXPORT },
  });
  profile = (await ctx.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(token) })).json();
  assert.equal(profile.attributes.tone, 'warm', 'override survived re-import');
});

test('profile adapts confirmations: brief tone produces brief summaries', async () => {
  const ctx = testApp({ autoClassify: true, personalization: true });
  const { token, userId } = await signup(ctx);
  ctx.db
    .prepare('INSERT INTO profiles (user_id, attributes, updated_at) VALUES (?, ?, ?)')
    .run(userId, JSON.stringify({ attributes: { tone: 'brief', verbosity: 'low' }, overrides: {} }), Date.now());

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'p1', rawText: 'buy oat milk', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/p1', headers: auth(token) })).json();
  assert.ok(!item.summary.startsWith('Got it'), `brief tone expected, got: ${item.summary}`);
});

test('total deletion: no import-derived data survives', async () => {
  const ctx = testApp();
  const { token, userId } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'chat_import', policyVersion: 'v1' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: auth(token),
    payload: { source: 'claude', content: CLAUDE_EXPORT },
  });

  const res = await ctx.app.inject({ method: 'DELETE', url: '/v1/profile', headers: auth(token) });
  assert.equal(res.json().deleted, true);
  assert.match(res.json().confirmation, /deleted/);

  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM profiles WHERE user_id = ?').get(userId)!.c, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM import_jobs WHERE user_id = ?').get(userId)!.c, 0);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE user_id = ? AND action LIKE 'import.%'").get(userId)!.c,
    0,
    'processing logs erased',
  );
  const profile = await ctx.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(token) });
  assert.equal(profile.statusCode, 404);
});

test('revoking chat_import consent also purges profile and imports', async () => {
  const ctx = testApp();
  const { token, userId } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'chat_import', policyVersion: 'v1' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: auth(token),
    payload: { source: 'claude', content: CLAUDE_EXPORT },
  });
  await ctx.app.inject({ method: 'POST', url: '/v1/consents/chat_import/revoke', headers: auth(token) });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM profiles WHERE user_id = ?').get(userId)!.c, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM import_jobs WHERE user_id = ?').get(userId)!.c, 0);
});

test('on-device path stores a client-derived profile without any upload', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'chat_import', policyVersion: 'v1' },
  });
  const res = await ctx.app.inject({
    method: 'PUT',
    url: '/v1/profile',
    headers: auth(token),
    payload: { attributes: { tone: 'brief', verbosity: 'low', vocabulary: ['ml'] } },
  });
  assert.equal(res.statusCode, 200);
  const profile = (await ctx.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(token) })).json();
  assert.equal(profile.storage, 'on-device-only');
  assert.equal(profile.attributes.tone, 'brief');
});
