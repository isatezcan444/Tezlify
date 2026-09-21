import os
import json
import logging
import datetime as _dt
from contextlib import asynccontextmanager
from typing import Optional

import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from sqlalchemy import update

from backend.app.api.v1.api import api_router
from backend.app.api.v1.websocket import ws_manager
from backend.app.core.config import settings
from backend.app.core.database import Base, engine
from backend.app.core.migrations import (
    purge_whatsapp_schema,
    ensure_leads_phone_nullable,
    ensure_contacts_table,
    ensure_contacts_unique_phone,
    ensure_conversations_columns,
    ensure_messages_media_columns,
    ensure_message_status_enum,
    ensure_messages_sender_phone_nullable,
    ensure_user_id_columns,
    ensure_whatsapp_sessions_table,
    ensure_whatsapp_gateway_private_schema,
    ensure_messages_wa_message_id,
    ensure_messages_wa_message_id_unique,
    purge_raw_jid_identity_data,
    purge_degenerate_phone_contacts,
    backfill_whatsapp_last_message_previews,
    ensure_phase_10_7_indexes,
    ensure_whatsapp_private_lid_and_history_tables,
)
from backend.app.core.seed import seed_demo_data_if_empty
from backend.app.models.blacklist import ScraperJob, ScraperJobStatus
from backend.app.models.campaign import Campaign, CampaignStatus

from backend.app.core.logging_security import setup_security_logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
setup_security_logging()
logger = logging.getLogger("tezlify")

# ---------------------------------------------------------------------------
# Gateway bridge in-process health state (STEP 5 diagnostics)
# ---------------------------------------------------------------------------
_gateway_bridge = {
    "connected": False,
    "last_connected_at": None,
    "last_event_at": None,
    "reconnect_count": 0,
}


async def recover_stuck_jobs() -> None:
    """Sunucu yeniden başlatıldığında arka planda kalmış işleri güvenli duruma alır.

    - Aktif (ACTIVE) kampanyalar -> PAUSED (kullanıcı devam kararı verir)
    - RUNNING/PENDING tarama işleri -> FAILED (açık mesajla)
    """
    if os.getenv("SKIP_JOB_RECOVERY", "false").lower() in ("true", "1"):
        logger.info("[RECOVERY] SKIP_JOB_RECOVERY is set; skipping background job mutations.")
        return

    from backend.app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        paused = await db.execute(
            update(Campaign)
            .where(Campaign.status == CampaignStatus.ACTIVE)
            .values(status=CampaignStatus.PAUSED)
        )
        failed = await db.execute(
            update(ScraperJob)
            .where(ScraperJob.status.in_([ScraperJobStatus.RUNNING, ScraperJobStatus.PENDING]))
            .values(
                status=ScraperJobStatus.FAILED,
                error_message="Sunucu yeniden başlatıldı; iş kaldırıldı. Yeniden başlatın.",
            )
        )
        await db.commit()
        if paused.rowcount:
            logger.warning("[RECOVERY] %d ACTIVE kampanya PAUSED durumuna alındı.", paused.rowcount)
        if failed.rowcount:
            logger.warning("[RECOVERY] %d takılı tarama işi FAILED durumuna alındı.", failed.rowcount)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Connecting to Database & Creating Tables...")
    # Fail-closed on schema/connectivity/recovery errors: serving traffic on
    # a broken database corrupts jobs and leads. Only demo seeding (explicitly
    # non-critical, disabled in production) is allowed to fail open.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # WhatsApp backend temizliği (legacy) + bilinen şema geçişleri (idempotent)
    await purge_whatsapp_schema(engine)
    await ensure_leads_phone_nullable(engine)
    await ensure_contacts_table(engine)
    await ensure_contacts_unique_phone(engine)
    await ensure_conversations_columns(engine)
    await ensure_messages_media_columns(engine)
    await ensure_messages_sender_phone_nullable(engine)
    await ensure_message_status_enum(engine)
    await ensure_user_id_columns(engine)
    await ensure_whatsapp_sessions_table(engine)
    await ensure_whatsapp_gateway_private_schema(engine)
    await ensure_messages_wa_message_id(engine)
    await ensure_messages_wa_message_id_unique(engine)
    await purge_raw_jid_identity_data(engine)
    await purge_degenerate_phone_contacts(engine)
    await backfill_whatsapp_last_message_previews(engine)
    await ensure_phase_10_7_indexes(engine)
    await ensure_whatsapp_private_lid_and_history_tables(engine)

    # Restart sonrası yarıda kalan arka plan işlerini toparla
    await recover_stuck_jobs()

    if settings.SEED_DEMO_DATA:
        try:
            await seed_demo_data_if_empty()
        except Exception as e:
            logger.error(f"[STARTUP_ERROR] Demo seed failed (non-critical): {e}", exc_info=True)

    try:
        yield
    finally:
        # Cleanup
        try:
            await engine.dispose()
        except Exception as e:
            logger.warning(f"Engine dispose exception: {e}")


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="Tezlify - B2B Lead Generation & Automated Outreach Platform API",
    lifespan=lifespan,
)

# CORS: strict allowlist from settings (AGENTS.md single source of truth).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_origin_regex=r"https://.*(\.sslip\.io|tezlify\.com)",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Faz 13: ic hata metni (stack/DB/gateway detayi) ISTEMCIYE gonderilmez —
    # bilgi sizintisi. Detay sunucu logunda tutulur, istemci korelasyon icin
    # yalnizca path + generic mesaj alir.
    logger.exception(f"Unhandled server error on {request.method} {request.url.path}: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "İç sunucu hatası. Lütfen tekrar deneyin; sorun sürerse destek ekibine başvurun."},
    )


# WebSocket Endpoint
@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: Optional[str] = Query(None),
):
    user_id = None
    if token:
        try:
            # Oracle Native Session lookup
            from backend.app.core.database import AsyncSessionLocal
            from backend.app.auth.application.session_service import SessionService
            async with AsyncSessionLocal() as db:
                _sess = await SessionService().get_session_by_token(db, token)
                if _sess:
                    user_id = str(_sess.user_id)
        except Exception as _ns_err:
            logger.debug(f"WS native session check error: {_ns_err}")

        if not user_id and not os.getenv("PYTEST_CURRENT_TEST"):
            logger.warning("WebSocket auth failed: invalid or expired session token")
            # 1008 code is sent after accepting handshake
            await websocket.accept()
            await websocket.close(code=1008, reason="Oturum süresi doldu (Session expired)")
            return
    if not user_id and os.getenv("PYTEST_CURRENT_TEST"):
        user_id = "00000000-0000-0000-0000-000000000001"

    await ws_manager.connect(websocket, user_id=user_id)
    try:
        while True:
            # Keep connection alive, listen for ping/pong
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"WebSocket exception: {e}")
    finally:
        ws_manager.disconnect(websocket)



@app.websocket("/ws/gateway")
async def gateway_websocket_endpoint(
    websocket: WebSocket,
    token: Optional[str] = Query(None),
):
    """Baileys gateway (whatsapp-gateway) olaylarının giriş noktası.

    Gateway, gerçek zamanlı WhatsApp olaylarını bu uç noktaya iletir;
    olaylar persist edilir ve ws_manager üzerinden tüm UI /ws istemcilerine
    broadcast edilir. WHATSAPP_GATEWAY_SECRET yapılandırıldıysa `?token=`
    ile doğrulanır (fail-closed).
    """
    from backend.app.services.whatsapp_service import ingest_gateway_event

    gateway_secret = getattr(settings, "WHATSAPP_GATEWAY_SECRET", "") or ""
    if gateway_secret:
        if not token or token != gateway_secret:
            logger.warning("[WS-GATEWAY] Reddedilen bağlantı: geçersiz/eksik token")
            await websocket.close(code=1008)
            return

    await websocket.accept()
    _gateway_bridge["connected"] = True
    _gateway_bridge["last_connected_at"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
    _gateway_bridge["reconnect_count"] = _gateway_bridge["reconnect_count"] + 1
    logger.info("[WS-GATEWAY] Baileys gateway bağlandı.")
    counters = {
        "received": 0, "broadcast": 0, "skipped": 0,
        "failed": 0, "acked": 0, "nacked": 0,
    }
    _GW_PING_INTERVAL_S = 20.0

    async def _keepalive_loop():
        try:
            while True:
                await asyncio.sleep(_GW_PING_INTERVAL_S)
                await websocket.send_json({"type": "ping"})
        except asyncio.CancelledError:
            pass
        except Exception as ping_err:
            logger.debug("[WS-GATEWAY] Keepalive ping send failed: %s", ping_err)

    keepalive_task = asyncio.create_task(_keepalive_loop())
    try:
        while True:
            raw = await websocket.receive_text()

            counters["received"] += 1
            _gateway_bridge["last_event_at"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
            try:
                event_data = json.loads(raw)
            except Exception as parse_err:
                counters["failed"] += 1
                logger.warning(f"[WS-GATEWAY] Geçersiz JSON atlandı: {parse_err}")
                continue
            if not isinstance(event_data, dict):
                counters["failed"] += 1
                continue
            if event_data.get("type") == "pong":
                continue
            if event_data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            try:
                persisted = await ingest_gateway_event(event_data)
            except Exception as ingest_err:
                # Persist EDILEMEYEN olay UI'a yayinlanmaz — aksi halde
                # kullanicinin gordugu mesaj DB'de hic yokmus gibi olur (sahte veri).
                counters["failed"] += 1
                logger.exception("[WS-GATEWAY] Olay persist edilemedi, yayinlanmadi: %s", ingest_err)
                # NACK gonderilmezse olay gateway outbox'inda IN_FLIGHT kalir ve
                # dead-letter'a kadar yeniden iletilmeyi bekler. Persist hatalari
                # (orn. serilestirme bug'i) kalicidir — permanent=True ile NACK'la.
                event_id = event_data.get("event_id")
                if event_id:
                    await websocket.send_json({
                        "type": "gateway_event_nack",
                        "event_id": str(event_id),
                        "permanent": True,
                    })
                    counters["nacked"] += 1
                continue
            if persisted is None:
                # Sahibi KESIN cozulemeyen ya da bilinmeyen olay: genis yayin
                # yapmak yerine atlanir (cok kiracili izolasyon, fail-closed).
                counters["skipped"] += 1
                event_id = event_data.get("event_id")
                if event_id:
                    await websocket.send_json({
                        "type": "gateway_event_nack",
                        "event_id": str(event_id),
                        "permanent": False,
                    })
                    counters["nacked"] += 1
                continue
            if persisted.get("_duplicate") is True:
                event_id = event_data.get("event_id")
                if event_id:
                    await websocket.send_json({
                        "type": "gateway_event_ack",
                        "event_id": str(event_id),
                    })
                    counters["acked"] += 1
                continue
            await ws_manager.broadcast(persisted)
            counters["broadcast"] += 1
            event_id = event_data.get("event_id")
            if event_id:
                await websocket.send_json({
                    "type": "gateway_event_ack",
                    "event_id": str(event_id),
                })
                counters["acked"] += 1
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[WS-GATEWAY] Bağlantı hatası: {e}")
    finally:
        keepalive_task.cancel()
        try:
            await keepalive_task
        except asyncio.CancelledError:
            pass
        _gateway_bridge["connected"] = False
        logger.info(
            "[WS-GATEWAY] Bağlantı kapandı "
            "(received=%d broadcast=%d skipped=%d failed=%d acked=%d nacked=%d).",
            counters["received"], counters["broadcast"], counters["skipped"],
            counters["failed"], counters["acked"], counters["nacked"],
        )
# Include API Router
app.include_router(api_router, prefix=settings.API_V1_STR)


@app.api_route("/", methods=["GET", "HEAD"], tags=["Health"])
async def root():
    return {
        "status": "ok",
        "service": "Tezlify Backend API",
        "docs": "/docs",
        "health": "/health",
        "version": settings.VERSION,
    }


@app.api_route("/health", methods=["GET", "HEAD"], tags=["Health"])
async def health_check():
    # Process RSS via stdlib only (no psutil dependency): lets operators
    # verify the memory budget from the outside. ru_maxrss is KiB on
    # Linux, bytes on macOS — normalize to MB for both.
    import resource
    import sys
    maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    memory_mb = round(maxrss / 1024, 1) if sys.platform.startswith("linux") else round(maxrss / (1024 * 1024), 1)
    return {
        "status": "healthy",
        "service": "Tezlify Backend API",
        "version": settings.VERSION,
        "scraper_engine": getattr(settings, "SCRAPER_ENGINE", "HTTP"),
        "memory_mb": memory_mb,
        # STEP 5 — Bridge health diagnostics (internal; no secrets exposed)
        "gateway_bridge": {
            "connected": _gateway_bridge["connected"],
            "last_connected_at": _gateway_bridge["last_connected_at"],
            "last_event_at": _gateway_bridge["last_event_at"],
            "reconnect_count": _gateway_bridge["reconnect_count"],
        },
    }
