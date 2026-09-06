import hmac
import hashlib
import json
import pytest
import httpx
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport
from datetime import datetime

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.blacklist import Blacklist
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.message import Message
from backend.app.services.whatsapp_cloud_client import WhatsAppCloudApiClient
from backend.app.services.whatsapp_sender import CloudApiSender


def _make_headers(payload_dict: dict, secret: str = "") -> dict:
    body_bytes = json.dumps(payload_dict).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    app_secret = secret or settings.WHATSAPP_CLOUD_APP_SECRET
    if app_secret:
        sig_hash = hmac.new(app_secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
        headers["X-Hub-Signature-256"] = f"sha256={sig_hash}"
    return headers


# ==============================================================================
# 1. GET Webhook Handshake Verification Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_cloud_webhook_verification_success():
    test_verify_token = "test-webhook-verify-token-secret"
    with patch.object(settings, "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", test_verify_token):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get(
                "/api/v1/whatsapp/cloud-webhook",
                params={
                    "hub.mode": "subscribe",
                    "hub.verify_token": test_verify_token,
                    "hub.challenge": "1158201444",
                },
            )
            assert res.status_code == 200
            assert res.text == "1158201444"


@pytest.mark.asyncio
async def test_cloud_webhook_verification_invalid_token():
    test_verify_token = "test-webhook-verify-token-secret"
    with patch.object(settings, "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", test_verify_token):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get(
                "/api/v1/whatsapp/cloud-webhook",
                params={
                    "hub.mode": "subscribe",
                    "hub.verify_token": "wrong-verify-token",
                    "hub.challenge": "1158201444",
                },
            )
            assert res.status_code == 403
            assert "Invalid verify token" in res.json()["detail"]


@pytest.mark.asyncio
async def test_cloud_webhook_verification_invalid_mode():
    test_verify_token = "test-webhook-verify-token-secret"
    with patch.object(settings, "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", test_verify_token):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get(
                "/api/v1/whatsapp/cloud-webhook",
                params={
                    "hub.mode": "unsubscribe",
                    "hub.verify_token": test_verify_token,
                    "hub.challenge": "1158201444",
                },
            )
            assert res.status_code == 403


@pytest.mark.asyncio
async def test_cloud_webhook_verification_missing_params():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/cloud-webhook")
        assert res.status_code == 403


# ==============================================================================
# 2. Signature Validation Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_cloud_webhook_signature_validation():
    test_secret = "test-meta-app-secret-12345"
    with patch.object(settings, "WHATSAPP_CLOUD_APP_SECRET", test_secret):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            payload = {
                "object": "whatsapp_business_account",
                "entry": []
            }
            body_bytes = json.dumps(payload).encode("utf-8")

            # 1. Valid Signature
            sig_hash = hmac.new(test_secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
            valid_res = await client.post(
                "/api/v1/whatsapp/cloud-webhook",
                content=body_bytes,
                headers={"Content-Type": "application/json", "X-Hub-Signature-256": f"sha256={sig_hash}"}
            )
            assert valid_res.status_code == 200
            assert valid_res.json()["status"] == "success"

            # 2. Tampered / Invalid Signature
            invalid_res = await client.post(
                "/api/v1/whatsapp/cloud-webhook",
                content=body_bytes,
                headers={"Content-Type": "application/json", "X-Hub-Signature-256": "sha256=invalidhash123"}
            )
            assert invalid_res.status_code == 401
            assert "Invalid webhook signature" in invalid_res.json()["detail"]


# ==============================================================================
# 3. POST Webhook Incoming Message Ingestion Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_cloud_webhook_incoming_message_updates_lead_and_notes():
    test_phone = "+905329998877"
    async with AsyncSessionLocal() as db:
        # Pre-cleanup in case of prior test runs
        await db.execute(Message.__table__.delete().where(Message.wa_message_id == "wamid.HBgLMTAwMDAwMDAwMDI"))
        await db.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db.commit()

        lead = Lead(
            name="Test WhatsApp Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.CONTACTED,
            city="İstanbul",
            district="Kadıköy",
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)
        lead_id = lead.id

    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "100000000000001",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {"display_phone_number": "905320000000", "phone_number_id": "1001"},
                            "contacts": [{"profile": {"name": "Ahmet Yılmaz"}, "wa_id": "905329998877"}],
                            "messages": [
                                {
                                    "from": "905329998877",
                                    "id": "wamid.HBgLMTAwMDAwMDAwMDI",
                                    "timestamp": "1700000000",
                                    "type": "text",
                                    "text": {"body": "Fiyat ve randevu bilgisi rica edebilir miyim?"},
                                }
                            ],
                        },
                        "field": "messages",
                    }
                ],
            }
        ],
    }

    body_bytes = json.dumps(webhook_payload).encode("utf-8")
    headers = _make_headers(webhook_payload)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/v1/whatsapp/cloud-webhook", content=body_bytes, headers=headers)
        assert res.status_code == 200
        assert res.json()["processed_messages"] == 1

    # Verify database state
    async with AsyncSessionLocal() as db:
        updated_lead = await db.get(Lead, lead_id)
        assert updated_lead is not None
        assert updated_lead.status == LeadStatus.REPLIED
        assert "Fiyat ve randevu bilgisi rica edebilir miyim?" in updated_lead.notes

        # Clean up
        await db.delete(updated_lead)
        await db.commit()


@pytest.mark.asyncio
async def test_cloud_webhook_incoming_message_opt_out_triggers_blacklist():
    test_phone = "+905328887766"
    async with AsyncSessionLocal() as db:
        # Pre-cleanup in case of prior test runs
        await db.execute(Message.__table__.delete().where(Message.wa_message_id == "wamid.OPT_OUT_TEST_1"))
        await db.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db.execute(Blacklist.__table__.delete().where(Blacklist.phone_e164 == test_phone))
        await db.commit()

        lead = Lead(
            name="OptOut Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.CONTACTED,
            city="İzmir",
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)
        lead_id = lead.id

    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "100000000000001",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "messages": [
                                {
                                    "from": "905328887766",
                                    "id": "wamid.OPT_OUT_TEST_1",
                                    "timestamp": "1700000000",
                                    "type": "text",
                                    "text": {"body": "Mesaj istemiyorum iptal edin"},
                                }
                            ],
                        },
                        "field": "messages",
                    }
                ],
            }
        ],
    }

    body_bytes = json.dumps(webhook_payload).encode("utf-8")
    headers = _make_headers(webhook_payload)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/v1/whatsapp/cloud-webhook", content=body_bytes, headers=headers)
        assert res.status_code == 200

    async with AsyncSessionLocal() as db:
        updated_lead = await db.get(Lead, lead_id)
        assert updated_lead.status == LeadStatus.UNSUBSCRIBED

        # Verify Blacklist entry
        bl = (await db.execute(
            Blacklist.__table__.select().where(Blacklist.phone_e164 == test_phone)
        )).first()
        assert bl is not None

        # Clean up
        await db.delete(updated_lead)
        await db.execute(Blacklist.__table__.delete().where(Blacklist.phone_e164 == test_phone))
        await db.commit()


# ==============================================================================
# 4. POST Webhook Outbound Status Updates Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_cloud_webhook_status_delivered_and_read_progression():
    test_wamid = "wamid.HBgLSTATUS_TEST_101"
    test_phone = "+905321110022"
    async with AsyncSessionLocal() as db:
        # Pre-cleanup
        await db.execute(MessageLog.__table__.delete().where(MessageLog.wa_message_id == test_wamid))
        await db.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db.commit()

        lead = Lead(name="Status Test Lead", phone=test_phone, phone_e164=test_phone)
        db.add(lead)
        await db.commit()
        await db.refresh(lead)

        log = MessageLog(
            lead_id=lead.id,
            target_phone=test_phone,
            rendered_message="Kampanya duyurusu",
            status=MessageStatus.SENT,
            wa_message_id=test_wamid,
        )
        db.add(log)
        await db.commit()
        await db.refresh(log)
        log_id = log.id
        lead_id = lead.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Update to DELIVERED
        payload_delivered = {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": "10001",
                    "changes": [
                        {
                            "value": {
                                "messaging_product": "whatsapp",
                                "statuses": [
                                    {
                                        "id": test_wamid,
                                        "status": "delivered",
                                        "timestamp": "1700000005",
                                        "recipient_id": "905321110022",
                                    }
                                ],
                            },
                            "field": "messages",
                        }
                    ],
                }
            ],
        }
        res_del = await client.post(
            "/api/v1/whatsapp/cloud-webhook",
            content=json.dumps(payload_delivered).encode("utf-8"),
            headers=_make_headers(payload_delivered),
        )
        assert res_del.status_code == 200
        assert res_del.json()["processed_statuses"] == 1

        async with AsyncSessionLocal() as db:
            msg_log = await db.get(MessageLog, log_id)
            assert msg_log.status == MessageStatus.DELIVERED

        # 2. Update to READ
        payload_read = {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": "10001",
                    "changes": [
                        {
                            "value": {
                                "messaging_product": "whatsapp",
                                "statuses": [
                                    {
                                        "id": test_wamid,
                                        "status": "read",
                                        "timestamp": "1700000010",
                                        "recipient_id": "905321110022",
                                    }
                                ],
                            },
                            "field": "messages",
                        }
                    ],
                }
            ],
        }
        res_read = await client.post(
            "/api/v1/whatsapp/cloud-webhook",
            content=json.dumps(payload_read).encode("utf-8"),
            headers=_make_headers(payload_read),
        )
        assert res_read.status_code == 200

        async with AsyncSessionLocal() as db:
            msg_log = await db.get(MessageLog, log_id)
            assert msg_log.status == MessageStatus.READ

            # 3. Monotonic protection: Re-sending "delivered" should NOT downgrade status from READ
            await client.post(
                "/api/v1/whatsapp/cloud-webhook",
                content=json.dumps(payload_delivered).encode("utf-8"),
                headers=_make_headers(payload_delivered),
            )
            await db.refresh(msg_log)
            assert msg_log.status == MessageStatus.READ

            # Clean up
            await db.delete(msg_log)
            lead_obj = await db.get(Lead, lead_id)
            if lead_obj:
                await db.delete(lead_obj)
            await db.commit()


@pytest.mark.asyncio
async def test_cloud_webhook_status_failed_records_error():
    test_wamid = "wamid.HBgLSTATUS_FAIL_202"
    test_phone = "+905321119900"
    async with AsyncSessionLocal() as db:
        # Pre-cleanup
        await db.execute(MessageLog.__table__.delete().where(MessageLog.wa_message_id == test_wamid))
        await db.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db.commit()

        lead = Lead(name="Fail Lead", phone=test_phone, phone_e164=test_phone)
        db.add(lead)
        await db.commit()
        await db.refresh(lead)

        log = MessageLog(
            lead_id=lead.id,
            target_phone=test_phone,
            rendered_message="Test",
            status=MessageStatus.SENT,
            wa_message_id=test_wamid,
        )
        db.add(log)
        await db.commit()
        await db.refresh(log)
        log_id = log.id
        lead_id = lead.id

    payload_failed = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "10001",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "statuses": [
                                {
                                    "id": test_wamid,
                                    "status": "failed",
                                    "timestamp": "1700000020",
                                    "recipient_id": "905321119900",
                                    "errors": [
                                        {
                                            "code": 131026,
                                            "title": "Message undeliverable",
                                            "message": "Recipient phone is not a valid WhatsApp user",
                                        }
                                    ],
                                }
                            ],
                        },
                        "field": "messages",
                    }
                ],
            }
        ],
    }

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/whatsapp/cloud-webhook",
            content=json.dumps(payload_failed).encode("utf-8"),
            headers=_make_headers(payload_failed),
        )
        assert res.status_code == 200

    async with AsyncSessionLocal() as db:
        msg_log = await db.get(MessageLog, log_id)
        assert msg_log.status == MessageStatus.FAILED
        assert "131026" in msg_log.error_reason
        assert "Recipient phone is not a valid WhatsApp user" in msg_log.error_reason

        # Clean up
        await db.delete(msg_log)
        lead_obj = await db.get(Lead, lead_id)
        if lead_obj:
            await db.delete(lead_obj)
        await db.commit()


# ==============================================================================
# 5. WhatsAppCloudApiClient Unit Tests (Mocked Graph API)
# ==============================================================================

@pytest.mark.asyncio
async def test_cloud_client_send_text_message_success():
    client = WhatsAppCloudApiClient(
        access_token="test_valid_token",
        phone_number_id="1005001",
        api_version="v21.0",
    )

    mock_resp = httpx.Response(
        status_code=200,
        json={
            "messaging_product": "whatsapp",
            "contacts": [{"input": "905321002030", "wa_id": "905321002030"}],
            "messages": [{"id": "wamid.HBgLMTAwMDAwMDAx"}],
        },
        request=httpx.Request("POST", "https://graph.facebook.com/v21.0/1005001/messages"),
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_resp
        res = await client.send_text_message(
            to_phone="+905321002030",
            message_text="Merhaba, Tezlify üzerinden test!",
        )

        assert res["success"] is True
        assert res["message_id"] == "wamid.HBgLMTAwMDAwMDAx"
        assert res["error"] is None


@pytest.mark.asyncio
async def test_cloud_client_send_text_message_auth_error():
    client = WhatsAppCloudApiClient(
        access_token="test_expired_token",
        phone_number_id="1005001",
    )

    mock_resp = httpx.Response(
        status_code=401,
        json={
            "error": {
                "message": "Error validating access token: Session has expired.",
                "type": "OAuthException",
                "code": 190,
                "error_subcode": 463,
            }
        },
        request=httpx.Request("POST", "https://graph.facebook.com/v21.0/1005001/messages"),
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_resp
        res = await client.send_text_message(
            to_phone="+905321002030",
            message_text="Test",
        )

        assert res["success"] is False
        assert res["message_id"] is None
        assert "HTTP 401" in res["error"]
        assert "190" in res["error"]


@pytest.mark.asyncio
async def test_cloud_client_send_text_message_rate_limit():
    client = WhatsAppCloudApiClient(
        access_token="test_token",
        phone_number_id="1005001",
    )

    mock_resp = httpx.Response(
        status_code=429,
        json={
            "error": {
                "message": "(#130429) Rate limit hit",
                "type": "OAuthException",
                "code": 130429,
            }
        },
        request=httpx.Request("POST", "https://graph.facebook.com/v21.0/1005001/messages"),
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_resp
        res = await client.send_text_message(
            to_phone="+905321002030",
            message_text="Test",
        )

        assert res["success"] is False
        assert "429" in res["error"]
        assert "130429" in res["error"]


# ==============================================================================
# 6. CloudApiSender Protocol Adapter Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_cloud_api_sender_protocol_conformance():
    mock_client = AsyncMock()
    mock_client.send_text_message.return_value = {
        "success": True,
        "message_id": "wamid.SENDER_CONFORMANCE_1",
        "error": None,
    }

    sender = CloudApiSender(client=mock_client)
    res = await sender.send_message(
        session_name="MetaCloud",
        phone_e164="+905321002030",
        message_text="Hello via Cloud API Sender",
        typing_seconds=2,
    )

    assert res["success"] is True
    assert res["is_simulated"] is False
    assert res["message_id"] == "wamid.SENDER_CONFORMANCE_1"
    assert res["error"] is None
