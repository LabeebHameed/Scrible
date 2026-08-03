# Scrible

Voice-first task & calendar system. Speak a task, idea, or reminder — Scrible
classifies it, breaks it down, schedules it on your real calendar, follows you across
devices, and lets you close items out as fast as you created them.

The full product specification lives in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md);
architecture decisions in [docs/decisions/](docs/decisions/).

## Repository layout

| Package | What it is |
|---|---|
| `backend/` | System of record: auth, items, sync, consent, AI orchestration, scheduling, notifications (TypeScript / Fastify / Postgres) |
| `app/` | Client app: Expo (React Native) for iOS/Android; the web build doubles as the web dashboard. `npm run web -w app` to run; native voice capture needs a dev build (`expo-speech-recognition`), Expo Go falls back to typed input |
| `extension/` | Chrome MV3 extension for computer-action reminders |
| `desktop/` | Tauri 2 tray app: background app-launch watcher with local-only matching (`desktop/README.md`) |
| `docs/` | Build plan, decision records, data classification, compliance |

## Development

```bash
npm install          # workspaces
npm run typecheck    # all packages
npm test             # all packages

# run the backend (defaults: port 8787, local Postgres, dev JWT secret)
npm run dev -w backend
```

Backend storage is Postgres — set `DATABASE_URL` (defaults to
`postgresql://postgres:postgres@localhost:5432/scrible_dev` for local dev; required
in production, same throw-if-missing pattern as `JWT_SECRET`). Any Postgres works:
a local install, or a free hosted one (Neon, Supabase).

Environment: `PORT`, `DATABASE_URL`, `JWT_SECRET` (required in production), `FLAG_*`
feature flags. AI is free-tier-first and fully optional (docs/AI-MAP.md): without any
key, every capability runs on deterministic heuristics — never fails, never costs
anything. `NVIDIA_API_KEY` (optional) enables the primary free-tier LLM tier via
NVIDIA NIM's OpenAI-compatible API for the genuinely ambiguous cases heuristics can't
confidently resolve; `NVIDIA_MODEL` (default `minimaxai/minimax-m3` — confirm the
exact catalog slug for your NVIDIA account and override if different) and
`NVIDIA_BASE_URL` (default `https://integrate.api.nvidia.com/v1`) are configurable.
`ANTHROPIC_API_KEY` (optional) is a secondary, paid, opt-in quality upgrade tried
only after the free tier — not required for any AI capability.

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
- [x] **Phase 6 — Polish**: edge-case hardening with fixes (multi-item utterance
  splitting, clock-skew clamping, double-offline-completion merge, DST-safe
  recurrence, ambiguous-done disambiguation), accessibility roles/labels, ops
  runbooks, and the launch-readiness checklist.
- [x] **Phase 7 — Desktop companion**: Tauri 2 tray app whose background watcher
  notices app launches ("when I open Photoshop…") and pops matching items —
  process names are diffed and matched on-device only, gated behind the
  `app_watcher` consent; classification extracts `appTrigger` from captures.
