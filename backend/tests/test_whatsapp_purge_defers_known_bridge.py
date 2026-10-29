"""The startup purge must never destroy a split it cannot prove is a ghost.

History
-------
2026-10-01. `purge_raw_jid_identity_data` documented itself as cleaning
"Çözülmemiş LID hayalet contact'leri" — *unresolved* LID ghosts. The SQL did not
implement that qualifier: it deleted EVERY contact keyed
`phone_e164 LIKE 'jid:%@lid'`, bridge or no bridge. That fix made a ghost with a
KNOWN bridge survive; a ghost with NO bridge was still hard-deleted.

2026-10-29 (Phase 3.8.6 cutover) proved the remaining half wrong. A LID-only
identity can belong to a real person whose phone JID is *never* revealed, so
"no bridge row" means "we never learned the bridge", not "nobody is there".
The cutover deleted 1 contact + 1 conversation + 9 real messages
(`126|2077|1538` → `125|2068|1537`); they survived only in gateway RAM.

The contract these checks pin now:

- a ghost with a KNOWN bridge survives, messages intact, and is recorded as
  `bridge_known_deferred` (the merge step picks it up in the same boot),
- a ghost with NO bridge ALSO survives, messages intact, recorded as
  `bridge_unknown_has_messages` — this is the case that used to lose data,
- the deciding factor is still the BRIDGE ROW (removing it flips the recorded
  reason), but the flip changes the CLASSIFICATION, never the row count,
- the purge reports `deleted_* == 0` in every case: "stopped deleting" must be
  distinguishable from "forgot to delete".
"""

import uuid as _uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.migrations import (
    ensure_whatsapp_identity_quarantine_table,
    purge_raw_jid_identity_data,
)
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
            # Karantina defteri purge tarafindan yazilir; testler arasinda
            # tasinirsa "ikinci calistirma yeni satir eklemez" iddiasi yalan
            # soyler. Tablo yoksa (eski test DB'si) once olustur.
            await db.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS whatsapp_identity_quarantine (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        created_at TIMESTAMP NOT NULL,
                        updated_at TIMESTAMP NOT NULL,
                        contact_id INTEGER NOT NULL,
                        conversation_id INTEGER,
                        user_id VARCHAR(36),
                        phone_e164 VARCHAR(64) NOT NULL,
                        reason VARCHAR(48) NOT NULL,
                        status VARCHAR(16) NOT NULL DEFAULT 'QUARANTINED',
                        message_count INTEGER NOT NULL DEFAULT 0,
                        detail TEXT
                    )
                    """
                )
            )
            await db.execute(text("DELETE FROM whatsapp_identity_quarantine"))
            # Purge artik hayaletleri SILMIYOR, bu yuzden baska bir test
            # dosyasinin biraktigi `jid:%@lid` contact'i `report[...]`
            # sayimlarina sizardi (eskiden purge onu temizliyordu — degisiklik
            # bu gizli bagimliligi ortaya cikardi). Bu dosya hayalet
            # populasyonunu sahipleniyor ki iddialar deterministik kalsin.
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


async def _quarantine_reason(contact_id):
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                text(
                    "SELECT reason FROM whatsapp_identity_quarantine "
                    "WHERE contact_id = :c"
                ),
                {"c": contact_id},
            )
        ).scalar()


async def _quarantine_rows(contact_id) -> int:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                text(
                    "SELECT count(*) FROM whatsapp_identity_quarantine "
                    "WHERE contact_id = :c"
                ),
                {"c": contact_id},
            )
        ).scalar_one()


@pytest.mark.asyncio
async def test_bridged_ghost_survives_the_purge_with_its_messages():
    """Deleting a repairable split is irreversible; deferring it is not."""
    seeded = await _seed_ghost(BRIDGED_LID, bridge=True, tag="b")

    report = await purge_raw_jid_identity_data(engine)

    assert await _contact_exists(seeded["contact_id"]), (
        "a ghost whose LID→phone bridge is KNOWN must not be deleted — "
        "the repair job merges it, and deleting first loses the messages"
    )
    assert await _message_count(seeded["conversation_id"]) == 2, "messages must survive"
    assert report["deleted_contacts"] == 0
    assert report["deleted_messages"] == 0
    assert await _quarantine_reason(seeded["contact_id"]) == "bridge_known_deferred"


@pytest.mark.asyncio
async def test_unresolved_ghost_is_quarantined_not_deleted():
    """The case that lost 9 production messages on 2026-10-29.

    "No bridge row" is not evidence that nobody is behind the LID. The row must
    survive, its messages must survive, and the reason must say why it was held.
    """
    seeded = await _seed_ghost(UNBRIDGED_LID, bridge=False, tag="u")

    report = await purge_raw_jid_identity_data(engine)

    assert await _contact_exists(seeded["contact_id"]), (
        "an unresolved LID may be a real person whose phone JID was never "
        "learned; deleting is unrecoverable, quarantining is not"
    )
    assert await _message_count(seeded["conversation_id"]) == 2, (
        "the 9-message production loss must not be reproducible"
    )
    assert report["deleted_contacts"] == 0
    assert report["deleted_conversations"] == 0
    assert report["deleted_messages"] == 0
    assert report["quarantined_with_messages"] == 1
    assert report["messages_held"] == 2
    assert await _quarantine_reason(seeded["contact_id"]) == "bridge_unknown_has_messages"


@pytest.mark.asyncio
async def test_the_bridge_row_changes_the_classification_not_the_row_count():
    """Falsification-in-test: the same ghost re-classifies when the bridge goes.

    This separates "quarantines because the bridge is unknown" from "quarantines
    everything blindly" — the latter would pass the previous checks too. It also
    proves the bridge is still the deciding *signal*, just no longer a licence
    to delete.
    """
    seeded = await _seed_ghost(BRIDGED_LID, bridge=True, tag="f")

    await purge_raw_jid_identity_data(engine)
    assert await _contact_exists(seeded["contact_id"])
    assert await _quarantine_reason(seeded["contact_id"]) == "bridge_known_deferred"

    async with AsyncSessionLocal() as db:
        await db.execute(text("DELETE FROM lid_mappings WHERE lid_jid = :l"), {"l": BRIDGED_LID})
        await db.commit()

    report = await purge_raw_jid_identity_data(engine)

    assert await _contact_exists(seeded["contact_id"]), (
        "losing the bridge must downgrade the classification, never delete"
    )
    assert await _message_count(seeded["conversation_id"]) == 2
    assert report["deleted_messages"] == 0
    assert await _quarantine_reason(seeded["contact_id"]) == "bridge_unknown_has_messages"


@pytest.mark.asyncio
async def test_repeated_startup_is_idempotent_and_never_deletes():
    """Two boots in a row: same single ledger row, same data, zero deletes."""
    seeded = await _seed_ghost(UNBRIDGED_LID, bridge=False, tag="i")

    first = await purge_raw_jid_identity_data(engine)
    second = await purge_raw_jid_identity_data(engine)

    assert first["deleted_messages"] == 0 and second["deleted_messages"] == 0
    assert await _quarantine_rows(seeded["contact_id"]) == 1, (
        "a re-run must UPDATE the ledger row, not append a duplicate"
    )
    assert await _message_count(seeded["conversation_id"]) == 2
