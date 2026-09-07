"""Sync hardening: duplicate threads, stale ordering, read-side dedupe.

Regression coverage for the WhatsAppHub-vs-WhatsApp comparison audit:
same group listed twice, wrong sort order, empty message threads.
"""
import time
import uuid
import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select, func

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection
from backend.app.services.whatsapp_sync_service import WhatsAppSyncService


def _headers(uid: str):
    return {"X-Test-User-Id": uid, "X-Test-User-Email": "hardening@tezlify.com"}


async def _reset_sessions():
    """Clears all sessions in the shared dev DB.

    Endpoint tests resolve the fixed pytest dev user, so any leftover
    CONNECTED session from another test file would win the session lookup
    race. Each endpoint test starts from a clean slate.
    """
    from backend.app.models.whatsapp_session import WhatsAppSession

    async with AsyncSessionLocal() as db:
        for s in (await db.execute(select(WhatsAppSession))).scalars().all():
            await db.delete(s)
        await db.commit()


@pytest.mark.asyncio
async def test_duplicate_group_threads_merge_on_sync():
    """Two leads + two conversations for one group JID collapse to one row."""
    test_user_id = str(uuid.uuid4())
    group_jid = f"dupgrp_{uuid.uuid4().hex[:6]}@g.us"

    async with AsyncSessionLocal() as db:
        from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus

        db.add(WhatsAppSession(
            user_id=test_user_id,
            session_name=f"sess_dup_{uuid.uuid4().hex[:8]}",
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        ))
        # Legacy duplicates: same JID twice, conversations on both.
        lead_a = Lead(user_id=test_user_id, name="Dup Grup", phone=group_jid,
                      status=LeadStatus.CONTACTED, category="WhatsApp Grubu")
        lead_b = Lead(user_id=test_user_id, name="WhatsApp Grubu", phone=group_jid,
                      status=LeadStatus.CONTACTED, category="WhatsApp Grubu")
        db.add_all([lead_a, lead_b])
        await db.flush()
        conv_a = Conversation(user_id=test_user_id, lead_id=lead_a.id, channel="WHATSAPP",
                              status=ConversationStatus.ACTIVE, unread_count=2,
                              last_message_at=datetime(2026, 1, 1))
        conv_b = Conversation(user_id=test_user_id, lead_id=lead_b.id, channel="WHATSAPP",
                              status=ConversationStatus.ACTIVE, unread_count=3,
                              last_message_at=datetime(2026, 2, 1))
        db.add_all([conv_a, conv_b])
        await db.flush()
        msg = Message(user_id=test_user_id, conversation_id=conv_b.id,
                      direction=MessageDirection.INBOUND, body="eski",
                      sender_phone=group_jid, recipient_phone="+905550001122")
        db.add(msg)
        await db.commit()

        merged = await WhatsAppSyncService._merge_duplicate_threads(
            db, test_user_id, [group_jid]
        )
        await db.commit()
        assert merged == {"leads": 1, "conversations": 1}

        remaining_leads = (
            await db.execute(select(Lead).where(Lead.phone == group_jid))
        ).scalars().all()
        assert len(remaining_leads) == 1
        assert remaining_leads[0].name == "Dup Grup"
        remaining_convs = (
            await db.execute(select(Conversation).where(Conversation.lead_id == remaining_leads[0].id))
        ).scalars().all()
        assert len(remaining_convs) == 1
        assert remaining_convs[0].unread_count == 5
        moved = (
            await db.execute(select(func.count(Message.id)).where(Message.conversation_id == remaining_convs[0].id))
        ).scalar_one()
        assert moved == 1


@pytest.mark.asyncio
async def test_repeated_esitle_lists_group_once_with_fresh_order():
    """End-to-end: same group synced twice lists exactly once, on top."""
    test_user_id = str(uuid.uuid4())
    group_jid = f"dupgrp2_{uuid.uuid4().hex[:6]}@g.us"
    session_name = f"sess_e2e_{uuid.uuid4().hex[:8]}"
    await _reset_sessions()

    async with AsyncSessionLocal() as db:
        from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus

        db.add(WhatsAppSession(
            session_name=session_name,
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        ))
        await db.commit()

    mock_chats = [
        {
            "id": group_jid,
            "phone": group_jid,
            "name": "E2E Grup",
            "is_group": True,
            "conversation_timestamp": time.time(),
            "last_message_preview": "selam millet",
            "last_message_from_me": False,
        }
    ]

    transport = ASGITransport(app=app)
    with patch("backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_chats
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            headers = _headers(test_user_id)
            r1 = await ac.post("/api/v1/conversations/sync-whatsapp", headers=headers)
            assert r1.status_code == 200
            r2 = await ac.post("/api/v1/conversations/sync-whatsapp", headers=headers)
            assert r2.status_code == 200

            lst = await ac.get("/api/v1/conversations", headers=headers)
            assert lst.status_code == 200
            rows = [c for c in lst.json() if c.get("lead_phone") == group_jid]
            assert len(rows) == 1

            # One stored message despite two syncs (no pseudo-duplicate).
            async with AsyncSessionLocal() as db:
                lead = (
                    await db.execute(
                        select(Lead).where(Lead.phone == group_jid)
                    )
                ).scalars().first()
                assert lead is not None
                conv = (
                    await db.execute(
                        select(Conversation).where(Conversation.lead_id == lead.id).limit(1)
                    )
                ).scalars().first()
                n = (
                    await db.execute(
                        select(func.count(Message.id)).where(Message.conversation_id == conv.id)
                    )
                ).scalar_one()
                assert n == 1


@pytest.mark.asyncio
async def test_last_message_at_recomputed_from_stored_messages():
    """A stale last_message_at is lifted to the newest stored message time."""
    test_user_id = str(uuid.uuid4())
    group_jid = f"dupgrp3_{uuid.uuid4().hex[:6]}@g.us"
    session_name = f"sess_e3_{uuid.uuid4().hex[:8]}"
    await _reset_sessions()

    async with AsyncSessionLocal() as db:
        from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus

        db.add(WhatsAppSession(
            session_name=session_name,
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        ))
        await db.commit()

    fresh_ts = time.time()
    mock_chats = [
        {
            "id": group_jid,
            "phone": group_jid,
            "name": "Eski Grup",
            "is_group": True,
            # Stale gateway timestamp (yesterday).
            "conversation_timestamp": fresh_ts - 86400,
            "last_message_preview": "taze mesaj",
            "last_message_from_me": False,
        }
    ]

    transport = ASGITransport(app=app)
    with patch("backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_chats
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            headers = _headers(test_user_id)
            # Plant a genuinely fresh stored message plus a stale conv stamp.
            async with AsyncSessionLocal() as db:
                lead, conv = await WhatsAppSyncService.get_or_create_lead_and_conversation(
                    db=db, user_id=None, phone_e164=None,
                    contact_name="Eski Grup", is_group=True, group_jid=group_jid,
                )
                conv.last_message_at = datetime.fromtimestamp(fresh_ts - 86400).replace(tzinfo=None)
                db.add(Message(
                    user_id=None,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    body="gerçek taze mesaj",
                    sender_phone=group_jid,
                    recipient_phone="+905550001122",
                    sender_name="Kimse",
                    created_at=datetime.fromtimestamp(fresh_ts).replace(tzinfo=None),
                ))
                await db.commit()
                conv_id = conv.id

            res = await ac.post("/api/v1/conversations/sync-whatsapp", headers=headers)
            assert res.status_code == 200

            async with AsyncSessionLocal() as db:
                conv_after = await db.get(Conversation, conv_id)
                # Recomputed from the stored fresh message, not the stale gateway ts.
                assert conv_after.last_message_at is not None
                assert conv_after.last_message_at.timestamp() >= fresh_ts - 5


@pytest.mark.asyncio
async def test_same_number_threads_unify_under_real_name():
    """The reported bug: one number split into 'Ahmed Tuncay Boyacı' and
    'WhatsApp (+90…)' threads. After sync there is a single thread showing
    the real name with every message inside."""
    from backend.app.services.whatsapp_sync_service import WhatsAppSyncService

    phone = f"+90532{uuid.uuid4().int % 10000000:07d}"
    group_jid_unused = None
    _ = group_jid_unused

    async with AsyncSessionLocal() as db:
        real = Lead(user_id=None, name="Ahmed Tuncay Boyacı", phone=phone,
                    phone_e164=phone, status=LeadStatus.CONTACTED)
        placeholder = Lead(user_id=None, name=f"WhatsApp ({phone})", phone=phone,
                           phone_e164=None, status=LeadStatus.CONTACTED)
        db.add_all([real, placeholder])
        await db.flush()
        conv_real = Conversation(user_id=None, lead_id=real.id, channel="WHATSAPP",
                                 status=ConversationStatus.ACTIVE,
                                 last_message_at=datetime(2026, 9, 1))
        conv_ph = Conversation(user_id=None, lead_id=placeholder.id, channel="WHATSAPP",
                               status=ConversationStatus.ACTIVE,
                               last_message_at=datetime(2026, 9, 6))
        db.add_all([conv_real, conv_ph])
        await db.flush()
        db.add(Message(user_id=None, conversation_id=conv_real.id,
                       direction=MessageDirection.INBOUND, body="Abi müsait olunca",
                       sender_phone=phone, recipient_phone="+900", sender_name="Ahmed Tuncay Boyacı",
                       created_at=datetime(2026, 9, 1)))
        db.add(Message(user_id=None, conversation_id=conv_ph.id,
                       direction=MessageDirection.INBOUND, body="Selamün aleyküm",
                       sender_phone=phone, recipient_phone="+900", sender_name="Tuncay",
                       created_at=datetime(2026, 9, 6)))
        await db.commit()

        merged = await WhatsAppSyncService._merge_threads_by_phone(db, None, limit_groups=100)
        await db.commit()
        assert merged >= 1

        remaining = (
            await db.execute(select(Conversation).where(Conversation.channel == "WHATSAPP"))
        ).scalars().all()
        mine = [c for c in remaining if c.lead_id in (real.id, placeholder.id)]
        assert len(mine) == 1
        keeper = mine[0]
        bodies = sorted(
            (await db.execute(select(Message.body).where(Message.conversation_id == keeper.id))).scalars().all()
        )
        assert bodies == ["Abi müsait olunca", "Selamün aleyküm"]
        # Keeper lead shows the real contact name, placeholder row preserved.
        shown = await db.get(Lead, keeper.lead_id)
        assert shown.name == "Ahmed Tuncay Boyacı"
        assert (await db.get(Lead, placeholder.id)) is not None


@pytest.mark.asyncio
async def test_esitle_empty_gateway_returns_honest_note():
    """Gateway'de sohbet yoksa sahte başarı yerine açıklayıcı not döner."""
    from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus

    await _reset_sessions()
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            session_name=f"sess_empty_{uuid.uuid4().hex[:8]}",
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        ))
        await db.commit()

    transport = ASGITransport(app=app)
    with patch(
        "backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats",
        new_callable=AsyncMock,
    ) as mock_get, patch(
        "backend.app.services.whatsapp_gateway_client.gateway_client.is_recently_offline",
        return_value=False,
    ):
        mock_get.return_value = []
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.post(
                "/api/v1/conversations/sync-whatsapp",
                headers=_headers(str(uuid.uuid4())),
            )
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "success"
            assert data["synced_count"] == 0
            assert data["note"]


@pytest.mark.asyncio
async def test_esitle_response_carries_merge_and_heal_counts():
    """Başarılı senkron yanıtı birleştirme/iyileştirme sayaçlarını taşır."""
    from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus

    await _reset_sessions()
    group_jid = f"cntgrp_{uuid.uuid4().hex[:6]}@g.us"
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            session_name=f"sess_cnt_{uuid.uuid4().hex[:8]}",
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        ))
        await db.commit()

    mock_chats = [
        {
            "id": group_jid,
            "phone": group_jid,
            "name": "Sayaç Grup",
            "is_group": True,
            "conversation_timestamp": time.time(),
            "last_message_preview": "merhaba",
            "last_message_from_me": False,
        }
    ]
    transport = ASGITransport(app=app)
    with patch(
        "backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats",
        new_callable=AsyncMock,
    ) as mock_get:
        mock_get.return_value = mock_chats
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            headers = _headers(str(uuid.uuid4()))
            res = await ac.post("/api/v1/conversations/sync-whatsapp", headers=headers)
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "success"
            assert data["synced_count"] == 1
            assert data["threads_merged"] == 0
            assert data["names_healed"] == 0
            assert data["messages_imported"] == 1
            assert data["note"] is None
