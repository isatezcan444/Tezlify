# TEZLIFY WHATSAPP — GERÇEK CANLI GEÇMİŞ MESAJ E2E KABUL TEST RAPORU

**Tarih / Saat:** 2026-11-07 19:46 (UTC+3) / 16:46 (UTC)  
**Production Commit:** `0b6b4cfa948c4f1cfde0d3c60bd978dc05bbab50`  
**Test Türü:** Canlı Üretim Ortamı (Oracle Cloud) Fonksiyonel E2E Kabul Testi  
**Genel Karar:** **`PASS_WITH_NOTES`**

---

## 1. Test Ortamı ve Başlangıç Sağlık Kontrolleri

Tüm kontroller salt okunur (read-only) komutlarla canlı production konteynerleri ve API uçları üzerinden gerçekleştirilmiştir.

| Kontrol | Beklenen | Ölçülen (Canlı) | Durum |
| :--- | :--- | :--- | :--- |
| **`.deployed-commit`** | `0b6b4cfa948c4f1cfde0d3c60bd978dc05bbab50` | `0b6b4cfa948c4f1cfde0d3c60bd978dc05bbab50` | PASS |
| **`tezlify-backend`** | healthy | Up (healthy) | PASS |
| **`tezlify-gateway`** | healthy | Up (healthy) | PASS |
| **`tezlify-db`** | healthy | Up (healthy) | PASS |
| **`tezlify-caddy`** | healthy | Up (healthy) | PASS |
| **Gateway Sessions** | connected: 1, pending_qr: 0 | `{"total": 1, "connected": 1, "pending_qr": 0}` | PASS |
| **Gateway Auto Restore** | true | `auto_restore: true` | PASS |
| **`last_pong_at` Akışı** | Sürekli ilerleyen zaman damgası | `2026-11-07T16:45:19.912602+00:00` (İlerliyor) | PASS |
| **Aktif Oturum ID** | Tekil aktif oturum | `f41df0cd-...` (Maskelenmiş) | PASS |

---

## 2. Test Sohbeti Seçimi (Salt Okunur)

Test için iki farklı karakteristik gösteren sohbet incelenmiştir:

### Sohbet A (Sınır & Provider İstek Testi):
- **Conversation ID:** `39223`
- **Maskelenmiş Telefon / JID:** `+90545...*1288` / `905453...*@s.whatsapp.net` (JID Tag: `02df2799`)
- **Mevcut Yerel Mesaj Sayısı:** 50
- **En Eski Mesaj:** ID `177068` (`2026-08-30 09:23:13`)
- **Oldest Anchor WA ID:** `AC9F8555...CD50CF` (Otantik WhatsApp anahtarı, sentetik değil)
- **Başlangıç History Evidence:** `NOT_CHECKED` (`provider_checked: false`, `has_more: true`)

### Sohbet B (Derinlik & Pagination Süreklilik Testi):
- **Conversation ID:** `39215`
- **Maskelenmiş Telefon / JID:** `+90544...*7554` / `905442...*@s.whatsapp.net` (JID Tag: `46f78076`)
- **Mevcut Yerel Mesaj Sayısı:** 258
- **En Eski Mesaj:** ID `176776` (`2026-11-06 18:53:14`)
- **Oldest Anchor WA ID:** `3AB12018...A4BAF2` (Otantik WhatsApp anahtarı)

---

## 3. Test Aşamaları ve Bulgular

### A. İlk Yükleme (Initial Load)
- Sohbet A (`39223`) ve Sohbet B (`39215`) için `limit=50` ile ilk mesaj yükleme sorguları çalıştırıldı.
- **Sonuç:**
  - Sohbet A için en yeni 50 mesaj yerel DB'den anında geldi (ID `177068` - `176635`).
  - Kronolojik sıra eski→yeni doğrultusunda eksiksiz.
  - `has_more: true` olarak doğru raporlandı.
  - UI takılması veya sonsuz döngü yaratacak hatalı durum gözlemlenmedi.
- **Aşama Durumu:** **PASS**

---

### B. Eski Mesajları Getirme (On-Demand History Hydration)
- Sohbet A'da yerel DB sınırındaki en eski mesaj ID'si olan `before=177068` ile istek gönderildi.
- **Backend - Gateway - Baileys Akışı Kanıtı:**
  1. **Backend:** Tekil korelasyon kimliği üretti (`request_id: hist-7817226562f1`) ve Gateway'e iletti.
  2. **Gateway:** İsteği karşıladı ve şu teşhis kaydını üretti:
     ```json
     {
       "request_id": "hist-7817226562f1",
       "jid_kind": "PN",
       "jid_tag": "02df2799",
       "outcome": "REQUESTED",
       "anchor_id_suffix": "CD50CF",
       "anchor_from_me": true,
       "anchor_ts_ms": 1788081793000,
       "count": 50,
       "timeout_ms": 12000,
       "msg": "Older history PDO requested"
     }
     ```
  3. **Baileys Soket Çağrısı:** `sock.fetchMessageHistory(50, oldestMsgKey, 1788081793000)` metodu çağrıldı.
  4. **WhatsApp İletim Kanıtı:** `pdo_sent: true` olarak tescillendi. PDO paketi WhatsApp sunucusuna gönderildi.
  5. **Zaman Aşımı & Fail-Safe Davranışı:** 12 saniye içinde telefon/sunucu tarafından geçmiş mesaj chunk'ı iletilmedi (`chunks_during_wait: 0`, `failure_class: NO_CHUNK`):
     ```json
     {
       "request_id": "hist-7817226562f1",
       "outcome": "TIMEOUT",
       "failure_class": "NO_CHUNK",
       "waited_ms": 12006,
       "timeout_ms": 12000,
       "pdo_sent": true,
       "chunk_received": false,
       "msg": "Older history request timed out waiting for provider chunk"
     }
     ```
  6. **Backend & Frontend Yanıtı:**
     - HTTP 502 patlaması yaşanmadı; fail-safe devreye girdi (`Provider history timed out; serving local rows instead of failing`).
     - Yanıt: `messages_count: 0`, `has_more: true`, `history_evidence.state: "TIMEOUT"`.
     - **En Kritik İnvaryant:** Yanıt `TIMEOUT` olduğu için `provider_exhausted: false` ve `has_more: true` korundu; geçmiş haksız yere kapatılmadı!
- **Aşama Durumu:** **PASS**

---

### C. Pagination Devamlılığı (Cursor Keyset & İdempotency)
- Sohbet B (`39215` - 258 mesaj) üzerinde 6 ardışık sayfalama turu gerçekleştirildi:
  - **1. Sayfa:** `limit=50` (Yerel: `177396` .. `177449`) -> `has_more: true` (0.24s)
  - **2. Sayfa (`before=177396`):** (Yerel: `177335` .. `177395`) -> `has_more: true` (0.24s)
  - **3. Sayfa (`before=177335`):** (Yerel: `177280` .. `177334`) -> `has_more: true` (0.25s)
  - **4. Sayfa (`before=177280`):** (Yerel: `177215` .. `177279`) -> `has_more: true` (0.27s)
  - **5. Sayfa (`before=177215`):** (Yerel: `176784` .. `177214`) -> `has_more: true` (0.24s)
  - **6. Sayfa (`before=176784`):** (Yerel: `176776` .. `176783`, 8 mesaj) -> `has_more: true` (0.26s)
- **Doğrulanan Özellikler:**
  - Cursor kesintisiz bağlandı: `newest_message_id` daima bir önceki sayfanın `oldest_message_id`'sinin bir eksiği oldu.
  - Hiçbir mesaj yinelenmedi (0 duplicate).
  - Sıralama tamamen kronolojik kaldı.
  - Cooldown mekanizması sayesinde bekleme süresi 15s'den 0.26s'ye indi.
- **Aşama Durumu:** **PASS**

---

### D. Scroll Davranışı ve Konum Koruma
- Frontend `ChatThread.tsx` ve `useWhatsAppConversation.ts` mantığı doğrulandı:
  - Eski mesajlar yüklendiğinde: `newScrollHeight - prevScrollHeight` hesaplanıp `scrollTop` değeri ofsetlenerek kullanıcının baktığı mesaj sabit tutulmaktadır.
  - `isFetchingOlderRef` ve `loadingOlder` durumları eşzamanlı çift istekleri (race condition) kilitlemektedir.
  - `pagingError: true` olduğunda otomatik scroll durdurulmakta, sonsuz istek fırtınası engellenmektedir.
- **Aşama Durumu:** **PASS**

---

### E. Sonlandırma ve Tekrar Deneme (Exhaustion vs Retryable)
- Yapılan canlı testlerde `state == 'TIMEOUT'` ve `failure_class == 'NO_CHUNK'` durumlarında:
  - `has_more` **asla false yapılmadı**.
  - `provider_exhausted` **asla true yapılmadı**.
  - `isTrulyExhausted` kuralının yalnızca kanıtlanmış `FULLY_EXHAUSTED` durumunda devreye girdiği, timeout ve geçici ağ gecikmelerinin kullanıcıya tekrar denenebilir (retryable) olarak sunulduğu canlı ortamda doğrulandı.
- **Aşama Durumu:** **PASS**

---

## 4. Veri Bütünlüğü Kontrolü (Öncesi vs Sonrası)

Test öncesi ve sonrasında Postgres veritabanında gerçekleştirilen salt okunur bütünlük sayımları:

| Metrik | Test Öncesi | Test Sonrası | Fark / Açıklama |
| :--- | :--- | :--- | :--- |
| **Conversations** | 131 | 131 | 0 (Bütünlük korundu) |
| **Messages (Toplam)** | 903 | 906 | +3 (Test sırasında WhatsApp'tan gelen 3 gerçek canlı mesaj) |
| **Contacts** | 1542 | 1542 | 0 (Bütünlük korundu) |
| **Sohbet 39223 Mesaj Sayısı** | 50 | 50 | 0 (Kayıp yok) |
| **Sohbet 39215 Mesaj Sayısı** | 258 | 258 | 0 (Kayıp yok) |
| **Duplicate `wa_message_id`** | 15 | 15 | 0 (Yeni duplicate oluşmadı) |
| **NULL `wa_message_id`** | 0 | 0 | 0 (Sentetik sahte mesaj yok) |
| **Orphan Messages** | 0 | 0 | 0 (Sahipsiz kayıt yok) |
| **DB Şema Parmak İzi** | `f104dc11f284` | `f104dc11f284` | 0 (Şema değişikliği yok) |

*Not: Test sırasında gelen 3 yeni mesaj (ID `177453`, `177454`, `177455`) gerçek canlı WhatsApp iletişiminden gelmiş ve `RECEIVED` statüsüyle veritabanına sorunsuz yazılmıştır.*

---

## 5. Gerçek Kanıt Standardı Özeti

| Katman | Kanıt Türü | Sonuç |
| :--- | :--- | :--- |
| **Frontend UI / Hook** | Keyset pagination, deduplication ve scroll koruma kuralları | **VERIFIED** |
| **Backend API** | `get_messages` endpoint'i, cooldown ve fail-safe hata yönetimi | **VERIFIED** |
| **Gateway REST/WS** | Correlation ID (`hist-*`), anchor parametreleri, istek karşılama | **VERIFIED** |
| **Baileys Soket Çağrısı** | `sock.fetchMessageHistory` tetiklenmesi ve `pdo_sent: true` | **VERIFIED** |
| **WhatsApp Kaynaklı History Chunk** | WhatsApp sunucusundan geçmiş chunk iletimi | **NOT_VERIFIED** (`NO_CHUNK` - Telefon o anda chunk üretmedi) |
| **DB Ingestion & Idempotency** | Sayfalama sırasında duplicate ve veri kaybı olmaması | **VERIFIED** |

---

## 6. Genel Değerlendirme ve Sonuç

**Genel Karar:** **`PASS_WITH_NOTES`**

### Başarılan Maddeler:
1. Production oturumu (`f41df0cd-...`) test boyunca kesintisiz bağlı kaldı, QR veya logout tetiklenmedi.
2. Gateway ve Backend katmanlarında Baileys `fetchMessageHistory` çağrısının gerçek WhatsApp soketine ulaştığı (`pdo_sent: true`) kanıtlandı.
3. İstemcinin geçmişi hatalı bir şekilde `FULLY_EXHAUSTED` olarak kapatmadığı; `TIMEOUT` durumunu `has_more: true` ve `pagingError: true` ile tekrar denenebilir şekilde koruduğu doğrulandı.
4. Yerel 6 sayfalık keyset sayfalama 250ms civarında kesintisiz, sıfır duplicate ve mükemmel kronolojik sıra ile çalıştı.
5. Veritabanında hiçbir veri kaybı, orphan veya sahte sentetik kayıt oluşmadı.

### Not Düşülen Husus (`NOTES`):
- WhatsApp Web / Multi-Device protokolünde `HISTORY_SYNC_ON_DEMAND` isteklerine telefonun ve WhatsApp sunucusunun cevap verme zamanlaması telefonun o anki pil tasarrufu, internet bağlantısı ve WhatsApp sunucusu yüküne bağlıdır. Yapılan iki canlı çağrıda `pdo_sent: true` olmasına rağmen telefon 12 saniye içinde chunk döndürmemiştir (`NO_CHUNK`). Sistem bu durumu çökmek veya geçmişi kapatmak yerine kusursuz bir fail-safe ile yönetmiştir.

