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

from backend.app.services.whatsapp.orchestration.events import (
    WhatsAppEventOrchestrator,
    _ensure_conversation,
    _ensure_conversation_race_safe,
    _ingest_contact_synced,
    _ingest_message,
    _map_conversation_event,
    _map_session_event,
    _passthrough_event,
    _persist_gateway_message,
    _upsert_contact,
    ingest_gateway_event,
    reconcile_legacy_split_conversation,
)

from backend.app.services.whatsapp.orchestration.sync import (
    SyncJob,
    WhatsAppSyncOrchestrator,
    _bulk_channel_available,
    _bulk_upsert_contacts,
    _cancel_stale_sync_jobs,
    _ensure_conversations_bulk,
    _hydrate_messages_on_demand,
    _persist_chat_snapshot,
    _reapply_chat_names,
    _repair_last_message_previews,
    _run_background_history_expansion,
    _run_bulk_message_sync,
    _run_initial_sync,
    _run_sync_job,
    _schedule_chats_bootstrap,
    _schedule_initial_sync,
    _schedule_metadata_enrichment,
    _sync_conversations_impl,
    get_sync_job,
    request_sync,
    reset_history_expansion_state,
    sync_contacts,
    sync_conversations,
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
    # Events
    "WhatsAppEventOrchestrator",
    "ingest_gateway_event",
    "_ingest_message",
    "_ingest_contact_synced",
    "reconcile_legacy_split_conversation",
    "_map_conversation_event",
    "_map_session_event",
    "_passthrough_event",
    "_upsert_contact",
    "_ensure_conversation",
    "_ensure_conversation_race_safe",
    "_persist_gateway_message",
    # Sync
    "WhatsAppSyncOrchestrator",
    "SyncJob",
    "request_sync",
    "get_sync_job",
    "sync_contacts",
    "sync_conversations",
    "_sync_conversations_impl",
    "_hydrate_messages_on_demand",
    "_run_sync_job",
    "_run_bulk_message_sync",
    "_persist_chat_snapshot",
    "_bulk_upsert_contacts",
    "_ensure_conversations_bulk",
    "_repair_last_message_previews",
    "_cancel_stale_sync_jobs",
    "_schedule_initial_sync",
    "_run_initial_sync",
    "_schedule_chats_bootstrap",
    "_schedule_metadata_enrichment",
    "_reapply_chat_names",
    "_run_background_history_expansion",
    "_bulk_channel_available",
    "reset_history_expansion_state",
]


