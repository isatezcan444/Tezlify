"""AŞAMA 5.3.9 — Session silme yaşam döngüsü (çok sekme tutarlılığı).

Neden bu dosya var
------------------
`deleteSession` (gateway) hiçbir event üretmez; backend silmeyi REST üzerinden
yapar. Bu, DELETE'i başlatan sekmeyi tatmin eder ama DİĞER açık sekmeleri
etmez: onlar yalnızca WebSocket'i görür. 5.3.8 alt-bulgusu (R-4) buydu.

Sözleşme
--------
- DB satırı silinir; `purge_whatsapp_data` mesaj/sohbet verisini temizler.
- Yayın yalnızca COMMIT'TEN SONRA yapılır: başarısız silme diğer sekmelere
  "silindi" demez.
- Yayın tenant-scoped'dur (`target_user_id`) ve `reason="DELETED"` taşır —
  normal logout'un LOGGED_OUT/BANNED UI'ını tetiklemez.
- `session_deleted` YENİ bir üreticiyle eklenmez; mevcut `session_disconnected`
  yaşam döngüsü sinyali yeniden kullanılır.
- Aynı oturum iki kez silinirse ikinci çağrı temiz bir "yok" hatası verir.
- Başka bir oturum etkilenmez.
"""
import uuid as _uuid
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text, select

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp.orchestration import sessions as sessions_mod
from backend.app.services.whatsapp.orchestration.sessions import delete_session
from backend.app.services.whatsapp_service import ingest_gateway_event

TEST_USER = "12345678-1234-1234-1234-123456789012"
OTHER_USER = "87654321-4321-4321-4321-210987654321"
_PREFIX = "asama539del"


def _new_identity() -> str:
    n = _uuid.uuid4().int % 10 ** 10
    return f"+90{n:010d}"


def _jid_for(phone: str) -> str:
    return f"{phone.lstrip('+')}@s.whatsapp.net"


async def _make_session(user_id: str = TEST_USER, label: str = "D539") -> tuple[int, str]:
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=user_id,
            gateway_id=gw_id,
            session_name=f"{label}-{gw_id[:8]}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(row)
        await db.commit()
        return row.id, gw_id


def _event(gw_id: str, jid: str, wa_id: str, body: str = "Merhaba"):
    return {
        "event": "message_new",
        "gateway_session_id": gw_id,
        "conversation_id": jid,
        "message": {
            "body": body,
            "direction": "INBOUND",
            "message_type": "TEXT",
            "wa_message_id": wa_id,
            "created_at": "2025-01-15T10:00:00Z",
        },
        "upsert_type": "notify",
    }


async def _count(sql: str, **params) -> int:
    async with AsyncSessionLocal() as db:
        return int((await db.execute(text(sql), params)).scalar_one())


async def _session_exists(session_id: int) -> bool:
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(WhatsAppSession.id).where(WhatsAppSession.id == session_id)
        )).scalar_one_or_none() is not None


# ---------------------------------------------------------------------------
# 1-2. Başarılı silme: satır + veri temizlenir
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_removes_session_and_purges_conversation(monkeypatch):
    session_id, gw_id = await _make_session()
    phone = _new_identity()
    jid = _jid_for(phone)
    wa_id = f"{_PREFIX}-m-{_uuid.uuid4().hex[:8]}"
    await ingest_gateway_event(_event(gw_id, jid, wa_id))
    conv_count_before = await _count(
        "SELECT COUNT(*) FROM conversations WHERE session_id = :s", s=session_id
    )
    assert conv_count_before >= 1, "tohum sohbet olusmali"

    monkeypatch.setattr(gw, "delete_session", AsyncMock(return_value=None))
    monkeypatch.setattr(sessions_mod.ws_manager, "broadcast", AsyncMock(return_value=1))

    async with AsyncSessionLocal() as db:
        result = await delete_session(db, TEST_USER, session_id)

    assert result.get("success") is True
    assert await _session_exists(session_id) is False, "DB satir silinmeli"
    conv_after = await _count(
        "SELECT COUNT(*) FROM conversations WHERE session_id = :s", s=session_id
    )
    assert conv_after == 0, "sohbet verisi purge edilmeli"
    msg_after = await _count(
        "SELECT COUNT(*) FROM messages WHERE wa_message_id = :w", w=wa_id
    )
    assert msg_after == 0, "mesaj purge edilmeli"


# ---------------------------------------------------------------------------
# 3. Yayın commit'ten SONRA ve tenant-scoped
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_broadcasts_after_commit_to_tenant(monkeypatch):
    session_id, gw_id = await _make_session()
    monkeypatch.setattr(gw, "delete_session", AsyncMock(return_value=None))

    observed = {}

    async def _broadcast_side_effect(message, target_user_id=None):
        # Yayın anında satır HÂLÂ var mı? Commit'ten sonra olmalı ⇒ YOK.
        observed["row_exists"] = await _session_exists(session_id)
        observed["message"] = message
        observed["target"] = target_user_id
        return 1

    monkeypatch.setattr(sessions_mod.ws_manager, "broadcast", AsyncMock(side_effect=_broadcast_side_effect))

    async with AsyncSessionLocal() as db:
        await delete_session(db, TEST_USER, session_id)

    assert observed.get("row_exists") is False, "yayin commit'ten SONRA olmali (satir artik yok)"
    assert observed["target"] == TEST_USER, "yayin tenant-scoped olmali"
    msg = observed["message"]
    assert msg["event"] == "session_disconnected", "mevcut yasam dongusu sinyali kullanilmali"
    assert msg["reason"] == "DELETED", "silme ayri bir reason tasimali"
    assert msg["session_id"] == session_id
    assert msg["gateway_session_id"] == gw_id


# ---------------------------------------------------------------------------
# 4. Commit'ten önce hata → yayın YOK
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_failure_before_commit_does_not_broadcast(monkeypatch):
    session_id, gw_id = await _make_session()
    monkeypatch.setattr(gw, "delete_session", AsyncMock(return_value=None))
    broadcast = AsyncMock(return_value=1)
    monkeypatch.setattr(sessions_mod.ws_manager, "broadcast", broadcast)

    async def _boom(*a, **k):
        raise RuntimeError("purge failed")

    monkeypatch.setattr(sessions_mod, "purge_whatsapp_data", _boom)

    async with AsyncSessionLocal() as db:
        with pytest.raises(RuntimeError):
            await delete_session(db, TEST_USER, session_id)

    broadcast.assert_not_awaited()
    # Satır hâlâ duruyor (commit edilmedi) ⇒ diğer sekmelere "silindi" denmedi.
    assert await _session_exists(session_id) is True


# ---------------------------------------------------------------------------
# 5. İkinci silme temiz hata verir
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_second_delete_raises_cleanly(monkeypatch):
    session_id, _ = await _make_session()
    monkeypatch.setattr(gw, "delete_session", AsyncMock(return_value=None))
    monkeypatch.setattr(sessions_mod.ws_manager, "broadcast", AsyncMock(return_value=1))

    async with AsyncSessionLocal() as db:
        await delete_session(db, TEST_USER, session_id)

    async with AsyncSessionLocal() as db:
        with pytest.raises(Exception):
            await delete_session(db, TEST_USER, session_id)


# ---------------------------------------------------------------------------
# 6. Başka oturum etkilenmez
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_does_not_touch_other_session(monkeypatch):
    keep_id, keep_gw = await _make_session(label="KEEP")
    drop_id, _ = await _make_session(label="DROP")
    monkeypatch.setattr(gw, "delete_session", AsyncMock(return_value=None))
    monkeypatch.setattr(sessions_mod.ws_manager, "broadcast", AsyncMock(return_value=1))

    async with AsyncSessionLocal() as db:
        await delete_session(db, TEST_USER, drop_id)

    assert await _session_exists(drop_id) is False
    assert await _session_exists(keep_id) is True, "baska oturum silinmemeli"

    async with AsyncSessionLocal() as db:
        await db.execute(text("DELETE FROM whatsapp_sessions WHERE id = :i"), {"i": keep_id})
        await db.commit()


# ---------------------------------------------------------------------------
# 7. Tenant izolasyonu: yayın yalnızca sahibe
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_broadcast_is_tenant_scoped(monkeypatch):
    session_id, _ = await _make_session(user_id=OTHER_USER, label="OTHER")
    monkeypatch.setattr(gw, "delete_session", AsyncMock(return_value=None))
    broadcast = AsyncMock(return_value=1)
    monkeypatch.setattr(sessions_mod.ws_manager, "broadcast", broadcast)

    async with AsyncSessionLocal() as db:
        await delete_session(db, OTHER_USER, session_id)

    broadcast.assert_awaited_once()
    assert broadcast.await_args.kwargs.get("target_user_id") == OTHER_USER
