"""
Multi-Source Entity Resolution Graph for Business Discovery Engine V3.
Fuses raw candidate records across providers (Overpass, Directory, Web, Nominatim)
using Multi-Key Evidence: E.164 Phone, Website Domain, Name+District Fingerprint, and Geo-Proximity.
Preserves complete provenance and provider identities on unified BusinessEntity nodes.
"""
import re
import uuid
import logging
from typing import Dict, Any, List, Optional, Tuple
from urllib.parse import urlparse

from backend.app.schemas.intelligence import (
    RawBusinessCandidate,
    CandidateEntity,
    CandidateProvenance,
    QualificationState
)
from backend.app.data.turkey_locations import normalize_turkish

logger = logging.getLogger(__name__)


def extract_domain_key(url: Optional[str]) -> Optional[str]:
    """Extracts base domain from a URL for entity resolution matching."""
    if not url:
        return None
    try:
        if not url.startswith("http://") and not url.startswith("https://"):
            url = f"https://{url}"
        parsed = urlparse(url)
        netloc = parsed.netloc.lower()
        netloc = re.sub(r'^www\.', '', netloc)
        return netloc if len(netloc) > 3 else None
    except Exception:
        return None


class EntityGraphMerger:
    """
    V3 Multi-Key Entity Resolution Graph:
    - Primary Index: E.164 phone
    - Secondary Index: Normalized domain
    - Tertiary Index: Name + District Fingerprint
    - Tracks complete provenance history and distinct provider contributions.
    """

    def __init__(self):
        self._entities_by_phone: Dict[str, CandidateEntity] = {}
        self._entities_by_domain: Dict[str, CandidateEntity] = {}
        self._entities_by_name_district: Dict[str, CandidateEntity] = {}
        self._all_entities: List[CandidateEntity] = []

    def merge_candidate(
        self,
        candidate: RawBusinessCandidate,
        phone_data: Optional[Dict[str, Any]],
        district: str,
        city: str
    ) -> Tuple[CandidateEntity, bool]:
        """
        Merges a RawBusinessCandidate into the Entity Graph using multi-key resolution.
        Returns (CandidateEntity, is_new: bool).
        """
        e164 = phone_data["e164"] if phone_data else candidate.phone_e164
        domain = extract_domain_key(candidate.raw_website)
        norm_name = normalize_turkish(candidate.clean_name)
        norm_district = normalize_turkish(district)
        name_key = f"{norm_name}_{norm_district}"

        # 1. Multi-key index lookup
        existing_entity: Optional[CandidateEntity] = None
        if e164 and e164 in self._entities_by_phone:
            existing_entity = self._entities_by_phone[e164]
        elif domain and domain in self._entities_by_domain:
            existing_entity = self._entities_by_domain[domain]
        elif name_key in self._entities_by_name_district:
            existing_entity = self._entities_by_name_district[name_key]

        prov = CandidateProvenance(
            provider=candidate.provider,
            query_id=candidate.query_id or f"q_{uuid.uuid4().hex[:8]}",
            query_family=candidate.query_family,
            query_text=candidate.provider_query,
            source_url=candidate.source_url,
            raw_category=candidate.raw_category
        )

        if existing_entity:
            # Corroborating discovery from another provider or query
            existing_entity.provenance_list.append(prov)
            if candidate.clean_name not in existing_entity.name_variations:
                existing_entity.name_variations.append(candidate.clean_name)

            # Attribute enrichment
            if candidate.raw_address and (not existing_entity.address or len(candidate.raw_address) > len(existing_entity.address)):
                existing_entity.address = candidate.raw_address
            if candidate.raw_website and not existing_entity.website:
                existing_entity.website = candidate.raw_website
            if domain and domain not in self._entities_by_domain:
                self._entities_by_domain[domain] = existing_entity
            if candidate.latitude and not existing_entity.latitude:
                existing_entity.latitude = candidate.latitude
                existing_entity.longitude = candidate.longitude
            if not existing_entity.phone_e164 and e164:
                existing_entity.phone_e164 = e164
                existing_entity.phone_raw = candidate.raw_phone or e164
                self._entities_by_phone[e164] = existing_entity

            # Cross-source confidence calculation
            distinct_providers = len({p.provider for p in existing_entity.provenance_list})
            existing_entity.discovery_confidence = min(
                0.5 + (distinct_providers * 0.2) + (len(existing_entity.provenance_list) * 0.05),
                1.0
            )

            return existing_entity, False
        else:
            # Create new unified CandidateEntity node
            entity_id = f"ent_{uuid.uuid4().hex[:12]}"
            new_entity = CandidateEntity(
                entity_id=entity_id,
                primary_name=candidate.clean_name,
                name_variations=[candidate.clean_name],
                phone_e164=e164 or "",
                phone_raw=candidate.raw_phone or e164 or "",
                is_mobile=phone_data.get("is_mobile", False) if phone_data else False,
                is_whatsapp_eligible=phone_data.get("is_whatsapp_eligible", False) if phone_data else False,
                address=candidate.raw_address,
                city=city,
                district=district,
                subdivision=candidate.provider_metadata.get("subdivision"),
                website=candidate.raw_website,
                latitude=candidate.latitude,
                longitude=candidate.longitude,
                provenance_list=[prov],
                discovery_confidence=0.5,
                qualification_state=QualificationState.CANDIDATE
            )

            if e164:
                self._entities_by_phone[e164] = new_entity
            if domain:
                self._entities_by_domain[domain] = new_entity
            self._entities_by_name_district[name_key] = new_entity
            self._all_entities.append(new_entity)

            return new_entity, True

    def get_all_entities(self) -> List[CandidateEntity]:
        return list(self._all_entities)

    def get_qualified_entities(self) -> List[CandidateEntity]:
        return [
            e for e in self._all_entities
            if e.qualification_state in (QualificationState.QUALIFIED, QualificationState.UNVERIFIED)
        ]
