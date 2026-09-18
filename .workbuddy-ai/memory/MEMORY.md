# Tezlify — Project Memory (curated, long-term)

## WhatsApp subsystem — durable invariants discovered during the 2026-09-18 forensic audit

These were **verified against source**, not inferred. Follow them; do not "fix" code that satisfies them.

### 1. Identity: single authority
`resolve_contact_identity()` (in `backend/app/services/whatsapp/identity.py`) is the **only** authority for
display name / phone / identity_state. `NAME_RANK` = `{addressbook:5, verified:4, group_subject:4,
history:3, push:2, phone:1}`.

- `name_source == "push"` means the counterparty's own WhatsApp profile name. It is **not** an address-book
  record and must never become the primary display name of a stranger — show the `+90...` phone instead.
- A push name must never be written into `contact.display_name`. It belongs in
  `custom_attributes["push_name"]` with `custom_attributes["name_source"] = "push"`.
- `_set_contact_name` refuses to overwrite when `current_rank > NAME_RANK["push"]`, and `2 > 2` is False —
  so it cannot clear a push-polluted name either. Guard at the writer, not the setter.

### 2. REST / WebSocket canonical payload contract (the "I-3" class of bug)
Every conversation payload on **both** REST and WS must use the **same field names**:
`session_id, contact_id, lead_id, name, phone, identity_state, is_group, is_archived, avatar_url,
last_message_preview, last_message_at, created_at, updated_at, unread_count, status`.
**Never emit `lead_phone`.**

Frontend side: `mapConversation` must copy a field **only when present** (`!== undefined`), never spread
explicit `undefined` over known state. The merge is `{...existing, ...mapped}` — an explicit `undefined`
in `mapped` **erases** `existing`. This exact chain caused the "Kişi kimliği çözülüyor..." fallback.

### 3. Ordering: `identity != ordering`
Sort key is **activity only**: `last_message_at` → `created_at` → `id` (unique, gives a total order).
Contact existence, identity state, name presence, push name, and phone presence must **never** affect
sorting. An identity resolution changes display only; only a new message changes ordering.
Message-less conversations always sort last.

### 4. History evidence (Phase 17)
`whatsapp_private.history_sync_states.session_id` is **TEXT and holds the gateway UUID**, not the integer
`Conversation.session_id` PK. Resolve it via `_conversation_gateway_id()`.
Invariants: cache hit never mutates evidence; timeout/error evidence is durably committed **before** the
exception is raised; exhaustion is two-step (`EXHAUSTION_CANDIDATE` → `FULLY_EXHAUSTED`); the cursor is
`(wa_message_id, from_me, timestamp_ms)`, never the DB auto-increment id.
**Keep `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED=false`.**

### 5. Truthfulness (AGENTS.md §1.1) is load-bearing in the gateway too
Gateway operations must fail closed. `markConversationRead` may only clear `unread_count` and emit
`conversation_read` **inside the success path**. A failed provider call must never report success.

### 6. `ws_manager.broadcast` parameter name
The parameter is `target_user_id` (**not** `tenant_id`). Passing the wrong kwarg raises `TypeError`, which
is easy to swallow in a broad `except` — never log a broadcast failure at `debug`.

### 7. Test baselines (reproduce these in a clean checkout)
- Backend: **988 passed** (975 baseline at `f6ec68d` + 13 in `test_whatsapp_forensic_fixes.py`).
- Gateway: **16/16** in the `test-*.mjs` loop.
- Frontend: `tsc --noEmit` exit 0; `npm run build` succeeds. There is **no** vitest/jest — see the
  `esbuild-frontend-verification` skill for how frontend logic is actually executed and asserted.

### 8. Known-open items (do not silently "fix" these — they need a decision)
- **New Chat** (`startConversation`) is an unconditional `throw`.
- **Background sweep** sets `FULLY_EXHAUSTED` from a single provider call (`sync.py:1383-1402`) — must be
  corrected before the flag is ever enabled.
- **LID mapping** loads globally with no `WHERE session_id`; scoping semantics are undecided.
- `messages.wa_message_id` has **no** unique constraint (dedup relies on `client_message_id` + logic).
