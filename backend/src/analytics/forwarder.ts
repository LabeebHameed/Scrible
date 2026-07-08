/**
 * Analytics forwarding layer (build plan §10.1). The single choke point between
 * the product and any analytics provider:
 *   - consent gating in one place (category 'analytics'; no consent → event dropped)
 *   - taxonomy enforcement (unknown events/props rejected — see taxonomy.ts)
 *   - pseudonymisation: events are keyed by a RANDOM per-user id stored only in
 *     analytics_ids; deleting that one row (consent revocation / account deletion)
 *     permanently unlinks all past events from the account
 *   - provider abstraction: events land in the local analytics_events store and are
 *     forwarded to a provider sink when configured (Amplitude/Mixpanel — a thin
 *     HTTP sink keeps migration trivial)
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import { hasConsent } from '../modules/consent.js';
import { TAXONOMY_VERSION, validateEvent } from './taxonomy.js';

export interface ProviderSink {
  name: string;
  send(pseudoId: string, name: string, props: Record<string, unknown>, ts: number): Promise<void>;
}

export class AnalyticsForwarder {
  constructor(
    private db: Db,
    private sinks: ProviderSink[] = [],
  ) {}

  /** Random per-user pseudonymous id; created lazily, erased on unlink. */
  private pseudoId(userId: string): string {
    const row = this.db.prepare('SELECT pseudo_id FROM analytics_ids WHERE user_id = ?').get(userId) as
      | { pseudo_id: string }
      | undefined;
    if (row) return row.pseudo_id;
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO analytics_ids (user_id, pseudo_id, created_at) VALUES (?, ?, ?)')
      .run(userId, id, Date.now());
    return id;
  }

  /**
   * Track one event. Returns 'stored' | 'no-consent' | 'rejected'. Consent-off users
   * generate zero rows and zero provider traffic.
   */
  track(userId: string, name: string, props: Record<string, unknown> = {}): 'stored' | 'no-consent' | 'rejected' {
    if (!hasConsent(this.db, userId, 'analytics')) return 'no-consent';
    const result = validateEvent(name, props);
    if (!result.ok) return 'rejected';
    const ts = Date.now();
    const pseudoId = this.pseudoId(userId);
    this.db
      .prepare(
        'INSERT INTO analytics_events (id, pseudo_id, event, props, schema_version, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), pseudoId, name, JSON.stringify(result.props), TAXONOMY_VERSION, ts);
    for (const sink of this.sinks) {
      void sink.send(pseudoId, name, result.props, ts).catch(() => {
        /* provider outage never breaks the product; local store is the buffer */
      });
    }
    return 'stored';
  }
}

/**
 * Amplitude HTTP sink (batch endpoint). Enabled when AMPLITUDE_API_KEY is set;
 * swapping providers means swapping this one class (the point of the layer).
 */
export class AmplitudeSink implements ProviderSink {
  name = 'amplitude';
  constructor(private apiKey: string) {}
  async send(pseudoId: string, name: string, props: Record<string, unknown>, ts: number): Promise<void> {
    await fetch('https://api2.amplitude.com/2/httpapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        events: [{ user_id: pseudoId, event_type: name, event_properties: props, time: ts }],
      }),
    });
  }
}
