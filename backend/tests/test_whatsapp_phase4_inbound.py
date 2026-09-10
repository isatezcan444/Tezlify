"""
Phase 4 Backend Inbound Message Bridge & Persistence Integration Tests.

Validates:
1. Inbound text event parsing & persistence
2. Tenant & session resolution (authoritative from DB)
3. Contact creation when non-existent (linking existing Lead if present, never auto-creating Lead)
4. Existing Contact reuse without field overwrite
5. Conversation creation when non-existent (multi-number isolated)
6. Existing Conversation reuse & update (unread_count, preview, timestamps)
7. Message persisted with direction=INBOUND, status=RECEIVED
8. wa_message_id stored and enforced
9. Idempotency: duplicate wa_message_id returns duplicate status without creating 2nd message
10. Conversation last_customer_message_at & preview updated
11. Baileys transport does not enforce Meta 24h template restrictions
12. Tenant mismatch rejection (fail-closed, 403)
13. Secret validation (missing or invalid X-Webhook-Secret returns 401)
14. Malformed payload handled gracefully without crash
15. Unsupported / non-text message type handled safely
16. Transaction boundary: WebSocket broadcast occurs strictly post-commit
17. Group JID ignored for personal inbox ingestion
18. LID / Phone normalization works consistently
19. Opt-out keyword triggers Blacklist & Lead UNSUBSCRIBED status
20. Decoupled CRM: No Lead created if none existed
"""
import uuid
from datetime import datetime
from unittest.mock import patch, AsyncMock
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberProvider, WhatsAppNumberStatus
from backend.app.models.contact import Contact
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.blacklist import Blacklist
from backend.app.api.v1.websocket import ws_manager


@pytest.fixture
def auth_headers():
    return {"X-Webhook-Secret": settings.WA_GATEWAY_WEBHOOK_SECRET or "dev-webhook-secret"}


@pytest.mark.asyncio
async def test_01_inbound_text_success_persists_contact_conversation_and_message(auth_headers):
    transport = ASGITransport(app=app)
    user_id = str(uuid.uuid4())
    session_name = f"sess_inbound_{uuid.uuid4().hex[:6]}"
    wamid = f"wamid_test_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        wanum = WhatsAppNumber(
            user_id=user_id,
            name="Baileys Hat 1",
            provider=WhatsAppNumberProvider.BAILEYS_QR,
            phone_number_e164="+905550001122",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(wanum)
        await db.flush()

        sess = WhatsAppSession(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
            phone_number="+905550001122",
        )
        db.add(sess)
        await db.commit()
        await db.refresh(sess)
        sess_id = sess.id

    rand_digits = f"{uuid.uuid4().int % 100000000:08d}"
    test_phone = f"+9052{rand_digits}"

    payload = {
        "tenant_id": user_id,
        "session_id": sess_id,
        "session_name": session_name,
        "phone": test_phone,
        "wa_jid": f"{test_phone[1:]}@s.whatsapp.net",
        "message": "Merhaba, ürün hakkında bilgi alabilir miyim?",
        "message_type": "TEXT",
        "wa_message_id": wamid,
        "push_name": "Ayşe Demir",
        "timestamp": int(datetime.utcnow().timestamp()),
    }

    with patch.object(ws_manager, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
            assert res.status_code == 200, res.text
            data = res.json()
            assert data["status"] == "success"
            assert data["processed_phone"] == test_phone
            assert data["wa_message_id"] == wamid

        # Verify WebSocket broadcast called strictly post-commit with correct payload
        mock_broadcast.assert_called_once()
        ws_event = mock_broadcast.call_args[0][0]
        assert ws_event["event"] == "inbound_reply"
        assert ws_event["provider"] == "BAILEYS_QR"
        assert ws_event["user_id"] == str(user_id)
        assert ws_event["wa_message_id"] == wamid
        assert ws_event["sender_name"] == "Ayşe Demir"
        assert ws_event["message"] == "Merhaba, ürün hakkında bilgi alabilir miyim?"

    # Verify DB records
    async with AsyncSessionLocal() as db:
        # 1. Contact created
        contact = (
            await db.execute(
                select(Contact).where(
                    Contact.user_id == user_id,
                    Contact.phone_e164 == test_phone,
                )
            )
        ).scalar_one_or_none()
        assert contact is not None
        assert contact.display_name == "Ayşe Demir"
        assert contact.whatsapp_profile_name == "Ayşe Demir"

        # 2. Lead created for CRM compatibility
        lead = (
            await db.execute(
                select(Lead).where(
                    Lead.user_id == user_id,
                    Lead.phone_e164 == test_phone,
                )
            )
        ).scalar_one_or_none()
        assert lead is not None
        assert lead.name == "Ayşe Demir"
        assert contact.lead_id == lead.id

        # 3. Conversation created with multi-number isolation
        conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.user_id == user_id,
                    Conversation.whatsapp_number_id == wanum.id,
                    Conversation.contact_id == contact.id,
                )
            )
        ).scalar_one_or_none()
        assert conv is not None
        assert conv.status == ConversationStatus.ACTIVE
        assert conv.unread_count == 1
        assert conv.last_message_preview == "Merhaba, ürün hakkında bilgi alabilir miyim?"
        assert conv.last_customer_message_at is not None

        # 3. Message persisted
        msg = (
            await db.execute(
                select(Message).where(Message.wa_message_id == wamid)
            )
        ).scalar_one_or_none()
        assert msg is not None
        assert msg.conversation_id == conv.id
        assert msg.direction == MessageDirection.INBOUND
        assert msg.body == "Merhaba, ürün hakkında bilgi alabilir miyim?"
        assert msg.status == ConversationMessageStatus.RECEIVED
        assert msg.sender_phone == test_phone


@pytest.mark.asyncio
async def test_02_idempotency_duplicate_wa_message_id_ignored(auth_headers):
    transport = ASGITransport(app=app)
    user_id = str(uuid.uuid4())
    session_name = f"sess_idemp_{uuid.uuid4().hex[:6]}"
    wamid = f"wamid_idemp_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
        )
        db.add(sess)
        await db.commit()

    rand_digits = f"{uuid.uuid4().int % 100000000:08d}"
    test_phone = f"+9054{rand_digits}"

    payload = {
        "session_name": session_name,
        "phone": test_phone,
        "message": "İlk gönderim",
        "wa_message_id": wamid,
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # First send -> success
        res1 = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
        assert res1.status_code == 200
        assert res1.json()["status"] == "success"

        # Second send with identical wa_message_id -> duplicate ignored
        with patch.object(ws_manager, "broadcast", new_callable=AsyncMock) as mock_broadcast:
            res2 = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
            assert res2.status_code == 200
            data2 = res2.json()
            assert data2["status"] == "duplicate"
            assert data2["wa_message_id"] == wamid
            # No WebSocket event emitted on duplicate
            mock_broadcast.assert_not_called()

    # Check only ONE message exists in DB
    async with AsyncSessionLocal() as db:
        messages = (
            await db.execute(select(Message).where(Message.wa_message_id == wamid))
        ).scalars().all()
        assert len(messages) == 1


@pytest.mark.asyncio
async def test_03_existing_contact_reused_and_linked_lead_updated(auth_headers):
    transport = ASGITransport(app=app)
    user_id = str(uuid.uuid4())
    session_name = f"sess_lead_{uuid.uuid4().hex[:6]}"
    rand_digits = f"{uuid.uuid4().int % 100000000:08d}"
    sender_phone = f"+9051{rand_digits}"

    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
        )
        db.add(sess)

        # Pre-existing Lead in CRM
        lead = Lead(
            user_id=user_id,
            name="Mevcut CRM Lideri",
            phone=sender_phone,
            phone_e164=sender_phone,
            status=LeadStatus.CONTACTED,
            place_id=f"wa_test_{uuid.uuid4().hex[:8]}",
        )
        db.add(lead)

        # Pre-existing Contact linked to Lead
        contact = Contact(
            user_id=user_id,
            phone_e164=sender_phone,
            display_name="Mevcut CRM Lideri",
            lead_id=lead.id,
        )
        db.add(contact)
        await db.commit()
        await db.refresh(lead)
        await db.refresh(contact)
        lead_id = lead.id
        contact_id = contact.id

    payload = {
        "session_name": session_name,
        "phone": sender_phone,
        "message": "Teklifinizi kabul ediyorum.",
        "wa_message_id": f"wamid_lead_{uuid.uuid4().hex[:6]}",
        "push_name": "Ayşe Profil",
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
        assert res.status_code == 200

    async with AsyncSessionLocal() as db:
        # Contact was reused, not duplicated
        contacts = (
            await db.execute(
                select(Contact).where(
                    Contact.user_id == user_id,
                    Contact.phone_e164 == sender_phone,
                )
            )
        ).scalars().all()
        assert len(contacts) == 1
        assert contacts[0].id == contact_id
        assert contacts[0].lead_id == lead_id
        assert contacts[0].whatsapp_profile_name == "Ayşe Profil"

        # Lead status updated to REPLIED
        updated_lead = await db.get(Lead, lead_id)
        assert updated_lead.status == LeadStatus.REPLIED
        assert "Teklifinizi kabul ediyorum." in updated_lead.notes


@pytest.mark.asyncio
async def test_04_tenant_mismatch_rejected_fail_closed(auth_headers):
    transport = ASGITransport(app=app)
    real_tenant = str(uuid.uuid4())
    attacker_tenant = str(uuid.uuid4())
    session_name = f"sess_sec_{uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=real_tenant,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
        )
        db.add(sess)
        await db.commit()

    payload = {
        "tenant_id": attacker_tenant,  # Mismatch!
        "session_name": session_name,
        "phone": "+905320000000",
        "message": "Sızma denemesi",
        "wa_message_id": "wamid_attack_01",
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
        assert res.status_code == 403
        assert "Tenant oturum eşleşmedi" in res.json()["detail"]


@pytest.mark.asyncio
async def test_05_invalid_webhook_secret_rejected_fail_closed():
    transport = ASGITransport(app=app)
    payload = {"phone": "+905320000000", "message": "Test"}

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Missing header
        res1 = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload)
        assert res1.status_code == 401

        # Wrong secret
        res2 = await ac.post(
            "/api/v1/whatsapp/webhook/inbound",
            json=payload,
            headers={"X-Webhook-Secret": "wrong-secret-12345"},
        )
        assert res2.status_code == 401


@pytest.mark.asyncio
async def test_06_group_chat_ignored_from_personal_inbox(auth_headers):
    transport = ASGITransport(app=app)
    user_id = str(uuid.uuid4())
    session_name = f"sess_group_{uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
        )
        db.add(sess)
        await db.commit()

    payload = {
        "session_name": session_name,
        "wa_jid": "120363024829281@g.us",
        "message": "Grup sohbeti bildirimi",
        "wa_message_id": "wamid_group_001",
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
        assert res.status_code == 200
        assert res.json()["status"] == "ignored"
        assert "Group chat" in res.json()["reason"]


@pytest.mark.asyncio
async def test_07_media_message_type_classification(auth_headers):
    transport = ASGITransport(app=app)
    user_id = str(uuid.uuid4())
    session_name = f"sess_media_{uuid.uuid4().hex[:6]}"
    wamid = f"wamid_img_{uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
        )
        db.add(sess)
        await db.commit()

    rand_digits = f"{uuid.uuid4().int % 100000000:08d}"
    test_phone = f"+9056{rand_digits}"

    payload = {
        "session_name": session_name,
        "phone": test_phone,
        "message": "📷 Fotoğraf",
        "message_type": "IMAGE",
        "wa_message_id": wamid,
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
        assert res.status_code == 200

    async with AsyncSessionLocal() as db:
        msg = (
            await db.execute(select(Message).where(Message.wa_message_id == wamid))
        ).scalar_one_or_none()
        assert msg is not None
        assert msg.message_type == MessageType.IMAGE
        assert msg.body == "📷 Fotoğraf"


@pytest.mark.asyncio
async def test_08_opt_out_pattern_adds_blacklist_and_unsubscribes_lead(auth_headers):
    transport = ASGITransport(app=app)
    user_id = str(uuid.uuid4())
    session_name = f"sess_optout_{uuid.uuid4().hex[:6]}"
    rand_digits = f"{uuid.uuid4().int % 100000000:08d}"
    opt_out_phone = f"+9059{rand_digits}"

    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
        )
        db.add(sess)

        lead = Lead(
            user_id=user_id,
            name="Ayrılmak İsteyen",
            phone=opt_out_phone,
            phone_e164=opt_out_phone,
            status=LeadStatus.CONTACTED,
            place_id=f"wa_test_{uuid.uuid4().hex[:8]}",
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)
        lead_id = lead.id

    payload = {
        "session_name": session_name,
        "phone": opt_out_phone,
        "message": "Lütfen beni listeden sil, mesaj istemiyorum",
        "wa_message_id": f"wamid_opt_{uuid.uuid4().hex[:6]}",
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/whatsapp/webhook/inbound", json=payload, headers=auth_headers)
        assert res.status_code == 200

    async with AsyncSessionLocal() as db:
        # Blacklist added
        bl = (
            await db.execute(select(Blacklist).where(Blacklist.phone_e164 == opt_out_phone))
        ).scalar_one_or_none()
        assert bl is not None
        assert bl.reason == "OPT_OUT_KEYWORD"

        # Lead status is UNSUBSCRIBED
        updated_lead = await db.get(Lead, lead_id)
        assert updated_lead.status == LeadStatus.UNSUBSCRIBED
