import pytest
import unittest.mock as mock
from backend.app.services.enrichment_service import EnrichmentService
from backend.app.models.lead import Lead, LeadStatus


def test_normalize_website_url():
    # Empty cases
    assert EnrichmentService.normalize_website_url(None) is None
    assert EnrichmentService.normalize_website_url("") is None
    assert EnrichmentService.normalize_website_url("   ") is None

    # Missing scheme
    assert EnrichmentService.normalize_website_url("ornekbutik.com") == "https://ornekbutik.com"
    assert EnrichmentService.normalize_website_url("www.ornekbutik.com/") == "https://www.ornekbutik.com"

    # Preserves http
    assert EnrichmentService.normalize_website_url("http://sirket.com.tr/hakkinda/") == "http://sirket.com.tr/hakkinda"

    # Rejects google maps / social pages as website
    assert EnrichmentService.normalize_website_url("https://www.google.com/maps/place/foo") is None
    assert EnrichmentService.normalize_website_url("https://instagram.com/butik") is None


def test_extract_emails():
    sample_html = """
    <html>
      <body>
        <p>Bize ulaşın: <a href="mailto:info@ornekbutik.com">E-posta Gönder</a></p>
        <p>Satış ekibi: satis@ornekbutik.com veya alternatif: destek@ornekbutik.com</p>
        <img src="icon@2x.png" alt="icon"/>
        <script src="sentry@sentry.io/bundle.js"></script>
        <p>Geliştirici: john.doe@ornekbutik.com</p>
      </body>
    </html>
    """
    emails = EnrichmentService.extract_emails(sample_html)

    assert "info@ornekbutik.com" in emails
    assert "satis@ornekbutik.com" in emails
    assert "destek@ornekbutik.com" in emails
    assert "john.doe@ornekbutik.com" in emails

    # False positives excluded
    assert not any("2x.png" in e for e in emails)
    assert not any("sentry.io" in e for e in emails)

    # Priority sorting: info@, destek@, satis@ should come early
    assert emails[0] in ["info@ornekbutik.com", "destek@ornekbutik.com", "satis@ornekbutik.com"]


def test_extract_social_links():
    sample_html = """
    <footer>
      <a href="https://www.instagram.com/ornekbutik/">Instagram</a>
      <a href="https://instagram.com/p/Cxyz123">Post linki</a>
      <a href="https://www.facebook.com/ornekbutikresmi">Facebook</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=foo">Share</a>
      <a href="https://www.linkedin.com/company/ornek-grup">LinkedIn</a>
      <a href="https://twitter.com/ornektwit">Twitter</a>
      <a href="https://x.com/ornektwit2">X</a>
      <a href="https://www.youtube.com/@ornekanal">YouTube</a>
    </footer>
    """
    socials = EnrichmentService.extract_social_links(sample_html, "https://ornekbutik.com")

    assert socials.get("instagram") == "https://www.instagram.com/ornekbutik"
    assert socials.get("facebook") == "https://www.facebook.com/ornekbutikresmi"
    assert socials.get("linkedin") == "https://www.linkedin.com/company/ornek-grup"
    assert socials.get("twitter") in ["https://twitter.com/ornektwit", "https://x.com/ornektwit2"]
    assert socials.get("youtube") == "https://www.youtube.com/@ornekanal"


def test_extract_meta_info():
    sample_html = """
    <!DOCTYPE html>
    <html>
      <head>
        <title>Örnek Butik | Kadın Giyim & Aksesuar</title>
        <meta name="description" content="En trend kadın giyim modelleri uygun fiyatlarla Örnek Butik'te.">
        <meta property="og:description" content="Trend kadın kıyafetleri">
      </head>
      <body></body>
    </html>
    """
    title, desc = EnrichmentService.extract_meta_info(sample_html)
    assert title == "Örnek Butik | Kadın Giyim & Aksesuar"
    assert desc == "En trend kadın giyim modelleri uygun fiyatlarla Örnek Butik'te."


def test_find_contact_page_url():
    sample_html = """
    <nav>
      <a href="/anasayfa">Ana Sayfa</a>
      <a href="/urunler">Ürünler</a>
      <a href="/iletisim">İletişim</a>
    </nav>
    """
    contact_url = EnrichmentService.find_contact_page_url(sample_html, "https://ornekbutik.com")
    assert contact_url == "https://ornekbutik.com/iletisim"


import uuid
from backend.app.core.database import AsyncSessionLocal


@pytest.mark.asyncio
async def test_enrich_lead_no_website():
    async with AsyncSessionLocal() as session:
        u = uuid.uuid4().hex[:8]
        lead = Lead(
            name="Web Sitesi Olmayan İşletme",
            phone=f"0555{u[:7]}",
            phone_e164=f"+90555{u[:7]}",
            website=None,
            status=LeadStatus.NEW,
        )
        session.add(lead)
        await session.commit()
        await session.refresh(lead)

        res = await EnrichmentService.enrich_lead(session, lead)
        assert res["success"] is False
        assert lead.enrichment_status == "NO_WEBSITE"
        assert lead.enriched_at is not None


@pytest.mark.asyncio
async def test_enrich_lead_success_mocked():
    async with AsyncSessionLocal() as session:
        u = uuid.uuid4().hex[:8]
        lead = Lead(
            name="Harika Kafe",
            phone=f"0555{u[:7]}",
            phone_e164=f"+90555{u[:7]}",
            website="https://harikakafe.com",
            status=LeadStatus.NEW,
        )
        session.add(lead)
        await session.commit()
        await session.refresh(lead)

        mock_html = """
        <html>
          <head><title>Harika Kafe Kadıköy</title><meta name="description" content="Nitelikli kahve ve tatlılar"></head>
          <body>
            <p>Bize yazın: <a href="mailto:info@harikakafe.com">Mail</a></p>
            <a href="https://instagram.com/harikakafe">Instagram</a>
          </body>
        </html>
        """

        with mock.patch.object(EnrichmentService, "fetch_html", return_value=mock_html):
            res = await EnrichmentService.enrich_lead(session, lead)

            assert res["success"] is True
            assert "info@harikakafe.com" in res["found_emails"]
            assert res["found_socials"].get("instagram") == "https://instagram.com/harikakafe"
            assert res["meta_title"] == "Harika Kafe Kadıköy"

            assert lead.enrichment_status == "ENRICHED"
            assert lead.email == "info@harikakafe.com"
            assert "info@harikakafe.com" in lead.emails
            assert lead.social_links.get("instagram") == "https://instagram.com/harikakafe"
            assert lead.meta_title == "Harika Kafe Kadıköy"


@pytest.mark.asyncio
async def test_bulk_enrich_leads_mocked():
    async with AsyncSessionLocal() as session:
        u1 = uuid.uuid4().hex[:8]
        u2 = uuid.uuid4().hex[:8]
        lead1 = Lead(
            name="İşletme 1",
            phone=f"0555{u1[:7]}",
            phone_e164=f"+90555{u1[:7]}",
            website="https://isletme1.com",
            status=LeadStatus.NEW,
        )
        lead2 = Lead(
            name="İşletme 2",
            phone=f"0555{u2[:7]}",
            phone_e164=f"+90555{u2[:7]}",
            website=None,  # should skip
            status=LeadStatus.NEW,
        )
        session.add_all([lead1, lead2])
        await session.commit()
        await session.refresh(lead1)
        await session.refresh(lead2)

        mock_html = """
        <html>
          <head><title>İşletme 1 Web</title></head>
          <body><a href="mailto:iletisim@isletme1.com">İletişim</a></body>
        </html>
        """

        with mock.patch.object(EnrichmentService, "fetch_html", return_value=mock_html):
            res = await EnrichmentService.bulk_enrich_leads(session, [lead1, lead2])

            assert res["total_requested"] == 2
            assert res["enriched_count"] == 1
            assert res["skipped_count"] == 1
            assert lead1.enrichment_status == "ENRICHED"
            assert lead2.enrichment_status == "NO_WEBSITE"


@pytest.mark.asyncio
async def test_api_enrich_endpoints():
    from fastapi.testclient import TestClient
    from backend.app.main import app
    from backend.app.core.auth import get_current_user, AuthUser

    test_uid = str(uuid.uuid4())
    user = AuthUser(id=test_uid, email="user@tezlify.test")
    app.dependency_overrides[get_current_user] = lambda: user

    async with AsyncSessionLocal() as session:
        u = uuid.uuid4().hex[:8]
        lead = Lead(
            user_id=test_uid,
            name="Endpoint Test Butik",
            phone=f"0555{u[:7]}",
            phone_e164=f"+90555{u[:7]}",
            website="https://endpointbutik.com",
            status=LeadStatus.NEW,
        )
        session.add(lead)
        await session.commit()
        await session.refresh(lead)
        lead_id = lead.id

    client = TestClient(app)
    mock_html = """
    <html>
      <head><title>Endpoint Butik Resmi</title><meta name="description" content="Moda burada"></head>
      <body><a href="mailto:info@endpointbutik.com">Mail</a></body>
    </html>
    """

    with mock.patch.object(EnrichmentService, "fetch_html", return_value=mock_html):
        # 1. Single lead enrich endpoint
        res = client.post(f"/api/v1/leads/{lead_id}/enrich")
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["success"] is True
        assert "info@endpointbutik.com" in data["found_emails"]
        assert data["meta_title"] == "Endpoint Butik Resmi"

        # 2. Bulk enrich endpoint
        res_bulk = client.post("/api/v1/leads/bulk-enrich", json={"lead_ids": [lead_id]})
        assert res_bulk.status_code == 200, res_bulk.text
        bulk_data = res_bulk.json()
        assert bulk_data["total_requested"] == 1
        assert bulk_data["enriched_count"] == 1

    app.dependency_overrides.clear()


