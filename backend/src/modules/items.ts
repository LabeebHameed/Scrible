/**
 * Item read routes + REST convenience mutations. Every mutation goes through the
 * SyncEngine op path so REST and offline-replay clients share one write path.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import { SyncEngine, rowToItem } from './sync.js';
import type { Item, SyncOp } from '../types.js';

export function registerItems(app: FastifyInstance, db: Db, sync: SyncEngine): void {
  app.get('/v1/items', { preHandler: app.authenticate }, async (req) => {
    const { status } = req.query as { status?: string };
    const rows = (await (status
      ? db
          .prepare('SELECT * FROM items WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200')
          .all(req.userId, status)
      : db
          .prepare("SELECT * FROM items WHERE user_id = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 200")
          .all(req.userId))) as Array<Record<string, unknown>>;
    return rows.map(rowToItem);
  });

  app.get('/v1/items/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await sync.itemById(req.userId, id);
    if (!item) return reply.code(404).send({ error: 'not found' });
    item.subtasks = await sync.subtasksFor(req.userId, id);
    return item;
  });

  /**
   * "Right now" queue (build plan §6.4): top ~5 next actions, transparent ordering —
   * explicit times first (soonest first), then everything else oldest-first.
   */
  app.get('/v1/queue', { preHandler: app.authenticate }, async (req) => {
    const rows = (await db
      .prepare(
        "SELECT * FROM items WHERE user_id = ? AND status IN ('captured','processing','active','scheduled') ORDER BY created_at",
      )
      .all(req.userId)) as Array<Record<string, unknown>>;
    const items = rows.map(rowToItem);
    const timed = items
      .filter((i) => i.timeIntent?.at)
      .sort((a, b) => (a.timeIntent!.at ?? 0) - (b.timeIntent!.at ?? 0));
    const rest = items.filter((i) => !i.timeIntent?.at);
    const queue = [...timed, ...rest].slice(0, 5);
    for (const item of queue) item.subtasks = await sync.subtasksFor(req.userId, item.id);
    return queue;
  });

  app.post('/v1/items', { preHandler: app.authenticate }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id : randomUUID();
    const results = await sync.applyOps(req.userId, [
      {
        opId: typeof body.opId === 'string' ? body.opId : randomUUID(),
        ts: Date.now(),
        kind: 'item.create',
        entityId: id,
        data: body,
      },
    ]);
    if (results[0]?.status.startsWith('error')) {
      return reply.code(400).send({ error: results[0].status });
    }
    const item = (await sync.itemById(req.userId, id)) as Item;
    item.subtasks = await sync.subtasksFor(req.userId, id);
    return reply.code(201).send(item);
  });

  const restOp =
    (kind: SyncOp['kind']) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const results = await sync.applyOps(req.userId, [
        {
          opId: randomUUID(),
          ts: Date.now(),
          kind,
          entityId: id,
          data: (req.body ?? {}) as Record<string, unknown>,
        },
      ]);
      const status = results[0]?.status ?? 'error';
      if (status === 'missing') return reply.code(404).send({ error: 'not found' });
      if (status.startsWith('error')) return reply.code(400).send({ error: status });
      return { ok: true, status, item: await sync.itemById(req.userId, id) };
    };

  app.post('/v1/items/:id/complete', { preHandler: app.authenticate }, restOp('item.complete'));
  app.post('/v1/items/:id/reopen', { preHandler: app.authenticate }, restOp('item.reopen'));
  app.patch('/v1/items/:id', { preHandler: app.authenticate }, restOp('item.update'));
  app.post('/v1/items/:id/retype', { preHandler: app.authenticate }, restOp('item.retype'));
  app.delete('/v1/items/:id', { preHandler: app.authenticate }, restOp('item.delete'));
}
