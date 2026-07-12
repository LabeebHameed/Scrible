import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ApiClient, RoutineBlock, ScheduleBlock } from '../api';
import type { SyncStore } from '../store';
import { colors } from '../theme';

const DAYS_AHEAD = 7;

/** One row on the day timeline — a routine span, or a timed item. */
interface Entry {
  key: string;
  at: number;
  kind: 'routine' | 'item';
  title: string;
  timeText: string;
  major: boolean;
  reminder: boolean;
}

const timeText = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function dayLabel(dayStart: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dayStart - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return new Date(dayStart).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * The whole day, not just the "important" parts: routines are the muted backbone,
 * every timed item sits on it, and major commitments (meetings, deadlines) get the
 * accent treatment so they pop at a glance.
 */
export function ScheduleScreen(props: { api: ApiClient; store: SyncStore }) {
  const [routines, setRoutines] = useState<RoutineBlock[]>([]);
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const [profile, schedule] = await Promise.all([props.api.getProfile(), props.api.getSchedule()]);
      setRoutines(profile?.attributes.routines ?? []);
      setBlocks(schedule.filter((b) => b.state !== 'released'));
    } catch {
      /* offline — the store's items still render the day */
    }
    setLoaded(true);
  };

  useEffect(() => {
    void load();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const blockByItem = new Map(blocks.map((b) => [b.itemId, b]));
  const now = Date.now();
  const days: Array<{ label: string; entries: Entry[] }> = [];

  for (let d = 0; d < DAYS_AHEAD; d++) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() + d);
    const start = dayStart.getTime();
    const end = start + 86_400_000;
    const entries: Entry[] = [];

    for (const r of routines) {
      if (r.days?.length && !r.days.includes(dayStart.getDay())) continue;
      const at = new Date(start).setHours(r.startHour, 0, 0, 0);
      const until = r.endHour != null ? new Date(start).setHours(r.endHour, 0, 0, 0) : null;
      entries.push({
        key: `routine-${r.label}-${d}`,
        at,
        kind: 'routine',
        title: r.label,
        timeText: until ? `${timeText(at)} – ${timeText(until)}` : `~${timeText(at)}`,
        major: false,
        reminder: false,
      });
    }

    for (const item of Object.values(props.store.items)) {
      const at = item.timeIntent?.at;
      if (!at || at < start || at >= end) continue;
      if (item.status === 'done' || item.status === 'dismissed') continue;
      const block = blockByItem.get(item.id);
      entries.push({
        key: `item-${item.id}`,
        at,
        kind: 'item',
        title: item.title,
        timeText: block ? `${timeText(block.start)} – ${timeText(block.end)}` : timeText(at),
        major: item.importance === 'major',
        reminder: item.type === 'reminder',
      });
    }

    entries.sort((a, b) => a.at - b.at);
    if (d < 2 || entries.length > 0) days.push({ label: dayLabel(start), entries });
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ padding: 18, paddingTop: 28, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <Text style={styles.heading}>Schedule</Text>
      {!loaded ? null : (
        days.map((day) => (
          <View key={day.label} style={styles.day}>
            <Text style={styles.dayLabel}>{day.label}</Text>
            {day.entries.length === 0 ? (
              <Text style={styles.empty}>Free — nothing scheduled.</Text>
            ) : (
              day.entries.map((e) => (
                <View
                  key={e.key}
                  style={[
                    styles.row,
                    e.kind === 'routine' && styles.routineRow,
                    e.major && styles.majorRow,
                    e.at < now && styles.pastRow,
                  ]}
                >
                  <Text style={[styles.rowTime, e.kind === 'routine' && styles.routineText]}>{e.timeText}</Text>
                  <Text
                    style={[styles.rowTitle, e.kind === 'routine' && styles.routineText, e.major && styles.majorTitle]}
                    numberOfLines={1}
                  >
                    {e.reminder ? '⏰ ' : ''}
                    {e.title}
                  </Text>
                </View>
              ))
            )}
          </View>
        ))
      )}
      {loaded && routines.length === 0 ? (
        <Text style={styles.footnote}>
          Tell me your routine — “I'm at college till 4 on weekdays” — and your days fill in here.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 26, fontWeight: '800', marginBottom: 16 },
  day: { marginBottom: 18 },
  dayLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  empty: { color: colors.textDim, fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  routineRow: { backgroundColor: colors.surfaceHigh, borderColor: colors.surfaceHigh },
  majorRow: { borderLeftColor: colors.accent, borderLeftWidth: 3 },
  pastRow: { opacity: 0.5 },
  rowTime: { color: colors.textDim, fontSize: 12, minWidth: 92 },
  rowTitle: { color: colors.text, fontSize: 14, flex: 1 },
  majorTitle: { fontWeight: '700' },
  routineText: { color: colors.textDim },
  footnote: { color: colors.textDim, fontSize: 12, marginTop: 8, lineHeight: 18 },
});
