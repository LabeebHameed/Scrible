/**
 * Real push notifications (Expo push service — abstracts APNs/FCM). Registers this
 * device's push token with the backend and wires notification taps back to
 * `POST /v1/reminders/:id/seen` so tapping a reminder stops its re-nagging.
 *
 * Android needs an FCM v1 credential uploaded to the EAS project before a real
 * notification is actually delivered (see docs) — registration/tap-handling here
 * works regardless; delivery itself depends on that one-time external setup.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import type { ApiClient } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function reminderIdFrom(response: Notifications.NotificationResponse | null): string | null {
  const data = response?.notification.request.content.data as Record<string, unknown> | undefined;
  return typeof data?.reminderId === 'string' ? data.reminderId : null;
}

/** Request permission, register this device's push token, and wire tap → seen. */
export async function setupPushNotifications(api: ApiClient): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

  try {
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.granted;
    }
    if (!granted) return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await api.registerDevice(Platform.OS, token.data);
  } catch {
    // Push isn't available (simulator, missing credentials, etc.) — the app works
    // fine without it, this just means no real notification arrives.
  }

  const ack = (response: Notifications.NotificationResponse | null) => {
    const reminderId = reminderIdFrom(response);
    if (reminderId) void api.markReminderSeen(reminderId).catch(() => {});
  };

  // Cold start: the app may have been launched by tapping a notification.
  void Notifications.getLastNotificationResponseAsync().then(ack);
  // Warm/background: the app was already running.
  Notifications.addNotificationResponseReceivedListener(ack);
}
