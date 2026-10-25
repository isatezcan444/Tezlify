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
from backend.app.services.webhook_dispatcher import WebhookDispatcher

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
        session_ids: Optional[List[int]] = None,
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
            cls._execute_campaign_worker(campaign_id, lead_ids, limit, session_id=session_id, session_ids=session_ids)
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
    async def check_and_start_scheduled_campaigns(cls) -> int:
        """
        Polls for campaigns in SCHEDULED status whose scheduled_at <= utc_now_naive().
        Transitions and kicks off CampaignRunner for each.
        Returns the count of successfully initiated campaigns.
        """
        from backend.app.core.datetime_utils import utc_now_naive
        from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
        from backend.app.models.campaign_group import campaign_group_leads

        now = utc_now_naive()
        started_count = 0

        async with AsyncSessionLocal() as db:
            stmt = (
                select(Campaign)
                .where(
                    Campaign.status == CampaignStatus.SCHEDULED,
                    Campaign.scheduled_at <= now,
                )
                .order_by(Campaign.scheduled_at.asc())
            )
            res = await db.execute(stmt)
            scheduled_campaigns = res.scalars().all()

            for campaign in scheduled_campaigns:
                if cls.is_campaign_running(campaign.id):
                    continue

                # Multi-session pool (Hat Havuzu) or single session resolution
                pool_sess_ids = getattr(campaign, "whatsapp_session_ids", None)
                target_sess_id = campaign.whatsapp_session_id
                sess_stmt = select(WhatsAppSession).where(
                    WhatsAppSession.status == SessionStatus.CONNECTED
                )
                if campaign.user_id:
                    sess_stmt = sess_stmt.where(WhatsAppSession.user_id == campaign.user_id)
                if pool_sess_ids and isinstance(pool_sess_ids, list) and len(pool_sess_ids) > 0:
                    sess_stmt = sess_stmt.where(WhatsAppSession.id.in_(pool_sess_ids))
                elif target_sess_id:
                    sess_stmt = sess_stmt.where(WhatsAppSession.id == target_sess_id)

                active_sessions = (await db.execute(sess_stmt.order_by(WhatsAppSession.id.desc()))).scalars().all()

                # Fallback to any connected session of same user if specific was offline
                if not active_sessions and campaign.user_id:
                    fallback_stmt = select(WhatsAppSession).where(
                        WhatsAppSession.user_id == campaign.user_id,
                        WhatsAppSession.status == SessionStatus.CONNECTED,
                    ).order_by(WhatsAppSession.id.desc())
                    active_sessions = (await db.execute(fallback_stmt)).scalars().all()

                if not active_sessions:
                    logger.warning(
                        f"[CampaignRunner] Scheduled campaign #{campaign.id} ('{campaign.name}') reached its scheduled time, but no connected WhatsApp session was found. Waiting for active line."
                    )
                    continue

                # Target leads if group_id is set
                target_lead_ids = None
                if campaign.group_id:
                    group_leads_res = await db.execute(
                        select(campaign_group_leads.c.lead_id).where(campaign_group_leads.c.group_id == campaign.group_id)
                    )
                    target_lead_ids = [row[0] for row in group_leads_res.fetchall()]

                if pool_sess_ids and len(pool_sess_ids) > 0:
                    started = await cls.start_campaign(
                        campaign_id=campaign.id,
                        lead_ids=target_lead_ids,
                        limit=50,
                        session_ids=[s.id for s in active_sessions],
                    )
                else:
                    started = await cls.start_campaign(
                        campaign_id=campaign.id,
                        lead_ids=target_lead_ids,
                        limit=50,
                        session_id=target_sess_id or (active_sessions[0].id if active_sessions else None),
                    )
                if started:
                    started_count += 1
                    logger.info(
                        f"[CampaignRunner] Scheduled campaign #{campaign.id} ('{campaign.name}') automatically started at scheduled time ({campaign.scheduled_at})."
                    )
                    await ws_manager.broadcast({
                        "event": "campaign_started",
                        "campaign_id": campaign.id,
                        "name": campaign.name,
                        "user_id": str(campaign.user_id) if campaign.user_id else None,
                        "scheduled": True,
                        "sender_phone": active_sessions[0].phone_number if active_sessions else None,
                    })

        return started_count

    @classmethod
    async def _execute_campaign_worker(
        cls,
        campaign_id: int,
        lead_ids: Optional[List[int]] = None,
        limit: int = 50,
        session_id: Optional[int] = None,
        session_ids: Optional[List[int]] = None,
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

                # Resolve sender line(s) / Hat Havuzu pool:
                from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
                candidate_pool_ids = session_ids or getattr(campaign, "whatsapp_session_ids", None)
                if candidate_pool_ids and isinstance(candidate_pool_ids, list) and len(candidate_pool_ids) > 0:
                    sess_stmt = select(WhatsAppSession).where(
                        WhatsAppSession.user_id == owner,
                        WhatsAppSession.status == SessionStatus.CONNECTED,
                        WhatsAppSession.id.in_(candidate_pool_ids),
                    ).order_by(WhatsAppSession.id.asc())
                    active_sessions = (await db.execute(sess_stmt)).scalars().all()
                elif session_id or getattr(campaign, "whatsapp_session_id", None):
                    single_target_id = session_id or getattr(campaign, "whatsapp_session_id", None)
                    sess_stmt = select(WhatsAppSession).where(
                        WhatsAppSession.user_id == owner,
                        WhatsAppSession.status == SessionStatus.CONNECTED,
                        WhatsAppSession.id == single_target_id,
                    )
                    active_sessions = (await db.execute(sess_stmt)).scalars().all()
                else:
                    sess_stmt = select(WhatsAppSession).where(
                        WhatsAppSession.user_id == owner,
                        WhatsAppSession.status == SessionStatus.CONNECTED,
                    ).order_by(WhatsAppSession.id.desc())
                    active_sessions = (await db.execute(sess_stmt)).scalars().all()

                # Fail-Closed Early Check: If no connected WhatsApp line exists, do NOT burn leads
                if not active_sessions:
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

                sender_phone = active_sessions[0].phone_number if active_sessions else None

                campaign.status = CampaignStatus.ACTIVE
                await db.commit()

                await ws_manager.broadcast({
                    "event": "campaign_started",
                    "campaign_id": campaign_id,
                    "campaign_name": campaign.name,
                    "user_id": owner,
                    "sender_phone": sender_phone,
                    "pool_size": len(active_sessions),
                    "pool_session_ids": [s.id for s in active_sessions],
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
                    )
                else:
                    stmt = select(Lead).where(
                        tenant_scope,
                        Lead.is_whatsapp_eligible == True,
                        Lead.status == LeadStatus.NEW
                    ).order_by(Lead.id.asc()).limit(limit)

                res = await db.execute(stmt)
                raw_leads = res.scalars().all()

                # Enforce OutreachGuard against ALL line numbers in the pool
                allow_self = bool(lead_ids)
                leads, blocked_leads = OutreachGuard.filter_qualified_for_outreach(
                    raw_leads, sender_phone=sender_phone, allow_self_outreach=allow_self
                )
                if not allow_self:
                    all_pool_phones = {s.phone_number for s in active_sessions if s.phone_number}
                    leads = [l for l in leads if l.phone_e164 not in all_pool_phones]

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
                from backend.app.services.warmup_service import WarmupService
                from sqlalchemy import func

                sys_setting = (await db.execute(
                    select(SystemSetting).where(SystemSetting.key == "antiban_config").limit(1)
                )).scalars().first()
                default_daily_limit = sys_setting.daily_message_limit if sys_setting and sys_setting.daily_message_limit else 50
                policy = AntibanPolicy.from_campaign(campaign, default_daily_limit=default_daily_limit)

                # Initialize Hat Havuzu: Track limits and daily sent count for each line in pool
                session_limits: Dict[int, int] = {}
                session_daily_sent: Dict[int, int] = {}
                for sess in active_sessions:
                    limit_val = policy.daily_message_limit
                    if getattr(sess, "is_warmup_enabled", False):
                        await WarmupService.sync_session_warmup(sess, db)
                        limit_val = min(limit_val, sess.warmup_daily_limit)
                    session_limits[sess.id] = limit_val
                    sent_cnt = await WarmupService.count_sent_today(sess, db)
                    session_daily_sent[sess.id] = sent_cnt

                # Check if all sessions in pool are already exhausted
                usable_sessions = [s for s in active_sessions if session_daily_sent[s.id] < session_limits[s.id]]
                if not usable_sessions:
                    reason = "pool_limits_reached" if len(active_sessions) > 1 else "daily_limit_reached"
                    if len(active_sessions) > 1:
                        msg_txt = (
                            f"Seçilen hat havuzundaki tüm WhatsApp hatlarının ({len(active_sessions)} hat) "
                            f"günlük Anti-Ban / Isıtma limitine ulaşıldı. Hesapların güvenliği için kampanya otomatik duraklatıldı."
                        )
                    else:
                        limit_val = session_limits[active_sessions[0].id]
                        msg_txt = (
                            f"WhatsApp hattınızın günlük Anti-Ban / Isıtma limitine ({limit_val} mesaj) "
                            f"ulaşıldı. Hesabınızın güvenliği için kampanya otomatik duraklatıldı."
                        )
                    logger.warning(
                        f"[CampaignRunner] Campaign #{campaign_id} paused: {reason} (pool size: {len(active_sessions)})."
                    )
                    campaign.status = CampaignStatus.PAUSED
                    await db.commit()
                    await ws_manager.broadcast({
                        "event": "campaign_paused",
                        "campaign_id": campaign_id,
                        "user_id": owner,
                        "reason": reason,
                        "message": msg_txt,
                    })
                    return

                was_stopped_early = False

                # Campaign-scoped batch blacklist pre-resolution: 1 query instead of N per-lead queries
                candidate_phones = [l.phone_e164 for l in leads if l.phone_e164]
                blacklisted_phones = await OutreachManager.get_blacklisted_phones(db, candidate_phones)
                round_robin_idx = 0

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

                    # Check which lines in the pool have available quota remaining
                    usable_sessions = [s for s in active_sessions if session_daily_sent[s.id] < session_limits[s.id]]
                    if not usable_sessions:
                        reason = "pool_limits_reached" if len(active_sessions) > 1 else "daily_limit_reached"
                        if len(active_sessions) > 1:
                            msg_txt = (
                                f"Hat havuzundaki tüm WhatsApp hatlarının ({len(active_sessions)} hat) "
                                f"günlük Anti-Ban / Isıtma limitine ulaşıldı. WhatsApp hesaplarınızın güvenliği için kampanya duraklatıldı."
                            )
                        else:
                            limit_val = session_limits[active_sessions[0].id]
                            msg_txt = (
                                f"WhatsApp hattınızın günlük Anti-Ban / Isıtma limitine ({limit_val} mesaj) "
                                f"ulaşıldı. WhatsApp hesabınızın güvenliği için kampanya duraklatıldı."
                            )
                        logger.warning(
                            f"[CampaignRunner] Campaign #{campaign_id} all {len(active_sessions)} pool lines reached limit. Pausing."
                        )
                        campaign.status = CampaignStatus.PAUSED
                        await db.commit()
                        await ws_manager.broadcast({
                            "event": "campaign_paused",
                            "campaign_id": campaign_id,
                            "user_id": owner,
                            "reason": reason,
                            "message": msg_txt,
                        })
                        was_stopped_early = True
                        break

                    # Pick next session using round-robin distribution
                    curr_sess = usable_sessions[round_robin_idx % len(usable_sessions)]
                    round_robin_idx += 1

                    # Process single outreach with selected line from the pool
                    success, msg, log_id = await OutreachManager.process_single_outreach(
                        db=db,
                        lead_id=lead.id,
                        campaign_id=campaign.id,
                        session_id=curr_sess.id,
                        lead=lead,
                        campaign=campaign,
                        blacklisted_phones=blacklisted_phones,
                    )

                    if success:
                        session_daily_sent[curr_sess.id] += 1
                        try:
                            from backend.app.services.quota_guard import QuotaGuardService
                            await QuotaGuardService.consume_whatsapp_quota(db, owner, 1)
                        except Exception as exc:
                            logger.warning(f"[QuotaGuard] Could not update WhatsApp quota: {exc}")

                    # Handle fatal connection drop or working hours pause
                    if not success:
                        if OutreachManager.is_connection_fatal_error(msg):
                            logger.warning(
                                f"[CampaignRunner] WhatsApp line #{curr_sess.id} ({curr_sess.session_name}) disconnected: {msg}."
                            )
                            # Remove disconnected line from active pool
                            active_sessions = [s for s in active_sessions if s.id != curr_sess.id]
                            if not active_sessions:
                                logger.warning(
                                    f"[CampaignRunner] All WhatsApp lines in pool disconnected during campaign #{campaign_id}. Pausing."
                                )
                                campaign.status = CampaignStatus.PAUSED
                                await db.commit()
                                await ws_manager.broadcast({
                                    "event": "campaign_paused",
                                    "campaign_id": campaign_id,
                                    "user_id": owner,
                                    "reason": "session_disconnected",
                                    "message": "WhatsApp hat havuzundaki tüm hatların bağlantısı koptu. Kalan kayıtların yanmaması için kampanya otomatik duraklatıldı. Lütfen WhatsApp sekmesinden hatlarınızı kontrol edin.",
                                })
                                was_stopped_early = True
                                break
                            else:
                                logger.info(
                                    f"[CampaignRunner] Failing over to remaining {len(active_sessions)} active lines in pool."
                                )
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

                    WebhookDispatcher.emit(
                        user_id=owner,
                        event_type="campaign.completed",
                        data={
                            "campaign_id": campaign.id,
                            "campaign_name": campaign.name,
                            "sent_count": campaign.sent_count,
                            "failed_count": campaign.failed_count,
                            "total_target": campaign.total_leads_target,
                        },
                    )

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
