# TEZLIFY WHATSAPP — PHASE 6.1 REPORT
## Cross-Layer Behavioral Test Execution

**Date:** 2026-09-19 · **Local HEAD:** `f4db4dd`
**Question this phase answers:**

> When events arrive from different sources at the same time or in an unfavourable
> order, do the DB, the backend event state, the WebSocket payload and the React UI
> all converge on the same correct final state?

Phase 5 results are treated as given and are not re-audited (P5-1/2/3, C-5, G-3).
They were only re-tested where a scenario here would have caught a regression.

---

## 1. Scenario Results

| Scenario | Result | Evidence |
|---|---|---|
| **A** old snapshot after newer realtime | **PASS** | `test_scenario_a_old_snapshot_after_new_realtime_does_not_win` — T2 survives a later T1 snapshot in DB **and** WS; live message persisted exactly once. |
| **B** snapshot + live M1/M2/M3 | **PASS** | `test_scenario_b_live_messages_survive_the_snapshot` — 3 rows, order M1<M2<M3, preview M3, conversation on top. Same-timestamp pair: `test_scenario_b_two_messages_with_the_same_timestamp` — 2 rows, no collapse. |
| **C** history + live inbound | **PASS** (incl. real concurrency) | Merge: `test_scenario_c_older_history_does_not_overwrite_newer_live_state` — live inbound at T4 survives a 3-message older page; `last_message_at` and preview do not rewind; no duplicate. Replay: `test_scenario_c_history_page_replayed_is_not_duplicated`. **Concurrency (high-priority case, now executed):** `test_scenario_c_delayed_provider_with_live_inbound_in_flight` — the provider is monkeypatched to block on an `asyncio.Event` so the history request is genuinely in flight while a live inbound arrives and commits; only then is the provider released. Result: both rows present, no duplicate, `last_message_at` = live timestamp, preview = live message. |
| **D** history + realtime same `wa_message_id` | **PASS** | Backend: `test_scenario_d_same_wa_message_id_from_two_sources_is_one_row` — DB = 1, UI reads 1, despite different `event_id`s. Frontend: `§P6/D` in `verify-whatsapp-logic.mjs` runs the shipped `mergeWhatsAppMessages` on a history row and a realtime row sharing one `wa_message_id` with different DB ids → 1 bubble, higher delivery rank wins. |
| **E** outbound PENDING + reconnect + echo + ACK | **PASS** | `test_scenario_e_optimistic_row_reconciles_with_the_provider_echo` — one bubble, `DELIVERED`, preview and order correct. |
| **F** PENDING → FAILED → retry → SENT → echo | **PASS** | Backend: `test_scenario_f_failed_then_successful_retry_advances_to_sent` — FAILED→SENT advances (rank 0→1), late FAILED echo does not downgrade, no duplicate bubble. Frontend: `§P6/F` asserts the shipped `mergeDeliveryStatus` is monotonic in both directions — `FAILED+PENDING`→`FAILED` (no resurrection as PENDING), `FAILED+SENT`→`SENT` (retry advances), `SENT+FAILED`→`SENT`, `DELIVERED+PENDING`→`DELIVERED`, `READ+DELIVERED`→`READ` (old ACK cannot rewind). |
| **G** active chat + inbound (bottom / reading older) | **NOT EXECUTED** | Scroll anchoring is DOM behaviour and needs a React/DOM runtime the repo does not have (no vitest/jest, no jsdom). The state half (message visible, unread policy, preview, order) is covered by H / I / O / Q. See §3. |
| **H** inactive chat + inbound | **PASS** | `test_scenario_h_inactive_inbound_raises_unread_and_preview`, `..._replayed_message_does_not_double_count_unread` — unread set, preview and `last_message_at` updated, conversation on top; replay does not double-count. |
| **I** external read / unread decrease | **BUG → FIXED** | Was: stale snapshot resurrected the badge. Now: `test_scenario_i_external_read_decreases_then_stale_snapshot_cannot_raise` passes. See §2 (P6-1). |
| **J** read failure then success | **PASS** | `test_scenario_j_failed_mark_read_then_success` — provider down leaves unread at 4 and reports `success: False`; provider recovers → 0. Both phases in one test. |
| **K** contact save transition | **PASS** | `test_scenario_k_unsaved_number_to_saved_contact_keeps_identity_stable` — name becomes "Ahmet Yilmaz", conversation id and message rows unchanged. |
| **L** LID first, mapping later | **PASS** | `test_scenario_l_lid_then_mapping_keeps_one_conversation` — same conversation, same messages, same order, same preview after `lid_mapped`. |
| **M** group message before metadata | **PASS** | `test_scenario_m_group_subject_arrival_does_not_disturb_the_message` — subject applied, `is_group` true, `last_message_at` and preview unmoved, no duplicate conversation. |
| **N** refresh during pagination | **PASS** (backend + React state) | Backend: `test_scenario_n_previously_loaded_pages_survive_new_activity` — page 1 and page 2 loaded, then a new message and a competing snapshot arrive: pages all present and deduped, conversation on top, one conversation, preview = new message. **React state:** `§P6/N` runs the *shipped* `mergeWhatsAppMessages` — the exact function the reconnect and sync-chunk paths call (`WhatsAppHubPage.tsx:1573`) — over 50 + 50 loaded messages plus a refresh and a live message: 101 rows, oldest page retained, no duplicate `wa_message_id`, replaying the refresh twice changes nothing. Only the *rendered* DOM half remains unexecuted. |
| **O** rapid event burst | **PASS** | `test_scenario_o_burst_converges_to_one_canonical_state` — 6 interleaved events with yields reduce to one canonical state; DB and WS agree. |
| **P** reconnect + live events during reconcile | **PASS** | `test_scenario_p_live_events_during_reconcile_are_not_lost` — inbound, outbound ACK and a history event including a known id all survive: 4 unique rows, 1 outbound bubble, `DELIVERED`, correct preview/order. |
| **Q** concurrent history + scroll + new msg + read | **PASS** | `test_scenario_q_concurrent_ui_actions_keep_state_consistent` — two concurrent `gather`ed loads of the same anchor yield 1 row, unread 0, preview `q2`, one conversation. |

**Result: 16 PASS + 1 BUG→FIXED (I).** Counting executed work: **17 of 17 scenarios have a
passing executed half.** The single remaining gap is narrow and stated precisely: the
*rendered* DOM behaviour of G (scroll anchoring / new-message pill) and of N (retention of
already-rendered pages), for which this repo has no DOM runtime. Everything below that
boundary — DB, backend state, WS payload, and React message state — is executed.

---

## 2. CONFIRMED BUGS

### P6-1 — a stale snapshot could RAISE the unread badge

**ID:** P6-1 · **STATUS:** FIXED

**User impact**
Read a chat on your phone (or WhatsApp Web). The badge in Tezlify clears. A moment
later an older `conversation_updated` snapshot — generated *before* the newest message
we already hold — arrives and the badge comes back, showing unread messages the user
has already read. Scenario I of the directive requires the final value to stay 0.

**Exact reproduction**
`backend/tests/test_whatsapp_phase6_scenarios.py::
test_scenario_i_external_read_decreases_then_stale_snapshot_cannot_raise`

```
conversation: unread_count = 8, last_message_at = T4
1. conversation_updated { unread_count: 0, last_message_at: T4 }   -> 0
2. conversation_updated { unread_count: 8, last_message_at: T1 }   -> must stay 0
```

**Root cause**
`should_apply_unread_count()` (`preview_normalization.py`) had two asymmetric guards:

```python
if inc < cur and inc_ts < cur_ts:            return False   # decrease: stale-blocked
if inc > cur and read_ts and inc_ts <= read_ts: return False  # increase: read-blocked
```

The increase guard was anchored on `last_read_at`. An **external** read (read on the
phone) never sets `last_read_at` — only our own `mark_conversation_read` does — so the
guard was inactive and an older snapshot was free to raise the badge.

**Fix**
Made the staleness guard symmetric: a snapshot whose activity timestamp predates the
newest message we already hold cannot know about that message, so it may not move the
badge in **either** direction. The read guard is kept as a second, independent
protection for snapshots that are new enough to pass the first.

```python
if inc_ts is not None and cur_ts is not None and inc_ts < cur_ts:
    return False          # stale in both directions
if inc < cur:
    return True           # fresh enough -> apply verbatim (badge can go DOWN)
if read_ts is not None and inc_ts is not None and inc_ts <= read_ts:
    return False          # pre-read state must not resurrect the badge
return True
```

This does not block legitimate increments: a new inbound at T5 against a newest-known
T4 passes (`T5 < T4` is false), and equal timestamps pass too (Scenario B).

**Fail proof**
Reverting just that block gives:
`AssertionError: stale snapshot resurrected unread to 8 / assert 8 == 0` —
`1 failed, 18 deselected`.

**Pass proof**
With the fix: `19 passed` for the module; `1077 passed` for the whole backend suite.

**Regression test**
`test_scenario_i_external_read_decreases_then_stale_snapshot_cannot_raise`, plus the
cross-layer frontend check `§P6/I` in `verify-whatsapp-logic.mjs`.

---

## 3. FALSE POSITIVES / NOT EXECUTED

| Item | Verdict | Why |
|---|---|---|
| Scenario F: "an outbound created via `message_new` came back SENT, not FAILED" | **Test artefact** | The optimistic row is created by the API send path (`messaging.py:101-179`), not by a `message_new` event; `_ingest_message` assigns its own status on creation. The test now seeds the row the way the send path does (`_add_outbound_row`). No product bug. |
| Scenario E: preview stayed on the seed message | **Test artefact** | `messaging.send_text_message` refreshes the conversation preview at lines 171-177; my helper had bypassed it. The helper now applies the same shared `apply_conversation_last_message`. No product bug. |
| `test_whatsapp_live.py` 12 failures | **Test infrastructure** | Caused by my own scratch script (see §4), not by the unread change. After cleanup: 56/56 pass. |
| Scenarios G, N (**rendered** DOM half only) | **Not executed** | `ChatThread.tsx` handles scroll imperatively (`scrollIntoView`, `scrollTop = prevScrollTop + heightDiff`, a 120 px near-bottom threshold, a 60 px older-page trigger, and the new-message pill). Those are real DOM measurements and there is no DOM runtime (no vitest/jest/jsdom). N's **state** half is now executed via the shipped `mergeWhatsAppMessages`; N's backend half passes; G's state half is covered by H / I / O / Q. |

**Falsification control (the new tests have teeth).** A PASS is only meaningful if the
test would fail when the invariant breaks. Two controls were run:

- **Scenario C concurrency** — replacing the live inbound with `return None` (silent loss)
  makes it fail with `assert len == 2` / `assert 'canli' in ...`. Restoring the ingest makes
  it pass. So it is not a tautology.
- **Scenario N merge (`§P6/N`)** — `mergeWhatsAppMessages` was temporarily replaced with a
  naive "sort and return the incoming page" implementation, i.e. exactly the refresh-wipes-
  pagination bug Scenario N guards against. The harness then fails with
  **`AssertionError: expected 100, got 50`**. Restoring the shipped implementation returns
  it to PASS, and `git diff --stat` confirms the file is byte-identical afterwards.

---

## 4. TEST INFRASTRUCTURE FINDINGS

1. **Cross-layer harness.** `main.py:319` broadcasts exactly the dict returned by
   `ingest_gateway_event`, so the WS layer needs no mock — the return value *is* the
   wire payload. `assert_conversation_consistency()` in the Phase 6 module compares that
   payload against the DB row for `id`, `unread_count`, `last_message_at` and
   `last_message_preview`, and every scenario calls it.

2. **Frontend layer is fed real backend output.** `scratch/p6_dump_ws_payloads.py` runs
   the real ingest path and writes `frontend/scripts/fixtures/phase6-ws-payloads.json`.
   `verify-whatsapp-logic.mjs` loads it and runs the **shipped** mappers
   (`mapConversationItem`, `buildConversationUpdatedPayload`, `resolveUnreadCount`,
   `shouldApplyPreview`) on it — so the React assertion is against a payload the backend
   actually produced.

3. **`processed_events` dedup is PostgreSQL-only.** `ingest_gateway_event` only consults
   it when `dialect.name == "postgresql"`, so replaying an `event_id` on SQLite is *not*
   deduplicated at the event layer. Replay scenarios therefore exercise the entity-layer
   guard (`wa_message_id` / `client_message_id`), which is what holds in production too.
   Documented in the module docstring.

4. **Scratch script polluted the dev DB (self-inflicted).** `p6_dump_ws_payloads.py`
    deleted its tenant using only the dashed UUID form, but `user_id` is
   `Uuid(as_uuid=False)` — SQLite stores the **hex** form. The leftover CONNECTED
   session made owner resolution ambiguous for other modules
   (`bagli tenant sayisi=2`) and broke 12 tests in `test_whatsapp_live.py`. Fixed: the
   script now deletes both forms and children before parents (FK order). After cleaning,
   `test_whatsapp_live.py` = 56/56.

---

## 5. FINAL STATE CONSISTENCY (DB / backend / WS / frontend)

| Field | DB | WS | Frontend | Verdict |
|---|---|---|---|---|
| `unread_count` | authoritative, policy-applied | `conv.unread_count` emitted verbatim | `resolveUnreadCount()` applies it verbatim | **Consistent** in all scenarios; proved end-to-end by `§P6/I` (5 → 0 from a real backend payload). |
| `last_message_at` | authoritative | `conv.last_message_at.isoformat()` | kept unless a newer gateway preview arrives (`shouldApplyPreview`) | **Consistent.** A partial event never blanks it; an older snapshot never rewinds it. |
| `last_message_preview` | authoritative | `_normalize_preview_text(None, conv.last_message_preview)` | replaced only when the gateway preview is newer | **Consistent.** |
| identity / name | `Contact` | canonical `name` + `identity_state` | `mapConversationItem` + `buildConversationUpdatedPayload` (a missing field never becomes `undefined`; explicit `null` stays authoritative) | **Consistent** (Scenario K). |
| message rows | one row per `(conversation_id, wa_message_id)` | serialized message | deduped by id | **Consistent** (Scenarios D, P, Q). |

The only sanctioned transient divergence is **optimistic outbound state**: a row exists
as `PENDING` before the provider confirms. Final state is canonical (Scenarios E, F, P).

---

## 6. RELEASE BLOCKERS

1. **Nothing in Phases 3–6 is committed, let alone deployed.** *(Corrected — earlier phases
   described this as "production is 3 commits behind", which understated it.)*
   Measured 2026-09-19, read-only:
   - Production `/opt/tezlify` is at **`f6ec68d`**; local HEAD is **`f4db4dd`** =
     **2** missing commits (`f4db4dd`, `06f7df1`), not 3.
   - Worse, **33 files are uncommitted locally** (19 modified, 14 new) — that is all of the
     Phase 3, 4, 5 and 6 work. So there is currently **nothing to deploy**: the fixes must be
     committed and pushed first, and only then can `f6ec68d` receive them.
   - Verified absent in production: the C-4 index `uq_msg_conv_wa_message_id`
     (`pg_indexes` lookup returns nothing). Verified present: `uq_conv_user_session_contact_channel`.
   - Production is live and growing: 1832 messages; statuses `RECEIVED 970, SENT 837, READ 23,
     FAILED 2` — the 2 FAILED rows are the P5-1 media sends. All 4 containers healthy.
   No deploy was performed, and none should happen without an explicit instruction.
2. **P5-1 has no live end-to-end confirmation** — one media send to a self-owned number
   after deploy is still required.
3. **The rendered-DOM half of Scenarios G and N is still unverified** — scroll anchoring, the
   new-message pill, and retention of *already-rendered* pagination pages need a DOM/React
   test runtime the repo does not have (no vitest/jest/jsdom). N's backend half and its React
   **state** half both pass. Recommend adding a runtime before the next UI-heavy change.

---

## 7. TEST GATES

| Gate | Result |
|---|---|
| Backend `pytest backend/tests -q` | **1079 passed** (baseline before this phase: 1058; +21) |
| Backend order independence | A→B **75 passed**, B→A **75 passed**, seeds 7/42/1234 **19 passed** each |
| Gateway `test-*.mjs` | **19/19** |
| Frontend `tsc --noEmit` | **0** |
| Frontend `npm run build` | **success** |
| Frontend `verify-whatsapp-logic.mjs` | **40 checks PASS** (was 32; +3 cross-layer unread, +5 pagination/merge) |
| `git diff --check` | **clean** |

---

## 8. Files changed this phase

- `backend/tests/test_whatsapp_phase6_scenarios.py` *(new — 21 scenarios)*
- `backend/app/services/whatsapp/preview_normalization.py` *(P6-1 fix)*
- `frontend/scripts/verify-whatsapp-logic.mjs` *(+3 cross-layer checks)*
- `frontend/scripts/fixtures/phase6-ws-payloads.json` *(new — real backend output)*
- `scratch/p6_dump_ws_payloads.py` *(new — fixture generator)*
- `WHATSAPP_PHASE6_REPORT.md` *(this file)*
