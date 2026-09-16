# WhatsApp Core Refactor Design

**Date:** 2026-09-14
**Status:** Implemented & Production Certified
**Target Architecture:** Oracle Cloud Infrastructure (OCI) VM `130.162.247.20` + Caddy + Docker (PostgreSQL + FastAPI + Baileys Gateway) + systemd timers

## 1. Purpose

Rebuild Tezlify's WhatsApp integration around durable session ownership, recoverable Baileys authentication, idempotent event delivery, explicit failure states, and tenant-safe multi-line operation.

## 2. Non-Negotiable Invariants

1. PostgreSQL is the persistent source of truth. The gateway's local filesystem and process memory are caches only.
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

### Caddy Edge Proxy

- Terminates TLS (HTTP/2 + HTTP/3) on public edge `https://api.130.162.247.20.sslip.io/`.
- Serves static React/Vite frontend releases with immutable assets.
- Proxies `/api/*` and `/ws*` directly to backend services with strict security headers.

### FastAPI Backend Container (`tezlify-backend`)

- Runs FastAPI application services and domain managers.
- Handles `/ws/gateway` bridge and WebSocket event broadcasts via shared `ws_manager`.
- Manages PostgreSQL sessions, tenant isolation, and CRM / outreach orchestration.

### Baileys Gateway Container (`tezlify-gateway`)

- Runs dedicated Node.js WhatsApp Baileys service under non-root user `gateway`.
- Manages socket lifecycles, encrypted Signal key storage, and QR pairing.
- Commits events to persistent outbox and relays them over authenticated gateway WebSocket.

### PostgreSQL Container (`tezlify-db`)

- Stores tenant/session metadata, encrypted Baileys auth state (`whatsapp_private`), leases, compact retry data, and the durable event outbox.
- Dedicated connection pooling with prepared statements tuned for local Docker networking.

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

1. **Domain (`domain/`):** Pure state models, transition rules, error classes, and port interfaces. No Baileys imports, no SQL, no network code.
2. **Application (`application/`):** Use-case orchestration, single-owner socket supervision, connection lease management, outbox commit, and reconnect policy.
3. **Infrastructure (`infrastructure/`):** PostgreSQL repository implementations, AES-256 Signal key store adapter, encryption helpers, and the raw Baileys socket wrapper.
4. **Transport (`transport/`):** Express HTTP endpoints (`/health`, `/sessions`, `/metrics`), `/ws/gateway` client relay, and token authentication.

Backend communication mirrors this boundary: HTTP endpoints remain thin validation wrappers delegating to domain services.

## 5. Session State Machine

A session moves through explicit states:

```text
[STOPPED / NEW]
       |
       v
   [STARTING]
       |
       +---> [SCAN_QR] ---------> [CONNECTED]
       |          |                      |
       |          v                      v
       +---> [RELINK_REQUIRED] <---+-[DISCONNECTED]
       |                           |     |
       +---> [UNAVAILABLE] <-------+     v
                                      [RECONNECTING]
```

State transitions are validated by the domain model. A state change is committed to PostgreSQL before an outbound event is emitted.

- **`SCAN_QR`**: A valid session identity exists but lacks credentials. A QR code is active.
- **`CONNECTED`**: Credentials exist, socket is open, presence is established.
- **`RECONNECTING`**: Socket closed with recoverable error; exponential backoff is running.
- **`RELINK_REQUIRED`**: Logged out by user, device unlinked, or Signal keys permanently unrecoverable.
- **`UNAVAILABLE`**: Network, host, or database dependency is unreachable; auth is preserved.

## 6. Socket Ownership and Lease Invariant

At most one physical Baileys socket may interact with a WhatsApp line at any time:

1. Every active session acquires an exclusive socket lease in `whatsapp_private.socket_leases`.
2. Leases use a monotonic `generation` counter and heartbeat expiration.
3. When a supervisor starts, it attempts to acquire the lease. If held by an active generation, takeover follows a graceful release-or-kill sequence.
4. Callbacks from old socket instances verify generation before mutating state; mismatched callbacks are dropped.
5. In-flight sends verify lease ownership before dispatch.

## 7. Encryption and Credential Security

1. Session credentials and Signal keys are encrypted at rest using AES-256-GCM.
2. The encryption key is derived from `GATEWAY_ENCRYPTION_KEY` via HKDF.
3. Plaintext keys never exist on disk; they reside only in memory for active socket sessions.
4. Database dumps and logs contain only ciphertext and initialization vectors.

## 8. Supervisor Reconnect Flow

1. On startup or line start, the supervisor checks existing credentials in PostgreSQL.
2. If credentials exist and are valid, it initiates connection without generating a QR.
3. If credentials do not exist or are invalid, it enters `SCAN_QR` and emits a transient QR.
4. Disconnections are classified:
   - 401 / 403 / Logged out: Transition to `RELINK_REQUIRED`.
   - Network drop / 5xx: Schedule exponential backoff reconnect.
   - Host shutdown / SIGTERM: Graceful lease release; preserve auth state.

## 9. Baileys Migration

- Replace production use of `useMultiFileAuthState` with PostgreSQL `AuthStore` adapter.
- Wrap Signal keys with Baileys' supported cache helper while preserving durable writes.
- Keep `msgRetryCounterCache` per session and outside socket generations.
- Implement `getMessage` through bounded retry store.
- Pin audited Baileys release through adapter.

## 10. Durable Gateway Event Flow

1. A current socket emits a supported event.
2. The gateway normalizes it and commits an encrypted outbox row before transport.
3. `EventRelay` sends ordered pending events over `/ws/gateway` with `event_id`, session sequence, tenant/session identity, type, and payload.
4. FastAPI authenticates the gateway, verifies ownership, and processes the event idempotently in a database transaction.
5. FastAPI broadcasts the resulting frontend event through the shared `ws_manager` only after persistence succeeds.
6. FastAPI ACKs the `event_id`; the gateway marks it delivered.
7. Disconnect or restart causes unacknowledged rows to replay in order. Duplicate delivery produces the same stored result and ACK.

## 11. User Operations

### Link a new line

- Backend creates one tenant-owned session identity.
- Gateway supervisor enters `SCAN_QR` and emits a short-lived QR event.
- Successful credential persistence precedes `CONNECTED`.
- QR values are transient and never persisted or logged.

### Restore after process restart

- Registry discovers active sessions from PostgreSQL.
- Each supervisor restores the same `gateway_id` and durable auth.
- No QR is generated when auth is valid.
- Pending outbox and retry state are replayed; recent supported history is reconciled within configured bounds.

### Send

- Backend verifies tenant ownership, session state, anti-ban policy, and idempotency key.
- A send is reported successful only when the gateway returns a real WhatsApp message identifier/accepted result.
- Network, capacity, policy, or dependency failures remain failed/pending according to their actual durable state.

### Logout/delete

- Invalidate socket generation and cancel reconnects first.
- Perform requested WhatsApp logout when applicable.
- Revoke/delete encrypted auth and bounded caches transactionally, release lease, and expose final state truthfully.

## 12. Capacity and Retention

- Database connection pools start conservatively and are configurable. Gateway and backend totals stay below configured PostgreSQL connection limits.
- Auth and pending delivery data take priority over historical diagnostics.
- Delivered outbox rows, retry messages, dead letters, and diagnostic history have explicit count, age, and byte caps.
- Media uses local storage with per-tenant quotas, maximum object size, and expiry.
- A periodic compact/cleanup job runs in bounded batches.

## 13. Supervision and Health

- Docker container entrypoints supervise FastAPI and gateway lifecycles.
- Readiness is false when FastAPI cannot reach the gateway or required database operations fail.
- Liveness detects wedged processes without claiming WhatsApp sessions are connected.
- Unexpected gateway exit triggers container health failure and Docker restart policy.
- SIGTERM propagates cleanly and awaits bounded graceful shutdown.

## 14. Systematic Debugging and Observability

Production diagnostics are transition-oriented, structured, and low-volume:

- Hashed session reference, component, event, generation, reason code, duration, and counters.
- State transitions, lease changes, reconnect scheduling/cancellation, auth write failures, outbox replay/ACK summaries, buffer/dead-letter pressure, slow/error proxy calls, and shutdown summaries.
- No per-message success spam and no sensitive payloads.
- `WHATSAPP_DIAGNOSTICS=false` disables optional diagnostics; errors and audit-critical state changes remain observable.

## 15. Migration and Rollout

1. Commit diagnostic baseline and deterministic reproductions for auth-order, restart-bootstrap, stale-socket, and event-loss defects.
2. Add private database schema (`whatsapp_private`), constraints, indexes, and reversible migrations.
3. Implement encryption and PostgreSQL port adapters with round-trip and corruption tests.
4. Implement `SocketSupervisor`, generation guard, lease, reconnect policy, and shutdown behavior.
5. Add outbox/ACK/replay and backend idempotent event processing.
6. Migrate to pinned Baileys adapter and remove filesystem auth.
7. Synchronize backend/frontend states and multi-line UI behavior.
8. Run migration in compatibility mode, verify persisted sessions restore with same identity.

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
- Infrastructure interruption produces truthful `UNAVAILABLE`/`DISCONNECTED` states and recovers without false relink.
- SIGTERM flushes writes and closes sockets within the deployment shutdown budget.
- Media and retry retention obey count/age/byte limits.
- Admission control is derived from repeatable memory/load measurements and fails closed above the safe limit.
- Existing scraper, campaign, `/ws`, `/ws/gateway`, anti-ban, and non-WhatsApp test contracts remain green.
- Backend pytest suite, gateway unit/integration suite, frontend TypeScript build, and focused end-to-end multi-line flows pass.
- Logs remain PII/secret-free under success, retry, corruption, logout, and outage scenarios.

## 17. Definition of Done

- No production WhatsApp auth or delivery correctness depends on ephemeral process memory.
- No runtime mutation of third-party packages remains.
- No silent self-heal identity replacement, mock fallback, false-positive success, or unbounded in-memory event loss remains.
- The implementation follows the layer boundaries and thin transport/fat application-service model above.
- Schema and role migrations are reviewed for PostgreSQL constraints and rollback safety.
- All verification matrix checks pass with concise diagnostic evidence.

## 18. Explicit Limits and Non-Goals

- Dedicated hosting provides continuous service. This design targets durable identity, safe restart recovery, bounded reconciliation, and truthful status.
- It does not bypass WhatsApp rate limits, anti-abuse controls, device limits, or platform policy.
- It does not require external third-party queue brokers or paid third-party add-ons.
- It does not alter the Google Maps scraper architecture or unrelated product domains.
