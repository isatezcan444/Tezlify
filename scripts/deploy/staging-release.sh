#!/usr/bin/env bash
#
# TEZLIFY — STAGING SURUM ORKESTRASYONU (GELISTIRICI / OPERATOR TARAFI).
#
# TASARIM VE GUVENLIK ILKELERI:
# 1. BU BETIK ASLA PRODUCTION SUNUCUSUNA (130.162.247.20) DOKUNMAZ.
# 2. STAGING_HOST eksikse veya tanimlanmamissa FAIL-CLOSED olarak durur;
#    production sunucusuna asla fallback yapilamaz.
# 3. STAGING_HOST production IP'si veya production alan adlari ile eslesirse
#    islemi derhal iptal eder.
# 4. .env.staging icindeki DATABASE_URL veya servisler production'a isaret
#    ediyorsa deployment'i engeller.
# 5. Staging ortaminda WhatsApp otomatik oturum baslatma (WHATSAPP_AUTO_RESTORE)
#    varsayilan olarak kapali olmak zorundadir.
#
# KULLANIM:
#   bash scripts/deploy/staging-release.sh [sha] [secenekler]
#
# SECENEKLER:
#   --staging-host HOST   Staging SSH hedefi (orn: ubuntu@staging.tezlify.internal)
#   --staging-env PATH    Staging environment dosyasi (varsayilan: .env.staging)
#   --skip-build          Frontend build adimini atla
#   --no-frontend         Frontend dagitimini haric tut
#   --dry-run             Hicbir uzak komut calistirma; plani dogrula ve cik
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
STAGING_COMPOSE="$REPO_ROOT/docker-compose.staging.yml"

PROD_HOST_IP="130.162.247.20"
PROD_FORBIDDEN_PATTERNS=(
  "130.162.247.20"
  "api.130.162.247.20.sslip.io"
  "app.130.162.247.20.sslip.io"
  "130.162.247.20.sslip.io"
)

STAGING_HOST="${STAGING_HOST:-}"
STAGING_ENV_FILE="${STAGING_ENV_FILE:-$REPO_ROOT/.env.staging}"
SSH_KEY="${STAGING_SSH_KEY:-$HOME/.ssh/id_tezlify_staging}"

SHA=""
SKIP_BUILD=""
NO_FRONTEND=""
DRY_RUN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --staging-host)
      shift
      STAGING_HOST="${1:-}"
      shift || true
      ;;
    --staging-env)
      shift
      STAGING_ENV_FILE="${1:-}"
      shift || true
      ;;
    --skip-build)
      SKIP_BUILD="--skip-build"
      shift
      ;;
    --no-frontend)
      NO_FRONTEND="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    -*)
      echo "[staging-release] Bilinmeyen secenek: $1" >&2
      exit 2
      ;;
    *)
      SHA="$1"
      shift
      ;;
  esac
done

log() { printf '[staging-release] %s\n' "$*"; }
die() { printf '[staging-release] HATA: %s\n' "$*" >&2; exit 1; }

cd "$REPO_ROOT"

# --- 1. FAIL-CLOSED GUVENLIK KONTROLLERI -----------------------------------

# 1.1 Staging Host Kontrolu
if [ -z "$STAGING_HOST" ]; then
  die "STAGING_HOST tanimlanmamis! Production sunucusuna fallback yapilamaz. Lutfen --staging-host veya STAGING_HOST ortam degiskenini saglayin."
fi

# 1.2 Production Host ve Domain Cakisim Kontrolu
for pattern in "${PROD_FORBIDDEN_PATTERNS[@]}"; do
  if [[ "$STAGING_HOST" == *"$pattern"* ]]; then
    die "STAGING_HOST ($STAGING_HOST) production hedefi ($pattern) ile eslesiyor! Production sunucusuna staging deploy yapilamaz. Islem iptal edildi."
  fi
done

# 1.3 Staging Environment Dosyasi Kontrolu
if [ ! -f "$STAGING_ENV_FILE" ]; then
  die "Staging environment dosyasi ($STAGING_ENV_FILE) bulunamadi. Lutfen .env.staging dosyasini hazirlayin (ornek: .env.staging.example)."
fi

# 1.4 Veritabani Izolasyon Kontrolu
if grep -q "$PROD_HOST_IP" "$STAGING_ENV_FILE" 2>/dev/null; then
  die "$STAGING_ENV_FILE icindeki DATABASE_URL veya baglanti bilgisi production IP'sini ($PROD_HOST_IP) iceriyor! Canli veritabani riski nedeniyle deployment durduruldu."
fi

# 1.5 Docker Compose Staging Yapilandirmasi Kontrolu
if [ ! -f "$STAGING_COMPOSE" ]; then
  die "Staging Docker Compose dosyasi ($STAGING_COMPOSE) bulunamadi."
fi

# Compose dosyasinda proje adi ve volume'lerin staging izolasyonunu dogrula
if ! grep -q "name: tezlify-staging" "$STAGING_COMPOSE"; then
  die "docker-compose.staging.yml 'name: tezlify-staging' proje adini tasimalidir."
fi
if grep -q "whatsapp_sessions:" "$STAGING_COMPOSE" && ! grep -q "whatsapp_sessions_staging:" "$STAGING_COMPOSE"; then
  die "docker-compose.staging.yml production volume'unu (whatsapp_sessions) kullanamaz! whatsapp_sessions_staging zorunludur."
fi

# 1.6 WhatsApp Guvenlik Kontrolu (Oturum Koruma Invariant'i)
if grep -E "^WHATSAPP_AUTO_RESTORE\s*=\s*['\"]?true['\"]?" "$STAGING_ENV_FILE" >/dev/null 2>&1; then
  die "Staging ortaminda WHATSAPP_AUTO_RESTORE=true olamaz! Gercek WhatsApp oturumlarinin kazara baglanmasini onlemek icin false olmalidir."
fi

# --- 2. GIT BASTAN BASLAMA KONTROLLERI --------------------------------------
SHA="${SHA:-$(git rev-parse HEAD)}"
SHA="$(git rev-parse "$SHA^{commit}")"
SHORT="$(git rev-parse --short "$SHA")"

if [ -n "$(git status --porcelain)" ] && [ "$DRY_RUN" != "1" ] && [ "${ALLOW_DIRTY:-}" != "1" ]; then
  git status --short | head -20
  die "Yerel calisma agaci kirli: staging build edilecek artefaktin kaynagi belirsiz olur."
fi

log "Guvenlik kontrolleri basarili."
log "Hedef staging host: $STAGING_HOST"
log "Hedef commit: $SHORT $(git log -1 --format=%s "$SHA")"
log "Staging env dosyasi: $STAGING_ENV_FILE"

# --- 3. FRONTEND ARTEFAKTI (HERMETIK STAGING PAKETI) ----------------------
FRONTEND_TAR=""
if [ -z "$NO_FRONTEND" ] && [ -z "$SKIP_BUILD" ]; then
  log "Frontend staging build (Vite)"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] Vite staging build simule edildi (npm run build)"
    FRONTEND_TAR="/tmp/tezlify-frontend-staging-${SHORT}.tgz"
  else
    (cd "$FRONTEND_DIR" && npm run build >/tmp/tezlify-staging-frontend-build.log 2>&1) \
      || { tail -30 /tmp/tezlify-staging-frontend-build.log; die "Frontend staging build basarisiz."; }
    SHORT_SAFE="$(printf '%s' "$SHORT" | tr -cd 'a-zA-Z0-9._-')"
    FRONTEND_TAR="/tmp/tezlify-frontend-staging-${SHORT_SAFE}.tgz"
    tar czf "$FRONTEND_TAR" -C "$FRONTEND_DIR/dist" .
    log "Frontend staging tarball hazirlandi: $FRONTEND_TAR"
  fi
fi

# --- 4. DRY-RUN VEYA SUNUCU AKTARIMI ---------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN MODU AKTIF — Hicbir uzak komut veya transfer gerceklestirilmedi."
  log "Planlanan uzak eylemler:"
  log "  1. scp $STAGING_ENV_FILE -> $STAGING_HOST:/opt/tezlify-staging/.env.staging"
  log "  2. scp $STAGING_COMPOSE -> $STAGING_HOST:/opt/tezlify-staging/docker-compose.staging.yml"
  log "  3. scp ${FRONTEND_TAR:-<frontend-tarball>} -> $STAGING_HOST:/tmp/"
  log "  4. ssh $STAGING_HOST 'docker compose -f docker-compose.staging.yml up -d'"
  log "Staging izolasyon dogrulamasi: TAMAMLANDI (Gecerli Staging Plani)."
  exit 0
fi

# 5. GERCEK DAGITIM (Yalnizca dogrulanmis Staging Sunucusu ile)
log "Staging host anahtari ve baglantisi test ediliyor: $STAGING_HOST"
if ! ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$STAGING_HOST" "echo staging_connected" >/dev/null 2>&1; then
  die "Staging sunucusuna ($STAGING_HOST) erisilemiyor veya SSH host anahtari dogrulanamadi."
fi

log "Staging sunucusuna artefaktlar aktariliyor..."
scp -i "$SSH_KEY" -o ConnectTimeout=20 "$STAGING_ENV_FILE" "$STAGING_HOST:/opt/tezlify-staging/.env.staging"
scp -i "$SSH_KEY" -o ConnectTimeout=20 "$STAGING_COMPOSE" "$STAGING_HOST:/opt/tezlify-staging/docker-compose.staging.yml"
if [ -n "$FRONTEND_TAR" ] && [ -f "$FRONTEND_TAR" ]; then
  scp -i "$SSH_KEY" -o ConnectTimeout=20 "$FRONTEND_TAR" "$STAGING_HOST:/tmp/"
fi

log "Staging servisleri baslatiliyor..."
ssh -i "$SSH_KEY" "$STAGING_HOST" "cd /opt/tezlify-staging && docker compose -f docker-compose.staging.yml up -d"

log "Staging dagitimi tamamlandi."
