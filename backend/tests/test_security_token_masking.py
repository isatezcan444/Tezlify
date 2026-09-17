"""Security tests verifying authentication token and secret masking in logs.

Validates that Bearer tokens, URL query parameter tokens (?token=...), access_tokens,
and session tokens are systematically masked in logs to prevent secret exposure.
"""
import io
import logging
import pytest

from backend.app.core.logging_security import (
    SecretMaskingFilter,
    mask_sensitive_text,
    setup_security_logging,
)


def test_mask_sensitive_text_bearer():
    raw = "Authorization: Bearer sampleSecretTokenValue123456789"
    masked = mask_sensitive_text(raw)
    assert "sampleSecretTokenValue123456789" not in masked
    assert "Bearer ***MASKED***" in masked


def test_mask_sensitive_text_url_query_token():
    raw = "GET /ws?token=sampleSecretTokenValue123456789 [accepted]"
    masked = mask_sensitive_text(raw)
    assert "sampleSecretTokenValue123456789" not in masked
    assert "token=***MASKED***" in masked


def test_mask_sensitive_text_access_and_refresh_tokens():
    raw = "Payload: access_token=sampleAccessToken123456789&refresh_token=sampleRefreshToken987654321"
    masked = mask_sensitive_text(raw)
    assert "sampleAccessToken123456789" not in masked
    assert "sampleRefreshToken987654321" not in masked
    assert "access_token=***MASKED***" in masked
    assert "refresh_token=***MASKED***" in masked


def test_mask_sensitive_text_json_format():
    raw = '{"token": "sampleSecretJsonToken123456789", "status": "ok"}'
    masked = mask_sensitive_text(raw)
    assert "sampleSecretJsonToken123456789" not in masked
    assert '***MASKED***' in masked


def test_secret_masking_filter_log_record():
    filter_instance = SecretMaskingFilter()
    
    # Test record.msg masking
    record = logging.LogRecord(
        name="test_logger",
        level=logging.INFO,
        pathname="test.py",
        lineno=1,
        msg="Connecting with token=secretTokenValue123456789",
        args=(),
        exc_info=None,
    )
    filter_instance.filter(record)
    assert "secretTokenValue123456789" not in record.msg
    assert "token=***MASKED***" in record.msg

    # Test record.args masking
    record_with_args = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname="access.py",
        lineno=10,
        msg='%s - "%s" %s',
        args=("127.0.0.1", "GET /ws?token=secretQueryToken12345 HTTP/1.1", 200),
        exc_info=None,
    )
    filter_instance.filter(record_with_args)
    assert "secretQueryToken12345" not in record_with_args.args[1]
    assert "token=***MASKED***" in record_with_args.args[1]


def test_logger_stream_output_does_not_contain_secrets():
    log_stream = io.StringIO()
    handler = logging.StreamHandler(log_stream)
    handler.setFormatter(logging.Formatter("%(levelname)s - %(message)s"))
    handler.addFilter(SecretMaskingFilter())

    test_logger = logging.getLogger("test_security_stream")
    test_logger.setLevel(logging.INFO)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    test_logger.info("User authenticated: Bearer mySecretTokenString987654321")
    test_logger.info("WebSocket handshake: /ws?token=mySecretWsToken123456")

    output = log_stream.getvalue()
    assert "mySecretTokenString987654321" not in output
    assert "mySecretWsToken123456" not in output
    assert "Bearer ***MASKED***" in output
    assert "token=***MASKED***" in output
