# TEZLIFY WHATSAPP — VIEW ONCE & REVOKE DÜZELTME RAPORU

**Tarih:** 8 Kasım 2026
**Referans Production Commit:** `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c`
**Referans İnceleme Raporu:** `reports/whatsapp-view-once-production-live-acceptance.md`
**Durum:** YEREL DÜZELTME VE TÜM TESTLER TAMAMLANDI (PRODUCTION'A HENÜZ COMMIT / DEPLOY EDİLMEDİ)

---

## 1. Başlangıç Git Durumu

- **Branch:** `main`
- **HEAD Commit:** `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c` (`fix(whatsapp): harden view-once extraction and eliminate media download crash loops`)
- **Git Durumu:** Temiz çalışma ağacından başlandı. Kullanıcının mevcut hiçbir commit veya dalı ezilmedi.
- **Sınır Uyumu:** `git push` yapılmadı, `release.sh` çalıştırılmadı, production container veya DB'sine müdahale edilmedi.

---

## 2. Düzeltilen Gateway Hataları

### 2.1 Baileys Companion Stanza (`msg.key.isViewOnce`) Kaybı
- **Kök Neden:** WhatsApp Multi-Device protokolünde, ana telefondan gönderilen veya alınan tek görüntülenmelik mesajlar masaüstü/companion web istemcilerine `<unavailable type="view_once"/>` şeklinde şifreli içerik olmaksızın iletilir. Baileys kütüphanesi bu mesajlarda `msg.message = undefined` bırakırken `msg.key.isViewOnce = true` bayrağını set eder.
- **Düzeltme:**
  - `isViewOnceMessage(content, key)` fonksiyonu hem `msg.message` zarfını hem de `msg.key?.isViewOnce === true` sinyalini birinci sınıf View Once kabul edecek şekilde genişletildi.
  - `classifyMessageType(content, key)` fonksiyonu, eğer içeriksiz View Once mesajı gelirse tür uydurmadan (`IMAGE` veya `PHOTO` varsaymadan) güvenli biçimde `'UNKNOWN'` türü döner.
  - `session-manager.js` içindeki `_ingestUpsertMessageInner`, `_historyMessageToRecord` ve raw formatlayıcı fonksiyonlarda:
    - `isViewOnce = Boolean(msg.key?.isViewOnce || isViewOnceMessage(msg.message, msg.key) || isViewOnceMessage(unwrapped, msg.key))` olarak çözüldü.
    - İçeriksiz veya türü belirsiz companion mesajları için `viewOnceKind = 'UNKNOWN'`, `body = '[VIEW_ONCE_MEDIA]'`, `message_type = 'UNKNOWN'` ve `media_mime_type = null` atandı. Sahte `media_id` veya sahte `image/jpeg` mime üretimi engellendi.
    - `hasRecognizedContent` filtresinde `isViewOnce` true olduğunda mesajın `null` olarak sessizce düşürülmesi engellendi.

### 2.2 Formatting ve Normalization Paritesi
- `whatsapp-formatting.js`: `VIEW_ONCE_MEDIA: '👁️ Tek görüntülenmelik medya'` etiketi `TYPE_PREVIEW_LABELS` ve `normalizePreviewText` sözlüğüne eklendi.

---

## 3. Düzeltilen Backend Revoke/Tombstone Davranışı

### 3.1 Orijinal Mesaj Bulunamayan Revoke Olayları (Out-of-Order / Missing Target)
- **Kök Neden:** `backend/app/services/whatsapp/orchestration/events.py` içindeki `_ingest_message_deleted` fonksiyonu, `target_msg` veritabanında bulunamadığında `_skip_event(...)` çalıştırarak olayı sessizce yutuyor, frontend'e hiçbir WebSocket bildirimi iletmiyordu.
- **Düzeltme & Güvenlik:**
  1. **Kiracı ve Sohbet Doğrulaması:** Orijinal mesaj bulunamadığında, event yükündeki `chat_jid` ve session bilgisi üzerinden `resolve_event_owner_and_session` ile kiracı/owner çözüldü, `find_whatsapp_conversation` ile güvenilir DB sohbeti bulundu. Sohbet veya kiracı doğrulanamazsa körlemesine broadcast yapılmaz, fail-closed davranılır.
  2. **Kalıcı Mezar Taşı (Tombstone Record):**
     - Veritabanında hedef `wa_message_id` için bir kayıt aranır.
     - Kayıt yoksa güvenli bir savepoint (`session.begin_nested()`) içinde kalıcı bir `Message` tombstone nesnesi oluşturulur:
       - `direction = MessageDirection.INBOUND` (veya `from_me`'ye göre)
       - `body = ""` (silinen içerik sızdırılmaz)
       - `is_revoked = True`
       - `revoked_at = datetime.now(timezone.utc)`
       - `status = ConversationMessageStatus.DELIVERED`
     - Sohbetin son mesaj önizlemesi güvenle `'Bu mesaj silindi'` olarak güncellenir.
  3. **Yeniden Sıralama / Geç Gelen Orijinal Mesaj Koruması:**
     - Eğer bir revoke olayı orijinal mesajdan önce gelmişse ve tombstone oluşturulmuşsa; ardından `_ingest_message` ile orijinal mesaj DB'ye yazılmaya çalışıldığında, `canonical.is_revoked == True` kontrolü devreye girer.
     - Geç gelen mesajın gövdesi boşa çekilir (`body = ""`, `media_id = None`), revocation bayrağı korunur ve silinmiş mesajın geri dirilmesi kesin olarak engellenir.
  4. **Tekrarlı Olay İdempotensi:**
     - Aynı revoke olayı tekrar geldiğinde, mevcut tombstone tespit edilir, gereksiz mükerrer insert yapılmaz ve mevcut payload güvenle frontend'e iletilir.

---

## 4. Frontend Değişiklikleri

### 4.1 Görselleştirme (`ChatBubble.tsx`)
- `isViewOnce` mesajlarda:
  - Video ise: `t('whatsapp.viewOnceVideo')`
  - Ses ise: `t('whatsapp.viewOnceAudio')`
  - Fotoğraf ise: `t('whatsapp.viewOncePhoto')`
  - Bilinmeyen veya genel medya ise: `t('whatsapp.viewOnceMedia')` ve `t('whatsapp.viewOnceNoticeInboundMedia')` ("Tek görüntülenmelik medya — WhatsApp uygulamasından görüntüleyin").
  - Bilinmeyen medyada lightbox veya `<img>` etiketi render edilmez, sahte görsel URL'si üretilmez.
- Quoted / yanıt kutusunda silinmiş ve tek görüntülenmelik mesaj etiketleri i18n sözlüğüne bağlandı.

### 4.2 Gerçek Zamanlı Revoke Olayı (`WhatsAppHubPage.tsx`)
- `message_deleted` WebSocket olayı geldiğinde, eğer revoked mesaj yerel `messagesMap` içinde mevcut değilse, UI listesine güvenli bir tombstone mesaj nesnesi eklenir (`is_revoked: true, body: ''`).
- Sohbet listesi önizlemesi anında `'Bu mesaj silindi'` olarak güncellenir.

### 4.3 Yerelleştirme (i18n Parity)
- `frontend/src/locales/tr.ts` ve `frontend/src/locales/en.ts` dosyalarına şu anahtarlar tam simetrik olarak eklendi:
  - `previewViewOnceMedia`
  - `viewOnceMedia`
  - `viewOnceNoticeInboundMedia`

---

## 5. Değiştirilen Dosyalar

1. `whatsapp-gateway/src/messages/message-classifier.js` (View Once key ve envelope algılama, generic UNKNOWN desteği)
2. `whatsapp-gateway/src/session-manager.js` (Ingestion, history ve raw formatlamada companion View Once desteği)
3. `whatsapp-gateway/src/utils/whatsapp-formatting.js` (VIEW_ONCE_MEDIA önizleme etiketi)
4. `whatsapp-gateway/tests/test-view-once-extraction.mjs` (14 durumlu View Once birim test paketi)
5. `whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs` (Companion stanzaları ve ingestion kontrat testleri)
6. `backend/app/services/whatsapp/preview_normalization.py` (VIEW_ONCE_MEDIA backend etiket desteği)
7. `backend/app/services/whatsapp/orchestration/messaging.py` ([VIEW_ONCE_MEDIA] serialization desteği)
8. `backend/app/services/whatsapp/repositories/messages.py` ([VIEW_ONCE_MEDIA] build desteği)
9. `backend/app/services/whatsapp/orchestration/events.py` (Kalıcı tombstone, out-of-order revoke koruması)
10. `backend/tests/test_view_once_revoke_tombstone.py` (Tombstone oluşturma, idempotency ve late-arrival testleri)
11. `frontend/src/locales/tr.ts` (TR yerelleştirme anahtarları)
12. `frontend/src/locales/en.ts` (EN yerelleştirme anahtarları)
13. `frontend/src/features/whatsapp/components/ChatBubble.tsx` (Generic View Once ve silinmiş alıntı gösterimi)
14. `frontend/src/pages/WhatsAppHubPage.tsx` (Unlisted mesaj revoke tombstone entegrasyonu)
15. `frontend/scripts/verify-whatsapp-logic.mjs` (Test asserting ve veri tipleri senkronizasyonu)
16. `frontend/scripts/verify-whatsapp-dom.mjs` (Pill seçici spesifikliği)

---

## 6. Test Sonuçları ve Gerçek Komut Çıktıları

| Test Alanı | Komut | Durum | Doğrulanan Kapsam |
|------------|-------|-------|-------------------|
| Gateway View Once Birim | `node whatsapp-gateway/tests/test-view-once-extraction.mjs` | **PASS** | 14 senaryo (key.isViewOnce, V1/V2/V2Ext, PTV, deviceSent, stub, ciphertext) |
| Gateway Ingestion Kontratı | `node whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs` | **PASS** | Companion stanza ingestion, deduplication, photo/video/unknown ayrımı |
| Gateway Tam Test Paketi | `cd whatsapp-gateway && npm test` | **PASS** | 50+ dosya, yüzlerce test senaryosu (auth, lifecycle, media, ordering, events) |
| Backend Revoke Tombstone | `pytest backend/tests/test_view_once_revoke_tombstone.py` | **PASS** | 4 test (tombstone creation, idempotency, late arrival, unknown serialization) |
| Backend View Once & Revoke | `pytest backend/tests/test_view_once_reply_quote.py` | **PASS** | 6 test (view once fail-closed, quoted view-once/revoke body stripping) |
| Backend Delete For Me | `pytest backend/tests/test_delete_for_me_isolation.py` | **PASS** | 3 test (multi-user delete-for-me izolasyonu) |
| Backend WhatsApp Entegrasyon | `pytest backend/tests/... (76 test)` | **PASS** | 76 testin tamamı yeşil (0 hata) |
| Frontend Mesaj Birleştirme | `npm --prefix frontend run verify:merge` | **PASS** | Identity, status, reconnect, media, revoke, view once retention |
| Frontend Mantık & i18n | `npm --prefix frontend run verify:logic` | **PASS** | 56 kontrolün tamamı yeşil, i18n anahtarları 3286/3286 tam eşit |
| Frontend DOM & Thread | `npm --prefix frontend run verify:dom` | **PASS** | 22 kontrolün tamamı yeşil (scroll anchoring, pill, composer isolation) |
| Frontend Üretim Derlemesi | `cd frontend && npm run build` | **PASS** | TypeScript derleme ve Vite minification hatasız tamamlandı |

---

## 7. Veritabanı Migration İhtiyacı ve Risk Değerlendirmesi

- **Migration İhtiyacı:** **YOK**.
- **Gerekçe:** Mevcut `messages` tablosu `is_revoked` (boolean), `revoked_at` (timestamp), `wa_message_id` (string), `conversation_id` (foreign key) ve `direction` kolonlarını eksiksiz içermektedir. Tombstone kayıtları standart bir `Message` satırı olarak `is_revoked = True` ve `body = ""` ile oluşturulur. Bu yapı mevcut keyset pagination, filtreleme ve silme mantığıyla %100 uyumludur.
- **Risk Değerlendirmesi:**
  - `savepoint` (`session.begin_nested()`) kullanıldığı için eşzamanlı yarış durumlarında (race conditions) veritabanı oturumu bozulmaz.
  - Orijinal mesaj sonradan gelse dahi `is_revoked` durumunu ezemeyeceği kanıtlanmıştır.

---

## 8. Kalan Sınırlamalar

1. **WhatsApp Companion Protokol Kısıtı:** WhatsApp ana telefondan atılan tek görüntülenmelik medyaların şifre çözme anahtarlarını (media keys) bağlı ikincil web istemcilerine göndermez (`<unavailable type="view_once"/>`). Bu nedenle Tezlify arayüzünden bu fotoğraf/videonun içeriğini açmak kriptografik olarak mümkün değildir. UI bunu kullanıcıya açıkça *"WhatsApp uygulamasından görüntüleyin"* şeklinde bildirir.
2. **Kayıp Tarih:** Orijinal mesaj DB'de yokken gelen bir revoke olayında mesajın orijinal oluşturulma tarihi bilinmediğinden, tombstone'un `created_at` değeri silinme anı (`datetime.now(timezone.utc)`) olarak kaydedilir.

---

## 9. Production Dağıtım Durumu

> [!IMPORTANT]
> Bu aşamada yapılan tüm değişiklikler **YALNIZCA YEREL ÇALIŞMA AĞACINDA** test edilmiş ve doğrulanmıştır.
> **Hiçbir kod commit edilmemiş, `git push` yapılmamış ve production ortamına deploy edilmemiştir.**
> Kullanıcının onayı sonrasında commit, push ve deploy aşamasına geçilecektir.
