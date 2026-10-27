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


# ---------------------------------------------------------------------------
# Phase 3 — atomicity, idempotency, visibility, and the path that was never
# audited at all.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_staged_event_rolls_back_with_the_change() -> None:
    """A rolled-back delete must leave NO audit row.

    This is the half of the atomicity contract that Phase 2 already had (it
    wrote after commit). The other half — a committed delete with no row —
    cannot be tested by rolling back, so it is covered structurally by writing
    both in ONE transaction and asserted here by the inverse.
    """
    user_id = str(uuid.uuid4())
    try:
        conv_id = await _seed_conversation(user_id, messages=1)

        async with AsyncSessionLocal() as db:
            await db.execute(delete(Conversation).where(Conversation.id == conv_id))
            await audit.stage_data_event(
                db,
                event=audit.EVENT_CONVERSATION_DELETED,
                source="api",
                user_id=user_id,
                conversation_ids=[conv_id],
            )
            # The caller changes its mind / hits an error.
            await db.rollback()

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppDataAudit).where(WhatsAppDataAudit.user_id == user_id)
                )
            ).scalars().all()

        assert rows == [], [r.as_dict() for r in rows]
    finally:
        await _purge(user_id)


@pytest.mark.asyncio
async def test_staged_event_commits_with_the_change() -> None:
    """The positive control: same path, committed, leaves exactly one row."""
    user_id = str(uuid.uuid4())
    try:
        conv_id = await _seed_conversation(user_id, messages=1)

        async with AsyncSessionLocal() as db:
            await db.execute(delete(Conversation).where(Conversation.id == conv_id))
            await audit.stage_data_event(
                db,
                event=audit.EVENT_CONVERSATION_DELETED,
                source="api",
                user_id=user_id,
                conversation_ids=[conv_id],
            )
            await db.commit()

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppDataAudit).where(WhatsAppDataAudit.user_id == user_id)
                )
            ).scalars().all()

        assert len(rows) == 1, [r.as_dict() for r in rows]
    finally:
        await _purge(user_id)


@pytest.mark.asyncio
async def test_idempotency_key_makes_a_retry_a_no_op() -> None:
    """One logical delete recorded twice must not read as a `-2`.

    A gateway redelivery or a client retry that appended a second row would make
    the count deltas lie in exactly the direction that caused this whole
    investigation to stall.
    """
    user_id = str(uuid.uuid4())
    key = f"conversation_deleted:{user_id}:999999"
    try:
        first = await audit.record_data_event(
            None,
            event=audit.EVENT_CONVERSATION_DELETED,
            source="api",
            user_id=user_id,
            idempotency_key=key,
            conversation_ids=[999999],
        )
        second = await audit.record_data_event(
            None,
            event=audit.EVENT_CONVERSATION_DELETED,
            source="api",
            user_id=user_id,
            idempotency_key=key,
            conversation_ids=[999999],
        )

        assert first is True, "the first write must persist"
        assert second is False, "the retry must be recognised as already recorded"

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppDataAudit).where(WhatsAppDataAudit.user_id == user_id)
                )
            ).scalars().all()
        assert len(rows) == 1, [r.as_dict() for r in rows]
    finally:
        await _purge(user_id)


@pytest.mark.asyncio
async def test_rows_without_a_key_are_not_constrained() -> None:
    """NULL idempotency keys must coexist — a sweep summary has no natural key."""
    user_id = str(uuid.uuid4())
    try:
        for reason in ("one", "two"):
            ok = await audit.record_data_event(
                None,
                event=audit.EVENT_SWEEP_RUN,
                source="sweep",
                user_id=user_id,
                reason=reason,
            )
            assert ok is True

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppDataAudit).where(WhatsAppDataAudit.user_id == user_id)
                )
            ).scalars().all()
        assert len(rows) == 2, [r.as_dict() for r in rows]
        assert all(r.idempotency_key is None for r in rows)
    finally:
        await _purge(user_id)


@pytest.mark.asyncio
async def test_failed_audit_write_is_visible_in_health_stats() -> None:
    """A silently broken recorder must not look like a system with no events.

    The counters are process-local by design (a restart resets them), but they
    are the only signal that distinguishes "nothing happened" from "nothing was
    recorded".
    """
    before = audit.stats()
    assert "failed" in before

    class ExplodingSession:
        def add(self, _row):
            raise RuntimeError("audit table is gone")

        async def commit(self):  # pragma: no cover
            raise RuntimeError("unreachable")

        async def rollback(self):
            return None

        async def close(self):
            return None

    await audit.record_data_event(
        ExplodingSession(), event=audit.EVENT_SWEEP_RUN, source="sweep"
    )

    after = audit.stats()
    assert after["failed"] == before["failed"] + 1, (before, after)
    assert after["last_error"] and "audit table is gone" in after["last_error"]


@pytest.mark.asyncio
async def test_self_identity_merge_records_why_both_counts_fell() -> None:
    """The path that changed BOTH counts and left no trace.

    `reconcile_self_identity` deletes a duplicate conversation and, when the
    duplicate contact has no conversation left, the contact too. That is the
    exact `-1 conversation, -1 contact` signature observed on 2026-10-27 — and
    it was the one count-changing path with no audit row at all.
    """
    from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
    from backend.app.services.whatsapp.orchestration.events import _default_orchestrator

    user_id = str(uuid.uuid4())
    canonical_phone = "+905559990001"
    try:
        async with AsyncSessionLocal() as db:
            session = WhatsAppSession(
                user_id=user_id,
                gateway_id=str(uuid.uuid4()),
                session_name="Audit Merge Fixture",
                status=SessionStatus.CONNECTED,
                phone_number=canonical_phone,
                is_active=True,
            )
            db.add(session)
            await db.flush()

            canonical = Contact(
                user_id=user_id, phone_e164=canonical_phone, display_name="Self"
            )
            db.add(canonical)
            await db.flush()
            canonical_conv = Conversation(
                user_id=user_id,
                contact_id=canonical.id,
                channel="WHATSAPP",
                session_id=session.id,
            )
            db.add(canonical_conv)

            # Same digits, different string: passes `is_self_identity` (digit
            # match) while still being a distinct row under uq_contact_user_phone.
            dup = Contact(
                user_id=user_id,
                phone_e164="905559990001@s.whatsapp.net",
                display_name="Self (LID ghost)",
            )
            db.add(dup)
            await db.flush()
            dup_conv = Conversation(
                user_id=user_id,
                contact_id=dup.id,
                channel="WHATSAPP",
                session_id=session.id,
            )
            db.add(dup_conv)
            await db.commit()

            session_id = session.id
            dup_conv_id = dup_conv.id
            dup_contact_id = dup.id

        async with AsyncSessionLocal() as db:
            session = (
                await db.execute(
                    select(WhatsAppSession).where(WhatsAppSession.id == session_id)
                )
            ).scalars().first()
            result = await _default_orchestrator.reconcile_self_identity(
                db, user_id, session
            )

        assert result["status"] == "reconciled", result
        assert dup_conv_id in result["merged_conversations"], result
        assert dup_contact_id in result["deleted_contacts"], result

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppDataAudit).where(
                        WhatsAppDataAudit.user_id == user_id,
                        WhatsAppDataAudit.event == audit.EVENT_SELF_IDENTITY_MERGE,
                    )
                )
            ).scalars().all()

        assert len(rows) == 1, [r.as_dict() for r in rows]
        row = rows[0]
        assert dup_conv_id in (row.conversation_ids or [])
        assert dup_contact_id in (row.contact_ids or [])
        # The signature that took a whole phase to explain, now written down.
        assert row.counts_before is not None and row.counts_after is not None
        assert row.counts_after["conversations"] == row.counts_before["conversations"] - 1
        assert row.counts_after["contacts"] == row.counts_before["contacts"] - 1
        assert row.idempotency_key, "a merge must carry an idempotency key"
        # `detail` is stored as JSON text on the row; the API decodes it.
        decoded = row.as_dict()["detail"]
        assert isinstance(decoded, dict), decoded
        assert decoded.get("merged_conversation_count") == 1
    finally:
        from backend.app.models.whatsapp_session import WhatsAppSession as _WS

        async with AsyncSessionLocal() as db:
            await db.execute(delete(_WS).where(_WS.user_id == user_id))
            await db.commit()
        await _purge(user_id)


@pytest.mark.asyncio
async def test_count_snapshot_writes_only_when_the_data_shape_changes() -> None:
    """The structural half of attribution: bound a change to a window.

    Message traffic must NOT trigger a snapshot — otherwise the table becomes a
    heartbeat and the one row that matters is lost in the noise. A conversation
    or contact count move must trigger one.
    """
    user_id = str(uuid.uuid4())
    try:
        # 1. Seed FIRST, so the baseline already contains the conversation.
        conv_id = await _seed_conversation(user_id, messages=2)
        async with AsyncSessionLocal() as db:
            first = await audit.record_count_snapshot(db, user_id=user_id)
        assert first is not None

        # 2. Only messages change (normal traffic) -> no new row.
        async with AsyncSessionLocal() as db:
            for i in range(3):
                db.add(
                    Message(
                        user_id=user_id,
                        conversation_id=conv_id,
                        wa_message_id=f"NOISE-{uuid.uuid4().hex[:10]}-{i}",
                        body="traffic",
                        direction=MessageDirection.INBOUND,
                        sender_phone="+905550000001",
                        recipient_phone="+905550000002",
                    )
                )
            await db.commit()
        async with AsyncSessionLocal() as db:
            second = await audit.record_count_snapshot(db, user_id=user_id)
        assert second is None, "a message-count change must not write a snapshot"

        # 3. The shape changes -> a row, carrying the new counts.
        async with AsyncSessionLocal() as db:
            await db.execute(delete(Conversation).where(Conversation.id == conv_id))
            await db.commit()
        async with AsyncSessionLocal() as db:
            third = await audit.record_count_snapshot(db, user_id=user_id)
        assert third is not None

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppDataAudit)
                    .where(
                        WhatsAppDataAudit.user_id == user_id,
                        WhatsAppDataAudit.event == audit.EVENT_COUNT_SNAPSHOT,
                    )
                    .order_by(WhatsAppDataAudit.id.asc())
                )
            ).scalars().all()

        assert len(rows) == 2, [r.as_dict() for r in rows]
        before, after = rows
        assert after.counts_after["conversations"] == before.counts_after["conversations"] - 1
        decoded = after.as_dict()["detail"]
        assert decoded["has_baseline"] is True
    finally:
        await _purge(user_id)
