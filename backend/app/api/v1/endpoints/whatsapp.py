"""WhatsApp gateway entegrasyonu API uç noktaları (Aşama 2).

HTTP katmanı: doğrulama + query parsing; iş mantığı `whatsapp_service`'de.
Tüm uç noktalar kimlik doğrulamalı ve çok kiracılı (user_id filtresi) çalışır.
"""
from typing import Optional, Dict, Any
import logging
import re
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import AuthUser, get_current_user
from backend.app.core.database import get_db
from backend.app.schemas.whatsapp import (
    WhatsAppAvatarBackfillResponse,
    WhatsAppAvatarRefreshResponse,
    WhatsAppContactListResponse,
    WhatsAppConversationItem,
    WhatsAppConversationListResponse,
    WhatsAppConversationStatusRequest,
    WhatsAppConversationStatusResult,
    WhatsAppConversationDeleteResult,
    WhatsAppLidSplitListResponse,
    WhatsAppLidSplitMergeRequest,
    WhatsAppLidSplitMergeResponse,
    WhatsAppLoadingGateResponse,
    WhatsAppMessageItem,
    WhatsAppMessagesResponse,
    WhatsAppPairingCodeRequest,
    WhatsAppPairingCodeResponse,
    WhatsAppPairingQrResponse,
    WhatsAppPairingStartRequest,
    WhatsAppPairingStartResponse,
    WhatsAppQrResponse,
    WhatsAppReactionResult,
    WhatsAppReadResult,
    WhatsAppSendMediaRequest,
    WhatsAppSendReactionRequest,
    WhatsAppSendResult,
    WhatsAppSendTextRequest,
    WhatsAppSessionCreate,
    WhatsAppSessionListResponse,
    WhatsAppSessionResponse,
    WhatsAppStartConversationRequest,
    WhatsAppStatusResult,
    WhatsAppSyncJobResponse,
    WhatsAppSyncStatusResponse,
    WhatsAppTypingRequest,
)
from backend.app.services import whatsapp_service
from backend.app.services.link_preview.service import (
    get_preview_image_bytes as _get_preview_image_bytes,
)
from backend.app.services.whatsapp.exceptions import PairingPromotionRefused
from backend.app.services.whatsapp_service import NoWhatsAppSession, WhatsAppRelinkRequired

router = APIRouter()

logger = logging.getLogger(__name__)


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


def _unprocessable(exc: Exception) -> HTTPException:
    """Girdi dogrulanamadi -> 422.

    `LookupError` "bulunamadi" demektir, ve bir bos mesaj govdesi veya yeniden
    kullanilan bir client_message_id bulunamaz degil — gecersizdir. Bunlar 404
    olarak dondugu icin istemci "sohbet bulunamadi" saniyor ve kullanicinin
    yapabilecegi tek sey yeniden denemek oluyor.
    """
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


def _conflict(exc: Exception) -> HTTPException:
    """Idempotency celiskisi -> 409.

    Ayni client_message_id FARKLI bir icerikle tekrar kullanilamaz. Bu bir
    gateway aritasi degil, istemcinin istegi kendi kendisiyle celisiyor; 502
    donmek "gecici hata, tekrar dene" dedirtiyor ve ayni hatayi tekrar
    uretiyordu.
    """
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


def _no_session(exc: Exception) -> HTTPException:
    """Kullanicinin bagli WhatsApp hatti yok -> 409.

    Bu bir gateway arizasi DEGILDIR; 502 "gateway'e ulasilamadi" demek
    kullaniciyi yanlis yone yonlendirir. Gercek neden: hat eslestirilmemis
    (ya da baglantisi kopmus) — UI kullaniciyi QR ekranina yonlendirmelidir.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Bağlı bir WhatsApp hattı yok. Lütfen önce QR ile eşleştirin.",
    )


def _bad_gateway(exc: Exception) -> HTTPException:
    """Gateway erisim hatasi -> 502.

    Faz 13: ham exception metni (ic URL, host, stack detayi) istemciye
    GONDERILMEZ — yalnizca sunucu logunda tutulur. Istemci generic mesaj alir.
    """
    logger.warning("WhatsApp gateway hatasi: %s", exc)
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="WhatsApp gateway'e ulaşılamadı. Lütfen gateway servisinin çalıştığını doğrulayın.",
    )


def _relink_required(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=str(exc),
        headers={"X-WhatsApp-State": "RELINK_REQUIRED"},
    )


def _pairing_refused(exc: Exception) -> HTTPException:
    """Eşleşme tamamlandı ama kalıcı oturum bağlanamadı -> 409.

    `promote_ephemeral_pairing` None döndürdüğünde (sahip kanıtlanamadı, telefon
    başka kiracıda, ya da canlı oturum başka gateway'de) yükseltilir. Bu bir
    gateway arızası DEĞİLDİR; 502 "gateway'e ulaşılamadı" demek kullanıcıyı
    yanlış yöne yönlendirir — `_no_session` ile aynı gerekçe.
    """
    logger.warning("WhatsApp eşleşmesi reddedildi: %s", exc)
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


# ---------------------------------------------------------------------------
# Gateway probe (A7)
# ---------------------------------------------------------------------------
@router.get("/gateway/health")
async def gateway_health() -> JSONResponse:
    """Fail-closed gateway reachability probe.

    Thin router: delegates to `whatsapp_service.gateway_health_probe`. On any
    failure returns 503 with `gateway_available=False` — the gateway being
    unreachable is NEVER masked as healthy. No response_model so the gateway
    summary fields pass through untouched; response carries no secrets.
    """
    try:
        data = await whatsapp_service.gateway_health_probe()
    except Exception as exc:
        logger.warning("[WhatsApp] Gateway health probe failed: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"gateway_available": False, "error": "WhatsApp gateway'e ulaşılamadı."},
        )
    return JSONResponse(content=data)


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


# ---------------------------------------------------------------------------
# Ephemeral Pairing Lifecycle (No-Create QR)
# ---------------------------------------------------------------------------
@router.post("/pairing/start", response_model=WhatsAppPairingStartResponse, status_code=status.HTTP_201_CREATED)
async def start_pairing(
    payload: WhatsAppPairingStartRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppPairingStartResponse:
    try:
        # Phase 6.8: the durable `ephemeral_pairings` record is written here, so a
        # later `session_connected` can resolve the owner even if this process
        # loses `_ephemeral_pairings` (restart, cancel, popped token).
        data = await whatsapp_service.start_pairing_session(current_user.id, payload.name, db=db)
        return WhatsAppPairingStartResponse(**data)
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.get("/pairing/{pair_token}/qr", response_model=WhatsAppPairingQrResponse)
async def get_pairing_qr(
    pair_token: str,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppPairingQrResponse:
    try:
        data = await whatsapp_service.get_pairing_qr(db, current_user.id, pair_token)
        return WhatsAppPairingQrResponse(**data)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except PairingPromotionRefused as exc:
        # The pairing DID complete on the gateway, but the durable row could not
        # be bound safely. That is a conflict, not a gateway outage.
        raise _pairing_refused(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.post("/pairing/{pair_token}/pair", response_model=WhatsAppPairingCodeResponse)
async def request_pairing_code_for_token(
    pair_token: str,
    payload: WhatsAppPairingCodeRequest,
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppPairingCodeResponse:
    """P6-8: 'Telefon numarası ile bağlan' for a NEW (ephemeral) pairing.

    `/sessions/{id}/pair` needs a numeric session id, which does not exist until
    the QR is scanned — so a first-time phone-code pairing had no endpoint at
    all and the UI silently did nothing. This is the same gateway call,
    addressed by the ephemeral pairing's gateway session, on the same lifecycle
    as QR pairing (promotion still happens on connection.open).
    """
    try:
        data = await whatsapp_service.request_pairing_code_for_token(
            current_user.id, pair_token, payload.phone
        )
        return WhatsAppPairingCodeResponse(**data)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.post("/pairing/{pair_token}/cancel")
async def cancel_pairing(
    pair_token: str,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Dict[str, Any]:
    try:
        # Phase 6.8: promotion-aware. A cancel that arrives after the gateway
        # already reached CONNECTED finalises the pairing instead of deleting
        # the promoted socket.
        return await whatsapp_service.cancel_pairing_session(current_user.id, pair_token, db=db)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        # §1.1 (truthfulness): beklenmeyen bir arıza basari gibi RAPORLANMAZ.
        # İstemci bu yanıtı fire-and-forget kullanır; yalnızca gerçek neden
        # artık logla sınırlı kalmayıp yanıtta taşınır.
        logger.warning("[WhatsApp] cancel_pairing error: %s", exc)
        return {"success": False, "cancelled": False, "error": str(exc)[:300]}


@router.post("/sessions", response_model=WhatsAppSessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: WhatsAppSessionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSessionResponse:
    try:
        session = await whatsapp_service.create_session(db, current_user.id, payload.name)
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
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
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
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
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
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
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
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
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
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
        result = await whatsapp_service.delete_session(db, current_user.id, session_id)
        return WhatsAppStatusResult(
            success=bool(result.get("success")),
            message="Oturum yerel olarak silindi" if result.get("success") else "Oturum yerel olarak silindi ancak gateway temizlenemedi",
            status="DISCONNECTED",
            error=result.get("error"),
        )
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
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
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppSyncStatusResponse(**data)


@router.get("/loading-gate", response_model=WhatsAppLoadingGateResponse)
async def get_loading_gate(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppLoadingGateResponse:
    """QR sonrasi Loading Gate — tek-authority yukleme kapisi (WhatsApp Web paritesi).

    Faz 0 kontrakt: frontend QR sonrasi `hubTab`'i ve kapiyi YALNIZCA bu
    endpoint'in `phase`'ine gore surer. `phase` backend SyncJob + gateway
    sync + avatar counts birlesiminden turetilir; sahte progress uretilmez.
    """
    try:
        data = await whatsapp_service.get_loading_gate(db, current_user.id)
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppLoadingGateResponse(**data)


@router.post("/sync", response_model=WhatsAppSyncJobResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_sync(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSyncJobResponse:
    """Initial-sync job'ını tetikle (kısa ömürlü, §15/§16).

    HTTP beklemez: job kaydı oluşturulur ve ilerleme MEVCUT WebSocket
    üzerinden `whatsapp_sync_*` olaylarıyla akar. Süren bir job varsa yeni
    job tetiklenmez — aynı sync_id döner (çift-sync koruması, §17).
    """
    job = await whatsapp_service.request_sync(db, current_user.id)
    return WhatsAppSyncJobResponse(**job.snapshot())


@router.get("/sync/job", response_model=WhatsAppSyncJobResponse)
async def get_sync_job(
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppSyncJobResponse:
    """Aktif/son sync job'ının gerçek durumu (WS reconnect kurtarması, §28).

    Job yoksa state=IDLE döner — frontend bu durumda senkron banner'ı kapatır
    ve listeyi DB'den normal yükler.
    """
    snap = whatsapp_service.get_sync_job(current_user.id)
    if snap is None:
        return WhatsAppSyncJobResponse(sync_id=None, state="IDLE", stage="idle")
    return WhatsAppSyncJobResponse(**snap)


# ---------------------------------------------------------------------------
# Contacts & conversations
# ---------------------------------------------------------------------------
@router.get("/contacts", response_model=WhatsAppContactListResponse)
async def sync_contacts(
    session_id: Optional[int] = Query(None, description="Opsiyonel hedef oturum ID'si"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppContactListResponse:
    try:
        ws_session = None
        if session_id is not None:
            ws_session = await whatsapp_service._require_user_session(db, current_user.id, session_id=session_id)
        contacts = await whatsapp_service.sync_contacts(db, current_user.id, session=ws_session)
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppContactListResponse(contacts=contacts)


@router.post("/contacts/{phone}/avatar/refresh", response_model=WhatsAppAvatarRefreshResponse)
async def refresh_contact_avatar(
    phone: str,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppAvatarRefreshResponse:
    try:
        res = await whatsapp_service.refresh_contact_avatar(db, current_user.id, phone)
        return WhatsAppAvatarRefreshResponse(**res)
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.post("/avatars/refresh", response_model=WhatsAppAvatarBackfillResponse)
async def refresh_all_avatars(
    force: bool = Query(False, description="Zorla yenile: negatif onbellegi ve zaman asimi engellerini temizler"),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppAvatarBackfillResponse:
    """Sohbet listesindeki TÜM eksik profil fotoğrafları için backfill tetikler.

    WhatsApp Web paritesi: QR eşleşmesi sonrası kimi fotoğraflar (rate limit,
    geç hydration vb.) ilk sweep'te düşebilir; bu uç nokta gateway'de eksik
    kalmayana dek backoff'lu turlarla çalışan sweep'i başlatır. Yeni
    avatarlar `conversation_updated` olaylarıyla sohbet listesine canlı akar.
    """
    try:
        data = await whatsapp_service.refresh_all_avatars(db, current_user.id, force=force)
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppAvatarBackfillResponse(**data)


@router.get("/conversations", response_model=WhatsAppConversationListResponse)
async def get_conversations(
    search: Optional[str] = Query(None),
    conv_status: Optional[str] = Query(None, alias="status"),
    unread_only: bool = Query(False),
    group_only: bool = Query(False, description="Yalnizca grup sohbetleri (is_group)"),
    archived_only: bool = Query(False, description="Yalnizca WhatsApp arsivli sohbetler (is_archived veya status=ARCHIVED)"),
    lead_id: Optional[int] = Query(
        None, ge=1, description="Yalnizca bu lead'e bagli sohbet (LeadDetailDrawer sohbet sekmesi)"
    ),
    conversation_id: Optional[int] = Query(
        None, ge=1, description="Yalnizca bu sohbet (hedefli tek-sohbet sorgusu)"
    ),
    sync: bool = Query(False, description="Arka plan sync job'ını tetikle (beklemeden döner)"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppConversationListResponse:
    # Yeni mimari (§15/§16): `sync=true` artık HTTP içinde gateway'den mesaj
    # çekMEZ — kısa ömürlüdür: job'ı tetikler (süren job varsa dokunmaz, §17)
    # ve anında mevcut DB snapshot'ını döner. Gerçek ilerleme WS üzerinden
    # `whatsapp_sync_*` olaylarıyla akar. Eski 502/timeout storm'unun kaynağı
    # bu endpoint'in içinde bekleyen 113 chat'lik round-trip zinciriydi.
    if sync:
        await whatsapp_service.request_sync(db, current_user.id)
    items, total = await whatsapp_service.list_conversations(
        db,
        current_user.id,
        search=search,
        status=conv_status,
        unread_only=unread_only,
        group_only=group_only,
        archived_only=archived_only,
        lead_id=lead_id,
        conversation_id=conversation_id,
        limit=limit,
        offset=offset,
    )
    has_more = (offset + len(items)) < total

    next_offset = (offset + len(items)) if has_more else None
    return WhatsAppConversationListResponse(
        items=items,
        total=total,
        has_more=has_more,
        next_offset=next_offset,
    )



@router.post("/conversations", response_model=WhatsAppConversationItem, status_code=status.HTTP_201_CREATED)
async def start_conversation(
    payload: WhatsAppStartConversationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppConversationItem:
    """WhatsApp Web paritesi: numara ile yeni sohbet baslat.

    `message` verilirse bagli hattan GERCEK olarak gönderilir; gönderim
    başarısızsa uç nokta başarısız olur (sahte "sohbet açıldı" yok, §1.1).
    """
    try:
        data = await whatsapp_service.start_conversation(
            db,
            current_user.id,
            payload.phone,
            name=payload.name,
            message=payload.message,
            session_id=payload.session_id,
        )
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppConversationItem(**data)


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
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        # On-demand history failures are operational outages, not an empty
        # conversation. Surface an explicit 502 so the UI can show retryable
        # state instead of claiming that no messages exist.
        raise _bad_gateway(exc) from exc
    return WhatsAppMessagesResponse(**data)


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}",
    response_model=WhatsAppMessageItem,
)
async def get_message_detail(
    conversation_id: int,
    message_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Dict[str, Any]:
    """Tek bir kalici mesaj satiri (FAILED retry akisinin kaynagi).

    Frontend `WhatsAppApi.getMessage` bu uç noktayı çağırır; endpoint yokken
    retry her denemede 404'e düşüyordu (contract kopması). Kiracı doğrulaması
    servis katmanında (`_resolve_jid` + user filtresi) yapılır.
    """
    try:
        return await whatsapp_service.get_message(
            db, current_user.id, conversation_id, message_id
        )
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/reactions",
    response_model=WhatsAppReactionResult,
)
async def send_reaction(
    conversation_id: int,
    message_id: int,
    payload: WhatsAppSendReactionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppReactionResult:
    """Bir mesaja tepki birakir/degistirir/kaldirir (WhatsApp Web paritesi).

    Kendi ucu vardir: `/messages` ucundan gecmesi tepkiyi bir MESAJ gibi
    kaydederdi — duzeltilen hatanin ta kendisi. Bos `emoji` geri ceker ve
    yanit bunu `removed=true` ile acikca soyler.
    """
    try:
        result = await whatsapp_service.send_reaction(
            db, current_user.id, conversation_id, message_id, payload.emoji
        )
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except LookupError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        # Ornegin henuz saglayici kimligi olmayan bir mesaj: girdi degil
        # DURUM sorunu, ama istemcinin retry etmemesi gerektigi icin 422.
        raise _unprocessable(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppReactionResult(**result)


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
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except LookupError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        # Idempotency conflict: the same client_message_id was reused for
        # different content. Distinguishable from a gateway outage so the UI
        # does not tell the user to just retry the identical request.
        raise _conflict(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppSendResult(
        id=msg.get("id"),
        wa_message_id=msg.get("wa_message_id"),
        client_message_id=msg.get("client_message_id"),
        status=msg.get("status"),
        body=msg.get("body"),
        created_at=msg.get("created_at"),
        message_type=msg.get("message_type"),
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
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except LookupError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        # Either an empty body (422) or a client_message_id reused for different
        # content (409). Both are client-side; retrying as-is never helps.
        if "client_message_id" in str(exc):
            raise _conflict(exc) from exc
        raise _unprocessable(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppSendResult(
        id=msg.get("id"),
        wa_message_id=msg.get("wa_message_id"),
        client_message_id=msg.get("client_message_id"),
        status=msg.get("status"),
        body=msg.get("body"),
        created_at=msg.get("created_at"),
        message_type=msg.get("message_type"),
        media_id=msg.get("media_id"),
        media_url=msg.get("media_url"),
    )


@router.post("/conversations/{conversation_id}/read", response_model=WhatsAppReadResult)
async def mark_conversation_read(
    conversation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppReadResult:
    try:
        result = await whatsapp_service.mark_conversation_read(db, current_user.id, conversation_id)
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except LookupError as exc:
        raise _not_found(exc) from exc
    return WhatsAppReadResult(
        success=bool(result.get("success", True)),
        error=result.get("error"),
    )


@router.post("/conversations/{conversation_id}/typing", response_model=WhatsAppReadResult)
async def send_typing(
    conversation_id: int,
    payload: WhatsAppTypingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppReadResult:
    try:
        result = await whatsapp_service.send_typing(db, current_user.id, conversation_id, typing=payload.typing)
    except WhatsAppRelinkRequired as exc:
        raise _relink_required(exc) from exc
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppReadResult(
        success=bool(result.get("success", True)),
        error=result.get("error"),
    )


@router.patch(
    "/conversations/{conversation_id}/status",
    response_model=WhatsAppConversationStatusResult,
)
async def update_conversation_status(
    conversation_id: int,
    payload: WhatsAppConversationStatusRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppConversationStatusResult:
    """Sohbeti arsivle / kapat / yeniden ac (kalici).

    Gateway'e ihtiyac duymaz: bu kullanicinin CRM seviyesindeki aksiyonudur.
    """
    try:
        result = await whatsapp_service.update_conversation_status(
            db, current_user.id, conversation_id, payload.status
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except LookupError as exc:
        raise _not_found(exc) from exc
    return WhatsAppConversationStatusResult(id=result["id"], status=result["status"])


@router.delete(
    "/conversations/{conversation_id}",
    response_model=WhatsAppConversationDeleteResult,
)
async def delete_conversation(
    conversation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppConversationDeleteResult:
    """Sohbeti ve o sohbete ait TUM mesajlari kalici olarak siler.

    Geri donusu yoktur ve WhatsApp konusmalari icin yedek bulunmaz; bu yuzden
    arayuz onay ister. Karsi tarafin cihazindaki gecmis silinmez (WhatsApp
    semantigi).

    Gateway'e ihtiyac DUYAR: Tezlify'dan silinen sohbet WhatsApp tarafinda da
    silinir (`deleteChatAction`), boylece hesabin diger cihazlari (telefon) da
    senkron kalir. Bu cagri en iyi cabadir ve yerel silmeyi ASLA engellemez;
    sonuc yanitta `remote_deleted` olarak doner.
    """
    try:
        result = await whatsapp_service.delete_conversation(
            db, current_user.id, conversation_id
        )
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    return WhatsAppConversationDeleteResult(**result)


# ---------------------------------------------------------------------------
# LID/telefon bölünmüş sohbet onarımı (yönetim ucu)
# ---------------------------------------------------------------------------
@router.get("/lid-splits", response_model=WhatsAppLidSplitListResponse)
async def list_lid_splits(
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppLidSplitListResponse:
    """Onarımı bekleyen bölünmüş LID sohbetlerini KANITLARIYLA listeler.

    Her satır "ne taşınacak"ı aksiyondan ÖNCE gösterir (mesaj/okunmamış sayısı);
    "bekleyen iş var mı" sorusu artık `docker exec` gerektirmez.
    """
    result = await whatsapp_service.list_lid_split_candidates(
        db, current_user.id, limit=limit
    )
    return WhatsAppLidSplitListResponse(**result)


@router.post("/lid-splits/merge", response_model=WhatsAppLidSplitMergeResponse)
async def merge_lid_splits(
    payload: WhatsAppLidSplitMergeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> WhatsAppLidSplitMergeResponse:
    """Tek istekte onarım: bekleyen bölünmüş çiftleri birleştirir.

    `lid_jid` verilirse yalnız o çift; verilmezse bu kiracının bekleyenleri
    (`limit` kadar). İş SÜPÜRMEYLE AYNI birleştirmeyi çağırır; kilit başka bir
    süreçteyse sonuç `deferred` olur ve çift aday kalır — sessiz kayıp yok.
    """
    result = await whatsapp_service.merge_lid_splits(
        db, current_user.id, lid_jid=payload.lid_jid, limit=payload.limit
    )
    return WhatsAppLidSplitMergeResponse(**result)


def _handle_byte_range(
    data: bytes, range_header: str, mime: Optional[str], headers: dict
) -> Response:
    total_len = len(data)
    headers["Accept-Ranges"] = "bytes"
    if not range_header.startswith("bytes="):
        headers["Content-Length"] = str(total_len)
        return Response(content=data, media_type=mime or "application/octet-stream", headers=headers)

    MAX_RANGE_CHUNK = 2 * 1024 * 1024  # 2MB chunks for open-ended streaming
    raw_range = range_header.replace("bytes=", "").strip()
    parts = raw_range.split("-")
    try:
        start = int(parts[0]) if parts[0] else 0
        if len(parts) > 1 and parts[1]:
            end = int(parts[1])
        else:
            # Open-ended range like "bytes=0-": cap chunk size to MAX_RANGE_CHUNK
            end = min(start + MAX_RANGE_CHUNK - 1, total_len - 1)
    except ValueError:
        headers["Content-Length"] = str(total_len)
        return Response(content=data, media_type=mime or "application/octet-stream", headers=headers)

    if start >= total_len or end >= total_len or start > end:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{total_len}", "Accept-Ranges": "bytes"},
        )

    chunk = data[start : end + 1]
    headers["Content-Range"] = f"bytes {start}-{end}/{total_len}"
    headers["Content-Length"] = str(len(chunk))
    return Response(
        content=chunk,
        status_code=206,
        media_type=mime or "application/octet-stream",
        headers=headers,
    )


@router.api_route("/media/{media_id}", methods=["GET", "HEAD"])
async def get_media(
    media_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Response:
    """Kimlik dogrulamali medya proxy'si — gateway'deki gelen medyayi sunar."""
    try:
        data, mime, filename = await whatsapp_service.get_media_bytes(db, current_user.id, media_id)
    except NoWhatsAppSession as exc:
        raise _no_session(exc) from exc
    except LookupError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
            headers={"Cache-Control": "private, max-age=300"},
        ) from exc
    except Exception as exc:
        raise _bad_gateway(exc) from exc
    headers = {}
    if filename:
        ascii_name = re.sub(r'[^\x20-\x7E]', '_', filename).replace('"', '').strip() or "document"
        utf8_encoded = urllib.parse.quote(filename, encoding="utf-8")
        headers["Content-Disposition"] = f'inline; filename="{ascii_name}"; filename*=UTF-8\'\'{utf8_encoded}'
    headers["Accept-Ranges"] = "bytes"
    headers["Content-Length"] = str(len(data))
    headers["Cache-Control"] = "private, max-age=86400, immutable"
    if request.method == "HEAD":
        return Response(content=b"", media_type=mime or "application/octet-stream", headers=headers)
    range_header = request.headers.get("range")
    if range_header:
        return _handle_byte_range(data, range_header, mime, headers)
    return Response(content=data, media_type=mime or "application/octet-stream", headers=headers)


@router.get("/link-preview/image")
async def get_link_preview_image(
    u: str = Query(
        ...,
        min_length=8,
        max_length=64,
        description="link_previews.url_hash (URL DEGIL)",
    ),
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> Response:
    """Onizleme kapak gorselini kimlik dogrulamali proxy uzerinden sunar.

    Istemci URL DEGIL HASH gonderir. Bu ayrim guvenligin kendisidir: URL kabul
    eden bir proxy, saldirganin `u=http://169.254.169.254/...` gonderip
    sunucuyu kendi ic agina konusturdugu acik bir aktarim olurdu. Hash ile
    cekilecek adres yalnizca `link_previews` tablosunda, yani dogrulamadan
    gecmis kayitlarda bulunur.

    `Cache-Control: private` secildi: onizleme kisisel bir sohbete ait
    olmasa da yanit kimlik dogrulamali bir uctan gelir ve ara sunucularda
    ortak onbellege alinmamalidir.
    """
    try:
        data, mime = await _get_preview_image_bytes(db, u)
    except LookupError as exc:
        raise _not_found(exc) from exc
    except Exception as exc:
        logger.warning("Link preview image proxy hatasi: %s", exc)
        raise _not_found(exc) from exc
    return Response(
        content=data,
        media_type=mime or "image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/contacts/{phone_or_jid}/status")
async def get_contact_status(
    phone_or_jid: str,
    session_id: Optional[int] = None,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """WhatsApp kişi durumunu (About / Status) dinamik olarak çeker."""
    return await whatsapp_service.get_contact_status(
        db, current_user.id, phone_or_jid, session_id=session_id
    )


@router.get("/conversations/{conversation_id}/participants")
async def get_group_participants(
    conversation_id: int,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """WhatsApp grup katılımcılarını ve metadata'sını çeker."""
    return await whatsapp_service.get_group_participants(
        db, current_user.id, conversation_id
    )


