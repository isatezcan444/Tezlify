# Tezlify — Final Verification Baseline & System Configuration

**Audit Mode:** Independent Principal QA & Security Audit Baseline  
**Audit Date:** 2026-09-01  
**Target Git Commit:** `9d4ff7c1b77e2a78f6cb4f02fc583407ec244f01`  

---

## 1. Environment & Runtime Baseline

| Parameter | Baseline Value | Verification Method |
| :--- | :--- | :--- |
| **Git Commit** | `9d4ff7c1b77e2a78f6cb4f02fc583407ec244f01` | `git rev-parse HEAD` |
| **Python Version** | `Python 3.14.7` | `python --version` (in virtualenv) |
| **Node.js Version** | `v24.15.0` | `node --version` |
| **npm Version** | `11.12.1` | `npm --version` |
| **Backend Framework** | `FastAPI 0.141.1`, `Starlette 1.6.0`, `Pydantic 2.13.4` | `pip list` |
| **ORM & Async Engine** | `SQLAlchemy 2.0.52`, `aiosqlite 0.22.1` | `pip list` |
| **Test Frameworks** | `pytest 9.1.1`, `pytest-asyncio 1.4.0`, `pytest-cov 7.1.0`, `pytest-randomly 4.1.0` | `pip list` |
| **E2E Automation** | `playwright 1.62.0` (Chromium Headless) | `pip list` |
| **Frontend Framework** | `React 18.3.1`, `TypeScript 5.5.3`, `Vite 5.4.21`, `Tailwind CSS 3.4.1` | `frontend/package.json` |

---

## 2. Database & Application Configuration

- **Development DB Engine:** SQLite via `aiosqlite` (`sqlite+aiosqlite:///./tezlify.db`).
- **Test DB Engine:** Isolated SQLite file databases per worker / clean temporary DB instances.
- **Connection Management:** Async connection pool with WAL mode (`PRAGMA journal_mode=WAL`).
- **Total Backend Statements:** 5,648 statements across 68 Python modules.
- **Frontend Codebase:** 1,589 transformed modules (Vite bundle).
- **Localization Baseline:** 684 localized keys in `frontend/src/locales/tr.ts` and `frontend/src/locales/en.ts`.

---

## 3. Test Inventory & Suite Baseline

| Suite Category | File Count | Collected Test Count | Directory Location |
| :--- | :--- | :--- | :--- |
| **Existing Regression Suite** | 28 files | **239 tests** | `backend/tests/` |
| **Stability Lifecycle Suite** | 10 files | **36 tests** | `backend/tests/stability/` |
| **Adversarial Robustness Suite**| 10 files | **30 tests** | `backend/tests/adversarial/` |
| **Total Pytest Inventory** | **48 files** | **305 tests** | `backend/tests/` |
| **Deep Playwright E2E Suite** | 1 runner | **6 user journeys** | `scratch/test_playwright_deep_e2e.py` |
| **Total Automated Tests** | — | **311 tests** | Backend + Frontend |

---

## 4. Existing Known Findings & Classification Baseline

- **`ADV-CONC-01` (Medium):** Concurrency race condition where simultaneous group deletion and member insert can leave an orphaned junction row when SQLite foreign keys are not enforced per async connection.
- **`ADV-SEC-01` (Low):** Development fallback in Meta Webhook signature verification when `WHATSAPP_CLOUD_APP_SECRET` is left empty.
- **`ADV-UX-01` (Info):** Boundary parameter validation on inverted lead filter ranges (`min_rating > max_rating`).
