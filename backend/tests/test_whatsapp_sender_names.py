"""Sender-name resolution for WhatsApp chats (DM + groups, phone + LID).

Covers the full chain: gateway participant JID (+ optional participant_pn
from LID mapping) -> CRM leads lookup -> stored sender_name, plus the
Eşitle no-duplicate + legacy 'Grup Üyesi' healing behavior.
"""
import time
import uuid
import pytest
from sqlalchemy import select, func

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.message import Message, MessageDirection
from backend.app.models.conversation import Conversation
from backend.app.services.whatsapp_sync_service import WhatsAppSyncService


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _uniq_e164() -> str:
    """Unique libphonenumber-valid TR mobile (532 block validates fully)."""
    return f"+90532{uuid.uuid4().int % 10000000:07d}"


async def _make_session(phone: str | None = None):
    phone = phone or _uniq_e164()
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            session_name=_uid("sess_sendername"),
            phone_number=phone,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
        )
        db.add(sess)
        await db.commit()
        await db.refresh(sess)
        return sess.session_name


async def _make_lead(phone_e164, name):
    async with AsyncSessionLocal() as db:
        lead = Lead(
            name=name,
            phone=phone_e164,
            phone_e164=phone_e164,
            status=LeadStatus.CONTACTED,
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)
        return lead.id


@pytest.mark.asyncio
async def test_lid_participant_with_pn_resolves_lead_name():
    session_name = await _make_session()
    MOM_E164 = _uniq_e164()
    await _make_lead(MOM_E164, "Annem")
    group_jid = f"tezliygrup_{uuid.uuid4().hex[:6]}@g.us"

    async with AsyncSessionLocal() as db:
        res = await WhatsAppSyncService.process_message_event(
            db=db,
            session_name=session_name,
            event_data={
                "phone": group_jid,
                "message": "Merhaba herkese",
                "fromMe": False,
                "is_group": True,
                "participant": "167812345678901@lid",
                "participant_pn": f"{MOM_E164[1:]}@s.whatsapp.net",
                "wa_message_id": f"wa_lidpn_{uuid.uuid4().hex[:8]}",
                "timestamp": time.time(),
            },
        )
        assert res["status"] == "success"
        msg = await db.get(Message, res["message_id"])
        assert msg.sender_name == "Annem"
        assert msg.sender_phone == MOM_E164
        # No lead may ever be created with raw LID digits as phone
        lid_lead = (
            await db.execute(select(Lead).where(Lead.phone_e164.like("+1678%")))
        ).scalars().first()
        assert lid_lead is None


@pytest.mark.asyncio
async def test_lid_participant_without_pn_never_fakes_number():
    session_name = await _make_session()
    group_jid = f"tezliygrup_{uuid.uuid4().hex[:6]}@g.us"
    lid = "167899900011122@lid"

    async with AsyncSessionLocal() as db:
        res = await WhatsAppSyncService.process_message_event(
            db=db,
            session_name=session_name,
            event_data={
                "phone": group_jid,
                "message": "Selam",
                "fromMe": False,
                "is_group": True,
                "participant": lid,
                "wa_message_id": f"wa_lidno_{uuid.uuid4().hex[:8]}",
                "timestamp": time.time(),
            },
        )
        assert res["status"] == "success"
        msg = await db.get(Message, res["message_id"])
        assert msg.sender_name is None
        assert msg.sender_name != "Grup Üyesi"
        assert msg.sender_phone == lid
        # No fabricated +number anywhere
        fake = (
            await db.execute(select(Lead).where(Lead.phone_e164.like("+1678%")))
        ).scalars().first()
        assert fake is None


@pytest.mark.asyncio
async def test_esitle_preview_does_not_duplicate_and_heals_name():
    session_name = await _make_session()
    MOM_E164 = _uniq_e164()
    await _make_lead(MOM_E164, "Annem")
    group_jid = f"tezliygrup_{uuid.uuid4().hex[:6]}@g.us"
    chat = {
        "id": group_jid,
        "phone": group_jid,
        "name": "Test Ailesi",
        "is_group": True,
        "conversation_timestamp": time.time(),
        "last_message_preview": "Herkese merhaba",
        "last_message_from_me": False,
        "last_message_sender_name": None,
        "last_message_participant": f"{MOM_E164[1:]}@s.whatsapp.net",
    }

    async with AsyncSessionLocal() as db:
        first = await WhatsAppSyncService.sync_history_batch(
            db=db, session_name=session_name, chats=[chat], messages=[]
        )
        second = await WhatsAppSyncService.sync_history_batch(
            db=db, session_name=session_name, chats=[chat], messages=[]
        )
        assert first["status"] == "success"
        assert second["status"] == "success"

        conv_id = None
        lead = (
            await db.execute(select(Lead).where(Lead.phone == group_jid))
        ).scalars().first()
        assert lead is not None
        from backend.app.models.conversation import Conversation
        conv = (
            await db.execute(
                select(Conversation).where(Conversation.lead_id == lead.id).limit(1)
            )
        ).scalars().first()
        conv_id = conv.id
        rows = (
            await db.execute(select(Message).where(Message.conversation_id == conv_id))
        ).scalars().all()
        # Exactly one row despite two Eşitle clicks; name healed via leads table
        assert len(rows) == 1
        assert rows[0].sender_name == "Annem"


@pytest.mark.asyncio
async def test_lid_dm_without_pn_keys_by_raw_jid():
    """Unresolvable LID DM: chat keyed by raw JID, message kept with
    pushName, nothing dropped, nothing fabricated."""
    session_name = await _make_session()
    lid_jid = f"1678{uuid.uuid4().int % 100000000000:011d}@lid"
    push = f"PushKisi_{uuid.uuid4().hex[:4]}"

    async with AsyncSessionLocal() as db:
        res = await WhatsAppSyncService.sync_history_batch(
            db=db,
            session_name=session_name,
            chats=[
                {
                    "id": lid_jid,
                    "phone": lid_jid,
                    "name": push,
                    "is_group": False,
                    "conversation_timestamp": time.time(),
                    "last_message_preview": "merhaba",
                    "last_message_from_me": False,
                    "last_message_sender_name": push,
                    "last_message_participant": lid_jid,
                    "last_message_participant_pn": None,
                }
            ],
            messages=[],
        )
        assert res["status"] == "success"
        lead = (
            await db.execute(select(Lead).where(Lead.phone == lid_jid))
        ).scalars().first()
        assert lead is not None
        assert lead.phone_e164 is None
        assert lead.name == push
        # No fake dialable number derived from the LID anywhere
        bad = (
            await db.execute(
                select(Lead).where(
                    Lead.phone_e164.like("+1678%"),
                    Lead.user_id.is_(None),
                )
            )
        ).scalars().first()
        assert bad is None


@pytest.mark.asyncio
async def test_heal_pass_upgrades_legacy_grup_uyesi_and_outbound():
    session_name = await _make_session()
    mom_e164 = _uniq_e164()
    unk_e164 = _uniq_e164()
    sess_phone = _uniq_e164()
    await _make_lead(mom_e164, "Annem")
    group_jid = f"tezliygrup_{uuid.uuid4().hex[:6]}@g.us"

    async with AsyncSessionLocal() as db:
        lead, conv = await WhatsAppSyncService.get_or_create_lead_and_conversation(
            db=db,
            user_id=None,
            phone_e164=None,
            contact_name="Eski Grup",
            is_group=True,
            group_jid=group_jid,
        )
        legacy_in = Message(
            user_id=None,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            body="eski mesaj",
            sender_phone=mom_e164,
            recipient_phone=sess_phone,
            sender_name="Grup Üyesi",
        )
        legacy_out = Message(
            user_id=None,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            body="eski yanıt",
            sender_phone=sess_phone,
            recipient_phone=group_jid,
            sender_name=None,
        )
        unknown = Message(
            user_id=None,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            body="bilinmeyen",
            sender_phone=unk_e164,
            recipient_phone=sess_phone,
            sender_name="",
        )
        db.add_all([legacy_in, legacy_out, unknown])
        await db.commit()
        in_id, out_id, unk_id = legacy_in.id, legacy_out.id, unknown.id

        res = await WhatsAppSyncService.sync_history_batch(
            db=db, session_name=session_name, chats=[], messages=[]
        )
        assert res["status"] == "success"

        assert (await db.get(Message, in_id)).sender_name == "Annem"
        assert (await db.get(Message, out_id)).sender_name == "Siz"
        # Unknown number: honest phone display, never generic placeholder
        assert (await db.get(Message, unk_id)).sender_name == unk_e164

        # And no 'Grup Üyesi' remains for this conversation
        leftovers = (
            await db.execute(
                select(func.count(Message.id)).where(
                    Message.conversation_id == conv.id,
                    Message.sender_name == "Grup Üyesi",
                )
            )
        ).scalar_one()
        assert leftovers == 0


@pytest.mark.asyncio
async def test_merge_lid_identities_absorbs_placeholder():
    from backend.app.services.whatsapp_sync_service import _is_poor_sender_name

    # "WhatsApp (...)" placeholders are upgradeable like other poor names.
    assert _is_poor_sender_name("WhatsApp (+905321112233)", "+905321112233") is True
    assert _is_poor_sender_name("WhatsApp (167812345678901@lid)") is True
    assert _is_poor_sender_name("Annem", "+905321112233") is False
    assert _is_poor_sender_name(None) is True

    async with AsyncSessionLocal() as db:
        lid_jid = f"1678{uuid.uuid4().int % 100000000000:011d}@lid"
        pn = _uniq_e164()
        raw_lead = Lead(name=f"WhatsApp ({lid_jid})", phone=lid_jid, phone_e164=None,
                        status=LeadStatus.CONTACTED)
        keeper = Lead(name="Gerçek İsim", phone=pn, phone_e164=pn,
                      status=LeadStatus.CONTACTED)
        db.add_all([raw_lead, keeper])
        await db.commit()

        n = await WhatsAppSyncService._merge_lid_identities(db, None, [(lid_jid, pn)])
        await db.commit()
        assert n == 1
        assert (await db.get(Lead, raw_lead.id)) is None
        kept = await db.get(Lead, keeper.id)
        assert kept.phone_e164 == pn


@pytest.mark.asyncio
async def test_merge_lid_identities_upgrades_placeholder_in_place():
    async with AsyncSessionLocal() as db:
        lid_jid = f"1678{uuid.uuid4().int % 100000000000:011d}@lid"
        pn = _uniq_e164()
        raw_lead = Lead(name=f"WhatsApp ({lid_jid})", phone=lid_jid, phone_e164=None,
                        status=LeadStatus.CONTACTED)
        db.add(raw_lead)
        await db.commit()

        n = await WhatsAppSyncService._merge_lid_identities(db, None, [(lid_jid, pn)])
        await db.commit()
        assert n == 0
        kept = await db.get(Lead, raw_lead.id)
        assert kept.phone_e164 == pn
        assert kept.phone == pn


@pytest.mark.asyncio
async def test_sync_contacts_updates_lead_name_and_heals_messages():
    session_name = await _make_session()
    phone = _uniq_e164()

    async with AsyncSessionLocal() as db:
        # Create a lead with placeholder name
        lead = Lead(name=f"WhatsApp ({phone})", phone=phone, phone_e164=phone, status=LeadStatus.CONTACTED)
        db.add(lead)
        await db.commit()
        await db.refresh(lead)

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP")
        db.add(conv)
        await db.commit()
        await db.refresh(conv)

        # Message with phone number as sender_name
        msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            body="Merhaba",
            sender_phone=phone,
            recipient_phone="ME",
            sender_name=phone,
        )
        db.add(msg)
        await db.commit()

        # Perform contacts sync
        res = await WhatsAppSyncService.sync_contacts(
            db=db,
            session_name=session_name,
            contacts=[{"id": f"{phone.replace('+', '')}@s.whatsapp.net", "phone": phone, "name": "Tolga Cebeci"}],
        )
        assert res["status"] == "success"
        assert res["healed_leads"] >= 1
        assert res["healed_messages"] >= 1

        # Check lead name updated
        await db.refresh(lead)
        assert lead.name == "Tolga Cebeci"

        # Check message sender_name updated
        await db.refresh(msg)
        assert msg.sender_name == "Tolga Cebeci"


@pytest.mark.asyncio
async def test_messages_chronological_order_in_fetch():
    from backend.app.api.v1.endpoints.conversations import _fetch_paginated_messages
    from datetime import datetime, timedelta

    async with AsyncSessionLocal() as db:
        lead = Lead(name="Order Test Lead", phone=_uniq_e164(), phone_e164=_uniq_e164(), status=LeadStatus.CONTACTED)
        db.add(lead)
        await db.commit()
        await db.refresh(lead)

        conv = Conversation(lead_id=lead.id, channel="WHATSAPP")
        db.add(conv)
        await db.commit()
        await db.refresh(conv)

        now = datetime.utcnow()
        # Insert newer message first (id 1, but time now)
        m1 = Message(conversation_id=conv.id, direction=MessageDirection.INBOUND, body="Son mesaj", sender_phone="1", recipient_phone="2", created_at=now)
        # Insert older message second (id 2, but time now - 1h)
        m2 = Message(conversation_id=conv.id, direction=MessageDirection.INBOUND, body="Eski mesaj", sender_phone="1", recipient_phone="2", created_at=now - timedelta(hours=1))
        # Insert oldest message third (id 3, but time now - 2h)
        m3 = Message(conversation_id=conv.id, direction=MessageDirection.INBOUND, body="En eski mesaj", sender_phone="1", recipient_phone="2", created_at=now - timedelta(hours=2))

        db.add_all([m1, m2, m3])
        await db.commit()

        # Fetch messages
        dtos, has_more, oldest_id, newest_id = await _fetch_paginated_messages(db, conv.id, limit=50)
        # Verify strict chronological order (oldest first, newest last)
        assert len(dtos) == 3
        assert dtos[0].body == "En eski mesaj"
        assert dtos[1].body == "Eski mesaj"
        assert dtos[2].body == "Son mesaj"
