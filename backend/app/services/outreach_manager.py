import logging
from datetime import datetime
from typing import Optional, Tuple

from backend.app.core.datetime_utils import utc_now_naive
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign import Campaign
from backend.app.models.blacklist import Blacklist
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.services.spintax_service import SpintaxService
from backend.app.services.antiban_policy import AntibanPolicy, gaussian_jitter_seconds

logger = logging.getLogger(__name__)


class OutreachManager:
    """
    Coordinates safe, humanized, anti-ban message dispatch preparation and live dispatch.

    The messaging pipeline validates leads, checks blacklist, verifies working hours,
    renders personalized spintax, and dispatches via the live Baileys WhatsApp Gateway.
    All dispatch operations fail-closed on gateway error (truthfulness invariant).
    """

    @classmethod
    def calculate_jitter_delay(cls, min_delay: int, max_delay: int) -> int:
        """Calculates a realistic humanized delay using Gaussian distribution."""
        return gaussian_jitter_seconds(min_delay, max_delay)

    @classmethod
    async def is_blacklisted(cls, db: AsyncSession, phone_e164: str) -> bool:
        """Checks if phone number is present in Blacklist."""
        stmt = select(Blacklist.id).where(Blacklist.phone_e164 == phone_e164).limit(1)
        result = await db.execute(stmt)
        return result.scalar_one_or_none() is not None

    @classmethod
    async def get_blacklisted_phones(cls, db: AsyncSession, phones: list[str]) -> set[str]:
        """Batch checks phone numbers against Blacklist in a single query."""
        if not phones:
            return set()
        stmt = select(Blacklist.phone_e164).where(Blacklist.phone_e164.in_(phones))
        result = await db.execute(stmt)
        return set(result.scalars().all())

    @classmethod
    async def process_single_outreach(
        cls,
        db: AsyncSession,
        lead_id: int,
        campaign_id: int,
        session_id: Optional[int] = None,
        lead: Optional[Lead] = None,
        campaign: Optional[Campaign] = None,
        blacklisted_phones: Optional[set[str]] = None,
    ) -> Tuple[bool, str, Optional[int]]:
        """
        Validates lead, checks blacklist, generates customized Spintax message,
        applies policy checks, and resolves the dispatch outcome truthfully.

        No WhatsApp dispatch backend exists in this build, so every outreach
        resolves to an explicit failure — no log rows are fabricated and no
        counter is bumped for a send that never happened.
        """
        # 1. Resolve Lead (reuse instance if already loaded in caller loop)
        if lead is None:
            lead = await db.get(Lead, lead_id)
        if not lead:
            return False, "Lead bulunamadı", None

        if not lead.is_whatsapp_eligible or not lead.phone_e164:
            return False, "Telefon WhatsApp için uygun değil veya geçerli E.164 numarası yok", None

        # 2. Check Blacklist (use batch pre-resolved set if provided, else single-query)
        is_bl = (
            lead.phone_e164 in blacklisted_phones
            if blacklisted_phones is not None
            else await cls.is_blacklisted(db, lead.phone_e164)
        )
        if is_bl:
            lead.status = LeadStatus.UNSUBSCRIBED
            await db.commit()
            return False, "Numara kara listede (Blacklisted)", None

        # 3. Resolve Campaign (reuse instance if already loaded in caller loop)
        if campaign is None:
            campaign = await db.get(Campaign, campaign_id)
        if not campaign:
            return False, "Kampanya bulunamadı", None

        # 4. Check Policy & Working Hours (Fail-Closed)
        policy = AntibanPolicy.from_campaign(campaign)
        if not policy.is_within_working_hours():
            return False, f"Mesai saatleri dışında ({campaign.working_hours_start}-{campaign.working_hours_end})", None

        # 5. Render Spintax Message with Lead Variables
        lead_dict = {
            "name": lead.name,
            "category": lead.category or "",
            "city": lead.city or "",
            "district": lead.district or "",
            "address": lead.address or "",
            "rating": lead.rating or "",
            "website": lead.website or "",
            "phone": lead.phone_e164
        }
        rendered_msg = SpintaxService.render_template(campaign.message_template, lead_dict)

        # 6. Calculate Humanized Jitter Delay
        delay_sec = policy.jitter_seconds()

        # 7. Dispatch via live WhatsApp Gateway
        user_id_str = str(campaign.user_id) if campaign.user_id else None
        if not user_id_str:
            return False, "Kampanya sahibi (user_id) bulunamadı; gönderim yapılamaz.", None

        try:
            from backend.app.services import whatsapp_service
            # Dispatch message live through connected Baileys session
            result = await whatsapp_service.start_conversation(
                db=db,
                user_id=user_id_str,
                phone=lead.phone_e164,
                name=lead.name,
                message=rendered_msg,
                session_id=session_id,
            )

            # Record in MessageLog
            msg_log = MessageLog(
                user_id=campaign.user_id,
                lead_id=lead.id,
                campaign_id=campaign.id,
                target_phone=lead.phone_e164,
                rendered_message=rendered_msg,
                status=MessageStatus.SENT,
                sent_at=utc_now_naive(),
                delay_applied_seconds=delay_sec,
            )
            db.add(msg_log)

            lead.status = LeadStatus.CONTACTED
            lead.last_contacted_at = utc_now_naive()
            campaign.sent_count = (campaign.sent_count or 0) + 1

            # Bi-directional link between Conversation / Contact and Lead
            conv_id = result.get("id") if isinstance(result, dict) else None
            if conv_id:
                from backend.app.models.conversation import Conversation
                from backend.app.models.contact import Contact
                conv = await db.get(Conversation, conv_id)
                if conv:
                    if not conv.lead_id:
                        conv.lead_id = lead.id
                    if conv.contact_id:
                        ct = await db.get(Contact, conv.contact_id)
                        if ct and not ct.lead_id:
                            ct.lead_id = lead.id

            await db.commit()
            await db.refresh(msg_log)

            logger.info(
                f"[OutreachManager] Lead {lead.id} ({lead.phone_e164}) outreach SUCCESS "
                f"via WhatsApp Gateway (log_id={msg_log.id})"
            )
            return True, "Mesaj başarıyla iletildi", msg_log.id

        except Exception as exc:
            logger.warning(
                f"[OutreachManager] Lead {lead.id} ({lead.phone_e164}) outreach FAILED: {exc}"
            )
            msg_log = MessageLog(
                user_id=campaign.user_id,
                lead_id=lead.id,
                campaign_id=campaign.id,
                target_phone=lead.phone_e164,
                rendered_message=rendered_msg,
                status=MessageStatus.FAILED,
                error_reason=str(exc),
                delay_applied_seconds=delay_sec,
            )
            db.add(msg_log)
            campaign.failed_count = (campaign.failed_count or 0) + 1
            await db.commit()
            return False, f"WhatsApp gönderim hatası: {str(exc)}", None