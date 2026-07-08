# Scrible Desktop (Tauri 2)

Tray app whose background watcher notices when a specific application launches and
pops the matching Scrible items — *"when I open Photoshop remind me to export the
banner"* → notification the moment Photoshop starts.

## Privacy model (the whole point of this design)

- The app **syncs down** the user's app-triggered items (`POST /v1/desktop/checkin`
  + the normal change feed).
- The Rust watcher polls running process names every 4 s and diffs for new launches
  (`watcher-core/`, dependency-light and fully unit-tested).
- **Matching happens on this machine** (`src/matcher.ts`). Process/app names are
  never sent to the server; the check-in endpoint doesn't even accept them.
- The watcher only runs after the `app_watcher` consent is granted (first-run
  banner in the app, also visible/toggleable from the phone's Settings). Revoking
  from any device stops the watcher within ~30 s.

## Architecture

| Piece | Where | Notes |
|---|---|---|
| Process snapshot + launch diff | `watcher-core/src/lib.rs` | Only dep: `sysinfo`. `cargo test` runs anywhere (no GUI libs needed). |
| Shell (tray, window, events) | `src-tauri/src/main.rs` | ~70 lines: spawns the watcher thread, emits `app-opened` events, close-to-tray. Consent gate via the `set_watcher_enabled` command. |
| Matching + UI | `src/` | `matcher.ts` is pure (Node-tested); `main.ts` renders sign-in / item list, wires events, sends notifications. |

Behavior details:
- First poll primes the baseline — apps already running when the watcher starts are
  not "launches"; quitting and reopening an app triggers again.
- An item pops at most once per app session (per-launch cap in `main.ts`).
- **Done** completes through the normal item API, so it clears on the phone within
  seconds. Enabling the watcher while apps are running never floods (the baseline
  stays fresh even while disabled).
- Known matching limitation: some Windows binaries use abbreviated names
  (`POWERPNT.EXE`); users can edit the item's trigger to match, or we can ship a
  friendly-name alias table later.

## Development

Prerequisites: Rust (rustup), Node 22, and Tauri's per-OS system deps
(<https://tauri.app/start/prerequisites/>) — on Linux that's `libwebkit2gtk-4.1-dev`,
`libgtk-3-dev`, `librsvg2-dev`, `build-essential`.

```bash
# from repo root
npm install
npm run dev -w backend            # API on :8787

# watcher logic tests (no GUI deps needed)
cd desktop/watcher-core && cargo test

# full app (dev)
cd desktop && npm run tauri dev

# bundle installers (generate full icon set first)
npm run tauri icon src-tauri/icons/icon128.png
npm run tauri build
```

The frontend alone also runs in a plain browser (`npm run dev:web -w desktop`) —
Tauri APIs are feature-detected, so sign-in and the item list work for UI iteration;
only watcher events and notifications need the real shell.
