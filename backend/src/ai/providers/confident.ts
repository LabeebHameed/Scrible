/**
 * Confidence gates (Phase 9) — the "automate first" half of the free-tier-first
 * design. Each wraps a heuristic and only returns when the heuristic's own signal
 * is strong; otherwise it throws NotConfident so the orchestrator falls through to
 * an LLM tier exactly like any other provider failure (ai/orchestrator.ts unchanged).
 * Reuses the same NotConfident class as the learned provider (providers/learned.ts).
 */
import type { ClassifyInput, ClassifyOutput, DecomposeInput, DecomposeOutput, MatchDoneInput, MatchDoneOutput } from '../contracts.js';
import { classifyHeuristic, decomposeHeuristic, decomposeTooSmall, scoreOpenItems } from './heuristic.js';
import { NotConfident } from './learned.js';

/** Explicit reminder/idea hints already push heuristic confidence well above the ambiguous 0.55/0.7 middle. */
const CLASSIFY_CONFIDENCE_THRESHOLD = 0.75;
/** Tighter than matchDoneHeuristic's own 0.3 pass bar — only a strong single match skips AI. */
const MATCH_DONE_CONFIDENCE_THRESHOLD = 0.6;

export function classifyConfident(input: ClassifyInput): ClassifyOutput {
  const result = classifyHeuristic(input);
  if (result.confidence >= CLASSIFY_CONFIDENCE_THRESHOLD) return result;
  throw new NotConfident();
}

export function decomposeConfident(input: DecomposeInput): DecomposeOutput {
  const result = decomposeHeuristic(input);
  // Confident either way: explicit connectors found, or confidently too small to split.
  if (result.subtasks.length > 0 || decomposeTooSmall(input)) return result;
  throw new NotConfident();
}

export function matchDoneConfident(input: MatchDoneInput): MatchDoneOutput {
  const scored = scoreOpenItems(input);
  // Ambiguous between the top two, or the top match isn't strong enough — let AI decide.
  if (scored.length === 0) throw new NotConfident();
  if (scored.length > 1 && scored[1]!.score >= scored[0]!.score * 0.8) throw new NotConfident();
  if (scored[0]!.score < MATCH_DONE_CONFIDENCE_THRESHOLD) throw new NotConfident();
  return { matchedId: scored[0]!.id, candidates: [] };
}
