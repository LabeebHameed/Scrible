import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { colors } from '../theme';

const hex = (c: string) => c as `#${string}`;

/**
 * 4x1 home-screen capture bar: mic circle + hint. Tap → the app opens straight into
 * recording (widgets can't own the microphone on Android — this is the platform
 * ceiling; the hardware capture device is the true answer, and the API is ready for
 * it). While the app records, the widget flips to a live "● Recording…" state via
 * setCaptureWidgetRecording (src/widgets/refresh.ts).
 */
export function CaptureWidget({ recording = false }: { recording?: boolean }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'scrible://capture?autostart=1' }}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: hex(colors.surface),
        borderRadius: 24,
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
      }}
    >
      <FlexWidget
        style={{
          height: 44,
          width: 44,
          borderRadius: 22,
          backgroundColor: hex(recording ? colors.danger : colors.accent),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <TextWidget text="🎙" style={{ fontSize: 20 }} />
      </FlexWidget>
      <FlexWidget style={{ width: 12, height: 1 }} />
      <TextWidget
        text={recording ? '● Recording…' : "What's on your mind?"}
        style={{ fontSize: 14, color: hex(recording ? colors.danger : colors.textDim) }}
      />
    </FlexWidget>
  );
}
