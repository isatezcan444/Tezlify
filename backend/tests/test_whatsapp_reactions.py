"""Mesaj reaksiyonlari — gercek ingest/persist yolu uzerinden davranis testleri.

Sozlesmeler
-----------
1. Reaksiyon bir MESAJ DEGILDIR: ingest sirasinda mesaj satiri URETILMEZ
   (eski hata `[REACTION]` govdeli cop bir balon ve yanlis liste onizlemesi
   uretiyordu).
2. Kisi basina mesaj basina TEK satir: ayni kisi tekrar tepki verirse UPDATE,
   tepkiyi cekerse satir silinmez (tekillik indeksi yarisi kaybetmesin).
3. Hedef mesaj `reactionMessage.key.id`dir; bilinmeyen hedefe gelen olay
   ATILIR ve hicbir satir yaratmaz.
4. Sohbet listesi rozeti yalnizca SON mesajin ifadesini gosterir.
5. Giden tepki gateway'in kendi ucundan gider ve yerelde `ME` kimligiyle
   yazilir; mesajin durumu/preview'i DEGISMEZ.

Tests exercise the real `ingest_gateway_event` against the real schema; each
one is written to fail before the corresponding fix (e.g. before the gateway
branch routed `reactionMessage` into its own event, case 1 produced a message
row whose body was the literal placeholder).
"""

from datetime import datetime
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.message_reaction import MessageReaction
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp_service import (
    get_messages,
    ingest_gateway_event,
    list_conversations,
    send_reaction,
)

RX_USER = "abcd1234-0000-0000-0000-00000000abce"
RX_USER_HEX = "abcd123400000000000000000000abce"
RX_GW = "gw-rx-reactions"
RX_PHONE = "+905550000301"
RX_JID = "905550000301@s.whatsapp.net"
RX_OTHER_JID = "905550000302@s.whatsapp.net"

T1 = "2026-09-30T10:00:00.000Z"
T2 = "2026-09-30T10:05:00.000Z"


async def _wipe() -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM message_reactions WHERE user_id IN (:h, :s)"),
            {"h": RX_USER_HEX, "s": RX_USER},
        )
        await db.execute(
            text("DELETE FROM messages WHERE user_id IN (:h, :s)"),
            {"h": RX_USER_HEX, "s": RX_USER},
        )
        await db.execute(
            text("DELETE FROM conversations WHERE user_id IN (:h, :s)"),
            {"h": RX_USER_HEX, "s": RX_USER},
        )
        await db.execute(
            text("DELETE FROM contacts WHERE user_id IN (:h, :s)"),
            {"h": RX_USER_HEX, "s": RX_USER},
        )
        await db.execute(
            text("DELETE FROM whatsapp_sessions WHERE user_id IN (:h, :s)"),
            {"h": RX_USER_HEX, "s": RX_USER},
        )
        await db.commit()


@pytest_asyncio.fixture(autouse=True)
async def _ensure_reactions_table():
    """`message_reactions` tablosunu paylasilan test DB'sinde garanti eder.

    Uygulama bunu acilista `ensure_message_reactions_table` ile yapar; testler
    lifespan'i calistirmadigi icin ayni migration'i burada kostururuz. Aksi
    halde test, sema eksikliginden (gercek urun davranisindan degil) kirmizi
    olurdu.
    """
    from backend.app.core.database import engine as app_engine
    from backend.app.core.migrations import ensure_message_reactions_table

    await ensure_message_reactions_table(app_engine)
    yield


@pytest_asyncio.fixture(autouse=True)
async def _isolated_tenant():
    await _wipe()
    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=RX_USER,
                gateway_id=RX_GW,
                session_name="RX Hat",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
        )
        await db.commit()
    yield
    await _wipe()


async def _ensure_conversation(phone: str = RX_PHONE) -> int:
    """Tek sohbet kurar ve id'sini doner (yoksa olusturur)."""
    async with AsyncSessionLocal() as db:
        existing = await db.scalar(
            select(Conversation.id).where(Conversation.user_id == RX_USER)
        )
        if existing is not None:
            return int(existing)
        contact = Contact(user_id=RX_USER, phone_e164=phone, display_name="RX Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=RX_USER,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            session_id=None,
        )
        db.add(conv)
        await db.commit()
        return int(conv.id)


async def _seed_message(
    wa_id: str = "RX_WA_1",
    *,
    jid: str = RX_JID,
    phone: str = RX_PHONE,
    body: str = "merhaba",
    created_at: str = T1,
    direction: MessageDirection = MessageDirection.INBOUND,
) -> int:
    conversation_id = await _ensure_conversation(phone)
    async with AsyncSessionLocal() as db:
        msg = Message(
            user_id=RX_USER,
            conversation_id=conversation_id,
            direction=direction,
            message_type=MessageType.TEXT,
            body=body,
            wa_message_id=wa_id,
            sender_phone="ME" if direction == MessageDirection.OUTBOUND else phone,
            recipient_phone="ME" if direction == MessageDirection.INBOUND else jid,
            status=(
                ConversationMessageStatus.RECEIVED
                if direction == MessageDirection.INBOUND
                else ConversationMessageStatus.SENT
            ),
            external_timestamp=datetime(2026, 9, 30, 10, 0, 0),
        )
        db.add(msg)
        await db.commit()
        return int(msg.id)


async def _count_rows() -> tuple[int, int]:
    async with AsyncSessionLocal() as db:
        messages = await db.scalar(
            select(func.count()).select_from(Message).where(Message.user_id.in_([RX_USER, RX_USER_HEX]))
        )
        reactions = await db.scalar(
            select(func.count())
            .select_from(MessageReaction)
            .where(MessageReaction.user_id.in_([RX_USER, RX_USER_HEX]))
        )
    return int(messages or 0), int(reactions or 0)


def _reaction_event(
    target_wa_id: str,
    emoji: str,
    *,
    jid: str = RX_JID,
    from_me: bool = False,
    reactor_jid: str | None = RX_PHONE,
    event_id: str | None = None,
) -> dict:
    return {
        "event": "message_reaction",
        "event_id": event_id or str(uuid.uuid4()),
        "gateway_session_id": RX_GW,
        "conversation_id": jid,
        "target_wa_message_id": target_wa_id,
        "emoji": emoji,
        "removed": not emoji,
        "from_me": from_me,
        "reactor_jid": reactor_jid,
        "created_at": T2,
    }


@pytest.mark.asyncio
async def test_reaction_ingest_persists_and_broadcasts():
    message_id = await _seed_message()
    result = await ingest_gateway_event(_reaction_event("RX_WA_1", "❤️"))

    assert result is not None, "reaksiyon olayi yayinlanmali"
    assert result["event"] == "message_reaction"
    assert result["user_id"] == RX_USER
    assert result["message_id"] == message_id
    assert result["emoji"] == "❤️"
    assert result["from_me"] is False
    assert result["removed"] is False
    # Rozet, liste sozlesmesiyle AYNI sekilde sunucuda hesaplanir.
    assert result["conversation_reaction"] is not None
    assert result["conversation_reaction"]["emoji"] == "❤️"

    async with AsyncSessionLocal() as db:
        row = await db.scalar(
            select(MessageReaction).where(MessageReaction.message_id == message_id)
        )
    assert row is not None
    assert row.emoji == "❤️"
    assert row.reactor_jid == RX_PHONE
    assert row.from_me is False


@pytest.mark.asyncio
async def test_reaction_never_creates_a_message_row():
    """Eski hata: reaksiyon `[REACTION]` govdeli bir mesaj satiri uretiyordu."""
    message_id = await _seed_message()
    before_messages, _ = await _count_rows()

    result = await ingest_gateway_event(_reaction_event("RX_WA_1", "👍"))

    assert result is not None
    after_messages, after_reactions = await _count_rows()
    assert after_messages == before_messages, "reaksiyon mesaj sayisini artirmamali"
    assert after_reactions == 1

    async with AsyncSessionLocal() as db:
        junk = await db.scalar(
            select(func.count())
            .select_from(Message)
            .where(
                Message.user_id == RX_USER,
                Message.body.like("%[REACTION]%"),
            )
        )
    assert int(junk or 0) == 0

    # Hedef mesajin kendisi DEGISMEDI: reaksiyon onun bir parcasi degil.
    async with AsyncSessionLocal() as db:
        target = await db.get(Message, message_id)
    assert target is not None
    assert target.body == "merhaba"
    assert target.message_type == MessageType.TEXT


@pytest.mark.asyncio
async def test_reaction_change_is_an_update_not_a_second_row():
    message_id = await _seed_message()
    await ingest_gateway_event(_reaction_event("RX_WA_1", "👍"))
    await ingest_gateway_event(_reaction_event("RX_WA_1", "😂"))

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(MessageReaction).where(MessageReaction.message_id == message_id)
            )
        ).scalars().all()
    assert len(rows) == 1, "kisi basina mesaj basina TEK satir"
    assert rows[0].emoji == "😂"


@pytest.mark.asyncio
async def test_two_reactors_on_the_same_message_both_survive():
    message_id = await _seed_message()
    await ingest_gateway_event(_reaction_event("RX_WA_1", "👍"))
    await ingest_gateway_event(
        _reaction_event("RX_WA_1", "🎉", reactor_jid="905550000999@s.whatsapp.net")
    )

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(MessageReaction)
                .where(MessageReaction.message_id == message_id)
                .order_by(MessageReaction.id.asc())
            )
        ).scalars().all()
    assert [r.emoji for r in rows] == ["👍", "🎉"]


@pytest.mark.asyncio
async def test_withdraw_keeps_the_row_but_hides_the_reaction():
    message_id = await _seed_message()
    await ingest_gateway_event(_reaction_event("RX_WA_1", "👍"))
    # Geri cekme KISIYE OZELDIR: ayni kisi (RX_PHONE) ifadesini ceker; baska
    # birinin ayni mesaja biraktigi ifade etkilenmez.
    result = await ingest_gateway_event(_reaction_event("RX_WA_1", ""))

    assert result is not None
    assert result["removed"] is True
    assert result["conversation_reaction"] is None

    async with AsyncSessionLocal() as db:
        row = await db.scalar(
            select(MessageReaction).where(MessageReaction.message_id == message_id)
        )
    assert row is not None, "geri cekilen satir silinmez (tekillik indeksi yarisi)"
    assert row.emoji == ""

    # API sozlesmesi: geri cekilmis reaksiyon istemciye HIC gitmez.
    async with AsyncSessionLocal() as db:
        page = await get_messages(db, RX_USER, (await _conversation_id()))
    assert page["messages"][0]["reactions"] == []


_conversation_id = _ensure_conversation


@pytest.mark.asyncio
async def test_list_badge_only_reflects_the_newest_message():
    older_id = await _seed_message("RX_WA_1", body="eski", created_at=T1)
    await _seed_message("RX_WA_2", body="yeni", created_at=T2)

    # Eski mesaja tepki: listede gorunmemeli.
    result = await ingest_gateway_event(_reaction_event("RX_WA_1", "👍"))
    assert result is not None
    assert result["conversation_reaction"] is None

    # Yeni mesaja tepki: simdi gorunmeli.
    result = await ingest_gateway_event(_reaction_event("RX_WA_2", "🔥"))
    assert result is not None
    assert result["conversation_reaction"]["emoji"] == "🔥"
    assert result["conversation_reaction"]["message_id"] != older_id


@pytest.mark.asyncio
async def test_unknown_target_is_skipped_without_creating_rows():
    await _seed_message()
    before_messages, before_reactions = await _count_rows()

    result = await ingest_gateway_event(_reaction_event("RX_DOES_NOT_EXIST", "👍"))

    assert result is None, "hedefsiz reaksiyon yayinlanmamali"
    after_messages, after_reactions = await _count_rows()
    assert (after_messages, after_reactions) == (before_messages, before_reactions)


@pytest.mark.asyncio
async def test_unattributable_reaction_is_skipped():
    """Kimi biraktigi cozulemezse olay ATILIR: iki kisi tek satiri ezemez."""
    await _seed_message()
    result = await ingest_gateway_event(
        _reaction_event("RX_WA_1", "👍", from_me=False, reactor_jid=None)
    )
    assert result is None
    _, reactions = await _count_rows()
    assert reactions == 0


@pytest.mark.asyncio
async def test_get_messages_attaches_reactions_in_one_page():
    first = await _seed_message("RX_WA_1", body="bir")
    second = await _seed_message("RX_WA_2", body="iki", created_at=T2)
    await ingest_gateway_event(_reaction_event("RX_WA_1", "👍"))
    await ingest_gateway_event(_reaction_event("RX_WA_2", "🎉"))

    async with AsyncSessionLocal() as db:
        page = await get_messages(db, RX_USER, await _conversation_id())
    by_id = {m["id"]: m for m in page["messages"]}
    assert by_id[first]["reactions"][0]["emoji"] == "👍"
    assert by_id[second]["reactions"][0]["emoji"] == "🎉"


@pytest.mark.asyncio
async def test_conversation_list_carries_last_reaction():
    await _seed_message("RX_WA_1", body="bir", created_at=T1)
    await _seed_message("RX_WA_2", body="iki", created_at=T2)
    await ingest_gateway_event(_reaction_event("RX_WA_2", "🔥"))

    async with AsyncSessionLocal() as db:
        items, _total = await list_conversations(db, RX_USER, limit=10)
    assert len(items) == 1
    assert items[0]["last_reaction"] is not None
    assert items[0]["last_reaction"]["emoji"] == "🔥"


@pytest.mark.asyncio
async def test_outbound_reaction_uses_gateway_and_persists_me(monkeypatch):
    from backend.app.services.whatsapp.orchestration import messaging as messaging_mod

    message_id = await _seed_message("RX_WA_1")
    calls: list[dict] = []

    async def _fake_send_reaction(gateway_id, jid, **kwargs):
        calls.append({"gateway_id": gateway_id, "jid": jid, **kwargs})
        return {"success": True}

    monkeypatch.setattr(messaging_mod.gw, "send_reaction", _fake_send_reaction)

    async with AsyncSessionLocal() as db:
        conversation_id = await _conversation_id()
        result = await send_reaction(db, RX_USER, conversation_id, message_id, "❤️")

    assert result["success"] is True
    assert result["removed"] is False
    assert result["reactor_jid"] == "ME"
    assert len(calls) == 1
    assert calls[0]["gateway_id"] == RX_GW
    assert calls[0]["target_wa_message_id"] == "RX_WA_1"
    assert calls[0]["target_from_me"] is False
    assert calls[0]["emoji"] == "❤️"

    async with AsyncSessionLocal() as db:
        row = await db.scalar(
            select(MessageReaction).where(MessageReaction.message_id == message_id)
        )
        target = await db.get(Message, message_id)
    assert row is not None and row.reactor_jid == "ME" and row.from_me is True
    # Tepki bir mesaj GONDERIMI degildir: hedef satirin durumu degismez.
    assert target.status == ConversationMessageStatus.RECEIVED
    assert target.body == "merhaba"


@pytest.mark.asyncio
async def test_outbound_reaction_withdraws_locally_when_gateway_accepts(monkeypatch):
    from backend.app.services.whatsapp.orchestration import messaging as messaging_mod

    message_id = await _seed_message("RX_WA_1")

    async def _fake_send_reaction(gateway_id, jid, **kwargs):
        return {"success": True}

    monkeypatch.setattr(messaging_mod.gw, "send_reaction", _fake_send_reaction)
    async with AsyncSessionLocal() as db:
        conversation_id = await _conversation_id()
        await send_reaction(db, RX_USER, conversation_id, message_id, "❤️")
        result = await send_reaction(db, RX_USER, conversation_id, message_id, "")

    assert result["removed"] is True
    assert result["conversation_reaction"] is None


@pytest.mark.asyncio
async def test_outbound_reaction_requires_a_provider_id(monkeypatch):
    from backend.app.services.whatsapp.orchestration import messaging as messaging_mod

    message_id = await _seed_message("RX_WA_1")

    async def _must_not_be_called(*args, **kwargs):  # pragma: no cover - guard
        raise AssertionError("saglayici kimligi olmayan mesaja gateway cagrisi yapildi")

    monkeypatch.setattr(messaging_mod.gw, "send_reaction", _must_not_be_called)

    async with AsyncSessionLocal() as db:
        target = await db.get(Message, message_id)
        target.wa_message_id = None
        await db.commit()
        conversation_id = await _conversation_id()
        with pytest.raises(ValueError):
            await send_reaction(db, RX_USER, conversation_id, message_id, "❤️")
