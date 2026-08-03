import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { SyncStore } from '../store';
import type { Item, ItemType } from '../types';
import { colors, typeColor } from '../theme';
import { surface, track } from '../analytics';

const TYPES: ItemType[] = ['task', 'idea', 'reminder'];

function formatWhen(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

function ItemCard(props: { item: Item; store: SyncStore }) {
  const { item, store } = props;
  const [open, setOpen] = useState(false);

  const cycleType = () => {
    const next = TYPES[(TYPES.indexOf(item.type) + 1) % TYPES.length]!;
    void store.retype(item.id, next);
  };
  const defer = () => {
    // Defer = push to tomorrow morning; syncs as a real edit, not a local hack.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    item.timeIntent = { at: tomorrow.getTime(), phrase: 'deferred to tomorrow' };
    void store.retype(item.id, item.type); // no-op type keeps op simple
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <Pressable
          style={styles.check}
          onPress={() => {
            track('item.completed', {
              type: item.type,
              surface,
              viaVoice: false,
              timeToCompleteMs: Date.now() - item.createdAt,
            });
            void store.complete(item.id);
          }}
          accessibilityLabel={`Complete ${item.title}`}
          accessibilityRole="button"
        >
          <Text style={styles.checkText}>✓</Text>
        </Pressable>
        <Pressable style={styles.cardBody} onPress={() => setOpen(!open)}>
          <Text style={styles.title}>{item.title}</Text>
          <View style={styles.metaRow}>
            <Pressable
              onPress={cycleType}
              style={[styles.chip, { borderColor: typeColor[item.type] }]}
              accessibilityRole="button"
              accessibilityLabel={`Type: ${item.type}. Tap to correct.`}
            >
              <Text style={[styles.chipText, { color: typeColor[item.type] }]}>{item.type}</Text>
            </Pressable>
            {item.timeIntent?.at ? (
              <Text style={styles.when}>{formatWhen(item.timeIntent.at)}</Text>
            ) : null}
            {item.contextTag === 'computer-action' ? <Text style={styles.tag}>💻</Text> : null}
            {item.status === 'processing' || item.status === 'captured' ? (
              <Text style={styles.processing}>understanding…</Text>
            ) : null}
          </View>
        </Pressable>
      </View>
      {open ? (
        <View style={styles.detail}>
          {item.summary ? <Text style={styles.summary}>{item.summary}</Text> : null}
          {(item.subtasks ?? []).map((st) => (
            <Pressable
              key={st.id}
              style={styles.subtaskRow}
              onPress={() => void store.completeSubtask(item.id, st.id)}
            >
              <Text style={[styles.subtask, st.completedAt ? styles.subtaskDone : null]}>
                {st.completedAt ? '☑' : '☐'} {st.title}
              </Text>
            </Pressable>
          ))}
          <Text style={styles.raw}>“{item.rawText}”</Text>
          <View style={styles.actions}>
            <Pressable onPress={defer}>
              <Text style={styles.actionText}>Defer to tomorrow</Text>
            </Pressable>
            <Pressable onPress={() => void store.remove(item.id)}>
              <Text style={[styles.actionText, { color: colors.danger }]}>Delete</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function QueueScreen(props: { store: SyncStore; version: number }) {
  const [showAll, setShowAll] = useState(false);
  const queue = props.store.queue();
  const all = props.store.allOpen();
  const rest = all.filter((i) => !queue.some((q) => q.id === i.id));
  const doneToday = props.store
    .completed()
    .filter((i) => i.completedAt && new Date(i.completedAt).toDateString() === new Date().toDateString());

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>Right now</Text>
      {queue.length === 0 ? (
        <Text style={styles.empty}>Nothing queued — capture something.</Text>
      ) : (
        <FlatList
          data={showAll ? [...queue, ...rest] : queue}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ItemCard item={item} store={props.store} />}
          extraData={props.version}
          ListFooterComponent={
            <>
              {rest.length > 0 ? (
                <Pressable onPress={() => setShowAll(!showAll)}>
                  <Text style={styles.more}>
                    {showAll ? 'Show top 5' : `Show ${rest.length} more`}
                  </Text>
                </Pressable>
              ) : null}
              {doneToday.length > 0 ? (
                <Text style={styles.doneCount}>✓ {doneToday.length} completed today</Text>
              ) : null}
            </>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 18, paddingTop: 28 },
  heading: { color: colors.text, fontSize: 26, fontWeight: '800', marginBottom: 16 },
  empty: { color: colors.textDim, fontSize: 15 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 10,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center' },
  check: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkText: { color: colors.textDim, fontSize: 16 },
  cardBody: { flex: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 },
  chipText: { fontSize: 12, fontWeight: '600' },
  when: { color: colors.textDim, fontSize: 12 },
  tag: { fontSize: 12 },
  processing: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
  detail: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  summary: { color: colors.reminder, fontSize: 13, marginBottom: 8 },
  subtaskRow: { paddingVertical: 4 },
  subtask: { color: colors.text, fontSize: 14 },
  subtaskDone: { color: colors.textDim, textDecorationLine: 'line-through' },
  raw: { color: colors.textDim, fontSize: 12, fontStyle: 'italic', marginTop: 8 },
  actions: { flexDirection: 'row', gap: 22, marginTop: 12 },
  actionText: { color: colors.textDim, fontSize: 13 },
  more: { color: colors.accent, marginTop: 8, marginBottom: 12, fontSize: 14 },
  doneCount: { color: colors.textDim, marginTop: 10, fontSize: 13 },
});
