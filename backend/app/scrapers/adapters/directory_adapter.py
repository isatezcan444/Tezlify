"""
Turkish B2B Directory Provider Adapter for Business Discovery Engine V3.
Executes directory category-slug discovery across all available pages until exhaustion.
"""
import uuid
import logging
from typing import List, Optional
import httpx

from backend.app.schemas.intelligence import (
    ProviderQuery,
    RawBusinessCandidate,
    CategoryProfile
)
from backend.app.scrapers.adapters.base_adapter import BaseProviderAdapter
from backend.app.scrapers.directory_scraper import DirectoryScraper

logger = logging.getLogger(__name__)


class DirectoryAdapter(BaseProviderAdapter):
    """
    Turkish B2B Directory Adapter (Bulurum.com & local registries).
    Supports exhaustive pagination across result pages.
    """

    def __init__(self):
        self._scraper = DirectoryScraper()

    @property
    def provider_name(self) -> str:
        return "directory"

    async def execute_query(
        self,
        client: httpx.AsyncClient,
        query: ProviderQuery,
        profile: Optional[CategoryProfile] = None,
        max_pages: int = 10
    ) -> List[RawBusinessCandidate]:
        candidates: List[RawBusinessCandidate] = []
        slug = query.category_slug or "isletmeler"

        try:
            raw_leads = await self._scraper.scrape_district_slug(
                client=client,
                slug=slug,
                district=query.district,
                city=query.city,
                max_pages=max_pages
            )

            for item in raw_leads:
                raw_name = item.get("name", "").strip()
                if not raw_name or len(raw_name) < 2:
                    continue

                clean_name = self._scraper._clean_business_name(raw_name)
                candidate_id = f"dir_{uuid.uuid4().hex[:12]}"
                phone = item.get("phone")
                phone_e164 = item.get("phone_e164")

                candidates.append(RawBusinessCandidate(
                    candidate_id=candidate_id,
                    provider="directory",
                    provider_query=query.query_text,
                    query_family=query.query_family,
                    query_id=query.query_id,
                    raw_name=raw_name,
                    clean_name=clean_name,
                    raw_category=slug.replace("-", " ").title(),
                    raw_address=item.get("address"),
                    raw_phone=phone,
                    raw_website=item.get("website"),
                    source_url=f"https://www.bulurum.com/search/{slug}/{query.district}/",
                    latitude=item.get("latitude"),
                    longitude=item.get("longitude"),
                    provider_metadata={
                        "category_slug": slug,
                        "subdivision": query.subdivision,
                        "phone_e164": phone_e164,
                        "raw_item": item
                    }
                ))

        except Exception as e:
            logger.warning(f"[DIRECTORY_ADAPTER] Error executing query '{query.query_text}': {e}")

        return candidates
