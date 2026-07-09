import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';

export function registerDevices(app: FastifyInstance, db: Db): void {
  app.post('/v1/devices', { preHandler: app.authenticate }, async (req, reply) => {
    const { platform, pushToken, capabilities, deviceId } = (req.body ?? {}) as {
      platform?: string;
      pushToken?: string;
      capabilities?: Record<string, unknown>;
      deviceId?: string;
    };
    if (!platform || !['ios', 'android', 'web', 'extension', 'desktop'].includes(platform)) {
      return reply.code(400).send({ error: 'platform must be ios|android|web|extension|desktop' });
    }
    const id = deviceId ?? randomUUID();
    const existing = await db
      .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?')
      .get(id, req.userId);
    if (existing) {
      await db.prepare('UPDATE devices SET push_token = ?, capabilities = ?, last_seen = ? WHERE id = ?').run(
        pushToken ?? null,
        JSON.stringify(capabilities ?? {}),
        Date.now(),
        id,
      );
      return { id };
    }
    await db.prepare(
      'INSERT INTO devices (id, user_id, platform, push_token, capabilities, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, req.userId, platform, pushToken ?? null, JSON.stringify(capabilities ?? {}), Date.now(), Date.now());
    return reply.code(201).send({ id });
  });

  app.get('/v1/devices', { preHandler: app.authenticate }, async (req) => {
    const rows = (await db
      .prepare('SELECT id, platform, push_token, capabilities, last_seen, created_at FROM devices WHERE user_id = ?')
      .all(req.userId)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      // Never the token itself over the API — only whether one is on file.
      hasPushToken: r.push_token != null,
      capabilities: JSON.parse(String(r.capabilities)),
      lastSeen: r.last_seen,
      createdAt: r.created_at,
    }));
  });

  app.post('/v1/devices/:id/ping', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND user_id = ?').run(
      Date.now(),
      id,
      req.userId,
    );
    return { ok: true };
  });

  app.delete('/v1/devices/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    await db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(id, req.userId);
    return { ok: true };
  });
}
