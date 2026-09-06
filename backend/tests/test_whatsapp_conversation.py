import pytest
from datetime import datetime, timezone
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.message_log import MessageStatus
from backend.app.services.whatsapp_cloud_service import WhatsAppCloudService
from backend.app.schemas.whatsapp_cloud import ParsedIncomingMessage, ParsedStatusUpdate


from backend.app.core.database import Base, engine, AsyncSessionLocal
from backend.app.core.migrations import ensure_conversations_columns


async def clean_db(db):
    await ensure_conversations_columns(engine)
    await db.execute(Message.__table__.delete())
    await db.execute(Conversation.__table__.delete())
    await db.commit()


@pytest.mark.asyncio
async def test_inbound_message_creates_conversation_and_message():
    """Verifies that an incoming WhatsApp message creates Conversation and Message entities."""
    test_phone = "+905411112233"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(
            name="Conversation Test Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.NEW,
        )
        db_session.add(lead)
        await db_session.commit()
        await db_session.refresh(lead)

        msg = ParsedIncomingMessage(
            message_id="wamid.CONV_TEST_001",
            sender_phone=test_phone,
            sender_name="Conversation Test Lead",
            text="Hello Tezlify, this is my first message.",
            timestamp=datetime.now(timezone.utc),
        )

        result = await WhatsAppCloudService.process_incoming_message(db_session, msg)
        assert result["status"] == "processed"
        assert result["lead_id"] == lead.id
        assert result["conversation_id"] is not None

        # Check Conversation
        conv = await db_session.get(Conversation, result["conversation_id"])
        assert conv is not None
        assert conv.lead_id == lead.id
        assert conv.channel == "WHATSAPP"
        assert conv.status == ConversationStatus.ACTIVE

        # Check Message
        stmt = select(Message).where(Message.conversation_id == conv.id)
        messages = (await db_session.execute(stmt)).scalars().all()
        assert len(messages) == 1
        assert messages[0].wa_message_id == "wamid.CONV_TEST_001"
        assert messages[0].direction == MessageDirection.INBOUND
        assert messages[0].status == ConversationMessageStatus.RECEIVED
        assert messages[0].body == "Hello Tezlify, this is my first message."

        # Check Lead status
        await db_session.refresh(lead)
        assert lead.status == LeadStatus.REPLIED
        assert "Hello Tezlify" in lead.notes


@pytest.mark.asyncio
async def test_multiple_messages_reuse_same_conversation():
    """Verifies that sequential messages from the same Lead attach to the single active Conversation thread."""
    test_phone = "+905412223344"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(
            name="Multi Message Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.NEW,
        )
        db_session.add(lead)
        await db_session.commit()

        msg1 = ParsedIncomingMessage(
            message_id="wamid.MULTI_001",
            sender_phone=test_phone,
            sender_name="Multi Message Lead",
            text="Message 1",
            timestamp=datetime.now(timezone.utc),
        )
        msg2 = ParsedIncomingMessage(
            message_id="wamid.MULTI_002",
            sender_phone=test_phone,
            sender_name="Multi Message Lead",
            text="Message 2",
            timestamp=datetime.now(timezone.utc),
        )

        res1 = await WhatsAppCloudService.process_incoming_message(db_session, msg1)
        res2 = await WhatsAppCloudService.process_incoming_message(db_session, msg2)

        assert res1["status"] == "processed"
        assert res2["status"] == "processed"
        assert res1["conversation_id"] == res2["conversation_id"]

        # Verify 1 Conversation with 2 Messages
        conv_id = res1["conversation_id"]
        conv_stmt = select(Conversation).where(Conversation.lead_id == lead.id)
        convs = (await db_session.execute(conv_stmt)).scalars().all()
        assert len(convs) == 1

        msg_stmt = select(Message).where(Message.conversation_id == conv_id).order_by(Message.id.asc())
        messages = (await db_session.execute(msg_stmt)).scalars().all()
        assert len(messages) == 2
        assert messages[0].body == "Message 1"
        assert messages[1].body == "Message 2"


@pytest.mark.asyncio
async def test_idempotent_duplicate_message_rejected():
    """Verifies that sending an identical message_id twice does not create duplicate Message entities."""
    test_phone = "+905413334455"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(
            name="Idempotency Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.NEW,
        )
        db_session.add(lead)
        await db_session.commit()

        msg = ParsedIncomingMessage(
            message_id="wamid.IDEMPOTENT_DUPLICATE_999",
            sender_phone=test_phone,
            sender_name="Idempotency Lead",
            text="Original Message",
            timestamp=datetime.now(timezone.utc),
        )

        res1 = await WhatsAppCloudService.process_incoming_message(db_session, msg)
        assert res1["status"] == "processed"

        # Replay identical message
        res2 = await WhatsAppCloudService.process_incoming_message(db_session, msg)
        assert res2["status"] == "idempotent_duplicate"

        # Assert exactly 1 message exists in DB
        msg_stmt = select(Message).where(Message.wa_message_id == "wamid.IDEMPOTENT_DUPLICATE_999")
        messages = (await db_session.execute(msg_stmt)).scalars().all()
        assert len(messages) == 1


@pytest.mark.asyncio
async def test_status_update_on_conversation_message():
    """Verifies status progression (SENT -> DELIVERED -> READ) on Message entity."""
    test_phone = "+905414445566"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(
            name="Status Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.CONTACTED,
        )
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP")
        db_session.add(conv)
        await db_session.commit()

        outbound_msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Outbound test",
            wa_message_id="wamid.OUTBOUND_STATUS_001",
            sender_phone="BUSINESS",
            recipient_phone=test_phone,
            status=ConversationMessageStatus.SENT,
        )
        db_session.add(outbound_msg)
        await db_session.commit()

        # 1. Update to DELIVERED
        status_delivered = ParsedStatusUpdate(
            message_id="wamid.OUTBOUND_STATUS_001",
            recipient_phone=test_phone,
            status=MessageStatus.DELIVERED,
            timestamp=datetime.now(timezone.utc),
        )
        await WhatsAppCloudService.process_status_update(db_session, status_delivered)
        await db_session.refresh(outbound_msg)
        assert outbound_msg.status == ConversationMessageStatus.DELIVERED

        # 2. Update to READ
        status_read = ParsedStatusUpdate(
            message_id="wamid.OUTBOUND_STATUS_001",
            recipient_phone=test_phone,
            status=MessageStatus.READ,
            timestamp=datetime.now(timezone.utc),
        )
        await WhatsAppCloudService.process_status_update(db_session, status_read)
        await db_session.refresh(outbound_msg)
        assert outbound_msg.status == ConversationMessageStatus.READ

        # 3. Delayed DELIVERED should NOT downgrade READ
        await WhatsAppCloudService.process_status_update(db_session, status_delivered)
        await db_session.refresh(outbound_msg)
        assert outbound_msg.status == ConversationMessageStatus.READ


@pytest.mark.asyncio
async def test_conversations_rest_api():
    """Verifies REST endpoints /api/v1/conversations, /{id}, and /lead/{lead_id}."""
    test_phone = "+905415556677"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(
            name="REST API Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.NEW,
        )
        db_session.add(lead)
        await db_session.commit()
        await db_session.refresh(lead)
        lead_id = lead.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Get or init lead conversation
        res_lead = await client.get(f"/api/v1/conversations/lead/{lead_id}")
        assert res_lead.status_code == 200
        conv_data = res_lead.json()
        assert conv_data["lead_id"] == lead_id
        conv_id = conv_data["id"]

        # List conversations
        res_list = await client.get("/api/v1/conversations")
        assert res_list.status_code == 200
        convs = res_list.json()
        assert any(c["id"] == conv_id for c in convs)

        # Get conversation detail
        res_detail = await client.get(f"/api/v1/conversations/{conv_id}")
        assert res_detail.status_code == 200
        assert res_detail.json()["id"] == conv_id


@pytest.mark.asyncio
async def test_conversation_message_pagination():
    """Verifies cursor pagination on messages within a conversation."""
    test_phone = "+905416667788"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(
            name="Pagination Test Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.NEW,
        )
        db_session.add(lead)
        await db_session.commit()
        await db_session.refresh(lead)

        conv = Conversation(
            lead_id=lead.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)

        # Create 15 messages (1 to 15)
        for i in range(1, 16):
            m = Message(
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND if i % 2 == 1 else MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body=f"Message {i:02d}",
                wa_message_id=f"wamid.PAG_{i:02d}",
                sender_phone=test_phone if i % 2 == 1 else "BUSINESS",
                recipient_phone="BUSINESS" if i % 2 == 1 else test_phone,
                status=ConversationMessageStatus.RECEIVED if i % 2 == 1 else ConversationMessageStatus.SENT,
            )
            db_session.add(m)
        await db_session.commit()
        conv_id = conv.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Page 1: Latest 5 messages (limit=5)
        res1 = await client.get(f"/api/v1/conversations/{conv_id}?limit=5")
        assert res1.status_code == 200
        data1 = res1.json()
        assert len(data1["messages"]) == 5
        assert data1["has_more"] is True
        # Chronological: Message 11, 12, 13, 14, 15
        assert data1["messages"][0]["body"] == "Message 11"
        assert data1["messages"][-1]["body"] == "Message 15"
        oldest_id_p1 = data1["messages"][0]["id"]

        # Page 2: Older messages before oldest_id_p1
        res2 = await client.get(f"/api/v1/conversations/{conv_id}?limit=5&before={oldest_id_p1}")
        assert res2.status_code == 200
        data2 = res2.json()
        assert len(data2["messages"]) == 5
        assert data2["has_more"] is True
        # Chronological: Message 06, 07, 08, 09, 10
        assert data2["messages"][0]["body"] == "Message 06"
        assert data2["messages"][-1]["body"] == "Message 10"
        oldest_id_p2 = data2["messages"][0]["id"]

        # Page 3: Oldest remaining messages
        res3 = await client.get(f"/api/v1/conversations/{conv_id}?limit=5&before={oldest_id_p2}")
        assert res3.status_code == 200
        data3 = res3.json()
        assert len(data3["messages"]) == 5
        assert data3["has_more"] is False
        assert data3["messages"][0]["body"] == "Message 01"
        assert data3["messages"][-1]["body"] == "Message 05"


@pytest.mark.asyncio
async def test_conversation_unread_count_and_mark_as_read():
    """Verifies that inbound messages increment unread_count and POST /read resets it to 0."""
    test_phone = "+905417778899"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(
            name="Unread Test Lead",
            phone=test_phone,
            phone_e164=test_phone,
            status=LeadStatus.NEW,
        )
        db_session.add(lead)
        await db_session.commit()
        await db_session.refresh(lead)

        # Inbound Message 1
        msg1 = ParsedIncomingMessage(
            message_id="wamid.UNREAD_001",
            sender_phone=test_phone,
            sender_name="Unread Test Lead",
            text="First unread message",
            timestamp=datetime.now(timezone.utc),
        )
        res1 = await WhatsAppCloudService.process_incoming_message(db_session, msg1)
        conv_id = res1["conversation_id"]

        # Inbound Message 2
        msg2 = ParsedIncomingMessage(
            message_id="wamid.UNREAD_002",
            sender_phone=test_phone,
            sender_name="Unread Test Lead",
            text="Second unread message",
            timestamp=datetime.now(timezone.utc),
        )
        await WhatsAppCloudService.process_incoming_message(db_session, msg2)

        # Verify in DB unread_count == 2
        conv = await db_session.get(Conversation, conv_id)
        assert conv.unread_count == 2

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Mark as read via POST /api/v1/conversations/{conv_id}/read
        res_read = await client.post(f"/api/v1/conversations/{conv_id}/read")
        assert res_read.status_code == 200
        assert res_read.json()["unread_count"] == 0

        # Verify DB unread_count == 0
        async with AsyncSessionLocal() as db_session:
            conv_db = await db_session.get(Conversation, conv_id)
            assert conv_db.unread_count == 0
            assert conv_db.last_read_at is not None


@pytest.mark.asyncio
async def test_inbound_image_webhook_parsing():
    """Verifies that an incoming IMAGE webhook parses and persists media metadata."""
    test_phone = "+905418889900"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Image Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.NEW)
        db_session.add(lead)
        await db_session.commit()

        from backend.app.schemas.whatsapp_cloud import parse_meta_webhook_payload
        raw_payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": "WABA_123",
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "contacts": [{"wa_id": "905418889900", "profile": {"name": "Image Sender"}}],
                        "messages": [{
                            "id": "wamid.IMG_TEST_001",
                            "from": "905418889900",
                            "timestamp": "1700000000",
                            "type": "image",
                            "image": {
                                "id": "MEDIA_IMG_999",
                                "mime_type": "image/jpeg",
                                "caption": "İşte ürün görseli",
                            }
                        }]
                    },
                    "field": "messages"
                }]
            }]
        }

        incoming_msgs, _ = parse_meta_webhook_payload(raw_payload)
        assert len(incoming_msgs) == 1
        parsed = incoming_msgs[0]
        assert parsed.raw_type == "image"
        assert parsed.media_id == "MEDIA_IMG_999"
        assert parsed.media_mime_type == "image/jpeg"
        assert parsed.media_caption == "İşte ürün görseli"

        res = await WhatsAppCloudService.process_incoming_message(db_session, parsed)
        assert res["status"] == "processed"

        stmt = select(Message).where(Message.wa_message_id == "wamid.IMG_TEST_001")
        msg_entity = (await db_session.execute(stmt)).scalar_one()
        assert msg_entity.message_type == MessageType.IMAGE
        assert msg_entity.media_id == "MEDIA_IMG_999"
        assert msg_entity.media_mime_type == "image/jpeg"
        assert msg_entity.media_caption == "İşte ürün görseli"


@pytest.mark.asyncio
async def test_inbound_document_and_audio_webhook_parsing():
    """Verifies that incoming DOCUMENT and AUDIO webhooks parse and persist properly."""
    test_phone = "+905419990011"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Doc Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.NEW)
        db_session.add(lead)
        await db_session.commit()

        from backend.app.schemas.whatsapp_cloud import parse_meta_webhook_payload
        raw_payload = {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": "WABA_123",
                "changes": [{
                    "value": {
                        "messaging_product": "whatsapp",
                        "contacts": [{"wa_id": "905419990011", "profile": {"name": "Doc Sender"}}],
                        "messages": [
                            {
                                "id": "wamid.DOC_TEST_001",
                                "from": "905419990011",
                                "timestamp": "1700000001",
                                "type": "document",
                                "document": {
                                    "id": "MEDIA_DOC_111",
                                    "mime_type": "application/pdf",
                                    "filename": "teklif_proforma.pdf",
                                    "caption": "Fiyat teklifimiz ektedir.",
                                }
                            },
                            {
                                "id": "wamid.AUD_TEST_001",
                                "from": "905419990011",
                                "timestamp": "1700000002",
                                "type": "audio",
                                "audio": {
                                    "id": "MEDIA_AUD_222",
                                    "mime_type": "audio/ogg",
                                }
                            }
                        ]
                    },
                    "field": "messages"
                }]
            }]
        }

        incoming_msgs, _ = parse_meta_webhook_payload(raw_payload)
        assert len(incoming_msgs) == 2

        # Process document
        res_doc = await WhatsAppCloudService.process_incoming_message(db_session, incoming_msgs[0])
        assert res_doc["status"] == "processed"

        # Process audio
        res_aud = await WhatsAppCloudService.process_incoming_message(db_session, incoming_msgs[1])
        assert res_aud["status"] == "processed"

        doc_msg = (await db_session.execute(select(Message).where(Message.wa_message_id == "wamid.DOC_TEST_001"))).scalar_one()
        assert doc_msg.message_type == MessageType.DOCUMENT
        assert doc_msg.media_id == "MEDIA_DOC_111"
        assert doc_msg.media_filename == "teklif_proforma.pdf"

        aud_msg = (await db_session.execute(select(Message).where(Message.wa_message_id == "wamid.AUD_TEST_001"))).scalar_one()
        assert aud_msg.message_type == MessageType.AUDIO
        assert aud_msg.media_id == "MEDIA_AUD_222"


@pytest.mark.asyncio
async def test_conversation_archive_close_and_reopen():
    """Verifies lifecycle status transitions: ACTIVE -> ARCHIVED -> CLOSED and auto REOPEN on new inbound."""
    test_phone = "+905410001122"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Lifecycle Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.NEW)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Archive conversation
        res_arch = await client.patch(f"/api/v1/conversations/{conv_id}/status", json={"status": "ARCHIVED"})
        assert res_arch.status_code == 200
        assert res_arch.json()["status"] == "ARCHIVED"

        # 2. Close conversation
        res_close = await client.patch(f"/api/v1/conversations/{conv_id}/status", json={"status": "CLOSED"})
        assert res_close.status_code == 200
        assert res_close.json()["status"] == "CLOSED"

    # 3. New inbound message arrives while CLOSED -> Should reopen to ACTIVE and increment unread_count
    async with AsyncSessionLocal() as db_session:
        new_msg = ParsedIncomingMessage(
            message_id="wamid.REOPEN_001",
            sender_phone=test_phone,
            sender_name="Lifecycle Lead",
            text="I want to buy now",
            timestamp=datetime.now(timezone.utc),
        )
        res_reopen = await WhatsAppCloudService.process_incoming_message(db_session, new_msg)
        assert res_reopen["status"] == "processed"

        conv_reopened = await db_session.get(Conversation, conv_id)
        assert conv_reopened.status == ConversationStatus.ACTIVE
        assert conv_reopened.unread_count >= 1


@pytest.mark.asyncio
async def test_conversation_list_filters_and_media_idor():
    """Verifies thin list filters (status, search, unread_only) and IDOR protection on media endpoint."""
    test_phone = "+905419998877"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Filter Test Acme", phone=test_phone, phone_e164=test_phone, status=LeadStatus.NEW)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE, unread_count=3)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)

        msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.IMAGE,
            body="[Görsel]",
            media_id="MEDIA_SECRET_123",
            sender_phone=test_phone,
            recipient_phone="BUSINESS",
            status=ConversationMessageStatus.RECEIVED,
        )
        db_session.add(msg)
        await db_session.commit()
        conv_id = conv.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Search by lead name
        res_search = await client.get("/api/v1/conversations?search=Acme")
        assert res_search.status_code == 200
        assert len(res_search.json()) == 1

        # Search by unread
        res_unread = await client.get("/api/v1/conversations?unread_only=true")
        assert res_unread.status_code == 200
        assert len(res_unread.json()) == 1

        # Valid media request
        res_media_ok = await client.get(f"/api/v1/conversations/{conv_id}/media/MEDIA_SECRET_123")
        assert res_media_ok.status_code == 200
        assert res_media_ok.json()["media_id"] == "MEDIA_SECRET_123"

        # IDOR attempt: wrong media ID in this conversation -> 404
        res_media_idor = await client.get(f"/api/v1/conversations/{conv_id}/media/WRONG_MEDIA_ID")
        assert res_media_idor.status_code == 404


from unittest.mock import patch
from backend.app.services.whatsapp_cloud_client import WhatsAppCloudApiClient


@pytest.mark.asyncio
async def test_send_outbound_text_message_success():
    """Verifies that POST /conversations/{id}/messages dispatches an outbound text message and persists it."""
    test_phone = "+905412229988"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Outbound Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    with patch.object(
        WhatsAppCloudApiClient,
        "send_text_message",
        return_value={"success": True, "message_id": "wamid.MOCK_DISPATCH_001", "error": None}
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "Hello from Tezlify Outbound Engine!"}
            )
            assert res.status_code == 201
            data = res.json()
            assert data["direction"] == "OUTBOUND"
            assert data["status"] == "SENT"
            assert data["body"] == "Hello from Tezlify Outbound Engine!"
            assert data["wa_message_id"] == "wamid.MOCK_DISPATCH_001"
            assert data["recipient_phone"] == test_phone

    # Verify in DB
    async with AsyncSessionLocal() as db_session:
        conv_db = await db_session.get(Conversation, conv_id)
        assert conv_db.last_message_at is not None

        stmt = select(Message).where(Message.conversation_id == conv_id)
        msgs = (await db_session.execute(stmt)).scalars().all()
        assert len(msgs) == 1
        assert msgs[0].direction == MessageDirection.OUTBOUND
        assert msgs[0].status == ConversationMessageStatus.SENT


@pytest.mark.asyncio
async def test_send_outbound_message_closed_and_archived_behaviors():
    """Verifies that CLOSED conversation blocks outbound sending, while ARCHIVED auto-reopens to ACTIVE."""
    test_phone = "+905413338877"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Closed/Archived Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.CLOSED)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    with patch.object(
        WhatsAppCloudApiClient,
        "send_text_message",
        return_value={"success": True, "message_id": "wamid.MOCK_DISPATCH_002", "error": None}
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Closed conversation should be blocked (400)
            res_closed = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "This should be blocked"}
            )
            assert res_closed.status_code == 400
            assert "Kapalı" in res_closed.json()["detail"]

            # 2. Change status to ARCHIVED
            await client.patch(f"/api/v1/conversations/{conv_id}/status", json={"status": "ARCHIVED"})

            # 3. Sending to ARCHIVED should succeed and auto-reopen to ACTIVE
            res_archived = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "This should reopen the thread"}
            )
            assert res_archived.status_code == 201

            res_conv = await client.get(f"/api/v1/conversations/{conv_id}")
            assert res_conv.json()["status"] == "ACTIVE"


@pytest.mark.asyncio
async def test_send_outbound_message_idempotency():
    """Verifies that repeated requests with the same X-Idempotency-Key return the existing message."""
    test_phone = "+905414447766"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Idempotent Outbound Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    with patch.object(
        WhatsAppCloudApiClient,
        "send_text_message",
        return_value={"success": True, "message_id": "idemp_outbound_unique_key_123", "error": None}
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            idempotency_key = "idemp_outbound_unique_key_123"

            # Request 1
            res1 = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                headers={"X-Idempotency-Key": idempotency_key},
                json={"body": "Hello once"}
            )
            assert res1.status_code == 201
            msg1_id = res1.json()["id"]

            # Request 2 (replay)
            res2 = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                headers={"X-Idempotency-Key": idempotency_key},
                json={"body": "Hello once"}
            )
            assert res2.status_code == 201
            assert res2.json()["id"] == msg1_id

    # Verify only 1 message exists in DB
    async with AsyncSessionLocal() as db_session:
        stmt = select(Message).where(Message.conversation_id == conv_id)
        msgs = (await db_session.execute(stmt)).scalars().all()
        assert len(msgs) == 1


@pytest.mark.asyncio
async def test_send_outbound_message_meta_error_normalization():
    """Verifies that Meta API error responses are translated into 502 without leaking secrets."""
    test_phone = "+905415554433"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Meta Error Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    with patch.object(
        WhatsAppCloudApiClient,
        "send_text_message",
        return_value={"success": False, "message_id": None, "error": "Meta Rate Limit Exceeded (HTTP 429)"}
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "Test rate limit"}
            )
            assert res.status_code == 502
            assert "Rate Limit" in res.json()["detail"]

    # Verify 0 messages exist in DB on failure
    async with AsyncSessionLocal() as db_session:
        stmt = select(Message).where(Message.conversation_id == conv_id)
        msgs = (await db_session.execute(stmt)).scalars().all()
        assert len(msgs) == 0


@pytest.mark.asyncio
async def test_send_outbound_message_meta_auth_expired_token():
    """Verifies that Meta 401 Session Expired error is gracefully handled without creating phantom messages."""
    test_phone = "+905416665544"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Expired Auth Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    with patch.object(
        WhatsAppCloudApiClient,
        "send_text_message",
        return_value={"success": False, "message_id": None, "error": "Meta Error (HTTP 401, code 190, subcode 463): Session has expired"}
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/conversations/{conv_id}/messages",
                json={"body": "Hello with expired token"}
            )
            assert res.status_code == 502
            assert "Session has expired" in res.json()["detail"]

    # Invariant: No phantom Message created
    async with AsyncSessionLocal() as db_session:
        stmt = select(Message).where(Message.conversation_id == conv_id)
        msgs = (await db_session.execute(stmt)).scalars().all()
        assert len(msgs) == 0


@pytest.mark.asyncio
async def test_send_outbound_message_lead_missing_phone():
    """Verifies that attempting to send to a lead with no phone number returns 400 Bad Request."""
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)

        lead = Lead(name="No Phone Lead", phone="", phone_e164=None, status=LeadStatus.NEW)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Message to lead without phone"}
        )
        assert res.status_code == 400
        assert "telefon numarası" in res.json()["detail"]


@pytest.mark.asyncio
async def test_list_and_send_templates():
    """Verifies listing business templates and sending a template with variable rendering."""
    test_phone = "+905417778899"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Dr. Mehmet Öz", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. List templates
        res_list = await client.get("/api/v1/conversations/templates")
        assert res_list.status_code == 200
        templates = res_list.json()
        assert len(templates) >= 4
        keys = [t["key"] for t in templates]
        assert "welcome_intro" in keys
        assert "offer_followup" in keys

        # 2. Send template
        with patch.object(
            WhatsAppCloudApiClient,
            "send_template_message",
            return_value={"success": True, "message_id": "wamid.TMPL_TEST_001", "error": None}
        ):
            res_send = await client.post(
                f"/api/v1/conversations/{conv_id}/templates/send",
                json={"template_key": "welcome_intro", "variables": {"name": "Dr. Mehmet"}}
            )
            assert res_send.status_code == 201
            data = res_send.json()
            assert data["direction"] == "OUTBOUND"
            assert data["status"] == "SENT"
            assert "Dr. Mehmet" in data["body"]
            assert data["wa_message_id"] == "wamid.TMPL_TEST_001"


@pytest.mark.asyncio
async def test_check_24h_window_and_retry_failed_message():
    """Verifies 24h window calculation and retrying a FAILED message."""
    test_phone = "+905418889900"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Window Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

        # Insert a FAILED outbound message
        failed_msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Retry me please",
            sender_phone="BUSINESS",
            recipient_phone=test_phone,
            status=ConversationMessageStatus.FAILED,
            error_message="Network Error",
        )
        db_session.add(failed_msg)
        await db_session.commit()
        await db_session.refresh(failed_msg)
        msg_id = failed_msg.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Check conversation 24h window info
        res_conv = await client.get(f"/api/v1/conversations/{conv_id}")
        assert res_conv.status_code == 200
        conv_data = res_conv.json()
        assert conv_data["is_window_open"] is True

        # Retry failed message
        with patch.object(
            WhatsAppCloudApiClient,
            "send_text_message",
            return_value={"success": True, "message_id": "wamid.RETRY_SUCCESS_001", "error": None}
        ):
            res_retry = await client.post(f"/api/v1/conversations/{conv_id}/messages/{msg_id}/retry")
            assert res_retry.status_code == 200
            data_retry = res_retry.json()
            assert data_retry["status"] == "SENT"
            assert data_retry["wa_message_id"] == "wamid.RETRY_SUCCESS_001"

    # Now simulate an expired inbound message (>24 hours ago)
    from datetime import timedelta
    async with AsyncSessionLocal() as db_session:
        old_time = datetime.now(timezone.utc) - timedelta(hours=25)
        expired_inbound = Message(
            conversation_id=conv_id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Old message from yesterday",
            sender_phone=test_phone,
            recipient_phone="BUSINESS",
            status=ConversationMessageStatus.READ,
            external_timestamp=old_time,
            created_at=old_time,
        )
        db_session.add(expired_inbound)
        await db_session.commit()

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Check conversation 24h window is now closed
        res_expired = await client.get(f"/api/v1/conversations/{conv_id}")
        assert res_expired.status_code == 200
        assert res_expired.json()["is_window_open"] is False

        # 2. Regular text message must be REJECTED (HTTP 400)
        res_text_rejected = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "This should be blocked due to expired window"}
        )
        assert res_text_rejected.status_code == 400
        assert "24 saatlik müşteri iletişim süresi dolmuştur" in res_text_rejected.json()["detail"]

        # 3. Template message must be ALLOWED (HTTP 200)
        with patch.object(
            WhatsAppCloudApiClient,
            "send_template_message",
            return_value={"success": True, "message_id": "wamid.TMPL_AFTER_EXPIRED_001", "error": None}
        ):
            res_tmpl = await client.post(
                f"/api/v1/conversations/{conv_id}/templates/send",
                json={"template_key": "welcome_intro", "variables": {"name": "Expired Window Lead"}}
            )
            assert res_tmpl.status_code == 201
            assert res_tmpl.json()["wa_message_id"] == "wamid.TMPL_AFTER_EXPIRED_001"


@pytest.mark.asyncio
async def test_send_outbound_media():
    """Verifies sending outbound image and document messages."""
    test_phone = "+905419990011"
    async with AsyncSessionLocal() as db_session:
        await clean_db(db_session)
        await db_session.execute(Lead.__table__.delete().where(Lead.phone_e164 == test_phone))
        await db_session.commit()

        lead = Lead(name="Media Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.CONTACTED)
        db_session.add(lead)
        await db_session.commit()

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db_session.add(conv)
        await db_session.commit()
        await db_session.refresh(conv)
        conv_id = conv.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        with patch.object(
            WhatsAppCloudApiClient,
            "send_media_message",
            return_value={"success": True, "message_id": "wamid.MEDIA_SUCCESS_001", "error": None}
        ):
            res_media = await client.post(
                f"/api/v1/conversations/{conv_id}/media",
                json={
                    "media_type": "IMAGE",
                    "media_url": "https://example.com/catalog.jpg",
                    "caption": "Yeni Ürün Kataloğu"
                }
            )
            assert res_media.status_code == 201
            data = res_media.json()
            assert data["direction"] == "OUTBOUND"
            assert data["message_type"] == "IMAGE"
            assert data["media_caption"] == "Yeni Ürün Kataloğu"
            assert data["wa_message_id"] == "wamid.MEDIA_SUCCESS_001"




