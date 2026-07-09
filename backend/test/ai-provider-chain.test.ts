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
