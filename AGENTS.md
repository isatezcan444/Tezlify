# Tezlify - AI Agent Development & System Rules

Tezlify is an AI-assisted, production-grade B2B Lead Generation & Outreach Platform.
This document defines the core architecture, non-negotiable rules, invariants, and guidelines for any AI agent or engineer extending the codebase.

---

## 1. Core Architectural Invariants

### 1.1 Truthfulness
- **No False Positives**: Never mask exceptions or failures as `{"success": True}`. If an outreach dispatch cannot happen, it MUST be reported as failed, never as sent.
- **WhatsApp Live Integration**: The project ships a three-tier WhatsApp live integration:
  1. **Gateway** (`whatsapp-gateway/`): Node.js + `@whiskeysockets/baileys` service (QR pairing, session lifecycle, encrypted auth state, event bridge).
  2. **Backend** (`backend/`): FastAPI proxy endpoints (`/api/v1/whatsapp/*`), `/ws/gateway` WebSocket for inbound gateway events, `WhatsAppSession` model.
  3. **Frontend** (`frontend/`): `WhatsAppApi` live client, `WhatsAppRepository` live+mock fallback, `WhatsAppHubPage` live mode.
  - When the gateway/backend is unreachable, all WhatsApp operations **fail closed** — no mock data, no simulations, no false-positive success. The UI surfaces the error to the user.

### 1.2 Single Source of Truth for Anti-Ban Policy
- All jitter delays, mesai (working hours) limits, and humanized delays MUST be resolved via `AntibanPolicy`.
- Working hours validation is **FAIL-CLOSED** (`is_within_working_hours` returns `False` if parsing fails).
- Anti-Ban settings are persisted in the database via `/api/v1/settings/antiban` and synced to the UI.

### 1.3 Data Integrity & Phone Numbers
- `Lead.phone_e164` is **nullable**. Never synthesize fake phone numbers (`+90000...`) for places without a phone number.
- Places without a phone number are saved with `phone_e164 = None` and `is_whatsapp_eligible = False`.
- `place_id` must use deterministic hashing: `hashlib.sha256(url.encode()).hexdigest()[:16]` (never process-local `hash()`).
- Ingestion and deduplication are handled centrally by `LeadIngestService`.

### 1.3.1 WebSocket
- The `/ws` WebSocket endpoint and `ws_manager` are shared infrastructure used by scraper progress, campaign progress broadcasts, and WhatsApp gateway event bridging (`/ws/gateway`). They must be preserved.
- The `/ws/gateway` endpoint is the inbound bridge for Baileys gateway events (fail-closed token auth via `WHATSAPP_GATEWAY_SECRET`). Gateway events are persisted and broadcast to connected frontend clients via the shared `ws_manager`.

### 1.4 Scraper Pipeline Integrity ("İşletme Ara")
- The Google Maps / Places scraper with Playwright and streaming HTTP extraction must NEVER be degraded.
- Multi-district expansion, satellite-tuner dynamic streaming, and real-time WebSocket progress broadcasts (`scraper_progress`, `scraper_completed`) must be preserved.
- Scraper concurrency is bounded by `settings.SCRAPER_MAX_CONCURRENT_TASKS` via semaphore.

---

## 2. Backend Coding Standards

- **Language & Framework**: Python 3.12+, FastAPI, SQLAlchemy 2.0 (AsyncIO), Pydantic v2.
- **Strict Typing**: All service methods and endpoints must have complete type hints.
- **Thin Routers / Fat Services (SRP)**: Endpoints in `backend/app/api/v1/endpoints/` handle HTTP validation, query parsing, and delegating to domain services (`LeadIngestService`, `CampaignRunner`, `OutreachManager`, `ExportService`).
- **Security**:
  - CORS origins are loaded from `settings.BACKEND_CORS_ORIGINS`.
  - Credentials/tokens must never be committed; the WhatsApp gateway encrypts session auth state at rest via `GATEWAY_ENCRYPTION_KEY` (AES-256).

---

## 3. Frontend Standards (Vuexy Design System)

- **Framework**: React 18, TypeScript, Vite, Tailwind CSS.
- **UI Aesthetic**: Rich, modern Vuexy theme with glassmorphism card surfaces, dark mode support, and vibrant badges.
- **Modal & Dialog Stacking**:
  - Full-screen fixed modals must be portaled to `document.body` via `createPortal(..., document.body)` with `z-[99999]`.
  - Native `window.alert()` and `window.confirm()` are strictly forbidden. Always use `useToast()` (`toast.success`, `toast.error`, `await toast.confirm(...)`).
- **Performance & Responsiveness**:
  - Search inputs must use debouncing (e.g. 300ms) to avoid request storms and race conditions.
  - File exports must check `res.ok` and revoke blob URLs (`window.URL.revokeObjectURL`).
  - Base URLs must respect `import.meta.env.VITE_API_URL`.
- **Centralized Localization (i18n) Invariant**:
  - All user-facing strings, button labels, table headers, placeholders, badges, modals, and toasts MUST be resolved via `useI18n()` (`t('domain.key')`).
  - Hardcoded natural language strings in JSX/TSX components are strictly forbidden.
  - Both English (`en`) (default) and Turkish (`tr`) dictionaries in `frontend/src/locales/` must always be maintained in full synchronization.
  - Language selection must persist in `localStorage` (`tezlify_lang`).
- **Centralized Component System & Registry Invariant**:
  - All UI elements must follow the design contracts in [`docs/UI_COMPONENT_RULES.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/UI_COMPONENT_RULES.md) and [`docs/component-registry.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/component-registry.md).
  - Page-specific ad-hoc duplicate components are strictly prohibited.
  - Any new reusable UI component or domain composite created during development must be automatically registered in `docs/component-registry.md` and exported via the corresponding `components/<category>/index.ts` barrel.

---

## 4. Test Discipline

- All backend changes must be verified against pytest:
  ```bash
  source venv/bin/activate && PYTHONPATH=. pytest backend/tests/ -v
  ```
- All frontend changes must pass TypeScript compilation and build:
  ```bash
  cd frontend && npm run build
  ```
