/**
 * Microsoft Outlook adapter (Graph API, incremental sync via calendarView/delta).
 * Requires MS_CLIENT_ID / MS_CLIENT_SECRET for the OAuth flow.
 */
import type { CalendarLinkRef, CalendarProvider, ExternalEvent } from './provider.js';

const API = 'https://graph.microsoft.com/v1.0';

interface MsTokens {
  access_token: string;
  refresh_token?: string;
  expiry?: number;
}

export class OutlookCalendarProvider implements CalendarProvider {
  name = 'outlook';
  onTokensRefreshed: ((linkId: string, tokens: string) => void) | null = null;

  private async accessToken(link: CalendarLinkRef): Promise<string> {
    const tokens = JSON.parse(link.tokens) as MsTokens;
    if (tokens.expiry && tokens.expiry - 60_000 > Date.now()) return tokens.access_token;
    if (!tokens.refresh_token) return tokens.access_token;
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID ?? '',
        client_secret: process.env.MS_CLIENT_SECRET ?? '',
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
        scope: 'offline_access Calendars.ReadWrite',
      }),
    });
    if (!res.ok) throw new Error(`outlook token refresh failed: ${res.status}`);
    const fresh = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const updated: MsTokens = {
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token ?? tokens.refresh_token,
      expiry: Date.now() + fresh.expires_in * 1000,
    };
    this.onTokensRefreshed?.(link.id, JSON.stringify(updated));
    return updated.access_token;
  }

  private async api<T>(link: CalendarLinkRef, method: string, url: string, body?: unknown): Promise<T> {
    const token = await this.accessToken(link);
    const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 410) throw new DeltaExpired();
    if (!res.ok) throw new Error(`graph api ${res.status}`);
    return (await res.json().catch(() => ({}))) as T;
  }

  async pullEvents(
    link: CalendarLinkRef,
    windowStart: number,
    windowEnd: number,
  ): Promise<{ events: ExternalEvent[]; syncState: Record<string, unknown> }> {
    const events: ExternalEvent[] = [];
    let url =
      (link.syncState.deltaLink as string | undefined) ??
      `${API}/me/calendarView/delta?startDateTime=${new Date(windowStart).toISOString()}&endDateTime=${new Date(windowEnd).toISOString()}`;
    let deltaLink: string | undefined;
    try {
      while (url) {
        const page = await this.api<{
          value?: Array<Record<string, any>>;
          '@odata.nextLink'?: string;
          '@odata.deltaLink'?: string;
        }>(link, 'GET', url);
        for (const it of page.value ?? []) {
          events.push({
            externalId: String(it.id),
            title: String(it.subject ?? ''),
            start: Date.parse(it.start?.dateTime ? `${it.start.dateTime}Z` : ''),
            end: Date.parse(it.end?.dateTime ? `${it.end.dateTime}Z` : ''),
            busy: it.showAs !== 'free',
            deleted: Boolean(it['@removed']),
          });
        }
        deltaLink = page['@odata.deltaLink'] ?? deltaLink;
        url = page['@odata.nextLink'] ?? '';
      }
    } catch (err) {
      if (err instanceof DeltaExpired) {
        return this.pullEvents({ ...link, syncState: {} }, windowStart, windowEnd);
      }
      throw err;
    }
    return { events, syncState: { ...link.syncState, deltaLink } };
  }

  async createEvent(link: CalendarLinkRef, event: Omit<ExternalEvent, 'externalId'>) {
    const created = await this.api<{ id: string }>(link, 'POST', '/me/events', {
      subject: event.title,
      start: { dateTime: new Date(event.start).toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(event.end).toISOString(), timeZone: 'UTC' },
      showAs: event.busy ? 'busy' : 'free',
    });
    return created.id;
  }

  async updateEvent(link: CalendarLinkRef, event: ExternalEvent) {
    await this.api(link, 'PATCH', `/me/events/${encodeURIComponent(event.externalId)}`, {
      subject: event.title,
      start: { dateTime: new Date(event.start).toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(event.end).toISOString(), timeZone: 'UTC' },
    });
  }

  async deleteEvent(link: CalendarLinkRef, externalId: string) {
    await this.api(link, 'DELETE', `/me/events/${encodeURIComponent(externalId)}`);
  }
}

class DeltaExpired extends Error {
  constructor() {
    super('delta link expired');
  }
}
