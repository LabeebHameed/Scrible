import { buildApp, type AppContext } from '../src/server.js';
import { enableEnrichment } from '../src/enrichment.js';

let counter = 0;

export function testApp(flags?: Partial<AppContext['config']['flags']>): AppContext {
  const ctx = buildApp({
    databasePath: ':memory:',
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
