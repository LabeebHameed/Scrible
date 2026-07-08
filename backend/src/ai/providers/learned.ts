/**
 * Learned provider (Phase 8) — the token-free path. Blends deterministic heuristics
 * with the user's own accumulated corrections (../learning.ts). A confident answer
 * short-circuits before any LLM call (0 tokens); an unconfident one throws so the
 * orchestrator falls through to Claude exactly as it already does on any provider
 * failure (ai/orchestrator.ts — no changes to that fallback mechanism).
 */
import type { Db } from '../../lib/db.js';
import type { ClassifyInput, ClassifyOutput, MatchDoneInput, MatchDoneOutput } from '../contracts.js';
import { classifyHeuristic, contentTokens } from './heuristic.js';
import { typePriors, appAliasFor, keyWeights } from '../learning.js';

export class NotConfident extends Error {
  constructor() {
    super('not confident');
  }
}

const CONFIDENCE_THRESHOLD = 0.85;
/** Minimum absolute evidence before a prior is trusted, even at 100% agreement. */
const MIN_EVIDENCE = 2;

export function classifyLearned(db: Db) {
  return async (input: ClassifyInput): Promise<ClassifyOutput> => {
    if (!input.userId) throw new NotConfident();
    const base = classifyHeuristic(input);

    const priors = typePriors(db, input.userId, input.text);
    const totalEvidence = priors.reduce((sum, p) => sum + Math.max(0, p.score), 0);
    const top = priors[0];
    const alias = appAliasFor(db, input.userId, input.text);

    const typeConfident = !!top && top.score >= MIN_EVIDENCE && top.score / Math.max(totalEvidence, 1e-9) >= CONFIDENCE_THRESHOLD;
    if (!typeConfident && !alias) throw new NotConfident();

    const type = typeConfident ? top!.type : base.type;
    const appTrigger = alias && alias.score >= MIN_EVIDENCE ? alias.value : base.appTrigger;
    return {
      ...base,
      type,
      confidence: typeConfident ? Math.max(base.confidence, top!.score / totalEvidence) : base.confidence,
      appTrigger,
      contextTag: type !== 'idea' && (base.contextTag != null || !!appTrigger) ? 'computer-action' : null,
    };
  };
}

export function matchDoneLearned(db: Db) {
  return async (input: MatchDoneInput): Promise<MatchDoneOutput> => {
    if (!input.userId) throw new NotConfident();
    const utterTokens = new Set(contentTokens(input.utterance));
    if (utterTokens.size === 0) throw new NotConfident();

    const weights = keyWeights(db, input.userId);
    const scored = input.openItems
      .map((it) => {
        const titleTokens = contentTokens(it.title);
        if (titleTokens.length === 0) return { id: it.id, score: 0 };
        const weightOf = (t: string) => 1 + (weights.get(t) ?? 0);
        const overlap = titleTokens.filter((t) => utterTokens.has(t));
        const weightedOverlap = overlap.reduce((a, t) => a + weightOf(t), 0);
        const weightedTotal = titleTokens.reduce((a, t) => a + weightOf(t), 0);
        return { id: it.id, score: weightedTotal ? weightedOverlap / weightedTotal : 0 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) throw new NotConfident();
    const top = scored[0]!;
    const second = scored[1];
    if (top.score < CONFIDENCE_THRESHOLD || (second && second.score >= top.score * 0.8)) {
      throw new NotConfident();
    }
    return { matchedId: top.id, candidates: [] };
  };
}
