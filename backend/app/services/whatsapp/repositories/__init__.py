"""WhatsApp persistence repositories."""

from backend.app.services.whatsapp.repositories.contacts import (
    get_contact_avatar,
    get_contact_by_phone,
    set_contact_avatar,
    set_contact_name,
)
from backend.app.services.whatsapp.repositories.conversations import (
    apply_conversation_last_message,
    create_conversation_entity,
    find_whatsapp_conversation,
    get_conversation_by_id,
    get_conversation_scope_filters,
    resolve_conversation_jid,
)
from backend.app.services.whatsapp.repositories.messages import (
    build_message_from_gateway,
    get_message_by_id,
    get_sync_watermark_epoch,
    has_older_messages,
    hydration_cursor_ms,
    message_exists_by_wa_id,
    msg_time,
    msg_time_col,
    select_messages_keyset,
)
from backend.app.services.whatsapp.repositories.sessions import (
    conversation_gateway_id,
    conversation_session,
    get_session_by_id,
    get_user_sessions,
    require_user_session,
    resolve_event_owner,
    resolve_event_owner_and_session,
    resolve_event_session_id,
)

__all__ = [
    "get_conversation_scope_filters",
    "get_conversation_by_id",
    "resolve_conversation_jid",
    "find_whatsapp_conversation",
    "get_user_sessions",
    "get_session_by_id",
    "require_user_session",
    "conversation_gateway_id",
    "conversation_session",
    "resolve_event_owner_and_session",
    "resolve_event_session_id",
    "resolve_event_owner",
    "msg_time_col",
    "msg_time",
    "hydration_cursor_ms",
    "get_sync_watermark_epoch",
    "get_message_by_id",
    "select_messages_keyset",
    "has_older_messages",
    "build_message_from_gateway",
    "message_exists_by_wa_id",
    "apply_conversation_last_message",
    "create_conversation_entity",
    "get_contact_avatar",
    "set_contact_avatar",
    "set_contact_name",
    "get_contact_by_phone",
]

