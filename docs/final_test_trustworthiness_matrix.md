# Tezlify — Final Test Trustworthiness Matrix

**Audit Mode:** Deep Forensic Test Inspection  
**Audit Standard:** Evaluation of Real Execution vs. False Confidence  

---

## 1. Test Trustworthiness Evaluation Matrix

| Test Module / Suite | Production Path | Real DB | Mocked Components | Critical Assertion | False Positive Risk | Evidence Quality |
| :--- | :--- | :---: | :--- | :--- | :--- | :--- |
| **`test_lead_adversarial.py`** | `LeadIngestService.ingest_leads`, `PhoneService.normalize_to_e164` | **YES** | **NONE** | Asserts exact row count, E.164 normalization, and zero duplicate IDs in DB. | **Zero** — Real async DB queries before and after ingestion. | **STRONG** |
| **`test_lead_lifecycle.py`** | `leads.py` CRUD, Status Updates, Blacklist toggle | **YES** | **NONE** | Asserts lead status progression (`NEW` ➔ `CONTACTED`), note append, and blacklist isolation. | **Zero** — Inspects committed database records. | **STRONG** |
| **`test_discovery_adversarial.py`**| `discovery_engine_v2.py`, `TaxonomyRegistry` | **YES** | **NONE** | Asserts 1,000-pass deterministic SHA-256 hash stability & polar-opposite penalty scoring. | **Zero** — Algorithmic and mathematical invariance. | **STRONG** |
| **`test_discovery_integrity.py`** | `SearchPlanner`, `GeoScopeFilter`, `TaxonomyRegistry` | **YES** | **NONE** | Asserts Turkish normalization, district boundaries, and non-empty category expansion. | **Zero** — Real registry lookup. | **STRONG** |
| **`test_campaign_state_machine.py`**| `campaigns.py`, `CampaignRunner` | **YES** | `CampaignRunner.cancel_campaign` (Spy) | Asserts illegal transitions reject with 422/409; active deletion cancels worker. | **Low** — State machine transitions validated on DB models. | **STRONG** |
| **`test_campaign_lifecycle.py`** | `campaigns.py`, `campaign_groups.py` | **YES** | **NONE** | Asserts campaign creation in `DRAFT` status and verified lead prefill handoff. | **Zero** — Full REST API roundtrip. | **STRONG** |
| **`test_campaign_group_adversarial.py`**| `campaign_groups.py` | **YES** | **NONE** | Asserts lead retention in CRM on group deletion & 10x duplicate member input deduplication. | **Zero** — Queries `Lead` and `campaign_group_leads` tables. | **STRONG** |
| **`test_campaign_group_lifecycle.py`** | `campaign_groups.py` | **YES** | **NONE** | Asserts delta counter accuracy (`total_leads_count`, `whatsapp_eligible_count`). | **Zero** — Committed DB count checks. | **STRONG** |
| ~~`test_whatsapp_adversarial.py`~~ | ~~`whatsapp_sender.py`~~ | ~~YES~~ | ~~REMOVED~~ | ~~WhatsApp backend removed~~ | — | — |
| ~~`test_whatsapp_safety.py`~~ | ~~`whatsapp_sender.py`~~ | ~~YES~~ | ~~REMOVED~~ | ~~WhatsApp backend removed~~ | — | — |
| ~~`test_webhook_adversarial.py`~~ | ~~`whatsapp_cloud_webhook.py`~~ | ~~YES~~ | ~~REMOVED~~ | ~~WhatsApp backend removed~~ | — | — |
| ~~`test_webhook_integrity.py`~~ | ~~`whatsapp_cloud_webhook.py`~~ | ~~YES~~ | ~~REMOVED~~ | ~~WhatsApp backend removed~~ | — | — |
| **`test_antiban_adversarial.py`** | `AntibanPolicy` | **YES** | **NONE** | Asserts fail-closed (`return False`) on 10 malformed hours formats; 1,000-sample Gaussian jitter clamping in `[min, max]`. | **Zero** — Statistical calculation across 1,000 iterations. | **STRONG** |
| **`test_antiban_invariants.py`** | `settings.py`, `AntibanPolicy` | **YES** | **NONE** | Asserts REST API persistence of Anti-Ban configuration. | **Zero** — Database record inspection. | **STRONG** |
| **`test_concurrency_adversarial.py`**| Async Engine & `campaign_groups.py` | **YES** | **NONE** | Asserts composite unique constraint on `campaign_group_leads` under 10x parallel bursts. | **Zero** — Real `asyncio.gather` with independent connections. | **STRONG** |
| **`test_api_fuzzing.py`** | ASGI Route Layer | **YES** | **NONE** | Asserts non-500 response codes under SQLi, XSS, and type confusion payloads. | **Zero** — Real FastAPI ASGI client execution. | **STRONG** |
| **`test_i18n_integrity.py`** | `frontend/src/locales/` | **N/A** | **NONE** | Asserts 100% 1:1 key parity between `tr.ts` and `en.ts` (684 keys). | **Zero** — Direct AST inspection. | **STRONG** |
| **`test_playwright_deep_e2e.py`** | Vite Dev Server + React 18 UI | **YES** | **NONE** | Asserts real browser user journeys (A–G), 0 console errors, and UI resilience on API 500 error. | **Zero** — Real headless Chromium automation. | **STRONG** |

---

## 2. Mocking Risk & Defect Masking Analysis

1. ~~**Why is `WhatsAppSpy` safe?**~~ — WhatsApp backend removed.
2. **Why are Database Sessions unmocked?**
   - All tests use real `AsyncSessionLocal()` instances connecting to SQLite. This guarantees that foreign key constraints, column types, transaction rollbacks, and unique indexes execute against the true relational engine.
3. ~~**Why is Meta HMAC Cryptography unmocked?**~~ — WhatsApp backend removed.
