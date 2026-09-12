"""Faz 8 — İSİM çözümlenmesi testleri (bireysel kişiler + gruplar).

Kapsanan senaryolar (mega-spec §22):
1. jid_to_phone grup JID'inden (@g.us) asla telefon türetmez (RC-4).
2. _NAME_RANK group_subject içerir; öncelik addressbook > group_subject/verified
   > history > push > phone (§4-5, §7).
3. Grup sohbeti: subject gelirse kullanıcı subject'i görür, `120363...@g.us` DEĞİL (§7).
4. contact_synced (addressbook, yüksek rütbe) → satır YOKSA oluşturulur (§15, RC-1).
5. contact_synced (düşük rütbe push) → satır yoksa oluşturulMAZ (şişirme yok).
6. session_sync_completed → paylaşılmış sync_conversations pipeline'ı tetiklenir (§16, RC-5).
7. sync_conversations → gateway'den grup subject'lerini ister; hata fail-soft (§16).
8. WS broadcast payload'ında ham jid/lid isim olarak DB'ye yazılmaz (§3, RC-3).
9. Perf: 1000 rehber kişisi tek sync'te hydrate edilir (§20-21).
10. Gerçek zamanlı grup yeniden adlandırma: conversation_updated(group_subject)
    subject'i günceller ama addressbook adını ezmez (§17).
"""
import asyncio
import uuid as _uuid
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp_service import (
    _NAME_RANK,
    _is_raw_jid_name,
    _set_contact_name,
    ingest_gateway_event,
    jid_to_phone,
    list_conversations,
    sync_conversations,
)

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
SYS_USER_HEX = "00000000000000000000000000000000"
MOCK_PHONE = "+905321002030"
MOCK_JID = "905321002030@s.whatsapp.net"
LID_JID = "62771114836011@lid"
GROUP_JID = "120363012345678901@g.us"
GROUP_PHONE_SENTINEL = f"jid:{GROUP_JID}"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    """Her testten önce/sonra bu modülün WhatsApp verilerini temizle."""
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(text(
                "DELETE FROM messages WHERE user_id IN (:h1, :h2)"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.execute(text(
                "DELETE FROM conversations WHERE user_id IN (:h1, :h2) AND channel = 'WHATSAPP'"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.execute(text(
                "DELETE FROM contacts WHERE user_id IN (:h1, :h2)"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.execute(text(
                "DELETE FROM whatsapp_sessions WHERE user_id IN (:h1, :h2)"
            ), {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.commit()

    await _wipe()
    yield
    await _wipe()


# ---------------------------------------------------------------------------
# 1. jid_to_phone: grup JID'inden telefon türetilmez (RC-4, AGENTS.md)
# ---------------------------------------------------------------------------

def test_jid_to_phone_rejects_group_jid():
    assert jid_to_phone(GROUP_JID) is None
    assert jid_to_phone(LID_JID) is None
    assert jid_to_phone(MOCK_JID) == MOCK_PHONE


# ---------------------------------------------------------------------------
# 2. _NAME_RANK: group_subject mevcut ve doğru sırada (§4-5, §7)
# ---------------------------------------------------------------------------

def test_name_rank_includes_group_subject():
    assert "group_subject" in _NAME_RANK
    assert _NAME_RANK["addressbook"] > _NAME_RANK["group_subject"]
    assert _NAME_RANK["group_subject"] >= _NAME_RANK["verified"]
    assert _NAME_RANK["group_subject"] > _NAME_RANK["history"]
    assert _NAME_RANK["history"] > _NAME_RANK["push"] > _NAME_RANK["phone"]


def test_set_contact_name_group_subject_beats_history_and_push():
    c = Contact(display_name="Eski push", phone_e164=GROUP_PHONE_SENTINEL,
                custom_attributes={"name_source": "push"})
    assert _set_contact_name(c, "İstanbul İş Grubu", "group_subject") is True
    assert c.display_name == "İstanbul İş Grubu"
    # addressbook (5) > group_subject (4): rehber adı kazanır
    assert _set_contact_name(c, "Rehber Grubu", "addressbook") is True
    assert c.display_name == "Rehber Grubu"
    # daha düşük rütbe mevcut adı ezmez
    assert _set_contact_name(c, "Gecmis Ad", "history") is False
    assert c.display_name == "Rehber Grubu"


def test_set_contact_name_rejects_raw_jid():
    c = Contact(display_name=None, phone_e164=GROUP_PHONE_SENTINEL)
    assert _set_contact_name(c, GROUP_JID, "group_subject") is False
    assert c.display_name is None


# ---------------------------------------------------------------------------
# 3. Grup sohbeti: subject gösterilir, ham @g.us DEĞİL (§7)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_group_conversation_displays_subject_not_raw_jid():
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=GROUP_PHONE_SENTINEL,
                          display_name="İstanbul İş Grubu",
                          custom_attributes={"name_source": "group_subject"})
        db.add(contact)
        await db.flush()
        conv = Conversation(user_id=TEST_USER, contact_id=contact.id,
                            channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db.add(conv)
        await db.commit()
        items, _total = await list_conversations(db, TEST_USER)

    row = next(i for i in items if i["is_group"])
    assert row["name"] == "İstanbul İş Grubu"
    assert not _is_raw_jid_name(row["name"])


# ---------------------------------------------------------------------------
# 4-5. contact_synced create-if-missing (RC-1, §15)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_contact_synced_creates_row_for_high_rank_name():
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=gw_id,
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()

    event = {
        "event": "contact_synced",
        "contact": {"id": MOCK_JID, "name": "Rehberdeki Ayşe", "name_source": "addressbook"},
    }
    await ingest_gateway_event(event)

    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(Contact.phone_e164 == MOCK_PHONE)
        )).scalar_one_or_none()
    assert contact is not None  # satır OLUŞTURULDU (Faz 7'de return edilirdi)
    assert contact.display_name == "Rehberdeki Ayşe"


@pytest.mark.asyncio
async def test_contact_synced_does_not_create_for_low_rank_push():
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=gw_id,
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()

    event = {
        "event": "contact_synced",
        "contact": {"id": "9999999999@s.whatsapp.net", "name": "PushName Kişisi", "name_source": "push"},
    }
    await ingest_gateway_event(event)

    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(Contact.phone_e164 == "+9999999999")
        )).scalar_one_or_none()
    assert contact is None  # düşük rütbe satır şişirmez


@pytest.mark.asyncio
async def test_contact_synced_updates_existing_low_rank():
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        existing = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name=MOCK_PHONE,
                           custom_attributes={"name_source": "phone"})
        db.add(existing)
        await db.commit()

    event = {
        "event": "contact_synced",
        "contact": {"id": MOCK_JID, "name": "Profil Adı", "name_source": "push"},
    }
    await ingest_gateway_event(event)

    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(Contact.phone_e164 == MOCK_PHONE)
        )).scalar_one()
    # mevcut satırın telefon görünümlü adı push ile düzelir
    assert contact.display_name == "Profil Adı"


# ---------------------------------------------------------------------------
# 6. session_sync_completed → paylaşılmış pipeline tetiklenir (§16, RC-5)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_session_sync_completed_schedules_hydration():
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=gw_id,
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()

    called = {}

    async def fake_run(owner):
        called["owner"] = owner

    with patch.object(ws, "_run_initial_sync", new=fake_run), \
         patch.object(ws, "_initial_sync_inflight", new=set()):
        event = {"event": "session_sync_completed", "session_id": gw_id, "sync": {"phase": "ready"}}
        await ingest_gateway_event(event)
        for _ in range(5):
            await asyncio.sleep(0)  # create_task'ın çalışması için
    assert called.get("owner") in (TEST_USER, TEST_USER_HEX)


# ---------------------------------------------------------------------------
# 7. sync_conversations grup subject'lerini ister; hata fail-soft (§16)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_conversations_requests_group_subjects():
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.sync_group_subjects", new_callable=AsyncMock) as sgs, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.return_value = []
            sgs.return_value = {"success": True}
            lconv.return_value = {"items": [{"jid": GROUP_JID, "name": "İstanbul İş Grubu",
                                             "name_source": "group_subject"}], "total": 1}
            gm.return_value = {"messages": [], "has_more": False}
            result = await sync_conversations(db, TEST_USER)
            sgs.assert_awaited()
    assert any(i["is_group"] and i["name"] == "İstanbul İş Grubu" for i in result)


@pytest.mark.asyncio
async def test_sync_conversations_survives_group_subject_failure():
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.sync_group_subjects", new_callable=AsyncMock) as sgs, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.return_value = []
            sgs.side_effect = RuntimeError("gateway grup hatası")
            lconv.return_value = {"items": [{"jid": MOCK_JID, "name": "Ali", "name_source": "addressbook"}], "total": 1}
            gm.return_value = {"messages": [], "has_more": False}
            result = await sync_conversations(db, TEST_USER)  # exception BEKLENMEZ
    assert any(i["phone"] == MOCK_PHONE for i in result)


# ---------------------------------------------------------------------------
# 8. WS broadcast: ham jid/lid DB'ye ad olarak yazılmaz (§3, RC-3)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_conversation_updated_raw_name_not_persisted():
    # Gateway sanitize etmese bile backend ham @g.us adını reddeder:
    event = {
        "event": "conversation_updated",
        "conversation_id": GROUP_JID,
        "conversation": {"id": GROUP_JID, "name": GROUP_JID, "name_source": "group_subject"},
    }
    await ingest_gateway_event(event)

    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(Contact.phone_e164 == GROUP_PHONE_SENTINEL)
        )).scalar_one_or_none()
    assert contact is None or not _is_raw_jid_name(contact.display_name)


# ---------------------------------------------------------------------------
# 9. Perf: 1000 rehber kişisi tek sync'te hydrate edilir (§20-21)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_1000_contacts_perf():
    contacts = [
        {"id": f"9055500{idx:05d}@s.whatsapp.net", "name": f"Kişi {idx}", "name_source": "addressbook"}
        for idx in range(1000)
    ]
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.sync_group_subjects", new_callable=AsyncMock) as sgs, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.return_value = contacts
            sgs.return_value = {"success": True}
            lconv.return_value = {"items": [], "total": 0}
            gm.return_value = {"messages": [], "has_more": False}
            import time as _time
            t0 = _time.perf_counter()
            await sync_conversations(db, TEST_USER)
            elapsed = _time.perf_counter() - t0
    async with AsyncSessionLocal() as db:
        count = (await db.execute(
            text("SELECT COUNT(*) FROM contacts WHERE user_id = :h AND phone_e164 LIKE '+90555%'"),
            {"h": TEST_USER_HEX},
        )).scalar_one()
    assert count == 1000
    assert elapsed < 30.0  # 1000 kişi makul sürede (CI tamponu)


# ---------------------------------------------------------------------------
# 10. Gerçek zamanlı grup yeniden adlandırma (§17)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_group_rename_updates_subject_keeps_addressbook():
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        contact = Contact(user_id=TEST_USER, phone_e164=GROUP_PHONE_SENTINEL,
                          display_name="İstanbul İş Grubu",
                          custom_attributes={"name_source": "group_subject"})
        db.add(contact)
        await db.commit()

    # group_subject → group_subject: eşit rütbe (>= kuralı), yeni ad yazılır
    await ingest_gateway_event({
        "event": "conversation_updated",
        "conversation_id": GROUP_JID,
        "conversation": {"id": GROUP_JID, "name": "Ankara Ekip Grubu", "name_source": "group_subject"},
    })
    async with AsyncSessionLocal() as db:
        c = (await db.execute(select(Contact).where(Contact.phone_e164 == GROUP_PHONE_SENTINEL))).scalar_one()
        assert c.display_name == "Ankara Ekip Grubu"

    # addressbook daha yüksek rütbe: subject'i ezebilir (rehber adı öncelikli)
    await ingest_gateway_event({
        "event": "conversation_updated",
        "conversation_id": GROUP_JID,
        "conversation": {"id": GROUP_JID, "name": "Rehberdeki Grup", "name_source": "addressbook"},
    })
    async with AsyncSessionLocal() as db:
        c = (await db.execute(select(Contact).where(Contact.phone_e164 == GROUP_PHONE_SENTINEL))).scalar_one()
        assert c.display_name == "Rehberdeki Grup"

    # düşük rütbeli push mevcut addressbook adını ezmez
    await ingest_gateway_event({
        "event": "conversation_updated",
        "conversation_id": GROUP_JID,
        "conversation": {"id": GROUP_JID, "name": "Push Grup", "name_source": "push"},
    })
    async with AsyncSessionLocal() as db:
        c = (await db.execute(select(Contact).where(Contact.phone_e164 == GROUP_PHONE_SENTINEL))).scalar_one()
        assert c.display_name == "Rehberdeki Grup"
