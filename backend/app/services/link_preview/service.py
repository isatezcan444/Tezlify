"""Onizleme orkestrasyonu: onbellek once, dis istek ASLA istek yolunda degil.

Tasarimin tamami tek bir kisit etrafinda kuruldu: `GET /conversations/{id}/messages`
ucu `@profiled("chat_open")` ile olculur ve Phase 10.9 tam olarak "mesaj basina
fazladan bir sorgu"yu kaldirmak icin yapildi. O yola bir HTTP cagrisi koymak
sohbet acilisini saniyelere cikarirdi. Bu yuzden:

* **Isabet**: sayfa basina TEK toplu sorgu (mesaj basina degil).
* **Isabetsizlik**: is ASENKRON baslatilir ve bu turda mesaj onizlemesiz doner;
  onizleme bir sonraki yuklemede veya WS olayindan sonra gorunur.
* **Basarisizlik da onbelleklenir**: olu bir link her sohbet acilisinda yeniden
  denenmez.

Goruntu adresi istemciye HAM verilmez
-------------------------------------
Istemciye uzak gorsel adresi yerine `/api/v1/whatsapp/link-preview/image?u=<hash>`
verilir. Iki sebep: (1) hotlink kullanicinin IP'sini ve tarayici parmak izini
uzak sunucuya sizdirir; (2) proxy HASH kabul eder, URL DEGIL — boylece proxy
keyfi URL cekmeye ikna edilemez (acik proxy / SSRF). Cekilecek adres yalnizca
bu tabloda, yani dogrulamadan gecmis kayitlarda bulunur.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.link_preview import LinkPreview
from backend.app.services.link_preview.unfurl import UnfurlError, unfurl
from backend.app.services.link_preview.ssrf import UnsafeUrlError
from backend.app.services.link_preview.urls import (
    extract_first_url,
    normalize_url,
    url_hash,
)

logger = logging.getLogger(__name__)

# Pozitif kayit: OpenGraph etiketleri nadiren degisir; bir hafta makul.
TTL_OK = timedelta(days=7)
# Negatif kayit: site bir gun duzelirse onizleme de duzelmelidir, ama olu bir
# link her sohbet acilisinda yeniden denenmemelidir.
TTL_FAILED = timedelta(hours=1)

# Ayni sayfada kac isabetsiz URL icin arka plan isi baslatilir. Sinir olmadan,
# link dolu bir sohbet tek seferde onlarca gorev acardi.
MAX_SCHEDULED_PER_PAGE = 8

# Ayni URL icin ayni anda birden fazla gorev baslatilmaz: ayni linki 20 mesajda
# paylasan bir kiracida 20 ozdes dis istek olurdu.
_inflight: set[str] = set()


def _proxy_image_url(row: LinkPreview) -> Optional[str]:
    if not row.image_url:
        return None
    return f"/api/v1/whatsapp/link-preview/image?u={row.url_hash}"


def serialize_preview(row: LinkPreview) -> Dict[str, Any]:
    """Bir onbellek satirinin istemciye giden sekli."""
    return {
        "url": row.url,
        "kind": row.kind or "LINK",
        "title": row.title,
        "description": row.description,
        "site_name": row.site_name,
        "image_url": _proxy_image_url(row),
        "embed_url": row.embed_url,
    }


def _is_fresh(row: LinkPreview, now: datetime) -> bool:
    if row.expires_at is None:
        return True
    return row.expires_at > now


def _extract_hashes(rows: Sequence[Any]) -> Dict[int, str]:
    """Her mesaj icin (mesaj_id -> normalize edilmis URL hash'i) haritasi.

    Yalnizca metin govdesi taranir. Medya basligi (`media_caption`) da link
    icerebilir ama o durumda mesaj zaten bir medya karti cizer; iki karti ust
    uste koymak WhatsApp Web'de de olmayan bir gorunum olurdu.
    """
    out: Dict[int, str] = {}
    for row in rows:
        url = extract_first_url(getattr(row, "body", None))
        if not url:
            continue
        normalized = normalize_url(url)
        if not normalized:
            continue
        out[int(row.id)] = url_hash(normalized)
    return out


def _hashes_to_urls(rows: Sequence[Any]) -> Dict[str, str]:
    """(hash -> normalize edilmis URL) — arka plan isi icin."""
    out: Dict[str, str] = {}
    for row in rows:
        url = extract_first_url(getattr(row, "body", None))
        if not url:
            continue
        normalized = normalize_url(url)
        if normalized:
            out.setdefault(url_hash(normalized), normalized)
    return out


async def previews_by_message(
    db: AsyncSession, rows: Sequence[Any]
) -> Dict[int, Dict[str, Any]]:
    """Bir sayfa mesaj icin onizlemeleri TEK sorguda cozer.

    Dis istek YAPMAZ. Onbellegi bos olan URL'ler icin arka plan isi baslatir ve
    o mesajlar bu turda onizlemesiz kalir.
    """
    if not rows:
        return {}
    hash_by_message = _extract_hashes(rows)
    if not hash_by_message:
        return {}

    wanted = set(hash_by_message.values())
    try:
        found = (
            await db.execute(
                select(LinkPreview).where(LinkPreview.url_hash.in_(wanted))
            )
        ).scalars().all()
    except Exception as exc:  # noqa: BLE001 - onizleme, sayfayi DUSURMEMELI
        logger.warning("Link onizlemeleri okunamadi: %s", exc)
        return {}

    now = datetime.utcnow()
    fresh: Dict[str, LinkPreview] = {}
    for row in found:
        if _is_fresh(row, now):
            fresh[row.url_hash] = row

    out: Dict[int, Dict[str, Any]] = {}
    for message_id, digest in hash_by_message.items():
        row = fresh.get(digest)
        if row is not None and row.status == "OK":
            out[message_id] = serialize_preview(row)

    missing = wanted - set(fresh.keys())
    if missing:
        urls_by_hash = _hashes_to_urls(rows)
        for digest in list(missing)[:MAX_SCHEDULED_PER_PAGE]:
            url = urls_by_hash.get(digest)
            if url:
                schedule_unfurl(digest, url)

    return out


async def ensure_preview(db: AsyncSession, normalized_url: str) -> Optional[LinkPreview]:
    """Onbellekten doner; yoksa/bayatlamissa ceker ve yazar.

    Bu fonksiyon DIS ISTEK yapar ve bu yuzden yalnizca ARKA PLAN gorevinden
    ya da acik bir "yenile" cagrisindan cagrilmalidir — sohbet acilisindan
    degil.
    """
    digest = url_hash(normalized_url)
    existing = await db.scalar(
        select(LinkPreview).where(LinkPreview.url_hash == digest)
    )
    now = datetime.utcnow()
    if existing is not None and _is_fresh(existing, now):
        return existing

    try:
        parsed = await unfurl(normalized_url)
        values = {
            "status": "OK",
            "kind": parsed.get("kind") or "LINK",
            "title": parsed.get("title"),
            "description": parsed.get("description"),
            "site_name": parsed.get("site_name"),
            "image_url": parsed.get("image_url"),
            "embed_url": parsed.get("embed_url"),
            "error": None,
            "expires_at": now + TTL_OK,
        }
    except (UnfurlError, UnsafeUrlError) as exc:
        # Guvenlik reddi ve ag hatasi AYNI sekilde ele alinir: ikisi de bir
        # sonuctur ve negatif onbelleklenir. `error` sutunu teshis icindir.
        values = {
            "status": "FAILED",
            "kind": "LINK",
            "title": None,
            "description": None,
            "site_name": None,
            "image_url": None,
            "embed_url": None,
            "error": str(exc)[:255],
            "expires_at": now + TTL_FAILED,
        }

    values["fetched_at"] = now

    if existing is None:
        row = LinkPreview(url_hash=digest, url=normalized_url, **values)
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError:
            # Iki gorev ayni URL'i ayni anda cozdu: kazanan satiri sec, yoksa
            # bu onizleme kaybolurdu (bkz. _ingest_message yarisi, `f9e92fa`).
            await db.rollback()
            existing = await db.scalar(
                select(LinkPreview).where(LinkPreview.url_hash == digest)
            )
            if existing is None:
                return None
            for key, value in values.items():
                setattr(existing, key, value)
            await db.commit()
            return existing
        await db.commit()
        return row

    for key, value in values.items():
        setattr(existing, key, value)
    await db.commit()
    return existing


async def _run_unfurl(digest: str, normalized_url: str) -> None:
    """Arka plan gorevi: kendi oturumunu acar.

    Istek oturumu bu noktada KAPANMISTIR; onu kullanmak sessiz bir hata
    uretirdi. Bu yuzden gorev kendi oturumunu acar.
    """
    try:
        async with AsyncSessionLocal() as session:
            await ensure_preview(session, normalized_url)
    except Exception as exc:  # noqa: BLE001 - arka plan isi asla yukseltmez
        logger.warning("Arka plan onizleme cozumu basarisiz (%s): %s", normalized_url, exc)
    finally:
        _inflight.discard(digest)


def schedule_unfurl(digest: str, normalized_url: str) -> None:
    """Onizleme cozumumunu arka planda baslatir (ayni URL icin tek gorev)."""
    if digest in _inflight:
        return
    _inflight.add(digest)
    try:
        asyncio.create_task(_run_unfurl(digest, normalized_url))
    except RuntimeError:
        # Calisan bir olay dongusu yok (orn. senkron test baglami): isi
        # sessizce dusurmek yerine isareti geri al, boylece bir sonraki cagri
        # yeniden deneyebilir.
        _inflight.discard(digest)


async def lookup_preview_for_proxy(
    db: AsyncSession, digest: str
) -> Optional[LinkPreview]:
    """Gorsel proxy'si icin kayit. Hash yoksa None — URL kabul EDILMEZ."""
    return await db.scalar(
        select(LinkPreview).where(LinkPreview.url_hash == digest)
    )


async def get_preview_image_bytes(db: AsyncSession, digest: str) -> tuple[bytes, str]:
    """Onbellekteki bir kaydin kapak gorselini indirir.

    Istemci URL DEGIL hash gonderir. Bu, proxy'yi acik bir aktarima donusmekten
    kurtarir: cekilecek adres yalnizca bu tabloda, yani dogrulamadan gecmis
    kayitlarda bulunur.
    """
    from backend.app.services.link_preview.unfurl import fetch_image_bytes

    row = await lookup_preview_for_proxy(db, digest)
    if row is None or not row.image_url:
        raise LookupError("Bu onizleme icin gorsel yok.")
    return await fetch_image_bytes(row.image_url)


async def refresh_preview(db: AsyncSession, url: str) -> Optional[LinkPreview]:
    """Acik "yenile" yolu: TTL'i yok sayip yeniden ceker."""
    normalized = normalize_url(url)
    if not normalized:
        return None
    digest = url_hash(normalized)
    existing = await db.scalar(
        select(LinkPreview).where(LinkPreview.url_hash == digest)
    )
    if existing is not None:
        existing.expires_at = datetime.utcnow() - timedelta(seconds=1)
        await db.commit()
    return await ensure_preview(db, normalized)
