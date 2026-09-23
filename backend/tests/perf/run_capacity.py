"""PHASE 2.C — deterministic capacity benchmark (synthetic workloads).

MEASURED benchmark (not a pytest suite). Run from repo root:
    backend/venv/bin/python backend/tests/perf/run_capacity.py

Deterministic contract:
  - fixed seed timestamps/ids/bodies (stable across runs)
  - isolated PostgreSQL DB scoutify_perf (see _env.py); never dev SQLite/tezlify
  - benchmark tenant 70000000-...-000000000000 wiped per workload
  - mock gateway returns production-shaped pages (limit=1000, offset, total)

Measured per workload: T0..T4, rows/s, SQL statement count + DB time,
RSS, asyncio task pressure, gateway page calls.
"""
import asyncio
import gc
import json
import resource
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
import backend.tests.perf._env  # noqa: F401,E402  (sets DATABASE_URL -> scoutify_perf)

from sqlalchemy import event, select, text  # noqa: E402

from backend.app.core.database import Base, AsyncSessionLocal, engine  # noqa: E402
from backend.app.models import contact as _c  # noqa: F401,E402
from backend.app.models import conversation as _v  # noqa: F401,E402
from backend.app.models import message as _m  # noqa: F401,E402
from backend.app.models import whatsapp_session as _s  # noqa: F401,E402
from backend.app.services.whatsapp.orchestration import sync as sync_mod  # noqa: E402
from backend.app.services.whatsapp.orchestration.sync import (  # noqa: E402
    SyncJob,
    WhatsAppSyncOrchestrator,
)

OWNER = "70000000-0000-0000-0000-000000000000"
OWNER_HEX = OWNER.replace("-", "")
SEED_TS = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

RESULTS: Dict[str, Any] = {}


def rss_mb() -> float:
    # macOS reports ru_maxrss in bytes; Linux in KiB.
    import platform

    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw / (1024.0 * 1024.0) if platform.system() == "Darwin" else raw / 1024.0


def conv_jid(i: int) -> str:
    return f"9055{7000000000 + i}@s.whatsapp.net"


def chat(i: int) -> Dict[str, Any]:
    return {"jid": conv_jid(i), "name": f"Bench Contact {i}", "last_message_at": None, "last_message_preview": None}


def gm_msg(ci: int, k: int) -> Dict[str, Any]:
    return {
        "conversation_id": conv_jid(ci),
        "wa_message_id": f"WA{ci:06d}{k:06d}",
        "direction": "INBOUND",
        "body": f"benchmark body conv={ci} seq={k}",
        "message_type": "TEXT",
        "sender_name": "Bench Sender",
        "created_at": (SEED_TS + timedelta(seconds=ci * 100000 + k)).isoformat(),
    }


class DeterministicGateway:
    """Test double of WhatsAppGatewayClient.list_all_messages (stable data)."""

    def __init__(self, n_conv: int, n_msg: int) -> None:
        self.n_conv = n_conv
        self.per_conv = max(1, n_msg // n_conv)
        self.total = n_conv * self.per_conv
        self.calls = 0

    async def list_all_messages(self, gateway_id: str, limit: int = 1000, offset: int = 0,
                                since: Optional[int] = None, per_chat_limit: int = 50) -> Dict[str, Any]:
        self.calls += 1
        msgs: List[Dict[str, Any]] = []
        lo, hi = offset, min(offset + limit, self.total)
        for idx in range(lo, hi):
            ci, k = divmod(idx, self.per_conv)
            msgs.append(gm_msg(ci, k))
        return {"messages": msgs, "total": self.total}


class SqlCounter:
    def __init__(self, eng) -> None:
        self.eng = eng
        self.count = 0
        self.time_s = 0.0
        self._t0 = 0.0

    def __enter__(self):
        event.listen(self.eng.sync_engine, "before_cursor_execute", self._before)
        event.listen(self.eng.sync_engine, "after_cursor_execute", self._after)
        return self

    def __exit__(self, *a):
        event.remove(self.eng.sync_engine, "before_cursor_execute", self._before)
        event.remove(self.eng.sync_engine, "after_cursor_execute", self._after)

    def _before(self, *a, **kw):
        self._t0 = time.perf_counter()
        self.count += 1

    def _after(self, *a, **kw):
        self.time_s += time.perf_counter() - self._t0


class TaskProbe:
    """Counts tasks created during the window (§17)."""

    def __init__(self) -> None:
        self.created = 0
        self._p = None

    def __enter__(self):
        import asyncio

        real = asyncio.create_task

        def counting(coro, **kw):
            self.created += 1
            return real(coro, **kw)

        self._p = patch.object(asyncio, "create_task", side_effect=counting)
        self._p.start()
        return self

    def __exit__(self, *a):
        self._p.stop()


async def wipe() -> None:
    async with AsyncSessionLocal() as db:
        for t in ("messages", "conversations", "contacts", "whatsapp_sessions"):
            await db.execute(text(f"DELETE FROM {t} WHERE user_id = :u"), {"u": OWNER_HEX})
        await db.commit()


async def add_session(gateway_id: str) -> None:
    from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=OWNER, gateway_id=gateway_id, session_name="bench",
                               status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()


async def first_message_seen(owner: str, deadline: float) -> Optional[float]:
    """Poller: returns the wall-clock time when the first message row appears."""
    from backend.app.models.message import Message

    while time.perf_counter() < deadline:
        async with AsyncSessionLocal() as db:
            row = (await db.execute(select(Message.id).where(Message.user_id == owner).limit(1))).first()
        if row is not None:
            return time.perf_counter()
        await asyncio.sleep(0.005)
    return None


async def run_workload(n_conv: int, n_msg: int, tag: str, persist_batch: Optional[int] = None,
                       wipe_first: bool = True) -> Dict[str, Any]:
    if wipe_first:
        await wipe()
    gw_id = f"gw-{tag}"
    await add_session(gw_id)
    orch = WhatsAppSyncOrchestrator()
    gwc = DeterministicGateway(n_conv, n_msg)

    gc.collect()
    with SqlCounter(engine) as sc, TaskProbe() as tp:
        t0 = time.perf_counter()
        async with AsyncSessionLocal() as db:
            _out, jid_by_conv = await orch._persist_chat_snapshot(db, OWNER, [chat(i) for i in range(n_conv)])
        t1 = time.perf_counter()  # T1: first conversations persisted

        job = SyncJob(sync_id=f"sync-{tag}", user_id=OWNER)
        poller = asyncio.ensure_future(first_message_seen(OWNER, t0 + 300))
        patches = [patch.object(sync_mod, "gw", gwc)]
        if persist_batch is not None:
            patches.append(patch.object(sync_mod, "_SYNC_PERSIST_BATCH", persist_batch))
        for p in patches:
            p.start()
        try:
            async with AsyncSessionLocal() as db:
                await orch._run_bulk_message_sync(db, job, dict(jid_by_conv), gw_id)
        finally:
            for p in patches:
                p.stop()
        t2 = await poller  # T2: first message row visible
        t3 = time.perf_counter()  # T3: final message persisted (bulk returned)

    async with AsyncSessionLocal() as db:
        from backend.app.models.message import Message

        n_rows = len((await db.execute(select(Message.id).where(Message.user_id == OWNER))).all())

    r = {
        "conv": n_conv,
        "msg": int(gwc.total),
        "T1_first_conv_s": round(t1 - t0, 3),
        "T2_first_msg_s": round(t2 - t0, 3) if t2 else None,
        "T3_final_msg_s": round(t3 - t0, 3),
        "rows": n_rows,
        "msg_per_s": round(n_rows / max(t3 - t1, 1e-6), 1),
        "conv_per_s": round(n_conv / max(t1 - t0, 1e-6), 1),
        "sql": sc.count,
        "db_time_s": round(sc.time_s, 3),
        "tasks": tp.created,
        "peak_rss_mb": round(rss_mb(), 1),
        "gw_pages": gwc.calls,
    }
    print(f"[{tag}] {json.dumps(r)}", flush=True)
    return r


async def main() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    RESULTS["meta"] = {"db": "scoutify_perf PostgreSQL 17.11 (isolated)", "seed_ts": SEED_TS.isoformat()}

    # §7/§9 calibration + scale
    RESULTS["W1_100x1000"] = await run_workload(100, 1000, "w1")
    RESULTS["W2_500x5500"] = await run_workload(500, 5500, "w2")
    RESULTS["W3_1000x20000"] = await run_workload(1000, 20000, "w3")

    # §10 repeatability: W2 x3
    RESULTS["W2_repeat"] = [await run_workload(500, 5500, f"w2r{i}") for i in range(3)]

    # §11 replay idempotency: rerun the exact same dataset WITHOUT wiping
    # (previous W2 run left its rows; expected: 0 new rows)
    RESULTS["replay"] = await run_workload(500, 5500, "w2replay", wipe_first=False)

    # §8 chunk sweep (test-controlled; production value is 200)
    RESULTS["chunk_sweep"] = {
        str(b): await run_workload(500, 5500, f"chunk{b}", persist_batch=b) for b in (50, 100, 200)
    }

    # §9 W4 — only if environment holds (attempt; report constraint if not)
    try:
        RESULTS["W4_5000x100000"] = await run_workload(5000, 100000, "w4")
    except Exception as e:  # noqa: BLE001
        RESULTS["W4_5000x100000"] = {"error": f"{type(e).__name__}: {e}"[:200]}

    with open("/tmp/phase2c-results.json", "w") as f:
        json.dump(RESULTS, f, indent=2)
    print("DONE", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
