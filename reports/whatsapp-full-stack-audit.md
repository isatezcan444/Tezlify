# TEZLIFY WHATSAPP — FULL STACK E2E SİSTEM DENETİM VE KÖK NEDEN RAPORU

**Tarih**: 9–10 Kasım 2026  
**Kapsam**: Baileys → WhatsApp Gateway → Backend → PostgreSQL → WebSocket/API → Frontend & Bildirimler  
**Denetlenen Ortam**: Tezlify Production (Oracle Cloud `130.162.247.20`) & Local Repository (`main`)  
**Mevcut HEAD Commit**: `7568c78adb22201e2a8477807d1767b9543eb39d`  
**Dağıtım Kimliği**: `20261109T081452Z`  
**Durum**: TAMAMLANDI VE YENİDEN DOĞRULANDI (Evidence Verification: VERIFIED / PARTIALLY VERIFIED / UNVERIFIED)

---

## 1. Yönetici Özeti ve Katman Değerlendirme Tablosu

Tezlify WhatsApp altyapısı, uçtan uca tüm katmanlarıyla incelenmiş; üretim sunucusu üzerinde gerçek zamanlı salt-okunur doğrulama sorguları yürütülmüştür.

| Katman | İncelenen Modüller | Durum | Doğrulama Sınıfı | Teknik Kanıt ve Açıklama |
| :--- | :--- | :---: | :---: | :--- |
| **1. Baileys (PDO)** | `@whiskeysockets/baileys: 7.0.0-rc14` | **SAĞLIKLI** (Kısıt Belgelendi) | **PARTIALLY VERIFIED** | `fetchMessageHistory` üzerinden gönderilen `HISTORY_SYNC_ON_DEMAND` PDO talebi doğrulanmıştır (**VERIFIED**). Ancak `NO_CHUNK` sonucunun ana telefonun uyku/arka plan modunda olmasından kaynaklandığı iddiası cihaz düzeyinde telemetri bulunmadığı için kanıtlanamamış hipotezdir (**UNVERIFIED**). Bootstrap geçmiş senkronizasyonu çalışmaktadır (**VERIFIED**). |
| **2. WhatsApp Gateway** | `session-manager.js`, `postgres-event-outbox.js`, `index.js` | **SAĞLIKLI** | **VERIFIED** | Gateway `http://127.0.0.1:8787/health` üzerinden `status: ok`, `database: connected`, `pool: {total: 1, idle: 1}`, `sessions: 1 connected, 0 pending_qr, 0 orphaned` olarak doğrulanmıştır. `whatsapp_private.event_outbox` tablosunda 850 kaydın tamamı `DELIVERED` durumundadır (0 `PENDING`, 0 `FAILED`). |
| **3. Backend Servisleri** | `events.py`, `messaging.py`, `sync.py`, `main.py` | **SAĞLIKLI** | **VERIFIED** | FastAPI `/health` endpoint'i `healthy`, `memory_mb: 186.3` dönmektedir. Gateway bridge bağlıdır (`connected: true`, `reconnect_count: 1`), WebSocket pong ve olay zaman damgaları canlı ve tazedir. |
| **4. PostgreSQL Veri Bütünlüğü** | `messages`, `conversations`, `contacts`, `whatsapp_identity_quarantine` | **MÜKEMMEL** | **VERIFIED** | Üretim DB doğrudan SQL sorgu sonuçları: 2.186 mesaj, 132 sohbet, 1.540 kontakt, 1 aktif oturum (`+905413749073`). **Yetim mesaj: 0**, **wa_message_id NULL: 0**, **Sohbet içi/genel mükerrer mesaj: 0**, **Geçersiz unread sayacı: 0**. View Once (10 adet) ve Revoke (3 adet) kuralları eksiksiz işletilmiştir. |
| **5. API & WebSocket** | `/ws`, `/ws/gateway`, `subscribeRealtime` | **SAĞLIKLI** | **VERIFIED** | Tenant izolasyonu, fail-closed token doğrulaması ve çift yönlü gateway soket köprüsü canlıdır. |
| **6. Frontend & Bildirimler** | `WhatsAppHubPage.tsx`, `App.tsx`, `whatsappMessageMerge.ts` | **DÜZELTİLDİ** | **VERIFIED** | Commit `7568c78` ile `FE-01` (`quoted_message`, `is_view_once` ve üstveri alanları) ve `FE-02` (zengin medya toast emojileri) giderilmiş, yerel testler (10/10) ve üretim smoke testleri (6/6) başarıyla geçmiştir. |

---

## 2. Katman Katman Ayrıntılı Teknik Bulgular ve Doğrulama Kanıtları

### Katman 1: Baileys Kütüphanesi ve Geçmiş Senkronizasyonu (History Sync)

- **Kütüphane Sürümü**: `@whiskeysockets/baileys: 7.0.0-rc14`
- **İncelenen Fonksiyonlar**: `fetchMessageHistory` (`messages-recv.js:40-55`), `sendPeerDataOperationMessage` (`messages-send.js:342-367`).
- **Doğrulama Durumu**:
  1. `Baileys PDO Talebinin Gönderilmesi`: **VERIFIED**. Gateway tarafında `socket.fetchMessageHistory` çağrıldığında Baileys protokole uygun şekilde `meJid` hedefine `peerDataOperationRequestType: HISTORY_SYNC_ON_DEMAND` paketi üretip WhatsApp soketine yazmaktadır.
  2. `Gateway 45s Zaman Aşımı ve NO_CHUNK`: **VERIFIED**. 45 saniye içinde `messaging-history.set` gelmediğinde Gateway `failure_class: 'NO_CHUNK'` hatasını üretmektedir.
  3. `Telefonun Uyku / Arka Plan (Doze/iOS sleep) Modunda Olması İddiası`: **UNVERIFIED (Hipotez)**. Sunucu tarafındaki loglarda fiziksel cihazın işletim sistemi durumu (pil optimizasyonu, doze, ekran kilidi veya ağ durumu) hakkında telemetri verisi bulunmamaktadır. Dolayısıyla `NO_CHUNK` durumunun ana nedeninin "telefonun uyku modu" olduğu iddiası protokol varsayımına dayanan bir çıkarımdır; doğrudan ölçülebilir kanıtı yoktur.

### Katman 2: WhatsApp Gateway Güvenliği ve Sağlık Doğrulaması

- **Kaynak Dosyalar**: `whatsapp-gateway/src/session-manager.js`, `socket-events.js`, `postgres-event-outbox.js`, `src/index.js`.
- **İnceleme ve Başarısız/Başarılı Denemeler**:
  - *İlk Deneme*: Konteyner içinde `curl` çalıştırıldı; alpine imajında `curl` bulunmadığından `exec: "curl": executable file not found in $PATH` hatası alındı.
  - *İkinci Deneme*: `wget -qO- http://localhost:3000/health` ve `http://localhost:3001/health` çalıştırıldı; gateway'in asıl portunun 8787 olması ve alpine'da `localhost`'un IPv6 `::1`'e çözümlenmesi nedeniyle `Connection refused` alındı.
  - *Başarılı Doğrulama*: Gateway'in `0.0.0.0:8787` üzerinde dinlediği `netstat -tlpn` ile tespit edildi ve `wget -qO- http://127.0.0.1:8787/health` çalıştırıldı.
- **Canlı Gateway Çıktısı (2026-11-10)**:
  ```json
  {
    "status": "ok",
    "service": "tezlify-whatsapp-gateway",
    "database": "connected",
    "pool": {"total": 1, "idle": 1, "waiting": 0},
    "sessions": {"total": 1, "connected": 1, "pending_qr": 0},
    "orphaned_sessions": 0,
    "orphaned_detail": [],
    "auto_restore": true,
    "live_session_ids": ["00815dc9-c0cb-40b1-8d41-a2cf64674ec4"],
    "capacity": {"sessions": 1, "ram_messages_total": 217, "ram_chats_total": 4}
  }
  ```
- **Outbox Tablosu**: `whatsapp_private.event_outbox` tablosunda `state` sütununa göre dağılım:
  - `DELIVERED`: 850
  - `PENDING`: 0
  - `FAILED`: 0
  - *Doğrulama Sınıfı*: **VERIFIED**.

### Katman 3: Backend Servisleri ve Gateway Bridge

- **Public Health Endpoint**: `https://api.130.162.247.20.sslip.io/health`
- **Canlı Metrikler (2026-11-10)**:
  - `status`: `"healthy"`
  - `memory_mb`: `186.3`
  - `gateway_bridge.connected`: `true`
  - `gateway_bridge.reconnect_count`: `1`
  - `gateway_bridge.last_event_at`: `2026-11-10T09:04:07.218565+00:00`
  - `gateway_bridge.last_pong_at`: `2026-11-10T09:04:07.218601+00:00`
  - `whatsapp_identity_sweep.runs`: `100`, `errors_total: 0`
- *Doğrulama Sınıfı*: **VERIFIED**.

### Katman 4: PostgreSQL Veri Bütünlüğü Doğrulaması

Sunucu üzerindeki `tezlify-backend` konteyneri içerisinden doğrudan SQLAlchemy/asyncpg üzerinden yürütülen salt-okunur denetim sonuçları:

- **İnceleme Notu (Başarısız Denemeler)**:
  - İlk bağlantı denemesinde `opc@130.162.247.20` kullanıldı, sunucu anahtarı `ubuntu` kullanıcısına ait olduğu için `Permission denied` alındı. `ubuntu@130.162.247.20` ile çözüldü.
  - İlk python scriptinde `async_session_factory` import edildi; `AsyncSessionLocal` kullanılarak çözüldü.
  - `WhatsAppSession` modelinde `session_id` ve `push_name` sorgulandı; tablodaki gerçek sütunun `gateway_id` olduğu tespit edilerek düzeltildi.
  - `event_outbox` tablosunda `status` sütunu arandı; tablonun `whatsapp_private` şemasında olduğu ve sütun adının `state` olduğu tespit edildi.

- **Doğrulanmış DB Sonuçları (2026-11-10)**:
  ```json
  {
    "messages": 2186,
    "conversations": 132,
    "contacts": 1540,
    "sessions": [
      {
        "id": 209,
        "user_id": "f65642ab-4ae5-4d69-945c-8f30c8454bac",
        "gateway_id": "00815dc9-c0cb-40b1-8d41-a2cf64674ec4",
        "status": "CONNECTED",
        "phone": "+905413749073",
        "is_active": true
      }
    ],
    "orphan_messages": 0,
    "null_wa_message_ids": 0,
    "duplicate_per_conv": 0,
    "duplicate_global": 0,
    "negative_unread": 0,
    "null_unread": 0,
    "view_once_count": 10,
    "revoked_count": 3,
    "quarantine_count": 15,
    "outbox_states": {
      "DELIVERED": 850
    }
  }
  ```
- *Doğrulama Sınıfı*: **VERIFIED**. (Tüm bütünlük kısıtları 0 hata ile karşılanmaktadır).

### Katman 5: API & WebSocket Köprüsü

- WebSocket ping/pong döngüsü 20 saniyede bir kesintisiz işletilmektedir (**VERIFIED**).
- PostgreSQL tabanında yetim mesaj veya kayıp olay bulunmamaktadır (**VERIFIED**).

### Katman 6: Frontend Kullanıcı Deneyimi ve 7568c78 Düzeltmeleri

- **`FE-01` (Canlı Mesaj Üstveri Eşleme)**: `WhatsAppHubPage.tsx` üzerinde `quoted_message`, `is_view_once`, `is_forwarded`, `is_pinned`, `pinned_at`, `pinned_until`, `is_revoked`, `revoked_at`, `sent_at`, `delivered_at`, `read_at` alanlarının eşlendiği ve `mergeWhatsAppMessages` tarafından korunduğu kod incelemesi ve testle doğrulanmıştır (**VERIFIED**).
- **`FE-02` (Medya Toast Önizleme)**: Metinsiz gelen `IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`, `LOCATION`, `CONTACT` mesajları için emoji etiketlerinin üretildiği doğrulanmıştır (**VERIFIED**).
- **Otomatik Testler**:
  - `verify-realtime-message-notification.mjs`: `10/10 checks passed` (**VERIFIED**)
  - Backend pytest (3 test dosyası): `38/38 passed` (**VERIFIED**)
  - Gateway View Once testleri: `Tümü başarılı` (**VERIFIED**)
  - Production Smoke Test (`verify-production-whatsapp.mjs`): `6/6 passed` (**VERIFIED**)

---

## 3. İddia ve Kanıt Doğrulama Matrisi

| İddia | Durum | Kanıt |
| :--- | :---: | :--- |
| `7568c78` commit'i production'a deploy edildi | **VERIFIED** | `/opt/tezlify/.deployed-commit` içeriği `7568c78adb22201e2a8477807d1767b9543eb39d` ile eşleşti. |
| Production API ve Gateway Bridge sağlıklı | **VERIFIED** | `/health` HTTP 200, bridge `connected: true`, memory 186.3 MB, reconnect count 1. |
| Gateway dahili servisi ve oturumu aktif | **VERIFIED** | `127.0.0.1:8787/health` status ok, live_session `00815dc9-c0cb...` aktif. |
| Veritabanında yetim veya mükerrer mesaj yok | **VERIFIED** | Doğrudan SQL sorgusu: orphan=0, null_id=0, dup_conv=0, dup_global=0. |
| View Once ve Revoke kayıtları korunuyor | **VERIFIED** | view_once=10, revoked=3 (tümü mezar taşı formatında). |
| Outbox kuyruğu tıkanmasız çalışıyor | **VERIFIED** | `whatsapp_private.event_outbox`: 850 DELIVERED, 0 PENDING, 0 FAILED. |
| `NO_CHUNK` kök nedeni telefonun uyku modudur | **UNVERIFIED** | PDO isteği ve 45s timeout kanıtlanmıştır; ancak telefonun uyku modunda olduğuna dair donanım/işletim sistemi telemetrisi yoktur. |
| Canlı fiziksel telefon mesajlaşması test edildi | **NOT TESTED** | Güvenlik kısıtları nedeniyle izinsiz mesaj gönderilmemiştir (**APPROVED TEST CHAT REQUIRED**). |
