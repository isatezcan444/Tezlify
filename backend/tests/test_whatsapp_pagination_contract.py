"""Gateway <-> backend sayfalama SÖZLEŞMESİ (AŞAMA 4.7/4.8).

NEDEN BU DOSYA VAR
------------------
`test_whatsapp_memory_persistence*.py` dosyalarındaki sahte gateway'ler
`pagination` anahtarını HİÇ döndürmüyor. Bu yüzden mevcut testlerin tamamı
backend'in **eski (offset) yolundan** geçiyor ve yeni `seq` yolu fiilen
test edilmiyordu. "Paket yeşil" demek "yeni sözleşme çalışıyor" demek değildi.

Bu dosya iki gateway kuşağının GERÇEK yanıt biçimlerini birebir kodlar ve
ikisini de aynı tüketiciden (`drain_gateway_memory_once`) geçirir:

1. **Eski gateway** (`cbe4f509` ve öncesi, üretimde ÇALIŞAN sürüm).
   `session-manager.js::listAllMessages` offset modunda döner:
       { messages, total, offset, limit, reached_end }
   `pagination` anahtarı YOKTUR. `afterSeq`/`seqEpoch` parametreleri
   bilinmeyen query parametresi olarak sessizce yok sayılır.

2. **Yeni gateway** (4.7, henüz dağıtılmadı). `afterSeq` verildiğinde:
       { messages, total, offset: 0, limit, pagination: 'seq', seq_epoch,
         max_seq, after_seq, next_after_seq, reached_end, epoch_reset,
         eligible_total }
   `afterSeq` verilmediğinde ise offset moduna döner ama artık modu
   AÇIKÇA bildirir: `pagination: 'offset'`.

Kritik nokta: dağıtım sırası backend-only olacağı için **yeni backend eski
gateway ile konuşacak**. Bu yüzden "eski gateway uyumluluğu" teorik değil,
gerçek dağıtım kombinasyonudur.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp import memory_persistence as mp

# Bu dosyaya özel kiracı — diğer test dosyalarının verisiyle çakışmasın.
U5 = "55555555-5555-5555-5555-555555555555"
U5_HEX = U5.replace("-", "")


def jid_of(tag: str) -> str:
    return f"9055{tag}@s.whatsapp.net"


@pytest.fixture(autouse=True)
def _enable_memory_persistence(monkeypatch):
    """Süpürme varsayılan olarak KAPALI; burada davranışı test ediyoruz."""
    monkeypatch.setattr(
        settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", True, raising=False
    )


@pytest_asyncio.fixture(autouse=True)
async def _clean_state():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": U5_HEX}
                )
            await db.commit()

    mp.reset_memory_persistence_state()
    await _wipe()
    yield
    await _wipe()
    mp.reset_memory_persistence_state()


async def make_line(gateway_id: str) -> int:
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=U5,
            gateway_id=gateway_id,
            session_name=f"s-{gateway_id[:8]}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return int(row.id)


async def make_conversation(jid: str, session_db_id: Optional[int]) -> int:
    async with AsyncSessionLocal() as db:
        contact = Contact(
            user_id=U5,
            phone_e164=(
                f"+{jid.split('@')[0]}"
                if "@s.whatsapp.net" in jid
                else f"jid:{jid}"
            ),
            display_name="Sozlesme Kisi",
        )
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=U5,
            contact_id=contact.id,
            channel="WHATSAPP",
            session_id=session_db_id,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        return int(conv.id)


def gw_msg(jid: str, wa_id: str, at: datetime) -> Dict[str, Any]:
    return {
        "id": int(at.timestamp() * 1000),
        "conversation_id": jid,
        "direction": "INBOUND",
        "message_type": "TEXT",
        "body": f"govde-{wa_id}",
        "status": "RECEIVED",
        "created_at": at.isoformat().replace("+00:00", "Z"),
        "timestamp_s": int(at.timestamp()),
        "sender_phone": "+905551112233",
        "recipient_name": "ME",
        "wa_message_id": wa_id,
        "reactions": [],
    }


# ---------------------------------------------------------------------------
# Gerçek gateway yanıt biçimleri — birebir
# ---------------------------------------------------------------------------
def legacy_offset_response(messages, total, offset, limit) -> Dict[str, Any]:
    """`cbe4f509:session-manager.js` offset dalı. `pagination` YOK."""
    return {
        "messages": messages,
        "total": total,
        "offset": offset,
        "limit": limit,
        "reached_end": offset + limit >= total,
    }


def new_offset_response(messages, total, offset, limit) -> Dict[str, Any]:
    """4.7 offset dalı — modu artık AÇIKÇA bildirir."""
    return {
        "messages": messages,
        "total": total,
        "offset": offset,
        "limit": limit,
        "pagination": "offset",
        "reached_end": offset + limit >= total,
    }


def new_seq_response(
    messages, total, limit, epoch, after, next_after, *, epoch_reset=False, eligible_total=None
) -> Dict[str, Any]:
    """4.7 seq dalı — `session-manager.js` seq bloğunun birebir kopyası."""
    return {
        "messages": messages,
        "total": total,
        "offset": 0,
        "limit": limit,
        "pagination": "seq",
        "seq_epoch": epoch,
        "max_seq": max([m.get("_seq", 0) for m in messages], default=0),
        "after_seq": after,
        "next_after_seq": next_after,
        "reached_end": len(messages) < limit,
        "epoch_reset": epoch_reset,
        "eligible_total": (
            len(messages) if eligible_total is None else eligible_total
        ),
    }


class SeqGateway:
    """4.7 gateway: `afterSeq` verilirse seq, verilmezse offset."""

    def __init__(self, items: List[Dict[str, Any]], epoch: str = "ep-1"):
        # items: [{"msg": <gateway message>, "seq": int}] — seq ekleme anında atanır.
        self.items = items
        self.epoch = epoch
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, _gateway_id, limit=1000, offset=0, since=None,
                 per_chat_limit=None, jids=None, after_seq=None,
                 seq_epoch=None, **_kw):
        self.calls.append(
            {"offset": offset, "after_seq": after_seq, "seq_epoch": seq_epoch}
        )
        total = len(self.items)
        if after_seq is not None:
            epoch_reset = bool(seq_epoch) and str(seq_epoch) != str(self.epoch)
            after = 0 if epoch_reset else max(0, int(after_seq))
            eligible = [it for it in self.items if it["seq"] > after]
            page = eligible[: int(limit)]
            last = page[-1]["seq"] if page else None
            next_after = after if last is None else last
            return new_seq_response(
                [dict(it["msg"], _seq=it["seq"]) for it in page],
                total,
                int(limit),
                self.epoch,
                after,
                next_after,
                epoch_reset=epoch_reset,
                eligible_total=len(eligible),
            )
        page = self.items[offset: offset + int(limit)]
        return new_offset_response(
            [it["msg"] for it in page], total, offset, int(limit)
        )


class LegacyGateway:
    """`cbe4f509` gateway: `afterSeq`'i YOK SAYAR, offset döner, mod bildirmez."""

    def __init__(self, messages: List[Dict[str, Any]]):
        self.messages = messages
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, _gateway_id, limit=1000, offset=0, since=None,
                 per_chat_limit=None, jids=None, after_seq=None,
                 seq_epoch=None, **_kw):
        self.calls.append(
            {"offset": offset, "after_seq": after_seq, "seq_epoch": seq_epoch}
        )
        total = len(self.messages)
        page = self.messages[offset: offset + int(limit)]
        return legacy_offset_response(page, total, offset, int(limit))


async def drain(
    gateway,
    gateway_id: str,
    *,
    session_db_id: Optional[int] = None,
    page_size: int = 500,
    max_pages: int = 20,
    start_offset: int = 0,
    start_after_seq: int = 0,
    start_epoch: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=gateway):
            return await mp.drain_gateway_memory_once(
                db,
                user_id=U5,
                gateway_id=gateway_id,
                session_db_id=session_db_id,
                page_size=page_size,
                max_pages=max_pages,
                per_chat_limit=2000,
                dry_run=dry_run,
                start_offset=start_offset,
                start_after_seq=start_after_seq,
                start_epoch=start_epoch,
            )


async def ids_of(conv_id: int) -> List[str]:
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Message.wa_message_id).where(Message.conversation_id == conv_id)
        )
        return sorted(str(r[0]) for r in res.all())


BASE = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# C1 — Yeni sözleşme: seq yanıtı doğru parse edilir, imleç DEĞER olarak ilerler
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_new_gateway_seq_response_is_parsed_and_cursor_advances_by_value():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700001")
    conv = await make_conversation(jid, sid)

    items = [
        {"msg": gw_msg(jid, f"S{i}", BASE + timedelta(minutes=i)), "seq": i + 1}
        for i in range(5)
    ]
    gateway = SeqGateway(items)

    first = await drain(gateway, gw_id, session_db_id=sid, page_size=2, max_pages=10)

    assert first.get("error") is None, first
    assert first["pagination_mode"] == "seq"
    assert first["inserted"] == 5
    assert first["seq_epoch"] == "ep-1"
    assert first["next_after_seq"] == 0, "tur sonuna ulasildi -> imlec 0"
    assert await ids_of(conv) == ["S0", "S1", "S2", "S3", "S4"]
    # Her cagride seq parametresi gonderilmis olmali (offset degil).
    assert all(c["after_seq"] is not None for c in gateway.calls)


# ---------------------------------------------------------------------------
# C2/D — Eski gateway: `pagination` yok -> offset'e duser, HATA VERMEZ
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_legacy_gateway_without_pagination_falls_back_to_offset():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700002")
    conv = await make_conversation(jid, sid)

    messages = [
        gw_msg(jid, f"L{i}", BASE + timedelta(minutes=i)) for i in range(4)
    ]
    gateway = LegacyGateway(messages)

    stats = await drain(gateway, gw_id, session_db_id=sid, page_size=2, max_pages=10)

    assert stats.get("error") is None, stats
    assert stats["pagination_mode"] == "offset", "eski gateway offset moduna dusmeli"
    assert stats["inserted"] == 4
    assert await ids_of(conv) == ["L0", "L1", "L2", "L3"]


# ---------------------------------------------------------------------------
# C3 — Offset'e duserken imleç SIFIRLANMAZ (yeniden başlama noktası korunur)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_offset_fallback_preserves_the_starting_cursor():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700003")
    await make_conversation(jid, sid)

    messages = [
        gw_msg(jid, f"F{i}", BASE + timedelta(minutes=i)) for i in range(10)
    ]
    gateway = LegacyGateway(messages)

    stats = await drain(
        gateway, gw_id, session_db_id=sid, page_size=2, max_pages=1, start_offset=4
    )

    assert stats["pagination_mode"] == "offset"
    # Ilk (ve tek) cagri 4'ten baslamali; 0'dan baslarsa imlec sifirlanmis olur.
    assert gateway.calls[0]["offset"] == 4, gateway.calls
    assert stats["next_offset"] == 6


# ---------------------------------------------------------------------------
# C5 — Epoch degisimi guvenli yeniden taramaya donusur
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_epoch_change_triggers_a_safe_rescan_and_is_counted():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700004")
    conv = await make_conversation(jid, sid)

    # Gateway yeniden basladi: seq numaralari 1'den basliyor, epoch degisti.
    items = [
        {"msg": gw_msg(jid, f"E{i}", BASE + timedelta(minutes=i)), "seq": i + 1}
        for i in range(3)
    ]
    gateway = SeqGateway(items, epoch="ep-2")

    before = int(mp._STATE.get("epoch_resets_total") or 0)
    stats = await drain(
        gateway,
        gw_id,
        session_db_id=sid,
        page_size=10,
        max_pages=5,
        start_after_seq=99,       # eski epoch'in imleci
        start_epoch="ep-1",       # eski epoch
    )

    assert stats["epoch_reset"] is True, stats
    assert stats["seq_epoch"] == "ep-2"
    assert int(mp._STATE["epoch_resets_total"]) == before + 1
    # Imlec 0'a cekildi -> eski imlecin gerisinde kalan kayitlar ATLANMADI.
    assert stats["inserted"] == 3
    assert await ids_of(conv) == ["E0", "E1", "E2"]


# ---------------------------------------------------------------------------
# C6 — FRONT-TRIM: offset atlar, seq ATLAMAZ (asıl kanıt)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_front_trim_skips_messages_in_offset_mode():
    """Eski davranış: RAM'in başından eviction offset'i kaydırır, kayıt atlanır."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700005")
    conv = await make_conversation(jid, sid)

    msgs = [gw_msg(jid, f"T{i}", BASE + timedelta(minutes=i)) for i in range(6)]
    gateway = LegacyGateway(msgs)

    first = await drain(gateway, gw_id, session_db_id=sid, page_size=3, max_pages=1)
    assert first["inserted"] == 3
    assert first["next_offset"] == 3

    # Front-trim: en eski 2 mesaj RAM'den atildi (sohbet basi 2000 siniri).
    gateway.messages = msgs[2:]

    await drain(
        gateway,
        gw_id,
        session_db_id=sid,
        page_size=3,
        max_pages=5,
        start_offset=first["next_offset"],
    )

    got = await ids_of(conv)
    # Ilk tur T0,T1,T2 yazdi; trim sonrasi offset 3 -> [T2,T3,T4,T5][3:] = [T5].
    assert got == ["T0", "T1", "T2", "T5"], (
        f"offset modu trim sonrasi T3,T4'u ATLAMALIYDI (got={got})"
    )
    # Kanit: T3 ve T4 hicbir turda yazilmadi -> sessiz kayip.
    assert "T3" not in got
    assert "T4" not in got


@pytest.mark.asyncio
async def test_front_trim_does_not_skip_messages_in_seq_mode():
    """Yeni davranış: `afterSeq` bir DEĞER, eviction onu kaydıramaz."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700006")
    conv = await make_conversation(jid, sid)

    msgs = [gw_msg(jid, f"Q{i}", BASE + timedelta(minutes=i)) for i in range(6)]
    items = [{"msg": m, "seq": i + 1} for i, m in enumerate(msgs)]
    gateway = SeqGateway(items)

    first = await drain(gateway, gw_id, session_db_id=sid, page_size=3, max_pages=1)
    assert first["inserted"] == 3
    assert first["next_after_seq"] == 3

    # Ayni front-trim: ilk 2 kayit RAM'den atildi.
    gateway.items = items[2:]

    await drain(
        gateway,
        gw_id,
        session_db_id=sid,
        page_size=3,
        max_pages=5,
        start_after_seq=first["next_after_seq"],
        start_epoch=first["seq_epoch"],
    )

    assert await ids_of(conv) == ["Q0", "Q1", "Q2", "Q3", "Q4", "Q5"], (
        "seq modu eviction'a ragmen hicbir kaydi atlamamali"
    )


# ---------------------------------------------------------------------------
# C4 — Kilitlenen imleç SONSUZ DÖNGÜ değil, ölçülen bir hatadır
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stalled_seq_cursor_is_reported_instead_of_looping_forever():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700007")
    await make_conversation(jid, sid)

    calls = {"n": 0}

    def stuck(_gateway_id, limit=1000, offset=0, since=None, per_chat_limit=None,
              jids=None, after_seq=None, seq_epoch=None, **_kw):
        calls["n"] += 1
        # Sayfa dolu gorunuyor ama imlec ILERLEMIYOR: bozuk bir gateway.
        return new_seq_response(
            [gw_msg(jid, "Z0", BASE)], 1, int(limit), "ep-1", int(after_seq or 0),
            int(after_seq or 0),
        )

    stats = await drain(stuck, gw_id, session_db_id=sid, page_size=1, max_pages=50)

    assert stats["error"] == "PaginationStalled", stats
    assert calls["n"] == 1, "ilk sayfada durmali, 50 sayfa donmemeli"
    assert int(mp._STATE["stalled_pages_total"]) >= 1


# ---------------------------------------------------------------------------
# C7 — seq modunda `next_after_seq` yoksa bu bir sözleşme ihlalidir
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_missing_next_after_seq_is_a_contract_error():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("700008")
    await make_conversation(jid, sid)

    def broken(_gateway_id, limit=1000, offset=0, since=None, per_chat_limit=None,
               jids=None, after_seq=None, seq_epoch=None, **_kw):
        resp = new_seq_response(
            [gw_msg(jid, "N0", BASE)], 1, int(limit), "ep-1", 0, 1
        )
        resp.pop("next_after_seq")
        return resp

    stats = await drain(broken, gw_id, session_db_id=sid, page_size=10, max_pages=3)
    assert stats["error"] == "MissingNextAfterSeq", stats


# ---------------------------------------------------------------------------
# §3 güvenlik: /health ve /metrics gateway UUID'si sızdırmamalı
# ---------------------------------------------------------------------------
def test_health_payload_never_leaks_a_gateway_uuid():
    """`last_error_page_key` gateway UUID'si ile kurulur — yayınlanmamalı.

    `/health` ve `/metrics` kimlik doğrulaması İSTEMEZ. İçinde gateway UUID'si
    bulunan bir tanılama anahtarı, kimlik doğrulamasız bir uçtan altyapı
    kimliği sızdırmak demektir. Hata SAYISI (`consecutive_page_errors`) ve
    hata TÜRÜ (`last_error`) operatöre gerekeni verir; kimlik gerekmez.
    """
    mp.reset_memory_persistence_state()
    uuid_val = "1bd78836-c084-4cbf-b333-9386d44b7bd7"
    mp._STATE["last_error_page_key"] = f"{uuid_val}:seq:0"
    mp._STATE["consecutive_page_errors"] = 3
    mp._STATE["last_error"] = "IntegrityError(23505)"

    status = mp.memory_persistence_status()

    assert "1bd78836" not in str(status), "gateway UUID'si /health'e sizdi"
    assert "last_error_page_key" not in status
    # Tanılama kaybolmadı: sayı ve tür hâlâ yayınlanıyor.
    assert status["consecutive_page_errors"] == 3
    assert status["last_error"] == "IntegrityError(23505)"
    mp.reset_memory_persistence_state()
