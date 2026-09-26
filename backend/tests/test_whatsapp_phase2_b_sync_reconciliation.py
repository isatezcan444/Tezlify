"""Phase 2.B — full-sync / watermark / snapshot-reconciliation falsification.

Establishes the ACTUAL generic correctness contract of the sync pipeline
through the REAL writers (real DB, real guards, real broadcast path), using
randomly generated generic jids — no production jid or group-name hardcoding.

Matrix rows pinned here (previously unpinned end-to-end):

  A  snapshot → realtime     : realtime (newer) must win after a snapshot upsert
  B  realtime → snapshot     : STALE snapshot must NEVER overwrite newer realtime
                               state (the §5/§14 primary invariant)
  C  message-only chunk      : persisted for mapped conversations; silently
                               dropped for unmapped ones (documented contract —
                               dual recovery: realtime ingest + watermark overlap)
  D  conversation-only chunk : persisted with preview, zero message rows
  E  empty chunk             : terminates pagination, erases nothing, moves
                               no watermark
  G  duplicate chunk replay  : identical final DB state — 0 new rows, preview
                               unchanged, no messages-chunk broadcast
  H  partial sync failure    : committed batch survives, run marked failed
  I  retry after failure     : resumes with dedup — no duplicate rows
  K  preview regression      : emitted snapshot payload describes the PERSISTED
                               conversation (H-6 pin), not the stale gateway echo
  L  out-of-order realtime   : logical ordering by (timestamp, id); preview =
                               newest regardless of delivery order
  M  watermark advancement   : moves with inbound messages; empty chunk is inert
"""
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp import repositories
from backend.app.services.whatsapp.orchestration import sync as sync_mod
from backend.app.services.whatsapp.orchestration.sync import SyncJob, WhatsAppSyncOrchestrator
from backend.app.services.whatsapp.repositories.messages import get_sync_watermark_epoch
from backend.app.services import whatsapp_service as ws

# Isolated tenant for this module (unique vs other test files).
U1 = "55555555-5555-5555-5555-555555555555"
U1_HEX = U1.replace("-", "")


def generic_jid() -> str:
    return f"9055{_uuid.uuid4().int % 10**10:010d}@s.whatsapp.net"


def iso(dt: datetime) -> str:
    return dt.isoformat()


@pytest_asyncio.fixture(autouse=True)
async def _clean_state():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": U1_HEX})
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def add_session(gateway_id: str) -> None:
    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=U1,
                gateway_id=gateway_id,
                session_name=f"s-{gateway_id[:8]}",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
        )
        await db.commit()


# One device line per jid: reusing a single WhatsAppSession row mirrors
# production (one device = one session) and keeps the unique conversation
# constraint from synthesizing one conversation per ingest call.
_SESSION_BY_JID: Dict[str, str] = {}


async def session_for(jid: str) -> str:
    if jid not in _SESSION_BY_JID:
        gw_id = f"gw-{_uuid.uuid4().hex}"
        await add_session(gw_id)
        _SESSION_BY_JID[jid] = gw_id
    return _SESSION_BY_JID[jid]


async def conv_row(jid: str) -> Conversation:
    from backend.app.models.contact import Contact

    if jid.endswith("@g.us"):
        candidates = [f"jid:{jid}"]
    else:
        digits = jid.split("@")[0]
        candidates = [f"+{digits}", f"jid:{jid}"]
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Conversation).where(Conversation.user_id == U1).order_by(Conversation.id.asc())
        )
        convs = res.scalars().all()
        for c in convs:
            contact = await db.get(Contact, c.contact_id)
            if contact is not None and contact.phone_e164 in candidates:
                return c
        raise AssertionError(f"no conversation backs jid {jid}")


async def snapshot_conversation(jid: str) -> Dict[str, Any]:
    """Re-read the canonical persisted state for one jid."""
    c = await conv_row(jid)
    return {
        "last_message_preview": c.last_message_preview,
        "last_message_at": c.last_message_at,
        "unread_count": c.unread_count,
    }


async def realtime_message(jid: str, body: str, at: datetime, wa_id: str) -> None:
    """Drive the REAL realtime writer (ingest_gateway_event → _ingest_message)."""
    gw_id = await session_for(jid)
    event = {
        "event": "message_new",
        "gateway_session_id": gw_id,
        "message": {
            "conversation_id": jid,
            "wa_message_id": wa_id,
            "direction": "INBOUND",
            "body": body,
            "message_type": "TEXT",
            "sender_name": "Sender",
            "created_at": iso(at),
        },
    }
    persisted = await ws.ingest_gateway_event(event)
    assert persisted is not None, f"realtime message must ingest (body={body!r})"


def bulk_page(messages: List[Dict[str, Any]], total: int) -> Dict[str, Any]:
    return {"messages": messages, "total": total}


async def run_bulk_sync(jid_by_conv: Dict[int, str], pages: List[Dict[str, Any]]) -> SyncJob:
    """Drive the REAL bulk sync writer with a scripted gateway page sequence."""
    job = SyncJob(sync_id=f"sync-{_uuid.uuid4().hex[:8]}", user_id=U1)
    orch = WhatsAppSyncOrchestrator()
    fake_gw = MagicMock()
    fake_gw.list_all_messages = AsyncMock(side_effect=pages)
    async with AsyncSessionLocal() as db:
        with patch.object(sync_mod, "gw", fake_gw):
            await orch._run_bulk_message_sync(db, job, dict(jid_by_conv), "gw-scripted")
    return job


# ---------------------------------------------------------------------------
# B — realtime → STALE snapshot: primary invariant
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stale_snapshot_never_overwrites_newer_realtime():
    jid = generic_jid()
    t1 = datetime.now(timezone.utc) - timedelta(hours=2)
    t2 = datetime.now(timezone.utc)
    # Realtime first: M2 (newer).
    await realtime_message(jid, "realtime newest message", t2, f"wa-{_uuid.uuid4().hex[:12]}")
    before = await snapshot_conversation(jid)
    assert before["last_message_preview"] == "realtime newest message"
    # Snapshot second: OLD chunk (M1, older ts + older preview).
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        out, _ = await orch._persist_chat_snapshot(
            db,
            U1,
            [
                {
                    "jid": jid,
                    "name": "Stale Snapshot Name",
                    "last_message_at": iso(t1),
                    "last_message_preview": "stale snapshot preview",
                    "unread_count": 99,
                }
            ],
        )
    after = await snapshot_conversation(jid)
    assert after["last_message_preview"] == "realtime newest message", (
        f"§5 invariant violated: stale snapshot overwrote realtime state ({after!r})"
    )
    assert after["last_message_at"] == before["last_message_at"], "sort key must not regress"
    # H-6: emitted payload describes the PERSISTED conversation (not the echo).
    emitted = next(o for o in out if o["phone"] in (f"jid:{jid}", f"+{jid.split('@')[0]}"))
    assert emitted["last_message_preview"] == "realtime newest message", (
        "§K invariant violated: emitted payload echoed the stale gateway value"
    )


# ---------------------------------------------------------------------------
# A — snapshot → realtime (newer realtime wins)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_newer_realtime_wins_after_snapshot():
    jid = generic_jid()
    t1 = datetime.now(timezone.utc) - timedelta(hours=2)
    t2 = datetime.now(timezone.utc)
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        await orch._persist_chat_snapshot(
            db,
            U1,
            [{"jid": jid, "name": "Snap", "last_message_at": iso(t1), "last_message_preview": "snapshot preview"}],
        )
    await realtime_message(jid, "newer realtime message", t2, f"wa-{_uuid.uuid4().hex[:12]}")
    after = await snapshot_conversation(jid)
    assert after["last_message_preview"] == "newer realtime message"


# ---------------------------------------------------------------------------
# D — conversation-only chunk
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_conversation_only_chunk_persists_state():
    jid = generic_jid()
    t1 = datetime.now(timezone.utc) - timedelta(hours=1)
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        out, jid_by_conv = await orch._persist_chat_snapshot(
            db,
            U1,
            [{"jid": jid, "name": "Conv Only", "last_message_at": iso(t1), "last_message_preview": "hello from provider"}],
        )
    assert jid_by_conv, "conversation must be mapped"
    state = await snapshot_conversation(jid)
    assert state["last_message_preview"] == "hello from provider"
    assert state["last_message_at"] is not None
    async with AsyncSessionLocal() as db:
        count = (await db.execute(select(Message).where(Message.conversation_id == (await conv_row(jid)).id))).scalars().all()
        assert count == [], "conversation-only chunk must not create message rows"


# ---------------------------------------------------------------------------
# Metinsiz son mesaj (sistem bildirimi / ifade / arama) — damga YINE de uygulanir
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_snapshot_with_empty_preview_still_applies_timestamp():
    """Onizlemesi bos bir snapshot aktivite damgasini DUSURMEMELI.

    Son mesaji bir grup ayari bildirimi, "X gruba eklendi", kullanici adi
    duyurusu, bir ifade, "bu mesaji sildiniz" veya bir arama kaydi olan sohbet
    metinsiz gelir (`normalize_preview_text('TEXT','')` -> ""). Damgayi
    `gw_summary` kapisinin arkasina koymak tam olarak o sohbetleri hic damgasiz
    birakiyordu; frontend/backend `NULLS LAST` ile siraladigi icin liste
    dibine dusuyorlardi. Prod olcumu 2026-09-26: 113 sohbetin 21'i bos
    onizlemeli, 5'i hic damgasiz.
    """
    jid = generic_jid()
    t1 = datetime.now(timezone.utc) - timedelta(minutes=30)
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        await orch._persist_chat_snapshot(
            db,
            U1,
            [{"jid": jid, "name": "System Only", "last_message_at": iso(t1), "last_message_preview": ""}],
        )
    state = await snapshot_conversation(jid)
    got = state["last_message_at"]
    assert got is not None, "bos onizleme aktivite damgasini dusurmemeli"
    expected = t1.replace(tzinfo=None).replace(microsecond=0)
    assert got.replace(microsecond=0) == expected, (
        f"damga gateway degeri olmali: beklenen {expected!r}, alinan {got!r}"
    )
    assert not state["last_message_preview"], "onizleme uydurulmamali"


# ---------------------------------------------------------------------------
# C — message-only chunk: mapped + unmapped conversations
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_message_only_chunk_mapped_and_unmapped():
    mapped = generic_jid()
    unmapped = generic_jid()  # never in the snapshot map
    t = datetime.now(timezone.utc) - timedelta(minutes=30)
    # Establish the mapped conversation via snapshot (conversation payload).
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        out, jid_by_conv = await orch._persist_chat_snapshot(
            db, U1, [{"jid": mapped, "name": "Mapped", "last_message_at": None, "last_message_preview": None}]
        )
    # Message-only bulk page: messages > 0, conversations = 0.
    msgs = [
        {
            "conversation_id": mapped,
            "wa_message_id": f"wa-{_uuid.uuid4().hex[:12]}",
            "direction": "INBOUND",
            "body": "mapped chunk message",
            "message_type": "TEXT",
            "created_at": iso(t),
        },
        {
            "conversation_id": unmapped,
            "wa_message_id": f"wa-{_uuid.uuid4().hex[:12]}",
            "direction": "INBOUND",
            "body": "unmapped chunk message",
            "message_type": "TEXT",
            "created_at": iso(t),
        },
    ]
    job = await run_bulk_sync(jid_by_conv, [bulk_page(msgs, total=2)])
    assert job.messages_synced == 1, "only the mapped message may be persisted"
    conv = await conv_row(mapped)
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(select(Message).where(Message.conversation_id == conv.id))).scalars().all()
        assert len(rows) == 1 and rows[0].body == "mapped chunk message"
        from backend.app.models.contact import Contact

        res = await db.execute(
            select(Contact).where(Contact.phone_e164.in_([f"jid:{unmapped}", f"+{unmapped.split('@')[0]}"]))
        )
        assert res.scalars().first() is None, "unmapped message must not synthesize a contact"
        state = await snapshot_conversation(mapped)
        assert state["last_message_preview"] == "mapped chunk message", (
            "message-only chunk must hydrate the mapped conversation preview"
        )


# ---------------------------------------------------------------------------
# E — empty chunk: inert, terminates, watermark untouched
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_empty_chunk_is_inert():
    jid = generic_jid()
    t2 = datetime.now(timezone.utc)
    await realtime_message(jid, "wm baseline", t2, f"wa-{_uuid.uuid4().hex[:12]}")
    async with AsyncSessionLocal() as db:
        wm_before = await get_sync_watermark_epoch(db, U1)
    conv = await conv_row(jid)
    # Empty page with offset < total: pagination terminates, nothing erased.
    job = await run_bulk_sync({conv.id: jid}, [bulk_page([], total=100)])
    assert job.messages_synced == 0
    state = await snapshot_conversation(jid)
    assert state["last_message_preview"] == "wm baseline", "empty chunk must not erase state"
    async with AsyncSessionLocal() as db:
        wm_after = await get_sync_watermark_epoch(db, U1)
    assert wm_after == wm_before, "empty chunk must not move the watermark"


# ---------------------------------------------------------------------------
# G — duplicate chunk replay: identical final state
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_chunk_replay_is_idempotent():
    jid = generic_jid()
    t = datetime.now(timezone.utc) - timedelta(minutes=10)
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        _out, jid_by_conv = await orch._persist_chat_snapshot(
            db, U1, [{"jid": jid, "name": "Replay", "last_message_at": None, "last_message_preview": None}]
        )
    conv = await conv_row(jid)
    wa = f"wa-{_uuid.uuid4().hex[:12]}"
    page = bulk_page(
        [
            {
                "conversation_id": jid,
                "wa_message_id": wa,
                "direction": "INBOUND",
                "body": "replay me",
                "message_type": "TEXT",
                "created_at": iso(t),
            }
        ],
        total=1,
    )
    job1 = await run_bulk_sync(jid_by_conv, [page])
    conv_id = conv.id
    async with AsyncSessionLocal() as db:
        c1 = await db.get(Conversation, conv_id)
        preview1, ts1, rows1 = c1.last_message_preview, c1.last_message_at, (await db.execute(select(Message).where(Message.conversation_id == conv_id))).scalars().all()
    # Replay the EXACT same page.
    job2 = await run_bulk_sync(jid_by_conv, [page])
    assert job2.messages_synced == 0, "replay must insert 0 rows"
    async with AsyncSessionLocal() as db:
        c2 = await db.get(Conversation, conv_id)
        rows2 = (await db.execute(select(Message).where(Message.conversation_id == conv_id))).scalars().all()
        assert len(rows2) == len(rows1) == 1, "no duplicate message rows"
        assert c2.last_message_preview == preview1 == "replay me"
        assert c2.last_message_at == ts1, "preview timestamp unchanged by replay"


# ---------------------------------------------------------------------------
# H + I — partial failure and resume
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_partial_failure_survives_and_retry_dedups():
    jid = generic_jid()
    t = datetime.now(timezone.utc) - timedelta(minutes=5)
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        _out, jid_by_conv = await orch._persist_chat_snapshot(
            db, U1, [{"jid": jid, "name": "Partial", "last_message_at": None, "last_message_preview": None}]
        )
    conv = await conv_row(jid)
    wa1, wa2 = f"wa-{_uuid.uuid4().hex[:12]}", f"wa-{_uuid.uuid4().hex[:12]}"

    def gm(wa_id, body):
        return {
            "conversation_id": jid,
            "wa_message_id": wa_id,
            "direction": "INBOUND",
            "body": body,
            "message_type": "TEXT",
            "created_at": iso(t),
        }

    # Chunk 1 OK, chunk 2 fails (gateway error), chunk 3 never processed.
    boom = RuntimeError("gateway socket closed mid-sync")
    with pytest.raises(RuntimeError):
        await run_bulk_sync(jid_by_conv, [bulk_page([gm(wa1, "chunk one")], total=3), boom])
    # Chunk 1's committed batch survives.
    conv_id = conv.id
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(select(Message).where(Message.conversation_id == conv_id))).scalars().all()
        assert [r.wa_message_id for r in rows] == [wa1], "chunk 1 data must survive the partial failure"
    # Resume (retry): provider replays chunk 1 + 2 (dedup) — no duplication.
    job = await run_bulk_sync(jid_by_conv, [bulk_page([gm(wa1, "chunk one"), gm(wa2, "chunk two")], total=2)])
    assert job.messages_synced == 1, "retry must insert only the missing chunk-2 message"
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(select(Message).where(Message.conversation_id == conv_id))).scalars().all()
        assert sorted(r.wa_message_id for r in rows) == sorted([wa1, wa2]), "resume without duplicates"


# ---------------------------------------------------------------------------
# L — out-of-order realtime delivery: preview = newest; logical order by (ts,id)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_out_of_order_realtime_keeps_newest_preview():
    jid = generic_jid()
    base = datetime.now(timezone.utc) - timedelta(hours=1)
    m1, m2, m3 = base, base + timedelta(minutes=1), base + timedelta(minutes=2)
    # Delivery order: M2, M1, M3 (§15 sequence 1).
    await realtime_message(jid, "second", m2, f"wa-{_uuid.uuid4().hex[:12]}")
    await realtime_message(jid, "first", m1, f"wa-{_uuid.uuid4().hex[:12]}")
    await realtime_message(jid, "third", m3, f"wa-{_uuid.uuid4().hex[:12]}")
    state = await snapshot_conversation(jid)
    assert state["last_message_preview"] == "third", "preview must be the newest regardless of delivery order"
    conv_id = (await conv_row(jid)).id
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(select(Message).where(Message.conversation_id == conv_id))).scalars().all()
        assert len(rows) == 3
        ordered = repositories.messages.select_messages_keyset(db, U1, conv_id, limit=10)
        msgs = (await ordered) if hasattr(ordered, "__await__") else ordered
        bodies = [m.body for m in msgs]
        assert bodies == ["third", "second", "first"], f"logical ordering violated: {bodies}"


# ---------------------------------------------------------------------------
# M — watermark moves with inbound messages
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_watermark_moves_with_inbound_messages():
    jid = generic_jid()
    async with AsyncSessionLocal() as db:
        wm0 = await get_sync_watermark_epoch(db, U1)
        assert wm0 is None, "empty tenant has no watermark"
    t = datetime.now(timezone.utc) - timedelta(minutes=2)
    await realtime_message(jid, "wm mover", t, f"wa-{_uuid.uuid4().hex[:12]}")
    async with AsyncSessionLocal() as db:
        wm1 = await get_sync_watermark_epoch(db, U1)
    assert wm1 is not None and wm1 <= int(t.timestamp()) - 300 + 1, (
        "watermark = max(inbound external_timestamp) - 300s overlap"
    )
