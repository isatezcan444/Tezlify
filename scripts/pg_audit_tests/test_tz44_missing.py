"""AŞAMA 4.4 §F — the four drain-path scenarios the repo suite does NOT cover.

Repo coverage already maps the directive's eight required scenarios as:

  1. client_message_id collision ................ MISSING  -> here (T1/T1b/T1c)
  2. page rollback .............................. partial  -> here (T2)
  3. cursor progress ............................ covered  (hardening:554/582)
  4. group JID matching ......................... MISSING  -> here (T4)
  5. LID mapping ................................ negative only -> here (T5, positive)
  6. live event with same wa_message_id ......... covered  (test 3)
  7. idempotency on second run .................. covered  (test 2 + hardening:380)
  8. partial batch failure ...................... partial  -> here (T2b)

This module is NOT part of the repository and must never be added to it.
Run against the throwaway PostgreSQL cluster only (see /tmp/tz44/pg_provision.py).
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp import memory_persistence as mp

U4 = "99999999-9999-9999-9999-999999999991"
U4_HEX = U4.replace("-", "")


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setattr(mp.settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", True, raising=False)


@pytest_asyncio.fixture(autouse=True)
async def _clean():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": U4_HEX}
                )
            await db.commit()

    mp.reset_memory_persistence_state()
    await _wipe()
    yield
    await _wipe()
    mp.reset_memory_persistence_state()


async def make_line(gateway_id: str) -> int:
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=U4,
            gateway_id=gateway_id,
            session_name=f"s-{gateway_id[:8]}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return int(row.id)


async def make_conv(phone_field: str, session_db_id: Optional[int]) -> int:
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=U4, phone_e164=phone_field, display_name="T44")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=U4, contact_id=contact.id, channel="WHATSAPP", session_id=session_db_id
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        return int(conv.id)


def gw_msg(jid: str, wa_id: str, at: datetime, **extra: Any) -> Dict[str, Any]:
    msg = {
        "id": int(at.timestamp() * 1000),
        "conversation_id": jid,
        "wa_message_id": wa_id,
        "direction": "INBOUND",
        "message_type": "TEXT",
        "body": "x",
        "status": "RECEIVED",
        "created_at": at.isoformat().replace("+00:00", "Z"),
        "timestamp_s": int(at.timestamp()),
        "sender_phone": "+905551112233",
        "recipient_phone": "ME",
        "sender_name": "T44",
        "reactions": [],
    }
    msg.update(extra)
    return msg


async def drain(
    gateway_id: str,
    msgs: List[Dict[str, Any]],
    *,
    session_db_id: Optional[int],
    page_size: int = 500,
    max_pages: int = 20,
) -> Dict[str, Any]:
    pages: List[Dict[str, Any]] = []
    off = 0
    total = len(msgs)
    while off < total or (total == 0 and off == 0):
        pages.append(
            {"messages": msgs[off:off + page_size], "total": total, "offset": off, "limit": page_size}
        )
        off += page_size
        if off >= total:
            break
    calls = {"n": 0}

    async def _fake(_gw, limit=1000, offset=0, since=None, per_chat_limit=None, jids=None, **kwargs):
        i = calls["n"]
        calls["n"] += 1
        if i >= len(pages):
            return {"messages": [], "total": total, "offset": offset, "limit": limit}
        return pages[i]

    async with AsyncSessionLocal() as db:
        with patch.object(mp.gw, "list_all_messages", side_effect=_fake):
            return await mp.drain_gateway_memory_once(
                db,
                user_id=U4,
                gateway_id=gateway_id,
                session_db_id=session_db_id,
                page_size=page_size,
                max_pages=max_pages,
                per_chat_limit=2000,
            )


async def count(conv_id: int) -> int:
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Message.id).where(Message.conversation_id == conv_id))
        return len(res.all())


# ---------------------------------------------------------------------------
# T1 — client_message_id collision: the arbiter does NOT cover the second index
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_t1_client_message_id_collision_isolates_the_poison_row():
    """UPDATED FOR 4.7. Old expectation: the whole page aborts.

    Before 4.7 the bulk INSERT used a single arbiter
    `(conversation_id, wa_message_id)`, so a collision on the OTHER unique index
    (`uq_msg_conv_client_message_id`) raised and the entire page was lost.

    4.7 wraps the bulk INSERT in a SAVEPOINT and, on failure, retries row by row
    inside per-row savepoints. The good row survives and the poison row is
    counted in `dead_letter` — nothing is silently dropped and nothing aborts.
    """
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905540000001@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)

    base = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)
    msgs = [
        gw_msg(jid, "WA-C1", base, client_message_id="DUP-CMID"),
        gw_msg(jid, "WA-C2", base + timedelta(minutes=1), client_message_id="DUP-CMID"),
    ]

    stats = await drain(gw, msgs, session_db_id=sid)

    # New contract: no page-level error, one row written, one row dead-lettered.
    assert "error" not in stats, stats
    assert stats["scanned"] == 2
    assert stats["inserted"] == 1, "the first row must survive"
    assert stats["dead_letter"] == 1, "exactly the colliding row is isolated"
    assert await count(conv) == 1, "no partial page, no total loss"
    assert await ids_of(conv) == ["WA-C1"]


async def ids_of(conv_id: int) -> List[str]:
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Message.wa_message_id).where(Message.conversation_id == conv_id)
        )
        return sorted(str(r[0]) for r in res.all())


@pytest.mark.asyncio
async def test_t1b_collision_no_longer_stalls_the_cursor():
    """UPDATED FOR 4.7. Old expectation: `next_offset` parks on the bad page
    forever, so the tail (`NEVER`) is permanently unreachable.

    That stall WAS the dangerous consequence of a page-level abort: the cursor
    could not move past a page it kept failing on, and every later turn re-read
    the same prefix.

    4.7 isolates the poison row inside the page, so the page commits, the cursor
    advances, and the tail is reached. The threat model is unchanged — only the
    outcome is.
    """
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905540000002@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)

    base = datetime(2026, 9, 2, 8, 0, tzinfo=timezone.utc)
    # page_size=2 -> page[0]=clean, page[2]=poisoned (both colliding rows), page[4]=tail
    msgs = [
        gw_msg(jid, "OK-1", base),
        gw_msg(jid, "OK-2", base + timedelta(minutes=1)),
        gw_msg(jid, "POISON-A", base + timedelta(minutes=2), client_message_id="STALL"),
        gw_msg(jid, "POISON-B", base + timedelta(minutes=3), client_message_id="STALL"),
        gw_msg(jid, "NEVER", base + timedelta(minutes=4)),
    ]
    first = await drain(gw, msgs, session_db_id=sid, page_size=2, max_pages=10)
    second = await drain(gw, msgs, session_db_id=sid, page_size=2, max_pages=10)

    assert "error" not in first, first
    assert first["pages"] == 3, "every page is visited, none aborts"
    assert first["inserted"] == 4, "clean rows on both sides of the poison survive"
    assert first["dead_letter"] == 1, "exactly one row is isolated"
    assert first["next_offset"] == 0, "the cursor reached the end of the store"

    # The tail is REACHABLE now — this is the assertion that used to be inverted.
    assert await ids_of(conv) == ["NEVER", "OK-1", "OK-2", "POISON-A"]
    assert "POISON-B" not in await ids_of(conv)

    # Idempotent: a second turn adds nothing and still does not error.
    assert "error" not in second, second
    assert second["inserted"] == 0
    assert await count(conv) == 4


@pytest.mark.asyncio
async def test_t1c_collision_against_an_existing_row():
    """UPDATED FOR 4.7. Old expectation: a page-level `IntegrityError`.

    4.7 reports the isolated row through `dead_letter` instead, and leaves the
    pre-existing row untouched.
    """
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905540000003@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)

    base = datetime(2026, 9, 3, 8, 0, tzinfo=timezone.utc)
    await drain(gw, [gw_msg(jid, "SEED", base, client_message_id="TAKEN")], session_db_id=sid)
    assert await count(conv) == 1

    stats = await drain(
        gw, [gw_msg(jid, "LATE", base + timedelta(minutes=1), client_message_id="TAKEN")],
        session_db_id=sid,
    )
    assert "error" not in stats, stats
    assert stats["dead_letter"] == 1, "the colliding row is isolated, not the page"
    assert stats["inserted"] == 0
    assert await count(conv) == 1, "the pre-existing row is untouched"
    assert await ids_of(conv) == ["SEED"]


@pytest.mark.asyncio
async def test_t1d_gateway_payload_without_client_message_id_never_collides():
    """Production risk = 0 because the drain path stores NULL, and the partial
    index is `WHERE client_message_id IS NOT NULL`."""
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905540000004@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)

    base = datetime(2026, 9, 4, 8, 0, tzinfo=timezone.utc)
    msgs = [gw_msg(jid, f"N{i}", base + timedelta(minutes=i)) for i in range(5)]
    stats = await drain(gw, msgs, session_db_id=sid)

    assert stats["inserted"] == 5
    assert "error" not in stats
    async with AsyncSessionLocal() as db:
        non_null = (
            await db.execute(
                text(
                    "SELECT count(*) FROM messages WHERE conversation_id = :c "
                    "AND client_message_id IS NOT NULL"
                ),
                {"c": conv},
            )
        ).scalar()
    assert non_null == 0


# ---------------------------------------------------------------------------
# T2 — page rollback / partial batch failure
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_t2_partial_page_commits_and_rerun_is_idempotent():
    """UPDATED FOR 4.7. Old expectation: the first turn errors and writes
    NOTHING (page-level rollback), then a clean rerun writes all 3.

    4.7 commits what it can: the 3 good rows plus the first of the two colliding
    rows survive, the second is dead-lettered, and no error is reported. A rerun
    is then a no-op — idempotency is preserved.
    """
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    jid = "905540000005@s.whatsapp.net"
    conv = await make_conv(f"+{jid.split('@')[0]}", sid)

    base = datetime(2026, 9, 5, 8, 0, tzinfo=timezone.utc)
    good = [gw_msg(jid, f"G{i}", base + timedelta(minutes=i)) for i in range(3)]
    poisoned = list(good) + [
        gw_msg(jid, "P1", base + timedelta(minutes=10), client_message_id="SAME"),
        gw_msg(jid, "P2", base + timedelta(minutes=11), client_message_id="SAME"),
    ]

    bad = await drain(gw, poisoned, session_db_id=sid)
    assert "error" not in bad, bad
    assert bad["inserted"] == 4, "3 good + the first of the two colliding rows"
    assert bad["dead_letter"] == 1, "only the second colliding row is isolated"
    assert await count(conv) == 4, "no half-written page is left behind"

    ok = await drain(gw, good, session_db_id=sid)
    assert ok["inserted"] == 0, "rerun is idempotent, nothing is duplicated"
    assert "error" not in ok
    assert await count(conv) == 4
    assert await ids_of(conv) == ["G0", "G1", "G2", "P1"]


# ---------------------------------------------------------------------------
# T4 — group JID matching (`jid:<id>@g.us` -> `<id>@g.us`)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_t4_group_jid_is_matched_and_written():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    gid = "120363118560107977@g.us"
    conv = await make_conv(f"jid:{gid}", sid)

    base = datetime(2026, 9, 6, 8, 0, tzinfo=timezone.utc)
    msgs = [gw_msg(gid, f"GR{i}", base + timedelta(minutes=i)) for i in range(3)]
    stats = await drain(gw, msgs, session_db_id=sid)

    assert stats["skipped_unmapped"] == 0
    assert stats["inserted"] == 3
    assert await count(conv) == 3


@pytest.mark.asyncio
async def test_t4b_unknown_group_is_skipped_not_invented():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    conv = await make_conv("+905540000006", sid)

    base = datetime(2026, 9, 7, 8, 0, tzinfo=timezone.utc)
    stats = await drain(
        gw,
        [gw_msg("120363000000000001@g.us", "UNK1", base)],
        session_db_id=sid,
    )
    assert stats["skipped_unmapped"] == 1
    assert stats["inserted"] == 0
    assert await count(conv) == 0


# ---------------------------------------------------------------------------
# T5 — REGISTERED LID bridge is followed (the positive half of A14/T)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_t5_registered_lid_bridge_is_followed():
    gw = f"gw-{_uuid.uuid4().hex}"
    sid = await make_line(gw)
    phone_jid = "905540000007@s.whatsapp.net"
    lid_jid = "218107046027315@lid"
    conv = await make_conv(f"+{phone_jid.split('@')[0]}", sid)

    async with AsyncSessionLocal() as db:
        # `lid_mappings.session_id` has an FK to `whatsapp_private.gateway_sessions`.
        await db.execute(
            text(
                "INSERT INTO whatsapp_private.gateway_sessions (session_id, session_name) "
                "VALUES (:s, :n) ON CONFLICT DO NOTHING"
            ),
            {"s": gw, "n": f"s-{gw[:8]}"},
        )
        await db.execute(
            text(
                "INSERT INTO whatsapp_private.lid_mappings (session_id, lid_jid, phone_jid) "
                "VALUES (:s, :l, :p) ON CONFLICT DO NOTHING"
            ),
            {"s": gw, "l": lid_jid, "p": phone_jid},
        )
        await db.commit()

    base = datetime(2026, 9, 8, 8, 0, tzinfo=timezone.utc)
    stats = await drain(gw, [gw_msg(lid_jid, "LIDOK1", base)], session_db_id=sid)

    assert stats["skipped_unmapped"] == 0, stats
    assert stats["inserted"] == 1
    assert await count(conv) == 1

    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM whatsapp_private.lid_mappings WHERE session_id = :s"), {"s": gw}
        )
        await db.commit()
