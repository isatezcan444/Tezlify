"""Characterization and boundary unit tests for WhatsApp Gateway boundary layer (Phase 11.8).

Validates pure payload builders, response normalizers, and error classification without
running external network requests or database operations.
"""
import pytest

from backend.app.services.whatsapp.gateway.errors import (
    classify_gateway_error,
    format_safe_gateway_error,
    is_gateway_session_missing,
    is_gateway_timeout,
    is_gateway_unavailable,
)
from backend.app.services.whatsapp.gateway.payloads import (
    build_bulk_messages_query_params,
    build_conversations_query_params,
    build_create_session_payload,
    build_history_request_payload,
    build_messages_query_params,
    build_pairing_code_payload,
    build_send_media_payload,
    build_send_text_payload,
    build_sync_groups_payload,
    build_typing_payload,
)
from backend.app.services.whatsapp.gateway.responses import (
    extract_live_session_fields,
    extract_pairing_code,
    extract_send_result,
    extract_session_id,
    normalize_contacts_payload,
    normalize_sessions_payload,
    normalize_sync_job_status,
)
from backend.app.services.whatsapp_gateway import WhatsAppGatewayError


class TestGatewayPayloadBuilders:
    """Validates deterministic construction of request dictionaries and query params."""

    def test_build_send_text_payload_basic(self):
        payload = build_send_text_payload("Hello World")
        assert payload == {"body": "Hello World"}

    def test_build_send_text_payload_with_client_id(self):
        payload = build_send_text_payload("Hello World", client_message_id="msg-12345")
        assert payload == {"body": "Hello World", "client_message_id": "msg-12345"}

    def test_build_send_media_payload(self):
        raw = {"media_type": "image", "media_url": "https://example.com/img.png"}
        payload = build_send_media_payload(raw, client_message_id="media-999")
        assert payload["media_type"] == "image"
        assert payload["media_url"] == "https://example.com/img.png"
        assert payload["client_message_id"] == "media-999"
        # Input dict should not be mutated if client_message_id was supplied
        assert "client_message_id" not in raw

    def test_build_typing_payload(self):
        p1 = build_typing_payload(True, 3000)
        assert p1 == {"typing": True, "duration_ms": 3000}

        p2 = build_typing_payload(False)
        assert p2 == {"typing": False, "duration_ms": 4000}

    def test_build_pairing_code_payload(self):
        p = build_pairing_code_payload("+905551234567")
        assert p == {"phone": "+905551234567"}

    def test_build_create_session_payload(self):
        p = build_create_session_payload("main_session")
        assert p == {"name": "main_session"}

    def test_build_sync_groups_payload(self):
        assert build_sync_groups_payload(force=True) == {"force": True}
        assert build_sync_groups_payload(force=False) == {"force": False}

    def test_build_history_request_payload(self):
        p = build_history_request_payload(
            count=25,
            oldest_msg_id="BAE592819",
            oldest_msg_from_me=True,
            oldest_msg_ts_ms=1690000000000,
            before=1690000000,
            timeout_ms=5000,
        )
        assert p == {
            "count": 25,
            "oldest_msg_id": "BAE592819",
            "oldest_msg_from_me": True,
            "oldest_msg_timestamp_ms": 1690000000000,
            "before": 1690000000,
            "timeout_ms": 5000,
        }

    def test_build_messages_query_params(self):
        params = build_messages_query_params(
            limit=20,
            before=1695000000,
            fetch_provider=True,
            oldest_msg_id="OLD123",
            oldest_msg_from_me=False,
            oldest_msg_ts_ms=1694000000000,
        )
        assert params == {
            "limit": 20,
            "before": 1695000000,
            "fetch_provider": "true",
            "oldest_msg_id": "OLD123",
            "oldest_msg_from_me": "false",
            "oldest_msg_timestamp_ms": 1694000000000,
        }

    def test_build_bulk_messages_query_params(self):
        p = build_bulk_messages_query_params(limit=500, offset=100, since=1690000000, per_chat_limit=50)
        assert p == {
            "limit": 500,
            "offset": 100,
            "since": 1690000000,
            "perChatLimit": 50,
        }

    def test_build_conversations_query_params(self):
        p = build_conversations_query_params(search="Tezlify", limit=30, offset=60)
        assert p == {"search": "Tezlify", "limit": 30, "offset": 60}


class TestGatewayResponseNormalizers:
    """Validates parsing, fallback, and extraction from gateway response payloads."""

    def test_extract_session_id(self):
        assert extract_session_id({"id": "gw-uuid-1"}) == "gw-uuid-1"
        assert extract_session_id({"session_id": "gw-uuid-2"}) == "gw-uuid-2"
        assert extract_session_id({}) is None
        assert extract_session_id(None) is None

    def test_extract_pairing_code(self):
        assert extract_pairing_code({"code": "ABCD-1234"}) == "ABCD-1234"
        assert extract_pairing_code({"pairing_code": "WXYZ-5678"}) == "WXYZ-5678"
        assert extract_pairing_code({}) is None
        assert extract_pairing_code(None) is None

    def test_extract_live_session_fields_connected(self):
        raw = {
            "status": "CONNECTED",
            "phone": "+905551112233",
            "error_message": "Old error",
            "is_phone_online": True,
            "battery_level": 85,
            "qr_code": None,
            "sync": {"phase": "syncing", "progress": 40},
        }
        res = extract_live_session_fields(raw)
        assert res["status"] == "CONNECTED"
        assert res["phone"] == "+905551112233"
        # When CONNECTED, error_message is cleared
        assert res["error_message"] is None
        assert res["is_phone_online"] is True
        assert res["battery_level"] == 85
        assert res["qr_code"] is None
        assert res["sync"] == {"phase": "syncing", "progress": 40}

    def test_extract_live_session_fields_disconnected_with_error(self):
        raw = {
            "status": "DISCONNECTED",
            "phone_number": "+905551112233",
            "error_message": "Stream connection closed",
            "is_phone_online": False,
            "battery_level": "invalid",
        }
        res = extract_live_session_fields(raw)
        assert res["status"] == "DISCONNECTED"
        assert res["phone"] == "+905551112233"
        assert res["error_message"] == "Stream connection closed"
        assert res["is_phone_online"] is False
        assert res["battery_level"] is None
        assert res["sync"] == {"phase": "idle", "progress": 0}

    def test_extract_live_session_fields_empty(self):
        res = extract_live_session_fields(None)
        assert res["status"] is None
        assert res["phone"] is None
        assert res["sync"] == {"phase": "idle", "progress": 0}

    def test_extract_send_result(self):
        assert extract_send_result({"wa_message_id": "WAMSG123", "status": "SENT"}) == {
            "wa_message_id": "WAMSG123",
            "status": "SENT",
        }
        assert extract_send_result({"id": "WAMSG456", "status": "PENDING"}) == {
            "wa_message_id": "WAMSG456",
            "status": "PENDING",
        }
        assert extract_send_result({}) == {"wa_message_id": None, "status": None}
        assert extract_send_result(None) == {"wa_message_id": None, "status": None}

    def test_normalize_contacts_payload(self):
        contacts = [{"id": "c1"}, {"id": "c2"}]
        assert normalize_contacts_payload({"contacts": contacts}) == contacts
        assert normalize_contacts_payload({"contacts": "invalid"}) == []
        assert normalize_contacts_payload({}) == []
        assert normalize_contacts_payload(None) == []

    def test_normalize_sessions_payload(self):
        sessions = [{"id": "s1"}, {"id": "s2"}]
        assert normalize_sessions_payload({"sessions": sessions}) == sessions
        assert normalize_sessions_payload({}) == []
        assert normalize_sessions_payload(None) == []

    def test_normalize_sync_job_status(self):
        res = normalize_sync_job_status({"phase": "messages", "progress": 75, "total": 100, "current": 75})
        assert res == {"phase": "messages", "progress": 75, "total": 100, "current": 75}
        assert normalize_sync_job_status(None) == {"phase": "idle", "progress": 0}


class TestGatewayErrorClassification:
    """Validates error taxonomy across HTTP status codes, timeouts, and body text."""

    def test_is_gateway_session_missing_http_404(self):
        err = WhatsAppGatewayError("Not found", status_code=404)
        assert is_gateway_session_missing(err) is True
        assert classify_gateway_error(err) == "SESSION_NOT_FOUND"

    def test_is_gateway_session_missing_in_body(self):
        err = WhatsAppGatewayError("Error 500", status_code=500, response_body="session not found")
        assert is_gateway_session_missing(err) is True
        assert classify_gateway_error(err) == "SESSION_NOT_FOUND"

    def test_is_gateway_session_missing_in_text(self):
        err = Exception("Cannot route request: session not found in gateway map")
        assert is_gateway_session_missing(err) is True
        assert classify_gateway_error(err) == "SESSION_NOT_FOUND"

    def test_is_gateway_session_missing_unrelated_error(self):
        err = WhatsAppGatewayError("Internal Server Error", status_code=500)
        assert is_gateway_session_missing(err) is False

    def test_is_gateway_unavailable(self):
        err_502 = WhatsAppGatewayError("Bad Gateway", status_code=502)
        assert is_gateway_unavailable(err_502) is True
        assert classify_gateway_error(err_502) == "UNAVAILABLE"

        err_conn = Exception("Gateway'e ulaşılamadı: ConnectError: connection refused")
        assert is_gateway_unavailable(err_conn) is True
        assert classify_gateway_error(err_conn) == "UNAVAILABLE"

    def test_is_gateway_timeout(self):
        err_504 = WhatsAppGatewayError("Gateway Timeout", status_code=504)
        assert is_gateway_timeout(err_504) is True
        assert classify_gateway_error(err_504) == "TIMEOUT"

        err_str = Exception("Client request timed out after 30.0s")
        assert is_gateway_timeout(err_str) is True
        assert classify_gateway_error(err_str) == "TIMEOUT"

    def test_classify_unauthorized_and_conflict(self):
        err_401 = WhatsAppGatewayError("Unauthorized", status_code=401)
        assert classify_gateway_error(err_401) == "UNAUTHORIZED"

        err_409 = WhatsAppGatewayError("Conflict", status_code=409)
        assert classify_gateway_error(err_409) == "CONFLICT"

    def test_classify_malformed_response(self):
        err = WhatsAppGatewayError("Gateway yanıtı JSON değil: <!DOCTYPE html>...")
        assert classify_gateway_error(err) == "MALFORMED_RESPONSE"

    def test_format_safe_gateway_error_sanitization(self):
        err_missing = WhatsAppGatewayError("404", status_code=404)
        msg = format_safe_gateway_error(err_missing)
        assert "QR ile yeniden bağlayın" in msg

        err_timeout = WhatsAppGatewayError("Timeout", status_code=504)
        assert "zaman aşımı" in format_safe_gateway_error(err_timeout)

        err_unavail = WhatsAppGatewayError("Bad Gateway", status_code=502)
        assert "gateway servisine ulaşılamadı" in format_safe_gateway_error(err_unavail)

        # Internal URL masking
        raw_err = Exception("Connect error to http://127.0.0.1:8787/sessions/secret-token/pair failed")
        safe = format_safe_gateway_error(raw_err)
        assert "127.0.0.1:8787" not in safe
        assert "<gateway-url>" in safe
