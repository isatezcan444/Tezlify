import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from sqlalchemy import select, update

from backend.app.api.v1.api import api_router
from backend.app.api.v1.websocket import ws_manager
from backend.app.core.config import settings
from backend.app.core.database import Base, engine
from backend.app.core.migrations import (
    ensure_leads_phone_nullable,
    ensure_conversations_columns,
    ensure_messages_media_columns,
    ensure_user_id_columns,
    ensure_whatsapp_session_auth_table,
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
    - RUNNING/PENDING tarama işleri -> FAILED ( açık mesajla)
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

    # Bilinen şema geçişleri (idempotent)
    await ensure_leads_phone_nullable(engine)
    await ensure_conversations_columns(engine)
    await ensure_messages_media_columns(engine)
    await ensure_user_id_columns(engine)
    await ensure_whatsapp_session_auth_table(engine)

    # Restart sonrası yarıda kalan arka plan işlerini toparla
    await recover_stuck_jobs()

    if settings.SEED_DEMO_DATA:
        try:
            await seed_demo_data_if_empty()
        except Exception as e:
            logger.error(f"[STARTUP_ERROR] Demo seed failed (non-critical): {e}", exc_info=True)

    yield
    # Cleanup
    try:
        await engine.dispose()
    except Exception as e:
        logger.warning(f"Engine dispose exception: {e}")


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="Tezlify - B2B Lead Generation & Automated WhatsApp Outreach Platform API",
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
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
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
        "simulation_mode": settings.SIMULATION_MODE,
        "scraper_engine": getattr(settings, "SCRAPER_ENGINE", "HTTP"),
        "memory_mb": memory_mb,
    }
