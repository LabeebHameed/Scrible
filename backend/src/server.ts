import Fastify, { type FastifyInstance } from 'fastify';
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
import { registerCalendarRoutes } from './modules/calendarRoutes.js';
import { registerExtension } from './modules/extension.js';
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
}

export function buildApp(overrides?: Partial<Config>): AppContext {
  const config = { ...loadConfig(), ...overrides };
  const db = openDb(config.databasePath);
  const app = Fastify({ logger: false });
  const sync = new SyncEngine(db);
  const orchestrator = buildOrchestrator(config);
  const jobs = new JobQueue();

  // Calendar providers (build plan §7.1). Google/Outlook re-encrypt refreshed tokens.
  const registry = new ProviderRegistry();
  const internalCalendar = new InternalCalendarProvider(db);
  const persistTokens = (linkId: string, tokens: string) => {
    db.prepare('UPDATE calendar_links SET token_ref = ? WHERE id = ?').run(encrypt(tokens), linkId);
  };
  const google = new GoogleCalendarProvider();
  google.onTokensRefreshed = persistTokens;
  const outlook = new OutlookCalendarProvider();
  outlook.onTokensRefreshed = persistTokens;
  registry.register(internalCalendar);
  registry.register(google);
  registry.register(outlook);

  const calendar = new CalendarService(db, sync, orchestrator, registry);
  const dispatcher = new NotificationDispatcher(db, [new OutboxSender(db)]);
  const reminders = new ReminderScheduler(db, sync, dispatcher, orchestrator);

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
  };

  // Scheduling path (plan §2.3): after an item is enriched, reminders get triggers
  // and ideas get calendar blocks — async, confirmed in plain language, undoable.
  ctx.afterEnrichment = (userId, itemId) => {
    jobs.enqueue(async () => {
      const item = sync.itemById(userId, itemId);
      if (!item) return;
      if (item.type === 'reminder' && item.timeIntent?.at) {
        reminders.ensureTrigger(userId, itemId, item.timeIntent.at, item.timeIntent.recurrence);
        const confirm = await orchestrator.run('confirm', {
          event: 'reminder_set',
          itemTitle: item.title,
          itemType: item.type,
          detail: { when: new Date(item.timeIntent.at).toLocaleString() },
        });
        calendar.recordActivity(userId, confirm.message, 'reminder_set', { itemId, undoable: false });
      } else if (item.type === 'idea' && config.flags.autoSchedule) {
        await calendar.autoSchedule(userId, itemId);
      }
    });
  };

  // Permissive CORS for the web dashboard / extension surfaces (token auth, no cookies).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'authorization, content-type');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());

  app.get('/v1/health', async () => ({ ok: true, version: '0.1.0' }));

  registerAuth(app, db, config.jwtSecret);
  registerConsent(app, db);
  registerDevices(app, db);
  registerItems(app, db, sync);
  registerSyncRoutes(app, sync);
  registerAccount(app, db);
  registerVoice(app, db, sync, orchestrator);
  registerCalendarRoutes(app, db, calendar, reminders);
  registerExtension(app, db, sync);

  return ctx;
}
