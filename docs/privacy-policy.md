# Scrible Privacy Policy (draft for legal review)

_Last updated: 2026-07-08. Plain-language policy covering every data category in the
architecture (docs/data-classification.md is the internal source of truth)._

## The short version

- **Your voice is transcribed on your device.** Audio leaves your phone only if you
  turn on the optional cloud quality pass, and is deleted immediately after unless
  you separately opt in to keeping recordings.
- **Your words are yours.** Transcripts, task titles, chat imports, and calendar
  details never enter analytics — analytics events carry only types, counts,
  durations, and buckets, under a random ID that is not your account ID.
- **Chat imports are radioactive to us.** If you import assistant chat history, we
  parse it in memory, derive a small structured profile (tone, breakdown preference,
  scheduling rhythm, vocabulary words), and discard the raw export in the same
  request. You can read, edit, and delete the profile at any time.
- **Deletion is total.** One action deletes your account and everything attached to
  it from live systems immediately; backup copies expire within 30 days.

## What we collect, and why

| Data | Why | Retention |
|---|---|---|
| Email + password hash | Your account | Until you delete the account |
| Items (transcripts, titles, sub-tasks) | The product itself | Until you delete them / the account |
| Schedule blocks & reminders | Scheduling and notifications | With the item |
| Calendar events (from calendars you link) | Free/busy scheduling; conflict handling | Rolling 30-day window; removed when you unlink |
| Calendar OAuth tokens | Acting on your calendar with your permission | Encrypted at rest; deleted on unlink/revoke; never shown to any client |
| Device registrations & push tokens | Delivering reminders to your devices | Until you remove the device |
| Personality profile (structured, no chat text) | Personalizing breakdowns, tone, scheduling | Until you delete it (one button) or revoke the consent |
| Analytics events (types/counts/durations only) | Improving the product | Under a pseudonymous ID; revoking consent permanently unlinks history |

## Consent, category by category

Nothing sensitive is on by default. Each of these is a separate, revocable switch in
Settings, and revoking it automatically triggers the corresponding data deletion:

1. **Voice processing** — transcribe your speech on-device.
2. **Keep recordings** — retain raw audio (off by default; otherwise audio is transient).
3. **Calendar access** — read free/busy and write Scrible-created events. Revoking
   deletes the link, tokens, and cached events.
4. **Chat import & profile** — derive the personalization profile. Revoking deletes
   imports and the profile.
5. **Product analytics** — pseudonymous usage events. Revoking stops emission and
   erases the ID that linked past events to you.

## Your rights (GDPR / CCPA)

- **Access / portability:** in-app data export (Settings) or `GET /v1/me/export` —
  a complete JSON of your data. Calendar OAuth tokens are credentials, not content,
  and are excluded.
- **Erasure:** in-app account deletion (`DELETE /v1/me`) removes every record across
  every store, verified programmatically; backups expire within 30 days.
- **Rectification:** everything is editable in-app, including the derived profile
  (your manual edits always beat our inferences).

## What we never do

- Sell your data, or share it with advertisers.
- Use your chat imports, transcripts, or items to train models.
- Read your calendar events beyond free/busy + the events Scrible itself created.
- Let staff read chat imports (processed in memory, access-logged, never persisted).

## Contact

privacy@scrible.app — data-subject requests are handled with audited tooling and a
deletion-verification step (see docs/compliance/).
