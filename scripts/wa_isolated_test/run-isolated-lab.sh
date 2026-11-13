#!/usr/bin/env bash
#
# Safe isolated lab launcher for non-production WhatsApp msmsg verification.
# - Operates ONLY on compose project `tezlify-wa-isolated` (`docker-compose.wa-isolated-test.yml`).
# - NEVER pairs/triggers QR automatically; operator pairs a separate test account manually.
# - NEVER touches production containers, volumes, networks, or .env.production.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.wa-isolated-test.yml"
ENV_FILE="$REPO_ROOT/scripts/wa_isolated_test/.env.wa-test"

cmd="${1:-help}"

require_isolated_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: Missing $ENV_FILE"
    echo "Copy scripts/wa_isolated_test/.env.wa-test.example to .env.wa-test with fresh test secrets first."
    exit 1
  fi
  if grep -q "replace-with-" "$ENV_FILE"; then
    echo "ERROR: Replace placeholder secrets in $ENV_FILE with fresh random values before starting."
    exit 1
  fi
  if [ -f "$REPO_ROOT/.env.production" ]; then
    local prod_key test_key
    prod_key="$(grep -E '^GATEWAY_ENCRYPTION_KEY=' "$REPO_ROOT/.env.production" | cut -d= -f2- || true)"
    test_key="$(grep -E '^GATEWAY_ENCRYPTION_KEY=' "$ENV_FILE" | cut -d= -f2- || true)"
    if [ -n "$prod_key" ] && [ "$prod_key" = "$test_key" ]; then
      echo "REFUSING TO START: Test GATEWAY_ENCRYPTION_KEY matches .env.production!"
      exit 1
    fi
  fi
}

case "$cmd" in
  up)
    require_isolated_env
    docker compose --project-name tezlify-wa-isolated --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build
    ;;
  up-capture)
    require_isolated_env
    echo "Enabling opt-in redacted msmsg wire capture for isolated test session ONLY (TTL=30m)."
    WA_ISOLATED_WIRE_CAPTURE=true WA_ISOLATED_CAPTURE_CIPHERTEXT=false \
      docker compose --project-name tezlify-wa-isolated --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build
    ;;
  purge-capture)
    docker compose --project-name tezlify-wa-isolated -f "$COMPOSE_FILE" exec -T wa-isolated-gateway \
      sh -c 'rm -f /tmp/tezlify-wa-capture/msmsg-*.json'
    echo "Purged temporary wire capture files from isolated container."
    ;;
  status)
    docker compose --project-name tezlify-wa-isolated -f "$COMPOSE_FILE" ps
    ;;
  down)
    docker compose --project-name tezlify-wa-isolated -f "$COMPOSE_FILE" down
    ;;
  down-wipe-test)
    docker compose --project-name tezlify-wa-isolated -f "$COMPOSE_FILE" down -v
    ;;
  verify-isolation)
    bash "$REPO_ROOT/scripts/wa_isolated_test/verify-isolation.sh"
    ;;
  *)
    cat <<EOF
Usage: $0 <command>
Commands:
  verify-isolation   Run read-only isolation verification (no Docker mutation)
  up                 Start isolated test stack (wire capture OFF by default)
  up-capture         Start isolated test stack with opt-in msmsg metadata capture ON
  purge-capture      Delete temporary msmsg capture files from isolated volume
  status             Show isolated stack container status
  down               Stop isolated test stack (keep test volumes)
  down-wipe-test     Stop isolated stack and wipe ONLY isolated test volumes
EOF
    ;;
esac

