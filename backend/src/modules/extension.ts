/**
 * Cross-device delivery module (build plan §8): decides where computer-action items
 * surface. Routing rule v1:
 *   - untimed computer-action tasks → extension popup on next browser activity
 *   - explicit-time reminders → push path (Phase 2), regardless of context
 * One owner for cross-surface dedup: the extension pulls on trigger (MV3-friendly),
 * completions flow back through the normal op path and withdraw the popup everywhere.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../lib/db.js';
import { rowToItem, type SyncEngine } from './sync.js';

export function registerExtension(app: FastifyInstance, db: Db, sync: SyncEngine): void {
  /**
   * Check-in: called by the extension on browser startup / first-activity-after-idle.
   * Returns pending computer-action items and updates the device's last-seen.
   */
  app.post('/v1/extension/checkin', { preHandler: app.authenticate }, async (req) => {
    const { deviceId } = (req.body ?? {}) as { deviceId?: string };
    if (deviceId) {
      db.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND user_id = ?').run(
        Date.now(),
        deviceId,
        req.userId,
      );
    }
    const rows = db
      .prepare(
        `SELECT * FROM items WHERE user_id = ? AND context_tag = 'computer-action'
         AND status IN ('captured','processing','active','scheduled')
         ORDER BY created_at LIMIT 20`,
      )
      .all(req.userId) as Array<Record<string, unknown>>;
    const items = rows.map(rowToItem);
    // Delivery is audit-logged so "what surfaced where" is always answerable.
    for (const item of items) {
      sync.audit(req.userId, 'popup.pending', 'item', item.id, { deviceId: deviceId ?? null });
    }
    return { items };
  });

  /** The popup records what it actually surfaced (frequency-capping signal). */
  app.post('/v1/extension/shown', { preHandler: app.authenticate }, async (req) => {
    const { itemIds } = (req.body ?? {}) as { itemIds?: string[] };
    for (const id of itemIds ?? []) {
      sync.audit(req.userId, 'popup.shown', 'item', String(id), {});
    }
    return { ok: true };
  });
}
