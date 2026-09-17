import os
import sys
import uvicorn

port_str = os.environ.get("PORT", "10000")
try:
    port = int(port_str)
except ValueError:
    port = 10000

print(f"[TEZLIFY_BOOT] Starting initialization on port {port}...", flush=True)

try:
    from backend.app.main import app
    from backend.app.core.logging_security import setup_security_logging
    setup_security_logging()
    print(f"[TEZLIFY_BOOT] Successfully loaded backend.app.main. Starting Uvicorn...", flush=True)
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        proxy_headers=True,
        forwarded_allow_ips="*",
        ws_ping_interval=None,
        ws_ping_timeout=None,
    )
except Exception as exc:
    print(f"[TEZLIFY_CRITICAL_BOOT_FAILURE] {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    raise
