"""WhatsApp Gateway Response Normalizers (Phase 11.8).

Pure, deterministic parsers and field extractors for raw gateway JSON dictionaries.
Zero database mutations, zero network I/O, fail-closed validation.
"""
from typing import Any, Dict, List, Optional


def extract_session_id(data: Optional[Dict[str, Any]]) -> Optional[str]:
    """Extracts session identifier from gateway session response.
    
    Checks both canonical 'id' and legacy 'session_id'.
    """
    if not isinstance(data, dict):
        return None
    val = data.get("id") or data.get("session_id")
    return str(val).strip() if val else None


def extract_pairing_code(data: Optional[Dict[str, Any]]) -> Optional[str]:
    """Extracts pairing code from gateway response.
    
    Checks both canonical 'code' and legacy 'pairing_code'.
    """
    if not isinstance(data, dict):
        return None
    val = data.get("code") or data.get("pairing_code")
    return str(val).strip() if val else None


def extract_live_session_fields(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Extracts and normalizes live status fields from gateway session JSON.
    
    Guarantees consistent keys and types. Clears error_message if state is CONNECTED or SCAN_QR.
    """
    if not isinstance(data, dict):
        return {
            "status": None,
            "phone": None,
            "error_message": None,
            "is_phone_online": None,
            "battery_level": None,
            "qr_code": None,
            "sync": {"phase": "idle", "progress": 0},
        }

    status = data.get("status")
    phone = data.get("phone") or data.get("phone_number")
    gw_error = data.get("error_message")
    error_message = (str(gw_error)[:1000] or None) if gw_error is not None else None
    if status in ("CONNECTED", "SCAN_QR"):
        error_message = None

    raw_online = data.get("is_phone_online")
    is_phone_online = bool(raw_online) if raw_online is not None else None

    raw_battery = data.get("battery_level")
    try:
        battery_level = int(raw_battery) if raw_battery is not None else None
    except (ValueError, TypeError):
        battery_level = None

    sync_val = data.get("sync")
    sync = sync_val if isinstance(sync_val, dict) else {"phase": "idle", "progress": 0}

    return {
        "status": str(status) if status else None,
        "phone": str(phone) if phone else None,
        "error_message": error_message,
        "is_phone_online": is_phone_online,
        "battery_level": battery_level,
        "qr_code": str(data.get("qr_code")) if data.get("qr_code") else None,
        "sync": sync,
    }


def extract_send_result(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Extracts wa_message_id and status from message dispatch response."""
    if not isinstance(data, dict):
        return {"wa_message_id": None, "status": None}
    wa_id = data.get("wa_message_id") or data.get("id")
    return {
        "wa_message_id": str(wa_id) if wa_id else None,
        "status": data.get("status"),
    }


def normalize_contacts_payload(data: Any) -> List[Dict[str, Any]]:
    """Validates contacts list payload from gateway GET /sessions/:id/contacts."""
    if not isinstance(data, dict):
        return []
    contacts = data.get("contacts")
    return contacts if isinstance(contacts, list) else []


def normalize_sessions_payload(data: Any) -> List[Dict[str, Any]]:
    """Validates sessions list payload from gateway GET /sessions."""
    if not isinstance(data, dict):
        return []
    sessions = data.get("sessions")
    return sessions if isinstance(sessions, list) else []


def normalize_sync_job_status(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Normalizes sync job status or progress dict."""
    if not isinstance(data, dict):
        return {"phase": "idle", "progress": 0}
    return {
        "phase": str(data.get("phase") or "idle"),
        "progress": int(data.get("progress") or 0),
        "total": data.get("total"),
        "current": data.get("current"),
    }
