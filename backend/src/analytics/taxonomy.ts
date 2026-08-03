/**
 * Analytics event taxonomy v1 (build plan §10.2).
 *
 * Every event and every property is declared here; the forwarding layer rejects
 * anything else. Property kinds are deliberately unable to carry content:
 *   - count      non-negative integer
 *   - durationMs non-negative integer milliseconds
 *   - flag       boolean
 *   - enum       one of the declared values
 * There is NO free-text kind — transcript text, item titles, import content, and
 * calendar details cannot enter analytics by construction.
 */

export const TAXONOMY_VERSION = '2026-07-08';

type PropSpec =
  | { kind: 'count' }
  | { kind: 'durationMs' }
  | { kind: 'flag' }
  | { kind: 'enum'; values: readonly string[] };

export interface EventSpec {
  props: Record<string, PropSpec>;
}

const itemType = { kind: 'enum', values: ['task', 'idea', 'reminder'] } as const;
const source = { kind: 'enum', values: ['voice', 'typed', 'import'] } as const;
const surface = { kind: 'enum', values: ['ios', 'android', 'web', 'extension'] } as const;
const editBucket = { kind: 'enum', values: ['none', 'light', 'heavy'] } as const;

export const EVENTS: Record<string, EventSpec> = {
  // Activation
  'signup.completed': { props: { surface } },
  'capture.first': { props: { surface } },
  'item.first_completed': { props: { surface } },
  'calendar.linked': { props: { provider: { kind: 'enum', values: ['internal', 'google', 'outlook', 'apple'] } } },
  'extension.installed': { props: {} },

  // Voice-capture success (the north-star quality metric)
  'capture.started': { props: { surface, source } },
  'capture.completed': { props: { surface, source, durationMs: { kind: 'durationMs' } } },
  'capture.abandoned': { props: { surface, source } },
  'transcription.corrected': { props: { editDistance: editBucket } },
  'classification.corrected': { props: { from: itemType, to: itemType } },
  'decomposition.edited': { props: { subtasksAdded: { kind: 'count' }, subtasksRemoved: { kind: 'count' } } },

  // Core loop health
  'item.created': { props: { type: itemType, source, surface } },
  'item.completed': { props: { type: itemType, surface, viaVoice: { kind: 'flag' }, timeToCompleteMs: { kind: 'durationMs' } } },
  'queue.viewed': { props: { surface, queueSize: { kind: 'count' } } },
  'voice_done.used': { props: { matched: { kind: 'flag' }, candidates: { kind: 'count' } } },

  // Scheduling
  'schedule.proposed': { props: { type: itemType } },
  'schedule.accepted': { props: {} },
  'schedule.moved': { props: { byUser: { kind: 'flag' } } },
  'schedule.undone': { props: {} },
  'schedule.conflict_shown': { props: { resolved: { kind: 'flag' } } },
  'reminder.delivered': { props: { channel: { kind: 'enum', values: ['push', 'outbox', 'extension'] } } },
  'reminder.snoozed': { props: {} },

  // Cross-device
  'popup.shown': { props: { itemCount: { kind: 'count' } } },
  'popup.acted': { props: { action: { kind: 'enum', values: ['done', 'later', 'next_session', 'open'] } } },

  // Personalization
  'import.started': { props: { source: { kind: 'enum', values: ['claude', 'chatgpt', 'gemini', 'generic'] } } },
  'import.completed': { props: { messages: { kind: 'count' } } },
  'profile.deleted': { props: {} },
  'profile.edited': { props: {} },

  // Retention signal (session pings; cohorting happens in the provider)
  'app.opened': { props: { surface } },
};

export type ValidationResult =
  | { ok: true; props: Record<string, string | number | boolean> }
  | { ok: false; reason: string };

/** Validate an event against the taxonomy. Unknown events/props are rejected. */
export function validateEvent(name: string, props: Record<string, unknown>): ValidationResult {
  const spec = EVENTS[name];
  if (!spec) return { ok: false, reason: `unknown event: ${name}` };
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    const propSpec = spec.props[key];
    if (!propSpec) return { ok: false, reason: `unknown property ${key} on ${name}` };
    switch (propSpec.kind) {
      case 'count':
      case 'durationMs':
        if (typeof value !== 'number' || value < 0 || !Number.isFinite(value)) {
          return { ok: false, reason: `${key} must be a non-negative number` };
        }
        clean[key] = Math.round(value);
        break;
      case 'flag':
        if (typeof value !== 'boolean') return { ok: false, reason: `${key} must be boolean` };
        clean[key] = value;
        break;
      case 'enum':
        if (typeof value !== 'string' || !propSpec.values.includes(value)) {
          return { ok: false, reason: `${key} must be one of ${propSpec.values.join('|')}` };
        }
        clean[key] = value;
        break;
    }
  }
  return { ok: true, props: clean };
}
