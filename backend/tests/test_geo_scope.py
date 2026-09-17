"""
Tests for the Geographic Scope Filter pipeline ("İşletme Ara" district spillover fix).

Regression scenario: searching 'Diş Klinikleri & Ağız Sağlığı Merkezleri' with
city=İstanbul, district=Ataşehir must NOT ingest businesses located in
Ümraniye / Kartal / Kadıköy (Google Maps metro-area spillover).

Covers:
- GeoScopeFilter decision matrix (ACCEPT_TARGET / REJECT_OUTSIDE / ACCEPT_UNPROVEN)
- Truthful district relabeling (resolved district persisted, never fabricated)
- Keyword location-token hygiene (QueryExpander.strip_location_tokens)
- Pipeline integration: out-of-scope places rejected before phone enrichment
- Settings toggles (SCRAPER_GEO_FILTER_ENABLED / SCRAPER_REJECT_UNPROVEN_LOCATION)
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import pytest

from backend.app.services.geo_scope_filter import GeoScopeFilter, GeoScopeDecision
from backend.app.services.query_expander import QueryExpander
from backend.app.scrapers.google.google_maps_scraper import (
    GoogleMapsScraper,
    LeadDiscoveryDeduplicator,
    DedupDecision,
)


# ============================================================
# UNIT TESTS: GeoScopeFilter decision matrix (Ataşehir scope)
# ============================================================

class TestGeoScopeFilterDecisions:

    def setup_method(self):
        self.filter = GeoScopeFilter(reject_unproven=False)

    def test_exact_target_district_accepted(self):
        verdict = self.filter.evaluate(
            "İstanbul", ["Ataşehir"],
            "Ataşehir Diş Kliniği",
            "Barbaros Mah. Ihlamur Sok. No:12, Ataşehir, İstanbul",
        )
        assert verdict.decision == GeoScopeDecision.ACCEPT_TARGET
        assert verdict.resolved_district == "Ataşehir"

    def test_subdivision_match_resolves_district(self):
        # 'Küçükbakkalköy' is a neighborhood of Ataşehir (turkey_subdivisions data).
        verdict = self.filter.evaluate(
            "İstanbul", ["Ataşehir"],
            "Ağız ve Diş Sağlığı Merkezi",
            "Küçükbakkalköy Mahallesi, Ataşehir, İstanbul",
        )
        assert verdict.decision == GeoScopeDecision.ACCEPT_TARGET

    @pytest.mark.parametrize("neighborhood,address", [
        ("Ümraniye kliniği", "Yamanevler Mah., Ümraniye, İstanbul"),
        ("Kartal diş hekimi", "Karlıktepe Mah., Kartal, İstanbul"),
        ("Kadıköy dental", "Caferağa Mah., Kadıköy, İstanbul"),
    ])
    def test_neighboring_districts_rejected(self, neighborhood, address):
        """THE regression: Google Maps spillover into Ataşehir's neighbors must be rejected."""
        verdict = self.filter.evaluate("İstanbul", ["Ataşehir"], neighborhood, address)
        assert verdict.decision == GeoScopeDecision.REJECT_OUTSIDE
        assert verdict.resolved_district is None

    def test_unproven_address_kept_but_not_relabelled(self):
        verdict = self.filter.evaluate(
            "İstanbul", ["Ataşehir"],
            "Gül Dental Klinik",
            "Ihlamur Sokak No:8",  # no district evidence either way
        )
        assert verdict.decision == GeoScopeDecision.ACCEPT_UNPROVEN
        assert verdict.resolved_district is None  # must never fabricate a district

    def test_strict_mode_rejects_unproven(self):
        strict = GeoScopeFilter(reject_unproven=True)
        verdict = strict.evaluate(
            "İstanbul", ["Ataşehir"], "Gül Dental Klinik", "Ihlamur Sokak No:8"
        )
        assert verdict.decision == GeoScopeDecision.REJECT_OUTSIDE

    def test_multi_district_scope_accepts_any_target(self):
        verdict = self.filter.evaluate(
            "İstanbul", ["Ataşehir", "Kadıköy"],
            "Moda Diş", "Caferağa Mah., Moda Cad., Kadıköy, İstanbul",
        )
        assert verdict.decision == GeoScopeDecision.ACCEPT_TARGET
        assert verdict.resolved_district == "Kadıköy"


# ============================================================
# UNIT TESTS: Keyword location-token hygiene
# ============================================================

class TestKeywordLocationStripping:

    def test_full_pasted_search_string_is_cleaned(self):
        """User pastes keyword + city + district into one field."""
        cleaned = QueryExpander.strip_location_tokens(
            "Diş Klinikleri & Ağız Sağlığı Merkezleri + istanbul + ataşehir",
            "İstanbul", ["Ataşehir"],
        )
        assert "istanbul" not in cleaned.lower()
        assert "ataşehir" not in cleaned.lower()
        assert "Diş Klinikleri" in cleaned
        assert "Ağız Sağlığı Merkezleri" in cleaned

    def test_admin_suffix_variants_stripped(self):
        cleaned = QueryExpander.strip_location_tokens(
            "Diş Kliniği İstanbul İli Ataşehir İlçesi",
            "İstanbul", ["Ataşehir"],
        )
        assert cleaned.strip() == "Diş Kliniği"

    def test_sector_word_containing_district_name_survives(self):
        """Only whole tokens are removed — business terms stay intact."""
        cleaned = QueryExpander.strip_location_tokens(
            "Kadıköy'deki kafeler", "İstanbul", ["Kadıköy"],
        )
        assert "kafeler" in cleaned

    def test_no_location_tokens_returns_keyword_unchanged(self):
        original = "Diş Klinikleri & Ağız Sağlığı Merkezleri"
        cleaned = QueryExpander.strip_location_tokens(original, "İstanbul", ["Ataşehir"])
        assert cleaned == original

    def test_empty_inputs(self):
        assert QueryExpander.strip_location_tokens("", "İstanbul", ["Ataşehir"]) == ""
        assert QueryExpander.strip_location_tokens("   ", "", []) == ""


# ============================================================
# INTEGRATION TESTS: Pipeline geo fence + truthful relabeling
# ============================================================

class _FakePlaywrightScraper:
    """
    Test double that simulates Google Maps spillover: emits an Ataşehir clinic,
    two neighboring-district clinics (Ümraniye/Kadıköy) and one unproven place.
    Records whether enrichment was attempted per place.
    """

    PLACES = [
        {"name": "Ataşehir Ağız Sağlığı", "address": "Barbaros Mah., Ataşehir, İstanbul",
         "phone": "+90 216 455 00 00", "website": "https://atasehir-dis.example.com",
         "google_maps_url": "https://maps.google.com/?cid=1"},
        {"name": "Ümraniye Dental Clinic", "address": "Yamanevler Mah., Ümraniye, İstanbul",
         "phone": "+90 216 111 00 00", "website": None,
         "google_maps_url": "https://maps.google.com/?cid=2"},
        {"name": "Moda Diş Kliniği", "address": "Caferağa Mah., Kadıköy, İstanbul",
         "phone": "+90 216 222 00 00", "website": None,
         "google_maps_url": "https://maps.google.com/?cid=3"},
        {"name": "Bulut Dental", "address": "Ihlamur Sokak No:9",
         "phone": None, "website": None,
         "google_maps_url": "https://maps.google.com/?cid=4"},
    ]

    def __init__(self):
        self.enrichment_attempts: list = []

    async def scrape_district_places(self, keyword, city, district, max_results,
                                     on_place_inspected=None, on_progress_status=None):
        for idx, place in enumerate(self.PLACES):
            if on_progress_status:
                await on_progress_status(f"testing {idx}", 10)
            if on_place_inspected:
                await on_place_inspected(dict(place), idx + 1, len(self.PLACES))


def _make_scraper_with_fake(monkeypatch) -> GoogleMapsScraper:
    scraper = GoogleMapsScraper()
    fake = _FakePlaywrightScraper()
    monkeypatch.setattr(scraper, "playwright_scraper", fake)
    return scraper


class TestPipelineGeoFence:
    """End-to-end discovery run against a spilling results feed."""

    @pytest.mark.asyncio
    async def test_out_of_scope_places_never_ingested(self, monkeypatch):
        scraper = _make_scraper_with_fake(monkeypatch)
        leads = await scraper.scrape(
            keyword="Diş Klinikleri & Ağız Sağlığı Merkezleri",
            city="İstanbul",
            districts=["Ataşehir"],
            max_results=0,
        )

        names = [lead["name"] for lead in leads]
        assert "Ataşehir Ağız Sağlığı" in names          # proven target — kept
        assert "Ümraniye Dental Clinic" not in names     # neighbor — fenced out
        assert "Moda Diş Kliniği" not in names           # neighbor — fenced out
        assert all(lead["district"] == "Ataşehir" for lead in leads if lead["name"] == "Ataşehir Ağız Sağlığı")

    @pytest.mark.asyncio
    async def test_geo_filtered_metric_reported(self, monkeypatch):
        from backend.app.core.config import settings
        # Pin to ONE query variant so raw/rejected counts are deterministic.
        monkeypatch.setattr(settings, "SCRAPER_MAX_QUERY_VARIANTS", 1)
        scraper = _make_scraper_with_fake(monkeypatch)
        metrics_holder = {}

        async def capture(event):
            if event.get("type") == "completed":
                metrics_holder.update(event["metrics"])

        await scraper.scrape(
            keyword="Diş Kliniği", city="İstanbul", districts=["Ataşehir"],
            max_results=0, progress_callback=capture,
        )
        assert metrics_holder["geo_filtered_out"] == 2   # Ümraniye + Kadıköy
        assert metrics_holder["raw_results_found"] == 4

    @pytest.mark.asyncio
    async def test_rejection_happens_before_website_enrichment(self, monkeypatch):
        """Out-of-scope places must be dropped BEFORE any phone-enrichment HTTP work."""
        scraper = _make_scraper_with_fake(monkeypatch)
        enrichment_calls = []
        monkeypatch.setattr(
            scraper, "_enrich_phones_from_website",
            lambda url: enrichment_calls.append(url) or asyncio.sleep(0, result=[]),
        )
        await scraper.scrape(
            keyword="Diş Kliniği", city="İstanbul", districts=["Ataşehir"], max_results=0,
        )
        # Only the accepted Ataşehir place may reach enrichment.
        assert all("Ümraniye" not in (u or "") and "Kadıköy" not in (u or "") for u in enrichment_calls)

    @pytest.mark.asyncio
    async def test_geo_filter_disabled_restores_legacy_behavior(self, monkeypatch):
        from backend.app.core.config import settings
        monkeypatch.setattr(settings, "SCRAPER_GEO_FILTER_ENABLED", False)
        scraper = _make_scraper_with_fake(monkeypatch)
        leads = await scraper.scrape(
            keyword="Diş Kliniği", city="İstanbul", districts=["Ataşehir"], max_results=0,
        )
        # Legacy behavior: everything ingested, feed district stamped verbatim.
        assert len(leads) == 4

    @pytest.mark.asyncio
    async def test_lead_found_streamed_live_per_accepted_place(self, monkeypatch):
        """
        REGRESSION: each accepted place MUST emit a 'lead_found' progress event
        the moment it is inspected — the UI renders its live card on this event.
        (A refactor accidentally dropped the emission and cards stopped streaming.)
        """
        from backend.app.core.config import settings
        monkeypatch.setattr(settings, "SCRAPER_MAX_QUERY_VARIANTS", 1)
        scraper = _make_scraper_with_fake(monkeypatch)

        streamed: list = []

        async def capture(event):
            if event.get("type") == "lead_found":
                streamed.append(event["lead"])

        leads = await scraper.scrape(
            keyword="Diş Kliniği", city="İstanbul", districts=["Ataşehir"],
            max_results=0, progress_callback=capture,
        )
        # One live card per persisted lead (2 accepted: proven + unproven),
        # streamed in discovery order.
        assert [l["name"] for l in streamed] == [l["name"] for l in leads]
        assert len(streamed) == 2


# ============================================================
# UNIT TESTS: Truthful district labeling at record level
# ============================================================

class TestTruthfulDistrictLabeling:

    def _build(self, scraper, address):
        place = {"name": "Test Klinik", "address": address, "phone": None}
        return asyncio.run(
            scraper._process_discovered_place(
                place=place,
                requested_district="Ataşehir",
                proven_district="Ataşehir" if (address and "Ataşehir" in address) else None,
                clean_city="İstanbul",
                clean_keyword="diş kliniği",
                deduplicator=LeadDiscoveryDeduplicator(),
            )
        )

    def test_unproven_place_has_null_district(self):
        scraper = GoogleMapsScraper()
        result = self._build(scraper, "Ihlamur Sokak No:9")
        assert result is not None
        lead, decision = result
        assert lead["district"] is None
        assert decision == DedupDecision.ACCEPT

    def test_proven_place_keeps_verified_district(self):
        scraper = GoogleMapsScraper()
        result = self._build(scraper, "Barbaros Mah., Ataşehir, İstanbul")
        lead, _decision = result
        assert lead["district"] == "Ataşehir"

    def test_fallback_address_does_not_invent_district(self):
        scraper = GoogleMapsScraper()
        place = {"name": "No Address Klinik", "address": None, "phone": None}
        record = scraper._build_lead_record(
            place=place,
            proven_district=None,
            clean_city="İstanbul",
            clean_keyword="diş kliniği",
            phone_data=None,
            shared_phone_line=False,
        )
        assert record["district"] is None
        assert "Ataşehir" not in record["address"]
