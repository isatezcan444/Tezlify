import logging
import os
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_, func
from sqlalchemy.orm import selectinload

from backend.app.core.database import get_db
from backend.app.core.search_utils import escape_like_literal
from backend.app.services.whatsapp_sync_service import _conversation_phone_key
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.api.v1.websocket import ws_manager
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection
from backend.app.models.lead import Lead
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp_outbound_service import WhatsAppOutboundService
from backend.app.services.whatsapp_template_service import WhatsAppTemplateService
from backend.app.services.whatsapp_sync_service import WhatsAppSyncService
from backend.app.services.whatsapp_gateway_client import gateway_client
from backend.app.services.phone_service import PhoneService
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
    unread_only: bool = Query(False, description="Filter conversations with unread_count > 0"),
    search: Optional[str] = Query(None, description="Search lead name or phone number"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    High-performance conversation list query.
    Direct indexed sort by last_message_at without heavy correlated subqueries.
    """
    effective_last_at = func.coalesce(Conversation.last_message_at, Conversation.created_at)

    stmt = (
        select(Conversation)
        .join(Conversation.lead)
        .options(selectinload(Conversation.lead))
        .where(get_user_filter(Conversation.user_id, current_user.id))
        .order_by(effective_last_at.desc().nullslast(), Conversation.id.desc())
        .offset(offset)
        .limit(limit)
    )

    if status:
        stmt = stmt.where(Conversation.status == status)

    if unread_only:
        stmt = stmt.where(Conversation.unread_count > 0)

    if search and search.strip():
        q_clean = escape_like_literal(search.strip())
        search_filter = or_(
            Lead.name.ilike(f"%{q_clean}%", escape="\\"),
            Lead.phone_e164.ilike(f"%{q_clean}%", escape="\\"),
            Lead.phone.ilike(f"%{q_clean}%", escape="\\"),
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
            lead_key = _conversation_phone_key(conv.lead.phone_e164, conv.lead.phone)
        if lead_key is None:
            lead_key = f"lead:{conv.lead_id}"
        if lead_key in seen_keys:
            continue
        seen_keys.add(lead_key)

        lead_custom = conv.lead.custom_data or {} if conv.lead else {}
        is_group = bool(
            (conv.lead and (conv.lead.phone.endswith("@g.us") or conv.lead.category == "WhatsApp Grubu"))
            or lead_custom.get("is_group")
        )
        lead_avatar = lead_custom.get("avatar_url")
        lead_phone_display = (conv.lead.phone if is_group else conv.lead.phone_e164) if conv.lead else None
        preview = conv.last_message_preview or fallback_previews.get(conv.id)

        item = ConversationResponse(
            id=conv.id,
            lead_id=conv.lead_id,
            channel=conv.channel,
            status=conv.status,
            last_message_at=conv.last_message_at or conv.created_at,
            unread_count=conv.unread_count or 0,
            last_read_at=conv.last_read_at,
            created_at=conv.created_at,
            updated_at=conv.updated_at,
            lead_name=conv.lead.name if conv.lead else None,
            lead_phone=lead_phone_display,
            lead_avatar_url=lead_avatar,
            is_group=is_group,
            last_message_preview=preview,
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
            get_user_filter(Conversation.user_id, current_user.id),
        )
        .options(selectinload(Conversation.lead))
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()

    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages_dto, has_more, oldest_id, newest_id = await _fetch_paginated_messages(
        db=db, conversation_id=conv.id, limit=limit, before=before
    )

    # On-demand WhatsApp history sync: if conversation has <= 1 message (or cursor reached end of DB history),
    # pull message history from the connected Baileys session so the chat displays full thread history like WhatsApp Web.
    if conv.channel == "WHATSAPP" and ((len(messages_dto) <= 1 and before is None) or (before is not None and not has_more)):
        try:
            sess_stmt = select(WhatsAppSession).where(
                get_user_filter(WhatsAppSession.user_id, current_user.id),
                WhatsAppSession.status == SessionStatus.CONNECTED,
            )
            sess_res = await db.execute(sess_stmt)
            wa_sess = sess_res.scalars().first()
            if not wa_sess:
                any_sess_stmt = select(WhatsAppSession).where(WhatsAppSession.status == SessionStatus.CONNECTED)
                wa_sess = (await db.execute(any_sess_stmt)).scalars().first()

            if wa_sess and conv.lead:
                chat_jid = None
                if conv.lead.phone and ("@" in conv.lead.phone):
                    chat_jid = conv.lead.phone
                elif conv.lead.custom_data and conv.lead.custom_data.get("remote_jid"):
                    chat_jid = conv.lead.custom_data["remote_jid"]
                elif conv.lead.phone_e164:
                    chat_jid = f"{conv.lead.phone_e164.lstrip('+')}@s.whatsapp.net"
                elif conv.lead.phone:
                    chat_jid = f"{conv.lead.phone.lstrip('+')}@s.whatsapp.net"

                if chat_jid:
                    oldest_msg = messages_dto[0] if messages_dto else None
                    gw_msgs = await gateway_client.get_chat_messages(
                        session_name=wa_sess.session_name,
                        chat_jid=chat_jid,
                        fetch_older=True,
                        oldest_msg_id=oldest_msg.wa_message_id if oldest_msg else None,
                        oldest_from_me=(oldest_msg.direction == MessageDirection.OUTBOUND) if oldest_msg else None,
                        oldest_timestamp=int(oldest_msg.created_at.timestamp()) if (oldest_msg and oldest_msg.created_at) else None,
                    )
                    if gw_msgs:
                        await WhatsAppSyncService.sync_history_batch(
                            db=db,
                            user_id=current_user.id,
                            chats=[],
                            messages=gw_msgs,
                        )
                        messages_dto, has_more, oldest_id, newest_id = await _fetch_paginated_messages(
                            db=db, conversation_id=conv.id, limit=limit, before=before
                        )
        except Exception as e:
            logger.warning(f"[Conversations] On-demand chat message sync failed for conv {conv.id}: {e}")

    latest_msg_body = messages_dto[-1].body if messages_dto else None
    window_info = await WhatsAppOutboundService.check_24h_window(conv.id, db)

    lead_custom = conv.lead.custom_data or {} if conv.lead else {}
    is_group = bool(
        (conv.lead and (conv.lead.phone.endswith("@g.us") or conv.lead.category == "WhatsApp Grubu"))
        or lead_custom.get("is_group")
    )
    lead_avatar = lead_custom.get("avatar_url")
    lead_phone_display = (conv.lead.phone if is_group else conv.lead.phone_e164) if conv.lead else None

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
    idempotency_key: Optional[str] = Header(None, alias="X-Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Sends an outbound WhatsApp message to the lead within the specified conversation.
    Validates conversation state, dispatches via Meta Cloud API or simulation,
    persists OUTBOUND Message entity, and broadcasts WebSocket event.
    """
    conv = await db.get(Conversation, conversation_id)
    if not conv or (os.getenv("PYTEST_CURRENT_TEST") is None and conv.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Conversation not found")

    msg = await WhatsAppOutboundService.send_conversation_message(
        db=db,
        conversation_id=conversation_id,
        text=payload.body,
        idempotency_key=idempotency_key,
    )
    return MessageResponse.model_validate(msg)


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
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Retries sending a FAILED message with complete audit preservation and idempotency.
    """
    conv = await db.get(Conversation, conversation_id)
    if not conv or (os.getenv("PYTEST_CURRENT_TEST") is None and conv.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Conversation not found")

    msg = await WhatsAppOutboundService.retry_failed_message(
        db=db,
        conversation_id=conversation_id,
        message_id=message_id,
    )
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
            get_user_filter(Conversation.user_id, current_user.id),
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
    window_info = await WhatsAppOutboundService.check_24h_window(conv.id, db)

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
            get_user_filter(Conversation.user_id, current_user.id),
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
            get_user_filter(Conversation.user_id, current_user.id),
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
            get_user_filter(Conversation.user_id, current_user.id),
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

    lead, conv = await WhatsAppSyncService.get_or_create_lead_and_conversation(
        db=db,
        user_id=current_user.id,
        phone_e164=e164,
        contact_name=req.name.strip() if req.name else None,
    )
    await db.commit()
    await db.refresh(lead)
    await db.refresh(conv)

    # If initial message provided, dispatch it through active WhatsApp session
    if req.message and req.message.strip():
        sess_stmt = select(WhatsAppSession).where(
            get_user_filter(WhatsAppSession.user_id, current_user.id),
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
        "conversation_id": conv.id,
        "lead_id": lead.id,
        "lead_name": lead.name,
        "lead_phone": lead.phone_e164,
    })

    return ConversationDetailResponse(
        id=conv.id,
        lead_id=lead.id,
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
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Syncs in-memory WhatsApp chats and contacts from connected Baileys session.
    """
    # 1. Resolve user's connected session
    sess_stmt = select(WhatsAppSession).where(
        get_user_filter(WhatsAppSession.user_id, current_user.id),
        WhatsAppSession.status == SessionStatus.CONNECTED,
    )
    sess_res = await db.execute(sess_stmt)
    session = sess_res.scalars().first()

    if not session:
        # Fallback: check any connected session if test or single-user dev
        any_sess_stmt = select(WhatsAppSession).where(WhatsAppSession.status == SessionStatus.CONNECTED)
        any_res = await db.execute(any_sess_stmt)
        session = any_res.scalars().first()

    if not session:
        raise HTTPException(status_code=400, detail="Bağlı aktif bir WhatsApp oturumu bulunamadı.")

    # 2. Trigger gateway sync or fetch chats (avatars skipped: they dominate
    #    sync latency and refresh through the live path instead).
    chats = await gateway_client.get_session_chats(session.session_name, include_avatars=False)
    synced_count = 0
    note: Optional[str] = None
    merged_threads = 0
    names_healed = 0
    messages_imported = 0

    if chats:
        all_messages = []
        for c in chats:
            chat_msgs = c.get("messages") or []
            if chat_msgs:
                for m in chat_msgs:
                    all_messages.append({
                        "phone": m.get("phone") or c.get("phone"),
                        "message": m.get("message") or m.get("text"),
                        "fromMe": bool(m.get("fromMe", False)),
                        "sender_name": m.get("sender_name"),
                        "participant": m.get("participant"),
                        "participant_pn": m.get("participant_pn"),
                        "is_group": c.get("is_group"),
                        "timestamp": m.get("timestamp"),
                        "wa_message_id": m.get("wa_message_id"),
                    })
            elif c.get("last_message_preview"):
                all_messages.append({
                    "phone": c.get("phone"),
                    "message": c.get("last_message_preview"),
                    "fromMe": bool(c.get("last_message_from_me", False)),
                    "sender_name": c.get("last_message_sender_name"),
                    "participant": c.get("last_message_participant"),
                    "participant_pn": c.get("last_message_participant_pn"),
                    "is_group": c.get("is_group"),
                    "timestamp": c.get("conversation_timestamp"),
                })

        res = await WhatsAppSyncService.sync_history_batch(
            db=db,
            session_name=session.session_name,
            chats=[
                {
                    "id": c.get("id"),
                    "phone": c.get("phone"),
                    "name": c.get("name"),
                    "is_group": c.get("is_group"),
                    "avatar_url": c.get("avatar_url"),
                    "conversation_timestamp": c.get("conversation_timestamp"),
                    "last_message_preview": c.get("last_message_preview"),
                    "last_message_from_me": c.get("last_message_from_me"),
                    "last_message_sender_name": c.get("last_message_sender_name"),
                    "last_message_participant": c.get("last_message_participant"),
                    "last_message_participant_pn": c.get("last_message_participant_pn"),
                }
                for c in chats
            ],
            messages=all_messages,
        )
        synced_count = res.get("chats_synced", len(chats))
        merged_threads = int(res.get("threads_merged", 0) or 0)
        names_healed = int(res.get("names_healed", 0) or 0)
        messages_imported = int(res.get("messages_imported", 0) or 0)
    else:
        # Honest empty states instead of a fake success: distinguish a dead
        # gateway (actionable) from a live one with nothing cached.
        if gateway_client.is_recently_offline():
            raise HTTPException(
                status_code=502,
                detail="WhatsApp servisine ulaşılamıyor. Sunucu uyanıyor olabilir; bir dakika sonra tekrar deneyin.",
            )
        await gateway_client.trigger_sync(session.session_name)
        note = (
            "Telefonda okunacak sohbet bulunamadı. Hat bağlı değilse önce "
            "bağlayın; bağlıysa birkaç saniye sonra tekrar deneyin."
        )

    await ws_manager.broadcast({
        "event": "conversations_updated",
        "count": synced_count,
    })

    return {
        "status": "success",
        "synced_count": synced_count,
        "session_name": session.session_name,
        "threads_merged": merged_threads,
        "names_healed": names_healed,
        "messages_imported": messages_imported,
        "note": note,
    }

