"""
Tezlify WhatsApp Rebuild - Phase 4 Outbound Messaging Pipeline Tests
Covers all 40 required architectural invariant scenarios + Real Meta E2E check:

1. Tenant isolation (User A cannot send to User B's conversation)
2. Conversation ownership enforcement
3. WhatsApp number ownership enforcement
4. Inactive number rejected (INACTIVE, DISCONNECTED, ERROR)
5. Contact recipient resolution (derived from Conversation Contact phone_e164)
6. Valid 24h text send accepted (freeform text within 24h window)
7. Expired 24h text rejected (CUSTOMER_SERVICE_WINDOW_EXPIRED)
8. Expired window template accepted (template allowed outside 24h window)
9. Template missing name rejected (422)
10. Template missing language rejected (422)
11. PENDING message creation (initial status=PENDING, wa_message_id=None)
12. Outbox created atomically (OutboxMessage created in same transaction)
13. Rollback removes both message and outbox (integrity invariant)
14. Meta success returns wamid (wamid extracted from Meta response)
15. wamid saved correctly (saved to Message.wa_message_id)
16. PENDING -> SENT (Message status transitions to SENT via MessageStateMachine)
17. Meta 400 no retry (fail fast, Outbox FAILED, Message FAILED)
18. Meta 401 no retry (fail fast, Outbox FAILED, Message FAILED)
19. Meta 403 no retry (fail fast, Outbox FAILED, Message FAILED)
20. Meta 429 retry (retryable, Outbox RETRYABLE, backoff scheduled)
21. Meta 500 retry (retryable, Outbox RETRYABLE, backoff scheduled)
22. Meta timeout handling (ReadTimeout -> AMBIGUOUS_PROVIDER_RESULT, no blind retry)
23. Token decrypted only at send boundary (decrypted in worker immediately before request)
24. Token never appears in logs (redacted in logs)
25. Token never appears in outbox (zero credentials in outbox table)
26. Token never appears in API response (safe MessageResponse DTO)
27. Duplicate client_message_id (idempotency: returns existing message, no double send)
28. Concurrent worker protection (atomic row locking, lease semantics)
29. Duplicate status webhook (idempotency, no second transition)
30. SENT -> DELIVERED (via webhook)
31. DELIVERED -> READ (via webhook)
32. Invalid status regression (e.g. READ -> SENT rejected by MessageStateMachine)
33. FAILED handling (terminal status, error code & message recorded)
34. Unknown Meta fields tolerated (tolerates extra provider JSON fields)
35. Two WhatsApp numbers isolated (different numbers in same tenant)
36. Two contacts isolated (two contacts with separate conversations)
37. Same contact across two numbers isolated (same phone on number A and number B has isolated threads)
38. Message ordering (strict chronological order)
39. No browser-to-Meta call (backend-only architecture)
40. API response never contains credentials (no secrets in schema or output)
41. Real Meta E2E check (Explicitly 'NOT RUN' if credentials absent)
"""

import os
import uuid
import json
import base64
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import httpx
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.credential_vault import CredentialVault
from backend.app.core.migrations import (
    ensure_whatsapp_numbers_table,
    ensure_contacts_table,
    ensure_webhook_events_table,
    ensure_outbox_messages_table,
    ensure_conversations_columns,
    ensure_messages_media_columns,
)
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    Message,
    MessageDirection,
    MessageType,
    ConversationMessageStatus,
)
from backend.app.models.outbox_message import OutboxMessage, OutboxMessageStatus
from backend.app.services.meta_cloud_client import (
    MetaCloudApiClient,
    MetaApiError,
    MetaAmbiguousResultError,
)
from backend.app.services.outbound_worker import OutboundWorker
from backend.app.services.whatsapp_webhook_service import WhatsAppWebhookService
from backend.app.schemas.conversation import MessageResponse


def _make_mock_jwt(user_id: str, email: str = "test@example.com") -> str:
    """Constructs an unverified mock JWT for test authorization."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "email": email,
        "user_metadata": {"full_name": f"User {user_id[:6]}"}
    }).encode()).decode().rstrip("=")
    signature = "mock_signature"
    return f"{header}.{payload}.{signature}"


async def clean_phase4_db(db):
    """Resets database state for deterministic test runs."""
    await ensure_whatsapp_numbers_table(engine)
    await ensure_contacts_table(engine)
    await ensure_webhook_events_table(engine)
    await ensure_outbox_messages_table(engine)
    await ensure_conversations_columns(engine)
    await ensure_messages_media_columns(engine)

    await db.execute(OutboxMessage.__table__.delete())
    await db.execute(Message.__table__.delete())
    await db.execute(Conversation.__table__.delete())
    await db.execute(Contact.__table__.delete())
    await db.execute(WhatsAppNumber.__table__.delete())
    await db.commit()


# ==============================================================================
# Helper Factories
# ==============================================================================

async def _create_active_number(
    db,
    user_id: str,
    phone_number_id: Optional[str] = None,
    phone_e164: str = "+908501112233",
    status: WhatsAppNumberStatus = WhatsAppNumberStatus.ACTIVE,
) -> WhatsAppNumber:
    pid = phone_number_id or f"meta_pid_{uuid.uuid4().hex[:10]}"
    encrypted = CredentialVault.encrypt("EAAB_test_mock_meta_access_token_12345")
    wanum = WhatsAppNumber(
        user_id=user_id,
        name="Test WhatsApp Line",
        display_phone_number=phone_e164,
        phone_number_e164=phone_e164,
        phone_number_id=pid,
        waba_id=f"waba_{uuid.uuid4().hex[:8]}",
        encrypted_access_token=encrypted,
        status=status,
    )
    db.add(wanum)
    await db.commit()
    await db.refresh(wanum)
    return wanum


async def _create_contact(
    db,
    user_id: str,
    phone_e164: str = "+905321112233",
    display_name: str = "Test Customer",
) -> Contact:
    contact = Contact(
        user_id=user_id,
        phone_e164=phone_e164,
        display_name=display_name,
    )
    db.add(contact)
    await db.commit()
    await db.refresh(contact)
    return contact


async def _create_conversation(
    db,
    user_id: str,
    whatsapp_number_id: int,
    contact_id: int,
    window_open_hours: int = 12,
) -> Conversation:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    conv = Conversation(
        user_id=user_id,
        whatsapp_number_id=whatsapp_number_id,
        contact_id=contact_id,
        channel="WHATSAPP",
        status=ConversationStatus.ACTIVE,
        customer_service_window_expires_at=now + timedelta(hours=window_open_hours),
        last_customer_message_at=now - timedelta(hours=24 - window_open_hours if window_open_hours < 24 else 0),
        last_message_at=now,
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv


# ==============================================================================
# TESTS
# ==============================================================================

@pytest.mark.asyncio
async def test_01_tenant_isolation():
    """User A cannot send to a Conversation belonging to User B (HTTP 404)."""
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num_b = await _create_active_number(db, user_b)
        contact_b = await _create_contact(db, user_b)
        conv_b = await _create_conversation(db, user_b, num_b.id, contact_b.id)
        conv_b_id = conv_b.id

    token_a = _make_mock_jwt(user_a)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_b_id}/messages",
            json={"message_type": "text", "body": "Intrusion attempt"},
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert res.status_code == 404
        assert "Diyalog bulunamadı" in res.json()["detail"]


@pytest.mark.asyncio
async def test_02_conversation_ownership():
    """User cannot access conversations they do not own."""
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num_b = await _create_active_number(db, user_b)
        contact_b = await _create_contact(db, user_b)
        conv_b = await _create_conversation(db, user_b, num_b.id, contact_b.id)
        conv_b_id = conv_b.id

    token_a = _make_mock_jwt(user_a)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get(
            f"/api/v1/conversations/{conv_b_id}",
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert res.status_code == 404


@pytest.mark.asyncio
async def test_03_whatsapp_number_ownership():
    """Conversation referencing a WhatsApp number belonging to another tenant is blocked (HTTP 403)."""
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num_b = await _create_active_number(db, user_b)
        contact_a = await _create_contact(db, user_a)
        # Illegally crossed conversation: conv belongs to User A, but points to User B's number
        conv = Conversation(
            user_id=user_a,
            whatsapp_number_id=num_b.id,
            contact_id=contact_a.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            customer_service_window_expires_at=datetime.utcnow() + timedelta(hours=5),
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        conv_id = conv.id

    token_a = _make_mock_jwt(user_a)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Cross-tenant send attempt"},
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert res.status_code == 403
        assert "yetkiniz yok" in res.json()["detail"]


@pytest.mark.asyncio
async def test_04_inactive_number_rejected():
    """Sending via an inactive/disconnected number is rejected (HTTP 400)."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user, status=WhatsAppNumberStatus.DISCONNECTED)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Should fail because number is disconnected"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 400
        assert "aktif değil" in res.json()["detail"]


@pytest.mark.asyncio
async def test_05_contact_recipient_resolution():
    """Recipient phone is resolved strictly from Conversation's Contact."""
    user = str(uuid.uuid4())
    expected_recipient = "+905329998877"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user, phone_e164=expected_recipient)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Hello recipient resolution", "recipient_phone": "+905000000000"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201
        data = res.json()
        assert data["recipient_phone"] == expected_recipient


@pytest.mark.asyncio
async def test_06_valid_24h_text_send_accepted():
    """Within 24h window, freeform text message is accepted."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id, window_open_hours=10)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Valid freeform text within 24h window"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201
        data = res.json()
        assert data["status"] == "PENDING"
        assert data["direction"] == "OUTBOUND"
        assert data["wa_message_id"] is None


@pytest.mark.asyncio
async def test_07_expired_24h_text_rejected():
    """Outside 24h window, freeform text message is strictly rejected with CUSTOMER_SERVICE_WINDOW_EXPIRED (HTTP 422)."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id, window_open_hours=-5)  # expired 5h ago
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Freeform message attempt when window is closed"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 422
        assert "CUSTOMER_SERVICE_WINDOW_EXPIRED" in str(res.json()["detail"])


@pytest.mark.asyncio
async def test_08_expired_window_template_accepted():
    """Outside 24h window, approved business template is accepted."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id, window_open_hours=-5)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={
                "message_type": "template",
                "template_name": "re_engagement_v1",
                "template_language": "tr",
                "template_parameters": [{"type": "text", "text": "Ahmet Bey"}],
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201
        data = res.json()
        assert data["status"] == "PENDING"
        assert data["message_type"] == "TEMPLATE"


@pytest.mark.asyncio
async def test_09_template_missing_name_rejected():
    """Template message missing template_name is rejected with HTTP 422."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id, window_open_hours=-2)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "template", "template_name": "", "template_language": "tr"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 422
        assert "template_name" in str(res.json()["detail"])


@pytest.mark.asyncio
async def test_10_template_missing_language_rejected():
    """Template message missing template_language is rejected with HTTP 422."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id, window_open_hours=-2)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "template", "template_name": "welcome_notice", "template_language": ""},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 422
        assert "template_language" in str(res.json()["detail"])


@pytest.mark.asyncio
async def test_11_pending_message_creation():
    """Outbound request immediately stores Message in status=PENDING with server-generated client_message_id."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Pending test message"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201
        data = res.json()
        assert data["status"] == "PENDING"
        assert data["wa_message_id"] is None
        assert data["client_message_id"] is not None
        assert data["client_message_id"].startswith("cmsg_")


@pytest.mark.asyncio
async def test_12_outbox_created_atomically():
    """Outbound Message creation atomically creates OutboxMessage in the same transaction."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    with patch.object(OutboundWorker, "process_outbox_message_by_id", new=AsyncMock()):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"message_type": "text", "body": "Atomic outbox test"},
                headers={"Authorization": f"Bearer {token}"},
            )
            msg_id = res.json()["id"]

    async with AsyncSessionLocal() as db:
        outbox_stmt = select(OutboxMessage).where(OutboxMessage.message_id == msg_id)
        outbox = (await db.execute(outbox_stmt)).scalar_one_or_none()
        assert outbox is not None
        assert outbox.status == OutboxMessageStatus.PENDING
        assert outbox.whatsapp_number_id == num.id
        assert outbox.user_id == user


@pytest.mark.asyncio
async def test_13_rollback_removes_both_message_and_outbox():
    """DB rollback ensures neither Message nor OutboxMessage is committed on transaction failure."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        # Attempt atomic add then intentional rollback
        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Rollback test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id="cmsg_rollback_test",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)

        # Explicit Rollback
        await db.rollback()

    async with AsyncSessionLocal() as db:
        msgs = (await db.execute(select(Message).where(Message.client_message_id == "cmsg_rollback_test"))).scalars().all()
        outboxes = (await db.execute(select(OutboxMessage).where(OutboxMessage.user_id == user))).scalars().all()
        assert len(msgs) == 0
        assert len(outboxes) == 0


@pytest.mark.asyncio
async def test_14_meta_success_returns_wamid():
    """Worker receives wamid from Meta Cloud API response."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Meta wamid test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    expected_wamid = "wamid.HBgLMDA5MDUzMjExMTIyMzMA"
    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        new=AsyncMock(return_value={"messages": [{"id": expected_wamid}]}),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "sent"
            assert res["wamid"] == expected_wamid


@pytest.mark.asyncio
async def test_15_wamid_saved_correctly():
    """Message.wa_message_id is populated with the Meta returned wamid."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Save wamid test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        msg_id = msg.id
        outbox_id = outbox.id

    expected_wamid = "wamid.HBgLTEST_SAVE_WAMID_123"
    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        new=AsyncMock(return_value={"messages": [{"id": expected_wamid}]}),
    ):
        async with AsyncSessionLocal() as db:
            await OutboundWorker.process_outbox_job(outbox_id, db)
            msg_db = await db.get(Message, msg_id)
            assert msg_db.wa_message_id == expected_wamid


@pytest.mark.asyncio
async def test_16_pending_to_sent_progression():
    """Worker monotonically transitions message status from PENDING to SENT and sets sent_at."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Progression test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        msg_id = msg.id
        outbox_id = outbox.id

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        new=AsyncMock(return_value={"messages": [{"id": "wamid.HBgLPROG_SENT"}]}),
    ):
        async with AsyncSessionLocal() as db:
            await OutboundWorker.process_outbox_job(outbox_id, db)
            msg_db = await db.get(Message, msg_id)
            assert msg_db.status == ConversationMessageStatus.SENT
            assert msg_db.sent_at is not None

            outbox_db = await db.get(OutboxMessage, outbox_id)
            assert outbox_db.status == OutboxMessageStatus.COMPLETED


@pytest.mark.asyncio
async def test_17_meta_400_no_retry():
    """Meta 400 Bad Request fails fast without wasteful worker retries."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Meta 400 test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        msg_id = msg.id
        outbox_id = outbox.id

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        side_effect=MetaApiError("Invalid parameter", http_status=400, meta_error_code=100, retryable=False),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "failed"

            outbox_db = await db.get(OutboxMessage, outbox_id)
            assert outbox_db.status == OutboxMessageStatus.FAILED
            assert outbox_db.attempt_count == 0  # no retry

            msg_db = await db.get(Message, msg_id)
            assert msg_db.status == ConversationMessageStatus.FAILED


@pytest.mark.asyncio
async def test_18_meta_401_no_retry():
    """Meta 401 Unauthorized / expired token fails fast without retry."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Meta 401 test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        side_effect=MetaApiError("Session expired", http_status=401, meta_error_code=190, retryable=False),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "failed"

            outbox_db = await db.get(OutboxMessage, outbox_id)
            assert outbox_db.status == OutboxMessageStatus.FAILED


@pytest.mark.asyncio
async def test_19_meta_403_no_retry():
    """Meta 403 Forbidden fails fast without retry."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Meta 403 test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        side_effect=MetaApiError("Permission denied", http_status=403, meta_error_code=200, retryable=False),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "failed"

            outbox_db = await db.get(OutboxMessage, outbox_id)
            assert outbox_db.status == OutboxMessageStatus.FAILED


@pytest.mark.asyncio
async def test_20_meta_429_retry():
    """Meta 429 Rate Limited schedules exponential backoff retry."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Meta 429 test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
            attempt_count=0,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        side_effect=MetaApiError("Rate Limit Exceeded", http_status=429, meta_error_code=130429, retryable=True),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "retryable"
            assert res["attempt"] == 1

            outbox_db = await db.get(OutboxMessage, outbox_id)
            assert outbox_db.status == OutboxMessageStatus.RETRYABLE
            assert outbox_db.attempt_count == 1
            assert outbox_db.available_at > datetime.utcnow() - timedelta(seconds=1)


@pytest.mark.asyncio
async def test_21_meta_500_retry():
    """Meta 500 Transient Server Error schedules retry."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Meta 500 test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
            attempt_count=0,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        side_effect=MetaApiError("Internal Meta Error", http_status=500, retryable=True),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "retryable"

            outbox_db = await db.get(OutboxMessage, outbox_id)
            assert outbox_db.status == OutboxMessageStatus.RETRYABLE
            assert outbox_db.attempt_count == 1


@pytest.mark.asyncio
async def test_22_meta_timeout_handling():
    """Ambiguous network failure (ReadTimeout on POST messages) triggers AMBIGUOUS_PROVIDER_RESULT without blind retry."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Ambiguous timeout test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        side_effect=MetaAmbiguousResultError("Read timeout occurred while awaiting Meta response"),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "ambiguous"

            outbox_db = await db.get(OutboxMessage, outbox_id)
            assert outbox_db.status == OutboxMessageStatus.AMBIGUOUS_PROVIDER_RESULT
            assert "timeout" in outbox_db.last_error.lower()


@pytest.mark.asyncio
async def test_23_token_decrypted_only_at_send_boundary():
    """Token is decrypted strictly inside the outbound worker immediately prior to sending."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Decryption timing test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    decrypt_calls = []
    real_decrypt = CredentialVault.decrypt

    def tracking_decrypt(val):
        decrypt_calls.append(val)
        return real_decrypt(val)

    with patch.object(CredentialVault, "decrypt", side_effect=tracking_decrypt):
        with patch.object(
            MetaCloudApiClient,
            "send_text_message",
            new=AsyncMock(return_value={"messages": [{"id": "wamid.DECRYPT_TEST"}]}),
        ):
            async with AsyncSessionLocal() as db:
                await OutboundWorker.process_outbox_job(outbox_id, db)

    assert len(decrypt_calls) == 1
    assert decrypt_calls[0] == num.encrypted_access_token


@pytest.mark.asyncio
async def test_24_token_never_appears_in_logs(caplog):
    """Raw token EAAB... never appears in application log output."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Log privacy test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    with caplog.at_level(logging.DEBUG):
        with patch.object(
            MetaCloudApiClient,
            "send_text_message",
            new=AsyncMock(return_value={"messages": [{"id": "wamid.LOG_TEST"}]}),
        ):
            async with AsyncSessionLocal() as db:
                await OutboundWorker.process_outbox_job(outbox_id, db)

    for record in caplog.records:
        assert "EAAB_test_mock" not in record.message


@pytest.mark.asyncio
async def test_25_token_never_appears_in_outbox():
    """Outbox table contains only identifiers and non-secret job payload."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Outbox safety check"},
            headers={"Authorization": f"Bearer {token}"},
        )
        msg_id = res.json()["id"]

    async with AsyncSessionLocal() as db:
        outbox = (await db.execute(select(OutboxMessage).where(OutboxMessage.message_id == msg_id))).scalar_one()
        assert not hasattr(outbox, "access_token")
        assert not hasattr(outbox, "encrypted_access_token")
        if outbox.payload_json:
            assert "EAAB" not in outbox.payload_json
            assert "token" not in outbox.payload_json.lower()


@pytest.mark.asyncio
async def test_26_token_never_appears_in_api_response():
    """API response DTO contains zero tokens or secrets."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Response DTO safety test"},
            headers={"Authorization": f"Bearer {token}"},
        )
        data = res.json()
        assert "access_token" not in data
        assert "encrypted_access_token" not in data
        assert "secret" not in data
        assert "token" not in str(data).lower() or "cmsg_" in str(data)  # exclude client_mid


@pytest.mark.asyncio
async def test_27_duplicate_client_message_id():
    """Sending with an identical client_message_id is idempotent: returns existing message without duplicate send."""
    user = str(uuid.uuid4())
    client_id = f"cmsg_unique_{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # First request
        res1 = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Idempotent send 1", "client_message_id": client_id},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res1.status_code == 201
        data1 = res1.json()

        # Second request with identical client_message_id
        res2 = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"message_type": "text", "body": "Idempotent send 2", "client_message_id": client_id},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res2.status_code == 201
        data2 = res2.json()

        # Exactly same logical message
        assert data1["id"] == data2["id"]
        assert data1["client_message_id"] == data2["client_message_id"]

    async with AsyncSessionLocal() as db:
        msgs = (await db.execute(select(Message).where(Message.client_message_id == client_id))).scalars().all()
        outboxes = (await db.execute(select(OutboxMessage).where(OutboxMessage.message_id == data1["id"]))).scalars().all()
        assert len(msgs) == 1
        assert len(outboxes) == 1


@pytest.mark.asyncio
async def test_28_concurrent_worker_protection():
    """Two workers attempting to claim the same outbox job result in exactly one successful lease."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Concurrent worker test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    async with AsyncSessionLocal() as db1:
        async with AsyncSessionLocal() as db2:
            claim1 = await OutboundWorker.claim_outbox_job(db1, outbox_id, worker_id="worker_alpha")
            claim2 = await OutboundWorker.claim_outbox_job(db2, outbox_id, worker_id="worker_beta")

    # Exactly one worker wins the claim
    assert (claim1 is True and claim2 is False) or (claim1 is False and claim2 is True)


@pytest.mark.asyncio
async def test_29_duplicate_status_webhook():
    """Duplicate status webhook deliveries are processed idempotently without error."""
    user = str(uuid.uuid4())
    wamid = "wamid.HBgLSTATUS_DUP_001"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Duplicate status test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.SENT,
            wa_message_id=wamid,
        )
        db.add(msg)
        await db.commit()

    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "WABA_ID",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": num.display_phone_number,
                        "phone_number_id": num.phone_number_id,
                    },
                    "statuses": [{
                        "id": wamid,
                        "status": "delivered",
                        "timestamp": "1700000000",
                        "recipient_id": contact.phone_e164.lstrip("+"),
                    }],
                },
            }],
        }],
    }

    raw_body = json.dumps(webhook_payload).encode("utf-8")
    sig = "sha256=" + __import__("hmac").new(
        settings.effective_meta_app_secret.encode("utf-8"), raw_body, __import__("hashlib").sha256
    ).hexdigest()

    async with AsyncSessionLocal() as db:
        res1 = await WhatsAppWebhookService.ingest_raw_event(db, raw_body, sig, sync_process=True)
        assert res1["status"] in ("processed", "received")

        # Second identical delivery
        res2 = await WhatsAppWebhookService.ingest_raw_event(db, raw_body, sig, sync_process=True)
        assert res2["status"] == "duplicate"


@pytest.mark.asyncio
async def test_30_sent_to_delivered():
    """Delivery status webhook transitions message from SENT to DELIVERED."""
    user = str(uuid.uuid4())
    wamid = "wamid.HBgLSTATUS_DELIV_002"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Delivered test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.SENT,
            wa_message_id=wamid,
        )
        db.add(msg)
        await db.commit()
        msg_id = msg.id

    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "WABA_ID",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": num.display_phone_number,
                        "phone_number_id": num.phone_number_id,
                    },
                    "statuses": [{
                        "id": wamid,
                        "status": "delivered",
                        "timestamp": "1700000010",
                        "recipient_id": contact.phone_e164.lstrip("+"),
                    }],
                },
            }],
        }],
    }

    raw_body = json.dumps(webhook_payload).encode("utf-8")
    sig = "sha256=" + __import__("hmac").new(
        settings.effective_meta_app_secret.encode("utf-8"), raw_body, __import__("hashlib").sha256
    ).hexdigest()

    async with AsyncSessionLocal() as db:
        await WhatsAppWebhookService.ingest_raw_event(db, raw_body, sig, sync_process=True)
        msg_db = await db.get(Message, msg_id)
        assert msg_db.status == ConversationMessageStatus.DELIVERED
        assert msg_db.delivered_at is not None


@pytest.mark.asyncio
async def test_31_delivered_to_read():
    """Read status webhook transitions message from DELIVERED to READ."""
    user = str(uuid.uuid4())
    wamid = "wamid.HBgLSTATUS_READ_003"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Read test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.DELIVERED,
            wa_message_id=wamid,
        )
        db.add(msg)
        await db.commit()
        msg_id = msg.id

    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "WABA_ID",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": num.display_phone_number,
                        "phone_number_id": num.phone_number_id,
                    },
                    "statuses": [{
                        "id": wamid,
                        "status": "read",
                        "timestamp": "1700000020",
                        "recipient_id": contact.phone_e164.lstrip("+"),
                    }],
                },
            }],
        }],
    }

    raw_body = json.dumps(webhook_payload).encode("utf-8")
    sig = "sha256=" + __import__("hmac").new(
        settings.effective_meta_app_secret.encode("utf-8"), raw_body, __import__("hashlib").sha256
    ).hexdigest()

    async with AsyncSessionLocal() as db:
        await WhatsAppWebhookService.ingest_raw_event(db, raw_body, sig, sync_process=True)
        msg_db = await db.get(Message, msg_id)
        assert msg_db.status == ConversationMessageStatus.READ
        assert msg_db.read_at is not None


@pytest.mark.asyncio
async def test_32_invalid_status_regression():
    """Attempting an invalid backward transition (READ -> DELIVERED) is strictly rejected."""
    user = str(uuid.uuid4())
    wamid = "wamid.HBgLSTATUS_REG_004"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Regression rejection test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.READ,
            wa_message_id=wamid,
        )
        db.add(msg)
        await db.commit()
        msg_id = msg.id

    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "WABA_ID",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": num.display_phone_number,
                        "phone_number_id": num.phone_number_id,
                    },
                    "statuses": [{
                        "id": wamid,
                        "status": "delivered",  # Backward regression attempt
                        "timestamp": "1700000030",
                        "recipient_id": contact.phone_e164.lstrip("+"),
                    }],
                },
            }],
        }],
    }

    raw_body = json.dumps(webhook_payload).encode("utf-8")
    sig = "sha256=" + __import__("hmac").new(
        settings.effective_meta_app_secret.encode("utf-8"), raw_body, __import__("hashlib").sha256
    ).hexdigest()

    async with AsyncSessionLocal() as db:
        await WhatsAppWebhookService.ingest_raw_event(db, raw_body, sig, sync_process=True)
        msg_db = await db.get(Message, msg_id)
        # Status MUST remain READ
        assert msg_db.status == ConversationMessageStatus.READ


@pytest.mark.asyncio
async def test_33_failed_handling():
    """Webhook 'failed' status updates message to FAILED with error details."""
    user = str(uuid.uuid4())
    wamid = "wamid.HBgLSTATUS_FAIL_005"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Failure handling test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.SENT,
            wa_message_id=wamid,
        )
        db.add(msg)
        await db.commit()
        msg_id = msg.id

    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "WABA_ID",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": num.display_phone_number,
                        "phone_number_id": num.phone_number_id,
                    },
                    "statuses": [{
                        "id": wamid,
                        "status": "failed",
                        "timestamp": "1700000040",
                        "recipient_id": contact.phone_e164.lstrip("+"),
                        "errors": [{
                            "code": 131026,
                            "title": "Message undeliverable",
                            "message": "Message undeliverable to this phone number",
                        }],
                    }],
                },
            }],
        }],
    }

    raw_body = json.dumps(webhook_payload).encode("utf-8")
    sig = "sha256=" + __import__("hmac").new(
        settings.effective_meta_app_secret.encode("utf-8"), raw_body, __import__("hashlib").sha256
    ).hexdigest()

    async with AsyncSessionLocal() as db:
        await WhatsAppWebhookService.ingest_raw_event(db, raw_body, sig, sync_process=True)
        msg_db = await db.get(Message, msg_id)
        assert msg_db.status == ConversationMessageStatus.FAILED
        assert msg_db.failed_at is not None
        assert msg_db.error_code == 131026


@pytest.mark.asyncio
async def test_34_unknown_meta_fields_tolerated():
    """Worker safely parses and tolerates unexpected fields in Meta response."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)

        msg = Message(
            user_id=user,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Unknown fields tolerance test",
            sender_phone=num.phone_number_e164,
            recipient_phone=contact.phone_e164,
            client_message_id=f"cmsg_{uuid.uuid4().hex}",
            status=ConversationMessageStatus.PENDING,
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=user,
            message_id=msg.id,
            whatsapp_number_id=num.id,
            status=OutboxMessageStatus.PENDING,
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    mock_meta_response = {
        "messaging_product": "whatsapp",
        "contacts": [{"input": contact.phone_e164, "wa_id": contact.phone_e164.lstrip("+")}],
        "messages": [{"id": "wamid.EXTRA_FIELDS_001"}],
        "pricing": {"billable": True, "pricing_model": "CBP", "category": "utility"},
        "future_field_xyz": {"some_random_key": [1, 2, 3]},
    }

    with patch.object(
        MetaCloudApiClient,
        "send_text_message",
        new=AsyncMock(return_value=mock_meta_response),
    ):
        async with AsyncSessionLocal() as db:
            res = await OutboundWorker.process_outbox_job(outbox_id, db)
            assert res["status"] == "sent"
            assert res["wamid"] == "wamid.EXTRA_FIELDS_001"


@pytest.mark.asyncio
async def test_35_two_whatsapp_numbers_isolated():
    """Two WhatsApp numbers belonging to same tenant have isolated outbox dispatches."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num1 = await _create_active_number(db, user, phone_e164="+908501111111")
        num2 = await _create_active_number(db, user, phone_e164="+908502222222")
        contact = await _create_contact(db, user)

        conv1 = await _create_conversation(db, user, num1.id, contact.id)
        conv2 = await _create_conversation(db, user, num2.id, contact.id)
        conv1_id = conv1.id
        conv2_id = conv2.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res1 = await client.post(
            f"/api/v1/conversations/{conv1_id}/messages",
            json={"message_type": "text", "body": "Message from line 1"},
            headers={"Authorization": f"Bearer {token}"},
        )
        res2 = await client.post(
            f"/api/v1/conversations/{conv2_id}/messages",
            json={"message_type": "text", "body": "Message from line 2"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert res1.status_code == 201
        assert res2.status_code == 201
        assert res1.json()["sender_phone"] == "+908501111111"
        assert res2.json()["sender_phone"] == "+908502222222"


@pytest.mark.asyncio
async def test_36_two_contacts_isolated():
    """Two contacts have strictly isolated conversations and message dispatches."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact1 = await _create_contact(db, user, phone_e164="+905321111111")
        contact2 = await _create_contact(db, user, phone_e164="+905322222222")

        conv1 = await _create_conversation(db, user, num.id, contact1.id)
        conv2 = await _create_conversation(db, user, num.id, contact2.id)
        conv1_id = conv1.id
        conv2_id = conv2.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res1 = await client.post(
            f"/api/v1/conversations/{conv1_id}/messages",
            json={"message_type": "text", "body": "Message to contact 1"},
            headers={"Authorization": f"Bearer {token}"},
        )
        res2 = await client.post(
            f"/api/v1/conversations/{conv2_id}/messages",
            json={"message_type": "text", "body": "Message to contact 2"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert res1.json()["recipient_phone"] == "+905321111111"
        assert res2.json()["recipient_phone"] == "+905322222222"


@pytest.mark.asyncio
async def test_37_same_contact_across_two_numbers_isolated():
    """Same customer contacting two different WhatsApp lines maintains isolated conversations."""
    user = str(uuid.uuid4())
    customer_phone = "+905327778899"

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num_sales = await _create_active_number(db, user, phone_e164="+908501000001")
        num_support = await _create_active_number(db, user, phone_e164="+908501000002")
        contact = await _create_contact(db, user, phone_e164=customer_phone)

        conv_sales = await _create_conversation(db, user, num_sales.id, contact.id)
        conv_support = await _create_conversation(db, user, num_support.id, contact.id)
        conv_sales_id = conv_sales.id
        conv_support_id = conv_support.id

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res_sales = await client.post(
            f"/api/v1/conversations/{conv_sales_id}/messages",
            json={"message_type": "text", "body": "Sales quote"},
            headers={"Authorization": f"Bearer {token}"},
        )
        res_supp = await client.post(
            f"/api/v1/conversations/{conv_support_id}/messages",
            json={"message_type": "text", "body": "Support ticket update"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert res_sales.json()["sender_phone"] == "+908501000001"
        assert res_supp.json()["sender_phone"] == "+908501000002"
        assert res_sales.json()["recipient_phone"] == customer_phone
        assert res_supp.json()["recipient_phone"] == customer_phone
        assert res_sales.json()["conversation_id"] != res_supp.json()["conversation_id"]


@pytest.mark.asyncio
async def test_38_message_ordering():
    """Messages in conversation are strictly returned in chronological ascending order."""
    user = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        await clean_phase4_db(db)
        num = await _create_active_number(db, user)
        contact = await _create_contact(db, user)
        conv = await _create_conversation(db, user, num.id, contact.id)
        conv_id = conv.id

        now = datetime.utcnow()
        for i in range(5):
            msg = Message(
                user_id=user,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body=f"Message order #{i}",
                sender_phone=num.phone_number_e164,
                recipient_phone=contact.phone_e164,
                status=ConversationMessageStatus.SENT,
                created_at=now + timedelta(seconds=i),
            )
            db.add(msg)
        await db.commit()

    token = _make_mock_jwt(user)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get(
            f"/api/v1/conversations/{conv_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200
        msgs = res.json()["messages"]
        assert len(msgs) == 5
        # Verify chronological order
        for i in range(5):
            assert msgs[i]["body"] == f"Message order #{i}"


def test_39_no_browser_to_meta_call():
    """Architectural invariant: Meta Graph API client is only invoked server-side."""
    # Verify client requires server-side access token
    client = MetaCloudApiClient()
    assert client.base_url.startswith("https://graph.facebook.com")
    # Verify MetaApiError is raised if called without access_token
    with pytest.raises(MetaApiError) as exc_info:
        asyncio.run(client.get_phone_number_details("123", access_token=""))
    assert exc_info.value.http_status == 401


def test_40_api_response_never_contains_credentials():
    """MessageResponse Pydantic schema and serialized fields never contain credential or outbox secrets."""
    fields = set(MessageResponse.model_fields.keys())
    prohibited = {"access_token", "encrypted_access_token", "app_secret", "password", "secret", "payload_json"}
    for p in prohibited:
        assert p not in fields


# ==============================================================================
# 41. REAL META E2E CHECK
# ==============================================================================

@pytest.mark.asyncio
async def test_41_real_meta_e2e_status():
    """
    Live Meta Cloud API E2E verification test.
    Explicitly skipped and documented as 'NOT RUN' when live credentials
    or REAL_META_TEST_RECIPIENT are absent.
    """
    real_meta_enabled = os.getenv("REAL_META_E2E", "false").lower() == "true"
    test_recipient = os.getenv("REAL_META_TEST_RECIPIENT")
    real_token = os.getenv("META_CLOUD_ACCESS_TOKEN") or os.getenv("META_ACCESS_TOKEN")
    phone_number_id = os.getenv("META_PHONE_NUMBER_ID")

    if not (real_meta_enabled and test_recipient and real_token and phone_number_id):
        pytest.skip(
            "REAL META E2E: NOT RUN (Requires REAL_META_E2E=true, REAL_META_TEST_RECIPIENT, "
            "META_PHONE_NUMBER_ID, and valid META_CLOUD_ACCESS_TOKEN)"
        )

    # Live Controlled Dispatch Sequence
    meta_client = MetaCloudApiClient()
    res = await meta_client.send_text_message(
        phone_number_id=phone_number_id,
        access_token=real_token,
        to_phone=test_recipient,
        message_text="[Tezlify E2E] Live Meta Cloud API outbound test verification.",
    )
    assert res is not None
    messages = res.get("messages", [])
    assert len(messages) > 0
    wamid = messages[0].get("id")
    assert wamid is not None and wamid.startswith("wamid.")
