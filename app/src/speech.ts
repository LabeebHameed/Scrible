/**
 * Speech-to-text abstraction (build plan §2.2: on-device first).
 * - Web: Web Speech API (Chrome/Edge/Safari).
 * - iOS/Android: expo-speech-recognition (SFSpeechRecognizer / SpeechRecognizer)
 *   — requires a dev/EAS build; in Expo Go the module is unavailable and the UI
 *   falls back to typed input (voice-first, not voice-only).
 */
import { Platform } from 'react-native';

export interface DictationHandlers {
  onPartial(transcript: string): void;
  onFinal(transcript: string): void;
  onError(message: string): void;
}

export interface DictationSession {
  stop(): void;
}

export async function isSpeechAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') {
    const w = globalThis as Record<string, unknown>;
    return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
  }
  try {
    const mod = await import('expo-speech-recognition');
    return await mod.ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

export async function startDictation(h: DictationHandlers): Promise<DictationSession | null> {
  if (Platform.OS === 'web') return startWeb(h);
  return startNative(h);
}

function startWeb(h: DictationHandlers): DictationSession | null {
  const w = globalThis as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => WebSpeechRecognition)
    | undefined;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  let finalText = '';
  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    h.onPartial((finalText + interim).trim());
  };
  rec.onerror = (event) => h.onError(event.error ?? 'speech error');
  rec.onend = () => h.onFinal(finalText.trim());
  rec.start();
  return { stop: () => rec.stop() };
}

async function startNative(h: DictationHandlers): Promise<DictationSession | null> {
  try {
    const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      h.onError('microphone permission denied');
      return null;
    }
    let latest = '';
    const resultSub = ExpoSpeechRecognitionModule.addListener('result', (event) => {
      const transcript = event.results?.[0]?.transcript ?? '';
      latest = transcript;
      h.onPartial(transcript);
    });
    const endSub = ExpoSpeechRecognitionModule.addListener('end', () => {
      resultSub.remove();
      endSub.remove();
      errSub.remove();
      h.onFinal(latest.trim());
    });
    const errSub = ExpoSpeechRecognitionModule.addListener('error', (event) => {
      h.onError(event.message ?? event.error ?? 'speech error');
    });
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
    });
    return { stop: () => ExpoSpeechRecognitionModule.stop() };
  } catch {
    // Module not present (Expo Go) — caller falls back to text input.
    return null;
  }
}

/* Minimal Web Speech API typings (not in RN's lib set). */
interface WebSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: WebSpeechResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface WebSpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
