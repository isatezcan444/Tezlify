"""AŞAMA 4.6 — audit tests for scenarios the repo suite does not cover.

Not part of the repository. Runs only against a throwaway PostgreSQL cluster.

Covered here (repo coverage in parentheses):
  A1 exact duplicate through the bulk writer        (new)
  A2 both unique indexes on one row                 (new)
  A3 PostgreSQL allows ONE arbiter per statement    (new — design constraint)
  A4 per-row savepoint fallback isolates poison     (prototype of the proposal)
  B1 lost cursor -> re-scan, no data loss           (new)
  B2 stale-high cursor -> self-heals next turn      (new)
  B3 two workers on the same offset                 (new; different-cursor case exists)
  C1 front-trim during pagination SKIPS records     (new — the real hazard)
  C2 append during pagination does NOT skip         (new)
  D1 message row + processed_events commit together (new)
"""
from __future__ import annotations

import asyncio
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, ProgrammingError

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp import memory_persistence as mp
from backend.app.services.whatsapp.orchestration.sync import _insert_messages_resilient

U = "77777777-1111-1111-1111-777777777777"
U_HEX = U.replace("-", "")


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setattr(mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", True, raising=False)


@pytest_asyncio.fixture(autouse=True)
async def _clean():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for t in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(text(f"DELETE FROM {t} WHERE user_id = :u"), {"u": U_HEX})
            await db.commit()

    mp.reset_memory_persistence_state()
    await _wipe()
    yield
    await _wipe()
    mp.reset_memory_persistence_state()


async def make_line(gw: str) -> int:
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=U, gateway_id=gw, session_name=f"s-{gw[:8]}",
            status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return int(row.id)


async def make_conv(phone: str, sid: Optional[int]) -> int:
    async with AsyncSessionLocal() as db:
        c = Contact(user_id=U, phone_e164=phone, display_name="A46")
        db.add(c)
        await db.flush()
        conv = Conversation(user_id=U, contact_id=c.id, channel="WHATSAPP", session_id=sid)
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        return int(conv.id)


def gw_msg(jid: str, wa: str, at: datetime, **extra: Any) -> Dict[str, Any]:
    m = {
        "id": int(at.timestamp() * 1000),
        "conversation_id": jid, "wa_message_id": wa,
        "direction": "INBOUND", "message_type": "TEXT", "body": "x",
        "status": "RECEIVED", "created_at": at.isoformat().replace("+00:00", "Z"),
        "timestamp_s": int(at.timestamp()), "sender_phone": "+905551112233",
        "recipient_phone": "ME", "sender_name": "A46", "reactions": [],
    }
    m.update(extra)
    return m


def row_of(conv: int, wa: str, at: datetime, cmid: Optional[str] = None) -> Message:
    return Message(
        conversation_id=conv, user_id=U, direction="INBOUND", message_type="TEXT",
        recipient_phone="ME", status="RECEIVED", body="x",
        wa_message_id=wa, client_message_id=cmid,
        external_timestamp=at.replace(tzinfo=None),
        created_at=at.replace(tzinfo=None), updated_at=at.replace(tzinfo=None),
    )


async def count(conv: int) -> int:
    async with AsyncSessionLocal() as db:
        return len(
            (await db.execute(select(Message.id).where(Message.conversation_id == conv))).all()
        )


async def ids_of(conv: int) -> List[str]:
    """Yazılan `wa_message_id` kümesi — sıralı. "Hangi satır hayatta kaldı"."""
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Message.wa_message_id).where(Message.conversation_id == conv)
        )
        return sorted(str(r[0]) for r in res.all())


async def drain(
    gw: str,
    pages: List[Dict[str, Any]],
    *,
    sid: Optional[int],
    page_size: int = 5,
    max_pages: int = 20,
    start_offset: int = 0,
) -> Dict[str, Any]:
    """`pages` is a list of (messages, total) tuples served in call order."""
    calls = {"n": 0}

    async def _fake(_gw, limit=1000, offset=0, since=None, per_chat_limit=None, jids=None, **kwargs):
        i = calls["n"]
        calls["n"] += 1
        if i >= len(pages):
            return {"messages": [], "total": pages[-1][1] if pages else 0,
                    "offset": offset, "limit": limit}
        msgs, total = pages[i]
        return {"messages": msgs, "total": total, "offset": offset, "limit": limit}

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=_fake):
            return await mp.drain_gateway_memory_once(
                db, user_id=U, gateway_id=gw, session_db_id=sid,
                page_size=page_size, max_pages=max_pages,
                per_chat_limit=2000, start_offset=start_offset,
            )


# ---------------------------------------------------------------------------
# A1/A2 — the arbiter covers wa_message_id, and therefore HIDES a simultaneous
#          client_message_id violation on the very same row
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a1_exact_duplicate_is_absorbed_by_the_wa_arbiter():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000001@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)

    async with AsyncSessionLocal() as db:
        first = await _insert_messages_resilient(db, [row_of(conv, "DUP", at, "C-1")])
        await db.commit()
        assert len(first) == 1

    async with AsyncSessionLocal() as db:
        again = await _insert_messages_resilient(db, [row_of(conv, "DUP", at, "C-1")])
        await db.commit()
        assert again == [], "ON CONFLICT (conv, wa_id) absorbed the whole row"
    assert await count(conv) == 1


@pytest.mark.asyncio
async def test_a2_same_client_id_with_new_wa_id_is_not_absorbed():
    """UPDATED FOR 4.7. The row violates uq_msg_conv_client_message_id only.

    Old expectation: `_insert_messages_resilient` raised `IntegrityError` and the
    caller had to catch it. 4.7 moved the isolation INSIDE the helper, so the
    caller now receives an empty result plus a `dead_letter` count. The guarantee
    that matters is unchanged: the new wa_message_id is NOT absorbed into the
    existing row.
    """
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000002@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)

    async with AsyncSessionLocal() as db:
        await _insert_messages_resilient(db, [row_of(conv, "W-1", at, "SAME")])
        await db.commit()

    async with AsyncSessionLocal() as db:
        dead = {"count": 0, "constraint": None}
        written = await _insert_messages_resilient(
            db, [row_of(conv, "W-2", at, "SAME")], dead_letter=dead
        )
        await db.commit()

    assert written == [], "the colliding row must not be written"
    assert dead["count"] == 1, "it must be counted as a dead letter"
    assert dead["constraint"] == "uq_msg_conv_client_message_id"
    assert await count(conv) == 1, "the pre-existing row is untouched"
    assert await ids_of(conv) == ["W-1"], "W-2 is not absorbed into W-1"


# ---------------------------------------------------------------------------
# A3 — PostgreSQL permits exactly ONE ON CONFLICT clause per statement, so
#      "handle both indexes in the arbiter" is not expressible.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a3_two_arbiters_in_one_statement_is_a_syntax_error():
    async with AsyncSessionLocal() as db:
        with pytest.raises((ProgrammingError, Exception)) as ei:
            await db.execute(
                text(
                    "INSERT INTO messages (conversation_id, direction, message_type, "
                    "recipient_phone, status, wa_message_id, client_message_id, "
                    "created_at, updated_at) VALUES (1,'INBOUND','TEXT','ME','RECEIVED',"
                    "'a','b',now(),now()) "
                    "ON CONFLICT (conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL "
                    "DO NOTHING "
                    "ON CONFLICT (conversation_id, client_message_id) "
                    "WHERE client_message_id IS NOT NULL DO NOTHING"
                )
            )
        msg = str(ei.value).lower()
        assert "syntax" in msg or "conflict" in msg, msg[:200]
        await db.rollback()


# ---------------------------------------------------------------------------
# A4 — prototype of the recommended fix: per-row savepoints isolate the poison
#      record and the rest of the page still lands.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a4_row_level_savepoint_isolates_the_poison_row():
    """UPDATED FOR 4.7. The isolation moved from the CALLER into the helper.

    Old expectation: the caller tried the batch, caught `IntegrityError`, rolled
    back, and re-inserted row by row itself — `dead` was counted in the test.

    4.7 performs exactly that dance inside `_insert_messages_resilient`, so the
    caller only passes a `dead_letter` sink. The observable guarantee is
    identical: 4 good rows survive, exactly 1 poison row is isolated.
    """
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000003@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 3, 9, 0, tzinfo=timezone.utc)

    async with AsyncSessionLocal() as db:
        await _insert_messages_resilient(db, [row_of(conv, "SEED", at, "TAKEN")])
        await db.commit()

    batch = [row_of(conv, f"OK{i}", at + timedelta(minutes=i), f"C{i}") for i in range(4)]
    batch.insert(2, row_of(conv, "POISON", at + timedelta(minutes=9), "TAKEN"))

    async with AsyncSessionLocal() as db:
        dead = {"count": 0, "constraint": None}
        written = await _insert_messages_resilient(db, batch, dead_letter=dead)
        await db.commit()

    assert len(written) == 4, "the four good rows must survive"
    assert dead["count"] == 1, "exactly the poison row is isolated"
    assert dead["constraint"] == "uq_msg_conv_client_message_id"
    assert await count(conv) == 5, "4 new + the 1 pre-existing seed row"
    assert "POISON" not in await ids_of(conv)


# ---------------------------------------------------------------------------
# B1/B2 — cursor semantics
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_b1_lost_cursor_costs_a_rescan_not_data():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000004@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 4, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_msg(jid, f"M{i}", at + timedelta(minutes=i)) for i in range(6)]

    first = await drain(gw, [(msgs, 6)], sid=sid, page_size=10)
    assert first["inserted"] == 6 and first["next_offset"] == 0

    # Process restart: cursor is gone, so the turn starts at 0 again.
    second = await drain(gw, [(msgs, 6)], sid=sid, page_size=10, start_offset=0)
    assert second["inserted"] == 0
    assert second["scanned"] == 6, "a full re-scan is the cost, not a loss"
    assert await count(conv) == 6


@pytest.mark.asyncio
async def test_b2_stale_high_cursor_self_heals_on_the_next_turn():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000005@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_msg(jid, f"S{i}", at + timedelta(minutes=i)) for i in range(3)]

    stale = await drain(gw, [([], 3)], sid=sid, page_size=10, start_offset=5000)
    assert stale["pages"] == 0
    assert stale["next_offset"] == 0, "an out-of-range offset resets, it does not stall"
    assert stale["inserted"] == 0
    assert "error" not in stale

    healed = await drain(gw, [(msgs, 3)], sid=sid, page_size=10,
                         start_offset=int(stale["next_offset"]))
    assert healed["inserted"] == 3
    assert await count(conv) == 3


@pytest.mark.asyncio
async def test_b3_two_workers_on_the_same_offset_do_not_duplicate():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000006@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 6, 9, 0, tzinfo=timezone.utc)
    msgs = [gw_msg(jid, f"W{i}", at + timedelta(minutes=i)) for i in range(6)]

    a, b = await asyncio.gather(
        drain(gw, [(msgs, 6)], sid=sid, page_size=10),
        drain(gw, [(msgs, 6)], sid=sid, page_size=10),
    )
    assert a["inserted"] + b["inserted"] == 6, "each row is written exactly once"
    assert await count(conv) == 6


# ---------------------------------------------------------------------------
# C1/C2 — offset pagination over a MUTATING list
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_c1_front_trim_between_pages_skips_records():
    """The 2000-cap splice removes from the FRONT, which shifts every later
    index left: an offset-based walk then never visits the boundary rows."""
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000007@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)
    all_msgs = [gw_msg(jid, f"T{i}", at + timedelta(minutes=i)) for i in range(10)]

    page1 = (all_msgs[0:5], 10)
    # After page 1 the store evicted the three oldest (splice(0, 3)).
    after = all_msgs[3:]
    page2 = (after[5:10], len(after))

    stats = await drain(gw, [page1, page2], sid=sid, page_size=5)
    written = await count(conv)

    assert stats["scanned"] == 7
    assert written == 7, "T5..T7 were never visited"
    async with AsyncSessionLocal() as db:
        got = {
            str(r[0])
            for r in (
                await db.execute(
                    select(Message.wa_message_id).where(Message.conversation_id == conv)
                )
            ).all()
        }
    assert {"T5", "T6", "T7"}.isdisjoint(got), "the boundary rows were skipped"
    assert written < 10, "documents the skip"


@pytest.mark.asyncio
async def test_c2_append_between_pages_does_not_skip():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905547000008@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)
    at = datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc)
    all_msgs = [gw_msg(jid, f"A{i}", at + timedelta(minutes=i)) for i in range(10)]

    page1 = (all_msgs[0:5], 10)
    grown = all_msgs + [gw_msg(jid, f"N{i}", at + timedelta(hours=1, minutes=i)) for i in range(3)]
    page2 = (grown[5:10], len(grown))
    page3 = (grown[10:13], len(grown))

    stats = await drain(gw, [page1, page2, page3], sid=sid, page_size=5)
    assert stats["inserted"] == 13, "the three appends are reached too"
    assert await count(conv) == 13, "appends only extend the tail; nothing is skipped"
    async with AsyncSessionLocal() as db:
        got = {
            str(r[0])
            for r in (
                await db.execute(
                    select(Message.wa_message_id).where(Message.conversation_id == conv)
                )
            ).all()
        }
    assert {f"A{i}" for i in range(10)} <= got, "no original record is skipped"


# ---------------------------------------------------------------------------
# D1 — the event row and the message row share one transaction
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_d1_message_and_processed_event_commit_together():
    from backend.app.services.whatsapp_service import ingest_gateway_event

    gw = f"gw-{_uuid.uuid4().hex}"
    await make_line(gw)
    jid = "905547000009@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", None)
    ev_id = str(_uuid.uuid4())
    event = {
        "event": "message_new",
        "event_id": ev_id,
        "gateway_session_id": gw,
        "message": {
            "conversation_id": jid, "wa_message_id": "EVT-1",
            "direction": "INBOUND", "message_type": "TEXT", "body": "x",
            "created_at": "2026-10-09T09:00:00.000Z",
        },
    }
    first = await ingest_gateway_event(event)
    assert first is not None and not first.get("_duplicate")

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                text("SELECT count(*) FROM whatsapp_private.processed_events WHERE event_id = :e"),
                {"e": ev_id},
            )
        ).scalar()
        assert rows == 1, "the dedup row exists only because the message committed"

    second = await ingest_gateway_event(event)
    assert second.get("_duplicate") is True
    assert await count(conv) == 1
