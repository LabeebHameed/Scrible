import pg from 'pg';
import { buildApp, type AppContext } from '../src/server.js';
import { enableEnrichment } from '../src/enrichment.js';

let counter = 0;

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/scrible_test';

/**
 * Full reset before every testApp() call — matches the old :memory:-per-call
 * isolation. Exported for tests that call buildApp() directly (bypassing testApp())
 * to pass extra Config overrides testApp()'s flags-only signature doesn't cover.
 */
export async function resetTestSchema(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await pool.end();
  }
}

export async function testApp(flags?: Partial<AppContext['config']['flags']>): Promise<AppContext> {
  await resetTestSchema();
  const ctx = await buildApp({
    databaseUrl: TEST_DATABASE_URL,
    jwtSecret: 'test-secret',
    flags: {
      autoClassify: false,
      autoSchedule: false,
      personalization: false,
      analytics: false,
      ...flags,
    },
  });
  enableEnrichment(ctx);
  return ctx;
}

export async function signup(
  ctx: AppContext,
  email = `user${++counter}@test.dev`,
): Promise<{ token: string; userId: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'password123' },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const body = res.json() as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
