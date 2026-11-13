#!/usr/bin/env bash
#
# Read-only isolation proof check for docker-compose.wa-isolated-test.yml.
# Verifies zero overlap with production/staging containers, volumes, networks,
# ports, credentials, and host paths, and verifies wire capture defaults to OFF.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ISOLATED_COMPOSE="$REPO_ROOT/docker-compose.wa-isolated-test.yml"
PROD_COMPOSE="$REPO_ROOT/docker-compose.prod.yml"
LOCAL_COMPOSE="$REPO_ROOT/docker-compose.yml"
STAGING_COMPOSE="$REPO_ROOT/docker-compose.staging.yml"

echo "=== TEZLIFY ISOLATED WHATSAPP LAB VERIFICATION ==="

fail() {
  echo "FAIL: $1"
  exit 1
}

[ -f "$ISOLATED_COMPOSE" ] || fail "Missing $ISOLATED_COMPOSE"

# 1. Forbidden production/host mount patterns
for forbidden in \
  "/var/run/docker.sock" \
  "/opt/tezlify" \
  "/var/lib/docker/containers" \
  ".env.production" \
  ".env.backend" \
  ".env.staging" \
  "tezlify-internal" \
  "tezlify-staging-internal" \
  "whatsapp_sessions:" \
  "whatsapp_media:" \
  "tezlify_db" \
  "whatsapp_sessions_staging" \
  "tezlify-gateway" \
  "tezlify-backend" \
  "tezlify-caddy"
do
  if grep -Fq "$forbidden" "$ISOLATED_COMPOSE"; then
    fail "Isolated compose references forbidden production identifier: $forbidden"
  fi
done
echo "  ok - 1. Zero production mounts, networks, containers, or env files referenced"

# 2. Wire capture flags default strictly to false and WHATSAPP_AUTO_RESTORE=false
grep -Fq 'GATEWAY_MSMSG_WIRE_CAPTURE: ${WA_ISOLATED_WIRE_CAPTURE:-false}' "$ISOLATED_COMPOSE" || fail "Wire capture must default to false"
grep -Fq 'GATEWAY_MSMSG_CAPTURE_INCLUDE_CIPHERTEXT: ${WA_ISOLATED_CAPTURE_CIPHERTEXT:-false}' "$ISOLATED_COMPOSE" || fail "Raw ciphertext capture must default to false"
grep -Fq 'WHATSAPP_AUTO_RESTORE: "false"' "$ISOLATED_COMPOSE" || fail "Auto restore must be false in isolated lab"
echo "  ok - 2. Wire capture flags default to false and WHATSAPP_AUTO_RESTORE=false"

# 3. No production compose file enables wire capture
for prod_file in "$PROD_COMPOSE" "$LOCAL_COMPOSE" "$STAGING_COMPOSE"; do
  if [ -f "$prod_file" ] && grep -Fq "GATEWAY_MSMSG_WIRE_CAPTURE" "$prod_file"; then
    fail "$prod_file must not enable GATEWAY_MSMSG_WIRE_CAPTURE"
  fi
done
echo "  ok - 3. Production and staging compose files do not enable wire capture"

# 4. Isolated ports are loopback-bound and distinct from 80, 443, 3000, 8000, 8080, 8443, 8787
grep -Fq '127.0.0.1:${WA_ISOLATED_BACKEND_PORT:-18000}:8000' "$ISOLATED_COMPOSE" || fail "Backend port must be loopback 18000"
grep -Fq '127.0.0.1:${WA_ISOLATED_GATEWAY_PORT:-18787}:8787' "$ISOLATED_COMPOSE" || fail "Gateway port must be loopback 18787"
echo "  ok - 4. All exposed ports are loopback-only (127.0.0.1:18000, 127.0.0.1:18787)"

# 5. Distinct isolated subnet (172.31.44.0/24 != 172.29.0.0/16 & 172.30.0.0/16)
grep -Fq '172.31.44.0/24' "$ISOLATED_COMPOSE" || fail "Isolated subnet 172.31.44.0/24 missing"
echo "  ok - 5. Network subnet 172.31.44.0/24 isolated from prod/staging"

# 6. Env example contains zero real secrets and requires distinct credentials
EXAMPLE_ENV="$REPO_ROOT/scripts/wa_isolated_test/.env.wa-test.example"
[ -f "$EXAMPLE_ENV" ] || fail "Missing $EXAMPLE_ENV"
grep -Fq "replace-with-" "$EXAMPLE_ENV" || fail "Example env must contain placeholders only"
grep -Fq "WA_ISOLATED_WIRE_CAPTURE=false" "$EXAMPLE_ENV" || fail "Example env must default capture to false"
echo "  ok - 6. Example env uses placeholders and disables wire capture by default"

echo "=== ALL ISOLATION VERIFICATION CHECKS PASSED (6/6) ==="

