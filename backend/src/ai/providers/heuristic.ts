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

/**
 * Duration-relative times ("in 5 minutes", "in the next minute", "in a few hours") —
 * timezone-FREE, so they must resolve deterministically and always beat the model
 * (a wrong guess here fires a reminder at a hallucinated time).
 */
export function parseRelativeTime(text: string, now = new Date()): TimeIntent | null {
  const t = text.toLowerCase();
  const rel = t.match(/\bin (?:(?<n>\d+)|(?<word>a|the next|a few|a couple(?: of)?)) (?<unit>minute|hour|day|week)s?\b/);
  if (rel?.groups) {
    const n = rel.groups.n ? Number(rel.groups.n) : /few|couple/.test(rel.groups.word ?? '') ? 3 : 1;
    const unitMs = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[
      rel.groups.unit as 'minute' | 'hour' | 'day' | 'week'
    ];
    return { at: now.getTime() + n * unitMs, phrase: rel[0] };
  }
  return null;
}

/** The offset (ms) that `timeZone` is at from UTC at the instant `utcMs` — computed by
 * asking Intl what wall-clock that instant shows there and diffing against the UTC
 * numbers. Timezone-arithmetic an LLM reliably gets wrong; this never does. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(new Date(utcMs))
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/** The true UTC instant for a wall-clock date/time as seen IN `timeZone` — e.g.
 * (2026, 7, 13, 12, 0, 'Asia/Kolkata') → the instant that reads noon in Kolkata,
 * not literally 12:00 UTC. One correction pass covers DST-transition edges. */
function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMs(guess, timeZone);
  const offset2 = tzOffsetMs(guess - offset, timeZone);
  return guess - offset2;
}

/** "Now", as calendar fields IN `timeZone` — the day/hour a wall-clock phrase like
 * "tomorrow" or "at 5" must be anchored to is the user's day, not the server's. */
function zonedNow(now: Date, timeZone: string): { y: number; mo: number; d: number; dow: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    dow: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(parts.weekday!.toLowerCase()),
    h: Number(parts.hour),
    mi: Number(parts.minute),
  };
}

/** Resolve an ambiguous bare hour (no am/pm, e.g. "at 5") to a 24h hour: noon/midnight
 * for 12/0, otherwise whichever of {AM, PM} is the next to occur from `now` on the
 * given day, or AM the following day once both have already passed. Casual speech
 * ("Monday at 2", "remind me at 5") almost always means the sooner upcoming one. */
function resolveAmbiguousHour(
  h: number,
  m: number,
  y: number,
  mo: number,
  d: number,
  nowMs: number,
  timeZone: string,
): { h: number; d: number } {
  if (h === 12 || h === 0) return { h, d };
  const amUtc = zonedTimeToUtc(y, mo, d, h, m, timeZone);
  if (amUtc > nowMs) return { h, d };
  const pmUtc = zonedTimeToUtc(y, mo, d, h + 12, m, timeZone);
  if (pmUtc > nowMs) return { h: h + 12, d };
  return { h, d: d + 1 };
}

/** Extract an explicit time expression ("friday at 3pm", "tomorrow", "in 2 hours"),
 * resolved in `timeZone` — the user's own clock, never the server's. Mechanically
 * computable, so (like parseRelativeTime) it must beat the model: an LLM reliably
 * fumbles the UTC-offset arithmetic (e.g. writing "T12:00:00.000Z" for "noon in
 * IST" instead of the correct 06:30Z), which is exactly the "6:32 for a ~12:00
 * request" bug this replaced. */
export function parseTimeIntent(text: string, now = new Date(), timeZone = 'UTC'): TimeIntent | null {
  const t = text.toLowerCase();

  const rel = parseRelativeTime(text, now);
  if (rel) return rel;

  // Bare "at 12" (no am/pm) only counts with an explicit "at"; an am/pm suffix
  // counts on its own ("3pm") — otherwise stray numbers ("in 2 minutes") would match.
  const timeMatch = t.match(/\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) ?? t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  const nowMs = now.getTime();
  const zn = zonedNow(now, timeZone);

  /** Hour/minute for a target day; `bareDefaultsPm` biases an unqualified hour
   * toward the evening for named-future-day phrasing ("Monday at 2" → 2pm), while
   * the plain today-anchored case instead picks whichever of AM/PM is soonest. */
  const hourFrom = (targetY: number, targetMo: number, targetD: number, bareDefaultsPm: boolean): { h: number; m: number; d: number } | null => {
    if (!timeMatch) return null;
    let h = Number(timeMatch[1]);
    const m = Number(timeMatch[2] ?? 0);
    if (timeMatch[3] === 'pm' && h < 12) h += 12;
    else if (timeMatch[3] === 'am' && h === 12) h = 0;
    else if (!timeMatch[3]) {
      if (bareDefaultsPm && h !== 12 && h !== 0) h += 12;
      else {
        const resolved = resolveAmbiguousHour(h, m, targetY, targetMo, targetD, nowMs, timeZone);
        return { h: resolved.h, m, d: resolved.d };
      }
    }
    return { h, m, d: targetD };
  };

  const day = WEEKDAYS.findIndex((w) => t.includes(w));
  if (day >= 0) {
    let delta = (day - zn.dow + 7) % 7;
    if (delta === 0) delta = 7;
    const hm = hourFrom(zn.y, zn.mo, zn.d + delta, true) ?? { h: 9, m: 0, d: zn.d + delta };
    return {
      at: zonedTimeToUtc(zn.y, zn.mo, hm.d, hm.h, hm.m, timeZone),
      phrase: WEEKDAYS[day] + (timeMatch ? ` ${timeMatch[0]}` : ''),
    };
  }

  if (/\btomorrow\b/.test(t)) {
    const hm = hourFrom(zn.y, zn.mo, zn.d + 1, true) ?? { h: 9, m: 0, d: zn.d + 1 };
    return { at: zonedTimeToUtc(zn.y, zn.mo, hm.d, hm.h, hm.m, timeZone), phrase: 'tomorrow' + (timeMatch ? ` ${timeMatch[0]}` : '') };
  }

  if (/\btonight\b/.test(t)) {
    let at = zonedTimeToUtc(zn.y, zn.mo, zn.d, 20, 0, timeZone);
    if (at < nowMs) at = zonedTimeToUtc(zn.y, zn.mo, zn.d + 1, 20, 0, timeZone);
    return { at, phrase: 'tonight' };
  }

  if (/\bevery (day|morning|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)) {
    const m = t.match(/\bevery (day|morning|week|\w+day)\b/)!;
    const hm = hourFrom(zn.y, zn.mo, zn.d, true) ?? { h: 9, m: 0, d: zn.d };
    let at = zonedTimeToUtc(zn.y, zn.mo, hm.d, hm.h, hm.m, timeZone);
    if (at < nowMs) at = zonedTimeToUtc(zn.y, zn.mo, hm.d + 1, hm.h, hm.m, timeZone);
    return { at, phrase: m[0], recurrence: m[1] === 'morning' ? 'day' : m[1] };
  }

  if (timeMatch) {
    const hm = hourFrom(zn.y, zn.mo, zn.d, false)!;
    let at = zonedTimeToUtc(zn.y, zn.mo, hm.d, hm.h, hm.m, timeZone);
    if (hm.d === zn.d && at < nowMs) at = zonedTimeToUtc(zn.y, zn.mo, zn.d + 1, hm.h, hm.m, timeZone);
    return { at, phrase: timeMatch[0] };
  }
  return null;
}

/**
 * Merge the model's time resolution with the deterministic parser.
 * Priority: (1) duration-relative parse ("in 3 minutes") — timezone-free, can't
 * hallucinate, always wins; (2) the full deterministic wall-clock parser, now
 * timezone-aware (weekdays, "tomorrow", "tonight", "every ...", bare "at H") — also
 * mechanically computable, so it beats the model too; (3) the model's timeAtIso, for
 * fuzzy/routine-anchored phrasing the parser can't handle at all (e.g. "after work").
 * This ordering fixed three real bugs: "in the next minute" hallucinated to a random
 * afternoon; the old UTC-only parser firing at 6:32 for a ~12:00 IST request; and —
 * why (2) now outranks the model — an 8B model asked to convert "noon in IST" to UTC
 * reliably just writes "T12:00:00.000Z" (local digits + a bare Z), not the correct
 * 06:30Z. Timezone arithmetic is exactly the kind of thing to never delegate to an
 * LLM when it's mechanically computable instead.
 */
export function resolveTimeIntent(
  text: string,
  model: { timePhrase: string | null; timeAtIso: string | null; recurrence: string | null },
  timezone = 'UTC',
): TimeIntent | null {
  const relative = parseRelativeTime(text);
  const wallClock = parseTimeIntent(text, new Date(), timezone);
  let at = relative?.at ?? wallClock?.at;
  if (at == null && model.timeAtIso) {
    const parsed = Date.parse(model.timeAtIso);
    if (!Number.isNaN(parsed)) at = parsed;
  }
  const phrase = model.timePhrase ?? relative?.phrase ?? wallClock?.phrase;
  const recurrence = model.recurrence ?? wallClock?.recurrence;
  if (at == null && !phrase) return null;
  return { ...(at != null ? { at } : {}), ...(phrase ? { phrase } : {}), ...(recurrence ? { recurrence } : {}) };
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
  const timeIntent = parseTimeIntent(text, new Date(), input.context.timezone);
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
  return {
    type,
    confidence,
    timeIntent,
    contextTag,
    appTrigger,
    title: cleanTitle(text),
    importance: 'normal',
    routineFact: null,
  };
}

export function cleanTitle(text: string): string {
  let t = text.trim().replace(/\s+/g, ' ');
  t = t.replace(/^(remind me to|remember to|don't forget to|dont forget to|i need to|i have to|todo:?|task:?|idea:?|note to self:?)\s+/i, '');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 80) t = `${t.slice(0, 77).trimEnd()}…`;
  return t.replace(/[.!]+$/, '');
}

/** Shared with the confidence gate (providers/confident.ts) so both agree on "too small to split". */
export function decomposeTooSmall(input: DecomposeInput): boolean {
  const words = input.text.trim().split(/\s+/).length;
  const granularity = input.profile?.decompositionGranularity ?? 'medium';
  const minWords = granularity === 'fine' ? 6 : granularity === 'coarse' ? 14 : 9;
  return words < minWords || input.type === 'reminder';
}

export function decomposeHeuristic(input: DecomposeInput): DecomposeOutput {
  const text = input.text.trim();
  // Product rule: small items get no decomposition — don't manufacture busywork.
  const granularity = input.profile?.decompositionGranularity ?? 'medium';
  if (decomposeTooSmall(input)) return { subtasks: [] };
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

/** Shared with the confidence gate (providers/confident.ts) so scoring never diverges. */
export function scoreOpenItems(input: MatchDoneInput): Array<{ id: string; score: number }> {
  const utter = tokenize(input.utterance.replace(/\b(done with|done|finished|completed?|mark|i)\b/gi, ' '));
  return input.openItems
    .map((it) => {
      const titleTokens = tokenize(it.title);
      const overlap = titleTokens.filter((tok) => utter.includes(tok)).length;
      return { id: it.id, score: titleTokens.length ? overlap / titleTokens.length : 0 };
    })
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score);
}

export function matchDoneHeuristic(input: MatchDoneInput): MatchDoneOutput {
  const best = scoreOpenItems(input);
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
