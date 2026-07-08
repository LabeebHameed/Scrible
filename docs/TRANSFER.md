# Scrible — Engineering Transfer / Handoff

This document hands the Scrible codebase to a new agent or engineer. It explains
what exists, how it is structured, how to run and test it, the conventions to keep,
and the remaining pre-launch work. Read this first, then `docs/BUILD_PLAN.md`
(the product spec) and `docs/decisions/0001-phase-0-tech-stack.md` (why the stack).

Last updated at the end of **Phase 8** — all build-plan phases are implemented, plus
a post-launch context engine. §6 below lists the remaining pre-launch work (device
QA, chaos/load drills, store submission).

---

## 1. TL;DR — current state

- **All phases (0–8) are complete, tested, committed, and pushed.** What remains is
  pre-launch operational work: on-device QA, chaos/load drills, store submissions
  (see docs/launch-checklist.md).
- **Phase 7** added a `desktop/` Tauri tray app (background app-launch watcher,
  local-only matching). **Phase 8** added a context engine: the system learns from
  the user's own corrections/edits over time — accuracy goes up, token usage goes
  down, never up (see `docs/AI-MAP.md` and invariant #8 below).
- **Four workspaces** in an npm-workspaces monorepo: `backend/` (Fastify + SQLite),
  `app/` (Expo / React Native, runs on iOS, Android, and web), `desktop/` (Tauri 2
  tray app), plus a build-less `extension/` (Chrome MV3, not an npm workspace).
- **Everything works with no API keys and no cloud accounts.** Every AI capability
  has a deterministic heuristic fallback; the calendar has an in-process "internal"
  provider; notifications write to a DB outbox. Adding real providers is additive.
- **Test status:** all backend, app, and desktop tests green. `npm run typecheck`
  and `npm test` are clean at the repo root.

```bash
git clone <repo> && cd Scrible
npm install
npm run typecheck      # both workspaces
npm test               # 62 tests, all green
npm run dev -w backend # API on :8787
npm run web -w app     # web client (also: expo start for native)
```

---

## 2. Repository map

| Path | What it is |
|---|---|
| `backend/` | System of record. Fastify API v1, SQLite (portable SQL → Postgres in prod). |
| `app/` | Expo client (iOS/Android/web). The web build is also the "web dashboard". |
| `extension/` | Chrome MV3 extension (plain JS, no build step). |
| `desktop/` | Tauri 2 tray app: Rust `watcher-core` (process-launch diff, cargo-tested) + TS frontend with local matching (`src/matcher.ts`, Node-tested). See `desktop/README.md`. |
| `docs/BUILD_PLAN.md` | The full product spec. Phase definitions and "done" criteria. |
| `docs/decisions/0001-phase-0-tech-stack.md` | Stack decision record (ADR). |
| `docs/data-classification.md` | Every field's sensitivity, retention, deletion path. Update when the schema changes. |
| `docs/AI-MAP.md` | Where every AI capability fires, its provider chain, and its token profile — the context engine's design doc. |
| `.github/workflows/ci.yml` | CI: typecheck + tests on every push/PR (+ `cargo test` for `desktop/watcher-core`). |

### Backend internals (`backend/src/`)

| Path | Responsibility |
|---|---|
| `server.ts` | Assembles the app: DB, providers, modules, enrichment + scheduling hooks. `buildApp(overrides)` is the test entry point. |
| `index.ts` | Production entry: starts server, reminder scheduler, calendar reconciliation sweep. |
| `config.ts` | Env → typed config, feature flags (`FLAG_*`), retention windows. |
| `types.ts` | Shared domain/API types (mirrored by `app/src/types.ts`). |
| `lib/db.ts` | Schema (portable SQL), `openDb`, `deleteAllUserData` + `USER_DATA_TABLES`. |
| `lib/jwt.ts`, `lib/crypto.ts`, `lib/jobs.ts` | HS256 JWT; AES-256-GCM for calendar tokens; in-process async job queue. |
| `modules/auth.ts` | Email signup/login (scrypt), JWT, `authenticate` preHandler, `/v1/me`. |
| `modules/sync.ts` | **The heart.** `SyncEngine`: idempotent op application, change feed, LWW-per-field conflict policy (completions & new captures always survive), audit log. |
| `modules/syncRoutes.ts` | `/v1/sync/ops`, `/v1/sync/changes`, `/v1/sync/stream` (SSE). |
| `modules/items.ts` | Item read routes + REST mutations (all routed through `SyncEngine`). |
| `modules/consent.ts` | Per-category versioned consents + revocation purge hooks. |
| `modules/account.ts` | Account deletion (end-to-end), audit feed. |
| `modules/devices.ts` | Device registry. |
| `modules/voice.ts` | Spoken-"done" completion (`/v1/voice/done`). |
| `modules/calendarRoutes.ts` | Calendar links, OAuth start/complete, availability, schedule move/undo, activity feed, reminder snooze, provider webhooks. |
| `modules/extension.ts` | Cross-device routing: `/v1/extension/checkin`, `/shown`. |
| `modules/profile.ts` | Personalization: imports, profile transparency/edit/delete, `loadEffectiveProfile` (used by enrichment + scheduling). |
| `ai/orchestrator.ts` | Provider chains with fallback + latency/token instrumentation (`CallMetric.inputTokens/outputTokens`). **Logging policy: never logs payload text.** |
| `ai/contracts.ts` | Versioned capability contracts (classify/decompose/confirm/matchDone/schedule/deriveProfile). `ClassifyInput`/`MatchDoneInput` carry an optional `userId` used only in code (learned provider) — never serialized into a Claude prompt. |
| `ai/learning.ts` | Context engine (Phase 8): `learnFromCorrection`/`learnAppAlias` write to the capped `learned_signals` table from the user's own edits; `typePriors`/`appAliasFor`/`keyWeights` read it back; `prune` enforces the 200-row/user cap; `learnedVocabulary`/`learnedSummary` feed the profile. |
| `ai/providers/learned.ts` | The zero-token provider: blends heuristics with learned priors; confident → answers instantly, else `throw new NotConfident()` to fall through exactly like any other provider failure. |
| `ai/providers/heuristic.ts` | Deterministic fallback for every capability (also powers tests). Exports `contentTokens` (shared tokenizer used by `learning.ts`). |
| `ai/providers/anthropic.ts` | Claude via official SDK with structured outputs (`output_config.format`). Token usage is attached to each returned output object via a `WeakMap` (`getUsage`) — race-free across concurrent requests, no shared mutable field. |
| `ai/index.ts` | Builds the orchestrator: `learned` registered first for classify/matchDone (0 tokens when confident), then Claude when `ANTHROPIC_API_KEY` set, heuristic always last. |
| `modules/aiMetrics.ts` | `GET /v1/ai/metrics` — per-capability call counts by provider + summed tokens, so "tokens go down as the learned provider's share rises" is measurable. |
| `enrichment.ts` | Capture-path job: classify → decompose → summary. `afterEnrichment` hook fans into scheduling (server.ts). |
| `calendar/` | `provider.ts` (interface + registry), `internal.ts` / `google.ts` / `outlook.ts` adapters, `service.ts` (sync engine, availability, auto-schedule, conflict cascade, undo, activity). |
| `notifications/index.ts` | `NotificationDispatcher` (dedup, quiet hours) + `ReminderScheduler` (triggers, delivery, snooze, recurrence). Pluggable push senders; dev `OutboxSender` writes to `push_outbox`. |

### App internals (`app/src/`)

| Path | Responsibility |
|---|---|
| `store.ts` | `SyncStore` — offline-first: optimistic ops, durable AsyncStorage queue, change-feed cursor, serialized sync. Pure TS, unit-tested in Node. |
| `api.ts` | Typed `HttpApi` client (`ApiClient` interface). |
| `speech.ts` | STT abstraction: Web Speech API on web, `expo-speech-recognition` on native, typed fallback. |
| `screens/` | `Auth`, `Capture`, `Queue`, `Activity`, `Settings` (consent + profile UI). |
| `App.tsx` | Shell, auth gate, tab nav, periodic sync. |

---

## 3. Key architectural invariants (do not break)

1. **All writes go through the SyncEngine op path.** REST mutations construct a
   `SyncOp` and call `applyOps`. This keeps offline replay and online writes on one
   code path. Idempotency is by `opId` (see `processed_ops`).
2. **Conflict policy:** last-writer-wins per field, **except** completions and new
   captures, which always survive. Covered by `test/sync.test.ts` — keep it green.
3. **AI is a boundary.** Nothing outside `ai/` calls a model provider. Every
   capability degrades to a heuristic; user-facing message paths never hard-fail.
4. **Privacy is architected, not bolted on.** Consent is per-category and revocable;
   revocation triggers a purge hook. Account deletion is verified by test across
   `USER_DATA_TABLES`. Chat imports are processed in memory and discarded — the
   `no-import-derived-data-survives-deletion` test enforces this. **When you add a
   table or field, update `USER_DATA_TABLES`, `docs/data-classification.md`, and add
   a deletion assertion.**
5. **Confirmations are never silent.** Every automated action (schedule, move,
   conflict, reminder) produces a plain-language activity entry that rides the change
   feed and carries an undo where reversible.
6. **Calendar safety:** Scrible only ever edits events it created; external calendar
   wins for foreign events; foreign events displace Scrible blocks (never silently).
7. **Desktop watcher privacy:** running-app/process names never leave the machine —
   the server serves app-triggered items (`/v1/desktop/checkin`) and the desktop app
   matches locally. Never add an endpoint that accepts process lists.
8. **Learned context is applied in code, never appended to prompts.** `learned_signals`
   (Phase 8) is read in `ai/providers/learned.ts` and used to short-circuit or refine
   an answer in TypeScript — it is never interpolated into a Claude prompt string.
   Every prompt input stays hard-capped regardless of table size (vocabulary ≤ 15
   terms, recentTypes ≤ 5); a growing table can only make the `learned` provider's
   share of calls rise (fewer tokens), never make any one call bigger. Learning is
   consent-gated (`chat_import`, reused) and only ever taught by genuine user edits —
   `serverUpdateItem` tags its own writes `origin: 'server'` so the system never
   learns from its own guesses.

---

## 4. How to run real integrations (all optional)

| Capability | Env vars | Without them |
|---|---|---|
| Claude LLM | `ANTHROPIC_API_KEY` (opt `ANTHROPIC_MODEL`, default `claude-opus-4-8`) | Heuristic providers (works, lower quality). |
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth routes return 501; use the `internal` provider. |
| Outlook Calendar | `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Same. |
| Push (APNs/FCM) | wire real `PushSender`s in `server.ts` | `OutboxSender` records to `push_outbox`. |
| Token encryption | `TOKEN_ENC_KEY` (required in prod), `JWT_SECRET` (required in prod) | Dev defaults (insecure). |
| Postgres | swap `lib/db.ts` for a PG pool; replay the same SQL | SQLite file. |

Feature flags: `FLAG_AUTO_CLASSIFY`, `FLAG_AUTO_SCHEDULE`, `FLAG_PERSONALIZATION`,
`FLAG_ANALYTICS` (all default on; set `=0` to disable).

---

## 5. Conventions

- **Commits:** one commit per phase, descriptive body. End with the `Co-Authored-By`
  and `Claude-Session` trailers already in the history (match the format).
- **Tests:** Node's built-in test runner (`node --test`), `tsx` for TS. Backend runs
  serial (`--test-concurrency=1`) because tests share an in-memory DB per app. Every
  behavioral claim gets a test; prefer testing through the HTTP surface via
  `app.inject`. Helpers in `backend/test/helpers.ts` (`testApp`, `signup`, `auth`).
- **New backend module:** create `modules/<name>.ts` exporting `register<Name>(app,
  db, …)`, wire it in `server.ts`, add `test/<name>.test.ts`.
- **Types:** keep `app/src/types.ts` in sync with `backend/src/types.ts` by hand
  (small, deliberate — no shared package yet; extractable later).

---

## 6. What remains (phases now built — kept for context on where each landed)

### Phase 5 — Analytics & Compliance — DONE: see `backend/src/analytics/`, `modules/analyticsRoutes.ts`, `scripts/dsr.ts`, `docs/privacy-policy.md`, `docs/compliance/`
- Event taxonomy (activation, voice-capture success, core-loop health, scheduling,
  cross-device, personalization, retention) behind a **consent-gated forwarding
  layer** — one in-house layer that enforces schema, strips sensitive fields, applies
  the `analytics` consent, and uses a **pseudonymous ID unlinked from account ID**.
  Instrumentation points should be stubbed as you go; this phase formalizes them.
- **Absolute rule:** no transcript text, item titles, import content, or calendar
  details in events — types, counts, durations, buckets only.
- Data export endpoint (GDPR/CCPA access) to complement the existing deletion.
- Store compliance packages: iOS privacy nutrition labels + purpose strings, Play
  data-safety form, Chrome Web Store disclosures. Privacy policy doc. DSR admin
  tooling + deletion-verification job.
- Suggested: `backend/src/analytics/` (forwarding layer + taxonomy), `modules/analyticsRoutes.ts`,
  `modules/exportRoutes.ts`, `docs/privacy-policy.md`, `docs/compliance/`.

### Phase 6 — Polish — DONE: see `test/edge-cases.test.ts`, `docs/runbooks.md`, `docs/launch-checklist.md`. Remaining pre-launch items live in the checklist (device QA, chaos/load drills, store submission).
- Cross-platform consistency audit; performance budgets; **edge-case hardening**
  (offline matrix, ambiguous/multi-item voice input, timezone/DST, sync pathologies —
  same item completed on two offline devices, clock skew, reinstall restore);
  accessibility (VoiceOver/TalkBack, dynamic type, WCAG AA); reliability/ops
  (load tests, provider-outage chaos drills, runbooks, SLOs); launch readiness.
- Much of this is test + hardening work against code that already exists; add
  `test/edge-cases.test.ts` and drive the named scenarios.

### Phase 7 — Desktop companion — DONE: see `desktop/`, `desktop/README.md`
- Tauri 2 tray app whose background watcher notices app launches and pops matching
  items; process names are diffed and matched on-device only, gated behind the
  `app_watcher` consent; classification extracts `appTrigger` from captures.

### Phase 8 — Context engine — DONE: see `ai/learning.ts`, `ai/providers/learned.ts`, `modules/aiMetrics.ts`, `docs/AI-MAP.md`
- Learning that grows awareness **without growing token usage** — token usage goes
  down as it learns, never up. Corrections/edits accumulate as capped evidence in
  `learned_signals`, applied purely in code; a new `learned` provider short-circuits
  classify/matchDone at zero tokens when confident, otherwise falls through to
  Claude via the existing fallback chain (no orchestrator core changes). `GET
  /v1/ai/metrics` proves the token trend; `GET /v1/profile` surfaces learned
  patterns in plain language.

### Known follow-ups / debts
- Social sign-in (Apple/Google) endpoints are shaped but return 501 (need provider
  id-token verification) — required for App Store, do in Phase 5.
- Apple Calendar has no server API: the iOS app must act as the EventKit sync bridge
  (documented limitation) — not yet implemented on the client.
- Extension icons are generated placeholders; replace before Web Store submission.
- `app/src/types.ts` duplicates backend types; consider a shared `packages/shared`.
- The reminder scheduler and calendar sweep run on `setInterval` in-process; for
  multi-instance prod, move to a real job queue (the `JobQueue`/orchestrator
  boundaries were built to be extractable).

---

## 7. Branch & workflow notes

- Default branch: `main`. Phase deliverables are tagged by branch (e.g. `phase-4`).
- CI runs typecheck + tests on every branch and PR.
- Do not open a PR unless asked. If you do, there is no template; write the body
  from the diff.
