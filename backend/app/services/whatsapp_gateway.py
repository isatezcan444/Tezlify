"""WhatsApp gateway REST istemcisi.

`whatsapp-gateway` Node servisiyle HTTPS/HTTP üzerinden konuşur. Tüm
hata durumları `WhatsAppGatewayError` içine sarılır; asla yanlış pozitif
başarı döndürülmez (AGENTS.md Truthfulness savunması).
"""
import logging
from typing import Any, Dict, List, Optional

import httpx

from backend.app.core.config import settings

logger = logging.getLogger(__name__)


class WhatsAppGatewayError(Exception):
    """Gateway çağrısı başarısız oldu (ağ, HTTP durum veya yanıt bozulması)."""


def gateway_base() -> str:
    return (getattr(settings, "WHATSAPP_GATEWAY_URL", "") or "http://127.0.0.1:8787").rstrip("/")


def gateway_timeout() -> float:
    return float(getattr(settings, "WHATSAPP_GATEWAY_TIMEOUT", 30.0) or 30.0)


async def _request(method: str, path: str, **kwargs: Any) -> Any:
    url = f"{gateway_base()}{path}"
    try:
        async with httpx.AsyncClient(timeout=gateway_timeout()) as client:
            res = await client.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        raise WhatsAppGatewayError(f"Gateway'e ulaşılamadı ({url}): {exc}") from exc
    if res.status_code >= 400:
        body = res.text[:300] if res.text else f"HTTP {res.status_code}"
        raise WhatsAppGatewayError(f"Gateway hatası {res.status_code}: {body}")
    try:
        return res.json()
    except Exception as exc:
        raise WhatsAppGatewayError(f"Gateway yanıtı JSON değil: {res.text[:200]}") from exc


# ---------------------------------------------------------------------------
# Health & Sessions
# ---------------------------------------------------------------------------

async def health() -> Dict[str, Any]:
    return await _request("GET", "/health")


async def list_sessions() -> List[Dict[str, Any]]:
    data = await _request("GET", "/sessions")
    return data.get("sessions", []) if isinstance(data, dict) else []


async def create_session(name: str) -> Dict[str, Any]:
    return await _request("POST", "/sessions", json={"name": name})


async def get_session_status(session_id: str) -> Dict[str, Any]:
    """Gateway oturum durumunu döndürür (CONNECTED/SCAN_QR/CONNECTING ya da 404 ise hata)."""
    return await _request("GET", f"/sessions/{session_id}")

async def get_session_qr(session_id: str) -> Dict[str, Any]:
    return await _request("GET", f"/sessions/{session_id}/qr")


async def refresh_session_qr(session_id: str) -> Dict[str, Any]:
    return await _request("POST", f"/sessions/{session_id}/qr/refresh")


async def request_pairing_code(session_id: str, phone: str) -> Dict[str, Any]:
    """'Telefon numarası ile bağlan' — gateway'den 8 haneli pairing kodu ister."""
    return await _request("POST", f"/sessions/{session_id}/pair", json={"phone": phone})


async def logout_session(session_id: str) -> Dict[str, Any]:
    return await _request("POST", f"/sessions/{session_id}/logout")


async def delete_session(session_id: str) -> Dict[str, Any]:
    return await _request("DELETE", f"/sessions/{session_id}")


# ---------------------------------------------------------------------------
# Contacts & Conversations
# ---------------------------------------------------------------------------

async def list_contacts() -> List[Dict[str, Any]]:
    data = await _request("GET", "/contacts")
    return data.get("contacts", []) if isinstance(data, dict) else []


async def list_conversations(
    search: Optional[str] = None, limit: Optional[int] = None, offset: Optional[int] = None
) -> Dict[str, Any]:
    params: Dict[str, Any] = {}
    if search:
        params["search"] = search
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    return await _request("GET", "/conversations", params=params)


async def sync_group_subjects() -> Dict[str, Any]:
    """Faz 8: gateway'den tüm katılımcı grupların subject'ini tek toplu
    istekte çözer (oturum bazında TTL gateway içinde). Hata fail-closed:
    WhatsAppGatewayError yükselir, çağıran yutar ama isim uydurmaz."""
    return await _request("POST", "/conversations/sync-groups")


async def get_messages(jid: str, limit: int = 50, before: Optional[int] = None) -> Dict[str, Any]:
    params: Dict[str, Any] = {"limit": limit}
    if before is not None:
        params["before"] = before
    return await _request("GET", f"/conversations/{jid}/messages", params=params)


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

async def send_text_message(jid: str, body: str, client_message_id: Optional[str] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"body": body}
    if client_message_id:
        payload["client_message_id"] = client_message_id
    return await _request("POST", f"/conversations/{jid}/messages", json=payload)


async def send_media_message(jid: str, media: Dict[str, Any]) -> Dict[str, Any]:
    return await _request("POST", f"/conversations/{jid}/media", json=media)


async def mark_conversation_read(jid: str) -> Dict[str, Any]:
    return await _request("POST", f"/conversations/{jid}/read")


async def send_typing(jid: str, typing: bool = True, duration_ms: int = 4000) -> Dict[str, Any]:
    return await _request(
        "POST", f"/conversations/{jid}/typing", json={"typing": typing, "duration_ms": duration_ms}
    )


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

async def fetch_media(media_id: str) -> bytes:
    """Gateway'den medya indirir. Yalnızca 2xx bayt döner."""
    url = f"{gateway_base()}/media/{media_id}"
    try:
        async with httpx.AsyncClient(timeout=gateway_timeout()) as client:
            res = await client.get(url)
    except httpx.HTTPError as exc:
        raise WhatsAppGatewayError(f"Medya indirilemedi: {exc}") from exc
    if res.status_code >= 400:
        raise WhatsAppGatewayError(f"Medya bulunamadı (HTTP {res.status_code})")
    return res.content