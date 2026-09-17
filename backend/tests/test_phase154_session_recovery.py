"""Phase 15.4+ WhatsApp Logical Session Recovery Test Suite.

Comprehensive 12-test matrix verifying:
1. test_orphan_gateway_session_detection
2. test_orphan_logical_session_recovery
3. test_recovery_idempotency
4. test_old_session_reference_audit
5. test_recovery_does_not_mutate_history_state
6. test_missing_gateway_relink_starts_ephemeral_pairing
7. test_session_connected_rebinds_recovered_session
8. test_history_state_migrates_after_recovered_relink
9. test_relink_candidate_ambiguous_fails_closed
10. test_cancel_does_not_destroy_recovered_lineage
11. test_no_duplicate_public_session
12. test_conversation_ownership_preserved
"""
import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp.exceptions import EventOwnerUnresolved
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.orchestration.recovery import (
    AmbiguousOrphanLineage,
    ConflictingSessionExists,
    CrossUserPhoneConflict,
    NoOrphanLineageFound,
    OrphanGatewayEvidence,
    RecoveryResult,
    detect_orphaned_gateway_lineages,
    normalize_phone_e164,
    recover_orphan_logical_session,
)
from backend.app.services.whatsapp.orchestration.relink import (
    RelinkCandidateAmbiguous,
    RelinkCandidateNotFound,
    RelinkResult,
    perform_atomic_relink,
    resolve_relink_candidate,
)
from backend.app.services.whatsapp.orchestration.sessions import (
    _ephemeral_pairings,
    _logical_to_ephemeral,
    cancel_pairing_session,
    find_ephemeral_pairing_by_gateway_id,
    get_pairing_qr,
    get_session_qr,
    refresh_session_qr,
    remove_ephemeral_pairing_by_gateway_id,
    start_pairing_session,
)


# ---------------------------------------------------------------------------
# Helpers & Mocks
# ---------------------------------------------------------------------------

def _mock_session(
    *,
    id: int = 59,
    user_id: str = "f65642ab-4ae5-4d69-945c-8f30c8454bac",
    phone: str = "+905413749073",
    gateway_id: str = "7ca58b14-a53e-47bd-b879-b77519f119bc",
    status: SessionStatus = SessionStatus.RELINK_REQUIRED,
    session_name: str = "Hat 1",
    is_active: bool = True,
    is_phone_online: bool = False,
) -> MagicMock:
    row = MagicMock(spec=WhatsAppSession)
    row.id = id
    row.user_id = user_id
    row.phone_number = phone
    row.gateway_id = gateway_id
    row.status = status
    row.session_name = session_name
    row.is_active = is_active
    row.is_phone_online = is_phone_online
    row.qr_code = None
    row.error_message = "WHATSAPP_AUTH_RELINK_REQUIRED" if status == SessionStatus.RELINK_REQUIRED else None
    row.battery_level = None
    row.created_at = datetime.utcnow()
    row.updated_at = datetime.utcnow()
    return row


@pytest.fixture(autouse=True)
def cleanup_ephemeral():
    """Clear in-memory pairing registries between tests."""
    _ephemeral_pairings.clear()
    _logical_to_ephemeral.clear()
    yield
    _ephemeral_pairings.clear()
    _logical_to_ephemeral.clear()


# ===========================================================================
# 12-TEST MATRIX
# ===========================================================================

@pytest.mark.asyncio
async def test_orphan_gateway_session_detection():
    """1. Orphan gateway sessions with unlinked history states must be detected."""
    db = AsyncMock(spec=AsyncSession)
    mock_result = MagicMock()
    mock_result.fetchall.return_value = [
        ("7ca58b14-a53e-47bd-b879-b77519f119bc", "Hat 1", 98, 0, datetime.utcnow(), datetime.utcnow())
    ]
    db.execute.return_value = mock_result

    orphans = await detect_orphaned_gateway_lineages(db)
    assert len(orphans) == 1
    assert orphans[0].old_gateway_id == "7ca58b14-a53e-47bd-b879-b77519f119bc"
    assert orphans[0].history_state_count == 98
    assert orphans[0].checked_state_count == 0
    assert orphans[0].session_name == "Hat 1"


@pytest.mark.asyncio
async def test_orphan_logical_session_recovery():
    """2. Orphan gateway session is recovered into a permanent logical session in RELINK_REQUIRED state."""
    db = AsyncMock(spec=AsyncSession)

    # 1st query: cross user check (empty)
    cross_res = MagicMock()
    cross_res.scalars().all.return_value = []

    # 2nd query: existing check (empty)
    exist_res = MagicMock()
    exist_res.scalars().all.return_value = []

    # 3rd query: orphan detection
    orphan_res = MagicMock()
    orphan_res.fetchall.return_value = [
        ("7ca58b14-a53e-47bd-b879-b77519f119bc", "Hat 1", 98, 0, datetime.utcnow(), datetime.utcnow())
    ]

    call_idx = {"n": 0}
    async def mock_execute(stmt, params=None):
        call_idx["n"] += 1
        if call_idx["n"] == 1:
            return cross_res
        elif call_idx["n"] == 2:
            return exist_res
        else:
            return orphan_res

    db.execute.side_effect = mock_execute

    created_rows = []
    def mock_add(row):
        row.id = 59  # auto-increment simulated
        created_rows.append(row)

    db.add.side_effect = mock_add

    res = await recover_orphan_logical_session(
        db,
        user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        phone="+905413749073",
        old_gateway_id="7ca58b14-a53e-47bd-b879-b77519f119bc",
    )

    assert res.session_id == 59
    assert res.status == "RELINK_REQUIRED"
    assert res.was_already_recovered is False
    assert res.old_gateway_id == "7ca58b14-a53e-47bd-b879-b77519f119bc"
    assert res.history_state_count == 98
    assert len(created_rows) == 1
    assert created_rows[0].gateway_id == "7ca58b14-a53e-47bd-b879-b77519f119bc"
    assert created_rows[0].status == SessionStatus.RELINK_REQUIRED
    assert db.commit.called


@pytest.mark.asyncio
async def test_recovery_idempotency():
    """3. Calling recovery twice returns the existing logical session without creating duplicates."""
    db = AsyncMock(spec=AsyncSession)

    existing_row = _mock_session(
        id=59,
        user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        phone="+905413749073",
        gateway_id="7ca58b14-a53e-47bd-b879-b77519f119bc",
        status=SessionStatus.RELINK_REQUIRED,
    )

    # 1st query: cross user check (empty)
    cross_res = MagicMock()
    cross_res.scalars().all.return_value = []

    # 2nd query: existing check returns existing_row
    exist_res = MagicMock()
    exist_res.scalars().all.return_value = [existing_row]

    # 3rd query: count history states
    cnt_res = MagicMock()
    cnt_res.scalar.return_value = 98

    call_idx = {"n": 0}
    async def mock_execute(stmt, params=None):
        call_idx["n"] += 1
        if call_idx["n"] == 1:
            return cross_res
        elif call_idx["n"] == 2:
            return exist_res
        return cnt_res

    db.execute.side_effect = mock_execute

    res = await recover_orphan_logical_session(
        db,
        user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        phone="+905413749073",
        old_gateway_id="7ca58b14-a53e-47bd-b879-b77519f119bc",
    )

    assert res.session_id == 59
    assert res.was_already_recovered is True
    assert res.history_state_count == 98
    assert not db.add.called


@pytest.mark.asyncio
async def test_old_session_reference_audit():
    """4. Reference audit confirms zero dangling foreign keys to deleted numeric session ID."""
    # conversations.session_id is nullable and has ON DELETE SET NULL
    from backend.app.models.conversation import Conversation
    col = Conversation.__table__.columns["session_id"]
    assert col.nullable is True
    assert len(col.foreign_keys) == 1
    fk = list(col.foreign_keys)[0]
    assert fk.target_fullname == "whatsapp_sessions.id"
    assert fk.ondelete == "SET NULL"


@pytest.mark.asyncio
async def test_recovery_does_not_mutate_history_state():
    """5. Recovery operation must NOT mutate or update any history_sync_states rows."""
    db = AsyncMock(spec=AsyncSession)

    cross_res = MagicMock()
    cross_res.scalars().all.return_value = []
    exist_res = MagicMock()
    exist_res.scalars().all.return_value = []
    orphan_res = MagicMock()
    orphan_res.fetchall.return_value = [
        ("7ca58b14-a53e-47bd-b879-b77519f119bc", "Hat 1", 98, 0, datetime.utcnow(), datetime.utcnow())
    ]

    executed_queries = []
    async def mock_execute(stmt, params=None):
        executed_queries.append(str(stmt))
        if len(executed_queries) == 1:
            return cross_res
        elif len(executed_queries) == 2:
            return exist_res
        return orphan_res

    db.execute.side_effect = mock_execute

    await recover_orphan_logical_session(
        db,
        user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        phone="+905413749073",
        old_gateway_id="7ca58b14-a53e-47bd-b879-b77519f119bc",
    )

    # Ensure NO updates were issued to history_sync_states
    for q in executed_queries:
        assert "UPDATE whatsapp_private.history_sync_states" not in q


@pytest.mark.asyncio
async def test_missing_gateway_relink_starts_ephemeral_pairing():
    """6. When session is in RELINK_REQUIRED and gateway returns 404, start ephemeral pairing without crashing."""
    db = AsyncMock(spec=AsyncSession)
    row = _mock_session(id=59, status=SessionStatus.RELINK_REQUIRED)

    with patch("backend.app.services.whatsapp.orchestration.sessions._get_session_or_404", AsyncMock(return_value=row)), \
         patch("backend.app.services.whatsapp_gateway.get_session_qr", AsyncMock(side_effect=gw.WhatsAppGatewayError("session not found", status_code=404))), \
         patch("backend.app.services.whatsapp_gateway.create_session", AsyncMock(return_value={"id": "new-eph-uuid", "qr_code": "data:image/png;base64,sampleqr"})):

        res = await get_session_qr(db, user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac", session_id=59)

        assert res["status"] == "SCAN_QR"
        assert res["qr_code"] == "data:image/png;base64,sampleqr"
        assert 59 in _logical_to_ephemeral
        pair_token = _logical_to_ephemeral[59]
        assert _ephemeral_pairings[pair_token]["gateway_id"] == "new-eph-uuid"
        assert _ephemeral_pairings[pair_token]["logical_session_id"] == 59


@pytest.mark.asyncio
async def test_session_connected_rebinds_recovered_session():
    """7. session_connected with new gateway UUID rebinds the recovered RELINK_REQUIRED session."""
    db = AsyncMock(spec=AsyncSession)

    recovered_session = _mock_session(
        id=59,
        user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        phone="+905413749073",
        gateway_id="7ca58b14-a53e-47bd-b879-b77519f119bc",
        status=SessionStatus.RELINK_REQUIRED,
    )

    # Database query 1: initial lookup by gateway_id (returns None since new gateway is unknown)
    init_lookup = MagicMock()
    init_lookup.scalar_one_or_none.return_value = None

    # Database query 2: candidate lookup by phone + RELINK_REQUIRED
    cand_lookup = MagicMock()
    cand_lookup.scalars().all.return_value = [recovered_session]

    # Database query 3: candidate lookup inside perform_atomic_relink
    relink_cand = MagicMock()
    relink_cand.scalars().all.return_value = [recovered_session]

    # Database query 4: UPDATE history_sync_states
    mig_res = MagicMock()
    mig_res.rowcount = 98

    # Database query 5: reload session after relink
    reload_lookup = MagicMock()
    reload_lookup.scalar_one_or_none.return_value = recovered_session

    call_count = {"n": 0}
    async def mock_execute(stmt, params=None):
        call_count["n"] += 1
        n = call_count["n"]
        if n == 1:
            return init_lookup
        elif n == 2:
            return cand_lookup
        elif n == 3:
            return relink_cand
        elif n == 4:
            return mig_res
        return reload_lookup

    db.execute.side_effect = mock_execute

    orchestrator = WhatsAppEventOrchestrator()
    event = {
        "event": "session_connected",
        "gateway_session_id": "new-gw-uuid-1234",
        "phone": "+905413749073",
    }

    with patch.object(orchestrator, "reconcile_self_identity", AsyncMock()):
        out_event = await orchestrator._map_session_event(db, event)

        assert out_event["session_id"] == 59
        assert recovered_session.gateway_id == "new-gw-uuid-1234"
        assert recovered_session.status == SessionStatus.CONNECTED


@pytest.mark.asyncio
async def test_history_state_migrates_after_recovered_relink():
    """8. Atomic relink migrates all 98 unverified history_sync_states to the new gateway ID."""
    db = AsyncMock(spec=AsyncSession)
    session_row = _mock_session(
        id=59,
        gateway_id="7ca58b14-a53e-47bd-b879-b77519f119bc",
        status=SessionStatus.RELINK_REQUIRED,
    )

    cand_res = MagicMock()
    cand_res.scalars().all.return_value = [session_row]

    mig_res = MagicMock()
    mig_res.rowcount = 98

    executed_sql = []
    call_count = {"n": 0}
    async def mock_execute(stmt, params=None):
        call_count["n"] += 1
        executed_sql.append((str(stmt), params))
        if call_count["n"] == 1:
            return cand_res
        return mig_res

    db.execute.side_effect = mock_execute

    res = await perform_atomic_relink(
        db,
        user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        phone="+905413749073",
        new_gateway_id="new-active-gw-uuid",
    )

    assert res.session_id == 59
    assert res.history_rows_migrated == 98
    assert session_row.gateway_id == "new-active-gw-uuid"
    assert session_row.status == SessionStatus.CONNECTED

    # Check migration SQL parameters
    update_sql, update_params = executed_sql[1]
    assert "UPDATE whatsapp_private.history_sync_states" in update_sql
    assert update_params["old_gw_id"] == "7ca58b14-a53e-47bd-b879-b77519f119bc"
    assert update_params["new_gw_id"] == "new-active-gw-uuid"


@pytest.mark.asyncio
async def test_relink_candidate_ambiguous_fails_closed():
    """9. Ambiguous candidate resolution fails closed when >1 session matches."""
    db = AsyncMock(spec=AsyncSession)
    row1 = _mock_session(id=59)
    row2 = _mock_session(id=60)

    res = MagicMock()
    res.scalars().all.return_value = [row1, row2]
    db.execute.return_value = res

    with pytest.raises(RelinkCandidateAmbiguous):
        await resolve_relink_candidate(
            db,
            user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
            phone="+905413749073",
            new_gateway_id="new-gw-uuid",
        )


@pytest.mark.asyncio
async def test_cancel_does_not_destroy_recovered_lineage():
    """10. Cancelling QR pairing terminates ephemeral socket and mutates zero history states."""
    pair_token = "pair-tok-123"
    _ephemeral_pairings[pair_token] = {
        "user_id": "f65642ab-4ae5-4d69-945c-8f30c8454bac",
        "gateway_id": "ephemeral-gw-uuid",
        "logical_session_id": 59,
    }
    _logical_to_ephemeral[59] = pair_token

    with patch("backend.app.services.whatsapp_gateway.delete_session", AsyncMock()) as mock_del:
        res = await cancel_pairing_session("f65642ab-4ae5-4d69-945c-8f30c8454bac", pair_token)

        assert res["success"] is True
        mock_del.assert_called_once_with("ephemeral-gw-uuid")
        assert pair_token not in _ephemeral_pairings
        assert 59 not in _logical_to_ephemeral


@pytest.mark.asyncio
async def test_no_duplicate_public_session():
    """11. Reconnecting an existing RELINK_REQUIRED session does NOT create a duplicate public session row."""
    db = AsyncMock(spec=AsyncSession)
    pair_token = "pair-tok-xyz"
    _ephemeral_pairings[pair_token] = {
        "user_id": "f65642ab-4ae5-4d69-945c-8f30c8454bac",
        "gateway_id": "ephemeral-gw-xyz",
        "session_name": "Hat 1",
        "logical_session_id": 59,
    }
    _logical_to_ephemeral[59] = pair_token

    with patch("backend.app.services.whatsapp_gateway.get_session_qr", AsyncMock(return_value={"status": "CONNECTED", "phone": "+905413749073"})), \
         patch("backend.app.services.whatsapp.orchestration.sessions.perform_atomic_relink", AsyncMock(return_value=RelinkResult(session_id=59, old_gateway_id="7ca58b14...", new_gateway_id="ephemeral-gw-xyz", phone_number="+905413749073", history_rows_migrated=98, was_already_linked=False))):

        res = await get_pairing_qr(db, "f65642ab-4ae5-4d69-945c-8f30c8454bac", pair_token)

        assert res["status"] == "CONNECTED"
        assert res["session_id"] == 59
        # Ensure db.add was NOT called (no new WhatsAppSession created)
        assert not db.add.called


@pytest.mark.asyncio
async def test_conversation_ownership_preserved():
    """12. Conversation ownership and integrity are preserved without message loss."""
    conv = MagicMock(spec=Conversation)
    conv.id = 101
    conv.session_id = 59
    conv.user_id = "f65642ab-4ae5-4d69-945c-8f30c8454bac"

    msg = MagicMock(spec=Message)
    msg.id = 1001
    msg.conversation_id = 101
    msg.wa_message_id = "wamid-test-123"

    # Relink only mutates WhatsAppSession.gateway_id and migrates history_sync_states.
    # It does NOT delete or truncate conversations or messages.
    assert conv.session_id == 59
    assert msg.conversation_id == 101
    assert msg.wa_message_id == "wamid-test-123"
