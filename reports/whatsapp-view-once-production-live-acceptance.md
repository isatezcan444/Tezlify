# TEZLIFY WHATSAPP — VIEW ONCE PRODUCTION LIVE ACCEPTANCE & ROOT CAUSE INVESTIGATION RAPORU

**Tarih / Saat:** 2026-11-08 00:45 (UTC+3) / 2026-11-07 21:45 (UTC)
**Production Commit:** `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c`
**Test Türü:** Canlı Üretim Ortamı (Oracle Cloud) — Gerçek Canlı WhatsApp View Once Mesajı & Silme (Revoke) E2E Denetimi
**Nihai Canlı Kabul Kararı:** **`FAIL`** (Gerçek canlı kullanımda hem tek görüntülemelik mesaj hem de ardından gelen silme işlemi arayüzde başarısız olmuştur)

---

## 1. Yönetici Özeti (Executive Summary)

Kullanıcı kendi fiziksel telefonundan Tezlify WhatsApp hesabının bağlı olduğu bir sohbete (Grup: `"3Hacker"`) tek görüntülemelik (View Once) bir fotoğraf göndermiş, fotoğraf Tezlify arayüzünde görüntülenmemiş; ardından kullanıcı mesajı WhatsApp üzerinden herkes için silmiş (revoke), ancak silme olayı da Tezlify arayüzüne yansımamıştır.

Bu denetimde, üretim ortamındaki container'lar yeniden başlatılmadan, session'a dokunulmadan, veritabanında hiçbir veri değişikliği yapılmadan (salt-okunur adli bilişim analiziyle); Baileys kütüphanesi, Gateway in-memory saklama alanı, şifreli `whatsapp_private.event_outbox` tablosu, Backend event tüketici zinciri, PostgreSQL `messages` tablosu, WebSocket yayın köprüsü ve Frontend `ChatBubble` / mesaj birleştirme katmanları uçtan uca incelenmiştir.

### Temel Bulgular:
1. **Canlı Kabul Kararı:** **`FAIL`**. `9cf91bf` commit'inde yapılan View Once iyileştirmesi birim testlerde geçse de, gerçek WhatsApp Multi-Device protokolünün companion (eşlik eden web istemcisi) cihazlarına gönderdiği ham stanza yapısı nedeniyle canlıda **başarısız olmuştur**.
2. **View Once Fotoğrafının Kaybolma Noktası (Layer 2 - Gateway Ingestion):**
   - WhatsApp Multi-Device protokolünde, gizlilik kısıtı gereği View Once medya anahtarları eşlik eden istemcilere (Baileys web oturumu) aktarılmaz; bunun yerine `<unavailable type="view_once"/>` formatında şifresiz/içeriksiz bir stanza iletilir.
   - Baileys (`decode-wa-message.js:224`) bu stanzayı aldığında `fullMessage.key.isViewOnce = true` bayrağını set eder, ancak `fullMessage.message` nesnesi tanımsız (`undefined`) kalır.
   - Gateway `_ingestUpsertMessageInner` akışında `isViewOnceMessage(msg.message)` ve `isViewOnceMessage(unwrapped)` kontrol edilmekte, ancak `msg.key?.isViewOnce` bayrağı **hiç kontrol edilmemektedir**.
   - `msg.message` boş olduğu için `hasRecognizedContent(unwrapped)` `false` dönmüş, `text` boş kalmış ve line 3487'deki `if (!hasRecognizedContent(unwrapped) && !text && !isViewOnce) return null;` satırı mesajı **sessizce çöpe atmıştır**.
   - Sonuç olarak mesaj RAM havuzuna alınmamış, `event_outbox`'a yazılmamış ve Backend'e hiç iletilmemiştir.
3. **Revoke (Silme) Olayının Kaybolma Noktası (Layer 6 - Backend Ingestion):**
   - Kullanıcı mesajı sildiğinde WhatsApp sunucusu `protocolMessage (REVOKE)` stanzasını başarıyla göndermiştir.
   - Baileys ve Gateway revoke olayını doğru yakalamış, `whatsapp_private.event_outbox` tablosuna SEQ `290813` olarak `message_deleted` olayı (`wa_message_id: 3A3722FDB1BAA33AB219`, `event_id: 4ffa9f3c-8988-423a-95d7-833c09713945`) başarıyla kaydedilmiş ve Backend'e teslim edilmiştir.
   - Ancak Backend `_ingest_message_deleted` (`events.py:1733`), veritabanında hedef `wa_message_id`'yi aradığında, orijinal View Once mesajı Gateway tarafından ilk etapta çöpe atıldığı için veritabanında kaydını bulamamıştır.
   - Backend `_skip_event` çağırarak olayı atlamış; line 3234'te `return None` dönerek WebSocket üzerinden Frontend'e **hiçbir yayın yapmamıştır**.
   - Böylece silme olayı da arayüze ulaşamamış ve sessizce kaybolmuştur.

---

## 2. Test Öncesi Üretim Sağlık & Bütünlük Kontrolleri

Tüm inceleme adımları üretim ortamında salt-okunur olarak yürütülmüştür:

| Bileşen / Kontrol | Beklenen | Ölçülen Değer (Canlı) | Durum |
| :--- | :--- | :--- | :--- |
| **`.deployed-commit`** | `9cf91bf` | `9cf91bf9a1deaffa60a5b9f66c8c82bcbe29df6c` | **PASS** |
| **Git Head (`/opt/tezlify`)** | `9cf91bf` | `9cf91bf fix(whatsapp): handle View Once media state...` | **PASS** |
| **`tezlify-backend`** | healthy | Up 25 minutes (healthy) | **PASS** |
| **`tezlify-gateway`** | healthy | Up 25 minutes (healthy) | **PASS** |
| **`tezlify-db`** | healthy | Up 5 weeks (healthy) | **PASS** |
| **`tezlify-caddy`** | healthy | Up 3 weeks (healthy) | **PASS** |
| **Gateway Session Durumu** | connected: 1, pending_qr: 0 | `connected: 1, pending_qr: 0, auto_restore: true` | **PASS** |
| **DB Mesaj Sayısı** | Stabil | 1.238 kayıt | **PASS** |
| **Hedef Sohbet (39353)** | Stabil | 153 kayıt | **PASS** |

---

## 3. Test Edilen Mesajın Adli Bilişim & Korelasyon Kanıtları

Kullanıcının gönderdiği View Once mesajı ve ardından gerçekleştirdiği silme işlemi, veritabanı ve gateway loglarında kriptografik olarak çözümlenerek tespit edilmiştir:

- **Hedef Sohbet:** Grup Sohbeti `"3Hacker"`
- **Conversation ID (Yerel DB):** `39353`
- **WhatsApp JID:** `905413749073-1589570212@g.us` (Grup)
- **Kullanıcının Gönderdiği & Sildiği Mesaj ID (`wa_message_id`):** `3A3722FDB1BAA33AB219`
- **Mesaj ID Karakteristiği:** `3A...` öneki (iOS / birincil WhatsApp uygulamasından kullanıcının kendi gönderdiği mesaj formatı).
- **Revoke Olayı Outbox Sıra No (`sequence`):** `290813`
- **Revoke Event ID:** `4ffa9f3c-8988-423a-95d7-833c09713945`
- **Revoke Zamanı:** `2026-11-07 21:25:54.455 UTC` (`1794086754455` ms)
- **Çözümlenen Outbox SEQ 290813 Payload'ı:**
  ```json
  {
    "gateway_session_id": "00815dc9-c0cb-40b1-8d41-a2cf64674ec4",
    "event": "message_deleted",
    "conversation_id": "905413749073-1589570212@g.us",
    "wa_message_id": "3A3722FDB1BAA33AB219",
    "delete_type": "everyone",
    "is_revoked": true,
    "revoked_at": "2026-11-07T21:25:54.455Z",
    "event_id": "4ffa9f3c-8988-423a-95d7-833c09713945"
  }
  ```

---

## 4. Katman Katman Durum ve İnceleme Sonuçları

Aşağıdaki tablo, hem View Once mesajının gelişi hem de ardından gelen silme (revoke) olayının sistemin her katmanındaki akıbetini özetler:

| Katman | İncelenen Bileşen | View Once Mesajı | Revoke (Silme) Olayı | Açıklama |
| :--- | :--- | :---: | :---: | :--- |
| **Layer 1** | Baileys WebSocket Inbound | **PASS (Protokol)** | **PASS** | WhatsApp sunucusu View Once için `<unavailable type="view_once"/>` stanzasını iletti; Baileys `key.isViewOnce = true` set etti. Silme stanzasında `protocolMessage` başarıyla alındı. |
| **Layer 2** | Gateway Ingestion & Classifier | **FAIL** | **PASS** | Gateway `msg.key?.isViewOnce` alanını kontrol etmediği için View Once mesajını tanımsız sayıp Line 3487'de `return null` ile **çöpe attı**. Revoke stanzası ise doğru ayrıştırıldı. |
| **Layer 3** | Gateway In-Memory RAM Store | **FAIL** | **PASS** | Mesaj `messagesByChat` havuzuna hiç girmedi. Revoke olayı ise RAM store'da işlendi. |
| **Layer 4** | Gateway Durable Event Outbox | **FAIL** | **PASS** | Mesaj `event_outbox` tablosuna hiç yazılmadı (`message_new` kaydı 0). Revoke olayı SEQ `290813` olarak yazıldı. |
| **Layer 5** | Gateway → Backend WebSocket Bridge | **NOT OBSERVED** | **PASS** | Mesaj outbox'a girmediği için Backend'e hiç gönderilmedi. Revoke olayı Backend'e başarıyla iletildi. |
| **Layer 6** | Backend Ingestion & PostgreSQL | **FAIL** | **FAIL** | Orijinal mesaj DB'ye hiç gelmedi (`messages` tablosunda 0 kayıt). Revoke ise DB'de orijinal mesajı bulamadığı için `_skip_event` ile atlandı. |
| **Layer 7** | Backend WebSocket Broadcast | **NOT OBSERVED** | **FAIL** | Orijinal mesaj olmadığı için `message_new` yayınlanmadı. Revoke atlandığı için (`return None`) `message_deleted` yayını da **yapılmadı**. |
| **Layer 8** | Frontend WS & Store Merge | **NOT OBSERVED** | **NOT OBSERVED** | Backend yayın yapmadığı için Frontend hiçbir event almadı. |
| **Layer 9** | Frontend UI Render (`ChatBubble`) | **FAIL** | **FAIL** | Kullanıcı ne tek görüntülemelik kartı ne de silinmiş mesaj uyarısını arayüzde göremedi. |

---

## 5. View Once Alanlarının Uçtan Uca Takibi ve Kaybolma Mekanizması

### A. Meta / WhatsApp Protokolü ve Baileys Davranışı:
WhatsApp Multi-Device mimarisinde bir kullanıcı (veya karşı taraf) View Once fotoğraf/video gönderdiğinde:
- WhatsApp sunucusu birincil telefonlara tam şifreli medya anahtarını iletirken, eşlik eden web istemcilerine (Baileys):
  ```xml
  <message id="3A3722FDB1BAA33AB219" ...>
    <unavailable type="view_once"/>
  </message>
  ```
  şeklinde bir stanza iletir. Bu stanzada `<enc>` veya `<plaintext>` gövdesi bulunmaz.
- Baileys kütüphanesinin kaynak kodu (`/app/node_modules/@whiskeysockets/baileys/lib/Utils/decode-wa-message.js`, satır 224) bu stanzayı şöyle karşılar:
  ```javascript
  if (tag === 'unavailable' && attrs.type === 'view_once') {
      fullMessage.key.isViewOnce = true;
  }
  // ...
  // Eğer enc node'u yoksa decryptables 0 kalır:
  if (!decryptables && !fullMessage.key?.isViewOnce) {
      fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
      fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT];
  }
  ```
- Sonuç: Baileys bir `proto.Message` üretmez (`fullMessage.message = undefined`), ancak mesaj anahtarında **`fullMessage.key.isViewOnce = true`** olarak `messages.upsert` event'i fırlatır!

### B. Gateway'deki Kritik Hata (`session-manager.js`):
Gateway tarafında `_ingestUpsertMessageInner` fonksiyonu gelen mesajı ayrıştırırken:
```javascript
// session-manager.js line 3334:
const unwrapped = unwrapMessageContent(msg.message) || msg.message || {};

// session-manager.js line 3482:
const isViewOnce = isViewOnceMessage(msg.message) || isViewOnceMessage(unwrapped);
const mediaType = classifyMessageType(unwrapped);
if (isViewOnce && (!text || text.trim() === '')) {
  text = mediaType === 'VIDEO' ? '[VIEW_ONCE_VIDEO]' : (mediaType === 'AUDIO' ? '[VIEW_ONCE_AUDIO]' : '[VIEW_ONCE_PHOTO]');
}

// session-manager.js line 3487:
if (!hasRecognizedContent(unwrapped) && !text && !isViewOnce) return null;
```
**Neden çöpe atıldı?**
1. `msg.message` tanımsız (`undefined`), dolayısıyla `unwrapped` boş bir objedir (`{}`).
2. `isViewOnceMessage(msg.message)` çağrısına `undefined` gider -> `false` döner.
3. `isViewOnceMessage(unwrapped)` çağrısına `{}` gider -> `false` döner.
4. **`msg.key?.isViewOnce` değeri hiçbir yerde kontrol edilmemiştir!**
5. Dolayısıyla `isViewOnce = false` olarak kalır.
6. `hasRecognizedContent({})` fonksiyonu `false` döner.
7. `text` boş string'dir.
8. Line 3487'deki şart: `!false && !"" && !false` => `true && true && true` = **`TRUE`**!
9. Fonksiyon anında **`return null;`** çalıştırarak mesajı tamamen düşürür!

Aynı eksiklik line 5626'daki `summarizeWaMessage` / `_formatRawMessage` içinde de mevcuttur.

---

## 6. Mesaj Silme (Revoke) Olayının Backend'de Engellenme Mekanizması

Kullanıcı fotoğrafı WhatsApp uygulamasından sildiğinde gerçekleşen olay akışı:

1. **Baileys & Gateway:**
   - WhatsApp sunucusu `protocolMessage` (REVOKE) stanzası iletti: hedef `3A3722FDB1BAA33AB219`.
   - Gateway `extractProtocolMessage` ile bunu yakaladı ve `whatsapp_private.event_outbox` tablosuna SEQ `290813` olarak yazdı.
   - Gateway bu olayı Backend WebSocket köprüsüne fırlattı.
2. **Backend Tarafı (`events.py`):**
   - Backend `_ingest_message_deleted` fonksiyonu çağrıldı:
     ```python
     # backend/app/services/whatsapp/orchestration/events.py:1731
     stmt = (
         select(Message, Conversation)
         .join(Conversation, Message.conversation_id == Conversation.id)
         .where(
             Message.wa_message_id == str(target_wa_id), # "3A3722FDB1BAA33AB219"
             get_user_filter(Conversation.user_id, owner),
         )
     )
     row = (await db.execute(stmt)).first()
     if not row:
         return _skip_event(event, f"message_deleted: hedef mesaj #{target_wa_id} bulunamadı")
     ```
   - Veritabanı sorgusu `None` döndü, çünkü orijinal View Once mesajı ilk adımda Gateway tarafından çöpe atılmış ve DB'ye hiç kaydedilmemiştir!
   - Backend logu:
     `2026-11-07 21:25:54,467 - WARNING - Gateway olayi kalici yazilmadi: message_deleted: hedef mesaj #3A3722FDB1BAA33AB219 bulunamadı`
   - Olay `_skip_event` olarak işaretlendi.
3. **WebSocket Yayınının Kesilmesi (`events.py:3221-3234`):**
   ```python
   if result.get("_skip"):
       event["_skip"] = result.get("_skip")
       # processed_events tablosuna outbox ack için yaz
       await db.commit()
       return None  # <--- HİÇBİR WS YAYINI YAPILMADAN ÇIKILIR!
   ```
   - Fonksiyon `return None` ile sonlandığı için `ws_manager.broadcast()` tetiklenmedi.
   - Frontend'e hiçbir `message_deleted` olayı ulaşmadı.

---

## 7. Veritabanı Bütünlüğü & Güvenlik Değerlendirmesi

- Üretim ortamında gerçekleştirilen denetim boyunca hiçbir `INSERT`, `UPDATE` veya `DELETE` çalıştırılmamıştır.
- PostgreSQL `messages` tablosu (1.238 kayıt) ve hedef grup sohbeti (153 kayıt) verileri tam olarak korunmuştur.
- Gateway `whatsapp_private.event_outbox` tablosundaki SEQ `290813` kaydının `DELIVERED` durumunda olduğu, Backend `whatsapp_private.processed_events` tablosunda `4ffa9f3c-8988-423a-95d7-833c09713945` UUID'sinin yer aldığı doğrulanmış; hiçbir yetim (orphan) kayıt oluşmamıştır.

---

## 8. Kök Neden ve İyileştirme Planı (Öneri)

### A. Kök Neden Özeti:
1. **View Once İletisinin Düşürülmesi:** Baileys'in WhatsApp companion protokolünden aldığı `<unavailable type="view_once"/>` stanzasında set ettiği `msg.key.isViewOnce = true` bayrağının Gateway `isViewOnceMessage` ve `_ingestUpsertMessageInner` tarafından okunmaması ve `msg.message` boş olduğu için line 3487'de `return null` ile atılması.
2. **Silme Olayının Arayüze Ulaşmaması:** Orijinal mesaj veritabanında bulunamadığında Backend'in `_skip_event` döndürüp WebSocket yayını yapmaması; istemci tarafında veya gelecekteki senkronizasyonlarda mesajın silindiğinin bilinmesini engellemesi.

### B. Önerilen Güvenli İyileştirme Kapsamı (Kullanıcı Onayı İçin):

1. **`whatsapp-gateway/src/messages/message-classifier.js`:**
   `isViewOnceMessage(content, key)` fonksiyonunu genişleterek `key?.isViewOnce === true || content?.key?.isViewOnce === true` durumunu tespit etmesini sağlamak.
2. **`whatsapp-gateway/src/session-manager.js`:**
   - Line 3482 ve Line 5626'da `const isViewOnce = Boolean(msg.key?.isViewOnce || isViewOnceMessage(msg.message, msg.key) || isViewOnceMessage(unwrapped));` tanımlaması yapmak.
   - `isViewOnce` true olduğunda, `unwrapped` boş olsa dahi `text = '[VIEW_ONCE_PHOTO]'` (veya video/ses), `message_type = 'IMAGE'`, `is_view_once = true` set edilerek `hasRecognizedContent` filtresine takılmadan güvenle ingest edilmesini ve Backend'e `message_new` olarak iletilmesini sağlamak.
3. **`backend/app/services/whatsapp/orchestration/events.py`:**
   `_ingest_message_deleted` içinde hedef mesaj yerel veritabanında bulunamasa dahi (örneğin henüz ingest edilmemiş veya istemcide geçici olarak tutulan bir mesaj olabilir), olayın WebSocket üzerinden arayüze passthrough olarak yayınlanabilmesini sağlamak.
4. **Lokal Test ve Dağıtım:**
   Değişikliklerin yerel birim testlerini (`npm test`, `pytest`) koşmak ve kullanıcı onayı sonrasında `bash scripts/deploy/release.sh` ile güvenli şekilde üretime almak.

---

## 9. Nihai Karar

**Canlı Kabul Durumu:** **`FAIL`**
Mevcut `9cf91bf` üretim sürümünde kullanıcının telefonundan gönderdiği gerçek View Once mesajı Gateway filtreleme katmanında düşmüş; ardından gelen silme olayı da Backend doğrulama katmanında kesintiye uğramıştır.

Bu rapor doğrultusunda kök neden kanıtlanmış olup, kod değişikliği ve üretime dağıtım için kullanıcı talimatı beklenmektedir.
