import React, { useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { ApiClient, ScheduleBlock } from '../api';
import type { SyncStore } from '../store';
import { colors } from '../theme';

/**
 * The calendar at a glance: only "major" items (meetings, appointments, deadlines)
 * ever land here — everything else still gets reminded, it just doesn't clutter this
 * view (see backend/src/server.ts afterEnrichment). Without this screen the internal
 * calendar was invisible, which was half of why it felt fake.
 */
export function ScheduleScreen(props: { api: ApiClient; store: SyncStore }) {
  const [blocks, setBlocks] = useState<ScheduleBlock[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const rows = await props.api.getSchedule();
      setBlocks(rows.filter((b) => b.state !== 'released').sort((a, b) => a.start - b.start));
    } catch {
      /* offline — keep showing whatever we last had */
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const formatDay = (ts: number): string =>
    new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const formatTime = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>Schedule</Text>
      {blocks === null ? null : blocks.length === 0 ? (
        <Text style={styles.empty}>
          Nothing major on your calendar. Meetings, appointments, and deadlines will show up here — everything
          else still gets reminded, it just doesn't need a calendar block.
        </Text>
      ) : (
        <FlatList
          data={blocks}
          keyExtractor={(b) => b.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          renderItem={({ item: b }) => {
            const title = props.store.items[b.itemId]?.title ?? '(untitled)';
            return (
              <View style={styles.row}>
                <Text style={styles.day}>{formatDay(b.start)}</Text>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.time}>
                  {formatTime(b.start)}–{formatTime(b.end)}
                  {b.external ? ' · synced' : ''}
                </Text>
                {b.state === 'moved' ? <Text style={styles.moved}>moved from a conflict</Text> : null}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 18, paddingTop: 28 },
  heading: { color: colors.text, fontSize: 26, fontWeight: '800', marginBottom: 16 },
  empty: { color: colors.textDim, fontSize: 14, lineHeight: 21 },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 13,
    marginBottom: 8,
  },
  day: { color: colors.textDim, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 4 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  time: { color: colors.textDim, fontSize: 12, marginTop: 4 },
  moved: { color: colors.reminder, fontSize: 11, marginTop: 4 },
});
