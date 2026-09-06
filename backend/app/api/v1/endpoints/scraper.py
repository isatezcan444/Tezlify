import asyncio
import logging
import time
from datetime import datetime
from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.core.database import get_db, AsyncSessionLocal
from backend.app.core.config import settings
from backend.app.core.auth import AuthUser, get_current_user, verify_lead_quota
from backend.app.models.profile import Profile
from backend.app.models.blacklist import ScraperJob, ScraperJobStatus
from backend.app.models.lead import Lead
from backend.app.schemas.scraper import ScraperRunRequest, ScraperSaveRequest, ScraperSaveResponse, ScraperJobResponse
from backend.app.scrapers.google_maps_scraper import GoogleMapsScraper
from backend.app.services.lead_ingest_service import LeadIngestService
from backend.app.api.v1.websocket import ws_manager
from backend.app.data.turkey_locations import get_districts_for_city, get_supported_cities
from sqlalchemy import or_

logger = logging.getLogger(__name__)

router = APIRouter()

active_tasks: dict[int, asyncio.Task] = {}
scraper_semaphore = asyncio.Semaphore(settings.SCRAPER_MAX_CONCURRENT_TASKS)


async def run_scraper_task(
    job_id: int,
    keyword: str,
    city: str,
    districts: List[str],
    max_results: int,
):
    """Background execution of scraper with structured location snapshot and WebSocket dispatch."""
    start_time = time.time()
    scraper = GoogleMapsScraper()

    logger.info(
        f"[SEARCH_JOB] job_id={job_id} keyword={keyword!r} "
        f"city={city!r} districts={districts!r} max_results={max_results}"
    )

    async with AsyncSessionLocal() as db:
        job = await db.get(ScraperJob, job_id)
        if not job:
            logger.error(f"[SEARCH_JOB] job_id={job_id} NOT FOUND in database")
            return

        job.status = ScraperJobStatus.RUNNING
        job.started_at = datetime.utcnow()
        await db.commit()

        await ws_manager.broadcast({
            "event": "scraper_started",
            "job_id": job_id,
            "keyword": keyword,
            "city": city,
            "districts": districts,
        })

        latest_metrics = {}

        async def on_progress(event_data: dict):
            nonlocal latest_metrics
            if event_data.get("type") == "completed" and "metrics" in event_data:
                latest_metrics = event_data["metrics"]
            await ws_manager.broadcast({
                "event": "scraper_progress",
                "job_id": job_id,
                "data": event_data
            })

        try:
            async with scraper_semaphore:
                raw_leads = await scraper.scrape(
                    keyword=keyword,
                    city=city,
                    districts=districts,
                    max_results=max_results,
                    progress_callback=on_progress,
                )

            # Discovery-only: nothing is written to CRM here. The user reviews
            # the live results and explicitly saves a selection (or all) via
            # POST /scraper/jobs/{job_id}/save. Persisted counts stay zero
            # until that happens.
            job.status = ScraperJobStatus.COMPLETED
            job.total_found = len(raw_leads)
            job.total_valid_phones = sum(1 for r in raw_leads if r.get("phone_e164"))
            job.total_new_leads = 0
            job.completed_at = datetime.utcnow()
            job.duration_seconds = int(time.time() - start_time)

            await db.commit()

            await ws_manager.broadcast({
                "event": "scraper_completed",
                "job_id": job_id,
                "total_found": len(raw_leads),
                "total_new_leads": 0,
                "leads": raw_leads,
                "metrics": latest_metrics
            })

            logger.info(
                f"[SEARCH_JOB_DONE] job_id={job_id} in {job.duration_seconds}s "
                f"discovered={len(raw_leads)} (awaiting explicit user save)"
            )

        except asyncio.CancelledError:
            logger.warning(f"[SEARCH_JOB_CANCELLED] job_id={job_id}")
            job.status = ScraperJobStatus.CANCELLED
            job.completed_at = datetime.utcnow()
            job.duration_seconds = int(time.time() - start_time)
            await db.commit()
            await ws_manager.broadcast({
                "event": "scraper_cancelled",
                "job_id": job_id,
            })
            raise
        except Exception as e:
            logger.exception(f"[SEARCH_JOB_ERROR] job_id={job_id}: {e}")
            try:
                await db.rollback()
                job = await db.get(ScraperJob, job_id)
                if job:
                    job.status = ScraperJobStatus.FAILED
                    job.error_message = str(e)[:500]
                    job.completed_at = datetime.utcnow()
                    job.duration_seconds = int(time.time() - start_time)
                    await db.commit()
            except Exception as rollback_err:
                logger.error(f"[SEARCH_JOB_ERROR] Failed to record failure in DB: {rollback_err}")
            await ws_manager.broadcast({
                "event": "scraper_failed",
                "job_id": job_id,
                "error": str(e)
            })
        finally:
            active_tasks.pop(job_id, None)


@router.post("/run", response_model=ScraperJobResponse)
@router.post("/start", response_model=ScraperJobResponse)
async def start_scraper(
    req: ScraperRunRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    # Enforce SaaS Lead Search Quota
    verify_lead_quota(current_user, requested_count=1)

    keyword = req.keyword.strip()
    city = req.city.strip()
    districts = req.districts or []

    if not keyword or not city:
        raise HTTPException(status_code=400, detail="Anahtar kelime ve şehir belirtilmelidir.")

    if not districts:
        districts = get_districts_for_city(city)
        if not districts:
            # FAIL CLOSED: fabricating a pseudo-district would corrupt the search query.
            supported = ", ".join(get_supported_cities())
            raise HTTPException(
                status_code=400,
                detail=f"'{city}' için ilçe kaydı bulunamadı. Desteklenen şehirler: {supported}"
            )

    location_display = f"{city} {', '.join(districts)}" if districts else city

    job = ScraperJob(
        keyword=keyword,
        location=location_display,
        city=city,
        districts_json=districts,
        source=req.source or "GOOGLE_MAPS",
        status=ScraperJobStatus.PENDING,
        total_found=0,
        total_valid_phones=0,
        total_new_leads=0,
        created_at=datetime.utcnow(),
        user_id=current_user.id,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    # max_results passes through verbatim: 0 means UNLIMITED (schema-validated ≥ 0).
    task = asyncio.create_task(
        run_scraper_task(
            job_id=job.id,
            keyword=keyword,
            city=city,
            districts=districts,
            max_results=req.max_results,
        )
    )
    active_tasks[job.id] = task

    return job


def lead_to_dict(l: Lead) -> Dict[str, Any]:
    """Serializes a persisted Lead for discovery/save responses (always carries id)."""
    return {
        "id": l.id,
        "name": l.name,
        "category": l.category,
        "entity_type": l.entity_type,
        "phone": l.phone,
        "phone_e164": l.phone_e164,
        "is_mobile": l.is_mobile,
        "is_whatsapp_eligible": l.is_whatsapp_eligible,
        "address": l.address,
        "city": l.city,
        "district": l.district,
        "latitude": l.latitude,
        "longitude": l.longitude,
        "website": l.website,
        "rating": l.rating,
        "reviews_count": l.reviews_count,
        "is_verified": l.is_verified,
        "place_id": l.place_id,
        "maps_url": (l.custom_data or {}).get("maps_url"),
        "status": l.status.value if hasattr(l.status, 'value') else str(l.status),
        "created_at": str(l.created_at)
    }


@router.post("/jobs/{job_id}/save", response_model=ScraperSaveResponse)
async def save_scraper_leads(
    job_id: int,
    req: ScraperSaveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Persists a user-reviewed selection of discovery results to CRM.

    Discovery itself is side-effect free; this is the only path that creates
    Lead rows from a scrape job. Re-saving is idempotent (matches merge).
    """
    job = await db.get(ScraperJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Tarama işi bulunamadı")
    if job.status != ScraperJobStatus.COMPLETED:
        raise HTTPException(
            status_code=400,
            detail="Yalnızca tamamlanmış taramaların sonuçları kaydedilebilir."
        )

    # Verify quota for saving leads
    verify_lead_quota(current_user, requested_count=len(req.leads))

    all_leads, new_count, updated_count = await LeadIngestService.ingest_leads(
        db=db,
        raw_leads=req.leads,
        source="GOOGLE_MAPS",
        search_keyword=job.keyword,
        search_location=job.location,
        user_id=current_user.id,
    )

    job.total_new_leads = (job.total_new_leads or 0) + new_count

    # Update user monthly usage in Profile table
    profile = await db.get(Profile, current_user.id)
    if profile:
        profile.leads_used_this_month = (profile.leads_used_this_month or 0) + new_count

    await db.commit()

    logger.info(
        f"[SEARCH_JOB_SAVE] job_id={job_id} user_id={current_user.id} saved={len(all_leads)} "
        f"new={new_count} updated={updated_count}"
    )
    return ScraperSaveResponse(
        job_id=job_id,
        saved=[lead_to_dict(l) for l in all_leads],
        new_count=new_count,
        updated_count=updated_count,
    )


@router.get("/jobs", response_model=List[ScraperJobResponse])
async def list_scraper_jobs(
    limit: int = 20, 
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    stmt = (
        select(ScraperJob)
        .where(or_(ScraperJob.user_id == current_user.id, ScraperJob.user_id.is_(None)))
        .order_by(ScraperJob.id.desc())
        .limit(limit)
    )
    res = await db.execute(stmt)
    return res.scalars().all()


@router.get("/jobs/{job_id}", response_model=ScraperJobResponse)
@router.get("/status/{job_id}", response_model=ScraperJobResponse)
async def get_scraper_job(job_id: int, db: AsyncSession = Depends(get_db)):
    job = await db.get(ScraperJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Tarama işi bulunamadı")
    return job


@router.post("/cancel/{job_id}")
async def cancel_scraper_job(job_id: int, db: AsyncSession = Depends(get_db)):
    job = await db.get(ScraperJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Tarama işi bulunamadı")

    task = active_tasks.get(job_id)
    if task and not task.done():
        task.cancel()
        return {"message": "Tarama işi iptal edildi", "job_id": job_id}

    if job.status in [ScraperJobStatus.PENDING, ScraperJobStatus.RUNNING]:
        job.status = ScraperJobStatus.CANCELLED
        job.completed_at = datetime.utcnow()
        await db.commit()

    return {"message": "Tarama işi durduruldu", "job_id": job_id}
