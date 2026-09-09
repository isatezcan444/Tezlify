"""
Meta WhatsApp Cloud API (Graph API) HTTP Client.

Provides an isolated, production-grade HTTP client abstraction for communicating
with Meta Graph API's WhatsApp Business endpoints.
Handles authentication, request construction, response mapping, and structured error isolation.
"""
import os
import random
import asyncio
import logging
from typing import Dict, Any, Optional, List
import httpx

from backend.app.core.config import settings
from backend.app.schemas.whatsapp_cloud import WhatsAppCloudSendMessageRequest, WhatsAppCloudTextObject

logger = logging.getLogger(__name__)


# ==============================================================================
# NotebookLM WhatsApp API Audit: Error Code Classifications
# ==============================================================================

# Transient errors eligible for exponential backoff + jitter retry
TRANSIENT_ERROR_CODES = {
    130429,  # Cloud API Rate Limit Hit (Throughput)
    131056,  # Business Pair Rate Limit Hit
}
TRANSIENT_HTTP_STATUSES = {429, 500, 502, 503, 504}

# Fail-fast permanent errors that should NEVER be retried
FAIL_FAST_ERROR_CODES = {
    190,     # Access token expired / invalid
    131047,  # Re-engagement message / 24-hour customer window expired (requires template)
    131026,  # Message undeliverable (not on WhatsApp or blocked)
    131051,  # Unsupported message type
    131052,  # Media download error from customer device
    132000,  # Template does not exist
    132001,  # Template name does not exist in the specified language
    132015,  # Template paused or disabled due to low quality rating
    100,     # Invalid parameter
}


# ==============================================================================
# Structured Exceptions for Meta Graph API
# ==============================================================================

class WhatsAppCloudApiError(Exception):
    """Base exception for Meta Graph API communication failures."""
    def __init__(self, message: str, status_code: Optional[int] = None, error_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code


class WhatsAppCloudAuthError(WhatsAppCloudApiError):
    """Raised when Meta rejects credentials (invalid token, expired token, missing scopes)."""
    pass


class WhatsAppCloudRateLimitError(WhatsAppCloudApiError):
    """Raised when Meta rate limits are exceeded (429 or code 130429)."""
    pass


class WhatsAppCloudInvalidRequestError(WhatsAppCloudApiError):
    """Raised when request payload or recipient phone number is rejected by Meta."""
    pass


class WhatsAppCloudNetworkError(WhatsAppCloudApiError):
    """Raised when network connection, DNS resolution, or timeout fails."""
    pass


# ==============================================================================
# WhatsApp Cloud API Client
# ==============================================================================

class WhatsAppCloudApiClient:
    """
    HTTP client for Meta WhatsApp Cloud API.
    
    Security Contract:
    - Never logs Bearer tokens, App Secrets, or raw Authorization headers.
    - Isolates Graph API HTTP communication from business logic.
    """

    def __init__(
        self,
        access_token: Optional[str] = None,
        phone_number_id: Optional[str] = None,
        api_version: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 15.0,
    ):
        self.access_token = access_token or settings.WHATSAPP_CLOUD_ACCESS_TOKEN
        self.phone_number_id = phone_number_id or settings.WHATSAPP_CLOUD_PHONE_NUMBER_ID
        self.api_version = api_version or settings.WHATSAPP_CLOUD_API_VERSION
        self.base_url = (base_url or settings.WHATSAPP_CLOUD_GRAPH_API_BASE_URL).rstrip("/")
        self.timeout = timeout

    @property
    def messages_endpoint_url(self) -> str:
        """Constructs the Meta Graph API endpoint URL for sending messages."""
        return f"{self.base_url}/{self.api_version}/{self.phone_number_id}/messages"

    def _get_headers(self) -> Dict[str, str]:
        """Constructs HTTP request headers."""
        if not self.access_token:
            raise WhatsAppCloudAuthError(
                "WhatsApp Cloud Access Token is not configured. Please set WHATSAPP_CLOUD_ACCESS_TOKEN in .env",
                status_code=401,
            )
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    @staticmethod
    def is_transient_error(meta_code: Optional[int], http_status: int) -> bool:
        """Determines if a Meta Graph API error is temporary and eligible for retry."""
        if meta_code in TRANSIENT_ERROR_CODES:
            return True
        if http_status in TRANSIENT_HTTP_STATUSES:
            return True
        return False

    @staticmethod
    def is_fail_fast_error(meta_code: Optional[int], http_status: int) -> bool:
        """Determines if an error is permanent and should fail immediately without retries."""
        if meta_code in FAIL_FAST_ERROR_CODES:
            return True
        if http_status in (400, 401, 403, 404):
            return True
        return False

    async def _post_with_retry(
        self,
        client: httpx.AsyncClient,
        url: str,
        json_payload: dict,
        headers: dict,
        max_retries: int = 2,
    ) -> httpx.Response:
        """
        Executes an HTTP POST against Meta Graph API with exponential backoff and jitter
        for transient error codes (e.g. 130429, 131056, 503) and immediate fail-fast for
        permanent errors (e.g. 190, 131047, 131026).
        """
        is_test = bool(os.getenv("PYTEST_CURRENT_TEST"))
        base_delay = 0.01 if is_test else 0.5

        last_resp = None
        for attempt in range(max_retries + 1):
            resp = await client.post(url, json=json_payload, headers=headers)
            last_resp = resp
            if resp.status_code == 200:
                return resp

            meta_code = None
            try:
                meta_code = resp.json().get("error", {}).get("code")
            except Exception:
                pass

            # Fail-fast check
            if self.is_fail_fast_error(meta_code, resp.status_code):
                logger.warning(
                    f"[WhatsAppCloudApiClient] Fail-fast error encountered (code={meta_code}, status={resp.status_code}). Not retrying."
                )
                return resp

            # Transient check
            if self.is_transient_error(meta_code, resp.status_code) and attempt < max_retries:
                delay = base_delay * (2 ** attempt) + (0.001 if is_test else random.uniform(0.1, 0.4))
                logger.warning(
                    f"[WhatsAppCloudApiClient] Transient error (code={meta_code}, status={resp.status_code}). "
                    f"Retrying in {delay:.2f}s (attempt {attempt + 1}/{max_retries})..."
                )
                await asyncio.sleep(delay)
                continue

            return resp
        return last_resp

    async def send_text_message(
        self,
        to_phone: str,
        message_text: str,
        preview_url: bool = False,
    ) -> Dict[str, Any]:
        """
        Sends a standard text message to a WhatsApp user via Meta Cloud API.

        Args:
            to_phone: Recipient phone number (E.164 or digits format).
            message_text: Message body string.
            preview_url: Whether to enable link previews.

        Returns:
            Dict format:
            {
                "success": bool,
                "message_id": Optional[str],
                "error": Optional[str]
            }
        """
        if not self.phone_number_id:
            error_msg = "WHATSAPP_CLOUD_PHONE_NUMBER_ID is not configured."
            logger.error(f"[WhatsAppCloudApiClient] {error_msg}")
            return {"success": False, "message_id": None, "error": error_msg}

        # Normalize phone to pure digits without '+' or punctuation
        clean_phone = to_phone.replace("+", "").replace(" ", "").replace("-", "").replace("(", "").replace(")", "")

        request_body = WhatsAppCloudSendMessageRequest(
            to=clean_phone,
            text=WhatsAppCloudTextObject(body=message_text, preview_url=preview_url)
        ).model_dump()

        try:
            headers = self._get_headers()
        except WhatsAppCloudAuthError as e:
            return {"success": False, "message_id": None, "error": str(e)}

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await self._post_with_retry(
                    client,
                    self.messages_endpoint_url,
                    json_payload=request_body,
                    headers=headers,
                )

                if resp.status_code == 200:
                    data = resp.json()
                    messages = data.get("messages", [])
                    wa_message_id = messages[0].get("id") if messages else None
                    logger.info(
                        f"[WhatsAppCloudApiClient] Message dispatched successfully: "
                        f"recipient={clean_phone}, message_id={wa_message_id}"
                    )
                    return {
                        "success": True,
                        "message_id": wa_message_id,
                        "error": None,
                    }

                # Handle Meta API Errors
                return self._handle_meta_error_response(resp)

        except httpx.TimeoutException as e:
            error_msg = f"Meta Graph API request timed out ({self.timeout}s): {str(e)}"
            logger.error(f"[WhatsAppCloudApiClient] {error_msg}")
            return {"success": False, "message_id": None, "error": error_msg}

        except httpx.RequestError as e:
            error_msg = f"Meta Graph API network connection error: {str(e)}"
            logger.error(f"[WhatsAppCloudApiClient] {error_msg}")
            return {"success": False, "message_id": None, "error": error_msg}

        except Exception as e:
            error_msg = f"Unexpected error during Meta Cloud API dispatch: {str(e)}"
            logger.error(f"[WhatsAppCloudApiClient] {error_msg}")
            return {"success": False, "message_id": None, "error": error_msg}

    async def send_template_message(
        self,
        to_phone: str,
        template_name: str,
        language_code: str = "tr",
        parameters: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Sends a registered WhatsApp template message via Meta Cloud API.
        Does NOT fall back to standard text message to strictly enforce Meta's 24-hour customer window policy.
        """
        if not self.phone_number_id:
            return {"success": False, "message_id": None, "error": "WHATSAPP_CLOUD_PHONE_NUMBER_ID is not configured."}

        clean_phone = to_phone.replace("+", "").replace(" ", "").replace("-", "").replace("(", "").replace(")", "")

        effective_lang = "en_US" if template_name == "hello_world" else (language_code or "tr")

        template_obj: Dict[str, Any] = {
            "name": template_name,
            "language": {"code": effective_lang},
        }

        if parameters and len(parameters) > 0:
            template_obj["components"] = [
                {
                    "type": "body",
                    "parameters": [{"type": "text", "text": str(p)} for p in parameters],
                }
            ]

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": clean_phone,
            "type": "template",
            "template": template_obj,
        }

        try:
            headers = self._get_headers()
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await self._post_with_retry(client, self.messages_endpoint_url, json_payload=payload, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    messages = data.get("messages", [])
                    wa_message_id = messages[0].get("id") if messages else None
                    logger.info(f"[WhatsAppCloudApiClient] Template '{template_name}' sent to {clean_phone}: {wa_message_id}")
                    return {"success": True, "message_id": wa_message_id, "error": None}

                return self._handle_meta_error_response(resp)
        except Exception as e:
            error_msg = f"Unexpected error during Meta Cloud API template dispatch: {str(e)}"
            logger.error(f"[WhatsAppCloudApiClient] {error_msg}")
            return {"success": False, "message_id": None, "error": error_msg}

    async def send_media_message(
        self,
        to_phone: str,
        media_type: str,  # "image" or "document"
        media_url: str,
        caption: Optional[str] = None,
        filename: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Sends an outbound media message (IMAGE or DOCUMENT) to a recipient.
        """
        if not self.phone_number_id:
            return {"success": False, "message_id": None, "error": "WHATSAPP_CLOUD_PHONE_NUMBER_ID is not configured."}

        clean_phone = to_phone.replace("+", "").replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
        m_type = media_type.lower()
        media_obj: Dict[str, Any] = {"link": media_url}
        if caption:
            media_obj["caption"] = caption
        if filename and m_type == "document":
            media_obj["filename"] = filename

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": clean_phone,
            "type": m_type,
            m_type: media_obj,
        }

        try:
            headers = self._get_headers()
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await self._post_with_retry(client, self.messages_endpoint_url, json_payload=payload, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    messages = data.get("messages", [])
                    wa_message_id = messages[0].get("id") if messages else None
                    return {"success": True, "message_id": wa_message_id, "error": None}
                return self._handle_meta_error_response(resp)
        except Exception as e:
            return {"success": False, "message_id": None, "error": str(e)}

    async def download_media(self, media_id: str) -> Dict[str, Any]:
        """
        Downloads media (image, audio, video, document) sent by a WhatsApp user.
        Strict 2-step authenticated protocol per NotebookLM Job 5 audit:
        Step 1: GET /{api_version}/{media_id} with Bearer token to get media download URL.
        Step 2: GET {url} with Bearer token to fetch raw binary payload.
        """
        if not media_id:
            return {"success": False, "content": None, "error": "media_id is required."}

        try:
            headers = self._get_headers()
        except WhatsAppCloudAuthError as e:
            return {"success": False, "content": None, "error": str(e)}

        meta_media_info_url = f"{self.base_url}/{self.api_version}/{media_id}"

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                # Step 1: Query Graph API for media URL
                info_resp = await client.get(meta_media_info_url, headers=headers)
                if info_resp.status_code != 200:
                    return self._handle_meta_error_response(info_resp)

                info_data = info_resp.json()
                download_url = info_data.get("url")
                mime_type = info_data.get("mime_type")
                file_size = info_data.get("file_size")

                if not download_url:
                    return {
                        "success": False,
                        "content": None,
                        "error": "Media download URL not returned by Meta.",
                    }

                # Step 2: Download raw media bytes (CRITICAL: Bearer token is required)
                media_resp = await client.get(download_url, headers=headers)
                if media_resp.status_code != 200:
                    return {
                        "success": False,
                        "content": None,
                        "error": f"Failed to download media binary stream: HTTP {media_resp.status_code}",
                    }

                logger.info(
                    f"[WhatsAppCloudApiClient] Media {media_id} downloaded successfully: "
                    f"mime={mime_type}, bytes={len(media_resp.content)}"
                )
                return {
                    "success": True,
                    "content": media_resp.content,
                    "mime_type": mime_type,
                    "file_size": file_size or len(media_resp.content),
                    "error": None,
                }
        except Exception as e:
            error_msg = f"Unexpected error during Meta media download: {str(e)}"
            logger.error(f"[WhatsAppCloudApiClient] {error_msg}")
            return {"success": False, "content": None, "error": error_msg}

    async def mark_as_read(self, message_id: str) -> bool:
        """
        Marks an incoming WhatsApp message as READ in Meta Cloud API.
        """
        if not self.phone_number_id or not self.access_token:
            return False

        payload = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
        }

        try:
            headers = self._get_headers()
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(self.messages_endpoint_url, json=payload, headers=headers)
                return resp.status_code == 200
        except Exception as e:
            logger.warning(f"[WhatsAppCloudApiClient] mark_as_read failed for {message_id}: {e}")
            return False

    def _handle_meta_error_response(self, resp: httpx.Response) -> Dict[str, Any]:
        """Parses and formats Meta error responses into human-readable messages without leaking secrets."""
        status_code = resp.status_code
        try:
            data = resp.json()
            error_obj = data.get("error", {})
            meta_code = error_obj.get("code")
            meta_subcode = error_obj.get("error_subcode")
            meta_msg = error_obj.get("message", resp.text)
            user_title = error_obj.get("error_user_title", "")
            user_msg = error_obj.get("error_user_msg", "")

            details = f"Meta Error (HTTP {status_code}, code {meta_code}"
            if meta_subcode:
                details += f", subcode {meta_subcode}"
            details += f"): {meta_msg}"
            if user_msg:
                details += f" - {user_title}: {user_msg}"

            logger.error(f"[WhatsAppCloudApiClient] {details}")

            return {
                "success": False,
                "message_id": None,
                "error": details,
            }
        except Exception:
            raw_text = resp.text[:200]
            error_msg = f"Meta Graph API HTTP {status_code}: {raw_text}"
            logger.error(f"[WhatsAppCloudApiClient] {error_msg}")
            return {"success": False, "message_id": None, "error": error_msg}
