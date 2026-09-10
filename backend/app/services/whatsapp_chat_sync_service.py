"""
WhatsApp Chat & Contact Sync Service (WhatsApp-Web-grade, zero-lag).

Single source of truth for materializing Baileys wa-gateway chats into
Leads, Conversations and Messages. Uses strict bulk operations (batched
SELECTs + bulk UPSERTs) so a full phonebook sync is O(1) round-trips
instead of per-chat queries — the sync stays instant even with thousands
of chats.

Both entry points share this service (SRP / DRY):
- POST /conversations/sync-whatsapp          (manual refresh button)
- POST /whatsapp/webhook/chats-synced        (auto-sync the moment a
  session connects / history syncs, so the UI fills itself with zero lag)
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.lead import Lead
from backend.app.models.message import Message, MessageDirection
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services.phone_service import PhoneService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NormalizedChat:
    """Gateway chat row normalized into a canonical, schema-agnostic shape."""
    jid: str
    phone_e164: Optional[str]
    raw_phone: Optional[str]
    name: str
    is_group: bool
    unread_count: int
    last_message_text: str
    last_message_from_me: bool
    timestamp_seconds: int
    jid_aliases: Tuple[str, ...] = ()

    @property
    def place_id(self) -> str:
        """Deterministic dedup key (AGENTS.md 1.3: never process-local hash)."""
        if self.is_group:
            return f"group_{hashlib.sha256(self.jid.encode()).hexdigest()[:16]}"
        seed = self.phone_e164 or self.jid
        return f"wa_{hashlib.sha256(seed.encode()).hexdigest()[:16]}"


@dataclass
class SyncReport:
    """Outcome summary returned to callers and tests (no false positives)."""
    synced_count: int = 0
    created_leads: int = 0
    updated_leads: int = 0
    created_conversations: int = 0
    new_messages: int = 0
    skipped: int = 0
    session_name: str = ""
    revision: Optional[int] = None
    errors: List[str] = field(default_factory=list)

    def to_payload(self) -> dict:
        return {
            "status": "success" if not self.errors else "partial",
            "synced_count": self.synced_count,
            "created_leads": self.created_leads,
            "updated_leads": self.updated_leads,
            "created_conversations": self.created_conversations,
            "new_messages": self.new_messages,
            "skipped": self.skipped,
            "session_name": self.session_name,
            "revision": self.revision,
            "errors": self.errors,
        }


class WhatsAppChatSyncService:
    """Materializes wa-gateway chats into the relational inbox (bulk, lag-free)."""

    # Last gateway revision successfully materialized per session name.
    # Enables O(changes) delta polls instead of O(all chats) full syncs.
    last_sync_revisions: Dict[str, int] = {}

    # ------------------------------------------------------------------
    # Normalization (gateway payload -> canonical shape)
    # ------------------------------------------------------------------
    @classmethod
    def normalize_chats(cls, chats: List[dict]) -> List[NormalizedChat]:
        if not chats or not isinstance(chats, list):
            return []
        normalized: List[NormalizedChat] = []
        seen_jids = set()
        for c in chats:
            if not isinstance(c, dict):
                continue
            jid = str(c.get("id") or c.get("jid") or "").strip()
            if not jid or jid in seen_jids or "@broadcast" in jid or jid.endswith("@newsletter"):
                continue
            seen_jids.add(jid)

            is_group = bool(
                c.get("is_group") if c.get("is_group") is not None else c.get("isGroup", False)
            ) or jid.endswith("@g.us")

            raw_phone = c.get("phone")
            if raw_phone and not is_group:
                raw_phone = str(raw_phone)
                phone_e164: Optional[str] = None
                parsed = PhoneService.normalize_to_e164(raw_phone)
                if parsed:
                    phone_e164 = parsed["e164"]
                elif raw_phone.startswith("+"):
                    # International non-TR number: keep E.164-ish literal,
                    # never invent digits (AGENTS.md 1.3 fail-closed).
                    phone_e164 = raw_phone
            else:
                phone_e164 = None

            last_msg = c.get("last_message") if c.get("last_message") is not None else c.get("lastMessage")
            last_text = ""
            from_me = False
            if isinstance(last_msg, dict):
                last_text = str(last_msg.get("text") or last_msg.get("body") or "")
                from_me = bool(last_msg.get("from_me", False))
            elif isinstance(last_msg, str):
                last_text = last_msg

            unread_raw = c.get("unread_count") if c.get("unread_count") is not None else c.get("unreadCount")
            try:
                unread_count = int(unread_raw or 0)
            except (TypeError, ValueError):
                unread_count = 0

            try:
                timestamp_seconds = int(c.get("timestamp") or 0)
            except (TypeError, ValueError):
                timestamp_seconds = 0

            aliases_raw = c.get("jid_aliases") or c.get("jidAliases") or []
            jid_aliases = tuple(
                str(alias).strip()
                for alias in aliases_raw
                if alias and str(alias).strip() != jid
            ) if isinstance(aliases_raw, list) else ()

            raw_name = str(c.get("name") or "").strip()
            resolved_name = raw_name or phone_e164 or ("WhatsApp Grubu" if is_group else (jid.split("@")[0] or "Bilinmeyen"))

            normalized.append(
                NormalizedChat(
                    jid=jid,
                    phone_e164=phone_e164,
                    raw_phone=str(raw_phone) if raw_phone else None,
                    name=resolved_name,
                    is_group=is_group,
                    unread_count=unread_count,
                    last_message_text=last_text,
                    last_message_from_me=from_me,
                    timestamp_seconds=timestamp_seconds,
                    jid_aliases=jid_aliases,
                )
            )
        return normalized

    # ------------------------------------------------------------------
    # Bulk persistence
    # ------------------------------------------------------------------
    @classmethod
    async def sync_chats(
        cls,
        db: AsyncSession,
        session: WhatsAppSession,
        chats: List[dict],
        revision: Optional[int] = None,
    ) -> SyncReport:
        report = SyncReport(session_name=session.session_name, revision=revision)
        try:
            normalized = cls.normalize_chats(chats)
        except Exception as e:
            logger.exception("normalize_chats failed")
            report.errors.append(f"Chat normalization error: {str(e)}")
            return report

        if not normalized:
            return report

        try:
            leads_by_key = await cls._upsert_leads_bulk(db, normalized, session, report)
            await cls._merge_alias_conversations(db, normalized, leads_by_key, session)
            convs_by_key = await cls._upsert_conversations_bulk(
                db, normalized, leads_by_key, session, report
            )
            await cls._sync_latest_messages_bulk(
                db, normalized, convs_by_key, session, report
            )
            await db.commit()
        except Exception as e:
            await db.rollback()
            report.errors.append(str(e))
            logger.exception("Bulk WhatsApp chat sync failed")
            return report

        report.synced_count = len(normalized)
        if revision is not None and not report.errors:
            cls.last_sync_revisions[session.session_name] = revision
        return report

    # ------------------------------------------------------------------
    # Internal bulk stages
    # ------------------------------------------------------------------
    @staticmethod
    def _chat_key(chat: NormalizedChat) -> str:
        """Identity used to join leads/conversations across bulk maps."""
        if chat.is_group:
            return f"grp:{chat.jid}"
        digits = (chat.phone_e164 or chat.raw_phone or chat.jid.split("@")[0] or "")
        digits = "".join(ch for ch in digits if ch.isdigit())
        return f"tel:{digits[-10:]}" if len(digits) >= 10 else f"jid:{chat.jid}"

    @classmethod
    async def _merge_alias_conversations(
        cls,
        db: AsyncSession,
        chats: List[NormalizedChat],
        leads_by_key: Dict[str, Lead],
        session: WhatsAppSession,
    ) -> None:
        alias_jids = {alias for chat in chats for alias in chat.jid_aliases}
        if not alias_jids:
            return

        alias_leads = (
            await db.execute(select(Lead).where(Lead.user_id == session.user_id))
        ).scalars().all()
        alias_by_jid = {
            str((lead.custom_data or {}).get("whatsapp_jid")): lead
            for lead in alias_leads
            if (lead.custom_data or {}).get("whatsapp_jid") in alias_jids
            and (lead.custom_data or {}).get("whatsapp_session_name") == session.session_name
        }

        for chat in chats:
            target_lead = leads_by_key.get(cls._chat_key(chat))
            if target_lead is None:
                continue
            for alias_jid in chat.jid_aliases:
                alias_lead = alias_by_jid.get(alias_jid)
                if alias_lead is None or alias_lead.id == target_lead.id:
                    continue

                conversations = (
                    await db.execute(
                        select(Conversation).where(
                            Conversation.lead_id.in_([target_lead.id, alias_lead.id]),
                            Conversation.channel == "WHATSAPP",
                        )
                    )
                ).scalars().all()
                target_conv = next((c for c in conversations if c.lead_id == target_lead.id), None)
                alias_conv = next((c for c in conversations if c.lead_id == alias_lead.id), None)

                if alias_conv and target_conv:
                    await db.execute(
                        Message.__table__.update()
                        .where(Message.conversation_id == alias_conv.id)
                        .values(conversation_id=target_conv.id, user_id=session.user_id)
                    )
                    target_conv.unread_count = max(
                        target_conv.unread_count or 0, alias_conv.unread_count or 0
                    )
                    if (
                        alias_conv.last_message_at
                        and (
                            not target_conv.last_message_at
                            or alias_conv.last_message_at > target_conv.last_message_at
                        )
                    ):
                        target_conv.last_message_at = alias_conv.last_message_at
                        target_conv.last_message_preview = alias_conv.last_message_preview
                    await db.delete(alias_conv)
                elif alias_conv:
                    alias_conv.lead_id = target_lead.id
                    alias_conv.user_id = session.user_id

                await db.flush()
                remaining = (
                    await db.execute(
                        select(Conversation.id).where(Conversation.lead_id == alias_lead.id).limit(1)
                    )
                ).scalar_one_or_none()
                if remaining is None:
                    await db.delete(alias_lead)

        await db.flush()

    @classmethod
    async def _upsert_leads_bulk(
        cls,
        db: AsyncSession,
        chats: List[NormalizedChat],
        session: WhatsAppSession,
        report: SyncReport,
    ) -> Dict[str, Lead]:
        person_chats = [c for c in chats if not c.is_group]

        e164_values = [c.phone_e164 for c in person_chats if c.phone_e164]
        place_ids = [c.place_id for c in chats]

        predicate = []
        if e164_values:
            predicate.append(Lead.phone_e164.in_(e164_values))
        if place_ids:
            predicate.append(Lead.place_id.in_(place_ids))

        found: Dict[str, Lead] = {}
        if predicate:
            rows = await db.execute(select(Lead).where(or_(*predicate)))
            for lead in rows.scalars().all():
                if lead.phone_e164:
                    digits = "".join(ch for ch in lead.phone_e164 if ch.isdigit())
                    if len(digits) >= 10:
                        found.setdefault(f"tel:{digits[-10:]}", lead)
                if lead.place_id:
                    found.setdefault(f"pid:{lead.place_id}", lead)

        result: Dict[str, Lead] = {}
        for chat in chats:
            lead = found.get(f"pid:{chat.place_id}")
            if lead is None and not chat.is_group and chat.phone_e164:
                digits = "".join(ch for ch in chat.phone_e164 if ch.isdigit())
                lead = found.get(f"tel:{digits[-10:]}") if len(digits) >= 10 else None

            if lead is None:
                lead = Lead(
                    user_id=session.user_id,
                    name=chat.name,
                    phone=chat.raw_phone or chat.jid,
                    phone_e164=chat.phone_e164,
                    is_whatsapp_eligible=bool(chat.phone_e164),
                    place_id=chat.place_id,
                    category="WhatsApp Grubu" if chat.is_group else "WhatsApp Kişisi",
                    custom_data={"is_group": chat.is_group, "whatsapp_jid": chat.jid},
                )
                report.created_leads += 1
                # Intra-batch dedup: register immediately so repeated chats reuse this new instance
                if chat.place_id:
                    found[f"pid:{chat.place_id}"] = lead
                if not chat.is_group and chat.phone_e164:
                    digits = "".join(ch for ch in chat.phone_e164 if ch.isdigit())
                    if len(digits) >= 10:
                        found[f"tel:{digits[-10:]}"] = lead

            # WhatsApp chats are personal to the session owner: transfer if owned by another user
            if session.user_id and str(lead.user_id or "") != str(session.user_id):
                lead.user_id = session.user_id
                report.updated_leads += 1

            if not lead.name or lead.name.startswith("+") or lead.name == "Bilinmeyen Numara":
                lead.name = chat.name
            if not lead.phone_e164 and chat.phone_e164:
                lead.phone_e164 = chat.phone_e164
                lead.is_whatsapp_eligible = True

            custom = dict(lead.custom_data or {})
            existing_aliases = custom.get("whatsapp_jid_aliases") or []
            custom.update({
                "is_group": chat.is_group,
                "whatsapp_jid": chat.jid,
                "whatsapp_session_name": session.session_name,
                "whatsapp_jid_aliases": sorted(set(existing_aliases) | set(chat.jid_aliases)),
            })
            lead.custom_data = custom
            result[cls._chat_key(chat)] = lead
            db.add(lead)

        # Group chats intentionally keep phone_e164 NULL (AGENTS.md 1.3).
        await db.flush()
        return result

    @classmethod
    async def _upsert_conversations_bulk(
        cls,
        db: AsyncSession,
        chats: List[NormalizedChat],
        leads_by_key: Dict[str, Lead],
        session: WhatsAppSession,
        report: SyncReport,
    ) -> Dict[str, Conversation]:
        lead_ids = [lead.id for lead in leads_by_key.values() if lead.id is not None]

        convs_by_lead: Dict[int, Conversation] = {}
        if lead_ids:
            # One active conversation per (lead, channel) is schema-enforced
            # (idx_unique_active_conv) and leads are globally unique by phone/place_id,
            # so the conversation identity is also global — never create a second
            # thread for the same lead. Ownership is repaired below for orphan rows.
            rows = await db.execute(
                select(Conversation).where(
                    Conversation.lead_id.in_(lead_ids),
                    Conversation.channel == "WHATSAPP",
                )
            )
            for conv in rows.scalars().all():
                convs_by_lead.setdefault(conv.lead_id, conv)

        result: Dict[str, Conversation] = {}
        now = datetime.utcnow()
        for chat in chats:
            lead = leads_by_key.get(cls._chat_key(chat))
            if lead is None:
                report.skipped += 1
                continue

            conv = convs_by_lead.get(lead.id) if lead.id is not None else None
            if conv is None:
                conv = Conversation(
                    user_id=session.user_id,
                    lead_id=lead.id,
                    channel="WHATSAPP",
                    status=ConversationStatus.ACTIVE,
                    unread_count=chat.unread_count,
                    last_message_preview=chat.last_message_text or None,
                )
                report.created_conversations += 1
                # Intra-batch dedup: register immediately so repeated chats reuse this conversation
                if lead.id is not None:
                    convs_by_lead[lead.id] = conv
            else:
                if session.user_id and str(conv.user_id or "") != str(session.user_id):
                    conv.user_id = session.user_id
                conv.unread_count = chat.unread_count
                if chat.last_message_text:
                    conv.last_message_preview = chat.last_message_text

            if chat.timestamp_seconds > 0:
                try:
                    conv.last_message_at = datetime.fromtimestamp(chat.timestamp_seconds)
                except (OverflowError, OSError, ValueError):
                    conv.last_message_at = conv.last_message_at or now
            elif chat.last_message_text and not conv.last_message_at:
                conv.last_message_at = now

            result[cls._chat_key(chat)] = conv
            db.add(conv)

        await db.flush()
        return result

    @classmethod
    async def _sync_latest_messages_bulk(
        cls,
        db: AsyncSession,
        chats: List[NormalizedChat],
        convs_by_key: Dict[str, Conversation],
        session: WhatsAppSession,
        report: SyncReport,
    ) -> None:
        conv_ids = [c.id for c in convs_by_key.values() if c.id is not None]
        # Snapshot only the comparison field: ORM attribute access later (after
        # flush expires instances) would trigger sync IO and break the event loop.
        latest_body_by_conv: Dict[int, str] = {}
        if conv_ids:
            rows = await db.execute(
                select(Message.conversation_id, Message.body)
                .where(Message.conversation_id.in_(conv_ids))
                .order_by(Message.conversation_id, Message.created_at.desc(), Message.id.desc())
            )
            for conv_id, body in rows.all():
                latest_body_by_conv.setdefault(conv_id, body or "")

        business_phone = session.phone_number or "BUSINESS"
        for chat in chats:
            conv = convs_by_key.get(cls._chat_key(chat))
            if conv is None or not chat.last_message_text:
                continue

            latest_body = latest_body_by_conv.get(conv.id) if conv.id is not None else None
            if latest_body is not None and latest_body == chat.last_message_text:
                continue

            # Update latest body to prevent inserting identical messages within the same sync batch
            if conv.id is not None:
                latest_body_by_conv[conv.id] = chat.last_message_text

            try:
                msg_dt = (
                    datetime.fromtimestamp(chat.timestamp_seconds)
                    if chat.timestamp_seconds > 0
                    else datetime.utcnow()
                )
            except (OverflowError, OSError, ValueError):
                msg_dt = datetime.utcnow()

            direction = (
                MessageDirection.OUTBOUND if chat.last_message_from_me else MessageDirection.INBOUND
            )
            db.add(
                Message(
                    user_id=session.user_id,
                    conversation_id=conv.id,
                    direction=direction,
                    body=chat.last_message_text,
                    sender_phone=business_phone if chat.last_message_from_me else (chat.phone_e164 or chat.jid),
                    recipient_phone=(chat.phone_e164 or chat.jid) if chat.last_message_from_me else business_phone,
                    sender_name="Siz" if chat.last_message_from_me else chat.name,
                    created_at=msg_dt,
                )
            )
            report.new_messages += 1
