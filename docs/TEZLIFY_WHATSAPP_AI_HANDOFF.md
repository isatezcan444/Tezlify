# Tezlify WhatsApp Subsystem — AI Handoff Document

**Purpose:** Give another AI agent full context about what was done, why, and what remains.
**Repository:** Tezlify (WhatsApp CRM: FastAPI backend + Vite/React frontend + Node Baileys gateway)
**As of:** 2026-11-02

---

## 1. System Architecture

Three-tier WhatsApp live integration:

1. **Gateway** (`whatsapp-gateway/`): Node.js + `@whiskeysockets/baileys`. QR pairing, session lifecycle, encrypted auth state, in-memory message store (2000/chat ceiling), event bridge to backend.
2. **Backend** (`backend/`): FastAPI proxy endpoints (`/api/v1/whatsapp/*`), `/ws/gateway` WebSocket for inbound gateway events, `WhatsAppSession` model, event orchestrator, persistence loop.
3. **Frontend** (`frontend/`): React + TypeScript. `WhatsAppApi` live client, `WhatsAppRepository` live+mock fallback, `WhatsAppHubPage` live mode, `useLiveMode` hook.

**Hard rule:** When gateway/backend unreachable, all WhatsApp operations **fail closed** — no mock data, no simulations, no false-positive success.

---

## 2. Critical Invariants (DO NOT VIOLATE)

These are proven, production-tested rules. Breaking them causes data loss or user-visible bugs.

### A. Irreversible Damage

- **Deleting a WhatsApp line cascades**: conversations + messages + gateway auth dir are purged. No backup covers conversations/messages.
- **Deploy ONLY via `scripts/deploy/host-release.sh`**; `.deployed-commit` is authority; push ≠ deploy.
- **A deploy runs startup migrations that can DELETE rows** — "no migration files" ≠ "no data change".
- **Gateway RAM is volatile** — recreate costs the in-memory message store (up to 2000 messages per chat). Deploy order: backend persistence → verify health → gateway.
- **Persistence kill-switch opens ONLY on `true`/`1`**.

### B. Core Behavioral Invariants

- **Chat-list order = absolute last message** (not last received). Coerce to uint64.
- **Empty preview never gates `last_message_at`**. Text-less → `[MARKER]` preview.
- **LID bridge keyed to CONNECTION, never person**. `ws.gateway_id` matched 4/4107; defer on `lid_jid` alone.
- **On-demand PDO failure is per-CHAT**, not per-session.
- **`should_apply_last_message` rejects `ts <= cur`** — older or equal timestamp never updates preview.
- **`resolve_contact_identity` owns names**; REST/WS fields match (never `lead_phone`); sort by activity.

### C. Cross-Cutting Rules

- **"Persist et ama yayınla-ma" — three mechanisms, two are WRONG tools:**
  - `_internal_only` (gateway) — sends to local emitter but NOT to backend. Correct for history-sync, fatal for DB writes.
  - `_skip` (backend) — `db.commit()` only called if postgres + event_id. SQLite/test path stays uncommitted.
  - **`_no_broadcast`** — correct tool. Read AFTER commit (`main.py:771`), ACKs but doesn't broadcast.
- **`messages.upsert` type (`notify`/`append`) MUST be passed through** to `_ingestUpsertMessage`. Without it, append (history) behaves like live notify — badge, preview, broadcast.
- **`messages.update` still defaults to `notify`** (pre-existing, consciously left).
- **Append preview: `should_apply_last_message` rejects `ts <= cur`**, BUT `msg_dt = ... or utc_now_naive()` fallback makes timeless history "now" ⇒ append + no `created_at` → `apply_last_message` must NOT be called.
- **Exported-but-never-called guard = dead guard.** Parity between two mirrors can't detect something missing from both — derive the set from the CONSUMER.
- **A cleanup key must come from the SAME function the writer uses.** `_upsert_contact` writes `contact_phone_for_jid(jid)`. `jid_to_phone` returns `None` for `@g.us` AND `@lid` ⇒ `WHERE phone_e164 = NULL` silently deletes nothing while the test stays green.

---

## 3. Release State

| Item | Value |
|---|---|
| **Deployed** | `0b795ea6` (`release/backend-only-seq-safety`, 2026-11-01T11:01:27Z) |
| Deploy scope | 5 backend files only, `--no-gateway` |
| Carries | **4.27** (epoch_reset → `after_seq=0`) + **4.28** (jid chunking, `_SYNC_BULK_PAGE_SIZE=1000`, `_SYNC_PER_CHAT_LIMIT=50`) |
| `main` HEAD | `e7f1077a` (5.2.6, parent `a4f12d7`) — NOT deployed, not pushed, ahead 3 vs `origin/main` |
| `main` dirty | 85 (24 modified + 61 untracked) — unchanged across all sessions |
| Persistence loop | OFF (4.27 shipped but dormant; enabling as-is is UNSAFE) |
| 4.34 (live E2E) | NOT yet run |
| `.workbuddy-ai/memory/*` | tracked and dirty — `git add -A` would put it in a release commit; stage explicit file list |

### Cannot deploy from main
`main` lacks 4.27/4.28 and the deployed gateway `20c88bb` is not its ancestor. The 4 changed files are blob-identical on `release/backend-only-seq-safety`, so re-applying there is the cheap path.

---

## 4. What Was Done — Phase-by-Phase Summary

### Phase 4.26 — Production Deployment (2026-10-31)
- Deployed `de1f1ad` (combined backend 4.7 + gateway 4.17) to production.
- `DEPLOY_RC=0`, 2m27s, no rollback. 4/4 containers healthy, RestartCount 0.
- **F6 finding:** P0-1's backend half is DORMANT. `memory_persistence.py` contains seq code but persistence loop is off. Initial sync still uses OFFSET (`sync.py:1703-1718`), not seq.

### Phase 4.27 — Seq Integration + Persistence Safety (2026-11-01)
- **F1 (P1) CONFIRMED BUG:** Epoch reset produced fake `PaginationStalled` because `after_seq` was not reset to 0. Fix: 1 line (`after_seq = 0` in epoch block). A/B proven.
- **F2 (P1) OPEN:** Initial sync offset + `perChatLimit` = silent message skip. Offset slides left when new messages arrive between pages.
- **F3 (P2):** `initial_sync_completed_at` means "chat list ready", not "history complete".
- Patch: `ASAMA-4.27-epoch-reset-cursor.patch` (source) + `ASAMA-4.27-epoch-reset-cursor-test.patch` (test was missing from original patch).
- 920 passed / 4 skipped (baseline 919/4 → +1 new test).

### Phase 4.28 — Initial Sync Safety + E2E Acceptance (2026-11-01)
- **F2 root cause:** `perChatLimit` applied at read-time per request (`session-manager.js:1272`), then `slice(offset, offset+limit)`. Between pages, if messages arrive, window shifts left → fixed offset misses records. Permanent: missed record stays below watermark.
- **Fix (E2): JID chunking.** `chunk = page_size // per_chat_limit` (1000/50 = 20). One request's total ≤ chunk*per ≤ page_size ⇒ request finishes in first page ⇒ no inter-page offset.
- Patch: `ASAMA-4.28-initial-sync-chunking.patch` (+73/−10 after refactor).
- **NOT deployed** — production still uses offset.
- Full regression: 2068 passed / 4 failed (all `test_whatsapp_postgres_concurrency.py` — needs live PG).

### Phase 4.29 — Backend-only Release Preflight (2026-11-01)
- Ready with conditions. Code/test ready, packaging not (no commit = no SHA).

### Phase 5.3.1 — Controlled Integration Base (2026-11-01)
- Worktree: `/private/tmp/tz531-integration`, branch `integration/whatsapp-5.3-seq-safe`, base `0b795ea`.
- Applied 5.2 changes (notify/append event contract) onto 4.17+4.27+4.28 base.
- 4 production files changed: `socket-events.js` (+7/−2), `session-manager.js` (+34/−7), `events.py` (+89/−3), `main.py` (+17).
- 3 new test files added from main.
- 4.17 protections verified intact (14/14 symbols).
- Test 4 (parity) failed: frontend still had `gateway_connected` in `LIVE_SESSION_EVENTS`.
- **Karar: CONDITIONAL.**

### Phase 5.3.1b — Frontend Event Parity (2026-11-01)
- Removed `'gateway_connected'` from `LIVE_SESSION_EVENTS` set (1 line deletion).
- All 6 tests passed: 45 pytest + 45 node controls, 0 errors.
- Gateway tests (5, 6) ran for the first time — required `ln -s` to repo root `node_modules` (302 entries, not gateway's empty dir).
- `uv run --offline` for Python env (55 packages, 186ms, no network).
- **Karar: PASS.**

### Phase 5.3.2 — Commit Readiness (2026-11-01)
- Fixed stale comment in `whatsappApi.ts` about `gateway_connected` (+21/−6 comment-only change).
- Frontend build: exit 0, 1718 modules, 12.43s.
- Parity test recheck: 12 passed.
- Secret scan: 0 matches across 13 commit candidates.
- Evidence strategy: `.log` files are gitignored (`*.log`); summaries in `EVIDENCE.md` + `t0-frontend-one-line.diff` (trackable).
- Erratum: 5.3.1 report had wrong line counts (+92/−11 should be +89/−3, etc.).
- **Karar: PASS.**

### Phase 5.3.3 — Controlled Commit (2026-11-01)
- Committed exactly 13 named files at HEAD `0b795ea` → commit `3ac26a9ffdd1a4738de915be255ee65c6b5be314`.
- Message: `feat(whatsapp): integrate notify append event contract on seq-safe release base`.
- One whitespace exception approved by user (trailing space in `.diff` context line).

### Phase 5.3.4 — Release Branch Compatibility (2026-11-01)
- Read-only analysis comparing cherry-pick/merge/re-application.
- Recommended fast-forward (blob-identical files on release branch).

### Phase 5.3.5 — Fast-Forward Integration (2026-11-01)
- `git merge --ff-only` in `/private/tmp/tz429-release` from `0b795ea` to `3ac26a9`.
- Clean FF, no conflicts, untracked files preserved.

### Phase 5.3.6 — Full Regression (2026-11-01)
- 7 backend tests (139 tests) + 3 gateway tests (28 controls) + build. All PASS.
- Three coverage gaps identified:
  1. No behavioral test for 4.17 write order (`stampMessageSeq` → `trimChatMessages` → `boundMessagesByChat`).
  2. No frontend regression test for `tezlify:ws_connected`.
  3. 4.27 epoch reset test not in the mandatory regression set.

### Phase 5.3.7 — Regression Coverage Hardening (2026-11-01)
- Closed all three coverage gaps:
  1. **4.17 write-order test** (`test-ingest-write-order.mjs`, 9 controls): Proxy-wrapped store to observe `SEQ→TRIM→BOUND` sequence. Mutation-verified.
  2. **`tezlify:ws_connected` frontend test** (`verify-live-mode-ws-connected.mjs`, 9 controls): esbuild + jsdom + React `act()`. Mutation-verified. Required explicit `process.exit(0)` to fix jsdom timer hang.
  3. **4.27 epoch reset in mandatory set**: Added `test_whatsapp_pagination_contract.py` to `run_whatsapp_regression.py`.
- Created project's first executable mandatory regression runner (`run_whatsapp_regression.py`).
- Connected new tests to `package.json` script chains (additive only, no version/lockfile changes).
- Full regression: 8/8 backend (149 tests), 4/4 gateway (37 controls), 3/3 frontend, build exit 0.
- Production source diff = 0 lines.
- **No commit** (await approval).

### Phase 5.3.8 — Event Contract & Update Semantics Audit (2026-11-02)
- **SALT OKUNUR** denetim. No code changes.
- **KONU A — `messages.update` upsertType:** `socket-events.js:1243` calls `_ingestUpsertMessage` without `upsertType` → defaults to `notify`. This means message updates (retry decryption, edit) are processed as live new messages: unread count increases, preview updates, broadcast fires. **Karar: DESIGN GAP (P2).** Existing protections mitigate the worst risks: `wa_message_id` dedup prevents duplicate rows, `should_apply_last_message` rejects older timestamps, status path is fully separate (`_applyMessageAck` → `message_status_updated`).
- **KONU B — `session_deleted`:** No producer in gateway, no handler in backend. Frontend `LIVE_SESSION_EVENTS` set has it as vestigial. Parity test lists it in `FRONTEND_UNPRODUCED_EVENTS`. Backend deletes via REST API, not WebSocket event. **Karar: NO ISSUE FOUND (vestigial).** Sub-finding (P3): `deleteSession` doesn't emit `session_disconnected` (unlike `logoutSession`), so multi-tab can't learn about deletion via WebSocket.
- Report: `docs/audits/ASAMA-5.3.8-event-contract-analysis.md`.

---

## 5. Key Technical Concepts

### 4.17 Write Order
`session-manager.js:2566-2568` — `stampMessageSeq` → `trimChatMessages` → `boundMessagesByChat`.
Three functions leave **disjoint store traces**: stamp→`store._messageSeq`, trim→`store.evictionsTotal` (only at ceiling), bound→`messagesByChat.delete(currentKey)`. Order only observable via call-time store touches (Proxy instrumentation), not final state.

### 4.27 Epoch Reset
Located in `backend/app/services/whatsapp/memory_persistence.py` (NOT `orchestration/`). `epoch_reset` flag, `after_seq = 0`, `epoch_resets_total` counter.

### 4.28 Chunking
`sync.py:103` `_SYNC_BULK_PAGE_SIZE = 1000`, `:107` `_SYNC_PER_CHAT_LIMIT = 50`, `:110` `_bulk_chunks`.

### 5.2 Notify/Append
- Gateway: `_ingestUpsertMessage(msg, sock, id, { upsertType: type })` — type passed through from `messages.upsert`.
- Backend: `upsert_type` field in `message_new` event; `is_append = upsert_type == "append"`.
- Append path: persist + ACK, no broadcast, no unread increment, no preview move (if timestamp exists; if not, `apply_last_message` not called at all).
- `_no_broadcast` consumed at `main.py:771` — after commit, ACKs but doesn't broadcast.
- Three return paths must all close: normal persist, pre-flight `return event # dedup`, `IntegrityError` recovery.

### Event Contract Parity
Three-direction set comparison (not count):
1. Gateway → Backend: every emitted event has a handler.
2. Backend → Gateway: backend accepts nothing the gateway never emits (allowlisted aliases: `chat_update`).
3. Backend → Frontend: every frontend-expected event is actually forwarded (allowlisted vestigial: `session_deleted`).

### Test Infrastructure
- **Python:** `uv run --offline --python 3.13 --with-requirements backend/requirements.txt --with pytest --with pytest-asyncio`. System Python lacks deps.
- **Test DB:** `TEST_DB_PATH=/tmp/... PYTHONPATH=. python scripts/provision_test_db.py` — 34 tables. `conftest.py` runs incremental migrations only (`ensure_*`), NOT `create_all`.
- **conftest fail-closed:** `assert_test_db_is_not_remote()` and `assert_test_db_matches_requested_path()`. `TEZLIFY_TEST_DB_REMOTE_OK` must NEVER be set.
- **Gateway tests:** `node_modules` symlink to repo root (302 entries). Gateway's own `node_modules` is empty.
- **Frontend tests:** esbuild bundle + jsdom + React `act()`. Run via `node scripts/verify-*.mjs`. `TEZLIFY_SRC_ROOT` env override for mutation testing.
- **Mandatory regression runner:** `backend/scripts/run_whatsapp_regression.py` — 8 backend test files, fresh SQLite DB per file, strips `TEZLIFY_TEST_DB_REMOTE_OK`.

### Git Worktree Pattern
All work done in `/private/tmp/tz*-release` worktrees, never in main worktree.
Main stays at `main` branch, HEAD `e7f1077`, 85 dirty entries — untouched.
Worktree creation: `git worktree add /private/tmp/tz429-release release/backend-only-seq-safety`.

---

## 6. File Map — What Changed and What Didn't

### Committed at `3ac26a9` (on `release/backend-only-seq-safety`)
| File | Change | Content |
|---|---|---|
| `backend/app/main.py` | +17 | `_no_broadcast` ACK branch |
| `backend/app/services/whatsapp/orchestration/events.py` | +89/−3 | 5.1 + 5.2 (9 hunks) |
| `whatsapp-gateway/src/session-manager.js` | +34/−7 | `_ingestUpsertMessage` + `_touchChat` append semantics |
| `whatsapp-gateway/src/socket/socket-events.js` | +6/−1 | `type` plumbing to `_ingestUpsertMessage` |
| `frontend/src/features/whatsapp/api/whatsappApi.ts` | +21/−6 | Comment fix + `gateway_connected` removal |
| `backend/tests/test_whatsapp_event_contract_parity.py` | NEW | 12 tests, 3-direction parity |
| `backend/tests/test_whatsapp_upsert_append.py` | NEW | 17 tests, notify/append backend |
| `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` | NEW | 13 controls, gateway notify/append |

### Created in 5.3.7 (untracked, not committed)
| File | Content |
|---|---|
| `whatsapp-gateway/scripts/test-ingest-write-order.mjs` | 9 controls, 4.17 behavioral write order |
| `frontend/scripts/verify-live-mode-ws-connected.mjs` | 9 controls, `tezlify:ws_connected` regression |
| `backend/scripts/run_whatsapp_regression.py` | Mandatory regression runner (8 files) |
| `whatsapp-gateway/package.json` | +1 line in `test` script chain |
| `frontend/package.json` | +1 line `verify:live-mode` script |

### Created in 5.3.8 (untracked)
| File | Content |
|---|---|
| `docs/audits/ASAMA-5.3.8-event-contract-analysis.md` | Event contract & update semantics audit report |

### NEVER touched
- `whatsapp-gateway/src/messages/message-store.js` (4.17 core)
- `whatsapp-gateway/src/index.js`
- `backend/app/services/whatsapp/memory_persistence.py`
- `backend/app/services/whatsapp/orchestration/sync.py`
- `backend/app/services/whatsapp_gateway.py`
- Any `package-lock.json` or version number
- `.gitignore`
- Main worktree (any file)

---

## 7. Open Items & Next Steps

### Immediate
1. **5.3.7 test files need commit approval** — 5 files (3 new tests, 2 `package.json` edits) are untracked/uncommitted on the release branch.
2. **5.3.8 findings need a coding phase** if the user wants to close them:
   - KONU A: Add `upsertType: 'replace'` (or `'update'`) to `socket-events.js:1243` call; teach backend to handle it (no unread increment, conditional preview, still broadcast).
   - KONU B: Optionally emit `session_disconnected` from `deleteSession`; remove `session_deleted` from `LIVE_SESSION_EVENTS` (vestigial cleanup).

### Not yet done
- **4.34 (live E2E acceptance)** — never run. Requires real WhatsApp connection.
- **Persistence loop activation** — 4.27 shipped but dormant. Enabling as-is is UNSAFE (separate task).
- **4.28 chunking NOT deployed** — production still uses offset initial sync. Silent message skip risk remains live.
- **Main → release merge** — main is ahead 3 vs origin but lacks 4.27/4.28. Re-applying on `release/backend-only-seq-safety` is the cheap path.

### Key risks still live in production
- F1 (4.27 epoch reset fake stall) — latent, `runs:0`, never triggered.
- F2 (4.28 offset skip) — **live in production**, not deployed.
- F6 (P0-1 backend half dormant) — persistence loop off.
- 5.3.8 R-1 (messages.update notify default) — P2 design gap, mitigated.
- 5.3.8 R-3 (deleteSession no event) — P2, mitigated by REST API response.

---

## 8. Patterns & Gotchas (Learned the Hard Way)

- **zsh `:w`/`:b` modifier trap:** `git show $REL:path` silently mangles paths. Always quote: `"${REL}:path"`.
- **BSD grep BRE trap:** macOS `grep "a\|b"` returns empty. Use `grep -E`.
- **jsdom/React timer hang:** `pretendToBeVisual` + React schedulers prevent self-termination. Requires explicit `process.exit(0)`.
- **npm workspaces hoisting:** `typescript` in root `node_modules` (302 entries), `vite`/`react` in `frontend/node_modules` (82 entries). Gateway's own `node_modules` is empty (0 entries).
- **`.log` files are gitignored** (`*.log`). Evidence summaries go in `.md` files.
- **`git hash-object`/`rev-parse` (SHA1) vs `shasum -a 256` (SHA256)** — never mix.
- **`git show <c>:<path> | shasum` is NOT a presence test** — a failing `git show` hashes `e3b0c442…` (empty). Use `git cat-file -e`.
- **"Green test can hide a dead guard"** — assert absence of error, not just side effect.
- **Equal counts ≠ equal sets** — always compare sets, not counts.
- **A cleanup key must come from the SAME function the writer uses.**
