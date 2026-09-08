"""
WhatsApp Gateway HTTP Client.
Handles high-performance, non-blocking communication between FastAPI backend
and the Baileys wa-gateway microservice.
"""
from __future__ import annotations
import time
import logging
from typing import Optional, Dict, Any, List
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
        """Returns a resilient connect timeout (5.0s) and specified read timeout."""
        return httpx.Timeout(timeout=read_timeout or self.timeout, connect=5.0)

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
                    "qr_code": None,
                    "phone": None,
                }
            return {"success": False, "error": f"Gateway unreachable: {str(e)}"}

    async def refresh_session_qr(self, session_name: str) -> Dict[str, Any]:
        """Requests a forced fresh QR code regeneration on wa-gateway."""
        if self.is_recently_offline() and not settings.SIMULATION_MODE:
            return {"success": False, "error": "Gateway offline"}
        url = f"{self.gateway_url}/api/sessions/{session_name}/refresh-qr"
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(5.0)) as client:
                res = await client.post(url, headers=self._headers())
                if res.status_code == 200:
                    self._last_unreachable_time = 0.0
                    data = res.json()
                    return {
                        "success": True,
                        "status": data.get("status", "SCAN_QR"),
                        "qr_code": data.get("qrImage")
                    }
        except Exception as e:
            self._last_unreachable_time = time.monotonic()
            logger.warning(f"[GatewayClient] refresh_session_qr error: {e}")
        return {"success": False, "qr_code": None}

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
        """Deletes session credentials and auth data on wa-gateway.

        Runs in background (non-blocking), but with a generous timeout:
        Baileys logout + credential wipe routinely exceeds 1s on free-tier
        CPU, and a timed-out delete leaves a live session behind that looks
        "resurrected" to the user.
        """
        if self.is_recently_offline():
            return False
        url = f"{self.gateway_url}/api/sessions/{session_name}"
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(10.0)) as client:
                res = await client.delete(url, headers=self._headers())
                if res.status_code not in (200, 204):
                    logger.warning(
                        f"[GatewayClient] delete_session HTTP {res.status_code} for {session_name}: {res.text[:200]}"
                    )
                    return False
                return True
        except Exception as e:
            logger.warning(f"[GatewayClient] delete_session error for {session_name}: {e}")
            return False

    async def send_message(
        self,
        session_name: str,
        phone: str,
        message: str,
        typing_delay_ms: int = 0
    ) -> Dict[str, Any]:
        """Dispatches an outbound message through an active Baileys session on wa-gateway."""
        url = f"{self.gateway_url}/api/send"
        payload = {
            "session": session_name,
            "phone": phone,
            "message": message,
            "typingDelayMs": typing_delay_ms,
        }
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(25.0)) as client:
                res = await client.post(url, json=payload, headers=self._headers())
                if res.status_code == 200:
                    self._last_unreachable_time = 0.0
                    return res.json()
                else:
                    return {"success": False, "error": f"Gateway HTTP {res.status_code}: {res.text}"}
        except Exception as e:
            self._last_unreachable_time = time.monotonic()
            return {"success": False, "error": f"Gateway unreachable: {str(e)}"}

    async def request_pairing_code(self, session_name: str, phone: str) -> Optional[str]:
        """Requests an 8-digit WhatsApp pairing code for linking via phone number."""
        if self.is_recently_offline():
            return None
        url = f"{self.gateway_url}/api/sessions/{session_name}/pairing-code"
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout(10.0)) as client:
                res = await client.post(url, json={"phone": phone}, headers=self._headers())
                if res.status_code == 200:
                    self._last_unreachable_time = 0.0
                    return res.json().get("pairingCode")
                else:
                    logger.warning(f"[GatewayClient] request_pairing_code failed: {res.text}")
                    return None
        except Exception as e:
            logger.warning(f"[GatewayClient] request_pairing_code error: {e}")
            self._last_unreachable_time = time.monotonic()
            return None




gateway_client = WhatsAppGatewayClient()
