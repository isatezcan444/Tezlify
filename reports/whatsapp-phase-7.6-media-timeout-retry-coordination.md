# AŞAMA 7.6 — Media Timeout & Retry Coordination Raporu

**Tarih**: 2026-11-04  
**İşlem Türü**: Mevcut WhatsApp medya indirme sisteminde hedefli kod düzeltmesi  
**Kodlama**: EVET  
**Altyapı**: HAYIR  
**Referans Rapor**: `reports/whatsapp-phase-7.5-final-acceptance.md`  
**Referans Kod Commit'i**: `408b82e5a23e2677cd5fcdd274b6e145f9c26dff`  
**Aşama 7.6 Kod Commit'i**: `3316336ed0309d0d85536717bdfb01a6fb7d86da`  
**Production Sürüm (Release ID)**: `20261104T140754Z`  
**Durum**: TAMAMLANDI / CANLIYA ALINDI

---

## 1. Başlangıç Git ve Release Durumu

AŞAMA 7.6 geliştirmesine başlanmadan önceki başlangıç kontrolü:

| Konum | Tam Commit SHA | Durum |
|---|---|---|
| **Local `main` HEAD** | `c9f24f4340887421a39eb79aeb0bb03f60500133` | Dokümantasyon (`docs(whatsapp): add phase 7.5 media download resilience report`) commit'i. |
| **`origin/main` HEAD** | `c9f24f4340887421a39eb79aeb0bb03f60500133` | GitHub ile yerel repo senkronize. |
| **Production `/opt/tezlify`** | `408b82e5a23e2677cd5fcdd274b6e145f9c26dff` | AŞAMA 7.5 kod commit'i. |
| **Production `.deployed-commit`** | `408b82e5a23e2677cd5fcdd274b6e145f9c26dff` | Doğrulanmış release commit'i. |
| **Çalışma Ağacı** | Temiz | Yalnızca Phase 7.5-F kabul raporu untracked durumda. |

---

## 2. Tespit Edilen İki Kritik Problem ve Çözüm Mimarisi

AŞAMA 7.5-F kabul raporuyla kanıtlanan iki kritik eksiklik giderilmiştir:

### 2.1 Problem 1: Bağımsız Retry Timeout'u ve Backend Proxy Erken Kopması
- **Sorun**: Gateway medya retry döngüsünde her deneme bağımsız olarak kendi `dynamicTimeoutMs` süresini kullanıyordu. Örneğin resim indirmesinde her deneme 45s sürüp 3 deneme yapıldığında toplam süre ~136s'ye ulaşıyordu. Backend HTTP proxy (`httpx.AsyncClient`) ise sabit 60.0s bekliyordu. Gateway 2. denemeyi yaparken backend `httpx.ReadTimeout` (502 Bad Gateway) ile bağlantıyı koparıyordu.
- **Çözüm**:
  1. Gateway tarafında tek bir birleşik toplam süre bütçesi (`totalBudgetMs`) ve mutlak bitiş zamanı (`deadline = Date.now() + totalBudgetMs`) oluşturuldu.
  2. Her retry öncesinde kalan bütçe (`deadline - Date.now()`) hesaplandı; asgari eşiğin (`MIN_RETRY_THRESHOLD_MS = 2500ms`) altındaysa yararsız retry başlatılmayıp döngü kırıldı.
  3. Retry backoff gecikmesi (`getRetryDelay`) kalan bütçeden düşüldü.
  4. Her münferit denemenin zaman aşımı kalan süreyle sınırlandı: `attemptTimeoutMs = Math.min(nominalAttemptTimeoutMs, remainingForAttempt)`.
  5. Backend tarafında `gateway_media_timeout`, gateway toplam deadline bütçesini en az 15 saniyelik ağ marjıyla karşılayacak şekilde koordine edildi.

### 2.2 Problem 2: 50 MB Video ve Büyük Dosyaların 180s Tavanına Takılması
- **Sorun**: 50 MB video (52,428,800 bayt), 150 KB/s (153,600 bayt/s) hızında en az 341.3 saniye gerektiriyordu. Önceki 180s tavanı bu hızda dosyanın yalnızca ~26.4 MB'ına izin veriyor ve 180. saniyede kesintiye yol açıyordu.
- **Çözüm**:
  1. Video tavan bütçesi **420,000 ms (420 saniye = 7 dakika)** olarak belirlendi.
  2. 50 MB video 150 KB/s hızda transfer edildiğinde 341.3s sürer; 420s tavanı bu transferi ~79 saniyelik ek marj ve retry payıyla güvenle karşılar.
  3. Backend video HTTP proxy zaman aşımı `420s + 15s = 435.0s` olarak güncellendi.
  4. 100 MB video için >= 250 KB/s (409.6s) ve >= 500 KB/s (204.8s) bant genişliğinde tam destek sağlandı; sunucu kaynaklarının sınırsız tüketimini önlemek için 420s makul ve koruyucu mutlak üst sınır olarak korundu.

---

## 3. Teorik İndirme Süreleri ve Timeout Matrisi

Gerçek bayt değerleri esas alınarak ($1\text{ MB} = 1,048,576\text{ bayt}$, $1\text{ KB} = 1,024\text{ bayt}$):

### 3.1 Hız ve Dosya Boyutu Matrisi

| Dosya Boyutu | Bayt Değeri | 150 KB/s (153.6 KB/s) | 250 KB/s (256 KB/s) | 500 KB/s (512 KB/s) | 1 MB/s (1,048.576 KB/s) | Gateway Toplam Bütçesi | Backend Proxy Timeout |
|---|---|---|---|---|---|---|---|
| **10 MB** | 10,485,760 B | ~68.3 s | ~41.0 s | ~20.5 s | ~10.0 s | **134 s** | **149.0 s** |
| **25 MB** | 26,214,400 B | ~170.7 s | ~102.4 s | ~51.2 s | ~25.0 s | **243 s** | **258.0 s** |
| **50 MB** | 52,428,800 B | **~341.3 s** | ~204.8 s | ~102.4 s | ~50.0 s | **420 s (Tavan)** | **435.0 s (Tavan)** |
| **100 MB**| 104,857,600 B| ~682.7 s | **~409.6 s** | **~204.8 s** | **~100.0 s** | **420 s (Tavan)** | **435.0 s (Tavan)** |

> [!NOTE]
> 100 MB dosya transferinde 150 KB/s hızda transfer 11.4 dakika sürer. Web ve HTTP proxy mimarilerinde (Caddy, Uvicorn, Gunicorn) 10 dakikayı aşan tekil HTTP istekleri bağlantı havuzu tükenmesine yol açabileceğinden, 420s (7 dakika) tavanı sistemi kilitlenmelere karşı koruyan kontrollü bir sınırdır. 100 MB dosyalar 4G/fiber hızlarında (>=250 KB/s) 420s bütçesine tam olarak sığmaktadır.

### 3.2 Medya Türü Taban ve Tavan Politikası

| Medya Türü | Taban Deneme | Tavan Deneme | Taban Bütçe | Gateway Toplam Tavanı | Backend Proxy Timeout | İletişim Marjı |
|---|---|---|---|---|---|---|
| **Preview** | 10.0 s | 10.0 s | 12.0 s | **12.0 s** | **15.0 s** | +3.0 s |
| **Image** | 20.0 s | 45.0 s | 25.0 s | **60.0 s (1 dk)** | **75.0 s** | +15.0 s |
| **Audio / PTT** | 30.0 s | 60.0 s | 35.0 s | **90.0 s (1.5 dk)**| **105.0 s** | +15.0 s |
| **Document** | 35.0 s | 120.0 s | 45.0 s | **180.0 s (3 dk)** | **195.0 s** | +15.0 s |
| **Video** | 45.0 s | 360.0 s | 60.0 s | **420.0 s (7 dk)** | **435.0 s** | +15.0 s |
| **Sticker** | 15.0 s | 20.0 s | 20.0 s | **25.0 s** | **75.0 s** | +50.0 s |
| **Bilinmeyen / Default** | 30.0 s | 45.0 s | 35.0 s | **60.0 s** | **75.0 s** | +15.0 s |

---

## 4. İstemci Cancellation (İptal) ve Hata Yönetimi

1. **Bağlantı Kapanması & Abort**:
   - İstemci (kullanıcı sekmeyi kapattığında veya sohbetten çıktığında) bağlantıyı kestiğinde:
   - Backend `HTTP 499 (Client Closed Request)` ile işlemi sonlandırır.
   - Gateway `media-routes.js` `AbortController` aracılığıyla `req.on('close')` sinyalini yakalar.
   - `mediaStore.storeIncomingMedia` `options.signal` üzerinden yarışı sonlandırır ve `AbortError` fırlatır.
2. **Hata Sınıflandırması**:
   - `AbortError`, `ERR_ABORTED`, `ECANCELED`, `client aborted` hataları **terminal** olarak sınıflandırılır (`isTransientMediaError` `false` döner).
   - İptal edilen istekler için gereksiz retry yapılmaz; kaynaklar derhal serbest bırakılır (`releaseMediaDownloadSlot`).
   - İptal edilen veya başarısız olan istekler RAM veya disk önbelleğine asla "başarılı" olarak yazılmaz.
3. **Gateway Hata Durum Kodları**:
   - `404`: CDN'de medya yok veya silinmiş (`MEDIA_EXPIRED`).
   - `422`: İndirilen bayt bütünlüğü veya metadata geçersiz (`MEDIA_CORRUPTED` / `MEDIA_INVALID_METADATA`). 502 yerine doğrudan 422 döndürülerek hatalı retry'lar önlenir.
   - `502`: Ağ kopması veya ulaşılamaz gateway durumu.

---

## 5. Değiştirilen Dosyalar

| Dosya | Değişiklik Özeti |
|---|---|
| `whatsapp-gateway/src/media/media-timeout.js` | `calculateTotalMediaBudget` eklendi; tavan 420s'ye yükseltildi; client abort terminal sınıflandırıldı. |
| `whatsapp-gateway/src/media/media-store.js` | Birleşik deadline bütçesi (`deadline = startTime + totalBudgetMs`), kalan süre kontrolü, backoff düşümü, AbortSignal entegrasyonu. |
| `whatsapp-gateway/src/media/media-routes.js` | `AbortController` ile HTTP request/response close sinyalleri indirme hattına bağlandı. |
| `whatsapp-gateway/package.json` | `test-media-download-dynamic-timeout-76.mjs` test komutuna eklendi. |
| `whatsapp-gateway/tests/test-media-download-dynamic-timeout-75.mjs` | Video 50MB üst sınır beklentisi yeni tavanla uyumlu hale getirildi. |
| `whatsapp-gateway/tests/test-media-download-dynamic-timeout-76.mjs` | **(Yeni)** Bütçe, 10/25/50/100MB boyut, retry tüketimi, client cancellation ve fallback testleri. |
| `backend/app/services/whatsapp_gateway.py` | `gateway_media_timeout` Gateway toplam bütçesi + 15s ağ marjıyla koordine edildi. |
| `backend/app/services/whatsapp/orchestration/messaging.py` | `get_media_bytes` içinde `quoted_message.fileLength` desteği bağlandı. |
| `backend/app/api/v1/endpoints/whatsapp.py` | `request.is_disconnected()` kontrolü ile 499 fast-fail eklendi. |
| `backend/tests/test_whatsapp_phase7_5_media_timeout.py` | Zaman aşımı testleri güncellenen koordine değerlere (435s video, 195s doc) uyarlandı. |
| `backend/tests/test_whatsapp_phase7_6_media_timeout.py` | **(Yeni)** Koordine timeout, matris matematiği, 422/502 hata ayrımı ve backend tekil çağrı testleri. |
| `reports/whatsapp-phase-7.5-final-acceptance.md` | **(Yeni)** Önceki aşamanın kabul ve risk raporu arşive alındı. |

---

## 6. Test ve Doğrulama Kanıtları

### 6.1 Gateway Testleri (`npm test --prefix whatsapp-gateway`)
- **Komut**: `npm test --prefix whatsapp-gateway`
- **Sonuç**: 54 test dosyasının tamamı **PASSED** (0 fail).
- **Özel Testler**:
  - `tests/test-media-download-dynamic-timeout-75.mjs`: 5 passed, 0 fail.
  - `tests/test-media-download-dynamic-timeout-76.mjs`: 6 passed, 0 fail.
    - `✔ 1. calculateTotalMediaBudget - video sizing, 10/25/50/100MB and ceilings`
    - `✔ 2. calculateTotalMediaBudget - fallbacks for missing, zero, and negative lengths`
    - `✔ 3. Client cancellation and terminal abort classification`
    - `✔ 4. Retry loop within unified deadline budget - single attempt success`
    - `✔ 5. Budget exhausted aborts retries immediately without wasting time`
    - `✔ 6. Client abort signal fast-fails without retries`

### 6.2 PostgreSQL 17 İzole Veritabanı Testleri (`pytest`)
- **Komut**:
  ```bash
  DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_test_isolated" PYTHONPATH=. pytest backend/tests/test_whatsapp_phase7_6_media_timeout.py backend/tests/test_whatsapp_phase7_5_media_timeout.py backend/tests/test_whatsapp_media_tenant_isolation.py -v
  ```
- **PostgreSQL Sürümü**: `PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0`
- **Sonuç**: **23 passed in 0.79s** (0 failed).

### 6.3 Tam WhatsApp Backend Regresyon Paketi (`pytest`)
- **Komut**: `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp* -v`
- **Sonuç**: **1035 passed, 8 skipped in 108.30s (0:01:48)** (0 failed).

### 6.4 Frontend Mantık & Build Doğrulaması
- `npm run verify:logic --prefix frontend`: **56 checks PASSED**.
- `npm run verify:media-coordination --prefix frontend`: **5 checks PASSED**.
- `npm run verify:bubble-media --prefix frontend`: **5 checks PASSED**.
- `npm run build --prefix frontend`: **✓ built in 3.25s (Exit code 0)**.

---

## 7. Production Canlı Dağıtım ve Sağlık Kanıtları

- **Dağıtım Komutu**: `bash scripts/deploy/release.sh`
- **Hedef Commit**: `3316336ed0309d0d85536717bdfb01a6fb7d86da`
- **Release ID**: `20261104T140754Z`
- **Yedek Konumu**: `/opt/tezlify/backups/releases/20261104T140754Z`

### 7.1 Canlı Container Durumu
```
NAMES               STATUS                    PORTS
tezlify-gateway     Up 19 seconds (healthy)   8787/tcp
tezlify-backend     Up 25 seconds (healthy)   8000/tcp
tz5327-restore-pg   Up 47 hours               5432/tcp
tezlify-caddy       Up 3 weeks (healthy)      0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp, 443/udp, 2019/tcp
tezlify-db          Up 4 weeks (healthy)      5432/tcp
```

### 7.2 Canlı Backend ve Gateway Sağlığı
```json
{
  "status": "healthy",
  "service": "Tezlify Backend API",
  "version": "1.0.0",
  "scraper_engine": "HTTP",
  "gateway_bridge": {
    "connected": true,
    "last_connected_at": "2026-11-04T14:10:15.911717+00:00",
    "last_event_at": "2026-11-04T14:10:55.916838+00:00",
    "last_pong_at": "2026-11-04T14:10:55.916880+00:00",
    "reconnect_count": 1
  }
}
```

### 7.3 Canlı WhatsApp Oturumu (Session 201)
- **Session ID**: `201`
- **Session Name**: `Hat 1`
- **Durum**: `SessionStatus.CONNECTED`
- **is_phone_online**: `True`
- **Gateway ID**: `1bd78836-c084-4cbf-b333-9386d44b7bd7`
- **Oturum Sürekliliği**: Oturum kesilmedi, QR relink tetiklenmedi, auth state başarıyla korundu.

---

## 8. Kalan Sınırlar ve Bir Sonraki Aşama Notları

1. **Stream Integrity %90 Eşiği**: Stream bütünlüğü doğrulamasında %90 eşiği AŞAMA 7.7 kapsamında ele alınmak üzere bilinçli olarak dokunulmadan korunmuştur.
2. **100 MB Video ve Çok Yavaş Ağlar**: 100 MB video 150 KB/s gibi aşırı dar bant genişliğinde 11.4 dakika sürdüğünden, HTTP sunucu kaynaklarını korumak amacıyla 420s (7 dakika) tavanı uygulanmaktadır. Bu sınır 250 KB/s ve üzeri bağlantılarda tam kapasiteyle çalışmaktadır.
3. **Browser E2E Altyapısı**: AŞAMA 7.7 kapsamında değerlendirilecektir.

---

**AŞAMA 7.6 Başarıyla Tamamlandı. Sistem stabil, testler yeşil ve canlı ortam sağlıklıdır.**
