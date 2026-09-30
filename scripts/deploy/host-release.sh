#!/usr/bin/env bash
#
# KESINTISIZ SURUM AKISI — SUNUCU TARAFI.
#
# NEDEN VAR
# ---------
# Eski akis `docker compose up -d` cagiriyordu: bu komut YENI container saglikli
# mi diye BAKMADAN eskisini durdurur. Yeni imaj boot ederken hata verirse
# (eksik tablo, import hatasi, DB uyumsuzlugu) canli trafik olu container'a
# gider ve geri donus yolu YOKTUR — kesinti kullanicinin haberini aldigi an
# baslar.
#
# BU SCRIPT'IN SIRASI
# -------------------
#   1. checkout'u hedef SHA'ya NORMALIZE eder (kirli agac icin --force-reset
#      SART; dosyalar once `backups/releases/<ts>/` altina yazilir)
#   2. imajlari ONCE build eder — eski container bu sure boyunca calismaya
#      devam eder (build en uzun ve en kirilgan adimdir)
#   3. yeni imaji ADACIK (candidate) bir container'da kaldirir: gateway KAPALI
#      (GATEWAY_ENCRYPTION_KEY bos) ve PORT=8001, yani WhatsApp oturumuna
#      DOKUNMAZ; /health 200 donene kadar bekler
#   4. ANCAK 3 basariliysa trafigi cevirir (`compose up -d backend gateway`)
#   5. yeni container'i ve YAYINDaki dosya hash'lerini dogrular; biri sasarsa
#      OTOMATIK geri alir (onceki imaj etiketleri + onceki frontend dizini)
#
# KULLANIM (sunucuda, /opt/tezlify icinde):
#   bash scripts/deploy/host-release.sh <sha> [secenekler]
#
#   --frontend-tar PATH   frontend/dist tarball'i (icerigi frontend_candidate'e
#                         yazilir; onceki dizin kopyasi saklanir)
#   --skip-build          imajlari yeniden build etme (yalniz frontend/verify)
#   --force-reset         kirli calisma agacini SIFIRLA (diff once yedeklenir)
#   --health-timeout N    adacik/gercek container saglik bekleme suresi (sn)
#   --dry-run             hicbir seyi degistirme; planı yaz ve cik
#
set -Eeuo pipefail

PROJECT_DIR="/opt/tezlify"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
FRONTEND_DIR="$PROJECT_DIR/frontend_candidate"
NETWORK="tezlify_tezlify-internal"
BACKEND_SERVICE="backend"
GATEWAY_SERVICE="gateway"
API_HEALTH_URL="https://api.130.162.247.20.sslip.io/health"
FRONTEND_URL="https://130.162.247.20.sslip.io"

# --- Geri donus modu: `--rollback-to <TS>` ---------------------------------
# Her surum, cutover'dan once mevcut imajlari `tezlify-backend:pre-<TS>`
# etiketiyle saklar; geri donus bu etiketi `latest`e baglar ve servisleri
# yeniden ayaga kaldirir. Frontend de varsa yedek dizinden geri yazilir.
if [ "${1:-}" = "--rollback-to" ]; then
  REL="${2:-}"
  [ -n "$REL" ] || { echo "kullanim: host-release.sh --rollback-to <TS>" >&2; exit 2; }
  cd "$PROJECT_DIR"
  printf '[rollback] %s surumune donuluyor\n' "$REL"
  docker tag "tezlify-backend:pre-$REL" tezlify-backend:latest
  docker tag "tezlify-gateway:pre-$REL" tezlify-gateway:latest
  if [ -d "$FRONTEND_DIR.prev-$REL" ]; then
    printf '[rollback] frontend yedekten geri yaziliyor: %s\n' "$FRONTEND_DIR.prev-$REL"
    find "$FRONTEND_DIR" -mindepth 1 -delete
    cp -a "$FRONTEND_DIR.prev-$REL/." "$FRONTEND_DIR/"
  fi
  docker compose -f "$COMPOSE_FILE" up -d backend gateway
  printf '[rollback] tamam. Kayit: backups/releases/%s/release.json\n' "$REL"
  exit 0
fi

SHA="${1:-}"
if [ -z "$SHA" ]; then
  echo "kullanim: bash scripts/deploy/host-release.sh <sha> [--frontend-tar PATH] [--skip-build] [--force-reset] [--health-timeout N] [--dry-run]" >&2
  exit 2
fi
shift || true

FRONTEND_TAR=""
SKIP_BUILD=0
FORCE_RESET=0
DRY_RUN=0
HEALTH_TIMEOUT=180
while [ $# -gt 0 ]; do
  case "$1" in
    --frontend-tar) FRONTEND_TAR="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --force-reset) FORCE_RESET=1; shift ;;
    --health-timeout) HEALTH_TIMEOUT="${2:-180}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "bilinmeyen secenek: $1" >&2; exit 2 ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$PROJECT_DIR/backups/releases/$TS"
CANDIDATE_NAME="tezlify-candidate-$TS"
CUTOVER=0
VERIFIED=0
FRONTEND_BACKUP=""

log() { printf '[release %s] %s\n' "$TS" "$*"; }
die() { printf '[release %s] HATA: %s\n' "$TS" "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

rollback() {
  log "GERI ALINIYOR: onceki imaj etiketlerine donuluyor"
  docker tag "tezlify-backend:pre-$TS" tezlify-backend:latest || true
  docker tag "tezlify-gateway:pre-$TS" tezlify-gateway:latest || true
  if [ -n "$FRONTEND_BACKUP" ] && [ -d "$FRONTEND_BACKUP" ]; then
    log "frontend dizini geri yukleniyor: $FRONTEND_BACKUP"
    find "$FRONTEND_DIR" -mindepth 1 -delete || true
    cp -a "$FRONTEND_BACKUP/." "$FRONTEND_DIR/" || true
  fi
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate "$BACKEND_SERVICE" "$GATEWAY_SERVICE" || true
  if [ -f "$RELEASE_DIR/deployed-commit.before" ]; then
    cp -a "$RELEASE_DIR/deployed-commit.before" "$PROJECT_DIR/.deployed-commit" || true
    log ".deployed-commit onceki degere dondu: $(cut -c1-12 "$PROJECT_DIR/.deployed-commit" 2>/dev/null || echo '?')"
  else
    rm -f "$PROJECT_DIR/.deployed-commit" || true
    log ".deployed-commit kaldirildi (onceki deger yoktu)"
  fi
  log "geri alindi"
}

on_error() {
  local code=$?
  log "HATA (cikis kodu $code)"
  if [ "$VERIFIED" = "1" ]; then
    # Dogrulama (hash'ler + public saglik) gectikten sonra hata artik GERI
    # DONME sebebi degil: cutover basarili, kanitlar alindi. Geri almak
    # calisan bir surumu bozmak olurdu (ilk denemede tam da bu oldu: kayit
    # dosyasindaki sozdizimi hatasi yuzunden iyi surum geri alindi).
    log "surum DOGRULANDI (hash + public saglik); geri alinmiyor — basarisiz adim yalnizca kayit"
  elif [ "$CUTOVER" = "1" ]; then
    rollback
  else
    log "trafik HENUZ cevrilmedi; canli sistem etkilenmedi"
  fi
  exit "$code"
}
trap on_error ERR

wait_healthy() {
  # $1 = container adi, $2 = health portu, $3 = saniye
  local name="$1" port="$2" limit="$3" i=1
  while [ "$i" -le "$limit" ]; do
    if docker exec "$name" curl -fsS --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# ---------------------------------------------------------------------------
# 0. On kosullar (hicbir seyi degistirmez)
# ---------------------------------------------------------------------------
cd "$PROJECT_DIR"
[ -f "$COMPOSE_FILE" ] || die "compose dosyasi yok: $COMPOSE_FILE"
[ "$(printf '%s' "$SHA" | wc -c)" -ge 7 ] || die "gecersiz sha: $SHA"

docker inspect tezlify-backend >/dev/null 2>&1 || die "tezlify-backend calismiyor"
PREV_BACKEND_IMAGE="$(docker inspect tezlify-backend --format '{{.Image}}')"
PREV_GATEWAY_IMAGE="$(docker inspect tezlify-gateway --format '{{.Image}}')"
log "mevcut backend imaj: $PREV_BACKEND_IMAGE"

log "git fetch origin --prune"
run git fetch origin --prune
git cat-file -e "$SHA^{commit}" 2>/dev/null || die "hedef SHA bu checkout'ta yok: $SHA (push edildi mi?)"
TARGET_FULL="$(git rev-parse "$SHA^{commit}")"

if [ "$DRY_RUN" = "1" ]; then
  log "PLAN: normalize -> build -> adacik saglik -> cutover -> dogrula (degisiklik yapilmadi)"
  log "hedef: $TARGET_FULL"
  exit 0
fi

mkdir -p "$RELEASE_DIR"
git status --porcelain > "$RELEASE_DIR/git-status-before.txt" || true
git diff > "$RELEASE_DIR/worktree-unstaged.patch" || true
git diff --cached > "$RELEASE_DIR/worktree-staged.patch" || true
# Rollback, .deployed-commit'i "geri alindi" diye birakip yeni SHA'yi orada
# birakmamali: denetim dosyasi calisan kodu gostermezse guvenilirligini
# yitirir. Onceki deger burada saklanir, rollback bunu geri yazar.
if [ -f "$PROJECT_DIR/.deployed-commit" ]; then
  cp -a "$PROJECT_DIR/.deployed-commit" "$RELEASE_DIR/deployed-commit.before" || true
fi
log "denetim kaydi: $RELEASE_DIR"

# ---------------------------------------------------------------------------
# 1. Checkout'u hedef SHA'ya normalize et
# ---------------------------------------------------------------------------
DIRTY_TRACKED="$(git status --porcelain --untracked-files=no || true)"
if [ -n "$DIRTY_TRACKED" ]; then
  if [ "$FORCE_RESET" != "1" ]; then
    printf '%s\n' "$DIRTY_TRACKED" | head -40
    die "calisma agaci kirli. Kaybi onlemek icin once inceleyin; bilincli ise --force-reset verin."
  fi
  log "calisma agaci kirli ($(printf '%s\n' "$DIRTY_TRACKED" | wc -l | tr -d ' ') dosya); patch yedeklendi, sifirlaniyor"
fi
run git reset --hard "$TARGET_FULL"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "reset sonrasi agac hala kirli — deploy edilen ile kaynak ayrisir"
fi
log "checkout temiz: $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"

# ---------------------------------------------------------------------------
# 2. Imajlari ONCE build et (eski container calismaya devam eder)
# ---------------------------------------------------------------------------
docker tag "$PREV_BACKEND_IMAGE" "tezlify-backend:pre-$TS"
docker tag "$PREV_GATEWAY_IMAGE" "tezlify-gateway:pre-$TS"
log "geri donus etiketleri hazir: tezlify-backend:pre-$TS / tezlify-gateway:pre-$TS"

if [ "$SKIP_BUILD" = "1" ]; then
  log "build atlandi (--skip-build)"
else
  log "imajlar build ediliyor (canli sistem bu sirada calisiyor)"
  docker compose -f "$COMPOSE_FILE" build "$BACKEND_SERVICE" "$GATEWAY_SERVICE"
fi
NEW_BACKEND_DIGEST="$(docker image inspect tezlify-backend:latest --format '{{.Id}}')"
NEW_GATEWAY_DIGEST="$(docker image inspect tezlify-gateway:latest --format '{{.Id}}')"
log "yeni backend imaj: $NEW_BACKEND_DIGEST"
log "yeni gateway imaj: $NEW_GATEWAY_DIGEST"

# ---------------------------------------------------------------------------
# 3. ADACIK SAGLIK KONTROLU — eski container hala ayakta
# ---------------------------------------------------------------------------
log "adacik container kaldiriliyor (gateway KAPALI, PORT=8001): $CANDIDATE_NAME"
docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
# Adacigin ortami CANLI container'dan kopyalanir, `.env.production`dan DEGIL:
# o dosya tirnakli degerler icerir ve `docker run --env-file` bunlari compose
# gibi soymez (ilk denemede DATABASE_URL basindaki tirnak yuzunden SQLAlchemy
# URL'i parse edemedi ve adacik olctu — cutover olmadigi icin canli etkilenmedi).
# Canli container'in env'i, compose'un cozumledigi halin ta kendisidir.
CANDIDATE_ENV_FILE="$RELEASE_DIR/candidate-env"
docker inspect "tezlify-$BACKEND_SERVICE" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > "$CANDIDATE_ENV_FILE" \
  || die "adacik ortami canli container'dan okunamadi"
log "adacik ortami canlidan kopyalandi: $(wc -l < "$CANDIDATE_ENV_FILE" | tr -d ' ') degisken"
docker run -d --name "$CANDIDATE_NAME" \
  --network "$NETWORK" \
  --env-file "$CANDIDATE_ENV_FILE" \
  -e PORT=8001 \
  -e GATEWAY_ENCRYPTION_KEY= \
  -e SKIP_JOB_RECOVERY=true \
  -e WHATSAPP_GATEWAY_URL="http://gateway:8787" \
  tezlify-backend:latest >/dev/null

if wait_healthy "$CANDIDATE_NAME" 8001 "$HEALTH_TIMEOUT"; then
  log "adacik SAGLIKLI — yeni imaj boot etti, migration'lar gecti"
  docker logs --tail 12 "$CANDIDATE_NAME" 2>&1 | sed 's/^/    /' || true
  docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
else
  log "adacik saglik kontrolu BASARISIZ — canli sisteme DOKUNULMADI"
  docker logs --tail 80 "$CANDIDATE_NAME" 2>&1 | sed 's/^/    /' || true
  docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  die "yeni imaj /health vermedi; eski container hala calisiyor"
fi

# ---------------------------------------------------------------------------
# 4. CUTOVER — adacik saglikli olduktan SONRA trafik cevrilir
# ---------------------------------------------------------------------------
CUTOVER=1
# `--force-recreate` SART: compose bir container'i "guncel" sayip recreate
# etmediginde yeni imaj canliya hic oturmaz ve surum kaydi olmayan bir imaji
# gosterir (olculdu: `up -d --dry-run backend` → "Container tezlify-backend
# Running", oysa latest etiketi yeni imaja kaymisti). Yeniden yaratmayi
# compose'un degisiklik sezgisine birakmak yerine acikca istiyoruz.
log "cutover: compose up -d --force-recreate backend gateway"
docker compose -f "$COMPOSE_FILE" up -d --force-recreate "$BACKEND_SERVICE" "$GATEWAY_SERVICE"
if ! wait_healthy tezlify-backend 8000 180; then
  die "yeni backend 180 sn icinde saglikli olmadi"
fi
log "yeni backend saglikli"

# Cutover'in gercekten YENI imaji calistirdigini kanitla: imaj kimligi
# kayittaki ile ayni degilse "deploy oldu" demek yanlis olur.
LIVE_BACKEND_IMAGE="$(docker inspect "tezlify-$BACKEND_SERVICE" --format '{{.Image}}')"
LIVE_GATEWAY_IMAGE="$(docker inspect "tezlify-$GATEWAY_SERVICE" --format '{{.Image}}')"
if [ "$LIVE_BACKEND_IMAGE" != "$NEW_BACKEND_DIGEST" ]; then
  die "cutover sonrasi backend yeni imajda degil (canli=${LIVE_BACKEND_IMAGE:0:12} beklenen=${NEW_BACKEND_DIGEST:0:12})"
fi
if [ "$LIVE_GATEWAY_IMAGE" != "$NEW_GATEWAY_DIGEST" ]; then
  die "cutover sonrasi gateway yeni imajda degil (canli=${LIVE_GATEWAY_IMAGE:0:12} beklenen=${NEW_GATEWAY_DIGEST:0:12})"
fi
log "cutover dogrulandi: backend=${LIVE_BACKEND_IMAGE:0:12} gateway=${LIVE_GATEWAY_IMAGE:0:12}"

# Frontend: backend ayaga kalktiktan SONRA yazilir (yeni bundle yeni uclari
# kullanabilir; tersi yonde eski bundle yeni uclara 404 alirdi).
if [ -n "$FRONTEND_TAR" ]; then
  [ -f "$FRONTEND_TAR" ] || die "frontend tarball yok: $FRONTEND_TAR"
  FRONTEND_BACKUP="$FRONTEND_DIR.prev-$TS"
  log "frontend degistiriliyor (yedek: $FRONTEND_BACKUP)"
  if [ -d "$FRONTEND_DIR" ]; then cp -a "$FRONTEND_DIR" "$FRONTEND_BACKUP"; fi
  find "$FRONTEND_DIR" -mindepth 1 -delete
  tar -xzf "$FRONTEND_TAR" -C "$FRONTEND_DIR"
  [ -f "$FRONTEND_DIR/index.html" ] || die "frontend tarball index.html icermiyor"
  log "frontend yazildi: $(find "$FRONTEND_DIR" -type f | wc -l | tr -d ' ') dosya"
fi

# ---------------------------------------------------------------------------
# 5. DOGRULAMA — hash'ler ve public uclar
# ---------------------------------------------------------------------------
verify_blob() {
  # $1 = container, $2 = container icindeki yol, $3 = repo yolu
  local container="$1" inner="$2" repo_path="$3" live expected
  live="$(docker exec "$container" sha256sum "$inner" | cut -d' ' -f1)"
  expected="$(git show "$TARGET_FULL:$repo_path" | sha256sum | cut -d' ' -f1)"
  if [ "$live" != "$expected" ]; then
    die "yayin hash uyusmuyor: $repo_path (canli=${live:0:12} git=${expected:0:12})"
  fi
  log "hash OK: $repo_path ${live:0:12}…"
}

verify_blob tezlify-backend "/app/backend/app/services/whatsapp/orchestration/events.py" "backend/app/services/whatsapp/orchestration/events.py"
verify_blob tezlify-backend "/app/backend/app/services/whatsapp/repositories/reactions.py" "backend/app/services/whatsapp/repositories/reactions.py"
verify_blob tezlify-gateway "/app/src/session-manager.js" "whatsapp-gateway/src/session-manager.js"

PUBLIC_OK=0
for attempt in 1 2 3 4 5 6; do
  if curl -fsS --max-time 8 "$API_HEALTH_URL" >/dev/null 2>&1; then PUBLIC_OK=1; break; fi
  sleep 5
done
if [ "$PUBLIC_OK" != "1" ]; then
  if curl -fsS -k --max-time 8 -H "Host: api.130.162.247.20.sslip.io" https://127.0.0.1/health >/dev/null 2>&1; then
    PUBLIC_OK=1
    log "public /health DNS uzerinden dogrulanamadi; Host header ile 200"
  fi
fi
[ "$PUBLIC_OK" = "1" ] || die "public /health 200 donmedi"
# Bu noktadan sonra yalnizca KAYIT yazilir; hata olursa surum geri alinmaz.
VERIFIED=1

if [ -d "$FRONTEND_DIR" ]; then
  if curl -fsS --max-time 10 "$FRONTEND_URL/" >/dev/null 2>&1; then
    log "frontend yayinda (200)"
  else
    log "UYARI: $FRONTEND_URL yanit vermedi — frontend kontrolu elle yapilmali"
  fi
fi

SHORT_SHA="$(git rev-parse --short "$TARGET_FULL")"
SUBJECT_JSON="$(git log -1 --format=%s "$TARGET_FULL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FRONTEND_JSON="null"
if [ -n "$FRONTEND_TAR" ]; then
  FRONTEND_JSON="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$(basename "$FRONTEND_TAR")")"
fi
cat > "$RELEASE_DIR/release.json" <<JSON
{
  "sha": "$TARGET_FULL",
  "sha_short": "$SHORT_SHA",
  "subject": $SUBJECT_JSON,
  "released_at": "$RELEASED_AT",
  "backend_image": "$NEW_BACKEND_DIGEST",
  "gateway_image": "$NEW_GATEWAY_DIGEST",
  "live_backend_image": "$LIVE_BACKEND_IMAGE",
  "live_gateway_image": "$LIVE_GATEWAY_IMAGE",
  "previous_backend_image": "$PREV_BACKEND_IMAGE",
  "rollback_tags": {"backend": "tezlify-backend:pre-$TS", "gateway": "tezlify-gateway:pre-$TS"},
  "frontend": $FRONTEND_JSON
}
JSON
# .deployed-commit EN SON yazilir: yukarisi patlarsa dosya eski SHA'yi gostermeye
# devam eder (ilk denemede bu dosya coktan yazilmisti ve geri almaya ragmen
# yeni SHA'yi gosteriyordu).
printf '%s\n' "$TARGET_FULL" > "$PROJECT_DIR/.deployed-commit"

log "SURUM TAMAM: $(git rev-parse --short "$TARGET_FULL") — $(git log -1 --format=%s "$TARGET_FULL")"
log "kayit: $RELEASE_DIR/release.json"
log "geri donus: bash scripts/deploy/host-release.sh --rollback-to $TS  (etiketler: tezlify-backend:pre-$TS)"
