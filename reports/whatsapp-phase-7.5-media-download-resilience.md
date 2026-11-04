# AŞAMA 7.5 — WhatsApp Media Download Resilience & Dynamic Timeout Raporu

**Tarih**: 2026-11-04  
**Kapsam**: Sabit 10s Timeout Kaldırılması, Tip ve Boyut Bazlı Dinamik Timeout, Üstel Geri Çekilme (Exponential Backoff) & Jitter ile Kontrollü Retry, Kesik Stream (Stream Truncation) Bütünlük Denetimi, Terminal Hatalarda Hızlı Başarısızlık (Fast-Fail), Küçük Resim (Thumbnail) Fallback Bypass & On-Demand Retry, Backend HTTP Proxy Dinamik Timeout Uyumu  
**Durum**: TAMAMLANDI, DOĞRULANDI, PRODUCTION DEPLOY EDİLDİ  
**Production Commit SHA**: `408b82e5a23e2677cd5fcdd274b6e145f9c26dff`

---

## 1. Yönetici Özeti (Executive Summary)

AŞAMA 7.0 genel fonksiyonel denetiminde tespit edilen ve özellikle büyük video (50MB+), ses/sesli mesaj ve PDF belgelerinin indirilmesinde başarısızlığa neden olan sabit timeout ve dayanıklılık sorunları AŞAMA 7.5 kapsamında kalıcı olarak çözüldü:

1. **Sabit 10 Saniyelik Timeout Kaldırıldı (P0)**:
   - `whatsapp-gateway/src/media/media-store.js` içerisindeki hardcoded 10,000ms (`setTimeout(..., 10_000)`) indirme sınırı kaldırıldı.
   - Yeni saf (pure) ve test edilebilir `calculateMediaTimeout` modülü (`whatsapp-gateway/src/media/media-timeout.js`) devreye alındı.
   - Medya türüne ve dosya boyutuna (`fileLength`) göre ölçeklenen dinamik timeout matrisi:
     - **Önizleme (`isPreview`)**: 10,000ms (10s) hızlı yol.
     - **Resim (`image`)**: Taban 20s, boyut ölçekli, tavan 45s.
     - **Ses (`audio` / `ptt`)**: Taban 30s, boyut ölçekli, tavan 60s.
     - **Belge (`document` / `pdf`)**: Taban 35s, boyut ölçekli, tavan 120s (2 dakika).
     - **Video (`video` / `ptv`)**: Taban 45s, boyut ölçekli (min 150 KB/sn bant genişliği varsayımı), tavan 180s (3 dakika).
     - **Çıkartma (`sticker`)**: 15s - 20s.
     - **Asgari / Azami Güvenlik Sınırları**: Bounded [5,000ms - 180,000ms]; asla sonsuz veya kontrolsüz bekleme yapmaz.

2. **Geçici Ağ Hatalarına Karşı Kontrollü Retry & Terminal Hatalarda Fast-Fail (P1)**:
   - `isTransientMediaError` ile hatalar kesin olarak sınıflandırıldı:
     - **Geçici Hatalar (Transient)**: `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`, `EPIPE`, soket kapanması/kopması (`socket hang up`, `socket closed`), stream kesintisi (`stream truncated`), zaman aşımı (`timeout`), HTTP 5xx durum kodları.
     - **Kalıcı/Terminal Hatalar (Non-transient)**: HTTP 404 (Not Found), HTTP 410 (Gone / Expired link), HTTP 401/403, `item-not-found`, `rate-overlimit`, geçersiz veya eksik `mediaKey`.
   - Geçici hatalarda 2 yeniden deneme (toplam 3 girişim) uygulanır.
   - Girişimler arasında üstel geri çekilme ve rastgele gecikme dalgalanması (jitter) hesaplanır (`getRetryDelay(attempt)`: 1. deneme anında, 2. deneme ~500-800ms, 3. deneme ~1000-1500ms).
   - Kalıcı/terminal hatalarda zaman kaybetmeden anında başarısız olunur (fast-fail) ve tekrar deneme döngüsü işletilmez.

3. **Stream Bütünlüğü ve Kesik İndirme (Truncated Stream) Tespiti (P1)**:
   - Protobuf metadata'sında `fileLength > 0` mevcutsa ve işlem önizleme (`isPreview`) değilse, CDN'den indirilen tampon bellek uzunluğu denetlenir.
   - İndirilen bayt miktarı beklenen boyutun %90'ının altındaysa CDN bağlantısının erken koptuğu tespit edilir (`STREAM_TRUNCATED`), geçici hata olarak işaretlenip retry tetiklenir.
   - Tüm retry denemeleri tükendiğinde, orijinal fallback mekanizması korunarak varsa `jpegThumbnail` önizleme olarak saklanır veya `null` dönülür.

4. **Önceden Saklanan Fallback Küçük Resimlerin Yeniden İndirilmesi (Retry Bypass)**:
   - Daha önce indirme zaman aşımına uğradığı için diske küçük resim (`thumb_...jpeg`) kaydedilmiş bir medya için kullanıcı "Yeniden Dene" (`_retry=true`) butonuna bastığında veya tam medya istendiğinde, `media-routes.js`, `session-manager.js` ve `media-store.js` eski küçük resmi önbellekten dönmek yerine tam medya indirmesini baştan tetikler.
   - Tam medya başarıyla indiğinde disk ve bellek indeksleri tam dosyaya güncellenir. Tam indirme yine başarısız olursa, mevcut küçük resim kesintisiz servis edilmeye devam eder.

5. **Backend HTTP Proxy Dinamik Timeout Entegrasyonu (P2)**:
   - Backend `whatsapp_gateway.py` servisindeki 30 saniyelik statik timeout (`gateway_timeout()`), büyük video (180s) ve belgelerde backend'in `httpx.ReadTimeout` verip 502 dönmesine yol açıyordu.
   - Backend tarafında `gateway_media_timeout(mime_type, preview, file_length)` fonksiyonu eklendi:
     - Preview: 15.0s
     - Video: 195.0s
     - Belge/PDF/Text: 135.0s
     - Ses: 75.0s
     - Resim: 60.0s
     - Bilinen büyük boyutlarda 240.0s tavanına kadar ölçekleme.
   - `fetch_media` ve `fetch_media_unscoped` metodlarına `timeout: Optional[float] = None` parametresi eklendi.
   - `backend/app/services/whatsapp/orchestration/messaging.py:get_media_bytes` içerisinde `fetch_media` çağrılırken medya MIME türüne göre dinamik timeout aktarılması sağlandı.

---

## 2. Değiştirilen Dosyalar ve Mimari Detaylar

| Dosya | Değişiklik Özeti |
|---|---|
| `whatsapp-gateway/src/media/media-timeout.js` | **(YENİ)** `calculateMediaTimeout`, `isTransientMediaError`, `getRetryDelay`, `normalizeMediaCategory`, `MEDIA_TIMEOUT_BOUNDS`. |
| `whatsapp-gateway/src/media/media-store.js` | Sabit 10s timeout kaldırıldı; `ingestIncomingMedia` içine dinamik timeout, 3 denemeli retry döngüsü, stream truncation kontrolü ve terminal error fast-fail eklendi; thumbnail bypass desteği sağlandı. |
| `whatsapp-gateway/src/media/media-routes.js` | `serveVerifiedMedia` içine retry durumunda ve tam medya istendiğinde `thumb_` dosyalarını atlayarak on-demand tam indirmeyi tetikleme mantığı eklendi. |
| `whatsapp-gateway/src/session-manager.js` | `downloadMediaOnDemand` içinde thumbnail fallback varlığında tam medya veya retry talebinde indirme yoluna yönlendirme yapıldı. |
| `whatsapp-gateway/package.json` | Test script'ine `node tests/test-media-download-dynamic-timeout-75.mjs` eklendi. |
| `whatsapp-gateway/tests/test-media-download-dynamic-timeout-75.mjs` | **(YENİ)** Dynamic timeout, retry, backoff, stream truncation ve thumbnail bypass birim test paketi (5 test, hepsi PASS). |
| `backend/app/services/whatsapp_gateway.py` | `gateway_media_timeout` fonksiyonu tanımlandı; `fetch_media` ve `fetch_media_unscoped` fonksiyonlarına `timeout: Optional[float] = None` dinamik parametresi eklendi. |
| `backend/app/services/whatsapp/orchestration/messaging.py` | `get_media_bytes` içinde `fetch_media` çağrılarına `timeout=gateway_media_timeout(...)` parametresi bağlandı. |
| `backend/tests/test_whatsapp_phase7_5_media_timeout.py` | **(YENİ)** Dinamik timeout matrisi, file length ölçeklemesi, httpx timeout parametre aktarımı ve `get_media_bytes` entegrasyon testleri (6 test, hepsi PASS). |
| `backend/tests/test_whatsapp_pure_identity.py` | Faz 7.3 kanal desteği ile uyumlu hale getirildi (`123456789@newsletter` is False). |
| `backend/tests/test_whatsapp_tenant_isolation.py` | Faz 7.3 kanal desteği ile uyumlu hale getirildi (`NEWSLETTER_JID` is False, `test_newsletter_message_is_persisted`). |

---

## 3. Doğrulama ve Test Kanıtları

### 3.1 Gateway Testleri (`whatsapp-gateway`)
```bash
npm test --prefix whatsapp-gateway
```
**Sonuç**:
- 54 test dosyasının ve yeni `test-media-download-dynamic-timeout-75.mjs` paketinin tamamı **PASSED** (0 failed).
- Yeni test paketi çıktıları:
  - `✔ 1. calculateMediaTimeout - preview, boundaries, and type scaling`
  - `✔ 2. isTransientMediaError - classification of transient vs terminal errors`
  - `✔ 3. getRetryDelay - backoff progression and bounds`
  - `✔ 4. Controlled retry succeeds on transient error`
  - `✔ 5. Cached thumbnail bypass when full media or retry is requested`

### 3.2 Backend Testleri (`pytest`)
```bash
source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_phase7_5_media_timeout.py -v
```
**Sonuç**:
- 6 testin tamamı **PASSED** (0 failed, 0.32s).
- Gerçek izole PostgreSQL 17 veritabanı üzerinde `get_media_bytes` ve `fetch_media` uçtan uca doğrulandı.

### 3.3 WhatsApp Backend Test Paketi Regresyon Denetimi
```bash
source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp* -v
```
**Sonuç**:
- 1028 test **PASSED** (0 failed, 8 skipped).

### 3.4 Frontend Mantık & Tip Denetimleri
```bash
npm run verify:logic --prefix frontend
npm run build --prefix frontend
```
**Sonuç**:
- `verify:logic`: 56/56 checks passed.
- `build`: `tsc && vite build` 0 hata ile tamamlandı (39 asset üretildi).

### 3.5 Production Dağıtımı ve Sağlık Kanıtı
- **Dağıtım Scripti**: `bash scripts/deploy/release.sh`
- **Hedef Commit SHA**: `408b82e5a23e2677cd5fcdd274b6e145f9c26dff`
- **Canary Island Doğrulaması**: İzole `tezlify-candidate-20261104T133006Z` konteyneri ayağa kalktı, `/health` 200 OK alındı.
- **Canlı Konteyner Durumları**:
  - `tezlify-gateway`: Up (healthy)
  - `tezlify-backend`: Up (healthy)
  - `tezlify-db`: Up (healthy)
  - `tezlify-caddy`: Up (healthy)
- **Canlı WhatsApp Oturumu (Session 201 - Hat 1)**:
  - `status: CONNECTED`
  - `is_phone_online: true`
  - `initial_sync_completed_at: 2026-10-27 20:32:33.511995`
  - `error_message: None`
  - Oturum bağlantısı, kimlik bilgileri ve QR durumu kesintisiz olarak korundu.
- **Canlı Smoke Doğrulaması**: `node frontend/scripts/verify-production-whatsapp.mjs` -> 6/6 checks passed.

---

## 4. Sonuç

AŞAMA 7.5 başarıyla tamamlandı. WhatsApp medya indirme boru hattı sabit timeout kısıtlamasından kurtarılarak medya tipine ve dosya boyutuna duyarlı dinamik timeout, akıllı retry ve stream bütünlüğü mekanizmalarıyla güçlendirildi; tüm değişiklikler production ortamına sıfır kesintiyle deploy edildi.
