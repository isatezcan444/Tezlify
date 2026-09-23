"""Phase 2.1.A — Group discovery / group subject hydration falsification.

ROOT CAUSE (audited in §A/§B/§C/§D/§E):
  A zero-message `@g.us` group whose jid is NOT in `store.chats` (because
  `groupFetchAllParticipating` omitted it, failed, or no message has ever
  passed through the session) has no path to a `groupMetadata` call on the
  gateway. The gateway-side `_pendingGroupJids` set (Phase 2.A) only
  collects jids that `_touchChat` has already seen, so it cannot help a
  true zero-message group.

  The remaining path is: backend bootstrap pulls the list of known `@g.us`
  jids from the DB and forwards them to the gateway as `extraJids`. The
  gateway's `_ensureGroupSubjects({extraJids})` then calls
  `groupMetadata` on each, populating `store.chats` via
  `seedGroupChat` / `applySubject` and emitting `conversation_updated`
  so the backend can persist the conversation.

  This module's first three tests (a/b/c) pin the new invariants:
    a. the backend exposes a helper that returns DB-known @g.us jids
       (generic — no hardcoded 3Hacker, no hardcoded jid).
    b. the gateway's `_ensureGroupSubjects({extraJids})` actually
       iterates `extraJids` and calls `groupMetadata` for each (the
       pre-fix targeted fallback only saw `chats.values()`).
    c. partial failure isolation — one failing jid does not abort the
       hydration of the others.

  Pre-fix (Phase 2.A, before this fix): the helper does not exist or
  returns `[]`; the targeted fallback never sees the jid; the test
  fails. Post-fix: the test passes for any @g.us jid (generic).

  Tests d–g pin the secondary invariants from the spec:
    d. duplicate extraJids produce no duplicate groupMetadata calls.
    e. an @g.us jid that already has a non-raw subject in store.chats
       does NOT trigger a redundant groupMetadata call.
    f. session lifecycle: cancelling the in-flight pass stops
       groupMetadata but does not leave the in-flight flag set.
    g. _pendingGroupJids is honoured even when store.chats has no
       entry for the jid (the Phase 2.A tracker is exercised end-to-end).
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus


# ----------------------------------------------------------------------------
# (a) Backend must expose a generic `_hydrate_known_groups` helper.
# ----------------------------------------------------------------------------
class TestBackendHydrateKnownGroups:
    """The backend is the source of truth for known `@g.us` jids. Without a
    generic helper that pulls them from the DB, the gateway has no input
    for the targeted-fallback pass for zero-message groups."""

    @pytest.mark.asyncio
    async def test_hydrate_known_groups_returns_db_known_group_jids(self):
        """A helper exists on the orchestrator that returns the set of
        jids where is_group=true and the row is owned by the given user.
        Generic — no hardcoded fixture, no hardcoded 3Hacker jid."""
        from backend.app.services.whatsapp.orchestration.sync import WhatsAppSyncOrchestrator

        orch = WhatsAppSyncOrchestrator()
        # The helper must be a coroutine function that takes (db, owner)
        # and returns a list of strings.
        helper = getattr(orch, "_hydrate_known_groups", None)
        assert helper is not None, (
            "Backend must expose `_hydrate_known_groups(db, owner)` so the "
            "gateway can receive DB-known @g.us jids. This is the fix for "
            "the 3Hacker-class bug (zero-message group with no path to "
            "groupMetadata)."
        )
        assert asyncio.iscoroutinefunction(helper), (
            "_hydrate_known_groups must be async (DB read is async)."
        )

        # Build a mock DB session that returns two known group jids.
        # The helper selects Contact.phone_e164 via a Conversation→Contact
        # join and reads `result.fetchall()` (not `scalars.all()`).
        db = MagicMock(spec=AsyncSession)
        result = MagicMock()
        result.fetchall.return_value = [
            ("120363000000001@g.us",),
            ("120363000000002@g.us",),
        ]
        db.execute = AsyncMock(return_value=result)

        out = await helper(db, "user-A")
        assert isinstance(out, (list, set)), "helper must return a list or set"
        out_set = set(out)
        assert "120363000000001@g.us" in out_set
        assert "120363000000002@g.us" in out_set
        assert all("@g.us" in jid for jid in out_set), (
            "helper must filter to @g.us jids only; broadcast / direct / "
            "LID jids must NOT leak through."
        )
        # Sentinel-shape must be de-prefixed: `jid:120363...@g.us` → bare 120363...@g.us
        result.fetchall.return_value = [
            ("jid:120363000000003@g.us",),
        ]
        out2 = await helper(db, "user-A")
        assert "120363000000003@g.us" in set(out2)
        assert "jid:120363000000003@g.us" not in set(out2), (
            "helper must strip the `jid:` sentinel prefix before emitting "
            "group jids to the gateway."
        )


# ----------------------------------------------------------------------------
# (b) Gateway `_ensureGroupSubjects` must iterate `extraJids` and call
#     `groupMetadata` for each — pre-fix this was a no-op because the
#     targeted fallback only saw `chats.values()`.
# ----------------------------------------------------------------------------
#
# Gateway has no test runner. The minimal generic observable for this
# invariant is the GATEWAY SOURCE itself: the targeted-fallback loop
# must read `extraJids` and call `groupMetadata(jid)`. We pin the source
# invariant by reading the file and checking for the union construction
# (the Phase 2.A union is a generic, jid-agnostic mechanism).
#
# This is a structural test (not a behavioural one). It is a degradation
# from a true falsification test, but it is the strongest test we can
# write without a gateway test runner. The test is named honestly to
# reflect that.


def test_gateway_targeted_fallback_iterates_extraJids():
    """Structural: the targeted-fallback loop in
    `whatsapp-gateway/src/session-manager.js::_ensureGroupSubjects` must
    iterate `extraJids` as one of the union sources. Pre-fix (pre-2.A)
    the loop only iterated `chats.values()`."""
    import os

    path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "whatsapp-gateway",
        "src",
        "session-manager.js",
    )
    with open(path) as fh:
        src = fh.read()

    assert "extraJids" in src, (
        "session-manager.js must reference `extraJids`; the targeted "
        "fallback must accept a caller-supplied jid list (the path for "
        "the backend to forward DB-known @g.us jids to the gateway)."
    )
    # Find the `_ensureGroupSubjects` body and assert it iterates extraJids.
    assert "for (const jid of extraJids)" in src, (
        "session-manager.js::_ensureGroupSubjects must iterate "
        "`extraJids`; without this loop the targeted fallback is "
        "invisible to caller-supplied jids (the 3Hacker class of bug)."
    )


# ----------------------------------------------------------------------------
# (c) Partial failure isolation — one jid failing must not abort the
#     others. This is the gateway's existing per-iteration try/except
#     around `groupMetadata`. We assert the structural invariant.
# ----------------------------------------------------------------------------
def test_gateway_targeted_fallback_partial_failure_isolated():
    """Structural: a `try {} catch {}` per `groupMetadata` call in the
    targeted fallback must exist so one failing jid does not abort the
    rest of the hydration pass."""
    import os

    path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "whatsapp-gateway",
        "src",
        "session-manager.js",
    )
    with open(path) as fh:
        src = fh.read()

    # The pre-fix shape was a single outer try { for (...) try { meta } catch {} }
    # We assert that the catch on the inner block exists, by checking that
    # the file contains the pattern used in `_ensureGroupSubjects`.
    assert "} catch { /* ignored */ }" in src, (
        "session-manager.js must have a per-jid catch around "
        "groupMetadata so one failing jid does not abort the rest of "
        "the targeted-fallback pass."
    )


# ----------------------------------------------------------------------------
# (d) Duplicate `extraJids` produce no duplicate `groupMetadata` calls.
#     Pin the dedup invariant via the source: the union is built as a
#     `Set` and `[...unresolvedKeys].slice(0, 10)` is taken ONCE.
# ----------------------------------------------------------------------------
def test_gateway_targeted_fallback_dedupes_extraJids():
    """Structural: the union of chats.values() ∪ _pendingGroupJids ∪
    extraJids is built as a Set, so duplicate jids across the three
    sources do not cause duplicate `groupMetadata` calls."""
    import os

    path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "whatsapp-gateway",
        "src",
        "session-manager.js",
    )
    with open(path) as fh:
        src = fh.read()
    # The targeted-fallback dedup uses Set semantics via `unresolvedKeys`
    # (a Set). After dedup, the pass slices to 10 — so the worst case
    # is 10 groupMetadata calls regardless of input size.
    assert "const unresolvedKeys = new Set();" in src, (
        "session-manager.js::_ensureGroupSubjects must build "
        "`unresolvedKeys` as a Set so duplicate extraJids / "
        "_pendingGroupJids / chats.values() entries do not produce "
        "duplicate groupMetadata calls."
    )
    assert "[...unresolvedKeys].slice(0, 10)" in src, (
        "The targeted pass must cap at 10 groupMetadata calls per "
        "invocation; this bounds the cost regardless of input size."
    )


# ----------------------------------------------------------------------------
# (e) Already-resolved @g.us jids in store.chats are NOT re-fetched.
#     The targeted pass filters out jids in `resolvedKeys` (set during
#     the broad groupFetchAllParticipating pass) AND skips chats whose
#     name is not raw.
# ----------------------------------------------------------------------------
def test_gateway_targeted_fallback_skips_already_resolved():
    """Structural: the targeted pass must skip a chat that already has a
    non-raw name (i.e. was resolved in a previous pass). The
    `isRawIdentityName(chat.name) || !chat.name` check is the gate."""
    import os

    path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "whatsapp-gateway",
        "src",
        "session-manager.js",
    )
    with open(path) as fh:
        src = fh.read()
    assert "(isRawIdentityName(c.name) || !c.name)" in src, (
        "The targeted pass must skip chats whose name is already "
        "non-raw (resolved by a prior pass). Re-fetching would be "
        "wasteful and could regress a higher-rank name."
    )


# ----------------------------------------------------------------------------
# (f) Session lifecycle — cancel must not leave the in-flight flag set.
#     The targeted pass checks `session._groupSubjectsInFlight ===
#     'cancelled'` and `finally` clears the flag.
# ----------------------------------------------------------------------------
def test_gateway_targeted_fallback_finally_clears_inflight():
    """Structural: the targeted pass must be wrapped in a try/finally
    that always clears `session._groupSubjectsInFlight` so a cancellation
    does not deadlock subsequent invocations."""
    import os

    path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "whatsapp-gateway",
        "src",
        "session-manager.js",
    )
    with open(path) as fh:
        src = fh.read()
    # The finally block at the end of the targeted pass must clear
    # the in-flight flag.
    assert "session._groupSubjectsInFlight = false;" in src, (
        "session-manager.js::_ensureGroupSubjects must clear the "
        "in-flight flag in a `finally` block so a cancellation or "
        "exception does not deadlock subsequent invocations."
    )


# ----------------------------------------------------------------------------
# (g) _pendingGroupJids is honoured end-to-end. _touchChat adds
#     unresolved @g.us jids; _ensureGroupSubjects iterates them; the
#     pass clears them at the end so a stale entry does not persist
#     across restarts.
# ----------------------------------------------------------------------------
def test_gateway_pendingGroupJids_cleared_after_pass():
    """Structural: after the targeted pass, `session._pendingGroupJids`
    must be cleared so a stale entry does not survive a restart /
    reconnect and cause a redundant fetch on the next pass."""
    import os

    path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "whatsapp-gateway",
        "src",
        "session-manager.js",
    )
    with open(path) as fh:
        src = fh.read()
    assert "session._pendingGroupJids.clear()" in src, (
        "After the targeted pass, _pendingGroupJids MUST be cleared "
        "so a stale entry does not persist and force a redundant "
        "groupMetadata call on the next pass."
    )


# ----------------------------------------------------------------------------
# (h) End-to-end integration: backend bootstrap calls the gateway with
#     `extraJids=...` from the DB. This is the seam the fix closes.
#
#     Pre-fix: no such call exists. The bootstrap path does NOT touch
#     the gateway's `_ensureGroupSubjects` at all. The test asserts
#     the seam by mocking the gateway and the DB and observing what
#     the bootstrap does.
# ----------------------------------------------------------------------------
class TestBackendBootstrapForwardsExtraJids:
    """The backend bootstrap is responsible for forwarding the
    DB-known @g.us jid list to the gateway. The seam is closed if a
    single bootstrap entry point can be invoked with a `user_id` and
    produces a `gw._ensureGroupSubjects(extraJids=...)` call."""

    @pytest.mark.asyncio
    async def test_bootstrap_forwards_db_known_groups_to_gateway(self):
        """A backend bootstrap entry point must:
          1. Read the known @g.us jid list from the DB (via
             `_hydrate_known_groups`).
          2. Call the gateway's `ensureGroupSubjects` (or equivalent
             gateway entry) with `extraJids=<that list>`.
          3. The list is the DB-truth, not a hardcoded jid.

        Phase 2.A closure note: pre-fix this test was VACUOUS (it only
        instantiated the orchestrator and asserted nothing), and
        `_schedule_group_hydration` had NO production caller. Both are
        closed: this test now proves the helper forwards `extraJids`, and
        `test_sync_conversations_routes_hydration_with_extraJids` proves
        the runtime sync path actually routes through it.
        """
        from unittest.mock import AsyncMock, MagicMock, patch

        from backend.app.services.whatsapp.orchestration import sync as sync_mod
        from backend.app.services.whatsapp.orchestration.sync import WhatsAppSyncOrchestrator

        orch = WhatsAppSyncOrchestrator()
        db = MagicMock(spec=AsyncSession)
        result = MagicMock()
        result.fetchall.return_value = [
            ("120363000000001@g.us",),
            ("jid:120363000000002@g.us",),
        ]
        db.execute = AsyncMock(return_value=result)

        captured: dict = {}

        async def _fake_sync(gateway_id, force=False, extraJids=None):
            captured["gateway_id"] = gateway_id
            captured["force"] = force
            captured["extraJids"] = list(extraJids or [])
            return {"applied": True, "reason": None}

        fake_gw = MagicMock()
        fake_gw.sync_group_subjects = AsyncMock(side_effect=_fake_sync)

        with patch.object(sync_mod, "gw", fake_gw):
            out = await orch._schedule_group_hydration(db, "user-A", "gw-1", force=True)

        assert out == {"applied": True, "reason": None}
        assert captured["gateway_id"] == "gw-1"
        assert captured["force"] is True, "runtime sync path must force the pass (10-min throttle would swallow extraJids)"
        assert set(captured["extraJids"]) == {
            "120363000000001@g.us",
            "120363000000002@g.us",
        }, "DB-known @g.us jids (de-prefixed) must be forwarded as extraJids"

    def test_sync_conversations_routes_hydration_with_extraJids(self):
        """Structural: the production conversation-sync path
        (`_sync_conversations_impl`) must route its group-subjects sync
        through `_schedule_group_hydration(..., force=True)` — the only
        seam that attaches DB-known `extraJids`. A bare
        `sync_group_subjects(gid, force=True)` call means `extraJids` is
        test-only and the production fix does not exist."""
        import inspect

        from backend.app.services.whatsapp.orchestration.sync import WhatsAppSyncOrchestrator

        src = inspect.getsource(WhatsAppSyncOrchestrator._sync_conversations_impl)
        assert "_schedule_group_hydration(db, user_id, gid, force=True)" in src, (
            "_sync_conversations_impl must call _schedule_group_hydration "
            "with force=True so DB-known @g.us jids reach the gateway as "
            "extraJids in production (3Hacker-class discovery)."
        )
        assert "gateway_client.sync_group_subjects(gid, force=True)" not in src, (
            "the bare force=True gateway call must NOT bypass the "
            "extraJids-forwarding helper"
        )

