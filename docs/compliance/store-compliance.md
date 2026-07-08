# Store Compliance Packages (build plan §10.4–10.6)

Submission checklists for the three stores. Each maps a store requirement to where
the codebase satisfies it. Re-verify against current store policies at submission.

## Apple App Store (iOS)

| Requirement | Status / where |
|---|---|
| Privacy nutrition labels | Declare: Contact Info (email, linked), User Content (tasks/audio-transient, linked), Identifiers (device push token, linked), Usage Data (analytics, **not linked** — pseudonymous ID unlinked from account, see `analytics/forwarder.ts`). **Tracking: NO** — nothing is shared for cross-app tracking, "no tracking" is truthfully claimable. |
| Purpose strings | Set in `app/app.json` plugin config: microphone + speech recognition ("capture tasks by speaking… transcribed on this device"). Add `NSCalendarsUsageDescription` when the EventKit bridge ships. Notifications permission requested in-context at first reminder. |
| Account deletion reachable in-app | Settings → "Delete account & all data" → `DELETE /v1/me` (Phase 0, tested). Meets the discoverability requirement (top-level Settings, no support contact needed). |
| Sign in with Apple | **Blocker until done:** required because Google sign-in will be offered. Endpoint shape exists (`POST /v1/auth/social`, currently 501) — wire Apple id-token JWKS verification before submission, or ship v1 with email-only auth (no social) to defer the requirement. |
| Age rating | 4+ expected (no objectionable content categories). |
| App Review notes | Provide demo account + a short video of the voice flow (reviewers may not speak). Note that voice is on-device STT and works in airplane mode. |

## Google Play Store (Android)

| Requirement | Status / where |
|---|---|
| Data safety form | Mirror the nutrition labels above. Collected: email, user content, device IDs; Shared: none; all encrypted in transit; deletion mechanism in-app. Analytics optional & pseudonymous. |
| Permissions | `RECORD_AUDIO` (in-context, pre-permission explainer in Capture), `POST_NOTIFICATIONS` runtime permission (requested when the first reminder is set). No device-calendar permission unless the EventKit-equivalent bridge ships. |
| Account deletion URL | Required alongside in-app deletion — publish a web page that signs the user in (Expo web build → Settings) and link it in the listing. |
| Target API level | Expo SDK 57 tracks current target API; keep `expo` updated at submission. |
| Content rating | Everyone. |

## Chrome Web Store (extension)

| Requirement | Status / where |
|---|---|
| Single purpose | "Surface your Scrible computer-action tasks when you're at the browser." The extension does exactly one thing. |
| Permission justifications | `storage` (auth token, session snoozes), `idle` (detect return-to-computer), `alarms` (badge refresh under MV3), `notifications` (one-per-session reminder). **No tabs/history/webNavigation** — the default install reads zero browsing signals. |
| Privacy disclosure | Listing must state: reads no browsing data; talks only to the user's configured Scrible server; site-scoped triggers are a future opt-in using `optional_permissions`. |
| Remote code | None — plain JS bundled in the package, no CDN/eval. |

## Operational compliance (§10.7)

- DSR tooling: `npm run dsr -w backend -- <export|delete|consent-history> <email>`
  — audited to stderr, deletion runs `verifyDeletion` across every user-data table
  and fails loudly on residuals.
- Deletion verification is also asserted in CI (`test/account.test.ts`,
  `test/personalization.test.ts`, `test/analytics.test.ts`).
- Data inventory: `docs/data-classification.md` — the source the labels/forms must
  match. **An inaccurate label is a rejection and a trust failure: re-audit this file
  against the schema before every submission.**
