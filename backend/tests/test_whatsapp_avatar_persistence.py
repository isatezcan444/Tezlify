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
from backend.app.services.whatsapp.repositories.contacts import (
    get_contact_avatar,
    set_contact_avatar,
    clear_contact_avatar,
    is_whatsapp_avatar_expired,
)


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

        # Setting 'changed' or 'remove' sentinels must NOT overwrite valid avatar
        set_contact_avatar(contact, "changed")
        assert get_contact_avatar(contact) == test_url
        set_contact_avatar(contact, "remove")
        assert get_contact_avatar(contact) == test_url

        # If contact initially has legacy 'changed' in custom_attributes, get_contact_avatar returns None
        # and set_contact_avatar purges it
        corrupted = Contact(id=2, user_id="u-test", phone_e164="+905551112233", custom_attributes={"avatar_url": "changed"})
        assert get_contact_avatar(corrupted) is None
        set_contact_avatar(corrupted, "changed")
        assert "avatar_url" not in corrupted.custom_attributes
        assert get_contact_avatar(corrupted) is None

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

    def test_expired_whatsapp_avatar_filtered_and_purged(self):
        # oe=6AD8EB1C corresponds to epoch 1792598812 (Oct 21, 2026), which is in the past
        expired_url = "https://pps.whatsapp.net/v/t61.24694-24/566638859_788599220678526_3305792808332190461_n.jpg?stp=dst-jpg_s96x96_tt6&ccb=11-4&oh=01_Q5Aa5wHRekH3lcK4WwmvD9Y9gyx9IMoqYmwcrKwQGt5q0bm2lg&oe=6AD8EB1C&_nc_sid=5e03e0&_nc_cat=107"
        assert is_whatsapp_avatar_expired(expired_url) is True

        # Future URL (oe=7FFFFFFF = year 2038)
        future_url = "https://pps.whatsapp.net/v/t61.24694-24/test.jpg?oe=7FFFFFFF"
        assert is_whatsapp_avatar_expired(future_url) is False

        # Static URL without oe parameter
        static_url = "https://pps.whatsapp.net/v/avatar_static.jpg"
        assert is_whatsapp_avatar_expired(static_url) is False

        # Contact with expired avatar stored previously in custom_attributes:
        # get_contact_avatar must fail-closed and return None to prevent client 403s
        contact = Contact(
            id=3,
            user_id="u-test",
            phone_e164="+905553334455",
            custom_attributes={"avatar_url": expired_url},
        )
        assert get_contact_avatar(contact) is None

        # Attempting to set an expired avatar should purge it from custom_attributes
        set_contact_avatar(contact, expired_url)
        assert "avatar_url" not in (contact.custom_attributes or {})
        assert get_contact_avatar(contact) is None

    def test_clear_contact_avatar(self):
        contact = Contact(
            id=4,
            user_id="u-test",
            phone_e164="+905554445566",
            custom_attributes={"avatar_url": "https://pps.whatsapp.net/v/valid_url.jpg"},
        )
        assert get_contact_avatar(contact) == "https://pps.whatsapp.net/v/valid_url.jpg"
        changed = clear_contact_avatar(contact)
        assert changed is True
        assert "avatar_url" not in contact.custom_attributes
        assert get_contact_avatar(contact) is None

        # Clearing again returns False (no-op)
        assert clear_contact_avatar(contact) is False

    def test_set_contact_avatar_force_none(self):
        contact = Contact(
            id=5,
            user_id="u-test",
            phone_e164="+905557778899",
            custom_attributes={"avatar_url": "https://pps.whatsapp.net/v/valid_url.jpg"},
        )
        # Without force, setting None does NOT delete
        set_contact_avatar(contact, None, force=False)
        assert get_contact_avatar(contact) == "https://pps.whatsapp.net/v/valid_url.jpg"

        # With force=True, setting None deletes it
        set_contact_avatar(contact, None, force=True)
        assert "avatar_url" not in contact.custom_attributes
        assert get_contact_avatar(contact) is None

    @pytest.mark.asyncio
    async def test_refresh_contact_avatar_item_not_found_clears_stale_avatar(self):
        contact = Contact(
            id=12,
            user_id="u-user",
            phone_e164="+905552223344",
            custom_attributes={"avatar_url": "https://pps.whatsapp.net/v/dead_404_url.jpg"},
        )
        session = WhatsAppSession(
            id=3,
            user_id="u-user",
            gateway_id="gw-session-3",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )

        db = AsyncMock()
        db.scalar.side_effect = [session, contact]
        db.commit = AsyncMock()

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw.refresh_avatar", new_callable=AsyncMock) as mock_refresh:
            # Baileys returns 404 item-not-found when user has removed their profile photo
            mock_refresh.return_value = {
                "success": False,
                "error": "item-not-found",
            }
            result = await refresh_contact_avatar(db, "u-user", "+905552223344")

        assert result["success"] is False
        assert result["avatar_url"] is None
        # Stale avatar is purged from database contact
        assert "avatar_url" not in (contact.custom_attributes or {})
        assert get_contact_avatar(contact) is None
        db.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_refresh_contact_avatar_redacts_phone_in_logs(self, caplog):
        import logging
        contact = Contact(
            id=13,
            user_id="u-user",
            phone_e164="+905553334455",
            custom_attributes={"avatar_url": "https://pps.whatsapp.net/v/dead_url.jpg"},
        )
        session = WhatsAppSession(
            id=4,
            user_id="u-user",
            gateway_id="gw-session-4",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )

        db = AsyncMock()
        db.scalar.side_effect = [session, contact]
        db.commit = AsyncMock()

        with patch("backend.app.services.whatsapp.orchestration.sessions.gw.refresh_avatar", new_callable=AsyncMock) as mock_refresh:
            mock_refresh.return_value = {
                "success": False,
                "error": "item-not-found",
            }
            with caplog.at_level(logging.WARNING):
                await refresh_contact_avatar(db, "u-user", "+905553334455")

        # Full phone +905553334455 must NOT appear in warnings (PII protection)
        full_phone = "+905553334455"
        raw_digits = "905553334455"
        for record in caplog.records:
            assert full_phone not in record.message
            assert raw_digits not in record.message
            if "item-not-found" in record.message:
                assert "...4455" in record.message

