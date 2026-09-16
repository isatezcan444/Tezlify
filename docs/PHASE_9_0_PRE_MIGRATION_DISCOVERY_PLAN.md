# PHASE 9.0 — VERCEL → ORACLE FRONTEND MIGRATION
## PRE-MIGRATION DISCOVERY + ZERO-DOWNTIME CUTOVER PLAN

**Timestamp:** 2026-09-16 11:10:00 UTC (14:10:00 TSİ)  
**Status:** DISCOVERY & MIGRATION DESIGN COMPLETE  
**Production Changes:** ZERO (0)  
**Next Phase:** PHASE 9.1 — ORACLE FRONTEND STAGING IMPLEMENTATION  

---

## 1. Executive Summary

Phase 9.0 conducts the architectural discovery, dependency auditing, and zero-downtime cutover design required to migrate Tezlify's frontend hosting from Vercel (`https://tezlify-woad.vercel.app`) to Oracle Cloud VM (`130.162.247.20`) served directly by the existing `tezlify-caddy` container.

### Key Discoveries:
1. **Zero Vercel NPM Dependencies**: The frontend codebase has no runtime Vercel SDK or platform lock-in. The only references are host sniffing in `client.ts` (`isVercel`) and static rewrites in `vercel.json`.
2. **Abundant Host Resources**: Oracle Cloud VM has 24 GB RAM (21 GB free) and 87 GB available NVMe storage. Serving static assets adds virtually zero memory or CPU overhead.
3. **Caddy Native Capabilities**: The existing `caddy:2-alpine` container supports `file_server`, `try_files {path} /index.html`, `encode gzip zstd`, and deterministic `handle` blocks out-of-the-box.
4. **Auth & WebSocket Synergy**: Migrating the frontend to the same origin as the API eliminates cross-origin cookie restrictions (Safari/Firefox Third-Party Cookie blocking), obviates CORS preflight overhead for `/api/v1`, and aligns WebSocket connectivity directly to `wss://${window.location.host}/ws`.
5. **Zero Downtime / Zero Risk Rollback**: Vercel remains untouched during staging and initial cutover, providing an instantaneous hot-standby fallback.

---

## 2. Current Architecture vs. Target Architecture

```
CURRENT ARCHITECTURE (Vercel + Oracle Hybrid):
User Browser
  ├── [HTTPS] → Vercel CDN (tezlify-woad.vercel.app)
  │               ├── Static Assets (index.html, js, css)
  │               └── Proxy Rewrite: /api/* ──┐
  │                                           │ (Cross-origin HTTPS)
  └── [WSS] ────────────────────────┐         │
                                    ▼         ▼
                     Oracle VM Caddy (api.130.162.247.20.sslip.io)
                                    ├── reverse_proxy: /api/* → backend:8000
                                    └── reverse_proxy: /ws    → backend:8000
                                                                   │
                                                                   ├── PostgreSQL
                                                                   └── WhatsApp Gateway

TARGET ARCHITECTURE (100% Oracle Cloud Unified Stack):
User Browser
  └── [HTTPS / WSS] → Oracle VM Caddy (:443)
                        ├── Static File Server: / (React SPA dist)
                        │     └── try_files {path} /index.html
                        ├── reverse_proxy: /api/* → backend:8000
                        └── reverse_proxy: /ws    → backend:8000
                                                       │
                                                       ├── PostgreSQL
                                                       └── WhatsApp Gateway
```

---

## 3. Frontend Inventory & Build Verification

- **Framework:** React 18.3.1, Vite 5.2.11, TypeScript 5.4.5, TailwindCSS 3.4.19.
- **Build Verification:**
  - Command: `npm run build` (`tsc && vite build`)
  - Execution Time: 1.41 seconds
  - Output Path: `frontend/dist`
  - Asset Breakdown:
    - `index.html`: 1.19 kB (0.68 kB gzip)
    - `assets/index-CUKl8vVj.css`: 79.38 kB (12.76 kB gzip)
    - `assets/index-DQi-tCpB.js`: 690.76 kB (187.20 kB gzip)
  - Asset Paths: Root-relative (`/assets/...`), completely portable.
  - SPA Routing: State-driven tab routing (`activeTab`), query param OAuth hydration (`?session_token=...`), history state cleaning.

---

## 4. Vercel Dependency Audit & Classification

| Occurrence | Location | Classification | Migration Action in Phase 9.1 |
|---|---|---|---|
| `isVercel = host.includes('vercel.app')` | `frontend/src/api/client.ts:21` | VERCEL-SPECIFIC | Refactor to enable same-origin `/api/v1` regardless of hostname |
| `vercel.json` | Project Root | VERCEL-SPECIFIC | Keep intact during Phase 9.0/9.1; remove only after full cutover |
| `FRONTEND_ORIGIN` default | `backend/app/auth/api/routes.py:25` | CONFIGURABLE | Update `.env.production` on server to Oracle frontend URL when cutover happens |
| `allow_origin_regex` | `backend/app/main.py:147` | ORACLE-SPECIFIC | Already matches `.sslip.io` and `tezlify.com`; zero changes needed |
| `test_phase_8_2_production_e2e.py` | `backend/scripts/` | HISTORICAL | Test script pointing to Vercel URL; update in validation phase |

---

## 5. Oracle Caddy Hosting Model & Configuration Design

### Recommended Architecture: Option A + D
Mount `/opt/tezlify/frontend_current:/srv/frontend:ro` directly into the existing `tezlify-caddy` container.

### Caddy Routing Design:
```caddy
{
    auto_https disable_redirects
}

:443 {
    tls internal {
        on_demand
    }

    # 1. Caddy internal health check
    handle /caddy-health {
        respond "OK" 200
    }

    # 2. Backend API routing
    handle /api/* {
        reverse_proxy backend:8000 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-Proto https
        }
    }

    # 3. Realtime WebSocket routing
    handle /ws* {
        reverse_proxy backend:8000 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-Proto https
        }
    }

    # 4. Backend health and API documentation
    handle /health {
        reverse_proxy backend:8000
    }
    handle /docs* {
        reverse_proxy backend:8000
    }
    handle /openapi.json {
        reverse_proxy backend:8000
    }

    # 5. Static Assets (immutable caching)
    handle /assets/* {
        root * /srv/frontend
        header Cache-Control "public, max-age=31536000, immutable"
        file_server
    }

    # 6. SPA Root & Fallback (no-cache for index.html)
    handle {
        root * /srv/frontend
        try_files {path} /index.html
        header Cache-Control "no-cache, no-store, must-revalidate"
        file_server
    }
}
```

---

## 6. Same-Origin & Auth Compatibility Matrix

| Aspect | Vercel (Current) | Oracle Same-Origin (Target) | Advantage |
|---|---|---|---|
| **API Calls** | Rewritten via Vercel proxy or CORS cross-origin | Same-origin `/api/v1` | Zero CORS preflights, lower latency |
| **WebSocket** | Direct to Oracle `wss://api...` (Cross-origin) | Same-origin `wss://${host}/ws` | Single TLS handshake, no third-party domain |
| **HttpOnly Cookie** | Cross-origin Lax cookie requiring token query param fallback | Same-origin Lax cookie natively attached to all requests | Superior browser security & Safari ITP immunity |
| **Google OAuth Callback** | Hits Oracle backend, redirects to Vercel origin | Hits Oracle backend, redirects to same Oracle origin | No cross-origin token handover in URL |
| **CORS Overhead** | Required regex matching | Unnecessary for same-origin requests | Maximum throughput |

---

## 7. Zero-Downtime Rollback & Deployment Protocol

1. **Release Directory Structure:**
   ```
   /opt/tezlify/frontend_releases/
   ├── v20260916_140000/
   └── v20260916_150000/
   /opt/tezlify/frontend_current -> /opt/tezlify/frontend_releases/v20260916_150000
   ```
2. **Rollback Action A (Vercel Fallback):**
   Vercel deployment is never deleted or modified during cutover. If any regression occurs, DNS/bookmarks pointing to `https://tezlify-woad.vercel.app` remain 100% operational.
3. **Rollback Action B (Oracle Rollback):**
   Execute `ln -sfn /opt/tezlify/frontend_releases/v_PREV /opt/tezlify/frontend_current` (takes <1 millisecond). Caddy automatically serves previous assets without container restart.
4. **Data & WhatsApp Isolation:**
   Frontend deployment does NOT restart backend, gateway, or PostgreSQL. WhatsApp Session 43 and socket leases maintain 100% uptime.
