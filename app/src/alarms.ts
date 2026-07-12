/**
 * Real offline alarms. Reminders synced from the server are scheduled ON this
 * device via react-native-notify-kit (AlarmManager exact triggers — fire through
 * Doze, survive reboot, need no network at ring time) and ring like a clock alarm:
 * full-screen over the lockscreen, looping sound, Stop + Snooze buttons that work
 * with the app killed (onBackgroundEvent in index.ts).
 *
 * The server knows this device rings its own alarms (capabilities.localAlarms in
 * api.registerDevice) and skips the first push to it; server push still covers the
 * 5-minute re-nag escalation and every other device.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiClient, ReminderView } from './api';
import { HttpApi } from './api';

const CHANNEL_ID = 'scrible-alarm';
const ID_PREFIX = 'rem-';
const SNOOZE_MINUTES = 10;

async function kit() {
  const mod = await import('react-native-notify-kit');
  return mod;
}

/** One-time setup: alarm channel + notification permission. Android-only. */
export async function setupAlarms(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const { default: notifee, AndroidImportance } = await kit();
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Reminders (alarm)',
      importance: AndroidImportance.HIGH,
      sound: 'default',
    });
    await notifee.requestPermission();
  } catch {
    // Alarm module unavailable (web, Expo Go) — server push still covers reminders.
  }
}

async function scheduleOne(
  notifee: Awaited<ReturnType<typeof kit>>['default'],
  extras: Pick<Awaited<ReturnType<typeof kit>>, 'AndroidCategory' | 'AndroidImportance' | 'TriggerType'>,
  id: string,
  title: string,
  fireAt: number,
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
    { type: TriggerType.TIMESTAMP, timestamp: fireAt, alarmManager: { allowWhileIdle: true } },
  );
}

/**
 * Reconcile local alarms with server truth. Idempotent: cancels every alarm we own
 * and recreates from the pending set, so snoozes/completions/edits made anywhere
 * (phone, desktop, another device) settle within one sync.
 */
export async function syncAlarms(api: ApiClient): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const { default: notifee, ...extras } = await kit();
    const due = await api.reminders();
    const pending = due.filter((r: ReminderView) => !r.seenAt && r.fireAt > Date.now());

    const existing = await notifee.getTriggerNotificationIds();
    await Promise.all(
      existing.filter((id) => id.startsWith(ID_PREFIX)).map((id) => notifee.cancelTriggerNotification(id)),
    );
    for (const r of pending) {
      await scheduleOne(notifee, extras, `${ID_PREFIX}${r.id}`, r.title, r.fireAt);
    }
  } catch {
    // Offline or module unavailable — previously scheduled alarms still ring;
    // reconcile again on the next sync.
  }
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
    await scheduleOne(
      notifee,
      extras,
      `${ID_PREFIX}${reminderId}`,
      detail.notification?.body ?? 'Reminder',
      Date.now() + SNOOZE_MINUTES * 60_000,
    );
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
