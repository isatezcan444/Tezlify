"""
WhatsApp Gateway HTTP Client.
Handles communication between the FastAPI backend and the Baileys wa-gateway microservice.
"""
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
        timeout: float = 10.0,
    ):
        self.gateway_url = (gateway_url or settings.WA_GATEWAY_URL).rstrip("/")
        self.auth_token = auth_token or settings.WA_GATEWAY_AUTH_TOKEN
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        return headers

    async def is_gateway_alive(self) -> bool:
        """Checks if the wa-gateway microservice is responding."""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                res = await client.get(f"{self.gateway_url}/health")
                return res.status_code == 200
        except Exception:
            return False

    async def create_session(self, session_name: str) -> Dict[str, Any]:
        """
        Initializes a WhatsApp Web session on wa-gateway and requests a pairing QR code.
        """
        url = f"{self.gateway_url}/api/sessions/create"
        payload = {"sessionName": session_name}

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(url, json=payload, headers=self._headers())
                if res.status_code in (200, 201):
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
            logger.warning(f"[GatewayClient] create_session connection error: {e}")
            # In simulation mode, return demo fallback
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
        url = f"{self.gateway_url}/api/sessions/{session_name}/qr"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(url, headers=self._headers())
                if res.status_code == 200:
                    return res.json().get("qrImage")
        except Exception as e:
            logger.debug(f"[GatewayClient] get_session_qr error: {e}")
        return None

    async def get_session_status(self, session_name: str) -> Dict[str, Any]:
        """Fetches the live status of the session from wa-gateway."""
        url = f"{self.gateway_url}/api/sessions/{session_name}/status"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(url, headers=self._headers())
                if res.status_code == 200:
                    return res.json()
        except Exception as e:
            logger.debug(f"[GatewayClient] get_session_status error: {e}")
        return {"status": "DISCONNECTED", "phone": None}

    async def disconnect_session(self, session_name: str) -> bool:
        """Disconnects and logs out the session on wa-gateway."""
        url = f"{self.gateway_url}/api/sessions/{session_name}/disconnect"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(url, headers=self._headers())
                return res.status_code == 200
        except Exception as e:
            logger.warning(f"[GatewayClient] disconnect_session error: {e}")
            return False

    async def delete_session(self, session_name: str) -> bool:
        """Deletes session credentials and auth data on wa-gateway."""
        url = f"{self.gateway_url}/api/sessions/{session_name}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.delete(url, headers=self._headers())
                return res.status_code in (200, 204)
        except Exception as e:
            logger.warning(f"[GatewayClient] delete_session error: {e}")
            return False


gateway_client = WhatsAppGatewayClient()
