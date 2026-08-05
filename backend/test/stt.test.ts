import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from '../src/lib/stt.js';

test('transcribeAudio returns null if GROQ_API_KEY is not set', async () => {
  const result = await transcribeAudio({ buffer: Buffer.from('fake audio') }, undefined);
  assert.equal(result, null);
});

test('transcribeAudio handles invalid API response gracefully', async () => {
  const result = await transcribeAudio({ buffer: Buffer.from('fake audio') }, 'invalid_key_123');
  assert.equal(result, null);
});
