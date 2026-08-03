# Operations Runbooks (build plan §11.5)

On-call procedures for the delivery-critical paths. The design principle everywhere:
**degrade, never break; nothing silent; no lost captures.**

## LLM provider down (Anthropic outage / rate-limit storm)

**Symptoms:** orchestrator metrics show `provider=anthropic ok=false` streaks;
capture still works but summaries read templated.

**What happens automatically:** every capability falls back to the deterministic
heuristic provider in the same request (orchestrator chain, 10s timeout per
provider). Items keep classifying, confirmations keep rendering, nothing queues up.

**Operator actions:**
1. Confirm via `orchestrator.recentMetrics()` (expose temporarily or check logs).
2. If the outage is long: set `ANTHROPIC_API_KEY=""` and restart to skip the failed
   call entirely (removes the per-request timeout latency).
3. After recovery, re-set the key. No backfill needed — enrichment is
   capture-time-only by design; users can re-type items if a heuristic guess was
   wrong (correction is one tap and a training signal).

**Never:** queue captures behind the provider, or retry storms against it.

## Calendar provider API down (Google/Microsoft)

**What happens automatically:** external writes (create/move/delete) are wrapped in
try/catch — the internal schedule block stays authoritative and the periodic
reconciliation sweep (`CALENDAR_SWEEP_MS`, default 5 min) retries convergence.
Inbound freshness degrades from webhook-speed to sweep-speed.

**Operator actions:**
1. Check provider status pages; nothing to do for short outages.
2. For long outages, raise `CALENDAR_SWEEP_MS` to reduce error noise.
3. On recovery, one sweep converges state. Verify: pick an affected user, hit
   `POST /v1/calendar/sync`, confirm no conflict-cascade storm (blocks only move if
   a foreign busy event actually overlaps).

## Push delivery failing (APNs/FCM)

Delivery rows are written to `push_outbox` before the provider send; a provider
failure leaves the row as the retry record. Reminder triggers are marked delivered
regardless (no duplicate storm on recovery). Clients also keep local notification
fallbacks for reminders already synced to the device.

## Database restore

1. SQLite (dev/small prod): stop the process; copy the `.db` + `-wal` files back;
   start. The change feed seq is monotonic per DB — clients whose cursor is ahead of
   the restored feed will see an empty diff; force full resync by having clients
   reset cursor to 0 (safe: change application is idempotent upserts).
2. Postgres (prod): restore snapshot; same client-cursor rule applies.
3. After any restore, run the deletion-verification sweep for recent DSR deletions
   (`npm run dsr -- delete <email>` is idempotent) so restored backups don't
   resurrect erased users — this is the documented 30-day backup-expiry promise.

## Key rotation

- `JWT_SECRET`: rotating invalidates all sessions (users re-log-in). Do during low
  traffic; no data impact.
- `TOKEN_ENC_KEY`: calendar tokens are encrypted with it. Rotation requires
  re-encrypting `calendar_links.token_ref` (decrypt with old, encrypt with new)
  before switching — write a one-off script; do NOT rotate blind (links would break
  and users would re-link).

## SLOs (initial targets, Phase 5 dashboards are the source)

| Path | Target |
|---|---|
| Capture API p95 | < 150 ms (enrichment is async, never on this path) |
| Reminder delivery | 99% within 60 s of `fire_at` (scheduler tick 30 s) |
| Calendar inbound freshness | webhook: seconds; worst case one sweep interval |
| Sync catch-up after 24h offline | < 2 s for 500 changes |
