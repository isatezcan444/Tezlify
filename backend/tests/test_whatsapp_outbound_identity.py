"""
Outbound identity & lifecycle regression tests for the Baileys send bugfix.

Covers the production incident:
- POST /conversations/{id}/messages returned 500 with
  `invalid input value for enum conversationmessagestatus: "PENDING"`
- Frontend retried with a timestamp-derived negative id
  (e.g. /messages/-1789054089553/retry) which PostgreSQL rejects as
  out-of-int32-range.

Canonical architecture under test:
- Message.status PENDING is intentional (Phase 4/5 + MessageStateMachine).
- messages.id        = REAL numeric DB primary key (server-generated).
- client_message_id  = cmsg_... idempotency key (client-generated).
- wa_message_id      = REAL Baileys key.id (gateway-generated).
- Optimistic UI ids are client-only strings and must never reach /retry.
"""
import base64
import json
import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.contact import Contact
from backend.app.models.message import (
    Message,
    MessageDirection,
    MessageType,
    ConversationMessageStatus,
)
from backend.app.models.outbox_message import OutboxMessage, OutboxMessageStatus
from backend.app.models.whatsapp_number import (
    WhatsAppNumber,
    WhatsAppNumberStatus,
    WhatsAppNumberProvider,
)
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.outbound_worker import OutboundWorker
from backend.app.services.whatsapp_gateway_client import gateway_client
from backend.app.api.v1.websocket import ws_manager


def _make_jwt(user_id: str, email: str = "test@example.com") -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "email": email,
        "user_metadata": {"full_name": f"User {user_id[:6]}"},
    }).encode()).decode().rstrip("=")
    return f"{header}.{payload}.mock_signature"


def _dyn_phone(prefix: str = "+9055") -> str:
    return f"{prefix}{uuid.uuid4().int % 100000000:08d}"


async def _create_baileys_setup(db, user_id: str, session_status: SessionStatus = SessionStatus.CONNECTED):
    line_phone = _dyn_phone("+9053")
    wanum = WhatsAppNumber(
        user_id=user_id,
        name="Baileys Identity Line",
        display_phone_number=line_phone,
        phone_number_e164=line_phone,
        provider=WhatsAppNumberProvider.BAILEYS_QR,
        status=WhatsAppNumberStatus.ACTIVE,
    )
    db.add(wanum)
    await db.flush()

    sess = WhatsAppSession(
        user_id=user_id,
        whatsapp_number_id=wanum.id,
        session_name=f"sess_{uuid.uuid4().hex[:8]}",
        phone_number=line_phone,
        status=session_status,
        max_daily_limit=100,
        daily_sent_count=0,
    )
    db.add(sess)

    contact = Contact(user_id=user_id, phone_e164=_dyn_phone("+9054"), display_name="Identity Customer")
    db.add(contact)
    await db.flush()

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    conv = Conversation(
        user_id=user_id,
        whatsapp_number_id=wanum.id,
        contact_id=contact.id,
        channel="WHATSAPP",
        status=ConversationStatus.ACTIVE,
        last_message_at=now,
    )
    db.add(conv)
    await db.commit()
    await db.refresh(wanum)
    await db.refresh(sess)
    await db.refresh(contact)
    await db.refresh(conv)
    return wanum, sess, contact, conv


def test_00_canonical_status_model_includes_pending():
    """DB model, state machine, and frontend contract agree on PENDING."""
    assert ConversationMessageStatus.PENDING.value == "PENDING"
    assert ConversationMessageStatus.SENT.value == "SENT"
    assert ConversationMessageStatus.FAILED.value == "FAILED"
    # FAILED -> PENDING is the single intentional re-queue edge for /retry.
    from backend.app.services.message_state_machine import MessageStateMachine
    assert MessageStateMachine.can_transition(
        ConversationMessageStatus.FAILED, ConversationMessageStatus.PENDING
    ) is True
    assert MessageStateMachine.can_transition(
        ConversationMessageStatus.PENDING, ConversationMessageStatus.SENT
    ) is True
    # Direct FAILED -> SENT stays forbidden: every dispatch passes outbox.
    assert MessageStateMachine.can_transition(
        ConversationMessageStatus.FAILED, ConversationMessageStatus.SENT
    ) is False


def test_00b_enum_migration_covers_model_values():
    """Startup migration targets every model enum value (no silent PG drift)."""
    import inspect
    from backend.app.core import migrations as mig

    assert hasattr(mig, "ensure_message_status_enum")
    src = inspect.getsource(mig.ensure_message_status_enum)
    for value in ("PENDING", "SENT", "DELIVERED", "READ", "FAILED", "RECEIVED"):
        assert value in [e.value for e in ConversationMessageStatus]
    assert "conversationmessagestatus" in src
    assert "ALTER TYPE" in src
    assert "AUTOCOMMIT" in src


@pytest.mark.asyncio
async def test_01_post_returns_pending_with_real_db_id():
    """POST creates PENDING message with real numeric id + cmsg idempotency key."""
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    client_mid = f"cmsg_{uuid.uuid4().hex[:12]}"
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "selam", "type": "text", "client_message_id": client_mid},
                headers={"Authorization": f"Bearer {token}"},
            )
    assert res.status_code == 201, res.text
    data = res.json()
    assert isinstance(data["id"], int) and data["id"] > 0
    assert data["status"] == "PENDING"
    assert data["direction"] == "OUTBOUND"
    assert data["body"] == "selam"
    assert data["client_message_id"] == client_mid
    assert data["wa_message_id"] is None

    async with AsyncSessionLocal() as db:
        msg = await db.get(Message, data["id"])
        assert msg is not None
        assert msg.status == ConversationMessageStatus.PENDING
        outbox = (
            await db.execute(select(OutboxMessage).where(OutboxMessage.message_id == data["id"]))
        ).scalar_one_or_none()
        assert outbox is not None
        assert outbox.status == OutboxMessageStatus.PENDING


@pytest.mark.asyncio
async def test_02_repeated_client_message_id_is_idempotent():
    """Same client_message_id never creates a duplicate Message or send."""
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    client_mid = f"cmsg_{uuid.uuid4().hex[:12]}"
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            first = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "selam", "type": "text", "client_message_id": client_mid},
                headers={"Authorization": f"Bearer {token}"},
            )
            second = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "selam", "type": "text", "client_message_id": client_mid},
                headers={"Authorization": f"Bearer {token}"},
            )
    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["id"] == second.json()["id"]

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(select(Message).where(Message.client_message_id == client_mid))
        ).scalars().all()
        assert len(rows) == 1


@pytest.mark.asyncio
async def test_03_worker_persists_real_baileys_key_and_broadcasts_db_id():
    """Worker stores the real Baileys key.id and broadcasts the numeric DB id."""
    user_id = str(uuid.uuid4())
    real_wamid = f"BAILEYS.{uuid.uuid4().hex[:16]}@s.whatsapp.net"
    async with AsyncSessionLocal() as db:
        wanum, _, contact, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="selam",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex[:12]}",
            status=ConversationMessageStatus.PENDING,
            created_at=now,
            updated_at=now,
        )
        db.add(msg)
        await db.flush()
        outbox = OutboxMessage(
            user_id=user_id,
            message_id=msg.id,
            whatsapp_number_id=wanum.id,
            event_type="SEND_MESSAGE",
            payload_json=json.dumps({"message_type": "text", "provider": "BAILEYS_QR"}),
            status=OutboxMessageStatus.PENDING,
            available_at=now,
            created_at=now,
        )
        db.add(outbox)
        await db.commit()
        outbox_id, msg_id = outbox.id, msg.id

    broadcasts: list = []

    async def _capture(payload):
        broadcasts.append(payload)

    with patch.object(
        gateway_client, "send_message", new_callable=AsyncMock,
        return_value={"success": True, "messageId": real_wamid},
    ), patch.object(ws_manager, "broadcast", new=AsyncMock(side_effect=_capture)):
        async with AsyncSessionLocal() as db:
            result = await OutboundWorker.process_outbox_job(outbox_id, db)

    assert result["status"] == "sent"
    assert result["wamid"] == real_wamid
    async with AsyncSessionLocal() as db:
        updated = await db.get(Message, msg_id)
        assert updated.status == ConversationMessageStatus.SENT
        assert updated.wa_message_id == real_wamid
    assert broadcasts, "worker must broadcast message_status_updated post-commit"
    event = broadcasts[-1]
    assert event["event"] == "message_status_updated"
    assert event["status"] == "SENT"
    assert event["message_id"] == msg_id and isinstance(event["message_id"], int)
    assert event["wa_message_id"] == real_wamid


@pytest.mark.asyncio
async def test_04_retry_rejects_optimistic_and_negative_ids():
    """Fake client-only IDs never reach the database (422, no SQL execution)."""
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        neg = await client.post(
            f"/api/v1/conversations/{conv_id}/messages/-1789054089553/retry",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert neg.status_code == 422
        zero = await client.post(
            f"/api/v1/conversations/{conv_id}/messages/0/retry",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert zero.status_code == 422


@pytest.mark.asyncio
async def test_05_retry_failed_requeues_pending_and_worker_sends():
    """FAILED --retry--> PENDING + fresh outbox --worker--> SENT (no duplicate)."""
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, _, contact, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="selam",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex[:12]}",
            status=ConversationMessageStatus.FAILED,
            error_message="Gateway 502",
            created_at=now,
            updated_at=now,
        )
        db.add(msg)
        await db.commit()
        await db.refresh(msg)
        conv_id, msg_id = conv.id, msg.id

    token = _make_jwt(user_id)
    real_wamid = f"BAILEYS.{uuid.uuid4().hex[:16]}"
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()) as mock_bg:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages/{msg_id}/retry",
                headers={"Authorization": f"Bearer {token}"},
            )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["id"] == msg_id
    assert data["status"] == "PENDING"
    mock_bg.assert_called_once()

    async with AsyncSessionLocal() as db:
        outbox = (
            await db.execute(select(OutboxMessage).where(OutboxMessage.message_id == msg_id))
        ).scalars().all()
        assert len(outbox) == 1
        assert outbox[0].status == OutboxMessageStatus.PENDING
        outbox_id = outbox[0].id

    with patch.object(
        gateway_client, "send_message", new_callable=AsyncMock,
        return_value={"success": True, "messageId": real_wamid},
    ):
        async with AsyncSessionLocal() as db:
            result = await OutboundWorker.process_outbox_job(outbox_id, db)
    assert result["status"] == "sent"
    async with AsyncSessionLocal() as db:
        updated = await db.get(Message, msg_id)
        assert updated.status == ConversationMessageStatus.SENT
        assert updated.wa_message_id == real_wamid


@pytest.mark.asyncio
async def test_06_retry_non_failed_is_conflict():
    """Retrying a PENDING/SENT message is rejected (no duplicate dispatch)."""
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="selam",
            sender_phone="+905300000001",
            recipient_phone="+905400000001",
            client_message_id=f"cmsg_{uuid.uuid4().hex[:12]}",
            status=ConversationMessageStatus.PENDING,
            created_at=now,
            updated_at=now,
        )
        db.add(msg)
        await db.commit()
        await db.refresh(msg)
        conv_id, msg_id = conv.id, msg.id

    token = _make_jwt(user_id)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages/{msg_id}/retry",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_07_disconnected_session_fails_cleanly():
    """BAILEYS_QR without CONNECTED session fails with 400 (no gateway call)."""
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id, SessionStatus.DISCONNECTED)
        conv_id = conv.id

    token = _make_jwt(user_id)
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()), patch.object(
        gateway_client, "send_message", new_callable=AsyncMock
    ) as mock_send:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "selam", "type": "text"},
                headers={"Authorization": f"Bearer {token}"},
            )
    assert res.status_code == 400
    assert "bağlı değil" in res.json()["detail"]
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_08_baileys_bypasses_meta_24h_window():
    """BAILEYS_QR freeform text is accepted even with an expired Meta window."""
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, _, contact, conv = await _create_baileys_setup(db, user_id)
        conv.customer_service_window_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=5)
        await db.commit()
        conv_id = conv.id

    token = _make_jwt(user_id)
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "selam", "type": "text"},
                headers={"Authorization": f"Bearer {token}"},
            )
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "PENDING"


@pytest.mark.asyncio
async def test_09_tenant_isolation_on_retry():
    """Another tenant cannot retry a message they do not own."""
    user_a, user_b = str(uuid.uuid4()), str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv_b = await _create_baileys_setup(db, user_b)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_b,
            conversation_id=conv_b.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="selam",
            sender_phone="+905300000001",
            recipient_phone="+905400000001",
            client_message_id=f"cmsg_{uuid.uuid4().hex[:12]}",
            status=ConversationMessageStatus.FAILED,
            created_at=now,
            updated_at=now,
        )
        db.add(msg)
        await db.commit()
        await db.refresh(msg)
        conv_id, msg_id = conv_b.id, msg.id

    token_a = _make_jwt(user_a)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages/{msg_id}/retry",
            headers={"Authorization": f"Bearer {token_a}"},
        )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_10_delete_session_clears_all_live_dialogs():
    """Product rule: deleting a line wipes the whole live-dialog list."""
    from backend.app.models.lead import Lead

    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum_a, sess_a, _, conv_a = await _create_baileys_setup(db, user_id)
        # Second line + second synced chat for the same user.
        wanum_b, sess_b, _, conv_b = await _create_baileys_setup(db, user_id)
        lead = Lead(
            user_id=user_id,
            name="Synced Chat",
            phone=_dyn_phone("+9054"),
            phone_e164=_dyn_phone("+9054"),
            place_id=f"wa_{uuid.uuid4().hex[:16]}",
            category="WhatsApp Sohbeti",
        )
        db.add(lead)
        await db.commit()
        sess_a_id = sess_a.id
        conv_ids = [conv_a.id, conv_b.id]

    token = _make_jwt(user_id)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.delete(
            f"/api/v1/whatsapp/sessions/{sess_a_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert res.status_code == 204, res.text

    async with AsyncSessionLocal() as db:
        remaining_convs = (
            await db.execute(select(Conversation).where(Conversation.id.in_(conv_ids)))
        ).scalars().all()
        assert remaining_convs == []
        remaining_synced = (
            await db.execute(
                select(Lead).where(
                    Lead.user_id == user_id,
                    Lead.category.in_(["WhatsApp Grubu", "WhatsApp Sohbeti", "WhatsApp Kişisi"]),
                )
            )
        ).scalars().all()
        assert remaining_synced == []


@pytest.mark.asyncio
async def test_11_template_send_persists_naive_datetimes():
    """Regression: template send must not write tz-aware datetimes to PG."""
    from backend.app.models.lead import Lead, LeadStatus
    from backend.app.services.whatsapp_template_service import WhatsAppTemplateService

    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        lead = Lead(
            user_id=user_id,
            name="Template Lead",
            phone=_dyn_phone("+9054"),
            phone_e164=_dyn_phone("+9054"),
            place_id=f"tmpl_{uuid.uuid4().hex[:16]}",
            status=LeadStatus.NEW,
        )
        db.add(lead)
        await db.flush()
        conv = Conversation(
            user_id=user_id,
            lead_id=lead.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        conv_id = conv.id

    async with AsyncSessionLocal() as db:
        msg = await WhatsAppTemplateService.send_template_message(
            db=db,
            conversation_id=conv_id,
            template_key="welcome_intro",
            variables={},
            force_simulation=True,
        )
        assert msg.status == ConversationMessageStatus.SENT
        for value in (msg.created_at, msg.updated_at, msg.external_timestamp):
            assert value is not None and value.tzinfo is None
        refreshed = await db.get(Conversation, conv_id)
        assert refreshed.last_message_at is not None and refreshed.last_message_at.tzinfo is None


@pytest.mark.asyncio
async def test_12_legacy_chat_window_open_with_connected_line():
    """Baileys hattı bağlıyken lead-bazlı sohbette şablonsuz yazışma açık görünür."""
    from backend.app.models.lead import Lead, LeadStatus

    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, _, _ = await _create_baileys_setup(db, user_id)
        old_inbound_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=30)
        lead = Lead(
            user_id=user_id,
            name="Legacy Chat",
            phone=_dyn_phone("+9054"),
            phone_e164=_dyn_phone("+9054"),
            place_id=f"legacy_{uuid.uuid4().hex[:16]}",
            status=LeadStatus.NEW,
        )
        db.add(lead)
        await db.flush()
        conv = Conversation(
            user_id=user_id,
            lead_id=lead.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()
        db.add(
            Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="eski mesaj",
                sender_phone=lead.phone_e164,
                recipient_phone=wanum.phone_number_e164,
                status=ConversationMessageStatus.RECEIVED,
                created_at=old_inbound_at,
                updated_at=old_inbound_at,
            )
        )
        await db.commit()
        conv_id = conv.id

    token = _make_jwt(user_id)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(
            f"/api/v1/conversations/{conv_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert res.status_code == 200, res.text
    assert res.json()["is_window_open"] is True


def test_13_state_machine_default_event_time_is_naive():
    """MessageStateMachine default timestamps must survive asyncpg TIMESTAMP."""
    from backend.app.services.message_state_machine import MessageStateMachine

    msg = Message(
        conversation_id=1,
        direction=MessageDirection.OUTBOUND,
        message_type=MessageType.TEXT,
        body="selam",
        sender_phone="+905300000001",
        recipient_phone="+905400000001",
        status=ConversationMessageStatus.PENDING,
    )
    MessageStateMachine.transition(msg, ConversationMessageStatus.SENT)
    assert msg.sent_at is not None and msg.sent_at.tzinfo is None
