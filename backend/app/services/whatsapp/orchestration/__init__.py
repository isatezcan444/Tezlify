"""WhatsApp Domain Orchestration Layer (Phase 11.9).

Contains cohesive coordinators for:
- Sessions lifecycle and QR/pairing management
- Outbound messaging, locks, media dispatch
- Background sync jobs and history streaming
- Inbound gateway event processing and WebSocket broadcast
"""
from backend.app.services.whatsapp.orchestration.sessions import (
    WhatsAppSessionOrchestrator,
    _apply_gateway_live,
    _gateway_op_or_mark_relink,
    _list_sessions_internal,
    _session_dict,
    create_session,
    delete_session,
    get_session_qr,
    list_sessions,
    logout_session,
    purge_whatsapp_data,
    refresh_session_qr,
    request_pairing_code,
)
from backend.app.services.whatsapp.orchestration.messaging import (
    WhatsAppMessagingOrchestrator,
    _serialize_message,
    get_media_bytes,
    mark_conversation_read,
    send_media_message,
    send_text_message,
    send_typing,
    serialize_message,
)

__all__ = [
    # Sessions
    "WhatsAppSessionOrchestrator",
    "_session_dict",
    "_apply_gateway_live",
    "_gateway_op_or_mark_relink",
    "_list_sessions_internal",
    "list_sessions",
    "create_session",
    "get_session_qr",
    "refresh_session_qr",
    "request_pairing_code",
    "logout_session",
    "purge_whatsapp_data",
    "delete_session",
    # Messaging
    "WhatsAppMessagingOrchestrator",
    "serialize_message",
    "_serialize_message",
    "send_text_message",
    "send_media_message",
    "mark_conversation_read",
    "send_typing",
    "get_media_bytes",
]

