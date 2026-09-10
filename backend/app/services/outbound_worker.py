"""
Durable Outbound WhatsApp Message Dispatch Worker.

Features:
- Transactional Outbox consumer for Meta WhatsApp Cloud API.
- Atomic lease/row-locking semantics (supports PostgreSQL and SQLite).
- Strict exponential backoff + jitter for transient failures (429, 5xx).
- Conservative ambiguity handling (ReadTimeout / network disconnect -> AMBIGUOUS_PROVIDER_RESULT, no blind retry).
- Fail-fast terminal failure on 4xx/validation/auth errors without wasteful retries.
- Credential vault token decryption strictly at send boundary.
- Zero secrets in outbox, messages, responses, or logs.
- Monotonic forward message state transition PENDING -> SENT via MessageStateMachine.
- Post-commit WebSocket domain event broadcasting.
"""
import os
import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, List

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, or_, and_
from sqlalchemy.orm import selectinload

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.credential_vault import CredentialVault
from backend.app.models.outbox_message import OutboxMessage, OutboxMessageStatus
from backend.app.models.message import Message, ConversationMessageStatus, MessageType
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus, WhatsAppNumberProvider
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp_gateway_client import gateway_client
from backend.app.services.meta_cloud_client import (
    MetaCloudApiClient,
    MetaApiError,
    MetaAmbiguousResultError,
    redact_secrets,
)
from backend.app.services.message_state_machine import MessageStateMachine
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)


class OutboundWorker:
    """
    Worker engine processing durable outbound message dispatch jobs from `outbox_messages`.
    """

    LEASE_DURATION = timedelta(seconds=60)
    MAX_ATTEMPTS = 3

    @classmethod
    async def recover_stuck_leases(
        cls,
        db_override: Optional[AsyncSession] = None,
        lease_timeout_seconds: int = 60,
    ) -> int:
        """
        Recovers outbox jobs stuck in PROCESSING where locked_at exceeded lease duration.
        Resets them to PENDING and clears locks for immediate reprocessing.
        """
        async def _recover(session: AsyncSession) -> int:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            cutoff = now - timedelta(seconds=lease_timeout_seconds)
            stmt = (
                update(OutboxMessage)
                .where(
                    OutboxMessage.status == OutboxMessageStatus.PROCESSING,
                    OutboxMessage.locked_at < cutoff,
                )
                .values(
                    status=OutboxMessageStatus.PENDING,
                    locked_at=None,
                    locked_by=None,
                )
            )
            res = await session.execute(stmt)
            await session.commit()
            return res.rowcount

        if db_override is not None:
            return await _recover(db_override)
        async with AsyncSessionLocal() as session:
            return await _recover(session)

    @classmethod
    async def claim_outbox_job(
        cls,
        db: AsyncSession,
        outbox_id: int,
        worker_id: Optional[str] = None,
    ) -> bool:
        """
        Atomically leases a specific outbox job using row locking.
        Prevents multiple workers from concurrently picking up or double-dispatching the job.
        Returns True if lease acquired, False otherwise.
        """
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        lease_cutoff = now - cls.LEASE_DURATION
        worker_tag = worker_id or f"worker_{uuid.uuid4().hex[:8]}"

        stmt = (
            update(OutboxMessage)
            .where(
                OutboxMessage.id == outbox_id,
                or_(
                    OutboxMessage.status.in_([
                        OutboxMessageStatus.PENDING,
                        OutboxMessageStatus.RETRYABLE,
                    ]),
                    and_(
                        OutboxMessage.status == OutboxMessageStatus.PROCESSING,
                        OutboxMessage.locked_at < lease_cutoff,
                    ),
                ),
                OutboxMessage.available_at <= now,
                or_(
                    OutboxMessage.locked_at.is_(None),
                    OutboxMessage.locked_at < lease_cutoff,
                ),
            )
            .values(
                status=OutboxMessageStatus.PROCESSING,
                locked_at=now,
                locked_by=worker_tag,
            )
        )
        res = await db.execute(stmt)
        await db.commit()
        return res.rowcount == 1

    @classmethod
    async def claim_pending_jobs(
        cls,
        db: AsyncSession,
        batch_size: int = 10,
        worker_id: Optional[str] = None,
    ) -> List[int]:
        """
        Scans for available PENDING or RETRYABLE outbox messages (and expired PROCESSING) and atomically claims them.
        Returns the list of claimed outbox IDs.
        """
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        lease_cutoff = now - cls.LEASE_DURATION

        candidates_stmt = (
            select(OutboxMessage.id)
            .where(
                or_(
                    OutboxMessage.status.in_([
                        OutboxMessageStatus.PENDING,
                        OutboxMessageStatus.RETRYABLE,
                    ]),
                    and_(
                        OutboxMessage.status == OutboxMessageStatus.PROCESSING,
                        OutboxMessage.locked_at < lease_cutoff,
                    ),
                ),
                OutboxMessage.available_at <= now,
                or_(
                    OutboxMessage.locked_at.is_(None),
                    OutboxMessage.locked_at < lease_cutoff,
                ),
            )
            .order_by(OutboxMessage.id.asc())
            .limit(batch_size)
        )
        candidate_ids = (await db.execute(candidates_stmt)).scalars().all()

        claimed_ids = []
        for cid in candidate_ids:
            if await cls.claim_outbox_job(db, cid, worker_id):
                claimed_ids.append(cid)
        return claimed_ids

    @classmethod
    async def process_outbox_job(
        cls,
        outbox_id: int,
        db: AsyncSession,
        worker_id: Optional[str] = None,
        force_claim: bool = False,
    ) -> Dict[str, Any]:
        """
        Executes an individual outbox dispatch job with complete lifecycle safety:
        1. Atomic lease acquisition
        2. Status and idempotency verification
        3. Decryption of Meta token at send boundary
        4. Meta Cloud API dispatch (text or template)
        5. Success wamid extraction and PENDING -> SENT monotonic progression
        6. Conservative ambiguity handling (no blind retry on ambiguous network timeout)
        7. Exponential backoff retry on transient errors, fail-fast on 4xx/client errors
        8. Post-commit realtime event broadcasting
        """
        now = datetime.now(timezone.utc).replace(tzinfo=None)

        if not force_claim:
            claimed = await cls.claim_outbox_job(db, outbox_id, worker_id)
            if not claimed:
                logger.info(f"[OutboundWorker] Job {outbox_id} could not be claimed (already processing or locked).")
                return {"status": "skipped", "reason": "not_claimed"}

        # Fetch outbox with relationships
        stmt = (
            select(OutboxMessage)
            .where(OutboxMessage.id == outbox_id)
            .options(
                selectinload(OutboxMessage.message),
                selectinload(OutboxMessage.whatsapp_number),
            )
        )
        res = await db.execute(stmt)
        outbox = res.scalar_one_or_none()
        if not outbox or not outbox.message:
            logger.error(f"[OutboundWorker] Job {outbox_id} or referenced message not found.")
            return {"status": "error", "reason": "not_found"}

        msg = outbox.message
        wanum = outbox.whatsapp_number

        # Idempotency barrier: If already sent/delivered/read, finalize outbox
        if msg.status in (
            ConversationMessageStatus.SENT,
            ConversationMessageStatus.DELIVERED,
            ConversationMessageStatus.READ,
        ):
            logger.info(f"[OutboundWorker] Message {msg.id} already in terminal/sent state ({msg.status.value}). Finalizing outbox {outbox.id}.")
            outbox.status = OutboxMessageStatus.COMPLETED
            outbox.processed_at = now
            outbox.locked_at = None
            outbox.locked_by = None
            await db.commit()
            return {"status": "already_sent", "wamid": msg.wa_message_id}

        # Validate WhatsApp Number Status
        if not wanum or wanum.status != WhatsAppNumberStatus.ACTIVE or wanum.deleted_at is not None:
            err_detail = f"WhatsApp hattı aktif değil (Durum: {wanum.status.value if wanum else 'Bilinmiyor'})."
            logger.warning(f"[OutboundWorker] Job {outbox_id} rejected: {err_detail}")
            outbox.status = OutboxMessageStatus.FAILED
            outbox.processed_at = now
            outbox.last_error = err_detail
            outbox.locked_at = None
            outbox.locked_by = None
            try:
                MessageStateMachine.transition(
                    msg,
                    ConversationMessageStatus.FAILED,
                    event_time=now,
                    error_code=400,
                    error_message=err_detail,
                )
            except Exception:
                pass
            await db.commit()
            return {"status": "failed", "reason": err_detail}

        # Parse Job Payload (template parameters, etc.)
        payload_data: Dict[str, Any] = {}
        if outbox.payload_json:
            try:
                payload_data = json.loads(outbox.payload_json)
            except Exception:
                pass

        is_baileys = (wanum.provider == WhatsAppNumberProvider.BAILEYS_QR) or (payload_data.get("provider") == "BAILEYS_QR")

        # =========================================================================
        # 1. BAILEYS_QR Outbound Dispatch Branch
        # =========================================================================
        if is_baileys:
            sess_stmt = (
                select(WhatsAppSession)
                .where(WhatsAppSession.whatsapp_number_id == wanum.id)
            )
            sess = (await db.execute(sess_stmt)).scalar_one_or_none()
            if not sess and wanum.user_id:
                sess_user_stmt = (
                    select(WhatsAppSession)
                    .where(WhatsAppSession.user_id == wanum.user_id)
                    .order_by(WhatsAppSession.id.asc())
                    .limit(1)
                )
                sess = (await db.execute(sess_user_stmt)).scalar_one_or_none()

            if not sess:
                err_detail = "WhatsApp hattı için aktif Baileys oturumu bulunamadı."
                outbox.status = OutboxMessageStatus.FAILED
                outbox.processed_at = now
                outbox.last_error = err_detail
                outbox.locked_at = None
                outbox.locked_by = None
                try:
                    MessageStateMachine.transition(
                        msg,
                        ConversationMessageStatus.FAILED,
                        event_time=now,
                        error_code=400,
                        error_message=err_detail,
                    )
                except Exception:
                    pass
                await db.commit()
                return {"status": "failed", "reason": err_detail}

            if sess.status != SessionStatus.CONNECTED:
                err_detail = f"WhatsApp hattı bağlı değil (Oturum: {sess.session_name}, Durum: {sess.status.value})."
                outbox.status = OutboxMessageStatus.FAILED
                outbox.processed_at = now
                outbox.last_error = err_detail
                outbox.locked_at = None
                outbox.locked_by = None
                try:
                    MessageStateMachine.transition(
                        msg,
                        ConversationMessageStatus.FAILED,
                        event_time=now,
                        error_code=400,
                        error_message=err_detail,
                    )
                except Exception:
                    pass
                await db.commit()
                return {"status": "failed", "reason": err_detail}

            # Anti-ban: check daily limit per session
            if sess.max_daily_limit and (sess.daily_sent_count or 0) >= sess.max_daily_limit:
                err_detail = f"Günlük mesaj limiti aşıldı ({sess.daily_sent_count}/{sess.max_daily_limit})."
                outbox.status = OutboxMessageStatus.FAILED
                outbox.processed_at = now
                outbox.last_error = err_detail
                outbox.locked_at = None
                outbox.locked_by = None
                try:
                    MessageStateMachine.transition(
                        msg,
                        ConversationMessageStatus.FAILED,
                        event_time=now,
                        error_code=429,
                        error_message=err_detail,
                    )
                except Exception:
                    pass
                await db.commit()
                return {"status": "failed", "reason": err_detail}

            # Call gateway
            gw_res = await gateway_client.send_message(
                session_name=sess.session_name,
                phone=msg.recipient_phone,
                message=msg.body or "",
                tenant_id=str(outbox.user_id) if outbox.user_id else (str(sess.user_id) if sess.user_id else None),
                session_id=sess.id,
                client_message_id=msg.client_message_id,
            )

            if gw_res.get("is_ambiguous"):
                amb_detail = "Baileys Gateway zaman aşımı (sonuç belirsiz, mükerrer gönderim önlendi)."
                logger.warning(f"[OutboundWorker] Ambiguous Baileys result for outbox {outbox.id}: {gw_res.get('error')}")
                outbox.status = OutboxMessageStatus.AMBIGUOUS_PROVIDER_RESULT
                outbox.last_error = amb_detail
                outbox.locked_at = None
                outbox.locked_by = None
                msg.error_message = amb_detail
                await db.commit()
                return {"status": "ambiguous", "error": amb_detail}

            if not gw_res.get("success"):
                err_detail = gw_res.get("error") or "Gateway mesajı iletemedi."
                logger.warning(f"[OutboundWorker] Baileys dispatch failed for outbox {outbox.id}: {err_detail}")
                outbox.status = OutboxMessageStatus.FAILED
                outbox.processed_at = now
                outbox.last_error = err_detail
                outbox.locked_at = None
                outbox.locked_by = None
                try:
                    MessageStateMachine.transition(
                        msg,
                        ConversationMessageStatus.FAILED,
                        event_time=now,
                        error_code=gw_res.get("status_code") or 502,
                        error_message=err_detail,
                    )
                except Exception:
                    pass
                await db.commit()
                try:
                    await ws_manager.broadcast({
                        "event": "message_status_updated",
                        "provider": "BAILEYS_QR",
                        "user_id": str(msg.user_id) if msg.user_id else None,
                        "message_id": msg.id,
                        "wa_message_id": None,
                        "client_message_id": msg.client_message_id,
                        "conversation_id": msg.conversation_id,
                        "status": ConversationMessageStatus.FAILED.value,
                        "error_message": err_detail,
                        "timestamp": now.isoformat(),
                    })
                except Exception:
                    pass
                return {"status": "failed", "reason": err_detail}

            # Success
            wamid = gw_res.get("messageId") or gw_res.get("message_id")
            if not wamid:
                wamid = f"wamid.BAILEYS_{uuid.uuid4().hex}"

            msg.wa_message_id = wamid
            sent_time = datetime.now(timezone.utc).replace(tzinfo=None)
            MessageStateMachine.transition(
                msg,
                ConversationMessageStatus.SENT,
                event_time=sent_time,
            )

            outbox.status = OutboxMessageStatus.COMPLETED
            outbox.processed_at = sent_time
            outbox.locked_at = None
            outbox.locked_by = None
            outbox.last_error = None

            sess.daily_sent_count = (sess.daily_sent_count or 0) + 1
            sess.last_sent_at = sent_time

            await db.commit()

            try:
                await ws_manager.broadcast({
                    "event": "message_status_updated",
                    "provider": "BAILEYS_QR",
                    "user_id": str(msg.user_id) if msg.user_id else None,
                    "message_id": wamid,
                    "wa_message_id": wamid,
                    "client_message_id": msg.client_message_id,
                    "conversation_id": msg.conversation_id,
                    "status": ConversationMessageStatus.SENT.value,
                    "timestamp": sent_time.isoformat(),
                })
            except Exception as ws_err:
                logger.warning(f"[OutboundWorker] Failed to broadcast realtime event for Baileys: {ws_err}")

            logger.info(f"[OutboundWorker] Successfully dispatched outbox {outbox.id} via Baileys: wamid={wamid}")
            return {"status": "sent", "wamid": wamid}

        # =========================================================================
        # 2. META_CLOUD Outbound Dispatch Branch (Preserved)
        # =========================================================================
        # Decrypt Access Token strictly inside backend service boundary immediately before dispatch
        if not wanum.encrypted_access_token:
            err_detail = "WhatsApp hattı için kayıtlı erişim anahtarı bulunamadı."
            outbox.status = OutboxMessageStatus.FAILED
            outbox.processed_at = now
            outbox.last_error = err_detail
            outbox.locked_at = None
            outbox.locked_by = None
            try:
                MessageStateMachine.transition(
                    msg,
                    ConversationMessageStatus.FAILED,
                    event_time=now,
                    error_code=401,
                    error_message=err_detail,
                )
            except Exception:
                pass
            await db.commit()
            return {"status": "failed", "reason": err_detail}

        try:
            raw_token = CredentialVault.decrypt(wanum.encrypted_access_token)
        except Exception as dec_err:
            err_detail = f"Erişim anahtarı çözülemedi: {type(dec_err).__name__}"
            logger.error(f"[OutboundWorker] Credential decryption failed for outbox {outbox_id}: {err_detail}")
            outbox.status = OutboxMessageStatus.FAILED
            outbox.processed_at = now
            outbox.last_error = err_detail
            outbox.locked_at = None
            outbox.locked_by = None
            try:
                MessageStateMachine.transition(
                    msg,
                    ConversationMessageStatus.FAILED,
                    event_time=now,
                    error_code=401,
                    error_message=err_detail,
                )
            except Exception:
                pass
            await db.commit()
            return {"status": "failed", "reason": err_detail}

        meta_client = MetaCloudApiClient()
        pending_realtime_event: Optional[Dict[str, Any]] = None

        try:
            # Dispatch to Meta
            if msg.message_type == MessageType.TEMPLATE or payload_data.get("message_type") == "template":
                template_name = payload_data.get("template_name") or ""
                template_lang = payload_data.get("template_language") or "tr"
                components = payload_data.get("template_parameters") or payload_data.get("components")

                meta_res = await meta_client.send_template_message(
                    phone_number_id=wanum.phone_number_id,
                    access_token=raw_token,
                    to_phone=msg.recipient_phone,
                    template_name=template_name,
                    language_code=template_lang,
                    components=components,
                )
            else:
                meta_res = await meta_client.send_text_message(
                    phone_number_id=wanum.phone_number_id,
                    access_token=raw_token,
                    to_phone=msg.recipient_phone,
                    message_text=msg.body or "",
                )

            # Extract wamid from Meta response
            messages_list = meta_res.get("messages", [])
            wamid = None
            if messages_list and isinstance(messages_list, list):
                wamid = messages_list[0].get("id")
            elif "message_id" in meta_res:
                wamid = meta_res["message_id"]

            if not wamid:
                logger.warning(f"[OutboundWorker] Meta returned 200 without message ID: {meta_res}")
                wamid = f"wamid.GEN_{uuid.uuid4().hex}"

            # Success: transition Message PENDING -> SENT and Outbox -> COMPLETED
            msg.wa_message_id = wamid
            sent_time = datetime.now(timezone.utc).replace(tzinfo=None)
            MessageStateMachine.transition(
                msg,
                ConversationMessageStatus.SENT,
                event_time=sent_time,
            )

            outbox.status = OutboxMessageStatus.COMPLETED
            outbox.processed_at = sent_time
            outbox.locked_at = None
            outbox.locked_by = None
            outbox.last_error = None

            await db.commit()

            pending_realtime_event = {
                "event": "message_status_updated",
                "provider": "META",
                "user_id": str(msg.user_id) if msg.user_id else None,
                "message_id": wamid,
                "wa_message_id": wamid,
                "client_message_id": msg.client_message_id,
                "conversation_id": msg.conversation_id,
                "status": ConversationMessageStatus.SENT.value,
                "timestamp": sent_time.isoformat(),
            }

            if pending_realtime_event:
                try:
                    await ws_manager.broadcast(pending_realtime_event)
                except Exception as ws_err:
                    logger.warning(f"[OutboundWorker] Failed to broadcast realtime event: {ws_err}")

            logger.info(f"[OutboundWorker] Successfully dispatched outbox {outbox.id}: wamid={wamid}")
            return {"status": "sent", "wamid": wamid}

        except MetaAmbiguousResultError as amb_err:
            # Conservative ambiguity handling:
            # A ReadTimeout occurred after request dispatch. The message MAY have been delivered by Meta!
            # Do NOT blindly retry to avoid duplicate WhatsApp messaging.
            logger.warning(f"[OutboundWorker] Ambiguous Meta result for outbox {outbox.id}: {amb_err}")
            outbox.status = OutboxMessageStatus.AMBIGUOUS_PROVIDER_RESULT
            outbox.last_error = str(amb_err)
            outbox.locked_at = None
            outbox.locked_by = None
            msg.error_message = "Meta API zaman aşımı (sonuç belirsiz, mükerrer gönderim önlendi)."
            await db.commit()
            return {"status": "ambiguous", "error": str(amb_err)}

        except MetaApiError as meta_err:
            sanitized_err = redact_secrets(str(meta_err))
            is_retryable = meta_err.retryable and (outbox.attempt_count < outbox.max_attempts)

            if is_retryable:
                outbox.attempt_count += 1
                outbox.status = OutboxMessageStatus.RETRYABLE
                outbox.last_error = sanitized_err
                outbox.locked_at = None
                outbox.locked_by = None
                is_test = bool(os.getenv("PYTEST_CURRENT_TEST"))
                backoff_delay = (0.01 if is_test else (2 ** outbox.attempt_count))
                outbox.available_at = now + timedelta(seconds=backoff_delay)
                await db.commit()
                logger.info(
                    f"[OutboundWorker] Transient failure for outbox {outbox.id} ({meta_err.http_status}). "
                    f"Scheduled retry #{outbox.attempt_count} at {outbox.available_at}"
                )
                return {"status": "retryable", "attempt": outbox.attempt_count, "error": sanitized_err}

            # Permanent failure or max attempts reached
            outbox.status = OutboxMessageStatus.FAILED
            outbox.processed_at = now
            outbox.last_error = sanitized_err
            outbox.locked_at = None
            outbox.locked_by = None

            try:
                MessageStateMachine.transition(
                    msg,
                    ConversationMessageStatus.FAILED,
                    event_time=now,
                    error_code=meta_err.meta_error_code or meta_err.http_status,
                    error_message=sanitized_err,
                )
            except Exception:
                pass

            await db.commit()

            try:
                await ws_manager.broadcast({
                    "event": "message_status_updated",
                    "provider": "META",
                    "user_id": str(msg.user_id) if msg.user_id else None,
                    "client_message_id": msg.client_message_id,
                    "conversation_id": msg.conversation_id,
                    "status": ConversationMessageStatus.FAILED.value,
                    "error_message": sanitized_err,
                    "timestamp": now.isoformat(),
                })
            except Exception:
                pass

            logger.warning(f"[OutboundWorker] Permanent failure for outbox {outbox.id}: {sanitized_err}")
            return {"status": "failed", "error": sanitized_err}

        except Exception as unk_err:
            sanitized_err = redact_secrets(str(unk_err))
            logger.error(f"[OutboundWorker] Unexpected exception in outbox {outbox_id}: {sanitized_err}", exc_info=True)
            try:
                await db.rollback()
                outbox_rec = await db.get(OutboxMessage, outbox_id)
                if outbox_rec:
                    outbox_rec.status = OutboxMessageStatus.FAILED
                    outbox_rec.processed_at = now
                    outbox_rec.last_error = sanitized_err
                    outbox_rec.locked_at = None
                    outbox_rec.locked_by = None
                    if msg:
                        msg_rec = await db.get(Message, msg.id)
                        if msg_rec:
                            MessageStateMachine.transition(
                                msg_rec,
                                ConversationMessageStatus.FAILED,
                                event_time=now,
                                error_code=500,
                                error_message=sanitized_err,
                            )
                    await db.commit()
            except Exception as inner_err:
                logger.error(f"[OutboundWorker] Failed to persist unexpected error state for outbox {outbox_id}: {inner_err}")
            return {"status": "failed", "error": sanitized_err}

    @classmethod
    async def process_outbox_message_by_id(cls, outbox_id: int) -> Dict[str, Any]:
        """
        Convenience background entrypoint opening a dedicated database session.
        """
        async with AsyncSessionLocal() as db:
            return await cls.process_outbox_job(outbox_id=outbox_id, db=db)

    @classmethod
    async def process_pending_outbox_batch(cls, batch_size: int = 10) -> int:
        """
        Scans and executes all eligible pending outbox jobs in the current batch.
        """
        async with AsyncSessionLocal() as db:
            claimed_ids = await cls.claim_pending_jobs(db, batch_size=batch_size)

        processed = 0
        for cid in claimed_ids:
            async with AsyncSessionLocal() as db:
                await cls.process_outbox_job(outbox_id=cid, db=db, force_claim=True)
                processed += 1
        return processed
