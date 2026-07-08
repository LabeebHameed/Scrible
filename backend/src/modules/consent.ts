/**
 * Consent architecture (build plan §4, §5.5): per-category, versioned, revocable.
 * Revoking a category triggers its data-handling hook automatically.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import { CONSENT_CATEGORIES, type ConsentCategory } from '../types.js';

export type RevocationHook = (db: Db, userId: string) => Record<string, number>;

/** category → what gets deleted when consent is revoked (docs/data-classification.md). */
export const revocationHooks: Record<ConsentCategory, RevocationHook> = {
  voice_processing: () => ({}),
  voice_retention: () => ({}), // stored audio purge — object storage wired in Phase 1
  calendar_access: (db, userId) => ({
    calendar_links: Number(db.prepare('DELETE FROM calendar_links WHERE user_id = ?').run(userId).changes),
  }),
  chat_import: (db, userId) => ({
    profiles: Number(db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId).changes),
    import_jobs: Number(db.prepare('DELETE FROM import_jobs WHERE user_id = ?').run(userId).changes),
    learned_signals: Number(db.prepare('DELETE FROM learned_signals WHERE user_id = ?').run(userId).changes),
  }),
  // Revoking analytics erases the pseudonymous-id mapping: emission stops (the
  // forwarding layer's consent gate) AND past events are permanently unlinked.
  analytics: (db, userId) => ({
    analytics_ids: Number(db.prepare('DELETE FROM analytics_ids WHERE user_id = ?').run(userId).changes),
  }),
  // App names are read and matched ON the desktop device and never uploaded —
  // there is nothing server-side to purge; the desktop app stops its watcher.
  app_watcher: () => ({}),
};

export function currentConsents(db: Db, userId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const category of CONSENT_CATEGORIES) {
    const row = db
      .prepare(
        'SELECT granted, policy_version, created_at FROM consents WHERE user_id = ? AND category = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(userId, category) as Record<string, unknown> | undefined;
    out[category] = row
      ? { granted: Number(row.granted) === 1, policyVersion: row.policy_version, at: row.created_at }
      : { granted: false, policyVersion: null, at: null };
  }
  return out;
}

export function hasConsent(db: Db, userId: string, category: ConsentCategory): boolean {
  const row = db
    .prepare(
      'SELECT granted FROM consents WHERE user_id = ? AND category = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(userId, category) as { granted: number } | undefined;
  return row ? row.granted === 1 : false;
}

export function registerConsent(app: FastifyInstance, db: Db): void {
  app.get('/v1/consents', { preHandler: app.authenticate }, async (req) =>
    currentConsents(db, req.userId),
  );

  app.post('/v1/consents', { preHandler: app.authenticate }, async (req, reply) => {
    const { category, policyVersion } = (req.body ?? {}) as {
      category?: string;
      policyVersion?: string;
    };
    if (!CONSENT_CATEGORIES.includes(category as ConsentCategory)) {
      return reply.code(400).send({ error: 'unknown consent category' });
    }
    if (!policyVersion) return reply.code(400).send({ error: 'policyVersion required' });
    db.prepare(
      'INSERT INTO consents (id, user_id, category, policy_version, granted, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ).run(randomUUID(), req.userId, category!, policyVersion, Date.now());
    return reply.code(201).send({ ok: true });
  });

  app.post('/v1/consents/:category/revoke', { preHandler: app.authenticate }, async (req, reply) => {
    const { category } = req.params as { category: string };
    if (!CONSENT_CATEGORIES.includes(category as ConsentCategory)) {
      return reply.code(400).send({ error: 'unknown consent category' });
    }
    const last = db
      .prepare(
        'SELECT policy_version FROM consents WHERE user_id = ? AND category = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(req.userId, category) as { policy_version: string } | undefined;
    db.prepare(
      'INSERT INTO consents (id, user_id, category, policy_version, granted, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(randomUUID(), req.userId, category, last?.policy_version ?? 'unversioned', Date.now());
    const purged = revocationHooks[category as ConsentCategory](db, req.userId);
    return { ok: true, purged };
  });
}
