"""
WhatsApp Template Service for Tezlify.

Provides a clean, simplicity-first template engine:
- Pre-configured business templates (Welcome, Follow-up, Reminder, Info Request).
- Variable resolution (lead name, date, custom fields).
- Meta Graph API template dispatch and simulated fallback.
- Outbound persistence, Conversation lifecycle auto-reopen, and WebSocket broadcast.
"""
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.config import settings
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.services.phone_service import PhoneService
from backend.app.services.whatsapp_cloud_client import WhatsAppCloudApiClient
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)

# Predefined business templates
BUSINESS_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "welcome_intro": {
        "key": "welcome_intro",
        "name": "Hoş Geldiniz",
        "name_en": "Welcome Greeting",
        "description": "Yeni müşteriler için selamlama ve ilk temas mesajı",
        "category": "UTILITY",
        "meta_template_name": "hello_world",
        "language": "tr",
        "body_pattern": "Merhaba {name}, Tezlify üzerinden sizinle iletişime geçiyoruz. Size nasıl yardımcı olabiliriz?",
        "variables": [
            {"key": "name", "label": "Müşteri / Firma Adı", "default_from": "lead_name"}
        ],
    },
    "offer_followup": {
        "key": "offer_followup",
        "name": "Teklif Takibi",
        "name_en": "Offer Follow-up",
        "description": "Hazırlanan teklif veya görüşme takibi için mesaj",
        "category": "MARKETING",
        "meta_template_name": "offer_followup_tr",
        "language": "tr",
        "body_pattern": "Merhaba {name}, hazırladığımız teklif hakkında görüşmek isteriz. Müsait olduğunuzda görüşebilir miyiz?",
        "variables": [
            {"key": "name", "label": "Müşteri / Firma Adı", "default_from": "lead_name"}
        ],
    },
    "appointment_reminder": {
        "key": "appointment_reminder",
        "name": "Randevu Hatırlatma",
        "name_en": "Appointment Reminder",
        "description": "Planlanan görüşme veya randevu hatırlatması",
        "category": "UTILITY",
        "meta_template_name": "appointment_reminder_tr",
        "language": "tr",
        "body_pattern": "Merhaba {name}, {time} tarihindeki görüşmemizi hatırlatmak isteriz.",
        "variables": [
            {"key": "name", "label": "Müşteri / Firma Adı", "default_from": "lead_name"},
            {"key": "time", "label": "Randevu / Görüşme Zamanı", "default_value": "yarın 14:00"}
        ],
    },
    "info_request": {
        "key": "info_request",
        "name": "Bilgi Talebi",
        "name_en": "Information Request",
        "description": "Hizmetlerimiz hakkında bilgi talebi daveti",
        "category": "UTILITY",
        "meta_template_name": "info_request_tr",
        "language": "tr",
        "body_pattern": "Merhaba {name}, hizmetlerimiz hakkında detaylı bilgi almak için bu mesaja yanıt verebilirsiniz.",
        "variables": [
            {"key": "name", "label": "Müşteri / Firma Adı", "default_from": "lead_name"}
        ],
    },
}


class WhatsAppTemplateService:
    """Service handling WhatsApp template listing, variable rendering, and outbound dispatch."""

    @staticmethod
    def list_templates() -> List[Dict[str, Any]]:
        """Returns the list of available business templates for frontend display."""
        return list(BUSINESS_TEMPLATES.values())

    @staticmethod
    def get_template(template_key: str) -> Optional[Dict[str, Any]]:
        """Fetches a single template definition by key."""
        return BUSINESS_TEMPLATES.get(template_key)

    @classmethod
    def render_body(
        cls,
        template_def: Dict[str, Any],
        variables: Dict[str, str],
        lead_name: Optional[str] = None
    ) -> str:
        """Renders the template body string replacing variable placeholders."""
        safe_vars = {}
        for var in template_def.get("variables", []):
            k = var["key"]
            if k in variables and variables[k].strip():
                safe_vars[k] = variables[k].strip()
            elif var.get("default_from") == "lead_name" and lead_name:
                safe_vars[k] = lead_name.strip()
            else:
                safe_vars[k] = var.get("default_value", "Değerli Müşterimiz")

        pattern = template_def.get("body_pattern", "")
        try:
            return pattern.format(**safe_vars)
        except KeyError:
            return pattern

    @classmethod
    async def send_template_message(
        cls,
        db: AsyncSession,
        conversation_id: int,
        template_key: str,
        variables: Optional[Dict[str, str]] = None,
        idempotency_key: Optional[str] = None,
        force_simulation: Optional[bool] = None,
    ) -> Message:
        """
        Validates conversation, renders template, dispatches via Meta API or Simulation,
        persists Message, and broadcasts WebSocket event.
        """
        template_def = cls.get_template(template_key)
        if not template_def:
            raise HTTPException(
                status_code=404,
                detail=f"'{template_key}' isimli şablon bulunamadı."
            )

        # 1. Fetch Conversation & Lead
        stmt = (
            select(Conversation)
            .where(Conversation.id == conversation_id)
            .options(selectinload(Conversation.lead))
        )
        conv = (await db.execute(stmt)).scalar_one_or_none()
        if not conv:
            raise HTTPException(status_code=404, detail="Diyalog bulunamadı.")

        if conv.status == ConversationStatus.CLOSED:
            raise HTTPException(
                status_code=400,
                detail="Kapalı bir diyaloğa mesaj gönderilemez. Lütfen önce diyaloğu yeniden açın.",
            )

        lead = conv.lead
        if not lead:
            raise HTTPException(status_code=404, detail="Diyalog ile ilişkili müşteri bulunamadı.")

        # 2. Resolve & Normalize Recipient Phone
        raw_phone = lead.phone_e164 or lead.phone
        if not raw_phone:
            raise HTTPException(
                status_code=400,
                detail="Müşteriye ait geçerli bir telefon numarası bulunamadı.",
            )

        phone_data = PhoneService.normalize_to_e164(raw_phone)
        e164_phone = phone_data["e164"] if phone_data else (
            f"+{raw_phone}" if not raw_phone.startswith("+") else raw_phone
        )

        # 3. Render Body
        rendered_body = cls.render_body(template_def, variables or {}, lead.name)

        # 4. Check Idempotency
        if idempotency_key:
            from backend.app.services.whatsapp_outbound_service import _idempotency_cache
            if idempotency_key in _idempotency_cache:
                _, cached_msg_id = _idempotency_cache[idempotency_key]
                cached_msg = await db.get(Message, cached_msg_id)
                if cached_msg:
                    logger.info(f"[WhatsAppTemplateService] Idempotency match for key {idempotency_key}")
                    return cached_msg

        # 5. Dispatch via Meta Cloud API or Simulation
        is_sim = settings.SIMULATION_MODE if force_simulation is None else force_simulation
        wa_message_id: Optional[str] = None

        if is_sim or not settings.WHATSAPP_CLOUD_ENABLED:
            import time, random
            wa_message_id = f"wamid.SIM_TMPL_{int(time.time())}_{random.randint(100000, 999999)}"
            logger.info(
                f"[WhatsAppTemplateService] (SIMULATION) Template message dispatched: "
                f"conv_id={conv.id}, template={template_key}, recipient={e164_phone}"
            )
        else:
            client = WhatsAppCloudApiClient()
            
            # Extract ordered parameter values if template defines variables
            param_values = None
            if template_def.get("meta_template_name") != "hello_world":
                param_values = []
                for var in template_def.get("variables", []):
                    k = var["key"]
                    if variables and k in variables and variables[k].strip():
                        param_values.append(variables[k].strip())
                    elif var.get("default_from") == "lead_name" and lead.name:
                        param_values.append(lead.name.strip())
                    else:
                        param_values.append(var.get("default_value", "Değerli Müşterimiz"))

            dispatch_res = await client.send_template_message(
                to_phone=e164_phone,
                template_name=template_def.get("meta_template_name", "hello_world"),
                language_code=template_def.get("language", "tr"),
                parameters=param_values,
            )

            if not dispatch_res.get("success"):
                error_msg = dispatch_res.get("error") or "Meta Cloud API şablon mesajını iletemedi."
                logger.error(f"[WhatsAppTemplateService] Dispatch failed: {error_msg}")
                raise HTTPException(
                    status_code=502,
                    detail=f"WhatsApp şablon mesajı gönderilemedi: {error_msg}",
                )

            wa_message_id = dispatch_res.get("message_id")

        # TIMESTAMP WITHOUT TIME ZONE columns: asyncpg rejects tz-aware values,
        # so always persist naive UTC here.
        now_utc = datetime.now(timezone.utc).replace(tzinfo=None)

        # 6. Persist Message
        outbound_msg = Message(
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body=rendered_body,
            wa_message_id=wa_message_id,
            sender_phone="BUSINESS",
            recipient_phone=e164_phone,
            sender_name="Siz",
            status=ConversationMessageStatus.SENT,
            external_timestamp=now_utc,
            created_at=now_utc,
            updated_at=now_utc,
        )
        db.add(outbound_msg)

        # 7. Update Conversation
        conv.last_message_at = now_utc
        conv.updated_at = now_utc
        if conv.status == ConversationStatus.ARCHIVED:
            conv.status = ConversationStatus.ACTIVE

        try:
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("[WhatsAppTemplateService] Template message persistence failed")
            raise HTTPException(status_code=500, detail="Şablon mesajı kaydedilemedi, lütfen tekrar deneyin.")
        await db.refresh(outbound_msg)

        if idempotency_key:
            import time
            from backend.app.services.whatsapp_outbound_service import _idempotency_cache
            _idempotency_cache[idempotency_key] = (time.time(), outbound_msg.id)

        # 8. Broadcast Realtime WebSocket Event
        await ws_manager.broadcast({
            "event": "outbound_message_sent",
            "message_id": outbound_msg.id,
            "wa_message_id": outbound_msg.wa_message_id,
            "conversation_id": conv.id,
            "lead_id": lead.id,
            "lead_name": lead.name,
            "recipient_phone": e164_phone,
            "direction": "OUTBOUND",
            "message_type": "TEXT",
            "body": rendered_body,
            "status": "SENT",
            "created_at": outbound_msg.created_at.isoformat() if outbound_msg.created_at else now_utc.isoformat(),
        })

        return outbound_msg
