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
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message, MessageDirection
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
async def test_sync_chats_merges_verified_lid_alias_conversation():
    test_user = str(uuid.uuid4())
    test_sess = f"lid_{uuid.uuid4().hex[:8]}"
    phone = f"+9053{uuid.uuid4().int % 100000000:08d}"
    phone_jid = f"{phone[1:]}@s.whatsapp.net"
    lid_jid = f"{uuid.uuid4().int % 10**15}@lid"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess,
            phone_number="+905551234567",
            status=SessionStatus.CONNECTED,
        )
        canonical_lead = Lead(
            user_id=test_user,
            name="Cevat Aydin",
            phone=phone,
            phone_e164=phone,
            place_id=f"phone_{uuid.uuid4().hex}",
            custom_data={
                "whatsapp_jid": phone_jid,
                "whatsapp_session_name": test_sess,
            },
        )
        alias_lead = Lead(
            user_id=test_user,
            name="lazury",
            phone=lid_jid,
            phone_e164=None,
            place_id=f"lid_{uuid.uuid4().hex}",
            custom_data={
                "whatsapp_jid": lid_jid,
                "whatsapp_session_name": test_sess,
            },
        )
        db.add_all([session, canonical_lead, alias_lead])
        await db.flush()
        canonical_conv = Conversation(
            user_id=test_user, lead_id=canonical_lead.id, channel="WHATSAPP"
        )
        alias_conv = Conversation(
            user_id=test_user, lead_id=alias_lead.id, channel="WHATSAPP", unread_count=1
        )
        db.add_all([canonical_conv, alias_conv])
        await db.flush()
        db.add_all([
            Message(
                user_id=test_user,
                conversation_id=canonical_conv.id,
                direction=MessageDirection.OUTBOUND,
                body="Giden mesaj",
                sender_phone=session.phone_number,
                recipient_phone=phone,
            ),
            Message(
                user_id=test_user,
                conversation_id=alias_conv.id,
                direction=MessageDirection.INBOUND,
                body="Gelen mesaj",
                sender_phone=phone,
                recipient_phone=session.phone_number,
            ),
        ])
        await db.commit()

        report = await WhatsAppChatSyncService.sync_chats(
            db=db,
            session=session,
            chats=[
                _make_chat(
                    phone_jid,
                    "Cevat Aydin",
                    phone=phone,
                    jid_aliases=[lid_jid],
                    last_message="Gelen mesaj",
                )
            ],
        )

        assert not report.errors
        conversations = (
            await db.execute(
                select(Conversation).where(Conversation.lead_id == canonical_lead.id)
            )
        ).scalars().all()
        assert len(conversations) == 1
        bodies = (
            await db.execute(
                select(Message.body).where(Message.conversation_id == conversations[0].id)
            )
        ).scalars().all()
        assert set(bodies) == {"Giden mesaj", "Gelen mesaj"}
        assert await db.get(Lead, alias_lead.id) is None


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


@pytest.mark.asyncio
async def test_cevat_aydin_lazury_lid_deduplication_and_merge():
    """
    Tests the real-world scenario reported by user:
    1. Lead 'Cevat Aydın' exists with phone and outbound message 'selam'.
    2. A duplicate lead 'Lazury' with LID/phone exists with inbound message 'aleykumselam tatlım'.
    3. Bulk sync receives consolidated chat from gateway with canonical phone JID and jid_aliases=[lazury_lid].
    4. Assert: 'Lazury' lead and conversation are cleanly merged and deleted.
    5. 'Cevat Aydın' conversation retains both messages in unified thread and updates preview.
    """
    test_user = str(uuid.uuid4())
    test_sess = f"sess_cevat_{uuid.uuid4().hex[:8]}"

    cevat_phone = f"+90507{uuid.uuid4().int % 10000000:07d}"
    phone_jid = f"{cevat_phone.lstrip('+')}@s.whatsapp.net"
    lazury_lid = f"{uuid.uuid4().int % 1000000000000000:015d}@lid"
    lazury_fake_phone = f"+{lazury_lid.split('@')[0]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess,
            phone_number="+905551112233",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.flush()

        # 1. Cevat Aydın lead and conversation
        cevat_lead = Lead(
            user_id=test_user,
            name="Cevat Aydın",
            phone=cevat_phone,
            phone_e164=cevat_phone,
            place_id=f"wa_{uuid.uuid4().hex[:12]}",
            category="WhatsApp Kişisi",
            custom_data={"whatsapp_session_name": test_sess}
        )
        db.add(cevat_lead)
        await db.flush()

        cevat_conv = Conversation(
            user_id=test_user,
            lead_id=cevat_lead.id,
            channel="WHATSAPP",
            last_message_preview="selam",
            unread_count=0
        )
        db.add(cevat_conv)
        await db.flush()

        cevat_msg = Message(
            user_id=test_user,
            conversation_id=cevat_conv.id,
            direction=MessageDirection.OUTBOUND,
            body="selam",
            sender_phone="+905551112233",
            recipient_phone=cevat_phone,
            sender_name="Tezlify User"
        )
        db.add(cevat_msg)

        # 2. Duplicate Lazury lead and conversation
        lazury_lead = Lead(
            user_id=test_user,
            name="Lazury",
            phone=lazury_fake_phone,
            phone_e164=lazury_fake_phone,
            place_id=f"wa_{uuid.uuid4().hex[:12]}",
            category="WhatsApp Kişisi",
            custom_data={"whatsapp_jid": lazury_lid, "whatsapp_session_name": test_sess}
        )
        db.add(lazury_lead)
        await db.flush()

        lazury_conv = Conversation(
            user_id=test_user,
            lead_id=lazury_lead.id,
            channel="WHATSAPP",
            last_message_preview="aleykumselam tatlım",
            unread_count=1
        )
        db.add(lazury_conv)
        await db.flush()

        lazury_msg1 = Message(
            user_id=test_user,
            conversation_id=lazury_conv.id,
            direction=MessageDirection.INBOUND,
            body="İbinalık yapma",
            sender_phone=lazury_lid,
            recipient_phone="+905551112233",
            sender_name="Lazury"
        )
        lazury_msg2 = Message(
            user_id=test_user,
            conversation_id=lazury_conv.id,
            direction=MessageDirection.INBOUND,
            body="aleykumselam tatlım",
            sender_phone=lazury_lid,
            recipient_phone="+905551112233",
            sender_name="Lazury"
        )
        db.add_all([lazury_msg1, lazury_msg2])
        await db.commit()

        cevat_lead_id = cevat_lead.id
        lazury_lead_id = lazury_lead.id
        cevat_conv_id = cevat_conv.id
        lazury_conv_id = lazury_conv.id

    # 3. Gateway sync arrives with consolidated Cevat Aydın chat and jid_aliases=[lazury_lid]
    consolidated_chat = {
        "id": phone_jid,
        "jid": phone_jid,
        "phone": cevat_phone,
        "name": "Cevat Aydın",
        "push_name": "Lazury",
        "last_message": "aleykumselam tatlım",
        "timestamp": 1720000000,
        "unread_count": 1,
        "jid_aliases": [lazury_lid],
    }

    async with AsyncSessionLocal() as db:
        session = await db.get(WhatsAppSession, session.id)
        report = await WhatsAppChatSyncService.sync_chats(db, session, [consolidated_chat])
        assert not report.errors, report.errors

    # 4. Verify that duplicate Lazury lead and conv were deleted and merged
    async with AsyncSessionLocal() as db:
        assert await db.get(Lead, lazury_lead_id) is None, "Duplicate Lazury lead must be deleted"
        assert await db.get(Conversation, lazury_conv_id) is None, "Duplicate Lazury conversation must be deleted"

        cevat_lead_after = await db.get(Lead, cevat_lead_id)
        assert cevat_lead_after is not None
        assert cevat_lead_after.name == "Cevat Aydın"
        assert cevat_lead_after.phone_e164 == cevat_phone
        aliases = (cevat_lead_after.custom_data or {}).get("whatsapp_jid_aliases", [])
        assert lazury_lid in aliases, f"Expected {lazury_lid} in aliases: {aliases}"

        cevat_conv_after = await db.get(Conversation, cevat_conv_id)
        assert cevat_conv_after is not None
        assert cevat_conv_after.last_message_preview == "aleykumselam tatlım"
        assert cevat_conv_after.unread_count == 1

        # Verify all 3 messages are now in Cevat Aydın's conversation!
        msgs = (
            await db.execute(
                select(Message).where(Message.conversation_id == cevat_conv_id).order_by(Message.id.asc())
            )
        ).scalars().all()
        bodies = [m.body for m in msgs]
        assert "selam" in bodies
        assert "İbinalık yapma" in bodies
        assert "aleykumselam tatlım" in bodies
        assert len(msgs) == 3


@pytest.mark.asyncio
async def test_webhook_inbound_routes_lid_alias_to_existing_contact():
    """
    Tests that when an inbound webhook arrives with an LID (whether phone is provided or None),
    it routes directly to the saved contact (Cevat Aydın) without creating a fake Lazury lead.
    """
    test_user = str(uuid.uuid4())
    test_sess = f"sess_hook_{uuid.uuid4().hex[:8]}"
    cevat_phone = f"+90507{uuid.uuid4().int % 10000000:07d}"
    phone_jid = f"{cevat_phone.lstrip('+')}@s.whatsapp.net"
    lazury_lid = f"{uuid.uuid4().int % 1000000000000000:015d}@lid"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess,
            phone_number="+905551112233",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.flush()

        lead = Lead(
            user_id=test_user,
            name="Cevat Aydın",
            phone=cevat_phone,
            phone_e164=cevat_phone,
            place_id=f"wa_{uuid.uuid4().hex[:12]}",
            category="WhatsApp Kişisi",
            custom_data={
                "whatsapp_session_name": test_sess,
                "whatsapp_jid": phone_jid,
                "whatsapp_jid_aliases": [lazury_lid],
            }
        )
        db.add(lead)
        await db.commit()
        lead_id = lead.id

    webhook_payload = {
        "session_name": test_sess,
        "phone": None,  # Phone was hidden/LID
        "wa_jid": phone_jid,
        "lid": lazury_lid,
        "message": "Canlı cevap",
        "push_name": "Lazury"
    }

    from backend.app.core.config import settings
    headers = {"X-Webhook-Secret": settings.WA_GATEWAY_WEBHOOK_SECRET}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.post("/api/v1/whatsapp/webhook/inbound", json=webhook_payload, headers=headers)
        assert res.status_code == 200, res.text

    async with AsyncSessionLocal() as db:
        conv = (
            await db.execute(select(Conversation).where(Conversation.lead_id == lead_id))
        ).scalar_one_or_none()
        assert conv is not None
        assert conv.last_message_preview == "Canlı cevap"

        msg = (
            await db.execute(select(Message).where(Message.conversation_id == conv.id))
        ).scalar_one_or_none()
        assert msg is not None
        assert msg.body == "Canlı cevap"
        assert msg.direction == MessageDirection.INBOUND

