import pytest
from unittest.mock import patch, MagicMock
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.system_settings import SystemSetting
from backend.app.services.email_service import EmailService


async def get_in_memory_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


@pytest.mark.asyncio
async def test_get_and_save_smtp_config():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        # Initially not configured
        config = await EmailService.get_smtp_config(db)
        assert config["is_configured"] is False

        # Save configuration
        saved = await EmailService.save_smtp_config(
            db,
            {
                "host": "smtp.example.com",
                "port": 587,
                "username": "user@example.com",
                "password": "secret_password",
                "sender_email": "user@example.com",
                "sender_name": "Test Company",
                "use_tls": True,
                "use_ssl": False,
            },
        )
        assert saved["is_configured"] is True
        assert saved["password"] == "********"

        # Read back
        read_back = await EmailService.get_smtp_config(db)
        assert read_back["is_configured"] is True
        assert read_back["host"] == "smtp.example.com"
        assert read_back["sender_email"] == "user@example.com"

    await engine.dispose()


@pytest.mark.asyncio
async def test_send_lead_email_success():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        # Configure SMTP
        await EmailService.save_smtp_config(
            db,
            {
                "host": "smtp.example.com",
                "port": 587,
                "username": "user@example.com",
                "password": "secret_password",
                "sender_email": "outreach@example.com",
                "sender_name": "Tezlify Outreach",
            },
        )

        # Create lead with email
        lead = Lead(
            name="Acme Corp",
            category="Yazılım",
            city="İstanbul",
            phone="+905551234567",
            email="info@acmecorp.com",
            status=LeadStatus.NEW,
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)

        # Mock the synchronous SMTP send function
        with patch.object(EmailService, "_send_sync") as mock_send:
            res = await EmailService.send_lead_email(
                db=db,
                lead_id=lead.id,
                subject="Merhaba {name} - {category} Çözümleri",
                body="Sayın {name} yetkilisi, {city} lokasyonundaki çalışmalarınız için teklifimiz...",
                is_html=False,
            )

            assert res["success"] is True
            assert res["recipient_email"] == "info@acmecorp.com"
            assert res["subject"] == "Merhaba Acme Corp - Yazılım Çözümleri"

            # Check that _send_sync was invoked with interpolated variables
            mock_send.assert_called_once()
            call_args = mock_send.call_args[0]
            assert call_args[1] == "info@acmecorp.com"
            assert "Acme Corp" in call_args[2]
            assert "İstanbul" in call_args[3]

            # Verify lead advanced from NEW to CONTACTED
            await db.refresh(lead)
            assert lead.status == LeadStatus.CONTACTED
            assert lead.last_contacted_at is not None

    await engine.dispose()
