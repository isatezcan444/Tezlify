"""Outbound delete sync: deleting in Tezlify must also delete on WhatsApp.

PRODUCTION SYMPTOM (2026-10-01, reported as "Tezlify'dan sohbeti sil dedigim
zaman whatsapp uygulamasinda da silmesi gerekiyor fakat silmiyor"): the delete
endpoint removed the conversation locally and never told WhatsApp.

Root cause, read from the running Baileys 7.0.0-rc14 sources rather than
guessed: `Socket/chats.js` exposes `chatModify(mod, jid)`, and
`Utils/chat-utils.js` turns `{ delete: true, lastMessages }` into a
`deleteChatAction` app-state patch — but the string `chatModify` appeared
NOWHERE in the gateway's own source. The chat was deleted for the CRM only,
while the account's other devices kept it.

Why this is not cosmetic: a local-only delete is reverted by the next history
sync, so the chat comes back. The two directions have to be symmetric or the
"deleted" state is not durable.

The contract these checks pin:

- the remote call happens, WITH the canonical jid, BEFORE the local rows go,
- a provider refusal (`success: false`) is NOT read as success (the gateway
  returns 200 with `success: false`, so a bare 2xx is not proof),
- a gateway failure NEVER blocks the local delete — the user asked for the
  delete and the local data must go,
- the outcome is REPORTED (`remote_deleted` / `remote_error`) instead of being
  silently swallowed,
- a conversation with no WhatsApp identity is deletable, not a 404.
"""
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.schemas.whatsapp import WhatsAppConversationDeleteResult
from backend.app.services import whatsapp_service as ws

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
GW_ID = "gw-outbound-delete-0001"
PHONE = "+905321112233"
PHONE_JID = "905321112233@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM messages WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM conversations WHERE user_id = :h AND channel = 'WHATSAPP'"),
                {"h": TEST_USER_HEX},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id = :h"),
                {"h": TEST_USER_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def _seed(with_contact=True):
    """CONNECTED session + conversation, optionally with a contact (jid)."""
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=GW_ID,
            session_name="Outbound Delete Hat",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()
        contact_id = None
        if with_contact:
            contact = Contact(user_id=TEST_USER, phone_e164=PHONE, display_name=None)
            db.add(contact)
            await db.flush()
            contact_id = contact.id
        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact_id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
        )
        db.add(conv)
        await db.commit()
        return conv.id


async def _conversation_exists(conv_id: int) -> bool:
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Conversation).where(Conversation.id == conv_id))
        return res.scalar_one_or_none() is not None


async def _delete(conv_id: int):
    """Runs the service delete with the WS broadcast stubbed out."""
    from backend.app.api.v1 import websocket as websocket_mod

    async with AsyncSessionLocal() as db:
        with patch.object(websocket_mod.ws_manager, "broadcast", AsyncMock(return_value=1)):
            return await ws.delete_conversation(db, TEST_USER, conv_id)


@pytest.mark.asyncio
async def test_remote_delete_is_attempted_with_canonical_jid_and_reported():
    """The happy path: Tezlify's delete reaches WhatsApp and says so."""
    conv_id = await _seed()
    calls = []

    async def _fake_remote(gateway_id, jid):
        calls.append((gateway_id, jid))
        return {"success": True, "remote_deleted": True}

    with patch.object(ws.gw, "delete_conversation_remote", _fake_remote):
        result = await _delete(conv_id)

    assert calls == [(GW_ID, PHONE_JID)], (
        "the remote delete must be sent to the conversation's OWN gateway "
        "session and canonical jid — not a guessed line"
    )
    assert result["remote_deleted"] is True
    assert result["remote_error"] is None
    assert result["deleted"] is True
    assert not await _conversation_exists(conv_id)


@pytest.mark.asyncio
async def test_provider_refusal_is_not_treated_as_success():
    """The gateway answers 200 with `success: false` when WhatsApp refuses.

    Reading that payload as success is the failure mode `mark_conversation_read`
    already guards against; the same rule has to hold here or the UI claims a
    delete that never happened on the phone.
    """
    conv_id = await _seed()

    with patch.object(
        ws.gw,
        "delete_conversation_remote",
        AsyncMock(return_value={"success": False, "error": "Chat not found"}),
    ):
        result = await _delete(conv_id)

    assert result["remote_deleted"] is False
    assert result["remote_error"] == "Chat not found"
    # The local delete still happened — the user's decision stands.
    assert result["deleted"] is True
    assert not await _conversation_exists(conv_id)


@pytest.mark.asyncio
async def test_gateway_failure_never_blocks_the_local_delete():
    """Load-bearing: a dead/unreachable gateway must not make the row immortal.

    If this inverts, "delete" silently becomes a no-op whenever the gateway is
    down — and the user has no way to tell.
    """
    conv_id = await _seed()

    with patch.object(
        ws.gw,
        "delete_conversation_remote",
        AsyncMock(side_effect=RuntimeError("gateway unreachable")),
    ):
        result = await _delete(conv_id)

    assert result["deleted"] is True
    assert result["remote_deleted"] is False
    assert "gateway unreachable" in (result["remote_error"] or "")
    assert not await _conversation_exists(conv_id), (
        "a gateway error must not leave the conversation behind"
    )


@pytest.mark.asyncio
async def test_conversation_without_whatsapp_identity_is_still_deletable():
    """No contact means no jid — a local-only delete, not a 404.

    `resolve_conversation_jid` raises LookupError both for "not found" AND for
    "no contact"; turning the second case into a 404 would make legacy rows
    undeletable.
    """
    conv_id = await _seed(with_contact=False)
    remote = AsyncMock()

    with patch.object(ws.gw, "delete_conversation_remote", remote):
        result = await _delete(conv_id)

    remote.assert_not_awaited()
    assert result["deleted"] is True
    assert result["remote_deleted"] is False
    assert result["remote_error"] == "NO_REMOTE_IDENTITY"
    assert not await _conversation_exists(conv_id)


def test_delete_result_schema_declares_remote_fields():
    """Pydantic v2 `extra="ignore"` silently DROPS undeclared fields.

    This exact shape already killed the `link_preview` feature in production:
    the service produced the value, the response model never declared it, and
    FastAPI sent nothing. Pin the declaration so it cannot regress.
    """
    fields = WhatsAppConversationDeleteResult.model_fields
    assert "remote_deleted" in fields
    assert "remote_error" in fields

    dumped = WhatsAppConversationDeleteResult(
        id=1, deleted=True, remote_deleted=False, remote_error="BOOM"
    ).model_dump()
    assert dumped["remote_deleted"] is False
    assert dumped["remote_error"] == "BOOM"


@pytest.mark.asyncio
async def test_remote_delete_forwards_last_message_hint_when_message_exists():
    """If the conversation has messages in DB, the latest message anchor is passed as last_message_hint."""
    conv_id = await _seed()
    async with AsyncSessionLocal() as db:
        msg = Message(
            user_id=TEST_USER,
            conversation_id=conv_id,
            wa_message_id="WA-DELETE-ANCHOR-123",
            direction=MessageDirection.INBOUND,
            body="Anchor test",
            recipient_phone="905321112233",
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(msg)
        await db.commit()

    captured = {}

    async def _fake_remote_with_hint(gateway_id, jid, last_message_hint=None):
        captured["gateway_id"] = gateway_id
        captured["jid"] = jid
        captured["last_message_hint"] = last_message_hint
        return {"success": True, "remote_deleted": True}

    with patch.object(ws.gw, "delete_conversation_remote", _fake_remote_with_hint):
        result = await _delete(conv_id)

    assert result["remote_deleted"] is True
    assert captured["gateway_id"] == GW_ID
    assert captured["jid"] == PHONE_JID
    assert captured["last_message_hint"] is not None
    assert captured["last_message_hint"]["wa_message_id"] == "WA-DELETE-ANCHOR-123"
    assert captured["last_message_hint"]["from_me"] is False
    assert captured["last_message_hint"]["timestamp_s"] > 0
