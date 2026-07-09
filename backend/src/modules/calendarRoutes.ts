/**
 * Calendar & scheduling API: links (incl. OAuth flows), availability, schedule
 * blocks with move/undo, activity feed, reminder snooze, provider webhooks.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import type { CalendarService } from '../calendar/service.js';
import type { ReminderScheduler } from '../notifications/index.js';
import { hasConsent } from './consent.js';

const OAUTH_CONFIG = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  outlook: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access Calendars.ReadWrite',
    clientId: () => process.env.MS_CLIENT_ID,
    clientSecret: () => process.env.MS_CLIENT_SECRET,
  },
} as const;

export function registerCalendarRoutes(
  app: FastifyInstance,
  db: Db,
  calendar: CalendarService,
  reminders: ReminderScheduler,
): void {
  const requireCalendarConsent = (userId: string): Promise<boolean> => hasConsent(db, userId, 'calendar_access');

  app.get('/v1/calendar/links', { preHandler: app.authenticate }, async (req) =>
    (await calendar.links(req.userId)).map((l) => ({ id: l.id, provider: l.provider, accountId: l.accountId })),
  );

  /** Direct link creation: internal calendar, or pre-obtained provider tokens. */
  app.post('/v1/calendar/links', { preHandler: app.authenticate }, async (req, reply) => {
    if (!(await requireCalendarConsent(req.userId))) {
      return reply.code(403).send({ error: 'calendar_access consent required' });
    }
    const { provider, accountId, tokens } = (req.body ?? {}) as {
      provider?: string;
      accountId?: string;
      tokens?: unknown;
    };
    if (!provider || !['internal', 'google', 'outlook', 'apple'].includes(provider)) {
      return reply.code(400).send({ error: 'provider must be internal|google|outlook|apple' });
    }
    const id = await calendar.createLink(
      req.userId,
      provider,
      accountId ?? 'primary',
      JSON.stringify(tokens ?? {}),
    );
    return reply.code(201).send({ id });
  });

  app.delete('/v1/calendar/links/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    await calendar.removeLink(req.userId, id);
    return { ok: true };
  });

  /** OAuth start: returns the provider consent URL for the client to open. */
  app.get('/v1/calendar/oauth/:provider/start', { preHandler: app.authenticate }, async (req, reply) => {
    const { provider } = req.params as { provider: 'google' | 'outlook' };
    const cfg = OAUTH_CONFIG[provider];
    if (!cfg) return reply.code(400).send({ error: 'unknown provider' });
    if (!cfg.clientId()) {
      return reply.code(501).send({
        error: `${provider} OAuth is not configured on this server (set ${provider === 'google' ? 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET' : 'MS_CLIENT_ID/MS_CLIENT_SECRET'})`,
      });
    }
    if (!(await requireCalendarConsent(req.userId))) {
      return reply.code(403).send({ error: 'calendar_access consent required' });
    }
    const { redirectUri } = req.query as { redirectUri?: string };
    const state = randomUUID();
    await db.prepare(
      'INSERT INTO processed_ops (op_id, user_id, result, created_at) VALUES (?, ?, ?, ?)',
    ).run(`oauth:${state}`, req.userId, JSON.stringify({ provider, redirectUri }), Date.now());
    const url = new URL(cfg.authUrl);
    url.searchParams.set('client_id', cfg.clientId()!);
    url.searchParams.set('redirect_uri', redirectUri ?? '');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return { url: url.toString(), state };
  });

  /** OAuth completion: client posts the code back; server exchanges + stores tokens. */
  app.post('/v1/calendar/oauth/:provider/complete', { preHandler: app.authenticate }, async (req, reply) => {
    const { provider } = req.params as { provider: 'google' | 'outlook' };
    const cfg = OAUTH_CONFIG[provider];
    if (!cfg?.clientId()) return reply.code(501).send({ error: 'provider not configured' });
    const { code, state, redirectUri } = (req.body ?? {}) as Record<string, string>;
    const pending = (await db
      .prepare('SELECT user_id FROM processed_ops WHERE op_id = ?')
      .get(`oauth:${state}`)) as { user_id: string } | undefined;
    if (!pending || pending.user_id !== req.userId) {
      return reply.code(400).send({ error: 'invalid oauth state' });
    }
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId()!,
        client_secret: cfg.clientSecret() ?? '',
        code: code ?? '',
        grant_type: 'authorization_code',
        redirect_uri: redirectUri ?? '',
      }),
    });
    if (!res.ok) return reply.code(502).send({ error: `token exchange failed (${res.status})` });
    const tokens = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const id = await calendar.createLink(
      req.userId,
      provider,
      'primary',
      JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      }),
    );
    void calendar.syncUser(req.userId).catch(() => {});
    return reply.code(201).send({ id });
  });

  /** Provider webhook — triggers an immediate sync for the affected user. */
  app.post('/v1/calendar/webhook/:provider', async (req, reply) => {
    // Google sends channel headers; Graph sends validationToken on subscribe.
    const { validationToken } = req.query as { validationToken?: string };
    if (validationToken) return reply.code(200).header('content-type', 'text/plain').send(validationToken);
    const linkId =
      (req.headers['x-goog-channel-token'] as string | undefined) ??
      ((req.body ?? {}) as { value?: Array<{ clientState?: string }> }).value?.[0]?.clientState;
    if (linkId) {
      const row = (await db.prepare('SELECT user_id FROM calendar_links WHERE id = ?').get(linkId)) as
        | { user_id: string }
        | undefined;
      if (row) void calendar.syncUser(row.user_id).catch(() => {});
    }
    return reply.code(202).send({});
  });

  app.post('/v1/calendar/sync', { preHandler: app.authenticate }, async (req) => {
    await calendar.syncUser(req.userId);
    return { ok: true };
  });

  app.get('/v1/availability', { preHandler: app.authenticate }, async (req) => {
    const { from, to } = req.query as { from?: string; to?: string };
    const start = Number(from ?? Date.now());
    const end = Number(to ?? Date.now() + 7 * 24 * 3600_000);
    return { slots: await calendar.freeSlots(req.userId, start, end) };
  });

  app.get('/v1/schedule', { preHandler: app.authenticate }, async (req) => {
    const rows = (await db
      .prepare(
        "SELECT * FROM schedule_blocks WHERE user_id = ? AND state != 'released' ORDER BY start_ts LIMIT 200",
      )
      .all(req.userId)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      start: r.start_ts,
      end: r.end_ts,
      state: r.state,
      rationale: r.rationale,
      external: Boolean(r.external_event_id),
    }));
  });

  app.post('/v1/schedule/:id/move', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { start, end } = (req.body ?? {}) as { start?: number; end?: number };
    if (!start || !end || end <= start) return reply.code(400).send({ error: 'start/end required' });
    await calendar.moveBlock(req.userId, id, start, end, { reason: 'you moved it' });
    return { ok: true };
  });

  app.post('/v1/schedule/:id/undo', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await calendar.undoBlock(req.userId, id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  app.get('/v1/activity', { preHandler: app.authenticate }, async (req) => {
    const rows = (await db
      .prepare('SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(req.userId)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      message: r.message,
      kind: r.kind,
      itemId: r.item_id,
      blockId: r.block_id,
      undoable: Number(r.undoable) === 1,
      createdAt: r.created_at,
    }));
  });

  app.get('/v1/reminders', { preHandler: app.authenticate }, async (req) => {
    const rows = (await db
      .prepare('SELECT * FROM reminder_triggers WHERE user_id = ? ORDER BY fire_at LIMIT 100')
      .all(req.userId)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      fireAt: r.fire_at,
      recurrence: r.recurrence,
      snoozedUntil: r.snoozed_until,
      deliveredAt: r.delivered_at,
    }));
  });

  app.post('/v1/reminders/:id/snooze', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { minutes } = (req.body ?? {}) as { minutes?: number };
    const ok = await reminders.snooze(req.userId, id, Math.max(1, Math.min(minutes ?? 30, 24 * 60)));
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });
}
