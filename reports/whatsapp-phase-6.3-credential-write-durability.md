# AŞAMA 6.3 — WhatsApp Credential Write Durability

**Tarih:** 2026-11-03
**Worktree:** `/private/tmp/tz429-release` (yalnızca bu worktree üzerinde çalışıldı)
**Branch:** `release/backend-only-seq-safety`
**Başlangıç / bitiş HEAD:** `978ddf56877cd7aad7d2f30b095b6232e34802d2`
**Kapsam:** P1 — Credential yazma hatalarının sessizce kaybolması
**Kodlama:** Evet · **Altyapı:** Hayır

**Karar: `PASS_WITH_NOTES`**

---

## 1. Amaç ve Kapsam

6.0 denetiminde P1-1 olarak kaydedilen bulgu: Baileys `creds.update` sonrasında
PostgreSQL'e yapılan credential yazımı başarısız olduğunda hata yutuluyor,
`saveCreds()` başarıyla dönüyor ve sistem credential'ı kalıcı sayıyordu. Kalıcı
storage eski veride kalıyor; gateway restart sonrası yeniden bağlanma başarısız
olup kullanıcı yeniden QR'a düşebiliyordu.

Bu aşamada yalnızca credential yazma yolu ele alındı:

- yazımların gerçekten `await` edilmesi,
- hataların sessizce yutulmaması, log/diagnostic ve mevcut hata yoluna ulaşması,
- aynı oturum içinde yazımların serileştirilmesi (snapshot + FIFO),
- eski yazımın yeni veriyi ezememesi,
- yazım başarısızsa kalıcılık iddia edilmemesi,
- sınırlı/kontrollü retry (sonsuz döngü yok),
- oturumlar arası izolasyon,
- mevcut storage formatının korunması, migration/altyapı değişikliği yapılmaması.

Kapsam dışı bırakılanlar (6.0 P1 listesi dışı): provider logout CONNECTED durumu,
Baileys 440 reconnect, backend restart sync-job kaybı, broadcast/ACK performansı,
LID mapping/reconciliation, frontend, campaign media, genel gateway refactor'u.

---

## 2. Başlangıç ve Bitiş Git Durumu

| | Başlangıç | Bitiş |
|---|---|---|
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Modified tracked | 22 | 22 (aynı dosya kümesi) |
| Untracked | 44 (6.1/6.2 dahil) | 48 (6.3'ün 4 yeni test dosyası eklendi) |

Kurallar:

- `git reset`, `git clean`, `git stash`, `git checkout`, `git switch`, `git rebase`,
  `git merge` **kullanılmadı**.
- `git add .` / `git add -A` **kullanılmadı**; stage/commit/push/deploy **yapılmadı**.
- Bağımlılık kurulmadı/güncellenmedi.
- Production DB'ye veya gerçek WhatsApp oturumlarına bağlanılmadı.
- 6.1 ve 6.2 dahil tüm mevcut dirty/untracked değişiklikler korundu; hiçbir dosya
  silinmedi veya geri alınmadı.

6.3'ün eklediği yeni dosyalar:

- `whatsapp-gateway/tests/test-credential-write-durability-63.mjs`
- `whatsapp-gateway/tests/credential-write-test-loader.mjs`
- `whatsapp-gateway/tests/credential-write-test-register.mjs`
- `whatsapp-gateway/tests/stubs/baileys-credential.mjs`

(`tests/stubs/pg.mjs` 6.1'de oluşturulmuştu, değiştirilmedi.)

---

## 3. Kök Neden ve Baseline Kanıtı

Baseline, HEAD `978ddf5` içeriğinin ayrı arşivi (`/tmp/tz62-baseline`) üzerinde,
yerel izole PostgreSQL 17.11'e karşı yeniden ölçüldü (production değil):

```
{"probe":"silent_swallow","saveCreds_resolved_on_failure":true,"stored":null,"durable_flag":null}
{"probe":"stale_overwrite","final_marker":"old","writes":2}
```

İki ayrı kusur kanıtlandı:

1. **Sessiz yutma:** `createSocketForSession` içindeki eski `saveCreds`, DB yazımını
   `try/catch` ile sarıp yalnızca `logger.warn` ediyordu. `creds.update` handler'ı
   hatayı hiç görmüyordu; çağrı başarıyla dönüyor, `stored` `null` kalıyor,
   `_credentialsDurable` hiç set edilmiyordu (durable iddiası yok ama hata da yok).
2. **Sırasız yazım / eski verinin ezmesi:** aynı oturum için eşzamanlı iki
   `saveCredentials` çağrısında yavaş olan ilk yazım sonra commit ediyor, final
   değer `old` kalıyordu (`writes: 2`). Yeni credential kalıcı olarak kayboluyordu.

Ek olarak, session-manager'daki app-state self-heal yolları `session.saveCreds()`
çağırıyordu; ancak connector `session.saveCreds`'i hiç atamadığı için bu yazımlar
sessiz no-op'tu.

---

## 4. Değişen Dosyalar ve Kod Noktaları

### 4.1 `whatsapp-gateway/src/auth/postgres-auth-repository.js`

- `:28-30` — `credentialWriteRetryDelaysMs = [100, 300]` fabrika seçeneği
  (varsayılan 3 deneme; `[]` ile retry kapatılabilir).
- `:45-58` — per-session zincir/state map'leri; `getCredentialWriteState` kopya döner.
- `:60-97` — `persistCredentialSnapshot`: sınırlı retry döngüsü; son hata `throw`.
- `:99-130` — `enqueueCredentialWrite`: çağrı anında `stringify` snapshot, FIFO
  zincir, hata durumunda da zincirin devamı, `pendingWrites`/`lastError`/zaman damgası.
- `:132-137` — `flushCredentialWrites`: in-flight zinciri bekler (shutdown yolu).
- `:190-200` — repository metotları: `saveCredentials` artık `await enqueue...`;
  `getCredentialWriteState`, `flushCredentialWrites` eklendi.

SQL ifadesi, tablo/kolonlar, `version + 1` semantiği ve AES-GCM codec **aynen
korundu**; migration veya yeni tablo yok.

### 4.2 `whatsapp-gateway/src/socket/socket-connector.js`

- `:96-102` — `diskSaveCreds` artık hatayı yutmuyor.
- `:104-121` — `saveCreds`: repo yazımını `await` eder; başarıda
  `_credentialsDurable = true`, hatada `false` + `_credentialWriteError` ve `throw`.
- `:122-125` — `session.saveCreds = saveCreds` ataması eklendi (self-heal no-op'u giderildi).
- Eski kodda PG yazımından sonra yapılan **ikinci** `diskSaveCreds()` çağrısı
  kaldırıldı; tek `creds.update` artık tek kez yazıyor.

### 4.3 `whatsapp-gateway/src/session-manager.js`

- `:520-550` — `shutdown()`: her oturum için `flushCredentialWrites` toplanır ve
  `Promise.allSettled([...leaseReleases, ...credentialFlushes])` ile pool
  kapanmadan önce beklenir. Socket teardown'dan önce flush toplanır.
- `:1963-1970` ve `:1988-1995` — app-state self-heal sonrası
  `session.saveCreds()` hataları artık `logger.warn({ err, session_ref }, ...)` ile
  görünür; sessiz `catch {}` kaldırıldı.

### 4.4 `whatsapp-gateway/src/socket/socket-events.js`

Kod değişmedi. Mevcut `creds.update` handler'ı (`:133-146`) hatayı zaten
`diagnostic('auth_state_write_failed', ...)` + `logger.error(...)` ile raporluyordu;
6.3 ile birlikte bu handler nihayet gerçek hataları alıyor.

### 4.5 `whatsapp-gateway/package.json`

`test` zincirine 6.3 suite'i eklendi:

```
node --import ./tests/credential-write-test-register.mjs tests/test-credential-write-durability-63.mjs
```

Gerçek `pg` URL'i verilmediğinde PG testleri skip edilir, disk/handler testleri koşar
(aşağıda doğrulandı).

---

## 5. Yazma Sırası ve Hata İşleme Yaklaşımı

1. **Snapshot-at-call:** `saveCredentials(sessionId, creds)` çağrıldığı anda
   `JSON.stringify(creds, BufferJSON.replacer)` alınır. Sonradan `state.creds`
   mutasyona uğrasa bile kuyruktaki yazım kendi anlık görüntüsünü yazar.
2. **Per-session FIFO:** `credentialWriteChains` anahtarı `String(sessionId)`'dir.
   Her yeni yazım önceki zincirin `then(ok, err)`'ine bağlanır; önceki hata zinciri
   kırmaz. Böylece eski snapshot yeni snapshot'tan sonra commit edemez.
3. **Oturum izolasyonu:** map'ler oturum başına ayrıdır; bir oturumun yavaş/hata
   veren zinciri diğerini bekletmez.
4. **Sınırlı retry:** varsayılan `[100, 300]` → toplam 3 deneme (100 ms + 300 ms
   arayla). Sabit üst sınır; büyüme/sonsuz döngü yok; son hata çağırana döner.
5. **Görünürlük:** repo `throw` eder → connector `_credentialsDurable=false` yapar ve
   yeniden fırlatır → `creds.update` handler'ı `auth_state_write_failed` diagnostic'i
   ve `logger.error` üretir. Başarısız yazım "başarılı" sayılmaz; DB değişmez.
6. **Shutdown drain:** gateway kapanırken kabul edilmiş yazımlar `flushCredentialWrites`
   ile beklenir; böylece pool kapanmadan önce kuyruk boşaltılır.
7. **Format korunur:** aynı tablo (`whatsapp_private.session_credentials`), aynı
   kolonlar, aynı `ON CONFLICT ... version + 1` davranışı.

---

## 6. Zorunlu Testler (A–H)

Komut (gerçek yerel PostgreSQL 17.11, izole `tezlify_62_isolated`):

```bash
cd /private/tmp/tz429-release/whatsapp-gateway
TZ63_PG_MODULE_URL="file:///Users/isatezcan/Documents/Github/Tezlify/node_modules/pg/lib/index.js" \
TZ63_PG_URL="postgresql://isatezcan@localhost:5432/tezlify_62_isolated" \
node --import ./tests/credential-write-test-register.mjs \
     --test tests/test-credential-write-durability-63.mjs
```

Sonuç:

```
✔ A: a normal credential update is awaited and reloads from storage
✔ B: a storage failure rejects, is recorded, and is not treated as persisted
✔ C: sequential updates persist the newest credential
✔ D: concurrent updates are serialized; an older write cannot overwrite the newer one
✔ E1: a transient failure is retried a bounded number of times and then succeeds
✔ E2: persistent failure stops after the bounded retries and never loops
✔ F: one session failure does not block or corrupt another session
✔ G: no persistence is claimed before the write completes; restart reloads it
✔ G2: flushCredentialWrites drains an in-flight write (shutdown path)
✔ socket: saveCreds surfaces PG failure and marks the session non-durable
✔ socket: a successful PG write is durable and written exactly once
✔ disk branch: credentials are written to a real file and failures propagate
✔ creds.update handler logs the failure instead of swallowing it
ℹ tests 13 · pass 13 · fail 0 · skipped 0
```

| Gereksinim | Test | Kanıt |
|---|---|---|
| A. Normal yazım kalıcı | A | Yeni repo instance'ı `loadCredentials` ile değeri geri okur; `pendingWrites=0`, `lastError=null` |
| B. Hata yutulmaz, başarı sayılmaz | B, socket-fail, disk branch | `assert.rejects`; state'te `lastError`; DB'de eski değer korunur; `_credentialsDurable=false` |
| C. Sıralı yazımda en yeni kalır | C | `c2` okunur; DB `version = 2` |
| D. Eşzamanlı yazımda eski yeni ezemez | D | İlk yazım 200 ms geciktirilir; sonuç `marker='new'`, 2 yazım |
| E. Sınırlı retry | E1, E2 | 2 hata + 1 başarı = 3 deneme; kalıcı hatada 3 deneme sonrası reject, döngü yok |
| F. Oturum izolasyonu | F | A oturumu fail ederken B başarıyla yazılır; A `null`, B doğru |
| G. ACK öncesi kalıcılık iddiası yok / restart | G, G2 | Yazım kapıda beklerken `pendingWrites=1`, `loadCredentials()` `null`; serbest bırakılınca restart repo'su değeri görür; flush in-flight yazımı bekler |
| H. Regresyonlar | §7 | 6.1, 6.2, backend, gateway script'leri |

`node --check` ile tüm değişen/yeni JS dosyaları sözdizimi kontrolünden geçti.

Gerçek `pg` verilmeden (npm test senaryosu) skip davranışı:

```
ℹ tests 13 · pass 2 · fail 0 · skipped 11
```

Bu, 11 PG-bağımlı testin (9 PG + 2 socket-PG) sakince skip edildiğini, disk ve
handler testlerinin ise her ortamda koştuğunu gösterir.

---

## 7. Gerçek Storage vs Mock Ayrımı

**Gerçek storage kullanılan testler (mock sonucu değildir):**

- A–G, G2, socket-fail, socket-ok: yerel **PostgreSQL 17.11**
  (`tezlify_62_isolated`) üzerinde gerçek `INSERT/UPSERT/SELECT`; credential'lar
  gerçek AES-GCM ile şifrelenip yazıldı ve geri okundu.
- Disk branch: gerçek dosya sistemi — `creds.json` yazıldı, içeriği diskten geri
  okundu; dizin `0o500` yapılarak gerçek yazma hatası üretildi ve hatanın çağırana
  ulaştığı doğrulandı.
- 6.2 SQLite regresyonu: `scripts/provision_test_db.py` ile üretilen taze SQLite
  dosyası (`/tmp/tz63_regression.db`) üzerinde gerçek SQLAlchemy oturumları.
- 6.2 PostgreSQL regresyonu: aynı yerel izole PG üzerinde gerçek asyncpg bağlantıları.

**Mock/stub kullanılan noktalar:**

- `@whiskeysockets/baileys` yerine `tests/stubs/baileys-credential.mjs` kullanıldı;
  socket oluşturma, `creds.update` kaydı ve `useMultiFileAuthState` (gerçek dosyaya
  yazan test double) bu stub üzerinden çalışır. Bu nedenle "gerçek WhatsApp ağına
  bağlanma / gerçek QR" bu suite'in kanıtı **değildir**.
- `wrapPool` enjekte edilen handler'lar hata/gecikme senaryolarını üretir; ancak
  `run()` çağrıldığında sorgu **gerçek** pool üzerinden DB'ye gider.

Test verisi temizliği: `tz63-%` satırları test sonunda silindi; doğrulama sorgusu
`0` döndürdü. Production veritabanına hiç bağlanılmadı.

---

## 8. Çalıştırılamayan Testler

- **`npm test` (tam gateway zinciri):** worktree'de `node_modules` yok; script'lerin
  çoğu gerçek bağımlılık istiyor. Bu nedenle tam zincir çalıştırılmadı; 6.3 suite'i
  kendi loader'ı ile, 6.1 suite'i kendi loader'ı ile koşturuldu.
- **`scripts/test-appstate-delete-selfheal.mjs`:** 6.1 stub'ının `proto.Message`
  nesnesinde `AppStateSyncKeyData` yok (`Cannot read properties of undefined`).
  Kod regresyonu değil, stub eksikliği. Self-heal `session.saveCreds` ataması 6.3
  socket testiyle doğrulandı.
- **`scripts/test-postgres-pool-error.mjs`:** 6.1 `pg` stub'ında
  `EventEmitter.listenerCount` yok; pre-existing stub sınırlaması.
- **Gerçek WhatsApp oturumu açma / QR / reconnect / logout:** brif gereği production
  veya gerçek oturumlara bağlanılmadı. Bu akışlar dolaylı olarak post-QR state
  machine, presence ve appstate rearm script'leriyle regresyona sokuldu (§9).
- **Frontend:** kapsam dışı; dokunulmadı.

---

## 9. Regresyon Sonuçları

| Suite | Komut altyapısı | Sonuç |
|---|---|---|
| 6.3 credential durability | gerçek PG + stub Baileys | **13/13 pass** |
| 6.3 skip modu (pg URL yok) | stub'lar | 2 pass / 11 skip / 0 fail |
| 6.1 pending-LID durability | lid loader/stub | **19/19 pass** |
| 6.2 SQLite LID matrisi (4 dosya) | taze provision edilmiş SQLite | **47 passed** (6.72 s) |
| 6.2 PostgreSQL LID matrisi | yerel PG 17.11 + `tz44_pgplugin` (NullPool) | **11 passed** (4.38 s) |
| Backend tam WhatsApp regresyonu | SQLite | **998 passed, 4 skipped, 2 errors** (87.82 s) |
| `scripts/test-durable-auth.mjs` | loader üzerinden | **12 assertions passed** |
| `scripts/test-post-qr-sync-state-machine.mjs` | lid loader | **18/18 PASS** |
| `scripts/test-appstate-rearm.mjs` | lid loader | **10 checks PASS** |
| `scripts/test-phone-notifications-presence.mjs` | lid loader | **3 checks PASS** |
| `scripts/test-orphan-session.mjs` | lid loader | **9 checks PASS** |
| `scripts/test-delete-chat-contract.mjs` | lid loader | **12/12 PASS** |

Backend'deki 2 hata, 6.2 raporunda da kayıtlı **bilinen baseline** hatalarıdır:

- `test_whatsapp_phase2_a_gateway_behavior.py::test_hydrated_group_broadcast_reaches_frontend`
- `test_whatsapp_phase2_a_gateway_behavior.py::test_hydrated_group_persists_via_real_ingestion`

Neden: worktree'de `node_modules` yok; Node testi `uuid` çözemiyor
(`ERR_MODULE_NOT_FOUND: Cannot find package 'uuid'`). 6.3 kaynaklı değildir.

---

## 10. Bilinen Sınırlamalar / Notlar

1. **Signal key mirror yazımları kapsam dışı:** `state.keys.set` → `setSignalKeys`
   yolu hâlâ `try/catch` + `logger.warn` ile devam ediyor. 6.3 yalnızca credential
   (`saveCredentials`) yolunu sertleştirdi. Bu, brifin "credential yazma" kapsamına
   uygundur; ancak Signal key kaybı ayrı bir risk olarak durur.
2. **Nihai yazma hatası sonrası yakınsama:** Retry'lar tükendiğinde hata görünür olur
   ve `_credentialsDurable=false` işaretlenir; ancak bir sonraki `creds.update` veya
   self-heal'e kadar DB eski veride kalır. Sistem artık kalıcılık iddia etmez; bu,
   "hata sessizce kaybolmasın" gereksiniminin kabul edilen davranışıdır. Otomatik
   telafi yazımı (ör. connect anında reconcile) 6.3 kapsamı dışıdır.
3. **Shutdown drain yarışı:** `flushCredentialWrites` çağrıldığı anda zincirde olan
   yazımları bekler. Kapanış sırasında `lifecycle.invalidate()` ve `_shuttingDown`
   nedeniyle yeni `creds.update` yazımı kabul edilmez; ancak kapanışla eşzamanlı bir
   self-heal yazımı flush sonrası kuyruğa girerse bu yazım drain edilmeyebilir.
   Olasılık düşük ve hata yine görünür (warn) kalır.
4. **Socket seviyesi testler stub Baileys kullanır:** Gerçek provider davranışı
   (QR, 440, logout) bu suite'in kanıtı değildir; brif gereği gerçek oturum
   açılmadı.
5. **Retry gecikmesi:** `creds.update` handler'ı artık en kötü durumda ~400 ms
   ek gecikme yaşayabilir (bounded). Bu, credential kaybını önlemek için bilinçli
   bir tercihtir; oturum başına ayrıdır ve diğer oturumları bloklamaz.

---

## 11. Sınır Kontrolü

- Yalnızca `/private/tmp/tz429-release` içinde çalışıldı; başka worktree veya ana
  repository üzerinde değişiklik yapılmadı (ana repo yalnızca `pg` modülü ve
  bağımlılık okuması için kullanıldı).
- `git reset/clean/stash/checkout/switch/rebase/merge` kullanılmadı.
- `git add .` / `git add -A` kullanılmadı; commit/push/deploy yapılmadı.
- Bağımlılık kurulmadı/güncellenmedi.
- Production DB ve gerçek WhatsApp oturumlarına bağlanılmadı.
- 6.1/6.2 dahil tüm mevcut dirty/untracked dosyalar korundu.
- Mock sonuçları gerçek storage kanıtı olarak sunulmadı; gerçek PG/SQLite/dosya
  doğrulamaları ayrıca belirtildi.

---

## 12. Karar

**PASS_WITH_NOTES**

Zorunlu A–H testlerinin tamamı geçti; P1-1 kök nedeni (sessiz yutma + sırasız
yazım) baseline probe'larıyla kanıtlandı ve düzeltildi. 6.1 ve 6.2 regresyonları
temiz. Notlar: Signal key mirror yutması kapsam dışı olarak duruyor, tam `npm test`
worktree'de `node_modules` olmadığı için koşulamadı, nihai yazma hatası sonrası
otomatik telafi yazımı yok (hata görünür ve kalıcılık iddia edilmiyor).
