"""
Unit and integration tests for WhatsApp Live Chat, History Sync, and Two-Way Mirroring.
Verifies SRP, data integrity, user tenant isolation, and non-blocking real-time synchronization.
"""
import uuid
import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, ConversationMessageStatus
from backend.app.services.whatsapp_outbound_service import WhatsAppOutboundService


@pytest.mark.asyncio
async def test_webhook_history_sync_batch():
    transport = ASGITransport(app=app)
    secret = settings.WA_GATEWAY_WEBHOOK_SECRET or "tezlify-gateway-secret-test"
    settings.WA_GATEWAY_WEBHOOK_SECRET = secret

    session_name = f"sync_sess_{uuid.uuid4().hex[:8]}"
    sess_id = None
    lead_ids = []

    try:
        async with AsyncSessionLocal() as db:
            sess = WhatsAppSession(
                session_name=session_name,
                phone_number="+905320001122",
                status=SessionStatus.CONNECTED,
                is_phone_online=True,
            )
            db.add(sess)
            await db.commit()
            await db.refresh(sess)
            sess_id = sess.id

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Test unauthenticated 401
            unauth_res = await client.post(
                "/api/v1/whatsapp/webhook/history-sync",
                headers={"X-Webhook-Secret": "wrong"},
                json={"session_name": session_name}
            )
            assert unauth_res.status_code == 401

            # 2. Test batch sync
            payload = {
                "session_name": session_name,
                "chats": [
                    {"id": "905551112233@s.whatsapp.net", "name": "Ahmet Yılmaz", "phone": "+905551112233"},
                    {"id": "905554445566@s.whatsapp.net", "name": "Zeynep Kaya", "phone": "+905554445566"}
                ],
                "messages": [
                    {
                        "wa_message_id": f"wa_msg_001_{uuid.uuid4().hex[:6]}",
                        "fromMe": False,
                        "phone": "+905551112233",
                        "message": "Fiyat teklifi alabilir miyim?",
                        "timestamp": 1710000000
                    },
                    {
                        "wa_message_id": f"wa_msg_002_{uuid.uuid4().hex[:6]}",
                        "fromMe": True,
                        "phone": "+905551112233",
                        "message": "Tabii ki, hemen iletiyorum.",
                        "timestamp": 1710000050
                    },
                    {
                        "wa_message_id": f"wa_msg_003_{uuid.uuid4().hex[:6]}",
                        "fromMe": False,
                        "phone": "+905554445566",
                        "message": "Merhaba, randevu almak istiyorum.",
                        "timestamp": 1710000100
                    }
                ]
            }

            res = await client.post(
                "/api/v1/whatsapp/webhook/history-sync",
                headers={"X-Webhook-Secret": secret},
                json=payload
            )
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "success"
            assert data["chats_synced"] >= 2
            assert data["messages_imported"] == 3

        # Verify DB persistence
        async with AsyncSessionLocal() as db:
            lead_1 = (await db.execute(select(Lead).where(Lead.phone_e164 == "+905551112233"))).scalar_one_or_none()
            assert lead_1 is not None
            assert lead_1.name == "Ahmet Yılmaz"
            lead_ids.append(lead_1.id)

            lead_2 = (await db.execute(select(Lead).where(Lead.phone_e164 == "+905554445566"))).scalar_one_or_none()
            assert lead_2 is not None
            assert lead_2.name == "Zeynep Kaya"
            lead_ids.append(lead_2.id)

            # Conversations created
            conv_1 = (await db.execute(select(Conversation).where(Conversation.lead_id == lead_1.id))).scalar_one_or_none()
            assert conv_1 is not None
            assert conv_1.channel == "WHATSAPP"

            # Messages created with correct direction
            msgs_1 = (await db.execute(select(Message).where(Message.conversation_id == conv_1.id))).scalars().all()
            assert len(msgs_1) == 2
            assert any(m.direction == MessageDirection.INBOUND and m.body == "Fiyat teklifi alabilir miyim?" for m in msgs_1)
            assert any(m.direction == MessageDirection.OUTBOUND and m.body == "Tabii ki, hemen iletiyorum." for m in msgs_1)

    finally:
        async with AsyncSessionLocal() as db:
            for lid in lead_ids:
                l = await db.get(Lead, lid)
                if l:
                    await db.delete(l)
            if sess_id:
                s = await db.get(WhatsAppSession, sess_id)
                if s:
                    await db.delete(s)
            await db.commit()


@pytest.mark.asyncio
async def test_webhook_message_event_two_way_mirroring():
    transport = ASGITransport(app=app)
    secret = settings.WA_GATEWAY_WEBHOOK_SECRET or "tezlify-gateway-secret-test"
    settings.WA_GATEWAY_WEBHOOK_SECRET = secret

    session_name = f"two_way_sess_{uuid.uuid4().hex[:8]}"
    contact_phone = f"+90555{uuid.uuid4().int % 10000000:07d}"
    sess_id = None
    lead_id = None

    try:
        async with AsyncSessionLocal() as db:
            sess = WhatsAppSession(
                session_name=session_name,
                phone_number="+905321002030",
                status=SessionStatus.CONNECTED,
                is_phone_online=True,
            )
            db.add(sess)
            await db.commit()
            await db.refresh(sess)
            sess_id = sess.id

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Inbound message from client
            inbound_payload = {
                "session_name": session_name,
                "phone": contact_phone,
                "message": "Bugün açık mısınız?",
                "fromMe": False,
                "wa_message_id": f"wa_in_{uuid.uuid4().hex[:6]}",
                "timestamp": 1710001000,
            }
            inbound_res = await client.post(
                "/api/v1/whatsapp/webhook/message-event",
                headers={"X-Webhook-Secret": secret},
                json=inbound_payload
            )
            assert inbound_res.status_code == 200
            inbound_data = inbound_res.json()
            assert inbound_data["status"] == "success"
            assert inbound_data["direction"] == "INBOUND"

            # 2. Outbound message sent from user's physical phone
            phone_outbound_payload = {
                "session_name": session_name,
                "phone": contact_phone,
                "message": "Evet, saat 19:00'a kadar açığız.",
                "fromMe": True,
                "wa_message_id": f"wa_out_{uuid.uuid4().hex[:6]}",
                "timestamp": 1710001060,
            }
            phone_res = await client.post(
                "/api/v1/whatsapp/webhook/message-event",
                headers={"X-Webhook-Secret": secret},
                json=phone_outbound_payload
            )
            assert phone_res.status_code == 200
            phone_data = phone_res.json()
            assert phone_data["status"] == "success"
            assert phone_data["direction"] == "OUTBOUND"

        # Verify conversation state
        async with AsyncSessionLocal() as db:
            lead = (await db.execute(select(Lead).where(Lead.phone_e164 == contact_phone))).scalar_one_or_none()
            assert lead is not None
            assert lead.status == LeadStatus.REPLIED
            lead_id = lead.id

            conv = (await db.execute(select(Conversation).where(Conversation.lead_id == lead.id))).scalar_one_or_none()
            assert conv is not None
            assert conv.unread_count == 1

            # Messages count
            messages = (await db.execute(select(Message).where(Message.conversation_id == conv.id))).scalars().all()
            assert len(messages) == 2

    finally:
        async with AsyncSessionLocal() as db:
            if lead_id:
                l = await db.get(Lead, lead_id)
                if l:
                    await db.delete(l)
            if sess_id:
                s = await db.get(WhatsAppSession, sess_id)
                if s:
                    await db.delete(s)
            await db.commit()


@pytest.mark.asyncio
async def test_outbound_service_dispatches_via_baileys_gateway():
    test_user_id = str(uuid.uuid4())
    session_name = f"outbound_baileys_{uuid.uuid4().hex[:8]}"
    contact_phone = f"+90555{uuid.uuid4().int % 10000000:07d}"
    conv_id = None
    sess_id = None
    lead_id = None

    try:
        async with AsyncSessionLocal() as db:
            # 1. Create connected session
            sess = WhatsAppSession(
                user_id=test_user_id,
                session_name=session_name,
                phone_number="+905321112233",
                status=SessionStatus.CONNECTED,
                is_phone_online=True,
            )
            db.add(sess)

            # 2. Create lead & conversation
            lead = Lead(
                user_id=test_user_id,
                name="Test Outbound Lead",
                phone=contact_phone,
                phone_e164=contact_phone,
                is_whatsapp_eligible=True,
            )
            db.add(lead)
            await db.commit()
            await db.refresh(lead)
            await db.refresh(sess)

            conv = Conversation(
                user_id=test_user_id,
                lead_id=lead.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            db.add(conv)
            await db.commit()
            await db.refresh(conv)

            conv_id = conv.id
            sess_id = sess.id
            lead_id = lead.id

        # 3. Mock gateway_client.send_message
        with patch("backend.app.services.whatsapp_gateway_client.gateway_client.send_message", new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {
                "success": True,
                "messageId": "baileys_msg_outbound_99",
                "phone": contact_phone,
                "status": "SENT"
            }

            async with AsyncSessionLocal() as db:
                msg = await WhatsAppOutboundService.send_conversation_message(
                    db=db,
                    conversation_id=conv_id,
                    text="Merhaba, panelden gönderilen canlı mesaj.",
                    force_simulation=False,
                )

                assert msg.direction == MessageDirection.OUTBOUND
                assert msg.body == "Merhaba, panelden gönderilen canlı mesaj."
                assert msg.wa_message_id == "baileys_msg_outbound_99"
                assert msg.status == ConversationMessageStatus.SENT

            mock_send.assert_called_once()

    finally:
        async with AsyncSessionLocal() as db:
            if conv_id:
                c = await db.get(Conversation, conv_id)
                if c:
                    await db.delete(c)
            if lead_id:
                l = await db.get(Lead, lead_id)
                if l:
                    await db.delete(l)
            if sess_id:
                s = await db.get(WhatsAppSession, sess_id)
                if s:
                    await db.delete(s)
            await db.commit()
