import { buildApp } from './server.js';
import { enableEnrichment } from './enrichment.js';

const ctx = buildApp();
enableEnrichment(ctx);
ctx.reminders.start();

// Reconciliation sweep as webhook backstop (build plan §7.2): periodically re-pull
// every linked user's calendars so external chaos is never missed.
const SWEEP_MS = Number(process.env.CALENDAR_SWEEP_MS ?? 5 * 60_000);
const sweep = setInterval(() => {
  const users = ctx.db.prepare('SELECT DISTINCT user_id FROM calendar_links').all() as Array<{
    user_id: string;
  }>;
  for (const u of users) void ctx.calendar.syncUser(u.user_id).catch(() => {});
}, SWEEP_MS);
sweep.unref?.();

ctx.app
  .listen({ port: ctx.config.port, host: '0.0.0.0' })
  .then(() => console.log(`scrible backend listening on :${ctx.config.port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
