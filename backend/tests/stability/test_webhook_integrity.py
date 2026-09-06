import hmac
import hashlib
import json
import uuid
import pytest
from httpx import AsyncClient
from unittest.mock import patch

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message, MessageDirection, ConversationMessageStatus
from backend.app.services.whatsapp_cloud_service import WhatsAppCloudService
from backend.tests.stability.conftest import unique_phone


@pytest.mark.asyncio
async def test_webhook_get_verification_handshake(client: AsyncClient):
    """
    Proves Meta Webhook GET verification handshake obeys Meta Graph API protocols:
    Valid verify token -> 200 plain text challenge
    Invalid verify token -> 403 Forbidden
    """
    token = "tezlify_test_verify_token_123"
    with patch.object(settings, "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", token):
        # 1. Valid handshake
        res_valid = await client.get("/api/v1/whatsapp/cloud-webhook", params={
            "hub.mode": "subscribe",
            "hub.challenge": "1158201444",
            "hub.verify_token": token
        })
        assert res_valid.status_code == 200
        assert res_valid.text == "1158201444"

        # 2. Invalid verify token
        res_invalid = await client.get("/api/v1/whatsapp/cloud-webhook", params={
            "hub.mode": "subscribe",
            "hub.challenge": "1158201444",
            "hub.verify_token": "wrong_token"
        })
        assert res_invalid.status_code == 403


@pytest.mark.asyncio
async def test_webhook_hmac_signature_validation(client: AsyncClient):
    """Proves incoming POST requests are authenticated cryptographically via HMAC-SHA256."""
    secret = "my_meta_app_secret_xyz"
    raw_payload = json.dumps({"object": "whatsapp_business_account", "entry": []}).encode("utf-8")
    
    # Calculate valid HMAC
    valid_sig = "sha256=" + hmac.new(secret.encode("utf-8"), raw_payload, hashlib.sha256).hexdigest()
    invalid_sig = "sha256=invalid_hash_value_123"

    with patch.object(settings, "WHATSAPP_CLOUD_APP_SECRET", secret):
        # 1. Valid signature
        res_valid = await client.post(
            "/api/v1/whatsapp/cloud-webhook",
            content=raw_payload,
            headers={"Content-Type": "application/json", "X-Hub-Signature-256": valid_sig}
        )
        assert res_valid.status_code == 200

        # 2. Invalid signature
        res_invalid = await client.post(
            "/api/v1/whatsapp/cloud-webhook",
            content=raw_payload,
            headers={"Content-Type": "application/json", "X-Hub-Signature-256": invalid_sig}
        )
        assert res_invalid.status_code == 401


@pytest.mark.asyncio
async def test_webhook_event_idempotency_and_message_ingestion(client: AsyncClient):
    """
    CRITICAL INVARIANT 15:
    Proves incoming message webhook is idempotent: posting the exact same message event
    twice does NOT create duplicate Message records in the conversation.
    """
    phone = unique_phone(prefix="+90532")
    msg_id = f"wamid.test_{uuid.uuid4().hex}"
    
    # Pre-seed Lead in CRM
    async with AsyncSessionLocal() as session:
        from backend.app.models.lead import Lead
        lead = Lead(
            name="Test Müşteri",
            phone=phone,
            phone_e164=phone,
            is_whatsapp_eligible=True
        )
        session.add(lead)
        await session.commit()
    
    meta_payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "1234567890",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "905550001122",
                                "phone_number_id": "100020003000"
                            },
                            "contacts": [
                                {
                                    "profile": {"name": "Test Müşteri"},
                                    "wa_id": phone.replace("+", "")
                                }
                            ],
                            "messages": [
                                {
                                    "from": phone.replace("+", ""),
                                    "id": msg_id,
                                    "timestamp": "1725184800",
                                    "type": "text",
                                    "text": {"body": "Merhaba, randevu almak istiyorum."}
                                }
                            ]
                        }
                    }
                ]
            }
        ]
    }

    raw_body = json.dumps(meta_payload).encode("utf-8")
    secret = "idempotency_test_secret"
    sig = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    headers = {"Content-Type": "application/json", "X-Hub-Signature-256": sig}

    with patch.object(settings, "WHATSAPP_CLOUD_APP_SECRET", secret):
        # 1. First Webhook Delivery
        res_1 = await client.post("/api/v1/whatsapp/cloud-webhook", content=raw_body, headers=headers)
        assert res_1.status_code == 200

        # 2. Second Webhook Delivery (Duplicate Event from Meta network retry)
        res_2 = await client.post("/api/v1/whatsapp/cloud-webhook", content=raw_body, headers=headers)
        assert res_2.status_code == 200

    # 3. Verify Database: Exactly ONE Message with this wamid exists
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        stmt = select(Message).where(Message.wa_message_id == msg_id)
        res = await session.execute(stmt)
        messages = res.scalars().all()
        assert len(messages) == 1
        assert messages[0].body == "Merhaba, randevu almak istiyorum."
        assert messages[0].direction == MessageDirection.INBOUND


@pytest.mark.asyncio
async def test_unknown_phone_webhook_creates_lead_and_conversation(client: AsyncClient):
    """
    HIGH-01 REGRESSION PROOF:
    Proves incoming webhook from an UNKNOWN phone (not previously in CRM):
    1. Does NOT crash with UnboundLocalError or 500 error.
    2. Auto-provisions a Lead and active Conversation.
    3. Persists the inbound Message with unread_count = 1.
    4. Handles duplicate retry idempotently without creating duplicate leads or messages.
    """
    from backend.app.models.lead import Lead, LeadStatus
    from backend.app.models.conversation import ConversationStatus

    unknown_phone = unique_phone(prefix="+90533")
    msg_id = f"wamid.unknown_{uuid.uuid4().hex}"
    
    meta_payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "1234567890",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "905550001122",
                                "phone_number_id": "100020003000"
                            },
                            "contacts": [
                                {
                                    "profile": {"name": "Bilinmeyen Potansiyel Müşteri"},
                                    "wa_id": unknown_phone.replace("+", "")
                                }
                            ],
                            "messages": [
                                {
                                    "from": unknown_phone.replace("+", ""),
                                    "id": msg_id,
                                    "timestamp": "1725184900",
                                    "type": "text",
                                    "text": {"body": "Fiyat teklifi alabilir miyim?"}
                                }
                            ]
                        }
                    }
                ]
            }
        ]
    }

    raw_body = json.dumps(meta_payload).encode("utf-8")
    secret = "unknown_phone_test_secret"
    sig = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    headers = {"Content-Type": "application/json", "X-Hub-Signature-256": sig}

    with patch.object(settings, "WHATSAPP_CLOUD_APP_SECRET", secret):
        # 1. Delivery for brand new contact
        res_1 = await client.post("/api/v1/whatsapp/cloud-webhook", content=raw_body, headers=headers)
        assert res_1.status_code == 200, f"Expected 200, got {res_1.status_code}: {res_1.text}"

        # 2. Duplicate retry delivery
        res_2 = await client.post("/api/v1/whatsapp/cloud-webhook", content=raw_body, headers=headers)
        assert res_2.status_code == 200

    # 3. Verify Database: Lead, Conversation, and Message exist and are unique
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        
        # Verify Lead
        lead_stmt = select(Lead).where(Lead.phone_e164 == unknown_phone)
        lead = (await session.execute(lead_stmt)).scalar_one_or_none()
        assert lead is not None
        assert lead.name == "Bilinmeyen Potansiyel Müşteri"
        assert lead.is_whatsapp_eligible is True

        # Verify Conversation
        conv_stmt = select(Conversation).where(Conversation.lead_id == lead.id)
        convs = (await session.execute(conv_stmt)).scalars().all()
        assert len(convs) == 1
        assert convs[0].status == ConversationStatus.ACTIVE
        assert convs[0].unread_count == 1

        # Verify Message
        msg_stmt = select(Message).where(Message.wa_message_id == msg_id)
        msgs = (await session.execute(msg_stmt)).scalars().all()
        assert len(msgs) == 1
        assert msgs[0].conversation_id == convs[0].id
        assert msgs[0].body == "Fiyat teklifi alabilir miyim?"
        assert msgs[0].direction == MessageDirection.INBOUND

