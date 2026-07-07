/**
 * Spoken-"done" completion (build plan §6.5): match an utterance against the
 * user's open items and complete it in one step, or return a disambiguation set.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import type { SyncEngine } from './sync.js';
import type { Orchestrator } from '../ai/orchestrator.js';
import { rowToItem } from './sync.js';

export function registerVoice(
  app: FastifyInstance,
  db: Db,
  sync: SyncEngine,
  orchestrator: Orchestrator,
): void {
  app.post('/v1/voice/done', { preHandler: app.authenticate }, async (req, reply) => {
    const { utterance } = (req.body ?? {}) as { utterance?: string };
    if (!utterance?.trim()) return reply.code(400).send({ error: 'utterance required' });

    const rows = db
      .prepare(
        "SELECT * FROM items WHERE user_id = ? AND status IN ('captured','processing','active','scheduled') ORDER BY created_at DESC LIMIT 50",
      )
      .all(req.userId) as Array<Record<string, unknown>>;
    const open = rows.map(rowToItem);

    const match = await orchestrator.run('matchDone', {
      utterance,
      openItems: open.map((i) => ({ id: i.id, title: i.title })),
    });

    if (match.matchedId) {
      sync.applyOps(req.userId, [
        { opId: randomUUID(), ts: Date.now(), kind: 'item.complete', entityId: match.matchedId },
      ]);
      const item = sync.itemById(req.userId, match.matchedId)!;
      const confirm = await orchestrator.run('confirm', {
        event: 'completed',
        itemTitle: item.title,
        itemType: item.type,
        detail: {},
      });
      return { completed: item, message: confirm.message };
    }
    if (match.candidates.length > 0) {
      return {
        completed: null,
        candidates: open.filter((i) => match.candidates.includes(i.id)),
        message: 'Which one did you finish?',
      };
    }
    return { completed: null, candidates: [], message: "I couldn't find a matching open item." };
  });
}
