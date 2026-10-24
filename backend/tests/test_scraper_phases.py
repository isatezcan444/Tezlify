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
