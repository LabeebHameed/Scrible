/**
 * Context engine (Phase 8): pattern → outcome evidence learned from the user's own
 * corrections and edits. Lives only in `learned_signals`; applied in code, NEVER
 * appended to LLM prompts (see providers/learned.ts, docs/AI-MAP.md). Every prompt
 * input to Claude stays hard-capped regardless of how much has been learned here.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../lib/db.js';
import { contentTokens } from './providers/heuristic.js';
import type { ItemType } from '../types.js';

/** Hard cap enforced by prune() — natural decay keeps recent patterns dominant. */
const CAP_PER_USER = 200;
const CONFIRM_WEIGHT = 1;
const DISCONFIRM_WEIGHT = 0.5;

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function keysFor(text: string): string[] {
  const tokens = contentTokens(text);
  return [...new Set([...tokens, ...bigrams(tokens)])];
}

function upsert(db: Db, userId: string, kind: string, key: string, value: string, delta: number): void {
  const row = db
    .prepare('SELECT weight FROM learned_signals WHERE user_id = ? AND kind = ? AND key = ? AND value = ?')
    .get(userId, kind, key, value) as { weight: number } | undefined;
  const next = Math.max(0, (row?.weight ?? 0) + delta);
  if (row) {
    if (next <= 0) {
      db.prepare('DELETE FROM learned_signals WHERE user_id = ? AND kind = ? AND key = ? AND value = ?').run(
        userId,
        kind,
        key,
        value,
      );
    } else {
      db.prepare(
        'UPDATE learned_signals SET weight = ?, updated_at = ? WHERE user_id = ? AND kind = ? AND key = ? AND value = ?',
      ).run(next, Date.now(), userId, kind, key, value);
    }
  } else if (next > 0) {
    db.prepare(
      'INSERT INTO learned_signals (id, user_id, kind, key, value, weight, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), userId, kind, key, value, next, Date.now());
  }
}

/** A user corrected an item's type (fromType → toType) — the strongest teaching signal. */
export function learnFromCorrection(
  db: Db,
  userId: string,
  itemText: string,
  fromType: ItemType,
  toType: ItemType,
): void {
  if (fromType === toType) return;
  for (const key of keysFor(itemText)) {
    upsert(db, userId, 'type_prior', key, toType, CONFIRM_WEIGHT);
    upsert(db, userId, 'type_prior', key, fromType, -DISCONFIRM_WEIGHT);
  }
  prune(db, userId);
}

/** A user manually set an app-launch trigger — associate the item's tokens with it. */
export function learnAppAlias(db: Db, userId: string, itemText: string, appTrigger: string): void {
  const trigger = appTrigger.trim().toLowerCase();
  if (!trigger) return;
  for (const key of keysFor(itemText)) {
    upsert(db, userId, 'app_alias', key, trigger, CONFIRM_WEIGHT);
  }
  prune(db, userId);
}

/** Aggregate type-prior evidence for a piece of text, strongest type first. */
export function typePriors(db: Db, userId: string, text: string): Array<{ type: ItemType; score: number }> {
  const keys = keysFor(text);
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT value, weight FROM learned_signals WHERE user_id = ? AND kind = 'type_prior' AND key IN (${placeholders})`,
    )
    .all(userId, ...keys) as Array<{ value: string; weight: number }>;
  // Max per type (not sum across keys): a correction bumps every one of its keys by
  // the same amount, so summing would let a single correction's several keys (token +
  // bigrams) look like several corrections. The strongest single matching key is the
  // true repetition count for that type.
  const maxByType = new Map<string, number>();
  for (const r of rows) maxByType.set(r.value, Math.max(maxByType.get(r.value) ?? 0, r.weight));
  return [...maxByType.entries()]
    .map(([type, score]) => ({ type: type as ItemType, score }))
    .sort((a, b) => b.score - a.score);
}

/** Strongest learned app-alias match for a piece of text, if any. */
export function appAliasFor(db: Db, userId: string, text: string): { value: string; score: number } | null {
  const keys = keysFor(text);
  if (keys.length === 0) return null;
  const placeholders = keys.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT value, weight FROM learned_signals WHERE user_id = ? AND kind = 'app_alias' AND key IN (${placeholders})`,
    )
    .all(userId, ...keys) as Array<{ value: string; weight: number }>;
  if (rows.length === 0) return null;
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.value, (totals.get(r.value) ?? 0) + r.weight);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length ? { value: sorted[0]![0], score: sorted[0]![1] } : null;
}

/** All single-token key weights, summed across kinds — used to sharpen matchDone scoring. */
export function keyWeights(db: Db, userId: string): Map<string, number> {
  const rows = db
    .prepare("SELECT key, SUM(weight) AS w FROM learned_signals WHERE user_id = ? AND key NOT LIKE '% %' GROUP BY key")
    .all(userId) as Array<{ key: string; w: number }>;
  return new Map(rows.map((r) => [r.key, r.w]));
}

/** Hard cap (build plan invariant): halve all weights and drop weak rows, then trim to the cap. */
export function prune(db: Db, userId: string): void {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM learned_signals WHERE user_id = ?').get(userId) as {
    c: number;
  };
  if (c <= CAP_PER_USER) return;
  db.prepare('UPDATE learned_signals SET weight = weight / 2 WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM learned_signals WHERE user_id = ? AND weight < 0.5').run(userId);
  const { c: after } = db.prepare('SELECT COUNT(*) AS c FROM learned_signals WHERE user_id = ?').get(userId) as {
    c: number;
  };
  if (after > CAP_PER_USER) {
    db.prepare(
      `DELETE FROM learned_signals WHERE id IN (
        SELECT id FROM learned_signals WHERE user_id = ? ORDER BY weight ASC, updated_at ASC LIMIT ?
      )`,
    ).run(userId, after - CAP_PER_USER);
  }
}

/** Top-15 single-token keys by weight — feeds the profile's already-capped vocabulary field. */
export function learnedVocabulary(db: Db, userId: string): string[] {
  const rows = db
    .prepare(
      "SELECT key, SUM(weight) AS w FROM learned_signals WHERE user_id = ? AND key NOT LIKE '% %' GROUP BY key ORDER BY w DESC LIMIT 15",
    )
    .all(userId) as Array<{ key: string; w: number }>;
  return rows.map((r) => r.key);
}

/** Plain-language transparency summary for GET /v1/profile. */
export function learnedSummary(db: Db, userId: string): { counts: Record<string, number>; patterns: string[] } {
  const rows = db
    .prepare('SELECT kind, key, value, weight FROM learned_signals WHERE user_id = ? ORDER BY weight DESC')
    .all(userId) as Array<{ kind: string; key: string; value: string; weight: number }>;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const patterns = rows
    .filter((r) => !r.key.includes(' '))
    .slice(0, 10)
    .map((r) => {
      const n = Math.max(1, Math.round(r.weight));
      if (r.kind === 'type_prior') return `"${r.key}" → ${r.value} (learned from ${n} correction${n === 1 ? '' : 's'})`;
      if (r.kind === 'app_alias') return `"${r.key}" → opens ${r.value} (learned from ${n} edit${n === 1 ? '' : 's'})`;
      return `${r.key} → ${r.value}`;
    });
  return { counts, patterns };
}
