# Tezlify — Adversarial Findings & Forensic Vulnerability Register

**Audit Mode:** Independent Adversarial Reliability Audit  
**Audit Date:** 2026-09-01  

---

## 1. Summary of Findings

| Finding ID | Severity | Component | Status | Summary |
| :--- | :--- | :--- | :--- | :--- |
| `ADV-CONC-01` | **MEDIUM** | Campaign Groups & Database Concurrency | **DISCOVERED & DOCUMENTED** | Concurrent `DELETE /groups/{id}` + `POST /groups/{id}/leads` race condition can leave orphaned junction row when SQLite foreign keys are not enforced per async connection. |
| `ADV-SEC-01` | **LOW** | Webhook App Secret Configuration | **DOCUMENTED** | `WHATSAPP_CLOUD_APP_SECRET` defaults to empty string in development mode, logging a warning rather than enforcing HMAC validation. |
| `ADV-UX-01` | **INFO** | Leads Table Dynamic Filtering | **DOCUMENTED** | Complex multi-param lead filtering in `/api/v1/leads` contains some untested edge filter branches. |

---

## 2. Detailed Forensic Finding Reports

### Finding: `ADV-CONC-01`
- **Severity:** `MEDIUM`
- **Component:** `backend/app/api/v1/endpoints/campaign_groups.py` & Database Connection Layer
- **Description:** When a campaign group deletion request (`DELETE /api/v1/campaign-groups/{id}`) and a member insertion request (`POST /api/v1/campaign-groups/{id}/leads`) arrive at the exact same millisecond:
  1. The delete request deletes the parent `CampaignGroup` row and cascades delete to existing memberships.
  2. Concurrently, the add request had already fetched `group = await db.get(CampaignGroup, id)` before the delete committed.
  3. The add request inserts `(group_id, lead_id)` into `campaign_group_leads`.
  4. If SQLite foreign key constraints (`PRAGMA foreign_keys = ON`) are not explicitly enabled on every async connection pool checkout, the junction insert succeeds even though the parent group was deleted, leaving an orphaned junction record.
- **Evidence & Reproduction:**
  - Executed via `backend/tests/adversarial/test_concurrency_adversarial.py::test_adversarial_concurrent_group_delete_and_lead_add`.
  - Result: `assert orphan_count == 0` failed with `assert 1 == 0` when both requests committed in parallel.
- **Root Cause:**
  - `add_leads_to_campaign_group` uses raw table insert `insert(campaign_group_leads)` without re-verifying parent group existence inside the nested transaction, combined with SQLite default connection settings where foreign keys are disabled unless explicitly set on connection connect event.
- **Impact:** In high-concurrency environments where users simultaneously delete groups while background bulk processes add leads, orphaned rows in `campaign_group_leads` can persist.
- **Recommended Fix (for post-audit remediation):**
  1. In `backend/app/core/database.py`, attach an event listener to the async engine `connect` event executing `await conn.execute(text("PRAGMA foreign_keys = ON"))` for SQLite dialects.
  2. In `add_leads_to_campaign_group`, verify `await db.get(CampaignGroup, group_id)` within the savepoint transaction before committing junction rows.
- **Regression Test:** `backend/tests/adversarial/test_concurrency_adversarial.py::test_adversarial_concurrent_group_delete_and_lead_add` (marked `xfail` to record the finding without blocking CI).

---

### Finding: `ADV-SEC-01`
- **Severity:** `LOW`
- **Component:** `backend/app/api/v1/endpoints/whatsapp_cloud_webhook.py:30`
- **Description:** If `WHATSAPP_CLOUD_APP_SECRET` is not set in environment (defaulting to empty string `""`), `verify_meta_signature` returns `True` and logs a warning to allow local offline development.
- **Root Cause:** Development convenience fallback in `verify_meta_signature`.
- **Impact:** If deployed to public production without configuring `WHATSAPP_CLOUD_APP_SECRET`, HMAC signature verification would be bypassed.
- **Recommended Fix:** In production mode (`settings.ENVIRONMENT == "production"`), enforce that `WHATSAPP_CLOUD_APP_SECRET` is mandatory and raise a startup validation error if missing.
- **Regression Test:** `backend/tests/adversarial/test_webhook_adversarial.py::test_adversarial_webhook_tampered_payload_rejection`.

---

### Finding: `ADV-UX-01`
- **Severity:** `INFO`
- **Component:** `backend/app/api/v1/endpoints/leads.py`
- **Description:** The `/api/v1/leads` endpoint contains over 10 optional query parameters (city, category, status, min_rating, max_rating, search, etc.). Certain combined permutations (e.g. `min_rating > max_rating`) are not covered by unit tests.
- **Impact:** Potential minor filter inconsistencies if extreme invalid query parameters are submitted.
- **Recommended Fix:** Add input validation ensuring `min_rating <= max_rating`.
- **Regression Test:** `backend/tests/adversarial/test_api_fuzzing.py::test_adversarial_pagination_boundary_values`.
