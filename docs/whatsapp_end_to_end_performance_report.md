# WHATSAPP END-TO-END PERFORMANCE FORENSIC REPORT

Date: 2026-09-14. **Partial application-side profiling iteration, not completed live E2E acceptance.**

## Latest verified follow-up (supersedes historical completion statements below)

- Optional group enrichment now runs as a coalesced background task, outside the sync database session. Provider errors are logged; no metadata success is fabricated. Regression proves snapshot publication, message-phase execution and COMPLETED sync while metadata remains blocked. This is not a provider timeout/lifecycle acceptance test.
- Frontend targeted hydration no longer starts inside conversation state updaters. Snapshot application preserves newer realtime previews. Message merging collapses previously separate optimistic/provider rows when an event links their identities, retaining the strongest delivery evidence. Regression covers split identities and sync/realtime message overlap, not actual browser reconnect subscriptions.
- Full backend: **629 passed, 44,350 warnings, 40.85s**. Gateway: **14 scripts, zero failures**. Frontend merge regressions pass; TypeScript and production build pass (**1.94s**, existing large-chunk warning). `git diff --check` passes.
- Repeated unchanged synthetic benchmark: **500 chats / 5,500 messages: 425.840ms import, 75.187ms first chunk, 39 SQL executions, 6 commits**. One chat / 5,500 messages: **382.200ms, 35 SQL executions, 6 commits, 5.128ms latest-page read**. These are single local SQLite samples, not live/provider or p95 measurements.
- Limit audit: `_SYNC_PER_CHAT_LIMIT = 50` is a backend application import window; normalized history is pruned to 500 in the gateway history handler and LID merge. Raw retry payloads have a separate 500-entry cache. None is a demonstrated provider limit. No retention limit was removed in this follow-up.
- Installed Baileys 7.0.0-rc14 implements `fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` using `HISTORY_SYNC_ON_DEMAND`; it requests asynchronous history and returns a peer-operation send result, not a message page. Application orchestration remains absent. Timestamp-only gateway hydration cursors still require a provider-ID tie-breaker, even though DB keyset pagination already handles equal timestamps.
- Unknown ACK persistence returns no broadcast result on lookup failure; the backend bridge sends a non-permanent `gateway_event_nack` for event-ID-bearing messages. This confirms the retry contract in code, not a new full transport retry experiment.
- **Remaining:** provider older-history orchestration and durable ingestion before eviction; mutable offset/global-watermark completeness; gateway retention; backend concurrent-send/legacy split-identity reconciliation; bootstrap/list refetch elimination; metadata task shutdown/session-generation coverage; actual reconnect/subscription/live-device acceptance. No claim of full completion.

Evidence: `/tmp/wa-history-suite.{log,exit}`, `/tmp/wa-history-gateway.{log,exit}`, `/tmp/wa-history-build.{log,exit}`, `/tmp/wa-history-benchmark.{log,exit}`. Existing baseline `/tmp/wa-preserved-baseline.diff` was verified present; the resumed tracked diff was additionally saved as `/tmp/wa-history-start.diff` (untracked files remain in the workspace).

## Resumption: verified application-side corrections

- Corrected Baileys rc14 status mapping: 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED. Send-promise completion leaves sends pending.
- Text/media sends commit pending backend rows and register gateway records before provider I/O. Existing client/provider IDs reconcile echoes and early ACKs; lower statuses do not overwrite delivery evidence. Unknown ACK records require durable-bridge retry.
- Database history uses timestamp plus message-ID tie-breaking. Tests traverse all 1,200 equal-timestamp messages without duplicates/skips.
- Removed the backend 200-chat snapshot cap. Persisted snapshots publish before group lookup; a blocked-metadata test verifies ordering.
- Unknown message/conversation events hydrate one conversation. Gateway completion no longer replaces loaded history. Sync chunks and reconnect history merge with pending/realtime messages.
- Validation: 629 backend tests passed (42.05s); all 14 gateway test scripts passed; frontend identity/status/reconnect-retention tests passed. Synthetic/provider-stub tests, not paired-device acceptance.
- Repeated synthetic 500-chat/5,500-message import: 400.821 ms, first chunk 81.746 ms, 39 SQL executions, 6 commits. One 5,500-message conversation: 320.439 ms import, 5.203 ms first-page query. A 1,200-message plus pending frontend merge measured 2.296 ms. Single samples, not p95/browser-render timings.
- Still incomplete: 50-message initial import window, 500-message gateway retention, watermark/history completeness, provider history orchestration, fully asynchronous group enrichment, remaining bootstrap/list refetches, concurrent-request/legacy split-identity reconciliation, and live reconnect/sync/outbound acceptance. Installed Baileys supports asynchronous `fetchMessageHistory`; it is not a synchronous pagination response. No claim of provider-complete history is made.

## A. Baseline

Inspected existing reconciliation, follow-up cancellation and outbox scheduling/sequence patches; retained them. Baseline prepared SQLite database: 622 tests passed in 32.69s. An earlier run against an empty database failed with `no such table: messages`; it is not evidence of a regression or a pass.

Benchmark uses real SQLAlchemy/aiosqlite transactions on a temporary SQLite file and synthetic gateway messages. No provider, network, production PostgreSQL, actual WebSocket or browser participates. Two fixtures: one conversation with 5,500 messages; 500 conversations with 5,500 messages. Timing is one before/after sample per fixture, not p95 or statistically controlled production evidence. Provider fixture intentionally returns all rows regardless of watermark/per-chat flags to isolate persistence cost, not validate full-history retrieval.

## B. Root Causes

**Measured:** `_run_bulk_message_sync` loaded each conversation using `db.get`: 500 SELECTs in the 500-chat fixture. `db.add_all` produced 5,500 individual INSERT executions despite page-level commits.

**Changed:** tenant-filtered conversation preload in groups of 200; SQLAlchemy bulk `INSERT ... RETURNING Message` in groups of 200. Existing dedup prefetch, transaction-per-page, persisted-before-event ordering, cancellation checks and numeric event IDs remain. No indexes, schema, libraries, polling intervals or UI layout changed.

**Code-proven, unmeasured live:** group-subject fetch blocks first chat snapshot; version fetch blocks socket construction; late/missing conversations and sync completion can trigger frontend list refresh. These were not changed speculatively.

## C. QR Performance

Gateway opt-in monotonic metrics: `auth_state_load_ms`, `provider_version_lookup_ms`, `socket_initialization_ms`, `socket_start_to_provider_qr_ms`, `qr_generation_ms`, `socket_start_to_ready_ms`.

QR encoding measures `QRCode.toDataURL`, separately from provider QR availability. Initialization uses Baileys, not a launched Chromium browser. Existing socket lifecycle generation fencing/dedup remains. No live QR measured; dominant QR bottleneck remains **unproven**. QR fallback still requests every 2,500ms including QR_READY; unchanged for reliability. No claim of reduced QR latency.

## D. Pairing Performance

Scan, provider scan detection and authentication boundaries were not observed. `connection=open` is measured as socket-ready, not scan detection/auth completion. Do not subtract QR-ready from READY and label it authentication; that includes human wait. Scan→READY: **N/A**. Do not infer that the provider is slow.

## E. Initial Sync Performance

Existing `session_connected` schedules automatic sync. Existing chat snapshot precedes contacts and bulk message import, so full history is not intentionally required before showing chats. Group metadata still blocks this first snapshot. Existing monotonic stage timings remain; new backend operation profile measures whole job SQL costs. Benchmark first-chunk timing is persisted-message-chunk availability, **not** first conversation/browser usability.

## F. Full History Performance

Still incomplete. Gateway bulk endpoint uses offset/limit and materializes/sorts available in-memory messages. Backend initial sync uses 200-chat fetch, 50-message/chat cap and tenant-wide timestamp watermark. Some gateway paths retain only 500 messages per chat. `syncFullHistory` is false. Existing older-message access is bounded/cursor-based but does not prove older data survives gateway eviction or provider absence.

Persistence already commits per 1,000-message page and emits <=100-message chunks. This iteration makes SQL insertion truly batched. Removing caps without durable, backpressured history storage would risk memory growth and does not constitute a safe fix. No full-history acceptance claim.

## G. Incoming Message Latency

Backend `gateway_event` profile covers ingestion and SQL, not transport queue delay. Development browser metric `event_handler_to_message_commit_ms` covers matching rendered bubble from the existing hub listener to `useLayoutEffect`. It does not measure provider→backend, WebSocket receipt→listener, serialization, paint or hidden-conversation rendering. Existing known-conversation delta path retained; unknown conversation fallback still refetches. Live values: **N/A**.

## H. Outgoing Message Latency

Backend `send_text` profiling added. Gateway `provider_send_promise_ms` measures Baileys send promise resolution; **not SERVER_ACK**. Existing UI optimistic PENDING remains. No click→ACK/paint correlation has been completed. Real provider ACK timing: **N/A**.

## I. Outbound Echo Race

**Unresolved.** Local send persists after provider response, while outbound echo can persist concurrently. Existing provider/client IDs assist UI dedup but do not by themselves guarantee one DB row. ACK-before-row can also be missed. This requires shared race-safe persistence/correlation and PostgreSQL concurrency tests, not an unverified process-local lock. No fake claim of resolution.

## J. WebSocket/Reconnection

Existing gateway socket generation fencing, listener cleanup and outbox fixes retained. Backend manager uses socket sets and tenant-specific dispatch. Browser effects remove their listeners on cleanup. These code patterns are not a measured browser reconnect proof. Serial broadcast/bridge work can delay subsequent events; dispatch/backlog/reconnect timings were not instrumented completely here. No polling intervals changed.

## K. Database

`WHATSAPP_LATENCY_PROFILING=true` enables structured backend profiles for initial sync, chat open, text send and gateway ingestion. Counters: query count, cursor execution total/average time, transactions, successful commits, rollbacks and SQL fingerprints/verbs. No SQL parameters, message body, phone, session token or raw SQL exported. ContextVar scopes profiles; SQLAlchemy listeners installed once. Cursor execution time excludes pool wait and commit I/O; whole operation includes awaits. Failed SQL executions are not included in successful-query totals. No unauthenticated metrics endpoint introduced.

500-chat fixture: DB execution 1,229.837→87.031ms; average per execution 0.205→2.232ms (larger batches; not a regression in total DB work). Transactions/commits: 6/6 before and after. INSERT executions 5,500→28. Conversation SELECTs 500→3. Existing replay dedup is tested; concurrent import/send races are not resolved by batching.

## L. Frontend Rendering

Development-only, opt-in `VITE_WHATSAPP_LATENCY_PROFILING=true`. Existing ChatThread/ChatBubble record DOM-commit endpoints; bounded 512-sample in-memory buffer. No telemetry upload, public new screen, styling or dependencies. Development tools can import `/src/lib/whatsappLatency.ts` and call `readWaLatency()`; exported samples omit correlation keys. `chat_request_to_commit_ms` begins at selection effect/request, not user click, and ends when message data commits. Cached data may render first. Commit is **not paint**. No browser was connected, so no render bottleneck was claimed or speculative memoization added.

## M. Before/After Metrics

All numeric rows below are synthetic-provider/real-SQLite **single-run** measurements, not live latency.

| Metric | Before | After | Reduction |
|---|---:|---:|---:|
| 500 chats / 5,500 messages: bulk persistence | 1,644.306ms | 425.847ms | 74.10% |
| Same fixture: first persisted message chunk | 430.546ms | 84.385ms | 80.40% |
| Same fixture: SQL count | 6,008 | 39 | 99.35% |
| Same fixture: cursor execution total | 1,229.837ms | 87.031ms | 92.92% |
| 1 chat / 5,500 messages: bulk persistence | 1,613.701ms | 388.778ms | 75.91% |
| Same fixture: first persisted message chunk | 285.820ms | 69.266ms | 75.77% |
| Same fixture: SQL count | 5,507 | 35 | 99.36% |
| Same fixture: DB-backed latest-50 service call | 5.693ms | 5.509ms | single-sample noise; no optimization claim |
| QR ready | N/A | N/A | N/A |
| Scan→READY | N/A | N/A | N/A |
| READY→sync / sync→first chat | N/A | N/A | N/A |
| Live chat click→render | N/A | N/A | N/A |
| Send click→provider ACK / UI render | N/A | N/A | N/A |
| Incoming provider→UI | N/A | N/A | N/A |

## N. Tests

Final full run including replay/query-budget assertions: **625 passed, 40,899 warnings, 33.10s**. Existing 622 plus 3 new parameterized/profiling cases. **13 gateway scripts, zero failures**. Frontend compilation/build successful, Vite build **1.95s**, existing >500kB bundle warning. Exit statuses recorded separately, unlike earlier terminal-close ambiguity.

New fixtures validate 5,500 persisted rows, <=50 initial chat page, <=100 event chunks, 6 commits, <60 SQL executions and repeat-import dedup. Fixtures do not test provider delivery, concurrent incoming/outgoing, real reconnect or full provider history. Existing deletion, duplicate connection/history and outbox contract tests remain in the suite. Requested stress scenarios A/B/E/F/G/H/I have no new live measurements; C/D only synthetic DB stress; J/K/L have existing contract coverage, not production degradation measurements.

Evidence paths:
- `/tmp/tezlify-wa-benchmark-before.log`
- `/tmp/tezlify-wa-benchmark-after.log`
- `/tmp/tezlify-wa-performance-final.log`
- `/tmp/tezlify-wa-performance-final.exit`
- `/tmp/tezlify-wa-performance-gateway.log`
- `/tmp/tezlify-wa-performance-gateway.exit`
- `/tmp/tezlify-wa-performance-build.log`
- `/tmp/tezlify-wa-performance-build.exit`

## O. Remaining Provider/Browser Limitations

**Controlled by application:** batching, group lookup ordering, persistence races, history retention, frontend delta updates, subscriptions and instrumentation. **External lifecycle:** human scan, provider auth/history availability/ACK and browser scheduling. None of the latter were measured; no attribution of slowness is justified. Cross-host monotonic clocks cannot be subtracted; complete distributed profiling still needs safe trace propagation, synchronized-clock uncertainty and actual provider/browser observations.

## P. Final Assessment

**What was fixed:** measured per-conversation SELECT and per-message INSERT amplification in bulk import. Existing reliability fixes preserved.

**What was measured:** actual local SQL executions/transactions and elapsed import, first chunk and bounded chat-read timings on 5,500 synthetic messages. Application instrumentation added for a subset of gateway/backend/browser boundaries.

**Not complete:** live E2E profiling, full history durability, outbound echo/early ACK reconciliation, group pre-snapshot blocking, full-refetch elimination, scan/auth boundaries, click→ACK correlation and browser paint/reconnect stress. The 15 acceptance criteria have **not** all been satisfied. A safe next iteration must address one of these with targeted tests and authorized live session/browser access; it must not extrapolate this SQLite improvement to QR or provider latency.