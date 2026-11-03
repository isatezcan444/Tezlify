# AŞAMA 5.4.4 — 5.4.2 + 5.4.3 BİRLEŞİK MEDYA DEĞİŞİKLİKLERİ BAĞIMSIZ SON DENETİMİ

**Tür:** Read-only audit / bağımsız doğrulama  
**Çalışma alanı:** `/private/tmp/tz429-release`  
**Tarih:** 2026-11-03  
**Ürün kodu değişikliği:** Yok (yalnızca bu rapor dosyası oluşturuldu)

---

## 1. Başlangıç ve Bitiş Git Durumu

| Öğe | Başlangıç | Bitiş |
|---|---|---|
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Staged değişiklik | Yok | Yok |
| Modified | 9 | 9 |
| Untracked | 9 | 10 (bu rapor eklendi) |
| Commit / push / deploy | Yapılmadı | Yapılmadı |

5.4.2 ve 5.4.3 değişikliklerinin tamamı korundu; hiçbir dosya değiştirilmedi, silinmedi, taşınmadı veya geri alınmadı. Ana worktree'ye ve diğer worktree'lere dokunulmadı.

Başlangıçta ölçülen durum:

```text
M backend/app/api/v1/endpoints/whatsapp.py
M backend/app/services/link_preview/service.py
M backend/app/services/whatsapp/orchestration/messaging.py
M backend/app/services/whatsapp_gateway.py
M backend/tests/test_whatsapp_live.py
M whatsapp-gateway/package.json
M whatsapp-gateway/src/index.js
M whatsapp-gateway/src/media/media-store.js
M whatsapp-gateway/src/session-manager.js
?? backend/tests/test_link_preview_media_tenant_isolation.py
?? backend/tests/test_whatsapp_media_tenant_isolation.py
?? whatsapp-gateway/src/media/media-routes.js
?? whatsapp-gateway/tests/media-test-loader.mjs
?? whatsapp-gateway/tests/media-test-register.mjs
?? whatsapp-gateway/tests/stubs/
?? whatsapp-gateway/tests/test-media-routes-543.mjs
?? whatsapp-gateway/tests/test-media-store-543.mjs
?? whatsapp-gateway/tests/test-media-store-integrity.mjs
```

`reports/` dizini başlangıçta mevcut değildi; bu rapor için oluşturuldu.

---

## 2. 5.4.2 + 5.4.3 Artifact Envanteri

Tüm beklenen dosyalar mevcut:

| Dosya | Satır |
|---|---:|
| [backend/app/services/link_preview/service.py](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py) | 475 |
| [backend/app/api/v1/endpoints/whatsapp.py](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/whatsapp.py) | 1487 |
| [backend/app/services/whatsapp/orchestration/messaging.py](file:///private/tmp/tz429-release/backend/app/services/whatsapp/orchestration/messaging.py) | 1483 |
| [backend/app/services/whatsapp_gateway.py](file:///private/tmp/tz429-release/backend/app/services/whatsapp_gateway.py) | 696 |
| [whatsapp-gateway/src/media/media-store.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js) | 934 |
| [whatsapp-gateway/src/media/media-routes.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js) | 131 |
| [whatsapp-gateway/src/session-manager.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/session-manager.js) | 4441 |
| [whatsapp-gateway/src/index.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/index.js) | 843 |
| [backend/tests/test_whatsapp_media_tenant_isolation.py](file:///private/tmp/tz429-release/backend/tests/test_whatsapp_media_tenant_isolation.py) | 290 |
| [backend/tests/test_link_preview_media_tenant_isolation.py](file:///private/tmp/tz429-release/backend/tests/test_link_preview_media_tenant_isolation.py) | 429 |
| [backend/tests/test_whatsapp_live.py](file:///private/tmp/tz429-release/backend/tests/test_whatsapp_live.py) | modified |
| [whatsapp-gateway/tests/test-media-store-integrity.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-store-integrity.mjs) | 337 |
| [whatsapp-gateway/tests/test-media-store-543.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-store-543.mjs) | 494 |
| [whatsapp-gateway/tests/test-media-routes-543.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-routes-543.mjs) | 395 |
| [whatsapp-gateway/tests/media-test-loader.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/media-test-loader.mjs) | 17 |
| [whatsapp-gateway/tests/media-test-register.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/media-test-register.mjs) | 3 |
| `whatsapp-gateway/tests/stubs/baileys.mjs`, `stubs/uuid.mjs` | mevcut |

Bağımlılık durumu: `whatsapp-gateway/node_modules` **yok**. Node medya testleri yerel `media-test-register.mjs` resolve hook'u ve `tests/stubs/` ile çalıştırıldı. Tam gateway test matrisi bu worktree'de çalıştırılamadı.

Test DB: `/tmp/tezlify_544_verify.db` (`scripts/provision_test_db.py` ile 34 tablo + startup migration parity). Gerçek medya klasörüne yazılmadı.

---

## 3. Tenant İzolasyonu

### 3.1 `get_media_bytes` (5.4.2, F-10)

Çağrı zinciri: `GET /api/v1/whatsapp/media/{media_id}` → [whatsapp.py:1162](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/whatsapp.py#L1162) → `whatsapp_service.get_media_bytes` → [messaging.py:1355](file:///private/tmp/tz429-release/backend/app/services/whatsapp/orchestration/messaging.py#L1355).

| Senaryo | Sonuç | Kanıt |
|---|---|---|
| A kendi medyasını alır | **PASS** | Tenant-scoped `Message` sorgusu + gateway'e yalnızca bir kez gidiliyor; test `test_tenant_can_fetch_own_media` |
| A, B'nin `media_id`'sini bilse de erişemez | **PASS** | Sorgu `get_user_filter` ile kapsamlı; `row is None` → gateway çağrısı yok; test `test_tenant_cannot_fetch_foreign_media_id` |
| A, B'nin `wa_message_id`'sini bilse de erişemez | **PASS** | `test_tenant_cannot_fetch_foreign_wa_message_id` |
| Boş/eksik `user_id` fail-closed | **PASS** | [messaging.py:1369](file:///private/tmp/tz429-release/backend/app/services/whatsapp/orchestration/messaging.py#L1369); DB'ye bile gidilmiyor |
| Mesaj sahibi ile konuşma sahibi uyuşmazsa red | **PASS** | [messaging.py:1389](file:///private/tmp/tz429-release/backend/app/services/whatsapp/orchestration/messaging.py#L1389) ve [1394](file:///private/tmp/tz429-release/backend/app/services/whatsapp/orchestration/messaging.py#L1394); test mevcut |
| DB hatası yetkilendirmeyi atlamaz | **PASS** | Hata yukarı fırlar; gateway çağrısı yapılmaz; `test_db_error_does_not_bypass_authorization` |
| Yetkisiz durumda gateway çağrısı yok | **PASS** | Tüm negatif testlerde `fake_gw.calls == []` ve `fetch_media_unscoped` çağrı sayacı 0 |
| Legacy/NULL sahiplik | **PASS (belgeli sınır)** | Üretimde `get_user_filter` NULL'a izin vermez; yalnızca `PYTEST_CURRENT_TEST` altında NULL satırlar kabul edilir ([auth.py:229](file:///private/tmp/tz429-release/backend/app/core/auth.py#L229)). Açık `_same_tenant` kontrolü NULL'u atlar; bu yalnızca test fixture legacy davranışıdır, üretimde NULL satır DB filtresinden geçemez |
| Hata yanıtı metadata sızdırmaz | **PASS** | `LookupError("Medya bulunamadi")`; dosya adı/başka tenant kimliği yok; test filename sızıntısını ayrıca doğruluyor |

Gateway oturumu `conversation_gateway_id(db, user_id, conv)` ile çözülür; `require_user_session` çağıran kullanıcıya kapsamlıdır ([sessions.py:44](file:///private/tmp/tz429-release/backend/app/services/whatsapp/repositories/sessions.py#L44)). Gateway'e giden yol oturum kapsamlı `/sessions/{gateway_id}/media/{media_id}` yoludur; tenant'sız `fetch_media_unscoped` **üretimde çağrılmıyor** (yalnızca testte).

### 3.2 `get_preview_image_bytes` (5.4.3)

Çağrı zinciri: `GET /api/v1/whatsapp/link-preview/image` → [whatsapp.py:1215](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/whatsapp.py#L1215) → [service.py:320](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py#L320).

- `lookup_preview_for_proxy` tek başına yetki kararı değildir ve tenant kolonu olmayan global `LinkPreview` satırı döner; dokümantasyonu bunu açıkça belirtir ([service.py:298](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py#L298)).
- Dahili medya (`/api/v1/whatsapp/media/...`) için `Message.media_id` sorgusu `get_user_filter` ile kapsamlıdır ([service.py:358](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py#L358)); mesaj ve konuşma sahipliği ayrıca açık `_same_tenant` ile kontrol edilir ([369](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py#L369), [374](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py#L374)).
- `gateway_id` çağıranın doğrulanmış `user_id`'si ile çözülür ([service.py:378](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py#L378)).
- `user_id` yok/boş → DB'ye dokunmadan fail-closed ([service.py:340](file:///private/tmp/tz429-release/backend/app/services/link_preview/service.py#L340)).
- DB hatası yetkilendirmeyi atlamaz; hata yayılır, gateway çağrılmaz.
- Testler: sahip erişimi, yabancı hash, bilinmeyen hash, boş tenant, DB hatası, filtre sızsa dahi açık sahiplik reddi, konuşma/mesaj uyuşmazlığı, gövdesiz önizleme, harici görsel yolu. Hepsi gerçek servis + izole SQLite; gateway yalnızca "çağrılmadı" kanıtı için mock.

**Sonuç: PASS.** Bilinen tasarım sınırı: harici (WhatsApp dışı) görseller global `LinkPreview` önbelleğinden gelir; hash'i bilen başka bir tenant harici görseli çekebilir. 64 hex hash tahmin edilemez ve hash yalnızca kullanıcının görebildiği mesajların önizlemelerinde istemciye verilir; 5.4.3'ün dahili medya sınırı bundan etkilenmez (LOW, tasarım notu).

### 3.3 Diğer medya erişim yolları

- `fetch_media_unscoped` ([whatsapp_gateway.py:656](file:///private/tmp/tz429-release/backend/app/services/whatsapp_gateway.py#L656)) üretimde çağrılmıyor; yalnızca `test_whatsapp_live.py` kullanıyor. Tenant'sız bir yardımcı olarak kalması gelecekteki yanlış kullanım riskidir (LOW).
- Kampanya medyası `GET /api/v1/campaigns/media/{file_id}` ([campaigns.py:364](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/campaigns.py#L364)) WhatsApp medyası değildir ve bu değişiklik kümesinin dışındadır. İncelendi: endpoint'te auth dependency yok ve tenant kontrolü yok; rastgele 64-bit `file_id` ile erişilir. Bu, 5.4.2/5.4.3 regresyonu değil, ayrı ve önceden var olan bir bulgudur (LOW/MEDIUM, kapsam dışı not).

---

## 4. FD / Hash / Stream Güvenlik Analizi

[`openVerifiedMedia`](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L396) akışı:

1. `fs.openSync(filePath, 'r')` → tek FD.
2. `fstatSync(fd)` → düzenli dosya mı, boyut.
3. Sidecar meta (asenkron) → bozuk ise `META_CORRUPT`.
4. Hash varsa `hashFd(fd)` — **açılan FD ile aynı FD** üzerinden SHA-256 ([media-store.js:434](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L434)).
5. Hash sonrası ikinci `fstatSync(fd)`; size/mtime/ctime değiştiyse `CHANGED_DURING_VERIFY` ([440](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L440)).
6. Başarıda **aynı FD** ile `createReadStream(null, { fd, autoClose: true, start: 0, end: size-1 })` ([460](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L460)). Yol yeniden açılmaz.

| Soru | Sonuç | Kanıt |
|---|---|---|
| Hash FD'si = açılan FD | **PASS** | `hashFd(fd)` |
| Stream FD'si = doğrulanan FD | **PASS** | `createReadStream({fd})`; store testi yol `rename` saldırısını doğruluyor |
| Hata yollarında FD kapanıyor | **PASS (bir istisna)** | ENOENT/fstat/META_CORRUPT/SIZE_MISMATCH/HASH_MISMATCH/CHANGED yollarında `closeSync`; catch bloğu da kapatıyor. **Ancak** başarılı `openVerifiedMedia` sonrası header yazımı istisna atarsa stream/FD kapatılmıyor: bkz. Bulgu M-2 |
| Erken client disconnect | **KOD PASS / RUNTIME UNVERIFIED** | [media-routes.js:103](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L103) `res.on('close')` → `stream.destroy()`; bu davranış için gerçek HTTP testi yok |
| Doğrulama sırasında dosya değişirse | **PASS** | Post-hash `fstat`; `CHANGED_DURING_VERIFY` testi mevcut |
| Bozuk sidecar legacy'ye düşebilir mi? | **PASS** | `metadataCorrupt` bayrağı ([media-store.js:591](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L591)) taramayı atlar, indekse yazmaz; taze store'da `META_CORRUPT` → route 422. 5.4.3 review'ında bulunan HIGH bu şekilde kapatılmış |
| Hash'siz legacy işaretli mi? | **PASS** | `X-Media-Integrity: legacy`; route testi doğruluyor |
| Path traversal yeterli mi? | **PASS (istek kimliği) / LOW (sidecar yolu)** | `isSafeMediaKey` `/`, `\`, NUL, `.`, `..` reddeder; fallback tam kök ad eşleşmesi; `../etc/passwd` ve prefix testleri var. Sidecar içindeki `filePath` mediaDir içinde olduğu doğrulanmıyor: bkz. Bulgu L-2 |

**Yerinde inode yazımı sınırı:** Son `fstat` sonrası, aynı inode'a yerel dosya sistemi erişimiyle yapılan bir yazma salt-FD doğrulamasıyla tamamen engellenemez. Pencere çok küçüktür ve stream aynı FD'den okuduğu için yol değiştirme saldırısı etkisizdir; ancak yerel yazma yetkisi olan bir aktöre karşı garanti değildir. Bu sınır küçültülmemeli, açıkça raporlanmalıdır (LOW/UNVERIFIED residual).

---

## 5. Sidecar / Index / Restart Analizi

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| RAM index sınırı korunuyor | **PASS** | `MEDIA_INDEX_MAX`; `evictOverflowMedia` ([media-store.js:261](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L261)); testler `MEDIA_INDEX_MAX: 1/0` |
| Eviction disk dosyasını silmiyor | **PASS** | Yalnızca Map'ten çıkarır; yorum ve kod; `clearSessionMedia` no-op ([883](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L883)) |
| Index dışı medya sidecar'dan bulunuyor | **PASS** | `resolveMediaPath` adım 1-2; route test fixture'ı RAM'den evict edilmiş medyayı HTTP üzerinden buluyor |
| Bozuk metadata güvenli reddediliyor | **PASS** | `META_CORRUPT` → 422; store + route testleri; bozuk sidecar legacy'ye düşmüyor |
| Request path'te senkron sidecar taraması | **PASS** | HTTP yolu `resolveMediaPath` (async); >5100 sidecar testinde senkron fs çağrısı 0. `getMediaPath` senkron taraması hâlâ var ama HTTP route'u kullanmıyor |
| Büyük sidecar sayısında event loop | **PASS (tarama)** | 64'lük partiler + `setImmediate`; >5100 sidecar testi, event loop tick'leri >0 |
| Restart sonrası medya bulunuyor | **PASS** | Taze store + sidecar/waId taraması; restart testi |
| Aynı medya yeniden işlenince duplicate | **PARTIAL / FAIL (kayıt yokken)** | Mevcut kopya varsa dedupe çalışıyor. **Kopya yokken eşzamanlı çağrılar duplicate üretiyor** (Bulgu M-1) |
| Process başlangıç timestamp sınırı | **PASS (sınırla)** | `ts < processStartedAtMs` ise taranır; eşit/yeni timestamp taranmaz (bilinçli canlı trafik ödüncü). Test: canlı mesajda sidecar okuması 0 |
| Eşzamanlı replay güvenli mi? | **PARTIAL** | Tarama promise'i `dedupeScans` ile birleşiyor; mevcut kayıt için güvenli. Kayıt yokken indirme+yazma kilitsiz (M-1) |

**M-1 kanıtı (geçici /tmp probu, ürün kodu değişmedi):**

- Geçmiş timestamp'li aynı `waMessageId`, diskte kopya yok, 3 eşzamanlı `storeIncomingMedia`:
  `uniqueIds: 3`, `dataFiles: 3`, `mediaByWaId` son yazılan ID'yi gösteriyor.
- Canlı timestamp'li aynı mesaj, 2 eşzamanlı çağrı: `uniqueIds: 2`, `dataFiles: 2`.

Yani 5.4.3 raporundaki "eşzamanlı replay güvenli" ifadesi **yalnızca mevcut kopya varken** doğrudur. Kopya yokken eşzamanlı işleme iki/üç dosya ve birden fazla `media_id` üretir; DB bunlardan birine bağlanır, diğerleri referanssız disk artığı olur. Veri kaybı veya tenant sızıntısı yoktur; disk büyümesi ve kimlik tutarsızlığı vardır. Bu aşamada düzeltilmedi (read-only).

---

## 6. HTTP Sözleşmesi

### 6.1 Gateway gerçek route'ları

Gerçek `registerMediaRoutes` + gerçek `requireGatewayToken` + native HTTP sunucusu ile çalıştırıldı ([test-media-routes-543.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-routes-543.mjs)). Route'lar `requireGatewayToken` sonrasında mount ediliyor ([index.js:229](file:///private/tmp/tz429-release/whatsapp-gateway/src/index.js#L229), [759](file:///private/tmp/tz429-release/whatsapp-gateway/src/index.js#L759)); unscoped route ayrıca kendi Bearer/secret kontrolünü yapıyor.

| Durum | Beklenen | Ölçülen |
|---|---|---|
| Geçerli medya (unscoped + session route) | 200 | 200; gövde hash'i sidecar hash'ine eşit |
| Eksik/yanlış token | 401 | 401 (her iki route) |
| Bilinmeyen session | 404 | 404 `Session not found` |
| Bilinmeyen medya | 404 | 404 `MEDIA_EXPIRED` |
| Hash uyuşmazlığı | 422 | 422 `MEDIA_CORRUPTED`, bozuk bayt dönmüyor |
| Bozuk sidecar (taze store) | 422 | 422 `MEDIA_CORRUPTED`, bayt dönmüyor |
| Çözümleme sonrası dosya kaybolması | 404 | 404 `MEDIA_EXPIRED` |
| Doğrulama istisnası | 500 | 500 `MEDIA_VERIFY_ERROR`, yol sızmıyor |
| Stream başlangıç hatası | 500 | 500 `MEDIA_STREAM_ERROR`; eski `Content-Length` kaldırılıyor |
| HEAD | 200, gövdesiz | 200, gövde 0, `Content-Length` korunuyor |
| Sıfır bayt | 200, boş | 200, `Content-Length: 0`, asılmıyor |
| Legacy (hash yok) | 200 + legacy | 200, `X-Media-Integrity: legacy` |
| Gateway upstream 5xx (backend) | 502 | 502 (`test_gateway_5xx_still_maps_to_502`) |
| Gateway 422 (backend) | 422, 502 değil | 422 + `no-store` ([whatsapp.py:1186](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/whatsapp.py#L1186)) |

**Erken client disconnect:** Kod yolu mevcut, gerçek HTTP testi yok → **UNVERIFIED**.

**M-2 (yeni bulgu):** Sidecar'daki `mimeType` CRLF/geçersiz header karakteri içeriyorsa `res.setHeader('Content-Type', ...)` `ERR_INVALID_CHAR` atar ([media-routes.js:68](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L68)). Session route guard'ı 500 döner ama açılmış stream/FD kapatılmaz; unscoped route'ta guard olmadığı için istek yanıtsız asılı kalır ve `unhandledRejection` oluşur ([media-routes.js:119](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L119)). Prob: 5 session-route isteğinde FD sayısı 16 → 20 (+4); unscoped istek `timeout`, `unhandledRejection: 1`. Ayrıntı ve sınıflandırma Bölüm 8'de.

### 6.2 Preview endpoint hata sözleşmesi

`get_link_preview_image` yalnızca `LookupError` ve generic `Exception` yakalar; ikisini de 404'e çevirir ve generic dalda `str(exc)` istemciye `detail` olarak gider ([whatsapp.py:1238-1244](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/whatsapp.py#L1238)). Dahili medya için gateway 422/5xx bu yüzden 422/502 değil 404 olur; ayrıca exception metni (ör. iç gateway host'u) sızabilir. Fail-closed güvenlik açısından sorun değildir; sözleşme tutarlılığı ve bilgi sızıntısı açısından **LOW** bulgudur (L-1).

---

## 7. Test Matrisi ve Gerçek Komut Çıktıları

Tüm backend testleri izole SQLite `/tmp/tezlify_544_verify.db` üzerinde; Node testleri geçici `mkdtemp` medya klasörlerinde çalıştı. Gerçek medya klasörüne yazılmadı.

| # | Komut | Exit | Passed | Failed | Skipped | Seviye |
|---|---|---:|---:|---:|---:|---|
| 1 | `node --import ./tests/media-test-register.mjs tests/test-media-store-integrity.mjs` | 0 | 65 assertion | 0 | 0 | L2 |
| 2 | `node --import ./tests/media-test-register.mjs tests/test-media-store-543.mjs` | 0 | 59 assertion | 0 | 0 | L2 |
| 3 | `node --import ./tests/media-test-register.mjs tests/test-media-routes-543.mjs` | 0 | 40 assertion | 0 | 0 | L2 |
| 4 | `pytest test_whatsapp_live.py test_whatsapp_media_tenant_isolation.py test_link_preview_media_tenant_isolation.py -q` | 0 | 82 | 0 | 0 | L2 |
| 5 | `pytest test_link_preview.py test_campaign_media.py -q` | 0 | 106 | 0 | 0 | L2 |
| 6 | `pytest test_whatsapp_faz10_preview_groupnames.py test_whatsapp_group_reaction_preview.py test_whatsapp_pure_preview.py -q` | 0 | 40 | 0 | 0 | L2 |
| 7 | `pytest test_whatsapp_gateway_ack.py test_whatsapp_gateway_boundary.py test_whatsapp_gateway_health.py test_whatsapp_gateway_liveness.py test_whatsapp_phase2_a_gateway_behavior.py -q` | 1 | 45 | 0 | 0 | L2 |
| 8 | `npm test` (tam gateway matrisi) | — | — | — | — | **NOT RUN** |
| 9 | PostgreSQL entegrasyon testleri | — | — | — | — | **NOT TESTED** |
| 10 | Gerçek WhatsApp L4 | — | — | — | — | **NOT RUN** |

Test 7'deki iki `ERROR`, ürün kodu hatası değil ortam eksikliğidir: `test_whatsapp_phase2_a_gateway_behavior.py` Node harness'ı `uuid` paketini bulamadı (`ERR_MODULE_NOT_FOUND`; `node_modules` yok). Kalan 45 test geçti. Dependency kurulmadı.

**Test kalitesi notları:**

- Backend tenant testleri gerçek `AsyncSessionLocal` + gerçek servis üzerinde; gateway mock'u yalnızca "çağrılmadı" kanıtı için. Vacuous assertion görülmedi.
- Route harness'ı gerçek handler'ları, gerçek auth middleware'ini ve gerçek HTTP'yi kullanıyor. Ancak harness, Express 4'ün aksine handler promise'ini `.catch()` ile sarıyor ([test-media-routes-543.mjs:93](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-routes-543.mjs#L93)); bu yüzden M-2'deki unscoped asılı kalma/`unhandledRejection` davranışı suite'te görünmez.
- Restart/concurrent testi mevcut kopya senaryosunu doğruluyor; kopya yokken duplicate senaryosu suite'te yok (M-1 bu yüzden yakalanmamış).
- Erken client disconnect, CRLF mime, sidecar `filePath` kaçışı ve preview gateway 422 eşlemesi için test yok.

---

## 8. Bağımsız İnceleme Bulguları

| ID | Önem | Bulgu | Konum |
|---|---|---|---|
| M-1 | **MEDIUM** | Aynı `waMessageId` için eşzamanlı `storeIncomingMedia` çağrılarında, diskte/RAM'de mevcut kopya yokken indirme+yazma kilitsizdir. 2-3 eşzamanlı çağrı 2-3 dosya ve farklı `media_id` üretir; yalnızca biri DB'ye bağlanır, diğerleri referanssız kalır. Mevcut kopya varsa dedupe doğru çalışır. | [media-store.js:747](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L747), [776](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L776), [624](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L624) |
| M-2 | **MEDIUM** (koşullu) | Sidecar `mimeType` CRLF/geçersiz header karakteri taşırsa `setHeader` `ERR_INVALID_CHAR` atar. Session route 500 döner ama stream/FD kapatılmaz (istek başına FD sızıntısı); unscoped route'ta catch olmadığı için istek asılı kalır ve unhandled rejection oluşur. Sağlayıcı `mimetype`'ı doğrulamıyorsa HIGH'a yükselir; L4 ile doğrulanmadı. | [media-routes.js:68](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L68), [119](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L119), [media-store.js:453](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L453) |
| L-1 | **LOW** | Preview proxy gateway 422/5xx'i 404'e çevirir ve generic exception metnini `detail` olarak döndürür; medya endpoint'inin 422/502 sözleşmesiyle tutarsız, iç URL sızıntısı mümkün. | [whatsapp.py:1238](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/whatsapp.py#L1238) |
| L-2 | **LOW** | Sidecar içindeki `filePath` mediaDir içinde mi diye doğrulanmıyor; `resolveMediaPath`/`openVerifiedMedia` bu yolu açar. Media dizinine yazma yetkisi gerektirir; savunma derinliği eksiği. | [media-store.js:92](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L92), [585](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L585), [396](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L396) |
| L-3 | **LOW** | Gateway'de canlı oturum yoksa session route 404 döner; diskte medya olsa da backend erişemez. Tenant-güvenli tasarımın kabul edilen availability ödüncü; veri kaybı yok. | [media-routes.js:15](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L15) |
| L-4 | **LOW** | `fetch_media_unscoped` üretimde ölü ama tenant'sız yardımcı olarak duruyor; gelecekteki yanlış kullanım riski. | [whatsapp_gateway.py:656](file:///private/tmp/tz429-release/backend/app/services/whatsapp_gateway.py#L656) |
| L-5 | **LOW** | `/health` kimlik doğrulamasız ve artık `media_capacity` (dosya/sidecar sayısı, boş/toplam bayt) döndürüyor; dosya adı/yol yok. | [index.js:222](file:///private/tmp/tz429-release/whatsapp-gateway/src/index.js#L222) |
| L-6 | **LOW / kapsam dışı** | Kampanya medya endpoint'i auth ve tenant kontrolü olmadan `file_id` ile bayt döndürüyor; WhatsApp 5.4.2/5.4.3 değişikliği değil, ayrı önceden var olan yol. | [campaigns.py:364](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/campaigns.py#L364) |
| P-1 | **PARTIAL** | Başlangıçta senkron tüm-dizin taraması ([media-store.js:203](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L203)) ve `storeMediaBuffer`'ın senkron `writeFileSync` çağrısı ([624](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L624)) event loop'u bloklayabilir. 5.4.3 kapsamı sidecar aramasıydı; bu noktalar önceden var olan ve değiştirilmeyen davranıştır. | code review |
| U-1 | **UNVERIFIED** | Erken client disconnect'te FD kapanışı gerçek HTTP testiyle kanıtlanmadı; kod yolu mevcut. | [media-routes.js:103](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L103) |
| U-2 | **UNVERIFIED** | CRLF/geçersiz `mimetype`'ın gerçek WhatsApp sağlayıcısından geçip geçmediği (L4) test edilmedi. | — |

BLOCKER veya HIGH sınıfında **doğrulanmış** bulgu yoktur. M-2 koşullu olarak HIGH'a yükselebilir; gerçek sağlayıcı davranışı bilinmediği için MEDIUM'da tutuldu.

---

## 9. PostgreSQL ve Gerçek WhatsApp Doğrulama Sınırları

- Tüm backend testleri **SQLite** üzerinde çalıştı. PostgreSQL'e bağlanılmadı, migration rehearsal yapılmadı, production'a dokunulmadı. **PostgreSQL: NOT TESTED.**
- SQLite'ta UUID saklama biçimi, NULL filtre davranışı ve eşzamanlılık kilitleri PostgreSQL'den farklıdır. Özellikle:
  - `get_user_filter`'ın UUID karşılaştırmaları PostgreSQL native UUID'de farklı davranabilir (kod cast ile ele alıyor; runtime doğrulanmadı).
  - Eşzamanlı `storeIncomingMedia` yarışı PostgreSQL ile değil, Node bellek/disk düzeyinde incelendi; DB tarafı bu yarışta devrede değildir.
- Gerçek WhatsApp hesabı, gerçek provider, gerçek medya indirme veya gerçek session lifecycle **çalıştırılmadı**. **L4: NOT RUN.**
- Bu nedenle L4 gerektiren hiçbir davranış PASS sayılmadı; yalnızca L1/L2 kanıtı sunuldu.

---

## 10. Açık Riskler

1. **Eşzamanlı duplicate (M-1):** Aynı mesajın eşzamanlı işlenmesi, kopya yokken referanssız dosya artığı ve çoklu `media_id` üretir. Disk büyümesi kalıcıdır (otomatik silme yok).
2. **Header/FD (M-2):** Geçersiz `mimeType` ile session route FD sızdırır, unscoped route yanıtsız kalır. Sağlayıcı mimetype'ı doğrulamıyorsa dışarıdan tetiklenebilir; L4 doğrulanmadı.
3. **Preview hata eşlemesi (L-1):** Gateway 422/5xx preview ucunda 404 olur; exception metni sızabilir.
4. **Sidecar `filePath` güveni (L-2):** Media dizinine yazma yetkisi olan aktör keyfi okunabilir dosyaya işaret edebilir; hash meta'sını da yazabildiği için doğrulama engel olmaz.
5. **Canlı oturum yokluğu (L-3):** Gateway restart sonrası medya, oturum yeniden bağlanana kadar 404 döner.
6. **Yerinde inode yazımı:** Son `fstat` sonrası yerel yazma tamamen engellenemez; aynı FD streaming yol değiştirmeyi engeller, içerik değişimini değil.
7. **Test kapsamı:** Node tam matrisi (`npm test`), PostgreSQL ve L4 çalıştırılmadı; early disconnect testi yok.
8. **Kapsam dışı kampanya medyası (L-6):** Auth/tenant kontrolü olmayan ayrı endpoint; bu aşamada değerlendirilmedi, takip gerektirir.

---

## 11. Genel Karar

**PASS_WITH_NOTES**

Gerekçe:

- Tenant izolasyonu (`get_media_bytes` ve `get_preview_image_bytes`) kaynak ve test düzeyinde doğrulandı; yabancı `media_id`/hash ile erişim yok, yetkisiz durumda gateway çağrısı yok, DB hatası yetkilendirmeyi atlamıyor.
- Verify→send TOCTOU, aynı FD üzerinden hash+stream ve post-hash `fstat` ile kapatılmış; yol değiştirme saldırısı testle doğrulandı.
- Bozuk sidecar legacy'ye düşmüyor; legacy dosyalar açıkça `legacy` işaretli ve hash-doğrulanmış sayılmıyor.
- Sidecar araması istek yolunda asenkron; >5100 sidecar'da event loop bloke olmuyor; RAM sınırı korunuyor, eviction disk silmiyor.
- Gateway HTTP sözleşmesi (200/401/404/422/500) ve backend 422≠502 eşlemesi gerçek route/handler testleriyle doğrulandı.
- Ancak iki MEDIUM bulgu açıktır: kopya yokken eşzamanlı duplicate (M-1) ve geçersiz `mimeType` kaynaklı FD sızıntısı/asılı istek (M-2). Bunlar bu read-only aşamada düzeltilmedi. Ayrıca PostgreSQL ve L4 doğrulaması yoktur.

Bu nedenle sonuç **PASS değil**, **PASS_WITH_NOTES**'tır. M-1 ve M-2 bir sonraki kodlama aşamasında önceliklendirilmelidir; L-1 ve L-2 savunma derinliği olarak ele alınmalıdır.
