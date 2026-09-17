"""
High-Recall Google Maps Playwright Discovery Scraper with Real-Time Place Streaming.
Directly queries Google Maps places feed for target city, district, and business category.
Interacts with each place card to extract exact full street/neighborhood address,
direct landline (02xx) & mobile GSM phone numbers, official website, rating, reviews, and place coordinates.
Streams each discovered place in real-time with satellite-tuner style progress updates.

Robustness invariants:
- Feed scrolling is ADAPTIVE: after each scroll the scraper polls until new cards render
  (bounded by SCROLLER_SETTLE_TIMEOUT_MS) instead of assuming a fixed delay.
- Stagnation detection is TIME-BASED: discovery only stops when no new card has been
  inspected for SCRAPER_STAGNATION_TIMEOUT_SECONDS — lazy-loaded feeds no longer cut short.
- Single-place detection is guarded: it requires the absence of the results feed AFTER an
  extra settle wait AND presence of concrete place-detail markers, preventing the results
  list header from being misread as a single place.
- Detail-pane attribution is validated: extracted pane title must match the clicked card,
  otherwise pane-derived fields are discarded instead of poisoning the wrong business.
- Anti-bot interstitials (captcha / unusual traffic) raise GoogleMapsBlockedError —
  failures are reported loudly, never silently as zero results.
"""
from __future__ import annotations

import gc
import re
import hashlib
import logging
import time
from typing import List, Dict, Any, Optional, Set, Callable, TYPE_CHECKING
from urllib.parse import quote, unquote, urlparse

if TYPE_CHECKING:  # Imported lazily at browser launch (cold-start cost)
    from playwright.async_api import Browser, Page, Locator
from bs4 import BeautifulSoup

from backend.app.core.config import settings
from backend.app.services.phone_service import PhoneService
from backend.app.data.turkey_locations import normalize_turkish

logger = logging.getLogger(__name__)

# Selectors that only exist on a genuine single-place details view (not on list pages).
_SINGLE_PLACE_MARKERS = 'button[data-item-id="address"], a[data-item-id="authority"], button[jsaction*="category"]'

# End-of-results markers rendered by Google Maps at the bottom of the feed.
_END_OF_RESULTS_SELECTOR = (
    'span:has-text("Tüm sonuçlara ulaştınız"), '
    'span:has-text("Sonuçların sonuna geldiniz"), '
    'span:has-text("reached the end"), '
    'div.HlvSq'
)

# Anti-bot / captcha interstitial indicators.
_BLOCK_URL_FRAGMENTS = ("/sorry/", "google.com/sorry")
_BLOCK_SELECTORS = "iframe[src*='recaptcha'], #captcha, form#captcha-form, div#sorry"
_BLOCK_TEXTS = ("unusual traffic", "olağandışı trafik")

# Extra wait before committing to the single-place branch when the feed looks empty (ms).
_SINGLE_PLACE_SETTLE_MS = 2500
# Poll interval while waiting for lazily-rendered feed cards (ms).
_FEED_GROWTH_POLL_MS = 300

# Extracts structured attributes from the currently open place details pane.
# paneTitle enables caller-side validation that the pane belongs to the clicked card.
_DETAILS_EXTRACT_JS = r"""() => {
    const res = {
        paneTitle: null,
        address: null,
        phone: null,
        website: null,
        rating: null,
        reviewsCount: 0,
        category: null,
        is_sponsored: false
    };

    const titleEl = document.querySelector('h1.DUwDvf, div.fontHeadlineLarge');
    if (titleEl) res.paneTitle = titleEl.innerText.trim();

    // Check sponsored badge
    if (document.querySelector('div.kpi10b, span.kpi10b, [aria-label*="Sponsorlu"], [aria-label*="Sponsored"]')) {
        res.is_sponsored = true;
    }

    // 1. Full Address
    const addrBtn = document.querySelector('button[data-item-id="address"], [data-tooltip*="Adres"], [data-item-id*="address"]');
    if (addrBtn) {
        res.address = addrBtn.getAttribute('aria-label') || addrBtn.innerText.trim();
    }

    // 2. Direct Phone
    const phoneBtn = document.querySelector('button[data-item-id*="phone"], a[href*="tel:"]');
    if (phoneBtn) {
        let p = phoneBtn.getAttribute('aria-label') || phoneBtn.innerText.trim() || phoneBtn.href;
        p = p.replace(/^tel:/i, '').replace(/^(?:Telefon|Phone|Tel|Cep)\s*:\s*/i, '').trim();
        res.phone = p;
    }

    // 3. Official Website
    const webBtn = document.querySelector('a[data-item-id="authority"], a[aria-label*="Web sitesi"], a[data-tooltip*="Web sitesi"]');
    if (webBtn) {
        res.website = webBtn.href;
    }

    // 4. Rating & Reviews
    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"], span.MW4etd');
    if (ratingEl) {
        const rText = ratingEl.innerText.replace(',', '.').trim();
        res.rating = parseFloat(rText) || null;
    }
    const revEl = document.querySelector('div.F7nice span[aria-label*="yorum"], span.UY7F9, span[aria-label*="reviews"]');
    if (revEl) {
        const revClean = revEl.innerText.replace(/[^0-9]/g, '');
        if (revClean) res.reviewsCount = parseInt(revClean, 10);
    }

    // 5. Category
    const catBtn = document.querySelector('button[jsaction*="category"]');
    if (catBtn) res.category = catBtn.innerText.trim();

    // 6. Deep Scan all Io6YTe / rogA2c text rows if phone/address still missing
    const rows = Array.from(document.querySelectorAll('div.Io6YTe, div.rogA2c, span.LrzXr')).map(r => r.innerText.trim());
    for (const row of rows) {
        if (!res.phone) {
            const pMatch = row.match(/(?:0[2-5]\\d{2}[\\s\\.\\-\\(\\)]*\\d{3}[\\s\\.\\-\\(\\)]*\\d{2}[\\s\\.\\-\\(\\)]*\\d{2}|\\+90[\\s\\.\\-\\(\\)]*[2-5]\\d{2}[\\s\\.\\-\\(\\)]*\\d{3}|0850[\\s\\.\\-\\(\\)]*\\d{3}[\\s\\.\\-\\(\\)]*\\d{2}[\\s\\.\\-\\(\\)]*\\d{2})/);
            if (pMatch) {
                res.phone = pMatch[0];
            }
        }
        if (!res.address) {
            if (row.includes('Mah') || row.includes('Cd') || row.includes('Sok') || row.includes('No:') || row.includes('/')) {
                res.address = row;
            }
        }
    }

    return res;
}"""

class GoogleMapsCardParser:
    """
    Advanced & Stable Python Parser for Google Maps Place Cards.
    Parses and normalizes raw DOM elements using Python's phonenumbers library,
    regex tokenization, and strict Turkish category & address rules:
    - Name normalization & deduplication
    - Canonical Maps URL (a.hfpxzc[href])
    - Precise Rating & Reviews Count parsing
    - Clean Official Website URL unwrapping
    - Robust Phone Extraction: scans card spans, phone buttons and attributes for 02xx, 05xx, 0850, and +90
    - Category: cleanly isolated from .W4Efsd metadata lines (excluding ratings, status words, addresses)
    - Address: street/neighborhood tokens or fallback to district/city
    - Coordinates: extracted from URL
    """

    PHONE_REGEX = re.compile(
        r'(?:0[2-5]\d{2}[\s.\-()\u0020]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|'
        r'\(0[2-5]\d{2}\)[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|'
        r'\+90[\s.\-()]*[2-5]\d{2}[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|'
        r'05\d{2}[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2}|'
        r'0850[\s.\-()]*\d{3}[\s.\-()]*\d{2}[\s.\-()]*\d{2})'
    )

    CATEGORY_KEYWORDS = (
        'klini', 'hastane', 'doktor', 'merkez', 'poliklinik',
        'sağlık', 'diş', 'hekim', 'şirket', 'danışmanlık',
        'güzellik', 'avukat', 'restoran', 'kafe', 'otel',
        'mühendis', 'hizmet', 'ofis', 'ajans', 'eczane',
        'optik', 'kuaför', 'berber', 'servis', 'kurs',
        'stüdyo', 'laboratuvar', 'sigorta', 'lojistik'
    )

    STATUS_WORDS = ('açık', 'kapalı', 'kapanmak üzere', '24 saat açık', 'open', 'closed', 'kapanır')
    ADDRESS_MARKERS = ('mah', 'cad', 'cd', 'sok', 'sk', 'no:', 'bulvar', 'kat:', 'sitesi', 'blok', 'apt')

    @classmethod
    def parse_item(
        cls,
        raw_item: Dict[str, Any],
        keyword: str,
        city: str,
        district: str
    ) -> Optional[Dict[str, Any]]:
        href = (raw_item.get("href") or "").strip()
        raw_name = (raw_item.get("name") or "").strip()
        if not href or not raw_name or '/maps/place/' not in href:
            return None

        safe_name = raw_name.split('\n')[0].strip()[:300]

        # 1. Rating & Reviews
        rating = None
        rating_text = raw_item.get("ratingText")
        if rating_text:
            try:
                rating = float(rating_text.replace(',', '.').strip())
            except (ValueError, TypeError):
                pass

        reviews_count = 0
        rev_text = raw_item.get("revText")
        if rev_text:
            digits = re.sub(r'[^0-9]', '', rev_text)
            if digits:
                try:
                    reviews_count = int(digits)
                except ValueError:
                    pass

        # 2. Official Website
        clean_web = clean_extracted_website(raw_item.get("webHref"))

        # 3. Direct Phone Extraction using Python regex & PhoneService (phonenumbers)
        phone_match = None
        phone_attr = raw_item.get("phoneAttr")
        if phone_attr:
            p_clean = phone_attr.replace('tel:', '').strip()
            m = cls.PHONE_REGEX.search(p_clean)
            if m:
                phone_match = m.group(0).strip()

        text_lines = raw_item.get("textLines") or []
        combined_text = " ".join(text_lines)
        if not phone_match:
            m = cls.PHONE_REGEX.search(combined_text)
            if m:
                phone_match = m.group(0).strip()

        phone_data = PhoneService.normalize_to_e164(phone_match) if phone_match else None
        raw_phone = phone_data["national_number"] if phone_data else (phone_match or "")

        # 4. Clean Category and Address Extraction
        category = None
        extracted_address = None

        for line in text_lines:
            parts = [p.replace('\r', ' ').replace('\n', ' ').strip() for p in line.split('\u00b7') if p.strip()]
            for part in parts:
                p_lower = normalize_turkish(part).lower()
                has_digit = bool(re.search(r'\d', part))

                if re.search(r'\d[,\.]\d', part):
                    continue
                if any(s in p_lower for s in cls.STATUS_WORDS):
                    continue

                if not category and 2 <= len(part) <= 35 and not has_digit and '(' not in part and ')' not in part and '|' not in part:
                    word_count = len(part.split())
                    if word_count <= 4:
                        if any(k in p_lower for k in cls.CATEGORY_KEYWORDS) or word_count <= 2:
                            category = part

                if not extracted_address and any(m in p_lower for m in cls.ADDRESS_MARKERS):
                    extracted_address = part

        safe_category = (category or keyword or "İşletme").split('\n')[0].strip()[:50]
        full_address = clean_extracted_address(extracted_address) if extracted_address else f"{district}, {city}"
        lat, lon = extract_coords_from_url(href)

        return {
            "name": safe_name,
            "category": safe_category,
            "phone": raw_phone[:50] if raw_phone else None,
            "phone_e164": phone_data["e164"] if phone_data else None,
            "is_mobile": phone_data.get("is_mobile", False) if phone_data else False,
            "is_whatsapp_eligible": phone_data.get("is_whatsapp_eligible", False) if phone_data else False,
            "website": clean_web[:500] if clean_web else None,
            "address": full_address[:500],
            "city": city[:100],
            "district": district[:100],
            "latitude": lat,
            "longitude": lon,
            "rating": rating,
            "reviews_count": reviews_count,
            "google_maps_url": href[:1000],
            "place_id": f"gmaps_{hashlib.sha256(href.encode()).hexdigest()[:16]}",
            "source": "GOOGLE_MAPS",
            "is_verified": bool(phone_data or clean_web or rating),
            "display_name": f"{safe_name}, {full_address}"[:500]
        }


def clean_extracted_website(raw_url: Optional[str]) -> Optional[str]:
    """Cleans and validates business website URLs extracted from Google Maps."""
    if not raw_url:
        return None
    url = raw_url.strip()
    if not url or url.startswith("javascript:") or url.startswith("mailto:"):
        return None

    # Unwrap Google redirect URLs (/url?q=...)
    if "/url?q=" in url:
        match = re.search(r'/url\?q=([^&]+)', url)
        if match:
            url = unquote(match.group(1))

    # Reject social, messaging and directory domains as company official website.
    # Messaging links (businesses often paste api.whatsapp.com/wa.me as their
    # "website") must surface as "no website", never as a site card link.
    skip_domains = [
        "google.com", "google.com.tr", "maps.google.com", "goo.gl",
        "facebook.com", "instagram.com", "twitter.com", "x.com",
        "youtube.com", "linkedin.com", "pinterest.com", "tiktok.com",
        "bulurum.com", "doktortakvimi.com", "eniyihekim.com", "sahibinden.com",
        "armut.com", "bionluk.com", "yellowpages.com.tr", "sarisayfalar.com"
    ]
    # Short messaging domains: exact-or-subdomain match only, so about.me and
    # similar real sites are NOT caught by substring ("t.me" in "about.me").
    skip_exact_domains = [
        "whatsapp.com", "api.whatsapp.com", "chat.whatsapp.com",
        "wa.me", "t.me", "m.me", "messenger.com",
    ]

    try:
        if not url.startswith("http://") and not url.startswith("https://"):
            url = f"https://{url}"
        parsed = urlparse(url)
        netloc = parsed.netloc.lower()
        if any(d in netloc for d in skip_domains):
            return None
        if netloc in skip_exact_domains or any(
            netloc.endswith("." + d) for d in skip_exact_domains
        ):
            return None
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
    except Exception:
        return None


def clean_extracted_address(raw_addr: Optional[str]) -> Optional[str]:
    """Cleans Google Maps address text, removing icons, newlines, and preserving full address text."""
    if not raw_addr:
        return None
    # Remove unicode icon glyphs (e.g. \ue0c8)
    cleaned = re.sub(r'[\ue000-\uf8ff]', '', raw_addr)
    # Remove 'Adres:' prefix from aria-label
    cleaned = re.sub(r'^\s*Adres:\s*', '', cleaned, flags=re.IGNORECASE).strip()
    # Remove opening status fragments
    cleaned = re.sub(r'(?:,\s*)?(?:Açık|Kapalı|Kapanmak üzere).*$', '', cleaned, flags=re.IGNORECASE).strip()
    # Split by newline and combine all address lines without dropping apartment/building/postal code
    lines = [l.strip().rstrip(',') for l in cleaned.split('\n') if l.strip() and not l.strip().startswith('Adres:')]
    if not lines:
        return None
    # If multiple lines exist, join them cleanly with comma
    full_joined = ", ".join(lines)
    # Clean redundant spaces or double commas
    full_joined = re.sub(r',\s*,', ', ', full_joined)
    return full_joined.strip()


def strip_leading_business_name(name: Optional[str], address: Optional[str]) -> Optional[str]:
    """Removes a business-name prefix from a Google Maps address string.

    The pure-HTTP JSON feed returns pd[18] as "Business Name, street, district..."
    (verified 11/11 on live samples). Cards must show only the street part, and
    downstream dedup (address-key) must compare streets — not names.
    Matching is whitespace-collapsed and case-insensitive; anything that does
    not match is returned byte-identical (fail-safe no-op).
    """
    if not address:
        return address
    if not name or not name.strip():
        return address
    collapsed_addr = re.sub(r'\s+', ' ', address).strip()
    collapsed_name = re.sub(r'\s+', ' ', name).strip()
    if not collapsed_name:
        return address
    if collapsed_addr.casefold().startswith(collapsed_name.casefold()):
        remainder = collapsed_addr[len(collapsed_name):].lstrip(' ,;:-–—').strip()
        # Address that is ONLY the name carries no street evidence — keep it
        # rather than returning an empty string.
        return remainder or address
    return address


def extract_coords_from_url(maps_url: Optional[str]) -> tuple[Optional[float], Optional[float]]:
    """Extracts latitude and longitude coordinates from Google Maps URL (@lat,lon,zoom)."""
    if not maps_url:
        return None, None
    match = re.search(r'@([0-9\.\-]+),([0-9\.\-]+)', maps_url)
    if match:
        try:
            return float(match.group(1)), float(match.group(2))
        except ValueError:
            pass
    return None, None


def pane_belongs_to_card(pane_title: Optional[str], card_name: str) -> bool:
    """
    Validates that the open details pane actually belongs to the clicked card.
    Comparison is diacritics-insensitive with bidirectional containment and word token matching.
    """
    if not pane_title:
        return True
    norm_pane = normalize_turkish(pane_title).lower()
    norm_card = normalize_turkish(card_name).lower()
    if not norm_pane or not norm_card:
        return True
    if norm_pane in norm_card or norm_card in norm_pane:
        return True
    # Word token intersection for titles with punctuation or slight variations
    pane_tokens = set(re.findall(r'\w+', norm_pane))
    card_tokens = set(re.findall(r'\w+', norm_card))
    common = pane_tokens.intersection(card_tokens)
    return len(common) >= 2 or (len(pane_tokens) == 1 and bool(common))


class GoogleMapsBlockedError(RuntimeError):
    """Raised when Google serves an anti-bot interstitial instead of search results."""


class GoogleMapsPlaywrightScraper:
    """
    Production-Grade Google Maps Discovery Scraper:
    - Scrolls results feed to discover all matching places.
    - Clicks into each listing to extract full exact address (Mahalle, Cadde, No, Posta Kodu, İlçe/İl).
    - Extracts verified landline phones (02xx), mobile GSMs (05xx), websites, ratings, and reviews.
    - Dispatches real-time callbacks as each place is inspected.
    """

    def __init__(self):
        self._browser: Optional[Browser] = None

    # ------------------------------------------------------------------
    # Session-level helpers
    # ------------------------------------------------------------------

    async def _open_results_session(self, page: Page, maps_url: str) -> None:
        """Navigates to the search URL, dismisses consent, and verifies Google served real results.
        Retries up to 3 times with exponential backoff to handle transient network timeouts
        on production environments.
        """
        max_attempts = 3
        last_exc: Optional[Exception] = None
        for attempt in range(1, max_attempts + 1):
            try:
                await page.goto(maps_url, wait_until="domcontentloaded", timeout=settings.SCRAPER_PAGE_TIMEOUT_MS)
                await page.wait_for_timeout(1800)
                await self._dismiss_consent(page)
                await page.wait_for_timeout(2500)
                await self._ensure_not_blocked(page)
                return  # Success
            except GoogleMapsBlockedError:
                raise  # Never retry anti-bot blocks
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    f"[GMAPS_PLAYWRIGHT] _open_results_session attempt {attempt}/{max_attempts} failed: {exc}"
                )
                if attempt < max_attempts:
                    await page.wait_for_timeout(5000 * attempt)  # 5s, 10s backoff
        raise RuntimeError(
            f"[GMAPS_PLAYWRIGHT] All {max_attempts} page-open attempts failed. Last error: {last_exc}"
        )

    async def _dismiss_consent(self, page: Page) -> None:
        """Dismisses the Google cookie-consent dialog when present across any region."""
        consent_selectors = [
            'button[aria-label*="Tümünü kabul et"]',
            'button[aria-label*="Accept all"]',
            'button[aria-label*="Alle akzeptieren"]',
            'form[action*="consent"] button',
            'button:has-text("Tümünü kabul et")',
            'button:has-text("Kabul et")',
            'button:has-text("Accept all")',
            'button:has-text("I agree")',
            'button:has-text("Ich stimme zu")',
            'button:has-text("Tout accepter")',
        ]
        for sel in consent_selectors:
            try:
                btn = page.locator(sel)
                if await btn.count() > 0:
                    await btn.first.click()
                    await page.wait_for_timeout(800)
                    break
            except Exception:
                pass

    async def _ensure_not_blocked(self, page: Page) -> None:
        """Raises GoogleMapsBlockedError when an anti-bot interstitial is detected."""
        current_url = page.url.lower()
        if any(fragment in current_url for fragment in _BLOCK_URL_FRAGMENTS):
            raise GoogleMapsBlockedError(f"Google anti-bot sayfasına yönlendirildik: {page.url}")
        try:
            if await page.locator(_BLOCK_SELECTORS).count() > 0:
                raise GoogleMapsBlockedError("Google captcha doğrulaması sunuldu.")
            body_text = (await page.locator("body").inner_text(timeout=1500)).lower()
            if any(text in body_text for text in _BLOCK_TEXTS):
                raise GoogleMapsBlockedError("Google 'olağandışı trafik' uyarısı gösterildi.")
        except GoogleMapsBlockedError:
            raise
        except Exception:
            pass  # Detection probes must never break a healthy session.

    async def _count_feed_cards(self, page: Page) -> int:
        try:
            return await page.locator('a.hfpxzc').count()
        except Exception:
            return 0

    async def _reached_end_of_results(self, page: Page) -> bool:
        try:
            return await page.locator(_END_OF_RESULTS_SELECTOR).count() > 0
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Scroll helpers (adaptive)
    # ------------------------------------------------------------------

    async def _scroll_feed_once(self, page: Page) -> None:
        """Performs one feed-scroll action: focus last card, wheel over the feed, PageDown."""
        try:
            last_card = page.locator('a.hfpxzc').last
            if await last_card.count() > 0:
                await last_card.scroll_into_view_if_needed(timeout=1000)

            feed_el = page.locator('div[role="feed"]').first
            if await feed_el.is_visible():
                await feed_el.hover()
                await page.mouse.wheel(0, 5000)
                await page.keyboard.press("PageDown")
        except Exception:
            await page.evaluate("""() => {
                const feedEl = document.querySelector('div[role="feed"]');
                if (feedEl) feedEl.scrollTop += 5000;
            }""")

    async def _scroll_and_wait_for_growth(self, page: Page, previous_count: int) -> int:
        """
        Scrolls the feed once, then adaptively polls until new cards render, the
        end-of-results marker appears, or the settle timeout elapses.
        Returns the observed card count after settling.
        """
        await self._scroll_feed_once(page)

        deadline = time.monotonic() + (settings.SCROLLER_SETTLE_TIMEOUT_MS / 1000.0)
        current_count = await self._count_feed_cards(page)
        while time.monotonic() < deadline:
            if current_count > previous_count:
                break
            if await self._reached_end_of_results(page):
                break
            await page.wait_for_timeout(_FEED_GROWTH_POLL_MS)
            current_count = await self._count_feed_cards(page)
        return current_count

    def _resolve_scroll_budget(self, max_results: int) -> int:
        """Unlimited/high-target runs get the full configured budget; smaller targets scale down."""
        if max_results == 0 or max_results > 50:
            return settings.SCRAPER_MAX_SCROLL_ITERATIONS
        return max(5, (max_results // 5) + 2)

    # ------------------------------------------------------------------
    # Card inspection
    # ------------------------------------------------------------------

    async def _inspect_card(self, page: Page, card: Locator, card_name: str) -> Dict[str, Any]:
        """Clicks a card and extracts validated attributes from the opened details pane.

        Waits for the details-pane heading to actually switch to the clicked card
        (the pane is shared across clicks and updates asynchronously — without this
        wait every extraction reads the PREVIOUS business).
        """
        try:
            await card.scroll_into_view_if_needed(timeout=1000)
            await card.click(timeout=1500)
            await page.wait_for_timeout(400)
            await self._wait_for_pane_title(page, card_name, timeout_ms=1200)
        except Exception as click_err:
            logger.debug(f"[GMAPS_PLAYWRIGHT] Card click fallback: {click_err}")

        details = await page.evaluate(_DETAILS_EXTRACT_JS)
        return details

    @staticmethod
    async def _wait_for_pane_title(page: Page, card_name: str, timeout_ms: int = 2500) -> None:
        """Resolves once the open pane heading matches the clicked card's name."""
        expected = normalize_turkish(card_name)
        if not expected:
            return

        async def poll() -> bool:
            try:
                title = await page.evaluate(
                    "() => { const el = document.querySelector('h1.DUwDvf, div.fontHeadlineLarge');"
                    " return el ? el.innerText.trim() : null }"
                )
                return bool(title) and pane_belongs_to_card(title, card_name)
            except Exception:
                return False

        deadline = time.monotonic() + timeout_ms / 1000.0
        while time.monotonic() < deadline:
            if await poll():
                return
            await page.wait_for_timeout(120)

    @staticmethod
    def _strip_untrusted_fields(details: Dict[str, Any]) -> None:
        """Removes pane-derived fields that cannot be trusted due to a pane/card mismatch."""
        for key in ("address", "phone", "website", "rating", "category", "reviewsCount", "is_sponsored"):
            details[key] = None if key != "reviewsCount" else 0

    async def _collect_card_details(self, page: Page, card: Locator, card_name: str) -> Dict[str, Any]:
        details = await self._inspect_card(page, card, card_name)
        if not pane_belongs_to_card(details.get("paneTitle"), card_name):
            # The pane may have been mid-transition — one bounded retry before giving up
            # on this card's detail fields.
            details = await self._inspect_card(page, card, card_name)
        if not pane_belongs_to_card(details.get("paneTitle"), card_name):
            logger.warning(
                f"[GMAPS_PLAYWRIGHT] Pane/card mismatch: pane='{details.get('paneTitle')}' card='{card_name}'. "
                "Pane-derived fields discarded to avoid mis-attribution."
            )
            self._strip_untrusted_fields(details)
        details.pop("paneTitle", None)
        return details

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def scrape_district_places(
        self,
        keyword: str,
        city: str,
        district: str,
        max_results: int = 100,
        on_place_inspected: Optional[Callable[[Dict[str, Any], int, int], Any]] = None,
        on_progress_status: Optional[Callable[[str, int], Any]] = None
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        seen_names: Set[str] = set()
        seen_hrefs: Set[str] = set()

        query = f"{city} {district} {keyword}"
        maps_url = f"https://www.google.com/maps/search/{quote(query)}"
        logger.info(f"[GMAPS_PLAYWRIGHT] Searching: '{query}' -> {maps_url}")

        if on_progress_status:
            await on_progress_status(f"🌐 Google Maps oturumu başlatılıyor: {city} > {district}...", 10)

        # Lazy import: playwright costs ~1s+ at startup and is only needed
        # on the fallback engine path (default is pure HTTP).
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--no-first-run",
                    "--no-zygote",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--disable-sync",
                    "--disable-translate",
                    "--hide-scrollbars",
                    "--metrics-recording-only",
                    "--mute-audio",
                    "--safebrowsing-disable-auto-update",
                    "--memory-pressure-off",
                    "--js-flags=--max-old-space-size=128",
                    "--renderer-process-limit=1",
                ]
            )
            context = await browser.new_context(
                locale="tr-TR",
                user_agent=settings.SCRAPER_USER_AGENT,
                viewport={"width": 1280, "height": 800}
            )
            page = await context.new_page()
            await page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")

            # Route optimization: aggressively block heavy media, fonts, images, stylesheets and trackers
            # to strictly stay within memory limits
            _BLOCKED_RESOURCE_TYPES = {"image", "media", "font", "stylesheet"}
            _BLOCKED_URL_FRAGMENTS = [
                "google-analytics", "googletagmanager", "doubleclick",
                "fonts.gstatic.com", "accounts.google.com", "recaptcha",
                "jnn-pa.googleapis.com",
            ]

            async def _filter_routes(route):
                req = route.request
                if req.resource_type in _BLOCKED_RESOURCE_TYPES:
                    await route.abort()
                elif any(b in req.url for b in _BLOCKED_URL_FRAGMENTS):
                    await route.abort()
                else:
                    await route.continue_()

            await page.route("**/*", _filter_routes)

            try:
                await self._open_results_session(page, maps_url)

                # Guarded single-place branch: requires the feed to remain absent after an
                # extra settle wait AND concrete place-detail markers to be present.
                if await self._count_feed_cards(page) == 0:
                    await page.wait_for_timeout(_SINGLE_PLACE_SETTLE_MS)
                    if await self._count_feed_cards(page) == 0 and await page.locator(_SINGLE_PLACE_MARKERS).count() > 0:
                        single_result = await self._scrape_single_place(page, keyword, city, district)
                        results.append(single_result)
                        if on_place_inspected:
                            await on_place_inspected(single_result, 1, 1)
                        await browser.close()
                        return results

                await self._run_feed_discovery_loop(
                    page=page,
                    keyword=keyword,
                    city=city,
                    district=district,
                    max_results=max_results,
                    results=results,
                    seen_names=seen_names,
                    seen_hrefs=seen_hrefs,
                    on_place_inspected=on_place_inspected,
                    on_progress_status=on_progress_status,
                )

            except GoogleMapsBlockedError:
                raise
            except Exception as e:
                logger.error(f"[GMAPS_PLAYWRIGHT] Error searching '{query}': {e}", exc_info=True)
                # Transparency: surface the partial-failure instead of silently returning.
                if on_progress_status:
                    try:
                        await on_progress_status(
                            f"⚠️ Oturum beklenmedik şekilde sonlandı ({type(e).__name__}); "
                            f"{len(results)} işletme ile dönüldü.",
                            15
                        )
                    except Exception:
                        pass
            finally:
                await browser.close()

        logger.info(f"[GMAPS_PLAYWRIGHT] District '{district}' finished. Extracted {len(results)} places with full details.")
        return results

    # ------------------------------------------------------------------
    # Feed discovery loop
    # ------------------------------------------------------------------

    async def _run_feed_discovery_loop(
        self,
        page: Page,
        keyword: str,
        city: str,
        district: str,
        max_results: int,
        results: List[Dict[str, Any]],
        seen_names: Set[str],
        seen_hrefs: Set[str],
        on_place_inspected: Optional[Callable[[Dict[str, Any], int, int], Any]],
        on_progress_status: Optional[Callable[[str, int], Any]],
    ) -> None:
        max_scroll_attempts = self._resolve_scroll_budget(max_results)
        progress_denominator = max_results if max_results > 0 else settings.SCRAPER_UNLIMITED_DISTRICT_TARGET
        scroll_attempts = 0
        stagnant_count = 0

        if on_progress_status:
            await on_progress_status(f"📡 {city} > {district} işletme akışı taranıyor...", 15)

        while scroll_attempts < max_scroll_attempts:
            # 1. Fast incremental extraction of newly rendered DOM cards (marked with dataset.scoutScraped)
            try:
                raw_items: List[Dict[str, Any]] = await page.evaluate("""() => {
                    const cards = document.querySelectorAll('div.Nv2PK');
                    const newItems = [];
                    for (let i = 0; i < cards.length; i++) {
                        const card = cards[i];
                        if (card.dataset.scoutScraped) continue;
                        card.dataset.scoutScraped = "true";

                        const nameEl = card.querySelector('.qBF1Pd, [role="heading"]');
                        const linkEl = card.querySelector('a.hfpxzc');
                        const ratingEl = card.querySelector('.MW4etd');
                        const revEl = card.querySelector('.UY7F9');
                        const webEl = card.querySelector('a[data-value="Web sitesi"], a.lcr4fd, a[aria-label*="Web"]');
                        const textLines = Array.from(card.querySelectorAll('.W4Efsd, .fontBodyMedium')).map(el => el.innerText.trim());
                        const phoneEl = card.querySelector('button[data-item-id*="phone"], a[href^="tel:"]');

                        newItems.push({
                            name: nameEl ? nameEl.innerText.trim() : (linkEl ? linkEl.getAttribute('aria-label') || '' : ''),
                            href: linkEl ? linkEl.href : '',
                            ratingText: ratingEl ? ratingEl.innerText.trim() : null,
                            revText: revEl ? revEl.innerText.trim() : null,
                            webHref: webEl ? webEl.href : null,
                            phoneAttr: phoneEl ? (phoneEl.getAttribute('aria-label') || phoneEl.innerText || phoneEl.href || '') : null,
                            textLines: textLines
                        });
                    }
                    return newItems;
                }""")
            except Exception as eval_err:
                logger.warning(f"[GMAPS_PLAYWRIGHT] Feed evaluation warning: {eval_err}")
                raw_items = []

            new_cards_this_iteration = 0

            for item in raw_items:
                lead_dict = GoogleMapsCardParser.parse_item(
                    item,
                    keyword=keyword,
                    city=city,
                    district=district,
                )
                if not lead_dict:
                    continue

                href = lead_dict.get("google_maps_url")
                raw_name = lead_dict.get("name")
                if not href or not raw_name:
                    continue
                if href in seen_hrefs or raw_name in seen_names:
                    continue

                seen_hrefs.add(href)
                seen_names.add(raw_name)
                new_cards_this_iteration += 1
                results.append(lead_dict)

                logger.info(
                    f"[GMAPS_PLAYWRIGHT] Extracted #{len(results)}: '{raw_name}' "
                    f"({lead_dict['phone_e164'] or 'No phone'})"
                )

                if on_place_inspected:
                    await on_place_inspected(lead_dict, len(results), progress_denominator)

                if max_results > 0 and len(results) >= max_results:
                    break

            if max_results > 0 and len(results) >= max_results:
                break

            if await self._reached_end_of_results(page):
                logger.info(f"[GMAPS_PLAYWRIGHT] Reached end-of-results marker for {city} > {district}.")
                break

            if new_cards_this_iteration == 0:
                stagnant_count += 1
                if stagnant_count >= 6:
                    logger.info(f"[GMAPS_PLAYWRIGHT] Discovery settled with {len(results)} places.")
                    break
            else:
                stagnant_count = 0

            # 2. Smooth feed scroll with synthetic scroll event dispatch
            try:
                await page.evaluate("""() => {
                    const feed = document.querySelector('div[role="feed"], .m6QErb[aria-label]');
                    if (feed) {
                        feed.scrollTop += 6000;
                        feed.dispatchEvent(new Event('scroll', { bubbles: true }));
                    }
                }""")
                await page.keyboard.press("PageDown")
            except Exception as scroll_err:
                logger.debug(f"[GMAPS_PLAYWRIGHT] Scroll action fallback: {scroll_err}")

            # 3. Adaptive wait for DOM cards growth (up to 2.5s)
            previous_count = len(results)
            deadline = time.monotonic() + 2.5
            while time.monotonic() < deadline:
                try:
                    current_count = await page.locator('div.Nv2PK').count()
                    if current_count > previous_count or await self._reached_end_of_results(page):
                        break
                except Exception:
                    pass
                await page.wait_for_timeout(300)

            if scroll_attempts % 3 == 0:
                gc.collect()

            scroll_attempts += 1

    # ------------------------------------------------------------------
    # Single-place branch
    # ------------------------------------------------------------------

    async def _scrape_single_place(
        self,
        page: Page,
        keyword: str,
        city: str,
        district: str,
    ) -> Dict[str, Any]:
        """Extracts the direct place view shown for exact-match brand queries."""
        raw_name = (await page.locator('h1.DUwDvf, div.fontHeadlineLarge').first.inner_text()).strip()
        details = await self._extract_single_place_details(page)

        full_address = clean_extracted_address(details.get("address")) or f"{district}, {city}"
        raw_phone = details.get("phone")
        phone_data = PhoneService.normalize_to_e164(raw_phone) if raw_phone else None
        clean_web = clean_extracted_website(details.get("website"))
        lat, lon = extract_coords_from_url(page.url)

        return {
            "name": raw_name,
            "category": details.get("category") or keyword,
            "phone": raw_phone,
            "phone_e164": phone_data["e164"] if phone_data else None,
            "is_mobile": phone_data.get("is_mobile", False) if phone_data else False,
            "is_whatsapp_eligible": phone_data.get("is_whatsapp_eligible", False) if phone_data else False,
            "website": clean_web,
            "address": full_address,
            "city": city,
            "district": district,
            "latitude": lat,
            "longitude": lon,
            "rating": details.get("rating"),
            "reviews_count": details.get("reviewsCount", 0),
            "google_maps_url": page.url,
            "place_id": f"gmaps_{hashlib.sha256(page.url.encode()).hexdigest()[:16]}",
            "source": "GOOGLE_MAPS",
            "is_verified": True if (phone_data or clean_web or details.get("rating")) else False,
            "display_name": f"{raw_name}, {full_address}"
        }

    async def _extract_single_place_details(self, page: Page) -> Dict[str, Any]:
        details = await page.evaluate("""() => {
            const res = { address: null, phone: null, website: null, rating: null, reviewsCount: 0, category: null };
            const addrBtn = document.querySelector('button[data-item-id="address"], [data-tooltip*="Adres"]');
            if (addrBtn) res.address = addrBtn.getAttribute('aria-label') || addrBtn.innerText.trim();

            const phoneBtn = document.querySelector('button[data-item-id*="phone"], a[href*="tel:"]');
            if (phoneBtn) res.phone = phoneBtn.getAttribute('aria-label') || phoneBtn.innerText.trim() || phoneBtn.href;

            const webBtn = document.querySelector('a[data-item-id="authority"]');
            if (webBtn) res.website = webBtn.href;

            const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"], span.MW4etd');
            if (ratingEl) res.rating = parseFloat(ratingEl.innerText.replace(',', '.').trim()) || null;

            const revEl = document.querySelector('div.F7nice span[aria-label*="yorum"], span.UY7F9');
            if (revEl) {
                const revClean = revEl.innerText.replace(/[^0-9]/g, '');
                if (revClean) res.reviewsCount = parseInt(revClean, 10);
            }

            const catBtn = document.querySelector('button[jsaction*="category"]');
            if (catBtn) res.category = catBtn.innerText.trim();

            const rows = Array.from(document.querySelectorAll('div.Io6YTe, div.rogA2c')).map(r => r.innerText.trim());
            for (const row of rows) {
                if (!res.phone) {
                    const pMatch = row.match(/(?:0[2-5]\\d{2}[\\s\\.\\-\\(\\)]*\\d{3}[\\s\\.\\-\\(\\)]*\\d{2}[\\s\\.\\-\\(\\)]*\\d{2}|\\+90[\\s\\.\\-\\(\\)]*[2-5]\\d{2}[\\s\\.\\-\\(\\)]*\\d{3}|0850[\\s\\.\\-\\(\\)]*\\d{3}[\\s\\.\\-\\(\\)]*\\d{2}[\\s\\.\\-\\(\\)]*\\d{2})/);
                    if (pMatch) res.phone = pMatch[0];
                }
                if (!res.address) {
                    if (row.includes('Mah') || row.includes('Cd') || row.includes('Sok') || row.includes('No:')) {
                        res.address = row;
                    }
                }
            }
            return res;
        }""")
        return details

    # ------------------------------------------------------------------
    # Multi-district convenience wrapper
    # ------------------------------------------------------------------

    async def scrape_multi_district(
        self,
        keyword: str,
        city: str,
        districts: List[str],
        max_results_per_district: int = 100,
        progress_callback: Optional[Any] = None
    ) -> List[Dict[str, Any]]:
        all_leads: List[Dict[str, Any]] = []
        seen_phones: Set[str] = set()
        seen_names: Set[str] = set()

        for idx, district in enumerate(districts):
            if progress_callback:
                await progress_callback(
                    status="RUNNING",
                    message=f"Google Maps taranıyor: {city} > {district} ({idx + 1}/{len(districts)})...",
                    current_district=district,
                    total_found=len(all_leads)
                )

            district_leads = await self.scrape_district_places(
                keyword=keyword,
                city=city,
                district=district,
                max_results=max_results_per_district
            )

            for lead in district_leads:
                phone_key = lead.get("phone_e164")
                name_key = normalize_turkish(lead.get("name", ""))

                if phone_key and phone_key in seen_phones:
                    continue
                if name_key and name_key in seen_names:
                    continue

                if phone_key:
                    seen_phones.add(phone_key)
                if name_key:
                    seen_names.add(name_key)

                all_leads.append(lead)

        return all_leads
