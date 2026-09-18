"""Regression tests for the WhatsApp forensic audit fixes.

Each test pins ONE confirmed defect found during the audit so it cannot silently
regress. The tests intentionally assert the *contract* (what the system must do),
not the previous implementation.

Covered defects:
- H-1  history evidence is keyed by the GATEWAY session UUID, never the integer PK
- I-1  a stranger's push name is never written into `contact.display_name`
- I-3  `conversations_updated` carries the canonical REST conversation shape
- S-1  the relink notification actually reaches the UI (correct broadcast kwarg)
- C-1  `_upsert_contact` self-identity branch must not raise UnboundLocalError
- F-1  conversation status changes persist (truthfulness)
- safe_display_name agrees with `resolve_contact_identity` for push contacts
"""

import uuid as _uuid
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp.identity import (
    IdentityResolutionState,
    resolve_contact_identity,
    safe_display_name,
)
from backend.app.services.whatsapp.orchestration import events as events_mod
from backend.app.services.whatsapp.orchestration import sessions as sessions_mod
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
GW_ID = "gw-forensic-0001"
PHONE = "+905321112233"
PHONE_JID = "905321112233@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM messages WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text(
                    "DELETE FROM conversations WHERE user_id = :h AND channel = 'WHATSAPP'"
                ),
                {"h": TEST_USER_HEX},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id = :h"),
                {"h": TEST_USER_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def _seed_session_contact_conversation(gateway_id=GW_ID):
    """CONNECTED session + 1:1 contact + conversation; returns (session, contact, conv) ids."""
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=gateway_id,
            session_name="Forensic Hat",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()
        contact = Contact(user_id=TEST_USER, phone_e164=PHONE, display_name=None)
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
        )
        db.add(conv)
        await db.commit()
        return sess.id, contact.id, conv.id


# ---------------------------------------------------------------------------
# H-1 — history evidence must be keyed by the gateway session UUID
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_history_evidence_uses_gateway_session_uuid_not_integer_pk():
    """`history_sync_states.session_id` is a gateway UUID (TEXT FK). Reading it
    with `conv.session_id` (integer PK) silently missed every row, which killed
    the exhaustion short-circuit and forced `has_more=True` forever."""
    sess_id, contact_id, conv_id = await _seed_session_contact_conversation()

    captured_exhaustion: dict = {}
    captured_evidence: dict = {}

    async def _fake_exhausted(db, jid, session_id=None):
        captured_exhaustion["jid"] = jid
        captured_exhaustion["session_id"] = session_id
        return False

    async def _fake_evidence(db, jid, session_id=None):
        captured_evidence["jid"] = jid
        captured_evidence["session_id"] = session_id
        return {
            "state": "NOT_CHECKED",
            "provider_checked": False,
            "provider_exhausted": False,
            "provider_msgs_returned": 0,
            "has_more": True,
        }

    async with AsyncSessionLocal() as db:
        with patch.object(ws, "_hydrate_messages_on_demand", AsyncMock(return_value=[])), \
             patch.object(ws, "is_history_exhausted_or_stalled", _fake_exhausted), \
             patch.object(ws, "get_history_evidence", _fake_evidence):
            await ws.get_messages(db, TEST_USER, conv_id)

    assert captured_exhaustion["session_id"] == GW_ID, (
        "exhaustion check must use the gateway session UUID"
    )
    assert captured_evidence["session_id"] == GW_ID, (
        "evidence read must use the gateway session UUID"
    )
    assert str(sess_id) != GW_ID  # sanity: the integer PK is a different value


@pytest.mark.asyncio
async def test_history_evidence_skipped_when_no_session_resolvable():
    """Legacy rows without a resolvable gateway session must not read evidence
    under an unrelated key (fail-soft, no cross-session leak)."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=PHONE, display_name=None)
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=None,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.commit()
        conv_id = conv.id

    called = {"evidence": False}

    async def _fake_evidence(db, jid, session_id=None):
        called["evidence"] = True
        return {}

    async with AsyncSessionLocal() as db:
        with patch.object(ws, "_hydrate_messages_on_demand", AsyncMock(return_value=[])), \
             patch.object(ws, "get_history_evidence", _fake_evidence):
            await ws.get_messages(db, TEST_USER, conv_id)

    assert called["evidence"] is False


# ---------------------------------------------------------------------------
# I-1 / safe_display_name — push names never become a stranger's display name
# ---------------------------------------------------------------------------


def test_safe_display_name_never_returns_push_nickname_for_phone_contact():
    """A stranger's profile nickname must not surface as the display name when a
    phone number is resolvable (WhatsApp Web parity)."""
    contact = SimpleNamespace(
        display_name="Fikret Bircan",  # polluted row written by the old create path
        phone_e164=PHONE,
        custom_attributes={"name_source": "push", "push_name": "Fikret Bircan"},
    )
    assert safe_display_name(contact) == PHONE

    # And it must agree with the canonical REST resolver (single authority).
    name, state = resolve_contact_identity(contact=contact, phone=PHONE)
    assert name == PHONE
    assert state == IdentityResolutionState.RESOLVED_PHONE


def test_safe_display_name_keeps_push_name_for_unmapped_lid():
    """With no resolvable phone (unmapped LID) the push name is the agreed
    fallback — same rule as `resolve_contact_identity` step 4."""
    contact = SimpleNamespace(
        display_name=None,
        phone_e164="jid:12345678901234@lid",
        custom_attributes={"name_source": "push", "push_name": "Caner"},
    )
    assert safe_display_name(contact) == "Caner"


def test_safe_display_name_still_returns_addressbook_name():
    contact = SimpleNamespace(
        display_name="Mehmet Kirkar",
        phone_e164="+905324960912",
        custom_attributes={"name_source": "addressbook"},
    )
    assert safe_display_name(contact) == "Mehmet Kirkar"


@pytest.mark.asyncio
async def test_upsert_contact_create_never_writes_push_name_as_display_name():
    """`_upsert_contact`'s create branch used to write the raw push name into
    `display_name` — the bulk sync path and `set_contact_name` already refused."""
    orch = WhatsAppEventOrchestrator()
    async with AsyncSessionLocal() as db:
        contact = await orch._upsert_contact(
            db, TEST_USER, PHONE_JID, "Fikret Bircan", "push"
        )
        await db.commit()
        contact_id = contact.id

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(Contact).where(Contact.id == contact_id))
        ).scalar_one()
        assert row.display_name != "Fikret Bircan", (
            "a stranger's push name must never be persisted as display_name"
        )
        assert row.display_name == PHONE
        assert (row.custom_attributes or {}).get("push_name") == "Fikret Bircan"
        assert (row.custom_attributes or {}).get("name_source") == "push"


@pytest.mark.asyncio
async def test_upsert_contact_create_keeps_addressbook_name():
    orch = WhatsAppEventOrchestrator()
    async with AsyncSessionLocal() as db:
        contact = await orch._upsert_contact(
            db, TEST_USER, PHONE_JID, "Mehmet Kirkar", "addressbook"
        )
        await db.commit()
        contact_id = contact.id

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(Contact).where(Contact.id == contact_id))
        ).scalar_one()
        assert row.display_name == "Mehmet Kirkar"
        assert (row.custom_attributes or {}).get("name_source") == "addressbook"


@pytest.mark.asyncio
async def test_upsert_contact_self_identity_without_existing_self_contact():
    """C-1: matching the authenticated user's own identity while no self contact
    exists used to raise UnboundLocalError (event silently dropped)."""
    orch = WhatsAppEventOrchestrator()
    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=TEST_USER,
                gateway_id=str(_uuid.uuid4()),
                session_name="Self Hat",
                phone_number=PHONE,
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
        )
        await db.commit()

    async with AsyncSessionLocal() as db:
        # Must not raise; the self contact is created for the candidate JID.
        contact = await orch._upsert_contact(db, TEST_USER, PHONE_JID, None, None)
        await db.commit()
        assert contact is not None
        assert contact.phone_e164 == PHONE


# ---------------------------------------------------------------------------
# I-3 — `conversations_updated` carries the canonical REST shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_conversations_updated_payload_is_canonical_rest_shape():
    """The LID reconciliation payload used to emit `lead_phone`; the frontend
    mapper reads `phone`, so the merged row lost its name AND phone."""
    orch = WhatsAppEventOrchestrator()
    reconciled = SimpleNamespace(
        id=42,
        session_id=7,
        contact_id=9,
        lead_id=None,
        is_group=False,
        is_archived=False,
        last_message_preview="[IMAGE]",
        last_message_at=datetime(2026, 9, 18, 10, 0, 0),
        created_at=datetime(2026, 9, 18, 9, 0, 0),
        updated_at=datetime(2026, 9, 18, 10, 0, 0),
        unread_count=3,
        status=ConversationStatus.ACTIVE,
        contact=SimpleNamespace(
            display_name=None, phone_e164=PHONE, custom_attributes={}
        ),
    )

    async with AsyncSessionLocal() as db:
        with patch.object(
            orch, "reconcile_legacy_split_conversation", AsyncMock(return_value=reconciled)
        ), patch.object(
            events_mod, "_resolve_event_owner", AsyncMock(return_value=TEST_USER)
        ):
            event = await orch._ingest_lid_mapped(
                db,
                {"lid": "12345678901234@lid", "phone_jid": PHONE_JID},
            )

    assert event["event"] == "conversations_updated"
    payload = event["conversation"]
    # The canonical field names the frontend mapper actually reads:
    assert payload["phone"] == PHONE
    assert payload["identity_state"] == IdentityResolutionState.RESOLVED_PHONE
    # `name` mirrors REST `list_conversations`: for RESOLVED_PHONE the resolved
    # label IS the normalized phone (the frontend's isRealContactName() rejects
    # it and renders the formatted phone).
    assert payload["name"] == PHONE
    assert payload["is_group"] is False
    assert payload["unread_count"] == 3
    assert payload["status"] == "ACTIVE"
    # The non-canonical alias must be gone.
    assert "lead_phone" not in payload


# ---------------------------------------------------------------------------
# S-1 — the relink notification must reach the UI
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_relink_notification_broadcasts_with_target_user_id():
    """`ws_manager.broadcast(message, target_user_id=...)` — the old call passed
    `tenant_id=`, raising TypeError that was swallowed, so the UI was never told
    a relink was required."""
    from backend.app.services.whatsapp.exceptions import WhatsAppRelinkRequired

    row = WhatsAppSession(
        user_id=TEST_USER,
        gateway_id="gw-relink-x",
        session_name="Relink Hat",
        phone_number=PHONE,
        status=SessionStatus.CONNECTED,
        is_active=True,
    )

    async def _op(_gw_id):
        raise sessions_mod.gw.WhatsAppGatewayError("session not found")

    broadcast_mock = AsyncMock(return_value=1)

    async with AsyncSessionLocal() as db:
        db.add(row)
        await db.commit()
        with patch.object(
            sessions_mod, "is_gateway_session_missing", return_value=True
        ), patch.object(sessions_mod.ws_manager, "broadcast", broadcast_mock):
            with pytest.raises(WhatsAppRelinkRequired):
                await sessions_mod._gateway_op_or_mark_relink(db, row, _op)

    assert broadcast_mock.await_count == 1, (
        "the relink notification must actually be broadcast"
    )
    kwargs = broadcast_mock.await_args.kwargs
    assert kwargs.get("target_user_id") == TEST_USER
    assert "tenant_id" not in kwargs
    payload = broadcast_mock.await_args.args[0]
    assert payload["event"] == "session_updated"
    assert payload["user_id"] == TEST_USER
    assert payload["session"]["status"] == SessionStatus.RELINK_REQUIRED.value


# ---------------------------------------------------------------------------
# F-1 — conversation status changes persist (no false success)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_conversation_status_persists_and_broadcasts():
    _sess_id, _contact_id, conv_id = await _seed_session_contact_conversation()

    broadcast_mock = AsyncMock(return_value=1)
    async with AsyncSessionLocal() as db:
        from backend.app.api.v1 import websocket as websocket_mod

        with patch.object(websocket_mod.ws_manager, "broadcast", broadcast_mock):
            result = await ws.update_conversation_status(
                db, TEST_USER, conv_id, "ARCHIVED"
            )

    assert result == {"id": conv_id, "status": "ARCHIVED"}

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(Conversation).where(Conversation.id == conv_id))
        ).scalar_one()
        assert row.status == ConversationStatus.ARCHIVED
        assert row.archived_at is not None

    assert broadcast_mock.await_count == 1
    assert broadcast_mock.await_args.args[0]["event"] == "conversation_status_updated"
    assert broadcast_mock.await_args.kwargs.get("target_user_id") == TEST_USER


@pytest.mark.asyncio
async def test_update_conversation_status_rejects_invalid_value():
    _sess_id, _contact_id, conv_id = await _seed_session_contact_conversation()
    async with AsyncSessionLocal() as db:
        with pytest.raises(ValueError):
            await ws.update_conversation_status(db, TEST_USER, conv_id, "NOT_A_STATUS")


@pytest.mark.asyncio
async def test_update_conversation_status_is_idempotent():
    _sess_id, _contact_id, conv_id = await _seed_session_contact_conversation()
    async with AsyncSessionLocal() as db:
        await ws.update_conversation_status(db, TEST_USER, conv_id, "CLOSED")
        second = await ws.update_conversation_status(db, TEST_USER, conv_id, "CLOSED")
    assert second["status"] == "CLOSED"
