"""
Meta WhatsApp Cloud API Webhook Parser.

Extracts, validates, and normalizes incoming webhook payloads according to
Meta Cloud API specifications. Handles arbitrary unknown fields gracefully.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import logging

from backend.app.models.message import MessageType

logger = logging.getLogger(__name__)


@dataclass
class NormalizedInboundMessage:
    """Normalized inbound WhatsApp message extracted from a Meta webhook event."""
    wa_message_id: str
    phone_number_id: str
    from_phone: str
    sender_name: Optional[str] = None
    body: Optional[str] = None
    message_type: MessageType = MessageType.TEXT
    timestamp: Optional[datetime] = None
    media_id: Optional[str] = None
    media_mime_type: Optional[str] = None
    media_filename: Optional[str] = None
    media_caption: Optional[str] = None
    display_phone_number: Optional[str] = None
    waba_id: Optional[str] = None
    raw_payload: Dict[str, Any] = field(default_factory=dict)


@dataclass
class NormalizedStatusUpdate:
    """Normalized outbound message status update extracted from a Meta webhook event."""
    wa_message_id: str
    phone_number_id: str
    recipient_phone: str
    status: str  # "sent", "delivered", "read", "failed"
    timestamp: Optional[datetime] = None
    error_code: Optional[int] = None
    error_message: Optional[str] = None
    display_phone_number: Optional[str] = None
    waba_id: Optional[str] = None
    raw_payload: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ParsedWebhookBatch:
    """Batch container of all parsed events from a webhook payload."""
    object_type: str
    is_valid_object: bool
    phone_number_ids: List[str]
    messages: List[NormalizedInboundMessage]
    statuses: List[NormalizedStatusUpdate]
    raw_payload: Dict[str, Any]


class MetaWebhookParser:
    """Stateless parser for Meta Cloud API webhook payloads."""

    @staticmethod
    def parse_timestamp(ts_val: Any) -> datetime:
        """Safely parses a Unix epoch timestamp (seconds) or ISO string to UTC datetime."""
        if ts_val is None:
            return datetime.now(timezone.utc)
        if isinstance(ts_val, (int, float)):
            try:
                return datetime.fromtimestamp(ts_val, tz=timezone.utc)
            except Exception:
                return datetime.now(timezone.utc)
        if isinstance(ts_val, str):
            ts_str = ts_val.strip()
            # Try numeric epoch
            try:
                epoch = float(ts_str)
                return datetime.fromtimestamp(epoch, tz=timezone.utc)
            except (ValueError, OverflowError):
                pass
            # Try ISO format
            try:
                dt = datetime.fromisoformat(ts_str)
                if dt.tzinfo is None:
                    return dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc)
            except Exception:
                pass
        return datetime.now(timezone.utc)

    @classmethod
    def parse_payload(cls, payload: Any) -> ParsedWebhookBatch:
        """
        Parses raw dict payload from Meta Webhook POST into normalized structures.
        Tolerates malformed entries and unknown fields.
        """
        if not isinstance(payload, dict):
            return ParsedWebhookBatch(
                object_type="unknown",
                is_valid_object=False,
                phone_number_ids=[],
                messages=[],
                statuses=[],
                raw_payload={},
            )

        object_type = str(payload.get("object") or "")
        is_valid_object = (object_type == "whatsapp_business_account")

        parsed_messages: List[NormalizedInboundMessage] = []
        parsed_statuses: List[NormalizedStatusUpdate] = []
        extracted_phone_ids: List[str] = []

        if not is_valid_object:
            logger.warning("[MetaWebhookParser] Received unexpected object type: %s", object_type)
            return ParsedWebhookBatch(
                object_type=object_type,
                is_valid_object=False,
                phone_number_ids=[],
                messages=[],
                statuses=[],
                raw_payload=payload,
            )

        entries = payload.get("entry", [])
        if not isinstance(entries, list):
            return ParsedWebhookBatch(
                object_type=object_type,
                is_valid_object=True,
                phone_number_ids=[],
                messages=[],
                statuses=[],
                raw_payload=payload,
            )

        for entry in entries:
            if not isinstance(entry, dict):
                continue
            waba_id = str(entry.get("id") or "")
            changes = entry.get("changes", [])
            if not isinstance(changes, list):
                continue

            for change in changes:
                if not isinstance(change, dict):
                    continue
                value = change.get("value", {})
                if not isinstance(value, dict):
                    continue

                metadata = value.get("metadata", {})
                phone_number_id = str(metadata.get("phone_number_id") or "") if isinstance(metadata, dict) else ""
                display_phone = str(metadata.get("display_phone_number") or "") if isinstance(metadata, dict) else ""

                if phone_number_id and phone_number_id not in extracted_phone_ids:
                    extracted_phone_ids.append(phone_number_id)

                # Contacts mapping (wa_id -> profile.name)
                contacts_map: Dict[str, str] = {}
                contacts_list = value.get("contacts", [])
                if isinstance(contacts_list, list):
                    for c in contacts_list:
                        if isinstance(c, dict):
                            wa_id = str(c.get("wa_id") or "")
                            prof = c.get("profile", {})
                            if isinstance(prof, dict):
                                name = prof.get("name")
                                if wa_id and name:
                                    contacts_map[wa_id] = str(name).strip()

                # Parse inbound messages
                messages = value.get("messages", [])
                if isinstance(messages, list):
                    for msg in messages:
                        if not isinstance(msg, dict):
                            continue
                        parsed_msg = cls._parse_single_message(
                            msg=msg,
                            phone_number_id=phone_number_id,
                            display_phone=display_phone,
                            waba_id=waba_id,
                            contacts_map=contacts_map,
                        )
                        if parsed_msg:
                            parsed_messages.append(parsed_msg)

                # Parse statuses
                statuses = value.get("statuses", [])
                if isinstance(statuses, list):
                    for st in statuses:
                        if not isinstance(st, dict):
                            continue
                        parsed_st = cls._parse_single_status(
                            st=st,
                            phone_number_id=phone_number_id,
                            display_phone=display_phone,
                            waba_id=waba_id,
                        )
                        if parsed_st:
                            parsed_statuses.append(parsed_st)

        return ParsedWebhookBatch(
            object_type=object_type,
            is_valid_object=True,
            phone_number_ids=extracted_phone_ids,
            messages=parsed_messages,
            statuses=parsed_statuses,
            raw_payload=payload,
        )

    @classmethod
    def _parse_single_message(
        cls,
        msg: Dict[str, Any],
        phone_number_id: str,
        display_phone: str,
        waba_id: str,
        contacts_map: Dict[str, str],
    ) -> Optional[NormalizedInboundMessage]:
        wamid = str(msg.get("id") or "").strip()
        from_phone = str(msg.get("from") or "").strip()
        if not wamid or not from_phone:
            return None

        msg_type_str = str(msg.get("type") or "text").lower().strip()
        dt = cls.parse_timestamp(msg.get("timestamp"))

        sender_name = contacts_map.get(from_phone)

        # Default fields
        body: Optional[str] = None
        message_type = MessageType.UNKNOWN
        media_id: Optional[str] = None
        media_mime_type: Optional[str] = None
        media_filename: Optional[str] = None
        media_caption: Optional[str] = None

        if msg_type_str == "text":
            message_type = MessageType.TEXT
            text_obj = msg.get("text", {})
            if isinstance(text_obj, dict):
                body = str(text_obj.get("body") or "")

        elif msg_type_str == "image":
            message_type = MessageType.IMAGE
            img = msg.get("image", {})
            if isinstance(img, dict):
                media_id = str(img.get("id") or "") or None
                media_mime_type = str(img.get("mime_type") or "image/jpeg")
                media_caption = img.get("caption")
                body = media_caption or "[Görsel]"

        elif msg_type_str == "audio":
            message_type = MessageType.AUDIO
            aud = msg.get("audio", {})
            if isinstance(aud, dict):
                media_id = str(aud.get("id") or "") or None
                media_mime_type = str(aud.get("mime_type") or "audio/ogg")
                body = "[Sesli Mesaj]"

        elif msg_type_str == "video":
            message_type = MessageType.VIDEO
            vid = msg.get("video", {})
            if isinstance(vid, dict):
                media_id = str(vid.get("id") or "") or None
                media_mime_type = str(vid.get("mime_type") or "video/mp4")
                media_caption = vid.get("caption")
                body = media_caption or "[Video]"

        elif msg_type_str == "document":
            message_type = MessageType.DOCUMENT
            doc = msg.get("document", {})
            if isinstance(doc, dict):
                media_id = str(doc.get("id") or "") or None
                media_mime_type = str(doc.get("mime_type") or "application/pdf")
                media_filename = str(doc.get("filename") or "dosya.pdf")
                media_caption = doc.get("caption")
                body = media_caption or media_filename or "[Belge]"

        elif msg_type_str == "sticker":
            message_type = MessageType.STICKER
            stk = msg.get("sticker", {})
            if isinstance(stk, dict):
                media_id = str(stk.get("id") or "") or None
                media_mime_type = str(stk.get("mime_type") or "image/webp")
                body = "[Çıkartma]"

        elif msg_type_str == "location":
            message_type = MessageType.LOCATION
            loc = msg.get("location", {})
            if isinstance(loc, dict):
                lat = loc.get("latitude")
                lng = loc.get("longitude")
                name = loc.get("name") or loc.get("address")
                body = f"Konum: {name or f'{lat}, {lng}'}"

        elif msg_type_str in ("contacts", "contact"):
            message_type = MessageType.CONTACT
            c_list = msg.get("contacts", [])
            contact_names = []
            if isinstance(c_list, list):
                for c in c_list:
                    if isinstance(c, dict) and isinstance(c.get("name"), dict):
                        contact_names.append(str(c["name"].get("formatted_name") or ""))
            body = f"Kişi Paylaşımı: {', '.join(filter(None, contact_names)) or 'Bilinmeyen'}"

        elif msg_type_str == "button":
            message_type = MessageType.TEXT
            btn = msg.get("button", {})
            if isinstance(btn, dict):
                body = str(btn.get("text") or "")

        elif msg_type_str == "interactive":
            message_type = MessageType.TEXT
            interactive = msg.get("interactive", {})
            if isinstance(interactive, dict):
                if "button_reply" in interactive and isinstance(interactive["button_reply"], dict):
                    body = str(interactive["button_reply"].get("title") or "")
                elif "list_reply" in interactive and isinstance(interactive["list_reply"], dict):
                    body = str(interactive["list_reply"].get("title") or "")

        else:
            # Future or unknown message types
            message_type = MessageType.UNKNOWN
            body = f"[{msg_type_str.capitalize()} Mesajı]"

        return NormalizedInboundMessage(
            wa_message_id=wamid,
            phone_number_id=phone_number_id,
            from_phone=from_phone,
            sender_name=sender_name,
            body=body,
            message_type=message_type,
            timestamp=dt,
            media_id=media_id,
            media_mime_type=media_mime_type,
            media_filename=media_filename,
            media_caption=media_caption,
            display_phone_number=display_phone,
            waba_id=waba_id,
            raw_payload=msg,
        )

    @classmethod
    def _parse_single_status(
        cls,
        st: Dict[str, Any],
        phone_number_id: str,
        display_phone: str,
        waba_id: str,
    ) -> Optional[NormalizedStatusUpdate]:
        wamid = str(st.get("id") or "").strip()
        status_str = str(st.get("status") or "").lower().strip()
        if not wamid or not status_str:
            return None

        recipient_id = str(st.get("recipient_id") or "")
        dt = cls.parse_timestamp(st.get("timestamp"))

        err_code: Optional[int] = None
        err_msg: Optional[str] = None
        errors = st.get("errors", [])
        if isinstance(errors, list) and len(errors) > 0 and isinstance(errors[0], dict):
            err_code = errors[0].get("code")
            err_msg = errors[0].get("message") or errors[0].get("title")

        return NormalizedStatusUpdate(
            wa_message_id=wamid,
            phone_number_id=phone_number_id,
            recipient_phone=recipient_id,
            status=status_str,
            timestamp=dt,
            error_code=err_code,
            error_message=err_msg,
            display_phone_number=display_phone,
            waba_id=waba_id,
            raw_payload=st,
        )
