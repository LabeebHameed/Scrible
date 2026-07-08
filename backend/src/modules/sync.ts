/**
 * Sync backbone (build plan §2.2 / §5.4).
 *
 * Server-authoritative, offline-first: clients queue SyncOps locally and replay them;
 * every op is idempotent (opId); the server appends resulting entity states to a
 * per-user change feed that clients consume via GET /v1/sync/changes and SSE.
 *
 * Conflict policy: last-writer-wins per field (client action timestamps), with two
 * exceptions that must never be lost — completions and new captures always survive.
 */
import type { Db } from '../lib/db.js';
import type { ChangeRow, Item, ItemType, Subtask, SyncOp } from '../types.js';
import { randomUUID } from 'node:crypto';
import { hasConsent } from './consent.js';
import { learnFromCorrection, learnAppAlias } from '../ai/learning.js';

type Listener = (change: ChangeRow) => void;

export class SyncEngine {
  private listeners = new Map<string, Set<Listener>>();
  /** Fired after an item is newly created via ops — Phase 1 hooks enrichment here. */
  onItemCreated: ((userId: string, itemId: string) => void) | null = null;

  constructor(private db: Db) {}

  subscribe(userId: string, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  private publish(userId: string, change: ChangeRow): void {
    for (const fn of this.listeners.get(userId) ?? []) {
      try {
        fn(change);
      } catch {
        /* one bad listener must not break the feed */
      }
    }
  }

  changesSince(userId: string, since: number, limit = 500): ChangeRow[] {
    const rows = this.db
      .prepare(
        'SELECT seq, entity_type, entity_id, op, data, ts FROM changes WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .all(userId, since, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      op: r.op as ChangeRow['op'],
      data: r.data ? JSON.parse(String(r.data)) : null,
      ts: Number(r.ts),
    }));
  }

  /** Append an entity state to the change feed and notify live subscribers. */
  recordChange(
    userId: string,
    entityType: string,
    entityId: string,
    op: 'upsert' | 'delete',
    data: unknown,
  ): ChangeRow {
    const ts = Date.now();
    const res = this.db
      .prepare(
        'INSERT INTO changes (user_id, entity_type, entity_id, op, data, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(userId, entityType, entityId, op, data == null ? null : JSON.stringify(data), ts);
    const change: ChangeRow = {
      seq: Number(res.lastInsertRowid),
      entityType,
      entityId,
      op,
      data,
      ts,
    };
    this.publish(userId, change);
    return change;
  }

  itemById(userId: string, id: string): Item | null {
    const r = this.db
      .prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    return r ? rowToItem(r) : null;
  }

  subtasksFor(userId: string, itemId: string): Subtask[] {
    const rows = this.db
      .prepare('SELECT * FROM subtasks WHERE item_id = ? AND user_id = ? ORDER BY position')
      .all(itemId, userId) as Array<Record<string, unknown>>;
    return rows.map(rowToSubtask);
  }

  /** Apply a batch of client ops. Returns per-op status. */
  applyOps(userId: string, ops: SyncOp[]): Array<{ opId: string; status: string }> {
    const results: Array<{ opId: string; status: string }> = [];
    const createdItems: string[] = [];
    for (const op of ops) {
      const seen = this.db
        .prepare('SELECT result FROM processed_ops WHERE op_id = ? AND user_id = ?')
        .get(op.opId, userId) as { result: string } | undefined;
      if (seen) {
        results.push({ opId: op.opId, status: 'duplicate' });
        continue;
      }
      // Clock-skew guard (plan §11.3): a client with a fast clock must not poison
      // per-field LWW timestamps far into the future (which would make every later
      // legitimate edit look stale). Clamp to now + 5 minutes.
      const clamped = { ...op, ts: Math.min(op.ts, Date.now() + 5 * 60_000) };
      let status: string;
      try {
        status = this.applyOne(userId, clamped, createdItems);
      } catch (err) {
        status = `error:${err instanceof Error ? err.message : 'unknown'}`;
      }
      this.db
        .prepare(
          'INSERT INTO processed_ops (op_id, user_id, result, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(op.opId, userId, status, Date.now());
      results.push({ opId: op.opId, status });
    }
    for (const itemId of createdItems) this.onItemCreated?.(userId, itemId);
    return results;
  }

  private applyOne(userId: string, op: SyncOp, createdItems: string[]): string {
    const d = op.data ?? {};
    switch (op.kind) {
      case 'item.create': {
        // New captures always survive: id is client-generated; re-insert is a no-op.
        if (this.itemById(userId, op.entityId)) return 'exists';
        const rawText = String(d.rawText ?? d.title ?? '');
        if (!rawText.trim()) return 'error:empty';
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO items (id, user_id, type, source, raw_text, title, status, context_tag, app_trigger, time_intent, field_versions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            op.entityId,
            userId,
            typeof d.type === 'string' ? d.type : 'task',
            typeof d.source === 'string' ? d.source : 'typed',
            rawText,
            String(d.title ?? rawText).slice(0, 200),
            typeof d.type === 'string' ? 'active' : 'captured',
            typeof d.contextTag === 'string' ? d.contextTag : null,
            typeof d.appTrigger === 'string' ? d.appTrigger : null,
            d.timeIntent ? JSON.stringify(d.timeIntent) : null,
            '{}',
            op.ts || now,
            op.ts || now,
          );
        this.emitItem(userId, op.entityId);
        createdItems.push(op.entityId);
        return 'created';
      }
      case 'item.update':
      case 'item.retype': {
        const item = this.rawItem(userId, op.entityId);
        if (!item) return 'missing';
        const versions = JSON.parse(String(item.field_versions ?? '{}')) as Record<
          string,
          number
        >;
        const editable = ['title', 'rawText', 'type', 'status', 'contextTag', 'appTrigger', 'timeIntent', 'summary', 'confidence'] as const;
        const colOf: Record<string, string> = {
          title: 'title',
          rawText: 'raw_text',
          type: 'type',
          status: 'status',
          contextTag: 'context_tag',
          appTrigger: 'app_trigger',
          timeIntent: 'time_intent',
          summary: 'summary',
          confidence: 'confidence',
        };
        const sets: string[] = [];
        const vals: Array<string | number | null> = [];
        const applied = new Set<string>();
        for (const f of editable) {
          if (!(f in d)) continue;
          // LWW per field; completions always win over concurrent edits.
          if ((versions[f] ?? 0) > op.ts) continue;
          if (f === 'status' && item.status === 'done' && d[f] !== 'done') continue;
          sets.push(`${colOf[f]} = ?`);
          const v = d[f];
          vals.push(
            f === 'timeIntent'
              ? v == null
                ? null
                : JSON.stringify(v)
              : v == null
                ? null
                : typeof v === 'number'
                  ? v
                  : String(v),
          );
          versions[f] = op.ts;
          applied.add(f);
        }
        if (sets.length === 0) return 'stale';
        sets.push('field_versions = ?', 'updated_at = ?');
        vals.push(JSON.stringify(versions), Date.now());
        this.db
          .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
          .run(...vals, op.entityId, userId);
        // Context engine (Phase 8): teach only from the user's OWN corrections/edits,
        // never from our own server-originated updates (serverUpdateItem flags those).
        const isUserOrigin = d.origin !== 'server';
        if (op.kind === 'item.retype') {
          this.audit(userId, 'classification.corrected', 'item', op.entityId, {
            from: item.type,
            to: d.type,
          });
          if (isUserOrigin && applied.has('type') && hasConsent(this.db, userId, 'chat_import')) {
            learnFromCorrection(this.db, userId, String(item.raw_text), item.type as ItemType, String(d.type) as ItemType);
          }
        }
        if (
          isUserOrigin &&
          applied.has('appTrigger') &&
          typeof d.appTrigger === 'string' &&
          d.appTrigger &&
          hasConsent(this.db, userId, 'chat_import')
        ) {
          learnAppAlias(this.db, userId, String(item.raw_text), d.appTrigger);
        }
        this.emitItem(userId, op.entityId);
        return 'updated';
      }
      case 'item.complete': {
        const item = this.rawItem(userId, op.entityId);
        if (!item) return 'missing';
        // Completions always survive conflicts — apply unconditionally.
        this.db
          .prepare(
            'UPDATE items SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
          )
          .run('done', op.ts || Date.now(), Date.now(), op.entityId, userId);
        this.emitItem(userId, op.entityId);
        return 'completed';
      }
      case 'item.reopen': {
        const item = this.rawItem(userId, op.entityId);
        if (!item) return 'missing';
        this.db
          .prepare(
            'UPDATE items SET status = ?, completed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?',
          )
          .run('active', Date.now(), op.entityId, userId);
        this.emitItem(userId, op.entityId);
        return 'reopened';
      }
      case 'item.delete': {
        const item = this.rawItem(userId, op.entityId);
        if (!item) return 'missing';
        this.db.prepare('DELETE FROM reminder_triggers WHERE item_id = ? AND user_id = ?').run(op.entityId, userId);
        this.db.prepare('DELETE FROM schedule_blocks WHERE item_id = ? AND user_id = ?').run(op.entityId, userId);
        this.db.prepare('DELETE FROM subtasks WHERE item_id = ? AND user_id = ?').run(op.entityId, userId);
        this.db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').run(op.entityId, userId);
        this.recordChange(userId, 'item', op.entityId, 'delete', null);
        return 'deleted';
      }
      case 'subtask.create': {
        const itemId = String(d.itemId ?? '');
        if (!this.rawItem(userId, itemId)) return 'missing';
        const exists = this.db
          .prepare('SELECT id FROM subtasks WHERE id = ?')
          .get(op.entityId);
        if (exists) return 'exists';
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO subtasks (id, item_id, user_id, title, position, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            op.entityId,
            itemId,
            userId,
            String(d.title ?? ''),
            Number(d.position ?? 0),
            d.origin === 'ai' ? 'ai' : 'user',
            op.ts || now,
            op.ts || now,
          );
        this.emitItem(userId, itemId);
        return 'created';
      }
      case 'subtask.update':
      case 'subtask.complete':
      case 'subtask.delete': {
        const st = this.db
          .prepare('SELECT * FROM subtasks WHERE id = ? AND user_id = ?')
          .get(op.entityId, userId) as Record<string, unknown> | undefined;
        if (!st) return 'missing';
        const itemId = String(st.item_id);
        if (op.kind === 'subtask.delete') {
          this.db.prepare('DELETE FROM subtasks WHERE id = ?').run(op.entityId);
        } else if (op.kind === 'subtask.complete') {
          this.db
            .prepare('UPDATE subtasks SET completed_at = ?, updated_at = ? WHERE id = ?')
            .run(op.ts || Date.now(), Date.now(), op.entityId);
        } else {
          this.db
            .prepare('UPDATE subtasks SET title = ?, position = ?, updated_at = ? WHERE id = ?')
            .run(
              String(d.title ?? st.title),
              Number(d.position ?? st.position),
              Date.now(),
              op.entityId,
            );
        }
        this.emitItem(userId, itemId);
        return op.kind === 'subtask.delete' ? 'deleted' : 'updated';
      }
      default:
        return 'error:unknown-kind';
    }
  }

  /** Server-originated item mutation (AI enrichment, scheduling) — same change path. */
  serverUpdateItem(userId: string, itemId: string, fields: Record<string, unknown>): void {
    this.applyOps(userId, [
      {
        opId: randomUUID(),
        ts: Date.now(),
        kind: 'item.update',
        entityId: itemId,
        // origin: 'server' excludes our own guesses from teaching the context engine
        // (see the item.update/item.retype case above) — only user edits ever teach it.
        data: { ...fields, origin: 'server' },
      },
    ]);
  }

  audit(
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown>,
    reversible = false,
  ): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, detail, reversible, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        userId,
        action,
        entityType,
        entityId,
        JSON.stringify(detail),
        reversible ? 1 : 0,
        Date.now(),
      );
  }

  private rawItem(userId: string, id: string): Record<string, unknown> | undefined {
    return this.db
      .prepare('SELECT * FROM items WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
  }

  private emitItem(userId: string, itemId: string): void {
    const item = this.itemById(userId, itemId);
    if (!item) return;
    item.subtasks = this.subtasksFor(userId, itemId);
    this.recordChange(userId, 'item', itemId, 'upsert', item);
  }
}

export function rowToItem(r: Record<string, unknown>): Item {
  return {
    id: String(r.id),
    type: r.type as Item['type'],
    source: r.source as Item['source'],
    rawText: String(r.raw_text),
    title: String(r.title),
    confidence: r.confidence == null ? null : Number(r.confidence),
    status: r.status as Item['status'],
    contextTag: r.context_tag == null ? null : String(r.context_tag),
    appTrigger: r.app_trigger == null ? null : String(r.app_trigger),
    timeIntent: r.time_intent ? JSON.parse(String(r.time_intent)) : null,
    summary: r.summary == null ? null : String(r.summary),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
  };
}

export function rowToSubtask(r: Record<string, unknown>): Subtask {
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    title: String(r.title),
    position: Number(r.position),
    origin: r.origin as Subtask['origin'],
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
