/**
 * Client event ingestion + GDPR/CCPA data export (build plan §10.2–10.3).
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../lib/db.js';
import type { AnalyticsForwarder } from '../analytics/forwarder.js';
import { TAXONOMY_VERSION } from '../analytics/taxonomy.js';
import { rowToItem, rowToSubtask } from './sync.js';
import { currentConsents } from './consent.js';

export function registerAnalyticsRoutes(app: FastifyInstance, db: Db, forwarder: AnalyticsForwarder): void {
  /**
   * Batch event ingestion. Always 202: consent-off and invalid events are dropped,
   * never an error the client must handle — analytics can never break the product.
   */
  app.post('/v1/analytics/events', { preHandler: app.authenticate }, async (req, reply) => {
    const { events } = (req.body ?? {}) as { events?: Array<{ name?: string; props?: Record<string, unknown> }> };
    const results = { stored: 0, dropped: 0 };
    for (const event of (events ?? []).slice(0, 100)) {
      if (!event?.name) {
        results.dropped++;
        continue;
      }
      const status = forwarder.track(req.userId, event.name, event.props ?? {});
      if (status === 'stored') results.stored++;
      else results.dropped++;
    }
    return reply.code(202).send({ ...results, schemaVersion: TAXONOMY_VERSION });
  });

  /** Data-subject access right: everything Scrible holds about the user, as JSON. */
  app.get('/v1/me/export', { preHandler: app.authenticate }, async (req) => {
    const userId = req.userId;
    const all = (table: string) =>
      db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId) as Array<Record<string, unknown>>;

    const user = db
      .prepare('SELECT id, email, timezone, working_hours, notification_prefs, created_at FROM users WHERE id = ?')
      .get(userId) as Record<string, unknown>;
    const items = all('items').map(rowToItem);
    const subtasks = all('subtasks').map(rowToSubtask);
    const profileRow = db.prepare('SELECT attributes, sources, storage, updated_at FROM profiles WHERE user_id = ?').get(userId) as
      | Record<string, unknown>
      | undefined;
    const pseudo = db.prepare('SELECT pseudo_id FROM analytics_ids WHERE user_id = ?').get(userId) as
      | { pseudo_id: string }
      | undefined;

    return {
      exportedAt: new Date().toISOString(),
      format: 'scrible-export.v1',
      account: {
        ...user,
        working_hours: JSON.parse(String(user.working_hours ?? '{}')),
        notification_prefs: JSON.parse(String(user.notification_prefs ?? '{}')),
      },
      consents: currentConsents(db, userId),
      items,
      subtasks,
      scheduleBlocks: all('schedule_blocks'),
      reminders: all('reminder_triggers'),
      calendarLinks: all('calendar_links').map((l) => ({
        id: l.id,
        provider: l.provider,
        accountId: l.account_id,
        // OAuth token material is a credential, not user content — never exported.
      })),
      devices: all('devices').map((d) => ({ id: d.id, platform: d.platform, lastSeen: d.last_seen })),
      activity: all('activity'),
      profile: profileRow
        ? { attributes: JSON.parse(String(profileRow.attributes)), sources: JSON.parse(String(profileRow.sources ?? '[]')), storage: profileRow.storage }
        : null,
      importJobs: all('import_jobs').map((j) => ({ id: j.id, source: j.source, state: j.state, rawDeletedAt: j.deleted_at, createdAt: j.created_at })),
      analytics: pseudo
        ? {
            pseudonymousId: pseudo.pseudo_id,
            events: db
              .prepare('SELECT event, props, schema_version, ts FROM analytics_events WHERE pseudo_id = ? ORDER BY ts')
              .all(pseudo.pseudo_id),
          }
        : null,
      auditLog: all('audit_log'),
    };
  });
}
