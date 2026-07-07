import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

async function linkInternalCalendar(ctx: ReturnType<typeof testApp>, token: string): Promise<string> {
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/consents',
    headers: auth(token),
    payload: { category: 'calendar_access', policyVersion: 'v1' },
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/calendar/links',
    headers: auth(token),
    payload: { provider: 'internal' },
  });
  return res.json().id;
}

test('calendar link requires consent', async () => {
  const ctx = testApp();
  const { token } = await signup(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/calendar/links',
    headers: auth(token),
    payload: { provider: 'internal' },
  });
  assert.equal(res.statusCode, 403);
});

test('availability excludes busy events and respects working hours', async () => {
  const ctx = testApp();
  const { token, userId } = await signup(ctx);
  const linkId = await linkInternalCalendar(ctx, token);

  // A meeting tomorrow 10:00–11:00.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  // Pick a weekday within default working hours (Mon-Fri).
  while ([0, 6].includes(tomorrow.getDay())) tomorrow.setDate(tomorrow.getDate() + 1);
  const meetingStart = new Date(tomorrow).setHours(10, 0, 0, 0);
  const meetingEnd = new Date(tomorrow).setHours(11, 0, 0, 0);
  ctx.internalCalendar.simulateExternalEvent(linkId, {
    title: 'Team sync',
    start: meetingStart,
    end: meetingEnd,
    busy: true,
  });
  await ctx.calendar.syncUser(userId);

  const dayStart = new Date(tomorrow).setHours(0, 0, 0, 0);
  const dayEnd = new Date(tomorrow).setHours(23, 59, 0, 0);
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/v1/availability?from=${dayStart}&to=${dayEnd}`,
    headers: auth(token),
  });
  const slots = res.json().slots as Array<{ start: number; end: number }>;
  assert.ok(slots.length >= 2, 'free time around the meeting');
  for (const s of slots) {
    assert.ok(s.end <= meetingStart || s.start >= meetingEnd, 'no slot overlaps the meeting');
    assert.ok(new Date(s.start).getHours() >= 9 && new Date(s.end).getHours() <= 18, 'inside working hours');
  }
});

test('idea captured by voice lands as a calendar block with confirmation, undo removes it externally', async () => {
  const ctx = testApp({ autoClassify: true, autoSchedule: true });
  const { token, userId } = await signup(ctx);
  const linkId = await linkInternalCalendar(ctx, token);

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'idea1', rawText: 'idea: what if we made a podcast series about maker workflows', source: 'voice' },
  });
  await ctx.jobs.onIdle();

  const item = (await ctx.app.inject({ method: 'GET', url: '/v1/items/idea1', headers: auth(token) })).json();
  assert.equal(item.type, 'idea');
  assert.equal(item.status, 'scheduled');

  const schedule = (await ctx.app.inject({ method: 'GET', url: '/v1/schedule', headers: auth(token) })).json();
  assert.equal(schedule.length, 1);
  assert.equal(schedule[0].external, true, 'written to the linked calendar');

  // The block exists on the "external" calendar.
  const link = ctx.calendar.links(userId)[0]!;
  const pulled = await ctx.internalCalendar.pullEvents(link, Date.now() - 1000, Date.now() + 30 * 86400000);
  assert.equal(pulled.events.length, 1);
  assert.match(pulled.events[0]!.title, /Scrible:/);

  // Plain-language confirmation in the activity feed.
  const activity = (await ctx.app.inject({ method: 'GET', url: '/v1/activity', headers: auth(token) })).json();
  assert.ok(activity.some((a: { kind: string; undoable: boolean }) => a.kind === 'scheduled' && a.undoable));

  // Undo removes the block AND the external event.
  const undo = await ctx.app.inject({
    method: 'POST',
    url: `/v1/schedule/${schedule[0].id}/undo`,
    headers: auth(token),
  });
  assert.equal(undo.statusCode, 200);
  const afterUndo = await ctx.internalCalendar.pullEvents(link, Date.now() - 1000, Date.now() + 30 * 86400000);
  assert.equal(afterUndo.events.length, 0, 'external event deleted on undo');
  const itemAfter = (await ctx.app.inject({ method: 'GET', url: '/v1/items/idea1', headers: auth(token) })).json();
  assert.equal(itemAfter.status, 'active', 'item back in the queue');
});

test('external meeting landing on a Scrible block displaces it — never silently', async () => {
  const ctx = testApp({ autoClassify: true, autoSchedule: true });
  const { token, userId } = await signup(ctx);
  const linkId = await linkInternalCalendar(ctx, token);

  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'idea2', rawText: 'idea: maybe we could build a community newsletter for early users', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const [block] = (await ctx.app.inject({ method: 'GET', url: '/v1/schedule', headers: auth(token) })).json();
  assert.ok(block, 'block scheduled');

  // A foreign meeting is created exactly over the block.
  ctx.internalCalendar.simulateExternalEvent(linkId, {
    title: 'Emergency board meeting',
    start: block.start,
    end: block.end,
    busy: true,
  });
  await ctx.calendar.syncUser(userId);

  const [moved] = (await ctx.app.inject({ method: 'GET', url: '/v1/schedule', headers: auth(token) })).json();
  assert.equal(moved.state, 'moved');
  assert.ok(moved.start >= block.end || moved.end <= block.start, 'block no longer overlaps the meeting');

  const activity = (await ctx.app.inject({ method: 'GET', url: '/v1/activity', headers: auth(token) })).json();
  assert.ok(
    activity.some((a: { kind: string }) => a.kind === 'moved'),
    'user was told about the move',
  );
});

test('scrible-owned events are never treated as foreign conflicts', async () => {
  const ctx = testApp({ autoClassify: true, autoSchedule: true });
  const { token, userId } = await signup(ctx);
  await linkInternalCalendar(ctx, token);
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'idea3', rawText: 'idea: a what-if series on scrible power workflows sounds fun', source: 'voice' },
  });
  await ctx.jobs.onIdle();
  const [before] = (await ctx.app.inject({ method: 'GET', url: '/v1/schedule', headers: auth(token) })).json();
  // Sync pulls the Scrible-created event back — must not displace its own block.
  await ctx.calendar.syncUser(userId);
  await ctx.calendar.syncUser(userId);
  const [after] = (await ctx.app.inject({ method: 'GET', url: '/v1/schedule', headers: auth(token) })).json();
  assert.equal(after.start, before.start, 'block untouched by its own external event');
  assert.equal(after.state, 'confirmed');
});
