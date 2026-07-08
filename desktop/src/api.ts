/** Lean typed client for the Scrible backend (desktop needs only these calls). */
import type { TriggerItem } from './matcher';

export interface ItemChange {
  seq: number;
  entityType: string;
  entityId: string;
  op: 'upsert' | 'delete';
  data: (TriggerItem & Record<string, unknown>) | null;
}

export class DesktopApi {
  constructor(
    public baseUrl: string,
    public token: string | null = null,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async login(email: string, password: string): Promise<string> {
    const res = await this.req<{ token: string }>('POST', '/v1/auth/login', { email, password });
    this.token = res.token;
    return res.token;
  }

  async registerDevice(): Promise<string> {
    const res = await this.req<{ id: string }>('POST', '/v1/devices', {
      platform: 'desktop',
      capabilities: { canWatchApps: true, canShowPopups: true },
    });
    return res.id;
  }

  /** Open app-triggered items. NOTE: no app/process names are ever sent. */
  async checkin(deviceId: string | null): Promise<TriggerItem[]> {
    const res = await this.req<{ items: TriggerItem[] }>('POST', '/v1/desktop/checkin', { deviceId });
    return res.items;
  }

  async changesSince(seq: number): Promise<{ changes: ItemChange[] }> {
    return this.req('GET', `/v1/sync/changes?since=${seq}`);
  }

  async completeItem(id: string): Promise<void> {
    await this.req('POST', `/v1/items/${id}/complete`, {});
  }

  async watcherConsent(): Promise<boolean> {
    const consents = await this.req<Record<string, { granted: boolean }>>('GET', '/v1/consents');
    return consents.app_watcher?.granted ?? false;
  }

  async grantWatcherConsent(): Promise<void> {
    await this.req('POST', '/v1/consents', { category: 'app_watcher', policyVersion: '2026-07-08' });
  }
}
