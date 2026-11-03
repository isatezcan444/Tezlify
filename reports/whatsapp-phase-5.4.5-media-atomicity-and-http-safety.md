# AŞAMA 5.4.5 — MEDYA INGESTION ATOMİKLİĞİ VE HTTP HATA GÜVENLİĞİ

**Tür:** Dar kapsamlı kodlama + regresyon testi  
**Çalışma alanı:** `/private/tmp/tz429-release`  
**Branch:** `release/backend-only-seq-safety`  
**Tarih:** 2026-11-03 (ölçümler 14:25 +03)  
**Kapsam:** Yalnızca M-1 (eşzamanlı ingestion atomikliği) ve M-2 (HTTP/FD hata güvenliği). Yeni altyapı, DB migration, dependency, frontend veya mimari değişiklik yok.

---

## 1. Başlangıç ve Bitiş Git Durumu

| Öğe | Başlangıç | Bitiş |
|---|---|---|
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Staged değişiklik | Yok | Yok |
| Modified | 9 | 9 |
| Untracked giriş | 10 | 14 |
| Commit / push / deploy | Yapılmadı | Yapılmadı |

5.4.2, 5.4.3 ve 5.4.4 artifact'larının tamamı korundu. Hiçbir dosya geri alınmadı, üzerine yazılmadı, silinmedi veya taşınmadı. `git reset`, `git clean`, `git stash`, `git checkout`, `git rebase`, `git merge`, `git add .`, `git add -A` kullanılmadı. Ana worktree'ye, diğer worktree'lere ve production'a dokunulmadı. Dependency kurulmadı, lockfile değiştirilmedi. Gerçek medya dosyası silinmedi; otomatik retention/disk temizliği eklenmedi.

Bu aşamada yeni untracked girişler yalnızca test altyapısıdır:

```text
?? whatsapp-gateway/tests/media-test-loader-atomic.mjs
?? whatsapp-gateway/tests/media-test-register-atomic.mjs
?? whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs
?? whatsapp-gateway/tests/test-media-routes-545.mjs
```

`reports/` dizini zaten untracked olduğu için bu rapor ayrı bir giriş sayılmadı; giriş sayısı 10 → 14 oldu. Modified sayısı değişmedi (9): bu aşamada [media-store.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js) ve [package.json](file:///private/tmp/tz429-release/whatsapp-gateway/package.json) zaten modified durumdaydı; `media-routes.js` ise 5.4.3'ten beri untracked.

---

## 2. M-1 Kök Nedeni

Eski `storeIncomingMedia` akışı bir **check-then-act** yarışıydı:

1. `findExistingMediaByWaId` / RAM indeksi ile "bu mesaj daha önce indirildi mi?" kontrolü,
2. kontrolün boş dönmesi hâlinde `downloadMediaMessage` ile indirme,
3. `storeMediaBuffer` içinde **her çağrı için yeni `uuidv4()`** ile yazma.

Aynı `waMessageId` için iki çağrı aynı anda kontrolü geçtiğinde ikisi de indiriyor ve iki ayrı `media_id` + iki ayrı dosya üretiyordu. Sonuç: gereksiz CDN trafiği, çift disk kullanımı ve aynı mesaj için birden fazla kalıcı medya kaydı. RAM dedupe ve restart sonrası disk dedupe yalnızca **sıralı** çağrıları kapsıyordu; eşzamanlı çağrıları kapsamıyordu.

Ek olarak kilit anahtarının yalnızca `waMessageId` olması, aynı mesaj kimliği farklı oturum/tenant'larda görünürse bir hesabın medyasının diğerine dönmesine yol açabilirdi. Bu nedenle kapsam dar tutulmadı.

---

## 3. M-1 Tasarımı

[media-store.js:66](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L66) civarında süreç içi, anahtar bazlı bir in-flight haritası eklendi:

```js
const ingestLocks = new Map();

function ingestLockKey(session, waMessageId) {
  const scope = session?.id ? String(session.id) : '';
  return `${scope}\u0000${String(waMessageId)}`;
}
```

[media-store.js:922](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L922) `storeIncomingMedia` artık:

- Anahtar `(session.id, waMessageId)`; **global kilit yok**, farklı kimlikler paralel.
- Aynı anahtar için ikinci çağrı yeni indirme başlatmaz; **aynı Promise'i bekler** (`if (pending) return await pending`).
- İlk çağrı `ingestIncomingMedia`'yı başlatır ve Promise'i haritaya yazar. `get` ile `set` arasında `await` yoktur; Node'un tek iş parçacıklı modelinde bu bölüm atomiktir.
- `finally` yalnızca **hâlâ kendi kaydıysa** siler: `if (key && task && ingestLocks.get(key) === task)`. Gelecekteki bir sahip varsa dokunulmaz.
- Başarısızlıkta bekleyen çağrılar aynı reddedilen Promise'i bekler; her biri kendi try/catch'inde `null` döner, asla asılı kalmaz.
- Eski "asla fırlatma" sözleşmesi korunur: `key.id` getter'ı gibi beklenmedik throw'lar `catch` ile `null`'a çevrilir; `finally` kilidi yine temizler.
- `waMessageId` yoksa kilit uygulanmaz; eski yol doğrudan çalışır (davranış değişmez).
- Kilit anahtarı RAM'de kalır; log'a, dosya adına, sidecar'a veya HTTP yanıtına yazılmaz. Oturum kimliği ve mesaj kimliği dışında hassas veri yoktur.
- RAM dedupe, restart disk dedupe, `PROCESS_STARTED_AT_MS` davranışı ve mevcut `media_id`/`wa_message_id` arama yolları değiştirilmedi.

**Kapsam kararı:** Aynı `waMessageId` iki farklı oturumda eşzamanlı gelirse birleştirilmez; her oturum kendi dosyasını üretir. Bu bilinçli bir tenant izolasyonu tercihidir. Sıralı durumda mevcut RAM/disk dedupe ilk dosyayı yine paylaştırır.

**Kısmi yazma davranışı:** `storeMediaBuffer` dosyayı doğrudan `writeFileSync` ile yazar; temp dosya + rename yoktur. Yazma hata verirse yalnızca bu çağrıda oluşturulan yol `rmSync(force)` ile temizlenir. Bu aşamada yeni test, **kısmi baytlar yazıldıktan sonra** `ENOSPC` fırlatacak şekilde güçlendirildi ve kısmi dosyanın diskte kalmadığı doğrulandı. Temp+rename'e geçiş, 5.4.2 yazma sözleşmesini değiştireceği ve kapsam dışı olduğu için yapılmadı (bkz. Bölüm 10).

---

## 4. M-1 Eşzamanlılık Sonuçları

Yeni dosya: [test-media-ingestion-atomicity-545.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs) — gerçek `createMediaStore`, geçici dizin, kontrollü Baileys stub'ı; ağ ve gerçek WhatsApp yok.

Komut:

```bash
node --import ./tests/media-test-register-atomic.mjs \
  tests/test-media-ingestion-atomicity-545.mjs
```

Sonuç: **39 assertion, EXIT 0** (2026-11-03 14:2x +03).

| # | Senaryo | Doğrulanan sonuç |
|---|---|---|
| 1 | Aynı mesaj, 2 eşzamanlı çağrı | 1 indirme; 1 dosya + 1 sidecar; iki çağrı aynı `media_id`; dosya SHA-256'sı indirilen baytlarla aynı |
| 2 | Aynı mesaj, 10 eşzamanlı çağrı | 1 indirme; 1 dosya + 1 sidecar; 10 çağrının tümü aynı `media_id`; hash eşleşiyor; 5 sn timeout içinde tamamlandı |
| 3 | Farklı mesaj kimlikleri | 2 bağımsız indirme; 2 farklı `media_id`; 2 dosya; her dosyanın içeriği kendi yüküyle eşleşiyor (global kilit yok) |
| 4 | İlk indirme hata, sonra retry | İlk çağrı `null`, dosya yok; retry başarılı, tam 1 dosya, hash doğru (kilit bırakıldı) |
| 5 | Kısmi yazma + `ENOSPC` | `null`; kısmi dosya silinmiş, sidecar yok; aynı anahtar sonra başarılı, tam 1 dosya |
| 6 | 5 bekleyen çağrı + patlayan getter | Tümü 3 sn içinde `null` ile sonuçlandı (asılı kalmadı); dosya yok; aynı kimlikle sonraki çağrı başarılı |
| 7 | Aynı mesaj, farklı oturumlar | 2 bağımsız indirme; 2 farklı `media_id`; 2 dosya; her sidecar kendi `sessionId`'sini taşıyor (yanlış birleştirme yok) |

Tüm başarı senaryolarında yalnızca Promise kimliği değil, **gerçek dosya sayısı, sidecar sayısı ve içerik SHA-256'sı** doğrulandı.

---

## 5. M-2 Kök Nedeni

Beş ayrı hata sınıfı vardı:

1. **MIME doğrulaması FD açıldıktan sonra** yapılıyordu. Geçersiz/CRLF içeren bir sidecar MIME'ı, dosya tanımlayıcısı açıldıktan sonra reddediliyor; hata yolunda FD kapatılmıyorsa sızıyordu. Ayrıca header'a yazılması CRLF injection riski taşıyordu.
2. **Bozuk sidecar / hash uyuşmazlığı** yollarında FD'nin her dalda kapatıldığı garanti değildi.
3. **Express 4 async handler semantiği:** Express 4, async handler'ın döndürdüğü Promise'i beklemez ve `.catch` etmez. Handler reddederse istek asılı kalır ve `unhandledRejection` oluşur. Eski test harness'ı kendi `.catch()`'i ile bu davranışı maskeliyordu.
4. **İkinci yanıt / eski header sızıntısı:** Header yazımı kısmen başarılı olduktan sonra hata olursa `Content-Length`, `Content-Type`, `Cache-Control`, `X-Media-Integrity` gibi medya header'ları 500 JSON gövdesine taşınıyor; yanlış `Content-Length` gövdeyi kesiyordu.
5. **Stream/FD temizliği:** Header hatası, istemci kopması ve byte'lar gittikten sonraki stream hatası yollarında stream/FD'nin kapatıldığı garanti değildi.

---

## 6. M-2 FD ve Express 4 Çözümü

### 6.1 FD açılmadan önce metadata doğrulaması

[media-store.js:423](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L423) `openVerifiedMedia` artık sırasıyla:

1. sidecar'ı okur; `corrupt` ise `META_CORRUPT` döner — **FD açılmaz**,
2. MIME'ı `meta.mimeType` veya yol uzantısından çözer,
3. `isSafeMimeType` ile doğrular; geçersizse `INVALID_MIME` döner — **FD açılmaz**,
4. ancak bundan sonra `fs.openSync` çağrılır.

`isSafeMimeType` ([media-store.js:191](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L191)) yalnızca yazdırılabilir ASCII kabul eder (CR/LF ve kontrol karakterleri reddedilir), 255 karakter sınırı koyar ve `type/subtype` token biçimini doğrular; `; codecs=...` gibi parametreler korunur. `storeMediaBuffer` ([media-store.js:660](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js#L660)) yeni kayıtlarda geçersiz MIME'ı `application/octet-stream`'e normalize eder; eski/bozuk kayıtlar okuma yolunda reddedilir.

FD açıldıktan sonraki tüm yollar (`fstat` hatası, düzenli dosya değil, boyut uyuşmazlığı, hash uyuşmazlığı, beklenmedik throw) `closeSync` + `fd = null` ile temizlenir. Başarıda stream aynı FD'den okur (`autoClose: true`); verify→send TOCTOU penceresi kapalı kalır.

### 6.2 HTTP katmanı

[media-routes.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js):

- `INVALID_MIME` → **422** `MEDIA_INVALID_METADATA` (FD açılmadan),
- `META_CORRUPT` / hash uyuşmazlığı → **422** `MEDIA_CORRUPTED`,
- `MISSING` → **404** `MEDIA_EXPIRED`,
- Header yazımı try/catch içinde; hata olursa stream `destroy()`, dört medya header'ı `removeHeader` ile geri alınır, ardından **500** `MEDIA_RESPONSE_ERROR` (veya header zaten gittiyse `res.destroy()`),
- Stream hatası, byte gitmeden önce: aynı dört header geri alınır, **500** `MEDIA_STREAM_ERROR`,
- Stream hatası, byte gittikten sonra: `res.destroy()` — istemci başarılı/eksiksiz yanıt görmez,
- `res.on('close')`: yanıt tamamlanmadıysa stream `destroy()` (istemci kopması),
- `HEAD`: stream `destroy()`, yalnızca header'lar döner,
- Yanıtlarda/log'larda dosya yolu, tenant bilgisi veya exception detayı yok; yalnızca sabit kodlar.

### 6.3 Express 4 uyumluluğu

Dışa açılan `asyncHandler` ([media-routes.js:15](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js#L15)) handler'ı `Promise.resolve().then(...).catch(...)` ile sarar:

- Reddedilen handler için header gitmemişse tek bir **500** `MEDIA_REQUEST_ERROR` yanıtı,
- Header zaten gitmişse **ikinci yanıt denemesi yok**, bağlantı `destroy()`,
- `mediaSessionGuard` ve iki route da bu sarmalayıcıdan geçer.

Not: `asyncHandler` Promise döndürür; Express 4 bunu yok sayar. Kritik olan, Promise'in **asla reddetmemesi** ve yanıtı **tam bir kez** sonlandırmasıdır.

---

## 7. Gerçek HTTP Test Sonuçları

Yeni dosya: [test-media-routes-545.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-routes-545.mjs) — gerçek `node:http` sunucusu, gerçek `registerMediaRoutes` handler'ları, gerçek `requireGatewayToken`, gerçek `createMediaStore`; `fs.openSync`/`fs.closeSync` sayacı ve global `unhandledRejection` toplayıcısı.

**Dürüstlük notu:** Bu worktree'de `node_modules` **yoktur** ve dependency kurmak yasaktır. Bu nedenle **gerçek Express 4 E2E çalıştırılmadı**. Host, Express 4'ün belgelenmiş davranışını (dönen Promise'i yok say, `.catch` yok) birebir taklit eder; ayrıca `asyncHandler` doğrudan birim test edilir. Bu sonuçlar "gerçek Express 4 E2E" olarak raporlanmamaktadır.

Komut ve sonuç (2026-11-03 14:2x +03): **61 assertion, EXIT 0**.

| # | Senaryo | Sonuç |
|---|---|---|
| 1 | Geçersiz MIME + mevcut medya (unscoped + session) | 422 `MEDIA_INVALID_METADATA`; `openSync` çağrısı **0**; CRLF header'ı yok; medya baytları servis edilmiyor |
| 2 | Var olmayan medya | 404 `MEDIA_EXPIRED`; FD **0** |
| 3 | Bozuk sidecar | 422 `MEDIA_CORRUPTED`; FD **0**; hedef baytlar servis edilmiyor |
| 4 | Hash uyuşmazlığı | 422 `MEDIA_CORRUPTED`; FD açıldı **1**, kapandı **1** |
| 5 | `/dev/null` (düzenli dosya değil) | `MISSING`; FD açıldı **1**, kapandı **1** |
| 5b | FD açıldıktan sonra header hatası | 500 `MEDIA_RESPONSE_ERROR`; eski `Content-Length` taşınmıyor; stream `destroyed` |
| 6 | Byte'tan önce stream hatası | 500 `MEDIA_STREAM_ERROR`; `Content-Length` ve `X-Media-Integrity` yok |
| 7 | Byte'tan sonra stream hatası | İstemci eksik/bozuk yanıt görür; tam ve başarılı yanıt görmez |
| 8 | Stream sırasında istemci kopması | Stream/FD serbest bırakıldı |
| 9 | `HEAD` | Yalnızca header'lar; FD serbest |
| 10 | Sıfır baytlık medya | Boş gövdeyle 200 |
| 11/12 | Her iki route başarı yolu | 200; unscoped gövde hash'i sidecar ile aynı; session gövdesi bayt-eşit; bilinmeyen oturum 404 |
| 13 | Eksik/yanlış token | Her iki route **401** (gerçek `requireGatewayToken`; production mount sırası ile uyumlu) |
| 14 | Express 4 async reddi | `getSession` throw → 500 `MEDIA_REQUEST_ERROR`; `req.query` getter throw → 500; doğrudan sarmalayıcı testi: Promise resolve eder, tek yanıt; header gitmişse `destroy`, ikinci yanıt yok |
| — | `unhandledRejection` sayacı | 150 ms sonunda **0** |

---

## 8. Mevcut Test Matrisi

| Test | Sonuç | EXIT |
|---|---|---:|
| `test-media-ingestion-atomicity-545.mjs` (yeni, M-1) | 39 assertion | 0 |
| `test-media-routes-545.mjs` (yeni, M-2) | 61 assertion | 0 |
| `test-media-store-integrity.mjs` (5.4.2; restart/eviction dahil) | 65 assertion | 0 |
| `test-media-store-543.mjs` (5.4.3) | 59 assertion | 0 |
| `test-media-routes-543.mjs` (5.4.3) | 40 assertion | 0 |
| `backend/tests/test_whatsapp_media_tenant_isolation.py` + `test_link_preview_media_tenant_isolation.py` | 21 passed | 0 |
| `backend/tests/test_whatsapp_live.py` | 61 passed (2 deprecation warning) | 0 |

Gateway testleri `node --import ./tests/media-test-register{,-atomic}.mjs ...` ile tek tek çalıştırıldı. Backend testleri taze, izole SQLite DB (`/tmp/tz545_test.db`, `scripts/provision_test_db.py`) üzerinde çalıştırıldı.

**Çalıştırılamayanlar:**

- `npm test`: `node_modules` yok; dependency kurmak yasak. Paket script'ine iki yeni suite eklendi ancak script bu ortamda uçtan uca koşturulamadı.
- Gerçek Express 4 E2E: aynı nedenle çalıştırılmadı (bkz. Bölüm 7).
- PostgreSQL: bu aşamada **test edilmedi**; tüm backend testleri SQLite üzerinde.
- L4 (gerçek WhatsApp sağlayıcısı): çalıştırılmadı; bu aşamada ağ/hesap kullanılmadı.

---

## 9. Bağımsız İnceleme Bulguları

Kod ve testler üzerinde ayrı bir inceleme turu yapıldı. Bulunanlar:

| # | Bulgu | Durum |
|---|---|---|
| I-1 | Header yazımı kısmen başarılı olduktan sonra hata olursa eski `Content-Length` 500 JSON gövdesini kesiyordu. | **Düzeltildi**: dört medya header'ı hata yolunda geri alınıyor; test 5b eklendi. |
| I-2 | Yeni `storeIncomingMedia` sarmalayıcısı `waMessage?.key?.id` ifadesini iç try dışında okuduğu için bozuk getter eski "asla fırlatma" sözleşmesini bozabiliyordu. | **Düzeltildi**: tüm gövde try/catch içinde; `finally` kimlik kontrollü temizliği koruyor. |
| I-3 | Test 7'de `'pipe'` olayı readable kaynakta değil, writable hedefte tetiklenir; test yanlış yerde dinliyordu. | **Düzeltildi**: tüketim `read()` içinde tetikleniyor ve gerçek okuma sayısı doğrulanıyor. |
| I-4 | Oturum kimliği yoksa kilit anahtarı boş kapsamla yalnızca `waMessageId`'ye düşer. | **Kabul edildi**: çağıranlar (`session-manager`) her zaman `session.id` taşır; kimliksiz durum eski global dedupe semantiğiyle aynıdır ve tenant'lar arası birleştirme üretmez. |
| I-5 | `storeMediaBuffer` temp dosya + rename kullanmıyor; süreç yazma ortasında çökerse sidecar'sız kısmi dosya kalabilir. | **Kapsam dışı / belgelendi**: yazma hatası (throw) yolu kısmi dosyayı temizliyor ve test edildi; çökme senaryosu 5.4.2'den gelen mevcut davranıştır, bu aşamada değiştirilmedi (bkz. Bölüm 10). |

Ek kontroller: kilit haritası hiçbir log'a veya diske yazılmıyor; MIME doğrulaması CRLF ve kontrol karakterlerini reddediyor; her iki route'ta hata gövdeleri sabit kodlar içeriyor; `unhandledRejection` sayacı sıfır.

---

## 10. Açık Riskler

1. **Gerçek Express 4 E2E yok.** `node_modules` bulunmadığı ve dependency kurulamadığı için Express 4'ün kendi dispatcher'ı çalıştırılmadı. Emülasyon + doğrudan handler testi güçlü kanıt sağlar ancak gerçek Express 4 entegrasyonunun yerini tam tutmaz. Deployment ortamında `npm test` çalıştırıldığında doğrulanmalıdır.
2. **`npm test` bu ortamda çalıştırılamadı.** İki yeni suite script'e eklendi; CI/deploy ortamında tam script koşturulmalıdır.
3. **PostgreSQL test edilmedi.** Gateway medya katmanı dosya sistemi tabanlıdır ve bu aşamada DB değişikliği yoktur; backend testleri SQLite ile sınırlıdır.
4. **Süreç çökmesi sırasında kısmi dosya.** Yazma throw ederse temizlik var; ancak süreç yazma ortasında ölürse sidecar'sız kısmi dosya kalabilir ve mevcut "legacy" okuma yolu bunu servis edebilir. Temp+rename bu riski kapatırdı; 5.4.2 yazma sözleşmesini değiştireceği için bu aşamada yapılmadı.
5. **Kilit yalnızca süreç içidir.** Birden fazla gateway instance'ı aynı `mediaDir`'i paylaşırsa eşzamanlı ingestion'lar aralarında birleştirilmez. Mevcut RAM/disk dedupe da süreç-yereldi; deploy topolojisi tek gateway varsayımına dayanır.
6. **Çapraz oturum aynı `waMessageId`.** Bilinçli olarak birleştirilmez; iki dosya oluşabilir. Tenant izolasyonu disk tasarrufundan önce gelir.
7. **MIME doğrulaması yalnızca header güvenliğidir**, içerik sniffing değildir. Sidecar'sız legacy dosyalarda MIME yol uzantısından türetilir.

---

## 11. Değişen / Oluşturulan Dosyalar

### Değişen (bu aşamada)

| Dosya | Değişiklik |
|---|---|
| [whatsapp-gateway/src/media/media-store.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-store.js) | `ingestLocks` + `ingestLockKey`, `storeIncomingMedia` sarmalayıcısı, `isSafeMimeType`, `storeMediaBuffer` MIME normalizasyonu, `openVerifiedMedia` metadata/MIME doğrulamasını FD öncesine taşıma ve tüm FD kapatma yolları |
| [whatsapp-gateway/src/media/media-routes.js](file:///private/tmp/tz429-release/whatsapp-gateway/src/media/media-routes.js) (5.4.3'ten untracked) | `asyncHandler`, `INVALID_MIME` → 422, header hata yolunda header geri alma + stream destroy, stream hata yolları, `headersSent` çift-yanıt koruması |
| [whatsapp-gateway/package.json](file:///private/tmp/tz429-release/whatsapp-gateway/package.json) | `test` script'ine iki yeni suite eklendi (5.4.3 girdileri korunarak) |

### Yeni

| Dosya | Satır | Amaç |
|---|---:|---|
| [tests/test-media-ingestion-atomicity-545.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs) | 329 | M-1 eşzamanlılık/atomiklik testleri (7 blok, 39 assertion) |
| [tests/test-media-routes-545.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/test-media-routes-545.mjs) | 665 | M-2 HTTP/FD/Express 4 semantiği testleri (14 blok, 61 assertion) |
| [tests/stubs/baileys-atomic.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/stubs/baileys-atomic.mjs) | 48 | Kontrol edilebilir indirme stub'ı |
| [tests/media-test-loader-atomic.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/media-test-loader-atomic.mjs) | 17 | ESM resolve hook (baileys/uuid stub) |
| [tests/media-test-register-atomic.mjs](file:///private/tmp/tz429-release/whatsapp-gateway/tests/media-test-register-atomic.mjs) | 3 | Hook kaydı |

### Bu aşamada değişmeyen

Backend, frontend, DB modelleri/migration'ları, 5.4.2/5.4.3 testleri ve diğer 5.4.2/5.4.3 artifact'ları değiştirilmedi. `reports/` altındaki bu rapor dışında doküman değişikliği yok.

---

## 12. Nihai Karar

**PASS_WITH_NOTES**

M-1 ve M-2 tanımlı kapsamda çözüldü:

- Aynı `(session, waMessageId)` için eşzamanlı çağrılar tek indirme/tek dosya/tek `media_id` üretiyor; hata bekleyenleri asmıyor ve kilidi temizliyor; farklı kimlikler ve farklı oturumlar paralel kalıyor.
- Geçersiz MIME ve bozuk metadata FD açılmadan reddediliyor; FD açılan tüm hata yollarında kapatılıyor; Express 4 async reddi tek terminal yanıta dönüşüyor; eski medya header'ları hata yanıtına sızmıyor; istemci kopması ve stream hataları temizleniyor.
- 5.4.2/5.4.3 regresyonları (65 + 59 + 40 assertion) ve backend tenant/live testleri (21 + 61 passed) yeşil.
- Başlangıç ve bitiş HEAD aynı (`978ddf5...`), staged değişiklik yok, commit/push/deploy yapılmadı.

Notlar (PASS'i engellemeyen, kullanıcı kararı gerektiren açık noktalar):

1. Gerçek Express 4 E2E ve `npm test` bu ortamda çalıştırılamadı (node_modules yok; kurulum yasak). Deploy/CI ortamında doğrulanmalı.
2. PostgreSQL bu aşamada test edilmedi.
3. Süreç çökmesi sırasında sidecar'sız kısmi dosya riski 5.4.2'den gelen mevcut davranıştır; temp+rename ayrı bir aşamanın konusudur.
4. Kilit süreç-yereldir; çoklu gateway instance topolojisi ayrıca değerlendirilmelidir.

Bir sonraki aşamaya otomatik geçilmedi.
