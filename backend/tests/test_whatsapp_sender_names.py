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
