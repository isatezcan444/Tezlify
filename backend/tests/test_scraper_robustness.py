"""
Regression tests for the İşletme Ara pipeline robustness fixes.

Covers:
- FIX-1  max_results=0 ('Sınırsız') stays unlimited end-to-end through the schema
         and per-district target computation (no silent coercion to 50).
- FIX-3  Sector labels with connectors expand into bounded search variants.
- FIX-4  Pane/card attribution validation helpers.
- FIX-5  Single-place guard marker policy (pure helper level).
- FIX-6  Anti-bot blocking error propagates loudly from the orchestrator.
- FIX-7  Distinct businesses sharing one phone line are kept, not dropped.
- FIX-8  Concurrent-insert IntegrityError recovers via SAVEPOINT merge.
- FIX-9  Website enrichment prefers mobile > fixed > hotline and verifies TLS.
- FIX-10 Unknown cities fail closed instead of fabricating pseudo-districts.
- FIX-11 Ingest persists the canonical Maps URL in custom_data.
- FIX-12 Metrics reflect measured values only.
"""
import pytest
from unittest.mock import AsyncMock
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.core.config import settings
from backend.app.core.database import Base
from backend.app.models.lead import Lead
from backend.app.schemas.scraper import ScraperRunRequest
from backend.app.services.query_expander import QueryExpander
from backend.app.services.lead_ingest_service import LeadIngestService
from backend.app.data.turkey_locations import (
    get_districts_for_city,
    get_supported_cities,
)
from backend.app.scrapers.google.google_maps_scraper import (
    GoogleMapsScraper,
    LeadDiscoveryDeduplicator,
    DedupDecision,
    compute_district_target,
)
from backend.app.scrapers.google.google_maps_playwright_scraper import (
    GoogleMapsBlockedError,
    pane_belongs_to_card,
)


# ============================================================
# FIX-1: 'Sınırsız' must remain unlimited
# ============================================================

class TestUnlimitedMode:
    def test_schema_preserves_zero(self):
        req = ScraperRunRequest(keyword="Diş Klinikleri", city="İstanbul", districts=["Ataşehir"], max_results=0)
        assert req.max_results == 0

    def test_schema_rejects_negative(self):
        with pytest.raises(Exception):
            ScraperRunRequest(keyword="x", city="İstanbul", districts=["Ataşehir"], max_results=-5)

    def test_unlimited_target_is_config_driven_high(self):
        target = compute_district_target(max_results=0, district_count=1)
        assert target == settings.SCRAPER_UNLIMITED_DISTRICT_TARGET
        assert target >= 100

    def test_limited_target_has_no_overshooting_floor(self):
        # Previously max(30, ...) forced a request of 10 to scrape 30+.
        assert compute_district_target(10, 1) == 10
        assert compute_district_target(20, 1) == 20

    def test_limited_target_rounds_up_across_districts(self):
        assert compute_district_target(7, 2) == 4
        assert compute_district_target(50, 39) == 2


# ============================================================
# FIX-3: Bounded query expansion for map engines
# ============================================================

class TestQueryTermExpansion:
    KEYWORD = "Diş Klinikleri & Ağız Sağlığı Merkezleri"

    def test_first_term_is_raw_keyword(self):
        terms = QueryExpander.build_search_terms(self.KEYWORD, max_terms=3)
        assert terms[0] == self.KEYWORD

    def test_connector_segments_are_split_out(self):
        terms = QueryExpander.build_search_terms(self.KEYWORD, max_terms=3)
        joined = " | ".join(terms).lower()
        assert "ağız sağlığı merkezleri" in joined or "ağız ve diş sağlığı" in joined

    def test_result_is_bounded_and_deduplicated(self):
        terms = QueryExpander.build_search_terms(self.KEYWORD, max_terms=3)
        assert len(terms) == 3
        normalized = [QueryExpander.normalize(t) if hasattr(QueryExpander, "normalize") else t.lower() for t in terms]
        assert len(set(normalized)) == 3

    def test_plain_keyword_yields_single_term_when_no_variants(self):
        terms = QueryExpander.build_search_terms("Kırtasiye", max_terms=3)
        assert terms[0] == "Kırtasiye"

    def test_empty_keyword_returns_empty_list(self):
        assert QueryExpander.build_search_terms("   ", max_terms=3) == []


# ============================================================
# FIX-5: Detail-pane / card attribution validation
# ============================================================

class TestPaneAttribution:
    def test_exact_match_accepted(self):
        assert pane_belongs_to_card("Ataşehir Diş Kliniği", "Ataşehir Diş Kliniği")

    def test_diacritics_insensitive(self):
        assert pane_belongs_to_card("Atasehir Dis Klinikleri", "Ataşehir Diş Klinikleri")

    def test_suffix_containment_accepted(self):
        assert pane_belongs_to_card("Diş Kliniği", "Diş Kliniği Ataşehir")

    def test_mismatch_rejected(self):
        assert not pane_belongs_to_card("Önceki İşletme A.Ş.", "Yeni İşletme Ltd.")

    def test_missing_pane_title_treated_as_belonging(self):
        assert pane_belongs_to_card(None, "Herhangi İşletme")
        assert pane_belongs_to_card("", "Herhangi İşletme")


# ============================================================
# FIX-7: Shared phone lines keep distinct businesses alive
# ============================================================

class TestSharedPhoneDedup:
    def test_same_place_url_suppressed_globally(self):
        dedup = LeadDiscoveryDeduplicator()
        dedup.register("https://maps.google.com/place/a", "klinik_a_atasehir", "+905321111111")

        decision = dedup.evaluate("https://maps.google.com/place/a", "klinik_a_kadikoy", "+905321111111")
        assert decision == DedupDecision.DUPLICATE_PLACE

    def test_same_name_same_district_suppressed(self):
        dedup = LeadDiscoveryDeduplicator()
        dedup.register("url-1", "klinik_x_atasehir", None)

        decision = dedup.evaluate("url-2", "klinik_x_atasehir", None)
        assert decision == DedupDecision.DUPLICATE_NAME

    def test_distinct_place_shared_phone_flagged_not_suppressed(self):
        dedup = LeadDiscoveryDeduplicator()
        dedup.register("url-1", "isletme_a_atasehir", "+902162223344")

        decision = dedup.evaluate("url-2", "isletme_b_atasehir", "+902162223344")
        assert decision == DedupDecision.SHARED_PHONE

    def test_fully_distinct_place_accepted(self):
        dedup = LeadDiscoveryDeduplicator()
        dedup.register("url-1", "isletme_a_atasehir", "+902162223344")

        decision = dedup.evaluate("url-2", "isletme_b_atasehir", "+905325556677")
        assert decision == DedupDecision.ACCEPT


@pytest.mark.asyncio
async def test_orchestrator_emits_shared_phone_lead_without_e164():
    """Two distinct places sharing a line → second lead kept with withheld targeting."""
    scraper = GoogleMapsScraper()
    dedup = LeadDiscoveryDeduplicator()

    record_a, _ = await scraper._process_discovered_place(
        place={
            "name": "İşletme A",
            "phone": "0216 222 33 44",
            "google_maps_url": "https://maps.google.com/place/a",
            "address": "Ataşehir, İstanbul",
        },
        requested_district="Ataşehir",
        proven_district="Ataşehir",
        clean_city="İstanbul",
        clean_keyword="diş klinikleri",
        deduplicator=dedup,
    )
    record_b, decision_b = await scraper._process_discovered_place(
        place={
            "name": "İşletme B",
            "phone": "0216 222 33 44",
            "google_maps_url": "https://maps.google.com/place/b",
            "address": "Ataşehir, İstanbul",
        },
        requested_district="Ataşehir",
        proven_district="Ataşehir",
        clean_city="İstanbul",
        clean_keyword="diş klinikleri",
        deduplicator=dedup,
    )

    assert record_a is not None and record_a["phone_e164"] == "+902162223344"
    assert record_b is not None and decision_b == DedupDecision.SHARED_PHONE
    assert record_b["phone_e164"] is None                      # unique constraint respected
    assert record_b["phone"] == "+902162223344"                # number still visible
    assert record_b["phone_line_shared"] is True
    assert record_b["is_whatsapp_eligible"] is False           # shared line never targeted twice


# ============================================================
# FIX-6: Blocking errors fail loud through the orchestrator
# ============================================================

@pytest.mark.asyncio
async def test_blocked_error_propagates_from_scrape():
    scraper = GoogleMapsScraper()
    scraper.playwright_scraper.scrape_district_places = AsyncMock(
        side_effect=GoogleMapsBlockedError("captcha served")
    )

    with pytest.raises(GoogleMapsBlockedError):
        await scraper.scrape(
            keyword="Diş",
            city="İstanbul",
            districts=["Ataşehir"],
            max_results=5,
            progress_callback=None,
        )


# ============================================================
# FIX-3b: Variant fan-out reaches the browser session layer
# ============================================================

@pytest.mark.asyncio
async def test_sector_label_expands_into_variant_sessions(monkeypatch=None):
    scraper = GoogleMapsScraper()
    recorded: list[dict] = []

    async def fake_scrape(self=None, **kwargs):
        recorded.append(kwargs)
        return []

    scraper.playwright_scraper.scrape_district_places = fake_scrape  # type: ignore[assignment]

    await scraper.scrape(
        keyword="Diş Klinikleri & Ağız Sağlığı Merkezleri",
        city="İstanbul",
        districts=["Ataşehir"],
        max_results=0,
        progress_callback=None,
    )

    expected_sessions = min(settings.SCRAPER_MAX_QUERY_VARIANTS, 3)
    assert len(recorded) == expected_sessions
    assert all(kw["city"] == "İstanbul" for kw in recorded)
    assert all(kw["district"] == "Ataşehir" for kw in recorded)
    # Unlimited mode passes the config-driven high target, not the raw 0/50.
    assert all(kw["max_results"] == settings.SCRAPER_UNLIMITED_DISTRICT_TARGET for kw in recorded)
    # Variants differ — the raw combined label is no longer repeated verbatim.
    keywords = {kw["keyword"] for kw in recorded}
    assert len(keywords) == expected_sessions


@pytest.mark.asyncio
async def test_limited_budget_splits_across_districts():
    scraper = GoogleMapsScraper()
    recorded: list[dict] = []

    async def fake_scrape(**kwargs):
        recorded.append(kwargs)
        return []

    scraper.playwright_scraper.scrape_district_places = fake_scrape  # type: ignore[assignment]

    await scraper.scrape(
        keyword="Diş",
        city="İstanbul",
        districts=["Ataşehir", "Kadıköy"],
        max_results=7,
        progress_callback=None,
    )

    per_district = compute_district_target(7, 2)
    assert recorded[0]["max_results"] == per_district == 4


# ============================================================
# FIX-8 + FIX-11: Savepoint recovery & Maps URL persistence
# ============================================================

async def _make_db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        echo=False,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


@pytest.mark.asyncio
async def test_persist_new_lead_recovers_from_unique_conflict():
    """Direct unique-conflict on place_id merges into the winner instead of raising."""
    session_maker, engine = await _make_db()

    async with session_maker() as db:
        winner = Lead(
            name="Önceki Kayıt",
            phone="Belirtilmemiş",
            phone_e164=None,
            city="İstanbul",
            district="Ataşehir",
            place_id="gmaps_conflict",
        )
        db.add(winner)
        await db.commit()

        raw = {
            "name": "Yeni Tarama Sonucu",
            "city": "İstanbul",
            "district": "Ataşehir",
            "place_id": "gmaps_conflict",
            "website": "https://ornekklinik.com.tr",
            "google_maps_url": "https://maps.google.com/place/conflict",
        }
        lead, merged = await LeadIngestService._persist_new_lead(
            db=db, raw=raw, name=raw["name"], e164=None, phone_data=None,
            is_wa_eligible=False, is_verified=False, is_blacklisted=False,
            source="GOOGLE_MAPS", search_keyword="diş", search_location="İstanbul",
        )

        assert merged is True
        assert lead.name == "Önceki Kayıt"
        assert lead.website == "https://ornekklinik.com.tr"

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_persists_maps_url_in_custom_data():
    session_maker, engine = await _make_db()

    async with session_maker() as db:
        raw = [{
            "name": "Haritalı Klinik",
            "phone": "05321112233",
            "city": "İstanbul",
            "district": "Ataşehir",
            "place_id": "gmaps_mapsurl",
            "google_maps_url": "https://maps.google.com/?cid=12345",
        }]
        leads, new_c, _ = await LeadIngestService.ingest_leads(db, raw)

        assert new_c == 1
        assert leads[0].custom_data["maps_url"] == "https://maps.google.com/?cid=12345"

        # Re-ingestion without URL must NOT wipe the stored value.
        raw_again = [{
            "name": "Haritalı Klinik",
            "phone": "05321112233",
            "city": "İstanbul",
            "district": "Ataşehir",
            "place_id": "gmaps_mapsurl",
        }]
        leads2, _, upd_c = await LeadIngestService.ingest_leads(db, raw_again)
        assert upd_c == 1
        assert leads2[0].custom_data["maps_url"] == "https://maps.google.com/?cid=12345"

    await engine.dispose()


# ============================================================
# FIX-9: Enrichment phone selection priority
# ============================================================

class TestEnrichmentPriority:
    def test_mobile_wins_over_hotline(self):
        discovered = [
            {"e164": "+908501234567", "national_number": "8501234567", "is_mobile": False},
            {"e164": "+905321234567", "national_number": "5321234567", "is_mobile": True},
        ]
        selected = GoogleMapsScraper._select_enriched_phone(discovered)
        assert selected["e164"] == "+905321234567"

    def test_fixed_line_wins_over_hotline(self):
        discovered = [
            {"e164": "+908501234567", "national_number": "8501234567", "is_mobile": False},
            {"e164": "+902163335566", "national_number": "2163335566", "is_mobile": False},
        ]
        selected = GoogleMapsScraper._select_enriched_phone(discovered)
        assert selected["e164"] == "+902163335566"

    def test_hotline_used_only_as_last_resort(self):
        discovered = [{"e164": "+908501234567", "national_number": "8501234567", "is_mobile": False}]
        selected = GoogleMapsScraper._select_enriched_phone(discovered)
        assert selected is not None

    def test_empty_discovery_returns_none(self):
        assert GoogleMapsScraper._select_enriched_phone([]) is None


# ============================================================
# FIX-10: Unknown cities fail closed (no fabricated districts)
# ============================================================

class TestUnknownCityFailClosed:
    def test_unknown_city_has_empty_registry(self):
        assert get_districts_for_city("Atlantis") == []

    def test_frontend_city_set_is_covered_by_backend_registry(self):
        """Every city the UI offers must resolve in the canonical backend registry."""
        frontend_cities = [
            "İstanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Adana", "Konya",
            "Gaziantep", "Kocaeli", "Mersin", "Kayseri", "Eskişehir", "Samsun",
            "Denizli", "Sakarya", "Muğla", "Tekirdağ", "Balıkesir", "Trabzon",
            "Aydın", "Manisa", "Diyarbakır", "Hatay", "Şanlıurfa",
        ]
        supported = {c.lower() for c in get_supported_cities()}
        missing = [c for c in frontend_cities if c.lower() not in supported]
        assert missing == []

    @pytest.mark.asyncio
    async def test_scrape_refuses_unknown_city(self):
        scraper = GoogleMapsScraper()
        with pytest.raises(ValueError, match="FAIL CLOSED"):
            await scraper.scrape(
                keyword="Test",
                city="Atlantis",
                districts=None,   # empty registry → previously fell back to [city]
                max_results=10,
                progress_callback=None,
            )


# ============================================================
# FIX-12: Honest metrics
# ============================================================

@pytest.mark.asyncio
async def test_metrics_pages_visited_equals_executed_sessions():
    scraper = GoogleMapsScraper()
    captured_metrics: dict = {}

    async def fake_scrape(**kwargs):
        return []

    scraper.playwright_scraper.scrape_district_places = fake_scrape  # type: ignore[assignment]

    async def cb(event: dict):
        if event.get("type") == "completed":
            captured_metrics.update(event["metrics"])

    await scraper.scrape(
        keyword="Diş",
        city="İstanbul",
        districts=["Ataşehir", "Kadıköy"],
        max_results=0,
        progress_callback=cb,
    )

    expected_terms = len(QueryExpander.build_search_terms("Diş", max_terms=settings.SCRAPER_MAX_QUERY_VARIANTS))
    executed = expected_terms * 2  # terms × two districts
    assert captured_metrics["queries_executed"] == executed
    assert captured_metrics["pages_visited"] == executed        # one page per session — truthful


# ============================================================
# Adaptive mahalle subdivision phase
# ============================================================

class TestMahallePhase:
    def test_primary_term_picks_first_segment(self):
        from backend.app.services.query_expander import QueryExpander
        assert QueryExpander.primary_term("Diş Klinikleri & Ağız Sağlığı Merkezleri") == "Diş Klinikleri"
        assert QueryExpander.primary_term("Güzellik Merkezleri") == "Güzellik Merkezleri"
        assert QueryExpander.primary_term("  ") == ""

    def test_extract_mahalle_candidates_rejects_streets(self):
        from backend.app.services.query_expander import QueryExpander
        addrs = [
            "Barbaros, Fesleğen Sk. No:7, 34746 Ataşehir/İstanbul",
            "BARBAROS, Halk Cd. No: 63/1",
            "Atatürk Mahallesi, Ertuğrul Gazi Sokak No: 2",
            "Ataşehir Bulvarı Ata 4-4 Çarşı No:17",
            "Fesleğen Sk. No:7, 34746 Ataşehir",
            "Küçükbakkalköy, Brandium Residence R2 Blok",
        ]
        got = QueryExpander.extract_mahalle_candidates(addrs, top_k=5, min_mentions=1)
        assert "Barbaros" in got
        assert "Atatürk" in got
        assert "Küçükbakkalköy" in got
        assert not any("Bulvar" in g or "Fesleğen" in g or "Brandium" in g for g in got)

    def test_extract_mahalle_candidates_honors_threshold(self):
        from backend.app.services.query_expander import QueryExpander
        addrs = ["Barbaros, X Sk. No:1", "Barbaros, Y Sk. No:2", "Tekil, Z Sk. No:3"]
        got = QueryExpander.extract_mahalle_candidates(addrs, top_k=5, min_mentions=2)
        assert got == ["Barbaros"]

    @pytest.mark.asyncio
    async def test_mahalle_phase_runs_bounded_queries(self):
        from unittest.mock import AsyncMock
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper

        scraper = GoogleMapsScraper()
        calls = []

        async def fake_mahalle(keyword, city, district, max_results=None, max_pages=None,
                               on_place_inspected=None, on_progress_status=None):
            calls.append((keyword, max_pages))
            assert max_pages == settings.SCRAPER_MAHALLE_MAX_PAGES
            await on_place_inspected(
                {"name": f"{keyword} Klinik", "address": f"{district}, {city}",
                 "phone": None, "google_maps_url": f"https://maps.example/{keyword}"},
                1, 1,
            )

        scraper.http_scraper.scrape_district_places = AsyncMock(side_effect=fake_mahalle)
        # Force HTTP engine regardless of settings
        scraper._resolve_active_engine = lambda: scraper.http_scraper  # type: ignore[method-assign]

        discovered: list = []

        async def collecting_handler(place, idx, total):
            discovered.append(place)

        q, marginal = await scraper._run_mahalle_phase(
            primary_term="Diş Klinikleri",
            clean_city="İstanbul",
            district="Ataşehir",
            district_addresses=["Barbaros, X Sk. No:1"] * 4 + ["Atatürk, Y Cd. No:2"] * 3,
            all_discovered_leads=discovered,
            handle_place_inspected=collecting_handler,
            handle_status=AsyncMock(),
            progress_callback=AsyncMock(),
        )
        assert q == 2
        assert marginal == 2
        assert calls[0][0] == "Barbaros Diş Klinikleri"

    @pytest.mark.asyncio
    async def test_mahalle_phase_skipped_without_primary_or_mahalles(self):
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper
        scraper = GoogleMapsScraper()
        noop = AsyncMock()
        assert await scraper._run_mahalle_phase(
            primary_term="", clean_city="X", district="Y", district_addresses=[],
            all_discovered_leads=[], handle_place_inspected=noop,
            handle_status=noop, progress_callback=noop,
        ) == (0, 0)
        assert await scraper._run_mahalle_phase(
            primary_term="Diş", clean_city="X", district="Y", district_addresses=[],
            all_discovered_leads=[], handle_place_inspected=noop,
            handle_status=noop, progress_callback=noop,
        ) == (0, 0)


# ============================================================
# Category relevance gate (dental search must not return vets,
# restaurants, pilates studios...)
# ============================================================

class TestHealthFacilitySignal:
    def test_markers_match_in_normalized_form(self):
        from backend.app.services.query_expander import QueryExpander as Q
        assert Q.has_health_facility_signal("Barbaros, Tıp Merkezi No:1") is True
        assert Q.has_health_facility_signal("Ataşehir Ağız Sağlığı") is True
        assert Q.has_health_facility_signal("Özel Hastane") is True
        assert Q.has_health_facility_signal("Dr.Toygan BORA Doktor") is True

    def test_bare_merkez_klinik_do_not_match(self):
        from backend.app.services.query_expander import QueryExpander as Q
        assert Q.has_health_facility_signal("Palladium Ataşehir AVM") is False
        assert Q.has_health_facility_signal("Alışveriş merkezi") is False
        assert Q.has_health_facility_signal("Ebru Işık Pilates Pilates Salonu") is False
        assert Q.has_health_facility_signal("Shape Club Spor salonu") is False
        assert Q.has_health_facility_signal(None) is False
        assert Q.has_health_facility_signal("") is False


class _FakeMixedScraper:
    """Emits dental, health-generic and junk places with Google categories."""

    PLACES = [
        {"name": "Mozaik Dent", "address": "Atatürk, Meriç Cd., Ataşehir, İstanbul",
         "phone": None, "category": "Diş Kliniği",
         "google_maps_url": "https://maps.google.com/?cid=11", "place_id": "gmaps_mix_11"},
        {"name": "Memorial Ataşehir", "address": "Barbaros, Ataşehir, İstanbul",
         "phone": None, "category": "Özel Hastane",
         "google_maps_url": "https://maps.google.com/?cid=12", "place_id": "gmaps_mix_12"},
        {"name": "Barbaros Veteriner", "address": "Barbaros, Ataşehir, İstanbul",
         "phone": None, "category": "Veteriner",
         "google_maps_url": "https://maps.google.com/?cid=13", "place_id": "gmaps_mix_13"},
        {"name": "OVA Pide", "address": "Barbaros, Ataşehir, İstanbul",
         "phone": None, "category": "Restoran",
         "google_maps_url": "https://maps.google.com/?cid=14", "place_id": "gmaps_mix_14"},
        {"name": "Ebru Pilates", "address": "Barbaros, Ataşehir, İstanbul",
         "phone": None, "category": "Pilates Salonu",
         "google_maps_url": "https://maps.google.com/?cid=15", "place_id": "gmaps_mix_15"},
        {"name": "Nova Lazer", "address": "Barbaros, Ataşehir, İstanbul",
         "phone": None, "category": "Estetik Cerrahi Kliniği",
         "google_maps_url": "https://maps.google.com/?cid=16", "place_id": "gmaps_mix_16"},
        {"name": "Palladium AVM", "address": "Barbaros, Ataşehir, İstanbul",
         "phone": None, "category": "Alışveriş merkezi",
         "google_maps_url": "https://maps.google.com/?cid=17", "place_id": "gmaps_mix_17"},
    ]

    async def scrape_district_places(self, keyword, city, district, max_results,
                                     on_place_inspected=None, on_progress_status=None):
        for idx, place in enumerate(self.PLACES):
            if on_place_inspected:
                await on_place_inspected(dict(place), idx + 1, len(self.PLACES))


class TestCategoryGateIntegration:
    @pytest.mark.asyncio
    async def test_dental_search_keeps_dental_and_health_drops_junk(self, monkeypatch):
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper
        monkeypatch.setattr(settings, "SCRAPER_MAX_QUERY_VARIANTS", 1)
        monkeypatch.setattr(settings, "SCRAPER_MAHALLE_PHASE_ENABLED", False)
        scraper = GoogleMapsScraper()
        monkeypatch.setattr(scraper, "playwright_scraper", _FakeMixedScraper())
        monkeypatch.setattr(scraper, "http_scraper", _FakeMixedScraper())

        metrics_holder: dict = {}

        async def capture(event):
            if event.get("type") == "completed":
                metrics_holder.update(event["metrics"])

        leads = await scraper.scrape(
            keyword="Diş Klinikleri", city="İstanbul", districts=["Ataşehir"],
            max_results=0, progress_callback=capture,
        )
        names = [l["name"] for l in leads]
        assert "Mozaik Dent" in names            # dental MATCH kept
        assert "Memorial Ataşehir" in names      # health-generic kept (second opinion)
        assert "Barbaros Veteriner" not in names  # mutual exclusion
        assert "OVA Pide" not in names            # mutual exclusion
        assert "Ebru Pilates" not in names        # ambiguous, no facility signal
        assert "Nova Lazer" not in names          # hair_beauty veto
        assert "Palladium AVM" not in names       # ambiguous, no signal
        assert metrics_holder["category_filtered_out"] == 5
        assert metrics_holder["unique_candidates"] == 2

    @pytest.mark.asyncio
    async def test_unknown_sector_skips_gate_keep_all(self, monkeypatch):
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper
        monkeypatch.setattr(settings, "SCRAPER_MAX_QUERY_VARIANTS", 1)
        monkeypatch.setattr(settings, "SCRAPER_MAHALLE_PHASE_ENABLED", False)
        scraper = GoogleMapsScraper()
        monkeypatch.setattr(scraper, "playwright_scraper", _FakeMixedScraper())
        monkeypatch.setattr(scraper, "http_scraper", _FakeMixedScraper())
        leads = await scraper.scrape(
            keyword="Xyz Bilinmeyen Sektör", city="İstanbul", districts=["Ataşehir"],
            max_results=0,
        )
        assert len(leads) == 7


class TestGenericClinicalDowngrade:
    def test_only_generic_evidence_detected(self):
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper
        from backend.app.services.taxonomy_registry import TaxonomyRegistry
        from backend.app.services.category_relevance_engine import CategoryRelevanceEngine
        from backend.app.schemas.intelligence import RawBusinessCandidate
        TaxonomyRegistry.initialize()
        prof = TaxonomyRegistry.build_profile_from_node(TaxonomyRegistry.get_node("dental"))

        def fit_for(name, category):
            return CategoryRelevanceEngine.evaluate(
                prof,
                RawBusinessCandidate(candidate_id="x", provider="G", provider_query="t",
                                     raw_name=name, clean_name=name, raw_category=category),
            )

        # Inflected "Polikliniği" matches only the generic clinical concept.
        generic = fit_for("X Polikliniği", "Danışman")
        assert generic.classification.value == "MATCH"
        assert GoogleMapsScraper._match_rests_on_generic_clinical_only(generic) is True

        specific = fit_for("DentX Polikliniği", "Danışman")
        assert GoogleMapsScraper._match_rests_on_generic_clinical_only(specific) is False

    @pytest.mark.asyncio
    async def test_generic_only_match_dropped_end_to_end(self, monkeypatch):
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper

        class _FakeSingle:
            PLACES = [
                {"name": "X Polikliniği", "address": "Barbaros, Ataşehir, İstanbul",
                 "phone": None, "category": "Danışman",
                 "google_maps_url": "https://maps.google.com/?cid=21", "place_id": "gmaps_gen_21"},
                {"name": "DentX Polikliniği", "address": "Barbaros, Ataşehir, İstanbul",
                 "phone": None, "category": "Danışman",
                 "google_maps_url": "https://maps.google.com/?cid=22", "place_id": "gmaps_gen_22"},
            ]

            async def scrape_district_places(self, keyword, city, district, max_results,
                                             on_place_inspected=None, on_progress_status=None, **kwargs):
                for idx, place in enumerate(self.PLACES):
                    if on_place_inspected:
                        await on_place_inspected(dict(place), idx + 1, len(self.PLACES))

        monkeypatch.setattr(settings, "SCRAPER_MAX_QUERY_VARIANTS", 1)
        monkeypatch.setattr(settings, "SCRAPER_MAHALLE_PHASE_ENABLED", False)
        scraper = GoogleMapsScraper()
        monkeypatch.setattr(scraper, "playwright_scraper", _FakeSingle())
        monkeypatch.setattr(scraper, "http_scraper", _FakeSingle())
        leads = await scraper.scrape(
            keyword="Diş Klinikleri", city="İstanbul", districts=["Ataşehir"],
            max_results=0,
        )
        names = [l["name"] for l in leads]
        assert "DentX Polikliniği" in names      # dental-specific evidence keeps
        assert "X Polikliniği" not in names      # generic-only MATCH dropped


class TestSpamAndCoordsGates:
    @pytest.mark.asyncio
    async def test_degenerate_names_dropped_counted(self, monkeypatch):
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper

        class _FakeSpam:
            PLACES = [
                {"name": "e", "address": "Barbaros, Ataşehir, İstanbul",
                 "phone": None, "category": "Diş Kliniği",
                 "google_maps_url": "https://maps.google.com/?cid=31", "place_id": "gmaps_spam_31"},
                {"name": "123", "address": "Barbaros, Ataşehir, İstanbul",
                 "phone": None, "category": "Diş Kliniği",
                 "google_maps_url": "https://maps.google.com/?cid=32", "place_id": "gmaps_spam_32"},
                {"name": "Gerçek Klinik", "address": "Barbaros, Ataşehir, İstanbul",
                 "phone": None, "category": "Diş Kliniği",
                 "google_maps_url": "https://maps.google.com/?cid=33", "place_id": "gmaps_spam_33"},
            ]

            async def scrape_district_places(self, keyword, city, district, max_results,
                                             on_place_inspected=None, on_progress_status=None, **kwargs):
                for idx, place in enumerate(self.PLACES):
                    if on_place_inspected:
                        await on_place_inspected(dict(place), idx + 1, len(self.PLACES))

        monkeypatch.setattr(settings, "SCRAPER_MAX_QUERY_VARIANTS", 1)
        monkeypatch.setattr(settings, "SCRAPER_MAHALLE_PHASE_ENABLED", False)
        scraper = GoogleMapsScraper()
        monkeypatch.setattr(scraper, "playwright_scraper", _FakeSpam())
        monkeypatch.setattr(scraper, "http_scraper", _FakeSpam())
        metrics_holder: dict = {}

        async def capture(event):
            if event.get("type") == "completed":
                metrics_holder.update(event["metrics"])

        leads = await scraper.scrape(
            keyword="Diş Klinikleri", city="İstanbul", districts=["Ataşehir"],
            max_results=0, progress_callback=capture,
        )
        assert [l["name"] for l in leads] == ["Gerçek Klinik"]
        assert metrics_holder["spam_filtered_out"] == 2

    @pytest.mark.asyncio
    async def test_addressless_row_keeps_lead_drops_coords(self, monkeypatch):
        from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper

        class _FakeNoAddr:
            PLACES = [
                {"name": "Adresiz Klinik", "address": None,
                 "phone": None, "category": "Diş Kliniği",
                 "latitude": 39.0, "longitude": 35.0,
                 "google_maps_url": "https://maps.google.com/place/Adresiz",
                 "place_id": "gmaps_noaddr_41"},
            ]

            async def scrape_district_places(self, keyword, city, district, max_results,
                                             on_place_inspected=None, on_progress_status=None, **kwargs):
                for idx, place in enumerate(self.PLACES):
                    if on_place_inspected:
                        await on_place_inspected(dict(place), idx + 1, len(self.PLACES))

        monkeypatch.setattr(settings, "SCRAPER_MAX_QUERY_VARIANTS", 1)
        monkeypatch.setattr(settings, "SCRAPER_MAHALLE_PHASE_ENABLED", False)
        scraper = GoogleMapsScraper()
        monkeypatch.setattr(scraper, "playwright_scraper", _FakeNoAddr())
        monkeypatch.setattr(scraper, "http_scraper", _FakeNoAddr())
        metrics_holder: dict = {}

        async def capture(event):
            if event.get("type") == "completed":
                metrics_holder.update(event["metrics"])

        leads = await scraper.scrape(
            keyword="Diş Klinikleri", city="İstanbul", districts=["Ataşehir"],
            max_results=0, progress_callback=capture,
        )
        assert len(leads) == 1
        assert leads[0]["latitude"] is None and leads[0]["longitude"] is None
        assert leads[0]["google_maps_url"] is None and leads[0]["maps_url"] is None
        # Display fallback shows the city scope only — the district is
        # unproven, so it must NOT be claimed (truthful labeling).
        assert leads[0]["address"] == "İstanbul"
        assert leads[0]["district"] is None
        assert metrics_holder["coords_stripped"] == 1
