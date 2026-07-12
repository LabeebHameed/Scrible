import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WidgetTaskHandler } from 'react-native-android-widget';
import type { Item } from '../types';
import { CaptureWidget } from './CaptureWidget';
import { TodoWidget, selectQueue } from './TodoWidget';

const STORE_KEY = 'scrible.store.v1';

/**
 * Registered from index.ts (Android only) — renders widgets on add/update/resize.
 * Runs in headless JS: native modules (AsyncStorage) work, app state doesn't exist.
 */
export const widgetTaskHandler: WidgetTaskHandler = async (props) => {
  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED': {
      if (props.widgetInfo.widgetName === 'ScribleTodo') {
        let items: Item[] = [];
        try {
          const raw = await AsyncStorage.getItem(STORE_KEY);
          items = selectQueue(raw ? ((JSON.parse(raw) as { items?: Record<string, Item> }).items ?? {}) : {});
        } catch {
          /* unreadable snapshot — render the empty state */
        }
        props.renderWidget(<TodoWidget items={items} />);
      } else {
        props.renderWidget(<CaptureWidget />);
      }
      break;
    }
    default:
      break;
  }
};
