/**
 * Phase 9 — free-tier-first AI: confidence gates automate as much as possible
 * before any LLM is consulted, and the free NVIDIA-compatible provider is tried
 * before any paid provider. Nothing here ever hits the real network — `fetch` is
 * stubbed for the NVIDIA-provider cases, and no ANTHROPIC/NVIDIA keys exist in the
 * test environment otherwise (see test/helpers.ts testApp()).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetTestSchema, TEST_DATABASE_URL } from './helpers.js';
import { buildApp } from '../src/server.js';

const baseOverrides = {
  databaseUrl: TEST_DATABASE_URL,
  jwtSecret: 'test-secret',
  flags: { autoClassify: false, autoSchedule: false, personalization: false, analytics: false },
} as const;

test('classify: an explicit hint short-circuits at the heuristic-confident tier, zero tokens', async () => {
  const ctx = await testApp();
  const out = await ctx.orchestrator.run('classify', {
    text: 'remind me to call the dentist tomorrow',
    context: { localHour: 9, recentTypes: [], timezone: 'UTC' },
  });
  assert.equal(out.type, 'reminder');
  const last = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'classify').pop()!;
  assert.equal(last.provider, 'heuristic-confident');
  assert.equal(last.ok, true);
  assert.equal(last.inputTokens, undefined);
});

test('decompose: explicit connectors short-circuit at the heuristic-confident tier', async () => {
  const ctx = await testApp();
  const out = await ctx.orchestrator.run('decompose', {
    text: 'Clean the kitchen, then do laundry, then vacuum the living room',
    type: 'task',
  });
  assert.ok(out.subtasks.length >= 2);
  const last = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'decompose').pop()!;
  assert.equal(last.provider, 'heuristic-confident');
});

test('decompose: a short item confidently needs no decomposition, no AI required', async () => {
  const ctx = await testApp();
  const out = await ctx.orchestrator.run('decompose', { text: 'water the plants', type: 'task' });
  assert.deepEqual(out.subtasks, []);
  const last = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'decompose').pop()!;
  assert.equal(last.provider, 'heuristic-confident');
});

test('matchDone: a strong single overlap short-circuits at the heuristic-confident tier', async () => {
  const ctx = await testApp();
  const out = await ctx.orchestrator.run('matchDone', {
    utterance: 'done with the dentist appointment',
    openItems: [
      { id: 'i1', title: 'dentist appointment' },
      { id: 'i2', title: 'buy groceries' },
    ],
  });
  assert.equal(out.matchedId, 'i1');
  const last = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'matchDone').pop()!;
  assert.equal(last.provider, 'heuristic-confident');
});

test('confirm never invokes AI even when nvidia/anthropic keys are configured', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key', anthropicApiKey: 'fake-anthropic-key' });
  for (const event of ['captured', 'scheduled', 'moved', 'conflict', 'reminder_set', 'completed'] as const) {
    await ctx.orchestrator.run('confirm', { event, itemTitle: 'test item', itemType: 'task', detail: {} });
  }
  const confirmCalls = ctx.orchestrator.recentMetrics(50).filter((m) => m.capability === 'confirm');
  assert.equal(confirmCalls.length, 6);
  assert.ok(confirmCalls.every((m) => m.provider === 'heuristic'));
});

function withStubbedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test('nvidia provider: a valid response is parsed, tokens captured, and the chain skips anthropic/heuristic', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const stub = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: 'idea',
                confidence: 0.6,
                title: 'Rework the onboarding flow',
                timePhrase: null,
                timeAtIso: null,
                recurrence: null,
                computerAction: false,
                appTrigger: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 42, completion_tokens: 8 },
      }),
    }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const out = await ctx.orchestrator.run('classify', {
      text: 'maybe rework how new users get onboarded at some point',
      context: { localHour: 10, recentTypes: [], timezone: 'UTC' },
    });
    assert.equal(out.type, 'idea');
    const last = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'classify').pop()!;
    assert.equal(last.provider, 'nvidia');
    assert.equal(last.inputTokens, 42);
    assert.equal(last.outputTokens, 8);
  });
});

test('nvidia provider failure (bad status or malformed JSON) falls through to heuristic — never a hard failure', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(failing, async () => {
    const out = await ctx.orchestrator.run('classify', {
      text: 'organize the shared drive folders at some point',
      context: { localHour: 10, recentTypes: [], timezone: 'UTC' },
    });
    assert.ok(out.type);
    const calls = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'classify');
    const last = calls.pop()!;
    assert.equal(last.provider, 'heuristic');
    assert.equal(last.fellBack, true);
    assert.ok(calls.some((m) => m.provider === 'nvidia' && m.ok === false));
  });
});

test('classify: with an LLM key configured, an explicit-hint phrase skips heuristic-confident and reaches the LLM', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const stub = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: 'reminder',
                confidence: 0.9,
                title: 'Call the dentist',
                timePhrase: 'tomorrow',
                timeAtIso: null,
                recurrence: null,
                computerAction: false,
                appTrigger: null,
                importance: 'normal',
                routineFact: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 6 },
      }),
    }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    // Same phrase as the very first test in this file — there it short-circuits at
    // heuristic-confident with zero tokens; with an LLM key present it must NOT.
    const out = await ctx.orchestrator.run('classify', {
      text: 'remind me to call the dentist tomorrow',
      context: { localHour: 9, recentTypes: [], timezone: 'UTC' },
    });
    assert.equal(out.type, 'reminder');
    const last = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'classify').pop()!;
    assert.equal(last.provider, 'nvidia');
    assert.equal(last.inputTokens, 30);
    assert.ok(
      !ctx.orchestrator.recentMetrics(10).some((m) => m.capability === 'classify' && m.provider === 'heuristic-confident'),
      'heuristic-confident must not be registered at all when an LLM key is configured',
    );
  });
});

test('classify: importance and routineFact pass through from the LLM response', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const stub = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: 'reminder',
                confidence: 0.9,
                title: 'Client meeting',
                timePhrase: '3pm',
                timeAtIso: new Date(Date.now() + 3600_000).toISOString(),
                recurrence: null,
                computerAction: false,
                appTrigger: null,
                importance: 'major',
                routineFact: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }),
    }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const out = await ctx.orchestrator.run('classify', {
      text: 'client meeting at 3pm',
      context: { localHour: 9, recentTypes: [], timezone: 'UTC' },
    });
    assert.equal(out.importance, 'major');
  });
});

test('classify: a stated routine fact is returned structured, not treated as an item', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const stub = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
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
            },
          },
        ],
        usage: { prompt_tokens: 25, completion_tokens: 10 },
      }),
    }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const out = await ctx.orchestrator.run('classify', {
      text: "I'm at college until 4pm on weekdays",
      context: { localHour: 9, recentTypes: [], timezone: 'UTC' },
    });
    assert.deepEqual(out.routineFact, {
      label: 'college until 4pm on weekdays',
      days: [1, 2, 3, 4, 5],
      startHour: 8,
      endHour: 16,
    });
  });
});

test('classify: a heuristic-parseable relative time wins over a hallucinated model timestamp', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const now = Date.now();
  // The model invents a plausible-sounding but wrong absolute date — exactly the
  // real-world failure mode: "in the next minute" got resolved to some Monday
  // afternoon meeting time out of thin air.
  const hallucinated = new Date(now + 3 * 24 * 3600_000).toISOString();
  const stub = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: 'reminder',
                confidence: 0.9,
                title: 'Attend meeting',
                timePhrase: 'in the next minute',
                timeAtIso: hallucinated,
                recurrence: null,
                computerAction: false,
                appTrigger: null,
                importance: 'normal',
                routineFact: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }),
    }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const out = await ctx.orchestrator.run('classify', {
      text: 'I have a meeting in the next minute remind me',
      context: { localHour: 9, recentTypes: [], timezone: 'UTC' },
    });
    assert.ok(out.timeIntent?.at, 'a time was resolved');
    assert.ok(
      Math.abs(out.timeIntent!.at! - (now + 60_000)) < 10_000,
      `expected ~1 minute from now, got ${new Date(out.timeIntent!.at!).toISOString()} (model hallucinated ${hallucinated})`,
    );
  });
});

test('classify: an invalid type from the model (e.g. "routineFact") is normalized, routineFact field preserved', async () => {
  // Live-probe regression: the free-form-JSON provider let the model answer
  // type:"routineFact" (a field name, not a type) which reached the database and
  // broke routine auto-remembering. The type must always normalize to the enum.
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const stub = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: 'routineFact',
                confidence: 0.8,
                title: 'college schedule',
                timePhrase: null,
                timeAtIso: null,
                recurrence: null,
                computerAction: false,
                appTrigger: null,
                importance: 'normal',
                routineFact: { label: 'college until 4pm on weekdays', days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
    }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const out = await ctx.orchestrator.run('classify', {
      text: "I'm at college until 4pm on weekdays",
      context: { localHour: 9, recentTypes: [], timezone: 'UTC' },
    });
    assert.equal(out.type, 'task', 'invalid model type coerced to a real enum value');
    assert.equal(out.routineFact?.label, 'college until 4pm on weekdays', 'the fact itself survives');
  });
});

test('classify: importance and routineFact default safely when the LLM omits them', async () => {
  await resetTestSchema();
  const ctx = await buildApp({ ...baseOverrides, nvidiaApiKey: 'fake-nvidia-key' });
  const stub = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: 'idea',
                confidence: 0.6,
                title: 'Rework the onboarding flow',
                timePhrase: null,
                timeAtIso: null,
                recurrence: null,
                computerAction: false,
                appTrigger: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 4 },
      }),
    }) as unknown as Response) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const out = await ctx.orchestrator.run('classify', {
      text: 'maybe rework how new users get onboarded at some point',
      context: { localHour: 10, recentTypes: [], timezone: 'UTC' },
    });
    assert.equal(out.importance, 'normal');
    assert.equal(out.routineFact, null);
  });
});

test('zero-config smoke: with no AI keys at all, every capability still resolves — never fails, never costs anything', async () => {
  const ctx = await testApp();
  const out = await ctx.orchestrator.run('classify', {
    text: 'organize the shared drive folders at some point',
    context: { localHour: 10, recentTypes: [], timezone: 'UTC' },
  });
  assert.ok(out.type);
  const last = ctx.orchestrator.recentMetrics(10).filter((m) => m.capability === 'classify').pop()!;
  assert.equal(last.provider, 'heuristic');
  assert.equal(last.inputTokens, undefined);
});
