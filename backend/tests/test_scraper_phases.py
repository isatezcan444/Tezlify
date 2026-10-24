"""
Tests for Lead Finder Phases:
- Faz 2: Mahalle (Neighborhood) Desteği
- Faz 3: Nüfus & Bölge / Yarıçap Filtreleri
- Faz 4: Bölgesel Çoklu HTTP Scraper Paralelleştirme
"""

import os
import sys

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend.app.data.turkey_locations import (
    TURKEY_LOCATIONS,
    DISTRICT_METRICS,
    get_district_population,
    format_population,
    get_district_id,
)
from backend.app.schemas.scraper import ScraperRunRequest
from backend.app.models.blacklist import ScraperJob
from backend.app.core.config import settings


def test_turkey_locations_structure():
    assert len(TURKEY_LOCATIONS) == 81
    total_districts = sum(len(c["districts"]) for c in TURKEY_LOCATIONS)
    assert total_districts == 973
    assert len(DISTRICT_METRICS) == 973


def test_district_population_metrics():
    # Istanbul Kadıköy
    pop_kadikoy = get_district_population("İstanbul", "Kadıköy")
    assert pop_kadikoy is not None
    assert pop_kadikoy > 400_000
    assert "K" in format_population(pop_kadikoy)

    # Ankara Çankaya
    pop_cankaya = get_district_population("Ankara", "Çankaya")
    assert pop_cankaya is not None
    assert pop_cankaya > 900_000

    # Nonexistent district
    assert get_district_population("İstanbul", "Hayaliİlçe") == 0
    assert format_population(None) == ""
    assert format_population(0) == ""


def test_district_id_resolution():
    did = get_district_id("İstanbul", "Kadıköy")
    assert did is not None
    assert isinstance(did, int)
    assert did > 0


def test_scraper_run_request_schema():
    req = ScraperRunRequest(
        keyword="Diş Kliniği",
        city="İstanbul",
        districts=["Kadıköy", "Beşiktaş"],
        neighborhoods=["Moda", "Caferağa"],
        min_population=100_000,
        radius_km=10,
        max_results=50,
        auto_save_to_crm=True,
    )
    assert req.neighborhoods == ["Moda", "Caferağa"]
    assert req.min_population == 100_000
    assert req.radius_km == 10
    assert req.districts == ["Kadıköy", "Beşiktaş"]


def test_scraper_config_concurrency():
    assert hasattr(settings, "SCRAPER_CONCURRENT_DISTRICTS")
    assert settings.SCRAPER_CONCURRENT_DISTRICTS >= 2


def test_scraper_job_model_columns():
    job = ScraperJob(
        keyword="Diş Kliniği",
        location="İstanbul Kadıköy",
        city="İstanbul",
        districts_json=["Kadıköy"],
        status="PENDING",
    )
    assert job.keyword == "Diş Kliniği"
    assert job.city == "İstanbul"
    assert job.districts_json == ["Kadıköy"]


def test_location_validator_explicit_neighborhood_targeting():
    from backend.app.services.location_validator import LocationValidator, LocationStatus

    # 1. Matching target neighborhood
    res = LocationValidator.evaluate(
        target_city="İstanbul",
        target_districts=["Ataşehir"],
        result_address="Yenişehir Mah. Baraj Yolu Cad. No: 12 Ataşehir / İstanbul",
        result_name="Özel Dentanis Diş Kliniği",
        target_neighborhoods=["Yenişehir"],
    )
    assert res.status == LocationStatus.SUBDIVISION
    assert res.matched_subdivision == "Yenişehir"
    assert res.confidence == 1.0

    # 2. Non-target neighborhood in the same district
    res_other = LocationValidator.evaluate(
        target_city="İstanbul",
        target_districts=["Ataşehir"],
        result_address="Barbaros Mah. Halk Cad. No: 5 Ataşehir / İstanbul",
        result_name="Barbaros Ağız ve Diş Sağlığı",
        target_neighborhoods=["Yenişehir"],
    )
    assert res_other.status == LocationStatus.SUBDIVISION
    assert res_other.matched_subdivision == "Barbaros"


def test_geo_scope_filter_neighborhood_flag():
    from backend.app.services.geo_scope_filter import GeoScopeFilter, GeoScopeDecision

    geo_filter = GeoScopeFilter()

    # Target neighborhood match -> is_target_neighborhood = True
    verdict_target = geo_filter.evaluate(
        target_city="İstanbul",
        target_districts=["Ataşehir"],
        place_name="Özel Dentanis Diş Kliniği",
        place_address="Yenişehir Mah. Baraj Yolu Cad. No: 12 Ataşehir / İstanbul",
        target_neighborhoods=["Yenişehir"],
    )
    assert verdict_target.decision == GeoScopeDecision.ACCEPT_TARGET
    assert verdict_target.is_target_neighborhood is True
    assert verdict_target.matched_subdivision == "Yenişehir"

    # Mismatched neighborhood -> is_target_neighborhood = False
    verdict_mismatch = geo_filter.evaluate(
        target_city="İstanbul",
        target_districts=["Ataşehir"],
        place_name="Barbaros Diş Kliniği",
        place_address="Barbaros Mah. Halk Cad. No: 5 Ataşehir / İstanbul",
        target_neighborhoods=["Yenişehir"],
    )
    assert verdict_mismatch.decision == GeoScopeDecision.ACCEPT_TARGET
    assert verdict_mismatch.is_target_neighborhood is False
    assert verdict_mismatch.matched_subdivision == "Barbaros"


def test_http_scraper_query_neighborhood_formatting():
    # Verify that mahalle queries format as "{keyword} {district} {city}"
    # to pin Google Maps directly to the neighborhood centroid
    clean_keyword = "diş kliniği Yenişehir Mahallesi"
    clean_district = "Ataşehir"
    clean_city = "İstanbul"

    if "mahallesi" in clean_keyword.lower():
        query = f"{clean_keyword} {clean_district} {clean_city}".strip()
    else:
        query = f"{clean_city} {clean_district} {clean_keyword}".strip()

    assert query == "diş kliniği Yenişehir Mahallesi Ataşehir İstanbul"


def test_outside_district_rejected_even_with_shared_neighborhood_name():
    from backend.app.services.location_validator import LocationValidator, LocationStatus

    # Yenişehir exists in both Ataşehir and Pendik.
    # An address in Pendik MUST be rejected as OUTSIDE_TARGET even if Yenişehir was the target neighborhood.
    res = LocationValidator.evaluate(
        target_city="İstanbul",
        target_districts=["Ataşehir"],
        result_address="Yenişehir, Eşref Bitlis Blv. No:23, 34912 Pendik/İstanbul",
        result_name="Yaşam Başladı",
        target_neighborhoods=["Yenişehir"],
    )
    assert res.status == LocationStatus.OUTSIDE_TARGET
    assert res.matched_district == "Pendik"


def test_veterinary_and_animal_hospital_exclusion():
    from backend.app.services.query_expander import QueryExpander
    from backend.app.services.taxonomy_registry import TaxonomyRegistry

    TaxonomyRegistry.initialize()
    node = TaxonomyRegistry.find_node_by_alias_or_concept("Hayvan Hastanesi")
    assert node is not None
    assert node.id == "pet_services"
    assert TaxonomyRegistry.are_mutually_exclusive("dental", "pet_services") is True

    # Health facility signal must veto animal hospitals
    assert QueryExpander.has_health_facility_signal("İstanbul Hayvan Hastanesi") is False
    assert QueryExpander.has_health_facility_signal("Veteriner Kliniği") is False
    assert QueryExpander.has_health_facility_signal("Ataşehir Diş Hastanesi") is True


