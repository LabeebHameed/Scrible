import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { ApiClient } from '../api';
import type { SyncStore } from '../store';
import { colors } from '../theme';

const CONSENTS: Array<{ key: string; label: string; detail: string }> = [
  { key: 'voice_processing', label: 'Voice processing', detail: 'Transcribe your voice on-device to create items.' },
  { key: 'voice_retention', label: 'Keep recordings', detail: 'Retain raw audio after transcription (off = deleted immediately).' },
  { key: 'calendar_access', label: 'Calendar access', detail: 'Read free/busy and write Scrible blocks to your calendar.' },
  { key: 'chat_import', label: 'Chat import & profile', detail: 'Derive a working-style profile from imported assistant chats.' },
  { key: 'analytics', label: 'Product analytics', detail: 'Anonymous usage events. Never your words or titles.' },
];

export function SettingsScreen(props: {
  api: ApiClient;
  store: SyncStore;
  onLogout(): void;
  onAccountDeleted(message: string): void;
}) {
  const [consents, setConsents] = useState<Record<string, { granted: boolean }>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setConsents(await props.api.getConsents());
      setError(null);
    } catch (err) {
      setError('Offline — consent settings need a connection.');
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const toggle = async (key: string, next: boolean) => {
    try {
      if (next) await props.api.grantConsent(key);
      else await props.api.revokeConsent(key);
      await refresh();
    } catch {
      setError('Could not update consent — are you online?');
    }
  };

  const confirmDelete = () => {
    const doDelete = async () => {
      try {
        const res = await props.api.deleteAccount();
        props.onAccountDeleted(res.confirmation);
      } catch {
        setError('Deletion failed — are you online?');
      }
    };
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (globalThis.confirm?.('Delete your account and ALL data? This cannot be undone.')) void doDelete();
    } else {
      Alert.alert('Delete account?', 'This permanently deletes your account and all data.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete everything', style: 'destructive', onPress: () => void doDelete() },
      ]);
    }
  };

  const pending = props.store.pendingOps.length;

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 18 }}>
      <Text style={styles.heading}>Settings</Text>

      <Text style={styles.section}>Privacy & consent</Text>
      {CONSENTS.map((c) => (
        <View key={c.key} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{c.label}</Text>
            <Text style={styles.detail}>{c.detail}</Text>
          </View>
          <Switch
            value={consents[c.key]?.granted ?? false}
            onValueChange={(v) => void toggle(c.key, v)}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.section}>Sync</Text>
      <Text style={styles.detail}>
        {pending === 0
          ? props.store.lastError
            ? `Offline (${props.store.lastError}) — changes will sync when back online.`
            : 'All changes synced.'
          : `${pending} change${pending === 1 ? '' : 's'} waiting to sync.`}
      </Text>
      <Pressable style={styles.buttonGhost} onPress={() => void props.store.sync()}>
        <Text style={styles.buttonGhostText}>Sync now</Text>
      </Pressable>

      <Text style={styles.section}>Account</Text>
      <Pressable style={styles.buttonGhost} onPress={props.onLogout}>
        <Text style={styles.buttonGhostText}>Sign out</Text>
      </Pressable>
      <Pressable style={styles.buttonDanger} onPress={confirmDelete}>
        <Text style={styles.buttonDangerText}>Delete account & all data</Text>
      </Pressable>
      <Text style={styles.footnote}>
        Deletion removes everything from live systems immediately; backup copies expire within 30 days.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 26, fontWeight: '800', marginBottom: 14 },
  section: { color: colors.textDim, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', marginTop: 22, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 14, gap: 12 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  detail: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  error: { color: colors.danger, fontSize: 13, marginTop: 6 },
  buttonGhost: { borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 13, alignItems: 'center', marginTop: 10 },
  buttonGhostText: { color: colors.text, fontWeight: '600' },
  buttonDanger: { backgroundColor: colors.danger, borderRadius: 12, padding: 13, alignItems: 'center', marginTop: 14 },
  buttonDangerText: { color: '#fff', fontWeight: '700' },
  footnote: { color: colors.textDim, fontSize: 11, marginTop: 10, marginBottom: 40 },
});
