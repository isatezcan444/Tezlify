# TEZLIFY WHATSAPP — PHONE-AWAKE CONTROLLED LIVE HISTORY ACCEPTANCE RAPORU

**Tarih / Saat:** 2026-11-07 22:00 (UTC+3) / 19:00 (UTC)  
**Production Commit:** `0b6b4cfa948c4f1cfde0d3c60bd978dc05bbab50`  
**Test Türü:** Canlı Üretim Ortamı (Oracle Cloud) — Telefon Açık / Ön Planda Tek Kontrollü Kabul Testi  
**Nihai Karar:** **`NO_CHUNK`**

---

## 1. Yönetici Özeti (Executive Summary)

Kullanıcının ana fiziksel telefonu internete bağlı, ekran kilidi açık, WhatsApp uygulaması ön planda ve arka plan veri kısıtlamaları devre dışı iken, Tezlify WhatsApp history retrieval altyapısı üzerinde **yalnızca tek bir kontrollü canlı geçmiş mesaj alma testi** gerçekleştirilmiştir.

### Test Sonucu ve Kanıtlanan / Doğrulanamayan Davranışlar:

1. **İstek Gönderim Yolu Doğrulandı:**
   - Backend `request_id: hist-1f23c251e751` korelasyon kimliği ile Gateway'e istek iletmiştir.
   - Gateway hedef JID ve yerel anchor parametrelerini çözümlemiştir.
   - Baileys kütüphanesinin PDO fonksiyon çağrısı başarıyla tamamlanmıştır (`pdo_sent: true`).
2. **Gerçek Eski Mesaj Chunk'ı Alınmadı (`NO_CHUNK`):**
   - 12.000 ms'lik bekleme süresi boyunca WhatsApp sunucusundan veya birincil telefondan hiçbir geçmiş mesaj bloğu (`HISTORY_SYNC_NOTIFICATION` / `messaging-history.set`) Gateway'e ulaşmamıştır (`chunks_during_wait: 0`, `chunk_received: false`).
   - Zaman aşımı sonrasındaki 3 dakika boyunca da gecikmeli bir chunk düşmemiştir.
3. **Tam History Event Pipeline Doğrulanmadı:**
   - Canlı testte gerçek bir history chunk alınamadığı için, gelen geçmiş mesajların Gateway → Backend → DB → WebSocket → Frontend zinciri üzerinden taşınması, veritabanına yazılması ve arayüzde gösterilmesi bu test kapsamında **doğrulanamamıştır**.
4. **Timeout ve Graceful Fallback Doğrulandı:**
   - Gateway zaman aşımına uğradığında HTTP 502 Bad Gateway hatası oluşmamış; Backend süreci yakalayarak arayüze kontrollü yanıt dönmüştür.
   - `has_more: true` ve `provider_exhausted: false` bayrakları korunarak geçmiş haksız yere "tükendi" olarak kapatılmamıştır.
5. **Veri Bütünlüğü Korundu:**
   - PostgreSQL veritabanında test öncesi ve sonrası ölçümlerde veri kaybı veya yapısal bozulma yaşanmamıştır. Sistemde mevcut olan 15 mükerrer kayıt sayısı değişmemiş, test sırasında yeni bir mükerrer kayıt oluşmamıştır.
6. **WhatsApp Tarafındaki Kök Neden:**
   - Telefon açık ve ön planda olmasına rağmen WhatsApp'tan neden chunk gelmediğinin kesin kök nedeni bu testle **belirlenememiştir (bilinmiyor)**.

---

## 2. Test Öncesi Sağlık ve Bütünlük Kontrolleri (Pre-Flight)

Tüm ön kontroller üretim ortamında salt okunur olarak doğrulanmıştır:

| Kontrol | Beklenen | Ölçülen (Canlı) | Durum |
| :--- | :--- | :--- | :--- |
| **`.deployed-commit`** | `0b6b4cfa948c4f1cfde0d3c60bd978dc05bbab50` | `0b6b4cfa948c4f1cfde0d3c60bd978dc05bbab50` | **PASS** |
| **`tezlify-backend`** | healthy | Up 3 hours (healthy) | **PASS** |
| **`tezlify-gateway`** | healthy | Up 3 hours (healthy) | **PASS** |
| **`tezlify-db`** | healthy | Up 5 weeks (healthy) | **PASS** |
| **`tezlify-caddy`** | healthy | Up 3 weeks (healthy) | **PASS** |
| **Gateway Sessions** | connected: 1, pending_qr: 0 | `total: 1, connected: 1, pending_qr: 0` | **PASS** |
| **Gateway Auto Restore** | true | `auto_restore: true` | **PASS** |
| **WebSocket Köprüsü** | connected: true | `gateway_bridge.connected: true` | **PASS** |
| **`last_pong_at` Akışı** | İlerleyen zaman damgası | `2026-11-07T18:56:40+00:00` (Canlı) | **PASS** |
| **In-Flight Waiters** | 0 | `in_flight: 0` (Önceki istek ve soğuma süreleri tamamlanmış) | **PASS** |

---

## 3. Test Edilen Sohbet, Anchor ve Metrik Farklarının Kronolojik Açıklaması

Önceki denetimler, hazırlık aşaması ve canlı test esnasında kaydedilen farklı sayısal metrikler ve anchor değerleri kronolojik olarak aşağıda açıklanmıştır:

### A. Toplam Mesaj Sayısı Farkı (903 / 946 vs 956):
- Önceki gün ve saatlerde gerçekleştirilen farklı faz denetimlerinde sistemdeki toplam mesaj sayısı sırasıyla 903 ve 946 olarak kaydedilmiştir.
- Canlı ortam sürekli aktif olduğundan ve arka planda yeni gelen/giden WhatsApp mesajları kaydedilmeye devam ettiğinden, Aşama 3 canlı testi öncesindeki pre-flight kontrolünde toplam mesaj sayısı **956** olarak ölçülmüştür. Test sonrasında da bu sayı tam olarak **956** kalmıştır.

### B. Hedef Sohbet (39215) Mesaj Sayısı Farkı (274 vs 280):
- Test planlama ve kullanıcı hazırlık notlarında aday sohbete ait mesaj sayısı **274** olarak belirtilmiştir.
- Canlı test öncesinde doğrudan PostgreSQL tablosundan yapılan doğrulamada (`SELECT count(*) FROM messages WHERE conversation_id = 39215`), sohbete test hazırlık sürecine kadar yeni mesajlar eklenmiş olduğu ve yerel mesaj sayısının **280**'e ulaştığı görülmüştür. Canlı test bu 280 mesajlık güncel durum üzerinden icra edilmiştir.

### C. Anchor Belirlenmesi (`05043BF2...` vs `3AB12018...A4BAF2`):
- Hazırlık aşamasında sohbetin en eski mesajına referans olarak `05043BF2...` anahtarı not edilmiştir.
- Canlı test öncesinde yapılan kesin veritabanı sorgusunda (`min(COALESCE(external_timestamp, sent_at, created_at))`), yerel DB'deki en eski kaydın ID `176776` (`2026-11-06 18:53:14 UTC`) olduğu ve bu kaydın gerçek WhatsApp mesaj anahtarının **`3AB1201896351DA4BAF2`** (kısa suffix: `A4BAF2`, `from_me: false`) olduğu kesinleştirilmiştir.
- Canlı istek, varsayım yerine bu doğrulanmış gerçek yerel taban mesaj ID'si olan `before=176776` ile gönderilmiştir.

### D. Canlı İstekte Kullanılan Sohbet Parametreleri:
- **Conversation ID:** `39215`
- **Maskelenmiş Telefon / JID:** `+90544...*7554` / `905442...*@s.whatsapp.net` (JID Tag: `46f78076`, JID Kind: `PN`)
- **Mevcut Yerel Mesaj Sayısı:** 280
- **En Eski Yerel Mesaj ID (Anchor):** `176776`
- **En Eski Yerel Mesaj Zaman Damgası:** `2026-11-06 18:53:14 UTC` (`1793991194000` ms)
- **Anchor WhatsApp ID:** `3AB1201896351DA4BAF2` (Suffix: `A4BAF2`, `from_me: false`)

---

## 4. Canlı İstek İcrası ve Gözlemlenen Olay Akışı

Tek kontrollü canlı istek `get_messages(db, session_id, 39215, limit=50, before=176776)` olarak tetiklenmiş ve Gateway/Baileys logları kayıt altına alınmıştır.

### Zaman Çizelgesi ve Korelasyon:

| Zaman (UTC) | Katman | Olay | Detay / Payload Özeti |
| :--- | :--- | :--- | :--- |
| **18:57:07.580** | Backend | İstek Başlangıcı | `get_messages(conv=39215, before=176776, limit=50)` çağrıldı. |
| **18:57:07.589** | Gateway | `Older history PDO requested` | `request_id: hist-1f23c251e751`, `jid_tag: 46f78076`, `anchor_id_suffix: A4BAF2`, `anchor_ts_ms: 1793991194000`, `count: 50`, `timeout_ms: 12000` |
| **18:57:07.592** | Baileys | `fetchMessageHistory()` Çağrısı | Baileys PDO gönderim fonksiyon çağrısı hata vermeden tamamlandı (`pdo_sent: true`). |
| **18:57:07 - 18:57:19** | Gateway | Dinleme & Bekleme | 12 saniye boyunca event bus üzerinde `messaging-history.set` veya `HISTORY_SYNC_NOTIFICATION` bekleniyor. |
| **18:57:19.589** | Gateway | `Older history request timed out` | `waited_ms: 12000`, `failure_class: NO_CHUNK`, `pdo_sent: true`, `chunk_received: false`, `chunks_during_wait: 0` |
| **18:57:19.595** | Backend | Fallback Log Kaydı | `Provider history timed out (conv=39215); serving local rows instead of failing` |
| **18:57:19.950** | Backend | API Yanıtı | Toplam süre: `12.37s`, `messages_count: 0`, `has_more: true`, `history_evidence.state: TIMEOUT` |

### `pdo_sent: true` Alanının Kesin Anlamı:
Loglarda yer alan `pdo_sent: true` ifadesi, **Baileys kütüphanesinin ilgili PDO mesajını sokete yazma fonksiyonunu istisna fırlatmadan icra ettiğini** gösterir. Bu değer, WhatsApp sunucularının paketi teslim aldığını veya birincil telefonun bu mesajı teslim alıp işlediğini kanıtlamaz; yalnızca yerel Gateway/Baileys katmanından çıkış çağrısının başarılı olduğunu ifade eder.

### Gateway Canlı Log Kayıtları:
```json
{"level":30,"time":1794077827589,"pid":1,"hostname":"f9669b7598dc","request_id":"hist-1f23c251e751","jid_kind":"PN","jid_tag":"46f78076","outcome":"REQUESTED","anchor_id_suffix":"A4BAF2","anchor_from_me":false,"anchor_ts_ms":1793991194000,"count":50,"timeout_ms":12000,"chat_jid_kind":"PN","msg":"Older history PDO requested"}
{"level":30,"time":1794077839589,"pid":1,"hostname":"f9669b7598dc","request_id":"hist-1f23c251e751","jid_kind":"PN","jid_tag":"46f78076","outcome":"TIMEOUT","failure_class":"NO_CHUNK","waited_ms":12000,"timeout_ms":12000,"pdo_sent":true,"chunk_received":false,"chunks_during_wait":0,"anchor_id_suffix":"A4BAF2","chat_jid_kind":"PN","msg":"Older history request timed out waiting for provider chunk"}
```

### Zaman Aşımı Sonrası Durum:
İstek tamamlandıktan sonra geçen 3 dakika boyunca Gateway loglarında `messaging-history.set` veya `hist-1f23c251e751` ile ilişkili hiçbir geç gelen mesaj paketi düşmemiştir.

---

## 5. API Yanıtındaki `messages_count: 0` ve Fallback Davranışı (Rapor Sınırlaması)

Backend logunda:
`Provider history timed out (conv=39215); serving local rows instead of failing`
yazmasına karşın API yanıtında `messages_count: 0` dönmüştür.

### Analiz ve Açık Rapor Sınırlaması:
- İstek `before=176776` parametresiyle yapılmıştır.
- ID `176776`, yerel veritabanında bu sohbetin zaten en eski kayıtlı mesajıdır (`min(id)`). Dolayısıyla yerel DB'de bu ID'den daha küçük ID'ye sahip bir mesaj bulunmamaktadır (`WHERE conversation_id = 39215 AND id < 176776` sorgusunun doğal sonucu 0 satırdır).
- **Rapor Sınırlaması:** Mevcut çalışma logları ve harici API çıktısı üzerinden, fallback mekanizmasının yerel veritabanında daha eski kayıt olmadığı için mi 0 mesaj döndüğü, yoksa timeout yakalandığında doğrudan boş bir mesaj listesi mi ürettiği kodun içine bakılmaksızın salt bu dış test çıktısıyla kesinleştirilemez. Bu nedenle kesin bir çıkarım yapılmamış, gözlemlenen durum bir sınırlama olarak not edilmiştir.

---

## 6. Veri Bütünlüğü Doğrulaması (Pre-Test vs Post-Test)

PostgreSQL veritabanında test öncesi (18:56 UTC) ve test sonrasında (18:59 UTC) çalıştırılan kontroller sistemin veri bütünlüğünü koruduğunu göstermektedir:

| Bütünlük Metriği | Test Öncesi (18:56 UTC) | Test Sonrası (18:59 UTC) | Fark / Durum |
| :--- | :--- | :--- | :--- |
| **Toplam Sohbet (`conversations`)** | 131 | 131 | 0 (Değişmedi) |
| **Toplam Mesaj (`messages`)** | 956 | 956 | 0 (Değişmedi) |
| **Toplam Kişi (`contacts`)** | 1542 | 1542 | 0 (Değişmedi) |
| **Sohbet 39215 Mesaj Sayısı** | 280 | 280 | 0 (Değişmedi) |
| **Sohbet 39215 En Eski Mesaj** | `2026-11-06 18:53:14` | `2026-11-06 18:53:14` | 0 (Değişmedi) |
| **Mükerrer `wa_message_id` Sayısı** | 15 (Eski bilinen) | 15 (Eski bilinen) | **Yeni mükerrer oluşmadı** |
| **`NULL` Mesaj ID Sayısı** | 0 | 0 | 0 (Bütünlük korundu) |
| **Yetim Mesaj Sayısı (`orphan`)** | 0 | 0 | 0 (Bütünlük korundu) |

> **Mükerrer Kayıt Notu:** Veritabanında tarihsel olarak var olan 15 adet mükerrer `wa_message_id` kaydı bulunmaktadır. Canlı test sırasında bu sayı 15'te sabit kalmış; sisteme yeni bir mükerrer kayıt eklenmemiştir.

---

## 7. WhatsApp / Dış Katman Kök Neden Değerlendirmesi

Kullanıcının birincil telefonu açık, ekran kilidi kaldırılmış ve WhatsApp uygulaması ön planda tutulmuştur. Buna rağmen 12 saniye boyunca WhatsApp'tan geçmiş mesaj chunk'ı gelmemiştir (`NO_CHUNK`).

- **WhatsApp Tarafındaki Kök Neden:**
  İsteğin WhatsApp sunucuları, telefon işletim sistemi (Android/iOS) veya WhatsApp'ın tescilli Multi-Device eşitleme mekanizması tarafından işlenip işlenmediği, sessizce düşürülüp düşürülmediği veya protokol kısıtlamalarına mı takıldığı **bu test ile belirlenememiştir (bilinmiyor)**.
- Dış sistemin iç işleyişine dair sunucu tarafı logları veya telefon tarafı hata kayıtları bulunmadığından, WhatsApp tarafındaki kök neden hakkında kesin bir yargıda bulunulamaz.

---

## 8. Nihai Sonuç ve Karar

| Kategori | Durum / Karar | Kanıt & Gözlem |
| :--- | :--- | :--- |
| **Canlı History Kabulü** | **`NO_CHUNK`** | 12.000 ms boyunca Gateway'e 0 adet history chunk ulaştı. |
| **İstek Gönderim Yolu** | **DOĞRULANDI** | Backend → Gateway parametre iletimi ve Baileys çağrısı başarılı. |
| **Baileys PDO Çağrısı** | **BAŞARILI** | `pdo_sent: true` (Baileys fonksiyon çağrısı başarıyla icra edildi). |
| **Gerçek Eski Mesaj Chunk'ı** | **ALINMADI** | `chunk_received: false`, `chunks_during_wait: 0`. |
| **Tam History Event Pipeline** | **DOĞRULANMADI** | Chunk gelmediği için Gateway → Backend → DB → WS → UI taşıma zinciri doğrulanamadı. |
| **Timeout / Graceful Fallback** | **DOĞRULANDI** | HTTP 502 oluşmadı, `has_more: true` ve `provider_exhausted: false` korundu. |
| **Veri Bütünlüğü** | **KORUNDU** | Pre/Post DB metrikleri sabit; 15 mükerrer değişmedi, yeni mükerrer oluşmadı. |
| **WhatsApp Kök Nedeni** | **BİLİNMİYOR** | Dış platform/telefon tarafındaki kesin sebep dış gözlemle belirlenemedi. |
| **GENEL KABUL KARARI** | **`NO_CHUNK`** | Raporlanan kanıtlarla tek kontrollü canlı test tamamlandı. |
