import pytest
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.blacklist import Blacklist
from backend.app.services.lead_ingest_service import LeadIngestService


async def get_in_memory_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


@pytest.mark.asyncio
async def test_lead_ingest_creates_and_deduplicates():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        raw_data = [
            {
                "name": "Kadıköy Diş Kliniği",
                "category": "Diş Kliniği",
                "phone": "05321112233",
                "city": "İstanbul",
                "district": "Kadıköy",
                "place_id": "gmaps_kdk_01"
            },
            {
                "name": "Telefonsuz Butik",
                "category": "Giyim",
                "phone": None,
                "city": "İzmir",
                "district": "Konak",
                "place_id": "gmaps_konak_02"
            }
        ]

        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw_data)
        assert new_c == 2
        assert upd_c == 0
        assert len(leads) == 2

        # Verify first lead normalized phone
        assert leads[0].phone_e164 == "+905321112233"
        assert leads[0].is_whatsapp_eligible is True

        # Verify second lead with missing phone is NULL, NOT fake +90000 number!
        assert leads[1].phone_e164 is None
        assert leads[1].is_whatsapp_eligible is False

        # Second ingestion with same place_id should update, not create duplicate
        leads_2, new_c2, upd_c2 = await LeadIngestService.ingest_leads(db, raw_data)
        assert new_c2 == 0
        assert upd_c2 == 2

    await engine.dispose()


@pytest.mark.asyncio
async def test_lead_ingest_handles_blacklist():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        bl = Blacklist(phone_e164="+905329998877", reason="Opt-out test")
        db.add(bl)
        await db.commit()

        raw = [{
            "name": "Kara Liste Adayı",
            "phone": "+905329998877",
            "city": "Ankara",
            "district": "Çankaya"
        }]

        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)
        assert new_c == 1
        assert leads[0].status == LeadStatus.UNSUBSCRIBED

    await engine.dispose()


@pytest.mark.asyncio
async def test_merge_heals_name_prefixed_address():
    """Rows stored before the pd[18] prefix strip carry 'Name, street...'.
    A re-scrape touching the same business must normalize the stored
    address (pure prefix removal, no new content injected)."""
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        db.add(Lead(
            name="Mozaik Dent",
            city="İstanbul",
            district="Ataşehir",
            phone="Belirtilmemiş",
            phone_e164=None,
            place_id="gmaps_mozaik_01",
            address="Mozaik Dent, Atatürk, Meriç Cd. NO: 21/35",
        ))
        await db.commit()

        raw = [{
            "name": "Mozaik Dent",
            "city": "İstanbul",
            "district": "Ataşehir",
            "place_id": "gmaps_mozaik_01",
            "phone": None,
            "phone_e164": None,
            "address": "Atatürk, Meriç Cd. NO: 21/35",
        }]
        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)
        assert new_c == 0 and upd_c == 1
        assert leads[0].address == "Atatürk, Meriç Cd. NO: 21/35"
    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_progress_callback_reports_checkpoints():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        raw = [
            {"name": f"Klinik {i}", "city": "İstanbul", "district": "Ataşehir",
             "place_id": f"gmaps_prog_{i}", "phone": None, "phone_e164": None}
            for i in range(25)
        ]
        checkpoints = []
        async def on_progress(done, total):
            checkpoints.append((done, total))
        leads, new_c, upd_c = await LeadIngestService.ingest_leads(
            db, raw, progress_callback=on_progress
        )
        assert new_c == 25
        assert checkpoints[0] == (0, 25)
        assert (10, 25) in checkpoints
        assert (20, 25) in checkpoints
        assert checkpoints[-1] == (25, 25)
    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_batch_blacklist_prefetch_marks_unsubscribed():
    from backend.app.models.lead import LeadStatus
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        db.add(Blacklist(phone_e164="+905321112233", reason="USER_REQUEST"))
        await db.commit()
        raw = [
            {"name": "Engelli Klinik", "city": "İstanbul", "district": "Kadıköy",
             "place_id": "gmaps_bl_01", "phone": "05321112233"},
            {"name": "Temiz Klinik", "city": "İstanbul", "district": "Kadıköy",
             "place_id": "gmaps_bl_02", "phone": "05329998877"},
        ]
        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)
        assert new_c == 2
        by_name = {l.name: l for l in leads}
        assert by_name["Engelli Klinik"].status == LeadStatus.UNSUBSCRIBED
        assert by_name["Temiz Klinik"].status == LeadStatus.NEW
    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_statement_budget_stays_flat():
    """50 fresh leads must persist in a handful of round-trips (bulk insert),
    not ~7 statements per lead. Guards the database save latency fix."""
    from sqlalchemy import event as sa_event
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    counter = {"n": 0}

    @sa_event.listens_for(engine.sync_engine, "before_cursor_execute")
    def _count(conn, cursor, statement, params, context, executemany):
        counter["n"] += 1

    raw = [
        {"name": f"Budget Klinik {i}", "city": "İstanbul", "district": "Ataşehir",
         "place_id": f"gmaps_budget_{i}", "phone": f"0534{i:07d}", "phone_e164": f"+90534{i:07d}"}
        for i in range(30)
    ]
    async with maker() as db:
        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)
    await engine.dispose()
    assert new_c == 30 and len(leads) == 30
    assert counter["n"] <= 30, f"too many statements: {counter['n']}"


@pytest.mark.asyncio
async def test_ingest_same_batch_duplicates_converge():
    """Same-batch duplicates must fold onto one row (read-your-writes),
    and a distinct business on a shared line keeps its own phoneless row."""
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        raw = [
            {"name": "Batch A", "city": "İstanbul", "district": "Ataşehir",
             "place_id": "gmaps_batch_X", "phone": "05350000001", "phone_e164": "+905350000001"},
            {"name": "Batch A", "city": "İstanbul", "district": "Ataşehir",
             "place_id": "gmaps_batch_X", "phone": "05350000001", "phone_e164": "+905350000001",
             "website": "https://batcha.example"},
            {"name": "Batch C", "city": "İstanbul", "district": "Ataşehir",
             "place_id": "gmaps_batch_Y", "phone": "05350000001", "phone_e164": "+905350000001"},
        ]
        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)
        assert new_c == 2
        assert upd_c == 1
        assert len(leads) == 3
        # Folded website landed on the single Batch A row (same id twice —
        # one entry per raw, mirroring long-standing return semantics).
        a_rows = [l for l in leads if l.place_id == "gmaps_batch_X"]
        assert {l.id for l in a_rows} == {a_rows[0].id}
        assert a_rows[0].website == "https://batcha.example"
        # Shared line kept its display phone but no targeting e164
        c_rows = [l for l in leads if l.place_id == "gmaps_batch_Y"]
        assert len(c_rows) == 1
        assert c_rows[0].phone_e164 is None
        assert c_rows[0].phone == "05350000001"
    await engine.dispose()


@pytest.mark.asyncio
async def test_reingest_identical_batch_writes_nothing():
    """Identical re-save must not dirty any row (no UPDATE round-trips)."""
    from sqlalchemy import event as sa_event
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    raw = [
        {"name": f"Stable {i}", "city": "İ", "district": "A",
         "place_id": f"gmaps_stable_{i}", "phone": None, "phone_e164": None}
        for i in range(10)
    ]
    async with maker() as db:
        await LeadIngestService.ingest_leads(db, raw)
    counter = {"n": 0}

    @sa_event.listens_for(engine.sync_engine, "before_cursor_execute")
    def _count(conn, cursor, statement, params, context, executemany):
        counter["n"] += 1

    async with maker() as db:
        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)
    await engine.dispose()
    assert new_c == 0 and upd_c == 10
    assert counter["n"] <= 10, f"no-op re-ingest wrote too much: {counter['n']}"


@pytest.mark.asyncio
async def test_bulk_maps_shared_phone_sibling_rows_to_distinct_ids():
    """Same (name, city, district) + shared line across two place_ids must
    persist as TWO rows and map back to DISTINCT response ids (bulk
    correlation key includes phone_e164 + place_id, not just the triple)."""
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        raw = [
            {"name": "Franchise X", "city": "İstanbul", "district": "Ataşehir",
             "place_id": "gmaps_fran_A", "phone": "08500000011", "phone_e164": "+908500000011"},
            {"name": "Franchise X", "city": "İstanbul", "district": "Ataşehir",
             "place_id": "gmaps_fran_B", "phone": "08500000011", "phone_e164": "+908500000011"},
        ]
        leads, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)
        assert new_c == 2 and upd_c == 0
        by_place = {l.place_id: l for l in leads}
        assert set(by_place) == {"gmaps_fran_A", "gmaps_fran_B"}
        assert by_place["gmaps_fran_A"].id != by_place["gmaps_fran_B"].id
        assert all(l.id is not None for l in leads)
        # Second row kept display phone but no targeting number
        assert by_place["gmaps_fran_B"].phone_e164 is None
    await engine.dispose()
