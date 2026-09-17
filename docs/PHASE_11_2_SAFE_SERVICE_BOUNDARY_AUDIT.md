# PHASE 11.2 — SAFE SERVICE BOUNDARY AUDIT & CODE SIZE REDUCTION
**Date**: 2026-09-17  
**Project**: Tezlify (Local: `/Users/isatezcan/Documents/Github/Tezlify`, Production: `ubuntu@130.162.247.20:/opt/tezlify`)  
**Status**: AUDIT COMPLETE — EXTRACTION STRATEGY FORMULATED

---

## 1. Executive Summary

Phase 11.2 addresses oversized service and controller modules in Tezlify by identifying distinct domain responsibilities and extracting high-cohesion, low-coupling modules without changing runtime behavior, API contracts, or database schemas.

Total backend codebase surveyed:
- **Total Backend Files**: 102 `.py` files
- **Total Backend Lines**: 22,266 lines of code
- **Strict Invariants Preserved**:
  - `whatsapp_service.py`, `session-manager.js`, and `WhatsAppHubPage.tsx` are **DEFERRED** from deep code modification (forensic inventory only).
  - Database schema & migrations (`backend/app/core/migrations.py`) are **FROZEN** (zero DDL/migrations).
  - Public HTTP/WebSocket API contracts are **IDENTICAL**.
  - All existing unit and integration tests (725 backend tests, 15 gateway test scripts) must remain 100% passing.

---

## 2. Top 25 Largest Backend Files

The 25 largest files in `backend/app/` analyzed for line count, structure, and functional responsibilities:

| Rank | Path | Lines | Classes | Functions (Async) | Responsibilities | Extraction Risk |
|:---|:---|:---:|:---:|:---:|:---|:---:|
| 1 | `backend/app/services/whatsapp_service.py` | 3,982 | 4 | 39 (59) | WhatsApp lifecycle, sync, outbox, ACK/NACK, media, conversation, gateway WS bridge | **CRITICAL (DEFERRED)** |
| 2 | `backend/app/core/migrations.py` | 1,271 | 0 | 8 (15) | Schema migrations, index definition, column backfills | **FROZEN (DEFERRED)** |
| 3 | `backend/app/scrapers/google/google_maps_playwright_scraper.py` | 1,020 | 3 | 9 (17) | Headless browser management, DOM scraping, infinite scroll, satellite grid expansion | **HIGH (KEEP COHESIVE)** |
| 4 | `backend/app/scrapers/google/google_maps_scraper.py` | 933 | 4 | 13 (7) | Orchestration facade, deduplication index, confidence rating, district target math | **LOW (EXTRACTION CANDIDATE)** |
| 5 | `backend/app/services/lead_ingest_service.py` | 541 | 1 | 8 (3) | Lead normalization, upsert, conflict resolution, place_id hashing | **MEDIUM (COHESIVE DOMAIN)** |
| 6 | `backend/app/api/v1/endpoints/leads.py` | 516 | 0 | 2 (11) | Lead REST endpoints, query filter builder, export projection serialization | **LOW (EXTRACTION CANDIDATE)** |
| 7 | `backend/app/services/query_expander.py` | 478 | 1 | 11 (0) | Turkish morphology, sector synonym expansion, query permutation | **LOW (COHESIVE PURE LOGIC)** |
| 8 | `backend/app/api/v1/endpoints/whatsapp.py` | 475 | 0 | 4 (18) | WhatsApp REST routes, session proxies, chat endpoints | **HIGH (DEFERRED ROUTER)** |
| 9 | `backend/app/services/taxonomy_registry.py` | 442 | 1 | 6 (0) | B2B category taxonomy catalog, synonym lookups | **LOW (COHESIVE REGISTRY)** |
| 10 | `backend/app/scrapers/google/google_maps_http_scraper.py` | 441 | 1 | 9 (1) | Fast HTTP fallback scraper, protobuf decoding | **MEDIUM (COHESIVE ENGINE)** |
| 11 | `backend/app/schemas/admin.py` | 414 | 34 | 0 (0) | Admin Pydantic data schemas | **NONE (DECLARATIVE SCHEMAS)** |
| 12 | `backend/app/api/v1/endpoints/campaign_groups.py` | 402 | 0 | 0 (10) | Group CRUD endpoints, bulk membership SQL, lead aggregation counts | **LOW (EXTRACTION CANDIDATE)** |
| 13 | `backend/app/services/message_strategy_service.py` | 396 | 1 | 2 (0) | Template generation, spintax rendering, variable injection | **LOW (COHESIVE TEMPLATE)** |
| 14 | `backend/app/main.py` | 375 | 0 | 0 (9) | FastAPI lifespan, CORS, middleware, router mounts, startup hooks | **MEDIUM (APP ENTRYPOINT)** |
| 15 | `backend/app/api/v1/endpoints/scraper.py` | 355 | 0 | 1 (7) | Scraper dispatch routes, concurrency lock, task status | **MEDIUM (THIN ROUTER)** |
| 16 | `backend/app/services/category_recommendation_service.py` | 318 | 1 | 1 (0) | Category similarity scoring, keyword matches | **LOW (COHESIVE LOGIC)** |
| 17 | `backend/app/services/whatsapp_gateway.py` | 310 | 1 | 5 (21) | HTTP client to Node.js Baileys gateway | **HIGH (DEFERRED GATEWAY CLIENT)** |
| 18 | `backend/app/services/admin/security_admin_service.py` | 292 | 0 | 8 (0) | Audit log inspection, rate limit inspect, failed logins | **LOW (EXTRACTION CANDIDATE)** |
| 19 | `backend/app/services/entity_resolver.py` | 276 | 5 | 3 (0) | Entity matching, brand deduplication, name normalization | **LOW (COHESIVE MATCH LOGIC)** |
| 20 | `backend/app/services/campaign_runner.py` | 265 | 1 | 1 (3) | Campaign background orchestration, worker lifecycle, task registry | **LOW (COHESIVE RUNNER)** |
| 21 | `backend/app/core/auth.py` | 259 | 1 | 5 (3) | JWT decoding, password hashing, tenant security scoping | **MEDIUM (CORE SECURITY)** |
| 22 | `backend/app/services/smart_matching_service.py` | 258 | 1 | 1 (1) | Lead-to-campaign recommendation heuristic engine | **LOW (COHESIVE ALGORITHM)** |
| 23 | `backend/app/api/v1/endpoints/campaigns.py` | 254 | 0 | 0 (10) | Campaign CRUD endpoints, status toggle, dispatch trigger | **LOW (THIN CONTROLLER)** |
| 24 | `backend/app/data/turkey_locations.py` | 243 | 0 | 5 (0) | Turkish 81 provinces, districts, character normalization | **LOW (STATIC DATA/UTILITY)** |
| 25 | `backend/app/schemas/intelligence.py` | 239 | 19 | 1 (0) | Discovery schemas, dataclasses, classifications | **NONE (DECLARATIVE SCHEMAS)** |

---

## 3. Top 15 Largest Frontend Files

| Rank | Path | Lines | Role / Type | Refactor Safety & Status |
|:---|:---|:---:|:---|:---|
| 1 | `frontend/src/pages/WhatsAppHubPage.tsx` | 2,546 | Main WhatsApp Live Hub (chat, QR, media, sync) | **CRITICAL (DEFERRED)** |
| 2 | `frontend/src/pages/LeadCRMPage.tsx` | 1,381 | Lead management, filtering, table, batch actions | High complexity page |
| 3 | `frontend/src/locales/tr.ts` | 1,371 | Turkish localization dictionary | Static translation dictionary |
| 4 | `frontend/src/locales/en.ts` | 1,371 | English localization dictionary | Static translation dictionary |
| 5 | `frontend/src/pages/CampaignsPage.tsx` | 1,337 | Campaign builder, execution wizard, metrics | Page component |
| 6 | `frontend/src/pages/LeadFinderPage.tsx` | 914 | Scraper UI, live satellite tuner, multi-district | Page component |
| 7 | `frontend/src/pages/CampaignGroupsPage.tsx` | 910 | Campaign groups management page | Page component |
| 8 | `frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx` | 894 | QR Code modal for WhatsApp pairing | Feature component (Protected) |
| 9 | `frontend/src/pages/admin/AdminDeploymentPage.tsx` | 850 | System deployment & release monitoring | Admin page |
| 10 | `frontend/src/api/client.ts` | 816 | Central typed Axios/fetch API client | Core API client |
| 11 | `frontend/src/pages/admin/AdminSecurityPage.tsx` | 764 | Admin security overview and audit logs | Admin page |
| 12 | `frontend/src/pages/admin/AdminMonitoringPage.tsx` | 754 | Admin system metrics and health status | Admin page |
| 13 | `frontend/src/pages/BlacklistPage.tsx` | 719 | Anti-spam blacklist manager | Page component |
| 14 | `frontend/src/pages/admin/AdminWhatsAppPage.tsx` | 647 | Admin WhatsApp session overview | Admin page |
| 15 | `frontend/src/features/whatsapp/api/whatsappApi.ts` | 637 | WhatsApp client endpoints & WS listener | Feature API (Protected) |

---

## 4. Top 10 Largest Gateway Files

| Rank | Path | Lines | Role / Type | Refactor Safety & Status |
|:---|:---|:---:|:---|:---|
| 1 | `whatsapp-gateway/src/session-manager.js` | 3,032 | Baileys multi-session engine, socket lifecycle, sync | **CRITICAL (DEFERRED)** |
| 2 | `whatsapp-gateway/src/index.js` | 405 | Gateway HTTP server, routes, health endpoints | Server entrypoint |
| 3 | `whatsapp-gateway/src/events.js` | 259 | Gateway WebSocket bridge event publishers | Event subsystem |
| 4 | `whatsapp-gateway/src/auth/postgres-auth-repository.js` | 230 | Postgres auth state repository for Baileys | Auth subsystem |
| 5 | `whatsapp-gateway/src/outbox/postgres-event-outbox.js` | 142 | Transactional outbox pattern implementation | Reliability subsystem |
| 6 | `whatsapp-gateway/src/lease/postgres-session-lease.js` | 59 | Postgres advisory lock lease coordinator | Concurrency subsystem |
| 7 | `whatsapp-gateway/src/domain/socket-lifecycle.js` | 58 | Socket connection state machines | Domain state machine |
| 8 | `whatsapp-gateway/src/auth/encrypted-codec.js` | 55 | AES-256 GCM token & credentials encryption | Security module |
| 9 | `whatsapp-gateway/src/domain/bounded-cache.js` | 33 | LRU-style bounded memory cache | Domain utility |
| 10 | `whatsapp-gateway/src/observability.js` | 31 | Prometheus/health metrics counters | Observability module |

---

## 5. Responsibility Matrix of Key Large Files

### 5.1 `whatsapp_service.py` (3,982 lines) [FORENSIC INVENTORY ONLY]
```text
whatsapp_service.py
├── Session Lifecycle & Gateway Sync (start, stop, QR pairing, health checks)
├── Inbound Event Routing & Message Deduplication (message.upsert, history.sync)
├── Database Persistence & Transaction Boundaries (Message, Conversation, Session)
├── Outbox Pattern & ACK/NACK Handling (status updates, retry queues)
├── Outbound Message Dispatch & Rate Limiting (send_message, antiban jitter)
├── Conversation Thread Management & Unread Counts (get_chats, mark_as_read)
├── Media Message Processing & Storage (upload, download, MIME validation)
└── WebSocket Broadcasting (frontend live chat feeds via ws_manager)
```
*Decision*: **DEFERRED**. Any structural alteration presents high risk of regressions in production Baileys session management.

### 5.2 `google_maps_scraper.py` (933 lines)
```text
google_maps_scraper.py
├── Dedup Index & Policy (LeadDiscoveryDeduplicator, DedupDecision) [EXTRACTABLE]
├── Location Confidence & District Target Math (LocationConfidence, compute_district_target) [EXTRACTABLE]
├── Multi-District & Query Expansion Loop (iteration, progress callback)
├── Scraper Engine Delegation (Playwright vs. HTTP fallback selection)
└── Contact Enrichment (website HTTP crawl for telephone number)
```
*Decision*: **EXTRACT DEDUPLICATION PRIMITIVES**. Low risk, high cohesion benefit.

### 5.3 `leads.py` (516 lines)
```text
leads.py
├── Lead Filter Query Expression Builder (build_lead_filter_conditions) [EXTRACTABLE]
├── Lead Serialization for CSV/Excel Projection (_lead_export_dict) [EXTRACTABLE]
├── Lead CRUD & Pagination HTTP Endpoints (list_leads, get_lead, delete_lead)
└── Bulk Lead Actions HTTP Endpoints (bulk_delete, bulk_status_update)
```
*Decision*: **EXTRACT QUERY BUILDER & EXPORT PROJECTION**. Restores thin router architecture.

### 5.4 `campaign_groups.py` (402 lines)
```text
campaign_groups.py
├── Bulk Membership SQL Insertion (_bulk_insert_memberships) [EXTRACTABLE]
├── Group Lead Count Aggregations (_get_group_counts) [EXTRACTABLE]
├── Add Leads Business Logic (validation, duplicate checking, messaging) [EXTRACTABLE]
└── Group CRUD HTTP Endpoints (create, list, get, update, delete)
```
*Decision*: **EXTRACT CAMPAIGN GROUP DOMAIN SERVICE**. Creates clean separation of data operations.

### 5.5 `backend/app/services/admin/` (7 services, 1,350 lines total)
```text
services/admin/
├── deployment_admin_service.py (_read_json_file duplication) [EXTRACTABLE]
├── monitoring_admin_service.py (_read_json_file duplication) [EXTRACTABLE]
├── backups_admin_service.py (_format_size_human duplication) [EXTRACTABLE]
└── Domain Admin Inspections (Git, System, Health, Backups)
```
*Decision*: **CREATE ADMIN COMMON UTILITIES**. Eliminates redundant file and byte utilities.

---

## 6. Extraction Candidates & Prioritization

Each candidate has been scored according to:
- **Safety**: LOW (high stability), MEDIUM (needs care), HIGH (tightly coupled)
- **Benefit**: LOW, MEDIUM, HIGH
- **Coupling**: LOW (independent primitives), MEDIUM, HIGH

| Candidate | Source File | Target Module | Responsibility Extracted | Est. Lines Reduced | Safety | Benefit | Coupling | Priority Rank | Tests Affected |
|:---|:---|:---|:---|:---:|:---:|:---:|:---:|:---:|:---|
| **BATCH 1** | `admin/*.py` | `backend/app/services/admin/admin_common.py` | JSON reader, byte formatting | ~40 | LOW | MEDIUM | LOW | **1 (Quick Win)** | Admin test suite |
| **BATCH 2** | `google_maps_scraper.py` | `backend/app/scrapers/google/deduplicator.py` | `LeadDiscoveryDeduplicator`, `DedupDecision`, `LocationConfidence`, `compute_district_target` | ~90 | LOW | HIGH | LOW | **2 (Core Domain)** | `test_scraper_robustness.py`, `test_geo_scope.py`, `test_lead_match_policy.py` |
| **BATCH 3** | `endpoints/leads.py` | `backend/app/services/lead_query_service.py` & `ExportService.lead_to_export_dict` | SQLAlchemy query filters (`build_lead_filter_conditions`), export serialization | ~130 | LOW | HIGH | LOW | **3 (Router Thinning)** | `test_search_pipeline.py`, lead endpoint tests |
| **BATCH 4** | `endpoints/campaign_groups.py` | `backend/app/services/campaign_group_service.py` | Bulk membership insertion, group counts, add-to-group orchestration | ~110 | LOW | HIGH | LOW | **4 (Service Layer)** | `test_campaign_*.py`, campaign group tests |

---

## 7. Formally Deferred High-Risk Candidates

To uphold the core invariants of Tezlify, the following components are strictly deferred from decomposition in Phase 11.2:

1. **`backend/app/services/whatsapp_service.py` (3,982 lines)**:
   - *Reason*: Contains multi-tenant transaction boundaries, gateway WebSocket bridge state, and outbox delivery ordering. Extracting pieces without end-to-end multi-worker orchestration tests introduces unacceptable risk of session desynchronization.
   - *Action in 11.2*: Forensic analysis and dependency mapping completed. Deferred to future dedicated Phase.
2. **`whatsapp-gateway/src/session-manager.js` (3,032 lines)**:
   - *Reason*: High-concurrency Baileys event loop with in-memory socket locks, multi-tenant session leases, and encrypted filesystem/Postgres state.
   - *Action in 11.2*: Code inspected. No edits permitted.
3. **`frontend/src/pages/WhatsAppHubPage.tsx` (2,546 lines)**:
   - *Reason*: Complex UI coordinator for chat tabs, active thread state, real-time message merging, and virtual scrolling.
   - *Action in 11.2*: Verified passing build and dedicated scroll/message tests. No structural changes in 11.2.
4. **`backend/app/core/migrations.py` (1,271 lines)**:
   - *Reason*: Invariant: ZERO DATABASE SCHEMA / MIGRATION CHANGES in Phase 11.2.

---

## 8. Execution Plan

We will proceed with the four safe, high-benefit batches sequentially:

1. **Batch 1**: Admin Common Utilities (`backend/app/services/admin/admin_common.py`).
   - Run compilation & targeted admin tests.
2. **Batch 2**: Scraper Deduplication Primitives (`backend/app/scrapers/google/deduplicator.py`).
   - Run compilation & targeted scraper tests (`test_scraper_robustness.py`, `test_geo_scope.py`, `test_lead_match_policy.py`).
3. **Batch 3**: Lead Query Builder & Export Projection (`lead_query_service.py`, `export_service.py`, `leads.py`).
   - Run compilation & lead search tests (`test_search_pipeline.py`).
4. **Batch 4**: Campaign Group Service (`campaign_group_service.py`, `campaign_groups.py`).
   - Run compilation & campaign group tests.
5. **Full Suite Validation & Production Deployment**:
   - Backend 725 tests PASS.
   - Frontend build PASS.
   - Gateway tests PASS.
   - Circular dependency check = 0.
   - Production deployment with `SESSION_MUTATIONS = 0`.
