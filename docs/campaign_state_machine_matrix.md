# Tezlify — Campaign State Machine & Transition Matrix

**Architecture Layer:** `backend/app/models/campaign.py` & `backend/app/api/v1/endpoints/campaigns.py`  
**State Machine Class:** `CampaignStatus` Enum  

---

## 1. Legal States Inventory

| State Enum | Description | Allowed Transitions |
| :--- | :--- | :--- |
| **`DRAFT`** | Initial campaign state after creation with message template and target group. | ➔ `ACTIVE` (via `/launch`), ➔ Deleted |
| **`ACTIVE`** | Campaign is running; background runner dispatches messages with Anti-Ban delays. | ➔ `PAUSED` (via `/pause`), ➔ `COMPLETED` (automatic), ➔ Deleted |
| **`PAUSED`** | Outreach execution is temporarily suspended; no messages dispatched. | ➔ `ACTIVE` (via `/resume`), ➔ `ARCHIVED`, ➔ Deleted |
| **`COMPLETED`**| All leads in campaign group have been processed. | ➔ `ARCHIVED`, ➔ Deleted |
| **`ARCHIVED`** | Campaign is archived for historical analytics. | ➔ Deleted |

---

## 2. Transition Matrix & Guardrails

| Current State | Target State | Trigger Method | Status Code | Guardrail Invariant |
| :--- | :--- | :--- | :--- | :--- |
| `DRAFT` | `ACTIVE` | `POST /campaigns/{id}/launch` | **`200 OK`** | Spawns `CampaignRunner.run_campaign(id)` async task. |
| `ACTIVE` | `ACTIVE` | `POST /campaigns/{id}/launch` | **`400 Bad Request / 409 Conflict`** | Prevent duplicate concurrent worker dispatch. |
| `ACTIVE` | `PAUSED` | `POST /campaigns/{id}/pause` | **`200 OK`** | Updates status and pauses worker loop. |
| `PAUSED` | `ACTIVE` | `POST /campaigns/{id}/resume` | **`200 OK`** | Resumes message dispatches where left off. |
| `ACTIVE` | *Deleted* | `DELETE /campaigns/{id}` | **`204 No Content`** | Triggers `CampaignRunner.cancel_campaign(id)` before DB row deletion. |
| `ARCHIVED` | `ACTIVE` | `POST /campaigns/{id}/launch` | **`400 Bad Request`** | Archived campaigns cannot be re-launched directly. |
| *Any* | *Invalid String*| `PATCH /campaigns/{id}` | **`422 Unprocessable`** | Pydantic v2 schema rejects invalid enum values. |

---

## 3. Worker Safety & Cancellation Semantics

- When a campaign is active, `CampaignRunner._running_tasks[campaign_id]` stores the `asyncio.Task` reference.
- `CampaignRunner.cancel_campaign(id)` executes `task.cancel()`, ensuring no pending sleep callbacks fire.
- Zero orphaned background processes remain after campaign deletion.
