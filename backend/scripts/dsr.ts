/**
 * Data-subject request tooling (build plan §10.7).
 *
 * Usage (from backend/):
 *   npm run dsr -- export user@example.com          # access right → JSON to stdout
 *   npm run dsr -- delete user@example.com          # erasure right → delete + verify
 *   npm run dsr -- consent-history user@example.com # full consent record
 *
 * Every invocation writes an operator audit line to stderr. Deletion runs
 * verifyDeletion afterwards and exits non-zero if any residual rows remain.
 */
import { openDb, deleteAllUserData, verifyDeletion, USER_DATA_TABLES } from '../src/lib/db.js';

const [command, email] = process.argv.slice(2);
if (!command || !email || !['export', 'delete', 'consent-history'].includes(command)) {
  console.error('usage: npm run dsr -- <export|delete|consent-history> <email>');
  process.exit(2);
}

const db = openDb(process.env.DATABASE_PATH ?? 'scrible.db');
const user = db.prepare('SELECT id, email, created_at FROM users WHERE email = ?').get(email.toLowerCase()) as
  | { id: string; email: string; created_at: number }
  | undefined;
if (!user) {
  console.error(`no account for ${email}`);
  process.exit(1);
}
console.error(`[dsr-audit] ${new Date().toISOString()} command=${command} subject=${user.id} operator=${process.env.USER ?? 'unknown'}`);

if (command === 'consent-history') {
  const rows = db
    .prepare('SELECT category, policy_version, granted, created_at FROM consents WHERE user_id = ? ORDER BY created_at')
    .all(user.id);
  console.log(JSON.stringify(rows, null, 2));
} else if (command === 'export') {
  const out: Record<string, unknown> = { account: user, exportedAt: new Date().toISOString() };
  for (const table of USER_DATA_TABLES) {
    if (table === 'users') continue;
    out[table] = db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(user.id);
  }
  console.log(JSON.stringify(out, null, 2));
} else {
  const counts = deleteAllUserData(db, user.id);
  const residuals = verifyDeletion(db, user.id);
  const clean = Object.values(residuals).every((c) => c === 0);
  console.log(JSON.stringify({ deleted: counts, verification: residuals, clean }, null, 2));
  if (!clean) {
    console.error('[dsr-audit] VERIFICATION FAILED — residual rows remain');
    process.exit(1);
  }
  console.error(`[dsr-audit] deletion verified clean across ${USER_DATA_TABLES.length} tables`);
}
