import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HttpApi } from './src/api';
import { SyncStore } from './src/store';
import { AuthScreen } from './src/screens/Auth';
import { CaptureScreen } from './src/screens/Capture';
import { QueueScreen } from './src/screens/Queue';
import { ActivityScreen } from './src/screens/Activity';
import { ScheduleScreen } from './src/screens/Schedule';
import { SettingsScreen } from './src/screens/Settings';
import { configureAnalytics, surface, track } from './src/analytics';
import { setupPushNotifications, type PushStatus } from './src/push';
import { handleAlarmEvent, setupAlarms, syncAlarms } from './src/alarms';
import { colors } from './src/theme';

const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787');

const SYNC_INTERVAL_MS = 5000;

type Tab = 'capture' | 'queue' | 'schedule' | 'activity' | 'settings';

export default function App() {
  const api = useMemo(() => new HttpApi(API_URL), []);
  const store = useMemo(() => new SyncStore(AsyncStorage, api), [api]);
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('capture');
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await AsyncStorage.getItem('scrible.token');
      if (saved) {
        api.token = saved;
        setToken(saved);
        await store.load();
        void store.sync();
        void api
          .getConsents()
          .then((c) => {
            configureAnalytics(api, c.analytics?.granted ?? false);
            track('app.opened', { surface });
          })
          .catch(() => configureAnalytics(api, false));
      }
      setReady(true);
    })();
  }, [api, store]);

  useEffect(() => store.subscribe(() => setVersion((v) => v + 1)), [store]);

  // Deep links (widget tap, `scrible://capture?autostart=1`) jump to Capture and, if
  // requested, start recording immediately. `addEventListener` fires on every tap even
  // for a repeated identical URL — deliberately not `Linking.useURL()`, which dedupes.
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const { hostname, path, queryParams } = Linking.parse(url);
      if (hostname !== 'capture' && path !== 'capture') return;
      setTab('capture');
      if (queryParams?.autostart === '1') setCaptureRequest((n) => n + 1);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!token) return;
    timer.current = setInterval(() => void store.sync(), SYNC_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [token, store]);

  // Register for push once signed in — covers both a restored session and a fresh
  // login/signup, since both paths set `token`.
  useEffect(() => {
    if (!token) return;
    void setupPushNotifications(api).then(setPushStatus);
  }, [token, api]);

  // Local alarms mirror server reminders so they ring offline with the app killed.
  // Reconciled once a minute — NOT on the 5s store sync, /v1/reminders doesn't need it.
  useEffect(() => {
    if (!token) return;
    let unsub: (() => void) | undefined;
    void setupAlarms().then(async () => {
      void syncAlarms(api);
      if (Platform.OS === 'android') {
        try {
          const { default: notifee } = await import('react-native-notify-kit');
          unsub = notifee.onForegroundEvent(({ type, detail }) => void handleAlarmEvent(type, detail, api));
        } catch {
          /* module unavailable (Expo Go) — background handler covers real builds */
        }
      }
    });
    const interval = setInterval(() => void syncAlarms(api), 60_000);
    return () => {
      clearInterval(interval);
      unsub?.();
    };
  }, [token, api]);

  const authenticate = async (mode: 'login' | 'signup', email: string, password: string) => {
    const res = mode === 'login' ? await api.login(email, password) : await api.signup(email, password);
    api.token = res.token;
    await AsyncStorage.setItem('scrible.token', res.token);
    await store.load();
    await store.sync();
    setToken(res.token);
  };

  const logout = async () => {
    await AsyncStorage.removeItem('scrible.token');
    await AsyncStorage.removeItem('scrible.store.v1');
    api.token = null;
    store.items = {};
    store.pendingOps = [];
    store.cursor = 0;
    setToken(null);
  };

  if (!ready) return <View style={styles.root} />;

  if (!token) {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <AuthScreen onSubmit={authenticate} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={{ flex: 1 }}>
        {tab === 'capture' ? <CaptureScreen store={store} api={api} autoStartSignal={captureRequest} /> : null}
        {tab === 'queue' ? <QueueScreen store={store} version={version} /> : null}
        {tab === 'schedule' ? <ScheduleScreen store={store} api={api} /> : null}
        {tab === 'activity' ? <ActivityScreen store={store} api={api} version={version} /> : null}
        {tab === 'settings' ? (
          <SettingsScreen
            api={api}
            store={store}
            pushStatus={pushStatus}
            onLogout={() => void logout()}
            onAccountDeleted={(message) => {
              setNotice(message);
              void logout();
            }}
          />
        ) : null}
      </View>
      <View style={styles.tabBar}>
        {(
          [
            ['queue', 'Queue'],
            ['capture', 'Capture'],
            ['schedule', 'Schedule'],
            ['activity', 'Activity'],
            ['settings', 'Settings'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <Pressable
            key={key}
            style={styles.tab}
            onPress={() => setTab(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
            accessibilityLabel={`${label} tab`}
          >
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingBottom: Platform.OS === 'ios' ? 22 : 8,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: colors.accent },
  notice: { color: colors.reminder, textAlign: 'center', marginTop: 60, paddingHorizontal: 24 },
});
