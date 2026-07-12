# SCRIBLE — Executable build plan: "the assistant, not an app"

This document is a complete, self-contained implementation spec. It assumes the
executing model has NO memory of prior sessions. Everything needed — file paths, exact
edits, commands, verification steps, known landmines — is written down. Follow it in
order. Do not improvise around the rules in §2.

## §0 North star (read once, then act like it's obvious)

Scrible is an external executive function for an ADHD user. He speaks a thought (app,
widget, someday a hardware clip-on mic that POSTs audio); from that moment the thought
is not his job: caught → understood in HIS context (routines, vocabulary, corrections)
→ remembered → turned into the right action (alarm / calendar block / step guideline /
safekeeping) → driven to completion (rings like an alarm, re-nags until acknowledged).
The hardware device proves the architecture: ALL intelligence lives in the backend;
every client is a dumb microphone. A missed reminder or a hallucinated time is a trust
break — trust is the product.

## §1 Project map & runbook (memorize)

Monorepo (npm workspaces) at `/home/user/Scrible`:
- `backend/` — Fastify + Postgres (pg wrapped in `.prepare(sql).get/all/run()` shim,
  `?` placeholders auto-translate). AI orchestrator: `learned → nvidia → anthropic →
  heuristic` per capability (`backend/src/ai/index.ts`); `heuristic-confident` tier is
  ONLY registered when no LLM key exists. Enrichment pipeline:
  `backend/src/enrichment.ts` (capture → classify → decompose → confirm → afterEnrichment
  in `backend/src/server.ts` ~line 99 → reminder triggers + major-item calendar blocks).
  Notifications: `backend/src/notifications/index.ts` (NotificationDispatcher,
  ReminderScheduler: 5-min re-nag, 2h cap, seen/snooze) + `expoPush.ts`.
- `app/` — Expo SDK 57 / RN 0.86. Screens in `app/src/screens/` (Capture, Queue,
  Schedule, Activity, Settings), store `app/src/store.ts` (offline-first, AsyncStorage
  key `scrible.store.v1`), api client `app/src/api.ts`, push `app/src/push.ts`, speech
  `app/src/speech.ts`, widgets `app/src/widgets/` (react-native-android-widget 0.20.3,
  widget name `ScribleCapture` — NEVER rename a shipped widget name, it orphans placed
  widgets). Deep links handled in `App.tsx` (`scrible://capture?autostart=1`).
  Hand-rolled tab navigation (no nav library). Theme: `app/src/theme.ts`.
- `desktop/`, `extension/` — not touched by this plan.

Commands:
- Backend tests need local Postgres:
  `sudo pg_ctlcluster 16 main start` (idempotent; run if `pg_isready -h localhost -p 5432` fails).
  Then from `backend/`: `node --import tsx --test --test-concurrency=1 test/*.test.ts`.
- Typecheck all: `npm run typecheck` at repo root. App tests: `npm test --workspace=app`.
- Long test runs go to background; read the output file when notified. Never chain `sleep`.
- APK build (from `app/`):
  `EXPO_TOKEN=<ask the user for the Expo access token — it is a SECRET; this repo is public, never commit it> npx eas-cli build --platform android --profile preview --non-interactive --no-wait`
  → note the build id → poll in a background loop:
  `npx eas-cli build:view <id> --json` until status FINISHED → artifact URL is
  `.artifacts.buildUrl` → give the user that URL (APKs are >30MB; never SendUserFile).
- Deployed backend: `https://scribble-rjma.onrender.com`. **Render does NOT auto-deploy.**
  After pushing backend changes, ask the user to click Manual Deploy in Render, then
  VERIFY the deploy took before testing (see §6 probe — if the probe returns a verbatim
  echo title, the old code is still live; tell the user, don't debug ghosts).
- Git: commit per slice on `main`, push `git push -u origin main`. Message = what user
  experience changed and why; never mention model names.

## §2 Non-negotiable engineering rules

1. **No intelligence in clients.** Classification, time resolution, decomposition,
   scheduling decisions happen server-side only. Clients capture, render, ring.
2. **The deterministic parser always beats the model on times.**
   `resolveTimeIntent()` in `backend/src/ai/providers/heuristic.ts` already enforces
   this. Never weaken it — a hallucinated time already burned the user once.
3. **Regression law: nothing is fixed twice.** Every user-reported bug gets a named
   test in the same slice that fixes it. Existing guards to never break:
   pause-erases-speech (fix in `app/src/speech.ts` — accumulate finalized segments),
   hallucinated-time test in `backend/test/ai-provider-chain.test.ts`, re-nag tests in
   `backend/test/reminders.test.ts`.
4. **Never hand the user an unverified build.** Backend: run the §6 corpus probe
   against the LIVE deployed API first. App: `npx tsc --noEmit` + `npx expo config
   --type prebuild` must pass (config errors break EAS builds 25 minutes in).
5. **One APK per round.** Batch all app-side slices before rebuilding.
6. **After writing each slice: run the `code-review` skill on the diff, fix what it
   finds, then commit.** Use the `verify` skill before committing backend slices.
7. Microcopy voice: first person, concrete, warm, never robotic, never blames the user.
   "I'll catch you at 4:30 — before the gym." Never "Reminder created successfully."
   Errors: "Couldn't reach the server — I've kept it safe here." Never "Network error".

## §3 SLICE A — Real offline alarms (highest trust impact; do first)

Goal: a due reminder RINGS like a clock alarm — full-screen over the lockscreen,
looping sound, Stop + Snooze buttons — with the app killed and the phone offline.

### A1. Install & config
- `cd app && npm install react-native-notify-kit` (maintained Notifee-compatible fork;
  Notifee itself is archived. AlarmManager exact triggers by default
  (SET_EXACT_AND_ALLOW_WHILE_IDLE), re-arms after reboot, Expo config plugin).
- Check `node_modules/react-native-notify-kit/app.plugin.js` exists → add
  `"react-native-notify-kit"` to `app/app.json` `plugins`. If no plugin file, skip the
  plugin entry.
- Add to `app.json` `android.permissions`: `"android.permission.SCHEDULE_EXACT_ALARM"`,
  `"android.permission.USE_FULL_SCREEN_INTENT"`, `"android.permission.RECEIVE_BOOT_COMPLETED"`.
- Validate: `npx expo config --type prebuild` prints without error.

### A2. App API client (`app/src/api.ts`)
Add to `ApiClient` interface + `HttpApi`:
```ts
export interface ReminderView { id: string; itemId: string; title: string; fireAt: number;
  recurrence: string | null; snoozedUntil: number | null; deliveredAt: number | null; seenAt: number | null; }
reminders(): Promise<ReminderView[]>;            // GET /v1/reminders
```
(`snoozeReminder`/`markReminderSeen` already exist.) Also change `registerDevice` to
send `capabilities: { localAlarms: true }` in its POST body (backend already stores
capabilities JSON). Update the fake api in `app/test/store.test.ts` with
`async reminders() { return []; }` (it implements the full interface; TS will fail
until you do).

### A3. New file `app/src/alarms.ts`
Behavior spec (write clean code around this):
```ts
import notifee, { AndroidCategory, AndroidImportance, EventType, TriggerType } from 'react-native-notify-kit';
// setupAlarms(api): create channel once:
//   notifee.createChannel({ id: 'scrible-alarm', name: 'Reminders (alarm)',
//     importance: AndroidImportance.HIGH, sound: 'default' })
//   request permission: await notifee.requestPermission()
// syncAlarms(api): const due = await api.reminders();
//   const pending = due.filter(r => !r.seenAt && r.fireAt > Date.now());
//   // full reconcile, idempotent: cancel everything ours, recreate from server truth
//   const ids = await notifee.getTriggerNotificationIds();
//   await Promise.all(ids.filter(id => id.startsWith('rem-')).map(id => notifee.cancelTriggerNotification(id)));
//   for (const r of pending) await notifee.createTriggerNotification({
//     id: `rem-${r.id}`, title: 'Scrible', body: r.title,
//     data: { reminderId: r.id },
//     android: { channelId: 'scrible-alarm', category: AndroidCategory.ALARM,
//       importance: AndroidImportance.HIGH, sound: 'default', loopSound: true,
//       fullScreenAction: { id: 'default' }, pressAction: { id: 'default' },
//       actions: [ { title: 'Stop', pressAction: { id: 'stop' } },
//                  { title: 'Snooze 10m', pressAction: { id: 'snooze' } } ] } },
//     { type: TriggerType.TIMESTAMP, timestamp: r.fireAt, alarmManager: { allowWhileIdle: true } });
// handleAlarmEvent(type, detail): shared by fg/bg handlers:
//   reminderId = detail.notification?.data?.reminderId; if none, return.
//   if pressAction.id === 'snooze': call api.snoozeReminder(id, 10) (catch->ignore),
//     cancel the notification, schedule a local re-ring at now+10min with same shape
//     (so snooze works offline too).
//   else (press 'stop' or 'default' tap): api.markReminderSeen(id) (catch->ignore),
//     notifee.cancelNotification(detail.notification.id).
// The bg handler runs with the app killed: it must build its own HttpApi —
//   baseUrl: process.env.EXPO_PUBLIC_API_URL ?? (same fallback as App.tsx),
//   token: await AsyncStorage.getItem('scrible.token').
// Export: setupAlarms, syncAlarms, handleAlarmEvent.
```
If `loopSound` or an option doesn't exist in the fork's types, drop that single option
(graceful degradation), don't fight it — check
`node_modules/react-native-notify-kit/dist/types/NotificationAndroid.d.ts` (or
equivalent) for exact names before writing.

### A4. Wiring
- `app/index.ts` (module scope, after widget registration, Android-only guard):
  `notifee.onBackgroundEvent(async ({ type, detail }) => handleAlarmEvent(type, detail))`.
- `App.tsx`: in the signed-in effect (where `setupPushNotifications` runs): also
  `setupAlarms(api)` then `syncAlarms(api)`; add a 60s interval calling
  `syncAlarms(api)` (separate from the 5s store sync — do NOT hit /v1/reminders every 5s).
  Register `notifee.onForegroundEvent` → same `handleAlarmEvent`.
- `app/src/push.ts`: no change needed (push tap handling stays expo-notifications).

### A5. Backend: complete-item kills the alarm + no double alert
- `backend/src/modules/sync.ts`, `case 'item.complete'`: after the items UPDATE, add:
  `await this.db.prepare('UPDATE reminder_triggers SET seen_at = ?, updated_at = ? WHERE item_id = ? AND user_id = ? AND seen_at IS NULL').run(Date.now(), Date.now(), op.entityId, userId);`
  (Rationale: completed item's pending trigger must vanish from GET /v1/reminders so
  the phone cancels its local alarm on next sync; also stops server re-nag races.)
- `backend/src/notifications/index.ts`: `NotificationDispatcher.notify` opts gains
  `suppressPushForLocalAlarmDevices?: boolean`. In the device loop, before
  `sender.send(...)`: parse `device.capabilities` JSON; if the flag is set AND
  `capabilities.localAlarms === true`, skip the send (still write the outbox row).
  In `ReminderScheduler.tick`, pass the flag as `isFirstDelivery` (first fire rings
  locally on the phone; 5-min re-nags still push, and other devices always push).
- Tests: in `backend/test/reminders.test.ts` add:
  (1) "completing an item clears its pending trigger's seen_at" — create timed
  reminder, complete item via POST /v1/items/:id/complete, assert GET /v1/reminders
  shows seenAt set. (2) "first delivery suppresses push for localAlarms devices" —
  register device with capabilities {localAlarms:true} via POST /v1/devices, deliver,
  assert outbox row exists (channel expo-push is fine) — behavioral assert is the
  skip; simplest observable: no throw + existing counts unchanged. Keep it minimal.

### A6. Verify & ship
- `npm run typecheck` root; backend suite green; app tests green;
  `npx expo config --type prebuild` clean.
- Run `code-review` skill on diff; fix findings; commit
  ("Reminders ring as real offline alarms with Stop/Snooze").
- Push. Tell the user: Render Manual Deploy needed (A5 is backend).

## §4 SLICE B — The live agent timeline (the "feels alive" moment)

Goal: after speaking, the user watches the assistant work, stage by stage, with real
content in each stage — not a spinner then a blob.

### B1. Backend staged updates (`backend/src/enrichment.ts`)
Currently one final `serverUpdateItem` after classify+decompose+confirm. Change to:
- Immediately after `const cls = await orchestrator.run('classify', ...)` (and after
  the existing routineFact early-return branch): write an interim update —
  `await sync.serverUpdateItem(userId, itemId, { type: cls.type, title: cls.title,
  confidence: cls.confidence, contextTag: cls.contextTag, appTrigger: cls.appTrigger,
  importance: cls.importance, timeIntent: cls.timeIntent,
  summary: understandingLine });` where `understandingLine` =
  `` `Understood — ${cls.type}: “${cls.title}”` `` + (cls.timeIntent?.at ? `` ` · ${formatWhen(cls.timeIntent.at)}` `` : '')
  (import `formatWhen` from `../calendar/service.js`). Status stays `processing`.
- Decompose + subtask ops unchanged (they already stream as separate ops).
- Final update unchanged (summary from confirm + `status: 'active'`).
- Existing enrichment tests still pass (they assert final state after `jobs.onIdle()`).
  Add one: capture with a stubbed nvidia fetch, DON'T await onIdle fully — hard to
  time-slice; instead assert via change feed: after onIdle, `GET /v1/sync/changes`
  contains ≥2 item upserts for the id with different summaries (interim then final).

### B2. Capture screen timeline (`app/src/screens/Capture.tsx`)
Replace the single `feedback` line (keep the voiceDone shortcut behavior) with a staged
timeline rendered under the mic once `lastItemId` is set. Derive stages from
`props.store.items[lastItemId]` inside the existing `store.subscribe` effect:
- Stage 1 `Heard you` — complete immediately on save(); text = the transcript (1 line, ellipsized).
- Stage 2 `Understanding` — complete when `item.confidence != null`; text = `item.summary`
  (the interim "Understood — …" line).
- Stage 3 `Breaking it down` — complete when `item.status === 'active'` OR
  `(item.subtasks?.length ?? 0) > 0`; text = subtasks.length
  ? `${subtasks.length} steps ready` : `Nothing to break down — it's one clean action`.
- Stage 4 `Locked in` — complete when `item.status === 'active' || 'scheduled'`;
  text: if `item.timeIntent?.at` → `Alarm set — ${new Date(at).toLocaleTimeString([, ]{hour:'numeric',minute:'2-digit'})}`;
  else if importance major → `On your calendar`; else `Safe in your queue`.
Visual: vertical list, each row = status glyph (○ pending → animated ● pulsing while
current → ✓ accent when done) + label + result text (dim). Animate row appearance with
`Animated` fade+slide (only motion on this screen). Haptics: `expo-haptics`
`impactAsync(ImpactFeedbackStyle.Light)` on record start,
`notificationAsync(NotificationFeedbackType.Success)` when Stage 2 completes.
Reset the timeline when a new recording starts.

### B3. Verify & ship
Typecheck + app tests + backend suite. `verify` skill: capture "remind me to check the
oven in 25 minutes" against LOCAL backend (`npm run dev` in backend with test DB) or
live API; watch `/v1/sync/changes` contains staged updates. `code-review` skill.
Commit ("You watch the assistant think — staged understanding, live timeline").
Backend half → remind user: Render deploy.

## §5 SLICE C — Widgets that feel native

### C1. app.json widget config (replace the widgets array)
```json
"widgets": [
  { "name": "ScribleCapture", "label": "Scrible — Capture", "description": "Tap and talk — Scrible handles the rest",
    "minWidth": "250dp", "minHeight": "40dp", "targetCellWidth": 4, "targetCellHeight": 1,
    "resizeMode": "horizontal", "updatePeriodMillis": 0 },
  { "name": "ScribleTodo", "label": "Scrible — Right now", "description": "Your queue on the home screen",
    "minWidth": "180dp", "minHeight": "180dp", "targetCellWidth": 3, "targetCellHeight": 3,
    "resizeMode": "horizontal|vertical", "updatePeriodMillis": 1800000 }
]
```
(Keep name `ScribleCapture` — renaming orphans existing home-screen widgets.)

### C2. `app/src/widgets/CaptureWidget.tsx` — redesign to a 4x1 bar
FlexWidget row, `height/width: 'match_parent'`, backgroundColor `#1A1C23`,
borderRadius 24, padding 12, alignItems center:
[accent circle (44dp, `#E8B84B`, borderRadius 22) containing 🎙] + 12dp gap +
TextWidget hint. Props: `{ recording?: boolean }` — when recording: circle turns
`#E06C6C`, hint = `● Recording…` (color `#E06C6C`), else hint = `What's on your mind?`
(color `#9AA0B0`, fontSize 14). Whole widget `clickAction OPEN_URI` →
`scrible://capture?autostart=1` (unchanged).

### C3. New `app/src/widgets/TodoWidget.tsx`
Header FlexWidget row: TextWidget `Right now` (bold, `#F2F3F7`) + spacer + mic circle
(same accent, clickAction OPEN_URI capture deep link). Below: `ListWidget` with up to
10 rows; each row a FlexWidget (padding 10, clickAction OPEN_URI `scrible://queue`):
colored 8dp dot by type (task `#6FA8DC`, idea `#B78BE8`, reminder `#7BC98F`) +
TextWidget title (maxLines 1, truncate END) + right-aligned time `h:mm` if
`timeIntent.at`. Empty state row: `Nothing waiting — tap the mic and talk.`
Data source: read AsyncStorage key `scrible.store.v1`, parse `{ items }`, then
**mirror `store.queue()`'s exact filtering/sorting — read `app/src/store.ts` and copy
its logic** (don't guess; timed-first ordering, active statuses only), cap 10.

### C4. `app/src/widgets/widget-task-handler.tsx` + refresh plumbing
- Handler: switch on `props.widgetInfo.widgetName` — `ScribleCapture` →
  `<CaptureWidget/>`; `ScribleTodo` → load items from AsyncStorage (handler runs in
  headless JS; AsyncStorage works) → `<TodoWidget items={...}/>`.
- New `app/src/widgets/refresh.ts`: `updateTodoWidget()` and
  `setCaptureWidgetRecording(recording: boolean)` — both call `requestWidgetUpdate({
  widgetName, renderWidget: ... })` from `react-native-android-widget`, wrapped in
  `Platform.OS === 'android'` + try/catch. Debounce `updateTodoWidget` (1s trailing).
- `App.tsx`: effect on `version` (the store-change counter) → `updateTodoWidget()`;
  also once on start. DO NOT import widget code into `app/src/store.ts` (its tests run
  in plain node; RN imports would break them).
- `Capture.tsx`: call `setCaptureWidgetRecording(true)` when recording starts,
  `(false)` in onFinal/onError/stop.
- `App.tsx` deep links: add `queue` handling next to `capture`:
  hostname/path `queue` → `setTab('queue')`.

### C5. Verify
Typecheck; `npx expo config --type prebuild` clean; app tests green; `code-review`
skill; commit ("Home-screen capture bar with live recording state + Right-now widget").

## §6 SLICE D — Whole-day Schedule + backend probe corpus

### D1. `app/src/screens/Schedule.tsx` — rebuild as day timeline
Data (all client-side, no backend change):
- `api.getProfile()` → `attributes.routines` (RoutineBlock: label, days?, startHour, endHour?).
- Store items with `timeIntent?.at` in the next 7 days, status not done/dismissed.
- `api.getSchedule()` blocks (state !== 'released').
Render: sections per day (Today, Tomorrow, weekday names). Within a day, rows sorted
by time: routine spans (muted `#242732` rows, "College · 8:00–16:00"), items
(time + title; importance `major` → accent left border 3dp + bold; reminders show ⏰),
blocks merge onto their item row (show the range). Pull-to-refresh refetches. Empty
day: `Free — nothing scheduled.` Keep it a FlatList of rows, no timeline graphics.

### D2. The messy-speech corpus (new committed file `backend/scripts/corpus.txt`)
15 lines, one utterance per line — include the exact past failures:
"oh I forgot my key, remind me to take the key next time at 4:30, that's usually when I go to the gym" /
"I have a meeting in the next minute remind me" /
"hello so I got to build an app the app is just scribbling and it write down my thoughts and all" /
"maybe swing by the pharmacy sometime after work if I remember" /
"I have to go to the gym at 5:30" /
"I'm at college till 4 on weekdays" / plus ~9 more with fillers/self-corrections
("call mom no wait call dad tomorrow evening", "ummm I think I need to like renew the
license before Friday", …).
New `backend/scripts/probe.mjs`: signs up a throwaway account against
`https://scribble-rjma.onrender.com` (or `PROBE_URL` env), POSTs each corpus line as an
item, waits ~4s, GETs each item + `/v1/ai/metrics`, prints a table: rawText → type /
title / time / importance / subtask count, and FAILS (exit 1) if: any title equals the
raw text (verbatim echo = old code live), or "in the next minute" resolves > 5 min out,
or metrics show `heuristic-confident` calls (impossible with an LLM key on new code).
**Run this after every Render deploy, before telling the user anything works.**

### D3. Verify & ship
Typecheck/tests; `code-review`; commit ("Your whole day on one screen" + probe corpus).

## §7 SLICE E — Ten-year details pass (one sweep, app-wide)

- **Microcopy sweep** per §2.7 voice: grep all user-visible strings in
  `app/src/screens/*.tsx` and fix flat/robotic ones. Known offenders: sync status
  lines in Settings, generic error strings in Capture, empty states.
- **Empty states teach**: Queue → `Nothing on your mind — hold the mic and just talk.`;
  Activity → keep; Schedule → per §6; Settings routines section already handled.
- **Haptics map** (expo-haptics, already a dependency): record start (light impact),
  understanding complete (success notification), item complete-check (selection),
  alarm snooze via in-app action (medium impact).
- **Motion**: ONLY the capture timeline animates (already in Slice B). Remove/avoid any
  other animation.
- **Accessibility**: `accessibilityLabel` + `accessibilityRole` on: mic button (already),
  every tab (already), complete-check circles, widget-related buttons, timeline rows
  (`accessibilityLiveRegion="polite"` on the current stage row so screen readers hear
  progress).
- **Latency**: Stage 1 of the timeline must appear optimistically (from local state, not
  server round-trip) — verify by running the app with network off: capture still shows
  Stage 1 immediately and queues the item (offline-first store already guarantees data).
- Commit ("Details pass: voice, haptics, empty states, a11y").

## §8 Ship round (after Slices A–E)

1. Full verification: root typecheck; backend suite (with local Postgres up); app +
   desktop tests. All green or fix before proceeding.
2. Push; user does Render Manual Deploy; run `node backend/scripts/probe.mjs` and read
   every row yourself; only proceed when it exits 0.
3. Build ONE APK (runbook §1). Send the user the artifact URL with this device script:
   - Add both widgets. Tap the capture bar → recording within ~1s, widget shows "● Recording…".
   - Say: "remind me to drink water in 2 minutes … actually make it 3 minutes" (with a
     real 3-second pause at the …). Expect: timeline ticks 4 stages; title ≈ "Drink
     water"; time = ~3 minutes out (the pause must NOT erase the first half).
   - Kill the app. Turn on airplane mode. Wait 3 minutes → full-screen alarm rings.
     Tap Snooze 10m → it dies and returns in 10. Tap Stop → gone for good.
   - Check the To-Do widget shows the queue; complete an item in-app; widget updates
     within a few seconds.
   - Open Schedule → routines + the timed item visible on today.
4. File every piece of user feedback as a task; anything broken becomes a named test
   (regression law) before its fix is written.

## §9 Held for later (decisions, not omissions)
- `POST /v1/capture/audio` + server-side transcription — the hardware device's door.
  When built: multipart audio upload → STT provider → feeds the SAME enrichment
  pipeline at `sync.onItemCreated`. Nothing in this plan may assume text-only capture
  (it doesn't — enrichment takes rawText regardless of source).
- Recall ("what did I say about X") and a morning briefing — capability work, next phase.
- Chat-back replies; iOS builds; Google Calendar OAuth (needs user's Google Cloud
  setup); true geofencing (routine times approximate it).

## §10 Known landmines (each cost real time once)
- Render never auto-deploys; always verify with the probe before debugging "bugs".
- `expo config --type prebuild` before every EAS build; a bad plugin config fails late.
- Widget names are permanent once shipped.
- `app/src/store.ts` must stay free of react-native imports (node tests).
- Backend tests: start Postgres first; run test files with `--test-concurrency=1`.
- The pg shim: always `await db.prepare(...).run/get/all(...)`; `?` placeholders.
- LWW field versions in sync.ts: server updates in the same ms are fine (`>` not `>=`).
- expo-notifications categories: reminder pushes already carry `categoryId: 'reminder'`
  (Stop/Snooze). Don't collide notify-kit channel ids with expo's (`scrible-alarm` vs
  `default`).
- The NVIDIA key/model: default `meta/llama-3.1-8b-instruct`; a 200-with-empty-choices
  means the model slug isn't available on the account — it's logged now, check Render logs.
