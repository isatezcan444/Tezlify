import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Any, Dict, Optional, Tuple

import httpx
from sqlalchemy import select, delete

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.webhook import WebhookSubscription, WebhookDeliveryLog

logger = logging.getLogger("tezlify.webhook")


class WebhookDispatcher:
    """
    Olayları (lead.created, whatsapp.message_received vb.) kullanıcının tanımladığı
    harici Webhook abonelerine güvenli (HMAC-SHA256 imzalı) ve asenkron iletir.
    """

    @classmethod
    def emit(cls, user_id: Optional[str], event_type: str, data: Dict[str, Any]) -> None:
        """
        Olayı arka planda yangın söndürme prensibiyle (fire-and-forget) fırlatır.
        Ana HTTP isteğini bloklamaz.
        """
        if not user_id:
            return
        asyncio.create_task(cls._dispatch_async(user_id, event_type, data))

    @classmethod
    async def _dispatch_async(cls, user_id: str, event_type: str, data: Dict[str, Any]) -> None:
        try:
            async with AsyncSessionLocal() as db:
                stmt = select(WebhookSubscription).where(
                    WebhookSubscription.user_id == user_id,
                    WebhookSubscription.is_active == True,
                )
                res = await db.execute(stmt)
                subscriptions = res.scalars().all()

                matching_subs = [
                    sub for sub in subscriptions
                    if event_type in (sub.events or []) or "*" in (sub.events or [])
                ]

                if not matching_subs:
                    return

                for sub in matching_subs:
                    await cls._deliver_to_subscription(db, sub, event_type, data)
                await db.commit()
        except Exception as exc:
            logger.warning("[WEBHOOK] Dispatcher genel hatasi: %s", exc)

    @classmethod
    async def _deliver_to_subscription(
        cls,
        db: Any,
        sub: WebhookSubscription,
        event_type: str,
        data: Dict[str, Any]
    ) -> WebhookDeliveryLog:
        delivery_id = str(uuid.uuid4())
        created_at_str = utc_now_naive().isoformat()

        payload = {
            "id": delivery_id,
            "event": event_type,
            "created_at": created_at_str,
            "data": data,
        }
        body_bytes = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        signature = hmac.new(sub.secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Tezlify-Webhook-Dispatcher/1.0",
            "X-Tezlify-Event": event_type,
            "X-Tezlify-Delivery": delivery_id,
            "X-Tezlify-Signature": f"sha256={signature}",
        }

        status_code = None
        response_body = None
        error_msg = None
        is_success = False

        start_time = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=8.0, verify=False) as client:
                res = await client.post(sub.target_url, content=body_bytes, headers=headers)
                status_code = res.status_code
                response_body = res.text[:2000] if res.text else ""
                is_success = 200 <= status_code < 300
        except Exception as http_err:
            error_msg = str(http_err)[:1000]
            is_success = False

        duration_ms = int((time.perf_counter() - start_time) * 1000)

        log = WebhookDeliveryLog(
            subscription_id=sub.id,
            user_id=sub.user_id,
            event_type=event_type,
            payload=payload,
            status_code=status_code,
            response_body=response_body,
            duration_ms=duration_ms,
            is_success=is_success,
            error_message=error_msg,
            created_at=utc_now_naive(),
        )
        db.add(log)
        return log

    @classmethod
    async def send_test_ping(cls, sub: WebhookSubscription) -> Tuple[bool, Optional[int], Optional[str], int, Optional[str]]:
        """Kullanıcının paneldeki 'Test Gönder' butonunu tetiklediğinde tek bir ping iletir."""
        sample_data = {
            "test": True,
            "message": "Tezlify Webhook test gönderimi başarılı!",
            "target_url": sub.target_url,
            "events_subscribed": sub.events,
            "timestamp": utc_now_naive().isoformat(),
        }

        delivery_id = str(uuid.uuid4())
        payload = {
            "id": delivery_id,
            "event": "webhook.test_ping",
            "created_at": utc_now_naive().isoformat(),
            "data": sample_data,
        }
        body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        signature = hmac.new(sub.secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Tezlify-Webhook-Dispatcher/1.0",
            "X-Tezlify-Event": "webhook.test_ping",
            "X-Tezlify-Delivery": delivery_id,
            "X-Tezlify-Signature": f"sha256={signature}",
        }

        start = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=8.0, verify=False) as client:
                res = await client.post(sub.target_url, content=body_bytes, headers=headers)
                duration_ms = int((time.perf_counter() - start) * 1000)
                is_success = 200 <= res.status_code < 300
                return is_success, res.status_code, res.text[:500], duration_ms, None
        except Exception as e:
            duration_ms = int((time.perf_counter() - start) * 1000)
            return False, None, None, duration_ms, str(e)[:500]
