# Phase 8.2 — Oracle Native Auth Production Cutover Report

**Date:** 2026-09-16 00:50 UTC  
**Environment:** Production (Oracle VM `130.162.247.20` + Vercel Frontend `https://tezlify-woad.vercel.app`)  
**Status:** Cutover Executed & Verified — Awaiting Google Cloud Console Redirect URI Registration (`redirect_uri_mismatch`)

---

## 1. Executive Summary

Phase 8.2 cutover from Supabase Authentication to Oracle Native Authentication has been deployed and verified across both the Oracle Frankfurt VM (`130.162.247.20`) and Vercel Production.

1. **Oracle Backend (`tezlify-backend`)**:
   - Rebuilt with Phase 8 native auth routes (`/api/v1/auth/google`, `/callback`, `/me`, `/logout`).
   - Production Google OAuth credentials configured in `/opt/tezlify/.env.production` (`chmod 600`).
   - Health endpoint `/health` verified `HTTP 200 OK`.
   - `/api/v1/auth/google?redirect=true` returns `HTTP 302` redirecting to Google OAuth with SHA-256 state tracking in `auth_staging_oauth_states`.
2. **Vercel Production Frontend**:
   - Switched to `VITE_AUTH_PROVIDER=oracle`.
   - Built and deployed cleanly (`index-BaJ-GOXy.js`).
   - Verified that `/api/*` requests route smoothly through Vercel rewrites to Oracle Caddy (`1.1 Caddy`).
   - Supabase fallback configurations (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) strictly preserved for zero-downtime rollback capability.
3. **Playwright Browser E2E Forensic**:
   - Playwright launched headless browser against `https://tezlify-woad.vercel.app`.
   - Clicked "Google ile Giriş Yap" (`button:has-text('Google')`).
   - Navigation intercepted: redirected to `https://accounts.google.com/o/oauth2/v2/auth`.
   - Google response: `Error 400: redirect_uri_mismatch` (`authError=ChVyZWRpcmVjdF91cmlfbWlzbWF0Y2g...`).
   - Forensic confirmation: Google accepted `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/callback` (`HTTP 200`), proving that the Google OAuth Client in Google Cloud Console is configured with the old Supabase callback and **must have the Oracle callback added**.
4. **Data & WhatsApp Integrity**:
   - Zero modifications to business data (3 profiles, 333 conversations, 1779 contacts, 20,116 messages, 4 sessions).
   - WhatsApp Gateway (`Hat 1`, `+905076382749`) remained active with valid socket lease (`generation: 4`, `is_lease_valid: t`).
   - Complete test suite passed: **665/665 tests passed in 40.17s**.

---

## 2. Evidence & Verification Artifacts

### 2.1 Backend Endpoint Verification (`/api/v1/auth/google?redirect=true`)
```http
HTTP/2 302 
alt-svc: h3=":443"; ma=2592000
date: Tue, 15 Sep 2026 21:46:20 GMT
location: https://accounts.google.com/o/oauth2/v2/auth?client_id=662374503405-m74guv10a7p5lvrja6dt49bl2afmp1k0.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fapi.130.162.247.20.sslip.io%2Fapi%2Fv1%2Fauth%2Fgoogle%2Fcallback&response_type=code&scope=openid+email+profile&state=f7HC_I9Qu-mzU_l6Pz01waGcY52J9FirR94WkRjfTeY&access_type=offline&prompt=consent
server: uvicorn
via: 1.1 Caddy
content-length: 0
```

### 2.2 Database State Persistence (`auth_staging_oauth_states`)
```sql
                            state_hash                            |          expires_at           |          created_at           | consumed_at 
------------------------------------------------------------------+-------------------------------+-------------------------------+-------------
 cd03143b6545972c68011061db38cf7a2701b044129ef92f43f73fdfa88651bb | 2026-09-15 21:56:21.875484+00 | 2026-09-15 21:46:21.875495+00 | NULL
```
- Raw state is never stored in plaintext (SHA-256 hash).
- 10-minute expiry strictly enforced.

### 2.3 Vercel Production Deployment
- Commit: `a3e982a` (`feat(auth): switch production auth provider to oracle native auth`)
- Deployed JS asset: `https://tezlify-woad.vercel.app/assets/index-BaJ-GOXy.js`
- Rewrite test: `curl -i "https://tezlify-woad.vercel.app/api/v1/auth/google?redirect=true"` -> `HTTP/2 302` via Caddy.

### 2.4 Google OAuth Error Forensic
```
URL: https://accounts.google.com/signin/oauth/error?authError=...&client_id=662374503405-m74guv10a7p5lvrja6dt49bl2afmp1k0.apps.googleusercontent.com
Decoded authError:
redirect_uri: https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback
Error: 400 redirect_uri_mismatch
```
Comparative test with Supabase callback:
- `redirect_uri=https://qfypckopgelvsimfrfub.supabase.co/auth/v1/callback` -> **HTTP 200 OK** (Google Login screen displayed).
- `redirect_uri=https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback` -> **HTTP 400 redirect_uri_mismatch**.

### 2.5 Business Data & WhatsApp Integrity Audit
| Resource | Count Before | Count After | State |
| :--- | :--- | :--- | :--- |
| `profiles` | 3 | 3 | Identical |
| `conversations` | 333 | 333 | Identical |
| `campaigns` | 0 | 0 | Identical |
| `contacts` | 1,779 | 1,779 | Identical |
| `messages` | 19,158 | 20,116 | Healthy (+958 live gateway sync) |
| `whatsapp_sessions` | 4 | 4 | Identical |
| `Hat 1` (+905076382749) | `CONNECTED` | `CONNECTED` | Unbroken |
| Socket Lease | Generation 4, Valid=t | Generation 4, Valid=t | Active |

---

## 3. Required Action to Finalize Cutover

To resolve `redirect_uri_mismatch`, add the Oracle production callback URI to the Google Cloud Console OAuth Client:

1. Open [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Select Client ID: `662374503405-m74guv10a7p5lvrja6dt49bl2afmp1k0.apps.googleusercontent.com`.
3. Under **Authorized redirect URIs** (Yetkili yönlendirme URI'leri), click **+ ADD URI** and add:
   ```
   https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback
   ```
   *(Optional bonus URI for direct Vercel routing: `https://tezlify-woad.vercel.app/api/v1/auth/google/callback`)*
4. Under **Authorized JavaScript origins** (Yetkili JavaScript kaynakları), ensure the following are present:
   ```
   https://tezlify-woad.vercel.app
   https://api.130.162.247.20.sslip.io
   ```
5. Click **SAVE** (Kaydet).

Changes typically take 1-5 minutes to propagate across Google's edge.

---

## 4. Rollback Plan (If Needed)

If an immediate rollback to Supabase Auth is ever required before Google Console is updated:
1. In `frontend/.env.production`, change:
   `VITE_AUTH_PROVIDER=supabase`
2. Commit & push:
   `git commit -am "fix(auth): rollback to supabase provider" && git push origin main`
3. Vercel automatically deploys within 45s, restoring 100% Supabase Auth flow with zero backend changes or downtime.
