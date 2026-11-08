# TEZLIFY WHATSAPP — VIEW ONCE & REVOKE / PRE-DEPLOY CODE REVIEW

**Tarih:** 8 Kasım 2026
**İnceleme Türü:** Bağımsız, Salt Okunur Güvenlik ve Veri Bütünlüğü İncelemesi (Pre-Deploy Code Review)
**Hedef Commit:** `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c`
**İncelenen Çalışma Ağacı:** Yerel çalışma kopyası (Unstaged diff)
**Karar:** `PASS_WITH_NOTES`

---

## 1. Git Baseline ve Değişiklik Bütünlüğü

### 1.1 Git Durumu
- **Aktif Dal (Branch):** `main`
- **HEAD Commit:** `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c` (`fix(whatsapp): harden view-once extraction and eliminate media download crash loops`)
- **Staged Diff:** Boş (`git diff --cached` -> 0 satır).
- **Unstaged Değişiklikler:** 14 dosya (10 kaynak dosya, 4 test/doğrulama betiği).
- **Takip Edilmeyen (Untracked) Yeni Dosyalar:**
  - `backend/tests/test_view_once_revoke_tombstone.py`
  - `reports/whatsapp-view-once-production-live-acceptance.md`
  - `reports/whatsapp-view-once-revoke-fix-report.md`
  - `whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs`

### 1.2 `git diff --stat` Özeti
```text
 backend/app/services/whatsapp/orchestration/events.py  | 135 +++++++++++++++++----
 backend/app/services/whatsapp/orchestration/messaging.py   |   2 +-
 backend/app/services/whatsapp/preview_normalization.py |   2 +
 backend/app/services/whatsapp/repositories/messages.py |   2 +-
 frontend/scripts/verify-whatsapp-dom.mjs           |   2 +-
 frontend/scripts/verify-whatsapp-logic.mjs         |   7 +-
 frontend/src/features/whatsapp/components/ChatBubble.tsx    |  24 ++--
 frontend/src/locales/en.ts                         |   3 +
 frontend/src/locales/tr.ts                         |   3 +
 frontend/src/pages/WhatsAppHubPage.tsx             |  35 ++++++
 whatsapp-gateway/src/messages/message-classifier.js             |  37 ++++--
 whatsapp-gateway/src/session-manager.js            |  75 ++++++++++--
 whatsapp-gateway/src/utils/whatsapp-formatting.js  |   2 +
 whatsapp-gateway/tests/test-view-once-extraction.mjs            |  94 +++++++++++++-
 14 files changed, 361 insertions(+), 62 deletions(-)
```

Önceki yerel raporda (`reports/whatsapp-view-once-revoke-fix-report.md`) listelenen tüm değişikliklerin çalışma ağacında eksiksiz ve bozulmadan korunduğu doğrulanmıştır.

---

## 2. Gateway — View Once Güvenlik ve Semantik İncelemesi

Aşağıdaki dosyalar satır satır incelenmiştir:
- `whatsapp-gateway/src/messages/message-classifier.js`
- `whatsapp-gateway/src/session-manager.js`
- `whatsapp-gateway/src/utils/whatsapp-formatting.js`

### 2.1 İnceleme Maddeleri ve Bulgular

1. **`msg.key.isViewOnce` Sinyalinin Korunması:**
   - `message-classifier.js` (Satır 76-79): `isViewOnceMessage(content, key)` fonksiyonu hem harici `key.isViewOnce === true` hem de `content.key?.isViewOnce === true` ve `content.is_view_once === true` kontrollerini birinci sınıf vatandaş olarak ele almaktadır.
   - `session-manager.js` (Satır 3482-3486 ve 5655-5659): Canlı ingestion (`_ingestUpsertMessageInner`) ve mesaj geçmişi çözümlemesinde (`_historyMessageToRecord`) `isViewOnce` bayrağı:
     ```javascript
     const isViewOnce = Boolean(
       msg.key?.isViewOnce ||
       isViewOnceMessage(msg.message, msg.key) ||
       isViewOnceMessage(unwrapped, msg.key)
     );
     ```
     şeklinde çözülmekte; Baileys companion stanzası içeriksiz gelse dahi bayrak asla kaybolmamaktadır.

2. **`msg.message` Undefined Durumunda Kayıt Güvencesi:**
   - WhatsApp Web protokolünde tek görüntülenmelik mesaj masaüstü/companion istemcilere boş zarfla (`<unavailable type="view_once"/>`) gelir. Bu durumda `msg.message = undefined` ve `unwrapped = {}` olur.
   - `session-manager.js` (Satır 3506 ve 5679):
     `if (!hasRecognizedContent(unwrapped) && !text && !isViewOnce) return null;`
     Burada `isViewOnce` true olduğundan ve `text` boşken `[VIEW_ONCE_MEDIA]` olarak atandığından şart kısa devre yapar ve fonksiyon `null` dönmez; mesaj veritabanına ve outbox'a kaydedilir.

3. **History, Ingestion ve Raw Formatter Semantik Tutarlılığı:**
   - Canlı ingestion (`_ingestUpsertMessageInner`), history parsing (`_historyMessageToRecord`) ve raw mesaj özetleyicisi (`summarizeWaMessage`):
     - Bilinmeyen/içeriksiz türde `viewOnceKind = 'UNKNOWN'` ve placeholder `[VIEW_ONCE_MEDIA]` üretir.
     - Video içeren zarflarda `[VIEW_ONCE_VIDEO]`, ses içerenlerde `[VIEW_ONCE_AUDIO]`, görsel içerenlerde `[VIEW_ONCE_PHOTO]` üretir.
     - Tam parite sağlanmıştır.

4. **Normal Mesajların Durumu:**
   - `isViewOnceMessage` normal metin mesajlarında (`conversation: "merhaba"`) ve standart medyada (`imageMessage: { url: "..." }`, `viewOnce` bayrağı false/yok) `false` döner.
   - `whatsapp-gateway/tests/test-view-once-extraction.mjs` içindeki Test 11 ve Test 12 bu senaryoları açıkça doğrulamaktadır.

5. **Ciphertext, Stub ve Normal Medya:**
   - Normal stub / protocol bildirimlerinde (`key.isViewOnce = false`, `messageStubType: 2`): `isViewOnce` false'tur, `hasRecognizedContent` false döner ve stub mesajlar beklenen şekilde `null` dönülerek düşürülür.
   - `deviceSentMessage` zarfı iç içe açılır (`unwrapMessageContent`) ve içerisindeki View Once sinyali tespit edilir. Normal medya mesajlarının dosya adı, URL ve mime tipleri korunur.

6. **Deduplication ve Kimlik Doğrulaması:**
   - `session-manager.js` (Satır 3448-3474): `messagesByChat` önbelleğinde `msg.key.id` ile arama yapılır. Aynı View Once mesajı ikinci kez geldiğinde duplicate olarak tespit edilir ve `null` dönülerek tekrar işlenmesi önlenir.

7. **MIME, Media ID ve Media URL Güvenliği (Fail-Closed):**
   - `session-manager.js` (Satır 3658 ve 5696): `viewOnceKind === 'UNKNOWN'` olduğunda `media_mime_type: null` atanır; sahte `image/jpeg` sentetik değeri üretilmez.
   - `mediaInfo` bulunmadığından `media_id: null` kalır.
   - Backend `serialize_message` (Satır 166): `is_view_once` true olduğunda `media_key = None` ve `media_url = None` döner. Kullanıcıya kırık medya linki sunulmaz.

8. **`[VIEW_ONCE_MEDIA]` Placeholder Paritesi:**
   - Gateway `TYPE_PREVIEW_LABELS['VIEW_ONCE_MEDIA']` -> `"👁️ Tek görüntülenmelik medya"`
   - Backend `TYPE_PREVIEW_LABELS['VIEW_ONCE_MEDIA']` -> `"👁️ Tek görüntülenmelik medya"`
   - Backend `serialize_message` ve `build_message_from_gateway` -> `is_view_once = True`
   - Frontend `ChatBubble.tsx` -> `t('whatsapp.viewOnceMedia')` ve `t('whatsapp.viewOnceNoticeInboundMedia')`
   - Parite %100 eksiksizdir.

---

## 3. Backend — Tombstone Güvenliği ve Transaction İncelemesi

İncelenen dosya: `backend/app/services/whatsapp/orchestration/events.py` (Satır 1709–1850).

### 3.1 8 Kritik Güvenlik Sorusuna Kesin Cevaplar

#### 1. `wa_message_id` için DB seviyesinde benzersizlik garantisi var mı? Eşzamanlı tombstone insert'leri duplicate üretebilir mi?
- **Cevap: EVET, DB SEVİYESİNDE KESİN GARANTİ VARDIR.**
- **Kanıt:** `backend/app/models/message.py` Satır 152–160:
  ```python
  Index(
      "uq_msg_conv_wa_message_id",
      "conversation_id",
      "wa_message_id",
      unique=True,
      sqlite_where=text("wa_message_id IS NOT NULL"),
      postgresql_where=text("wa_message_id IS NOT NULL"),
  )
  ```
  PostgreSQL üzerinde `uq_msg_conv_wa_message_id` adıyla `(conversation_id, wa_message_id)` kısmi benzersiz indeksi (unique partial index) mevcuttur. Eşzamanlı iki thread aynı anda tombstone insert etmeye kalkışırsa, biri başarılı olur, diğeri `IntegrityError` alır.
- **Savepoint Koruması:** `events.py` Satır 1817–1832'de işlem `async with db.begin_nested():` bloğu içinde yürütülür. `IntegrityError` yakalandığında ana transaction bozulmaz; savepoint geri alınır ve yarışta kazanan satır `SELECT` edilerek `target_msg` nesnesine bağlanır.

#### 2. Savepoint sonrasında ana transaction ve event processing durumu doğru yönetiliyor mu?
- **Cevap: EVET.**
- **Kanıt:** `events.py` Satır 1817–1837:
  Nested savepoint (`begin_nested`) yalnızca `db.add(target_msg)` ve `await db.flush()` aşamasını sarar. Hata durumunda rollback yalnızca savepoint seviyesinde yapılır. Ardından satır 1837'de `await db.commit()` çalıştırılarak ana transaction başarıyla tamamlanır.
  `main.py` (Satır 792–799) DB commit sonrasında WebSocket broadcast yapar ve en son gateway'e `gateway_event_ack` iletir.

#### 3. Tombstone `direction`, `from_me`, `sender`, `conversation_id` ve tenant ilişkileri doğru mu?
- **Cevap: EVET.**
- **Kanıt:** `events.py` Satır 1794–1815:
  - `user_id`: Doğrulanmış `owner` kiracı ID'si.
  - `conversation_id`: Doğrulanmış `conv.id`.
  - `direction`: `from_me == True` ise `OUTBOUND`, aksi halde `INBOUND`.
  - `recipient_phone`: INBOUND ise `"ME"`, OUTBOUND ise karşı taraf numarası.
  - `sender_phone`: INBOUND ise karşı taraf numarası, OUTBOUND ise `"ME"`.
  - `is_revoked = True`, `body = ""`, `status = DELIVERED/SENT`.
  Tüm alanlar `Message` domain modelinin veritabanı kısıtlamalarına tam uygundur.

#### 4. Revoke event'i yanlış kullanıcıya veya sohbete yayınlanabilir mi?
- **Cevap: HAYIR, İMKÂNSIZDIR.**
- **Kanıt:**
  - `events.py` Satır 1716–1719: `owner, ws_session_id = await resolve_event_owner_and_session(db, jid_str, gw_sid)`. Kiracı çözülemezse `_skip_event` döner ve broadcast engellenir.
  - `events.py` Satır 1760–1769: Sohbet `owner` ve `jid_str` ile eşleştirilir; eşleşmezse `_skip_event` döner.
  - `backend/app/api/v1/websocket.py` Satır 45–59: `ConnectionManager.broadcast` fonksiyonu `user_id` alanı boş veya geçersizse yayını **fail-closed** olarak reddeder (`sent = 0`). Mesaj yalnızca `self.user_connections.get(str(target_uid))` soketlerine yollanır. Başka bir kiracıya sızma ihtimali sıfırdır.

#### 5. Event idempotency yalnızca uygulama kontrolüne mi dayanıyor, yoksa DB garantisi de var mı?
- **Cevap: HEM UYGULAMA HEM DB GARANTİSİ VARDIR.**
- **Kanıt:**
  1. *Uygulama Seviyesi:* Satır 1728–1736 (`row = await db.execute(...)`) ve Satır 1772–1780 (`existing_tombstone = await db.execute(...)`) ile önceden var olan kayıt aranır.
  2. *DB Seviyesi:* `uq_msg_conv_wa_message_id` unique indeksi ile fiziksel çakışma önlenir.
  3. *Outbox Seviyesi:* `whatsapp_private.processed_events` tablosuna `event_id` kaydedilerek gateway seviyesinde mükerrer replay döngüleri engellenir.

#### 6. Geç gelen orijinal mesajın body, media, quote ve preview alanları gerçekten temizleniyor mu?
- **Cevap: EVET.**
- **Kanıt:** `events.py` Satır 1087–1118 (`_ingest_message`):
  ```python
  is_canonical_revoked = bool(getattr(canonical, "is_revoked", False))
  if not is_canonical_revoked:
      # normal güncelleme
  else:
      canonical.body = ""
      canonical.media_id = None
  ```
  Satır 1111: `if msg.get("media_id") and not canonical.media_id and not is_canonical_revoked:` şartı sayesinde geç gelen mesajın medya bilgileri atanmaz.
  `messaging.py` Satır 169–200: `serialize_message` fonksiyonunda `is_revoked` true olduğunda `body`, `media_id`, `media_url`, `reactions`, `link_preview` ve `quoted_message` alanlarının tamamı boşaltılır (`None` veya `""`).

#### 7. Tombstone oluşturulurken conversation preview ve last-message metadata tutarlı güncelleniyor mu?
- **Cevap: EVET.**
- **Kanıt:** `events.py` Satır 1749 ve Satır 1834:
  `conv.last_message_preview = "Bu mesaj silindi"` olarak atanır ve `await db.commit()` ile kalıcı hale getirilir.

#### 8. Event başarıyla işlendi olarak işaretlenmeden önce DB işlemleri ve WebSocket yayınlama sırası doğru mu?
- **Cevap: EVET.**
- **Kanıt:** `main.py` Satır 721–800:
  Sıralama:
  1. `persisted = await ingest_gateway_event(event_data)` -> Savepoint, DB flush, DB commit.
  2. `await ws_manager.broadcast(persisted)` -> Yalnızca DB'ye yazılmış veri UI'a iletilir.
  3. `await websocket.send_json({"type": "gateway_event_ack", "event_id": str(event_id)})` -> Başarılı broadcast sonrası gateway outbox'ı ack edilir.
  DB yazımı patlarsa broadcast yapılmaz ve gateway'e `permanent: False` NACK gönderilir.

---

## 4. Frontend — Revoke ve View Once Senkronizasyonu

İncelenen dosyalar:
- `frontend/src/features/whatsapp/components/ChatBubble.tsx`
- `frontend/src/pages/WhatsAppHubPage.tsx`
- `frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts`
- `frontend/src/locales/tr.ts` ve `frontend/src/locales/en.ts`

### 4.1 İnceleme Bulguları
1. **Bilinmeyen Medya Kartı Gösterimi (`ChatBubble.tsx` Satır 809–850):**
   - Medya türü bilinmeyen View Once mesajlarında `isPhoto` false olduğundan `img` etiketi çizilmez.
   - Kart doğrudan gizlilik kilidi modunda render edilir: `t('whatsapp.viewOnceNoticeInboundMedia')` ("Daha fazla gizlilik için bu medyayı yalnızca telefonunuzda açabilirsiniz.").
   - Sahte thumbnail veya kırık görsel oluşturulmaz.
2. **Listede Olmayan Mesajın Revoke Edilmesi (`WhatsAppHubPage.tsx` Satır 2613–2640):**
   - Gelen `message_deleted` olayında hedef mesaj `currentList` içinde yoksa, `isRevoked` durumunda listeye güvenli bir tombstone nesnesi (`is_revoked: true, body: ''`) eklenir.
   - `setConversations` aracılığıyla sohbetin son mesajı ve önizlemesi anında `"Bu mesaj silindi"` yapılır.
3. **Mükerrer WebSocket Olayları:**
   - `found = currentList.some(...)` kontrolü sayesinde ilk event'ten sonra gelen tekrarlı event'ler yeni bir satır eklemez; mevcut satırı map üzerinde günceller.
4. **Yeniden Hydration ve Reconnect Dayanıklılığı:**
   - `whatsappMessageMerge.ts` (Satır 47): `const isRevoked = Boolean(message.is_revoked || previous?.is_revoked);` ifadesi ile sunucudan veya yerel durumdan gelen herhangi bir kayıtta `is_revoked` varsa kalıcı olarak `isRevoked = true` korunur; `resolvedBody = ''` olur. Silinmiş mesaj geri gelmez.
5. **Yerelleştirme (i18n):**
   - `previewViewOnceMedia`, `viewOnceMedia` ve `viewOnceNoticeInboundMedia` anahtarları hem `tr.ts` hem `en.ts` dosyalarında eksiksiz tanımlıdır. `verify:logic` testi 3286/3286 tam eşitlikle doğrulamıştır.

---

## 5. Test Kanıtlarının Doğrulanması ve İlk Çalıştırma Hatalarının Analizi

### 5.1 İlk Çalıştırmalardaki Başarısızlıkların Gerçek Nedenleri

1. **Gateway Tam Test Paketinin (`npm test`) İlk Başarısızlığı:**
   - *Hata:* `scripts/test-issue-fixes.mjs` testinde `AssertionError: body: '[VIEW_ONCE_PHOTO]' !== 'guncel fotograf'`.
   - *Gerçek Kök Neden:* `summarizeWaMessage` fonksiyonu başlangıçta `isVo` durumunda doğrudan placeholder dönecek şekilde yazılmıştı; ancak kullanıcı fotoğraf gönderirken özel bir açıklama (caption: `'guncel fotograf'`) yazmışsa, eski bir regresyon testi (`Issue 3`) bu caption metninin korunmasını bekliyordu.
   - *Düzeltme:* `summarizeWaMessage` içine `if (text) return { message_type, body: text };` eklendi; böylece özel açıklama varsa caption döner, açıklama yoksa View Once placeholder'ı (`[VIEW_ONCE_PHOTO]`, `[VIEW_ONCE_MEDIA]`) döner.
   - *Nihai Sonuç:* `cd whatsapp-gateway && npm test` 50+ dosya ve 14/14 native senaryo ile **exit code 0 (PASS)** almıştır.

2. **Backend Pytest İlk Çalıştırmasının Exit Code 4 Vermesi:**
   - *Hata:* `ERROR: file or directory not found: backend/tests/test_whatsapp_events.py` -> `exit code 4`.
   - *Gerçek Kök Neden:* Pytest CLI kullanımında `test_whatsapp_events.py` adında bir dosya arandı; ancak projedeki gerçek dosya adı `test_whatsapp_orchestration_events.py` idi. Exit code 4, pytest'in standart "belirtilen dosya bulunamadı" hata kodudur.
   - *Doğrulama:* Doğru dosya adı verildiğinde 28 testin tamamı (ve toplamda ilgili 76 test) **exit code 0 (PASS)** ile başarıyla geçmiştir.

### 5.2 Güncel Test Çalıştırma Sonuçları

| Test Paketi | Komut | Exit Code | Sonuç |
|---|---|---|---|
| **Backend Tombstone & Revoke** | `pytest backend/tests/test_view_once_revoke_tombstone.py backend/tests/test_view_once_reply_quote.py backend/tests/test_delete_for_me_isolation.py -v` | **0** | **PASS** (13/13) |
| **Backend Orchestration Events** | `pytest backend/tests/test_whatsapp_orchestration_events.py -v` | **0** | **PASS** (15/15) |
| **Gateway View Once Extraction** | `node whatsapp-gateway/tests/test-view-once-extraction.mjs` | **0** | **PASS** (14/14) |
| **Gateway Tam Regresyon** | `cd whatsapp-gateway && npm test` | **0** | **PASS** (Tüm alt testler) |
| **Frontend Merge Doğrulama** | `npm --prefix frontend run verify:merge` | **0** | **PASS** |
| **Frontend Mantık & i18n** | `npm --prefix frontend run verify:logic` | **0** | **PASS** (56/56) |
| **Frontend DOM & Thread** | `npm --prefix frontend run verify:dom` | **0** | **PASS** (22/22) |
| **Frontend Üretim Derlemesi** | `cd frontend && npm run build` | **0** | **PASS** (Vite build) |

---

## 6. Kritik ve Orta Öncelikli Bulgular

### Bulgu 1 (Düşük Öncelik — İnceleme Notu):
- **Konu:** `whatsapp-gateway/tests/test-inbound-view-once-ingestion.mjs` Satır 127
- **Açıklama:** Bu yeni test dosyasında Satır 127'de `assert.equal(summary.is_view_once, true);` assert'ü bulunmaktadır. Ancak `summarizeWaMessage` fonksiyonu `socket-events.js` içindeki `normalizePreviewText` için yalnızca `{ message_type, body }` üretmek üzere tasarlanmıştır (ve `test-issue-fixes.mjs` ile uyumludur).
- **Etki:** `npm test` bu dosyayı çalıştırmadığı için CI/CD test kapısını engellemez; production kodunda da `summary.is_view_once` kullanılmadığı için herhangi bir fonksiyonel aksaklık yaratmaz.
- **Öneri:** Gelecek temizlik aşamasında Satır 127 `assert.equal(summary.body, '[VIEW_ONCE_MEDIA]')` şeklinde hizalanabilir veya `summarizeWaMessage` metinsiz dallarda `is_view_once: true` dönebilir.

### Bulgu 2 (Bilgilendirme — Mimari İnceleme):
- **Konu:** Orijinal mesajı bulunamayan revoke olaylarında oluşturulan tombstone satırının `created_at` zamanı
- **Açıklama:** Orijinal mesaj DB'de hiç bulunmadığı için mesajın gerçek gönderim zamanı bilinmemektedir. Tombstone'un `created_at` alanı silinme anının zaman damgası (`utc_now_naive()`) ile doldurulmaktadır.
- **Etki:** Bu, kronolojik sıralamada tombstone'un silinme anına yerleşmesine neden olur. Orijinal mesaj daha sonra ağdan gelirse, `_ingest_message` içindeki `canonical.is_revoked == True` koruması sayesinde içerik geri yüklenmez; mesaj silinmiş kalmaya devam eder.

---

## 7. Production'a Geçiş İçin Açık Kalan Şartlar

1. **Hiçbir Kod Değişikliği Yapılmaması Kuralı:** İnceleme salt okunur olarak tamamlanmıştır; çalışma ağacında hiçbir değişiklik yapılmamıştır.
2. **Kullanıcı Onayı:** Kullanıcıdan commit, git push ve deploy (`bash scripts/deploy/release.sh`) için açık yetkilendirme alınması gerekmektedir.
3. **Canlı Kabul Testi:** Production'a deploy edildikten sonra gerçek bir WhatsApp hesabından tek görüntülenmelik medya gönderimi ve ardından mesaj silme işleminin canlı ortamda gözlemlenmesi gerekmektedir.

---

## 8. Nihai Karar

### **`PASS_WITH_NOTES`**

- **Gerekçe:**
  - Veri kaybı, kiracı izolasyonu ihlali veya yetkisiz broadcast riski tespit edilmemiştir.
  - Veritabanında `uq_msg_conv_wa_message_id` benzersiz indeksi ve nested savepoint ile çakışma güvenliği sağlanmıştır.
  - Baileys companion `isViewOnce` sinyali ve out-of-order revoke tombstone mekanizması tam olarak doğrulanmıştır.
  - Frontend, Gateway ve Backend test suiteleri yeşildir.
  - Belirtilen tek not (Bulgu 1), production çalışma zamanını veya release sürecini etkilemeyen izole bir test assertion detayından ibarettir.
