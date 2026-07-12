/**
 * Real push notifications (Expo push service — abstracts APNs/FCM). Registers this
 * device's push token with the backend and wires notification taps back to
 * `POST /v1/reminders/:id/seen` so tapping a reminder stops its re-nagging.
 *
 * Reminders use a 'reminder' notification category with explicit Stop/Snooze
 * actions (alarm-like: an explicit choice, not just swiping the notification away)
 * — see REMINDER_CATEGORY below.
 *
 * Android needs an FCM v1 credential uploaded to the EAS project, AND a
 * google-services.json baked into the build (app.json `android.googleServicesFile`)
 * before a real notification is actually delivered — registration/tap-handling here
 * works regardless; delivery itself depends on that one-time external setup.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import type { ApiClient } from './api';

const DEVICE_ID_KEY = 'scrible.deviceId';
const REMINDER_CATEGORY = 'reminder';
const SNOOZE_MINUTES = 10;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushStatus =
  | { state: 'registered' }
  | { state: 'unsupported' }
  | { state: 'no-permission' }
  | { state: 'failed'; reason: string };

function reminderIdFrom(response: Notifications.NotificationResponse | null): string | null {
  const data = response?.notification.request.content.data as Record<string, unknown> | undefined;
  return typeof data?.reminderId === 'string' ? data.reminderId : null;
}

/** Request permission, register this device's push token, and wire tap/Stop/Snooze.
 * `localAlarms` must only be true when exact local alarms are VERIFIED working. */
export async function setupPushNotifications(api: ApiClient, localAlarms = false): Promise<PushStatus> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return { state: 'unsupported' };

  let status: PushStatus;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
      });
    }
    // Explicit Stop/Snooze buttons on reminder notifications, instead of relying on
    // an ambiguous swipe-to-dismiss — matches "alarm" behavior: you choose, it
    // doesn't just quietly go away.
    await Notifications.setNotificationCategoryAsync(REMINDER_CATEGORY, [
      { identifier: 'STOP', buttonTitle: 'Stop' },
      { identifier: 'SNOOZE', buttonTitle: `Snooze ${SNOOZE_MINUTES}m` },
    ]);

    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.granted;
    }
    if (!granted) {
      status = { state: 'no-permission' };
    } else {
      const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
      const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      const deviceId = (await AsyncStorage.getItem(DEVICE_ID_KEY)) ?? undefined;
      const res = await api.registerDevice(Platform.OS, token.data, deviceId, localAlarms);
      if (!deviceId) await AsyncStorage.setItem(DEVICE_ID_KEY, res.id);
      status = { state: 'registered' };
    }
  } catch (err) {
    // Surfaced to the user via Settings — a silent catch here is exactly why
    // "notifications don't arrive" was previously undiagnosable.
    status = { state: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }

  const ack = (response: Notifications.NotificationResponse | null) => {
    const reminderId = reminderIdFrom(response);
    if (!reminderId) return;
    if (response?.actionIdentifier === 'SNOOZE') {
      // Re-arms delivery later server-side; must NOT also mark seen, or it would
      // never re-fire (see backend ReminderScheduler.snooze).
      void api.snoozeReminder(reminderId, SNOOZE_MINUTES).catch(() => {});
    } else {
      // Plain tap or the explicit Stop action — both mean "dealt with".
      void api.markReminderSeen(reminderId).catch(() => {});
    }
  };

  // Cold start: the app may have been launched by tapping a notification.
  void Notifications.getLastNotificationResponseAsync().then(ack);
  // Warm/background: the app was already running.
  Notifications.addNotificationResponseReceivedListener(ack);

  return status;
}
