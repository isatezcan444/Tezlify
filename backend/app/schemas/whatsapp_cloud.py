"""
WhatsApp Cloud API (Meta Graph API) DTOs, Schemas and Webhook Parsers.

This module provides:
1. External Pydantic schemas mirroring Meta Graph API request/response structures.
2. Normalized internal domain event models (`ParsedIncomingMessage`, `ParsedStatusUpdate`).
3. Clean parser utility isolating Meta Graph API's nested webhook structure from internal business logic.
"""
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime, timezone
from pydantic import BaseModel, Field, ConfigDict

from backend.app.models.message_log import MessageStatus


# ==============================================================================
# 1. Meta Graph API Webhook External DTOs
# ==============================================================================

class WhatsAppCloudMetadata(BaseModel):
    display_phone_number: Optional[str] = None
    phone_number_id: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudProfile(BaseModel):
    name: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudContact(BaseModel):
    wa_id: str
    profile: Optional[WhatsAppCloudProfile] = None
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudText(BaseModel):
    body: str
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudError(BaseModel):
    code: int
    title: Optional[str] = None
    message: Optional[str] = None
    error_data: Optional[Dict[str, Any]] = None
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudMessage(BaseModel):
    id: str
    from_phone: str = Field(alias="from")
    timestamp: str
    type: str = "text"
    text: Optional[WhatsAppCloudText] = None
    errors: Optional[List[WhatsAppCloudError]] = None
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class WhatsAppCloudConversation(BaseModel):
    id: Optional[str] = None
    origin: Optional[Dict[str, Any]] = None
    expiration_timestamp: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudStatusUpdate(BaseModel):
    id: str
    status: str  # sent, delivered, read, failed
    timestamp: str
    recipient_id: str
    conversation: Optional[WhatsAppCloudConversation] = None
    pricing: Optional[Dict[str, Any]] = None
    errors: Optional[List[WhatsAppCloudError]] = None
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudValue(BaseModel):
    messaging_product: str = "whatsapp"
    metadata: Optional[WhatsAppCloudMetadata] = None
    contacts: Optional[List[WhatsAppCloudContact]] = None
    messages: Optional[List[WhatsAppCloudMessage]] = None
    statuses: Optional[List[WhatsAppCloudStatusUpdate]] = None
    errors: Optional[List[WhatsAppCloudError]] = None
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudChange(BaseModel):
    value: WhatsAppCloudValue
    field: str = "messages"
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudEntry(BaseModel):
    id: str
    changes: List[WhatsAppCloudChange]
    model_config = ConfigDict(extra="ignore")


class WhatsAppCloudWebhookPayload(BaseModel):
    object: str = "whatsapp_business_account"
    entry: List[WhatsAppCloudEntry]
    model_config = ConfigDict(extra="ignore")


# ==============================================================================
# 2. Meta Graph API Outbound Message DTOs
# ==============================================================================

class WhatsAppCloudTextObject(BaseModel):
    preview_url: bool = False
    body: str


class WhatsAppCloudSendMessageRequest(BaseModel):
    messaging_product: str = "whatsapp"
    recipient_type: str = "individual"
    to: str
    type: str = "text"
    text: WhatsAppCloudTextObject


class WhatsAppCloudSendResponse(BaseModel):
    messaging_product: str = "whatsapp"
    contacts: Optional[List[Dict[str, Any]]] = None
    messages: Optional[List[Dict[str, Any]]] = None
    model_config = ConfigDict(extra="ignore")


# ==============================================================================
# 3. Normalized Internal Domain Events
# ==============================================================================

class ParsedIncomingMessage(BaseModel):
    """Normalized domain model for an incoming message received via webhook."""
    message_id: str
    sender_phone: str
    sender_name: Optional[str] = None
    text: str
    timestamp: datetime
    raw_type: str = "text"
    media_id: Optional[str] = None
    media_mime_type: Optional[str] = None
    media_filename: Optional[str] = None
    media_caption: Optional[str] = None


class ParsedStatusUpdate(BaseModel):
    """Normalized domain model for an outbound message status update."""
    message_id: str
    recipient_phone: str
    status: MessageStatus
    timestamp: datetime
    error_code: Optional[int] = None
    error_message: Optional[str] = None


# Status mapper from Meta Cloud API status string to Tezlify MessageStatus
META_STATUS_MAP: Dict[str, MessageStatus] = {
    "sent": MessageStatus.SENT,
    "delivered": MessageStatus.DELIVERED,
    "read": MessageStatus.READ,
    "failed": MessageStatus.FAILED,
}


def _safe_parse_timestamp(ts_str: Optional[str]) -> datetime:
    """Converts a Unix epoch string or ISO string to UTC datetime."""
    if not ts_str:
        return datetime.now(timezone.utc)
    try:
        # Meta sends timestamps as epoch seconds string, e.g. "1603059201"
        epoch = float(ts_str)
        return datetime.fromtimestamp(epoch, tz=timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return datetime.now(timezone.utc)


def parse_meta_webhook_payload(
    payload_dict: Dict[str, Any]
) -> Tuple[List[ParsedIncomingMessage], List[ParsedStatusUpdate]]:
    """
    Parses a raw Meta webhook dictionary into normalized domain event lists.
    Supports TEXT, IMAGE, DOCUMENT, AUDIO, VIDEO, STICKER, LOCATION and INTERACTIVE replies.
    
    Returns:
        Tuple of (incoming_messages, status_updates)
    """
    incoming_messages: List[ParsedIncomingMessage] = []
    status_updates: List[ParsedStatusUpdate] = []

    if not isinstance(payload_dict, dict):
        return incoming_messages, status_updates

    entries = payload_dict.get("entry", [])
    if not isinstance(entries, list):
        return incoming_messages, status_updates

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        changes = entry.get("changes", [])
        if not isinstance(changes, list):
            continue

        for change in changes:
            if not isinstance(change, dict):
                continue
            val = change.get("value", {})
            if not isinstance(val, dict):
                continue

            # Build contacts map for sender display names
            contacts_map: Dict[str, str] = {}
            for contact in val.get("contacts", []):
                if isinstance(contact, dict):
                    wa_id = str(contact.get("wa_id", ""))
                    profile = contact.get("profile", {})
                    if isinstance(profile, dict) and "name" in profile:
                        contacts_map[wa_id] = profile["name"]

            # 1. Parse incoming messages
            messages = val.get("messages", [])
            if isinstance(messages, list):
                for msg in messages:
                    if not isinstance(msg, dict):
                        continue
                    msg_id = msg.get("id")
                    from_phone = msg.get("from")
                    if not msg_id or not from_phone:
                        continue

                    msg_type = msg.get("type", "text")
                    text_body = ""
                    media_id = None
                    media_mime_type = None
                    media_filename = None
                    media_caption = None

                    if msg_type == "text" and isinstance(msg.get("text"), dict):
                        text_body = msg["text"].get("body", "")
                    elif msg_type == "button" and isinstance(msg.get("button"), dict):
                        text_body = msg["button"].get("text", "")
                    elif msg_type == "interactive" and isinstance(msg.get("interactive"), dict):
                        interactive = msg["interactive"]
                        if "button_reply" in interactive and isinstance(interactive["button_reply"], dict):
                            text_body = interactive["button_reply"].get("title", "")
                        elif "list_reply" in interactive and isinstance(interactive["list_reply"], dict):
                            text_body = interactive["list_reply"].get("title", "")
                    elif msg_type == "image" and isinstance(msg.get("image"), dict):
                        img = msg["image"]
                        media_id = str(img.get("id", "")) if img.get("id") else None
                        media_mime_type = img.get("mime_type", "image/jpeg")
                        media_caption = img.get("caption")
                        text_body = media_caption or "[Görsel]"
                    elif msg_type == "document" and isinstance(msg.get("document"), dict):
                        doc = msg["document"]
                        media_id = str(doc.get("id", "")) if doc.get("id") else None
                        media_mime_type = doc.get("mime_type", "application/pdf")
                        media_filename = doc.get("filename", "belge.pdf")
                        media_caption = doc.get("caption")
                        text_body = media_caption or media_filename or "[Belge]"
                    elif msg_type == "audio" and isinstance(msg.get("audio"), dict):
                        aud = msg["audio"]
                        media_id = str(aud.get("id", "")) if aud.get("id") else None
                        media_mime_type = aud.get("mime_type", "audio/ogg")
                        text_body = "[Sesli Mesaj]"
                    elif msg_type == "video" and isinstance(msg.get("video"), dict):
                        vid = msg["video"]
                        media_id = str(vid.get("id", "")) if vid.get("id") else None
                        media_mime_type = vid.get("mime_type", "video/mp4")
                        media_caption = vid.get("caption")
                        text_body = media_caption or "[Video]"
                    elif msg_type == "sticker" and isinstance(msg.get("sticker"), dict):
                        stk = msg["sticker"]
                        media_id = str(stk.get("id", "")) if stk.get("id") else None
                        media_mime_type = stk.get("mime_type", "image/webp")
                        text_body = "[Çıkartma]"
                    elif msg_type == "location" and isinstance(msg.get("location"), dict):
                        loc = msg["location"]
                        lat = loc.get("latitude")
                        lng = loc.get("longitude")
                        loc_title = loc.get("name") or loc.get("address") or f"{lat}, {lng}"
                        text_body = f"Konum: {loc_title}"
                    else:
                        text_body = "[Desteklenmeyen Mesaj]"

                    incoming_messages.append(
                        ParsedIncomingMessage(
                            message_id=str(msg_id),
                            sender_phone=str(from_phone),
                            sender_name=contacts_map.get(str(from_phone)),
                            text=text_body,
                            timestamp=_safe_parse_timestamp(msg.get("timestamp")),
                            raw_type=msg_type,
                            media_id=media_id,
                            media_mime_type=media_mime_type,
                            media_filename=media_filename,
                            media_caption=media_caption,
                        )
                    )

            # 2. Parse status updates
            statuses = val.get("statuses", [])
            if isinstance(statuses, list):
                for st in statuses:
                    if not isinstance(st, dict):
                        continue
                    msg_id = st.get("id")
                    raw_status = st.get("status", "").lower()
                    if not msg_id or raw_status not in META_STATUS_MAP:
                        continue

                    recipient_id = str(st.get("recipient_id", ""))
                    mapped_status = META_STATUS_MAP[raw_status]

                    err_code: Optional[int] = None
                    err_msg: Optional[str] = None
                    errors = st.get("errors", [])
                    if isinstance(errors, list) and len(errors) > 0 and isinstance(errors[0], dict):
                        err_code = errors[0].get("code")
                        err_msg = errors[0].get("message") or errors[0].get("title")

                    status_updates.append(
                        ParsedStatusUpdate(
                            message_id=str(msg_id),
                            recipient_phone=recipient_id,
                            status=mapped_status,
                            timestamp=_safe_parse_timestamp(st.get("timestamp")),
                            error_code=err_code,
                            error_message=err_msg,
                        )
                    )

    return incoming_messages, status_updates
