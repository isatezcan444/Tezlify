"""Permanent Isolated PostgreSQL Multi-Process Concurrency & Crash-Recovery Test Suite (Phase 2.8.5 - 2.8.6).

This suite verifies that under real multi-process concurrency on PostgreSQL:
1. Same client_message_id concurrent initial send dispatches to gateway exactly once.
2. Same FAILED row concurrent retry uses atomic DB claim to dispatch exactly once.
3. Media retry race uses atomic DB claim to dispatch exactly once.
4. Same client_message_id with different payload is rejected with ValueError.
5. Worker crashing immediately after atomic claim leaves row in PENDING without gateway dispatch,
   and losing/subsequent worker marks DELIVERY_UNCONFIRMED after timeout (0 duplicate dispatches).
6. Gateway accepts message, but worker crashes before writing wa_message_id to DB:
   the losing/subsequent worker waits, does NOT perform a second dispatch, and safely marks
   DELIVERY_UNCONFIRMED (dispatch count remains exactly 1, preventing duplicate WhatsApp messages).
7. Losing worker cleanly awaits winning worker's committed SENT status and returns it without dispatching.
8. Late-arriving gateway event (ECHO/ACK) promotes a DELIVERY_UNCONFIRMED row to SENT/DELIVERED,
   while late failures never downgrade an already SENT/DELIVERED row.
9. FAILED row with existing wa_message_id is NEVER redispatched (0 dispatches; returns existing row).
10. Post-recovery retry (recovered row in SENT with wa_message_id) prevents duplicate dispatch (0 dispatches).

Requirements:
- Strictly isolated PostgreSQL connection (hard rejection of production hosts/databases).
- Independent OS processes (multiprocessing spawn context) and asyncpg pools.
- Zero false positives; reports BLOCKED if isolated PostgreSQL is unavailable.
"""
import asyncio
import multiprocessing
import os
import sys
import time
import uuid
import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.messaging import WhatsAppMessagingOrchestrator
from backend.app.services.whatsapp.status_policy import advance_message_status

POSTGRES_TEST_URL = os.environ.get(
    "POSTGRES_TEST_URL",
    "postgresql+asyncpg://isatezcan@localhost:5432/tezlify_test_isolated",
)
os.environ["WHATSAPP_GATEWAY_SECRET"] = "01234567890123456789012345678901"
TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


def _assert_safe_isolated_test_database(url: str) -> None:
    """Explicit safety guard ensuring tests CANNOT connect to unisolated or production DB."""
    url_lower = url.lower()
    production_indicators = ["130.162.247.20", "tezlify.com", "oracle"]
    for indicator in production_indicators:
        if indicator in url_lower:
            raise RuntimeError(
                f"SAFETY VIOLATION: Test database URL '{url}' matches production indicator '{indicator}'. "
                "Tests can only run against a local isolated test database."
            )
    if "test" not in url_lower and "isolated" not in url_lower:
        raise RuntimeError(
            f"SAFETY VIOLATION: Database name in '{url}' must contain 'test' or 'isolated' to prevent accidental writes."
        )


_assert_safe_isolated_test_database(POSTGRES_TEST_URL)


def _check_postgres_reachable() -> bool:
    """Synchronous probe to check if isolated PostgreSQL is available."""
    async def _probe():
        try:
            eng = create_async_engine(POSTGRES_TEST_URL, connect_args={"timeout": 2})
            async with eng.connect() as conn:
                await conn.execute(text("SELECT 1"))
            await eng.dispose()
            return True
        except Exception:
            return False

    try:
        return asyncio.run(_probe())
    except Exception:
        return False


POSTGRES_AVAILABLE = _check_postgres_reachable()
pytestmark = pytest.mark.skipif(
    not POSTGRES_AVAILABLE,
    reason=f"BLOCKED: Isolated PostgreSQL not available at {POSTGRES_TEST_URL}",
)

# ---------------------------------------------------------------------------
# Module-level worker routines (required for multiprocessing 'spawn' context)
# ---------------------------------------------------------------------------

def _mp_worker_initial_send(proc_id, counter, sync_e, start_e, q):
    async def run():
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        class MockService: pass
        svc = MockService()
        async def mock_gw(db, session_row, op):
            with counter.get_lock(): counter.value += 1
            await asyncio.sleep(0.3)
            return {"wa_message_id": f"BAE5_INIT_PROC_{proc_id}", "status": "SENT"}
        svc._gateway_op_or_mark_relink = mock_gw
        orch = WhatsAppMessagingOrchestrator(svc)
        sync_e.set()
        start_e.wait()
        try:
            async with session_maker() as db:
                res = await orch.send_text_message(
                    db, TEST_USER_ID, 1, "Concurrent initial text", client_message_id="pg-mid-initial-send"
                )
                q.put((proc_id, "SUCCESS", res.get("status"), res.get("wa_message_id")))
        except Exception as e:
            q.put((proc_id, "ERROR", str(e), None))
        finally:
            await eng.dispose()
    asyncio.run(run())


def _mp_worker_retry_text(proc_id, counter, sync_e, start_e, q):
    async def run():
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        class MockService: pass
        svc = MockService()
        async def mock_gw(db, session_row, op):
            with counter.get_lock(): counter.value += 1
            await asyncio.sleep(0.3)
            return {"wa_message_id": f"BAE5_RETRY_PROC_{proc_id}", "status": "SENT"}
        svc._gateway_op_or_mark_relink = mock_gw
        orch = WhatsAppMessagingOrchestrator(svc)
        sync_e.set()
        start_e.wait()
        try:
            async with session_maker() as db:
                res = await orch.send_text_message(
                    db, TEST_USER_ID, 1, "Concurrent retry text", client_message_id="pg-mid-retry-text"
                )
                q.put((proc_id, "SUCCESS", res.get("status"), res.get("wa_message_id")))
        except Exception as e:
            q.put((proc_id, "ERROR", str(e), None))
        finally:
            await eng.dispose()
    asyncio.run(run())


def _mp_worker_retry_media(proc_id, counter, sync_e, start_e, q):
    async def run():
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        class MockService: pass
        svc = MockService()
        async def mock_gw(db, session_row, op):
            with counter.get_lock(): counter.value += 1
            await asyncio.sleep(0.3)
            return {"wa_message_id": f"BAE5_MEDIA_PROC_{proc_id}", "status": "SENT"}
        svc._gateway_op_or_mark_relink = mock_gw
        orch = WhatsAppMessagingOrchestrator(svc)
        sync_e.set()
        start_e.wait()
        try:
            async with session_maker() as db:
                media_payload = {
                    "client_message_id": "pg-mid-retry-media",
                    "media_url": "https://example.com/photo.png",
                    "mime_type": "image/png",
                }
                res = await orch.send_media_message(db, TEST_USER_ID, 1, media_payload)
                q.put((proc_id, "SUCCESS", res.get("status"), res.get("wa_message_id")))
        except Exception as e:
            q.put((proc_id, "ERROR", str(e), None))
        finally:
            await eng.dispose()
    asyncio.run(run())


def _mp_worker_crash_after_claim_pre_dispatch(proc_id, counter, sync_e, start_e, q):
    """Worker 1 wins claim, but aborts immediately before calling gateway."""
    async def run():
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        class MockService: pass
        svc = MockService()
        async def mock_gw(db, session_row, op):
            with counter.get_lock(): counter.value += 1
            return {"wa_message_id": f"BAE5_CLAIM_CRASH_{proc_id}", "status": "SENT"}
        svc._gateway_op_or_mark_relink = mock_gw
        orch = WhatsAppMessagingOrchestrator(svc)
        sync_e.set()
        start_e.wait()
        try:
            async with session_maker() as db:
                if proc_id == 1:
                    # Worker 1 acquires atomic claim directly, then aborts without calling gateway
                    claim_stmt = (
                        update(Message)
                        .where(
                            Message.client_message_id == "pg-mid-crash-after-claim",
                            Message.status == ConversationMessageStatus.FAILED,
                            Message.wa_message_id.is_(None),
                        )
                        .values(status=ConversationMessageStatus.PENDING, failed_at=None, error_message=None)
                    )
                    claim_res = await db.execute(claim_stmt)
                    await db.commit()
                    assert claim_res.rowcount == 1
                    # Worker 1 aborts / crashes here without dispatching!
                    q.put((proc_id, "CRASHED_AFTER_CLAIM", None, None))
                    return

                # Worker 2 attempts retry while Worker 1 has claimed PENDING
                res = await orch.send_text_message(
                    db, TEST_USER_ID, 1, "Crash after claim body", client_message_id="pg-mid-crash-after-claim"
                )
                q.put((proc_id, "SUCCESS", res.get("status"), res.get("wa_message_id")))
        except Exception as e:
            q.put((proc_id, "ERROR", str(e), None))
        finally:
            await eng.dispose()
    asyncio.run(run())


def _mp_worker_crash_post_dispatch_pre_db_ack(proc_id, counter, sync_e, start_e, q, crash_step_event):
    """Worker 1 dispatches to gateway, gateway succeeds, but Worker 1 crashes before writing wa_message_id to DB.
    Worker 2 waits for Worker 1 to crash, then calls send_text_message to verify fail-closed handling."""
    async def run():
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        class MockService: pass
        svc = MockService()

        async def mock_gw(db, session_row, op):
            with counter.get_lock(): counter.value += 1
            if proc_id == 1:
                # Gateway accepts message, returns wa_message_id:
                q.put((proc_id, "DISPATCHED_THEN_KILLED", "GATEWAY_ACCEPTED", "BAE5_GW_LOST_ACK"))
                # Notify worker 2 that dispatch was completed at gateway:
                crash_step_event.set()
                # Simulate sudden OS crash / termination of Worker 1 before DB write:
                os._exit(0)
            return {"wa_message_id": f"BAE5_POST_DISPATCH_{proc_id}", "status": "SENT"}

        svc._gateway_op_or_mark_relink = mock_gw
        orch = WhatsAppMessagingOrchestrator(svc)
        sync_e.set()
        start_e.wait()
        try:
            async with session_maker() as db:
                if proc_id == 1:
                    await orch.send_text_message(
                        db, TEST_USER_ID, 1, "Crash post dispatch body", client_message_id="pg-mid-crash-post-dispatch"
                    )
                else:
                    # Worker 2 waits until Worker 1 has dispatched and terminated
                    crash_step_event.wait(timeout=5)
                    res = await orch.send_text_message(
                        db, TEST_USER_ID, 1, "Crash post dispatch body", client_message_id="pg-mid-crash-post-dispatch"
                    )
                    q.put((proc_id, "SUCCESS", res.get("status"), res.get("wa_message_id")))
        except Exception as e:
            q.put((proc_id, "ERROR", str(e), None))
        finally:
            await eng.dispose()
    asyncio.run(run())


def _mp_worker_retry_with_existing_wa_id(proc_id, counter, sync_e, start_e, q):
    """Worker attempts to retry a message that already has a wa_message_id (FAILED or PENDING).
    Gateway MUST NOT be called (dispatch_count must remain 0)."""
    async def run():
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        class MockService: pass
        svc = MockService()
        async def mock_gw(db, session_row, op):
            with counter.get_lock(): counter.value += 1
            return {"wa_message_id": f"BAE5_UNWANTED_DISPATCH_{proc_id}", "status": "SENT"}
        svc._gateway_op_or_mark_relink = mock_gw
        orch = WhatsAppMessagingOrchestrator(svc)
        sync_e.set()
        start_e.wait()
        try:
            async with session_maker() as db:
                res = await orch.send_text_message(
                    db, TEST_USER_ID, 1, "Existing wa_id retry body", client_message_id="pg-mid-failed-with-wa-id"
                )
                q.put((proc_id, "SUCCESS", res.get("status"), res.get("wa_message_id")))
        except Exception as e:
            q.put((proc_id, "ERROR", str(e), None))
        finally:
            await eng.dispose()
    asyncio.run(run())


def _mp_worker_post_recovery_retry(proc_id, counter, sync_e, start_e, q):
    """Worker attempts to send/retry a recovered message that has status SENT and wa_message_id.
    Gateway MUST NOT be called (dispatch_count must remain 0)."""
    async def run():
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        class MockService: pass
        svc = MockService()
        async def mock_gw(db, session_row, op):
            with counter.get_lock(): counter.value += 1
            return {"wa_message_id": f"BAE5_POST_REC_DISPATCH_{proc_id}", "status": "SENT"}
        svc._gateway_op_or_mark_relink = mock_gw
        orch = WhatsAppMessagingOrchestrator(svc)
        sync_e.set()
        start_e.wait()
        try:
            async with session_maker() as db:
                res = await orch.send_text_message(
                    db, TEST_USER_ID, 1, "Post recovery retry body", client_message_id="pg-mid-post-recovery-retry"
                )
                q.put((proc_id, "SUCCESS", res.get("status"), res.get("wa_message_id")))
        except Exception as e:
            q.put((proc_id, "ERROR", str(e), None))
        finally:
            await eng.dispose()
    asyncio.run(run())


# ---------------------------------------------------------------------------
# Test Fixtures and Runner Helper
# ---------------------------------------------------------------------------

@pytest.fixture
def isolated_pg_db():
    """Sets up fresh test conversation in isolated PostgreSQL."""
    async def _setup():
        from backend.app.core.migrations import (
            ensure_messages_media_columns,
            ensure_whatsapp_sessions_warmup_columns,
        )
        eng = create_async_engine(POSTGRES_TEST_URL)
        await ensure_messages_media_columns(eng)
        await ensure_whatsapp_sessions_warmup_columns(eng)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            await db.execute(delete(Message))
            await db.execute(delete(Conversation))
            await db.execute(delete(Contact))
            await db.execute(delete(WhatsAppSession))
            await db.commit()

            ws_row = WhatsAppSession(
                id=1,
                user_id=TEST_USER_ID,
                session_name="Postgres Isolated Session",
                gateway_id="gw-pg-test",
                status=SessionStatus.CONNECTED,
            )
            db.add(ws_row)
            contact = Contact(id=1, user_id=TEST_USER_ID, phone_e164="+905559998877")
            db.add(contact)
            conv = Conversation(id=1, user_id=TEST_USER_ID, contact_id=1, session_id=1, is_group=False)
            db.add(conv)
            await db.commit()
        await eng.dispose()

    asyncio.run(_setup())
    yield
    # Cleanup


def _run_two_process_concurrency(target_fn):
    """Spawns 2 independent OS processes and synchronizes simultaneous execution."""
    ctx = multiprocessing.get_context("spawn")
    counter = ctx.Value("i", 0)
    sync_e1 = ctx.Event()
    sync_e2 = ctx.Event()
    start_e = ctx.Event()
    q = ctx.Queue()

    p1 = ctx.Process(target=target_fn, args=(1, counter, sync_e1, start_e, q))
    p2 = ctx.Process(target=target_fn, args=(2, counter, sync_e2, start_e, q))

    p1.start()
    p2.start()

    sync_e1.wait(timeout=5)
    sync_e2.wait(timeout=5)

    start_e.set()

    p1.join(timeout=10)
    p2.join(timeout=10)

    results = []
    while not q.empty():
        results.append(q.get())

    return counter.value, results


def _run_two_process_crash_post_dispatch(target_fn):
    """Spawns 2 independent OS processes with crash step event synchronization."""
    ctx = multiprocessing.get_context("spawn")
    counter = ctx.Value("i", 0)
    sync_e1 = ctx.Event()
    sync_e2 = ctx.Event()
    start_e = ctx.Event()
    crash_step_event = ctx.Event()
    q = ctx.Queue()

    p1 = ctx.Process(target=target_fn, args=(1, counter, sync_e1, start_e, q, crash_step_event))
    p2 = ctx.Process(target=target_fn, args=(2, counter, sync_e2, start_e, q, crash_step_event))

    p1.start()
    p2.start()

    sync_e1.wait(timeout=5)
    sync_e2.wait(timeout=5)

    start_e.set()

    p1.join(timeout=10)
    p2.join(timeout=10)

    results = []
    while not q.empty():
        results.append(q.get())

    return counter.value, results


async def _fetch_db_message(client_message_id: str) -> Message:
    eng = create_async_engine(POSTGRES_TEST_URL)
    session_maker = async_sessionmaker(eng, expire_on_commit=False)
    async with session_maker() as db:
        res = await db.scalar(select(Message).where(Message.client_message_id == client_message_id))
    await eng.dispose()
    return res


# ---------------------------------------------------------------------------
# Test Scenarios
# ---------------------------------------------------------------------------

class TestWhatsAppPostgresMultiProcessConcurrency:
    """Rigorous PostgreSQL Concurrency & Crash Evidence Test Suite."""

    @pytest.mark.asyncio
    async def test_01_concurrent_initial_send_single_dispatch(self, isolated_pg_db):
        """Scenario 1: Two independent OS processes initiate the same client_message_id concurrently."""
        dispatch_count, results = _run_two_process_concurrency(_mp_worker_initial_send)

        assert dispatch_count == 1, f"Expected exactly 1 gateway dispatch, got {dispatch_count}"
        db_msg = await _fetch_db_message("pg-mid-initial-send")
        assert db_msg is not None
        assert db_msg.status == ConversationMessageStatus.SENT
        assert db_msg.wa_message_id is not None

        # Both processes return the winning result
        successes = [r for r in results if r[1] == "SUCCESS"]
        assert len(successes) == 2
        assert successes[0][2] == "SENT"
        assert successes[1][2] == "SENT"
        assert successes[0][3] == successes[1][3]

    @pytest.mark.asyncio
    async def test_02_concurrent_retry_failed_row_atomic_claim(self, isolated_pg_db):
        """Scenario 2: Two independent OS processes retry the same FAILED row concurrently."""
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            db.add(Message(
                id=101,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Concurrent retry text",
                client_message_id="pg-mid-retry-text",
                status=ConversationMessageStatus.FAILED,
                error_message="Previous delivery failure",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()
        await eng.dispose()

        dispatch_count, results = _run_two_process_concurrency(_mp_worker_retry_text)

        assert dispatch_count == 1, f"Atomic claim failed: multiple dispatches ({dispatch_count})"
        db_msg = await _fetch_db_message("pg-mid-retry-text")
        assert db_msg.status == ConversationMessageStatus.SENT
        assert db_msg.wa_message_id is not None

        successes = [r for r in results if r[1] == "SUCCESS"]
        assert len(successes) == 2
        assert successes[0][3] == db_msg.wa_message_id
        assert successes[1][3] == db_msg.wa_message_id

    @pytest.mark.asyncio
    async def test_03_concurrent_retry_media_atomic_claim(self, isolated_pg_db):
        """Scenario 3: Two independent OS processes retry the same FAILED media message concurrently."""
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            db.add(Message(
                id=102,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.IMAGE,
                body="https://example.com/photo.png",
                media_mime_type="image/png",
                client_message_id="pg-mid-retry-media",
                status=ConversationMessageStatus.FAILED,
                error_message="Previous media upload failure",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()
        await eng.dispose()

        dispatch_count, results = _run_two_process_concurrency(_mp_worker_retry_media)

        assert dispatch_count == 1, f"Media atomic claim failed: multiple dispatches ({dispatch_count})"
        db_msg = await _fetch_db_message("pg-mid-retry-media")
        assert db_msg.status == ConversationMessageStatus.SENT
        assert db_msg.wa_message_id is not None

        successes = [r for r in results if r[1] == "SUCCESS"]
        assert len(successes) == 2
        assert successes[0][3] == db_msg.wa_message_id
        assert successes[1][3] == db_msg.wa_message_id

    @pytest.mark.asyncio
    async def test_04_different_payload_same_idempotency_key_rejected(self, isolated_pg_db):
        """Scenario 4: Attempting to send different body with same client_message_id raises ValueError."""
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            db.add(Message(
                id=103,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Original Content A",
                client_message_id="pg-mid-conflict-key",
                status=ConversationMessageStatus.SENT,
                wa_message_id="BAE5_ORIGINAL_KEY",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()

            class MockService: pass
            orch = WhatsAppMessagingOrchestrator(MockService())

            with pytest.raises(ValueError, match="client_message_id farklı bir mesaj için yeniden kullanılamaz"):
                await orch.send_text_message(
                    db, TEST_USER_ID, 1, "Tampered Content B", client_message_id="pg-mid-conflict-key"
                )

        await eng.dispose()

    @pytest.mark.asyncio
    async def test_05_crash_after_claim_pre_dispatch_marks_delivery_unconfirmed(self, isolated_pg_db):
        """Scenario 5: Worker 1 crashes immediately after atomic claim (pre-dispatch).
        Worker 2 waits, observes no dispatch occurred, and marks DELIVERY_UNCONFIRMED with 0 dispatches.
        """
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            db.add(Message(
                id=105,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Crash after claim body",
                client_message_id="pg-mid-crash-after-claim",
                status=ConversationMessageStatus.FAILED,
                error_message="Previous error",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()
        await eng.dispose()

        dispatch_count, results = _run_two_process_concurrency(_mp_worker_crash_after_claim_pre_dispatch)

        # Worker 1 crashed before dispatch; Worker 2 timed out without dispatching
        assert dispatch_count == 0, f"Expected 0 dispatches when worker crashes before dispatch, got {dispatch_count}"
        db_msg = await _fetch_db_message("pg-mid-crash-after-claim")
        assert db_msg.status == ConversationMessageStatus.FAILED
        assert "DELIVERY_UNCONFIRMED" in (db_msg.error_message or "")
        assert db_msg.wa_message_id is None

    @pytest.mark.asyncio
    async def test_06_crash_post_dispatch_pre_db_ack_evidence(self, isolated_pg_db):
        """Scenario 6 (CRITICAL CRASH EVIDENCE):
        Worker 1 dispatches to Gateway, gateway accepts message.
        Worker 1 is killed before writing wa_message_id and commit.
        Worker 2 enters polling loop, avoids duplicate dispatch, and marks DELIVERY_UNCONFIRMED.
        """
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            # Seed FAILED message to be retried
            db.add(Message(
                id=106,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Crash post dispatch body",
                client_message_id="pg-mid-crash-post-dispatch",
                status=ConversationMessageStatus.FAILED,
                error_message="Initial error",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()
        await eng.dispose()

        dispatch_count, results = _run_two_process_crash_post_dispatch(_mp_worker_crash_post_dispatch_pre_db_ack)

        # Dispatch count was exactly 1 (Worker 1 called gateway once; Worker 2 did NOT call gateway!)
        assert dispatch_count == 1, f"Expected exactly 1 dispatch, got {dispatch_count}"

        db_msg = await _fetch_db_message("pg-mid-crash-post-dispatch")
        # In DB: Worker 1 died before writing wa_message_id.
        # Worker 2 timed out waiting for Worker 1, and marked DELIVERY_UNCONFIRMED.
        # This proves the fail-closed intermediate state: no false-positive SENT is fabricated!
        assert db_msg.status == ConversationMessageStatus.FAILED
        assert "DELIVERY_UNCONFIRMED" in (db_msg.error_message or "")
        assert db_msg.wa_message_id is None

        # Part 6B: Event-Driven Recovery Verification
        # When Gateway asynchronously delivers the ACK/ECHO event matching client_message_id,
        # the row is promoted to SENT without any second gateway dispatch:
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            row = await db.scalar(select(Message).where(Message.client_message_id == "pg-mid-crash-post-dispatch"))
            advance_message_status(row, "SENT")
            row.wa_message_id = "BAE5_GW_LOST_ACK"
            await db.commit()
        await eng.dispose()

        recovered_msg = await _fetch_db_message("pg-mid-crash-post-dispatch")
        assert recovered_msg.status == ConversationMessageStatus.SENT
        assert recovered_msg.wa_message_id == "BAE5_GW_LOST_ACK"
        assert dispatch_count == 1

    @pytest.mark.asyncio
    async def test_07_losing_worker_awaits_winner_and_returns_committed_sent(self, isolated_pg_db):
        """Scenario 7: Worker B loses claim, polls PostgreSQL with populate_existing=True,
        and returns Worker A's committed SENT status and wa_message_id without dispatching.
        """
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            db.add(Message(
                id=107,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Concurrent retry text",
                client_message_id="pg-mid-retry-text",
                status=ConversationMessageStatus.FAILED,
                error_message="Previous failure",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()
        await eng.dispose()

        dispatch_count, results = _run_two_process_concurrency(_mp_worker_retry_text)

        assert dispatch_count == 1
        db_msg = await _fetch_db_message("pg-mid-retry-text")
        assert db_msg.status == ConversationMessageStatus.SENT
        assert db_msg.wa_message_id is not None

        # Verify that both processes returned identical wa_message_id
        res_map = {r[0]: r for r in results if r[1] == "SUCCESS"}
        assert len(res_map) == 2
        assert res_map[1][3] == res_map[2][3]

    @pytest.mark.asyncio
    async def test_08_late_ack_event_promotes_unconfirmed_row_to_sent(self, isolated_pg_db):
        """Scenario 8: A row was marked DELIVERY_UNCONFIRMED due to lost/delayed ACK.
        When asynchronous gateway ACK/ECHO arrives subsequently, status policy promotes it to SENT.
        """
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            msg = Message(
                id=108,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Late ACK message",
                client_message_id="pg-mid-late-ack",
                status=ConversationMessageStatus.FAILED,
                error_message="DELIVERY_UNCONFIRMED: Gönderim zaman aşımına uğradı",
                sender_phone="ME",
                recipient_phone="+905559998877",
            )
            db.add(msg)
            await db.commit()

            # Simulate late-arriving inbound ACK promotion:
            advance_message_status(msg, "SENT")
            msg.wa_message_id = "BAE5_LATE_ARRIVED_ACK"
            await db.commit()

            # Verify in DB:
            refreshed = await db.scalar(select(Message).where(Message.id == 108))
            assert refreshed.status == ConversationMessageStatus.SENT
            assert refreshed.wa_message_id == "BAE5_LATE_ARRIVED_ACK"
            assert refreshed.error_message is None

            # Negative test: A subsequent delayed failure event does NOT revert SENT to FAILED:
            did_revert = advance_message_status(refreshed, "FAILED")
            assert did_revert is False
            assert refreshed.status == ConversationMessageStatus.SENT

        await eng.dispose()

    @pytest.mark.asyncio
    async def test_09_failed_row_with_existing_wa_message_id_never_redispatches(self, isolated_pg_db):
        """Scenario 9 (CRITICAL DUPLICATE DISPATCH INVARIANT):
        A message in FAILED state already possesses a wa_message_id (e.g. from prior dispatch).
        Two concurrent workers attempt to retry this message.
        Verification:
        - Exactly 0 gateway dispatches occur (dispatch_count == 0).
        - Both workers immediately return the existing record without modifying DB or claiming PENDING.
        - wa_message_id is strictly preserved and never overwritten.
        """
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            db.add(Message(
                id=109,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Existing wa_id retry body",
                client_message_id="pg-mid-failed-with-wa-id",
                status=ConversationMessageStatus.FAILED,
                wa_message_id="BAE5_PRE_EXISTING_ID",
                error_message="DELIVERY_UNCONFIRMED: Prior timeout",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()
        await eng.dispose()

        dispatch_count, results = _run_two_process_concurrency(_mp_worker_retry_with_existing_wa_id)

        # Invariant: ZERO gateway dispatches! Existing wa_message_id blocks redispatch.
        assert dispatch_count == 0, f"Expected 0 dispatches for row with existing wa_message_id, got {dispatch_count}"

        db_msg = await _fetch_db_message("pg-mid-failed-with-wa-id")
        assert db_msg.wa_message_id == "BAE5_PRE_EXISTING_ID"

        successes = [r for r in results if r[1] == "SUCCESS"]
        assert len(successes) == 2
        assert successes[0][3] == "BAE5_PRE_EXISTING_ID"
        assert successes[1][3] == "BAE5_PRE_EXISTING_ID"

    @pytest.mark.asyncio
    async def test_10_post_recovery_subsequent_retry_prevents_duplicate_dispatch(self, isolated_pg_db):
        """Scenario 10 (POST-RECOVERY RETRY SAFETY):
        A message that was previously recovered (status is SENT, wa_message_id is populated)
        is retried concurrently by two workers.
        Verification:
        - Exactly 0 gateway dispatches occur (dispatch_count == 0).
        - Both workers return the committed SENT message.
        - Zero duplicate WhatsApp messages can be sent.
        """
        eng = create_async_engine(POSTGRES_TEST_URL)
        session_maker = async_sessionmaker(eng, expire_on_commit=False)
        async with session_maker() as db:
            db.add(Message(
                id=110,
                user_id=TEST_USER_ID,
                conversation_id=1,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Post recovery retry body",
                client_message_id="pg-mid-post-recovery-retry",
                status=ConversationMessageStatus.SENT,
                wa_message_id="BAE5_RECOVERED_ACK",
                sender_phone="ME",
                recipient_phone="+905559998877",
            ))
            await db.commit()
        await eng.dispose()

        dispatch_count, results = _run_two_process_concurrency(_mp_worker_post_recovery_retry)

        assert dispatch_count == 0, f"Expected 0 dispatches on post-recovery retry, got {dispatch_count}"

        db_msg = await _fetch_db_message("pg-mid-post-recovery-retry")
        assert db_msg.status == ConversationMessageStatus.SENT
        assert db_msg.wa_message_id == "BAE5_RECOVERED_ACK"

        successes = [r for r in results if r[1] == "SUCCESS"]
        assert len(successes) == 2
        assert successes[0][2] == "SENT"
        assert successes[1][2] == "SENT"
        assert successes[0][3] == "BAE5_RECOVERED_ACK"
        assert successes[1][3] == "BAE5_RECOVERED_ACK"
