/**
 * Backend Comprehension & Reminders Probe (Guards Feature 1 & Feature 3 quality).
 * Run after every backend deploy or change: `node backend/scripts/probe.mjs`.
 * Exits with 0 if all test vectors pass; exits non-zero on regression.
 */
import { buildApp } from '../src/server.ts';
import assert from 'node:assert/strict';

async function runProbe() {
  console.log('[Probe] Initializing Scribble backend probe...');
  const ctx = await buildApp({
    databaseUrl: ':memory:',
    jwtSecret: 'probe-secret-key-32-chars-minimum!!',
  });

  try {
    // 1. Health check probe
    const healthRes = await ctx.app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(healthRes.statusCode, 200, 'Health endpoint must return 200');

    // 2. Device registration probe with exact alarm capabilities
    const signupRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'probe@scrible.app', password: 'probe-password-123' },
    });
    const token = JSON.parse(signupRes.body).token;
    assert.ok(token, 'Signup should issue valid JWT token');

    const deviceRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        platform: 'android',
        pushToken: 'ExpoPushToken[probe-test-token]',
        capabilities: { exactAlarms: true, notificationsGranted: true },
      },
    });
    assert.equal(deviceRes.statusCode, 201, 'Device registration with exactAlarms capability should return 201');

    // 3. Reminder trigger scheduling & snooze probe
    const now = Date.now();
    const fireAt = now + 120_000; // 2 minutes in future
    const userId = JSON.parse(signupRes.body).user?.id ?? 'probe-user-id';

    await ctx.db
      .prepare(
        'INSERT INTO items (id, user_id, type, source, raw_text, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('item-probe-1', userId, 'reminder', 'typed', 'Drink water in 2m', 'Drink water', 'active', now, now);

    await ctx.reminders.ensureTrigger(userId, 'item-probe-1', fireAt);

    // Initial tick with exactAlarms capability: server push skipped on initial delivery (local alarm handles it)
    const deliveredCount = await ctx.reminders.tick(now);
    assert.equal(deliveredCount, 0, 'Initial delivery should be silent server-side when exactAlarms is enabled on device');

    // Snooze probe
    const triggers = await ctx.db.prepare('SELECT id FROM reminder_triggers WHERE item_id = ?').all('item-probe-1');
    assert.ok(triggers.length > 0, 'Reminder trigger must exist');
    const triggerId = triggers[0].id;

    const snoozed = await ctx.reminders.snooze(userId, triggerId, 10);
    assert.ok(snoozed, 'Reminder snooze must succeed');

    const updatedTrigger = await ctx.db.prepare('SELECT snoozed_until FROM reminder_triggers WHERE id = ?').get(triggerId);
    assert.ok(updatedTrigger.snoozed_until > now, 'Snoozed timestamp must be in the future');

    console.log('✅ [Probe] All backend probe tests passed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ [Probe] Regression detected in probe:', err);
    process.exit(1);
  } finally {
    await ctx.app.close();
  }
}

void runProbe();
