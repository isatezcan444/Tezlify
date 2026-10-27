"""LID koprusu: KIRACI (tenant) YALITIMI.

Neden bu dosya
--------------
`7b510c7` kopruyu baglantidan kisiye tasidi: erteleme artik yalnizca
`lid_jid`'e bakiyor, birlesme sahibini `contacts.user_id`'den okuyor. Bu
degisiklik iki yonde birden risklidir ve ikisi de burada civiliyor:

1. **Eksik onarim** — eski kod, kopruyu yalnizca O ANKI gateway baglantisinin
   UUID'siyle eslestigi icin gecmis baglantilarda kaydedilmis kopruyu
   goremiyordu (`4 / 4107`). Hayalet yerinde kaliyor, kullanici mesajini
   bulamiyordu.
2. **Kiracilar-arasi sizinti** — sahip yanlis yerden okunursa A kiracisinin
   mesaji B kiracisinin sohbetine tasinir. Sessiz, geri alinamaz ve "mesajlarim
   baskasinda" diye gorunur.

Ikinci risk bu dosyanin asil konusudur: birlesme **yalnizca hayaletin
sahibine** ve **o sahibin kendi kanonik kisisine** yapilmalidir.

SQLite / PostgreSQL farki
-------------------------
Testler SQLite'ta kosar, uretim PostgreSQL'dir. Sorguda lehce farki yaratan
yapilar (`::` cast, `ILIKE`, `DISTINCT ON`, `FILTER (WHERE)`) YASAK; bunu
`test_candidate_query_has_no_postgres_only_construct` civiliyor. `substr(x, 5)`
ve `||` iki lehcede de ayni davranir; `is_archived = :archived` boolean
parametresi SQLAlchemy tarafindan iki lehcede de dogru baglanir.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.reconciliation import (
    candidate_lid_split_pairs,
    merge_deferred_lid_ghosts,
)

# Iki AYRI kiraci. Diger WhatsApp kapilariyla paylasilmayan UUID'ler: bu dosya
# "kimin satiri kiminle birlesTI" sorusunu kanit olarak okudugu icin yalitim
# sart.
USER_A = "a1b2c3d4-0000-4000-8000-aaaaaaaaaaaa"
USER_B = "b1b2c3d4-0000-4000-8000-bbbbbbbbbbbb"
HEX_A = USER_A.replace("-", "")
HEX_B = USER_B.replace("-", "")

LID = "777000111222333@lid"          # iki kiracida da AYNI kisi
PHONE = "+905551112233"
PHONE_JID = "905551112233@s.whatsapp.net"
GW_A = "gw-tenant-a"
GW_B = "gw-tenant-b"
GW_A_OLD = "gw-tenant-a-previous-connection"
GW_B_OLD = "gw-tenant-b-previous-connection"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe(create_table=True):
        async with AsyncSessionLocal() as db:
            if create_table:
                # Gateway bu tabloyu uretir; izole test DB'sinde olmayabilir.
                await db.execute(
                    text(
                        """
                        CREATE TABLE IF NOT EXISTS lid_mappings (
                            session_id TEXT NOT NULL,
                            lid_jid VARCHAR(100) NOT NULL,
                            phone_jid VARCHAR(100) NOT NULL DEFAULT '',
                            created_at TIMESTAMP,
                            PRIMARY KEY (session_id, lid_jid)
                        )
                        """
                    )
                )
            await db.execute(text("DELETE FROM lid_mappings"))
            for h in (HEX_A, HEX_B):
                await db.execute(text("DELETE FROM messages WHERE user_id = :h"), {"h": h})
                await db.execute(text("DELETE FROM conversations WHERE user_id = :h"), {"h": h})
                await db.execute(text("DELETE FROM contacts WHERE user_id = :h"), {"h": h})
                await db.execute(text("DELETE FROM whatsapp_sessions WHERE user_id = :h"), {"h": h})
            await db.commit()

    await _wipe()
    yield
    await _wipe(create_table=False)


async def _seed_tenant(
    user_id: str,
    hex_id: str,
    *,
    gw_id: str,
    body: str,
    mapping_session_id: str | None = None,
    with_canonical: bool = True,
) -> dict[str, Any]:
    """Bir kiracida bolunmus kimligi tohumlar: hayalet LID + kanonik telefon.

    `mapping_session_id` verilirse kopru, oturumun SU ANKI `gateway_id`'sinden
    FARKLI bir baglanti UUID'si altinda kaydedilir — uretimde her yeniden
    baglanmada olan sey.
    """
    lid_phone = f"jid:{LID}"
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user_id,
            gateway_id=gw_id,
            session_name="Tenant Hat",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()

        ghost = Contact(user_id=user_id, phone_e164=lid_phone, display_name="Ghost")
        db.add(ghost)
        await db.flush()
        ghost_conv = Conversation(
            user_id=user_id,
            contact_id=ghost.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            is_archived=False,
            unread_count=1,
        )
        db.add(ghost_conv)
        await db.flush()
        db.add(
            Message(
                user_id=hex_id,
                conversation_id=ghost_conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body=f"{body}-ghost",
                sender_phone=PHONE,
                recipient_phone="ME",
                wa_message_id=f"{body}-ghost-wa",
            )
        )

        canon_conv_id = None
        if with_canonical:
            canon = Contact(user_id=user_id, phone_e164=PHONE, display_name="Canonical")
            db.add(canon)
            await db.flush()
            canon_conv = Conversation(
                user_id=user_id,
                contact_id=canon.id,
                session_id=sess.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                is_archived=False,
                unread_count=0,
            )
            db.add(canon_conv)
            await db.flush()
            canon_conv_id = canon_conv.id
            db.add(
                Message(
                    user_id=hex_id,
                    conversation_id=canon_conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"{body}-canonical",
                    sender_phone=PHONE,
                    recipient_phone="ME",
                    wa_message_id=f"{body}-canon-wa",
                )
            )

        if mapping_session_id:
            await db.execute(
                text(
                    "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid) "
                    "VALUES (:s, :l, :p)"
                ),
                {"s": mapping_session_id, "l": LID, "p": PHONE_JID},
            )
        await db.commit()
        return {
            "session_id": sess.id,
            "ghost_conv_id": ghost_conv.id,
            "canon_conv_id": canon_conv_id,
        }


async def _rows():
    """(conversation_id, conversation.user_id, message.user_id, body) listesi.

    YALNIZCA bu dosyanin iki kiracisi: ayni test oturumunda baska dosyalar da
    satir birakir, filtresiz bir `select` "18 satir var" gibi anlamsiz bir
    sonucla yanlis kirmizi uretirdi.
    """
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                select(
                    Message.conversation_id,
                    Conversation.user_id,
                    Message.user_id,
                    Message.body,
                )
                .join(Conversation, Conversation.id == Message.conversation_id)
                .where(Conversation.user_id.in_([USER_A, USER_B]))
            )
        ).all()


async def _candidates(limit: int = 10):
    async with AsyncSessionLocal() as db:
        return await candidate_lid_split_pairs(db, limit=limit)


@pytest.mark.asyncio
async def test_a_bridge_never_moves_messages_across_tenants():
    """A kiracisinin mesaji B kiracisinin sohbetine ASLA tasinmaz.

    Iki kiracida da ayni LID ve ayni telefon var (ayni kisiyi iki isletme de
    senkronlamis olabilir). Kopru tek: `lid -> phone`. Birlesme her kiracida
    KENDI kanonik kisisine yapmali; tek bir havuzda toplamamali.
    """
    a = await _seed_tenant(USER_A, HEX_A, gw_id=GW_A, body="a")
    b = await _seed_tenant(USER_B, HEX_B, gw_id=GW_B, body="b")
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("INSERT INTO lid_mappings (session_id, lid_jid, phone_jid) VALUES (:s,:l,:p)"),
            {"s": GW_A, "l": LID, "p": PHONE_JID},
        )
        await db.commit()

    report = await merge_deferred_lid_ghosts(engine, limit=10)
    assert report["merged"] == 2, "her kiracinin kendi hayaleti birlesmeli"

    rows = await _rows()
    # 1) Hicbir mesaj sahibinden farkli bir kullaniciya ait sohbette degil.
    for conv_id, conv_owner, msg_owner, body in rows:
        assert str(conv_owner).replace("-", "") == str(msg_owner).replace("-", ""), (
            f"kiracilar-arasi sizinti: {body!r} mesaji {msg_owner} sahibiyken "
            f"{conv_owner} sohbetinde"
        )
    # 2) A'nin mesajlari A'nin kanonik sohbetinde, B'ninki B'nin.
    a_bodies = {body for cid, owner, _o, body in rows if str(owner).replace("-", "") == HEX_A}
    b_bodies = {body for cid, owner, _o, body in rows if str(owner).replace("-", "") == HEX_B}
    assert a_bodies == {"a-ghost", "a-canonical"}
    assert b_bodies == {"b-ghost", "b-canonical"}


@pytest.mark.asyncio
async def test_a_tenant_without_a_bridge_is_never_guessed_at():
    """Kopru YOKSA hicbir kiracida birlesme yok — tahmin yurutulmez."""
    await _seed_tenant(USER_A, HEX_A, gw_id=GW_A, body="a")

    report = await merge_deferred_lid_ghosts(engine, limit=10)

    assert report["scanned"] == 0
    assert report["merged"] == 0
    assert len(await _rows()) == 2, "hicbir satir dokunulmamali"


@pytest.mark.asyncio
async def test_both_tenants_are_repaired_even_when_the_bridge_predates_the_connection():
    """Kopru gecmis bir baglanti UUID'sinde olsa da HER IKI kiracida onarilir.

    Eski kod burada 0 birlesme raporluyordu: kopru yalnizca `whatsapp_sessions.
    gateway_id` ile eslesiyordu ve o da her yeniden baglanmada degisir.
    """
    await _seed_tenant(USER_A, HEX_A, gw_id=GW_A, body="a", mapping_session_id=GW_A_OLD)
    await _seed_tenant(USER_B, HEX_B, gw_id=GW_B, body="b", mapping_session_id=GW_B_OLD)

    pairs = await _candidates()
    assert len(pairs) == 2, "iki kiracinin hayaleti de aday olmali"

    report = await merge_deferred_lid_ghosts(engine, limit=10)
    assert report["merged"] == 2


@pytest.mark.asyncio
async def test_candidates_are_owned_by_the_ghost_contact_not_by_the_session():
    """Adayin `user_id`'si hayaletin sahibidir.

    Eski sorgu sahibi `whatsapp_sessions.user_id`'den okuyordu; yani koprunun
    kaydedildigi BAGLANTI hangi kiracinin id'sini tasiyorsa sahip o oluyordu.
    Artik sahip `contacts.user_id`'dir ve bu, mesajlarin gercekten ait oldugu
    kiracidir.
    """
    await _seed_tenant(USER_A, HEX_A, gw_id=GW_A, body="a", mapping_session_id=GW_A_OLD)
    await _seed_tenant(USER_B, HEX_B, gw_id=GW_B, body="b", mapping_session_id=GW_B)

    pairs = await _candidates()

    owners = {str(p["user_id"]).replace("-", "") for p in pairs}
    assert owners == {HEX_A, HEX_B}


def test_candidate_query_has_no_postgres_only_construct():
    """Sorgu iki lehcede de kosmali: SQLite'ta yesil, PostgreSQL'de patlamasin.

    `::` cast, `ILIKE`, `DISTINCT ON`, `FILTER (WHERE)` yalnizca PostgreSQL'de
    vardir; testler SQLite'ta kostugu icin bunlar ancak URETIMDE patlar.
    """
    src = inspect.getsource(candidate_lid_split_pairs)
    for bad in ("::", "ILIKE", "DISTINCT ON", "FILTER (WHERE)", "generate_series"):
        assert bad not in src, f"PostgreSQL'e ozgu yapi SQLite testinde gorunmez: {bad}"
