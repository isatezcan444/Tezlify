# WhatsApp Core Refactor Design

**Date:** 2026-09-14  
**Status:** Proposed for implementation  
**Target branch:** `main`  
**Deployment:** Vercel Hobby + Supabase Free + Render Free

## 1. Purpose

Rebuild Tezlify's WhatsApp integration around durable session ownership, recoverable Baileys authentication, idempotent event delivery, explicit failure states, and tenant-safe multi-line operation.

The target is WhatsApp Web-like behavior within the hard limits of free hosting: a linked line must normally reconnect without a new QR after process restarts or Render wake-up, duplicate or stale socket activity must not corrupt state, and the UI must report the real state. Render Free cannot provide uninterrupted 24/7 message reception while the service is asleep; the system must expose that limitation honestly and reconcile after wake-up instead of simulating availability.

## 2. Non-Negotiable Invariants

1. Supabase is the persistent source of truth. Render's filesystem and process memory are caches only.
2. A user may own multiple WhatsApp lines. Every stateful record and operation is scoped by both tenant and session.
3. One logical session has at most one current socket owner. Old socket callbacks are ignored.
4. A known session keeps its stable `gateway_id`. Missing or corrupt auth becomes `RELINK_REQUIRED`; the backend never silently creates a replacement identity.
5. Signal credentials and keys are durably committed before a Baileys key-store write reports success.
6. Gateway events are persisted before delivery and processed idempotently before acknowledgement.
7. Failures are never returned or displayed as successful sends, successful links, or synthetic mock data.
8. `/ws`, `/ws/gateway`, scraper broadcasts, and campaign broadcasts remain compatible shared infrastructure.
9. Logs contain no QR data, pairing codes, phone numbers, JIDs, message bodies, auth blobs, or encryption material.
10. Anti-ban timing and working-hours decisions continue to come only from `AntibanPolicy`.

## 3. Hosting Responsibilities

### Vercel Hobby

- Hosts the React/Vite frontend only.
- Connects to the Render FastAPI HTTP and WebSocket endpoints.
- Holds no WhatsApp credentials and performs no background processing.

### Render Free

- Runs FastAPI and the Baileys gateway in one web service/container.
- Uses a supervised child process lifecycle so the service cannot appear healthy while the gateway child is dead.
- Handles SIGTERM by stopping admission, cancelling reconnect timers, flushing pending auth writes, releasing leases, and closing sockets within Render's shutdown window.
- Accepts that idle sleep, restart, redeploy, or local-file loss can happen at any time.

### Supabase Free

- Stores tenant/session metadata, encrypted Baileys auth state, leases, compact retry data, and the durable event outbox.
- Stores bounded media objects only when required by an active feature and quota policy.
- Uses small transaction-mode connection pools with prepared statements disabled where the pooler requires it.
- Uses a private database schema and a dedicated least-privilege gateway role; WhatsApp secrets are not exposed through the Data API.

## 4. Clean Architecture Boundary

The gateway is split into four layers:

```text
transport/http + transport/ws
             |
application/session-registry + socket-supervisor + reconciliation
             |
domain/session-state + ports
             |
infrastructure/postgres + encryption + baileys
```

### Domain

- `SessionState`: legal states and transitions.
- Value objects: `SessionId`, `TenantId`, `SocketGeneration`, `EventId`.
- Ports: `AuthStore`, `EventOutbox`, `RetryMessageStore`, `SessionLease`, `SocketFactory`, `Clock`.
- Domain code has no FastAPI, Express, PostgreSQL, filesystem, or Baileys imports.

### Application

- `SessionRegistry`: restores eligible sessions and enforces admission limits.
- `SocketSupervisor`: owns one session actor, current socket generation, reconnect policy, and cancellation.
- `EventRelay`: writes events to the outbox, delivers them, and handles ACK/replay.
- `ReconciliationService`: performs bounded post-wake synchronization using supported Baileys mechanisms.

### Infrastructure

- PostgreSQL implementations of auth, outbox, retry cache, and lease ports.
- AES-256-GCM envelope encryption with explicit key version and authenticated context.
- Baileys v7 adapter isolated behind `SocketFactory`.

### Transport

- Existing HTTP routes remain a compatibility facade during migration.
- `/ws/gateway` remains the inbound event bridge and gains authenticated event ACK semantics.
- Transport validates input and delegates; it does not own session lifecycle rules.

The existing large `session-manager.js` becomes a thin compatibility facade and is removed only after all callers use the new application interfaces.

## 5. Persistent Data Model

All gateway-private tables live outside the exposed API schema. UUIDs are used for externally meaningful session identity; monotonically increasing database identities may be used for outbox ordering.

### Session metadata

The existing tenant-visible `whatsapp_sessions` record remains authoritative for ownership and UI state. It includes a stable `gateway_id`, tenant/user owner, display metadata, state, state reason, last transition time, last successful connection time, and auth key version.

### Encrypted auth credentials

One current credential document per session:

- Primary key: `session_id`
- Ciphertext, nonce, authentication tag, key version
- Optimistic version and timestamps

### Encrypted Signal keys

One row per session/key type/key identifier:

- Unique key: `(session_id, key_type, key_hash)`
- `key_hash` is a keyed HMAC blind index, not the raw Signal key identifier.
- Encrypted BufferJSON payload with key version and timestamps.
- Batched upsert/delete operations preserve Baileys `keys.set` semantics atomically.

### Socket lease

- One row per session with `instance_id`, `generation`, and expiry.
- Acquisition and renewal use compare-and-swap semantics.
- A socket is created only after a lease is held; loss of lease terminates that generation.
- This prevents two owners during overlapping deploys or delayed shutdown.

### Event outbox

- Stable `event_id` UUID and per-session sequence.
- Tenant/session, event type, encrypted payload, state, attempt count, next attempt, created/delivered timestamps.
- Unique constraints make enqueue and backend processing idempotent.
- Workers claim bounded batches using `FOR UPDATE SKIP LOCKED` in short transactions.
- Delivered rows are compacted on a bounded retention schedule; dead letters are capped and visible as failures.

### Retry message cache

- Encrypted compact message/proto required by Baileys `getMessage`.
- Scoped per session, TTL-bound, and capped by item count and byte budget.
- Lives outside individual socket objects so reconnecting a socket does not lose retry context.

Every foreign key used by cleanup or lookup has a matching index. Constraints enforce legal states, non-negative attempts, and tenant/session ownership.

## 6. Encryption and Access Control

- AES-256-GCM encrypts credentials, Signal keys, outbox payloads, and retry payloads at application level.
- Associated authenticated data binds ciphertext to table purpose, tenant, session, record identity, and key version so rows cannot be swapped safely.
- Raw JIDs and Signal key identifiers are not stored as plaintext lookup keys; keyed HMAC blind indexes are used where lookup is necessary.
- Encryption keys come only from runtime secrets. No key, token, credential, QR, or plaintext payload is logged.
- Key rotation reads the stored key version and rewrites records gradually after successful decrypt.
- The gateway database role can access only its private schema operations. Frontend roles receive no grants on gateway-private tables.

## 7. Session State Machine

Canonical states:

- `SCAN_QR`: no valid linked credentials; user action required.
- `RESTORING`: durable auth exists and the supervisor is rebuilding a socket.
- `CONNECTING`: a current socket generation is connecting.
- `CONNECTED`: current generation is open and lease is healthy.
- `DISCONNECTED`: recoverable network/platform interruption; retry scheduled or service asleep.
- `RELINK_REQUIRED`: WhatsApp logged out the device or durable auth is absent/corrupt.
- `UNAVAILABLE`: infrastructure dependency prevents a truthful decision or operation.
- `ERROR`: non-recoverable application failure requiring operator inspection.
- `BANNED`: WhatsApp explicitly reports a banned/restricted account.

Backend enum, API schema, frontend TypeScript union, badges, messages, and English/Turkish dictionaries change together. Transitions include a machine-readable reason code and timestamp. Unknown or contradictory evidence fails closed to `UNAVAILABLE` or `ERROR`, never `CONNECTED`.

## 8. Socket Ownership and Reconnect Rules

Each session has one `SocketSupervisor` actor:

1. Acquire the database lease.
2. Load and validate durable credentials and Signal keys.
3. Increment the socket generation and create one socket.
4. Bind callbacks to that exact generation and socket reference.
5. Ignore callbacks unless both generation and reference still match the current owner.
6. Persist `creds.update` and Signal `keys.set` before acknowledging the write to Baileys.
7. On recoverable close, schedule exactly one cancellable exponential-backoff timer with bounded jitter.
8. Reset backoff only after a stable open.
9. QR refresh, logout, delete, lease loss, and shutdown cancel the timer and invalidate the generation before closing the socket.

Reconnect policy classifies Baileys disconnect reasons explicitly. Logged-out/bad-session conditions move to `RELINK_REQUIRED`; transient transport failures reconnect; dependency outages move to `UNAVAILABLE` without destroying auth.

Startup restores eligible sessions from Supabase with bounded concurrency. Registered lines are not arbitrarily deleted, but active socket admission is capped using measured memory and connection data. Requests above the safe cap fail clearly and can remain disconnected until capacity is available.

## 9. Baileys Migration

- Replace the production use of `useMultiFileAuthState` with the PostgreSQL `AuthStore` adapter.
- Wrap Signal keys with Baileys' supported cache helper while preserving durable writes.
- Keep `msgRetryCounterCache` per session and outside socket generations.
- Implement `getMessage` through the bounded retry store.
- Remove blanket forced app-state resync and manual event-buffer flushing. Reconciliation is explicit, bounded, and uses supported events/APIs.
- Remove the runtime `postinstall` mutation of `node_modules`.
- Pin one audited Baileys v7 release through the adapter. Because the current latest line is a release candidate, compatibility is proven by contract and integration tests before rollout. If an upstream defect blocks operation, use a pinned, reviewed Tezlify fork or adapter patch committed to source control; never patch installed files at runtime.

## 10. Durable Gateway Event Flow

1. A current socket emits a supported event.
2. The gateway normalizes it and commits an encrypted outbox row before transport.
3. `EventRelay` sends ordered pending events over `/ws/gateway` with `event_id`, session sequence, tenant/session identity, type, and payload.
4. FastAPI authenticates the gateway, verifies ownership, and processes the event idempotently in a database transaction.
5. FastAPI broadcasts the resulting frontend event through the shared `ws_manager` only after persistence succeeds.
6. FastAPI ACKs the `event_id`; the gateway marks it delivered.
7. Disconnect or restart causes unacknowledged rows to replay in order. Duplicate delivery produces the same stored result and ACK.

Unknown sessions, wrong tenant ownership, malformed events, and exhausted retries go to an explicit bounded dead-letter state and are never silently dropped.

## 11. User Operations

### Link a new line

- Backend creates one tenant-owned session identity.
- Gateway supervisor enters `SCAN_QR` and emits a short-lived QR event.
- Successful credential persistence precedes `CONNECTED`.
- QR values are transient and never persisted or logged.

### Restore after Render wake/restart

- Registry discovers active sessions from Supabase.
- Each supervisor restores the same `gateway_id` and durable auth.
- No QR is generated when auth is valid.
- Pending outbox and retry state are replayed; recent supported history is reconciled within configured bounds.

### Send

- Backend verifies tenant ownership, session state, anti-ban policy, and idempotency key.
- A send is reported successful only when the gateway returns a real WhatsApp message identifier/accepted result.
- Network, capacity, policy, sleep, or dependency failures remain failed/pending according to their actual durable state.

### Logout/delete

- Invalidate the socket generation and cancel reconnects first.
- Perform the requested WhatsApp logout when applicable.
- Revoke/delete encrypted auth and bounded caches transactionally, release the lease, and expose the final state truthfully.

## 12. Free-Tier Capacity and Retention

- Database pools start conservatively and are configurable. Gateway and backend totals must stay below measured Supabase pooler limits.
- Auth and pending delivery data take priority over historical diagnostics.
- Delivered outbox rows, retry messages, dead letters, and diagnostic history have explicit count, age, and byte caps.
- Media uses Supabase Storage only with per-tenant and global quotas, maximum object size, and expiry. Expired media remains represented as unavailable metadata rather than a broken success.
- A periodic compact/cleanup job is safe to rerun and performs bounded batches.
- No artificial keep-alive traffic is introduced to evade Render Free sleeping. While Render sleeps, real-time reception is unavailable; recovery begins on the next legitimate wake.
- Supabase Free may pause after prolonged inactivity and has no automatic backup/PITR guarantee. Dependency detection must distinguish platform unavailability from lost WhatsApp auth, and deployment documentation must state the backup limitation.

## 13. Supervision and Health

- The container entrypoint launches a small supervisor responsible for FastAPI and gateway lifecycles.
- Readiness is false when FastAPI cannot reach the gateway or required database operations fail.
- Liveness detects wedged processes without claiming WhatsApp sessions are connected.
- Unexpected gateway exit makes the service unhealthy and triggers bounded restart behavior; it cannot leave an apparently healthy backend proxying to a dead child.
- SIGTERM propagates to both processes and awaits bounded graceful shutdown.

## 14. Systematic Debugging and Observability

Production diagnostics are transition-oriented, structured, and low-volume:

- Hashed session reference, component, event, generation, reason code, duration, and counters.
- State transitions, lease changes, reconnect scheduling/cancellation, auth write failures, outbox replay/ACK summaries, buffer/dead-letter pressure, slow/error proxy calls, and shutdown summaries.
- No per-message success spam and no sensitive payloads.
- `WHATSAPP_DIAGNOSTICS=false` disables optional diagnostics; errors and audit-critical state changes remain observable.

Every defect follows this required loop:

1. Reproduce and collect boundary evidence without sensitive data.
2. State one falsifiable root-cause hypothesis.
3. Add the smallest deterministic failing test.
4. Apply one root-cause fix, avoiding bundled speculative changes.
5. Re-run the focused test, neighboring contract tests, and full relevant suites.
6. Keep a diagnostic only if it is actionable and bounded; remove investigation noise.

## 15. Migration and Rollout

1. Commit the diagnostic baseline and deterministic reproductions for current auth-order, restart-bootstrap, stale-socket, and event-loss defects.
2. Add private Supabase schema, constraints, indexes, least-privilege role, and reversible migrations.
3. Implement encryption and PostgreSQL port adapters with round-trip and corruption tests.
4. Implement `SocketSupervisor`, generation guard, lease, reconnect policy, and shutdown behavior behind the compatibility facade.
5. Add outbox/ACK/replay and backend idempotent event processing.
6. Migrate to the pinned Baileys v7 adapter and remove filesystem auth/runtime patching.
7. Synchronize backend/frontend states and multi-line UI behavior.
8. Add supervised container lifecycle and truthful health checks.
9. Run migration in compatibility mode, verify persisted sessions restore with the same identity, then remove obsolete file snapshots and volatile bridge buffering.

Database migrations are additive first. Destructive cleanup occurs only after successful restore/replay verification and a rollback window. Existing user data and unrelated dirty worktree changes are preserved.

## 16. Verification Matrix

The implementation is complete only when automated tests prove:

- Credentials and every supported Signal key type survive process restart with BufferJSON fidelity.
- A valid linked session restores the same `gateway_id` without a QR.
- Missing/corrupt auth yields `RELINK_REQUIRED`, not a replacement session.
- Delayed callbacks from an old socket cannot change state or schedule reconnect.
- At most one socket generation owns a session, including lease overlap tests.
- Reconnect backoff is single, cancellable, bounded, and reset after stable open.
- Outbox replay preserves order; duplicate events are idempotent; ACKs survive restart; overflow never silently drops data.
- Multiple users and multiple lines per user are isolated across auth, leases, events, sends, and UI updates.
- Supabase/gateway/Render interruption produces truthful `UNAVAILABLE`/`DISCONNECTED` states and recovers without false relink.
- SIGTERM flushes writes and closes sockets within the deployment shutdown budget.
- Media and retry retention obey count/age/byte limits.
- Admission control is derived from repeatable memory/load measurements and fails closed above the safe limit.
- Existing scraper, campaign, `/ws`, `/ws/gateway`, anti-ban, and non-WhatsApp test contracts remain green.
- Backend pytest suite, gateway unit/integration suite, frontend TypeScript build, and focused end-to-end multi-line flows pass.
- Logs remain PII/secret-free under success, retry, corruption, logout, and outage scenarios.

## 17. Definition of Done

- No production WhatsApp auth or delivery correctness depends on Render filesystem/process memory.
- No runtime mutation of third-party packages remains.
- No silent self-heal identity replacement, mock fallback, false-positive success, or unbounded in-memory event loss remains.
- The implementation follows the layer boundaries and thin transport/fat application-service model above.
- Schema and role migrations are reviewed for Supabase Free limits and rollback safety.
- Operational documentation states the Render sleep and Supabase backup/pause limitations plainly.
- All verification matrix checks pass with concise diagnostic evidence.

## 18. Explicit Limits and Non-Goals

- Render Free cannot equal an always-awake phone or WhatsApp Web session. This design targets durable identity, safe wake-up, bounded reconciliation, and truthful status—not impossible uninterrupted delivery during sleep.
- It does not bypass WhatsApp rate limits, anti-abuse controls, device limits, or platform policy.
- It does not add a paid queue, Redis, persistent Render disk, or another paid dependency.
- It does not alter the Google Maps scraper architecture or unrelated product domains.
