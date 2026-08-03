/**
 * Calendar provider boundary (build plan §7.1). Each provider adapts one external
 * calendar API to this interface; the sync engine is provider-agnostic.
 */

export interface ExternalEvent {
  externalId: string;
  title: string;
  start: number;
  end: number;
  busy: boolean;
  deleted?: boolean;
}

export interface CalendarLinkRef {
  id: string;
  userId: string;
  provider: string;
  accountId: string;
  /** Decrypted provider token material (JSON string). */
  tokens: string;
  syncState: Record<string, unknown>;
}

export interface CalendarProvider {
  name: string;
  /**
   * Pull changes since the provider cursor in syncState. Returns current events in
   * the window plus an updated syncState (cursor/tokens for incremental sync).
   */
  pullEvents(
    link: CalendarLinkRef,
    windowStart: number,
    windowEnd: number,
  ): Promise<{ events: ExternalEvent[]; syncState: Record<string, unknown> }>;
  createEvent(link: CalendarLinkRef, event: Omit<ExternalEvent, 'externalId'>): Promise<string>;
  updateEvent(link: CalendarLinkRef, event: ExternalEvent): Promise<void>;
  deleteEvent(link: CalendarLinkRef, externalId: string): Promise<void>;
}

export class ProviderRegistry {
  private providers = new Map<string, CalendarProvider>();
  register(p: CalendarProvider): void {
    this.providers.set(p.name, p);
  }
  get(name: string): CalendarProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`unknown calendar provider: ${name}`);
    return p;
  }
}
