/**
 * Internal calendar provider — Scrible's own calendar store. Serves users without a
 * linked external calendar, and doubles as the provider-simulation surface for the
 * sync/conflict test suite (plan risk #2: extensive provider-simulation tests).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import type { CalendarLinkRef, CalendarProvider, ExternalEvent } from './provider.js';

export class InternalCalendarProvider implements CalendarProvider {
  name = 'internal';
  /** link.id → events; module-level store so tests can inject "external" changes. */
  private calendars = new Map<string, Map<string, ExternalEvent>>();

  constructor(private db: Db) {}

  /** Rehydrate from the cache table so internal calendars survive restarts. */
  async init(): Promise<void> {
    const rows = (await this.db
      .prepare("SELECT * FROM calendar_events WHERE id LIKE 'int-%'")
      .all()) as Array<Record<string, unknown>>;
    for (const r of rows) {
      this.upsertLocal(String(r.calendar_link_id), {
        externalId: String(r.external_id),
        title: String(r.title),
        start: Number(r.start_ts),
        end: Number(r.end_ts),
        busy: Number(r.busy) === 1,
      });
    }
  }

  private cal(linkId: string): Map<string, ExternalEvent> {
    let c = this.calendars.get(linkId);
    if (!c) this.calendars.set(linkId, (c = new Map()));
    return c;
  }
  private upsertLocal(linkId: string, event: ExternalEvent): void {
    this.cal(linkId).set(event.externalId, event);
  }

  /** Test/simulation hook: an event appearing "externally" (as if created in another app). */
  simulateExternalEvent(linkId: string, event: Omit<ExternalEvent, 'externalId'> & { externalId?: string }): string {
    const id = event.externalId ?? randomUUID();
    this.upsertLocal(linkId, { ...event, externalId: id });
    return id;
  }
  simulateExternalDeletion(linkId: string, externalId: string): void {
    this.cal(linkId).delete(externalId);
  }

  async pullEvents(link: CalendarLinkRef, windowStart: number, windowEnd: number) {
    const events = [...this.cal(link.id).values()].filter(
      (e) => e.end > windowStart && e.start < windowEnd,
    );
    return { events, syncState: { lastPull: Date.now() } };
  }
  async createEvent(link: CalendarLinkRef, event: Omit<ExternalEvent, 'externalId'>) {
    const id = randomUUID();
    this.upsertLocal(link.id, { ...event, externalId: id });
    return id;
  }
  async updateEvent(link: CalendarLinkRef, event: ExternalEvent) {
    this.upsertLocal(link.id, event);
  }
  async deleteEvent(link: CalendarLinkRef, externalId: string) {
    this.cal(link.id).delete(externalId);
  }
}
