"""Faz 10 — Kısmen çözülen grup isimleri + chat list son mesaj preview doğruluğu.

Mega-spec senaryoları (gerçek DB testleri, sqlite+aiosqlite):
P1 (grup isimleri):
 1. group_subject metadata "Aile" → displayName "Aile".
 2. Gecikmeli metadata: isim cozulmemis (NULL → UI "Grup") iken gelen
    group_subject olayi mevcut kaydi GUNCELLER (cache poisoning yok).
 3. Oneceden "Grup" yazilmis (eski/legacy) contact, metadata gelince
    ezilir — "Grup" kilitli gercek deger DEGILDIR.
 4. REGRESYON: 1:1 kisi isim cozumu (addressbook > push) bozulmadi.
 5. P1 gizli bug: grup sohbetine gelen mesjin pushName'i GRUP contact'ine
    yazilmaz (member adi grup adi olamaz).
P2 (son mesaj):
 6. 18:20 / 18:25 / 18:31 → preview "Görüşürüz" @ 18:31 (ZAMAN DAMGASI,
    ekleme sirasi degil — ters sirada insert edilse bile).
 7. Grup preview "Ahmet: Toplantıyı yarına aldık." — gonderen cozuluyse.
 8. Gercek bos sohbet → last_message_state NO_MESSAGES; mesajli ama ozetsiz
    sohbet → REPAIRING ("Henüz WhatsApp Mesajı Yok" ASLA yanlis gosterilmez).
 9. Realtime ingest → conversation summary + last_message_at DB'ye yazilir.
10. Eski poison: utcnow()-tohumlu last_message_at + NULL preview →
    _repair_last_message_previews gercek mesaja cevirir.
11. '[IMAGE]' gibi kopeli degerler okuma/aninda etikete normalize edilir.
12. sync_conversations force grup subject + preview onarimini çagrır.
13. Performans: list_conversations mesaj sayilarini TEK agregat sorguda alir
    (sohbet basina N+1 yok) — SQLAlchemy event sayaci ile dogrulanir.
"""
import uuid as _uuid
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import event, func, select, text

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp_service import (
    _apply_last_message,
    _ensure_conversation,
    _repair_last_message_previews,
    _set_contact_name,
    _upsert_contact,
    build_last_message_summary,
    ingest_gateway_event,
    list_conversations,
    sync_conversations,
)

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
SYS_USER_HEX = "00000000000000000000000000000000"
MOCK_PHONE = "+905321002030"
MOCK_JID = "905321002030@s.whatsapp.net"
GROUP_JID = "120363012345678901@g.us"
GROUP_SENTINEL = f"jid:{GROUP_JID}"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    """Her testten once/sonra bu modulun WhatsApp verilerini temizle."""
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


async def _seed_session_and_group(display_name=None, name_source=None, preview=None,
                                  last_message_at=None, poisoned_ts=False):
    """CONNECTED session + grup contact + conversation tohumlar; ids doner."""
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
                               session_name="S", status=SessionStatus.CONNECTED, is_active=True))
        contact = Contact(user_id=TEST_USER, phone_e164=GROUP_SENTINEL,
                          display_name=display_name,
                          custom_attributes={"name_source": name_source} if name_source else {})
        db.add(contact)
        await db.flush()
        conv = Conversation(user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
                             status=ConversationStatus.ACTIVE,
                             last_message_preview=preview,
                             last_message_at=(datetime.utcnow() if poisoned_ts else last_message_at))
        db.add(conv)
        await db.commit()
        return contact.id, conv.id


def _ts(h, m):
    return datetime(2026, 2, 10, h, m, 0)


# ---------------------------------------------------------------------------
# P1.1 — group_subject metadata → displayName
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_group_subject_metadata_sets_display_name():
    contact_id, _ = await _seed_session_and_group()  # isim cozulmemis (NULL → UI "Grup")
    async with AsyncSessionLocal() as db:
        contact = (await db.execute(select(Contact).where(Contact.id == contact_id))).scalar_one()
        changed = _set_contact_name(contact, "Aile", "group_subject")
        await db.commit()
        assert changed is True
        assert contact.display_name == "Aile"


# ---------------------------------------------------------------------------
# P1.2 — gecikmeli metadata: conversation_updated NULL ismi gunceller
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delayed_metadata_updates_unresolved_group():
    contact_id, conv_id = await _seed_session_and_group()
    event = {
        "event": "conversation_updated",
        "conversation_id": GROUP_JID,
        "conversation": {"id": GROUP_JID, "name": "Aile", "name_source": "group_subject"},
    }
    await ingest_gateway_event(event)
    async with AsyncSessionLocal() as db:
        contact = (await db.execute(select(Contact).where(Contact.id == contact_id))).scalar_one()
        assert contact.display_name == "Aile"  # NULL → metadata yazildi
        items, _ = await list_conversations(db, TEST_USER)
    row = next(i for i in items if i["is_group"])
    assert row["name"] == "Aile"


# ---------------------------------------------------------------------------
# P1.3 — onceden "Grup" yazilmis contact metadata ile ezilir (cache poisoning)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_preseeded_grup_label_overwritten_by_metadata():
    # Eski/legacy satirlarda display_name "Grup" kalicilasmis olabilir —
    # group_subject (rutbe 4) history-varsayilan (3) degeri ezer.
    contact_id, _ = await _seed_session_and_group(display_name="Grup")
    async with AsyncSessionLocal() as db:
        contact = (await db.execute(select(Contact).where(Contact.id == contact_id))).scalar_one()
        changed = _set_contact_name(contact, "Aile", "group_subject")
        await db.commit()
    assert changed is True
    async with AsyncSessionLocal() as db:
        contact = (await db.execute(select(Contact).where(Contact.id == contact_id))).scalar_one()
        assert contact.display_name == "Aile"


# ---------------------------------------------------------------------------
# P1.4 — REGRESYON: 1:1 isim onceligi bozulmadi
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_person_name_resolution_regression():
    async with AsyncSessionLocal() as db:
        c1 = await _upsert_contact(db, TEST_USER, MOCK_JID, "Ayşe", "push")
        await db.commit()
        cid = c1.id
    async with AsyncSessionLocal() as db:
        c2 = (await db.execute(select(Contact).where(Contact.id == cid))).scalar_one()
        assert _set_contact_name(c2, "Ayşe Hanım", "addressbook") is True   # rehber push'u ezer
        await db.commit()
    async with AsyncSessionLocal() as db:
        c3 = (await db.execute(select(Contact).where(Contact.id == cid))).scalar_one()
        assert _set_contact_name(c3, "Ayşe", "push") is False               # push rehber adini EZEMEZ
        assert c3.display_name == "Ayşe Hanım"


# ---------------------------------------------------------------------------
# P1.5 — grup mesjinin pushName'i GRUP contact'ine yazilmaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_group_message_does_not_rename_group_contact():
    await _seed_session_and_group()  # grup, ismi cozulmemis
    event = {
        "event": "message_new",
        "conversation_id": GROUP_JID,
        "message": {
            "conversation_id": GROUP_JID,
            "wa_message_id": "FAZ10PUSHNAME01",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "body": "Selamlar",
            "sender_name": "Ahmet",          # bir uyeye ait pushName
            "participant_name": "Ahmet",
            "created_at": "2026-02-10T18:00:00",
        },
    }
    await ingest_gateway_event(event)
    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(Contact.phone_e164 == GROUP_SENTINEL)
        )).scalar_one()
        assert contact.display_name is None  # "Ahmet" GRUP adi OLAMAZ
        items, _ = await list_conversations(db, TEST_USER)
    row = next(i for i in items if i["is_group"])
    assert row["name"] is None  # UI gecenli fallback ("Grup") gosterir, DB'ye sizmadi


# ---------------------------------------------------------------------------
# P2.6 — zaman damgasi siralamasi: 18:31 kazanir (ekleme sirasi onemsiz)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_last_message_by_timestamp_not_insertion_order():
    _contact_id, conv_id = await _seed_session_and_group()
    # Ters sirada yaz: once 18:31, sonra 18:25, en son 18:20 (retry/duplicate senaryosu)
    async with AsyncSessionLocal() as db:
        for ts, body in ((_ts(18, 31), "Görüşürüz"), (_ts(18, 25), "Tamam"), (_ts(18, 20), "Selam")):
            db.add(Message(user_id=TEST_USER, conversation_id=conv_id,
                           direction=MessageDirection.INBOUND, message_type=MessageType.TEXT,
                           body=body, sender_phone=MOCK_PHONE, recipient_phone="ME",
                           external_timestamp=ts))
        await db.commit()
    async with AsyncSessionLocal() as db:
        fixed = await _repair_last_message_previews(db, TEST_USER)
        await db.commit()
    assert fixed == 1
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert conv.last_message_preview == "Görüşürüz"
        assert conv.last_message_at == _ts(18, 31)


# ---------------------------------------------------------------------------
# P2.7 — grup preview "Ahmet: ..." / cozulemeyince yalans govde
# ---------------------------------------------------------------------------

def test_summary_group_sender_prefix_rules():
    assert build_last_message_summary(
        message_type="TEXT", body="Toplantıyı yarına aldık.",
        sender_name="Ahmet", is_group=True, direction="INBOUND",
    ) == "Ahmet: Toplantıyı yarına aldık."
    # ham JID / telefon gorunumlu ad on ek OLMAZ
    assert build_last_message_summary(
        message_type="TEXT", body="Selam",
        sender_name="905321002030@s.whatsapp.net", is_group=True, direction="INBOUND",
    ) == "Selam"
    assert build_last_message_summary(
        message_type="TEXT", body="Selam",
        sender_name="+905321002030", is_group=True, direction="INBOUND",
    ) == "Selam"
    # outbound on ek almaz
    assert build_last_message_summary(
        message_type="TEXT", body="Tamamdır",
        sender_name="Ahmet", is_group=True, direction="OUTBOUND",
    ) == "Tamamdır"


def test_summary_type_normalization():
    assert build_last_message_summary(message_type="IMAGE", body="", is_group=False) == "📷 Fotoğraf"
    assert build_last_message_summary(message_type="AUDIO", body="", is_group=False) == "🎵 Sesli mesaj"
    assert build_last_message_summary(message_type="VIDEO", body="", is_group=False) == "🎥 Video"
    assert build_last_message_summary(message_type="DOCUMENT", body="", is_group=False) == "📄 Dosya"
    assert build_last_message_summary(message_type="STICKER", body="", is_group=False) == "Sticker"
    # eski kopeli degerler etikete normalize edilir — UI'a '[IMAGE]' sizmaz
    assert build_last_message_summary(message_type="TEXT", body="[IMAGE]", is_group=False) == "📷 Fotoğraf"
    assert build_last_message_summary(message_type="TEXT", body="[object Object]", is_group=False) == "Mesaj"
    # bos metin → bos ozet (mevcut ozet silinmez)
    assert build_last_message_summary(message_type="TEXT", body="", is_group=False) == ""


# ---------------------------------------------------------------------------
# P2.8 — NO_MESSAGES vs REPAIRING ayrimi
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_messages_vs_repairing_state():
    empty_contact, empty_conv = await _seed_session_and_group()
    # ikinci sohbet: mesajli ama ozeti hesaplanmadi
    async with AsyncSessionLocal() as db:
        c2 = Contact(user_id=TEST_USER, phone_e164="+905550001122", display_name="Mehmet")
        db.add(c2)
        await db.flush()
        conv2 = Conversation(user_id=TEST_USER, contact_id=c2.id, channel="WHATSAPP",
                             status=ConversationStatus.ACTIVE)
        db.add(conv2)
        await db.flush()
        db.add(Message(user_id=TEST_USER, conversation_id=conv2.id,
                       direction=MessageDirection.INBOUND, message_type=MessageType.TEXT,
                       body="Merhaba", sender_phone="+905550001122", recipient_phone="ME",
                       external_timestamp=_ts(12, 0)))
        await db.commit()
        empty_id, filled_id = empty_conv, conv2.id

    async with AsyncSessionLocal() as db:
        items, _ = await list_conversations(db, TEST_USER)
    by_id = {i["id"]: i for i in items}
    assert by_id[empty_id]["last_message_state"] == "NO_MESSAGES"
    assert by_id[empty_id]["message_count"] == 0
    # Mesaji olan sohbet asla "mesaj yok" durumuna dusemez:
    assert by_id[filled_id]["last_message_state"] == "REPAIRING"
    assert by_id[filled_id]["message_count"] == 1


# ---------------------------------------------------------------------------
# P2.9 — realtime ingest → ozet DB'de
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_realtime_ingest_persists_summary():
    await _seed_session_and_group()
    event = {
        "event": "message_new",
        "conversation_id": GROUP_JID,
        "message": {
            "conversation_id": GROUP_JID,
            "wa_message_id": "FAZ10RT0001",
            "direction": "INBOUND",
            "message_type": "IMAGE",
            "body": "",
            "participant_name": "Ahmet",
            "created_at": "2026-02-10T18:45:00",
        },
    }
    result = await ingest_gateway_event(event)
    assert result["conversation_id"]  # sayisal conv id'ye cevrildi
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(
            select(Conversation).join(Contact, Contact.id == Conversation.contact_id)
            .where(Contact.phone_e164 == GROUP_SENTINEL)
        )).scalar_one()
        assert conv.last_message_preview == "Ahmet: 📷 Fotoğraf"
        assert conv.last_message_at == _ts(18, 45)


@pytest.mark.asyncio
async def test_realtime_older_message_does_not_overwrite():
    _cid, conv_id = await _seed_session_and_group(preview="Görüşürüz", last_message_at=_ts(18, 31))
    event = {
        "event": "message_new",
        "conversation_id": GROUP_JID,
        "message": {
            "conversation_id": GROUP_JID,
            "wa_message_id": "FAZ10OLD0001",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "body": "Eski mesaj retry",
            "participant_name": "Ahmet",
            "created_at": "2026-02-10T18:20:00",
        },
    }
    await ingest_gateway_event(event)
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert conv.last_message_preview == "Görüşürüz"  # daha eskidi, ezmedi
        assert conv.last_message_at == _ts(18, 31)


# ---------------------------------------------------------------------------
# P2.10 — utcnow() poison: creation NULL + repair gercek ts'ye cevirir
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_conversation_created_without_poison_ts():
    async with AsyncSessionLocal() as db:
        conv = await _ensure_conversation(db, TEST_USER, MOCK_JID)
        assert conv.last_message_at is None  # Faz 10 RC-1: gelecek ts tohumlanmaz
        await db.rollback()


@pytest.mark.asyncio
async def test_repair_fixes_poisoned_timestamp():
    # Eski kayit: last_message_at=utcnow() (gelecek/zehirli), preview NULL,
    # gecmiste 18:20 tarihli mesaj var.
    _contact_id, conv_id = await _seed_session_and_group(poisoned_ts=True)
    async with AsyncSessionLocal() as db:
        db.add(Message(user_id=TEST_USER, conversation_id=conv_id,
                       direction=MessageDirection.INBOUND, message_type=MessageType.TEXT,
                       body="Selam", sender_phone=MOCK_PHONE, recipient_phone="ME",
                       external_timestamp=_ts(18, 20)))
        await db.commit()
    async with AsyncSessionLocal() as db:
        fixed = await _repair_last_message_previews(db, TEST_USER)
        await db.commit()
    assert fixed == 1
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert conv.last_message_preview == "Selam"
        assert conv.last_message_at == _ts(18, 20)  # zehirli ts gercek mesaja dondu


# ---------------------------------------------------------------------------
# P2.11 — '[IMAGE]' kalici degeri okuma aninda etiket
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bracket_preview_normalized_on_read():
    _contact_id, conv_id = await _seed_session_and_group(preview="[IMAGE]", last_message_at=_ts(9, 0))
    async with AsyncSessionLocal() as db:
        items, _ = await list_conversations(db, TEST_USER)
    row = next(i for i in items if i["id"] == conv_id)
    assert row["last_message_preview"] == "📷 Fotoğraf"
    # repair gecisi de kopeli degeri onarir
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        db.add(Message(user_id=TEST_USER, conversation_id=conv.id,
                       direction=MessageDirection.OUTBOUND, message_type=MessageType.IMAGE,
                       body=None, sender_phone="ME", recipient_phone=MOCK_PHONE,
                       external_timestamp=_ts(9, 30)))
        await db.commit()
    async with AsyncSessionLocal() as db:
        fixed = await _repair_last_message_previews(db, TEST_USER)
        await db.commit()
    assert fixed == 1
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert conv.last_message_preview == "📷 Fotoğraf"


# ---------------------------------------------------------------------------
# P2.12 — sync_conversations: force grup subject + preview onarimi
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_conversations_forces_group_subjects_and_repairs():
    _contact_id, conv_id = await _seed_session_and_group()  # isimsiz grup, ozetsiz
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.sync_group_subjects", new_callable=AsyncMock) as sgs, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.return_value = []
            sgs.return_value = {"success": True, "force": True}
            lconv.return_value = {
                "items": [
                    {"jid": GROUP_JID, "name": "Aile", "name_source": "group_subject",
                     "last_message_preview": "Görüşürüz", "last_message_at": "2026-02-10T18:31:00.000Z",
                     "message_type": "TEXT"},
                ],
                "total": 1,
            }
            gm.return_value = {"messages": [], "has_more": False}
            items = await sync_conversations(db, TEST_USER)
    # Faz 10 (P1): esitleme force ister — TTL engeli kaldirildi
    sgs.assert_awaited_once_with(force=True)
    row = next(i for i in items if i["is_group"])
    assert row["name"] == "Aile"
    assert row["last_message_preview"] == "Görüşürüz"
    assert row["last_message_state"] == "RESOLVED"
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert conv.last_message_preview == "Görüşürüz"


@pytest.mark.asyncio
async def test_sync_repairs_from_history_when_gateway_preview_missing():
    # Gateway sohbet item'i previewsuz; gecmis mesajlardan en yeni secilir.
    _contact_id, conv_id = await _seed_session_and_group()
    async with AsyncSessionLocal() as db:
        with patch("backend.app.services.whatsapp_service.gw.list_contacts", new_callable=AsyncMock) as lc, \
             patch("backend.app.services.whatsapp_service.gw.sync_group_subjects", new_callable=AsyncMock) as sgs, \
             patch("backend.app.services.whatsapp_service.gw.list_conversations", new_callable=AsyncMock) as lconv, \
             patch("backend.app.services.whatsapp_service.gw.get_messages", new_callable=AsyncMock) as gm:
            lc.return_value = []
            sgs.return_value = {"success": True}
            lconv.return_value = {"items": [{"jid": GROUP_JID, "name": "Aile",
                                             "name_source": "group_subject"}], "total": 1}
            gm.return_value = {"messages": [
                {"wa_message_id": "H1", "direction": "INBOUND", "message_type": "TEXT",
                 "body": "Selam", "participant_name": "Ahmet",
                 "created_at": "2026-02-10T18:20:00.000Z"},
                {"wa_message_id": "H2", "direction": "INBOUND", "message_type": "TEXT",
                 "body": "Görüşürüz", "participant_name": "Ahmet",
                 "created_at": "2026-02-10T18:31:00.000Z"},
            ], "has_more": False}
            await sync_conversations(db, TEST_USER)
    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert conv.last_message_preview == "Ahmet: Görüşürüz"
        assert conv.last_message_at == _ts(18, 31)


# ---------------------------------------------------------------------------
# P2.13 — N+1 yok: liste basina sabit sorgu sayisi
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_conversations_no_n_plus_one():
    # 5 grup sohbeti + her birine 2 mesaj tohumla
    conv_ids = []
    for n in range(5):
        jid = f"12036301234567890{n}@g.us"
        async with AsyncSessionLocal() as db:
            c = Contact(user_id=TEST_USER, phone_e164=f"jid:{jid}", display_name=f"G{n}")
            db.add(c)
            await db.flush()
            cv = Conversation(user_id=TEST_USER, contact_id=c.id, channel="WHATSAPP",
                              status=ConversationStatus.ACTIVE,
                              last_message_preview="x", last_message_at=_ts(10, n))
            db.add(cv)
            await db.flush()
            for k in range(2):
                db.add(Message(user_id=TEST_USER, conversation_id=cv.id,
                               direction=MessageDirection.INBOUND, message_type=MessageType.TEXT,
                               body=f"m{k}", sender_phone=jid, recipient_phone="ME",
                               external_timestamp=_ts(10, n)))
            conv_ids.append(cv.id)
            await db.commit()

    counter = {"n": 0}

    def _count(conn, cursor, statement, parameters, context, executemany):
        counter["n"] += 1

    event.listen(engine.sync_engine, "before_cursor_execute", _count)
    try:
        async with AsyncSessionLocal() as db:
            items, total = await list_conversations(db, TEST_USER)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _count)
    assert len(items) >= 5
    # 5 sohbet x (count + conv + contact + per-chat message count) N+1 olsaydi
    # tek basina 20+ sorgu olurdu; toplam sorgu sayisi sabit kalmali.
    assert counter["n"] <= 10, f"N+1 detected: {counter['n']} queries for {len(items)} conversations"


# ---------------------------------------------------------------------------
# _apply_last_message birim kurallari
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_apply_last_message_rules():
    async with AsyncSessionLocal() as db:
        conv = await _ensure_conversation(db, TEST_USER, MOCK_JID)
        # bos ozet yazmaz
        assert _apply_last_message(conv, _ts(10, 0), "") is False
        # ilk ozet yazilir
        assert _apply_last_message(conv, _ts(10, 0), "Selam") is True
        # esit/eski zaman damgasi ezmez (duplicate-safe)
        assert _apply_last_message(conv, _ts(10, 0), "Selam tekrar") is False
        assert _apply_last_message(conv, _ts(9, 59), "Eski") is False
        # daha yeni yazar
        assert _apply_last_message(conv, _ts(10, 1), "Görüşürüz") is True
        assert conv.last_message_preview == "Görüşürüz"
        assert conv.last_message_at == _ts(10, 1)
        await db.rollback()
