/** Minimal HS256 JWT — no external dependency. */
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url');

export interface TokenPayload {
  sub: string;
  exp: number;
  [k: string]: unknown;
}

export function signToken(
  payload: Omit<TokenPayload, 'exp'>,
  secret: string,
  ttlMs = 30 * 24 * 3600 * 1000,
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.sub !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}
