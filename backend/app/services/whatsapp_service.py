"""WhatsApp gateway - veri katmani orkestrasyonu.

WhatsApp UI, gateway (transport) + FastAPI DB (tek dogruluk kaynagi)
arasinda koprulenir: ic mesajlar contacts/conversations/messages
tablolarina kalici yazilir; frontend her zaman sayisal DB kimlikleriyle
konusur. Gateway olaylari (/ws/gateway) bu servis araciligiyla persist
edilir ve broadcast icin sayisal kimliklere cevrilir.
"""
import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, FrozenSet, List, Optional, Set, Tuple

from sqlalchemy import select, func, or_, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.auth import get_user_filter
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.lead import Lead
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_gateway as gw

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Yardimcilar
# ---------------------------------------------------------------------------

def jid_to_phone(jid: str) -> Optional[str]:
    """`905321002030@s.whatsapp.net` -> `+905321002030`.

    Faz 6e: `xxx@lid` kimlikleri WhatsApp'ın telefon-gizli LID anahtarıdır ve
    telefon numarası DEĞİLDİR — asla `+rakam` türetilmez (AGENTS.md: sahte
    telefon sentezlenmez). Gateway eşleşmeyi öğrenince telefona çözülmüş JID
    gönderir; öğrenemezse hiç göndermez.
    """
    if not jid:
        return None
    jid_str = str(jid)
    if jid_str.endswith("@lid"):
        return None
    # Faz 8 (RC-4): grup JID'inden (`120363...@g.us`) asla telefon türetilmez
    # — yoksa UI'da `+1203632...` gibi sahte numaralar görünür (AGENTS.md).
    if "@g.us" in jid_str:
        return None
    digits = "".join(ch for ch in jid_str.split("@")[0] if ch.isdigit())
    # Faz 9 (§4/§5, RC-2): dejenere JID'lerden (`0@s.whatsapp.net`) '+0' gibi
    # uydurma telefonlar üretilmez — en az 5 hane ve tümü sıfır olamaz.
    if not digits or len(digits) < 5 or set(digits) == {"0"}:
        return None
    return f"+{digits}"


def is_degenerate_jid(jid: str) -> bool:
    """Faz 9 (§5): WhatsApp sistem/dejenere JID'leri (`0@s.whatsapp.net`,
    `000@...`) gercek bir kisi/sohbet DEGILDIR — contact/conversation
    kaydi uretilmez (kapida '+0' chat'in kaynagi buydu). Gateway ile
    ayni kural: 5+ hane ve tamami sifir degil."""
    if not jid:
        return False
    head = str(jid).split("@")[0]
    digits = "".join(ch for ch in head if ch.isdigit())
    if not digits or digits != head.strip():
        return False
    return len(digits) < 5 or set(digits) == {"0"}


def phone_to_jid(phone_e164: str) -> str:
    """`+905321002030` -> `905321002030@s.whatsapp.net`."""
    digits = "".join(ch for ch in phone_e164 if ch.isdigit())
    return f"{digits}@s.whatsapp.net"


# ---------------------------------------------------------------------------
# Kisi adi onceligi (WhatsApp Web parityi): kullanıcının telefon rehberindeki
# ad (gateway W:Contact app-state → name_source='addressbook') her zaman
# pushName'den (kişinin kendi profil adı, 'push') ve history sync adindan
# ('history') once gelir. Kaynak gateway'den name_source alaniyla gelir.
# ---------------------------------------------------------------------------
_NAME_RANK: Dict[str, int] = {"addressbook": 5, "verified": 4, "group_subject": 4, "history": 3, "push": 2, "phone": 1}


def _is_phone_like(value: Optional[str]) -> bool:
    """Ad bos ya da telefon numarasi gorunumunde mi ('+90...', 'jid:...')."""
    if not value:
        return True
    v = str(value).strip()
    return (v.startswith("+") and v[1:].isdigit()) or v.startswith("jid:")


def _set_contact_name(contact: Contact, name: Optional[str], source: Optional[str]) -> bool:
    """Oncelik-cozumumlu kisi adi guncellemesi; isim degistiyse True doner.

    Kural: mevcut ad telefon gorunumunde/bossa her gercek ad yazar;
    aksi halde yalnizca rutbesi (addressbook > verified > history > push)
    mevcut rutbeyi saglayan ad yazilir. Boylece pushName rehber adini, ya da
    eski bir pushName yeni rehber adini asla ezemez.
    """
    if not name:
        return False
    # Faz 7: ham jid/lid ('6277...@lid', 'jid:...') asla gercek ad olarak
    # yazilmaz — identity cozulumu tamamlanana kadar ad None kalir.
    if _is_raw_jid_name(name):
        return False
    clean = str(name).strip()[:150]
    if not clean:
        return False
    # Telefon gorunumundeki bir ad (ornek '+90532...') gercek bir adin
    # uzerine asla yazilmaz; yalnizca bos kisiye yerlestirilir.
    if _is_phone_like(clean) and not _is_phone_like(contact.display_name):
        return False
    src = str(source) if str(source or "") in _NAME_RANK else "history"
    attrs = dict(contact.custom_attributes or {})
    stored_source = str(attrs.get("name_source") or "")
    if stored_source in _NAME_RANK:
        current_rank = _NAME_RANK[stored_source]
    else:
        # Kaynagi bilinmeyen eski kayitlar: gercek ad gibi varsay (history rutbesi).
        current_rank = _NAME_RANK["history"] if contact.display_name else 0
    phone_like = _is_phone_like(contact.display_name) or contact.display_name == contact.phone_e164
    if phone_like or _NAME_RANK[src] >= current_rank:
        changed = contact.display_name != clean
        contact.display_name = clean
        if attrs.get("name_source") != src:
            attrs["name_source"] = src
            contact.custom_attributes = attrs
        return changed
    return False


def _serialize_message(row: Message) -> Dict[str, Any]:
    # Gelen medya gateway'de durur; frontend kimlik doğrulamalı proxy üzerinden çeker.
    media_url = f"/api/v1/whatsapp/media/{row.media_id}" if row.media_id else None
    return {
        "id": row.id,
        "conversation_id": row.conversation_id,
        "direction": row.direction.value if hasattr(row.direction, "value") else str(row.direction),
        "message_type": row.message_type.value if hasattr(row.message_type, "value") else str(row.message_type),
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "body": row.body,
        "media_id": row.media_id,
        "media_mime_type": row.media_mime_type,
        "media_filename": row.media_filename,
        "media_caption": row.media_caption,
        "media_url": media_url,
        "wa_message_id": row.wa_message_id,
        "client_message_id": row.client_message_id,
        "sender_phone": row.sender_phone,
        "sender_name": row.sender_name,
        "recipient_phone": row.recipient_phone,
        "error_message": row.error_message,
        "created_at": row.external_timestamp.isoformat()
        if row.external_timestamp
        else (row.created_at.isoformat() if row.created_at else None),
    }


def _session_dict(row: WhatsAppSession) -> Dict[str, Any]:
    return {
        "id": row.id,
        "session_name": row.session_name,
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "phone_number": row.phone_number,
        "is_active": row.is_active,
        "is_phone_online": row.is_phone_online,
        "battery_level": row.battery_level,
        "qr_code": row.qr_code,
        "error_message": row.error_message,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _parse_status(value: Optional[str]) -> SessionStatus:
    try:
        return SessionStatus(value or "SCAN_QR")
    except Exception:
        return SessionStatus.SCAN_QR


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _as_naive_utc(value: Optional[datetime]) -> Optional[datetime]:
    """DB kolonlari naive UTC; aware datetime'lari karsilastirilabilir hale getirir."""
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


# ---------------------------------------------------------------------------
# Faz 10 (P2): SON MESAJ OZETI — TEK PAYLASILAN KURAL.
# Initial sync, manuel "Eşitle", realtime ingest ve gonderim yollari AYNI
# fonksiyonlari kullanir; sohbet ozeti hicbir yerde farkli hesaplanmaz.
# Kurallar:
#  - Metin mesajinda govde; medyada tip etiketi (📷/🎥/🎵/📄/Sticker...).
#  - Eski kose-parantezli degerler ([IMAGE] vb.) ayni etiketlere normalize
#    edilir — UI'a asla '[IMAGE]' veya '[object Object]' sizmaz.
#  - Grup sohbetinde gonderen cozulebildiyse on ek: "Ahmet: Toplantı...";
#    cozulemiyorsa ham JID/LID on ek ASLA yazilmaz, yalans govde kalir.
#  - Uygulama zaman-damgali siralamayadir (ekleme sirasi DEGIL): daha yeni
#    mesaj eskisini ezemez; bos ozet mevcut ozeti silmez.
# ---------------------------------------------------------------------------

_TYPE_PREVIEW_LABELS: Dict[str, str] = {
    "IMAGE": "📷 Fotoğraf",
    "VIDEO": "🎥 Video",
    "AUDIO": "🎵 Sesli mesaj",
    "STICKER": "Sticker",
    "DOCUMENT": "📄 Dosya",
    "LOCATION": "📍 Konum",
    "CONTACT": "👤 Kişi kartı",
    "TEMPLATE": "Şablon mesajı",
    "UNKNOWN": "Mesaj",
    "OTHER": "Mesaj",
}

_BRACKET_TYPE_RE = re.compile(r"^\[([A-Za-z_]+)\]$")


def _normalize_preview_text(message_type: Optional[str], body: Optional[str]) -> str:
    """Bir mesajdan (tip + govde) yuzluk preview metnini uretir.

    Bos govde + medya tipi -> tip etiketi; eski '[IMAGE]' tarzi kalici
    degerler de ayni etikete cevrilir. Metin tipi + bos govde -> bos string
    (ozet YAZILMAZ, mevcut korunur).
    """
    t = str(message_type or "TEXT").upper()
    text = (body or "").strip()
    if text:
        m = _BRACKET_TYPE_RE.match(text)
        if m:
            inner = m.group(1).upper()
            # UI'a asla kopeli deger sizmaz: taninmayan tip -> mesajin kendi
            # tip etiketi, o da yoksa genel 'Mesaj'.
            return _TYPE_PREVIEW_LABELS.get(inner, _TYPE_PREVIEW_LABELS.get(t, "Mesaj"))
        if text in ("[object Object]", "[Medya]"):
            return _TYPE_PREVIEW_LABELS.get(t, "Mesaj")
        return text
    if t == "TEXT":
        return ""
    return _TYPE_PREVIEW_LABELS.get(t, "Mesaj")


def build_last_message_summary(
    *,
    message_type: Optional[str],
    body: Optional[str],
    sender_name: Optional[str] = None,
    is_group: bool = False,
    direction: Optional[str] = None,
) -> str:
    """Sohbet listesi satiri icin son-mesaj ozetini uretir (tek kural).

    Grup + gelen mesajda cozulmus gonderen adi one eklenir
    ('Ahmet: Toplantıyı yarına aldık.'). Gonderen adi ham JID/LID veya
    telefon gorunumundeyse ya da sohbet adinin kendisiyle ayniysa on ek
    atlanir (WhatsApp Web paritesi: 'Ahmet:' degilse yalans govde).
    """
    base = _normalize_preview_text(message_type, body)
    if not base:
        return ""
    name = (sender_name or "").strip()
    if (
        is_group
        and str(direction or "INBOUND").upper() == "INBOUND"
        and name
        and name.upper() != "ME"
        and not _is_raw_jid_name(name)
        and not _is_phone_like(name)
    ):
        return f"{name}: {base}"
    return base


def _apply_last_message(conv: Conversation, ts: Optional[datetime], summary: str) -> bool:
    """Sohbetin son mesaj alanlarini ZAMAN DAMGALI kurala gore gunceller.

    - summary bos ise hicbir sey yazilmaz (mevcut ozet silinmez).
    - ts mevcut last_message_at'ten eski/eseit ise guncellenmez — boylece
      gecmis mesajlarin yeniden yazimi (retry/duplicate) en yeni ozeti bozamaz.
    - ts yoksa (realtime) yazilir — canli akista siralama gateway'de dogru.
    Degisiklik olduysa True doner.
    """
    if not summary:
        return False
    ts = _as_naive_utc(ts)
    if ts is not None and conv.last_message_at is not None and ts <= conv.last_message_at:
        return False
    conv.last_message_preview = summary[:500]
    if ts is not None:
        conv.last_message_at = ts
    return True


def _apply_gateway_live(row: WhatsAppSession, data: Dict[str, Any]) -> None:
    status = data.get("status")
    if status:
        row.status = _parse_status(status)
    if data.get("phone"):
        row.phone_number = data["phone"]
    gw_error = data.get("error_message")
    if gw_error is not None:
        row.error_message = str(gw_error)[:1000] or None
    if status in ("CONNECTED", "SCAN_QR"):
        row.error_message = None
    row.updated_at = datetime.utcnow()


# ---------------------------------------------------------------------------
# Yetim gateway oturumu -> yeniden kurma (self-healing)
#
# Kok neden (canli probe ile kanitlandi): Render redeploy'da gateway'in
# bellekteki `sessions` Map'i (ve ephemeral auth dizini) sifirlanir; backend
# DB'sindeki `whatsapp_sessions` satirlari ise BAYAT `gateway_id` UUID'lerini
# saklamaya devam eder. Bu satirla yapilan her gateway cagrisi (QR cekme,
# QR yenileme, pairing kodu) gateway'de "Session not found" -> 500/404 ->
# backend 502 "WhatsApp gateway'e ulasilamadi" uretir. Bu, hem QR hem de
# "Telefon No ile Baglan" akisini kirar.
#
# Cozum: gateway "Session not found" derse DB satiri icin gateway'de yeni bir
# oturum olusturulur, satirin gateway_id/durumu tazelenir ve orijinal cagri
# bir kez tekrar denenir. Fail-closed korunur: baska hicbir hata yutulmaz ve
# asla sahte basari/sahte kod uretilmez (AGENTS.md Truthfulness).
# ---------------------------------------------------------------------------

_GATEWAY_SESSION_MISSING = "session not found"


def _is_gateway_session_missing(exc: Exception) -> bool:
    """Gateway hatasinin 'yetim/bilinmeyen oturum' hatasi olup olmadigini
    anlar. Sadece bu spesifik hata self-heal tetikler; ag/timeout/diger 500'ler
    aynen yukselir (fail-closed)."""
    return _GATEWAY_SESSION_MISSING in str(exc).lower()


async def _recreate_gateway_session(db: AsyncSession, row: WhatsAppSession) -> Dict[str, Any]:
    """Bayat `gateway_id` icin gateway'de yeni oturum kurar ve DB satirini
    taze kimlik + SCAN_QR durumu ile gunceller. Gateway'e ulasilamazsa hata
    aynen yukari firlar (sahte basari yok)."""
    gw_session = await gw.create_session(row.session_name)
    new_id = gw_session.get("id")
    if not new_id:
        raise gw.WhatsAppGatewayError("Gateway yeniden kurulan oturum kimligini dondurmedi.")
    logger.warning(
        "[WhatsApp] Yetim gateway oturumu yeniden kuruldu: DB id=%s gateway_id %s -> %s",
        row.id, row.gateway_id, new_id,
    )
    row.gateway_id = str(new_id)
    row.status = _parse_status(gw_session.get("status"))
    row.qr_code = gw_session.get("qr_code")
    row.error_message = None
    row.is_active = True
    row.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(row)
    return gw_session


async def _gateway_op_or_recreate(
    db: AsyncSession,
    row: WhatsAppSession,
    op: Callable[[str], Awaitable[Dict[str, Any]]],
) -> Dict[str, Any]:
    """`op(gateway_id)` cagrisini calistirir; gateway 'Session not found' derse
    (redeploy sonrasi bellek kaybi) oturumu yeniden kurup cagriyi BIR KEZ tekrar
    dener. Baska hata -> aynen yukselir."""
    try:
        return await op(row.gateway_id)
    except gw.WhatsAppGatewayError as exc:
        if not _is_gateway_session_missing(exc):
            raise
        await _recreate_gateway_session(db, row)
        return await op(row.gateway_id)


# ---------------------------------------------------------------------------
# Session yonetimi
# ---------------------------------------------------------------------------

async def _list_sessions_internal(
    db: AsyncSession, user_id: str
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Oturum listesi + (varsa) gateway erisim hatasi.

    Faz 13: gateway hatasi ARTIK YUTULMAZ — cagirana dondurulur, karar
    cagirana birakilir. `list_sessions` DB durumunu gostermeye devam eder
    (kullanici oturumlarini gormeli), ancak `get_sync_status` bu hatayi
    'unavailable' olarak yuzeye cikarir; "senkron yok" ile karistirilamaz.
    """
    stmt = select(WhatsAppSession).where(get_user_filter(WhatsAppSession.user_id, user_id))
    res = await db.execute(stmt)
    rows = res.scalars().all()
    gw_sync: Dict[str, Any] = {}
    gateway_error: Optional[str] = None
    try:
        gw_sessions = {s["id"]: s for s in await gw.list_sessions()}
        for row in rows:
            live = gw_sessions.get(row.gateway_id)
            if live:
                gw_sync[row.id] = live.get("sync") or {"phase": "idle"}
                if live.get("status") != row.status.value:
                    row.status = _parse_status(live.get("status"))
                    row.is_phone_online = bool(live.get("is_phone_online", row.is_phone_online))
                    row.battery_level = live.get("battery_level", row.battery_level)
                    row.phone_number = live.get("phone_number", row.phone_number)
        await db.commit()
    except Exception as exc:
        gateway_error = str(exc)[:300]
        logger.warning("Gateway canli durum tazelenemedi: %s", exc)
    out: List[Dict[str, Any]] = []
    for r in rows:
        d = _session_dict(r)
        # Faz 7: gercek initial-sync asamasi/ilerlemesi (gateway belleginden,
        # sahte degil). Gateway'e ulasilamazsa `get_sync_status` bunu ayrica
        # 'unavailable' olarak bildirir.
        d["sync"] = gw_sync.get(r.id, {"phase": "idle", "progress": 0})
        out.append(d)
    return out, gateway_error


async def list_sessions(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    sessions, _gateway_error = await _list_sessions_internal(db, user_id)
    return sessions


async def get_sync_status(db: AsyncSession, user_id: str) -> Dict[str, Any]:
    """Oturumlarin GERCEK senkron durumunu dondurur (QR sonrasi initial sync).

    Kaynak: gateway bellegindeki sync durumu (session_sync_* olaylariyla ayni).
    Gateway'e ulasilamazsa `gateway_available=False` + phase `unavailable`
    doner — hata MASKELENMEZ ve "senkron yok" (idle) ile KARISTIRILAMAZ.
    (Onceki surum hatayi yutup her seyi 'idle' gosteriyordu; docstring
    'fail-closed' diyordu ama kod bunu yapmiyordu.)
    """
    sessions, gateway_error = await _list_sessions_internal(db, user_id)
    if gateway_error:
        return {
            "gateway_available": False,
            "gateway_error": gateway_error,
            "sessions": [
                {
                    "id": s["id"],
                    "session_name": s["session_name"],
                    "status": s["status"],
                    "sync": {"phase": "unavailable", "progress": 0},
                }
                for s in sessions
            ],
        }
    active = [s for s in sessions if s["status"] == "CONNECTED"] or sessions
    return {
        "gateway_available": True,
        "sessions": [
            {
                "id": s["id"],
                "session_name": s["session_name"],
                "status": s["status"],
                "sync": s.get("sync", {"phase": "idle", "progress": 0}),
            }
            for s in active
        ],
    }


async def create_session(db: AsyncSession, user_id: str, name: str) -> Dict[str, Any]:
    gw_session = await gw.create_session(name)
    gateway_id = gw_session.get("id")
    if not gateway_id:
        raise gw.WhatsAppGatewayError("Gateway oturum kimligi dondurmedi.")
    row = WhatsAppSession(
        user_id=user_id,
        gateway_id=gateway_id,
        session_name=gw_session.get("session_name") or name,
        status=_parse_status(gw_session.get("status")),
        phone_number=gw_session.get("phone_number"),
        is_phone_online=bool(gw_session.get("is_phone_online", False)),
        battery_level=gw_session.get("battery_level"),
        qr_code=gw_session.get("qr_code"),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("[WhatsApp] Yeni gateway oturumu: %s (%s)", row.session_name, gateway_id)
    return _session_dict(row)


async def _get_session_or_404(db: AsyncSession, user_id: str, session_id: int) -> WhatsAppSession:
    stmt = select(WhatsAppSession).where(
        WhatsAppSession.id == session_id,
        get_user_filter(WhatsAppSession.user_id, user_id),
    )
    res = await db.execute(stmt)
    row = res.scalar_one_or_none()
    if not row:
        raise LookupError("WhatsApp oturumu bulunamadi.")
    return row


async def get_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    # Redeploy sonrasi yetim kalan gateway oturumu varsa self-heal ile yeniden
    # kurulur (aksi halde QR/pairing akisi kalici olarak 502 verirdi).
    data = await _gateway_op_or_recreate(db, row, gw.get_session_qr)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "phone": data.get("phone") or row.phone_number,
        "error_message": data.get("error_message") or row.error_message,
    }


async def refresh_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    data = await _gateway_op_or_recreate(db, row, gw.refresh_session_qr)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "error_message": data.get("error_message") or row.error_message,
    }


async def request_pairing_code(db: AsyncSession, user_id: str, session_id: int, phone: str) -> Dict[str, Any]:
    """'Telefon numarası ile bağlan' — gateway'den 8 haneli pairing kodu ister.

    Hata durumunda WhatsAppGatewayError yukarı fırlar (fail-closed); asla
    sahte kod/sahte başarı döndürülmez (AGENTS.md Truthfulness).
    """
    row = await _get_session_or_404(db, user_id, session_id)
    # "Session not found" (redeploy yetimi) self-heal ile yeniden kurulur;
    # digeri hata aynen yukselir — sahte kod asla uretilmez (fail-closed).
    data = await _gateway_op_or_recreate(
        db, row, lambda gid: gw.request_pairing_code(gid, phone)
    )
    pairing_code = data.get("pairing_code")
    if not pairing_code:
        raise gw.WhatsAppGatewayError("Gateway pairing kodu döndürmedi.")
    if data.get("phone") and not row.phone_number:
        row.phone_number = data["phone"]
        await db.commit()
    return {
        "success": True,
        "pairing_code": str(pairing_code),
        "phone": data.get("phone") or row.phone_number,
    }


async def logout_session(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    try:
        await gw.logout_session(row.gateway_id)
    except gw.WhatsAppGatewayError as exc:
        # Redeploy sonrasi gateway belleginde oturum kalmadiysa hedef durum
        # (baglanti yok) zaten saglanmistir; DB satiri asagida DISCONNECTED
        # isaretlenir. Diger hatalar aynen yukselir (fail-closed).
        if not _is_gateway_session_missing(exc):
            raise
        logger.warning(
            "[WhatsApp] Gateway oturumu zaten yok (DB id=%s gateway_id=%s): %s",
            row.id, row.gateway_id, exc,
        )
    row.status = SessionStatus.DISCONNECTED
    row.is_active = False
    row.is_phone_online = False
    row.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "status": "DISCONNECTED"}


async def purge_whatsapp_data(db: AsyncSession, user_id: str) -> Dict[str, int]:
    """QR oturumu silindiğinde kullanıcının tüm WhatsApp eşitlemelerini kalıcı
    olarak temizler: mesajlar -> sohbetler -> (artık sohbeti kalmayan) kişiler.

    Kapsam: kullanıcıya ait satırlar + oturum sahibi çözümlenemeden gateway
    olaylarıyla yazılan SYSTEM_USER_ID satırları (hayalet sohbet kalmasın).
    Lead kayıtlarına dokunulmaz (contacts.lead_id FK'i yalnızca kişidedir,
    leads tablosu korunur). CRM/WhatsApp-dışı sohbetler korunur.
    """
    conv_ids: List[int] = []
    for owner in (str(user_id), SYSTEM_USER_ID):
        res = await db.execute(
            select(Conversation.id).where(
                get_user_filter(Conversation.user_id, owner),
                Conversation.channel == "WHATSAPP",
            )
        )
        conv_ids.extend(int(r[0]) for r in res.all())

    purged = {"messages": 0, "conversations": 0, "contacts": 0}
    if not conv_ids:
        return purged

    msg_res = await db.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))
    purged["messages"] = msg_res.rowcount or 0

    con_res = await db.execute(
        select(Conversation.contact_id).where(Conversation.id.in_(conv_ids))
    )
    contact_ids = [int(r[0]) for r in con_res.all() if r[0] is not None]

    conv_res = await db.execute(delete(Conversation).where(Conversation.id.in_(conv_ids)))
    purged["conversations"] = conv_res.rowcount or 0

    if contact_ids:
        # Yalnızca artık HİÇBİR sohbete bağlı olmayan kişileri sil (güvenlik
        # payandası: başka bir kanal/sohbet referans veriyorsa koru).
        remaining = select(Conversation.contact_id).where(Conversation.contact_id.isnot(None))
        ct_res = await db.execute(
            delete(Contact).where(
                Contact.id.in_(contact_ids),
                Contact.id.notin_(remaining),
            )
        )
        purged["contacts"] = ct_res.rowcount or 0

    return purged


async def delete_session(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    # §26/§27: oturum silinirken süren initial-sync job'ı iptal edilir — eski
    # gateway oturumuna karsi istek gondermeye devam etmez.
    _cancel_stale_sync_jobs(user_id)
    try:
        await gw.delete_session(row.gateway_id)
    except Exception as exc:
        logger.warning("Gateway oturum silinemedi (devam): %s", exc)
    purged = await purge_whatsapp_data(db, user_id)
    await db.delete(row)
    await db.commit()
    logger.info(
        "WhatsApp oturumu silindi (user=%s session=%s): %s eşitleme temizlendi",
        user_id, session_id, purged,
    )
    return {"success": True, "purged": purged}
# ---------------------------------------------------------------------------
# Kisiler (contacts)
# ---------------------------------------------------------------------------

def _set_contact_avatar(contact: Contact, avatar_url: Optional[str]) -> None:
    """Contact avatarini custom_attributes icina yazar (SQLite JSON degisim
    algisi icin sozlugu yeniden atamali guncelle)."""
    if not avatar_url:
        return
    attrs = dict(contact.custom_attributes or {})
    if attrs.get("avatar_url") == avatar_url:
        return
    attrs["avatar_url"] = avatar_url
    contact.custom_attributes = attrs


def _get_contact_avatar(contact: Optional[Contact]) -> Optional[str]:
    if contact is None:
        return None
    attrs = contact.custom_attributes or {}
    value = attrs.get("avatar_url") if isinstance(attrs, dict) else None
    return str(value) if value else None


async def sync_contacts(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    # Faz 6 (N+1 kaldirma): kisi basina SELECT+flush yerine TEK SELECT + tek
    # flush — 197 kisilik rehberde ~394 sorgu -> 2 sorgu. Semantik korunur
    # (dejenere JID kapisi, oncelikli ad cozumu, avatar, commit).
    gw_contacts = await gw.list_contacts()
    items = [
        (
            item.get("id"),
            item.get("name") or item.get("notify") or None,
            item.get("name_source"),
            item.get("avatar_url"),
        )
        for item in gw_contacts
        if item.get("id")
    ]
    resolved = await _bulk_upsert_contacts(db, user_id, items)
    out = [
        {
            "id": jid_str,
            "phone": contact.phone_e164,
            "name": contact.display_name,
            "avatar_url": _get_contact_avatar(contact),
        }
        for jid_str, contact in resolved
    ]
    await db.commit()
    return out


def _is_raw_jid_name(value: Optional[str]) -> bool:
    """Ham WhatsApp kimligi gorunumunde ad mi ('6277...@lid', '123...@c.us',
    'jid:...') — presentation layer'a asla cikmamali (Faz 7)."""
    if not value:
        return False
    v = str(value).strip()
    return (
        v.startswith("jid:")
        or "@lid" in v
        or v.endswith("@c.us")
        or v.endswith("@s.whatsapp.net")
        or v.endswith("@g.us")
    )


def _safe_display_name(contact: Optional[Contact]) -> Optional[str]:
    """UI icin guvenli gorunen ad: ham jid/lid sizarca None'a cevrilir
    (frontend normalize edilmis telefona duser)."""
    if contact is None:
        return None
    name = contact.display_name
    if _is_raw_jid_name(name):
        return None
    return name


def _contact_phone_for_jid(jid: str) -> str:
    """Kisi telefon/`jid:` sentinel kurali (tek kaynak — _upsert_contact ve
    batch yollari ayni semantigi kullanir).

    Grup JID'leri ("...@g.us") telefon numarasina cevrilemez; jid: sentinel'i
    ile saklanır — _resolve_jid ve is_group bu sentinel'e guvenir.
    """
    if "@g.us" in str(jid):
        return f"jid:{jid}"
    phone = jid_to_phone(jid)
    return phone or f"jid:{jid}"


async def _bulk_upsert_contacts(
    db: AsyncSession,
    user_id: str,
    items: List[Tuple[str, Optional[str], Optional[str], Optional[str]]],
) -> List[Tuple[str, Contact]]:
    """(jid, name, name_source, avatar) listesini TOPLU upsert eder (N+1 yok).

    Kisi basina SELECT+INSERT/UPDATE yerine 1 SELECT + tek flush: 197 kisilik
    rehberde 394 sorgu -> 2 sorgu (prod Postgres'te ~55s -> ~2s, Faz 6).
    Semantik `_upsert_contact` ile birebir aynidir: dejenere JID atlanir,
    `jid:` sentinel + legacy '+rakam' tasima, oncelik cozulumlu ad, avatar.
    Doner: (jid_str, Contact) — yeni kisi flush sonrasi id'lidir.
    """
    resolved: List[Tuple[str, str, Optional[str], Optional[str], Optional[str]]] = []
    for jid, name, source, avatar in items:
        jid_str = str(jid)
        if is_degenerate_jid(jid_str):  # §5/§24: '+0' kisi uretilmez
            continue
        resolved.append((jid_str, _contact_phone_for_jid(jid_str), name, source, avatar))
    if not resolved:
        return []
    phones: Set[str] = set()
    for jid_str, phone, _n, _s, _a in resolved:
        phones.add(phone)
        if phone.startswith("jid:"):
            legacy = jid_to_phone(jid_str)
            if legacy:
                phones.add(legacy)
    res = await db.execute(
        select(Contact).where(
            Contact.phone_e164.in_(sorted(phones)),
            get_user_filter(Contact.user_id, user_id),
        )
    )
    by_phone: Dict[str, Contact] = {}
    for c in res.scalars().all():
        by_phone.setdefault(str(c.phone_e164), c)
    out: List[Tuple[str, Contact]] = []
    for jid_str, phone, name, source, avatar in resolved:
        contact = by_phone.get(phone)
        if contact is None and phone.startswith("jid:"):
            # Eski kayitlar: grup JID'i yanlislikla "+rakam" gibi saklanmis olabilir.
            legacy = jid_to_phone(jid_str)
            if legacy:
                contact = by_phone.get(legacy)
                if contact is not None:
                    contact.phone_e164 = phone
        if contact is None:
            contact = Contact(
                user_id=user_id,
                phone_e164=phone,
                # Faz 7: ham jid/lid asla display_name olmaz — isim yoksa None.
                display_name=(None if _is_raw_jid_name(name) else name) or jid_to_phone(jid_str),
            )
            if name and str(source or "") in _NAME_RANK:
                contact.custom_attributes = {"name_source": str(source)}
            by_phone[phone] = contact
            db.add(contact)
        else:
            _set_contact_name(contact, name, source)
        _set_contact_avatar(contact, avatar)
        out.append((jid_str, contact))
    await db.flush()
    return out


async def _ensure_conversations_bulk(
    db: AsyncSession, user_id: str, contacts: List[Tuple[str, Contact]]
) -> List[Tuple[str, Contact, Conversation]]:
    """Kisi listesi icin WhatsApp conversation satirlarini TOPLU garanti eder.

    `_ensure_conversation` ile ayni semantik (yoksa ACTIVE + last_message_at
    tohumlanmaz — Faz 10 RC-1 korumasi), ama sohbet basina 2 sorgu yerine
    1 SELECT + tek flush (Faz 7).
    """
    contact_ids = [c.id for _jid, c in contacts if c.id is not None]
    by_contact: Dict[int, Conversation] = {}
    if contact_ids:
        res = await db.execute(
            select(Conversation).where(
                Conversation.contact_id.in_(contact_ids),
                Conversation.channel == "WHATSAPP",
                get_user_filter(Conversation.user_id, user_id),
            )
        )
        for conv in res.scalars().all():
            by_contact.setdefault(int(conv.contact_id), conv)
    out: List[Tuple[str, Contact, Conversation]] = []
    for jid_str, contact in contacts:
        conv = by_contact.get(contact.id) if contact.id is not None else None
        if conv is None:
            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                last_message_preview=None,
                # Sorun 4: grup bayragi JID'den kalici yazilir (@g.us).
                is_group="@g.us" in jid_str,
                is_archived=False,
                # Faz 10 (P2, RC-1): olustururken utcnow() ile GELECEK timestamp
                # tohumlanmaz — ozet yalnizca gercek mesaj verisiyle dolar.
                last_message_at=None,
            )
            if contact.id is not None:
                by_contact[contact.id] = conv
            db.add(conv)
        out.append((jid_str, contact, conv))
    await db.flush()
    return out


async def _upsert_contact(
    db: AsyncSession,
    user_id: str,
    jid: str,
    display_name: Optional[str],
    name_source: Optional[str] = None,
) -> Contact:
    # Faz 9 (§5, RC-2): dejenere JID'lerden (`0@s.whatsapp.net`) contact
    # ÜRETİLMEZ — '+0' contact'in kaynağı buydu. Çağıran katmanlar
    # (sync/ingest) bu hatayı yakalayıp kaydı atlar.
    if is_degenerate_jid(jid):
        raise ValueError(f"Degenerate WhatsApp JID reddedildi: {jid}")
    phone_e164 = _contact_phone_for_jid(jid)
    stmt = select(Contact).where(
        Contact.phone_e164 == phone_e164,
        get_user_filter(Contact.user_id, user_id),
    )
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if contact is None and phone_e164.startswith("jid:"):
        # Eski kayitlar: grup JID'i yanlislikla "+rakam" telefon gibi saklanmis
        # olabilir (jid_to_phone rakamlari topluyordu). Bulursak sentinel'e tasi.
        legacy = jid_to_phone(jid)
        if legacy:
            lres = await db.execute(
                select(Contact).where(
                    Contact.phone_e164 == legacy,
                    get_user_filter(Contact.user_id, user_id),
                )
            )
            contact = lres.scalar_one_or_none()
            if contact is not None:
                contact.phone_e164 = phone_e164
                await db.flush()
    if not contact:
        contact = Contact(
            user_id=user_id,
            phone_e164=phone_e164,
            # Faz 7: ham jid/lid asla display_name olmaz — isim yoksa None
            # birakilir; UI normalize telefon/guvenli fallback gosterir.
            display_name=(None if _is_raw_jid_name(display_name) else display_name) or jid_to_phone(jid),
        )
        if display_name and str(name_source or "") in _NAME_RANK:
            contact.custom_attributes = {"name_source": str(name_source)}
        db.add(contact)
        await db.flush()
    else:
        if _set_contact_name(contact, display_name, name_source):
            await db.flush()
    return contact


# ---------------------------------------------------------------------------
# Sohbetler (conversations)
# ---------------------------------------------------------------------------

async def _ensure_conversation(
    db: AsyncSession, user_id: str, jid: str, preview: Optional[str] = None
) -> Conversation:
    contact = await _upsert_contact(db, user_id, jid, None)
    stmt = select(Conversation).where(
        Conversation.contact_id == contact.id,
        Conversation.channel == "WHATSAPP",
        get_user_filter(Conversation.user_id, user_id),
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()
    if not conv:
        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            last_message_preview=preview,
            # Sorun 4: grup bayragi JID'den kalici yazilir (@g.us).
            is_group="@g.us" in jid,
            is_archived=False,
            # Faz 10 (P2, RC-1): olustururken utcnow() ile GELECEK timestamp
            # tohumlanmaz — gecmis mesajlarin hicbiri "daha yeni" olamaz ve
            # preview hicbir zaman yazilamazdi (prod'da 18 sohbetin 100
            # mesajli olmasina ragmen preview'i NULL kalmisti). Ozet artık
            # yalnizca gercek mesaj verisiyle _apply_last_message üzerinden
            # doldurulur; sohbetler last_message_at NULL olanlari liste
            # sonunda konumlandirir (nullslast).
            last_message_at=None,
        )
        db.add(conv)
        await db.flush()
    return conv


def _message_row_from_gateway(owner: str, conv: Conversation, msg: Dict[str, Any]) -> Optional[Message]:
    """Gateway mesaj kaydinden Message satiri uretir (INSERT yapmaz).

    `_persist_gateway_message` (tekli yol) ile chunked sync job'i (batch yolu)
    AYNI alan semantigini kullanir — iki kopya drift'i olusmaz.
    """
    jid_str = str(msg.get("conversation_id") or "")
    mtype_str = (msg.get("message_type") or "TEXT").upper()
    try:
        mtype = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.TEXT
    except Exception:
        mtype = MessageType.TEXT
    direction = MessageDirection.INBOUND if str(msg.get("direction", "INBOUND")).upper() == "INBOUND" else MessageDirection.OUTBOUND
    body = msg.get("body") or ""
    ts = _parse_dt(msg.get("created_at"))
    status_str = str(msg.get("status") or ("RECEIVED" if direction == MessageDirection.INBOUND else "SENT")).upper()
    try:
        status = ConversationMessageStatus[status_str]
    except Exception:
        status = ConversationMessageStatus.RECEIVED if direction == MessageDirection.INBOUND else ConversationMessageStatus.SENT
    return Message(
        user_id=owner,
        conversation_id=conv.id,
        direction=direction,
        message_type=mtype,
        body=body[:4000] if body else None,
        media_id=msg.get("media_id"),
        media_mime_type=msg.get("media_mime_type"),
        media_filename=msg.get("media_filename"),
        media_caption=msg.get("media_caption"),
        wa_message_id=msg.get("wa_message_id"),
        client_message_id=msg.get("client_message_id"),
        sender_phone=msg.get("sender_phone") or jid_to_phone(jid_str) or "unknown",
        # Faz 6a: grup gecmisi mesajlarinda participant pushname onecliklidir.
        sender_name=msg.get("participant_name") or msg.get("sender_name"),
        recipient_phone=msg.get("recipient_phone") or "ME",
        status=status,
        external_timestamp=_as_naive_utc(ts),
    )


async def _persist_gateway_message(db: AsyncSession, owner: str, msg: Dict[str, Any]) -> bool:
    """Gateway mesaj kaydini (history sync veya sync sirasinda cekilen) DB'ye yazar.

    wa_message_id ile dedup eder; yeni satir yazildiysa True doner.
    """
    jid = msg.get("conversation_id")
    if not jid or "@" not in str(jid):
        return False
    jid_str = str(jid)
    wa_id = msg.get("wa_message_id")
    conv = await _ensure_conversation(db, owner, jid_str)
    if wa_id:
        existing = await db.execute(
            select(Message).where(Message.wa_message_id == wa_id, Message.conversation_id == conv.id)
        )
        if existing.scalar_one_or_none() is not None:
            return False  # dedup
    row = _message_row_from_gateway(owner, conv, msg)
    if row is None:
        return False
    ts = _as_naive_utc(_parse_dt(msg.get("created_at")))
    db.add(row)
    # Faz 10 (P2): paylasilan son-mesaj kurali — tip etiketi, grup gonderen
    # on eki ve ZAMAN DAMGASI siralamasi tek kaynaktan.
    summary = build_last_message_summary(
        message_type=row.message_type.value,
        body=row.body,
        sender_name=row.sender_name,
        is_group="@g.us" in jid_str,
        direction=row.direction.value,
    )
    _apply_last_message(conv, ts, summary)
    await db.flush()
    return True


async def _repair_last_message_previews(db: AsyncSession, user_id: str) -> int:
    """Faz 10 (P2): eksik/bozuk son-mesaj ozetlerini messages tablosundan onarir.

    Senkron bittikten sonra calisir; henuz ozeti bos olan ya da eski
    placeholder tarzi ('[IMAGE]' vb.) yazilmis sohbetler icin en yeni mesaji
    (ZAMAN DAMGASI sirasiyla — ekleme sirasi degil) bulur ve paylasilan
    kurala gore ozeti yazar. Iki toplu sorgu kullanilir — sohbet basina
    sorgu (N+1) YOKTUR. Doner: duzeltilen sohbet sayisi.
    """
    cand_res = await db.execute(
        select(Conversation, Contact.phone_e164)
        .join(Contact, Contact.id == Conversation.contact_id, isouter=True)
        .where(
            get_user_filter(Conversation.user_id, user_id),
            Conversation.channel == "WHATSAPP",
            or_(
                Conversation.last_message_preview.is_(None),
                func.trim(Conversation.last_message_preview) == "",
                Conversation.last_message_preview.like("[%"),
            ),
        )
    )
    candidates = cand_res.fetchall()
    if not candidates:
        return 0
    conv_ids = [row[0].id for row in candidates]
    # Bu sohbetlerin TÜM mesajlarını tek sorguda çek, Python'da zaman damgasına
    # göre en yeniyi seç (postgres + sqlite testleri için dialect-bağımsız).
    msg_res = await db.execute(
        select(Message).where(Message.conversation_id.in_(conv_ids))
    )
    by_conv: Dict[int, List[Message]] = {}
    for m in msg_res.scalars().all():
        by_conv.setdefault(m.conversation_id, []).append(m)
    fixed = 0
    for conv, phone in candidates:
        msgs = by_conv.get(conv.id) or []
        if not msgs:
            continue  # gercekten mesajsiz — onarilacak bir sey yok
        newest = max(
            msgs,
            key=lambda m: _as_naive_utc(m.external_timestamp or m.sent_at or m.created_at)
            or datetime.min,
        )
        mtype = newest.message_type.value if hasattr(newest.message_type, "value") else str(newest.message_type or "TEXT")
        summary = build_last_message_summary(
            message_type=mtype,
            body=newest.body,
            sender_name=newest.sender_name,
            is_group=bool(phone and "@g.us" in phone),
            direction=newest.direction.value if hasattr(newest.direction, "value") else str(newest.direction),
        )
        if not summary:
            continue
        # Zehirli (utcnow tohumlu) last_message_at'i de gercek mesaja cevir.
        conv.last_message_preview = summary[:500]
        ts = _as_naive_utc(newest.external_timestamp or newest.sent_at or newest.created_at)
        if ts is not None:
            conv.last_message_at = ts
        fixed += 1
    if fixed:
        await db.flush()
        logger.info("Faz 10 preview onarimi: %d sohbet guncellendi (owner=%s)", fixed, user_id)
    return fixed


# Faz 8 (§16/§20): owner bazında tek paylaşılmış senkron hattı — initial-sync
# background task'ı, manuel "Eşitle" butonu ve endpoint çağrıları AYNI
# sync_conversations kodunu kullanır; aynı owner için ikinci bir çağrı
# gateway'e ikinci bir istek fırtınası yaratmaz (in-flight dedupe), mevcut
# DB anlık görüntüsünü döner.
_sync_conversations_inflight: Set[str] = set()


async def sync_conversations(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """LEGACY senkron hatti (chat basina gateway round-trip + tek commit).

    Yeni mimaride HTTP yolu bu fonksiyonu KULLANMAZ: `request_sync` WS tabanli
    chunked job'i tetikler (§15/§16). Bu hatti yalnizca gateway'de bulk kanali
    (`/messages/bulk`) yoksa job icinden fail-soft fallback olarak ve servis
    testleri icin korunur.
    """
    if user_id in _sync_conversations_inflight:
        result, _total = await list_conversations(db, user_id)
        return result
    _sync_conversations_inflight.add(user_id)
    try:
        return await _sync_conversations_impl(db, user_id)
    finally:
        _sync_conversations_inflight.discard(user_id)


async def _sync_conversations_impl(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    # Faz 7: "Eşitle" = tam yenileme — once telefon rehberini (W:Contact
    # app-state + history kisi kayitlari) DB'ye hydrate et; boylece hic
    # sohbeti olmayan kisilerin rehber adlari da kalici olur ve identity
    # cozumleme sohbet listesinde dogru ad uretir.
    try:
        await sync_contacts(db, user_id)
    except Exception as exc:
        logger.warning("Rehber senkronu atlandi (sohbet senkronu suruyor): %s", exc)
    # Faz 8 (RC-2): grup JID'leri subject olarak cozulmeden listeyi okuma —
    # gateway tek toplu groupFetchAllParticipating ile chats Map'lerini gunceller
    # ve conversation_updated yayar. Hata durumunda eski davranis surer
    # (fail-soft: isim uydurulmaz, ham JID zaten sanitize edilir).
    # Faz 10 (P1): "Eşitle" ve initial-sync artik FORCE ile ister — gateway
    # icindeki 10 dk'lik TTL, daha once cozulememis ("Grup" kalan) gruplarin
    # yeniden denenmesini engelliyordu. Gateway'de in-flight korumasi
    # varindan oldugu icin request storm olusmaz.
    try:
        await gw.sync_group_subjects(force=True)
    except Exception as exc:
        logger.warning("Grup basliklari senkronu atlandi: %s", exc)
    data = await gw.list_conversations(limit=200)
    items = data.get("items", []) if isinstance(data, dict) else []
    owner = user_id
    for item in items:
        jid = item.get("jid") or item.get("id")
        if not jid or "@" not in str(jid):
            continue
        jid_str = str(jid)
        # Faz 9 (§5): dejenere JID sohbetleri (`0@s.whatsapp.net`) DB'ye yazilmaz.
        if is_degenerate_jid(jid_str):
            continue
        preview_raw = item.get("last_message_preview") or ""
        # Sohbet adini (history sync'ten gelir) contact'a tasi — oncelik
        # cozulumu _set_contact_name icinde (rehber adi > push > telefon).
        chat_name = item.get("name")
        contact = await _upsert_contact(db, user_id, jid_str, chat_name, item.get("name_source"))
        # Faz 5: sohbet avatarunu (profil/grup resmi) contact'a tasi.
        _set_contact_avatar(contact, item.get("avatar_url"))
        stmt = select(Conversation).where(
            Conversation.contact_id == contact.id,
            Conversation.channel == "WHATSAPP",
            get_user_filter(Conversation.user_id, user_id),
        )
        res = await db.execute(stmt)
        conv = res.scalar_one_or_none()
        if conv is None:
            conv = await _ensure_conversation(db, user_id, jid_str)
        # Faz 4: sohbet gecmisini de cek (history sync gateway belleğinde tuttu).
        # Faz 10 (P2): gecmis ONCE çekilir ki paylasilan zaman-damgali kural
        # en yeni mesajı dogru secsin; gateway'in sohbet bazli preview'i
        # (medyada bos/eksik olabilir) yalnizca zaman damgasi daha yeni ise
        # ve normalize edilmis metin uretiyorsa uygulanir.
        try:
            # Sorun 1: legacy yolda sohbet basina tam gecmis yerine en yeni
            # _SYNC_PER_CHAT_LIMIT mesaj cekilir (bulk kanal yoksa bile
            # initial-sync maliyeti sinirli kalir; gecmis lazy hydration ile).
            msg_data = await gw.get_messages(jid_str, limit=_SYNC_PER_CHAT_LIMIT)
            gw_messages = msg_data.get("messages", []) if isinstance(msg_data, dict) else []
            for gm in gw_messages:
                gm = dict(gm)
                gm.setdefault("conversation_id", jid_str)
                await _persist_gateway_message(db, owner, gm)
        except Exception as exc:
            logger.warning("Sohbet gecmisi cekilemedi (%s): %s", jid_str, exc)
        gw_ts = _as_naive_utc(_parse_dt(str(item.get("last_message_at")))) if item.get("last_message_at") else None
        gw_summary = _normalize_preview_text(item.get("message_type") or "TEXT", preview_raw)
        if gw_summary:
            # Eski zehirli degerler (utcnow tohumlu last_message_at) düzeltilsin
            # diye gateway preview'i kendi zaman damgasiyla uygulariz;
            # conv.last_message_at gateway'den yeni ise kural zaten yazar.
            # Sorun 5: `gw_ts or utcnow()` UYDURMASI kaldirildi — gercek
            # zaman damgasi yoksa "simdi" yazmak sohbeti gelecege kilitler ve
            # sonraki gercek mesajlar (daha eski ts) ozeti bir daha asla
            # guncelleyemezdi. ts None ise _apply_last_message yalnizca ozeti
            # yazar (realtime semantigi), timestamp uydurulmaz.
            if conv.last_message_at is None or (gw_ts and gw_ts > conv.last_message_at):
                _apply_last_message(conv, gw_ts, gw_summary)
            elif not conv.last_message_preview:
                # Ozet hic yoksa (mesajsiz/eksik hydrate) gateway degeriyle doldur.
                _apply_last_message(conv, None, gw_summary)
        # Sorun 4: grup/arsiv metadata'sini kalici sutunlara yaz (gateway
        # arsiv alanini gondermiyorsa — eski gateway — mevcut deger korunur).
        conv.is_group = bool(item.get("is_group")) or "@g.us" in jid_str
        if "archived" in item:
            conv.is_archived = bool(item.get("archived"))
        unread = int(item.get("unread_count") or 0)
        conv.unread_count = max(conv.unread_count or 0, unread)
        await db.flush()
    # Faz 10 (P2): onarim gecisi — hâlâ ozeti bos/eksik olan sohbetleri,
    # mesaj tablosundan TEK agregat sorguyla (per-chat N+1 yok) hydrates et.
    await _repair_last_message_previews(db, user_id)
    await db.commit()
    result, _total = await list_conversations(db, user_id)
    return result


async def list_conversations(
    db: AsyncSession,
    user_id: str,
    search: Optional[str] = None,
    status: Optional[str] = None,
    unread_only: bool = False,
    group_only: bool = False,
    archived_only: bool = False,
    lead_id: Optional[int] = None,
    conversation_id: Optional[int] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    conv_filter = get_user_filter(Conversation.user_id, user_id)
    base = select(Conversation).where(conv_filter, Conversation.channel == "WHATSAPP")
    # `Contact` tablosuna katlanma GEREKEN filtreler icin join BIR KEZ yapilir
    # (ayni sorguda iki kez join etmek SQL hatasi uretir).
    joined_contact = False
    # Faz 12: lead -> sohbet cozumlemesi SUNUCU tarafinda. Onceden istemci
    # `limit=200` listesini indirip icinde ariyordu (LeadDetailDrawer'in sohbet
    # sekmesi) — hem agir hem de 200 sohbetten sonra sessizce basarisiz.
    #
    # DIKKAT: `Conversation.lead_id` kolonu var ama bugune kadar hicbir yerde
    # YAZILMIYOR (nullable CRM bagi). Yalnizca o kolonu filtrelemek sessizce HER
    # ZAMAN bos sonuc donerdi (AGENTS.md §1.1: sahte/bos basari yok). Gercek bag
    # TELEFON uzerindendir: `Lead.phone_e164` == `Contact.phone_e164`.
    # Bu yuzden iki yol BIRLIKTE denenir — kayitli CRM bagi VEYA telefon eslesmesi.
    if lead_id is not None:
        lead_phone = await db.scalar(
            select(Lead.phone_e164).where(
                Lead.id == lead_id,
                get_user_filter(Lead.user_id, user_id),
            )
        )
        base = base.join(Contact, Conversation.contact_id == Contact.id)
        joined_contact = True
        lead_match = [Contact.lead_id == lead_id]
        if lead_phone:
            lead_match.append(Contact.phone_e164 == lead_phone)
        base = base.where(or_(*lead_match))
    # Faz 12: tek sohbet cozumlemesi de hedefli sorguyla (200 satirlik liste
    # taramasi yerine) — ayni tenant filtresi.
    if conversation_id is not None:
        base = base.where(Conversation.id == conversation_id)
    if status:
        try:
            base = base.where(Conversation.status == ConversationStatus(status))
        except Exception:
            pass
    if unread_only:
        base = base.where(Conversation.unread_count > 0)
    # Sorun 4 (Grup/Arsiv sekmeleri): kalici sütunlar üzerinden filtre —
    # `group_only` yalnizca @g.us sohbetleri, `archived_only` WhatsApp'i
    # arsivlenmis (is_archived) VEYA CRM status'u ARCHIVED olan sohbetleri
    # dondurur. Ikisi birden verilirse kesisim (WhatsApp paritesi: "Arsiv"
    # sekmesindeki gruplar hem grup hem arsiv olarak sayilir).
    if group_only:
        base = base.where(Conversation.is_group.is_(True))
    if archived_only:
        base = base.where(
            or_(
                Conversation.is_archived.is_(True),
                Conversation.status == ConversationStatus.ARCHIVED,
            )
        )
    if search:
        like = f"%{search.strip().lower()}%"
        if not joined_contact:
            base = base.join(Contact, Conversation.contact_id == Contact.id)
            joined_contact = True
        base = base.where(
            or_(
                func.lower(Contact.display_name).like(like),
                func.lower(Contact.phone_e164).like(like),
            )
        )

    count_res = await db.execute(select(func.count()).select_from(base.subquery()))
    total = count_res.scalar_one()

    base = base.order_by(Conversation.last_message_at.desc().nullslast()).order_by(Conversation.id.desc())
    if offset:
        base = base.offset(offset)
    if limit:
        base = base.limit(limit)

    res = await db.execute(base)
    rows = res.scalars().all()

    contact_ids = [r.contact_id for r in rows if r.contact_id]
    contacts_map: Dict[int, Contact] = {}
    if contact_ids:
        cres = await db.execute(select(Contact).where(Contact.id.in_(contact_ids)))
        contacts_map = {c.id: c for c in cres.scalars().all()}

    # Faz 10 (P2): mesaj sayilari TEK agregat sorguyla — sohbet basina N+1 yok.
    # UI "Henüz WhatsApp Mesajı Yok" metnini yalnizca count==0 ve senkron
    # bittiginde gosterir (last_message_state).
    conv_ids = [r.id for r in rows]
    counts_map: Dict[int, int] = {}
    if conv_ids:
        cnt_res = await db.execute(
            select(Message.conversation_id, func.count())
            .where(Message.conversation_id.in_(conv_ids))
            .group_by(Message.conversation_id)
        )
        counts_map = {cid: int(n) for cid, n in cnt_res.fetchall()}

    out: List[Dict[str, Any]] = []
    for r in rows:
        contact = contacts_map.get(r.contact_id)
        phone = contact.phone_e164 if contact else None
        # Faz 10: eski kose-parantezli degerler okuma aninda da etikete
        # normalize edilir ('[IMAGE]' -> '📷 Fotoğraf'); normal metin aynen gecer.
        preview = _normalize_preview_text(None, r.last_message_preview) or None
        msg_count = counts_map.get(r.id, 0)
        if preview:
            lm_state = "RESOLVED"
        elif msg_count == 0:
            lm_state = "NO_MESSAGES"
        else:
            # Mesaj var ama ozet henuz hesaplanmadi (senkron/hydrate sürüyor).
            lm_state = "REPAIRING"
        out.append(
            {
                "id": r.id,
                "contact_id": r.contact_id,
                "lead_id": r.lead_id,
                # Faz 7: ham jid/lid sizarca UI'a None gonderilir (fallback
                # normalize telefon) — presentation'a internal ID sizmaz.
                "name": _safe_display_name(contact),
                "phone": phone,
                # Sorun 4: kalici `is_group` sütunu esas; eski satirlar
                # (sync oncesinde olusmus) JID sentinel'iyle tamamlanir.
                "is_group": bool(r.is_group) or bool(phone and "@g.us" in phone),
                # WhatsApp arsiv durumu (CRM status'tan bagimsiz, gateway
                # metadata'sindan kalici yazilir).
                "is_archived": bool(r.is_archived),
                "avatar_url": _get_contact_avatar(contact),
                "last_message_preview": preview,
                "last_message_at": r.last_message_at.isoformat() if r.last_message_at else None,
                "message_count": msg_count,
                "last_message_state": lm_state,
                "unread_count": r.unread_count,
                "status": r.status.value if hasattr(r.status, "value") else str(r.status),
            }
        )
    return out, total
# ---------------------------------------------------------------------------
# Mesajlar & gonderme
# ---------------------------------------------------------------------------

async def _get_conversation_or_404(db: AsyncSession, user_id: str, conversation_id: int) -> Conversation:
    stmt = select(Conversation).where(
        Conversation.id == conversation_id,
        get_user_filter(Conversation.user_id, user_id),
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()
    if not conv:
        raise LookupError("Konusma bulunamadi.")
    return conv


async def _resolve_jid(db: AsyncSession, user_id: str, conversation_id: int) -> Tuple[Conversation, str]:
    conv = await _get_conversation_or_404(db, user_id, conversation_id)
    if not conv.contact_id:
        raise LookupError("Konusma bir kisiyle iliskili degil.")
    cres = await db.execute(select(Contact).where(Contact.id == conv.contact_id))
    contact = cres.scalar_one()
    phone = contact.phone_e164
    jid = phone[4:] if phone.startswith("jid:") else phone_to_jid(phone)
    return conv, jid


async def _hydrate_messages_on_demand(
    db: AsyncSession, owner: str, conv: Conversation, limit: int,
    before_ts_ms: Optional[int] = None,
) -> List[Message]:
    """P0.11 (WhatsApp Web paritesi): kullanici sohbeti job hydrasyonundan once
    actiysa gateway belleğinden (history-sync'ten beri mevcut) bu sohbetin son
    mesajlarini cek + kalici yaz. Gercek veri, sentez yok; hata fail-soft
    (bos liste doner — UI zaten job banner'ini gosteriyor, basari maskelenmez).

    Sorun 1 (lazy hydration): `before_ts_ms` verildiginde gateway'den bu
    MILAT (ms epoch) tarihinden ESKI mesajlar istenir — initial sync yalnizca
    en yeni ~50 mesaji yazdigi icin, kullanici yukari kaydiridiginda kalan
    gecmis buradan tamamlanir. Kayit id'si history'de messageTimestamp*1000,
    canli akista Date.now() tabanlidir — ikisi de ms kronolojisi oldugu icin
    sucut ayni alanda calisir.
    """
    if not conv.contact_id:
        return []
    cres = await db.execute(select(Contact).where(Contact.id == conv.contact_id))
    contact = cres.scalar_one_or_none()
    if contact is None or not contact.phone_e164:
        return []
    phone = str(contact.phone_e164)
    jid = phone[4:] if phone.startswith("jid:") else phone_to_jid(phone)
    if not jid:
        return []
    try:
        data = await gw.get_messages(
            jid,
            limit=min(max(limit, 50), 100),
            before=before_ts_ms,
        )
    except Exception as exc:  # noqa: BLE001 — gateway kapali/eski: sessiz bos
        logger.info("On-demand hydrasyon atlandi (conv=%s): %s", conv.id, exc)
        return []
    gw_msgs = data.get("messages", []) if isinstance(data, dict) else []
    if not gw_msgs:
        return []
    # dedup: mevcut wa_message_id'ler tek SELECT ile.
    res = await db.execute(
        select(Message.wa_message_id).where(
            Message.conversation_id == conv.id, Message.wa_message_id.isnot(None)
        )
    )
    have = {str(r[0]) for r in res.all()}
    rows: List[Message] = []
    for gm in gw_msgs:
        wa = gm.get("wa_message_id")
        if wa and str(wa) in have:
            continue
        row = _message_row_from_gateway(owner, conv, gm)
        if row is None:
            continue
        if wa:
            have.add(str(wa))
        rows.append(row)
    if not rows:
        return []
    # Kronolojik sirala: gateway sayfası asc doner ama dedup/INSERT sonrasi
    # liste sirasi bozulabilir; sucut sonrasi eski+yeni karişik gelebilir.
    rows.sort(key=lambda r: (r.external_timestamp or r.created_at, r.id or 0))
    db.add_all(rows)
    await db.flush()
    # Preview'i da hydrate edilen gercek mesajla guncelle (sohbet listesi tutarli).
    # Sorun 1: eski gecmis hydrasyonunda (before_ts_ms) listedeki EN YENI
    # mesaj esas alinir — _apply_last_message ts-guard'u zaten daha eski
    # degerin mevcut ozeti ezmesini engeller.
    summary_src = rows[-1]
    _apply_last_message(
        conv,
        summary_src.external_timestamp,
        build_last_message_summary(
            message_type=summary_src.message_type.value,
            body=summary_src.body,
            sender_name=summary_src.sender_name,
            is_group="@g.us" in jid,
            direction=summary_src.direction.value,
        ),
    )
    await db.commit()
    for r in rows:
        await db.refresh(r)
    return list(reversed(rows))


def _hydration_cursor_ms(rows: List[Optional[Message]]) -> Optional[int]:
    """Verilen mesaj satirlarindaki EN ESKI gercek zaman damgasini gateway
    sucut alanina (ms epoch, naive-UTC tabanli) cevirir. Satir yoksa veya
    damga cozulemiyorsa None — sucut uydurulmaz (Truthfulness).

    Gateway `getMessages.before` kiyasi kayit id'si uzerindendir ve id hem
    history'de (messageTimestamp*1000) hem canli akista (Date.now() tabanli)
    ms epoch kronolojisidir — DB'deki external_timestamp ayni alana donusturulur.
    """
    oldest: Optional[datetime] = None
    for r in rows:
        if r is None:
            continue
        ts = r.external_timestamp or r.created_at
        if ts is not None and (oldest is None or ts < oldest):
            oldest = ts
    if oldest is None:
        return None
    return int(oldest.replace(tzinfo=timezone.utc).timestamp() * 1000)


async def get_messages(
    db: AsyncSession, user_id: str, conversation_id: int, limit: int = 50, before: Optional[int] = None
) -> Dict[str, Any]:
    conv = await _get_conversation_or_404(db, user_id, conversation_id)
    page_size = min(limit, 100)
    base = select(Message).where(
        Message.conversation_id == conv.id,
        get_user_filter(Message.user_id, user_id),
    )
    # Sorun 2 + Sorun 1 (zaman-damgali keyset sayfalamasi): `before` frontend
    # sozlesmesi geregi bir mesaj id'sidir, ama KESIM NOKTASI o satirin GERCEK
    # zaman damgasidir. Sebep: initial sync sohbet basina yalnizca en yeni ~50
    # mesaji yazar; kalan gecmis kaydirma sirasinda lazy hydration ile eklenir
    # ve bu eski mesajlar DB'de DAHA BUYUK auto-increment id alir. `id < before`
    # sayfalamasi bunlari gormezden gelir ve kronolojik sayfayi bozardi —
    # zaman-damgasi kesimi + siralamasi bunu duzeltir.
    before_row: Optional[Message] = None
    if before:
        bres = await db.execute(
            select(Message).where(Message.id == before, Message.conversation_id == conv.id)
        )
        before_row = bres.scalars().first()
        cutoff = before_row.external_timestamp if before_row else None
        if cutoff is not None:
            base = base.where(Message.external_timestamp < cutoff)
        else:
            # before satiri cozulemedi → bos sayfa (uydurma sucut yok).
            base = base.where(Message.id < before)
    base = base.order_by(
        Message.external_timestamp.desc().nullslast(), Message.id.desc()
    ).limit(page_size)
    res = await db.execute(base)
    rows = list(res.scalars().all())
    # Faz 6 (P0.11 lazy hydration): ilk sayfa hic bos ve sohbet hicbir zaman
    # mesaj gormemisse gateway belleğinden canli cek (job'u bekleme).
    if not rows and before is None:
        rows = await _hydrate_messages_on_demand(db, user_id, conv, limit)
    elif len(rows) < page_size:
        # Sorun 1 (kaydirma ile gecmis): DB sayfası tukendi — initial sync
        # sohbet basina yalnizca en yeni ~50 mesaji yazdigi icin kalan gecmis
        # gateway'den sucut tabanli tamamlanir. Suicut, sayfadaki (ve varsa
        # `before` satirindaki) EN ESKI GERCEK zaman damgasidir (sentez yok).
        cursor_src = list(rows) + ([before_row] if before_row else [])
        cursor_ms = _hydration_cursor_ms(cursor_src)
        if cursor_ms is not None:
            older = await _hydrate_messages_on_demand(
                db, user_id, conv, page_size - len(rows), before_ts_ms=cursor_ms
            )
            if older:
                seen_ids = {r.id for r in rows}
                rows = [r for r in older if r.id not in seen_ids] + rows
    # Kronolojik cikis siralamasi (eski→yeni): hydration sonrasi id sirasi
    # bozulabilir — tek dogru anahtar gercek zaman damgasidir.
    rows.sort(key=lambda r: (r.external_timestamp or r.created_at or datetime.min, r.id or 0))
    has_more = len(rows) == page_size
    messages = [_serialize_message(r) for r in rows]
    return {
        "messages": messages,
        "has_more": has_more,
        "oldest_message_id": messages[0]["id"] if messages else None,
        "newest_message_id": messages[-1]["id"] if messages else None,
    }


async def send_text_message(
    db: AsyncSession, user_id: str, conversation_id: int, body: str, client_message_id: Optional[str] = None
) -> Dict[str, Any]:
    conv, jid = await _resolve_jid(db, user_id, conversation_id)
    clean = body.strip()
    if not clean:
        raise LookupError("Mesaj bos olamaz.")
    gateway_result = await gw.send_text_message(jid, clean, client_message_id)
    wa_id = gateway_result.get("wa_message_id")
    row = Message(
        user_id=user_id,
        conversation_id=conv.id,
        direction=MessageDirection.OUTBOUND,
        message_type=MessageType.TEXT,
        body=clean,
        wa_message_id=wa_id,
        client_message_id=client_message_id,
        sender_phone="ME",
        recipient_phone=jid_to_phone(jid) or jid,
        status=ConversationMessageStatus.SENT,
        sent_at=datetime.utcnow(),
    )
    db.add(row)
    # Faz 10 (P2): gonderim yolu da paylasilan kurali kullanir (tek kaynak).
    _apply_last_message(
        conv,
        datetime.utcnow(),
        build_last_message_summary(
            message_type="TEXT", body=clean, direction=MessageDirection.OUTBOUND.value
        ),
    )
    await db.commit()
    await db.refresh(row)
    return _serialize_message(row)


async def send_media_message(
    db: AsyncSession, user_id: str, conversation_id: int, media: Dict[str, Any]
) -> Dict[str, Any]:
    conv, jid = await _resolve_jid(db, user_id, conversation_id)
    gateway_result = await gw.send_media_message(jid, media)
    wa_id = gateway_result.get("wa_message_id")
    mtype_str = (media.get("media_type") or "document").upper()
    try:
        msg_type = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.DOCUMENT
    except Exception:
        msg_type = MessageType.DOCUMENT
    caption = media.get("caption")
    filename = media.get("filename")
    row = Message(
        user_id=user_id,
        conversation_id=conv.id,
        direction=MessageDirection.OUTBOUND,
        message_type=msg_type,
        body=(caption or filename or media.get("media_url") or "")[:4000],
        media_id=None,
        media_filename=filename,
        media_caption=caption,
        wa_message_id=wa_id,
        client_message_id=media.get("client_message_id"),
        sender_phone="ME",
        recipient_phone=jid_to_phone(jid) or jid,
        status=ConversationMessageStatus.SENT,
        sent_at=datetime.utcnow(),
    )
    db.add(row)
    # Faz 10 (P2): "[Medya]" yerine paylasilan kuralin tip etiketi.
    _apply_last_message(
        conv,
        datetime.utcnow(),
        build_last_message_summary(
            message_type=mtype_str,
            body=caption or filename,
            direction=MessageDirection.OUTBOUND.value,
        ),
    )
    await db.commit()
    await db.refresh(row)
    return _serialize_message(row)


async def mark_conversation_read(db: AsyncSession, user_id: str, conversation_id: int) -> Dict[str, Any]:
    """Sohbeti okundu isaretler.

    Faz 13 (truthfulness): gateway'e okundu bilgisi ILETILEMEZSE `success=False`
    doner. Onceden gateway hatasi yutulup her durumda `success: True` donuyordu
    — karsi taraf mesaji hala "okunmadi" gorurken UI "okundu" gosteriyordu
    (sahte basari). Yerel CRM sayaci yine sifirlanir (kullanici mesaji bu UI'da
    gordu), ancak gercek iletim durumu cagirana DOGRU bildirilir.
    """
    conv, jid = await _resolve_jid(db, user_id, conversation_id)
    gateway_ok = True
    gateway_error: Optional[str] = None
    try:
        await gw.mark_conversation_read(jid)
    except Exception as exc:
        gateway_ok = False
        gateway_error = str(exc)[:300]
        logger.warning("Gateway okundu isareti iletilemedi (conv=%s): %s", conversation_id, exc)
    conv.unread_count = 0
    conv.last_read_at = datetime.utcnow()
    await db.commit()
    result: Dict[str, Any] = {"success": gateway_ok}
    if gateway_error:
        result["error"] = gateway_error
    return result


async def send_typing(db: AsyncSession, user_id: str, conversation_id: int, typing: bool = True) -> Dict[str, Any]:
    """Karsı tarafa 'yazıyor...' gostermesi gonderir (WhatsApp Web paritesi)."""
    conv, jid = await _resolve_jid(db, user_id, conversation_id)
    await gw.send_typing(jid, typing=typing)
    return {"success": True}


async def get_media_bytes(db: AsyncSession, user_id: str, media_id: str) -> Tuple[bytes, Optional[str], Optional[str]]:
    """Kullaniciya ait bir mesaja ait medyayi gateway'den proxy'ler.

    Doner: (baytlar, mime_type, filename). Medya kaydi yoksa/erisim yoksa LookupError.
    """
    res = await db.execute(
        select(Message).where(
            Message.media_id == media_id,
            get_user_filter(Message.user_id, user_id),
        )
    )
    row = res.scalars().first()
    if row is None:
        raise LookupError(f"Medya bulunamadi: {media_id}")
    data = await gw.fetch_media(media_id)
    return data, row.media_mime_type, row.media_filename


# ---------------------------------------------------------------------------
# Initial-sync job mimarisi (HTTP yerine WS tabanli arka plan hydrasyonu)
#
# Eski davranis: GET /conversations?sync=true, 113 chat icin per-chat gateway
# round-trip'ini + tek commit'i HTTP istegi ICINDE beklerdi; Render 60s proxy
# timeout'u ve Baileys "Timed Out" hatalariyla 502 + retry storm'u uretiyordu
# (olculen kok neden). Yeni davranis: HTTP yalnizca job'i tetikler ve aninda
# DB snapshot'i doner; agir hydrasyon asyncio job'i olarak MEVCUT WebSocket
# uzerinden `whatsapp_sync_*` olaylarina akitor.
#
# Sozlesme (§25/§40): her olay snake_case `event`, job bazinda `sync_id`
# (frontend stale-sync filtresi) ve `user_id` (WS tenant routing) tasir.
# ---------------------------------------------------------------------------

_SYNC_BULK_PAGE_SIZE = 1000   # gateway'den tek istekte cekilen mesaj
_SYNC_PERSIST_BATCH = 200     # dedup-SELECT + INSERT grubu
_SYNC_EVENT_CHUNK = 100       # WS mesaj chunk olayinin ust siniri
_SYNC_CHAT_PAGE_SIZE = 40     # sohbet anlik goruntusu sayfa boyutu

# Sorun 1 (yavas initial sync): bulk kanali her sohbet icin yalnizca EN YENI
# N mesajı ceker (gateway `perChatLimit`). WhatsApp Web'in kendi davranisiyla
# ayni: acilmayan sohbetin tam gecmisi istenmez; daha eskileri kullanici
# yukari kaydiridiginda lazy hydration ile gelir (get_messages/before).
_SYNC_PER_CHAT_LIMIT = 50

# WhatsApp Web paritesi (Faz 17/28): sohbet listesi, Baileys history sync
# SIRASINDA (session_sync_completed'i beklemeden) canli `conversation_updated`
# olaylariyla akmaya baslar. Backend bu akisi owner'in WS'ine 2 sn'de bir
# 'whatsapp_sync_chats_bootstrap' olayiyla sinyaller; frontend bu olayi
# aldiginda DB snapshot'ini GET /conversations ile hemen yukler — UI, job'un
# ~137 sn'lik N+1 fazini beklemez. Sahte veri/atlama YOK: yalnizca GERCEK
# kalici yazilmis sohbetler gosterilir.
_BOOTSTRAP_EMIT_INTERVAL_S = 2.0

_bulk_channel_cache: Dict[str, Any] = {"ok": False, "checked_at": 0.0}

# owner -> son bootstrap yayin zamani (time.monotonic) — throttled akis.
_last_bootstrap_emit: Dict[str, float] = {}


def _schedule_chats_bootstrap(owner: str) -> None:
    """Canli sohbet olayindan sonra (throttled) bootstrap sinyali yayinla.

    Fire-and-forget: hata yayilmaz, zamanlayici varsa ikinci task yok."""
    now = time.monotonic()
    last = _last_bootstrap_emit.get(owner)
    if last is not None and now - last < _BOOTSTRAP_EMIT_INTERVAL_S:
        return
    _last_bootstrap_emit[owner] = now

    async def _emit() -> None:
        await _broadcast_sync_event({
            "event": "whatsapp_sync_chats_bootstrap",
            "sync_id": "live",
            "user_id": owner,
            "at": datetime.now(timezone.utc).isoformat(),
        }, owner)

    try:
        asyncio.get_running_loop().create_task(_emit())
    except RuntimeError:
        pass  # event loop yok (test disi senkron baglam) — sessiz atla


class SyncJob:
    """Tek bir initial-sync calismasi — durum makinesi SYNCING/COMPLETED/FAILED.

    `done` event'i job sonlandiginda set edilir; `sync_conversations` gibi
    HTTP kisa yollari yeni job tetiklemeden mevcut job'i bekleyebilir (§17).
    """

    __slots__ = ("sync_id", "user_id", "state", "stage", "error", "cancel_requested",
                 "chats_total", "chats_synced", "contacts_synced", "messages_total",
                 "messages_synced", "started_at", "finished_at", "done", "task",
                 "stage_timings")

    def __init__(self, sync_id: str, user_id: str) -> None:
        self.sync_id = sync_id
        self.user_id = user_id
        self.state = "SYNCING"
        self.stage = "starting"
        self.error: Optional[str] = None
        self.cancel_requested = False
        self.chats_total = 0
        self.chats_synced = 0
        self.contacts_synced = 0
        self.messages_total = 0
        self.messages_synced = 0
        self.started_at = datetime.now(timezone.utc)
        self.finished_at: Optional[datetime] = None
        self.done = asyncio.Event()
        self.task: Optional[asyncio.Task] = None
        # Faz 6 (P0.1 enstrumantasyon): asama bazinda gecen sure (sn) — benchmark
        # ve raporlama icin gercek olcum; tahmin DEGIL (time.monotonic delta).
        self.stage_timings: Dict[str, float] = {}

    def snapshot(self) -> Dict[str, Any]:
        """GET /sync/job + WS reconnect kurtarmasi icin gercek durum (§28)."""
        return {
            "sync_id": self.sync_id,
            "state": self.state,
            "stage": self.stage,
            "error": self.error,
            "chats_total": self.chats_total,
            "chats_synced": self.chats_synced,
            "contacts_synced": self.contacts_synced,
            "messages_total": self.messages_total,
            "messages_synced": self.messages_synced,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "stage_timings": dict(self.stage_timings),
        }


# owner -> aktif/son job (uvicorn tek is parca calisir — start.py; in-process
# registry yeterli; redeploy'da job duser, frontend GET /sync/job ile gorur).
_sync_jobs: Dict[str, SyncJob] = {}


async def _bulk_channel_available() -> bool:
    """Gateway'de `/messages/bulk` kanali var mi (yeni gateway surumu).

    Eski gateway dagitimi 404 donerur; job bu durumda legacy per-chat hattina
    fail-soft duser (hata yayilmaz). Sonuc 5 dk cache'lenir.
    """
    import time as _time

    now = _time.monotonic()
    if now - float(_bulk_channel_cache.get("checked_at") or 0.0) < 300:
        return bool(_bulk_channel_cache.get("ok"))
    try:
        probe = await gw.list_all_messages(limit=1, offset=0)
        ok = isinstance(probe, dict) and "messages" in probe
    except Exception:  # noqa: BLE001 — gateway kapali/eski surum: legacy hat
        ok = False
    _bulk_channel_cache["ok"] = ok
    _bulk_channel_cache["checked_at"] = now
    return ok


async def _broadcast_sync_event(payload: Dict[str, Any], owner: str) -> None:
    """whatsapp_sync_* olayini mevcut ws_manager uzerinden SAHIBINE yollar.

    `owner` ZORUNLU argümandir: hedef tenant cagri aninda acikca verilir,
    payload icindeki `user_id` alanina guvenilmez (Faz 13 tenant izolasyonu).
    Broadcast hatasi job'i dusurmaz — DB gercegi yazilmaya devam eder,
    frontend reconnect'te GET /sync/job ile toparlar (§28).
    """
    try:
        from backend.app.api.v1.websocket import ws_manager
        sent = await ws_manager.broadcast(payload, target_user_id=owner)
        if sent == 0:
            logger.debug(
                "Sync olayi teslim edilecek soket bulamadi (event=%s, owner=%s)",
                payload.get("event"), owner,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Sync olayi yayilamadi (%s): %s", payload.get("event"), exc)


def _sync_event(job: SyncJob, event: str, **fields: Any) -> Dict[str, Any]:
    """Ortak sozlesme: snake_case event + sync_id + user_id + alanlar."""
    return {"event": event, "sync_id": job.sync_id, "user_id": job.user_id, **fields}


async def request_sync(db: AsyncSession, user_id: str) -> SyncJob:
    """Sync job'i tetikle ya da suren job'i dondur (asla ikinci job yok, §17).

    Kisa omurlu: job kaydi olustur + arka plan task'i baslat + aninda don.
    COMPLETED/FAILED job beklenmez — yeni sync_id ile taze job baslar.
    """
    owner = str(user_id)
    job = _sync_jobs.get(owner)
    if job is not None and job.state == "SYNCING":
        return job
    job = SyncJob(sync_id=uuid.uuid4().hex, user_id=owner)
    _sync_jobs[owner] = job
    job.task = asyncio.create_task(_run_sync_job(job))
    return job


def get_sync_job(user_id: str) -> Optional[Dict[str, Any]]:
    """Owner'in mevcut/son job anlik goruntusu (WS reconnect kurtarma, §28)."""
    job = _sync_jobs.get(str(user_id))
    return job.snapshot() if job else None


def _cancel_stale_sync_jobs(user_id: str) -> int:
    """Oturum silinince owner'in suren job'ini iptal eder — eski gateway
    oturumuna karsi istek gondermeye devam etmez (§26/§27)."""
    job = _sync_jobs.get(str(user_id))
    if job is None or job.state != "SYNCING":
        return 0
    job.cancel_requested = True
    return 1


async def _reapply_chat_names(
    db: AsyncSession, owner: str, items: List[Dict[str, Any]]
) -> None:
    """Faz 6 (P0.3 sonrasi): sohbet-listesi adlarini REHBER fazindan SONRA
    yeniden otoriter kilar.

    Eski sirada (contacts -> chats) sohbet adi son yazan oldugu icin tie-break'ta
    kazanirdi — WhatsApp Web paritesi: gateway sohbet adini contact-store ile
    merge ederek uretir, canli ortamda iki kaynak ayni ad/rutbeyi tasir. Yeni
    sirada (chats -> contacts) tie-break tersine donup rehber mock/eski adini
    sohbet adinin uzerine yazabiliyor; tek SELECT'lik bu onarim ad semantigini
    SIRADAN BAGIMSIZ hale getirir. Dusuk rutbeli ad yuksek rutbeliyi asla ezmez
    (_set_contact_name korumasi) — addressbook > chat-gorunen ad kirilmaz.
    """
    named = [
        (str(item.get("jid") or item.get("id")), item.get("name"), item.get("name_source"))
        for item in items
        if (item.get("jid") or item.get("id")) and item.get("name")
    ]
    if not named:
        return
    phones = {
        _contact_phone_for_jid(j) for j, _n, _s in named if not is_degenerate_jid(j)
    }
    if not phones:
        return
    res = await db.execute(
        select(Contact).where(
            Contact.phone_e164.in_(sorted(phones)),
            get_user_filter(Contact.user_id, owner),
        )
    )
    by_phone: Dict[str, Contact] = {}
    for c in res.scalars().all():
        by_phone.setdefault(str(c.phone_e164), c)
    changed = False
    for jid_str, name, source in named:
        if is_degenerate_jid(jid_str):
            continue
        contact = by_phone.get(_contact_phone_for_jid(jid_str))
        if contact is not None and _set_contact_name(contact, name, source):
            changed = True
    if changed:
        await db.commit()


async def _run_sync_job(job: SyncJob) -> None:
    """Chunked initial-sync hatti — WS olaylariyla ilerler, HTTP'yi bloklamaz.

    Faz 6 (P0.3) — SOHBETLER İLK: chats snapshot artik rehber/mesaj fazlarindan
    ONCE yayinlanir; kullanici sohbete job basladiktan saniyeler sonra baslar,
    rehber adlari + mesajlar arka planda tamamlanir (WhatsApp Web sirasi).
    Akis: started -> grup basliklari -> chats snapshot -> contacts -> mesajlar
    (tek bulk fetch, sayfali) -> onarim + complete/failed.
    Chat basina gateway cagrisi YOK (§21); her fazin gercek suresi
    stage_timings'e yazilir (P0.1).
    """
    owner = job.user_id
    try:
        async with AsyncSessionLocal() as db:
            await _broadcast_sync_event(_sync_event(job, "whatsapp_sync_started", started_at=job.started_at.isoformat()), owner)
            phase_t0 = time.monotonic()

            def _mark_phase(name: str) -> None:
                nonlocal phase_t0
                now = time.monotonic()
                job.stage_timings[name] = round(job.stage_timings.get(name, 0.0) + (now - phase_t0), 3)
                phase_t0 = now

            # 1) Grup basliklari (fail-soft; force — cozulememis gruplar tekrar denensin).
            #    Tek gateway cagrisi, bellek-ici cozum — hizli; sohbet snapshot'indaki
            #    grup isimlerinin dogru gelmesi icin chats'ten once kalir.
            try:
                await gw.sync_group_subjects(force=True)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Sync job grup basliklari atlandi (owner=%s): %s", owner, exc)
            _mark_phase("group_subjects")

            # 2) Sohbet anlik goruntusu — chat BASINA gateway istegi YOK (§21);
            #    chats listesi tek cagri, DB'ye bir geciste TOPLU yazilir (Faz 7).
            #    Bu faz biter bitmez chats_snapshot yayinlanir — UI artik mesaj
            #    senkronunu BEKLEMEZ (P0.3).
            job.stage = "chats"
            data = await gw.list_conversations(limit=200)
            items = data.get("items", []) if isinstance(data, dict) else []
            conv_out, jid_by_conv = await _persist_chat_snapshot(db, owner, items)
            job.chats_total = len(conv_out)
            job.chats_synced = len(conv_out)
            if job.cancel_requested:
                raise asyncio.CancelledError()
            for page_start in range(0, len(conv_out), _SYNC_CHAT_PAGE_SIZE):
                await _broadcast_sync_event(_sync_event(
                    job, "whatsapp_sync_chats_snapshot",
                    total=job.chats_total,
                    conversations=conv_out[page_start:page_start + _SYNC_CHAT_PAGE_SIZE]), owner)
            _mark_phase("chats")

            # 3) Rehber (fail-soft — sohbetler artik gorunur, ad zenginlestirmesi
            #    arka planda tamamlanir; final complete olayi cozulmus listeyi tasir).
            job.stage = "contacts"
            try:
                contacts = await sync_contacts(db, owner)
                job.contacts_synced = len(contacts)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Sync job rehber adimi atlandi (owner=%s): %s", owner, exc)
                contacts = []
            if job.cancel_requested:
                raise asyncio.CancelledError()
            await _broadcast_sync_event(_sync_event(
                job, "whatsapp_sync_contacts_snapshot",
                total=job.contacts_synced, contacts=contacts[:_SYNC_EVENT_CHUNK]), owner)
            _mark_phase("contacts")

            # 3b) Ad otoritesini geri ver (P0.3 tie-break onarimi, tek SELECT):
            #     sohbet-listesi adlari rehber fazindan bagimsiz olarak kazanir —
            #     WhatsApp Web'de kullaniciyin gordugu ad budur.
            try:
                await _reapply_chat_names(db, owner, items)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Sync job ad onarimi atlandi (owner=%s): %s", owner, exc)

            # 4) Mesajlar — TEK bulk kanaldan, bellek-ici offset sayfalamasi
            #    (§21: per-chat HTTP yok; §23: mesaj basina sorgu yok; Faz 8:
            #    dedup kumesi sayfalar arasi onbelleklenir).
            job.stage = "messages"
            if await _bulk_channel_available():
                await _run_bulk_message_sync(db, job, jid_by_conv)
            else:
                # Eski gateway dagitimi: legacy per-chat hatti (fail-soft).
                logger.warning("Gateway bulk kanali yok — legacy per-chat sync (owner=%s)", owner)
                await _sync_conversations_impl(db, owner)
            if job.cancel_requested:
                raise asyncio.CancelledError()
            _mark_phase("messages")

            # 5) Onarim + tamamlanma — preview'i eksik sohbetleri tek agregat
            #    sorguyla hydrate et, sonra cozulmus tam listeyi yayinla.
            job.stage = "finalizing"
            await _repair_last_message_previews(db, owner)
            await db.commit()
            result, _total = await list_conversations(db, owner)
            _mark_phase("finalizing")
            job.state = "COMPLETED"
            job.stage = "complete"
            job.finished_at = datetime.now(timezone.utc)
            await _broadcast_sync_event(_sync_event(
                job, "whatsapp_sync_complete",
                conversations=result,
                chats_synced=job.chats_synced,
                contacts_synced=job.contacts_synced,
                messages_synced=job.messages_synced,
                finished_at=job.finished_at.isoformat(),
                stage_timings=dict(job.stage_timings),
                duration_s=round((job.finished_at - job.started_at).total_seconds(), 3),
            ), owner)
            logger.info(
                "Sync job tamamlandi (owner=%s sync_id=%s chats=%s msgs=%s sure=%ss fazlar=%s)",
                owner, job.sync_id, job.chats_synced, job.messages_synced,
                round((job.finished_at - job.started_at).total_seconds(), 1),
                job.stage_timings,
            )
    except asyncio.CancelledError:
        job.state = "FAILED"
        job.error = "sync iptal edildi"
        job.finished_at = datetime.now(timezone.utc)
        logger.info("Sync job iptal edildi (owner=%s sync_id=%s)", owner, job.sync_id)
        # Faz 13: iptal de UI'a BILDIRILIR. Onceden yalnizca state degisiyordu;
        # frontend `whatsapp_sync_failed` olayi gelmedigi icin banner'i
        # "senkron surüyor" durumunda takili kaliyordu (sessiz basarisizlik).
        await _broadcast_sync_event(_sync_event(
            job, "whatsapp_sync_failed", error=job.error, stage=job.stage), owner)
    except Exception as exc:  # noqa: BLE001 — fail-closed: hatayi UI'a bildir
        job.state = "FAILED"
        job.error = str(exc)[:500]
        job.finished_at = datetime.now(timezone.utc)
        logger.warning("Sync job basarisiz (owner=%s sync_id=%s): %s", owner, job.sync_id, exc)
        await _broadcast_sync_event(_sync_event(
            job, "whatsapp_sync_failed", error=job.error, stage=job.stage), owner)
    finally:
        job.done.set()
        _initial_sync_inflight.discard(owner)


async def _persist_chat_snapshot(
    db: AsyncSession, owner: str, items: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], Dict[int, str]]:
    """Gateway chats listesini TOPLU geciste DB'ye yazar (Faz 7: N+1 yok).

    Eski yol sohbet basina `_upsert_contact` + `_ensure_conversation`
    (2 SELECT + flush) calistiriyordu — 113 sohbette prod Postgres'te ~81s.
    Yeni yol: tek `_bulk_upsert_contacts` + tek `_ensure_conversations_bulk`
    (2 SELECT + 2 flush) + tek commit. Semantik birebir korunur: dejenere JID
    kapisi, oncelikli ad cozumu, avatar, ts-guard'lu preview, unread max.

    Doner: (list_conversations formatinda sohbet serisi — ham WhatsApp
    nesnesi DEGIL, sayisal DB kimlikli, §30; conversation_id -> ham jid haritasi
    — jid yalnizca backend icinde kalir, frontend'e sizmaz).
    """
    candidates: List[Dict[str, Any]] = []
    for item in items:
        jid = item.get("jid") or item.get("id")
        if not jid or "@" not in str(jid):
            continue
        if is_degenerate_jid(str(jid)):  # §5/§24: '+0' sohbeti DB'ye yazilmaz
            continue
        candidates.append(item)
    contacts = await _bulk_upsert_contacts(
        db, owner,
        [
            (str(item.get("jid") or item.get("id")), item.get("name"),
             item.get("name_source"), item.get("avatar_url"))
            for item in candidates
        ],
    )
    item_by_jid: Dict[str, Dict[str, Any]] = {
        str(item.get("jid") or item.get("id")): item for item in candidates
    }
    triples = await _ensure_conversations_bulk(db, owner, contacts)
    out: List[Dict[str, Any]] = []
    jid_by_conv: Dict[int, str] = {}
    for jid_str, contact, conv in triples:
        item = item_by_jid.get(jid_str)
        if item is None:
            continue
        gw_ts = _as_naive_utc(_parse_dt(str(item.get("last_message_at")))) if item.get("last_message_at") else None
        gw_summary = _normalize_preview_text(item.get("message_type") or "TEXT", item.get("last_message_preview") or "")
        if gw_summary:
            # Sorun 5: `gw_ts or utcnow()` uydurmasi kaldirildi (bkz.
            # sync_conversations ayisi) — gercek olmayan zaman damgasi
            # sohbeti gelecege kilitler, toplu senkrondaki bayat ozet daha
            # yeni gercek mesajlarin uzerine yazilmaz.
            if conv.last_message_at is None or (gw_ts and gw_ts > conv.last_message_at):
                _apply_last_message(conv, gw_ts, gw_summary)
            elif not conv.last_message_preview:
                _apply_last_message(conv, None, gw_summary)
        # Sorun 4: Baileys sohbet metadata'sini (grup/arsiv) kalici yaz.
        conv.is_group = bool(item.get("is_group")) or "@g.us" in jid_str
        if "archived" in item:
            conv.is_archived = bool(item.get("archived"))
        conv.unread_count = max(conv.unread_count or 0, int(item.get("unread_count") or 0))
        jid_by_conv[conv.id] = jid_str
        out.append(
            {
                "id": conv.id,
                "contact_id": contact.id,
                "lead_id": conv.lead_id,
                "name": _safe_display_name(contact),
                "phone": contact.phone_e164,
                "is_group": "@g.us" in jid_str,
                "is_archived": bool(conv.is_archived),
                "avatar_url": _get_contact_avatar(contact),
                "last_message_preview": gw_summary or None,
                "last_message_at": gw_ts.isoformat() if gw_ts else None,
                "message_count": 0,
                "last_message_state": "RESOLVED" if gw_summary else "REPAIRING",
                "unread_count": conv.unread_count,
                "status": conv.status.value if hasattr(conv.status, "value") else str(conv.status),
            }
        )
    await db.commit()
    return out, jid_by_conv


async def _sync_watermark_epoch(db: AsyncSession, owner: str) -> Optional[int]:
    """P0.13 delta suucusu: kullanıcının DB'sindeki en son mesaj zamanı (epoch
    saniye, 5 dk overlap payıyla). Hiç mesaj yoksa None → tam cekim.

    Suuc uydurma degil: external_timestamp gateway'deki GERCEK Baileys
    messageTimestamp'ten yazilir. Realtime akis (message_new) yeni mesajları
    zaten kalici yazdigi icin suuc her senkronla ilerler.
    """
    res = await db.execute(
        select(func.max(Message.external_timestamp)).where(
            get_user_filter(Message.user_id, owner)
        )
    )
    ts = res.scalar()
    if ts is None:
        return None
    return int(ts.replace(tzinfo=timezone.utc).timestamp()) - 300


async def _run_bulk_message_sync(
    db: AsyncSession, job: SyncJob, jid_by_conv: Dict[int, str]
) -> None:
    """Bulk mesaj kanalindan sayfali hydrasyon.

    Bellek-ici (jid -> conv) haritasi + sohbet gruplu TEK dedup SELECT
    (wa_message_id) + gruplu INSERT + ~100'luk WS chunk olaylari. Kismi
    ilerleme commit'lenir — job yarida olse yazilanlar korunur (§20).
    """
    conv_by_jid: Dict[str, int] = {}
    for cid, jid_str in jid_by_conv.items():
        conv_by_jid[jid_str] = cid
    conv_by_id: Dict[int, Conversation] = {}
    # Faz 8 (N+1 kaldirma): dedup kumesi SAYFALAR ARASI onbelleklenir. Eski yol
    # her sayfada deginen sohbetlerin TAM wa_message_id listesini yeniden
    # SELECT'liyordu — 5 sayfa x 16k mesaj = ~42s. On bellekte, her sohbet yalnizca
    # ILK deginisinde bir kez yuklenir; bu job'in kendisinin ekledigi id'ler zaten
    # `have`'a eklendigi icin tutarlilik korunur.
    existing_ids: Dict[int, Set[str]] = {}
    dedup_loaded: Set[int] = set()

    # Faz 6 (P0.13 delta sync): GERCEK suuc — bu kullanicinin DB'sindeki en son
    # bilinen mesaj zamani (external_timestamp MAX). Varsa gateway'den yalnizca
    # (suuc - 5 dk overlap) sonrasi istenir; boylece reconnect sonrasi ayni
    # gecmis tekrar tekrar cekilmez. Overlap + wa_message_id dedup'u, sinirdaki
    # mesajlarin kaybolmasini onler. Ilk senkronda suuc yok → tam cekim.
    since_epoch = await _sync_watermark_epoch(db, job.user_id)

    offset = 0
    first_page = True
    while True:
        page = await gw.list_all_messages(
            limit=_SYNC_BULK_PAGE_SIZE,
            offset=offset,
            since=since_epoch,
            per_chat_limit=_SYNC_PER_CHAT_LIMIT,
        )
        msgs = page.get("messages", []) if isinstance(page, dict) else []
        total = int(page.get("total") or 0) if isinstance(page, dict) else 0
        if first_page:
            job.messages_total = total
            first_page = False
        if not msgs:
            break
        # jid -> conversation cozumu (yalnizca snapshot'taki sohbetler).
        pending: Dict[int, List[Dict[str, Any]]] = {}
        for gm in msgs:
            jid_str = str(gm.get("conversation_id") or "")
            cid = conv_by_jid.get(jid_str)
            if cid is None:
                continue
            pending.setdefault(cid, []).append(gm)
        # dedup: ilk temasda sohbet bazinda mevcut wa_message_id'leri toplu SELECT ile cek (§23).
        cid_list = [cid for cid in pending.keys() if cid not in dedup_loaded]
        for batch_start in range(0, len(cid_list), _SYNC_PERSIST_BATCH):
            sub = cid_list[batch_start:batch_start + _SYNC_PERSIST_BATCH]
            res = await db.execute(
                select(Message.conversation_id, Message.wa_message_id).where(
                    Message.conversation_id.in_(sub),
                    Message.wa_message_id.isnot(None),
                )
            )
            for cid, wa in res.all():
                existing_ids.setdefault(int(cid), set()).add(str(wa))
        dedup_loaded.update(pending.keys())
        rows: List[Tuple[Message, Dict[str, Any]]] = []  # (satır, jid_str) — serialization flush sonrası
        touched: Set[int] = set()
        for cid, gm_list in pending.items():
            conv = conv_by_id.get(cid)
            if conv is None:
                conv = await db.get(Conversation, cid)
                if conv is None:
                    continue
                conv_by_id[cid] = conv
            have = existing_ids.setdefault(cid, set())
            for gm in gm_list:
                wa = gm.get("wa_message_id")
                if wa and str(wa) in have:
                    continue
                row = _message_row_from_gateway(job.user_id, conv, gm)
                if row is None:
                    continue
                if wa:
                    have.add(str(wa))
                rows.append((row, str(gm.get("conversation_id") or "")))
                summary = build_last_message_summary(
                    message_type=row.message_type.value,
                    body=row.body,
                    sender_name=row.sender_name,
                    is_group="@g.us" in str(gm.get("conversation_id") or ""),
                    direction=row.direction.value,
                )
                _apply_last_message(conv, _parse_dt(gm.get("created_at")), summary)
            touched.add(cid)
        # persist: gruplu INSERT + commit (kismi ilerleme kalici).
        serialized: List[Dict[str, Any]] = []
        if rows:
            for batch_start in range(0, len(rows), _SYNC_PERSIST_BATCH):
                db.add_all([r for r, _ in rows[batch_start:batch_start + _SYNC_PERSIST_BATCH]])
            await db.flush()
            await db.commit()
            # flush sonrasi id'ler doludur — WS chunk'i sayisal DB kimlikli seridir.
            serialized = [_serialize_message(r) for r, _ in rows]
            job.messages_synced += len(rows)
        for chunk_start in range(0, len(serialized), _SYNC_EVENT_CHUNK):
            await _broadcast_sync_event(_sync_event(
                job, "whatsapp_sync_messages_chunk",
                conversation_ids=sorted(touched),
                messages=serialized[chunk_start:chunk_start + _SYNC_EVENT_CHUNK],
                total=job.messages_total,
                synced=job.messages_synced,
            ), job.user_id)
        await _broadcast_sync_event(_sync_event(
            job, "whatsapp_sync_progress",
            stage=job.stage,
            chats_total=job.chats_total, chats_synced=job.chats_synced,
            contacts_synced=job.contacts_synced,
            messages_total=job.messages_total, messages_synced=job.messages_synced,
        ), job.user_id)
        offset += len(msgs)
        if offset >= total:
            break
        if job.cancel_requested:
            raise asyncio.CancelledError()


# ---------------------------------------------------------------------------
# Gateway olaylarini veritabanina isleme (inbound)
# ---------------------------------------------------------------------------

# Faz 8 (§16): initial-sync sonrasi DB hydrate eden paylasilmis pipeline —
# owner bazinda in-flight dedupe (ayni kullanici icin ikinci bir hydration
# tetiklenmez; "Eşitle" butonu da ayni sync_conversations'i kullanir).
_initial_sync_inflight: Set[str] = set()


def _schedule_initial_sync(owner: str) -> None:
    if owner in _initial_sync_inflight:
        return
    _initial_sync_inflight.add(owner)
    asyncio.create_task(_run_initial_sync(owner))


async def _run_initial_sync(owner: str) -> None:
    # Faz 8 (§16) sozlesmesi korunur: initial-sync, "Eşitle" ile AYNI pipeline'i
    # kullanir — artik bu, WS tabanli chunked sync job'i (`request_sync`).
    # HTTP 502/timeout storm'u yerine agirlik arka planda `whatsapp_sync_*`
    # olaylariyla akitor; `conversations_updated` eski UI sozlesmesi olarak
    # tamamlanmada yayinlanmaya devam eder (§25 kirilmaz).
    try:
        async with AsyncSessionLocal() as db:
            job = await request_sync(db, owner)
            await asyncio.shield(job.done.wait())
        if job.state == "COMPLETED":
            logger.info("Initial-sync hydration tamamlandi (owner=%s)", owner)
            try:
                from backend.app.api.v1.websocket import ws_manager
                await ws_manager.broadcast({"event": "conversations_updated", "user_id": owner})
            except Exception as exc:  # noqa: BLE001 — broadcast basarisiz olssa bile DB gercegi yazar
                logger.warning("Initial-sync broadcast basarisiz (owner=%s): %s", owner, exc)
        else:
            logger.warning("Initial-sync hydration basarisiz (owner=%s): %s", owner, job.error)
    except Exception as exc:  # noqa: BLE001 — fail-soft: sonraki olay/Eşitle dener
        logger.warning("Initial-sync hydration beklenemedi (owner=%s): %s", owner, exc)
    finally:
        _initial_sync_inflight.discard(owner)


# Faz 13 (düzeltme — Render log regresyonu): Gateway'in bilerek KALICI
# YAZILMAYAN ama UI'a ULAŞMASI GEREKEN olayları. Bunlar DB'ye yazılmaz
# (kalıcı yan etkisi yoktur) fakat sahibi KESİN çözülmeden YAYINLANMAZ —
# aksi halde `ws_manager.broadcast` hedefsiz kalır ve olay diğer tenant'lara
# sızabilir (AGENTS.md §1.1).
#
# `history_sync_completed` (whatsapp-gateway/src/session-manager.js:1876)
# buradadır: telefonun geçmiş senkronu bittiğinde sohbet listesini ve seçili
# sohbetin mesajlarını tazelemek için frontend'e
# (frontend/src/pages/WhatsAppHubPage.tsx:1181) ulaşması ZORUNLUDUR.
# Bu olay daha önce "bilinmeyen olay" dalına düşüyor, ERROR olarak loglanıyor
# ve yayınlanmıyordu — UI geçmiş senkronu bitince tazelenmiyordu.
#
# NOT: `gateway_connected` (whatsapp-gateway/src/events.js:88) burada YOKTUR:
# o olay yalnızca gateway'e doğrudan bağlanan istemci soketlerine gönderilir,
# backend köprüsünden (`/ws/gateway`) HİÇ geçmez.
_PASSTHROUGH_EVENTS: FrozenSet[str] = frozenset({"history_sync_completed"})


async def _passthrough_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    """Kalıcı yazılmayan, yalnızca UI'a yönlendirilen gateway olayı.

    `gateway_session_id` ZORUNLUDUR: sahip bu kimlikten KESİN çözülür. Eksikse
    olay `_skip_event` ile işaretlenir ve yayınlanmaz — "tek bağlı oturum"
    tahminine düşülmez, çünkü bu olayın DB'ye yazılacak bir yan etkisi
    olmadığından sahipsiz yayınlanması yalnızca gereksiz sızıntı riski taşır.
    """
    gw_session_id = event.get("gateway_session_id")
    if not gw_session_id:
        return _skip_event(event, "passthrough: gateway_session_id yok")
    owner = await _resolve_event_owner(db, "", str(gw_session_id))
    event["user_id"] = owner
    return event


def _skip_event(event: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """Kalici yazilmayacak olayi NEDENIYLE isaretle (sessiz yutma yok).

    Dondurulen olay `_skip` tasir; `ingest_gateway_event` sinirinda bu olay
    UI'a YAYINLANMAZ ama debug seviyesinde loglanir. Boylece "bu olay neden
    yayinlanmadi" sorusu her zaman cevaplanabilir kalir — ne sessizce
    yutulur ne de sahte/eksik veri olarak disari cikar (AGENTS.md §1.1).
    """
    logger.debug("Gateway olayi kalici yazilmadi (%s)", reason)
    event["_skip"] = reason
    return event


async def ingest_gateway_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Gateway olayini persist eder ve UI broadcast'i icin kimlikleri cevirir.

    - `message_new`: inbound/outbound mesaji contact/conversation/messages'a
      yazar; `conversation_id` jid'den backend sayisal id'sine cevrilir.
    - `session_*`: `session_id` (gateway UUID) backend oturum id'sine cevrilir.
    - `conversation_*`: conversation kimligi sayisallastirilir.

    Dönüş sözleşmesi (Faz 13 — fail-closed): yayınlanabilir olay, tenant
    `user_id`'si KESİN olarak eklenmiş halde döner. `None` dönerse çağıran
    olayı **YAYINLAMAMALIDIR**. Böylece hiçbir koşulda persist edilmemiş ya da
    sahibi belirsiz bir olay UI'a çıkmaz (AGENTS.md §1.1 — sahte veri yok,
    sessiz hata yutma yok).
    """
    async with AsyncSessionLocal() as db:
        evt = event.get("event") or event.get("event_type") or ""
        try:
            if evt == "message_new":
                result = await _ingest_message(db, event)
            elif evt in ("conversation_updated", "conversation_read", "message_status_updated", "presence_updated"):
                result = await _map_conversation_event(db, event)
            elif evt == "contact_synced":
                result = await _ingest_contact_synced(db, event)
            elif evt == "connection_error" or str(evt).startswith("session_"):
                result = await _map_session_event(db, event)
            elif evt in _PASSTHROUGH_EVENTS:
                # Faz 13 (düzeltme): bilerek persist EDİLMEYEN ama UI'a
                # ulaşması gereken olaylar (bkz. _PASSTHROUGH_EVENTS).
                result = await _passthrough_event(db, event)
            else:
                # Gerçekten bilinmeyen olay: gateway ile backend sözleşmesi
                # kaymış demektir. Sessizce yutulmaz — fail-closed: yayınlanmaz.
                logger.error("Bilinmeyen gateway olayi yayinlanmadi (event=%s)", evt)
                return None

            # Sinir kontrolu: sahibi cozulemeyen olay DISARI CIKMAZ.
            if not isinstance(result, dict):
                logger.error("Gateway olayi sozluk degil, yayinlanmadi (event=%s)", evt)
                return None
            if result.get("_skip"):
                # Helper bilerek atladi (dejenere JID / eksik kimlik) — beklenen
                # durum, debug seviyesinde zaten loglandi. Sessiz yutma degil.
                return None
            if not result.get("user_id"):
                logger.error(
                    "Gateway olayi sahipsiz (event=%s, gateway_session_id=%s) — yayinlanmadi",
                    evt, event.get("gateway_session_id"),
                )
                return None

            await db.commit()
            # Faz 8 (§16, RC-5): initial sync TAMAMLANDIĞINDA backend DB'si de
            # ayni paylasilmis hattan (sync_conversations) hydrate edilir —
            # QR -> AUTHENTICATED -> INITIAL SYNC -> READY zinciri tek pipeline
            # ile calisir; "Eşitle" (manuel) ile initial sync AYNI kodu kullanir.
            if evt == "session_sync_completed":
                owner = result.get("user_id")
                if owner and owner != SYSTEM_USER_ID:
                    _schedule_initial_sync(str(owner))
            return result
        except EventOwnerUnresolved as exc:
            # Beklenen fail-closed durumu: olay yanlis tenant'a YAZILMAZ ve
            # UI'a YAYINLANMAZ. Hata seviyesinde loglanir (sessiz yutma yok).
            await db.rollback()
            logger.error("Gateway olayi sahibi cozulemedi, atlandi (event=%s): %s", evt, exc)
            return None
        except Exception as exc:
            await db.rollback()
            logger.exception("Gateway olayi islenemedi, yayinlanmadi (event=%s): %s", evt, exc)
            return None


async def _ingest_message(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    msg = event.get("message") or {}
    jid = msg.get("conversation_id") or event.get("conversation_id")
    if not jid or "@" not in str(jid):
        return _skip_event(event, "message_new: gecerli jid yok")
    jid_str = str(jid)
    # Faz 9 (§5): dejenere JID mesajları (`0@s.whatsapp.net`) kalıcılaştırılmaz.
    if is_degenerate_jid(jid_str):
        return _skip_event(event, f"message_new: dejenere jid ({jid_str})")
    # MVP: gateway tenant'i bilmiyor; kayitli oturumun sahibine, yoksa system'e baglan.
    # Faz 13 (tenant izolasyonu): gateway artik her olayda `gateway_session_id`
    # (gateway UUID) tasiyor — sahip KESIN olarak cozulur, tahmin edilmez.
    # Cozulemezse `EventOwnerUnresolved` yukselir ve olay hic islenmez.
    owner = await _resolve_event_owner(db, jid_str, event.get("gateway_session_id"))
    # Faz 13 (fail-closed sinir kontrolu): cozulen sahip olaya YAZILIR. Aksi
    # halde `ingest_gateway_event` sonundaki "sahipsiz olay yayinlanmaz"
    # kontrolu bu mesaji reddeder ve gercek mesajlar UI'a hic ulasmaz.
    event["user_id"] = owner
    conv = await _ensure_conversation(db, owner, jid_str)
    # Faz 10 (P1, RC-4): GRUP sohbetlerinde mesajin gonderen adi (pushName —
    # ör. bir üyenin "Ahmet"ı) GRUP contact'ine ASLA yazilmaz; grup adi
    # yalnizca group_subject metadata'sindan guncellenir. (1:1'de mevcut
    # davranis korunur: kisi adini mesajla tasiyabiliriz.)
    # Faz 10 (P3): GIDEN mesajlarda sender_name 'ME'dir — kisi adi OLAMAZ
    # (telefondan gonderilen mesajlar artik messages.upsert ile de akıyor).
    is_group_jid = "@g.us" in jid_str
    msg_direction = (
        MessageDirection.INBOUND
        if str(msg.get("direction", "INBOUND")).upper() == "INBOUND"
        else MessageDirection.OUTBOUND
    )
    name_for_contact = None if (is_group_jid or msg_direction == MessageDirection.OUTBOUND) else msg.get("sender_name")
    source_for_contact = None if (is_group_jid or msg_direction == MessageDirection.OUTBOUND) else msg.get("sender_name_source")
    contact = await _upsert_contact(db, owner, jid_str, name_for_contact, source_for_contact)

    wa_id = msg.get("wa_message_id")
    if wa_id:
        existing = await db.execute(
            select(Message).where(Message.wa_message_id == wa_id, Message.conversation_id == conv.id)
        )
        if existing.scalars().first() is not None:
            event["conversation_id"] = conv.id
            return event  # dedup

    mtype_str = (msg.get("message_type") or "TEXT").upper()
    try:
        mtype = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.TEXT
    except Exception:
        mtype = MessageType.TEXT
    direction = msg_direction

    body = msg.get("body") or ""
    row = Message(
        user_id=owner,
        conversation_id=conv.id,
        direction=direction,
        message_type=mtype,
        body=body[:4000] if body else None,
        media_id=msg.get("media_id"),
        media_mime_type=msg.get("media_mime_type"),
        media_filename=msg.get("media_filename"),
        media_caption=msg.get("media_caption"),
        wa_message_id=wa_id,
        client_message_id=msg.get("client_message_id"),
        sender_phone=msg.get("sender_phone") or jid_to_phone(jid_str) or "unknown",
        # Faz 6a: grup mesajlarinda balon ustunde gercek gonderen adi gorunur
        # (WhatsApp Web paritesi); 1:1 sohbetlerde sohbet/kisi adi kalir.
        # Faz 10 (P1): grup mesajinda fallback ASLA grup contact adidir —
        # katilimci cozulemiyorsa ad None kalir (preview one eki de atlanir).
        # Faz 10 (P3): GIDEN mesajlarda gonderen her zaman 'ME'dir (history
        # senkronundaki `_historyMessageToRecord` ile ayni sozlesme) — kisi
        # adi one cikmaz.
        sender_name=(
            "ME"
            if direction == MessageDirection.OUTBOUND
            else (msg.get("participant_name") or (None if is_group_jid else contact.display_name))
        ),
        recipient_phone=msg.get("recipient_phone") or "ME" if direction == MessageDirection.INBOUND else contact.phone_e164,
        status=ConversationMessageStatus.RECEIVED if direction == MessageDirection.INBOUND else ConversationMessageStatus.SENT,
        # Prod fix (render log): asyncpg aware datetime'i naive kolona yazmayi
        # reddediyor ("can't subtract offset-naive and offset-aware") — tıpkı
        # _persist_gateway_message gibi _as_naive_utc ile normalize edilir.
        external_timestamp=_as_naive_utc(_parse_dt(msg.get("created_at"))),
    )
    db.add(row)
    # Faz 10 (P2): paylasilan kural — gercek mesaj zaman damgasiyla, tip
    # etiketi ve grup gonderen on eki uretilir; utcnow() uzerinden yazilmaz.
    summary = build_last_message_summary(
        message_type=mtype_str,
        body=body,
        sender_name=row.sender_name,
        is_group=is_group_jid,
        direction=direction.value,
    )
    _apply_last_message(conv, _as_naive_utc(_parse_dt(msg.get("created_at"))) or datetime.utcnow(), summary)
    if direction == MessageDirection.INBOUND:
        conv.unread_count = (conv.unread_count or 0) + 1
    await db.flush()
    await db.refresh(row)

    event["conversation_id"] = conv.id
    event["message"] = _serialize_message(row)
    return event


# Sentinel user_id for events that arrive before any session is connected.
# Must be a valid UUID string since user_id columns are Uuid(as_uuid=False).
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"


class EventOwnerUnresolved(Exception):
    """Gateway olayinin hangi tenant'a ait oldugu KESIN olarak belirlenemedi.

    Fail-closed: bu durumda olay ne DB'ye yazilir ne de UI'a yayilir. Onceki
    davranis (rastgele bir CONNECTED oturumu secmek; hata durumunda
    `except Exception: pass` ile SYSTEM_USER_ID'ye dusmek) veriyi yanlis
    tenant'a yaziyor ve mesaj/telefon verisini diger tenant'lara sizdiriyordu.
    Ayrica `scalar_one_or_none()` iki oturum varken MultipleResultsFound
    firlatiyor, bu hata yutuluyor ve TUM olaylar sistem tenant'ina yaziliyordu.
    """


async def _resolve_event_owner(
    db: AsyncSession, jid: str, gw_session_id: Optional[str] = None
) -> str:
    """Gateway olayinin sahibi (tenant user_id) — KESIN cozum, tahmin yok.

    1) Tercih edilen yol: olay `session_id` (gateway UUID) tasiyorsa sahibi
       `whatsapp_sessions.gateway_id` uzerinden birebir bulunur.
    2) Geriye donuk uyum: `session_id` gondermeyen eski gateway surumu icin,
       YALNIZCA tek bir bagli oturum varsa sahibi belirsiz degildir.
       Birden fazla tenant bagliysa cozum imkansizdir -> hata (tahmin yok).

    `jid` yalnizca teshis/log icin tasinir.
    """
    if gw_session_id:
        owner = await db.scalar(
            select(WhatsAppSession.user_id).where(
                WhatsAppSession.gateway_id == str(gw_session_id)
            )
        )
        if owner:
            return str(owner)
        raise EventOwnerUnresolved(
            f"Bilinmeyen gateway oturumu (session_id={gw_session_id}, jid={jid})"
        )

    rows = (
        await db.execute(
            select(WhatsAppSession.user_id).where(
                WhatsAppSession.status == SessionStatus.CONNECTED
            )
        )
    ).all()
    owners = {str(r[0]) for r in rows if r[0]}
    if len(owners) == 1:
        return next(iter(owners))
    raise EventOwnerUnresolved(
        "Olay session_id tasimiyor ve sahibi tek anlamli degil "
        f"(bagli tenant sayisi={len(owners)}, jid={jid})"
    )


async def _ingest_contact_synced(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    """Gateway `contact_synced` olayi: kisi adi/avatar'ini DB'ye kalici yaz.

    Faz 8 (§15, RC-1): yüksek rütbeli GERÇEK ad (addressbook/verified/
    group_subject) taşıyan olay için satir YOKSA oluşturulur — böylece
    hiç sohbeti olmayan rehber kişileri de kalıcı olur ve "Eşitle" sonrası
    adlar kaybolmaz. Düşük rütbeli (push) pushName güncellemeleri eski
    davranışta olduğu gibi yalnızca mevcut satırı günceller (şişirme yok).
    """
    contact_payload = event.get("contact") or {}
    jid = contact_payload.get("id") or contact_payload.get("jid")
    if not jid or "@" not in str(jid):
        return _skip_event(event, "contact_synced: gecerli jid yok")
    # Faz 9 (§5): dejenere JID kişileri (`0@s.whatsapp.net` → '+0') DB'ye yazılmaz.
    if is_degenerate_jid(str(jid)):
        return _skip_event(event, f"contact_synced: dejenere jid ({jid})")
    phone_e164 = jid_to_phone(str(jid)) or f"jid:{jid}"
    owner = await _resolve_event_owner(db, str(jid), event.get("gateway_session_id"))
    event["user_id"] = owner  # Faz 13: cozulen sahip olaya yazilir (yayin sinir kontrolu)
    res = await db.execute(
        select(Contact).where(
            Contact.phone_e164 == phone_e164,
            get_user_filter(Contact.user_id, owner),
        )
    )
    # Prod fix (render log): ayni telefonda mükerrer contact satiri varsa
    # scalar_one_or_none() "Multiple rows were found" ile ingest'i kırıyordu;
    # ilk satiri al — guncelleme idempotent.
    contact = res.scalars().first()
    name = contact_payload.get("name")
    source = str(contact_payload.get("name_source") or "")
    if contact is None:
        # Yalnızca gerçek rehber/metadata adıyla oluştur; ham jid/lid veya
        # telefonsuz düşük rütbeli olaylar satır şişirmez.
        high_rank = source in ("addressbook", "verified", "group_subject")
        if high_rank and name and not _is_raw_jid_name(name):
            contact = await _upsert_contact(db, owner, str(jid), name, source)
            _set_contact_avatar(contact, contact_payload.get("avatar_url"))
            await db.commit()
        return event
    _set_contact_name(contact, name, source)
    _set_contact_avatar(contact, contact_payload.get("avatar_url"))
    await db.commit()
    return event


async def _map_conversation_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    jid = event.get("conversation_id")
    if not jid or "@" not in str(jid):
        # Gateway `conversation_updated` olayini ust seviye id olmadan
        # yayarlar (chats.update / history sync); jid'yi conversation nesnesinden
        # topla.
        conv_payload = event.get("conversation") or {}
        candidate = conv_payload.get("id") or conv_payload.get("jid")
        if candidate and "@" in str(candidate):
            jid = candidate
        else:
            return _skip_event(event, f"{event.get('event')}: sohbet jid'i cozulemedi")
    # Faz 9 (§5): dejenere JID sohbetleri (`0@s.whatsapp.net`) DB'ye yazilmaz.
    if is_degenerate_jid(str(jid)):
        return _skip_event(event, f"{event.get('event')}: dejenere jid ({jid})")
    owner = await _resolve_event_owner(db, str(jid), event.get("gateway_session_id"))
    event["user_id"] = owner  # Faz 13: cozulen sahip olaya yazilir (yayin sinir kontrolu)
    conv = await _ensure_conversation(db, owner, str(jid))
    event["conversation_id"] = conv.id
    if event.get("event") == "presence_updated":
        # Baileys presence: composing / paused / available / recording ...
        presence = str(event.get("presence") or "").lower()
        event["typing"] = presence in ("composing", "recording")
        return event
    if event.get("event") == "conversation_updated":
        # Faz 4: history sync / chats.update alanlarini DB'ye kalici yaz.
        payload = event.get("conversation") or {}
        # Sorun 4: grup bayragi her olayda JID'den garanti edilir; arsiv
        # durumu yalnizca gateway GERCEK alan gonderdiyse yazilir (eski
        # gateway payload'inda `archived` yok → mevcut deger korunur,
        # varsayimla sifirlanmaz).
        conv.is_group = bool(payload.get("is_group")) or "@g.us" in str(jid)
        if "archived" in payload:
            conv.is_archived = bool(payload.get("archived"))
        name = payload.get("name")
        if name or payload.get("avatar_url"):
            contact = await _upsert_contact(db, owner, str(jid), None)
            _set_contact_name(contact, name, payload.get("name_source"))
            # Faz 5: grup/profil sohbet avatarunu kalici yaz.
            _set_contact_avatar(contact, payload.get("avatar_url"))
            await db.flush()
        preview = payload.get("last_message_preview")
        # Faz 10 (P2): gecikmeli gateway metadata/ozet olayinda da paylasilan
        # kural — bos/eksik preview mevcut ozeti silmez, eski zaman damgali
        # deger daha yeni ozetin uzerine yazmaz, '[IMAGE]' etiketlere
        # normalize edilir.
        if preview:
            gw_ts = _as_naive_utc(_parse_dt(payload.get("last_message_at")))
            summary = _normalize_preview_text(payload.get("message_type"), str(preview))
            if summary:
                if conv.last_message_at is None or not conv.last_message_preview:
                    _apply_last_message(conv, None, summary)
                    if gw_ts and (conv.last_message_at is None or gw_ts > conv.last_message_at):
                        conv.last_message_at = gw_ts
                else:
                    _apply_last_message(conv, gw_ts, summary)
        last_at = _as_naive_utc(_parse_dt(payload.get("last_message_at")))
        if last_at and (conv.last_message_at is None or last_at > conv.last_message_at):
            conv.last_message_at = last_at
        try:
            if payload.get("unread_count") is not None:
                conv.unread_count = max(conv.unread_count or 0, int(payload["unread_count"]))
        except Exception:
            pass
        await db.commit()
        # Faz 6 (P0.4 / PHASE-28): history sync sirasinda gelen her
        # conversation_updated DB'ye yazildiktan sonra frontend'e "sozlesme
        # listende yeni veri var, gel al" sinyali verilir (2 sn'de bir,
        # throttle'li). Frontend bu sinyalle GET /conversations'i tetikler —
        # UI, job'un chats_snapshot'unu (T+~44s) BEKLEMEZ, canli akistaki
        # sohbetleri saniyeler icinde gorur.
        if owner != SYSTEM_USER_ID:
            _schedule_chats_bootstrap(owner)
        return event
    if event.get("event") == "conversation_read":
        conv.unread_count = 0
        await db.commit()
    elif event.get("event") == "message_status_updated":
        # Outbound ack (✓ / ✓✓ / mavi ✓✓) → persist on the matching message.
        wa_id = event.get("wa_message_id")
        new_status = (event.get("status") or "").upper()
        if wa_id and new_status in ConversationMessageStatus.__members__:
            res = await db.execute(
                select(Message).where(
                    Message.wa_message_id == wa_id,
                    Message.conversation_id == conv.id,
                )
            )
            row = res.scalars().first()
            if row is not None:
                target = ConversationMessageStatus[new_status]
                rank = {
                    ConversationMessageStatus.PENDING: 0,
                    ConversationMessageStatus.SENT: 1,
                    ConversationMessageStatus.DELIVERED: 2,
                    ConversationMessageStatus.READ: 3,
                    ConversationMessageStatus.RECEIVED: 3,
                    ConversationMessageStatus.FAILED: 4,
                }
                cur_rank = rank.get(row.status, 0)
                new_rank = rank.get(target, 0)
                # Acks only move forward; never downgrade an existing status.
                if new_rank > cur_rank:
                    row.status = target
                    if target == ConversationMessageStatus.READ:
                        row.delivered_at = row.delivered_at or datetime.utcnow()
                        row.read_at = datetime.utcnow()
                    elif target == ConversationMessageStatus.DELIVERED:
                        row.delivered_at = row.delivered_at or datetime.utcnow()
                    await db.commit()
                    event["message_id"] = row.id
    return event


async def _map_session_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    gw_session_id = event.get("session_id")
    if not gw_session_id:
        return _skip_event(event, "session_*: session_id yok")
    evt = event.get("event") or event.get("event_type") or ""
    res = await db.execute(select(WhatsAppSession).where(WhatsAppSession.gateway_id == str(gw_session_id)))
    row = res.scalar_one_or_none()
    if row:
        event["session_id"] = row.id
        event["session_name"] = event.get("session_name") or row.session_name
        event["user_id"] = str(row.user_id) if row.user_id else None
        # Kalici hata yuzeyi: gateway'in gercek baglanti hatasini DB'ye yaz.
        err = event.get("error") or event.get("error_message")
        if evt == "connection_error" and err:
            row.error_message = str(err)[:1000]
            row.status = SessionStatus.DISCONNECTED
            row.is_phone_online = False
            row.updated_at = datetime.utcnow()
        elif evt in ("session_connected", "session_qr_updated"):
            row.error_message = None
    return event