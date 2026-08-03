# ADR 0001 — Phase 0 tech-stack decisions

Status: accepted · Date: 2026-07-07

The build plan (docs/BUILD_PLAN.md §5.1, §14) requires written decision records for the
open Phase 0 choices. All four are decided here.

## 1. Mobile framework: React Native via Expo (TypeScript)

- One TypeScript codebase across iOS, Android, and — via `react-native-web` — the web
  dashboard, so the plan's component #6 (web dashboard) shares the client codebase.
- Expo provides the native-module escape hatches the plan requires (widgets, audio
  session, notifications) through config plugins / dev clients without ejecting.
- Shares the language and type definitions with the backend (see §2), so sync-protocol
  and API contracts are one set of shared types, not two.
- Fallback per plan: fully-native modules only where the bridge proves insufficient
  (widgets are expected to need small native targets; tracked in Phase 1).

## 2. Backend language: TypeScript (Node 22, Fastify)

- First-class async job handling (the AI-orchestration queue is in-process in the
  modular monolith, extractable later per plan §2.2).
- Best-in-class SDK coverage for Google/Microsoft calendar APIs and LLM providers.
- Native WebSocket/SSE support for the real-time change feed.
- Same language as the client → shared contract types in one package.

## 3. Data store: SQLite (dev/test) behind a thin data layer; PostgreSQL in production

- The plan mandates a relational system of record (§2.2). The schema is written in
  portable SQL (TEXT ids, INTEGER millisecond timestamps, JSON-in-TEXT for flexible
  fields) so it maps 1:1 onto PostgreSQL.
- SQLite (via the Node built-in `node:sqlite`) gives zero-dependency local dev, fast
  CI, and honest automated tests of the sync/conflict/deletion paths from day one.
- The swap point is a single module (`backend/src/lib/db.ts`); no query builder or ORM
  lock-in. Production deployment provisions Postgres and replays `schema.sql`.
- Object storage (voice audio, chat imports) is S3-compatible in production; a
  local-disk adapter serves dev/test. Cloud provider selection is deferred to first
  deployment — nothing in the codebase binds to a vendor (12-factor env config).

## 4. LLM / speech providers

- **Speech-to-text:** platform on-device recognition is primary (plan §2.2): iOS
  SFSpeechRecognizer / Android SpeechRecognizer via Expo; Web Speech API on web.
  Cloud quality pass is optional and off by default.
- **LLM (classification, decomposition, phrasing, matching, profiling):** Anthropic
  Claude as primary provider through the AI-orchestration layer; every capability has
  a deterministic heuristic fallback provider so the product functions (degraded but
  never broken) with no API key, offline, or during provider outage — this also
  satisfies plan risk #6 (templated fallbacks for every user-facing message path).
- Providers are registered per capability with an ordered chain; nothing outside
  `backend/src/ai/` may call a model provider (plan §2.2 boundary rule).

## 5. Monorepo tooling: npm workspaces

- No extra tooling layer (Nx/Turbo) until scale demands it; CI runs typecheck + tests
  per workspace with `--workspaces --if-present`.
