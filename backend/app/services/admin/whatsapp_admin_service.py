"""WhatsApp Operations service for Admin Center.

Invariants:
- Read-only aggregation across gateway bridge, gateway runtime, and database.
- Strict phone number masking (+90 552 *** ** 34).
- Dead letters and event outbox are aggregate counts ONLY; zero message bodies or payloads.
- Zero mutations.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from sqlalchemy import text, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.schemas.admin import (
    AdminGatewayBridgeStatus,
    AdminGatewayRuntimeStatus,
    AdminDBSessionSummary,
    AdminWhatsAppSessionSummary,
    AdminSocketLeasesStatus,
    AdminOutboxStatus,
    AdminRetryStatus,
    AdminWhatsAppResponse,
)
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services.whatsapp_gateway import health as get_gateway_health

logger = logging.getLogger(__name__)


def mask_phone_number(phone: Optional[str]) -> Optional[str]:
    """Masks phone number digits to avoid exposing full customer / line PII."""
    if not phone:
        return None
    cleaned = str(phone).strip()
    if len(cleaned) <= 4:
        return "***"
    prefix = cleaned[:6]
    suffix = cleaned[-2:]
    return f"{prefix}***{suffix}"


async def get_whatsapp_operations_metrics(db: AsyncSession) -> AdminWhatsAppResponse:
    now_iso = datetime.now(timezone.utc).isoformat()

    # 1. Gateway bridge status (in-process from main.py)
    bridge_data = {"connected": False, "reconnect_count": 0, "last_connected_at": None, "last_event_at": None}
    try:
        from backend.app.main import _gateway_bridge
        bridge_data["connected"] = bool(_gateway_bridge.get("connected", False))
        bridge_data["reconnect_count"] = int(_gateway_bridge.get("reconnect_count", 0))
        bridge_data["last_connected_at"] = _gateway_bridge.get("last_connected_at")
        bridge_data["last_event_at"] = _gateway_bridge.get("last_event_at")
    except Exception as be:
        logger.debug("Could not read _gateway_bridge from main: %s", be)

    gateway_bridge = AdminGatewayBridgeStatus(
        connected=bridge_data["connected"],
        reconnect_count=bridge_data["reconnect_count"],
        last_connected_at=bridge_data["last_connected_at"],
        last_event_at=bridge_data["last_event_at"],
    )

    # 2. Gateway runtime health probe
    gw_health = "unknown"
    gw_sessions = 0
    gw_connected = 0
    gw_pending_qr = 0
    try:
        res = await get_gateway_health()
        if isinstance(res, dict):
            gw_health = res.get("status", "ok")
            sessions_info = res.get("sessions", {})
            if isinstance(sessions_info, dict):
                gw_sessions = int(sessions_info.get("total", 0))
                gw_connected = int(sessions_info.get("connected", 0))
                gw_pending_qr = int(sessions_info.get("pending_qr", 0))
    except Exception as ge:
        logger.debug("Gateway health probe failed: %s", ge)
        gw_health = "unreachable"

    gateway_runtime = AdminGatewayRuntimeStatus(
        health_status=gw_health,
        session_count=gw_sessions,
        connected_count=gw_connected,
        pending_qr_count=gw_pending_qr,
    )

    # 3. DB session summary & session list
    sessions_list: List[AdminWhatsAppSessionSummary] = []
    total_sess = 0
    connected_sess = 0
    scan_qr_sess = 0
    relink_sess = 0

    try:
        stmt = select(WhatsAppSession).order_by(WhatsAppSession.id.asc())
        result = await db.execute(stmt)
        rows = result.scalars().all()

        total_sess = len(rows)
        for s in rows:
            st = str(s.status.value if hasattr(s.status, "value") else s.status)
            if st == "CONNECTED":
                connected_sess += 1
            elif st == "SCAN_QR":
                scan_qr_sess += 1
            elif st == "RELINK_REQUIRED":
                relink_sess += 1

            sessions_list.append(
                AdminWhatsAppSessionSummary(
                    id=s.id,
                    session_name=s.session_name,
                    status=st,
                    is_active=bool(s.is_active),
                    is_phone_online=bool(s.is_phone_online),
                    phone_number_masked=mask_phone_number(s.phone_number),
                    created_at=s.created_at.isoformat() if s.created_at else None,
                    updated_at=s.updated_at.isoformat() if s.updated_at else None,
                )
            )
    except Exception as se:
        logger.warning("Failed to query whatsapp_sessions: %s", se)

    db_summary = AdminDBSessionSummary(
        total=total_sess,
        connected=connected_sess,
        scan_qr=scan_qr_sess,
        relink_required=relink_sess,
    )

    # 4. Socket leases
    leases_count = 0
    try:
        lease_stmt = text("SELECT count(*) FROM whatsapp_private.socket_leases;")
        res = await db.execute(lease_stmt)
        val = res.scalar()
        if val is not None:
            leases_count = int(val)
    except Exception as le:
        logger.debug("Socket leases query failed or table not present: %s", le)
        leases_count = 0

    # R5 / R6: Duplicate is count exceeding connected; stale is count exceeding connected
    duplicate_leases = max(0, leases_count - max(1, connected_sess)) if connected_sess > 0 else leases_count
    stale_leases = max(0, leases_count - connected_sess)

    socket_leases = AdminSocketLeasesStatus(
        active_count=leases_count,
        duplicate_count=duplicate_leases,
        stale_count=stale_leases,
    )

    # 5. Outbox distribution
    outbox_counts = {"PENDING": 0, "IN_FLIGHT": 0, "DELIVERED": 0, "DEAD_LETTER": 0}
    total_outbox = 0
    try:
        outbox_stmt = text("SELECT state, count(*) FROM whatsapp_private.event_outbox GROUP BY state;")
        res = await db.execute(outbox_stmt)
        for r in res.fetchall():
            if len(r) >= 2:
                state_name = str(r[0]).strip().upper()
                cnt = int(r[1] or 0)
                outbox_counts[state_name] = cnt
                total_outbox += cnt
    except Exception as oe:
        logger.debug("Event outbox query failed or table not present: %s", oe)

    outbox_status = AdminOutboxStatus(
        total=total_outbox,
        pending=outbox_counts.get("PENDING", 0),
        in_flight=outbox_counts.get("IN_FLIGHT", 0),
        delivered=outbox_counts.get("DELIVERED", 0),
        dead_letter=outbox_counts.get("DEAD_LETTER", 0),
    )

    # 6. Retry message backlog
    retry_count = 0
    try:
        retry_stmt = text("SELECT count(*) FROM whatsapp_private.retry_messages;")
        res = await db.execute(retry_stmt)
        val = res.scalar()
        if val is not None:
            retry_count = int(val)
    except Exception as re_err:
        logger.debug("Retry messages query failed: %s", re_err)

    retry_status = AdminRetryStatus(
        retry_backlog=retry_count,
    )

    return AdminWhatsAppResponse(
        timestamp=now_iso,
        gateway_bridge=gateway_bridge,
        gateway_runtime=gateway_runtime,
        db_session_summary=db_summary,
        sessions=sessions_list,
        socket_leases=socket_leases,
        outbox=outbox_status,
        retry=retry_status,
    )
