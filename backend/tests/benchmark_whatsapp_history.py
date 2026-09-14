"""Comprehensive WhatsApp Performance and History Benchmarking Suite.
Measures:
1. 500 conversations / 5500 messages sync & chat open (5 iterations: min, median, max)
2. 1000 message conversation open & keyset pagination (5 iterations: min, median, max)
3. 5000 message conversation open & keyset pagination (5 iterations: min, median, max)
4. 10 sequential history pages retrieval (5 iterations: min, median, max)
5. Concurrent history requests deduplication & latency (5 iterations: min, median, max)
"""
import asyncio
import json
import statistics
import time
import uuid
import tempfile
import shutil
from datetime import datetime, timedelta
from unittest.mock import AsyncMock

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.conversation import Conversation
from backend.app.models.contact import Contact
from backend.app.models.message import Message, MessageDirection, ConversationMessageStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp_profiling import Profile, active_profile, install


async def run_500_conv_5500_msg_benchmark(runs=5):
    results = []
    first_chunk_results = []
    chat_open_results = []

    for r in range(runs):
        tmp = tempfile.mkdtemp()
        try:
            engine = create_async_engine(f"sqlite+aiosqlite:///{tmp}/bench500.db")
            install(engine.sync_engine)
            sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

            owner = str(uuid.uuid4())
            async with sessions() as db:
                conversations = [Conversation(user_id=owner) for _ in range(500)]
                db.add_all(conversations)
                await db.commit()
                mapping = {c.id: f"{100000 + i}@s.whatsapp.net" for i, c in enumerate(conversations)}

            jids = list(mapping.values())
            messages = [{
                "conversation_id": jids[i % 500],
                "wa_message_id": f"b500-{r}-{i}",
                "direction": "INBOUND",
                "message_type": "TEXT",
                "body": "fixture",
                "sender_phone": "fixture",
                "recipient_phone": "ME",
                "created_at": f"2025-01-01T00:{i // 60 % 60:02d}:{i % 60:02d}Z",
            } for i in range(5500)]

            async def bulk(gateway_id, limit=1000, offset=0, **kwargs):
                return {"messages": messages[offset:offset + limit], "total": len(messages)}

            ws.gw.list_all_messages = bulk
            emitted = []
            started = time.perf_counter()

            async def broadcast(payload, owner_id):
                emitted.append((time.perf_counter() - started, payload))

            ws._broadcast_sync_event = broadcast
            job = ws.SyncJob(str(uuid.uuid4()), owner)

            profile = Profile("benchmark_500_5500")
            token = active_profile.set(profile)
            try:
                async with sessions() as db:
                    await ws._run_bulk_message_sync(db, job, mapping, "fixture")
                measured = profile.snapshot()
            finally:
                active_profile.reset(token)

            chunks = [p for p in emitted if p[1]["event"] == "whatsapp_sync_messages_chunk"]
            fc_ms = chunks[0][0] * 1000.0 if chunks else 0.0

            async with sessions() as db:
                first_conv = await db.get(Conversation, next(iter(mapping)))
                ws._get_conversation_or_404 = AsyncMock(return_value=first_conv)
                ws._hydrate_messages_on_demand = AsyncMock(return_value=[])
                t_open_start = time.perf_counter()
                page = await ws.get_messages(db, owner, first_conv.id, limit=50)
                open_ms = (time.perf_counter() - t_open_start) * 1000.0

            results.append(measured["duration_ms"])
            first_chunk_results.append(fc_ms)
            chat_open_results.append(open_ms)
        finally:
            await engine.dispose()
            shutil.rmtree(tmp, ignore_errors=True)

    return {
        "benchmark": "500 conversations / 5500 messages sync",
        "iterations": runs,
        "sync_duration_ms": {
            "min": round(min(results), 2),
            "median": round(statistics.median(results), 2),
            "max": round(max(results), 2),
        },
        "first_chunk_ms": {
            "min": round(min(first_chunk_results), 2),
            "median": round(statistics.median(first_chunk_results), 2),
            "max": round(max(first_chunk_results), 2),
        },
        "chat_open_ms": {
            "min": round(min(chat_open_results), 2),
            "median": round(statistics.median(chat_open_results), 2),
            "max": round(max(chat_open_results), 2),
        },
    }


async def run_single_conversation_benchmark(msg_count, runs=5):
    open_times = []
    scroll_times = []

    for r in range(runs):
        tmp = tempfile.mkdtemp()
        try:
            engine = create_async_engine(f"sqlite+aiosqlite:///{tmp}/conv_{msg_count}.db")
            sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

            owner = str(uuid.uuid4())
            async with sessions() as db:
                conv = Conversation(user_id=owner)
                db.add(conv)
                await db.flush()

                t0 = datetime(2026, 1, 1, 0, 0, 0)
                # Bulk add messages
                msgs = [
                    Message(
                        user_id=owner,
                        conversation_id=conv.id,
                        direction=MessageDirection.INBOUND,
                        status=ConversationMessageStatus.RECEIVED,
                        sender_phone="fixture",
                        recipient_phone="ME",
                        external_timestamp=t0 + timedelta(seconds=i),
                        body=f"msg-{i}",
                        wa_message_id=f"bench-{msg_count}-{r}-{i}",
                    )
                    for i in range(msg_count)
                ]
                db.add_all(msgs)
                await db.commit()
                cid = conv.id

            async with sessions() as db:
                ws._get_conversation_or_404 = AsyncMock(return_value=conv)
                ws._hydrate_messages_on_demand = AsyncMock(return_value=[])

                # 1. Chat Open (latest 50 messages)
                t_start = time.perf_counter()
                p1 = await ws.get_messages(db, owner, cid, limit=50)
                open_ms = (time.perf_counter() - t_start) * 1000.0
                open_times.append(open_ms)

                # 2. Keyset scroll to older page
                t_scroll = time.perf_counter()
                p2 = await ws.get_messages(db, owner, cid, limit=50, before=p1["oldest_message_id"])
                scroll_ms = (time.perf_counter() - t_scroll) * 1000.0
                scroll_times.append(scroll_ms)
        finally:
            await engine.dispose()
            shutil.rmtree(tmp, ignore_errors=True)

    return {
        "benchmark": f"{msg_count} message conversation",
        "iterations": runs,
        "chat_open_ms": {
            "min": round(min(open_times), 2),
            "median": round(statistics.median(open_times), 2),
            "max": round(max(open_times), 2),
        },
        "older_page_scroll_ms": {
            "min": round(min(scroll_times), 2),
            "median": round(statistics.median(scroll_times), 2),
            "max": round(max(scroll_times), 2),
        },
    }


async def run_10_sequential_pages_benchmark(runs=5):
    total_times = []
    per_page_times = []

    for r in range(runs):
        tmp = tempfile.mkdtemp()
        try:
            engine = create_async_engine(f"sqlite+aiosqlite:///{tmp}/seq10.db")
            sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

            owner = str(uuid.uuid4())
            async with sessions() as db:
                conv = Conversation(user_id=owner)
                db.add(conv)
                await db.flush()

                t0 = datetime(2026, 1, 1, 0, 0, 0)
                msgs = [
                    Message(
                        user_id=owner,
                        conversation_id=conv.id,
                        direction=MessageDirection.INBOUND,
                        status=ConversationMessageStatus.RECEIVED,
                        sender_phone="fixture",
                        recipient_phone="ME",
                        external_timestamp=t0 + timedelta(seconds=i),
                        body=f"seq-{i}",
                        wa_message_id=f"seq-{r}-{i}",
                    )
                    for i in range(1000)
                ]
                db.add_all(msgs)
                await db.commit()
                cid = conv.id

            async with sessions() as db:
                ws._get_conversation_or_404 = AsyncMock(return_value=conv)
                ws._hydrate_messages_on_demand = AsyncMock(return_value=[])

                cursor = None
                t_total_start = time.perf_counter()
                single_page_durations = []
                for p_idx in range(10):
                    t0_p = time.perf_counter()
                    page = await ws.get_messages(db, owner, cid, limit=50, before=cursor)
                    single_page_durations.append((time.perf_counter() - t0_p) * 1000.0)
                    cursor = page["oldest_message_id"]

                total_ms = (time.perf_counter() - t_total_start) * 1000.0
                total_times.append(total_ms)
                per_page_times.extend(single_page_durations)
        finally:
            await engine.dispose()
            shutil.rmtree(tmp, ignore_errors=True)

    return {
        "benchmark": "10 sequential history pages (50 msgs/page)",
        "iterations": runs,
        "total_10_pages_ms": {
            "min": round(min(total_times), 2),
            "median": round(statistics.median(total_times), 2),
            "max": round(max(total_times), 2),
        },
        "per_page_avg_ms": {
            "min": round(min(per_page_times), 2),
            "median": round(statistics.median(per_page_times), 2),
            "max": round(max(per_page_times), 2),
        },
    }


async def run_concurrent_history_requests_benchmark(runs=5):
    durations = []
    dedup_counts = []

    for r in range(runs):
        tmp = tempfile.mkdtemp()
        try:
            engine = create_async_engine(f"sqlite+aiosqlite:///{tmp}/concurrent.db")
            sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

            owner = str(uuid.uuid4())
            async with sessions() as db:
                session = WhatsAppSession(user_id=owner, gateway_id=f"gw-{r}", session_name="Bench", status=SessionStatus.CONNECTED)
                db.add(session)
                contact = Contact(user_id=owner, phone_e164="+905551112233")
                db.add(contact)
                await db.flush()
                conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
                db.add(conv)
                await db.flush()

                t0 = datetime(2026, 1, 1, 12, 0, 0)
                msg0 = Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551112233",
                    recipient_phone="ME",
                    external_timestamp=t0,
                    body="anchor",
                    wa_message_id=f"anchor-{r}",
                )
                db.add(msg0)
                await db.commit()
                cid = conv.id
                m0_id = msg0.id

            call_count = 0

            async def mock_gw_get(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                await asyncio.sleep(0.02)
                return {
                    "messages": [{
                        "id": 999,
                        "wa_message_id": f"older-{r}",
                        "body": "older",
                        "created_at": (t0 - timedelta(minutes=5)).isoformat(),
                        "sender_phone": "+905551112233",
                        "recipient_phone": "ME",
                        "direction": "INBOUND",
                        "status": "RECEIVED",
                    }],
                    "has_more": False,
                }

            ws.gw.get_messages = mock_gw_get

            async def fetch_job():
                async with sessions() as s:
                    return await ws.get_messages(s, owner, cid, limit=10, before=m0_id)

            t_start = time.perf_counter()
            # 5 concurrent identical requests for the same older-history cursor
            results = await asyncio.gather(*[fetch_job() for _ in range(5)])
            elapsed = (time.perf_counter() - t_start) * 1000.0

            durations.append(elapsed)
            dedup_counts.append(call_count)
        finally:
            await engine.dispose()
            shutil.rmtree(tmp, ignore_errors=True)

    return {
        "benchmark": "5 concurrent identical older-history requests",
        "iterations": runs,
        "duration_ms": {
            "min": round(min(durations), 2),
            "median": round(statistics.median(durations), 2),
            "max": round(max(durations), 2),
        },
        "provider_calls_executed": {
            "min": min(dedup_counts),
            "median": statistics.median(dedup_counts),
            "max": max(dedup_counts),
        },
    }


async def main():
    print("=== STARTING WHATSAPP PERFORMANCE & HISTORY BENCHMARKS (5 RUNS EACH) ===")
    b1 = await run_500_conv_5500_msg_benchmark(5)
    print("1. 500 CONV / 5500 MSG:", json.dumps(b1, indent=2))

    b2 = await run_single_conversation_benchmark(1000, 5)
    print("2. 1000 MSG CONVERSATION:", json.dumps(b2, indent=2))

    b3 = await run_single_conversation_benchmark(5000, 5)
    print("3. 5000 MSG CONVERSATION:", json.dumps(b3, indent=2))

    b4 = await run_10_sequential_pages_benchmark(5)
    print("4. 10 SEQUENTIAL PAGES:", json.dumps(b4, indent=2))

    b5 = await run_concurrent_history_requests_benchmark(5)
    print("5. CONCURRENT REQUESTS:", json.dumps(b5, indent=2))
    print("=== BENCHMARKS COMPLETED SUCCESSFULLY ===")


if __name__ == "__main__":
    asyncio.run(main())
