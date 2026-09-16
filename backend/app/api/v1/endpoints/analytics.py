from typing import Dict, Any, List
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.schemas.analytics import DashboardStatsResponse

router = APIRouter()


@router.get("/dashboard", response_model=DashboardStatsResponse)
async def get_dashboard_stats(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    lead_filter = get_user_filter(Lead.user_id, current_user.id)
    camp_filter = get_user_filter(Campaign.user_id, current_user.id)
    msg_filter = get_user_filter(MessageLog.user_id, current_user.id)

    # 1. Leads by Status Breakdown (single grouped query resolving status distribution, contacted, replied & total)
    status_counts_res = await db.execute(
        select(Lead.status, func.count(Lead.id)).where(lead_filter).group_by(Lead.status)
    )
    leads_by_status = {
        status.value if hasattr(status, "value") else str(status): count
        for status, count in status_counts_res.all()
    }
    total_leads = sum(leads_by_status.values())

    # 2. WhatsApp Eligible Leads
    wa_eligible_res = await db.execute(select(func.count(Lead.id)).where(lead_filter, Lead.is_whatsapp_eligible == True))
    wa_eligible = wa_eligible_res.scalar_one()

    # 3. Contacted & Replied Leads (derived from grouped status counts — zero extra queries)
    contacted = (
        leads_by_status.get(LeadStatus.CONTACTED.value, 0)
        + leads_by_status.get(LeadStatus.REPLIED.value, 0)
        + leads_by_status.get(LeadStatus.INTERESTED.value, 0)
    )
    replied = (
        leads_by_status.get(LeadStatus.REPLIED.value, 0)
        + leads_by_status.get(LeadStatus.INTERESTED.value, 0)
    )

    # Response Rate %
    response_rate = round((replied / contacted * 100), 1) if contacted > 0 else 0.0

    # 4. Total & Active Campaigns (single aggregated query)
    camp_counts_res = await db.execute(
        select(
            func.count(Campaign.id),
            func.count(Campaign.id).filter(Campaign.status == CampaignStatus.ACTIVE)
        ).where(camp_filter)
    )
    total_campaigns, active_campaigns = camp_counts_res.one()

    # 6. Connected WhatsApp Sessions: WhatsApp backend removed — always 0.
    #    Field kept for dashboard contract compatibility.
    connected_sessions = 0

    # 7. Messages Sent Metrics
    total_sent_res = await db.execute(
        select(func.count(MessageLog.id)).where(
            msg_filter,
            MessageLog.status.in_([MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ, MessageStatus.REPLIED])
        )
    )
    total_messages_sent = total_sent_res.scalar_one()

    # "Today" follows the product's home market (Europe/Istanbul, fixed UTC+3,
    # no DST since 2016); columns store naive UTC, so compare naive instants.
    # Same success set as the lifetime counter — FAILED sends never count.
    tr_now = datetime.now(ZoneInfo("Europe/Istanbul"))
    today_start = (
        tr_now.replace(hour=0, minute=0, second=0, microsecond=0)
        .astimezone(timezone.utc)
        .replace(tzinfo=None)
    )
    today_sent_res = await db.execute(
        select(func.count(MessageLog.id)).where(
            msg_filter,
            MessageLog.created_at >= today_start,
            MessageLog.status.in_([MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ, MessageStatus.REPLIED]),
        )
    )
    messages_sent_today = today_sent_res.scalar_one()


    # 9. Top Categories
    top_cat_res = await db.execute(
        select(Lead.category, func.count(Lead.id).label("count"))
        .where(lead_filter, Lead.category.is_not(None))
        .group_by(Lead.category)
        .order_by(func.count(Lead.id).desc())
        .limit(5)
    )
    top_categories = [{"category": cat, "count": count} for cat, count in top_cat_res.all()]

    # 10. Last 7 Days Volume Trend (Optimized single GROUP BY query)
    seven_days_ago = today_start - timedelta(days=6)
    
    sent_by_day_res = await db.execute(
        select(
            func.date(MessageLog.created_at).label("d"),
            func.count(MessageLog.id)
        )
        .where(msg_filter, MessageLog.created_at >= seven_days_ago)
        .group_by(func.date(MessageLog.created_at))
    )
    sent_map = {str(row[0]): row[1] for row in sent_by_day_res.all()}

    leads_by_day_res = await db.execute(
        select(
            func.date(Lead.created_at).label("d"),
            func.count(Lead.id)
        )
        .where(lead_filter, Lead.created_at >= seven_days_ago)
        .group_by(func.date(Lead.created_at))
    )
    leads_map = {str(row[0]): row[1] for row in leads_by_day_res.all()}

    daily_volume = []
    for i in range(6, -1, -1):
        day = (datetime.utcnow() - timedelta(days=i)).date()
        day_str = str(day)
        daily_volume.append({
            "date": day.strftime("%d %b"),
            "sent_messages": sent_map.get(day_str, 0),
            "leads_scraped": leads_map.get(day_str, 0)
        })

    # 11. Recent Activity
    recent_logs = await db.execute(select(MessageLog).where(msg_filter).order_by(MessageLog.id.desc()).limit(6))
    recent_activity = []
    for log in recent_logs.scalars().all():
        recent_activity.append({
            "id": log.id,
            "phone": log.target_phone,
            "status": log.status.value if hasattr(log.status, "value") else str(log.status),
            "time": log.created_at.strftime("%H:%M:%S") if log.created_at else "",
            "message_snippet": log.rendered_message[:60] + "..." if len(log.rendered_message) > 60 else log.rendered_message
        })

    return {
        "total_leads": total_leads,
        "whatsapp_eligible_leads": wa_eligible,
        "contacted_leads": contacted,
        "replied_leads": replied,
        "response_rate_percentage": response_rate,
        "total_campaigns": total_campaigns,
        "active_campaigns": active_campaigns,
        "connected_sessions": connected_sessions,
        "total_messages_sent": total_messages_sent,
        "messages_sent_today": messages_sent_today,
        "leads_by_status": leads_by_status,
        "top_categories": top_categories,
        "daily_volume": daily_volume,
        "recent_activity": recent_activity
    }
