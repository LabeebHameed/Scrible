import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

test('capture is classified, decomposed, and summarized asynchronously', async () => {
  const ctx = testApp({ autoClassify: true });
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
  const ctx = testApp({ autoClassify: true });
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
  const ctx = testApp({ autoClassify: true });
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
  const ctx = testApp();
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
  const ctx = testApp();
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

test('queue orders explicit times first', async () => {
  const ctx = testApp({ autoClassify: true });
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
