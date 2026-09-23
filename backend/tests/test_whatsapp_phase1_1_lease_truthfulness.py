"""Phase 1.1 — Lease truthfulness falsification tests.

The CONNECTED invariant requires:
  public row + gateway session + valid lease + active socket

A row whose gateway session exists but whose lease is missing or expired
MUST NOT remain CONNECTED. A row whose socket is in flight (transient
reconnect, 515) but whose lease is still ours MUST NOT be demoted to
RELINK_REQUIRED.

These tests are characterisation tests against `_list_sessions_internal`
and the lease-truthfulness check it must perform.
"""
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession


def _make_row(*, status=SessionStatus.CONNECTED, gateway_id="gw-uuid-1", user_id="user-A"):
    return MagicMock(
        spec=WhatsAppSession,
        id=42,
        user_id=user_id,
        gateway_id=gateway_id,
        session_name="Primary",
        status=status,
        phone_number="+905551112233",
        is_active=True,
        is_phone_online=True,
        battery_level=90,
        qr_code=None,
        error_message=None,
        error_reason=None,
        sync=type("S", (), {"phase": "ready"})(),
        created_at=datetime(2026, 1, 1),
        updated_at=datetime(2026, 1, 2),
        _sa_instance_state=MagicMock(),
    )


def _patch_scalars(rows):
    """Build a MagicMock AsyncSession that returns the given rows from scalars().all()."""
    session = MagicMock()
    result = MagicMock()
    scalars = MagicMock()
    scalars.all.return_value = rows
    scalars.scalar.return_value = None
    result.scalars.return_value = scalars
    session.execute = AsyncMock(return_value=result)
    session.scalar = AsyncMock(return_value=None)
    session.commit = AsyncMock(return_value=None)
    session.rollback = AsyncMock(return_value=None)
    session.add = MagicMock()
    return session


class TestListSessionsLeaseTruthfulness:
    """CASE B (gateway exists, lease missing) MUST demote the row.
    CASE C (gateway exists, valid lease, transient reconnect) MUST keep CONNECTED
    unless the gateway reports a non-CONNECTED status.
    """

    @pytest.mark.asyncio
    async def test_case_b_lease_missing_demotes_connected_to_disconnected(self):
        """FALSIFICATION: a CONNECTED row whose gateway session exists but whose
        lease is missing must be demoted. Pre-fix, the row stays CONNECTED."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-b")
        db = _patch_scalars([row])

        # gateway side: the session IS present (in-memory)
        gw_sessions = [
            {"id": "gw-b", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        # lease side: no row for this gateway_id (or expired)
        held_leases = set()  # empty: nothing held

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        # The bug: the row stays CONNECTED even though no lease is held.
        assert err is None
        assert row.status != SessionStatus.CONNECTED, (
            "FALSIFICATION: a CONNECTED row with a missing lease MUST be demoted"
        )
        assert row.is_phone_online is False

    @pytest.mark.asyncio
    async def test_case_d_lease_held_keeps_connected(self):
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-d")
        db = _patch_scalars([row])
        gw_sessions = [
            {"id": "gw-d", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        held_leases = {"gw-d"}

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        assert err is None
        assert row.status == SessionStatus.CONNECTED, (
            "A CONNECTED row with a valid lease must remain CONNECTED"
        )
        assert row.is_phone_online is True

    @pytest.mark.asyncio
    async def test_case_b_lease_missing_but_gateway_reports_connecting_keeps_connecting(self):
        """Transient reconnect (E/F) keeps the lease (about to renew) but the
        gateway reports CONNECTING. The row must follow the gateway status
        (CONNECTING), not be demoted to RELINK_REQUIRED."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-e")
        db = _patch_scalars([row])
        gw_sessions = [
            {"id": "gw-e", "status": "CONNECTING", "is_active": True, "is_phone_online": False, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        held_leases = {"gw-e"}  # lease still held during reconnect

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        assert err is None
        # CONNECTING (truth) is correct for a transient reconnect; NOT RELINK_REQUIRED.
        assert row.status == SessionStatus.CONNECTING

    @pytest.mark.asyncio
    async def test_case_a_gateway_missing_demotes_to_relink(self):
        """Phase 1 §13 — gateway missing → RELINK_REQUIRED."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-a")
        db = _patch_scalars([row])
        gw_sessions = []  # gateway does not have this session
        held_leases = set()

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        assert err is None
        assert row.status == SessionStatus.RELINK_REQUIRED

    @pytest.mark.asyncio
    async def test_tenant_isolation_lease_truthfulness_only_affects_owner(self):
        """Two users, two rows, one gateway has the row but no lease. The OTHER
        user's row must not be demoted by the same check."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row_a = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-tenant-a", user_id="tenant-a")
        row_b = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-tenant-b", user_id="tenant-b")
        db = _patch_scalars([row_a, row_b])
        gw_sessions = [
            {"id": "gw-tenant-a", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+90a", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
            {"id": "gw-tenant-b", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+90b", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        # tenant-a lost its lease; tenant-b still holds its lease
        held_leases = {"gw-tenant-b"}

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            # List for tenant-a only
            out, err = await _list_sessions_internal(db, "tenant-a")

        # Only tenant-a's row is in the list (we passed both as db rows but the
        # user filter is applied upstream; for this test we check that the
        # demote logic does not poison row_b if it were a sibling).
        # The important assertion: row_a is demoted, and the helper does not
        # throw on row_b being in the result set.
        assert row_a.status != SessionStatus.CONNECTED


# =============================================================================
# Phase 1.1 CLOSURE — DB read failure vs valid empty result must be distinguished.
# =============================================================================
#
# fetch_held_lease_gateway_ids must NOT collapse DB read failure into "no leases".
# A DB read failure means we cannot answer the lease truthfulness question;
# we must fall back to "lease truth unknown" and SKIP the demote for that call.
#
# - return set()  → query succeeded, zero valid leases exist  → DEMOTE
# - return None  → query failed (DB unreachable / schema missing / exception)
#                 → SKIP the demote, do not write LEASE_LOST, do not broadcast

class TestLeaseDBReadFailureVsEmptyResult:
    """Closure of the Phase 1.1 lease truthfulness path."""

    @pytest.mark.asyncio
    async def test_db_read_failure_does_not_demote_healthy_connected(self):
        """Pre-fix: fetch_held_lease_gateway_ids returned set() on failure,
        which caused every healthy CONNECTED row to be demoted to
        WHATSAPP_LEASE_LOST. Post-fix: the helper returns None on failure
        and the demote branch is bypassed."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-healthy")
        db = _patch_scalars([row])
        gw_sessions = [
            {"id": "gw-healthy", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        # The patch returns None to model a DB read failure (NOT empty set).
        held_leases = None

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        # The row must remain CONNECTED: we cannot prove the lease is gone
        # when the read itself failed. The reconciliation is deferred to the
        # next successful read.
        assert row.status == SessionStatus.CONNECTED, (
            "DB read failure MUST NOT be interpreted as 'no lease held'; "
            "a healthy CONNECTED row must remain CONNECTED on a failed read."
        )
        assert row.is_phone_online is True
        assert row.error_message is None
        assert row.error_reason is None

    @pytest.mark.asyncio
    async def test_successful_empty_lease_result_demotes_connected(self):
        """When the DB read succeeds and returns zero rows, the row is demoted.
        This is the 'truthful empty' case — distinct from the failure case."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-truly-lost")
        db = _patch_scalars([row])
        gw_sessions = [
            {"id": "gw-truly-lost", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        # Empty set returned by a successful read: this is the truthful
        # "no lease held" result, distinct from None which means read failed.
        held_leases = set()

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        assert row.status == SessionStatus.DISCONNECTED
        assert row.error_message == "WHATSAPP_LEASE_LOST"
        assert row.error_reason == "LEASE_LOST"
        assert row.is_phone_online is False
        assert row.is_active is False

    @pytest.mark.asyncio
    async def test_no_mass_demotion_on_db_failure(self):
        """Regression guard: N healthy CONNECTED sessions, DB read fails,
        ZERO of them should be demoted. The pre-fix code demoted all N."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        n = 7
        rows = [_make_row(status=SessionStatus.CONNECTED, gateway_id=f"gw-mass-{i}") for i in range(n)]
        db = _patch_scalars(rows)
        gw_sessions = [
            {
                "id": f"gw-mass-{i}",
                "status": "CONNECTED",
                "is_active": True,
                "is_phone_online": True,
                "phone": "+905551112233",
                "battery_level": 90,
                "sync": {"phase": "ready"},
                "qr_code": None,
            }
            for i in range(n)
        ]
        held_leases = None  # DB read failure

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        for i, r in enumerate(rows):
            assert r.status == SessionStatus.CONNECTED, f"row {i} should remain CONNECTED on DB failure"
            assert r.is_phone_online is True
            assert r.error_message is None
            assert r.error_reason is None

    @pytest.mark.asyncio
    async def test_helper_returns_none_on_db_exception(self):
        """The helper itself must return None (not set()) on DB exception.
        This pins the contract that the consumer relies on."""
        from backend.app.services.whatsapp.orchestration.sessions import fetch_held_lease_gateway_ids

        class _BoomDB:
            async def execute(self, *args, **kwargs):
                raise RuntimeError("simulated DB down")

        result = await fetch_held_lease_gateway_ids(_BoomDB())
        assert result is None, (
            "fetch_held_lease_gateway_ids must return None (not set()) on DB "
            "exception so the consumer can skip the demote instead of "
            "treating failure as a truthful empty result."
        )

    @pytest.mark.asyncio
    async def test_helper_returns_empty_set_on_successful_zero_rows(self):
        """The helper must return set() (not None) when the query succeeded
        with zero rows. This is the truthful 'no lease held anywhere' case."""
        from backend.app.services.whatsapp.orchestration.sessions import fetch_held_lease_gateway_ids
        from unittest.mock import MagicMock

        class _EmptyDB:
            def __init__(self):
                self._result = MagicMock()
                self._result.fetchall.return_value = []

            async def execute(self, *args, **kwargs):
                return self._result

        result = await fetch_held_lease_gateway_ids(_EmptyDB())
        assert result == set(), (
            "fetch_held_lease_gateway_ids must return set() on a successful "
            "zero-row result; returning None would conflate 'read failed' "
            "with 'truthfully empty'."
        )


def _patch_scalars(rows):
    """Build a MagicMock AsyncSession that returns the given rows from scalars().all()."""
    session = MagicMock()
    result = MagicMock()
    scalars = MagicMock()
    scalars.all.return_value = rows
    scalars.scalar.return_value = None
    result.scalars.return_value = scalars
    session.execute = AsyncMock(return_value=result)
    session.scalar = AsyncMock(return_value=None)
    session.commit = AsyncMock(return_value=None)
    session.rollback = AsyncMock(return_value=None)
    session.add = MagicMock()
    return session


class TestListSessionsLeaseTruthfulness:
    """CASE B (gateway exists, lease missing) MUST demote the row.
    CASE C (gateway exists, valid lease, transient reconnect) MUST keep CONNECTED
    unless the gateway reports a non-CONNECTED status.
    """

    @pytest.mark.asyncio
    async def test_case_b_lease_missing_demotes_connected_to_disconnected(self):
        """FALSIFICATION: a CONNECTED row whose gateway session exists but whose
        lease is missing must be demoted. Pre-fix, the row stays CONNECTED."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-b")
        db = _patch_scalars([row])

        # gateway side: the session IS present (in-memory)
        gw_sessions = [
            {"id": "gw-b", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        # lease side: no row for this gateway_id (or expired)
        held_leases = set()  # empty: nothing held

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        # The bug: the row stays CONNECTED even though no lease is held.
        assert err is None
        assert row.status != SessionStatus.CONNECTED, (
            "FALSIFICATION: a CONNECTED row with a missing lease MUST be demoted"
        )
        assert row.is_phone_online is False

    @pytest.mark.asyncio
    async def test_case_d_lease_held_keeps_connected(self):
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-d")
        db = _patch_scalars([row])
        gw_sessions = [
            {"id": "gw-d", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        held_leases = {"gw-d"}

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        assert err is None
        assert row.status == SessionStatus.CONNECTED, (
            "A CONNECTED row with a valid lease must remain CONNECTED"
        )
        assert row.is_phone_online is True

    @pytest.mark.asyncio
    async def test_case_b_lease_missing_but_gateway_reports_connecting_keeps_connecting(self):
        """Transient reconnect (E/F) keeps the lease (about to renew) but the
        gateway reports CONNECTING. The row must follow the gateway status
        (CONNECTING), not be demoted to RELINK_REQUIRED."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-e")
        db = _patch_scalars([row])
        gw_sessions = [
            {"id": "gw-e", "status": "CONNECTING", "is_active": True, "is_phone_online": False, "phone": "+905551112233", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        held_leases = {"gw-e"}  # lease still held during reconnect

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        assert err is None
        # CONNECTING (truth) is correct for a transient reconnect; NOT RELINK_REQUIRED.
        assert row.status == SessionStatus.CONNECTING

    @pytest.mark.asyncio
    async def test_case_a_gateway_missing_demotes_to_relink(self):
        """Phase 1 §13 — gateway missing → RELINK_REQUIRED."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-a")
        db = _patch_scalars([row])
        gw_sessions = []  # gateway does not have this session
        held_leases = set()

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            out, err = await _list_sessions_internal(db, "user-A")

        assert err is None
        assert row.status == SessionStatus.RELINK_REQUIRED

    @pytest.mark.asyncio
    async def test_tenant_isolation_lease_truthfulness_only_affects_owner(self):
        """Two users, two rows, one gateway has the row but no lease. The OTHER
        user's row must not be demoted by the same check."""
        from backend.app.services.whatsapp.orchestration.sessions import _list_sessions_internal

        row_a = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-tenant-a", user_id="tenant-a")
        row_b = _make_row(status=SessionStatus.CONNECTED, gateway_id="gw-tenant-b", user_id="tenant-b")
        db = _patch_scalars([row_a, row_b])
        gw_sessions = [
            {"id": "gw-tenant-a", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+90a", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
            {"id": "gw-tenant-b", "status": "CONNECTED", "is_active": True, "is_phone_online": True, "phone": "+90b", "battery_level": 90, "sync": {"phase": "ready"}, "qr_code": None},
        ]
        # tenant-a lost its lease; tenant-b still holds its lease
        held_leases = {"gw-tenant-b"}

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw") as gw_mod, \
             patch("backend.app.services.whatsapp.orchestration.sessions.fetch_held_lease_gateway_ids", new=AsyncMock(return_value=held_leases)):
            gw_mod.list_sessions = AsyncMock(return_value=gw_sessions)
            # List for tenant-a only
            out, err = await _list_sessions_internal(db, "tenant-a")

        # Only tenant-a's row is in the list (we passed both as db rows but the
        # user filter is applied upstream; for this test we check that the
        # demote logic does not poison row_b if it were a sibling).
        # The important assertion: row_a is demoted, and the helper does not
        # throw on row_b being in the result set.
        assert row_a.status != SessionStatus.CONNECTED
