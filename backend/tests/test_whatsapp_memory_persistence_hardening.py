"""Faz 3.6 sertleştirme — drain modülünün güvenlik sözleşmesi.

Bu dosya, `test_whatsapp_memory_persistence.py`'nin kapsamadığı yedi senaryoyu
kilitler (direktif §4: 3, 6, 10, 11, 12, 13, 14). Diğer yedi senaryo
(1, 2, 4, 5, 7, 8, 9) aynı modüldeki mevcut testlerle kapsanıyor.

NEDEN AYRI DOSYA: buradaki testler "mutlu yol" değil, arıza ve yarış
senaryolarıdır. Bir tanesi (eksik `wa_message_id`) yazıldığında GERÇEKTEN
kırmızıydı: tekillik indeksi `WHERE wa_message_id IS NOT NULL` olduğu için
kimliksiz satır her turda yeniden yazılıyordu. Düzeltme modülün içinde.
"""
from __future__ import annotations

import asyncio
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp import memory_persistence as mp

# Bu dosyaya özel kiracı — diğer test dosyalarıyla çakışmasın.
U3 = "88888888-8888-8888-8888-888888888888"
U3_HEX = U3.replace("-", "")


def jid_of(tag: str) -> str:
    return f"9055{tag}@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _clean_state():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": U3_HEX}
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
            user_id=U3,
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
            user_id=U3,
            phone_e164=f"+{jid.split('@')[0]}" if "@s.whatsapp.net" in jid else f"jid:{jid}",
            display_name="Sertlestirme Kişi",
        )
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=U3,
            contact_id=contact.id,
            channel="WHATSAPP",
            session_id=session_db_id,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        return int(conv.id)


def gw_message(
    jid: str, wa_id: Optional[str], at: datetime, *, body: str = "merhaba"
) -> Dict[str, Any]:
    msg: Dict[str, Any] = {
        "id": int(at.timestamp() * 1000),
        "conversation_id": jid,
        "direction": "INBOUND",
        "message_type": "TEXT",
        "body": body,
        "status": "RECEIVED",
        "created_at": at.isoformat().replace("+00:00", "Z"),
        "timestamp_s": int(at.timestamp()),
        "sender_phone": "+905551112233",
        "recipient_name": "ME",
        "reactions": [],
    }
    if wa_id is not None:
        msg["wa_message_id"] = wa_id
    return msg


def fake_gateway(messages: List[Dict[str, Any]], page_size: int):
    """`gw.list_all_messages` yerine geçen sahte sayfalayıcı.

    İstenen `offset`'e SAYGI DUYAR — gerçek API gibi. Çağrı SIRASINA göre
    sayfa döndürseydi, imleçten (`start_offset`) başlayan bir tur yanlış
    dilimi alırdı ve imleç testi kendi kendini doğrulamış olurdu.
    """
    calls = {"n": 0, "offsets": []}

    async def _fake(_gateway_id, limit=1000, offset=0, since=None, per_chat_limit=None, jids=None):
        calls["n"] += 1
        start = max(0, int(offset or 0))
        calls["offsets"].append(start)
        size = int(limit or page_size)
        return {
            "messages": messages[start:start + size],
            "total": len(messages),
            "offset": start,
            "limit": size,
        }

    _fake.calls = calls  # type: ignore[attr-defined]
    return _fake


async def drain(
    gateway_id: str,
    messages: List[Dict[str, Any]],
    *,
    page_size: int = 500,
    max_pages: int = 20,
    session_db_id: Optional[int] = None,
    dry_run: bool = False,
    start_offset: int = 0,
) -> Dict[str, Any]:
    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(messages, page_size)):
            return await mp.drain_gateway_memory_once(
                db,
                user_id=U3,
                gateway_id=gateway_id,
                session_db_id=session_db_id,
                page_size=page_size,
                max_pages=max_pages,
                dry_run=dry_run,
                start_offset=start_offset,
            )


async def count_messages(conv_id: int) -> int:
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Message).where(Message.conversation_id == conv_id))
        return len(res.scalars().all())


# ---------------------------------------------------------------------------
# §3 — Yalnızca AÇIKÇA izin verilen hatlar üzerinde çalışır
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_inactive_line_is_skipped():
    """Devre dışı bırakılmış hat geri doldurulmaz."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    jid = jid_of("300020")
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=U3,
            gateway_id=gw_id,
            session_name=f"s-{gw_id[:8]}",
            status=SessionStatus.CONNECTED,
            is_active=False,          # kullanıcı hattı kapatmış
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        sid = int(row.id)
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 8, 10, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"I{i:03d}", base + timedelta(minutes=i)) for i in range(3)]

    with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(msgs, 500)) as spy:
        await mp.run_memory_persistence_once()

    assert await count_messages(conv_id) == 0
    assert spy.call_count == 0, "kapalı hat için gateway'e bile gidilmemeli"


# ---------------------------------------------------------------------------
# §4.3 — Kısmi DB hatası ve güvenli tekrar deneme
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_partial_db_error_then_safe_retry():
    """İkinci sayfa yazılamazsa: ilk sayfa kalır, ikincisi TEKRAR denenebilir.

    Sözleşme: hata yarım bir sayfa bırakmaz (sayfa başına tek INSERT), tur
    `error` bildirir, ve sonraki tur eksiği tamamlar — çift üretmeden.
    """
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300003")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"P{i:03d}", base + timedelta(minutes=i)) for i in range(6)]

    real_insert = mp._insert_messages_resilient
    calls = {"n": 0}

    async def _flaky(db, rows):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OperationalError("INSERT", {}, Exception("simulated db outage"))
        return await real_insert(db, rows)

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(msgs, 3)):
            with patch.object(mp, "_insert_messages_resilient", side_effect=_flaky):
                first = await mp.drain_gateway_memory_once(
                    db, user_id=U3, gateway_id=gw_id, session_db_id=sid,
                    page_size=3, max_pages=10,
                )

    # İlk sayfa yazıldı, ikinci sayfa hata verdi, üçüncüye geçilmedi.
    assert first["pages"] == 2
    assert first["inserted"] == 3
    assert "error" in first
    assert await count_messages(conv_id) == 3

    # Aynı tur yeniden koşar: eksik 3'ü tamamlar, ilk 3'ü çoğaltmaz.
    second = await drain(gw_id, msgs, page_size=3, session_db_id=sid)
    assert second["inserted"] == 3
    assert await count_messages(conv_id) == 6


# ---------------------------------------------------------------------------
# §4.6 — Eksik / bozuk WhatsApp mesaj kimliği
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_message_without_wa_id_is_never_duplicated():
    """Kimliksiz mesaj her turda yeniden yazılmamalı.

    Tekillik indeksi `(conversation_id, wa_message_id) WHERE wa_message_id IS
    NOT NULL` — yani `NULL` kimlik hiçbir zaman çakışmaz. Kimliksiz satırı
    yazmak, her turda bir kopya daha demektir. Doğru davranış: kimliksiz
    kaydı YAZMA, say ve raporla.
    """
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300006")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 2, 10, 0, tzinfo=timezone.utc)
    msgs = [
        gw_message(jid, "OK001", base),
        gw_message(jid, None, base + timedelta(minutes=1)),      # alan yok
        gw_message(jid, "", base + timedelta(minutes=2)),        # boş string
        gw_message(jid, "   ", base + timedelta(minutes=3)),     # yalnızca boşluk
    ]

    first = await drain(gw_id, msgs, session_db_id=sid)
    second = await drain(gw_id, msgs, session_db_id=sid)
    third = await drain(gw_id, msgs, session_db_id=sid)

    assert first["inserted"] == 1
    assert first["skipped_no_id"] == 3
    assert second["inserted"] == 0
    assert third["inserted"] == 0
    assert await count_messages(conv_id) == 1


# ---------------------------------------------------------------------------
# §4.10 — Görev iptali ve uygulama kapanışı
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_cancellation_propagates_and_leaves_no_half_written_page():
    """İptal, `CancelledError` olarak yukarı çıkmalı ve yarım sayfa bırakmamalı."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300010")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 3, 10, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"C{i:03d}", base + timedelta(minutes=i)) for i in range(4)]

    async def _cancel_after_first_page(_gateway_id, limit=1000, offset=0, **kw):
        if offset == 0:
            return {"messages": msgs[:2], "total": 4, "offset": 0, "limit": 2}
        raise asyncio.CancelledError()

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=_cancel_after_first_page):
            with pytest.raises(asyncio.CancelledError):
                await mp.drain_gateway_memory_once(
                    db, user_id=U3, gateway_id=gw_id, session_db_id=sid,
                    page_size=2, max_pages=10,
                )

    # İlk sayfa commit edilmişti; iptal onu geri almaz ve yarım satır bırakmaz.
    assert await count_messages(conv_id) == 2


@pytest.mark.asyncio
async def test_loop_cancellation_exits_cleanly():
    """`memory_persistence_loop` iptal edilince sessizce sonlanır."""
    async def _noop(**_kw):
        return []

    with patch.object(mp, "run_memory_persistence_once", side_effect=_noop):
        task = asyncio.create_task(
            mp.memory_persistence_loop(interval_seconds=30, initial_delay_seconds=0)
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert task.cancelled()


# ---------------------------------------------------------------------------
# §4.11 — Feature flag kapalıyken hiçbir yazma yapılmamalı
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_feature_flag_off_writes_nothing(monkeypatch):
    """Kill-switch yalnızca lifespan'de değil, işin KENDİSİNDE de geçerli olmalı.

    Aksi halde elle/CLI ile çağrılan bir tur, kapalı olduğu söylenen bir
    özellikte yazmaya devam eder.
    """
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300011")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 4, 10, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"F{i:03d}", base + timedelta(minutes=i)) for i in range(3)]

    monkeypatch.setattr(settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", False, raising=False)

    with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(msgs, 500)) as spy:
        results = await mp.run_memory_persistence_once()

    assert await count_messages(conv_id) == 0
    assert results == []
    # Gateway'e hiç gidilmemeli: kapalı bir iş kaynak tüketmemeli.
    assert spy.call_count == 0


# ---------------------------------------------------------------------------
# §4.12 — Eşzamanlı iki worker aynı mesajları işlerse
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_two_concurrent_workers_do_not_duplicate():
    """İki eşzamanlı tur aynı sayfayı yazarsa sonuç tek kopya olmalı."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300012")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 5, 10, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"W{i:03d}", base + timedelta(minutes=i)) for i in range(20)]

    async def _one_run():
        async with AsyncSessionLocal() as db:
            with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(msgs, 10)):
                return await mp.drain_gateway_memory_once(
                    db, user_id=U3, gateway_id=gw_id, session_db_id=sid,
                    page_size=10, max_pages=10,
                )

    results = await asyncio.gather(_one_run(), _one_run(), return_exceptions=True)
    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, f"Eşzamanlı tur hata verdi: {errors!r}"

    assert await count_messages(conv_id) == 20
    inserted_total = sum(r["inserted"] for r in results if isinstance(r, dict))
    assert inserted_total == 20, "aynı mesaj iki kez sayıldı/yazıldı"


# ---------------------------------------------------------------------------
# §4.13 — DB kesintisi sırasında RAM'deki mesajlar korunur
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_db_outage_never_touches_gateway_memory():
    """DB erişilemezse iş durur; gateway belleğine DOKUNMAZ, bağlantıyı bozmaz."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300013")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 6, 10, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"O{i:03d}", base + timedelta(minutes=i)) for i in range(5)]

    # Gateway'e yapılan çağrıları kaydet: yalnızca OKUMA olmalı.
    seen: List[str] = []

    async def _fake_list(*a, **kw):
        seen.append("list_all_messages")
        return {"messages": msgs, "total": 5, "offset": 0, "limit": 500}

    async def _boom(_db, _rows):
        raise OperationalError("INSERT", {}, Exception("db down"))

    with patch.object(mp.gw, "list_all_messages", side_effect=_fake_list):
        with patch.object(mp, "_insert_messages_resilient", side_effect=_boom):
            results = await mp.run_memory_persistence_once()

    assert await count_messages(conv_id) == 0
    assert seen == ["list_all_messages"], f"beklenmeyen gateway çağrısı: {seen}"
    assert mp.memory_persistence_status()["errors_total"] >= 1
    assert "db down" in str(mp.memory_persistence_status()["last_error"])
    # Hat hâlâ bağlı ve mesajlar hâlâ RAM'de (silme yolu yok).
    assert results == [] or all(r.get("inserted", 0) == 0 for r in results)


# ---------------------------------------------------------------------------
# §4.14 — Reconnect sonrası tekrar çalıştırma veri çoğaltmaz
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_reconnect_rerun_does_not_duplicate():
    """Gateway yeniden dolduğunda (aynı + yeni mesajlar) yalnızca yeniler yazılır."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300014")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 7, 10, 0, tzinfo=timezone.utc)
    old = [gw_message(jid, f"R{i:03d}", base + timedelta(minutes=i)) for i in range(5)]

    first = await drain(gw_id, old, session_db_id=sid)
    assert first["inserted"] == 5

    # Reconnect: RAM yeniden dolduruldu — aynı 5 + 2 yeni.
    fresh = old + [
        gw_message(jid, "R005", base + timedelta(minutes=5)),
        gw_message(jid, "R006", base + timedelta(minutes=6)),
    ]
    second = await drain(gw_id, fresh, session_db_id=sid)

    assert second["inserted"] == 2
    assert await count_messages(conv_id) == 7


# ---------------------------------------------------------------------------
# §3.2 — Tur tavanı toplamın altındaysa listenin KUYRUĞU erişilebilir kalmalı
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_tail_is_reachable_when_max_pages_is_below_total():
    """Tavan yetmediğinde imleç kuyruğa ulaştırmalı.

    Tavan `max_pages * page_size`. İmleç olmadan her tur offset 0'dan başlar;
    ilk N sayfa zaten DB'de olduğu için 0 satır eklenir ve offset hiç ilerlemez
    ⇒ listenin kuyruğu HİÇBİR turda yazılmaz. Sessiz veri kaybı.

    Ölçüm (2026-10-28, üretim): RAM 9122 mesaj, varsayılan tavan 10000 —
    pay yalnızca 878 mesajdı. Yani sınır teorik değil, yakındı.
    """
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300015")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 8, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"T{i:03d}", base + timedelta(minutes=i)) for i in range(12)]

    # page_size=5, max_pages=2 ⇒ tur başına en fazla 10 mesaj.
    first = await drain(gw_id, msgs, page_size=5, max_pages=2, session_db_id=sid)
    assert first["inserted"] == 10, "ilk tur tavanı doldurmalı"
    assert first["next_offset"] == 10, "tur sonuna ulaşmadı → imleç kaldığı yeri göstermeli"

    second = await drain(
        gw_id, msgs, page_size=5, max_pages=2, session_db_id=sid,
        start_offset=first["next_offset"],
    )
    assert second["inserted"] == 2, "kuyruk ikinci turda yazılmalı"
    assert second["next_offset"] == 0, "tur sonuna ulaşıldı → imleç sıfırlanmalı"
    assert await count_messages(conv_id) == 12


@pytest.mark.asyncio
async def test_run_once_advances_cursor_across_turns():
    """`run_memory_persistence_once` imleci turlar arasında taşımalı."""
    mp.reset_memory_persistence_state()
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300016")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 9, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"U{i:03d}", base + timedelta(minutes=i)) for i in range(12)]

    def mine(results):
        return [r for r in results if r.get("gateway_id") == gw_id]

    with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(msgs, 5)):
        first = mine(await mp.run_memory_persistence_once(page_size=5, max_pages=2))
        second = mine(await mp.run_memory_persistence_once(page_size=5, max_pages=2))

    assert first and first[0]["inserted"] == 10
    assert second and second[0]["inserted"] == 2, "ikinci tur kuyruğu yazmalı"
    assert await count_messages(conv_id) == 12
    # Tur sonuna ulaşıldı: imleç sıfırlandı ve /health'e UUID sızmıyor.
    status = mp.memory_persistence_status()
    assert status["max_cursor_offset"] == 0
    assert "cursors" not in status


@pytest.mark.asyncio
async def test_dry_run_does_not_advance_the_cursor():
    """`dry_run` sayım turudur: imleci ilerletirse gerçek tur atlanır."""
    mp.reset_memory_persistence_state()
    gw_id = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw_id)
    jid = jid_of("300017")
    conv_id = await make_conversation(jid, sid)

    base = datetime(2026, 7, 10, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_message(jid, f"V{i:03d}", base + timedelta(minutes=i)) for i in range(12)]

    def mine(results):
        return [r for r in results if r.get("gateway_id") == gw_id]

    with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(msgs, 5)):
        dry = mine(await mp.run_memory_persistence_once(page_size=5, max_pages=2, dry_run=True))

    assert dry and dry[0]["inserted"] == 10, "dry_run saymalı"
    assert await count_messages(conv_id) == 0, "dry_run yazmamalı"

    with patch.object(mp.gw, "list_all_messages", side_effect=fake_gateway(msgs, 5)):
        real = mine(await mp.run_memory_persistence_once(page_size=5, max_pages=2))

    assert real and real[0]["inserted"] == 10, "gerçek tur yine BAŞTAN başlamalı"
    assert await count_messages(conv_id) == 10
