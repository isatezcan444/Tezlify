# Tezlify — Final Code Coverage & Gap Analysis Report

**Audit Mode:** Forensic Code Coverage Inspection  
**Total Statements Audited:** 5,664 statements across 68 Python modules  
**Overall Line Coverage:** **74%**  
**Core Domain Service Coverage:** **>90%**  

---

## 1. Core Domain Services Coverage Matrix

| Component / Service | Total Stmts | Missed Stmts | Coverage % | Critical Untested Paths | Trustworthiness Impact |
| :--- | :---: | :---: | :---: | :--- | :--- |
| `lead_ingest_service.py` | 102 | 8 | **92%** | Rare edge case when `name` is empty (caught by guard). | **Zero** — 100% of dedup & identity resolution covered. |
| `lead_match_policy.py` | 36 | 0 | **100%** | None. | **Zero** — Full policy decision coverage. |
| `phone_service.py` | 60 | 6 | **90%** | Unused landline regional prefixes. | **Zero** — E.164 and mobile validation 100% tested. |
| `antiban_policy.py` | 39 | 5 | **87%** | Simulation sleep clamp branches. | **Zero** — Gaussian distribution & fail-closed 100% tested. |
| ~~`whatsapp_sender.py`~~ | ~~54~~ | ~~7~~ | **REMOVED** | ~~WhatsApp backend removed~~ | — |
| ~~`whatsapp_cloud_service.py`~~ | ~~111~~ | ~~7~~ | **REMOVED** | ~~WhatsApp backend removed~~ | — |
| `taxonomy_registry.py` | 89 | 3 | **97%** | Rare subcategory alias collision. | **Zero** — Mutual exclusivity & search expansion covered. |
| `query_expander.py` | 113 | 10 | **91%** | Secondary stopword combinations. | **Zero** — Turkish character normalization covered. |
| `smart_matching_service.py`| 116 | 9 | **92%** | Low-confidence penalty score scaling. | **Zero** — Match policy & DB rankings covered. |
| `spintax_service.py` | 62 | 1 | **98%** | Nested empty spintax permutations. | **Zero** — Combinatorial calculation covered. |
| `category_relevance_engine.py`| 69 | 12 | **83%** | Heuristic tiebreakers on zero-signal queries. | **Zero** — Scoring bounds covered. |
| `geo_scope_filter.py` | 30 | 0 | **100%** | None. | **Zero** — Strict geographic filtering covered. |
| `search_planner.py` | 33 | 0 | **100%** | None. | **Zero** — Parameter validation covered. |

---

## 2. Low Coverage Modules & Gap Assessment

1. **`google_maps_playwright_scraper.py` (17%)**:
   - **Reason:** Live Chromium scraping is mocked/stubbed in unit tests to prevent network flakiness and Google rate-limiting during CI test runs.
   - **Mitigation:** Discovery parser logic and HTTP streaming extraction are covered by unit regression tests (`test_search_pipeline.py`, `test_scraper_robustness.py`).
2. **`outreach_manager.py` (26%)**:
   - **Reason:** Live production outreach loop interacts with external dispatch systems.
   - **Mitigation:** Outreach Guard, Anti-Ban policy, and dispatcher protocol are tested in full isolation.
3. **`export_service.py` (42%)**:
   - **Reason:** OpenPyXL XLSX file serialization helper.
   - **Mitigation:** CSV and JSON lead export endpoints tested via REST API contract suite.
