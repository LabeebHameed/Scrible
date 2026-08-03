# Scrible — Voice-First Task & Calendar System: End-State Build Plan

This document is the complete, phase-wise build plan for Scrible: a voice-first task and scheduling app. It is written so that a team (or an AI agent executing step by step) can build the end-state product without needing prior context. It covers architecture decisions, components, data flow, tech choices, integration points, and milestones. It deliberately contains **no code, no pseudocode, and no algorithm specifications** — where AI/NLP capabilities are needed, they are described as black-box services with defined inputs and outputs.

---

## Table of Contents

1. [Product Overview & Guiding Principles](#1-product-overview--guiding-principles)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Core Data Model](#3-core-data-model)
4. [Privacy & Security Architecture (Cross-Cutting)](#4-privacy--security-architecture-cross-cutting)
5. [Phase 0 — Foundations](#5-phase-0--foundations)
6. [Phase 1 — Core Loop (Mobile Only)](#6-phase-1--core-loop-mobile-only)
7. [Phase 2 — Calendar Intelligence](#7-phase-2--calendar-intelligence)
8. [Phase 3 — Cross-Device Linking (Chrome Extension)](#8-phase-3--cross-device-linking-chrome-extension)
9. [Phase 4 — Personalization](#9-phase-4--personalization)
10. [Phase 5 — Analytics & Compliance](#10-phase-5--analytics--compliance)
11. [Phase 6 — Polish / End-Version](#11-phase-6--polish--end-version)
12. [Integration Points Summary](#12-integration-points-summary)
13. [Risks & Mitigations](#13-risks--mitigations)
14. [Open Product Decisions per Phase](#14-open-product-decisions-per-phase)

---

## 1. Product Overview & Guiding Principles

### Vision

A voice-first task and scheduling app. The user speaks a task, idea, or reminder. The system classifies and decomposes it, schedules it intelligently, tracks it across devices, and lets the user close items out as fast as they created them.

### Core user flow

1. **Capture** — User taps a record button (app or home-screen widget) and speaks.
2. **Understand** — The item is transcribed, classified (task / idea / reminder), and broken into sub-tasks.
3. **Route** — By type:
   - *Task linked to a computer action* (e.g. "post on X") → surfaces as a popup reminder when the user next opens Chrome on their laptop.
   - *Idea* → auto-assigned a time block on the user's real calendar.
   - *Reminder* → scheduled; push notification fires at the right time.
4. **Confirm** — Every scheduling action is confirmed back in plain language ("Scheduled 'Draft X post' for 3pm Thursday").
5. **Complete** — A "right now" queue shows the top ~5 next actions. Completion is one tap/swipe or a spoken "done."

### Non-negotiable principles

These constrain every phase and every design decision below:

- **Speed of capture and completion.** Cold start to recording must feel instant. Completing an item must never take more steps than creating it. Every screen and API is designed around this.
- **Plain-language feedback.** The system never silently schedules or reclassifies anything. Every automated decision produces a human-readable confirmation the user can undo in one action.
- **Privacy by design.** Voice audio and imported chat history are among the most sensitive data a user can share. Consent is explicit, storage is encrypted, deletion is total and verifiable. This is architected in Phase 0, not bolted on in Phase 5.
- **Offline resilience.** Capture must work with zero connectivity; everything queues and reconciles when the network returns. The user is never told "can't record right now."
- **User is always in control.** AI classification, decomposition, and scheduling are *suggestions applied by default* — every one is visible, editable, and reversible. Misclassification correction is a first-class interaction (and a training signal).

---

## 2. System Architecture Overview

### 2.1 Component map

Seven top-level components, each an independently deployable/shippable unit:

| # | Component | Role |
|---|-----------|------|
| 1 | **Mobile apps (iOS + Android)** | Voice capture, home-screen widget, "right now" queue, notifications, offline handling. Primary surface. |
| 2 | **Chrome browser extension** | Detects laptop/browser context; shows popup reminders for computer-action tasks. Separate product from the web dashboard. |
| 3 | **Backend API & sync service** | System of record. Auth, item CRUD, device registry, real-time sync, notification dispatch. |
| 4 | **AI orchestration layer** | A distinct service boundary inside the backend that owns all LLM/speech interactions: transcription, classification, decomposition, scheduling suggestions, confirmation phrasing, personality profiling. Everything else calls it through versioned internal contracts. |
| 5 | **Calendar sync service** | Two-way sync with Google / Outlook / Apple calendars; conflict detection; free/busy computation. |
| 6 | **Web dashboard** | Companion browser view of queue, all items, and calendar; settings, data export/deletion, chat-import management. |
| 7 | **Analytics pipeline** | Product analytics (mobile + extension + web) and marketing-site analytics, feeding a single event taxonomy. |

Supporting infrastructure (not user-facing components, but planned as first-class workstreams): identity provider, push infrastructure (APNs + FCM + web push), object storage for audio/import files, job queue for async AI work, observability stack.

### 2.2 Key architecture decisions and rationale

**Mobile: native-leaning cross-platform.**
Use a cross-platform framework (React Native or Flutter — pick one in Phase 0 based on team skills; both are acceptable end-state choices) for all screens and business logic, **with native modules for the three things that must be native anyway**: home-screen widgets (WidgetKit on iOS, Glance/AppWidget on Android), audio capture/session handling, and platform notification behaviors. Rationale: the app is UI-heavy and must ship on both platforms with identical behavior; the truly platform-specific surface is small and well-bounded. A fully-native two-codebase approach is the fallback only if widget or audio requirements prove impossible through the bridge (they generally are not).

**Backend: modular monolith first, service boundaries enforced by contract.**
One deployable backend application with strictly separated internal modules (auth, items, scheduling, calendar sync, AI orchestration, notifications, analytics ingestion), communicating through explicit internal interfaces and an async job queue. The AI orchestration layer and calendar sync service are the two modules designed to be extractable into standalone services later (they have external dependencies, bursty load, and different scaling profiles). Rationale: microservices on day one multiplies operational cost without benefit; the discipline that matters is the *boundary*, not the deployment unit.

**Language/platform for backend:** TypeScript (Node) or Kotlin/Go — decide in Phase 0 by team expertise. Requirements that constrain the choice: first-class async job processing, good SDK support for Google/Microsoft calendar APIs and LLM providers, WebSocket support for real-time sync.

**Data store:** A relational database (PostgreSQL) as the system of record. Rationale: the data model is relational (items → sub-tasks → schedule blocks → calendar links), consistency matters for sync, and Postgres handles the JSON-ish flexible fields (classification metadata, profile attributes) natively. Object storage (S3-compatible) for voice audio files and chat-import archives. A cache/queue layer (Redis or equivalent) for sessions, rate limiting, and job queues.

**Sync model: server-authoritative with offline-first clients.**
Every client (mobile, extension, web) keeps a local store and an outbound operation queue. Operations are timestamped and idempotent; the server is the arbiter; clients reconcile via a per-user change feed (delivered over WebSocket/SSE when connected, polled on reconnect). Conflict policy: last-writer-wins per field for edits, with two exceptions that must never be lost — *completions* and *new captures* always survive a conflict. Rationale: full CRDT machinery is overkill for a single-user-per-account data set; the failure modes that matter are "I captured something offline" and "I completed something offline," and both are append-like operations that merge trivially.

**AI orchestration as a service boundary.**
All model calls (speech-to-text, classification, decomposition, scheduling suggestion, confirmation phrasing, profile derivation) go through one internal layer that owns: provider selection and fallback, prompt/model versioning, per-capability input/output contracts, cost and latency budgets, and logging policy (what may and may not be retained). Clients never call model providers directly. Rationale: models and providers will change many times over the product's life; nothing outside this layer should notice.

**Speech-to-text: on-device first, cloud fallback.**
Use the platform's on-device speech recognition for immediate transcription (fast, private, works offline), with an optional cloud transcription pass for quality when the recording is ambiguous or long. Raw audio is retained only transiently for the cloud pass unless the user opts into "keep my recordings" (off by default).

**Push infrastructure:** APNs (iOS), FCM (Android), and the Chrome extension's own event channel (see Phase 3). All time-based reminders are scheduled server-side and dispatched through a single notification-dispatch module so delivery, retries, quiet hours, and de-duplication live in one place. Clients additionally schedule *local* notifications as an offline fallback for reminders already known to the device.

### 2.3 Primary data flows (described in prose)

**Capture path (Phase 1):**
Mobile app/widget records audio → on-device transcription produces text immediately → the item is created locally in "processing" state and synced up → backend enqueues an AI-orchestration job → job returns classification (task/idea/reminder + confidence), decomposition (sub-task list), and any detected scheduling intent ("remind me Friday") → item updates propagate back to the client over the change feed → the client shows the classified, decomposed item with a plain-language summary and one-tap correction affordances. If offline: the transcribed item sits in the local queue in "pending classification" state, fully usable as a plain item, and is enriched when connectivity returns.

**Scheduling path (Phase 2):**
Classified item + user's availability (from the calendar sync service's free/busy view) + user preferences (working hours, focus blocks, personalization profile in Phase 4) → AI orchestration proposes a time block → scheduling module validates against real calendar state → block is written to the internal schedule and (if the user linked a calendar) pushed to the external calendar → confirmation message is generated and delivered (in-app + notification) → user can accept silently (default), move, or reject in one tap.

**Cross-device path (Phase 3):**
A task classified as "computer action" is tagged for desktop delivery → the device registry knows the user's enrolled Chrome extension(s) → when the extension signals "browser session active," the backend delivers pending computer-action reminders → extension shows a popup → the user's dismiss/snooze/complete action syncs back to the same item everywhere.

**Personalization path (Phase 4):**
User explicitly initiates chat-history import → consent flow → file uploaded to isolated encrypted storage (or processed on-device, per user's choice) → AI orchestration derives a structured personality/communication profile (tone preferences, verbosity, working rhythm hints, domain vocabulary) → raw import is deleted per retention policy → the profile becomes an input to decomposition, confirmation phrasing, and idea scheduling → user can view, edit, and delete the profile at any time.

---

## 3. Core Data Model

Entity overview (fields listed are the conceptually necessary ones, not an exhaustive schema):

- **User** — identity, auth linkage, timezone, working-hours preferences, notification preferences, consent records (versioned, timestamped, per data category: voice audio retention, chat import, analytics).
- **Item** — the universal captured object. Type (`task` / `idea` / `reminder`), source (voice / typed / import), raw transcription text, cleaned title, classification confidence, status (captured → processing → active → scheduled → done / dismissed), context tag (e.g. `computer-action`), timestamps. An item's type can be changed by the user at any time; the correction is recorded as a signal.
- **Sub-task** — ordered children of an item, each independently completable; carries origin (AI-generated vs. user-added).
- **Schedule block** — an assignment of an item (or sub-task) to a time range; state (proposed / confirmed / moved / released); link to an external calendar event if synced.
- **Calendar link** — a user's connection to an external calendar account (provider, account identifier, OAuth token references, selected calendars, sync cursor/state).
- **Reminder trigger** — for reminder-type items: fire time(s), recurrence, delivery channels, snooze state, delivery log.
- **Device registration** — each enrolled client (phone, tablet, extension instance, browser session for web): platform, push token/channel, capabilities (can show popups, can record audio), last-seen.
- **Personality profile** — a *structured, derived* artifact (never raw chat text): tone/verbosity preferences, decomposition granularity preference, scheduling rhythm hints, generated-from metadata (which imports, when), storage location flag (server-encrypted vs. on-device-only).
- **Import job** — a chat-history import: source assistant, consent reference, processing state, retention deadline, deletion audit record.
- **Analytics event** — client-generated, schema-versioned events (see Phase 5 taxonomy); pseudonymous ID separate from the user's account ID.
- **Audit/undo log** — every automated action (classification, scheduling, rescheduling) with enough information to display "what happened and why" and to reverse it.

Relationships: User 1—N Items; Item 1—N Sub-tasks; Item 1—N Schedule blocks; Schedule block 0..1—1 external calendar event; User 1—N Calendar links, Device registrations, Import jobs; User 0..1 Personality profile.

---

## 4. Privacy & Security Architecture (Cross-Cutting)

This section is deliberately placed before the phases: **the chat-import feature means the system ingests highly sensitive personal data, and the architecture must be built for that from Phase 0.**

**Consent model.**
Consent is per-category, versioned, and revocable: (a) microphone/voice processing, (b) voice-audio retention beyond transient processing, (c) calendar access, (d) chat-history import and profile derivation, (e) product analytics. Each consent is a stored record (what was agreed, which policy version, when). Revoking a consent triggers the corresponding data-handling change automatically (e.g., revoking (d) deletes imports and the derived profile).

**Chat-import handling (explicit requirements).**
- The import flow states, in plain language before upload: what will be extracted, what will be stored (a structured profile, not the conversations), how long the raw file is retained, and how to delete everything.
- **Storage choice offered to the user:** *on-device processing* (raw export never leaves the device; profile derivation runs locally with a smaller on-device model, accepting reduced profile richness) or *encrypted server processing* (raw file encrypted at rest in an isolated bucket, processed, then deleted within a fixed short retention window — days, not months).
- Raw chat exports are never used for anything except profile derivation. They are never used to train models, never shared with analytics, and never readable by staff (encrypted with keys the application layer controls, access-logged).
- **Total deletion:** one action deletes the derived profile, any remaining raw import data, and associated processing logs, and produces a user-visible confirmation. Deletion propagates to backups within the documented backup-expiry window, and that window is stated to the user.

**Voice data.** On-device transcription by default; audio sent to the cloud only for the optional quality pass and deleted immediately after unless retention consent (b) is given. Transcripts are user data (retained, syncable, deletable like any item).

**General security posture.** TLS everywhere; encryption at rest for all stores; OAuth tokens for calendar providers stored encrypted and never exposed to clients; per-user data isolation enforced at the API layer; secrets in a managed vault; access audit logging on all sensitive-data paths; account deletion removes all user data end-to-end (this also satisfies store requirements in Phase 5).

---

## 5. Phase 0 — Foundations

**Goal:** Everything later phases stand on: accounts, the data model, the sync backbone, the privacy/consent architecture, and the engineering infrastructure to ship continuously. No user-visible product yet beyond sign-in.

**Dependencies:** None (first phase).

### Key features & workstreams

1. **Tech-stack finalization.** Lock the four open choices with a short written decision record each: mobile framework (React Native vs. Flutter), backend language, cloud provider, LLM/speech providers (primary + fallback per capability). Criteria: team expertise, SDK maturity for the integrations in Phases 2–4, cost profile.
2. **Accounts & auth.** Email + Sign in with Apple + Google sign-in (Apple sign-in is mandatory for App Store when other social logins exist). Managed identity provider or well-supported auth library rather than hand-rolled. Session model that works identically across mobile, extension, and web; device enrollment tied to auth so the device registry (Phase 3) has a foundation.
3. **Data model & API v1.** Implement the entities in Section 3 (users, items, sub-tasks, schedule blocks, reminder triggers, device registrations, consent records; calendar links and profiles as schema stubs). Versioned API from day one. Item state machine defined and documented.
4. **Sync backbone.** The change-feed + client operation queue described in §2.2, exercised by an internal test client. Conflict policy implemented and tested (especially: offline capture and offline completion never lost).
5. **Privacy & consent architecture.** Consent record storage, per-category consent APIs, deletion pipeline skeleton (account deletion works end-to-end from day one, even when there's little data to delete). Data-classification doc: every field labeled by sensitivity, retention, and deletion path.
6. **AI orchestration layer skeleton.** The service boundary exists with its contract style, provider abstraction, versioning scheme, logging policy, and budget instrumentation — even before any real capability is wired in. Define the input/output contracts for the Phase 1 capabilities now (classification: text + user context in → type + confidence + extracted scheduling intent out; decomposition: item text + type in → ordered sub-task list out).
7. **Engineering infrastructure.** Monorepo (recommended) with mobile, backend, extension, web packages; CI running tests and linters on every change; staging + production environments; observability (structured logs, error tracking, basic metrics) from the first deploy; feature-flag system (later phases depend on it for gradual rollout).

### What "done" looks like

- A user can create an account, sign in on two devices, and see a trivial test item sync between them in near-real-time and after an offline period.
- Account deletion fully works and is verified by an automated test.
- Consent records can be created, versioned, and revoked via API.
- CI/CD deploys backend and produces installable mobile builds (internal distribution).
- Written decision records exist for all Phase 0 tech choices.

---

## 6. Phase 1 — Core Loop (Mobile Only)

**Goal:** The product's heartbeat: speak → classified & decomposed item → "right now" queue → one-gesture completion. Mobile only; no calendar, no cross-device, no personalization.

**Dependencies:** Phase 0 (auth, sync, item model, AI orchestration skeleton).

### Key features & workstreams

1. **Voice capture.**
   - In-app record button: single tap starts recording with visible live transcription; tap again (or auto-stop on silence) finishes. Target: under one second from tap to recording.
   - Home-screen widget on both platforms: one tap from home screen into recording. iOS and Android widget capabilities differ (iOS widgets deep-link into the app; Android can get closer to in-widget interaction) — the plan accepts platform-appropriate behavior as long as the *tap count* is one.
   - Microphone permission flow with a clear pre-permission explanation screen (also needed for store review, Phase 5).
   - Fallback text input for environments where speaking isn't possible — voice-first, not voice-only.
2. **Transcription.** On-device speech-to-text wired through the AI orchestration contract; language setting; visible transcript the user can quickly correct before or after saving.
3. **Classification & decomposition (black-box capabilities).**
   - *Classification*: input = transcript + lightweight context (time of day, user's recent items); output = type (task/idea/reminder), confidence, any explicit time expressions found ("Friday at 3"), and a context tag when the item implies a computer action (tag is stored now, used in Phase 3).
   - *Decomposition*: input = item text + type; output = 0–N sub-tasks. Product rule: small items get no decomposition — do not manufacture busywork. Decomposition runs async; the item is usable immediately and enriches in place.
   - *Correction UX*: the classified type is shown as a tappable chip; one tap re-types the item. Corrections are logged as quality signals (fed to analytics in Phase 5 and to personalization in Phase 4).
4. **"Right now" queue.** Home screen shows the top ~5 next actions, chosen by a transparent ordering (explicit times first, then age/priority; the *intelligent* ordering arrives with Phase 2/4 inputs). Swipe to complete, swipe to defer, tap to open detail with sub-tasks.
5. **Completion parity.** One-swipe complete from queue and notification; spoken "done" — after finishing a recording, or via a dedicated voice command surface, saying "done with X" completes the matching item (this is a black-box match capability: input = utterance + user's open items; output = matched item or a disambiguation prompt).
6. **Offline handling.** Recording, transcription, item creation, queue viewing, and completion all work offline via the Phase 0 local store; classification/decomposition catch up on reconnect with a subtle "processing" state, never a blocker.
7. **Plain-language feedback (v1).** Every capture ends with a one-line summary of what the system understood ("Got it — task: 'Buy renewal gift', 2 steps"). Generated through the AI orchestration layer so tone becomes adaptable in Phase 4.

### What "done" looks like

- Speak-to-visible-classified-item happens in seconds on a mid-range phone; capture works from the widget in one tap.
- Items captured in airplane mode appear correctly classified once connectivity returns; nothing captured or completed is ever lost (verified by automated sync tests).
- Classification accuracy is measured (against an internal labeled test set) and a correction-rate metric is instrumented, with an agreed launch threshold.
- Internal/beta users run their day from the queue for a week without falling back to another to-do app for capture.

---

## 7. Phase 2 — Calendar Intelligence

**Goal:** The system becomes a scheduler, not just a list: ideas get auto-assigned time blocks on the user's *real* calendar, reminders fire reliably at the right time, and every scheduling action is confirmed in plain language.

**Dependencies:** Phase 1 (classified items with extracted time intent), Phase 0 (consent architecture — calendar access is a consented category).

### Key features & workstreams

1. **Calendar provider integrations.** Google Calendar and Microsoft Outlook via their OAuth APIs with incremental-sync and push-notification (webhook) mechanisms; Apple Calendar via on-device EventKit on iOS (Apple offers no comparable server API — the iOS app acts as the sync bridge for Apple-calendar users, and the plan treats this as a documented platform limitation affecting non-iOS surfaces' freshness for those users). Multi-account support (work + personal).
2. **Two-way sync engine.** Per-link sync state with provider cursors/tokens; inbound changes (events created/moved/deleted externally) update free/busy and can displace Scrible-created blocks; outbound changes (blocks created/moved in Scrible) write to the provider. Sync conflicts resolve in favor of the external calendar for *foreign* events and in favor of the most recent user action for *Scrible-owned* events. Webhook-driven freshness with periodic reconciliation sweeps as backstop.
3. **Availability model.** A unified free/busy view across all linked calendars plus user-defined working hours, protected focus blocks, and "don't schedule" windows. This is the scheduling capability's main input.
4. **Auto-scheduling (black-box capability).** Input = item (idea or schedulable task) + availability + user preferences; output = proposed time block with a human-readable rationale ("Thursday 3pm — your first free hour after the deadline you mentioned"). Product rules around it: proposals respect working hours and existing events; the user's default is *auto-accept with easy undo*, switchable to *confirm-first* in settings; rescheduling cascades (an external meeting lands on a Scrible block → the block moves and the user is told).
5. **Reminder & notification system.** Server-side scheduling of reminder triggers; dispatch through APNs/FCM with delivery tracking; local-notification fallback for reminders known to the device; recurrence; snooze that syncs across devices; quiet hours; de-duplication so one reminder never fires twice across channels.
6. **Plain-language confirmations (v2).** Every scheduling event — proposed, confirmed, moved, conflicted — produces a one-line message in the app's activity feed and (when appropriate) a notification, each carrying a one-tap action (undo / move / open). Generated through AI orchestration; templated fallback when the model call fails so confirmations are never silent-dropped.
7. **Conflict handling UX.** When the system cannot find a slot, or two things collide, the user gets a clear choice card ("Your Thursday filled up — move 'Outline blog post' to Friday 10am?") rather than a silent failure.

### What "done" looks like

- Linking Google and Outlook calendars takes under a minute each; events created/moved externally are reflected in Scrible within seconds (webhook path) and never later than the reconciliation interval.
- An idea captured by voice lands as a calendar block on the user's real calendar with a plain-language confirmation, and undo removes it from the external calendar too.
- Reminder delivery is measured (scheduled vs. delivered vs. seen) with an agreed reliability threshold; no duplicate notifications in cross-device tests.
- A week-long dogfood where external calendar chaos (moved meetings, cancellations) is handled without a single silent scheduling change.

---

## 8. Phase 3 — Cross-Device Linking (Chrome Extension)

**Goal:** Tasks tied to computer actions reach the user at the moment of context: when they next open Chrome on their laptop.

**Dependencies:** Phase 1 (context tagging of computer-action tasks), Phase 0 (device registry, auth that spans surfaces).

### Key features & workstreams

1. **Chrome extension (Manifest V3).** Sign-in that pairs the extension to the account (device-code or click-through from the web dashboard); registration in the device registry as a `popup-capable` device. Built within MV3's constraints (service-worker lifecycle, no persistent background page) — the design must assume the extension wakes on browser events rather than running continuously.
2. **Context/trigger model.** The trigger for delivery is "user is now active in Chrome on this machine": browser startup and first-activity-after-idle are the core signals. Delivery mechanics: the extension checks in when triggered and pulls pending computer-action reminders; a push channel supplements this when the browser is already open. Optional (explicitly consented, off by default) refinement: site-scoped triggers ("when I next open x.com, remind me to post") — this reads navigation context, so it is its own consent with its own plain explanation.
3. **Popup reminder UX.** A calm, dismissible in-browser surface (extension popup/badge + a non-intrusive on-page overlay or browser notification) showing the pending computer-action tasks: complete, snooze ("later today", "next session"), or open-in-dashboard. Frequency capping so the browser never nags — at most one surfacing per session unless the user opens the list themselves.
4. **Routing logic.** The classification context tag from Phase 1 marks items `computer-action`; users can also toggle this per item ("show me this on my laptop"). The backend's delivery module decides *where* an item surfaces (phone notification vs. extension popup vs. both-with-dedup) based on device registry + trigger type — one module, so cross-surface de-duplication has a single owner.
5. **Bidirectional state sync.** Complete/snooze/dismiss in the popup updates the item everywhere through the normal sync path; conversely, completing on the phone withdraws the pending popup.
6. **Extension distribution & review.** Chrome Web Store listing with its own privacy disclosure (what browsing signals are read and why); the site-scoped-trigger permission requested only when the user enables that feature (optional permissions), keeping the default install permission footprint minimal.

### What "done" looks like

- "Remind me to post on X when I'm at my laptop," spoken on the phone, produces a popup the next time the user opens Chrome — and completing it there clears it on the phone within seconds.
- No duplicate reminders across phone and browser in matrix tests (all combinations of online/offline, browser open/closed at fire time).
- Extension passes Chrome Web Store review with the minimal default permission set.
- The extension behaves correctly through MV3 service-worker suspensions (verified through idle/wake test scenarios).

---

## 9. Phase 4 — Personalization

**Goal:** The system adapts to the person: task breakdown granularity, confirmation tone, and idea-scheduling rhythm all follow a profile derived (with explicit consent) from the user's imported assistant chat history and their in-app behavior.

**Dependencies:** Phase 1 (decomposition & confirmation surfaces to adapt), Phase 2 (scheduling to adapt), Phase 0 (consent architecture, encrypted storage, deletion pipeline). Privacy requirements in §4 govern this entire phase.

### Key features & workstreams

1. **Chat import pipeline.** Support the export formats of major assistants (Claude, ChatGPT, Gemini) plus a generic text/JSON fallback; import via file upload on mobile/web. Format parsers are isolated and individually updatable, since export formats change.
2. **Consent & storage-choice flow.** The full §4 flow: plain-language explanation → per-import consent record → user chooses *on-device processing* or *encrypted server processing* → visible processing status → automatic raw-file deletion at the retention deadline with user-visible confirmation.
3. **Profile derivation (black-box capability).** Input = parsed chat history (and, separately, in-app behavioral signals: correction patterns, preferred decomposition edits, completion times of day); output = the structured personality profile of §3 — tone/verbosity preference, decomposition granularity preference, scheduling rhythm hints, domain vocabulary. The profile is small, structured, human-readable — *never* embeddings-plus-raw-text or anything from which conversations could be reconstructed.
4. **Profile transparency UI.** A settings screen showing the profile in plain language ("You prefer brief confirmations", "You like tasks broken into fewer, larger steps"), with per-attribute editing and override — the user can correct the machine's read of them, and manual edits win over derived values. One button deletes the profile and all import artifacts entirely (§4 total-deletion guarantee).
5. **Adaptation wiring.** The profile becomes an input to three existing AI-orchestration contracts: decomposition (granularity, vocabulary), confirmation phrasing (tone, length), and auto-scheduling (rhythm hints — e.g., creative ideas in mornings). Behavior without a profile is the unchanged Phase 1–2 default; adaptation degrades gracefully to defaults if the profile is deleted.
6. **Continuous lightweight personalization.** Independent of chat import, in-app signals (corrections, edits, completion patterns) refine the same profile attributes over time — gated by the same consent category, visible in the same transparency UI.

### What "done" looks like

- A user can import a Claude export, watch the profile appear, read it in plain language, notice confirmations and breakdowns change accordingly, and then delete everything — with an automated test proving no import-derived data survives deletion (database, object storage, logs).
- On-device processing mode verifiably never uploads the raw export (validated by network audit in testing).
- A/B-able flag: personalization on/off per user, so Phase 5 analytics can measure whether adaptation actually improves completion rates.

---

## 10. Phase 5 — Analytics & Compliance

**Goal:** Measurable product and shippable product: a full analytics taxonomy across all surfaces, and everything the App Store, Play Store, and Chrome Web Store require.

**Dependencies:** All prior phases (the features being measured and submitted must exist). Analytics *instrumentation points* should have been stubbed throughout earlier phases behind the analytics consent flag; this phase completes and formalizes them.

### Key features & workstreams

1. **Analytics provider & architecture.** One product-analytics provider (Amplitude or Mixpanel — decide on pricing/team familiarity; both satisfy requirements) fed through a thin in-house event-forwarding layer rather than direct SDK-to-provider wiring everywhere. Rationale: the forwarding layer enforces the schema, applies consent gating in one place, strips anything sensitive, and makes a future provider migration trivial. GA4 (or a privacy-friendlier equivalent such as Plausible) for the marketing site and public web analytics — a separate concern from product analytics.
2. **Event taxonomy.** A versioned, documented schema. The events that matter, by question:
   - *Activation*: sign-up completed, first capture, first completed item, widget installed, calendar linked, extension installed.
   - *Voice-capture success*: capture started/completed/abandoned, transcription corrected (edit distance bucket), classification corrected, decomposition edited. Together these define the **voice-capture success rate** — the product's most important quality metric.
   - *Core loop health*: items created per day by type and source, completion rate, time-to-completion, queue interactions, spoken-"done" usage.
   - *Scheduling*: proposals shown/accepted/moved/rejected, undo rate, conflict cards shown/resolved, reminder delivered→seen→acted funnel.
   - *Cross-device*: popup shown→acted rate, cross-surface dedup correctness.
   - *Personalization*: import funnel, profile deletions, and the personalization-on vs. off completion-rate comparison.
   - *Retention*: D1/D7/D30, WAU/MAU, per-feature retention cohorts.
   - Absolute rule: **no transcript text, item titles, chat-import content, or calendar event details ever enter analytics events** — properties are types, counts, durations, and buckets only. Analytics runs under its own consent category with a pseudonymous ID unlinked from account ID.
3. **Privacy policy & user-facing data documentation.** A plain-language privacy policy covering every data category in §4; in-app data-usage screen; documented data-retention schedule. Legal review. GDPR/CCPA alignment: data export (user can download their items and profile) and the already-built deletion flows satisfy the access/erasure rights.
4. **App Store (iOS) compliance package.**
   - Privacy nutrition labels accurately reflecting §4 (data types collected, linked-to-identity flags, tracking declaration — with the analytics design above, "no tracking" should be truthfully claimable).
   - Purpose strings for microphone, speech recognition, calendar, and notification permissions — each phrased to match what the app visibly does.
   - Account deletion reachable in-app (built in Phase 0 — verify it meets Apple's discoverability requirement).
   - Sign in with Apple present (Phase 0). Age rating questionnaire (expected 4+/low). App Review notes + demo account prepared, including a demo video of the voice flow since reviewers may not speak to the device.
5. **Play Store (Android) compliance package.** Data-safety form mirroring the nutrition labels; permission declarations (microphone, notifications runtime permission, calendar if device calendar is touched); account-deletion URL requirement; Data deletion inside the app; content rating questionnaire; target-API-level currency.
6. **Chrome Web Store**: re-verify the Phase 3 listing against current program policies at submission time (single purpose, permission justifications, privacy disclosures).
7. **Operational compliance tooling.** Admin tooling for data-subject requests (export, delete, consent history) with audit logs; deletion-verification job that proves erasure completed across stores and backups within the documented window.

### What "done" looks like

- Every taxonomy event flows from all three surfaces into dashboards answering the north-star questions (voice-capture success rate, completion rate, retention) — verified against a QA checklist per event.
- Consent-off users generate zero analytics traffic (verified by network audit).
- Both store submissions pass review; privacy labels/data-safety forms match an internally audited data inventory (an inaccurate label is a rejection *and* a trust failure).
- Privacy policy published; a full data-subject request (export + total deletion) completes end-to-end in a staging drill.

---

## 11. Phase 6 — Polish / End-Version

**Goal:** The end-state product: consistent across every surface, fast everywhere, and graceful in every edge case. This phase is a hardening sweep with explicit exit criteria, not new feature scope.

**Dependencies:** All prior phases.

### Key features & workstreams

1. **Cross-platform consistency audit.** One walkthrough matrix: every core flow (capture, correct, complete, schedule, snooze, delete, import, consent) exercised on iOS, Android, web dashboard, and extension — same vocabulary, same states, same outcomes. Fix every divergence or document it as a deliberate platform difference.
2. **Performance budgets (set, measured, enforced in CI where possible).**
   - Tap-to-recording: under one second, cold start included.
   - Capture-to-classified-item: seconds-level p95, with the item usable immediately regardless.
   - Queue render and sync catch-up after a day offline: near-instant perceived.
   - Notification delivery p95 within a defined window of scheduled time.
   - Backend cost budgets per user for AI calls (orchestration layer's instrumentation from Phase 0 makes this enforceable).
3. **Edge-case hardening (the named ones, plus the ones a scheduler must survive):**
   - *No connectivity*: full offline matrix re-test after all features exist — capture, complete, snooze offline; reminder local-fallback; extension behavior when the laptop is offline.
   - *Ambiguous voice input*: low-confidence classification asks instead of guessing (one-tap disambiguation card); unintelligible audio saves the recording + partial transcript rather than dropping the capture; multi-item utterances ("remind me to call mom and also I have an idea about…") split into multiple items with a combined confirmation.
   - *Calendar conflicts*: double-booking storms (external calendar bulk-changes), event moved during an active proposal, declined-meeting slots, all-day events, and cross-provider duplicate events.
   - *Time zones & DST*: traveling users, reminders scheduled across a DST boundary, calendar events in foreign time zones.
   - *Sync pathologies*: same item completed on two offline devices, clock-skewed clients, re-installed app restoring state.
4. **Accessibility.** Full screen-reader support (VoiceOver/TalkBack) — a voice-first app should be excellent for low-vision users; dynamic type; captions/haptics as alternatives to audio cues; WCAG AA on web dashboard and extension surfaces.
5. **Reliability & operations.** Load testing on sync and notification fan-out; chaos drills on provider outages (LLM provider down → templated fallbacks everywhere, calendar API down → queued writes with user-visible "will sync" states); on-call runbooks; SLOs for the delivery-critical paths.
6. **Launch readiness.** Beta program feedback burn-down; store assets and marketing site; support/FAQ content covering the privacy model in plain language; staged rollout plan (percentage rollout on Play, phased release on iOS) with rollback criteria tied to the Phase 5 dashboards.

### What "done" looks like

- The consistency matrix passes with zero unexplained divergences; performance budgets hold on mid-range hardware; every edge case above has an automated or scripted test that passes.
- Accessibility audit passes on all surfaces.
- A full provider-outage drill degrades gracefully with no silent failures and no lost captures.
- Staged rollout completes to 100% with dashboards green against the rollback criteria.

---

## 12. Integration Points Summary

| From | To | Channel | Purpose |
|------|----|---------|---------|
| Mobile app / widget | Backend API | HTTPS + change feed (WebSocket/SSE) | Item CRUD, sync, device registration |
| Mobile app | On-device speech APIs | Platform SDK | Primary transcription |
| Backend | AI orchestration layer | Internal contract + job queue | Classification, decomposition, scheduling, phrasing, profiling |
| AI orchestration | LLM / speech providers | Provider APIs (with fallback) | Model execution |
| Calendar sync service | Google / Microsoft APIs | OAuth + REST + webhooks | Two-way calendar sync |
| iOS app | Apple Calendar (EventKit) | On-device SDK | Apple-calendar bridge |
| Backend notification module | APNs / FCM / extension channel | Push protocols | Reminders, confirmations, popup delivery |
| Chrome extension | Backend API | HTTPS + push channel | Trigger check-ins, popup content, state sync |
| Web dashboard | Backend API | HTTPS + change feed | Companion view, settings, imports, deletion |
| All clients | Analytics forwarding layer | HTTPS (consent-gated) | Product events |
| Analytics forwarding layer | Amplitude/Mixpanel; GA4-equivalent | Provider APIs | Product & web analytics |

---

## 13. Risks & Mitigations

1. **Voice classification quality below trust threshold.** If users must correct most captures, the product dies. Mitigation: labeled test set and accuracy gate before Phase 1 ships; one-tap correction; correction rate as a launch-blocking metric.
2. **Calendar sync correctness.** Two-way sync bugs (duplicates, lost events) destroy trust instantly. Mitigation: Scrible only ever edits events it created; reconciliation sweeps; extensive provider-simulation tests; conservative conflict rules (external calendar wins for foreign events).
3. **Apple Calendar has no server API.** Mitigation accepted in design (§7.1): iOS app as sync bridge, limitation documented to users.
4. **Chrome MV3 lifecycle constraints.** Background persistence is not guaranteed. Mitigation: event-driven design from the start (Phase 3), pull-on-trigger rather than always-on push.
5. **Chat-import privacy incident.** The single worst possible failure. Mitigation: §4 architecture (isolation, encryption, short retention, on-device option, total deletion with verification), plus treating raw imports as radioactive — minimum handling, maximum logging of access.
6. **LLM provider cost/latency/outage.** Mitigation: orchestration layer owns budgets, fallback providers, and templated non-AI fallbacks for every user-facing message path.
7. **Store review rejections.** Mitigation: compliance treated as a Phase 5 workstream with checklists, not an afterthought; permissions requested in-context with clear purpose strings; accurate privacy labels from the audited data inventory.
8. **Scope gravity.** Each phase has explicit "done" criteria; features not in the phase's list wait, and the feature-flag system allows shipping phases progressively without long-lived branches.

---

## 14. Open Product Decisions per Phase

Decisions to resolve *before* each phase starts (each should get a short written decision record):

- **Phase 0:** Mobile framework; backend language; cloud provider; LLM/speech providers; monorepo tooling.
- **Phase 1:** Auto-stop-on-silence vs. tap-to-stop default; decomposition size threshold (when is an item "too small to split"); queue ordering rules v1.
- **Phase 2:** Default scheduling mode (auto-accept-with-undo vs. confirm-first) per item type; whether Scrible blocks appear on the external calendar as busy or free; supported reminder recurrence set.
- **Phase 3:** Whether site-scoped triggers ship in v1 of the extension or later; popup surface choice (browser notification vs. on-page overlay) after prototyping both.
- **Phase 4:** Which import formats are launch-blocking; on-device model choice and the quality gap accepted for on-device mode; retention window length for raw imports.
- **Phase 5:** Amplitude vs. Mixpanel; GA4 vs. privacy-first web analytics; which jurisdictions' privacy regimes are explicitly targeted at launch.
- **Phase 6:** Launch markets/languages; beta program size; SLO targets.

---

*End of build plan.*
