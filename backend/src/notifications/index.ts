/**
 * Notification dispatch + server-side reminder scheduling (build plan §7.5).
 * One module owns delivery, dedup, and quiet hours so a reminder never fires twice
 * across channels. Push senders are pluggable: real delivery (Expo push — see
 * expoPush.ts) plus a dev sender that records to push_outbox — the outbox also
 * powers delivery assertions in tests and the extension's pull channel (Phase 3).
 *
 * Escalation (peak-assistant standard): an unacknowledged reminder re-nags every
 * RENAG_INTERVAL_MS until RENAG_CAP_MS after its due time, or until it's seen
 * (tapped, completed, or snoozed) — see ReminderScheduler.tick().
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import type { SyncEngine } from '../modules/sync.js';
import type { Orchestrator } from '../ai/orchestrator.js';

export interface PushSendOpts {
  data?: Record<string, unknown>;
  /** Client-registered notification category (e.g. 'reminder' → Stop/Snooze actions). */
  categoryId?: string;
}

export interface PushSender {
  /** e.g. 'apns' | 'fcm' | 'outbox' */
  channel: string;
  supports(platform: string): boolean;
  send(deviceToken: string | null, title: string, body: string, opts?: PushSendOpts): Promise<void>;
}

/** Dev/test sender — delivery is observable in the push_outbox table. */
export class OutboxSender implements PushSender {
  channel = 'outbox';
  constructor(private db: Db) {}
  supports(): boolean {
    return true;
  }
  async send(): Promise<void> {
    /* row is written by the dispatcher (needs user/device context) */
  }
}

export class NotificationDispatcher {
  constructor(
    private db: Db,
    private senders: PushSender[] = [],
  ) {}

  /**
   * Deliver one logical notification to a user across their devices, exactly once
   * per dedup key. Returns true if anything was (newly) delivered.
   */
  async notify(
    userId: string,
    dedupKey: string,
    title: string,
    body: string,
    opts: { respectQuietHours?: boolean; data?: Record<string, unknown>; categoryId?: string } = {},
  ): Promise<boolean> {
    const seen = await this.db
      .prepare('SELECT id FROM push_outbox WHERE user_id = ? AND dedup_key = ? LIMIT 1')
      .get(userId, dedupKey);
    if (seen) return false;

    if (opts.respectQuietHours && (await this.inQuietHours(userId))) return false;

    const devices = (await this.db
      .prepare('SELECT id, platform, push_token FROM devices WHERE user_id = ?')
      .all(userId)) as Array<Record<string, unknown>>;
    const targets = devices.length > 0 ? devices : [{ id: 'no-device', platform: 'none', push_token: null }];
    for (const device of targets) {
      const sender =
        this.senders.find((s) => s.channel !== 'outbox' && s.supports(String(device.platform))) ??
        this.senders.find((s) => s.channel === 'outbox');
      const channel = sender?.channel ?? 'outbox';
      await this.db
        .prepare(
          'INSERT INTO push_outbox (id, user_id, device_id, channel, title, body, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), userId, String(device.id), channel, title, body, dedupKey, Date.now());
      if (sender && sender.channel !== 'outbox') {
        try {
          await sender.send(device.push_token as string | null, title, body, { data: opts.data, categoryId: opts.categoryId });
        } catch {
          /* provider failure — outbox row stands as the retry record */
        }
      }
    }
    return true;
  }

  private async inQuietHours(userId: string): Promise<boolean> {
    const row = (await this.db.prepare('SELECT notification_prefs FROM users WHERE id = ?').get(userId)) as
      | { notification_prefs: string }
      | undefined;
    const prefs = JSON.parse(row?.notification_prefs ?? '{}') as {
      quietHours?: { start: number; end: number };
    };
    if (!prefs.quietHours) return false;
    const h = new Date().getHours();
    const { start, end } = prefs.quietHours;
    return start <= end ? h >= start && h < end : h >= start || h < end;
  }
}

/** Re-nag cadence for an unacknowledged reminder — the "won't let it go" behavior. */
const RENAG_INTERVAL_MS = 5 * 60_000;
/** Stop escalating this long after the original due time; item stays overdue in the queue. */
const RENAG_CAP_MS = 2 * 3600_000;

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    private sync: SyncEngine,
    private dispatcher: NotificationDispatcher,
    private orchestrator: Orchestrator,
  ) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Create/refresh the trigger for a reminder-type item with a resolved time. */
  async ensureTrigger(userId: string, itemId: string, fireAt: number, recurrence?: string): Promise<void> {
    const existing = (await this.db
      .prepare('SELECT id FROM reminder_triggers WHERE item_id = ? AND user_id = ?')
      .get(itemId, userId)) as { id: string } | undefined;
    const now = Date.now();
    if (existing) {
      await this.db
        .prepare(
          'UPDATE reminder_triggers SET fire_at = ?, recurrence = ?, delivered_at = NULL, seen_at = NULL, updated_at = ? WHERE id = ?',
        )
        .run(fireAt, recurrence ?? null, now, existing.id);
      return;
    }
    await this.db
      .prepare(
        'INSERT INTO reminder_triggers (id, user_id, item_id, fire_at, recurrence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), userId, itemId, fireAt, recurrence ?? null, now, now);
  }

  async snooze(userId: string, triggerId: string, minutes: number): Promise<boolean> {
    const trigger = await this.db
      .prepare('SELECT id FROM reminder_triggers WHERE id = ? AND user_id = ?')
      .get(triggerId, userId);
    if (!trigger) return false;
    const until = Date.now() + minutes * 60_000;
    // Snooze re-arms delivery and syncs across devices via the change feed.
    await this.db
      .prepare(
        'UPDATE reminder_triggers SET snoozed_until = ?, fire_at = ?, delivered_at = NULL, seen_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(until, until, Date.now(), triggerId);
    return true;
  }

  /** Acknowledge a trigger (notification tapped) — stops further re-nagging. */
  async markSeen(userId: string, triggerId: string): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE reminder_triggers SET seen_at = ? WHERE id = ? AND user_id = ?')
      .run(Date.now(), triggerId, userId);
    return res.changes > 0;
  }

  /**
   * Deliver every due, unacknowledged trigger — re-nagging every RENAG_INTERVAL_MS
   * until RENAG_CAP_MS after the due time, or until seen (tapped/completed/snoozed).
   * Called on an interval; test-callable.
   */
  async tick(now = Date.now()): Promise<number> {
    const due = (await this.db
      .prepare(
        `SELECT rt.*, i.title, i.type, i.status FROM reminder_triggers rt
         JOIN items i ON i.id = rt.item_id
         WHERE rt.fire_at <= ? AND rt.fire_at > ? AND rt.seen_at IS NULL
           AND (rt.delivered_at IS NULL OR rt.delivered_at <= ?)`,
      )
      .all(now, now - RENAG_CAP_MS, now - RENAG_INTERVAL_MS)) as Array<Record<string, unknown>>;
    let delivered = 0;
    for (const trigger of due) {
      const userId = String(trigger.user_id);
      const itemId = String(trigger.item_id);
      const isFirstDelivery = trigger.delivered_at == null;
      if (trigger.status === 'done' || trigger.status === 'dismissed') {
        await this.db
          .prepare('UPDATE reminder_triggers SET delivered_at = ?, seen_at = ? WHERE id = ?')
          .run(now, now, String(trigger.id));
        continue;
      }
      let message: string;
      try {
        const confirm = await this.orchestrator.run('confirm', {
          event: 'reminder_set',
          itemTitle: String(trigger.title),
          itemType: trigger.type as 'reminder',
          detail: { when: 'now' },
        });
        message = confirm.message;
      } catch {
        message = `Reminder: ${String(trigger.title)}`;
      }
      // Explicit-time reminders fire regardless of quiet hours — the user asked.
      // Dedup key includes `now` (not the constant fire_at) so each re-nag attempt
      // is its own delivery, not deduped against the first one.
      const sent = await this.dispatcher.notify(
        userId,
        `reminder:${String(trigger.id)}:${now}`,
        'Scrible',
        message,
        { data: { reminderId: String(trigger.id) }, categoryId: 'reminder' },
      );
      await this.db.prepare('UPDATE reminder_triggers SET delivered_at = ?, updated_at = ? WHERE id = ?').run(now, now, String(trigger.id));
      if (sent) delivered++;

      // Recurrence and the audit trail are logical, one-time events tied to the
      // reminder's original due time — only fire them on the first delivery, not
      // on every re-nag.
      if (isFirstDelivery) {
        if (trigger.recurrence) {
          const next = nextOccurrence(Number(trigger.fire_at), String(trigger.recurrence));
          if (next) {
            await this.db
              .prepare(
                'INSERT INTO reminder_triggers (id, user_id, item_id, fire_at, recurrence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              )
              .run(randomUUID(), userId, itemId, next, String(trigger.recurrence), now, now);
          }
        }
        await this.sync.audit(userId, 'reminder.delivered', 'reminder_trigger', String(trigger.id), { fireAt: trigger.fire_at });
      }
    }
    return delivered;
  }
}

export function nextOccurrence(from: number, recurrence: string): number | null {
  const d = new Date(from);
  switch (recurrence) {
    case 'day':
      d.setDate(d.getDate() + 1);
      return d.getTime();
    case 'week':
      d.setDate(d.getDate() + 7);
      return d.getTime();
    default: {
      const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      if (weekdays.includes(recurrence)) {
        d.setDate(d.getDate() + 7);
        return d.getTime();
      }
      return null;
    }
  }
}
