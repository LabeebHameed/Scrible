/**
 * Speech-to-Text module using Groq Whisper v3 Turbo API (free tier: 2,000 mins/day).
 * Falls back gracefully if GROQ_API_KEY is not set or network fails.
 */

export interface TranscribeOptions {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
}

export async function transcribeAudio(
  options: TranscribeOptions,
  apiKey: string | undefined = process.env.GROQ_API_KEY
): Promise<string | null> {
  if (!apiKey) {
    console.warn('[STT] GROQ_API_KEY is not configured — skipping cloud transcription.');
    return null;
  }

  const mime = (options.mimeType || 'audio/m4a').toLowerCase();
  let ext = 'm4a';
  if (mime.includes('webm')) ext = 'webm';
  else if (mime.includes('wav')) ext = 'wav';
  else if (mime.includes('ogg')) ext = 'ogg';
  else if (mime.includes('mp3') || mime.includes('mpeg')) ext = 'mp3';
  
  const filename = options.filename || `recording.${ext}`;

  try {
    const formData = new FormData();
    const blob = new Blob([options.buffer], { type: mime });
    formData.append('file', blob, filename);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[STT] Groq API error (${res.status}):`, errText);
      return null;
    }

    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    console.error('[STT] Audio transcription failed:', err);
    return null;
  }
}
