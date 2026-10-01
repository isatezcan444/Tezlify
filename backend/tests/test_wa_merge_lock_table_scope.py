"""`_ensure_merge_lock_table` hazır-işareti VERİTABANI başına olmalı.

Bağlam (2026-10-01). Birleştirme kilidi (`wa_merge_locks`) bir ORM modeli
DEĞİLDİR; tablo çalışma anında `CREATE TABLE IF NOT EXISTS` ile kurulur ve
süreç başına bir kez kurulduğu bir küme ile işaretlenir. İşaret yalnızca
LEHÇEYE göre anahtarlanıyordu (`"sqlite"` / `"postgresql"`).

Tek bir süreçte birden fazla sqlite veritabanı koşar (test paketi her kapı için
ayrı bir dosya açar). Bu yüzden tabloyu ilk kuran veritabanı DİĞERLERİNİ de
"hazır" işaretliyor, `CREATE TABLE` tam da gereken yerde atlanıyordu. Ölçülen
sonuç: taze provision edilmiş bir veritabanında 13 kapı
`no such table: wa_merge_locks` ile düşüyordu.

Asıl tehlike hata mesajı değildi: kilit ALINMAMIŞ sayılıyordu, yani bu tablonun
önlemek için var olduğu çapraz süreç birleştirme yarışı sessizce geri
geliyordu. Üretimde tek veritabanı olduğu için görünmüyordu.

Bu dosya o özelliği çiviler: İKİ AYRI veritabanı, İKİSİ de tabloya sahip olmalı.
"""
import shutil
import tempfile

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.services.whatsapp.reconciliation import _ensure_merge_lock_table


async def _engine_for(directory: str):
    engine = create_async_engine(f"sqlite+aiosqlite:///{directory}/lock.db")
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.asyncio
async def test_lock_table_exists_in_every_database_not_once_per_dialect():
    """İkinci veritabanı da tabloya sahip olmalı — önbellek onu atlamamalı.

    Düzeltmeden ÖNCE bu test düşer: ikinci çağrı önbellekten `True` döner,
    DDL hiç çalışmaz ve aşağıdaki SELECT `no such table` ile patlar.
    """
    dirs = [
        tempfile.mkdtemp(prefix="tezlify-lock-a-"),
        tempfile.mkdtemp(prefix="tezlify-lock-b-"),
    ]
    engines = []
    try:
        for directory in dirs:
            engine, sessions = await _engine_for(directory)
            engines.append(engine)
            async with sessions() as db:
                assert await _ensure_merge_lock_table(db, postgres=False) is True
                # Tablo BU veritabanında gerçekten var mı? Önbellek "hazır"
                # dese bile tek kanıt budur.
                await db.execute(text("SELECT 1 FROM wa_merge_locks LIMIT 1"))
    finally:
        for engine in engines:
            await engine.dispose()
        for directory in dirs:
            shutil.rmtree(directory, ignore_errors=True)


@pytest.mark.asyncio
async def test_lease_row_can_actually_be_written_in_a_fresh_database():
    """Kilidin GERÇEKTEN alınabilmesi: tablo yoksa kilit sessizce alınmaz."""
    directory = tempfile.mkdtemp(prefix="tezlify-lock-c-")
    engine = None
    try:
        engine, sessions = await _engine_for(directory)
        async with sessions() as db:
            assert await _ensure_merge_lock_table(db, postgres=False) is True
            await db.execute(
                text(
                    "INSERT INTO wa_merge_locks (lock_key, holder, expires_at) "
                    "VALUES ('k', 'holder', '2099-01-01 00:00:00')"
                )
            )
            await db.commit()
            stored = await db.scalar(text("SELECT COUNT(*) FROM wa_merge_locks"))
            assert stored == 1
    finally:
        if engine is not None:
            await engine.dispose()
        shutil.rmtree(directory, ignore_errors=True)
