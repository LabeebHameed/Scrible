/**
 * Google Calendar adapter (REST v3, incremental sync via syncToken).
 * Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET for the OAuth flow; the adapter
 * itself only needs the stored token material on the link.
 */
import type { CalendarLinkRef, CalendarProvider, ExternalEvent } from './provider.js';

const API = 'https://www.googleapis.com/calendar/v3';

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry?: number;
}

export class GoogleCalendarProvider implements CalendarProvider {
  name = 'google';
  /** Called when a token refresh produces new material to persist (re-encrypted by caller). */
  onTokensRefreshed: ((linkId: string, tokens: string) => void) | null = null;

  private async accessToken(link: CalendarLinkRef): Promise<string> {
    const tokens = JSON.parse(link.tokens) as GoogleTokens;
    if (tokens.expiry && tokens.expiry - 60_000 > Date.now()) return tokens.access_token;
    if (!tokens.refresh_token) return tokens.access_token;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`google token refresh failed: ${res.status}`);
    const fresh = (await res.json()) as { access_token: string; expires_in: number };
    const updated: GoogleTokens = {
      ...tokens,
      access_token: fresh.access_token,
      expiry: Date.now() + fresh.expires_in * 1000,
    };
    this.onTokensRefreshed?.(link.id, JSON.stringify(updated));
    return updated.access_token;
  }

  private async api<T>(link: CalendarLinkRef, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken(link);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 410) throw new SyncTokenExpired();
    if (!res.ok) throw new Error(`google api ${res.status}`);
    return (await res.json().catch(() => ({}))) as T;
  }

  async pullEvents(
    link: CalendarLinkRef,
    windowStart: number,
    windowEnd: number,
  ): Promise<{ events: ExternalEvent[]; syncState: Record<string, unknown> }> {
    const calId = encodeURIComponent(link.accountId || 'primary');
    const syncToken = link.syncState.syncToken as string | undefined;
    const events: ExternalEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    try {
      do {
        const params = new URLSearchParams({ maxResults: '250', singleEvents: 'true' });
        if (pageToken) params.set('pageToken', pageToken);
        if (syncToken) params.set('syncToken', syncToken);
        else {
          params.set('timeMin', new Date(windowStart).toISOString());
          params.set('timeMax', new Date(windowEnd).toISOString());
        }
        const page = await this.api<{
          items?: Array<Record<string, any>>;
          nextPageToken?: string;
          nextSyncToken?: string;
        }>(link, 'GET', `/calendars/${calId}/events?${params}`);
        for (const it of page.items ?? []) {
          const start = Date.parse(it.start?.dateTime ?? it.start?.date ?? '');
          const end = Date.parse(it.end?.dateTime ?? it.end?.date ?? '');
          events.push({
            externalId: String(it.id),
            title: String(it.summary ?? ''),
            start,
            end,
            busy: it.transparency !== 'transparent',
            deleted: it.status === 'cancelled',
          });
        }
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
    } catch (err) {
      if (err instanceof SyncTokenExpired) {
        // Cursor invalidated — caller retries with a full-window pull.
        return this.pullEvents({ ...link, syncState: {} }, windowStart, windowEnd);
      }
      throw err;
    }
    return { events, syncState: { ...link.syncState, syncToken: nextSyncToken } };
  }

  async createEvent(link: CalendarLinkRef, event: Omit<ExternalEvent, 'externalId'>) {
    const calId = encodeURIComponent(link.accountId || 'primary');
    const created = await this.api<{ id: string }>(link, 'POST', `/calendars/${calId}/events`, {
      summary: event.title,
      start: { dateTime: new Date(event.start).toISOString() },
      end: { dateTime: new Date(event.end).toISOString() },
      transparency: event.busy ? 'opaque' : 'transparent',
      source: { title: 'Scrible', url: 'https://scrible.app' },
    });
    return created.id;
  }

  async updateEvent(link: CalendarLinkRef, event: ExternalEvent) {
    const calId = encodeURIComponent(link.accountId || 'primary');
    await this.api(link, 'PATCH', `/calendars/${calId}/events/${encodeURIComponent(event.externalId)}`, {
      summary: event.title,
      start: { dateTime: new Date(event.start).toISOString() },
      end: { dateTime: new Date(event.end).toISOString() },
    });
  }

  async deleteEvent(link: CalendarLinkRef, externalId: string) {
    const calId = encodeURIComponent(link.accountId || 'primary');
    await this.api(link, 'DELETE', `/calendars/${calId}/events/${encodeURIComponent(externalId)}`);
  }
}

class SyncTokenExpired extends Error {
  constructor() {
    super('sync token expired');
  }
}
