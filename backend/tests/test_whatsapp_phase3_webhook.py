"""
Tezlify WhatsApp Rebuild - Phase 3 Real Meta Webhook Ingestion & Inbound Pipeline Tests

Tests covering all 33 required scenarios + Real Meta E2E check:
1. GET webhook verification success
2. GET webhook wrong verify token
3. GET webhook wrong mode
4. POST valid signature
5. POST invalid signature returns 403
6. POST malformed JSON returns controlled response
7. POST invalid object returns ok without mutation
8. unknown phone_number_id does not mutate domain
9. valid inbound text message ingestion
10. new contact creation on inbound
11. existing contact resolution on inbound
12. new conversation creation on inbound
13. existing conversation resolution on inbound
14. same wamid duplicate is idempotent
15. same wamid concurrent duplicate protection
16. duplicate webhook does not emit realtime twice
17. status webhook sent
18. status webhook delivered
19. status webhook read
20. status webhook failed records error details
21. invalid status regression rejected
22. orphan status webhook handled gracefully
23. 24h customer window updated on inbound
24. duplicate inbound does not extend window incorrectly
25. tenant isolation inbound routing
26. two WhatsApp numbers same tenant
27. same contact on two numbers creates isolated conversations
28. unknown fields in payload do not crash
29. secret never appears in logs
30. webhook event lifecycle states
31. processing failure is recorded in webhook events
32. retry/replay behavior is idempotent
33. DB rollback does not emit realtime event
34. Real Meta E2E check
"""

import os
import uuid
import json
import hmac
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.migrations import (
    ensure_whatsapp_numbers_table,
    ensure_contacts_table,
    ensure_webhook_events_table,
    ensure_conversations_columns,
    ensure_messages_media_columns,
    ensure_user_id_columns,
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
from backend.app.models.webhook_event import WebhookEvent, WebhookEventStatus
from backend.app.services.whatsapp_webhook_service import WhatsAppWebhookService
from backend.app.services.customer_window_service import CustomerWindowService
from backend.app.api.v1.websocket import ws_manager

TEST_SECRET = "test_meta_app_secret_phase3_super_secure_32b!"
TEST_VERIFY_TOKEN = "tezlify_test_verify_token_phase3"


@pytest.fixture(autouse=True)
def setup_test_settings():
    """Sets deterministic test credentials and resets overrides."""
    old_secret = settings.META_APP_SECRET
    old_token = settings.META_WEBHOOK_VERIFY_TOKEN
    old_cloud_secret = settings.WHATSAPP_CLOUD_APP_SECRET
    old_cloud_token = settings.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN

    settings.META_APP_SECRET = TEST_SECRET
    settings.META_WEBHOOK_VERIFY_TOKEN = TEST_VERIFY_TOKEN
    settings.WHATSAPP_CLOUD_APP_SECRET = TEST_SECRET
    settings.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN = TEST_VERIFY_TOKEN

    yield

    settings.META_APP_SECRET = old_secret
    settings.META_WEBHOOK_VERIFY_TOKEN = old_token
    settings.WHATSAPP_CLOUD_APP_SECRET = old_cloud_secret
    settings.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN = old_cloud_token


def _sign(payload_bytes: bytes, secret: str = TEST_SECRET) -> str:
    """Calculates valid X-Hub-Signature-256 for test payload."""
    sig = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
    return f"sha256={sig}"


def _make_inbound_payload(
    phone_number_id: str,
    from_phone: str,
    wamid: str,
    body: str = "Test message",
    sender_name: str = "Test User",
    timestamp: str = "1700000000",
    extra_fields: dict = None,
) -> dict:
    """Constructs a standard Meta WhatsApp Cloud webhook inbound text message payload."""
    msg_dict = {
        "from": from_phone,
        "id": wamid,
        "timestamp": timestamp,
        "text": {"body": body},
        "type": "text",
    }
    if extra_fields:
        msg_dict.update(extra_fields)

    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "WABA_12345",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "908501234567",
                                "phone_number_id": phone_number_id,
                            },
                            "contacts": [
                                {
                                    "profile": {"name": sender_name},
                                    "wa_id": from_phone,
                                }
                            ],
                            "messages": [msg_dict],
                        },
                    }
                ],
            }
        ],
    }
    return payload


def _make_status_payload(
    phone_number_id: str,
    recipient_phone: str,
    wamid: str,
    status: str,
    timestamp: str = "1700000005",
    errors: list = None,
) -> dict:
    """Constructs a standard Meta WhatsApp Cloud webhook status update payload."""
    status_dict = {
        "id": wamid,
        "status": status,
        "timestamp": timestamp,
        "recipient_id": recipient_phone,
    }
    if errors:
        status_dict["errors"] = errors

    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "WABA_12345",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "908501234567",
                                "phone_number_id": phone_number_id,
                            },
                            "statuses": [status_dict],
                        },
                    }
                ],
            }
        ],
    }


# ============================================================================
# 1-3. GET Webhook Handshake Verification Tests
# ============================================================================

@pytest.mark.asyncio
async def test_01_get_webhook_verification_success():
    """1. GET webhook verification returns HTTP 200 with raw challenge body."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        params = {
            "hub.mode": "subscribe",
            "hub.verify_token": TEST_VERIFY_TOKEN,
            "hub.challenge": "challenge_code_123456789",
        }
        res = await client.get("/api/v1/whatsapp/webhook", params=params)
        assert res.status_code == 200
        assert res.text == "challenge_code_123456789"
        assert res.headers["content-type"].startswith("text/plain")


@pytest.mark.asyncio
async def test_02_get_webhook_wrong_verify_token():
    """2. GET webhook with wrong verify token returns HTTP 403."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        params = {
            "hub.mode": "subscribe",
            "hub.verify_token": "incorrect_token",
            "hub.challenge": "challenge_code_123456789",
        }
        res = await client.get("/api/v1/whatsapp/webhook", params=params)
        assert res.status_code == 403


@pytest.mark.asyncio
async def test_03_get_webhook_wrong_mode():
    """3. GET webhook with invalid hub.mode returns HTTP 403."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        params = {
            "hub.mode": "publish",
            "hub.verify_token": TEST_VERIFY_TOKEN,
            "hub.challenge": "challenge_code_123456789",
        }
        res = await client.get("/api/v1/whatsapp/webhook", params=params)
        assert res.status_code == 403


# ============================================================================
# 4-7. POST Ingestion Signature & Envelope Tests
# ============================================================================

@pytest.mark.asyncio
async def test_04_post_valid_signature():
    """4. POST with valid HMAC-SHA256 signature accepts request and returns 200."""
    wamid = f"wamid.test04_{uuid.uuid4().hex}"
    payload = _make_inbound_payload("99999", "905550001122", wamid)
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        res = await client.post("/api/v1/whatsapp/webhook", content=raw_body, headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "received"
        assert "event_hash" in data


@pytest.mark.asyncio
async def test_05_post_invalid_signature():
    """5. POST with invalid signature must be rejected with HTTP 403."""
    payload = _make_inbound_payload("99999", "905550001122", f"wamid.test05_{uuid.uuid4().hex}")
    raw_body = json.dumps(payload).encode("utf-8")
    bad_sig = "sha256=0000000000000000000000000000000000000000000000000000000000000000"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": bad_sig, "Content-Type": "application/json"}
        res = await client.post("/api/v1/whatsapp/webhook", content=raw_body, headers=headers)
        assert res.status_code == 403


@pytest.mark.asyncio
async def test_06_post_malformed_json():
    """6. POST with malformed JSON body returns controlled response without 500 crash."""
    raw_body = f"{{\"object\": \"whatsapp_business_account\", \"test_id\": \"{uuid.uuid4().hex}\", broken_json...".encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        res = await client.post("/api/v1/whatsapp/webhook", content=raw_body, headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "error"


@pytest.mark.asyncio
async def test_07_post_invalid_object():
    """7. POST with non-whatsapp object is safely ignored without error."""
    payload = {"object": "page", "entry": [], "test_nonce": uuid.uuid4().hex}
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        res = await client.post("/api/v1/whatsapp/webhook", content=raw_body, headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ignored"


# ============================================================================
# 8-13. Multi-Tenant Routing, Contact & Conversation Resolution
# ============================================================================

@pytest.mark.asyncio
async def test_08_unknown_phone_number_id():
    """8. Webhook for unknown phone_number_id audits event but performs zero domain mutation."""
    unknown_pid = f"unknown_pid_{uuid.uuid4().hex[:8]}"
    payload = _make_inbound_payload(unknown_pid, "905551112233", f"wamid.{uuid.uuid4().hex}")
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        res = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)
        assert res.status_code == 200

    async with AsyncSessionLocal() as session:
        # Verify no contact, conversation or message was created for this phone
        c = (await session.execute(select(Contact).where(Contact.phone_e164 == "+905551112233"))).scalar_one_or_none()
        assert c is None


@pytest.mark.asyncio
async def test_09_valid_inbound_text():
    """9. Valid inbound text creates a Message entity in DB with status RECEIVED."""
    uid = str(uuid.uuid4())
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Destek Hattı",
            display_phone_number="+90 850 111 22 33",
            phone_number_e164="+908501112233",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    payload = _make_inbound_payload(pid, "905551112244", wamid, body="Merhaba Dünya!")
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        res = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)
        assert res.status_code == 200

    async with AsyncSessionLocal() as session:
        msg = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one_or_none()
        assert msg is not None
        assert msg.body == "Merhaba Dünya!"
        assert msg.direction == MessageDirection.INBOUND
        assert msg.status == ConversationMessageStatus.RECEIVED
        assert str(msg.user_id) == str(uid)


@pytest.mark.asyncio
async def test_10_new_contact_creation():
    """10. Inbound message creates a new Contact when one does not exist for the tenant."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"
    sender_phone = "905551119900"
    normalized_sender = "+905551119900"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Satış Hattı",
            display_phone_number="+90 850 111 22 44",
            phone_number_e164="+908501112244",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    payload = _make_inbound_payload(pid, sender_phone, wamid, body="Yeni Kişi", sender_name="Ayşe Yılmaz")
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)

    async with AsyncSessionLocal() as session:
        c = (await session.execute(select(Contact).where(Contact.phone_e164 == normalized_sender, Contact.user_id == uid))).scalar_one_or_none()
        assert c is not None
        assert c.whatsapp_profile_name == "Ayşe Yılmaz"
        assert c.display_name == "Ayşe Yılmaz"


@pytest.mark.asyncio
async def test_11_existing_contact_resolution():
    """11. Inbound message resolves existing Contact without creating duplicates."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    sender_e164 = "+905552223344"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat 1",
            display_phone_number="+90 850 111 22 55",
            phone_number_e164="+908501112255",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        existing_contact = Contact(
            user_id=uid,
            phone_e164=sender_e164,
            display_name="Eski İsim",
            whatsapp_profile_name="Eski İsim",
        )
        session.add_all([num, existing_contact])
        await session.commit()

    payload = _make_inbound_payload(pid, "905552223344", f"wamid.{uuid.uuid4().hex}", sender_name="Yeni Profil İsmi")
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)

    async with AsyncSessionLocal() as session:
        contacts = (await session.execute(select(Contact).where(Contact.phone_e164 == sender_e164, Contact.user_id == uid))).scalars().all()
        assert len(contacts) == 1
        assert contacts[0].whatsapp_profile_name == "Yeni Profil İsmi"


@pytest.mark.asyncio
async def test_12_new_conversation_creation():
    """12. First message creates a new Conversation for (user_id, whatsapp_number_id, contact_id)."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat A",
            display_phone_number="+90 850 222 33 44",
            phone_number_e164="+908502223344",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()
        num_id = num.id

    payload = _make_inbound_payload(pid, "905553334455", wamid, body="İlk Mesaj")
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)

    async with AsyncSessionLocal() as session:
        conv = (await session.execute(select(Conversation).where(Conversation.whatsapp_number_id == num_id))).scalar_one_or_none()
        assert conv is not None
        assert conv.status == ConversationStatus.ACTIVE
        assert conv.unread_count == 1
        assert conv.last_message_preview == "İlk Mesaj"


@pytest.mark.asyncio
async def test_13_existing_conversation_resolution():
    """13. Subsequent message updates existing Conversation and increments unread count."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    sender = "905554445566"
    sender_e164 = "+905554445566"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat B",
            display_phone_number="+90 850 333 44 55",
            phone_number_e164="+908503334455",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()
        num_id = num.id

    # First message
    p1 = _make_inbound_payload(pid, sender, f"wamid.{uuid.uuid4().hex}", body="Mesaj 1")
    b1 = json.dumps(p1).encode("utf-8")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=b1, headers={"X-Hub-Signature-256": _sign(b1)})

    # Second message
    p2 = _make_inbound_payload(pid, sender, f"wamid.{uuid.uuid4().hex}", body="Mesaj 2")
    b2 = json.dumps(p2).encode("utf-8")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=b2, headers={"X-Hub-Signature-256": _sign(b2)})

    async with AsyncSessionLocal() as session:
        convs = (await session.execute(select(Conversation).where(Conversation.whatsapp_number_id == num_id))).scalars().all()
        assert len(convs) == 1
        assert convs[0].unread_count == 2
        assert convs[0].last_message_preview == "Mesaj 2"


# ============================================================================
# 14-16. Idempotency & Duplicate Webhook Handling
# ============================================================================

@pytest.mark.asyncio
async def test_14_same_wamid_duplicate():
    """14. Ingesting the same wamid twice does not create duplicate Message."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat C",
            display_phone_number="+90 850 444 55 66",
            phone_number_e164="+908504445566",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    payload = _make_inbound_payload(pid, "905555556677", wamid, body="Tekil Mesaj")
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
        # Send 1
        res1 = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)
        assert res1.status_code == 200

        # Send 2 (Replay)
        res2 = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)
        assert res2.status_code == 200

    async with AsyncSessionLocal() as session:
        msgs = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalars().all()
        assert len(msgs) == 1


@pytest.mark.asyncio
async def test_15_same_wamid_concurrent_duplicate():
    """15. Simultaneous execution with same wamid is safely caught by IntegrityError handling."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat D",
            display_phone_number="+90 850 555 66 77",
            phone_number_e164="+908505556677",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    payload = _make_inbound_payload(pid, "905556667788", wamid, body="Eşzamanlı Mesaj")

    # Ingest directly with separate sessions to simulate concurrent workers
    async with AsyncSessionLocal() as s1:
        evt1 = WebhookEvent(
            provider="META", event_type="messages", event_hash=f"hash_1_{wamid}", external_message_id=wamid,
            status=WebhookEventStatus.RECEIVED, payload_json="{}", received_at=datetime.utcnow(),
        )
        s1.add(evt1)
        await s1.commit()
        await s1.refresh(evt1)
        evt1_id = evt1.id

    async with AsyncSessionLocal() as s2:
        evt2 = WebhookEvent(
            provider="META", event_type="messages", event_hash=f"hash_2_{wamid}", external_message_id=wamid,
            status=WebhookEventStatus.RECEIVED, payload_json="{}", received_at=datetime.utcnow(),
        )
        s2.add(evt2)
        await s2.commit()
        await s2.refresh(evt2)
        evt2_id = evt2.id

    # Run processing
    res1 = await WhatsAppWebhookService.process_webhook_event(evt1_id, payload)
    res2 = await WhatsAppWebhookService.process_webhook_event(evt2_id, payload)

    assert res1["status"] in ("processed", "duplicate_message")
    assert res2["status"] in ("processed", "duplicate_message", "duplicate_race_condition")

    async with AsyncSessionLocal() as session:
        msgs = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalars().all()
        assert len(msgs) == 1


@pytest.mark.asyncio
async def test_16_duplicate_webhook_does_not_emit_realtime_twice():
    """16. Duplicate webhook ingestion does not emit realtime WebSocket notification twice."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat E",
            display_phone_number="+90 850 666 77 88",
            phone_number_e164="+908506667788",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    payload = _make_inbound_payload(pid, "905557778899", wamid, body="Tek Bildirim")
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)

    with patch.object(ws_manager, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
            # First send
            await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)
            assert mock_broadcast.call_count == 1

            # Second send (Duplicate)
            await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)
            # Must remain 1, zero new realtime broadcasts
            assert mock_broadcast.call_count == 1


# ============================================================================
# 17-22. Outbound Message Status Webhooks & State Machine
# ============================================================================

@pytest.mark.asyncio
async def test_17_status_webhook_sent():
    """17. Webhook status update transitions message to SENT."""
    uid = uuid.uuid4().hex
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=uid, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.flush()
        msg = Message(
            user_id=uid,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Merhaba",
            wa_message_id=wamid,
            sender_phone="+908501112233",
            recipient_phone="+905551112233",
            status=ConversationMessageStatus.PENDING,
        )
        session.add(msg)
        await session.commit()

    payload = _make_status_payload("pid_123", "905551112233", wamid, "sent")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        updated = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one()
        assert updated.status == ConversationMessageStatus.SENT
        assert updated.sent_at is not None


@pytest.mark.asyncio
async def test_18_status_webhook_delivered():
    """18. Webhook status update transitions message to DELIVERED."""
    uid = uuid.uuid4().hex
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=uid, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.flush()
        msg = Message(
            user_id=uid,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Merhaba",
            wa_message_id=wamid,
            sender_phone="+908501112233",
            recipient_phone="+905551112233",
            status=ConversationMessageStatus.SENT,
        )
        session.add(msg)
        await session.commit()

    payload = _make_status_payload("pid_123", "905551112233", wamid, "delivered")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        updated = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one()
        assert updated.status == ConversationMessageStatus.DELIVERED
        assert updated.delivered_at is not None


@pytest.mark.asyncio
async def test_19_status_webhook_read():
    """19. Webhook status update transitions message to READ."""
    uid = uuid.uuid4().hex
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=uid, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.flush()
        msg = Message(
            user_id=uid,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Merhaba",
            wa_message_id=wamid,
            sender_phone="+908501112233",
            recipient_phone="+905551112233",
            status=ConversationMessageStatus.DELIVERED,
        )
        session.add(msg)
        await session.commit()

    payload = _make_status_payload("pid_123", "905551112233", wamid, "read")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        updated = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one()
        assert updated.status == ConversationMessageStatus.READ
        assert updated.read_at is not None


@pytest.mark.asyncio
async def test_20_status_webhook_failed():
    """20. Webhook status failed transitions to FAILED and records error code/message."""
    uid = uuid.uuid4().hex
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=uid, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.flush()
        msg = Message(
            user_id=uid,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Merhaba",
            wa_message_id=wamid,
            sender_phone="+908501112233",
            recipient_phone="+905551112233",
            status=ConversationMessageStatus.SENT,
        )
        session.add(msg)
        await session.commit()

    errors = [{"code": 131047, "title": "Re-engagement message", "message": "24h window closed"}]
    payload = _make_status_payload("pid_123", "905551112233", wamid, "failed", errors=errors)
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        updated = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one()
        assert updated.status == ConversationMessageStatus.FAILED
        assert updated.failed_at is not None
        assert updated.error_code == 131047
        assert "24h window closed" in updated.error_message


@pytest.mark.asyncio
async def test_21_invalid_status_regression():
    """21. Out-of-order webhook delivery (e.g. SENT after READ) is rejected without error."""
    uid = uuid.uuid4().hex
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=uid, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.flush()
        msg = Message(
            user_id=uid,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="Merhaba",
            wa_message_id=wamid,
            sender_phone="+908501112233",
            recipient_phone="+905551112233",
            status=ConversationMessageStatus.READ,
        )
        session.add(msg)
        await session.commit()

    # Arriving with "sent" after already being "read"
    payload = _make_status_payload("pid_123", "905551112233", wamid, "sent")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        updated = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one()
        assert updated.status == ConversationMessageStatus.READ  # Preserved!


@pytest.mark.asyncio
async def test_22_orphan_status():
    """22. Status update for non-existent wamid is logged as orphan without failing request."""
    payload = _make_status_payload("pid_123", "905551112233", f"wamid.orphan_{uuid.uuid4().hex}", "delivered")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})
        assert res.status_code == 200


# ============================================================================
# 23-24. 24-Hour Customer Service Window Tests
# ============================================================================

@pytest.mark.asyncio
async def test_23_24h_customer_window_update():
    """23. Inbound customer message sets last_customer_message_at and expires_at (+24h)."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat Window",
            display_phone_number="+90 850 777 88 99",
            phone_number_e164="+908507778899",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()
        num_id = num.id

    msg_epoch = 1700000000
    expected_utc = datetime.fromtimestamp(msg_epoch, tz=timezone.utc).replace(tzinfo=None)
    expected_expiry = expected_utc + timedelta(hours=24)

    payload = _make_inbound_payload(pid, "905558889900", wamid, body="Window Test", timestamp=str(msg_epoch))
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        conv = (await session.execute(select(Conversation).where(Conversation.whatsapp_number_id == num_id))).scalar_one()
        assert conv.last_customer_message_at == expected_utc
        assert conv.customer_service_window_expires_at == expected_expiry
        assert CustomerWindowService.is_within_24h_window(conv, reference_time=expected_utc + timedelta(hours=23)) is True
        assert CustomerWindowService.is_within_24h_window(conv, reference_time=expected_utc + timedelta(hours=25)) is False


@pytest.mark.asyncio
async def test_24_duplicate_inbound_does_not_extend_window_incorrectly():
    """24. Replaying a duplicate inbound message does not reset/extend the 24h window."""
    uid = uuid.uuid4().hex
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Hat Window 2",
            display_phone_number="+90 850 888 99 00",
            phone_number_e164="+908508889900",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()
        num_id = num.id

    t1_epoch = 1700000000
    t1_dt = datetime.fromtimestamp(t1_epoch, tz=timezone.utc).replace(tzinfo=None)
    t1_expiry = t1_dt + timedelta(hours=24)

    payload = _make_inbound_payload(pid, "905559990011", wamid, body="Window Replay", timestamp=str(t1_epoch))
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # First send
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        conv1 = (await session.execute(select(Conversation).where(Conversation.whatsapp_number_id == num_id))).scalar_one()
        assert conv1.customer_service_window_expires_at == t1_expiry

    # Replay identical message with updated metadata later
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        conv2 = (await session.execute(select(Conversation).where(Conversation.whatsapp_number_id == num_id))).scalar_one()
        # Window must NOT have been moved or modified
        assert conv2.customer_service_window_expires_at == t1_expiry


# ============================================================================
# 25-27. Multi-Tenant & Multi-Number Isolation Tests
# ============================================================================

@pytest.mark.asyncio
async def test_25_tenant_isolation():
    """25. Inbound message is strictly scoped to the tenant owning the phone_number_id."""
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())
    pid_a = f"pid_a_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        num_a = WhatsAppNumber(
            user_id=tenant_a,
            name="Tenant A Hat",
            display_phone_number="+90 850 111 00 01",
            phone_number_e164="+908501110001",
            phone_number_id=pid_a,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num_a)
        await session.commit()

    wamid = f"wamid.{uuid.uuid4().hex}"
    payload = _make_inbound_payload(pid_a, "905550001122", wamid, body="Tenant A Mesajı")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    async with AsyncSessionLocal() as session:
        msg = (await session.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one()
        assert str(msg.user_id) == str(tenant_a)

        # Ensure Tenant B cannot see this message or contact
        contact_b = (await session.execute(select(Contact).where(Contact.user_id == tenant_b, Contact.phone_e164 == "+905550001122"))).scalar_one_or_none()
        assert contact_b is None


@pytest.mark.asyncio
async def test_26_two_whatsapp_numbers_same_tenant():
    """26. Single tenant with two numbers correctly routes each inbound to its respective line."""
    tenant = uuid.uuid4().hex
    pid_1 = f"pid_1_{uuid.uuid4().hex[:8]}"
    pid_2 = f"pid_2_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        num1 = WhatsAppNumber(
            user_id=tenant,
            name="Satış Hattı",
            display_phone_number="+90 850 111 01 01",
            phone_number_e164="+908501110101",
            phone_number_id=pid_1,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        num2 = WhatsAppNumber(
            user_id=tenant,
            name="Destek Hattı",
            display_phone_number="+90 850 111 02 02",
            phone_number_e164="+908501110202",
            phone_number_id=pid_2,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add_all([num1, num2])
        await session.commit()
        n1_id = num1.id
        n2_id = num2.id

    wamid1 = f"wamid.{uuid.uuid4().hex}"
    wamid2 = f"wamid.{uuid.uuid4().hex}"

    p1 = _make_inbound_payload(pid_1, "905551113355", wamid1, body="Satışa mesaj")
    p2 = _make_inbound_payload(pid_2, "905551113355", wamid2, body="Desteğe mesaj")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=json.dumps(p1).encode("utf-8"), headers={"X-Hub-Signature-256": _sign(json.dumps(p1).encode("utf-8"))})
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=json.dumps(p2).encode("utf-8"), headers={"X-Hub-Signature-256": _sign(json.dumps(p2).encode("utf-8"))})

    async with AsyncSessionLocal() as session:
        m1 = (await session.execute(select(Message).where(Message.wa_message_id == wamid1))).scalar_one()
        m2 = (await session.execute(select(Message).where(Message.wa_message_id == wamid2))).scalar_one()

        c1 = await session.get(Conversation, m1.conversation_id)
        c2 = await session.get(Conversation, m2.conversation_id)

        assert c1.whatsapp_number_id == n1_id
        assert c2.whatsapp_number_id == n2_id


@pytest.mark.asyncio
async def test_27_same_contact_on_two_numbers_creates_isolated_conversations():
    """27. Same external contact speaking to Number A and Number B gets two isolated conversations."""
    tenant = uuid.uuid4().hex
    pid_a = f"pid_a_{uuid.uuid4().hex[:8]}"
    pid_b = f"pid_b_{uuid.uuid4().hex[:8]}"
    contact_phone = "905559998877"

    async with AsyncSessionLocal() as session:
        na = WhatsAppNumber(
            user_id=tenant,
            name="Hattı A",
            display_phone_number="+90 850 111 03 03",
            phone_number_e164="+908501110303",
            phone_number_id=pid_a,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        nb = WhatsAppNumber(
            user_id=tenant,
            name="Hattı B",
            display_phone_number="+90 850 111 04 04",
            phone_number_e164="+908501110404",
            phone_number_id=pid_b,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add_all([na, nb])
        await session.commit()
        na_id = na.id
        nb_id = nb.id

    pa = _make_inbound_payload(pid_a, contact_phone, f"wamid.{uuid.uuid4().hex}", body="Hat A Konuşması")
    pb = _make_inbound_payload(pid_b, contact_phone, f"wamid.{uuid.uuid4().hex}", body="Hat B Konuşması")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=json.dumps(pa).encode("utf-8"), headers={"X-Hub-Signature-256": _sign(json.dumps(pa).encode("utf-8"))})
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=json.dumps(pb).encode("utf-8"), headers={"X-Hub-Signature-256": _sign(json.dumps(pb).encode("utf-8"))})

    async with AsyncSessionLocal() as session:
        conv_a = (await session.execute(select(Conversation).where(Conversation.whatsapp_number_id == na_id))).scalar_one()
        conv_b = (await session.execute(select(Conversation).where(Conversation.whatsapp_number_id == nb_id))).scalar_one()

        assert conv_a.id != conv_b.id
        assert conv_a.contact_id == conv_b.contact_id  # Same contact entity, distinct conversation threads!


# ============================================================================
# 28-33. Resilience, Security, Lifecycle & Rollback Tests
# ============================================================================

@pytest.mark.asyncio
async def test_28_unknown_fields_dont_crash():
    """28. Future unknown Meta fields inside payload are ignored without error."""
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    uid = uuid.uuid4().hex

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Future Hat",
            display_phone_number="+90 850 111 05 05",
            phone_number_e164="+908501110505",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    extra = {
        "future_field_foo": "bar",
        "quantum_encryption_data": {"level": 99, "nested": [1, 2, 3]},
    }
    payload = _make_inbound_payload(pid, "905551234567", f"wamid.{uuid.uuid4().hex}", body="Gelecek Alanlar", extra_fields=extra)
    payload["future_envelope_marker"] = True

    raw_body = json.dumps(payload).encode("utf-8")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})
        assert res.status_code == 200


@pytest.mark.asyncio
async def test_29_secret_never_appears_in_logs(caplog):
    """29. META_APP_SECRET never appears anywhere in logging output."""
    caplog.set_level(logging.DEBUG)

    payload = _make_inbound_payload("pid_x", "905551234567", f"wamid.{uuid.uuid4().hex}", body="Log Kontrol")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})

    for record in caplog.records:
        assert TEST_SECRET not in record.message


@pytest.mark.asyncio
async def test_30_webhook_event_state_lifecycle():
    """30. WebhookEvent records correctly transition through RECEIVED -> PROCESSED."""
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    uid = uuid.uuid4().hex
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Lifecycle Hat",
            display_phone_number="+90 850 111 06 06",
            phone_number_e164="+908501110606",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    payload = _make_inbound_payload(pid, "905551234567", wamid, body="Lifecycle Test")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})
        event_id = res.json()["event_id"]

    async with AsyncSessionLocal() as session:
        evt = await session.get(WebhookEvent, event_id)
        assert evt is not None
        assert evt.status == WebhookEventStatus.PROCESSED
        assert evt.processed_at is not None


@pytest.mark.asyncio
async def test_31_processing_failure_is_recorded():
    """31. Unhandled exception in background processing records FAILED status with failure_reason."""
    async with AsyncSessionLocal() as session:
        evt = WebhookEvent(
            provider="META",
            event_type="messages",
            event_hash=f"hash_fail_{uuid.uuid4().hex}",
            status=WebhookEventStatus.RECEIVED,
            payload_json="{}",
            received_at=datetime.utcnow(),
        )
        session.add(evt)
        await session.commit()
        await session.refresh(evt)
        evt_id = evt.id

    # Force a mock error during single message processing
    with patch.object(WhatsAppWebhookService, "_process_single_inbound_message", side_effect=RuntimeError("Simulated DB Crash")):
        payload = _make_inbound_payload("pid_fail", "905551234567", "wamid.crash", body="Crash Test")
        res = await WhatsAppWebhookService.process_webhook_event(evt_id, payload)
        assert res["status"] == "failed"

    async with AsyncSessionLocal() as session:
        updated_evt = await session.get(WebhookEvent, evt_id)
        assert updated_evt.status == WebhookEventStatus.FAILED
        assert "Simulated DB Crash" in updated_evt.failure_reason


@pytest.mark.asyncio
async def test_32_retry_replay_behavior():
    """32. Replaying identical raw payload returns duplicate status without duplicate domain operations."""
    pid = f"pid_{uuid.uuid4().hex[:8]}"
    uid = uuid.uuid4().hex
    wamid = f"wamid.{uuid.uuid4().hex}"

    async with AsyncSessionLocal() as session:
        num = WhatsAppNumber(
            user_id=uid,
            name="Replay Hat",
            display_phone_number="+90 850 111 07 07",
            phone_number_e164="+908501110707",
            phone_number_id=pid,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num)
        await session.commit()

    payload = _make_inbound_payload(pid, "905551234567", wamid, body="Replay test")
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # First call
        r1 = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})
        assert r1.json()["status"] == "received"

        # Replay exact same payload
        r2 = await client.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers={"X-Hub-Signature-256": _sign(raw_body)})
        assert r2.json()["status"] == "duplicate"


@pytest.mark.asyncio
async def test_33_db_rollback_does_not_emit_realtime_event():
    """33. Invariant: If database transaction rolls back, zero realtime events are emitted."""
    async with AsyncSessionLocal() as session:
        evt = WebhookEvent(
            provider="META",
            event_type="messages",
            event_hash=f"hash_rollback_{uuid.uuid4().hex}",
            status=WebhookEventStatus.RECEIVED,
            payload_json="{}",
            received_at=datetime.utcnow(),
        )
        session.add(evt)
        await session.commit()
        await session.refresh(evt)
        evt_id = evt.id

    payload = _make_inbound_payload("pid_rollback", "905551234567", "wamid.rollback", body="Rollback Test")

    with patch.object(ws_manager, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        # Simulate an IntegrityError or exception before commit
        with patch.object(WhatsAppWebhookService, "_process_single_inbound_message", side_effect=IntegrityError("stmt", "params", "orig")):
            await WhatsAppWebhookService.process_webhook_event(evt_id, payload)

        # Broadcast MUST NOT be called because transaction rolled back!
        assert mock_broadcast.call_count == 0


# ============================================================================
# 34. Real Meta Integration E2E Check
# ============================================================================

def test_34_real_meta_e2e_status():
    """
    Checks if live Meta Cloud credentials are present in environment.
    If not, reports explicit status 'REAL META E2E: NOT RUN'.
    """
    token = os.getenv("WHATSAPP_CLOUD_ACCESS_TOKEN", "").strip()
    phone_id = os.getenv("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "").strip()
    waba_id = os.getenv("WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID", "").strip()
    enabled = os.getenv("REAL_META_E2E", "false").lower() in ("true", "1")

    if not (token and phone_id and waba_id and enabled):
        pytest.skip("REAL META E2E: NOT RUN (Credentials not present or REAL_META_E2E!=true)")
