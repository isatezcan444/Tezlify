# Phase 11.6 — WhatsApp Pure Policy & Identity Extraction Plan

**Document Status**: APPROVED & READY FOR EXECUTION  
**Phase**: 11.6 — WhatsApp Pure Policy & Identity Extraction  
**Baseline Before**: 734/734 Backend PASS, 15/15 Gateway PASS, Frontend Build PASS, 0 Circular Dependencies, Production HEALTHY, `SESSION_MUTATIONS = 0`.

---

## 1. Objectives & Non-Negotiable Invariants

1. **Extract Only Pure Code**:
   - Zero database sessions (`AsyncSession`), zero DB queries, zero mutations.
   - Zero network I/O, zero HTTP/REST calls, zero WebSocket calls.
   - Zero locks (`asyncio.Lock`, `_conversation_locks`).
   - Zero global mutable state containers.
   - Zero dependency on Baileys or gateway session-manager.
2. **Strict Protection**:
   - `whatsapp-gateway/src/session-manager.js`: **DO NOT TOUCH**.
   - `frontend/src/pages/WhatsAppHubPage.tsx`: **DO NOT TOUCH**.
   - `frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx`: **DO NOT TOUCH**.
   - Transaction boundaries, outbox persistence, locking, history sync, and session lifecycle in `whatsapp_service.py`: **DEFERRED**.
3. **100% Backward Compatibility**:
   - All extracted symbols are re-exported from `backend/app/services/whatsapp_service.py` to ensure existing callers, tests, and endpoints continue functioning seamlessly.
4. **Architectural Dependency Direction**:
   $$\text{Pure Policy} \longleftarrow \text{whatsapp\_service.py} \longleftarrow \text{whatsapp endpoints}$$
   Pure policy modules must NEVER import `whatsapp_service.py` (Zero Circular Dependencies).

---

## 2. Extraction Candidate Inventory

Below is the complete evaluation of candidate functions in [whatsapp_service.py](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp_service.py):

| Source Method / Symbol | Source Lines | Responsibility | Dependencies | DB Dep? | Network Dep? | Lock Dep? | Global State? | Target Module | Risk | Decision |
|---|---|---|---|---|---|---|---|---|---|---|
| `jid_to_phone` | 56–78 | JID $\rightarrow$ E.164 phone string conversion | None (pure string) | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `is_degenerate_jid` | 81–92 | Flags system/degenerate JIDs (e.g. `0@s.whatsapp.net`) | None (pure string) | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `is_broadcast_only_jid` | 101–105 | Flags status broadcast and newsletter JIDs | None (pure string) | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `phone_to_jid` | 108–111 | E.164 phone $\rightarrow$ JID string conversion | None (pure string) | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `_is_phone_like` | 123–128 | Checks if value looks like a phone number | None (pure string) | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `_is_raw_jid_name` | 875–887 | Checks if display name leaks raw JID/LID | None (pure string) | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `_contact_phone_for_jid` | 901–911 | Resolves phone or `jid:` sentinel | `jid_to_phone` | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `_safe_display_name` | 890–898 | Strips raw JID display name fallbacks | `_is_raw_jid_name` | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `_NAME_RANK` | 120 | Contact name precedence dictionary | None (dict constant) | NO | NO | NO | NO | `whatsapp.identity` | Very Low | **EXTRACT (Batch 1)** |
| `_advance_message_status` | 2110–2125 | Monotonic delivery rank status decision | `ranks` dict | NO | NO | NO | NO | `whatsapp.status_policy` | Low | **EXTRACT (Batch 2)** |
| `_parse_status` | 214–222 | Parses gateway status string to `SessionStatus` | `SessionStatus` enum | NO | NO | NO | NO | `whatsapp.status_policy` | Low | **EXTRACT (Batch 2)** |
| `_TYPE_PREVIEW_LABELS` | 257–268 | Type to emoji preview label mapping | None (dict constant) | NO | NO | NO | NO | `whatsapp.preview_normalization` | Very Low | **EXTRACT (Batch 3)** |
| `_BRACKET_TYPE_RE` | 270 | Regex for legacy `[IMAGE]` tokens | `re.compile` | NO | NO | NO | NO | `whatsapp.preview_normalization` | Very Low | **EXTRACT (Batch 3)** |
| `_normalize_preview_text` | 273–295 | Generates clean preview text from body/type | `_TYPE_PREVIEW_LABELS` | NO | NO | NO | NO | `whatsapp.preview_normalization` | Very Low | **EXTRACT (Batch 3)** |
| `build_last_message_summary`| 297–326 | Formats group/inbound chat summary | `_normalize_preview_text` | NO | NO | NO | NO | `whatsapp.preview_normalization` | Very Low | **EXTRACT (Batch 3)** |
| `_parse_dt` | 224–232 | Parses ISO-8601 string to naive UTC datetime | `datetime` | NO | NO | NO | NO | `whatsapp.preview_normalization` | Very Low | **EXTRACT (Batch 3)** |
| `_as_naive_utc` | 234–241 | Converts aware datetime to naive UTC | `datetime` | NO | NO | NO | NO | `whatsapp.preview_normalization` | Very Low | **EXTRACT (Batch 3)** |
| `_set_contact_name` | 131–168 | Mutates contact model fields | `Contact` ORM Model | **YES** | NO | NO | NO | N/A | High | **DEFER** (Model Mutator) |
| `_apply_last_message` | 328–345 | Mutates conversation model fields | `Conversation` Model | **YES** | NO | NO | NO | N/A | High | **DEFER** (Model Mutator) |
| `_serialize_message` | 171–196 | Serializes Message ORM model | `Message` Model | **YES** | NO | NO | NO | N/A | Medium | **DEFER** (Model Serializer)|
| `_session_dict` | 198–212 | Serializes WhatsAppSession ORM model | `WhatsAppSession` Model | **YES** | NO | NO | NO | N/A | Medium | **DEFER** (Model Serializer)|
| All 29 Tx Functions | Various | Transaction orchestration | `AsyncSession` | **YES** | **YES** | **YES** | **YES** | N/A | High | **DEFER** (Core Pipeline) |

---

## 3. Batch Execution Plan

### Batch 1: Identity & JID/Phone Normalization
- **New Module**: `backend/app/services/whatsapp/identity.py`
- **Exports**:
  - `jid_to_phone`
  - `phone_to_jid`
  - `is_degenerate_jid`
  - `is_broadcast_only_jid`
  - `is_phone_like` (aliased to `_is_phone_like`)
  - `is_raw_jid_name` (aliased to `_is_raw_jid_name`)
  - `contact_phone_for_jid` (aliased to `_contact_phone_for_jid`)
  - `safe_display_name` (aliased to `_safe_display_name`)
  - `NAME_RANK` (aliased to `_NAME_RANK`)
- **Compatibility**: Re-exported in `backend/app/services/whatsapp_service.py`.
- **Targeted Unit Tests**: `backend/tests/test_whatsapp_pure_identity.py`.

### Batch 2: Message Status & Delivery Policy
- **New Module**: `backend/app/services/whatsapp/status_policy.py`
- **Exports**:
  - `DELIVERY_STATUS_RANKS`
  - `should_advance_status`
  - `resolve_next_delivery_status`
  - `advance_message_status` (pure policy function taking message status, updating timestamp fields or returning new state)
  - `parse_session_status` (aliased to `_parse_status`)
- **Compatibility**: Re-exported in `backend/app/services/whatsapp_service.py`.
- **Targeted Unit Tests**: `backend/tests/test_whatsapp_pure_status_policy.py`.

### Batch 3: Preview & Text Normalization Policy
- **New Module**: `backend/app/services/whatsapp/preview_normalization.py`
- **Exports**:
  - `TYPE_PREVIEW_LABELS`
  - `BRACKET_TYPE_RE`
  - `normalize_preview_text` (aliased to `_normalize_preview_text`)
  - `build_last_message_summary`
  - `should_apply_last_message` (pure timestamp decision)
  - `parse_dt` (aliased to `_parse_dt`)
  - `as_naive_utc` (aliased to `_as_naive_utc`)
- **Compatibility**: Re-exported in `backend/app/services/whatsapp_service.py`.
- **Targeted Unit Tests**: `backend/tests/test_whatsapp_pure_preview.py`.

---

## 4. Verification Protocol for Each Batch
1. `python3 -m compileall backend/app`
2. Run targeted unit test suite.
3. Run full pytest suite (`pytest backend/tests/ -q`) $\rightarrow$ verify 734+ pass.
4. Run circular dependency script $\rightarrow$ verify 0 cycles across Python, TypeScript, and Gateway.
5. Verify production read-only baseline: `SESSION_MUTATIONS = 0`.
