# TEZLIFY WHATSAPP — AŞAMA 3.7: KONTROLLÜ MESAJ KALICILIĞI VE BACKEND-ONLY RELEASE

**Tarih:** 2026-10-28 (20:20–21:00 GMT+3)
**Mod:** KODLAMA + ALTYAPI
**Öncelik:** P0 — RAM'deki mesajları kayıpsız kalıcılaştırma
**Başlangıç üretim commit'i:** `b5715fe90d0ff05ef497dcccbc87652efa10ccd1`
**Deploy:** **YAPILMADI** — bu aşama yalnızca doğrulanmış bir release yolu hazırlar.

> **Aşamanın başarı kriteri deploy etmek değil**, 7336 mesajı güvenli biçimde
> kalıcılaştırabilecek, gateway'e dokunmayan ve açık onayla yürütülebilen bir
> release yolu hazırlamaktı. Bu rapor o yolun kanıtıdır.

---

## §0 — KANIT SEVİYESİ LEJANDI

| Etiket | Anlamı |
| --- | --- |
| **[K]** | Kod doğrulaması — kaynak okundu, satır düzeyinde gösterildi |
| **[T]** | İzole test doğrulaması — temiz test DB'sinde koşturuldu, çıktı kayıtlı |
| **[P]** | Üretim salt-okunur gözlemi — hiçbir yazma yapılmadı |
| **[D]** | Gerçek cihaz E2E — **bu aşamada yok** |
| **[B]** | BLOCKED — kanıt yok, tahmin de yok |

---

## §1 — BAŞLANGIÇ DURUMU (bağımsız doğrulama)

### 1.1 Repo [K]

| Öğe | Değer |
| --- | --- |
| Branch | `main` |
| Başlangıç `HEAD` | `25989cb` |
| Başlangıç `origin/main` | `25989cb` (eşit) |
| Çalışma ağacı | temiz |
| **Üretimde çalışan** | **`b5715fe`** |

Aşama 3.6b'nin beş commit'i (`9ec13b6`, `0d909ab`, `d56abc6`, `baa4db2`, `25989cb`)
`git merge-base --is-ancestor` ile **tek tek** doğrulandı: hepsi `origin/main` üzerinde. [K]

### 1.2 Konteynerler — ÖNCE [P]

| Konteyner | ID | StartedAt | Durum |
| --- | --- | --- | --- |
| `tezlify-backend` | `579085f13268…` | `2026-10-27T22:25:45Z` | running |
| `tezlify-gateway` | `5b867095d376…` | `2026-10-27T17:25:57Z` | running |
| `tezlify-db` | `f6d79c4a1f8b…` | `2026-10-01T17:45:08Z` | running |
| `tezlify-caddy` | `ee66a5cab371…` | `2026-10-12T13:12:45Z` | running |

### 1.3 Oturum ve sayaçlar — ÖNCE [P]

| Öğe | Değer |
| --- | --- |
| WhatsApp oturumu | `201` · **`CONNECTED`** · `is_active=t` · `is_phone_online=t` |
| Gateway UUID | `1bd78836-c084-4cbf-b333-9386d44b7bd7` |
| Sohbet / mesaj / max ID | 125 / 1786 / 161031 |
| Kişi | 1537 |
| **`conv 38346`** | **4 mesaj — değişmedi** |
| `event_outbox` | `DELIVERED: 3965` (dead-letter yok) |

### 1.4 RAM/DB farkı — `perChatLimit=2000` ile yeniden sayıldı [P]

`scripts/diagnostics/audit_memory_gap.py` (bu aşamada yazıldı, salt-okunur)
üretimde backend konteyneri içinde çalıştırıldı:

| Ölçüm | Değer |
| --- | --- |
| Gateway RAM (dönen = bildirilen) | **9122** |
| RAM geçerli kimlikli / benzersiz | **9122 / 9122** → 0 kopya |
| RAM kimliksiz satır | **0** |
| DB toplam | **1786** |
| DB'de olup RAM'de **doğru sohbette** bulunan | **1786** (DB ⊆ RAM, tam) |
| Başka sohbette / başka kiracıda / eşlenemeyen JID | **0 / 0 / 0** |
| **Gerçekten DB'de yok** | **7336** — **40 sohbet** |
| Eksiklerde geçersiz zaman damgası / gönderici | **0 / 0** |

**Kapanış kontrolü:** 1786 + 7336 = **9122** ✓ (RAM'in tamamı açıklanıyor).

### 1.5 `conv 38346` hakkında dürüst ifade

Gateway RAM'i ile DB **birebir aynı 4 mesajı** tutuyor. Yani eksik geçmiş bir
kalıcılık kaybı değil: telefon o mesajları hiç göndermemiş. **Bu aşamada da
kurtarılmadı ve kurtarıldı diye raporlanmıyor.** [P]

---

## §2 — BACKEND-ONLY RELEASE ENGELİNİN ÇÖZÜMÜ

### 2.1 Engel neydi [K]

`scripts/deploy/host-release.sh` satır 477–489:

```bash
if [ "$NO_GATEWAY" = "1" ]; then
  ...
  if ! git diff --quiet "$PREV_DEPLOYED" "$TARGET_FULL" -- \
      whatsapp-gateway/ "$COMPOSE_FILE" docker-compose.yml; then
    die "--no-gateway kullanilamaz: gateway/compose degismis (bayragi kaldirin)"
  fi
```

Yani `--no-gateway`, **yayındaki commit ile hedef commit arasında** gateway
ağacına dokunulmuşsa reddediyor. `b5715fe..main` aralığında **8 gateway dosyası**
değiştiği için backend-only deploy imkânsızdı.

### 2.2 Neden muhafız zayıflatılmadı

Muhafız doğru davranıyor: kaldırılsaydı "deploy başarılı görünür, gateway kodu
eski kalır" — yanlış yönde başarısız olan sessiz bir hata sınıfı. Bu yüzden
`host-release.sh` **hiç değiştirilmedi** (`git diff` boş).

### 2.3 Çözüm: koşulu gerçekten sağlayan bir release ref'i

```
release ref ağacı = main'in ağacı, `whatsapp-gateway/` b5715fe'deki hâliyle
```

`release/backend-only-3.7` (SHA: `git rev-parse release/backend-only-3.7`).
Doğrulamalar [K]:

| Doğrulama | Komut | Sonuç |
| --- | --- | --- |
| Muhafızın **birebir** komutu | `git diff --quiet b5715fe release/backend-only-3.7 -- whatsapp-gateway/ docker-compose.prod.yml docker-compose.yml` | **exit 0** → muhafız geçer |
| Ağaç değişmezi | `git diff --stat release/backend-only-3.7 main -- . ':(exclude)whatsapp-gateway'` | **boş** → birebir aynı |
| Backend içeriği | `git diff --name-only b5715fe release/backend-only-3.7 -- backend/` | **10 dosya** |
| Ön-kontrol betiği | `backend_only_release.py --base b5715fe --target release/backend-only-3.7` | **GÜVENLİ**, exit 0 |

Backend paketinde olması gereken her şey var [K]:

```
backend/app/core/config.py                                  <- flag + varsayılan
backend/app/main.py                                         <- lifespan + /health
backend/app/services/whatsapp/memory_persistence.py          <- süpürme
backend/app/services/whatsapp/orchestration/sync.py          <- request_id
backend/app/services/whatsapp_gateway.py                     <- istemci
backend/tests/conftest.py                                    <- fail-closed DB kapısı
+ 4 test dosyası
```

### 2.4 Kontrat uyumu — deployed gateway `b5715fe` üzerinde [K]

| Kontrat | Deployed gateway'de | Sonuç |
| --- | --- | --- |
| `perChatLimit` (süpürmenin ihtiyacı) | **destekliyor** (`index.js:564`, `session-manager.js:1162`) | sohbet başına 2000 görülebilir → süpürme doğru çalışır |
| `request_id` (yeni, opsiyonel) | **okunmuyor** → bilinmeyen query param | yok sayılır, hata vermez → geriye dönük uyumlu |

> Bu kontrol kritikti: eğer `perChatLimit` deployed gateway'de olmasaydı,
> süpürme sessizce sohbet başına 50 mesaj görür ve **7336 mesajın çoğunu
> kalıcılaştırmazdı** — üstelik hiçbir hata vermeden.

### 2.5 Yeni ön-kontrol betiği [T]

`scripts/deploy/backend_only_release.py` — **18 test**.

Üç ihlali ayrı ayrı raporlar:
1. gateway/compose değişmiş → muhafız reddeder,
2. backend `main`'den farklı → release ref düzeltmeyi taşımıyor (sessiz gerileme),
3. backend base'den farksız → dağıtılacak bir şey yok.

Betik **hiçbir şey deploy etmez**, DB/ağa dokunmaz; yalnızca `git diff` okur.
Yapısal olarak pinlendi: DB/ağ istemcisi import etmiyor, `host-release.sh`
yazmıyor, muhafız metni hâlâ yerinde.

**Gerçek depoda kanıt:** `main` hedef gösterildiğinde betik **reddediyor**
(8 gateway dosyası); release ref gösterildiğinde **geçiyor**.

---

## §3 — KONTROLLÜ İLK KALICILIK TURU (RUNBOOK)

> **Kural:** her adım AYRI ve AÇIK onay gerektirir. `dry_run` sonucu
> **otomatik olarak** gerçek yazmaya dönüşmez. Sayaçlar kanıt sayılmaz —
> doğrulama **mesaj kimliği** üzerinden yapılır.

### Adım 0 — Ön koşul (onay yok, salt okunur)

```bash
python scripts/deploy/backend_only_release.py \
  --base "$(cat .deployed-commit)" \
  --target release/backend-only-3.7 --backend-from main
```

`SONUC: GUVENLI` görmelisin. Görmüyorsan **dur**.

### Adım 1 — Backend'i gateway'e dokunmadan devreye al 【ONAY 1】

```bash
bash scripts/deploy/host-release.sh release/backend-only-3.7 --no-gateway
```

**Deploy öncesi zorunlu:** servise `WHATSAPP_MEMORY_PERSIST_ENABLED=false`
verilmelidir. Varsayılan **`True`** ve üretimde bu değişken **tanımlı değil** [P]
— yani flag verilmezse süpürme açılıştan **~90 sn** sonra kendiliğinden başlar.
Kontrollü ilk tur isteniyorsa bu yapılmamalıdır.

Kabul: cutover doğrulaması `gateway=DEGISMEDI` demeli; gateway `StartedAt`
değişmemeli.

### Adım 2 — Health ve gateway bağlantı uyumu 【ONAY 1'in parçası】

```bash
docker exec tezlify-backend python -c "import urllib.request,json;print(json.load(urllib.request.urlopen('http://127.0.0.1:8000/health'))['whatsapp_memory_persistence'])"
```

Beklenen: `enabled: false`, `runs: 0`, `last_error: null`, `cursor_count: 0`.
Ayrıca `docker inspect tezlify-gateway --format '{{.State.StartedAt}}'`
**değişmemiş** olmalı.

### Adım 3 — `dry_run` turu 【ONAY 2】

```bash
docker exec tezlify-backend python -c "
import asyncio
from backend.app.services.whatsapp.memory_persistence import run_memory_persistence_once
print(asyncio.run(run_memory_persistence_once(dry_run=True)))"
```

**Zorunlu gözlem:** DB'deki `messages` sayısı **değişmemeli** ve
`/health.memory_persistence.max_cursor_offset` **0 kalmalı**.
(`dry_run` imleci ilerletmez — testle kilitli [T].)

### Adım 4 — Sayıları OKU, kanıt sayma 【onay yok】

Beklenen büyüklükler (2026-10-28 ölçümü):

| Metrik | Beklenen | Not |
| --- | --- | --- |
| `last_scanned` | ≈ **9122** | gateway'in tamamı |
| `last_pages` | ≈ **19** | 9122 / 500 |
| `last_inserted` | ≈ **7336** | **ama bu kanıt değildir** |
| `errors_total` | **0** | |
| `total_reported` | **9122** | gateway'in bildirdiği |

> `last_inserted` ile `7336` **eşit olmak zorunda değil**: arada canlı trafik
> gelir, `wa_message_id`'siz kayıtlar atlanır, eşlenemeyen JID olabilir.
> Gerçek doğrulama Adım 6'dadır.

### Adım 5 — Gerçek turu başlat 【ONAY 3】

Flag'i aç (yeniden başlatma **yok**; süreç içi durum `runs` sayacıyla izlenir)
veya elle tek tur çalıştır. Elle çalıştırma tercih edilir: otomatik döngü
ikinci turu 300 sn sonra kendisi başlatır.

### Adım 6 — KİMLİK üzerinden doğrula 【onay yok, salt okunur】

```bash
# önce (Adım 1'den ÖNCE alınmış olmalı)
docker exec -i tezlify-backend python - < scripts/diagnostics/audit_memory_gap.py \
  > gap-before.json
# sonra
docker exec -i tezlify-backend python - < scripts/diagnostics/audit_memory_gap.py \
  --compare gap-before.json
```

Kabul:
- `CLASS_genuinely_missing` **7336 → 0** (veya canlı trafik kadar küçük),
- `CLASS_present_other_tenant` = **0**,
- `ram_duplicate_id_rows` = **0**,
- `compare` çıkış kodu **0** (gerileme yok; artış olsaydı **3**).

`wa_message_id` tekilliği ve kiracı izolasyonu ayrıca DB'de doğrulanır:

```sql
SELECT count(*) FROM (SELECT conversation_id, wa_message_id FROM messages
  WHERE wa_message_id IS NOT NULL
  GROUP BY 1,2 HAVING count(*) > 1) d;          -- 0 olmalı
```

### Adım 7 — Gateway deploy'u HÂLÂ YASAK 【ONAY 4, ayrı karar】

Adım 6 temiz çıkmadan gateway **deploy edilmez, yeniden oluşturulmaz**.
Sıra: backend yazdı → kimlikle doğrulandı → **ancak şimdi** gateway
recreate'i veri kaybı değil.

---

## §4 — EK GÜVENLİK İNCELEMESİ

| Konu | Bulgu | Seviye |
| --- | --- | --- |
| **İmleç + eşzamanlı worker** | İki tur aynı `start_offset`'tan başlar → aynı sayfaları yazar; `(conversation_id, wa_message_id)` tekilliği kopyayı engeller. Boşa iş, veri hatası yok. | [K][T] |
| **İmleç + süreç yeniden başlatma** | İmleç süreç belleğinde; restart'ta 0'a döner → tam yeniden tarama, hepsi DB'de olduğu için **0 satır** ekler. Idempotent. | [K][T] |
| **Çift başlama** | `start.py` `uvicorn.run(app)` — **`workers=` yok** ⇒ tek süreç, tek lifespan, tek döngü. (İleride `workers=N` eklenirse N döngü olur: yine güvenli ama israf.) | [K] |
| **`wa_message_id` eksik** | Atlanır, `skipped_no_id` sayılır; kısmi tekillik indeksi NULL'da çakışmadığı için yazılsaydı her turda kopya üretirdi. | [T] |
| **Kısmi DB hatası** | Sayfa başına tek INSERT + `rollback()`; yarım sayfa kalmaz, sonraki tur eksiği tamamlar. | [T] |
| **Devre dışı hat / başka kiracı** | `status='CONNECTED' AND is_active` + `user_id`/`session_id` filtresi; LID takma adları yalnızca **bu** gateway'in `lid_mappings` satırlarından. | [T] |
| **DB kesintisi** | Gateway'e yalnızca `list_all_messages` (GET) gider; hiçbir mutasyon çağrısı yok. | [T] |
| **`/health` PII** | **GERÇEK KUSUR BULUNDU ve düzeltildi** — aşağıda §4.1. | [K][T] |
| **Deploy/rollback sırasında yarım kalma** | Döngü `CancelledError`'ı yeniden fırlatır; `lifespan` kapanışta görevi iptal eder; sayfa başına commit olduğu için iptal yarım sayfa bırakmaz. | [T] |

### 4.1 Bulunan gerçek kusur: `/health` SQL parametrelerini sızdırıyordu [K][T]

`last_error` doğrudan `/health`'te yayınlanıyor ve o uç **kimlik doğrulaması
istemiyor**. İçine `str(exc)` yazılıyordu. Bir SQLAlchemy `IntegrityError` /
`OperationalError` metni SQL ifadesini **ve bağlı parametreleri** taşır — yani
mesaj gövdesini, telefon numarasını, JID'i. Aynı metin `exc_info=True` ile
sunucu loglarına da düşüyordu.

**Kanıt:** önceki turda `assert "db down" in last_error` testi **geçiyordu**,
yani uç gerçekten ham istisna metnini döndürüyordu.

**Düzeltme:** `_safe_error()` yalnızca istisna **türünü** ve varsa SQLSTATE'i
döndürür (`IntegrityError(23505)`). `exc_info=True` kaldırıldı. Ayrıştırma
gerektiğinde hata izole ortamda yeniden üretilir — üretim verisini loglara
taşımak pahasına değil.

3 yeni test: SQL+parametre sızıntısı yok, SQLSTATE korunur, `/health` durumu
gateway UUID'si taşımaz (imleçler `cursor_count` / `max_cursor_offset` olarak
özetlenir).

### 4.2 Yeni salt-okunur doğrulama betiği [T]

`scripts/diagnostics/audit_memory_gap.py` — **19 test**.

- `classify()` **saf fonksiyon** (DB/ağ yok, her dal test edilebilir).
- Kimliksiz kayıt **"eksik" sayılmaz** (sınıflandırılamaz).
- Boş string kimlik **değildir** (tekillik indeksini atlar, kopya üretir).
- `--compare before.json` → gerileme kontrolü; `genuinely_missing` **artarsa**
  çıkış **3**.
- Mesaj içeriği, telefon, gövde **yazdırılmaz**.
- Salt-okunurluk yapısal olarak pinlendi (kaynakta `INSERT`/`UPDATE`/`DELETE`/
  `commit`/`add`/`flush` aranır).

---

## §5 — KAPILAR (gerçek exit code'lar)

### 5.1 Backend — dört tam koşum, her biri taze DB [T]

Her koşumdan **önce**: `rm -f /tmp/tezlify_clean.db && python scripts/provision_test_db.py`.
`DATABASE_URL=sqlite+aiosqlite:////tmp/tezlify_clean.db` **ve**
`TEST_DB_PATH=/tmp/tezlify_clean.db` birlikte verildi.

| Koşum | Sonuç | Süre | Exit |
| --- | --- | --- | --- |
| Sabit sıra (`-p no:randomly`) | **1839 passed, 4 skipped** | 163.59 s | **0** |
| Seed `424242` | **1839 passed, 4 skipped** | 135.33 s | **0** |
| Seed `777` | **1839 passed, 4 skipped** | 145.79 s | **0** |
| Seed `900913` | **1839 passed, 4 skipped** | 135.86 s | **0** |

Ek koşumlar:
- **Release ref `release/backend-only-3.7` üzerinde** tam koşum: **1839 passed, 4 skipped**, exit **0**
  → *dağıtılacak ağacın kendisi* yeşil.
- Yorum düzeltmesinden sonra `main`: **1839 passed, 4 skipped**, exit **0**.

**Test sayısı muhasebesi:** `1799` (3.6b sonu) → `1836` (+18 release betiği,
+19 fark betiği = **+37**) → `1839` (+3 PII testi). Her adımda artış tam
olarak eklenen test sayısı kadar; sapma yok.

**İzolasyon kanıtı:** dört logda `postgresql` / `130.162` / `tezlify-db`
referansı **0**. `conftest` uyuşmazlıkta fail-closed (`RuntimeError`).

### 5.2 Diğer kapılar

| Kapı | Sonuç | Exit |
| --- | --- | --- |
| Gateway `npm test` | 0 `FAIL`, `[test-history-diagnostics] PASS` | **0** |
| Frontend `npm run build` | `✓ built in 8.43s` | **0** |
| `verify:i18n-keys` | `PASS` | **0** |
| `verify:older-page-lock` | 9 checks | **0** |
| `verify:older-page-state` | 6 checks | **0** |
| `verify:message-timeout-budget` | 3 checks | **0** |
| `git diff --check` | temiz | **0** |
| `py_compile` (tüm değişen dosyalar) | OK | **0** |
| Secret taraması | `ogBuK5ha…`, private key, host IP, `+90…` **yok** | **0** |

---

## §6 — COMMIT / PUSH

| Commit | İçerik |
| --- | --- |
| `10bafbe` | `feat(deploy)` — backend-only release ön-kontrolü (+18 test) |
| `549de5c` | `feat(diagnostics)` — kimlik tabanlı RAM/DB fark betiği (+19 test) |
| `1ed6c43` | `fix(whatsapp)` — `/health` PII sızıntısı (+3 test) |
| `52658a4` | `docs(whatsapp)` — koddaki yanlış 7080 sayısının düzeltilmesi |
| *(ref)* | **`release/backend-only-3.7`** — dağıtılacak ref |

`main` ve `release/backend-only-3.7` **`origin`'e push edildi**. Deploy yapılmadı.

---

## §7 — KABUL TABLOSU

| # | Kriter | Durum | Kanıt |
| --- | --- | --- | --- |
| 1 | 7336 mesajı kalıcılaştırabilecek yol hazır | **PASS** | modül + 22 test [T]; kuyruk erişimi imleçle [T] |
| 2 | Gateway'e dokunmayan release yolu | **PASS** | `guard_exit=0`, ağaç değişmezi boş [K] |
| 3 | Muhafız zayıflatılmadı | **PASS** | `host-release.sh` diff boş; muhafız metni testle pinli [K][T] |
| 4 | Kontrat geriye dönük uyumlu | **PASS** | `perChatLimit` var, `request_id` yok sayılır [K] |
| 5 | Release paketi tam | **PASS** | 10 backend dosyası, 0 fark vs main [K] |
| 6 | Kontrollü ilk tur planı, her adım ayrı onay | **PASS** | §3 runbook |
| 7 | `dry_run` yazmaz, imleci ilerletmez | **PASS** | `test_dry_run_does_not_advance_the_cursor` [T] |
| 8 | Doğrulama sayaçla değil kimlikle | **PASS** | `audit_memory_gap.py` + `--compare` [T][P] |
| 9 | `/health` PII/UUID sızdırmaz | **PASS** | kusur bulundu ve düzeltildi [K][T] |
| 10 | İzole testler yeşil (sabit sıra + 3 seed) | **PASS** | 4 × 1839, exit 0 [T] |
| 11 | Üretim değişmedi | **PASS** | §1.2/§1.3 ile bitiş ölçümü aynı [P] |
| 12 | Gerçek cihaz E2E | **BLOCKED** | yetkili cihaz/hesap yok [B] |
| 13 | `conv 38346` geçmişi kurtarıldı | **FAIL (beklenen)** | telefon o mesajları hiç göndermemiş; kurtarılmadı ve öyle raporlanmıyor [P] |

**Özet: 11 PASS, 1 BLOCKED, 1 FAIL (kapsam dışı — 38346 kalıcılıkla ilgili değil).**

---

## §8 — AÇIK RİSKLER

1. **Deploy sırası hâlâ tek ölümcül risk.** Gateway backend'den önce
   oluşturulursa RAM'deki **7336** mesaj kalıcı olarak gider (A6).
2. **Flag varsayılanı `True`.** Deploy'da `..._ENABLED=false` verilmezse
   süpürme ~90 sn sonra kendiliğinden başlar. Runbook bunu zorunlu kılıyor
   ama **teknik olarak zorlanmıyor** — operatör disiplinine bağlı.
3. **Release ref `main`'den ayrık.** Backend-only deploy sonrası
   `.deployed-commit` = release ref SHA'sı olur; `main` ile arasında yalnızca gateway
   farkı kalır ve **gateway deploy'unda kapanır**. O ana kadar
   `--no-gateway` karşılaştırma tabanı bu ref'tir.
4. **`workers>1` eklenirse** N eşzamanlı döngü olur. Güvenli (tekillik) ama
   israf; `start.py` bugün tek süreç.
5. **PDO teşhis izleri üretimde yok** — gateway deploy'u yapılmadığı için
   `failure_class` hâlâ ölçülemiyor. Bu aşamanın kapsamı dışı.
6. **İlk turun yükü** 7336 insert / ~19 sayfa. Sayfa başına commit var ama
   ilk tur izlenmeli; DB bağlantı havuzu ve süre `last_duration_ms`'ten okunmalı.

---

## §9 — GERÇEK CİHAZ E2E İÇİN GEREKEN

Yetkili bir test WhatsApp hesabı (üretimden ayrı), telefonda 50+ mesajlı bir
sohbet, eski bir anchor ve gateway loglarına erişim. Bunlar sağlanmadan hiçbir
iddia [D] seviyesine yükseltilmeyecek.
