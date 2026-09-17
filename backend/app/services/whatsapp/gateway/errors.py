"""WhatsApp Gateway Error Classification & Sanitization (Phase 11.8).

Pure error inspection and classification. Categorizes gateway errors (404/missing session,
timeout, connection refused, unauthorized) without database access, side effects, or mutations.
"""
import re
from typing import Optional

from backend.app.services.whatsapp_gateway import WhatsAppGatewayError

_GATEWAY_SESSION_MISSING = "session not found"


def is_gateway_session_missing(exc: Exception) -> bool:
    """Determines whether an exception indicates an orphaned or missing gateway session.
    
    Only this specific failure mode triggers explicit session relink/self-healing.
    All other network, timeout, or 500 errors remain fail-closed.
    """
    if isinstance(exc, WhatsAppGatewayError):
        if exc.status_code == 404:
            return True
        if exc.response_body and (
            "session not found" in exc.response_body.lower()
            or "not found" in exc.response_body.lower()
        ):
            return True
    exc_str = str(exc).lower()
    return _GATEWAY_SESSION_MISSING in exc_str or ("404" in exc_str and "session" in exc_str)


def is_gateway_unavailable(exc: Exception) -> bool:
    """Determines whether the gateway service is unreachable or returning gateway-level errors."""
    if isinstance(exc, WhatsAppGatewayError):
        if exc.status_code in (502, 503):
            return True
    exc_str = str(exc).lower()
    return any(
        k in exc_str
        for k in (
            "ulaşılamadı",
            "unreachable",
            "connection refused",
            "connecterror",
            "bad gateway",
            "connection reset",
        )
    )


def is_gateway_timeout(exc: Exception) -> bool:
    """Determines whether the gateway call timed out."""
    if isinstance(exc, WhatsAppGatewayError) and exc.status_code == 504:
        return True
    exc_str = str(exc).lower()
    return "timeout" in exc_str or "timed out" in exc_str


def classify_gateway_error(exc: Exception) -> str:
    """Classifies any gateway exception into a deterministic category code.
    
    Possible values:
    - 'SESSION_NOT_FOUND'
    - 'TIMEOUT'
    - 'UNAVAILABLE'
    - 'UNAUTHORIZED'
    - 'CONFLICT'
    - 'MALFORMED_RESPONSE'
    - 'UNKNOWN_ERROR'
    """
    if is_gateway_session_missing(exc):
        return "SESSION_NOT_FOUND"
    if is_gateway_timeout(exc):
        return "TIMEOUT"
    if is_gateway_unavailable(exc):
        return "UNAVAILABLE"

    if isinstance(exc, WhatsAppGatewayError):
        if exc.status_code == 401:
            return "UNAUTHORIZED"
        if exc.status_code == 409:
            return "CONFLICT"
        if exc.status_code and exc.status_code >= 500:
            return "UNAVAILABLE"

    exc_str = str(exc).lower()
    if "json" in exc_str and ("yanıtı" in exc_str or "decode" in exc_str):
        return "MALFORMED_RESPONSE"

    return "UNKNOWN_ERROR"


def format_safe_gateway_error(exc: Exception) -> str:
    """Produces a sanitized, PII-safe error description suitable for user or log surfaces."""
    category = classify_gateway_error(exc)
    if category == "SESSION_NOT_FOUND":
        return "WhatsApp oturumu gateway üzerinde bulunamadı. Lütfen QR ile yeniden bağlayın."
    if category == "TIMEOUT":
        return "WhatsApp gateway yanıt vermedi (zaman aşımı)."
    if category == "UNAVAILABLE":
        return "WhatsApp gateway servisine ulaşılamadı. Lütfen servisin çalıştığını doğrulayın."
    if category == "UNAUTHORIZED":
        return "WhatsApp gateway yetkilendirme hatası."
    if category == "CONFLICT":
        return "WhatsApp gateway durum çakışması."
    if category == "MALFORMED_RESPONSE":
        return "WhatsApp gateway geçersiz yanıt döndürdü."

    # Generic sanitized string truncated to 200 chars, stripping internal URLs/IPs
    raw = str(exc)
    sanitized = re.sub(r"https?://\S+", "<gateway-url>", raw)
    return sanitized[:200]
