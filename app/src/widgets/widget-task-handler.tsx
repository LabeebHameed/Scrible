import React from 'react';
import type { WidgetTaskHandler } from 'react-native-android-widget';
import { CaptureWidget } from './CaptureWidget';

/** Registered from index.ts (Android only) — renders the widget on add/update/resize. */
export const widgetTaskHandler: WidgetTaskHandler = async (props) => {
  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED':
      props.renderWidget(<CaptureWidget />);
      break;
    default:
      break;
  }
};
