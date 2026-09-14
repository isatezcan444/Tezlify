#!/bin/sh
# Supervise FastAPI + Baileys as one Render Free web service. A child failure
# terminates the container so Render cannot route traffic to a half-dead app.
set -eu

BACKEND_PID=""
GATEWAY_PID=""

shutdown() {
  trap - TERM INT EXIT
  [ -z "$GATEWAY_PID" ] || kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || kill -TERM "$BACKEND_PID" 2>/dev/null || true
  [ -z "$GATEWAY_PID" ] || wait "$GATEWAY_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || wait "$BACKEND_PID" 2>/dev/null || true
}

trap 'shutdown; exit 143' TERM INT
trap shutdown EXIT

python /app/start.py &
BACKEND_PID=$!

# FastAPI owns idempotent schema migration. Start Baileys only after the
# private durable gateway schema is available.
BACKEND_READY=0
attempt=1
MAX_ATTEMPTS=180
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    wait "$BACKEND_PID" || exit $?
  fi
  if curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT:-10000}/health" >/dev/null; then
    BACKEND_READY=1
    break
  fi
  if [ $((attempt % 15)) -eq 0 ]; do
    echo "[entrypoint] Waiting for backend readiness... ($attempt/${MAX_ATTEMPTS}s)"
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$BACKEND_READY" -ne 1 ]; then
  echo "[entrypoint] Backend readiness timeout after ${MAX_ATTEMPTS}s." >&2
  exit 1
fi

if [ -n "${GATEWAY_ENCRYPTION_KEY:-}" ]; then
  echo "[entrypoint] Starting durable WhatsApp gateway."
  (cd /app/whatsapp-gateway && exec node src/index.js) &
  GATEWAY_PID=$!
else
  echo "[entrypoint] WhatsApp gateway disabled: GATEWAY_ENCRYPTION_KEY is not set."
fi

while :; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    wait "$BACKEND_PID"
    exit $?
  fi
  if [ -n "$GATEWAY_PID" ] && ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    wait "$GATEWAY_PID"
    exit $?
  fi
  sleep 2
done
