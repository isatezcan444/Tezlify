"""
Turkish B2B Directory Provider (Bulurum & Local Directory Extractor).
Performs multi-category slug discovery, exhaustive pagination across result pages,
and extracts verified business names, telephone numbers, addresses, and websites.
"""
import re
import json
import logging
from typing import List, Dict, Any, Optional, Set
import httpx
from bs4 import BeautifulSoup
from urllib.parse import quote, unquote

from backend.app.data.turkey_locations import normalize_turkish
from backend.app.services.phone_service import PhoneService

logger = logging.getLogger(__name__)


class DirectoryScraper:
    """
    Turkish B2B Directory Provider:
    - Queries verified business directory categories (e.g. diş-klinikleri, mobilya-magazalari).
    - Iterates pages (Page 1..N) until directory results are exhausted.
    - Extracts structured company data, phone numbers (02xx landlines & 05xx mobile GSMs),
      exact addresses, and websites.
    """

    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "DNT": "1"
    }

    @classmethod
    def _clean_business_name(cls, raw_title: str) -> str:
        """Cleans search engine suffixes, addresses, and pipe separators from company name."""
        if not raw_title:
            return ""
        cleaned = re.sub(
            r'(\s*[\-\|\:\–\—\•]\s*(İletişim|Telefon|Adres|Hakkında|Harita|Yol Tarifi|Randevu|Fiyatları|Yorumları|Bulurum|Sarı Sayfalar).*$)',
            '',
            raw_title,
            flags=re.IGNORECASE
        )
        cleaned = re.sub(r'(\.\.\.|\b(www\.|https?://)\S+)', '', cleaned).strip()
        cleaned = re.sub(r'\s+', ' ', cleaned)
        return cleaned

    @classmethod
    def _clean_website(cls, raw_url: Optional[str]) -> Optional[str]:
        if not raw_url:
            return None
        url = raw_url.strip()
        if "uddg=" in url:
            match = re.search(r'uddg=([^&]+)', url)
            if match:
                url = unquote(match.group(1))

        skip_domains = [
            "duckduckgo.com", "google.com", "bing.com", "yandex.com", "yahoo.com",
            "facebook.com", "twitter.com", "instagram.com", "linkedin.com", "youtube.com",
            "bulurum.com", "doktortakvimi.com", "eniyihekim.com", "sarisayfalar.com", "firmasec.com"
        ]
        if any(d in url.lower() for d in skip_domains):
            return None

        if not url.startswith("http://") and not url.startswith("https://"):
            url = f"https://{url}"
        return url

    async def scrape_district_slug(
        self,
        client: httpx.AsyncClient,
        slug: str,
        district: str,
        city: str,
        max_pages: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Scrapes a specific category slug for a district across multiple pages with exhaustive pagination.
        """
        results: List[Dict[str, Any]] = []
        district_slug = normalize_turkish(district).replace(" ", "-")
        seen_page_fingerprints: Set[str] = set()

        for page in range(1, max_pages + 1):
            if page == 1:
                url = f"https://www.bulurum.com/search/{slug}/{district_slug}/"
            else:
                url = f"https://www.bulurum.com/search/{slug}/{district_slug}/?page={page}"

            try:
                resp = await client.get(url, timeout=12.0)
                if resp.status_code != 200:
                    break

                page_leads = self._parse_html(resp.text, district, city)
                if not page_leads:
                    # Fallback mapInfo parser
                    page_leads = self._parse_map_info(resp.text, district, city)

                if not page_leads:
                    # No results on this page -> pagination exhausted
                    break

                # Create page fingerprint to prevent infinite pagination loops
                page_fp = "|".join(sorted([l.get("name", "") for l in page_leads]))
                if page_fp in seen_page_fingerprints:
                    logger.info(f"[DIRECTORY] Page {page} is duplicate of earlier page. Ending pagination for slug '{slug}'.")
                    break
                seen_page_fingerprints.add(page_fp)

                results.extend(page_leads)

                # Check if there is pagination in HTML
                soup = BeautifulSoup(resp.text, 'html.parser')
                pagination = soup.select('.pagination, .paging, .pages, a[href*="page="]')
                if not pagination and len(page_leads) < 15:
                    break

            except Exception as e:
                logger.warning(f"Error scraping directory slug '{slug}' page {page} for {district}: {e}")
                break

        return results

    def _parse_html(self, html_content: str, district: str, city: str) -> List[Dict[str, Any]]:
        """Parses company listings from Bulurum HTML structure."""
        leads: List[Dict[str, Any]] = []
        soup = BeautifulSoup(html_content, 'html.parser')

        # Find h2 company titles
        for h2 in soup.find_all('h2'):
            a_tag = h2.find('a')
            if not a_tag:
                continue

            raw_name = a_tag.get_text(separator=' ', strip=True)
            if not raw_name or len(raw_name) < 3:
                continue

            clean_name = self._clean_business_name(raw_name)

            # Find parent container
            container = h2.find_parent('div', class_=re.compile(r'result|listing|company|card|item', re.I)) or h2.parent.parent
            container_text = container.get_text(separator=' ', strip=True) if container else ''

            # Extract Phone
            phone_m = re.search(
                r'(?:Telefon|Tel|Gsm)?\s*:?\s*(0[2-5]\d{2}\s*\d{3}\s*\d{2}\s*\d{2}|0850\s*\d{3}\s*\d{2}\s*\d{2})',
                container_text
            )
            raw_phone = phone_m.group(1).replace(' ', '') if phone_m else None
            phone_data = PhoneService.normalize_to_e164(raw_phone) if raw_phone else None

            # Extract Address
            addr_m = re.search(r'(?:Adres|Konum)?\s*:?\s*([^•\|\n\r\t]+(?:Mah|Cad|Sok|Bulv|Yolu|Apt|Kat|No|Daire|İş Mrk|Plaza)[^•\|\n\r\t]+)', container_text, re.IGNORECASE)
            address = addr_m.group(1).strip() if addr_m else None
            if not address:
                addr_div = container.find('div', class_=re.compile(r'address|location|street', re.I)) if container else None
                if addr_div:
                    address = addr_div.get_text(separator=' ', strip=True)

            # Extract Website
            web_tag = container.find('a', href=re.compile(r'http', re.I)) if container else None
            raw_website = None
            if web_tag:
                href = web_tag.get('href')
                if href and 'bulurum.com' not in href and 'javascript' not in href:
                    raw_website = self._clean_website(href)

            leads.append({
                "name": clean_name,
                "phone": raw_phone,
                "phone_e164": phone_data["e164"] if phone_data else None,
                "is_mobile": phone_data.get("is_mobile", False) if phone_data else False,
                "is_whatsapp_eligible": phone_data.get("is_whatsapp_eligible", False) if phone_data else False,
                "address": address or f"{district}, {city}",
                "city": city,
                "district": district,
                "website": raw_website,
                "source": "TURKISH_DIRECTORY",
                "display_name": f"{clean_name}, {address or district}"
            })

        return leads

    def _parse_map_info(self, html_content: str, district: str, city: str) -> List[Dict[str, Any]]:
        """Fallback parser for mapInfo JS JSON object embedded in pages."""
        leads: List[Dict[str, Any]] = []
        try:
            results = []
            match_obj = re.search(r'var\s+mapInfo\s*=\s*(\{.*?\});', html_content, re.DOTALL)
            if match_obj:
                data = json.loads(match_obj.group(1))
                results = data.get('results', [])
            else:
                match_arr = re.search(r'mapInfo\.results\s*=\s*(\[.*?\]);', html_content, re.DOTALL)
                if match_arr:
                    results = json.loads(match_arr.group(1))

            if not results:
                return leads

            for item in results:
                name = item.get('Title') or item.get('CompanyName') or item.get('Name')
                if not name:
                    continue
                clean_name = self._clean_business_name(name)
                phone = item.get('Phone') or item.get('Telephone') or item.get('Gsm')
                phone_data = PhoneService.normalize_to_e164(phone) if phone else None

                point = item.get('Point', {}) if isinstance(item.get('Point'), dict) else {}
                lat = item.get('Latitude') or point.get('DecLatitude')
                lon = item.get('Longitude') or point.get('DecLongitude')

                leads.append({
                    "name": clean_name,
                    "phone": phone,
                    "phone_e164": phone_data["e164"] if phone_data else None,
                    "is_mobile": phone_data.get("is_mobile", False) if phone_data else False,
                    "is_whatsapp_eligible": phone_data.get("is_whatsapp_eligible", False) if phone_data else False,
                    "address": item.get('Address') or f"{district}, {city}",
                    "city": city,
                    "district": district,
                    "latitude": float(lat) if lat is not None else None,
                    "longitude": float(lon) if lon is not None else None,
                    "website": item.get('CompanyWebsite') or item.get('Website'),
                    "source": "TURKISH_DIRECTORY"
                })
        except Exception as e:
            logger.debug(f"mapInfo parse error: {e}")
        return leads
