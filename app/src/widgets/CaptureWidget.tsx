import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { colors } from '../theme';

const hex = (c: string) => c as `#${string}`;

/** Home-screen widget: tap → open the app straight into recording (see App.tsx's
 * deep-link handler for `scrible://capture?autostart=1`). Widgets have no mic
 * access, so one-tap-to-recording is the actual ceiling here, not a shortcut. */
export function CaptureWidget() {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'scrible://capture?autostart=1' }}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: hex(colors.surfaceHigh),
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
      }}
    >
      <TextWidget text="🎙" style={{ fontSize: 28 }} />
      <TextWidget text="Scrible" style={{ fontSize: 12, color: hex(colors.text), fontWeight: '700' }} />
    </FlexWidget>
  );
}
