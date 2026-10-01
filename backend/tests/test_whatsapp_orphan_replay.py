"""Owner-unresolved gateway events are HELD and replayed, never discarded.

PRODUCTION SYMPTOM (2026-10-01, reported as "Syafira QR ile baglanirken yazdi,
diyaloglarda gorunmuyor / telefondan yazdigim Tezlify'a dusmuyor"): a
`lid_mapped` event produced during QR pairing was rejected as ownerless and
thrown away.

Why one dropped event caused a visible identity failure: `_resolve_event_owner_
and_session` looks the session up by `gateway_id`, and during pairing the
`whatsapp_sessions` row does not exist yet, so it raises `EventOwnerUnresolved`.
The dispatch path caught that and returned — discarding the event. But the
`lid_mapped` handler is the ONLY caller of the LID identity repair
(`_heal_lid_contact_identity` + `reconcile_legacy_split_conversation`). Starving
it is what left the LID-keyed chat split from the phone-keyed one, which reads
to a user as "the contact is missing and my messages never arrived".

These checks pin the contract:

- an unresolvable event is queued (counted, bounded, TTL'd), not dropped,
- once the blocker clears and a later event for the SAME gateway session
  resolves, the held event is replayed and its effect lands in the database,
- a real `lid_mapped` orphan replays into the contact identity heal,
- expiry and overflow are DROPPED WITH A COUNT (a queue that silently discards
  would just move the same bug one layer down).
"""
import uuid as _uuid
from datetime import datetime
from unittest.mock import patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp.orchestration import events as events_mod

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
PHONE = "+905551112233"
JID = "905551112233@s.whatsapp.net"
OTHER_PHONE = "+905551119999"
OTHER_JID = "905551119999@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM messages WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM conversations WHERE user_id = :h AND channel = 'WHATSAPP'"),
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

    events_mod.reset_orphan_queue()
    await _wipe()
    yield
    await _wipe()
    events_mod.reset_orphan_queue()


async def _create_session(gateway_id: str) -> None:
    """The blocker clearing: the session row now exists."""
    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=TEST_USER,
                gateway_id=gateway_id,
                session_name="Orphan Hat",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
        )
        await db.commit()


async def _contact_phones():
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Contact.phone_e164).where(Contact.phone_e164.isnot(None))
            )
        ).all()
    return {str(r[0]) for r in rows}


def _contact_synced(gateway_id, jid=JID, name="Tutulan Kisi"):
    return {
        "event": "contact_synced",
        "gateway_session_id": gateway_id,
        "contact": {"id": jid, "name": name, "name_source": "addressbook"},
    }


@pytest.mark.asyncio
async def test_unresolved_owner_event_is_held_not_discarded():
    """The core inversion: no session row means 'not yet', not 'throw away'."""
    gw_id = "gw-orphan-hold-1"

    result = await ws.ingest_gateway_event(_contact_synced(gw_id))

    assert result is None, "an ownerless event still publishes nothing"
    stats = events_mod.orphan_queue_stats()
    assert stats["queued"] == 1, "the event must be HELD, not dropped"
    assert stats["dropped"] == 0
    assert gw_id in stats["sessions"]
    # It genuinely could not be written yet — this is not a silent success.
    assert PHONE not in await _contact_phones()


@pytest.mark.asyncio
async def test_held_event_is_replayed_once_the_owner_becomes_resolvable():
    """The whole point: the effect lands AFTER the blocker clears."""
    gw_id = "gw-orphan-replay-1"
    await ws.ingest_gateway_event(_contact_synced(gw_id))
    assert events_mod.orphan_queue_stats()["queued"] == 1
    assert PHONE not in await _contact_phones()

    await _create_session(gw_id)

    # A later, resolvable event for the SAME gateway session is the evidence
    # the blocker is gone; it must drain the held event.
    await ws.ingest_gateway_event(_contact_synced(gw_id, jid=OTHER_JID, name="Tetikleyen"))

    stats = events_mod.orphan_queue_stats()
    assert stats["queued"] == 0, "the held event must be drained"
    assert stats["replayed"] == 1
    phones = await _contact_phones()
    assert PHONE in phones, "the held event's effect must be in the database"
    assert OTHER_PHONE in phones


@pytest.mark.asyncio
async def test_lid_mapped_orphan_replays_into_the_identity_heal():
    """The exact production case, end to end.

    A `lid_mapped` arrives while the QR session has no row yet. Once the row
    exists, the held event must replay and the LID-keyed contact must be re-keyed
    onto the canonical phone number — that repair is what makes the chat stop
    looking split/missing.
    """
    gw_id = "gw-orphan-lid-1"
    lid = "111111111111111@lid"
    lid_phone = f"jid:{lid}"

    # A LID-keyed contact exists (this is what the heal has to fix).
    async with AsyncSessionLocal() as db:
        db.add(Contact(user_id=TEST_USER, phone_e164=lid_phone, display_name="Syafira"))
        await db.commit()
    assert lid_phone in await _contact_phones()

    orphan = {
        "event": "lid_mapped",
        "gateway_session_id": gw_id,
        "lid": lid,
        "phone_jid": JID,
    }
    await ws.ingest_gateway_event(orphan)

    stats = events_mod.orphan_queue_stats()
    assert stats["queued"] == 1, "the lid_mapped event must be held"
    assert lid_phone in await _contact_phones(), "nothing healed yet — owner was unknown"

    await _create_session(gw_id)
    await ws.ingest_gateway_event(_contact_synced(gw_id, jid=OTHER_JID, name="Tetikleyen"))

    stats = events_mod.orphan_queue_stats()
    assert stats["replayed"] >= 1, "the held lid_mapped must replay"
    phones = await _contact_phones()
    assert PHONE in phones, "the LID contact must be re-keyed onto the phone number"
    assert lid_phone not in phones, "the LID-keyed row must not survive the heal"


@pytest.mark.asyncio
async def test_expired_held_events_are_dropped_with_a_count():
    """Held forever is its own bug: the TTL bounds the wait, and the eviction
    is counted so it can never be mistaken for a successful replay."""
    gw_id = "gw-orphan-ttl-1"
    await ws.ingest_gateway_event(_contact_synced(gw_id))
    assert events_mod.orphan_queue_stats()["queued"] == 1

    # Age the entry past the TTL.
    events_mod._orphan_queue[0]["queued_at"] -= events_mod._ORPHAN_TTL_SECONDS + 1.0

    await _create_session(gw_id)
    await ws.ingest_gateway_event(_contact_synced(gw_id, jid=OTHER_JID, name="Tetikleyen"))

    stats = events_mod.orphan_queue_stats()
    assert stats["queued"] == 0
    assert stats["dropped"] == 1, "an expired event is dropped, and that is counted"
    assert PHONE not in await _contact_phones(), "an expired event must not be applied"


def test_queue_is_bounded_and_counts_overflow():
    """A pathological stream must not grow memory — and must not pretend the
    overflow was handled."""
    events_mod.reset_orphan_queue()
    over = 25
    for i in range(events_mod._ORPHAN_QUEUE_MAX + over):
        events_mod._enqueue_orphan_event(
            {"event": "contact_synced", "gateway_session_id": f"gw-overflow-{i}"},
            "owner_unresolved:contact_synced",
        )

    stats = events_mod.orphan_queue_stats()
    assert stats["queued"] == events_mod._ORPHAN_QUEUE_MAX
    assert stats["dropped"] == over, "every eviction must be counted"
    events_mod.reset_orphan_queue()


@pytest.mark.asyncio
async def test_replay_does_not_recurse_when_still_unresolvable():
    """Re-entrancy guard: a still-ownerless replay is re-held, not retried in
    place, so a permanently orphaned event cannot spin."""
    gw_id = "gw-orphan-noloop-1"
    await ws.ingest_gateway_event(_contact_synced(gw_id))
    await _create_session(gw_id)

    calls = {"n": 0}
    real_drain = events_mod.WhatsAppEventOrchestrator._drain_orphan_queue

    async def counting_drain(self, gateway_session_id):
        calls["n"] += 1
        return await real_drain(self, gateway_session_id)

    with patch.object(
        events_mod.WhatsAppEventOrchestrator, "_drain_orphan_queue", counting_drain
    ):
        await ws.ingest_gateway_event(
            _contact_synced(gw_id, jid=OTHER_JID, name="Tetikleyen")
        )

        # Drain #1 replays the held event. That replay dispatches again, which
        # reaches the trigger a second time — but the guard must stop it there.
        assert calls["n"] <= 2, (
            "replay must not re-enter the drain unboundedly "
            f"(observed {calls['n']} calls)"
        )

    assert events_mod.orphan_queue_stats()["queued"] == 0
    assert PHONE in await _contact_phones()
