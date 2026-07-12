#!/usr/bin/env node
/**
 * Live comprehension probe. Run after EVERY Render deploy, before telling the user
 * anything works: feeds scripts/corpus.txt (messy real speech, including every
 * utterance that ever failed) to the deployed backend and fails loudly if the
 * assistant's understanding regresses.
 *
 *   node backend/scripts/probe.mjs                    # against production
 *   PROBE_URL=http://localhost:8787 node backend/scripts/probe.mjs
 *
 * Exit 1 when: a title is a verbatim echo of the raw text (old code still live),
 * "in the next minute" resolves > 5 minutes out (time hallucination), or the
 * metrics show heuristic-confident classify calls (impossible on current code when
 * an LLM key is configured).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.PROBE_URL ?? 'https://scribble-rjma.onrender.com';
const corpus = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'corpus.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

const req = async (method, path, body, token) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
};

// Probe as an IST user — the timezone the real user lives in. Wall-clock corpus
// lines ("at 12") must resolve in THIS clock, not the server's UTC.
const TZ = process.env.PROBE_TZ ?? 'Asia/Kolkata';
const email = `probe-${Date.now()}@example.com`;
const { token } = await req('POST', '/v1/auth/signup', { email, password: 'ProbePass123!', timezone: TZ });
console.log(`probing ${BASE} as ${email} (timezone ${TZ})\n`);

const hourIn = (epochMs, tz) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date(epochMs)));

const failures = [];
const rows = [];
for (let i = 0; i < corpus.length; i++) {
  const rawText = corpus[i];
  const id = `probe-${Date.now()}-${i}`;
  await req('POST', '/v1/items', { id, rawText, source: 'voice' }, token);
  // Enrichment is async and can queue up under probe load — poll until it settles
  // (a 'processing' item isn't a comprehension failure, it's an unfinished one).
  let item;
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    item = await req('GET', `/v1/items/${id}`, undefined, token);
    if (item.status !== 'captured' && item.status !== 'processing') break;
  }
  const at = item.timeIntent?.at ?? null;
  rows.push({
    text: rawText.slice(0, 48),
    type: item.type,
    title: (item.title ?? '').slice(0, 44),
    time: at ? new Date(at).toISOString().slice(5, 16) : '-',
    imp: item.importance,
    steps: item.subtasks?.length ?? 0,
    status: item.status,
  });

  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const settled = item.status !== 'captured' && item.status !== 'processing';
  if (settled && normalize(item.title) === normalize(rawText) && rawText.split(' ').length > 6) {
    failures.push(`VERBATIM ECHO (old code live?): "${rawText.slice(0, 60)}"`);
  }
  if (!settled) {
    failures.push(`STUCK IN PROCESSING after 24s: "${rawText.slice(0, 60)}"`);
  }
  if (item.type && !['task', 'idea', 'reminder'].includes(item.type)) {
    failures.push(`INVALID TYPE "${item.type}" reached the database: "${rawText.slice(0, 60)}"`);
  }
  if (/in the next minute/i.test(rawText) && at && at - Date.now() > 5 * 60_000) {
    failures.push(`TIME HALLUCINATION: "in the next minute" resolved to ${new Date(at).toISOString()}`);
  }
  if (/go to the gym at 5:30/i.test(rawText) && (item.subtasks?.length ?? 0) > 0) {
    failures.push(`BUSYWORK DECOMPOSITION: "${rawText}" got ${item.subtasks.length} steps (should be 0)`);
  }
  if (/drink water at 12$/i.test(rawText)) {
    if (!at) failures.push(`NO TIME RESOLVED for "at 12"`);
    else {
      const h = hourIn(at, TZ);
      if (h !== 12 && h !== 0) {
        failures.push(
          `TIMEZONE BUG: "at 12" resolved to ${h}:xx in ${TZ} (${new Date(at).toISOString()}) — wall-clock times must resolve in the USER's timezone`,
        );
      }
    }
  }
}

console.table(rows);
const metrics = await req('GET', '/v1/ai/metrics', undefined, token);
const classify = metrics.byCapability?.classify ?? {};
console.log('classify providers:', Object.fromEntries(Object.entries(classify).map(([k, v]) => [k, v.calls])));
if (classify['heuristic-confident']) {
  failures.push('heuristic-confident classify calls present — the AI-first chain is NOT deployed');
}

if (failures.length > 0) {
  console.error('\nPROBE FAILED:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nPROBE PASSED — comprehension quality holds on the live backend.');
