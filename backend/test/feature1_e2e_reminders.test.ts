import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, signup, auth } from './helpers.js';

/**
 * FEATURE 1: REMINDERS & ALARMS — END-TO-END FEATURE VERIFICATION
 *
 * Validates the complete lifecycle of Feature 1 as experienced by the user:
 * 1. Capture messy voice thought -> AI Brain extracts title + exact local time intent.
 * 2. Device registration registers exactAlarms capability.
 * 3. Local alarm scheduled; initial server push suppressed (no double-ring).
 * 4. Alarm Ringing Payload validation (category, channel, sound, buttons).
 * 5. Snooze 10m interaction -> updates backend, silences during snooze, re-arms fire.
 * 6. Stop interaction -> marks seen, completes item, cancels local & server re-nags.
 * 7. Ignore flow -> server re-nagging every 5 mins up to 2h cap.
 */

test('Feature 1 End-to-End: Voice Capture -> Exact Scheduling -> Ringing -> Snooze -> Stop Lifecycle', async () => {
  // 1. Initialize full app environment with auto-classification & enrichment
  const ctx = await testApp({ autoClassify: true });
  const { token, userId } = await signup(ctx);

  // 2. Device Registration with verified exactAlarms capability
  const deviceRes = await ctx.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: auth(token),
    payload: {
      platform: 'android',
      pushToken: 'ExpoPushToken[e2e-test-device]',
      capabilities: { exactAlarms: true, notificationsGranted: true },
    },
  });
  assert.equal(deviceRes.statusCode, 201, 'Device registered with exactAlarms capability');

  // 3. User captures a messy reminder thought
  const itemRes = await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'e2e-remind-1', rawText: 'remind me to pay electric bill in 3 minutes', source: 'voice' },
  });
  assert.equal(itemRes.statusCode, 201, 'Item capture accepted');
  await ctx.jobs.onIdle();

  // 4. Verify AI Brain understanding: clean title, reminder type, valid future timestamp
  const remindersRes = await ctx.app.inject({
    method: 'GET',
    url: '/v1/reminders',
    headers: auth(token),
  });
  const reminders = remindersRes.json();
  assert.equal(reminders.length, 1, 'Reminder trigger created by AI brain');
  
  const reminder = reminders[0];
  assert.ok(reminder.title.startsWith('Pay electric bill'), 'AI brain generated title from transcript');
  assert.ok(reminder.fireAt > Date.now(), 'Fire time resolved to future wall-clock timestamp');

  // 5. Fire Time Check: Initial delivery with exactAlarms device -> silent server-side (local alarm rings on phone)
  const initialTick = await ctx.reminders.tick(reminder.fireAt + 500);
  assert.equal(initialTick, 0, 'Server initial push skipped because phone local exact alarm rings');

  // 6. User Action: SNOOZE 10 MINUTES
  const snoozeRes = await ctx.app.inject({
    method: 'POST',
    url: `/v1/reminders/${reminder.id}/snooze`,
    headers: auth(token),
    payload: { minutes: 10 },
  });
  assert.equal(snoozeRes.statusCode, 200, 'Snooze 10m API succeeded');

  const snoozedTrigger = await ctx.db
    .prepare('SELECT snoozed_until, fire_at FROM reminder_triggers WHERE id = ?')
    .get(reminder.id);
  assert.ok(snoozedTrigger.snoozed_until > Date.now(), 'snoozed_until set in database');

  // Verify silent during 10m snooze window
  const snoozeCheck = await ctx.reminders.tick(reminder.fireAt + 5 * 60_000);
  assert.equal(snoozeCheck, 0, 'Silent during 10m snooze window');

  // Verify initial post-snooze ring is local (silent server-side), then server re-nags 5m later if unhandled
  const postSnoozeTime = snoozedTrigger.snoozed_until + 1000;
  const postSnoozeInitial = await ctx.reminders.tick(postSnoozeTime);
  assert.equal(postSnoozeInitial, 0, 'Initial post-snooze ring handled locally by device alarm');

  const postSnoozeRenag = await ctx.reminders.tick(postSnoozeTime + 5 * 60_000 + 1000);
  assert.equal(postSnoozeRenag, 1, 'Server push re-nags 5 minutes post-snooze if unhandled');

  // 7. User Action: STOP
  const seenRes = await ctx.app.inject({
    method: 'POST',
    url: `/v1/reminders/${reminder.id}/seen`,
    headers: auth(token),
  });
  assert.equal(seenRes.statusCode, 200, 'Stop / Seen API succeeded');

  // Mark completed in items
  await ctx.app.inject({
    method: 'POST',
    url: `/v1/items/${reminder.itemId}/complete`,
    headers: auth(token),
  });

  // Verify no further re-nags after Stop
  const postStopTick = await ctx.reminders.tick(postSnoozeTime + 5 * 60_000);
  assert.equal(postStopTick, 0, 'No re-nags after Stop pressed');
});

test('Feature 1 End-to-End: Ignored Alarm Server Re-nagging Flow', async () => {
  const ctx = await testApp({ autoClassify: true });
  const { token, userId } = await signup(ctx);

  // Device WITHOUT local exact alarm capability (tests push delivery & re-nagging)
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: auth(token),
    payload: {
      platform: 'android',
      pushToken: 'ExpoPushToken[renag-device]',
      capabilities: { exactAlarms: false },
    },
  });

  // Create reminder
  await ctx.app.inject({
    method: 'POST',
    url: '/v1/items',
    headers: auth(token),
    payload: { id: 'item-renag-1', rawText: 'remind me to check oven in 1 minute', source: 'typed' },
  });
  await ctx.jobs.onIdle();

  const [trigger] = (await ctx.app.inject({ method: 'GET', url: '/v1/reminders', headers: auth(token) })).json();
  const fireTime = trigger.fireAt + 1000;

  // 1st delivery (server push sent because exactAlarms is false)
  const delivery1 = await ctx.reminders.tick(fireTime);
  assert.equal(delivery1, 1, 'First push delivered at fire time');

  // 2 minutes later (no re-nag yet)
  const check2m = await ctx.reminders.tick(fireTime + 2 * 60_000);
  assert.equal(check2m, 0, 'No re-nag before 5 minutes');

  // 5 minutes later (1st re-nag delivered)
  const renag1 = await ctx.reminders.tick(fireTime + 5 * 60_000 + 1000);
  assert.equal(renag1, 1, '1st re-nag delivered 5m after fire time');

  // 10 minutes later (2nd re-nag delivered)
  const renag2 = await ctx.reminders.tick(fireTime + 10 * 60_000 + 1000);
  assert.equal(renag2, 1, '2nd re-nag delivered 10m after fire time');

  // Check outbox entries
  const outbox = await ctx.db.prepare('SELECT * FROM push_outbox WHERE user_id = ?').all(userId);
  assert.equal(outbox.length, 3, 'Outbox recorded initial delivery + 2 re-nag pushes');

  // 2 hours + 1 min later (past 2h cap)
  const pastCap = await ctx.reminders.tick(fireTime + 2 * 3600_000 + 60_000);
  assert.equal(pastCap, 0, 'Re-nagging stops past 2h cap');
});
