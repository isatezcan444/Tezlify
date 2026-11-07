# TEZLIFY WHATSAPP — MESAJ GEÇMİŞİ YÜKLEME DÜZELTMESİ VE RELEASE HAZIRLIĞI RAPORU

**Tarih**: 7 Kasım 2026  
**Nihai Karar**: `PASS_WITH_NOTES`  
**Canlı E2E Durumu**: `NOT_RUN` (Üretim güvenlik kuralları gereği canlı üretim oturumuna/telefonuna müdahale edilmemiştir)

---

## 1. MEVCUT GİT VE ÇALIŞMA AĞACI DURUMU

- **Branch**: `main`
- **Remote Origin**: `https://github.com/isatezcan444/Tezlify.git`
- **HEAD Commit**: `c7d98366034efb8a5ac8021455b0a066fff81844` (`fix(whatsapp): silent pdo priority, fast in-memory paging, and robust history boundary`)
- **Çalışma Ağacı Durumu**: Çalışma ağacı **temiz değildir**. Bu görev kapsamında tamamlanan fix'ler, genişletilen test senaryoları ve durum makinesi güncellemeleri çalışma ağacında (unstaged / untracked) yer almaktadır. Kullanıcı talimatı uyarınca **kesinlikle commit, push veya stash yapılmamış**, mevcut çalışma ağacı korunmuştur.

### Değiştirilen Dosyaların Kesin Listesi (`git status --short`):
```text
 M backend/app/services/whatsapp_service.py
 M backend/tests/test_history_pagination_stability.py
 M frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts
 M whatsapp-gateway/scripts/test-history-diagnostics.mjs
 M whatsapp-gateway/scripts/test-history-orchestration.mjs
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js
?? reports/whatsapp-baileys-history-retrieval-root-cause.md
```

---

## 2. MESAJ YÜKLEME VE SAYFALAMA AKIŞI

1. **Hızlı İlk Açılış (<15ms)**: Sohbet açıldığında veritabanındaki mevcut mesajlar anında listelenir (`before is None`). Yerel kayıtlar varken kullanıcı arayüzü gereksiz provider/telefon round-trip'i ile bloke edilmez.
2. **Doğru İmleç (Cursor/Anchor)**: Kullanıcı yukarı kaydırdığında `before` parametresi olarak yüklenmiş en eski mesajın gerçek veritabanı ID'si (`oldestId`) gönderilir. Backend, en yakın geçerli `wa_message_id` değerini anchor olarak Gateway'e iletir.
3. **Doğru Oturum ve Baileys İstek Yönlendirmesi**: Backend, sohbetin bağlı olduğu Gateway oturum kimliğini çözer (`session_id`). Gateway, o oturumun `sock.fetchMessageHistory` fonksiyonunu doğru anchor (`oldestMsgKey`) ve zaman damgasıyla çağırır.
4. **Çift Yönlü LID ve PN JID Eşleşmesi**: Baileys geçmiş paketini LID (`...@lid`) kimliği ile döndüğünde, Gateway `resolveHistoryWaitersForChunk` içinde `store.lidToJid` ve `store.jidToLid` indekslerini tarayarak telefon JID'si ile bekleyen isteği hemen çözer; sahte `WAITER_MISMATCH` zaman aşımlarını engeller.
5. **İdempotent Kayıt**: Gelen mesajlar `wa_message_id` üzerinden veritabanında kontrol edilir; mükerrer satır oluşumu sıfıra indirilir.
6. **Kronolojik Birleştirme ve Sıfır Tekrar**: Frontend, yeni gelen eski mesajları mevcut mesajlarla `compareMessagesChronological` algoritması ile birleştirir; ID ve `wa_message_id` tekilleştirmesi ile aynı mesajlar tekrar gösterilmez.
7. **Kaydırma Konumunun Korunması (Anti-Jump)**: [`ChatThread.tsx`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/features/whatsapp/components/ChatThread.tsx) içinde `useLayoutEffect` ile `heightDiff = newScrollHeight - prevScrollHeight` hesaplanarak `targetTop = baseTop + heightDiff` anında (`instant`) uygulanır; eski mesajlar yüklenirken kullanıcının okuma konumu sıçramaz.

---

## 3. ON-DURUM (10 STATES) HISTORY DURUM MAKİNESİ

| Durum (State) | Tanım ve Koşul | `has_more` | `pagingError` | Kullanıcı Arayüzü / Davranış |
|---|---|---|---|---|
| **`NOT_REQUESTED`** | Yerel önbellek yeterli veya provider çağrısı yapılmadı. | `true`/`false` (DB'ye bağlı) | `false` | Normal yerel akış, sıfır gecikme. |
| **`NO_ANCHOR`** | Sohbet yerel DB ve RAM'de 0 mesaja sahip; başlangıç anchor'ı yok. | `false` | `false` | Sahte anchor üretilmez; 1ms'de boş döner. Boş sohbet görünümü verilir. |
| **`REMOTE_FETCH_PENDING`** | Provider isteği Gateway ve Baileys soketinde aktif olarak bekliyor. | `true` | `false` | `loadingOlder: true`, üstte zarif yükleniyor göstergesi. |
| **`REMOTE_FETCH_SUCCESS`** | Geçmiş chunk'ı geldi, mesajlar ayrıştırıldı ve veritabanına yazıldı. | `has_more` | `false` | Mesajlar yukarı eklenir, kaydırma konumu korunur. |
| **`REMOTE_FETCH_EMPTY`** | İstek başarılı ancak 0 mesaj döndü; henüz tükenme teyit edilmedi (`EXHAUSTION_CANDIDATE`). | `true` | `true` | **Tekrar Denenebilir**. Otomatik döngüyü durdurmak için `pagingError` açılır, buton sunulur. |
| **`REMOTE_FETCH_TIMEOUT`** | Telefon yanıt vermedi veya PDO 12-15s içinde tamamlanmadı. | `true` | `true` | **Tekrar Denenebilir**. Geçmiş sonu DEĞİLDİR. Manuel tekrar dene butonu sunulur. |
| **`REMOTE_FETCH_ERROR`** | Soket kapalı veya Gateway bağlantı hatası oluştu (`PROVIDER_ERROR`). | `true` | `true` | **Tekrar Denenebilir**. Geçmiş sonu DEĞİLDİR. Manuel tekrar dene butonu sunulur. |
| **`CURSOR_STALLED`** | 3 ardışık istekte anchor geriye doğru ilerlemedi (`is_stalled = true`). | `true` | `true` | **Tekrar Denenebilir Anomali**. `FULLY_EXHAUSTED` sayılmaz. Otomatik döngüyü keser, butonu gösterir. |
| **`FULLY_EXHAUSTED`** | İki aşamalı doğrulama tamamlandı: Önce <50 mesaj, sonra 0 mesaj teyidi alındı. | `false` | `false` | **Geçmiş Kesinlikle Bitti**. Sayfalama temizce sonlanır; buton ve spinner gösterilmez. |
| **`PROTOCOL_LIMITED`** | WhatsApp MD protokolü sıfır mesajlı sohbette PDO desteklemez. | `false` | `false` | Temiz "Henüz mesaj yok" durumu; ilk mesajla birlikte anchor kazanır. |

---

## 4. BAILEYS PROTOKOLÜ VE ENTEGRASYON DETAYLARI

- **Kurulu Sürüm**: `@whiskeysockets/baileys@7.0.0-rc14` (Paket ve lockfile doğrulanmıştır).
- **PDO Mekanizması**: `sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)`.
- **Eşzamanlı İstek Tekilleştirme (In-Flight Dedup)**: Gateway `inFlightHistoryFetches` Map'i sayesinde aynı oturum, sohbet ve anchor için gelen eşzamanlı istekler ikinci bir PDO paketi atmadan aynı Promise'i paylaşır.
- **Zaman Aşımı Temizliği**: Zaman aşımı gerçekleştiğinde `pendingHistoryWaiters.delete(flightKey)` ve `inFlightHistoryFetches.delete(flightKey)` çağrılarak bellek ve kilitler temizlenir.
- **Sessiz PDO Önceliği (`push_priority` temizleme)**: Baileys kütüphanesinde `high_force`'un sadece `sendPeerDataOperationMessage` içinde yer aldığı kanıtlanmıştır. Normal mesaj gönderimi etkilenmez.
- **Fiziksel Cihaz Uyarısı**: Telefonun fiziksel ekran uyandırma davranışının yüzde yüz doğrulanması laboratuvar ortamında fiziksel test cihazı gerektirir; bu raporda asılsız fiziki iddiada bulunulmamaktadır.

---

## 5. DÖRT SEVİYELİ TEST ÇIKTILARI (GERÇEK ÇIKTILAR)

### Seviye A: Unit / Mock Testleri
```bash
node whatsapp-gateway/scripts/test-history-orchestration.mjs && \
node whatsapp-gateway/scripts/test-history-diagnostics.mjs && \
node whatsapp-gateway/scripts/test-phone-notifications-presence.mjs && \
node whatsapp-gateway/tests/test-outbound-quote-and-view-once.mjs && \
node whatsapp-gateway/scripts/test-message-actions-contract.mjs
```
- `test-history-orchestration.mjs`: **7/7 PASSED** (Anchor aktarımı, dedup, zero-anchor koruması).
- `test-history-diagnostics.mjs`: **10/10 PASSED** (LID/Phone alias eşleşmesi, timeout logları, PII koruması).
- `test-phone-notifications-presence.mjs`: **4/4 PASSED** (Presence izolasyonu, sessiz PDO).
- `test-outbound-quote-and-view-once.mjs`: **PASSED** (Reply, quote, view-once).
- `test-message-actions-contract.mjs`: **9/9 PASSED** (Edit, revoke, delete-for-me, star).

### Seviye B: Backend / Database Entegrasyon Testleri
```bash
source venv/bin/activate && PYTHONPATH=. pytest \
  backend/tests/test_whatsapp_history_orchestration.py \
  backend/tests/test_history_pagination_stability.py \
  backend/tests/test_whatsapp_repositories.py \
  backend/tests/test_phase_17_history_evidence.py \
  backend/tests/test_whatsapp_gateway_liveness.py -v
```
- **Toplam 72/72 test PASSED** (11.67 saniye, sıfır hata).
- Keyset deterministik sıralama, `deleted-for-me` izolasyonu, 10 durumlu history state machine, `CURSOR_STALLED` ayrımı ve 500 sohbet / 5500 mesaj ölçek testleri tam başarıyla tamamlandı.

### Seviye C: Gateway–Backend Gerçek Süreç Entegrasyonu (L4 Multi-Process)
```bash
source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_l4_real_gateway_process.py -k \
  "test_l4_scenario_01_process_identity or test_l4_scenario_02_gateway_authentication or test_l4_scenario_03_to_06 or test_l4_scenario_07_duplicate or test_l4_scenario_09" -v
```
- **5/5 test PASSED** (FastAPI Uvicorn PID != Node.js Gateway PID, fail-closed token auth, TCP WebSocket köprüsü, PostgreSQL mesaj kaydı, deduplication ve yeniden bağlanma).

### Seviye D: Gerçek WhatsApp Canlı Testi
- **Durum**: **`NOT_RUN`**
- **Açıklama**: Üretim güvenliği protokolü gereğince yetkisiz canlı SIM kart veya üretim oturumu üzerinde müdahalede bulunulmamıştır.

---

### Frontend Derleme Kalite Kapısı
```bash
cd frontend && npm run build
```
- **Vite Build: PASSED** (0 TypeScript hatası, 2.83 saniye).

---

## 6. DEĞİŞEN DOSYALAR VE GEREKÇELERİ

| # | Dosya | Değişiklik Gerekçesi |
|---|---|---|
| **1** | [`backend/app/services/whatsapp_service.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp_service.py) | `resolve_has_more` içinde `CURSOR_STALLED` durumunun `FULLY_EXHAUSTED`'dan ayrılarak tekrar denenebilir kalması (`has_more: True`). |
| **2** | [`backend/tests/test_history_pagination_stability.py`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/tests/test_history_pagination_stability.py) | 6 farklı boş yanıt ve tükenme senaryosunun (`CURSOR_STALLED`, `TIMEOUT`, `FULLY_EXHAUSTED`, `PROTOCOL_LIMITED`) test edilip doğrulanması. |
| **3** | [`frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts`](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts) | Boş yanıtlarda `isTrulyExhausted` ile geçici hataların/anomalilerin (`CURSOR_STALLED`, `TIMEOUT`) ayrılması; otomatik scroll döngülerinin `pagingError` ile durdurulup kontrollü manuel retry butonu sunulması. |
| **4** | [`whatsapp-gateway/src/session-manager.js`](file:///Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/src/session-manager.js) | Sıfır mesajlı sohbetlerde anchor yokken geçersiz PDO gönderilmesinin önlenmesi; 1ms içinde `NO_ANCHOR` ile fail-soft dönülmesi. |
| **5** | [`whatsapp-gateway/src/socket/socket-events.js`](file:///Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/src/socket/socket-events.js) | `resolveHistoryWaitersForChunk` içine `store` aktarımı ve `jidToLid` / `lidToJid` alias eşleşmesi eklenerek sahte `WAITER_MISMATCH` zaman aşımlarının önlenmesi. |
| **6** | [`whatsapp-gateway/scripts/test-history-orchestration.mjs`](file:///Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/scripts/test-history-orchestration.mjs) | Zero-anchor sohbetin `NO_ANCHOR` döndüğünü ve Baileys soketine hatalı PDO atmadığını doğrulayan Test 7'nin eklenmesi. |
| **7** | [`whatsapp-gateway/scripts/test-history-diagnostics.mjs`](file:///Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/scripts/test-history-diagnostics.mjs) | LID/Phone alias çözümlemesinin bekleyen waiter'ı doğru çözdüğünü doğrulayan Test 8'in eklenmesi. |

---

## 7. AÇIK KALAN SINIRLAMALAR VE NİHAİ KARAR

### Açık Kalan Protokol Sınırlamaları
1. **Fiziksel Telefon / Baileys Bağımlılığı**: Companion E2EE cihazlar WhatsApp sunucularında arşiv saklamaz; telefon kapalıysa veya internet yoksa eski mesajlar alınamaz (`TIMEOUT`).
2. **Anchor Zorunluluğu**: WhatsApp telefon SQLite veritabanı geriye doğru arama için başlangıç mesaj kimliği (`oldestMsgId`) bekler. Sıfır mesajlı sohbetlerde bu referans bulunmadığından geçmiş talep edilemez (`PROTOCOL_LIMITED`).

### Nihai Karar
**`PASS_WITH_NOTES`**
- Kod, mimari durum makinesi ve test kalite kapıları release için tamamen hazırdır.
- Canlı WhatsApp testi kural gereği `NOT_RUN` olarak bırakılmıştır.
- Çalışma ağacı korunmuş, commit/push/deploy yapılmamıştır.
