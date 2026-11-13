#!/usr/bin/env bash
# Explicit migration trigger for ONLY the isolated test PostgreSQL container (`tezlify-wa-isolated`).
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.wa-isolated-test.yml"
ACTION="${1:---upgrade}"

case "$ACTION" in
  --upgrade|--verify-only|--rollback-table-only)
    ;;
  *)
    echo "Usage: $0 [--upgrade|--verify-only|--rollback-table-only]"
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker CLI not installed on this host; run this on the isolated test Docker host."
  exit 127
fi

docker compose --project-name tezlify-wa-isolated -f "$COMPOSE_FILE" exec -T wa-isolated-backend \
  python3 -m backend.scripts.migrate_isolated_message_secrets "$ACTION"

