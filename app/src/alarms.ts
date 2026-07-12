/**
 * Real offline alarms. Reminders synced from the server are scheduled ON this
 * device via react-native-notify-kit (AlarmManager exact triggers — fire through
 * Doze, survive reboot, need no network at ring time) and ring like a clock alarm:
 * full-screen over the lockscreen, looping sound, Stop + Snooze buttons that work
 * with the app killed (onBackgroundEvent in index.ts).
 *
 * Android 13/14 denies SCHEDULE_EXACT_ALARM by default and notify-kit THROWS when
 * scheduling an exact trigger without it — the original silent catch here turned
 * that into "the alarm just never rang". Now: the permission is checked and prompted
 * (openAlarmPermissionSettings), scheduling falls back per-trigger to an inexact
 * (WorkManager) trigger that still rings, and the status is surfaced in Settings.
 *
 * The server is only told this device rings its own alarms
 * (capabilities.localAlarms) when exact alarms are VERIFIED enabled — otherwise the
 * server keeps pushing at fire time, so a missing permission can never mean silence.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiClient, ReminderView } from './api';
import { HttpApi } from './api';

const CHANNEL_ID = 'scrible-alarm';
const ID_PREFIX = 'rem-';
const SNOOZE_MINUTES = 10;
const ALARM_PROMPT_KEY = 'scrible.alarmPromptShown';

export type AlarmStatus =
  | { state: 'exact' }
  | { state: 'inexact' }
  | { state: 'unsupported' }
  | { state: 'error'; reason: string };

let currentStatus: AlarmStatus = { state: 'unsupported' };
export function getAlarmStatus(): AlarmStatus {
  return currentStatus;
}

async function kit() {
  const mod = await import('react-native-notify-kit');
  return mod;
}

async function exactAlarmsEnabled(): Promise<boolean> {
  const { default: notifee, AndroidNotificationSetting } = await kit();
  const settings = await notifee.getNotificationSettings();
  // NOT_SUPPORTED (Android < 12) means no permission gate exists — exact works.
  return settings.android.alarm !== AndroidNotificationSetting.DISABLED;
}

/** Open the system "Alarms & reminders" screen so the user can allow exact alarms. */
export async function requestExactAlarms(): Promise<void> {
  try {
    const { default: notifee } = await kit();
    await notifee.openAlarmPermissionSettings();
  } catch {
    /* module unavailable */
  }
}

/** One-time setup: alarm channel + permissions. Returns the alarm capability. */
export async function setupAlarms(): Promise<AlarmStatus> {
  if (Platform.OS !== 'android') return (currentStatus = { state: 'unsupported' });
  try {
    const { default: notifee, AndroidImportance } = await kit();
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Reminders (alarm)',
      importance: AndroidImportance.HIGH,
      sound: 'default',
    });
    await notifee.requestPermission();

    if (await exactAlarmsEnabled()) {
      currentStatus = { state: 'exact' };
    } else {
      currentStatus = { state: 'inexact' };
      // Send the user to the system toggle once, not on every launch.
      const prompted = await AsyncStorage.getItem(ALARM_PROMPT_KEY);
      if (!prompted) {
        await AsyncStorage.setItem(ALARM_PROMPT_KEY, '1');
        await requestExactAlarms();
      }
    }
  } catch (err) {
    currentStatus = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  return currentStatus;
}

async function scheduleOne(
  notifee: Awaited<ReturnType<typeof kit>>['default'],
  extras: Pick<Awaited<ReturnType<typeof kit>>, 'AndroidCategory' | 'AndroidImportance' | 'TriggerType'>,
  id: string,
  title: string,
  fireAt: number,
  exact: boolean,
): Promise<void> {
  const { AndroidCategory, AndroidImportance, TriggerType } = extras;
  await notifee.createTriggerNotification(
    {
      id,
      title: 'Scrible',
      body: title,
      data: { reminderId: id.slice(ID_PREFIX.length) },
      android: {
        channelId: CHANNEL_ID,
        category: AndroidCategory.ALARM,
        importance: AndroidImportance.HIGH,
        sound: 'default',
        loopSound: true,
        // Rings over the lockscreen like a clock alarm.
        fullScreenAction: { id: 'default' },
        pressAction: { id: 'default' },
        actions: [
          { title: 'Stop', pressAction: { id: 'stop' } },
          { title: `Snooze ${SNOOZE_MINUTES}m`, pressAction: { id: 'snooze' } },
        ],
      },
    },
    exact
      ? { type: TriggerType.TIMESTAMP, timestamp: fireAt, alarmManager: { allowWhileIdle: true } }
      : { type: TriggerType.TIMESTAMP, timestamp: fireAt },
  );
}

/**
 * Reconcile local alarms with server truth. Idempotent: cancels every alarm we own
 * and recreates from the pending set. Exact when permitted; inexact (WorkManager —
 * may ring minutes late, but RINGS) as the per-trigger fallback. Never silent:
 * failures land in the status shown in Settings.
 */
export async function syncAlarms(api: ApiClient): Promise<AlarmStatus> {
  if (Platform.OS !== 'android') return currentStatus;
  try {
    const { default: notifee, ...extras } = await kit();
    const due = await api.reminders();
    const pending = due.filter((r: ReminderView) => !r.seenAt && r.fireAt > Date.now());

    const exact = await exactAlarmsEnabled();
    const existing = await notifee.getTriggerNotificationIds();
    await Promise.all(
      existing.filter((id) => id.startsWith(ID_PREFIX)).map((id) => notifee.cancelTriggerNotification(id)),
    );
    let failures = 0;
    for (const r of pending) {
      try {
        await scheduleOne(notifee, extras, `${ID_PREFIX}${r.id}`, r.title, r.fireAt, exact);
      } catch {
        try {
          await scheduleOne(notifee, extras, `${ID_PREFIX}${r.id}`, r.title, r.fireAt, false);
        } catch {
          failures++;
        }
      }
    }
    currentStatus =
      failures > 0
        ? { state: 'error', reason: `${failures} alarm${failures === 1 ? '' : 's'} could not be scheduled` }
        : exact
          ? { state: 'exact' }
          : { state: 'inexact' };
  } catch (err) {
    // Offline is normal (previously scheduled alarms still ring) — only surface
    // real scheduling errors, not network blips.
    if (!(err instanceof TypeError)) {
      currentStatus = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return currentStatus;
}

/**
 * Stop/Snooze/tap handling — shared by the foreground handler (App.tsx) and the
 * background handler (index.ts, runs with the app killed). `apiOrNull` is null in
 * the killed-app case; we then rebuild a client from persisted state.
 */
export async function handleAlarmEvent(
  type: number,
  detail: { notification?: { id?: string; body?: string; data?: Record<string, unknown> }; pressAction?: { id: string } },
  apiOrNull: ApiClient | null,
): Promise<void> {
  const reminderId = detail.notification?.data?.reminderId;
  if (typeof reminderId !== 'string' || !reminderId) return;
  const { default: notifee, EventType, ...extras } = await kit();
  if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;

  const api = apiOrNull ?? (await headlessApi());
  const action = detail.pressAction?.id ?? 'default';

  if (action === 'snooze') {
    if (detail.notification?.id) await notifee.cancelNotification(detail.notification.id).catch(() => {});
    // Local re-ring first so snooze works offline; server snooze keeps every other
    // device and the re-nag escalation in agreement when we're online.
    const exact = await exactAlarmsEnabled().catch(() => false);
    await scheduleOne(
      notifee,
      extras,
      `${ID_PREFIX}${reminderId}`,
      detail.notification?.body ?? 'Reminder',
      Date.now() + SNOOZE_MINUTES * 60_000,
      exact,
    ).catch(() => {});
    if (api) await api.snoozeReminder(reminderId, SNOOZE_MINUTES).catch(() => {});
    return;
  }

  // 'stop' button or plain tap — both mean "dealt with".
  if (detail.notification?.id) await notifee.cancelNotification(detail.notification.id).catch(() => {});
  if (api) await api.markReminderSeen(reminderId).catch(() => {});
}

/** Rebuild an authenticated client when the app process was dead (background event). */
async function headlessApi(): Promise<ApiClient | null> {
  try {
    const baseUrl =
      process.env.EXPO_PUBLIC_API_URL ??
      (Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787');
    const token = await AsyncStorage.getItem('scrible.token');
    if (!token) return null;
    const api = new HttpApi(baseUrl);
    api.token = token;
    return api;
  } catch {
    return null;
  }
}
