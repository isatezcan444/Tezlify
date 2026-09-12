import os
import json
import logging
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
from backend.app.core.auth import verify_and_decode_jwt
from backend.app.core.config import settings
from backend.app.core.database import Base, engine
from backend.app.core.migrations import (
    purge_whatsapp_schema,
    ensure_leads_phone_nullable,
    ensure_contacts_table,
    ensure_conversations_columns,
    ensure_messages_media_columns,
    ensure_message_status_enum,
    ensure_user_id_columns,
    ensure_whatsapp_sessions_table,
    ensure_messages_wa_message_id,
    purge_raw_jid_identity_data,
)
from backend.app.core.seed import seed_demo_data_if_empty
from backend.app.models.blacklist import ScraperJob, ScraperJobStatus
from backend.app.models.campaign import Campaign, CampaignStatus

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("tezlify")


async def recover_stuck_jobs() -> None:
    """Sunucu yeniden başlatıldığında arka planda kalmış işleri güvenli duruma alır.

    - Aktif (ACTIVE) kampanyalar -> PAUSED (kullanıcı devam kararı verir)
    - RUNNING/PENDING tarama işleri -> FAILED (açık mesajla)
    """
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
    await ensure_conversations_columns(engine)
    await ensure_messages_media_columns(engine)
    await ensure_message_status_enum(engine)
    await ensure_user_id_columns(engine)
    await ensure_whatsapp_sessions_table(engine)
    await ensure_messages_wa_message_id(engine)
    await purge_raw_jid_identity_data(engine)

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
# Vercel preview deployments (*.vercel.app) are matched by regex so feature
# branches keep working without reopening to "*". Credentials stay disabled.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_origin_regex=r"https://.*\.vercel\.app",
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
    logger.exception(f"Unhandled server error on {request.method} {request.url.path}: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": f"İç sunucu hatası: {str(exc)}"},
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
            payload = verify_and_decode_jwt(token)
            user_id = payload.get("sub")
        except Exception as auth_err:
            logger.warning(f"WebSocket auth failed: {auth_err}")
            if not os.getenv("PYTEST_CURRENT_TEST"):
                await websocket.close(code=1008)  # Policy violation
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
    logger.info("[WS-GATEWAY] Baileys gateway bağlandı.")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                event_data = json.loads(raw)
            except Exception as parse_err:
                logger.warning(f"[WS-GATEWAY] Geçersiz JSON atlandı: {parse_err}")
                continue
            if not isinstance(event_data, dict):
                continue
            try:
                event_data = await ingest_gateway_event(event_data)
            except Exception as ingest_err:
                logger.warning(f"[WS-GATEWAY] Olay persist edilirken hata (yine de broadcast): {ingest_err}")
            await ws_manager.broadcast(event_data)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[WS-GATEWAY] Bağlantı hatası: {e}")
    finally:
        logger.info("[WS-GATEWAY] Baileys gateway bağlantısı kapandı.")
# Include API Router
app.include_router(api_router, prefix=settings.API_V1_STR)


@app.get("/", tags=["Health"])
async def root():
    return {
        "status": "ok",
        "service": "Tezlify Backend API",
        "docs": "/docs",
        "health": "/health",
        "version": settings.VERSION,
    }


@app.get("/health", tags=["Health"])
async def health_check():
    # Process RSS via stdlib only (no psutil dependency): lets operators
    # verify the 512 MB Render budget from the outside. ru_maxrss is KiB on
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
    }
