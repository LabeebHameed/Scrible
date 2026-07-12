import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { ApiClient, CalendarLink, ProfileView } from '../api';
import type { PushStatus } from '../push';
import { requestExactAlarms, type AlarmStatus } from '../alarms';
import { setAnalyticsEnabled } from '../analytics';
import type { SyncStore } from '../store';
import { colors } from '../theme';

const CONSENTS: Array<{ key: string; label: string; detail: string }> = [
  { key: 'voice_processing', label: 'Voice processing', detail: 'Transcribe your voice on-device to create items.' },
  { key: 'voice_retention', label: 'Keep recordings', detail: 'Retain raw audio after transcription (off = deleted immediately).' },
  { key: 'calendar_access', label: 'Calendar access', detail: 'Let major items (meetings, appointments) get a block on Scrible’s own internal calendar.' },
  { key: 'chat_import', label: 'Chat import & profile', detail: 'Derive a working-style profile from imported assistant chats.' },
  { key: 'analytics', label: 'Product analytics', detail: 'Anonymous usage events. Never your words or titles.' },
  { key: 'app_watcher', label: 'Desktop app watcher', detail: 'Let the desktop app notice app launches to surface matching items. App names never leave that device.' },
];

export function SettingsScreen(props: {
  api: ApiClient;
  store: SyncStore;
  pushStatus?: PushStatus | null;
  alarmStatus?: AlarmStatus | null;
  onLogout(): void;
  onAccountDeleted(message: string): void;
}) {
  const [consents, setConsents] = useState<Record<string, { granted: boolean }>>({});
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [importText, setImportText] = useState('');
  const [importSource, setImportSource] = useState<'claude' | 'chatgpt' | 'gemini' | 'generic'>('claude');
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [calendarLinks, setCalendarLinks] = useState<CalendarLink[]>([]);

  const refresh = async () => {
    try {
      setConsents(await props.api.getConsents());
      setProfile(await props.api.getProfile());
      setCalendarLinks(await props.api.getCalendarLinks());
      setError(null);
    } catch (err) {
      setError('Offline — consent settings need a connection.');
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const removeRoutine = async (label: string) => {
    await props.api.deleteRoutine(label);
    await refresh();
  };

  const describePush = (status?: PushStatus | null): string => {
    if (!status) return 'Checking…';
    switch (status.state) {
      case 'registered':
        return 'Enabled — reminders will buzz this device.';
      case 'no-permission':
        return 'Off — notification permission was denied. Enable it in your phone’s system settings.';
      case 'unsupported':
        return 'Not available on this platform.';
      case 'failed':
        return `Couldn’t register (${status.reason}). Reminders will only show inside the app.`;
    }
  };

  const runImport = async () => {
    setImportStatus('Processing… your export is parsed in memory and never stored.');
    try {
      await props.api.importChats(importSource, importText);
      setImportText('');
      setImportStatus('Done — profile updated below. The raw export was discarded.');
      await refresh();
    } catch (err) {
      setImportStatus(err instanceof Error ? err.message : 'Import failed.');
    }
  };

  const setTone = async (tone: string) => {
    await props.api.patchProfile({ tone });
    await refresh();
  };

  const deleteProfile = async () => {
    const res = await props.api.deleteProfile();
    setImportStatus(res.confirmation);
    await refresh();
  };

  const describeProfile = (p: ProfileView): string[] => {
    const lines: string[] = [];
    const a = p.attributes;
    if (a.tone) lines.push(a.tone === 'brief' ? 'You prefer brief confirmations.' : `You prefer a ${a.tone} tone.`);
    if (a.decompositionGranularity)
      lines.push(
        a.decompositionGranularity === 'coarse'
          ? 'You like tasks broken into fewer, larger steps.'
          : a.decompositionGranularity === 'fine'
            ? 'You like tasks broken into many small steps.'
            : 'You like a moderate level of task breakdown.',
      );
    if (a.vocabulary?.length) lines.push(`Your world: ${a.vocabulary.slice(0, 6).join(', ')}.`);
    lines.push(p.storage === 'on-device-only' ? 'Derived on your device — raw chats never uploaded.' : 'Derived from your import; the raw file was not kept.');
    return lines;
  };

  const toggle = async (key: string, next: boolean) => {
    try {
      if (next) await props.api.grantConsent(key);
      else await props.api.revokeConsent(key);
      if (key === 'analytics') setAnalyticsEnabled(next);
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

      <Text style={styles.section}>Notifications</Text>
      <Text style={styles.detail}>{describePush(props.pushStatus)}</Text>

      <Text style={styles.section}>Alarms</Text>
      {props.alarmStatus?.state === 'exact' ? (
        <Text style={styles.detail}>Exact alarms on — reminders ring on the second, even offline.</Text>
      ) : props.alarmStatus?.state === 'inexact' ? (
        <>
          <Text style={styles.detail}>
            Reminders will ring, but Android may delay them. Allow “Alarms & reminders” for on-the-second
            alarms, then restart Scrible.
          </Text>
          <Pressable style={styles.buttonGhost} onPress={() => void requestExactAlarms()}>
            <Text style={styles.buttonGhostText}>Allow exact alarms</Text>
          </Pressable>
        </>
      ) : props.alarmStatus?.state === 'error' ? (
        <Text style={styles.error}>Alarm trouble: {props.alarmStatus.reason}</Text>
      ) : (
        <Text style={styles.detail}>Checking…</Text>
      )}

      <Text style={styles.section}>Calendar</Text>
      {calendarLinks.length === 0 ? (
        <Text style={styles.detail}>
          No external calendar connected. Major items (meetings, appointments) still get a block on
          Scrible’s own internal calendar — everything else stays reminder-only. Google/Outlook sync:
          coming soon.
        </Text>
      ) : (
        calendarLinks.map((l) => (
          <Text key={l.id} style={styles.detail}>
            Connected: {l.provider} ({l.accountId})
          </Text>
        ))
      )}

      {profile?.attributes.routines?.length ? (
        <>
          <Text style={styles.section}>Your routine</Text>
          <Text style={styles.detail}>Learned from what you’ve told Scrible — used to resolve times like “after work”.</Text>
          {profile.attributes.routines.map((r) => (
            <View key={r.label} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{r.label}</Text>
                <Text style={styles.detail}>
                  {(r.days?.length ? r.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join('/') : 'every day') +
                    ' · ' +
                    (r.endHour != null ? `${r.startHour}:00–${r.endHour}:00` : `~${r.startHour}:00`)}
                </Text>
              </View>
              <Pressable onPress={() => void removeRoutine(r.label)}>
                <Text style={styles.buttonGhostText}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </>
      ) : null}

      <Text style={styles.section}>Personalization</Text>
      {consents.chat_import?.granted ? (
        <>
          {profile ? (
            <View style={styles.profileBox}>
              {describeProfile(profile).map((line, i) => (
                <Text key={i} style={styles.profileLine}>
                  • {line}
                </Text>
              ))}
              <View style={styles.toneRow}>
                <Text style={styles.detail}>Confirmation tone:</Text>
                {(['brief', 'neutral', 'warm'] as const).map((t) => (
                  <Pressable
                    key={t}
                    style={[styles.tonePill, profile.attributes.tone === t && styles.tonePillActive]}
                    onPress={() => void setTone(t)}
                  >
                    <Text
                      style={[
                        styles.tonePillText,
                        profile.attributes.tone === t && styles.tonePillTextActive,
                      ]}
                    >
                      {t}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Pressable style={styles.buttonDanger} onPress={() => void deleteProfile()}>
                <Text style={styles.buttonDangerText}>Delete profile & all import data</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.detail}>
              Import your assistant chat history to tailor task breakdown, tone, and scheduling.
              Only a structured profile is kept — the raw export is discarded after processing.
            </Text>
          )}
          <View style={styles.sourceRow}>
            {(['claude', 'chatgpt', 'gemini', 'generic'] as const).map((s) => (
              <Pressable
                key={s}
                style={[styles.tonePill, importSource === s && styles.tonePillActive]}
                onPress={() => setImportSource(s)}
              >
                <Text style={[styles.tonePillText, importSource === s && styles.tonePillTextActive]}>{s}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={styles.importInput}
            placeholder="paste your export (JSON or text)…"
            placeholderTextColor={colors.textDim}
            value={importText}
            onChangeText={setImportText}
            multiline
          />
          <Pressable
            style={styles.buttonGhost}
            onPress={() => void runImport()}
            disabled={!importText.trim()}
          >
            <Text style={styles.buttonGhostText}>Import & derive profile</Text>
          </Pressable>
          {importStatus ? <Text style={styles.importStatus}>{importStatus}</Text> : null}
        </>
      ) : (
        <Text style={styles.detail}>
          Enable “Chat import & profile” above to personalize Scrible from your assistant history.
        </Text>
      )}

      <Text style={styles.section}>Sync</Text>
      <Text style={styles.detail}>
        {pending === 0
          ? props.store.lastError
            ? "You're offline — everything is kept safe here and syncs the moment you're back."
            : 'Everything is in sync.'
          : `${pending} change${pending === 1 ? '' : 's'} kept safe — syncing when I can reach the server.`}
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
  profileBox: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 12 },
  profileLine: { color: colors.text, fontSize: 13, lineHeight: 20, marginBottom: 4 },
  toneRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' },
  sourceRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  tonePill: { borderColor: colors.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  tonePillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  tonePillText: { color: colors.textDim, fontSize: 12 },
  tonePillTextActive: { color: colors.accentText, fontWeight: '700' },
  importInput: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 12, color: colors.text, fontSize: 13, padding: 12, marginTop: 8, minHeight: 70, textAlignVertical: 'top' },
  importStatus: { color: colors.reminder, fontSize: 12, marginTop: 8 },
  buttonDangerText: { color: '#fff', fontWeight: '700' },
  footnote: { color: colors.textDim, fontSize: 11, marginTop: 10, marginBottom: 40 },
});
