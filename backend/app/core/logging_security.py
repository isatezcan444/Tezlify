"""Security logging filters and token masking utilities.

Prevents authentication tokens, session secrets, and Bearer credentials from being
written in plaintext to application logs, uvicorn access logs, or debug output.
"""
import logging
import re
from typing import Any, Dict, Tuple, Union

# Regex patterns matching sensitive credentials and tokens
_SENSITIVE_PATTERNS = [
    # Authorization: Bearer <token> or Bearer <token>
    (re.compile(r"(Bearer\s+)[A-Za-z0-9_\-\.]{8,}", re.IGNORECASE), r"\1***MASKED***"),
    # URL query param ?token=..., &token=..., ?access_token=..., etc.
    (re.compile(r"([?&](?:token|access_token|refresh_token|session_token)=)[^&\s]+", re.IGNORECASE), r"\1***MASKED***"),
    # JSON or key-value format: "token": "...", token=...
    (re.compile(r'((?:["\']?(?:token|access_token|refresh_token|session_token)["\']?\s*[:=]\s*["\']))[^"\']+(["\'])', re.IGNORECASE), r"\1***MASKED***\2"),
    # Plain text assignment: token=... or access_token=...
    (re.compile(r'(\b(?:token|access_token|refresh_token|session_token)\s*=\s*)([A-Za-z0-9_\-\.]{8,})', re.IGNORECASE), r"\1***MASKED***"),
]


def mask_sensitive_text(text: str) -> str:
    """Masks tokens, secrets, and credentials in the given string."""
    if not isinstance(text, str):
        return text
    result = text
    for pattern, replacement in _SENSITIVE_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


class SecretMaskingFilter(logging.Filter):
    """Logging filter that sanitizes authentication tokens and credentials from log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = mask_sensitive_text(record.msg)
            if record.args:
                if isinstance(record.args, tuple):
                    record.args = tuple(
                        mask_sensitive_text(arg) if isinstance(arg, str) else arg
                        for arg in record.args
                    )
                elif isinstance(record.args, dict):
                    record.args = {
                        k: mask_sensitive_text(v) if isinstance(v, str) else v
                        for k, v in record.args.items()
                    }
                elif isinstance(record.args, str):
                    record.args = mask_sensitive_text(record.args)
        except Exception:
            # Masking failure must fail closed / safe
            pass
        return True


def setup_security_logging() -> None:
    """Installs SecretMaskingFilter on root logger, uvicorn access loggers, and existing handlers."""
    masking_filter = SecretMaskingFilter()
    root_logger = logging.getLogger()
    root_logger.addFilter(masking_filter)
    for handler in root_logger.handlers:
        handler.addFilter(masking_filter)

    for logger_name in ("uvicorn", "uvicorn.access", "uvicorn.error", "fastapi", "tezlify"):
        sub_logger = logging.getLogger(logger_name)
        sub_logger.addFilter(masking_filter)
        for handler in sub_logger.handlers:
            handler.addFilter(masking_filter)
