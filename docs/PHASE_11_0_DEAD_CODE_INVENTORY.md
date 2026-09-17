# Phase 11.0 — Dead Code & Component Inventory

**Phase**: 11.0 — Codebase Architecture & Forensic Dead Code Audit  
**Date**: September 17, 2026  
**Classification Rules**:
* `CONFIRMED_USED`: Actively executed in production, route handling, tests, or imports.
* `PROBABLY_USED`: Public API contract, UI registry component, or future extension hook.
* `UNKNOWN`: Insufficient evidence to prove death; MUST NOT be deleted.
* `CONFIRMED_DEAD`: Proven to have 0 runtime references, 0 route references, 0 test references, 0 dynamic references, and 0 exports.

---

## 1. Frontend Component & Page Inventory (Conservative Rule)

As mandated by **Section 6 & Section 18**, every frontend component and page was forensically analyzed across direct imports, dynamic/lazy imports, route definitions in `App.tsx`, test scripts, and component barrel exports.

### 1.1 Pages & Admin Centers (15 Pages)
| Page Component | Direct Refs | Dynamic Refs | Route Refs | Test Refs | Export Refs | Verdict |
|---|---|---|---|---|---|---|
| `DashboardPage.tsx` | 0 | 0 | `App.tsx` (route `/`) | 0 | N/A | **CONFIRMED_USED** |
| `LeadFinderPage.tsx` | 0 | 0 | `App.tsx` (route `/lead-finder`) | 0 | N/A | **CONFIRMED_USED** |
| `LeadCRMPage.tsx` | 0 | 0 | `App.tsx` (route `/leads`) | 0 | N/A | **CONFIRMED_USED** |
| `CampaignsPage.tsx` | 0 | 0 | `App.tsx` (route `/campaigns`) | 0 | N/A | **CONFIRMED_USED** |
| `CampaignGroupsPage.tsx` | 0 | 0 | `App.tsx` (route `/campaign-groups`) | 0 | N/A | **CONFIRMED_USED** |
| `WhatsAppHubPage.tsx` | 0 | 0 | `App.tsx` (route `/whatsapp`) | `test-whatsapp-*.mjs` | N/A | **CONFIRMED_USED** |
| `BlacklistPage.tsx` | 0 | 0 | `App.tsx` (route `/blacklist`) | 0 | N/A | **CONFIRMED_USED** |
| `SettingsPage.tsx` | 0 | 0 | `App.tsx` (route `/settings`) | 0 | N/A | **CONFIRMED_USED** |
| `LoginPage.tsx` | 0 | 0 | `App.tsx` (route `/login`) | 0 | N/A | **CONFIRMED_USED** |
| `AdminOverviewPage.tsx` | 0 | 0 | `App.tsx` (route `/admin`) | `test_frontend_admin_scenarios.py` | N/A | **CONFIRMED_USED** |
| `AdminMonitoringPage.tsx` | 0 | 0 | `App.tsx` (route `/admin/monitoring`) | `test_frontend_admin_scenarios.py` | N/A | **CONFIRMED_USED** |
| `AdminWhatsAppPage.tsx` | 0 | 0 | `App.tsx` (route `/admin/whatsapp`) | `test_frontend_admin_scenarios.py` | N/A | **CONFIRMED_USED** |
| `AdminBackupsPage.tsx` | 0 | 0 | `App.tsx` (route `/admin/backups`) | `test_frontend_admin_scenarios.py` | N/A | **CONFIRMED_USED** |
| `AdminSecurityPage.tsx` | 0 | 0 | `App.tsx` (route `/admin/security`) | `test_frontend_admin_scenarios.py` | N/A | **CONFIRMED_USED** |
| `AdminDeploymentPage.tsx` | 0 | 0 | `App.tsx` (route `/admin/deployment`) | `test_frontend_admin_scenarios.py` | N/A | **CONFIRMED_USED** |

### 1.2 Layout & Admin Shell Components (4 Components)
| Component | Direct Refs | Dynamic Refs | Route Refs | Test Refs | Export Refs | Verdict |
|---|---|---|---|---|---|---|
| `Layout/Sidebar.tsx` | `App.tsx` | 0 | 0 | 0 | `Layout/index.ts` | **CONFIRMED_USED** |
| `Layout/TopHeader.tsx` | `App.tsx` | 0 | 0 | 0 | `Layout/index.ts` | **CONFIRMED_USED** |
| `Layout/Breadcrumb.tsx` | `App.tsx`, `LeadFinderPage.tsx`, etc. | 0 | 0 | 0 | `Layout/index.ts` | **CONFIRMED_USED** |
| `admin/AdminShell.tsx` | All 6 `Admin*Page.tsx` | 0 | 0 | 0 | Direct | **CONFIRMED_USED** |

### 1.3 Lead Finder Domain Components (3 Components)
| Component | Direct Refs | Dynamic Refs | Route Refs | Test Refs | Export Refs | Verdict |
|---|---|---|---|---|---|---|
| `CategoryMultiSelect.tsx` | `LeadFinderPage.tsx` | 0 | 0 | 0 | Direct | **CONFIRMED_USED** |
| `LocationMultiSelect.tsx` | `LeadFinderPage.tsx` | 0 | 0 | 0 | Direct | **CONFIRMED_USED** |
| `SectorAutocomplete.tsx` | `LeadFinderPage.tsx` | 0 | 0 | 0 | Direct | **CONFIRMED_USED** |

### 1.4 Domain Composite Components (13 Components)
| Component | Direct Refs | Dynamic Refs | Route Refs | Test Refs | Export Refs | Verdict |
|---|---|---|---|---|---|---|
| `CampaignCard.tsx` | `CampaignsPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `CampaignGroupCard.tsx` | `CampaignGroupsPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `ChatBubble.tsx` | `ChatThread.tsx`, `WhatsAppHubPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `ChatComposer.tsx` | `WhatsAppHubPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `ChatThread.tsx` | `WhatsAppHubPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `ConversationList.tsx` | `WhatsAppHubPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `LeadDetailDrawer.tsx` | `LeadCRMPage.tsx`, `WhatsAppHubPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `NewChatModal.tsx` | `WhatsAppHubPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `SessionCard.tsx` | `WhatsAppHubPage.tsx`, `AdminWhatsAppPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `SpintaxPreviewCard.tsx` | `CampaignsPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `TemplateSelectModal.tsx` | `WhatsAppHubPage.tsx`, `CampaignsPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `VerificationBadge.tsx` | `LeadCRMPage.tsx`, `ConversationList.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |
| `WhatsAppQrConnectModal.tsx` | `WhatsAppHubPage.tsx`, `AdminWhatsAppPage.tsx` | 0 | 0 | 0 | `domain/index.ts` | **CONFIRMED_USED** |

### 1.5 Data Display Components (5 Components)
| Component | Direct Refs | Dynamic Refs | Route Refs | Test Refs | Export Refs | Verdict |
|---|---|---|---|---|---|---|
| `ActivityTimeline.tsx` | `DashboardPage.tsx`, `LeadDetailDrawer.tsx` | 0 | 0 | 0 | `data-display/index.ts` | **CONFIRMED_USED** |
| `BusinessCell.tsx` | `LeadCRMPage.tsx`, `DataTable.tsx` | 0 | 0 | 0 | `data-display/index.ts` | **CONFIRMED_USED** |
| `DataTable.tsx` | `LeadCRMPage.tsx`, `BlacklistPage.tsx` | 0 | 0 | 0 | `data-display/index.ts` | **CONFIRMED_USED** |
| `ProgressFunnel.tsx` | `DashboardPage.tsx` | 0 | 0 | 0 | `data-display/index.ts` | **CONFIRMED_USED** |
| `TableToolbar.tsx` | `DataTable.tsx`, `LeadCRMPage.tsx` | 0 | 0 | 0 | `data-display/index.ts` | **CONFIRMED_USED** |

### 1.6 Forms Components (10 Components)
| Component | Direct Refs | Dynamic Refs | Route Refs | Test Refs | Export Refs | Verdict |
|---|---|---|---|---|---|---|
| `Checkbox.tsx` | `DataTable.tsx`, `Forms` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `FormField.tsx` | `CampaignsPage.tsx`, `SettingsPage.tsx` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `FormSection.tsx` | `SettingsPage.tsx`, `CampaignsPage.tsx` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `RadioGroup.tsx` | `CampaignsPage.tsx`, `SettingsPage.tsx` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `SearchInput.tsx` | `ConversationList.tsx`, `LeadCRMPage.tsx` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `Select.tsx` | `LeadFinderPage.tsx`, `SettingsPage.tsx` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `Slider.tsx` | `SettingsPage.tsx` (Anti-ban jitter) | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `Switch.tsx` | `SettingsPage.tsx`, `AdminSecurityPage.tsx` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `TextInput.tsx` | Used across all pages & modals | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |
| `Textarea.tsx` | `CampaignsPage.tsx`, `ChatComposer.tsx` | 0 | 0 | 0 | `forms/index.ts` | **CONFIRMED_USED** |

### 1.7 UI Primitives & Icons (33 Components)
All 33 UI components (`Accordion`, `Alert`, `Avatar`, `AvatarGroup`, `BulkActionToolbar`, `ButtonGroup`, `Chip`, `CircularProgress`, `ConfirmDialog`, `Drawer`, `Dropdown`, `EmptyState`, `HeroBanner`, `IconButton`, `IconTile`, `LanguageSwitcher`, `LoadingOverlay`, `Modal`, `PageHeader`, `Pagination`, `Progress`, `Skeleton`, `Spinner`, `StatsCard`, `StatusBadge`, `Tabs`, `Tooltip`, `TrendIndicator`, `badge`, `button`, `card`, `google-maps-icon`, `whatsapp-icon`) are **CONFIRMED_USED** in pages and domain composites.

### 1.8 Navigation Directory Stub
| Component / File | Direct Refs | Dynamic Refs | Route Refs | Test Refs | Export Refs | Verdict |
|---|---|---|---|---|---|---|
| `components/navigation/index.ts` | 0 | 0 | 0 | 0 | 0 (stub: `export {};`) | **CONFIRMED_DEAD** |

---

## 2. Backend Dead Code Inventory

### 2.1 Confirmed Dead Prototype Files (Abandoned Experiments)
| File Path | Description / History | References | Decision |
|---|---|---|---|
| `backend/app/scrapers/adapters/overpass_adapter.py` | Initial OSM Overpass prototype (Aug 24, 2026). Never exported or called. | 0 references across repo, tests & docs. | **CONFIRMED_DEAD** (Safe to remove) |
| `backend/app/services/discovery_budget.py` | V3 discovery rate limiter class. Never instantiated. | 0 references across repo, tests & docs. | **CONFIRMED_DEAD** (Safe to remove) |
| `backend/app/services/discovery_strategy.py` | V3 strategy enum and pydantic model. Never used. | 0 references across repo, tests & docs. | **CONFIRMED_DEAD** (Safe to remove) |
| `backend/app/services/discovery_benchmark.py` | Static benchmark dict for dental/solar/pet in Istanbul. Never referenced. | 0 references across repo, tests & docs. | **CONFIRMED_DEAD** (Safe to remove) |

### 2.2 Duplicate API Route
| Route | File Path | Issue | Resolution |
|---|---|---|---|
| `@router.get("/me")` | `backend/app/api/v1/endpoints/auth.py` | `native_auth_router` in `backend/app/auth/api/routes.py` already implements `/me`. Including both duplicates the OpenAPI definition. | **MERGE / DEDUPLICATE** (Remove shadowed handler in `endpoints/auth.py`) |

### 2.3 Unused Imports in Active Backend Files (84 Imports across 43 Files)
| File | Unused Import | Classification |
|---|---|---|
| `backend/app/api/v1/endpoints/analytics.py` | `from typing import Dict, Any, List`, `from sqlalchemy import or_` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/api/v1/endpoints/auth.py` | `from sqlalchemy.ext.asyncio import AsyncSession`, `from backend.app.core.database import get_db` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/api/v1/endpoints/campaign_groups.py` | `from typing import Optional` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/api/v1/endpoints/leads.py` | `from backend.app.core.search_utils import generate_tr_search_terms` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/api/v1/endpoints/scraper.py` | `from sqlalchemy import or_` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/api/v1/endpoints/smart_outreach.py` | `import os`, `from typing import List, Optional`, `AsyncSessionLocal` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/api/v1/websocket.py` | `from typing import List`, `from fastapi import WebSocketDisconnect` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/auth/api/dependencies.py` | `from uuid import UUID` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/auth/api/routes.py` | `from backend.app.auth.api.dependencies import get_current_user_unified` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/auth/application/oauth_service.py` | `from sqlalchemy import update` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/auth/application/session_service.py` | `from sqlalchemy import update` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/auth/domain/models.py` | `from pydantic import EmailStr` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/auth/infrastructure/google_provider.py` | `import time` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/core/search_utils.py` | `from sqlalchemy.sql.elements import BinaryExpression` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/models/blacklist.py` | `import json`, `from sqlalchemy import Index` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/scrapers/adapters/base_adapter.py` | `from backend.app.schemas.intelligence import SearchPlan` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/scrapers/adapters/directory_adapter.py` | `from backend.app.schemas.intelligence import QueryFamily` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/scrapers/adapters/osm_adapter.py` | `from backend.app.schemas.intelligence import QueryFamily` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/services/campaign_runner.py` | `from datetime import datetime`, `from sqlalchemy.ext.asyncio import AsyncSession` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/services/entity_graph_merger.py` | `from backend.app.services.phone_service import PhoneService` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/services/outreach_manager.py` | `from datetime import datetime` | CONFIRMED_DEAD (P0 cleanup) |
| `backend/app/services/smart_matching_service.py` | `from backend.app.models.lead import VerificationStatus`, `from backend.app.models.conversation import Conversation` | CONFIRMED_DEAD (P0 cleanup) |

---

## 3. WhatsApp Gateway Dead Code & Protocol Routing Inventory

### 3.1 Gateway Source Files (11 Files)
| File | Responsibility | Usage Status |
|---|---|---|
| `whatsapp-gateway/src/index.js` | Express HTTP server, WebSocket bridge client, session registry, outbox worker | **CONFIRMED_USED** |
| `whatsapp-gateway/src/session-manager.js` | Baileys socket lifecycle, creds update, messages.upsert, history sync | **CONFIRMED_USED** |
| `whatsapp-gateway/src/events.js` | WebSocket event bridge, queue management, ACK handling | **CONFIRMED_USED** |
| `whatsapp-gateway/src/observability.js` | Diagnostics logger, latency metrics, session references | **CONFIRMED_USED** |
| `whatsapp-gateway/src/auth/postgres-auth-repository.js` | Encrypted session auth state persistence in PostgreSQL | **CONFIRMED_USED** |
| `whatsapp-gateway/src/auth/encrypted-codec.js` | AES-256-GCM cipher/decipher for session state and outbox events | **CONFIRMED_USED** |
| `whatsapp-gateway/src/database/postgres-pool.js` | PostgreSQL connection pool for gateway outbox and session lease | **CONFIRMED_USED** |
| `whatsapp-gateway/src/domain/bounded-cache.js` | In-memory LRU cache preventing OOM under high message volume | **CONFIRMED_USED** |
| `whatsapp-gateway/src/domain/socket-lifecycle.js` | State machine tracking connecting, open, closing, closed states | **CONFIRMED_USED** |
| `whatsapp-gateway/src/lease/postgres-session-lease.js` | Distributed lease preventing split-brain Baileys socket execution | **CONFIRMED_USED** |
| `whatsapp-gateway/src/outbox/postgres-event-outbox.js` | Durable transactional outbox for gateway-to-backend events | **CONFIRMED_USED** |

### 3.2 Gateway Helper Exports
All helper functions exported by `session-manager.js` (`sanitizeChatForEmit`, `mergeContactName`, `normalizePreviewText`, `buildChatPreview`, `isRawIdentityName`, `jidToPhone`, `classifyMessageType`, `resolveDownloadableMedia`, etc.) are actively tested by the 15 unit test scripts in `whatsapp-gateway/scripts/`. **None are dead.**

---

## 4. Scripts Inventory & Classification

| Script Path | Classification | Purpose & References |
|---|---|---|
| `scripts/monitor_health.sh` | **PRODUCTION / OBSERVABILITY** | Executed by `tezlify-monitor.service` systemd timer every 60s. High criticality. |
| `scripts/whatsapp_reliability_collector.py` | **PRODUCTION / OBSERVABILITY** | Executed by `tezlify-wa-observer.service` systemd timer. Collects connection telemetry. |
| `scripts/db_long_run_observer.py` | **OBSERVABILITY / TEST** | Used for database forensic profiling and runtime query sampling. |
| `backend/scripts/benchmark_native_auth.py` | **TEST / BENCHMARK** | Standalone benchmark suite for native session token throughput. |
| `backend/scripts/migrate_phase_10_7_indexes.py` | **MIGRATION / ONE-OFF** | Standalone CLI for phase 10.7 PostgreSQL index deployment. |
| `backend/scripts/migrate_profiles_to_auth_users.py` | **MIGRATION / ONE-OFF** | Data backfill helper for profile-to-auth-user migration. |
| `backend/scripts/monitor_phase_8_5.py` | **LEGACY / DEBUG** | Historical phase 8.5 monitor. |
| `backend/scripts/test_phase_8_2_production_e2e.py` | **TEST / LEGACY** | Historical phase 8.2 end-to-end integration test. |
| `backend/scripts/test_staging_playwright_auth.py` | **TEST** | Staging environment browser automation test. |
| `frontend/scripts/test-whatsapp-chat-scroll.mjs` | **TEST** | Verifies chat scroll restoration and message container heights. |
| `frontend/scripts/test-whatsapp-message-merge.mjs` | **TEST** | Verifies deduplicated message merge algorithm performance (<2ms). |
| `whatsapp-gateway/scripts/test-*.mjs` (15 scripts) | **TEST** | Comprehensive gateway unit and integration test suite (15/15 passing). |

---

## 5. Dependency Inventory

### 5.1 Backend Dependencies (`backend/requirements.txt`)
* Total Packages: 21
* Unused Packages: **0**
* All 21 packages (`fastapi`, `uvicorn`, `pydantic`, `sqlalchemy`, `aiosqlite`, `greenlet`, `httpx`, `beautifulsoup4`, `phonenumbers`, `pandas`, `openpyxl`, `pytest`, `pytest-asyncio`, `python-multipart`, `websockets`, `playwright`, `asyncpg`, `psycopg2-binary`, `pyjwt`, `cryptography`, `pydantic-settings`) are actively used.

### 5.2 Frontend Dependencies (`frontend/package.json`)
* **Unused Packages** (0 references across all TSX/TS files):
  1. `@radix-ui/react-dialog`
  2. `@radix-ui/react-dropdown-menu`
  3. `@radix-ui/react-select`
  4. `@radix-ui/react-tabs`
  5. `@radix-ui/react-tooltip`
  6. `canvas-confetti`
  7. `framer-motion`
  8. `@types/canvas-confetti`
* **Used Packages**: `react`, `react-dom`, `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`.
* **Action**: Safe to remove unused packages in P1 refactor to streamline npm install and reduce vulnerability attack surface.

### 5.3 WhatsApp Gateway Dependencies (`whatsapp-gateway/package.json`)
* Total Packages: 8 (`@whiskeysockets/baileys`, `dotenv`, `express`, `pg`, `pino`, `qrcode`, `uuid`, `ws`)
* Unused Packages: **0** (100% utilized).
