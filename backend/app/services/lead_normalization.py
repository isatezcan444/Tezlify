"""
Lead Normalization and Entity Value Formatting Service.
Extracted from LeadIngestService to separate pure data transformation
and merge business logic from database batch orchestration and persistence.
"""
from datetime import datetime
from typing import Dict, Any, Optional, Tuple

from backend.app.models.lead import (
    Lead,
    LeadStatus,
    EntityType,
    VerificationStatus,
    ConfidenceLevel,
)
from backend.app.scrapers.google.google_maps_playwright_scraper import strip_leading_business_name


# Column set materialized from transient Lead objects into Core bulk rows.
# Must stay in sync with build_lead_values().
LEAD_VALUE_COLS = (
    "name", "category", "canonical_category", "category_score",
    "category_classification", "entity_type", "verification_status",
    "confidence_level", "confidence_score", "is_verified", "discovered_from",
    "verified_by", "phone", "phone_e164", "is_mobile", "is_whatsapp_eligible",
    "address", "city", "district", "latitude", "longitude", "website",
    "rating", "reviews_count", "place_id", "search_keyword", "search_location",
    "source", "status", "custom_data", "user_id",
)


def truncate_column_value(val: Optional[str], limit: int) -> Optional[str]:
    """Defensive truncation: protect all VARCHAR-bounded columns from overflow.
    Also strips embedded newlines that can corrupt single-line fields.
    """
    if val is None:
        return None
    val = val.split("\n")[0].strip()
    return val[:limit]


def build_initial_custom_data(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Builds the initial custom_data payload preserving the canonical Maps URL."""
    maps_url = raw.get("maps_url") or raw.get("google_maps_url")
    return {"maps_url": maps_url} if maps_url else {}


def build_lead_values(
    raw: Dict[str, Any],
    name: str,
    e164: Optional[str],
    phone_data: Optional[Dict[str, Any]],
    is_wa_eligible: bool,
    is_verified: bool,
    is_blacklisted: bool,
    source: str,
    search_keyword: Optional[str],
    search_location: Optional[str],
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Builds the column-value dict for a brand-new lead row.

    Single construction site shared by the ORM row-mode path and the Core
    bulk path — both persist byte-identical rows.
    """
    initial_status = LeadStatus.UNSUBSCRIBED if is_blacklisted else LeadStatus.NEW

    return {
        "name": name,  # text (unlimited)
        "category": raw.get("category"),  # text (unlimited)
        "canonical_category": raw.get("canonical_category"),  # text
        "category_score": raw.get("category_score", 1.0),
        "category_classification": truncate_column_value(raw.get("category_classification", "MATCH"), 50),
        "entity_type": truncate_column_value(raw.get("entity_type", EntityType.BUSINESS.value), 50),
        "verification_status": truncate_column_value(
            raw.get("verification_status", VerificationStatus.VERIFIED.value if is_verified else VerificationStatus.UNVERIFIED.value),
            50,
        ),
        "confidence_level": truncate_column_value(
            raw.get("confidence_level", ConfidenceLevel.HIGH.value if (is_verified and is_wa_eligible) else ConfidenceLevel.MEDIUM.value),
            20,
        ),
        "confidence_score": raw.get("confidence_score", 90 if (is_verified and is_wa_eligible) else 60),
        "is_verified": is_verified,
        "discovered_from": truncate_column_value(raw.get("discovered_from", source), 100),
        "verified_by": raw.get("verified_by"),
        "phone": truncate_column_value(raw.get("phone") or (e164 or "Belirtilmemiş"), 50),
        "phone_e164": truncate_column_value(e164, 30),  # None if phone is not present — never fabricate numbers
        "is_mobile": phone_data.get("is_mobile", False) if phone_data else False,
        "is_whatsapp_eligible": is_wa_eligible,
        "address": raw.get("address"),  # text
        "city": truncate_column_value(raw.get("city"), 100),
        "district": truncate_column_value(raw.get("district"), 100),
        "latitude": raw.get("latitude"),
        "longitude": raw.get("longitude"),
        "website": raw.get("website"),  # text
        "rating": raw.get("rating"),
        "reviews_count": raw.get("reviews_count", 0),
        "place_id": truncate_column_value(raw.get("place_id"), 255),
        "search_keyword": truncate_column_value(search_keyword or raw.get("search_keyword"), 200),
        "search_location": truncate_column_value(search_location or raw.get("search_location"), 200),
        "source": truncate_column_value(source, 50),
        "status": initial_status,
        "custom_data": build_initial_custom_data(raw),
        "user_id": user_id,
    }


def merge_into_existing_lead(
    existing_lead: Lead,
    raw: Dict[str, Any],
    e164: Optional[str],
    is_wa_eligible: bool,
    is_blacklisted: bool,
) -> bool:
    """Backfills richer details discovered on a subsequent scan of the same business.

    Returns True when any attribute actually changed. Untouched rows stay
    clean so commit emits no UPDATE for them (identical re-saves cost zero
    write round-trips on remote Postgres).
    """
    changed = False

    def _set(attr: str, value: Any) -> None:
        nonlocal changed
        if getattr(existing_lead, attr) != value:
            setattr(existing_lead, attr, value)
            changed = True

    maps_url = raw.get("maps_url") or raw.get("google_maps_url")
    if not existing_lead.phone_e164 and e164:
        _set("phone_e164", e164)
        _set("phone", e164)
        _set("is_whatsapp_eligible", is_wa_eligible)
    if not existing_lead.website and raw.get("website"):
        _set("website", raw.get("website"))
    if not existing_lead.address and raw.get("address"):
        _set("address", raw.get("address"))
    # Self-healing: rows stored before the name-prefix strip carry
    # "Business Name, street...". Normalize them on contact — pure removal
    # of a proven prefix, never injecting new content.
    if existing_lead.address:
        healed = strip_leading_business_name(existing_lead.name, existing_lead.address)
        if healed and healed != existing_lead.address:
            _set("address", healed)
    if raw.get("rating") and not existing_lead.rating:
        _set("rating", raw.get("rating"))
    if is_blacklisted:
        _set("status", LeadStatus.UNSUBSCRIBED)
    if maps_url and not (existing_lead.custom_data or {}).get("maps_url"):
        _set("custom_data", {**(existing_lead.custom_data or {}), "maps_url": maps_url})
    if changed:
        _set("updated_at", datetime.utcnow())
    return changed


def compute_bulk_correlation_key(transient: Lead) -> Tuple[str, Any, Any, Optional[str], Optional[str]]:
    """Correlation key mapping a planned transient to its bulk-inserted row.

    Full (name, city, district, phone_e164, place_id): any strict subset
    can repeat across two inserts (shared phone line on one triple; see
    SHARED_PHONE), but the full key is distinct — an exact repeat would
    have merged during planning instead of inserting.
    """
    return (
        transient.name,
        transient.city,
        transient.district,
        transient.phone_e164,
        transient.place_id,
    )
