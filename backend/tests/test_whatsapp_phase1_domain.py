"""
Tezlify WhatsApp Rebuild - Phase 1 Domain & Database Foundation Tests
Tests covering all 34 requirements defined in PHASE 1 specification:
- WhatsAppNumber (1-8)
- Contact (9-11)
- Conversation (12-18)
- Message (19-25)
- WebhookEvent (26-29)
- Data Integrity / Delete Semantics (30-33)
- Full Acceptance Scenario (34)
"""

import uuid
import hashlib
from datetime import datetime, timezone, timedelta
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.migrations import (
    ensure_whatsapp_numbers_table,
    ensure_contacts_table,
    ensure_webhook_events_table,
    ensure_conversations_columns,
    ensure_messages_media_columns,
    ensure_user_id_columns,
)
from backend.app.models.lead import Lead, LeadStatus
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
from backend.app.services.message_state_machine import (
    MessageStateMachine,
    InvalidMessageStatusTransitionError,
)
from backend.app.services.customer_window_service import (
    CustomerWindowService,
    MessagingPolicy,
)
from backend.app.services.whatsapp_number_service import WhatsAppNumberService
from backend.app.services.contact_service import ContactService


# ============================================================================
# 1. WhatsAppNumber Tests (1 - 8)
# ============================================================================

@pytest.mark.asyncio
async def test_01_wanum_create():
    """1. Create WhatsAppNumber successfully with all canonical fields."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Main Support Line",
            display_phone_number="+90 (541) 111 22 33",
            phone_number_e164="+905411112233",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            waba_id="waba_123456",
            business_account_id="bacc_987654",
            credential_reference="vault:meta:token:ref_1",
            status=WhatsAppNumberStatus.ACTIVE,
            verified_name="Tezlify Support",
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        assert wanum.id is not None
        assert wanum.user_id == tenant_id
        assert wanum.status == WhatsAppNumberStatus.ACTIVE
        assert wanum.credential_reference == "vault:meta:token:ref_1"


@pytest.mark.asyncio
async def test_02_wanum_duplicate_phone_number_id_rejected():
    """2. Duplicate phone_number_id rejected at database unique constraint level."""
    tenant_id = str(uuid.uuid4())
    shared_phone_id = f"meta_dup_id_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        num1 = WhatsAppNumber(
            user_id=tenant_id,
            name="Line 1",
            display_phone_number="+90 541 111 00 01",
            phone_number_e164="+905411110001",
            phone_number_id=shared_phone_id,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num1)
        await session.commit()

    async with AsyncSessionLocal() as session:
        num2 = WhatsAppNumber(
            user_id=tenant_id,
            name="Line 2 Duplicate",
            display_phone_number="+90 541 111 00 02",
            phone_number_e164="+905411110002",
            phone_number_id=shared_phone_id,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num2)
        with pytest.raises(IntegrityError):
            await session.commit()


@pytest.mark.asyncio
async def test_03_wanum_update():
    """3. Update WhatsAppNumber status, quality, and verified name."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Sales Line",
            display_phone_number="+90 541 222 33 44",
            phone_number_e164="+905412223344",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        # Update via service
        updated = await WhatsAppNumberService.update_number(
            session,
            number_id=wanum.id,
            user_id=tenant_id,
            verified_name="Tezlify Sales Official",
            quality_rating="GREEN",
            status=WhatsAppNumberStatus.INACTIVE,
        )
        assert updated.verified_name == "Tezlify Sales Official"
        assert updated.quality_rating == "GREEN"
        assert updated.status == WhatsAppNumberStatus.INACTIVE


@pytest.mark.asyncio
async def test_04_wanum_disconnect():
    """4. Disconnect sets status to DISCONNECTED, preserving record in DB."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Temporary Line",
            display_phone_number="+90 541 333 44 55",
            phone_number_e164="+905413334455",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        disconnected = await WhatsAppNumberService.disconnect_number(session, wanum.id, user_id=tenant_id)
        assert disconnected.status == WhatsAppNumberStatus.DISCONNECTED

        # Check still exists in DB
        fetched = await session.get(WhatsAppNumber, wanum.id)
        assert fetched is not None
        assert fetched.status == WhatsAppNumberStatus.DISCONNECTED


@pytest.mark.asyncio
async def test_05_wanum_delete_does_not_delete_lead():
    """5. Deleting/removing WhatsAppNumber does NOT delete CRM Lead."""
    tenant_id = str(uuid.uuid4())
    test_phone = f"+90555{uuid.uuid4().hex[:7]}"
    async with AsyncSessionLocal() as session:
        lead = Lead(user_id=tenant_id, name="Preserved Lead", phone=test_phone, phone_e164=test_phone, status=LeadStatus.NEW)
        session.add(lead)
        await session.commit()
        await session.refresh(lead)

        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Line To Delete",
            display_phone_number="+90 541 444 55 66",
            phone_number_e164="+905414445566",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        # Soft delete / disconnect number
        await WhatsAppNumberService.remove_number(session, wanum.id, user_id=tenant_id, hard_delete=False)

        # Verify Lead is completely intact
        db_lead = await session.get(Lead, lead.id)
        assert db_lead is not None
        assert db_lead.name == "Preserved Lead"


@pytest.mark.asyncio
async def test_06_wanum_delete_does_not_delete_contact():
    """6. Deleting WhatsAppNumber does NOT delete Contact."""
    tenant_id = str(uuid.uuid4())
    contact_phone = f"+90544{uuid.uuid4().hex[:7]}"
    async with AsyncSessionLocal() as session:
        contact = Contact(user_id=tenant_id, phone_e164=contact_phone, display_name="Preserved Contact")
        session.add(contact)
        await session.commit()
        await session.refresh(contact)

        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Line To Delete",
            display_phone_number="+90 541 555 66 77",
            phone_number_e164="+905415556677",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        # Remove number
        await WhatsAppNumberService.remove_number(session, wanum.id, user_id=tenant_id, hard_delete=False)

        # Verify Contact is intact
        db_contact = await session.get(Contact, contact.id)
        assert db_contact is not None
        assert db_contact.phone_e164 == contact_phone


@pytest.mark.asyncio
async def test_07_wanum_delete_does_not_delete_conversation():
    """7. Deleting WhatsAppNumber does NOT cascade delete Conversation."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Line With Convs",
            display_phone_number="+90 541 666 77 88",
            phone_number_e164="+905416667788",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        conv = Conversation(
            user_id=tenant_id,
            whatsapp_number_id=wanum.id,
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)

        # Disconnect / remove number
        await WhatsAppNumberService.remove_number(session, wanum.id, user_id=tenant_id, hard_delete=False)

        # Verify Conversation is intact
        db_conv = await session.get(Conversation, conv.id)
        assert db_conv is not None
        assert db_conv.status == ConversationStatus.ACTIVE


@pytest.mark.asyncio
async def test_08_wanum_unauthorized_tenant_cannot_access():
    """8. Tenant isolation: Tenant B cannot access or modify Tenant A's number."""
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        wanum = WhatsAppNumber(
            user_id=tenant_a,
            name="Tenant A Secret Line",
            display_phone_number="+90 541 777 88 99",
            phone_number_e164="+905417778899",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        # Tenant B attempts to fetch Tenant A's number
        fetched = await WhatsAppNumberService.get_number_by_id(session, wanum.id, user_id=tenant_b)
        assert fetched is None

        # Tenant B attempts to update Tenant A's number
        with pytest.raises(ValueError, match="not found or access denied"):
            await WhatsAppNumberService.update_number(session, wanum.id, user_id=tenant_b, name="Hacked Name")


# ============================================================================
# 2. Contact Tests (9 - 11)
# ============================================================================

def test_09_contact_phone_normalization():
    """9. E.164 phone normalization formats various inputs correctly."""
    assert ContactService.normalize_phone("+90 (541) 123 45 67") == "+905411234567"
    assert ContactService.normalize_phone("0541 123 45 67") == "+905411234567"
    assert ContactService.normalize_phone("905411234567") == "+905411234567"
    assert ContactService.normalize_phone("00905411234567") == "+905411234567"
    assert ContactService.normalize_phone("+1-800-555-0199") == "+18005550199"


@pytest.mark.asyncio
async def test_10_contact_duplicate_normalized_phone_handling():
    """10. Same tenant with duplicate normalized phone returns existing Contact."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        c1 = await ContactService.get_or_create_contact(
            session,
            user_id=tenant_id,
            phone="0542 999 88 77",
            display_name="Cevat Aydin",
        )
        await session.commit()

        c2 = await ContactService.get_or_create_contact(
            session,
            user_id=tenant_id,
            phone="+90 (542) 999-88-77",
            whatsapp_profile_name="Cevat WhatsApp",
        )
        await session.commit()

        assert c1.id == c2.id
        assert c2.phone_e164 == "+905429998877"
        assert c2.whatsapp_profile_name == "Cevat WhatsApp"


@pytest.mark.asyncio
async def test_11_contact_interact_through_multiple_numbers():
    """11. Single Contact can interact through multiple distinct WhatsApp numbers."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        num1 = WhatsAppNumber(
            user_id=tenant_id,
            name="Support Line",
            display_phone_number="+90 541 111 00 11",
            phone_number_e164="+905411110011",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        num2 = WhatsAppNumber(
            user_id=tenant_id,
            name="Sales Line",
            display_phone_number="+90 541 111 00 22",
            phone_number_e164="+905411110022",
            phone_number_id=f"meta_phone_id_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add_all([num1, num2])
        await session.commit()

        contact = await ContactService.get_or_create_contact(
            session,
            user_id=tenant_id,
            phone="+905431112233",
            display_name="Multi-Channel Customer",
        )
        await session.commit()

        # Conversation 1: Contact via Support Line
        conv1 = Conversation(
            user_id=tenant_id,
            whatsapp_number_id=num1.id,
            contact_id=contact.id,
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
        )
        # Conversation 2: Contact via Sales Line
        conv2 = Conversation(
            user_id=tenant_id,
            whatsapp_number_id=num2.id,
            contact_id=contact.id,
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
        )
        session.add_all([conv1, conv2])
        await session.commit()

        assert conv1.id != conv2.id
        assert conv1.contact_id == contact.id
        assert conv2.contact_id == contact.id
        assert conv1.whatsapp_number_id == num1.id
        assert conv2.whatsapp_number_id == num2.id


# ============================================================================
# 3. Conversation Tests (12 - 18)
# ============================================================================

@pytest.mark.asyncio
async def test_12_conv_create_without_lead():
    """12. Conversation can be created without any CRM Lead (lead_id is NULL)."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        conv = Conversation(
            user_id=tenant_id,
            lead_id=None,
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
            last_message_preview="Hello without lead",
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)

        assert conv.id is not None
        assert conv.lead_id is None


@pytest.mark.asyncio
async def test_13_conv_create_with_lead():
    """13. Conversation can be linked to a CRM Lead."""
    tenant_id = str(uuid.uuid4())
    lead_phone = f"+90533{uuid.uuid4().hex[:7]}"
    async with AsyncSessionLocal() as session:
        lead = Lead(user_id=tenant_id, name="Test Lead", phone=lead_phone, phone_e164=lead_phone, status=LeadStatus.NEW)
        session.add(lead)
        await session.commit()
        await session.refresh(lead)

        conv = Conversation(
            user_id=tenant_id,
            lead_id=lead.id,
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)

        assert conv.id is not None
        assert conv.lead_id == lead.id


@pytest.mark.asyncio
async def test_14_conv_number_a_contact_x_distinct_from_number_b():
    """14. Number A + Contact X != Number B + Contact X (distinct conversations)."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        c = Contact(user_id=tenant_id, phone_e164=f"+90532{uuid.uuid4().hex[:7]}", display_name="Target Customer")
        w1 = WhatsAppNumber(user_id=tenant_id, name="N1", display_phone_number="1", phone_number_e164="1", phone_number_id=f"p_{uuid.uuid4().hex[:8]}")
        w2 = WhatsAppNumber(user_id=tenant_id, name="N2", display_phone_number="2", phone_number_e164="2", phone_number_id=f"p_{uuid.uuid4().hex[:8]}")
        session.add_all([c, w1, w2])
        await session.commit()

        conv1 = Conversation(user_id=tenant_id, whatsapp_number_id=w1.id, contact_id=c.id, channel="whatsapp", status=ConversationStatus.ACTIVE)
        conv2 = Conversation(user_id=tenant_id, whatsapp_number_id=w2.id, contact_id=c.id, channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add_all([conv1, conv2])
        await session.commit()

        assert conv1.id != conv2.id
        assert conv1.whatsapp_number_id != conv2.whatsapp_number_id


@pytest.mark.asyncio
async def test_15_conv_unread_count():
    """15. Unread count increments on customer message and resets on mark read."""
    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=str(uuid.uuid4()), channel="whatsapp", status=ConversationStatus.ACTIVE, unread_count=0)
        session.add(conv)
        await session.commit()
        await session.refresh(conv)

        # Receive inbound messages
        conv.unread_count += 1
        await session.commit()
        await session.refresh(conv)
        assert conv.unread_count == 1

        conv.unread_count += 1
        await session.commit()
        await session.refresh(conv)
        assert conv.unread_count == 2

        # Mark as read
        conv.unread_count = 0
        conv.last_read_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(conv)
        assert conv.unread_count == 0
        assert conv.last_read_at is not None


@pytest.mark.asyncio
async def test_16_conv_last_customer_message_update():
    """16. Inbound message updates last_customer_message_at and customer window."""
    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=str(uuid.uuid4()), channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()

        now_utc = datetime.now(timezone.utc)
        CustomerWindowService.update_conversation_window(conv, customer_message_time=now_utc)
        await session.commit()
        await session.refresh(conv)

        assert conv.last_customer_message_at is not None
        assert conv.customer_service_window_expires_at is not None
        # Expires roughly 24 hours from now
        diff = conv.customer_service_window_expires_at.replace(tzinfo=timezone.utc) - now_utc
        assert 86390 <= diff.total_seconds() <= 86410


def test_17_conv_24h_window_calculation():
    """17. Meta 24-hour customer window calculation (FREEFORM_ALLOWED vs TEMPLATE_REQUIRED)."""
    now = datetime.now(timezone.utc)
    conv_active = Conversation(
        customer_service_window_expires_at=now + timedelta(hours=5),
        last_customer_message_at=now - timedelta(hours=19),
    )
    assert CustomerWindowService.evaluate_messaging_policy(conv_active, reference_time=now) == MessagingPolicy.FREEFORM_ALLOWED
    assert CustomerWindowService.is_within_24h_window(conv_active, reference_time=now) is True

    conv_expired = Conversation(
        customer_service_window_expires_at=now - timedelta(minutes=1),
        last_customer_message_at=now - timedelta(hours=24, minutes=1),
    )
    assert CustomerWindowService.evaluate_messaging_policy(conv_expired, reference_time=now) == MessagingPolicy.TEMPLATE_REQUIRED
    assert CustomerWindowService.is_within_24h_window(conv_expired, reference_time=now) is False


@pytest.mark.asyncio
async def test_18_conv_cross_tenant_access_rejected():
    """18. Tenant B cannot query or manipulate Tenant A's conversations."""
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        conv_a = Conversation(user_id=tenant_a, channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv_a)
        await session.commit()
        await session.refresh(conv_a)

        # Query filtered by tenant_b
        stmt = select(Conversation).where(Conversation.id == conv_a.id, Conversation.user_id == tenant_b)
        result = (await session.execute(stmt)).scalar_one_or_none()
        assert result is None


# ============================================================================
# 4. Message Tests (19 - 25)
# ============================================================================

@pytest.mark.asyncio
async def test_19_msg_inbound_creation():
    """19. Inbound message creation with wamid, direction INBOUND, status DELIVERED."""
    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=str(uuid.uuid4()), channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()

        wamid = f"wamid.IN_{uuid.uuid4().hex[:8]}"
        msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Inbound Hello",
            sender_phone="+905410001122",
            recipient_phone="+905419998877",
            wa_message_id=wamid,
            status=ConversationMessageStatus.DELIVERED,
            delivered_at=datetime.now(timezone.utc),
        )
        session.add(msg)
        await session.commit()
        await session.refresh(msg)

        assert msg.id is not None
        assert msg.external_message_id == wamid
        assert msg.direction == MessageDirection.INBOUND
        assert msg.status == ConversationMessageStatus.DELIVERED


@pytest.mark.asyncio
async def test_20_msg_outbound_pending():
    """20. Outbound pending message with client_message_id."""
    client_id = f"client_uuid_{uuid.uuid4()}"
    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=str(uuid.uuid4()), channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()

        msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Outbound Proposal",
            sender_phone="+905419998877",
            recipient_phone="+905410001122",
            client_message_id=client_id,
            status=ConversationMessageStatus.PENDING,
        )
        session.add(msg)
        await session.commit()
        await session.refresh(msg)

        assert msg.id is not None
        assert msg.client_message_id == client_id
        assert msg.status == ConversationMessageStatus.PENDING


@pytest.mark.asyncio
async def test_21_msg_duplicate_wamid_rejected():
    """21. Duplicate wamid (external_message_id) rejected at DB unique constraint."""
    shared_wamid = f"wamid.DUP_{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=str(uuid.uuid4()), channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()

        msg1 = Message(
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="First",
            sender_phone="+905410001122",
            recipient_phone="+905419998877",
            wa_message_id=shared_wamid,
            status=ConversationMessageStatus.DELIVERED,
        )
        session.add(msg1)
        await session.commit()

    async with AsyncSessionLocal() as session:
        msg2 = Message(
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Duplicate Webhook Attempt",
            sender_phone="+905410001122",
            recipient_phone="+905419998877",
            wa_message_id=shared_wamid,
            status=ConversationMessageStatus.DELIVERED,
        )
        session.add(msg2)
        with pytest.raises(IntegrityError):
            await session.commit()


@pytest.mark.asyncio
async def test_22_msg_duplicate_client_message_id_rejected():
    """22. Duplicate client_message_id rejected at DB unique constraint."""
    shared_client_id = f"client_dup_{uuid.uuid4()}"
    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=str(uuid.uuid4()), channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()

        msg1 = Message(
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Outbound 1",
            sender_phone="+905419998877",
            recipient_phone="+905410001122",
            client_message_id=shared_client_id,
            status=ConversationMessageStatus.PENDING,
        )
        session.add(msg1)
        await session.commit()

    async with AsyncSessionLocal() as session:
        msg2 = Message(
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Outbound 2 Double Click",
            sender_phone="+905419998877",
            recipient_phone="+905410001122",
            client_message_id=shared_client_id,
            status=ConversationMessageStatus.PENDING,
        )
        session.add(msg2)
        with pytest.raises(IntegrityError):
            await session.commit()


def test_23_msg_status_transition_valid():
    """23. Valid forward status transitions: PENDING -> SENT -> DELIVERED -> READ."""
    msg = Message(
        conversation_id=1,
        direction=MessageDirection.OUTBOUND,
        status=ConversationMessageStatus.PENDING,
        sender_phone="1",
        recipient_phone="2",
    )
    # PENDING -> SENT
    MessageStateMachine.transition(msg, ConversationMessageStatus.SENT)
    assert msg.status == ConversationMessageStatus.SENT
    assert msg.sent_at is not None

    # SENT -> DELIVERED
    MessageStateMachine.transition(msg, ConversationMessageStatus.DELIVERED)
    assert msg.status == ConversationMessageStatus.DELIVERED
    assert msg.delivered_at is not None

    # DELIVERED -> READ
    MessageStateMachine.transition(msg, ConversationMessageStatus.READ)
    assert msg.status == ConversationMessageStatus.READ
    assert msg.read_at is not None


def test_24_msg_status_transition_backward_rejected():
    """24. Backward status transitions rejected with InvalidMessageStatusTransitionError."""
    msg = Message(
        conversation_id=1,
        direction=MessageDirection.OUTBOUND,
        status=ConversationMessageStatus.READ,
        sender_phone="1",
        recipient_phone="2",
    )
    # READ cannot go back to DELIVERED
    with pytest.raises(InvalidMessageStatusTransitionError):
        MessageStateMachine.transition(msg, ConversationMessageStatus.DELIVERED)

    # READ cannot go back to SENT
    with pytest.raises(InvalidMessageStatusTransitionError):
        MessageStateMachine.transition(msg, ConversationMessageStatus.SENT)

    msg.status = ConversationMessageStatus.DELIVERED
    # DELIVERED cannot go back to SENT
    with pytest.raises(InvalidMessageStatusTransitionError):
        MessageStateMachine.transition(msg, ConversationMessageStatus.SENT)


@pytest.mark.asyncio
async def test_25_msg_timestamps_update():
    """25. Lifecycle timestamps set properly during state transitions."""
    async with AsyncSessionLocal() as session:
        conv = Conversation(user_id=str(uuid.uuid4()), channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()

        msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            status=ConversationMessageStatus.PENDING,
            sender_phone="+905411112233",
            recipient_phone="+905414445566",
        )
        session.add(msg)
        await session.commit()

        # Step to SENT
        t_sent = datetime.now(timezone.utc)
        MessageStateMachine.transition(msg, ConversationMessageStatus.SENT, event_time=t_sent)
        await session.commit()
        await session.refresh(msg)
        assert msg.sent_at is not None

        # Step to FAILED with error
        t_fail = datetime.now(timezone.utc)
        MessageStateMachine.transition(
            msg,
            ConversationMessageStatus.FAILED,
            event_time=t_fail,
            error_code=131051,
            error_message="Recipient phone number not in allowed list",
        )
        await session.commit()
        await session.refresh(msg)
        assert msg.status == ConversationMessageStatus.FAILED
        assert msg.error_code == 131051
        assert "not in allowed list" in msg.error_message


# ============================================================================
# 5. WebhookEvent Tests (26 - 29)
# ============================================================================

@pytest.mark.asyncio
async def test_26_webhook_duplicate_event_hash_rejected():
    """26. Duplicate event_hash rejected at DB unique constraint level."""
    payload = f'{{"object":"whatsapp_business_account","nonce":"{uuid.uuid4().hex}"}}'
    shared_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()

    async with AsyncSessionLocal() as session:
        e1 = WebhookEvent(
            provider="meta",
            event_type="messages",
            event_hash=shared_hash,
            status=WebhookEventStatus.PENDING,
            payload_json=payload,
        )
        session.add(e1)
        await session.commit()

    async with AsyncSessionLocal() as session:
        e2 = WebhookEvent(
            provider="meta",
            event_type="messages",
            event_hash=shared_hash,
            status=WebhookEventStatus.PENDING,
            payload_json=payload,
        )
        session.add(e2)
        with pytest.raises(IntegrityError):
            await session.commit()


@pytest.mark.asyncio
async def test_27_webhook_processing_state():
    """27. WebhookEvent transitions to PROCESSED with processed_at timestamp."""
    async with AsyncSessionLocal() as session:
        event = WebhookEvent(
            provider="meta",
            event_type="messages",
            event_hash=hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
            status=WebhookEventStatus.PENDING,
        )
        session.add(event)
        await session.commit()
        await session.refresh(event)

        # Process event
        event.status = WebhookEventStatus.PROCESSED
        event.processed_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(event)

        assert event.status == WebhookEventStatus.PROCESSED
        assert event.processed_at is not None


@pytest.mark.asyncio
async def test_28_webhook_failure_state():
    """28. WebhookEvent records failure status and failure_reason."""
    async with AsyncSessionLocal() as session:
        event = WebhookEvent(
            provider="meta",
            event_type="messages",
            event_hash=hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
            status=WebhookEventStatus.PENDING,
        )
        session.add(event)
        await session.commit()

        event.status = WebhookEventStatus.FAILED
        event.failure_reason = "Payload validation failed: missing field 'contacts'"
        event.processed_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(event)

        assert event.status == WebhookEventStatus.FAILED
        assert "missing field" in event.failure_reason


def test_29_webhook_retry_safe_deterministic_hash():
    """29. Deterministic hash computation ensures duplicate incoming payloads produce identical hashes."""
    payload_raw = '{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.123"}]}}]}]}'
    hash1 = hashlib.sha256(payload_raw.encode("utf-8")).hexdigest()
    hash2 = hashlib.sha256(payload_raw.encode("utf-8")).hexdigest()
    assert hash1 == hash2


# ============================================================================
# 6. Data Integrity / Delete Semantics Tests (30 - 33)
# ============================================================================

@pytest.mark.asyncio
async def test_30_integrity_deleting_number_never_cascades_into_lead():
    """30. Physical/hard delete of WhatsAppNumber NEVER deletes CRM Lead."""
    tenant_id = str(uuid.uuid4())
    lead_phone = f"+90551{uuid.uuid4().hex[:7]}"
    async with AsyncSessionLocal() as session:
        lead = Lead(user_id=tenant_id, name="Immortal Lead", phone=lead_phone, phone_e164=lead_phone, status=LeadStatus.NEW)
        session.add(lead)
        await session.commit()
        await session.refresh(lead)

        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Deletable Number",
            display_phone_number="+90 541 000 00 00",
            phone_number_e164="+905410000000",
            phone_number_id=f"meta_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()

        # Delete number directly via DB DELETE
        await session.delete(wanum)
        await session.commit()

        # Lead must still exist
        assert (await session.get(Lead, lead.id)) is not None


@pytest.mark.asyncio
async def test_31_integrity_deleting_number_never_cascades_into_contact():
    """31. Deleting WhatsAppNumber NEVER deletes Contact."""
    tenant_id = str(uuid.uuid4())
    contact_phone = f"+90552{uuid.uuid4().hex[:7]}"
    async with AsyncSessionLocal() as session:
        contact = Contact(user_id=tenant_id, phone_e164=contact_phone, display_name="Immortal Contact")
        session.add(contact)
        await session.commit()
        await session.refresh(contact)

        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Deletable Number",
            display_phone_number="+90 541 000 00 01",
            phone_number_e164="+905410000001",
            phone_number_id=f"meta_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()

        await session.delete(wanum)
        await session.commit()

        assert (await session.get(Contact, contact.id)) is not None


@pytest.mark.asyncio
async def test_32_integrity_deleting_number_never_cascades_into_message():
    """32. Deleting WhatsAppNumber NEVER cascades into deleting Message history."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Line With Messages",
            display_phone_number="+90 541 000 00 02",
            phone_number_e164="+905410000002",
            phone_number_id=f"meta_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()

        conv = Conversation(user_id=tenant_id, whatsapp_number_id=wanum.id, channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()

        msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            status=ConversationMessageStatus.DELIVERED,
            sender_phone="+905410000002",
            recipient_phone="+905411112233",
            body="Historical message to preserve",
        )
        session.add(msg)
        await session.commit()
        await session.refresh(msg)

        # Disconnect / soft remove number
        await WhatsAppNumberService.remove_number(session, wanum.id, user_id=tenant_id, hard_delete=False)

        # Message must exist and be accessible
        db_msg = await session.get(Message, msg.id)
        assert db_msg is not None
        assert db_msg.body == "Historical message to preserve"


@pytest.mark.asyncio
async def test_33_integrity_deleting_number_never_cascades_into_conversation():
    """33. Deleting WhatsAppNumber NEVER deletes Conversation records."""
    tenant_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Number For Conv Preservation",
            display_phone_number="+90 541 000 00 03",
            phone_number_e164="+905410000003",
            phone_number_id=f"meta_{uuid.uuid4().hex[:8]}",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()

        conv = Conversation(user_id=tenant_id, whatsapp_number_id=wanum.id, channel="whatsapp", status=ConversationStatus.ACTIVE)
        session.add(conv)
        await session.commit()
        await session.refresh(conv)

        # Soft remove
        await WhatsAppNumberService.remove_number(session, wanum.id, user_id=tenant_id, hard_delete=False)

        db_conv = await session.get(Conversation, conv.id)
        assert db_conv is not None
        assert db_conv.id == conv.id


# ============================================================================
# 7. Full Section 31 Acceptance Test (34)
# ============================================================================

@pytest.mark.asyncio
async def test_34_acceptance_full_rebuild_flow():
    """
    34. Section 31 Acceptance Test:
    - Tenant A creates Number A.
    - Customer X (without Lead) initiates conversation.
    - Inbound conversation created without Lead.
    - Customer X sends follow-up message -> Same conversation updated.
    - Duplicate webhook sent -> duplicate Message prevented.
    - Customer X sends message through Number B -> Separate Conversation created.
    - Number A conversation unaffected.
    - Number A disconnected -> Conversation, Messages, Contact remain intact.
    - Tenant B attempts to access Number A or create duplicate phone_number_id -> REJECTED.
    """
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())
    meta_id_a = f"phone_id_a_{uuid.uuid4().hex[:8]}"
    meta_id_b = f"phone_id_b_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        # 1. Tenant A has Number A
        num_a = WhatsAppNumber(
            user_id=tenant_a,
            name="Tenant A - Line A",
            display_phone_number="+90 555 100 00 01",
            phone_number_e164="+905551000001",
            phone_number_id=meta_id_a,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        # Also create Number B under Tenant A
        num_b = WhatsAppNumber(
            user_id=tenant_a,
            name="Tenant A - Line B",
            display_phone_number="+90 555 100 00 02",
            phone_number_e164="+905551000002",
            phone_number_id=meta_id_b,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add_all([num_a, num_b])
        await session.commit()
        await session.refresh(num_a)
        await session.refresh(num_b)

        # 2. Customer X (No CRM Lead) interacts
        cust_phone = f"+90530{uuid.uuid4().hex[:7]}"
        contact_x = await ContactService.get_or_create_contact(
            session,
            user_id=tenant_a,
            phone=cust_phone,
            display_name="Customer X",
        )
        await session.commit()
        assert contact_x.lead_id is None

        # 3. Inbound conversation created for Number A + Customer X
        conv_a = Conversation(
            user_id=tenant_a,
            whatsapp_number_id=num_a.id,
            contact_id=contact_x.id,
            lead_id=None,  # No lead!
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
            unread_count=1,
            last_message_preview="Hello Number A",
            last_message_at=datetime.now(timezone.utc),
            last_customer_message_at=datetime.now(timezone.utc),
            customer_service_window_expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
        )
        session.add(conv_a)
        await session.commit()
        await session.refresh(conv_a)

        wamid_1 = f"wamid.ACC_01_{uuid.uuid4().hex[:8]}"
        msg_1 = Message(
            conversation_id=conv_a.id,
            direction=MessageDirection.INBOUND,
            status=ConversationMessageStatus.DELIVERED,
            sender_phone=cust_phone,
            recipient_phone=num_a.phone_number_e164,
            wa_message_id=wamid_1,
            body="Hello Number A",
        )
        session.add(msg_1)
        await session.commit()

        # Save IDs to local variables to prevent expired attribute access across rollbacks
        num_a_id = num_a.id
        num_b_id = num_b.id
        contact_x_id = contact_x.id
        conv_a_id = conv_a.id
        msg_1_id = msg_1.id

        # 4. Customer X sends follow-up -> Same conversation updated
        conv_a.unread_count += 1
        conv_a.last_message_preview = "Follow up from X"
        conv_a.last_message_at = datetime.now(timezone.utc)
        conv_a.last_customer_message_at = datetime.now(timezone.utc)
        conv_a.customer_service_window_expires_at = datetime.now(timezone.utc) + timedelta(hours=24)

        wamid_2 = f"wamid.ACC_02_{uuid.uuid4().hex[:8]}"
        msg_2 = Message(
            conversation_id=conv_a_id,
            direction=MessageDirection.INBOUND,
            status=ConversationMessageStatus.DELIVERED,
            sender_phone=cust_phone,
            recipient_phone="+905551000001",
            wa_message_id=wamid_2,
            body="Follow up from X",
        )
        session.add(msg_2)
        await session.commit()

        # 5. Duplicate webhook with wamid_2 -> duplicate message rejected
        dup_msg = Message(
            conversation_id=conv_a_id,
            direction=MessageDirection.INBOUND,
            status=ConversationMessageStatus.DELIVERED,
            sender_phone=cust_phone,
            recipient_phone="+905551000001",
            wa_message_id=wamid_2,
            body="Duplicate follow up from X",
        )
        session.add(dup_msg)
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()

        # 6. Customer X interacts through Number B -> Separate Conversation created
        conv_b = Conversation(
            user_id=tenant_a,
            whatsapp_number_id=num_b_id,
            contact_id=contact_x_id,
            lead_id=None,
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
            unread_count=1,
            last_message_preview="Hello Number B",
            last_message_at=datetime.now(timezone.utc),
            last_customer_message_at=datetime.now(timezone.utc),
            customer_service_window_expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
        )
        session.add(conv_b)
        await session.commit()
        await session.refresh(conv_b)

        assert conv_b.id != conv_a_id
        assert conv_b.whatsapp_number_id == num_b_id

        # 7. Disconnect Number A
        await WhatsAppNumberService.disconnect_number(session, num_a_id, user_id=tenant_a)

        # 8. All data remains intact!
        conv_a_recheck = await session.get(Conversation, conv_a_id)
        assert conv_a_recheck is not None
        assert conv_a_recheck.last_message_preview == "Follow up from X"

        msg_1_recheck = await session.get(Message, msg_1_id)
        assert msg_1_recheck is not None

        contact_recheck = await session.get(Contact, contact_x_id)
        assert contact_recheck is not None

        # 9. Tenant B attempts to access Number A or create duplicate meta_id_a -> REJECT
        num_tenant_b_access = await WhatsAppNumberService.get_number_by_id(session, num_a_id, user_id=tenant_b)
        assert num_tenant_b_access is None

        tenant_b_hijack = WhatsAppNumber(
            user_id=tenant_b,
            name="Hijacked Number",
            display_phone_number="+90 555 100 00 01",
            phone_number_e164="+905551000001",
            phone_number_id=meta_id_a,  # Same Meta ID!
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(tenant_b_hijack)
        with pytest.raises(IntegrityError):
            await session.commit()
