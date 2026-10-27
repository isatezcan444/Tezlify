"""The migration that has to work on a table which already exists.

`whatsapp_data_audit` was created in Phase 2, so in production it is NOT a fresh
table. `WhatsAppDataAudit.__table__.create(checkfirst=True)` skips an existing
table **entirely — including its indexes and new columns**. So the model gaining
`idempotency_key` and a UNIQUE index changes nothing in the live database unless
the migration issues an explicit ALTER and CREATE INDEX.

That is the "tests are green but production has no constraint" trap, and it is
invisible without a test that starts from the OLD shape. These tests build the
old table by hand and then run the real migration against it.

Each case uses its own throwaway SQLite file so it can control the starting
schema exactly; the shared test DB is already up to date and would make every
assertion here vacuous.
"""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.migrations import ensure_whatsapp_data_audit_table

# The Phase-2 shape: everything except `idempotency_key`, and no unique index.
_LEGACY_DDL = """
CREATE TABLE whatsapp_data_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME NOT NULL,
    event VARCHAR(48) NOT NULL,
    source VARCHAR(24) NOT NULL,
    user_id CHAR(32),
    session_id INTEGER,
    correlation_id VARCHAR(36),
    outcome VARCHAR(16) NOT NULL,
    reason VARCHAR(160),
    conversation_ids JSON,
    contact_ids JSON,
    counts_before JSON,
    counts_after JSON,
    outbox_event_id VARCHAR(64),
    detail TEXT
)
"""


async def _columns(engine) -> set:
    async with engine.connect() as conn:
        rows = (await conn.execute(text("PRAGMA table_info(whatsapp_data_audit)"))).fetchall()
    return {r[1] for r in rows}


async def _indexes(engine) -> set:
    async with engine.connect() as conn:
        rows = (
            await conn.execute(text("PRAGMA index_list(whatsapp_data_audit)"))
        ).fetchall()
    return {r[1] for r in rows}


@pytest.mark.asyncio
async def test_migration_adds_the_column_to_an_existing_table(tmp_path) -> None:
    db_path = tmp_path / f"legacy-{uuid.uuid4().hex[:8]}.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text(_LEGACY_DDL))
            await conn.execute(
                text(
                    "INSERT INTO whatsapp_data_audit "
                    "(created_at, event, source, outcome) VALUES "
                    "(datetime('now'), 'conversation_deleted', 'api', 'committed')"
                )
            )

        assert "idempotency_key" not in await _columns(engine)
        assert "uq_wa_data_audit_idempotency_key" not in await _indexes(engine)

        status = await ensure_whatsapp_data_audit_table(engine)
        assert status == "CREATED", status

        # The whole point: the ALTER really happened on the pre-existing table.
        assert "idempotency_key" in await _columns(engine)
        assert "uq_wa_data_audit_idempotency_key" in await _indexes(engine)

        # Idempotent: a second boot must not redo the DDL or fail.
        assert await ensure_whatsapp_data_audit_table(engine) == "ALREADY_PRESENT"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_migration_preserves_existing_rows(tmp_path) -> None:
    """Additive means additive: the legacy row must still be there, unchanged."""
    db_path = tmp_path / f"legacy-{uuid.uuid4().hex[:8]}.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text(_LEGACY_DDL))
            await conn.execute(
                text(
                    "INSERT INTO whatsapp_data_audit "
                    "(created_at, event, source, outcome, reason) VALUES "
                    "(datetime('now'), 'sweep_run', 'sweep', 'committed', 'legacy-row')"
                )
            )

        await ensure_whatsapp_data_audit_table(engine)

        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text("SELECT event, reason, idempotency_key FROM whatsapp_data_audit")
                )
            ).fetchall()
        assert len(rows) == 1, rows
        assert rows[0][1] == "legacy-row"
        assert rows[0][2] is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_unique_index_actually_rejects_a_duplicate_key(tmp_path) -> None:
    """A created index that does not constrain anything is decoration."""
    db_path = tmp_path / f"legacy-{uuid.uuid4().hex[:8]}.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text(_LEGACY_DDL))
        await ensure_whatsapp_data_audit_table(engine)

        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO whatsapp_data_audit "
                    "(created_at, event, source, outcome, idempotency_key) VALUES "
                    "(datetime('now'), 'conversation_deleted', 'api', 'committed', 'k1')"
                )
            )

        from sqlalchemy.exc import IntegrityError

        with pytest.raises(IntegrityError):
            async with engine.begin() as conn:
                await conn.execute(
                    text(
                        "INSERT INTO whatsapp_data_audit "
                        "(created_at, event, source, outcome, idempotency_key) VALUES "
                        "(datetime('now'), 'conversation_deleted', 'api', 'committed', 'k1')"
                    )
                )

        # NULL keys are exempt — a sweep summary has no natural key, and the
        # partial predicate must keep allowing several of them.
        async with engine.begin() as conn:
            for _ in range(3):
                await conn.execute(
                    text(
                        "INSERT INTO whatsapp_data_audit "
                        "(created_at, event, source, outcome) VALUES "
                        "(datetime('now'), 'sweep_run', 'sweep', 'committed')"
                    )
                )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_migration_refuses_to_create_the_index_over_duplicates(tmp_path) -> None:
    """BLOCKED, and nothing is deleted.

    If the column already exists with duplicate values, creating the unique
    index would fail. The tempting "fix" is to delete the extra rows — which in
    an AUDIT table destroys the very evidence the table exists to hold. The
    migration must refuse and say so instead.
    """
    db_path = tmp_path / f"legacy-{uuid.uuid4().hex[:8]}.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text(_LEGACY_DDL))
            await conn.execute(text("ALTER TABLE whatsapp_data_audit ADD COLUMN idempotency_key VARCHAR(96)"))
            for _ in range(2):
                await conn.execute(
                    text(
                        "INSERT INTO whatsapp_data_audit "
                        "(created_at, event, source, outcome, idempotency_key) VALUES "
                        "(datetime('now'), 'conversation_deleted', 'api', 'committed', 'dupe')"
                    )
                )

        status = await ensure_whatsapp_data_audit_table(engine)
        assert status == "BLOCKED", status
        assert "uq_wa_data_audit_idempotency_key" not in await _indexes(engine)

        # Refusing means refusing to touch the data, not "cleaning it up".
        async with engine.connect() as conn:
            n = (
                await conn.execute(text("SELECT COUNT(*) FROM whatsapp_data_audit"))
            ).scalar()
        assert n == 2, "the migration must not delete audit rows"
    finally:
        await engine.dispose()
