# TEZLIFY WHATSAPP — VIEW ONCE & REVOKE / TEST TUTARLILIĞI KAPANIŞ RAPORU

**Tarih:** 8 Kasım 2026
**Hedef:** Pre-deploy inceleme notunun (`whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs` testindeki `summary.is_view_once` tutarsızlığı) kapatılması ve Gateway test kapısının %100 yeşile ulaştırılması
**Referans Raporlar:**
- `reports/whatsapp-view-once-production-live-acceptance.md`
- `reports/whatsapp-view-once-revoke-fix-report.md`
- `reports/whatsapp-view-once-revoke-predeploy-review.md`
**Nihai Karar:** **`PASS`**

---

## 1. Kapsam ve İnceleme Analizi

Pre-deploy review raporunda Bulgu 1 olarak kaydedilen konu:
- `whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs` dosyasının 127. satırında `assert.equal(summary.is_view_once, true);` yer almaktaydı.
- `summarizeWaMessage(waMsg)` fonksiyonu, Gateway genelinde (`whatsapp-gateway/src/socket/socket-events.js` Satır 906) chat preview etiketini üretmek (`normalizePreviewText(s.message_type, s.body)`) amacıyla tasarlanmıştır ve tüm dallarında katı olarak `{ message_type: string, body: string }` sözleşmesini uygular.
- Tam mesaj ingestion ve veritabanı persist modellerinde (`_ingestUpsertMessageInner` ve `_historyMessageToRecord`) `is_view_once: true` alanı eksiksiz mevcuttur (test dosyasında Satır 55, 90, 119 ve 147'de doğrulanmaktadır).
- Dolayısıyla `summarizeWaMessage`'ın chat preview özetleme sözleşmesi korunmalı; testin bu fonksiyondan dönen `summary` nesnesi üzerinde `body === '[VIEW_ONCE_MEDIA]'` ve `message_type === 'UNKNOWN'` kontrolleriyle doğrulanması sağlanmalıdır.

---

## 2. Yapılan En Küçük Düzeltme

- **Değiştirilen Dosya:** `whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs`
- **Fark:** Satır 127'deki gereksiz `assert.equal(summary.is_view_once, true);` assertion'ı kaldırılarak fonksiyonun gerçek ve tutarlı `{ message_type, body }` sözleşmesine hizalandı:
  ```javascript
  // 5. Test summarizeWaMessage with companion stanza (key.isViewOnce = true, no message)
  const summary = summarizeWaMessage(voCompanionMsg);
  assert.ok(summary, 'summarizeWaMessage must not drop key-only View Once');
  assert.equal(summary.body, '[VIEW_ONCE_MEDIA]');
  assert.equal(summary.message_type, 'UNKNOWN');
  ```
- **Backend ve Frontend Etkisi:** Sıfır (hiçbir backend veya frontend dosyasına dokunulmadı).

---

## 3. Doğrulama ve Test Kapısı Sonuçları

Aşağıdaki üç test komutu çalıştırılmış ve gerçek terminal çıktıları ile exit code'ları doğrulanmıştır:

| Test Komutu | Exit Code | Durum | Doğrulanan Kapsam |
|---|---|---|---|
| `node whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs` | **0** | **PASS** | Companion stanza ingestion (`record.is_view_once: true`, `[VIEW_ONCE_MEDIA]`), deduplication, photo/video/unknown ayrımı, stub dropping, `summarizeWaMessage` ve `_historyMessageToRecord` |
| `node whatsapp-gateway/tests/test-view-once-extraction.mjs` | **0** | **PASS** | 14 ayrı senaryoda zarf açma, caption koruma, stub tespiti ve preview text normalizasyonu |
| `cd whatsapp-gateway && npm test` | **0** | **PASS** | 50+ dosya ve yüzlerce test içeren tam gateway regresyon paketi (auth, lifecycle, media download, timeout, actions) |

### Gerçek Komut Çıktıları
```text
$ node whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs
Testing inbound View Once ingestion contracts with companion key hints...
{"level":30,"time":1794130054775,"component":"whatsapp-diagnostics","event":"session_registry_initialized","in_memory_sessions":0,"persisted_session_directories":0,"restored_sessions":0,"msg":"session_registry_initialized"}
✅ Inbound View Once ingestion contracts verified successfully!
(Exit code: 0)

$ node whatsapp-gateway/tests/test-view-once-extraction.mjs
Testing isViewOnceMessage, classifyMessageType and view-once formatting...
✅ All view-once gateway tests passed successfully!
(Exit code: 0)

$ cd whatsapp-gateway && npm test
...
Avatar URL expiry regression: PASS (13 checks)
[test-gateway-auth] fail-closed REST/WS authentication passed
PASS: 13 issue-fix gateway checks
Group avatar fetch verification: PASS (3 checks)
Archive state contract verification: PASS (8 checks)
Bulk seq pagination contract: PASS (8 checks)
[test-unread-count-progression] ALL ASSERTIONS PASSED!
[test-history-resilience] ALL 5 tests passed successfully!
[test-pending-notifications-sync] ALL checks passed successfully!
[test-post-qr-sync-state-machine] Starting Phase 14 comprehensive state machine test suite...
✓ Scenario 1-14 PASS
Initial sync front-trim proof: PASS (7 checks)
--- ALL WHATSAPP GATEWAY MESSAGE ACTIONS CONTRACT TESTS PASSED! ---
[test-media-store-integrity] 65 assertions passed
[test-media-store-543] 59 assertions passed
[test-media-routes-543] 40 assertions passed
✔ Test A-H Media Pipeline Hardening PASS
✔ Scenario 1-14 Native Baileys Lifecycle PASS
(Exit code: 0)
```

---

## 4. Git Branch, HEAD ve Çalışma Ağacı Durumu

- **Branch:** `main`
- **HEAD Commit:** `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c`
- **Çalışma Ağacı Durumu (`git status --short`):**
  ```text
   M backend/app/services/whatsapp/orchestration/events.py
   M backend/app/services/whatsapp/orchestration/messaging.py
   M backend/app/services/whatsapp/preview_normalization.py
   M backend/app/services/whatsapp/repositories/messages.py
   M frontend/scripts/verify-whatsapp-dom.mjs
   M frontend/scripts/verify-whatsapp-logic.mjs
   M frontend/src/features/whatsapp/components/ChatBubble.tsx
   M frontend/src/locales/en.ts
   M frontend/src/locales/tr.ts
   M frontend/src/pages/WhatsAppHubPage.tsx
   M whatsapp-gateway/src/messages/message-classifier.js
   M whatsapp-gateway/src/session-manager.js
   M whatsapp-gateway/src/utils/whatsapp-formatting.js
   M whatsapp-gateway/tests/test-view-once-extraction.mjs
  ?? backend/tests/test_view_once_revoke_tombstone.py
  ?? reports/whatsapp-view-once-production-live-acceptance.md
  ?? reports/whatsapp-view-once-revoke-fix-report.md
  ?? reports/whatsapp-view-once-revoke-predeploy-review.md
  ?? reports/whatsapp-view-once-revoke-final-test-closure.md
  ?? whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs
  ```
- **Önceki Değişikliklerin Korunması:**
  Backend'deki tüm savepoint ve tombstone düzeltmeleri, Frontend'deki ChatBubble ve WebSocket unlisted message revoke güncellemeleri, Gateway'deki companion key.isViewOnce algılama mantığı eksiksiz ve bozulmadan korunmaktadır.

---

## 5. Nihai Karar

### **`PASS`**

Tüm testler yeşildir, açıkta kalan hiçbir tutarsızlık notu veya hata kalmamıştır. Sistem production dağıtımına bütünüyle hazırdır.

> [!IMPORTANT]
> **Production Güvenlik Sınırı:** Talimat gereği bu aşamada **hiçbir commit oluşturulmamış, `git push` yapılmamış ve production ortamına deploy edilmemiştir**.
> Production ortamına dağıtım (`bash scripts/deploy/release.sh`) için kullanıcının açık yetkilendirmesi beklenmektedir.
