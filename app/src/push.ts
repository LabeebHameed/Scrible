/**
 * Real push notifications & local alarm dispatch wiring (Feature 1).
 * Registers this device's push token and capabilities with the backend,
 * configures action categories ('Stop' / 'Snooze 10m'), and wires notification
 * actions back to `SyncStore` and backend APIs.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import type { ApiClient } from './api';
import type { SyncStore } from './store';
import {
  ACTION_SNOOZE,
  ACTION_STOP,
  cancelLocalAlarm,
  checkAlarmPermissions,
  setupAlarmChannelAndCategories,
  snoozeLocalAlarm,
} from './alarms';

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
  return typeof data?.reminderId === 'string'
    ? data.reminderId
    : typeof data?.itemId === 'string'
      ? data.itemId
      : null;
}

/** Request permissions, setup categories, register device capabilities, and wire action listeners. */
export async function setupPushNotifications(api: ApiClient, store?: SyncStore): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

  try {
    // 1. Setup channel & action categories
    await setupAlarmChannelAndCategories();

    // 2. Check permissions & capabilities
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.granted;
    }

    const alarmPerm = await checkAlarmPermissions();
    let pushToken: string | null = null;

    if (granted) {
      try {
        const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
        const tokenRes = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
        pushToken = tokenRes.data;
      } catch {
        // Push token unavailable (e.g. simulator)
      }
    }

    // 3. Register device with capabilities
    await api.registerDevice(Platform.OS, pushToken, {
      exactAlarms: alarmPerm.canScheduleExact,
      notificationsGranted: granted,
    });
  } catch {
    // Platform push registration error
  }

  // 4. Handle Notification Action & Tap Interactions (Stop, Snooze, Tap)
  const handleResponse = async (response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    const reminderId = reminderIdFrom(response);
    const actionIdentifier = response.actionIdentifier;

    if (!reminderId) return;

    if (actionIdentifier === ACTION_STOP) {
      // STOP action: mark seen on backend & complete in local store
      void api.markReminderSeen(reminderId).catch(() => {});
      void cancelLocalAlarm(reminderId);
      if (store) {
        void store.complete(reminderId);
      }
    } else if (actionIdentifier === ACTION_SNOOZE) {
      // SNOOZE action: snooze on backend & reschedule local alarm for 10 minutes from now
      void api.snoozeReminder(reminderId, 10).catch(() => {});
      void snoozeLocalAlarm(reminderId, response.notification.request.content.title ?? undefined, 10);
    } else {
      // General tap: mark seen on backend
      void api.markReminderSeen(reminderId).catch(() => {});
    }
  };

  // Cold start tap / notification response
  void Notifications.getLastNotificationResponseAsync().then(handleResponse);

  // Background / Foreground interaction listener
  Notifications.addNotificationResponseReceivedListener(handleResponse);
}
