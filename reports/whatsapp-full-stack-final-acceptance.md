# TEZLIFY WHATSAPP — FULL STACK E2E NİHAİ KABUL RAPORU

**Tarih**: 9–10 Kasım 2026  
**Nihai Karar**: **PASS_WITH_NOTES** (Otomatik Testler, Dağıtım ve DB Bütünlüğü: **PASS** / Fiziksel Canlı Mesaj Testi: **NOT TESTED — APPROVED TEST CHAT REQUIRED** / NO_CHUNK Uyku Modu İddiası: **UNVERIFIED**)  
**Hedef Commit**: `7568c78adb22201e2a8477807d1767b9543eb39d` (`fix(whatsapp): preserve quoted message and view once metadata on realtime inbound`)  
**Ebeveyn Commit**: `11e50ec0e8bb2ed892c3090c59f003e971e0b8e6`  
**Dağıtım Kimliği**: `20261109T081452Z`  
**Ortam**: Tezlify Production (Oracle Cloud `130.162.247.20`)  

---

## 1. Yönetici Özeti ve Karar

Tezlify WhatsApp altyapısı genelinde yürütülen uçtan uca denetim ve düzeltme çalışmasının production kabul doğrulaması tamamlanmıştır.

- **Git ve Deployment Bütünlüğü**: `7568c78` commit'i hem yerel `main` hem de `origin/main` dalında HEAD konumundadır. Sunucu üzerindeki `/opt/tezlify/.deployed-commit` dosyası ve `/opt/tezlify/backups/releases/20261109T081452Z/release.json` kaydı ile birebir eşleşmektedir (**VERIFIED**).
- **Frontend Varlık Doğrulaması**: Sunucuda yayındaki `dist/assets/index-Bux1zuN8.js` ve bağlı bundle hash'leri yerel derleme ile birebir eşleşmiştir (**VERIFIED**).
- **Veri Tabanı ve Oturum Bütünlüğü**: 2.186 mesaj, 132 sohbet, 1.540 kontakt ve 1 aktif WhatsApp oturumu (`+905413749073`) sıfır veri kaybı, sıfır yetim kayıt ve sıfır mükerrerlik ile doğrulanmıştır (**VERIFIED**).
- **Kısıtlar & Ayrım**: Fiziksel canlı cihazla son kullanıcı testi yürütülmemiştir (**NOT TESTED — APPROVED TEST CHAT REQUIRED**). Baileys geçmiş senkronizasyonunda görülen `NO_CHUNK` durumunun "telefonun uyku modu"ndan kaynaklandığı iddiası cihaz düzeyinde telemetri verisi bulunmadığı için hipotez olarak sınıflandırılmıştır (**UNVERIFIED**).

---

## 2. Git ve Dağıtım Zinciri Doğrulaması

| Parametre | Beklenen Değer | Gerçek Değer (Kanıt) | Durum |
| :--- | :--- | :--- | :---: |
| **Yerel HEAD** | `7568c78adb22...` | `7568c78adb22201e2a8477807d1767b9543eb39d` | **VERIFIED** |
| **origin/main HEAD** | `7568c78adb22...` | `7568c78adb22201e2a8477807d1767b9543eb39d` | **VERIFIED** |
| **Commit Ebeveyni** | `11e50ec0e8bb...` | `11e50ec0e8bb2ed892c3090c59f003e971e0b8e6` | **VERIFIED** |
| **Commit Zinciri** | `b24665b` -> `11e50ec` -> `7568c78` | Doğrusal commit grafiği teyit edildi | **VERIFIED** |
| **Production `.deployed-commit`** | `7568c78adb22...` | `/opt/tezlify/.deployed-commit`: `7568c78adb22201e2a8477807d1767b9543eb39d` | **VERIFIED** |
| **Release ID** | `20261109T081452Z` | `/opt/tezlify/backups/releases/20261109T081452Z/release.json` mevcut | **VERIFIED** |
| **Yıkıcı Migration Kontrolü** | Temiz (0 satır) | Migration guard temiz geçti, şema değişmedi (`f104dc11f284`) | **VERIFIED** |

*Not (Cutover Sayacı)*: `release.json` dosyasında `counts_after_cutover: 130|1969|1540` olarak kaydedilen sohbet sayısı geçici geçiş filtresinden kaynaklanmış olup; canlı üretim veritabanında sohbet tabanının tam olarak **132** olduğu yeniden doğrulanmıştır.

---

## 3. Servis ve Sağlık Doğrulamaları (Deneme Geçmişi Dahil)

### 3.1 İnceleme Denemeleri ve Çözümleri
1. **SSH Bağlantısı**:
   - *Hata*: `opc@130.162.247.20` bağlantısı `Permission denied (publickey)` ile reddedildi.
   - *Çözüm*: Deployment betiğindeki resmi parametre olan `ubuntu@130.162.247.20` ve `$HOME/.ssh/id_tezlify_oracle` anahtarı kullanılarak bağlantı sağlandı.
2. **Gateway Sağlık Kontrolü**:
   - *Hata 1*: `tezlify-gateway` konteynerinde `curl` bulunamadı (`exec failed: "curl": executable file not found in $PATH`).
   - *Hata 2*: `wget http://localhost:3000` ve `3001` denendiğinde `Connection refused` alındı (gateway portunun 8787 olması ve alpine'da `localhost`'un IPv6'ya çözümlenmesi nedeniyle).
   - *Çözüm*: `wget -qO- http://127.0.0.1:8787/health` çalıştırılarak gateway servisinin ve bağlı veritabanı havuzunun tam sağlıklı olduğu kanıtlandı.
3. **PostgreSQL Sorguları**:
   - *Hata 1*: `from backend.app.core.database import async_session_factory` (`ImportError`). `AsyncSessionLocal` ile düzeltildi.
   - *Hata 2*: `whatsapp_sessions` tablosunda `session_id` ve `push_name` sorgulandı; gerçek sütunların `gateway_id` ve `phone_number` olduğu görüldü.
   - *Hata 3*: `event_outbox` tablosunda `status` sütunu arandı; tablonun `whatsapp_private` şemasında ve sütunun `state` olduğu tespit edildi.

### 3.2 Doğrulanmış Sağlık Göstergeleri
- **Backend API**: `https://api.130.162.247.20.sslip.io/health` -> HTTP 200 `healthy`, `memory_mb: 186.3` (**VERIFIED**).
- **PostgreSQL**: `docker exec tezlify-db pg_isready -U tezlify` -> `accepting connections` (**VERIFIED**).
- **Gateway**: `http://127.0.0.1:8787/health` -> `status: "ok"`, `database: "connected"`, `pool: {total: 1, idle: 1}`, `sessions: {total: 1, connected: 1, pending_qr: 0}`, `live_session_ids: ["00815dc9-c0cb-40b1-8d41-a2cf64674ec4"]` (**VERIFIED**).
- **Gateway Bridge**: `connected: true`, `reconnect_count: 1`, `last_event_at: 2026-11-10T09:04:07Z`, `last_pong_at: 2026-11-10T09:04:07Z` (**VERIFIED**).

---

## 4. PostgreSQL Bütünlük Metrikleri Tablosu

Doğrudan üretim veritabanında çalıştırılan salt-okunur doğrulama sorgusu sonuçları:

| Metrik | Önceki Rapor | Doğrulanan Canlı Değer | Durum |
| :--- | :---: | :---: | :---: |
| **Toplam Mesaj (`messages`)** | 1.969 | **2.186** (canlı akışla arttı) | **VERIFIED** |
| **Sohbet Sayısı (`conversations`)** | 132 | **132** | **VERIFIED** |
| **Kişi Sayısı (`contacts`)** | 1.540 | **1.540** | **VERIFIED** |
| **Aktif WhatsApp Oturumu** | 1 | **1** (`+905413749073`, CONNECTED) | **VERIFIED** |
| **Yetim Mesajlar (`orphan_messages`)** | 0 | **0** | **VERIFIED** |
| **NULL wa_message_id** | 0 | **0** | **VERIFIED** |
| **Sohbet İçi Mükerrer Mesaj** | 0 | **0** | **VERIFIED** |
| **Genel Mükerrer wa_message_id** | 0 | **0** | **VERIFIED** |
| **Negatif / Geçersiz Unread Sayacı** | 0 | **0** | **VERIFIED** |
| **View Once Kayıtları** | 8 | **10** (yeni gelenler korundu) | **VERIFIED** |
| **Revoke Mezar Taşları** | 3 | **3** | **VERIFIED** |
| **Identity Quarantine Kayıtları** | 8 | **15** (LID kayıtları izole) | **VERIFIED** |
| **Outbox DELIVERED** | 1.709* | **850** (`whatsapp_private.event_outbox`) | **VERIFIED** |
| **Outbox PENDING** | 0 | **0** | **VERIFIED** |
| **Outbox FAILED** | 0 | **0** | **VERIFIED** |

*\*Not*: Önceki raporda belirtilen 1.709 sayısı kümülatif/farklı bir kontrol noktasından alınmıştı; `whatsapp_private.event_outbox` tablosunun doğrudan SQL sayımında aktif satır sayısı 850 DELIVERED, 0 PENDING, 0 FAILED olarak kesinleştirilmiştir.

---

## 5. Düzeltmelerin ve Otomatik Testlerin Doğrulanması

- **`quoted_message`**: Canlı WebSocket olayından gelen alıntılanan mesaj snapshot'ının `newMsg` içine alındığı ve `mergeWhatsAppMessages` tarafından korunduğu doğrulandı (**VERIFIED**).
- **`is_view_once`**: Tek görüntülenmelik medya bayrağının canlı gelen mesaj balonunda ve state'te korunduğu doğrulandı (**VERIFIED**).
- **Metadata Alanları**: `sent_at`, `delivered_at`, `read_at`, `is_forwarded`, `is_pinned`, `is_revoked`, `reactions` alanlarının eksiksiz eşlendiği doğrulandı (**VERIFIED**).
- **Medya Önizleme Emojileri**: Metinsiz medya mesajlarında `📷 Fotoğraf`, `🎬 Video`, `🎵 Ses`, `📄 Belge`, `📍 Konum`, `👤 Kişi` etiketlerinin üretildiği doğrulandı (**VERIFIED**).
- **Test Sonuçları**:
  - `verify-realtime-message-notification.mjs`: `10/10 checks passed` (**VERIFIED**).
  - Pytest: `38/38 passed` in 1.72s (**VERIFIED**).
  - Gateway Inbound & View Once testleri: `Tümü başarılı` (**VERIFIED**).
  - Production Smoke Test (`verify-production-whatsapp.mjs`): `6/6 checks passed` (**VERIFIED**).

---

## 6. History NO_CHUNK ve Canlı Test Beyanı

> [!WARNING]
> **NO_CHUNK KÖK NEDEN DEĞERLENDİRMESİ**:  
> Baileys `fetchMessageHistory` üzerinden PDO paketinin gönderildiği ve 45 saniyelik zaman aşımı sonrasında `NO_CHUNK` alındığı doğrulanmıştır.  
> Ancak bu durumun "ana telefonun uyku / arka plan modunda olmasından" kaynaklandığı iddiası, sunucu loglarında telefon işletim sistemine ait doğrudan telemetri verisi bulunmadığı için **UNVERIFIED (Hipotez)** olarak düzeltilmiştir.

> [!IMPORTANT]
> **GERÇEK CİHAZ KABUL TESTİ BEYANI**:  
> Otomatik testler, derleme, konteyner sağlık kontrolleri, WebSocket canlılığı ve üretim veritabanı bütünlüğü eksiksiz olarak doğrulanmıştır (**PASS**).  
> Güvenlik kuralları gereği harici numaralara izinsiz/otonom mesaj gönderilmemiştir.  
> Canlı fiziksel telefon ile iki yönlü alıntı ve tek görüntülenmelik medya akışı kabul testi:  
> **`NOT TESTED — APPROVED TEST CHAT REQUIRED`**.
