# Tezlify — Data Invariant Catalog

**Version:** 2.0  
**Classification:** Forensic Reliability Standard  

---

## 1. CRM & Lead Invariants

### INV-CRM-001: Phone Normalization Truthfulness
- **Description:** `Lead.phone_e164` must always be normalized to valid E.164 format or remain `None`. The system must never synthesize fake/dummy phone numbers (`+900000000000`) for records without a phone number.
- **Production Location:** `backend/app/services/phone_service.py` & `backend/app/services/lead_ingest_service.py`
- **Verification Test:** `backend/tests/adversarial/test_lead_adversarial.py::test_adversarial_phone_corruption_matrix`
- **Status:** `VERIFIED / PASS`

### INV-CRM-002: Deduplication Multi-Pass Invariance
- **Description:** Repeated ingestion of the same raw candidate (by `place_id`, E.164 phone, or identity tuple) must strictly update metadata and never create duplicate rows.
- **Production Location:** `backend/app/services/lead_ingest_service.py:102`
- **Verification Test:** `backend/tests/adversarial/test_lead_adversarial.py::test_adversarial_same_lead_repeated_ingest_10x`
- **Status:** `VERIFIED / PASS`

---

## 2. Discovery & Taxonomy Invariants

### INV-DISC-001: Mathematical Determinism of Place Identity
- **Description:** `place_id` calculation must use deterministic SHA-256 slicing (`hashlib.sha256(url.encode()).hexdigest()[:16]`) and strictly never rely on process-local randomized `hash()`.
- **Production Location:** `backend/app/services/discovery_engine_v2.py`
- **Verification Test:** `backend/tests/adversarial/test_discovery_adversarial.py::test_adversarial_deterministic_hashing_stability`
- **Status:** `VERIFIED / PASS`

### INV-DISC-002: Intent & Taxonomy Fallback Safety
- **Description:** Malformed, empty, or hostile category inputs must safely resolve to `None` or category node fallbacks without throwing unhandled 500 exceptions.
- **Production Location:** `backend/app/services/taxonomy_registry.py`
- **Verification Test:** `backend/tests/adversarial/test_discovery_adversarial.py::test_adversarial_taxonomy_boundary_queries`
- **Status:** `VERIFIED / PASS`

---

## 3. Campaign & State Machine Invariants

### INV-CMP-001: State Machine Transition Integrity
- **Description:** Campaigns must only transition through legal enum states (`DRAFT` ➔ `ACTIVE` ➔ `PAUSED` ➔ `ARCHIVED`). Invalid status strings must fail fast at the Pydantic schema validation layer (HTTP 422).
- **Production Location:** `backend/app/api/v1/endpoints/campaigns.py:110`
- **Verification Test:** `backend/tests/adversarial/test_campaign_state_machine.py::test_campaign_state_machine_matrix`
- **Status:** `VERIFIED / PASS`

### INV-CMP-002: Running Worker Cancellation on Deletion
- **Description:** Deleting a running campaign must immediately trigger worker cancellation via `CampaignRunner.cancel_campaign(cid)` before purging database records.
- **Production Location:** `backend/app/api/v1/endpoints/campaigns.py:124`
- **Verification Test:** `backend/tests/adversarial/test_campaign_state_machine.py::test_adversarial_running_campaign_deletion_cancels_worker`
- **Status:** `VERIFIED / PASS`

---

## 4. Campaign Group & Retention Invariants

### INV-GRP-001: Unique Membership Constraint
- **Description:** The junction table `campaign_group_leads` must strictly enforce composite uniqueness on `(group_id, lead_id)`. Adding the same lead 10x must produce exactly 1 membership row.
- **Production Location:** `backend/app/models/campaign_group.py` & `backend/app/api/v1/endpoints/campaign_groups.py:266`
- **Verification Test:** `backend/tests/adversarial/test_campaign_group_adversarial.py::test_adversarial_group_membership_duplicate_filtering`
- **Status:** `VERIFIED / PASS`

### INV-GRP-002: Lead Preservation Invariant on Group Deletion
- **Description:** Deleting a `CampaignGroup` or removing a lead from a group MUST NEVER delete the underlying `Lead` entity from the CRM.
- **Production Location:** `backend/app/api/v1/endpoints/campaign_groups.py:298, 321`
- **Verification Test:** `backend/tests/adversarial/test_campaign_group_adversarial.py::test_adversarial_lead_preservation_on_group_delete`
- **Status:** `VERIFIED / PASS`

---

## 5. ~~WhatsApp Dispatch & Safety Invariants~~
- **Status:** ~~REMOVED~~ — WhatsApp backend removed.

---

## 6. ~~Webhook Security & Idempotency Invariants~~
- **Status:** ~~REMOVED~~ — WhatsApp backend removed.

---

## 7. Anti-Ban Safety Invariants

### INV-AB-001: Fail-Closed Working Hours Validation
- **Description:** Any corrupted, empty, or unparseable working hours format must fail closed (`is_within_working_hours` returns `False`). Outreach is prohibited when policy configuration cannot be parsed.
- **Production Location:** `backend/app/services/antiban_policy.py:72`
- **Verification Test:** `backend/tests/adversarial/test_antiban_adversarial.py::test_adversarial_working_hours_fail_closed_on_corrupt_data`
- **Status:** `VERIFIED / PASS`

### INV-AB-002: Gaussian Jitter Delay Clamping
- **Description:** Generated message dispatch delays must strictly fall within `[min_delay, max_delay]`. 1,000 continuous samples must exhibit zero upper or lower boundary breaches.
- **Production Location:** `backend/app/services/antiban_policy.py:30`
- **Verification Test:** `backend/tests/adversarial/test_antiban_adversarial.py::test_adversarial_jitter_distribution_clamping_1000_samples`
- **Status:** `VERIFIED / PASS`
