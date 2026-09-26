"""`backfill_phone_sender_names` migration testleri.

Kapsanan senaryolar:
1. `sender_name` telefon olan mesaj, AYNI kiracıdaki gerçek adlı kişiyle
   eşleşiyorsa kişi adına çevrilir.
2. Gerçek adı bilinmeyen kişi (display_name == phone_e164) ad kaynağı olamaz.
3. Ham jid görünümlü display_name ad kaynağı olamaz.
4. Kiracı izolasyonu: başka kullanıcının kişi kaydı ASLA ad kaynağı olamaz.
5. Zaten gerçek ad taşıyan `sender_name` ezilmez.
6. Idempotenttir (ikinci çalıştırma no-op).
7. Telefon olmayan sender_name'e dokunulmaz.
"""
import pytest
from sqlalchemy import text, select

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.migrations import backfill_phone_sender_names
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    Message,
    MessageDirection,
    MessageType,
    ConversationMessageStatus,
)

USER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

PHONE_KNOWN = "+905076382749"      # kişi kaydı olan, adı bilinen
PHONE_UNKNOWN = "+905333240016"    # kişi kaydı var ama adı telefon
PHONE_RAWJID = "+905459137484"     # kişi kaydının adı ham jid
PHONE_OTHER_TENANT = "+905550001111"  # yalnızca B kiracısında kayıtlı


async def _mk_conversation(db, user_id: str, is_group: bool = True) -> int:
    conv = Conversation(
        user_id=user_id,
        channel="WHATSAPP",
        status=ConversationStatus.ACTIVE,
        is_group=is_group,
    )
    db.add(conv)
    await db.flush()
    return conv.id


async def _mk_message(db, user_id: str, conv_id: int, sender_name: str) -> int:
    msg = Message(
        user_id=user_id,
        conversation_id=conv_id,
        direction=MessageDirection.INBOUND,
        message_type=MessageType.TEXT,
        sender_phone="ME",
        recipient_phone="+905413749073",
        sender_name=sender_name,
        status=ConversationMessageStatus.RECEIVED,
        body="test",
    )
    db.add(msg)
    await db.flush()
    return msg.id


@pytest.mark.asyncio
async def test_backfill_phone_sender_names_repairs_only_known_names():
    async with AsyncSessionLocal() as db:
        # A kiracısı: adı bilinen kişi + adı bilinmeyenler
        known = Contact(user_id=USER_A, phone_e164=PHONE_KNOWN, display_name="Cevat Aydın")
        unknown = Contact(user_id=USER_A, phone_e164=PHONE_UNKNOWN, display_name=PHONE_UNKNOWN)
        rawjid = Contact(user_id=USER_A, phone_e164=PHONE_RAWJID, display_name="jid:120363424890338512@g.us")
        # B kiracısı: aynı numara, BAŞKA kullanıcı
        other = Contact(user_id=USER_B, phone_e164=PHONE_OTHER_TENANT, display_name="B Kişisi")
        db.add_all([known, unknown, rawjid, other])
        await db.flush()

        conv_a = await _mk_conversation(db, USER_A)
        conv_b = await _mk_conversation(db, USER_B)

        fixable = await _mk_message(db, USER_A, conv_a, PHONE_KNOWN)
        keep_unknown = await _mk_message(db, USER_A, conv_a, PHONE_UNKNOWN)
        keep_rawjid = await _mk_message(db, USER_A, conv_a, PHONE_RAWJID)
        keep_real_name = await _mk_message(db, USER_A, conv_a, "Tolga Cebeci")
        cross_tenant = await _mk_message(db, USER_A, conv_a, PHONE_OTHER_TENANT)
        other_tenant_msg = await _mk_message(db, USER_B, conv_b, PHONE_OTHER_TENANT)
        non_phone = await _mk_message(db, USER_A, conv_a, "Lazury")

        ids = {
            "known": known.id, "unknown": unknown.id, "rawjid": rawjid.id, "other": other.id,
            "conv_a": conv_a, "conv_b": conv_b,
        }
        await db.commit()

    await backfill_phone_sender_names(engine)

    async with AsyncSessionLocal() as db:
        assert (await db.get(Message, fixable)).sender_name == "Cevat Aydın", \
            "known contact name repaired the phone label"
        assert (await db.get(Message, keep_unknown)).sender_name == PHONE_UNKNOWN, \
            "a contact whose display_name is the phone cannot supply a name"
        assert (await db.get(Message, keep_rawjid)).sender_name == PHONE_RAWJID, \
            "a raw-jid display_name cannot supply a name"
        assert (await db.get(Message, keep_real_name)).sender_name == "Tolga Cebeci", \
            "an existing real name is never overwritten"
        assert (await db.get(Message, non_phone)).sender_name == "Lazury", \
            "a non-phone sender_name is untouched"
        # Kiracı izolasyonu: A'nın mesajı B'nin kişi adını ALMAMALI.
        assert (await db.get(Message, cross_tenant)).sender_name == PHONE_OTHER_TENANT, \
            "another tenant's contact must never name this message"
        assert (await db.get(Message, other_tenant_msg)).sender_name == "B Kişisi", \
            "the owning tenant's message is repaired"

        # Idempotentlik
        await backfill_phone_sender_names(engine)
        assert (await db.get(Message, fixable)).sender_name == "Cevat Aydın"

        # temizlik
        for mid in (fixable, keep_unknown, keep_rawjid, keep_real_name, cross_tenant,
                    other_tenant_msg, non_phone):
            row = await db.get(Message, mid)
            if row:
                await db.delete(row)
        for cid in (ids["conv_a"], ids["conv_b"]):
            row = await db.get(Conversation, cid)
            if row:
                await db.delete(row)
        for key in ("known", "unknown", "rawjid", "other"):
            row = await db.get(Contact, ids[key])
            if row:
                await db.delete(row)
        await db.commit()
