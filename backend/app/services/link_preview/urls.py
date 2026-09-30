"""Mesaj govdesinden URL cikarma, normalizasyon ve tur siniflandirmasi.

Neden ayri modul: bu kurallar (a) sunucuda onbellek anahtarini uretir,
(b) testlerde tek basina dogrulanir ve (c) arayuzdeki cikarma kuraliyla AYNI
olmasi gerekir. Tek bir yerde yasamazsa iki kopya kacinilmaz olarak sapar.

Normalizasyonun siniri — neden sorgu dizesine DOKUNULMAZ
--------------------------------------------------------
Yaygin bir "temizlik" utm_*/fbclid parametrelerini silmektir. Burada
YAPILMAZ: imzali URL'ler (S3 presigned, imzali CDN baglantilari) sorgu
parametresinin TAMAMINI imzaya dahil eder ve tek bir parametreyi silmek
baglantiyi 404'e cevirir. Kazanc (birkac onbellek isabeti) kayiptan (kirik
link) kucuktur. Bu yuzden yalnizca SUNUCUYA GITMEYEN ve anlam degistirmeyen
parcalar normalize edilir: sema, ana makine, varsayilan port ve fragment.
"""

import hashlib
import re
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

# http(s):// ile baslayan veya `www.` ile baslayan adresler. Sema verilmemis
# ciplak alan adlari KABUL EDILMEZ: "dosya.pdf" ya da "ornek.com" gibi ifadeler
# duz metin olabilir ve yanlis pozitif onizleme uretirdi.
_URL_RE = re.compile(
    r"""(?xi)
    \b
    (?:
        https?://[^\s<>"']+
      | www\.[^\s<>"']+
    )
    """
)

# Sondaki noktalama cumleye aittir, URL'e degil: "bak https://a.com." gibi.
_TRAILING_JUNK = ".,;:!?\"'"

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# Sema benzeri onek (`mailto:`, `javascript:`, `data:`). `example.com:8080/x`
# ile karistirilmamalidir: orada iki nokta ustunden sonra PORT gelir.
_SCHEME_PREFIX_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.\-]*):(.*)$", re.S)
_PORT_AFTER_COLON_RE = re.compile(r"^\d+(/|$|\?)")

_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
_YOUTUBE_SHORT_HOSTS = {"youtu.be", "www.youtu.be"}

_INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}

_DOCUMENT_SUFFIXES = (
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".csv",
    ".txt",
    ".zip",
)


def _trim_trailing_junk(candidate: str) -> str:
    """Cumle noktalamasini kirpar; DENGELI parantezleri KORUR.

    Wikipedia baglantilari mesru olarak `)` icerir
    (`.../wiki/Foo_(bar)`). Bu yuzden kapanis parantezi yalnizca URL'de
    karsiligi olmayan bir acilis yoksa kirpilir.
    """
    while candidate and candidate[-1] in _TRAILING_JUNK:
        candidate = candidate[:-1]
    for opener, closer in (("(", ")"), ("[", "]"), ("{", "}")):
        while candidate.endswith(closer) and candidate.count(closer) > candidate.count(
            opener
        ):
            candidate = candidate[:-1]
    return candidate


def extract_first_url(text: Optional[str]) -> Optional[str]:
    """Metindeki ILK adresi dondurur, yoksa None.

    Yalnizca ilki alinir: WhatsApp Web de bir mesajda tek onizleme gosterir ve
    birden fazla link icin birden fazla dis istek yapmak, kullanicinin
    istemedigi maliyeti dogurur.
    """
    if not text:
        return None
    match = _URL_RE.search(text)
    if not match:
        return None
    candidate = _trim_trailing_junk(match.group(0))
    if candidate.lower().startswith("www."):
        candidate = f"https://{candidate}"
    return candidate or None


def normalize_url(url: str) -> Optional[str]:
    """Onbellek anahtari icin kararli bir bicim uretir. Gecersizse None."""
    if not url:
        return None
    raw = url.strip()
    if not raw:
        return None
    if "://" not in raw:
        # Sema benzeri bir onek varsa ve ardindan PORT gelmiyorsa bu bir
        # semadir (`mailto:`, `javascript:`, `data:`) ve DESTEKLENMEZ.
        # Naif bir `f"https://{raw}"` oneki bunlari gecerli URL gibi
        # ayristirirdi: `mailto:x@y.com` -> ana makine `y.com`, kullanici
        # bilgisi `mailto:x` — yani desteklenmeyen bir sema sessizce gecerli
        # sayilirdi.
        prefix = _SCHEME_PREFIX_RE.match(raw)
        if prefix and not _PORT_AFTER_COLON_RE.match(prefix.group(2)):
            return None
        raw = f"https://{raw}"
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None

    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        return None

    # Varsayilan port yazilmaz: `https://a.com:443/x` ile `https://a.com/x`
    # ayni kaynaktir ve iki ayri onbellek satiri acmamalidir.
    port = parts.port
    default_port = 443 if scheme == "https" else 80
    netloc = host if port in (None, default_port) else f"{host}:{port}"

    path = parts.path or "/"
    # Yalnizca KOK yolun sondaki egik cizgisi kirpilir; `/a/b/` ile `/a/b`
    # farkli kaynaklar olabilir, onlara dokunulmaz.
    if path == "/":
        path = ""

    # Fragment sunucuya hic gitmez, dolayisiyla onbellek anahtarina da girmez.
    return urlunsplit((scheme, netloc, path, parts.query, ""))


def url_hash(normalized_url: str) -> str:
    """Normalize edilmis URL'in sabit boyutlu kimligi."""
    return hashlib.sha256(normalized_url.encode("utf-8")).hexdigest()


def youtube_video_id(normalized_url: str) -> Optional[str]:
    """YouTube baglantisindan video kimligini cikarir, yoksa None.

    YouTube icin sayfa KAZINMAZ: kimlik URL'den deterministik olarak cikar ve
    thumbnail ile gomme adresi bundan uretilir. Kazima daha kirilgan ve daha
    yavastir; ayrica YouTube'un HTML'i degistiginde sessizce bozulur.
    """
    try:
        parts = urlsplit(normalized_url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    path = parts.path or ""

    if host in _YOUTUBE_SHORT_HOSTS:
        candidate = path.lstrip("/").split("/")[0]
        return candidate if _VIDEO_ID_RE.match(candidate) else None

    if host not in _YOUTUBE_HOSTS:
        return None

    if path == "/watch":
        for chunk in (parts.query or "").split("&"):
            key, _, value = chunk.partition("=")
            if key == "v" and _VIDEO_ID_RE.match(value):
                return value
        return None

    for prefix in ("/shorts/", "/embed/", "/v/"):
        if path.startswith(prefix):
            candidate = path[len(prefix):].split("/")[0]
            return candidate if _VIDEO_ID_RE.match(candidate) else None
    return None


def instagram_shortcode(normalized_url: str) -> Optional[str]:
    """Instagram gonderi/reel kodunu cikarir, yoksa None."""
    try:
        parts = urlsplit(normalized_url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if host not in _INSTAGRAM_HOSTS:
        return None
    segments = [s for s in (parts.path or "").split("/") if s]
    if len(segments) >= 2 and segments[0] in ("p", "reel", "reels", "tv"):
        return segments[1]
    return None


def classify_url(normalized_url: str) -> str:
    """Onizleme turu: LINK | VIDEO | IMAGE | DOCUMENT."""
    try:
        parts = urlsplit(normalized_url)
    except ValueError:
        return "LINK"
    path = (parts.path or "").lower()

    if youtube_video_id(normalized_url) or instagram_shortcode(normalized_url):
        return "VIDEO"
    if path.endswith(_DOCUMENT_SUFFIXES):
        return "DOCUMENT"
    if path.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg")):
        return "IMAGE"
    return "LINK"


def youtube_thumbnail(video_id: str) -> str:
    """Video icin kapak gorseli adresi (deterministik, kazima yok)."""
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def youtube_embed(video_id: str) -> str:
    """Tikla-yukle oynatici adresi.

    `youtube-nocookie.com` secildi: gomme yapildiginda cerez yazmaz, bu da
    kullanicinin izlenmesini azaltir. Yalnizca bu saglayici icin izin verilir —
    keyfi URL'ler asla iframe'e konmaz.
    """
    return f"https://www.youtube-nocookie.com/embed/{video_id}"
