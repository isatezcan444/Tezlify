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
#   --no-gateway          gateway'i YENIDEN OLUSTURMA (yalnizca backend build +
#                         cutover). Gateway'in bellek ici deposu her restart'ta
#                         kayboldugu ve WhatsApp mevcut oturum icin gecmis
#                         gondermedigi icin (A6) her recreate bir gecmis kaybi
#                         olayidir. Muhafiz: yayindaki commit ile hedef arasinda
#                         `whatsapp-gateway/` veya compose dosyasi degistiyse
#                         komut REDDEDILIR — sessiz "yayina gitmemis gateway
#                         degisikligi" bu bayragin tek gercek riskidir.
#   --force-reset         kirli calisma agacini SIFIRLA (diff once yedeklenir)
#   --health-timeout N    adacik/gercek container saglik bekleme suresi (sn)
#   --dry-run             hicbir seyi degistirme; planı yaz ve cik
#   --allow-migrations    deploy araligi YIKICI migration satiri ekliyorsa
#                         (DELETE FROM / TRUNCATE / DROP TABLE / DROP COLUMN)
#                         gereken ACIK ONAY. Verilmezse deploy, hicbir container
#                         calismadan reddedilir. Gerekce: adacik container
#                         cutover'dan ONCE ayni uretim veritabanina karsi tum
#                         startup migration setini calistiriyor — yani yikici bir
#                         migration'in bedeli "cutover" degil "veri" oluyor.
#
# VERI KAYBI MUHAFIZLARI (bu script'in tek gercek riski)
# ------------------------------------------------------
#   1. STATIK : yukaridaki --allow-migrations kapisi (container'dan ONCE).
#   2. SAYIM  : adacik penceresi oncesi/sonrasi satir sayimlari karsilastirilir;
#               sayi dustuyse cutover YAPILMAZ (onay yoksa) — canli dokunulmaz.
#   3. LOG    : adacik logu container silinmeden ONCE release dizinine yazilir.
#               2026-10-27'de bir sohbet tam bu pencerede kayboldu ve "kim sildi"
#               sorusu log container'la birlikte silindigi icin cevapsiz kaldi.
#   4. SEMA   : cutover oncesi/sonrasi sema parmak izi (kolon+indeks) saklanir.
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
  echo "kullanim: bash scripts/deploy/host-release.sh <sha> [--frontend-tar PATH] [--skip-build] [--no-gateway] [--force-reset] [--health-timeout N] [--allow-migrations] [--dry-run]" >&2
  exit 2
fi
shift || true

FRONTEND_TAR=""
SKIP_BUILD=0
FORCE_RESET=0
DRY_RUN=0
NO_GATEWAY=0
ALLOW_MIGRATIONS=0
HEALTH_TIMEOUT=180
while [ $# -gt 0 ]; do
  case "$1" in
    --frontend-tar) FRONTEND_TAR="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-gateway) NO_GATEWAY=1; shift ;;
    --force-reset) FORCE_RESET=1; shift ;;
    --allow-migrations) ALLOW_MIGRATIONS=1; shift ;;
    --health-timeout) HEALTH_TIMEOUT="${2:-180}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "bilinmeyen secenek: $1" >&2; exit 2 ;;
  esac
done

# Cutover'da yeniden ayaga kaldirilacak servisler.
#
# `--no-gateway` NEDEN VAR: gateway'in bellek ici deposu (chats/messagesByChat/
# store.contacts) her restart'ta kaybolur ve WhatsApp mevcut bir oturum icin
# gecmis senkronu gondermez (invariant A6). Yani her deploy, gateway'i yeniden
# olusturdugu surece bir "gecmis kaybi" olayidir — backend-only bir degisiklik
# icin bile. Bu mod, gateway agacina DOKUNULMADIGI kanitlanmis deploy'larda onu
# ayakta birakir. Yanlis kullanimi engellemek icin asagida bir muhafiz var:
# gateway ile ilgili dosyalar degismisse komut REDDEDILIR.
if [ "$NO_GATEWAY" = "1" ]; then
  CUTOVER_SERVICES=("$BACKEND_SERVICE")
else
  CUTOVER_SERVICES=("$BACKEND_SERVICE" "$GATEWAY_SERVICE")
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$PROJECT_DIR/backups/releases/$TS"
CANDIDATE_NAME="tezlify-candidate-$TS"
CUTOVER=0
VERIFIED=0
FRONTEND_BACKUP=""
# Adacigin izole veritabani. Bos = izolasyon kurulmadi (henuz ya da basarisiz).
# `on_error` bunu kosulsuz okur, bu yuzden `set -u` icin baslangicta tanimli.
CANDIDATE_DB=""
# Filigran karsilastirmasi (hedef commit'ten cozulur, asagida).
WATERMARK_PY=""

log() { printf '[release %s] %s\n' "$TS" "$*"; }
# `die` bir `exit` yapar; `exit` ERR tuzagini TETIKLEMEZ. Bu yuzden izole DB
# temizligi burada da yapilir — aksi halde `die` ile biten her hata yolunda
# gercek satirlar tasiyan bir kopya veritabaninda kalirdi.
die() {
  candidate_db_drop "${CANDIDATE_DB:-}"
  printf '[release %s] HATA: %s\n' "$TS" "$*" >&2
  exit 1
}
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# ADACIK IZOLASYONU — aday artik URETIM DB'sine yazmaz
# ---------------------------------------------------------------------------
# ONCEKI DURUM (2026-10-27'ye kadar): adacik, canli container'in ortamini
# oldugu gibi aliyordu; `DATABASE_URL` uretim veritabanini gosteriyordu. Yani
# "aday saglikli mi" diye boot ettigimiz container, startup migration
# zincirinin TAMAMINI uretim verisi uzerinde kosuyordu. Kapilar (sayim +
# filigran) bunu ancak SONRADAN tespit ediyordu — 2026-10-27'de 1 sohbet +
# 9 mesaj tam olarak boyle, cutover karari verilmeden once silindi.
#
# YENI DURUM: adacik, uretimin AYNI ANDAKI kopyasi uzerinde kosar. Boylece
#  - "migration patliyor mu" sorusu gercek sekilli veride cevaplanir,
#  - yikici bir migration'in NE SILECEGI kopyada olculur (uretimde degil),
#  - uretim satirlarina yazma yetkisi hic verilmez.
# Kopya, adacik olculdukten hemen sonra DROP edilir; kalici bir artik birakmaz.
# Uretim verisine hicbir test satiri eklenmez.
db_counts_for() {
  # $1 = veritabani adi. Cikti: "conversations|messages|contacts"
  local db="${1:-}"
  case "$db" in ''|*[!A-Za-z0-9_]*) printf 'unavailable\n'; return 0 ;; esac
  docker exec "${DB_CONTAINER:-tezlify-db}" psql -U "${DB_USER:-tezlify}" -d "$db" -t -A -F'|' -c \
    "select (select count(*) from conversations), (select count(*) from messages), (select count(*) from contacts);" \
    2>/dev/null || printf 'unavailable\n'
}

candidate_db_drop() {
  # Idempotent ve sessiz: hata yolunda da cagrilir, hicbir zaman patlamaz.
  local db="${1:-}"
  case "$db" in ''|*[!A-Za-z0-9_]*) return 0 ;; esac
  docker exec "${DB_CONTAINER:-tezlify-db}" psql -U "${DB_USER:-tezlify}" -d postgres -q \
    -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 \
    || docker exec "${DB_CONTAINER:-tezlify-db}" psql -U "${DB_USER:-tezlify}" -d postgres -q \
         -c "DROP DATABASE IF EXISTS \"$db\"" >/dev/null 2>&1 || true
  return 0
}

candidate_db_prune_stale() {
  # SIGKILL (tuzak calismaz) ile biten bir kosum, icinde GERCEK satirlar olan
  # bir kopya birakabilir. Ayni onekle gelen eski kopyalar burada temizlenir.
  # Es zamanli deploy desteklenmiyor: "keep" disindaki her sey artik.
  local keep="${1:-}" db
  for db in $(docker exec "${DB_CONTAINER:-tezlify-db}" psql -U "${DB_USER:-tezlify}" \
      -d postgres -t -A -c \
      "select datname from pg_database where datname like '${DB_NAME}_cand_%' and datname <> '$keep';" \
      2>/dev/null || true); do
    case "$db" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    candidate_db_drop "$db"
    log "eski adacik kopyasi temizlendi: $db"
  done
  return 0
}

candidate_db_create() {
  # $1 = hedef DB, $2 = kaynak DB. Sema + VERI kopyasi.
  # Veri kopyasi bilinclidir: yikici bir migration'in etkisi ancak gercek
  # satirlar varken olculebilir. Kopya oldugu icin kayip riski yoktur.
  local db="${1:-}" src="${2:-}"
  case "$db" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
  case "$src" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
  candidate_db_prune_stale "$db"
  candidate_db_drop "$db"
  if ! docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -q \
        -c "CREATE DATABASE \"$db\"" >/dev/null 2>&1; then
    log "izole DB olusturulamadi: $db"
    return 1
  fi
  if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$src" \
        --no-owner --no-privileges 2>"$RELEASE_DIR/candidate-db-dump.err" \
       | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$db" -q \
         >"$RELEASE_DIR/candidate-db-restore.log" 2>&1; then
    log "izole DB kopyasi basarisiz (candidate-db-dump.err / candidate-db-restore.log)"
    candidate_db_drop "$db"
    return 1
  fi
  local tables
  tables="$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$db" -t -A -c \
    "select count(*) from information_schema.tables where table_schema in ('public','whatsapp_private')" \
    2>/dev/null || echo 0)"
  # Kopya "oldu" demek icin tablolar gercekten gelmis olmali; psql hata
  # yutabilir (ON_ERROR_STOP kapali, uzanti izinleri icin), bu yuzden olcut
  # niyet degil SAYI: en az 10 tablo yoksa kopya yoktur.
  if [ "${tables:-0}" -lt 10 ]; then
    log "izole DB kopyasi eksik: yalnizca ${tables:-0} tablo"
    candidate_db_drop "$db"
    return 1
  fi
  log "izole DB hazir: $db ($tables tablo, $src kopyasi)"
  return 0
}

candidate_env_isolate() {
  # $1 = env dosyasi, $2 = izole DB. DATABASE_URL'i kopyaya cevirir.
  # Uretim URL'i adacik env'inde KALMAZ: "yazma yetkisi yok" iddiasi ancak
  # boyle dogrulanabilir. Donusum mantigi `candidate_db_url.py`'de durur —
  # orada birim testiyle dogrulanir, burada yalnizca cagrilir.
  local envfile="${1:-}" db="${2:-}"
  [ -f "$envfile" ] || return 1
  case "$db" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
  [ -n "$CANDIDATE_DB_URL_PY" ] || return 1
  python3 "$CANDIDATE_DB_URL_PY" "$envfile" "$db" || return 1
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
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate "${CUTOVER_SERVICES[@]}" || true
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
  # Izole DB her cikista temizlenir: yarim kalmis bir kopya, icinde gercek
  # satirlar ve kimlik bilgileri tasiyan bir artik olarak kalmamali.
  candidate_db_drop "$CANDIDATE_DB"
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
# Veri butunlugu probu — SALT OKUNUR
# ---------------------------------------------------------------------------
# `db` compose'da tanimli DEGIL (elle kurulmus, etiketsiz container). Bu yuzden
# container ADI sabittir ve yoksa prob sessizce "unavailable" doner: deploy bir
# DB topolojisi varsayimi yuzunden durmamali. Sayim dustugunde karar veren
# muhafiz ayri; bu yalnizca olcum.
DB_CONTAINER="tezlify-db"
DB_NAME="tezlify"
DB_USER="tezlify"

db_available() { docker inspect "$DB_CONTAINER" >/dev/null 2>&1; }

db_counts() {
  # Cikti: "conversations|messages|contacts" veya "unavailable"
  if ! db_available; then printf 'unavailable\n'; return 0; fi
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F'|' -c \
    "select (select count(*) from conversations), (select count(*) from messages), (select count(*) from contacts);" \
    2>/dev/null || printf 'unavailable\n'
}

# Sohbet bazinda mesaj sayisi — "hangi sohbet kac mesaj kaybetti" sorusunu
# cevaplar. `edge` verilirse YALNIZCA o kimlik esiginin altindaki mesajlar
# sayilir; yeni gelen mesajlar ozeti degistirmez, yani once/sonra kiyasi
# gercek kaybi gosterir.
#
# KARAR VERMEZ, KANIT URETIR: canli kimlik supurmesi mesru bir birlestirme
# yaparsa mesajlar sohbetler ARASINDA tasinir ve bu ozet degisir — kayip
# olmadan. Kayip karari filigrana aittir (kimlik tasinmaz, korunur).
db_relation_digest() {
  local edge="${1:-}" where=""
  if [ -n "$edge" ]; then
    case "$edge" in *[!0-9]*) printf 'unavailable\n'; return 0 ;; esac
    where="where id <= $edge"
  fi
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
    "select conversation_id||'|'||count(*) from messages $where group by 1 order by 1;" \
    2>/dev/null || printf 'unavailable\n'
}

schema_fingerprint() {
  # Kolon + indeks envanteri. Satir SAYISI degil, YAPI: bir migration'in
  # ekledigi/dusurdugu her sey burada gorunur, veri degisimi gorunmez.
  if ! db_available; then printf 'unavailable\n'; return 0; fi
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
    "select table_name||'.'||column_name||':'||data_type from information_schema.columns where table_schema='public' order by 1;" \
    2>/dev/null || true
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
    "select 'INDEX '||indexname from pg_indexes where schemaname='public' order by 1;" \
    2>/dev/null || true
}

# Sayim dustuyse "alan:once->sonra" satirlari basar. Dusmediyse bos doner.
# `unavailable` iceren her durumda karar VERILMEZ (olcum yok, yanlis pozitif yok).
counts_dropped() {
  local before="${1:-}" after="${2:-}"
  case "$before$after" in *unavailable*) return 0 ;; esac
  local b_c b_m b_t a_c a_m a_t
  IFS='|' read -r b_c b_m b_t <<<"$before"
  IFS='|' read -r a_c a_m a_t <<<"$after"
  if [ "${a_c:-0}" -lt "${b_c:-0}" ]; then printf 'conversations:%s->%s\n' "$b_c" "$a_c"; fi
  if [ "${a_m:-0}" -lt "${b_m:-0}" ]; then printf 'messages:%s->%s\n' "$b_m" "$a_m"; fi
  if [ "${a_t:-0}" -lt "${b_t:-0}" ]; then printf 'contacts:%s->%s\n' "$b_t" "$a_t"; fi
  return 0
}

# Mesaj KIMLIK filigrani — "yeni gelen mesaj sayimi sisirdi mi?" sorusunu
# ortadan kaldirir.
#
# `counts_dropped` yalnizca TOPLAM sayiya bakar. Canli bir hatta pencere
# boyunca yeni mesaj gelir: 9 mesaj silinip 9 yeni mesaj gelirse toplam
# DEGISMEZ ve kayip gorunmez. Filigran bunu kapatir — once `max(id)` ve o ana
# kadarki mesaj sayisi alinir, sonra "id'si bu esigin ALTINDA kalan kac mesaj
# duruyor" sorulur. Yeni mesajlar esigin USTUNDE oldugu icin sayima girmez,
# silinen her eski mesaj ise kesinlikle gorunur.
db_message_watermark() {
  # Cikti: "max_id|adet" veya "unavailable"
  if ! db_available; then printf 'unavailable\n'; return 0; fi
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F'|' -c \
    "select coalesce(max(id),0), count(*) from messages;" \
    2>/dev/null || printf 'unavailable\n'
}

db_messages_upto() {
  local edge="${1:-}"
  case "$edge" in ''|*[!0-9]*) printf 'unavailable\n'; return 0 ;; esac
  if ! db_available; then printf 'unavailable\n'; return 0; fi
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
    "select count(*) from messages where id <= $edge;" \
    2>/dev/null || printf 'unavailable\n'
}

# Filigran oncesinde var olan mesajlardan kaci kayboldu? Kayip yoksa bos doner.
# Karsilastirma `message_watermark.py`'de durur: bash icinde gomulu bir
# kosul test edilemezdi, oysa bu olcu "veri kaybi var mi" sorusunun tek
# dayanagi. Orada birim testiyle dogrulanir (yeni gelen mesajlarin sayimi
# sisirmedigi dâhil), burada yalnizca cagrilir.
messages_lost_since() {
  local wm="${1:-}" after="${2:-}"
  [ -n "${WATERMARK_PY:-}" ] || return 0
  python3 "$WATERMARK_PY" "$wm" "$after" || true
  return 0
}

# Adacik logunu container SILINMEDEN once diske al.
#
# `docker rm -f` container'in log dizinini de siler; 2026-10-27'de yikici bir
# migration'in kaniti tam olarak boyle yok oldu. `docker logs` bir json-file
# okuma yoludur ve truncate edilmis dosyada kilitlenebilir (bkz. ops notu), bu
# yuzden basarisiz olursa dosya dogrudan kopyalanir.
capture_candidate_log() {
  local name="$1" out="$2"
  if docker logs "$name" >"$out" 2>&1; then
    log "adacik logu kaydedildi: $out ($(wc -l <"$out" | tr -d ' ') satir)"
    return 0
  fi
  local path
  path="$(docker inspect "$name" --format '{{.LogPath}}' 2>/dev/null || true)"
  if [ -n "$path" ] && [ -r "$path" ] && cp "$path" "$out.raw" 2>/dev/null; then
    log "adacik logu docker logs'tan alinamadi; dosyadan kopyalandi: $out.raw"
    return 0
  fi
  log "UYARI: adacik logu KAYDEDILEMEDI ($name) — container silinecek, kanit kaybolacak"
  return 0
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

# Yayindaki commit — hem --no-gateway muhafizi hem migration muhafizi icin
# karsilastirma tabani. (Onceden yalnizca --no-gateway dalinda okunuyordu.)
PREV_DEPLOYED="$(cat "$PROJECT_DIR/.deployed-commit" 2>/dev/null | tr -d '[:space:]' || true)"

# --no-gateway MUHAFIZI
#
# "Gateway'e dokunmadim" iddiasini insan hafizasina birakmak, bir gun gateway
# degisikliginin sessizce yayina hic gitmemesi demek olurdu (yanlis yonde
# basarisizlik: deploy "basarili" gorunur, kod eski kalir). Bu yuzden iddia
# DOGRULANIR: yayindaki commit ile hedef arasinda gateway'i etkileyen bir dosya
# degistiyse komut reddedilir.
if [ "$NO_GATEWAY" = "1" ]; then
  [ -n "$PREV_DEPLOYED" ] || die "--no-gateway icin .deployed-commit gerekli (karsilastirma tabani yok)"
  git cat-file -e "$PREV_DEPLOYED^{commit}" 2>/dev/null \
    || die "--no-gateway: .deployed-commit ($PREV_DEPLOYED) bu checkout'ta yok"
  if ! git diff --quiet "$PREV_DEPLOYED" "$TARGET_FULL" -- \
      whatsapp-gateway/ "$COMPOSE_FILE" docker-compose.yml; then
    log "gateway'i etkileyen degisiklikler:"
    git diff --stat "$PREV_DEPLOYED" "$TARGET_FULL" -- \
      whatsapp-gateway/ "$COMPOSE_FILE" docker-compose.yml | sed 's/^/    /'
    die "--no-gateway kullanilamaz: gateway/compose degismis (bayragi kaldirin)"
  fi
  log "gateway muhafizi GECTI: $PREV_DEPLOYED..$TARGET_FULL arasinda gateway agaci degismedi"
fi

# ---------------------------------------------------------------------------
# YIKICI MIGRATION MUHAFIZI — container calismadan ONCE
# ---------------------------------------------------------------------------
# Neden burada ve neden statik: adacik container (asama 3) AYNI uretim
# veritabanina baglanip tum startup migration setini calistiriyor. Yani yikici
# bir migration fark edildiginde artik "cutover'i durduralim" demek ise yaramaz
# — satirlar zaten silinmistir. Tek etkili kapi, container hic kalkmadan once
# kod farkina bakmaktir.
#
# Kapsam: yalnizca EKLENEN satirlar (`migration_guard.py diff`). Kaldirilan bir
# `DELETE` satiri yikiciligi AZALTIR, engellenmez. `UPDATE ... SET` (backfill
# onarimlari) raporlanir ama engellemez — her deploy'da engel olmak operatoru
# surekli onay vermeye alistirip asil uyariyi degersizlestirirdi.
# Muhafiz betigi, HEDEF COMMIT'ten okunur — calisma agacindan DEGIL.
#
# Bootstrap sorunu: bu betik ilk kez dagitildiginda konakta henuz YOKTUR (agac
# hala onceki commit'te, `git reset --hard` ise daha ileride). Calisma agacindan
# calistirmak ilk deploy'u "muhafiz calistirilamadi" diye reddederdi. Hedef
# commit'ten okumak ayrica dogru olani yapar: denetlenen kod, dagitilan koddur.
GUARD_PY="/tmp/tezlify-migration-guard-$TS.py"
if git show "$TARGET_FULL:scripts/deploy/migration_guard.py" > "$GUARD_PY" 2>/dev/null \
    && [ -s "$GUARD_PY" ]; then
  :
elif [ -f "$PROJECT_DIR/scripts/deploy/migration_guard.py" ]; then
  GUARD_PY="$PROJECT_DIR/scripts/deploy/migration_guard.py"
  log "UYARI: migration_guard.py hedef commit'te yok; calisma agacindaki kopya kullaniliyor"
else
  GUARD_PY=""
fi

# Ayni bootstrap mantigi: adacik env'ini izole kopyaya ceviren yardimci da
# hedef commit'ten okunur. Yoksa izolasyon KANITLANAMAZ — ve kanitlanamayan
# izolasyonla deploy edilmez (asagida `die`).
CANDIDATE_DB_URL_PY="/tmp/tezlify-candidate-db-url-$TS.py"
if git show "$TARGET_FULL:scripts/deploy/candidate_db_url.py" > "$CANDIDATE_DB_URL_PY" 2>/dev/null \
    && [ -s "$CANDIDATE_DB_URL_PY" ]; then
  :
elif [ -f "$PROJECT_DIR/scripts/deploy/candidate_db_url.py" ]; then
  CANDIDATE_DB_URL_PY="$PROJECT_DIR/scripts/deploy/candidate_db_url.py"
  log "UYARI: candidate_db_url.py hedef commit'te yok; calisma agacindaki kopya kullaniliyor"
else
  CANDIDATE_DB_URL_PY=""
fi

# Filigran karsilastirmasi da hedef commit'ten okunur: denetlenen kod,
# dagitilan koddur.
WATERMARK_PY="/tmp/tezlify-message-watermark-$TS.py"
if git show "$TARGET_FULL:scripts/deploy/message_watermark.py" > "$WATERMARK_PY" 2>/dev/null \
    && [ -s "$WATERMARK_PY" ]; then
  :
elif [ -f "$PROJECT_DIR/scripts/deploy/message_watermark.py" ]; then
  WATERMARK_PY="$PROJECT_DIR/scripts/deploy/message_watermark.py"
  log "UYARI: message_watermark.py hedef commit'te yok; calisma agacindaki kopya kullaniliyor"
else
  WATERMARK_PY=""
fi

if [ -z "$GUARD_PY" ]; then
  MIGRATION_GUARD_RESULT="skipped_no_guard"  log "UYARI: migration muhafizi ATLANDI — migration_guard.py bulunamadi"
elif [ -z "$PREV_DEPLOYED" ]; then
  MIGRATION_GUARD_RESULT="skipped_no_baseline"
  log "UYARI: migration muhafizi ATLANDI — karsilastirma tabani yok (.deployed-commit bos)"
elif ! git cat-file -e "$PREV_DEPLOYED^{commit}" 2>/dev/null; then
  MIGRATION_GUARD_RESULT="skipped_unknown_baseline"
  log "UYARI: migration muhafizi ATLANDI — $PREV_DEPLOYED bu checkout'ta yok"
elif [ "$ALLOW_MIGRATIONS" = "1" ]; then
  MIGRATION_GUARD_RESULT="approved"
  log "migration muhafizi: --allow-migrations verildi (yikici SQL onaylandi)"
  python3 "$GUARD_PY" diff \
    --repo "$PROJECT_DIR" --base "$PREV_DEPLOYED" --target "$TARGET_FULL" || true
else
  set +e
  python3 "$GUARD_PY" diff \
    --repo "$PROJECT_DIR" --base "$PREV_DEPLOYED" --target "$TARGET_FULL"
  MIGRATION_GUARD_EXIT=$?
  set -e
  case "$MIGRATION_GUARD_EXIT" in
    0)
      MIGRATION_GUARD_RESULT="clean"
      log "migration muhafizi GECTI: $PREV_DEPLOYED..$TARGET_FULL yikici SQL eklemiyor"
      ;;
    3) die "deploy araligi YIKICI migration satiri ekliyor (yukarida). Acik onay icin --allow-migrations verin. Hicbir container calistirilmadi, canli sistem etkilenmedi." ;;
    *) die "migration muhafizi calistirilamadi (exit $MIGRATION_GUARD_EXIT)" ;;
  esac
fi

if [ "$DRY_RUN" = "1" ]; then
  log "PLAN: normalize -> build -> adacik saglik -> cutover -> dogrula (degisiklik yapilmadi)"
  log "hedef: $TARGET_FULL"
  log "cutover servisleri: ${CUTOVER_SERVICES[*]}"
  log "ek adimlar: db sayim+sema tabani, adacik IZOLE DB kopyasi, adacik logu, adacik sonrasi sayim karsilastirmasi"
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
# 0b. VERI TABANI TABANI — herhangi bir container kalkmadan ONCE
# ---------------------------------------------------------------------------
# Adacik container ayni veritabanina yazacagi icin, "once" degerinin adacik
# kalkmadan once alinmis olmasi SART. Sayim + sema parmak izi burada sabitlenir.
DB_COUNTS_BEFORE="$(db_counts)"
printf '%s\n' "$DB_COUNTS_BEFORE" > "$RELEASE_DIR/db-counts-before.txt"
MSG_WM_BEFORE="$(db_message_watermark)"
printf '%s\n' "$MSG_WM_BEFORE" > "$RELEASE_DIR/message-watermark-before.txt"
# Iliski ozeti: cutover oncesi sohbet->mesaj dagilimi (kimlik/iliskinin kaydi).
db_relation_digest "" > "$RELEASE_DIR/relations-before.txt"
schema_fingerprint > "$RELEASE_DIR/schema-before.txt"
SCHEMA_BEFORE_HASH="$(sha256sum "$RELEASE_DIR/schema-before.txt" | cut -d' ' -f1)"
log "db tabani: counts=${DB_COUNTS_BEFORE} filigran=${MSG_WM_BEFORE} sema=${SCHEMA_BEFORE_HASH:0:12}"

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
elif [ "$NO_GATEWAY" = "1" ]; then
  log "imaj build ediliyor (yalnizca backend; --no-gateway, canli sistem calisiyor)"
  docker compose -f "$COMPOSE_FILE" build "$BACKEND_SERVICE"
else
  log "imajlar build ediliyor (canli sistem bu sirada calisiyor)"
  docker compose -f "$COMPOSE_FILE" build "$BACKEND_SERVICE" "$GATEWAY_SERVICE"
fi
NEW_BACKEND_DIGEST="$(docker image inspect tezlify-backend:latest --format '{{.Id}}')"
NEW_GATEWAY_DIGEST="$(docker image inspect tezlify-gateway:latest --format '{{.Id}}')"
log "yeni backend imaj: $NEW_BACKEND_DIGEST"
if [ "$NO_GATEWAY" = "1" ]; then
  log "gateway imaj: DOKUNULMADI (yayindaki: $NEW_GATEWAY_DIGEST)"
else
  log "yeni gateway imaj: $NEW_GATEWAY_DIGEST"
fi

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

# --- IZOLASYON: adacik uretim DB'sine YAZAMAZ ------------------------------
# Bu blok olmadan adacik, uretimin tam kopyasi olan bir veritabaninda startup
# migration zincirini kosar ve yikici bir migration'i cutover kararindan ONCE
# uygular. Kanit tek bir seye dayanmaz: (1) env'deki DATABASE_URL kopyaya
# cevrilir, (2) uretim DB adinin env'de kalmadigi grep ile dogrulanir,
# (3) adacik penceresi boyunca uretim sayim/filigraninin DEGISMEDIGI olculur.
CANDIDATE_DB="${DB_NAME}_cand_${TS}"
[ -n "$CANDIDATE_DB_URL_PY" ] \
  || die "candidate_db_url.py bulunamadi; adacik izolasyonu KANITLANAMAZ (cutover yapilmadi)"
[ -n "$WATERMARK_PY" ] \
  || die "message_watermark.py bulunamadi; veri kaybi OLCULEMEZ (cutover yapilmadi)"
candidate_db_create "$CANDIDATE_DB" "$DB_NAME" \
  || die "izole aday veritabani kurulamadi; adacik uretim DB'sine karsi kosmayacak (cutover yapilmadi)"
candidate_env_isolate "$CANDIDATE_ENV_FILE" "$CANDIDATE_DB" \
  || die "adacik DATABASE_URL'i izole kopyaya cevrilemedi; uretim DB'sine dokunma riski (cutover yapilmadi)"
if grep -Eq "DATABASE_URL=.*/${DB_NAME}(\\?|$)" "$CANDIDATE_ENV_FILE"; then
  die "adacik env'inde uretim DATABASE_URL kaldi; izolasyon kanitlanamadi (cutover yapilmadi)"
fi
printf '%s\n' "$CANDIDATE_DB" > "$RELEASE_DIR/candidate-db.txt"
grep '^DATABASE_URL=' "$CANDIDATE_ENV_FILE" | sed 's#://[^@]*@#://***@#' \
  > "$RELEASE_DIR/candidate-db-url.txt" || true
CAND_DB_BEFORE="$(db_counts_for "$CANDIDATE_DB")"
printf '%s\n' "$CAND_DB_BEFORE" > "$RELEASE_DIR/candidate-db-counts-before.txt"
log "adacik IZOLE DB: $CANDIDATE_DB — uretim '$DB_NAME'e DOKUNULMUYOR (kopya sayimi=${CAND_DB_BEFORE})"

docker run -d --name "$CANDIDATE_NAME" \
  --network "$NETWORK" \
  --env-file "$CANDIDATE_ENV_FILE" \
  -e PORT=8001 \
  -e GATEWAY_ENCRYPTION_KEY= \
  -e SKIP_JOB_RECOVERY=true \
  -e WHATSAPP_GATEWAY_URL="http://gateway:8787" \
  tezlify-backend:latest >/dev/null

CANDIDATE_LOG="$RELEASE_DIR/candidate.log"
# `set -u` karsisinda guvenli varsayilan: release.json yazan blok bu degiskeni
# kosulsuz okur. Basarisiz dal `die` ettigi icin normalde hep "ok" olur, ama
# ileride bir refactor bu varsayimi sessizce bozmasin.
CANDIDATE_HEALTH="unknown"
if wait_healthy "$CANDIDATE_NAME" 8001 "$HEALTH_TIMEOUT"; then
  log "adacik SAGLIKLI — yeni imaj boot etti, migration'lar gecti"
  capture_candidate_log "$CANDIDATE_NAME" "$CANDIDATE_LOG"
  docker logs --tail 12 "$CANDIDATE_NAME" 2>&1 | sed 's/^/    /' || true
  docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  CANDIDATE_HEALTH="ok"
else
  log "adacik saglik kontrolu BASARISIZ — canli sisteme DOKUNULMADI"
  # Log KURTARILIR, sonra container silinir: basarisiz bir boot'un nedeni
  # container'la birlikte yok olmamali.
  capture_candidate_log "$CANDIDATE_NAME" "$CANDIDATE_LOG"
  docker logs --tail 80 "$CANDIDATE_NAME" 2>&1 | sed 's/^/    /' || true
  docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true
  die "yeni imaj /health vermedi; eski container hala calisiyor (log: $CANDIDATE_LOG)"
fi

# ---------------------------------------------------------------------------
# 3b. ADACIK PENCERESINDE URETIM VERISI DEGISTI MI?
# ---------------------------------------------------------------------------
# Adacik artik izole kopyada kostugu icin bu olcumun anlami DEGISTI ve daha
# guclendi: uretim sayiminda/filigraninda gorulen HER degisiklik ya canli
# trafiktir (artis) ya da IZOLASYON KUSURUDUR (azalma). Yani bu blok hem
# "migration ne sildi" hem de "adacik uretime dokundu mu" sorusunu cevaplar.
#
# Kopyanin kendi sayimi ayrica tutulur: yikici bir migration'in gercek sekilli
# veride NE silcegini gosterir — uretimde degil, atilabilir kopyada.
CAND_DB_AFTER="$(db_counts_for "$CANDIDATE_DB")"
printf '%s\n' "$CAND_DB_AFTER" > "$RELEASE_DIR/candidate-db-counts-after.txt"
CLONE_DROPS="$(counts_dropped "$CAND_DB_BEFORE" "$CAND_DB_AFTER")"
if [ -n "$CLONE_DROPS" ]; then
  printf '%s\n' "$CLONE_DROPS" > "$RELEASE_DIR/candidate-clone-drop.txt"
  log "BILGI: migration IZOLE KOPYADA satir sildi (uretim ETKILENMEDI):"
  printf '%s\n' "$CLONE_DROPS" | sed 's/^/    /'
  if [ -n "$GUARD_PY" ]; then
    python3 "$GUARD_PY" log --file "$CANDIDATE_LOG" 2>&1 | sed 's/^/    /' || true
  fi
else
  log "izole kopyada satir sayisi degismedi: $CAND_DB_AFTER"
fi
candidate_db_drop "$CANDIDATE_DB"
CANDIDATE_DB=""

# Iliski ozeti (kanit): esik oncesi mesajlarin sohbetlere dagilimi. Kayip
# karari filigranda; burada "hangi sohbet" sorusunun cevabi saklanir.
db_relation_digest "${MSG_WM_BEFORE%%|*}" > "$RELEASE_DIR/relations-after-candidate.txt"
if ! diff -q "$RELEASE_DIR/relations-before.txt" "$RELEASE_DIR/relations-after-candidate.txt" >/dev/null 2>&1; then
  diff "$RELEASE_DIR/relations-before.txt" "$RELEASE_DIR/relations-after-candidate.txt" \
    > "$RELEASE_DIR/relations-diff.txt" 2>&1 || true
  log "BILGI: sohbet bazinda mesaj dagilimi degisti (kanit: relations-diff.txt) — karar filigrana aittir"
fi

DB_COUNTS_AFTER_CANDIDATE="$(db_counts)"
printf '%s\n' "$DB_COUNTS_AFTER_CANDIDATE" > "$RELEASE_DIR/db-counts-after-candidate.txt"
CANDIDATE_DROPS="$(counts_dropped "$DB_COUNTS_BEFORE" "$DB_COUNTS_AFTER_CANDIDATE")"
# Filigran kontrolu ONCE gelir: toplam sayim degismemis olsa bile (silinen
# kadar yeni mesaj geldiyse) kaybi yakalayan tek olcu budur.
CANDIDATE_LOST="$(messages_lost_since "$MSG_WM_BEFORE" "$(db_messages_upto "${MSG_WM_BEFORE%%|*}")")"
if [ -n "$CANDIDATE_LOST" ]; then
  printf '%s\n' "$CANDIDATE_LOST" > "$RELEASE_DIR/candidate-messages-lost.txt"
  log "HATA: adacik penceresinde URETIMDE onceden var olan mesaj kayboldu:"
  printf '%s\n' "$CANDIDATE_LOST" | sed 's/^/    /'
  # Adacik izole kopyada kostugu icin bu artik "onaylanmis migration" degil,
  # IZOLASYON IHLALIDIR. --allow-migrations bunu gecemez.
  die "adacik izole olmasina ragmen uretimde mesaj kayboldu; CUTOVER YAPILMADI. Kanit: $RELEASE_DIR"
fi
if [ -n "$CANDIDATE_DROPS" ]; then
  printf '%s\n' "$CANDIDATE_DROPS" > "$RELEASE_DIR/candidate-data-drop.txt"
  log "HATA: adacik izole olmasina ragmen URETIMDE satir sayisi dustu:"
  printf '%s\n' "$CANDIDATE_DROPS" | sed 's/^/    /'
  if [ -n "$GUARD_PY" ]; then
    python3 "$GUARD_PY" log --file "$CANDIDATE_LOG" 2>&1 | sed 's/^/    /' || true
  fi
  die "adacik izolasyonu kanitlanamadi (uretim verisi azaldi); CUTOVER YAPILMADI. Kanit: $RELEASE_DIR"
else
  log "adacik penceresinde uretim satir sayisi degismedi: $DB_COUNTS_AFTER_CANDIDATE (izolasyon kaniti)"
fi

# Adacigin GERCEKTEN calistirdigi migration setini kayda gecir. "Imaj boot etti"
# tek basina "hangi migration kostu" sorusunu cevaplamaz; bu dosya cevaplar.
MIGRATION_LINES=0
if [ -f "$CANDIDATE_LOG" ]; then
  MIGRATION_LINES="$(grep -c '\[MIGRATION\]' "$CANDIDATE_LOG" 2>/dev/null || true)"
  MIGRATION_LINES="${MIGRATION_LINES:-0}"
  grep '\[MIGRATION\]' "$CANDIDATE_LOG" > "$RELEASE_DIR/migration-summary.txt" 2>/dev/null || true
  log "adacikta kosan migration satiri: $MIGRATION_LINES (kanit: migration-summary.txt)"
fi

# ---------------------------------------------------------------------------
# 4. CUTOVER — adacik saglikli olduktan SONRA trafik cevrilir
# ---------------------------------------------------------------------------
CUTOVER=1
# `--force-recreate` SART: compose bir container'i "guncel" sayip recreate
# etmediginde yeni imaj canliya hic oturmaz ve surum kaydi olmayan bir imaji
# ---------------------------------------------------------------------------
# 4. CUTOVER — eski container'lari durdur, yenileri ayaga kaldir
# ---------------------------------------------------------------------------
DEPLOY_FLAG="/opt/tezlify/runtime/deploy_in_progress"
mkdir -p /opt/tezlify/runtime
touch "$DEPLOY_FLAG"

log "cutover: compose up -d --force-recreate ${CUTOVER_SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" up -d --force-recreate "${CUTOVER_SERVICES[@]}"
if ! wait_healthy tezlify-backend 8000 180; then
  rm -f "$DEPLOY_FLAG"
  die "yeni backend 180 sn icinde saglikli olmadi"
fi
rm -f "$DEPLOY_FLAG"
log "yeni backend saglikli"

# Cutover'in gercekten YENI imaji calistirdigini kanitla: imaj kimligi
# kayittaki ile ayni degilse "deploy oldu" demek yanlis olur.
LIVE_BACKEND_IMAGE="$(docker inspect "tezlify-$BACKEND_SERVICE" --format '{{.Image}}')"
LIVE_GATEWAY_IMAGE="$(docker inspect "tezlify-$GATEWAY_SERVICE" --format '{{.Image}}')"
if [ "$LIVE_BACKEND_IMAGE" != "$NEW_BACKEND_DIGEST" ]; then
  die "cutover sonrasi backend yeni imajda degil (canli=${LIVE_BACKEND_IMAGE:0:12} beklenen=${NEW_BACKEND_DIGEST:0:12})"
fi
if [ "$NO_GATEWAY" = "1" ]; then
  # Gateway'e dokunulmadi: imajin AYNI kaldigini dogrulamak, "yenilendi" demekten
  # daha anlamli — degismisse bu mod yanlis kullanilmis demektir.
  if [ "$LIVE_GATEWAY_IMAGE" != "$PREV_GATEWAY_IMAGE" ]; then
    die "--no-gateway verildi ama gateway imaji degisti (canli=${LIVE_GATEWAY_IMAGE:0:12} onceki=${PREV_GATEWAY_IMAGE:0:12})"
  fi
  log "cutover dogrulandi: backend=${LIVE_BACKEND_IMAGE:0:12} gateway=DEGISMEDI (${LIVE_GATEWAY_IMAGE:0:12})"
else
  if [ "$LIVE_GATEWAY_IMAGE" != "$NEW_GATEWAY_DIGEST" ]; then
    die "cutover sonrasi gateway yeni imajda degil (canli=${LIVE_GATEWAY_IMAGE:0:12} beklenen=${NEW_GATEWAY_DIGEST:0:12})"
  fi
  log "cutover dogrulandi: backend=${LIVE_BACKEND_IMAGE:0:12} gateway=${LIVE_GATEWAY_IMAGE:0:12}"
fi

# ---------------------------------------------------------------------------
# 4b. CUTOVER SONRASI VERI/SEMA KONTROLU — SALT OKUNUR
# ---------------------------------------------------------------------------
# Sema parmak izi (kolon+indeks) cutover oncesi alinanla karsilastirilir: bir
# migration'in yaptigi HER yapisal degisiklik burada gorunur. Beklenmeyen bir
# fark otomatik "onarilmaz" — yalnizca kayda gecer ve uyarir; sema degisiminin
# dogru olup olmadigina dair karar bir domain kararidir.
DB_COUNTS_AFTER="$(db_counts)"
printf '%s\n' "$DB_COUNTS_AFTER" > "$RELEASE_DIR/db-counts-after.txt"
schema_fingerprint > "$RELEASE_DIR/schema-after.txt"
SCHEMA_AFTER_HASH="$(sha256sum "$RELEASE_DIR/schema-after.txt" | cut -d' ' -f1)"
SCHEMA_CHANGED=false
if [ "$SCHEMA_BEFORE_HASH" != "$SCHEMA_AFTER_HASH" ]; then
  SCHEMA_CHANGED=true
  diff -u "$RELEASE_DIR/schema-before.txt" "$RELEASE_DIR/schema-after.txt" \
    > "$RELEASE_DIR/schema.diff" 2>&1 || true
  log "UYARI: veritabani SEMASI degisti (${SCHEMA_BEFORE_HASH:0:12} -> ${SCHEMA_AFTER_HASH:0:12}); kanit: $RELEASE_DIR/schema.diff"
  sed -n '1,20p' "$RELEASE_DIR/schema.diff" | sed 's/^/    /' || true
else
  log "sema degismedi (${SCHEMA_BEFORE_HASH:0:12})"
fi
CUTOVER_DROPS="$(counts_dropped "$DB_COUNTS_AFTER_CANDIDATE" "$DB_COUNTS_AFTER")"
# Cutover artik gerceklesti: burada durdurmak yerine KANIT birakilir (release.json
# ve ayni dizindeki dosyalar). Filigran, yeni gelen mesajlarin gizleyebilecegi
# kaybi da yakalar.
CUTOVER_LOST="$(messages_lost_since "$MSG_WM_BEFORE" "$(db_messages_upto "${MSG_WM_BEFORE%%|*}")")"
if [ -n "$CUTOVER_LOST" ]; then
  printf '%s\n' "$CUTOVER_LOST" > "$RELEASE_DIR/cutover-messages-lost.txt"
  log "UYARI: cutover sonrasi ONCEDEN VAR OLAN mesaj kayboldu:"
  printf '%s\n' "$CUTOVER_LOST" | sed 's/^/    /'
fi
if [ -n "$CUTOVER_DROPS" ]; then
  printf '%s\n' "$CUTOVER_DROPS" > "$RELEASE_DIR/cutover-data-drop.txt"
  log "UYARI: cutover sonrasi satir sayisi dustu:"
  printf '%s\n' "$CUTOVER_DROPS" | sed 's/^/    /'
else
  log "cutover sonrasi satir sayisi degismedi: $DB_COUNTS_AFTER"
fi

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
  # Onceki frontend yedeklerini dondur (en son 3'u tutulur, eskiler temizlenir)
  ls -1dt "$FRONTEND_DIR.prev-"* 2>/dev/null | tail -n +4 | xargs -r rm -rf || true
fi

# Caddyfile ve observer guncellemesi
if [ -f "$PROJECT_DIR/Caddyfile" ]; then
  docker exec tezlify-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
fi
if [ -f "$PROJECT_DIR/scripts/whatsapp_reliability_collector.py" ]; then
  python3 "$PROJECT_DIR/scripts/whatsapp_reliability_collector.py" >/dev/null 2>&1 || true
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
if [ "$NO_GATEWAY" = "1" ]; then
  log "gateway blob dogrulamasi atlandi (--no-gateway: gateway yeniden olusturulmadi)"
else
  verify_blob tezlify-gateway "/app/src/session-manager.js" "whatsapp-gateway/src/session-manager.js"
fi

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
if [ "$NO_GATEWAY" = "1" ]; then GATEWAY_TOUCHED_JSON="false"; else GATEWAY_TOUCHED_JSON="true"; fi
if [ -n "$CANDIDATE_DROPS" ]; then CANDIDATE_DROP_JSON="true"; else CANDIDATE_DROP_JSON="false"; fi
if [ -n "$CUTOVER_DROPS" ]; then CUTOVER_DROP_JSON="true"; else CUTOVER_DROP_JSON="false"; fi
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
  "gateway_touched": $GATEWAY_TOUCHED_JSON,
  "rollback_tags": {"backend": "tezlify-backend:pre-$TS", "gateway": "tezlify-gateway:pre-$TS"},
  "frontend": $FRONTEND_JSON,
  "migrations": {
    "approval": "$MIGRATION_GUARD_RESULT",
    "candidate_health": "$CANDIDATE_HEALTH",
    "candidate_log": "candidate.log",
    "migration_lines": $MIGRATION_LINES,
    "counts_before": "$DB_COUNTS_BEFORE",
    "counts_after_candidate": "$DB_COUNTS_AFTER_CANDIDATE",
    "counts_after_cutover": "$DB_COUNTS_AFTER",
    "dropped_during_candidate": $CANDIDATE_DROP_JSON,
    "dropped_during_cutover": $CUTOVER_DROP_JSON,
    "schema_changed": $SCHEMA_CHANGED,
    "schema_fingerprint": {"before": "${SCHEMA_BEFORE_HASH:0:12}", "after": "${SCHEMA_AFTER_HASH:0:12}"}
  }
}
JSON
# .deployed-commit EN SON yazilir: yukarisi patlarsa dosya eski SHA'yi gostermeye
# devam eder (ilk denemede bu dosya coktan yazilmisti ve geri almaya ragmen
# yeni SHA'yi gosteriyordu).
printf '%s\n' "$TARGET_FULL" > "$PROJECT_DIR/.deployed-commit"

log "SURUM TAMAM: $(git rev-parse --short "$TARGET_FULL") — $(git log -1 --format=%s "$TARGET_FULL")"
log "kayit: $RELEASE_DIR/release.json"
log "geri donus: bash scripts/deploy/host-release.sh --rollback-to $TS  (etiketler: tezlify-backend:pre-$TS)"
