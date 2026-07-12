import React from 'react';
import { FlexWidget, ListWidget, TextWidget } from 'react-native-android-widget';
import type { Item } from '../types';
import { colors, typeColor } from '../theme';

const hex = (c: string) => c as `#${string}`;

/**
 * "Right now" home-screen widget: the queue at a glance. Rows open the app's queue;
 * the mic in the header jumps straight to recording. Data comes from the persisted
 * store snapshot (see selectQueue below + widget-task-handler/refresh).
 */
export function TodoWidget({ items }: { items: Item[] }) {
  return (
    <FlexWidget
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: hex(colors.surface),
        borderRadius: 24,
        padding: 12,
        flexDirection: 'column',
      }}
    >
      <FlexWidget
        style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}
      >
        <TextWidget text="Right now" style={{ fontSize: 15, fontWeight: 'bold', color: hex(colors.text) }} />
        <FlexWidget
          clickAction="OPEN_URI"
          clickActionData={{ uri: 'scrible://capture?autostart=1' }}
          style={{
            height: 32,
            width: 32,
            borderRadius: 16,
            backgroundColor: hex(colors.accent),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <TextWidget text="🎙" style={{ fontSize: 14 }} />
        </FlexWidget>
      </FlexWidget>
      {items.length === 0 ? (
        <TextWidget
          text="Nothing waiting — tap the mic and talk."
          style={{ fontSize: 13, color: hex(colors.textDim) }}
        />
      ) : (
        <ListWidget style={{ height: 'match_parent', width: 'match_parent' }}>
          {items.map((item) => (
            <FlexWidget
              key={item.id}
              clickAction="OPEN_URI"
              clickActionData={{ uri: 'scrible://queue' }}
              style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'center', padding: 8 }}
            >
              <FlexWidget
                style={{
                  height: 8,
                  width: 8,
                  borderRadius: 4,
                  backgroundColor: hex(typeColor[item.type] ?? colors.textDim),
                  marginRight: 8,
                }}
              />
              <FlexWidget style={{ flex: 1 }}>
                <TextWidget text={item.title} truncate="END" maxLines={1} style={{ fontSize: 13, color: hex(colors.text) }} />
              </FlexWidget>
              {item.timeIntent?.at ? (
                <TextWidget
                  text={new Date(item.timeIntent.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  style={{ fontSize: 11, color: hex(colors.reminder), marginLeft: 8 }}
                />
              ) : null}
            </FlexWidget>
          ))}
        </ListWidget>
      )}
    </FlexWidget>
  );
}

/**
 * Mirror of SyncStore.queue() (app/src/store.ts) over a raw persisted snapshot —
 * keep the two in lockstep: open statuses, explicit times first (soonest), then
 * oldest-first.
 */
export function selectQueue(items: Record<string, Item>, limit = 10): Item[] {
  const open = Object.values(items).filter((i) =>
    ['captured', 'processing', 'active', 'scheduled'].includes(i.status),
  );
  const timed = open
    .filter((i) => i.timeIntent?.at)
    .sort((a, b) => (a.timeIntent!.at ?? 0) - (b.timeIntent!.at ?? 0));
  const rest = open.filter((i) => !i.timeIntent?.at).sort((a, b) => a.createdAt - b.createdAt);
  return [...timed, ...rest].slice(0, limit);
}
