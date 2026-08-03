/**
 * Shared system-prompt text for every LLM-backed capability (Phase 9). Both
 * anthropic.ts and openaiCompatible.ts call these so wording never drifts between
 * providers — only the transport (SDK vs. raw fetch) differs.
 */
import type { DecomposeInput, ConfirmInput } from '../contracts.js';

export function classifyPrompt(timezone: string): string {
  return `You classify a voice-captured note into exactly one of: task (something to do), idea (a thought/concept to develop later), reminder (time-bound nudge). Extract any explicit time expression. Flag when the item requires being at a computer/browser (posting online, email, publishing, coding). If the item should surface when a specific desktop application is opened ("when I open Photoshop…"), extract that application's name (lowercase) as appTrigger; otherwise null. Current local time: ${new Date().toISOString()} in timezone ${timezone}. Resolve relative times against that. Produce a short cleaned title (max 60 chars) without filler like "remind me to".`;
}

export function decomposePrompt(input: DecomposeInput): string {
  const granularity = input.profile?.decompositionGranularity ?? 'medium';
  return `You break a captured ${input.type} into concrete, ordered sub-tasks. Rules: if the item is small enough to do in one sitting, return an empty list — never manufacture busywork. Granularity preference: ${granularity} (coarse = 2-3 large steps, medium = up to 5, fine = up to 8 small steps). Each sub-task is a short imperative phrase.`;
}

export function confirmPrompt(input: ConfirmInput): string {
  const tone = input.profile?.tone ?? 'neutral';
  const verbosity = input.profile?.verbosity ?? 'medium';
  return `Write a one-line plain-language confirmation for a task app. Tone: ${tone}. Verbosity: ${verbosity}. Never exceed 120 characters. No emoji unless tone is warm.`;
}

export const MATCH_DONE_PROMPT =
  'The user spoke a completion utterance. Match it to exactly one of their open items. If confident, set matchedId. If ambiguous between a few, return their ids as candidates with matchedId null. If nothing matches, both empty/null.';

export const DERIVE_PROFILE_PROMPT =
  "Derive a small structured working-style profile from a user's assistant-chat messages and behavioral signals. Output ONLY structured attributes — never quote or paraphrase the conversations. vocabulary = up to 15 domain terms the user actually uses. schedulingRhythm hours are 0-23 local.";
