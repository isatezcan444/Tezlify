"""
Domain Service for WhatsApp Contact management and phone normalization.

Enforces:
- Consistent E.164 phone normalization via PhoneService.
- Per-tenant contact deduplication on (user_id, phone_e164).
- Optional decoupling from CRM Leads (Contact can exist with or without a Lead).
"""
import logging
from typing import Optional, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_

from backend.app.models.contact import Contact
from backend.app.models.lead import Lead
from backend.app.services.phone_service import PhoneService
from backend.app.core.auth import get_user_filter

logger = logging.getLogger(__name__)


class ContactService:
    """Service handling Contact resolution, normalization, and CRM Lead linking."""

    @classmethod
    def normalize_phone(cls, raw_phone: str) -> str:
        """Normalizes any phone string to strict E.164 (+90...) format."""
        clean = (raw_phone or "").strip()
        parsed = PhoneService.normalize_to_e164(clean)
        if parsed and parsed.get("is_valid"):
            return parsed["e164"]
        # Fallback: digits with leading +
        digits = "".join(ch for ch in clean if ch.isdigit())
        return f"+{digits}" if not clean.startswith("+") else clean

    @classmethod
    async def get_or_create_contact(
        cls,
        db: AsyncSession,
        user_id: Optional[str],
        phone: str,
        display_name: Optional[str] = None,
        whatsapp_profile_name: Optional[str] = None,
        lead_id: Optional[int] = None,
        custom_attributes: Optional[Dict[str, Any]] = None,
    ) -> Contact:
        """
        Retrieves or provisions a Contact entity for the given phone number within the tenant.
        Prevents duplicate contacts for the same normalized phone number.
        """
        e164 = cls.normalize_phone(phone)

        stmt = select(Contact).where(Contact.phone_e164 == e164)
        if user_id:
            stmt = stmt.where(get_user_filter(Contact.user_id, user_id))

        res = await db.execute(stmt)
        contact = res.scalar_one_or_none()

        if contact:
            # Update missing attributes
            changed = False
            if display_name and not contact.display_name:
                contact.display_name = display_name.strip()
                changed = True
            if whatsapp_profile_name and not contact.whatsapp_profile_name:
                contact.whatsapp_profile_name = whatsapp_profile_name.strip()
                changed = True
            if lead_id and not contact.lead_id:
                contact.lead_id = lead_id
                changed = True
            if custom_attributes:
                current_attr = dict(contact.custom_attributes or {})
                current_attr.update(custom_attributes)
                contact.custom_attributes = current_attr
                changed = True
            if changed:
                await db.flush()
            return contact

        # If lead_id not provided, try to correlate with an existing CRM Lead by phone
        resolved_lead_id = lead_id
        if not resolved_lead_id:
            lead_stmt = select(Lead.id).where(Lead.phone_e164 == e164)
            if user_id:
                lead_stmt = lead_stmt.where(get_user_filter(Lead.user_id, user_id))
            resolved_lead_id = (await db.execute(lead_stmt)).scalar_one_or_none()

        contact = Contact(
            user_id=user_id,
            phone_e164=e164,
            display_name=display_name.strip() if display_name else None,
            whatsapp_profile_name=whatsapp_profile_name.strip() if whatsapp_profile_name else None,
            lead_id=resolved_lead_id,
            custom_attributes=custom_attributes,
        )

        db.add(contact)
        await db.flush()
        return contact
