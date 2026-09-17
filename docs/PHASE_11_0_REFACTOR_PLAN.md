# Phase 11.0 — Safe Refactor Plan & Execution Matrix

**Phase**: 11.0 — Professional Codebase Architecture, Dead Code Audit & Safe Refactoring  
**Date**: September 17, 2026  
**Safety Contract**: Apply ONLY evidence-backed, behavior-preserving, low-risk changes (P0, P1, P2). P3 and P4 are documented and deferred to protect production stability and WhatsApp invariants.

---

## 1. Prioritization Hierarchy

| Priority Tier | Description | Scope in Phase 11.0 | Risk Level |
|---|---|---|---|
| **P0** | Confirmed Dead Code & Duplicate Routes | **EXECUTE** | Very Low |
| **P1** | Safe Duplication Removal, Unused Dependencies & Hot-Path Optimizations | **EXECUTE** | Low |
| **P2** | Safe Folder / Artifact Cleanup | **EXECUTE** | Very Low |
| **P3** | Frontend State Hook Decomposition (`WhatsAppHubPage.tsx`) | **DOCUMENT & DEFER** | Medium |
| **P4** | Core Service Architectural Decomposition (`whatsapp_service.py`, `session-manager.js`) | **DOCUMENT & DEFER** | High |

---

## 2. P0: Confirmed Dead Code Removal & Duplicate Route Resolution

### 2.1 P0-1: Delete Confirmed Dead Prototype Files
* **Target Files**:
  1. `backend/app/scrapers/adapters/overpass_adapter.py`
  2. `backend/app/services/discovery_budget.py`
  3. `backend/app/services/discovery_strategy.py`
  4. `backend/app/services/discovery_benchmark.py`
* **Evidence**:
  - 0 references in `backend/app/`
  - 0 references in `backend/tests/`
  - 0 references in `frontend/`
  - 0 references in `scripts/`
  - 0 references in `docs/`
* **Safety**: Behavior completely preserved; eliminates 4 abandoned prototype files from initial release.

### 2.2 P0-2: Remove Empty Navigation Barrel
* **Target File**: `frontend/src/components/navigation/index.ts`
* **Evidence**: File only contains `export {};`. 0 imports across `frontend/src`.

### 2.3 P0-3: Eliminate Duplicate Route in `endpoints/auth.py`
* **Target File**: `backend/app/api/v1/endpoints/auth.py`
* **Issue**: Lines 15-20 declare `@router.get("/me")` which duplicates `@router.get("/me")` already exposed by `native_auth_router` in `backend/app/auth/api/routes.py`.
* **Fix**: Remove the shadowed duplicate handler in `endpoints/auth.py`.

### 2.4 P0-4: Clean Up 84 Unused Imports across 43 Backend Files
* **Target Files**: 43 backend files (e.g. `analytics.py`, `scraper.py`, `campaign_runner.py`, `search_utils.py`, `smart_outreach.py`).
* **Fix**: Remove unused imports identified by AST analysis.

### 2.5 P0-5: Remove Untracked Legacy DB Artifact
* **Target File**: `scoutify.db` (5.2 MB untracked local SQLite file from pre-rebrand era).

---

## 3. P1: Safe Duplication Removal & Dependency Streamlining

### 3.1 P1-1: Remove Unused Frontend npm Dependencies
* **Target File**: `frontend/package.json`
* **Packages to Remove**:
  - `@radix-ui/react-dialog`
  - `@radix-ui/react-dropdown-menu`
  - `@radix-ui/react-select`
  - `@radix-ui/react-tabs`
  - `@radix-ui/react-tooltip`
  - `canvas-confetti`
  - `framer-motion`
  - `@types/canvas-confetti`
* **Evidence**: 0 imports across all 83 frontend components and pages. The app utilizes custom Vuexy primitives.
* **Safety**: Build tested with `npm --prefix frontend run build`.

### 3.2 P1-2: Hoist Translation Table in `search_utils.py`
* **Target File**: `backend/app/core/search_utils.py`
* **Optimization**: Move `str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")` to module-level constant `_TR2ASCII_TRANS`. Avoids repeatedly compiling the translation mapping on every search term loop.

### 3.3 P1-3: Mitigate Deprecation Warnings (`datetime.utcnow()`)
* **Target Files**: Key backend services generating 60,000+ warnings during test runs.
* **Optimization**: Standardize on `datetime.now(timezone.utc)` to prevent warning allocation storms.

---

## 4. P2: Safe File & Artifact Hygiene

* Ensure `.gitignore` properly covers all scratch, test SQLite, and benchmark outputs.
* Retain operational scripts in `scripts/` (`monitor_health.sh`, `whatsapp_reliability_collector.py`) untouched.

---

## 5. P3 & P4: Deferred Architectural Improvements (Future Phases)

### P3 (Phase 12 Candidate):
* Extract stateful custom hooks from `frontend/src/pages/WhatsAppHubPage.tsx`:
  - `useWhatsAppChatState` (active thread, drafts, pending sends)
  - `useWhatsAppSessionRegistry` (session status, QR pairing modals)

### P4 (Phase 13 Candidate):
* Decompose `backend/app/services/whatsapp_service.py` into focused domain services:
  - `WhatsAppSessionService`: QR, authentication, and session lease management.
  - `WhatsAppEventIngestService`: Gateway event dispatch and deduplication.
  - `WhatsAppChatService`: Message sending, reactions, media decrypt proxy.
* Strict Requirement: Require zero regression across all 725 pytest cases and all WhatsApp stability invariants before merging.

---

## 6. Execution & Verification Pipeline

```text
1. Execute P0 & P1 changes locally
2. Run full backend pytest suite (pytest backend/tests/ -q) -> Ensure 725/725 pass
3. Run python -m compileall backend/app -> Ensure 0 syntax/import errors
4. Run npm run build in frontend -> Ensure 0 build errors
5. Run all gateway test scripts (whatsapp-gateway/scripts/test-*.mjs) -> Ensure 15/15 pass
6. Commit changes to git
7. Push to origin/main
8. Pull on production (ubuntu@130.162.247.20:/opt/tezlify)
9. Rebuild production containers (docker compose -f docker-compose.prod.yml build)
10. Deploy production containers (docker compose -f docker-compose.prod.yml up -d)
11. Verify health & read-only WhatsApp session state on production
```
