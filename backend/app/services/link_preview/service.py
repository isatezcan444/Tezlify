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
from backend.app.core.datetime_utils import utc_now_naive
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

    now = utc_now_naive()
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
        first_row = rows[0] if rows else None
        row_user_id = str(getattr(first_row, "user_id", None)) if first_row and getattr(first_row, "user_id", None) else None
        row_conv_id = getattr(first_row, "conversation_id", None) if first_row else None
        for digest in list(missing)[:MAX_SCHEDULED_PER_PAGE]:
            url = urls_by_hash.get(digest)
            if url:
                try:
                    schedule_unfurl(digest, url, user_id=row_user_id, conversation_id=row_conv_id)
                except TypeError:
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
    now = utc_now_naive()
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


async def _run_unfurl(
    digest: str,
    normalized_url: str,
    user_id: Optional[str] = None,
    conversation_id: Optional[int] = None,
) -> None:
    """Arka plan gorevi: kendi oturumunu acar.

    Istek oturumu bu noktada KAPANMISTIR; onu kullanmak sessiz bir hata
    uretirdi. Bu yuzden gorev kendi oturumunu acar.
    """
    try:
        async with AsyncSessionLocal() as session:
            preview_row = await ensure_preview(session, normalized_url)
            if preview_row is not None and preview_row.status == "OK":
                try:
                    from backend.app.api.v1.websocket import ws_manager
                    event_payload = {
                        "event": "link_preview_updated",
                        "url_hash": digest,
                        "url": normalized_url,
                        "conversation_id": conversation_id,
                        "preview": serialize_preview(preview_row),
                    }
                    if user_id:
                        event_payload["user_id"] = user_id
                        await ws_manager.broadcast(event_payload, target_user_id=user_id)
                except Exception as ws_err:
                    logger.debug("WS link preview broadcast atlandi: %s", ws_err)
    except Exception as exc:  # noqa: BLE001 - arka plan isi asla yukseltmez
        logger.warning("Arka plan onizleme cozumu basarisiz (%s): %s", normalized_url, exc)
    finally:
        _inflight.discard(digest)


def schedule_unfurl(
    digest: str,
    normalized_url: str,
    user_id: Optional[str] = None,
    conversation_id: Optional[int] = None,
) -> None:
    """Onizleme cozumumunu arka planda baslatir (ayni URL icin tek gorev)."""
    if digest in _inflight:
        return
    _inflight.add(digest)
    try:
        asyncio.create_task(_run_unfurl(digest, normalized_url, user_id=user_id, conversation_id=conversation_id))
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
    if row.image_url.startswith("/api/v1/whatsapp/media/"):
        from backend.app.models.message import Message
        from backend.app.models.conversation import Conversation
        from backend.app.services.whatsapp.repositories.sessions import (
            conversation_gateway_id as _conversation_gateway_id,
        )
        from backend.app.services import whatsapp_gateway as gw

        media_id = row.image_url.split("/")[-1]
        msg_row = await db.scalar(select(Message).where(Message.media_id == media_id))
        if msg_row:
            conv = await db.get(Conversation, msg_row.conversation_id)
            if conv:
                gid = await _conversation_gateway_id(db, msg_row.user_id, conv)
                data = await gw.fetch_media(gid, media_id)
                return data, msg_row.media_mime_type or "image/jpeg"
        raise LookupError("Medyaya ulasilamadi.")
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
        existing.expires_at = utc_now_naive() - timedelta(seconds=1)
        await db.commit()
    return await ensure_preview(db, normalized)


async def preview_for_text_message(
    db: AsyncSession,
    body: Optional[str],
    user_id: Optional[str] = None,
    conversation_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Extracts first URL from message body, returns cached preview or schedules unfurl."""
    if not body:
        return None
    raw_url = extract_first_url(body)
    if not raw_url:
        return None
    norm = normalize_url(raw_url)
    if not norm:
        return None
    digest = url_hash(norm)
    row = await db.scalar(select(LinkPreview).where(LinkPreview.url_hash == digest))
    now = utc_now_naive()
    if row and _is_fresh(row, now) and row.status == "OK":
        return serialize_preview(row)
    try:
        schedule_unfurl(digest, norm, user_id=user_id, conversation_id=conversation_id)
    except TypeError:
        schedule_unfurl(digest, norm)
    return None


async def ingest_native_preview(
    db: AsyncSession,
    native: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Persists a link preview extracted directly by Baileys gateway."""
    from backend.app.services.link_preview.urls import classify_url

    raw_url = native.get("url")
    if not raw_url:
        return None
    norm = normalize_url(raw_url)
    if not norm:
        return None
    digest = url_hash(norm)
    now = utc_now_naive()
    existing = await db.scalar(select(LinkPreview).where(LinkPreview.url_hash == digest))
    thumb_id = native.get("thumbnail_media_id")
    image_url = f"/api/v1/whatsapp/media/{thumb_id}" if thumb_id else None

    if existing is not None:
        if not existing.image_url and image_url:
            existing.image_url = image_url
        if not existing.title and native.get("title"):
            existing.title = native.get("title")
        if not existing.description and native.get("description"):
            existing.description = native.get("description")
        existing.status = "OK"
        existing.expires_at = now + TTL_OK
        return serialize_preview(existing)

    kind = classify_url(norm)
    lp = LinkPreview(
        url_hash=digest,
        url=norm,
        status="OK",
        kind=kind,
        title=native.get("title"),
        description=native.get("description"),
        site_name=None,
        image_url=image_url,
        fetched_at=now,
        expires_at=now + TTL_OK,
    )
    db.add(lp)
    try:
        await db.flush()
    except IntegrityError:
        pass
    return serialize_preview(lp)

