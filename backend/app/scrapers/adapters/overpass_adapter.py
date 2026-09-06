"""
OpenStreetMap Overpass Structured Geographic Discovery Adapter for Business Discovery Engine V3.
Executes structured tag queries bounded by city and district polygons.
Provides high-recall POI discovery without relying on lexical free-text search.
"""
import uuid
import logging
from typing import List, Dict, Any, Optional
import httpx

from backend.app.schemas.intelligence import (
    ProviderQuery,
    RawBusinessCandidate,
    QueryFamily,
    CategoryProfile
)
from backend.app.scrapers.adapters.base_adapter import BaseProviderAdapter
from backend.app.scrapers.directory_scraper import DirectoryScraper

logger = logging.getLogger(__name__)


class OverpassAdapter(BaseProviderAdapter):
    """
    Overpass API Structured Discovery Adapter:
    - Bounded geographic search via OSM area filters.
    - Multi-tag extraction (amenity, healthcare, shop, office, craft).
    - Extracts complete POI metadata, coordinates, addresses, and contacts.
    """

    ENDPOINTS = [
        "https://overpass-api.de/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter",
        "https://z.overpass-api.de/api/interpreter",
    ]

    HEADERS = {
        "User-Agent": "Tezlify-DiscoveryEngine-V3/1.0 (contact@tezlify.io)",
        "Accept": "application/json"
    }

    @property
    def provider_name(self) -> str:
        return "overpass"

    def _build_overpass_query(
        self,
        district: str,
        city: str,
        profile: Optional[CategoryProfile] = None,
        osm_tags: Optional[Dict[str, str]] = None
    ) -> str:
        """
        Constructs an Overpass QL query string bounded by target district.
        """
        tag_clauses: List[str] = []

        if osm_tags:
            for k, v in osm_tags.items():
                tag_clauses.append(f'node["{k}"="{v}"](area.searchArea);')
                tag_clauses.append(f'way["{k}"="{v}"](area.searchArea);')
        elif profile:
            for amenity in profile.osm_amenities:
                tag_clauses.append(f'node["amenity"="{amenity}"](area.searchArea);')
                tag_clauses.append(f'way["amenity"="{amenity}"](area.searchArea);')
            for shop in profile.osm_shops:
                tag_clauses.append(f'node["shop"="{shop}"](area.searchArea);')
                tag_clauses.append(f'way["shop"="{shop}"](area.searchArea);')
            # Extra healthcare tags if present
            if hasattr(profile, "osm_healthcare"):
                for hc in getattr(profile, "osm_healthcare", []):
                    tag_clauses.append(f'node["healthcare"="{hc}"](area.searchArea);')
                    tag_clauses.append(f'way["healthcare"="{hc}"](area.searchArea);')

        # Fallback if no specific tags mapped
        if not tag_clauses:
            tag_clauses.append('node["amenity"](area.searchArea);')
            tag_clauses.append('node["shop"](area.searchArea);')

        clauses_str = "\n  ".join(tag_clauses)
        return f"""
[out:json][timeout:25];
area["name"="{district}"]->.searchArea;
(
  {clauses_str}
);
out center tags;
"""

    async def execute_query(
        self,
        client: httpx.AsyncClient,
        query: ProviderQuery,
        profile: Optional[CategoryProfile] = None,
        max_pages: int = 1
    ) -> List[RawBusinessCandidate]:
        candidates: List[RawBusinessCandidate] = []
        ql_query = self._build_overpass_query(
            district=query.district,
            city=query.city,
            profile=profile,
            osm_tags=query.osm_tags
        )

        for endpoint in self.ENDPOINTS:
            try:
                resp = await client.post(
                    endpoint,
                    data={"data": ql_query},
                    headers=self.HEADERS,
                    timeout=20.0
                )
                if resp.status_code == 200:
                    data = resp.json()
                    elements = data.get("elements", [])
                    logger.info(f"[OVERPASS_ADAPTER] Query for '{query.district}' returned {len(elements)} raw elements.")

                    for el in elements:
                        tags = el.get("tags", {})
                        raw_name = tags.get("name") or tags.get("brand") or tags.get("name:tr")
                        if not raw_name or len(raw_name.strip()) < 2:
                            continue

                        clean_name = DirectoryScraper._clean_business_name(raw_name)
                        osm_type = el.get("type", "node")
                        osm_id = el.get("id", "")
                        record_id = f"osm_{osm_type}_{osm_id}"

                        lat = el.get("lat") or (el.get("center", {}).get("lat") if "center" in el else None)
                        lon = el.get("lon") or (el.get("center", {}).get("lon") if "center" in el else None)

                        raw_phone = (
                            tags.get("phone") or
                            tags.get("contact:phone") or
                            tags.get("contact:mobile") or
                            tags.get("mobile")
                        )
                        raw_web = tags.get("website") or tags.get("contact:website")
                        clean_web = DirectoryScraper._clean_website(raw_web)

                        # Construct address from structured OSM tags
                        street = tags.get("addr:street") or tags.get("street")
                        hn = tags.get("addr:housenumber") or ""
                        nh = tags.get("addr:neighbourhood") or tags.get("addr:suburb") or query.subdivision or ""
                        addr_parts = [p for p in [street, hn, nh, f"{query.district}/{query.city}"] if p]
                        display_address = ", ".join(addr_parts) if addr_parts else f"{query.district}, {query.city}"

                        category_hint = (
                            tags.get("amenity") or
                            tags.get("healthcare") or
                            tags.get("shop") or
                            tags.get("office") or
                            tags.get("craft")
                        )

                        candidates.append(RawBusinessCandidate(
                            candidate_id=f"ovp_{uuid.uuid4().hex[:12]}",
                            provider="overpass",
                            provider_query=query.query_text,
                            query_family=query.query_family,
                            query_id=query.query_id,
                            raw_name=raw_name,
                            clean_name=clean_name,
                            raw_category=category_hint,
                            raw_address=display_address,
                            raw_phone=raw_phone,
                            raw_website=clean_web,
                            source_url=f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
                            latitude=float(lat) if lat else None,
                            longitude=float(lon) if lon else None,
                            provider_metadata={
                                "osm_id": osm_id,
                                "osm_type": osm_type,
                                "tags": tags,
                                "subdivision": nh or query.subdivision
                            }
                        ))

                    return candidates
                else:
                    logger.warning(f"[OVERPASS_ADAPTER] Endpoint {endpoint} returned status {resp.status_code}. Trying next mirror...")
            except Exception as e:
                logger.warning(f"[OVERPASS_ADAPTER] Endpoint {endpoint} connection failed: {e}. Trying next mirror...")

        return candidates
