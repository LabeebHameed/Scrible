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
| `app/` | Client app: Expo (React Native) for iOS/Android; the web build doubles as the web dashboard *(Phase 1+)* |
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
- [ ] **Phase 1 — Core loop**: voice capture → classify → decompose → "right now" queue → one-gesture completion.
- [ ] **Phase 2 — Calendar intelligence**: two-way calendar sync, availability, auto-scheduling, reminders.
- [ ] **Phase 3 — Cross-device**: Chrome extension popup reminders for computer-action tasks.
- [ ] **Phase 4 — Personalization**: chat-history import → transparent, editable, deletable profile.
- [ ] **Phase 5 — Analytics & compliance**: consent-gated event taxonomy, store compliance packages.
- [ ] **Phase 6 — Polish**: edge-case hardening, accessibility, launch readiness.
