# Aşama 4.25 — Kontrollü Backend + Gateway Deployment Öncesi Son Güvenlik Kapısı

**Tarih:** 2026-11-01 00:51–01:05 +0300 (ölçüm anı: **2026-10-31T21:51:31Z**)
**Mod:** **READ-ONLY** production preflight. Deployment **YAPILMADI**. `release.sh` / `host-release.sh` **çalıştırılmadı**, container restart/recreate/rebuild **YOK**, DB'ye INSERT/UPDATE/DELETE/migration **YOK**, gateway RAM'ine müdahale **YOK**, loop/flag değişikliği **YOK**, commit/push/merge **YOK**, rollback denemesi **YOK**.
**Sonuç:** ✅ **READY FOR EXPLICIT DEPLOYMENT APPROVAL**

> **Tek cümle:** Veri güvenliği kanıtlandı (`RAM_ONLY = 0`, DB tutarlı, outbox'ta uçuşta olay yok); ancak **deploy betiğinin gateway RAM'i için hiçbir koruması yok** — bu yüzden deploy anında RAM_ONLY ölçümü **operatörün** sorumluluğundadır ve tekrar edilmelidir (K1).

---

## 0. Karar özeti

| Kriter | Durum |
| --- | --- |
| Remote SHA = `de1f1ad…` | ✅ |
| Tree = `9966f60…` | ✅ |
| Backend 4.7 + Gateway 4.17 birleşikte | ✅ |
| Deploy betiği ref'i işleyebiliyor | ✅ |
| `--no-gateway` kazası engelli | ✅ (muhafız reddediyor) |
| Production beklenen commit'te | ✅ `cbe4f509` |
| Container sağlıkları / restart | ✅ 4/4 healthy, RestartCount 0 |
| **RAM_ONLY = 0** | ✅ **0** |
| DB tutarlılığı | ✅ 0 null / 0 orphan / 0 duplikasyon |
| Outbox PENDING + IN_FLIGHT | ✅ **0** |
| Persistence loop kapalı | ✅ `config_enabled=false`, `runs=0` |
| Startup migration silme riski | ✅ 3 yol da **0 satır** |

**→ READY FOR EXPLICIT DEPLOYMENT APPROVAL** (koşullar §9'da)

---

## 1. Release doğrulaması

| Öğe | Beklenen | Gerçek | Sonuç |
| --- | --- | --- | --- |
| Remote branch | `refs/heads/release/whatsapp-combined-backend-4.7-gateway-4.17` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` | ✅ |
| SHA | `de1f1ad34f123a304f6b6432cd22a546ccafac36` | aynı | ✅ |
| Tree | `9966f6065ac03a6c192a5aaff66c33cfc48c405d` | aynı | ✅ |
| Ebeveynler | `2236cae` + `20c88bb` | aynı (sırayla) | ✅ |
| Host ref'i görebiliyor mu? | evet | `git ls-remote` (host'tan, salt-okunur) → `de1f1ad…`, RC=0 | ✅ |

### 1.1 İki release'in içeriği birleşikte mi?

| Dosya | Blob (git SHA1) | Kaynak |
| --- | --- | --- |
| `backend/app/services/whatsapp/memory_persistence.py` | `e12c030bd239c7b9099b7d0f4b02a6ab44a6aa7d` | 4.7 |
| `backend/app/services/whatsapp/orchestration/sync.py` | `213f736e976ff5db0b27e86f09361623e4158ffd` | 4.7 |
| `backend/app/services/whatsapp_gateway.py` | `2f44be2058c2686c6b0f7f16d241ac79b69b36ad` | 4.7 |
| `whatsapp-gateway/src/index.js` | `128b0bbb7679fcce391bf2012d7343d2cea1965b` | 4.17 |
| `whatsapp-gateway/src/messages/message-store.js` | `c5bef759693a4dc575dde9e7f9999543be1c8d1b` | 4.17 |
| `whatsapp-gateway/src/session-manager.js` | `b8676998a1ca8ae1083649007b7376d548dc7718` | 4.17 |
| `whatsapp-gateway/src/socket/socket-events.js` | `cd3a21cc497c66d4bfe2a50629c7aee7243763d9` | 4.17 |

Değişmeyenler (kritik): `backend/app/core/migrations.py` **IDENTICAL** (`0d232b70…`), `docker-compose.prod.yml` **IDENTICAL** (`0efa3e1d…`), `backend/app/core/config.py` **IDENTICAL** (persistence flag varsayılanı aynı).

### 1.2 Deploy betiği bu ref'i işleyebiliyor mu?

| Kontrol | Bulgu |
| --- | --- |
| Hedef çözümleme | `git cat-file -e "$SHA^{commit}"` + `git rev-parse "$SHA^{commit}"` — **merge commit sorunsuz** çözülür |
| Betik sürüm muhafızı | `host-release.sh` blob'u üç ref'te de aynı: **`f2b7a9aeb5c46247bae73dfc226d8a83dfeea587`** ⇒ muhafız geçer |
| `run_release.sh` çıkarımı | `git show "$TARGET:$PATH_IN_REPO"` + `git hash-object` — merge commit'te de çalışır; blob doğrulanır |
| Host'ta fetch | `git ls-remote` RC=0 ⇒ deploy'un 0. adımı (`git fetch origin --prune`) başarısız olmaz |

### 1.3 Yanlışlıkla backend-only / `--no-gateway` çalıştırılması engelli mi?

**Evet.** Muhafızın tam girdisi:

```
git diff --quiet cbe4f509 de1f1ad -- whatsapp-gateway/ docker-compose.prod.yml docker-compose.yml
→ RC=1 (fark var)
```

Kapsamdaki değişiklikler: `whatsapp-gateway/package.json`, `scripts/test-bulk-seq-pagination*.mjs` (2), `src/index.js`, `src/messages/message-store.js`, `src/session-manager.js`, `src/socket/socket-events.js` — **7 dosya**.

Sonuç: `--no-gateway` verilirse betik **`die "--no-gateway kullanilamaz: gateway/compose degismis"`** ile durur. Gateway'i atlayarak bu sürümü yayına almak **mümkün değil**. ✅

---

## 2. Production mevcut durumu (salt-okunur)

| Öğe | Değer |
| --- | --- |
| `.deployed-commit` | **`cbe4f509f4bcc5babb12cc85e0ad422cb13ba739`** (beklenen) |
| Host repo HEAD | `5cd3eae4f4b1edc57c940a4d9e56ef0257199948` (`main`) — `cbe4f509`'un descendant'ı, fark yalnız `.gitignore` |
| Backend imajı | `sha256:06ce4fe12874d9e694e03e2f53e74f6d95fef5e3339b4dfde7c8554ec9ddb21a` |
| Gateway imajı | `sha256:a1ba2572c40926fd3d71289b6e7eb20116915efc9024c7487631f24324eaa1cc` |
| Son release kaydı | `backups/releases/20261029T214629Z` — `sha=cbe4f509…`, `gateway_touched=false`, `migrations.approval=clean` |

### 2.1 Container sağlığı, restart, başlangıç

| Container | Durum | Health | **RestartCount** | Başlangıç (UTC) |
| --- | --- | --- | --- | --- |
| `tezlify-backend` | running | **healthy** | **0** | 2026-10-29T21:47:56Z |
| `tezlify-gateway` | running | **healthy** | **0** | 2026-10-27T17:25:57Z |
| `tezlify-db` | running | **healthy** | **0** | 2026-10-01T17:45:08Z |
| `tezlify-caddy` | running | **healthy** | **0** | 2026-10-12T13:12:45Z |

**Hiçbir container yeniden başlamamış** (`RestartCount = 0` × 4) ⇒ beklenmeyen durum yok.

### 2.2 Beklenen commit üzerinde mi çalışıyor?

Backend `/metrics` (canlı, `cbe4f509`):

```
keys: ['service', 'version', 'generated_at', 'whatsapp_identity_sweep']
has persistence key: False          ← 4.7 DEĞİL (beklenen)
sweep runs: 193
```

Gateway `/health`:

```json
{"status":"ok","database":"connected","pool":{"total":1,"idle":1,"waiting":0},
 "sessions":{"total":1,"connected":1,"pending_qr":0},"orphaned_sessions":0,
 "auto_restore":true,"live_session_ids":["1bd78836-c084-4cbf-b333-9386d44b7bd7"]}
```

`capacity` anahtarı **yok** ⇒ 4.17 **deploy edilmemiş** (beklenen). Yani production gerçekten `cbe4f509`.

> **Düzeltme (4.24 raporundaki hata):** 4.24'te 4.7 sinyali olarak `/metrics/check` yazılmıştı. Doğru yol **`GET /metrics`**'tir (`main.py:958` `@app.api_route("/metrics", …)`); `/metrics/check` **404** döner. 4.7 sonrası doğrulama `GET /metrics` içinde `whatsapp_memory_persistence` anahtarının **varlığı** ile yapılmalıdır.

### 2.3 PostgreSQL ve WhatsApp oturumu

| Öğe | Sonuç |
| --- | --- |
| DB erişilebilirliği (backend'den `select 1`) | **DB_OK 1** ✅ |
| Gateway DB pool | `total 1 / idle 1 / waiting 0` ✅ |
| WhatsApp oturumu | `total 1, connected 1, pending_qr 0` ✅ |
| Yetim oturum | `0` ✅ |
| `auto_restore` | `true` ✅ |
| Canlı oturum | `1bd78836-c084-4cbf-b333-9386d44b7bd7` ✅ |
| Backend↔gateway köprüsü | `connected: true`, `reconnect_count: 1`, `last_event_at 2026-10-31T21:52:05Z` ✅ |
| Container süreç sayısı | backend: **1** (`python3 start.py`) · gateway: **1** (`node src/index.js`) ✅ |

**Beklenmeyen durum yok.**

---

## 3. Kritik veri kaybı güvenlik kontrolü (yeniden ölçüldü)

> 4.24'teki `RAM_ONLY = 0` **kanıt olarak kullanılmadı**; ölçüm bu aşamada sıfırdan tekrarlandı.

**Yöntem:** gateway `GET /sessions/<sid>/messages/bulk?limit=200000&offset=0` (tek sayfa ⇒ offset kayması yok), `Authorization: Bearer $WHATSAPP_GATEWAY_SECRET`. Kimlik anahtarı **`wa_message_id`** (mesaj `id`'si ms-timestamp'tir, sohbetler arası çakışır). DB tarafı `select conversation_id, wa_message_id from messages`. Kümeler yerelde karşılaştırıldı.

| Ölçüm | 4.24 (21:30Z) | **4.25 (21:51Z)** |
| --- | --- | --- |
| RAM tekil mesaj | 9168 | **9168** |
| RAM sohbet | 100 | **100** |
| DB mesaj | 9464 | **9482** |
| **RAM_ONLY** | 0 | **0** ✅ |
| DB_ONLY | 296 | **314** |
| Kesişim | 9168 | **9168** |

### 3.1 RAM_ONLY = 0 (kritik koşul)

**Sıfır.** RAM'deki 9168 mesajın **tamamı** DB'de mevcut. Gateway yeniden oluşturulsa RAM'de DB'de olmayan tek bir mesaj bile yok.

### 3.2 DB_ONLY = 314 — tam olarak tavan taşması

| Sohbet | DB | RAM | Fark |
| --- | --- | --- | --- |
| 38289 | 2224 | 2000 | **224** |
| 38291 | 2090 | 2000 | **90** |
| **Toplam** | | | **314** ✅ |

Diğer **98 sohbette tek bir DB_ONLY yok**.

**Tutarlılık kanıtı:** 4.24'ten bu yana DB **+18** (9464→9482) ve DB_ONLY **+18** (296→314) — **tamamen conv 38289'da**; RAM 9168'de **sabit** kaldı. Yeni mesajlar tavandaki sohbete geldiği için DB büyüdü, RAM 2000'de kaldı. Beklenen davranış.

**En eski dilim kanıtı (4.24'te yapıldı, veri değişmedi):** DB_ONLY satırlarının mesaj zamanı aralığı her iki sohbette de sohbetin **minimum**undan başlıyor ⇒ baş-eksiltme (head eviction). `created_at` (DB insert zamanı) bu satırlarda 2026-10-30 20:58'de kümelenir — **mesaj zamanı değildir**, toplu INSERT imzasıdır.

### 3.3 Bütünlük kontrolleri

| Kontrol | Sonuç |
| --- | --- |
| `null wa_message_id` | **0** ✅ |
| Yetim mesaj (conversation yok) | **0** ✅ |
| Duplike `(conversation_id, wa_message_id)` | **0** ✅ |
| Global duplike `wa_message_id` | **0** ✅ |
| `FAILED` mesaj | **0** ✅ |
| `whatsapp_identity_quarantine` | **0** ✅ |
| Sohbet sayısı (toplam / mesajlı) | 126 / **100** = RAM sohbet sayısı ✅ |
| RAM max mesaj zamanı | `2026-10-31T21:50:44Z` |
| DB max `created_at` | `2026-10-31 21:50:44.773` ✅ (aynı saniye) |

### 3.4 Outbox ve processed_events

| Öğe | Değer |
| --- | --- |
| `event_outbox` toplam | **1149** |
| Durum dağılımı | **DELIVERED 1149** |
| **PENDING** | **0** ✅ |
| **IN_FLIGHT** | **0** ✅ |
| `DEAD_LETTER` | **0** ✅ |
| `max(attempts)` | **1** |
| Outbox zaman aralığı | `2026-10-30 21:46:01Z` → `2026-10-31 21:50:45Z` |
| `processed_events` | **3807** (aralık `2026-10-28 21:46` → `2026-10-31 21:50:45`) |

**Yorum:** Son outbox olayı **21:50:45**, yani ölçüm anından saniyeler önce — outbox gerçek zamanlı boşalıyor, birikme yok. 24 saatlik döner pencere (`min(created_at)` ≈ now−24h) 4.24'te kodla doğrulandı: `cleanup()` yalnız `DELIVERED` (24h) / `DEAD_LETTER` (48h) siler, `processed_events` 3 gün.

**Deploy açısından kritik:** `PENDING = 0` ve `IN_FLIGHT = 0` ⇒ gateway recreate anında **uçuşta olan olay yok**.

---

## 4. Persistence loop ve feature flag

| Kontrol | Değer | Sonuç |
| --- | --- | --- |
| `whatsapp_memory_persistence.config_enabled` | **false** | ✅ |
| `task_running` | **false** | ✅ |
| `runs` | **0** | ✅ |
| `cursor_count` | **0** | ✅ |
| `inserted_total` | **0** | ✅ |
| `errors_total` / `last_error` | 0 / `null` | ✅ |
| `.env.production`'da `WHATSAPP_MEMORY_PERSIST_ENABLED` | **anahtar YOK** (grep = 0) | ✅ "yokluk = kapalı" |
| `config.py` varsayılanı | `False`, blob **değişmemiş** | ✅ |
| İstenmeyen background worker | Container başına **1 süreç**; tek periyodik iş `whatsapp_identity_sweep` (`runs: 193`, `errors_total: 0`) — beklenen | ✅ |
| `whatsapp_data_audit` | `written 1, failed 0, last_error null` | ✅ |

**Flag'in üç katmanlı koruması (deploy betiğinde):**
1. Adacık env'i canlıdan kopyalanır, `WHATSAPP_MEMORY_PERSIST_ENABLED` satırı **silinir** ve `=false` **eklenir**, sonra `persistence_flag_guard.py --require-explicit-false` ile doğrulanır; `docker run`'a ayrıca `-e …=false` geçilir.
2. Cutover **öncesi** `.env.production` `persistence_flag_guard.py` ile denetlenir; anahtar yoksa "kapalı" kabul edilir (kod varsayılanı `false`).
3. Cutover **sonrası** çalışan sürecin **etkin** değeri `/health`'ten okunur; `false` değilse (ya da `unknown` ise) `die` — deploy geri alınır.

### 4.1 Başlangıç migration'ları veri siler mi?

`migrations.py` **değişmiyor** (`0d232b70…` = `cbe4f509`). Üç veri-bağımlı silme yolu, güncel veriyle:

| Migration | Koşul | Eşleşen satır |
| --- | --- | --- |
| `purge_degenerate_phone_contacts` | `phone_e164 ~ '^\+0+$'` | **0** |
| `purge_synthetic_preview_messages` | `wa_message_id LIKE 'preview%'` + `preview_<d>_<d>` | **0** |
| conversation dedupe | aynı `contact_id`+`channel` >1 | **0** (null contact: 0) |

⇒ Bugünkü veriyle **no-op**. Ayrıca deploy betiği bunu körü körüne varsaymıyor: adacık **izole klon DB** üzerinde tüm migration setini çalıştırıyor, sonra üretimde filigran + satır sayımı karşılaştırıyor (bkz. §5).

---

## 5. Deployment script güvenliği

### 5.1 Sorulan sorulara doğrudan cevaplar

| Soru | Cevap |
| --- | --- |
| Hedef SHA sabit ve doğrulanabilir mi? | **Evet.** `SHA` argümanı → `git cat-file -e "$SHA^{commit}"` → `TARGET_FULL`; sonraki her adım `$TARGET_FULL` kullanır; `release.json`'a tam SHA yazılır. ⚠️ **40-hex format zorlaması yok** — branch adı da kabul edilir (bkz. R2). |
| Backend ve gateway birlikte deploy ediliyor mu? | **Evet.** `--no-gateway` yoksa `CUTOVER_SERVICES=(backend gateway)`, iki imaj da build edilir, `up -d --force-recreate backend gateway`, ardından **her ikisinin** imaj kimliği doğrulanır. |
| Yanlış branch/commit deploy edilebilir mi? | Kısmen: SHA argümanı branch adı olabilir ve `git fetch origin --prune` sonrası çözülür ⇒ **branch preflight ile deploy arasında kayarsa başka commit gider**. Tam 40-hex SHA verilmesi bunu kapatır. `--expected-self-blob` betiği de pinler. |
| Migration öncesi/sonrası kontroller yeterli mi? | **Cutover öncesi: evet, güçlü.** Statik yıkıcı-migration kapısı + **izole klon DB** + üretim filigranı (kayıp → `die`, `--allow-migrations` bunu **geçemez**) + satır sayımı + şema parmak izi + adacık logu. **Cutover sonrası: yalnız tespit** — kayıp `UYARI` olarak loglanır, geri alınmaz (bkz. F3). |
| **Gateway recreate öncesi veri güvenliği doğrulaması var mı?** | **HAYIR.** Betikte `messagesByChat` / RAM / `capacity` kontrolü **yok** (grep: 0). Tüm veri muhafızları **DB tarafında**. Gateway RAM'i için tek koruma operatörün ölçümüdür — bu aşamanın varlık sebebi. (F1) |
| Health check başarısız olursa ne olur? | Adacık sağlıksız → `die`, **canlı sisteme dokunulmaz**. Cutover sonrası backend 180 sn içinde sağlıklı olmazsa → `die` → `trap` → **rollback** (henüz `VERIFIED=0`). `VERIFIED=1`'den sonra hata **geri alınmaz** (bilinçli: çalışan sürümü kayıt hatası yüzünden geri almak 3.8.x'te bir kez iyi sürümü bozdu). |
| Rollback mekanizması güvenli mi? | **DB açısından evet**, RAM açısından **ikinci bir recreate** demek (F2). `--rollback-to <TS>` → `pre-<TS>` imajlarını `latest`e bağlar + `up -d --force-recreate backend gateway` + `.deployed-commit`'ı `deployed-commit.before`'dan geri yazar. |
| Rollback sırasında DB/mesaj kaybı riski var mı? | **Şema değişikliği yok** (4.7/4.17 hiçbir migration getirmiyor) ⇒ geri dönüş kod-only, DB'ye dokunmaz. **DB'deki mesajlar güvende.** RAM'deki mesajlar ikinci recreate'te de kaybolur — ancak `RAM_ONLY = 0` olduğu için kayıp yok. |

### 5.2 Doğrulanan somut davranışlar

| Bulgu | Kanıt |
| --- | --- |
| Cutover komutu | `docker compose -f docker-compose.prod.yml up -d --force-recreate backend gateway` |
| Persistence kapısı cutover **öncesi** | `.env.production` yoksa bile `die` ("kill-switch KANITLANAMAZ") |
| Persistence kapısı cutover **sonrası** | `persist_flag_effective()` `/health` → `false` değilse `die` |
| İmaj kimliği doğrulaması | backend + gateway ayrı ayrı `NEW_*_DIGEST` ile karşılaştırılır |
| Hash doğrulaması | `events.py`, `reactions.py` (backend) + **`session-manager.js`** (gateway) |
| Public sağlık | `https://api.…/health` 6 deneme, DNS yoksa `Host:` başlığıyla fallback |
| Gateway health beklemesi | **YOK** — `wait_healthy` yalnız adacık ve `tezlify-backend` için çağrılır |
| Gateway imajında `curl` yok | Doğru, ama `wait_healthy` gateway'e uygulanmadığı için **yanlış negatif üretmez** (R6) |

### 5.3 Önerilen deploy komutu (bu aşamada **çalıştırılmadı**)

```
# 0) Planı gör (hiçbir şeyi değiştirmez)
bash scripts/deploy/run_release.sh de1f1ad34f123a304f6b6432cd22a546ccafac36 \
  --expected-self-blob f2b7a9aeb5c46247bae73dfc226d8a83dfeea587 --dry-run

# 1) Gerçek deploy — TAM release (--no-gateway YOK, --allow-migrations YOK, --frontend-tar YOK)
bash scripts/deploy/run_release.sh de1f1ad34f123a304f6b6432cd22a546ccafac36 \
  --expected-self-blob f2b7a9aeb5c46247bae73dfc226d8a83dfeea587
```

`--frontend-tar` verilmemeli: birleşik release frontend'e dokunmuyor (18 dosyanın hiçbiri `frontend/` altında değil).

---

## 6. Tespit edilen riskler

| ID | Risk | Olasılık | Şiddet | Azaltım |
| --- | --- | --- | --- | --- |
| **F1** | **Deploy betiğinde gateway RAM koruması yok** — recreate, RAM_ONLY'yi kimse kontrol etmeden yapılır | Yapısal | Yüksek | Deploy'dan **hemen önce** RAM_ONLY ölçümü tekrarlanmalı (K1). Bugün 0; deploy anında 0 olmalı. |
| **F2** | Rollback ikinci bir recreate ⇒ **ikinci RAM sıfırlaması** | Kesin (rollback olursa) | Orta | `RAM_ONLY = 0` olduğu için veri kaybı yok; UI'de geçmiş yeniden hidrasyonu görülür. Rollback hedefi **yeni release'in TS'i** olmalı (bugünkü imajları `pre-<TS>` olarak saklar). |
| **F3** | Cutover **sonrası** mesaj kaybı yalnız **UYARI** | Düşük | Yüksek | Cutover öncesi filigran kapısı ölümcül; sonrası için operatör filigranı elle karşılaştırmalı (§7). |
| **F4** | `verify_blob` yalnız **3 dosyayı** hash'liyor (`index.js`, `message-store.js`, `socket-events.js`, `memory_persistence.py`, `sync.py` kapsam dışı) | Kesin | Orta | Deploy sonrası bu 5 dosya için **elle** `sha256sum` ↔ `git show de1f1ad:path \| shasum -a 256` karşılaştırması (§7). |
| **F5** | 4.24 raporunda `/metrics/check` yazıyordu; doğru yol `/metrics` | — | Düşük | Bu raporda düzeltildi (§2.2). |
| **R1** | `SHA` argümanı branch adı olabilir; fetch sonrası çözülür | Düşük | Yüksek | Tam 40-hex SHA + `--expected-self-blob` kullan (§5.3). |
| **R2** | 2000/chat tavanı: 2 sohbet sürekli tavanda ⇒ DB büyür, RAM büyümez | Kesin | Düşük (DB üst küme) | 4.17 `/health.capacity` ile görünür olacak; tavan **değiştirilmiyor**. |
| **R3** | Outbox temizliği "kayıp" sanılır (1149 → düşer) | Orta (yanlış alarm) | Düşük | 24h döner pencere; yalnız `DELIVERED` silinir. |
| **R4** | Gateway health beklemesi olmadığı için gateway "ayağa kalktı mı" yalnız imaj kimliğiyle doğrulanır | Orta | Orta | Deploy sonrası `sessions.connected = 1` elle kontrol edilmeli (§7). |

---

## 7. Deploy sonrası doğrulama listesi (onay verilirse uygulanacak)

| # | Kontrol | Beklenen |
| --- | --- | --- |
| 1 | `.deployed-commit` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` |
| 2 | `GET /metrics` | `whatsapp_memory_persistence` anahtarı **VAR** (4.7 işareti) |
| 3 | `GET /health` → `whatsapp_memory_persistence` | `config_enabled: false`, `runs: 0` (loop kapalı kalmalı) |
| 4 | Gateway `/health` | `capacity` anahtarı **VAR** (4.17 işareti), `sessions.connected = 1`, `orphaned = 0` |
| 5 | Hash (elle, 5 dosya) | `memory_persistence.py` `070fda03…`, `sync.py` `edb7e9d2…`, `index.js` `641b1062…`, `message-store.js` `cc4414f2…`, `socket-events.js` `f441cb94…` |
| 6 | DB bütünlüğü | `null wa = 0`, yetim = 0, duplike = 0 |
| 7 | Filigran | eşik altında **kayıp yok** |
| 8 | Gateway RAM | sohbet sayısı DB mesajlı sohbet sayısına dönmeli (100) |
| 9 | `pagination: 'seq'` | İlk persist turunda `pagination_mode = seq` (loop kapalıysa bu **görülemez** — C4) |

---

## 8. Yapılmayanlar (açıkça)

Deployment **başlatılmadı**; `release.sh` / `host-release.sh` **çalıştırılmadı**; container restart/recreate/rebuild **yapılmadı**; DB'ye INSERT/UPDATE/DELETE/migration **uygulanmadı**; gateway RAM'i **değiştirilmedi** (yalnız okundu); persistence loop **açılmadı**; feature flag **değiştirilmedi**; commit/push/merge **yapılmadı**; rollback **denenmedi**.

Production'a yalnız **salt-okunur** erişim: `cat`, `docker inspect`, `docker exec` ile `ps`/`sha256sum`/`node`/`python` okuma, `psql SELECT`, `git ls-remote` (salt-okunur ağ çağrısı). **Hiçbir yazma işlemi yapılmadı.**

---

## 9. Karar

### ✅ READY FOR EXPLICIT DEPLOYMENT APPROVAL

**Koşullar (deploy onayı verilse bile uygulanacak):**

- **K1 — Deploy'dan hemen önce RAM_ONLY yeniden ölçülmeli.** Bugün `0`; deploy anında `0` olmalı. `RAM_ONLY > 0` ise deploy **iptal**. (Betik bunu kontrol etmiyor — F1.)
- **K2 — Tam 40-hex SHA + `--expected-self-blob f2b7a9ae…` kullanılmalı**, `--no-gateway` / `--allow-migrations` verilmemeli.
- **K3 — Deploy sonrası §7 listesi eksiksiz uygulanmalı**; özellikle 5 dosyanın elle hash doğrulaması (F4) ve `sessions.connected = 1`.
- **K4 — Persistence loop açılmamalı.** Açma ayrı bir karardır; P0-1'in `seq` modu ancak loop çalışırken görünür olur.

**Engelleyici bulgu yok.** Veri kaybı riski kanıtlanmadı: `RAM_ONLY = 0`, DB tutarlı, outbox boş, migration silme koşulları 0 satır, oturum volume'da.

**AŞAMA 4.25 bu noktada tamamlanır. Deployment için ayrıca açık onay beklenir.**
