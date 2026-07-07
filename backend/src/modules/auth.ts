import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../lib/db.js';
import { signToken, verifyToken } from '../lib/jwt.js';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function registerAuth(app: FastifyInstance, db: Db, jwtSecret: string): void {
  app.decorateRequest('userId', '');
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyToken(token, jwtSecret) : null;
    if (!payload) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(payload.sub);
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.userId = payload.sub;
  });

  app.post('/v1/auth/signup', async (req, reply) => {
    const { email, password, timezone } = (req.body ?? {}) as {
      email?: string;
      password?: string;
      timezone?: string;
    };
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: 'invalid email' });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return reply.code(409).send({ error: 'account exists' });
    const id = randomUUID();
    db.prepare(
      'INSERT INTO users (id, email, password_hash, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, email.toLowerCase(), hashPassword(password), timezone ?? 'UTC', Date.now());
    const token = signToken({ sub: id }, jwtSecret);
    return reply.code(201).send({ token, user: { id, email: email.toLowerCase() } });
  });

  app.post('/v1/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const row = db
      .prepare('SELECT id, password_hash FROM users WHERE email = ?')
      .get((email ?? '').toLowerCase()) as { id: string; password_hash: string } | undefined;
    if (!row || !password || !verifyPassword(password, row.password_hash)) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const token = signToken({ sub: row.id }, jwtSecret);
    return { token, user: { id: row.id, email: (email ?? '').toLowerCase() } };
  });

  // Sign in with Apple / Google: production requires provider id-token verification
  // (JWKS) + app credentials. The endpoint shape is fixed now so clients don't churn;
  // enablement is a Phase 5 store-compliance work item (see docs/compliance).
  app.post('/v1/auth/social', async (_req, reply) =>
    reply.code(501).send({ error: 'social sign-in requires provider credentials; see docs' }),
  );

  app.get('/v1/me', { preHandler: app.authenticate }, async (req) => {
    const u = db
      .prepare('SELECT id, email, timezone, working_hours, notification_prefs, created_at FROM users WHERE id = ?')
      .get(req.userId) as Record<string, unknown>;
    return {
      id: u.id,
      email: u.email,
      timezone: u.timezone,
      workingHours: JSON.parse(String(u.working_hours)),
      notificationPrefs: JSON.parse(String(u.notification_prefs)),
      createdAt: u.created_at,
    };
  });

  app.patch('/v1/me', { preHandler: app.authenticate }, async (req) => {
    const { timezone, workingHours, notificationPrefs } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof timezone === 'string') {
      db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(timezone, req.userId);
    }
    if (workingHours && typeof workingHours === 'object') {
      db.prepare('UPDATE users SET working_hours = ? WHERE id = ?').run(
        JSON.stringify(workingHours),
        req.userId,
      );
    }
    if (notificationPrefs && typeof notificationPrefs === 'object') {
      db.prepare('UPDATE users SET notification_prefs = ? WHERE id = ?').run(
        JSON.stringify(notificationPrefs),
        req.userId,
      );
    }
    return { ok: true };
  });
}
