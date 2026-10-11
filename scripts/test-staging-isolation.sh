#!/usr/bin/env bash
#
# TEZLIFY — STAGING ISOLATION & FAIL-CLOSED AUTOMATED TEST SUITE
# Verifies all 10 staging isolation criteria in an isolated, hermetic manner.
# NEVER touches production host 130.162.247.20.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d /tmp/tezlify-staging-test-XXXXXX)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

cd "$REPO_ROOT"

PASSED=0
FAILED=0

assert_fails() {
  local desc="$1"
  local expected_err="$2"
  shift 2
  local output
  local exit_code=0
  output="$("$@" 2>&1)" || exit_code=$?

  if [ "$exit_code" -ne 0 ] && echo "$output" | grep -q "$expected_err"; then
    echo "  ok - $desc"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL - $desc"
    echo "    Expected error: '$expected_err'"
    echo "    Actual exit code: $exit_code"
    echo "    Output: $output"
    FAILED=$((FAILED + 1))
  fi
}

assert_passes() {
  local desc="$1"
  local expected_msg="$2"
  shift 2
  local output
  local exit_code=0
  output="$("$@" 2>&1)" || exit_code=$?

  if [ "$exit_code" -eq 0 ] && echo "$output" | grep -q "$expected_msg"; then
    echo "  ok - $desc"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL - $desc"
    echo "    Expected success message: '$expected_msg'"
    echo "    Actual exit code: $exit_code"
    echo "    Output: $output"
    FAILED=$((FAILED + 1))
  fi
}

echo "=== TEZLIFY STAGING ISOLATION TEST SUITE ==="

# Create a temporary valid staging env
cat << 'EOF' > "$TEMP_DIR/.env.staging.valid"
ENVIRONMENT=staging
DATABASE_URL=postgresql+asyncpg://tezlify_staging:pass@staging-db:5432/tezlify_staging
WHATSAPP_AUTO_RESTORE=false
JWT_SECRET=staging_jwt_secret_valid_min_32_chars
WHATSAPP_GATEWAY_SECRET=staging_gateway_secret_valid_32
EOF

# 1. --target staging and STAGING_HOST missing -> FAIL-CLOSED
assert_fails \
  "1. Missing STAGING_HOST is blocked fail-closed" \
  "STAGING_HOST tanimlanmamis" \
  bash scripts/deploy/release.sh --target staging --dry-run

# 2. STAGING_HOST is identical to production IP -> BLOCKED
assert_fails \
  "2. STAGING_HOST matching production IP 130.162.247.20 is blocked" \
  "production hedefi" \
  bash scripts/deploy/staging-release.sh --staging-host ubuntu@130.162.247.20 --staging-env "$TEMP_DIR/.env.staging.valid" --dry-run

# 2b. STAGING_HOST matching production domain -> BLOCKED
assert_fails \
  "2b. STAGING_HOST matching production sslip.io domain is blocked" \
  "production hedefi" \
  bash scripts/deploy/staging-release.sh --staging-host ubuntu@api.130.162.247.20.sslip.io --staging-env "$TEMP_DIR/.env.staging.valid" --dry-run

# 3. Missing staging env file -> BLOCKED
assert_fails \
  "3. Missing staging environment file is blocked" \
  "bulunamadi" \
  bash scripts/deploy/staging-release.sh --staging-host ubuntu@10.0.0.99 --staging-env "$TEMP_DIR/nonexistent.env" --dry-run

# 4. Production database IP present in staging env -> BLOCKED
cat << 'EOF' > "$TEMP_DIR/.env.staging.prod_db"
ENVIRONMENT=staging
DATABASE_URL=postgresql+asyncpg://tezlify:pass@130.162.247.20:5432/tezlify
WHATSAPP_AUTO_RESTORE=false
EOF
assert_fails \
  "4. Staging configuration pointing to production database IP is blocked" \
  "production IP'sini" \
  bash scripts/deploy/staging-release.sh --staging-host ubuntu@10.0.0.99 --staging-env "$TEMP_DIR/.env.staging.prod_db" --dry-run

# 5. WHATSAPP_AUTO_RESTORE=true in staging env -> BLOCKED
cat << 'EOF' > "$TEMP_DIR/.env.staging.whatsapp_unsafe"
ENVIRONMENT=staging
DATABASE_URL=postgresql+asyncpg://tezlify_staging:pass@staging-db:5432/tezlify_staging
WHATSAPP_AUTO_RESTORE=true
EOF
assert_fails \
  "5. WHATSAPP_AUTO_RESTORE=true in staging is blocked to protect WhatsApp lines" \
  "WHATSAPP_AUTO_RESTORE=true olamaz" \
  bash scripts/deploy/staging-release.sh --staging-host ubuntu@10.0.0.99 --staging-env "$TEMP_DIR/.env.staging.whatsapp_unsafe" --dry-run

# 6. Compose project name verification
assert_passes \
  "6. docker-compose.staging.yml specifies isolated project name 'name: tezlify-staging'" \
  "name: tezlify-staging" \
  grep "name: tezlify-staging" docker-compose.staging.yml

# 7. Compose volume isolation verification
assert_passes \
  "7. docker-compose.staging.yml uses isolated whatsapp_sessions_staging volume" \
  "whatsapp_sessions_staging" \
  grep "whatsapp_sessions_staging:" docker-compose.staging.yml

# 8. Unreachable/unverified SSH host without dry-run -> BLOCKED
assert_fails \
  "8. Unverified SSH host key or unreachable staging host is blocked" \
  "erisilemiyor" \
  env ALLOW_DIRTY=1 bash scripts/deploy/staging-release.sh --staging-host "ubuntu@192.0.2.1" --staging-env "$TEMP_DIR/.env.staging.valid" --skip-build

# 9. Valid isolated staging target with --dry-run -> PASSES cleanly
assert_passes \
  "9. Valid isolated staging target produces dry-run plan cleanly without executing remote commands" \
  "Staging izolasyon dogrulamasi: TAMAMLANDI" \
  bash scripts/deploy/staging-release.sh --staging-host ubuntu@10.0.0.99 --staging-env "$TEMP_DIR/.env.staging.valid" --dry-run

# 11. Argument order preservation: --dry-run BEFORE --target staging
assert_passes \
  "11. release.sh preserves --dry-run when placed before --target staging" \
  "Staging izolasyon dogrulamasi: TAMAMLANDI" \
  bash scripts/deploy/release.sh --dry-run --target staging --staging-host ubuntu@10.0.0.99 --staging-env "$TEMP_DIR/.env.staging.valid"

# 12. ops_service.py environment isolation verification (Python)
assert_passes \
  "12. ops_service.py resolves tezlify-staging and container names in staging mode" \
  "STAGING_OPS_ISOLATED_OK" \
  python3 -c "
import os
os.environ['ENVIRONMENT'] = 'staging'
from backend.app.services.admin.ops_service import COMPOSE_PROJECT, COMPOSE_FILE, _container_name
assert COMPOSE_PROJECT == 'tezlify-staging', f'Unexpected project: {COMPOSE_PROJECT}'
assert 'docker-compose.staging.yml' in COMPOSE_FILE, f'Unexpected compose file: {COMPOSE_FILE}'
assert _container_name('backend') == 'tezlify-backend-staging', f'Unexpected name: {_container_name(\"backend\")}'
assert _container_name('caddy') == 'tezlify-caddy-staging', f'Unexpected name: {_container_name(\"caddy\")}'
print('STAGING_OPS_ISOLATED_OK')
"

# 13. ops_service.py production isolation verification (Python)
assert_passes \
  "13. ops_service.py resolves standard production project and container names in prod mode" \
  "PROD_OPS_ISOLATED_OK" \
  python3 -c "
import os
os.environ.pop('ENVIRONMENT', None)
os.environ.pop('TEZLIFY_COMPOSE_PROJECT', None)
os.environ.pop('TEZLIFY_CONTAINER_SUFFIX', None)
# Reimport or reload
import importlib
from backend.app.services.admin import ops_service
importlib.reload(ops_service)
assert ops_service.COMPOSE_PROJECT == 'tezlify', f'Unexpected project: {ops_service.COMPOSE_PROJECT}'
assert 'docker-compose.prod.yml' in ops_service.COMPOSE_FILE, f'Unexpected compose file: {ops_service.COMPOSE_FILE}'
assert ops_service._container_name('backend') == 'tezlify-backend', f'Unexpected name: {ops_service._container_name(\"backend\")}'
assert ops_service._container_name('caddy') == 'tezlify-caddy', f'Unexpected name: {ops_service._container_name(\"caddy\")}'
print('PROD_OPS_ISOLATED_OK')
"

echo ""
echo "Summary: $PASSED passed, $FAILED failed"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit 0
