"""PHASE 2.C — TOCTOU race (§12) + concurrent sessions (§16) benchmarks.

TOCTOU: realtime inserts message M, then bulk sync attempts the same M.
Deterministic (no sleeping races): realtime first, bulk second — the exact
sequence PHASE 2.B flagged as unprotected (raw INSERT, no IntegrityError
fallback). Run N times to measure occurrence rate.

Sessions: 5 owners x (500 conv / 5500 msg) concurrently on scoutify_perf.
"""
import asyncio
import gc
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
import backend.tests.perf._env  # noqa: F401,E402

from sqlalchemy import select, text  # noqa: E402

from backend.app.core.database import AsyncSessionLocal, engine  # noqa: E402
from backend.app.models import contact as _c  # noqa: F401,E402
from backend.app.models import conversation as _v  # noqa: F401,E402
from backend.app.models import message as _m  # noqa: F401,E402
from backend.app.models import whatsapp_session as _s  # noqa: F401,E402
from backend.app.services import whatsapp_service as ws  # noqa: E402
from backend.app.services.whatsapp.orchestration import sync as sync_mod  # noqa: E402
from backend.app.services.whatsapp.orchestration.sync import (  # noqa: E402
    SyncJob,
    WhatsAppSyncOrchestrator,
)

RESULTS: Dict[str, Any] = {"toctou": [], "sessions": {}}


def owner(n: int) -> str:
    return f"80000000-0000-0000-0000-{n:012d}"


def owner_hex(n: int) -> str:
    return owner(n).replace("-", "")


async def wipe_owner(n: int) -> None:
    async with AsyncSessionLocal() as db:
        for t in ("messages", "conversations", "contacts", "whatsapp_sessions"):
            await db.execute(text(f"DELETE FROM {t} WHERE user_id = :u"), {"u": owner_hex(n)})
        await db.commit()


async def add_session(n: int, gateway_id: str) -> None:
    from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=owner(n), gateway_id=gateway_id, session_name="bench",
                               status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()


async def toctou_once(run: int) -> Dict[str, Any]:
    n = 990000 + run
    await wipe_owner(n)
    gw = f"gw-toctou-{run}"
    await add_session(n, gw)
    jid = f"9055{8000000000 + run}@s.whatsapp.net"
    created = "2026-01-01T12:00:00+00:00"
    # Task A: realtime inserts M first.
    event = {"event": "message_new", "gateway_session_id": gw,
             "message": {"conversation_id": jid, "wa_message_id": f"WA-DUP-{run}",
                          "direction": "INBOUND", "body": "realtime first", "message_type": "TEXT",
                          "sender_name": "S", "created_at": created}}
    p = await ws.ingest_gateway_event(event)
    assert p is not None, "realtime insert must succeed"

    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        _out, jid_by_conv = await orch._persist_chat_snapshot(
            db, owner(n), [{"jid": jid, "name": "T", "last_message_at": None, "last_message_preview": None}])

    # Task B: bulk sync attempts the same M (deterministic mock).
    async def list_all_messages(gateway_id, limit=1000, offset=0, since=None, per_chat_limit=50):
        return {"messages": [{"conversation_id": jid, "wa_message_id": f"WA-DUP-{run}",
                              "direction": "INBOUND", "body": "bulk same", "message_type": "TEXT",
                              "created_at": created}], "total": 1}

    fake_gw = MagicMock()
    fake_gw.list_all_messages = list_all_messages
    job = SyncJob(sync_id=f"sync-toctou-{run}", user_id=owner(n))
    outcome, err = "no_collision", ""
    t0 = time.perf_counter()
    try:
        async with AsyncSessionLocal() as db:
            with patch.object(sync_mod, "gw", fake_gw):
                await orch._run_bulk_message_sync(db, job, dict(jid_by_conv), gw)
    except Exception as e:  # noqa: BLE001
        outcome, err = type(e).__name__, str(e)[:120]
    t1 = time.perf_counter()
    async with AsyncSessionLocal() as db:
        rows = len((await db.execute(select(1).where(text("true")).limit(1))).all())  # noqa
        from backend.app.models.message import Message

        from backend.app.models.conversation import Conversation

        mrows = (await db.execute(
            select(Message.body).join(Conversation, Message.conversation_id == Conversation.id)
            .where(Conversation.user_id == owner(n)))).all()
    return {
        "run": run,
        "bulk_outcome": outcome,
        "job_state": job.state,
        "db_state": [r[0] for r in mrows],
        "dup_rows": len(mrows),
        "elapsed_s": round(t1 - t0, 4),
        "error": err,
    }


async def one_session(n: int) -> Dict[str, Any]:
    await wipe_owner(n)
    gw = f"gw-session-{n}"
    await add_session(n, gw)
    orch = WhatsAppSyncOrchestrator()
    per_conv = 11
    n_conv = 500
    total = n_conv * per_conv

    async def list_all_messages(gateway_id, limit=1000, offset=0, since=None, per_chat_limit=50):
        msgs = []
        for idx in range(offset, min(offset + limit, total)):
            ci, k = divmod(idx, per_conv)
            msgs.append({"conversation_id": f"9055{8000000000 + ci}@s.whatsapp.net",
                         "wa_message_id": f"WA{ci:06d}{k:06d}", "direction": "INBOUND",
                         "body": f"s{n} m{k}", "message_type": "TEXT",
                         "created_at": f"2026-01-01T12:{ci // 60:02d}:{ci % 60:02d}+00:00"})
        return {"messages": msgs, "total": total}

    fake_gw = MagicMock()
    fake_gw.list_all_messages = list_all_messages
    t0 = time.perf_counter()
    async with AsyncSessionLocal() as db:
        _out, jid_by_conv = await orch._persist_chat_snapshot(
            db, owner(n), [{"jid": f"9055{8000000000 + i}@s.whatsapp.net", "name": f"Session {n} C{i}",
                            "last_message_at": None, "last_message_preview": None} for i in range(n_conv)])
    t1 = time.perf_counter()
    job = SyncJob(sync_id=f"sync-session-{n}", user_id=owner(n))
    async with AsyncSessionLocal() as db:
        with patch.object(sync_mod, "gw", fake_gw):
            await orch._run_bulk_message_sync(db, job, dict(jid_by_conv), gw)
    t2 = time.perf_counter()
    return {"session": n, "snapshot_s": round(t1 - t0, 3), "bulk_s": round(t2 - t1, 3),
            "total_s": round(t2 - t0, 3), "rows": job.messages_synced}


async def main() -> None:
    async with engine.begin() as conn:
        from backend.app.core.database import Base

        await conn.run_sync(Base.metadata.create_all)

    # §12 TOCTOU: 5 deterministic runs
    for i in range(5):
        RESULTS["toctou"].append(await toctou_once(i))
        print(f"[TOCTOU {i}] {RESULTS['toctou'][-1]}", flush=True)

    # §16 concurrent sessions: 5 x (500 conv / 5500 msg)
    t0 = time.perf_counter()
    results = await asyncio.gather(*(one_session(n) for n in range(5)))
    t1 = time.perf_counter()
    RESULTS["sessions"] = {
        "concurrent": sorted(results, key=lambda r: r["session"]),
        "wall_s": round(t1 - t0, 3),
        "sum_individual_s": round(sum(r["total_s"] for r in results), 3),
    }
    print(f"[SESSIONS] {json.dumps(RESULTS['sessions'])}", flush=True)

    with open("/tmp/phase2c-races.json", "w") as f:
        json.dump(RESULTS, f, indent=2)
    print("DONE", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
