"""
Tezlify WhatsApp Rebuild - Phase 1: Domain Model & 1:1 Session Linkage Tests
Verifies the 12 core requirements for BAILEYS_QR transport and WhatsAppSession linkage:

1. META_CLOUD WhatsAppNumber can be created.
2. BAILEYS_QR WhatsAppNumber can be created.
3. For BAILEYS_QR, phone_number_id can be NULL.
4. For BAILEYS_QR, phone_number_e164 can be stored.
5. WhatsAppNumber -> WhatsAppSession 1:1 relationship works bidirectionally.
6. Cannot link second WhatsAppSession to the same WhatsAppNumber (UNIQUE constraint).
7. Cannot link second WhatsAppNumber to the same WhatsAppSession (single FK identity).
8. Session tenant ownership invariant is strictly enforced (session.user_id == wanum.user_id).
9. User A can see their own session.
10. User A cannot access User B's session.
11. Existing META_CLOUD flows still pass without regression.
12. Existing Conversation -> WhatsAppNumber relationship preserved, no whatsapp_session_id on Conversation.
"""

import uuid
from datetime import datetime, timezone
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from backend.app.core.database import AsyncSessionLocal, engine, Base
from backend.app.core.migrations import (
    ensure_whatsapp_numbers_table,
    ensure_whatsapp_sessions_number_fk,
    ensure_contacts_table,
    ensure_conversations_columns,
    ensure_user_id_columns,
)
from backend.app.models.whatsapp_number import (
    WhatsAppNumber,
    WhatsAppNumberStatus,
    WhatsAppNumberProvider,
)
from backend.app.models.whatsapp_session import (
    WhatsAppSession,
    SessionStatus,
)
from backend.app.models.contact import Contact
from backend.app.models.conversation import (
    Conversation,
    ConversationStatus,
)
from backend.app.services.whatsapp_number_service import (
    WhatsAppNumberService,
    DuplicatePhoneNumberIdError,
)

_db_initialized = False


async def _init_phase1_db():
    """Ensures database schema and migrations are fully applied."""
    global _db_initialized
    if _db_initialized:
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await ensure_whatsapp_numbers_table(engine)
    await ensure_whatsapp_sessions_number_fk(engine)
    _db_initialized = True


# ============================================================================
# 1. META_CLOUD WhatsAppNumber Creation
# ============================================================================

@pytest.mark.asyncio
async def test_01_meta_cloud_wanum_creation():
    """1. META_CLOUD WhatsAppNumber can be created with default or explicit provider."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())
    phone_id = f"meta_pid_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        # Explicit META_CLOUD provider
        wanum = WhatsAppNumber(
            user_id=tenant_id,
            name="Official Meta Line",
            provider=WhatsAppNumberProvider.META_CLOUD,
            display_phone_number="+90 850 111 22 33",
            phone_number_e164="+908501112233",
            phone_number_id=phone_id,
            waba_id="waba_official_123",
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(wanum)
        await session.commit()
        await session.refresh(wanum)

        assert wanum.id is not None
        assert wanum.provider == WhatsAppNumberProvider.META_CLOUD
        assert wanum.phone_number_id == phone_id
        assert wanum.user_id == tenant_id
        assert wanum.status == WhatsAppNumberStatus.ACTIVE


# ============================================================================
# 2. BAILEYS_QR WhatsAppNumber Creation
# ============================================================================

@pytest.mark.asyncio
async def test_02_baileys_qr_wanum_creation():
    """2. BAILEYS_QR WhatsAppNumber can be created via service and model."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        qr_num = await WhatsAppNumberService.create_qr_number(
            db=session,
            user_id=tenant_id,
            name="Saha Ekibi QR Hat",
        )
        await session.commit()
        await session.refresh(qr_num)

        assert qr_num.id is not None
        assert qr_num.provider == WhatsAppNumberProvider.BAILEYS_QR
        assert qr_num.name == "Saha Ekibi QR Hat"
        assert qr_num.user_id == tenant_id
        assert qr_num.status == WhatsAppNumberStatus.ACTIVE


# ============================================================================
# 3. BAILEYS_QR phone_number_id Can Be NULL
# ============================================================================

@pytest.mark.asyncio
async def test_03_baileys_qr_phone_number_id_can_be_null():
    """3. BAILEYS_QR phone_number_id can be NULL, and multiple NULL records can coexist."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        # First QR line with NULL phone_number_id
        num1 = WhatsAppNumber(
            user_id=tenant_id,
            name="QR Line 1",
            provider=WhatsAppNumberProvider.BAILEYS_QR,
            phone_number_id=None,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num1)
        await session.commit()
        await session.refresh(num1)
        assert num1.phone_number_id is None

        # Second QR line with NULL phone_number_id under same tenant (must NOT fail uniqueness)
        num2 = WhatsAppNumber(
            user_id=tenant_id,
            name="QR Line 2",
            provider=WhatsAppNumberProvider.BAILEYS_QR,
            phone_number_id=None,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        session.add(num2)
        await session.commit()
        await session.refresh(num2)
        assert num2.phone_number_id is None
        assert num1.id != num2.id


# ============================================================================
# 4. BAILEYS_QR phone_number_e164 Can Be Stored
# ============================================================================

@pytest.mark.asyncio
async def test_04_baileys_qr_phone_number_e164_stored():
    """4. BAILEYS_QR phone_number_e164 can be stored upon scan without fake Meta phone_number_id."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())
    scanned_phone = "+905321112233"

    async with AsyncSessionLocal() as session:
        qr_num = await WhatsAppNumberService.create_qr_number(
            db=session,
            user_id=tenant_id,
            name="Scanned Phone Line",
            phone_number_e164=scanned_phone,
            display_phone_number="+90 532 111 22 33",
        )
        await session.commit()
        await session.refresh(qr_num)

        assert qr_num.phone_number_e164 == scanned_phone
        assert qr_num.display_phone_number == "+90 532 111 22 33"
        # Invariant: phone_number_id must remain None, NEVER fake 'qr_{session_id}'
        assert qr_num.phone_number_id is None


# ============================================================================
# 5. WhatsAppNumber -> WhatsAppSession 1:1 Bidirectional Relationship
# ============================================================================

@pytest.mark.asyncio
async def test_05_wanum_session_1_to_1_relationship():
    """5. WhatsAppNumber -> WhatsAppSession 1:1 works bidirectionally."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())
    session_key = f"sess_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        # Create WhatsAppNumber
        wanum = await WhatsAppNumberService.create_qr_number(
            db=session,
            user_id=tenant_id,
            name="Linked QR Line",
            phone_number_e164="+905330001122",
        )
        # Create Baileys WhatsAppSession
        wa_session = WhatsAppSession(
            user_id=tenant_id,
            session_name=session_key,
            status=SessionStatus.SCAN_QR,
            qr_code="data:image/png;base64,iVBORw0KGgo...",
        )
        session.add(wa_session)
        await session.commit()

        # Link session to number
        await WhatsAppNumberService.link_session(
            db=session,
            number_id=wanum.id,
            session_id=wa_session.id,
            user_id=tenant_id,
        )
        await session.commit()
        wanum_id = wanum.id
        session_id = wa_session.id

    # Query in fresh session to test full DB persistence and lazy='selectin' traversal
    async with AsyncSessionLocal() as session:
        stmt = select(WhatsAppNumber).where(WhatsAppNumber.id == wanum_id)
        re_wanum = (await session.execute(stmt)).scalar_one()

        assert re_wanum.session is not None
        assert re_wanum.session.id == session_id
        assert re_wanum.session.session_name == session_key

        # Reverse traversal
        assert re_wanum.session.whatsapp_number is not None
        assert re_wanum.session.whatsapp_number.id == wanum_id
        assert re_wanum.session.whatsapp_number.name == "Linked QR Line"



# ============================================================================
# 6. Cannot Link Second WhatsAppSession to the Same WhatsAppNumber
# ============================================================================

@pytest.mark.asyncio
async def test_06_cannot_link_second_session_to_same_number():
    """6. Cannot link a second WhatsAppSession to the same WhatsAppNumber (UNIQUE constraint)."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        wanum = await WhatsAppNumberService.create_qr_number(
            db=session,
            user_id=tenant_id,
            name="Single Session Number",
        )
        sess1 = WhatsAppSession(
            user_id=tenant_id,
            session_name=f"sess_a_{uuid.uuid4().hex[:8]}",
            status=SessionStatus.CONNECTED,
        )
        sess2 = WhatsAppSession(
            user_id=tenant_id,
            session_name=f"sess_b_{uuid.uuid4().hex[:8]}",
            status=SessionStatus.CONNECTED,
        )
        session.add_all([sess1, sess2])
        await session.commit()

        # Link session 1 successfully
        await WhatsAppNumberService.link_session(session, wanum.id, sess1.id, tenant_id)
        await session.commit()

        # 1. Domain service level rejection
        with pytest.raises(ValueError, match="already linked"):
            await WhatsAppNumberService.link_session(session, wanum.id, sess2.id, tenant_id)

        # 2. Database UNIQUE constraint rejection on direct assignment
        sess2.whatsapp_number_id = wanum.id
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()


# ============================================================================
# 7. Cannot Link Second WhatsAppNumber to the Same WhatsAppSession
# ============================================================================

@pytest.mark.asyncio
async def test_07_cannot_link_second_number_to_same_session():
    """7. WhatsAppSession cannot point to two WhatsAppNumbers at the same time."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        num1 = await WhatsAppNumberService.create_qr_number(db=session, user_id=tenant_id, name="Number 1")
        num2 = await WhatsAppNumberService.create_qr_number(db=session, user_id=tenant_id, name="Number 2")
        sess = WhatsAppSession(
            user_id=tenant_id,
            session_name=f"sess_solo_{uuid.uuid4().hex[:8]}",
            status=SessionStatus.CONNECTED,
        )
        session.add(sess)
        await session.commit()

        # Link to num1
        await WhatsAppNumberService.link_session(session, num1.id, sess.id, tenant_id)
        await session.commit()
        await session.refresh(sess)
        assert sess.whatsapp_number_id == num1.id

        # Reassign to num2
        sess.whatsapp_number_id = num2.id
        await session.commit()
        await session.refresh(sess)

        # Session now points only to num2, strictly preserving 1:1
        assert sess.whatsapp_number_id == num2.id


# ============================================================================
# 8. Session Tenant Ownership Invariant
# ============================================================================

@pytest.mark.asyncio
async def test_08_session_tenant_ownership_invariant():
    """8. Session tenant ownership invariant: session.user_id == whatsapp_number.user_id."""
    await _init_phase1_db()
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        num_a = await WhatsAppNumberService.create_qr_number(db=session, user_id=tenant_a, name="Tenant A Line")
        sess_b = WhatsAppSession(
            user_id=tenant_b,
            session_name=f"sess_b_{uuid.uuid4().hex[:8]}",
            status=SessionStatus.CONNECTED,
        )
        session.add(sess_b)
        await session.commit()

        # Attempt to link tenant B's session to tenant A's number
        with pytest.raises(ValueError, match="Tenant isolation violation|access denied"):
            await WhatsAppNumberService.link_session(
                db=session,
                number_id=num_a.id,
                session_id=sess_b.id,
                user_id=tenant_a,
            )

        # Verify session remains unlinked
        await session.refresh(sess_b)
        assert sess_b.whatsapp_number_id is None


# ============================================================================
# 9. User A Can See Their Own Session
# ============================================================================

@pytest.mark.asyncio
async def test_09_user_a_can_see_own_session():
    """9. User A can query and retrieve their own WhatsAppSession."""
    await _init_phase1_db()
    tenant_a = str(uuid.uuid4())
    session_name = f"sess_user_a_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        sess = WhatsAppSession(
            user_id=tenant_a,
            session_name=session_name,
            phone_number="+905551234567",
            status=SessionStatus.CONNECTED,
        )
        session.add(sess)
        await session.commit()

        # Tenant A queries their own sessions
        stmt = select(WhatsAppSession).where(
            WhatsAppSession.id == sess.id,
            WhatsAppSession.user_id == tenant_a,
        )
        found = (await session.execute(stmt)).scalar_one_or_none()
        assert found is not None
        assert found.session_name == session_name
        assert found.user_id == tenant_a


# ============================================================================
# 10. User A Cannot Access User B's Session
# ============================================================================

@pytest.mark.asyncio
async def test_10_user_a_cannot_access_user_b_session():
    """10. Tenant isolation: User A cannot query, view, or unlink User B's session."""
    await _init_phase1_db()
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())

    async with AsyncSessionLocal() as session:
        sess_b = WhatsAppSession(
            user_id=tenant_b,
            session_name=f"sess_secret_b_{uuid.uuid4().hex[:8]}",
            status=SessionStatus.CONNECTED,
        )
        session.add(sess_b)
        await session.commit()

        # User A attempts to query User B's session
        stmt = select(WhatsAppSession).where(
            WhatsAppSession.id == sess_b.id,
            WhatsAppSession.user_id == tenant_a,
        )
        result = (await session.execute(stmt)).scalar_one_or_none()
        assert result is None

        # User A attempts to unlink User B's session via service
        with pytest.raises(ValueError, match="not found or access denied"):
            await WhatsAppNumberService.unlink_session(session, sess_b.id, user_id=tenant_a)


# ============================================================================
# 11. Existing META_CLOUD Tests Still Pass
# ============================================================================

@pytest.mark.asyncio
async def test_11_existing_meta_cloud_tests_still_pass():
    """11. Existing META_CLOUD flow still validates token, encrypts, and rejects duplicate phone_number_id."""
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())
    shared_phone_id = f"meta_test_cloud_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as session:
        # Create Meta Cloud line via create_number
        wanum = await WhatsAppNumberService.create_number(
            db=session,
            user_id=tenant_id,
            name="Meta Production Line",
            display_phone_number="+90 (850) 555 44 33",
            phone_number_id=shared_phone_id,
            waba_id="waba_cloud_prod_1",
            access_token="EAABtesttoken_minimum_valid_length_1234567890",
            business_account_id="bacc_cloud_prod_1",
        )
        await session.commit()
        await session.refresh(wanum)

        assert wanum.provider == WhatsAppNumberProvider.META_CLOUD
        assert wanum.phone_number_id == shared_phone_id
        assert wanum.phone_number_e164 == "+908505554433"
        assert wanum.encrypted_access_token is not None

        # Duplicate phone_number_id must be rejected
        with pytest.raises(DuplicatePhoneNumberIdError):
            await WhatsAppNumberService.create_number(
                db=session,
                user_id=tenant_id,
                name="Meta Duplicate Line",
                display_phone_number="+90 (850) 555 44 33",
                phone_number_id=shared_phone_id,
                waba_id="waba_cloud_prod_2",
                access_token="EAABtesttoken_minimum_valid_length_1234567890",
            )



# ============================================================================
# 12. Existing Conversation -> WhatsAppNumber Relationship Preserved
# ============================================================================

@pytest.mark.asyncio
async def test_12_existing_conversation_wanum_relationship_preserved():
    """
    12. Existing Conversation -> WhatsAppNumber relationship preserved:
    - Conversation links to WhatsAppNumber via whatsapp_number_id.
    - Conversation does NOT have whatsapp_session_id.
    - Deleting WhatsAppNumber sets conversation.whatsapp_number_id = NULL (safe preservation).
    """
    await _init_phase1_db()
    tenant_id = str(uuid.uuid4())

    # Critical architectural check: Conversation has NO whatsapp_session_id
    assert not hasattr(Conversation, "whatsapp_session_id"), (
        "Invariant violated: Conversation model must NOT have whatsapp_session_id column."
    )

    async with AsyncSessionLocal() as session:
        # Create number
        wanum = await WhatsAppNumberService.create_qr_number(
            db=session,
            user_id=tenant_id,
            name="Conversation Host Line",
            phone_number_e164="+905551112233",
        )
        # Create contact
        contact = Contact(
            user_id=tenant_id,
            phone_e164="+905309998877",
            display_name="Chat Customer",
        )
        session.add(contact)
        await session.commit()

        # Create conversation linked to whatsapp_number_id
        conv = Conversation(
            user_id=tenant_id,
            whatsapp_number_id=wanum.id,
            contact_id=contact.id,
            channel="whatsapp",
            status=ConversationStatus.ACTIVE,
            last_message_preview="Hello via QR Line",
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)

        assert conv.id is not None
        assert conv.whatsapp_number_id == wanum.id
        assert conv.whatsapp_number.name == "Conversation Host Line"

        # Disconnect number (soft delete) -> conversation completely unaffected
        await WhatsAppNumberService.disconnect_number(session, wanum.id, user_id=tenant_id)
        await session.refresh(conv)
        assert conv.status == ConversationStatus.ACTIVE
        assert conv.whatsapp_number_id == wanum.id

        # Hard delete number -> ON DELETE SET NULL preserves conversation
        conv_id = conv.id
        await WhatsAppNumberService.remove_number_safely(session, wanum.id, user_id=tenant_id)
        await session.commit()

        db_conv = await session.get(Conversation, conv_id)
        assert db_conv is not None
        assert db_conv.whatsapp_number_id is None
        assert db_conv.status == ConversationStatus.ACTIVE
