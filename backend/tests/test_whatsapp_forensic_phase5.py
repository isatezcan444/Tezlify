"""Phase 5 — runtime forensic hardening: behavioral invariant tests.

These tests exercise the REAL ingest / persistence path against the real
SQLite schema (no repository mocks) so the assertions describe production
behaviour, not a mock's behaviour. Each test encodes one invariant from the
Phase 5 directive and is written to FAIL before a fix and PASS after.

Invariants under test
---------------------
§3  same conversation + same wa_message_id  => at most ONE persisted message
§3  PENDING -> SENT -> DELIVERED -> READ never moves backwards
§5  a newer realtime state is never overwritten by an older snapshot
§5  ordering depends on activity time, never on identity-resolution
§10 metadata arrival never downgrades the latest preview / ordering
§11 a failed provider mark-read is never reported as a successful read
§13 concurrent first-contact ingestion yields ONE conversation
§15 a partial `conversation_updated` event never destroys known state
"""

import asyncio
import io
import pathlib
import uuid
from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp_service import ingest_gateway_event

# A tenant that no other test file touches, so the assertions cannot be
# perturbed by a neighbour's leftovers.
P5_USER = "abcd1234-0000-0000-0000-00000000abcd"
P5_USER_HEX = "abcd123400000000000000000000abcd"
P5_GW = "gw-p5-forensic"
P5_PHONE = "+905550000101"
P5_JID = "905550000101@s.whatsapp.net"
P5_PHONE_2 = "+905550000202"
P5_JID_2 = "905550000202@s.whatsapp.net"
P5_GROUP_JID = "120363111111111111@g.us"


async def _wipe() -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM messages WHERE user_id IN (:h, :s)"),
            {"h": P5_USER_HEX, "s": P5_USER},
        )
        await db.execute(
            text("DELETE FROM conversations WHERE user_id IN (:h, :s)"),
            {"h": P5_USER_HEX, "s": P5_USER},
        )
        await db.execute(
            text("DELETE FROM contacts WHERE user_id IN (:h, :s)"),
            {"h": P5_USER_HEX, "s": P5_USER},
        )
        await db.execute(
            text("DELETE FROM whatsapp_sessions WHERE user_id IN (:h, :s)"),
            {"h": P5_USER_HEX, "s": P5_USER},
        )
        await db.commit()


@pytest_asyncio.fixture(autouse=True)
async def _ensure_conversation_line_uniqueness():
    """Install the same-line conversation uniqueness on the shared test DB.

    `Conversation.__table_args__` declares
    `uq_conv_user_session_contact_channel`, but `create_all` never alters an
    existing table, so the constraint only reaches the database through the
    startup migration `ensure_conversations_columns`. Production runs that
    migration at boot; this fixture mirrors it so the DB-level backstop is
    actually present while the race assertions below run.

    NOTE (Phase 5): this used to call a dedicated C-5 migration added in this
    phase. That migration was removed again — it duplicated
    `ensure_conversations_columns`, which already creates the very same index
    (verified present in production, 2026-09-19 read-only query).
    """
    from backend.app.core.database import engine as app_engine
    from backend.app.core.migrations import ensure_conversations_columns

    await ensure_conversations_columns(app_engine)
    yield


@pytest_asyncio.fixture(autouse=True)
async def _isolated_tenant():
    await _wipe()
    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=P5_USER,
                gateway_id=P5_GW,
                session_name="P5 Hat",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
        )
        await db.commit()
    yield
    await _wipe()


async def _seed_conversation(
    jid: str = P5_JID,
    phone: str = P5_PHONE,
    *,
    unread_count: int = 0,
    is_group: bool = False,
    display_name: str = "P5 Lead",
) -> int:
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=P5_USER, phone_e164=phone, display_name=display_name)
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=P5_USER,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=unread_count,
            is_group=is_group,
        )
        db.add(conv)
        await db.flush()
        conv_id = conv.id
        await db.commit()
    return conv_id


def _message_new(
    wa_id: str,
    *,
    jid: str = P5_JID,
    client_id: str | None = None,
    status: str | None = None,
    direction: str = "INBOUND",
    body: str = "merhaba",
    created_at: str | None = None,
    event_id: str | None = None,
) -> dict:
    msg = {
        "conversation_id": jid,
        "wa_message_id": wa_id,
        "direction": direction,
        "message_type": "TEXT",
        "body": body,
        "created_at": created_at or "2026-09-18T10:00:00.000Z",
    }
    if client_id:
        msg["client_message_id"] = client_id
    if status:
        msg["status"] = status
    return {
        "event": "message_new",
        "event_id": event_id or str(uuid.uuid4()),
        "gateway_session_id": P5_GW,
        "message": msg,
    }


async def _count_messages(conv_id: int, wa_id: str | None = None) -> int:
    async with AsyncSessionLocal() as db:
        stmt = select(func.count()).select_from(Message).where(
            Message.conversation_id == conv_id
        )
        if wa_id is not None:
            stmt = stmt.where(Message.wa_message_id == wa_id)
        return int((await db.execute(stmt)).scalar_one())


async def _get_message(conv_id: int, wa_id: str) -> Message | None:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conv_id,
                    Message.wa_message_id == wa_id,
                )
            )
        ).scalars().first()


async def _get_conversation(conv_id: int) -> Conversation | None:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(Conversation).where(Conversation.id == conv_id))
        ).scalars().first()


async def _count_conversations() -> int:
    async with AsyncSessionLocal() as db:
        return int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(Conversation)
                    .where(Conversation.user_id == P5_USER)
                )
            ).scalar_one()
        )


# ===========================================================================
# §3 — duplicate inbound / outbound echo must not create a second message
# ===========================================================================


@pytest.mark.asyncio
async def test_p5_duplicate_message_new_with_distinct_event_ids_is_deduplicated():
    """Two `message_new` events carrying the SAME wa_message_id but DIFFERENT
    event_ids (provider replay, reconnect race) must leave exactly one row.

    The `processed_events` idempotency table cannot help here: the two events
    are genuinely different events. Dedup must come from the message identity.
    """
    conv_id = await _seed_conversation()

    await ingest_gateway_event(_message_new("W-DUP-1"))
    await ingest_gateway_event(_message_new("W-DUP-1"))

    assert await _count_messages(conv_id, "W-DUP-1") == 1


@pytest.mark.asyncio
async def test_p5_concurrent_duplicate_message_new_is_deduplicated():
    """The dedup lookup is SELECT-then-INSERT. Under concurrency both callers
    can observe 'no row yet'. The C-4 partial unique index must still collapse
    them into ONE persisted message (and the loser must not crash the ingest).
    """
    conv_id = await _seed_conversation()

    await asyncio.gather(
        ingest_gateway_event(_message_new("W-RACE-1")),
        ingest_gateway_event(_message_new("W-RACE-1")),
        return_exceptions=True,
    )

    assert await _count_messages(conv_id, "W-RACE-1") == 1


@pytest.mark.asyncio
async def test_p5_concurrent_first_contact_ingest_yields_one_conversation():
    """§13 — two concurrent first-messages for the same brand-new JID must not
    create two conversations for one counterparty."""
    await asyncio.gather(
        ingest_gateway_event(_message_new("W-NEW-1", body="bir")),
        ingest_gateway_event(_message_new("W-NEW-2", body="iki")),
        return_exceptions=True,
    )

    assert await _count_conversations() == 1


# ===========================================================================
# §3 — outbound lifecycle: status must never move backwards
# ===========================================================================


async def _seed_optimistic_outbound(client_id: str) -> int:
    """Mirrors `send_text_message`: the optimistic row is committed PENDING
    with a client_message_id and NO wa_message_id."""
    conv_id = await _seed_conversation()
    async with AsyncSessionLocal() as db:
        db.add(
            Message(
                user_id=P5_USER,
                conversation_id=conv_id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="gonderildi",
                wa_message_id=None,
                client_message_id=client_id,
                sender_phone="ME",
                recipient_phone=P5_PHONE,
                status=ConversationMessageStatus.PENDING,
                external_timestamp=datetime(2026, 9, 18, 10, 0, 0),
            )
        )
        await db.commit()
    return conv_id


@pytest.mark.asyncio
async def test_p5_outbound_echo_reconciles_optimistic_row_not_a_new_one():
    """The provider echo (wa_message_id + client_message_id) must ATTACH to the
    optimistic PENDING row — not insert a second message for one send."""
    client_id = str(uuid.uuid4())
    conv_id = await _seed_optimistic_outbound(client_id)

    await ingest_gateway_event(
        _message_new(
            "W-OUT-1",
            client_id=client_id,
            direction="OUTBOUND",
            status="SENT",
            body="gonderildi",
        )
    )

    assert await _count_messages(conv_id) == 1
    row = await _get_message(conv_id, "W-OUT-1")
    assert row is not None
    assert row.client_message_id == client_id
    assert row.status == ConversationMessageStatus.SENT


@pytest.mark.asyncio
async def test_p5_status_never_downgrades_after_read():
    """PENDING -> SENT -> DELIVERED -> READ, then a late duplicate SENT /
    DELIVERED echo must not pull the status back down."""
    client_id = str(uuid.uuid4())
    conv_id = await _seed_optimistic_outbound(client_id)

    await ingest_gateway_event(
        _message_new("W-ACK-1", client_id=client_id, direction="OUTBOUND", status="SENT")
    )
    for status in ("DELIVERED", "READ"):
        await ingest_gateway_event(
            {
                "event": "message_status_updated",
                "event_id": str(uuid.uuid4()),
                "gateway_session_id": P5_GW,
                "conversation_id": P5_JID,
                "wa_message_id": "W-ACK-1",
                "client_message_id": client_id,
                "status": status,
            }
        )
    # Late / out-of-order duplicates:
    for status in ("SENT", "DELIVERED", "SENT"):
        await ingest_gateway_event(
            {
                "event": "message_status_updated",
                "event_id": str(uuid.uuid4()),
                "gateway_session_id": P5_GW,
                "conversation_id": P5_JID,
                "wa_message_id": "W-ACK-1",
                "client_message_id": client_id,
                "status": status,
            }
        )

    row = await _get_message(conv_id, "W-ACK-1")
    assert row is not None
    assert row.status == ConversationMessageStatus.READ


@pytest.mark.asyncio
async def test_p5_failed_outbound_is_not_downgraded_by_late_pending_echo():
    """FAILED and PENDING share rank 0 (`DELIVERY_STATUS_RANKS`), so a late
    out-of-order PENDING echo must not pull a FAILED message back.

    FAILED -> SENT is deliberately ALLOWED: a transient send failure followed
    by a real provider ACK is genuine evidence of delivery, and the gateway
    applies the same transition in `_applyMessageAck`. That is recovery, not a
    downgrade, so this test pins the boundary rather than forbidding it.
    """
    client_id = str(uuid.uuid4())
    conv_id = await _seed_optimistic_outbound(client_id)

    await ingest_gateway_event(
        _message_new("W-FAIL-1", client_id=client_id, direction="OUTBOUND", status="PENDING")
    )
    await ingest_gateway_event(
        {
            "event": "message_status_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "wa_message_id": "W-FAIL-1",
            "client_message_id": client_id,
            "status": "FAILED",
            "error_message": "media upload rejected",
        }
    )
    row = await _get_message(conv_id, "W-FAIL-1")
    assert row.status == ConversationMessageStatus.FAILED
    assert row.failed_at is not None

    # Late / out-of-order PENDING echo: must not resurrect or erase the failure.
    await ingest_gateway_event(
        {
            "event": "message_status_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "wa_message_id": "W-FAIL-1",
            "client_message_id": client_id,
            "status": "PENDING",
        }
    )
    # A duplicate FAILED echo must also stay FAILED (no double-counting).
    await ingest_gateway_event(
        {
            "event": "message_status_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "wa_message_id": "W-FAIL-1",
            "client_message_id": client_id,
            "status": "FAILED",
        }
    )

    row = await _get_message(conv_id, "W-FAIL-1")
    assert row.status == ConversationMessageStatus.FAILED, (
        "a FAILED outbound message was erased by a late PENDING echo"
    )


@pytest.mark.asyncio
async def test_p5_sent_is_not_downgraded_by_late_failed_echo():
    """The mirror case: a real delivery must not be undone by a late FAILED
    echo for the same wa_message_id."""
    client_id = str(uuid.uuid4())
    conv_id = await _seed_optimistic_outbound(client_id)

    await ingest_gateway_event(
        _message_new("W-FAIL-2", client_id=client_id, direction="OUTBOUND", status="SENT")
    )
    await ingest_gateway_event(
        {
            "event": "message_status_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "wa_message_id": "W-FAIL-2",
            "client_message_id": client_id,
            "status": "FAILED",
            "error_message": "late failure echo",
        }
    )

    row = await _get_message(conv_id, "W-FAIL-2")
    assert row.status == ConversationMessageStatus.SENT


# ===========================================================================
# §3/§11 — an early provider ACK must not be discarded
# ===========================================================================


@pytest.mark.asyncio
async def test_p5_early_provider_ack_is_deferred_and_applied_when_record_lands():
    """The provider can ACK a message BEFORE its `message_new` upsert arrives.

    Production log: hundreds of
        ERROR Gateway olayi islenemedi, yayinlanmadi (event=message_status_updated):
        Provider ACK precedes its message record; retry required
    Nothing retried — the LookupError made the dispatcher drop the ACK for good,
    so every early receipt was lost and the thread kept its stale status.

    The ACK must be buffered instead, and applied the moment the record exists.
    """
    client_id = str(uuid.uuid4())
    conv_id = await _seed_conversation()

    ack = {
        "event": "message_status_updated",
        "event_id": str(uuid.uuid4()),
        "gateway_session_id": P5_GW,
        "conversation_id": P5_JID,
        "wa_message_id": "W-EARLY-1",
        "client_message_id": client_id,
        "status": "DELIVERED",
    }
    # The early ACK is buffered, not broadcast, and must not raise.
    assert await ingest_gateway_event(dict(ack)) is None

    # There is still no record: the ACK cannot fabricate a message.
    assert await _get_message(conv_id, "W-EARLY-1") is None

    result = await ingest_gateway_event(
        _message_new(
            "W-EARLY-1",
            client_id=client_id,
            direction="OUTBOUND",
            status="PENDING",
            body="erken ack",
        )
    )

    row = await _get_message(conv_id, "W-EARLY-1")
    assert row is not None
    assert row.status == ConversationMessageStatus.DELIVERED, (
        "the deferred provider ACK was not applied to the message record"
    )
    # The broadcast must carry the true status, so the UI never shows a stale
    # tick for a message the provider has already delivered.
    assert result is not None
    assert result["message"]["status"] == "DELIVERED"


@pytest.mark.asyncio
async def test_p5_early_ack_survives_identity_only_on_one_side():
    """The ACK may carry only the wa id while the record carries both, or vice
    versa. Buffering is keyed by EVERY identity the ACK carries, so either
    match consumes it exactly once."""
    client_id = str(uuid.uuid4())
    conv_id = await _seed_conversation()

    await ingest_gateway_event({
        "event": "message_status_updated",
        "event_id": str(uuid.uuid4()),
        "gateway_session_id": P5_GW,
        "conversation_id": P5_JID,
        "wa_message_id": "W-EARLY-2",
        "status": "READ",
    })

    await ingest_gateway_event(
        _message_new(
            "W-EARLY-2",
            client_id=client_id,
            direction="OUTBOUND",
            status="SENT",
            body="tek kimlik",
        )
    )

    row = await _get_message(conv_id, "W-EARLY-2")
    assert row is not None
    assert row.status == ConversationMessageStatus.READ


@pytest.mark.asyncio
async def test_p5_early_ack_with_no_matching_record_is_harmless():
    """An ACK whose record never arrives must not crash, create a row, or leak
    into an unrelated message."""
    conv_id = await _seed_conversation()

    await ingest_gateway_event({
        "event": "message_status_updated",
        "event_id": str(uuid.uuid4()),
        "gateway_session_id": P5_GW,
        "conversation_id": P5_JID,
        "wa_message_id": "W-NEVER-ARRIVES",
        "status": "READ",
    })

    await ingest_gateway_event(
        _message_new("W-OTHER-1", direction="OUTBOUND", status="SENT", body="baska")
    )

    assert await _count_messages(conv_id) == 1
    row = await _get_message(conv_id, "W-OTHER-1")
    assert row is not None
    assert row.status == ConversationMessageStatus.SENT, (
        "an unmatched deferred ACK leaked onto another message"
    )


@pytest.mark.asyncio
async def test_p5_ingest_never_replaces_a_known_provider_wa_id():
    """The gateway records an outbound send under a deterministic pre-send id and
    can echo that record after the provider id is confirmed. The dedup path used
    to assign unconditionally (`wa_id or current`), so a stale echo overwrote
    the real id — every later dedup/ACK lookup for that message then missed it
    and a second row could be created.

    A known provider id is evidence and must never be replaced by a different
    one; an unknown id is still filled in normally.
    """
    client_id = str(uuid.uuid4())
    conv_id = await _seed_conversation()

    await ingest_gateway_event(
        _message_new(
            "W-REAL-1",
            client_id=client_id,
            direction="OUTBOUND",
            status="SENT",
            body="gercek",
        )
    )
    # Stale echo for the same client id carrying a different (pre-send) id.
    await ingest_gateway_event(
        _message_new(
            "W-SYNTHETIC-1",
            client_id=client_id,
            direction="OUTBOUND",
            status="PENDING",
            body="gercek",
        )
    )

    assert await _count_messages(conv_id) == 1
    row = await _get_message(conv_id, "W-REAL-1")
    assert row is not None, "the real provider id was overwritten by a stale echo"
    assert row.wa_message_id == "W-REAL-1"


# ===========================================================================
# §5 — snapshot vs realtime ordering of state
# ===========================================================================


@pytest.mark.asyncio
async def test_p5_stale_snapshot_does_not_resurrect_a_read_conversation():
    """User reads the chat (unread -> 0). An older `conversation_updated`
    snapshot still carrying unread_count=N must not bring the badge back: the
    realtime read is NEWER information than the snapshot.

    The gateway always ships `last_message_at` on a chat snapshot, so the
    snapshot's age is decidable.
    """
    conv_id = await _seed_conversation(unread_count=5)

    await ingest_gateway_event(
        _message_new("W-UR-1", body="son mesaj", created_at="2026-09-18T10:00:00.000Z")
    )
    await ingest_gateway_event(
        {
            "event": "conversation_read",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "unread_count": 0,
        }
    )
    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 0
    assert conv.last_read_at is not None

    # Stale snapshot: its activity timestamp predates our read.
    await ingest_gateway_event(
        {
            "event": "conversation_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "conversation": {
                "unread_count": 6,
                "last_message_at": "2026-09-18T10:00:00.000Z",
            },
        }
    )

    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 0, (
        "a stale snapshot resurrected unread_count after the user read the chat"
    )


@pytest.mark.asyncio
async def test_p5_snapshot_can_lower_the_badge_read_on_another_device():
    """The gateway reports the chat as read (user read it on the phone). The
    local badge MUST be able to go DOWN — a monotonic `max()` made a read
    performed anywhere else permanently invisible."""
    conv_id = await _seed_conversation(unread_count=5)

    await ingest_gateway_event(
        _message_new("W-UR-2", body="son mesaj", created_at="2026-09-18T10:00:00.000Z")
    )
    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 6

    # Gateway snapshot: the chat was read elsewhere, unread is now 0. Same
    # activity timestamp, so this is current — not stale.
    await ingest_gateway_event(
        {
            "event": "conversation_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "conversation": {
                "unread_count": 0,
                "last_message_at": "2026-09-18T10:00:00.000Z",
            },
        }
    )

    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 0, (
        "a read performed on another device never reached the local badge"
    )


@pytest.mark.asyncio
async def test_p5_stale_snapshot_does_not_erase_newer_message_unread():
    """A snapshot OLDER than the newest message we already hold cannot account
    for that message, so it must not lower the badge."""
    conv_id = await _seed_conversation(unread_count=0)

    await ingest_gateway_event(
        _message_new("W-UR-3", body="yeni", created_at="2026-09-18T12:00:00.000Z")
    )
    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 1

    # Snapshot from BEFORE the newest message we hold.
    await ingest_gateway_event(
        {
            "event": "conversation_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "conversation": {
                "unread_count": 0,
                "last_message_at": "2026-09-18T09:00:00.000Z",
            },
        }
    )

    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 1, "a stale snapshot erased the badge of a newer message"


@pytest.mark.asyncio
async def test_p5_stale_snapshot_does_not_downgrade_newer_preview():
    """An older snapshot (smaller last_message_at) must never replace a newer
    realtime preview, and must not move the conversation's activity time
    backwards."""
    conv_id = await _seed_conversation()

    await ingest_gateway_event(
        _message_new(
            "W-NEWEST",
            body="en yeni mesaj",
            created_at="2026-09-18T12:00:00.000Z",
        )
    )
    conv = await _get_conversation(conv_id)
    assert conv.last_message_preview == "en yeni mesaj"
    newest_at = conv.last_message_at

    await ingest_gateway_event(
        {
            "event": "conversation_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "conversation": {
                "last_message_preview": "eski mesaj",
                "last_message_at": "2026-09-18T09:00:00.000Z",
            },
        }
    )

    conv = await _get_conversation(conv_id)
    assert conv.last_message_preview == "en yeni mesaj"
    assert conv.last_message_at == newest_at


@pytest.mark.asyncio
async def test_p5_ordering_is_by_activity_not_identity_resolution():
    """§5 — the sort key is activity only. A conversation whose contact name
    has not resolved yet must not be pushed to the bottom of the list."""
    old_id = await _seed_conversation(
        jid=P5_JID, phone=P5_PHONE, display_name="Çözülmüş Kişi"
    )
    new_id = await _seed_conversation(
        jid=P5_JID_2, phone=P5_PHONE_2, display_name="+905550000202"
    )

    await ingest_gateway_event(
        _message_new(
            "W-ORD-OLD",
            jid=P5_JID,
            body="eski",
            created_at="2026-09-18T08:00:00.000Z",
        )
    )
    await ingest_gateway_event(
        _message_new(
            "W-ORD-NEW",
            jid=P5_JID_2,
            body="yeni",
            created_at="2026-09-18T13:00:00.000Z",
        )
    )

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Conversation.id)
                .where(Conversation.user_id == P5_USER)
                .order_by(Conversation.last_message_at.desc().nullslast())
            )
        ).scalars().all()

    assert list(rows)[0] == new_id, "activity ordering broken"
    assert list(rows)[-1] == old_id


# ===========================================================================
# §10 — group metadata must not downgrade preview / ordering
# ===========================================================================


@pytest.mark.asyncio
async def test_p5_group_subject_arrival_does_not_downgrade_preview():
    """A group name/metadata update carries no message. It must refresh the
    name without touching the latest preview or the activity timestamp."""
    conv_id = await _seed_conversation(
        jid=P5_GROUP_JID,
        phone=f"jid:{P5_GROUP_JID}",
        is_group=True,
        display_name="Grup",
    )

    await ingest_gateway_event(
        _message_new(
            "W-GRP-1",
            jid=P5_GROUP_JID,
            body="toplanti 15:00",
            created_at="2026-09-18T11:00:00.000Z",
        )
    )
    conv = await _get_conversation(conv_id)
    before_preview, before_at = conv.last_message_preview, conv.last_message_at

    await ingest_gateway_event(
        {
            "event": "conversation_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_GROUP_JID,
            "conversation": {"name": "Satıcı Ekip", "is_group": True},
        }
    )

    conv = await _get_conversation(conv_id)
    assert conv.last_message_preview == before_preview
    assert conv.last_message_at == before_at
    async with AsyncSessionLocal() as db:
        contact = (
            await db.execute(select(Contact).where(Contact.id == conv.contact_id))
        ).scalars().first()
    assert contact.display_name == "Satıcı Ekip"


# ===========================================================================
# §15 — partial events must not destroy known state
# ===========================================================================


@pytest.mark.asyncio
async def test_p5_partial_conversation_updated_keeps_existing_state():
    """`conversation_updated` is a PARTIAL event. A payload that omits name /
    preview / unread must leave the previously known values untouched — never
    blank them out."""
    conv_id = await _seed_conversation(unread_count=3)

    await ingest_gateway_event(
        {
            "event": "conversation_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "conversation": {
                "name": "Mehmet Demir",
                "last_message_preview": "Görüşürüz",
                "last_message_at": "2026-09-18T10:30:00.000Z",
                "unread_count": 3,
            },
        }
    )

    # Partial event: archive flag only.
    await ingest_gateway_event(
        {
            "event": "conversation_updated",
            "event_id": str(uuid.uuid4()),
            "gateway_session_id": P5_GW,
            "conversation_id": P5_JID,
            "conversation": {"archived": True},
        }
    )

    conv = await _get_conversation(conv_id)
    assert conv.last_message_preview == "Görüşürüz"
    assert conv.unread_count == 3
    assert conv.is_archived is True
    async with AsyncSessionLocal() as db:
        contact = (
            await db.execute(select(Contact).where(Contact.id == conv.contact_id))
        ).scalars().first()
    assert contact.display_name == "Mehmet Demir"


# ===========================================================================
# §11 — read receipt truthfulness
# ===========================================================================


@pytest.mark.asyncio
async def test_p5_failed_provider_mark_read_does_not_claim_the_chat_was_read():
    """§11 — if the provider mark-read call fails, the local record must NOT
    claim the conversation was read (unread=0 + last_read_at). Reporting a
    successful local read while the counterparty still sees 'unread' is a
    silent lie, and it makes a later honest reconnect snapshot look like a
    regression.
    """
    from unittest.mock import patch

    from backend.app.services.whatsapp.orchestration import messaging as m

    conv_id = await _seed_conversation(unread_count=4)

    class _Boom(Exception):
        pass

    async def _failing_gateway_op(db, session_row, op):
        raise _Boom("gateway unreachable")

    async with AsyncSessionLocal() as db:
        with patch.object(m, "_gateway_op_or_mark_relink", _failing_gateway_op):
            res = await m.mark_conversation_read(db, P5_USER, conv_id)

    assert res["success"] is False, "the API must not report a fake success"

    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 4, (
        "provider mark-read failed but the local unread_count was cleared anyway"
    )
    assert conv.last_read_at is None, (
        "provider mark-read failed but last_read_at was stamped anyway"
    )


# ===========================================================================
# C-5 migration — the conversation uniqueness the model declared but the DB
# never received
# ===========================================================================


@pytest.mark.asyncio
async def test_p5_conversation_line_uniqueness_is_enforced_by_the_database():
    """The same-line uniqueness is a real, enforced DB constraint — not just a
    declared-but-absent model constraint.

    This is the durable backstop that makes `_ensure_conversation`'s
    "SELECT then INSERT" safe and `_ensure_conversation_race_safe`'s
    IntegrityError -> rollback -> retry path reachable. A second row with the
    same (user, line, contact, channel) must be rejected.
    """
    from sqlalchemy.exc import IntegrityError

    # The line must be set: the index is (user_id, session_id, contact_id,
    # channel) and SQL NULLs are distinct, so line-less legacy rows are
    # deliberately allowed to coexist.
    conv_id = await _seed_conversation(unread_count=0)
    async with AsyncSessionLocal() as db:
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == conv_id))
        ).scalar_one()
        line = (
            await db.execute(
                select(WhatsAppSession).where(WhatsAppSession.gateway_id == P5_GW)
            )
        ).scalar_one()
        conv.session_id = line.id
        await db.commit()

        dup = Conversation(
            user_id=conv.user_id,
            contact_id=conv.contact_id,
            channel=conv.channel,
            status=ConversationStatus.ACTIVE,
            session_id=conv.session_id,
            last_message_at=None,
        )
        db.add(dup)
        with pytest.raises(IntegrityError):
            await db.flush()
        await db.rollback()


@pytest.mark.asyncio
async def test_p5_line_uniqueness_index_is_scoped_by_line():
    """The index must be scoped by session_id: the same contact on two
    different lines is two legitimate conversations, and must stay insertable.
    """
    conv_id = await _seed_conversation(unread_count=0)
    async with AsyncSessionLocal() as db:
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == conv_id))
        ).scalar_one()
        line1 = (
            await db.execute(
                select(WhatsAppSession).where(WhatsAppSession.gateway_id == P5_GW)
            )
        ).scalar_one()
        conv.session_id = line1.id
        await db.commit()

        second = WhatsAppSession(
            user_id=P5_USER,
            gateway_id=f"{P5_GW}-2",
            session_name="P5 Hat 2",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(second)
        await db.flush()
        # Same contact, same user, DIFFERENT line -> a legitimate second
        # conversation. The index must not collapse the two lines.
        twin = Conversation(
            user_id=conv.user_id,
            contact_id=conv.contact_id,
            channel=conv.channel,
            status=ConversationStatus.ACTIVE,
            session_id=second.id,
            last_message_at=None,
        )
        db.add(twin)
        await db.flush()  # must NOT raise
        await db.rollback()


@pytest.mark.asyncio
async def test_p5_no_unread_monotonic_max_remains_in_the_write_paths():
    """Source guard: the badge must be decided by the shared policy helper, not
    by a bare `max(...)` that can only ever raise it."""
    import pathlib
    import tokenize

    repo_root = pathlib.Path(__file__).resolve().parents[2]
    targets = [
        "backend/app/services/whatsapp/orchestration/events.py",
        "backend/app/services/whatsapp/orchestration/sync.py",
        "backend/app/services/whatsapp_service.py",
    ]
    for rel in targets:
        src = (repo_root / rel).read_text(encoding="utf-8")
        code_only = []
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.COMMENT:
                continue
            code_only.append(tok.string)
        code = " ".join(code_only)
        assert "max ( conv.unread_count" not in code, (
            f"{rel} still applies a monotonic max() to unread_count"
        )


@pytest.mark.asyncio
async def test_p5_successful_mark_read_clears_unread():
    """Control case: a successful provider read DOES clear the local badge."""
    from unittest.mock import patch

    from backend.app.services.whatsapp.orchestration import messaging as m

    conv_id = await _seed_conversation(unread_count=4)

    async def _ok_gateway_op(db, session_row, op):
        return {"success": True}

    async with AsyncSessionLocal() as db:
        with patch.object(m, "_gateway_op_or_mark_relink", _ok_gateway_op):
            res = await m.mark_conversation_read(db, P5_USER, conv_id)

    assert res["success"] is True
    conv = await _get_conversation(conv_id)
    assert conv.unread_count == 0
    assert conv.last_read_at is not None


# ---------------------------------------------------------------------------
# §3b — a lost duplicate INSERT race must cost ONLY that INSERT
# ---------------------------------------------------------------------------


async def _seed_race_winner(conv_id: int, wa_id: str, *, body: str = "kazanan") -> int:
    """Commits the row a concurrent ingest won the race with."""
    async with AsyncSessionLocal() as db:
        row = Message(
            user_id=P5_USER,
            conversation_id=conv_id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body=body,
            wa_message_id=wa_id,
            sender_phone=P5_PHONE,
            recipient_phone="ME",
            status=ConversationMessageStatus.RECEIVED,
            external_timestamp=datetime(2026, 9, 18, 10, 0, 0),
        )
        db.add(row)
        await db.commit()
        return row.id


@pytest.mark.asyncio
async def test_p5_duplicate_insert_race_costs_only_its_own_insert():
    """Measured in production on 2026-09-30 14:32:01 (conversation 17600):
    `uq_msg_conv_wa_message_id` was violated on the live `message_new` path.
    The pre-flight dedup SELECT is a TOCTOU filter — two ingests of the same
    WhatsApp message (a send echo delivered twice, or a history replay
    overlapping the live event) both pass it — and `_ingest_message` ran that
    INSERT with no savepoint, so the IntegrityError aborted the WHOLE
    transaction and `ingest_gateway_event` could only recover by rolling back.

    Contract proven here against the real schema and the real orchestrator:
      * the pre-flight SELECT is allowed to legitimately miss (that IS the race),
      * the duplicate loses only its own INSERT: nothing else in the
        transaction is discarded and NO transaction-wide rollback is needed,
      * the event is still broadcast, and it carries the WINNER row,
      * exactly one row and one unread tick survive.
    """
    from backend.app.services.whatsapp.orchestration.events import (
        WhatsAppEventOrchestrator,
    )

    conv_id = await _seed_conversation()
    event = _message_new("W-RACE-1", body="yarisi kaybeden")
    winner_id = await _seed_race_winner(conv_id, "W-RACE-1")

    orch = WhatsAppEventOrchestrator()
    async with AsyncSessionLocal() as db:
        real_execute = db.execute
        real_rollback = db.rollback
        seen = {"select_missed": 0, "rollbacks": 0}

        async def execute_that_misses_the_winner(stmt, *args, **kwargs):
            # Only the pre-flight dedup SELECT is blinded, and only once: it is
            # the one Message query scoped to a conversation. Everything else
            # (owner resolution, contact/conversation lookups, the winner
            # re-selection on the recovery path) runs for real.
            sql = str(stmt)
            if seen["select_missed"] == 0 and "FROM messages" in sql and "messages.conversation_id" in sql:
                seen["select_missed"] += 1
                return await real_execute(
                    select(Message).where(Message.conversation_id == -1)
                )
            return await real_execute(stmt, *args, **kwargs)

        async def counting_rollback(*args, **kwargs):
            seen["rollbacks"] += 1
            return await real_rollback(*args, **kwargs)

        db.execute = execute_that_misses_the_winner
        db.rollback = counting_rollback

        result = await orch._ingest_message(db, event)
        await db.commit()

    assert seen["select_missed"] == 1, "the race window was never exercised"
    assert result.get("_skip") is None, "the duplicate must still be broadcast"
    assert result["message"]["wa_message_id"] == "W-RACE-1"
    assert (await _get_message(conv_id, "W-RACE-1")).id == winner_id
    assert await _count_messages(conv_id, "W-RACE-1") == 1
    # The point of the fix: the loser's INSERT failure never escalated into a
    # transaction-wide rollback that would take unrelated work down with it.
    assert seen["rollbacks"] == 0, (
        "the duplicate must be contained by the savepoint, not by a rollback"
    )
    # And a duplicate is not a second unread message.
    assert (await _get_conversation(conv_id)).unread_count == 0
