/**
 * Account deletion — end-to-end from day one (build plan §5.5) — and the audit feed
 * powering "what happened and why" UI.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../lib/db.js';
import { deleteAllUserData } from '../lib/db.js';

export function registerAccount(app: FastifyInstance, db: Db): void {
  app.delete('/v1/me', { preHandler: app.authenticate }, async (req) => {
    const counts = deleteAllUserData(db, req.userId);
    return {
      deleted: true,
      // User-visible confirmation of total deletion (plan §4): live stores now,
      // backups within the documented 30-day expiry window.
      confirmation:
        'Your account and all associated data have been deleted from live systems. Backup copies expire within 30 days.',
      counts,
    };
  });

  app.get('/v1/audit', { preHandler: app.authenticate }, async (req) => {
    const rows = db
      .prepare(
        'SELECT id, action, entity_type, entity_id, detail, reversible, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
      )
      .all(req.userId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      detail: JSON.parse(String(r.detail)),
      reversible: Number(r.reversible) === 1,
      at: r.created_at,
    }));
  });
}
