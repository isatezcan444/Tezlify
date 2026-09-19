"""
WhatsApp Preview & Message Text Normalization Policy.

Phase 11.6: Extracted from whatsapp_service.py.
Pure, deterministic text normalization, emoji preview tagging, and timestamp ordering.
"""

import logging
import re
from datetime import datetime, timezone
from typing import Dict, Optional

from backend.app.services.whatsapp.identity import is_phone_like, is_raw_jid_name

logger = logging.getLogger(__name__)

# Type to emoji preview label mapping (Faz 10 P2 single shared rule)
TYPE_PREVIEW_LABELS: Dict[str, str] = {
    "IMAGE": "📷 Fotoğraf",
    "VIDEO": "🎥 Video",
    "AUDIO": "🎵 Sesli mesaj",
    "STICKER": "Sticker",
    "DOCUMENT": "📄 Dosya",
    "LOCATION": "📍 Konum",
    "CONTACT": "👤 Kişi kartı",
    "TEMPLATE": "Şablon mesajı",
    "UNKNOWN": "Mesaj",
    "OTHER": "Mesaj",
}

BRACKET_TYPE_RE = re.compile(r"^\[([A-Za-z_]+)\]$")


def parse_dt(value: Optional[str]) -> Optional[datetime]:
    """Parses ISO-8601 formatted timestamp string into datetime."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        logger.warning("WhatsApp zaman damgasi parse edilemedi (value=%r): %s", value, exc)
        return None


def as_naive_utc(value: Optional[datetime]) -> Optional[datetime]:
    """DB columns are naive UTC; normalizes aware datetimes to naive UTC for safe comparison."""
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def normalize_preview_text(message_type: Optional[str], body: Optional[str]) -> str:
    """Bir mesajdan (tip + govde) yuzluk preview metnini uretir.

    Bos govde + medya tipi -> tip etiketi; eski '[IMAGE]' tarzi kalici
    degerler de ayni etikete cevrilir. Metin tipi + bos govde -> bos string
    (ozet YAZILMAZ, mevcut korunur).
    """
    t = str(message_type or "TEXT").upper()
    text = (body or "").strip()
    if text:
        m = BRACKET_TYPE_RE.match(text)
        if m:
            inner = m.group(1).upper()
            # UI'a asla kopeli deger sizmaz: taninmayan tip -> mesajin kendi
            # tip etiketi, o da yoksa genel 'Mesaj'.
            return TYPE_PREVIEW_LABELS.get(inner, TYPE_PREVIEW_LABELS.get(t, "Mesaj"))
        if text in ("[object Object]", "[Medya]"):
            return TYPE_PREVIEW_LABELS.get(t, "Mesaj")
        return text
    if t == "TEXT":
        return ""
    return TYPE_PREVIEW_LABELS.get(t, "Mesaj")


def build_last_message_summary(
    *,
    message_type: Optional[str],
    body: Optional[str],
    sender_name: Optional[str] = None,
    is_group: bool = False,
    direction: Optional[str] = None,
) -> str:
    """Sohbet listesi satiri icin son-mesaj ozetini uretir (tek kural).

    Grup + gelen mesajda cozulmus gonderen adi one eklenir
    ('Ahmet: Toplantıyı yarına aldık.'). Gonderen adi ham JID/LID veya
    telefon gorunumundeyse ya da sohbet adinin kendisiyle ayniysa on ek
    atlanir (WhatsApp Web paritesi: 'Ahmet:' degilse yalans govde).
    """
    base = normalize_preview_text(message_type, body)
    if not base:
        return ""
    name = (sender_name or "").strip()
    if (
        is_group
        and str(direction or "INBOUND").upper() == "INBOUND"
        and name
        and name.upper() != "ME"
        and not is_raw_jid_name(name)
        and not is_phone_like(name)
    ):
        return f"{name}: {base}"
    return base


def should_apply_last_message(
    current_ts: Optional[datetime],
    incoming_ts: Optional[datetime],
    summary: str,
) -> bool:
    """Pure decision logic governing whether an incoming message preview should update conversation state.

    - Empty summary never updates (preserves existing preview).
    - Older or equal timestamp never updates (preserves newer message preview).
    - Realtime message (no timestamp) or newer timestamp always updates.
    """
    if not summary:
        return False
    ts = as_naive_utc(incoming_ts)
    cur = as_naive_utc(current_ts)
    if ts is not None and cur is not None and ts <= cur:
        return False
    return True


def should_apply_unread_count(
    current: Optional[int],
    incoming: Optional[int],
    *,
    current_activity_ts: Optional[datetime] = None,
    incoming_activity_ts: Optional[datetime] = None,
    last_read_at: Optional[datetime] = None,
) -> bool:
    """Pure decision logic for the unread badge after a gateway snapshot/event.

    The gateway owns `unread_count` and reports it VERBATIM, including decreases
    (a chat read on the phone drops to 0 — see the gateway's `chats.update`
    handler). The local value must therefore be able to go DOWN; a monotonic
    `max(local, incoming)` makes a read performed anywhere else permanently
    invisible, so the badge never clears.

    Two guards keep a *stale* snapshot from undoing newer local knowledge:

    - **Decrease guard.** A snapshot whose activity timestamp is OLDER than the
      newest message we already hold cannot account for that message, so it must
      never LOWER the badge.
    - **Read guard.** A snapshot whose activity timestamp is at or before our own
      successful read describes the pre-read state, so it must never RAISE the
      badge back.

    Anything else is applied verbatim — that is how a read performed on another
    device reaches us.

    Note: an absent `incoming_activity_ts` carries no staleness evidence, so the
    snapshot is treated as fresh (fail-open). The gateway always populates
    `last_message_at`, so this branch is a boundary case, not the norm.
    """
    if incoming is None:
        return False
    if current is None:
        return True

    cur = max(0, int(current))
    inc = max(0, int(incoming))
    if inc == cur:
        return False

    inc_ts = as_naive_utc(incoming_activity_ts)
    cur_ts = as_naive_utc(current_activity_ts)
    read_ts = as_naive_utc(last_read_at)

    # Staleness guard, applied symmetrically to BOTH directions:
    # a snapshot whose activity timestamp predates the newest message we
    # already hold cannot know about that message, so it may not move the
    # badge in EITHER direction.
    if inc_ts is not None and cur_ts is not None and inc_ts < cur_ts:
        return False

    # Anything at or after our newest known activity is fresh enough to be
    # believed, so a decrease is applied verbatim.
    if inc < cur:
        return True

    # An increase describing the pre-read state must not resurrect the badge.
    if read_ts is not None and inc_ts is not None and inc_ts <= read_ts:
        return False

    return True
