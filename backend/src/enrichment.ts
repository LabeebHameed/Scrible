/**
 * Capture-path enrichment (build plan §2.3): when an item is created, an async job
 * classifies it, decomposes it, and attaches a plain-language summary. The item is
 * fully usable before, during, and after — enrichment failure degrades, never blocks.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from './server.js';
import type { ItemType } from './types.js';
import { loadEffectiveProfile, recordRoutineFact } from './modules/profile.js';
import { splitUtterance } from './ai/providers/heuristic.js';

export function enableEnrichment(ctx: AppContext): void {
  if (!ctx.config.flags.autoClassify) return;
  const { db, sync, orchestrator, jobs } = ctx;

  sync.onItemCreated = (userId, itemId) => {
    jobs.enqueue(async () => {
      const item = await sync.itemById(userId, itemId);
      if (!item || item.status !== 'captured') return; // user already typed it or acted
      await sync.serverUpdateItem(userId, itemId, { status: 'processing' });

      // Multi-item utterance: split before classification; the original item keeps
      // the first part, each extra part becomes its own item (enriched in turn).
      const parts = splitUtterance(item.rawText);
      if (parts.length > 1) {
        await sync.serverUpdateItem(userId, itemId, { rawText: parts[0], title: parts[0] });
        const extraOps = parts.slice(1).map((part) => ({
          opId: randomUUID(),
          ts: Date.now(),
          kind: 'item.create' as const,
          entityId: randomUUID(),
          data: { rawText: part, source: item.source },
        }));
        await sync.applyOps(userId, extraOps);
        await sync.audit(userId, 'item.split', 'item', itemId, { parts: parts.length }, false);
        // Reload with the trimmed text before classifying.
        const updated = await sync.itemById(userId, itemId);
        if (!updated) return;
        item.rawText = updated.rawText;
      }

      const user = (await db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId)) as
        | { timezone: string }
        | undefined;
      const recent = (await db
        .prepare(
          "SELECT type FROM items WHERE user_id = ? AND id != ? ORDER BY created_at DESC LIMIT 5",
        )
        .all(userId, itemId)) as Array<{ type: ItemType }>;
      const profile = await loadProfile(ctx, userId);

      const cls = await orchestrator.run('classify', {
        userId,
        text: item.rawText,
        context: {
          localHour: new Date().getHours(),
          recentTypes: recent.map((r) => r.type),
          timezone: user?.timezone ?? 'UTC',
        },
        profile,
      });

      // A stated routine fact ("I'm at college till 4 on weekdays") isn't an
      // actionable item — remember it for future understanding/scheduling and
      // auto-complete instead of running decompose/confirm on it.
      if (cls.routineFact) {
        if (ctx.config.flags.personalization) {
          await recordRoutineFact(db, userId, cls.routineFact);
        }
        await sync.serverUpdateItem(userId, itemId, {
          title: `Noted: ${cls.routineFact.label}`,
          confidence: cls.confidence,
          summary: `Got it — I'll remember: ${cls.routineFact.label}.`,
        });
        await sync.applyOps(userId, [{ opId: randomUUID(), ts: Date.now(), kind: 'item.complete', entityId: itemId }]);
        await sync.audit(userId, 'item.routine_noted', 'item', itemId, { label: cls.routineFact.label }, true);
        return;
      }

      const dec = await orchestrator.run('decompose', {
        text: item.rawText,
        type: cls.type,
        profile,
      });

      const now = Date.now();
      let position = 0;
      const subtaskOps = dec.subtasks.map((title) => ({
        opId: randomUUID(),
        ts: now,
        kind: 'subtask.create' as const,
        entityId: randomUUID(),
        data: { itemId, title, position: position++, origin: 'ai' },
      }));
      await sync.applyOps(userId, subtaskOps);

      const confirm = await orchestrator.run('confirm', {
        event: 'captured',
        itemTitle: cls.title,
        itemType: cls.type,
        detail: { subtaskCount: dec.subtasks.length || undefined },
        profile,
      });

      await sync.serverUpdateItem(userId, itemId, {
        type: cls.type,
        title: cls.title,
        confidence: cls.confidence,
        contextTag: cls.contextTag,
        appTrigger: cls.appTrigger,
        importance: cls.importance,
        timeIntent: cls.timeIntent,
        summary: confirm.message,
        status: 'active',
      });
      await sync.audit(
        userId,
        'item.classified',
        'item',
        itemId,
        { type: cls.type, confidence: cls.confidence, subtasks: dec.subtasks.length },
        true,
      );
      ctx.afterEnrichment?.(userId, itemId);
    });
  };
}

async function loadProfile(ctx: AppContext, userId: string) {
  if (!ctx.config.flags.personalization) return null;
  return loadEffectiveProfile(ctx.db, userId);
}

declare module './server.js' {
  interface AppContext {
    /** Phase 2 hooks scheduling after enrichment completes. */
    afterEnrichment?: (userId: string, itemId: string) => void;
  }
}
