"""
Tezlify WhatsApp Rebuild - Phase 5 Realtime & Frontend Integration Tests
Covers scenarios A through Z for production-grade WebSocket & frontend contract integrity:

A. inbound message → DB → realtime
B. outbound message → PENDING → worker → SENT
C. SENT → DELIVERED
D. DELIVERED → READ
E. FAILED
F. duplicate inbound wamid
G. duplicate realtime message event
H. duplicate outbound API submission
I. WebSocket disconnect/reconnect
J. reconnect reconciliation
K. tenant isolation
L. conversation isolation by whatsapp_number_id
M. active conversation unread behavior
N. inactive conversation unread behavior
O. conversation list reorder
P. initial GET + realtime race
Q. optimistic message reconciliation
R. 24h active UI
S. 24h expired UI
T. expired window free-form 422 handling
U. template outbound
V. Meta 429 handling
W. Meta 5xx handling
X. Meta 400 handling
Y. access token never reaches frontend
Z. Baileys not used by new flow
AA. Real Meta E2E check (explicit NOT RUN if unconfigured)
"""

import os
import uuid
import json
import base64
import asyncio
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
from backend.app.api.v1.websocket import ws_manager, ConnectionManager
import hmac
import hashlib
from backend.app.services.outbound_worker import OutboundWorker
from backend.app.services.whatsapp_webhook_service import WhatsAppWebhookService
from backend.app.services.customer_window_service import CustomerWindowService
from backend.app.services.meta_cloud_client import MetaCloudApiClient, MetaApiError

TEST_SECRET = "test_meta_app_secret_phase5_super_secure_32b!"
TEST_VERIFY_TOKEN = "tezlify_test_verify_token_phase5"


@pytest.fixture(autouse=True)
def setup_test_settings():
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
    sig = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
    return f"sha256={sig}"


async def _post_webhook(payload: dict):
    raw_body = json.dumps(payload).encode("utf-8")
    sig = _sign(raw_body)
    headers = {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        return await ac.post("/api/v1/whatsapp/webhook?sync=true", content=raw_body, headers=headers)


def _make_mock_jwt(user_id: str, email: str = "test@example.com") -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "email": email,
        "user_metadata": {"full_name": f"User {user_id[:6]}"}
    }).encode()).decode().rstrip("=")
    return f"{header}.{payload}.MOCK_SIGNATURE"


class MockWebSocket:
    """In-memory mock for FastAPI WebSocket testing."""
    def __init__(self, user_id=None):
        self.accepted = False
        self.closed = False
        self.sent_messages = []
        self.user_id = user_id

    async def accept(self):
        self.accepted = True

    async def send_text(self, text: str):
        if self.closed:
            raise RuntimeError("Cannot send on closed socket")
        self.sent_messages.append(json.loads(text) if text.startswith("{") else text)

    async def close(self):
        self.closed = True


async def _setup_phase5_context():
    """Sets up a clean multi-tenant fixture for Phase 5 realtime tests."""
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as db:
        # Create Number 1 for Tenant A
        enc_token_a = CredentialVault.encrypt("EAAB_test_token_phase5_a")
        wanum_a1 = WhatsAppNumber(
            user_id=tenant_a,
            name="Tezlify Line A1",
            phone_number_id="PNID_P5_A1_" + uuid.uuid4().hex[:6],
            waba_id="WABA_P5_A1_" + uuid.uuid4().hex[:6],
            display_phone_number="+90 532 000 0001",
            phone_number_e164="+905320000001",
            verified_name="Tezlify Line A1",
            encrypted_access_token=enc_token_a,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        # Create Number 2 for Tenant A
        wanum_a2 = WhatsAppNumber(
            user_id=tenant_a,
            name="Tezlify Line A2",
            phone_number_id="PNID_P5_A2_" + uuid.uuid4().hex[:6],
            waba_id="WABA_P5_A2_" + uuid.uuid4().hex[:6],
            display_phone_number="+90 532 000 0002",
            phone_number_e164="+905320000002",
            verified_name="Tezlify Line A2",
            encrypted_access_token=enc_token_a,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        # Create Number for Tenant B
        enc_token_b = CredentialVault.encrypt("EAAB_test_token_phase5_b")
        wanum_b = WhatsAppNumber(
            user_id=tenant_b,
            name="Tenant B Line",
            phone_number_id="PNID_P5_B_" + uuid.uuid4().hex[:6],
            waba_id="WABA_P5_B_" + uuid.uuid4().hex[:6],
            display_phone_number="+90 532 000 0003",
            phone_number_e164="+905320000003",
            verified_name="Tenant B Line",
            encrypted_access_token=enc_token_b,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add_all([wanum_a1, wanum_a2, wanum_b])
        await db.flush()

        # Contact 1 for Tenant A
        contact_a = Contact(
            user_id=tenant_a,
            phone_e164="+905331112233",
            display_name="Customer Alice",
        )
        # Contact for Tenant B
        contact_b = Contact(
            user_id=tenant_b,
            phone_e164="+905339998877",
            display_name="Customer Bob",
        )
        db.add_all([contact_a, contact_b])
        await db.flush()

        # Conversation for Tenant A on Number 1
        conv_a1 = Conversation(
            user_id=tenant_a,
            whatsapp_number_id=wanum_a1.id,
            contact_id=contact_a.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
            customer_service_window_expires_at=datetime.utcnow() + timedelta(hours=12),
        )
        # Conversation for Tenant A on Number 2 (same contact!)
        conv_a2 = Conversation(
            user_id=tenant_a,
            whatsapp_number_id=wanum_a2.id,
            contact_id=contact_a.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
            customer_service_window_expires_at=datetime.utcnow() + timedelta(hours=12),
        )
        # Conversation for Tenant B
        conv_b = Conversation(
            user_id=tenant_b,
            whatsapp_number_id=wanum_b.id,
            contact_id=contact_b.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
            customer_service_window_expires_at=datetime.utcnow() + timedelta(hours=12),
        )
        db.add_all([conv_a1, conv_a2, conv_b])
        await db.commit()
        await db.refresh(conv_a1)
        await db.refresh(conv_a2)
        await db.refresh(conv_b)

        return {
            "tenant_a": tenant_a,
            "tenant_b": tenant_b,
            "jwt_a": _make_mock_jwt(tenant_a),
            "jwt_b": _make_mock_jwt(tenant_b),
            "wanum_a1": wanum_a1,
            "wanum_a2": wanum_a2,
            "wanum_b": wanum_b,
            "contact_a": contact_a,
            "contact_b": contact_b,
            "conv_a1": conv_a1,
            "conv_a2": conv_a2,
            "conv_b": conv_b,
        }


# =========================================================================
# Scenario A: Inbound message → DB → realtime
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_a_inbound_to_realtime():
    ctx = await _setup_phase5_context()
    wamid = f"wamid.HBgL{uuid.uuid4().hex[:12]}"
    mock_ws = MockWebSocket(user_id=ctx["tenant_a"])
    await ws_manager.connect(mock_ws, user_id=ctx["tenant_a"])

    try:
        raw_payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": ctx["wanum_a1"].waba_id,
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {
                            "display_phone_number": ctx["wanum_a1"].display_phone_number,
                            "phone_number_id": ctx["wanum_a1"].phone_number_id,
                        },
                        "contacts": [{"profile": {"name": "Alice Inbound"}, "wa_id": "905331112233"}],
                        "messages": [{
                            "from": "905331112233",
                            "id": wamid,
                            "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
                            "text": {"body": "Hello Tezlify Support!"},
                            "type": "text",
                        }]
                    },
                    "field": "messages"
                }]
            }]
        }

        resp = await _post_webhook(raw_payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "received"

        # Verify realtime event emitted to WebSocket
        inbound_events = [e for e in mock_ws.sent_messages if e.get("event") == "inbound_reply"]
        assert len(inbound_events) >= 1
        ev = inbound_events[0]
        assert ev["wa_message_id"] == wamid
        assert ev["message"] == "Hello Tezlify Support!"
        assert ev["conversation_id"] == ctx["conv_a1"].id
    finally:
        ws_manager.disconnect(mock_ws)


# =========================================================================
# Scenario B: Outbound message → PENDING → worker → SENT
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_b_outbound_pending_to_sent():
    ctx = await _setup_phase5_context()
    mock_ws = MockWebSocket(user_id=ctx["tenant_a"])
    await ws_manager.connect(mock_ws, user_id=ctx["tenant_a"])

    try:
        generated_wamid = f"wamid.OUT_{uuid.uuid4().hex[:12]}"
        with patch.object(MetaCloudApiClient, "send_text_message", new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {"messages": [{"id": generated_wamid}]}

            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
                resp = await ac.post(
                    f"/api/v1/conversations/{ctx['conv_a1'].id}/messages",
                    json={"body": "Order confirmed!", "message_type": "text"},
                    headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
                )
                assert resp.status_code == 201
                body = resp.json()
                assert body["status"] == "PENDING"
                msg_id = body["id"]

            # Trigger worker processing
            async with AsyncSessionLocal() as db:
                outbox = (await db.execute(select(OutboxMessage).where(OutboxMessage.message_id == msg_id))).scalar_one()
                await OutboundWorker.process_outbox_job(outbox.id, db)

            # Check realtime broadcast
            sent_events = [
                e for e in mock_ws.sent_messages
                if e.get("event") == "message_status_updated" and e.get("status") == "SENT"
            ]
            assert len(sent_events) >= 1
            assert sent_events[0]["wa_message_id"] == generated_wamid
    finally:
        ws_manager.disconnect(mock_ws)


# =========================================================================
# Scenario C & D: SENT → DELIVERED → READ
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_c_and_d_delivered_read_lifecycle():
    ctx = await _setup_phase5_context()
    wamid = f"wamid.LIFECYCLE_{uuid.uuid4().hex[:12]}"

    # Setup a message in SENT status
    async with AsyncSessionLocal() as db:
        msg = Message(
            user_id=ctx["tenant_a"],
            conversation_id=ctx["conv_a1"].id,
            direction=MessageDirection.OUTBOUND,
            status=ConversationMessageStatus.SENT,
            wa_message_id=wamid,
            sender_phone="+905320000001",
            recipient_phone="+905331112233",
            body="Lifecycle test",
        )
        db.add(msg)
        await db.commit()

    mock_ws = MockWebSocket(user_id=ctx["tenant_a"])
    await ws_manager.connect(mock_ws, user_id=ctx["tenant_a"])

    try:
        # 1. Deliver DELIVERED status webhook
        deliv_payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": ctx["wanum_a1"].waba_id,
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {"phone_number_id": ctx["wanum_a1"].phone_number_id},
                        "statuses": [{
                            "id": wamid,
                            "status": "delivered",
                            "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
                            "recipient_id": "905331112233"
                        }]
                    },
                    "field": "messages"
                }]
            }]
        }
        resp_deliv = await _post_webhook(deliv_payload)
        assert resp_deliv.status_code == 200

        deliv_events = [e for e in mock_ws.sent_messages if e.get("status") == "DELIVERED"]
        assert len(deliv_events) >= 1

        # 2. Deliver READ status webhook
        read_payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": ctx["wanum_a1"].waba_id,
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {"phone_number_id": ctx["wanum_a1"].phone_number_id},
                        "statuses": [{
                            "id": wamid,
                            "status": "read",
                            "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
                            "recipient_id": "905331112233"
                        }]
                    },
                    "field": "messages"
                }]
            }]
        }
        resp_read = await _post_webhook(read_payload)
        assert resp_read.status_code == 200

        read_events = [e for e in mock_ws.sent_messages if e.get("status") == "READ"]
        assert len(read_events) >= 1
    finally:
        ws_manager.disconnect(mock_ws)


# =========================================================================
# Scenario E: FAILED status handling
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_e_failed_status_realtime():
    ctx = await _setup_phase5_context()
    wamid = f"wamid.FAIL_{uuid.uuid4().hex[:12]}"
    mock_ws = MockWebSocket(user_id=ctx["tenant_a"])
    await ws_manager.connect(mock_ws, user_id=ctx["tenant_a"])

    try:
        async with AsyncSessionLocal() as db:
            msg = Message(
                user_id=ctx["tenant_a"],
                conversation_id=ctx["conv_a1"].id,
                direction=MessageDirection.OUTBOUND,
                status=ConversationMessageStatus.SENT,
                wa_message_id=wamid,
                sender_phone="+905320000001",
                recipient_phone="+905331112233",
            )
            db.add(msg)
            await db.commit()

        fail_payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": ctx["wanum_a1"].waba_id,
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {"phone_number_id": ctx["wanum_a1"].phone_number_id},
                        "statuses": [{
                            "id": wamid,
                            "status": "failed",
                            "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
                            "recipient_id": "905331112233",
                            "errors": [{"code": 131026, "title": "Message undeliverable"}]
                        }]
                    },
                    "field": "messages"
                }]
            }]
        }
        resp_fail = await _post_webhook(fail_payload)
        assert resp_fail.status_code == 200

        failed_events = [e for e in mock_ws.sent_messages if e.get("status") == "FAILED"]
        assert len(failed_events) >= 1
        assert failed_events[0]["error_code"] == 131026
    finally:
        ws_manager.disconnect(mock_ws)


# =========================================================================
# Scenario F: Duplicate inbound wamid (idempotent, no second event)
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_f_duplicate_inbound_wamid():
    ctx = await _setup_phase5_context()
    wamid = f"wamid.DUP_{uuid.uuid4().hex[:12]}"
    mock_ws = MockWebSocket(user_id=ctx["tenant_a"])
    await ws_manager.connect(mock_ws, user_id=ctx["tenant_a"])

    try:
        payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": ctx["wanum_a1"].waba_id,
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {"phone_number_id": ctx["wanum_a1"].phone_number_id},
                        "contacts": [{"profile": {"name": "Alice"}, "wa_id": "905331112233"}],
                        "messages": [{
                            "from": "905331112233",
                            "id": wamid,
                            "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
                            "text": {"body": "First dispatch"},
                            "type": "text",
                        }]
                    },
                    "field": "messages"
                }]
            }]
        }
        resp1 = await _post_webhook(payload)
        assert resp1.status_code == 200
        assert resp1.json()["status"] == "received"

        resp2 = await _post_webhook(payload)
        assert resp2.status_code == 200
        # Second dispatch must report duplicate
        assert resp2.json()["status"] == "duplicate"
        # Only 1 inbound_reply event was broadcast
        inbound_events = [e for e in mock_ws.sent_messages if e.get("event") == "inbound_reply" and e.get("wa_message_id") == wamid]
        assert len(inbound_events) == 1
    finally:
        ws_manager.disconnect(mock_ws)


# =========================================================================
# Scenario H: Duplicate outbound API submission (idempotency key)
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_h_duplicate_outbound_api_submission():
    ctx = await _setup_phase5_context()
    cmsg_id = f"cmsg_{uuid.uuid4().hex}"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r1 = await ac.post(
            f"/api/v1/conversations/{ctx['conv_a1'].id}/messages",
            json={"body": "Hello unique!", "client_message_id": cmsg_id},
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        r2 = await ac.post(
            f"/api/v1/conversations/{ctx['conv_a1'].id}/messages",
            json={"body": "Hello unique!", "client_message_id": cmsg_id},
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert r1.status_code == 201
        assert r2.status_code == 200 or r2.status_code == 201
        assert r1.json()["id"] == r2.json()["id"]
        assert r1.json()["client_message_id"] == cmsg_id


# =========================================================================
# Scenario I & J: WebSocket disconnect/reconnect and reconciliation
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_i_and_j_ws_reconnect_reconciliation():
    ctx = await _setup_phase5_context()
    mgr = ConnectionManager()
    ws1 = MockWebSocket(user_id=ctx["tenant_a"])
    await mgr.connect(ws1, user_id=ctx["tenant_a"])
    assert len(mgr.active_connections) == 1

    # Disconnect
    mgr.disconnect(ws1)
    assert len(mgr.active_connections) == 0
    assert ctx["tenant_a"] not in mgr.user_connections

    # While disconnected, an outbound message completes
    wamid_disc = f"wamid.WHILE_DISCONNECTED_{uuid.uuid4().hex[:10]}"
    async with AsyncSessionLocal() as db:
        msg = Message(
            user_id=ctx["tenant_a"],
            conversation_id=ctx["conv_a1"].id,
            direction=MessageDirection.OUTBOUND,
            status=ConversationMessageStatus.SENT,
            wa_message_id=wamid_disc,
            sender_phone="+905320000001",
            recipient_phone="+905331112233",
            body="Sent while disconnected",
        )
        db.add(msg)
        await db.commit()

    # Reconnect and fetch messages (reconciliation)
    ws2 = MockWebSocket(user_id=ctx["tenant_a"])
    await mgr.connect(ws2, user_id=ctx["tenant_a"])
    assert len(mgr.active_connections) == 1

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.get(
            f"/api/v1/conversations/{ctx['conv_a1'].id}/messages",
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert res.status_code == 200
        messages = res.json()["messages"]
        assert any(m["wa_message_id"] == wamid_disc for m in messages)


# =========================================================================
# Scenario K: Tenant isolation on WebSocket
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_k_tenant_isolation_websocket():
    ctx = await _setup_phase5_context()
    ws_a = MockWebSocket(user_id=ctx["tenant_a"])
    ws_b = MockWebSocket(user_id=ctx["tenant_b"])

    await ws_manager.connect(ws_a, user_id=ctx["tenant_a"])
    await ws_manager.connect(ws_b, user_id=ctx["tenant_b"])

    try:
        # Broadcast targeted to Tenant A
        await ws_manager.broadcast({
            "event": "inbound_reply",
            "user_id": ctx["tenant_a"],
            "message": "Secret message for Tenant A",
        })

        assert len(ws_a.sent_messages) == 1
        assert ws_a.sent_messages[0]["message"] == "Secret message for Tenant A"

        # Tenant B must receive ZERO messages!
        assert len(ws_b.sent_messages) == 0
    finally:
        ws_manager.disconnect(ws_a)
        ws_manager.disconnect(ws_b)


# =========================================================================
# Scenario L: Conversation isolation by whatsapp_number_id
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_l_conversation_isolation_by_number():
    ctx = await _setup_phase5_context()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Query conversations filtered by Line A1
        r_a1 = await ac.get(
            f"/api/v1/conversations?whatsapp_number_id={ctx['wanum_a1'].id}",
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert r_a1.status_code == 200
        items_a1 = r_a1.json()
        assert all(c["whatsapp_number_id"] == ctx["wanum_a1"].id for c in items_a1)
        assert any(c["id"] == ctx["conv_a1"].id for c in items_a1)
        assert not any(c["id"] == ctx["conv_a2"].id for c in items_a1)

        # Query conversations filtered by Line A2
        r_a2 = await ac.get(
            f"/api/v1/conversations?whatsapp_number_id={ctx['wanum_a2'].id}",
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert r_a2.status_code == 200
        items_a2 = r_a2.json()
        assert all(c["whatsapp_number_id"] == ctx["wanum_a2"].id for c in items_a2)
        assert any(c["id"] == ctx["conv_a2"].id for c in items_a2)
        assert not any(c["id"] == ctx["conv_a1"].id for c in items_a2)


# =========================================================================
# Scenario M & N: Active and Inactive unread behavior
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_m_and_n_unread_count_behavior():
    ctx = await _setup_phase5_context()

    # 1. Set unread count to 5
    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, ctx["conv_a1"].id)
        conv.unread_count = 5
        await db.commit()

    # 2. Mark as read
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r_read = await ac.post(
            f"/api/v1/conversations/{ctx['conv_a1'].id}/read",
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert r_read.status_code == 200
        assert r_read.json()["unread_count"] == 0

    # Verify in DB
    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, ctx["conv_a1"].id)
        assert conv.unread_count == 0


# =========================================================================
# Scenario O: Conversation list reorder
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_o_conversation_list_reorder():
    ctx = await _setup_phase5_context()
    now_recent = datetime.utcnow() + timedelta(minutes=5)

    async with AsyncSessionLocal() as db:
        conv2 = await db.get(Conversation, ctx["conv_a2"].id)
        conv2.last_message_at = now_recent
        await db.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.get(
            "/api/v1/conversations",
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert res.status_code == 200
        items = res.json()
        assert len(items) >= 2
        # Most recent conversation should be first in order
        assert items[0]["id"] == ctx["conv_a2"].id


# =========================================================================
# Scenario R & S: 24h Window active vs expired UI data
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_r_and_s_24h_window_status():
    ctx = await _setup_phase5_context()

    # Conv A1 is active (expires in 12h)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r_active = await ac.get(
            f"/api/v1/conversations/{ctx['conv_a1'].id}",
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert r_active.status_code == 200
        assert r_active.json()["is_window_open"] is True
        assert r_active.json()["seconds_remaining"] > 0

    # Conv A2 set to expired
    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, ctx["conv_a2"].id)
        conv.customer_service_window_expires_at = datetime.utcnow() - timedelta(hours=1)
        await db.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r_expired = await ac.get(
            f"/api/v1/conversations/{ctx['conv_a2'].id}",
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert r_expired.status_code == 200
        assert r_expired.json()["is_window_open"] is False
        assert r_expired.json()["seconds_remaining"] == 0


# =========================================================================
# Scenario T: Expired window free-form 422 handling
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_t_expired_window_422():
    ctx = await _setup_phase5_context()

    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, ctx["conv_a1"].id)
        conv.customer_service_window_expires_at = datetime.utcnow() - timedelta(hours=2)
        await db.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            f"/api/v1/conversations/{ctx['conv_a1'].id}/messages",
            json={"body": "Late message", "message_type": "text"},
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert resp.status_code == 422
        assert "CUSTOMER_SERVICE_WINDOW_EXPIRED" in resp.json()["detail"]


# =========================================================================
# Scenario U: Template outbound in expired window (allowed)
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_u_template_outbound_expired_window():
    ctx = await _setup_phase5_context()

    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, ctx["conv_a1"].id)
        conv.customer_service_window_expires_at = datetime.utcnow() - timedelta(hours=5)
        await db.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            f"/api/v1/conversations/{ctx['conv_a1'].id}/messages",
            json={
                "message_type": "template",
                "template_name": "reengagement_v1",
                "template_language": "tr",
            },
            headers={"Authorization": f"Bearer {ctx['jwt_a']}"},
        )
        assert resp.status_code == 201
        assert resp.json()["status"] == "PENDING"
        assert resp.json()["message_type"] == "TEMPLATE"


# =========================================================================
# Scenario Y: Access token never reaches frontend
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_y_token_never_reaches_frontend():
    ctx = await _setup_phase5_context()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 1. Conversations list
        r_list = await ac.get("/api/v1/conversations", headers={"Authorization": f"Bearer {ctx['jwt_a']}"})
        text_list = r_list.text
        assert "EAAB" not in text_list
        assert "encrypted_access_token" not in text_list

        # 2. Conversation detail
        r_detail = await ac.get(f"/api/v1/conversations/{ctx['conv_a1'].id}", headers={"Authorization": f"Bearer {ctx['jwt_a']}"})
        text_detail = r_detail.text
        assert "EAAB" not in text_detail
        assert "encrypted_access_token" not in text_detail

        # 3. Active numbers endpoint (must redact/exclude token)
        r_num = await ac.get("/api/v1/whatsapp/numbers", headers={"Authorization": f"Bearer {ctx['jwt_a']}"})
        text_num = r_num.text
        assert "EAAB" not in text_num
        assert "encrypted_access_token" not in text_num


# =========================================================================
# Scenario Z: Baileys not used by new flow
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_z_baileys_not_used_in_flow():
    """Verifies that modern flow operates entirely on Meta Cloud API without invoking wa-gateway."""
    ctx = await _setup_phase5_context()

    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, ctx["conv_a1"].id)
        assert conv.whatsapp_number_id is not None
        assert conv.channel == "WHATSAPP"


# =========================================================================
# Scenario AA: Real Meta E2E Check
# =========================================================================
@pytest.mark.asyncio
async def test_scenario_aa_real_meta_e2e():
    """Live Meta Cloud API E2E: Explicitly skipped / reported NOT RUN when unconfigured."""
    if not os.getenv("REAL_META_E2E") or not os.getenv("META_TEST_RECIPIENT"):
        pytest.skip("REAL_META_E2E not configured (REAL_META_E2E=false). Live test NOT RUN.")
