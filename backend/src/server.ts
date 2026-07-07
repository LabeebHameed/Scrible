import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type Db } from './lib/db.js';
import { loadConfig, type Config } from './config.js';
import { registerAuth } from './modules/auth.js';
import { registerConsent } from './modules/consent.js';
import { registerDevices } from './modules/devices.js';
import { registerItems } from './modules/items.js';
import { registerSyncRoutes } from './modules/syncRoutes.js';
import { registerAccount } from './modules/account.js';
import { SyncEngine } from './modules/sync.js';
import { buildOrchestrator } from './ai/index.js';
import type { Orchestrator } from './ai/orchestrator.js';
import { JobQueue } from './lib/jobs.js';

export interface AppContext {
  app: FastifyInstance;
  db: Db;
  sync: SyncEngine;
  orchestrator: Orchestrator;
  jobs: JobQueue;
  config: Config;
}

export function buildApp(overrides?: Partial<Config>): AppContext {
  const config = { ...loadConfig(), ...overrides };
  const db = openDb(config.databasePath);
  const app = Fastify({ logger: false });
  const sync = new SyncEngine(db);
  const orchestrator = buildOrchestrator(config);
  const jobs = new JobQueue();

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

  return { app, db, sync, orchestrator, jobs, config };
}
