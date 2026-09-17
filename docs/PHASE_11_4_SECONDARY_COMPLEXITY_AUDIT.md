# PHASE 11.4 — SECONDARY COMPLEXITY AUDIT

**Tezlify B2B Outreach & Lead Generation Platform**  
**Execution Date**: September 17, 2026  
**Status**: AUDIT COMPLETE (Pre-Implementation Baseline)  
**Safety Certification**: Fail-Closed Invariants & Forensic Protections Enforced  

---

## 1. Executive Summary

Phase 11.4 performs a forensic complexity audit across the remaining medium and large modules in the Tezlify codebase following the successful completion of Phase 11.3 (Frontend Page Boundary Refactor).

### Core Audit Principles
1. **True Responsibility Boundaries**: Do not chase arbitrary line counts; extract only code with distinct, decoupled responsibilities.
2. **Cohesive Units Preserved**: Files with high internal cohesion, low external coupling, and a single domain scope are designated as `KEEP COHESIVE` (no-op is acceptable).
3. **Strictly Protected Modules**: Core transactional, live WebSocket, Baileys socket lifecycle, and schema migration modules remain **FORENSIC ONLY**.
4. **Zero Contract & Runtime Invariants**: No modifications to public REST API routes, schemas, database tables, or WebSocket protocols.

---

## 2. Strictly Protected Forensic Targets

Per Section 2 of the Phase 11.4 mandate, the following 4 files are **strictly protected** against architectural decomposition in this phase:

| Protected Target | Lines | Shared Consumers | Nature & Protection Rationale | Audit Status |
|---|:---:|:---:|---|:---:|
| [`backend/app/services/whatsapp_service.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp_service.py) | 3,982 | 44 | Multi-tenant transaction manager, outbox worker, Baileys gateway event bridge, locking coordinator. | **FORENSIC ONLY** |
| [`whatsapp-gateway/src/session-manager.js`](file:///Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/src/session-manager.js) | 3,032 | 26 | Baileys socket lifecycle, in-memory leases, Postgres encrypted auth state, QR pairing. | **FORENSIC ONLY** |
| [`frontend/src/pages/WhatsAppHubPage.tsx`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/pages/WhatsAppHubPage.tsx) | 2,546 | 21 | High-throughput live chat coordinator, virtual list scrolling, optimistic send, ACK state. | **FORENSIC ONLY** |
| [`backend/app/core/migrations.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/core/migrations.py) | 1,271 | 17 | Core database schema definitions & immutable migration freeze invariant. | **FORENSIC ONLY** |

---

## 3. Comprehensive Target Inventory & Metrics

For every audited target, the structural, lifecycle, dependency, and complexity metrics are documented below:

| Target File | Lines | Classes | Functions | States | Side Effects | Ext Deps | Int Deps | API Calls | DB Calls | Consumers | Primary Responsibilities |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| [`frontend/src/pages/LeadCRMPage.tsx`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/pages/LeadCRMPage.tsx) | 1,028 | 0 | 19 | 42 | 3 | 1 | 6 | 14 | 0 | 12 | Table display, filter orchestration, selection, pagination, drawer trigger |
| [`frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx) | 894 | 0 | 2 | 23 | 6 | 2 | 6 | 0 | 0 | 8 | QR state machine, countdown timers, pairing code tab, fallback polling |
| [`frontend/src/pages/admin/AdminDeploymentPage.tsx`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/pages/admin/AdminDeploymentPage.tsx) | 850 | 0 | 1 | 9 | 2 | 1 | 9 | 0 | 0 | 8 | Read-only telemetry, deployment metrics, systemd stats, access check |
| [`frontend/src/api/client.ts`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/api/client.ts) | 816 | 1 | 12 | 0 | 0 | 0 | 0 | 2 | 0 | 108 | Central HTTP transport, auth headers, token management, endpoint wrappers |
| [`backend/app/services/lead_ingest_service.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/lead_ingest_service.py) | 541 | 1 | 11 | 0 | 3 | 11 | 0 | 0 | 17 | 16 | Lead value building, truncation, merge logic, bulk insert, conflict resolution |
| [`backend/app/scrapers/google/google_maps_playwright_scraper.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/scrapers/google/google_maps_playwright_scraper.py) | 1,020 | 3 | 26 | 0 | 11 | 14 | 0 | 0 | 0 | 12 | Playwright browser lifecycle, feed scroll, DOM card extraction, anti-bot |
| [`backend/app/scrapers/google/google_maps_http_scraper.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/scrapers/google/google_maps_http_scraper.py) | 441 | 1 | 10 | 0 | 13 | 11 | 0 | 5 | 0 | 7 | Pure HTTP JSON RPC query, nested array parsing, phone/website extraction |
| [`backend/app/services/query_expander.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/query_expander.py) | 478 | 1 | 11 | 0 | 1 | 5 | 0 | 0 | 1 | 7 | Keyword expansion, category taxonomy table, location stripping, mahalle extraction |
| [`backend/app/services/taxonomy_registry.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/taxonomy_registry.py) | 442 | 1 | 6 | 0 | 1 | 5 | 0 | 0 | 2 | 16 | In-memory relational taxonomy graph, mutual exclusivity checks, category profile |
| [`backend/app/services/entity_resolver.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/entity_resolver.py) | 276 | 5 | 3 | 0 | 0 | 4 | 0 | 0 | 0 | 3 | Person vs Clinic/Company classification, confidence scoring, source trust |
| [`backend/app/services/message_strategy_service.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/message_strategy_service.py) | 396 | 1 | 2 | 0 | 0 | 4 | 0 | 0 | 0 | 6 | Goal-based outreach recommendation, TR/EN locale copy generation, spintax |

---

## 4. Responsibility Classification & Architectural Mapping

Each module's internals are mapped against the 13 canonical responsibility categories:
- **A. ORCHESTRATION** (Workflows, high-level control flow)
- **B. DOMAIN LOGIC** (Business policies, matching rules)
- **C. DATA ACCESS** (SQL queries, ORM operations)
- **D. API TRANSPORT** (HTTP headers, fetch wrapper, endpoints)
- **E. VALIDATION** (Format checking, bounds, input rules)
- **F. TRANSFORMATION** (Data normalization, string munging)
- **G. UI PRESENTATION** (JSX rendering, visual layout, theme)
- **H. STATE MANAGEMENT** (React useState, selection sets)
- **I. EXTERNAL INTEGRATION** (Playwright browser, Google Maps RPC)
- **J. PURE UTILITY** (Deterministic input→output helpers)
- **K. CACHING** (In-memory lookup maps, memoization)
- **L. RETRY / ERROR HANDLING** (Savepoints, catch blocks)
- **M. OBSERVABILITY** (Logging, telemetry, stats counters)

### 4.1 Target Breakdown

#### 1. `LeadCRMPage.tsx`
- **Classifications Present**: **A** (Orchestration), **G** (UI Presentation), **H** (State Management: 42 states), **F** (Filter query param transformation), **D** (ApiClient coordination).
- **Evaluation**: The page has 42 active `useState` hooks. Filter state (city, district, categories, search, status, waOnly, pagination) accounts for 8 state hooks and 30+ lines of derived query string construction. Multi-selection logic is currently duplicated inline rather than utilizing the hook created in Phase 11.3.
- **Candidate Status**: **EXTRACTION CANDIDATE** (`useLeadFilters.ts`, attach `useLeadSelection.ts`).

#### 2. `lead_ingest_service.py`
- **Classifications Present**: **A** (Ingest pipeline orchestration), **B** (Merge rules), **C** (Bulk SQL insert, prefetch), **F** (Lead value dictionary building, string truncation), **J** (Correlation key building), **L** (Nested savepoint rollback on concurrent race).
- **Evaluation**: Lead value building (`_build_lead_values`), string truncation (`_trunc`), default custom data payload (`_initial_custom_data`), column list definition (`_LEAD_VALUE_COLS`), merge logic (`_merge_into_existing`), and bulk key hashing (`_bulk_key`) are purely deterministic domain transformations. They have zero direct dependency on `AsyncSession`.
- **Candidate Status**: **EXTRACTION CANDIDATE** (`backend/app/services/lead_normalization.py`).

#### 3. `query_expander.py`
- **Classifications Present**: **B** (Search query expansion rules), **F** (Turkish location stripping, mahalle extraction), **J** (Static taxonomy dictionary definitions: `CATEGORY_TAXONOMY`).
- **Evaluation**: `CATEGORY_TAXONOMY` occupies ~175 lines of static Turkish & English keyword lists, directory slugs, and OSM tags embedded directly in the class definition. Moving this data dictionary to a clean data module (`backend/app/data/category_taxonomy.py`) decouples static data definitions from expansion algorithms.
- **Candidate Status**: **EXTRACTION CANDIDATE** (`backend/app/data/category_taxonomy.py`).

#### 4. `WhatsAppQrConnectModal.tsx`
- **Classifications Present**: **G** (Modal UI), **H** (State Machine: 23 states), **I** (Baileys gateway pairing & socket event listeners), **L** (Timer countdown & error mapping).
- **Evaluation**: Extremely high coupling between QR countdown intervals, live socket event subscriptions, phone pairing code fallbacks, and modal view transitions. Any component split risks subtle race conditions during QR scanning.
- **Candidate Status**: **HIGH RISK → DEFERRED / KEEP COHESIVE** (Explicitly protected under Section 8 & Section 19).

#### 5. `AdminDeploymentPage.tsx`
- **Classifications Present**: **G** (Dashboard UI), **H** (Read-only data state: 9 states), **M** (Telemetry visualization).
- **Evaluation**: The page has zero user edit actions, zero modal flows, and zero form inputs. It is a single, highly cohesive monitoring dashboard. Splitting it artificially into multiple tiny files would violate Rule #5 and Rule #14.
- **Candidate Status**: **KEEP COHESIVE / NO CHANGE**.

#### 6. `api/client.ts`
- **Classifications Present**: **D** (HTTP fetch wrapper, auth headers, token storage, API endpoint methods).
- **Evaluation**: Central transport for the entire frontend application (108 consumer files). Domain client splitting carries non-trivial coupling risk for shared interceptors.
- **Candidate Status**: **DEFERRED / KEEP COHESIVE** (Explicitly protected under Section 9 & Section 19).

#### 7. `google_maps_playwright_scraper.py`
- **Classifications Present**: **I** (Playwright browser automation), **F** (DOM parsing, coordinate extraction), **L** (Stagnation & anti-bot error handling).
- **Evaluation**: Already decoupled in Phase 11.2 from discovery deduplication. Card parsing and browser scrolling are tightly coupled to the live Playwright page context.
- **Candidate Status**: **KEEP COHESIVE / DEFERRED** (Explicitly protected under Section 11 & Section 19).

#### 8. `google_maps_http_scraper.py`
- **Classifications Present**: **I** (Google Maps JSON RPC), **F** (Nested array extraction).
- **Evaluation**: 441 lines, highly focused on zero-overhead HTTP extraction. Single responsibility.
- **Candidate Status**: **KEEP COHESIVE / NO CHANGE**.

#### 9. `taxonomy_registry.py`
- **Classifications Present**: **B** (Relational graph traversal), **J** (Static taxonomy node definitions).
- **Evaluation**: 442 lines. Works closely with `CategoryNode` schemas. Cohesion is high.
- **Candidate Status**: **KEEP COHESIVE / NO CHANGE**.

#### 10. `entity_resolver.py`
- **Classifications Present**: **B** (Entity classification), **F** (Trust tier scoring).
- **Evaluation**: 276 lines. Cohesive, deterministic, side-effect-free.
- **Candidate Status**: **KEEP COHESIVE / NO CHANGE**.

#### 11. `message_strategy_service.py`
- **Classifications Present**: **B** (Outreach copy generation), **F** (Spintax template selection).
- **Evaluation**: 396 lines. Cohesive, deterministic TR/EN copy generation.
- **Candidate Status**: **KEEP COHESIVE / NO CHANGE**.

---

## 5. Candidate Prioritization & Risk Matrix

| Candidate | Safety | Benefit | Coupling | Testability | Composite Priority | Recommended Action |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **`lead_normalization.py`** (extract from `lead_ingest_service.py`) | **LOW RISK** | **HIGH** | **LOW** | **HIGH** | **P1 (Highest)** | **Execute in Batch 1**: Extract value builder, truncation, merge, and column constants. |
| **`category_taxonomy.py`** (extract from `query_expander.py`) | **LOW RISK** | **HIGH** | **LOW** | **HIGH** | **P2** | **Execute in Batch 2**: Extract static dictionary data to `data/category_taxonomy.py`. |
| **`useLeadFilters.ts`** (extract from `LeadCRMPage.tsx`) | **LOW RISK** | **HIGH** | **LOW** | **HIGH** | **P3** | **Execute in Batch 3**: Encapsulate filter states, reset, and URL param mapping. |
| `WhatsAppQrConnectModal.tsx` | HIGH RISK | MEDIUM | HIGH | LOW | DEFERRED | Do not modify (Section 8 & 19). |
| `api/client.ts` | HIGH RISK | LOW | HIGH | MEDIUM | DEFERRED | Do not modify (Section 9 & 19). |
| `google_maps_playwright_scraper.py` | MEDIUM RISK | LOW | HIGH | MEDIUM | KEEP COHESIVE | Do not modify (Section 11 & 19). |
| `AdminDeploymentPage.tsx` | LOW RISK | LOW | LOW | HIGH | KEEP COHESIVE | Do not modify (Rule 14). |
| `entity_resolver.py` | LOW RISK | LOW | LOW | HIGH | KEEP COHESIVE | Do not modify (Rule 14). |
| `message_strategy_service.py` | LOW RISK | LOW | LOW | HIGH | KEEP COHESIVE | Do not modify (Rule 14). |

---

## 6. Execution Plan (Maximum 3 Safe Batches)

Per Section 18 of the mandate, the execution phase is restricted to **3 low-risk, high-benefit batches**:

### Batch 1: Pure Lead Normalization Extraction (Backend)
- **New Module**: [`backend/app/services/lead_normalization.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/lead_normalization.py)
- **Contents**:
  - `LEAD_VALUE_COLS`: Immutable tuple of DB column names.
  - `truncate_column_value(val, limit)`: Defensive truncation helper.
  - `build_initial_custom_data(raw)`: Maps Google Maps URL into custom data JSON.
  - `build_lead_values(raw, name, e164, ...)`: Pure column dictionary constructor.
  - `merge_into_existing_lead(existing_lead, raw, e164, ...)`: In-place attribute backfill logic.
  - `compute_bulk_correlation_key(transient)`: Deterministic tuple key.
- **Modified Module**: [`backend/app/services/lead_ingest_service.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/lead_ingest_service.py)
  - Delegates value building and merging to `lead_normalization`.
  - Retains all transaction control, batch execution, deduplication prefetch, and savepoint rollbacks.
- **Verification**: `pytest backend/tests/test_lead_match_policy.py backend/tests/test_search_pipeline.py -v`.

### Batch 2: Static Taxonomy Data Extraction (Backend)
- **New Module**: [`backend/app/data/category_taxonomy.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/data/category_taxonomy.py)
- **Contents**:
  - `CATEGORY_TAXONOMY`: Pure data dictionary containing Turkish & English search keywords, directory slugs, text terms, and OSM amenities for all 7 primary industries.
- **Modified Module**: [`backend/app/services/query_expander.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/query_expander.py)
  - Imports `CATEGORY_TAXONOMY` from data module while preserving class-level reference `QueryExpander.CATEGORY_TAXONOMY = CATEGORY_TAXONOMY` for complete backward compatibility.
- **Verification**: `pytest backend/tests/test_search_pipeline.py -v`.

### Batch 3: CRM Filter Orchestration Hook & Selection Integration (Frontend)
- **New Hook**: [`frontend/src/features/leads/hooks/useLeadFilters.ts`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/features/leads/hooks/useLeadFilters.ts)
- **Contents**:
  - Encapsulates `search`, `selectedCity`, `selectedDistricts`, `selectedCategories`, `statusFilter`, `waOnly`, `page`, `pageSize`.
  - Exports `resetFilters`, `handleCityChange`, `handlePageChange`, and `buildQueryParams`.
- **Modified Page**: [`frontend/src/pages/LeadCRMPage.tsx`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/pages/LeadCRMPage.tsx)
  - Replaces 8 inline filter states and manual param building with `useLeadFilters`.
  - Integrates `useLeadSelection` for multi-row selection.
- **Verification**: `npm --prefix frontend run build`.

---

## 7. Approval & Sign-Off

The audit is complete and fully documented. Implementation will strictly adhere to the 3 low-risk batches above, preserving all existing runtime behavior, API contracts, and database integrity.
