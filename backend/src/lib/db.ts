/**
 * Data layer. SQLite via the Node built-in for dev/test; the schema is written in
 * portable SQL so production swaps this module for a Postgres pool (ADR 0001 §3).
 */
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  working_hours TEXT NOT NULL DEFAULT '{"start":9,"end":18,"days":[1,2,3,4,5]}',
  notification_prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  granted INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'user',
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subtasks_item ON subtasks(item_id, position);

CREATE TABLE IF NOT EXISTS schedule_blocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  subtask_id TEXT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed',
  calendar_link_id TEXT,
  external_event_id TEXT,
  rationale TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_user ON schedule_blocks(user_id, start_ts);

CREATE TABLE IF NOT EXISTS reminder_triggers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  fire_at INTEGER NOT NULL,
  recurrence TEXT,
  channels TEXT NOT NULL DEFAULT '["push"]',
  snoozed_until INTEGER,
  delivered_at INTEGER,
  seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminder_triggers(fire_at, delivered_at);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,
  push_token TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}',
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  attributes TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  storage TEXT NOT NULL DEFAULT 'server',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  retention_deadline INTEGER NOT NULL,
  raw_ref TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  calendar_link_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  busy INTEGER NOT NULL DEFAULT 1,
  foreign_event INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  data TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_user ON changes(user_id, seq);

CREATE TABLE IF NOT EXISTS analytics_ids (
  user_id TEXT PRIMARY KEY,
  pseudo_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Deliberately NO user_id column: events are keyed by pseudo_id only, so erasing
-- the analytics_ids mapping permanently unlinks history from the account.
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  pseudo_id TEXT NOT NULL,
  event TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_events ON analytics_events(event, ts);

CREATE TABLE IF NOT EXISTS processed_ops (
  op_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** Tables holding per-user rows, in FK-safe deletion order (account deletion path). */
export const USER_DATA_TABLES = [
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

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Additive migrations for pre-existing dev databases (CREATE TABLE IF NOT EXISTS
  // won't alter an existing table).
  try {
    db.exec('ALTER TABLE items ADD COLUMN app_trigger TEXT');
  } catch {
    /* column already exists */
  }
  return db;
}

/**
 * DSR verification: proves no row referencing the user survives in any user-data
 * table. Returns per-table residual counts (all zero after a correct deletion).
 */
export function verifyDeletion(db: Db, userId: string): Record<string, number> {
  const residuals: Record<string, number> = {};
  for (const table of USER_DATA_TABLES) {
    const col = table === 'users' ? 'id' : 'user_id';
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).get(userId) as { c: number };
    residuals[table] = Number(row.c);
  }
  return residuals;
}

export function deleteAllUserData(db: Db, userId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  db.exec('BEGIN');
  try {
    for (const table of USER_DATA_TABLES) {
      const col = table === 'users' ? 'id' : 'user_id';
      const res = db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(userId);
      counts[table] = Number(res.changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return counts;
}
