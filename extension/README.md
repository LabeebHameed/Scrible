# Scrible Chrome Extension (Manifest V3)

Surfaces your computer-action tasks ("post on X", "reply to that email") the moment
you're back at the browser — captured on your phone, completed at your laptop.

## How it works (MV3-safe, event-driven)

- The service worker holds **no in-memory state**; it wakes on browser startup and on
  first-activity-after-idle (`chrome.idle`), pulls pending items from the backend
  (`POST /v1/extension/checkin`), and shows **at most one** notification per browser
  session (frequency capping — the browser never nags).
- A 5-minute `chrome.alarms` tick keeps the badge count fresh while the browser is open.
- Completing an item in the popup calls the normal item API, so it clears on your
  phone within seconds; completing on the phone withdraws it from the next check-in.
- "Later today" / "Next session" snoozes are per-browser-session (`storage.session`).

## Permissions (kept minimal for Web Store review)

| Permission | Why |
|---|---|
| `storage` | Auth token, device id, per-session snoozes |
| `idle` | Detect "user is back at the computer" |
| `alarms` | Periodic badge refresh (MV3 has no persistent background) |
| `notifications` | The one-per-session popup reminder |

No tabs, history, or navigation access. Site-scoped triggers ("when I next open
x.com…") are a separately-consented future feature using **optional** permissions —
the default install reads no browsing signals at all.

## Development

1. Run the backend (`npm run dev -w backend`).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → this folder.
3. Click the Scrible icon, sign in with your account (server url defaults to
   `http://localhost:8787`).

Icons: place `icon16/48/128.png` under `icons/` before packaging for the Web Store
(placeholders are generated; replace with brand assets).
