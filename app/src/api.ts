/** Thin typed client for the Scrible backend API v1. */
import type { ChangeRow, Item, SyncOp } from './types';

export interface RoutineBlock {
  label: string;
  days?: number[];
  startHour: number;
  endHour?: number;
}

export interface DeviceView {
  id: string;
  platform: string;
  hasPushToken: boolean;
  lastSeen: number;
  createdAt: number;
}

export interface ScheduleBlock {
  id: string;
  itemId: string;
  start: number;
  end: number;
  state: string;
  rationale: string | null;
  external: boolean;
}

export interface CalendarLink {
  id: string;
  provider: string;
  accountId: string;
}

export interface ReminderView {
  id: string;
  itemId: string;
  title: string;
  fireAt: number;
  recurrence: string | null;
  snoozedUntil: number | null;
  deliveredAt: number | null;
  seenAt: number | null;
}

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
  setTimezone(timezone: string): Promise<void>;
  getConsents(): Promise<Record<string, { granted: boolean }>>;
  grantConsent(category: string): Promise<void>;
  revokeConsent(category: string): Promise<void>;
  deleteAccount(): Promise<{ confirmation: string }>;
  undoBlock(blockId: string): Promise<void>;
  getProfile(): Promise<ProfileView | null>;
  patchProfile(edits: Record<string, unknown>): Promise<void>;
  deleteProfile(): Promise<{ confirmation: string }>;
  deleteRoutine(label: string): Promise<void>;
  importChats(source: string, content: string): Promise<{ profile: Record<string, unknown> }>;
  sendAnalytics(events: Array<{ name: string; props: Record<string, unknown> }>): Promise<void>;
  registerDevice(platform: string, pushToken: string, deviceId?: string, localAlarms?: boolean): Promise<{ id: string }>;
  getDevices(): Promise<DeviceView[]>;
  reminders(): Promise<ReminderView[]>;
  markReminderSeen(reminderId: string): Promise<void>;
  snoozeReminder(reminderId: string, minutes: number): Promise<void>;
  getCalendarLinks(): Promise<CalendarLink[]>;
  getSchedule(): Promise<ScheduleBlock[]>;
}

export interface ProfileView {
  attributes: {
    tone?: string;
    verbosity?: string;
    decompositionGranularity?: string;
    vocabulary?: string[];
    routines?: RoutineBlock[];
  };
  overrides: Record<string, unknown>;
  sources: string[];
  storage: string;
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
  async setTimezone(timezone: string) {
    // Without this every fuzzy time ("after work", "at 12") resolves in the server's
    // clock (UTC), 5:30 off for IST users — the "asked at 12, set for 6:32" bug.
    await this.req('PATCH', '/v1/me', { timezone });
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
  async undoBlock(blockId: string) {
    await this.req('POST', `/v1/schedule/${blockId}/undo`);
  }
  async getProfile() {
    try {
      return await this.req<ProfileView>('GET', '/v1/profile');
    } catch {
      return null;
    }
  }
  async patchProfile(edits: Record<string, unknown>) {
    await this.req('PATCH', '/v1/profile', edits);
  }
  async deleteProfile() {
    return this.req<{ confirmation: string }>('DELETE', '/v1/profile');
  }
  async deleteRoutine(label: string) {
    await this.req('DELETE', `/v1/profile/routines/${encodeURIComponent(label)}`);
  }
  async importChats(source: string, content: string) {
    return this.req<{ profile: Record<string, unknown> }>('POST', '/v1/imports', { source, content });
  }
  async sendAnalytics(events: Array<{ name: string; props: Record<string, unknown> }>) {
    await this.req('POST', '/v1/analytics/events', { events });
  }
  async registerDevice(platform: string, pushToken: string, deviceId?: string, localAlarms = false) {
    // localAlarms means this device VERIFIABLY rings reminders itself (exact alarms
    // enabled — see src/alarms.ts); the server then skips the first push to it so
    // the user isn't double-alerted. Claiming it without verification means a missing
    // Android permission turns into total silence — never send true optimistically.
    return this.req<{ id: string }>('POST', '/v1/devices', {
      platform,
      pushToken,
      deviceId,
      capabilities: { localAlarms },
    });
  }
  async getDevices() {
    return this.req<DeviceView[]>('GET', '/v1/devices');
  }
  async reminders() {
    return this.req<ReminderView[]>('GET', '/v1/reminders');
  }
  async markReminderSeen(reminderId: string) {
    await this.req('POST', `/v1/reminders/${reminderId}/seen`);
  }
  async snoozeReminder(reminderId: string, minutes: number) {
    await this.req('POST', `/v1/reminders/${reminderId}/snooze`, { minutes });
  }
  async getCalendarLinks() {
    return this.req<CalendarLink[]>('GET', '/v1/calendar/links');
  }
  async getSchedule() {
    return this.req<ScheduleBlock[]>('GET', '/v1/schedule');
  }
}
