/**
 * App → widget refresh plumbing. Called from app code (never from store.ts — its
 * tests run in plain node and must stay free of react-native imports).
 */
import React from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Item } from '../types';

const STORE_KEY = 'scrible.store.v1';
let todoTimer: ReturnType<typeof setTimeout> | null = null;

async function readItems(): Promise<Record<string, Item>> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (!raw) return {};
    return (JSON.parse(raw) as { items?: Record<string, Item> }).items ?? {};
  } catch {
    return {};
  }
}

/** Debounced: mirror the queue onto the home-screen To-Do widget. */
export function updateTodoWidget(): void {
  if (Platform.OS !== 'android') return;
  if (todoTimer) clearTimeout(todoTimer);
  todoTimer = setTimeout(() => {
    void (async () => {
      try {
        const { requestWidgetUpdate } = await import('react-native-android-widget');
        const { TodoWidget, selectQueue } = await import('./TodoWidget');
        const items = selectQueue(await readItems());
        await requestWidgetUpdate({
          widgetName: 'ScribleTodo',
          renderWidget: () => React.createElement(TodoWidget, { items }),
        });
      } catch {
        /* no widget placed / module unavailable — nothing to update */
      }
    })();
  }, 1000);
}

/** Flip the capture bar widget to its live "● Recording…" state and back. */
export function setCaptureWidgetRecording(recording: boolean): void {
  if (Platform.OS !== 'android') return;
  void (async () => {
    try {
      const { requestWidgetUpdate } = await import('react-native-android-widget');
      const { CaptureWidget } = await import('./CaptureWidget');
      await requestWidgetUpdate({
        widgetName: 'ScribleCapture',
        renderWidget: () => React.createElement(CaptureWidget, { recording }),
      });
    } catch {
      /* no widget placed / module unavailable */
    }
  })();
}
