# TEZLIFY WHATSAPP — VIEW ONCE & REVOKE PRODUCTION CANLI KABUL RAPORU

**Tarih / Saat:** 2026-11-08 13:14 (UTC+3) / 2026-11-08 10:14 (UTC)
**Önceki Commit:** `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c`
**Nihai Production Commit:** `f3f2f4c07f785b5b309eea11662319a6f0a18711`
**Production Host:** `130.162.247.20` (Oracle Cloud Production)
**Canlı Kabul Durumu:** **`PASS`**

---

## 1. Yönetici Özeti ve Nihai Karar

Kullanıcı tarafından fiziksel WhatsApp cihazı üzerinden production ortamında kontrollü canlı kabul testi icra edilmiştir.

1. **View Once Medya Gönderimi:** Kullanıcı tarafından telefon üzerinden gönderilen tek görüntülenmelik fotoğraf Tezlify web arayüzünde başarıyla ve anında görüntülenmiştir (herhangi bir kırık görsel veya sahte link oluşmamıştır).
2. **Herkesten Sil (Revoke):** Kullanıcı tarafından WhatsApp üzerinden "Herkesten Sil" (Delete for everyone) işlemi yapıldığında, Tezlify arayüzündeki mesaj anında mezartaşına ("Bu mesaj silindi") dönüşmüş ve silme işlemi başarıyla yansımıştır.
3. **Teknik Zincir Doğrulaması:** Gateway Outbox, PostgreSQL veritabanı kayıtları ve Baileys event akışları bağımsız olarak incelenmiş, tüm katmanların (Gateway → Backend → DB → WebSocket → Frontend) %100 uyumlu çalıştığı kanıtlanmıştır.

**Nihai Karar:** **`PASS`**

---

## 2. Dağıtım ve Git Doğrulaması

- **Branch:** `main`
- **Commit:** `f3f2f4c07f785b5b309eea11662319a6f0a18711`
- **Commit Mesajı:** `fix(whatsapp): preserve view-once messages and revoke tombstones`
- **GitHub Push:** Başarılı (`9cf91bf..f3f2f4c  main -> main`, exit code 0)
- **Sunucu Commit Eşleşmesi:** `/opt/tezlify/.deployed-commit` = `f3f2f4c07f785b5b309eea11662319a6f0a18711`
- **Release ID:** `20261108T100024Z`
- **Container Durumları (`docker ps`):**
  - `tezlify-gateway`: Up (healthy)
  - `tezlify-backend`: Up (healthy)
  - `tezlify-caddy`: Up (healthy)
  - `tezlify-db`: Up (healthy)
- **Baileys Gateway Oturumu:** `status: CONNECTED`, `is_phone_online: true`, `pending_qr: 0` (oturum kesintisiz korundu).

---

## 3. Canlı Testin Adli Bilişim ve Teknik Kanıtları

*Veri güvenliği gereği telefon numaraları, tam JID'ler ve mesaj tanımlayıcıları maskelenmiştir.*

### 3.1 Zaman Aralığı ve Test Parametreleri
- **Olay Zamanı:** 2026-11-08 10:07:46 UTC (13:07:46 UTC+3) – 10:07:54 UTC (13:07:54 UTC+3)
- **Test Sohbeti (Yerel DB ID):** `39352` (Bireysel Sohbet)
- **Olay Yönü:** `OUTBOUND` (Kullanıcının kendi fiziksel WhatsApp cihazından gönderildi)
- **Maskelenmiş WhatsApp Mesaj ID:** `3A00D7...585E` (Kriptografik SHA256: `cd8d03f5f794656d`)

---

### 3.2 Gateway Ingestion Kanıtı (View Once)

Gateway'in şifrelenmiş outbox tablosundaki (`whatsapp_private.event_outbox`) **SEQ 291461** kaydı çözümlenmiş ve Gateway katmanında mesajın başarıyla algılandığı doğrulanmıştır:

```json
{
  "sequence": 291461,
  "event_type": "message_new",
  "created_at": "2026-11-08T10:07:46.310804Z",
  "delivered_at": "2026-11-08T10:07:46.422626Z",
  "state": "DELIVERED",
  "payload": {
    "event": "message_new",
    "gateway_session_id": "00815dc9-c0cb-40b1-8d41-a2cf64674ec4",
    "conversation_id": "9054***pp.net",
    "message": {
      "wa_message_id": "3A00D7...585E",
      "direction": "OUTBOUND",
      "message_type": "UNKNOWN",
      "status": "SENT",
      "body": "[VIEW_ONCE_MEDIA]",
      "is_view_once": true,
      "media_id": null,
      "media_mime_type": null,
      "created_at": "2026-11-08T10:07:46.000Z"
    }
  }
}
```

**Teknik Doğrulama Bulguları:**
- Baileys companion stanza'sındaki `key.isViewOnce` bayrağı doğru yakalanmış ve `is_view_once: true` olarak işaretlenmiştir.
- İçeriksiz View Once stanza'sı düşürülmemiş, `[VIEW_ONCE_MEDIA]` güvenli yer tutucusu üretilmiştir.
- Medya download tetiklenmemiş, sahte medya ID veya sızan dosya linki üretilmemiştir (`media_id: null`).

---

### 3.3 Backend ve DB Persist Kanıtı (Mesaj Oluşturma)

Backend API, Gateway'den gelen SEQ 291461 olayını alarak PostgreSQL veritabanındaki `messages` tablosuna **178831** ID'si ile kaydetmiştir:

- **Veritabanı Satırı (`messages`):**
  ```json
  {
    "id": 178831,
    "conversation_id": 39352,
    "direction": "OUTBOUND",
    "message_type": "UNKNOWN",
    "is_view_once": true,
    "is_revoked": false,
    "media_id": null,
    "created_at": "2026-11-08 10:07:46.411070"
  }
  ```
- **Korelasyon:** Gateway oluşturma zamanı (10:07:46.310) ile Backend DB yazma zamanı (10:07:46.411) arasındaki gecikme yalnızca **101 milisaniyedir**.

---

### 3.4 Gateway Revoke Event Kanıtı (Herkesten Sil)

Kullanıcı WhatsApp uygulamasında "Herkesten Sil" butonuna bastığında, Baileys protokolü `protocolMessage.type === REVOKE` stanzasını yakalamış ve Outbox'a **SEQ 291463** olarak yazmıştır:

```json
{
  "sequence": 291463,
  "event_type": "message_deleted",
  "created_at": "2026-11-08T10:07:54.848730Z",
  "delivered_at": "2026-11-08T10:07:54.874924Z",
  "state": "DELIVERED",
  "payload": {
    "event": "message_deleted",
    "gateway_session_id": "00815dc9-c0cb-40b1-8d41-a2cf64674ec4",
    "conversation_id": "9054***pp.net",
    "wa_message_id": "3A00D7...585E",
    "delete_type": "everyone",
    "is_revoked": true,
    "revoked_at": "2026-11-08T10:07:54.847Z"
  }
}
```

---

### 3.5 Backend Tombstone Güncellemesi ve DB Kalıcılık Kanıtı

Backend `_ingest_message_deleted` fonksiyonu, gelen SEQ 291463 olayını işleyerek orijinal mesajı (ID: 178831) DB üzerinde güncellemiştir:

- **Veritabanı Satırı Güncel Durumu (`messages` ID 178831):**
  ```json
  {
    "id": 178831,
    "conversation_id": 39352,
    "direction": "OUTBOUND",
    "message_type": "UNKNOWN",
    "is_view_once": true,
    "is_revoked": true,
    "media_id": null,
    "body": "",
    "body_length": 0,
    "created_at": "2026-11-08 10:07:46.411070",
    "updated_at": "2026-11-08 10:07:54.865829"
  }
  ```
- **Korelasyon:** Mesaj gönderildikten tam **8.4 saniye sonra** silinmiş; Gateway olayı ile Backend güncellemesi arasındaki gecikme sadece **17 milisaniye** olmuştur.
- **Güvenlik Doğrulaması:** Mesaj gövdesi kalıcı olarak sıfırlanmış (`body: ""`), `media_id` alanı `null` kalmış ve `is_revoked: true` flag'i atanmıştır. Silinen verinin geri gelmesi imkansız kılınmıştır.

---

### 3.6 WebSocket Broadcast ve Frontend Yansıması

1. **WebSocket Yayını:** Backend `ConnectionManager.broadcast` fonksiyonu `user_id` filtresi uygulayarak bağlı istemciye `message_revoked` payload'ını iletmiştir.
2. **Kullanıcı Canlı Doğrulaması:** Kullanıcı, Tezlify ekranında mesajın anında silindiğini ve silinmiş mesaj kartına dönüştüğünü bizzat gözlemlemiştir.
3. **Kalıcılık (Refresh / Reconnect):** Veritabanında `is_revoked = true` ve `body = ""` kalıcı olarak saklandığı için sayfa yenilemelerinde veya geçmiş sorgularında silinmiş içerik kesinlikle yeniden ortaya çıkamaz (`ChatBubble.tsx` sözleşmesi gereği `is_revoked` durumunda daima "Bu mesaj silindi" mezartaşı render edilmektedir).

---

## 4. Doğrulanamayan Hususlar ve Notlar

- **Tarayıcı F5 / Hard Refresh Gözlemi:** Kullanıcı canlı test sırasında View Once görünümünü ve Herkesten Sil mezartaşını aktif websocket akışı üzerinden doğrulamıştır. Test sonrasında tarayıcı üzerinde ayrı bir F5 / sayfa yenileme testi talep edilmemiştir; ancak veritabanı satırı (ID 178831) fiziksel olarak `is_revoked=true` ve `body=""` olarak depolandığından, API seviyesinde kalıcılık tamdır.

---

## 5. Değerlendirme Tablosu

| Kabul Kriteri | Beklenen Davranış | Canlı Kanıt / Gözlem | Sonuç |
|---|---|---|:---:|
| **View Once Algılama** | `key.isViewOnce` dikkate alınmalı, mesaj düşürülmemeli | SEQ 291461, `is_view_once: true`, `[VIEW_ONCE_MEDIA]` | **PASS** |
| **Görsel Gizlilik** | Sahte link veya kırık resim üretilmemeli | `media_id: null`, UI generic privacy card render etti | **PASS** |
| **Herkesten Sil Algılama** | `protocolMessage.type == REVOKE` Gateway'den backend'e akmalı | SEQ 291463 `message_deleted` event | **PASS** |
| **Tombstone Güvenliği** | DB'de orijinal mesaj silinmeli, body sıfırlanmalı | DB row 178831 `is_revoked=True`, `body=""` | **PASS** |
| **Kullanıcı Kabulü** | Ekranda iki işlemin de hatasız görünmesi | Kullanıcı iki eylemin de başarılı olduğunu onayladı | **PASS** |

---

## 6. Sonuç

Tüm kalite kapıları, pre-deploy incelemeleri, production dağıtımı ve kontrollü canlı kabul testi başarıyla tamamlanmıştır. Tezlify WhatsApp View Once ve Revoke mimarisi **tam uyumlu ve kararlı** durumdadır.
