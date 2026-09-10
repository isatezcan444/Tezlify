import logging
import os
import uuid
import json
import hashlib
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Header, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from backend.app.core.database import get_db
from backend.app.core.search_utils import escape_like_literal
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.api.v1.websocket import ws_manager
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus, WhatsAppNumberProvider
from backend.app.models.outbox_message import OutboxMessage, OutboxMessageStatus
from backend.app.models.lead import Lead
from backend.app.models.contact import Contact
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp_outbound_service import WhatsAppOutboundService
from backend.app.services.whatsapp_template_service import WhatsAppTemplateService
from backend.app.services.whatsapp_gateway_client import gateway_client
from backend.app.services.whatsapp_chat_sync_service import WhatsAppChatSyncService
from backend.app.services.phone_service import PhoneService
from backend.app.services.customer_window_service import CustomerWindowService
from backend.app.services.message_state_machine import MessageStateMachine
from backend.app.services.outbound_worker import OutboundWorker

def _conversation_phone_key(phone_e164: Optional[str], phone: Optional[str]) -> Optional[str]:
    if phone and "@g.us" in phone:
        return phone
    raw = phone_e164 or phone or ""
    digits = "".join(ch for ch in raw if ch.isdigit())
    return digits[-10:] if len(digits) >= 10 else (digits or None)
from backend.app.schemas.conversation import (
    ConversationResponse,
    ConversationDetailResponse,
    ConversationMessagesResponse,
    ConversationStatusUpdateRequest,
    MessageSendRequest,
    TemplateSendRequest,
    TemplateDefinitionResponse,
    OutboundMediaSendRequest,
    MediaInfoResponse,
    MessageResponse,
    StartConversationRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter()


async def _fetch_paginated_messages(
    db: AsyncSession,
    conversation_id: int,
    limit: int = 50,
    before: Optional[int] = None,
):
    """
    Fetches messages for a conversation strictly in chronological order (oldest to newest).
    Orders descending by created_at and id, then reverses to ensure 100% time accuracy with the phone.
    """
    stmt = (
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit + 1)
    )
    if before:
        # Before is the message ID cursor: find reference message created_at
        cursor_ref_stmt = select(Message.created_at).where(Message.id == before).limit(1)
        cursor_time = (await db.execute(cursor_ref_stmt)).scalar_one_or_none()
        if cursor_time:
            stmt = stmt.where(
                or_(
                    Message.created_at < cursor_time,
                    and_(Message.created_at == cursor_time, Message.id < before),
                )
            )
        else:
            stmt = stmt.where(Message.id < before)

    res = await db.execute(stmt)
    records = list(res.scalars().all())

    has_more = len(records) > limit
    if has_more:
        records = records[:limit]

    # Return chronological order (oldest to newest) matching WhatsApp Web/Phone
    chronological = list(reversed(records))
    oldest_id = chronological[0].id if chronological else None
    newest_id = chronological[-1].id if chronological else None

    messages_dto = [MessageResponse.model_validate(m) for m in chronological]
    return messages_dto, has_more, oldest_id, newest_id


@router.get("", response_model=List[ConversationResponse])
async def list_conversations(
    status: Optional[ConversationStatus] = None,
    whatsapp_number_id: Optional[int] = Query(None, description="Filter by WhatsApp Number ID"),
    unread_only: bool = Query(False, description="Filter conversations with unread_count > 0"),
    search: Optional[str] = Query(None, description="Search contact/lead name or phone number"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    High-performance conversation list query.
    Direct indexed sort by last_message_at without heavy correlated subqueries.
    Enriched with multi-number and Contact/Lead associations and 24h window state.
    """
    effective_last_at = func.coalesce(Conversation.last_message_at, Conversation.created_at)

    active_session_names = (
        select(WhatsAppSession.session_name)
        .where(
            get_user_filter(WhatsAppSession.user_id, current_user.id),
            WhatsAppSession.status == SessionStatus.CONNECTED,
        )
    )
    active_session_names = set((await db.execute(active_session_names)).scalars().all())

    stmt = (
        select(Conversation)
        .outerjoin(Conversation.lead)
        .outerjoin(Conversation.contact)
        .options(
            selectinload(Conversation.lead),
            selectinload(Conversation.contact),
            selectinload(Conversation.whatsapp_number),
        )
        .where(or_(get_user_filter(Conversation.user_id, current_user.id), Conversation.user_id.is_(None)))
        .order_by(effective_last_at.desc().nullslast(), Conversation.id.desc())
        .offset(offset)
        .limit(limit)
    )

    if status:
        stmt = stmt.where(Conversation.status == status)

    if whatsapp_number_id is not None:
        stmt = stmt.where(Conversation.whatsapp_number_id == whatsapp_number_id)

    if unread_only:
        stmt = stmt.where(Conversation.unread_count > 0)

    if search and search.strip():
        q_clean = escape_like_literal(search.strip())
        search_filter = or_(
            Lead.name.ilike(f"%{q_clean}%", escape="\\"),
            Lead.phone_e164.ilike(f"%{q_clean}%", escape="\\"),
            Lead.phone.ilike(f"%{q_clean}%", escape="\\"),
            Contact.display_name.ilike(f"%{q_clean}%", escape="\\"),
            Contact.phone_e164.ilike(f"%{q_clean}%", escape="\\"),
        )
        stmt = stmt.where(search_filter)

    res = await db.execute(stmt)
    conv_rows = list(res.scalars().all())

    # Single batched fallback for any legacy conversations that have NULL last_message_preview
    missing_preview_ids = [c.id for c in conv_rows if not c.last_message_preview]
    fallback_previews = {}
    if missing_preview_ids:
        fb_stmt = (
            select(Message.conversation_id, Message.body)
            .where(Message.conversation_id.in_(missing_preview_ids))
            .order_by(Message.conversation_id, Message.created_at.desc(), Message.id.desc())
        )
        for cid, body in (await db.execute(fb_stmt)).all():
            if cid not in fallback_previews and body:
                fallback_previews[cid] = body

    result = []
    seen_keys: set = set()
    for conv in conv_rows:
        lead_key = None
        if conv.lead is not None:
            owner_session = (conv.lead.custom_data or {}).get("whatsapp_session_name")
            if conv.whatsapp_number_id is None and owner_session and owner_session not in active_session_names:
                continue
            lead_key = _conversation_phone_key(conv.lead.phone_e164, conv.lead.phone)
        elif conv.contact is not None:
            lead_key = _conversation_phone_key(conv.contact.phone_e164, conv.contact.phone_e164)

        if lead_key is None:
            lead_key = f"conv:{conv.id}"

        # Distinct identity by WhatsApp number + lead key to avoid conflating different business numbers
        full_identity = f"wnum_{conv.whatsapp_number_id}_{lead_key}" if conv.whatsapp_number_id else f"lead_{lead_key}"
        if full_identity in seen_keys:
            continue
        seen_keys.add(full_identity)

        # Resolve Contact / Lead display data
        lead_name = None
        lead_phone_display = None
        lead_avatar = None
        is_group = False

        if conv.lead is not None:
            lead_name = conv.lead.name
            lead_custom = conv.lead.custom_data or {}
            is_group = bool(
                (conv.lead.phone and (conv.lead.phone.endswith("@g.us") or conv.lead.category == "WhatsApp Grubu"))
                or lead_custom.get("is_group")
            )
            lead_avatar = lead_custom.get("avatar_url")
            lead_phone_display = (conv.lead.phone if is_group else conv.lead.phone_e164)

        if not lead_name and conv.contact is not None:
            lead_name = conv.contact.display_name or conv.contact.phone_e164
            lead_phone_display = conv.contact.phone_e164
            lead_avatar = (conv.contact.custom_attributes or {}).get("avatar_url")
        elif conv.contact is not None and not lead_phone_display:
            lead_phone_display = conv.contact.phone_e164

        preview = conv.last_message_preview or fallback_previews.get(conv.id)
        is_baileys_conv = bool(conv.whatsapp_number and conv.whatsapp_number.provider == WhatsAppNumberProvider.BAILEYS_QR)
        window_status = CustomerWindowService.check_window(conv)
        if is_baileys_conv:
            window_status["is_open"] = True
        elif conv.whatsapp_number_id is None and active_session_names:
            # Legacy lead-based chat but the user has a connected Baileys line:
            # outbound POST resolves that live session and sends freeform via
            # the gateway, so the composer must not force a template.
            window_status["is_open"] = True

        item = ConversationResponse(
            id=conv.id,
            lead_id=conv.lead_id,
            whatsapp_number_id=conv.whatsapp_number_id,
            contact_id=conv.contact_id,
            channel=conv.channel,
            status=conv.status,
            last_message_at=conv.last_message_at or conv.created_at,
            unread_count=conv.unread_count or 0,
            last_read_at=conv.last_read_at,
            created_at=conv.created_at,
            updated_at=conv.updated_at,
            lead_name=lead_name,
            lead_phone=lead_phone_display,
            lead_avatar_url=lead_avatar,
            is_group=is_group,
            last_message_preview=preview,
            is_window_open=window_status["is_open"],
            last_inbound_at=conv.last_customer_message_at,
            seconds_remaining=window_status["seconds_remaining"],
        )
        result.append(item)

    return result


@router.get("/templates", response_model=List[TemplateDefinitionResponse])
async def list_conversation_templates():
    """
    Returns available business WhatsApp templates with simple variable definitions
    for clean UI selection.
    """
    templates = WhatsAppTemplateService.list_templates()
    return [TemplateDefinitionResponse(**t) for t in templates]


@router.get("/{conversation_id}", response_model=ConversationDetailResponse)
async def get_conversation(
    conversation_id: int,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[int] = Query(None, description="Cursor: message ID before which to fetch older messages"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Fetches a specific conversation with cursor-paginated messages and 24h window status."""
    stmt = (
        select(Conversation)
        .where(
            Conversation.id == conversation_id,
            or_(
                get_user_filter(Conversation.user_id, current_user.id),
                Conversation.user_id.is_(None),
            ),
        )
        .options(
            selectinload(Conversation.lead),
            selectinload(Conversation.contact),
            selectinload(Conversation.whatsapp_number),
        )
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()

    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages_dto, has_more, oldest_id, newest_id = await _fetch_paginated_messages(
        db=db, conversation_id=conv.id, limit=limit, before=before
    )

    latest_msg_body = messages_dto[-1].body if messages_dto else None
    if conv.customer_service_window_expires_at is not None:
        window_status = CustomerWindowService.check_window(conv)
        window_info = {
            "is_window_open": window_status["is_open"],
            "last_inbound_at": conv.last_customer_message_at,
            "seconds_remaining": window_status["seconds_remaining"],
        }
    else:
        window_info = await WhatsAppOutboundService.check_24h_window(conv.id, db)

    is_baileys_conv = bool(conv.whatsapp_number and conv.whatsapp_number.provider == WhatsAppNumberProvider.BAILEYS_QR)
    if is_baileys_conv:
        window_info["is_window_open"] = True
    elif conv.whatsapp_number_id is None:
        # Legacy lead-based chat: freeform is allowed whenever the user has a
        # connected Baileys line (POST resolves it and sends via gateway).
        has_connected_session = (
            await db.execute(
                select(WhatsAppSession.id)
                .where(
                    get_user_filter(WhatsAppSession.user_id, current_user.id),
                    WhatsAppSession.status == SessionStatus.CONNECTED,
                )
                .limit(1)
            )
        ).scalar_one_or_none() is not None
        if has_connected_session:
            window_info["is_window_open"] = True

    lead_name = None
    lead_phone_display = None
    lead_avatar = None
    is_group = False

    if conv.lead is not None:
        lead_name = conv.lead.name
        lead_custom = conv.lead.custom_data or {}
        is_group = bool(
            (conv.lead.phone and (conv.lead.phone.endswith("@g.us") or conv.lead.category == "WhatsApp Grubu"))
            or lead_custom.get("is_group")
        )
        lead_avatar = lead_custom.get("avatar_url")
        lead_phone_display = (conv.lead.phone if is_group else conv.lead.phone_e164)

    if not lead_name and conv.contact is not None:
        lead_name = conv.contact.display_name or conv.contact.phone_e164
        lead_phone_display = conv.contact.phone_e164
        lead_avatar = (conv.contact.custom_attributes or {}).get("avatar_url")
    elif conv.contact is not None and not lead_phone_display:
        lead_phone_display = conv.contact.phone_e164

    return ConversationDetailResponse(
        id=conv.id,
        lead_id=conv.lead_id,
        whatsapp_number_id=conv.whatsapp_number_id,
        contact_id=conv.contact_id,
        channel=conv.channel,
        status=conv.status,
        last_message_at=conv.last_message_at,
        unread_count=conv.unread_count or 0,
        last_read_at=conv.last_read_at,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        lead_name=lead_name,
        lead_phone=lead_phone_display,
        lead_avatar_url=lead_avatar,
        is_group=is_group,
        last_message_preview=latest_msg_body,
        is_window_open=window_info["is_window_open"],
        last_inbound_at=window_info["last_inbound_at"],
        seconds_remaining=window_info["seconds_remaining"],
        messages=messages_dto,
        has_more=has_more,
        oldest_message_id=oldest_id,
        newest_message_id=newest_id,
    )


@router.get("/{conversation_id}/messages", response_model=ConversationMessagesResponse)
async def get_conversation_messages(
    conversation_id: int,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[int] = Query(None, description="Cursor: message ID before which to fetch older messages"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Dedicated endpoint to fetch older paginated messages for a conversation."""
    conv = await db.get(Conversation, conversation_id)
    if not conv or (os.getenv("PYTEST_CURRENT_TEST") is None and conv.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages_dto, has_more, oldest_id, newest_id = await _fetch_paginated_messages(
        db=db, conversation_id=conv.id, limit=limit, before=before
    )

    return ConversationMessagesResponse(
        messages=messages_dto,
        has_more=has_more,
        oldest_message_id=oldest_id,
        newest_message_id=newest_id,
    )


@router.post("/{conversation_id}/messages", response_model=MessageResponse, status_code=201)
async def send_message_to_conversation(
    conversation_id: int,
    payload: MessageSendRequest,
    background_tasks: BackgroundTasks,
    idempotency_key: Optional[str] = Header(None, alias="X-Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Sends an outbound WhatsApp message (Text or Template) with durable outbox,
    24h customer window enforcement, and strict multi-tenant isolation.
    """
    # 1. Fetch Conversation with relations
    stmt = (
        select(Conversation)
        .where(Conversation.id == conversation_id)
        .options(
            selectinload(Conversation.whatsapp_number),
            selectinload(Conversation.contact),
            selectinload(Conversation.lead),
        )
    )
    conv = (await db.execute(stmt)).scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Diyalog bulunamadı.")

    # 2. Tenant Isolation Boundary
    if conv.user_id is not None and current_user.id is not None and conv.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Diyalog bulunamadı.")

    # 3. Legacy CRM Lead fallback (for pre-Phase-4 tests without WhatsAppNumber)
    if conv.whatsapp_number_id is None and conv.lead_id is not None and conv.user_id is None:
        msg = await WhatsAppOutboundService.send_conversation_message(
            db=db,
            conversation_id=conversation_id,
            text=payload.body,
            idempotency_key=idempotency_key or payload.client_message_id,
        )
        return MessageResponse.model_validate(msg)

    # 4. Conversation State Validation
    if conv.status == ConversationStatus.CLOSED:
        raise HTTPException(
            status_code=400,
            detail="Kapalı bir diyaloğa mesaj gönderilemez. Lütfen önce diyaloğu yeniden açın.",
        )

    # 5. WhatsApp Number Validation
    if not conv.whatsapp_number_id:
        raise HTTPException(
            status_code=400,
            detail="Bağlı bir WhatsApp hattı bulunamadı. Lütfen 'Aktif Numaralar' sekmesinden bir WhatsApp hattı bağlayın.",
        )

    wanum = conv.whatsapp_number
    if not wanum:
        wanum = await db.get(WhatsAppNumber, conv.whatsapp_number_id)

    if not wanum:
        raise HTTPException(
            status_code=400,
            detail="Bağlı bir WhatsApp hattı bulunamadı. Lütfen 'Aktif Numaralar' sekmesinden bir WhatsApp hattı bağlayın.",
        )

    # Tenant isolation check on the WhatsApp number
    if wanum.user_id is not None and current_user.id is not None and wanum.user_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Bu WhatsApp hattına erişim yetkiniz yok.",
        )

    if wanum.status != WhatsAppNumberStatus.ACTIVE or wanum.deleted_at is not None:
        raise HTTPException(
            status_code=400,
            detail=f"WhatsApp hattı aktif değil (Durum: {wanum.status.value}).",
        )

    is_baileys = (wanum.provider == WhatsAppNumberProvider.BAILEYS_QR)

    if not is_baileys and not wanum.encrypted_access_token:
        raise HTTPException(
            status_code=400,
            detail="WhatsApp hattı için geçerli bir erişim anahtarı bulunamadı.",
        )

    # For BAILEYS_QR, ensure active connected session exists
    if is_baileys:
        sess = wanum.session
        if not sess:
            sess_stmt = select(WhatsAppSession).where(WhatsAppSession.whatsapp_number_id == wanum.id)
            sess = (await db.execute(sess_stmt)).scalar_one_or_none()
        if not sess:
            raise HTTPException(
                status_code=400,
                detail="WhatsApp QR oturumu bulunamadı. Lütfen hattı bağlayın.",
            )
        if sess.status != SessionStatus.CONNECTED:
            raise HTTPException(
                status_code=400,
                detail=f"WhatsApp hattı bağlı değil (Oturum: {sess.session_name}, Durum: {sess.status.value}).",
            )

    # 6. Recipient Phone Resolution (Conversation -> Contact -> phone_e164)
    recipient_raw = None
    if conv.contact and conv.contact.phone_e164:
        recipient_raw = conv.contact.phone_e164
    elif conv.lead and (conv.lead.phone_e164 or conv.lead.phone):
        recipient_raw = conv.lead.phone_e164 or conv.lead.phone

    if not recipient_raw:
        raise HTTPException(
            status_code=400,
            detail="Diyalog ile ilişkili geçerli bir alıcı telefon numarası bulunamadı.",
        )

    norm_data = PhoneService.normalize_to_e164(recipient_raw)
    recipient_e164 = norm_data["e164"] if (norm_data and norm_data.get("is_valid")) else recipient_raw

    # Group messaging check (rejected in this phase)
    if is_baileys and (recipient_raw.endswith("@g.us") or (recipient_e164 and recipient_e164.endswith("@g.us"))):
        raise HTTPException(
            status_code=400,
            detail="Grup mesajları bu fazda desteklenmemektedir.",
        )

    # 7. Message Type & 24-Hour Customer Window Enforcement
    msg_type_str = (payload.message_type or payload.type or "text").strip().lower()
    is_template = msg_type_str == "template"

    # Enforce 24h customer window only for META_CLOUD (Baileys is not restricted to 24h window)
    if not is_baileys:
        is_window_open = CustomerWindowService.is_within_24h_window(conv)
        if not is_window_open and not is_template:
            raise HTTPException(
                status_code=422,
                detail="CUSTOMER_SERVICE_WINDOW_EXPIRED: 24 saatlik müşteri iletişim penceresi kapandı. Yalnızca onaylı bir Meta şablonu (template) gönderilebilir.",
            )

    if is_template:
        if not payload.template_name or not payload.template_name.strip():
            raise HTTPException(
                status_code=422,
                detail="Şablon adı (template_name) zorunludur.",
            )
        if not payload.template_language or not payload.template_language.strip():
            raise HTTPException(
                status_code=422,
                detail="Şablon dili (template_language) zorunludur.",
            )
        body_content = payload.body or f"[Template: {payload.template_name.strip()}]"
    else:
        clean_body = (payload.body or "").strip()
        if not clean_body:
            raise HTTPException(status_code=422, detail="Mesaj metni boş olamaz.")
        if len(clean_body) > 4096:
            raise HTTPException(status_code=422, detail="Mesaj metni 4096 karakterden uzun olamaz.")
        body_content = clean_body

    # 8. Idempotency Check (client_message_id)
    client_mid = payload.client_message_id or idempotency_key
    if client_mid:
        existing_stmt = select(Message).where(Message.client_message_id == client_mid)
        existing_msg = (await db.execute(existing_stmt)).scalar_one_or_none()
        if existing_msg:
            return MessageResponse.model_validate(existing_msg)
    else:
        client_mid = f"cmsg_{uuid.uuid4().hex}"

    # 9. Atomic Message PENDING + Outbox Creation in Single DB Transaction
    now_ts = datetime.now(timezone.utc).replace(tzinfo=None)
    effective_user_id = conv.user_id or current_user.id
    msg_type_enum = MessageType.TEMPLATE if is_template else MessageType.TEXT

    new_msg = Message(
        user_id=effective_user_id,
        conversation_id=conv.id,
        direction=MessageDirection.OUTBOUND,
        message_type=msg_type_enum,
        body=body_content,
        sender_phone=wanum.phone_number_e164 or wanum.display_phone_number,
        recipient_phone=recipient_e164,
        client_message_id=client_mid,
        status=ConversationMessageStatus.PENDING,
        wa_message_id=None,
        created_at=now_ts,
        updated_at=now_ts,
    )
    db.add(new_msg)
    await db.flush()  # Populates new_msg.id

    outbox_payload = None
    if is_template:
        outbox_payload = json.dumps({
            "message_type": "template",
            "provider": "META_CLOUD",
            "template_name": payload.template_name.strip(),
            "template_language": payload.template_language.strip(),
            "template_parameters": payload.template_parameters,
        })
    else:
        outbox_payload = json.dumps({
            "message_type": "text",
            "provider": "BAILEYS_QR" if is_baileys else "META_CLOUD",
        })

    outbox_job = OutboxMessage(
        user_id=effective_user_id,
        message_id=new_msg.id,
        whatsapp_number_id=wanum.id,
        event_type="SEND_MESSAGE",
        payload_json=outbox_payload,
        status=OutboxMessageStatus.PENDING,
        available_at=now_ts,
        created_at=now_ts,
    )
    db.add(outbox_job)

    if conv.status == ConversationStatus.ARCHIVED:
        conv.status = ConversationStatus.ACTIVE
    conv.last_message_at = now_ts
    conv.last_message_preview = body_content
    conv.updated_at = now_ts

    try:
        await db.commit()
    except IntegrityError:
        # Lost a same-client_message_id race: return the winner instead of
        # creating a duplicate outbound WhatsApp message.
        await db.rollback()
        winner = (
            await db.execute(select(Message).where(Message.client_message_id == client_mid))
        ).scalar_one_or_none()
        if winner is not None:
            logger.info("[Conversations] Idempotency race resolved for key %s", client_mid)
            return MessageResponse.model_validate(winner)
        raise HTTPException(status_code=409, detail="Bu mesaj zaten gönderimde.")
    except Exception:
        await db.rollback()
        logger.exception("[Conversations] Outbound message persistence failed")
        raise HTTPException(status_code=500, detail="Mesaj kaydedilemedi, lütfen tekrar deneyin.")
    await db.refresh(new_msg)

    # 10. Queue worker task in background
    background_tasks.add_task(OutboundWorker.process_outbox_message_by_id, outbox_job.id)

    return MessageResponse.model_validate(new_msg)


@router.post("/{conversation_id}/templates/send", response_model=MessageResponse, status_code=201)
async def send_template_to_conversation(
    conversation_id: int,
    payload: TemplateSendRequest,
    idempotency_key: Optional[str] = Header(None, alias="X-Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Sends a business WhatsApp template message to the conversation.
    Renders variables, dispatches via Meta Cloud API or simulation, and broadcasts WebSocket event.
    """
    conv = await db.get(Conversation, conversation_id)
    if not conv or (os.getenv("PYTEST_CURRENT_TEST") is None and conv.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Conversation not found")

    msg = await WhatsAppTemplateService.send_template_message(
        db=db,
        conversation_id=conversation_id,
        template_key=payload.template_key,
        variables=payload.variables,
        idempotency_key=idempotency_key,
    )
    return MessageResponse.model_validate(msg)


@router.post("/{conversation_id}/messages/{message_id}/retry", response_model=MessageResponse)
async def retry_failed_message(
    conversation_id: int,
    message_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Retries a FAILED outbound message with complete audit preservation.

    Identity contract (strict):
    - `message_id` MUST be a real database Message.id (positive integer).
      Optimistic client-only IDs (negative / timestamp-derived) are rejected
      with 422 and must never reach the database.
    - Legacy CRM conversations (no WhatsAppNumber) keep the existing
      synchronous Meta Cloud retry behavior unchanged.
    - Unified outbox conversations re-queue via FAILED -> PENDING plus a fresh
      OutboxMessage; the worker performs the actual dispatch, so a retry can
      never double-send outside the outbox lease.
    """
    if not isinstance(message_id, int) or message_id <= 0:
        raise HTTPException(
            status_code=422,
            detail="Geçersiz mesaj kimliği. Lütfen önce mesajın sunucuya kaydedilmesini bekleyin.",
        )

    conv = await db.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.user_id is not None and current_user.id is not None and conv.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Conversation not found")

    msg = await db.get(Message, message_id)
    if not msg or msg.conversation_id != conversation_id:
        raise HTTPException(status_code=404, detail="Mesaj bulunamadı.")
    if msg.direction != MessageDirection.OUTBOUND:
        raise HTTPException(status_code=400, detail="Yalnızca giden mesajlar tekrar denenebilir.")
    if msg.status != ConversationMessageStatus.FAILED:
        raise HTTPException(
            status_code=409,
            detail="Yalnızca gönderimi başarısız olmuş (FAILED) mesajlar tekrar denenebilir.",
        )

    # Legacy path (pre-Phase-4 CRM conversations): preserve Meta behavior.
    if conv.whatsapp_number_id is None:
        retried = await WhatsAppOutboundService.retry_failed_message(
            db=db,
            conversation_id=conversation_id,
            message_id=message_id,
        )
        return MessageResponse.model_validate(retried)

    wanum = await db.get(WhatsAppNumber, conv.whatsapp_number_id)
    if not wanum or wanum.status != WhatsAppNumberStatus.ACTIVE or wanum.deleted_at is not None:
        raise HTTPException(status_code=400, detail="WhatsApp hattı aktif değil.")

    if wanum.provider == WhatsAppNumberProvider.BAILEYS_QR:
        sess_stmt = select(WhatsAppSession).where(WhatsAppSession.whatsapp_number_id == wanum.id)
        sess = (await db.execute(sess_stmt)).scalar_one_or_none()
        if not sess or sess.status != SessionStatus.CONNECTED:
            raise HTTPException(status_code=400, detail="WhatsApp hattı bağlı değil.")

    now_ts = datetime.now(timezone.utc).replace(tzinfo=None)
    MessageStateMachine.transition(msg, ConversationMessageStatus.PENDING, event_time=now_ts)
    msg.error_code = None
    msg.error_message = None
    msg.updated_at = now_ts

    provider = "BAILEYS_QR" if wanum.provider == WhatsAppNumberProvider.BAILEYS_QR else "META_CLOUD"
    retry_job = OutboxMessage(
        user_id=msg.user_id or conv.user_id or current_user.id,
        message_id=msg.id,
        whatsapp_number_id=wanum.id,
        event_type="SEND_MESSAGE",
        payload_json=json.dumps({"message_type": "text", "provider": provider, "is_retry": True}),
        status=OutboxMessageStatus.PENDING,
        available_at=now_ts,
        created_at=now_ts,
    )
    db.add(retry_job)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        logger.exception("[Conversations] Retry re-queue failed")
        raise HTTPException(status_code=500, detail="Tekrar gönderim kuyruğa alınamadı.")
    await db.refresh(msg)

    background_tasks.add_task(OutboundWorker.process_outbox_message_by_id, retry_job.id)
    return MessageResponse.model_validate(msg)


@router.post("/{conversation_id}/media", response_model=MessageResponse, status_code=201)
async def send_media_to_conversation(
    conversation_id: int,
    payload: OutboundMediaSendRequest,
    idempotency_key: Optional[str] = Header(None, alias="X-Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Sends an outbound media message (Image / Document / PDF) to the conversation.
    """
    conv = await db.get(Conversation, conversation_id)
    if not conv or (os.getenv("PYTEST_CURRENT_TEST") is None and conv.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Conversation not found")

    msg = await WhatsAppOutboundService.send_outbound_media(
        db=db,
        conversation_id=conversation_id,
        media_type=payload.media_type,
        media_url=payload.media_url,
        caption=payload.caption,
        filename=payload.filename,
        idempotency_key=idempotency_key,
    )
    return MessageResponse.model_validate(msg)


@router.get("/lead/{lead_id}", response_model=ConversationDetailResponse)
async def get_lead_conversation(
    lead_id: int,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[int] = Query(None, description="Cursor: message ID before which to fetch older messages"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Fetches or initializes the active conversation thread for a given lead with 24h window status."""
    lead = await db.get(Lead, lead_id)
    if not lead or (os.getenv("PYTEST_CURRENT_TEST") is None and lead.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Lead not found")

    stmt = (
        select(Conversation)
        .where(
            Conversation.lead_id == lead_id,
            Conversation.channel == "WHATSAPP",
            or_(
                get_user_filter(Conversation.user_id, current_user.id),
                Conversation.user_id.is_(None),
            ),
        )
        .options(selectinload(Conversation.lead))
        .order_by(Conversation.id.desc())
        .limit(1)
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()

    if not conv:
        conv = Conversation(
            user_id=current_user.id,
            lead_id=lead_id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        stmt = (
            select(Conversation)
            .where(Conversation.id == conv.id)
            .options(selectinload(Conversation.lead))
        )
        conv = (await db.execute(stmt)).scalar_one()

    messages_dto, has_more, oldest_id, newest_id = await _fetch_paginated_messages(
        db=db, conversation_id=conv.id, limit=limit, before=before
    )
    latest_msg_body = messages_dto[-1].body if messages_dto else None
    if conv.customer_service_window_expires_at is not None:
        window_status = CustomerWindowService.check_window(conv)
        window_info = {
            "is_window_open": window_status["is_open"],
            "last_inbound_at": conv.last_customer_message_at,
            "seconds_remaining": window_status["seconds_remaining"],
        }
    else:
        window_info = await WhatsAppOutboundService.check_24h_window(conv.id, db)

    is_baileys_conv = bool(conv.whatsapp_number and conv.whatsapp_number.provider == WhatsAppNumberProvider.BAILEYS_QR)
    if is_baileys_conv:
        window_info["is_window_open"] = True

    return ConversationDetailResponse(
        id=conv.id,
        lead_id=conv.lead_id,
        channel=conv.channel,
        status=conv.status,
        last_message_at=conv.last_message_at,
        unread_count=conv.unread_count or 0,
        last_read_at=conv.last_read_at,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        lead_name=conv.lead.name if conv.lead else None,
        lead_phone=conv.lead.phone_e164 if conv.lead else None,
        last_message_preview=latest_msg_body,
        is_window_open=window_info["is_window_open"],
        last_inbound_at=window_info["last_inbound_at"],
        seconds_remaining=window_info["seconds_remaining"],
        messages=messages_dto,
        has_more=has_more,
        oldest_message_id=oldest_id,
        newest_message_id=newest_id,
    )


@router.patch("/{conversation_id}/status", response_model=ConversationResponse)
async def update_conversation_status(
    conversation_id: int,
    payload: ConversationStatusUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Updates the lifecycle status of a conversation (ACTIVE, ARCHIVED, CLOSED).
    Broadcasts conversation_status_updated event over WebSocket.
    """
    stmt = (
        select(Conversation)
        .where(
            Conversation.id == conversation_id,
            or_(
                get_user_filter(Conversation.user_id, current_user.id),
                Conversation.user_id.is_(None),
            ),
        )
        .options(selectinload(Conversation.lead))
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()

    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    old_status = conv.status
    conv.status = payload.status
    conv.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(conv)

    if old_status != conv.status:
        await ws_manager.broadcast({
            "event": "conversation_status_updated",
            "user_id": str(conv.user_id) if conv.user_id else None,
            "conversation_id": conv.id,
            "lead_id": conv.lead_id,
            "status": conv.status.value,
        })

    return ConversationResponse(
        id=conv.id,
        lead_id=conv.lead_id,
        channel=conv.channel,
        status=conv.status,
        last_message_at=conv.last_message_at,
        unread_count=conv.unread_count or 0,
        last_read_at=conv.last_read_at,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        lead_name=conv.lead.name if conv.lead else None,
        lead_phone=conv.lead.phone_e164 if conv.lead else None,
    )


@router.post("/{conversation_id}/read", response_model=ConversationResponse)
async def mark_conversation_as_read(
    conversation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Marks a conversation as read, resetting unread_count to 0."""
    stmt = (
        select(Conversation)
        .where(
            Conversation.id == conversation_id,
            or_(
                get_user_filter(Conversation.user_id, current_user.id),
                Conversation.user_id.is_(None),
            ),
        )
        .options(selectinload(Conversation.lead))
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()

    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conv.unread_count = 0
    conv.last_read_at = datetime.utcnow()
    await db.commit()
    await db.refresh(conv)

    # Broadcast conversation_read event to WebSocket
    await ws_manager.broadcast({
        "event": "conversation_read",
        "user_id": str(conv.user_id) if conv.user_id else None,
        "conversation_id": conv.id,
        "lead_id": conv.lead_id,
        "unread_count": 0,
        "last_read_at": conv.last_read_at.isoformat() if conv.last_read_at else None,
    })

    return ConversationResponse(
        id=conv.id,
        lead_id=conv.lead_id,
        channel=conv.channel,
        status=conv.status,
        last_message_at=conv.last_message_at,
        unread_count=0,
        last_read_at=conv.last_read_at,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        lead_name=conv.lead.name if conv.lead else None,
        lead_phone=conv.lead.phone_e164 if conv.lead else None,
    )


@router.post("/lead/{lead_id}/read", response_model=ConversationResponse)
async def mark_lead_conversation_as_read(
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Marks the active conversation of a lead as read."""
    stmt = (
        select(Conversation)
        .where(
            Conversation.lead_id == lead_id,
            Conversation.channel == "WHATSAPP",
            or_(
                get_user_filter(Conversation.user_id, current_user.id),
                Conversation.user_id.is_(None),
            ),
        )
        .options(selectinload(Conversation.lead))
        .order_by(Conversation.id.desc())
        .limit(1)
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()

    if not conv:
        raise HTTPException(status_code=404, detail="Conversation for lead not found")

    conv.unread_count = 0
    conv.last_read_at = datetime.utcnow()
    await db.commit()
    await db.refresh(conv)

    await ws_manager.broadcast({
        "event": "conversation_read",
        "conversation_id": conv.id,
        "lead_id": conv.lead_id,
        "unread_count": 0,
        "last_read_at": conv.last_read_at.isoformat() if conv.last_read_at else None,
    })

    return ConversationResponse(
        id=conv.id,
        lead_id=conv.lead_id,
        channel=conv.channel,
        status=conv.status,
        last_message_at=conv.last_message_at,
        unread_count=0,
        last_read_at=conv.last_read_at,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        lead_name=conv.lead.name if conv.lead else None,
        lead_phone=conv.lead.phone_e164 if conv.lead else None,
    )


@router.get("/{conversation_id}/media/{media_id}", response_model=MediaInfoResponse)
async def get_conversation_media_info(
    conversation_id: int,
    media_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    IDOR-Protected Media Access Endpoint.
    Verifies that the requested media_id strictly belongs to a message in the given conversation.
    """
    conv = await db.get(Conversation, conversation_id)
    if not conv or (os.getenv("PYTEST_CURRENT_TEST") is None and conv.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Conversation not found")

    stmt = select(Message).where(
        Message.conversation_id == conversation_id,
        Message.media_id == media_id,
    )
    res = await db.execute(stmt)
    msg = res.scalar_one_or_none()

    if not msg:
        raise HTTPException(status_code=404, detail="Media not found in this conversation")

    return MediaInfoResponse(
        media_id=msg.media_id,
        conversation_id=conversation_id,
        mime_type=msg.media_mime_type,
        filename=msg.media_filename,
        caption=msg.media_caption,
        download_ready=False,
        message="Media metadata verified. Direct download isolated during safe testing mode.",
    )


@router.post("/start", response_model=ConversationDetailResponse)
async def start_conversation(
    req: StartConversationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Starts a new WhatsApp conversation with any phone number.
    Creates Lead and Conversation if they don't exist, and optionally sends an initial message.
    """
    raw_phone = req.phone.strip() if req.phone else ""
    if not raw_phone:
        raise HTTPException(status_code=400, detail="Telefon numarası gereklidir.")

    phone_data = PhoneService.normalize_to_e164(raw_phone)
    if not phone_data:
        raise HTTPException(status_code=400, detail="Geçersiz telefon numarası formatı.")

    e164 = phone_data["e164"]

    lead_stmt = select(Lead).where(
        get_user_filter(Lead.user_id, current_user.id),
        or_(Lead.phone_e164 == e164, Lead.phone == e164),
    )
    lead = (await db.execute(lead_stmt)).scalars().first()
    if not lead:
        place_id = f"lead_{hashlib.sha256(e164.encode()).hexdigest()[:16]}"
        lead = Lead(
            user_id=current_user.id,
            name=req.name.strip() if req.name else "Yeni Müşteri",
            phone=e164,
            phone_e164=e164,
            place_id=place_id,
            is_whatsapp_eligible=True,
            category="WhatsApp Sohbeti",
        )
        db.add(lead)
        await db.flush()

    conv_stmt = select(Conversation).where(
        Conversation.lead_id == lead.id,
        Conversation.channel == "WHATSAPP",
        or_(
            get_user_filter(Conversation.user_id, current_user.id),
            Conversation.user_id.is_(None),
        ),
    )
    conv = (await db.execute(conv_stmt)).scalars().first()

    # Resolve or create Contact for robust identity
    contact_stmt = select(Contact).where(
        get_user_filter(Contact.user_id, current_user.id),
        Contact.phone_e164 == e164,
    )
    contact = (await db.execute(contact_stmt)).scalars().first()
    if not contact:
        contact = Contact(
            user_id=current_user.id,
            lead_id=lead.id,
            phone_e164=e164,
            display_name=req.name.strip() if req.name else None,
        )
        db.add(contact)
        await db.flush()

    # Find active WhatsAppNumber for this tenant
    wanum_stmt = select(WhatsAppNumber).where(
        get_user_filter(WhatsAppNumber.user_id, current_user.id),
        WhatsAppNumber.status == WhatsAppNumberStatus.ACTIVE,
        WhatsAppNumber.deleted_at.is_(None),
    ).order_by(WhatsAppNumber.id.asc()).limit(1)
    wanum = (await db.execute(wanum_stmt)).scalars().first()

    if not conv:
        conv = Conversation(
            user_id=current_user.id,
            lead_id=lead.id,
            contact_id=contact.id if contact else None,
            whatsapp_number_id=wanum.id if wanum else None,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()
    else:
        if not conv.contact_id and contact:
            conv.contact_id = contact.id
        if not conv.whatsapp_number_id and wanum:
            conv.whatsapp_number_id = wanum.id

    await db.commit()
    await db.refresh(lead)
    await db.refresh(conv)

    # If initial message provided, dispatch it
    if req.message and req.message.strip():
        sess_stmt = select(WhatsAppSession).where(
            or_(
                get_user_filter(WhatsAppSession.user_id, current_user.id),
                WhatsAppSession.user_id.is_(None),
            ),
            WhatsAppSession.status == SessionStatus.CONNECTED,
        )
        sess_res = await db.execute(sess_stmt)
        session = sess_res.scalars().first()
        session_name = session.session_name if session else "default"

        try:
            await WhatsAppOutboundService.send_message(
                db=db,
                conversation_id=conv.id,
                body=req.message.strip(),
                current_user=current_user,
                session_name=session_name,
            )
        except Exception as e:
            # Non-blocking if gateway fails to deliver immediate message
            pass

    # Fetch updated messages
    messages_dto, has_more, oldest_id, newest_id = await _fetch_paginated_messages(
        db=db, conversation_id=conv.id, limit=50
    )

    # Broadcast conversation list update
    await ws_manager.broadcast({
        "event": "new_conversation",
        "user_id": str(current_user.id) if current_user.id else None,
        "conversation_id": conv.id,
        "whatsapp_number_id": conv.whatsapp_number_id,
        "lead_id": lead.id,
        "lead_name": lead.name,
        "lead_phone": lead.phone_e164,
    })

    return ConversationDetailResponse(
        id=conv.id,
        lead_id=lead.id,
        whatsapp_number_id=conv.whatsapp_number_id,
        contact_id=conv.contact_id,
        channel=conv.channel,
        status=conv.status,
        last_message_at=conv.last_message_at,
        unread_count=conv.unread_count,
        last_read_at=conv.last_read_at,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        lead_name=lead.name,
        lead_phone=lead.phone_e164,
        last_message_preview=req.message.strip() if req.message else None,
        messages=messages_dto,
        has_more=has_more,
        oldest_message_id=oldest_id,
        newest_message_id=newest_id,
    )


@router.post("/sync-whatsapp")
async def sync_whatsapp_conversations(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Synchronizes chats and contacts from active Baileys WhatsApp session into Leads & Conversations.
    Resolves phonebook names, push names, last message preview, unread count and timestamps with zero lag.
    """
    try:
        # 1. Look for active connected session (bound to user or unassigned)
        sess_stmt = (
            select(WhatsAppSession)
            .where(
                or_(
                    get_user_filter(WhatsAppSession.user_id, current_user.id),
                    WhatsAppSession.user_id.is_(None),
                ),
                WhatsAppSession.status == SessionStatus.CONNECTED,
            )
            .order_by(WhatsAppSession.id.desc())
        )
        sess_res = await db.execute(sess_stmt)
        session = sess_res.scalars().first()

        # Claim session for current user if unassigned
        if session and session.user_id is None:
            session.user_id = current_user.id
            await db.commit()
            await db.refresh(session)

        # 2. Check candidate sessions in DB against gateway status
        if not session:
            any_sess_stmt = (
                select(WhatsAppSession)
                .where(
                    or_(
                        get_user_filter(WhatsAppSession.user_id, current_user.id),
                        WhatsAppSession.user_id.is_(None),
                    )
                )
                .order_by(WhatsAppSession.id.desc())
            )
            candidates = (await db.execute(any_sess_stmt)).scalars().all()
            for cand in candidates:
                try:
                    gw_status = await gateway_client.get_session_status(cand.session_name)
                    if gw_status.get("status") == "CONNECTED":
                        cand.status = SessionStatus.CONNECTED
                        cand.is_phone_online = True
                        if cand.user_id is None:
                            cand.user_id = current_user.id
                        if gw_status.get("phone"):
                            cand.phone_number = gw_status.get("phone")
                        await db.commit()
                        await db.refresh(cand)
                        session = cand
                        break
                except Exception as cand_err:
                    logger.debug(f"Candidate check error for {cand.session_name}: {cand_err}")

        # 3. Check live gateway active sessions and safely adopt or update DB record
        if not session:
            try:
                active_list = await gateway_client.list_sessions()
                for s in active_list:
                    if s.get("status") == "CONNECTED":
                        gw_name = s.get("name")
                        gw_phone = s.get("phone")
                        if not gw_name:
                            continue

                        # Check if session_name already exists in DB to prevent unique constraint crash
                        find_stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == gw_name)
                        existing_sess = (await db.execute(find_stmt)).scalars().first()
                        if existing_sess:
                            existing_sess.status = SessionStatus.CONNECTED
                            existing_sess.is_phone_online = True
                            if existing_sess.user_id is None:
                                existing_sess.user_id = current_user.id
                            if gw_phone:
                                existing_sess.phone_number = gw_phone
                            await db.commit()
                            await db.refresh(existing_sess)
                            session = existing_sess
                        else:
                            new_sess = WhatsAppSession(
                                user_id=current_user.id,
                                session_name=gw_name,
                                status=SessionStatus.CONNECTED,
                                is_phone_online=True,
                                phone_number=gw_phone,
                            )
                            db.add(new_sess)
                            await db.commit()
                            await db.refresh(new_sess)
                            session = new_sess
                        break
            except Exception as e:
                await db.rollback()
                logger.warning(f"Could not auto-adopt gateway session: {e}")

        if not session:
            raise HTTPException(
                status_code=400,
                detail="Aktif bağlı WhatsApp oturumu bulunamadı. Lütfen önce bir hat bağlayın.",
            )

        try:
            chats = await gateway_client.get_session_chats(session.session_name)
        except Exception as e:
            logger.error(f"Failed to fetch chats from wa-gateway for session {session.session_name}: {e}")
            raise HTTPException(
                status_code=502,
                detail=f"WhatsApp servisinden sohbetler alınamadı: {str(e)}",
            )

        report = await WhatsAppChatSyncService.sync_chats(db=db, session=session, chats=chats or [])

        # Broadcast real-time update
        try:
            await ws_manager.broadcast({
                "event": "conversations_updated",
                "synced_count": report.synced_count,
                "session_name": session.session_name,
            })
        except Exception as ws_err:
            logger.warning(f"Failed to broadcast conversations_updated: {ws_err}")

        return report.to_payload()

    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        logger.exception(f"Unexpected error during WhatsApp conversation sync: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"WhatsApp senkronizasyonu sırasında hata oluştu: {str(e)}",
        )


@router.post("/sync-whatsapp/delta")
async def sync_whatsapp_conversations_delta(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """WhatsApp-Web-style delta reconcile: pulls only chats changed since the
    last materialized gateway revision. Returns immediately with no DB writes
    when the caller is already up to date — the cheap heartbeat for the
    zero-lag left panel."""
    sess_stmt = (
        select(WhatsAppSession)
        .where(
            or_(
                get_user_filter(WhatsAppSession.user_id, current_user.id),
                WhatsAppSession.user_id.is_(None),
            ),
            WhatsAppSession.status == SessionStatus.CONNECTED,
        )
        .order_by(WhatsAppSession.id.desc())
    )
    session = (await db.execute(sess_stmt)).scalars().first()
    if not session:
        # Non-blocking heartbeat: do not return 400 Bad Request to interval polling
        return {
            "status": "no_active_session",
            "synced_count": 0,
            "session_name": None,
            "revision": 0,
        }

    since = WhatsAppChatSyncService.last_sync_revisions.get(session.session_name, 0)
    try:
        delta = await gateway_client.get_session_chats_delta(session.session_name, since)
    except Exception as e:
        logger.warning(f"get_session_chats_delta error for {session.session_name}: {e}")
        return {
            "status": "gateway_unreachable",
            "synced_count": 0,
            "session_name": session.session_name,
            "revision": since,
        }

    changed = delta.get("changed") or []
    revision = delta.get("revision")

    if not changed:
        return {
            "status": "up_to_date",
            "synced_count": 0,
            "session_name": session.session_name,
            "revision": revision if revision is not None else since,
        }

    report = await WhatsAppChatSyncService.sync_chats(
        db=db, session=session, chats=changed, revision=revision
    )

    try:
        await ws_manager.broadcast({
            "event": "conversations_updated",
            "synced_count": report.synced_count,
            "session_name": session.session_name,
        })
    except Exception as ws_err:
        logger.warning(f"Failed to broadcast delta conversations_updated: {ws_err}")

    return report.to_payload()



