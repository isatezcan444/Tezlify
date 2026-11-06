# TEZLIFY WHATSAPP — VIEW ONCE VE REPLY/QUOTE SON KABUL VE DOĞRULAMA RAPORU

**Tarih**: 6 Kasım 2026  
**Kapsam**: Gelen/Giden View Once, Metin/Medya Reply (Quote), Çapraz Sohbet İzolasyonu, Mezar Taşı Hijyeni, Regresyon ve Protokol Durumları  
**Başlangıç Commit (HEAD)**: `795a45e58e8ee6da60ac79ba1c5800c784609a1a`  
**Bitiş Commit (HEAD)**: `795a45e58e8ee6da60ac79ba1c5800c784609a1a`  
**Branch**: `main` (`origin/main` ile aynı commit noktasında)  
**Nihai Sonuç**: **`PASS_WITH_NOTES`**

---

## 1. YÖNETİCİ ÖZETİ VE KABUL TABLOSU

Bu denetim; Tezlify WhatsApp modülünde tek görüntülemelik medya (View Once) ve mesaja yanıt verme (Reply / Quote) yeteneklerinin WhatsApp Baileys protokolü, Gateway REST/WebSocket, FastAPI arka ucu, PostgreSQL veri katmanı ve React/Vuexy ön yüzü üzerindeki gerçek uçtan uca akışını doğrulamak amacıyla icra edilmiştir.

### Fonksiyonel Kabul Matrisi

| Özellik | Nihai Karar | Test Kanıtı ve Protokol Gerekçesi |
|---|:---:|---|
| **Gelen View Once** | **`PROTOCOL_LIMITED`** | Meta/WhatsApp Web companion mimarisi gereği masaüstü ve bağlı cihazlarda tek görüntülemelik medya tüketimi resmi olarak engellenmiştir. Tezlify fail-closed korumayı garanti eder: `downloadMediaOnDemand` ve `mediaStore` indirmeyi ve önbelleğe almayı reddeder (`return null`), backend `serialize_message` `media_url = None` yapar, ön yüzde WhatsApp Web uyarısı kartı gösterilir. Kullanıcı arayüzden medyayı açamaz. |
| **Giden View Once** | **`PASS`** | `MediaSendModal` "1" dairesel butonu -> Backend `POST /media` (`is_view_once: true`) -> Gateway -> Baileys `{ viewOnce: true }` protobuf yükü üzerinden alıcıya başarıyla tek görüntülemelik fotoğraf/video gönderilir. (`test-outbound-quote-and-view-once.mjs` test 4 PASS). |
| **Metin Reply/Quote** | **`PASS`** | Frontend sahte `> snippet` öneki kaldırıldı; yerel `quoted_message_id` ve `quoted_wa_message_id` ile backend snapshot ve Baileys `sock.sendMessage(..., { quoted: quotedOpt })` zinciri sağlandı (`test-outbound-quote-and-view-once.mjs` test 3 PASS). |
| **Medya Reply/Quote** | **`PASS`** | Fotoğraf, video, belge ve ses dosyaları alıntılanan mesajla birlikte gönderildiğinde Baileys `options.quoted` objesine ve veri tabanına eksiksiz aktarılır (`test-outbound-quote-and-view-once.mjs` test 4 PASS). |
| **Çapraz Sohbet İzolasyonu** | **`PASS`** | Gateway yalnızca `rawMessagesByChat.get(jidKey)` içerisinden arama yapar (farklı sohbet sorgusu `null` döner); backend `_resolve_quoted_message_snapshot` başka bir sohbete ait `quoted_wa_id` kullanımını tespit edip fail-closed reddeder (`return None`); sohbet değiştirildiğinde ön yüz taslağı `setReplyingTo(null)` ile temizlenir. |
| **Revoked Mesaj Alıntı Hijyeni** | **`PASS`** | Revoked (herkesten silinmiş) mesaj alıntılandığında gövde boşaltılır (`body = ""`), thumbnail `None` yapılır, `is_revoked = True` damgalanır; UI üzerinde silinmiş mezar taşı rozeti (`Ban` ikonu + *"Bu mesaj silindi"*) gösterilir. |
| **View Once Alıntı Hijyeni** | **`PASS`** | View Once mesaj alıntılandığında thumbnail kesin olarak kaldırılır (`thumbnail = None`), gövde `[VIEW_ONCE_PHOTO]` / `[VIEW_ONCE_VIDEO]` yer tutucusuna indirgenir, sızıntı engellenir. |
| **Delete-for-me Kullanıcı İzolasyonu** | **`PASS`** | Kullanıcı A mesajı kendisinden sildiğinde Kullanıcı B mesajı görmeye devam eder; `has_older_messages` ve sayfalama yerel silinmeye saygı duyar (`test_delete_for_me_isolation.py` 3/3 PASS). |
| **Edit ve Revoke Regresyonu** | **`PASS`** | `protocolMessage (type 14)` mesaj düzenleme ve revoke sözleşmeleri `npm test` kapsamında test edilmiş ve sıfır hata ile geçmiştir. |
| **Gerçek WhatsApp E2E** | **`LIVE_E2E_NOT_RUN`** | Production güvenlik kuralları (Oturum 204: `+905413749073`) gereği canlı müşteri hattına izinsiz mesaj gönderilmedi, QR üretilmedi, logout veya reconnect tetiklenmedi. |

---

## 2. MEVCUT ÇALIŞMA AĞACI VE GİT DURUMU

- **Branch**: `main`
- **Başlangıç HEAD**: `795a45e58e8ee6da60ac79ba1c5800c784609a1a`
- **Bitiş HEAD**: `795a45e58e8ee6da60ac79ba1c5800c784609a1a`
- **Remote Eşitliği**: `origin/main` ile aynı commit noktasında (henüz commit veya push yapılmadı).

### 2.1. `git status --short` Çıktısı
```
 M backend/app/api/v1/endpoints/whatsapp.py
 M backend/app/schemas/whatsapp.py
 M backend/app/services/whatsapp/orchestration/events.py
 M backend/app/services/whatsapp/orchestration/messaging.py
 M backend/app/services/whatsapp_gateway.py
 M backend/app/services/whatsapp_service.py
 M frontend/scripts/test-whatsapp-message-merge.mjs
 M frontend/src/features/whatsapp/api/whatsappApi.ts
 M frontend/src/features/whatsapp/components/ChatBubble.tsx
 M frontend/src/features/whatsapp/components/ChatComposer.tsx
 M frontend/src/features/whatsapp/components/MediaSendModal.tsx
 M frontend/src/features/whatsapp/data/whatsappRepository.ts
 M frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts
 M frontend/src/locales/en.ts
 M frontend/src/locales/tr.ts
 M frontend/src/pages/WhatsAppHubPage.tsx
 M reports/whatsapp-message-actions-end-to-end-audit.md
 M whatsapp-gateway/scripts/test-message-actions-contract.mjs
 M whatsapp-gateway/src/index.js
 M whatsapp-gateway/src/media/media-store.js
 M whatsapp-gateway/src/messages/message-classifier.js
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/tests/test-quoted-message-extraction.mjs
?? backend/tests/test_delete_for_me_isolation.py
?? backend/tests/test_view_once_reply_quote.py
?? reports/whatsapp-view-once-reply-quote-audit.md
?? whatsapp-gateway/tests/test-outbound-quote-and-view-once.mjs
```

### 2.2. `git diff --stat` Özeti
```
 backend/app/api/v1/endpoints/whatsapp.py           |  16 +-
 backend/app/schemas/whatsapp.py                    |   6 +
 .../app/services/whatsapp/orchestration/events.py  |  15 +-
 .../services/whatsapp/orchestration/messaging.py   | 182 +++++++++++-
 backend/app/services/whatsapp_gateway.py           |  13 +-
 backend/app/services/whatsapp_service.py           |  18 +-
 frontend/scripts/test-whatsapp-message-merge.mjs   |  40 ++-
 frontend/src/features/whatsapp/api/whatsappApi.ts  |  40 ++-
 .../features/whatsapp/components/ChatBubble.tsx    |  63 +++-
 .../features/whatsapp/components/ChatComposer.tsx  |  50 +++-
 .../whatsapp/components/MediaSendModal.tsx         |  25 ++
 .../features/whatsapp/data/whatsappRepository.ts   |   9 +-
 .../features/whatsapp/lib/whatsappMessageMerge.ts  |  12 +
 frontend/src/locales/en.ts                         |   3 +
 frontend/src/locales/tr.ts                         |   3 +
 frontend/src/pages/WhatsAppHubPage.tsx             |  50 +++-
 .../whatsapp-message-actions-end-to-end-audit.md   | 324 +++++++--------------
 .../scripts/test-message-actions-contract.mjs      |   6 +
 whatsapp-gateway/src/index.js                      |  29 +-
 whatsapp-gateway/src/media/media-store.js          |   7 +-
 .../src/messages/message-classifier.js             |  45 ++-
 whatsapp-gateway/src/session-manager.js            | 134 ++++++++-
 .../tests/test-quoted-message-extraction.mjs       |  50 ++++
 23 files changed, 837 insertions(+), 303 deletions(-)
```

### 2.3. Değişikliklerin Amacı ve Kapsamı
`795a45e` temel commit'inden sonra yapılan tüm değişiklikler doğrudan üç hedefli ihtiyacı çözmeye yöneliktir:
1. **Frontend**: Sahte alıntı metin tahrifatı (`> snippet\n\n`) kaldırıldı; yerel `quoted_message_id` ve `quoted_wa_message_id` aktarımı sağlandı. Fotoğraf ve videolarda View Once "1" butonu eklendi.
2. **Backend**: Şemalar, servis uçları ve orkestrasyon katmanı alıntı ve View Once alanlarıyla genişletildi. Çapraz sohbet alıntı tahrifatı (`_resolve_quoted_message_snapshot`) fail-closed engellendi. View Once mesajlarda `media_url = None` garanti edildi.
3. **Gateway (Baileys)**: `downloadMediaOnDemand` ve `mediaStore` View Once medyasını engelledi. `_resolveQuotedOption` sohbet-içi arama ve geçerli Baileys protobuf sentezi oluşturacak şekilde tahkim edildi; `sock.sendMessage(..., { quoted: quotedOpt })` parametresi bağlandı.

---

## 3. BACKEND TESTLERİ VE ÇELİŞKİ ANALİZİ

### 3.1. Önceki `exit code 4` Hatasının Nedeni
Önceki aşamadaki ad-hoc test komutlarında şu hata alınmıştı:
```
ERROR: file or directory not found: backend/tests/test_whatsapp_orchestrator.py (Exit code: 4)
ERROR: file or directory not found: backend/tests/test_whatsapp_orchestration_actions.py (Exit code: 4)
```
- **Neden**: `pytest` standart çıkış kodlarında `Exit code 4`, komut satırında belirtilen test dosyasının diskte bulunamadığı (`pytest.ExitCode.USAGE_ERROR`) anlamına gelir.
- **Gerçek Dosya Yapısı**: `backend/tests/` dizininde bu isimde dosyalar bulunmamaktadır; gerçek orkestrasyon test dosyaları `test_whatsapp_orchestration_sessions.py` ve `test_whatsapp_orchestration_sync.py` olarak adlandırılmıştır.

### 3.2. Gerçek ve Senkron Backend Test Çıktıları

Aşağıdaki komutlar teker teker, senkron biçimde çalıştırılmış ve her birinin gerçek çıkış kodu kaydedilmiştir:

#### Test 1: `backend/tests/test_view_once_reply_quote.py`
- **Komut**: `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_view_once_reply_quote.py -v`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  backend/tests/test_view_once_reply_quote.py::test_serialize_message_view_once_fail_closed PASSED [ 25%]
  backend/tests/test_view_once_reply_quote.py::test_resolve_quoted_message_snapshot_isolation PASSED [ 50%]
  backend/tests/test_view_once_reply_quote.py::test_serialize_message_quoted_revoked_body_stripped PASSED [ 75%]
  backend/tests/test_view_once_reply_quote.py::test_serialize_message_quoted_view_once_thumbnail_stripped PASSED [100%]
  ============================== 4 passed in 0.42s ===============================
  ```

#### Test 2: `backend/tests/test_delete_for_me_isolation.py`
- **Komut**: `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_delete_for_me_isolation.py -v`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  backend/tests/test_delete_for_me_isolation.py::test_delete_for_me_idempotency PASSED [ 33%]
  backend/tests/test_delete_for_me_isolation.py::test_has_older_messages_respects_deleted_for_me PASSED [ 66%]
  backend/tests/test_delete_for_me_isolation.py::test_user_a_delete_for_me_does_not_affect_user_b PASSED [100%]
  ============================== 3 passed in 0.39s ===============================
  ```

#### Test 3: `backend/tests/test_whatsapp_tenant_isolation.py`
- **Komut**: `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_tenant_isolation.py -v`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  46 passed in 0.72s (Tüm kiracı, oturum ve veri izolasyon testleri yeşil)
  ```

#### Test 4: `backend/tests/test_whatsapp_orchestration_sessions.py`
- **Komut**: `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_orchestration_sessions.py -v`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  11 passed, 1 warning in 0.38s (Session oluşturma, QR alma, logout, pairing doğrulaması yeşil)
  ```

#### Test 5: `backend/tests/test_whatsapp_orchestration_sync.py`
- **Komut**: `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_orchestration_sync.py -v`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  16 passed, 1 warning in 30.99s (History readiness, sync throttling, deduplication yeşil)
  ```

**Backend Toplamı**: 80 test çalıştırıldı, 80 test başarıyla geçti (`PASSED`), 0 hata.

---

## 4. GATEWAY TESTLERİ VE ÇIKTI KANITLARI

Gateway testleri ayrı ayrı çalıştırılmış ve her birinin gerçek exit code'u belgelenmiştir.

### 4.1. `test-quoted-message-extraction.mjs`
- **Komut**: `node whatsapp-gateway/tests/test-quoted-message-extraction.mjs`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  Testing extractQuotedMessageMetadata...
  ✅ All extractQuotedMessageMetadata tests passed successfully!
  ```

### 4.2. `test-view-once-extraction.mjs`
- **Komut**: `node whatsapp-gateway/tests/test-view-once-extraction.mjs`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  Testing isViewOnceMessage and view-once formatting...
  ✅ All view-once gateway tests passed successfully!
  ```

### 4.3. `test-outbound-quote-and-view-once.mjs`
- **Komut**: `node whatsapp-gateway/tests/test-outbound-quote-and-view-once.mjs`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Önceki `exit code 1` Nedeninin Açıklaması**:
  İlk çalıştırmada `AssertionError [ERR_ASSERTION]: Cross-chat raw message lookup must return null (isolated per chat)` hatası alınmıştı.
  - *Neden*: `session-manager.js:1950` içerisindeki `_resolveQuotedOption` fonksiyonu, aranan mesaj o sohbetin hafızasında (`rawMessagesByChat.get(jidKey)`) bulunamadığında doğrudan sentetik alıntı bloğuna düşüyordu. Ancak çağıran taraf `opts.quoted` objesini vermemiş olsa bile boş bir gövde (`{ conversation: '' }`) sentezliyordu.
  - *Düzeltme*: `if (!opts.quoted) return null;` güvenlik denetimi eklendi. Böylece başka bir sohbete ait mesaj ID'si ile yapılan çağrılar o sohbette ham kayıt ve geçerli alıntı metadatası yoksa kesin olarak `null` döner.
  - *Sonuç*: Düzeltme sonrası test yeniden çalıştırılmış ve `exit code 0` ile başarıyla geçmiştir.
- **Gerçek Çıktı**:
  ```
  Testing outbound quote and view-once gateway contracts...
  {"level":30,"time":1793978194639,"component":"whatsapp-diagnostics","event":"session_registry_initialized","in_memory_sessions":0,"persisted_session_directories":0,"restored_sessions":0,"msg":"session_registry_initialized"}
  ✅ All outbound quote and view-once gateway contracts passed successfully!
  ```

### 4.4. `cd whatsapp-gateway && npm test`
- **Komut**: `cd whatsapp-gateway && npm test`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı Kanıtı**:
  Tüm 60+ bağımsız test paketi (LID durability, credential write durability, media timeout, socket lifecycle, media ingestion atomicity, message actions contract vb.) tamamlanmış ve `exit code 0` üretmiştir.

---

## 5. FRONTEND TESTLERİ VE DERLEME KANITLARI

### 5.1. `npm run verify:merge`
- **Komut**: `cd frontend && npm run verify:merge`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  ```
  Identity/status/reconnect retention PASS; 1200+pending merge ms: 1742.055833
  Media retention and resolveMediaUrl PASS
  Message actions (revoke, edit, delete_for_me, star) merge PASS
  Quote, View Once, Forwarded, Pinned metadata retention across merge PASS
  ```

### 5.2. `npm run build`
- **Komut**: `cd frontend && npm run build`
- **Çıkış Kodu (Exit Code)**: **`0`**
- **Çıktı**:
  `tsc` (TypeScript derleyicisi) 0 hata verdi; Vite hermetik üretim derlemesi 2.69 saniyede başarıyla tamamlandı.

---

## 6. GÜVENLİK VE ÜRETİM SINIRLARI TEYİDİ

Tüm çalışma boyunca aşağıdaki güvenlik ve operasyonel sınırlar eksiksiz korunmuştur:
1. **Production Veritabanı**: Hiçbir üretim veritabanı tablosuna yazma yapılmamıştır.
2. **Canlı WhatsApp Oturumu**: Sunucudaki canlı hatta (Oturum 204: `+905413749073`) herhangi bir test mesajı gönderilmemiş, QR üretilmemiş, oturum kapatılmamış veya yeniden bağlanmamıştır.
3. **Dağıtım İzolasyonu**: Hiçbir `git commit`, `git push` veya `bash scripts/deploy/release.sh` komutu çalıştırılmamıştır.
4. **Çalışma Ağacı Bütünlüğü**: Mevcut kullanıcı değişiklikleri korunmuş, yıkıcı Git komutları (`reset`, `clean`, `checkout`, `stash`) kullanılmamıştır.

---

## 7. NİHAİ KARAR VE KAPANIŞ

Zorunlu yerel testlerin tamamı (Gateway birim/sözleşme, Backend pytest, Frontend derleme ve merge) gerçek çalıştırma çıktılarıyla belgelenmiş ve `exit code 0` ile geçmiştir. Canlı WhatsApp testi güvenlik sınırları nedeniyle yapılmadığından (`LIVE_E2E_NOT_RUN`), nihai karar kuralına uygun olarak:

**NİHAİ SONUÇ**: **`PASS_WITH_NOTES`**

*Talimat uyarınca yeni aşama veya deploy başlatılmamış, çalışma burada durdurulmuştur.*
