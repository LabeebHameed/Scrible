# Launch Readiness Checklist (build plan §11.6)

## Performance budgets (§11.2) — measure on mid-range hardware before launch

- [ ] Tap-to-recording < 1 s cold start (native dev build; instrument `Capture` mount → `startDictation`).
- [ ] Capture-to-classified p95 in seconds (item usable immediately regardless — enforced by design; verify with `orchestrator.recentMetrics()` durations).
- [ ] Queue render + sync catch-up after a day offline: near-instant (batch of 500 changes < 2 s).
- [ ] Notification delivery p95 within 60 s of scheduled time (see runbooks SLOs).
- [ ] AI cost per user per day within budget (orchestrator instrumentation; set alert).

## Cross-platform consistency matrix (§11.1)

Walk each flow on iOS / Android / web / extension; identical vocabulary and outcomes:
- [ ] capture (voice + typed) — [ ] correct type — [ ] complete (tap + spoken)
- [ ] schedule / move / undo — [ ] snooze — [ ] delete — [ ] import — [ ] every consent toggle
Document deliberate platform differences (iOS widget deep-links vs Android in-widget; Expo Go = typed-input fallback).

## Hardening status (§11.3) — automated coverage in `backend/test/`

- [x] Offline matrix: capture/complete offline, idempotent replay, restart durability (`sync.test.ts`, app `store.test.ts`)
- [x] Double completion on two offline devices; clock skew clamped; reinstall restore (`edge-cases.test.ts`)
- [x] Multi-item utterances split; garbled capture never dropped; low confidence exposed; ambiguous "done" asks (`edge-cases.test.ts`)
- [x] Calendar conflict cascade; own-events never self-displace; undo removes external event (`calendar.test.ts`)
- [x] DST-safe recurrence (`edge-cases.test.ts`); [ ] traveling-user timezone change (needs device QA)
- [x] Reminder exactly-once, snooze, recurrence, quiet hours (`reminders.test.ts`)
- [ ] Provider-outage chaos drill executed against staging (procedure in runbooks.md)
- [ ] Load test: sync fan-out + reminder tick at 10k users (script TBD before public launch)

## Accessibility (§11.4)

- [x] Interactive elements carry `accessibilityRole`/`accessibilityLabel`/selected state (tabs, record button, complete, chips).
- [ ] VoiceOver/TalkBack walkthrough of the capture→complete loop on device.
- [ ] Dynamic type spot-check; captions/haptics for audio cues (expo-haptics wired, add on record start/stop).
- [ ] WCAG AA contrast audit on web + extension (dark palette generally passes; verify accent-on-dark).

## Store & policy

- [ ] `docs/compliance/store-compliance.md` items all checked, labels re-audited against `docs/data-classification.md`.
- [ ] Sign in with Apple wired (blocker if Google sign-in ships) — or ship email-only v1.
- [ ] Privacy policy legal review; publish at a stable URL; account-deletion URL for Play.
- [ ] Extension icons replaced with brand assets; CWS listing screenshots.

## Rollout (§11.6)

- [ ] Staged: Play percentage rollout + iOS phased release.
- [ ] Rollback criteria wired to Phase 5 dashboards: voice-capture success rate, correction rate, reminder delivery rate, crash-free sessions.
- [ ] Beta feedback burn-down complete; support/FAQ covering the privacy model in plain language.
