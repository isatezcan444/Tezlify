#!/usr/bin/env bash
#
# Single-command runtime preflight for the isolated WhatsApp protocol lab (`tezlify-wa-isolated`).
# - NEVER starts, stops, or modifies any containers or volumes.
# - Fails closed if any production/staging overlap is detected.
# - Reports clearly whether Docker CLI / Compose config ran live or only static validation ran.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.wa-isolated-test.yml"
EXAMPLE_ENV="$REPO_ROOT/scripts/wa_isolated_test/.env.wa-test.example"
ACTIVE_ENV="$REPO_ROOT/scripts/wa_isolated_test/.env.wa-test"
REQUIRE_DOCKER=false

if [ "${1:-}" = "--require-docker" ]; then
  REQUIRE_DOCKER=true
fi

echo "=== TEZLIFY ISOLATED WHATSAPP RUNTIME PREFLIGHT ==="

# 1. Isolation verification (volumes, networks, ports, compose identifiers)
bash "$REPO_ROOT/scripts/wa_isolated_test/verify-isolation.sh"

# 2. Static YAML & Dockerfile/build-context audit
PYTHON_BIN="python3"
if [ -x "$REPO_ROOT/venv/bin/python3" ]; then
  PYTHON_BIN="$REPO_ROOT/venv/bin/python3"
fi

"$PYTHON_BIN" - "$REPO_ROOT" <<'PYEOF'
import pathlib, sys, yaml

root = pathlib.Path(sys.argv[1])
compose_path = root / "docker-compose.wa-isolated-test.yml"
prod_path = root / "docker-compose.prod.yml"
staging_path = root / "docker-compose.staging.yml"
gw_dockerfile = (root / "whatsapp-gateway" / "Dockerfile").read_text(encoding="utf-8")
be_dockerfile = (root / "backend" / "Dockerfile").read_text(encoding="utf-8")

cfg = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
assert cfg.get("name") == "tezlify-wa-isolated", f"unexpected project name: {cfg.get('name')}"
services = cfg.get("services") or {}
assert set(services.keys()) == {"wa-isolated-db", "wa-isolated-backend", "wa-isolated-gateway"}

# Dockerfile & non-root checks
assert "USER gateway" in gw_dockerfile, "gateway Dockerfile must run as non-root USER gateway"
assert (root / "start.py").exists(), "start.py missing for backend Dockerfile"
assert "CMD [\"python3\", \"start.py\"]" in be_dockerfile, "backend Dockerfile CMD mismatch"

be_env = services["wa-isolated-backend"].get("environment") or {}
gw_env = services["wa-isolated-gateway"].get("environment") or {}

assert be_env.get("ENVIRONMENT") == "test", "backend ENVIRONMENT must be 'test'"
assert str(be_env.get("ALLOW_ISOLATED_MESSAGE_SECRETS_MIGRATION")).lower() == "true"
assert str(be_env.get("WHATSAPP_AUTO_RESTORE")).lower() == "false"
assert be_env.get("WHATSAPP_GATEWAY_URL") == "http://wa-isolated-gateway:8787"
assert "@wa-isolated-db:5432/" in str(be_env.get("DATABASE_URL"))

assert gw_env.get("NODE_ENV") == "development"
assert str(gw_env.get("WHATSAPP_AUTO_RESTORE")).lower() == "false"
assert gw_env.get("GATEWAY_WIRE_CAPTURE_DIR") == "/tmp/tezlify-wa-capture", "must use non-root writable /tmp capture dir"
assert "@wa-isolated-db:5432/" in str(gw_env.get("GATEWAY_DATABASE_URL"))

# Ensure production & staging do not set isolated migration flag
for p in (prod_path, staging_path):
    if p.exists():
        txt = p.read_text(encoding="utf-8")
        assert "ALLOW_ISOLATED_MESSAGE_SECRETS_MIGRATION" not in txt, f"{p.name} must not enable isolated secrets migration"

print("  ok - static YAML, build context, non-root gateway user, DB URL, auto-restore=false & env isolation")
PYEOF

# 3. Credential file check (only validates active .env.wa-test if already created by operator)
if [ -f "$ACTIVE_ENV" ]; then
  if grep -q "replace-with-" "$ACTIVE_ENV"; then
    echo "FAIL: Active $ACTIVE_ENV still contains placeholder values."
    exit 1
  fi
  if [ -f "$REPO_ROOT/.env.production" ]; then
    prod_key="$(grep -E '^GATEWAY_ENCRYPTION_KEY=' "$REPO_ROOT/.env.production" | cut -d= -f2- || true)"
    test_key="$(grep -E '^GATEWAY_ENCRYPTION_KEY=' "$ACTIVE_ENV" | cut -d= -f2- || true)"
    if [ -n "$prod_key" ] && [ "$prod_key" = "$test_key" ]; then
      echo "FAIL: Active $ACTIVE_ENV reuses production GATEWAY_ENCRYPTION_KEY."
      exit 1
    fi
  fi
  echo "  ok - active .env.wa-test checked for non-placeholder, non-production secrets"
else
  echo "  info - .env.wa-test not created yet (validated .env.wa-test.example for compose preflight)"
fi

# 4. Docker CLI & Compose config validation (read-only; NEVER starts containers)
ENV_FOR_COMPOSE="$ACTIVE_ENV"
if [ ! -f "$ENV_FOR_COMPOSE" ]; then
  ENV_FOR_COMPOSE="$EXAMPLE_ENV"
fi

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    docker compose --project-name tezlify-wa-isolated --env-file "$ENV_FOR_COMPOSE" -f "$COMPOSE_FILE" config --quiet
    echo "  ok - docker compose config validated cleanly (containers NOT started)"
  else
    echo "WARN: docker found but 'docker compose' plugin is unavailable"
    [ "$REQUIRE_DOCKER" = "true" ] && exit 127
  fi
else
  echo "  info - docker CLI unavailable on this host (exit 127 skipped unless --require-docker)"
  [ "$REQUIRE_DOCKER" = "true" ] && exit 127
fi

echo "=== ISOLATED RUNTIME PREFLIGHT COMPLETE ==="

