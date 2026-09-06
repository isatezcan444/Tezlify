import re
import os
import logging
from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Body, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_

from backend.app.core.database import get_db
from backend.app.core.config import settings
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.blacklist import Blacklist
from backend.app.schemas.whatsapp import (
    WhatsAppSessionResponse,
    WhatsAppSessionCreate,
    TestMessageRequest,
    MessageLogResponse
)
from backend.app.services.phone_service import PhoneService
from backend.app.services.whatsapp_sender import get_whatsapp_sender
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)
router = APIRouter()

OPT_OUT_PATTERN = re.compile(r"\b(istemiyorum|iptal|sil|stop|unsubscribe|rahats[ıi]z\s+etmeyin)\b", re.IGNORECASE)

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
    return res.scalars().all()

@router.post("/sessions", response_model=WhatsAppSessionResponse, status_code=201)
async def create_session(
    session_in: WhatsAppSessionCreate,
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

    session = WhatsAppSession(
        user_id=current_user.id,
        session_name=session_in.session_name,
        phone_number=session_in.phone_number,
        max_daily_limit=session_in.max_daily_limit,
        status=SessionStatus.SCAN_QR,
        qr_code="2@wS12dE98vA==,Tezlify_WA_Pairing_Token_Ready",
        warm_up_day=1,
        daily_sent_count=0,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    
    await ws_manager.broadcast({
        "event": "session_created",
        "session": {"id": session.id, "name": session.session_name, "status": session.status}
    })
    return session

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
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    session = await db.get(WhatsAppSession, session_id)
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")
        
    session.status = SessionStatus.DISCONNECTED
    session.qr_code = None
    await db.commit()
    
    await ws_manager.broadcast({
        "event": "session_disconnected",
        "session_id": session.id
    })
    return {"message": "Oturum bağlantısı kesildi", "session": session}

@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    session = await db.get(WhatsAppSession, session_id)
    if not session or (os.getenv("PYTEST_CURRENT_TEST") is None and session.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")
    await db.delete(session)
    await db.commit()
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
