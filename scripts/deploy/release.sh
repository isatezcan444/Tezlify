#!/usr/bin/env bash
#
# SURUM ORKESTRASYONU — GELISTIRICI MAKINESI TARAFI.
#
# Tasarim karari: frontend BURADA (yerelde, kilitli bagimliliklarla) build
# edilir ve sunucuya hazir artefakt olarak gider; backend/gateway imajlari ise
# sunucuda, CHECKOUT'UN KENDISINDEN build edilir (Dockerfile'lar `COPY
# backend/`, `COPY whatsapp-gateway/src` yapar). Bu yuzden:
#   * sunucudaki checkout hedef SHA'ya NORMALIZE edilmis olmalidir — aksi
#     halde imaj "git'te olmayan" bir koddan uretilir (bu tam olarak
#     yasadigimiz sapmaydi), ve
#   * frontend hash'leri yerelde uretilip yayinda dogrulanir.
#
# Kullanim:
#   bash scripts/deploy/release.sh [sha] [--skip-build] [--no-frontend] [--dry-run]
#
set -Eeuo pipefail

HOST="ubuntu@130.162.247.20"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_tezlify_oracle}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
API_HEALTH_URL="https://api.130.162.247.20.sslip.io/health"
FRONTEND_URL="https://130.162.247.20.sslip.io"

SHA=""
SKIP_BUILD=""
NO_FRONTEND=""
DRY_RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD="--skip-build"; shift ;;
    --no-frontend) NO_FRONTEND="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -*) echo "bilinmeyen secenek: $1" >&2; exit 2 ;;
    *) SHA="$1"; shift ;;
  esac
done

log() { printf '[release] %s\n' "$*"; }
die() { printf '[release] HATA: %s\n' "$*" >&2; exit 1; }

cd "$REPO_ROOT"
SHA="${SHA:-$(git rev-parse HEAD)}"
SHA="$(git rev-parse "$SHA^{commit}")"
SHORT="$(git rev-parse --short "$SHA")"

# --- On kosullar -----------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  git status --short | head -20
  die "yerel calisma agaci kirli: build edilecek artefakt hangi koddan ciktigi belirsiz olur"
fi
git cat-file -e "origin/main:$SHA" 2>/dev/null || true
if ! git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
  die "$SHORT origin/main uzerinde degil — sunucu bu SHA'yi fetch edemez (once push edin)"
fi
log "hedef: $SHORT $(git log -1 --format=%s "$SHA")"

# --- 1. Frontend artefakti (yerelde, hermetik) -----------------------------
FRONTEND_TAR=""
if [ -z "$NO_FRONTEND" ]; then
  log "frontend build (vite)"
  (cd "$FRONTEND_DIR" && npm run build >/tmp/tezlify-frontend-build.log 2>&1) \
    || { tail -30 /tmp/tezlify-frontend-build.log; die "frontend build basarisiz"; }

  node -e '
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    const dist = process.argv[1];
    const wanted = ["index.html"].concat(
      fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js") || f.endsWith(".css"))
    );
    const out = {};
    for (const rel of wanted) {
      const p = rel === "index.html" ? path.join(dist, rel) : path.join(dist, "assets", rel);
      if (!fs.existsSync(p)) continue;
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
    fs.writeFileSync(path.join(dist, "deploy-hashes.json"), JSON.stringify(out, null, 2));
    console.log(`  build cikti sayisi: ${Object.keys(out).length}`);
  ' "$FRONTEND_DIR/dist" || die "build hash manifesti uretilemedi"

  SHORT_SAFE="$(printf '%s' "$SHORT" | tr -cd 'a-zA-Z0-9._-')"
  FRONTEND_TAR="/tmp/tezlify-frontend-${SHORT_SAFE}.tgz"
  tar czf "$FRONTEND_TAR" -C "$FRONTEND_DIR/dist" .
  log "frontend tarball: $FRONTEND_TAR ($(du -h "$FRONTEND_TAR" | cut -f1))"
fi

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run: sunucu tarafina DOKUNULMADI"
  log "sunucuda calistirilacak: bash scripts/deploy/host-release.sh $SHA ${SKIP_BUILD} ${FRONTEND_TAR:+--frontend-tar $FRONTEND_TAR} --force-reset"
  exit 0
fi

# --- 2. Artefaktlari sunucuya kopyala --------------------------------------
if [ -n "$FRONTEND_TAR" ]; then
  log "tarball sunucuya kopyalaniyor"
  scp -i "$SSH_KEY" -o ConnectTimeout=20 "$FRONTEND_TAR" "$HOST:/tmp/" >/dev/null
fi

# --- 3. Sunucu tarafi akis (adacik saglik kapisi + cutover + dogrulama) -----
log "sunucu akisi basliyor (once imaj build + ADACIK saglik, sonra cutover)"
# Sunucudaki script HEDEF COMMIT'ten gelir: once fetch, sonra yalnizca o dosyayi
# checkout et. Boylece calisan script ile deploy edilen kod AYNI git nesnesidir
# (script'i scp ile kopyalamak "sunucuda ne var?" sorusunu geri getirirdi).
# Reset'in kendisi hala host script'inin icinde ve `--force-reset` ister.
# shellcheck disable=SC2029
ssh -i "$SSH_KEY" -o ConnectTimeout=20 "$HOST" \
  "cd /opt/tezlify && git fetch origin --prune && git checkout $(printf '%s' "$SHA") -- scripts/deploy/host-release.sh && bash scripts/deploy/host-release.sh $SHA $SKIP_BUILD ${FRONTEND_TAR:+--frontend-tar /tmp/$(basename "$FRONTEND_TAR")} --force-reset"

# --- 4. Yayin dogrulamasi (yerelden, public uclar) -------------------------
log "public /health"
curl -fsS --max-time 10 "$API_HEALTH_URL" >/dev/null || die "public /health 200 donmedi"
log "public /health OK"

live_hash() {
  # $1 = url, $2 = beklenen hash. Cutover'in hemen ardindan CDN/Caddy ilk
  # saniyelerde onceki dosyayi servis edebiliyor; o yuzden kisa tekrarlar var.
  # Kalici sapma (gercek drift) yine de yakalanir: 5 deneme sonrasi doner.
  local url="$1" want="$2" got="" attempt
  for attempt in 1 2 3 4 5; do
    got="$(curl -fsS --max-time 20 "$url" 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)"
    [ "$got" = "$want" ] && break
    sleep 3
  done
  printf '%s' "$got"
}

if [ -n "$FRONTEND_TAR" ]; then
  log "yayindaki frontend hash'leri karsilastiriliyor"
  FAILED=""
  while read -r rel hash; do
    if [ "$rel" = "index.html" ]; then
      live="$(live_hash "$FRONTEND_URL/" "$hash")"
      if [ "$live" != "$hash" ]; then FAILED="$FAILED index.html"; fi
    else
      live="$(live_hash "$FRONTEND_URL/assets/$rel" "$hash")"
      if [ "$live" != "$hash" ]; then FAILED="$FAILED $rel"; fi
    fi
  done < <(node -e '
    const fs = require("node:fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [k, v] of Object.entries(m)) if (/^(index-.*\.(js|css)|WhatsAppHubPage-.*\.js|ChatBubble-.*\.js|index\.html)$/.test(k)) console.log(`${k} ${v}`);
  ' "$FRONTEND_DIR/dist/deploy-hashes.json")

  if [ -n "$FAILED" ]; then
    die "yayindaki dosyalar yerel build ile ayni degil:$FAILED"
  fi
  log "frontend hash'leri birebir ayni"
fi

log "SURUM TAMAM — smoke: node frontend/scripts/verify-production-whatsapp.mjs"
