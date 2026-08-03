/**
 * At-rest encryption for calendar OAuth tokens (build plan §4: stored encrypted,
 * never exposed to clients). AES-256-GCM with an app-layer key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key(): Buffer {
  const secret = process.env.TOKEN_ENC_KEY ?? 'dev-token-key-do-not-use-in-production';
  if (process.env.NODE_ENV === 'production' && !process.env.TOKEN_ENC_KEY) {
    throw new Error('TOKEN_ENC_KEY is required in production');
  }
  return createHash('sha256').update(secret).digest();
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split('.');
  if (!iv || !tag || !data) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
