import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HttpApi } from './src/api';
import { SyncStore } from './src/store';
import { AuthScreen } from './src/screens/Auth';
import { CaptureScreen } from './src/screens/Capture';
import { QueueScreen } from './src/screens/Queue';
import { ActivityScreen } from './src/screens/Activity';
import { SettingsScreen } from './src/screens/Settings';
import { colors } from './src/theme';

const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787');

const SYNC_INTERVAL_MS = 5000;

type Tab = 'capture' | 'queue' | 'activity' | 'settings';

export default function App() {
  const api = useMemo(() => new HttpApi(API_URL), []);
  const store = useMemo(() => new SyncStore(AsyncStorage, api), [api]);
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('capture');
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await AsyncStorage.getItem('scrible.token');
      if (saved) {
        api.token = saved;
        setToken(saved);
        await store.load();
        void store.sync();
      }
      setReady(true);
    })();
  }, [api, store]);

  useEffect(() => store.subscribe(() => setVersion((v) => v + 1)), [store]);

  useEffect(() => {
    if (!token) return;
    timer.current = setInterval(() => void store.sync(), SYNC_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [token, store]);

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
        {tab === 'capture' ? <CaptureScreen store={store} api={api} /> : null}
        {tab === 'queue' ? <QueueScreen store={store} version={version} /> : null}
        {tab === 'activity' ? <ActivityScreen store={store} api={api} version={version} /> : null}
        {tab === 'settings' ? (
          <SettingsScreen
            api={api}
            store={store}
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
            ['activity', 'Activity'],
            ['settings', 'Settings'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <Pressable key={key} style={styles.tab} onPress={() => setTab(key)}>
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
