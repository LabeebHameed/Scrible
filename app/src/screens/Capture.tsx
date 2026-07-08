import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { SyncStore } from '../store';
import type { ApiClient } from '../api';
import { isSpeechAvailable, startDictation, type DictationSession } from '../speech';
import { surface, track } from '../analytics';
import { colors } from '../theme';

type Phase = 'idle' | 'recording' | 'saving';

export function CaptureScreen(props: { store: SyncStore; api: ApiClient }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [typed, setTyped] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [speechOk, setSpeechOk] = useState<boolean | null>(null);
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  const session = useRef<DictationSession | null>(null);

  useEffect(() => {
    void isSpeechAvailable().then(setSpeechOk);
  }, []);

  // Live enrichment feedback: when the captured item's summary arrives, show it.
  useEffect(() => {
    return props.store.subscribe(() => {
      if (lastItemId) {
        const item = props.store.items[lastItemId];
        if (item?.summary) setFeedback(item.summary);
      }
    });
  }, [lastItemId, props.store]);

  const save = async (text: string, source: 'voice' | 'typed') => {
    const clean = text.trim();
    if (!clean) return;
    setPhase('saving');
    // Spoken completion: "done with X" completes instead of creating (plan §6.5).
    if (source === 'voice' && /^(done|finished|completed?)\b/i.test(clean)) {
      try {
        const res = await props.api.voiceDone(clean);
        setFeedback(res.message);
        await props.store.sync();
      } catch {
        setFeedback("Couldn't reach the server to complete that — try from the queue.");
      }
      setPhase('idle');
      setTranscript('');
      return;
    }
    const item = await props.store.capture(clean, source);
    track('capture.completed', { surface, source });
    setLastItemId(item.id);
    setFeedback(`Got it — "${item.title}". Understanding it…`);
    setPhase('idle');
    setTranscript('');
    setTyped('');
  };

  const toggleRecording = async () => {
    if (phase === 'recording') {
      session.current?.stop();
      return;
    }
    setFeedback(null);
    setTranscript('');
    const s = await startDictation({
      onPartial: setTranscript,
      onFinal: (finalText) => {
        session.current = null;
        setPhase('idle');
        void save(finalText, 'voice');
      },
      onError: (message) => {
        session.current = null;
        setPhase('idle');
        if (message !== 'no-speech' && message !== 'aborted') {
          setFeedback(`Speech recognition problem (${message}). You can type instead.`);
        }
      },
    });
    if (s) {
      session.current = s;
      setPhase('recording');
    } else {
      setSpeechOk(false);
      setFeedback('Voice input is not available here — type your item below.');
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.hint}>
        {phase === 'recording' ? 'Listening — tap to finish' : 'Tap and speak a task, idea, or reminder'}
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
  typedRow: { flexDirection: 'row', marginTop: 40, width: '100%', gap: 10 },
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
