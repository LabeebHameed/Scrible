/** Thin typed client for the Scrible backend API v1. */
import type { ChangeRow, Item, SyncOp } from './types';

export interface ApiClient {
  signup(email: string, password: string): Promise<{ token: string }>;
  login(email: string, password: string): Promise<{ token: string }>;
  pushOps(ops: SyncOp[]): Promise<Array<{ opId: string; status: string }>>;
  changesSince(seq: number): Promise<{ changes: ChangeRow[]; latest: number }>;
  voiceDone(utterance: string): Promise<{
    completed: Item | null;
    candidates?: Item[];
    message: string;
  }>;
  getConsents(): Promise<Record<string, { granted: boolean }>>;
  grantConsent(category: string): Promise<void>;
  revokeConsent(category: string): Promise<void>;
  deleteAccount(): Promise<{ confirmation: string }>;
}

export class HttpApi implements ApiClient {
  token: string | null = null;
  constructor(public baseUrl: string) {}

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

  async signup(email: string, password: string) {
    return this.req<{ token: string }>('POST', '/v1/auth/signup', { email, password });
  }
  async login(email: string, password: string) {
    return this.req<{ token: string }>('POST', '/v1/auth/login', { email, password });
  }
  async pushOps(ops: SyncOp[]) {
    const r = await this.req<{ results: Array<{ opId: string; status: string }> }>(
      'POST',
      '/v1/sync/ops',
      { ops },
    );
    return r.results;
  }
  async changesSince(seq: number) {
    return this.req<{ changes: ChangeRow[]; latest: number }>(
      'GET',
      `/v1/sync/changes?since=${seq}`,
    );
  }
  async voiceDone(utterance: string) {
    return this.req<{ completed: Item | null; candidates?: Item[]; message: string }>(
      'POST',
      '/v1/voice/done',
      { utterance },
    );
  }
  async getConsents() {
    return this.req<Record<string, { granted: boolean }>>('GET', '/v1/consents');
  }
  async grantConsent(category: string) {
    await this.req('POST', '/v1/consents', { category, policyVersion: '2026-07-07' });
  }
  async revokeConsent(category: string) {
    await this.req('POST', `/v1/consents/${category}/revoke`);
  }
  async deleteAccount() {
    return this.req<{ confirmation: string }>('DELETE', '/v1/me');
  }
}
