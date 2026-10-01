"""The startup purge must not delete a split it can actually repair.

Context (2026-10-01). `purge_raw_jid_identity_data` documented itself as
cleaning "Çözülmemiş LID hayalet contact'leri" — *unresolved* LID ghosts. The
SQL did not implement that qualifier: it deleted EVERY contact keyed
`phone_e164 LIKE 'jid:%@lid'`, bridge or no bridge.

That matters because the bridge is precisely what makes the row repairable.
`scripts/diagnostics/whatsapp_lid_split_repair.py` MOVES such a ghost's
messages onto the canonical phone conversation and archives the old one; the
purge DELETES the ghost, its conversation and its messages. Running the purge
first destroys the repair's material and the loss is irreversible — the user
simply sees "my messages are gone".

Measured in production before this fix: 208 known LID→phone bridges existed
while 0 ghost contacts remained, and the deploy report recorded
`conversations 449 → 447` / `contacts 1848 → 1846` attributed to this purge.
The repair found nothing because the purge had already deleted it.

What these checks pin:

- a ghost with a KNOWN bridge survives the purge, messages intact,
- a ghost with NO bridge is still deleted (the original contract, unchanged),
- the deciding factor is the BRIDGE ROW, proven by removing it and re-running:
  the same ghost that survived is then deleted.
"""

import uuid as _uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.migrations import purge_raw_jid_identity_data
from backend.app.core.database import engine
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
GW_ID = "gw-purge-defer-0001"

BRIDGED_LID = "555555555555551@lid"
UNBRIDGED_LID = "555555555555552@lid"
PHONE = "+905551119988"
PHONE_JID = "905551119988@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe(create_table=True):
        async with AsyncSessionLocal() as db:
            if create_table:
                # The gateway owns this table, so an isolated test DB may lack
                # it; mirrors `_ensure_sqlite_lid_and_history_tables`.
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
            await db.execute(
                text("DELETE FROM messages WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM conversations WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id = :h"),
                {"h": TEST_USER_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe(create_table=False)


async def _seed_ghost(lid_jid: str, *, bridge: bool, tag: str = "") -> dict:
    """A ghost LID contact + conversation + 2 messages, optionally bridged."""
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=GW_ID,
            session_name="Purge Erteleme Hatti",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()

        ghost = Contact(user_id=TEST_USER, phone_e164=f"jid:{lid_jid}", display_name="Hayalet")
        db.add(ghost)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER,
            contact_id=ghost.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=2,
        )
        db.add(conv)
        await db.flush()

        for i in range(2):
            db.add(
                Message(
                    user_id=TEST_USER_HEX,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"split-{tag}{i}",
                    sender_phone=PHONE,
                    recipient_phone="ME",
                    wa_message_id=f"SPLIT_{tag}{i}_{_uuid.uuid4().hex[:6]}",
                )
            )

        if bridge:
            await db.execute(
                text(
                    "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid) "
                    "VALUES (:s, :l, :p)"
                ),
                {"s": GW_ID, "l": lid_jid, "p": PHONE_JID},
            )
        await db.commit()
        return {"contact_id": ghost.id, "conversation_id": conv.id}


async def _contact_exists(contact_id) -> bool:
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(Contact.id).where(Contact.id == contact_id))).first() is not None


async def _message_count(conversation_id) -> int:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                select(func.count()).select_from(Message).where(
                    Message.conversation_id == conversation_id
                )
            )
        ).scalar_one()


@pytest.mark.asyncio
async def test_bridged_ghost_survives_the_purge_with_its_messages():
    """Deleting a repairable split is irreversible; deferring it is not."""
    seeded = await _seed_ghost(BRIDGED_LID, bridge=True, tag="b")

    await purge_raw_jid_identity_data(engine)

    assert await _contact_exists(seeded["contact_id"]), (
        "a ghost whose LID→phone bridge is KNOWN must not be deleted — "
        "the repair job merges it, and deleting first loses the messages"
    )
    assert await _message_count(seeded["conversation_id"]) == 2, "messages must survive"


@pytest.mark.asyncio
async def test_unresolved_ghost_is_still_deleted():
    """Control: the original contract is unchanged for an unresolved LID.

    Without this, "did not delete" would be indistinguishable from "the purge
    stopped working".
    """
    seeded = await _seed_ghost(UNBRIDGED_LID, bridge=False, tag="u")

    await purge_raw_jid_identity_data(engine)

    assert not await _contact_exists(seeded["contact_id"]), (
        "an unresolved ghost has no one to merge into and is still purged"
    )
    assert await _message_count(seeded["conversation_id"]) == 0


@pytest.mark.asyncio
async def test_the_bridge_row_is_what_decides():
    """Falsification-in-test: the same ghost flips fate when the bridge goes.

    This is what separates "defers because the bridge is known" from "defers
    everything" — the latter would also pass the first check.
    """
    seeded = await _seed_ghost(BRIDGED_LID, bridge=True, tag="f")

    await purge_raw_jid_identity_data(engine)
    assert await _contact_exists(seeded["contact_id"])

    async with AsyncSessionLocal() as db:
        await db.execute(text("DELETE FROM lid_mappings WHERE lid_jid = :l"), {"l": BRIDGED_LID})
        await db.commit()

    await purge_raw_jid_identity_data(engine)

    assert not await _contact_exists(seeded["contact_id"]), (
        "with the bridge gone the ghost is unresolved, so the purge deletes it"
    )
