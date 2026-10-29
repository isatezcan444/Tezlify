#!/usr/bin/env bash
#
# HEDEF COMMIT'IN DEPLOY BETIGINI CALISTIR — hash pinli baslatici.
#
# NEDEN VAR
# ---------
# `host-release.sh` checkout'un ICINDEN calisir. `/opt/tezlify` yayindaki
# commit'teyken yeni bir commit'i dagitmaya kalkarsaniz ESKI betik kosar ve o
# betik yeni guvenlik kapilarini (adacikta zorunlu `...=false`, cutover sonrasi
# `/health` kontrolu) ICERMEZ. Deploy basarili gorunur, kapi hic calismaz.
#
# Bu baslatici o celiskiyi kapatir: hedef commit'in `host-release.sh` dosyasini
# git'ten cikarir, blob kimligini commit'teki kimlikle karsilastirir, sonra
# DOGRULANMIS kopyayi calistirir. Boylece calisan betik, denetlenen betiktir.
#
# KULLANIM (sunucuda, herhangi bir dizinden):
#   bash run_release.sh <sha|ref> [host-release secenekleri...]
#   bash run_release.sh --verify-only <sha|ref>      # yalnizca dogrula
#
#   --expected-self-blob <sha1>  Bu dosyanin kendi blob'unu pinler. Preflight
#                                (`backend_only_release.py`) bu degeri yazdirir;
#                                eski/degistirilmis bir baslatici kendini reddeder.
#
# ORTAM
#   HOST_RELEASE_REPO   depo yolu (varsayilan: bu dosyanin bulundugu depo).
#                       `/tmp`'ye cikarilmis bir kopyadan calistirirken
#                       `HOST_RELEASE_REPO=/opt/tezlify` verin.
#
# CIKIS KODLARI
#   0  basarili (ya da --verify-only basarili)
#   2  kullanim hatasi / commit cozulemedi
#   9  surum uyusmazligi — betik hedef commit'in betigi DEGIL
#
# HICBIR SEYI DEGISTIRMEZ: yalnizca `git show`/`git rev-parse`/`git hash-object`
# calistirir ve /tmp'ye bir kopya yazar. Deploy'u yapan sey, cagirdigi
# `host-release.sh`'tir.
set -Eeuo pipefail

PATH_IN_REPO="scripts/deploy/host-release.sh"
VERIFY_ONLY=0
EXPECTED_SELF_BLOB=""

die() {
  local code="$1"; shift
  printf '[run-release] HATA: %s\n' "$*" >&2
  exit "$code"
}

SELF_PATH="${BASH_SOURCE[0]}"
# `readlink -f` macOS'ta yok; varsa kullan, yoksa oldugu gibi birak.
SELF_REAL="$(readlink -f "$SELF_PATH" 2>/dev/null || printf '%s' "$SELF_PATH")"

# Depoyu bu dosyanin konumundan cozer: baslatici `/tmp`den kosarken bile
# `HOST_RELEASE_REPO` verilmedigi surece yanlis depoya bakmaz.
if [ -n "${HOST_RELEASE_REPO:-}" ]; then
  REPO_DIR="$HOST_RELEASE_REPO"
else
  REPO_DIR="$(git -C "$(dirname "$SELF_REAL")" rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$REPO_DIR" ] || die 2 "depo yolu cozulemedi (HOST_RELEASE_REPO verin)"
[ -d "$REPO_DIR" ] || die 2 "depo yok: $REPO_DIR"

while [ $# -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    --expected-self-blob) EXPECTED_SELF_BLOB="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) die 2 "bilinmeyen secenek: $1" ;;
    *) break ;;
  esac
done

REF="${1:-}"
[ -n "$REF" ] || die 2 "kullanim: bash run_release.sh <sha|ref> [--expected-self-blob <sha1>] [host-release secenekleri]"
shift || true

# --- 0. Kendi kimligimiz ----------------------------------------------------
# Baslatici giris noktasidir; kendi kaynagini kanitlayamaz ama KENDINI
# pinleyebilir: preflight'in yazdirdigi blob ile uyusmuyorsa reddeder.
SELF_BLOB="$(git -C "$REPO_DIR" hash-object -- "$SELF_REAL" 2>/dev/null || true)"
[ -n "$SELF_BLOB" ] || die 2 "kendi blob kimligim hesaplanamadi"
if [ -n "$EXPECTED_SELF_BLOB" ] && [ "$SELF_BLOB" != "$EXPECTED_SELF_BLOB" ]; then
  die 9 "baslatici pinlenen surum degil (self=${SELF_BLOB:0:12} beklenen=${EXPECTED_SELF_BLOB:0:12})"
fi
if [ -n "$EXPECTED_SELF_BLOB" ]; then
  printf '[run-release] baslatici blob=%s (pinlendi)\n' "${SELF_BLOB:0:12}"
else
  printf '[run-release] baslatici blob=%s\n' "${SELF_BLOB:0:12}"
fi

# --- 1. Hedef commit --------------------------------------------------------
TARGET="$(git -C "$REPO_DIR" rev-parse --verify "${REF}^{commit}" 2>/dev/null || true)"
[ -n "$TARGET" ] || die 2 "hedef commit cozulemedi: $REF (fetch edildi mi?)"
printf '[run-release] hedef=%s (%s)\n' "${TARGET:0:12}" "$REF"

EXPECTED_BLOB="$(git -C "$REPO_DIR" rev-parse --verify "$TARGET:$PATH_IN_REPO" 2>/dev/null || true)"
[ -n "$EXPECTED_BLOB" ] \
  || die 9 "hedef commit'te $PATH_IN_REPO YOK — bu surum dagitilamaz"

# --- 2. Betigi hedef commit'ten cikar ve kimligini kanitla ------------------
TMP_SCRIPT="/tmp/tezlify-host-release-${TARGET:0:12}.sh"
git -C "$REPO_DIR" show "$TARGET:$PATH_IN_REPO" > "$TMP_SCRIPT" 2>/dev/null \
  || die 9 "betik hedef commit'ten cikarilamadi"
[ -s "$TMP_SCRIPT" ] || die 9 "cikarilan betik bos"
chmod 700 "$TMP_SCRIPT" 2>/dev/null || true

ACTUAL_BLOB="$(git -C "$REPO_DIR" hash-object -- "$TMP_SCRIPT" 2>/dev/null || true)"
if [ "$ACTUAL_BLOB" != "$EXPECTED_BLOB" ]; then
  rm -f "$TMP_SCRIPT"
  die 9 "cikarilan betik hedefteki blob ile ayni degil (actual=${ACTUAL_BLOB:0:12} beklenen=${EXPECTED_BLOB:0:12})"
fi

# --- 3. Karar kapisi (saf mantik, test edilebilir) --------------------------
# Kapi betigi de HEDEF commit'ten cikarilir: calisma agacindaki bir kopya,
# denetlenen kod olmadigi icin "hedef muhafizi tasiyor mu" sorusunu yanitlamaz.
GUARD_PATH="scripts/deploy/script_version_guard.py"
EXPECTED_GUARD_BLOB="$(git -C "$REPO_DIR" rev-parse --verify "$TARGET:$GUARD_PATH" 2>/dev/null || true)"
[ -n "$EXPECTED_GUARD_BLOB" ] \
  || die 9 "hedef commit'te $GUARD_PATH YOK — surum dogrulamasi KANITLANAMAZ"
TMP_GUARD="/tmp/tezlify-script-version-guard-${TARGET:0:12}.py"
git -C "$REPO_DIR" show "$TARGET:$GUARD_PATH" > "$TMP_GUARD" 2>/dev/null \
  || die 9 "kapi betigi hedef commit'ten cikarilamadi"
ACTUAL_GUARD_BLOB="$(git -C "$REPO_DIR" hash-object -- "$TMP_GUARD" 2>/dev/null || true)"
if [ "$ACTUAL_GUARD_BLOB" != "$EXPECTED_GUARD_BLOB" ]; then
  die 9 "cikarilan kapi betigi hedefteki blob ile ayni degil"
fi

python3 "$TMP_GUARD" \
  --repo "$REPO_DIR" \
  --self "$TMP_SCRIPT" \
  --target-commit "$TARGET" \
  --path "$PATH_IN_REPO" \
  --pin-blob "$ACTUAL_BLOB" \
  --pin-commit "$TARGET" \
  || die 9 "surum dogrulamasi REDDETTI — deploy baslatilmadi"

printf '[run-release] betik blob=%s kaynak=%s\n' "${ACTUAL_BLOB:0:12}" "${TARGET:0:12}"

if [ "$VERIFY_ONLY" = "1" ]; then
  printf '[run-release] --verify-only: dogrulama GECTI, hicbir sey calistirilmadi\n'
  exit 0
fi

# --- 4. Dogrulanmis kopyayi calistir ---------------------------------------
# `exec`: bu surec betigin yerine gecer; sinyal/exit kodu dogrudan operatora
# gider. Kopya /tmp'de KALIR — bash betigi calisirken artimli okur, silmek
# calisan bir betigin altindan dosyayi cekmek olurdu.
printf '[run-release] calistiriliyor: %s %s\n' "$TMP_SCRIPT" "${*:-}"
exec env \
  HOST_RELEASE_SOURCE_COMMIT="$TARGET" \
  HOST_RELEASE_EXPECTED_BLOB="$ACTUAL_BLOB" \
  bash "$TMP_SCRIPT" "$TARGET" "$@"
