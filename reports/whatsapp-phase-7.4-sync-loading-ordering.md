# AŞAMA 7.4 — WhatsApp Sync, Loading Gate, Conversation Refresh ve Message Ordering Raporu

**Tarih**: 2026-11-04  
**Kapsam**: WhatsApp Loading Gate kilitlenme çözümü, İlk Senkron Sonrası Otomatik Sohbet Yenileme, Mesaj Kronolojik Sıralama & Nedensellik (Causality) Tie-Breaker, Eski Mesaj Sayfalama Hata Yönetimi ve Retry  
**Durum**: TAMAMLANDI, DOĞRULANDI, PRODUCTION DEPLOY EDİLDİ  
**Production Commit SHA**: `482809997ec0c44d53efce122dbb68fd7d3c7770`

---

## 1. Yönetici Özeti (Executive Summary)

AŞAMA 7.0 genel fonksiyonel denetiminde tespit edilen ve kullanıcı deneyimini doğrudan etkileyen kritik senkronizasyon ve sohbet akışı kusurları AŞAMA 7.4 kapsamında eksiksiz olarak çözüldü:

1. **Loading Gate Sonsuz Bekleme Kusuru (P0)**:
   - `resolve_gate_phase` fonksiyonu; `initial_sync_completed` damgası bulunmayan ancak bağlantısı kopmuş (`DISCONNECTED`, `BANNED`, `ERROR`, `RELINK_REQUIRED`, `UNAVAILABLE`) oturumlarda `syncing_history` durumunda takılı kalıyordu. Bu durum düzeltildi; hat kopmuşsa kapı `error (disconnected)` durumuna fail-closed geçer, hat daha önce senkronize edilmişse kullanıcı sohbetlerini offline okumaya devam eder (`ready, complete`).
   - Backend yeniden başlatıldığında veya `SyncJob` bellekten silindiğinde, veritabanında daha önceden aktarılmış sohbetler bulunmasına rağmen durable stamp (`initial_sync_completed_at`) eksik kalmışsa, `get_loading_gate` bunu otomatik algılayarak veritabanına damgalar ve kapıyı anında açar.
   - Bağlantısı `CONNECTED` olan ancak hiçbir sohbeti bulunmayan ve in-flight sync işi çalışmayan oturumlarda arka planda initial sync orchestrator otomatik tetiklenerek (`_schedule_initial_sync`) sonsuz boş bekleme engellendi.
   - SyncJob state machine'ine arka plan task çökmesi (`task.done()`) ve 15 dakikalık stale sync timeout koruması eklendi.

2. **QR ve İlk Senkron Sonrası Sohbet Listesi Otomatik Yenileme (P1)**:
   - Gateway veya backend tarafında ilk senkron tamamlandığında (`session_sync_completed` event'i geldiğinde), arayüzde yalnızca stats ve session bilgisi yenileniyor, ancak `loadConversations(true)` çağrılmıyordu.
   - `WhatsAppHubPage.tsx` içerisinde hem `handleWsEvent` hem de `handleWs` event handler'larına `loadConversations(true)` entegre edildi. Kullanıcı F5 yapmadan, mevcut sohbet seçimini, scroll pozisyonunu ve unread durumunu kaybetmeden sohbet listesi otomatik olarak güncellenir.

3. **Aynı Zaman Damgasına Sahip Mesajların Kronolojik Sıralanması & Tie-Breaker (P2)**:
   - `getMessageTimestampMs` ve `normalizeMessageTimestampMs` ile 10 haneli unix saniye (`1730000000`), 13 haneli milisaniye ve ISO tarih formatları standardize edildi (10 haneli saniyelerin 1970 yılına dönmesi engellendi).
   - `compareMessagesChronological`: Aynı saniyeye/milisaniyeye sahip mesajlarda 13 haneli istemci/optimistic ID (`Date.now()`) ile kısa veritabanı ID'sinin (`idA - idB`) aritmetik çıkarılması sonucu oluşan sıralama tersine dönme hatası tamamen giderildi.
   - Deterministik nedensellik (causality) kuralları uygulandı:
     - Aynı timestamp'te `INBOUND` (müşteri sorusu) daima `OUTBOUND` (kullanıcı yanıtı) öncesine sıralanır.
     - Onaylanmış gerçek veritabanı ID'si (`isRealDbId`, `< 1_000_000_000`), henüz sunucu onayı almamış optimistic ID'nin öncesine yerleştirilir.
     - İki gerçek DB ID'si `idA - idB` şeklinde sıralanır.
     - İki optimistic veya aynı ID'li mesaj `wa_message_id`, `client_message_id` ve string `id` üzerinden deterministik leksikografik sıralanır.
   - `whatsappMessageMerge.ts`: `isRealDbId` kontrolü ile gerçek veritabanı ID'sinin geçici optimistic ID tarafından ezilmesi engellendi.

4. **Eski Mesaj Sayfalama Hata Yönetimi & In-Thread Retry (P2)**:
   - `WhatsAppHubPage.tsx` içerisinde `loadOlderMessages` başarısız olduğunda `error: false` atanarak hatanın yutulması düzeltildi; non-404 ağ veya sunucu hatalarında `error: true` flag'i atanarak `hasMore` korundu.
   - `ChatThread.tsx` içerisindeki `olderMessagesAffordance`: Hata durumunda sayfa başına açık bir yeniden deneme butonu (`paginationRetry`) eklendi.
   - Sayfa yukarı kaydırılırken hata durumunda istek fırtınası oluşmaması için `!pagingError` denetimi eklendi; kullanıcı yeniden deneme butonuna bastığında temiz bir şekilde tekrar istek gönderilir.
   - `useWhatsAppConversation.ts` ve `LeadDetailDrawer.tsx` bileşenlerine de `pagingError` desteği kazandırıldı.

---

## 2. Değiştirilen Dosyalar ve Mimari Detaylar

| Dosya | Değişiklik Özeti |
|---|---|
| `backend/app/services/whatsapp_service.py` | `resolve_gate_phase` disconnected fail-closed mantığı; `get_loading_gate` DB durable stamp auto-recovery ve unsynced session tetikleme. |
| `backend/app/services/whatsapp/orchestration/sync.py` | `get_sync_job` içerisine dead task ve stale timeout (15 dk) kurtarma mekanizması eklendi. |
| `backend/tests/test_whatsapp_phase7_4_sync_loading.py` | Gate faz çözümleri, disconnected oturumlar, timeout ve DB auto-stamp senaryolarını test eden kapsamlı test paketi. |
| `frontend/src/features/whatsapp/lib/whatsappOrdering.ts` | `normalizeMessageTimestampMs`, `isRealDbId`, nedensellik ve optimistic/DB ID tie-breaker kuralları. |
| `frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts` | `isRealDbId` ile gerçek DB ID'sinin optimistic ID tarafından ezilmesini önleme. |
| `frontend/src/features/whatsapp/components/WhatsAppSyncGate.tsx` | `{sync?.error \|\| loadingGate?.error}` desteği ile Loading Gate hatalarının kullanıcıya görünür kılınması. |
| `frontend/src/features/whatsapp/components/ChatThread.tsx` | Sayfalama hata retry butonu (`paginationRetry`) ve kaydırma fırtınası önleme. |
| `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` | `pagingError` state yönetimi ve hata yakalama. |
| `frontend/src/features/leads/components/LeadDetailDrawer.tsx` | `pagingError` prop'unun `ChatThread` bileşenine aktarılması. |
| `frontend/src/pages/WhatsAppHubPage.tsx` | `loadOlderMessages` hata state'i (`error: true`), `session_sync_completed` sonrası `loadConversations(true)`. |
| `frontend/src/locales/tr.ts` & `en.ts` | `paginationRetry` sözlük anahtarlarının birebir senkron eklenmesi (3259 anahtar). |
| `frontend/scripts/verify-whatsapp-logic.mjs` | Phase 7.4 normalizasyon, DB ID ve sıralama determinizmi için yeni testler (56/56 PASS). |

---

## 3. Doğrulama ve Test Kanıtları

### 3.1 Backend Testleri
```bash
source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_phase7_4_sync_loading.py backend/tests/test_whatsapp_repositories.py backend/tests/test_whatsapp_sync_job.py -v
```
**Sonuç**:
- 65 testin tamamı **PASSED** (0 failed, 6.05s).

### 3.2 İzole Gerçek PostgreSQL 17 Test Kanıtı
```bash
DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_test_isolated" PYTHONPATH=. pytest backend/tests/test_whatsapp_phase7_4_sync_loading.py -v
```
**Sonuç**:
- PostgreSQL 17.11 üzerinde 7 testin tamamı **PASSED** (0.39s).

### 3.3 Frontend Mantık & Sözlük Senkronizasyon Testleri
```bash
npm run verify:logic --prefix frontend
```
**Sonuç**:
- 56 doğrulamadan 56'sı **PASS** (en=3259 keys, tr=3259 keys tam eşitlik).

### 3.4 Frontend TypeScript & Hermetik Build
```bash
npm run build --prefix frontend
```
**Sonuç**:
- `tsc && vite build` sıfır hata ile tamamlandı (2.51s, 39 asset üretildi).

### 3.5 WhatsApp Gateway Testleri
```bash
npm test --prefix whatsapp-gateway
```
**Sonuç**:
- Tüm test suite'leri eksiksiz **PASS** (18/18 state machine, 19/19 pending durability, 8/8 logout consistency, 9/9 protocol events).

---

## 4. Production Canlı Dağıtım (Deployment) Kanıtı

1. **Commit & Push**:
   - Commit: `4828099 fix(whatsapp): stabilize sync loading and conversation history`
   - Push: `https://github.com/isatezcan444/Tezlify.git` `main -> main`
2. **Release Betiği**:
   - `bash scripts/deploy/release.sh` çalıştırıldı.
   - Hermetik Docker imajları build edildi.
   - İzole adacık container ve izole DB üzerinde sağlık testleri yapıldı.
   - Sıfır kesintiyle blue-green cutover gerçekleştirildi.
   - Caddy frontend hash doğrulaması: `%100 birebir aynı`.
3. **Canlı Sunucu Doğrulaması**:
   - Sunucu: Oracle Cloud (`130.162.247.20`)
   - `cat /opt/tezlify/.deployed-commit`: `482809997ec0c44d53efce122dbb68fd7d3c7770`
   - `git rev-parse HEAD`: `482809997ec0c44d53efce122dbb68fd7d3c7770`
   - Konteyner Durumları:
     - `tezlify-backend`: Up (healthy)
     - `tezlify-gateway`: Up (healthy)
     - `tezlify-caddy`: Up (healthy)
     - `tezlify-db`: Up (healthy)
   - WhatsApp Oturum 201 (`Hat 1`):
     - `status`: `CONNECTED`
     - `is_phone_online`: `t`
     - `error_message`: `None`
   - Smoke Test:
     - `node frontend/scripts/verify-production-whatsapp.mjs`: `6/6 checks passed`.

---

## 5. Sonuç

AŞAMA 7.4'ün tüm hedefleri (Loading Gate sonsuz bekleme koruması, ilk senkronizasyon sonrası otomatik sohbet yenileme, milisaniye ve nedensellik sıralama kuralları, eski mesaj sayfalama retry mekanizması) başarıyla tamamlanmış, test edilmiş ve production ortamında devreye alınmıştır.
WhatsApp sistemi kesintisiz çalışmakta ve aktif Hat 1 oturumu canlı durumunu korumaktadır.
