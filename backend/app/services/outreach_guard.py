"""
Outreach Quality & Entity Verification Guard.
Guarantees that unverified leads, private persons, or low-confidence records
are strictly blocked from entering WhatsApp marketing pipelines.
"""
import logging
from typing import List, Tuple, Dict, Any, Optional
from backend.app.models.lead import Lead, EntityType, VerificationStatus

logger = logging.getLogger(__name__)


class OutreachGuard:
    """
    Quality gatekeeper for outbound WhatsApp campaigns:
    - Blocks PERSON / DOCTOR / UNVERIFIED entries.
    - Permits only verified commercial business entities (CLINIC, BUSINESS, COMPANY).
    - Requires valid E.164 and WhatsApp eligibility.
    """

    ALLOWED_ENTITY_TYPES = {
        EntityType.BUSINESS.value,
        EntityType.CLINIC.value,
        EntityType.COMPANY.value,
    }

    @classmethod
    def can_enroll_in_campaign(
        cls, lead: Lead, sender_phone: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """
        Evaluates a single Lead record for campaign enrollment.
        Returns (is_allowed, reason_if_blocked).
        """
        # 1. WhatsApp eligibility check
        if not lead.is_whatsapp_eligible:
            return False, "Telefon numarası WhatsApp uyumlu değil."

        # 2. Self-Outreach Prevention: A sender cannot target their own connected line
        if sender_phone and lead.phone_e164:
            from backend.app.services.whatsapp.identity import is_self_identity
            if is_self_identity(lead.phone_e164, sender_phone):
                return False, "Lead telefon numarası gönderici WhatsApp hattı ile aynıdır (Kendi kendine outreach yapılamaz)."

        # 3. Entity Type Check: Private persons or unverified profiles are strictly blocked
        entity_type_val = lead.entity_type or EntityType.UNKNOWN.value
        if entity_type_val == EntityType.PERSON.value:
            return False, "Kayıt bir şahıs/doktor profilidir (PERSON != BUSINESS). Ticari işletme olmadan outreach yapılamaz."
        if entity_type_val not in cls.ALLOWED_ENTITY_TYPES:
            return False, f"Geçersiz işletme tipi: {entity_type_val}. Sadece doğrulanmış ticari işletmeler hedeflenebilir."

        # 4. Verification Status Check
        if not lead.is_verified or lead.verification_status != VerificationStatus.VERIFIED.value:
            return False, "İşletme henüz bağımsız kaynaklarla doğrulanmadı (UNVERIFIED)."

        return True, None

    @classmethod
    def filter_qualified_for_outreach(
        cls, leads: List[Lead], sender_phone: Optional[str] = None
    ) -> Tuple[List[Lead], List[Dict[str, Any]]]:
        """
        Filters a list of leads, partitioning into allowed leads and blocked reports.
        """
        allowed: List[Lead] = []
        blocked: List[Dict[str, Any]] = []

        for lead in leads:
            can_enroll, block_reason = cls.can_enroll_in_campaign(lead, sender_phone=sender_phone)
            if can_enroll:
                allowed.append(lead)
            else:
                blocked.append({
                    "lead_id": lead.id,
                    "name": lead.name,
                    "phone": lead.phone_e164,
                    "entity_type": lead.entity_type,
                    "reason": block_reason
                })

        logger.info(
            f"[OUTREACH_GUARD] Evaluated {len(leads)} leads: "
            f"{len(allowed)} APPROVED, {len(blocked)} BLOCKED"
        )
        return allowed, blocked
