/**
 * Calendar service: two-way sync engine, availability model, auto-scheduling,
 * rescheduling cascade, and undo (build plan §7).
 *
 * Conflict rules (plan §7.2): external calendar wins for foreign events; most recent
 * user action wins for Scrible-owned events; a foreign event landing on a
 * Scrible-owned confirmed block displaces the block (moved + user told, never silent).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import type { SyncEngine } from '../modules/sync.js';
import type { Orchestrator } from '../ai/orchestrator.js';
import type { CalendarLinkRef, ProviderRegistry } from './provider.js';
import type { Item } from '../types.js';

const WINDOW_PAST_MS = 24 * 3600_000;
const WINDOW_FUTURE_MS = 30 * 24 * 3600_000;

export interface FreeSlot {
  start: number;
  end: number;
}

export class CalendarService {
  constructor(
    private db: Db,
    private sync: SyncEngine,
    private orchestrator: Orchestrator,
    private registry: ProviderRegistry,
  ) {}

  // ---------- links ----------

  createLink(userId: string, provider: string, accountId: string, tokens: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO calendar_links (id, user_id, provider, account_id, token_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, provider, accountId, encrypt(tokens), Date.now());
    return id;
  }

  links(userId: string): CalendarLinkRef[] {
    const rows = this.db
      .prepare('SELECT * FROM calendar_links WHERE user_id = ?')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      provider: String(r.provider),
      accountId: String(r.account_id),
      tokens: decrypt(String(r.token_ref)),
      syncState: JSON.parse(String(r.sync_state ?? '{}')),
    }));
  }

  removeLink(userId: string, linkId: string): void {
    this.db.prepare('DELETE FROM calendar_events WHERE calendar_link_id = ? AND user_id = ?').run(linkId, userId);
    this.db.prepare('DELETE FROM calendar_links WHERE id = ? AND user_id = ?').run(linkId, userId);
  }

  // ---------- two-way sync ----------

  /** Pull external changes for every link; detect conflicts; cascade displaced blocks. */
  async syncUser(userId: string): Promise<void> {
    const now = Date.now();
    for (const link of this.links(userId)) {
      const provider = this.registry.get(link.provider);
      const { events, syncState } = await provider.pullEvents(
        link,
        now - WINDOW_PAST_MS,
        now + WINDOW_FUTURE_MS,
      );
      this.db
        .prepare('UPDATE calendar_links SET sync_state = ? WHERE id = ?')
        .run(JSON.stringify(syncState), link.id);

      const scribleExternalIds = new Set(
        (
          this.db
            .prepare('SELECT external_event_id FROM schedule_blocks WHERE user_id = ? AND external_event_id IS NOT NULL')
            .all(userId) as Array<Record<string, unknown>>
        ).map((r) => String(r.external_event_id)),
      );

      for (const ev of events) {
        if (ev.deleted) {
          this.db
            .prepare('DELETE FROM calendar_events WHERE calendar_link_id = ? AND external_id = ?')
            .run(link.id, ev.externalId);
          continue;
        }
        const foreign = scribleExternalIds.has(ev.externalId) ? 0 : 1;
        this.db
          .prepare(
            `INSERT INTO calendar_events (id, user_id, calendar_link_id, external_id, title, start_ts, end_ts, busy, foreign_event, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(calendar_link_id, external_id) DO UPDATE SET
               title = excluded.title, start_ts = excluded.start_ts, end_ts = excluded.end_ts,
               busy = excluded.busy, updated_at = excluded.updated_at`,
          )
          .run(
            `int-${randomUUID()}`,
            userId,
            link.id,
            ev.externalId,
            ev.title,
            ev.start,
            ev.end,
            ev.busy ? 1 : 0,
            foreign,
            now,
          );
      }
      // Full-window replace for providers without tombstones: drop cached foreign
      // events in-window that no longer exist upstream (reconciliation sweep).
      const upstreamIds = new Set(events.filter((e) => !e.deleted).map((e) => e.externalId));
      if (!('syncToken' in syncState) && !('deltaLink' in syncState)) {
        const cached = this.db
          .prepare(
            'SELECT external_id FROM calendar_events WHERE calendar_link_id = ? AND start_ts < ? AND end_ts > ?',
          )
          .all(link.id, now + WINDOW_FUTURE_MS, now - WINDOW_PAST_MS) as Array<Record<string, unknown>>;
        for (const row of cached) {
          if (!upstreamIds.has(String(row.external_id))) {
            this.db
              .prepare('DELETE FROM calendar_events WHERE calendar_link_id = ? AND external_id = ?')
              .run(link.id, String(row.external_id));
          }
        }
      }
    }
    await this.cascadeConflicts(userId);
  }

  /** A foreign busy event overlapping a Scrible block displaces the block. */
  private async cascadeConflicts(userId: string): Promise<void> {
    const blocks = this.db
      .prepare(
        "SELECT * FROM schedule_blocks WHERE user_id = ? AND state IN ('proposed','confirmed') AND end_ts > ?",
      )
      .all(userId, Date.now()) as Array<Record<string, unknown>>;
    for (const block of blocks) {
      const conflict = this.db
        .prepare(
          `SELECT title FROM calendar_events WHERE user_id = ? AND foreign_event = 1 AND busy = 1
           AND start_ts < ? AND end_ts > ? LIMIT 1`,
        )
        .get(userId, Number(block.end_ts), Number(block.start_ts)) as { title: string } | undefined;
      if (!conflict) continue;
      const item = this.sync.itemById(userId, String(block.item_id));
      if (!item) continue;
      const moved = await this.placeBlock(userId, item, {
        excludeBlockId: String(block.id),
        notBefore: Date.now(),
      });
      if (moved) {
        await this.moveBlock(userId, String(block.id), moved.start, moved.end, {
          reason: `"${conflict.title || 'a new event'}" landed on this slot`,
          state: 'moved',
        });
      } else {
        this.recordActivity(
          userId,
          `Your calendar filled up — couldn't find a new slot for "${item.title}". Pick a time?`,
          'conflict',
          { itemId: item.id, blockId: String(block.id), undoable: false },
        );
      }
    }
  }

  // ---------- availability ----------

  freeSlots(userId: string, from: number, to: number, excludeBlockId?: string): FreeSlot[] {
    const user = this.db.prepare('SELECT working_hours, timezone FROM users WHERE id = ?').get(userId) as
      | { working_hours: string; timezone: string }
      | undefined;
    const wh = JSON.parse(user?.working_hours ?? '{"start":9,"end":18,"days":[1,2,3,4,5]}') as {
      start: number;
      end: number;
      days: number[];
    };

    const busy: Array<{ start: number; end: number }> = [];
    const events = this.db
      .prepare(
        'SELECT start_ts, end_ts FROM calendar_events WHERE user_id = ? AND busy = 1 AND end_ts > ? AND start_ts < ?',
      )
      .all(userId, from, to) as Array<Record<string, unknown>>;
    for (const e of events) busy.push({ start: Number(e.start_ts), end: Number(e.end_ts) });
    const blocks = this.db
      .prepare(
        "SELECT id, start_ts, end_ts FROM schedule_blocks WHERE user_id = ? AND state IN ('proposed','confirmed','moved') AND end_ts > ? AND start_ts < ?",
      )
      .all(userId, from, to) as Array<Record<string, unknown>>;
    for (const b of blocks) {
      if (excludeBlockId && String(b.id) === excludeBlockId) continue;
      busy.push({ start: Number(b.start_ts), end: Number(b.end_ts) });
    }
    busy.sort((a, b) => a.start - b.start);

    // Working-hour windows per day, minus busy intervals.
    const slots: FreeSlot[] = [];
    const cursorDay = new Date(from);
    cursorDay.setHours(0, 0, 0, 0);
    for (let day = new Date(cursorDay); day.getTime() < to; day.setDate(day.getDate() + 1)) {
      if (!wh.days.includes(day.getDay())) continue;
      const winStart = Math.max(new Date(day).setHours(wh.start, 0, 0, 0), from);
      const winEnd = Math.min(new Date(day).setHours(wh.end, 0, 0, 0), to);
      if (winEnd <= winStart) continue;
      let cursor = winStart;
      for (const b of busy) {
        if (b.end <= cursor || b.start >= winEnd) continue;
        if (b.start > cursor) slots.push({ start: cursor, end: Math.min(b.start, winEnd) });
        cursor = Math.max(cursor, b.end);
        if (cursor >= winEnd) break;
      }
      if (cursor < winEnd) slots.push({ start: cursor, end: winEnd });
    }
    return slots.filter((s) => s.end - s.start >= 15 * 60_000);
  }

  // ---------- auto-scheduling ----------

  private async placeBlock(
    userId: string,
    item: Item,
    opts: { excludeBlockId?: string; notBefore?: number } = {},
  ): Promise<{ start: number; end: number; rationale: string } | null> {
    const from = Math.max(opts.notBefore ?? Date.now(), Date.now());
    const slots = this.freeSlots(userId, from, from + 14 * 24 * 3600_000, opts.excludeBlockId);
    if (slots.length === 0) return null;
    const user = this.db.prepare('SELECT working_hours, timezone FROM users WHERE id = ?').get(userId) as {
      working_hours: string;
      timezone: string;
    };
    const profileRow = this.db.prepare('SELECT attributes FROM profiles WHERE user_id = ?').get(userId) as
      | { attributes: string }
      | undefined;
    try {
      return await this.orchestrator.run('schedule', {
        itemTitle: item.title,
        itemType: item.type,
        timeIntent: item.timeIntent,
        freeSlots: slots,
        preferences: {
          workingHours: JSON.parse(user.working_hours),
          timezone: user.timezone,
        },
        profile: profileRow ? JSON.parse(profileRow.attributes) : null,
      });
    } catch {
      return null;
    }
  }

  /**
   * Auto-schedule an idea (or schedulable task) onto the user's real calendar.
   * Default mode: auto-accept with easy undo (plan §7.4).
   */
  async autoSchedule(userId: string, itemId: string): Promise<void> {
    const item = this.sync.itemById(userId, itemId);
    if (!item || item.status === 'done') return;
    const existing = this.db
      .prepare("SELECT id FROM schedule_blocks WHERE item_id = ? AND state != 'released'")
      .get(itemId);
    if (existing) return;

    const placed = await this.placeBlock(userId, item, { notBefore: item.timeIntent?.at });
    if (!placed) {
      this.recordActivity(
        userId,
        `Couldn't find a free slot for "${item.title}" in the next two weeks — your calendar is full.`,
        'conflict',
        { itemId, undoable: false },
      );
      return;
    }

    const blockId = randomUUID();
    let externalEventId: string | null = null;
    let linkId: string | null = null;
    const [link] = this.links(userId);
    if (link) {
      try {
        externalEventId = await this.registry.get(link.provider).createEvent(link, {
          title: `Scrible: ${item.title}`,
          start: placed.start,
          end: placed.end,
          busy: true,
        });
        linkId = link.id;
      } catch {
        // External write failed — keep the internal block; sync sweep will retry semantics later.
      }
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO schedule_blocks (id, user_id, item_id, start_ts, end_ts, state, calendar_link_id, external_event_id, rationale, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`,
      )
      .run(blockId, userId, itemId, placed.start, placed.end, linkId, externalEventId, placed.rationale, now, now);

    this.sync.serverUpdateItem(userId, itemId, { status: 'scheduled', timeIntent: { ...(item.timeIntent ?? {}), at: placed.start } });
    const confirm = await this.orchestrator.run('confirm', {
      event: 'scheduled',
      itemTitle: item.title,
      itemType: item.type,
      detail: { when: formatWhen(placed.start), rationale: placed.rationale },
    });
    this.recordActivity(userId, confirm.message, 'scheduled', { itemId, blockId, undoable: true });
    this.sync.audit(userId, 'item.scheduled', 'schedule_block', blockId, { start: placed.start, end: placed.end }, true);
  }

  async moveBlock(
    userId: string,
    blockId: string,
    start: number,
    end: number,
    opts: { reason?: string; state?: 'confirmed' | 'moved' } = {},
  ): Promise<void> {
    const block = this.db
      .prepare('SELECT * FROM schedule_blocks WHERE id = ? AND user_id = ?')
      .get(blockId, userId) as Record<string, unknown> | undefined;
    if (!block) return;
    this.db
      .prepare('UPDATE schedule_blocks SET start_ts = ?, end_ts = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(start, end, opts.state ?? 'confirmed', Date.now(), blockId);
    const item = this.sync.itemById(userId, String(block.item_id));
    if (block.external_event_id && block.calendar_link_id) {
      const link = this.links(userId).find((l) => l.id === String(block.calendar_link_id));
      if (link) {
        try {
          await this.registry.get(link.provider).updateEvent(link, {
            externalId: String(block.external_event_id),
            title: `Scrible: ${item?.title ?? 'block'}`,
            start,
            end,
            busy: true,
          });
        } catch {
          /* external move failed — reconciliation sweep will retry */
        }
      }
    }
    if (item) {
      this.sync.serverUpdateItem(userId, item.id, { timeIntent: { ...(item.timeIntent ?? {}), at: start } });
      const confirm = await this.orchestrator.run('confirm', {
        event: 'moved',
        itemTitle: item.title,
        itemType: item.type,
        detail: { when: formatWhen(start), rationale: opts.reason },
      });
      this.recordActivity(userId, confirm.message, 'moved', { itemId: item.id, blockId, undoable: true });
    }
  }

  /** One-tap undo: release the block and remove it from the external calendar too. */
  async undoBlock(userId: string, blockId: string): Promise<boolean> {
    const block = this.db
      .prepare('SELECT * FROM schedule_blocks WHERE id = ? AND user_id = ?')
      .get(blockId, userId) as Record<string, unknown> | undefined;
    if (!block) return false;
    this.db
      .prepare("UPDATE schedule_blocks SET state = 'released', updated_at = ? WHERE id = ?")
      .run(Date.now(), blockId);
    if (block.external_event_id && block.calendar_link_id) {
      const link = this.links(userId).find((l) => l.id === String(block.calendar_link_id));
      if (link) {
        try {
          await this.registry.get(link.provider).deleteEvent(link, String(block.external_event_id));
          this.db
            .prepare('DELETE FROM calendar_events WHERE calendar_link_id = ? AND external_id = ?')
            .run(link.id, String(block.external_event_id));
        } catch {
          /* retried by sweep */
        }
      }
    }
    const item = this.sync.itemById(userId, String(block.item_id));
    if (item) {
      this.sync.serverUpdateItem(userId, item.id, { status: 'active' });
      this.recordActivity(userId, `Unscheduled "${item.title}" — it's back in your queue.`, 'unscheduled', {
        itemId: item.id,
        blockId,
        undoable: false,
      });
    }
    return true;
  }

  // ---------- activity feed ----------

  recordActivity(
    userId: string,
    message: string,
    kind: string,
    opts: { itemId?: string; blockId?: string; undoable?: boolean },
  ): void {
    const id = randomUUID();
    const row = {
      id,
      message,
      kind,
      itemId: opts.itemId ?? null,
      blockId: opts.blockId ?? null,
      undoable: opts.undoable ?? false,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO activity (id, user_id, message, kind, item_id, block_id, undoable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, message, kind, row.itemId, row.blockId, row.undoable ? 1 : 0, row.createdAt);
    // Confirmations ride the same change feed the items do — never silent.
    this.sync.recordChange(userId, 'activity', id, 'upsert', row);
  }
}

export function formatWhen(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}
