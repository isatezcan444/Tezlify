"""WhatsApp Sandbox E2E Foundation & Operational Verification Service (Phase 8.0.1).

This module provides a strictly isolated, fail-closed testing framework for
verifying WhatsApp outbound/inbound delivery flows, delivery receipts, and
ping/pong correlation without risking production lines, session 201, or live clients.
"""

import asyncio
import collections
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from backend.app.core.config import settings
from backend.app.services.whatsapp.identity import is_system_session_name

logger = logging.getLogger("whatsapp.sandbox")

# Korumalı üretim oturumları: bu oturumlar KESİNLİKLE sandbox için kullanılamaz.
PROTECTED_PRODUCTION_SESSION_IDS: Set[int] = {201}

SANDBOX_PREFIX = "TEZLIFY_SANDBOX"
PING_PREFIX = f"{SANDBOX_PREFIX}:PING"
PONG_PREFIX = f"{SANDBOX_PREFIX}:PONG"


def is_session_sandbox_eligible(
    session_id: Optional[int],
    session_name: Optional[str] = None,
    gateway_id: Optional[str] = None,
) -> Tuple[bool, str]:
    """Verifies that a WhatsApp session is explicitly safe and eligible for sandbox use."""
    if session_id is None:
        return False, "Session ID is None (missing session)"

    if session_id in PROTECTED_PRODUCTION_SESSION_IDS:
        return False, f"Session {session_id} is in PROTECTED_PRODUCTION_SESSION_IDS"

    cfg_sess = settings.WHATSAPP_SANDBOX_SESSION_ID
    if cfg_sess is None or session_id != cfg_sess:
        return False, f"Session {session_id} does not match configured WHATSAPP_SANDBOX_SESSION_ID ({cfg_sess})"

    if session_name:
        s_name = str(session_name).strip().lower()
        # Production names like "Hat 1", "Hat 2", "Tezlify Live", etc.
        if is_system_session_name(session_name) or "live" in s_name or "prod" in s_name:
            if "sandbox" not in s_name:
                return False, f"Session name '{session_name}' indicates a production line"

    return True, "OK"


class WhatsAppSandboxError(Exception):
    """WhatsApp Sandbox temel istisnası."""
    pass


class SandboxDisabledError(WhatsAppSandboxError):
    """Sandbox modu kapalıyken tetiklenir (fail-closed)."""
    pass


class ProductionSessionBlockedError(WhatsAppSandboxError):
    """Üretim oturumu sandbox için kullanılmaya çalışıldığında tetiklenir."""
    pass


class SandboxSessionNotConfiguredError(WhatsAppSandboxError):
    """Sandbox oturumu atanmadığında veya uyuşmadığında tetiklenir."""
    pass


class SandboxTargetNotAllowedError(WhatsAppSandboxError):
    """Hedef numara allowlist'te olmadığında veya allowlist boş olduğunda tetiklenir."""
    pass


class SandboxRateLimitExceededError(WhatsAppSandboxError):
    """Azami test mesajı sınırı aşıldığında tetiklenir."""
    pass


class DuplicateCorrelationIdError(WhatsAppSandboxError):
    """Aynı correlation ID yeniden kullanılmaya çalışıldığında tetiklenir."""
    pass


class SandboxTimeoutError(WhatsAppSandboxError):
    """Test teslimat veya PONG yanıtı için zaman aşımına uğradığında tetiklenir."""
    pass


class SandboxNumberNotConfiguredError(WhatsAppSandboxError):
    """Canlı test için tahsis edilmiş geçerli bir sandbox numarası bulunmadığında tetiklenir."""
    pass


def mask_phone_number(phone: Optional[str]) -> str:
    """PII-safe log ve çıktı maskeleme (+90541****073)."""
    if not phone:
        return "—"
    cleaned = re.sub(r"[^\d+]", "", str(phone).strip())
    if len(cleaned) <= 6:
        return "****"
    prefix = cleaned[:6]
    suffix = cleaned[-2:]
    return f"{prefix}****{suffix}"


def normalize_target_phone(raw_phone: str) -> str:
    """Telefon veya JID değerini normalize eder (E.164 veya salt rakam)."""
    if not raw_phone:
        return ""
    val = str(raw_phone).strip()
    if val.endswith("@s.whatsapp.net"):
        val = val.split("@")[0]
    has_plus = val.startswith("+")
    digits = re.sub(r"\D", "", val)
    return f"+{digits}" if has_plus else digits


@dataclass
class SandboxTestRecord:
    """Yapılandırılmış tekil sandbox test yürütme kaydı."""
    test_id: str
    correlation_id: str
    session_id: Optional[int]
    target_masked: str
    started_at: str
    user_id: Optional[str] = None
    target_phone: Optional[str] = None
    gateway_session_id: Optional[str] = None
    completed_at: Optional[str] = None
    send_status: str = "PENDING"  # PENDING, SENT, FAILED, BLOCKED
    delivery_status: str = "PENDING"  # PENDING, DELIVERED, READ, TIMEOUT, NONE, SKIPPED
    pong_status: str = "WAITING"  # WAITING, MATCHED, TIMEOUT, NONE, SKIPPED
    duration_ms: Optional[float] = None
    error_code: Optional[str] = None
    error_detail: Optional[str] = None
    wa_message_id: Optional[str] = None
    is_terminal: bool = False
    _completion_event: asyncio.Event = field(default_factory=asyncio.Event)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "test_id": self.test_id,
            "correlation_id": self.correlation_id,
            "session_id": self.session_id,
            "target_masked": self.target_masked,
            "user_id": self.user_id,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "send_status": self.send_status,
            "delivery_status": self.delivery_status,
            "pong_status": self.pong_status,
            "duration_ms": self.duration_ms,
            "error_code": self.error_code,
            "error_detail": self.error_detail,
        }


class WhatsAppSandboxService:
    """WhatsApp Sandbox koordinasyon, izolasyon ve operasyonel doğrulama servisi."""

    def __init__(self) -> None:
        self._active_tests: Dict[str, SandboxTestRecord] = {}  # correlation_id -> test
        self._wa_id_to_corr: Dict[str, str] = {}  # wa_message_id -> correlation_id
        self._seen_correlation_ids: Set[str] = set()
        self._recent_correlation_order: collections.deque[str] = collections.deque(maxlen=1000)
        self._results_history: collections.deque[Dict[str, Any]] = collections.deque(maxlen=200)
        self._dispatch_timestamps: collections.deque[float] = collections.deque(maxlen=100)
        self._lock = asyncio.Lock()

    @property
    def is_enabled(self) -> bool:
        """Sandbox modu açık mı?"""
        return bool(settings.WHATSAPP_SANDBOX_ENABLED)

    def get_configured_session_id(self) -> Optional[int]:
        """Yapılandırılmış sandbox session ID'sini döner."""
        return settings.WHATSAPP_SANDBOX_SESSION_ID

    def get_allowed_targets(self) -> List[str]:
        """Normalize edilmiş izinli hedef numaraları döner."""
        targets = settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS or []
        normalized: List[str] = []
        for t in targets:
            norm = normalize_target_phone(t)
            if norm and norm not in normalized:
                normalized.append(norm)
        return normalized

    def can_execute_live(self) -> Tuple[bool, str, str]:
        """Canlı sandbox testinin çalıştırılabilirliğini doğrular."""
        if not self.is_enabled:
            return False, "BLOCKED: SANDBOX DISABLED", "WHATSAPP_SANDBOX_ENABLED is False (fail-closed)"

        sess_id = self.get_configured_session_id()
        if sess_id is None:
            return False, "BLOCKED: NO SESSION CONFIGURED", "WHATSAPP_SANDBOX_SESSION_ID is not configured"

        if sess_id in PROTECTED_PRODUCTION_SESSION_IDS:
            return False, "BLOCKED: PRODUCTION SESSION PROTECTED", f"Session {sess_id} is a protected production session"

        allowed = self.get_allowed_targets()
        if not allowed:
            return False, "BLOCKED: SANDBOX NUMBER NOT CONFIGURED", "Sandbox target allowlist is empty"

        return True, "READY", "Sandbox configuration is valid and operational"

    def get_status(self) -> Dict[str, Any]:
        """Genel durum ve konfigürasyon özetini döner (PII-safe)."""
        can_exec, code, reason = self.can_execute_live()
        allowed = self.get_allowed_targets()
        return {
            "enabled": self.is_enabled,
            "session_id": self.get_configured_session_id(),
            "allowed_targets_count": len(allowed),
            "allowed_targets_masked": [mask_phone_number(t) for t in allowed],
            "max_messages": settings.WHATSAPP_SANDBOX_MAX_MESSAGES,
            "timeout_ms": settings.WHATSAPP_SANDBOX_TIMEOUT_MS,
            "protected_sessions": sorted(list(PROTECTED_PRODUCTION_SESSION_IDS)),
            "can_execute_live": can_exec,
            "status_reason": f"{code}: {reason}",
        }

    def validate_target_allowed(self, target: Optional[str]) -> str:
        """Hedef numaranın allowlist içinde olduğunu doğrular (fail-closed)."""
        allowed = self.get_allowed_targets()
        if not allowed:
            logger.warning("[AUDIT] Sandbox attempt rejected: allowlist is empty")
            raise SandboxTargetNotAllowedError("Sandbox target allowlist is empty. Fail-closed: no messages permitted.")

        if not target:
            # Allowlist'te tam olarak tek numara varsa onu varsayılan kabul et, aksi halde açık hedef zorunlu
            if len(allowed) == 1:
                return allowed[0]
            raise SandboxTargetNotAllowedError("Multiple allowlisted targets exist; explicit target is required.")

        norm_target = normalize_target_phone(target)
        if norm_target not in allowed:
            masked = mask_phone_number(norm_target)
            logger.warning("[AUDIT] Sandbox attempt rejected: target %s is not in allowlist", masked)
            raise SandboxTargetNotAllowedError(f"Target '{masked}' is not in sandbox allowlist.")

        return norm_target

    def validate_session(
        self,
        session_id: Optional[int],
        user_id: Optional[str] = None,
        session_owner_id: Optional[str] = None,
        is_admin: bool = False,
        session_name: Optional[str] = None,
    ) -> int:
        """Oturumun korumalı olmadığını ve kiracı yetkisini doğrular."""
        if session_id is None:
            session_id = self.get_configured_session_id()

        if session_id is None:
            raise SandboxSessionNotConfiguredError("No sandbox session ID provided or configured.")

        if session_id in PROTECTED_PRODUCTION_SESSION_IDS:
            logger.error("[AUDIT] Sandbox security violation: attempt to use protected production session %s", session_id)
            raise ProductionSessionBlockedError(
                f"Production session {session_id} is strictly protected and cannot be used for sandbox."
            )

        # Üretim oturumu ismi / deseni kontrolü (P2)
        if session_name:
            s_name = str(session_name).strip().lower()
            if "sandbox" not in s_name and (is_system_session_name(session_name) or "live" in s_name or "prod" in s_name):
                logger.error("[AUDIT] Sandbox security violation: session '%s' indicates production", session_name)
                raise ProductionSessionBlockedError(
                    f"Session '{session_name}' indicates a production line and cannot be used for sandbox."
                )

        # Sahipsiz oturum kontrolü (user_id=None durumu) (P1)
        if session_owner_id is None and user_id is not None and not is_admin:
            logger.warning("[AUDIT] Sandbox unowned session access rejected for non-admin: user=%s", user_id)
            raise WhatsAppSandboxError("Tenant isolation error: Unowned/system session requires administrator authorization.")

        # Kiracı izolasyonu kontrolü (P1)
        if user_id is not None and session_owner_id is not None:
            if str(user_id) != str(session_owner_id) and not is_admin:
                logger.warning("[AUDIT] Sandbox tenant isolation mismatch: user=%s session_owner=%s", user_id, session_owner_id)
                raise WhatsAppSandboxError("Tenant/session ownership mismatch.")

        return session_id

    def check_rate_limit(self) -> None:
        """Son 60 saniye içindeki gönderim sayısını kontrol eder."""
        now = time.monotonic()
        cutoff = now - 60.0
        while self._dispatch_timestamps and self._dispatch_timestamps[0] < cutoff:
            self._dispatch_timestamps.popleft()

        max_limit = max(1, settings.WHATSAPP_SANDBOX_MAX_MESSAGES)
        if len(self._dispatch_timestamps) >= max_limit:
            logger.warning("[AUDIT] Sandbox rate limit reached (%d/%d msg in 60s)", len(self._dispatch_timestamps), max_limit)
            raise SandboxRateLimitExceededError(
                f"Sandbox rate limit exceeded: maximum {max_limit} messages allowed per 60 seconds."
            )

    def register_correlation_id(self, correlation_id: str) -> None:
        """Correlation ID'nin tekilliğini garanti eder."""
        if correlation_id in self._seen_correlation_ids:
            logger.warning("[AUDIT] Duplicate sandbox correlation ID rejected: %s", correlation_id)
            raise DuplicateCorrelationIdError(f"Correlation ID '{correlation_id}' has already been used.")

        if len(self._seen_correlation_ids) >= 1000:
            oldest = self._recent_correlation_order.popleft()
            self._seen_correlation_ids.discard(oldest)

        self._seen_correlation_ids.add(correlation_id)
        self._recent_correlation_order.append(correlation_id)

    @staticmethod
    def generate_correlation_id() -> str:
        """Benzersiz correlation ID üretir."""
        return f"{SANDBOX_PREFIX}:{uuid.uuid4().hex[:16]}"

    @staticmethod
    def build_ping_body(correlation_id: str, timestamp_ms: Optional[int] = None) -> str:
        """PING mesaj metnini oluşturur."""
        ts = timestamp_ms or int(time.time() * 1000)
        return f"{PING_PREFIX}:{correlation_id}:{ts}"

    @staticmethod
    def build_pong_body(correlation_id: str) -> str:
        """PONG yanıt mesaj metnini oluşturur."""
        return f"{PONG_PREFIX}:{correlation_id}"

    @staticmethod
    def is_sandbox_message(body: Optional[str]) -> bool:
        """Metnin bir sandbox mesajı olup olmadığını kontrol eder."""
        if not body:
            return False
        return str(body).strip().startswith(SANDBOX_PREFIX)

    @staticmethod
    def parse_sandbox_message(body: Optional[str]) -> Optional[Dict[str, Any]]:
        """Sandbox mesajını parçalarına ayırır."""
        if not body:
            return None
        clean = str(body).strip()
        if not clean.startswith(SANDBOX_PREFIX):
            return None

        # PING: TEZLIFY_SANDBOX:PING:<correlation_id>:<ts>
        if clean.startswith(f"{PING_PREFIX}:"):
            remainder = clean[len(PING_PREFIX) + 1 :]
            if ":" in remainder:
                corr, ts_str = remainder.rsplit(":", 1)
                ts = int(ts_str) if ts_str.isdigit() else None
                return {"type": "PING", "correlation_id": corr, "timestamp_ms": ts}
            return {"type": "PING", "correlation_id": remainder, "timestamp_ms": None}

        # PONG: TEZLIFY_SANDBOX:PONG:<correlation_id>
        if clean.startswith(f"{PONG_PREFIX}:"):
            corr = clean[len(PONG_PREFIX) + 1 :]
            return {"type": "PONG", "correlation_id": corr}

        return None

    def is_tracked_wa_message(self, wa_message_id: str) -> bool:
        """Verilen WhatsApp mesaj ID'sinin aktif bir sandbox testine ait olup olmadığını kontrol eder."""
        return wa_message_id in self._wa_id_to_corr

    def handle_status_or_receipt(self, wa_message_id: str, status: str) -> bool:
        """Teslimat raporu (delivery receipt) veya statü güncellemesini eşleştirir."""
        if not self.is_enabled:
            return False

        corr_id = self._wa_id_to_corr.get(wa_message_id)
        if not corr_id:
            return False

        test = self._active_tests.get(corr_id)
        if not test or test.session_id in PROTECTED_PRODUCTION_SESSION_IDS:
            return False

        upper_st = str(status).upper()
        test.delivery_status = upper_st
        logger.info(
            "[AUDIT] Sandbox delivery receipt updated: corr=%s wa_id=%s status=%s",
            corr_id, wa_message_id, upper_st
        )

        if upper_st in ("DELIVERED", "READ") and test.pong_status == "MATCHED":
            test._completion_event.set()
        return True

    def handle_inbound_message(
        self,
        body: Optional[str],
        sender_phone: Optional[str] = None,
        gateway_session_id: Optional[str] = None,
    ) -> bool:
        """Gelen PONG mesajını aktif test correlation ID ile eşleştirir (fail-closed, strictly isolated)."""
        # 1. Sandbox açık mı?
        if not self.is_enabled:
            return False

        # 2. Mesaj formatı ve PONG tipi doğrulaması
        parsed = self.parse_sandbox_message(body)
        if not parsed or parsed.get("type") != "PONG":
            return False

        corr_id = parsed.get("correlation_id")
        if not corr_id:
            return False

        # 3. Aktif test kaydı var mı?
        test = self._active_tests.get(corr_id)
        masked_sender = mask_phone_number(sender_phone)
        if not test:
            logger.warning(
                "[AUDIT] Sandbox inbound PONG matched no active test (expired/late/unknown): corr=%s sender=%s",
                corr_id, masked_sender
            )
            return False

        # 4. Korumalı üretim oturumu ve uygunluk koruması (Fail-Closed)
        if test.session_id is None or test.session_id in PROTECTED_PRODUCTION_SESSION_IDS:
            logger.error(
                "[AUDIT] Sandbox inbound rejected: test uses protected or missing session %s",
                test.session_id,
            )
            return False

        eligible, reason = is_session_sandbox_eligible(session_id=test.session_id)
        if not eligible:
            logger.error(
                "[AUDIT] Sandbox inbound rejected: test session %s ineligible (%s) corr=%s",
                test.session_id, reason, corr_id,
            )
            return False

        # 5. Gateway session kimliği doğrulaması (Fail-Closed)
        if not gateway_session_id or not str(gateway_session_id).strip():
            logger.warning(
                "[AUDIT] Sandbox inbound PONG rejected: missing or empty gateway_session_id corr=%s",
                corr_id,
            )
            return False

        ev_gw = str(gateway_session_id).strip()
        test_gw = str(test.gateway_session_id).strip() if test.gateway_session_id else ""
        expected_alias = f"sandbox-session-{test.session_id}" if test.session_id else ""
        valid_sids = {s for s in (test_gw, expected_alias) if s}

        if not valid_sids or ev_gw not in valid_sids:
            logger.warning(
                "[AUDIT] Sandbox PONG session mismatch: event_session=%s expected=%s corr=%s",
                ev_gw, valid_sids, corr_id,
            )
            return False

        # 6. Gönderici allowlist ve hedef telefon eşleşmesi
        norm_sender = normalize_target_phone(sender_phone) if sender_phone else ""
        allowed_targets = self.get_allowed_targets()
        if not allowed_targets or norm_sender not in allowed_targets:
            logger.warning(
                "[AUDIT] Sandbox PONG sender not in allowlist: sender=%s corr=%s",
                masked_sender, corr_id
            )
            return False

        if test.target_phone:
            norm_target = normalize_target_phone(test.target_phone)
            if norm_sender and norm_target and norm_sender != norm_target:
                logger.warning(
                    "[AUDIT] Sandbox PONG sender mismatch: sender=%s expected=%s corr=%s",
                    masked_sender, mask_phone_number(norm_target), corr_id
                )
                return False

        # 7. Terminal durum ve tekil eşleşme garantisi (P3)
        if test.is_terminal or test.pong_status != "WAITING":
            logger.warning(
                "[AUDIT] Sandbox late or duplicate PONG rejected: corr=%s status=%s is_terminal=%s",
                corr_id, test.pong_status, test.is_terminal
            )
            return False

        # 8. Başarılı eşleştirme ve durum güncellemesi
        test.pong_status = "MATCHED"
        test.is_terminal = True
        test.error_code = None
        test.error_detail = None
        logger.info(
            "[AUDIT] Sandbox PONG successfully matched: corr=%s sender=%s session=%s",
            corr_id, masked_sender, test.session_id
        )
        test._completion_event.set()
        return True

    def get_results_history(
        self,
        user_id: Optional[str] = None,
        is_admin: bool = False,
    ) -> List[Dict[str, Any]]:
        """Son yapılandırılmış operational health sonuçlarını döner (tenant isolated)."""
        if is_admin:
            return list(self._results_history)
        if not user_id:
            return []
        uid_str = str(user_id)
        return [
            item for item in self._results_history
            if item.get("user_id") and str(item.get("user_id")) == uid_str
        ]

    async def run_ping_pong_test(
        self,
        target_phone: Optional[str] = None,
        session_id: Optional[int] = None,
        correlation_id: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        gateway_id: Optional[str] = None,
        gateway_client: Optional[Any] = None,
        user_id: Optional[str] = None,
        is_admin: bool = False,
        session_owner_id: Optional[str] = None,
        session_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Kontrollü Ping/Pong test akışını çalıştırır."""
        # 1. Konfigürasyon ve güvenlik doğrulamaları
        if not self.is_enabled:
            raise SandboxDisabledError("WhatsApp Sandbox is disabled (WHATSAPP_SANDBOX_ENABLED is False).")

        sess_id = self.validate_session(
            session_id,
            user_id=user_id,
            session_owner_id=session_owner_id,
            is_admin=is_admin,
            session_name=session_name,
        )
        norm_target = self.validate_target_allowed(target_phone)
        self.check_rate_limit()

        # 2. Correlation ID ve kimlik oluşturma
        corr_id = correlation_id or self.generate_correlation_id()
        self.register_correlation_id(corr_id)

        test_id = f"test_{uuid.uuid4().hex[:12]}"
        masked_target = mask_phone_number(norm_target)
        now_dt = datetime.now(timezone.utc)
        start_mono = time.monotonic()
        effective_gateway_id = gateway_id or f"sandbox-session-{sess_id}"

        test_record = SandboxTestRecord(
            test_id=test_id,
            correlation_id=corr_id,
            session_id=sess_id,
            target_masked=masked_target,
            started_at=now_dt.isoformat(),
            user_id=str(user_id) if user_id else None,
            target_phone=norm_target,
            gateway_session_id=effective_gateway_id,
            send_status="PENDING",
            delivery_status="PENDING",
            pong_status="WAITING",
        )

        async with self._lock:
            self._active_tests[corr_id] = test_record

        timeout_sec = (timeout_ms or settings.WHATSAPP_SANDBOX_TIMEOUT_MS or 15000) / 1000.0
        ping_body = self.build_ping_body(corr_id)

        # 3. Mesaj gönderme isteği (Gateway REST üzerinden)
        try:
            self._dispatch_timestamps.append(time.monotonic())
            target_jid = f"{norm_target.lstrip('+')}@s.whatsapp.net"

            logger.info(
                "[AUDIT] Dispatching sandbox PING: test_id=%s corr=%s session=%s target=%s user=%s",
                test_id, corr_id, sess_id, masked_target, user_id
            )

            if gateway_client is not None:
                gw_res = await gateway_client.send_text_message(
                    effective_gateway_id, target_jid, ping_body, client_message_id=corr_id
                )
            else:
                from backend.app.services.whatsapp_gateway import send_text_message as gw_send
                gw_res = await gw_send(
                    effective_gateway_id, target_jid, ping_body, client_message_id=corr_id
                )

            wa_id = str(gw_res.get("wa_message_id") or "")
            test_record.wa_message_id = wa_id
            test_record.send_status = "SENT"

            if wa_id:
                async with self._lock:
                    self._wa_id_to_corr[wa_id] = corr_id

        except Exception as exc:
            duration_ms = (time.monotonic() - start_mono) * 1000.0
            test_record.send_status = "FAILED"
            test_record.delivery_status = "SKIPPED"
            test_record.pong_status = "SKIPPED"
            test_record.error_code = "GATEWAY_ERROR"
            test_record.error_detail = str(exc)[:250]
            test_record.completed_at = datetime.now(timezone.utc).isoformat()
            test_record.duration_ms = round(duration_ms, 2)
            test_record.is_terminal = True

            logger.error("[AUDIT] Sandbox PING dispatch failed: test_id=%s error=%s", test_id, exc)

            async with self._lock:
                self._active_tests.pop(corr_id, None)
                self._results_history.append(test_record.to_dict())

            return test_record.to_dict()

        # 4. Teslimat ve PONG yanıtını bekleme
        try:
            await asyncio.wait_for(test_record._completion_event.wait(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            async with self._lock:
                if test_record.pong_status == "MATCHED":
                    test_record.is_terminal = True
                    if test_record.delivery_status == "PENDING":
                        test_record.delivery_status = "TIMEOUT"
                    logger.info("[AUDIT] Sandbox PONG arrived before timeout settled: corr=%s", corr_id)
                else:
                    test_record.is_terminal = True
                    test_record.pong_status = "TIMEOUT"
                    if test_record.delivery_status == "PENDING":
                        test_record.delivery_status = "TIMEOUT"
                    test_record.error_code = "TIMEOUT"
                    test_record.error_detail = f"Sandbox verification timed out after {timeout_sec:.1f}s waiting for receipt/PONG"
                    logger.warning("[AUDIT] Sandbox test timed out: test_id=%s corr=%s", test_id, corr_id)

        duration_ms = (time.monotonic() - start_mono) * 1000.0
        test_record.completed_at = datetime.now(timezone.utc).isoformat()
        test_record.duration_ms = round(duration_ms, 2)

        async with self._lock:
            test_record.is_terminal = True
            if test_record.pong_status == "MATCHED":
                test_record.error_code = None
                test_record.error_detail = None
            self._active_tests.pop(corr_id, None)
            if test_record.wa_message_id:
                self._wa_id_to_corr.pop(test_record.wa_message_id, None)
            self._results_history.append(test_record.to_dict())

        return test_record.to_dict()


# Global tekil servis örneği
sandbox_service = WhatsAppSandboxService()
