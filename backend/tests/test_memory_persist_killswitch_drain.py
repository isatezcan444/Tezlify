"""Kill-switch boşluğu — `drain_gateway_memory_once` yazma yolunu da reddetmeli.

Ölçülen boşluk (3.9.15, üretim gözlemi): kill-switch yalnızca
`run_memory_persistence_once` içinde kontrol ediliyordu. `drain_gateway_memory_once`
doğrudan çağrıldığında (diagnostik betik, CLI, gelecekteki bir job) yazma yolu
AÇIK kalıyordu; yani "kapalı" bir özellik, çağıranın hangi fonksiyonu seçtiğine
bağlı olarak yazabiliyordu. Bir güvenlik kapısı çağıranın tercihine bağlı olamaz.

Korunan sözleşme:
  * kill-switch KAPALI + `dry_run=False`  -> hiç yazmaz, gateway'e hiç gitmez,
    `error="PERSIST_DISABLED"` döner.
  * kill-switch KAPALI + `dry_run=True`   -> ölçüm SERBEST (satır yazmaz), çünkü
    "kaç satır yazılırdı" cevabı özellik kapalıyken de gerekir.
  * kill-switch AÇIK  + `dry_run=False`   -> normal yazar.

Testler sentetiktir: gerçek gateway yok (mock), gerçek mesaj yok.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp import memory_persistence as mp

# Bu dosyaya özel kiracı (diğer test dosyalarıyla çakışmasın).
U3 = "88888888-8888-8888-8888-888888888888"
U3_HEX = U3.replace("-", "")

JID = "905551119999@s.whatsapp.net"
GATEWAY = "gw-killswitch-drain"


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


async def _seed_line_and_conversation() -> int:
    """Bir hat + bir sohbet oluşturur; hat DB id'sini döner."""
    async with AsyncSessionLocal() as db:
        line = WhatsAppSession(
            user_id=U3,
            gateway_id=GATEWAY,
            session_name="killswitch",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(line)
        await db.flush()
        contact = Contact(
            user_id=U3,
            phone_e164="+905551119999",
            display_name="Test Kişi",
        )
        db.add(contact)
        await db.flush()
        db.add(
            Conversation(
                user_id=U3,
                contact_id=contact.id,
                channel="WHATSAPP",
                session_id=line.id,
            )
        )
        await db.commit()
        return int(line.id)


def _gw_message(wa_id: str) -> Dict[str, Any]:
    at = datetime(2026, 10, 30, 9, 0, tzinfo=timezone.utc)
    return {
        "id": 1,
        "conversation_id": JID,
        "wa_message_id": wa_id,
        "direction": "INBOUND",
        "message_type": "TEXT",
        "body": "sentetik",
        "status": "RECEIVED",
        "created_at": at.isoformat().replace("+00:00", "Z"),
        "timestamp_s": int(at.timestamp()),
        "sender_phone": "+905551119999",
        "recipient_phone": "ME",
        "reactions": [],
    }


def _fake_gateway(wa_id: str = "WA-KS-1"):
    """`list_all_messages` yerine geçen, çağrı sayısını sayan sahte."""
    async def _call(*args, **kwargs):
        _call.calls += 1
        return {"messages": [_gw_message(wa_id)], "total": 1}
    _call.calls = 0
    return _call


async def _count_messages() -> int:
    async with AsyncSessionLocal() as db:
        return int(
            (
                await db.execute(
                    text(
                        "SELECT count(*) FROM messages m "
                        "JOIN conversations c ON c.id = m.conversation_id "
                        "WHERE c.user_id = :u"
                    ),
                    {"u": U3_HEX},
                )
            ).scalar()
        )


# ---------------------------------------------------------------- asıl sözleşme
@pytest.mark.asyncio
async def test_write_tour_is_refused_when_killswitch_is_off(monkeypatch):
    """KAPALI + dry_run=False -> yazmaz, gateway'e HİÇ gitmez."""
    line_id = await _seed_line_and_conversation()
    monkeypatch.setattr(
        mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", False, raising=False
    )
    fake = _fake_gateway()

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=fake):
            stats = await mp.drain_gateway_memory_once(
                db,
                user_id=U3,
                gateway_id=GATEWAY,
                session_db_id=line_id,
                dry_run=False,
            )

    assert stats["error"] == "PERSIST_DISABLED"
    assert stats.get("blocked_by_killswitch") is True
    assert stats["inserted"] == 0
    assert stats["scanned"] == 0
    # Kapı, gateway'e gitmeden önce kapanmalı.
    assert fake.calls == 0
    assert await _count_messages() == 0


@pytest.mark.asyncio
async def test_dry_run_still_measures_when_killswitch_is_off(monkeypatch):
    """KAPALI + dry_run=True -> ölçüm serbest, ama hiçbir satır yazılmaz."""
    line_id = await _seed_line_and_conversation()
    monkeypatch.setattr(
        mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", False, raising=False
    )
    fake = _fake_gateway()

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=fake):
            stats = await mp.drain_gateway_memory_once(
                db,
                user_id=U3,
                gateway_id=GATEWAY,
                session_db_id=line_id,
                dry_run=True,
            )

    assert "error" not in stats
    assert stats["dry_run"] is True
    assert stats["scanned"] == 1
    assert stats["inserted"] == 1  # "yazılırdı" sayısı
    assert fake.calls >= 1
    assert await _count_messages() == 0  # ama gerçekten yazılmadı


@pytest.mark.asyncio
async def test_write_tour_proceeds_when_killswitch_is_on(monkeypatch):
    """AÇIK + dry_run=False -> normal yazar (kapı yanlışlıkla hep kapalı değil)."""
    line_id = await _seed_line_and_conversation()
    monkeypatch.setattr(
        mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", True, raising=False
    )
    fake = _fake_gateway()

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=fake):
            stats = await mp.drain_gateway_memory_once(
                db,
                user_id=U3,
                gateway_id=GATEWAY,
                session_db_id=line_id,
                dry_run=False,
            )

    assert "error" not in stats
    assert stats["inserted"] == 1
    assert await _count_messages() == 1


@pytest.mark.asyncio
async def test_refusal_is_idempotent_and_writes_nothing_twice(monkeypatch):
    """Kapı iki kez çağrıldığında da yazmaz; durum sayaçları şişmez."""
    line_id = await _seed_line_and_conversation()
    monkeypatch.setattr(
        mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", False, raising=False
    )
    fake = _fake_gateway()

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=fake):
            first = await mp.drain_gateway_memory_once(
                db, user_id=U3, gateway_id=GATEWAY, session_db_id=line_id, dry_run=False
            )
            second = await mp.drain_gateway_memory_once(
                db, user_id=U3, gateway_id=GATEWAY, session_db_id=line_id, dry_run=False
            )

    assert first["error"] == second["error"] == "PERSIST_DISABLED"
    assert fake.calls == 0
    assert await _count_messages() == 0


@pytest.mark.asyncio
async def test_empty_identifiers_still_return_quietly(monkeypatch):
    """Boş user/gateway kill-switch'ten önce döner (davranış değişmedi)."""
    monkeypatch.setattr(
        mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", False, raising=False
    )
    async with AsyncSessionLocal() as db:
        stats = await mp.drain_gateway_memory_once(
            db, user_id="", gateway_id="", dry_run=False
        )
    assert "error" not in stats
    assert stats["inserted"] == 0
