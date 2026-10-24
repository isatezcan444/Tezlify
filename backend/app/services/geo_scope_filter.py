"""
Geographic Scope Filter for Business Discovery Engine V3.

Single decision point that keeps discovery results inside the user-selected
city/district scope. Wraps the LocationValidator (which owns the matching
heuristics) so the scraper orchestrator depends on one honest policy object
instead of scattering address checks across the pipeline.

Why this exists: Google Maps text search is relevance-ranked over the whole
metro area — a search bound to 'Ataşehir' routinely returns prominent
businesses from neighboring districts (Ümraniye, Kartal, Kadıköy...). Without
a post-extraction fence those places were ingested labeled with the REQUESTED
district instead of their real one.
"""
import enum
import logging
from typing import List, Optional

from pydantic import BaseModel

from backend.app.services.location_validator import LocationStatus, LocationValidator

logger = logging.getLogger(__name__)


class GeoScopeDecision(str, enum.Enum):
    """Outcome of evaluating a discovered place against the requested geo scope."""
    ACCEPT_TARGET = "ACCEPT_TARGET"      # Address proves the place is in a target district.
    ACCEPT_UNPROVEN = "ACCEPT_UNPROVEN"  # No district evidence either way (kept, honestly labeled).
    REJECT_OUTSIDE = "REJECT_OUTSIDE"    # Address proves the place is in a different district.


class GeoScopeVerdict(BaseModel):
    """
    Immutable result of a geo-scope evaluation.

    resolved_district carries the place's TRUE district as proven by its address,
    or None when the address proves nothing. Callers must never relabel a lead
    with the requested district when this is None.
    """
    decision: GeoScopeDecision
    resolved_district: Optional[str] = None
    matched_subdivision: Optional[str] = None
    is_target_neighborhood: bool = False
    confidence: float = 0.0
    reason: str = ""


class GeoScopeFilter:
    """
    District-level geo fence for a single discovery run.

    Policy:
    - OUTSIDE_TARGET (address names another district of the same city) → REJECT.
    - EXACT / SUBDIVISION (address proves a target district or neighborhood) →
      ACCEPT with the proven district as resolved_district.
    - CITY_ONLY / UNKNOWN (no district evidence) → ACCEPT_UNPROVEN by default;
      with reject_unproven=True these are rejected too (strictest mode).

    The filter is stateless: one instance can be shared across districts of the
    same run because targets are passed per evaluation.
    """

    def __init__(self, reject_unproven: bool = False) -> None:
        self.reject_unproven = reject_unproven

    @classmethod
    def from_settings(cls) -> "GeoScopeFilter":
        """Builds a filter from application settings (kept out of __init__ for DI-friendliness)."""
        from backend.app.core.config import settings
        return cls(reject_unproven=settings.SCRAPER_REJECT_UNPROVEN_LOCATION)

    def evaluate(
        self,
        target_city: str,
        target_districts: List[str],
        place_name: str,
        place_address: Optional[str],
        target_neighborhoods: Optional[List[str]] = None,
    ) -> GeoScopeVerdict:
        """Evaluates one discovered place against the requested city/district scope."""
        assessment = LocationValidator.evaluate(
            target_city=target_city,
            target_districts=target_districts,
            result_address=place_address,
            result_name=place_name,
            target_neighborhoods=target_neighborhoods,
        )

        is_target_nh = False
        if target_neighborhoods and assessment.matched_subdivision:
            from backend.app.data.turkey_locations import normalize_turkish
            norm_sub = normalize_turkish(assessment.matched_subdivision)
            if any(normalize_turkish(tn) == norm_sub or normalize_turkish(tn) in norm_sub for tn in target_neighborhoods):
                is_target_nh = True

        if assessment.status in (LocationStatus.EXACT, LocationStatus.SUBDIVISION):
            return GeoScopeVerdict(
                decision=GeoScopeDecision.ACCEPT_TARGET,
                resolved_district=assessment.matched_district,
                matched_subdivision=assessment.matched_subdivision,
                is_target_neighborhood=is_target_nh,
                confidence=assessment.confidence,
                reason=assessment.reason,
            )

        if assessment.status == LocationStatus.OUTSIDE_TARGET:
            return GeoScopeVerdict(
                decision=GeoScopeDecision.REJECT_OUTSIDE,
                resolved_district=None,
                matched_subdivision=None,
                is_target_neighborhood=False,
                confidence=assessment.confidence,
                reason=assessment.reason,
            )

        # CITY_ONLY / UNKNOWN: no district evidence in the address text.
        if self.reject_unproven:
            return GeoScopeVerdict(
                decision=GeoScopeDecision.REJECT_OUTSIDE,
                resolved_district=None,
                matched_subdivision=None,
                is_target_neighborhood=False,
                confidence=assessment.confidence,
                reason=f"Kesin ilçe kanıtı yok (strict mod): {assessment.reason}",
            )

        return GeoScopeVerdict(
            decision=GeoScopeDecision.ACCEPT_UNPROVEN,
            resolved_district=None,
            matched_subdivision=assessment.matched_subdivision,
            is_target_neighborhood=is_target_nh,
            confidence=assessment.confidence,
            reason=assessment.reason,
        )
