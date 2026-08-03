# Scrible — The Vision

Companion to `docs/SPEC.md` (the how). This is the **why and what-for** — the
document that explains the whole app to anyone (or any model) picking it up cold.

---

## 1. The problem

ADHD is not a knowledge problem — the person knows what they need to do. It is a
**working-memory and time-perception problem**:

- A thought ("I need to renew my license") exists for seconds. If it isn't captured
  in those seconds, it's gone until the consequence arrives.
- Intentions don't survive transitions. Walking from one room to another erases the plan.
- Time is invisible: "later" and "in three weeks" feel identical until suddenly it's now.
- Every existing tool assumes the discipline it's supposed to replace: to-do apps
  require opening the app, remembering it exists, typing, categorizing, prioritizing.
  Each of those steps is exactly what ADHD breaks. So every to-do app becomes a
  graveyard within two weeks.
- Reminders that can be swiped away silently get swiped away silently. A notification
  is a suggestion; ADHD needs an interruption.

## 2. The end goal

**Scrible is an external brain — a real assistant, not an app.**

The one-sentence goal: *the user speaks a thought once, in the moment it occurs, and
Scrible takes full responsibility for it from that point on* — understanding it,
remembering it, breaking it down, scheduling it, and physically interrupting the user
at the right moment so it actually happens.

The measure of success is trust: after two weeks of use, the user stops keeping
backup systems (sticky notes, phone alarms, asking people to remind them) because
Scrible has never dropped anything. That is the entire product. Every feature either
builds that trust or doesn't ship.

## 3. The principles

1. **Capture must cost nothing.** One tap (widget) or zero taps (future hardware),
   then talk. No forms, no categories, no titles, no due-date pickers. Rambling,
   self-correcting, half-finished speech is the expected input format.
2. **All intelligence lives server-side.** Phones, widgets, desktops, the browser
   extension, and the future clip-on device are dumb capture-and-alert surfaces.
   This is an architectural law, not a preference — it's what makes every future
   surface (including hardware with no screen) possible.
3. **The assistant understands; it never transcribes.** "call mom no wait call dad
   tomorrow evening" becomes *Call dad — tomorrow evening*, not an echo of the mess.
   A wrong understanding (especially a wrong time) is worse than no understanding.
4. **Alarms, not notifications.** When Scrible promised to remind you, your phone
   rings — looping sound, full screen, works offline and with the app killed. Stop
   and Snooze are explicit choices made right there. Nothing important can be
   accidentally swiped into oblivion, and ignoring it triggers re-nagging.
5. **Honesty everywhere.** The app never claims a capability it hasn't verified
   (alarms, push, calendar). A silent failure is the worst bug class in the codebase.
6. **The app adapts to the person, not the reverse.** It learns routines from
   ordinary speech ("I'm at college till 4 on weekdays"), schedules around them,
   learns how fine-grained the person needs task breakdowns, and gets more useful
   the longer it's used — without a single settings screen visit.
7. **Never overwhelm.** The queue shows at most five things. The point is always
   "what do I do *now*", never "look at everything you owe".

## 4. Who it's for

Primarily: people with ADHD (diagnosed or not) who have burned through every
to-do/productivity app. Secondarily: anyone whose thoughts outrun their systems —
students, founders, parents running a household, people juggling shift work.

## 5. The use cases — all of them

### Capture (the thought is fleeting)
- **The shower/walking/driving thought:** "oh I need to email the landlord" — widget
  tap, speak, done. The thought is now Scrible's problem.
- **The mid-task interruption:** working on X, remember Y — capture Y in 5 seconds
  and return to X without losing either.
- **The correction mid-speech:** "call mom no wait call dad" — the assistant keeps
  only the corrected intent.
- **The double thought:** "remind me about the key and also idea: app that summarizes
  my week" — one utterance, two items, each handled correctly.
- **Offline:** in a basement, on a plane — capture works, syncs later.

### Remembering (time-blind by default)
- **The hard appointment:** "dentist tomorrow at 4:30" — rings at 4:30 *local time*,
  full alarm, re-nags if ignored.
- **The micro-reminder:** "take the pizza out in 20 minutes" — exact, deterministic,
  never hallucinated.
- **The routine anchor:** "remind me to take my meds every morning" — recurring alarm.
- **The pre-departure item:** "take the key next time I leave for the gym" — anchored
  to the gym routine it has learned.
- **The someday-with-a-deadline:** "renew the license before Friday" — scheduled with
  enough lead time, not at the deadline.
- **The computer-bound action:** "reply to that email when I'm at my laptop" — fires
  on the desktop/extension when the user is actually there (not on the phone at
  dinner).

### Understanding & breakdown (starting is the wall)
- **The overwhelming project:** "plan the product launch" — broken into real,
  concrete, startable steps (guideline quality, not busywork).
- **The routine action:** "go to the gym at 5:30" — NO breakdown; it's one action.
  Padding simple things with steps destroys trust in the breakdowns that matter.
- **The idea:** "what if the app could summarize my week" — kept as an idea, never
  nagging, never lost, findable later.
- **The life-fact:** "I'm at college till 4 on weekdays" — not a task; remembered as
  a routine, used forever after for scheduling.

### The day (seeing time)
- **"What does my day look like?"** — one timeline: routine bands (college, gym,
  sleep) with timed items placed on top. The *whole* day, not just "important" blocks.
- **Auto-scheduling:** a major task with a time requirement gets placed into an
  actual free slot — never inside a routine, never double-booked.
- **"What do I do right now?"** — the Queue (and the Right-now widget): max five
  items, timed ones first.

### Longer-term & personalization
- Scrible learns preferred granularity of breakdowns, active hours, and routines,
  from behavior and speech — the assistant a year in is materially better than day one.
- Optional chat-history import seeds the personality/profile so day one isn't cold.
- Everything learned is visible and deletable (Settings → honesty).

### Future surfaces (parked; architecture already supports them)
- **The clip-on hardware device:** a physical switch on your collar/pocket — press,
  speak, release. No phone, no screen, no app open. The device streams to the same
  server brain; alarms still ring on whatever surface is nearest. This is why no
  intelligence may ever live in a client.
- **The calling agent:** for the biggest tasks, the assistant *calls you* and talks
  the plan through — the highest-friction interruption for the highest-stakes items.
- **Desktop + extension parity:** computer-bound reminders firing at the computer.

## 6. What Scrible is NOT

- Not a project-management tool (no boards, no labels, no collaboration).
- Not a note-taking app (capture is for *actionable* thought; ideas are kept, but the
  product isn't a knowledge base).
- Not a calendar replacement — it reads and writes to your day, but the product is
  the *assistant*, not the grid.
- Not a productivity maximizer. The goal is *nothing falls through*, not *do more*.
- Never a graveyard: anything that would let items rot invisibly is a design bug.

## 7. How we know it's working

- The user tests every feature on a real phone against `docs/SPEC.md` scripts —
  a feature is done when its script passes on-device, not when tests pass.
- The live probe (`backend/scripts/probe.mjs`) guards comprehension quality on every
  deploy; every real-world failure becomes a permanent named regression test.
- The ultimate metric, restated: **the user deletes their backup systems.**
