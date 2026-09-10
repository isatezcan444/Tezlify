# Backend Architecture Rules

## 1. Directory Structure & Responsibilities
- `backend/app/models/`: SQLAlchemy 2.0 ORM models (Declarative Base, Enums, Relationships).
- `backend/app/schemas/`: Pydantic V2 models for requests, responses, and validation with `model_config = ConfigDict(from_attributes=True)`.
- `backend/app/services/`: Core business logic, domain rules, and third-party gateways.
  - `LeadIngestService`: Ingests, validates, deduplicates, and saves leads.
  - `CampaignRunner`: Asynchronous outreach execution, idempotency, and lifecycle.
  - `OutreachManager`: Single lead dispatching with Spintax rendering and logging.
  - `AntibanPolicy`: Single source of truth for timing, jitter, and working hours.
  - `PhoneService`: Turkish & international phone normalization (E.164, mobile detection).
  - `SpintaxService`: Template variable substitution and Spintax permutation evaluator.
  - `ExportService`: In-memory streaming CSV and Excel generator.
- `backend/app/api/v1/endpoints/`: FastAPI APIRouters. Must remain thin, delegating to services.

## 2. Invariants
- Never mutate data directly in router functions when domain services exist.
- Always use `get_db` async session dependency for endpoints.
- Catch errors explicitly and log with structured context.
- Never fake success on outreach exceptions.
