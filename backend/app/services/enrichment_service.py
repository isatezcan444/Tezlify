import re
import html
import logging
import asyncio
from typing import Optional, Dict, Any, List, Set, Tuple
from urllib.parse import urljoin, urlparse
import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from backend.app.models.lead import Lead
from backend.app.core.datetime_utils import utc_now_naive

logger = logging.getLogger(__name__)

# Common false positive email domains and file extensions
IGNORED_EMAIL_DOMAINS = {
    "sentry.io",
    "wixpress.com",
    "example.com",
    "domain.com",
    "email.com",
    "wordpress.org",
    "wordpress.com",
    "cloudflare.com",
    "github.com",
    "google.com",
    "schema.org",
    "w3.org",
    "gravatar.com",
    "placeholder.com",
}

IGNORED_EMAIL_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".bmp", ".tiff", ".woff", ".woff2"
}

EMAIL_REGEX = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+", re.IGNORECASE)

# Social media patterns
SOCIAL_PATTERNS = {
    "instagram": re.compile(
        r"https?://(?:www\.)?instagram\.com/([a-zA-Z0-9_.-]+)/?", re.IGNORECASE
    ),
    "facebook": re.compile(
        r"https?://(?:www\.)?facebook\.com/([a-zA-Z0-9_.-]+)/?", re.IGNORECASE
    ),
    "linkedin": re.compile(
        r"https?://(?:www\.)?linkedin\.com/(?:company|in)/([a-zA-Z0-9_.-]+)/?", re.IGNORECASE
    ),
    "twitter": re.compile(
        r"https?://(?:www\.)?(?:twitter|x)\.com/([a-zA-Z0-9_.-]+)/?", re.IGNORECASE
    ),
    "youtube": re.compile(
        r"https?://(?:www\.)?youtube\.com/(@?[a-zA-Z0-9_.-]+|channel/[a-zA-Z0-9_-]+)/?", re.IGNORECASE
    ),
    "tiktok": re.compile(
        r"https?://(?:www\.)?tiktok\.com/(@?[a-zA-Z0-9_.-]+)/?", re.IGNORECASE
    ),
}

IGNORED_SOCIAL_HANDLES = {
    "sharer", "share", "intent", "dialog", "p", "reel", "stories", "hashtag", "login",
    "privacy", "terms", "help", "support", "explore", "about", "pages", "groups", "tr"
}

CONTACT_PAGE_KEYWORDS = ["iletisim", "contact", "bize-ulasin", "hakkimizda", "about", "ulasim"]


class EnrichmentService:
    """Web sitesi tarama, e-posta, sosyal medya ve meta veri zenginleştirme servisi."""

    @staticmethod
    def normalize_website_url(url: Optional[str]) -> Optional[str]:
        if not url:
            return None
        url = url.strip()
        if not url:
            return None

        # Exclude directory or map profiles passed as websites
        lower = url.lower()
        if any(d in lower for d in ["google.com/maps", "goo.gl/maps", "facebook.com", "instagram.com"]):
            return None

        if not (url.startswith("http://") or url.startswith("https://")):
            url = f"https://{url}"

        # Remove trailing slash or tracking
        try:
            parsed = urlparse(url)
            if not parsed.netloc:
                return None
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
        except Exception:
            return url

    @staticmethod
    def extract_emails(html_text: str) -> List[str]:
        """HTML metninden geçerli kurumsal e-postaları ayıklar."""
        found_emails: Set[str] = set()

        # 1. mailto: linkleri
        mailto_matches = re.findall(r'href=["\']mailto:([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)["\']', html_text, re.IGNORECASE)
        for m in mailto_matches:
            clean = m.strip().lower()
            if EnrichmentService._is_valid_email(clean):
                found_emails.add(clean)

        # 2. Raw regex
        raw_matches = EMAIL_REGEX.findall(html_text)
        for m in raw_matches:
            clean = m.strip().lower()
            if EnrichmentService._is_valid_email(clean):
                found_emails.add(clean)

        # Sort so that info@, iletisim@, contact@, bilgi@, satis@ come first
        def email_priority(e: str) -> int:
            if any(pref in e for pref in ["info@", "iletisim@", "contact@", "bilgi@", "destek@", "satis@", "satist@", "hello@", "merhaba@"]):
                return 0
            return 1

        return sorted(list(found_emails), key=email_priority)

    @staticmethod
    def _is_valid_email(email_str: str) -> bool:
        if not email_str or len(email_str) > 100 or len(email_str) < 5:
            return False
        if any(email_str.endswith(ext) for ext in IGNORED_EMAIL_EXTENSIONS):
            return False
        parts = email_str.split("@")
        if len(parts) != 2:
            return False
        domain = parts[1].lower()
        if domain in IGNORED_EMAIL_DOMAINS:
            return False
        # Discard dummy or image filename matches like "user@2x.png"
        if "." not in domain or len(domain.split(".")[-1]) < 2:
            return False
        return True

    @staticmethod
    def extract_social_links(html_text: str, base_url: str) -> Dict[str, str]:
        """HTML içindeki sosyal medya profil bağlantılarını çıkarır."""
        socials: Dict[str, str] = {}

        # Scan all hrefs
        hrefs = re.findall(r'href=["\'](.*?)["\']', html_text, re.IGNORECASE)
        for href in hrefs:
            full_url = urljoin(base_url, href.strip())
            for network, pattern in SOCIAL_PATTERNS.items():
                if network in socials:
                    continue  # already found one for this network
                match = pattern.match(full_url)
                if match:
                    handle = match.group(1).lower().strip("/")
                    if handle and handle not in IGNORED_SOCIAL_HANDLES and len(handle) > 1:
                        # Clean canonical URL
                        socials[network] = full_url.split("?")[0].rstrip("/")

        return socials

    @staticmethod
    def extract_meta_info(html_text: str) -> Tuple[Optional[str], Optional[str]]:
        """HTML <title> ve meta description bilgilerini çıkarır."""
        title: Optional[str] = None
        desc: Optional[str] = None

        # Title
        title_match = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.IGNORECASE | re.DOTALL)
        if title_match:
            raw_title = title_match.group(1).strip()
            title = html.unescape(re.sub(r"\s+", " ", raw_title))[:250]

        # Description
        desc_match = re.search(
            r'<meta\s+[^>]*(?:name|property)=["\'](?:description|og:description)["\'][^>]*content=(["\'])(.*?)\1',
            html_text,
            re.IGNORECASE | re.DOTALL,
        )
        if not desc_match:
            desc_match = re.search(
                r'<meta\s+[^>]*content=(["\'])(.*?)\1[^>]*(?:name|property)=["\'](?:description|og:description)["\']',
                html_text,
                re.IGNORECASE | re.DOTALL,
            )
        if desc_match:
            raw_desc = desc_match.group(2).strip()
            desc = html.unescape(re.sub(r"\s+", " ", raw_desc))[:1000]

        return title, desc

    @staticmethod
    def find_contact_page_url(html_text: str, base_url: str) -> Optional[str]:
        """İletişim / Hakkımızda sayfasının linkini tespit eder."""
        hrefs = re.findall(r'href=["\'](.*?)["\']', html_text, re.IGNORECASE)
        for href in hrefs:
            clean_href = href.strip()
            lower = clean_href.lower()
            if any(kw in lower for kw in CONTACT_PAGE_KEYWORDS):
                full_url = urljoin(base_url, clean_href)
                # Verify same domain
                if urlparse(full_url).netloc == urlparse(base_url).netloc:
                    return full_url
        return None

    @classmethod
    async def fetch_html(cls, url: str) -> Optional[str]:
        """Emniyetli, zaman aşımlı ve SSL hata toleranslı HTTP HTML çekici."""
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        }
        # First attempt with normal SSL verify
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(8.0, connect=4.0),
                follow_redirects=True,
                verify=False,  # tolerates SME self-signed or expired certificates
                headers=headers,
            ) as client:
                res = await client.get(url)
                if res.status_code == 200:
                    return res.text
        except Exception as e:
            logger.debug("[ENRICHMENT] Fetch error for %s: %s", url, e)
        return None

    @classmethod
    async def crawl_and_extract(cls, website_url: str) -> Dict[str, Any]:
        """Web sitesini ve gerekirse iletişim alt sayfasını tarayıp veri çıkarır."""
        norm_url = cls.normalize_website_url(website_url)
        if not norm_url:
            return {
                "success": False,
                "error": "Geçerli bir web sitesi adresi bulunamadı.",
                "emails": [],
                "social_links": {},
                "meta_title": None,
                "meta_description": None,
            }

        html_text = await cls.fetch_html(norm_url)
        if not html_text:
            return {
                "success": False,
                "error": "Web sitesine erişilemedi veya yanıt vermedi.",
                "emails": [],
                "social_links": {},
                "meta_title": None,
                "meta_description": None,
            }

        emails = cls.extract_emails(html_text)
        socials = cls.extract_social_links(html_text, norm_url)
        meta_title, meta_description = cls.extract_meta_info(html_text)

        # If no email found on homepage, check contact page
        if not emails:
            contact_url = cls.find_contact_page_url(html_text, norm_url)
            if contact_url and contact_url != norm_url:
                contact_html = await cls.fetch_html(contact_url)
                if contact_html:
                    contact_emails = cls.extract_emails(contact_html)
                    if contact_emails:
                        emails = contact_emails
                    contact_socials = cls.extract_social_links(contact_html, norm_url)
                    for k, v in contact_socials.items():
                        if k not in socials:
                            socials[k] = v

        return {
            "success": True,
            "emails": emails,
            "social_links": socials,
            "meta_title": meta_title,
            "meta_description": meta_description,
        }

    @classmethod
    async def enrich_lead(cls, db: AsyncSession, lead: Lead) -> Dict[str, Any]:
        """Tek bir lead'i zenginleştirir ve veritabanına kaydeder."""
        if not lead.website:
            lead.enrichment_status = "NO_WEBSITE"
            lead.enriched_at = utc_now_naive()
            await db.commit()
            return {
                "success": False,
                "lead": lead,
                "error": "İşletmenin web sitesi kayıtlı değil.",
                "found_emails": [],
                "found_socials": {},
                "meta_title": None,
                "meta_description": None,
            }

        extracted = await cls.crawl_and_extract(lead.website)
        now = utc_now_naive()

        if extracted["success"]:
            emails = extracted["emails"]
            socials = extracted["social_links"]

            # Set primary email if not already present or if we found one
            if emails:
                lead.emails = emails
                if not lead.email:
                    lead.email = emails[0]

            if socials:
                lead.social_links = socials

            if extracted["meta_title"]:
                lead.meta_title = extracted["meta_title"]

            if extracted["meta_description"]:
                lead.meta_description = extracted["meta_description"]

            lead.enrichment_status = "ENRICHED"
            lead.enriched_at = now
        else:
            lead.enrichment_status = "FAILED"
            lead.enriched_at = now

        await db.commit()
        await db.refresh(lead)

        return {
            "success": extracted["success"],
            "lead": lead,
            "found_emails": extracted["emails"],
            "found_socials": extracted["social_links"],
            "meta_title": extracted["meta_title"],
            "meta_description": extracted["meta_description"],
            "error": extracted.get("error"),
        }

    @classmethod
    async def bulk_enrich_leads(
        cls,
        db: AsyncSession,
        leads: List[Lead],
        max_concurrency: int = 5,
    ) -> Dict[str, Any]:
        """Birden çok lead'i kontrollü eşzamanlılıkla zenginleştirir."""
        sem = asyncio.Semaphore(max_concurrency)
        enriched_count = 0
        skipped_count = 0
        failed_count = 0
        updated_leads: List[Lead] = []

        async def _enrich_worker(lead_item: Lead):
            nonlocal enriched_count, skipped_count, failed_count
            if not lead_item.website:
                skipped_count += 1
                lead_item.enrichment_status = "NO_WEBSITE"
                lead_item.enriched_at = utc_now_naive()
                return

            async with sem:
                res = await cls.crawl_and_extract(lead_item.website)
                now = utc_now_naive()
                if res["success"]:
                    if res["emails"]:
                        lead_item.emails = res["emails"]
                        if not lead_item.email:
                            lead_item.email = res["emails"][0]
                    if res["social_links"]:
                        lead_item.social_links = res["social_links"]
                    if res["meta_title"]:
                        lead_item.meta_title = res["meta_title"]
                    if res["meta_description"]:
                        lead_item.meta_description = res["meta_description"]
                    lead_item.enrichment_status = "ENRICHED"
                    lead_item.enriched_at = now
                    enriched_count += 1
                else:
                    lead_item.enrichment_status = "FAILED"
                    lead_item.enriched_at = now
                    failed_count += 1

                updated_leads.append(lead_item)

        tasks = [_enrich_worker(l) for l in leads]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
            await db.commit()

        return {
            "total_requested": len(leads),
            "enriched_count": enriched_count,
            "skipped_count": skipped_count,
            "failed_count": failed_count,
            "items": leads,
        }
