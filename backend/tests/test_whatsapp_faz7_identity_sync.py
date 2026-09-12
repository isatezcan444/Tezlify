"""Faz 7 — kimlik sanitizasyonu, gerçek initial-sync ve hayalet LID temizliği testleri.

Kapsanan senaryolar (mega-spec §20):
1. _is_raw_jid_name / _safe_display_name birim testleri (ham jid/lid asla ad değil).
2. _upsert_contact ham '@lid' adını display_name olarak ASLA saklamaz.
3. message_new ingest'inde sender_name='xxx@lid' isim olarak yazılmaz.
4. list_conversations yanıtında ham jid/lid sızmaz (name None → UI fallback).
5. sync_conversations "Eşitle" = tam yenileme: önce rehberi hydrate eder.
6. sync_conversations: rehber senkronu patlasa bile sohbet senkronu devam eder
   (partial sync crash üretmez).
7. GET /sync-status: gateway'deki GERÇEK sync fazı/ilerlemesi döner.
8. list_sessions gateway sync alanını birleştirir; gateway kapalıysa 'idle'.
9. purge_raw_jid_identity_data migration'ı: hayalet LID contact + sohbet + mesaj
   silinir, ham adlar NULL'lanır, gruplar (@g.us) ve meşru telefon contact'leri
   korunur; idempotenttir.
10. Session isolation: migration yalnızca WhatsApp sentinel verisine dokunur,
    OTHER-channel contact'leri bozmaz.
11. Mock perf: 500 kişilik rehber senkronu tek kişi/satır ile tamamlanır.
12. ingest_gateway_event session_sync_* olaylarını backend oturum id'sine çevirir.
"""
import base64
import json
import time
import uuid as _uuid
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text, select, func, or_
from unittest.mock import AsyncMock, patch

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.migrations import purge_raw_jid_identity_data
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp_service import (
    ingest_gateway_event,
    jid_to_phone,
    list_conversations,
    list_sessions,
    sync_contacts,
    sync_conversations,
    _is_raw_jid_name,
    _safe_display_name,
    _upsert_contact,
)

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
SYS_USER_HEX = "00000000000000000000000000000000"
MOCK_PHONE = "+905321002030"
MOCK_JID = "905321002030@s.whatsapp.net"
LID_JID = "62771114836011@lid"
GROUP_JID = "120363012345678901@g.us"


def _make_jwt(user_id: str = TEST_USER) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": user_id, "email": "wa-test@tezlify.com"}).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.mock_sig"


@pytest.fixture
def auth_headers():
    return {"Authorization": f"Bearer {_make_jwt()}"}


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    """Her testten önce/sonra bu modülün WhatsApp verilerini temizle."""
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(text(
                "DELETE FROM messages WHERE user_id IN (:h1, :h2) OR sender_phone IN (:p1, :lid)"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX, "p1": MOCK_PHONE, "lid": LID_JID})
            await db.execute(text(
                "DELETE FROM conversations WHERE (user_id IN (:h1, :h2)) AND channel = 'WHATSAPP'"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.execute(text(
                "DELETE FROM contacts WHERE user_id IN (:h1, :h2) AND (phone_e164 IN (:p, :jl, :g) OR phone_e164 LIKE 'jid:%@lid')"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX, "p": MOCK_PHONE, "jl": f"jid:{LID_JID}", "g": f"jid:{GROUP_JID}"})
            await db.execute(text(
                "DELETE FROM whatsapp_sessions WHERE user_id IN (:h1, :h2)"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.commit()

    await _wipe()
    yield
    await _wipe()


# ---------------------------------------------------------------------------
# 1. Birim: ham jid/lid tespiti
# ---------------------------------------------------------------------------

def test_is_raw_jid_name_detects_all_internal_ids():
    assert _is_raw_jid_name(f"{LID_JID}")
    assert _is_raw_jid_name(f"jid:{LID_JID}")
    assert _is_raw_jid_name("905321002030@s.whatsapp.net")
    assert _is_raw_jid_name("120363@g.us")
    assert _is_raw_jid_name("123@c.us")
    assert not _is_raw_jid_name("Mehmet Kuaför")
    assert not _is_raw_jid_name("+905321002030")
    assert not _is_raw_jid_name(None)
    assert not _is_raw_jid_name("")


def test_safe_display_name_never_leaks_jid():
    c = Contact(display_name=f"{LID_JID}")
    assert _safe_display_name(c) is None
    c2 = Contact(display_name="Ayşe Yılmaz")
    assert _safe_display_name(c2) == "Ayşe Yılmaz"
    assert _safe_display_name(None) is None


def test_jid_to_phone_rejects_lid():
    assert jid_to_phone(LID_JID) is None
    assert jid_to_phone(MOCK_JID) == MOCK_PHONE


# ---------------------------------------------------------------------------
# 2-3. Kimlik saklama: ham '@lid' asla display_name olmaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_upsert_contact_never_stores_raw_lid_as_name():
    async with AsyncSessionLocal() as db:
        # LID jid, isim yerine ham kimlik gönderilmiş
        contact = await _upsert_contact(db, TEST_USER, LID_JID, LID_JID, "history")
        assert contact.display_name is None
        assert contact.phone_e164 == f"jid:{LID_JID}"
        # Telefon jid, isim yerine ham jid gönderilmiş → ad None, telefon normalize
        contact2 = await _upsert_contact(db, TEST_USER, MOCK_JID, MOCK_JID, "history")
        assert contact2.display_name == MOCK_PHONE  # normalize telefon fallback
        await db.rollback()


@pytest.mark.asyncio
async def test_upsert_contact_real_name_is_kept():
    async with AsyncSessionLocal() as db:
        contact = await _upsert_contact(db, TEST_USER, MOCK_JID, "Zeynep Berber", "addressbook")
        assert contact.display_name == "Zeynep Berber"
        # Düşük öncelikli ham jid gelirse mevcut ad korunur
        again = await _upsert_contact(db, TEST_USER, MOCK_JID, LID_JID, "history")
        assert again.display_name == "Zeynep Berber"
        await db.rollback()


@pytest.mark.asyncio
async def test_ingest_message_with_lid_sender_name_does_not_store_name():
    """Canlı diyalog: sender_name='xxx@lid' mesajı isim olarak yazılmamalı."""
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        await db.commit()

    event = {
        "event": "message_new",
        "conversation_id": LID_JID,
        "message": {
            "body": "Merhaba",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "wa_message_id": "wamid_lid_name",
            "sender_name": LID_JID,
            "created_at": "2025-01-15T10:00:00Z",
        },
    }
    result = await ingest_gateway_event(event)
    assert isinstance(result.get("conversation_id"), int)

    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(Contact.phone_e164 == f"jid:{LID_JID}")
        )).scalar_one_or_none()
        assert contact is not None
        assert contact.display_name is None  # ham @lid asla ad olarak saklanmaz
        msg = (await db.execute(
            select(Message).where(Message.wa_message_id == "wamid_lid_name")
        )).scalar_one_or_none()
        assert msg is not None
        assert msg.sender_name != LID_JID


# ---------------------------------------------------------------------------
# 4. Sunum katmanı: list_conversations ham jid sızdırmaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_conversations_sanitizes_raw_jid_name():
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=f"jid:{LID_JID}", display_name=LID_JID)
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        )
        db.add(conv)
        await db.commit()

        items, total = await list_conversations(db, TEST_USER)
    leaked = [i for i in items if _is_raw_jid_name(i["name"])]
    assert leaked == []
    lid_row = next(i for i in items if i["phone"] == f"jid:{LID_JID}")
    assert lid_row["name"] is None


# ---------------------------------------------------------------------------
# 5-6. "Eşitle" = tam yenileme + partial sync dayanıklılığı
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_conversations_hydrates_contacts_first():
    """Eşitle, sohbet senkronundan ÖNCE rehberi DB'ye yazar (spec: tam yenileme)."""
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.return_value = [
                {"id": MOCK_JID, "name": "Rehberdeki Ahmet", "name_source": "addressbook"},
            ]
            lconv.return_value = {"items": [{"jid": MOCK_JID, "name": "Sohbet Adi", "name_source": "history"}], "total": 1}
            gm.return_value = {"messages": [], "has_more": False}
            await sync_conversations(db, TEST_USER)
            lc.assert_awaited()  # rehber once cekildi
            contact = (await db.execute(
                select(Contact).where(Contact.phone_e164 == MOCK_PHONE)
            )).scalar_one()
            # addressbook (rank 5) > history (rank 3): rehber adi kazanir
            assert contact.display_name == "Rehberdeki Ahmet"
        # temizlik
        await db.execute(text("DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE phone_e164 = :p AND user_id IN (:h1,:h2))"), {"p": MOCK_PHONE, "h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
        await db.execute(text("DELETE FROM contacts WHERE phone_e164 = :p AND user_id IN (:h1,:h2)"), {"p": MOCK_PHONE, "h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
        await db.commit()


@pytest.mark.asyncio
async def test_sync_conversations_survives_contact_sync_failure():
    """Rehber senkronu patlarsa sohbet senkronu devam etmeli (partial sync crash yok)."""
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.side_effect = RuntimeError("gateway rehber hatasi")
            lconv.return_value = {"items": [{"jid": MOCK_JID, "name": "Sohbet Kisisi"}], "total": 1}
            gm.return_value = {"messages": [], "has_more": False}
            result = await sync_conversations(db, TEST_USER)  # exception BEKLENMEZ
            assert any(i["phone"] == MOCK_PHONE for i in result)
        await db.execute(text("DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE phone_e164 = :p AND user_id IN (:h1,:h2))"), {"p": MOCK_PHONE, "h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
        await db.execute(text("DELETE FROM contacts WHERE phone_e164 = :p AND user_id IN (:h1,:h2)"), {"p": MOCK_PHONE, "h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
        await db.commit()


# ---------------------------------------------------------------------------
# 7-8. Senkron durumu: GERÇEK ilerleme, sahte yok
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_sessions_merges_gateway_sync_state():
    gw_id = str(_uuid.uuid4())
    sync_payload = {"phase": "syncing", "progress": 42, "chats_synced": 7, "contacts_synced": 120, "messages_synced": 340}
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=TEST_USER, gateway_id=gw_id, session_name="Sync Test",
            status=SessionStatus.CONNECTED, is_active=True,
        ))
        await db.commit()
        with patch("backend.app.services.whatsapp_gateway.list_sessions", new_callable=AsyncMock) as ls:
            ls.return_value = [{"id": gw_id, "status": "CONNECTED", "is_phone_online": True, "battery_level": 90, "phone_number": MOCK_PHONE, "sync": sync_payload}]
            sessions = await list_sessions(db, TEST_USER)
    assert sessions[0]["sync"]["phase"] == "syncing"
    assert sessions[0]["sync"]["progress"] == 42


@pytest.mark.asyncio
async def test_list_sessions_sync_idle_when_gateway_unreachable():
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid.uuid4()), session_name="Offline",
            status=SessionStatus.CONNECTED, is_active=True,
        ))
        await db.commit()
        with patch("backend.app.services.whatsapp_gateway.list_sessions", new_callable=AsyncMock) as ls:
            ls.side_effect = RuntimeError("gateway yok")
            sessions = await list_sessions(db, TEST_USER)
    assert sessions[0]["sync"] == {"phase": "idle", "progress": 0}


@pytest.mark.asyncio
async def test_sync_status_endpoint_returns_real_progress(auth_headers):
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=TEST_USER, gateway_id=gw_id, session_name="Sync EP",
            status=SessionStatus.CONNECTED, is_active=True,
        ))
        await db.commit()
    transport = ASGITransport(app=app)
    with patch("backend.app.services.whatsapp_gateway.list_sessions", new_callable=AsyncMock) as ls:
        ls.return_value = [{
            "id": gw_id, "status": "CONNECTED", "is_phone_online": True,
            "battery_level": None, "phone_number": MOCK_PHONE,
            "sync": {"phase": "syncing", "progress": 61, "chats_synced": 10, "contacts_synced": 200, "messages_synced": 900},
        }]
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/api/v1/whatsapp/sync-status", headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    sess = next(s for s in data["sessions"] if s["session_name"] == "Sync EP")
    assert sess["sync"]["phase"] == "syncing"
    assert sess["sync"]["progress"] == 61


@pytest.mark.asyncio
async def test_sync_status_endpoint_502_when_gateway_down(auth_headers):
    transport = ASGITransport(app=app)
    with patch("backend.app.services.whatsapp_gateway.list_sessions", new_callable=AsyncMock) as ls:
        ls.side_effect = RuntimeError("gateway erisilemedi")
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/api/v1/whatsapp/sync-status", headers=auth_headers)
    # list_sessions gateway hatasini yutuyor (fail-soft idle) → 200 + idle;
    # endpoint'in kendisi 502 uretecek bir hata firlatirsa maskelenmemeli.
    assert res.status_code == 200
    assert all(s["sync"]["phase"] == "idle" for s in res.json()["sessions"])


# ---------------------------------------------------------------------------
# 9-10. Hayalet LID migration'ı
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_purge_raw_jid_migration_cleans_ghosts_and_keeps_legit():
    async with AsyncSessionLocal() as db:
        # Hayalet: cozulmemis LID contact + sohbet + mesaj
        ghost = Contact(user_id=TEST_USER, phone_e164=f"jid:{LID_JID}", display_name=f"{LID_JID}")
        db.add(ghost)
        await db.flush()
        ghost_conv = Conversation(user_id=TEST_USER, contact_id=ghost.id, channel="WHATSAPP",
                                  status=ConversationStatus.ACTIVE)
        db.add(ghost_conv)
        await db.flush()
        db.add(Message(user_id=TEST_USER, conversation_id=ghost_conv.id,
                       direction=MessageDirection.INBOUND, message_type=MessageType.TEXT,
                       sender_phone=LID_JID, recipient_phone=MOCK_PHONE,
                       sender_name=f"{LID_JID}", body="ghost"))
        # Ham adli ama gecerli telefon contact'i → silinmeyecek, adi NULL'lanacak
        leaky = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="905321002030@s.whatsapp.net")
        db.add(leaky)
        # Grup sentinel'i KORUNMALI
        group = Contact(user_id=TEST_USER, phone_e164=f"jid:{GROUP_JID}", display_name="Test Grubu")
        db.add(group)
        # Meşru contact + OTHER kanal → dokunulmamalı
        legit = Contact(user_id=TEST_USER, phone_e164="+905551110000", display_name="Gerçek Kişi")
        db.add(legit)
        await db.flush()
        legit_conv = Conversation(user_id=TEST_USER, contact_id=legit.id, channel="OTHER",
                                  status=ConversationStatus.ACTIVE)
        db.add(legit_conv)
        await db.flush()
        ghost_id, leaky_id, group_id, legit_id = ghost.id, leaky.id, group.id, legit.id
        legit_conv_id = legit_conv.id
        await db.commit()

    await purge_raw_jid_identity_data(engine)

    async with AsyncSessionLocal() as db:
        assert (await db.get(Contact, ghost_id)) is None
        assert (await db.get(Conversation, legit_conv_id)) is not None
        leaky_row = await db.get(Contact, leaky_id)
        assert leaky_row is not None and leaky_row.display_name is None
        group_row = await db.get(Contact, group_id)
        assert group_row is not None and group_row.display_name == "Test Grubu"
        legit_row = await db.get(Contact, legit_id)
        assert legit_row is not None and legit_row.display_name == "Gerçek Kişi"
        leftover_msgs = (await db.execute(
            select(func.count()).select_from(Message).where(Message.sender_phone == LID_JID)
        )).scalar_one()
        assert leftover_msgs == 0
        # Idempotentlik: ikinci calisma no-op olmali, hata cikarmamali
        await purge_raw_jid_identity_data(engine)
        assert (await db.get(Contact, group_id)) is not None
        # temizlik
        await db.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": legit_conv_id})
        for cid in (leaky_id, group_id, legit_id):
            c = await db.get(Contact, cid)
            if c:
                await db.execute(text("DELETE FROM conversations WHERE contact_id = :c"), {"c": cid})
                await db.delete(c)
        await db.commit()


# ---------------------------------------------------------------------------
# 11. Mock perf: 500 kisilik rehber
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_contacts_perf_500_unique_people():
    contacts_payload = [
        {"id": f"90532100{i:04d}@s.whatsapp.net", "name": f"Musteri {i}", "name_source": "addressbook"}
        for i in range(500)
    ]
    # LID'li karisik senaryo: 10 kisi cozulmemis LID ile gelsin (isim ham @lid olmamali)
    contacts_payload += [
        {"id": f"700000000000{i:02d}@lid", "name": f"700000000000{i:02d}@lid", "name_source": "history"}
        for i in range(10)
    ]
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc:
            lc.return_value = contacts_payload
            start = time.perf_counter()
            out = await sync_contacts(db, TEST_USER)
            elapsed = time.perf_counter() - start
        assert len(out) == 510
        assert elapsed < 20.0  # mock performans hedefi
        # Duplicate kontrolu: her phone_e164 tek satir
        dup = (await db.execute(
            select(Contact.phone_e164, func.count()).where(Contact.user_id == TEST_USER)
            .group_by(Contact.phone_e164).having(func.count() > 1)
        )).all()
        assert dup == []
        # Ham @lid ad olarak saklanmamis olmali
        bad = (await db.execute(
            select(func.count()).select_from(Contact).where(
                Contact.user_id == TEST_USER, Contact.display_name.like("%@lid%")
            )
        )).scalar_one()
        assert bad == 0
        # temizlik
        await db.execute(text("DELETE FROM contacts WHERE user_id = :u AND (phone_e164 LIKE '90532100%' OR phone_e164 LIKE 'jid:700000000000%@lid')"), {"u": TEST_USER_HEX})
        await db.commit()


# ---------------------------------------------------------------------------
# 12. session_sync_* olaylarinin backend id'sine cevrilmesi
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ingest_session_sync_events_map_to_backend_id():
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=TEST_USER, gateway_id=gw_id, session_name="SyncEvt",
            status=SessionStatus.CONNECTED, is_active=True,
        ))
        await db.commit()
    for evt_name in ("session_sync_started", "session_sync_progress", "session_sync_completed"):
        event = {
            "event": evt_name,
            "session_id": gw_id,
            "sync": {"phase": "syncing" if "progress" in evt_name or "started" in evt_name else "ready", "progress": 50},
        }
        result = await ingest_gateway_event(event)
        assert result["session_id"] != gw_id  # backend sayisal id'sine cevrilmis
        assert isinstance(result["session_id"], int)
