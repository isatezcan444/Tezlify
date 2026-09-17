# Phase 11.5 — WhatsApp Future Extraction Plan & Risk Ranking

**Document Status**: COMPLETE & VERIFIED  
**Phase**: 11.5 — WhatsApp Architecture Preparation & Characterization  
**Scope**: Classification of WhatsApp components by boundary type, ranking of future extraction modules, risk assessment, and recommended phased roadmap.

> [!IMPORTANT]
> **NO EXTRACTION IN PHASE 11.5**:  
> This document specifies the planned sequence for subsequent dedicated refactoring phases (Phase 11.6+). No production logic is extracted or split during Phase 11.5.

---

## 1. Boundary Classification Taxonomy

Every responsibility in the WhatsApp subsystem is classified into one of seven architectural archetypes:

| Classification | Characteristics | Risk Profile | Extraction Strategy |
|---|---|---|---|
| **PURE** | Zero I/O, deterministic input/output, no global state, no database | Very Low | Extract first with exhaustive unit tests |
| **IDENTITY** | JID/LID format conversions, phone normalization, cryptographic hashes | Low | Extract alongside pure policies |
| **UI-BOUND** | React state hooks, DOM scroll sync, audio chimes, modal orchestration | Low-Medium | Extract into custom React hooks in `features/whatsapp/hooks/` |
| **NETWORK-BOUND** | HTTP REST client calls, WebSocket message publishing | Medium | Encapsulate behind typed gateway/broadcaster adapters |
| **DATABASE-BOUND** | SQLAlchemy async queries, CRUD operations without complex transactions | Medium | Encapsulate into focused domain repositories |
| **TRANSACTION-BOUND** | `db.begin()`, `db.begin_nested()` savepoints, `FOR UPDATE SKIP LOCKED` | High | Preserve transaction ownership; do not distribute across services |
| **PROTOCOL-BOUND** | Baileys socket state, Signal pre-keys, NoiseSocket lifecycle | Extreme | Defer to final phase; keep isolated in Node.js gateway |

---

## 2. Extraction Candidates & Risk Matrix

| Rank | Proposed Future Module | Current Location | Boundary Type | Lines | Transaction Dependency | State Dependency | Risk Rating | Target Phase |
|---|---|---|---|---|---|---|---|---|
| **1** | `whatsapp_preview.py` / `policy.py` | `whatsapp_service.py` (L100-300) | **PURE** | ~200 | None | None | **LOW (1/5)** | Phase 11.6 |
| **2** | `whatsapp_identity.py` | `whatsapp_service.py` (L350-650) | **IDENTITY** | ~300 | Read-only contact lookups | None | **LOW (1.5/5)** | Phase 11.6 |
| **3** | `whatsapp_status_policy.py` | `whatsapp_service.py` (L1200-1400) | **PURE** | ~150 | None | None | **LOW (1/5)** | Phase 11.6 |
| **4** | `useWhatsAppMessages.ts` | `WhatsAppHubPage.tsx` (L850-1100) | **UI-BOUND** | ~350 | None | React state (`messagesMap`) | **LOW-MED (2/5)** | Phase 11.6 |
| **5** | `useWhatsAppConversations.ts` | `WhatsAppHubPage.tsx` (L1150-1350) | **UI-BOUND** | ~400 | None | React state (`conversations`) | **LOW-MED (2/5)** | Phase 11.6 |
| **6** | `whatsapp_event_normalizer.py` | `whatsapp_service.py` (L3200-3350) | **PURE / NETWORK** | ~250 | None | None | **MEDIUM (2.5/5)** | Phase 11.7 |
| **7** | `whatsapp_history_service.py` | `whatsapp_service.py` (L2300-2900) | **DATABASE + NETWORK** | ~600 | Multiple commits, background jobs | In-flight sync set | **MEDIUM-HIGH (3.5/5)** | Phase 11.7 |
| **8** | `whatsapp_conversation_service.py`| `whatsapp_service.py` (L1400-2000) | **TRANSACTION-BOUND** | ~600 | Savepoints, race-safe upserts | Conversation locks | **HIGH (4/5)** | Phase 11.8 |
| **9** | `whatsapp_outbound_service.py` | `whatsapp_service.py` (L2000-2300) | **TRANSACTION + NETWORK** | ~400 | Optimistic commit + gateway call | Conversation locks | **HIGH (4/5)** | Phase 11.8 |
| **10** | `whatsapp_session_service.py` | `whatsapp_service.py` (L650-1200) | **DATABASE + NETWORK** | ~550 | Session state commits | In-flight session state | **HIGH (4/5)** | Phase 11.8 |
| **11** | `gateway/socket-manager.js` | `session-manager.js` (L1000-3000) | **PROTOCOL-BOUND** | ~2000 | Distributed leases, signal keys | Baileys socket map | **EXTREME (5/5)** | Phase 11.9+ |

---

## 3. Recommended Phased Refactoring Roadmap

### Phase 11.6: Pure Policies & Frontend Hook Extraction
- **Scope**:
  - Extract pure preview and message text normalization functions into `backend/app/services/whatsapp/preview.py`.
  - Extract status ranking and monotonic transition policy into `backend/app/services/whatsapp/status_policy.py`.
  - Extract JID/LID string normalization and validation into `backend/app/services/whatsapp/identity.py`.
  - Extract message store and conversation list management from `WhatsAppHubPage.tsx` into `features/whatsapp/hooks/useWhatsAppMessageStore.ts` and `useWhatsAppConversations.ts`.
- **Safety**:
  - Zero database schema or transaction changes.
  - Full test suite parity.

### Phase 11.7: Event Normalization & History Sync Boundary
- **Scope**:
  - Extract gateway DTO event normalization into `backend/app/services/whatsapp/event_normalizer.py`.
  - Extract chunked history hydration and background expansion jobs from `whatsapp_service.py` into `backend/app/services/whatsapp/history_sync_service.py`.
- **Safety**:
  - Validated by existing 15 history orchestration integration tests (`test_whatsapp_history_orchestration.py`).

### Phase 11.8: Conversation & Outbound Service Boundary
- **Scope**:
  - Extract conversation race-safe creation, unread counting, and bulk sync into `whatsapp_conversation_service.py`.
  - Extract outbound send logic, client-message-id deduplication, and optimistic persistence into `whatsapp_outbound_service.py`.
  - Extract session QR, pairing, and lifecycle into `whatsapp_session_service.py`.
- **Safety**:
  - Retain `_conversation_locks` in a dedicated `WhatsAppLockRegistry`.

### Phase 11.9: Node.js Gateway Modularization
- **Scope**:
  - Decompose `session-manager.js` (3,032 lines) into:
    1. `src/session/session-registry.js` (In-memory and persisted session tracking)
    2. `src/protocol/socket-lifecycle.js` (Baileys socket creation, event binding, close handlers)
    3. `src/chat/chat-store.js` (In-memory chats/contacts caching and updates)
    4. `src/outbox/outbox-publisher.js` (Integration with `postgres-event-outbox.js`)
- **Safety**:
  - Verified by the 15 gateway test scripts (`test-bounded-cache.mjs`, `test-event-outbox.mjs`, `test-socket-lifecycle.mjs`, etc.).
