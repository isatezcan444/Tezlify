"""The LID split repair MERGES split conversations instead of deleting them.

Context (2026-10-01). Two repairs already existed for a person whose chat was
split between a LID-keyed identity and their phone identity:

- the live path, `lid_mapped` → `reconcile_legacy_split_conversation`, which
  MOVES messages onto the canonical conversation; and
- a startup migration, `purge_raw_jid_identity_data`, which DELETES the ghost
  LID contact and its conversation, betting that the gateway will re-create the
  person under the phone JID.

The live path only ever fires once per mapping, so splits that hardened before
it existed are left to the second one — and for a mapping that IS known, deleting
the messages is needless data loss: the user sees "my messages are gone". This
job applies the merge to those rows instead.

What these checks pin:

- a DRY RUN (the default) changes NOTHING — no merge on a read,
- the merge MOVES every message, losing none, and dedups by `wa_message_id`,
- the LID conversation is ARCHIVED, never deleted,
- an unknown mapping is never guessed at (a LID with no bridge is skipped),
- the run is bounded by `limit`.
"""
import uuid as _uuid

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

from scripts.diagnostics.whatsapp_lid_split_repair import repair_lid_splits

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
LID_JID = "444444444444444@lid"
LID_PHONE = f"jid:{LID_JID}"
PHONE = "+905551112233"
PHONE_JID = "905551112233@s.whatsapp.net"
GW_ID = "gw-lid-repair-0001"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe(create_table=True):
        async with AsyncSessionLocal() as db:
            if create_table:
                # Mirrors `_ensure_sqlite_lid_and_history_tables`; the gateway
                # owns this table, so the isolated test DB may not have it.
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


async def _seed_split(
    mapping: bool = True,
    *,
    lid_jid: str = LID_JID,
    phone: str = PHONE,
    phone_jid: str = PHONE_JID,
    gw_id: str = GW_ID,
    wa_tag: str = "",
):
    """A ghost LID identity and the canonical phone identity, split apart."""
    lid_phone = f"jid:{lid_jid}"
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=gw_id,
            session_name="LID Onarim Hat",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()

        ghost = Contact(user_id=TEST_USER, phone_e164=lid_phone, display_name="Syafira")
        db.add(ghost)
        await db.flush()
        legacy_conv = Conversation(
            user_id=TEST_USER,
            contact_id=ghost.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=2,
        )
        db.add(legacy_conv)
        await db.flush()

        canonical = Contact(user_id=TEST_USER, phone_e164=phone, display_name=None)
        db.add(canonical)
        await db.flush()
        canonical_conv = Conversation(
            user_id=TEST_USER,
            contact_id=canonical.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=1,
        )
        db.add(canonical_conv)
        await db.flush()

        # One wa_message_id is SHARED: that is the duplicate the merge must
        # collapse rather than clone.
        for i in range(2):
            db.add(
                Message(
                    user_id=TEST_USER_HEX,
                    conversation_id=legacy_conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"lid-{i}",
                    # Same convention the gateway record uses: for an inbound
                    # message the peer is the sender and WE are the recipient.
                    sender_phone=phone,
                    recipient_phone="ME",
                    wa_message_id=f"SHARED_{wa_tag}" if i == 0 else f"LID_{wa_tag}{i}",
                )
            )
        db.add(
            Message(
                user_id=TEST_USER_HEX,
                conversation_id=canonical_conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="already-canonical",
                sender_phone=phone,
                recipient_phone="ME",
                wa_message_id=f"SHARED_{wa_tag}",
            )
        )

        if mapping:
            await db.execute(
                text(
                    "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid) "
                    "VALUES (:s, :l, :p)"
                ),
                {"s": gw_id, "l": lid_jid, "p": phone_jid},
            )
        await db.commit()
        return legacy_conv.id, canonical_conv.id


async def _message_conversations():
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message.conversation_id, Message.wa_message_id, Message.body).where(
                    Message.user_id == TEST_USER_HEX
                )
            )
        ).all()
    return [(r[0], r[1], r[2]) for r in rows]


async def _legacy_state(legacy_conv_id):
    async with AsyncSessionLocal() as db:
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == legacy_conv_id))
        ).scalar_one_or_none()
        return conv


@pytest.mark.asyncio
async def test_dry_run_is_the_default_and_changes_nothing():
    """A repair tool that acts while merely reporting is a footgun."""
    legacy_id, canonical_id = await _seed_split()
    before = await _message_conversations()

    result = await repair_lid_splits(apply=False, limit=10)

    assert result["apply"] is False
    assert result["would_merge"] == 1
    assert result["merged"] == 0
    assert await _message_conversations() == before, "a dry run must not touch rows"
    legacy = await _legacy_state(legacy_id)
    assert legacy.unread_count == 2, "a dry run must not move unread counts either"
    # Evidence is still produced, so the plan is auditable before applying.
    assert result["evidence"][0]["action"] == "would_merge"
    assert result["evidence"][0]["messages_in_lid_conversation"] == 2


@pytest.mark.asyncio
async def test_apply_merges_loses_no_message_and_archives_the_lid_conversation():
    """The whole point: MOVE, don't delete."""
    legacy_id, canonical_id = await _seed_split()

    result = await repair_lid_splits(apply=True, limit=10)

    assert result["merged"] == 1
    evidence = result["evidence"][0]
    assert evidence["applied"] is True
    assert evidence["canonical_conversation_id"] == canonical_id
    assert evidence["legacy_conversation_archived"] is True

    # The invariant that matters: a UNIQUE message is never left behind. A row
    # whose wa_message_id already exists canonically is a dead duplicate on the
    # now-archived conversation (the shared merge deliberately keeps it), which
    # the canonical read path never sees.
    assert evidence["unique_messages_stranded"] == 0, (
        "no message may be stranded on the archived LID conversation"
    )
    assert evidence["duplicates_left_on_archived_lid"] == 1, (
        "the shared wa_message_id row stays put — expected, and reported as such"
    )

    rows = await _message_conversations()
    canonical_rows = [r for r in rows if r[0] == canonical_id]
    # 2 LID messages + 1 canonical, minus the shared wa_message_id = 2 visible.
    assert len(canonical_rows) == 2, f"the shared message must collapse, got {rows}"
    bodies = sorted(body for _c, _w, body in canonical_rows)
    assert bodies == ["already-canonical", "lid-1"], (
        "the surviving copy of a duplicated wa_message_id is the canonical one, "
        "and the LID-only message must have travelled"
    )

    legacy = await _legacy_state(legacy_id)
    assert legacy is not None, "the LID conversation is ARCHIVED, never deleted"
    assert legacy.is_archived is True
    assert legacy.unread_count == 0, "its unread count moved to the canonical chat"


@pytest.mark.asyncio
async def test_unread_counts_are_combined_not_dropped():
    await _seed_split()
    await repair_lid_splits(apply=True, limit=10)

    async with AsyncSessionLocal() as db:
        canonical = (
            await db.execute(
                select(Conversation.unread_count).where(
                    Conversation.contact_id.in_(
                        select(Contact.id).where(Contact.phone_e164 == PHONE)
                    )
                )
            )
        ).scalar_one()
    assert canonical == 3, "2 (LID) + 1 (canonical) — the badge must not lose the held ones"


@pytest.mark.asyncio
async def test_a_lid_without_a_known_mapping_is_never_guessed_at():
    """No bridge means no merge: joining the wrong two people is worse than
    leaving a split."""
    await _seed_split(mapping=False)

    result = await repair_lid_splits(apply=True, limit=10)

    assert result["scanned"] == 0
    assert result["merged"] == 0
    rows = await _message_conversations()
    assert len(rows) == 3, "nothing may be touched when the identity is unknown"


@pytest.mark.asyncio
async def test_the_run_is_bounded_by_limit():
    """A repair job must not be able to touch an unbounded number of rows, and
    an impossible bound must be refused rather than silently ignored."""
    await _seed_split(
        lid_jid="555555555555551@lid",
        phone="+905551110001",
        phone_jid="905551110001@s.whatsapp.net",
        gw_id="gw-lid-repair-a",
        wa_tag="a",
    )
    await _seed_split(
        lid_jid="555555555555552@lid",
        phone="+905551110002",
        phone_jid="905551110002@s.whatsapp.net",
        gw_id="gw-lid-repair-b",
        wa_tag="b",
    )

    bounded = await repair_lid_splits(apply=True, limit=1)
    assert bounded["merged"] == 1, "limit must actually bound the work done"

    async with AsyncSessionLocal() as db:
        archived = (
            await db.execute(
                select(Conversation.id).where(Conversation.is_archived.is_(True))
            )
        ).all()
    assert len(archived) == 1, "exactly one merge, not two"

    with pytest.raises(ValueError):
        await repair_lid_splits(apply=True, limit=0)
