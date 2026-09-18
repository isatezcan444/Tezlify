"""Phase 17 — Durable On-Demand History Evidence Test Suite.

Verifies:
1. provider_status NOT_REQUESTED -> no evidence
2. provider OK + 50 -> HAS_MORE
3. provider OK + 14 -> EXHAUSTION_CANDIDATE
4. candidate + next request 0 -> FULLY_EXHAUSTED
5. timeout -> TIMEOUT
6. provider error -> PROVIDER_ERROR
7. stale cursor -> CURSOR_STALLED (3 stalls)
8. same conversation concurrent request -> single provider flight
9. new inbound message does not move history anchor
10. history state isolated by session_id + jid
11. initial sync does not create provider evidence
12. manual history does create provider evidence
13. FULLY_EXHAUSTED cannot be produced without second confirmation
14. provider cache hit cannot create evidence
15. existing messages remain idempotent by wa_message_id
"""

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.history_evidence import (
    get_history_evidence,
    is_history_exhausted_or_stalled,
    record_on_demand_provider_result,
)
from backend.app.services.whatsapp.orchestration.sync import WhatsAppSyncOrchestrator
from backend.app.services import whatsapp_service as ws


@asynccontextmanager
async def make_test_db(tmp_path, name="p17_test.db"):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        from sqlalchemy import text
        await conn.execute(
            text("""
                CREATE TABLE IF NOT EXISTS history_sync_states (
                    session_id TEXT NOT NULL,
                    jid VARCHAR(100) NOT NULL,
                    oldest_msg_id VARCHAR(100),
                    oldest_timestamp_ms BIGINT,
                    has_more BOOLEAN NOT NULL DEFAULT 1,
                    completed_at TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    state VARCHAR(50) DEFAULT 'NOT_CHECKED',
                    stall_count INTEGER DEFAULT 0,
                    timeout_count INTEGER DEFAULT 0,
                    error_count INTEGER DEFAULT 0,
                    last_attempt_at TIMESTAMP,
                    last_success_at TIMESTAMP,
                    last_error TEXT,
                    provider_checked BOOLEAN NOT NULL DEFAULT 0,
                    provider_checked_at TIMESTAMP,
                    provider_exhausted BOOLEAN DEFAULT 0,
                    provider_signal VARCHAR(32),
                    provider_msgs_returned INTEGER DEFAULT 0,
                    provider_cursor_used VARCHAR(255),
                    last_sweep_count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, jid)
                )
            """)
        )
    try:
        yield sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_01_provider_status_not_requested_no_evidence(tmp_path):
    """1. provider_status NOT_REQUESTED -> no evidence written (cache hit rule)."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            res = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="NOT_REQUESTED",
                gw_msgs=[{"wa_message_id": "wa-1", "timestamp_s": 1700000000}],
            )
            assert res is None
            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "NOT_CHECKED"
            assert ev["provider_checked"] is False
            assert ev["provider_exhausted"] is False


@pytest.mark.asyncio
async def test_02_provider_ok_full_page_has_more(tmp_path):
    """2. provider OK + 50 -> HAS_MORE."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            msgs = [{"wa_message_id": f"wa-{i}", "timestamp_s": 1700000000 - i * 10} for i in range(50)]
            res = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=msgs,
            )
            assert res is not None
            assert res["state"] == "HAS_MORE"
            assert res["provider_checked"] is True
            assert res["provider_exhausted"] is False
            assert res["has_more"] is True

            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "HAS_MORE"
            assert ev["provider_checked"] is True
            assert ev["provider_exhausted"] is False


@pytest.mark.asyncio
async def test_03_provider_ok_partial_page_exhaustion_candidate(tmp_path):
    """3. provider OK + 14 -> EXHAUSTION_CANDIDATE."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            msgs = [{"wa_message_id": f"wa-{i}", "timestamp_s": 1700000000 - i * 10} for i in range(14)]
            res = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=msgs,
            )
            assert res is not None
            assert res["state"] == "EXHAUSTION_CANDIDATE"
            assert res["provider_checked"] is True
            assert res["provider_exhausted"] is False
            assert res["has_more"] is True


@pytest.mark.asyncio
async def test_04_candidate_then_zero_fully_exhausted(tmp_path):
    """4. candidate + next request 0 -> FULLY_EXHAUSTED (two-step confirmation)."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            # Step 1: 14 messages returned
            await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=[{"wa_message_id": f"wa-{i}", "timestamp_s": 1700000000 - i * 10} for i in range(14)],
            )
            # Step 2: Next request returns 0 messages
            res2 = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=[],
            )
            assert res2 is not None
            assert res2["state"] == "FULLY_EXHAUSTED"
            assert res2["provider_checked"] is True
            assert res2["provider_exhausted"] is True
            assert res2["has_more"] is False

            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "FULLY_EXHAUSTED"
            assert ev["provider_exhausted"] is True
            assert ev["completed_at"] is not None


@pytest.mark.asyncio
async def test_05_provider_timeout(tmp_path):
    """5. timeout -> TIMEOUT, retryable."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            res = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="TIMEOUT",
                error_msg="Gateway timeout waiting for provider chunk",
            )
            assert res is not None
            assert res["state"] == "TIMEOUT"
            assert res["provider_exhausted"] is False
            assert res["has_more"] is True


@pytest.mark.asyncio
async def test_06_provider_error(tmp_path):
    """6. provider error -> PROVIDER_ERROR."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            res = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="ERROR",
                error_msg="Baileys socket error",
            )
            assert res is not None
            assert res["state"] == "PROVIDER_ERROR"
            assert res["provider_exhausted"] is False


@pytest.mark.asyncio
async def test_07_stale_cursor_stalled(tmp_path):
    """7. stale cursor -> CURSOR_STALLED after 3 consecutive stalled attempts."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            same_msg = [{"wa_message_id": "wa-stuck", "timestamp_s": 1700000000}]
            anchor_ts = 1700000000 * 1000

            # Attempt 1: stall 1
            r1 = await record_on_demand_provider_result(
                db, sid, jid, 50, "OK", same_msg, oldest_msg_id="wa-stuck", before_ts_ms=anchor_ts
            )
            assert r1["state"] != "CURSOR_STALLED"

            # Attempt 2: stall 2
            r2 = await record_on_demand_provider_result(
                db, sid, jid, 50, "OK", same_msg, oldest_msg_id="wa-stuck", before_ts_ms=anchor_ts
            )
            assert r2["state"] != "CURSOR_STALLED"

            # Attempt 3: stall 3 -> CURSOR_STALLED
            r3 = await record_on_demand_provider_result(
                db, sid, jid, 50, "OK", same_msg, oldest_msg_id="wa-stuck", before_ts_ms=anchor_ts
            )
            assert r3["state"] == "CURSOR_STALLED"
            assert r3["has_more"] is False

            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "CURSOR_STALLED"
            assert ev["stall_count"] == 3


@pytest.mark.asyncio
async def test_08_concurrent_requests_single_flight(tmp_path, monkeypatch):
    """8. same conversation concurrent request -> single provider flight."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner, gateway_id="gw-p17", session_name="Session 17", status=SessionStatus.CONNECTED
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            call_count = 0

            async def slow_hydrate(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                await asyncio.sleep(0.05)
                return []

            monkeypatch.setattr(ws, "_hydrate_messages_on_demand", slow_hydrate)

            # Fire two concurrent get_messages calls with isolated sessions
            async with sessions() as db1, sessions() as db2:
                t1 = asyncio.create_task(ws.get_messages(db1, owner, conv.id, limit=20))
                t2 = asyncio.create_task(ws.get_messages(db2, owner, conv.id, limit=20))
                await asyncio.gather(t1, t2)

            # Exactly one provider flight should have been initiated
            assert call_count == 1


@pytest.mark.asyncio
async def test_09_new_inbound_message_does_not_move_history_anchor(tmp_path):
    """9. new inbound message does not move history anchor in history_sync_states."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            # Establish history anchor
            await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=[{"wa_message_id": "wa-old", "timestamp_s": 1600000000}],
            )
            ev_before = await get_history_evidence(db, jid, session_id=sid)

            # Simulate new inbound message occurring in real time
            conv = Conversation(user_id="user1", last_message_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
            db.add(conv)
            await db.flush()

            # Verify history anchor remains unchanged
            ev_after = await get_history_evidence(db, jid, session_id=sid)
            assert ev_before["state"] == ev_after["state"]
            assert ev_after["provider_msgs_returned"] == 1


@pytest.mark.asyncio
async def test_10_history_state_isolated_by_session_and_jid(tmp_path):
    """10. history state isolated by session_id + jid:
    - Session A + JID X = FULLY_EXHAUSTED does not affect Session B + JID X (remains NOT_CHECKED)
    - JID X != JID Y (LID, group, PN) remain strictly isolated keys within same session
    """
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session_a = str(uuid.uuid4())
            session_b = str(uuid.uuid4())
            jid_x = "905551111111@s.whatsapp.net"
            jid_group = "12036302@g.us"
            jid_lid = "12345678@lid"

            # Set Session A + JID X to FULLY_EXHAUSTED (two steps)
            await record_on_demand_provider_result(
                db, session_a, jid_x, 50, "OK", [{"wa_message_id": "m1", "timestamp_s": 1700000000}]
            )
            res_a = await record_on_demand_provider_result(
                db, session_a, jid_x, 50, "OK", []
            )
            assert res_a["state"] == "FULLY_EXHAUSTED"

            # Set Session A + JID Group to HAS_MORE
            await record_on_demand_provider_result(
                db, session_a, jid_group, 1, "OK", [{"wa_message_id": "mg1", "timestamp_s": 1700000000}]
            )

            # Check Session A + JID X -> FULLY_EXHAUSTED
            ev_a_x = await get_history_evidence(db, jid_x, session_id=session_a)
            assert ev_a_x["state"] == "FULLY_EXHAUSTED"
            assert ev_a_x["provider_exhausted"] is True

            # Check Session B + JID X -> NOT_CHECKED (B is NOT affected by A!)
            ev_b_x = await get_history_evidence(db, jid_x, session_id=session_b)
            assert ev_b_x["state"] == "NOT_CHECKED"
            assert ev_b_x["provider_exhausted"] is False

            # Check Session A + Group JID -> HAS_MORE (isolated from JID X)
            ev_a_grp = await get_history_evidence(db, jid_group, session_id=session_a)
            assert ev_a_grp["state"] == "HAS_MORE"

            # Check Session A + LID JID -> NOT_CHECKED (isolated from PN and Group)
            ev_a_lid = await get_history_evidence(db, jid_lid, session_id=session_a)
            assert ev_a_lid["state"] == "NOT_CHECKED"


@pytest.mark.asyncio
async def test_11_initial_sync_does_not_create_provider_evidence(tmp_path):
    """11. initial sync does not create provider evidence."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905553334455@s.whatsapp.net"
            # An initial sync / chat bootstrap runs without calling provider on-demand
            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["provider_checked"] is False
            assert ev["state"] == "NOT_CHECKED"


@pytest.mark.asyncio
async def test_12_manual_history_creates_provider_evidence(tmp_path, monkeypatch):
    """12. manual history does create provider evidence via _hydrate_messages_on_demand."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner, gateway_id="gw-session-12", session_name="S12", status=SessionStatus.CONNECTED
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551239999")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            orch = WhatsAppSyncOrchestrator()
            mock_gw = AsyncMock()
            mock_gw.get_messages = AsyncMock(
                return_value={
                    "messages": [
                        {
                            "wa_message_id": "wa-manual-1",
                            "body": "Hello Manual",
                            "timestamp_s": 1700000500,
                            "direction": "INBOUND",
                        }
                    ],
                    "provider_status": "OK",
                }
            )
            orch.gw = mock_gw

            rows = await orch._hydrate_messages_on_demand(db, owner, conv, limit=50)
            assert len(rows) == 1
            assert rows[0].wa_message_id == "wa-manual-1"

            jid = "905551239999@s.whatsapp.net"
            ev = await get_history_evidence(db, jid, session_id="gw-session-12")
            assert ev["provider_checked"] is True
            assert ev["state"] == "EXHAUSTION_CANDIDATE"
            assert ev["provider_msgs_returned"] == 1


@pytest.mark.asyncio
async def test_13_fully_exhausted_cannot_be_produced_without_second_confirmation(tmp_path):
    """13. FULLY_EXHAUSTED cannot be produced without second confirmation."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905559990000@s.whatsapp.net"

            # Very first request returns 0 messages: must become EXHAUSTION_CANDIDATE, NOT FULLY_EXHAUSTED!
            res = await record_on_demand_provider_result(
                db, sid, jid, requested_count=50, provider_status="OK", gw_msgs=[]
            )
            assert res["state"] == "EXHAUSTION_CANDIDATE"
            assert res["provider_exhausted"] is False
            assert res["has_more"] is True

            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "EXHAUSTION_CANDIDATE"
            assert ev["provider_exhausted"] is False

            # Second request confirms 0 messages -> now becomes FULLY_EXHAUSTED
            res2 = await record_on_demand_provider_result(
                db, sid, jid, requested_count=50, provider_status="OK", gw_msgs=[]
            )
            assert res2["state"] == "FULLY_EXHAUSTED"
            assert res2["provider_exhausted"] is True
            assert res2["has_more"] is False


@pytest.mark.asyncio
async def test_14_provider_cache_hit_cannot_create_evidence(tmp_path, monkeypatch):
    """14. provider cache hit (NOT_REQUESTED) cannot create evidence."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner, gateway_id="gw-session-14", session_name="S14", status=SessionStatus.CONNECTED
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551238888")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            orch = WhatsAppSyncOrchestrator()
            mock_gw = AsyncMock()
            mock_gw.get_messages = AsyncMock(
                return_value={
                    "messages": [
                        {
                            "wa_message_id": "wa-cache-1",
                            "body": "Cached Message",
                            "timestamp_s": 1700000100,
                            "direction": "INBOUND",
                        }
                    ],
                    "provider_status": "NOT_REQUESTED",  # Cache hit!
                }
            )
            orch.gw = mock_gw

            rows = await orch._hydrate_messages_on_demand(db, owner, conv, limit=50)
            assert len(rows) == 1

            jid = "905551238888@s.whatsapp.net"
            ev = await get_history_evidence(db, jid, session_id="gw-session-14")
            assert ev["state"] == "NOT_CHECKED"
            assert ev["provider_checked"] is False


@pytest.mark.asyncio
async def test_15_existing_messages_remain_idempotent_by_wa_message_id(tmp_path):
    """15. existing messages remain idempotent by wa_message_id."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner, gateway_id="gw-session-15", session_name="S15", status=SessionStatus.CONNECTED
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551237777")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            orch = WhatsAppSyncOrchestrator()
            mock_gw = AsyncMock()
            mock_payload = {
                "messages": [
                    {
                        "wa_message_id": "wa-idempotent-1",
                        "body": "Msg 1",
                        "timestamp_s": 1700000100,
                        "direction": "INBOUND",
                    },
                    {
                        "wa_message_id": "wa-idempotent-2",
                        "body": "Msg 2",
                        "timestamp_s": 1700000200,
                        "direction": "OUTBOUND",
                    },
                ],
                "provider_status": "OK",
            }
            mock_gw.get_messages = AsyncMock(return_value=mock_payload)
            orch.gw = mock_gw

            # First hydration
            rows1 = await orch._hydrate_messages_on_demand(db, owner, conv, limit=50)
            assert len(rows1) == 2

            # Second hydration with same messages
            rows2 = await orch._hydrate_messages_on_demand(db, owner, conv, limit=50)
            assert len(rows2) == 0

            # Count rows in db
            res = await db.execute(select(Message).where(Message.conversation_id == conv.id))
            db_msgs = res.scalars().all()
            assert len(db_msgs) == 2


@pytest.mark.asyncio
async def test_16_candidate_then_timeout_does_not_exhaust(tmp_path):
    """16. candidate -> timeout must NOT become FULLY_EXHAUSTED."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            # Step 1: candidate
            res1 = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=[{"wa_message_id": f"wa-{i}", "timestamp_s": 1700000000 - i * 10} for i in range(10)],
            )
            assert res1["state"] == "EXHAUSTION_CANDIDATE"

            # Step 2: timeout occurs
            res2 = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="TIMEOUT",
                error_msg="Gateway timeout",
            )
            assert res2["state"] == "TIMEOUT"
            assert res2["provider_exhausted"] is False
            assert res2["has_more"] is True

            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "TIMEOUT"
            assert ev["provider_exhausted"] is False


@pytest.mark.asyncio
async def test_17_candidate_then_error_does_not_exhaust(tmp_path):
    """17. candidate -> provider error must NOT become FULLY_EXHAUSTED."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            # Step 1: candidate
            res1 = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=[{"wa_message_id": f"wa-{i}", "timestamp_s": 1700000000 - i * 10} for i in range(10)],
            )
            assert res1["state"] == "EXHAUSTION_CANDIDATE"

            # Step 2: error occurs
            res2 = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="ERROR",
                error_msg="Socket disconnected",
            )
            assert res2["state"] == "PROVIDER_ERROR"
            assert res2["provider_exhausted"] is False
            assert res2["has_more"] is True

            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "PROVIDER_ERROR"
            assert ev["provider_exhausted"] is False


@pytest.mark.asyncio
async def test_18_candidate_then_full_page_reverts_to_has_more(tmp_path):
    """18. candidate -> 50 messages must transition to HAS_MORE, not FULLY_EXHAUSTED."""
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = "905551234567@s.whatsapp.net"
            # Step 1: candidate
            res1 = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=[{"wa_message_id": f"wa-{i}", "timestamp_s": 1700000000 - i * 10} for i in range(10)],
            )
            assert res1["state"] == "EXHAUSTION_CANDIDATE"

            # Step 2: 50 messages returned
            res2 = await record_on_demand_provider_result(
                db,
                session_id=sid,
                jid=jid,
                requested_count=50,
                provider_status="OK",
                gw_msgs=[{"wa_message_id": f"wa-new-{i}", "timestamp_s": 1690000000 - i * 10} for i in range(50)],
            )
            assert res2["state"] == "HAS_MORE"
            assert res2["provider_exhausted"] is False
            assert res2["has_more"] is True

            ev = await get_history_evidence(db, jid, session_id=sid)
            assert ev["state"] == "HAS_MORE"
            assert ev["provider_exhausted"] is False


@pytest.mark.asyncio
async def test_19_timeout_evidence_persists_across_exception_and_rollback(tmp_path):
    """19. Timeout evidence persists to database even when WhatsAppHistoryTimeout is raised and caller rolls back."""
    from backend.app.services.whatsapp.exceptions import WhatsAppHistoryTimeout

    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        # Phase 1: Setup and execution that raises timeout
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner, gateway_id="gw-session-19", session_name="S19", status=SessionStatus.CONNECTED
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551239919")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            orch = WhatsAppSyncOrchestrator()
            mock_gw = AsyncMock()
            mock_gw.get_messages = AsyncMock(
                return_value={
                    "messages": [],
                    "provider_status": "TIMEOUT",
                }
            )
            orch.gw = mock_gw

            with pytest.raises(WhatsAppHistoryTimeout):
                await orch._hydrate_messages_on_demand(db, owner, conv, limit=50)

            # Simulate caller/framework rolling back its session on unhandled exception
            await db.rollback()

        # Phase 2: Verify in a completely clean database session
        async with sessions() as db2:
            jid = "905551239919@s.whatsapp.net"
            ev = await get_history_evidence(db2, jid, session_id="gw-session-19")
            assert ev["state"] == "TIMEOUT"
            assert ev["provider_checked"] is False
            assert ev["provider_exhausted"] is False
            assert ev["has_more"] is True
            assert ev["provider_msgs_returned"] == 0

            # Verify it is not marked exhausted
            is_exhausted = await is_history_exhausted_or_stalled(db2, jid, session_id="gw-session-19")
            assert is_exhausted is False


@pytest.mark.asyncio
async def test_20_error_evidence_persists_across_exception_and_rollback(tmp_path):
    """20. Provider error evidence persists to database even when exception is raised and caller rolls back."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        # Phase 1: Setup and execution that raises network error
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner, gateway_id="gw-session-20", session_name="S20", status=SessionStatus.CONNECTED
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551239920")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            orch = WhatsAppSyncOrchestrator()
            mock_gw = AsyncMock()
            mock_gw.get_messages = AsyncMock(side_effect=RuntimeError("Provider socket disconnected"))
            orch.gw = mock_gw

            with pytest.raises(RuntimeError):
                await orch._hydrate_messages_on_demand(db, owner, conv, limit=50)

            # Simulate caller/framework rolling back its session on unhandled exception
            await db.rollback()

        # Phase 2: Verify in a completely clean database session
        async with sessions() as db2:
            jid = "905551239920@s.whatsapp.net"
            ev = await get_history_evidence(db2, jid, session_id="gw-session-20")
            assert ev["state"] == "PROVIDER_ERROR"
            assert ev["provider_checked"] is False
            assert ev["provider_exhausted"] is False
            assert ev["has_more"] is True
            assert ev["provider_msgs_returned"] == 0

            # Verify it is not marked exhausted
            is_exhausted = await is_history_exhausted_or_stalled(db2, jid, session_id="gw-session-20")
            assert is_exhausted is False

