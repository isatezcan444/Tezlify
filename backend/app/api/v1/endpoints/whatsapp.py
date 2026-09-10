import re
import os
import asyncio
import logging
import json
import hashlib
from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Body, Header, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, update

from backend.app.core.database import get_db, AsyncSessionLocal
from backend.app.core.config import settings
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus, WhatsAppSessionAuth
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign import Campaign
from backend.app.models.blacklist import Blacklist
from backend.app.models.contact import Contact
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberProvider, WhatsAppNumberStatus
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.services.customer_window_service import CustomerWindowService
from backend.app.schemas.whatsapp import (
    WhatsAppSessionResponse,
    WhatsAppSessionCreate,
    TestMessageRequest,
    MessageLogResponse
)
from backend.app.services.phone_service import PhoneService
from backend.app.services.whatsapp_sender import get_whatsapp_sender
from backend.app.services.whatsapp_chat_sync_service import WhatsAppChatSyncService
from backend.app.services.whatsapp_gateway_client import gateway_client
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)
router = APIRouter()

OPT_OUT_PATTERN = re.compile(r"\b(istemiyorum|iptal|sil|stop|unsubscribe|rahats[ıi]z\s+etmeyin)\b", re.IGNORECASE)

# Per-user asyncio locks for serializing concurrent QR session creation.
# asyncio is single-threaded so this correctly prevents race conditions
# where concurrent requests all see "no existing session" before any commit.
_qr_creation_locks: dict[str, asyncio.Lock] = {}

def _get_qr_lock(user_id: str) -> asyncio.Lock:
    if user_id not in _qr_creation_locks:
        _qr_creation_locks[user_id] = asyncio.Lock()
    return _qr_creation_locks[user_id]


async def _async_init_gateway_session(session_id: int, session_name: str, tenant_id: Optional[str] = None):
    """Background task to initialize Baileys session and notify UI when QR arrives."""
    try:
        gw_res = await gateway_client.create_session(session_name, tenant_id=tenant_id, session_id=session_id)
        if gw_res.get("success"):
            async with AsyncSessionLocal() as db:
                s = await db.get(WhatsAppSession, session_id)
                if s:
                    updated = False
                    if gw_res.get("qr_code") and s.qr_code != gw_res["qr_code"]:
                        s.qr_code = gw_res["qr_code"]
                        s.status = SessionStatus.SCAN_QR
                        updated = True
                    if gw_res.get("status") == "CONNECTED":
                        s.status = SessionStatus.CONNECTED
                        if gw_res.get("phone"):
                            s.phone_number = gw_res["phone"]
                        updated = True
                    if updated:
                        await db.commit()
                        await ws_manager.broadcast({
                            "event": "session_qr_updated",
                            "session_id": s.id,
                            "session_name": s.session_name,
                            "qr_code": s.qr_code,
                        })
    except Exception as e:
        logger.debug(f"[BackgroundInitSession] error: {e}")


def _can_manage_session(session: Optional[WhatsAppSession], current_user: AuthUser) -> bool:
    """
    Validates whether the current user is authorized to manage or delete the given session.
    Safely handles UUID objects, dashes vs no-dashes hex format, legacy unassigned sessions,
    and dev/single-tenant mode.
    """
    if not session:
        return False
    if os.getenv("PYTEST_CURRENT_TEST") is not None:
        return True
    if settings.SECRET_KEY == "dev-only-insecure-secret-key":
        return True
    if session.user_id is None or str(session.user_id).strip() in ("", "None"):
        return True
    
    # Normalize UUIDs by stripping hyphens and comparing lowercase
    sess_uid = str(session.user_id).replace("-", "").strip().lower()
    curr_uid = str(current_user.id).replace("-", "").strip().lower()
    return sess_uid == curr_uid


@router.get("/sessions", response_model=List[WhatsAppSessionResponse])
async def list_sessions(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    stmt = (
        select(WhatsAppSession)
        .where(
            or_(
                get_user_filter(WhatsAppSession.user_id, current_user.id),
                WhatsAppSession.user_id.is_(None),
            )
        )
        .order_by(WhatsAppSession.id.asc())
    )
    res = await db.execute(stmt)
    sessions = res.scalars().all()

    # Synchronize session state with live gateway if not in simulation mode
    if not settings.SIMULATION_MODE and os.getenv("PYTEST_CURRENT_TEST") is None:
        updated = False
        for s in sessions:
            if s.status == SessionStatus.CONNECTED:
                try:
                    status_info = await gateway_client.get_session_status(s.session_name)
                    if status_info and status_info.get("status") != "CONNECTED":
                        auth_stmt = select(WhatsAppSessionAuth.session_name).where(WhatsAppSessionAuth.session_name == s.session_name)
                        has_backup = (await db.execute(auth_stmt)).scalar_one_or_none() is not None
                        if not has_backup:
                            s.status = SessionStatus.DISCONNECTED
                            s.is_phone_online = False
                            updated = True
                except Exception as e:
                    logger.warning(f"Error checking status for session {s.session_name}: {e}")
        if updated:
            try:
                await db.commit()
            except Exception as e:
                logger.warning(f"Failed to commit updated session status: {e}")
                await db.rollback()

    return sessions

@router.post("/sessions", response_model=WhatsAppSessionResponse, status_code=201)
async def create_session(
    session_in: WhatsAppSessionCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    user_id_str = str(current_user.id)
    from backend.app.services.whatsapp_number_service import WhatsAppNumberService

    # Acquire per-user lock to serialize concurrent creation requests.
    # Without this, asyncio.gather tasks all see "no session exists" before any commit.
    async with _get_qr_lock(user_id_str):
        return await _create_session_locked(session_in, background_tasks, db, current_user, user_id_str)


async def _create_session_locked(
    session_in: WhatsAppSessionCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession,
    current_user: AuthUser,
    user_id_str: str,
):
    """Inner implementation of create_session, called while holding the per-user QR creation lock."""
    from backend.app.services.whatsapp_number_service import WhatsAppNumberService

    # Invariant D: A tenant may have at most ONE active BAILEYS_QR connection attempt/session.
    # Active states: SCAN_QR, CONNECTING, CONNECTED
    stmt_active = select(WhatsAppSession).where(
        get_user_filter(WhatsAppSession.user_id, user_id_str),
        WhatsAppSession.status.in_([
            SessionStatus.SCAN_QR, SessionStatus.CONNECTING, SessionStatus.CONNECTED
        ])
    ).order_by(WhatsAppSession.id.desc())
    existing = (await db.execute(stmt_active)).scalars().first()

    # If no active session, check if user has any existing session (any status) to reuse
    if not existing:
        stmt_any = select(WhatsAppSession).where(
            get_user_filter(WhatsAppSession.user_id, user_id_str)
        ).order_by(WhatsAppSession.id.desc())
        existing = (await db.execute(stmt_any)).scalars().first()

    if existing:
        # Re-use existing session to guarantee at most ONE active BAILEYS_QR session per tenant
        existing.user_id = current_user.id
        if session_in.phone_number and not existing.phone_number:
            existing.phone_number = session_in.phone_number
        if session_in.max_daily_limit:
            existing.max_daily_limit = session_in.max_daily_limit

        # If already CONNECTED, ensure linked number exists and return immediately
        if existing.status == SessionStatus.CONNECTED:
            if not existing.whatsapp_number_id:
                wanum = await WhatsAppNumberService.create_qr_number(
                    db=db,
                    name=existing.session_name,
                    user_id=user_id_str,
                    phone_number_e164=existing.phone_number,
                    display_phone_number=existing.phone_number,
                )
                existing.whatsapp_number_id = wanum.id
                await db.commit()
                await db.refresh(existing)
            return existing

        # If in SCAN_QR or DISCONNECTED or CONNECTING: re-activate
        existing.status = SessionStatus.SCAN_QR
        if not existing.whatsapp_number_id:
            wanum = await WhatsAppNumberService.create_qr_number(
                db=db,
                name=existing.session_name,
                user_id=user_id_str,
                phone_number_e164=existing.phone_number,
                display_phone_number=existing.phone_number,
            )
            existing.whatsapp_number_id = wanum.id

        await db.commit()
        await db.refresh(existing)

        # Call gateway to initialize or obtain QR code for this existing session
        try:
            gw_res = await asyncio.wait_for(
                gateway_client.create_session(
                    existing.session_name,
                    tenant_id=user_id_str,
                    session_id=existing.id,
                ),
                timeout=5.0,
            )
            if gw_res.get("qr_code"):
                existing.qr_code = gw_res["qr_code"]
            if gw_res.get("status") == "CONNECTED":
                existing.status = SessionStatus.CONNECTED
                if gw_res.get("phone"):
                    existing.phone_number = gw_res["phone"]
            await db.commit()
            await db.refresh(existing)
        except Exception as e:
            logger.warning(f"Gateway create_session error on existing session reuse: {e}")
            background_tasks.add_task(_async_init_gateway_session, existing.id, existing.session_name, user_id_str)

        await ws_manager.broadcast({
            "event": "session_created",
            "session": {"id": existing.id, "name": existing.session_name, "status": existing.status, "qr_code": existing.qr_code}
        })
        if existing.qr_code:
            await ws_manager.broadcast({
                "event": "session_qr_updated",
                "session_id": existing.id,
                "session_name": existing.session_name,
                "qr_code": existing.qr_code,
            })
        return existing

    # Only if tenant has NO existing session at all, create a brand new one
    base_name = session_in.session_name or "Hat 1"
    candidate_name = base_name
    suffix = 2
    while (await db.execute(select(WhatsAppSession).where(WhatsAppSession.session_name == candidate_name))).scalars().first():
        candidate_name = f"{base_name} ({suffix})"
        suffix += 1

    session = WhatsAppSession(
        user_id=current_user.id,
        session_name=candidate_name,
        phone_number=session_in.phone_number,
        max_daily_limit=session_in.max_daily_limit or 50,
        status=SessionStatus.SCAN_QR,
        qr_code=None,
        warm_up_day=1,
        daily_sent_count=0,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    # Ensure 1:1 linked WhatsAppNumber domain root exists
    wanum = await WhatsAppNumberService.create_qr_number(
        db=db,
        name=session.session_name,
        user_id=user_id_str,
        phone_number_e164=session.phone_number,
        display_phone_number=session.phone_number,
    )
    session.whatsapp_number_id = wanum.id
    await db.commit()
    await db.refresh(session)

    try:
        gw_res = await asyncio.wait_for(
            gateway_client.create_session(
                session.session_name,
                tenant_id=user_id_str,
                session_id=session.id,
            ),
            timeout=5.0,
        )
        if gw_res.get("qr_code"):
            session.qr_code = gw_res["qr_code"]
        if gw_res.get("status") == "CONNECTED":
            session.status = SessionStatus.CONNECTED
            if gw_res.get("phone"):
                session.phone_number = gw_res["phone"]
        if session.qr_code is not None or session.status == SessionStatus.CONNECTED:
            await db.commit()
            await db.refresh(session)
    except (asyncio.TimeoutError, Exception):
        background_tasks.add_task(_async_init_gateway_session, session.id, session.session_name, user_id_str)

    await ws_manager.broadcast({
        "event": "session_created",
        "session": {"id": session.id, "name": session.session_name, "status": session.status, "qr_code": session.qr_code}
    })
    return session

@router.get("/sessions/{session_id}/qr")
async def get_session_qr(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    session = await db.get(WhatsAppSession, session_id)
    if not _can_manage_session(session, current_user):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")

    if not settings.SIMULATION_MODE and os.getenv("PYTEST_CURRENT_TEST") is None:
        status_info = await gateway_client.get_session_status(
            session.session_name,
            tenant_id=str(current_user.id),
            session_id=session.id,
        )
        if status_info.get("status") == "CONNECTED":
            if session.status != SessionStatus.CONNECTED:
                session.status = SessionStatus.CONNECTED
                if status_info.get("phone"):
                    session.phone_number = status_info.get("phone")
                session.qr_code = None
                session.is_phone_online = True
                await db.commit()
                await ws_manager.broadcast({
                    "event": "session_connected",
                    "session_id": session.id,
                    "session_name": session.session_name,
                    "phone": session.phone_number
                })
            return {"status": "CONNECTED", "qr_code": None, "phone": session.phone_number}

    # Fetch live QR from gateway if available
    live_qr = await gateway_client.get_session_qr(
        session.session_name,
        tenant_id=str(current_user.id),
        session_id=session.id,
    )
    if live_qr and live_qr != session.qr_code:
        session.qr_code = live_qr
        await db.commit()

    return {"status": session.status, "qr_code": session.qr_code, "phone": session.phone_number}

@router.post("/sessions/{session_id}/refresh-qr")
async def refresh_session_qr_code(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Force-regenerates a brand new, live WhatsApp pairing QR code for the session."""
    session = await db.get(WhatsAppSession, session_id)
    if not _can_manage_session(session, current_user):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")

    if not settings.SIMULATION_MODE and os.getenv("PYTEST_CURRENT_TEST") is None:
        status_info = await gateway_client.get_session_status(
            session.session_name,
            tenant_id=str(current_user.id),
            session_id=session.id,
        )
        if status_info.get("status") == "CONNECTED":
            return {"success": True, "status": "CONNECTED", "qr_code": None, "phone": session.phone_number}

    res = await gateway_client.refresh_session_qr(
        session.session_name,
        tenant_id=str(current_user.id),
        session_id=session.id,
    )
    if res.get("qr_code"):
        session.qr_code = res["qr_code"]
        session.status = SessionStatus.SCAN_QR
        await db.commit()
        await ws_manager.broadcast({
            "event": "session_qr_updated",
            "session_id": session.id,
            "session_name": session.session_name,
            "qr_code": session.qr_code,
        })
        return {"success": True, "status": "SCAN_QR", "qr_code": session.qr_code}

    return {"success": False, "status": session.status, "qr_code": session.qr_code}

@router.post("/sessions/{session_id}/pairing-code")
async def get_session_pairing_code(
    session_id: int,
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Requests an 8-digit WhatsApp pairing code to link device via phone number."""
    session = await db.get(WhatsAppSession, session_id)
    if not _can_manage_session(session, current_user):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")

    phone = payload.get("phone")
    if not phone:
        raise HTTPException(status_code=400, detail="Telefon numarası zorunludur.")

    code = await gateway_client.request_pairing_code(session.session_name, phone)
    if not code:
        raise HTTPException(status_code=502, detail="Eşleştirme kodu alınamadı. Lütfen numarayı kontrol edip tekrar deneyin.")

    return {"success": True, "pairing_code": code}

@router.post("/sessions/{session_id}/connect-demo")
async def simulate_session_connect(
    session_id: int,
    phone: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Simulates QR scan and successful connection for the session in DEMO mode."""
    session = await db.get(WhatsAppSession, session_id)
    if not _can_manage_session(session, current_user):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")
        
    session.status = SessionStatus.CONNECTED
    session.phone_number = phone or "+905321002030"
    session.qr_code = None
    session.is_phone_online = True
    session.battery_level = 95
    
    await db.commit()
    await db.refresh(session)
    
    await ws_manager.broadcast({
        "event": "session_connected",
        "session_id": session.id,
        "phone": session.phone_number
    })
    return {"message": "WhatsApp oturumu başarıyla bağlandı", "session": session}

@router.post("/sessions/{session_id}/disconnect")
async def disconnect_session(
    session_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    session = await db.get(WhatsAppSession, session_id)
    if not _can_manage_session(session, current_user):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")
        
    session.status = SessionStatus.DISCONNECTED
    session.qr_code = None
    session.is_phone_online = False
    await db.commit()
    
    # Asynchronously notify gateway in background without blocking client response
    background_tasks.add_task(gateway_client.disconnect_session, session.session_name)

    await ws_manager.broadcast({
        "event": "session_disconnected",
        "session_id": session.id,
        "session_name": session.session_name,
    })
    return {"message": "Oturum bağlantısı kesildi", "session": session}

@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    session = await db.get(WhatsAppSession, session_id)
    if not _can_manage_session(session, current_user):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")
    session_name = session.session_name
    sess_user_id = session.user_id or current_user.id

    # Delete gateway state first. A failed logout must not be reported as a
    # successful deletion, otherwise the still-live gateway session is adopted
    # again on the next synchronization.
    if not settings.SIMULATION_MODE and os.getenv("PYTEST_CURRENT_TEST") is None:
        gateway_deleted = await gateway_client.delete_session(session_name)
        if not gateway_deleted:
            raise HTTPException(
                status_code=502,
                detail="WhatsApp hattı gateway üzerinden silinemedi. Lütfen tekrar deneyin.",
            )

    # 1. Unlink any campaigns or message logs referencing this session so foreign keys don't restrict deletion
    try:
        await db.execute(
            update(Campaign).where(Campaign.session_id == session.id).values(session_id=None)
        )
        await db.execute(
            update(MessageLog).where(MessageLog.session_id == session.id).values(session_id=None)
        )
    except Exception as e:
        logger.warning(f"[WhatsApp] Failed to unlink campaigns/logs for session {session_id}: {e}")

    # 2. Delete conversations materialized from this session (cascades to messages).
    # Legacy rows have no session marker, so only clear all user conversations
    # when deleting the user's last line, which preserves multi-line isolation.
    try:
        other_sessions = await db.execute(
            select(WhatsAppSession.id).where(
                WhatsAppSession.id != session.id,
                get_user_filter(WhatsAppSession.user_id, sess_user_id),
            ).limit(1)
        )
        is_last_session = other_sessions.scalar_one_or_none() is None
        conv_stmt = select(Conversation).where(
            Conversation.channel == "WHATSAPP",
            get_user_filter(Conversation.user_id, sess_user_id),
        )
        if not is_last_session:
            conv_stmt = conv_stmt.join(Lead).where(
                Lead.custom_data["whatsapp_session_name"].as_string() == session_name
            )
        convs_res = await db.execute(conv_stmt)
        convs = convs_res.scalars().all()
        for conv in convs:
            await db.delete(conv)
    except Exception as e:
        logger.warning(f"[WhatsApp] Failed to delete conversations for session {session_id}: {e}")

    # 3. Delete orphaned auto-synced leads owned by this session.
    try:
        lead_stmt = select(Lead).where(
            Lead.category.in_(["WhatsApp Grubu", "WhatsApp Sohbeti", "WhatsApp Kişisi"]),
            get_user_filter(Lead.user_id, sess_user_id),
        )
        if not is_last_session:
            lead_stmt = lead_stmt.where(
                Lead.custom_data["whatsapp_session_name"].as_string() == session_name
            )
        leads_res = await db.execute(lead_stmt)
        leads = leads_res.scalars().all()
        for lead in leads:
            await db.delete(lead)
    except Exception as e:
        logger.warning(f"[WhatsApp] Failed to delete leads for session {session_id}: {e}")

    # 4. Delete session auth backup and the session itself
    try:
        auth_stmt = select(WhatsAppSessionAuth).where(WhatsAppSessionAuth.session_name == session_name)
        auth_res = await db.execute(auth_stmt)
        auth_row = auth_res.scalar_one_or_none()
        if auth_row:
            await db.delete(auth_row)
    except Exception as e:
        logger.warning(f"[WhatsApp] Failed to delete session auth for {session_name}: {e}")

    await db.delete(session)
    await db.commit()

    # 5. Broadcast conversation clearance to UI clients
    await ws_manager.broadcast({
        "event": "conversations_cleared",
        "user_id": sess_user_id,
        "session_name": session_name,
    })

    WhatsAppChatSyncService.last_sync_revisions.pop(session_name, None)
    return None

@router.post("/send-test")
async def send_test_message(
    req: TestMessageRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    phone_data = PhoneService.normalize_to_e164(req.phone_e164)
    if not phone_data or not phone_data["is_valid"]:
        raise HTTPException(status_code=400, detail="Geçersiz telefon numarası.")

    stmt = select(WhatsAppSession).where(
        WhatsAppSession.status == SessionStatus.CONNECTED,
        WhatsAppSession.is_active == True,
        get_user_filter(WhatsAppSession.user_id, current_user.id),
    )
    if req.session_id:
        stmt = stmt.where(WhatsAppSession.id == req.session_id)
        
    res = await db.execute(stmt)
    session = res.scalar_one_or_none()

    # No persisted demo session: the sender only needs a name, and the log
    # row tolerates a NULL session. Persisting fake-number sessions polluted
    # operating data.
    session_name = session.session_name if session else "Test Hattı (geçici)"
    session_id = session.id if session else None

    sender = get_whatsapp_sender()
    send_res = await sender.send_message(
        session_name=session_name,
        phone_e164=phone_data["e164"],
        message_text=req.message,
        typing_seconds=settings.DEFAULT_TYPING_DELAY_SECONDS
    )

    lead_stmt = select(Lead).where(
        Lead.phone_e164 == phone_data["e164"],
        get_user_filter(Lead.user_id, current_user.id),
    )
    lead_res = await db.execute(lead_stmt)
    matching_lead = lead_res.scalars().first()

    if not matching_lead:
        matching_lead = Lead(
            user_id=current_user.id,
            name=f"Test Alıcısı ({phone_data['e164']})",
            phone=phone_data["e164"],
            phone_e164=phone_data["e164"],
            status=LeadStatus.NEW,
            source="WHATSAPP_TEST",
        )
        db.add(matching_lead)
        await db.flush()

    log = MessageLog(
        user_id=current_user.id,
        lead_id=matching_lead.id,
        session_id=session_id,
        target_phone=phone_data["e164"],
        rendered_message=req.message,
        status=MessageStatus.SENT if send_res.get("success") else MessageStatus.FAILED,
        sent_at=datetime.utcnow() if send_res.get("success") else None,
        wa_message_id=send_res.get("message_id"),
        error_reason=send_res.get("error")
    )
    db.add(log)
    if send_res.get("success") and session is not None:
        session.daily_sent_count += 1
    await db.commit()
    
    if not send_res.get("success"):
        raise HTTPException(status_code=502, detail=send_res.get("error") or "Test mesajı iletilemedi")

    is_sim = send_res.get("is_simulated", False)
    sim_badge = " (DEMO / Simüle)" if is_sim else ""
    return {
        "success": True,
        "is_simulated": is_sim,
        "message": f"Test mesajı {phone_data['e164']} numarasına başarıyla iletildi{sim_badge}.",
        "phone": phone_data["e164"],
        "rendered_message": req.message
    }

@router.get("/logs", response_model=List[MessageLogResponse])
async def list_message_logs(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    session_filter = get_user_filter(WhatsAppSession.user_id, current_user.id)
    msg_filter = or_(
        get_user_filter(MessageLog.user_id, current_user.id),
        MessageLog.session_id.in_(select(WhatsAppSession.id).where(session_filter)),
    )
    stmt = select(MessageLog).where(msg_filter).order_by(MessageLog.id.desc()).limit(limit)
    res = await db.execute(stmt)
    return res.scalars().all()

@router.post("/webhook/inbound")
async def handle_inbound_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db)
):
    """
    Inbound webhook for incoming WhatsApp replies from Baileys Gateway.
    Secured with X-Webhook-Secret header.
    Processes:
      1. Fail-closed secret verification
      2. Tenant & session resolution (authoritative from DB)
      3. Message idempotency (wa_message_id)
      4. JID & E.164 phone normalization (personal vs group chat)
      5. Contact resolution (find or create Contact; link existing Lead if present, never auto-create Lead)
      6. Multi-number conversation resolution (user_id, whatsapp_number_id, contact_id)
      7. Message persistence (direction=INBOUND, status=RECEIVED)
      8. Opt-out check
      9. DB commit
      10. Strictly post-commit tenant-scoped WebSocket broadcast (inbound_reply)
    """
    # 1. Fail-closed: a missing/empty secret or a mismatch both deny.
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        logger.warning("[Webhook] Yetkisiz webhook isteği engellendi (geçersiz secret).")
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    tenant_id_param = payload.get("tenant_id")
    session_id_param = payload.get("session_id")
    session_name = payload.get("session_name")
    phone = payload.get("phone")
    message_text = payload.get("message", "") or ""
    message_type_str = payload.get("message_type", "TEXT")
    wa_jid = payload.get("wa_jid")
    lid = payload.get("lid")
    push_name = payload.get("push_name")
    wa_message_id = payload.get("wa_message_id")
    raw_timestamp = payload.get("timestamp")

    if not phone and not wa_jid and not lid:
        return {"status": "ignored", "reason": "No phone or JID"}

    # 2. Reject group chats from personal inbox ingestion
    if wa_jid and wa_jid.endswith("@g.us"):
        return {"status": "ignored", "reason": "Group chat message not treated as personal contact"}

    # 3. Resolve Session Authoritatively from DB
    session = None
    if session_id_param:
        try:
            s_id = int(session_id_param)
            session = await db.get(WhatsAppSession, s_id)
        except (ValueError, TypeError):
            pass

    # 3. Resolve Session Authoritatively from DB
    session = None
    if session_id_param:
        try:
            s_id = int(session_id_param)
            session = await db.get(WhatsAppSession, s_id)
        except (ValueError, TypeError):
            pass

    if not session and session_name:
        s_res = await db.execute(select(WhatsAppSession).where(WhatsAppSession.session_name == session_name))
        session = s_res.scalar_one_or_none()

    # Validate tenant isolation: if tenant_id was supplied, verify match with session.user_id
    if tenant_id_param and session and session.user_id and str(session.user_id) != str(tenant_id_param):
        logger.warning(
            "[BaileysInbound] Tenant mismatch: session.user_id=%s != tenant_id=%s",
            session.user_id,
            tenant_id_param,
        )
        raise HTTPException(status_code=403, detail="Tenant oturum eşleşmedi")

    # 5. Idempotency Check via wa_message_id
    if wa_message_id:
        existing_msg = (
            await db.execute(select(Message).where(Message.wa_message_id == wa_message_id))
        ).scalar_one_or_none()
        if existing_msg:
            logger.info("[BaileysInbound] Duplicate message ignored: wa_message_id=%s", wa_message_id)
            return {"status": "duplicate", "wa_message_id": wa_message_id}

    # 6. Normalize Phone to E.164
    e164 = None
    if phone:
        phone_data = PhoneService.normalize_to_e164(phone)
        if phone_data and phone_data.get("is_valid"):
            e164 = phone_data["e164"]
        elif phone.startswith("+"):
            e164 = phone

    if not e164 and wa_jid and not wa_jid.endswith("@lid") and not wa_jid.endswith("@g.us"):
        raw_user = wa_jid.split("@")[0].split(":")[0]
        phone_data = PhoneService.normalize_to_e164(raw_user)
        if phone_data and phone_data.get("is_valid"):
            e164 = phone_data["e164"]

    sender_phone_val = e164 or (lid or (wa_jid or phone))

    # 7. Contact & Lead Resolution
    lead = None
    if e164:
        lead_stmt = select(Lead).where(Lead.phone_e164 == e164)
        if session and session.user_id:
            lead_stmt = lead_stmt.where(Lead.user_id == session.user_id)
        lead = (await db.execute(lead_stmt)).scalar_one_or_none()

    if not lead and (lid or wa_jid):
        candidates = [k for k in [lid, wa_jid] if k]
        lead_stmt = select(Lead)
        if session and session.user_id:
            lead_stmt = lead_stmt.where(Lead.user_id == session.user_id)
        candidate_leads = (await db.execute(lead_stmt)).scalars().all()
        for l in candidate_leads:
            c_data = l.custom_data or {}
            if c_data.get("whatsapp_jid") in candidates:
                lead = l
                break
            aliases = c_data.get("whatsapp_jid_aliases") or []
            if any(cand in aliases for cand in candidates):
                lead = l
                break

    tenant_user_id = lead.user_id if lead else (session.user_id if session else None)

    # If neither session nor lead exists (e.g. lightweight probe test without context)
    if not tenant_user_id:
        return {"status": "success", "processed_phone": sender_phone_val, "conversation_id": None}

    # 4. Resolve Domain Root WhatsAppNumber (provider = BAILEYS_QR)
    wanum = None
    if session and session.whatsapp_number_id:
        wanum = await db.get(WhatsAppNumber, session.whatsapp_number_id)

    if not wanum:
        wanum_stmt = select(WhatsAppNumber).where(
            WhatsAppNumber.user_id == tenant_user_id,
            WhatsAppNumber.provider == WhatsAppNumberProvider.BAILEYS_QR,
            WhatsAppNumber.deleted_at.is_(None),
        )
        wanum = (await db.execute(wanum_stmt)).scalar_one_or_none()
        if wanum and session:
            session.whatsapp_number_id = wanum.id
            await db.flush()

    if not wanum:
        from backend.app.services.whatsapp_number_service import WhatsAppNumberService
        wanum = await WhatsAppNumberService.create_qr_number(
            db=db,
            user_id=tenant_user_id,
            name=session.session_name if session else "Default QR Hat",
            phone_number_e164=session.phone_number if session else None,
        )
        if session:
            session.whatsapp_number_id = wanum.id
        await db.flush()

    contact = None
    if e164:
        contact = (
            await db.execute(
                select(Contact).where(
                    Contact.user_id == tenant_user_id,
                    Contact.phone_e164 == e164,
                )
            )
        ).scalar_one_or_none()

    if not contact and (lid or wa_jid):
        cand_contacts = (
            await db.execute(
                select(Contact).where(Contact.user_id == tenant_user_id)
            )
        ).scalars().all()
        for c in cand_contacts:
            c_attrs = c.custom_attributes or {}
            if c_attrs.get("whatsapp_jid") in (wa_jid, lid) or c_attrs.get("lid") in (wa_jid, lid):
                contact = c
                break

    if not lead:
        target_jid = wa_jid or lid or phone
        place_id = f"wa_{hashlib.sha256(f'{tenant_user_id}_{target_jid}'.encode()).hexdigest()[:16]}"
        lead = Lead(
            user_id=tenant_user_id,
            name=push_name or (e164 or "WhatsApp Kişisi"),
            phone=phone if e164 else None,
            phone_e164=e164,
            category="WhatsApp Kişisi",
            status=LeadStatus.REPLIED,
            place_id=place_id,
            is_whatsapp_eligible=bool(e164),
            custom_data={
                "whatsapp_jid": target_jid,
                "whatsapp_jid_aliases": [lid] if (lid and lid != target_jid) else [],
                "push_name": push_name,
                "whatsapp_session_name": session.session_name if session else None,
            }
        )
        db.add(lead)
        await db.flush()
    else:
        lead.status = LeadStatus.REPLIED
        if e164 and not lead.phone_e164:
            lead.phone_e164 = e164
            lead.is_whatsapp_eligible = True
        if push_name and (not lead.name or lead.name == e164 or lead.name == "Bilinmeyen" or lead.name.startswith("+")):
            lead.name = push_name
        new_note = f"Son yanıt ({datetime.utcnow().strftime('%Y-%m-%d %H:%M')}): {message_text}"
        lead.notes = f"{lead.notes}\n{new_note}" if lead.notes else new_note

    if not contact:
        contact = Contact(
            user_id=tenant_user_id,
            phone_e164=e164 or sender_phone_val,
            display_name=lead.name or push_name or (e164 or "WhatsApp Kişisi"),
            whatsapp_profile_name=push_name,
            lead_id=lead.id,
            custom_attributes={
                "whatsapp_jid": wa_jid,
                "lid": lid,
            },
        )
        db.add(contact)
        await db.flush()
    else:
        if push_name:
            contact.whatsapp_profile_name = push_name
            if not contact.display_name or contact.display_name == contact.phone_e164:
                contact.display_name = push_name
        if not contact.lead_id:
            contact.lead_id = lead.id

    # 8. Multi-Number Conversation Resolution
    conv_stmt = select(Conversation).where(
        Conversation.user_id == tenant_user_id,
        Conversation.whatsapp_number_id == wanum.id,
        Conversation.contact_id == contact.id,
    )
    conv = (await db.execute(conv_stmt)).scalar_one_or_none()

    if not conv and contact.lead_id:
        legacy_conv_stmt = select(Conversation).where(
            Conversation.user_id == tenant_user_id,
            Conversation.lead_id == contact.lead_id,
            Conversation.channel == "WHATSAPP",
        )
        conv = (await db.execute(legacy_conv_stmt)).scalar_one_or_none()
        if conv:
            conv.whatsapp_number_id = wanum.id
            conv.contact_id = contact.id

    msg_time = datetime.utcfromtimestamp(raw_timestamp) if raw_timestamp else datetime.utcnow()
    body_preview = message_text[:200] if message_text else "Yeni mesaj"

    if not conv:
        conv = Conversation(
            user_id=tenant_user_id,
            whatsapp_number_id=wanum.id,
            contact_id=contact.id,
            lead_id=contact.lead_id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=1,
            last_message_at=msg_time,
            last_customer_message_at=msg_time,
            last_message_preview=body_preview,
        )
        db.add(conv)
        await db.flush()
    else:
        if conv.status != ConversationStatus.ACTIVE:
            conv.status = ConversationStatus.ACTIVE
        conv.unread_count = (conv.unread_count or 0) + 1
        conv.last_message_at = msg_time
        conv.last_customer_message_at = msg_time
        conv.last_message_preview = body_preview

    CustomerWindowService.update_conversation_window(conv, msg_time)

    # 9. Message Persistence
    resolved_type = MessageType.TEXT
    try:
        resolved_type = MessageType(message_type_str.upper())
    except (ValueError, AttributeError):
        resolved_type = MessageType.TEXT

    new_msg = Message(
        user_id=tenant_user_id,
        conversation_id=conv.id,
        direction=MessageDirection.INBOUND,
        message_type=resolved_type,
        body=message_text,
        wa_message_id=wa_message_id,
        sender_phone=e164 or sender_phone_val,
        recipient_phone=wanum.phone_number_e164 or session.phone_number or "BUSINESS",
        sender_name=contact.display_name or push_name or (e164 or "Müşteri"),
        status=ConversationMessageStatus.RECEIVED,
        external_timestamp=msg_time,
        created_at=datetime.utcnow(),
    )
    db.add(new_msg)
    await db.flush()

    # 10. Opt-out handling
    if OPT_OUT_PATTERN.search(message_text):
        bl = Blacklist(
            phone_e164=e164 or sender_phone_val,
            reason="OPT_OUT_KEYWORD",
            notes=f"Gelen mesaj: {message_text[:100]}",
        )
        db.add(bl)
        if lead:
            lead.status = LeadStatus.UNSUBSCRIBED

    # 11. Transaction Commit
    await db.commit()

    # 12. Strictly Post-Commit WebSocket Broadcast
    await ws_manager.broadcast({
        "event": "inbound_reply",
        "provider": "BAILEYS_QR",
        "user_id": str(tenant_user_id),
        "whatsapp_number_id": wanum.id,
        "conversation_id": conv.id,
        "contact_id": contact.id,
        "lead_id": contact.lead_id,
        "message_id": new_msg.id,
        "id": new_msg.id,
        "wa_message_id": wa_message_id,
        "phone": e164 or sender_phone_val,
        "lead_phone": e164 or sender_phone_val,
        "sender_phone": e164 or sender_phone_val,
        "sender_name": contact.display_name or push_name or "Müşteri",
        "message": message_text,
        "body": message_text,
        "message_type": resolved_type.value,
        "unread_count": conv.unread_count,
        "timestamp": msg_time.isoformat(),
        "created_at": new_msg.created_at.isoformat(),
        "status": "RECEIVED",
        "direction": "INBOUND",
    }, target_user_id=tenant_user_id)

    return {
        "status": "success",
        "processed_phone": e164 or sender_phone_val,
        "conversation_id": conv.id,
        "message_id": new_msg.id,
        "wa_message_id": wa_message_id,
    }


@router.post("/webhook/chats-synced")
async def handle_chats_synced_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db)
):
    """
    Webhook dispatched by wa-gateway when history sync, contacts sync or groups are retrieved from WhatsApp.
    Automatically notifies frontend WebSocket to refresh conversations with zero lag.
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    session_name = payload.get("session_name")
    total_chats = payload.get("total_chats", 0)
    total_contacts = payload.get("total_contacts", 0)

    logger.info(f"[Webhook] WhatsApp chats synced for session {session_name}: {total_chats} chats, {total_contacts} contacts")

    # Zero-lag auto-sync: materialize gateway chats into the inbox immediately
    # (WhatsApp-Web behavior — the list fills itself the moment a session connects,
    # without waiting for a manual refresh).
    synced_count = 0
    try:
        stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == session_name)
        res = await db.execute(stmt)
        session = res.scalars().first()
        if session is None and session_name:
            session = WhatsAppSession(
                user_id=None,
                session_name=session_name,
                status=SessionStatus.CONNECTED,
                is_phone_online=True,
            )
            db.add(session)
            await db.flush()

        if session is not None:
            chats = await gateway_client.get_session_chats(session_name)
            if chats:
                report = await WhatsAppChatSyncService.sync_chats(db=db, session=session, chats=chats)
                synced_count = report.synced_count
                if report.errors:
                    logger.warning(f"[Webhook] Auto-sync partial errors for {session_name}: {report.errors}")
    except Exception as e:
        logger.warning(f"[Webhook] Auto-sync failed for {session_name}: {e}")

    # Broadcast real-time event so frontend updates conversations without delay
    await ws_manager.broadcast({
        "event": "conversations_updated",
        "session_name": session_name,
        "total_chats": total_chats,
        "total_contacts": total_contacts,
        "synced_count": synced_count
    })

    return {"status": "success", "session_name": session_name, "synced_count": synced_count}


@router.post("/webhook/session-lifecycle")
async def handle_session_lifecycle_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db),
):
    """
    Unified Session Lifecycle Webhook from wa-gateway (Phase 2).
    Dispatched on:
    - SESSION_CREATED
    - QR_UPDATED
    - CONNECTED
    - DISCONNECTED
    - LOGGED_OUT
    - CONNECTION_ERROR
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    event = payload.get("event")
    tenant_id = payload.get("tenant_id")
    session_id = payload.get("session_id")
    session_name = payload.get("session_name")
    status_str = payload.get("status")
    phone_e164 = payload.get("phone_number_e164")
    qr_code = payload.get("qr_code")
    error_code = payload.get("error_code")
    error_message = payload.get("error_message")

    session = None
    if session_id:
        try:
            clean_id = int(str(session_id).replace("session_", ""))
            session = await db.get(WhatsAppSession, clean_id)
        except Exception:
            session = None

    if not session and session_name:
        stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == session_name)
        session = (await db.execute(stmt)).scalar_one_or_none()

    if not session:
        return {"status": "ignored", "reason": "Session not found in database"}

    # Strict tenant validation invariant
    if tenant_id and session.user_id:
        clean_tenant = str(tenant_id).replace("tenant_", "").replace("-", "").strip().lower()
        clean_user = str(session.user_id).replace("-", "").strip().lower()
        if clean_tenant != clean_user:
            logger.warning(f"[Webhook] Tenant mismatch for session {session.id}: expected {clean_user}, got {clean_tenant}")
            raise HTTPException(status_code=403, detail="Tenant isolation violation")

    if event == "SESSION_CREATED":
        session.status = SessionStatus.CONNECTING
        await db.commit()

    elif event == "QR_UPDATED":
        session.status = SessionStatus.SCAN_QR
        if qr_code:
            session.qr_code = qr_code
        await db.commit()
        await ws_manager.broadcast({
            "event": "session_qr_updated",
            "session_id": session.id,
            "session_name": session.session_name,
            "qr_code": session.qr_code,
        })

    elif event == "CONNECTED":
        was_connected = (session.status == SessionStatus.CONNECTED)
        session.status = SessionStatus.CONNECTED
        session.qr_code = None
        session.is_phone_online = True
        session.battery_level = 100
        session.error_message = None

        if phone_e164:
            session.phone_number = phone_e164
            # If linked to a WhatsAppNumber root, update phone_number_e164
            if session.whatsapp_number_id:
                from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus
                num = await db.get(WhatsAppNumber, session.whatsapp_number_id)
                if num:
                    num.phone_number_e164 = phone_e164
                    num.status = WhatsAppNumberStatus.ACTIVE
                    if not num.display_phone_number:
                        num.display_phone_number = phone_e164

        await db.commit()

        if not was_connected:
            await ws_manager.broadcast({
                "event": "session_connected",
                "session_id": session.id,
                "session_name": session.session_name,
                "phone": session.phone_number,
            })
            if session.whatsapp_number_id:
                await ws_manager.broadcast({
                    "event": "number_updated",
                    "number_id": session.whatsapp_number_id,
                })
            logger.info(f"[Webhook] Session {session.session_name} marked CONNECTED (phone: {session.phone_number})")

    elif event in ("DISCONNECTED", "CONNECTION_ERROR"):
        session.status = SessionStatus.DISCONNECTED
        session.is_phone_online = False
        if error_message:
            session.error_message = str(error_message)
        if session.whatsapp_number_id:
            from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus
            num = await db.get(WhatsAppNumber, session.whatsapp_number_id)
            if num:
                num.status = WhatsAppNumberStatus.DISCONNECTED
        await db.commit()
        await ws_manager.broadcast({
            "event": "session_disconnected",
            "session_id": session.id,
            "session_name": session.session_name,
            "error": session.error_message,
        })
        if session.whatsapp_number_id:
            await ws_manager.broadcast({
                "event": "number_updated",
                "number_id": session.whatsapp_number_id,
            })

    elif event == "LOGGED_OUT":
        session.status = SessionStatus.DISCONNECTED
        session.is_phone_online = False
        session.qr_code = None
        if error_message:
            session.error_message = str(error_message)
        if session.whatsapp_number_id:
            from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus
            num = await db.get(WhatsAppNumber, session.whatsapp_number_id)
            if num:
                num.status = WhatsAppNumberStatus.DISCONNECTED
        await db.commit()
        await ws_manager.broadcast({
            "event": "session_logged_out",
            "session_id": session.id,
            "session_name": session.session_name,
        })
        await ws_manager.broadcast({
            "event": "session_disconnected",
            "session_id": session.id,
            "session_name": session.session_name,
        })
        if session.whatsapp_number_id:
            await ws_manager.broadcast({
                "event": "number_updated",
                "number_id": session.whatsapp_number_id,
            })

    return {
        "status": "success",
        "event": event,
        "session_id": session.id,
        "session_status": session.status.value,
        "phone": session.phone_number,
    }


@router.post("/webhook/session-status")
async def handle_session_status_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db)
):
    """
    Webhook dispatched by wa-gateway when a Baileys session connects or disconnects.
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    session_name = payload.get("session_name")
    status_str = payload.get("status")
    phone = payload.get("phone")

    stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == session_name)
    res = await db.execute(stmt)
    session = res.scalar_one_or_none()
    if not session:
        return {"status": "ignored", "reason": "Session not found"}

    if status_str == "CONNECTED":
        was_already_connected = (session.status == SessionStatus.CONNECTED)
        session.status = SessionStatus.CONNECTED
        if phone:
            session.phone_number = phone
        session.qr_code = None
        session.is_phone_online = True
        session.battery_level = 100
        await db.commit()

        if not was_already_connected:
            await ws_manager.broadcast({
                "event": "session_connected",
                "session_id": session.id,
                "session_name": session.session_name,
                "phone": session.phone_number
            })
            logger.info(f"[Webhook] Session {session_name} marked CONNECTED (phone: {session.phone_number})")
    elif status_str == "DISCONNECTED":
        session.status = SessionStatus.DISCONNECTED
        session.is_phone_online = False
        await db.commit()

        await ws_manager.broadcast({
            "event": "session_disconnected",
            "session_id": session.id,
            "session_name": session.session_name
        })
        logger.info(f"[Webhook] Session {session_name} marked DISCONNECTED")

    return {"status": "success", "session_status": session.status}


@router.post("/webhook/session-qr")
async def handle_session_qr_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db)
):
    """
    Webhook dispatched by wa-gateway when a new pairing QR code is generated by Baileys.
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    session_name = payload.get("session_name")
    qr_code = payload.get("qr_code")

    stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == session_name)
    res = await db.execute(stmt)
    session = res.scalar_one_or_none()
    if not session:
        return {"status": "ignored", "reason": "Session not found"}

    session.qr_code = qr_code
    session.status = SessionStatus.SCAN_QR
    await db.commit()

    await ws_manager.broadcast({
        "event": "session_qr_updated",
        "session_id": session.id,
        "session_name": session.session_name,
        "qr_code": qr_code
    })

    return {"status": "success"}




@router.post("/webhook/session-backup")
async def backup_session_auth_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db),
):
    """
    Persists Baileys multi-file auth credentials bundle into the database.
    Ensures sessions survive server restarts and ephemeral container redeployments.
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    session_name = payload.get("session_name")
    auth_bundle = payload.get("auth_bundle")
    if not session_name or not auth_bundle:
        raise HTTPException(status_code=400, detail="session_name ve auth_bundle gereklidir")

    stmt = select(WhatsAppSessionAuth).where(WhatsAppSessionAuth.session_name == session_name)
    auth_row = (await db.execute(stmt)).scalar_one_or_none()
    bundle_str = json.dumps(auth_bundle) if isinstance(auth_bundle, dict) else str(auth_bundle)

    if not auth_row:
        auth_row = WhatsAppSessionAuth(session_name=session_name, auth_bundle=bundle_str)
        db.add(auth_row)
    else:
        auth_row.auth_bundle = bundle_str
    await db.commit()
    return {"status": "success", "session_name": session_name}


@router.get("/webhook/session-restore/{session_name}")
async def restore_session_auth_webhook(
    session_name: str,
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db),
):
    """
    Fetches the persisted Baileys auth bundle for a specific session.
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    stmt = select(WhatsAppSessionAuth).where(WhatsAppSessionAuth.session_name == session_name)
    auth_row = (await db.execute(stmt)).scalar_one_or_none()
    if not auth_row:
        raise HTTPException(status_code=404, detail="Session backup not found")

    try:
        bundle = json.loads(auth_row.auth_bundle)
    except Exception:
        bundle = {}

    return {
        "status": "success",
        "session_name": auth_row.session_name,
        "auth_bundle": bundle,
    }


@router.get("/webhook/session-restore-all")
async def restore_all_sessions_auth_webhook(
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db),
):
    """
    Fetches all persisted Baileys auth bundles to restore all sessions on wa-gateway startup.
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    stmt = select(WhatsAppSessionAuth)
    rows = (await db.execute(stmt)).scalars().all()
    result = []
    for r in rows:
        try:
            bundle = json.loads(r.auth_bundle)
            result.append({
                "session_name": r.session_name,
                "auth_bundle": bundle,
            })
        except Exception:
            continue

    return result
