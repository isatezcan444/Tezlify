# PHASE 10.1 — TEZLIFY DISASTER RECOVERY & BACKUP RUNBOOK
## PRODUCTION BACKUP, RESTORE, INTEGRITY & FAILOVER PROCEDURE

**Document Status:** `BACKUP_RESTORE_VERIFIED`  
**Last Certification:** `2026-09-16T13:25 UTC`  
**Target Infrastructure:** Oracle Cloud Always Free VM (`130.162.247.20`)  
**Production Services:** `tezlify-caddy`, `tezlify-backend`, `tezlify-gateway`, `tezlify-db`  
**Database Engine:** PostgreSQL 17.11 (`postgres:17-alpine`)  
**Architecture:** `ORACLE_ONLY`  
**Off-Host Backup:** `OFF_HOST_BACKUP_NOT_CONFIGURED` (see Section 9)  

---

## 0. Phase 10.1 Finalization Certification Results

> [!IMPORTANT]
> This section records the certified isolated restore verification executed on **2026-09-16**.

### Backup Files Verified

| File | Size | SHA-256 | Status |
|---|---|---|---|
| `tezlify_20260916_131737Z.dump` | 31 MB | `eb796f281d24d7880d009fa06bde0ad03f988c2ad49fd3bcf39f5df25ab52b4a` | ✅ PRIMARY |
| `tezlify_20260916_131540Z.dump` | 31 MB | `243b30c45fa8e0051b0530a11ecf7426ab7e33bfe2a37d6721d35312885253aa` | ✅ REPEATABILITY BACKUP |

- `pg_restore --list` → exit 0, 302 TOC entries, both schemas (`public`, `whatsapp_private`) present ✅

### Isolated Restore

- **Container:** `tezlify-db-restore-test` (PostgreSQL 17-alpine, isolated internal network, dedicated temporary volume)
- **No host port binding.** No connection from `tezlify-backend` or `tezlify-gateway`.
- **Production volume (`tezlify_postgres_staging_data`) never mounted or accessed.**
- **Restore command used `|| true`: NO.** Exit code captured explicitly.
- **`RESTORE_EXIT_CODE=0`** — zero stderr warnings.

### Row Count Comparison (Production vs. Restored)

All counts captured at restore time. Production DB was **not** overwritten.

| Table | Production | Restored | Match |
|---|---|---|---|
| `public.profiles` | 3 | 3 | ✅ |
| `public.conversations` | 0 | 0 | ✅ |
| `public.campaigns` | 0 | 0 | ✅ |
| `public.contacts` | 1430 | 1430 | ✅ |
| `public.messages` | 0 | 0 | ✅ |
| `public.whatsapp_sessions` | 2 | 2 | ✅ |
| `public.auth_staging_users` | 3 | 3 | ✅ |
| `public.auth_staging_oauth_accounts` | 2 | 2 | ✅ |
| `public.auth_staging_sessions` | 10 | 10 | ✅ |
| `whatsapp_private.gateway_sessions` | 8 | 8 | ✅ |
| `whatsapp_private.signal_keys` | 0 | 0 | ✅ |
| `whatsapp_private.session_credentials` | 0 | 0 | ✅ |
| `whatsapp_private.socket_leases` | 0 | 0 | ✅ |

### Structural Integrity

| Check | Production | Restored | Match |
|---|---|---|---|
| Schemas | `public`, `whatsapp_private` | `public`, `whatsapp_private` | ✅ |
| Tables in `public` | 19 | 19 | ✅ |
| Tables in `whatsapp_private` | 7 | 7 | ✅ |
| Indexes in `public` | 120 | 120 | ✅ |
| Indexes in `whatsapp_private` | 11 | 11 | ✅ |
| UUID preservation (auth_staging_users) | Verified | Verified | ✅ |

### WhatsApp Session State Note

> [!WARNING]
> The WhatsApp session state is **dynamic** and is NOT tied to Session ID 43.
> At the time of this certification, production `whatsapp_sessions` table contains:
> - Session 4: `SCAN_QR`
> - Session 5: `RELINK_REQUIRED`
>
> WhatsApp sessions may be created, deleted, or changed in status by operators at any time.
> The backup captures **exact production state at backup time**. Do NOT assume any specific session ID is valid.
> **Never recreate or delete any WhatsApp session as part of a backup/restore test.**

### Post-Restore Cleanup

- `tezlify-db-restore-test` container: **REMOVED** ✅
- `tezlify_restore_test_vol` volume: **REMOVED** ✅
- `tezlify_restore_net` network: **REMOVED** ✅
- Production `tezlify-db` container: **UNTOUCHED, still running healthy** ✅

### Production Health After Certification

```
tezlify-backend  Up (healthy)  tezlify-backend
tezlify-caddy    Up (healthy)  caddy:2-alpine
tezlify-gateway  Up (healthy)  tezlify-gateway
tezlify-db       Up (healthy)  postgres:17-alpine
```

API: `{"status":"healthy","service":"Tezlify Backend API","version":"1.0.0"}`

### Off-Host Backup

> [!IMPORTANT]
> **Status: `OFF_HOST_BACKUP_NOT_CONFIGURED`**  
> Backups are stored locally on the Oracle VM at `/opt/tezlify/backups/`.  
> If the VM's block storage is lost, local backups will be inaccessible.  
> See Section 9 for the recommended OCI Object Storage configuration.

### Regression Verification

| Suite | Result |
|---|---|
| `pytest backend/tests/ -q` | **667 passed, 0 failed** ✅ |
| `cd frontend && npm run build` | **0 errors** ✅ |

---

## 1. Safety Warnings & Principles

> [!CAUTION]
> **CRITICAL DISASTER RECOVERY RULES:**
> 1. **NEVER execute `pg_restore` directly against production database `tezlify` without prior validation.**
> 2. Always restore into an isolated staging/temporary database or container first to verify archive integrity.
> 3. Never store or commit raw credentials (`DB_PASSWORD`, `GATEWAY_ENCRYPTION_KEY`, OAuth tokens) into version control or backup logs.
> 4. Ensure backup directory permissions remain restricted (`chmod 700` for directories, `chmod 600` for dump files).
> 5. Keep at least 3 historical backup generations before executing any destructive operations.

---

## 2. Production Critical State Inventory

| Component | Storage Location / Mount | Backup Format | Encryption Level | Recovery Target |
|---|---|---|---|---|
| **PostgreSQL Database** | `tezlify_postgres_staging_data` (`tezlify-db`) | Custom Archive (`.dump`, `pg_dump -Fc`) | OS Restricted (600) | `pg_restore` |
| **WhatsApp Credentials & Keys** | PostgreSQL `whatsapp_private` schema | Included in DB Dump | AES-256 (`GATEWAY_ENCRYPTION_KEY`) | DB Restore |
| **WhatsApp Media Files** | Docker Volume `tezlify_whatsapp_media` | Gzipped Tarball (`.tar.gz`) | OS Restricted (600) | Volume Restore |
| **Caddy & Proxy Config** | `/opt/tezlify/Caddyfile` | Tarball (`.tar.gz`) | Standard | File Restore |
| **Docker Compose Services** | `/opt/tezlify/docker-compose.prod.yml` | Tarball (`.tar.gz`) | Standard | File Restore |
| **Frontend Static Releases** | `/opt/tezlify/frontend_releases/` | Filesystem Releases | Standard | Symlink Update |

---

## 3. Database Backup Procedure

### 3.1 Standard Backup Command
Execute via SSH on the Oracle VM:
```bash
set -e
TIMESTAMP=$(date -u +%Y%m%d_%H%M%SZ)
BACKUP_DIR="/opt/tezlify/backups/postgres"
DUMP_FILE="${BACKUP_DIR}/tezlify_${TIMESTAMP}.dump"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Stream custom format dump directly from production database container
docker exec tezlify-db pg_dump -U tezlify -d tezlify -Fc > "$DUMP_FILE"
chmod 600 "$DUMP_FILE"

# Generate checksum
sha256sum "$DUMP_FILE" > "${DUMP_FILE}.sha256"
```

### 3.2 Checksum Verification
```bash
sha256sum -c "${DUMP_FILE}.sha256"
```

### 3.3 Archive Structural Inspection (TOC)
To inspect archive validity without restoring:
```bash
cat "$DUMP_FILE" | docker exec -i tezlify-db pg_restore --list
```
Verify that TOC includes critical tables: `profiles`, `conversations`, `contacts`, `messages`, `auth_staging_users`, `whatsapp_sessions`, and `whatsapp_private.gateway_sessions`.

---

## 4. Isolated Restore Verification Procedure

To test any backup without risking production state, launch an isolated throwaway PostgreSQL container.

> [!CAUTION]
> **Never use `|| true` to suppress restore errors.** The exit code of `pg_restore` must be captured explicitly. A non-zero exit code means the restore failed — do not certify it.

### 4.1 Launch Isolated Test Container

```bash
RESTORE_CONTAINER="tezlify-db-restore-test"
RESTORE_VOLUME="tezlify_restore_test_vol"
RESTORE_NETWORK="tezlify_restore_net"
RESTORE_PW="$(openssl rand -hex 24)"

# Isolated internal network — no external internet access
docker network create --internal "$RESTORE_NETWORK"
docker volume create "$RESTORE_VOLUME"

docker run -d \
  --name "$RESTORE_CONTAINER" \
  --network "$RESTORE_NETWORK" \
  -v "${RESTORE_VOLUME}:/var/lib/postgresql/data" \
  -e POSTGRES_USER=restore_user \
  -e POSTGRES_DB=tezlify \
  -e POSTGRES_PASSWORD="$RESTORE_PW" \
  postgres:17-alpine

# Wait for readiness
for i in $(seq 1 30); do
  docker exec "$RESTORE_CONTAINER" pg_isready -U restore_user -d tezlify -q && break
  sleep 1
done
```

### 4.2 Execute Restore — Strict Exit Code

```bash
BACKUP="/opt/tezlify/backups/postgres/tezlify_<TIMESTAMP>.dump"
STDERR_FILE="$(mktemp)"

cat "$BACKUP" | docker exec -i "$RESTORE_CONTAINER" \
  pg_restore \
  --no-owner \
  --no-privileges \
  --username restore_user \
  --dbname tezlify \
  2>"$STDERR_FILE"

RESTORE_EXIT_CODE=$?
echo "RESTORE_EXIT_CODE=$RESTORE_EXIT_CODE"
cat "$STDERR_FILE"  # Audit stderr before proceeding

if [ "$RESTORE_EXIT_CODE" -ne 0 ]; then
  echo "FATAL: pg_restore failed. Do NOT certify."
  exit 1
fi
```

### 4.3 Verify Restored Integrity

Compare row counts against production (both schemas):

```bash
docker exec "$RESTORE_CONTAINER" psql -U restore_user -d tezlify -t -A -c "
  SELECT
    (SELECT COUNT(*) FROM public.profiles) AS profiles,
    (SELECT COUNT(*) FROM public.contacts) AS contacts,
    (SELECT COUNT(*) FROM public.messages) AS messages,
    (SELECT COUNT(*) FROM public.whatsapp_sessions) AS wa_sessions,
    (SELECT COUNT(*) FROM public.auth_staging_users) AS auth_users,
    (SELECT COUNT(*) FROM public.auth_staging_oauth_accounts) AS oauth_accounts,
    (SELECT COUNT(*) FROM public.auth_staging_sessions) AS auth_sessions,
    (SELECT COUNT(*) FROM whatsapp_private.gateway_sessions) AS gw_sessions,
    (SELECT COUNT(*) FROM whatsapp_private.signal_keys) AS signal_keys,
    (SELECT COUNT(*) FROM whatsapp_private.socket_leases) AS socket_leases;
"
```

### 4.4 Tear Down Isolated Container, Volume and Network

```bash
docker rm -f "$RESTORE_CONTAINER"
docker volume rm "$RESTORE_VOLUME"
docker network rm "$RESTORE_NETWORK"

# Verify completely gone
docker ps -a --filter name=tezlify-db-restore-test
```

---

## 5. Media & Configuration Backup Procedure

### 5.1 WhatsApp Media Backup
```bash
TIMESTAMP=$(date -u +%Y%m%d_%H%M%SZ)
MEDIA_DIR="/opt/tezlify/backups/media"
mkdir -p "$MEDIA_DIR" && chmod 700 "$MEDIA_DIR"

docker run --rm \
  -v tezlify_whatsapp_media:/media_data:ro \
  -v "$MEDIA_DIR":/backup_dest \
  alpine tar czf "/backup_dest/media_${TIMESTAMP}.tar.gz" -C /media_data .

sudo chown ubuntu:ubuntu "${MEDIA_DIR}/media_${TIMESTAMP}.tar.gz"
chmod 600 "${MEDIA_DIR}/media_${TIMESTAMP}.tar.gz"
sha256sum "${MEDIA_DIR}/media_${TIMESTAMP}.tar.gz" > "${MEDIA_DIR}/media_${TIMESTAMP}.tar.gz.sha256"
```

### 5.2 Media Restore Command
To restore media into a new or recovered volume:
```bash
docker run --rm \
  -v tezlify_whatsapp_media:/media_data \
  -v /opt/tezlify/backups/media:/backup_src:ro \
  alpine tar xzf "/backup_src/media_<TIMESTAMP>.tar.gz" -C /media_data
```

### 5.3 Configuration Backup
```bash
TIMESTAMP=$(date -u +%Y%m%d_%H%M%SZ)
CONFIG_DIR="/opt/tezlify/backups/config"
mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"

STAGE_DIR=$(mktemp -d)
cp /opt/tezlify/Caddyfile "$STAGE_DIR/"
cp /opt/tezlify/docker-compose.prod.yml "$STAGE_DIR/"
cp /opt/tezlify/docker-compose.yml "$STAGE_DIR/"
echo "CURRENT_FRONTEND_RELEASE=$(readlink -f /opt/tezlify/frontend_current)" > "$STAGE_DIR/release_info.txt"
grep -E "^[A-Za-z0-9_]+" /opt/tezlify/.env.production | cut -d= -f1 > "$STAGE_DIR/env_vars.manifest"

tar czf "${CONFIG_DIR}/config_${TIMESTAMP}.tar.gz" -C "$STAGE_DIR" .
chmod 600 "${CONFIG_DIR}/config_${TIMESTAMP}.tar.gz"
rm -rf "$STAGE_DIR"
```

---

## 6. WhatsApp Credential & Signal Key Recovery

All WhatsApp session keys, Baileys signal pre-keys, and session state are persisted inside the PostgreSQL database under schema `whatsapp_private`.
- Credentials are automatically restored when restoring the PostgreSQL dump.
- **Key Requirement:** The environment variable `GATEWAY_ENCRYPTION_KEY` in `tezlify-gateway` must match the key used when the session was created to decrypt `session_credentials` and `signal_keys`.
- When restoring onto a new machine or recreated container, ensure `GATEWAY_ENCRYPTION_KEY` in `.env.production` is preserved.

---

## 7. Full VM Disaster Recovery Sequence (Bare Metal / New Oracle VM)

In the event of total VM loss, execute this sequential recovery:

### Step 1: Provision & Base Setup
1. Provision an Ubuntu 24.04 LTS instance on Oracle Cloud.
2. Install Docker Engine, Docker Compose, and Git:
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git curl
   sudo usermod -aG docker ubuntu
   ```
3. Open firewall ports in OCI Security List & UFW:
   - Port 80 (HTTP)
   - Port 443 (HTTPS)
   - Port 22 (SSH)

### Step 2: Clone Codebase
```bash
cd /opt
sudo git clone https://github.com/isatezcan444/Tezlify.git tezlify
sudo chown -R ubuntu:ubuntu /opt/tezlify
cd /opt/tezlify
```

### Step 3: Restore Configuration & Environment
1. Restore `.env.production` from secure off-host storage.
2. Verify critical secrets are populated:
   - `DB_PASSWORD=<SECURE_PASSWORD>`
   - `SECRET_KEY=<SECURE_BACKEND_KEY>`
   - `GATEWAY_ENCRYPTION_KEY=<ORIGINAL_AES_KEY>`
   - `WHATSAPP_GATEWAY_SECRET=<SHARED_WS_SECRET>`
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   - `FRONTEND_ORIGIN="https://api.130.162.247.20.sslip.io"`

### Step 4: Start PostgreSQL Service
```bash
docker compose -f docker-compose.yml up -d db
# Wait until healthy:
docker exec tezlify-db pg_isready -U tezlify -d tezlify
```

### Step 5: Restore PostgreSQL Dump
```bash
cat tezlify_<TIMESTAMP>.dump | docker exec -i tezlify-db pg_restore -U tezlify -d tezlify --clean --if-exists --no-owner --role=tezlify
```

### Step 6: Restore Media Files
```bash
docker run --rm \
  -v tezlify_whatsapp_media:/media_data \
  -v /opt/tezlify/backups/media:/backup_src:ro \
  alpine tar xzf "/backup_src/media_<TIMESTAMP>.tar.gz" -C /media_data
```

### Step 7: Build & Launch Complete Stack
```bash
# Build frontend
cd /opt/tezlify/frontend && npm ci && npm run build
mkdir -p /opt/tezlify/frontend_releases/v$(date +%Y%m%d_%H%M%S)
cp -r dist/* /opt/tezlify/frontend_releases/v$(date +%Y%m%d_%H%M%S)/
ln -sfn /opt/tezlify/frontend_releases/v$(date +%Y%m%d_%H%M%S) /opt/tezlify/frontend_candidate
ln -sfn /opt/tezlify/frontend_releases/v$(date +%Y%m%d_%H%M%S) /opt/tezlify/frontend_current

# Start production containers
cd /opt/tezlify
docker compose -f docker-compose.prod.yml up -d --build
```

### Step 8: Post-Recovery Validation
1. Verify API health: `curl -s https://<DOMAIN>/health`
2. Verify gateway health: `docker exec tezlify-backend curl -s http://gateway:8787/health`
3. Verify WebSocket: Connect to `wss://<DOMAIN>/ws`
4. Verify database: Verify row counts in `profiles`, `contacts`, `whatsapp_sessions`.

---

## 8. Backup Retention & Rotation Policy

| Frequency | Snapshots Kept | Rotation Schedule | Estimated Disk Usage |
|---|---|---|---|
| **Daily** | 7 | Kept for 7 days | ~217 MB |
| **Weekly** | 4 | Kept for 4 weeks (taken every Sunday 03:00 UTC) | ~124 MB |
| **Monthly** | 3 | Kept for 3 months (taken 1st of month 03:00 UTC) | ~93 MB |
| **Total** | 14 | Automatic cleanup of older files | **~434 MB** |

*Disk capacity on `/dev/sda1` is 96 GB (87 GB available), meaning backups consume < 0.5% of total disk space.*

---

## 9. Off-Host Storage Replication (Recommended Next Step)

> [!IMPORTANT]
> **Status:** `OFF_HOST_BACKUP_NOT_CONFIGURED`  
> Local backups are stored on the same VM host (`/dev/sda1`). In the event of catastrophic block storage loss or VM termination, off-host backups are required.

To configure automated off-host sync to Oracle Cloud (OCI) Object Storage:
1. Create a Standard Object Storage bucket in Frankfurt region: `tezlify-backups`.
2. Configure OCI CLI on the instance using Instance Principal authentication:
   ```bash
   oci os object bulk-upload \
     --bucket-name tezlify-backups \
     --src-dir /opt/tezlify/backups/ \
     --overwrite
   ```
3. Set a cron job at `04:00 UTC` daily to sync `/opt/tezlify/backups/` to the OCI bucket.
