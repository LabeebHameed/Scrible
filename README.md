# Scrible

Voice-first task & calendar system. Speak a task, idea, or reminder — Scrible
classifies it, breaks it down, schedules it on your real calendar, follows you across
devices, and lets you close items out as fast as you created them.

The full product specification lives in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md);
architecture decisions in [docs/decisions/](docs/decisions/).

## Repository layout

| Package | What it is |
|---|---|
| `backend/` | System of record: auth, items, sync, consent, AI orchestration, scheduling, notifications (TypeScript / Fastify / SQLite-dev → Postgres-prod) |
| `app/` | Client app: Expo (React Native) for iOS/Android; the web build doubles as the web dashboard. `npm run web -w app` to run; native voice capture needs a dev build (`expo-speech-recognition`), Expo Go falls back to typed input |
| `extension/` | Chrome MV3 extension for computer-action reminders *(Phase 3+)* |
| `docs/` | Build plan, decision records, data classification, compliance |

## Development

```bash
npm install          # workspaces
npm run typecheck    # all packages
npm test             # all packages

# run the backend (defaults: port 8787, scrible.db, dev JWT secret)
npm run dev -w backend
```

Environment: `PORT`, `DATABASE_PATH`, `JWT_SECRET` (required in production),
`ANTHROPIC_API_KEY` (optional — without it every AI capability uses its deterministic
heuristic fallback), `FLAG_*` feature flags.

## Build phases

- [x] **Phase 0 — Foundations**: accounts/auth, data model & API v1, offline-first sync
  backbone with conflict policy, consent architecture + verified total account
  deletion, AI orchestration skeleton with provider fallback chains, CI.
- [x] **Phase 1 — Core loop**: voice capture (on-device STT, typed fallback) → async
  classification & decomposition (Claude provider + deterministic heuristic fallback) →
  "right now" queue → one-tap completion and spoken "done"; fully offline-capable
  client with a durable op queue.
- [x] **Phase 2 — Calendar intelligence**: provider-abstracted two-way sync (Google/
  Outlook adapters + internal calendar), availability model, auto-scheduling with
  plain-language confirmations and one-tap undo (removes the external event too),
  conflict cascade (external meetings displace Scrible blocks, never silently),
  server-side reminder delivery with dedup, snooze, recurrence, quiet hours.
- [x] **Phase 3 — Cross-device**: MV3 Chrome extension — event-driven check-ins on
  browser startup / return-from-idle, one-per-session popup with complete/snooze,
  minimal permission set, bidirectional state via the normal sync path; backend
  routing module owns where items surface.
- [x] **Phase 4 — Personalization**: chat-history import (Claude/ChatGPT/Gemini/generic
  parsers, user-side only), in-memory profile derivation (raw never stored),
  transparency UI with per-attribute edit that wins over derived values, adaptation
  into decomposition/confirmation/scheduling, on-device path, total deletion with a
  no-surviving-data test.
- [x] **Phase 5 — Analytics & compliance**: versioned event taxonomy with no free-text
  property kind (content cannot enter analytics by construction), consent-gated
  forwarding layer under a random pseudonymous ID (revocation permanently unlinks
  history), GDPR data export, audited DSR CLI with deletion verification, privacy
  policy + iOS/Play/Chrome-Web-Store compliance packages.
- [ ] **Phase 6 — Polish**: edge-case hardening, accessibility, launch readiness.
