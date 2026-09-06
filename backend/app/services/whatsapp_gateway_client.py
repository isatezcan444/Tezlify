"""
WhatsApp Gateway HTTP Client.
Handles high-performance, non-blocking communication between FastAPI backend
and the Baileys wa-gateway microservice.
"""
import time
import logging
from typing import Optional, Dict, Any
import httpx

from backend.app.core.config import settings

logger = logging.getLogger(__name__)


class WhatsAppGatewayClient:
    """Client for managing Baileys WhatsApp sessions on wa-gateway."""

    def __init__(
        self,
        gateway_url: Optional[str] = None,
        auth_token: Optional[str] = None,
        timeout: float = 1.5,
    ):
        self.gateway_url = (gateway_url or settings.WA_GATEWAY_URL).rstrip("/")
        self.auth_token = auth_token or settings.WA_GATEWAY_AUTH_TOKEN
        self.timeout = timeout
        self._last_unreachable_time: float = 0.0

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        return headers

    def _get_timeout(self, read_timeout: Optional[float] = None) -> httpx.Timeout:
        """Returns a fast-fail connect timeout (0.4s) to eliminate hanging."""
        return httpx.Timeout(timeout=read_timeout or self.timeout, connect=0.4)

    def is_recently_offline(self) -> bool:
        """Returns True if the gateway failed connection within the last 3 seconds."""
        return (time.monotonic() - self._last_unreachable_time) < 3.0

    async def is_gateway_alive(self) -> bool:
        """Checks if the wa-gateway microservice is responding."""
        if self.is_recently_offline():
            return False
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(1.0)) as client:
                res = await client.get(f"{self.gateway_url}/health")
                alive = res.status_code == 200
                if alive:
                    self._last_unreachable_time = 0.0
                return alive
        except Exception:
            self._last_unreachable_time = time.monotonic()
            return False

    async def create_session(self, session_name: str) -> Dict[str, Any]:
        """
        Initializes a WhatsApp Web session on wa-gateway and requests a pairing QR code.
        """
        if self.is_recently_offline() and not settings.SIMULATION_MODE:
            return {"success": False, "error": "Gateway offline (cached)"}

        url = f"{self.gateway_url}/api/sessions/create"
        payload = {"sessionName": session_name}

        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(self.timeout)) as client:
                res = await client.post(url, json=payload, headers=self._headers())
                if res.status_code in (200, 201):
                    self._last_unreachable_time = 0.0
                    data = res.json()
                    session_info = data.get("session", {})
                    return {
                        "success": True,
                        "status": session_info.get("status", "SCAN_QR"),
                        "qr_code": session_info.get("qrImage"),
                        "phone": session_info.get("phone"),
                    }
                else:
                    logger.warning(f"[GatewayClient] create_session HTTP {res.status_code}: {res.text}")
                    return {"success": False, "error": f"Gateway error: {res.text}"}
        except Exception as e:
            self._last_unreachable_time = time.monotonic()
            logger.warning(f"[GatewayClient] create_session connection error: {e}")
            if settings.SIMULATION_MODE:
                return {
                    "success": True,
                    "status": "SCAN_QR",
                    "qr_code": "2@wS12dE98vA==,Tezlify_WA_Pairing_Token_Ready",
                    "phone": None,
                }
            return {"success": False, "error": f"Gateway unreachable: {str(e)}"}

    async def get_session_qr(self, session_name: str) -> Optional[str]:
        """Fetches the latest generated QR code for the session."""
        if self.is_recently_offline():
            return None
        url = f"{self.gateway_url}/api/sessions/{session_name}/qr"
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(1.0)) as client:
                res = await client.get(url, headers=self._headers())
                if res.status_code == 200:
                    self._last_unreachable_time = 0.0
                    return res.json().get("qrImage")
        except Exception as e:
            self._last_unreachable_time = time.monotonic()
            logger.debug(f"[GatewayClient] get_session_qr error: {e}")
        return None

    async def get_session_status(self, session_name: str) -> Dict[str, Any]:
        """Fetches the live status of the session from wa-gateway."""
        if self.is_recently_offline():
            return {"status": "DISCONNECTED", "phone": None}
        url = f"{self.gateway_url}/api/sessions/{session_name}/status"
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(1.0)) as client:
                res = await client.get(url, headers=self._headers())
                if res.status_code == 200:
                    self._last_unreachable_time = 0.0
                    return res.json()
        except Exception as e:
            self._last_unreachable_time = time.monotonic()
            logger.debug(f"[GatewayClient] get_session_status error: {e}")
        return {"status": "DISCONNECTED", "phone": None}

    async def disconnect_session(self, session_name: str) -> bool:
        """Disconnects and logs out the session on wa-gateway."""
        if self.is_recently_offline():
            return False
        url = f"{self.gateway_url}/api/sessions/{session_name}/disconnect"
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(1.0)) as client:
                res = await client.post(url, headers=self._headers())
                return res.status_code == 200
        except Exception as e:
            logger.warning(f"[GatewayClient] disconnect_session error: {e}")
            return False

    async def delete_session(self, session_name: str) -> bool:
        """Deletes session credentials and auth data on wa-gateway."""
        if self.is_recently_offline():
            return False
        url = f"{self.gateway_url}/api/sessions/{session_name}"
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(1.0)) as client:
                res = await client.delete(url, headers=self._headers())
                return res.status_code in (200, 204)
        except Exception as e:
            logger.warning(f"[GatewayClient] delete_session error: {e}")
            return False


gateway_client = WhatsAppGatewayClient()
