"""
Campaign Runner & Lifecycle Management Service.
Coordinates background dispatch, concurrency locks, paused/completed state integrity,
and real-time WebSocket progress broadcasts.
"""

import asyncio
import logging
from typing import List, Optional
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.services.outreach_manager import OutreachManager
from backend.app.services.outreach_guard import OutreachGuard
from backend.app.services.antiban_policy import AntibanPolicy
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)

# In-memory registry of active campaign tasks to enforce idempotency
active_campaign_tasks: dict[int, asyncio.Task] = {}


class CampaignRunner:
    """Manages asynchronous campaign worker execution and state lifecycle."""

    @classmethod
    def is_campaign_running(cls, campaign_id: int) -> bool:
        task = active_campaign_tasks.get(campaign_id)
        return task is not None and not task.done()

    @classmethod
    async def start_campaign(
        cls,
        campaign_id: int,
        lead_ids: Optional[List[int]] = None,
        limit: int = 50
    ) -> bool:
        if cls.is_campaign_running(campaign_id):
            logger.warning(f"[CampaignRunner] Campaign #{campaign_id} is already running.")
            return False

        # DB-backed claim: exactly one worker owns a campaign, surviving
        # restarts and multi-worker setups. The conditional UPDATE wins the
        # race atomically; rowcount 0 means already ACTIVE (owned) or missing.
        async with AsyncSessionLocal() as db:
            claimed = await db.execute(
                update(Campaign)
                .where(
                    Campaign.id == campaign_id,
                    Campaign.status != CampaignStatus.ACTIVE,
                )
                .values(status=CampaignStatus.ACTIVE)
            )
            await db.commit()
            if claimed.rowcount == 0:
                logger.warning(
                    f"[CampaignRunner] Campaign #{campaign_id} already active or missing."
                )
                return False

        task = asyncio.create_task(
            cls._execute_campaign_worker(campaign_id, lead_ids, limit)
        )
        active_campaign_tasks[campaign_id] = task
        return True

    @classmethod
    async def cancel_campaign(cls, campaign_id: int) -> bool:
        task = active_campaign_tasks.get(campaign_id)
        if task and not task.done():
            task.cancel()
            return True
        return False

    @classmethod
    async def _execute_campaign_worker(
        cls,
        campaign_id: int,
        lead_ids: Optional[List[int]] = None,
        limit: int = 50
    ):
        logger.info(f"[CampaignRunner] Campaign #{campaign_id} outreach worker started.")

        try:
            async with AsyncSessionLocal() as db:
                campaign = await db.get(Campaign, campaign_id)
                if not campaign:
                    return

                campaign.status = CampaignStatus.ACTIVE
                await db.commit()

                await ws_manager.broadcast({
                    "event": "campaign_started",
                    "campaign_id": campaign_id,
                    "campaign_name": campaign.name
                })

                # Fetch Target Leads
                if lead_ids:
                    stmt = select(Lead).where(
                        Lead.id.in_(lead_ids),
                        Lead.is_whatsapp_eligible == True,
                        Lead.status == LeadStatus.NEW
                    )
                else:
                    stmt = select(Lead).where(
                        Lead.is_whatsapp_eligible == True,
                        Lead.status == LeadStatus.NEW
                    ).order_by(Lead.id.asc()).limit(limit)

                res = await db.execute(stmt)
                raw_leads = res.scalars().all()

                # Enforce OutreachGuard
                leads, blocked_leads = OutreachGuard.filter_qualified_for_outreach(raw_leads)

                campaign.total_leads_target = len(leads)
                await db.commit()

                if not leads:
                    campaign.status = CampaignStatus.COMPLETED
                    await db.commit()
                    await ws_manager.broadcast({
                        "event": "campaign_completed",
                        "campaign_id": campaign_id,
                        "message": f"Gönderilecek doğrulanmış işletme lead'i bulunamadı ({len(blocked_leads)} kayıt doğrulanamadığı için engellendi)."
                    })
                    return

                policy = AntibanPolicy.from_campaign(campaign)
                was_stopped_early = False

                for idx, lead in enumerate(leads):
                    # Re-check if campaign was paused or cancelled. Narrow
                    # status poll — no full-row refresh per lead.
                    live_status = await db.scalar(
                        select(Campaign.status).where(Campaign.id == campaign_id)
                    )
                    if live_status in (CampaignStatus.PAUSED, CampaignStatus.ARCHIVED):
                        logger.info(f"[CampaignRunner] Campaign #{campaign_id} was paused/stopped by user.")
                        was_stopped_early = True
                        break

                    # Process single outreach
                    success, msg, log_id = await OutreachManager.process_single_outreach(
                        db=db,
                        lead_id=lead.id,
                        campaign_id=campaign.id,
                    )

                    # Broadcast progress
                    await ws_manager.broadcast({
                        "event": "message_sent" if success else "message_failed",
                        "campaign_id": campaign_id,
                        "lead_id": lead.id,
                        "lead_name": lead.name,
                        "phone": lead.phone_e164,
                        "success": success,
                        "message": msg,
                        "progress": {
                            "current": idx + 1,
                            "total": len(leads),
                            "percentage": int(((idx + 1) / len(leads)) * 100)
                        }
                    })

                    # Apply Anti-Ban sleep delay
                    if idx < len(leads) - 1:
                        sleep_time = policy.worker_sleep_seconds()
                        await asyncio.sleep(sleep_time)

                # State transition at loop end:
                # If paused or cancelled early, preserve that status instead of incorrectly forcing COMPLETED!
                live_status = await db.scalar(
                    select(Campaign.status).where(Campaign.id == campaign_id)
                )
                if not was_stopped_early and live_status == CampaignStatus.ACTIVE:
                    campaign.status = CampaignStatus.COMPLETED
                    await db.commit()

                    await ws_manager.broadcast({
                        "event": "campaign_completed",
                        "campaign_id": campaign_id,
                        "total_sent": campaign.sent_count,
                        "total_failed": campaign.failed_count
                    })

        except asyncio.CancelledError:
            logger.warning(f"[CampaignRunner] Campaign #{campaign_id} worker task cancelled.")
            async with AsyncSessionLocal() as db:
                campaign = await db.get(Campaign, campaign_id)
                if campaign and campaign.status == CampaignStatus.ACTIVE:
                    campaign.status = CampaignStatus.PAUSED
                    await db.commit()
            raise
        except Exception as e:
            logger.exception(f"[CampaignRunner] Campaign #{campaign_id} error: {e}")
            # Fail-visible: never leave a campaign stuck ACTIVE. PAUSED matches
            # the restart-recovery semantics (user decides resume/retry).
            try:
                async with AsyncSessionLocal() as db:
                    broken = await db.get(Campaign, campaign_id)
                    if broken and broken.status == CampaignStatus.ACTIVE:
                        broken.status = CampaignStatus.PAUSED
                        await db.commit()
            except Exception as record_err:
                logger.error(f"[CampaignRunner] Could not park failed campaign #{campaign_id}: {record_err}")
            await ws_manager.broadcast({
                "event": "campaign_failed",
                "campaign_id": campaign_id,
                "error": str(e)[:300],
            })
        finally:
            active_campaign_tasks.pop(campaign_id, None)
