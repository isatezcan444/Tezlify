"""WhatsApp Gateway Boundary Package (Phase 11.8).

Pure boundary layer between application orchestration and the gateway transport.
Contains deterministic payload builders, response normalizers, and error classifiers.
"""
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

__all__ = [
    # Errors
    "is_gateway_session_missing",
    "is_gateway_unavailable",
    "is_gateway_timeout",
    "classify_gateway_error",
    "format_safe_gateway_error",
    # Payloads
    "build_send_text_payload",
    "build_send_media_payload",
    "build_typing_payload",
    "build_pairing_code_payload",
    "build_create_session_payload",
    "build_sync_groups_payload",
    "build_history_request_payload",
    "build_messages_query_params",
    "build_bulk_messages_query_params",
    "build_conversations_query_params",
    # Responses
    "extract_session_id",
    "extract_pairing_code",
    "extract_live_session_fields",
    "extract_send_result",
    "normalize_contacts_payload",
    "normalize_sessions_payload",
    "normalize_sync_job_status",
]
