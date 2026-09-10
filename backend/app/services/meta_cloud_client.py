"""
Meta WhatsApp Cloud API (Graph API) Infrastructure Adapter.

Implements:
- Shared HTTP Connection Pooling (httpx.AsyncClient with keep-alive limits).
- Granular timeouts (connect, read, write, pool).
- Strict selective retry policy (exponential backoff + jitter for 5xx/network; immediate fail-fast on 4xx/auth/client).
- Error normalization into MetaApiError with token/secret redaction.
- Canonical Meta endpoints: phone number inspection, WABA validation, subscribed_apps webhook binding.
"""
import os
import re
import random
import asyncio
import logging
import uuid
from typing import Dict, Any, Optional, List
import httpx

from backend.app.core.config import settings

logger = logging.getLogger(__name__)

# ==============================================================================
# Error Code Classifications
# ==============================================================================

# Transient errors eligible for exponential backoff + jitter retry
TRANSIENT_ERROR_CODES = {
    130429,  # Cloud API Throughput Rate Limit
    131056,  # Business Pair Rate Limit
    2,       # Temporary Meta Service Issue
    1,       # Unknown transient Meta error
}
TRANSIENT_HTTP_STATUSES = {429, 500, 502, 503, 504}

# Permanent errors that must fail fast without retries
FAIL_FAST_ERROR_CODES = {
    190,     # Invalid or expired OAuth access token
    100,     # Invalid parameter / missing required parameter
    200,     # Permissions error
    10,      # Application does not have permission for this action
    131031,  # Account payment issue
    131047,  # 24-hour window expired
    131026,  # Message undeliverable
    131051,  # Unsupported message type
}

# Redaction patterns for secrets in logs/exceptions
SECRET_REDACT_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]+", re.IGNORECASE),
    re.compile(r"access_token=[A-Za-z0-9_\-\.]+", re.IGNORECASE),
    re.compile(r"EAA[A-Za-z0-9_\-\.]+", re.IGNORECASE),
    re.compile(r"(?:app_secret|secret)\s*[:=\s]\s*[A-Za-z0-9_\-\.]{12,}", re.IGNORECASE),
]


def redact_secrets(text: str) -> str:
    """Removes tokens and credentials from strings to prevent leakage in logs or exceptions."""
    if not text:
        return ""
    sanitized = text
    for pattern in SECRET_REDACT_PATTERNS:
        sanitized = pattern.sub("[REDACTED_TOKEN]", sanitized)
    return sanitized


# ==============================================================================
# MetaApiError Normalized Exception
# ==============================================================================

class MetaApiError(Exception):
    """Normalized structured exception representing a failure returned by Meta Graph API."""

    def __init__(
        self,
        message: str,
        http_status: int = 500,
        meta_error_code: Optional[int] = None,
        meta_error_subcode: Optional[int] = None,
        fbtrace_id: Optional[str] = None,
        retryable: bool = False,
        provider: str = "meta",
    ):
        sanitized_msg = redact_secrets(message)
        super().__init__(sanitized_msg)
        self.message = sanitized_msg
        self.http_status = http_status
        self.meta_error_code = meta_error_code
        self.meta_error_subcode = meta_error_subcode
        self.fbtrace_id = fbtrace_id
        self.retryable = retryable
        self.provider = provider

    @classmethod
    def from_meta_response(cls, http_status: int, response_data: Dict[str, Any]) -> "MetaApiError":
        """Normalizes a raw Meta JSON error response into a sanitized MetaApiError."""
        error_dict = response_data.get("error", {}) if isinstance(response_data, dict) else {}
        msg = error_dict.get("message") or str(response_data)
        return cls(
            message=msg,
            http_status=http_status,
            meta_error_code=error_dict.get("code"),
            meta_error_subcode=error_dict.get("error_subcode"),
            fbtrace_id=error_dict.get("fbtrace_id"),
            retryable=http_status in (500, 502, 503, 504, 429),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "http_status": self.http_status,
            "meta_error_code": self.meta_error_code,
            "meta_error_subcode": self.meta_error_subcode,
            "message": self.message,
            "fbtrace_id": self.fbtrace_id,
            "retryable": self.retryable,
        }


class MetaAmbiguousResultError(MetaApiError):
    """
    Raised when an outbound HTTP request outcome is uncertain (e.g. ReadTimeout after transmission).
    Conservative policy: Do NOT automatically retry to prevent duplicate WhatsApp message dispatches.
    """
    def __init__(self, message: str, **kwargs):
        super().__init__(
            message=message,
            http_status=kwargs.get("http_status", 504),
            retryable=False,
            meta_error_code=kwargs.get("meta_error_code"),
            meta_error_subcode=kwargs.get("meta_error_subcode"),
            fbtrace_id=kwargs.get("fbtrace_id"),
            provider="meta",
        )
        self.ambiguous = True


# ==============================================================================
# MetaCloudApiClient Adapter
# ==============================================================================

class MetaCloudApiClient:
    """
    Production-grade HTTP client adapter communicating with Meta Graph API.
    Reuses a single persistent AsyncClient connection pool for optimal performance.
    """

    _shared_client: Optional[httpx.AsyncClient] = None

    def __init__(
        self,
        api_version: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        self.api_version = (api_version or settings.effective_meta_api_version).strip("/")
        self.base_url = (base_url or settings.WHATSAPP_CLOUD_GRAPH_API_BASE_URL or "https://graph.facebook.com").rstrip("/")

    @staticmethod
    def is_retryable_status(status_code: int) -> bool:
        """Determines if an HTTP status code is eligible for transient retry."""
        return status_code in TRANSIENT_HTTP_STATUSES

    _is_retryable_status = is_retryable_status

    @classmethod
    def get_http_client(cls) -> httpx.AsyncClient:
        """
        Returns or lazily creates a singleton httpx.AsyncClient with connection pooling.
        """
        if cls._shared_client is None or cls._shared_client.is_closed:
            limits = httpx.Limits(
                max_keepalive_connections=20,
                max_connections=50,
                keepalive_expiry=30.0,
            )
            timeout = httpx.Timeout(
                connect=5.0,
                read=15.0,
                write=10.0,
                pool=10.0,
            )
            cls._shared_client = httpx.AsyncClient(
                limits=limits,
                timeout=timeout,
                headers={"Accept": "application/json", "User-Agent": "Tezlify-MetaAdapter/2.0"},
            )
        return cls._shared_client

    @classmethod
    async def close_shared_client(cls) -> None:
        """Closes the shared connection pool during application shutdown."""
        if cls._shared_client is not None and not cls._shared_client.is_closed:
            await cls._shared_client.aclose()
            cls._shared_client = None

    def _build_url(self, path: str) -> str:
        clean_path = path.lstrip("/")
        return f"{self.base_url}/{self.api_version}/{clean_path}"

    @staticmethod
    def _is_retryable(http_status: int, meta_code: Optional[int]) -> bool:
        if meta_code in FAIL_FAST_ERROR_CODES:
            return False
        if http_status in (400, 401, 403, 404):
            return False
        if meta_code in TRANSIENT_ERROR_CODES or http_status in TRANSIENT_HTTP_STATUSES:
            return True
        return False

    async def _execute_request(
        self,
        method: str,
        path: str,
        access_token: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        max_retries: int = 2,
    ) -> Dict[str, Any]:
        """
        Executes an HTTP request against Meta Graph API with exponential backoff and jitter.
        Normalizes any error response into MetaApiError.
        """
        if not access_token or not access_token.strip():
            raise MetaApiError("Access token is required for Meta Graph API calls.", http_status=401)

        url = self._build_url(path)
        headers = {
            "Authorization": f"Bearer {access_token.strip()}",
            "Content-Type": "application/json",
        }

        client = self.get_http_client()
        correlation_id = uuid.uuid4().hex[:8]
        is_test = bool(os.getenv("PYTEST_CURRENT_TEST"))
        base_delay = 0.01 if is_test else 0.4

        last_error: Optional[MetaApiError] = None

        for attempt in range(max_retries + 1):
            try:
                resp = await client.request(
                    method=method,
                    url=url,
                    headers=headers,
                    params=params,
                    json=json_data,
                )

                if resp.status_code == 200:
                    try:
                        return resp.json()
                    except Exception:
                        return {"success": True, "raw": resp.text}

                # Parse Meta Error
                meta_error_code = None
                meta_subcode = None
                fbtrace_id = None
                raw_msg = resp.text

                try:
                    err_json = resp.json().get("error", {})
                    meta_error_code = err_json.get("code")
                    meta_subcode = err_json.get("error_subcode")
                    raw_msg = err_json.get("message") or resp.text
                    fbtrace_id = err_json.get("fbtrace_id")
                except Exception:
                    pass

                retryable = self._is_retryable(resp.status_code, meta_error_code)

                # Format humanized error message
                user_msg = f"Meta API error (HTTP {resp.status_code}): {raw_msg}"
                if meta_error_code == 190:
                    user_msg = "Meta erişim token'ı geçersiz veya süresi dolmuş. Lütfen yeni bir token girin."
                elif meta_error_code in (10, 200):
                    user_msg = "Meta erişim token'ı gerekli WhatsApp Business izinlerine sahip değil."
                elif resp.status_code == 404:
                    user_msg = f"Meta kaynağı bulunamadı: {path}"

                meta_err = MetaApiError(
                    message=user_msg,
                    http_status=resp.status_code,
                    meta_error_code=meta_error_code,
                    meta_error_subcode=meta_subcode,
                    fbtrace_id=fbtrace_id,
                    retryable=retryable,
                )

                if not retryable or attempt >= max_retries:
                    logger.warning(
                        f"[MetaCloudApiClient:{correlation_id}] {method} {path} failed: "
                        f"status={resp.status_code}, code={meta_error_code}, retryable={retryable}"
                    )
                    raise meta_err

                last_error = meta_err
                jitter = 0.001 if is_test else random.uniform(0.1, 0.3)
                delay = (base_delay * (2 ** attempt)) + jitter
                logger.info(
                    f"[MetaCloudApiClient:{correlation_id}] Transient error ({resp.status_code}, code={meta_error_code}). "
                    f"Retrying in {delay:.2f}s ({attempt + 1}/{max_retries})..."
                )
                await asyncio.sleep(delay)

            except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout) as net_err:
                logger.warning(f"[MetaCloudApiClient:{correlation_id}] Network error: {type(net_err).__name__}")
                # Non-idempotent message dispatch ambiguity protection:
                # If a ReadTimeout occurs on POST .../messages, the payload was transmitted to Meta.
                # Meta might have sent the WhatsApp message! Resending blindly risks duplicate WhatsApp delivery.
                if method.upper() == "POST" and "messages" in path and isinstance(net_err, (httpx.ReadTimeout, httpx.RemoteProtocolError)):
                    logger.warning(f"[MetaCloudApiClient:{correlation_id}] Ambiguous network timeout on POST messages. Aborting retries to prevent duplicate delivery.")
                    raise MetaAmbiguousResultError(
                        f"Meta Graph API mesaj isteğinde zaman aşımı meydana geldi (sonuç belirsiz): {type(net_err).__name__}",
                        http_status=504,
                    )

                last_error = MetaApiError(
                    message=f"Meta Graph API sunucusuna bağlanılamadı: {type(net_err).__name__}",
                    http_status=503,
                    retryable=True,
                )
                if attempt >= max_retries:
                    raise last_error
                delay = (base_delay * (2 ** attempt)) + (0.001 if is_test else 0.2)
                await asyncio.sleep(delay)

        if last_error:
            raise last_error
        raise MetaApiError("Bilinmeyen Meta API hatası.", http_status=500)

    # ==========================================================================
    # High-Level Domain Operations
    # ==========================================================================

    async def get_phone_number_details(self, phone_number_id: str, access_token: str) -> Dict[str, Any]:
        """
        Retrieves phone number metadata (verified name, display phone number, quality rating)
        by querying GET /{phone_number_id}.
        """
        clean_id = phone_number_id.strip()
        params = {
            "fields": "id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status"
        }
        res = await self._execute_request(
            method="GET",
            path=f"{clean_id}",
            access_token=access_token,
            params=params,
        )
        return {
            "phone_number_id": str(res.get("id", clean_id)),
            "display_phone_number": res.get("display_phone_number", ""),
            "verified_name": res.get("verified_name"),
            "quality_rating": res.get("quality_rating", "UNKNOWN"),
            "code_verification_status": res.get("code_verification_status"),
            "name_status": res.get("name_status"),
        }

    async def get_waba_phone_numbers(self, waba_id: str, access_token: str) -> List[Dict[str, Any]]:
        """
        Queries GET /{waba_id}/phone_numbers to fetch all phone numbers registered under the WABA.
        """
        clean_waba = waba_id.strip()
        params = {
            "fields": "id,display_phone_number,verified_name,quality_rating"
        }
        res = await self._execute_request(
            method="GET",
            path=f"{clean_waba}/phone_numbers",
            access_token=access_token,
            params=params,
        )
        return res.get("data", [])

    async def verify_waba_number_match(self, waba_id: str, phone_number_id: str, access_token: str) -> bool:
        """
        Verifies that the given phone_number_id is strictly registered under the specified WABA.
        Prevents mismatched or fraudulent WABA/phone associations.
        """
        phone_numbers = await self.get_waba_phone_numbers(waba_id, access_token)
        clean_target = str(phone_number_id).strip()
        matched = any(str(p.get("id", "")).strip() == clean_target for p in phone_numbers)
        return matched

    async def subscribe_waba_apps(self, waba_id: str, access_token: str) -> Dict[str, Any]:
        """
        Subscribes the WABA to receive webhooks via POST /{waba_id}/subscribed_apps.
        Idempotent: succeeding or already-subscribed returns success.
        """
        clean_waba = waba_id.strip()
        try:
            res = await self._execute_request(
                method="POST",
                path=f"{clean_waba}/subscribed_apps",
                access_token=access_token,
            )
            return {"success": bool(res.get("success", True)), "data": res}
        except MetaApiError as e:
            # If already subscribed or minor code, treat idempotently
            if e.meta_error_code in (100, 200) and "already subscribed" in e.message.lower():
                return {"success": True, "already_subscribed": True}
            raise e

    async def validate_connection(
        self,
        waba_id: str,
        phone_number_id: str,
        access_token: str,
    ) -> Dict[str, Any]:
        """
        Executes the comprehensive pre-flight verification sequence for connecting a number:
        1. Queries Meta for phone_number_id details (validates token & phone existence).
        2. Queries WABA phone numbers and validates relationship.
        3. Attempts WABA subscribed_apps binding.
        Returns a consolidated metadata dictionary.
        """
        # Step 1: Query phone details
        details = await self.get_phone_number_details(phone_number_id, access_token)

        # Step 2: Validate WABA relationship if waba_id provided
        clean_waba = (waba_id or "").strip()
        if clean_waba:
            is_matched = await self.verify_waba_number_match(clean_waba, phone_number_id, access_token)
            if not is_matched:
                raise MetaApiError(
                    f"Belirtilen Phone Number ID ({phone_number_id}), verilen WABA ({clean_waba}) altında bulunamadı.",
                    http_status=400,
                    meta_error_code=100,
                )

            # Step 3: Subscribed apps
            try:
                await self.subscribe_waba_apps(clean_waba, access_token)
            except Exception as e:
                logger.warning(f"[MetaCloudApiClient] subscribed_apps warning (non-fatal): {e}")

        return {
            "phone_number_id": details["phone_number_id"],
            "display_phone_number": details.get("display_phone_number"),
            "verified_name": details.get("verified_name"),
            "quality_rating": details.get("quality_rating", "UNKNOWN"),
            "waba_id": clean_waba,
            "is_valid": True,
        }

    async def send_text_message(
        self,
        phone_number_id: str,
        access_token: str,
        to_phone: str,
        message_text: str,
        context_message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Dispatches an outbound WhatsApp text message via Meta Graph API:
        POST /{phone_number_id}/messages
        """
        clean_phone_id = str(phone_number_id).strip()
        clean_to = str(to_phone).strip().lstrip("+")
        payload: Dict[str, Any] = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": clean_to,
            "type": "text",
            "text": {
                "body": message_text,
            },
        }
        if context_message_id:
            payload["context"] = {"message_id": context_message_id}

        return await self._execute_request(
            method="POST",
            path=f"{clean_phone_id}/messages",
            access_token=access_token,
            json_data=payload,
        )

    async def send_template_message(
        self,
        phone_number_id: str,
        access_token: str,
        to_phone: str,
        template_name: str,
        language_code: str = "tr",
        components: Optional[List[Dict[str, Any]]] = None,
        context_message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Dispatches an outbound WhatsApp pre-approved template message via Meta Graph API:
        POST /{phone_number_id}/messages
        """
        clean_phone_id = str(phone_number_id).strip()
        clean_to = str(to_phone).strip().lstrip("+")
        template_obj: Dict[str, Any] = {
            "name": template_name.strip(),
            "language": {
                "code": language_code.strip() if language_code else "tr",
            },
        }
        if components:
            template_obj["components"] = components

        payload: Dict[str, Any] = {
            "messaging_product": "whatsapp",
            "to": clean_to,
            "type": "template",
            "template": template_obj,
        }
        if context_message_id:
            payload["context"] = {"message_id": context_message_id}

        return await self._execute_request(
            method="POST",
            path=f"{clean_phone_id}/messages",
            access_token=access_token,
            json_data=payload,
        )

