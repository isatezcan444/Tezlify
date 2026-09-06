"""
Meta WhatsApp Cloud API Diagnostic & Health Check Script.

Performs a secure health check against Meta Graph API:
- Validates token presence and Phone Number ID configuration.
- Checks endpoint reachability and account verification status.
- Classifies token status (VALID, EXPIRED, INVALID, PERMISSION_ERROR, NETWORK_ERROR).
- NEVER prints, logs, or exports access tokens or secrets.
"""
import sys
import asyncio
import httpx
from typing import Dict, Any

from backend.app.core.config import settings
from backend.app.services.whatsapp_cloud_client import WhatsAppCloudApiClient


async def verify_whatsapp_cloud_health() -> Dict[str, Any]:
    client = WhatsAppCloudApiClient()
    token_present = bool(client.access_token)
    phone_id_present = bool(client.phone_number_id)
    waba_id_present = bool(settings.WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID)

    result = {
        "configured": phone_id_present and token_present,
        "token_present": token_present,
        "token_value": "[REDACTED]",
        "phone_number_id": client.phone_number_id or "[NOT_CONFIGURED]",
        "waba_id": settings.WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID or "[NOT_CONFIGURED]",
        "api_version": client.api_version,
        "base_url": client.base_url,
        "status": "UNKNOWN",
        "http_status": None,
        "details": "",
        "verified_name": None,
        "display_phone_number": None,
    }

    if not token_present:
        result["status"] = "INVALID"
        result["details"] = "WHATSAPP_CLOUD_ACCESS_TOKEN is not configured in .env"
        return result

    if not phone_id_present:
        result["status"] = "INVALID"
        result["details"] = "WHATSAPP_CLOUD_PHONE_NUMBER_ID is not configured in .env"
        return result

    url = f"{client.base_url}/{client.api_version}/{client.phone_number_id}"
    headers = {
        "Authorization": f"Bearer {client.access_token}",
        "Accept": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=12.0) as http_client:
            res = await http_client.get(url, headers=headers)
            result["http_status"] = res.status_code

            if res.status_code == 200:
                data = res.json()
                result["status"] = "VALID"
                result["verified_name"] = data.get("verified_name")
                result["display_phone_number"] = data.get("display_phone_number")
                result["details"] = f"Verified: {data.get('verified_name')} ({data.get('display_phone_number')})"
            else:
                err_body = res.json().get("error", {})
                err_code = err_body.get("code")
                err_subcode = err_body.get("error_subcode")
                err_msg = err_body.get("message", res.text)

                if err_code == 190 and err_subcode == 463:
                    result["status"] = "EXPIRED"
                elif err_code == 190:
                    result["status"] = "INVALID"
                elif res.status_code in (401, 403):
                    result["status"] = "PERMISSION_ERROR"
                else:
                    result["status"] = f"HTTP_{res.status_code}"

                result["details"] = f"Meta Error (HTTP {res.status_code}, code {err_code}, subcode {err_subcode}): {err_msg}"

    except httpx.TimeoutException as e:
        result["status"] = "NETWORK_ERROR"
        result["details"] = f"Request timed out (12s): {str(e)}"
    except httpx.RequestError as e:
        result["status"] = "NETWORK_ERROR"
        result["details"] = f"Network connection failed: {str(e)}"
    except Exception as e:
        result["status"] = "NETWORK_ERROR"
        result["details"] = f"Unexpected error: {str(e)}"

    return result


def print_report(res: Dict[str, Any]) -> None:
    print("============================================================")
    print("TEZLIFY META WHATSAPP CLOUD API — HEALTH CHECK REPORT")
    print("============================================================")
    print(f"Token Configured      : {'YES' if res['token_present'] else 'NO'} [REDACTED]")
    print(f"Phone Number ID       : {res['phone_number_id']}")
    print(f"WABA Business Account : {res['waba_id']}")
    print(f"API Version           : {res['api_version']}")
    print(f"Graph Base URL        : {res['base_url']}")
    print(f"HTTP Status           : {res['http_status']}")
    print(f"Token / Auth Status   : {res['status']}")
    print(f"Diagnostics           : {res['details']}")
    print("============================================================")


if __name__ == "__main__":
    report = asyncio.run(verify_whatsapp_cloud_health())
    print_report(report)
    if report["status"] != "VALID":
        sys.exit(1)
    sys.exit(0)
