import type { FastifyInstance } from 'fastify';
import type { SyncEngine } from './sync.js';
import type { SyncOp } from '../types.js';

export function registerSyncRoutes(app: FastifyInstance, sync: SyncEngine): void {
  /** Replay a batch of (possibly offline-queued) client ops. Idempotent. */
  app.post('/v1/sync/ops', { preHandler: app.authenticate }, async (req, reply) => {
    const { ops } = (req.body ?? {}) as { ops?: SyncOp[] };
    if (!Array.isArray(ops)) return reply.code(400).send({ error: 'ops array required' });
    if (ops.length > 500) return reply.code(400).send({ error: 'max 500 ops per batch' });
    for (const op of ops) {
      if (!op || typeof op.opId !== 'string' || typeof op.kind !== 'string' || typeof op.entityId !== 'string') {
        return reply.code(400).send({ error: 'each op needs opId, kind, entityId' });
      }
    }
    return { results: await sync.applyOps(req.userId, ops) };
  });

  /** Catch-up: all changes after `since` (a change seq). */
  app.get('/v1/sync/changes', { preHandler: app.authenticate }, async (req) => {
    const { since } = req.query as { since?: string };
    const changes = await sync.changesSince(req.userId, Number(since ?? 0));
    return { changes, latest: changes.length ? changes[changes.length - 1]!.seq : Number(since ?? 0) };
  });

  /** Live change feed over SSE. */
  app.get('/v1/sync/stream', { preHandler: app.authenticate }, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(':ok\n\n');
    const unsubscribe = sync.subscribe(req.userId, (change) => {
      res.write(`data: ${JSON.stringify(change)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(':ka\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });
}
