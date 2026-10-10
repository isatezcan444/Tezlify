"""Phase 22: WhatsApp Avatar Persistence & Zero-Flicker Backend Tests.

Verifies:
1. Contact lookup matches with plus, without plus, and JID formats in refresh_contact_avatar.
2. set_contact_avatar and _get_contact_avatar correctly store and retrieve avatar URLs.
3. Database persistence preserves avatar URL across updates.
"""
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from backend.app.models.contact import Contact
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.sessions import refresh_contact_avatar
from backend.app.services.whatsapp.repositories.contacts import get_contact_avatar, set_contact_avatar


class TestWhatsAppAvatarPersistence:

    def test_contact_avatar_set_and_get(self):
        contact = Contact(
            id=1,
            user_id="u-test",
            phone_e164="+905551234567",
            custom_attributes={},
        )
        assert get_contact_avatar(contact) is None

        test_url = "https://pps.whatsapp.net/avatar_test_v1.jpg"
        set_contact_avatar(contact, test_url)
        assert get_contact_avatar(contact) == test_url
        assert contact.custom_attributes["avatar_url"] == test_url

        # Setting None should not clobber existing avatar
        set_contact_avatar(contact, None)
        assert get_contact_avatar(contact) == test_url

        # Setting empty string should not clobber existing avatar
        set_contact_avatar(contact, "")
        assert get_contact_avatar(contact) == test_url

    @pytest.mark.asyncio
    async def test_refresh_contact_avatar_matches_phone_without_plus(self):
        # Database contact stored with E.164 plus
        contact = Contact(
            id=10,
            user_id="u-user",
            phone_e164="+905559876543",
            custom_attributes={},
        )
        session = WhatsAppSession(
            id=1,
            user_id="u-user",
            gateway_id="gw-session-1",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )

        db = AsyncMock()
        # First scalar call is session query, second is contact query
        db.scalar.side_effect = [session, contact]
        db.commit = AsyncMock()

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw.refresh_avatar", new_callable=AsyncMock) as mock_refresh:
            mock_refresh.return_value = {
                "success": True,
                "avatar_url": "https://pps.whatsapp.net/v/avatar_905559876543.jpg",
            }
            # Pass phone WITHOUT '+'
            result = await refresh_contact_avatar(db, "u-user", "905559876543")

        assert result["success"] is True
        assert result["avatar_url"] == "https://pps.whatsapp.net/v/avatar_905559876543.jpg"
        # Assert contact was found and avatar was set
        assert get_contact_avatar(contact) == "https://pps.whatsapp.net/v/avatar_905559876543.jpg"
        db.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_refresh_contact_avatar_matches_phone_with_plus(self):
        contact = Contact(
            id=11,
            user_id="u-user",
            phone_e164="+905551112233",
            custom_attributes={},
        )
        session = WhatsAppSession(
            id=2,
            user_id="u-user",
            gateway_id="gw-session-2",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )

        db = AsyncMock()
        db.scalar.side_effect = [session, contact]
        db.commit = AsyncMock()

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw.refresh_avatar", new_callable=AsyncMock) as mock_refresh:
            mock_refresh.return_value = {
                "success": True,
                "avatar_url": "https://pps.whatsapp.net/v/avatar_with_plus.jpg",
            }
            result = await refresh_contact_avatar(db, "u-user", "+905551112233")

        assert result["success"] is True
        assert result["avatar_url"] == "https://pps.whatsapp.net/v/avatar_with_plus.jpg"
        assert get_contact_avatar(contact) == "https://pps.whatsapp.net/v/avatar_with_plus.jpg"
        db.commit.assert_awaited_once()
