#!/usr/bin/env bash
# Tezlify saatlik RAM snapshot timer'i — KURULUM ARACI (Faz 3.9.17)
#
# Bu betik KENDILIGINDEN HICBIR SEY YAPMAZ. Varsayilan mod yalnizca ON KONTROL
# calistirir ve ne yapacagini yazar. Gercek kurulum icin `--apply`, timer'i
# baslatmak icin ayrica `--start` gerekir.
#
#   ./install-ram-snapshot-timer.sh              # yalnizca kontrol (hicbir sey degismez)
#   sudo ./install-ram-snapshot-timer.sh --apply # birimleri kur, timer'i BASLATMA
#   sudo ./install-ram-snapshot-timer.sh --apply --start
#
# Geri alma:
#   sudo systemctl disable --now tezlify-ram-snapshot.timer
#   sudo rm -f /etc/systemd/system/tezlify-ram-snapshot.{service,timer}
#   sudo systemctl daemon-reload
#
# Notlar:
#  * Bu betik konteyner olusturmaz, yeniden baslatmaz, degistirmez.
#  * Yukleme onayi birim dosyasindaki TEZLIFY_OFFSITE_APPROVED=1 satiridir.
#    O satir yoksa gorev yalnizca yerel sifreli snapshot uretir.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/tezlify}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SNAP_SCRIPT="$REPO_DIR/scripts/backup/hourly_snapshot.py"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tezlify-ram}"
CONTAINER="${CONTAINER:-tezlify-backend}"

APPLY=0
START=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --start) START=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "bilinmeyen arguman: $arg" >&2; exit 2 ;;
  esac
done

if [ "$START" = "1" ] && [ "$APPLY" = "0" ]; then
  echo "REDDEDILDI: --start yalnizca --apply ile birlikte kullanilabilir." >&2
  exit 2
fi

fail=0
ok()   { printf '  [OK]   %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; fail=1; }

echo "== ON KONTROL =="

# 1) Betik yerinde mi ve host python3 ile derleniyor mu?
if [ -f "$SNAP_SCRIPT" ]; then
  ok "betik var: $SNAP_SCRIPT"
  if /usr/bin/python3 -m py_compile "$SNAP_SCRIPT" 2>/dev/null; then
    ok "host python3 betigi derliyor (harici bagimlilik yok)"
  else
    bad "betik derlenmiyor: $SNAP_SCRIPT"
  fi
else
  bad "betik yok: $SNAP_SCRIPT (once git pull)"
fi

# 2) Betik git'teki surumle ayni mi? (elle degistirilmis kopya ile calismasin)
if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$REPO_DIR" diff --quiet -- scripts/backup/hourly_snapshot.py; then
    ok "betik git calisma agaciyla tutarli"
  else
    warn "betik yerelde degistirilmis (git diff bos degil)"
  fi
else
  warn "$REPO_DIR bir git deposu degil"
fi

# 3) Docker ve backend konteyneri
if command -v docker >/dev/null 2>&1; then
  ok "docker bulundu"
  if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    ok "$CONTAINER calisiyor"
  else
    bad "$CONTAINER calismiyor"
  fi
  # 4) Sifreleme anahtari konteynerde TANIMLI mi (deger BASILMAZ)
  if docker exec "$CONTAINER" printenv GATEWAY_ENCRYPTION_KEY >/dev/null 2>&1; then
    ok "GATEWAY_ENCRYPTION_KEY konteynerde tanimli (deger okunmadi)"
  else
    bad "GATEWAY_ENCRYPTION_KEY konteynerde tanimli degil"
  fi
else
  bad "docker bulunamadi"
fi

# 5) Yedek dizini
if [ -d "$BACKUP_DIR" ]; then
  mode="$(stat -c '%a' "$BACKUP_DIR")"
  if [ "$mode" = "700" ]; then
    ok "yedek dizini var ve 0700"
  else
    warn "yedek dizini izni $mode (0700 beklenirdi)"
  fi
  free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
  echo "         bos alan: $((free_kb / 1024)) MiB"
  # Saatlik snapshot ~7.2 MB; 30 gunluk ihtiyac ~4.9 GiB (rapor Bolum 5).
  if [ "$free_kb" -lt 6291456 ]; then
    warn "bos alan 6 GiB'in altinda: 30 gunluk birikim icin yetersiz olabilir"
  else
    ok "bos alan 30 gunluk birikim icin yeterli gorunuyor"
  fi
else
  bad "yedek dizini yok: $BACKUP_DIR"
fi

# 6) Birim dosyalari bu betigin yaninda mi?
here="$(cd "$(dirname "$0")" && pwd)"
for u in tezlify-ram-snapshot.service tezlify-ram-snapshot.timer; do
  if [ -f "$here/$u" ]; then ok "birim dosyasi var: $u"; else bad "birim dosyasi yok: $here/$u"; fi
done

# 7) Ayni isi yapan baska bir timer var mi?
if systemctl list-timers --all --no-pager 2>/dev/null | grep -q "tezlify-ram-snapshot"; then
  warn "tezlify-ram-snapshot timer'i ZATEN kurulu"
else
  ok "cakisan snapshot timer'i yok"
fi

echo
if [ "$fail" = "1" ]; then
  echo "SONUC: on kontrol BASARISIZ — kurulum yapilmadi."
  exit 1
fi

if [ "$APPLY" = "0" ]; then
  echo "SONUC: on kontrol temiz. Hicbir sey degistirilmedi."
  echo "Kurmak icin:  sudo $0 --apply"
  echo "Baslatmak icin (AYRI ONAY):  sudo $0 --apply --start"
  exit 0
fi

echo "== KURULUM =="
install -m 0644 "$here/tezlify-ram-snapshot.service" "$UNIT_DIR/tezlify-ram-snapshot.service"
install -m 0644 "$here/tezlify-ram-snapshot.timer" "$UNIT_DIR/tezlify-ram-snapshot.timer"
echo "  birimler kopyalandi: $UNIT_DIR"
systemctl daemon-reload
echo "  daemon-reload yapildi"

if [ "$START" = "0" ]; then
  echo
  echo "SONUC: birimler kuruldu, timer BASLATILMADI."
  echo "Baslatmak icin:  sudo systemctl enable --now tezlify-ram-snapshot.timer"
  exit 0
fi

systemctl enable --now tezlify-ram-snapshot.timer
echo
echo "SONUC: timer etkin ve baslatildi."
systemctl list-timers --no-pager tezlify-ram-snapshot.timer || true
echo
echo "Ilk turu elle izlemek icin:  sudo systemctl start tezlify-ram-snapshot.service"
echo "Log:                          journalctl -u tezlify-ram-snapshot.service -n 50"
echo "Geri alma:                    sudo systemctl disable --now tezlify-ram-snapshot.timer"
