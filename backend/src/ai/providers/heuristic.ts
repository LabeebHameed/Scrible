/**
 * Deterministic heuristic providers — the guaranteed fallback for every capability
 * (build plan risk #6: templated non-AI fallbacks for every user-facing path).
 * They also make the whole product function with no API key and in tests.
 */
import type {
  ClassifyInput,
  ClassifyOutput,
  ConfirmInput,
  ConfirmOutput,
  DecomposeInput,
  DecomposeOutput,
  DeriveProfileInput,
  DeriveProfileOutput,
  MatchDoneInput,
  MatchDoneOutput,
  ScheduleInput,
  ScheduleOutput,
} from '../contracts.js';
import type { TimeIntent } from '../../types.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Extract an explicit time expression ("friday at 3pm", "tomorrow", "in 2 hours"). */
export function parseTimeIntent(text: string, now = new Date()): TimeIntent | null {
  const t = text.toLowerCase();

  const rel = t.match(/\bin (\d+) (minute|hour|day|week)s?\b/);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[
      rel[2] as 'minute' | 'hour' | 'day' | 'week'
    ];
    return { at: now.getTime() + n * unitMs, phrase: rel[0] };
  }

  const timeMatch = t.match(/\b(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  const hourFrom = (): { h: number; m: number } | null => {
    if (!timeMatch) return null;
    let h = Number(timeMatch[1]);
    const m = Number(timeMatch[2] ?? 0);
    if (timeMatch[3] === 'pm' && h < 12) h += 12;
    if (timeMatch[3] === 'am' && h === 12) h = 0;
    return { h, m };
  };

  const day = WEEKDAYS.findIndex((d) => t.includes(d));
  if (day >= 0) {
    const target = new Date(now);
    let delta = (day - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    target.setDate(target.getDate() + delta);
    const hm = hourFrom() ?? { h: 9, m: 0 };
    target.setHours(hm.h, hm.m, 0, 0);
    return { at: target.getTime(), phrase: WEEKDAYS[day] + (timeMatch ? ` ${timeMatch[0]}` : '') };
  }

  if (/\btomorrow\b/.test(t)) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    const hm = hourFrom() ?? { h: 9, m: 0 };
    target.setHours(hm.h, hm.m, 0, 0);
    return { at: target.getTime(), phrase: 'tomorrow' + (timeMatch ? ` ${timeMatch[0]}` : '') };
  }

  if (/\btonight\b/.test(t)) {
    const target = new Date(now);
    target.setHours(20, 0, 0, 0);
    if (target.getTime() < now.getTime()) target.setDate(target.getDate() + 1);
    return { at: target.getTime(), phrase: 'tonight' };
  }

  if (/\bevery (day|morning|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)) {
    const m = t.match(/\bevery (day|morning|week|\w+day)\b/)!;
    const hm = hourFrom() ?? { h: 9, m: 0 };
    const target = new Date(now);
    target.setHours(hm.h, hm.m, 0, 0);
    if (target.getTime() < now.getTime()) target.setDate(target.getDate() + 1);
    return { at: target.getTime(), phrase: m[0], recurrence: m[1] === 'morning' ? 'day' : m[1] };
  }

  if (timeMatch) {
    const hm = hourFrom()!;
    const target = new Date(now);
    target.setHours(hm.h, hm.m, 0, 0);
    if (target.getTime() < now.getTime()) target.setDate(target.getDate() + 1);
    return { at: target.getTime(), phrase: timeMatch[0] };
  }
  return null;
}

/**
 * Multi-item utterances (plan §11.3): "remind me to call mom and also I have an
 * idea about…" splits into separate items. Conservative: only explicit connectors
 * split; a plain "and" never does (that's decomposition's job, not capture's).
 */
export function splitUtterance(text: string): string[] {
  const parts = text
    .split(/\s+(?:and also|also remind me|and remind me|oh and|and another thing[,:]?)\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 2);
  return parts.length >= 2 ? parts.slice(0, 5) : [text];
}

const COMPUTER_ACTION =
  /\b(post|tweet|email|e-mail|reply to|browser|website|upload|publish|laptop|computer|online|on x\b|github|linkedin|instagram|youtube|blog)\b/i;
const REMINDER_HINT = /\b(remind|reminder|don't forget|dont forget|remember to)\b/i;
const IDEA_HINT = /\b(idea|what if|maybe (?:we|i) (?:could|should)|concept|brainstorm|thought:?|i was thinking)\b/i;

/**
 * Extract a desktop app-launch trigger: "when I open Photoshop", "next time I'm in
 * Figma". Conservative — only explicit open/launch/in-app phrasing qualifies.
 */
export function parseAppTrigger(text: string): string | null {
  const stop =
    '(?=$|[,.!?;]| to\\b| next\\b| again\\b| later\\b| and\\b| remind\\b| i\\b| update\\b| check\\b| fix\\b| finish\\b| review\\b| send\\b| post\\b| write\\b| do\\b| go\\b| make\\b| create\\b| export\\b| upload\\b| edit\\b| look\\b| add\\b| clean\\b| reply\\b)';
  const patterns = [
    new RegExp(
      `\\bwhen(?:ever)? i(?:'m| am)? (?:next )?(?:open|launch|start|use|get(?: back)? (?:in|into|on)|(?:'m |am )?(?:in|on))\\s+([a-z0-9][\\w .+-]{1,30}?)${stop}`,
      'i',
    ),
    new RegExp(`\\bnext time i(?:'m| am)? (?:open|launch|start|use|in|on)\\s+([a-z0-9][\\w .+-]{1,30}?)${stop}`, 'i'),
  ];
  for (const re of patterns) {
    const match = text.match(re);
    const name = match?.[1]?.trim().replace(/^(the|my)\s+/i, '').toLowerCase();
    if (name && name.length >= 3 && !['chrome', 'the browser', 'browser'].includes(name)) {
      return name;
    }
  }
  return null;
}

export function classifyHeuristic(input: ClassifyInput): ClassifyOutput {
  const text = input.text.trim();
  const timeIntent = parseTimeIntent(text);
  const appTrigger = parseAppTrigger(text);
  let type: ClassifyOutput['type'] = 'task';
  let confidence = 0.55;
  if (REMINDER_HINT.test(text) || (timeIntent && !IDEA_HINT.test(text))) {
    type = 'reminder';
    confidence = REMINDER_HINT.test(text) ? 0.9 : 0.7;
  }
  if (IDEA_HINT.test(text)) {
    type = 'idea';
    confidence = 0.85;
  }
  const contextTag =
    type !== 'idea' && (COMPUTER_ACTION.test(text) || appTrigger) ? 'computer-action' : null;
  return { type, confidence, timeIntent, contextTag, appTrigger, title: cleanTitle(text) };
}

export function cleanTitle(text: string): string {
  let t = text.trim().replace(/\s+/g, ' ');
  t = t.replace(/^(remind me to|remember to|don't forget to|dont forget to|i need to|i have to|todo:?|task:?|idea:?|note to self:?)\s+/i, '');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 80) t = `${t.slice(0, 77).trimEnd()}…`;
  return t.replace(/[.!]+$/, '');
}

export function decomposeHeuristic(input: DecomposeInput): DecomposeOutput {
  const text = input.text.trim();
  // Product rule: small items get no decomposition — don't manufacture busywork.
  const words = text.split(/\s+/).length;
  const granularity = input.profile?.decompositionGranularity ?? 'medium';
  const minWords = granularity === 'fine' ? 6 : granularity === 'coarse' ? 14 : 9;
  if (words < minWords || input.type === 'reminder') return { subtasks: [] };
  const parts = text
    .split(/(?:,|;| and then | then | and also | after that |\band\b)/i)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 2);
  if (parts.length < 2) return { subtasks: [] };
  const max = granularity === 'coarse' ? 3 : granularity === 'fine' ? 8 : 5;
  return { subtasks: parts.slice(0, max).map(cleanTitle) };
}

export function confirmHeuristic(input: ConfirmInput): ConfirmOutput {
  const brief = input.profile?.tone === 'brief' || input.profile?.verbosity === 'low';
  const t = input.itemTitle;
  const d = input.detail;
  switch (input.event) {
    case 'captured': {
      const steps = d.subtaskCount ? `, ${d.subtaskCount} steps` : '';
      return {
        message: brief
          ? `${cap(input.itemType)}: “${t}”${steps}`
          : `Got it — ${input.itemType}: “${t}”${steps}.`,
      };
    }
    case 'scheduled':
      return {
        message: brief
          ? `“${t}” → ${d.when}`
          : `Scheduled “${t}” for ${d.when}${d.rationale ? ` — ${d.rationale}` : ''}.`,
      };
    case 'moved':
      return { message: brief ? `“${t}” moved to ${d.when}` : `Moved “${t}” to ${d.when}${d.rationale ? ` — ${d.rationale}` : ''}.` };
    case 'conflict':
      return {
        message: `“${t}” conflicts with ${d.conflictWith ?? 'another event'} — move it to ${d.when}?`,
      };
    case 'reminder_set':
      return { message: brief ? `Reminder: “${t}” at ${d.when}` : `I'll remind you: “${t}” — ${d.when}.` };
    case 'completed':
      return { message: brief ? `Done: “${t}”` : `Nice — “${t}” is done.` };
  }
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function matchDoneHeuristic(input: MatchDoneInput): MatchDoneOutput {
  const utter = tokenize(input.utterance.replace(/\b(done with|done|finished|completed?|mark|i)\b/gi, ' '));
  let best: Array<{ id: string; score: number }> = input.openItems
    .map((it) => {
      const titleTokens = tokenize(it.title);
      const overlap = titleTokens.filter((tok) => utter.includes(tok)).length;
      return { id: it.id, score: titleTokens.length ? overlap / titleTokens.length : 0 };
    })
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score);
  if (best.length === 0) return { matchedId: null, candidates: [] };
  if (best.length > 1 && best[1]!.score >= best[0]!.score * 0.8) {
    return { matchedId: null, candidates: best.slice(0, 3).map((b) => b.id) };
  }
  return { matchedId: best[0]!.id, candidates: [] };
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'some', 'them', 'then', 'when', 'what', 'have', 'need', 'get', 'its']);

/** Content tokens (stopword-filtered) — shared with the context engine (learning.ts). */
export const contentTokens = (s: string): string[] => tokenize(s);

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

export function scheduleHeuristic(input: ScheduleInput): ScheduleOutput {
  const durationMs = input.itemType === 'idea' ? 3_600_000 : 1_800_000;
  const wanted = input.timeIntent?.at;
  // Honor an explicit time when it falls in a free slot; otherwise first free slot
  // (preferring profile rhythm hours for ideas) within working hours.
  if (wanted) {
    const slot = input.freeSlots.find((s) => wanted >= s.start && wanted + durationMs <= s.end);
    if (slot) {
      return { start: wanted, end: wanted + durationMs, rationale: `the time you mentioned (${input.timeIntent?.phrase ?? ''})`.trim() };
    }
  }
  const preferredHours =
    input.itemType === 'idea' ? input.profile?.schedulingRhythm?.creativeHours : undefined;
  const fits = (s: { start: number; end: number }) => s.end - s.start >= durationMs;
  let chosen = preferredHours
    ? input.freeSlots.find((s) => fits(s) && preferredHours.includes(new Date(s.start).getHours()))
    : undefined;
  chosen ??= input.freeSlots.find(fits);
  if (!chosen) throw new Error('no-free-slot');
  return {
    start: chosen.start,
    end: chosen.start + durationMs,
    rationale: 'your first free block',
  };
}

export function deriveProfileHeuristic(input: DeriveProfileInput): DeriveProfileOutput {
  const msgs = input.userMessages;
  const avgLen = msgs.length ? msgs.reduce((a, m) => a + m.split(/\s+/).length, 0) / msgs.length : 20;
  const verbosity = avgLen < 12 ? 'low' : avgLen > 40 ? 'high' : 'medium';
  const counts = new Map<string, number>();
  for (const m of msgs) {
    for (const w of tokenize(m)) {
      if (w.length >= 6) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const vocabulary = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w]) => w);
  const completionHours = input.behavioralSignals?.completionHours ?? [];
  const morning = completionHours.filter((h) => h < 12).length;
  const rhythm =
    completionHours.length >= 5
      ? { creativeHours: morning > completionHours.length / 2 ? [8, 9, 10, 11] : [14, 15, 16, 17] }
      : undefined;
  return {
    attributes: {
      tone: verbosity === 'low' ? 'brief' : 'neutral',
      verbosity,
      decompositionGranularity:
        (input.behavioralSignals?.avgSubtaskEdits ?? 0) > 2 ? 'coarse' : 'medium',
      ...(rhythm ? { schedulingRhythm: rhythm } : {}),
      vocabulary,
    },
  };
}
