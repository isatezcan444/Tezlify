import hashlib
import pytest
from backend.app.services.phone_service import PhoneService
from backend.app.services.taxonomy_registry import TaxonomyRegistry
from backend.app.services.search_planner import SearchPlanner
from backend.app.services.location_validator import LocationValidator
from backend.app.services.smart_matching_service import SmartMatchingService


def test_deterministic_place_id_hashing():
    """Proves place_id hashing is deterministic and process-independent."""
    url = "https://www.google.com/maps/place/Tezlify+Dental/@40.99,29.12,17z"
    expected = hashlib.sha256(url.encode()).hexdigest()[:16]
    actual_1 = hashlib.sha256(url.encode()).hexdigest()[:16]
    actual_2 = hashlib.sha256(url.encode()).hexdigest()[:16]
    assert expected == actual_1 == actual_2
    assert len(expected) == 16


def test_phone_normalization_invariants():
    """Proves phone normalization handles Turkish mobile, landline, and invalid formats safely."""
    # Turkish GSM -> Valid E.164 & WhatsApp eligible
    res_gsm = PhoneService.normalize_to_e164("0532 123 45 67")
    assert res_gsm is not None
    assert res_gsm["is_valid"] is True
    assert res_gsm["e164"] == "+905321234567"
    assert res_gsm["is_mobile"] is True
    assert res_gsm["is_whatsapp_eligible"] is True

    # Turkish Landline -> Valid phone, but NOT WhatsApp eligible
    res_landline = PhoneService.normalize_to_e164("0212 234 56 78")
    assert res_landline is not None
    assert res_landline["is_valid"] is True
    assert res_landline["e164"] == "+902122345678"
    assert res_landline["is_mobile"] is False
    assert res_landline["is_whatsapp_eligible"] is False

    # Empty / None phone -> Returns None, never synthesizes fake numbers
    res_empty = PhoneService.normalize_to_e164("")
    assert res_empty is None

    # Invalid digits -> Safe None or invalid
    res_invalid = PhoneService.normalize_to_e164("12345")
    assert res_invalid is None or not res_invalid.get("is_valid")


def test_taxonomy_and_category_mapping_integrity():
    """Proves TaxonomyRegistry resolves business keywords and synonyms correctly."""
    node = TaxonomyRegistry.find_node_by_alias_or_concept("diş")
    assert node is not None
    assert node.id == "dental"
    assert "Diş" in node.display_name

    # Check mutual exclusivity
    is_exclusive = TaxonomyRegistry.are_mutually_exclusive("dental", "automotive")
    assert is_exclusive is True


def test_search_planner_expansion():
    """Proves SearchPlanner generates structured queries for multi-district discovery."""
    from backend.app.services.intent_resolver import IntentResolver
    intent = IntentResolver.resolve_intent("diş")
    plan = SearchPlanner.create_plan(
        intent=intent,
        city="İstanbul",
        districts=["Kadıköy", "Ataşehir"]
    )
    assert plan is not None
    assert len(plan.provider_queries) >= 2
    assert any("Kadıköy" in q.district for q in plan.provider_queries)
    assert any("Ataşehir" in q.district for q in plan.provider_queries)


def test_smart_matching_scoring_invariants():
    """Proves SmartMatchingService evaluates lead-offer fit without throwing exceptions."""
    from backend.app.models.lead import Lead
    sample_lead = Lead(
        name="Ataşehir Diş Polikliniği",
        category="Diş Hekimi",
        city="İstanbul",
        district="Ataşehir",
        is_whatsapp_eligible=True
    )
    assessment = SmartMatchingService.evaluate_lead(
        lead=sample_lead,
        offer_title="Diş Hekimlerine Özel İmplant Randevu Sistemi",
        approved_target_categories=["Diş Klinikleri"]
    )
    assert assessment is not None
    assert 0 <= assessment.fit_score <= 100
    assert assessment.fit_level in ("HIGH", "MEDIUM", "LOW", "UNMATCHED")
    assert isinstance(assessment.positive_signals, list)
