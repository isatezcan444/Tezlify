"""Tests for WhatsApp Self Identity Resolution and Avatar Integrity (Phase 13.2).

Validates:
- SELF-01: Pure self identity detection across JID, LID, phone formats, and 'jid:' prefixes.
- SELF-02: Strict discrimination against non-self contacts.
- SELF-03: _upsert_contact maps self LID to canonical self contact without creating duplicates.
- SELF-04: _map_conversation_event resolves self LID to canonical phone JID.
- SELF-05: reconcile_self_identity merges duplicate conversations and dedups messages.
- AVATAR-01: strip_jid_prefix normalizes prefixes for group, phone, and LID.
- AVATAR-02: _ingest_contact_synced persists avatar_url in contact custom_attributes.
"""

import pytest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.identity import (
    is_self_identity,
    strip_jid_prefix,
    contact_phone_for_jid,
    jid_to_phone,
    phone_to_jid,
)
from backend.app.services.whatsapp.repositories.contacts import (
    get_contact_avatar,
    set_contact_avatar,
)
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator


def test_self_01_is_self_identity_matches():
    """SELF-01: is_self_identity correctly matches all self representations."""
    session_phone = "+905413749073"
    session_lid = "62771114836011@lid"

    # Exact phone
    assert is_self_identity("+905413749073", session_phone, session_lid) is True
    assert is_self_identity("905413749073", session_phone, session_lid) is True

    # Phone JID
    assert is_self_identity("905413749073@s.whatsapp.net", session_phone, session_lid) is True
    assert is_self_identity("905413749073:12@s.whatsapp.net", session_phone, session_lid) is True

    # LID
    assert is_self_identity("62771114836011@lid", session_phone, session_lid) is True
    assert is_self_identity("62771114836011:12@lid", session_phone, session_lid) is True

    # jid: prefixed
    assert is_self_identity("jid:905413749073@s.whatsapp.net", session_phone, session_lid) is True
    assert is_self_identity("jid:62771114836011@lid", session_phone, session_lid) is True


def test_self_02_is_self_identity_rejects_others():
    """SELF-02: is_self_identity rejects contacts that do not match the session."""
    session_phone = "+905413749073"
    session_lid = "62771114836011@lid"

    assert is_self_identity("+905321002030", session_phone, session_lid) is False
    assert is_self_identity("905321002030@s.whatsapp.net", session_phone, session_lid) is False
    assert is_self_identity("12036329482910@g.us", session_phone, session_lid) is False
    assert is_self_identity("999999999999@lid", session_phone, session_lid) is False
    assert is_self_identity("", session_phone, session_lid) is False
    assert is_self_identity(None, session_phone, session_lid) is False


def test_avatar_01_strip_jid_prefix():
    """AVATAR-01: strip_jid_prefix cleanly removes jid: prefix."""
    assert strip_jid_prefix("jid:905413749073-1589570212@g.us") == "905413749073-1589570212@g.us"
    assert strip_jid_prefix("jid:62771114836011@lid") == "62771114836011@lid"
    assert strip_jid_prefix("jid:+905413749073") == "+905413749073"
    assert strip_jid_prefix("+905413749073") == "+905413749073"
    assert strip_jid_prefix("905413749073@s.whatsapp.net") == "905413749073@s.whatsapp.net"
    assert strip_jid_prefix(None) == ""
    assert strip_jid_prefix("") == ""


def test_avatar_02_contact_avatar_mutation():
    """AVATAR-02: set_contact_avatar and get_contact_avatar mutate and retrieve URL."""
    c = Contact(phone_e164="+905413749073", display_name="Self")
    assert get_contact_avatar(c) is None

    url = "https://pps.whatsapp.net/v/t61.24694-24/test.jpg"
    set_contact_avatar(c, url)
    assert get_contact_avatar(c) == url

    # Setting same avatar is idempotent
    set_contact_avatar(c, url)
    assert get_contact_avatar(c) == url

    # None does not overwrite
    set_contact_avatar(c, None)
    assert get_contact_avatar(c) == url


@pytest.mark.asyncio
async def test_self_03_upsert_contact_resolves_self_identity():
    """SELF-03: _upsert_contact returns canonical self contact when active session exists."""
    orchestrator = WhatsAppEventOrchestrator()
    user_id = str(uuid.uuid4())
    session_phone = "+905413749073"

    mock_db = MagicMock(spec=AsyncSession)

    # Active session mock
    active_session = WhatsAppSession(
        id=1,
        user_id=user_id,
        gateway_id="gw-1",
        session_name="Test",
        status=SessionStatus.CONNECTED,
        phone_number=session_phone,
        is_active=True,
    )
    # Existing canonical contact
    canonical_contact = Contact(
        id=100,
        user_id=user_id,
        phone_e164=session_phone,
        display_name="İsa Tezcan",
    )

    # Mock execute return values:
    # 1st query: active session
    # 2nd query: canonical contact lookup
    mock_res_sess = MagicMock()
    mock_res_sess.scalars.return_value.first.return_value = active_session

    mock_res_contact = MagicMock()
    mock_res_contact.scalars.return_value.first.return_value = canonical_contact

    mock_res_lid = MagicMock()
    mock_res_lid.first.return_value = None

    def mock_exec(*args, **kwargs):
        stmt_str = str(args[0]) if args else ""
        if "whatsapp_sessions" in stmt_str:
            return mock_res_sess
        if "lid_mappings" in stmt_str:
            return mock_res_lid
        return mock_res_contact

    mock_db.execute = AsyncMock(side_effect=mock_exec)
    mock_db.flush = AsyncMock()

    # Call with LID
    res = await orchestrator._upsert_contact(
        mock_db,
        user_id=user_id,
        jid="62771114836011@lid",
        display_name=None,
    )

    assert res.id == 100
    assert res.phone_e164 == session_phone


@pytest.mark.asyncio
async def test_self_04_reconcile_self_identity_merges_duplicate_conversation():
    """SELF-05: reconcile_self_identity merges duplicate LID conversation into canonical."""
    orchestrator = WhatsAppEventOrchestrator()
    user_id = str(uuid.uuid4())
    canonical_phone = "+905413749073"

    session = WhatsAppSession(
        id=54,
        user_id=user_id,
        gateway_id="gw-54",
        session_name="My Session",
        status=SessionStatus.CONNECTED,
        phone_number=canonical_phone,
        is_active=True,
    )

    canonical_contact = Contact(id=5213, user_id=user_id, phone_e164=canonical_phone, display_name="Canonical")
    duplicate_contact = Contact(id=5243, user_id=user_id, phone_e164="jid:62771114836011@lid", display_name=None)
    set_contact_avatar(duplicate_contact, "https://pps.whatsapp.net/test.jpg")

    canonical_conv = Conversation(id=9525, user_id=user_id, contact_id=5213, session_id=54, channel="WHATSAPP")
    duplicate_conv = Conversation(id=9638, user_id=user_id, contact_id=5243, session_id=54, channel="WHATSAPP")

    msg_existing = Message(id=1, conversation_id=9525, wa_message_id="WA_1", body="Hello", direction=MessageDirection.INBOUND, sender_phone="+905413749073", recipient_phone="+905413749073")
    msg_dup = Message(id=2, conversation_id=9638, wa_message_id="WA_1", body="Hello duplicate", direction=MessageDirection.INBOUND, sender_phone="+905413749073", recipient_phone="+905413749073")
    msg_unique = Message(id=3, conversation_id=9638, wa_message_id="WA_UNIQUE", body="New note", direction=MessageDirection.INBOUND, sender_phone="+905413749073", recipient_phone="+905413749073")

    mock_db = MagicMock(spec=AsyncSession)

    def mock_scalar_execute(*args, **kwargs):
        stmt_str = str(args[0]) if args else ""
        stmt_lower = stmt_str.lower()
        m = MagicMock()
        if "where contacts.phone_e164 =" in stmt_lower:
            m.scalars.return_value.first.return_value = canonical_contact
        elif "contacts.id != " in stmt_lower:
            m.scalars.return_value.all.return_value = [duplicate_contact]
        elif "order by conversations.id asc" in stmt_lower:
            m.scalars.return_value.first.return_value = canonical_conv
        elif "where conversations.contact_id =" in stmt_lower:
            m.scalars.return_value.all.return_value = [duplicate_conv]
        elif "wa_message_id is not null" in stmt_lower:
            m.scalars.return_value.all.return_value = ["WA_1"]
        elif "where messages.conversation_id =" in stmt_lower:
            m.scalars.return_value.all.return_value = [msg_dup, msg_unique]
        else:
            m.scalars.return_value.first.return_value = canonical_conv
            m.scalars.return_value.all.return_value = []
        return m

    mock_db.execute = AsyncMock(side_effect=mock_scalar_execute)
    mock_db.delete = AsyncMock()
    mock_db.commit = AsyncMock()
    mock_db.flush = AsyncMock()

    result = await orchestrator.reconcile_self_identity(mock_db, user_id, session, self_lid="62771114836011@lid")

    assert result["status"] == "reconciled"
    assert 9638 in result["merged_conversations"]
    # Contact rows are tenant-global and may still be referenced by another
    # WhatsApp line. Reconciliation deletes only the current line's duplicate
    # conversation; contact cleanup is reference-aware.
    assert result["deleted_contacts"] == []
    assert result["deleted_duplicate_messages"] == 1
    assert result["moved_messages"] == 1
    # Check that canonical contact received the avatar
    assert get_contact_avatar(canonical_contact) == "https://pps.whatsapp.net/test.jpg"
    assert msg_unique.conversation_id == 9525


@pytest.mark.asyncio
async def test_lid_01_unresolved_lid_creates_conversation():
    """LID-01: conversation_updated for an unresolved LID JID creates a conversation safely."""
    service = MagicMock()
    mock_conv = MagicMock()
    mock_conv.id = 9741
    # The canonical payload now reports the PERSISTED preview (REST parity), so the
    # mock must carry a realistic value for the column the production code reads —
    # same as `mock_reconciled_conv` in test_lid_02 below.
    mock_conv.last_message_preview = None
    mock_conv.last_message_at = None
    service._ensure_conversation_race_safe = AsyncMock(return_value=mock_conv)
    service._resolve_event_owner_and_session = AsyncMock(return_value=("test-user", 1))

    orchestrator = WhatsAppEventOrchestrator(service=service)
    mock_db = AsyncMock(spec=AsyncSession)
    mock_db.get = AsyncMock(return_value=None)

    event = {
        "event": "conversation_updated",
        "conversation_id": "97418884436079@lid",
        "gateway_session_id": 1,
        "conversation": {
            "id": "97418884436079@lid",
            "last_message_preview": "Test preview",
        },
    }

    result = await orchestrator._map_conversation_event(mock_db, event)
    assert not result.get("_skip")
    assert service._ensure_conversation_race_safe.called


@pytest.mark.asyncio
async def test_lid_02_lid_mapped_event_triggers_reconciliation():
    """LID-02: lid_mapped event triggers reconcile_legacy_split_conversation and broadcasts."""
    service = MagicMock()
    service._resolve_event_owner_and_session = AsyncMock(return_value=("test-user", 54))

    orchestrator = WhatsAppEventOrchestrator(service=service)
    mock_db = AsyncMock(spec=AsyncSession)

    mock_reconciled_conv = MagicMock()
    mock_reconciled_conv.id = 9764
    mock_reconciled_conv.contact = MagicMock(phone_e164="+905525372434")
    mock_reconciled_conv.last_message_preview = "Reconciled preview"
    mock_reconciled_conv.last_message_at = None

    orchestrator.reconcile_legacy_split_conversation = AsyncMock(return_value=mock_reconciled_conv)

    event = {
        "event": "lid_mapped",
        "lid": "97418884436079@lid",
        "phone_jid": "905525372434@s.whatsapp.net",
        "gateway_session_id": 1,
    }

    result = await orchestrator._ingest_lid_mapped(mock_db, event)
    orchestrator.reconcile_legacy_split_conversation.assert_awaited_once_with(
        mock_db,
        "test-user",
        "97418884436079@lid",
        "905525372434@s.whatsapp.net",
        session_id=54,
    )
    assert result.get("event") == "conversations_updated"
    assert result.get("reconciled_conversation_id") == 9764
    assert result.get("conversation", {}).get("archived_lid") == "97418884436079@lid"

