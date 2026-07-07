import { Orchestrator } from './orchestrator.js';
import * as h from './providers/heuristic.js';
import type { Config } from '../config.js';

/**
 * Build the orchestrator with each capability's provider chain.
 * Chain order = preference; the heuristic provider is always last so every
 * capability has a deterministic fallback (never a silent failure).
 */
export function buildOrchestrator(config: Config): Orchestrator {
  const orch = new Orchestrator();
  // LLM providers (Anthropic) are registered ahead of heuristics when configured —
  // wired in Phase 1 via providers/anthropic.ts.
  orch.register('classify', { name: 'heuristic', run: async (i) => h.classifyHeuristic(i) });
  orch.register('decompose', { name: 'heuristic', run: async (i) => h.decomposeHeuristic(i) });
  orch.register('confirm', { name: 'heuristic', run: async (i) => h.confirmHeuristic(i) });
  orch.register('matchDone', { name: 'heuristic', run: async (i) => h.matchDoneHeuristic(i) });
  orch.register('schedule', { name: 'heuristic', run: async (i) => h.scheduleHeuristic(i) });
  orch.register('deriveProfile', {
    name: 'heuristic',
    run: async (i) => h.deriveProfileHeuristic(i),
  });
  void config;
  return orch;
}
