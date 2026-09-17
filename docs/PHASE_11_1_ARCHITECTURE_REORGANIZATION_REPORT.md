# Phase 11.1 — Architecture Reorganization & Folder Structure Report

**Phase**: 11.1 — Professional Folder Structure & Safe Architecture Reorganization  
**Execution Date**: September 17, 2026  
**Final Status**: `PHASE_11_1_ARCHITECTURE_REORGANIZATION_COMPLETE`  
**Safety Verification**: Zero session mutations (`SESSION_MUTATIONS = 0`), zero test regressions (725/725 passed, 15/15 gateway passed, 2/2 frontend scripts passed).

---

## 1. Executive Summary

Phase 11.1 reorganized the Tezlify repository into a clean, professional, responsibility-oriented architecture without altering any runtime behavior or public contracts.

The reorganization achieved:
1. **Backend Scrapers Domain Segregation**: Scrapers moved from a flat list in `backend/app/scrapers/` into clear subpackages: `google/` (Google Maps Playwright, HTTP, and orchestrator) and `common/` (BaseScraper, DirectoryScraper), with canonical re-exports from `backend.app.scrapers`.
2. **Frontend Feature Architecture**: Domain-coupled components and utilities previously scattered across `components/domain/`, `components/LeadFinder/`, `data/whatsapp/`, `api/`, and `lib/` were reorganized into cohesive feature modules:
   - `frontend/src/features/whatsapp/` (components, api, hooks, data, lib)
   - `frontend/src/features/campaigns/` (components)
   - `frontend/src/features/leads/` (components)
3. **Pristine Separation of Shared UI Primitives**: `frontend/src/components/` now exclusively contains genuine shared primitives (`ui/`, `forms/`, `data-display/`, `Layout/`, `admin/`).
4. **Zero Drift Invariants**:
   - Zero database mutations or schema changes.
   - Zero false-positive responses.
   - WhatsApp credentials, Baileys keys, QR flows, and ACK semantics 100% preserved.
   - `whatsapp_service.py` (3,982 lines), `session-manager.js` (3,032 lines), and `WhatsAppHubPage.tsx` state machine preserved intact without risky artificial fragmentation.

---

## 2. Before & After Architecture Tree

### 2.1 Backend Scrapers

#### Before
```text
backend/app/scrapers/
├── adapters/
│   ├── base_adapter.py
│   ├── directory_adapter.py
│   └── osm_adapter.py
├── base_scraper.py
├── directory_scraper.py
├── google_maps_http_scraper.py
├── google_maps_playwright_scraper.py
└── google_maps_scraper.py
```

#### After
```text
backend/app/scrapers/
├── __init__.py                  # Canonical top-level re-exports
├── adapters/
│   ├── base_adapter.py
│   ├── directory_adapter.py
│   └── osm_adapter.py
├── common/
│   ├── __init__.py
│   ├── base_scraper.py
│   └── directory_scraper.py
└── google/
    ├── __init__.py
    ├── google_maps_http_scraper.py
    ├── google_maps_playwright_scraper.py
    └── google_maps_scraper.py
```

---

### 2.2 Frontend Architecture

#### Before
```text
frontend/src/
├── api/
│   ├── client.ts
│   └── whatsappApi.ts            # Domain API in generic folder
├── components/
│   ├── Layout/
│   ├── LeadFinder/               # Domain components mixed in generic folder
│   │   ├── CategoryMultiSelect.tsx
│   │   ├── LocationMultiSelect.tsx
│   │   └── SectorAutocomplete.tsx
│   ├── admin/
│   ├── data-display/
│   ├── domain/                   # Unstructured bag of 13 domain components
│   │   ├── CampaignCard.tsx
│   │   ├── CampaignGroupCard.tsx
│   │   ├── ChatBubble.tsx
│   │   ├── ChatComposer.tsx
│   │   ├── ChatThread.tsx
│   │   ├── ConversationList.tsx
│   │   ├── LeadDetailDrawer.tsx
│   │   ├── NewChatModal.tsx
│   │   ├── SessionCard.tsx
│   │   ├── SpintaxPreviewCard.tsx
│   │   ├── TemplateSelectModal.tsx
│   │   ├── VerificationBadge.tsx
│   │   └── WhatsAppQrConnectModal.tsx
│   ├── forms/
│   └── ui/
├── data/
│   ├── sectors.ts
│   ├── turkeyLocations.ts
│   └── whatsapp/
│       └── whatsappRepository.ts # Domain repository isolated in data/
├── hooks/
│   ├── useI18n.ts
│   ├── useTheme.ts
│   └── useWhatsAppConversation.ts
└── lib/
    ├── utils.ts
    ├── whatsappLatency.ts
    ├── whatsappMessageMerge.ts
    └── whatsappPreview.ts
```

#### After
```text
frontend/src/
├── features/
│   ├── campaigns/
│   │   └── components/
│   │       ├── index.ts
│   │       ├── CampaignCard.tsx
│   │       ├── CampaignGroupCard.tsx
│   │       └── SpintaxPreviewCard.tsx
│   ├── leads/
│   │   └── components/
│   │       ├── index.ts
│   │       ├── CategoryMultiSelect.tsx
│   │       ├── LeadDetailDrawer.tsx
│   │       ├── LocationMultiSelect.tsx
│   │       ├── SectorAutocomplete.tsx
│   │       └── VerificationBadge.tsx
│   └── whatsapp/
│       ├── api/
│       │   └── whatsappApi.ts
│       ├── components/
│       │   ├── index.ts
│       │   ├── ChatBubble.tsx
│       │   ├── ChatComposer.tsx
│       │   ├── ChatThread.tsx
│       │   ├── ConversationList.tsx
│       │   ├── NewChatModal.tsx
│       │   ├── SessionCard.tsx
│       │   ├── TemplateSelectModal.tsx
│       │   └── WhatsAppQrConnectModal.tsx
│       ├── data/
│       │   └── whatsappRepository.ts
│       ├── hooks/
│       │   └── useWhatsAppConversation.ts
│       └── lib/
│           ├── whatsappLatency.ts
│           ├── whatsappMessageMerge.ts
│           └── whatsappPreview.ts
└── components/
    ├── Layout/
    ├── admin/
    ├── data-display/
    ├── forms/
    └── ui/
```

---

## 3. Inventory of Files Moved & Reasons

| Source File | Destination File | Domain Responsibility | Rationale |
|---|---|---|---|
| `backend/app/scrapers/base_scraper.py` | `backend/app/scrapers/common/base_scraper.py` | Scraper Core | Shared abstract base class for all scraper implementations. |
| `backend/app/scrapers/directory_scraper.py` | `backend/app/scrapers/common/directory_scraper.py` | Scraper Common | Directory/registry scraping logic shared by multiple adapters. |
| `backend/app/scrapers/google_maps_http_scraper.py` | `backend/app/scrapers/google/google_maps_http_scraper.py` | Google Engine | High-performance pure HTTP Google Maps engine. |
| `backend/app/scrapers/google_maps_playwright_scraper.py` | `backend/app/scrapers/google/google_maps_playwright_scraper.py` | Google Engine | Playwright headless browser fallback discovery engine. |
| `backend/app/scrapers/google_maps_scraper.py` | `backend/app/scrapers/google/google_maps_scraper.py` | Google Engine | Unified orchestrator for Google Maps scraping and deduplication. |
| `frontend/src/api/whatsappApi.ts` | `frontend/src/features/whatsapp/api/whatsappApi.ts` | WhatsApp API | Live WhatsApp API client, error mapping, and probe logic. |
| `frontend/src/hooks/useWhatsAppConversation.ts` | `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` | WhatsApp Hook | Conversation thread loading, ordering, and read-status synchronization. |
| `frontend/src/data/whatsapp/whatsappRepository.ts` | `frontend/src/features/whatsapp/data/whatsappRepository.ts` | WhatsApp Data | Live-only WhatsApp repository and CustomEvent bridge. |
| `frontend/src/lib/whatsappLatency.ts` | `frontend/src/features/whatsapp/lib/whatsappLatency.ts` | WhatsApp Lib | Development latency profiler for chat render cycles. |
| `frontend/src/lib/whatsappMessageMerge.ts` | `frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts` | WhatsApp Lib | Deterministic message reconciliation algorithm. |
| `frontend/src/lib/whatsappPreview.ts` | `frontend/src/features/whatsapp/lib/whatsappPreview.ts` | WhatsApp Lib | Single-source-of-truth chat preview generator. |
| `frontend/src/components/domain/ChatBubble.tsx` | `frontend/src/features/whatsapp/components/ChatBubble.tsx` | WhatsApp UI | Message bubble primitive with media lightboxes and retry triggers. |
| `frontend/src/components/domain/ChatComposer.tsx` | `frontend/src/features/whatsapp/components/ChatComposer.tsx` | WhatsApp UI | Message composer with 24h window checks and typing presence. |
| `frontend/src/components/domain/ChatThread.tsx` | `frontend/src/features/whatsapp/components/ChatThread.tsx` | WhatsApp UI | Scrollable message timeline with WhatsApp Web parity typing bubbles. |
| `frontend/src/components/domain/ConversationList.tsx` | `frontend/src/features/whatsapp/components/ConversationList.tsx` | WhatsApp UI | Chat list sidebar with unread badges, filter tabs, and live previews. |
| `frontend/src/components/domain/NewChatModal.tsx` | `frontend/src/features/whatsapp/components/NewChatModal.tsx` | WhatsApp UI | New conversation starter modal. |
| `frontend/src/components/domain/SessionCard.tsx` | `frontend/src/features/whatsapp/components/SessionCard.tsx` | WhatsApp UI | WhatsApp account status card with warmup metrics and QR triggers. |
| `frontend/src/components/domain/TemplateSelectModal.tsx` | `frontend/src/features/whatsapp/components/TemplateSelectModal.tsx` | WhatsApp UI | Pre-approved HSM template selector with variable interpolation. |
| `frontend/src/components/domain/WhatsAppQrConnectModal.tsx` | `frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx` | WhatsApp UI | Full lifecycle Baileys QR code pairing modal. |
| `frontend/src/components/domain/CampaignCard.tsx` | `frontend/src/features/campaigns/components/CampaignCard.tsx` | Campaign UI | Outreach campaign card with live progress and action controls. |
| `frontend/src/components/domain/CampaignGroupCard.tsx` | `frontend/src/features/campaigns/components/CampaignGroupCard.tsx` | Campaign UI | Audience group metadata card with readiness statistics. |
| `frontend/src/components/domain/SpintaxPreviewCard.tsx` | `frontend/src/features/campaigns/components/SpintaxPreviewCard.tsx` | Campaign UI | Dynamic spintax variation tester card. |
| `frontend/src/components/domain/LeadDetailDrawer.tsx` | `frontend/src/features/leads/components/LeadDetailDrawer.tsx` | Lead UI | Slide-over inspector for lead records and WhatsApp thread. |
| `frontend/src/components/domain/VerificationBadge.tsx` | `frontend/src/features/leads/components/VerificationBadge.tsx` | Lead UI | Trust badge showing E.164 and mobile verification score. |
| `frontend/src/components/LeadFinder/CategoryMultiSelect.tsx` | `frontend/src/features/leads/components/CategoryMultiSelect.tsx` | Lead UI | Multi-category dropdown filter with sector autocomplete. |
| `frontend/src/components/LeadFinder/LocationMultiSelect.tsx` | `frontend/src/features/leads/components/LocationMultiSelect.tsx` | Lead UI | Hierarchical Turkish city/district multi-select filter. |
| `frontend/src/components/LeadFinder/SectorAutocomplete.tsx` | `frontend/src/features/leads/components/SectorAutocomplete.tsx` | Lead UI | Industry sector search autocomplete with Turkish normalization. |

---

## 4. What Stayed and Why

* **`backend/app/services/whatsapp_service.py` (3,982 lines)**:
  - *Decision*: Stayed intact.
  - *Rationale*: Critical WhatsApp session state, Baileys WebSocket orchestration, database transaction boundaries, ACK/NACK semantics, and message deduplication are deeply coupled. Decomposing this file without a separate behavioral test harness would violate the zero-regression invariant.
* **`whatsapp-gateway/src/session-manager.js` (3,032 lines)**:
  - *Decision*: Stayed intact.
  - *Rationale*: Gateway session lifecycle, socket locks, credentials encryption, and event bridging are production-critical.
* **`frontend/src/pages/WhatsAppHubPage.tsx` (2,547 lines)**:
  - *Decision*: Stayed intact.
  - *Rationale*: Stateful live chat coordinator. All separated subcomponents were successfully organized under `features/whatsapp/components/`, while the main page state machine remains safe and working.
* **`components/ui/`, `components/forms/`, `components/data-display/`, `components/Layout/`**:
  - *Decision*: Kept under `components/`.
  - *Rationale*: These are genuinely generic, domain-agnostic UI building blocks reused throughout all pages.
* **Operational Scripts (`scripts/monitor_health.sh`, `scripts/whatsapp_reliability_collector.py`)**:
  - *Decision*: Stayed intact in `scripts/`.
  - *Rationale*: Bound to active systemd timers (`tezlify-monitor.timer`, `tezlify-wa-observer.timer`).

---

## 5. High-Risk Refactors Formally Deferred

```text
HIGH_RISK_REFACTORS_DEFERRED = [
  "backend/app/services/whatsapp_service.py deep decomposition into micro-services",
  "whatsapp-gateway/src/session-manager.js deep decomposition",
  "frontend/src/pages/WhatsAppHubPage.tsx state-machine hook extraction"
]
```

These refactors are documented for future phases when dedicated end-to-end sandbox environments allow live protocol regression verification.

---

## 6. Verification Results

### 6.1 Local Test Suite
* **Backend Pytest**: `725 passed, 0 failed` (44.44s)
* **Python Compile Check**: `0 errors` (`python3 -m compileall backend/app`)
* **Frontend TypeScript & Bundle**: `Built in 1.60s`, 0 errors (`npm --prefix frontend run build`)
* **Frontend Test Scripts**: `2/2 passed` (scroll preservation & message merge)
* **Gateway Unit Tests**: `15/15 passed` across all security, outbox, cache, and session scripts
* **Circular Dependencies**: `0 cycles` across Python, TypeScript, and Gateway

### 6.2 Production Deployment & WhatsApp Session Verification
* **Target**: `ubuntu@130.162.247.20:/opt/tezlify`
* **Git Hash**: `5bfeaf0`
* **Docker Rollout**:
  - `tezlify-backend`: Recreated & **Healthy**
  - `tezlify-gateway`: **Healthy**
  - `tezlify-caddy`: **Healthy**
  - `tezlify-db`: **Healthy**
* **API Health**:
  ```json
  {
    "status": "healthy",
    "service": "Tezlify Backend API",
    "version": "1.0.0",
    "scraper_engine": "HTTP",
    "memory_mb": 103.6,
    "gateway_bridge": {
      "connected": true,
      "reconnect_count": 1
    }
  }
  ```
* **WhatsApp Session State Check (Read-Only)**:
  ```sql
  SELECT id, user_id, gateway_id, session_name, status, is_active FROM whatsapp_sessions ORDER BY id;
  ```
  ```text
   id |               user_id                |              gateway_id              | session_name |     status      | is_active 
  ----+--------------------------------------+--------------------------------------+--------------+-----------------+-----------
    4 | 00000000-0000-0000-0000-000000000001 | 2b2ed927-866c-4373-89d9-0ad8b35d63c8 | diag         | SCAN_QR         | t
    5 | 00000000-0000-0000-0000-000000000001 | 87cf30e9-91d7-40b8-aba4-5d36494192f9 | diag         | RELINK_REQUIRED | t
   45 | f65642ab-4ae5-4d69-945c-8f30c8454bac | 7b3569af-90b1-43db-9767-fe256a839e76 | Hat 1        | SCAN_QR         | t
  (3 rows)
  ```
  **`SESSION_MUTATIONS = 0`** (100% match with pre-deployment baseline).

* **Systemd Timers**:
  - `tezlify-monitor.timer`: Active
  - `tezlify-wa-observer.timer`: Active

---

## 7. Rollback Strategy

If any unforeseen runtime issue occurs:
```bash
git checkout 5edbd44
git push -f origin main
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 "cd /opt/tezlify && git reset --hard 5edbd44 && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d"
```
Because no database migrations or state mutations occurred, rollback is instantaneous.
