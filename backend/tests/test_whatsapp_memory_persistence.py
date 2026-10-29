"""Faz 3.6 — gateway belleğinin kalıcılaştırılması (P0).

Korunan sözleşme: gateway RAM'inde duran ve DB'de OLMAYAN mesajlar, mevcut
ingest yolundan idempotent biçimde yazılır. Bu testler bilerek "gerçek yazıcı"
üzerinden gider (`_insert_messages_resilient` + `build_message_from_gateway`),
çünkü asıl risk yeni bir paralel yazma yolu açmaktı.

Ölçülen hata (üretim, 2026-10-28, salt okunur): RAM'de 9098 mesaj, 7080'i DB'de
yok. Neden: ilk senkron sohbet başına yalnızca en yeni 50 mesajı yazıyor
(`_SYNC_PER_CHAT_LIMIT`), gerisi yalnızca bellekte kalıyor.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp import memory_persistence as mp

# Bu modüle özel kiracı (diğer test dosyalarıyla çakışmasın).
U1 = "66666666-6666-6666-6666-666666666666"
U1_HEX = U1.replace("-", "")
# İkinci kiracı: yalnızca izolasyon testinde kullanılır.
U2 = "77777777-7777-7777-7777-777777777777"
U2_HEX = U2.replace("-", "")


def jid_of(tag: str) -> str:
    return f"9055{tag}@s.whatsapp.net"


@pytest.fixture(autouse=True)
def _enable_memory_persistence(monkeypatch):
    """Süpürme artık VARSAYILAN OLARAK KAPALI (Faz 3.8.1, fail-closed).

    Bu dosya süpürmenin DAVRANIŞINI test eder, bu yüzden flag'i açıkça açar.
    """
    monkeypatch.setattr(
        mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", True, raising=False
    )


@pytest_asyncio.fixture(autouse=True)
async def _clean_state():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id IN (:u1, :u2)"),
                    {"u1": U1_HEX, "u2": U2_HEX},
                )
            await db.commit()

    mp.reset_memory_persistence_state()
    await _wipe()
    yield
    await _wipe()
    mp.reset_memory_persistence_state()


async def make_line(gateway_id: str, user_id: str = U1) -> int:
    """Bir hat (WhatsAppSession) oluşturur; DB id'sini döner."""
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=user_id,
            gateway_id=gateway_id,
            session_name=f"s-{gateway_id[:8]}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return int(row.id)


async def make_conversation(
    jid: str,
    session_db_id: Optional[int],
    user_id: str = U1,
    *,
    last_message_at: Optional[datetime] = None,
    last_message_preview: Optional[str] = None,
) -> int:
    async with AsyncSessionLocal() as db:
        contact = Contact(
            user_id=user_id,
            phone_e164=f"+{jid.split('@')[0]}" if "@s.whatsapp.net" in jid else f"jid:{jid}",
            display_name="Test Kişi",
        )
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
            session_id=session_db_id,
            last_message_at=last_message_at,
            last_message_preview=last_message_preview,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        return int(conv.id)


def gw_message(
    jid: str,
    wa_id: str,
    at: datetime,
    *,
    body: str = "merhaba",
    direction: str = "INBOUND",
) -> Dict[str, Any]:
    """Gateway'in `messagesByChat` kaydının şekli (gerçek alanlarla)."""
    return {
        "id": int(at.timestamp() * 1000),
        "conversation_id": jid,
        "wa_message_id": wa_id,
        "direction": direction,
        "message_type": "TEXT",
        "body": body,
        "status": "RECEIVED" if direction == "INBOUND" else "DELIVERED",
        "created_at": at.isoformat().replace("+00:00", "Z"),
        "timestamp_s": int(at.timestamp()),
        "sender_phone": "+905551112233" if direction == "INBOUND" else "ME",
        "recipient_phone": "ME" if direction == "INBOUND" else "+905551112233",
        "sender_name": "Test Kişi",
        "reactions": [],
    }


def paged(messages: List[Dict[str, Any]], page_size: int) -> List[Dict[str, Any]]:
    """`list_all_messages` gibi davranan sayfa listesi üretir."""
    pages = []
    total = len(messages)
    offset = 0
    while offset < total or (total == 0 and offset == 0):
        chunk = messages[offset:offset + page_size]
        pages.append({"messages": chunk, "total": total, "offset": offset, "limit": page_size})
        offset += page_size
        if offset >= total:
            break
    return pages


async def run_drain(
    gateway_id: str,
    messages: List[Dict[str, Any]],
    *,
    page_size: int = 500,
    max_pages: int = 20,
    per_chat_limit: int = 2000,
    session_db_id: Optional[int] = None,
    dry_run: bool = False,
    user_id: str = U1,
) -> Dict[str, Any]:
    pages = paged(messages, page_size)
    calls = {"n": 0}

    async def _fake(_gateway_id, limit=1000, offset=0, since=None, per_chat_limit=None, jids=None):
        idx = calls["n"]
        calls["n"] += 1
        if idx >= len(pages):
            return {"messages": [], "total": len(messages), "offset": offset, "limit": limit}
        return pages[idx]

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=_fake):
            return await mp.drain_gateway_memory_once(
                db,
                user_id=user_id,
                gateway_id=gateway_id,
                session_db_id=session_db_id,
                page_size=page_size,
                max_pages=max_pages,
                per_chat_limit=per_chat_limit,
                dry_run=dry_run,
            )


async def count_messages(conv_id: int) -> int:
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Message).where(Message.conversation_id == conv_id)
        )
        return len(res.scalars().all())


async def message_ids(conv_id: int) -> List[str]:
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Message.wa_message_id).where(Message.conversation_id == conv_id)
        )
        return sorted(str(r[0]) for r in res.all())


# ---------------------------------------------------------------------------
# 1. Tavanın dışında kalan geçmiş yazılır
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_drains_history_beyond_per_chat_cap():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100001")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 5, 15, 9, 0, tzinfo=timezone.utc)
    # 8 mesaj: 3'ü DB'de (en yeni), 5'i yalnızca RAM'de (daha eski).
    all_msgs = [gw_message(jid, f"WA{i:02d}", base + timedelta(days=i)) for i in range(8)]
    # DB'ye yalnızca en yeni 3'ü yaz (tavanın simülasyonu).
    await run_drain(gw_id, all_msgs[-3:], session_db_id=sid)
    assert await count_messages(conv_id) == 3

    stats = await run_drain(gw_id, all_msgs, session_db_id=sid)

    assert stats["inserted"] == 5
    assert await count_messages(conv_id) == 8
    assert await message_ids(conv_id) == sorted(m["wa_message_id"] for m in all_msgs)


# ---------------------------------------------------------------------------
# 2. İkinci tur idempotent — çift kayıt üretmez
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_repeated_drain_is_idempotent():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100002")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 6, 1, 8, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"ID{i:02d}", base + timedelta(hours=i)) for i in range(6)]

    first = await run_drain(gw_id, msgs, session_db_id=sid)
    second = await run_drain(gw_id, msgs, session_db_id=sid)
    third = await run_drain(gw_id, msgs, session_db_id=sid)

    assert first["inserted"] == 6
    assert second["inserted"] == 0
    assert third["inserted"] == 0
    assert await count_messages(conv_id) == 6


# ---------------------------------------------------------------------------
# 3. Canlı akış + history aynı wa_id → tek satır (D değişmezi)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_live_and_history_same_id_single_row():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100003")
    conv_id = await make_conversation(jid, sid)

    at = datetime(2026, 6, 2, 10, 0, tzinfo=timezone.utc)
    live = gw_message(jid, "SHARED01", at)
    await run_drain(gw_id, [live], session_db_id=sid)
    assert await count_messages(conv_id) == 1

    # History chunk aynı mesajı tekrar getirir + bir yenisini ekler.
    history = [live, gw_message(jid, "NEWER01", at + timedelta(minutes=5))]
    stats = await run_drain(gw_id, history, session_db_id=sid)

    assert stats["inserted"] == 1
    assert await count_messages(conv_id) == 2


# ---------------------------------------------------------------------------
# 4. Kiracı izolasyonu: başka kiracının jid'i ASLA yazılmaz
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_other_tenant_jid_is_not_written():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id, U1)
    own_jid = jid_of("100004")
    own_conv = await make_conversation(own_jid, sid, U1)

    # Başka kiracının aynı jid'i (meşru: farklı tenant, aynı telefon).
    other_jid = jid_of("100004")
    other_conv = await make_conversation(other_jid, None, U2)

    base = datetime(2026, 6, 3, 7, 0, tzinfo=timezone.utc)
    msgs = [gw_message(own_jid, f"T1-{i}", base + timedelta(minutes=i)) for i in range(3)]

    stats = await run_drain(gw_id, msgs, session_db_id=sid, user_id=U1)

    assert stats["inserted"] == 3
    assert await count_messages(own_conv) == 3
    # İkinci kiracının sohbetine TEK satır bile yazılmadı.
    assert await count_messages(other_conv) == 0


# ---------------------------------------------------------------------------
# 5. Köprüsü bilinmeyen LID sohbeti ATLANIR (A14/T: tahmin etme)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_unmapped_lid_chat_is_skipped():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100005")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 6, 4, 9, 0, tzinfo=timezone.utc)
    msgs = [
        gw_message(jid, "KNOWN01", base),
        gw_message("218107046027315@lid", "LIDONLY1", base + timedelta(minutes=1)),
    ]

    stats = await run_drain(gw_id, msgs, session_db_id=sid)

    assert stats["inserted"] == 1
    assert stats["skipped_unmapped"] == 1
    assert await count_messages(conv_id) == 1
    # LID jid'i için yeni bir sohbet/kişi UYDURULMADI.
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Contact).where(Contact.phone_e164 == "jid:218107046027315@lid")
        )
        assert res.scalars().first() is None


# ---------------------------------------------------------------------------
# 6. dry_run hiçbir şey yazmaz ama ne yazacağını söyler
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_dry_run_writes_nothing():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100006")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 6, 5, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"DR{i}", base + timedelta(minutes=i)) for i in range(4)]

    stats = await run_drain(gw_id, msgs, session_db_id=sid, dry_run=True)

    assert stats["dry_run"] is True
    assert stats["inserted"] == 4
    assert await count_messages(conv_id) == 0


# ---------------------------------------------------------------------------
# 7. Eski mesaj yazmak sohbet sırasını GERİYE SARMAZ (A4/A11)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_older_messages_do_not_rewind_last_message_at():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100007")

    newest = datetime(2026, 8, 17, 5, 45, tzinfo=timezone.utc)
    conv_id = await make_conversation(
        jid, sid, last_message_at=newest.replace(tzinfo=None), last_message_preview="en yeni"
    )

    older = [gw_message(jid, f"OLD{i}", newest - timedelta(days=30 + i)) for i in range(3)]
    stats = await run_drain(gw_id, older, session_db_id=sid)

    assert stats["inserted"] == 3
    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, conv_id)
        assert conv.last_message_at == newest.replace(tzinfo=None)
        assert conv.last_message_preview == "en yeni"


# ---------------------------------------------------------------------------
# 8. Sayfalama sınırı: max_pages turu sınırlar (sınırsız yükleme yok)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_max_pages_bounds_the_run():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100008")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 6, 6, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"PG{i:02d}", base + timedelta(minutes=i)) for i in range(10)]

    stats = await run_drain(gw_id, msgs, page_size=3, max_pages=2, session_db_id=sid)

    assert stats["pages"] == 2
    assert stats["scanned"] == 6
    assert stats["inserted"] == 6
    assert await count_messages(conv_id) == 6

    # Sınırlı tur TEKRAR ÇALIŞTIRILABİLİR: kalanlar sonraki turda yazılır.
    stats2 = await run_drain(gw_id, msgs, page_size=3, max_pages=5, session_db_id=sid)
    assert stats2["inserted"] == 4
    assert await count_messages(conv_id) == 10


# ---------------------------------------------------------------------------
# 9. Bozuk/eksik timestamp: timestamp_s'ten türetilir, satır kaybolmaz
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_missing_created_at_falls_back_to_timestamp_s():
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("100009")
    conv_id = await make_conversation(jid, sid)

    at = datetime(2026, 6, 7, 12, 30, tzinfo=timezone.utc)
    msg = gw_message(jid, "NOTS0001", at)
    msg.pop("created_at")
    msg["timestamp_s"] = int(at.timestamp())

    stats = await run_drain(gw_id, [msg], session_db_id=sid)

    assert stats["inserted"] == 1
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(Message).where(Message.conversation_id == conv_id))
        ).scalars().first()
        assert row is not None
        # Zaman EKSENI `external_timestamp`tir (msg_time_col: COALESCE).
        # `created_at` satirin yazildigi andir, saglayicinin zamani degil.
        assert row.external_timestamp is not None
        assert abs((row.external_timestamp - at.replace(tzinfo=None)).total_seconds()) < 2


# ---------------------------------------------------------------------------
# 10. Döngü tek turda ölmez: hata duruma yazılır, döngü devam eder
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_loop_survives_a_failing_run():
    calls = {"n": 0}

    def _factory():
        # Senkron fabrika: `async with factory()` çağrısı burada patlar.
        calls["n"] += 1
        raise RuntimeError("db down")

    import asyncio

    task = asyncio.create_task(
        mp.memory_persistence_loop(
            interval_seconds=30, initial_delay_seconds=0, session_factory=_factory
        )
    )
    try:
        for _ in range(50):
            if int(mp.memory_persistence_status().get("errors_total") or 0) >= 1:
                break
            await asyncio.sleep(0.02)
        status = mp.memory_persistence_status()
        assert status["enabled"] is True
        assert int(status["errors_total"]) >= 1
        # `/health` yalnızca istisna TÜRÜNÜ yayınlar, ham metni değil (PII).
        assert "RuntimeError" in str(status["last_error"])
        assert "db down" not in str(status["last_error"])
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
