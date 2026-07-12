import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { SyncStore } from '../store';
import type { ApiClient } from '../api';
import type { Item } from '../types';
import { isSpeechAvailable, startDictation, type DictationSession } from '../speech';
import { surface, track } from '../analytics';
import { colors } from '../theme';

type Phase = 'idle' | 'recording' | 'saving';

/**
 * The agent timeline: the user watches the assistant work, stage by stage, with the
 * real result in each stage — the "talking to something alive" moment. Stages derive
 * from the item's staged enrichment updates riding the change feed (see
 * backend/src/enrichment.ts): interim "Understood — …" lands first (confidence set,
 * status still processing), subtasks stream in, then the final summary + active.
 */
interface Stage {
  label: string;
  done: boolean;
  detail: string | null;
}

function deriveStages(transcript: string, item: Item | undefined): Stage[] {
  const understood = item != null && item.confidence != null;
  const finalized = item != null && (item.status === 'active' || item.status === 'scheduled');
  const subtasks = item?.subtasks?.length ?? 0;
  return [
    { label: 'Heard you', done: true, detail: transcript },
    {
      label: 'Understanding',
      done: understood,
      detail: understood ? (item!.summary?.replace(/^Understood — /, '') ?? item!.title) : null,
    },
    {
      label: 'Breaking it down',
      done: finalized || subtasks > 0,
      detail:
        subtasks > 0
          ? `${subtasks} step${subtasks === 1 ? '' : 's'} ready`
          : finalized
            ? 'One clean action — nothing to split'
            : null,
    },
    {
      label: 'Locked in',
      done: finalized,
      detail: finalized
        ? item!.timeIntent?.at
          ? `I'll catch you — ${new Date(item!.timeIntent.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
          : item!.importance === 'major'
            ? 'On your calendar'
            : 'Safe in your queue'
        : null,
    },
  ];
}

function StageRow(props: { stage: Stage; active: boolean }) {
  const fade = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, [fade]);
  useEffect(() => {
    if (!props.active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 550, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [props.active, pulse]);

  const { stage } = props;
  return (
    <Animated.View
      style={[styles.stageRow, { opacity: fade }]}
      accessibilityLiveRegion={props.active ? 'polite' : 'none'}
    >
      <Animated.Text style={[styles.stageGlyph, props.active && { opacity: pulse }, stage.done && styles.stageGlyphDone]}>
        {stage.done ? '✓' : props.active ? '●' : '○'}
      </Animated.Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.stageLabel, stage.done && styles.stageLabelDone]}>{stage.label}</Text>
        {stage.detail ? (
          <Text style={styles.stageDetail} numberOfLines={2}>
            {stage.detail}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

export function CaptureScreen(props: { store: SyncStore; api: ApiClient; autoStartSignal?: number }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [typed, setTyped] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [speechOk, setSpeechOk] = useState<boolean | null>(null);
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  const [capturedText, setCapturedText] = useState('');
  const [version, setVersion] = useState(0);
  const session = useRef<DictationSession | null>(null);
  const lastAutoStart = useRef(0);
  const understoodHaptic = useRef(false);

  useEffect(() => {
    void isSpeechAvailable().then(setSpeechOk);
  }, []);

  // Re-render as staged enrichment updates land for the captured item.
  useEffect(() => {
    return props.store.subscribe(() => setVersion((v) => v + 1));
  }, [props.store]);

  const item = lastItemId ? props.store.items[lastItemId] : undefined;
  const stages = lastItemId ? deriveStages(capturedText, item) : null;
  const activeIndex = stages ? stages.findIndex((s) => !s.done) : -1;

  // A felt moment: one success tap when understanding lands.
  useEffect(() => {
    if (stages?.[1]?.done && !understoodHaptic.current) {
      understoodHaptic.current = true;
      if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }, [stages, version]);

  const save = async (text: string, source: 'voice' | 'typed') => {
    const clean = text.trim();
    if (!clean) return;
    setPhase('saving');
    // Spoken completion: "done with X" completes instead of creating.
    if (source === 'voice' && /^(done|finished|completed?)\b/i.test(clean)) {
      try {
        const res = await props.api.voiceDone(clean);
        setFeedback(res.message);
        await props.store.sync();
      } catch {
        setFeedback("Couldn't reach the server to complete that — try it from the queue.");
      }
      setPhase('idle');
      setTranscript('');
      return;
    }
    const item = await props.store.capture(clean, source);
    track('capture.completed', { surface, source });
    understoodHaptic.current = false;
    setCapturedText(clean);
    setLastItemId(item.id);
    setFeedback(null);
    setPhase('idle');
    setTranscript('');
    setTyped('');
  };

  const setWidgetRecording = (recording: boolean) => {
    if (Platform.OS !== 'android') return;
    void import('../widgets/refresh')
      .then((m) => m.setCaptureWidgetRecording(recording))
      .catch(() => {});
  };

  const toggleRecording = async () => {
    if (phase === 'recording') {
      session.current?.stop();
      return;
    }
    setFeedback(null);
    setTranscript('');
    setLastItemId(null);
    const s = await startDictation({
      onPartial: setTranscript,
      onFinal: (finalText) => {
        session.current = null;
        setPhase('idle');
        setWidgetRecording(false);
        void save(finalText, 'voice');
      },
      onError: (message) => {
        session.current = null;
        setPhase('idle');
        setWidgetRecording(false);
        if (message !== 'no-speech' && message !== 'aborted') {
          setFeedback(`I couldn't hear that (${message}) — typing works too.`);
        }
      },
    });
    if (s) {
      session.current = s;
      setPhase('recording');
      setWidgetRecording(true);
      if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } else {
      setSpeechOk(false);
      setFeedback('Voice input is not available here — type your item below.');
    }
  };

  // Widget/deep-link entry point (`scrible://capture?autostart=1`): start recording
  // the instant this screen is reached — one tap from the home screen to talking.
  useEffect(() => {
    const signal = props.autoStartSignal ?? 0;
    if (signal === lastAutoStart.current) return;
    lastAutoStart.current = signal;
    if (phase === 'idle' && speechOk !== false) void toggleRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.autoStartSignal]);

  return (
    <View style={styles.root}>
      <Text style={styles.hint}>
        {phase === 'recording' ? 'Listening — tap to finish' : "What's on your mind?"}
      </Text>
      <Pressable
        onPress={toggleRecording}
        style={[styles.mic, phase === 'recording' && styles.micActive]}
        accessibilityLabel={phase === 'recording' ? 'Stop recording' : 'Start recording'}
        accessibilityRole="button"
      >
        <Text style={styles.micIcon}>{phase === 'recording' ? '■' : '🎙'}</Text>
      </Pressable>
      {transcript ? <Text style={styles.transcript}>{transcript}</Text> : null}
      {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}

      {stages ? (
        <View style={styles.timeline} accessibilityLabel="Assistant progress">
          {stages.map((stage, i) => (
            <StageRow key={stage.label} stage={stage} active={i === activeIndex} />
          ))}
        </View>
      ) : null}

      <View style={styles.typedRow}>
        <TextInput
          style={styles.input}
          placeholder={speechOk === false ? 'Type your item…' : 'or type it…'}
          placeholderTextColor={colors.textDim}
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={() => void save(typed, 'typed')}
          returnKeyType="done"
        />
        <Pressable style={styles.addButton} onPress={() => void save(typed, 'typed')}>
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      </View>
      <Text style={styles.tip}>Say “done with …” to complete an item by voice.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hint: { color: colors.textDim, fontSize: 15, marginBottom: 28 },
  mic: {
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 8,
  },
  micActive: { backgroundColor: colors.danger },
  micIcon: { fontSize: 46 },
  transcript: { color: colors.text, fontSize: 18, marginTop: 26, textAlign: 'center' },
  feedback: { color: colors.reminder, fontSize: 15, marginTop: 18, textAlign: 'center' },
  timeline: {
    width: '100%',
    marginTop: 22,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  stageRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  stageGlyph: { color: colors.textDim, fontSize: 15, width: 18, textAlign: 'center', marginTop: 1 },
  stageGlyphDone: { color: colors.accent },
  stageLabel: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  stageLabelDone: { color: colors.text },
  stageDetail: { color: colors.textDim, fontSize: 12, marginTop: 2, lineHeight: 17 },
  typedRow: { flexDirection: 'row', marginTop: 28, width: '100%', gap: 10 },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    fontSize: 16,
    padding: 13,
  },
  addButton: { backgroundColor: colors.surfaceHigh, borderRadius: 12, paddingHorizontal: 18, justifyContent: 'center' },
  addButtonText: { color: colors.text, fontWeight: '600' },
  tip: { color: colors.textDim, fontSize: 12, marginTop: 14 },
});
