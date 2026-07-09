/**
 * Data layer — Postgres (ADR 0001 §3: the schema was written in portable SQL from
 * day one specifically so this swap would be a single-module change). `Db` wraps a
 * `pg.Pool` behind the same `.prepare(sql).get/all/run(...)` shape the rest of the
 * codebase already used against `node:sqlite`, so callers only needed `await` added
 * — not a query rewrite. `?` placeholders are translated to Postgres's `$1..$n`
 * positionally; every query in this codebase is a static first-party string, never
 * user-supplied SQL, so that translation is safe.
 */
import pg from 'pg';

// pg returns BIGINT (OID 20) as strings by default, to avoid silently truncating
// values beyond Number.MAX_SAFE_INTEGER. Every BIGINT column here is an epoch-ms
// timestamp or an identity sequence — both comfortably within safe-integer range —
// and the rest of the codebase expects plain JS numbers (arithmetic, Date, JSON),
// so parse BIGINT as a number globally rather than converting at every call site.
pg.types.setTypeParser(20, (val: string) => Number(val));

export interface RunResult {
  changes: number;
  rows: unknown[];
}

export interface PreparedStatement {
  get(...args: unknown[]): Promise<unknown>;
  all(...args: unknown[]): Promise<unknown[]>;
  run(...args: unknown[]): Promise<RunResult>;
}

/** Translate `?` positional placeholders to `$1..$n`, skipping `?` inside string literals. */
function toPositional(sql: string): string {
  let out = '';
  let inString = false;
  let n = 0;
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    if (ch === '?' && !inString) {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

class PgDb {
  constructor(private pool: pg.Pool) {}

  prepare(sql: string): PreparedStatement {
    const text = toPositional(sql);
    const query = async (args: unknown[]) => this.pool.query(text, args);
    return {
      async get(...args) {
        const res = await query(args);
        return res.rows[0];
      },
      async all(...args) {
        const res = await query(args);
        return res.rows;
      },
      async run(...args) {
        const res = await query(args);
        return { changes: res.rowCount ?? 0, rows: res.rows };
      },
    };
  }

  /** Multi-statement raw SQL (schema/migrations) — no params, simple query protocol. */
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /** Runs `fn` against a single checked-out connection wrapped in BEGIN/COMMIT/ROLLBACK. */
  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const scoped = new PgDb({ query: client.query.bind(client) } as unknown as pg.Pool);
    try {
      await client.query('BEGIN');
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export type Db = PgDb;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  working_hours TEXT NOT NULL DEFAULT '{"start":9,"end":18,"days":[1,2,3,4,5]}',
  notification_prefs TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  granted INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS idx_consents_user ON consents(user_id, category, created_at);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'task',
  source TEXT NOT NULL DEFAULT 'typed',
  raw_text TEXT NOT NULL,
  title TEXT NOT NULL,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'captured',
  context_tag TEXT,
  app_trigger TEXT,
  time_intent TEXT,
  summary TEXT,
  field_versions TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'user',
  completed_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subtasks_item ON subtasks(item_id, position);

CREATE TABLE IF NOT EXISTS schedule_blocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  subtask_id TEXT,
  start_ts BIGINT NOT NULL,
  end_ts BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed',
  calendar_link_id TEXT,
  external_event_id TEXT,
  rationale TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_user ON schedule_blocks(user_id, start_ts);

CREATE TABLE IF NOT EXISTS reminder_triggers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  fire_at BIGINT NOT NULL,
  recurrence TEXT,
  channels TEXT NOT NULL DEFAULT '["push"]',
  snoozed_until BIGINT,
  delivered_at BIGINT,
  seen_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminder_triggers(fire_at, delivered_at);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,
  push_token TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}',
  last_seen BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS calendar_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  token_ref TEXT NOT NULL,
  selected_calendars TEXT NOT NULL DEFAULT '[]',
  sync_state TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  attributes TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  storage TEXT NOT NULL DEFAULT 'server',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  retention_deadline BIGINT NOT NULL,
  raw_ref TEXT,
  deleted_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  calendar_link_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  start_ts BIGINT NOT NULL,
  end_ts BIGINT NOT NULL,
  busy INTEGER NOT NULL DEFAULT 1,
  foreign_event INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cal_events_user ON calendar_events(user_id, start_ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_events_ext ON calendar_events(calendar_link_id, external_id);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT,
  block_id TEXT,
  undoable INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, created_at);

CREATE TABLE IF NOT EXISTS push_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_dedup ON push_outbox(user_id, dedup_key);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  reversible INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

CREATE TABLE IF NOT EXISTS changes (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  data TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_user ON changes(user_id, seq);

CREATE TABLE IF NOT EXISTS analytics_ids (
  user_id TEXT PRIMARY KEY,
  pseudo_id TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

-- Deliberately NO user_id column: events are keyed by pseudo_id only, so erasing
-- the analytics_ids mapping permanently unlinks history from the account.
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  pseudo_id TEXT NOT NULL,
  event TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_events ON analytics_events(event, ts);

-- Context engine (Phase 8): capped pattern→outcome evidence learned from the user's
-- own corrections/edits. Applied in code, NEVER appended to prompts.
CREATE TABLE IF NOT EXISTS learned_signals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  weight REAL NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, kind, key, value)
);
CREATE INDEX IF NOT EXISTS idx_learned_user ON learned_signals(user_id, kind, key);

CREATE TABLE IF NOT EXISTS processed_ops (
  op_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
`;

/** Tables holding per-user rows, in FK-safe deletion order (account deletion path). */
export const USER_DATA_TABLES = [
  'learned_signals',
  'analytics_ids',
  'processed_ops',
  'changes',
  'audit_log',
  'push_outbox',
  'activity',
  'calendar_events',
  'import_jobs',
  'profiles',
  'calendar_links',
  'devices',
  'reminder_triggers',
  'schedule_blocks',
  'subtasks',
  'items',
  'consents',
  'users',
] as const;

export async function openDb(connectionString: string): Promise<Db> {
  const pool = new pg.Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  const db = new PgDb(pool);
  await db.exec(SCHEMA);
  // Additive migration for pre-existing databases (CREATE TABLE IF NOT EXISTS won't
  // alter an existing table); Postgres's IF NOT EXISTS makes this idempotent natively.
  await db.exec('ALTER TABLE items ADD COLUMN IF NOT EXISTS app_trigger TEXT');
  return db;
}

/**
 * DSR verification: proves no row referencing the user survives in any user-data
 * table. Returns per-table residual counts (all zero after a correct deletion).
 */
export async function verifyDeletion(db: Db, userId: string): Promise<Record<string, number>> {
  const residuals: Record<string, number> = {};
  for (const table of USER_DATA_TABLES) {
    const col = table === 'users' ? 'id' : 'user_id';
    const row = (await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).get(userId)) as {
      c: string | number;
    };
    residuals[table] = Number(row.c);
  }
  return residuals;
}

export async function deleteAllUserData(db: Db, userId: string): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const counts: Record<string, number> = {};
    for (const table of USER_DATA_TABLES) {
      const col = table === 'users' ? 'id' : 'user_id';
      const res = await tx.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(userId);
      counts[table] = Number(res.changes);
    }
    return counts;
  });
}
