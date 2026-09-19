"""Phase 4 / G-3 regression tests — cross-tenant LID isolation.

G-3 was the last open *security* item. `whatsapp_private.lid_mappings` is keyed
by `(session_id, lid_jid)` where `session_id` is the **gateway** session UUID.
The table has no `user_id`; the only route to a tenant is

    lid_mappings.session_id -> public.whatsapp_sessions.gateway_id -> .user_id

Three backend readers ignored that and resolved a LID with a bare
`WHERE lid_jid = :lid` scan across *every* tenant's rows:

  * ``orchestration/events.py``  `_upsert_contact`
  * ``orchestration/events.py``  `_ingest_contact_synced`
  * ``whatsapp_service.py``      `list_conversations`

A LID -> phone pair is a global WhatsApp protocol fact (production: 27 `lid_jid`
values appear in more than one tenant's session, and `COUNT(DISTINCT phone_jid)
= 1` for all of them). A global protocol fact is **not** a globally readable DB
row. These tests pin the isolation property itself, not today's data:

  Test A  same LID, two tenants, *different* phones -> each tenant sees its own
  Test B  same user, two sessions                   -> resolution still works
  Test C  mapping exists ONLY for tenant B          -> tenant A gets nothing

Test C is the critical security regression test.
"""

import pathlib
import re
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy import text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.orchestration.history_evidence import (
    get_history_evidence,
    is_history_exhausted_or_stalled,
)
from backend.app.services.whatsapp.repositories.lid_mappings import (
    resolve_lid_phone,
    resolve_lid_phones,
)

USER_A = "11111111-2222-3333-4444-555555555501"
USER_B = "11111111-2222-3333-4444-555555555502"

GW_A = "gw-phase4-g3-a"
GW_A2 = "gw-phase4-g3-a2"       # second line belonging to USER_A
GW_B = "gw-phase4-g3-b"
GW_ORPHAN = "gw-phase4-g3-orphan"  # a gateway session with no owning user

LID = "900000000000001@lid"
LID_SIBLING = "900000000000002@lid"
LID_B_ONLY = "900000000000003@lid"

PHONE_A = "+905321110001"
PHONE_A_JID = "905321110001@s.whatsapp.net"
PHONE_A2 = "+905321110002"
PHONE_A2_JID = "905321110002@s.whatsapp.net"
PHONE_B = "+905321110003"
PHONE_B_JID = "905321110003@s.whatsapp.net"

_ALL_GW = (GW_A, GW_A2, GW_B, GW_ORPHAN)
_ALL_USERS = (USER_A, USER_B)

_LID_DDL = (
    "CREATE TABLE IF NOT EXISTS lid_mappings ("
    " session_id TEXT NOT NULL,"
    " lid_jid TEXT NOT NULL,"
    " phone_jid TEXT NOT NULL,"
    " created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
    " PRIMARY KEY (session_id, lid_jid))"
)

# Same class of bug in a sibling table: `history_sync_states` is keyed by
# `(session_id, jid)` and `jid` is a NATURAL key that legitimately repeats across
# tenants (two tenants may both talk to the same phone number).
_HISTORY_DDL = (
    "CREATE TABLE IF NOT EXISTS history_sync_states ("
    " session_id TEXT NOT NULL,"
    " jid TEXT NOT NULL,"
    " state TEXT,"
    " provider_checked BOOLEAN DEFAULT 0,"
    " provider_exhausted BOOLEAN,"
    " provider_msgs_returned INTEGER,"
    " has_more BOOLEAN DEFAULT 1,"
    " stall_count INTEGER DEFAULT 0,"
    " completed_at TIMESTAMP,"
    " updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
    " PRIMARY KEY (session_id, jid))"
)

SHARED_JID = "905321119999@s.whatsapp.net"


async def _reset(db) -> None:
    """Removes only this module's rows; the shared test DB is never wiped."""
    for gw in _ALL_GW:
        await db.execute(
            text("DELETE FROM lid_mappings WHERE session_id = :sid"), {"sid": gw}
        )
        await db.execute(
            text("DELETE FROM history_sync_states WHERE session_id = :sid"), {"sid": gw}
        )
    await db.execute(
        text("DELETE FROM contacts WHERE user_id IN (:a, :b)"),
        {"a": USER_A, "b": USER_B},
    )
    await db.execute(
        text("DELETE FROM whatsapp_sessions WHERE gateway_id IN (:a, :b, :c, :d)"),
        {"a": GW_A, "b": GW_A2, "c": GW_B, "d": GW_ORPHAN},
    )
    await db.commit()


async def _add_mapping(db, gateway_session_id: str, lid: str, phone_jid: str) -> None:
    await db.execute(
        text(
            "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
            "VALUES (:sid, :lid, :pj, :ts)"
        ),
        {
            "sid": gateway_session_id,
            "lid": lid,
            "pj": phone_jid,
            "ts": datetime.now(timezone.utc).replace(tzinfo=None),
        },
    )


@pytest_asyncio.fixture
async def g3_db():
    """Real SQLite session + the two tenants' lines + a clean LID table."""
    async with AsyncSessionLocal() as db:
        await db.execute(text(_LID_DDL))
        await db.execute(text(_HISTORY_DDL))
        await db.commit()
        await _reset(db)

        # USER_A has two lines; USER_B has one; GW_ORPHAN has no owner at all.
        db.add(
            WhatsAppSession(
                user_id=USER_A,
                gateway_id=GW_A,
                session_name="Phase4 G3 A1",
                status=SessionStatus.CONNECTED,
                is_active=True,
                phone_number=PHONE_A,
            )
        )
        db.add(
            WhatsAppSession(
                user_id=USER_A,
                gateway_id=GW_A2,
                session_name="Phase4 G3 A2",
                status=SessionStatus.DISCONNECTED,
                is_active=True,
                phone_number=PHONE_A2,
            )
        )
        db.add(
            WhatsAppSession(
                user_id=USER_B,
                gateway_id=GW_B,
                session_name="Phase4 G3 B1",
                status=SessionStatus.CONNECTED,
                is_active=True,
                phone_number=PHONE_B,
            )
        )
        await db.commit()
        try:
            yield db
        finally:
            await _reset(db)


# ---------------------------------------------------------------------------
# Test A — same LID, two tenants, DIFFERENT phones: each sees its own
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_g3_test_a_same_lid_two_tenants_resolve_to_their_own_phone(g3_db):
    """A: `lid-A -> phone-A` for A and `lid-A -> phone-B` for B.

    The same LID deliberately maps to *different* phones in the two tenants, so
    a leak cannot be masked by the values happening to agree.
    """
    await _add_mapping(g3_db, GW_A, LID, PHONE_A_JID)
    await _add_mapping(g3_db, GW_B, LID, PHONE_B_JID)
    await g3_db.commit()

    got_a = await resolve_lid_phone(g3_db, LID, user_id=USER_A, gateway_session_id=GW_A)
    got_b = await resolve_lid_phone(g3_db, LID, user_id=USER_B, gateway_session_id=GW_B)

    assert got_a == PHONE_A_JID, "tenant A must resolve its own mapping"
    assert got_b == PHONE_B_JID, "tenant B must resolve its own mapping"
    assert got_a != got_b, "the two tenants must not collapse onto one phone"


@pytest.mark.asyncio
async def test_g3_test_a_upsert_contact_creates_two_distinct_contacts(g3_db):
    """A (reader path): `_upsert_contact` must not merge the two tenants."""
    await _add_mapping(g3_db, GW_A, LID, PHONE_A_JID)
    await _add_mapping(g3_db, GW_B, LID, PHONE_B_JID)
    await g3_db.commit()

    orch = WhatsAppEventOrchestrator()
    contact_a = await orch._upsert_contact(
        g3_db, USER_A, LID, None, None, gateway_session_id=GW_A
    )
    contact_b = await orch._upsert_contact(
        g3_db, USER_B, LID, None, None, gateway_session_id=GW_B
    )

    assert contact_a.phone_e164 == PHONE_A
    assert contact_b.phone_e164 == PHONE_B
    assert contact_a.id != contact_b.id


# ---------------------------------------------------------------------------
# Test B — same user, two sessions: resolution still works (no over-isolation)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_g3_test_b_same_user_second_session_still_resolves(g3_db):
    """B: the mapping is learned on A's line 2 and read from A's line 1.

    This is the anti-over-isolation guard: scoping must keep the *same user's*
    other sessions usable, otherwise LID resolution regresses in production.
    """
    await _add_mapping(g3_db, GW_A2, LID_SIBLING, PHONE_A2_JID)
    await g3_db.commit()

    got = await resolve_lid_phone(
        g3_db, LID_SIBLING, user_id=USER_A, gateway_session_id=GW_A
    )
    assert got == PHONE_A2_JID, "a sibling session of the SAME user must still resolve"


@pytest.mark.asyncio
async def test_g3_test_b_own_session_wins_over_sibling(g3_db):
    """B: with the LID on both of A's lines, the caller's own line wins."""
    await _add_mapping(g3_db, GW_A, LID, PHONE_A_JID)
    await _add_mapping(g3_db, GW_A2, LID, PHONE_A2_JID)
    await g3_db.commit()

    from_a1 = await resolve_lid_phone(
        g3_db, LID, user_id=USER_A, gateway_session_id=GW_A
    )
    from_a2 = await resolve_lid_phone(
        g3_db, LID, user_id=USER_A, gateway_session_id=GW_A2
    )
    assert from_a1 == PHONE_A_JID
    assert from_a2 == PHONE_A2_JID


# ---------------------------------------------------------------------------
# Test C — THE critical security regression test
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_g3_test_c_mapping_of_another_tenant_is_never_returned(g3_db):
    """C: the LID exists ONLY for tenant B. Tenant A must get nothing.

    This is the exact hole the old global `WHERE lid_jid = :lid` scan opened.
    """
    await _add_mapping(g3_db, GW_B, LID_B_ONLY, PHONE_B_JID)
    await g3_db.commit()

    got_a = await resolve_lid_phone(
        g3_db, LID_B_ONLY, user_id=USER_A, gateway_session_id=GW_A
    )
    assert got_a is None, "tenant A must NOT read tenant B's mapping row"

    # ...and tenant B still resolves it, so the guard is isolation, not breakage.
    got_b = await resolve_lid_phone(
        g3_db, LID_B_ONLY, user_id=USER_B, gateway_session_id=GW_B
    )
    assert got_b == PHONE_B_JID


@pytest.mark.asyncio
async def test_g3_test_c_upsert_contact_does_not_adopt_foreign_phone(g3_db):
    """C (reader path): A's contact must not be keyed by B's phone number."""
    await _add_mapping(g3_db, GW_B, LID_B_ONLY, PHONE_B_JID)
    await g3_db.commit()

    orch = WhatsAppEventOrchestrator()
    contact_a = await orch._upsert_contact(
        g3_db, USER_A, LID_B_ONLY, None, None, gateway_session_id=GW_A
    )
    assert contact_a.phone_e164 != PHONE_B, "must not adopt another tenant's phone"
    assert contact_a.user_id == USER_A

    # A keeps the LID as an unresolved placeholder instead of a foreign phone.
    assert contact_a.phone_e164 == f"jid:{LID_B_ONLY}"


@pytest.mark.asyncio
async def test_g3_test_c_batch_resolver_is_also_tenant_scoped(g3_db):
    """C: the `list_conversations` batch path must not leak either."""
    await _add_mapping(g3_db, GW_B, LID_B_ONLY, PHONE_B_JID)
    await _add_mapping(g3_db, GW_A, LID, PHONE_A_JID)
    await g3_db.commit()

    got_a = await resolve_lid_phones(g3_db, [LID, LID_B_ONLY], user_id=USER_A)
    assert got_a == {LID: PHONE_A_JID}, "only A's own row may appear"

    got_b = await resolve_lid_phones(g3_db, [LID, LID_B_ONLY], user_id=USER_B)
    assert got_b == {LID_B_ONLY: PHONE_B_JID}, "only B's own row may appear"


# ---------------------------------------------------------------------------
# Fail-closed edges
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_g3_orphan_session_mapping_is_readable_by_nobody(g3_db):
    """A mapping whose gateway session has no owning user belongs to no tenant."""
    await _add_mapping(g3_db, GW_ORPHAN, LID, PHONE_A_JID)
    await g3_db.commit()

    for uid in _ALL_USERS:
        assert await resolve_lid_phone(g3_db, LID, user_id=uid) is None
    assert await resolve_lid_phones(g3_db, [LID], user_id=USER_A) == {}


@pytest.mark.asyncio
async def test_g3_resolver_is_fail_closed_without_a_user(g3_db):
    """No `user_id` -> no result. Never fall back to a global scan."""
    await _add_mapping(g3_db, GW_A, LID, PHONE_A_JID)
    await g3_db.commit()

    assert await resolve_lid_phone(g3_db, LID, user_id=None) is None
    assert await resolve_lid_phone(g3_db, LID, user_id="") is None
    assert await resolve_lid_phones(g3_db, [LID], user_id=None) == {}


@pytest.mark.asyncio
async def test_g3_resolver_returns_none_for_unknown_lid(g3_db):
    assert await resolve_lid_phone(g3_db, "999999999999999@lid", user_id=USER_A) is None


# ---------------------------------------------------------------------------
# The same bug class in a sibling table: `history_sync_states`
# ---------------------------------------------------------------------------

async def _add_history_state(db, gateway_session_id: str, jid: str, state: str) -> None:
    await db.execute(
        text(
            "INSERT INTO history_sync_states "
            " (session_id, jid, state, provider_checked, provider_exhausted,"
            "  provider_msgs_returned, has_more, stall_count, updated_at) "
            "VALUES (:sid, :jid, :st, 1, 1, 42, 0, 0, :ts)"
        ),
        {
            "sid": gateway_session_id,
            "jid": jid,
            "st": state,
            "ts": datetime.now(timezone.utc).replace(tzinfo=None),
        },
    )


@pytest.mark.asyncio
async def test_g3_history_evidence_is_scoped_to_the_requesting_tenant(g3_db):
    """C (sibling table): evidence that exists only for tenant B is invisible to A.

    `jid` is a natural key — two tenants can both talk to the same phone number —
    so an unscoped `WHERE jid = :jid` returned another tenant's exhaustion state
    and provider message count.
    """
    await _add_history_state(g3_db, GW_B, SHARED_JID, "FULLY_EXHAUSTED")
    await g3_db.commit()

    # Tenant B sees its own evidence.
    ev_b = await get_history_evidence(g3_db, SHARED_JID, session_id=GW_B)
    assert ev_b["state"] == "FULLY_EXHAUSTED"
    assert ev_b["provider_msgs_returned"] == 42

    # Tenant A's own line has no row -> fail-closed default, never B's row.
    ev_a = await get_history_evidence(g3_db, SHARED_JID, session_id=GW_A)
    assert ev_a["state"] == "NOT_CHECKED", "tenant A must not read tenant B's evidence"
    assert ev_a["provider_msgs_returned"] == 0
    assert ev_a["has_more"] is True


@pytest.mark.asyncio
async def test_g3_history_evidence_requires_a_session_id(g3_db):
    """Fail-closed: no `session_id` must never degrade into a global scan."""
    await _add_history_state(g3_db, GW_B, SHARED_JID, "FULLY_EXHAUSTED")
    await g3_db.commit()

    for missing in (None, ""):
        ev = await get_history_evidence(g3_db, SHARED_JID, session_id=missing)
        assert ev["state"] == "NOT_CHECKED", (
            "an absent session id must not fall back to a cross-tenant read"
        )
        assert ev["provider_msgs_returned"] == 0

    # `is_history_exhausted_or_stalled` delegates, so it must fail closed too.
    assert await is_history_exhausted_or_stalled(g3_db, SHARED_JID, session_id=None) is False


def test_g3_history_evidence_has_no_unscoped_branch():
    """Source guard: the bare `WHERE jid = :jid` fallback may not return."""
    src = _code_only(
        _src("backend/app/services/whatsapp/orchestration/history_evidence.py")
    )
    assert "WHERE jid = :jid\n" not in src.replace("WHERE session_id = :sid AND jid = :jid", ""), (
        "history_sync_states must never be read by jid alone"
    )
    assert src.count("WHERE session_id = :sid AND jid = :jid") >= 2, (
        "every history_sync_states read must be session-scoped"
    )


# ---------------------------------------------------------------------------
# Anti-regression: the global lookup must not come back
# ---------------------------------------------------------------------------

_FORBIDDEN_GLOBAL_LID_SQL = (
    # the three removed global readers, verbatim
    "WHERE lid_jid = :lid ORDER BY created_at DESC LIMIT 1",
    "WHERE lid_jid = ANY(:lids)",
    "whatsapp_private.lid_mappings WHERE lid_jid",
)

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

_SOURCES = (
    "backend/app/services/whatsapp/orchestration/events.py",
    "backend/app/services/whatsapp_service.py",
)


def _src(rel: str) -> str:
    return (_REPO_ROOT / rel).read_text(encoding="utf-8")


def _code_only(src: str) -> str:
    """Source with COMMENT tokens dropped.

    The fix documents the removed global SQL verbatim in comments, so a raw
    substring scan would flag the explanation rather than the code. Only code
    matters here.
    """
    import io
    import tokenize

    kept = [
        tok.string
        for tok in tokenize.generate_tokens(io.StringIO(src).readline)
        if tok.type != tokenize.COMMENT
    ]
    return "\n".join(kept)


def test_g3_no_backend_reader_resolves_a_lid_globally():
    """Guards the fix itself: a bare, tenant-less LID lookup may not return."""
    for rel in _SOURCES:
        src = _code_only(_src(rel))
        for needle in _FORBIDDEN_GLOBAL_LID_SQL:
            assert needle not in src, f"global LID lookup reintroduced in {rel}: {needle}"


def test_g3_tenant_predicate_never_accepts_null_owners():
    """`get_user_filter` allows `IS NULL` under pytest — unusable as a boundary."""
    src = _code_only(_src("backend/app/services/whatsapp/repositories/lid_mappings.py"))
    # The module *documents* why get_user_filter is unsuitable; what matters is
    # that it is never imported or called.
    assert "import get_user_filter" not in src, (
        "the tenant boundary must not import get_user_filter"
    )
    assert "get_user_filter(" not in src, (
        "the tenant boundary must not call get_user_filter: under pytest it also "
        "matches `user_id IS NULL`, which would expose orphan rows"
    )
    assert "IS NOT NULL" in src


def test_g3_every_lid_reader_goes_through_the_scoped_resolver():
    """Both scoped entry points must actually be used by the readers."""
    events_src = _src("backend/app/services/whatsapp/orchestration/events.py")
    svc_src = _src("backend/app/services/whatsapp_service.py")

    assert len(re.findall(r"_resolve_lid_phone\(", events_src)) == 2, (
        "both events.py readers must call the scoped single-LID resolver"
    )
    assert "_resolve_lid_phones(" in svc_src, (
        "list_conversations must call the scoped batch resolver"
    )
    assert uuid.UUID(USER_A) and uuid.UUID(USER_B)  # ids stay canonical UUIDs
