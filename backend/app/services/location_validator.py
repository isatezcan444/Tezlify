"""
Location Resolution and Geographic Scope Validation Engine for Business Discovery Engine V3.
Performs deterministic hierarchical location verification:
EXACT -> SUBDIVISION -> CITY_ONLY -> OUTSIDE_TARGET -> UNKNOWN.
"""
import enum
import logging
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

from backend.app.data.turkey_locations import (
    normalize_turkish,
    get_districts_for_city
)
from backend.app.data.turkey_subdivisions import get_subdivisions_for_district

logger = logging.getLogger(__name__)


class LocationStatus(str, enum.Enum):
    EXACT = "EXACT"
    SUBDIVISION = "SUBDIVISION"
    CITY_ONLY = "CITY_ONLY"
    OUTSIDE_TARGET = "OUTSIDE_TARGET"
    UNKNOWN = "UNKNOWN"


class LocationAssessment(BaseModel):
    status: LocationStatus
    confidence: float
    matched_district: Optional[str] = None
    matched_subdivision: Optional[str] = None
    reason: str


class LocationValidator:
    """
    V3 Hierarchical Location Validator:
    - Verifies address text and structured OSM address components.
    - Evaluates neighborhood/subdivision presence.
    - Strictly rejects OUTSIDE_TARGET districts.
    """

    @classmethod
    def evaluate(
        cls,
        target_city: str,
        target_districts: List[str],
        result_address: Optional[str],
        result_name: Optional[str] = None,
        structured_metadata: Optional[Dict[str, Any]] = None,
        target_neighborhoods: Optional[List[str]] = None,
    ) -> LocationAssessment:
        if not target_city:
            return LocationAssessment(
                status=LocationStatus.UNKNOWN,
                confidence=0.0,
                reason="Hedef şehir belirtilmedi."
            )

        norm_city = normalize_turkish(target_city)
        norm_targets = [normalize_turkish(d) for d in target_districts]
        all_city_districts = get_districts_for_city(target_city)
        all_city_norm = [normalize_turkish(d) for d in all_city_districts]

        corpus = f"{result_name or ''} {result_address or ''}"
        norm_corpus = normalize_turkish(corpus)

        # 1. Structured metadata evaluation (OSM address details / Overpass tags)
        if structured_metadata:
            addr_details = structured_metadata.get("address_details") or structured_metadata.get("tags") or {}
            for field in ["suburb", "city_district", "district", "town", "borough", "addr:district", "addr:suburb"]:
                val = addr_details.get(field)
                if val:
                    norm_val = normalize_turkish(val)
                    for idx, td in enumerate(norm_targets):
                        if norm_val == td:
                            return LocationAssessment(
                                status=LocationStatus.EXACT,
                                confidence=1.0,
                                matched_district=target_districts[idx],
                                reason=f"Yapısal veri üzerinden ilçe doğrulandı: {target_districts[idx]}"
                            )
                    if norm_val in all_city_norm and norm_val not in norm_targets:
                        return LocationAssessment(
                            status=LocationStatus.OUTSIDE_TARGET,
                            confidence=1.0,
                            matched_district=val,
                            reason=f"Hedef dışı ilçe tespiti: {val} ({target_city})"
                        )

            # Check structured neighbourhood
            nh = addr_details.get("neighbourhood") or addr_details.get("addr:neighbourhood")
            if nh:
                norm_nh = normalize_turkish(nh)
                for td in target_districts:
                    subs = [normalize_turkish(s) for s in get_subdivisions_for_district(target_city, td)]
                    if norm_nh in subs or any(s in norm_nh for s in subs):
                        return LocationAssessment(
                            status=LocationStatus.SUBDIVISION,
                            confidence=0.95,
                            matched_district=td,
                            matched_subdivision=nh,
                            reason=f"Hedef ilçe mahalle/alt-bölge doğrulandı: {nh} ({td})"
                        )

        # 2. Text Corpus Evaluation
        # A. Check if Address Contains Another District in Same City -> OUTSIDE_TARGET
        # District boundaries are strict: a mention of another district (e.g. Pendik/İstanbul)
        # must always be rejected even if a shared neighborhood name is mentioned.
        for d in all_city_districts:
            nd = normalize_turkish(d)
            if nd not in norm_targets:
                if (
                    f"{nd}/" in norm_corpus or f"{nd}," in norm_corpus or f" {nd} " in norm_corpus or 
                    f"{nd} mah" in norm_corpus or f"{nd} merkez" in norm_corpus or f"{nd} cad" in norm_corpus or
                    norm_corpus.startswith(f"{nd} ") or norm_corpus.endswith(f" {nd}") or norm_corpus == nd
                ):
                    return LocationAssessment(
                        status=LocationStatus.OUTSIDE_TARGET,
                        confidence=0.9,
                        matched_district=d,
                        reason=f"Farklı ilçe adresi tespit edildi: {d} (Hedef: {', '.join(target_districts)})"
                    )

        # B. Check Subdivisions of Target Districts
        import re
        matched_sub: Optional[str] = None
        matched_td: Optional[str] = None
        for td in target_districts:
            subs = get_subdivisions_for_district(target_city, td)
            if target_neighborhoods:
                # Prioritize explicit target neighborhoods
                subs = [s for s in subs if any(normalize_turkish(tn) == normalize_turkish(s) for tn in target_neighborhoods)] + [
                    s for s in subs if not any(normalize_turkish(tn) == normalize_turkish(s) for tn in target_neighborhoods)
                ]
            for sub in subs:
                norm_sub = normalize_turkish(sub)
                if not norm_sub:
                    continue
                # Match word boundary (handles "Barbaros,", "Yenişehir Mah.", "Barbaros Cad.")
                pattern = r"\b" + re.escape(norm_sub) + r"\b"
                if re.search(pattern, norm_corpus):
                    matched_sub = sub
                    matched_td = td
                    break
            if matched_sub:
                break

        # C. Check Exact Target District in Address
        for idx, td in enumerate(target_districts):
            norm_td = norm_targets[idx]
            if norm_td in norm_corpus:
                if matched_sub:
                    return LocationAssessment(
                        status=LocationStatus.SUBDIVISION,
                        confidence=1.0,
                        matched_district=td,
                        matched_subdivision=matched_sub,
                        reason=f"Adres metninde ilçe ve mahalle doğrulandı: {td} > {matched_sub}"
                    )
                return LocationAssessment(
                    status=LocationStatus.EXACT,
                    confidence=0.85,
                    matched_district=td,
                    reason=f"Adres metninde ilçe doğrulandı: {td}"
                )

        if matched_sub and matched_td:
            return LocationAssessment(
                status=LocationStatus.SUBDIVISION,
                confidence=0.9,
                matched_district=matched_td,
                matched_subdivision=matched_sub,
                reason=f"Adres metninde mahalle/semt doğrulandı: {matched_sub} ({matched_td})"
            )

        # D. Check City Only Match
        if norm_city in norm_corpus:
            return LocationAssessment(
                status=LocationStatus.CITY_ONLY,
                confidence=0.5,
                reason=f"İl ({target_city}) doğrulandı fakat ilçe detayı ayrıştırılamadı."
            )

        return LocationAssessment(
            status=LocationStatus.UNKNOWN,
            confidence=0.0,
            reason="Lokasyon bilgisi tespit edilemedi."
        )
