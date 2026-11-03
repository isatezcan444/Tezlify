# AŞAMA 5.4.6 — Birleşik Medya Değişiklikleri Son Kabul Denetimi

**Tarih:** 2026-11-03 (UTC 11:39, TRT 14:39)
**Kapsam:** 5.4.2 – 5.4.5 medya değişikliklerinin birleşik, bağımsız ve salt-okuma son kabulü
**Tür:** READ-ONLY AUDIT / RELEASE READINESS — kod, test veya altyapı değişikliği yok
**Çalışma alanı:** `/private/tmp/tz429-release`
**Sonuç:** **PASS_WITH_NOTES** (kapsam içinde BLOCKER/HIGH yok; 3 MEDIUM, 2 LOW risk belgelendi)

---

## 1. Başlangıç ve Bitiş Git Durumu

| Alan | Başlangıç (5.4.6 başında) | Bitiş (2026-11-03T11:39Z) | Durum |
|---|---|---|---|
| `pwd` | `/private/tmp/tz429-release` | `/private/tmp/tz429-release` | Aynı |
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` | Aynı |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | **Aynı** |
| Staged değişiklik | 0 | 0 | Aynı |
| Modified | 9 | 9 | Aynı |
| Untracked giriş | 14 | 14 (`reports/` içine 1 rapor eklendi) | Aynı |

**Modified (9):**

```
 backend/app/api/v1/endpoints/whatsapp.py                  |  14 +-
 backend/app/services/link_preview/service.py              |  67 +-
 backend/app/services/whatsapp/orchestration/messaging.py  |  43 +-
 backend/app/services/whatsapp_gateway.py                  |  24 +-
 backend/tests/test_whatsapp_live.py                       |  96 +++
 whatsapp-gateway/package.json                             |   2 +-
 whatsapp-gateway/src/index.js                             |  43 +-
 whatsapp-gateway/src/media/media-store.js                 | 783 +++++++++++++++++--
 whatsapp-gateway/src/session-manager.js                   |  29 +-
 9 files changed, 971 insertions(+), 130 deletions(-)
```

**Untracked (14):** `reports/`, `backend/tests/test_link_preview_media_tenant_isolation.py`,
`backend/tests/test_whatsapp_media_tenant_isolation.py`, `whatsapp-gateway/src/media/media-routes.js`,
`whatsapp-gateway/tests/test-media-store-integrity.mjs`, `test-media-store-543.mjs`,
`test-media-routes-543.mjs`, `test-media-ingestion-atomicity-545.mjs`, `test-media-routes-545.mjs`,
`tests/stubs/`, `tests/media-test-loader.mjs`, `media-test-loader-atomic.mjs`,
`media-test-register.mjs`, `media-test-register-atomic.mjs`.

**Sınırlar:** Commit/push/deploy yapılmadı; `git reset/clean/stash/checkout/rebase/merge` çalıştırılmadı;
`git add` kullanılmadı; ana worktree ve diğer worktree'lere dokunulmadı; production'a bağlanılmadı;
gerçek WhatsApp hesabı kullanılmadı; dependency kurulmadı; gerçek medya klasörüne yazılmadı.
Denetim sırasında oluşturulan geçici SQLite DB'leri (`/tmp/tz546_*.db`) ve probe betiği denetim
sonunda temizlendi; ürün dosyalarında tek bayt değişiklik yoktur.

---

## 2. Artefakt Envanteri (5.4.2 – 5.4.5)

| Faz | Ürün dosyası | Amaç | Durum |
|---|---|---|---|
| 5.4.2 | `backend/app/services/whatsapp/orchestration/messaging.py` | `get_media_bytes` tenant kapsamı (F-10) | Mevcut, doğrulandı |
| 5.4.2 | `backend/app/services/whatsapp_gateway.py` | `fetch_media` (scoped) / `fetch_media_unscoped` (çağıransız) | Mevcut, doğrulandı |
| 5.4.2 | `whatsapp-gateway/src/media/media-store.js` | Hash/sidecar doğrulama (F-09/F-12) | Mevcut, doğrulandı |
| 5.4.2 | `backend/tests/test_whatsapp_media_tenant_isolation.py` | Backend tenant regresyonu | Mevcut, PASS |
| 5.4.2 | `whatsapp-gateway/tests/test-media-store-integrity.mjs` | Store bütünlük regresyonu | Mevcut, PASS |
| 5.4.3 | `backend/app/services/link_preview/service.py` | Preview proxy tenant + fail-closed | Mevcut, doğrulandı |
| 5.4.3 | `whatsapp-gateway/src/media/media-routes.js` (yeni) | Session-scoped medya rotaları | Mevcut, doğrulandı |
| 5.4.3 | `whatsapp-gateway/src/index.js` | Global gateway auth + rota kaydı | Mevcut, doğrulandı |
| 5.4.3 | `whatsapp-gateway/src/session-manager.js` | Media store delegasyonu + on-demand indirme | Mevcut, doğrulandı |
| 5.4.3 | `whatsapp-gateway/src/media/media-store.js` | Same-FD doğrulama (TOCTOU), async sidecar taraması, kapasite gözlemi | Mevcut, doğrulandı |
| 5.4.3 | `backend/tests/test_link_preview_media_tenant_isolation.py` | Preview tenant regresyonu | Mevcut, PASS |
| 5.4.3 | `whatsapp-gateway/tests/test-media-store-543.mjs` | TOCTOU / legacy / corrupt regresyonu | Mevcut, PASS |
| 5.4.3 | `whatsapp-gateway/tests/test-media-routes-543.mjs` | Rota seviyesi HTTP regresyonu | Mevcut, PASS |
| 5.4.3 | `whatsapp-gateway/scripts/test-gateway-auth.mjs` | Fail-closed auth regresyonu | Mevcut, PASS |
| 5.4.4 | `reports/whatsapp-phase-5.4.4-combined-media-audit.md` | Birleşik denetim raporu; M-1/M-2 tespiti | Mevcut (rapor) |
| 5.4.5 | `whatsapp-gateway/src/media/media-store.js` | M-1: `(session, waMessageId)` ingest lock | Mevcut, doğrulandı |
| 5.4.5 | `whatsapp-gateway/src/media/media-routes.js` | M-2: `asyncHandler`, header retraction, FD/stream cleanup | Mevcut, doğrulandı |
| 5.4.5 | `whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs` | Eşzamanlılık/retry/ENOSPC regresyonu | Mevcut, PASS |
| 5.4.5 | `whatsapp-gateway/tests/test-media-routes-545.mjs` | Express-4 semantiği + FD sayacı regresyonu | Mevcut, PASS |
| 5.4.5 | `backend/tests/test_whatsapp_live.py` (+96) | 422 medya bütünlük eşlemesi | Mevcut, PASS |
| 5.4.5 | `reports/whatsapp-phase-5.4.5-media-atomicity-and-http-safety.md` | M-1/M-2 raporu | Mevcut |

**`package.json` test kablolaması:** `test` script'i 45 adet `&&` zinciri içeriyor. Beş medya
süiti de gerçekten çağrılıyor ve doğru loader ile eşleşiyor:

```
node --import ./tests/media-test-register.mjs        tests/test-media-store-integrity.mjs
node --import ./tests/media-test-register.mjs        tests/test-media-store-543.mjs
node --import ./tests/media-test-register.mjs        tests/test-media-routes-543.mjs
node --import ./tests/media-test-register-atomic.mjs tests/test-media-ingestion-atomicity-545.mjs
node --import ./tests/media-test-register.mjs        tests/test-media-routes-545.mjs
```

`node -e "require('./package.json')"` parse OK; referans verilen tüm test dosyaları mevcut.
Not: 5.4.5 rota süiti `-atomic` değil normal loader kullanıyor; bu bilinçli bir seçimdir (aşağıda §6).

---

## 3. Güvenlik İncelemesi — 12 Kontrol

| # | Kontrol | Sonuç | Kanıt |
|---|---|---|---|
| 1 | Tenant izolasyonu | **PASS** | `messaging.py:1372-1396`; `link_preview/service.py:346-379`; `whatsapp.py:1172` |
| 2 | Boş `user_id` fail-closed | **PASS** | `messaging.py:1369`; `service.py:340` |
| 3 | Yetkisiz unscoped backend kullanımı yok | **PASS** | `fetch_media_unscoped` (`whatsapp_gateway.py:656`) production'da çağıransız; yalnız testlerde ve test "asla çağrılmamalı" diye assert ediyor |
| 4 | MIME doğrulaması FD açılmadan önce | **PASS** | `media-store.js:426-432` (meta okuma + corrupt + `isSafeMimeType`), FD `:437`'de açılıyor |
| 5 | Bozuk sidecar legacy sayılmıyor | **PASS** | `media-store.js:428`; `:620-642` bozuk metadata indekslenmiyor, yol dönse bile `META_CORRUPT` üretilir |
| 6 | Hash uyuşmazlığı fail-closed | **PASS** | `media-store.js:465-469`; rota `media-routes.js:89-97` → 422 `MEDIA_CORRUPTED` |
| 7 | Aynı FD ile doğrula + gönder | **PASS** | `media-store.js:465` hash FD üzerinden; `:471-479` post-hash `fstat`; `:490-498` stream aynı FD |
| 8 | FD / stream temizliği | **PASS** | `media-store.js:471-488`, `:503-511`; `media-routes.js:119,129,141,152`; testlerde açılan/kapanan FD sayacı |
| 9 | Çift yanıt yok | **PASS** | `media-routes.js:20-38` (`asyncHandler` tek terminal yol), `:124` destroyed kontrolü, `settled` bayrağı `:133` |
| 10 | Hata yanıtında bayat medya header'ı yok | **PASS** | `media-routes.js:85-95` ve `:135-147`: Content-Type/Length/Cache-Control/X-Media-Integrity geri çekiliyor |
| 11 | Tenant / dosya yolu sızıntısı yok | **PASS** | Hata gövdeleri generic (`Media ... failed`); yanıtlarda path yok; loglar yalnız `err.code`/`mediaId`. Gateway `/health` public ve yalnız sayı/byte döner (PII/path yok) |
| 12 | Path traversal yok | **PASS** | `isSafeMediaKey` (`media-store.js:78-85`): `/`, `\`, NUL, `.`, `..` reddi; `resolveMediaPath` tam kök-ad eşleşmesi (`:636-648`); campaign tarafında `resolve().is_relative_to(upload_dir)` (`campaign_media_service.py:196-198`) |

**Ek — Gateway kimlik doğrulaması:** `requireGatewayToken` (`gateway-auth.js:88`) secret yoksa 503,
yanlışsa 401; `timingSafeEqual`; secret ≥32 byte zorunlu. Global middleware medya rotalarından önce
takılı (`index.js:229`), rotalar `:759`'da kayıtlı. `verifyWsToken` (`gateway-auth.js:104`) fail-closed.
`/health` bilinçli olarak auth öncesinde (kapasite gözlemi), hassas veri içermiyor.

**Not (LOW/INFO):** `/health` kimlik doğrulamasız olarak `files/sidecars/bytes/free_bytes/total_bytes`
döndürür. Saldırgana yalnız kaba disk kullanımı bilgisi verir; yol, mesaj veya tenant bilgisi yoktur.

---

## 4. Tenant İzolasyonu (Backend)

- `get_media_bytes` (`messaging.py:1355`) önce boş `user_id`'yi reddeder (`:1369`).
- `media_id`/`wa_message_id` sorgusu `get_user_filter(Message.user_id, user_id)` ile kapsamlanır (`:1381`).
- `get_user_filter` (`auth.py:213`) production'da katıdır; NULL sahipli legacy satırlara yalnız
  `PYTEST_CURRENT_TEST` altında izin verir. Bu yüzden `get_media_bytes` ayrıca açık `_same_tenant`
  çift kontrolü yapar: satır (`:1389`) ve conversation (`:1394`).
- Gateway kimliği `conversation_gateway_id(db, user_id, conv)` ile kullanıcıya kapsamlı çözülür (`:1396`).
- DB okuma transaction'ı gateway çağrısından önce commit edilir (`:1417`) — bağlantı havuza döner,
  kilit tutulmaz.
- `fetch_media` (`whatsapp_gateway.py:617`) yalnız session-scoped uç noktayı kullanır. Scoped çağrı
  `LookupError` verirse fallback'ler yine aynı scope içindedir (`messaging.py:1419-1435`).
- Link preview proxy (`service.py:320`): boş kullanıcı fail-closed (`:340`); dahili WhatsApp medya
  yolu (`:346`) için `Message.media_id` kullanıcıya kapsamlı (`:361`), satır (`:369`) ve conversation
  (`:374`) çift kontrol, gateway kimliği doğrulanmış kullanıcıdan (`:378`).
- Endpoint `Depends(get_current_user)` ile korunur (`whatsapp.py:1172`); gateway 422 → HTTP 422
  (`whatsapp.py:1187`).

**Test kanıtı:** `test_whatsapp_media_tenant_isolation.py` + `test_link_preview_media_tenant_isolation.py`
→ **21 passed**, EXIT 0. Testler unscoped çağrının hiç yapılmadığını açıkça doğrular.

**Kapsam dışı istisna (bkz. §9 A-1):** campaign medya uç noktası auth'suzdur; 5.4.x medya
değişikliklerinin parçası değildir ve bu fazda düzeltilmemiştir.

---

## 5. Ingestion Atomikliği (M-1)

- Lock anahtarı `(session.id, waMessageId)` (`media-store.js:68`); oturumlar arası eşzamanlı
  çalışma ayrıdır.
- `storeIncomingMedia` (`:922`) aynı anahtar için in-flight Promise'i paylaşır; hata yutar ve
  `finally` içinde yalnız kendi kaydını kimlik kontrolüyle siler (`:945-950`).
- `ingestIncomingMedia` (`:806`) RAM + disk dedupe sonrası indirir; thumbnail fallback ve
  `storeMediaBuffer` (`:654`) ile tek dosya + tek sidecar üretir.
- `ingestLocks`, `dedupeScans` ve `mediaByWaId` yalnız RAM'dedir; restart sonrası disk dedupe
  sidecar taramasıyla korunur (`:780-802`, `initFromDisk` `:229`).

**Test kanıtı:** `test-media-ingestion-atomicity-545.mjs` → **39 assertions**, EXIT 0. Kapsam:
2 ve 10 eşzamanlı aynı mesaj (tek indirme, tek dosya, aynı `media_id`), farklı id'ler paralel,
hata sonrası retry, ENOSPC benzeri yazma hatasında dosya/lock temizliği, 5 bekleyen çağıranın
çözülmesi, farklı oturumların eşzamanlı birleşmemesi.

### 5.1 Yeni bulgu — sıralı çapraz-oturum dedupe (MEDIUM)

`findExistingMediaByWaId` (`media-store.js:780`) **yalnız `waMessageId`** ile arar; `sessionId`
filtresi yoktur (RAM yolu `:781-788`, disk taraması `:802`). Bu nedenle **eşzamanlı** çapraz-oturum
doğru ayrılırken (lock anahtarı oturum kapsamlı), **sıralı** ikinci oturum birincinin dosyasını
yeniden kullanır. `ingestLockKey` yorumundaki "farklı hesaplar medyayı paylaşmamalı" kuralıyla
çelişir.

**Canlı probe (2026-11-03, gerçek store + stub, gerçek WhatsApp yok):**

```json
{
  "downloads": 1,
  "same_media_id": true,
  "files": 1,
  "sidecars": 1,
  "sidecar_session_a": "sess-a",
  "sidecar_session_b": "sess-a",
  "sidecar_paths_shared": true
}
```

Ayrıca `resolveMediaPath('sess-b', <sess-a media_id>)` dosyayı döndürür; `resolveMediaPath`
tasarım gereği oturum-agnostiktir (`:602`). **Etki:** aynı `waMessageId` iki oturumda görünürse
baytlar zaten aynıdır (veri sızıntısı yok); risk, sidecar sahipliğinin yanlış oturumu göstermesi
ve ileride oturum bazlı erişim/retention kararlarının yanlış veriye dayanmasıdır. Farklı
kullanıcıların aynı `waMessageId`'yi görmesi pratikte imkânsıza yakın olduğundan çapraz-tenant
sızıntı yoktur. **MEDIUM** (tutarlılık/sahiplik), BLOCKER/HIGH değil.

---

## 6. FD ve HTTP Güvenliği (M-2)

`serveVerifiedMedia` (`media-routes.js:57`):

- `openVerifiedMedia` hataları: `MISSING`→404, `INVALID_MIME`→422 `MEDIA_INVALID_METADATA`,
  diğer→422 `MEDIA_CORRUPTED` (`:82-97`). FD yalnız doğrulama başarılıysa stream'e devredilir.
- Header yazımı başarısızsa stream yok edilir ve medya header'ları geri çekilir (`:85-95`).
- İstemci gitmişse FD kapatılır (`:119-122`); `HEAD` stream'i yok edip `end()` eder (`:129-132`).
- Stream hatası: bayt yazılmadıysa header retraction + 500 `MEDIA_STREAM_ERROR`; yazıldıysa
  `res.destroy()` (`:135-147`).
- `res.on('close')` bitmemiş stream'i yok eder (`:152-154`).
- `asyncHandler` (`:20-38`) Express 4'te dönüş değeri yok sayılsa bile tek terminal yanıt veya
  socket destroy garanti eder.

**Test kanıtı:** `test-media-routes-545.mjs` → **61 assertions**, EXIT 0. Express-4'e sadık host
(dönen Promise'i yakalamaz), gerçek `requireGatewayToken`, `openSync/closeSync` FD sayacı ve
global `unhandledRejection` toplayıcısı ile: geçersiz MIME (mevcut/olmayan dosya, iki rota,
açılan FD=0), bozuk sidecar (422, FD=0), hash uyuşmazlığı (açılan=1/kapanan=1), `/dev/null`,
header hatası (500, bayat Content-Length yok, stream yok edildi), bayt öncesi/sonrası stream hatası,
istemci kopması, HEAD, sıfır bayt, iki rota başarısı, bilinmeyen session 404, yanlış/eksik token 401,
`asyncHandler` doğrudan birim testleri ve `unhandled.length === 0`.

`test-media-routes-543.mjs` (**40 assertions**, EXIT 0) host'u dönen Promise'i `.catch()` ettiği
için Express 4 semantiğini **maskeleyebilir**; bu süit tarihsel regresyon içindir, Express 4
kanıtı olarak kullanılmamalıdır. Express 4 semantiği 5.4.5 süiti ve doğrudan `asyncHandler`
testleriyle kapsanmıştır. **Gerçek `express@4` üzerinde E2E çalıştırılmadı** (bkz. §8).

---

## 7. Disk Dayanıklılığı, Crash ve Kısmi Dosya

- `storeMediaBuffer` (`media-store.js:654`) dosyayı **doğrudan** `fs.writeFileSync` ile yazar
  (temp+rename yok). Yazma hatasında yalnız bu çağrıda oluşturulan dosya silinir; mevcut dosyalara
  dokunulmaz. Sidecar yazımı başarısız olursa yeni dosya geri alınır (doğrulanamayan referans
  oluşmaz).
- `initFromDisk` (`:229`) yalnız `.meta.json` sidecar'ları indeksler; sidecar'sız dosyalar restart
  sonrası indekse girmez. Sidecar'sız dosya "legacy" kabul edilir ve **yalnız `media_id` bilinirse**
  `resolveMediaPath` adım 4 ile sunulabilir (`:636-648`).
- **Crash penceresi:** `writeFileSync` ile sidecar yazımı arasında SIGKILL olursa sidecar'sız,
  kısmi bir dosya kalır. Bu dosya restart'ta indekslenmez; `media_id` çağırana hiç dönmediyse
  backend'de referansı yoktur, dolayısıyla adreslenemez ve sunulamaz. Bu nedenle crash→sunum
  zinciri **ulaşılabilir değildir**.
- **Ancak:** (a) yetim kısmi dosyalar için temizlik/retention yoktur, disk kullanımı zamanla
  birikebilir; (b) legacy kabulü nedeniyle, bir gün sidecar'sız bir dosyaya referans üretilirse
  (eski sürüm, manuel migrasyon, gelecekteki bir kod değişikliği) boyut/hash doğrulanmadan
  sunulur; (c) testler write–sidecar arası crash'i kapsamaz.
- Beklenen boyut, sidecar varsa `sizeBytes` ile kontrol edilir (`:457-463`); sidecar yoksa
  karşılaştırılacak beklenen değer yoktur. Hash de yoktur.
- **Sınıflandırma: MEDIUM** — ulaşılabilir bir yanlış sunum yolu yok, fakat sınırsız yetim dosya
  birikimi + legacy kabulü latent bütünlük riski oluşturur. HIGH değildir; disk dolduğunda yeni
  medya fail-closed davranır ve `/health` kapasiteyi raporlar.
- **Öneri (uygulanmadı):** temp dosya + `fsync` + atomik `rename`; açılışta yetim/yarım dosya
  süpürmesi; testte write–sidecar arası crash simülasyonu. Bu fazda kod değişikliği yapılmadı.

---

## 8. Test Matrisi

Tüm komutlar 2026-11-03 UTC 11:39 civarında, `/private/tmp/tz429-release` içinde çalıştırıldı.
Seviyeler: **L1** statik, **L2** birim, **L3** izole entegrasyon/mock/SQLite, **L4** gerçek WhatsApp E2E.

| # | Komut | Seviye | Sonuç | Exit |
|---|---|---|---|---|
| 1 | `node --import ./tests/media-test-register.mjs tests/test-media-store-integrity.mjs` | L2 | 65 assertions passed | 0 |
| 2 | `node --import ./tests/media-test-register.mjs tests/test-media-store-543.mjs` | L2/L3 | 59 assertions passed | 0 |
| 3 | `node --import ./tests/media-test-register.mjs tests/test-media-routes-543.mjs` | L3 | 40 assertions passed | 0 |
| 4 | `node --import ./tests/media-test-register-atomic.mjs tests/test-media-ingestion-atomicity-545.mjs` | L2/L3 | 39 assertions passed | 0 |
| 5 | `node --import ./tests/media-test-register.mjs tests/test-media-routes-545.mjs` | L3 | 61 assertions passed | 0 |
| 6 | `node scripts/test-gateway-auth.mjs` | L2 | fail-closed REST/WS auth passed | 0 |
| 7 | `pytest backend/tests/test_whatsapp_media_tenant_isolation.py backend/tests/test_link_preview_media_tenant_isolation.py -q` | L3 (SQLite) | 21 passed (0.39s) | 0 |
| 8 | `pytest backend/tests/test_whatsapp_live.py -q` | L3 (SQLite) | 61 passed, 2 warnings (2.29s) | 0 |
| 9 | `pytest backend/tests/test_campaign_media.py backend/tests/test_link_preview.py -q` | L3 (SQLite) | 106 passed, 6 warnings (1.75s) | 0 |
| 10 | `node -e "require('./package.json')"` / `node --check` hedefleri | L1 | Parse/sözdizimi OK | 0 |
| 11 | `python -m compileall` hedefleri | L1 | Sözdizimi OK | 0 |

**Çalıştırılamayanlar / sınırlar (gizlenmedi):**

- **Gerçek `express@4` E2E: ÇALIŞTIRILMADI.** `whatsapp-gateway/node_modules` yok; dependency
  kurulumu yasak. Express 4 semantiği, dönen Promise'i yakalamayan sadık host + doğrudan
  `asyncHandler` birim testleriyle temsil edilir; gerçek paketle smoke test önerilir.
- **`npm test` (tam süit): ÇALIŞTIRILMADI.** Aynı bağımlılık eksikliği nedeniyle zincir başta
  kırılır. Beş medya süiti loader/stub ile tek tek çalıştırıldı.
- **PostgreSQL: TEST EDİLMEDİ.** Backend testleri izole **SQLite** üzerindedir; SQLite sonuçları
  PostgreSQL sonucu olarak raporlanmamıştır.
- **L4 (gerçek WhatsApp hesabı): ÇALIŞTIRILMADI.** Yasak.
- **Bağımlılık kaynaklı 2 hata:** `test-quoted-message-extraction.mjs` ve
  `test-view-once-extraction.mjs` → EXIT 1, `ERR_MODULE_NOT_FOUND: @whiskeysockets/baileys`.
  Ortam sınırlamasıdır; ürün hatası olarak sınıflandırılmadı ve düzeltilmedi.

---

## 9. Bağımsız Bulgular ve Yeniden Değerlendirme

| ID | Bulgu | Önem | Durum |
|---|---|---|---|
| **A-1** | `GET /api/v1/campaigns/media/{file_id}` kimlik doğrulaması ve tenant kontrolü yok (`campaigns.py:364-365`; `campaign_media_service.py:178`). `file_id` 64-bit rastgele (`uuid4().hex[:16]`, `:161`), yani tahmin edilemez ama bearer-link'tir; URL sızarsa herkes erişir. Yalnız medya baytları; MIME byte'tan sniff edilir, `nosniff`/CSP vardır. | **MEDIUM** | 5.4.x öncesi, kapsam dışı; düzeltilmedi |
| **A-2** | Sıralı çapraz-oturum aynı `waMessageId` dedupe'ı oturumları ayırmıyor (`media-store.js:780`; lock `:68`). Probe: tek indirme, aynı `media_id`, sidecar `sess-a`; `resolveMediaPath` oturum-agnostik (`:602`). İçerik aynı; sahiplik metadatası çelişir. | **MEDIUM** | 5.4.5 M-1 kapsamı dışında kalan mevcut davranış; düzeltilmedi |
| **A-3** | Crash/yarım dosya dayanıklılığı: temp+rename yok (`:654`), yetim kısmi dosya temizliği yok, sidecar'sız dosya legacy kabul ediliyor (`:636-648`), crash testi yok. Ulaşılabilir yanlış sunum yolu yok. | **MEDIUM** | Yeni gözlem; öneri §7 |
| **A-4** | `ingestLocks` process-local; compose topolojisi tek gateway (`docker-compose.yml:11` sabit `container_name`, replica yok) ama dokümanlar çoklu-instance lease akışı anlatıyor. Ölçeklenirse aynı mesaj iki instance'ta paralel indirilebilir. | **LOW** (koşullu MEDIUM) | Mevcut topoloji tek instance; risk ölçekleme ile |
| **A-5** | Gerçek `express@4` E2E ve tam `npm test` yok; sadık harness ile telafi ediliyor. | **LOW** (doğrulama boşluğu) | Bağımlılık yok; kurulum yasak |
| **A-6** | `/health` auth'suz kapasite sayıları döndürüyor (yol/tenant/PII yok). | **INFO** | Tasarım gereği |

**5.4.2 yeniden değerlendirme — F-10:** PASS. `get_media_bytes` tenant kapsamı, boş kullanıcı
fail-closed, çift sahiplik kontrolü ve unscoped çağrının kaldırılması doğrulandı; 21 test PASS.

**5.4.3 yeniden değerlendirme — F-09 / F-10 / F-12, link-preview, TOCTOU, sidecar:** PASS.
Same-FD hash + post-`fstat` (`media-store.js:465-479`), bozuk sidecar'ın asla legacy sayılmaması
(`:428`, `:620-642`), MIME'ın FD öncesi reddi (`:426-432`), preview proxy tenant zinciri
(`service.py:340-379`) doğrulandı; 59 + 40 test PASS. Uyarı: 543 rota host'u Express 4'ü
maskeleyebilir; bu nedenle Express 4 kanıtı 545 süitine dayandırıldı.

**5.4.4 M-1 / M-2 yeniden değerlendirme:** PASS. M-1 lock kapsamı ve hata temizliği; M-2 tek
terminal yanıt, header retraction, FD/stream kurtarma doğrulandı.

**5.4.5 düzeltmeleri:** PASS. 39 + 61 assertion; FD sızıntısı yok (`opened === closed`),
`unhandledRejection` yok, stale medya header'ı yok.

**Yeni kritik güvenlik açığı:** Bulunmadı. A-1 ve A-2 MEDIUM'dur; BLOCKER/HIGH yoktur. Durma
kuralı gereği denetim burada durduruldu; düzeltme yapılmadı.

---

## 10. Açık Riskler

| Risk | Önem | Etki | 5.5'e etkisi |
|---|---|---|---|
| Campaign medya uç noktası auth'suz (A-1) | MEDIUM | URL sızarsa medya baytlarına anonim erişim; 64-bit id tahmini zor | 5.5 kapsamı değil; ayrı sertleştirme işi olarak planlanmalı |
| Sıralı çapraz-oturum dedupe (A-2) | MEDIUM | İçerik aynı; sahiplik/sidecar metadata'sı yanlış oturumu gösterir; oturum bazlı erişim/retention kararlarını yanıltabilir | 5.5'te oturum kapsamlı dedupe kararı verilmeli |
| Crash yetim dosyaları + legacy kabulü (A-3) | MEDIUM | Disk birikimi; latent doğrulanmamış sunum riski; ulaşılabilir yol yok | 5.5 öncesi temp+rename + startup süpürme değerlendirilmeli |
| Process-local lock (A-4) | LOW (koşullu MEDIUM) | Yalnız çoklu gateway instance'ta çift indirme | Mevcut tek-instance topolojide kabul edilebilir |
| Gerçek Express 4 / PostgreSQL / L4 doğrulaması yok (A-5) | LOW | Ortam kaynaklı doğrulama boşluğu | Deploy öncesi bağımlılıklı ortamda smoke test önerilir |

---

## 11. 5.4.x Kapanış Kararı

**Karar: PASS_WITH_NOTES**

Kabul kriterleri:

| Kriter | Sonuç |
|---|---|
| Tenant testleri geçiyor | **EVET** — 21 passed |
| Hash / same-FD doğrulaması kanıtlı | **EVET** — 65 + 59 + 61 assertion |
| Bozuk sidecar fail-closed | **EVET** — 422, FD açılmıyor |
| Eşzamanlı ingestion çift dosya üretmiyor | **EVET** — 39 assertion |
| Oturumlar karışmıyor | **KISMİ** — eşzamanlı ayrı; sıralı aynı `waMessageId` birleşiyor (A-2, MEDIUM) |
| HTTP hata yolları güvenli | **EVET** — 61 assertion |
| FD sızıntısı yok | **EVET** — opened === closed |
| 5.4.2–5.4.5 testleri geçiyor | **EVET** — beş süit + auth, EXIT 0 |
| BLOCKER/HIGH yok | **EVET** |
| MEDIUM riskler belgeli | **EVET** — A-1, A-2, A-3 |

**Gerekçe:** Kapsam içi düzeltmeler (F-10, F-09/F-12, link-preview, TOCTOU, M-1, M-2) kod ve
test düzeyinde doğrulandı; kapsam içinde BLOCKER/HIGH yok. Üç MEDIUM bulgu ya 5.4.x öncesine ait
(A-1, A-2) ya da öneri niteliğindedir (A-3) ve hiçbiri 5.4.x medya yolunda yeni bir veri sızıntısı
veya yanlış başarı üretmez. Ortam sınırları (gerçek Express 4, `npm test`, PostgreSQL, L4)
açıkça belgelendi; bunlar kritik davranışın doğrulanamadığı anlamına gelmez, çünkü Express 4
semantiği sadık harness ve doğrudan birim testleriyle kapsanmıştır. Bu nedenle BLOCKED/FAIL değil,
**PASS_WITH_NOTES** uygundur.

**Kapanış koşulları (not):**
1. A-1 için campaign medya uç noktasına auth veya imzalı URL eklenmesi ayrı bir sertleştirme
   fazında ele alınmalı.
2. A-2 için sıralı dedupe'ın oturum kapsamlı olup olmayacağı ürün kararı olarak netleştirilmeli.
3. A-3 için temp+rename ve açılış süpürmesi önerilir; bu fazda uygulanmadı.

---

## 12. 5.5 Geçiş Önerisi

Bu denetim **5.5'e otomatik geçiş yapmaz**; karar ve yetki kullanıcıdadır. 5.5'e geçmeden önce
önerilen ön koşullar:

1. Bağımlılıkların kurulu olduğu bir ortamda **gerçek `express@4` smoke testi** ve tam `npm test`.
2. **PostgreSQL** üzerinde backend medya/tenant testlerinin tekrarı (SQLite sonucu yerine geçmez).
3. Operatör yetkisiyle **L4** gerçek WhatsApp medya E2E (gönder/al/önizleme/silme).
4. A-1 (campaign medya auth) ve A-2 (oturum kapsamlı dedupe) için ürün kararı.
5. A-3 için atomik yazma (temp+rename) ve startup orphan süpürme değerlendirmesi.

Bu maddeler tamamlanmadan 5.5 kapsamına girilmemesi; girilirse yukarıdaki risklerin kabul edildiğinin
açıkça kayda geçirilmesi önerilir.

---

**Denetim bütünlüğü:** Başlangıç ve bitiş HEAD aynı (`978ddf5...`), branch aynı, staged 0, ürün
dosyalarında değişiklik yok, commit/push/deploy yapılmadı. Bu rapor salt-okuma denetimin çıktısıdır.
