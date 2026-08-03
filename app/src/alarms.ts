/**
 * Local Alarm & Reminder Engine (Feature 1 - Reminders & Alarms).
 *
 * Directs on-device exact alarm scheduling using `expo-notifications`.
 * Works offline, when app is killed, and across lockscreen takeovers.
 * Configures notification action categories ('STOP', 'SNOOZE 10M') and high-priority
 * Android notification channels.
 */
let PlatformOS: string = 'web';
let openSettingsFn: (() => Promise<void>) | null = null;
let NotificationsModule: typeof import('expo-notifications') | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RN = require('react-native');
  if (RN && RN.Platform) PlatformOS = RN.Platform.OS;
  if (RN && RN.Linking) openSettingsFn = () => RN.Linking.openSettings();
} catch {
  // Pure Node test environment
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  NotificationsModule = require('expo-notifications');
} catch {
  // Pure Node test environment
}

import type { Item } from './types';

export const ALARM_CHANNEL_ID = 'scrible_alarms';
export const REMINDER_CATEGORY_ID = 'scrible_reminder';
export const ACTION_STOP = 'STOP';
export const ACTION_SNOOZE = 'SNOOZE';

export interface AlarmPermissionStatus {
  granted: boolean;
  canScheduleExact: boolean;
  platform: string;
}

/** Configures the high-importance Android channel & notification action categories. */
export async function setupAlarmChannelAndCategories(): Promise<void> {
  if (PlatformOS !== 'ios' && PlatformOS !== 'android') return;
  if (!NotificationsModule) return;

  try {
    // 1. Configure Android Notification Channel for alarm ringing
    if (PlatformOS === 'android') {
      await NotificationsModule.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
        name: 'Alarms & Urgent Reminders',
        importance: NotificationsModule.AndroidImportance.MAX,
        sound: 'default', // Fallback to system default alarm sound
        enableVibrate: true,
        vibrationPattern: [0, 500, 250, 500, 250, 500],
        enableLights: true,
        lockscreenVisibility: NotificationsModule.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
      });
    }

    // 2. Configure Notification Action Categories (Stop & Snooze 10m)
    await NotificationsModule.setNotificationCategoryAsync(REMINDER_CATEGORY_ID, [
      {
        identifier: ACTION_STOP,
        buttonTitle: 'Stop',
        options: {
          isDestructive: true,
          opensAppToForeground: false,
        },
      },
      {
        identifier: ACTION_SNOOZE,
        buttonTitle: 'Snooze 10m',
        options: {
          isAuthenticationRequired: false,
          opensAppToForeground: false,
        },
      },
    ]);
  } catch (err) {
    // Channel / Category setup failed on unsupported platform
  }
}

/** Check exact alarm & notification permissions on this device. */
export async function checkAlarmPermissions(): Promise<AlarmPermissionStatus> {
  if (PlatformOS !== 'ios' && PlatformOS !== 'android') {
    return { granted: false, canScheduleExact: false, platform: PlatformOS };
  }
  if (!NotificationsModule) {
    return { granted: false, canScheduleExact: false, platform: PlatformOS };
  }

  try {
    const perm = await NotificationsModule.getPermissionsAsync();
    // On Android 12+ (API 31+), check exact alarms permission status if available
    const canScheduleExact =
      PlatformOS === 'android'
        ? ((perm as unknown as Record<string, boolean>).canScheduleExactAlarms ?? perm.granted)
        : perm.granted;

    return {
      granted: perm.granted,
      canScheduleExact,
      platform: PlatformOS,
    };
  } catch {
    return { granted: false, canScheduleExact: false, platform: PlatformOS };
  }
}

/** Open OS alarm/notification settings page. */
export async function openAlarmSettings(): Promise<void> {
  try {
    if (PlatformOS === 'ios' || PlatformOS === 'android') {
      await openSettingsFn?.();
    }
  } catch {
    // Unable to open settings
  }
}

/** Schedules a local exact alarm for an item if it has a valid future time. */
export async function scheduleLocalAlarm(item: Item): Promise<string | null> {
  if (PlatformOS !== 'ios' && PlatformOS !== 'android') return null;
  if (!NotificationsModule) return null;

  const targetTs = item.timeIntent?.at;
  if (!targetTs || item.status === 'done' || item.status === 'dismissed') {
    return null;
  }

  // Ensure target timestamp is in the future
  const now = Date.now();
  if (targetTs <= now) return null;

  const title = item.summary || item.title || 'Scrible Reminder';
  const body = item.rawText || title;

  try {
    // Cancel any existing scheduled notification for this item first
    await cancelLocalAlarm(item.id);

    const notificationId = await NotificationsModule.scheduleNotificationAsync({
      identifier: `reminder_${item.id}`,
      content: {
        title,
        body,
        sound: true,
        priority: NotificationsModule.AndroidNotificationPriority.MAX,
        categoryIdentifier: REMINDER_CATEGORY_ID,
        data: { reminderId: item.id, itemId: item.id },
      },
      trigger: {
        type: NotificationsModule.SchedulableTriggerInputTypes.DATE,
        date: new Date(targetTs),
        channelId: ALARM_CHANNEL_ID,
      },
    });

    return notificationId;
  } catch (err) {
    console.error(`[Alarms] Failed to schedule local alarm for ${item.id}:`, err);
    return null;
  }
}

/** Reschedules an alarm for 10 minutes from now (Snooze). */
export async function snoozeLocalAlarm(itemId: string, title?: string, minutes: number = 10): Promise<string | null> {
  if (PlatformOS !== 'ios' && PlatformOS !== 'android') return null;
  if (!NotificationsModule) return null;

  const targetTs = Date.now() + minutes * 60_000;
  try {
    await cancelLocalAlarm(itemId);
    return await NotificationsModule.scheduleNotificationAsync({
      identifier: `reminder_${itemId}`,
      content: {
        title: title || 'Scrible Reminder (Snoozed)',
        body: `Snoozed reminder from earlier`,
        sound: true,
        priority: NotificationsModule.AndroidNotificationPriority.MAX,
        categoryIdentifier: REMINDER_CATEGORY_ID,
        data: { reminderId: itemId, itemId },
      },
      trigger: {
        type: NotificationsModule.SchedulableTriggerInputTypes.DATE,
        date: new Date(targetTs),
        channelId: ALARM_CHANNEL_ID,
      },
    });
  } catch (err) {
    return null;
  }
}

/** Cancels a pending local alarm for an item. */
export async function cancelLocalAlarm(itemId: string): Promise<void> {
  if (PlatformOS !== 'ios' && PlatformOS !== 'android') return;
  if (!NotificationsModule) return;
  try {
    await NotificationsModule.cancelScheduledNotificationAsync(`reminder_${itemId}`);
  } catch {
    // Ignored if notification wasn't scheduled
  }
}

/** Syncs all items in store to ensure local exact alarms match active items. */
export async function syncStoreLocalAlarms(items: Record<string, Item>): Promise<void> {
  if (PlatformOS !== 'ios' && PlatformOS !== 'android') return;
  if (!NotificationsModule) return;

  const now = Date.now();
  for (const item of Object.values(items)) {
    const targetTs = item.timeIntent?.at;
    if (item.status === 'done' || item.status === 'dismissed' || !targetTs || targetTs <= now) {
      await cancelLocalAlarm(item.id);
    } else if (item.type === 'reminder' || targetTs > now) {
      await scheduleLocalAlarm(item);
    }
  }
}
