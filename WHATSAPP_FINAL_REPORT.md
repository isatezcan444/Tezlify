# TEZLIFY WHATSAPP — FINAL REPORT

**Base commit:** `f6ec68d` (clean tree) → working tree with audit fixes applied
**Companion document:** [`WHATSAPP_FORENSIC_AUDIT.md`](./WHATSAPP_FORENSIC_AUDIT.md) (17-section forensic audit)
**Method:** forensic audit → root cause → minimal fix → regression test → executed verification. No report claim was accepted as evidence; every finding was re-read from this checkout.

---

## EXECUTIVE SUMMARY

```text
System state:      Working, architecturally sound, but the last six "fix" commits layered
                   guards onto the identity path without consolidating them, leaving the
                   push-name rule enforced in 2 of 3 writers and the history-evidence table
                   read with the wrong key. Send/ACK/echo, session leases, LID persistence
                   and activity ordering are genuinely solid.

Critical (P0):     0 confirmed. No path reports a failed send as success in the live send
                   flow; no message loss, wrong-session send or conversation loss found.

High (P1):         11 identified
                     - 9 fixed and regression-tested in this pass
                     - 1 latent (flag OFF, unreachable today)
                     - 1 left open by decision (New Chat — needs a product call)

Medium (P2):       38 identified — 3 fixed, 35 documented with file:line

Fixed:             H-1, I-1(+safe_display_name), I-3, S-1, C-1, F-1, F-2, F-3, F-4, G-1, G-2
                   (11 code fixes across backend / gateway / frontend)

Remaining:         F-5 New Chat (broken control, product decision), H-2 latent sweep
                   violation, G-3 LID session scoping (semantics ambiguous), S-2/S-4
                   session races, H-4/H-5 history budget, 35 P2 items, and
                   live-device E2E verification (not possible in this environment)
```

**Headline corrections to prior reports**

| Prior claim | Reality verified in this checkout |
|---|---|
| "push names isolated from address book contacts" (`f6ec68d`) | **Incomplete.** `resolve_contact_identity` and `set_contact_name` were hardened, but `_upsert_contact`'s **create** branch still wrote the raw push name into `contact.display_name`, and `safe_display_name` never consulted `name_source`. Fixed. |
| History evidence / two-step exhaustion is durable (Phase 17) | **The read path was dead.** `history_sync_states` is keyed by the gateway session UUID; the facade read it with the integer PK. Exhaustion short-circuit never fired and `has_more` was permanently `True`. Fixed. |
| "975 passed" | Reproduced exactly: **975 passed** at `f6ec68d`. Prior 967/970 figures came from other checkouts. |
| Conversation ordering safe from identity | **Confirmed correct.** Ordering is activity-only in both backend and frontend; the "identity broke ordering" hypothesis does not hold. |
| "no permanent resolving spinner" | **Confirmed by unreachability**, not by a fix — the backend can never emit `RESOLVING_TRANSIENT`. No escape hatch exists if it ever does (latent). |

---

## ARCHITECTURE

```text
Backend:    FastAPI + SQLAlchemy 2.0 async + Pydantic v2.
            `whatsapp_service.py` is the PUBLIC FACADE (Phase 11.11) — verified reachable
            from both the REST endpoints and the /ws ingestion path. NOT legacy; do not delete.
            Orchestration split: sessions / messaging / events / sync, each owning its
            transactions. Repositories own SQL only. Pure policies in identity.py,
            status_policy.py, preview_normalization.py.

Gateway:    Node + Baileys. `session-manager.js` (3363 lines) owns per-session RAM stores
            (contacts/chats/messages/rawMessages), the LID map, media index and the socket.
            Durable outbox (ACK/NACK/replay), single-owner Postgres leases, socket-generation
            guard, encrypted auth state (AES-256). Binds 127.0.0.1.

Frontend:   React 18 + TS + Vite + Tailwind (Vuexy). `WhatsAppHubPage.tsx` is the state
            owner (conversations / messagesMap / peerTypingMap / sessionSync). Pure helpers in
            features/whatsapp/lib. Single ordering comparator, single conversation mapper.

Database:   Public schema + `whatsapp_private` schema (lid_mappings, history_sync_states,
            gateway_sessions). Uniqueness enforced at DB level for contacts
            (user_id+phone_e164), conversations (user_id+session_id+contact_id+channel) and
            messages.client_message_id. `messages.wa_message_id` has NO unique constraint.

Realtime:   Gateway → durable outbox → /ws/gateway (fail-closed token auth) → orchestrators →
            ws_manager.broadcast(message, target_user_id) → /ws → React.
            Fail-closed: no resolvable target user ⇒ no broadcast.

History:    On-demand only. `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED=false` (double-gated).
            Evidence table drives exhaustion/stall; cursor is (wa_message_id, from_me, ts_ms).
            Two-step exhaustion on the on-demand path; the (unreachable) background sweep
            violates it — documented, flag off.

Identity:   Canonical hierarchy in `resolve_contact_identity`:
            group subject > addressbook/verified (name_source != 'push') > clean E.164 >
            push_name (LID only) > RESOLVED_JID > UNRESOLVED_PERMANENT.
            After this pass, REST, WebSocket and the contact-create path all agree.
```

---

## BUG MATRIX

| Bug | Root Cause | Status | Fix |
|---|---|---|---|
| **H-1** `has_more` always `True`, exhaustion short-circuit dead | `history_sync_states.session_id` is a gateway UUID (TEXT FK); facade queried it with `conv.session_id` (integer PK) → every lookup missed | **FIXED** | `whatsapp_service.py`: new `_history_evidence_session_id()` resolves the gateway id via the already-imported-but-unused `_conversation_gateway_id`; used for both the exhaustion check and the evidence read |
| **I-1** stranger push name persisted as `contact.display_name` | `_upsert_contact` create branch had no `name_source == 'push'` exclusion (bulk path and `set_contact_name` both had one) | **FIXED** | `events.py:216-241`: push names are never written to `display_name`; stored as `custom_attributes.push_name` |
| **I-1b** `safe_display_name` leaked push names over WS | It returned `display_name` without consulting `name_source` | **FIXED** | `identity.py`: returns the normalized phone for push contacts when a phone resolves (matching `resolve_contact_identity`), push name only for unmapped LIDs |
| **I-3** LID reconciliation erased a conversation's name+phone | `conversations_updated` emitted `lead_phone`; the mapper reads `phone` → `undefined` → `{...existing, ...mapped}` overwrote name and phone | **FIXED (both sides)** | `events.py`: emits the canonical REST shape (`name`/`phone`/`identity_state`/…), `lead_phone` removed. `whatsappApi.ts`: mapper copies a field **only when present in the payload**; new rows get defaults at the call site |
| **S-1** relink notification never reached the UI | `ws_manager.broadcast(..., tenant_id=...)` — the parameter is `target_user_id`; `TypeError` swallowed by `except … logger.debug` | **FIXED** | `sessions.py`: correct kwarg + `user_id` in the payload; log level raised to `warning` |
| **C-1** `UnboundLocalError` silently dropped events | self-identity branch referenced `phone_e164` without assigning it when no self contact existed | **FIXED** | `events.py`: falls through with `_contact_phone_for_jid(clean_jid)` |
| **G-1** "read" reported although WhatsApp never received the receipt | `markConversationRead` zeroed `unread_count` and emitted `conversation_read: 0` even when `gatewayOk === false` | **FIXED** | `session-manager.js`: state change + event now inside the success path only (its own code comment already documented this contract) |
| **G-2** `ReferenceError` masked LID errors | `logger` used in `index.js` but never imported/defined | **FIXED** | `index.js`: `pino` logger added |
| **F-1** archive/close/reopen was a phantom action with a fake success toast | `handleStatusChange` only mutated local state; `updateConversationStatus` unconditionally threw; no backend endpoint existed | **FIXED** | New `PATCH /conversations/{id}/status` + `update_conversation_status()` facade (persists + broadcasts `conversation_status_updated`) + repository/API wiring + optimistic rollback on failure |
| **F-2** server-side conversation search silently disabled | `search` declared and passed by callers but never appended to the querystring (backend fully supported it) | **FIXED** | `whatsappApi.ts`: `qs.set('search', …)` |
| **F-3** silent refresh discarded paged-in conversations | `loadConversations` did `setConversations(page.items)` (page 1 only) | **FIXED** | Merge page 1 with locally paged-in **older** rows; rows newer than the returned tail are dropped (server says they're gone); full replace when `has_more === false` |
| **F-4** wrong chat rendered on rapid lead switch | no generation guard / abort around the fetch | **FIXED** | `useWhatsAppConversation.ts`: fetch-generation guard on every state write |
| **I-4** `conversation_updated` bypasses the shared mapper | hand-rolled `patch()` ignores `phone`/`identity_state` | OPEN (P2) | Payload now carries canonical fields; the handler should be routed through `mapConversationItem` in a follow-up |
| **F-5** New Chat always fails | `startConversation` is an unconditional `throw`; no live path | OPEN (P1) | Needs a product decision (is starting a chat with an unknown number desired?) |
| **H-2** background sweep sets `FULLY_EXHAUSTED` from one call | `sync.py:1383-1402` contradicts `history_evidence.py:282-296` | OPEN (P1, latent) | Unreachable while the flag is off; must be aligned before the flag is ever enabled |
| **G-3** cross-session LID mapping loading | `SELECT DISTINCT ON (lid_jid) … ` has no `WHERE session_id`; the disk scan writes other sessions' pairs under the current `session_id` | OPEN (P2) | Semantics ambiguous (LID↔PN may legitimately be global); needs a product call before scoping |
| **G-4…G-10, C-2…C-5, I-5…I-7, S-2…S-5, H-3…H-6, F-6…F-13** | see `WHATSAPP_FORENSIC_AUDIT.md` §7–§13 | OPEN (P2) | Documented with file:line |
| "non-monotonic `last_message_at` in `_repair_last_message_previews`" | — | **WITHDRAWN** | False positive. The backward move is intentional poison repair, pinned by an existing test. The attempted fix broke that test and was reverted; a clarifying comment was added |
| #10 initial-sync conversation completeness | — | **NOT VERIFIED** | Requires a live device; not reachable in this environment |

---

## TEST MATRIX

| Suite | Command | Result |
|---|---|---|
| Backend (full) — baseline | `PYTHONPATH=. pytest backend/tests/ -q` @ `f6ec68d` | **975 passed** (54.8s) |
| Backend (full) — after fixes | same | **988 passed** (62.5s) — 975 baseline + 13 new regression tests, 0 failures |
| Backend (new regression) | `pytest backend/tests/test_whatsapp_forensic_fixes.py -q` | **13 passed** |
| Backend (WhatsApp subset) | `pytest backend/tests/ -k "whatsapp or identity" -q` | covered inside the full run; no failures |
| Gateway | `for f in whatsapp-gateway/scripts/test-*.mjs; do node "$f"; done` | **16 / 16 PASS** (15 pre-existing + 1 new) |
| Gateway (new regression) | `node whatsapp-gateway/scripts/test-read-truthfulness.mjs` | **PASS** (3 scenarios: provider failure / success / disconnected) |
| Frontend typecheck | `npx tsc --noEmit` | **exit 0** |
| Frontend build | `npm run build` (tsc && vite build) | **✓ built in 4.45s**, 1626 modules, no errors |
| Frontend logic (executed) | `node frontend/scripts/verify-whatsapp-logic.mjs` | **7 / 7 PASS** — bundles the real source with esbuild and asserts partial-merge + ordering behaviour |
| Whitespace | `git diff --check` | **clean** |
| Working tree | `git status --short` | 15 modified + 4 new files (listed below) |

**Frontend logic checks (executed, not typechecked):**
partial `conversations_updated` does not wipe name/phone · canonical payload updates identity · full REST payload unchanged · ordering ignores identity state/name/phone · a late name resolution does not re-sort · message-less conversations never outrank · comparator is a total order (no flicker).

**Real UI / device testing:** a live end-to-end run (backend + gateway + a paired WhatsApp device + browser) was **not performed** — this environment has no paired device or production credentials, and fabricating one would violate the project's no-false-success rule. The frontend checks above execute the real shipped modules, but they do not replace device E2E.

---

## PRODUCTION

**No production mutation was performed. No production credentials were used. No read-only production queries were run from this session.**

```text
Session status:           Not verified live. Code paths for relink/recovery/lease are sound
                          (generation guard + single-owner lease + fail-closed sends), but the
                          relink UI notification was dead until this pass (S-1) — any session
                          currently stuck in RELINK_REQUIRED was never surfaced to the operator.

Gateway status:           Not verified live. Code paths are fail-closed and no fake-phone /
                          mock-success path exists. G-1 meant the UI could previously show
                          "read" when WhatsApp had not received the receipt; fixed.

Conversation integrity:   Ordering verified activity-only on both sides. No duplicate-creation
                          path found (DB constraint + retry). F-3 previously discarded
                          paged-in rows on every silent refresh; fixed.

Contact integrity:        DB-level uniqueness holds (uq_contact_user_phone). The bulk upsert
                          is N+1-free. The create path polluted display_name with push names
                          (I-1) — existing polluted rows are NOT remediated here; see below.

Message integrity:        Send/ACK/echo verified sound (monotonic ACK, both-direction echo
                          dedup, permutation-tested). messages.wa_message_id has no unique
                          constraint — concurrent ingest dedup is SELECT-then-INSERT.

Identity integrity:       REST / WebSocket / create-path now agree (single authority). One
                          live leak remains in ChatBubble sender labels (I-5, P2).

History integrity:        Evidence/cursor/two-step exhaustion verified at source level and
                          durably committed before exceptions. H-1 made the read path dead
                          (infinite pagination); fixed.
```

### Data remediation — READ-ONLY report first (nothing applied)

Required before any cleanup. Run these as **reads**, then review the output:

```sql
-- 1. push names written into display_name by the old create path
SELECT COUNT(*) FROM contacts
WHERE custom_attributes->>'name_source' = 'push'
  AND display_name IS NOT NULL
  AND display_name <> phone_e164;

-- 2. duplicate phones (expected 0 — uq_contact_user_phone)
SELECT user_id, phone_e164, COUNT(*) FROM contacts GROUP BY 1,2 HAVING COUNT(*) > 1;

-- 3. duplicate conversations (expected 0 — uq_conv_user_session_contact_channel)
SELECT user_id, session_id, contact_id, channel, COUNT(*) FROM conversations
GROUP BY 1,2,3,4 HAVING COUNT(*) > 1;

-- 4. unmapped LIDs still stored as the contact key
SELECT COUNT(*) FROM contacts WHERE phone_e164 LIKE '%@lid';

-- 5. history evidence distribution (FULLY_EXHAUSTED is likely absent because of H-1)
SELECT state, COUNT(*) FROM whatsapp_private.history_sync_states GROUP BY 1;

-- 6. LID mapping attribution across sessions
SELECT session_id, COUNT(*) FROM whatsapp_private.lid_mappings GROUP BY 1;
```

**Recommended remediation for query 1 — only after review, and only the `display_name` column:**

```sql
-- For push-polluted rows, restore display_name to the phone and keep push_name as metadata.
-- NOT a bulk DELETE. Run inside a transaction, verify the row count, then commit.
UPDATE contacts
SET display_name = phone_e164
WHERE custom_attributes->>'name_source' = 'push'
  AND display_name IS NOT NULL
  AND display_name <> phone_e164
  AND phone_e164 NOT LIKE '%@lid';   -- LID rows legitimately keep the push name
```

Do **not** bulk-delete `push_name`, `display_name`, or `addressbook` values. Rows where `phone_e164 LIKE '%@lid'` must keep their push name (it is the agreed fallback).

---

## REMAINING RISKS

1. **No live-device E2E evidence.** Item #10 (conversations missing after initial sync) is unverified, and the identity/ordering fixes have not been exercised against a real paired device. This is the single largest gap.
2. **F-5 — New Chat is a broken user-facing control.** Prominent CTA on two surfaces, always errors. Left open pending a product decision.
3. **H-2 — latent sweep violation.** The background sweep sets `FULLY_EXHAUSTED` from one provider call. Unreachable while `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED=false`; must be fixed *before* anyone enables it.
4. **G-3 — LID mapping session scoping.** Cross-session loading is either a deliberate global-fact optimisation or a tenant-isolation leak; the DB attribution is definitely wrong. Changing it risks regressing LID resolution (a hard-won, multi-commit feature), so it was left alone.
5. **S-2 / S-4 — session lifecycle races.** A pairing phone is persisted before pairing succeeds (disabling a fail-loud guard), and `skip_locked` in the relink candidate lookup can be confused with "no candidate", allowing duplicate session rows.
6. **I-4 — `conversation_updated` still bypasses the shared mapper.** The backend now sends canonical fields, but the handler ignores `phone`/`identity_state`, so a phone learned only via that event is not applied until a REST refresh.
7. **No escape hatch for `RESOLVING_TRANSIENT`.** Unreachable today; if ever emitted, a row would stick until a full refresh.
8. **Production data is polluted** (push names in `display_name`, likely misattributed LID rows). Remediation is staged above but deliberately **not applied**.
9. **`messages.wa_message_id` has no unique constraint.** Concurrent ingest can duplicate.
10. **Sync counters are cumulative event counts**, not unique entities — sync progress is misleading after cache eviction.

---

## CHANGED FILES

**Backend (7)**
`app/services/whatsapp/identity.py` · `app/services/whatsapp/orchestration/events.py` · `app/services/whatsapp/orchestration/sessions.py` · `app/services/whatsapp/orchestration/sync.py` (comment only) · `app/services/whatsapp_service.py` · `app/api/v1/endpoints/whatsapp.py` · `app/schemas/whatsapp.py`

**Gateway (2)**
`src/session-manager.js` · `src/index.js`

**Frontend (6)**
`src/features/whatsapp/api/whatsappApi.ts` · `src/features/whatsapp/data/whatsappRepository.ts` · `src/features/whatsapp/hooks/useWhatsAppConversation.ts` · `src/pages/WhatsAppHubPage.tsx` · `src/locales/en.ts` · `src/locales/tr.ts`

**New (4)**
`WHATSAPP_FORENSIC_AUDIT.md` · `WHATSAPP_FINAL_REPORT.md` · `backend/tests/test_whatsapp_forensic_fixes.py` · `whatsapp-gateway/scripts/test-read-truthfulness.mjs` · `frontend/scripts/verify-whatsapp-logic.mjs`

**Deployment notes**
- **No DB migration required.** The new endpoint reuses existing columns (`conversations.status/archived_at/closed_at`); no runtime DDL was added and no bulk data mutation was performed.
- Deploy backend and frontend together: the frontend calls the new `PATCH /conversations/{id}/status`; against an older backend it would 404 and show an error toast (honest failure, not a false success).
- No secrets were logged or written to source.

---

## FINAL VERDICT

```text
RELEASE CANDIDATE
```

Rationale: no P0 exists, and the highest-impact identity / realtime / pagination / truthfulness defects (H-1, I-1, I-3, S-1, G-1, F-1, F-2, F-3, F-4, C-1, G-2) are fixed with passing regression tests, a green build and executed frontend-logic verification. It is **not** RELEASE READY because there is no live-device end-to-end evidence, one user-facing control (New Chat) is still broken, and two latent/ambiguous items (H-2, G-3) plus the documented P2 backlog remain. It is **not** RELEASE BLOCKED — nothing found loses data, mis-reports a send, or routes to the wrong session.
