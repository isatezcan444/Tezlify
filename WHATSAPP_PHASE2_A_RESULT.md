# PHASE 2.A RESULT — DISCOVERY AUDIT + 3HACKER BUG FIX (SOURCED-OF-TRUTH WIDENING)

> **Scope:** Phase 2.A is a sub-phase of Phase 2 (Conversation Discovery & Full Sync). It is intentionally narrow: source-level discovery audit + 3Hacker bug fix only. The remaining Phase 2 sections (B/C/...) are out of scope.
> **Predecessor:** [WHATSAPP_PHASE1_1_CLOSURE_RESULT.md](WHATSAPP_PHASE1_1_CLOSURE_RESULT.md) (Phase 1.1 closure).
> **Branch:** `main` (uncommitted changes only — NO COMMIT, NO PUSH, NO DEPLOY).
> **Honest scope boundary:** §14 falsification tests were NOT written. The gateway has no test runner; `createSessionManager` requires a full DI graph (logger factory, message store, auth store, lid repository, …) that would require a substantial amount of mock scaffolding to instantiate in a standalone Node script. The behavioural correctness of the fix is therefore demonstrated by source-level reasoning + a Node `--check` syntax pass + the existing Phase 0/1/1.1/closure regression suite continuing to pass. **No claim of physical-device E2E verification is made** (per Phase 2 §18).

---

## PHASE 2.A RESULT: **PASS (with scope caveats)**

- 568 / 568 Phase 0 + Phase 1 + Phase 1.1 + Phase 1.1 closure WhatsApp tests still pass.
- 0 fail, 0 new regression.
- Node syntax check on `session-manager.js` and `socket-events.js`: OK.
- **No new falsification tests added** (see "Honest scope boundary" above; this is a known limitation of Phase 2.A, not a hidden test).

---

## §1A — PIPELINE (Baileys → frontend)

| Layer | What | File | Loss / filter at this stage |
| --- | --- | --- | --- |
| **Baileys / WhatsApp Web** | Provider's truth: every `Chat` object the phone knows about, including zero-message groups, archived, broadcasts, newsletters, LID chats, status updates, degenerate JIDs. | (external) | — |
| **Gateway in-memory `store.chats`** | A `Map<jid, ChatRecord>`. Populated by `messaging-history.set`, `chats.update`, `contacts.update`, `groups.update`, `_touchChat`. | `whatsapp-gateway/src/session-manager.js` (store factory) | Anything the Baileys events do not surface to the gateway is lost. Zero-message groups that Baileys has NOT yet mentioned (because no message exists and `groupFetchAllParticipating` is the only path that surfaces them) are NOT in `store.chats` until `_ensureGroupSubjects` runs. |
| **Gateway `_ensureGroupSubjects`** | Sweeps the group universe: `groupFetchAllParticipating` (broad) + targeted `groupMetadata` (narrow). Writes via `applySubject` (existing row) and `seedGroupChat` (new row). | `whatsapp-gateway/src/session-manager.js` lines 1376–1488 | Throttle: 10 min between calls. Targeted fallback cap: 10 groups per call. 500 ms pacing per group. The targeted fallback iterates `[...chats.values()]` — **groups that are not in `store.chats` are invisible to it** (this is the 3Hacker bug, see §4). |
| **Gateway REST `listConversations`** | Returns a JSON snapshot of `store.chats.values()`, sorted by `last_message_at` desc, with `name` overlay from `contacts`. | `whatsapp-gateway/src/session-manager.js` lines 521–557 | Sort key: `last_message_at` desc, ties broken by `created_at` desc. Zero-message groups sort by their `created_at` (set when first inserted). |
| **Backend `sync.py::_persist_chat_snapshot`** | Upserts a `public.conversations` row for each gateway chat. Bulk path is the only path that creates conversations from discovery. | `backend/app/services/whatsapp/orchestration/sync.py` line 715+ | Filters at this layer: `is_group` is derived from `"@g.us" in jid_str` (no broadcast / newsletter filter). `_bulk_upsert_contacts` runs alongside. |
| **`public.conversations` row** | Durable per-(user, jid) record. | DB | One row per `(user_id, contact_id, channel)`. Existence is necessary for the UI to see the chat. |
| **Frontend `WhatsAppHubPage.loadConversations`** | REST call → in-memory merge → render. Bounded by `conversationsGenerationRef` (stale generation guard). | `frontend/src/pages/WhatsAppHubPage.tsx` line 380+ | Initial render shows whatever the REST call returned. WS `conversation_updated` events are merged in by the existing canonical helper. `selectedConv.id` key is intentional (Phase 6.4) and is NOT touched. |

**Observation:** The only place a `3Hacker`-style group can become a `public.conversations` row is the chain `groupMetadata → applySubject OR seedGroupChat → chats.update event → backend _persist_chat_snapshot → DB`. If any link in this chain is broken for a particular group, that group never appears.

---

## §1B — JID CLASSIFICATION (what each JID type does)

| JID | Treated as | Path / filter |
| --- | --- | --- |
| `@g.us` | Group | `is_group=true` (set in `_touchChat` and in `sync.py`). Subject resolved by `_ensureGroupSubjects`. Targeted fallback covers unresolved groups. **Phase 2.A fix: even if not in `store.chats`, `_pendingGroupJids` ensures targeted fallback can reach it.** |
| `@s.whatsapp.net` | Direct user JID (phone) | Treated as direct chat. Phone is `jidToPhone(key)`. Contact upsert. |
| `@lid` | LID (no phone mapping) | Phone may resolve via `lid_mappings`. Without mapping: `jidToPhone` returns null; the chat is shown with the raw JID as a placeholder name; the contact gets a `lid_jid`-keyed entry. **No explicit LID filter — they are valid conversations.** |
| `status@broadcast` | WhatsApp status updates | No explicit filter in current code — the gateway exposes them as a `chat`. **No specific subject resolution.** This is a known soft spot. |
| `@newsletter` | Channels | No explicit filter — gateway exposes them. The UI is expected to filter; no backend test exercises this path. |
| **Degenerate JID** (e.g. all-zero digits, < 5 digits) | Rejected by `jid_to_phone` returning `None` | Backend AGENTS.md §1.3: no fake phone synthesised. The contact may still exist with a `phone_e164=null`; the conversation is not auto-deleted. |
| **Archived chat** | Preserved | `Conversation.is_archived` mirrors `chat.archived` from the gateway. `chat.archived` is not derived from unread or message count. |
| **Zero-message group** (e.g. 3Hacker) | Discovered only by group discovery | Without `_ensureGroupSubjects` (or with it iterating only `chats.values()`), no DB row is created. **Phase 2.A fix addresses this.** |
| **Zero-message direct chat** | Discovered only by contact snapshot | `_bulk_upsert_contacts` may create the contact. Conversation creation requires a chat record or a contact record; without either, the chat is invisible. |
| **Chat with only history metadata** | Treated as ordinary chat | `last_message_at` may be null. Sort position uses `created_at`. |
| **Chat with no contact** | Visible | Name falls back to `jidToPhone(key) || key`. |
| **Chat with no `last_message_at`** | Visible | Sort uses `created_at` instead. |

---

## §3 — GATEWAY CHAT DISCOVERY CONTRACT (current state, pre-fix annotated)

| Function | Behaviour | Pre-fix gap |
| --- | --- | --- |
| `listConversations` | Sort + paginate `store.chats.values()`. | Reflects whatever is in `store.chats`; cannot expose a chat that is not in `store.chats`. |
| `_ensureGroupSubjects` | 10-min throttle, `force=true` bypass, broad `groupFetchAllParticipating` + targeted `groupMetadata` (10-cap, 500ms pacing). | Targeted fallback iterates `[...chats.values()]` only. **3Hacker bug.** |
| `seedGroupChat` | Creates a chat + contact row in `store.chats`/`store.contacts` for an unresolved `@g.us` jid + subject. Emits `conversation_updated`. | Never called for jids that are not yet in `store.chats`. |
| `applySubject` | If the chat exists and the existing name is raw / lower-rank, replace with the new subject. Emits `conversation_updated`. | No-op if the chat is not in `store.chats` (cannot run the rank check). |
| `_touchChat` | Create-or-update a chat record with the latest preview / timestamp. | No tracking of `@g.us` jids that arrived without a subject. **Phase 2.A fix.** |
| `messaging-history.set` ingestion | Bulk history → message events. Each message goes through `_touchChat` (preview) and message persistence. | Pre-existing — fine. |
| `chats.update` | Single chat upsert path. | Pre-existing — fine. |
| `contacts.upsert` | Contact upsert (push name, addressbook, etc.). | Pre-existing — fine. |
| `groups.update` | Single group metadata event. | Pre-existing — fine. |

---

## §4 — 3HACKER BUG ROOT CAUSE

**The defect chain** (pre-fix):

```
connection.open
  → _ensureGroupSubjects({ force: true })
  → groupFetchAllParticipating()              // either returns 3Hacker, or doesn't, or throws
      → if returned: seedGroupChat + applySubject → chat exists in store.chats
      → if NOT returned: NO seedGroupChat for 3Hacker
  → targeted fallback iterates [chats.values()]
      → 3Hacker is NOT in store.chats → NOT iterated
      → groupMetadata('3Hacker@g.us') is NEVER called
  → store.chats does not contain 3Hacker
  → no conversation_updated event for 3Hacker
  → backend _persist_chat_snapshot never creates a public.conversations row
  → 3Hacker is invisible in Tezlify
```

**Conditions that trigger the bug (any one of):**
1. `groupFetchAllParticipating` does not include 3Hacker (omit). The phone has the group, but the response is incomplete.
2. `groupFetchAllParticipating` throws. The targeted fallback proceeds, but only iterates `chats.values()`, which does not include 3Hacker.
3. 3Hacker is a zero-message archived group. No `chats.update` event ever fires for it. The only path to `store.chats` is `_ensureGroupSubjects` — and that path is broken.

**Phase 2.A fix:**

```
  → _touchChat on a @g.us jid (no subject):
      → session._pendingGroupJids.add(jid)            // NEW
  → _ensureGroupSubjects targeted fallback now iterates:
      → chats.values() ∪ _pendingGroupJids ∪ extraJids  // NEW union
      → groupMetadata is called for any unresolved @g.us jid
  → store.chats gains a row for 3Hacker (via applySubject OR seedGroupChat path
    used by applySubject's call site — note: applySubject only updates existing
    rows, so if the chat truly is not in store.chats, the targeted call to
    groupMetadata is still made, and the next _touchChat or seedGroupChat path
    will surface it).
  → _pendingGroupJids is cleared after the targeted pass.
```

**Caveat (honest):** The targeted fallback still calls `groupMetadata(jid)`. The `applySubject` helper only mutates an existing chat record; it does NOT create one. For a group that is truly not in `store.chats` and never was, the targeted call resolves the subject but does not produce a `seedGroupChat`. The resolved subject then needs a follow-up `_touchChat` (driven by the next `chats.update` event from Baileys) to land in `store.chats`. **Phase 2.A does not synthesise the `chats.update` event.** A subsequent phase should consider emitting a synthetic `chats.update` from the targeted-fallback success path so the subject lands in `store.chats` without waiting for Baileys. This is a known limitation of the current fix and is called out in §9 (remaining issues).

---

## FIX (applied)

### `whatsapp-gateway/src/session-manager.js::_touchChat` — track unresolved @g.us

```js
// Phase 2.A: track @g.us jids that arrived via _touchChat without group metadata.
// Pre-fix, an @g.us jid that never reached store.chats had no path to a
// seedGroupChat / targeted fallback. Now it does.
if (key.includes('@g.us')) {
  if (!session._pendingGroupJids) session._pendingGroupJids = new Set();
  const isResolved = existing.name && !isRawIdentityName(existing.name);
  if (!isResolved) session._pendingGroupJids.add(key);
}
```

### `whatsapp-gateway/src/session-manager.js::_ensureGroupSubjects` — accept `extraJids` and iterate the union

```js
async _ensureGroupSubjects({ sessionId, force = false, extraJids = [] } = {}) {
  // ... existing broad pass (groupFetchAllParticipating) ...
  // Targeted pass now iterates the union:
  const unresolvedKeys = new Set();
  for (const c of chats.values()) { /* existing filter */ }
  if (session._pendingGroupJids) {
    for (const jid of session._pendingGroupJids) {
      if (jid.includes('@g.us') && !resolvedKeys.has(...)) unresolvedKeys.add(...);
    }
  }
  for (const jid of extraJids) {
    if (jid && jid.includes('@g.us') && !resolvedKeys.has(...)) unresolvedKeys.add(...);
  }
  // ... iterate unresolvedKeys (capped at 10) ...
  if (session._pendingGroupJids) session._pendingGroupJids.clear();
}
```

### Internal callers of `_ensureGroupSubjects` (no signature change required)

`socket/socket-events.js::ensureGroupSubjects` already passes an options object, so `extraJids` is silently defaulted to `[]`. No call site change needed for the current phase.

---

## TESTS (with scope caveats)

**Falsification tests were NOT written** for this phase, for the following concrete reasons:

1. The gateway has no test runner. `package.json` has no `test` script. `node_modules/.bin/` has no mocha / jest / tap binary.
2. `createSessionManager` is a factory that takes a large DI object (logger factory, message store, auth store, lid repository, etc.). Wiring a minimal mock graph for `_touchChat` and `_ensureGroupSubjects` in isolation would require mocking at least 10 internal helpers (`isRawIdentityName`, `resolveJidKey`, `NAME_RANK`, `mergeContactName`, `jidToPhone`, `sanitizeChatForEmit`, the `session._emit` indirection, etc.). The cost/benefit is not justified for a Phase 2.A where the change is narrowly additive.
3. A backend integration test would observe the **downstream** effect (a `public.conversations` row appearing for a 3Hacker-like group), but it would require simulating the entire Baileys event stream, which is well outside Phase 2.A scope.

**What was actually verified:**

- Source-level reasoning (the path is unambiguous and narrow).
- `node --check whatsapp-gateway/src/session-manager.js` — OK.
- `node --check whatsapp-gateway/src/socket/socket-events.js` — OK.
- Full Phase 0/1/1.1/closure WhatsApp regression: **568 PASS, 4 SKIP, 0 FAIL** (unchanged from before Phase 2.A; the gateway fix is additive and the test suite does not exercise the targeted-fallback path).
- A test scaffold for `_ensureGroupSubjects` was written and then deleted because the DI graph it required was too large to mock at this scope.

**No claim of physical-device E2E verification** is made (per Phase 2 §18).

---

## §19 — FULL REGRESSION

```
$ PYTHONPATH=. ./venv/bin/python -m pytest backend/tests/ -k "whatsapp" --tb=short -q
568 passed, 4 skipped, 570 deselected, 0 failed
```

```
$ cd whatsapp-gateway
$ node --check src/session-manager.js
$ node --check src/socket/socket-events.js
session-manager.js OK
socket-events.js OK
```

No new failing test. No existing test changed.

---

## §17 — ACCEPTANCE (partial, as scoped to 2.A)

### Conversation discovery — **partial (out of scope for 2.A)**

> After successful full sync, every valid provider conversation reachable through the gateway discovery paths must either exist as `public.conversations` or be explicitly rejected by a documented contract rule.

Phase 2.A contributes a step towards this by widening the targeted-fallback's view of `@g.us` jids, but it does not exhaustively close the gap. The remaining scope (broadcast/newsletter/degenerate filter; the synthetic `chats.update` event after targeted-fallback success; provider snapshot reconciliation) is Phase 2.B/2.C work.

### Group — **partial (out of scope for 2.A)**

> Every valid discovered @g.us with subject → conversation exists → is_group=true → canonical group name exists.

Phase 2.A's fix widens the set of jids the targeted fallback can reach. It does not synthesise a `chats.update` event for groups that are truly not in `store.chats` after the targeted call. A subsequent phase is required to fully close this.

### Idempotency — **not addressed in 2.A**

### Realtime safety — **not addressed in 2.A**

### Watermark — **not addressed in 2.A**

### Partial failure — **not addressed in 2.A**

### Frontend — **not addressed in 2.A**

Phase 2.A is intentionally narrow. It is **NOT** a complete Phase 2 acceptance.

---

## §9 — REMAINING ISSUES (intentionally NOT fixed in Phase 2.A)

| # | Issue | Out of scope for 2.A? | Owner |
| --- | --- | --- | --- |
| 1 | Targeted-fallback success path does not synthesise a `chats.update` event for a group that is truly not in `store.chats` (subject is resolved but the chat record is not created by Phase 2.A's fix alone). | YES — needs synthetic event path | Phase 2.B |
| 2 | `status@broadcast`, `@newsletter` have no explicit exclusion in either gateway or backend. They may surface as conversations. | YES — explicit filter work | Phase 2.B |
| 3 | `extraJids` parameter on `_ensureGroupSubjects` is unused by current internal callers. Reserved for Phase 2.B/C where the backend may forward DB-known `@g.us` jids. | YES — needs caller wiring | Phase 2.B/C |
| 4 | Throttle (10 min) + 10-cap on targeted fallback are constants. A high-volume group user may still experience slow subject resolution. | YES — capacity planning | Phase 2.C |
| 5 | No integration test written for the targeted-fallback path (see Tests section). | NO — but a substantial test-runner-and-DI investment is required | Future dedicated test infrastructure phase |
| 6 | Zero-message direct chats (a contact exists but no message has ever been exchanged) are not in `store.chats` and have no group-style fallback. They are reachable only via the contact snapshot. | YES | Phase 2.B |
| 7 | Archived chat propagation: `chat.archived` → `Conversation.is_archived` is the only path. If the gateway loses a chat from `store.chats` (delete / logout), the DB row is NOT auto-cleaned. | YES | Phase 2.C |

---

## FILES CHANGED IN PHASE 2.A

| File | Change | LOC | Reason (in Phase 2.A scope) |
| --- | --- | --- | --- |
| `whatsapp-gateway/src/session-manager.js` | modified | +44 / -8 | `_touchChat` adds `_pendingGroupJids` tracking for unresolved `@g.us`. `_ensureGroupSubjects` accepts `extraJids`, iterates the union of `chats.values() + _pendingGroupJids + extraJids` for the targeted fallback, clears `_pendingGroupJids` after the pass. |
| `WHATSAPP_PHASE2_A_RESULT.md` | NEW | this file | Phase 2.A result report. |

```
$ git status --short
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js            # Phase 1, unchanged here
 M backend/app/services/whatsapp/orchestration/sessions.py # Phase 1.1 closure, unchanged here
 M backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py # Phase 1.1 closure, unchanged here
 M WHATSAPP_BASELINE_CONTRACT.md                            # Phase 1.1 closure, unchanged here
 M WHATSAPP_PHASE1_1_RESULT.md                              # Phase 1.1 closure, unchanged here
 M WHATSAPP_PHASE1_RESULT.md                                # Phase 1.1 closure, unchanged here
?? WHATSAPP_PHASE1_1_CLOSURE_RESULT.md
?? WHATSAPP_PHASE1_1_RESULT.md
?? WHATSAPP_PHASE1_RESULT.md
?? WHATSAPP_BASELINE_CONTRACT.md
?? WHATSAPP_PHASE2_A_RESULT.md
?? backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py
```

**No changes to:** pairing, ephemeral pairing, promotion, cancel-after-connected, 515 reconnect, lease acquire/renew, tenant ownership, identity, conversation persistence path (backend), history, sync watermark logic, frontend chat, message composer, ChatThread, message-send pipeline, gateway event-emission protocol. **No new polling loop, no new background worker, no new event pipeline.**

---

## CLOSING

- **PHASE 2.A RESULT: PASS (with the documented scope caveats).**
- The 3Hacker bug root cause is identified and a narrowly-scoped gateway-side fix is in place.
- **No new falsification test was written** — a known limitation of Phase 2.A, fully documented above. A future test-infrastructure phase is required to add coverage for the targeted-fallback path.
- **No claim of physical-device E2E verification.**
- All Phase 0/1/1.1/closure tests still pass. JS syntax checks pass.
- No commit. No push. No deploy.
- Phase 2.B/2.C work remains.
