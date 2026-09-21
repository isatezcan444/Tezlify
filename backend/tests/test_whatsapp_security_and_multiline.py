"""Security, authentication, and multi-line isolation regression tests for WhatsApp gateway.

Validates:
1. Fail-closed gateway auth headers (WHATSAPP_GATEWAY_SECRET min 32 chars).
2. Fail-closed /ws/gateway WebSocket endpoint token validation.
3. Multi-line conversation isolation: distinct sessions for the same phone/user
   do not merge or collide.
4. Message client_message_id scoping per conversation.
"""
import uuid as _uuid
import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.main import app
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp_gateway import WhatsAppGatewayError, gateway_auth_headers


TEST_USER = "44444444-4444-4444-4444-444444444444"
TEST_USER_HEX = TEST_USER.replace("-", "")


@pytest_asyncio.fixture(autouse=True)
async def _clean_test_state():
    """Wipe database rows and restore settings between tests."""
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"),
                    {"u": TEST_USER_HEX},
                )
            await db.commit()

    orig_secret = getattr(settings, "WHATSAPP_GATEWAY_SECRET", None)
    await _wipe()
    yield
    await _wipe()
    settings.WHATSAPP_GATEWAY_SECRET = orig_secret


class TestGatewayAuthHeaders:
    """Verifies that gateway_auth_headers enforces fail-closed minimum secret length."""

    def test_gateway_auth_headers_with_valid_secret(self, monkeypatch):
        secret = "a" * 32
        monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", secret)
        headers = gateway_auth_headers()
        assert headers == {"X-Gateway-Secret": secret}

    def test_gateway_auth_headers_with_empty_secret(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", "")
        with pytest.raises(WhatsAppGatewayError):
            gateway_auth_headers()

    def test_gateway_auth_headers_with_short_secret(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", "too_short_secret_under_32")
        with pytest.raises(WhatsAppGatewayError):
            gateway_auth_headers()



class TestGatewayWebSocketSecurity:
    """Verifies fail-closed token validation on /ws/gateway."""

    def test_gateway_ws_rejects_missing_token(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", "super_secret_gateway_key_minimum_32_chars!")
        client = TestClient(app)
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/gateway"):
                pass
        assert exc_info.value.code == 1008

    def test_gateway_ws_rejects_invalid_token(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", "super_secret_gateway_key_minimum_32_chars!")
        client = TestClient(app)
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/gateway?token=invalid_token_attempt_1234567890"):
                pass
        assert exc_info.value.code == 1008

    def test_gateway_ws_rejects_when_server_secret_short(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", "short_secret")
        client = TestClient(app)
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/gateway?token=short_secret"):
                pass
        assert exc_info.value.code == 1011

    def test_gateway_ws_accepts_valid_token(self, monkeypatch):
        valid_secret = "super_secret_gateway_key_minimum_32_chars!"
        monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", valid_secret)
        client = TestClient(app)
        with client.websocket_connect(f"/ws/gateway?token={valid_secret}") as ws:
            ws.send_text('{"type":"ping"}')
            data = ws.receive_json()
            assert data.get("type") == "pong"


@pytest.mark.asyncio
class TestMultiLineConversationIsolation:
    """Verifies that multiple lines (sessions) remain isolated."""

    async def test_two_sessions_same_contact_distinct_conversations(self):
        """Two different lines messaging the same contact produce separate conversations."""
        async with AsyncSessionLocal() as db:
            # Create two sessions
            s1 = WhatsAppSession(
                user_id=TEST_USER_HEX,
                gateway_id="gw-line-1",
                session_name="Line 1",
                phone_number="+905551111111",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
            s2 = WhatsAppSession(
                user_id=TEST_USER_HEX,
                gateway_id="gw-line-2",
                session_name="Line 2",
                phone_number="+905552222222",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
            db.add_all([s1, s2])
            await db.flush()

            # Create contact
            contact = Contact(
                user_id=TEST_USER_HEX,
                phone_e164="+905559999999",
                display_name="Customer Test",
            )
            db.add(contact)
            await db.flush()

            # Create conversation for Line 1
            conv1 = Conversation(
                user_id=TEST_USER_HEX,
                contact_id=contact.id,
                channel="WHATSAPP",
                session_id=s1.id,
                status=ConversationStatus.ACTIVE,
            )
            # Create conversation for Line 2
            conv2 = Conversation(
                user_id=TEST_USER_HEX,
                contact_id=contact.id,
                channel="WHATSAPP",
                session_id=s2.id,
                status=ConversationStatus.ACTIVE,
            )
            db.add_all([conv1, conv2])
            await db.commit()

            # Verify both conversations exist and have different session_ids
            res = await db.execute(
                select(Conversation).where(
                    Conversation.contact_id == contact.id,
                    Conversation.user_id == TEST_USER_HEX,
                )
            )
            convs = res.scalars().all()
            assert len(convs) == 2
            session_ids = {c.session_id for c in convs}
            assert session_ids == {s1.id, s2.id}

    async def test_client_message_id_scoped_to_conversation(self):
        """Same client_message_id across different conversations is allowed."""
        async with AsyncSessionLocal() as db:
            c1 = Conversation(
                user_id=TEST_USER_HEX,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            c2 = Conversation(
                user_id=TEST_USER_HEX,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            db.add_all([c1, c2])
            await db.flush()

            client_mid = "cmsg-unique-test-123"

            m1 = Message(
                user_id=TEST_USER_HEX,
                conversation_id=c1.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Hello from conv 1",
                sender_phone="ME",
                recipient_phone="+905559999999",
                client_message_id=client_mid,
                status=ConversationMessageStatus.SENT,
            )
            m2 = Message(
                user_id=TEST_USER_HEX,
                conversation_id=c2.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Hello from conv 2",
                sender_phone="ME",
                recipient_phone="+905559999999",
                client_message_id=client_mid,
                status=ConversationMessageStatus.SENT,
            )
            db.add_all([m1, m2])
            await db.commit()

            # Both messages should be persisted successfully
            res = await db.execute(
                select(Message).where(Message.client_message_id == client_mid)
            )
            msgs = res.scalars().all()
            assert len(msgs) == 2
            assert {m.conversation_id for m in msgs} == {c1.id, c2.id}

    async def test_client_message_id_unique_within_same_conversation(self):
        """Duplicate client_message_id within the SAME conversation violates uniqueness."""
        async with AsyncSessionLocal() as db:
            c1 = Conversation(
                user_id=TEST_USER_HEX,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            db.add(c1)
            await db.flush()

            client_mid = "cmsg-dup-in-conv-456"

            m1 = Message(
                user_id=TEST_USER_HEX,
                conversation_id=c1.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="First send",
                sender_phone="ME",
                recipient_phone="+905559999999",
                client_message_id=client_mid,
                status=ConversationMessageStatus.SENT,
            )
            db.add(m1)
            await db.commit()

            m2 = Message(
                user_id=TEST_USER_HEX,
                conversation_id=c1.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Second send (duplicate client_mid)",
                sender_phone="ME",
                recipient_phone="+905559999999",
                client_message_id=client_mid,
                status=ConversationMessageStatus.PENDING,
            )
            db.add(m2)
            with pytest.raises(IntegrityError):
                await db.commit()
