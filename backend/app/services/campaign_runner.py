"""
Campaign Runner & Lifecycle Management Service.
Coordinates background dispatch, concurrency locks, paused/completed state integrity,
and real-time WebSocket progress broadcasts.
"""

import asyncio
import logging
from typing import List, Optional
from sqlalchemy import select, update

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.auth import get_user_filter
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
        limit: int = 50,
        session_id: Optional[int] = None,
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
            cls._execute_campaign_worker(campaign_id, lead_ids, limit, session_id=session_id)
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
        limit: int = 50,
        session_id: Optional[int] = None,
    ):
        logger.info(f"[CampaignRunner] Campaign #{campaign_id} outreach worker started.")

        # Faz 13: tenant sahibi. `except` bloklarinda da guvenle kullanilabilmesi
        # icin donguden ONCE tanimlanir (atama try icinde yapilir).
        owner: Optional[str] = None

        try:
            async with AsyncSessionLocal() as db:
                campaign = await db.get(Campaign, campaign_id)
                if not campaign:
                    return

                # Faz 13 (tenant izolasyonu): kampanyanin sahibi KESIN olmali.
                # Sahipsiz kampanya ile gonderim yapmak (ve olaylari genis
                # yayinlamak) veriyi yanlis tenant'a tasir — fail-closed dur.
                owner = str(campaign.user_id) if campaign.user_id else None
                if not owner:
                    logger.error(
                        "[CampaignRunner] Campaign #%s sahipsiz (user_id yok) — "
                        "gonderim yapilmadi, olay yayinlanmadi.",
                        campaign_id,
                    )
                    campaign.status = CampaignStatus.PAUSED
                    await db.commit()
                    return

                # Resolve sender line (session_id if specified, else campaign.whatsapp_session_id, else latest CONNECTED session)
                from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
                target_sess_id = session_id or getattr(campaign, "whatsapp_session_id", None)
                sess_stmt = select(WhatsAppSession).where(
                    WhatsAppSession.user_id == owner,
                    WhatsAppSession.status == SessionStatus.CONNECTED,
                )
                if target_sess_id:
                    sess_stmt = sess_stmt.where(WhatsAppSession.id == target_sess_id)
                active_sess = (await db.execute(sess_stmt.order_by(WhatsAppSession.id.desc()).limit(1))).scalars().first()

                # Fail-Closed Early Check: If no connected WhatsApp line exists, do NOT burn leads
                if not active_sess:
                    logger.warning(
                        "[CampaignRunner] Campaign #%s has no connected WhatsAppSession for user %s — pausing safely.",
                        campaign_id,
                        owner,
                    )
                    campaign.status = CampaignStatus.PAUSED
                    await db.commit()
                    await ws_manager.broadcast({
                        "event": "campaign_failed",
                        "campaign_id": campaign_id,
                        "user_id": owner,
                        "error": "Bağlı aktif bir WhatsApp hattı bulunamadı. Lütfen önce WhatsApp sekmesinden QR kod ile bir hat bağlayın.",
                    })
                    return

                sender_phone = active_sess.phone_number

                campaign.status = CampaignStatus.ACTIVE
                await db.commit()

                await ws_manager.broadcast({
                    "event": "campaign_started",
                    "campaign_id": campaign_id,
                    "campaign_name": campaign.name,
                    "user_id": owner,
                    "sender_phone": sender_phone,
                })

                # Fetch Target Leads — ZORUNLU tenant filtresi. Filtresiz sorgu
                # bir tenant'in kampanyasinin BASKA tenant'larin lead'lerine
                # gercek WhatsApp mesaji gondermesine yol aciyordu.
                tenant_scope = get_user_filter(Lead.user_id, owner)
                if lead_ids:
                    stmt = select(Lead).where(
                        tenant_scope,
                        Lead.id.in_(lead_ids),
                        Lead.is_whatsapp_eligible == True,
                        Lead.status == LeadStatus.NEW
                    )
                else:
                    stmt = select(Lead).where(
                        tenant_scope,
                        Lead.is_whatsapp_eligible == True,
                        Lead.status == LeadStatus.NEW
                    ).order_by(Lead.id.asc()).limit(limit)

                res = await db.execute(stmt)
                raw_leads = res.scalars().all()

                # Enforce OutreachGuard
                leads, blocked_leads = OutreachGuard.filter_qualified_for_outreach(raw_leads, sender_phone=sender_phone)

                campaign.total_leads_target = len(leads)
                await db.commit()

                if not leads:
                    campaign.status = CampaignStatus.COMPLETED
                    await db.commit()
                    await ws_manager.broadcast({
                        "event": "campaign_completed",
                        "campaign_id": campaign_id,
                        "user_id": owner,
                        "message": f"Gönderilecek doğrulanmış işletme lead'i bulunamadı ({len(blocked_leads)} kayıt doğrulanamadığı için engellendi)."
                    })
                    return

                # Resolve Anti-Ban Policy with daily limit
                from backend.app.models.system_settings import SystemSetting
                from backend.app.models.message_log import MessageLog, MessageStatus
                from backend.app.core.datetime_utils import utc_now_naive
                from sqlalchemy import func

                sys_setting = (await db.execute(
                    select(SystemSetting).where(SystemSetting.key == "antiban_config").limit(1)
                )).scalars().first()
                default_daily_limit = sys_setting.daily_message_limit if sys_setting and sys_setting.daily_message_limit else 50
                policy = AntibanPolicy.from_campaign(campaign, default_daily_limit=default_daily_limit)

                # Check today's sent count against policy daily limit
                start_of_day = utc_now_naive().replace(hour=0, minute=0, second=0, microsecond=0)
                sent_today = (await db.scalar(
                    select(func.count(MessageLog.id)).where(
                        MessageLog.user_id == owner,
                        MessageLog.status.in_([MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ, MessageStatus.REPLIED]),
                        MessageLog.sent_at >= start_of_day,
                    )
                )) or 0

                if policy.is_daily_limit_reached(sent_today):
                    logger.warning(
                        f"[CampaignRunner] Campaign #{campaign_id} paused: daily anti-ban limit reached ({sent_today}/{policy.daily_message_limit})."
                    )
                    campaign.status = CampaignStatus.PAUSED
                    await db.commit()
                    await ws_manager.broadcast({
                        "event": "campaign_paused",
                        "campaign_id": campaign_id,
                        "user_id": owner,
                        "reason": "daily_limit_reached",
                        "message": f"Günlük Anti-Ban mesaj limitine ({sent_today}/{policy.daily_message_limit}) ulaşıldı. WhatsApp hesabınızın güvenliği için kampanya otomatik duraklatıldı.",
                    })
                    return

                was_stopped_early = False

                # Campaign-scoped batch blacklist pre-resolution: 1 query instead of N per-lead queries
                candidate_phones = [l.phone_e164 for l in leads if l.phone_e164]
                blacklisted_phones = await OutreachManager.get_blacklisted_phones(db, candidate_phones)

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

                    # Check daily limit before each message
                    if policy.is_daily_limit_reached(sent_today):
                        logger.warning(
                            f"[CampaignRunner] Campaign #{campaign_id} reached daily limit ({sent_today}/{policy.daily_message_limit}) during loop. Pausing."
                        )
                        campaign.status = CampaignStatus.PAUSED
                        await db.commit()
                        await ws_manager.broadcast({
                            "event": "campaign_paused",
                            "campaign_id": campaign_id,
                            "user_id": owner,
                            "reason": "daily_limit_reached",
                            "message": f"Günlük Anti-Ban limitine ({sent_today}/{policy.daily_message_limit}) ulaşıldı. WhatsApp hattınızın güvenliği için kampanya duraklatıldı.",
                        })
                        was_stopped_early = True
                        break

                    # Process single outreach (reusing in-memory lead and campaign objects, plus batch blacklist)
                    success, msg, log_id = await OutreachManager.process_single_outreach(
                        db=db,
                        lead_id=lead.id,
                        campaign_id=campaign.id,
                        session_id=active_sess.id,
                        lead=lead,
                        campaign=campaign,
                        blacklisted_phones=blacklisted_phones,
                    )

                    # Handle fatal connection drop or working hours pause
                    if not success:
                        if OutreachManager.is_connection_fatal_error(msg):
                            logger.warning(
                                f"[CampaignRunner] WhatsApp session disconnected during campaign #{campaign_id}: {msg}. Pausing campaign."
                            )
                            campaign.status = CampaignStatus.PAUSED
                            await db.commit()
                            await ws_manager.broadcast({
                                "event": "campaign_paused",
                                "campaign_id": campaign_id,
                                "user_id": owner,
                                "reason": "session_disconnected",
                                "message": "WhatsApp hattının bağlantısı koptu. Kalan kayıtların yanmaması için kampanya otomatik duraklatıldı. Lütfen WhatsApp sekmesinden hattınızı yeniden bağlayın.",
                            })
                            was_stopped_early = True
                            break
                        elif "Mesai saatleri dışında" in msg:
                            logger.info(
                                f"[CampaignRunner] Outside working hours for campaign #{campaign_id}. Pausing campaign."
                            )
                            campaign.status = CampaignStatus.PAUSED
                            await db.commit()
                            await ws_manager.broadcast({
                                "event": "campaign_paused",
                                "campaign_id": campaign_id,
                                "user_id": owner,
                                "reason": "outside_working_hours",
                                "message": f"Mesai saatleri dışına çıkıldı ({campaign.working_hours_start}-{campaign.working_hours_end}). Kampanya ertesi gün mesai saatinde devam ettirilmek üzere güvenle duraklatıldı.",
                            })
                            was_stopped_early = True
                            break
                    else:
                        sent_today += 1

                    # Broadcast progress — yalnizca sahibine (lead adi/telefon
                    # tasiyor; genis yayin diger tenant'lara PII sizdirirdi).
                    await ws_manager.broadcast({
                        "event": "message_sent" if success else "message_failed",
                        "campaign_id": campaign_id,
                        "user_id": owner,
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
                    if idx < len(leads) - 1 and not was_stopped_early:
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
                        "user_id": owner,
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
                    # Hata `owner` atamasindan ONCE olustuysa sahibi DB'den coz —
                    # olay yalnizca sahibine yayinlanabilir.
                    if owner is None and broken and broken.user_id:
                        owner = str(broken.user_id)
            except Exception as record_err:
                logger.error(f"[CampaignRunner] Could not park failed campaign #{campaign_id}: {record_err}")
            if owner:
                await ws_manager.broadcast({
                    "event": "campaign_failed",
                    "campaign_id": campaign_id,
                    "user_id": owner,
                    "error": str(e)[:300],
                })
            else:
                logger.error(
                    "[CampaignRunner] Campaign #%s hatasi yayinlanmadi: tenant sahibi cozulemedi.",
                    campaign_id,
                )
        finally:
            active_campaign_tasks.pop(campaign_id, None)
