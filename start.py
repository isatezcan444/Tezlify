import os
import sys
import traceback
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse

port_str = os.environ.get("PORT", "10000")
try:
    port = int(port_str)
except ValueError:
    port = 10000

print(f"[TEZLIFY_BOOT] Starting initialization on port {port}...", flush=True)

try:
    # Try importing the real FastAPI app
    from backend.app.main import app
    print(f"[TEZLIFY_BOOT] Successfully loaded backend.app.main. Starting Uvicorn...", flush=True)
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
except Exception as exc:
    error_tb = traceback.format_exc()
    print(f"[TEZLIFY_CRITICAL_BOOT_FAILURE]\n{error_tb}", file=sys.stderr, flush=True)

    # Fallback diagnostic app to prevent container crash and expose error
    fallback_app = FastAPI(title="Tezlify Diagnostic Fallback")

    @fallback_app.get("/")
    @fallback_app.get("/health")
    async def fallback_health():
        return JSONResponse(
            status_code=200,
            content={
                "status": "degraded_diagnostic_mode",
                "message": "Tezlify backend hit a boot exception. See /system-log for full traceback.",
                "error": str(exc),
            },
        )

    @fallback_app.get("/system-log")
    async def fallback_log():
        return JSONResponse(
            status_code=200,
            content={
                "status": "boot_failure",
                "error": str(exc),
                "traceback": error_tb.splitlines(),
            },
        )

    print(f"[TEZLIFY_BOOT] Running diagnostic fallback server on port {port}...", flush=True)
    uvicorn.run(
        fallback_app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        proxy_headers=True,
        forwarded_allow_ips="*",
    )