"""Faz 9 — Grup isimleri / Geçersiz +0 chat / Sync banner lifecycle testleri.

Mega-spec §28 — gerçek testler. Kapsanan senaryolar:
1. jid_to_phone / is_degenerate_jid: "0@s.whatsapp.net", "+0", "000@..." gibi
   dejenere JID'lerden telefon TÜRETİLMEZ (RC-2 kök neden).
2. _upsert_contact dejenere JID'i reddeder (ValueError) → kayıt OLUŞMAZ.
3. GEÇERSİZ telefonlar ("+0", "0", "000", None, "") contact/conversation ÜRETMEZ.
4. ingest_gateway_event (dejenere jid) → DB'ye hiçbir satır yazılmaz (§6 SADECE
   frontend'de gizleme YOK — pipeline'da engellenir).
5. REGRESYON: geçerli kişi name/phone çözülmesi BOZULMADI (+905321002030).
6. purge_degenerate_phone_contacts: tohumlanan '+0' contact+conversation+messages
   silinir; idempotent; geçerli kayıtlara dokunmaz.
7. Grup sohbeti: jid:...@g.us sentinel + is_group True korunur (çalışmayı bozma).
8. sync_conversations: gateway'den gelen dejenere item'ları atlar.
"""
import uuid as _uuid
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp_service import (
    _upsert_contact,
    ingest_gateway_event,
    is_degenerate_jid,
    jid_to_phone,
    list_conversations,
    sync_conversations,
)
from backend.app.core.migrations import _is_degenerate_phone, purge_degenerate_phone_contacts

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
SYS_USER_HEX = "00000000000000000000000000000000"
MOCK_PHONE = "+905321002030"
MOCK_JID = "905321002030@s.whatsapp.net"
GROUP_JID = "120363012345678901@g.us"
GROUP_PHONE_SENTINEL = f"jid:{GROUP_JID}"
DEGENERATE_JID = "0@s.whatsapp.net"


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
# 1. Dejenere JID'lerden telefon türetilmez (RC-2 kök neden)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_jid", [
    "0@s.whatsapp.net",
    "000@s.whatsapp.net",
    "0000@s.whatsapp.net",
    "0@g.us",
    "0@lid",
])
def test_jid_to_phone_rejects_degenerate_jids(bad_jid):
    # "0" / "+0" asla üretilmemeli (E.164 0 ile başlayamaz)
    assert jid_to_phone(bad_jid) is None


@pytest.mark.parametrize("bad_jid", [
    "0@s.whatsapp.net",
    "000@s.whatsapp.net",
    "123@s.whatsapp.net",   # çok kısa → dejenere
])
def test_is_degenerate_jid_flags_bad(bad_jid):
    assert is_degenerate_jid(bad_jid) is True


@pytest.mark.parametrize("good_jid", [
    MOCK_JID,               # 905321002030
    "15556599459@s.whatsapp.net",
    "12345@s.whatsapp.net",
])
def test_is_degenerate_jid_allows_valid(good_jid):
    assert is_degenerate_jid(good_jid) is False


def test_jid_to_phone_valid_regression():
    # REGRESYON: geçerli numaralar çözülür — mevcut name/phone çalışması bozulmadı
    assert jid_to_phone(MOCK_JID) == MOCK_PHONE
    assert jid_to_phone("15556599459@s.whatsapp.net") == "+15556599459"


def test_is_degenerate_phone_migration_helper():
    assert _is_degenerate_phone("+0") is True
    assert _is_degenerate_phone("+000") is True
    assert _is_degenerate_phone(MOCK_PHONE) is False
    assert _is_degenerate_phone("+15556599459") is False
    assert _is_degenerate_phone(None) is False
    assert _is_degenerate_phone("") is False


# ---------------------------------------------------------------------------
# 2-3. _upsert_contact dejenere/geçersiz JID'i reddeder → kayıt OLUŞMAZ
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_upsert_contact_raises_for_degenerate_jid():
    async with AsyncSessionLocal() as db:
        with pytest.raises(ValueError):
            await _upsert_contact(db, TEST_USER, DEGENERATE_JID, "Bogus", "push")
        await db.rollback()
    async with AsyncSessionLocal() as db:
        n = (await db.execute(
            select(func.count()).select_from(Contact).where(Contact.phone_e164 == "+0")
        )).scalar_one()
    assert n == 0  # "+0" contact ASLA oluşmadı


@pytest.mark.asyncio
async def test_upsert_contact_valid_regression():
    # REGRESYON: geçerli kişi oluşturulur, isim/telefon çözülür
    async with AsyncSessionLocal() as db:
        contact = await _upsert_contact(db, TEST_USER, MOCK_JID, "Yüksel Abi", "addressbook")
        await db.commit()
        assert contact.phone_e164 == MOCK_PHONE
        assert contact.display_name == "Yüksel Abi"


# ---------------------------------------------------------------------------
# 4. ingest_gateway_event dejenere jid → hiçbir satır yazılmaz (§6 pipeline'da engelle)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ingest_contact_synced_degenerate_no_row():
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()

    event = {
        "event": "contact_synced",
        "contact": {"id": DEGENERATE_JID, "name": "Hayalet", "name_source": "push"},
    }
    await ingest_gateway_event(event)  # exception beklenmez (guard'lı)

    async with AsyncSessionLocal() as db:
        n = (await db.execute(
            select(func.count()).select_from(Contact).where(Contact.phone_e164 == "+0")
        )).scalar_one()
    assert n == 0


@pytest.mark.asyncio
async def test_ingest_message_new_degenerate_no_conv():
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()

    event = {
        "event": "message_new",
        "key": {"remoteJid": DEGENERATE_JID, "id": "FAZ9TESTMSG0"},
        "message": {"conversation": "merhaba"},
        "messageType": "text",
        "messageTimestamp": 1700000000,
    }
    await ingest_gateway_event(event)

    async with AsyncSessionLocal() as db:
        n = (await db.execute(
            select(func.count()).select_from(Conversation).where(Conversation.channel == "WHATSAPP")
        )).scalar_one()
        nc = (await db.execute(
            select(func.count()).select_from(Contact).where(Contact.phone_e164 == "+0")
        )).scalar_one()
    assert n == 0 and nc == 0  # +0 chat OLUŞMADI


# ---------------------------------------------------------------------------
# 6. purge_degenerate_phone_contacts: '+0' contact+conv+messages silinir
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_purge_degenerate_contacts_removes_rows():
    # Seed: bir '+0' contact + conversation + message, bir de GEÇERLİ contact
    async with AsyncSessionLocal() as db:
        bad = Contact(user_id=TEST_USER, phone_e164="+0", display_name="+0",
                      custom_attributes={"name_source": "phone"})
        good = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Yüksel Abi",
                       custom_attributes={"name_source": "addressbook"})
        db.add_all([bad, good])
        await db.flush()
        bad_conv = Conversation(user_id=TEST_USER, contact_id=bad.id, channel="WHATSAPP",
                                status=ConversationStatus.ACTIVE)
        good_conv = Conversation(user_id=TEST_USER, contact_id=good.id, channel="WHATSAPP",
                                 status=ConversationStatus.ACTIVE)
        db.add_all([bad_conv, good_conv])
        await db.flush()
        db.add(Message(user_id=TEST_USER, conversation_id=bad_conv.id,
                       direction=MessageDirection.INBOUND, message_type=MessageType.TEXT,
                       body="spam", sender_phone="+0", recipient_phone=MOCK_PHONE))
        await db.commit()
        bad_id = bad.id
        good_id = good.id

    # Run migration purge (async, AsyncEngine alır)
    from backend.app.core.database import engine
    await purge_degenerate_phone_contacts(engine)

    async with AsyncSessionLocal() as db:
        still_bad = (await db.execute(
            select(Contact).where(Contact.id == bad_id)
        )).scalar_one_or_none()
        still_good = (await db.execute(
            select(Contact).where(Contact.id == good_id)
        )).scalar_one_or_none()
    assert still_bad is None       # '+0' contact silindi
    assert still_good is not None  # geçerli kişi KORUNDU

    # Idempotent: ikinci çalıştırma hata vermez, yine 0 '+0'
    await purge_degenerate_phone_contacts(engine)
    async with AsyncSessionLocal() as db:
        n = (await db.execute(
            select(func.count()).select_from(Contact).where(Contact.phone_e164 == "+0")
        )).scalar_one()
    assert n == 0


# ---------------------------------------------------------------------------
# 7. Grup sohbeti sentinel + is_group korunur (regresyon — çalışmayı bozma)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_group_conversation_sentinel_preserved():
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=GROUP_PHONE_SENTINEL,
                          display_name="İstanbul İş Grubu",
                          custom_attributes={"name_source": "group_subject"})
        db.add(contact)
        await db.flush()
        db.add(Conversation(user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
                            status=ConversationStatus.ACTIVE))
        await db.commit()
        items, _total = await list_conversations(db, TEST_USER)
    row = next(i for i in items if i["is_group"])
    assert row["name"] == "İstanbul İş Grubu"
    assert row["phone"] == GROUP_PHONE_SENTINEL  # sentinel korunur (frontend terminal fallback)


# ---------------------------------------------------------------------------
# 8. sync_conversations: gateway'den gelen dejenere item'ları atlar
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_conversations_skips_degenerate_items():
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.sync_group_subjects", new_callable=AsyncMock) as sgs, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.return_value = []
            sgs.return_value = {"success": True}
            lconv.return_value = {
                "items": [
                    {"jid": DEGENERATE_JID, "name": "Hayalet", "name_source": "push"},
                    {"jid": MOCK_JID, "name": "Ali", "name_source": "addressbook"},
                ],
                "total": 2,
            }
            gm.return_value = {"messages": [], "has_more": False}
            result = await sync_conversations(db, TEST_USER)
    phones = {i["phone"] for i in result}
    assert MOCK_PHONE in phones          # geçerli kişi işlendi
    assert "+0" not in phones            # dejenere atlandı
    async with AsyncSessionLocal() as db:
        n = (await db.execute(
            select(func.count()).select_from(Contact).where(Contact.phone_e164 == "+0")
        )).scalar_one()
    assert n == 0
