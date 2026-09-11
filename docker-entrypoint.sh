#!/bin/sh
# Tezlify container entrypoint.
# Starts the WhatsApp gateway (Baileys) as a sidecar when configured, then
# execs the FastAPI backend as PID-of-record. If the gateway is not
# configured (no GATEWAY_ENCRYPTION_KEY), the backend still starts and all
# WhatsApp operations fail closed with a clear error — never a false success.
set -e

if [ -n "$GATEWAY_ENCRYPTION_KEY" ]; then
  echo "[entrypoint] Starting WhatsApp gateway on ${GATEWAY_HOST:-127.0.0.1}:${GATEWAY_PORT:-8787}"
  (cd /app/whatsapp-gateway && node src/index.js) &
  GATEWAY_PID=$!
  # Keep the backend alive even if the gateway process dies; the gateway's
  # own crash is surfaced via backend health checks failing closed.
  echo "[entrypoint] Gateway PID: $GATEWAY_PID"
else
  echo "[entrypoint] GATEWAY_ENCRYPTION_KEY not set - WhatsApp gateway disabled (fail-closed)."
fi

exec python /app/start.py
