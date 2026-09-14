# LATENCY FORENSIC REPORT — 2026-09-14

## Scope and evidence limits

Current stack: Baileys 7.0.0-rc14, Node 24.15.0, FastAPI/async SQLAlchemy,
React 18/TypeScript/Vite. Local Python is 3.14. The configured local database
is SQLite; its messages/conversations tables are empty. No running local
backend/gateway was detected. PostgreSQL client/server tools are unavailable.
No real QR, phone pairing, provider ACK, browser render latency, or production
query timings have been measured. Historical performance reports are not a
current baseline. Tests use isolated SQLite and explicit provider doubles.

Before changes: 40 existing backend sync/ACK tests passed in 3.23 seconds;
gateway outbox (11 assertions), socket lifecycle (11 assertions), and bulk
messages (5 tests) passed. Suite duration is not end-to-end message latency.

## Findings before implementation

### 1. Automatic sync exists; history notifications can be lost

- **Problem:** Later provider history can remain unpersisted despite a successful job.
- **Root cause/evidence:** `ingest_gateway_event` already schedules sync after
  committing `session_connected`. However `_schedule_initial_sync` drops all
  notifications while an owner is in flight. `history_sync_completed` is emitted
  for every provider chunk, but the backend only schedules when `chats_synced > 0`,
  ignoring message-only chunks. There is no trailing reconciliation.
- **Measured latency:** Not available; this is an event-loss path, not an established
  slow operation. Persistence may wait until a later manual sync/open-chat request.
- **Impact:** Incomplete history; misleading diagnosis that initial sync never ran.
- **Fix:** Coalesce history notifications into one trailing pass; accept message-only
  chunks. Preserve the existing connected trigger and single owner job.
- **Risk:** Extra reconciliation work when history arrives during a pass. Do not
  turn repeated CONNECTED notifications into an unbounded follow-up loop.

### 2. Outbox retry backoff is bypassed

- **Problem:** NACKed events can be reclaimed immediately and reach dead letter.
- **Root cause/evidence:** `reject` sets PENDING and a future `next_attempt_at`,
  but `claimPending` applies the due-time predicate only to IN_FLIGHT rows.
  The bridge pumps immediately after each NACK.
- **Measured latency:** No PostgreSQL timing available. The query has no effective
  minimum retry interval for PENDING rows (configured minimum is five seconds).
- **Impact:** Retry storms during session-registration races or temporary failures.
- **Fix:** Apply due-time eligibility to both states; test virtual time boundaries.
- **Risk:** Existing 10-second retry pump may add up to one tick after eligibility;
  keep that interval unchanged rather than introduce arbitrary polling changes.

### 3. Claimed batch order is not guaranteed

- **Problem:** Lifecycle events may be relayed out of order within a claimed batch.
- **Root cause/evidence:** CTE SELECT orders sequence, but UPDATE RETURNING does not
  guarantee result ordering. The bridge sends rows in returned order.
- **Measured latency:** Not a measured bottleneck; correctness defect.
- **Fix:** Explicitly sort claimed rows by sequence before relay.
- **Risk:** Sorting is bounded to at most 100 rows. This is not a claim of global
  ordering across multiple gateway processes.

## Additional unresolved findings (not silently counted as fixed)

- Group-subject network work precedes the first chat snapshot.
- Bulk initial sync currently caps each chat at 50 messages, uses a tenant-wide
  inbound timestamp watermark, and requests 200 chats. A recent inbound message
  does not prove older history is complete. Full provider-history preservation
  needs separate coverage; no new truncation is proposed here.
- Gateway quiet/no-chunk timers infer completion; they are not provider proof.
- Some frontend completion events refetch messages; realtime existing-chat
  updates are already delta-based. Browser-level reconciliation remains unverified.
- Outbound HTTP insertion can race gateway echoes; ACK status reconciliation
  requires dedicated persistence/provider tests.
- Gateway WebSocket currently permits an empty configured secret, contrary to
  the workspace fail-closed requirement. Security hardening remains outstanding.

No schema/index changes are justified by this environment. An empty SQLite query
plan would not establish production PostgreSQL performance. Run EXPLAIN
(ANALYZE, BUFFERS) on representative read queries in an authorized environment;
never run an outbox UPDATE ANALYZE against production merely for profiling.

## Implemented and validated subset

- Added one coalesced trailing hydration request for data arriving during a pass,
  including message-only chunks. CONNECTED duplicates only join an active pass.
  Cancellation/session deletion clears queued reconciliation.
- Outbox eligibility now honors retry deadlines for PENDING and IN_FLIGHT rows.
  Returned batches are sorted using bigint-safe sequence comparison.
- New regression tests failed before the changes and passed afterward. The
  notification test checks 20 connection duplicates plus 20 history notifications
  produce two passes, not 41 concurrent jobs. Outbox virtual-clock coverage checks
  no retry at 4,999 ms, eligibility at 5,000 ms, and lease expiry at 30 seconds.
  These are deterministic contract tests, not PostgreSQL integration measurements.
- Final full backend suite: **622 passed in 31.28 seconds**, including the
  cancellation guard regression. Existing datetime deprecations remain.
- All 13 gateway test scripts passed. Frontend TypeScript/production build passed;
  Vite reports an existing bundle-size warning. No UI files or dependencies changed.

This subset does **not** establish full-history completeness or live end-to-end
latency improvement. The additional findings above remain open acceptance work.