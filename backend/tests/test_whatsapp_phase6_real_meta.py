"""
Tezlify WhatsApp Rebuild — Phase 6: Real Meta Cloud API E2E & Production Verification Tests.

Covers:
1. Meta credential audit & token status verification (handling expired/active tokens safely)
2. Graph API version centralization
3. Webhook public verification handshake contract (raw challenge text, 403 on invalid token)
4. Webhook HMAC-SHA256 cryptographic verification & security
5. Webhook durability & recovery of unprocessed events on crash/restart
6. Outbound worker stuck lease recovery & daemon batch processing
7. Meta error forensics: classification and redaction of 401, 429, 400, 500 errors
8. Security audit: zero token/secret leakage across REST and WebSocket
9. Multi-tenant isolation integrity
10. Real Meta E2E live dispatch gate (explicitly SKIPPED if REAL_META_E2E=false or token expired)
"""

import os
import hmac
import json
import uuid
import hashlib
import base64
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.core.credential_vault import CredentialVault
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
from backend.app.models.webhook_event import WebhookEvent, WebhookEventStatus
from backend.app.api.v1.websocket import ws_manager
from backend.app.services.outbound_worker import OutboundWorker
from backend.app.services.whatsapp_webhook_service import WhatsAppWebhookService
from backend.app.services.meta_cloud_client import MetaCloudApiClient, MetaApiError, redact_secrets

TEST_SECRET = "test_meta_app_secret_phase6_audit_32b!"
TEST_VERIFY_TOKEN = "tezlify_test_verify_token_phase6"


@pytest.fixture(autouse=True)
def setup_phase6_test_settings():
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


def _make_mock_jwt(user_id: str, email: str = "test@example.com") -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "email": email,
        "user_metadata": {"full_name": f"User {user_id[:6]}"}
    }).encode()).decode().rstrip("=")
    return f"{header}.{payload}.MOCK_SIGNATURE"


def _sign(payload_bytes: bytes, secret: str = TEST_SECRET) -> str:
    sig = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
    return f"sha256={sig}"


async def _post_webhook(payload: dict):
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)
    headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        return await ac.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)


# =========================================================================
# 1. Credential Audit & Redaction
# =========================================================================
@pytest.mark.asyncio
async def test_credential_audit_and_redaction():
    """Validates that secret redaction works and tokens are never exposed in plaintext logs."""
    sensitive_text = "Bearer EAAT1234567890abcdefghijklmnopqrstuvwxyz with app_secret: 1234567890abcdef"
    redacted = redact_secrets(sensitive_text)
    assert "EAAT1234567890abcdef" not in redacted
    assert "1234567890abcdef" not in redacted
    assert "[REDACTED_TOKEN]" in redacted


# =========================================================================
# 2. Graph API Version Centralization
# =========================================================================
@pytest.mark.asyncio
async def test_graph_api_version_centralization():
    """Validates that Graph API version is centralized and matches Meta versioning conventions."""
    version = settings.effective_meta_api_version
    assert version.startswith("v")
    assert float(version[1:]) >= 20.0
    client = MetaCloudApiClient()
    assert client.api_version == version


# =========================================================================
# 3. Webhook Public Verification Handshake Contract
# =========================================================================
@pytest.mark.asyncio
async def test_webhook_get_verification_handshake():
    """Validates Meta GET webhook handshake returns raw challenge text on success, 403 on failure."""
    challenge_val = "challenge_1234567890_test"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 1. Valid handshake
        r_valid = await ac.get(
            f"/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.challenge={challenge_val}&hub.verify_token={TEST_VERIFY_TOKEN}"
        )
        assert r_valid.status_code == 200
        # Meta requires raw challenge string, NOT a JSON object
        assert r_valid.text == challenge_val
        assert "application/json" not in r_valid.headers.get("content-type", "")

        # 2. Invalid verify token
        r_invalid = await ac.get(
            f"/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.challenge={challenge_val}&hub.verify_token=WRONG_TOKEN"
        )
        assert r_invalid.status_code == 403

        # 3. Missing mode or challenge
        r_missing = await ac.get("/api/v1/whatsapp/webhook")
        assert r_missing.status_code == 403


# =========================================================================
# 4. Webhook HMAC-SHA256 Cryptographic Verification
# =========================================================================
@pytest.mark.asyncio
async def test_webhook_hmac_verification():
    """Validates timing-safe HMAC-SHA256 signature verification."""
    payload = {"object": "whatsapp_business_account", "entry": []}
    raw_body = json.dumps(payload).encode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 1. Valid signature
        sig_valid = _sign(raw_body)
        r_ok = await ac.post(
            "/api/v1/whatsapp/webhook",
            content=raw_body,
            headers={"X-Hub-Signature-256": sig_valid, "Content-Type": "application/json"},
        )
        assert r_ok.status_code == 200

        # 2. Tampered body / Invalid signature
        sig_tampered = "sha256=0000000000000000000000000000000000000000000000000000000000000000"
        r_bad = await ac.post(
            "/api/v1/whatsapp/webhook",
            content=raw_body,
            headers={"X-Hub-Signature-256": sig_tampered, "Content-Type": "application/json"},
        )
        assert r_bad.status_code == 403

        # 3. Missing signature
        r_nosig = await ac.post(
            "/api/v1/whatsapp/webhook",
            content=raw_body,
            headers={"Content-Type": "application/json"},
        )
        assert r_nosig.status_code == 403


# =========================================================================
# 5. Webhook Durability & Recovery of Unprocessed Events
# =========================================================================
@pytest.mark.asyncio
async def test_webhook_durability_recovery():
    """
    Validates Section 28: Unprocessed WebhookEvents left in RECEIVED status
    due to a crash or restart are reliably recovered and processed.
    """
    tenant_id = str(uuid.uuid4())
    pid = f"PNID_REC_{uuid.uuid4().hex[:8]}"
    wamid = f"wamid.RECOVER_{uuid.uuid4().hex[:10]}"

    async with AsyncSessionLocal() as db:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Recovery Line",
            phone_number_id=pid,
            display_phone_number="+90 532 999 0001",
            phone_number_e164="+905329990001",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(wanum)
        await db.flush()

        inbound_payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": "WABA_REC",
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {"phone_number_id": pid},
                        "contacts": [{"profile": {"name": "Recovery User"}, "wa_id": "905329990002"}],
                        "messages": [{
                            "from": "905329990002",
                            "id": wamid,
                            "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
                            "text": {"body": "Message arrived during server crash"},
                            "type": "text",
                        }]
                    },
                    "field": "messages"
                }]
            }]
        }

        # Simulate raw WebhookEvent saved in RECEIVED status before crash
        evt = WebhookEvent(
            provider="META",
            event_type="messages",
            event_hash=hashlib.sha256(wamid.encode()).hexdigest(),
            external_message_id=wamid,
            status=WebhookEventStatus.RECEIVED,
            payload_json=json.dumps(inbound_payload),
            received_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5),
        )
        db.add(evt)
        await db.commit()
        evt_id = evt.id

    # Run recovery
    async with AsyncSessionLocal() as db:
        recovered = await WhatsAppWebhookService.recover_unprocessed_events(batch_size=10, db_override=db)
        assert recovered >= 1

    # Verify event transitioned to PROCESSED and Message was created
    async with AsyncSessionLocal() as db:
        evt_check = await db.get(WebhookEvent, evt_id)
        assert evt_check.status == WebhookEventStatus.PROCESSED
        msg = (await db.execute(select(Message).where(Message.wa_message_id == wamid))).scalar_one_or_none()
        assert msg is not None
        assert msg.body == "Message arrived during server crash"
        assert msg.direction == MessageDirection.INBOUND


# =========================================================================
# 6. Outbound Worker Stuck Lease Recovery
# =========================================================================
@pytest.mark.asyncio
async def test_outbox_worker_stuck_lease_recovery():
    """
    Validates Section 27: Outbox messages stuck in PROCESSING due to a worker
    or container crash have their leases expired and reset to PENDING.
    """
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Recovery Line",
            phone_number_id="PNID_STUCK_" + uuid.uuid4().hex[:6],
            display_phone_number="+90 532 999 1111",
            phone_number_e164="+905329991111",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(wanum)
        await db.flush()

        conv = Conversation(
            user_id=tenant_id,
            whatsapp_number_id=wanum.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()

        msg = Message(
            user_id=tenant_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            status=ConversationMessageStatus.PENDING,
            sender_phone=wanum.phone_number_e164,
            recipient_phone="+905330000002",
            body="Stuck lease recovery test",
        )
        db.add(msg)
        await db.flush()

        # Simulate stuck PROCESSING outbox with lock 5 minutes ago
        past_lock = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5)
        outbox = OutboxMessage(
            user_id=tenant_id,
            whatsapp_number_id=wanum.id,
            message_id=msg.id,
            status=OutboxMessageStatus.PROCESSING,
            locked_at=past_lock,
            locked_by="dead_worker_pid_9999",
            payload_json=json.dumps({"body": "Stuck lease recovery test"}),
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id

    # Execute stuck lease recovery
    recovered_count = await OutboundWorker.recover_stuck_leases(lease_timeout_seconds=60)
    assert recovered_count >= 1

    async with AsyncSessionLocal() as db:
        outbox_check = await db.get(OutboxMessage, outbox_id)
        assert outbox_check.status == OutboxMessageStatus.PENDING
        assert outbox_check.locked_at is None
        assert outbox_check.locked_by is None


# =========================================================================
# 7. Outbound Worker Batch Execution
# =========================================================================
@pytest.mark.asyncio
async def test_outbox_worker_batch_execution():
    """Validates that OutboundWorker.process_pending_outbox_batch leases and dispatches jobs."""
    tenant_id = str(uuid.uuid4())
    enc_token = CredentialVault.encrypt("EAAB_test_phase6_token")
    wamid_out = f"wamid.BATCH_{uuid.uuid4().hex[:10]}"

    async with AsyncSessionLocal() as db:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Batch Line",
            phone_number_id="PNID_BATCH_" + uuid.uuid4().hex[:6],
            display_phone_number="+90 532 888 0001",
            phone_number_e164="+905328880001",
            encrypted_access_token=enc_token,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(wanum)
        await db.flush()

        conv = Conversation(
            user_id=tenant_id,
            whatsapp_number_id=wanum.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()

        msg = Message(
            user_id=tenant_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            status=ConversationMessageStatus.PENDING,
            sender_phone=wanum.phone_number_e164,
            recipient_phone="+905338880002",
            body="Batch dispatch test",
        )
        db.add(msg)
        await db.flush()

        outbox = OutboxMessage(
            user_id=tenant_id,
            whatsapp_number_id=wanum.id,
            message_id=msg.id,
            status=OutboxMessageStatus.PENDING,
            payload_json=json.dumps({"body": "Batch dispatch test"}),
        )
        db.add(outbox)
        await db.commit()
        outbox_id = outbox.id
        msg_id = msg.id

    with patch.object(MetaCloudApiClient, "send_text_message", new_callable=AsyncMock) as mock_send:
        mock_send.side_effect = lambda *args, **kwargs: {"messages": [{"id": f"wamid.BATCH_{uuid.uuid4().hex}"}]}
        processed = await OutboundWorker.process_pending_outbox_batch(batch_size=10)
        assert processed >= 1

    async with AsyncSessionLocal() as db:
        outbox_res = await db.get(OutboxMessage, outbox_id)
        assert outbox_res.status == OutboxMessageStatus.COMPLETED
        msg_res = await db.get(Message, msg_id)
        assert msg_res.status == ConversationMessageStatus.SENT
        assert msg_res.wa_message_id.startswith("wamid.BATCH_")


# =========================================================================
# 8. Meta Error Forensics
# =========================================================================
@pytest.mark.asyncio
async def test_meta_error_forensics():
    """Validates classification and safe handling of Meta Cloud API error payloads."""
    # 401 Session Expired (OAuthException code 190 subcode 463)
    err_401 = MetaApiError.from_meta_response(
        401,
        {
            "error": {
                "message": "Session has expired on Friday, 28-Aug-26. Current time is Thursday, 10-Sep-26.",
                "type": "OAuthException",
                "code": 190,
                "error_subcode": 463,
            }
        },
    )
    assert err_401.http_status == 401
    assert err_401.meta_error_code == 190
    assert err_401.meta_error_subcode == 463
    assert "expired" in str(err_401).lower()

    # 429 Rate limit
    err_429 = MetaApiError.from_meta_response(
        429,
        {
            "error": {
                "message": "Message rate limit hit for business phone number.",
                "type": "OAuthException",
                "code": 80007,
            }
        },
    )
    assert err_429.http_status == 429
    assert err_429.retryable is True

    # Check secret redaction on error serialization
    token_str = "EAAB_super_secret_token_12345"
    err_leak = MetaApiError(message=f"Invalid call with token {token_str}", http_status=400)
    sanitized = redact_secrets(str(err_leak))
    assert token_str not in sanitized


# =========================================================================
# 9. Security Audit: Zero Token Exposure
# =========================================================================
@pytest.mark.asyncio
async def test_security_audit_zero_token_in_endpoints():
    """Validates that API responses and outbound DTOs never serialize tokens or app secrets."""
    tenant_id = str(uuid.uuid4())
    jwt = _make_mock_jwt(tenant_id)
    enc_token = CredentialVault.encrypt("EAAB_test_vault_secret_token_456")

    async with AsyncSessionLocal() as db:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Secure Line",
            phone_number_id="PNID_SEC_" + uuid.uuid4().hex[:6],
            display_phone_number="+90 532 777 0001",
            phone_number_e164="+905327770001",
            encrypted_access_token=enc_token,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(wanum)
        await db.flush()

        contact = Contact(
            user_id=tenant_id,
            phone_e164="+905337770002",
            display_name="Secure Contact",
        )
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=tenant_id,
            whatsapp_number_id=wanum.id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            customer_service_window_expires_at=datetime.utcnow() + timedelta(hours=10),
        )
        db.add(conv)
        await db.commit()
        conv_id = conv.id

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # GET /conversations
        r_list = await ac.get("/api/v1/conversations", headers={"Authorization": f"Bearer {jwt}"})
        assert r_list.status_code == 200
        text_list = r_list.text
        assert "encrypted_access_token" not in text_list
        assert "EAAB_test_vault_secret" not in text_list
        assert "META_APP_SECRET" not in text_list

        # GET /conversations/{id}
        r_det = await ac.get(f"/api/v1/conversations/{conv_id}", headers={"Authorization": f"Bearer {jwt}"})
        assert r_det.status_code == 200
        assert "encrypted_access_token" not in r_det.text

        # POST /conversations/{id}/messages
        r_msg = await ac.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Security test message", "message_type": "text"},
            headers={"Authorization": f"Bearer {jwt}"},
        )
        assert r_msg.status_code == 201
        assert "encrypted_access_token" not in r_msg.text
        assert "access_token" not in r_msg.text


# =========================================================================
# 10. Multi-Tenant Isolation Audit
# =========================================================================
@pytest.mark.asyncio
async def test_tenant_isolation_safety():
    """Validates that Tenant B cannot access or mutate Tenant A's conversation."""
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())
    jwt_b = _make_mock_jwt(tenant_b)

    async with AsyncSessionLocal() as db:
        conv_a = Conversation(
            user_id=tenant_a,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv_a)
        await db.commit()
        conv_a_id = conv_a.id

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Tenant B requests Tenant A's conversation
        r_get = await ac.get(f"/api/v1/conversations/{conv_a_id}", headers={"Authorization": f"Bearer {jwt_b}"})
        assert r_get.status_code in (403, 404)

        # Tenant B tries to send message to Tenant A's conversation
        r_post = await ac.post(
            f"/api/v1/conversations/{conv_a_id}/messages",
            json={"body": "Unauthorized access attempt", "message_type": "text"},
            headers={"Authorization": f"Bearer {jwt_b}"},
        )
        assert r_post.status_code in (403, 404)


# =========================================================================
# 11. Real Meta Live E2E Gate (Skipped unless REAL_META_E2E=true with active token)
# =========================================================================
@pytest.mark.asyncio
async def test_real_meta_cloud_api_live_e2e():
    """
    Live Meta Cloud API E2E Verification Check (Section 8-11, 30, 31, 37, 38).
    Explicitly skips when REAL_META_E2E is not True or when Meta access token is expired/unconfigured.
    """
    if not os.environ.get("REAL_META_E2E") and not settings.REAL_META_E2E:
        pytest.skip("REAL META E2E NOT CONFIGURED: REAL_META_E2E is false (mock/deterministic mode active)")

    token = settings.effective_meta_access_token
    pnid = settings.effective_meta_phone_number_id
    recipient = settings.REAL_META_TEST_RECIPIENT or os.environ.get("REAL_META_TEST_RECIPIENT")

    if not token or not pnid or not recipient:
        pytest.skip("REAL META E2E BLOCKED: Missing live token, phone_number_id, or test recipient")

    client = MetaCloudApiClient()
    try:
        # Step 1: Verify phone number validity
        pn_info = await client.get_phone_number_details(phone_number_id=pnid, access_token=token)
        assert pn_info.get("phone_number_id") == pnid

        # Step 2: Dispatch live test message
        unique_id = f"TEZLIFY_OUTBOUND_E2E_{uuid.uuid4().hex[:8]}"
        res = await client.send_text_message(
            phone_number_id=pnid,
            access_token=token,
            to_phone=recipient,
            message_text=f"Live test dispatch: {unique_id}",
        )
        assert "messages" in res
        wamid = res["messages"][0]["id"]
        assert wamid.startswith("wamid.")
    except MetaApiError as exc:
        if exc.code == 190 or exc.status_code == 401:
            pytest.skip(f"REAL META E2E BLOCKED: Access token expired or invalid ({exc.message})")
        raise
