# Tezlify WhatsApp QR / Linked Device - Phase 4: Inbound Message Bridge & Persistence

## 1. Mimari ve Amaç
Phase 4'ün tek odak noktası, Baileys QR oturumlarından gelen gerçek inbound WhatsApp mesajlarının uçtan uca güvenilir, fail-closed, idempotant ve tenant-izole şekilde taşınarak DB'ye kaydedilmesi ve Canlı Diyaloglar ekranına gerçek zamanlı iletilmesidir:

```
WhatsApp Mobile (Kullanıcı Cihazı)
       ↓ (Baileys socket)
Baileys Gateway (wa-gateway/src/sessionManager.js)
       ↓ (HTTP POST + X-Webhook-Secret)
Inbound Event Bridge (/api/v1/whatsapp/webhook/inbound)
       ↓
Backend Authoritative Session & Tenant Resolution
       ↓
Contact & CRM Lead Resolution
       ↓
Conversation Resolution & Update
       ↓
Message Persistence (wa_message_id Idempotency)
       ↓
DB ATOMIC COMMIT
       ↓
WebSocket Broadcast (tezlify:ws_event)
       ↓
Frontend Canlı Diyaloglar UI
```

---

## 2. Gateway Tarafı (wa-gateway)
- **`messages.upsert` Filtreleme**:
  - `type !== 'notify'` olan arka plan sync (`append`) mesajları filtrelenir; sadece canlı `notify` mesajları işlenir.
  - `key.fromMe === true` olan giden mesajlar filtrelenir (inbound sahte müşteri mesajı olamaz).
  - `status@broadcast` sistem/durum güncellemeleri filtrelenir.
  - `@g.us` grup mesajları kişisel müşteri gelen kutusunu kirletmemesi için filtrelenir/yoksayılır.
- **Message Unwrapping**:
  - `ephemeralMessage`, `viewOnceMessage`, `viewOnceMessageV2`, `documentWithCaptionMessage` gibi sarmalayıcılar güvenle unwrapped edilir.
- **Mesaj Tipi Sınıflandırması**:
  - `conversation`, `extendedTextMessage` -> `TEXT`
  - `imageMessage` -> `IMAGE`
  - `videoMessage` -> `VIDEO`
  - `audioMessage` -> `AUDIO`
  - `documentMessage` -> `DOCUMENT`
  - `stickerMessage` -> `STICKER`
  - `locationMessage` -> `LOCATION`
  - `contactMessage` -> `CONTACT`
  - Diğer bilinmeyen -> `OTHER`
- **Fallback Metin**:
  - Başlıksız görseller ve sesler için `📷 Fotoğraf`, `🎥 Video`, `🎵 Ses` gibi kullanıcı dostu yer tutucular atanır.
- **In-Memory Dedup**:
  - Oturum başına son 1.000 mesaj ID'si tutularak Gateway katmanında anlık duplicate webhook gönderimleri engellenir.
- **Listener & Reconnect Temizliği**:
  - Oturum yeniden başlatıldığında veya kapandığında eski soket listener'ları (`ev.removeAllListeners()`, `sock.ws.close()`) temizlenir.

---

## 3. Backend Tarafı (FastAPI / SQLAlchemy)
- **Webhook Güvenliği**:
  - `X-Webhook-Secret` doğrulaması fail-closed (401 Unauthorized).
- **Tenant & Oturum Doğrulaması**:
  - Gateway'den gelen oturum kimliği veritabanından `WhatsAppSession` üzerinden çözülür.
  - `tenant_id` eşleşmesi kontrol edilir; uyumsuzluk durumunda 403 Forbidden fail-closed döndürülür.
- **Contact & Lead Çözümlemesi**:
  - `PhoneService.normalize_to_e164` ile telefon canonical E.164 standardına getirilir.
  - Tenant bazında `Contact` taranır; yoksa yeni `Contact` oluşturulur.
  - CRM uyumluluğu için `Lead` kaydı kontrol edilir ve ilişkilendirilir.
  - WhatsApp profil adı (`push_name`) mevcut display name'i ezmeden kaydedilir.
- **Conversation Çözümlemesi**:
  - `whatsapp_number_id` + `contact_id` + `user_id` bazında doğru görüşme bulunur veya oluşturulur.
  - `unread_count`, `last_message_preview`, `last_customer_message_at` güncellenir.
  - Baileys taşıyıcısı Meta Cloud'a özgü 24 saatlik katı template kısıtlamasına sokulmaz.
- **Mesaj Idempotency & DB Sınırı**:
  - `wa_message_id` varlığı kontrol edilir. Aynı `wa_message_id` ikinci kez gelirse duplicate olarak işaretlenir ve ikinci bir `Message` satırı açılmaz.
  - `MessageDirection.INBOUND` ve `ConversationMessageStatus.RECEIVED` ile kaydedilir.
  - **Transaction Boundary**: Tüm DB kayıtları `await db.commit()` ile atomik olarak kaydedildikten SONRA WebSocket yayını yapılır.
- **Opt-Out Tespiti**:
  - `"istemiyorum"`, `"iptal"`, `"sil"`, `"stop"`, `"unsubscribe"` gibi anahtar kelimeler regex ile yakalanıp numara otomatik olarak `Blacklist`'e alınır ve Lead durumu `UNSUBSCRIBED` yapılır.

---

## 4. Canlı İletim ve UI
- `ws_manager.broadcast` ile yalnızca ilgili tenant kullanıcısına (`target_user_id`) WebSocket mesajı gönderilir.
- Canlı Diyaloglar ekranında `inbound_reply` olayı ile sol liste ve aktif sohbet anında güncellenir.

---

## 5. Doğrulama ve Test Sonuçları
- **wa-gateway unit & integration tests**:
  - `test/sessionManager.test.js` (LID-PN ve Session): **PASS**
  - `test/phase2_session_lifecycle.test.js`: 17/17 **PASS**
  - `test/phase3_frontend_qr_flow.test.js`: 12/12 **PASS**
  - `test/phase4_inbound_bridge.test.js`: 12/12 **PASS**
- **Backend pytest regression suite**:
  - `backend/tests/test_whatsapp_phase4_inbound.py`: 8/8 **PASS**
  - Toplam: **667 passed, 5 skipped, 0 failed** (Önceki 659 passed testin tümü regression'sız korundu).
- **Frontend build**:
  - `npm run build`: **PASS** (0 TypeScript ve 0 Vite hatası).
