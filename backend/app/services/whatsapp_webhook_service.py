"""
Meta WhatsApp Cloud API Webhook Ingestion & Processing Service.

Features:
- Fast 200 ACK with async background event processing.
- Timing-safe HMAC-SHA256 signature verification (X-Hub-Signature-256).
- Deterministic event deduplication and audit logging via WebhookEvent.
- Multi-tenant routing via metadata.phone_number_id -> WhatsAppNumber -> user_id.
- Exact-once Inbound Message ingestion with wa_message_id canonical idempotency.
- Contact resolution by (user_id, phone_e164).
- Multi-number isolated Conversation resolution by (user_id, whatsapp_number_id, contact_id).
- 24-hour customer service window updates via CustomerWindowService.
- Monotonic outbound status progression via MessageStateMachine.
- Realtime domain event emission strictly post-commit.
- Secret redaction: zero tokens or secrets logged or persisted.
"""
import hmac
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.webhook_event import WebhookEvent, WebhookEventStatus
from backend.app.models.whatsapp_number import WhatsAppNumber
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    Message,
    MessageDirection,
    ConversationMessageStatus,
)
from backend.app.models.lead import Lead
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.services.phone_service import PhoneService
from backend.app.services.customer_window_service import CustomerWindowService
from backend.app.services.message_state_machine import (
    MessageStateMachine,
    InvalidMessageStatusTransitionError,
)
from backend.app.services.meta_webhook_parser import (
    MetaWebhookParser,
    NormalizedInboundMessage,
    NormalizedStatusUpdate,
    ParsedWebhookBatch,
)
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)

STATUS_MAP: Dict[str, ConversationMessageStatus] = {
    "sent": ConversationMessageStatus.SENT,
    "delivered": ConversationMessageStatus.DELIVERED,
    "read": ConversationMessageStatus.READ,
    "failed": ConversationMessageStatus.FAILED,
}

LEGACY_STATUS_MAP: Dict[str, MessageStatus] = {
    "sent": MessageStatus.SENT,
    "delivered": MessageStatus.DELIVERED,
    "read": MessageStatus.READ,
    "failed": MessageStatus.FAILED,
}


def sanitize_payload_for_persistence(payload: Any) -> str:
    """
    Serializes payload to JSON while aggressively redacting any potential
    credentials, tokens, or app secrets as a defense-in-depth measure.
    """
    if isinstance(payload, bytes):
        try:
            payload = json.loads(payload.decode("utf-8"))
        except Exception:
            return "[non-json binary payload]"

    sensitive_keys = {"token", "secret", "authorization", "app_secret", "access_token"}

    def _sanitize(obj: Any) -> Any:
        if isinstance(obj, dict):
            return {
                k: ("[REDACTED]" if any(s in k.lower() for s in sensitive_keys) else _sanitize(v))
                for k, v in obj.items()
            }
        elif isinstance(obj, list):
            return [_sanitize(item) for item in obj]
        return obj

    try:
        sanitized = _sanitize(payload)
        return json.dumps(sanitized)
    except Exception:
        return "[serialization error]"


class WhatsAppWebhookService:
    """Production service for Meta WhatsApp Cloud API webhooks."""

    @classmethod
    def verify_hub_signature(
        cls,
        raw_body: bytes,
        signature_header: Optional[str],
        app_secret: Optional[str] = None,
    ) -> bool:
        """
        Validates X-Hub-Signature-256 header using timing-safe comparison against META_APP_SECRET.
        App Secret is NEVER logged or exposed.
        """
        secret = (app_secret if app_secret is not None else settings.effective_meta_app_secret)
        if not secret:
            # In test mode or when no secret is configured, fail-closed
            logger.warning("[WhatsAppWebhookService] META_APP_SECRET is empty. Rejecting signature verification.")
            return False

        if not signature_header or not signature_header.startswith("sha256="):
            return False

        expected_hash = hmac.new(
            key=secret.encode("utf-8"),
            msg=raw_body,
            digestmod=hashlib.sha256,
        ).hexdigest()

        expected_sig = f"sha256={expected_hash}"
        return hmac.compare_digest(signature_header.strip(), expected_sig)

    @classmethod
    def verify_hub_subscription(
        cls,
        hub_mode: Optional[str],
        hub_verify_token: Optional[str],
        hub_challenge: Optional[str],
        configured_token: Optional[str] = None,
    ) -> Optional[str]:
        """
        Validates Meta's GET verification handshake.
        Returns the challenge string on success, or None on failure.
        """
        token_to_match = (
            configured_token if configured_token is not None else settings.effective_meta_verify_token
        )
        if not token_to_match:
            logger.warning("[WhatsAppWebhookService] META_WEBHOOK_VERIFY_TOKEN is not configured.")
            return None

        if hub_mode == "subscribe" and hub_verify_token == token_to_match and hub_challenge:
            return hub_challenge
        return None

    @classmethod
    async def ingest_raw_event(
        cls,
        db: AsyncSession,
        raw_body: bytes,
        signature_header: Optional[str],
        background_tasks: Optional[BackgroundTasks] = None,
        sync_process: bool = False,
    ) -> Dict[str, Any]:
        """
        Fast ACK ingestion barrier:
        1. Validates cryptographic signature (HTTP 403 on failure).
        2. Computes payload SHA-256 event_hash.
        3. Parses raw JSON safely (HTTP 200 on malformed to prevent retry storm).
        4. Verifies envelope object == 'whatsapp_business_account'.
        5. Persists WebhookEvent with status=RECEIVED.
        6. Dispatches async processing.
        7. Returns HTTP 200 immediately.
        """
        # 1. Cryptographic Signature Verification
        if not cls.verify_hub_signature(raw_body, signature_header):
            logger.warning("[WhatsAppWebhookService] Rejected webhook: Invalid X-Hub-Signature-256.")
            raise HTTPException(status_code=403, detail="Invalid webhook signature.")

        # 2. SHA-256 Event Hash
        event_hash = hashlib.sha256(raw_body).hexdigest()

        # Check if identical webhook delivery already recorded (idempotency barrier)
        existing_evt_stmt = select(WebhookEvent).where(WebhookEvent.event_hash == event_hash)
        existing_evt = (await db.execute(existing_evt_stmt)).scalar_one_or_none()
        if existing_evt:
            logger.info("[WhatsAppWebhookService] Webhook event %s already exists (status=%s)", event_hash, existing_evt.status)
            return {"status": "duplicate", "event_id": existing_evt.id, "event_hash": event_hash}

        # 3. JSON Parse
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception as e:
            logger.error("[WhatsAppWebhookService] Malformed JSON payload received: %s", e)
            # Record failed event and return non-error response to avoid retry loop
            evt = WebhookEvent(
                provider="META",
                event_type="malformed_json",
                event_hash=event_hash,
                status=WebhookEventStatus.FAILED,
                failure_reason=f"Malformed JSON: {str(e)}",
                payload_json=raw_body[:500].decode("utf-8", errors="replace"),
                received_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(evt)
            await db.commit()
            return {"status": "error", "message": "Malformed JSON"}

        # 4. Minimal Envelope Validation
        object_type = payload.get("object") if isinstance(payload, dict) else None
        if object_type != "whatsapp_business_account":
            logger.warning("[WhatsAppWebhookService] Non-whatsapp object received: %s", object_type)
            evt = WebhookEvent(
                provider="META",
                event_type="invalid_object",
                event_hash=event_hash,
                status=WebhookEventStatus.PROCESSED,
                failure_reason=f"Ignored non-whatsapp object: {object_type}",
                payload_json=sanitize_payload_for_persistence(payload),
                received_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(evt)
            await db.commit()
            return {"status": "ignored", "reason": "Invalid object type"}

        # Parse batch preview to find primary wamid and event_type
        batch = MetaWebhookParser.parse_payload(payload)
        first_wamid = None
        event_type = "unknown"
        if batch.messages:
            first_wamid = batch.messages[0].wa_message_id
            event_type = "messages"
        elif batch.statuses:
            first_wamid = batch.statuses[0].wa_message_id
            event_type = "statuses"

        sanitized_payload = sanitize_payload_for_persistence(payload)
        webhook_event = WebhookEvent(
            provider="META",
            event_type=event_type,
            event_hash=event_hash,
            external_message_id=first_wamid,
            status=WebhookEventStatus.RECEIVED,
            payload_json=sanitized_payload,
            received_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(webhook_event)
        await db.commit()
        await db.refresh(webhook_event)

        # 6. Dispatch Async Processing
        if sync_process:
            # Immediate synchronous execution (useful for integration test environments)
            await cls.process_webhook_event(webhook_event.id, payload, db_override=db)
        elif background_tasks:
            background_tasks.add_task(cls.process_webhook_event, webhook_event.id, payload)
        else:
            # Default to background execution without blocking HTTP response
            import asyncio
            asyncio.create_task(cls.process_webhook_event(webhook_event.id, payload))

        # 7. Fast HTTP 200 response
        return {
            "status": "received",
            "event_id": webhook_event.id,
            "event_hash": event_hash,
        }

    @classmethod
    async def process_webhook_event(
        cls,
        event_id: int,
        payload: Dict[str, Any],
        db_override: Optional[AsyncSession] = None,
    ) -> Dict[str, Any]:
        """
        Asynchronous domain processor:
        - Resolves tenant via metadata.phone_number_id -> WhatsAppNumber.user_id.
        - Ignores events from unknown phone numbers without mutating domain records.
        - Ingests inbound messages (idempotent on wa_message_id).
        - Ingests status updates (monotonic state progression).
        - Emits realtime events ONLY after database transaction commits.
        """
        if db_override is not None:
            return await cls._execute_processing(event_id, payload, db_override)

        async with AsyncSessionLocal() as session:
            return await cls._execute_processing(event_id, payload, session)

    @classmethod
    async def _execute_processing(
        cls,
        event_id: int,
        payload: Dict[str, Any],
        db: AsyncSession,
    ) -> Dict[str, Any]:
        webhook_event = await db.get(WebhookEvent, event_id)
        if not webhook_event:
            logger.warning("[WhatsAppWebhookService] WebhookEvent %d not found for processing.", event_id)
            return {"status": "not_found"}

        webhook_event.status = WebhookEventStatus.PROCESSING
        await db.commit()

        batch = MetaWebhookParser.parse_payload(payload)

        # In-memory accumulator for domain events to emit strictly AFTER db commit
        pending_realtime_events: List[Dict[str, Any]] = []

        try:
            has_duplicate = False
            all_ignored = True if (batch.messages or batch.statuses) else False

            # Step A: Process inbound messages
            for msg in batch.messages:
                res = await cls._process_single_inbound_message(db, msg, pending_realtime_events)
                if res.get("user_id") and not webhook_event.user_id:
                    webhook_event.user_id = res["user_id"]
                if res.get("status") == "duplicate_message":
                    has_duplicate = True
                if res.get("status") != "ignored":
                    all_ignored = False
                elif not webhook_event.failure_reason:
                    webhook_event.failure_reason = f"Ignored: {res.get('reason')} ({msg.phone_number_id})"

            # Step B: Process outbound message status updates
            for st in batch.statuses:
                res = await cls._process_single_status_update(db, st, pending_realtime_events)
                if res.get("user_id") and not webhook_event.user_id:
                    webhook_event.user_id = res["user_id"]
                if res.get("status") not in ("ignored", "orphan"):
                    all_ignored = False
                elif res.get("status") == "orphan" and not webhook_event.failure_reason:
                    webhook_event.failure_reason = f"Orphan status for wamid: {st.wa_message_id}"

            # Step C: If there were no routed records and batch had unknown phone_number_ids
            if not batch.messages and not batch.statuses and batch.phone_number_ids:
                for pid in batch.phone_number_ids:
                    wanum_stmt = select(WhatsAppNumber).where(WhatsAppNumber.phone_number_id == pid)
                    wanum = (await db.execute(wanum_stmt)).scalar_one_or_none()
                    if not wanum:
                        webhook_event.failure_reason = f"Unknown phone_number_id: {pid}"

            # Step D: Commit database transaction
            if has_duplicate and not pending_realtime_events:
                webhook_event.status = WebhookEventStatus.DUPLICATE
            else:
                webhook_event.status = WebhookEventStatus.PROCESSED
            webhook_event.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            await db.commit()

        except IntegrityError as ie:
            await db.rollback()
            logger.warning("[WhatsAppWebhookService] Caught IntegrityError during webhook processing (likely race condition duplicate): %s", ie)
            webhook_event.status = WebhookEventStatus.DUPLICATE
            webhook_event.failure_reason = f"IntegrityError (Concurrent Duplicate): {str(ie)}"
            webhook_event.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            try:
                await db.commit()
            except Exception:
                await db.rollback()
            # Invariant: NO realtime events emitted if transaction rolled back
            return {"status": "duplicate_race_condition"}

        except Exception as e:
            await db.rollback()
            logger.error("[WhatsAppWebhookService] Exception processing webhook event %d: %s", event_id, e, exc_info=True)
            webhook_event.status = WebhookEventStatus.FAILED
            webhook_event.failure_reason = str(e)
            webhook_event.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            try:
                await db.commit()
            except Exception:
                await db.rollback()
            # Invariant: NO realtime events emitted on failure
            return {"status": "failed", "error": str(e)}

        # Step E: Emit realtime events ONLY AFTER successful commit
        for event in pending_realtime_events:
            try:
                await ws_manager.broadcast(event)
            except Exception as ws_err:
                logger.warning("[WhatsAppWebhookService] Failed to broadcast realtime event: %s", ws_err)

        return {
            "status": "processed",
            "messages_count": len(batch.messages),
            "statuses_count": len(batch.statuses),
        }

    @classmethod
    async def _process_single_inbound_message(
        cls,
        db: AsyncSession,
        msg: NormalizedInboundMessage,
        pending_realtime_events: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Processes a single inbound WhatsApp message with full multi-tenant isolation,
        idempotency check, contact resolution, conversation resolution, and 24h customer window.
        """
        # 1. Canonical Tenant Routing: metadata.phone_number_id -> WhatsAppNumber
        if not msg.phone_number_id:
            logger.warning("[WhatsAppWebhookService] Missing phone_number_id in incoming message %s", msg.wa_message_id)
            return {"status": "unrouted", "reason": "No phone_number_id"}

        wanum_stmt = select(WhatsAppNumber).where(
            WhatsAppNumber.phone_number_id == msg.phone_number_id,
            WhatsAppNumber.deleted_at.is_(None),
        )
        wanum = (await db.execute(wanum_stmt)).scalar_one_or_none()
        if not wanum:
            logger.warning(
                "[WhatsAppWebhookService] Unknown phone_number_id %s. Webhook ignored without mutating domain.",
                msg.phone_number_id,
            )
            return {"status": "ignored", "reason": "Unknown phone_number_id"}

        tenant_user_id = wanum.user_id

        # 2. Canonical Message Idempotency: messages.wa_message_id == msg.wa_message_id
        existing_msg_stmt = select(Message).where(Message.wa_message_id == msg.wa_message_id)
        existing_msg = (await db.execute(existing_msg_stmt)).scalar_one_or_none()
        if existing_msg:
            logger.info(
                "[WhatsAppWebhookService] Duplicate inbound message ignored: wamid=%s",
                msg.wa_message_id,
            )
            return {
                "status": "duplicate_message",
                "wa_message_id": msg.wa_message_id,
                "user_id": tenant_user_id,
            }

        # 3. Contact Resolution: (user_id, phone_e164)
        phone_data = PhoneService.normalize_to_e164(msg.from_phone)
        sender_e164 = phone_data["e164"] if (phone_data and phone_data["is_valid"]) else msg.from_phone

        contact_stmt = select(Contact).where(
            Contact.user_id == tenant_user_id,
            Contact.phone_e164 == sender_e164,
        )
        contact = (await db.execute(contact_stmt)).scalar_one_or_none()

        if not contact:
            # Check if matching Lead exists in the same tenant to connect
            lead_stmt = select(Lead.id).where(
                Lead.user_id == tenant_user_id,
                Lead.phone_e164 == sender_e164,
            )
            lead_id = (await db.execute(lead_stmt)).scalar_one_or_none()

            display_name = msg.sender_name or sender_e164
            contact = Contact(
                user_id=tenant_user_id,
                phone_e164=sender_e164,
                display_name=display_name,
                whatsapp_profile_name=msg.sender_name,
                lead_id=lead_id,
            )
            db.add(contact)
            await db.flush()
        else:
            # Update profile name if available
            if msg.sender_name:
                contact.whatsapp_profile_name = msg.sender_name
                if not contact.display_name or contact.display_name == contact.phone_e164:
                    contact.display_name = msg.sender_name

        # 4. Multi-Number Conversation Resolution: (user_id, whatsapp_number_id, contact_id)
        conv_stmt = select(Conversation).where(
            Conversation.user_id == tenant_user_id,
            Conversation.whatsapp_number_id == wanum.id,
            Conversation.contact_id == contact.id,
        )
        conv = (await db.execute(conv_stmt)).scalar_one_or_none()

        # TIMESTAMP WITHOUT TIME ZONE columns: asyncpg rejects tz-aware values.
        _raw_ts = msg.timestamp or datetime.now(timezone.utc).replace(tzinfo=None)
        msg_time = (
            _raw_ts.astimezone(timezone.utc).replace(tzinfo=None)
            if _raw_ts.tzinfo is not None
            else _raw_ts
        )

        if not conv:
            conv = Conversation(
                user_id=tenant_user_id,
                whatsapp_number_id=wanum.id,
                contact_id=contact.id,
                lead_id=contact.lead_id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                unread_count=1,
                last_message_at=msg_time,
                last_message_preview=msg.body,
            )
            db.add(conv)
            await db.flush()
        else:
            if conv.status != ConversationStatus.ACTIVE:
                conv.status = ConversationStatus.ACTIVE
            conv.unread_count = (conv.unread_count or 0) + 1
            conv.last_message_at = msg_time
            conv.last_message_preview = msg.body

        # 5. Customer 24-Hour Window Update
        CustomerWindowService.update_conversation_window(conv, msg_time)

        # 6. Insert Inbound Message Entity
        new_msg = Message(
            user_id=tenant_user_id,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=msg.message_type,
            body=msg.body,
            wa_message_id=msg.wa_message_id,
            media_id=msg.media_id,
            media_mime_type=msg.media_mime_type,
            media_filename=msg.media_filename,
            media_caption=msg.media_caption,
            sender_phone=sender_e164,
            recipient_phone=wanum.display_phone_number or wanum.phone_number_e164,
            sender_name=msg.sender_name or contact.display_name,
            status=ConversationMessageStatus.RECEIVED,
            external_timestamp=msg_time,
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(new_msg)

        # 7. Queue Realtime Domain Event (to be broadcast AFTER commit)
        pending_realtime_events.append({
            "event": "inbound_reply",
            "provider": "META",
            "user_id": str(tenant_user_id) if tenant_user_id else None,
            "whatsapp_number_id": wanum.id,
            "conversation_id": conv.id,
            "contact_id": contact.id,
            "message_id": msg.wa_message_id,
            "wa_message_id": msg.wa_message_id,
            "phone": sender_e164,
            "sender_name": contact.display_name,
            "message": msg.body,
            "message_type": msg.message_type.value,
            "media_id": msg.media_id,
            "media_mime_type": msg.media_mime_type,
            "media_filename": msg.media_filename,
            "media_caption": msg.media_caption,
            "unread_count": conv.unread_count,
            "timestamp": msg_time.isoformat(),
        })

        return {
            "status": "created",
            "user_id": tenant_user_id,
            "conversation_id": conv.id,
            "wa_message_id": msg.wa_message_id,
        }

    @classmethod
    async def _process_single_status_update(
        cls,
        db: AsyncSession,
        st: NormalizedStatusUpdate,
        pending_realtime_events: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Processes an outbound message delivery status update (sent, delivered, read, failed).
        Enforces monotonic state progression via MessageStateMachine.
        """
        # Lookup message by wa_message_id
        msg_stmt = select(Message).where(Message.wa_message_id == st.wa_message_id)
        msg = (await db.execute(msg_stmt)).scalar_one_or_none()

        if not msg:
            logger.info(
                "[WhatsAppWebhookService] Orphan status received for wamid: %s (status: %s)",
                st.wa_message_id,
                st.status,
            )
            return {"status": "orphan", "wa_message_id": st.wa_message_id}

        target_status = STATUS_MAP.get(st.status.lower())
        if not target_status:
            logger.warning("[WhatsAppWebhookService] Unknown status string: %s", st.status)
            return {"status": "ignored", "reason": f"Unknown status: {st.status}"}

        # Apply state transition via domain state machine
        try:
            MessageStateMachine.transition(
                msg,
                target_status=target_status,
                event_time=st.timestamp,
                error_code=st.error_code,
                error_message=st.error_message,
            )
        except InvalidMessageStatusTransitionError as e:
            logger.info(
                "[WhatsAppWebhookService] Non-monotonic status regression rejected (%s -> %s): %s",
                msg.status.value,
                target_status.value,
                e,
            )
            return {
                "status": "regression_skipped",
                "current_status": msg.status.value,
                "target_status": target_status.value,
            }

        # Also update legacy MessageLog if present
        log_stmt = select(MessageLog).where(MessageLog.wa_message_id == st.wa_message_id)
        msg_log = (await db.execute(log_stmt)).scalars().first()
        if msg_log:
            legacy_target = LEGACY_STATUS_MAP.get(st.status.lower())
            if legacy_target:
                msg_log.status = legacy_target
                if legacy_target == MessageStatus.FAILED and st.error_message:
                    msg_log.error_reason = f"Meta Error ({st.error_code}): {st.error_message}"

        # Queue realtime status event
        pending_realtime_events.append({
            "event": "message_status_updated",
            "provider": "META",
            "user_id": str(msg.user_id) if msg.user_id else None,
            "message_id": st.wa_message_id,
            "wa_message_id": st.wa_message_id,
            "conversation_id": msg.conversation_id,
            "status": target_status.value,
            "error_code": st.error_code,
            "error_message": st.error_message,
            "timestamp": (st.timestamp or datetime.now(timezone.utc)).isoformat(),
        })

        return {
            "status": "updated",
            "user_id": msg.user_id,
            "wa_message_id": st.wa_message_id,
            "new_status": target_status.value,
        }

    @classmethod
    async def recover_unprocessed_events(
        cls,
        batch_size: int = 20,
        db_override: Optional[AsyncSession] = None,
    ) -> int:
        """
        Durable webhook recovery mechanism (Section 28):
        Scans for WebhookEvents left in RECEIVED or PROCESSING status due to
        server crashes, reboots, or task interruptions, and reliably processes them.
        """
        async def _recover_in_session(db: AsyncSession) -> int:
            stmt = (
                select(WebhookEvent)
                .where(
                    WebhookEvent.status.in_([
                        WebhookEventStatus.RECEIVED,
                        WebhookEventStatus.PROCESSING,
                    ])
                )
                .order_by(WebhookEvent.received_at.asc())
                .limit(batch_size)
            )
            events = (await db.execute(stmt)).scalars().all()
            if not events:
                return 0

            processed_count = 0
            for evt in events:
                try:
                    payload = json.loads(evt.payload_json) if evt.payload_json else {}
                    if not payload:
                        evt.status = WebhookEventStatus.FAILED
                        evt.failure_reason = "Missing or empty payload_json in recovery"
                        await db.commit()
                        continue
                    await cls._execute_processing(evt.id, payload, db)
                    processed_count += 1
                except Exception as exc:
                    logger.error("[WhatsAppWebhookService] Recovery failed for WebhookEvent %d: %s", evt.id, exc)
                    evt.status = WebhookEventStatus.FAILED
                    evt.failure_reason = f"Recovery error: {str(exc)}"
                    await db.commit()

            return processed_count

        if db_override is not None:
            return await _recover_in_session(db_override)

        async with AsyncSessionLocal() as session:
            return await _recover_in_session(session)
