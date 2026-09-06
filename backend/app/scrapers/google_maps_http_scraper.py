"""
High-performance pure HTTP Google Maps scraper engine.

Queries Google Maps internal JSON RPC endpoint (/search?tbm=map) directly via httpx,
completely eliminating headless browser (Chromium/Playwright) overhead, memory bloat,
and OOM crashes on memory-constrained cloud environments (e.g. Render 512MB RAM).

Data extraction integrity:
- Clean Place Name, Categories, Rating & Review count
- Phone normalization via PhoneService (E.164 and mobile detection)
- Clean Official Website unwrap (filtering social / directory aggregators)
- Deterministic place_id hashing matching AGENTS.md invariant 1.3
- Live streaming callback invocation (on_place_inspected) for real-time WebSocket updates
"""

import asyncio
import hashlib
import json
import logging
import re
import urllib.parse
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

import httpx

from backend.app.core.config import settings
from backend.app.scrapers.google_maps_playwright_scraper import (
    clean_extracted_address,
    clean_extracted_website,
    strip_leading_business_name,
)
from backend.app.services.phone_service import PhoneService

logger = logging.getLogger("tezlify.scraper.http")

PHONE_REGEX = re.compile(
    r"(?:0[2-5]\d{2}[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|"
    r"\(0[2-5]\d{2}\)[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|"
    r"\+90[\s.\-()]*[2-5]\d{2}[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|"
    r"05\d{2}[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|"
    r"0850[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2})"
)


class GoogleMapsHttpScraper:
    """Zero-overhead pure HTTP/JSON scraper for Google Maps places."""

    def __init__(self):
        self.headers = {
            "User-Agent": settings.SCRAPER_USER_AGENT,
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://www.google.com/maps",
            "Cookie": "CONSENT=YES+cb.20230531-04-p0.tr+FX+999",
            "Accept": "*/*",
        }
        self.page_size = 20
        self.max_pages = getattr(settings, "SCRAPER_HTTP_MAX_PAGES_PER_QUERY", 10)
        self.timeout = getattr(settings, "SCRAPER_HTTP_TIMEOUT_SECONDS", 12.0)

    def _build_search_url(self, query: str, start: int = 0) -> str:
        """Constructs Google Maps internal map-search RPC URL."""
        pb = (
            f"!4m12!1m3!1d14248!2d0!3d0"
            f"!2m3!1f0!2f0!3f0!3m2!1i1280!2i593!4f13.1"
            f"!7i{self.page_size}"
        )
        if start > 0:
            pb += f"!8i{start}"
        pb += "!10b1"

        encoded_q = urllib.parse.quote(query)
        return (
            f"https://www.google.com/search?tbm=map&authuser=0&hl=tr&gl=tr"
            f"&pb={pb}&q={encoded_q}&tch=1&ech=1"
        )

    _FID_RE = re.compile(r"0x[0-9a-f]+:0x[0-9a-f]+")

    @classmethod
    def _extract_place_ids(cls, pd: List[Any]) -> tuple[str, Optional[str], Optional[str]]:
        """Finds (fid, g_path, chij) in the place descriptor.

        Google buries ["0x…:0x…", null, null, "/g/…", "ChIJ…", …] a few levels
        deep next to reviews/photos metadata. The FID+/g pair is what Google's
        own share URLs carry (!1s<fid> … !16s<g/...>), so pins built from it
        resolve exactly like a native share instead of a bare coordinate view.
        Returns ("", None, None) when absent — callers fall back to base URLs.
        """
        fid = pd[10] if (len(pd) > 10 and isinstance(pd[10], str)) else ""

        def _walk(obj: Any) -> Optional[tuple[str, Optional[str]]]:
            if isinstance(obj, list):
                strs = [x for x in obj if isinstance(x, str)]
                gpaths = [x for x in strs if x.startswith("/g/")]
                if gpaths:
                    fids = [x for x in strs if cls._FID_RE.fullmatch(x)]
                    chijs = [x for x in strs if x.startswith("ChIJ")]
                    return (fids[0] if fids else fid), (
                        gpaths[0],
                        chijs[0] if chijs else None,
                    )
                for x in obj:
                    found = _walk(x)
                    if found:
                        return found
            return None

        found = _walk(pd)
        if found:
            pair_fid, (g_path, chij) = found
            return pair_fid or fid, g_path, chij
        return fid, None, None

    def _extract_phone(self, pd: List[Any]) -> Optional[str]:
        """Extracts candidate phone number from place descriptor."""
        # 1. Direct phone descriptor list at pd[178]
        if len(pd) > 178 and isinstance(pd[178], list) and pd[178]:
            p_block = str(pd[178])
            m = PHONE_REGEX.search(p_block)
            if m:
                return m.group(0).strip()

        # 2. Deep regex search inside place descriptor
        m = PHONE_REGEX.search(str(pd))
        if m:
            return m.group(0).strip()

        return None

    def _extract_website(self, pd: List[Any]) -> Optional[str]:
        """Extracts and unwraps official website URL."""
        raw_u = None
        # Primary website field at pd[7][0]
        if len(pd) > 7 and isinstance(pd[7], list) and pd[7] and isinstance(pd[7][0], str):
            raw_u = pd[7][0]

        # Secondary website field at pd[75] (appointment/official link)
        if not raw_u and len(pd) > 75 and isinstance(pd[75], list):
            m = re.search(r"https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\"\\\)]*", str(pd[75]))
            if m:
                raw_u = m.group(0)

        if raw_u:
            return clean_extracted_website(raw_u)
        return None

    def _extract_category(self, pd: List[Any], keyword: str) -> str:
        """Extracts clean primary sector category from pd[13]."""
        if len(pd) > 13 and isinstance(pd[13], list) and pd[13]:
            first_cat = str(pd[13][0]).strip()
            # Clean embedded formatting or newlines
            first_cat = first_cat.split("\n")[0].strip()
            if 2 <= len(first_cat) <= 50:
                return first_cat

        return keyword.title()[:50]

    def _extract_coordinates(self, pd: List[Any]) -> tuple[Optional[float], Optional[float]]:
        """Extracts (latitude, longitude) from pd[9]."""
        lat, lon = None, None
        if len(pd) > 9 and isinstance(pd[9], list) and len(pd[9]) > 3:
            try:
                if pd[9][2] is not None:
                    lat = float(pd[9][2])
                if pd[9][3] is not None:
                    lon = float(pd[9][3])
            except (ValueError, TypeError):
                pass
        return lat, lon

    def _parse_place_entry(
        self,
        entry: List[Any],
        keyword: str,
        city: str,
        district: str,
    ) -> Optional[Dict[str, Any]]:
        """Transforms a raw Google Maps JSON array item into a canonical Tezlify lead dict."""
        if not isinstance(entry, list) or len(entry) <= 14:
            return None

        pd = entry[14]
        if not isinstance(pd, list) or len(pd) <= 11:
            return None

        raw_name = pd[11]
        if not isinstance(raw_name, str) or not raw_name.strip():
            return None

        safe_name = raw_name.split("\n")[0].strip()[:300]
        cid = pd[10] if (len(pd) > 10 and isinstance(pd[10], str)) else ""

        # Coordinates
        lat, lon = self._extract_coordinates(pd)

        # Canonical Google Maps URL, minimal share form (also the place_id
        # hash input — keep byte-stable so re-scrapes match saved rows).
        if lat is not None and lon is not None:
            base_url = f"https://www.google.com/maps/place/{urllib.parse.quote(safe_name)}/@{lat},{lon},17z"
        elif cid:
            base_url = f"https://www.google.com/maps/search/?api=1&query={urllib.parse.quote(safe_name)}&query_place_id={cid}"
        else:
            base_url = f"https://www.google.com/maps/search/{urllib.parse.quote(safe_name)}"

        # Display URL: byte-faithful reconstruction of Google's native share
        # shape (verified against a live share link):
        #   place/<slug>/@lat,lon,17z/data=!3m1!4b1!4m6!3m5!1s<fid>!8m2!3d<lat>!4d<lon>!16s<g/…>
        # The FID+/g pair pins the EXACT listing (dense buildings included);
        # anything missing degrades to base_url. place_id always hashes
        # base_url, never the display form.
        fid, g_path, _chij = self._extract_place_ids(pd)
        if lat is not None and lon is not None and fid and g_path:
            slug = urllib.parse.quote_plus(safe_name)
            maps_url = (
                f"https://www.google.com/maps/place/{slug}/@{lat},{lon},17z"
                f"/data=!3m1!4b1!4m6!3m5!1s{fid}"
                f"!8m2!3d{lat}!4d{lon}!16s{urllib.parse.quote(g_path, safe='')}"
            )
        else:
            maps_url = base_url

        # Deterministic place_id conforming to AGENTS.md invariant 1.3
        place_id = f"gmaps_{hashlib.sha256(base_url.encode()).hexdigest()[:16]}"

        # Address (pd[18] carries a "Business Name, street..." prefix — strip it
        # BEFORE cleaning so cards show streets and dedup compares streets).
        # No address → None (never a fabricated "district, city": the display
        # fallback lives in the orchestrator, while geo/coord logic must see
        # the absence honestly).
        raw_addr = pd[18] if (len(pd) > 18 and isinstance(pd[18], str)) else None
        if raw_addr:
            raw_addr = strip_leading_business_name(safe_name, raw_addr)
        full_address = clean_extracted_address(raw_addr) if raw_addr else None

        # Category
        safe_category = self._extract_category(pd, keyword)

        # Rating & Reviews
        rating = None
        reviews_count = 0
        if len(pd) > 4 and isinstance(pd[4], list):
            try:
                if len(pd[4]) > 7 and pd[4][7] is not None:
                    rating = float(pd[4][7])
                if len(pd[4]) > 8 and pd[4][8] is not None:
                    reviews_count = int(pd[4][8])
            except (ValueError, TypeError):
                pass

        # Website
        website = self._extract_website(pd)

        # Phone
        phone_match = self._extract_phone(pd)
        phone_data = PhoneService.normalize_to_e164(phone_match) if phone_match else None
        raw_phone = phone_data["national_number"] if phone_data else (phone_match or "")

        return {
            "name": safe_name,
            "category": safe_category,
            "phone": raw_phone[:50] if raw_phone else None,
            "phone_e164": phone_data["e164"] if phone_data else None,
            "is_mobile": phone_data.get("is_mobile", False) if phone_data else False,
            "is_whatsapp_eligible": phone_data.get("is_whatsapp_eligible", False) if phone_data else False,
            "website": website[:500] if website else None,
            "address": full_address[:500] if full_address else None,
            "city": city[:100],
            "district": district[:100],
            "latitude": lat,
            "longitude": lon,
            "rating": rating,
            "reviews_count": reviews_count,
            "google_maps_url": maps_url[:1000],
            "place_id": place_id,
            "source": "GOOGLE_MAPS",
            "is_verified": bool(phone_data or website or rating),
            "display_name": f"{safe_name}, {full_address}"[:500],
        }

    async def scrape_district_places(
        self,
        keyword: str,
        city: str,
        district: str,
        max_results: Optional[int] = None,
        on_place_inspected: Optional[Callable[[Dict[str, Any], int, int], Awaitable[None]]] = None,
        on_progress_status: Optional[Callable[..., Awaitable[None]]] = None,
        max_pages: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Executes paginated HTTP JSON retrieval for the given district query.
        Returns the list of raw discovered place dictionaries.
        """
        clean_keyword = keyword.strip()
        clean_city = city.strip()
        clean_district = district.strip()
        search_query = f"{clean_city} {clean_district} {clean_keyword}".strip()

        target_count = max_results if (max_results and max_results > 0) else getattr(
            settings, "SCRAPER_UNLIMITED_DISTRICT_TARGET", 200
        )
        progress_denominator = target_count

        logger.info(
            f"[GMAPS_HTTP] Starting fast retrieval: query='{search_query}', target={target_count}"
        )
        if on_progress_status:
            await on_progress_status(
                f"Google Maps taraması başlatıldı: '{search_query}'", 15,
                "leadFinder.stream.engineStarted", {"query": search_query},
            )

        discovered: List[Dict[str, Any]] = []
        seen_place_ids: Set[str] = set()
        seen_names: Set[str] = set()

        start = 0
        consecutive_empty = 0
        page_budget = max_pages if (max_pages and max_pages > 0) else self.max_pages

        async with httpx.AsyncClient(headers=self.headers, timeout=self.timeout) as client:
            for page_num in range(page_budget):
                if len(discovered) >= target_count:
                    logger.info(f"[GMAPS_HTTP] Target count {target_count} satisfied.")
                    break

                page_url = self._build_search_url(search_query, start=start)

                try:
                    resp = await client.get(page_url)
                except httpx.HTTPError as net_err:
                    logger.warning(f"[GMAPS_HTTP] Network glitch at start={start}: {net_err}")
                    # Brief jitter backoff on network failure
                    await asyncio.sleep(1.0)
                    continue

                # Retry with backoff on transient HTTP errors: a single 429/5xx
                # must not truncate the whole district stream.
                if resp.status_code != 200:
                    recovered = False
                    for attempt in (1, 2):
                        await asyncio.sleep(float(attempt))
                        try:
                            resp = await client.get(page_url)
                        except httpx.HTTPError as net_err:
                            logger.warning(f"[GMAPS_HTTP] Retry {attempt} network glitch: {net_err}")
                            continue
                        if resp.status_code == 200:
                            recovered = True
                            break
                        logger.warning(
                            f"[GMAPS_HTTP] Retry {attempt} HTTP status={resp.status_code} at start={start}"
                        )
                    if not recovered:
                        logger.warning(f"[GMAPS_HTTP] Giving up page at start={start}")
                        break

                text = resp.text.split("/*")[0]
                try:
                    outer, _ = json.JSONDecoder().raw_decode(text)
                    inner_text = outer.get("d", text) if isinstance(outer, dict) else text
                except Exception:
                    inner_text = text

                if inner_text.startswith(")]}\x27\n"):
                    inner_text = inner_text[5:]
                elif inner_text.startswith(")]}\x27"):
                    inner_text = inner_text[4:]

                try:
                    data = json.loads(inner_text)
                except json.JSONDecodeError:
                    logger.warning(f"[GMAPS_HTTP] Malformed JSON payload at start={start}")
                    break

                # Extract listings array (located at data[0][1])
                listings: List[Any] = []
                if isinstance(data, list) and len(data) > 0 and isinstance(data[0], list):
                    if len(data[0]) > 1 and isinstance(data[0][1], list):
                        raw_list = data[0][1]
                        # Index 0 is search metadata, index 1..N are place entries
                        listings = [item for item in raw_list[1:] if isinstance(item, list) and len(item) > 14]

                if not listings:
                    consecutive_empty += 1
                    if consecutive_empty >= 2:
                        logger.info(f"[GMAPS_HTTP] End of results stream for '{search_query}' at start={start}.")
                        break
                    start += self.page_size
                    continue

                consecutive_empty = 0

                for item in listings:
                    if len(discovered) >= target_count:
                        break

                    lead_dict = self._parse_place_entry(
                        entry=item,
                        keyword=clean_keyword,
                        city=clean_city,
                        district=clean_district,
                    )
                    if not lead_dict:
                        continue

                    pid = lead_dict["place_id"]
                    norm_name = lead_dict["name"].lower().strip()

                    if pid in seen_place_ids or norm_name in seen_names:
                        continue

                    seen_place_ids.add(pid)
                    seen_names.add(norm_name)
                    discovered.append(lead_dict)

                    if on_place_inspected:
                        await on_place_inspected(lead_dict, len(discovered), progress_denominator)

                pct = min(90, int((len(discovered) / max(target_count, 1)) * 90))
                if on_progress_status:
                    await on_progress_status(
                        f"Keşif akıyor: {len(discovered)} işletme incelendi...",
                        pct,
                        "leadFinder.stream.discoveryProgress",
                        {"count": len(discovered)},
                    )

                # If fewer listings were returned than page size, Google has no more results
                if len(listings) < (self.page_size - 5):
                    logger.info(f"[GMAPS_HTTP] Reached final page ({len(listings)} items).")
                    break

                start += self.page_size
                # Politeness micro-sleep to prevent 429
                await asyncio.sleep(0.3)

        logger.info(
            f"[GMAPS_HTTP] Completed retrieval for '{search_query}': {len(discovered)} places."
        )
        return discovered
