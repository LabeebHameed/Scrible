import { Orchestrator } from './orchestrator.js';
import * as h from './providers/heuristic.js';
import { AnthropicProvider, getUsage } from './providers/anthropic.js';
import { OpenAICompatibleProvider } from './providers/openaiCompatible.js';
import { classifyLearned, matchDoneLearned } from './providers/learned.js';
import { classifyConfident, decomposeConfident, matchDoneConfident } from './providers/confident.js';
import type { Config } from '../config.js';
import type { Db } from '../lib/db.js';

/**
 * Build the orchestrator with each capability's provider chain (Phase 9 —
 * free-tier-first, automate-first design; see docs/AI-MAP.md).
 *
 * Chain order = preference, WHEN an LLM key is configured:
 *  1. `learned`            — 0 tokens, when the user's own corrections are confident.
 *  2. `nvidia`             — free-tier LLM (NVIDIA NIM or any OpenAI-compatible
 *                            endpoint), tried before any paid provider.
 *  3. `anthropic`          — optional, paid, only registered if ANTHROPIC_API_KEY is
 *                            explicitly set (opt-in quality upgrade, not required).
 *  4. `heuristic`          — deterministic best-effort, always succeeds, guarantees
 *                            the app never hard-fails and never costs anything.
 *
 * `heuristic-confident` (0-token keyword/regex shortcuts) is only registered when NO
 * LLM key is configured at all. With a free-tier LLM available, the common phrasings
 * that used to short-circuit here (explicit "remind"/"idea" keywords) are exactly the
 * bulk of real captures — skipping the LLM for them was the root cause of the app
 * feeling like a keyword matcher instead of an assistant. Offline/no-key installs keep
 * today's zero-token behavior unchanged.
 *
 * `confirm` intentionally skips both AI tiers — it fires on every event (captured,
 * scheduled, moved, conflict, completed) and templated heuristic messages already
 * honor tone/verbosity, so this is the single largest per-capture token cut.
 * `schedule` stays heuristic-only — deterministic constraint-solving, not language
 * understanding.
 */
export function buildOrchestrator(config: Config, db: Db): Orchestrator {
  const orch = new Orchestrator();
  const hasLLM = !!(config.nvidiaApiKey || config.anthropicApiKey);

  orch.register('classify', { name: 'learned', run: classifyLearned(db) });
  orch.register('matchDone', { name: 'learned', run: matchDoneLearned(db) });
  if (!hasLLM) {
    orch.register('classify', { name: 'heuristic-confident', run: async (i) => classifyConfident(i) });
    orch.register('decompose', { name: 'heuristic-confident', run: async (i) => decomposeConfident(i) });
    orch.register('matchDone', { name: 'heuristic-confident', run: async (i) => matchDoneConfident(i) });
  }

  if (config.nvidiaApiKey) {
    const nvidia = new OpenAICompatibleProvider({
      apiKey: config.nvidiaApiKey,
      model: config.nvidiaModel,
      baseUrl: config.nvidiaBaseUrl,
    });
    orch.register('classify', { name: 'nvidia', run: (i) => nvidia.classify(i), usageOf: nvidia.getUsage });
    orch.register('decompose', { name: 'nvidia', run: (i) => nvidia.decompose(i), usageOf: nvidia.getUsage });
    orch.register('matchDone', { name: 'nvidia', run: (i) => nvidia.matchDone(i), usageOf: nvidia.getUsage });
    orch.register('deriveProfile', { name: 'nvidia', run: (i) => nvidia.deriveProfile(i), usageOf: nvidia.getUsage });
    // 'confirm' intentionally excluded — heuristic-only (see doc comment above).
  }

  if (config.anthropicApiKey) {
    const claude = new AnthropicProvider(config.anthropicApiKey);
    orch.register('classify', { name: 'anthropic', run: (i) => claude.classify(i), usageOf: getUsage });
    orch.register('decompose', { name: 'anthropic', run: (i) => claude.decompose(i), usageOf: getUsage });
    orch.register('matchDone', { name: 'anthropic', run: (i) => claude.matchDone(i), usageOf: getUsage });
    orch.register('deriveProfile', { name: 'anthropic', run: (i) => claude.deriveProfile(i), usageOf: getUsage });
    // 'confirm' intentionally excluded here too — see doc comment above.
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
