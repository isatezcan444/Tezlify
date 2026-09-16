"""
Tests for lead-loss prevention during ingestion ("147 buldu, 130 kaydetti" fix).

Regression scenario: repeated scans of the same area merged discovered
businesses into pre-existing DB rows — sometimes WRONGLY, collapsing distinct
businesses that merely share a phone line (franchise 0850 hotlines, building
lines). Chain branches with identical brand names were also suppressed at
discovery time even when sitting at different addresses.

Covers:
- LeadMatchPolicy decision matrix (PLACE_ID / PHONE / NAME_LOCATION / no-match)
- Anti-collapsing guard: shared phone across distinct place_ids never merges
- Chain branches: same name + different address → both kept at discovery time
- Ingest funnel transparency (matched_by breakdown, skipped_no_name)
"""
import pytest
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.lead import Lead
from backend.app.scrapers.google_maps_scraper import (
    DedupDecision,
    GoogleMapsScraper,
    LeadDiscoveryDeduplicator,
)
from backend.app.services.lead_ingest_service import LeadIngestService
from backend.app.services.lead_match_policy import LeadMatchPolicy, MatchBasis


async def get_in_memory_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


# ============================================================
# LeadMatchPolicy: the identity decision matrix
# ============================================================

class TestLeadMatchPolicy:

    async def _seed(self, db, **overrides):
        lead = Lead(
            name=overrides.get("name", "Mega Dent Ataşehir"),
            city=overrides.get("city", "İstanbul"),
            district=overrides.get("district", "Ataşehir"),
            phone=overrides.get("phone", "+902162223344"),
            phone_e164=overrides.get("phone_e164", "+902162223344"),
            place_id=overrides.get("place_id", "gmaps_megadent_ata"),
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)
        return lead

    @pytest.mark.asyncio
    async def test_same_place_id_matches(self):
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            await self._seed(db)

            verdict = await LeadMatchPolicy().resolve(
                db, {"place_id": "gmaps_megadent_ata"}, "Mega Dent Ataşehir", None
            )
            assert verdict.existing is not None
            assert verdict.basis == MatchBasis.PLACE_ID
        await engine.dispose()

    @pytest.mark.asyncio
    async def test_phone_match_with_agreeing_place_merges(self):
        """Existing row lacks place_id → phone match is trustworthy."""
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            await self._seed(db, place_id=None)

            verdict = await LeadMatchPolicy().resolve(
                db, {"place_id": "gmaps_new_id"}, "Mega Dent Ataşehir", "+902162223344"
            )
            assert verdict.basis == MatchBasis.PHONE
        await engine.dispose()

    @pytest.mark.asyncio
    async def test_shared_phone_across_distinct_places_never_merges(self):
        """
        THE regression: franchise hotline 0850 shared by unrelated businesses.
        The second business must NOT be absorbed into the first row.
        """
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            await self._seed(db, phone_e164="+9008501234567")

            verdict = await LeadMatchPolicy().resolve(
                db,
                {"place_id": "gmaps_other_branch", "city": "İstanbul", "district": "Kadıköy"},
                "Farklı İşletme Kadıköy",
                "+9008501234567",
            )
            assert verdict.existing is None
            assert verdict.shares_phone_line is True
        await engine.dispose()

    @pytest.mark.asyncio
    async def test_name_location_triple_matches(self):
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            await self._seed(db, phone_e164=None, phone="Belirtilmemiş", place_id=None)

            verdict = await LeadMatchPolicy().resolve(
                db,
                {"place_id": "gmaps_fresh", "city": "İstanbul", "district": "Ataşehir"},
                "Mega Dent Ataşehir",
                None,
            )
            assert verdict.basis == MatchBasis.NAME_LOCATION
        await engine.dispose()

    @pytest.mark.asyncio
    async def test_unknown_business_matches_nothing(self):
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            await self._seed(db)

            verdict = await LeadMatchPolicy().resolve(
                db,
                {"place_id": "gmaps_brand_new", "city": "İstanbul", "district": "Ümraniye"},
                "Marka Bağımsız Klinik",
                "+905329998877",
            )
            assert verdict.existing is None
            assert verdict.basis is None
            assert verdict.shares_phone_line is False
        await engine.dispose()


# ============================================================
# Ingest end-to-end: distinct businesses stay distinct rows
# ============================================================

class TestIngestKeepsSharedLineBusinesses:

    @pytest.mark.asyncio
    async def test_two_businesses_sharing_hotline_get_two_rows(self):
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            raw_first = {
                "name": "Dent Group Merkez",
                "phone": "0850 123 45 67",
                "city": "İstanbul",
                "district": "Ataşehir",
                "place_id": "gmaps_hq",
            }
            raw_second = {
                "name": "Bağımsız Klinik Şubesi",
                "phone": "0850 123 45 67",  # same call-center line
                "city": "İstanbul",
                "district": "Kadıköy",
                "place_id": "gmaps_branch_b",
            }

            leads_1, new_1, upd_1 = await LeadIngestService.ingest_leads(db, [raw_first])
            leads_2, new_2, upd_2 = await LeadIngestService.ingest_leads(db, [raw_second])

            assert (new_1, upd_1) == (1, 0)
            assert (new_2, upd_2) == (1, 0)  # previously collapsed into leads_1!

            total = len((await db.execute(
                __import__("sqlalchemy").select(Lead)
            )).scalars().all())
            assert total == 2

            second_row = leads_2[0]
            # Distinct business keeps its own row; targeting number withheld.
            assert second_row.phone_e164 is None
            assert second_row.phone != "Belirtilmemiş"
        await engine.dispose()

    @pytest.mark.asyncio
    async def test_rescan_of_same_place_merges_once_not_duplicated(self):
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            raw = [{
                "name": "Ataşehir Diş Kliniği",
                "phone": "05321112233",
                "city": "İstanbul",
                "district": "Ataşehir",
                "place_id": "gmaps_ata_01",
            }]
            await LeadIngestService.ingest_leads(db, raw)
            _, new_c, upd_c = await LeadIngestService.ingest_leads(db, raw)

            assert new_c == 0
            assert upd_c == 1
        await engine.dispose()

    @pytest.mark.asyncio
    async def test_nameless_candidate_skipped_without_breaking_batch(self):
        maker, engine = await get_in_memory_db()
        async with maker() as db:
            raw = [
                {"name": "", "phone": "05321112233", "city": "İstanbul", "district": "Ataşehir"},
                {"name": "Geçerli Klinik", "phone": None, "city": "İstanbul", "district": "Ataşehir"},
            ]
            leads, new_c, _ = await LeadIngestService.ingest_leads(db, raw)
            assert new_c == 1
            assert leads[0].name == "Geçerli Klinik"
        await engine.dispose()


# ============================================================
# Discovery-side chain branch preservation
# ============================================================

class TestChainBranchDedup:

    def test_same_name_different_address_kept_as_distinct(self):
        dedup = LeadDiscoveryDeduplicator()
        dedup.register("url-hq", "mega dent_atasehir", None, address_key="barbaros mah")
        decision = dedup.evaluate("url-branch2", "mega dent_atasehir", None, address_key="palladium avm")
        assert decision == DedupDecision.ACCEPT

    def test_same_name_same_address_still_suppressed(self):
        dedup = LeadDiscoveryDeduplicator()
        dedup.register("url-1", "klinik x_atasehir", None, address_key="ataturk cad")
        decision = dedup.evaluate("url-2", "klinik x_atasehir", None, address_key="ataturk cad")
        assert decision == DedupDecision.DUPLICATE_NAME

    def test_missing_address_falls_back_to_name_only_policy(self):
        dedup = LeadDiscoveryDeduplicator()
        dedup.register("url-1", "klinik y_atasehir", None, address_key=None)
        decision = dedup.evaluate("url-2", "klinik y_atasehir", None, address_key="herhangi sokak")
        assert decision == DedupDecision.DUPLICATE_NAME

    def test_build_address_key_normalizes_and_takes_first_segment(self):
        key = LeadDiscoveryDeduplicator.build_address_key("Barbaros Mah., Ataşehir, İstanbul")
        assert key == "barbaros mah"


@pytest.mark.asyncio
async def test_orchestrator_keeps_chain_branches_both_saved():
    """Two 'Mega Dent' branches in one district at different addresses → two leads."""
    scraper = GoogleMapsScraper()
    dedup = LeadDiscoveryDeduplicator()

    record_a, decision_a = await scraper._process_discovered_place(
        place={
            "name": "Mega Dent",
            "address": "Barbaros Mah. Ihlamur Sokak No:9, Ataşehir, İstanbul",
            "google_maps_url": "https://maps.google.com/place/mega-a",
            "phone": "0216 111 22 33",
        },
        requested_district="Ataşehir",
        proven_district="Ataşehir",
        clean_city="İstanbul",
        clean_keyword="diş klinikleri",
        deduplicator=dedup,
    )
    record_b, decision_b = await scraper._process_discovered_place(
        place={
            "name": "Mega Dent",
            "address": "Palladium AVM Kat:3, Ataşehir, İstanbul",
            "google_maps_url": "https://maps.google.com/place/mega-b",
            "phone": "0216 444 55 66",
        },
        requested_district="Ataşehir",
        proven_district="Ataşehir",
        clean_city="İstanbul",
        clean_keyword="diş klinikleri",
        deduplicator=dedup,
    )

    assert decision_a == DedupDecision.ACCEPT and record_a is not None
    assert decision_b == DedupDecision.ACCEPT and record_b is not None


@pytest.mark.asyncio
async def test_scrape_reports_explicit_suppression_funnel():
    """Metrics account for every suppressed candidate — no silent gaps."""
    from unittest.mock import AsyncMock

    scraper = GoogleMapsScraper()
    captured_events = []

    async def capture(event):
        captured_events.append(event)

    same_place = {
        "name": "Tekrar Eden Klinik",
        "address": "Ataşehir, İstanbul",
        "phone": None,
        # Real engines always attach a Google category; without it the
        # relevance gate (correctly) treats a bare "Klinik" as unproven.
        "category": "Diş Kliniği",
        "google_maps_url": "https://maps.google.com/place/dup",
    }

    async def fake_scrape_district(keyword, city, district, max_results, on_place_inspected, on_progress_status):
        for idx in range(3):
            await on_place_inspected(dict(same_place), idx + 1, 3)

    scraper.playwright_scraper.scrape_district_places = AsyncMock(
        side_effect=fake_scrape_district
    )

    await scraper.scrape(
        keyword="Diş Kliniği", city="İstanbul", districts=["Ataşehir"],
        max_results=0, progress_callback=capture,
    )

    completed = next(e for e in captured_events if e["type"] == "completed")
    metrics = completed["metrics"]
    # The same physical place is inspected once per query variant; every repeat
    # is suppressed by place identity and the funnel accounts for ALL of them.
    raw = metrics["raw_results_found"]
    assert raw >= 3                       # at least one inspection per variant
    assert metrics["unique_candidates"] == 1
    assert metrics["geo_filtered_out"] == 0
    assert metrics["duplicate_merged"] == raw - 1
    assert metrics["duplicates_by_place"] == raw - 1
    assert raw == (
        metrics["unique_candidates"]
        + metrics["duplicate_merged"]
        + metrics["geo_filtered_out"]
    )


# ============================================================
# Legacy-duplicate fail-safe (prod job 19: "Multiple rows were found...")
# ============================================================

class TestLegacyDuplicateFailSafe:
    """Production database holds duplicate rows predating the hardened unique
    constraints. Identity resolution must merge into the oldest row instead of
    raising MultipleResultsFound and failing the whole scrape job."""

    async def _seed_legacy_dupes(self, db):
        first = Lead(
            name="Legacy Klinik", city="İstanbul", district="Ataşehir",
            phone="Belirtilmemiş", phone_e164=None, place_id=None,
        )
        second = Lead(
            name="Legacy Klinik", city="İstanbul", district="Ataşehir",
            phone="Belirtilmemiş", phone_e164=None, place_id=None,
        )
        db.add_all([first, second])
        await db.commit()
        await db.refresh(first)
        await db.refresh(second)
        return first, second

    @pytest.mark.asyncio
    async def test_resolve_merges_into_oldest_on_name_location_dupes(self):
        maker, engine = await get_in_memory_db()
        try:
            async with maker() as db:
                first, _ = await self._seed_legacy_dupes(db)
                verdict = await LeadMatchPolicy().resolve(
                    db,
                    {"name": "Legacy Klinik", "city": "İstanbul",
                     "district": "Ataşehir", "place_id": None},
                    "Legacy Klinik",
                    None,
                )
                assert verdict.existing is not None
                assert verdict.existing.id == first.id
                assert verdict.basis == MatchBasis.NAME_LOCATION
        finally:
            await engine.dispose()

    @pytest.mark.asyncio
    async def test_ingest_completes_over_legacy_dupes(self):
        maker, engine = await get_in_memory_db()
        try:
            async with maker() as db:
                await self._seed_legacy_dupes(db)
                raw = [{
                    "name": "Legacy Klinik", "city": "İstanbul",
                    "district": "Ataşehir", "place_id": None,
                    "phone": None, "phone_e164": None,
                    "address": "Ataşehir, İstanbul",
                }]
                leads, new_count, updated_count = await LeadIngestService.ingest_leads(
                    db=db, raw_leads=raw, source="GOOGLE_MAPS",
                    search_keyword="Diş Kliniği",
                    search_location="İstanbul Ataşehir",
                )
                assert len(leads) == 1
                assert new_count == 0
                assert updated_count == 1
        finally:
            await engine.dispose()


# ============================================================
# resolve() vs resolve_from_caches() equivalence
# ============================================================

class TestResolveCachesEquivalence:
    """The batched fast path must reach byte-identical verdicts to the
    DB-backed cascade across all rules (incl. shared-line + legacy dupes)."""

    async def _seed(self, db):
        rows = [
            Lead(name="Klinik P", city="İstanbul", district="Ataşehir",
                 phone="+902161111111", phone_e164="+902161111111",
                 place_id="gmaps_eq_place"),
            Lead(name="Santral", city="İstanbul", district="Kadıköy",
                 phone="08500000000", phone_e164="+908500000000",
                 place_id="gmaps_eq_other_place"),
            Lead(name="Klinik N", city="İstanbul", district="Ataşehir",
                 phone="Belirtilmemiş", phone_e164=None, place_id=None),
        ]
        db.add_all(rows)
        await db.commit()
        for r in rows:
            await db.refresh(r)
        return rows

    def _caches(self, rows):
        place = {r.place_id: r for r in rows if r.place_id}
        phone = {r.phone_e164: r for r in rows if r.phone_e164}
        nameloc = {(r.name, r.city, r.district): r for r in rows}
        def find(kind, key):
            return {"place": place, "phone": phone, "nameloc": nameloc}[kind].get(key)
        return find

    @staticmethod
    def _sig(v):
        return (v.existing.id if v.existing else None, v.basis, v.shares_phone_line)

    @pytest.mark.asyncio
    async def test_verdicts_match_across_rules(self):
        maker, engine = await get_in_memory_db()
        try:
            async with maker() as db:
                rows = await self._seed(db)
                find = self._caches(rows)
                policy = LeadMatchPolicy()
                cases = [
                    ({"place_id": "gmaps_eq_place"}, "Klinik P", "+902161111111"),
                    ({"place_id": "gmaps_eq_place"}, "Klinik P", None),
                    ({"place_id": "gmaps_eq_new"}, "Yeni", "+902161111111"),
                    ({"place_id": "gmaps_eq_new2"}, "Baska", "+908500000000"),
                    ({"city": "İstanbul", "district": "Ataşehir"}, "Klinik N", None),
                    ({"city": "İstanbul", "district": "Yok"}, "Kimse", None),
                ]
                for raw, name, e164 in cases:
                    db_verdict = await policy.resolve(db, raw, name, e164)
                    cache_verdict = policy.resolve_from_caches(raw, name, e164, find)
                    assert self._sig(cache_verdict) == self._sig(db_verdict), (raw, name, e164)
        finally:
            await engine.dispose()


@pytest.mark.asyncio
async def test_category_gate_filters_before_dedup_accounting(monkeypatch):
    """A category-less generic 'Klinik' carries no dental proof and must be
    filtered by the relevance gate (counted, never silently kept)."""
    from unittest.mock import AsyncMock
    from backend.app.scrapers.google_maps_scraper import GoogleMapsScraper

    scraper = GoogleMapsScraper()
    captured: list = []

    async def capture(event):
        captured.append(event)

    no_evidence = {
        "name": "Tekrar Eden Klinik",
        "address": "Ataşehir, İstanbul",
        "phone": None,
        "google_maps_url": "https://maps.google.com/place/dup2",
    }

    async def fake_scrape(keyword, city, district, max_results, on_place_inspected, on_progress_status):
        await on_place_inspected(dict(no_evidence), 1, 1)

    scraper.playwright_scraper.scrape_district_places = AsyncMock(side_effect=fake_scrape)
    monkeypatch.setattr(
        "backend.app.scrapers.google_maps_scraper.QueryExpander.build_search_terms",
        classmethod(lambda cls, kw, max_terms=3: ["Diş Kliniği"]),
    )
    leads = await scraper.scrape(
        keyword="Diş Kliniği", city="İstanbul", districts=["Ataşehir"],
        max_results=0, progress_callback=capture,
    )

    assert leads == []
    completed = next(e for e in captured if e.get("type") == "completed")
    assert completed["metrics"]["category_filtered_out"] == 1
    assert completed["metrics"]["raw_results_found"] == 1
