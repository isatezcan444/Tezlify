"""Onizleme cozumu: dis istek + OpenGraph ayristirma.

Iki yol vardir ve ayrim ONEMLIDIR:

1. **Deterministik saglayicilar (YouTube, Instagram).** Video kimligi URL'den
   cikarilir; sayfa KAZINMAZ. Bu hem daha hizli hem daha dayaniklidir —
   saglayicinin HTML'i degistiginde kirilan bir kaziyici yerine, degismeyen
   bir URL kuralina dayanir.
2. **Genel baglantilar.** Sayfa sunucu tarafinda cekilir, `<head>` icindeki
   OpenGraph/Twitter etiketleri okunur.

Instagram icin durust sinir: Instagram anonim isteklere giris duvari doner ve
`og:*` etiketleri cogu zaman gelmez. Bu durumda KIRIK bir onizleme uretmek
yerine markali bir yedek kart uretilir (bkz. `_instagram_fallback`).
"""

import logging
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

from backend.app.services.link_preview.ssrf import (
    MAX_BYTES,
    MAX_REDIRECTS,
    REQUEST_TIMEOUT_S,
    _USER_AGENT,
    UnsafeUrlError,
    validate_url,
)
from backend.app.services.link_preview.urls import (
    classify_url,
    instagram_shortcode,
    normalize_url,
    youtube_embed,
    youtube_thumbnail,
    youtube_video_id,
)

logger = logging.getLogger(__name__)

_REDIRECT_CODES = {301, 302, 303, 307, 308}
_HTML_TYPES = ("text/html", "application/xhtml+xml")

# Google/YouTube, veri merkezi IP'lerine bir ONAM (consent) ARA SAYFASI doner.
# Ara sayfanin `og:title`'i gercek icerigin degil ara sayfanin basligidir.
# Canli olculdu (2026-09-30, uretim):
#   maps.app.goo.gl       -> "Google Haritalar'a devam etmeden once"
#   youtube.com/playlist  -> "YouTube'a devam etmeden once"
# Yanlis bir baslik gostermek, hic kart gostermemekten KOTUDUR: kullanici
# paylasilan icerigin basligi sanir. Bu yuzden ara sayfa bir SONUC degil,
# bir BASARISIZLIK sayilir (negatif onbellek, kart cizilmez).
_CONSENT_HOSTS = ("consent.google.com", "consent.youtube.com")


def _is_consent_interstitial(final_url: str) -> bool:
    """Son adres bir onam ara sayfasi mi?"""
    host = (urlsplit(final_url).hostname or "").lower()
    return host in _CONSENT_HOSTS or host.startswith("consent.")



class UnfurlError(Exception):
    """Onizleme cozulemedi (ag, icerik turu veya guvenlik)."""


async def _fetch_html(url: str) -> Tuple[str, str]:
    """Sayfayi ceker, `(html, son_url)` doner.

    Yonlendirmeler ELLE takip edilir: `httpx`'in otomatik takibi, ilk
    dogrulamadan sonra ozel bir adrese atlayabilir ve kontrolu atlardi. Her
    adim `validate_url` ile yeniden dogrulanir.
    """
    current = url
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Language": "tr,en;q=0.8",
    }

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S, follow_redirects=False) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            validate_url(current)
            try:
                async with client.stream("GET", current, headers=headers) as response:
                    if response.status_code in _REDIRECT_CODES:
                        location = response.headers.get("location")
                        if not location:
                            raise UnfurlError("Yonlendirme adresi yok.")
                        current = urljoin(current, location)
                        continue
                    if response.status_code >= 400:
                        raise UnfurlError(f"HTTP {response.status_code}")
                    content_type = (response.headers.get("content-type") or "").lower()
                    if not any(kind in content_type for kind in _HTML_TYPES):
                        raise UnfurlError(f"HTML degil: {content_type or '(bilinmiyor)'}")
                    # Akis halinde ve SINIRLI okunur: `response.text` butun
                    # govdeyi indirirdi ve bir saldirgan sunucuyu buyuk bir
                    # dosyayla mesgul edebilirdi.
                    chunks = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        chunks.append(chunk)
                        total += len(chunk)
                        if total >= MAX_BYTES:
                            break
                    raw = b"".join(chunks)[:MAX_BYTES]
                    encoding = response.encoding or "utf-8"
                    return raw.decode(encoding, errors="replace"), str(response.url)
            except httpx.HTTPError as exc:
                raise UnfurlError(f"Ag hatasi: {exc}") from exc
    raise UnfurlError("Cok fazla yonlendirme.")


def _meta(soup: BeautifulSoup, *, prop: Optional[str] = None, name: Optional[str] = None) -> Optional[str]:
    if prop:
        tag = soup.find("meta", attrs={"property": prop})
        if tag and tag.get("content"):
            return str(tag["content"]).strip()
    if name:
        tag = soup.find("meta", attrs={"name": name})
        if tag and tag.get("content"):
            return str(tag["content"]).strip()
    return None


def _first(*values: Optional[str]) -> Optional[str]:
    """Ilk DOLU degeri doner (bos dize de 'yok' sayilir)."""
    for value in values:
        if value:
            cleaned = value.strip()
            if cleaned:
                return cleaned
    return None


def parse_html(html: str, final_url: str) -> Dict[str, Any]:
    """`<head>` etiketlerinden onizleme alanlarini cikarir."""
    soup = BeautifulSoup(html, "html.parser")

    title = _first(
        _meta(soup, prop="og:title"),
        _meta(soup, name="twitter:title"),
        soup.title.string if soup.title and soup.title.string else None,
    )
    description = _first(
        _meta(soup, prop="og:description"),
        _meta(soup, name="twitter:description"),
        _meta(soup, name="description"),
    )
    site_name = _first(_meta(soup, prop="og:site_name"))
    image = _first(
        _meta(soup, prop="og:image"),
        _meta(soup, name="twitter:image"),
        _meta(soup, prop="og:image:url"),
    )
    # Gorsel adresi COGUNLUKLA gorecelidir (`/img/x.png`); mutlaklastirilmazsa
    # proxy onu kendi adresimiz sanip 404 uretirdi.
    if image:
        image = urljoin(final_url, image)

    if not site_name:
        site_name = urlsplit(final_url).hostname

    if not any((title, description, image)):
        raise UnfurlError("Sayfada onizleme etiketi yok.")

    return {
        "title": title[:512] if title else None,
        "description": description,
        "site_name": site_name[:255] if site_name else None,
        "image_url": image,
        "embed_url": None,
    }


def _instagram_fallback(shortcode: str, normalized: str) -> Dict[str, Any]:
    """Instagram icin DURUST yedek: kirik onizleme yerine markali kart.

    Instagram anonim isteklere giris duvari dondurur, bu yuzden `og:*`
    etiketleri guvenilir degildir. Bos bir kart gostermek "uygulama bozuk"
    izlenimi verir; kaynagi adiyla soyleyen bir kart ise dogru bilgi verir.
    """
    return {
        "title": None,
        "description": None,
        "site_name": "Instagram",
        "image_url": None,
        "embed_url": None,
    }


async def unfurl(normalized_url: str) -> Dict[str, Any]:
    """Normalize edilmis bir URL icin onizleme alanlarini uretir.

    Donen sozluk `status` anahtari TASIMAZ; onu cagiran (service) belirler.
    Burada ya bir sonuc uretilir ya `UnfurlError` yukseltilir.
    """
    kind = classify_url(normalized_url)

    video_id = youtube_video_id(normalized_url)
    if video_id:
        # Tek bir dis istek bile YOK: kapak ve gomme adresi deterministik.
        return {
            "kind": "VIDEO",
            "title": None,
            "description": None,
            "site_name": "YouTube",
            "image_url": youtube_thumbnail(video_id),
            "embed_url": youtube_embed(video_id),
        }

    shortcode = instagram_shortcode(normalized_url)
    if shortcode:
        try:
            html, final_url = await _fetch_html(normalized_url)
            parsed = parse_html(html, final_url)
            parsed["kind"] = "VIDEO"
            return parsed
        except (UnfurlError, UnsafeUrlError) as exc:
            logger.debug("Instagram onizlemesi cekilemedi (%s): %s", normalized_url, exc)
            fallback = _instagram_fallback(shortcode, normalized_url)
            fallback["kind"] = "VIDEO"
            return fallback

    html, final_url = await _fetch_html(normalized_url)
    if _is_consent_interstitial(final_url):
        # Basligi ara sayfadan okumak yerine acikca basarisiz ol. `error`
        # sutunu teshis icin son ana makineyi saklar.
        raise UnfurlError(
            f"Onam ara sayfasi donduruldu ({urlsplit(final_url).hostname}); "
            "gercek icerik alinamadi."
        )
    parsed = parse_html(html, final_url)
    parsed["kind"] = kind
    return parsed


def normalize_or_raise(url: str) -> str:
    normalized = normalize_url(url)
    if not normalized:
        raise UnfurlError("URL normalize edilemedi.")
    return normalized


# Onizleme kapagi bir THUMBNAIL'dir; 3 MB fazlasiyla yeterlidir ve bir
# saldirganin sunucuyu buyuk bir gorselle mesgul etmesini engeller.
MAX_IMAGE_BYTES = 3 * 1024 * 1024


async def fetch_image_bytes(remote_url: str) -> Tuple[bytes, str]:
    """Uzak gorseli SSRF korumasi altinda indirir. `(bytes, mime)` doner.

    Proxy bu fonksiyonu KULLANICI GIRDISI olmayan bir adresle cagirir: adres,
    daha once dogrulanip `link_previews` tablosuna yazilmis bir kayittan gelir.
    Yine de ayni koruma uygulanir — kayit bir gun baska bir yoldan yazilirsa
    korumanin orada olmadigini fark etmemek en kotu senaryodur.
    """
    headers = {"User-Agent": _USER_AGENT, "Accept": "image/*"}
    current = remote_url

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S, follow_redirects=False) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            validate_url(current)
            try:
                async with client.stream("GET", current, headers=headers) as response:
                    if response.status_code in _REDIRECT_CODES:
                        location = response.headers.get("location")
                        if not location:
                            raise UnfurlError("Yonlendirme adresi yok.")
                        current = urljoin(current, location)
                        continue
                    if response.status_code >= 400:
                        raise UnfurlError(f"HTTP {response.status_code}")
                    content_type = (response.headers.get("content-type") or "").lower()
                    # Yalnizca gorsel: aksi halde proxy keyfi icerik servis eden
                    # bir aktarima donusurdu.
                    if not content_type.startswith("image/"):
                        raise UnfurlError(f"Gorsel degil: {content_type or '(bilinmiyor)'}")
                    chunks = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        chunks.append(chunk)
                        total += len(chunk)
                        if total >= MAX_IMAGE_BYTES:
                            break
                    return b"".join(chunks)[:MAX_IMAGE_BYTES], content_type.split(";")[0]
            except httpx.HTTPError as exc:
                raise UnfurlError(f"Ag hatasi: {exc}") from exc
    raise UnfurlError("Cok fazla yonlendirme.")
