# Scrible — Feature Spec List

The rule of this document: **one feature at a time, perfected, then move on.**
Each feature below has (a) exactly what "perfect" means, written as behavior you can
observe on the phone, (b) where it stands today, and (c) the test script — the steps
that must pass before the feature is called DONE and the next one is started.

Recommended order: features are listed in it. Reminders & Alarms is first because it
is the active pain point and the core promise of the app.

Status legend: `SHIPPED` = in the current APK/backend · `BUILT` = code pushed but not
yet verified on a device · `PARTIAL` = some of the spec exists · `NOT BUILT`.

---

## 1. Reminders & Alarms  ⟵ current focus

**Purpose:** when Scrible says it will remind you, your phone RINGS — a real alarm,
not a quiet notification. This is the trust core of the whole app.

**Spec — perfect means:**
1. Saying "remind me to drink water at 12" creates a reminder that fires at 12:00
   **in your local clock** (IST), never a UTC-shifted time.
2. At fire time the phone rings like an alarm clock: looping sound, full-screen takeover
   if the phone is locked, works with the app killed and with no internet (the alarm is
   scheduled locally on the phone, not dependent on a push arriving).
3. The ringing screen/notification has two buttons: **Stop** and **Snooze 10m**.
   Both work right there — no opening the app. Stop silences it and marks it seen;
   Snooze silences it and re-rings 10 minutes later.
4. If you ignore it, it re-nags every 5 minutes (server push) for up to 2 hours, then
   gives up but stays overdue in the Queue.
5. Completing the item in the app before fire time cancels the pending alarm.
6. Settings → Alarms tells the truth: "Exact alarms on" only when the phone verified
   the permission; otherwise it shows a one-tap fix. The app never claims alarm
   capability to the server unless it's verified (otherwise server push covers it).

**Status:** SHIPPED — Exact alarm engine (`app/src/alarms.ts`), high-importance Android channel (`scrible_alarms`), notification action buttons (`STOP`, `SNOOZE 10M`), permission verification UI in Settings, pre-completion cancellation, and server capability gating implemented and verified by automated test suite & `probe.mjs`.

**Test script (device):**
- [ ] Install latest APK, sign in, open Settings → Alarms shows "Exact alarms on"
      (grant the Android "Alarms & reminders" permission if prompted, restart app).
- [ ] Say "remind me to drink water in 3 minutes". Lock the phone. It must ring
      (sound + screen) within seconds of the mark.
- [ ] Press **Stop** on the ringing notification — it silences and disappears
      without the app opening.
- [ ] Repeat with **Snooze** — it re-rings ~10 minutes later.
- [ ] Repeat "in 3 minutes" test in **airplane mode** — must still ring (local alarm).
- [ ] Say "remind me at <a wall-clock time ~5 min out>" — verify the Queue shows the
      right local time and it rings at that time.
- [ ] Ignore one reminder entirely — a re-nag push arrives ~5 minutes later.

---

## 2. Voice & Text Capture

**Purpose:** zero-friction dumping of a thought before ADHD loses it.

**Spec — perfect means:**
1. Mic button starts recording instantly; speech appears live as you talk.
2. Pauses in speech never erase earlier words; rambling multi-sentence speech is kept
   whole.
3. Saving works offline — the item appears in the Queue immediately, syncs later.
4. One utterance containing two thoughts ("remind me X and also idea Y") becomes two
   items.
5. Typed capture works identically via the text field.

**Status:** SHIPPED and user-confirmed working (pause-erases-speech bug fixed).

**Test script:** record with deliberate 3-second pauses mid-sentence → full text kept;
capture in airplane mode → item usable instantly, syncs when back online.

---

## 3. Understanding (the AI brain)

**Purpose:** Scrible *understands* what you said — it never just echoes it back.

**Spec — perfect means:**
1. Every capture gets a clean short title (never the verbatim transcript), a type
   (task / idea / reminder), and an importance (major / normal).
2. Times resolve correctly: relative ("in 3 minutes") exactly; wall-clock ("at 12",
   "Monday 2pm", "tomorrow evening") in YOUR timezone; fuzzy ("after work") sensibly.
   A missing time is acceptable; a wrong time never is.
3. Genuine projects get useful step breakdowns; routine actions ("go to the gym") get
   ZERO busywork steps.
4. Statements about your life ("I'm at college till 4 on weekdays") are remembered as
   routines — auto-completed, visible in Settings, used by Schedule.
5. Corrections mid-speech are honored ("call mom no wait call dad" → Call dad).
6. All of this runs server-side (clients stay dumb capture surfaces).

**Status:** SHIPPED — live probe (16-line corpus) passes against production,
including the timezone line. Guarded by `backend/scripts/probe.mjs`; run it after
every backend deploy.

**Test script:** `node backend/scripts/probe.mjs` exits 0. On device: capture 5 messy
real thoughts; every title reads like an assistant wrote it; no invented times.

---

## 4. Queue

**Purpose:** the "what do I do now" list — short, honest, never overwhelming.

**Spec — perfect means:**
1. Shows at most 5 items; anything with a time sorts first.
2. Completing an item is one tap, works offline, never comes back.
3. Expanded items show their step breakdown; steps checkable individually.
4. Overdue reminders stay visible and marked until dealt with.

**Status:** SHIPPED, needs a focused device pass once alarms are perfected.

**Test script:** capture 7 items → only 5 show, timed first; complete one offline →
stays completed after sync; expand a project → steps check off.

---

## 5. Schedule

**Purpose:** your real day at a glance — routines AND items, not just "important" blocks.

**Spec — perfect means:**
1. A day timeline showing learned routines as background bands, timed items on top.
2. Major items with explicit times get calendar blocks auto-placed in free slots.
3. Calendar section never lies: shows "linked"/sync status honestly.
4. New routines learned from speech appear without any manual setup.

**Status:** PARTIAL — timeline + routine bands + major-item auto-scheduling shipped;
needs a dedicated perfecting pass (density, empty states, block editing).

**Test script:** tell it a routine ("I'm at college till 4 on weekdays") → band appears
on weekdays; capture a major timed item → block appears in a free slot, not inside a
routine band.

---

## 6. Home-screen Widgets

**Purpose:** capture without even opening the app.

**Spec — perfect means:**
1. 4x1 capture bar: tapping it opens Capture and starts recording immediately
   (one tap total from home screen to talking).
2. 3x3 "Right now" widget mirrors the top of the Queue, updates when items change,
   tap opens the Queue.
3. Both look native and crafted — no emoji-as-icon, correct spacing.

**Status:** PARTIAL — both widgets shipped and functional; the drawn mic mark and
design-system pass are pending (see Feature 8). Update latency needs a device check.

**Test script:** from home screen, one tap → recording within ~2s; complete an item in
app → Right-now widget reflects it within a minute.

---

## 7. Push Notifications (fallback + re-nags)

**Purpose:** delivery safety net for devices without verified local alarms, and the
re-nag channel for ignored reminders.

**Spec — perfect means:**
1. If local alarms are verified, first delivery is silent server-side (no double alert);
   re-nags still push.
2. If local alarms are NOT verified, the server pushes at fire time — reminders never
   silently vanish.
3. Push notifications carry Stop/Snooze buttons that work without opening the app.
4. Settings shows push status honestly (registered / no permission / failed + reason).

**Status:** BUILT — capability gating + background Stop/Snooze in the current APK,
not yet device-verified.

**Test script:** covered by Feature 1's script (ignore-and-re-nag step, buttons step);
plus: revoke notification permission → Settings says so plainly.

---

## 8. Design ("a quiet instrument")

**Purpose:** the app stops looking AI-generated; it looks like ten years of craft.

**Spec — perfect means:**
1. The approved mockup (design artifact) is implemented 1:1: ink/brass palette, 5 type
   voices, strict 4pt spacing tokens (screen 20 / card 16 / row 12 / intra 8 / section 28),
   hairlines not shadows, no emoji in chrome.
2. The mic is a drawn concentric-circle mark — same signature in app, widgets, icon.
3. Custom app icon + splash (no default Expo icon anywhere).
4. Every spacing value in code is a named token; no ad-hoc numbers.

**Status:** PARTIAL — mockup artifact published, awaiting reaction/iteration; no RN
code restyled yet; icon/splash not generated.

**Test script:** side-by-side phone vs mockup on all 5 screens + both widgets; a
stranger can't tell which is the mock. App icon on the launcher is the brass mark.

---

## 9. Settings & Honesty

**Purpose:** every capability the app claims is verifiable here — no silent failures.

**Spec — perfect means:**
1. Rows for Push, Alarms, Calendar, Routines, Consents — each states its real status
   and offers a one-tap fix when broken.
2. Learned routines are listed and deletable.
3. Account deletion and data export work as promised.

**Status:** SHIPPED (rows exist incl. new Alarms row) — verify alongside Feature 1.

---

## 10. Later (explicitly parked — do not touch until 1–9 are perfect)

- Desktop companion & Chrome extension styling/parity
- Calling agent (assistant phones you to talk through a plan)
- Chat-import personalization depth
- Hardware capture device (the clip-on) — the architecture rule that keeps this
  possible is already enforced: ALL intelligence lives server-side; every client is a
  dumb capture/alert surface.

---

## Working agreement (how each feature gets perfected)

1. Pick the next feature (top-most not-DONE in this list).
2. Fix/build until its full test script passes on YOUR phone, not just in tests.
3. Every bug found on device gets a named regression test in the same commit as its fix.
4. Backend changes aren't "done" until `probe.mjs` passes against the live deploy.
5. Only then mark it DONE here (edit this file, commit) and move to the next.
