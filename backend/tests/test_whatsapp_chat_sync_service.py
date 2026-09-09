"""
Unit tests for the bulk WhatsApp chat sync service and the delta reconcile endpoint.
Verifies WhatsApp-Web-grade zero-lag sync: bulk persistence, name resolution,
group handling (phone_e164 stays NULL per AGENTS.md 1.3) and revision tracking.
"""
import uuid
import pytest
from sqlalchemy import select
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.lead import Lead
from backend.app.services.whatsapp_chat_sync_service import (
    WhatsAppChatSyncService,
    NormalizedChat,
)


def _make_chat(jid: str, name: str, **overrides) -> dict:
    base = {
        "id": jid,
        "name": name,
        "unread_count": 1,
        "last_message": {"text": "Merhaba", "from_me": False},
        "timestamp": 1717000000,
        "is_group": jid.endswith("@g.us"),
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_normalize_chats_resolves_fields():
    chats = [
        _make_chat("905321112233@s.whatsapp.net", "Ahmet Yılmaz", phone="905321112233"),
        _make_chat("120363099999999999@g.us", "Şirket Grubu", phone=None),
        {"id": "status@broadcast"},  # filtered out
    ]
    normalized = WhatsAppChatSyncService.normalize_chats(chats)
    assert len(normalized) == 2

    person = next(c for c in normalized if not c.is_group)
    assert person.name == "Ahmet Yılmaz"
    assert person.phone_e164 is not None and person.phone_e164.startswith("+90")
    assert person.unread_count == 1

    group = next(c for c in normalized if c.is_group)
    assert group.phone_e164 is None  # AGENTS.md 1.3: never synthesize numbers
    assert group.place_id.startswith("group_")


@pytest.mark.asyncio
async def test_normalize_chats_camel_case_and_string_last_message():
    chats = [
        {
            "id": "905321110022@s.whatsapp.net",
            "phone": "+905321110022",
            "name": "Ayşe",
            "isGroup": False,
            "unreadCount": 5,
            "lastMessage": "Teklifinizi kabul ediyoruz.",
            "timestamp": 1717005000,
        }
    ]
    normalized = WhatsAppChatSyncService.normalize_chats(chats)
    assert len(normalized) == 1
    c = normalized[0]
    assert c.unread_count == 5
    assert c.last_message_text == "Teklifinizi kabul ediyoruz."
    assert not c.last_message_from_me


@pytest.mark.asyncio
async def test_sync_chats_bulk_creates_and_updates():
    test_user = str(uuid.uuid4())
    test_sess = f"bulk_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess,
            phone_number="+905551234567",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.commit()

        unique_suffix = uuid.uuid4().hex[:8]
        chats = [
            _make_chat(
                f"90532{unique_suffix}01@s.whatsapp.net",
                "Mehmet Kaya (Rehber)",
                phone=f"90532{unique_suffix}01",
                unread_count=3,
            ),
            _make_chat(f"120363{unique_suffix}@g.us", "Şirket Duyuru Grubu"),
        ]
        report = await WhatsAppChatSyncService.sync_chats(db=db, session=session, chats=chats, revision=7)

        assert not report.errors
        assert report.synced_count == 2
        assert report.created_leads == 2
        assert report.created_conversations == 2
        assert report.new_messages == 2
        assert WhatsAppChatSyncService.last_sync_revisions.get(test_sess) == 7

        synced_leads = (await db.execute(select(Lead).where(Lead.user_id == test_user))).scalars().all()
        assert synced_leads
        assert all(
            (lead.custom_data or {}).get("whatsapp_session_name") == test_sess
            for lead in synced_leads
        )

        # Idempotent second run: nothing new is created
        second = await WhatsAppChatSyncService.sync_chats(db=db, session=session, chats=chats, revision=7)
        assert second.created_leads == 0
        assert second.created_conversations == 0
        assert second.new_messages == 0


@pytest.mark.asyncio
async def test_sync_chats_upserts_existing_lead_by_phone():
    from backend.app.models.lead import Lead

    test_user = str(uuid.uuid4())
    test_sess = f"bulk2_{uuid.uuid4().hex[:8]}"
    e164 = f"+90532{uuid.uuid4().int % 10000000:07d}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess,
            phone_number="+905551234567",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.commit()

        # Pre-existing scraped lead with the same number
        db.add(
            Lead(
                user_id=test_user,
                name="Eski Kayıt",
                phone=e164,
                phone_e164=e164,
                place_id=f"legacy_{uuid.uuid4().hex[:12]}",
                category="Kuaför",
            )
        )
        await db.commit()

        chats = [_make_chat(f"{e164[1:]}@s.whatsapp.net", "Yeni Rehber Adı", phone=e164[1:])]
        report = await WhatsAppChatSyncService.sync_chats(db=db, session=session, chats=chats)

        assert not report.errors
        assert report.created_leads == 0  # matched by phone, not duplicated
        assert report.created_conversations == 1


@pytest.mark.asyncio
async def test_delta_endpoint_up_to_date_and_changed():
    test_user = str(uuid.uuid4())
    test_sess = f"delta_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=test_user,
                session_name=test_sess,
                phone_number="+905559998877",
                status=SessionStatus.CONNECTED,
            )
        )
        await db.commit()

    from backend.app.core.auth import get_current_user, AuthUser
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=test_user, email="delta@test.com", full_name="Delta User"
    )

    changed_payload = [
        _make_chat(
            f"905321555444{uuid.uuid4().hex[:4]}@s.whatsapp.net",
            "Delta Kişi",
            phone=f"905321555444{uuid.uuid4().hex[:4]}",
        )
    ]

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            # Gateway reports no changes -> cheap no-op response
            with patch(
                "backend.app.api.v1.endpoints.conversations.gateway_client.get_session_chats_delta",
                new_callable=AsyncMock,
            ) as mock_delta:
                mock_delta.return_value = {"revision": 42, "changed": []}
                res = await ac.post("/api/v1/conversations/sync-whatsapp/delta")
                assert res.status_code == 200, res.text
                assert res.json()["status"] == "up_to_date"
                assert res.json()["synced_count"] == 0

            # Gateway reports one changed chat -> bulk materialized
            with patch(
                "backend.app.api.v1.endpoints.conversations.gateway_client.get_session_chats_delta",
                new_callable=AsyncMock,
            ) as mock_delta:
                mock_delta.return_value = {"revision": 43, "changed": changed_payload}
                res = await ac.post("/api/v1/conversations/sync-whatsapp/delta")
                assert res.status_code == 200, res.text
                data = res.json()
                assert data["status"] == "success"
                assert data["synced_count"] == 1
    finally:
        app.dependency_overrides.clear()
