"""
Canonical Meta WhatsApp Cloud API Webhook Endpoints.

Provides:
- GET /api/v1/whatsapp/webhook: Meta verification challenge handshake.
- POST /api/v1/whatsapp/webhook: Cryptographically verified, fast ACK event ingestion.
"""
import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Header, Response, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.services.whatsapp_webhook_service import WhatsAppWebhookService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("", summary="Meta Webhook Verification Handshake")
@router.get("/", summary="Meta Webhook Verification Handshake", include_in_schema=False)
async def verify_meta_webhook(
    hub_mode: Optional[str] = Query(None, alias="hub.mode"),
    hub_challenge: Optional[str] = Query(None, alias="hub.challenge"),
    hub_verify_token: Optional[str] = Query(None, alias="hub.verify_token"),
):
    """
    GET /api/v1/whatsapp/webhook

    Verification request from Meta when configuring Webhook URL in Meta Developer App Dashboard.
    Validates hub.mode == 'subscribe' and hub.verify_token matches configured token.
    Returns HTTP 200 with raw challenge body if valid. Returns HTTP 403 otherwise.
    """
    challenge = WhatsAppWebhookService.verify_hub_subscription(
        hub_mode=hub_mode,
        hub_verify_token=hub_verify_token,
        hub_challenge=hub_challenge,
    )
    if challenge is not None:
        logger.info("[MetaWebhook] GET verification handshake successful.")
        return Response(content=str(challenge), media_type="text/plain", status_code=200)

    logger.warning(
        "[MetaWebhook] GET verification handshake failed. mode=%s, token_provided=%s",
        hub_mode,
        bool(hub_verify_token),
    )
    raise HTTPException(
        status_code=403,
        detail="Webhook verification failed: Invalid verify token or mode.",
    )


@router.post("", summary="Meta Webhook Event Ingestion")
@router.post("/", summary="Meta Webhook Event Ingestion", include_in_schema=False)
async def receive_meta_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    sync: bool = Query(False),
    x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
    db: AsyncSession = Depends(get_db),
):
    """
    POST /api/v1/whatsapp/webhook

    Canonical ingestion endpoint for Meta WhatsApp Cloud API events:
    1. Reads raw body before JSON parsing.
    2. Validates X-Hub-Signature-256 (HMAC-SHA256). Fails with 403 if invalid.
    3. Persists audit event in WebhookEvent table (status=RECEIVED).
    4. Dispatches async background processing.
    5. Returns fast HTTP 200 to prevent Meta webhook retries.
    """
    raw_body = await request.body()

    return await WhatsAppWebhookService.ingest_raw_event(
        db=db,
        raw_body=raw_body,
        signature_header=x_hub_signature_256,
        background_tasks=background_tasks,
        sync_process=sync,
    )
