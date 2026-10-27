"""Audit tablosunun ACILIS SIRASI — "tablo yok" ile "olay yok" ayni sey degildir.

Onceki sirada `ensure_whatsapp_data_audit_table` cagrisi
`purge_empty_ghost_conversations`'tan SONRA geliyordu. Taze bir kurulumda ilk
ghost temizliginin denetim satiri "tablo yok" hatasiyla duserdi; hata yutuldugu
icin sistem "denetim calisiyor" gorunurdu. Ustelik `failed == 0` de yaniltici:
tablo hic olusmamisken ve denetlenen bir adim henuz calismamisken de sifirdir.

Bu dosya sirasini ve `table_ready` sinyalini pinler. Testler kendi gecici
SQLite dosyalarini kurar; hicbiri uretim veritabanina baglanmaz.
"""

import logging
import pathlib
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import backend.app.main as main_module
from backend.app.core.migrations import ensure_whatsapp_data_audit_table

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

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


@pytest.fixture(autouse=True)
def _restore_table_status():
    """Modul globali testler arasinda sizmamali."""
    saved = main_module._DATA_AUDIT_TABLE_STATUS
    try:
        yield
    finally:
        main_module._DATA_AUDIT_TABLE_STATUS = saved


def _lifespan_source() -> str:
    import ast

    source = pathlib.Path(main_module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    node = next(
        n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "lifespan"
    )
    lines = source.splitlines()
    return "\n".join(lines[node.lineno - 1 : node.end_lineno])


def test_audit_table_is_ensured_before_the_ghost_purge() -> None:
    """SIRA: tablo hazirligi, denetlenen yikici adimdan ONCE olmali.

    Yanlislanabilir: cagriyi purge'ten sonraya tasimak bu testi kirmizi yapar.
    """
    body = _lifespan_source()
    ensure_at = body.find("_ensure_audit_table_ready(engine)")
    purge_at = body.find("purge_empty_ghost_conversations(engine)")
    assert ensure_at != -1, "lifespan audit tablosunu hic hazirlamiyor"
    assert purge_at != -1, "lifespan ghost purge cagrisini icermiyor"
    assert ensure_at < purge_at, (
        "audit tablosu ghost purge'ten SONRA hazirlaniyor: ilk temizligin "
        "denetim satiri 'tablo yok' ile duserdi"
    )


@pytest.mark.asyncio
async def test_fresh_database_gets_the_table_before_anything_writes(tmp_path) -> None:
    """Temiz bir veritabaninda tablo + idempotency kolonu + UNIQUE indeks olusmali."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / f'fresh-{uuid.uuid4().hex[:8]}.db'}")
    try:
        status = await main_module._ensure_audit_table_ready(engine)
        assert status in ("CREATED", "ALREADY_PRESENT"), status

        async with engine.connect() as conn:
            columns = {
                row[1]
                for row in (
                    await conn.execute(text("PRAGMA table_info(whatsapp_data_audit)"))
                ).fetchall()
            }
            indexes = {
                row[1]
                for row in (
                    await conn.execute(text("PRAGMA index_list(whatsapp_data_audit)"))
                ).fetchall()
            }
        assert "idempotency_key" in columns
        assert "uq_wa_data_audit_idempotency_key" in indexes
        assert main_module._DATA_AUDIT_TABLE_STATUS == status
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_existing_table_is_idempotent_and_keeps_its_rows(tmp_path) -> None:
    """Ikinci acilis DDL'i tekrarlamamali ve hicbir denetim satirini silmemeli."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / f'idem-{uuid.uuid4().hex[:8]}.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text(_LEGACY_DDL))
            await conn.execute(
                text(
                    "INSERT INTO whatsapp_data_audit "
                    "(created_at, event, source, outcome, reason) VALUES "
                    "(datetime('now'), 'sweep_run', 'sweep', 'committed', 'keep-me')"
                )
            )

        first = await main_module._ensure_audit_table_ready(engine)
        assert first == "CREATED", first
        second = await main_module._ensure_audit_table_ready(engine)
        assert second == "ALREADY_PRESENT", second

        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text("SELECT event, reason FROM whatsapp_data_audit")
                )
            ).fetchall()
        assert len(rows) == 1
        assert rows[0][1] == "keep-me"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_blocked_table_is_not_reported_as_success(tmp_path, caplog) -> None:
    """Tablo kurulamiyorsa bu SESSIZ olmamali: ERROR logu + table_ready=false.

    `BLOCKED` = kolonda yinelenen deger var, UNIQUE indeks kurulmadi. Migration
    hicbir satiri silmez (denetim tablosunda silmek denetimi yok etmektir) ama
    durumun gorunur olmasi gerekir.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / f'blocked-{uuid.uuid4().hex[:8]}.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text(_LEGACY_DDL))
            await conn.execute(
                text("ALTER TABLE whatsapp_data_audit ADD COLUMN idempotency_key VARCHAR(96)")
            )
            for _ in range(2):
                await conn.execute(
                    text(
                        "INSERT INTO whatsapp_data_audit "
                        "(created_at, event, source, outcome, idempotency_key) VALUES "
                        "(datetime('now'), 'conversation_deleted', 'api', 'committed', 'dupe')"
                    )
                )

        with caplog.at_level(logging.ERROR):
            status = await main_module._ensure_audit_table_ready(engine)

        assert status == "BLOCKED", status
        assert main_module._DATA_AUDIT_TABLE_STATUS == "BLOCKED"
        assert any("HAZIR DEGIL" in record.message for record in caplog.records), (
            "BLOCKED durumu loglanmadi — sessiz basarisizlik"
        )

        stats = main_module._data_audit_stats()
        assert stats["table_status"] == "BLOCKED"
        assert stats["table_ready"] is False

        # Reddetmek, veriyi "temizlemek" degildir.
        async with engine.connect() as conn:
            count = (
                await conn.execute(text("SELECT COUNT(*) FROM whatsapp_data_audit"))
            ).scalar()
        assert count == 2
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_health_reports_table_ready_after_a_successful_bootstrap(tmp_path) -> None:
    """`failed == 0` tek basina yetmez; tablo gercekten hazir mi da gorunmeli."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / f'ready-{uuid.uuid4().hex[:8]}.db'}")
    try:
        await main_module._ensure_audit_table_ready(engine)
        stats = main_module._data_audit_stats()
        assert stats["table_ready"] is True
        assert stats["table_status"] in ("CREATED", "ALREADY_PRESENT")
        assert "failed" in stats
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_ghost_purge_audit_reports_failure_instead_of_raising(monkeypatch) -> None:
    """Denetim yazilamazsa fonksiyon False doner ve acilis DUSMEZ."""

    class _BrokenSession:
        async def __aenter__(self):
            raise RuntimeError("pool exhausted")

        async def __aexit__(self, *exc_info):
            return False

    import backend.app.core.database as database_module

    monkeypatch.setattr(database_module, "AsyncSessionLocal", lambda: _BrokenSession())
    assert await main_module._record_ghost_purge_audit(2) is False
    # 0 silmede hic deneme yapilmaz — basari sayilir, satir yazilmaz.
    assert await main_module._record_ghost_purge_audit(0) is True
