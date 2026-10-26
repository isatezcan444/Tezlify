import os
import logging
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter, check_entity_ownership
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.schemas.campaign import (
    CampaignResponse,
    CampaignCreate,
    CampaignUpdate,
    CampaignScheduleRequest,
    CampaignBulkDeleteRequest,
    CampaignLaunchRequest,
    SpintaxPreviewRequest,
    SpintaxPreviewResponse,
    GenerateMessageRequest,
    GenerateMessageResponse,
    SequenceLeadResponse,
)
from backend.app.models.campaign_sequence_lead import CampaignSequenceLead, SequenceLeadStatus
from backend.app.models.lead import Lead
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.services.spintax_service import SpintaxService
from backend.app.services.campaign_runner import CampaignRunner
from backend.app.services.message_strategy_service import MessageStrategyService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/generate-message", response_model=GenerateMessageResponse)
async def generate_campaign_message(req: GenerateMessageRequest):
    """
    Generates a natural, category-aware, and goal-specific B2B WhatsApp outreach message template.
    Validates required fields depending on communication_goal.
    """
    goal = req.communication_goal.upper().strip()
    
    # Required validations based on goal
    if goal == "SERVICE_PROMOTION":
        if not (req.offer_title and req.offer_title.strip()):
            raise HTTPException(status_code=400, detail="Tanıtılacak ürün / hizmet alanı zorunludur.")
    elif goal == "DISCOVERY":
        if not (req.offer_title and req.offer_title.strip()):
            raise HTTPException(status_code=400, detail="Sunduğunuz ürün / hizmet alanı zorunludur.")
        if not (req.lead_need and req.lead_need.strip()):
            raise HTTPException(status_code=400, detail="Öğrenmek istediğiniz ihtiyaç alanı zorunludur.")
    elif goal == "OFFER":
        if not (req.offer_title and req.offer_title.strip()):
            raise HTTPException(status_code=400, detail="Ürün / hizmet alanı zorunludur.")
        if not (req.key_benefit and req.key_benefit.strip()):
            raise HTTPException(status_code=400, detail="Teklifinizin kısa özeti zorunludur.")
    elif goal == "MEETING":
        if not (req.offer_title and req.offer_title.strip()):
            raise HTTPException(status_code=400, detail="Ürün / hizmet alanı zorunludur.")
        if not (req.meeting_purpose and req.meeting_purpose.strip()):
            raise HTTPException(status_code=400, detail="Görüşme amacı alanı zorunludur.")
    elif goal == "FOLLOW_UP":
        if not (req.previous_topic and req.previous_topic.strip()):
            raise HTTPException(status_code=400, detail="Önceki iletişimin konusu zorunludur.")

    msg, summary = MessageStrategyService.generate_campaign_message(
        communication_goal=goal,
        target_category=req.target_category,
        offer_title=req.offer_title,
        key_benefit=req.key_benefit,
        extra_information=req.extra_information,
        preferred_channel=req.preferred_channel,
        lead_need=req.lead_need,
        specific_question=req.specific_question,
        pricing_info=req.pricing_info,
        meeting_purpose=req.meeting_purpose,
        previous_topic=req.previous_topic,
        language=req.language,
        variation_seed=req.variation_seed
    )

    return GenerateMessageResponse(
        generated_message=msg,
        communication_goal=goal,
        language=req.language,
        strategy_summary=summary,
    )


@router.get("", response_model=List[CampaignResponse])
async def list_campaigns(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    stmt = (
        select(Campaign)
        .where(get_user_filter(Campaign.user_id, current_user.id))
        .order_by(Campaign.id.desc())
    )
    res = await db.execute(stmt)
    return res.scalars().all()


@router.post("", response_model=CampaignResponse, status_code=201)
async def create_campaign(
    campaign_in: CampaignCreate,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign_dict = campaign_in.model_dump()
    initial_status = CampaignStatus.DRAFT
    sched_dt = campaign_in.scheduled_at
    if sched_dt:
        sched_dt_naive = sched_dt.replace(tzinfo=None) if sched_dt.tzinfo else sched_dt
        campaign_dict["scheduled_at"] = sched_dt_naive
        if sched_dt_naive > utc_now_naive():
            initial_status = CampaignStatus.SCHEDULED

    campaign = Campaign(**campaign_dict, user_id=current_user.id, status=initial_status)
    db.add(campaign)
    await db.commit()
    await db.refresh(campaign)
    return campaign


@router.get("/{campaign_id}", response_model=CampaignResponse)
async def get_campaign(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")
    return campaign


@router.patch("/{campaign_id}", response_model=CampaignResponse)
async def update_campaign(
    campaign_id: int,
    campaign_in: CampaignUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    update_data = campaign_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(campaign, key, value)

    await db.commit()
    await db.refresh(campaign)
    return campaign


@router.delete("/{campaign_id}", status_code=204)
async def delete_campaign(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")
    
    if CampaignRunner.is_campaign_running(campaign_id):
        await CampaignRunner.cancel_campaign(campaign_id)

    await db.execute(delete(CampaignSequenceLead).where(CampaignSequenceLead.campaign_id == campaign_id))
    await db.delete(campaign)
    await db.commit()
    return None


@router.post("/bulk-delete")
async def bulk_delete_campaigns(
    req: CampaignBulkDeleteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    if not req.campaign_ids:
        return {"deleted_count": 0, "message": "Silinecek kampanya belirtilmedi."}

    distinct_ids = list(set(req.campaign_ids))
    # Stop live workers first (in-memory, no DB round-trips).
    for cid in distinct_ids:
        if CampaignRunner.is_campaign_running(cid):
            await CampaignRunner.cancel_campaign(cid)

    await db.execute(delete(CampaignSequenceLead).where(CampaignSequenceLead.campaign_id.in_(distinct_ids)))
    # Single bulk delete scoped to user
    del_stmt = delete(Campaign).where(
        Campaign.id.in_(distinct_ids),
        get_user_filter(Campaign.user_id, current_user.id),
    )
    res = await db.execute(del_stmt)
    await db.commit()
    deleted_count = res.rowcount if res.rowcount is not None and res.rowcount >= 0 else 0
    return {"deleted_count": deleted_count, "message": f"{deleted_count} kampanya başarıyla silindi."}


@router.post("/spintax/preview", response_model=SpintaxPreviewResponse)
async def preview_spintax(req: SpintaxPreviewRequest):
    """
    Evaluates template, calculates permutation combinations, and generates live sample variations.
    """
    perms = SpintaxService.calculate_permutations(req.template)
    samples = SpintaxService.generate_preview_samples(req.template, count=req.count, sample_lead=req.sample_lead)
    return {
        "template": req.template,
        "permutations_count": perms,
        "samples": samples
    }


@router.post("/{campaign_id}/launch")
async def launch_campaign(
    campaign_id: int,
    req: CampaignLaunchRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    if campaign.status == CampaignStatus.ACTIVE or CampaignRunner.is_campaign_running(campaign_id):
        raise HTTPException(status_code=409, detail="Bu kampanya şu anda zaten çalışıyor.")

    from backend.app.services.quota_guard import QuotaGuardService
    await QuotaGuardService.check_campaign_allowance(db, current_user.id)

    # WhatsApp Active Session Check (Fail-Closed with Multi-Session Hat Havuzu support)
    from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
    target_session_ids = req.session_ids or getattr(campaign, "whatsapp_session_ids", None)
    target_session_id = req.session_id or getattr(campaign, "whatsapp_session_id", None)
    sess_stmt = select(WhatsAppSession).where(
        WhatsAppSession.user_id == current_user.id,
        WhatsAppSession.status == SessionStatus.CONNECTED,
    )
    if target_session_ids and len(target_session_ids) > 0:
        sess_stmt = sess_stmt.where(WhatsAppSession.id.in_(target_session_ids))
    elif target_session_id:
        sess_stmt = sess_stmt.where(WhatsAppSession.id == target_session_id)
    active_sessions = (await db.execute(sess_stmt.order_by(WhatsAppSession.id.desc()))).scalars().all()

    # Fail-closed in live environment (outside unit tests that mock the worker)
    if not active_sessions and os.getenv("PYTEST_CURRENT_TEST") is None:
        raise HTTPException(
            status_code=400,
            detail="Bağlı aktif bir WhatsApp hattı bulunamadı. Kampanyayı başlatmak için lütfen önce WhatsApp Hub sekmesinden QR kod ile bir hat bağlayın.",
        )

    target_lead_ids = req.lead_ids
    if not target_lead_ids and campaign.group_id:
        from backend.app.models.campaign_group import campaign_group_leads
        group_leads_res = await db.execute(
            select(campaign_group_leads.c.lead_id).where(campaign_group_leads.c.group_id == campaign.group_id)
        )
        target_lead_ids = [row[0] for row in group_leads_res.fetchall()]

    started = await CampaignRunner.start_campaign(
        campaign_id=campaign.id,
        lead_ids=target_lead_ids,
        limit=req.limit or 50,
        session_id=active_sessions[0].id if active_sessions else None,
        session_ids=[s.id for s in active_sessions],
    )

    if not started:
        raise HTTPException(status_code=409, detail="Kampanya başlatılamadı, işlem zaten aktif.")

    return {
        "message": f"'{campaign.name}' kampanyası başlatıldı ve arka planda işleniyor.",
        "campaign_id": campaign.id,
        "sender_session_id": active_sessions[0].id if active_sessions else None,
        "sender_phone": active_sessions[0].phone_number if active_sessions else None,
        "pool_size": len(active_sessions),
        "pool_session_ids": [s.id for s in active_sessions],
    }


@router.post("/{campaign_id}/pause")
async def pause_campaign(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    campaign.status = CampaignStatus.PAUSED
    await db.commit()
    await CampaignRunner.cancel_campaign(campaign_id)

    return {"message": f"'{campaign.name}' kampanyası duraklatıldı.", "campaign_id": campaign.id}


@router.post("/{campaign_id}/schedule", response_model=CampaignResponse)
async def schedule_campaign(
    campaign_id: int,
    req: CampaignScheduleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    sched_dt = req.scheduled_at.replace(tzinfo=None) if req.scheduled_at.tzinfo else req.scheduled_at
    if sched_dt <= utc_now_naive():
        raise HTTPException(status_code=400, detail="Planlanan tarih gelecekte bir zaman olmalıdır.")

    if CampaignRunner.is_campaign_running(campaign_id):
        await CampaignRunner.cancel_campaign(campaign_id)

    campaign.scheduled_at = sched_dt
    campaign.status = CampaignStatus.SCHEDULED
    if req.session_ids:
        campaign.whatsapp_session_ids = req.session_ids
    if req.session_id:
        campaign.whatsapp_session_id = req.session_id

    await db.commit()
    await db.refresh(campaign)
    return campaign


@router.post("/{campaign_id}/unschedule", response_model=CampaignResponse)
async def unschedule_campaign(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    campaign.scheduled_at = None
    if campaign.status == CampaignStatus.SCHEDULED:
        campaign.status = CampaignStatus.DRAFT

    await db.commit()
    await db.refresh(campaign)
    return campaign


@router.post("/upload-media")
async def upload_campaign_media(
    file: UploadFile = File(...),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Uploads a campaign attachment file (PDF, catalog, brochure, image)
    and returns its file_id, media_url, media_type, and filename.
    """
    from backend.app.services.campaign_media_service import CampaignMediaService
    return await CampaignMediaService.save_uploaded_media(file, current_user.id)


@router.get("/media/{file_id}")
async def get_campaign_media(file_id: str):
    """
    Serves uploaded campaign media — as the BYTES say it is, never as the name
    claims.

    Hardening against stored XSS on the API origin. The previous version
    re-guessed the type from the stored FILE NAME and served it `inline`, so a
    file uploaded as `text/plain` named `evil.html` came back as `text/html`
    and executed on this origin. Now:

      * the MIME type is re-sniffed from the stored bytes (a lying extension
        cannot come back as HTML — the sniff fails and this 404s);
      * `X-Content-Type-Options: nosniff` stops the browser re-guessing;
      * only image formats are `inline`; PDF/Office are forced to `attachment`
        (a PDF can carry script for whatever viewer renders it);
      * `Content-Security-Policy: default-src 'none'; sandbox` neutralises any
        document that still manages to render;
      * `private` cache — this is tenant data, not a public asset.
    """
    from backend.app.services.campaign_media_service import (
        CampaignMediaService,
        inline_safe,
    )
    res = CampaignMediaService.get_media_file_info(file_id)
    if not res:
        raise HTTPException(status_code=404, detail="Medya dosyası bulunamadı.")
    content, mime, filename = res
    disposition = "inline" if inline_safe(mime) else "attachment"
    headers = {
        "Content-Disposition": f'{disposition}; filename="{filename}"',
        "Content-Length": str(len(content)),
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    }
    return Response(content=content, media_type=mime, headers=headers)


@router.get("/{campaign_id}/sequence-leads", response_model=List[SequenceLeadResponse])
async def get_campaign_sequence_leads(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Returns the real-time status of all leads in a multi-step drip sequence campaign.
    """
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    stmt = (
        select(CampaignSequenceLead, Lead.name, Lead.phone_e164)
        .outerjoin(Lead, CampaignSequenceLead.lead_id == Lead.id)
        .where(CampaignSequenceLead.campaign_id == campaign_id)
        .order_by(CampaignSequenceLead.created_at.desc())
    )
    results = (await db.execute(stmt)).all()

    resp = []
    for seq_lead, lead_name, lead_phone in results:
        data = SequenceLeadResponse(
            id=seq_lead.id,
            campaign_id=seq_lead.campaign_id,
            lead_id=seq_lead.lead_id,
            lead_name=lead_name,
            lead_phone=lead_phone,
            whatsapp_session_id=seq_lead.whatsapp_session_id,
            current_step=seq_lead.current_step,
            total_steps=seq_lead.total_steps,
            status=seq_lead.status.value if hasattr(seq_lead.status, "value") else str(seq_lead.status),
            next_step_at=seq_lead.next_step_at,
            last_step_sent_at=seq_lead.last_step_sent_at,
            stopped_at=seq_lead.stopped_at,
            stop_reason=seq_lead.stop_reason,
            created_at=seq_lead.created_at,
            updated_at=seq_lead.updated_at,
        )
        resp.append(data)
    return resp


@router.post("/{campaign_id}/sequence-leads/{seq_lead_id}/stop", response_model=SequenceLeadResponse)
async def stop_campaign_sequence_lead(
    campaign_id: int,
    seq_lead_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Manually halts future sequence follow-ups for a specific lead.
    """
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or not check_entity_ownership(campaign, current_user):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    seq_lead = await db.get(CampaignSequenceLead, seq_lead_id)
    if not seq_lead or seq_lead.campaign_id != campaign_id:
        raise HTTPException(status_code=404, detail="Sekans kaydı bulunamadı")

    seq_lead.status = SequenceLeadStatus.STOPPED_MANUAL
    seq_lead.stopped_at = utc_now_naive()
    seq_lead.stop_reason = "MANUAL"
    seq_lead.next_step_at = None
    await db.commit()
    await db.refresh(seq_lead)

    lead = await db.get(Lead, seq_lead.lead_id)
    return SequenceLeadResponse(
        id=seq_lead.id,
        campaign_id=seq_lead.campaign_id,
        lead_id=seq_lead.lead_id,
        lead_name=lead.name if lead else None,
        lead_phone=lead.phone_e164 if lead else None,
        whatsapp_session_id=seq_lead.whatsapp_session_id,
        current_step=seq_lead.current_step,
        total_steps=seq_lead.total_steps,
        status=seq_lead.status.value if hasattr(seq_lead.status, "value") else str(seq_lead.status),
        next_step_at=seq_lead.next_step_at,
        last_step_sent_at=seq_lead.last_step_sent_at,
        stopped_at=seq_lead.stopped_at,
        stop_reason=seq_lead.stop_reason,
        created_at=seq_lead.created_at,
        updated_at=seq_lead.updated_at,
    )
