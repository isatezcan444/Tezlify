"""WhatsApp gateway REST istemcisi.

`whatsapp-gateway` Node servisiyle HTTPS/HTTP üzerinden konuşur. Tüm
hata durumları `WhatsAppGatewayError` içine sarılır; asla yanlış pozitif
başarı döndürülmez (AGENTS.md Truthfulness savunması).
"""
import logging
import re
import time
from typing import Any, Dict, List, Optional

import httpx

from backend.app.core.config import settings

logger = logging.getLogger(__name__)


def _diagnostic_route(path: str) -> str:
    """PII-safe route shape for low-volume gateway diagnostics."""
    route = re.sub(r"/sessions/[^/]+", "/sessions/:session", path)
    route = re.sub(r"/conversations/[^/]+", "/conversations/:jid", route)
    route = re.sub(r"/media/[^/?]+", "/media/:media", route)
    return route


class WhatsAppGatewayError(Exception):
    """Gateway çağrısı başarısız oldu (ağ, HTTP durum veya yanıt bozulması)."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[str] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


def gateway_base() -> str:
    return (getattr(settings, "WHATSAPP_GATEWAY_URL", "") or "http://127.0.0.1:8787").rstrip("/")


def gateway_timeout() -> float:
    return float(getattr(settings, "WHATSAPP_GATEWAY_TIMEOUT", 30.0) or 30.0)


def _auth_headers() -> Dict[str, str]:
    """Gateway shared-secret auth header (fail-closed: gateway rejects when unset)."""
    secret = getattr(settings, "WHATSAPP_GATEWAY_SECRET", "") or ""
    if secret:
        return {"Authorization": f"Bearer {secret}"}
    return {}


async def _request(method: str, path: str, **kwargs: Any) -> Any:
    url = f"{gateway_base()}{path}"
    route = _diagnostic_route(path)
    auth = _auth_headers()
    if auth:
        headers = dict(kwargs.get("headers") or {})
        headers.update(auth)
        kwargs["headers"] = headers
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=gateway_timeout()) as client:
            res = await client.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        elapsed_ms = round((time.monotonic() - started) * 1000)
        logger.warning(
            "[WA-GATEWAY-HTTP] Ulaşım hatası (method=%s route=%s elapsed_ms=%d type=%s)",
            method, route, elapsed_ms, type(exc).__name__,
        )
        raise WhatsAppGatewayError(f"Gateway'e ulaşılamadı ({route}): {exc}") from exc
    elapsed_ms = round((time.monotonic() - started) * 1000)
    if res.status_code >= 400:
        logger.warning(
            "[WA-GATEWAY-HTTP] HTTP hata (method=%s route=%s status=%d elapsed_ms=%d)",
            method, route, res.status_code, elapsed_ms,
        )
        body = res.text[:300] if res.text else f"HTTP {res.status_code}"
        raise WhatsAppGatewayError(
            f"Gateway hatası {res.status_code}: {body}",
            status_code=res.status_code,
            response_body=body,
        )
    if elapsed_ms >= 2000:
        logger.info(
            "[WA-GATEWAY-HTTP] Yavaş çağrı (method=%s route=%s status=%d elapsed_ms=%d)",
            method, route, res.status_code, elapsed_ms,
        )
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


async def create_session(name: str, ephemeral: bool = False) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"name": name}
    if ephemeral:
        payload["ephemeral"] = True
    return await _request("POST", "/sessions", json=payload)


async def refresh_avatar(gateway_id: str, jid: str) -> Dict[str, Any]:
    return await _request("POST", f"{_s(gateway_id)}/avatar/refresh", json={"jid": jid})


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

# ---------------------------------------------------------------------------
# Veri duzlemi: TUM cagrilar OTURUM KAPSAMLIDIR.
#
# Guvenlik duzeltmesi: bu fonksiyonlar eskiden oturumsuz yollara
# (`/contacts`, `/conversations/{jid}/messages` ...) gidiyordu ve gateway
# "bagli olan tek oturumu" seciyordu. Cagiranin kimligi hic sorulmadigi icin
# bir kiracinin istegi, bagli olan BASKA bir kiracinin hattindan veri okuyup
# o hattan mesaj gonderebiliyordu. Artik her cagri `gateway_id` tasir ve
# cagiran katman (whatsapp_service) oturumun gercekten o kullaniciya ait
# oldugunu ONCEDEN dogrular.
# ---------------------------------------------------------------------------

def _s(gateway_id: str) -> str:
    """Oturum kapsamli yol on eki. Kimlik bossa fail-closed."""
    gid = str(gateway_id or "").strip()
    if not gid:
        raise WhatsAppGatewayError("Gateway oturum kimligi (gateway_id) zorunludur.")
    return f"/sessions/{gid}"


async def list_contacts(gateway_id: str) -> List[Dict[str, Any]]:
    data = await _request("GET", f"{_s(gateway_id)}/contacts")
    if not isinstance(data, dict):
        raise WhatsAppGatewayError("Gateway contacts response is invalid.")
    contacts = data.get("contacts", [])
    if not isinstance(contacts, list):
        raise WhatsAppGatewayError("Gateway contacts payload is invalid.")
    return contacts


async def list_conversations(
    gateway_id: str,
    search: Optional[str] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> Dict[str, Any]:
    params: Dict[str, Any] = {}
    if search:
        params["search"] = search
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    return await _request("GET", f"{_s(gateway_id)}/conversations", params=params)


async def sync_group_subjects(gateway_id: str, force: bool = False) -> Dict[str, Any]:
    """Faz 8: gateway'den tüm katılımcı grupların subject'ini tek toplu
    istekte çözer (oturum bazında TTL gateway içinde). Hata fail-closed:
    WhatsAppGatewayError yükselir, çağıran yutar ama isim uydurmaz.

    Faz 10 (P1): ``force=True`` gateway'deki 10 dakikalık TTL'i atlar —
    "Eşitle" ve initial-sync böylece daha önce çözülememiş ("Grup" kalan)
    grupları her seferinde yeniden dener.
    """
    payload: Dict[str, Any] = {"force": bool(force)}
    return await _request("POST", f"{_s(gateway_id)}/conversations/sync-groups", json=payload)


async def get_messages(
    gateway_id: str,
    jid: str,
    limit: int = 50,
    before: Optional[int] = None,
    fetch_provider: bool = False,
    oldest_msg_id: Optional[str] = None,
    oldest_msg_from_me: Optional[bool] = None,
    oldest_msg_ts_ms: Optional[int] = None,
) -> Dict[str, Any]:
    params: Dict[str, Any] = {"limit": limit}
    if before is not None:
        params["before"] = before
    if fetch_provider:
        params["fetch_provider"] = "true"
    if oldest_msg_id is not None:
        params["oldest_msg_id"] = str(oldest_msg_id)
    if oldest_msg_from_me is not None:
        params["oldest_msg_from_me"] = "true" if oldest_msg_from_me else "false"
    if oldest_msg_ts_ms is not None:
        params["oldest_msg_timestamp_ms"] = int(oldest_msg_ts_ms)
    return await _request("GET", f"{_s(gateway_id)}/conversations/{jid}/messages", params=params)


async def request_older_history(
    gateway_id: str,
    jid: str,
    count: int = 50,
    oldest_msg_id: Optional[str] = None,
    oldest_msg_from_me: Optional[bool] = None,
    oldest_msg_ts_ms: Optional[int] = None,
    before: Optional[int] = None,
    timeout_ms: Optional[int] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"count": count}
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
    return await _request("POST", f"{_s(gateway_id)}/conversations/{jid}/history", json=payload)


async def list_all_messages(
    gateway_id: str,
    limit: int = 1000,
    offset: int = 0,
    since: Optional[int] = None,
    per_chat_limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Faz 10 (P5): gateway belleğindeki TÜM geçmişi zaman damgası sıralı,
    deterministik offset sayfalamasıyla toplu çeker. initial-sync job'ı
    sohbet-başına getMessages turu (N+1 HTTP) yerine bu tek kanalı kullanır.
    Hata fail-closed: WhatsAppGatewayError yükselir.

    Faz 6 (P0.13 delta sync): ``since`` (epoch saniye) verildiğinde gateway
    yalnızca gerçek mesaj zaman damgası ``since``'tan yeni kayıtları döner —
    suuc DB'deki en son bilinen mesaj zamanından turetilir (uydurma degil).
    Eski gateway suucusu yoksa parametreyi yok sayar → tam gecmis + dedup
    (geriye donuk uyumlu, fail-safe).

    Sorun 1 (initial-sync hızı): ``per_chat_limit`` verildiğinde gateway her
    sohbet için yalnızca EN YENİ N mesajı döner — ilk senkronun yükü sohbet
    başına ~50 mesajla sınırlanır; daha eski geçmiş kullanıcı kaydırdıkça
    lazy hydration ile çekilir. Eski gateway parametreyi yok sayar → tam
    geçmiş + dedup (geriye dönük uyumlu).
    """
    params: Dict[str, Any] = {"limit": limit, "offset": offset}
    if since is not None:
        params["since"] = int(since)
    if per_chat_limit is not None:
        params["perChatLimit"] = int(per_chat_limit)
    return await _request("GET", f"{_s(gateway_id)}/messages/bulk", params=params)


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

async def send_text_message(gateway_id: str, jid: str, body: str, client_message_id: Optional[str] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"body": body}
    if client_message_id:
        payload["client_message_id"] = client_message_id
    return await _request("POST", f"{_s(gateway_id)}/conversations/{jid}/messages", json=payload)


async def send_media_message(gateway_id: str, jid: str, media: Dict[str, Any]) -> Dict[str, Any]:
    return await _request("POST", f"{_s(gateway_id)}/conversations/{jid}/media", json=media)


async def mark_conversation_read(gateway_id: str, jid: str) -> Dict[str, Any]:
    return await _request("POST", f"{_s(gateway_id)}/conversations/{jid}/read")


async def send_typing(gateway_id: str, jid: str, typing: bool = True, duration_ms: int = 4000) -> Dict[str, Any]:
    return await _request(
        "POST", f"{_s(gateway_id)}/conversations/{jid}/typing", json={"typing": typing, "duration_ms": duration_ms}
    )


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

async def fetch_media(gateway_id: str, media_id: str) -> bytes:
    """Gateway'den medya indirir (oturum kapsamli). Yalnızca 2xx bayt döner."""
    url = f"{gateway_base()}{_s(gateway_id)}/media/{media_id}"
    try:
        async with httpx.AsyncClient(timeout=gateway_timeout()) as client:
            res = await client.get(url, headers=_auth_headers())
    except httpx.HTTPError as exc:
        raise WhatsAppGatewayError(f"Medya indirilemedi: {exc}") from exc
    if res.status_code >= 400:
        raise WhatsAppGatewayError(f"Medya bulunamadı (HTTP {res.status_code})")
    return res.content
