"""`ensure_tenant_scoped_lead_uniqueness` — lead kimliği kiracı başına benzersiz.

Üretimde `phone_e164` ve `place_id` GLOBAL benzersizdi (`ix_leads_phone_e164`,
`ix_leads_place_id`). Bu iki şeyi birden bozuyordu:

  1. ikinci bir kiracı, birinci kiracıda zaten kayıtlı bir numarayı/listing'i
     KENDİ lead'i olarak kaydedemiyordu;
  2. ingest dedup'ı kiracı filtresi olmadan aradığı için ikinci kiracının
     verisi birincinin satırının ÜZERİNE birleşiyordu (kiracılar arası yazma).

Migrasyon eski global UNIQUE indeksleri düşürüp yerine `(user_id, phone_e164)`
ve `(user_id, place_id)` üzerinde KISMİ benzersiz indeksler koyar.

Bu test, migrasyonu GERÇEK eski şemadan başlatır (ORM modelini değil, elle
yazılmış DDL) — çünkü ORM modeli zaten yeni indeksleri taşıyor ve migrasyonun
hiçbir şey yapmadığı bir dünyada da yeşil kalırdı.
"""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.migrations import ensure_tenant_scoped_lead_uniqueness

LEGACY_DDL = (
    "CREATE TABLE leads ("
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "  user_id VARCHAR(64),"
    "  phone_e164 VARCHAR(32),"
    "  place_id VARCHAR(128)"
    ")",
    "CREATE UNIQUE INDEX ix_leads_phone_e164 ON leads (phone_e164)",
    "CREATE UNIQUE INDEX ix_leads_place_id ON leads (place_id)",
)


async def _legacy_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        for ddl in LEGACY_DDL:
            await conn.execute(text(ddl))
    return engine


async def _indexes(engine):
    async with engine.connect() as conn:
        rows = (await conn.execute(text("PRAGMA index_list('leads')"))).fetchall()
    # PRAGMA index_list: (seq, name, unique, origin, partial)
    return {r[1]: {"unique": bool(r[2]), "partial": bool(r[4])} for r in rows}


async def _insert(engine, user_id, phone_e164, place_id):
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO leads (user_id, phone_e164, place_id) "
                "VALUES (:u, :p, :pl)"
            ),
            {"u": user_id, "p": phone_e164, "pl": place_id},
        )


@pytest.mark.asyncio
async def test_migration_swaps_global_unique_for_per_tenant_partial():
    engine = await _legacy_engine()
    try:
        before = await _indexes(engine)
        assert before["ix_leads_phone_e164"]["unique"] is True
        assert before["ix_leads_place_id"]["unique"] is True

        await ensure_tenant_scoped_lead_uniqueness(engine)

        after = await _indexes(engine)
        # Eski global benzersizlik GİTTİ, tek-kolon indeksleri kaldı (unique değil).
        assert after["ix_leads_phone_e164"]["unique"] is False
        assert after["ix_leads_place_id"]["unique"] is False
        # Yeni kısmi benzersiz indeksler geldi.
        assert after["uq_lead_user_phone"]["unique"] is True
        assert after["uq_lead_user_phone"]["partial"] is True
        assert after["uq_lead_user_place"]["unique"] is True
        assert after["uq_lead_user_place"]["partial"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_two_tenants_may_share_a_phone_after_migration():
    engine = await _legacy_engine()
    try:
        await ensure_tenant_scoped_lead_uniqueness(engine)

        await _insert(engine, "tenant-a", "+905551112233", "place-a")
        await _insert(engine, "tenant-b", "+905551112233", "place-b")

        async with engine.connect() as conn:
            n = (await conn.execute(text("SELECT COUNT(*) FROM leads"))).scalar()
        assert n == 2
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_same_tenant_duplicate_phone_still_rejected():
    engine = await _legacy_engine()
    try:
        await ensure_tenant_scoped_lead_uniqueness(engine)
        await _insert(engine, "tenant-a", "+905551112233", "place-a")

        with pytest.raises(IntegrityError):
            await _insert(engine, "tenant-a", "+905551112233", "place-other")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_null_phone_never_collides():
    """Kısmi indeks: `WHERE phone_e164 IS NOT NULL` — telefonsuz kayıtlar serbest."""
    engine = await _legacy_engine()
    try:
        await ensure_tenant_scoped_lead_uniqueness(engine)
        await _insert(engine, "tenant-a", None, "place-1")
        await _insert(engine, "tenant-a", None, "place-2")

        async with engine.connect() as conn:
            n = (await conn.execute(text("SELECT COUNT(*) FROM leads"))).scalar()
        assert n == 2
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_migration_is_idempotent():
    engine = await _legacy_engine()
    try:
        await ensure_tenant_scoped_lead_uniqueness(engine)
        await ensure_tenant_scoped_lead_uniqueness(engine)

        after = await _indexes(engine)
        assert after["uq_lead_user_phone"]["unique"] is True
        assert after["ix_leads_phone_e164"]["unique"] is False
    finally:
        await engine.dispose()
