import { Orchestrator } from './orchestrator.js';
import * as h from './providers/heuristic.js';
import { AnthropicProvider, getUsage } from './providers/anthropic.js';
import { classifyLearned, matchDoneLearned } from './providers/learned.js';
import type { Config } from '../config.js';
import type { Db } from '../lib/db.js';

/**
 * Build the orchestrator with each capability's provider chain.
 * Chain order = preference: learned (0 tokens, when confident) first for classify
 * and matchDone, then Claude when configured, then the deterministic heuristic so
 * every capability always has a fallback (never a silent failure).
 */
export function buildOrchestrator(config: Config, db: Db): Orchestrator {
  const orch = new Orchestrator();

  orch.register('classify', { name: 'learned', run: classifyLearned(db) });
  orch.register('matchDone', { name: 'learned', run: matchDoneLearned(db) });

  if (config.anthropicApiKey) {
    const claude = new AnthropicProvider(config.anthropicApiKey);
    orch.register('classify', { name: 'anthropic', run: (i) => claude.classify(i), usageOf: getUsage });
    orch.register('decompose', { name: 'anthropic', run: (i) => claude.decompose(i), usageOf: getUsage });
    orch.register('confirm', { name: 'anthropic', run: (i) => claude.confirm(i), usageOf: getUsage });
    orch.register('matchDone', { name: 'anthropic', run: (i) => claude.matchDone(i), usageOf: getUsage });
    orch.register('deriveProfile', { name: 'anthropic', run: (i) => claude.deriveProfile(i), usageOf: getUsage });
    // 'schedule' stays heuristic-first: slot selection over a computed free/busy
    // list is deterministic constraint-solving, not language understanding.
  }

  orch.register('classify', { name: 'heuristic', run: async (i) => h.classifyHeuristic(i) });
  orch.register('decompose', { name: 'heuristic', run: async (i) => h.decomposeHeuristic(i) });
  orch.register('confirm', { name: 'heuristic', run: async (i) => h.confirmHeuristic(i) });
  orch.register('matchDone', { name: 'heuristic', run: async (i) => h.matchDoneHeuristic(i) });
  orch.register('schedule', { name: 'heuristic', run: async (i) => h.scheduleHeuristic(i) });
  orch.register('deriveProfile', {
    name: 'heuristic',
    run: async (i) => h.deriveProfileHeuristic(i),
  });
  return orch;
}
