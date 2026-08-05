import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { enableEnrichment } from './enrichment.js';
import { openDb, type Db } from './lib/db.js';
import { encrypt } from './lib/crypto.js';
import { loadConfig, type Config } from './config.js';
import { registerAuth } from './modules/auth.js';
import { registerConsent } from './modules/consent.js';
import { registerDevices } from './modules/devices.js';
import { registerItems } from './modules/items.js';
import { registerSyncRoutes } from './modules/syncRoutes.js';
import { registerAccount } from './modules/account.js';
import { registerVoice } from './modules/voice.js';
import { registerSpeechRoutes } from './modules/speechRoutes.js';
import { registerCalendarRoutes } from './modules/calendarRoutes.js';
import { registerExtension } from './modules/extension.js';
import { registerProfile } from './modules/profile.js';
import { registerAnalyticsRoutes } from './modules/analyticsRoutes.js';
import { registerAiMetrics } from './modules/aiMetrics.js';
import { AmplitudeSink, AnalyticsForwarder, type ProviderSink } from './analytics/forwarder.js';
import { SyncEngine } from './modules/sync.js';
import { buildOrchestrator } from './ai/index.js';
import type { Orchestrator } from './ai/orchestrator.js';
import { JobQueue } from './lib/jobs.js';
import { ProviderRegistry } from './calendar/provider.js';
import { InternalCalendarProvider } from './calendar/internal.js';
import { GoogleCalendarProvider } from './calendar/google.js';
import { OutlookCalendarProvider } from './calendar/outlook.js';
import { CalendarService } from './calendar/service.js';
import { NotificationDispatcher, OutboxSender, ReminderScheduler } from './notifications/index.js';
import { ExpoPushSender } from './notifications/expoPush.js';

export interface AppContext {
  app: FastifyInstance;
  db: Db;
  sync: SyncEngine;
  orchestrator: Orchestrator;
  jobs: JobQueue;
  config: Config;
  calendar: CalendarService;
  reminders: ReminderScheduler;
  dispatcher: NotificationDispatcher;
  internalCalendar: InternalCalendarProvider;
  analytics: AnalyticsForwarder;
}

export async function buildApp(overrides?: Partial<Config>): Promise<AppContext> {
  const config = { ...loadConfig(), ...overrides };
  const db = await openDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  const sync = new SyncEngine(db);
  const orchestrator = buildOrchestrator(config, db);
  const jobs = new JobQueue();

  // Calendar providers (build plan §7.1). Google/Outlook re-encrypt refreshed tokens.
  const registry = new ProviderRegistry();
  const internalCalendar = new InternalCalendarProvider(db);
  await internalCalendar.init();
  // Fire-and-forget from onTokensRefreshed (?.() is never awaited by callers) —
  // swallow failures internally, matching the "retried by sweep" pattern elsewhere.
  const persistTokens = async (linkId: string, tokens: string) => {
    try {
      await db.prepare('UPDATE calendar_links SET token_ref = ? WHERE id = ?').run(encrypt(tokens), linkId);
    } catch {
      /* best-effort; the next refresh will retry */
    }
  };
  const google = new GoogleCalendarProvider();
  google.onTokensRefreshed = persistTokens;
  const outlook = new OutlookCalendarProvider();
  outlook.onTokensRefreshed = persistTokens;
  registry.register(internalCalendar);
  registry.register(google);
  registry.register(outlook);

  const calendar = new CalendarService(db, sync, orchestrator, registry);
  const dispatcher = new NotificationDispatcher(db, [new OutboxSender(db), new ExpoPushSender()]);
  const reminders = new ReminderScheduler(db, sync, dispatcher, orchestrator);

  // Analytics forwarding layer (plan §10.1): consent-gated, taxonomy-enforced,
  // pseudonymous. Provider sink only when configured; local store is the buffer.
  const sinks: ProviderSink[] = [];
  if (process.env.AMPLITUDE_API_KEY) sinks.push(new AmplitudeSink(process.env.AMPLITUDE_API_KEY));
  const analytics = new AnalyticsForwarder(db, sinks);

  const ctx: AppContext = {
    app,
    db,
    sync,
    orchestrator,
    jobs,
    config,
    calendar,
    reminders,
    dispatcher,
    internalCalendar,
    analytics,
  };

  enableEnrichment(ctx);

  // Scheduling path (plan §2.3): after an item is enriched, reminders get triggers
  // and ideas get calendar blocks — async, confirmed in plain language, undoable.
  ctx.afterEnrichment = (userId, itemId) => {
    jobs.enqueue(async () => {
      const item = await sync.itemById(userId, itemId);
      if (!item) return;
      await analytics.track(userId, 'item.created', { type: item.type, source: item.source, surface: 'web' });
      if (item.type === 'reminder' && item.timeIntent?.at) {
        await reminders.ensureTrigger(userId, itemId, item.timeIntent.at, item.timeIntent.recurrence);
        const confirm = await orchestrator.run('confirm', {
          event: 'reminder_set',
          itemTitle: item.title,
          itemType: item.type,
          detail: { when: new Date(item.timeIntent.at).toLocaleString() },
        });
        await calendar.recordActivity(userId, confirm.message, 'reminder_set', { itemId, undoable: false });
      } else if (item.type === 'idea' && config.flags.autoSchedule) {
        await calendar.autoSchedule(userId, itemId);
      }
    });
  };

  // Raw audio parser for STT routes
  app.addContentTypeParser(
    ['audio/m4a', 'audio/webm', 'audio/wav', 'audio/ogg', 'audio/mp3', 'application/octet-stream', 'audio/*'],
    { parseAs: 'buffer' },
    (_req, payload, done) => {
      done(null, payload);
    }
  );

  // Permissive CORS for the web dashboard / extension surfaces (token auth, no cookies).
  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', '*');
    reply.header('access-control-allow-methods', '*');
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });
  app.get('/v1/health', async () => ({ ok: true, version: '0.1.0' }));

  app.get('/test', async (_req, reply) => {
    try {
      const htmlPath = new URL('../../tester.html', import.meta.url);
      const html = await fs.promises.readFile(htmlPath, 'utf8');
      reply.type('text/html').send(html);
    } catch {
      reply.code(404).send('Tester page not found');
    }
  });

  registerAuth(app, db, config.jwtSecret);
  registerConsent(app, db);
  registerDevices(app, db);
  registerItems(app, db, sync);
  registerSyncRoutes(app, sync);
  registerAccount(app, db);
  registerVoice(app, db, sync, orchestrator);
  registerSpeechRoutes(app);
  registerCalendarRoutes(app, db, calendar, reminders);
  registerExtension(app, db, sync);
  registerProfile(app, db, sync, orchestrator);
  registerAnalyticsRoutes(app, db, analytics);
  registerAiMetrics(app, orchestrator);

  return ctx;
}
