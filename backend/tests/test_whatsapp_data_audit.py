"""Durable data-shape audit — the evidence a deploy must not destroy.

Background: on 2026-10-27 the production conversation count read 124 and then
123, and the contact count fell with it. Data loss was excluded (zero orphaned
messages, the message count rose, no `conversation_deleted` in the gateway
outbox) but the cause could not be named, because the container the deploy
replaced took its logs with it and every counter involved was in-memory.

These tests pin the replacement: a delete leaves a row that survives a restart,
carries before/after counts, and never leaks message content or phone numbers.
"""

import uuid

import pytest
from sqlalchemy import delete, select

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message, MessageDirection
from backend.app.models.whatsapp_data_audit import WhatsAppDataAudit
from backend.app.services import whatsapp_data_audit as audit
from backend.app.services.whatsapp_service import delete_conversation


async def _purge(user_id: str) -> None:
    """Leave the shared test DB exactly as it was found."""
    async with AsyncSessionLocal() as db:
        await db.execute(delete(WhatsAppDataAudit).where(WhatsAppDataAudit.user_id == user_id))
        await db.execute(delete(Message).where(Message.user_id == user_id))
        await db.execute(delete(Conversation).where(Conversation.user_id == user_id))
        await db.execute(delete(Contact).where(Contact.user_id == user_id))
        await db.commit()


async def _seed_conversation(user_id: str, *, messages: int = 2):
    async with AsyncSessionLocal() as db:
        contact = Contact(
            user_id=user_id, phone_e164="+905550000001", display_name="Audit Fixture"
        )
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=user_id, contact_id=contact.id, channel="WHATSAPP", session_id=None
        )
        db.add(conv)
        await db.flush()
        for i in range(messages):
            db.add(
                Message(
                    user_id=user_id,
                    conversation_id=conv.id,
                    wa_message_id=f"AUDIT-{uuid.uuid4().hex[:12]}-{i}",
                    body=f"fixture body {i}",
                    direction=MessageDirection.INBOUND,
                    sender_phone="+905550000001",
                    recipient_phone="+905550000002",
                )
            )
        await db.commit()
        return int(conv.id)


@pytest.mark.asyncio
async def test_delete_conversation_leaves_a_durable_audit_row() -> None:
    user_id = str(uuid.uuid4())
    try:
        conv_id = await _seed_conversation(user_id, messages=2)

        async with AsyncSessionLocal() as db:
            await delete_conversation(db, user_id, conv_id)

        # A NEW session: proves the row was committed, not merely staged.
        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppDataAudit)
                    .where(WhatsAppDataAudit.user_id == user_id)
                    .order_by(WhatsAppDataAudit.id.desc())
                )
            ).scalars().all()

        assert len(rows) == 1, [r.as_dict() for r in rows]
        row = rows[0]
        assert row.event == audit.EVENT_CONVERSATION_DELETED
        assert row.source == "api"
        assert row.outcome == "committed"
        assert conv_id in (row.conversation_ids or [])

        # The whole point: the delta is recorded, not inferred.
        assert row.counts_before is not None and row.counts_after is not None
        assert row.counts_after["conversations"] == row.counts_before["conversations"] - 1
        assert row.counts_after["messages"] == row.counts_before["messages"] - 2
        # A chat delete must NOT take the contact with it.
        assert row.counts_after["contacts"] == row.counts_before["contacts"]

        assert row.detail is not None
        assert "messages_deleted" in row.detail

        # The API must hand back an object, not a JSON string inside JSON.
        decoded = row.as_dict()
        assert isinstance(decoded["detail"], dict), decoded["detail"]
        assert decoded["detail"]["messages_deleted"] == 2
    finally:
        await _purge(user_id)


@pytest.mark.asyncio
async def test_audit_row_carries_no_message_body_or_phone_number() -> None:
    user_id = str(uuid.uuid4())
    try:
        conv_id = await _seed_conversation(user_id, messages=1)
        async with AsyncSessionLocal() as db:
            await delete_conversation(db, user_id, conv_id)

        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(
                    select(WhatsAppDataAudit).where(WhatsAppDataAudit.user_id == user_id)
                )
            ).scalars().first()

        blob = repr(row.as_dict())
        assert "fixture body" not in blob
        assert "+905550000001" not in blob
        assert "@s.whatsapp.net" not in blob
        assert "@lid" not in blob
    finally:
        await _purge(user_id)


@pytest.mark.asyncio
async def test_audit_recording_never_raises_into_the_caller(monkeypatch) -> None:
    """A broken audit write must not undo a legitimate delete."""

    class ExplodingSession:
        def add(self, _row):
            raise RuntimeError("audit table is gone")

        async def commit(self):  # pragma: no cover - add() raises first
            raise RuntimeError("unreachable")

        async def rollback(self):
            return None

        async def close(self):
            return None

    ok = await audit.record_data_event(
        ExplodingSession(),
        event=audit.EVENT_CONVERSATION_DELETED,
        source="api",
        user_id=str(uuid.uuid4()),
    )
    assert ok is False


@pytest.mark.asyncio
async def test_session_acquisition_failure_never_raises(monkeypatch) -> None:
    """Opening the audit's OWN session must not escape either.

    `record_data_event(None, ...)` is called from the reconciliation sweep. If
    the pool is exhausted, `AsyncSessionLocal()` raises — and if that call sat
    outside the try/except, the audit would stop the very repair loop it exists
    to explain. Asserted separately from the write path because it is a
    different failure point (acquisition, not `add`).
    """

    def _boom():
        raise RuntimeError("pool exhausted")

    monkeypatch.setattr(
        "backend.app.core.database.AsyncSessionLocal", _boom, raising=True
    )

    ok = await audit.record_data_event(
        None, event=audit.EVENT_SWEEP_RUN, source="sweep", reason="pool down"
    )
    assert ok is False


@pytest.mark.asyncio
async def test_recent_events_is_tenant_scoped() -> None:
    mine, theirs = str(uuid.uuid4()), str(uuid.uuid4())
    try:
        await audit.record_data_event(
            None, event=audit.EVENT_SWEEP_RUN, source="sweep", user_id=mine, reason="mine"
        )
        await audit.record_data_event(
            None, event=audit.EVENT_SWEEP_RUN, source="sweep", user_id=theirs, reason="theirs"
        )

        async with AsyncSessionLocal() as db:
            rows = await audit.recent_events(db, user_id=mine, limit=50)

        assert rows, "expected at least one row for the caller's tenant"
        assert all(r["reason"] == "mine" for r in rows), rows
    finally:
        await _purge(mine)
        await _purge(theirs)
