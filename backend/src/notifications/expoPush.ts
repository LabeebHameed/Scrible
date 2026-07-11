/**
 * Real push delivery via Expo's push service — abstracts APNs/FCM so the app only
 * ever deals with an "Expo push token" (registered via POST /v1/devices, same as
 * any other device). No SDK needed: it's a single POST to a public HTTPS endpoint.
 *
 * Android requires an FCM v1 service-account credential uploaded to the EAS project
 * (`eas credentials`) before Expo can actually hand pushes off to Google — without
 * it, Expo's API accepts the request but the notification never reaches the device.
 * That's a one-time external setup step, not something this code can do.
 */
import type { PushSender, PushSendOpts } from './index.js';

export class ExpoPushSender implements PushSender {
  channel = 'expo-push';

  supports(platform: string): boolean {
    return platform === 'ios' || platform === 'android';
  }

  async send(deviceToken: string | null, title: string, body: string, opts?: PushSendOpts): Promise<void> {
    if (!deviceToken) return;
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        to: deviceToken,
        title,
        body,
        sound: 'default',
        priority: 'high',
        data: opts?.data ?? {},
        ...(opts?.categoryId ? { categoryId: opts.categoryId } : {}),
      }),
    });
    if (!res.ok) {
      // Diagnostic only — never transcript text, never the token beyond what Expo
      // itself already has. Without this, a bad/expired token fails silently.
      const detail = await res.text().catch(() => '');
      console.error(`expo push http ${res.status}: ${detail.slice(0, 300)}`);
    }
  }
}
