import asyncio
import logging
import time
from typing import List, Dict, Any, Optional

from backend.app.core.datetime_utils import utc_now_naive
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

import os
from backend.app.core.database import get_db, AsyncSessionLocal
from backend.app.core.config import settings
from backend.app.core.auth import AuthUser, get_current_user, verify_lead_quota, get_user_filter, check_entity_ownership
from backend.app.models.profile import Profile
from backend.app.models.blacklist import ScraperJob, ScraperJobStatus
from backend.app.models.lead import Lead
from backend.app.schemas.scraper import ScraperRunRequest, ScraperSaveRequest, ScraperSaveResponse, ScraperJobResponse
from backend.app.scrapers.google.google_maps_scraper import GoogleMapsScraper
from backend.app.services.lead_ingest_service import LeadIngestService
from backend.app.api.v1.websocket import ws_manager
from backend.app.data.turkey_locations import (
    get_districts_for_city,
    get_supported_cities,
    get_district_id,
    get_district_population,
)

logger = logging.getLogger(__name__)

router = APIRouter()

active_tasks: dict[int, asyncio.Task] = {}
scraper_semaphore = asyncio.Semaphore(settings.SCRAPER_MAX_CONCURRENT_TASKS)
_NEIGHBORHOOD_CACHE: Dict[str, List[str]] = {}


@router.get("/neighborhoods")
async def get_neighborhoods_for_district(
    city: str,
    district: str,
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Returns official 2025 neighborhoods for a given city and district (Faz 2).
    Uses in-memory cache and falls back to live Türkiye API or subdivision data.
    """
    clean_city = city.strip()
    clean_district = district.strip()
    cache_key = f"{clean_city}:{clean_district}".lower()
    if cache_key in _NEIGHBORHOOD_CACHE:
        return {
            "city": clean_city,
            "district": clean_district,
            "neighborhoods": _NEIGHBORHOOD_CACHE[cache_key]
        }

    district_id = get_district_id(clean_city, clean_district)
    neighborhood_names: List[str] = []

    if district_id:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=6.0) as client:
                res = await client.get(
                    f"https://api.turkiyeapi.dev/v2/neighborhoods?districtId={district_id}",
                    headers={"User-Agent": "Tezlify/1.0"}
                )
                if res.status_code == 200:
                    payload = res.json()
                    data = payload.get("data", [])
                    neighborhood_names = [item["name"] for item in data if "name" in item]
        except Exception as err:
            logger.warning(f"[NEIGHBORHOODS] Live fetch failed for {clean_city} > {clean_district}: {err}")

    # Fallback to local subdivisions if API returned empty
    if not neighborhood_names:
        from backend.app.data.turkey_subdivisions import get_subdivisions_for_district
        neighborhood_names = get_subdivisions_for_district(clean_city, clean_district)

    if neighborhood_names:
        _NEIGHBORHOOD_CACHE[cache_key] = neighborhood_names

    return {
        "city": clean_city,
        "district": clean_district,
        "neighborhoods": neighborhood_names
    }


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


async def run_scraper_task(
    job_id: int,
    keyword: str,
    city: str,
    districts: List[str],
    max_results: int,
    auto_save_to_crm: bool = False,
    neighborhoods: Optional[List[str]] = None,
    min_population: Optional[int] = None,
    radius_km: Optional[int] = None,
):
    """Background execution of scraper with structured location snapshot and WebSocket dispatch."""
    start_time = time.time()
    scraper = GoogleMapsScraper()

    logger.info(
        f"[SEARCH_JOB] job_id={job_id} keyword={keyword!r} "
        f"city={city!r} districts={districts!r} neighborhoods={neighborhoods!r} max_results={max_results}"
    )

    async with AsyncSessionLocal() as db:
        job = await db.get(ScraperJob, job_id)
        if not job:
            logger.error(f"[SEARCH_JOB] job_id={job_id} NOT FOUND in database")
            return

        # Faz 13 (tenant izolasyonu): sahibi cozulemeyen isin olaylari
        # yayinlanamaz (lead listesi PII tasir). Fail-visible: is FAILED'a
        # alinir — sessizce "calisiyor ama gorunmuyor" durumuna dusulmez.
        owner = str(job.user_id) if job.user_id else None
        if not owner:
            job.status = ScraperJobStatus.FAILED
            job.error_message = "Is sahibi (user_id) atanmamis; sonuclar hicbir tenant'a guvenle yazilamaz."
            job.completed_at = utc_now_naive()
            await db.commit()
            logger.error("[SEARCH_JOB] job_id=%s sahipsiz — FAILED olarak kapatildi.", job_id)
            return

        job.status = ScraperJobStatus.RUNNING
        job.started_at = utc_now_naive()
        await db.commit()

        await ws_manager.broadcast({
            "event": "scraper_started",
            "job_id": job_id,
            "user_id": owner,
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
                "user_id": owner,
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
                    neighborhoods=neighborhoods,
                    min_population=min_population,
                    radius_km=radius_km,
                )

            persisted_leads = []
            new_count = 0
            updated_count = 0

            if auto_save_to_crm and raw_leads:
                try:
                    persisted_leads, new_count, updated_count = await LeadIngestService.ingest_leads(
                        db=db,
                        raw_leads=raw_leads,
                        source="GOOGLE_MAPS",
                        search_keyword=keyword,
                        search_location=job.location,
                        user_id=job.user_id,
                    )
                    profile = await db.get(Profile, job.user_id)
                    if profile:
                        profile.leads_used_this_month = (profile.leads_used_this_month or 0) + new_count
                    logger.info(
                        f"[SEARCH_JOB_AUTO_INGEST] job_id={job_id} auto-ingested={len(persisted_leads)} "
                        f"new={new_count} updated={updated_count}"
                    )
                except Exception as ex:
                    logger.error(f"[SEARCH_JOB_AUTO_INGEST_ERR] job_id={job_id}: {ex}", exc_info=True)

            job.status = ScraperJobStatus.COMPLETED
            job.total_found = len(raw_leads)
            job.total_valid_phones = sum(1 for r in raw_leads if r.get("phone_e164"))
            job.total_new_leads = new_count
            job.completed_at = utc_now_naive()
            job.duration_seconds = int(time.time() - start_time)

            await db.commit()

            leads_to_broadcast = [lead_to_dict(l) for l in persisted_leads] if persisted_leads else raw_leads

            await ws_manager.broadcast({
                "event": "scraper_completed",
                "job_id": job_id,
                "user_id": owner,
                "total_found": len(raw_leads),
                "total_new_leads": new_count,
                "leads": leads_to_broadcast,
                "auto_saved": auto_save_to_crm,
                "metrics": latest_metrics
            })

            logger.info(
                f"[SEARCH_JOB_DONE] job_id={job_id} in {job.duration_seconds}s "
                f"discovered={len(raw_leads)} (auto_saved={auto_save_to_crm}, new={new_count})"
            )

        except asyncio.CancelledError:
            logger.warning(f"[SEARCH_JOB_CANCELLED] job_id={job_id}")
            job.status = ScraperJobStatus.CANCELLED
            job.completed_at = utc_now_naive()
            job.duration_seconds = int(time.time() - start_time)
            await db.commit()
            await ws_manager.broadcast({
                "event": "scraper_cancelled",
                "job_id": job_id,
                "user_id": owner,
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
                    job.completed_at = utc_now_naive()
                    job.duration_seconds = int(time.time() - start_time)
                    await db.commit()
            except Exception as rollback_err:
                logger.error(f"[SEARCH_JOB_ERROR] Failed to record failure in DB: {rollback_err}")
            await ws_manager.broadcast({
                "event": "scraper_failed",
                "job_id": job_id,
                "user_id": owner,
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
    from backend.app.services.quota_guard import QuotaGuardService
    await QuotaGuardService.check_scrape_allowance(db, current_user.id, count=1)

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
        created_at=utc_now_naive(),
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
            auto_save_to_crm=bool(req.auto_save_to_crm),
            neighborhoods=req.neighborhoods or [],
            min_population=req.min_population,
            radius_km=req.radius_km,
        )
    )
    active_tasks[job.id] = task

    return job


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
    from backend.app.services.quota_guard import QuotaGuardService
    await QuotaGuardService.check_scrape_allowance(db, current_user.id, count=len(req.leads))

    all_leads, new_count, updated_count = await LeadIngestService.ingest_leads(
        db=db,
        raw_leads=req.leads,
        source="GOOGLE_MAPS",
        search_keyword=job.keyword,
        search_location=job.location,
        user_id=current_user.id,
    )

    job.total_new_leads = (job.total_new_leads or 0) + new_count

    # Update user monthly usage in Profile table and QuotaGuardService
    profile = await db.get(Profile, current_user.id)
    if profile:
        profile.leads_used_this_month = (profile.leads_used_this_month or 0) + new_count

    if new_count > 0:
        await QuotaGuardService.consume_scrape_quota(db, current_user.id, count=new_count)

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
        .where(get_user_filter(ScraperJob.user_id, current_user.id))
        .order_by(ScraperJob.id.desc())
        .limit(limit)
    )
    res = await db.execute(stmt)
    return res.scalars().all()


@router.get("/jobs/{job_id}", response_model=ScraperJobResponse)
@router.get("/status/{job_id}", response_model=ScraperJobResponse)
async def get_scraper_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    job = await db.get(ScraperJob, job_id)
    if not job or not check_entity_ownership(job, current_user):
        raise HTTPException(status_code=404, detail="Tarama işi bulunamadı")
    return job


@router.post("/cancel/{job_id}")
async def cancel_scraper_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    job = await db.get(ScraperJob, job_id)
    if not job or not check_entity_ownership(job, current_user):
        raise HTTPException(status_code=404, detail="Tarama işi bulunamadı")

    task = active_tasks.get(job_id)
    if task and not task.done():
        task.cancel()
        return {"message": "Tarama işi iptal edildi", "job_id": job_id}

    if job.status in [ScraperJobStatus.PENDING, ScraperJobStatus.RUNNING]:
        job.status = ScraperJobStatus.CANCELLED
        job.completed_at = utc_now_naive()
        await db.commit()

    return {"message": "Tarama işi durduruldu", "job_id": job_id}
