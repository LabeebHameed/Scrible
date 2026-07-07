/**
 * Notification dispatch + server-side reminder scheduling (build plan §7.5).
 * One module owns delivery, dedup, and quiet hours so a reminder never fires twice
 * across channels. Push senders are pluggable: APNs/FCM in production (credentials
 * via env), a dev sender that records to push_outbox otherwise — the outbox also
 * powers delivery assertions in tests and the extension's pull channel (Phase 3).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import type { SyncEngine } from '../modules/sync.js';
import type { Orchestrator } from '../ai/orchestrator.js';

export interface PushSender {
  /** e.g. 'apns' | 'fcm' | 'outbox' */
  channel: string;
  supports(platform: string): boolean;
  send(deviceToken: string | null, title: string, body: string): Promise<void>;
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
    opts: { respectQuietHours?: boolean } = {},
  ): Promise<boolean> {
    const seen = this.db
      .prepare('SELECT id FROM push_outbox WHERE user_id = ? AND dedup_key = ? LIMIT 1')
      .get(userId, dedupKey);
    if (seen) return false;

    if (opts.respectQuietHours && this.inQuietHours(userId)) return false;

    const devices = this.db
      .prepare('SELECT id, platform, push_token FROM devices WHERE user_id = ?')
      .all(userId) as Array<Record<string, unknown>>;
    const targets = devices.length > 0 ? devices : [{ id: 'no-device', platform: 'none', push_token: null }];
    for (const device of targets) {
      const sender =
        this.senders.find((s) => s.channel !== 'outbox' && s.supports(String(device.platform))) ??
        this.senders.find((s) => s.channel === 'outbox');
      const channel = sender?.channel ?? 'outbox';
      this.db
        .prepare(
          'INSERT INTO push_outbox (id, user_id, device_id, channel, title, body, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), userId, String(device.id), channel, title, body, dedupKey, Date.now());
      if (sender && sender.channel !== 'outbox') {
        try {
          await sender.send(device.push_token as string | null, title, body);
        } catch {
          /* provider failure — outbox row stands as the retry record */
        }
      }
    }
    return true;
  }

  private inQuietHours(userId: string): boolean {
    const row = this.db.prepare('SELECT notification_prefs FROM users WHERE id = ?').get(userId) as
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
  ensureTrigger(userId: string, itemId: string, fireAt: number, recurrence?: string): void {
    const existing = this.db
      .prepare('SELECT id FROM reminder_triggers WHERE item_id = ? AND user_id = ?')
      .get(itemId, userId) as { id: string } | undefined;
    const now = Date.now();
    if (existing) {
      this.db
        .prepare(
          'UPDATE reminder_triggers SET fire_at = ?, recurrence = ?, delivered_at = NULL, updated_at = ? WHERE id = ?',
        )
        .run(fireAt, recurrence ?? null, now, existing.id);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO reminder_triggers (id, user_id, item_id, fire_at, recurrence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), userId, itemId, fireAt, recurrence ?? null, now, now);
  }

  snooze(userId: string, triggerId: string, minutes: number): boolean {
    const trigger = this.db
      .prepare('SELECT id FROM reminder_triggers WHERE id = ? AND user_id = ?')
      .get(triggerId, userId);
    if (!trigger) return false;
    const until = Date.now() + minutes * 60_000;
    // Snooze re-arms delivery and syncs across devices via the change feed.
    this.db
      .prepare('UPDATE reminder_triggers SET snoozed_until = ?, fire_at = ?, delivered_at = NULL, updated_at = ? WHERE id = ?')
      .run(until, until, Date.now(), triggerId);
    return true;
  }

  /** Deliver every due, undelivered trigger. Called on an interval; test-callable. */
  async tick(now = Date.now()): Promise<number> {
    const due = this.db
      .prepare(
        `SELECT rt.*, i.title, i.type, i.status FROM reminder_triggers rt
         JOIN items i ON i.id = rt.item_id
         WHERE rt.fire_at <= ? AND rt.delivered_at IS NULL`,
      )
      .all(now) as Array<Record<string, unknown>>;
    let delivered = 0;
    for (const trigger of due) {
      const userId = String(trigger.user_id);
      const itemId = String(trigger.item_id);
      if (trigger.status === 'done' || trigger.status === 'dismissed') {
        this.db.prepare('UPDATE reminder_triggers SET delivered_at = ? WHERE id = ?').run(now, String(trigger.id));
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
      const sent = await this.dispatcher.notify(
        userId,
        `reminder:${String(trigger.id)}:${String(trigger.fire_at)}`,
        'Scrible',
        message,
      );
      this.db.prepare('UPDATE reminder_triggers SET delivered_at = ?, updated_at = ? WHERE id = ?').run(now, now, String(trigger.id));
      if (sent) delivered++;

      if (trigger.recurrence) {
        const next = nextOccurrence(Number(trigger.fire_at), String(trigger.recurrence));
        if (next) {
          this.db
            .prepare(
              'INSERT INTO reminder_triggers (id, user_id, item_id, fire_at, recurrence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(randomUUID(), userId, itemId, next, String(trigger.recurrence), now, now);
        }
      }
      this.sync.audit(userId, 'reminder.delivered', 'reminder_trigger', String(trigger.id), { fireAt: trigger.fire_at });
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
