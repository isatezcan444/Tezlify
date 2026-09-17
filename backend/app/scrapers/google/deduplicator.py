"""
Google Maps Discovery Deduplication & Target Computation Primitives.

Extracted from GoogleMapsScraper to provide independent, testable deduplication
indexes, confidence definitions, and district target mathematics.
"""
import enum
import math
from typing import Dict, Optional, Set

from backend.app.core.config import settings
from backend.app.data.turkey_locations import normalize_turkish


class LocationConfidence(str, enum.Enum):
    EXACT_DISTRICT = "EXACT_DISTRICT"
    CITY_ONLY = "CITY_ONLY"
    OUTSIDE_TARGET = "OUTSIDE_TARGET"
    UNKNOWN = "UNKNOWN"


class DedupDecision(str, enum.Enum):
    """Outcome of evaluating a freshly inspected place against prior discoveries."""
    ACCEPT = "ACCEPT"                      # New unique business — emit.
    DUPLICATE_PLACE = "DUPLICATE_PLACE"    # Same physical place seen before — suppress.
    DUPLICATE_NAME = "DUPLICATE_NAME"      # Identical name within the same district — suppress.
    SHARED_PHONE = "SHARED_PHONE"          # Distinct business on an already-seen line — emit flagged.


class LeadDiscoveryDeduplicator:
    """
    Stateful, in-memory dedup index for a single discovery run.

    Suppression policy (aligned with LeadIngestService + WhatsApp anti-spam):
    - Place identity (canonical Maps URL) is global across districts.
    - Exact name within one district is treated as the same listing.
    - A shared phone line never suppresses the business itself; it only flags the
      lead so the shared number is displayed but withheld from outreach targeting.
    """

    def __init__(self) -> None:
        self.seen_place_urls: Set[str] = set()
        self.seen_names: Set[str] = set()
        self.seen_phones: Set[str] = set()
        # First-seen coarse address token per name key: chain branches with the
        # same brand name must NOT suppress each other when addresses differ.
        self.name_address_keys: Dict[str, Optional[str]] = {}

    @staticmethod
    def build_address_key(address: Optional[str]) -> Optional[str]:
        """Coarse location token: normalized street/neighberhood segment of an address."""
        segment = (address or "").split(",")[0].strip().strip(".").strip()
        return normalize_turkish(segment).lower() or None

    def _name_matches_address(self, name_key: str, address_key: Optional[str]) -> bool:
        stored = self.name_address_keys.get(name_key)
        # No address evidence on either side → fall back to legacy name-only policy.
        return address_key is None or stored is None or address_key == stored

    def evaluate(
        self,
        place_url: Optional[str],
        name_key: str,
        e164: Optional[str],
        address_key: Optional[str] = None,
    ) -> DedupDecision:
        if place_url and place_url in self.seen_place_urls:
            return DedupDecision.DUPLICATE_PLACE
        if name_key in self.seen_names and self._name_matches_address(name_key, address_key):
            return DedupDecision.DUPLICATE_NAME
        if e164 and e164 in self.seen_phones:
            return DedupDecision.SHARED_PHONE
        return DedupDecision.ACCEPT

    def register(
        self,
        place_url: Optional[str],
        name_key: str,
        e164: Optional[str],
        address_key: Optional[str] = None,
    ) -> None:
        if place_url:
            self.seen_place_urls.add(place_url)
        self.seen_names.add(name_key)
        self.name_address_keys.setdefault(name_key, address_key)
        if e164:
            self.seen_phones.add(e164)


def compute_district_target(max_results: int, district_count: int) -> int:
    """
    Per-district discovery target.
    - Limited mode: even distribution rounded up (no artificial floor that would
      make '10 results' scrape 30+).
    - Unlimited mode (max_results == 0): config-driven high target.
    """
    if max_results > 0:
        return max(1, math.ceil(max_results / max(district_count, 1)))
    return settings.SCRAPER_UNLIMITED_DISTRICT_TARGET


__all__ = [
    "LocationConfidence",
    "DedupDecision",
    "LeadDiscoveryDeduplicator",
    "compute_district_target",
]
