"""Connection-attempt stage timing — the measurement Phase 2 could not take.

Phase 2 found `observability.latency()` correct but silent in production
(`WHATSAPP_LATENCY_PROFILING` unset), so "measure QR -> first chat" had no
number to read. The backend now owns a durable version of that measurement, and
these tests pin the three properties that make it trustworthy:

  1. a stage is recorded only when it was observed — a missing start yields
     `elapsed_ms = None`, never `0`;
  2. two attempts cannot borrow each other's clock;
  3. percentiles are withheld below a stated sample size instead of being
     computed from one sample and quoted as a trend.
"""

import asyncio
import uuid

import pytest
from sqlalchemy import delete, select

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_connect_stage import (
    STAGE_ATTEMPT_FAILED,
    STAGE_FIRST_MESSAGE,
    STAGE_PAIRING_REQUESTED,
    STAGE_QR_RECEIVED,
    STAGE_SOCKET_OPEN,
    STAGE_SYNC_COMPLETED,
    WhatsAppConnectStage,
)
from backend.app.services import whatsapp_connect_metrics as cm


async def _purge(*correlation_ids: str) -> None:
    async with AsyncSessionLocal() as db:
        for cid in correlation_ids:
            await db.execute(
                delete(WhatsAppConnectStage).where(
                    WhatsAppConnectStage.correlation_id == str(cid)
                )
            )
        await db.commit()


def _gw() -> str:
    """A fresh gateway session id: one per pairing attempt, by construction."""
    return str(uuid.uuid4())


@pytest.mark.asyncio
async def test_attempt_id_is_derived_deterministically_and_is_not_the_uuid() -> None:
    gw = _gw()
    a = cm.attempt_id_for_gateway(gw)
    b = cm.attempt_id_for_gateway(gw)

    assert a == b, "the same attempt must always resolve to the same id"
    assert a != gw, "the raw gateway UUID must never be the correlation id"
    assert len(a) == 32
    assert cm.attempt_id_for_gateway(_gw()) != a, "two attempts must differ"
    assert cm.attempt_id_for_gateway(None) is None


@pytest.mark.asyncio
async def test_elapsed_is_measured_from_this_attempt_start() -> None:
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db,
                correlation_id=cid,
                stage=STAGE_PAIRING_REQUESTED,
                gateway_id=gw,
            )
            await cm.record_stage(
                db,
                correlation_id=cid,
                stage=STAGE_QR_RECEIVED,
                gateway_id=gw,
            )

        async with AsyncSessionLocal() as db:
            timeline = await cm.attempt_timeline(db, cid)

        assert [s["stage"] for s in timeline] == [
            STAGE_PAIRING_REQUESTED,
            STAGE_QR_RECEIVED,
        ], timeline
        start, second = timeline
        assert start["elapsed_ms"] == 0, start
        assert second["elapsed_ms"] is not None and second["elapsed_ms"] >= 0, second
    finally:
        await _purge(cid)


@pytest.mark.asyncio
async def test_stage_without_a_start_row_has_null_elapsed_not_zero() -> None:
    """'We did not observe the start' must not read as 'it took no time'.

    Deliberately recorded AFTER another attempt's start row exists. A version of
    `record_stage` that looked up the earliest start globally — rather than this
    attempt's own — would happily compute a duration from the OTHER attempt and
    this test would catch it. Without that ordering the test is vacuous: with no
    start row anywhere, even a broken lookup returns None.
    """
    other_gw = _gw()
    other_cid = cm.attempt_id_for_gateway(other_gw)
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db,
                correlation_id=other_cid,
                stage=STAGE_PAIRING_REQUESTED,
                gateway_id=other_gw,
            )
        await asyncio.sleep(0.05)
        async with AsyncSessionLocal() as db:
            # This attempt has NO start row of its own.
            await cm.record_stage(
                db,
                correlation_id=cid,
                stage=STAGE_SOCKET_OPEN,
                gateway_id=gw,
            )

        async with AsyncSessionLocal() as db:
            timeline = await cm.attempt_timeline(db, cid)

        assert len(timeline) == 1
        assert timeline[0]["elapsed_ms"] is None, (
            "elapsed must be NULL when THIS attempt's start was never observed; "
            f"got {timeline[0]['elapsed_ms']} — likely borrowed from another attempt"
        )
    finally:
        await _purge(cid, other_cid)


@pytest.mark.asyncio
async def test_two_attempts_do_not_share_a_clock() -> None:
    """Attempt B's duration must be measured from B's start, not A's.

    The assertion is a MAGNITUDE, not just "not None": B's start is recorded
    ~150 ms after A's, so a contaminated clock would report ~150 ms for a stage
    that happened immediately after B's start. Checking only `is not None` lets
    the contamination through — verified by removing the fix and watching this
    test still pass, which is how it was rewritten.
    """
    gw_a, gw_b = _gw(), _gw()
    cid_a, cid_b = cm.attempt_id_for_gateway(gw_a), cm.attempt_id_for_gateway(gw_b)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db, correlation_id=cid_a, stage=STAGE_PAIRING_REQUESTED, gateway_id=gw_a
            )
        await asyncio.sleep(0.15)
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db, correlation_id=cid_b, stage=STAGE_PAIRING_REQUESTED, gateway_id=gw_b
            )
            await cm.record_stage(
                db, correlation_id=cid_b, stage=STAGE_QR_RECEIVED, gateway_id=gw_b
            )

        async with AsyncSessionLocal() as db:
            timeline_b = await cm.attempt_timeline(db, cid_b)
            timeline_a = await cm.attempt_timeline(db, cid_a)

        assert [s["stage"] for s in timeline_a] == [STAGE_PAIRING_REQUESTED], timeline_a
        assert len(timeline_b) == 2, timeline_b
        b_elapsed = timeline_b[1]["elapsed_ms"]
        assert b_elapsed is not None
        assert b_elapsed < 100, (
            f"attempt B's stage reported {b_elapsed} ms but its own start was "
            "moments earlier — it borrowed attempt A's clock"
        )
    finally:
        await _purge(cid_a, cid_b)


@pytest.mark.asyncio
async def test_a_redelivered_stage_is_not_a_second_sample() -> None:
    """A duplicated `first_message_persisted` would halve the apparent duration."""
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db, correlation_id=cid, stage=STAGE_PAIRING_REQUESTED, gateway_id=gw
            )
            first = await cm.record_stage(
                db, correlation_id=cid, stage=STAGE_FIRST_MESSAGE, gateway_id=gw
            )
            second = await cm.record_stage(
                db, correlation_id=cid, stage=STAGE_FIRST_MESSAGE, gateway_id=gw
            )

        assert first is True
        assert second is False, "the duplicate must be refused, not appended"

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppConnectStage).where(
                        WhatsAppConnectStage.correlation_id == cid,
                        WhatsAppConnectStage.stage == STAGE_FIRST_MESSAGE,
                    )
                )
            ).scalars().all()
        assert len(rows) == 1
    finally:
        await _purge(cid)


@pytest.mark.asyncio
async def test_record_stage_once_is_cheap_but_still_correct() -> None:
    """The hot-path variant: one row, and the second call is a memo hit."""
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db, correlation_id=cid, stage=STAGE_PAIRING_REQUESTED, gateway_id=gw
            )
            wrote_first = await cm.record_stage_once(
                db, correlation_id=cid, stage=STAGE_FIRST_MESSAGE, gateway_id=gw
            )
            wrote_again = await cm.record_stage_once(
                db, correlation_id=cid, stage=STAGE_FIRST_MESSAGE, gateway_id=gw
            )

        assert wrote_first is True
        assert wrote_again is False
        assert (cid, STAGE_FIRST_MESSAGE) in cm._ONCE_CACHE

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppConnectStage).where(
                        WhatsAppConnectStage.correlation_id == cid,
                        WhatsAppConnectStage.stage == STAGE_FIRST_MESSAGE,
                    )
                )
            ).scalars().all()
        assert len(rows) == 1
    finally:
        await _purge(cid)


@pytest.mark.asyncio
async def test_stored_row_carries_no_gateway_uuid() -> None:
    """Privacy: the table must never contain the raw gateway session UUID."""
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db, correlation_id=cid, stage=STAGE_PAIRING_REQUESTED, gateway_id=gw
            )

        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(
                    select(WhatsAppConnectStage).where(
                        WhatsAppConnectStage.correlation_id == cid
                    )
                )
            ).scalars().first()

        assert row.gateway_ref is not None
        assert len(row.gateway_ref) == 12
        assert gw not in row.gateway_ref
        blob = repr(row.as_dict())
        assert gw not in blob, "gateway UUID leaked into the metrics table"
        assert "@s.whatsapp.net" not in blob and "@lid" not in blob
    finally:
        await _purge(cid)


@pytest.mark.asyncio
async def test_summary_withholds_percentiles_below_the_stated_sample_size() -> None:
    """Two samples are not a p95. The API must say so instead of implying it."""
    user_id = str(uuid.uuid4())
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db,
                correlation_id=cid,
                stage=STAGE_PAIRING_REQUESTED,
                user_id=user_id,
                gateway_id=gw,
            )
            await cm.record_stage(
                db,
                correlation_id=cid,
                stage=STAGE_QR_RECEIVED,
                user_id=user_id,
                gateway_id=gw,
            )

        async with AsyncSessionLocal() as db:
            summary = await cm.stage_summary(db, days=7, user_id=user_id)

        entry = summary["stages"][STAGE_QR_RECEIVED]
        assert entry["n"] == 1
        assert entry["percentiles_reliable"] is False
        assert "p95_ms" not in entry, entry
        assert entry["values_ms"] == [entry["min_ms"]], entry
        assert summary["min_samples_for_percentile"] == cm.MIN_SAMPLES_FOR_PERCENTILE
    finally:
        await _purge(cid)


@pytest.mark.asyncio
async def test_summary_emits_percentiles_once_enough_samples_exist() -> None:
    user_id = str(uuid.uuid4())
    cids = []
    try:
        for _ in range(cm.MIN_SAMPLES_FOR_PERCENTILE):
            gw = _gw()
            cid = cm.attempt_id_for_gateway(gw)
            cids.append(cid)
            async with AsyncSessionLocal() as db:
                await cm.record_stage(
                    db,
                    correlation_id=cid,
                    stage=STAGE_PAIRING_REQUESTED,
                    user_id=user_id,
                    gateway_id=gw,
                )
                await cm.record_stage(
                    db,
                    correlation_id=cid,
                    stage=STAGE_SYNC_COMPLETED,
                    user_id=user_id,
                    gateway_id=gw,
                )

        async with AsyncSessionLocal() as db:
            summary = await cm.stage_summary(db, days=7, user_id=user_id)

        entry = summary["stages"][STAGE_SYNC_COMPLETED]
        assert entry["n"] == cm.MIN_SAMPLES_FOR_PERCENTILE, entry
        assert entry["percentiles_reliable"] is True
        assert entry["p50_ms"] is not None and entry["p95_ms"] is not None
        assert entry["p50_ms"] <= entry["p95_ms"]
        assert summary["attempts"] >= cm.MIN_SAMPLES_FOR_PERCENTILE
    finally:
        await _purge(*cids)


@pytest.mark.asyncio
async def test_failed_attempt_is_visible_as_a_failure() -> None:
    """A cancelled pairing must not be indistinguishable from one that never ran."""
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db, correlation_id=cid, stage=STAGE_PAIRING_REQUESTED, gateway_id=gw
            )
            await cm.record_stage(
                db,
                correlation_id=cid,
                stage=STAGE_ATTEMPT_FAILED,
                gateway_id=gw,
                outcome="cancelled",
                reason_code="cancelled_by_client",
            )

        async with AsyncSessionLocal() as db:
            timeline = await cm.attempt_timeline(db, cid)

        failed = [s for s in timeline if s["stage"] == STAGE_ATTEMPT_FAILED]
        assert len(failed) == 1
        assert failed[0]["outcome"] == "cancelled"
        assert failed[0]["reason_code"] == "cancelled_by_client"
    finally:
        await _purge(cid)


@pytest.mark.asyncio
async def test_prune_keeps_recent_rows() -> None:
    gw = _gw()
    cid = cm.attempt_id_for_gateway(gw)
    try:
        async with AsyncSessionLocal() as db:
            await cm.record_stage(
                db, correlation_id=cid, stage=STAGE_PAIRING_REQUESTED, gateway_id=gw
            )

        async with AsyncSessionLocal() as db:
            removed = await cm.prune_old_stages(db, days=90)

        async with AsyncSessionLocal() as db:
            rows = (
                await db.execute(
                    select(WhatsAppConnectStage).where(
                        WhatsAppConnectStage.correlation_id == cid
                    )
                )
            ).scalars().all()
        assert removed >= 0
        assert len(rows) == 1, "a fresh row must survive pruning"
    finally:
        await _purge(cid)


@pytest.mark.asyncio
async def test_record_stage_never_raises_on_a_broken_session() -> None:
    class ExplodingSession:
        async def execute(self, *_a, **_kw):
            raise RuntimeError("database is gone")

        def add(self, _row):
            raise RuntimeError("database is gone")

        async def commit(self):  # pragma: no cover
            raise RuntimeError("unreachable")

        async def flush(self):  # pragma: no cover
            raise RuntimeError("unreachable")

        async def rollback(self):
            return None

    ok = await cm.record_stage(
        ExplodingSession(),
        correlation_id="deadbeef",
        stage=STAGE_SOCKET_OPEN,
        gateway_id=_gw(),
    )
    assert ok is False

    ok_once = await cm.record_stage_once(
        ExplodingSession(),
        correlation_id="deadbeef2",
        stage=STAGE_SOCKET_OPEN,
        gateway_id=_gw(),
    )
    assert ok_once is False
