"""
Smart Outreach, Category Confirmation, and Lead Matching Endpoints.
"""
import os
import asyncio
import logging
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.core.database import get_db, AsyncSessionLocal
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.models.lead import Lead
from backend.app.models.blacklist import ScraperJob, ScraperJobStatus
from backend.app.schemas.smart_outreach import (
    CategoryRecommendationRequest,
    CategoryRecommendationResponse,
    TargetedDiscoveryRequest,
    MatchLeadsRequest,
    MatchLeadsResponse,
    MessageRecommendationRequest,
    MessageRecommendationResponse
)
from backend.app.services.category_recommendation_service import CategoryRecommendationService
from backend.app.services.smart_matching_service import SmartMatchingService
from backend.app.services.message_strategy_service import MessageStrategyService
from backend.app.api.v1.endpoints.scraper import run_scraper_task, active_tasks

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/recommend-categories", response_model=CategoryRecommendationResponse)
async def recommend_categories(
    request: CategoryRecommendationRequest,
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Analyzes user offer and returns ranked candidate target categories with rationales.
    """
    try:
        return CategoryRecommendationService.recommend_categories(request)
    except Exception as e:
        logger.error(f"[SMART_OUTREACH] recommend_categories failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Kategori önerileri üretilirken hata oluştu.")


@router.post("/match-leads", response_model=MatchLeadsResponse)
async def match_leads(
    request: MatchLeadsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Scores and ranks leads against user offer and goal, returning explainable fit assessments.
    """
    try:
        matched_leads = await SmartMatchingService.match_and_rank_leads(
            db=db,
            offer_title=request.offer_title,
            offer_description=request.offer_description,
            business_goal=request.business_goal,
            approved_target_categories=request.approved_target_categories,
            lead_ids=request.lead_ids,
            city=request.city,
            category_filter=request.category_filter,
            min_fit_score=request.min_fit_score,
            user_id=current_user.id,
        )

        high_count = sum(1 for l in matched_leads if l.fit_assessment.fit_score >= 75)
        medium_count = sum(1 for l in matched_leads if 50 <= l.fit_assessment.fit_score < 75)
        low_count = sum(1 for l in matched_leads if l.fit_assessment.fit_score < 50)

        return MatchLeadsResponse(
            total_evaluated=len(matched_leads),
            high_fit_count=high_count,
            medium_fit_count=medium_count,
            low_fit_count=low_count,
            leads=matched_leads
        )
    except Exception as e:
        logger.error(f"[SMART_OUTREACH] match_leads failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Müşteri eşleştirmesi yapılırken hata oluştu.")


@router.post("/recommend-message", response_model=MessageRecommendationResponse)
async def recommend_message(
    request: MessageRecommendationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Produces category-aware personalized outreach message draft for a specific lead.
    """
    stmt = select(Lead).where(
        Lead.id == request.lead_id,
        get_user_filter(Lead.user_id, current_user.id),
    )
    res = await db.execute(stmt)
    lead = res.scalar_one_or_none()
    if not lead:
        raise HTTPException(status_code=404, detail="Müşteri adayı bulunamadı.")

    target_category = request.target_category or lead.category or "Genel"
    return MessageStrategyService.generate_recommendation(
        lead_id=lead.id,
        lead_name=lead.name,
        target_category=target_category,
        offer_title=request.offer_title,
        offer_description=request.offer_description,
        business_goal=request.business_goal
    )


@router.post("/start-targeted-discovery")
async def start_targeted_discovery(
    request: TargetedDiscoveryRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Launches targeted discovery exclusively for user-approved target categories and custom categories.
    """
    if not request.approved_target_categories and not request.user_added_categories:
        raise HTTPException(status_code=400, detail="En az bir onaylanmış hedef kategori gereklidir.")

    all_target_terms = list(dict.fromkeys(request.approved_target_categories + request.user_added_categories))
    job_ids = []

    for cat_term in all_target_terms:
        # Create ScraperJob entry
        location_display = f"{request.city} {', '.join(request.districts)}" if request.districts else request.city
        job = ScraperJob(
            keyword=cat_term,
            location=location_display,
            city=request.city,
            districts_json=request.districts or [],
            status=ScraperJobStatus.PENDING,
            total_found=0,
            total_valid_phones=0,
            total_new_leads=0,
            user_id=current_user.id,
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)

        job_ids.append(job.id)
        # Tracked asyncio task (not a fire-and-forget BackgroundTask) so the
        # job honors the scraper semaphore inside run_scraper_task AND stays
        # cancellable via POST /scraper/cancel/{job_id} like all other jobs.
        # run_scraper_task removes itself from active_tasks when done.
        task = asyncio.create_task(
            run_scraper_task(
                job_id=job.id,
                keyword=cat_term,
                city=request.city,
                districts=request.districts,
                max_results=request.max_results_per_category,
            )
        )
        active_tasks[job.id] = task

    return {
        "status": "started",
        "approved_categories_count": len(all_target_terms),
        "job_ids": job_ids,
        "message": f"{len(all_target_terms)} onaylı hedef kategori için hedefli arama başlatıldı."
    }
