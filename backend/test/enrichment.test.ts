import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth, resetTestSchema, TEST_DATABASE_URL } from './helpers.js';
import { buildApp } from '../src/server.js';
import { enableEnrichment } from '../src/enrichment.js';

function withStubbedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function nvidiaStub(content: Record<string, unknown>): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }),
    }) as unknown as Response) as typeof fetch;
}

test('capture is classified, decomposed, and summarized asynchronously', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'e1', rawText: "remind me to call mom tomorrow at 5pm", source: 'voice' },
  });
  // Usable immediately — enrichment happens off the request path.
  assert.equal(created.statusCode, 201);
  assert.ok(['captured', 'processing'].includes(created.json().status));

  await ctx.jobs.onIdle();

  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/e1', headers: auth(token) })).json();
  assert.equal(item.type, 'reminder');
  assert.equal(item.status, 'active');
  assert.ok(item.timeIntent?.at, 'time intent extracted');
  assert.ok(item.summary, 'plain-language summary attached');
  assert.match(item.title, /call mom/i);
});

test('long multi-part task gets decomposed; small item does not', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: {
      id: 'e2',
      rawText:
        'I need to plan the product launch, draft the announcement post, email the beta users and then schedule the livestream',
      source: 'voice',
    },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'e3', rawText: 'buy milk', source: 'voice' },
  });
  await ctx.jobs.onIdle();

  const big = (await ctx.app.inject({ method: 'GET', url: '/v1/items/e2', headers: auth(token) })).json();
  const small = (await ctx.app.inject({ method: 'GET', url: '/v1/items/e3', headers: auth(token) })).json();
  assert.ok(big.subtasks.length >= 2, `expected decomposition, got ${big.subtasks.length}`);
  assert.equal(big.subtasks[0].origin, 'ai');
  assert.equal(small.subtasks.length, 0, 'small items must not be decomposed');
});

test('computer-action tasks get the context tag for Phase 3 routing', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'e4', rawText: 'post the launch thread on X when I get a chance', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/e4', headers: auth(token) })).json();
  assert.equal(item.contextTag, 'computer-action');
});

test('spoken done completes the matching item', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'd1', rawText: 'Write the quarterly report' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'd2', rawText: 'Buy groceries for the week' },
  });

  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/voice/done',
    headers: auth(token),
    payload: { utterance: 'done with the quarterly report' },
  });
  assert.equal(res.json().completed.id, 'd1');
  assert.ok(res.json().message);

  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/d1', headers: auth(token) })).json();
  assert.equal(item.status, 'done');
});

test('spoken done with no match does not complete anything', async () => {
  const ctx = await testApp();
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'd3', rawText: 'Water the plants' },
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/voice/done',
    headers: auth(token),
    payload: { utterance: 'done with the tax filing' },
  });
  assert.equal(res.json().completed, null);
});

test('a stated routine fact is auto-completed and remembered in the profile, not left as a task', async () => {
  await resetTestSchema();
  const ctx = await buildApp({
    databaseUrl: TEST_DATABASE_URL,
    jwtSecret: 'test-secret',
    flags: { autoClassify: true, autoSchedule: false, personalization: true, analytics: false },
    nvidiaApiKey: 'fake-nvidia-key',
  });
  enableEnrichment(ctx);
  const { token } = await signup(ctx);

  await withStubbedFetch(
    nvidiaStub({
      type: 'task',
      confidence: 0.5,
      title: 'college schedule',
      timePhrase: null,
      timeAtIso: null,
      recurrence: null,
      computerAction: false,
      appTrigger: null,
      importance: 'normal',
      routineFact: { label: 'college until 4pm on weekdays', days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 },
    }),
    async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: auth(token),
        payload: { id: 'rf1', rawText: "I'm at college until 4pm on weekdays", source: 'voice' },
      });
      await ctx.jobs.onIdle();
    },
  );

  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/rf1', headers: auth(token) })).json();
  assert.equal(item.status, 'done', 'a routine fact is not left as an open task');
  assert.match(item.title, /college until 4pm/i);

  const profile = (await ctx.app.inject({ method: 'GET', url: '/v1/profile', headers: auth(token) })).json();
  assert.deepEqual(profile.attributes.routines, [
    { label: 'college until 4pm on weekdays', days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 },
  ]);
});

test('a major item with an explicit time gets both a reminder and a calendar block; a normal one gets only a reminder', async () => {
  await resetTestSchema();
  const ctx = await buildApp({
    databaseUrl: TEST_DATABASE_URL,
    jwtSecret: 'test-secret',
    flags: { autoClassify: true, autoSchedule: true, personalization: false, analytics: false },
    nvidiaApiKey: 'fake-nvidia-key',
  });
  enableEnrichment(ctx);
  const { token } = await signup(ctx);
  const at = new Date(Date.now() + 2 * 3600_000).toISOString();

  await withStubbedFetch(
    nvidiaStub({
      type: 'reminder',
      confidence: 0.9,
      title: 'Client meeting',
      timePhrase: 'in 2 hours',
      timeAtIso: at,
      recurrence: null,
      computerAction: false,
      appTrigger: null,
      importance: 'major',
      routineFact: null,
    }),
    async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: auth(token),
        payload: { id: 'maj1', rawText: 'client meeting in 2 hours', source: 'voice' },
      });
      await ctx.jobs.onIdle();
    },
  );

  const reminders = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  assert.equal(reminders.length, 1, 'still gets reminded like anything else');
  const schedule = (await ctx.app.inject({ method: 'GET', url: '/v1/schedule', headers: auth(token) })).json();
  assert.equal(schedule.length, 1, 'major item also gets a calendar block');
  assert.equal(schedule[0].itemId, 'maj1');

  await withStubbedFetch(
    nvidiaStub({
      type: 'reminder',
      confidence: 0.9,
      title: 'Take out the trash',
      timePhrase: 'in 2 hours',
      timeAtIso: at,
      recurrence: null,
      computerAction: false,
      appTrigger: null,
      importance: 'normal',
      routineFact: null,
    }),
    async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: auth(token),
        payload: { id: 'norm1', rawText: 'take out the trash in 2 hours', source: 'voice' },
      });
      await ctx.jobs.onIdle();
    },
  );

  const remindersAfter = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  assert.equal(remindersAfter.length, 2, 'normal item still gets reminded');
  const scheduleAfter = (await ctx.app.inject({ method: 'GET', url: '/v1/schedule', headers: auth(token) })).json();
  assert.equal(scheduleAfter.length, 1, 'normal item does not clutter the calendar');
});

test('enrichment streams staged updates through the change feed (understood, then final)', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'stage1', rawText: 'remind me to call mom tomorrow at 5pm', source: 'voice' },
  });
  await ctx.jobs.onIdle();

  const { changes } = (await ctx.app.inject({ method: 'GET', url: '/v1/sync/changes?since=0', headers: auth(token) })).json();
  const summaries = changes
    .filter((c: { entityType: string; entityId: string }) => c.entityType === 'item' && c.entityId === 'stage1')
    .map((c: { data: { summary: string | null } }) => c.data?.summary)
    .filter(Boolean);
  assert.ok(
    summaries.some((s: string) => s.startsWith('Understood —')),
    `interim "Understood" stage must ride the change feed, got: ${JSON.stringify(summaries)}`,
  );
  assert.ok(
    summaries.length >= 2 && !summaries[summaries.length - 1].startsWith('Understood —'),
    'final summary replaces the interim one',
  );
});

test('queue orders explicit times first', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token } = await signup(ctx);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'q1', rawText: 'organize the garage sometime', source: 'voice' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'q2', rawText: 'remind me to join standup tomorrow at 9am', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const queue = (await ctx.app.inject({ method: 'GET', url: '/v1/queue', headers: auth(token) })).json();
  assert.equal(queue[0].id, 'q2', 'timed item first');
});
