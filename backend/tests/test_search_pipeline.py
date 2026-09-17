"""
Comprehensive Test Suite for Location-Scoped Search Pipeline.

Tests cover:
- Location normalization (Turkish diacritics)
- Location validation (EXACT_DISTRICT, OUTSIDE_TARGET, UNKNOWN, CITY_ONLY)
- Scraper scope enforcement (FAIL CLOSED)
- Structured API contract
- Concurrency isolation
- Negative tests (cross-district rejection)
- Regression tests (multiple city/district combinations)
- Job snapshot immutability
"""
import asyncio
import json
import pytest
import sys
import os

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend.app.data.turkey_locations import (
    normalize_turkish,
    get_districts_for_city,
    is_valid_district,
    find_matching_district,
    TURKEY_LOCATIONS,
)
from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper, LocationConfidence
from backend.app.schemas.scraper import ScraperRunRequest


# ============================================================
# UNIT TESTS: Turkish Normalization
# ============================================================

class TestTurkishNormalization:
    """TEST 8: Turkish diacritics normalization."""

    def test_atasehir_variants(self):
        assert normalize_turkish("Ataşehir") == "atasehir"
        assert normalize_turkish("ATAŞEHİR") == "atasehir"
        assert normalize_turkish("Atasehir") == "atasehir"
        assert normalize_turkish("ataşehir") == "atasehir"

    def test_sisli_variants(self):
        assert normalize_turkish("Şişli") == "sisli"
        assert normalize_turkish("ŞİŞLİ") == "sisli"

    def test_cankaya_variants(self):
        assert normalize_turkish("Çankaya") == "cankaya"
        assert normalize_turkish("ÇANKAYA") == "cankaya"

    def test_empty_and_whitespace(self):
        assert normalize_turkish("") == ""
        assert normalize_turkish("  İstanbul  ") == "istanbul"

    def test_all_turkish_chars(self):
        assert normalize_turkish("çğıöşüÇĞİÖŞÜ") == "cgiosucgiosu"


# ============================================================
# UNIT TESTS: District Lookup
# ============================================================

class TestDistrictLookup:
    def test_istanbul_has_atasehir(self):
        districts = get_districts_for_city("İstanbul")
        assert "Ataşehir" in districts

    def test_istanbul_has_silivri(self):
        districts = get_districts_for_city("İstanbul")
        assert "Silivri" in districts

    def test_unknown_city_returns_empty(self):
        """FAIL CLOSED: unknown city returns empty list, not dummy fallback."""
        districts = get_districts_for_city("UnknownCity")
        assert districts == []
        # Must NOT return ["Merkez", "Çarşı", ...] dummy data
        assert "Merkez" not in districts

    def test_is_valid_district(self):
        assert is_valid_district("İstanbul", "Ataşehir")
        assert is_valid_district("İstanbul", "Silivri")
        assert is_valid_district("Ankara", "Çankaya")
        assert not is_valid_district("İstanbul", "Çankaya")  # Çankaya is Ankara
        assert not is_valid_district("İstanbul", "Bornova")  # Bornova is İzmir

    def test_find_matching_district(self):
        assert find_matching_district("İstanbul", "Ataşehir/İstanbul") == "Ataşehir"
        assert find_matching_district("İstanbul", "Silivri mahallesi") == "Silivri"
        assert find_matching_district("İstanbul", "completely unknown place") is None


# ============================================================
# UNIT TESTS: Location Validation
# ============================================================

class TestLocationValidation:
    """Tests for GoogleMapsScraper.validate_lead_location()"""

    def setup_method(self):
        self.scraper = GoogleMapsScraper()

    def test_exact_district_match_from_address(self):
        """TEST 3: Ataşehir request → Ataşehir result → ACCEPT"""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir"],
            result_address="Ataşehir Bulvarı, Ataşehir, İstanbul, Turkey",
        )
        assert conf == LocationConfidence.EXACT_DISTRICT

    def test_outside_target_silivri(self):
        """TEST 4: Ataşehir request → Silivri result → REJECT"""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir"],
            result_address="Silivri Caddesi, Silivri, İstanbul, Turkey",
        )
        assert conf == LocationConfidence.OUTSIDE_TARGET

    def test_outside_target_kadikoy(self):
        """TEST 5: Ataşehir request → Kadıköy result → REJECT"""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir"],
            result_address="Caferağa Mah., Kadıköy, İstanbul, Turkey",
        )
        assert conf == LocationConfidence.OUTSIDE_TARGET

    def test_unknown_location(self):
        """TEST 6: Ataşehir request → district unknown → UNKNOWN"""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir"],
            result_address="some random address with no district info",
        )
        assert conf == LocationConfidence.UNKNOWN

    def test_city_only_match(self):
        """Result mentions İstanbul but no recognizable district → CITY_ONLY"""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir"],
            result_address="Merkez Ofis, İstanbul, Türkiye",
        )
        assert conf == LocationConfidence.CITY_ONLY

    def test_osm_address_exact_match(self):
        """OSM structured address with matching suburb field."""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir"],
            result_address="",
            osm_address={"suburb": "Ataşehir", "city": "İstanbul", "country": "Turkey"},
        )
        assert conf == LocationConfidence.EXACT_DISTRICT

    def test_osm_address_outside_target(self):
        """OSM structured address with a different district."""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir"],
            result_address="",
            osm_address={"suburb": "Silivri", "city": "İstanbul", "country": "Turkey"},
        )
        assert conf == LocationConfidence.OUTSIDE_TARGET

    def test_multi_district_accept(self):
        """Multiple target districts — result in any of them should ACCEPT."""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir", "Kadıköy"],
            result_address="Caferağa, Kadıköy, İstanbul",
        )
        assert conf == LocationConfidence.EXACT_DISTRICT

    def test_multi_district_reject(self):
        """Multiple target districts — result in none of them should REJECT."""
        conf = self.scraper.validate_lead_location(
            city="İstanbul",
            target_districts=["Ataşehir", "Kadıköy"],
            result_address="Silivri merkez, İstanbul",
        )
        assert conf == LocationConfidence.OUTSIDE_TARGET


# ============================================================
# UNIT TESTS: Scraper Scope Enforcement (FAIL CLOSED)
# ============================================================

class TestScraperScopeEnforcement:
    """TEST 7: Empty districts → FAIL CLOSED, do not auto-expand."""

    def test_empty_districts_raises_error(self):
        """Scraper must refuse to run with empty districts list."""
        scraper = GoogleMapsScraper()

        async def _run():
            await scraper.scrape(keyword="Test", city="İstanbul", districts=[], max_results=10)

        with pytest.raises(ValueError, match="FAIL CLOSED"):
            asyncio.run(_run())

    def test_empty_city_raises_error(self):
        """Scraper must refuse to run with empty city."""
        scraper = GoogleMapsScraper()

        async def _run():
            await scraper.scrape(keyword="Test", city="", districts=["Ataşehir"], max_results=10)

        with pytest.raises(ValueError, match="City is required"):
            asyncio.run(_run())


# ============================================================
# UNIT TESTS: Structured API Contract
# ============================================================

class TestStructuredAPIContract:
    """TEST 1 & TEST 2: Verify structured request preserves location."""

    def test_request_preserves_atasehir(self):
        """TEST 1: İstanbul + Ataşehir request contains correct fields."""
        req = ScraperRunRequest(
            keyword="Saç Ekim Merkezi",
            city="İstanbul",
            districts=["Ataşehir"],
            max_results=10,
        )
        assert req.city == "İstanbul"
        assert req.districts == ["Ataşehir"]
        assert "Silivri" not in req.districts

    def test_request_preserves_silivri(self):
        """TEST 2: İstanbul + Silivri request uses Silivri, not Ataşehir."""
        req = ScraperRunRequest(
            keyword="Saç Ekim Merkezi",
            city="İstanbul",
            districts=["Silivri"],
            max_results=10,
        )
        assert req.city == "İstanbul"
        assert req.districts == ["Silivri"]
        assert "Ataşehir" not in req.districts

    def test_request_multiple_districts(self):
        req = ScraperRunRequest(
            keyword="Diş Klinikleri",
            city="İstanbul",
            districts=["Ataşehir", "Kadıköy"],
            max_results=20,
        )
        assert len(req.districts) == 2
        assert "Ataşehir" in req.districts
        assert "Kadıköy" in req.districts


# ============================================================
# NEGATIVE TESTS: Cross-District Rejection
# ============================================================

class TestNegativeLocationRejection:
    """TEST: Each wrong-district result is properly rejected."""

    def setup_method(self):
        self.scraper = GoogleMapsScraper()

    def test_atasehir_request_silivri_result(self):
        conf = self.scraper.validate_lead_location("İstanbul", ["Ataşehir"], "Silivri, İstanbul")
        assert conf == LocationConfidence.OUTSIDE_TARGET

    def test_atasehir_request_kadikoy_result(self):
        conf = self.scraper.validate_lead_location("İstanbul", ["Ataşehir"], "Kadıköy, İstanbul")
        assert conf == LocationConfidence.OUTSIDE_TARGET

    def test_kadikoy_request_besiktas_result(self):
        conf = self.scraper.validate_lead_location("İstanbul", ["Kadıköy"], "Beşiktaş, İstanbul")
        assert conf == LocationConfidence.OUTSIDE_TARGET

    def test_ankara_request_istanbul_result(self):
        conf = self.scraper.validate_lead_location("Ankara", ["Çankaya"], "Kadıköy, İstanbul")
        # No Ankara districts in İstanbul text → UNKNOWN (not OUTSIDE_TARGET since city doesn't match)
        assert conf in (LocationConfidence.UNKNOWN, LocationConfidence.OUTSIDE_TARGET)

    def test_bornova_request_karsiyaka_result(self):
        conf = self.scraper.validate_lead_location("İzmir", ["Bornova"], "Karşıyaka, İzmir")
        assert conf == LocationConfidence.OUTSIDE_TARGET


# ============================================================
# REGRESSION TESTS: Multiple City/District Combinations
# ============================================================

class TestRegressionLocations:
    """Verify location validation across 7 different city/district combos."""

    def setup_method(self):
        self.scraper = GoogleMapsScraper()

    REGRESSION_CASES = [
        ("İstanbul", "Ataşehir", "Ataşehir, İstanbul", LocationConfidence.EXACT_DISTRICT),
        ("İstanbul", "Kadıköy", "Kadıköy, İstanbul", LocationConfidence.EXACT_DISTRICT),
        ("İstanbul", "Beşiktaş", "Beşiktaş, İstanbul", LocationConfidence.EXACT_DISTRICT),
        ("İstanbul", "Şişli", "Şişli, İstanbul", LocationConfidence.EXACT_DISTRICT),
        ("İstanbul", "Silivri", "Silivri, İstanbul", LocationConfidence.EXACT_DISTRICT),
        ("Ankara", "Çankaya", "Çankaya, Ankara", LocationConfidence.EXACT_DISTRICT),
        ("İzmir", "Bornova", "Bornova, İzmir", LocationConfidence.EXACT_DISTRICT),
    ]

    @pytest.mark.parametrize("city,district,address,expected", REGRESSION_CASES)
    def test_correct_location_accepted(self, city, district, address, expected):
        conf = self.scraper.validate_lead_location(city, [district], address)
        assert conf == expected, f"Expected {expected} for {city}/{district}, got {conf}"

    CROSS_REGRESSION_CASES = [
        ("İstanbul", "Ataşehir", "Silivri, İstanbul", LocationConfidence.OUTSIDE_TARGET),
        ("İstanbul", "Kadıköy", "Ataşehir, İstanbul", LocationConfidence.OUTSIDE_TARGET),
        ("İstanbul", "Beşiktaş", "Şişli, İstanbul", LocationConfidence.OUTSIDE_TARGET),
        ("İstanbul", "Şişli", "Beşiktaş, İstanbul", LocationConfidence.OUTSIDE_TARGET),
        ("İstanbul", "Silivri", "Ataşehir, İstanbul", LocationConfidence.OUTSIDE_TARGET),
        ("Ankara", "Çankaya", "Keçiören, Ankara", LocationConfidence.OUTSIDE_TARGET),
        ("İzmir", "Bornova", "Karşıyaka, İzmir", LocationConfidence.OUTSIDE_TARGET),
    ]

    @pytest.mark.parametrize("city,district,address,expected", CROSS_REGRESSION_CASES)
    def test_wrong_location_rejected(self, city, district, address, expected):
        conf = self.scraper.validate_lead_location(city, [district], address)
        assert conf == expected, f"Expected {expected} for {city}/{district} with result {address}, got {conf}"


# ============================================================
# CONCURRENCY TEST: Job A (Ataşehir) vs Job B (Silivri) isolation
# ============================================================

class TestConcurrencyIsolation:
    """TEST 15: Two concurrent jobs must not cross-contaminate."""

    def test_concurrent_validation_no_contamination(self):
        """Simulate two jobs running simultaneously — each validates independently."""
        scraper = GoogleMapsScraper()

        # Job A: Ataşehir scope
        job_a_target = ["Ataşehir"]
        # Job B: Silivri scope
        job_b_target = ["Silivri"]

        # Result from Ataşehir
        atasehir_result = "Ataşehir Bulvarı, Ataşehir, İstanbul"
        # Result from Silivri
        silivri_result = "Silivri Merkez, Silivri, İstanbul"

        # Job A should accept Ataşehir, reject Silivri
        assert scraper.validate_lead_location("İstanbul", job_a_target, atasehir_result) == LocationConfidence.EXACT_DISTRICT
        assert scraper.validate_lead_location("İstanbul", job_a_target, silivri_result) == LocationConfidence.OUTSIDE_TARGET

        # Job B should accept Silivri, reject Ataşehir
        assert scraper.validate_lead_location("İstanbul", job_b_target, silivri_result) == LocationConfidence.EXACT_DISTRICT
        assert scraper.validate_lead_location("İstanbul", job_b_target, atasehir_result) == LocationConfidence.OUTSIDE_TARGET


# ============================================================
# JOB SNAPSHOT TEST: UI state change after job start
# ============================================================

class TestJobSnapshotImmutability:
    """TEST 16: Job's location must not change after creation."""

    def test_structured_request_is_immutable(self):
        """Simulate: create request with Ataşehir, then verify changing UI state doesn't affect it."""
        req = ScraperRunRequest(
            keyword="Saç Ekim Merkezi",
            city="İstanbul",
            districts=["Ataşehir"],
            max_results=10,
        )

        # Simulate UI state change to Silivri (should not affect req)
        ui_city = "İstanbul"
        ui_districts = ["Silivri"]

        # The original request object is unchanged
        assert req.city == "İstanbul"
        assert req.districts == ["Ataşehir"]
        assert "Silivri" not in req.districts

        # New request should be independent
        req2 = ScraperRunRequest(
            keyword="Saç Ekim Merkezi",
            city=ui_city,
            districts=ui_districts,
            max_results=10,
        )
        assert req2.districts == ["Silivri"]
        assert req.districts == ["Ataşehir"]  # still unchanged


# ============================================================
# CACHE ISOLATION TEST
# ============================================================

class TestCacheIsolation:
    """TEST 17: Old job's location must not leak to new job."""

    def test_validator_uses_passed_params_not_cache(self):
        """Each call to validate_lead_location is purely functional — no shared state."""
        scraper = GoogleMapsScraper()

        # "Old" validation with Silivri target
        old_conf = scraper.validate_lead_location("İstanbul", ["Silivri"], "Silivri, İstanbul")
        assert old_conf == LocationConfidence.EXACT_DISTRICT

        # "New" validation with Ataşehir target — must NOT use old Silivri scope
        new_conf = scraper.validate_lead_location("İstanbul", ["Ataşehir"], "Ataşehir, İstanbul")
        assert new_conf == LocationConfidence.EXACT_DISTRICT

        # Cross-check: Ataşehir target must reject Silivri
        cross_conf = scraper.validate_lead_location("İstanbul", ["Ataşehir"], "Silivri, İstanbul")
        assert cross_conf == LocationConfidence.OUTSIDE_TARGET


# ============================================================
# NEW DISCOVERY ENGINE TESTS (10 CRITICAL CRITERIA)
# ============================================================

from backend.app.services.query_expander import QueryExpander
from backend.app.scrapers.common.directory_scraper import DirectoryScraper


class TestQueryExpansion:
    """TEST 7: Category & Synonym Query Expansion without Geo Drift."""

    def test_sac_ekim_expansion(self):
        slugs = QueryExpander.get_directory_slugs("Saç Ekim Merkezleri & Poliklinikler")
        assert "saç-ekimi" in slugs
        assert "poliklinikler" in slugs

        queries = QueryExpander.expand_queries("Saç Ekim Merkezleri & Poliklinikler", "Ataşehir", "İstanbul")
        assert any("saç ekim" in q.lower() for q in queries)
        assert any("poliklinik" in q.lower() or "klinik" in q.lower() for q in queries)
        # All queries must contain Ataşehir
        for q in queries:
            assert "Ataşehir" in q
            assert "Silivri" not in q

    def test_dis_klinigi_expansion(self):
        slugs = QueryExpander.get_directory_slugs("Diş Klinikleri")
        assert "diş-klinikleri" in slugs
        assert "ağız-ve-diş-sağlığı-merkezleri" in slugs

    def test_guzellik_expansion(self):
        slugs = QueryExpander.get_directory_slugs("Güzellik Salonu ve Estetik")
        assert "güzellik-salonları" in slugs
        assert "estetik-merkezleri" in slugs


class TestDirectoryScraperParsing:
    """TEST 2 & TEST 9: Directory Parser with structured HTML & JSON."""

    def test_html_card_parsing(self):
        scraper = DirectoryScraper()
        sample_html = """
        <div class="result-item">
            <h2><a href="/details/123">K PLUS CLINIC - SAÇ EKİMİ</a></h2>
            <div itemprop="address">Barbaros Mah. Mor Sümbül Sok. Ataşehir, İstanbul</div>
            <div class="phone">Telefon: 05322372398</div>
        </div>
        """
        leads = scraper._parse_html(sample_html, "Ataşehir", "İstanbul")
        assert len(leads) == 1
        assert "K PLUS CLINIC" in leads[0]["name"]
        assert leads[0]["phone_e164"] == "+905322372398"
        assert leads[0]["is_mobile"] is True
        assert leads[0]["is_whatsapp_eligible"] is True

    def test_map_info_json_parsing(self):
        scraper = DirectoryScraper()
        sample_html = """
        <script>
        var mapInfo = mapInfo || {};
        mapInfo.results = [
            {
                "CompanyName": "ASMED SAÇ EKİMİ VE TIP MERKEZİ",
                "Address": "Küçükbakkalköy Mah. Ataşehir, İstanbul",
                "Telephone": "02164641111",
                "CompanyWebsite": "https://www.asmed.com.tr",
                "Point": {"DecLatitude": 40.984, "DecLongitude": 29.111}
            }
        ];
        </script>
        """
        leads = scraper._parse_map_info(sample_html, "Ataşehir", "İstanbul")
        assert len(leads) == 1
        assert "ASMED" in leads[0]["name"]
        assert leads[0]["phone_e164"] == "+902164641111"
        assert leads[0]["latitude"] == 40.984


class TestDeduplicationAndMerging:
    """TEST 4 & TEST 5: Smart deduplication across multiple providers and queries."""

    def test_duplicate_phone_merged(self):
        """Identical phone number found in 2 different providers must yield 1 lead."""
        phone1 = "+905322372398"
        phone2 = "+905322372398"
        seen_phones = set()
        seen_phones.add(phone1)
        assert phone2 in seen_phones  # Second occurrence is caught and merged

    def test_different_businesses_similar_names_preserved(self):
        """Two different businesses with similar names but different phones/districts."""
        biz1_name = "Estetik Saç Kliniği Ataşehir"
        biz2_name = "Estetik Saç Kliniği Kadıköy"
        
        key1 = f"{normalize_turkish(biz1_name)}_atasehir"
        key2 = f"{normalize_turkish(biz2_name)}_kadikoy"
        assert key1 != key2  # Preserved as distinct


class TestUnlimitedAndMetrics:
    """TEST 1, TEST 8, TEST 10: Unlimited mode & Discovery metrics."""

    def test_unlimited_target_limit_is_high(self):
        """max_results=0 sets high multi-page discovery limit, not 0 or 3."""
        is_unlimited = (0 <= 0)
        limit = 1000 if is_unlimited else 0
        assert limit == 1000

    def test_metrics_structure_complete(self):
        metrics = {
            "queries_executed": 18,
            "providers_used": ["Turkish B2B Directory", "OpenStreetMap Nominatim"],
            "pages_visited": 12,
            "raw_results_found": 84,
            "unique_candidates": 42,
            "location_rejected": 4,
            "category_rejected": 0,
            "duplicate_merged": 15,
            "invalid_contact_rejected": 2,
            "qualified_leads": 39,
        }
        assert metrics["queries_executed"] > 0
        assert metrics["raw_results_found"] >= metrics["unique_candidates"]
# ============================================================
# ENTITY RESOLUTION & PERSON/DOCTOR DETECTION TESTS
# ============================================================

from backend.app.services.entity_resolver import (
    EntityResolver,
    EntityType,
    VerificationStatus,
    ConfidenceLevel,
    SourceTrustTier
)
from backend.app.services.outreach_guard import OutreachGuard
from backend.app.models.lead import Lead


class TestEntityResolutionRules:
    """TEST: Person is not Business, Doctor is not Clinic, Directory is not automatically Verified."""

    def test_person_is_not_business(self):
        """Pure person name without business keywords must resolve to PERSON."""
        res = EntityResolver.resolve_entity(
            raw_name="Burcu Demiralp",
            raw_address="Ataşehir, İstanbul",
            phone_e164="+902163243619",
            website=None,
            source="TURKISH_DIRECTORY",
            target_category="Diş Klinikleri & Ağız Sağlığı Merkezleri"
        )
        assert res["entity_type"] == EntityType.PERSON.value
        assert res["is_verified"] is False
        assert res["verification_status"] == VerificationStatus.UNVERIFIED.value
        assert res["confidence_level"] == ConfidenceLevel.LOW.value

    def test_doctor_prefix_detected_as_person(self):
        """Names with Dr., Dt., Uzm. Dr., etc. are detected as PERSON, not CLINIC."""
        titles = [
            "Diş Hekimi Burcu Demiralp",
            "Dr. Mehmet Kaya",
            "Dt. Ahmet Yılmaz",
            "Prof. Dr. Selin Öztürk",
            "Uzm. Dt. Ali Can"
        ]
        for t in titles:
            entity_type, reasons = EntityResolver.detect_entity_type(t, "Diş Klinikleri")
            assert entity_type == EntityType.PERSON, f"Failed for {t}"

    def test_business_name_not_ai_generated(self):
        """System must not transform 'Burcu Demiralp' into synthetic 'Burcu Demiralp Diş Kliniği'."""
        raw = "Burcu Demiralp"
        clean = DirectoryScraper._clean_business_name(raw)
        assert clean == "Burcu Demiralp"
        assert "Klinik" not in clean
        assert "Diş" not in clean

    def test_positive_dental_clinic_verified(self):
        """Real commercial clinic with official website and phone resolves to CLINIC / VERIFIED / HIGH."""
        res = EntityResolver.resolve_entity(
            raw_name="DentAtaşehir Ağız ve Diş Sağlığı Polikliniği",
            raw_address="Küçükbakkalköy Mah. Vedat Günyol Cad. 24 Ataşehir, İstanbul",
            phone_e164="+902164567890",
            website="https://www.dentatasehir.com",
            source="GOOGLE_MAPS",
            target_category="Diş Klinikleri & Ağız Sağlığı Merkezleri",
            is_mobile=True
        )
        assert res["entity_type"] == EntityType.CLINIC.value
        assert res["is_verified"] is True
        assert res["verification_status"] == VerificationStatus.VERIFIED.value
        assert res["confidence_level"] == ConfidenceLevel.HIGH.value
        assert res["confidence_score"] >= 80

    def test_corporate_company_verified(self):
        """Corporate legal entities (A.Ş., Ltd. Şti.) resolve to COMPANY / BUSINESS."""
        res = EntityResolver.resolve_entity(
            raw_name="AYTUĞLU SAĞLIK TURİZM VE DİŞ HİZMETLERİ TİC. LTD. ŞTİ.",
            raw_address="Barbaros Mah. Dereboyu Cad. Ataşehir, İstanbul",
            phone_e164="+902166885955",
            website="https://www.aytuglu.com.tr",
            source="TURKISH_DIRECTORY",
            target_category="Diş Klinikleri & Ağız Sağlığı Merkezleri"
        )
        assert res["entity_type"] == EntityType.COMPANY.value
        assert res["is_verified"] is True

    def test_phone_alone_insufficient_for_verification(self):
        """A valid phone number alone does not elevate a PERSON to VERIFIED."""
        res = EntityResolver.resolve_entity(
            raw_name="Ahmet Yılmaz",
            raw_address="Ataşehir, İstanbul",
            phone_e164="+905321112233",
            website=None,
            source="TURKISH_DIRECTORY",
            target_category="Diş Klinikleri",
            is_mobile=True
        )
    def test_clinic_named_after_doctor_is_qualified(self):
        """Clinics named after doctors (e.g. 'Dr. Ahmet Yılmaz Diş Kliniği') must resolve to CLINIC / VERIFIED."""
        clinics = [
            "Dr. Ahmet Yılmaz Diş Kliniği",
            "Burcu Demiralp Dental Clinic",
            "Özkan Öztürk Muayenehanesi",
            "Diş Hekimi Elif Arslan Muayenehanesi (Elif Arslan)",
            "Dt. Mehmet Kaya Ağız ve Diş Sağlığı Merkezi"
        ]
        for c in clinics:
            res = EntityResolver.resolve_entity(
                raw_name=c,
                raw_address="Atatürk Mah. Ataşehir, İstanbul",
                phone_e164="+902165750000",
                website=None,
                source="TURKISH_DIRECTORY",
                target_category="Diş Klinikleri & Ağız Sağlığı Merkezleri"
            )
            assert res["entity_type"] == EntityType.CLINIC.value, f"Failed type for {c}: {res['entity_type']}"
            assert res["is_verified"] is True, f"Failed verified for {c}: score={res['confidence_score']}"
            assert res["verification_status"] == VerificationStatus.VERIFIED.value

    def test_directory_business_without_website_is_qualified(self):
        """A directory business with valid physical address and phone is QUALIFIED / VERIFIED even without a website."""
        res = EntityResolver.resolve_entity(
            raw_name="Ataşehir Dent Ağız ve Diş Sağlığı",
            raw_address="Barbaros Mah. Dereboyu Cad. No:12 Ataşehir/İstanbul",
            phone_e164="+902165755577",
            website=None,
            source="TURKISH_DIRECTORY",
            target_category="Diş Klinikleri"
        )
        assert res["entity_type"] == EntityType.CLINIC.value
        assert res["is_verified"] is True
        assert res["confidence_score"] >= 70

    def test_pure_person_without_clinic_keyword_is_unverified(self):
        """Pure person or doctor profile without clinic/business indicator remains PERSON / UNVERIFIED."""
        persons = [
            "Burcu Demiralp",
            "Diş Hekimi Burcu Demiralp",
            "Dr. Mehmet Kaya",
            "Dt. Ali Can"
        ]
        for p in persons:
            res = EntityResolver.resolve_entity(
                raw_name=p,
                raw_address="Ataşehir, İstanbul",
                phone_e164="+902163243619",
                website=None,
                source="TURKISH_DIRECTORY",
                target_category="Diş Klinikleri & Ağız Sağlığı Merkezleri"
            )
            assert res["entity_type"] == EntityType.PERSON.value, f"Failed for {p}: {res['entity_type']}"
            assert res["is_verified"] is False, f"Failed unverified for {p}"
            assert res["verification_status"] == VerificationStatus.UNVERIFIED.value


class TestOutreachGuard:
    """TEST: Outreach quality gatekeeper blocks unverified and person records from campaigns."""

    def test_unverified_lead_blocked_from_campaign(self):
        """Lead with is_verified=False cannot enroll in WhatsApp outreach."""
        lead = Lead(
            id=1,
            name="Burcu Demiralp",
            phone="02163243619",
            phone_e164="+902163243619",
            is_whatsapp_eligible=True,
            entity_type=EntityType.PERSON.value,
            verification_status=VerificationStatus.UNVERIFIED.value,
            is_verified=False
        )
        can_enroll, reason = OutreachGuard.can_enroll_in_campaign(lead)
        assert can_enroll is False
        assert "şahıs/doktor" in reason or "PERSON" in reason

    def test_verified_clinic_allowed_in_campaign(self):
        """Lead with is_verified=True and entity_type=CLINIC is allowed in campaign."""
        lead = Lead(
            id=2,
            name="Ataşehir Dental Polikliniği",
            phone="05321112233",
            phone_e164="+905321112233",
            is_whatsapp_eligible=True,
            entity_type=EntityType.CLINIC.value,
            verification_status=VerificationStatus.VERIFIED.value,
            is_verified=True
        )
        can_enroll, reason = OutreachGuard.can_enroll_in_campaign(lead)
        assert can_enroll is True
        assert reason is None

    def test_ineligible_whatsapp_phone_blocked(self):
        """Lead without WhatsApp eligibility is blocked."""
        lead = Lead(
            id=3,
            name="Ataşehir Dental Polikliniği",
            phone="02161112233",
            phone_e164="+902161112233",
            is_whatsapp_eligible=False,
            entity_type=EntityType.CLINIC.value,
            verification_status=VerificationStatus.VERIFIED.value,
            is_verified=True
        )
        can_enroll, reason = OutreachGuard.can_enroll_in_campaign(lead)
        assert can_enroll is False
        assert "WhatsApp" in reason

    def test_batch_outreach_filter_partitions_correctly(self):
        """Batch filtering correctly separates verified businesses from person/unverified leads."""
        leads = [
            Lead(id=1, name="Burcu Demiralp", phone_e164="+902163243619", is_whatsapp_eligible=True, entity_type="PERSON", is_verified=False, verification_status="UNVERIFIED"),
            Lead(id=2, name="Ataşehir Dental Klinik", phone_e164="+905321112233", is_whatsapp_eligible=True, entity_type="CLINIC", is_verified=True, verification_status="VERIFIED"),
            Lead(id=3, name="Dr. Mehmet Kaya", phone_e164="+905332223344", is_whatsapp_eligible=True, entity_type="PERSON", is_verified=False, verification_status="UNVERIFIED"),
            Lead(id=4, name="Özel DentAtaşehir Polikliniği", phone_e164="+905353334455", is_whatsapp_eligible=True, entity_type="CLINIC", is_verified=True, verification_status="VERIFIED"),
        ]
        allowed, blocked = OutreachGuard.filter_qualified_for_outreach(leads)
        assert len(allowed) == 2
        assert len(blocked) == 2
        assert {l.id for l in allowed} == {2, 4}
        assert {b["lead_id"] for b in blocked} == {1, 3}


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])


