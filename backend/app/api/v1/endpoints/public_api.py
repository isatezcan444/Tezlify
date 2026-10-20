import hashlib
import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.api.dependencies import require_api_key
from backend.app.core.auth import AuthUser
from backend.app.core.database import get_db
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.api_key import ApiKey
from backend.app.models.campaign_group import CampaignGroup, campaign_group_leads
from backend.app.models.lead import (
    ConfidenceLevel,
    EntityType,
    Lead,
    LeadStatus,
    VerificationStatus,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.schemas.public_lead import (
    PublicLeadIngestRequest,
    PublicLeadIngestResponse,
)
from backend.app.services.lead_ingest_service import LeadIngestService
from backend.app.services.phone_service import PhoneService
from backend.app.services.webhook_dispatcher import WebhookDispatcher
from backend.app.services.whatsapp_service import send_text_message

logger = logging.getLogger("tezlify.public_api")

router = APIRouter()


@router.post("/leads", response_model=PublicLeadIngestResponse, status_code=status.HTTP_201_CREATED)
async def ingest_lead_via_api(
    payload: PublicLeadIngestRequest,
    current_user: AuthUser = Depends(require_api_key),
    db: AsyncSession = Depends(get_db),
):
    """
    X-API-Key başlığı ile harici sistemlerden (CRM, form, web sitesi, n8n) doğrudan Lead kaydeder.
    Telefon numarasını E.164 uluslararası formatına normalize eder, WhatsApp uygunluğunu belirler.
    Opsiyonel olarak bir kampanya grubuna ekler ve ilk WhatsApp karşılama mesajını iletir.
    """
    return await _process_lead_ingest(
        db=db,
        user_id=current_user.id,
        payload=payload,
        source="PUBLIC_REST_API",
    )


@router.post("/inbound-webhook/{key_prefix}", response_model=PublicLeadIngestResponse, status_code=status.HTTP_201_CREATED)
async def generic_inbound_webhook(
    key_prefix: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Özel başlık (header) eklenemeyen form ve webhook araçları (Elementor, Typeform, Webflow, Zapier vb.)
    için URL ön ekli genel webhook uç noktası.
    URL'deki key_prefix ile eşleşen aktif API anahtarı kullanıcısına lead'i bağlar.
    """
    stmt = select(ApiKey).where(
        ApiKey.key_prefix == key_prefix.strip(),
        ApiKey.is_active == True,
    )
    res = await db.execute(stmt)
    api_key_row = res.scalar_one_or_none()

    if not api_key_row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Geçersiz veya devre dışı bırakılmış Webhook anahtarı",
        )

    # Gelen gövdeyi JSON veya Form verisi olarak parse et
    content_type = request.headers.get("content-type", "")
    raw_data: Dict[str, Any] = {}

    if "application/json" in content_type:
        try:
            raw_data = await request.json()
        except Exception:
            raw_data = {}
    elif "application/x-www-form-urlencoded" in content_type or "multipart/form-data" in content_type:
        form = await request.form()
        raw_data = dict(form)
    else:
        try:
            raw_data = await request.json()
        except Exception:
            raw_data = {}

    # Esnek alan çözümleme (farklı form alan adlarını eşleştir)
    name = (
        raw_data.get("name")
        or raw_data.get("full_name")
        or raw_data.get("isim")
        or raw_data.get("ad_soyad")
        or raw_data.get("company")
        or raw_data.get("isletme_adi")
        or "Web Form Müşteri Adayı"
    )
    phone = (
        raw_data.get("phone")
        or raw_data.get("telefon")
        or raw_data.get("tel")
        or raw_data.get("gsm")
        or raw_data.get("mobile")
    )
    email = raw_data.get("email") or raw_data.get("eposta") or raw_data.get("mail")
    city = raw_data.get("city") or raw_data.get("sehir") or raw_data.get("il")
    district = raw_data.get("district") or raw_data.get("ilce")
    category = raw_data.get("category") or raw_data.get("sektor") or raw_data.get("hizmet")
    notes = raw_data.get("notes") or raw_data.get("message") or raw_data.get("mesaj") or raw_data.get("aciklama")
    website = raw_data.get("website") or raw_data.get("site") or raw_data.get("url")

    payload = PublicLeadIngestRequest(
        name=str(name).strip(),
        phone=str(phone).strip() if phone else None,
        email=str(email).strip() if email else None,
        city=str(city).strip() if city else None,
        district=str(district).strip() if district else None,
        category=str(category).strip() if category else None,
        notes=str(notes).strip() if notes else None,
        website=str(website).strip() if website else None,
        custom_fields=raw_data,
    )

    api_key_row.last_used_at = utc_now_naive()
    await db.commit()

    return await _process_lead_ingest(
        db=db,
        user_id=str(api_key_row.user_id),
        payload=payload,
        source="INBOUND_WEBHOOK",
    )


async def _process_lead_ingest(
    db: AsyncSession,
    user_id: str,
    payload: PublicLeadIngestRequest,
    source: str,
) -> PublicLeadIngestResponse:
    # 1. Telefon normalizasyonu ve WhatsApp uygunluğu
    phone_e164 = None
    is_mobile = False
    is_wa_eligible = False

    if payload.phone:
        norm_result = PhoneService.normalize_to_e164(payload.phone)
        if norm_result and norm_result.get("is_valid"):
            phone_e164 = norm_result.get("e164")
            is_mobile = norm_result.get("is_mobile", False)
            is_wa_eligible = norm_result.get("is_whatsapp_eligible", False)
        else:
            phone_e164 = payload.phone.strip()

    # Deterministic place_id
    raw_hash_seed = f"{payload.name}_{phone_e164 or payload.email or ''}_{user_id}"
    place_id = hashlib.sha256(raw_hash_seed.encode("utf-8")).hexdigest()[:16]

    existing_lead = None
    if phone_e164:
        stmt = select(Lead).where(Lead.phone_e164 == phone_e164)
        res = await db.execute(stmt)
        existing_lead = res.scalars().first()

    if existing_lead:
        lead = existing_lead
        lead.name = payload.name
        if payload.city:
            lead.city = payload.city
        if payload.district:
            lead.district = payload.district
        if payload.category:
            lead.category = payload.category
            lead.canonical_category = payload.category
        if payload.website:
            lead.website = payload.website
        if payload.address:
            lead.address = payload.address
        custom_data = dict(lead.custom_data or {})
        if payload.email:
            custom_data["email"] = payload.email
        if payload.notes:
            custom_data["notes"] = payload.notes
        if payload.custom_fields:
            existing_custom = custom_data.get("custom_fields") or {}
            existing_custom.update(payload.custom_fields)
            custom_data["custom_fields"] = existing_custom
        lead.custom_data = custom_data
        lead.updated_at = utc_now_naive()
    else:
        lead = Lead(
            user_id=user_id,
            name=payload.name,
            phone=payload.phone,
            phone_e164=phone_e164,
            is_mobile=is_mobile,
            is_whatsapp_eligible=is_wa_eligible,
            city=payload.city,
            district=payload.district,
            address=payload.address,
            website=payload.website,
            category=payload.category,
            canonical_category=payload.category,
            source=source,
            status=LeadStatus.NEW,
            place_id=place_id,
            custom_data={
                "email": payload.email,
                "notes": payload.notes,
                "custom_fields": payload.custom_fields or {},
            },
            created_at=utc_now_naive(),
            updated_at=utc_now_naive(),
        )
        db.add(lead)
    await db.commit()
    await db.refresh(lead)

    # 2. Opsiyonel kampanya grubuna ekle
    added_group_id = None
    if payload.group_id:
        group_stmt = select(CampaignGroup).where(
            CampaignGroup.id == payload.group_id,
            CampaignGroup.user_id == user_id,
        )
        group_res = await db.execute(group_stmt)
        group = group_res.scalar_one_or_none()
        if group:
            try:
                await db.execute(
                    insert(campaign_group_leads).values(
                        campaign_group_id=group.id,
                        lead_id=lead.id,
                    )
                )
                await db.commit()
                added_group_id = group.id
            except Exception as grp_err:
                logger.debug("[PUBLIC_API] Gruba ekleme atlandi (olasi tekrar): %s", grp_err)

    # 3. Opsiyonel WhatsApp karşılama mesajı gönder
    welcome_sent = False
    if payload.send_whatsapp_welcome and is_wa_eligible and phone_e164:
        welcome_text = payload.welcome_message or f"Merhaba {lead.name}, talebiniz başarıyla alındı. En kısa sürede sizinle iletişime geçeceğiz."
        try:
            sess_stmt = select(WhatsAppSession).where(
                WhatsAppSession.user_id == user_id,
                WhatsAppSession.status == SessionStatus.CONNECTED,
            ).order_by(WhatsAppSession.id.desc()).limit(1)
            sess_res = await db.execute(sess_stmt)
            active_sess = sess_res.scalar_one_or_none()

            if active_sess:
                from backend.app.models.conversation import Conversation
                from backend.app.models.contact import Contact
                # Sohbet kaydını bul veya oluştur
                clean_phone = phone_e164.replace("+", "").strip()
                conv_stmt = select(Conversation).where(
                    Conversation.user_id == user_id,
                    Conversation.session_id == active_sess.id,
                    Conversation.lead_id == lead.id,
                )
                conv_res = await db.execute(conv_stmt)
                conv = conv_res.scalar_one_or_none()
                if not conv:
                    conv = Conversation(
                        user_id=user_id,
                        session_id=active_sess.id,
                        lead_id=lead.id,
                        channel="WHATSAPP",
                        created_at=utc_now_naive(),
                        updated_at=utc_now_naive(),
                    )
                    db.add(conv)
                    await db.commit()
                    await db.refresh(conv)

                await send_text_message(
                    db=db,
                    user_id=user_id,
                    conversation_id=conv.id,
                    body=welcome_text,
                )
                welcome_sent = True
        except Exception as wa_err:
            logger.warning("[PUBLIC_API] Otomatik WhatsApp karsilama gonderilemedi: %s", wa_err)

    # 4. Webhook olayını asenkron fırlat
    WebhookDispatcher.emit(
        user_id=user_id,
        event_type="lead.created",
        data={
            "lead_id": lead.id,
            "name": lead.name,
            "phone_e164": lead.phone_e164,
            "is_whatsapp_eligible": lead.is_whatsapp_eligible,
            "city": lead.city,
            "district": lead.district,
            "category": lead.category,
            "email": payload.email,
            "source": source,
            "created_at": lead.created_at.isoformat(),
        },
    )

    logger.info("[PUBLIC_API] Lead #%s ('%s') ingested successfully for user %s", lead.id, lead.name, user_id)

    return PublicLeadIngestResponse(
        success=True,
        lead_id=lead.id,
        name=lead.name,
        phone_e164=lead.phone_e164,
        is_whatsapp_eligible=is_wa_eligible,
        added_to_group_id=added_group_id,
        whatsapp_welcome_sent=welcome_sent,
        message="Müşteri adayı başarıyla içeri aktarıldı",
    )
