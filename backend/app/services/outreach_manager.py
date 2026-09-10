import logging
from datetime import datetime
from typing import Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign import Campaign
from backend.app.models.blacklist import Blacklist
from backend.app.services.spintax_service import SpintaxService
from backend.app.services.antiban_policy import AntibanPolicy, gaussian_jitter_seconds

logger = logging.getLogger(__name__)

# WhatsApp gönderim altyapısı tamamen kaldırıldığı için kampanya gönderim
# adımı hiçbir dış servise ulaşmadan açık ve dürüst bir sonuç döndürür.
NO_DISPATCH_BACKEND_MESSAGE = (
    "WhatsApp gönderim altyapısı bulunmuyor; mesaj gönderilemedi."
)


class OutreachManager:
    """
    Coordinates safe, humanized, anti-ban message dispatch preparation.

    The messaging pipeline (lead validation, blacklist, working hours,
    spintax rendering, jitter) is preserved; the actual WhatsApp dispatch
    backend has been removed, so dispatch always resolves to an explicit,
    truthful failure instead of pretending a message was sent.
    """

    @classmethod
    def calculate_jitter_delay(cls, min_delay: int, max_delay: int) -> int:
        """Calculates a realistic humanized delay using Gaussian distribution."""
        return gaussian_jitter_seconds(min_delay, max_delay)

    @classmethod
    async def is_blacklisted(cls, db: AsyncSession, phone_e164: str) -> bool:
        """Checks if phone number is present in Blacklist."""
        stmt = select(Blacklist).where(Blacklist.phone_e164 == phone_e164)
        result = await db.execute(stmt)
        return result.scalar_one_or_none() is not None

    @classmethod
    async def process_single_outreach(
        cls,
        db: AsyncSession,
        lead_id: int,
        campaign_id: int,
        session_id: Optional[int] = None,
    ) -> Tuple[bool, str, Optional[int]]:
        """
        Validates lead, checks blacklist, generates customized Spintax message,
        applies policy checks, and resolves the dispatch outcome truthfully.

        No WhatsApp dispatch backend exists in this build, so every outreach
        resolves to an explicit failure — no log rows are fabricated and no
        counter is bumped for a send that never happened.
        """
        # 1. Fetch Lead
        lead = await db.get(Lead, lead_id)
        if not lead:
            return False, "Lead bulunamadı", None

        if not lead.is_whatsapp_eligible or not lead.phone_e164:
            return False, "Telefon WhatsApp için uygun değil veya geçerli E.164 numarası yok", None

        # 2. Check Blacklist
        if await cls.is_blacklisted(db, lead.phone_e164):
            lead.status = LeadStatus.UNSUBSCRIBED
            await db.commit()
            return False, "Numara kara listede (Blacklisted)", None

        # 3. Fetch Campaign
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

        # 6. Calculate Humanized Jitter Delay (informational; no send follows)
        delay_sec = policy.jitter_seconds()

        # 7. Dispatch outcome: no WhatsApp backend exists in this build.
        logger.info(
            "[OutreachManager] Lead %d blocked from dispatch: %s (rendered %d chars, jitter %ds)",
            lead.id, NO_DISPATCH_BACKEND_MESSAGE, len(rendered_msg), delay_sec,
        )
        return False, NO_DISPATCH_BACKEND_MESSAGE, None