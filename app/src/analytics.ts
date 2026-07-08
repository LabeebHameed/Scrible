/**
 * Client-side analytics emitter. Consent-gated at the SOURCE: when the analytics
 * consent is off, no request is ever made (network-audit-verifiable zero traffic).
 * The server's forwarding layer enforces the same gate and the taxonomy again.
 */
import { Platform } from 'react-native';
import type { ApiClient } from './api';

let client: ApiClient | null = null;
let enabled = false;
let queue: Array<{ name: string; props: Record<string, unknown> }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const surface = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

export function configureAnalytics(api: ApiClient, consentGranted: boolean): void {
  client = api;
  setAnalyticsEnabled(consentGranted);
}

export function setAnalyticsEnabled(value: boolean): void {
  enabled = value;
  if (!value) queue = []; // drop anything buffered the instant consent goes away
}

export function track(name: string, props: Record<string, unknown> = {}): void {
  if (!enabled || !client) return;
  queue.push({ name, props });
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 2000);
}

async function flush(): Promise<void> {
  if (!enabled || !client || queue.length === 0) return;
  const batch = queue.splice(0, 100);
  try {
    await client.sendAnalytics(batch);
  } catch {
    // Analytics never surfaces errors or retries aggressively — best effort only.
  }
}
