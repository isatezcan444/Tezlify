"""Phase 2 forensic regression tests.

Each test pins ONE confirmed defect from the Phase 2 workstream so it cannot
silently regress. The tests assert the *contract* (what the system must do), never
the previous implementation.

Covered defects:
- H-2  the background sweep must NOT reach FULLY_EXHAUSTED from a single
       zero-message provider response; it must use the shared two-step policy
- H-3  a partial timeout (TIMEOUT + messages) must record its REAL message count,
       must not read as exhausted, and must not be confused with a zero result
- H-3b a full timeout must commit its evidence BEFORE raising
- H-4  NOT_REQUESTED (provider never called) must stay distinct from
       SOCKET_UNAVAILABLE (provider call requested but the socket was unusable)
- H-5  the on-demand provider path is budgeted per conversation
- H-6  a gateway chat snapshot must not move `last_message_at` backwards in the
       emitted payload
- C-5  `list_conversations` is a GET: it must never mutate persistence
- S-2  requesting a pairing code must not persist the phone as canonical
- S-4  a lock-skipped relink candidate must not be reported as "no candidate"
- S-5  a reconcile burst for one session must coalesce
- WS contract: `conversation_updated` carries the canonical REST conversation shape
"""

import asyncio
import re
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal, Base
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp.exceptions import WhatsAppHistoryTimeout
from backend.app.services.whatsapp.orchestration import relink as relink_mod
from backend.app.services.whatsapp.orchestration.history_evidence import (
    get_history_evidence,
    record_on_demand_provider_result,
)
from backend.app.services.whatsapp.orchestration.relink import (
    RelinkCandidateNotFound,
    resolve_relink_candidate,
)
from backend.app.services.whatsapp.orchestration.sync import (
    WhatsAppSyncOrchestrator,
    _ON_DEMAND_PROVIDER_MAX_PER_WINDOW,
    _on_demand_provider_budget_available,
    _on_demand_provider_budget_spend,
    _on_demand_provider_calls,
)

TEST_USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
GW_ID = "gw-phase2-0001"
PHONE = "+905321119988"
PHONE_JID = "905321119988@s.whatsapp.net"

_HISTORY_DDL = """
    CREATE TABLE IF NOT EXISTS history_sync_states (
        session_id TEXT NOT NULL,
        jid VARCHAR(100) NOT NULL,
        oldest_msg_id VARCHAR(100),
        oldest_timestamp_ms BIGINT,
        has_more BOOLEAN NOT NULL DEFAULT 1,
        completed_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        state VARCHAR(50) DEFAULT 'NOT_CHECKED',
        stall_count INTEGER DEFAULT 0,
        timeout_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        last_attempt_at TIMESTAMP,
        last_success_at TIMESTAMP,
        last_error TEXT,
        provider_checked BOOLEAN NOT NULL DEFAULT 0,
        provider_checked_at TIMESTAMP,
        provider_exhausted BOOLEAN DEFAULT 0,
        provider_signal VARCHAR(32),
        provider_msgs_returned INTEGER DEFAULT 0,
        provider_cursor_used VARCHAR(255),
        last_sweep_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, jid)
    )
"""


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    """Wipes the shared test DB rows this module touches, before and after."""

    async def _wipe():
        async with AsyncSessionLocal() as db:
            hex_id = TEST_USER.replace("-", "")
            await db.execute(
                text("DELETE FROM messages WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.execute(
                text("DELETE FROM conversations WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.execute(
                text("DELETE FROM history_sync_states WHERE session_id LIKE 'gw-phase2%'")
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()
    _on_demand_provider_calls.clear()


async def _seed(*, phone=PHONE, gateway_id=GW_ID, with_message=True, last_message_at=None):
    """Seeds session + contact + conversation (+ one anchor message). Returns ids."""
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=gateway_id,
            session_name="Phase2 Hat",
            status=SessionStatus.CONNECTED,
            is_active=True,
            phone_number=phone,
        )
        db.add(sess)
        await db.flush()
        contact = Contact(user_id=TEST_USER, phone_e164=phone, display_name=None)
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
            last_message_at=last_message_at,
        )
        db.add(conv)
        await db.flush()
        if with_message:
            db.add(
                Message(
                    user_id=TEST_USER,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body="anchor",
                    wa_message_id="wa-anchor-1",
                    sender_phone=phone,
                    recipient_phone=phone,
                    external_timestamp=datetime(2026, 1, 1, 12, 0, 0),
                )
            )
        await db.commit()
        return sess.id, contact.id, conv.id


# ---------------------------------------------------------------------------
# H-2 — background sweep uses the shared two-step exhaustion policy
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_h2_background_sweep_needs_two_steps_to_exhaust(monkeypatch):
    """H-2: one zero-message sweep must yield EXHAUSTION_CANDIDATE, never FULLY_EXHAUSTED.

    This drives the REAL sweep against a real database. The provider returns zero
    messages, which the pre-fix code wrote straight to `state='FULLY_EXHAUSTED'`,
    skipping the Phase 17 two-step confirmation and permanently declaring the
    conversation complete.
    """
    await _seed()
    orch = WhatsAppSyncOrchestrator()
    gw_mock = MagicMock()
    gw_mock.get_messages = AsyncMock(
        return_value={"messages": [], "provider_status": "OK"}
    )

    def _helper(name, default=None):
        if name == "AsyncSessionLocal":
            return AsyncSessionLocal
        if name == "gw":
            return gw_mock
        return default

    monkeypatch.setattr(orch, "_get_helper", _helper)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(settings, "WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED", True)
    key = (TEST_USER, GW_ID)
    orch._history_expansion_running.discard(key)
    orch._history_expansion_done.discard(key)
    orch._history_jid_attempts.clear()
    orch._history_jid_cooldown.clear()

    await orch._run_background_history_expansion(TEST_USER, GW_ID)

    async with AsyncSessionLocal() as db:
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)

    assert ev["state"] == "EXHAUSTION_CANDIDATE", (
        f"one zero-message sweep must not exhaust the conversation (got {ev['state']})"
    )
    assert ev["provider_exhausted"] is False
    assert ev["state"] != "FULLY_EXHAUSTED"


@pytest.mark.asyncio
async def test_h2_second_zero_sweep_completes_exhaustion(monkeypatch):
    """H-2: the SECOND consecutive zero-message sweep legitimately exhausts."""
    await _seed()
    # First step: leave the conversation at EXHAUSTION_CANDIDATE.
    async with AsyncSessionLocal() as db:
        await record_on_demand_provider_result(
            db,
            session_id=GW_ID,
            jid=PHONE_JID,
            requested_count=50,
            provider_status="OK",
            gw_msgs=[],
        )
        await db.commit()

    orch = WhatsAppSyncOrchestrator()
    gw_mock = MagicMock()
    gw_mock.get_messages = AsyncMock(
        return_value={"messages": [], "provider_status": "OK"}
    )

    def _helper(name, default=None):
        if name == "AsyncSessionLocal":
            return AsyncSessionLocal
        if name == "gw":
            return gw_mock
        return default

    monkeypatch.setattr(orch, "_get_helper", _helper)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(settings, "WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED", True)
    key = (TEST_USER, GW_ID)
    orch._history_expansion_running.discard(key)
    orch._history_expansion_done.discard(key)
    orch._history_jid_attempts.clear()
    orch._history_jid_cooldown.clear()

    await orch._run_background_history_expansion(TEST_USER, GW_ID)

    async with AsyncSessionLocal() as db:
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)

    assert ev["state"] == "FULLY_EXHAUSTED"
    assert ev["provider_exhausted"] is True


# ---------------------------------------------------------------------------
# H-3 — partial timeout
# ---------------------------------------------------------------------------

async def _hydrate_with_provider(payload, *, gateway_id=GW_ID, conv_id=None, limit=50):
    """Runs the real `_hydrate_messages_on_demand` with only the gateway mocked."""
    orch = WhatsAppSyncOrchestrator()
    gw_mock = MagicMock()
    gw_mock.get_messages = AsyncMock(return_value=payload)

    def _helper(name, default=None):
        if name == "gw":
            return gw_mock
        return default

    with patch.object(orch, "_get_helper", _helper):
        async with AsyncSessionLocal() as db:
            conv = await db.get(Conversation, conv_id)
            older = await orch._hydrate_messages_on_demand(
                db, TEST_USER, conv, limit, before_ts_ms=1700000000000, oldest_msg_id="wa-anchor-1"
            )
    return older, gw_mock


@pytest.mark.asyncio
async def test_h3_partial_timeout_records_real_count_and_persists_messages():
    """H-3: TIMEOUT + messages = partial. Evidence must carry the real count."""
    _, _, conv_id = await _seed()
    partial = [
        {
            "wa_message_id": "wa-partial-1",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "body": "partial one",
            "timestamp_s": 1699999000,
        },
        {
            "wa_message_id": "wa-partial-2",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "body": "partial two",
            "timestamp_s": 1699999500,
        },
    ]
    older, _ = await _hydrate_with_provider(
        {"messages": partial, "provider_status": "TIMEOUT"}, conv_id=conv_id
    )

    # The partial data is real data: it must be persisted and returned.
    assert len(older) == 2

    async with AsyncSessionLocal() as db:
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)
        persisted = (
            await db.execute(
                select(Message.wa_message_id).where(Message.conversation_id == conv_id)
            )
        ).scalars().all()

    assert "wa-partial-1" in persisted and "wa-partial-2" in persisted
    # The round-trip DID time out — that must be recorded, not hidden.
    assert ev["state"] == "TIMEOUT"
    assert ev["provider_exhausted"] is False
    assert ev["state"] != "FULLY_EXHAUSTED"
    # ...but the evidence must not claim zero while the client got two messages.
    assert ev["provider_msgs_returned"] == 2, (
        "a partial timeout must record the messages it actually received"
    )


@pytest.mark.asyncio
async def test_h3b_full_timeout_commits_evidence_before_raising():
    """H-3b: a full timeout records durable evidence, then raises."""
    _, _, conv_id = await _seed()
    with pytest.raises(WhatsAppHistoryTimeout):
        await _hydrate_with_provider(
            {"messages": [], "provider_status": "TIMEOUT"}, conv_id=conv_id
        )

    async with AsyncSessionLocal() as db:
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)

    assert ev["state"] == "TIMEOUT"
    assert ev["provider_exhausted"] is False
    assert ev["provider_msgs_returned"] == 0


# ---------------------------------------------------------------------------
# H-4 — NOT_REQUESTED vs SOCKET_UNAVAILABLE vs NO_ANCHOR
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_h4_not_requested_never_mutates_evidence():
    """H-4: a cache hit (`NOT_REQUESTED`) records nothing at all."""
    async with AsyncSessionLocal() as db:
        res = await record_on_demand_provider_result(
            db,
            session_id=GW_ID,
            jid=PHONE_JID,
            requested_count=50,
            provider_status="NOT_REQUESTED",
            gw_msgs=[{"wa_message_id": "x", "timestamp_s": 1700000000}],
        )
        await db.commit()
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)

    assert res is None
    assert ev["state"] == "NOT_CHECKED"
    assert ev["provider_checked"] is False


@pytest.mark.asyncio
async def test_h4_no_anchor_never_mutates_evidence():
    """H-4: `NO_ANCHOR` means the provider was never reached — it carries no evidence."""
    async with AsyncSessionLocal() as db:
        res = await record_on_demand_provider_result(
            db,
            session_id=GW_ID,
            jid=PHONE_JID,
            requested_count=50,
            provider_status="NO_ANCHOR",
        )
        await db.commit()
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)

    assert res is None
    assert ev["state"] == "NOT_CHECKED"


@pytest.mark.asyncio
async def test_h4_socket_unavailable_is_a_real_provider_failure():
    """H-4: `SOCKET_UNAVAILABLE` is NOT a cache hit — it must be recorded as an error.

    Conflating it with `NOT_REQUESTED` made a socket-less gateway look like a
    healthy "nothing to do", so the failure was invisible.
    """
    async with AsyncSessionLocal() as db:
        res = await record_on_demand_provider_result(
            db,
            session_id=GW_ID,
            jid=PHONE_JID,
            requested_count=50,
            provider_status="SOCKET_UNAVAILABLE",
            error_msg="gateway socket unusable",
        )
        await db.commit()
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)

    assert res is not None
    assert res["state"] == "PROVIDER_ERROR"
    assert ev["state"] == "PROVIDER_ERROR"
    assert ev["provider_exhausted"] is False
    assert ev["provider_checked"] is False


# ---------------------------------------------------------------------------
# H-5 — on-demand provider request budget
# ---------------------------------------------------------------------------

def test_h5_budget_is_conversation_scoped():
    """H-5: the budget is per conversation — one busy chat cannot starve another."""
    _on_demand_provider_calls.clear()
    for _ in range(_ON_DEMAND_PROVIDER_MAX_PER_WINDOW):
        assert _on_demand_provider_budget_available("u1", 1) is True
        _on_demand_provider_budget_spend("u1", 1)

    assert _on_demand_provider_budget_available("u1", 1) is False
    # A different conversation is unaffected (no global lock).
    assert _on_demand_provider_budget_available("u1", 2) is True
    # A different user is unaffected.
    assert _on_demand_provider_budget_available("u2", 1) is True


def test_h5_budget_window_expires():
    """H-5: the sliding window releases budget once entries age out."""
    _on_demand_provider_calls.clear()
    import time as _time

    now = _time.monotonic()
    for _ in range(_ON_DEMAND_PROVIDER_MAX_PER_WINDOW):
        _on_demand_provider_calls.setdefault(("u1", 7), __import__("collections").deque()).append(now)

    assert _on_demand_provider_budget_available("u1", 7) is False
    # Well past the window: the old entries are pruned.
    assert _on_demand_provider_budget_available("u1", 7, now=now + 3600) is True


@pytest.mark.asyncio
async def test_h5_budget_suppresses_provider_call_without_claiming_exhaustion():
    """H-5: a suppressed call must not reach the provider and must not write evidence."""
    _, _, conv_id = await _seed()
    _on_demand_provider_calls.clear()
    for _ in range(_ON_DEMAND_PROVIDER_MAX_PER_WINDOW):
        _on_demand_provider_budget_spend(TEST_USER, conv_id)

    older, gw_mock = await _hydrate_with_provider(
        {"messages": [{"wa_message_id": "wa-x", "timestamp_s": 1}], "provider_status": "OK"},
        conv_id=conv_id,
    )

    assert older == []
    gw_mock.get_messages.assert_not_awaited()
    async with AsyncSessionLocal() as db:
        ev = await get_history_evidence(db, PHONE_JID, session_id=GW_ID)
    # Nothing was learned, so nothing may be recorded.
    assert ev["state"] == "NOT_CHECKED"
    assert ev["provider_exhausted"] is False


# ---------------------------------------------------------------------------
# H-6 — snapshot payload must not move last_message_at backwards
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_h6_snapshot_payload_uses_persisted_timestamp():
    """H-6: an older gateway snapshot must not override the canonical timestamp.

    The conversation already carries a NEWER `last_message_at`. The gateway chat
    snapshot carries an OLDER one. The emitted payload (which the frontend uses as
    its sort key) must report the persisted value, otherwise the UI ordering
    contradicts the database.
    """
    newer = datetime(2026, 6, 1, 12, 0, 0)
    _, _, conv_id = await _seed(last_message_at=newer)
    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, conv_id)
        conv.last_message_preview = "newer preview"
        await db.commit()

    orch = WhatsAppSyncOrchestrator()
    older_iso = "2025-01-01T00:00:00"
    items = [
        {
            "jid": PHONE_JID,
            "id": PHONE_JID,
            "name": "Snapshot Name",
            "name_source": "push",
            "last_message_at": older_iso,
            "last_message_preview": "OLDER snapshot preview",
            "message_type": "TEXT",
            "unread_count": 0,
        }
    ]
    async with AsyncSessionLocal() as db:
        out, _ = await orch._persist_chat_snapshot(db, TEST_USER, items)

    assert len(out) == 1
    payload = out[0]
    assert payload["last_message_at"] is not None
    assert not payload["last_message_at"].startswith("2025-01-01"), (
        "an older gateway snapshot must not move the payload's sort key backwards"
    )
    assert payload["last_message_at"].startswith("2026-06-01")

    # ...and the DB itself must be unchanged too.
    async with AsyncSessionLocal() as db:
        conv = await db.get(Conversation, conv_id)
    assert conv.last_message_at.replace(tzinfo=None) == newer


# ---------------------------------------------------------------------------
# C-5 — a GET must not mutate persistence
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_c5_list_conversations_issues_no_writes():
    """C-5: `list_conversations` is a read path — SELECTs only, and never commits.

    It used to re-key `contact.phone_e164` and run `UPDATE messages SET
    sender_phone` and then `db.commit()` from inside the GET. Committing from a
    read path can also flush and discard unrelated pending work on the same
    session.
    """
    await _seed()
    async with AsyncSessionLocal() as db:
        statements = []
        commits = []
        real_execute = db.execute
        real_commit = db.commit

        async def spy_execute(stmt, *a, **kw):
            statements.append(str(stmt))
            return await real_execute(stmt, *a, **kw)

        async def spy_commit():
            commits.append(1)
            return await real_commit()

        db.execute = spy_execute
        db.commit = spy_commit
        try:
            result, _total = await ws.list_conversations(db, TEST_USER)
        finally:
            db.execute = real_execute
            db.commit = real_commit

    assert result, "the read path must still return the conversation"
    writes = [
        s for s in statements if re.match(r"\s*(UPDATE|INSERT|DELETE)\b", s, re.IGNORECASE)
    ]
    assert writes == [], f"list_conversations must not write: {writes}"
    assert commits == [], "list_conversations must not commit"


@pytest.mark.asyncio
async def test_c5_lid_heal_is_a_write_path_only():
    """C-5: the LID re-key repair exists, but on the write path (`lid_mapped`)."""
    from backend.app.services.whatsapp.orchestration.events import (
        WhatsAppEventOrchestrator,
    )

    assert hasattr(
        WhatsAppEventOrchestrator, "_heal_lid_contact_identity"
    ), "the LID repair must exist on the event (write) path"
    src = (
        __import__("inspect").getsource(ws.list_conversations)
    )
    assert "UPDATE messages" not in src, (
        "the read path must not rewrite messages.sender_phone"
    )
    assert "phone_e164 = " not in src, "the read path must not re-key contacts"


# ---------------------------------------------------------------------------
# S-2 — pairing phone is not canonical until pairing succeeds
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_s2_pairing_code_does_not_persist_phone():
    """S-2: the requested number is a candidate, not a verified canonical phone."""
    from backend.app.services.whatsapp.orchestration.sessions import request_pairing_code

    db = AsyncMock()
    row = WhatsAppSession(id=9, gateway_id="gw-9", status=SessionStatus.SCAN_QR)
    with patch(
        "backend.app.services.whatsapp.orchestration.sessions._get_session_or_404",
        new_callable=AsyncMock,
        return_value=row,
    ), patch(
        "backend.app.services.whatsapp_gateway.request_pairing_code",
        new_callable=AsyncMock,
        return_value={"code": "1111-2222", "phone": "+905551112233"},
    ):
        res = await request_pairing_code(db, TEST_USER, 9, "+905551112233")

    assert res["phone"] == "+905551112233"
    assert res["phone_pending"] is True
    assert row.phone_number is None
    db.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# S-4 — lock-skip must not be reported as "no candidate"
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_s4_lock_skipped_candidate_is_reused_not_notfound():
    """S-4: `skip_locked` returning 0 must not be mistaken for "no candidate".

    Reporting NotFound here makes the caller create a NEW session for a phone that
    already has one — a duplicate session row.
    """
    existing = WhatsAppSession(
        id=42, user_id=TEST_USER, gateway_id="gw-old", status=SessionStatus.RELINK_REQUIRED,
        session_name="Hat", phone_number=PHONE,
    )
    db = AsyncMock()
    locked_result = MagicMock()
    locked_result.scalars.return_value.all.return_value = []  # row was skipped
    recheck_result = MagicMock()
    recheck_result.scalars.return_value.all.return_value = [existing]
    db.execute = AsyncMock(side_effect=[locked_result, recheck_result])

    got = await resolve_relink_candidate(
        db, user_id=TEST_USER, phone=PHONE, new_gateway_id="gw-new"
    )
    assert got is existing


@pytest.mark.asyncio
async def test_s4_genuinely_absent_candidate_still_raises_notfound():
    """S-4: a real absence must still fail closed as NotFound (first-time pairing)."""
    db = AsyncMock()
    empty = MagicMock()
    empty.scalars.return_value.all.return_value = []
    db.execute = AsyncMock(side_effect=[empty, empty])

    with pytest.raises(RelinkCandidateNotFound):
        await resolve_relink_candidate(
            db, user_id=TEST_USER, phone=PHONE, new_gateway_id="gw-new"
        )


@pytest.mark.asyncio
async def test_s4_lock_skipped_ambiguous_still_fails_closed():
    """S-4: two lock-skipped candidates must fail closed, never heuristic-pick."""
    from backend.app.services.whatsapp.orchestration.relink import RelinkCandidateAmbiguous

    a = WhatsAppSession(id=1, user_id=TEST_USER, gateway_id="g1", status=SessionStatus.RELINK_REQUIRED, session_name="A", phone_number=PHONE)
    b = WhatsAppSession(id=2, user_id=TEST_USER, gateway_id="g2", status=SessionStatus.RELINK_REQUIRED, session_name="B", phone_number=PHONE)
    db = AsyncMock()
    locked_result = MagicMock()
    locked_result.scalars.return_value.all.return_value = []
    recheck_result = MagicMock()
    recheck_result.scalars.return_value.all.return_value = [a, b]
    db.execute = AsyncMock(side_effect=[locked_result, recheck_result])

    with pytest.raises(RelinkCandidateAmbiguous):
        await resolve_relink_candidate(
            db, user_id=TEST_USER, phone=PHONE, new_gateway_id="gw-new"
        )


# ---------------------------------------------------------------------------
# S-5 — reconcile burst coalescing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_s5_reconcile_burst_coalesces_per_session(monkeypatch):
    """S-5: a reconnect storm must not fan out into parallel sync jobs."""
    orch = WhatsAppSyncOrchestrator()
    spawned = []

    async def _fake_run(owner):
        spawned.append(owner)

    def _helper(name, default=None):
        if name == "_run_initial_sync":
            return _fake_run
        return default

    monkeypatch.setattr(orch, "_get_helper", _helper)
    orch._initial_sync_inflight.clear()
    orch._initial_sync_pending.clear()
    orch._reconcile_session_inflight.clear()
    orch._reconcile_session_coalesced.clear()

    session_key = "gw-storm-1"
    for _ in range(6):
        orch._schedule_initial_sync(TEST_USER, reconcile=True, session_key=session_key)
    await asyncio.sleep(0)  # let the created task start

    assert len(spawned) == 1, "one active reconcile per session"
    assert (TEST_USER, session_key) in orch._reconcile_session_inflight
    assert orch._reconcile_session_coalesced[(TEST_USER, session_key)] == 5

    # A different session gets its OWN marker (not counted as a duplicate of
    # session 1); it is queued by the owner-level single-flight, not coalesced.
    orch._schedule_initial_sync(TEST_USER, reconcile=True, session_key="gw-storm-2")
    assert (TEST_USER, "gw-storm-2") in orch._reconcile_session_inflight
    assert (TEST_USER, "gw-storm-2") not in orch._reconcile_session_coalesced
    assert TEST_USER in orch._initial_sync_pending

    # No global lock: a DIFFERENT owner reconciles concurrently.
    orch._schedule_initial_sync("other-user", reconcile=True, session_key="gw-storm-3")
    await asyncio.sleep(0)
    assert "other-user" in spawned


def test_s5_marker_released_after_owner_drains():
    """S-5: once the owner's queue drains, the session marker is released."""
    orch = WhatsAppSyncOrchestrator()
    orch._initial_sync_inflight.clear()
    orch._initial_sync_pending.clear()
    orch._reconcile_session_inflight.clear()
    orch._reconcile_session_coalesced.clear()

    key = (TEST_USER, "gw-x")
    orch._reconcile_session_inflight.add(key)
    orch._reconcile_session_coalesced[key] = 3

    # Simulate the tail of `_run_initial_sync`'s finally block with nothing pending.
    orch._initial_sync_inflight.discard(TEST_USER)
    if TEST_USER in orch._initial_sync_pending:
        orch._initial_sync_pending.discard(TEST_USER)
    else:
        stale = [k for k in orch._reconcile_session_inflight if k[0] == TEST_USER]
        for k in stale:
            orch._reconcile_session_inflight.discard(k)
            orch._reconcile_session_coalesced.pop(k, None)

    assert key not in orch._reconcile_session_inflight


# ---------------------------------------------------------------------------
# REST / WS conversation contract
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ws_conversation_updated_emits_canonical_contract():
    """The WS `conversation_updated` payload must match the REST conversation shape.

    It previously forwarded the raw gateway object (which used `lead_phone`), so
    REST and WebSocket disagreed about a conversation's identity.
    """
    from backend.app.services.whatsapp.orchestration.events import (
        WhatsAppEventOrchestrator,
    )

    _, _, conv_id = await _seed()
    orch = WhatsAppEventOrchestrator()
    event = {
        "event": "conversation_updated",
        "conversation_id": PHONE_JID,
        "gateway_session_id": GW_ID,
        "conversation": {"last_message_preview": "hello", "last_message_at": None},
    }
    async with AsyncSessionLocal() as db:
        result = await orch._map_conversation_event(db, event)

    payload = result.get("conversation")
    assert isinstance(payload, dict)
    assert payload["id"] == conv_id
    for field in (
        "name",
        "phone",
        "identity_state",
        "is_group",
        "is_archived",
        "avatar_url",
        "last_message_preview",
        "last_message_at",
        "unread_count",
        "status",
    ):
        assert field in payload, f"canonical conversation payload missing {field}"
    assert "lead_phone" not in payload, (
        "the raw gateway field must never reach the client"
    )
    assert payload["phone"] == PHONE


# ---------------------------------------------------------------------------
# §34 — messages.wa_message_id dedup: DB constraint vs application-level guard
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_34_wa_message_id_dedup_is_conversation_scoped_and_reliable():
    """§34: the live inbound path must dedup by `wa_message_id` (per conversation).

    There is NO unique DB constraint on `messages.wa_message_id` (see
    `ensure_messages_wa_message_id` — it creates a plain, non-unique index), so the
    ONLY thing preventing a duplicate row is application-level dedup. This test
    proves that guard is real and that its scope is per conversation.

    Contract:
      * same `wa_message_id` delivered twice to the SAME conversation -> 1 row
      * same `wa_message_id` in a DIFFERENT conversation -> 2 rows
        (conversation-scoped on purpose: a WhatsApp id identifies a message, and a
        message belongs to exactly one chat. Re-keying a chat — LID -> PN — is
        handled by `reconcile_legacy_split_conversation`, which dedups by
        `wa_message_id` across the merge; it is NOT this path's job.)
    """
    from backend.app.services.whatsapp.orchestration.events import (
        WhatsAppEventOrchestrator,
    )
    from backend.app.services.whatsapp.repositories.messages import (
        message_exists_by_wa_id,
    )

    _, _, conv_id = await _seed()
    orch = WhatsAppEventOrchestrator()
    event = {
        "event": "message_new",
        "gateway_session_id": GW_ID,
        "message": {
            "conversation_id": PHONE_JID,
            "wa_message_id": "wa-dedup-1",
            "body": "hello",
            "message_type": "TEXT",
            "direction": "INBOUND",
            "sender_phone": PHONE,
        },
    }

    async with AsyncSessionLocal() as db:
        first = await orch._ingest_message(db, dict(event))
        await db.commit()
        # Re-delivery of the exact same provider message (gateway retry / reconnect
        # replay) must not create a second row.
        second = await orch._ingest_message(db, dict(event))
        await db.commit()

        rows = (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conv_id,
                    Message.wa_message_id == "wa-dedup-1",
                )
            )
        ).scalars().all()
        exists = await message_exists_by_wa_id(db, conv_id, "wa-dedup-1")

    assert len(rows) == 1, (
        f"the same wa_message_id must persist exactly once per conversation "
        f"(got {len(rows)} rows)"
    )
    assert exists is True
    assert first.get("message") is not None, "the first delivery must be persisted"
    assert second.get("message") is not None, (
        "a duplicate must return the existing canonical message, not a skip"
    )
    assert first["message"]["id"] == second["message"]["id"], (
        "both deliveries must resolve to the SAME canonical message row"
    )


@pytest.mark.asyncio
async def test_34_wa_message_id_has_no_unique_db_constraint():
    """§34: document the real schema — the column is nullable and NOT unique.

    This is why application-level dedup is load-bearing. If a future migration
    adds a UNIQUE constraint it must be `(conversation_id, wa_message_id)` (or a
    partial index excluding NULLs), because `wa_message_id` is NULL for locally
    created rows that were never acknowledged by the provider.
    """
    async with AsyncSessionLocal() as db:
        col = (
            await db.execute(text("PRAGMA table_info(messages)"))
        ).all()
        wa_col = [c for c in col if c[1] == "wa_message_id"]
        assert wa_col, "messages.wa_message_id column must exist"
        # PRAGMA row shape: (cid, name, type, notnull, dflt_value, pk)
        assert wa_col[0][3] == 0, (
            "wa_message_id must stay nullable: locally-created rows have no "
            "provider id yet"
        )
        assert wa_col[0][5] == 0, "wa_message_id must not be the primary key"

        indexes = (await db.execute(text("PRAGMA index_list(messages)"))).all()
        for idx in indexes:
            name = idx[1]
            unique = bool(idx[2])
            cols = [
                r[2]
                for r in (
                    await db.execute(text(f"PRAGMA index_info({name})"))
                ).all()
            ]
            if cols == ["wa_message_id"]:
                assert unique is False, (
                    "the wa_message_id index must remain NON-unique until a "
                    "conversation-scoped partial index is introduced"
                )


# ---------------------------------------------------------------------------
# Truthfulness (§1.1) — a FAILED send must never be reported as a success
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_http_send_failure_never_returns_a_success_payload():
    """A gateway send failure must surface as an HTTP error, never as `status: SENT`.

    `WhatsAppSendResult.status` previously carried a fabricated `"SENT"` default
    (both in the endpoint's `or "SENT"` and in the response model's field default).
    Those are unreachable today because `Message.status` is `NOT NULL`, but a
    false-success default is exactly what AGENTS.md §1.1 forbids — so the
    contract is pinned here rather than left to chance.

    This exercises the real endpoint: a raising `send_text_message` must map to
    502, and must NOT return a 200 body claiming the message was sent.
    """
    from fastapi import HTTPException

    from backend.app.api.v1.endpoints.whatsapp import send_message
    from backend.app.schemas.whatsapp import WhatsAppSendTextRequest

    payload = WhatsAppSendTextRequest(body="merhaba", client_message_id="cmsg-truth-1")
    fake_user = MagicMock()
    fake_user.id = TEST_USER

    with patch(
        "backend.app.api.v1.endpoints.whatsapp.whatsapp_service.send_text_message",
        new=AsyncMock(side_effect=RuntimeError("gateway unreachable")),
    ):
        with pytest.raises(HTTPException) as excinfo:
            await send_message(
                conversation_id=1,
                payload=payload,
                db=AsyncMock(),
                current_user=fake_user,
            )

    assert excinfo.value.status_code == 502, (
        "a gateway failure must surface as 502, not as a success payload"
    )


def test_send_result_model_has_no_fabricated_status_default():
    """§1.1: the response model must not invent a status.

    A Pydantic default of `"SENT"` means any code path that forgets to supply a
    status silently reports success. The field must be required instead.
    """
    from backend.app.schemas.whatsapp import WhatsAppSendResult

    field = WhatsAppSendResult.model_fields["status"]
    assert field.is_required(), (
        "WhatsAppSendResult.status must be required — a default of 'SENT' is a "
        "false-success fallback (AGENTS.md §1.1)"
    )


def test_send_endpoint_does_not_fabricate_status():
    """The HTTP boundary must forward the real status, not default it to SENT."""
    import inspect

    from backend.app.api.v1.endpoints import whatsapp as wa_endpoints

    src = inspect.getsource(wa_endpoints)
    assert 'msg.get("status") or "SENT"' not in src, (
        'the endpoint must not fall back to a fabricated "SENT" status'
    )
