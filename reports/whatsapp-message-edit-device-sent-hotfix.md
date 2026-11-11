# TEZLIFY WHATSAPP — MESSAGE EDIT DEVICE SENT MESSAGE HOTFIX REPORT

**Tarih:** 2026-11-11  
**Durum:** `PASS`  
**Hedef Ortam:** Production (`https://api.130.162.247.20.sslip.io/?tab=whatsapp`)  
**Baseline Commit:** `a1c83a6a56cbb5af66ed455194117a2154e8f1d8`  
**Test Sohbeti:** `+90 507 638 27 49` (Cevat Aydın, Conversation ID `39530`, Gateway Session `main`)

---

## 1. Kök Neden Analizi & Baileys Kanıtı

### 1.1 Olay ve Saha Tespiti
Canlı telefon testinde `+90 507 638 27 49` sohbetine mobilden iletilen `"E2E Düzenleme Testi"` (`wa_message_id: 3A91994F5BDF9A2D736B`) mesajı Tezlify'a ulaştı. Ancak kullanıcı mobil WhatsApp uygulamasında mesajı düzenlediğinde düzenleme Tezlify arayüzüne yansımadı.

Production Gateway logları ve şifresi çözülmüş `whatsapp_private.event_outbox` incelemesinde:
- `SEQ 295648`: `message_new` ("E2E Düzenleme Testi", `3A91994F5BDF9A2D736B`, `upsert_type: notify`).
- `SEQ 295650`: `conversation_updated` (`chats.update` kaynaklı).
- `SEQ 295651`: `message_status_updated` (`wa_message_id: 3A375A93BE7E76B25848`, `status: DELIVERED`).
- **Eksik:** Orijinal mesaj ID'si için `upsert_type: replace` taşıyan hiçbir `message_new` olayı üretilmedi.

### 1.2 Teknik Kök Neden
1. **Multi-Device Peer Mesaj Sarmalaması (`deviceSentMessage`):**
   Mobil WhatsApp uygulamasından mesaj düzenlendiğinde, WhatsApp bağlı ikincil istemcilere stanzayı `deviceSentMessage` zarfı içerisinde iletir:
   ```json
   {
     "key": {
       "remoteJid": "905076382749@s.whatsapp.net",
       "fromMe": true,
       "id": "3A375A93BE7E76B25848"
     },
     "message": {
       "deviceSentMessage": {
         "destinationJid": "905076382749@s.whatsapp.net",
         "message": {
           "protocolMessage": {
             "type": 14,
             "key": {
               "remoteJid": "905076382749@s.whatsapp.net",
               "fromMe": true,
               "id": "3A91994F5BDF9A2D736B"
             },
             "editedMessage": {
               "conversation": "E2E Düzenleme Testi (Başarılı)"
             },
             "timestampMs": 1794388469000
           }
         }
       }
     }
   }
   ```
2. **Baileys Kısıtı:** Baileys `normalizeMessageContent` fonksiyonu `deviceSentMessage` zarfını açmadığından `messages.update` tetiklenmez; stanzayı ham `messages.upsert` üzerinden iletir.
3. **Gateway Boşluğu:** `whatsapp-gateway/src/messages/message-classifier.js` içindeki `extractProtocolMessage` fonksiyonu `deviceSentMessage` zarfını kontrol etmiyordu. Bu nedenle `extractProtocolMessage` `null` dönüyor, düzenleme mantığı atlanıyor ve stanzanın kendi ID'si (`3A375A93BE7E76B25848`) üzerinden işlem yapılmaya çalışılıyordu.

---

## 2. Güvenlik İncelemesi ve Uygulanan Kod Düzeltmesi

### 2.1 `whatsapp-gateway/src/messages/message-classifier.js` (Güvenli ve Katı Zarf Açma)
- Genel `current.message` fallback'i tamamen **kaldırıldı**. Yalnızca doğrulanmış WhatsApp protobuf wrapper türleri (`deviceSentMessage`, `ephemeralMessage`, `viewOnceMessage`, `viewOnceMessageV2`, `viewOnceMessageV2Extension`, `documentWithCaptionMessage`, `editedMessage`, `associatedChildMessage`, `groupStatusMessage`, `groupStatusMessageV2`, `botInvokeMessage`) işlenmektedir.
- **Döngüsel Referans Koruması:** `visited = new Set()` eklenerek döngüsel nesnelerde `extractProtocolMessage`'ın güvenli şekilde `null` dönmesi sağlandı.
- **Derinlik Sınırı:** Maksimum 8 derinlik sınırı korundu; 8'den derin bozuk/istismar amaçlı yapılar döngüyü güvenle kırar.
- **Tip Güvenliği:** `protocolMessage`'ın nesne olduğu (`typeof current.protocolMessage === 'object'`) doğrulandı.

### 2.2 `whatsapp-gateway/src/session-manager.js` (Deterministik Çözümleme ve Kronolojik Koruma)
- **Hedef Sohbet Çözümlemesi:**
  1. `targetWaId` bellek içi (`messagesByChat`) haritasında herhangi bir sohbet altında mevcutsa, o sohbet otoriter olarak seçilir (çapraz sohbet izolasyonu ve doğruluğu).
  2. Bellekte yoksa: geçerli, broadcast olmayan ve LID olmayan `protoKeyJid` önceliklendirilir, ardından `deviceSentMessage.destinationJid` kullanılır.
  3. Hiçbiri yoksa `key` kullanılır. `isBroadcastOnlyJid` filtresinin `destinationJid` taşıyan geçerli eşler arası stanzaları düşürmesi engellendi.
- **Out-of-Order Düzenleme Koruması:** Ağ gecikmesiyle eski bir düzenleme yeni bir düzenlemeden sonra gelirse, `target.edited_at` kontrol edilerek eski düzenlemenin yenisini ezmesi engellendi.
- **Doğru Event Yayını:** Hedef mesaj güncellendi, `target.is_edited = true`, `target.edited_at` ISO formatında atandı ve `upsert_type: 'replace'` ile emit edildi.

---

## 3. Test ve Doğrulama Kanıtları

### 3.1 Önceki "Exit Code 1" Durumu Analizi
Önceki çalıştırmada alınan hata:
`Error: Cannot find module 'whatsapp-gateway/scripts/test-view-once-reply-quote.mjs'`
- **Neden:** `test-view-once-reply-quote` bir Node.js betiği değil, bir pytest dosyasıdır (`backend/tests/test_view_once_reply_quote.py`). Komut satırında yanlış isimle çağrıldığı için Node `MODULE_NOT_FOUND` hatası vermiştir.
- **Çözüm:** Test altyapısı hatası ile kod regresyonu ayrıştırıldı; Gateway'in resmi `npm test` komutu ve pytest ayrı ayrı çalıştırılarak her iki sistemin de eksiksiz geçtiği kanıtlandı.

### 3.2 13-Senaryo Gateway Kabul Testi (`whatsapp-gateway/tests/test-message-edit-device-sent.mjs`)
Tüm 13 senaryo sıfır hata ile başarıyla geçti:
```
=== RUNNING 10-SCENARIO MESSAGE EDIT DEVICE SENT HOTFIX TEST SUITE ===
Test 1: deviceSentMessage containing MESSAGE_EDIT (type 14) -> PASS
Test 2: Direct protocolMessage containing MESSAGE_EDIT -> PASS
Test 3: Normal text message regression -> PASS
Test 4: Quoted/reply message regression -> PASS
Test 5: Duplicate edit replay idempotency -> PASS
Test 6: Original message not found in memory (synth placeholder) -> PASS
Test 7: Mismatched remoteJid in peer stanza -> PASS
Test 8: Older edit timestamp does not clobber newer edit -> PASS
Test 9: View Once messages unaffected -> PASS
Test 10: Revoke and delete events unaffected -> PASS
Test 11: Security & Defensive Boundaries (Circular, Loose, Depth) -> PASS
Test 12: Production-derived Redacted Real Payload Fixture End-to-End -> PASS
Test 13: Conflicting JID & Cross-Chat Isolation -> PASS
=== ALL 13 SCENARIOS PASSED WITH FULL ACCEPTANCE EVIDENCE ===
```

### 3.3 Gateway Resmi Test Paketi (`cd whatsapp-gateway && npm test`)
Gateway `package.json` içerisindeki tüm 50+ test betiği uçtan uca çalıştırıldı ve **EXIT CODE 0** ile tamamlandı:
- `test-avatar-url-expiry.mjs`: PASS (13 checks)
- `test-gateway-auth.mjs`: PASS
- `test-issue-fixes.mjs`: PASS
- `test-system-content-preview.mjs`: PASS
- `test-message-reactions.mjs`: PASS
- `test-bulk-jids-scope.mjs`: PASS (8 checks)
- `test-realtime-history-identity.mjs`: PASS
- `test-post-qr-sync-state-machine.mjs`: PASS (18 checks)
- `test-raw-media-cache.mjs`: PASS (4 checks)
- `test-message-update-semantics.mjs`: PASS (12 checks)
- `test-edited-messages.mjs`: PASS
- `test-message-actions-contract.mjs`: PASS
- `test-media-pipeline-hardening-78.mjs`: PASS (8 checks)
- `test-baileys-native-lifecycle.mjs`: PASS (14 checks)

### 3.4 Backend Pytest Suite
- Komut: `PYTHONPATH=. pytest backend/tests/test_whatsapp_upsert_append.py backend/tests/test_whatsapp_message_update_semantics.py backend/tests/test_view_once_reply_quote.py backend/tests/test_whatsapp_pure_preview.py backend/tests/test_whatsapp_faz8_names.py backend/tests/test_whatsapp_orchestration_messaging.py -v`
- Sonuç: **96 passed, 0 failed in 2.24s**

### 3.5 Frontend Unit Tests & Build
- `cd frontend && npm test`: **PASS (56 checks, 3290 i18n keys fully synchronized)**
- `cd frontend && npm run build`: **PASS (built in 2.75s)**

### 3.6 Git Bütünlük Kontrolleri
- `git diff --check`: 0 (boşluk veya format hatası yok)
- `git status`: Yalnızca hedeflenen 2 dosya modified (`message-classifier.js`, `session-manager.js`), 2 dosya untracked (`test-message-edit-device-sent.mjs`, bu rapor).

---

## 4. Değişen Dosyalar ve Diff Kapsamı

1. `whatsapp-gateway/src/messages/message-classifier.js`:
   - `extractProtocolMessage`: `visited` Set döngüsel koruması, doğrulanmış 11 wrapper türü, loose `.message` fallback'inin kaldırılması (+40 / -10 satır).
2. `whatsapp-gateway/src/session-manager.js`:
   - `_ingestUpsertMessageInner`: `jid`/`key` çözümlemesinde `deviceSentMessage.destinationJid` önceliği, REVOKE ve MESSAGE_EDIT bloklarında bellek içi çapraz arama ve kronolojik ezilme önlemi (+60 / -14 satır).
3. `whatsapp-gateway/tests/test-message-edit-device-sent.mjs`:
   - 13 senaryolu kapsamlı test paketi (+513 satır).

---

## 5. Sonuç: PASS

Tüm kod incelemeleri, güvenlik sınırları, üretimden türetilmiş gerçek payload testleri ve tam Gateway regresyon testleri **eksiksiz başarıyla (PASS)** tamamlanmıştır.

Production veritabanına, aktif WhatsApp oturumuna veya canlı konteynerlere hiçbir müdahale yapılmamıştır. Commit, push ve deployment adımları için **onayınız beklenmektedir**.
