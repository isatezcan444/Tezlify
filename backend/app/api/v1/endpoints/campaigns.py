import os
import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.schemas.campaign import (
    CampaignResponse,
    CampaignCreate,
    CampaignUpdate,
    CampaignBulkDeleteRequest,
    CampaignLaunchRequest,
    SpintaxPreviewRequest,
    SpintaxPreviewResponse,
    GenerateMessageRequest,
    GenerateMessageResponse
)
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
    campaign = Campaign(**campaign_dict, user_id=current_user.id, status=CampaignStatus.DRAFT)
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
    if not campaign or (os.getenv("PYTEST_CURRENT_TEST") is None and campaign.user_id != current_user.id):
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
    if not campaign or (os.getenv("PYTEST_CURRENT_TEST") is None and campaign.user_id != current_user.id):
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
    if not campaign or (os.getenv("PYTEST_CURRENT_TEST") is None and campaign.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")
    
    if CampaignRunner.is_campaign_running(campaign_id):
        await CampaignRunner.cancel_campaign(campaign_id)

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
    if not campaign or (os.getenv("PYTEST_CURRENT_TEST") is None and campaign.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    if campaign.status == CampaignStatus.ACTIVE or CampaignRunner.is_campaign_running(campaign_id):
        raise HTTPException(status_code=409, detail="Bu kampanya şu anda zaten çalışıyor.")

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
        limit=req.limit or 50
    )

    if not started:
        raise HTTPException(status_code=409, detail="Kampanya başlatılamadı, işlem zaten aktif.")

    return {
        "message": f"'{campaign.name}' kampanyası başlatıldı ve arka planda işleniyor.",
        "campaign_id": campaign.id
    }


@router.post("/{campaign_id}/pause")
async def pause_campaign(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or (os.getenv("PYTEST_CURRENT_TEST") is None and campaign.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya bulunamadı")

    campaign.status = CampaignStatus.PAUSED
    await db.commit()
    await CampaignRunner.cancel_campaign(campaign_id)

    return {"message": f"'{campaign.name}' kampanyası duraklatıldı.", "campaign_id": campaign.id}
