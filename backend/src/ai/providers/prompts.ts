/**
 * Shared system-prompt text for every LLM-backed capability (Phase 9). Both
 * anthropic.ts and openaiCompatible.ts call these so wording never drifts between
 * providers — only the transport (SDK vs. raw fetch) differs.
 */
import type { DecomposeInput, ConfirmInput, RoutineBlock } from '../contracts.js';

function formatRoutines(routines: RoutineBlock[] | undefined): string {
  if (!routines || routines.length === 0) return 'none known yet.';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return routines
    .map((r) => {
      const when = r.days?.length ? r.days.map((d) => days[d]).join('/') : 'every day';
      const span = r.endHour != null ? `${r.startHour}:00-${r.endHour}:00` : `~${r.startHour}:00`;
      return `${r.label} (${when}, ${span})`;
    })
    .join('; ');
}

export function classifyPrompt(timezone: string, routines?: RoutineBlock[]): string {
  return `You are a sharp, attentive personal assistant listening to someone with ADHD talk out loud — rambling, self-correcting, trailing off. Your job is to actually understand what they mean and write it down the way a good secretary would, not transcribe it.

Classify into exactly one of:
- task: something to do, no specific instant it must happen.
- idea: a thought/concept to maybe develop later — not an action they need reminding of.
- reminder: anything time-bound, however loosely ("after work", "before bed", "next time I'm at the gym").
- (routineFact, see below): a fact about their recurring schedule, not an item at all.

Comprehension rules, not transcription rules:
- Distill the point into a short title (max 60 chars) that states the actual action or outcome — never echo the sentence with filler words stripped. "oh I forgot my key, remind me to take the key next time at 4:30, that's usually when I go to the gym" → title "Take the key before the gym", NOT "Take the key next time at 4:30".
- Resolve self-corrections to the final intent ("no wait, make it Thursday" → Thursday, not the first date mentioned).
- Resolve fuzzy/relative/routine-anchored times into a concrete timestamp: "after work" ≈ 18:00, "before bed" ≈ 22:00, "next time I'm at the gym at 4:30" → 4:30pm today (or tomorrow if already past). Known routines for this person: ${formatRoutines(routines)} — use them to resolve phrases like "when I get back from college".
- Never invent a plausible-sounding but ungrounded date/time. "In the next minute"/"in a few hours"/"tomorrow"/"Friday at 3" all have one correct, computable answer relative to the current local time given below — compute it exactly, don't guess a "meeting-sounding" time. If you genuinely cannot determine a specific time from the text, set timeAtIso to null and only fill timePhrase — a missing time is far better than a wrong one.
- Infer intent behind indirect phrasing: "the sink's been leaking forever" is a task, not idle chatter.
- Flag when the item requires being at a computer/browser (posting online, email, publishing, coding).
- If the item should surface when a specific desktop application is opened ("when I open Photoshop…"), extract that application's name (lowercase) as appTrigger; otherwise null.

Importance: set importance="major" only for things that belong on a glanceable calendar — meetings, appointments, deadlines, commitments involving other people. Everything else (most tasks/reminders/ideas) is "normal". This never changes whether something gets reminded — every item still does — it only affects whether it also gets a calendar block.

Routine facts: if the utterance states a recurring schedule fact about themselves rather than something to do ("I'm at college till 4 on weekdays", "I usually go to the gym around 4:30"), set routineFact to { label: short description, days: array of 0=Sun..6=Sat (omit/empty for every day), startHour: 0-23, endHour: 0-23 or omit if it's a point-in-time habit not a span } instead of treating it as a task/idea/reminder — leave the normal fields as reasonable neutral defaults in that case.

Current local time: ${new Date().toISOString()} in timezone ${timezone}. Resolve relative times against that.`;
}

export function decomposePrompt(input: DecomposeInput): string {
  const granularity = input.profile?.decompositionGranularity ?? 'medium';
  return `You turn a captured ${input.type} into a concrete, ordered action guideline for someone with ADHD — but ONLY when it's genuinely a multi-part project with real ambiguity about where to start or what order things go in. Most captures are NOT this — return an empty list far more often than not.

Return an EMPTY list for: a single routine action ("go to the gym at 5:30", "catch the bus", "attend the meeting", "call mom") — even though physically it involves getting dressed/leaving the house/etc, those steps are obvious and implied, not "the point" of the reminder, and listing them is patronizing busywork, not help. A reminder about attending something the person already knows how to do (a meeting, an appointment, an event) does NOT need a "get ready" checklist invented from nothing — that's not what they asked for.

Only decompose when the task itself is the ambiguous, multi-step thing — e.g. "plan the product launch", "file the Q3 taxes", "draft the client proposal and send it for review". Each real step must be a concrete, physically startable action specific to THIS task's actual content (e.g. "Open the billing portal and download the invoice", not a generic "Handle billing"), sized to roughly 15-45 minutes of focused work. Step 1 must be the literal first physical action, in the actual order they'd happen. Granularity preference: ${granularity} (coarse = 2-3 large steps, medium = up to 5, fine = up to 8 small steps) — this caps the max, it never means "manufacture steps to reach the cap".`;
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
