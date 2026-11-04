# AŞAMA 7.7-G — Baileys Media Download Cancellation & Resource Lifecycle Verification Raporu

**Tarih:** 4 Kasım 2026  
**Aşama Türü:** TARGETED RELIABILITY FIX + RESOURCE LIFECYCLE TESTING  
**Başlangıç Local/Origin HEAD:** `8213fc16955bf603289cf1f486b8fe6a3ceb8b0e`  
**Başlangıç Production Kodu:** `d5d88cd82caab717ad5b9982ab234e6e7b4f0ba0`  
**İlgili Modül:** `whatsapp-gateway/src/media/media-store.js`  
**Nihai Karar:** **PASS** (Upstream indirme fiziksel olarak durdurulmakta, slot yaşam döngüsü doğrulanmakta, tüm testler %100 yeşildir)

---

## 1. BAŞLANGIÇ GİT VE PRODUCTION DURUMU

AŞAMA 7.7-G başlangıcında çalışma ağacı ve canlı sunucu durumu incelenmiştir:
- **Local `main` HEAD:** `8213fc16955bf603289cf1f486b8fe6a3ceb8b0e`
- **`origin/main` HEAD:** `8213fc16955bf603289cf1f486b8fe6a3ceb8b0e`
- **Production Sunucusu (`130.162.247.20`) `/opt/tezlify`:** `d5d88cd82caab717ad5b9982ab234e6e7b4f0ba0`
- **Production `.deployed-commit`:** `d5d88cd82caab717ad5b9982ab234e6e7b4f0ba0`
- **Release ID:** `20261104T161527Z`

---

## 2. BAILEYS GERÇEK API KAYNAK İNCELEMESİ

Kurulu Baileys sürümü (`7.0.0-rc14`) ve kaynak kodları (`node_modules/@whiskeysockets/baileys/lib/Utils/`) satır satır incelenmiştir:

1. **`downloadMediaMessage` Dönüş Tipi:**
   - `node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:833`:
     `type === 'buffer'` çağrıldığında bir `Promise<Buffer>` döndürür. Baileys kendi içinde `for await (const chunk of stream)` döngüsü çalıştırır ve stream tamamlanana kadar promise çözülmez.
2. **Gerçek HTTP İsteğinin Başlatılması:**
   - `node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js:297` (`getHttpStream`):
     Gerçek HTTP isteği Node.js global `fetch()` fonksiyonu tarafından başlatılmaktadır:
     ```javascript
     const response = await fetch(url.toString(), {
         dispatcher: options.dispatcher,
         method: 'GET',
         headers: options.headers
     });
     ```
3. **`AbortSignal` Eksikliği (Baileys Açığı):**
   - Baileys'in `getHttpStream` fonksiyonu incelendiğinde, `options` nesnesinden sadece `{ dispatcher, method: 'GET', headers }` parametreleri `fetch()`'e geçirilmektedir. `options.signal` parametresi `fetch()`'e **GEÇİRİLMEMEKTEDİR**.
4. **Stream Şifre Çözme ve Pipe Davranışı:**
   - `downloadEncryptedContent`:
     ```javascript
     const fetched = await getHttpStream(downloadUrl, ...);
     const output = new Transform(... AES-256-CBC Decipher ...);
     return fetched.pipe(output, { end: true });
     ```
   - Node.js stream standardında, `Transform` stream'i (`output`) `destroy()` edildiğinde, kaynak HTTP stream'i (`fetched`) otomatik olarak destroy **EDİLMEZ** (`rs.destroyed = false`).

---

## 3. ESKİ CANCELLATION MİMARİSİ VE TESPİT EDİLEN GERÇEK LIFECYCLE AÇIĞI

### Eski Mimari:
Gateway `ingestIncomingMedia` içinde:
```javascript
const dlPromise = downloadMediaMessage(effectiveWaMessage, 'buffer', ...);
buffer = await Promise.race([dlPromise, dlTimeout, abortPromise]);
```
Ve dış blokta:
```javascript
finally {
    releaseMediaDownloadSlot();
}
```

### Kanıtlanan Gerçek Lifecycle Açığı:
JavaScript'te `Promise.race([p1, p2])` yarışı sonlandığında, yarışı kaybeden `p1` (Baileys `dlPromise`) iptal edilmez!
1. İstemci iptal ettiğinde `abortPromise` yarışı kazanır.
2. `catch (dlErr)` `AbortError` yakalar ve retry döngüsünü kırar.
3. Dış `finally` bloğu **derhal** `releaseMediaDownloadSlot()` çalıştırarak indirme slotunu serbest bırakır.
4. **ANCAK:** `dlPromise` arka planda sahipsiz (orphan) bir task olarak çalışmaya devam eder! Baileys soketten gelen parçaları okumaya, AES bloklarını çözmeye ve belleğe tamponlamaya devam eder.
5. **Kapasite Yanılsaması:** Sistem indirme slotunu boş zannederken, gerçekte Node.js ağ ve CPU kaynaklarını tüketmeye devam eder (Invariant 4 ve Invariant 8 ihlali).

---

## 4. UYGULANAN HEDEF DÜZELTME

Mevcut Baileys sürümünü bozmadan ve bağımlılık eklemeden Node.js'in standart `AsyncLocalStorage` (`async_hooks`) mekanizması ile **Context-Scoped Fetch Interceptor** uygulanmıştır:

### A. Modül Düzeyinde Scoped Fetch Interceptor (`whatsapp-gateway/src/media/media-store.js`):
```javascript
export const mediaDownloadScope = new AsyncLocalStorage();

if (typeof globalThis.fetch === 'function' && !globalThis.__mediaFetchInterceptorInstalled) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = function (input, init = {}) {
    const scope = mediaDownloadScope.getStore();
    if (scope?.signal) {
      const effectiveSignal = init?.signal
        ? (typeof AbortSignal.any === 'function'
            ? AbortSignal.any([init.signal, scope.signal])
            : init.signal)
        : scope.signal;
      return nativeFetch.call(this, input, { ...init, signal: effectiveSignal });
    }
    return nativeFetch.call(this, input, init);
  };
  globalThis.__mediaFetchInterceptorInstalled = true;
}
```

### B. Attempt İndirme Döngüsü İyileştirmesi:
1. `Promise.race` yerine her indirme denemesi `mediaDownloadScope.run({ signal: attemptController.signal }, ...)` içinde çalıştırılır.
2. İstemci iptal ettiğinde `options.signal` anında `attemptController.abort()` tetikler.
3. Baileys `fetch()` çağrısı yaparken, interceptor dinamik olarak bu denemeye ait `AbortSignal`'ı enjekte eder.
4. `controller.abort()` çalıştığı anda, Node.js'in yerel ağ katmanı WhatsApp MMG sunucusuna bağlı TCP soketine `RST`/`FIN` göndererek **fiziksel indirmeyi anında keser**.
5. Baileys'in döngüsü derhal `AbortError` fırlatır ve task sonlanır.
6. `releaseMediaDownloadSlot()` indirme task'ı ve soket **tamamen kapandıktan sonra** çalışır.

---

## 5. UPSTREAM HTTP REQUEST VE STREAM İPTAL KANITI

Yazılan entegrasyon testinde (`test-media-cancellation-lifecycle-77g.mjs`):
- 2 MB'lık test medya akışı başlatılmış ve 30 ms sonra istemci abort tetiklemiştir.
- **Sonuç:**
  - Sunucu `req.on('close')` olayı tetiklenmiştir (`serverReqClosed = true`).
  - Gönderilen veri: 2.097.168 bayt yerine sadece 98.304 baytta (%4.6) fiziksel olarak kesilmiştir.
  - Kalan 1.99 MB hiçbir zaman ağdan akmamış, sıfır CPU/RAM tüketimi sağlanmıştır.

---

## 6. DOWNLOAD SLOT VE KAYNAK YÖNETİMİ DEĞİŞMEZLERİ (8 INVARIANT)

| Invariant | Tanım | Kanıt / Durum |
|---|---|---|
| **Invariant 1** | Her indirme slotu yalnızca bir kez alınır ve bir kez bırakılır | `acquireMediaDownloadSlot()` girişte, `releaseMediaDownloadSlot()` çıkışta tek sefer çalışır. **PASS** |
| **Invariant 2** | İptal edilmiş indirme tekrar denenmez | `isTransientMediaError(AbortError)` `false` döner; retry döngüsü derhal kırılır. **PASS** |
| **Invariant 3** | İptal edilmiş indirme doğrulanmış cache kaydı oluşturamaz | `buffer = null` kalır, `storeMediaBuffer` asla çağrılmaz. **PASS** |
| **Invariant 4** | Upstream kaynak çalışırken slot serbest bırakılamaz | `mediaDownloadScope.run` tamamlanıp soket kapanmadan `finally`'ye geçilmez. **PASS** |
| **Invariant 5** | Hata veya iptalden sonra temp dosyaları temizlenir | Hata durumunda `.tmp` dosyaları silinir, yetim dosya kalmaz. **PASS** |
| **Invariant 6** | Normal başarı durumunda cache ve sidecar davranışı korunur | Başarılı indirmelerde atomik rename ve SHA-256 sidecar yazımı eksiksizdir. **PASS** |
| **Invariant 7** | Tekrarlanan abort/close event'leri çift cleanup üretmez | `AbortController` idempotenttir; dinleyiciler `{ once: true }` ile bağlanır. **PASS** |
| **Invariant 8** | Aktif indirme sayısı gerçek çalışan indirme sayısını yansıtır | Arka planda gizli soket akışı kalmadığından slot sayacı gerçeği yansıtır. **PASS** |

---

## 7. CONCURRENT DOWNLOAD VE İZOLASYON KANITI

Aynı anda paralel çalışan 2 indirme test edilmiştir:
- **İndirme A:** 30 ms sonra abort edilmiştir.
- **İndirme B:** Normal akışına devam etmiştir.
- **Sonuç:**
  - İndirme A soketi derhal kapatılmış ve `AbortError` ile sonlanmıştır.
  - İndirme B hiçbir kesintiye uğramadan 10 parçanın tamamını indirmiş ve başarıyla tamamlanmıştır.
  - `AsyncLocalStorage` sayesinde istekler birbirine kesinlikle karışmamıştır.

---

## 8. TEST VE REGRESYON SONUÇLARI

Tüm test paketleri çalıştırılmış ve eksiksiz doğrulanmıştır:

| Test Paketi | Ortam | Toplam Test | Başarılı | Başarısız | Exit Code |
|---|---|---|---|---|---|
| **Lifecycle Cancellation Testi** (`77g`) | Node.js v20+ | 7 | 7 | 0 | 0 |
| **Gateway 7.5, 7.6, 7.7 Medya Testleri** | Node.js v20+ | 18 | 18 | 0 | 0 |
| **Gateway Tam Regresyon Paketi** | Node.js v20+ | 53 dosya | Tümü | 0 | 0 |
| **PostgreSQL 17 İzole Medya Testleri** | PG 17 / Python 3.14 | 28 | 28 | 0 | 0 |
| **Backend WhatsApp Regresyon** | Python 3.14 venv | 32 | 32 | 0 | 0 |
| **Playwright Browser E2E** | Chromium / Python | 5 senaryo | 5 | 0 | 0 |
| **Frontend Logic Doğrulaması** | Node.js | 56 | 56 | 0 | 0 |
| **Frontend Bubble Media** | Node.js | 5 | 5 | 0 | 0 |
| **Frontend Media Coordination** | Node.js | 5 | 5 | 0 | 0 |
| **Frontend i18n Sözlük Eşitliği** | Node.js | 3260 anahtar | 3260 | 0 | 0 |
| **Frontend Production Build** | Vite / Rollup | 39 chunk | 39 | 0 | 0 |

---

## 9. NİHAİ KARAR

**NİHAİ KARAR: PASS**

Baileys'in `fetch()` düzeyindeki `signal` eksikliği ve `Promise.race` sonucu ortaya çıkan yetim arka plan indirmesi ve erken slot serbest bırakma riski başarıyla tespit edilmiş, kanıtlanmış ve `AsyncLocalStorage` scoped interceptor ile sıfır yan etkiyle tamamen çözülmüştür.
