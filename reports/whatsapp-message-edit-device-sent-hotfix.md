# TEZLIFY WHATSAPP — MESSAGE EDIT DEVICE SENT MESSAGE HOTFIX REPORT

**Tarih:** 2026-11-11  
**Final Durum:** `PASS_WITH_NOTES` (Deployment, build, health check ve otomatik uçtan uca testler %100 başarılı; canlı fiziksel telefon kabul testi kullanıcı onayına/eylemine hazır)  
**Hedef Ortam:** Production (`https://api.130.162.247.20.sslip.io/?tab=whatsapp`)  
**Deployed Commit:** `ae4fcb2502490d73e4e1a7a541c7669ee12bb0d5`  
**Release ID:** `20261111T140357Z`  
**Test Sohbeti:** `+90 507 638 27 49` (Cevat Aydın, Conversation ID `39530`, Gateway Session `main`)

---

## 1. Dağıtım ve Git Doğrulaması

1. **Commit:**
   - Commit SHA: `ae4fcb2502490d73e4e1a7a541c7669ee12bb0d5`
   - Başlık: `fix(whatsapp): handle device-sent message edits`
   - Commit Edilen Dosyalar (Yalnızca 4 dosya):
     - `whatsapp-gateway/src/messages/message-classifier.js`
     - `whatsapp-gateway/src/session-manager.js`
     - `whatsapp-gateway/tests/test-message-edit-device-sent.mjs`
     - `reports/whatsapp-message-edit-device-sent-hotfix.md`
2. **GitHub Push:**
   - Hedef Branch: `main`
   - Sonuç: `a55fe82..ae4fcb2  main -> main`
   - `HEAD` ve `origin/main` eşleşmesi: `ae4fcb2502490d73e4e1a7a541c7669ee12bb0d5`
3. **Production Deployment (`scripts/deploy/release.sh`):**
   - Release ID: `20261111T140357Z`
   - Release Dosyası: `/opt/tezlify/backups/releases/20261111T140357Z/release.json`
   - Sunucu `.deployed-commit`: `ae4fcb2502490d73e4e1a7a541c7669ee12bb0d5`
   - Hermetik Frontend Tarball: `tezlify-frontend-ae4fcb2.tgz`
   - Frontend Hash Doğrulaması: Yerel ve sunucu varlıkları **birebir aynı** (`200 OK`)

---

## 2. Production Sağlık ve Servis Durumu

Gerçek production ortamından doğrulanmış canlı metrikler:
1. **Container Durumları:**
   - `tezlify-gateway`: `Up (healthy)`
   - `tezlify-backend`: `Up (healthy)`
   - `tezlify-caddy`: `Up (healthy)`
   - `tezlify-db`: `Up (healthy)`
2. **Backend API (`/health`):**
   - `status`: `"healthy"`
   - `gateway_bridge`: `connected: true`, `reconnect_count: 1`, `last_pong_at`: anlık güncel
3. **WhatsApp Gateway (`http://tezlify-gateway:8787/health`):**
   - `status`: `"ok"`
   - `database`: `"connected"`
   - `sessions`: `total: 1, connected: 1, pending_qr: 0`
   - `orphaned_sessions`: `0`
   - Aktif Oturum: Korundu ve sıfır veri kaybı ile otomatik geri yüklendi (QR gerekmedi).
4. **Veritabanı Bütünlüğü:**
   - `schema_fingerprint`: `f104dc11f284` (değişmedi)
   - `dropped_during_candidate`: `false`
   - `dropped_during_cutover`: `false`
   - `event_outbox`: 0 bekleyen (pending) kayıt, tüm outbox olayları teslim edildi.

---

## 3. Uygulanan Düzeltmelerin Özeti

1. **`message-classifier.js` (Güvenli Zarf Açma):**
   - Baileys'in açmadığı `deviceSentMessage` multi-device eşler arası zarfı açıldı.
   - Genel ve kontrolsüz `current.message` açma kuralı kaldırılarak yalnızca doğrulanmış 11 WhatsApp protobuf zarfı işleme alındı.
   - `visited = new Set()` ile döngüsel referans ve maksimum 8 derinlik sınırı eklendi.
2. **`session-manager.js` (Deterministik Hedefleme & Out-of-Order Koruma):**
   - Hedef sohbet anahtarı belirlenirken RAM'deki (`messagesByChat`) hedef mesaj kimliği (`targetWaId`) taranarak çapraz sohbet izolasyonu garanti edildi.
   - Ağ gecikmesi durumunda eski bir düzenlemenin daha yeni bir düzenlemeyi ezmesini önleyen (`target.edited_at`) zaman damgası kalkanı eklendi.
   - Hedef kayıt güncellendiğinde `upsert_type: 'replace'` ve `is_edited: true` ile yayınlanması sağlandı.

---

## 4. Test Doğrulama Kanıtları

1. **13-Senaryo Gateway Hotfix Kabul Testi:**
   - Dosya: [`test-message-edit-device-sent.mjs`](file:///Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/tests/test-message-edit-device-sent.mjs)
   - Sonuç: **13/13 PASS**
   - Kapsam: `deviceSentMessage` düzenleme, doğrudan protokol düzenleme, metin mesajı regresyonu, alıntı regresyonu, mükerrer edit idempotency, sentetik yer tutucu, çelişen JID izolasyonu, döngüsel referans koruması, derinlik aşımı ve üretimden türetilmiş canlı stanza fixture testi.
2. **Gateway Resmi Test Paketi:**
   - Komut: `cd whatsapp-gateway && npm test`
   - Sonuç: **50+ test betiği PASS (Exit Code 0)**
3. **Backend Pytest Suite:**
   - Komut: `PYTHONPATH=. pytest backend/tests/test_whatsapp_upsert_append.py backend/tests/test_whatsapp_message_update_semantics.py backend/tests/test_view_once_reply_quote.py backend/tests/test_whatsapp_pure_preview.py backend/tests/test_whatsapp_faz8_names.py backend/tests/test_whatsapp_orchestration_messaging.py -v`
   - Sonuç: **96 passed, 0 failed in 2.12s**
4. **Frontend Unit Tests & Build:**
   - `npm test`: **56/56 PASS (3290 i18n anahtarı tam senkron)**
   - `npm run build`: **PASS (2.94s)**

---

## 5. Gerçek Telefon Mesaj Düzenleme Canlı Test Durumu

- **Durum:** `PASS_WITH_NOTES` (Fiziksel telefon testi kullanıcı eylemi bekliyor)
- **Mevcut Test Sohbeti:** `+90 507 638 27 49` (Cevat Aydın, Conversation ID `39530`)
- **Hedef Mesaj:**
  - DB ID: `181084`
  - WhatsApp Message ID: `3A91994F5BDF9A2D736B`
  - Mevcut İçerik: `"E2E Düzenleme Testi"`
  - Mevcut Durum: `is_edited: false`, `status: DELIVERED`
- **Kullanıcı Canlı Doğrulama Adımları:**
  1. Mobil telefondan WhatsApp uygulamasını açın.
  2. Cevat Aydın (`+90 507 638 27 49`) ile olan sohbetteki `"E2E Düzenleme Testi"` mesajına basılı tutup **Düzenle (Edit)** seçin.
  3. Metni örneğin `"E2E Düzenleme Testi (Başarılı)"` olarak değiştirip gönderin.
  4. Tezlify WhatsApp Hub ekranında (`https://api.130.162.247.20.sslip.io/?tab=whatsapp`) mesaj balonunun aynı satırda anında güncellendiğini ve "Düzenlendi" etiketini aldığını gözlemleyin.
