# Data classification, retention & deletion paths

Required by build plan §5.5. Every stored field class, its sensitivity, retention, and
deletion path. This document must be updated whenever the schema changes.

Sensitivity levels: **S3** highly sensitive · **S2** personal · **S1** operational ·
**S0** non-personal.

| Data | Table / store | Sensitivity | Retention | Deletion path |
|---|---|---|---|---|
| Email, password hash | `users` | S2 | Life of account | Account deletion (`DELETE /v1/me`) |
| Timezone, working hours, notification prefs | `users` | S2 | Life of account | Account deletion |
| Consent records | `consents` | S1 (legal) | Life of account | Account deletion (consent history is deleted with the account; revocation itself is recorded, not deleted) |
| Item transcript / title / type / status | `items` | S2 | Until item deleted by user | Item delete op; account deletion |
| Item app-launch trigger (`app_trigger`) | `items` | S2 | With item | Cascade with item; account deletion. Matched against process names ON the desktop device only — running-app names are never uploaded or stored server-side. |
| Sub-tasks | `subtasks` | S2 | With parent item | Cascade with item; account deletion |
| Schedule blocks | `schedule_blocks` | S2 | With item | Cascade; account deletion; external calendar event removed on undo (Phase 2) |
| Reminder triggers + delivery log | `reminder_triggers` | S2 | With item | Cascade; account deletion |
| Device registrations, push tokens | `devices` | S2 | Until device removed / 90 days unseen | Device delete; account deletion |
| Calendar link OAuth tokens | `calendar_links` | **S3** | Life of link | Link revoke (also revokes at provider); consent (c) revocation; account deletion. Never returned to clients. |
| Voice audio (cloud quality pass) | object storage | **S3** | Transient (deleted after pass) unless consent (b) | Immediate post-processing delete; consent (b) revocation; account deletion |
| Chat-import raw files | object storage (isolated bucket) | **S3** | ≤ 7 days (retention deadline on `import_jobs`) | Auto-delete at deadline; total-deletion action; consent (d) revocation; account deletion |
| Personality profile | `profiles` | **S3** | Life of consent (d) | Profile delete button; consent (d) revocation; account deletion |
| Import job metadata + deletion audit | `import_jobs` | S2 | Life of account | Account deletion (deletion audit rows persist until account deletion as proof-of-erasure) |
| Audit/undo log | `audit_log` | S2 | 90 days rolling | Rolling expiry; account deletion |
| Change feed | `changes` | S2 | 30 days rolling (clients past the horizon full-resync) | Rolling expiry; account deletion |
| Analytics events | forwarding layer → provider | S1 (pseudonymous) | Provider retention window | Consent (e) revocation stops emission; pseudonymous id unlinked from account id; account deletion erases the id mapping |
| Server logs | observability stack | S1 | 30 days | Rolling expiry. Logging policy: no transcript text, item titles, import content, or calendar details in logs — enforced in the AI orchestration layer's logging policy and reviewed per module. |

## Consent categories (build plan §4)

| Key | Category | Governs |
|---|---|---|
| `voice_processing` | (a) microphone / voice processing | Recording + transcription |
| `voice_retention` | (b) audio retention beyond transient processing | Keeping raw recordings |
| `calendar_access` | (c) calendar access | Calendar links & sync |
| `chat_import` | (d) chat-history import & profile derivation | Imports + personality profile |
| `analytics` | (e) product analytics | Event emission |
| `app_watcher` | (f) desktop app-launch watching | Desktop watcher runs; nothing stored server-side (revocation stops the watcher on-device) |

Revoking a consent triggers the corresponding data-handling change automatically
(`backend/src/modules/consent.ts` revocation hooks).

## Backup expiry window

Backups expire within **30 days**; the total-deletion guarantee is therefore
"immediately from live stores, ≤ 30 days from backups", and that window is what user
-facing copy must state.
