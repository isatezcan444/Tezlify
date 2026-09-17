# Phase 11.1 — Architecture Reorganization & Folder Structure Plan

**Phase**: 11.1 — Professional Folder Structure & Safe Architecture Reorganization  
**Date**: September 17, 2026  
**Status**: DRAFT (Planning Mode)  
**Safety Contract**: Apply ONLY evidence-backed, behavior-preserving, responsibility-oriented structural moves. Adhere strictly to the batch execution order and the WhatsApp preservation invariants.

---

## 1. Executive Summary & Responsibility Principles

Phase 11.0 completed all dead-code pruning, duplicate route removals, and unused dependency cleanup.
Phase 11.1 restructures the codebase into a clean, modern, domain-driven folder hierarchy:

1. **Responsibility-First Organization**: Group components and modules near the domain they own rather than arbitrary generic buckets.
2. **Feature-Oriented Frontend**: Move domain composites into `features/` (`whatsapp/`, `campaigns/`, `leads/`) while maintaining genuinely shared primitives under `components/` (`ui/`, `forms/`, `data-display/`, `Layout/`, `admin/`).
3. **Structured Scraper Pipeline**: Separate Google Maps scraping engine into `scrapers/google/`, common utilities into `scrapers/common/`, and provider adapters into `scrapers/adapters/`.
4. **Strict Invariant Protection**:
   - `whatsapp_service.py` is **NOT decomposed** into fragmented micro-files in this phase.
   - `session-manager.js` is **NOT decomposed**.
   - `WhatsAppHubPage.tsx` state machine is **NOT decomposed**.
   - WhatsApp database sessions, Baileys keys, QR flows, and ACK semantics remain **100% untouched**.

---

## 2. Target Conceptual Structure

### 2.1 Backend Target Structure (`backend/app/`)
```text
backend/app/
├── api/
│   └── v1/
│       ├── endpoints/
│       │   ├── admin.py
│       │   ├── analytics.py
│       │   ├── auth.py
│       │   ├── blacklist.py
│       │   ├── campaign_groups.py
│       │   ├── campaigns.py
│       │   ├── leads.py
│       │   ├── scraper.py
│       │   ├── settings.py
│       │   ├── smart_outreach.py
│       │   └── whatsapp.py
│       ├── api.py
│       └── websocket.py
├── auth/
│   ├── api/
│   ├── application/
│   ├── domain/
│   └── infrastructure/
├── core/
│   ├── auth.py
│   ├── config.py
│   ├── database.py
│   ├── migrations.py
│   ├── search_utils.py
│   └── seed.py
├── data/
│   ├── turkey_locations.py
│   └── turkey_subdivisions.py
├── models/
│   ├── __init__.py
│   └── (14 SQL models)
├── schemas/
│   └── (10 Pydantic schema modules)
├── scrapers/
│   ├── __init__.py                # Canonical exports: GoogleMapsScraper, etc.
│   ├── google/                    # Google Maps discovery & extraction engine
│   │   ├── __init__.py
│   │   ├── google_maps_scraper.py
│   │   ├── google_maps_playwright_scraper.py
│   │   └── google_maps_http_scraper.py
│   ├── adapters/                  # Provider adapters (OSM, Directory, Base)
│   │   ├── __init__.py
│   │   ├── base_adapter.py
│   │   ├── directory_adapter.py
│   │   └── osm_adapter.py
│   └── common/                    # Base scraper definitions
│       ├── __init__.py
│       ├── base_scraper.py
│       └── directory_scraper.py
└── services/
    ├── admin/                     # Admin center domain services (8 services)
    │   ├── backups_admin_service.py
    │   ├── database_service.py
    │   ├── deployment_admin_service.py
    │   ├── monitoring_admin_service.py
    │   ├── overview_service.py
    │   ├── security_admin_service.py
    │   ├── system_service.py
    │   └── whatsapp_admin_service.py
    ├── whatsapp_service.py        # Core WhatsApp service (preserved intact)
    ├── whatsapp_gateway.py        # Gateway HTTP/WS bridge
    ├── whatsapp_profiling.py      # Latency & diagnostics profiling
    └── (domain services: campaign_runner, lead_ingest, taxonomy, etc.)
```

### 2.2 Frontend Target Structure (`frontend/src/`)
```text
frontend/src/
├── features/                      # Feature-oriented domain modules
│   ├── whatsapp/
│   │   ├── components/            # WhatsApp domain UI components
│   │   │   ├── ChatBubble.tsx
│   │   │   ├── ChatComposer.tsx
│   │   │   ├── ChatThread.tsx
│   │   │   ├── ConversationList.tsx
│   │   │   ├── NewChatModal.tsx
│   │   │   ├── SessionCard.tsx
│   │   │   ├── TemplateSelectModal.tsx
│   │   │   └── WhatsAppQrConnectModal.tsx
│   │   ├── api/
│   │   │   └── whatsappApi.ts     # Live WhatsApp HTTP endpoints
│   │   ├── hooks/
│   │   │   └── useWhatsAppConversation.ts
│   │   ├── data/
│   │   │   └── whatsappRepository.ts # Active repository layer
│   │   └── lib/
│   │       ├── whatsappLatency.ts
│   │       ├── whatsappMessageMerge.ts
│   │       └── whatsappPreview.ts
│   ├── campaigns/
│   │   └── components/            # Campaign domain UI components
│   │       ├── CampaignCard.tsx
│   │       ├── CampaignGroupCard.tsx
│   │       └── SpintaxPreviewCard.tsx
│   └── leads/
│       └── components/            # Lead CRM & Finder domain UI components
│           ├── LeadDetailDrawer.tsx
│           ├── VerificationBadge.tsx
│           ├── CategoryMultiSelect.tsx
│           ├── LocationMultiSelect.tsx
│           └── SectorAutocomplete.tsx
├── components/                    # Genuinely shared UI primitives and layouts
│   ├── ui/                        # 33 Vuexy foundation primitives (Button, Modal, Card, etc.)
│   ├── forms/                     # 10 generic form controls (TextInput, Select, Switch, etc.)
│   ├── data-display/              # 5 generic data widgets (DataTable, TableToolbar, etc.)
│   ├── Layout/                    # Sidebar, TopHeader, Breadcrumb
│   └── admin/                     # AdminShell
├── pages/                         # Route entry pages
├── context/                       # Global React contexts (Auth, Theme, Toast, I18n)
├── api/                           # Core API client & admin API
├── data/                          # Shared geographic & sector datasets
├── lib/                           # Shared design tokens & utils
├── locales/                       # Centralized i18n dictionaries (tr.ts, en.ts)
└── types/                         # Global TypeScript type definitions
```

---

## 3. Detailed Move & Impact Analysis

### 3.1 Batch 1: Backend Scrapers Reorganization
| Source Path | Target Path | Responsibility | References to Update |
|---|---|---|---|
| `backend/app/scrapers/google_maps_scraper.py` | `backend/app/scrapers/google/google_maps_scraper.py` | Google Maps Orchestrator | `endpoints/scraper.py`, `test_scraper_robustness.py`, `test_geo_scope.py`, `test_lead_match_policy.py`, `test_search_pipeline.py` |
| `backend/app/scrapers/google_maps_playwright_scraper.py` | `backend/app/scrapers/google/google_maps_playwright_scraper.py` | Playwright Engine | `google_maps_scraper.py`, `google_maps_http_scraper.py`, `lead_ingest_service.py`, `test_google_maps_http_scraper.py` |
| `backend/app/scrapers/google_maps_http_scraper.py` | `backend/app/scrapers/google/google_maps_http_scraper.py` | HTTP Streaming Scraper | `google_maps_scraper.py`, `test_google_maps_http_scraper.py` |
| `backend/app/scrapers/base_scraper.py` | `backend/app/scrapers/common/base_scraper.py` | Base Scraper Interface | `google_maps_scraper.py`, `google_maps_playwright_scraper.py`, `google_maps_http_scraper.py`, `directory_scraper.py` |
| `backend/app/scrapers/directory_scraper.py` | `backend/app/scrapers/common/directory_scraper.py` | Directory Cleaner & Parser | `adapters/directory_adapter.py`, `adapters/osm_adapter.py`, `test_search_pipeline.py` |

**Compatibility Guarantee**:
`backend/app/scrapers/__init__.py` will cleanly export `GoogleMapsScraper`, `GoogleMapsPlaywrightScraper`, `GoogleMapsHttpScraper`, `BaseScraper`, and `DirectoryScraper` for backward and forward compatibility.

### 3.2 Batch 2: Frontend Feature Organization
| Source Path | Target Path | Consumers to Update |
|---|---|---|
| `frontend/src/components/domain/Chat*.tsx`, `ConversationList.tsx`, `NewChatModal.tsx`, `SessionCard.tsx`, `TemplateSelectModal.tsx`, `WhatsAppQrConnectModal.tsx` | `frontend/src/features/whatsapp/components/` | `WhatsAppHubPage.tsx`, `AdminWhatsAppPage.tsx`, `test-whatsapp-chat-scroll.mjs` |
| `frontend/src/api/whatsappApi.ts` | `frontend/src/features/whatsapp/api/whatsappApi.ts` | `WhatsAppHubPage.tsx`, `whatsappRepository.ts` |
| `frontend/src/hooks/useWhatsAppConversation.ts` | `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` | `LeadDetailDrawer.tsx` |
| `frontend/src/data/whatsapp/whatsappRepository.ts` | `frontend/src/features/whatsapp/data/whatsappRepository.ts` | `WhatsAppHubPage.tsx`, `useWhatsAppConversation.ts` |
| `frontend/src/lib/whatsapp*.ts` | `frontend/src/features/whatsapp/lib/` | `WhatsAppHubPage.tsx`, `ChatThread.tsx`, `ChatBubble.tsx`, `test-whatsapp-message-merge.mjs` |
| `frontend/src/components/domain/Campaign*.tsx`, `SpintaxPreviewCard.tsx` | `frontend/src/features/campaigns/components/` | `CampaignsPage.tsx`, `CampaignGroupsPage.tsx` |
| `frontend/src/components/domain/LeadDetailDrawer.tsx`, `VerificationBadge.tsx` | `frontend/src/features/leads/components/` | `LeadCRMPage.tsx`, `WhatsAppHubPage.tsx` |
| `frontend/src/components/LeadFinder/*` | `frontend/src/features/leads/components/` | `LeadFinderPage.tsx`, `LeadCRMPage.tsx`, `CampaignsPage.tsx`, `CampaignGroupsPage.tsx` |

---

## 4. High-Risk Refactors Explicitly Deferred

In strict compliance with **Section 1, 4, 8, 10, 22**:
1. **`backend/app/services/whatsapp_service.py` Decomposition**:
   - Status: **DEFERRED**.
   - Rationale: Splitting this 3,982-line service requires altering function ownership, transaction scopes, and event bridging. It is battle-tested with 725 passing tests and production-stable.
2. **`whatsapp-gateway/src/session-manager.js` Decomposition**:
   - Status: **DEFERRED**.
   - Rationale: High protocol coupling between Baileys socket reconnects, credential encryption, and outbox writes.
3. **`frontend/src/pages/WhatsAppHubPage.tsx` State Hook Extraction**:
   - Status: **DEFERRED**.
   - Rationale: High risk of scroll restoration and optimistic messaging regressions.

---

## 5. Order of Operations

```text
1. Execute Batch 1: Backend Scrapers Reorganization
   -> python -m compileall backend/app
   -> pytest backend/tests/ -q (Verify 725/725 passed)

2. Execute Batch 2: Frontend Feature Reorganization
   -> npm --prefix frontend run build (Verify 0 TS/bundle errors)
   -> node frontend/scripts/test-whatsapp-chat-scroll.mjs (Pass)
   -> node frontend/scripts/test-whatsapp-message-merge.mjs (Pass)

3. Full Suite Validation
   -> pytest backend/tests/ -q (725 passed)
   -> Gateway scripts 15/15 passed
   -> Circular dependency check (0 cycles)

4. Update Documentation Registry
   -> docs/component-registry.md

5. Commit & Push to origin/main
   -> git commit & git push

6. Deploy to Production
   -> ssh to ubuntu@130.162.247.20
   -> git pull origin main
   -> docker compose -f docker-compose.prod.yml build
   -> docker compose -f docker-compose.prod.yml up -d
   -> Verify container health & WhatsApp session read-only query
```
