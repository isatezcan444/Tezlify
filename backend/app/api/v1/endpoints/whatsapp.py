"""WhatsApp gateway entegrasyonu API uç noktaları (Aşama 2).

HTTP katmanı: doğrulama + query parsing; iş mantığı `whatsapp_service`'de.
Tüm uç noktalar kimlik doğrulamalı ve çok kiracılı (user_id filtresi) çalışır.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import AuthUser, get_current_user
from backend.app.core.database import get_db
from backend.app.schemas.whatsapp import (
    WhatsAppContactListResponse,
    WhatsAppConversationListResponse,
    WhatsAppMessagesResponse,
    WhatsAppPairingCodeRequest,
    WhatsAppPairingCodeResponse,
    WhatsAppQrResponse,
    WhatsAppReadResult,
    WhatsAppSendMediaRequest,
    WhatsAppSendResult,
    WhatsAppSendTextRequest,
    WhatsAppSessionCreate,
    WhatsAppSessionListResponse,
    WhatsAppSessionResponse,
    WhatsAppStatusResult,
    WhatsAppSyncStatusResponse,
    WhatsAppTypingRequest,
)
from backend.app.services import whatsapp_service

router = APIRouter()


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


def _bad_gateway(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"WhatsApp gateway'e ulaşılamadı: {exc}",
    )


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------
@router.get("/sessions", response_model=WhatsAppSessionListResponse)
async def get_sessions(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSessionListResponse:
    sessions = await whatsapp_service.list_sessions(db, current_user.id)
    return WhatsAppSessionListResponse(sessions=sessions)


@router.post("/sessions", response_model=WhatsAppSessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: WhatsAppSessionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSessionResponse:
    try:
        session = await whatsapp_service.create_session(db, current_user.id, payload.name)
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppSessionResponse(**session)


@router.get("/sessions/{session_id}/qr", response_model=WhatsAppQrResponse)
async def get_session_qr(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppQrResponse:
    try:
        return WhatsAppQrResponse(**await whatsapp_service.get_session_qr(db, current_user.id, session_id))
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.post("/sessions/{session_id}/qr/refresh", response_model=WhatsAppQrResponse)
async def refresh_session_qr(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppQrResponse:
    try:
        return WhatsAppQrResponse(**await whatsapp_service.refresh_session_qr(db, current_user.id, session_id))
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.post("/sessions/{session_id}/pair", response_model=WhatsAppPairingCodeResponse)
async def request_pairing_code(
    session_id: int,
    payload: WhatsAppPairingCodeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppPairingCodeResponse:
    try:
        result = await whatsapp_service.request_pairing_code(db, current_user.id, session_id, payload.phone)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppPairingCodeResponse(**result)


@router.post("/sessions/{session_id}/logout", response_model=WhatsAppStatusResult)
async def logout_session(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppStatusResult:
    try:
        result = await whatsapp_service.logout_session(db, current_user.id, session_id)
        return WhatsAppStatusResult(success=True, message=result.get("status"), status=result.get("status"))
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.delete("/sessions/{session_id}", response_model=WhatsAppStatusResult)
async def delete_session(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppStatusResult:
    try:
        await whatsapp_service.delete_session(db, current_user.id, session_id)
        return WhatsAppStatusResult(success=True, message="Oturum silindi", status="DISCONNECTED")
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.get("/sync-status", response_model=WhatsAppSyncStatusResponse)
async def get_sync_status(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSyncStatusResponse:
    """QR sonrası gerçek initial-sync aşaması/ilerlemesi (Faz 7).

    Kaynak gateway belleğidir (Baileys history-sync progress) — sahte progress
    üretilmez. Gateway'e ulaşılamazsa hata maskelenmez (502).
    """
    try:
        data = await whatsapp_service.get_sync_status(db, current_user.id)
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppSyncStatusResponse(**data)


# ---------------------------------------------------------------------------
# Contacts & conversations
# ---------------------------------------------------------------------------
@router.get("/contacts", response_model=WhatsAppContactListResponse)
async def sync_contacts(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppContactListResponse:
    try:
        contacts = await whatsapp_service.sync_contacts(db, current_user.id)
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppContactListResponse(contacts=contacts)


@router.get("/conversations", response_model=WhatsAppConversationListResponse)
async def get_conversations(
    search: Optional[str] = Query(None),
    conv_status: Optional[str] = Query(None, alias="status"),
    unread_only: bool = Query(False),
    sync: bool = Query(False, description="Gateway'den sohbetleri senkronize et"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppConversationListResponse:
    try:
        if sync:
            await whatsapp_service.sync_conversations(db, current_user.id)
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    items, total = await whatsapp_service.list_conversations(
        db,
        current_user.id,
        search=search,
        status=conv_status,
        unread_only=unread_only,
        limit=limit,
        offset=offset,
    )
    return WhatsAppConversationListResponse(items=items, total=total)


@router.get("/conversations/{conversation_id}/messages", response_model=WhatsAppMessagesResponse)
async def get_messages(
    conversation_id: int,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppMessagesResponse:
    try:
        data = await whatsapp_service.get_messages(db, current_user.id, conversation_id, limit=limit, before=before)
    except LookupError as exc:
        raise _not_found(exc) from exc
    return WhatsAppMessagesResponse(**data)


@router.post("/conversations/{conversation_id}/messages", response_model=WhatsAppSendResult)
async def send_message(
    conversation_id: int,
    payload: WhatsAppSendTextRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSendResult:
    try:
        msg = await whatsapp_service.send_text_message(
            db, current_user.id, conversation_id, payload.body, payload.client_message_id
        )
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppSendResult(
        id=msg.get("id"),
        wa_message_id=msg.get("wa_message_id"),
        client_message_id=msg.get("client_message_id"),
        status=msg.get("status") or "SENT",
        body=msg.get("body"),
    )


@router.post("/conversations/{conversation_id}/media", response_model=WhatsAppSendResult)
async def send_media(
    conversation_id: int,
    payload: WhatsAppSendMediaRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSendResult:
    if not payload.media_url and not payload.media_base64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="media_url veya media_base64 zorunludur.",
        )
    media = {
        "media_type": payload.media_type,
        "media_url": payload.media_url,
        "media_base64": payload.media_base64,
        "mime_type": payload.mime_type,
        "caption": payload.caption,
        "filename": payload.filename,
        "client_message_id": payload.client_message_id,
    }
    try:
        msg = await whatsapp_service.send_media_message(db, current_user.id, conversation_id, media)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppSendResult(
        id=msg.get("id"),
        wa_message_id=msg.get("wa_message_id"),
        client_message_id=msg.get("client_message_id"),
        status=msg.get("status") or "SENT",
        body=msg.get("body"),
    )


@router.post("/conversations/{conversation_id}/read", response_model=WhatsAppReadResult)
async def mark_conversation_read(
    conversation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppReadResult:
    try:
        result = await whatsapp_service.mark_conversation_read(db, current_user.id, conversation_id)
    except LookupError as exc:
        raise _not_found(exc) from exc
    return WhatsAppReadResult(success=bool(result.get("success", True)))


@router.post("/conversations/{conversation_id}/typing", response_model=WhatsAppReadResult)
async def send_typing(
    conversation_id: int,
    payload: WhatsAppTypingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppReadResult:
    try:
        result = await whatsapp_service.send_typing(db, current_user.id, conversation_id, typing=payload.typing)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppReadResult(success=bool(result.get("success", True)))


@router.get("/media/{media_id}")
async def get_media(
    media_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Response:
    """Kimlik dogrulamali medya proxy'si — gateway'deki gelen medyayi sunar."""
    try:
        data, mime, filename = await whatsapp_service.get_media_bytes(db, current_user.id, media_id)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    headers = {}
    if filename:
        headers["Content-Disposition"] = f'inline; filename="{filename}"'
    return Response(content=data, media_type=mime or "application/octet-stream", headers=headers)

