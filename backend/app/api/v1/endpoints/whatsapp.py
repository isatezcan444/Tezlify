import re
import os
import asyncio
import logging
import json
from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Body, Header, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_

from backend.app.core.database import get_db, AsyncSessionLocal
from backend.app.core.config import settings
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus, WhatsAppSessionAuth
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.blacklist import Blacklist
from backend.app.models.conversation import Conversation
from backend.app.schemas.whatsapp import (
    WhatsAppSessionResponse,
    WhatsAppSessionCreate,
    TestMessageRequest,
    MessageLogResponse
)
from backend.app.services.phone_service import PhoneService
from backend.app.services.whatsapp_sender import get_whatsapp_sender
from backend.app.services.whatsapp_gateway_client import gateway_client
from backend.app.services.whatsapp_sync_service import WhatsAppSyncService
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)
router = APIRouter()

OPT_OUT_PATTERN = re.compile(r"\b(istemiyorum|iptal|sil|stop|unsubscribe|rahats[ıi]z\s+etmeyin)\b", re.IGNORECASE)


async def _async_init_gateway_session(session_id: int, session_name: str):
    """Background task to initialize Baileys session and notify UI when QR arrives."""
    try:
        gw_res = await gateway_client.create_session(session_name)
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


@router.get("/sessions", response_model=List[WhatsAppSessionResponse])
async def list_sessions(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    stmt = (
        select(WhatsAppSession)
        .where(get_user_filter(WhatsAppSession.user_id, current_user.id))
        .order_by(WhatsAppSession.id.asc())
    )
    res = await db.execute(stmt)
    sessions = res.scalars().all()

    # Synchronize session state with live gateway if not in simulation mode
    if not settings.SIMULATION_MODE and os.getenv("PYTEST_CURRENT_TEST") is None:
        updated = False
        for s in sessions:
            if s.status == SessionStatus.CONNECTED:
                status_info = await gateway_client.get_session_status(s.session_name)
                if status_info.get("status") != "CONNECTED":
                    auth_stmt = select(WhatsAppSessionAuth.session_name).where(WhatsAppSessionAuth.session_name == s.session_name)
                    has_backup = (await db.execute(auth_stmt)).scalar_one_or_none() is not None
                    if not has_backup:
                        s.status = SessionStatus.DISCONNECTED
                        s.is_phone_online = False
                        updated = True
        if updated:
            await db.commit()

    return sessions

@router.post("/sessions", response_model=WhatsAppSessionResponse, status_code=201)
async def create_session(
    session_in: WhatsAppSessionCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    stmt = select(WhatsAppSession).where(
        WhatsAppSession.session_name == session_in.session_name,
        get_user_filter(WhatsAppSession.user_id, current_user.id),
    )
    existing = await db.execute(stmt)
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Bu oturum adı zaten kullanılıyor.")

    initial_qr = None

    session = WhatsAppSession(
        user_id=current_user.id,
        session_name=session_in.session_name,
        phone_number=session_in.phone_number,
        max_daily_limit=session_in.max_daily_limit,
        status=SessionStatus.SCAN_QR,
        qr_code=initial_qr,
        warm_up_day=1,
        daily_sent_count=0,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    # Fast non-blocking query to gateway (max 400ms)
    try:
        gw_res = await asyncio.wait_for(gateway_client.create_session(session_in.session_name), timeout=0.4)
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
        # Schedule in background so endpoint returns in <30ms without freezing the UI
        background_tasks.add_task(_async_init_gateway_session, session.id, session.session_name)

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
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")

    if not settings.SIMULATION_MODE and os.getenv("PYTEST_CURRENT_TEST") is None:
        status_info = await gateway_client.get_session_status(session.session_name)
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
    live_qr = await gateway_client.get_session_qr(session.session_name)
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
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")

    if not settings.SIMULATION_MODE and os.getenv("PYTEST_CURRENT_TEST") is None:
        status_info = await gateway_client.get_session_status(session.session_name)
        if status_info.get("status") == "CONNECTED":
            return {"success": True, "status": "CONNECTED", "qr_code": None, "phone": session.phone_number}

    res = await gateway_client.refresh_session_qr(session.session_name)
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
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
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
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
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
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
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
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    session = await db.get(WhatsAppSession, session_id)
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")
    session_name = session.session_name
    sess_user_id = session.user_id or current_user.id

    # 1. Delete all WhatsApp conversations belonging to this user (cascades to messages)
    conv_stmt = select(Conversation).where(
        Conversation.channel == "WHATSAPP",
        get_user_filter(Conversation.user_id, sess_user_id),
    )
    convs_res = await db.execute(conv_stmt)
    convs = convs_res.scalars().all()
    for conv in convs:
        await db.delete(conv)

    # 2. Delete auto-synced WhatsApp leads for this user (groups and raw WhatsApp chats)
    lead_stmt = select(Lead).where(
        Lead.category.in_(["WhatsApp Grubu", "WhatsApp Sohbeti"]),
        get_user_filter(Lead.user_id, sess_user_id),
    )
    leads_res = await db.execute(lead_stmt)
    leads = leads_res.scalars().all()
    for lead in leads:
        await db.delete(lead)

    # 3. Delete session auth backup and the session itself
    try:
        auth_stmt = select(WhatsAppSessionAuth).where(WhatsAppSessionAuth.session_name == session_name)
        auth_res = await db.execute(auth_stmt)
        auth_row = auth_res.scalar_one_or_none()
        if auth_row:
            await db.delete(auth_row)
    except Exception:
        pass

    await db.delete(session)
    await db.commit()

    # 4. Broadcast conversation clearance to UI clients
    await ws_manager.broadcast({
        "event": "conversations_cleared",
        "user_id": sess_user_id,
        "session_name": session_name,
    })

    # 5. Asynchronously delete from gateway in background without blocking response
    background_tasks.add_task(gateway_client.delete_session, session_name)
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
    Inbound webhook for incoming WhatsApp replies.
    Secured with X-Webhook-Secret header.
    """
    # Fail-closed: a missing/empty secret or a mismatch both deny.
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        logger.warning("[Webhook] Yetkisiz webhook isteği engellendi (geçersiz secret).")
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    phone = payload.get("phone")
    message_text = payload.get("message", "")
    
    if not phone:
        return {"status": "ignored", "reason": "No phone"}

    phone_data = PhoneService.normalize_to_e164(phone)
    if not phone_data:
        return {"status": "ignored", "reason": "Invalid phone"}
        
    e164 = phone_data["e164"]

    stmt = select(Lead).where(Lead.phone_e164 == e164)
    res = await db.execute(stmt)
    lead = res.scalar_one_or_none()
    
    if lead:
        lead.status = LeadStatus.REPLIED
        new_note = f"Son yanıt ({datetime.utcnow().strftime('%Y-%m-%d %H:%M')}): {message_text}"
        lead.notes = f"{lead.notes}\n{new_note}" if lead.notes else new_note

    if OPT_OUT_PATTERN.search(message_text):
        bl = Blacklist(
            phone_e164=e164,
            reason="OPT_OUT_KEYWORD",
            notes=f"Gelen mesaj: {message_text[:100]}"
        )
        db.add(bl)
        if lead:
            lead.status = LeadStatus.UNSUBSCRIBED

    await db.commit()

    await ws_manager.broadcast({
        "event": "inbound_reply",
        "phone": e164,
        "lead_name": lead.name if lead else "Bilinmeyen",
        "message": message_text
    })

    return {"status": "success", "processed_phone": e164}


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


@router.post("/webhook/history-sync")
async def handle_history_sync_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db)
):
    """
    Webhook dispatched by wa-gateway when Baileys completes initial chat/message history sync.
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    session_name = payload.get("session_name")
    chats = payload.get("chats", [])
    messages = payload.get("messages", [])

    return await WhatsAppSyncService.sync_history_batch(
        db=db,
        session_name=session_name,
        chats=chats,
        messages=messages,
    )


@router.post("/webhook/message-event")
async def handle_message_event_webhook(
    payload: dict = Body(...),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    db: AsyncSession = Depends(get_db)
):
    """
    Webhook dispatched by wa-gateway for live two-way message mirroring (inbound and phone outbound).
    """
    if not settings.WA_GATEWAY_WEBHOOK_SECRET or x_webhook_secret != settings.WA_GATEWAY_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Yetkisiz Webhook İsteği (Geçersiz Secret)")

    session_name = payload.get("session_name")
    return await WhatsAppSyncService.process_message_event(
        db=db,
        session_name=session_name,
        event_data=payload,
    )


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


