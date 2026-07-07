/**
 * Personalization (build plan §9): chat import → structured profile, transparency
 * API, manual-edit precedence, behavioral refinement, and total deletion.
 *
 * Privacy invariants (§4): the raw export is processed in memory and never written
 * to disk or logs (retention = 0 in this deployment; the import job records only
 * counts). The stored profile is small, structured, human-readable — no text from
 * which conversations could be reconstructed.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import type { SyncEngine } from '../modules/sync.js';
import type { Orchestrator } from '../ai/orchestrator.js';
import type { ProfileAttributes } from '../ai/contracts.js';
import { parseImport, type ImportSource } from '../imports/parsers.js';
import { hasConsent } from './consent.js';

interface StoredProfile {
  attributes: ProfileAttributes;
  /** Manual edits — always win over derived values (plan §9.4). */
  overrides: Partial<ProfileAttributes>;
}

export function loadEffectiveProfile(db: Db, userId: string): ProfileAttributes | null {
  const row = db.prepare('SELECT attributes FROM profiles WHERE user_id = ?').get(userId) as
    | { attributes: string }
    | undefined;
  if (!row) return null;
  const stored = JSON.parse(row.attributes) as StoredProfile | ProfileAttributes;
  if ('attributes' in stored && typeof stored.attributes === 'object') {
    const s = stored as StoredProfile;
    return { ...s.attributes, ...s.overrides };
  }
  return stored as ProfileAttributes;
}

export function behavioralSignals(db: Db, userId: string) {
  const corrections = db
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE user_id = ? AND action = 'classification.corrected'")
    .get(userId) as { c: number };
  const classified = db
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE user_id = ? AND action = 'item.classified'")
    .get(userId) as { c: number };
  const completions = db
    .prepare('SELECT completed_at FROM items WHERE user_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 100')
    .all(userId) as Array<{ completed_at: number }>;
  return {
    correctionRate: classified.c > 0 ? corrections.c / classified.c : 0,
    completionHours: completions.map((r) => new Date(Number(r.completed_at)).getHours()),
  };
}

export function registerProfile(
  app: FastifyInstance,
  db: Db,
  sync: SyncEngine,
  orchestrator: Orchestrator,
): void {
  const saveProfile = (userId: string, profile: StoredProfile, sources: string[], storage: string) => {
    const existing = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(userId);
    if (existing) {
      db.prepare('UPDATE profiles SET attributes = ?, sources = ?, storage = ?, updated_at = ? WHERE user_id = ?').run(
        JSON.stringify(profile),
        JSON.stringify(sources),
        storage,
        Date.now(),
        userId,
      );
    } else {
      db.prepare('INSERT INTO profiles (user_id, attributes, sources, storage, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        userId,
        JSON.stringify(profile),
        JSON.stringify(sources),
        storage,
        Date.now(),
      );
    }
  };

  const loadStored = (userId: string): { profile: StoredProfile; sources: string[]; storage: string } | null => {
    const row = db.prepare('SELECT attributes, sources, storage FROM profiles WHERE user_id = ?').get(userId) as
      | { attributes: string; sources: string; storage: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.attributes) as StoredProfile | ProfileAttributes;
    const profile: StoredProfile =
      'attributes' in parsed && typeof parsed.attributes === 'object'
        ? (parsed as StoredProfile)
        : { attributes: parsed as ProfileAttributes, overrides: {} };
    return { profile, sources: JSON.parse(row.sources ?? '[]'), storage: row.storage };
  };

  /**
   * Server-side import processing. The raw export lives only in this request's
   * memory: parsed → profile derived → discarded. The job row stores counts only.
   */
  app.post('/v1/imports', { preHandler: app.authenticate }, async (req, reply) => {
    if (!hasConsent(db, req.userId, 'chat_import')) {
      return reply.code(403).send({ error: 'chat_import consent required' });
    }
    const { source, content } = (req.body ?? {}) as { source?: ImportSource; content?: string };
    if (!source || !['claude', 'chatgpt', 'gemini', 'generic'].includes(source)) {
      return reply.code(400).send({ error: 'source must be claude|chatgpt|gemini|generic' });
    }
    if (!content || content.length > 50_000_000) {
      return reply.code(400).send({ error: 'content required (max 50MB)' });
    }

    let parsed;
    try {
      parsed = parseImport(source, content);
    } catch {
      return reply.code(400).send({ error: `could not parse ${source} export format` });
    }
    if (parsed.userMessages.length === 0) {
      return reply.code(400).send({ error: 'no user messages found in the export' });
    }

    const jobId = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO import_jobs (id, user_id, source, consent_id, state, retention_deadline, raw_ref, deleted_at, created_at)
       VALUES (?, ?, ?, 'current', 'processing', ?, NULL, NULL, ?)`,
    ).run(jobId, req.userId, source, now, now);

    try {
      const derived = await orchestrator.run('deriveProfile', {
        userMessages: parsed.userMessages,
        behavioralSignals: behavioralSignals(db, req.userId),
      });
      const existing = loadStored(req.userId);
      const profile: StoredProfile = {
        attributes: derived.attributes,
        overrides: existing?.profile.overrides ?? {},
      };
      const sources = [...new Set([...(existing?.sources ?? []), `${source}@${new Date(now).toISOString().slice(0, 10)}`])];
      saveProfile(req.userId, profile, sources, existing?.storage ?? 'server');
      // Raw content is now out of scope — record deletion in the job (retention 0).
      db.prepare("UPDATE import_jobs SET state = 'done', deleted_at = ?, raw_ref = NULL WHERE id = ?").run(Date.now(), jobId);
      sync.audit(req.userId, 'import.processed', 'import_job', jobId, {
        source,
        conversations: parsed.conversationCount,
        messages: parsed.userMessages.length,
      });
      sync.recordChange(req.userId, 'profile', req.userId, 'upsert', { ...profile.attributes, ...profile.overrides });
      return reply.code(201).send({
        jobId,
        profile: { ...profile.attributes, ...profile.overrides },
        rawRetention:
          'Your export was processed in memory and has already been discarded — only the structured profile below was stored.',
      });
    } catch (err) {
      db.prepare("UPDATE import_jobs SET state = 'failed', deleted_at = ? WHERE id = ?").run(Date.now(), jobId);
      return reply.code(500).send({ error: 'profile derivation failed; the export was not retained' });
    }
  });

  app.get('/v1/imports', { preHandler: app.authenticate }, async (req) => {
    const rows = db
      .prepare('SELECT id, source, state, deleted_at, created_at FROM import_jobs WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.userId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      state: r.state,
      rawDeletedAt: r.deleted_at,
      createdAt: r.created_at,
    }));
  });

  /** Transparency: the profile in plain, structured form. */
  app.get('/v1/profile', { preHandler: app.authenticate }, async (req, reply) => {
    const stored = loadStored(req.userId);
    if (!stored) return reply.code(404).send({ error: 'no profile yet' });
    return {
      attributes: { ...stored.profile.attributes, ...stored.profile.overrides },
      derived: stored.profile.attributes,
      overrides: stored.profile.overrides,
      sources: stored.sources,
      storage: stored.storage,
    };
  });

  /** Per-attribute manual edit — always wins over derived values. */
  app.patch('/v1/profile', { preHandler: app.authenticate }, async (req) => {
    const edits = (req.body ?? {}) as Partial<ProfileAttributes>;
    const existing = loadStored(req.userId) ?? {
      profile: { attributes: {}, overrides: {} } as StoredProfile,
      sources: ['manual'],
      storage: 'server',
    };
    const allowed: Array<keyof ProfileAttributes> = ['tone', 'verbosity', 'decompositionGranularity', 'schedulingRhythm', 'vocabulary'];
    for (const key of allowed) {
      if (key in edits) {
        (existing.profile.overrides as Record<string, unknown>)[key] = (edits as Record<string, unknown>)[key];
      }
    }
    saveProfile(req.userId, existing.profile, existing.sources, existing.storage);
    sync.recordChange(req.userId, 'profile', req.userId, 'upsert', {
      ...existing.profile.attributes,
      ...existing.profile.overrides,
    });
    return { attributes: { ...existing.profile.attributes, ...existing.profile.overrides } };
  });

  /** On-device processing path: the client derived locally; raw never left the device. */
  app.put('/v1/profile', { preHandler: app.authenticate }, async (req, reply) => {
    if (!hasConsent(db, req.userId, 'chat_import')) {
      return reply.code(403).send({ error: 'chat_import consent required' });
    }
    const { attributes } = (req.body ?? {}) as { attributes?: ProfileAttributes };
    if (!attributes || typeof attributes !== 'object') {
      return reply.code(400).send({ error: 'attributes required' });
    }
    const existing = loadStored(req.userId);
    saveProfile(
      req.userId,
      { attributes, overrides: existing?.profile.overrides ?? {} },
      [...new Set([...(existing?.sources ?? []), 'on-device'])],
      'on-device-only',
    );
    return { ok: true };
  });

  /** Total deletion (§4): profile + import artifacts + processing audit rows, verified. */
  app.delete('/v1/profile', { preHandler: app.authenticate }, async (req) => {
    const counts = {
      profiles: Number(runDelete(db, 'DELETE FROM profiles WHERE user_id = ?', req.userId)),
      import_jobs: Number(runDelete(db, 'DELETE FROM import_jobs WHERE user_id = ?', req.userId)),
      audit_rows: Number(
        runDelete(db, "DELETE FROM audit_log WHERE user_id = ? AND action LIKE 'import.%'", req.userId),
      ),
    };
    sync.recordChange(req.userId, 'profile', req.userId, 'delete', null);
    return {
      deleted: true,
      confirmation:
        'Your profile, all import records, and import processing logs are deleted from live systems. Backup copies expire within 30 days. Scrible is back to its defaults.',
      counts,
    };
  });

  /** Continuous lightweight personalization: refresh rhythm hints from in-app signals. */
  app.post('/v1/profile/refresh', { preHandler: app.authenticate }, async (req, reply) => {
    if (!hasConsent(db, req.userId, 'chat_import')) {
      return reply.code(403).send({ error: 'chat_import consent required' });
    }
    const existing = loadStored(req.userId);
    const derived = await orchestrator.run('deriveProfile', {
      userMessages: [],
      behavioralSignals: behavioralSignals(db, req.userId),
    });
    const attributes = { ...(existing?.profile.attributes ?? {}), schedulingRhythm: derived.attributes.schedulingRhythm };
    saveProfile(
      req.userId,
      { attributes, overrides: existing?.profile.overrides ?? {} },
      existing?.sources ?? ['behavioral'],
      existing?.storage ?? 'server',
    );
    return { attributes: { ...attributes, ...(existing?.profile.overrides ?? {}) } };
  });
}

function runDelete(db: Db, sql: string, ...params: string[]): number | bigint {
  return db.prepare(sql).run(...params).changes;
}
