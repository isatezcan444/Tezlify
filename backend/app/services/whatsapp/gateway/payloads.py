"""WhatsApp Gateway Request Payload Builders (Phase 11.8).

Pure, deterministic, side-effect-free builders that construct request dictionaries
and query parameter mappings sent to the Node/Baileys WhatsApp Gateway.

Zero database, lock, or network dependencies.
"""
from typing import Any, Dict, Optional


def build_send_text_payload(
    body: str,
    client_message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Constructs JSON payload for outbound text messages."""
    payload: Dict[str, Any] = {"body": body}
    if client_message_id:
        payload["client_message_id"] = client_message_id
    return payload


def build_send_media_payload(
    media: Dict[str, Any],
    client_message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Constructs JSON payload for outbound media messages."""
    payload = dict(media)
    if client_message_id and "client_message_id" not in payload:
        payload["client_message_id"] = client_message_id
    return payload


def build_typing_payload(
    typing: bool = True,
    duration_ms: int = 4000,
) -> Dict[str, Any]:
    """Constructs JSON payload for typing indicators."""
    return {
        "typing": bool(typing),
        "duration_ms": int(duration_ms),
    }


def build_pairing_code_payload(phone: str) -> Dict[str, Any]:
    """Constructs JSON payload for 8-digit pairing code requests."""
    return {"phone": str(phone)}


def build_create_session_payload(name: str) -> Dict[str, Any]:
    """Constructs JSON payload for session initialization."""
    return {"name": str(name)}


def build_sync_groups_payload(force: bool = False) -> Dict[str, Any]:
    """Constructs JSON payload for bulk group subject resolution."""
    return {"force": bool(force)}


def build_history_request_payload(
    count: int = 50,
    oldest_msg_id: Optional[str] = None,
    oldest_msg_from_me: Optional[bool] = None,
    oldest_msg_ts_ms: Optional[int] = None,
    before: Optional[int] = None,
    timeout_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Constructs JSON payload for requesting older message history from gateway."""
    payload: Dict[str, Any] = {"count": int(count)}
    if oldest_msg_id is not None:
        payload["oldest_msg_id"] = str(oldest_msg_id)
    if oldest_msg_from_me is not None:
        payload["oldest_msg_from_me"] = bool(oldest_msg_from_me)
    if oldest_msg_ts_ms is not None:
        payload["oldest_msg_timestamp_ms"] = int(oldest_msg_ts_ms)
    if before is not None:
        payload["before"] = int(before)
    if timeout_ms is not None:
        payload["timeout_ms"] = int(timeout_ms)
    return payload


def build_messages_query_params(
    limit: int = 50,
    before: Optional[int] = None,
    fetch_provider: bool = False,
    oldest_msg_id: Optional[str] = None,
    oldest_msg_from_me: Optional[bool] = None,
    oldest_msg_ts_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Constructs query parameter dictionary for GET /conversations/:jid/messages."""
    params: Dict[str, Any] = {"limit": int(limit)}
    if before is not None:
        params["before"] = int(before)
    if fetch_provider:
        params["fetch_provider"] = "true"
    if oldest_msg_id is not None:
        params["oldest_msg_id"] = str(oldest_msg_id)
    if oldest_msg_from_me is not None:
        params["oldest_msg_from_me"] = "true" if oldest_msg_from_me else "false"
    if oldest_msg_ts_ms is not None:
        params["oldest_msg_timestamp_ms"] = int(oldest_msg_ts_ms)
    return params


def build_bulk_messages_query_params(
    limit: int = 1000,
    offset: int = 0,
    since: Optional[int] = None,
    per_chat_limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Constructs query parameter dictionary for GET /messages/bulk."""
    params: Dict[str, Any] = {"limit": int(limit), "offset": int(offset)}
    if since is not None:
        params["since"] = int(since)
    if per_chat_limit is not None:
        params["perChatLimit"] = int(per_chat_limit)
    return params


def build_conversations_query_params(
    search: Optional[str] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> Dict[str, Any]:
    """Constructs query parameter dictionary for GET /conversations."""
    params: Dict[str, Any] = {}
    if search:
        params["search"] = str(search)
    if limit is not None:
        params["limit"] = int(limit)
    if offset is not None:
        params["offset"] = int(offset)
    return params
