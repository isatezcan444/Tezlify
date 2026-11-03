"""AŞAMA 6.2 — P0-2: LID reconciliation must be SESSION-SCOPED.

Controlling invariant (6.2 brief):

    Bir LID eşleştirmesi YALNIZCA ait olduğu WhatsApp oturumu ve tenant
    kapsamındaki kimlik kayıtlarını etkileyebilir. Farklı oturumların
    kimlikleri birbirine karışamaz.

The prior bug (6.0 audit, P0-2)
-------------------------------
`_merge_under_lease` selected conversations with

    convs = {c.contact_id: c for c in rows}

and boot/sweep called it with `session_id=None`. A person split on TWO lines
has one ghost contact (contacts are user-level) with a conversation in each
line, and one canonical contact with a conversation in each line. The dict
kept only the LAST row per contact, so the "legacy" side could come from line A
while the "canonical" side came from line B. Messages were then moved from A
into B's conversation — silently, permanently, and with no multi-line test to
catch it.

This module pins the new contract end to end:

A. same tenant, two sessions: merging A leaves B's contact/conversation/
   messages untouched;
B. different tenants with the same LID and phone stay separate;
C. boot recovery processes EACH session in its own scope;
D. the periodic sweep is session-scoped;
E. a missing/ambiguous session (`session_id=None`) fails CLOSED — nothing is
   moved into another session;
F. idempotency: the second boot produces no cross-session change;
G. regression: single-session LID→PN still merges, normal PN chats are
   untouched, and a post-mapping inbound message (the 6.1 pending-release
   shape) lands on the same line's canonical conversation.

The tests run the REAL SQLAlchemy models against the test database; nothing is
mocked. See the phase report for the SQLite/PostgreSQL split: this file is
SQLite (L3), not PostgreSQL evidence.
"""

from __future__ import annotations

import uuid as _uuid
from typing import Any, Dict

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.reconciliation import (
    candidate_lid_split_pairs,
    merge_deferred_lid_ghosts,
    merge_split_conversation,
    run_identity_sweep_once,
)
from backend.app.services.whatsapp_service import ingest_gateway_event
from scripts.diagnostics.whatsapp_lid_split_repair import repair_lid_splits

# Dedicated tenants: this module reads row-level evidence, so sharing a tenant
# with another WhatsApp gate would produce false reds.
TENANT = "62a00000-0000-4000-8000-000000000062"
TENANT_HEX = TENANT.replace("-", "")
OTHER_TENANT = "62b00000-0000-4000-8000-000000000062"
OTHER_TENANT_HEX = OTHER_TENANT.replace("-", "")

LID = "628000111222333@lid"
PHONE = "+905550006201"
PHONE_JID = "905550006201@s.whatsapp.net"

GW_A = "gw-62-line-a"
GW_B = "gw-62-line-b"


def _lid_table_name() -> str:
    """The gateway keeps `lid_mappings` in a private schema on PostgreSQL."""
    return (
        "whatsapp_private.lid_mappings"
        if engine.dialect.name == "postgresql"
        else "lid_mappings"
    )


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe(create_table: bool = True):
        table = _lid_table_name()
        async with AsyncSessionLocal() as db:
            if create_table and engine.dialect.name != "postgresql":
                # SQLite test DB: the gateway owns this table and the isolated
                # file may lack it. PostgreSQL gets it from the schema migration.
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
            await db.execute(text(f"DELETE FROM {table}"))
            for h in (TENANT_HEX, TENANT, OTHER_TENANT_HEX, OTHER_TENANT):
                await db.execute(text("DELETE FROM messages WHERE user_id = :h"), {"h": h})
                await db.execute(
                    text("DELETE FROM conversations WHERE user_id = :h"), {"h": h}
                )
                await db.execute(text("DELETE FROM contacts WHERE user_id = :h"), {"h": h})
                await db.execute(
                    text("DELETE FROM whatsapp_sessions WHERE user_id = :h"), {"h": h}
                )
            if engine.dialect.name == "postgresql":
                # `whatsapp_private.lid_mappings.session_id` has an FK to the
                # gateway connection rows; delete mappings first (above), then
                # the fixtures' connections.
                await db.execute(
                    text(
                        "DELETE FROM whatsapp_private.gateway_sessions "
                        "WHERE session_id LIKE 'gw-62-%'"
                    )
                )
            await db.commit()

    await _wipe()
    yield
    await _wipe(create_table=False)


# ---------------------------------------------------------------------------
# Seeding primitives
# ---------------------------------------------------------------------------


async def _make_session(db, user_id: str, gw_id: str, name: str) -> WhatsAppSession:
    sess = WhatsAppSession(
        user_id=user_id,
        gateway_id=gw_id,
        session_name=name,
        status=SessionStatus.CONNECTED,
        is_active=True,
    )
    db.add(sess)
    await db.flush()
    return sess


async def _make_contact(
    db, user_id: str, phone_e164: str, display_name: str | None = None
) -> Contact:
    contact = Contact(user_id=user_id, phone_e164=phone_e164, display_name=display_name)
    db.add(contact)
    await db.flush()
    return contact


async def _make_conversation(
    db,
    user_id: str,
    contact: Contact,
    session_id: int | None,
    *,
    unread_count: int = 0,
) -> Conversation:
    conv = Conversation(
        user_id=user_id,
        contact_id=contact.id,
        session_id=session_id,
        channel="WHATSAPP",
        status=ConversationStatus.ACTIVE,
        is_archived=False,
        unread_count=unread_count,
    )
    db.add(conv)
    await db.flush()
    return conv


async def _make_message(
    db, user_hex: str, conv: Conversation, body: str, wa_id: str, phone: str = PHONE
) -> Message:
    msg = Message(
        user_id=user_hex,
        conversation_id=conv.id,
        direction=MessageDirection.INBOUND,
        message_type=MessageType.TEXT,
        body=body,
        sender_phone=phone,
        recipient_phone="ME",
        wa_message_id=wa_id,
    )
    db.add(msg)
    await db.flush()
    return msg


async def _add_mapping(db, gw_id: str, lid: str = LID, phone_jid: str = PHONE_JID):
    if engine.dialect.name == "postgresql":
        # PostgreSQL enforces lid_mappings.session_id -> gateway_sessions.
        await db.execute(
            text(
                "INSERT INTO whatsapp_private.gateway_sessions "
                "(session_id, session_name) VALUES (:s, :n) "
                "ON CONFLICT (session_id) DO NOTHING"
            ),
            {"s": gw_id, "n": f"test-{gw_id}"[:150]},
        )
    await db.execute(
        text(
            f"INSERT INTO {_lid_table_name()} (session_id, lid_jid, phone_jid) "
            "VALUES (:s, :l, :p)"
        ),
        {"s": gw_id, "l": lid, "p": phone_jid},
    )


async def _seed_two_session_split(
    *,
    user_id: str = TENANT,
    hex_id: str = TENANT_HEX,
    lid: str = LID,
    phone: str = PHONE,
    phone_jid: str = PHONE_JID,
    gw_a: str = GW_A,
    gw_b: str = GW_B,
    order: str = "normal",
    mapping: bool = True,
) -> Dict[str, Any]:
    """One ghost contact + one canonical contact, each with a conversation on
    two lines of the SAME tenant (the realistic multi-line split).

    `order="cross"` inserts conversations in the order that made the OLD dict
    (`{contact_id: conv}` keeps the last row) pair line A's legacy with line
    B's canonical — the exact cross-session move from the 6.0 audit.
    """
    async with AsyncSessionLocal() as db:
        sess_a = await _make_session(db, user_id, gw_a, "Hat A")
        sess_b = await _make_session(db, user_id, gw_b, "Hat B")
        ghost = await _make_contact(db, user_id, f"jid:{lid}", "Ghost")
        canonical = await _make_contact(db, user_id, phone, "Canonical")

        convs: Dict[str, Conversation] = {}

        async def _ghost(session, unread=2):
            return await _make_conversation(db, user_id, ghost, session.id, unread_count=unread)

        async def _canon(session, unread=1):
            return await _make_conversation(
                db, user_id, canonical, session.id, unread_count=unread
            )

        if order == "cross":
            order_ops = [
                ("ghost_b", lambda: _ghost(sess_b)),
                ("ghost_a", lambda: _ghost(sess_a)),
                ("canonical_a", lambda: _canon(sess_a)),
                ("canonical_b", lambda: _canon(sess_b)),
            ]
        else:
            order_ops = [
                ("ghost_a", lambda: _ghost(sess_a)),
                ("ghost_b", lambda: _ghost(sess_b)),
                ("canonical_a", lambda: _canon(sess_a)),
                ("canonical_b", lambda: _canon(sess_b)),
            ]
        for key, op in order_ops:
            convs[key] = await op()

        for line, tag in (("a", "A"), ("b", "B")):
            await _make_message(
                db, hex_id, convs[f"ghost_{line}"], f"{line}-lid-1", f"{tag}-LID-1", phone
            )
            await _make_message(
                db, hex_id, convs[f"ghost_{line}"], f"{line}-lid-2", f"{tag}-LID-2", phone
            )
            await _make_message(
                db, hex_id, convs[f"canonical_{line}"], f"{line}-canon", f"{tag}-CANON", phone
            )

        if mapping:
            await _add_mapping(db, gw_a, lid, phone_jid)
        await db.commit()
        return {
            "sessions": {"a": sess_a.id, "b": sess_b.id},
            "conversations": {k: v.id for k, v in convs.items()},
        }


# ---------------------------------------------------------------------------
# Readers / snapshots
# ---------------------------------------------------------------------------


async def _conv(conv_id: int) -> Conversation | None:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(Conversation).where(Conversation.id == conv_id))
        ).scalars().first()


async def _bodies(conv_id: int) -> list[str]:
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message.body).where(Message.conversation_id == conv_id)
            )
        ).scalars().all()
    return sorted(rows)


async def _snapshot(*conv_ids: int) -> Dict[str, Any]:
    """Conversation state + message rows for the given conversations."""
    snapshot: Dict[str, Any] = {}
    async with AsyncSessionLocal() as db:
        for conv_id in conv_ids:
            conv = (
                await db.execute(select(Conversation).where(Conversation.id == conv_id))
            ).scalars().first()
            rows = (
                await db.execute(
                    select(Message.id, Message.conversation_id, Message.body)
                    .where(Message.conversation_id == conv_id)
                    .order_by(Message.id.asc())
                )
            ).all()
            snapshot[str(conv_id)] = {
                "is_archived": bool(conv.is_archived),
                "status": conv.status.value,
                "unread_count": conv.unread_count,
                "messages": [(r.id, r.conversation_id, r.body) for r in rows],
            }
    return snapshot


# ---------------------------------------------------------------------------
# H. The new candidate contract: one candidate per (pair, session)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_h_candidate_pairs_carry_their_own_session():
    """A candidate is (lid, phone, session), not (lid, phone).

    The old query grouped by lid/phone/user only, so a person split on two
    lines produced ONE candidate and the caller could not know which line it
    belonged to. Two lines must yield TWO candidates, each with its session.
    """
    seeded = await _seed_two_session_split()

    async with AsyncSessionLocal() as db:
        pairs = await candidate_lid_split_pairs(db, user_id=TENANT, limit=10)

    assert len(pairs) == 2, f"iki hat iki ayrı aday üretmeli; got {pairs}"
    assert {p["session_id"] for p in pairs} == {
        seeded["sessions"]["a"],
        seeded["sessions"]["b"],
    }
    assert all(p["lid_jid"] == LID and p["phone_jid"] == PHONE_JID for p in pairs)
    # Each candidate points at ITS OWN line's ghost conversation.
    by_session = {p["session_id"]: p for p in pairs}
    assert by_session[seeded["sessions"]["a"]]["lid_conversation_id"] == seeded[
        "conversations"
    ]["ghost_a"]
    assert by_session[seeded["sessions"]["b"]]["lid_conversation_id"] == seeded[
        "conversations"
    ]["ghost_b"]


# ---------------------------------------------------------------------------
# A. Same tenant, two sessions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_merging_one_session_leaves_the_other_session_untouched():
    """Running line A's mapping changes NOTHING on line B."""
    seeded = await _seed_two_session_split()
    conv = seeded["conversations"]

    before_b = await _snapshot(conv["ghost_b"], conv["canonical_b"])

    async with AsyncSessionLocal() as db:
        merged = await merge_split_conversation(
            db,
            TENANT,
            LID,
            PHONE_JID,
            session_id=seeded["sessions"]["a"],
        )

    assert merged is not None and merged.id == conv["canonical_a"]
    assert (await _conv(conv["ghost_a"])).is_archived is True
    assert merged.unread_count == 3, "A: 2 ghost + 1 canonical"
    assert await _bodies(conv["canonical_a"]) == ["a-canon", "a-lid-1", "a-lid-2"]

    # The whole point: B is byte-for-byte unchanged.
    assert await _snapshot(conv["ghost_b"], conv["canonical_b"]) == before_b
    assert (await _conv(conv["ghost_b"])).is_archived is False
    assert await _bodies(conv["ghost_b"]) == ["b-lid-1", "b-lid-2"]
    assert await _bodies(conv["canonical_b"]) == ["b-canon"]


# ---------------------------------------------------------------------------
# B. Different tenants, same LID and phone
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_b_same_lid_and_phone_in_two_tenants_never_cross_tenants():
    """Two businesses may have synced the same person; each merge stays home."""
    a = await _seed_two_session_split(
        user_id=TENANT,
        hex_id=TENANT_HEX,
        lid="628000999888777@lid",
        phone="+905550006299",
        phone_jid="905550006299@s.whatsapp.net",
        gw_a="gw-62-tenant-a",
        gw_b="gw-62-tenant-a-b",
    )
    b = await _seed_two_session_split(
        user_id=OTHER_TENANT,
        hex_id=OTHER_TENANT_HEX,
        lid="628000999888777@lid",
        phone="+905550006299",
        phone_jid="905550006299@s.whatsapp.net",
        gw_a="gw-62-tenant-b",
        gw_b="gw-62-tenant-b-b",
    )

    async with AsyncSessionLocal() as db:
        await merge_split_conversation(
            db, TENANT, "628000999888777@lid", "905550006299@s.whatsapp.net",
            session_id=a["sessions"]["a"],
        )
        await merge_split_conversation(
            db, OTHER_TENANT, "628000999888777@lid", "905550006299@s.whatsapp.net",
            session_id=b["sessions"]["a"],
        )

    for seeded, hex_id, who in (
        (a, TENANT_HEX, "tenant-a"),
        (b, OTHER_TENANT_HEX, "tenant-b"),
    ):
        conv = seeded["conversations"]
        assert await _bodies(conv["canonical_a"]) == [
            "a-canon", "a-lid-1", "a-lid-2"
        ], who
        # The untouched line of each tenant also stayed home.
        assert await _bodies(conv["canonical_b"]) == ["b-canon"], who
        assert await _bodies(conv["ghost_b"]) == ["b-lid-1", "b-lid-2"], who

    # No message row may live in a conversation owned by the OTHER tenant.
    # (Body prefixes repeat per tenant by construction, so the invariant is the
    # message/conversation owner pair, not the body text.)
    normalized = lambda value: str(value).replace("-", "")  # noqa: E731
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message.user_id, Conversation.user_id, Message.body)
                .join(Conversation, Conversation.id == Message.conversation_id)
                .where(Conversation.user_id.in_([TENANT, OTHER_TENANT]))
            )
        ).all()
    assert len(rows) == 12, rows  # 6 seeded rows per tenant, none lost
    for msg_owner, conv_owner, body in rows:
        assert normalized(msg_owner) == normalized(conv_owner), (
            f"kiracılar arası sızıntı: {body!r} ({msg_owner}) -> {conv_owner}"
        )


# ---------------------------------------------------------------------------
# C. Boot recovery with multiple sessions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_c_boot_reconciliation_processes_each_session_in_its_scope():
    """Boot used to call the merge with `session_id=None` for every candidate.

    It must now merge line A's split into A's canonical and line B's split into
    B's canonical — never A's messages into B.
    """
    seeded = await _seed_two_session_split()
    conv = seeded["conversations"]

    report = await merge_deferred_lid_ghosts(engine, limit=10, user_id=TENANT)

    assert report["merged"] == 2, report
    assert report["errors"] == 0, report
    assert report["remaining_at_least"] == 0, report
    merged_ids = {p["canonical_conversation_id"] for p in report["merged_pairs"]}
    assert merged_ids == {conv["canonical_a"], conv["canonical_b"]}

    assert await _bodies(conv["canonical_a"]) == ["a-canon", "a-lid-1", "a-lid-2"]
    assert await _bodies(conv["canonical_b"]) == ["b-canon", "b-lid-1", "b-lid-2"]
    assert (await _conv(conv["ghost_a"])).is_archived is True
    assert (await _conv(conv["ghost_b"])).is_archived is True
    assert (await _conv(conv["canonical_a"])).unread_count == 3
    assert (await _conv(conv["canonical_b"])).unread_count == 3


# ---------------------------------------------------------------------------
# D/F. The periodic sweep is session-scoped and idempotent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_d_periodic_sweep_is_session_scoped_and_idempotent():
    seeded = await _seed_two_session_split()
    conv = seeded["conversations"]

    first = await run_identity_sweep_once(engine, limit=10)

    assert first["splits"]["merged"] == 2, first
    assert first["splits"]["errors"] == 0, first
    assert first["stranded"]["still_stranded"] == 0, first
    assert await _bodies(conv["canonical_a"]) == ["a-canon", "a-lid-1", "a-lid-2"]
    assert await _bodies(conv["canonical_b"]) == ["b-canon", "b-lid-1", "b-lid-2"]

    after_first = await _snapshot(
        conv["ghost_a"], conv["canonical_a"], conv["ghost_b"], conv["canonical_b"]
    )
    second = await run_identity_sweep_once(engine, limit=10)

    assert second["splits"]["scanned"] == 0, "arşivlenen LID sohbeti aday değil"
    assert second["splits"]["merged"] == 0, second
    assert (
        await _snapshot(
            conv["ghost_a"], conv["canonical_a"], conv["ghost_b"], conv["canonical_b"]
        )
        == after_first
    ), "ikinci süpürme hiçbir oturumda değişiklik üretmemeli"


# ---------------------------------------------------------------------------
# E. Missing / ambiguous session scope fails CLOSED
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e_ambiguous_scope_called_with_none_moves_nothing():
    """THE REPRODUCER: the old boot/sweep call shape (`session_id=None`) on a
    two-line split.

    Old code kept the last conversation per contact, so this seed (cross order:
    ghost B, ghost A, canonical A, canonical B) made it pair line A's legacy
    with line B's canonical and move A's messages into B. The fixed code sees
    two distinct scopes and refuses.
    """
    seeded = await _seed_two_session_split(order="cross")
    conv = seeded["conversations"]
    before = await _snapshot(
        conv["ghost_a"], conv["canonical_a"], conv["ghost_b"], conv["canonical_b"]
    )

    info: Dict[str, Any] = {}
    async with AsyncSessionLocal() as db:
        merged = await merge_split_conversation(
            db, TENANT, LID, PHONE_JID, session_id=None, result_info=info
        )

    assert merged is None, "belirsiz kapsamda birleştirme YAPILMAMALI"
    assert info.get("skipped_reason") == "ambiguous_session_scope", info
    assert (
        await _snapshot(
            conv["ghost_a"], conv["canonical_a"], conv["ghost_b"], conv["canonical_b"]
        )
        == before
    ), "fail-closed: hiçbir mesaj/sohbet değişmemeli"


@pytest.mark.asyncio
async def test_e2_boot_never_moves_a_session_less_record_into_a_line():
    """A ghost conversation with no session must NOT be merged into line A's
    canonical conversation just because it happens to exist.

    Boot reads the candidate's own session (here `None`); the canonical side is
    searched only in that same `None` scope. No same-scope canonical exists, so
    the fallback `ensure_conversation` must not borrow line A's chat: the
    post-ensure guard fails closed.
    """
    async with AsyncSessionLocal() as db:
        sess_a = await _make_session(db, TENANT, GW_A, "Hat A")
        ghost = await _make_contact(db, TENANT, f"jid:{LID}", "Ghost")
        canonical = await _make_contact(db, TENANT, PHONE, "Canonical")
        ghost_conv = await _make_conversation(db, TENANT, ghost, None, unread_count=2)
        canonical_conv = await _make_conversation(
            db, TENANT, canonical, sess_a.id, unread_count=1
        )
        for i in (1, 2):
            await _make_message(
                db, TENANT_HEX, ghost_conv, f"missing-lid-{i}", f"MISSING-{i}"
            )
        await _make_message(
            db, TENANT_HEX, canonical_conv, "line-a-canon", "MISSING-CANON"
        )
        await _add_mapping(db, GW_A)
        await db.commit()
        ghost_id, canonical_id = ghost_conv.id, canonical_conv.id
        ghost_contact_id = ghost.id

    report = await merge_deferred_lid_ghosts(engine, limit=10, user_id=TENANT)

    assert report["merged"] == 0, report
    assert report["skipped"] == 1, report
    assert report.get("error") is None, report

    assert (await _conv(ghost_id)).is_archived is False, "oturumsuz kayıt arşivlenmemeli"
    assert (await _conv(canonical_id)).unread_count == 1, "hat A'nın okunmamışı değişmemeli"
    assert await _bodies(ghost_id) == ["missing-lid-1", "missing-lid-2"]
    assert await _bodies(canonical_id) == ["line-a-canon"]
    # No borrowed canonical conversation was created inside session A.
    async with AsyncSessionLocal() as db:
        created = (
            await db.execute(
                select(Conversation.id).where(
                    Conversation.contact_id == ghost_contact_id
                )
            )
        ).scalars().all()
    assert set(created) == {ghost_id}, "oturumsuz kayıt için başka sohbet üretilmemeli"


# ---------------------------------------------------------------------------
# G. Regression: single session, normal chats, post-mapping (6.1) ingest
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_g_single_session_lid_merge_still_works():
    """The ordinary one-line case must keep its old, correct behavior."""
    async with AsyncSessionLocal() as db:
        sess = await _make_session(db, TENANT, GW_A, "Tek Hat")
        ghost = await _make_contact(db, TENANT, f"jid:{LID}", "Ghost")
        canonical = await _make_contact(db, TENANT, PHONE, "Canonical")
        ghost_conv = await _make_conversation(db, TENANT, ghost, sess.id, unread_count=2)
        canonical_conv = await _make_conversation(
            db, TENANT, canonical, sess.id, unread_count=1
        )
        await _make_message(db, TENANT_HEX, ghost_conv, "single-lid-1", "SINGLE-LID-1")
        await _make_message(db, TENANT_HEX, ghost_conv, "single-lid-2", "SINGLE-LID-2")
        await _make_message(
            db, TENANT_HEX, canonical_conv, "single-canon", "SINGLE-CANON"
        )
        await _add_mapping(db, GW_A)
        await db.commit()
        ghost_id, canonical_id = ghost_conv.id, canonical_conv.id

    report = await merge_deferred_lid_ghosts(engine, limit=10, user_id=TENANT)

    assert report["merged"] == 1, report
    assert await _bodies(canonical_id) == [
        "single-canon", "single-lid-1", "single-lid-2"
    ]
    assert (await _conv(ghost_id)).is_archived is True
    assert (await _conv(canonical_id)).unread_count == 3


@pytest.mark.asyncio
async def test_g2_normal_pn_conversations_are_never_touched():
    """A chat without a LID mapping is not a candidate and must stay intact."""
    seeded = await _seed_two_session_split()
    conv = seeded["conversations"]
    async with AsyncSessionLocal() as db:
        normal_contact = await _make_contact(
            db, TENANT, "+905550006288", "Normal"
        )
        normal_conv = await _make_conversation(
            db, TENANT, normal_contact, seeded["sessions"]["a"], unread_count=4
        )
        await _make_message(
            db,
            TENANT_HEX,
            normal_conv,
            "normal-chat",
            "NORMAL-1",
            phone="+905550006288",
        )
        await db.commit()
        normal_id = normal_conv.id
    before = await _snapshot(normal_id)

    report = await merge_deferred_lid_ghosts(engine, limit=10, user_id=TENANT)

    assert report["merged"] == 2, report
    assert await _snapshot(normal_id) == before, "normal PN sohbeti dokunulmamalı"
    assert (await _conv(normal_id)).is_archived is False


@pytest.mark.asyncio
async def test_g3_post_mapping_message_lands_on_the_same_lines_canonical_chat():
    """6.1 pending release replays a `message_new` addressed to the PHONE JID.

    After both lines are merged, an inbound event carrying line A's gateway
    session must land on line A's canonical conversation and leave line B's
    canonical conversation exactly as it was.
    """
    seeded = await _seed_two_session_split()
    conv = seeded["conversations"]
    await merge_deferred_lid_ghosts(engine, limit=10, user_id=TENANT)

    before_b = await _snapshot(conv["canonical_b"])
    before_a_count = len(await _bodies(conv["canonical_a"]))

    await ingest_gateway_event(
        {
            "event": "message_new",
            "event_id": str(_uuid.uuid4()),
            "gateway_session_id": GW_A,
            "message": {
                "conversation_id": PHONE_JID,
                "wa_message_id": "PENDING-RELEASED-62",
                "direction": "INBOUND",
                "message_type": "TEXT",
                "body": "pending-release",
                "created_at": "2026-11-03T10:00:00.000Z",
            },
        }
    )

    assert "pending-release" in await _bodies(conv["canonical_a"])
    assert len(await _bodies(conv["canonical_a"])) == before_a_count + 1
    assert await _snapshot(conv["canonical_b"]) == before_b, (
        "hat A'ya gelen mesaj hat B'nin sohbetine düşmemeli"
    )

    # The event resolved to the SAME conversation (no parallel chat was created).
    async with AsyncSessionLocal() as db:
        target = (
            await db.execute(
                select(Message.conversation_id).where(
                    Message.wa_message_id == "PENDING-RELEASED-62"
                )
            )
        ).scalars().first()
    assert target == conv["canonical_a"]


# ---------------------------------------------------------------------------
# I. The manual/diagnostic repair path is session-scoped too
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_i_diagnostic_repair_merges_each_session_independently():
    """The operator repair tool must not reintroduce cross-session merging."""
    seeded = await _seed_two_session_split()
    conv = seeded["conversations"]

    result = await repair_lid_splits(apply=True, limit=10, user_id=TENANT)

    assert result["scanned"] == 2, result
    assert result["merged"] == 2, result
    assert result["skipped"] == [], result
    assert {e["canonical_conversation_id"] for e in result["evidence"]} == {
        conv["canonical_a"],
        conv["canonical_b"],
    }
    assert await _bodies(conv["canonical_a"]) == ["a-canon", "a-lid-1", "a-lid-2"]
    assert await _bodies(conv["canonical_b"]) == ["b-canon", "b-lid-1", "b-lid-2"]
