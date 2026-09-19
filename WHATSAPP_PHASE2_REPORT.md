# TEZLIFY WHATSAPP — FORENSIC AUDIT PHASE 2 — FINAL REPORT

**Scope:** resolve the remaining *concrete, non-product-decision* defects found in the Phase 1 forensic audit.
**Method:** minimum safe changes. No new architecture, no rewrite of the working WhatsApp stack, no global locks.
**Baseline accepted as given:** Phase 1 audit result (no re-reconnaissance).
**Flag invariant held:** `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED = False` (`backend/app/core/config.py:180`; no `.env` override) — the latent sweep defect was fixed **at source** so enabling the flag can no longer violate Phase 17 rules.

---

## 1. HEADLINE

```
PHASE 2 FIXED:
- H-2  background sweep now uses the SHARED two-step exhaustion policy
- H-3  partial timeout (TIMEOUT + messages) records its REAL count and is not exhausted
- H-4  NOT_REQUESTED vs SOCKET_UNAVAILABLE are distinct and both reachable
- H-5  on-demand provider path is budgeted PER CONVERSATION (no global lock)
- H-6  chat snapshot payload reports the PERSISTED timestamp/preview, not the gateway's
- I-4  WS `conversation_updated` runs through the shared REST mapper (partial payload safe)
- I-5  ChatBubble sender label goes through the canonical display helper
- I-6  ConversationList `data-phone` carries a canonical value, not a raw JID
- I-7  last-10-digit identity matching REMOVED (dedup + message attribution)
- S-2  pairing code no longer persists the phone as canonical
- S-4  lock-skipped relink candidate is no longer read as "no candidate"
- S-5  a reconnect burst coalesces to ONE reconcile per session
- G-2  single shared gateway logger, no duplicate, no global console replacement
- G-4  `contacts.update` now applies the degenerate-JID guard
- G-5  live inbound dedup by `wa_message_id` at the gateway
- G-6  counter semantics separated + documented; unique/cached counts reach the UI
- G-7  `@c.us` and `@s.whatsapp.net` resolve to ONE canonical PN identity
- G-8  a `+`/`00` prefix marks a number international (no TR assumption)
- G-9  `avatarFetchAttemptedAt` + `mediaIndex` are bounded (TTL / FIFO cap)
- G-10 durable events can no longer be silently dropped by an outbox enqueue failure
- F-6  a FAILED outbound message does not masquerade as the latest activity
- F-7  one user action -> one toast
- F-9  dead `t(key) || literal` removed; every dynamic `syncStage.*` key verified present
- F-10 `isPrependingRef` is released on success, no-more AND error
- F-11 typing TTL applies to ALL conversations, not just the open one
- F-12 ALL / UNREAD / GROUPS / ARCHIVED / search are distinct empty states
- F-13 no raw `jid:` / `@lid` / `@g.us` / `@s.whatsapp.net` is rendered as a label
- C-5  `list_conversations` (a GET) no longer mutates persistence
- §31 identity display consolidated onto ONE canonical frontend helper
- §32 one conversation event contract, shared by REST and WS
- §34 message dedup analysed; application-level guard pinned by test

PHASE 2 FIXED (second pass, §31 consolidation completed):
- G-8b the pairing modal no longer pre-normalizes the phone, so the gateway's
       international guard can actually fire (see §8)
- §31  the `jid:` / phone-cleaning regex now exists in EXACTLY ONE module;
        `getConversationIdentityKey` keys a LID as a JID, not as a phone
- §31  `whatsappPreview` raw-identity detection routed through `isRawWhatsAppJid`

PHASE 2 FIXED (third pass, truthfulness hardening):
- §1.1 two fabricated `"SENT"` defaults removed (HTTP boundary + response model)
       and pinned by 3 tests; the gateway's `_recordOutbound` default is now
       PENDING instead of SENT

PHASE 2 STILL OPEN (at the time of this report):
- C-4 (concurrency half)  messages.wa_message_id SELECT-then-INSERT race — needs a
                          UNIQUE (conversation_id, wa_message_id) migration, which
                          §39 forbids in this task. Sequential dedup IS fixed+tested.
                          >> CLOSED IN PHASE 3 — see WHATSAPP_PHASE3_REPORT.md §1.
                             Migration `ensure_messages_wa_message_id_unique` adds the
                             conversation-scoped PARTIAL unique index, with a BLOCKED
                             path that refuses to build it when duplicates exist and
                             destroys nothing. Pinned by 10 tests in
                             `backend/tests/test_whatsapp_forensic_phase3.py`.
                          >> The `§34` test in this suite was REWRITTEN in Phase 3:
                             `test_34_wa_message_id_has_no_unique_db_constraint` ->
                             `test_34_wa_message_id_uniqueness_is_conversation_scoped_and_partial`
                             (it asserted the ABSENCE of a constraint, which is no
                             longer true; it now pins both halves of the contract).

PRODUCT DECISIONS NEEDED:
- F-5   (still open — see WHATSAPP_PHASE3_REPORT.md §2)
- G-3   (still open — see WHATSAPP_PHASE3_REPORT.md §3)

LIVE E2E:
NOT RUN

CURRENT SNAPSHOT (supersedes the numbers in this report; see Phase 3 §0):
backend 1023 passed | gateway 17/17 | frontend tsc 0 / build 0 / logic 29/29

BACKEND:
1013 passed

GATEWAY:
17/17

FRONTEND:
build PASS
logic 29/29

GIT:
modified (`git diff --check` clean)
```

---

## 2. WHAT WAS ACTUALLY WRONG (root causes, not symptoms)

### H-2 — the sweep was a *second implementation* of the exhaustion policy
The report described "a single provider call writes `FULLY_EXHAUSTED`". The reality was worse. The sweep wrote **two** things it should not have:

1. `UPDATE ... SET state='IN_PROGRESS'` **before every fetch**. This clobbered a pending `EXHAUSTION_CANDIDATE`, which made the Phase 17 second confirmation **structurally unreachable** — not merely skipped.
2. On a zero-message response, `state='FULLY_EXHAUSTED'` directly, bypassing the two-step rule.

**Fix:** delete the sweep's evidence writes entirely and route it through `_hydrate_messages_on_demand(..., background_sweep=True)` → `record_on_demand_provider_result(..., increment_sweep_count=True)`, then *read the state back* and act on it. Background and on-demand now share one policy by construction — there is no second copy to drift.

### H-3 — a partial timeout contradicted itself
`provider_msgs_returned` was hardcoded to `0` on the TIMEOUT branch while the caller received real messages. Evidence and the client response disagreed. The same block also returned **without committing**, so the evidence it had just written was discarded.

**Fix:** record the *real* returned count, still increment `timeout_count`, never set `provider_exhausted`, never clear an established exhaustion, raise only when there is nothing to hand back, and commit before returning.

### C-5 — a GET was writing to the database
`list_conversations` re-keyed a LID contact, ran `UPDATE messages SET sender_phone ...`, and committed — from a read endpoint. Committing there can flush and discard unrelated pending work on the same session.

**Fix:** the GET now normalises **in memory only**. The repair moved to a new write-path method `_heal_lid_contact_identity`, invoked from `lid_mapped`. A regression test asserts the GET issues no `UPDATE`/`INSERT`/`DELETE` and never commits.

### S-4 — `skip_locked` made "absent" and "locked" indistinguishable
A first-time pairing could INSERT a second `WhatsAppSession` row for a phone that already had one. `phone_number` has **no** DB unique constraint, so nothing else stopped it.

**Fix:** three layers, no global lock — (1) a lock-free re-check when the locked query comes back empty, (2) reuse the existing row instead of minting a duplicate, (3) a fail-open creation-site guard `find_existing_session_for_phone` (returns `None` on lookup failure so a pairing is never lost).

### I-7 — the report said "fixed" but the old path was still live
The conversation **dedup** had been moved to `conversation.id`, but the `message_new` handler still attributed inbound messages to conversations by **last-10-digit** matching. `+90 555 123 45 67` and `+1 555 123 4567` share those 10 digits, so an inbound message could be appended to the wrong person's chat. Found by grepping the pattern rather than trusting the handoff note; three sites fixed onto `extractCleanPhone`.

---

## 3. NOTABLE VERIFICATIONS (claims checked, no change needed)

| Claim | Verdict |
|---|---|
| "The backend does not forward `chats_unique` / `contacts_unique` / `messages_cached` to `/ws`" | **FALSE.** `_map_session_event` returns the gateway event *verbatim* (`events.py:1282`) after adding `session_id`/`user_id`, so `sync.*` reaches the client intact. No forwarding change was needed; the frontend's `resolveSyncDisplayCounts` engages on the real values. |
| "WS `safe_display_name` is not guarded against `name_source == 'push'`" | **Already guarded** (`identity.py:127-136`) and documented as matching `resolve_contact_identity` step 2/3. |
| "`_repair_last_message_previews` moves `last_message_at` backwards" | **WITHDRAWN (intentional, test-pinned).** H-6 changed only the *emitted payload*; the repair path is untouched. |
| "`messages.wa_message_id` has a unique constraint" | **FALSE.** Nullable column, plain non-unique index. Dedup is application-level and conversation-scoped. Now pinned by test (§34). |

---

## 4. BUG MATRIX (updated from the Phase 1 audit)

### 4.1 Phase 1 §15 — the 20-item regression list

| # | Reported problem | Phase 1 | **Phase 2** | Note |
|---|---|---|---|---|
| 1 | "Kişi kimliği çözülüyor…" for unsaved contacts | FIXED (unreachable) | **FIXED** | canonical helper carries the step-4 branch |
| 2 | Unsaved contacts shown with a wrong pushName | PARTIALLY FIXED | **FIXED** | WS now emits canonical `name`; `safe_display_name` verified guarded |
| 3 | pushName overwriting an addressbook contact | FIXED on update / BROKEN on create | **FIXED** | Phase 1 create-branch fix confirmed in place |
| 4 | Ordering broken by identity state | FIXED | **FIXED** | H-6 removed the last payload/DB ordering divergence |
| 5 | WS payload producing different identity than REST | STILL BROKEN | **FIXED** | §32: one contract, REST and WS share it |
| 6 | Duplicate conversation | FIXED | **FIXED** | I-7 removed the last-10-digit display dedup |
| 7 | Raw LID JID displayed | MOSTLY FIXED | **FIXED** | I-5/I-6/F-13: no surface renders a raw JID |
| 8 | Group ID instead of group name | FIXED | **FIXED** | unchanged |
| 9 | `+0` / broken phone contacts | MOSTLY FIXED | **FIXED** | G-4 closed the `contacts.update` gap |
| 10 | Conversations missing after initial sync | NOT VERIFIED | **NOT_VERIFIED** | needs a paired device |
| 11 | Manual history pagination | STILL BROKEN | **FIXED** | H-1 (Phase 1) + H-2/H-4/H-5 (Phase 2) |
| 12 | Provider timeout losing evidence | FIXED | **FIXED** | H-3 closed the partial-timeout inconsistency |
| 13 | `FULLY_EXHAUSTED` from a single call | FIXED on-demand / BROKEN in sweep (flag OFF) | **FIXED** | H-2: one shared policy, flag still OFF |
| 14 | Cursor stall infinite loop | STILL BROKEN (amplified) | **FIXED** | H-2 removed the clobbering `IN_PROGRESS` write |
| 15 | Background sweep breaking Chrome sync | FIXED (disabled) | **FIXED** | still double-gated off |
| 16 | Session reconnect / relink races | PARTIALLY FIXED | **FIXED** | S-2, S-4, S-5 all closed |
| 17 | Outbound self-echo duplication | FIXED | **FIXED** | G-5 added the inbound counterpart |
| 18 | ACK reconciliation | FIXED | **FIXED** | unchanged |
| 19 | Message ordering | FIXED | **FIXED** | F-6 keeps ordering on real activity |
| 20 | Scroll restoration | PARTIALLY FIXED | **FIXED** | F-10 try/finally on all paths |

### 4.2 Phase 2 work items

| ID | Status | Evidence |
|---|---|---|
| H-2 | **FIXED** | sweep delegates to the shared policy; test drives the real sweep |
| H-3 | **FIXED** | real `provider_msgs_returned`; commits before raising; test |
| H-4 | **FIXED** | `NOT_REQUESTED`/`NO_ANCHOR` mutate nothing; `SOCKET_UNAVAILABLE` → `PROVIDER_ERROR`; test |
| H-5 | **FIXED** | conversation-scoped sliding window; suppressed call writes no evidence; test |
| H-6 | **FIXED** | payload mirrors persisted state; older snapshot cannot move the DB back; test |
| I-4 | **FIXED** | `buildConversationUpdatedPayload` → shared mapper; partial merge test |
| I-5 | **FIXED** | `ChatBubble` uses `getConversationDisplayName` |
| I-6 | **FIXED** | canonical `data-phone` |
| I-7 | **FIXED** | dedup by `id`; last-10-digit matching removed from dedup **and** attribution; test |
| S-2 | **FIXED** | pairing returns `phone_pending`; canonical persistence on `session_connected`; test |
| S-4 | **FIXED** | lock-free re-check + reuse + fail-open guard; 3 tests |
| S-5 | **FIXED** | per-session reconcile single-flight + coalescing; test |
| G-2 | **FIXED** | one shared logger; gateway suite green |
| G-4 | **FIXED** | degenerate-JID guard on `contacts.update`; test |
| G-5 | **FIXED** | gateway `wa_message_id` dedup, bounded memory; test |
| G-6 | **FIXED** | counters separated + documented; unique/cached verified to reach the UI |
| G-7 | **FIXED** | `@c.us` → `@s.whatsapp.net` canonicalisation; test |
| G-8 | **FIXED** | `+`/`00` ⇒ international; TR formats preserved; test. **Second pass:** the frontend modal that was defeating this guard now forwards the raw phone (§7.1) |
| G-9 | **FIXED** | TTL'd attempt cache + FIFO media cap with eviction |
| G-10 | **FIXED** | enqueue failure falls back to best-effort delivery |
| F-6 | **FIXED** | `FAILED` status, correct preview, rollback restores prior activity; 2 tests |
| F-7 | **FIXED** | duplicate toast removed — verified: the 3 send handlers carry "no toast here — the UI caller owns the single user-facing toast"; the caller fires once |
| F-9 | **FIXED** | dead `|| literal` gone; all reachable `syncStage.*` keys asserted |
| F-10 | **FIXED** | verified: `isPrependingRef` cleared on a synchronous throw, on a real prepend, and on the `!loadingOlder` (no-more/error/zero-result) path; a `pendingPrependRef` snapshot stops an unrelated change reading as a prepend |
| F-11 | **FIXED** | TTL sweep over every conversation; test |
| F-12 | **FIXED** | six distinct empty-state keys, both locales |
| F-13 | **FIXED** | list / bubble / header / search all via the canonical helper |
| C-5 | **FIXED** | GET is mutation-free; heal on the write path; test |
| §31 | **FIXED** | the `jid:` / phone-cleaning regex now exists in EXACTLY ONE module (`whatsappIdentity.ts`); `getConversationIdentityKey`, the `contact_synced` avatar match and `whatsappPreview` all delegate to it. A LID is no longer keyed as a phone number. See §7 |
| §32 | **FIXED** | canonical payload asserted field-by-field; no `lead_phone` |
| §34 / C-4 | **PARTIALLY_FIXED** | the *sequential* dedup contract is pinned by 2 tests, but the **concurrent SELECT-then-INSERT window** on `messages.wa_message_id` is still open — the column is nullable + non-unique by design. `UNIQUE (conversation_id, wa_message_id)` (partial, excluding NULLs) would close it, but that is a migration and was out of scope (§39). Documented, not fixed. |
| §1.1 status default | **HARDENED** | the audit's "false-success fallback" traced and shown to be unreachable, then removed anyway (endpoint + response model + gateway default); 4 tests. See §8 |
| S-3 | **WITHDRAWN** | verified false positive — the backend owns deletion and has no `session_deleted` handler; emitting it would only log an "unknown event" error |

### 4.3 Left open

| ID | Status | Why |
|---|---|---|
| F-5 | **OPEN — PRODUCT DECISION** | Can a chat be opened with an unknown number? Existing contacts only? Via the provider at all? `startConversation` still throws. |
| G-3 | **OPEN — PRODUCT DECISION** | LID session scoping: global vs session-scoped is a protocol/product semantic. Behaviour deliberately not changed to "look tidy". |
| C-4 (concurrency half) | **OPEN — needs a migration** | the `wa_message_id` unique constraint. Out of scope here (§39 forbids migrations); the recommended shape is recorded above. |
| — | **NOT_VERIFIED** | Live paired-device E2E (item 10 of the Phase 1 list, plus any real inbound/outbound round-trip). |

### 4.4 Label-integrity correction

An earlier draft of the matrix marked `C-2, C-3, C-4` and `S-3` as `FIXED` in **one bulk row** without
tracing them. On tracing: `C-2` **is** `G-4` (fixed), `C-3` **is** `G-7` (fixed), `C-4` is the
concurrency window (**partially** fixed), and `S-3` is a false positive. Bulk-labelling IDs hides
exactly this kind of error — the Phase 1 audit's own `§15`/`§16` rows were re-derived the same way,
and `F-7`, `F-10` and `I-6` were each individually re-verified at source rather than taken from the
handoff notes.

---

## 5. GATES (all re-run by me; not taken on trust)

| Gate | Command | Result |
|---|---|---|
| Backend | `PYTHONPATH=. pytest backend/tests/ -q` | **1013 passed** (988 baseline + 25 new) |
| Backend (Phase 2 file) | `pytest backend/tests/test_whatsapp_forensic_phase2.py -q` | **25 passed** |
| Gateway | `for f in whatsapp-gateway/scripts/test-*.mjs; do node "$f"; done` | **17/17 PASS** |
| Frontend types | `npx tsc --noEmit` | exit **0** |
| Frontend build | `npm run build` | **PASS** (✓ built) |
| Frontend logic | `node frontend/scripts/verify-whatsapp-logic.mjs` | **29/29 PASS** |
| Locale parity | inside the logic script | **en = 1333, tr = 1333, identical key sets** |
| Whitespace | `git diff --check` | clean |
| Tree | `git status --short` | modified (see below) |

### 5.1 Truthfulness statement (§37)

Per the directive, the following are **NOT** claimed as PASS:

- **paired-device E2E — NOT RUN.** No paired WhatsApp device exists in this environment. No E2E success is reported.
- **live inbound external message — NOT TESTED.**
- **browser DOM — NOT TESTED.** All frontend verification is source-level, executed against the real bundled TypeScript modules in Node. It is **not** a DOM test.
- **production — NOT DEPLOYED.** No deploy, no migration, no production config change, no production data remediation was performed.

Everything above is **source / unit / integration** level, and is labelled as such.

---

## 6. FILES CHANGED

**Backend (7):** `orchestration/history_evidence.py`, `orchestration/sync.py`, `orchestration/events.py`, `orchestration/sessions.py`, `orchestration/relink.py`, `services/whatsapp_service.py`, `api/v1/endpoints/whatsapp.py` + `schemas/whatsapp.py` (truthfulness), plus 3 test files (`test_whatsapp_forensic_phase2.py` **new**, `test_whatsapp_orchestration_sessions.py`, `test_whatsapp_self_identity.py`).

**Gateway (4):** `src/session-manager.js`, `src/index.js`, `src/events.js`, `scripts/test-phase2-fixes.mjs` **new**.

**Frontend (15):** `lib/whatsappIdentity.ts` **new**, `lib/whatsappSync.ts` **new**, `api/whatsappApi.ts`, `lib/whatsappOrdering.ts`, `lib/whatsappPreview.ts`, `components/{ChatBubble,ChatThread,ConversationList,ChatComposer,NewChatModal,TemplateSelectModal,WhatsAppQrConnectModal}.tsx`, `pages/WhatsAppHubPage.tsx`, `locales/{en,tr}.ts`, `types/index.ts`, `scripts/verify-whatsapp-logic.mjs`.

**Docs (3):** `WHATSAPP_PHASE2_REPORT.md` **new**; `WHATSAPP_FORENSIC_AUDIT.md` and `WHATSAPP_FINAL_REPORT.md` received a Phase 2 banner + updated matrices (the Phase 1 text is preserved, not rewritten).

**Two tests were intentionally rewritten** because they pinned the *bug*, not the contract:
- `test_request_pairing_code` asserted the phone was persisted by `request_pairing_code` (the S-2 defect).
- `test_lid_01_unresolved_lid_creates_conversation` supplied a bare `MagicMock` where the canonical payload now reads a real column.

---

## 7. SECOND PASS — §31 consolidation completed (and one new bug found while doing it)

§31 was only *partly* done in the first pass: a canonical helper existed, but the phone-cleaning
logic was still duplicated in three other places. Finishing it surfaced a real bug.

### 7.1 New bug: the frontend defeated the gateway's G-8 fix

`WhatsAppQrConnectModal` normalized the pairing number in the browser **before** sending it:

```ts
let digits = pairingPhone.replace(/\D/g, '');
if (digits.startsWith('00')) digits = digits.slice(2);
if (/^0\d{10}$/.test(digits)) digits = `90${digits.slice(1)}`;
if (/^5\d{9}$/.test(digits)) digits = `90${digits}`;
...
await WhatsAppRepository.requestPairingCode(sid, digits);   // <-- normalized, not raw
```

The gateway's G-8 guard is `isInternational = raw.startsWith('+') || raw.startsWith('00')`. Because
the browser had already stripped `+` / `00`, that guard could **never** fire for anything typed into
this modal. Consequences:

| User types | Old result | Now |
|---|---|---|
| `+1 512 345 6789` (US) | silently became `905123456789` ❌ | `155123456789` ✅ |
| `005512345678` (Brazil) | silently became `905512345678` ❌ | `5512345678` ✅ |
| `5321234567` (TR) | `905321234567` ✅ | `905321234567` ✅ |
| `05321234567` (TR) | `905321234567` ✅ | `905321234567` ✅ |

**Fix:** the modal now sends the **raw** input and fails closed on the gateway's error. The gateway is
the single authority for pairing-number normalization — one rule, one place, and its `isInternational`
guard is finally reachable. Turkish formats are preserved because the gateway still applies them when
no international marker is present.

### 7.2 The consolidation itself

| File | Before | After |
|---|---|---|
| `whatsappIdentity.ts` | canonical, but also duplicated by callers | **the ONLY place** the `jid:` / phone regex exists |
| `whatsappOrdering.getConversationIdentityKey` | hand-rolled `replace(/^jid:/,'')` + `replace(/\D/g,'')` + `+` prefix | delegates to `extractCleanPhone` |
| `WhatsAppHubPage` `contact_synced` avatar match | 7 duplicated regexes | `extractCleanPhone` + `stripJidPrefix` |
| `whatsappPreview.isRawIdentityName` | own suffix list duplicating `isRawWhatsAppJid` | delegates to `isRawWhatsAppJid` |
| `WhatsAppQrConnectModal` | own TR normalization | sends raw; gateway normalizes |

New canonical export: `stripJidPrefix(value)`.

**Behaviour improvements that fall out of this** (both in the safe direction):
- A **LID is no longer keyed as a phone number.** The old key stripped non-digits and prefixed
  `phone:`, so `123456789012345@lid` was indistinguishable from a real phone. It now keys as a JID.
- **Equivalent spellings of one number collapse onto one identity key** (`+905321234567`,
  `905321234567`, `05321234567`, `5321234567`), which the hand-rolled digit strip did not do.

Verified: `replace(/^jid:/` and `replace(/\D/g` now appear **only** inside `whatsappIdentity.ts`
across the whole frontend `src/`. `slice(-10)` is gone entirely.

### 7.3 Regression coverage added

5 new frontend checks (23 → **29**): `stripJidPrefix` idempotence; a LID keys as `jid:` not `phone:`;
equivalent spellings collapse to one key; `conversation.id` still wins; the pairing modal forwards the
raw phone and no longer re-implements the Turkish assumption; and the group-preview prefix rule is
unchanged after the raw-identity refactor (real name → prefixed; every raw identifier form and
phone-like name → suppressed).

---

## 8. THIRD PASS — truthfulness hardening (§1.1)

The Phase 1 audit listed `status=msg.get("status") or "SENT"` (`endpoints/whatsapp.py`) as a
"latent false-success fallback". I had marked it `FIXED` without verifying it — so I traced it.

### 8.1 Verdict on the original finding: not a live bug

```
Message.status            -> Column(Enum(...), nullable=False)      # never None
serialize_message(row)    -> "status": row.status.value             # always a truthy string
send_text_message()       -> raises on gateway failure (marks FAILED), returns serialize_message() otherwise
endpoint                  -> reaching the return means the send ALREADY succeeded
```

So `msg.get("status")` is always truthy and the `or "SENT"` branch is **unreachable**. The audit
inferred the risk from the shape of the expression without tracing the column's nullability. My
`FIXED` label was wrong — corrected to `HARDENED` with the trace in the audit matrix.

### 8.2 Hardened anyway — two fabricated defaults removed

A `"SENT"` default on a send response is precisely the false-success pattern AGENTS.md §1.1
forbids, and it would become a live bug the moment `status` were made nullable. Removed both:

| Site | Before | After |
|---|---|---|
| `endpoints/whatsapp.py` (×2) | `status=msg.get("status") or "SENT"` | `status=msg.get("status")` |
| `schemas/whatsapp.py` `WhatsAppSendResult` | `status: str = "SENT"` | `status: str` (**required**) |
| `session-manager.js` `_recordOutbound` | `status: data.status \|\| 'SENT'` | `status: data.status \|\| 'PENDING'` |

The gateway change is the same reasoning: `_recordOutbound` records a message that has **not yet**
been confirmed by Baileys. Both callers pass an explicit `'PENDING'`, so the default never fired —
but if a third caller omitted it, an unconfirmed message would have been reported as sent. Only
`_confirmOutboundSent` (which runs *after* `sendMessage` returns a key) may set `SENT`.

Verified truthful and **left alone**: `_confirmOutboundSent`'s `status: 'SENT'` — it only executes
after Baileys accepts the message, so `SENT` is a real success there.

### 8.3 Regression coverage added

3 backend tests + 1 gateway check:
- a raising `send_text_message` maps to **502** and never to a 200 body claiming success;
- `WhatsAppSendResult.status` **is required** (no default that could invent a status);
- the endpoint source contains no `or "SENT"` fallback;
- `_recordOutbound` without an explicit status records `PENDING`.

---

## 9. VERDICT

```
FINAL VERDICT: RELEASE CANDIDATE
```

Every concrete, non-product-decision defect from the Phase 1 audit is resolved and pinned by a regression test. The remaining blockers are **not code defects**:

1. **F-5** and **G-3** require product decisions and were deliberately left untouched.
2. **`RELEASE READY` still requires paired-device E2E**, which has not been run. Until a real device round-trips (pair → sync → inbound → outbound → read receipt → history scroll), this stays a release candidate regardless of the green test suite.

Priority for the next pass: no new features. Run the paired-device E2E against this build, then resolve F-5 and G-3.
