"""
OpenStreetMap Nominatim Provider Adapter for Business Discovery Engine V2.
Executes targeted geo-category and subdivision queries, returning RawBusinessCandidate records with provenance.
"""
import uuid
import logging
from typing import List, Dict, Any
from urllib.parse import quote
import httpx
from backend.app.schemas.intelligence import ProviderQuery, RawBusinessCandidate, QueryFamily
from backend.app.scrapers.adapters.base_adapter import BaseProviderAdapter
from backend.app.scrapers.directory_scraper import DirectoryScraper

logger = logging.getLogger(__name__)


class OSMAdapter(BaseProviderAdapter):
    """
    OpenStreetMap Nominatim Discovery Adapter:
    Executes targeted amenity, shop, and subdivision queries.
    """

    HEADERS = {
        "User-Agent": "Tezlify-DiscoveryEngine-V2/8.0 (contact@tezlify.io)"
    }

    @property
    def provider_name(self) -> str:
        return "osm"

    async def execute_query(
        self,
        client: httpx.AsyncClient,
        query: ProviderQuery,
        max_pages: int = 1
    ) -> List[RawBusinessCandidate]:
        candidates: List[RawBusinessCandidate] = []
        encoded_q = quote(query.query_text)
        url = f"https://nominatim.openstreetmap.org/search?q={encoded_q}&format=json&addressdetails=1&extratags=1&limit={query.limit}"

        try:
            resp = await client.get(url, headers=self.HEADERS, timeout=12.0)
            if resp.status_code == 200:
                items = resp.json()
                for item in items:
                    raw_name = item.get("name", "").strip()
                    if not raw_name or len(raw_name) < 2:
                        continue

                    clean_name = DirectoryScraper._clean_business_name(raw_name)
                    addr = item.get("address", {})
                    tags = item.get("extratags") or {}

                    raw_phone = tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile")
                    raw_web = tags.get("website") or tags.get("contact:website")
                    clean_web = DirectoryScraper._clean_website(raw_web)

                    road = addr.get("road") or addr.get("suburb") or query.district
                    display_addr = f"{road}, {query.district}/{query.city}"
                    candidate_id = f"osm_{uuid.uuid4().hex[:12]}"

                    category_hint = tags.get("amenity") or tags.get("shop") or tags.get("healthcare") or tags.get("office")

                    candidates.append(RawBusinessCandidate(
                        candidate_id=candidate_id,
                        provider="osm",
                        provider_query=query.query_text,
                        query_family=query.query_family,
                        query_id=query.query_id,
                        raw_name=raw_name,
                        clean_name=clean_name,
                        raw_category=category_hint,
                        raw_address=display_addr,
                        raw_phone=raw_phone,
                        raw_website=clean_web,
                        source_url=f"https://www.openstreetmap.org/{item.get('osm_type', 'node')}/{item.get('osm_id', '')}",
                        latitude=float(item.get("lat", 0)),
                        longitude=float(item.get("lon", 0)),
                        provider_metadata={
                            "osm_id": item.get("osm_id"),
                            "osm_type": item.get("osm_type"),
                            "subdivision": query.subdivision,
                            "address_details": addr,
                            "extratags": tags
                        }
                    ))

        except Exception as e:
            logger.warning(f"[OSM_ADAPTER] Error executing query '{query.query_text}': {e}")

        return candidates
