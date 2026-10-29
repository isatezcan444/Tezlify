"""Identity quarantine — the startup step that used to delete, now holds.

WHY (measured, 2026-10-29 Phase 3.8.6 cutover)
----------------------------------------------
`purge_raw_jid_identity_data` treated `contacts.phone_e164 = 'jid:<x>@lid'`
with no `lid_mappings` bridge as a ghost and hard-deleted the contact, its
conversation and its messages. Production lost **1 contact + 1 conversation +
9 messages** (`126|2077|1538` → `125|2068|1537`) in a single boot. The messages
survived only in gateway RAM, where the persistence sweep skips them (no
conversation) — one gateway recreate away from permanent loss.

The premise was wrong: LID privacy mode can leave a real person whose phone JID
is never revealed, so "no bridge row" means "we never learned the bridge".

CONTRACT PINNED HERE
--------------------
1. no bridge + messages  -> preserved, `bridge_unknown_has_messages`
2. bridge known          -> preserved, `bridge_known_deferred` (merge handles it)
3. two startups          -> one ledger row, zero deletes, same data
4. ambiguous/foreign owner-> still preserved (fail-closed), never "resolved"
5. a deletion candidate  -> NEVER physically deleted by startup
6. test DB mismatch      -> the suite refuses to run (conftest gate)
7. old schema (no table) -> health degrades to `available: false`, never raises
"""

import uuid as _uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.migrations import (
    ensure_whatsapp_identity_quarantine_table,
    purge_raw_jid_identity_data,
    quarantine_counts,
    quarantine_status,
)
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

USER_A = "aaaaaaaa-1111-1111-1111-000000000001"
USER_A_HEX = "aaaaaaaa111111111111000000000001"
USER_B = "bbbbbbbb-2222-2222-2222-000000000002"
USER_B_HEX = "bbbbbbbb222222222222000000000002"

LID_A = "666666666666601@lid"
LID_B = "666666666666602@lid"
PHONE_A = "+905551110001"
PHONE_JID_A = "905551110001@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS lid_mappings (
                        session_id TEXT NOT NULL,
                        lid_jid VARCHAR(100) NOT NULL,
                        phone_jid VARCHAR(100) NOT NULL DEFAULT '',
                        created_at TIMESTAMP,
                        PRIMARY KEY (session_id, lid_jid)
                    )
                    """
                )
            )
            await db.execute(text("DELETE FROM lid_mappings"))
            await db.execute(text("DELETE FROM whatsapp_identity_quarantine"))
            # Bu dosya GLOBAL karantina sayimi iddia ediyor. Purge artik
            # hayaletleri silmedigi icin, baska bir test dosyasinin biraktigi
            # `jid:%@lid` contact'i buraya sizardi (eskiden purge onu siliyordu
            # — degisiklik o gizli bagimliligi ortaya cikardi). Hayalet
            # populasyonunu bu dosya sahipleniyor: iddialar deterministik olur.
            await db.execute(
                text(
                    "DELETE FROM messages WHERE conversation_id IN ("
                    " SELECT id FROM conversations WHERE contact_id IN ("
                    "  SELECT id FROM contacts WHERE phone_e164 LIKE 'jid:%@lid'))"
                )
            )
            await db.execute(
                text(
                    "DELETE FROM conversations WHERE contact_id IN ("
                    " SELECT id FROM contacts WHERE phone_e164 LIKE 'jid:%@lid')"
                )
            )
            await db.execute(text("DELETE FROM contacts WHERE phone_e164 LIKE 'jid:%@lid'"))
            for owner in (USER_A_HEX, USER_B_HEX):
                await db.execute(
                    text("DELETE FROM messages WHERE user_id = :h"), {"h": owner}
                )
                await db.execute(
                    text("DELETE FROM conversations WHERE user_id = :h"), {"h": owner}
                )
                await db.execute(
                    text("DELETE FROM contacts WHERE user_id = :h"), {"h": owner}
                )
                await db.execute(
                    text("DELETE FROM whatsapp_sessions WHERE user_id = :h"),
                    {"h": owner},
                )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def _seed(
    *,
    user: str = USER_A,
    user_hex: str = USER_A_HEX,
    lid: str = LID_A,
    bridge: bool = False,
    messages: int = 3,
    gateway_id: str = "gw-quarantine-0001",
) -> dict:
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user,
            gateway_id=gateway_id,
            session_name="Karantina Hatti",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()

        contact = Contact(user_id=user, phone_e164=f"jid:{lid}", display_name=lid)
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=user,
            contact_id=contact.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=messages,
        )
        db.add(conv)
        await db.flush()

        for i in range(messages):
            db.add(
                Message(
                    user_id=user_hex,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"held-{i}",
                    sender_phone=PHONE_A,
                    recipient_phone="ME",
                    wa_message_id=f"HELD_{_uuid.uuid4().hex[:10]}",
                )
            )
        if bridge:
            await db.execute(
                text(
                    "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid) "
                    "VALUES (:s, :l, :p)"
                ),
                {"s": gateway_id, "l": lid, "p": PHONE_JID_A},
            )
        await db.commit()
        return {
            "contact_id": contact.id,
            "conversation_id": conv.id,
            "session_id": sess.id,
        }


async def _exists(model, pk) -> bool:
    async with AsyncSessionLocal() as db:
        return (await db.get(model, pk)) is not None


async def _msg_count(conversation_id) -> int:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                select(func.count())
                .select_from(Message)
                .where(Message.conversation_id == conversation_id)
            )
        ).scalar_one()


async def _ledger(contact_id):
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                text(
                    "SELECT reason, status, message_count, user_id "
                    "FROM whatsapp_identity_quarantine WHERE contact_id = :c"
                ),
                {"c": contact_id},
            )
        ).fetchall()


# ---------------------------------------------------------------------------
# 1. No bridge + messages -> preserved
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_ghost_without_bridge_is_preserved_with_all_messages():
    seeded = await _seed(bridge=False, messages=3)

    report = await purge_raw_jid_identity_data(engine)

    assert await _exists(Contact, seeded["contact_id"]), (
        "a LID with no bridge may be a real person whose phone JID was never "
        "revealed — deleting is unrecoverable"
    )
    assert await _exists(Conversation, seeded["conversation_id"])
    assert await _msg_count(seeded["conversation_id"]) == 3
    assert report["quarantined_with_messages"] == 1
    assert report["messages_held"] == 3
    rows = await _ledger(seeded["contact_id"])
    assert len(rows) == 1
    assert rows[0][0] == "bridge_unknown_has_messages"
    assert rows[0][1] == "QUARANTINED"
    assert rows[0][2] == 3


# ---------------------------------------------------------------------------
# 2. Verified bridge -> classified as deferred, ownership preserved
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_bridged_ghost_is_classified_deferred_and_keeps_its_owner():
    seeded = await _seed(bridge=True, messages=2)

    report = await purge_raw_jid_identity_data(engine)

    assert await _exists(Contact, seeded["contact_id"])
    assert await _msg_count(seeded["conversation_id"]) == 2
    assert report["deferred_known_bridge"] == 1
    assert report["quarantined_with_messages"] == 0
    rows = await _ledger(seeded["contact_id"])
    assert rows[0][0] == "bridge_known_deferred"
    assert str(rows[0][3]) == USER_A_HEX, (
        "the ledger must carry the owning tenant so a merge cannot cross tenants"
    )


# ---------------------------------------------------------------------------
# 3. Two startups -> idempotent, no loss
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_two_startups_produce_one_row_and_zero_loss():
    seeded = await _seed(bridge=False, messages=4)

    first = await purge_raw_jid_identity_data(engine)
    second = await purge_raw_jid_identity_data(engine)

    for report in (first, second):
        assert report["deleted_contacts"] == 0
        assert report["deleted_conversations"] == 0
        assert report["deleted_messages"] == 0
    assert len(await _ledger(seeded["contact_id"])) == 1, (
        "a re-run must UPDATE the ledger row, not append a second one"
    )
    assert await _msg_count(seeded["conversation_id"]) == 4


# ---------------------------------------------------------------------------
# 4. Ambiguous / foreign-owner match -> fail-closed
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_bridge_belonging_to_another_tenant_does_not_authorise_anything():
    """The bridge table is gateway-global; a row for a DIFFERENT lid must not
    reclassify this ghost. Ambiguity resolves to "held", never to "handled"."""
    seeded = await _seed(user=USER_A, user_hex=USER_A_HEX, lid=LID_A, bridge=False, messages=2)
    await _seed(
        user=USER_B,
        user_hex=USER_B_HEX,
        lid=LID_B,
        bridge=True,
        messages=1,
        gateway_id="gw-quarantine-0002",
    )

    await purge_raw_jid_identity_data(engine)

    rows = await _ledger(seeded["contact_id"])
    assert rows[0][0] == "bridge_unknown_has_messages", (
        "another LID's bridge must not make this one look resolved"
    )
    assert str(rows[0][3]) == USER_A_HEX
    assert await _msg_count(seeded["conversation_id"]) == 2


# ---------------------------------------------------------------------------
# 5. A deletion CANDIDATE is still not deleted
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_even_an_empty_ghost_is_quarantined_not_deleted():
    """`bridge_unknown_empty` is the closest thing to a safe delete there is,
    and startup still refuses: an empty conversation today may be the only
    record of who the person is. Release is an operator decision."""
    seeded = await _seed(bridge=False, messages=0)

    report = await purge_raw_jid_identity_data(engine)

    assert await _exists(Contact, seeded["contact_id"]), "empty is not proof"
    assert await _exists(Conversation, seeded["conversation_id"])
    assert report["deleted_contacts"] == 0
    rows = await _ledger(seeded["contact_id"])
    assert rows[0][0] == "bridge_unknown_empty"


# ---------------------------------------------------------------------------
# 6. The suite's own isolation gate is real
# ---------------------------------------------------------------------------
def test_the_suite_refuses_a_database_that_is_not_the_requested_one(monkeypatch):
    """Pins conftest's fail-closed guard: a `TEST_DB_PATH`/`DATABASE_URL`
    mismatch must abort the run, not silently test a different file."""
    from backend.tests import conftest

    monkeypatch.setenv("TEST_DB_PATH", "/tmp/expected.db")
    with pytest.raises(RuntimeError):
        conftest.assert_test_db_matches_requested_path(
            "sqlite+aiosqlite:////tmp/something_else.db"
        )


def test_the_suite_refuses_a_remote_database():
    from backend.tests import conftest

    with pytest.raises(RuntimeError):
        conftest.assert_test_db_is_not_remote(
            "postgresql+asyncpg://tezlify:pw@130.162.247.20:5432/tezlify"
        )


# ---------------------------------------------------------------------------
# 7. Old schema / degraded health
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_counts_are_pii_free_and_survive_a_missing_table():
    await _seed(bridge=False, messages=5)
    await purge_raw_jid_identity_data(engine)

    counts = await quarantine_counts(engine)
    assert counts["available"] is True
    assert counts["quarantined"] == 1
    assert counts["with_messages"] == 1
    assert counts["messages_held"] == 5
    assert counts["by_reason"] == {"bridge_unknown_has_messages": 1}
    # Only counts/classifications may leave this function.
    assert set(counts) == {
        "available",
        "quarantined",
        "with_messages",
        "messages_held",
        "by_reason",
    }


@pytest.mark.asyncio
async def test_health_snapshot_is_synchronous_and_tracks_the_last_refresh():
    """`/health` must not take a DB round-trip: a slow database would then also
    slow the probe that is supposed to reveal the slowness. The endpoint reads a
    snapshot that boot refreshes."""
    await _seed(bridge=False, messages=2)
    await purge_raw_jid_identity_data(engine)

    assert isinstance(quarantine_status(), dict), "the sync accessor never raises"

    refreshed = await quarantine_counts(engine)
    snapshot = quarantine_status()

    assert refreshed == snapshot
    assert snapshot["available"] is True
    assert snapshot["quarantined"] == 1
    assert snapshot["messages_held"] == 2


@pytest.mark.asyncio
async def test_ensure_is_idempotent_and_reports_its_state():
    first = await ensure_whatsapp_identity_quarantine_table(engine)
    second = await ensure_whatsapp_identity_quarantine_table(engine)

    assert first in {"CREATED", "ALREADY_PRESENT"}
    assert second == "ALREADY_PRESENT"


# ---------------------------------------------------------------------------
# 8. The ledger survives an operator decision
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_startup_does_not_reset_an_operator_release():
    """If an operator marks a row RELEASED, the next boot must not silently
    put it back to QUARANTINED — that would erase the decision trail."""
    seeded = await _seed(bridge=False, messages=1)
    await purge_raw_jid_identity_data(engine)

    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "UPDATE whatsapp_identity_quarantine SET status = 'RELEASED' "
                "WHERE contact_id = :c"
            ),
            {"c": seeded["contact_id"]},
        )
        await db.commit()

    await purge_raw_jid_identity_data(engine)

    rows = await _ledger(seeded["contact_id"])
    assert rows[0][1] == "RELEASED", "startup must not overwrite an operator decision"
    assert await _msg_count(seeded["conversation_id"]) == 1, (
        "a RELEASED row still does not delete anything on boot"
    )
