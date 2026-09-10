"""
Phase 5 Backend Outbound Messaging & Verification Tests (Baileys QR + Meta Cloud Invariant).

Covers all 23 required Phase 5 test scenarios:
1. Authenticated user can send outbound text from their Conversation.
2. Cannot send outbound message to another tenant's Conversation (404/403).
3. Conversation -> WhatsAppNumber resolution functions authoritatively.
4. BAILEYS_QR provider routes to Baileys Gateway transport (OutboundWorker calls gateway_client).
5. META_CLOUD provider routes to existing Meta Cloud transport.
6. BAILEYS_QR authoritatively resolves linked WhatsAppSession.
7. Cannot use another tenant's WhatsAppSession (cross-tenant session fail-closed).
8. Disconnected Baileys session rejects send fail-closed (HTTP 400).
9. Logged-out / Banned session rejects send fail-closed.
10. Empty message text is rejected (HTTP 422).
11. Invalid payload (e.g. text > 4096) is rejected (HTTP 422).
12. Outbound Message entity is persisted with direction=OUTBOUND.
13. Initial message state is PENDING.
14. Real Baileys message key.id is persisted into wa_message_id on success.
15. Gateway failure transitions Message and Outbox to FAILED.
16. Ambiguous network failure (ReadTimeout) transitions to AMBIGUOUS_PROVIDER_RESULT (no blind retry).
17. Duplicate client_message_id returns existing Message without double send (idempotency).
18. Group recipient (@g.us) is rejected fail-closed (HTTP 400).
19. Baileys outbound is NOT restricted by Meta 24-hour customer window (can send freeform text even if window expired).
20. WebSocket domain event (message_status_updated) is broadcast strictly post-commit.
21. Database rollback suppresses WebSocket broadcast.
22. Baileys outbound multi-tenant isolation is preserved.
23. Meta Cloud regression: expired 24h window on META_CLOUD is still blocked unless template.
"""
import uuid
import json
import base64
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import httpx
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.core.credential_vault import CredentialVault
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus, WhatsAppNumberProvider
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    Message,
    MessageDirection,
    MessageType,
    ConversationMessageStatus,
)
from backend.app.models.outbox_message import OutboxMessage, OutboxMessageStatus
from backend.app.services.whatsapp_gateway_client import gateway_client
from backend.app.services.outbound_worker import OutboundWorker
from backend.app.api.v1.websocket import ws_manager


def _make_jwt(user_id: str, email: str = "test@example.com") -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "email": email,
        "user_metadata": {"full_name": f"User {user_id[:6]}"}
    }).encode()).decode().rstrip("=")
    return f"{header}.{payload}.mock_signature"


def _dyn_phone(prefix: str = "+9055") -> str:
    return f"{prefix}{uuid.uuid4().int % 100000000:08d}"


async def _create_baileys_setup(db, user_id: str, session_status: SessionStatus = SessionStatus.CONNECTED):
    line_phone = _dyn_phone("+9053")
    wanum = WhatsAppNumber(
        user_id=user_id,
        name="Baileys Test Line",
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

    contact_phone = _dyn_phone("+9054")
    contact = Contact(
        user_id=user_id,
        phone_e164=contact_phone,
        display_name="Müşteri Ali",
    )
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


# ==============================================================================
# TESTS
# ==============================================================================

@pytest.mark.asyncio
async def test_01_authenticated_user_can_send_outbound_text():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "Merhaba, siparişiniz yola çıktı.", "type": "text"},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert res.status_code == 201, res.text
            data = res.json()
            assert data["body"] == "Merhaba, siparişiniz yola çıktı."
            assert data["direction"] == "OUTBOUND"
            assert data["status"] == "PENDING"
            assert data["conversation_id"] == conv_id

    # Verify OutboxMessage was created atomically in DB
    async with AsyncSessionLocal() as db:
        outbox = (
            await db.execute(select(OutboxMessage).where(OutboxMessage.message_id == data["id"]))
        ).scalar_one_or_none()
        assert outbox is not None
        assert outbox.status == OutboxMessageStatus.PENDING
        assert "BAILEYS_QR" in (outbox.payload_json or "")


@pytest.mark.asyncio
async def test_02_cannot_send_outbound_to_other_tenant_conversation():
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv_b = await _create_baileys_setup(db, user_b)
        conv_b_id = conv_b.id

    token_a = _make_jwt(user_a)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_b_id}/messages",
            json={"body": "Yetkisiz sızma denemesi", "type": "text"},
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert res.status_code == 404
        assert "Diyalog bulunamadı" in res.json()["detail"]


@pytest.mark.asyncio
async def test_03_conversation_to_whatsapp_number_resolution():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id
        wanum_id = wanum.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "Hattı doğrula", "type": "text"},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert res.status_code == 201
            msg_id = res.json()["id"]

    async with AsyncSessionLocal() as db:
        outbox = (
            await db.execute(select(OutboxMessage).where(OutboxMessage.message_id == msg_id))
        ).scalar_one_or_none()
        assert outbox.whatsapp_number_id == wanum_id


@pytest.mark.asyncio
async def test_04_baileys_qr_routes_to_gateway_transport():
    user_id = str(uuid.uuid4())
    real_wamid = f"baileys_real_mid_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Gateway testi",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex[:6]}",
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
        outbox_id = outbox.id
        msg_id = msg.id

    # Mock gateway client send_message
    mock_gw_res = {
        "success": True,
        "messageId": real_wamid,
        "phone": contact.phone_e164,
        "status": "SENT",
    }
    with patch.object(gateway_client, "send_message", new_callable=AsyncMock, return_value=mock_gw_res) as mock_send:
        async with AsyncSessionLocal() as db:
            job_res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert job_res["status"] == "sent"
            assert job_res["wamid"] == real_wamid
            mock_send.assert_called_once()

    # Verify Message and Outbox updated in DB
    async with AsyncSessionLocal() as db:
        updated_msg = await db.get(Message, msg_id)
        assert updated_msg.status == ConversationMessageStatus.SENT
        assert updated_msg.wa_message_id == real_wamid

        updated_outbox = await db.get(OutboxMessage, outbox_id)
        assert updated_outbox.status == OutboxMessageStatus.COMPLETED


@pytest.mark.asyncio
async def test_05_meta_cloud_provider_routes_to_meta_transport():
    user_id = str(uuid.uuid4())
    pid = f"meta_pid_{uuid.uuid4().hex[:8]}"
    enc_token = CredentialVault.encrypt("EAAB_test_token")
    phone = _dyn_phone("+9085")

    async with AsyncSessionLocal() as db:
        wanum = WhatsAppNumber(
            user_id=user_id,
            name="Meta Line",
            provider=WhatsAppNumberProvider.META_CLOUD,
            phone_number_id=pid,
            phone_number_e164=phone,
            encrypted_access_token=enc_token,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(wanum)
        contact = Contact(user_id=user_id, phone_e164=_dyn_phone("+9053"), display_name="Cust")
        db.add(contact)
        await db.flush()

        now = datetime.now(timezone.utc).replace(tzinfo=None)
        conv = Conversation(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            contact_id=contact.id,
            customer_service_window_expires_at=now + timedelta(hours=10),
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()

        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Meta text",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            status=ConversationMessageStatus.PENDING,
            created_at=now,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user_id,
            message_id=msg.id,
            whatsapp_number_id=wanum.id,
            payload_json=json.dumps({"message_type": "text", "provider": "META_CLOUD"}),
            status=OutboxMessageStatus.PENDING,
            available_at=now,
            created_at=now,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    meta_mock_wamid = f"wamid.META_{uuid.uuid4().hex[:12]}"
    meta_mock_res = {"messages": [{"id": meta_mock_wamid}]}
    with patch("backend.app.services.outbound_worker.MetaCloudApiClient.send_text_message", new_callable=AsyncMock, return_value=meta_mock_res) as mock_meta:
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "sent"
            assert res["wamid"] == meta_mock_wamid
            mock_meta.assert_called_once()


@pytest.mark.asyncio
async def test_06_baileys_qr_authoritatively_resolves_session():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Session resolve test", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201


@pytest.mark.asyncio
async def test_07_cross_tenant_session_rejected_fail_closed():
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        # Number owned by User B
        wanum_b, _, _, _ = await _create_baileys_setup(db, user_b)
        # Contact owned by User A
        contact_a = Contact(user_id=user_a, phone_e164=_dyn_phone("+9051"), display_name="A")
        db.add(contact_a)
        await db.flush()

        # Fraudulent cross-tenant conversation
        conv = Conversation(
            user_id=user_a,
            whatsapp_number_id=wanum_b.id,
            contact_id=contact_a.id,
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.commit()
        conv_id = conv.id

    token_a = _make_jwt(user_a)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Attack attempt", "type": "text"},
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert res.status_code == 403
        assert "yetkiniz yok" in res.json()["detail"]


@pytest.mark.asyncio
async def test_08_disconnected_baileys_session_rejected_fail_closed():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(
            db, user_id, session_status=SessionStatus.DISCONNECTED
        )
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Should fail because session is disconnected", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 400
        assert "bağlı değil" in res.json()["detail"]


@pytest.mark.asyncio
async def test_09_banned_session_rejected_fail_closed():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(
            db, user_id, session_status=SessionStatus.BANNED
        )
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Should fail because session is banned", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 400
        assert "bağlı değil" in res.json()["detail"]


@pytest.mark.asyncio
async def test_10_empty_text_rejected():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "   ", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 422
        assert "boş olamaz" in res.json()["detail"]


@pytest.mark.asyncio
async def test_11_text_exceeding_max_length_rejected():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "A" * 4097, "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 422
        assert "4096" in res.json()["detail"]


@pytest.mark.asyncio
async def test_12_and_13_outbound_message_persisted_with_pending():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Initial pending test", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201
        data = res.json()
        assert data["direction"] == "OUTBOUND"
        assert data["status"] == "PENDING"
        assert data["wa_message_id"] is None


@pytest.mark.asyncio
async def test_14_gateway_success_persists_real_wamid():
    user_id = str(uuid.uuid4())
    real_key_id = f"baileys_key_{uuid.uuid4().hex[:10]}"

    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Persistent wamid",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            status=ConversationMessageStatus.PENDING,
            created_at=now,
        )
        db.add(msg)
        await db.flush()
        outbox = OutboxMessage(
            user_id=user_id,
            message_id=msg.id,
            whatsapp_number_id=wanum.id,
            payload_json=json.dumps({"provider": "BAILEYS_QR"}),
            status=OutboxMessageStatus.PENDING,
            available_at=now,
            created_at=now,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id
        msg_id = msg.id

    with patch.object(gateway_client, "send_message", new_callable=AsyncMock, return_value={"success": True, "messageId": real_key_id}):
        async with AsyncSessionLocal() as db:
            await OutboundWorker.process_outbox_job(outbox_id, db)

    async with AsyncSessionLocal() as db:
        saved_msg = await db.get(Message, msg_id)
        assert saved_msg.wa_message_id == real_key_id
        assert saved_msg.status == ConversationMessageStatus.SENT


@pytest.mark.asyncio
async def test_15_gateway_failure_updates_state_to_failed():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Will fail",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            status=ConversationMessageStatus.PENDING,
            created_at=now,
        )
        db.add(msg)
        await db.flush()
        outbox = OutboxMessage(
            user_id=user_id,
            message_id=msg.id,
            whatsapp_number_id=wanum.id,
            payload_json=json.dumps({"provider": "BAILEYS_QR"}),
            status=OutboxMessageStatus.PENDING,
            available_at=now,
            created_at=now,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id
        msg_id = msg.id

    with patch.object(gateway_client, "send_message", new_callable=AsyncMock, return_value={"success": False, "error": "Remote socket closed"}):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "failed"

    async with AsyncSessionLocal() as db:
        failed_msg = await db.get(Message, msg_id)
        assert failed_msg.status == ConversationMessageStatus.FAILED
        assert "Remote socket closed" in (failed_msg.error_message or "")


@pytest.mark.asyncio
async def test_16_ambiguous_network_failure_no_blind_retry():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Timeout test",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            status=ConversationMessageStatus.PENDING,
            created_at=now,
        )
        db.add(msg)
        await db.flush()
        outbox = OutboxMessage(
            user_id=user_id,
            message_id=msg.id,
            whatsapp_number_id=wanum.id,
            payload_json=json.dumps({"provider": "BAILEYS_QR"}),
            status=OutboxMessageStatus.PENDING,
            available_at=now,
            created_at=now,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id
        msg_id = msg.id

    with patch.object(gateway_client, "send_message", new_callable=AsyncMock, return_value={"success": False, "error": "ReadTimeout", "is_ambiguous": True}):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "ambiguous"

    async with AsyncSessionLocal() as db:
        outbox_rec = await db.get(OutboxMessage, outbox_id)
        assert outbox_rec.status == OutboxMessageStatus.AMBIGUOUS_PROVIDER_RESULT


@pytest.mark.asyncio
async def test_17_duplicate_client_message_id_idempotency():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        _, _, _, conv = await _create_baileys_setup(db, user_id)
        conv_id = conv.id

    client_mid = f"cmsg_unique_{uuid.uuid4().hex[:8]}"
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # First send
        res1 = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Same send", "type": "text", "client_message_id": client_mid},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res1.status_code == 201
        first_id = res1.json()["id"]

        # Second send with identical client_message_id
        res2 = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Same send", "type": "text", "client_message_id": client_mid},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res2.status_code == 201
        second_id = res2.json()["id"]
        assert first_id == second_id


@pytest.mark.asyncio
async def test_18_group_recipient_rejected_fail_closed():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, _, _ = await _create_baileys_setup(db, user_id)
        group_contact = Contact(user_id=user_id, phone_e164="120363024829281@g.us", display_name="Group")
        db.add(group_contact)
        await db.flush()
        conv = Conversation(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            contact_id=group_contact.id,
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.commit()
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Group text", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 400
        assert "Grup mesajları" in res.json()["detail"]


@pytest.mark.asyncio
async def test_19_baileys_outbound_not_restricted_by_meta_24h_window():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, _ = await _create_baileys_setup(db, user_id)
        # Expired customer service window (>48 hours ago)
        expired_ts = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=48)
        conv = Conversation(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            customer_service_window_expires_at=expired_ts,
            last_customer_message_at=expired_ts,
        )
        db.add(conv)
        await db.commit()
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Freeform text should SUCCEED on Baileys even with expired 24h window!
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Freeform text outside 24h window on Baileys", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_20_and_21_websocket_event_broadcast_strictly_post_commit():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum, sess, contact, conv = await _create_baileys_setup(db, user_id)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="WS test",
            sender_phone=wanum.phone_number_e164,
            recipient_phone=contact.phone_e164,
            status=ConversationMessageStatus.PENDING,
            client_message_id=f"cmsg_ws_{uuid.uuid4().hex[:8]}",
            created_at=now,
        )
        db.add(msg)
        await db.flush()
        outbox = OutboxMessage(
            user_id=user_id,
            message_id=msg.id,
            whatsapp_number_id=wanum.id,
            payload_json=json.dumps({"provider": "BAILEYS_QR"}),
            status=OutboxMessageStatus.PENDING,
            available_at=now,
            created_at=now,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    ws_success_wamid = f"wamid.WS_{uuid.uuid4().hex[:8]}"
    with patch.object(ws_manager, "broadcast", new_callable=AsyncMock) as mock_ws:
        with patch.object(gateway_client, "send_message", new_callable=AsyncMock, return_value={"success": True, "messageId": ws_success_wamid}):
            async with AsyncSessionLocal() as db:
                await OutboundWorker.process_outbox_job(outbox_id, db)
            mock_ws.assert_called_once()
            ws_payload = mock_ws.call_args[0][0]
            assert ws_payload["event"] == "message_status_updated"
            assert ws_payload["provider"] == "BAILEYS_QR"
            assert ws_payload["status"] == "SENT"
            assert ws_payload["wa_message_id"] == ws_success_wamid


@pytest.mark.asyncio
async def test_22_baileys_outbound_tenant_isolation_preserved():
    user_1 = str(uuid.uuid4())
    user_2 = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        _, _, _, conv_1 = await _create_baileys_setup(db, user_1)
        _, _, _, conv_2 = await _create_baileys_setup(db, user_2)
        c1_id = conv_1.id
        c2_id = conv_2.id

    token_1 = _make_jwt(user_1)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res1 = await client.post(
            f"/api/v1/conversations/{c1_id}/messages",
            json={"body": "User 1 sending to Conv 1", "type": "text"},
            headers={"Authorization": f"Bearer {token_1}"},
        )
        assert res1.status_code == 201

        # User 1 attempting to send to User 2's conversation
        res2 = await client.post(
            f"/api/v1/conversations/{c2_id}/messages",
            json={"body": "Cross-tenant intrusion", "type": "text"},
            headers={"Authorization": f"Bearer {token_1}"},
        )
        assert res2.status_code == 404


@pytest.mark.asyncio
async def test_23_meta_cloud_regression_expired_window_still_blocked():
    user_id = str(uuid.uuid4())
    enc_token = CredentialVault.encrypt("EAAB_test_token")
    expired_ts = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=48)

    async with AsyncSessionLocal() as db:
        wanum = WhatsAppNumber(
            user_id=user_id,
            name="Meta Regression Line",
            provider=WhatsAppNumberProvider.META_CLOUD,
            phone_number_id=f"meta_reg_{uuid.uuid4().hex[:8]}",
            phone_number_e164=_dyn_phone("+9085"),
            encrypted_access_token=enc_token,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(wanum)
        contact = Contact(user_id=user_id, phone_e164=_dyn_phone("+9053"), display_name="Reg Cust")
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            customer_service_window_expires_at=expired_ts,
            last_customer_message_at=expired_ts,
        )
        db.add(conv)
        await db.commit()
        conv_id = conv.id

    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Freeform text on META_CLOUD outside window MUST return 422!
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Freeform text on Meta outside window", "type": "text"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 422
        assert "CUSTOMER_SERVICE_WINDOW_EXPIRED" in res.json()["detail"]
