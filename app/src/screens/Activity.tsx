import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { SyncStore } from '../store';
import type { ApiClient } from '../api';
import { colors } from '../theme';

/**
 * Activity feed (build plan §7.6): every automated decision — scheduled, moved,
 * conflicted, reminder set — as a plain-language line with one-tap undo.
 */
export function ActivityScreen(props: { store: SyncStore; api: ApiClient; version: number }) {
  const [undone, setUndone] = useState<Set<string>>(new Set());

  const undo = async (activityId: string, blockId: string) => {
    try {
      await props.api.undoBlock(blockId);
      setUndone(new Set(undone).add(activityId));
      await props.store.sync();
    } catch {
      /* stays undoable; user can retry */
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>Activity</Text>
      {props.store.activities.length === 0 ? (
        <Text style={styles.empty}>
          When Scrible schedules, moves, or reminds, you'll see it here — nothing happens silently.
        </Text>
      ) : (
        <FlatList
          data={props.store.activities}
          keyExtractor={(a) => a.id}
          extraData={props.version}
          renderItem={({ item: a }) => (
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.message}>{a.message}</Text>
                <Text style={styles.time}>
                  {new Date(a.createdAt).toLocaleString([], {
                    weekday: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              {a.undoable && a.blockId && !undone.has(a.id) ? (
                <Pressable style={styles.undo} onPress={() => void undo(a.id, a.blockId!)}>
                  <Text style={styles.undoText}>Undo</Text>
                </Pressable>
              ) : null}
            </View>
          )}
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
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 13,
    marginBottom: 8,
    gap: 10,
  },
  message: { color: colors.text, fontSize: 14, lineHeight: 20 },
  time: { color: colors.textDim, fontSize: 11, marginTop: 4 },
  undo: { borderColor: colors.accent, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  undoText: { color: colors.accent, fontWeight: '700', fontSize: 13 },
});
