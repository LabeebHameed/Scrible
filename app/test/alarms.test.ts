import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_SNOOZE,
  ACTION_STOP,
  ALARM_CHANNEL_ID,
  REMINDER_CATEGORY_ID,
  cancelLocalAlarm,
  checkAlarmPermissions,
  scheduleLocalAlarm,
  snoozeLocalAlarm,
  syncStoreLocalAlarms,
} from '../src/alarms';
import type { Item } from '../src/types';

test('alarm module export constants and category identifiers', () => {
  assert.equal(ALARM_CHANNEL_ID, 'scrible_alarms');
  assert.equal(REMINDER_CATEGORY_ID, 'scrible_reminder');
  assert.equal(ACTION_STOP, 'STOP');
  assert.equal(ACTION_SNOOZE, 'SNOOZE');
});

test('checkAlarmPermissions fallback on non-mobile test runner', async () => {
  const perm = await checkAlarmPermissions();
  assert.equal(perm.granted, false);
  assert.equal(perm.canScheduleExact, false);
});

test('scheduleLocalAlarm handles past/completed items gracefully', async () => {
  const pastItem: Item = {
    id: 'item-1',
    type: 'reminder',
    source: 'typed',
    rawText: 'drink water',
    title: 'drink water',
    confidence: null,
    status: 'active',
    contextTag: null,
    appTrigger: null,
    timeIntent: { at: Date.now() - 10000 },
    summary: 'drink water',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    subtasks: [],
  };

  const id = await scheduleLocalAlarm(pastItem);
  assert.equal(id, null, 'past items should not schedule future local notifications');

  const completedItem: Item = { ...pastItem, timeIntent: { at: Date.now() + 60000 }, status: 'done' };
  const id2 = await scheduleLocalAlarm(completedItem);
  assert.equal(id2, null, 'completed items should not schedule local notifications');
});

test('cancelLocalAlarm runs without throwing on non-mobile platform', async () => {
  await cancelLocalAlarm('test-item-id');
});

test('snoozeLocalAlarm runs without throwing on non-mobile platform', async () => {
  const id = await snoozeLocalAlarm('test-item-id', 'Drink water', 10);
  assert.equal(id, null);
});

test('syncStoreLocalAlarms processes item dictionary safely', async () => {
  const items: Record<string, Item> = {
    '1': {
      id: '1',
      type: 'reminder',
      source: 'typed',
      rawText: 'call mom',
      title: 'call mom',
      confidence: null,
      status: 'active',
      contextTag: null,
      appTrigger: null,
      timeIntent: { at: Date.now() + 300000 },
      summary: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      subtasks: [],
    },
    '2': {
      id: '2',
      type: 'task',
      source: 'typed',
      rawText: 'buy groceries',
      title: 'buy groceries',
      confidence: null,
      status: 'done',
      contextTag: null,
      appTrigger: null,
      timeIntent: null,
      summary: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
      subtasks: [],
    },
  };

  await syncStoreLocalAlarms(items);
});
