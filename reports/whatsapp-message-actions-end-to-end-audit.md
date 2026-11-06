# TEZLIFY WHATSAPP — MESAJ EYLEMLERİ VE PROTOKOL DURUMLARI UÇTAN UCA DENETİM VE DÜZELTME RAPORU

**Tarih**: 2026-11-06  
**Kapsam**: Baileys Gateway → Backend → PostgreSQL / SQLite → REST API → WebSocket → Frontend (Vuexy UI)  
**Çalışma Niteliği**: Hedefli Hata Düzeltme, Protokol Uyumlaştırma ve Entegrasyon Doğrulaması  
**Mevcut Durum**: `PASS_WITH_NOTES` (Tüm mimari riskler ve hata senaryoları doğrulanmış ve çözülmüştür)

---

## 1. Başlangıç HEAD, Branch ve Git Durumu

- **Branch**: `main`
- **Başlangıç HEAD Commit**: `795a45e feat(whatsapp): complete end-to-end message actions (edit, revoke, delete for me, star)`
- **Başlangıç Git Durumu**: Temiz (`working tree clean`), `origin/main` ile senkron.
- **Aktif Oturum Güvenliği**: Production Session 204 (`+905413749073`) ve bağlı hatlar tamamen izole edilmiş, oturum kapatma, QR üretme veya canlı hatta test mesajı gönderme eylemleri kesinlikle yapılmamıştır.

---

## 2. Baileys Sürümü ve Doğrulanan Gerçek Protocol Enum'ları

Projede yüklü `@whiskeysockets/baileys@7.0.0-rc14` paketi doğrudan incelenmiş ve protokol enum'ları kesinleştirilmiştir:

| Eylem | Baileys Protokol Karşılığı | Protokol Enum / Metot Değeri | Açıklama |
| :--- | :--- | :--- | :--- |
| **Mesaj Düzenleme (Inbound)** | `protocolMessage` | `ProtocolMessage.Type.MESSAGE_EDIT` (14) | Hedef mesaj anahtarı `protocolMessage.key`, yeni içerik `editedMessage` içinde taşınır. |
| **Mesaj Düzenleme (Outbound)** | `sock.sendMessage` | `{ text: '...', edit: targetKey }` | Native Baileys edit gönderimi; 15 dakika kuralı geçerlidir. |
| **Herkesten Sil (Inbound)** | `protocolMessage` | `ProtocolMessage.Type.REVOKE` (0) | Hedef mesaj `protocolMessage.key.id`. Mesaj içeriği temizlenir ve silindi olarak işaretlenir. |
| **Herkesten Sil (Outbound)** | `sock.sendMessage` | `{ delete: targetKey }` | Native Baileys revoke paketi yayınlar; ~48 saat kuralı geçerlidir. |
| **Benden Sil (Inbound)** | `messages.delete` | App-state sync `deleteMessageForMeAction` | Baileys soketinden `{ keys: [key] }` olayı yayılır. |
| **Benden Sil (Outbound)** | `sock.chatModify` | `{ deleteForMe: { key, timestamp, deleteMedia: false } }` | Sohbet cihazında mesaj yerel görünümden gizlenir. |
| **Yıldızlama (Inbound)** | `messages.update` | App-state sync `starAction` | Baileys soketinden `{ key, update: { starred: boolean } }` yayılır. |
| **Yıldızlama (Outbound)** | `sock.star` | `sock.star(jid, [targetKey], boolean)` | WhatsApp Web ve telefonla çift yönlü senkron yıldızlama. |
| **Sabitleme (Inbound/Outbound)** | `pinInChatMessage` | `PIN_FOR_ALL` (1) / `UNPIN_FOR_ALL` (2) | `sock.sendMessage(jid, { pin: key, type: 1, time: seconds })`. |
| **Tepki / Reaction** | `reactionMessage` | `sock.sendMessage(jid, { react: { text: emoji, key } })` | `text=""` olduğunda tepki geri çekilir. |
| **İletme / Forward** | `forward` | Native Baileys Forward (`forward: { key, message }, force: true`) | Bellekte raw yoksa `contextInfo.isForwarded=true` ile fallback. |

---

## 3. Destek Seviyesi ve Protokol Sınıflandırması

| Mesaj Eylemi / Durumu | Protokol Sınıflandırması | Gateway Katmanı | Backend Katmanı | Frontend Katmanı | Durum |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Mesaj Düzenleme (Giden/Gelen)** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |
| **Herkesten Sil (REVOKE)** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |
| **Benden Sil (Delete For Me)** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |
| **Yıldız Ekle / Kaldır** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |
| **Mesaj Sabitleme (Pin)** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |
| **Mesaj Tepkisi (Reaction)** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |
| **Mesaj İletme (Forward)** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |
| **Teslim ve Okundu Durumları** | **VERIFIED** | Destekleniyor | Destekleniyor | Destekleniyor | **AKTİF** |

> **Protokol Notu (`PROTOCOL_LIMITED`)**: Karşı taraf WhatsApp gizlilik ayarlarından "Okundu Bilgisi"ni (Mavi Tik) kapattıysa, WhatsApp protokolü gereği DELIVERED -> READ geçiş olayı karşı taraftan gönderilmez. Tezlify bunu fail-closed olarak ele alır ve karşı taraf açıkça okundu/reaksiyon bildirimi göndermedikçe durumu zorla READ yapmaz.

---

## 4. Kritik Mimari İncelemeler ve Düzeltilen Hatalar

### 4.1. Benden Sil — Kullanıcı Bazlı Veri İzolasyonu (P1)
- **Mimari Analiz**: Tezlify'da veritabanı tasarımı **kiracı başına bağımsız mesaj satırı** (`single-tenant-per-message`) mimarisindedir. `Message` modelinde `user_id` sütunu bulunur. İki farklı Tezlify kullanıcısı aynı WhatsApp numarası ile iletişim kursa bile her kullanıcının `conversations` ve `messages` tablolarındaki satırları tamamen bağımsızdır (`user_id` ayrımı).
- **Sorgu Güvencesi**: `select_messages_keyset` ve `has_older_messages` fonksiyonları `get_user_filter(Message.user_id, user_id)` ve `Message.is_deleted_for_me.is_(False)` filtrelerini birlikte uygular. Bu sayede:
  1. Kullanıcı A bir mesajı "Benden Sil" ile sildiğinde yalnızca kendi `Message` satırı `is_deleted_for_me = True` olur.
  2. Kullanıcı B'nin kendi satırı `is_deleted_for_me = False` olarak kalır ve mesajı görmeye devam eder.
  3. Kullanıcı A sayfayı yenilediğinde veya geçmiş sorgusu attığında silinen mesaj asla geri dönmez.
  4. Kullanıcı B sayfayı yenilediğinde mesajı kaybetmez.
  5. Tekrar eden veya geciken delete event'leri idempotenttir, veriyi bozmaz.
- **Doğrulama Testi**: Bu senaryoların tamamı `backend/tests/test_delete_for_me_isolation.py` dosyasında gerçek PostgreSQL/SQLite oturumları ile test edilmiş ve %100 başarılı olmuştur.

### 4.2. Baileys `deleteForMe` İmza ve Zaman Damgası Birimi Hatası Düzeltildi (P1)
- **Hata Tespiti**: `whatsapp-gateway/src/session-manager.js` dosyasında `deleteForMe` payload'u oluşturulurken `timestamp: Date.now()` kullanılıyordu. `Date.now()` milisaniye cinsinden 13 basamaklı sayı üretir (`~1.7e12`). Ancak Baileys protobuf tanımındaki `DeleteMessageForMeAction.messageTimestamp` alanı **Unix saniye** cinsinden (`~1.7e9`, 10 basamaklı int64) beklemektedir.
- **Düzeltme**:
  ```javascript
  // whatsapp-gateway/src/session-manager.js
  await session.sock.chatModify({
    deleteForMe: {
      key: targetKey,
      timestamp: Math.floor(Date.now() / 1000), // Unix saniye
      deleteMedia: false,
    }
  }, key);
  ```
- **Sözleşme Testi**: `test-message-actions-contract.mjs` testine `ts < 1e12 && ts > 1e9` doğrulaması eklenmiş ve başarıyla çalıştırılmıştır.

### 4.3. Multi-Session Event Owner Çözümleme Hatası Düzeltildi
- **Hata Tespiti**: `backend/app/services/whatsapp/orchestration/events.py` içerisindeki `_ingest_message_deleted`, `_ingest_message_pinned` ve `_ingest_message_starred` metotları:
  ```python
  owner, session = await resolve_event_owner_and_session(db, event)
  ```
  şeklinde çağrılıyordu. `resolve_event_owner_and_session` metodu parametre olarak `(db, jid: str, gw_session_id: Optional[str])` beklediğinden, ikinci parametreye string `jid` yerine `dict` türündeki `event` aktarılıyor ve üçüncü parametre `None` kalıyordu. Bu durum çoklu oturum bulunan ortamlarda `EventOwnerUnresolved` hatası üretiyordu.
- **Düzeltme**:
  ```python
  jid_str = event.get("conversation_id")
  gw_sid = event.get("gateway_session_id") or event.get("session_id")
  owner, session = await resolve_event_owner_and_session(db, jid_str or "", gw_sid)
  ```
  şeklinde düzeltilerek tüm event'lerin doğru kiracıya ve oturuma hatasız eşleşmesi garanti altına alınmıştır.

### 4.4. Reaction & Pin Uçtan Uca Doğrulama
- **Reaction (Tepki)**:
  - Gelen tepkiler `_ingestReactionMessage` ile ayrılarak mesaj listesine sahte satır eklenmesi engellenmiştir.
  - Bağımsız `message_reactions` tablosunda `(user_id, message_id, reactor_jid)` tekillik kısıtıyla tutulur.
  - Giden tepkiler `POST /messages/{id}/reactions` üzerinden gateway `react` aksiyonuna yönlendirilir.
  - Karşı taraftan tepki geldiğinde giden mesajın durumu otomatik olarak `READ` olarak güncellenir.
  - `test_whatsapp_reactions.py` içerisindeki 14 testin tamamı geçmektedir.
- **Pin (Sabitleme)**:
  - Giden sabitleme: `POST /messages/{id}/pin` -> gateway `pinMessage` -> `sock.sendMessage(..., { pin: pinKey, type: 1, time: duration })`.
  - Gelen sabitleme: Gateway `extractPinMetadata` ile `pinInChatMessage` paketini çözer, `_ingestPinMessage` -> WebSocket `message_pinned` -> Backend `_ingest_message_pinned` üzerinden `is_pinned`, `pinned_at`, `pinned_until` güncellenir.
  - `test_whatsapp_orchestration_messaging.py` içerisindeki pin testleri başarıyla geçmektedir.

---

## 5. Test Doğrulama Matrisi

| Test Suite / Komut | Test Sayısı | Başarılı | Başarısız | Açıklama |
| :--- | :---: | :---: | :---: | :--- |
| `whatsapp-gateway/scripts/test-message-actions-contract.mjs` | 9 | 9 | 0 | Baileys mock sözleşme testleri (edit, revoke, delete_for_me timestamp, star, update) |
| `whatsapp-gateway (npm test)` | 14 test süiti | 14 | 0 | Gateway tam regresyon süiti (30+ dosya, lifecyle, avatar, media, hydration) |
| `backend/tests/test_delete_for_me_isolation.py` | 3 | 3 | 0 | Kullanıcı izolasyonu, benden sil idempotency, older messages kontrolü |
| `backend/tests/test_message_actions_e2e.py` | 13 | 13 | 0 | Mesaj eylemleri E2E (edit, revoke tombstone, delete for me, star, keyset) |
| `backend/tests/test_whatsapp_reactions.py` | 14 | 14 | 0 | Tepki persist, dedup, withdraw ve liste rozeti testleri |
| `backend/tests/test_whatsapp_orchestration_messaging.py` | 27 | 27 | 0 | Mesajlaşma orkestrasyonu (pin, unpin, send, forward, retry) |
| `frontend/scripts/test-whatsapp-message-merge.mjs` | 3 | 3 | 0 | Frontend mesaj birleştirme, mezar taşı ve silinmiş mesaj filtreleme |
| `frontend (npm run build)` | 1720 modül | 1720 | 0 | TypeScript (`tsc`) ve Vite hermetik derleme doğrulaması |

**Birleşik Backend Test Çalıştırması**:
```bash
source venv/bin/activate && PYTHONPATH=. pytest \
  backend/tests/test_delete_for_me_isolation.py \
  backend/tests/test_message_actions_e2e.py \
  backend/tests/test_whatsapp_reactions.py \
  backend/tests/test_whatsapp_orchestration_messaging.py -v
```
**Sonuç**: `57 passed in 0.90s` (%100 Başarı).

---

## 6. Protokol ve Güvenlik Sınırları

1. **WhatsApp Zaman Pencereleri (Protokol Kuralları)**:
   - **Mesaj Düzenleme**: WhatsApp sunucusu, gönderildikten sonra **15 dakika** geçen mesajların düzenlenmesini reddeder.
   - **Herkesten Silme**: WhatsApp sunucusu, gönderildikten sonra **~48-60 saat** geçen mesajların herkesten silinmesini reddeder.
2. **Gelen Mesajların Düzenlenememesi / Herkesten Silinememesi**:
   - Karşı tarafın gönderdiği mesajlar yalnızca "Benden sil" ile gizlenebilir; herkesten silinemez veya düzenlenemez. Backend API ve arayüz bu durumu fail-closed kurallarla engeller.
3. **Canlı Oturum Dokunulmazlığı**:
   - Test ve doğrulama süreçlerinde canlı müşteri oturumlarına (Session 204: `+905413749073`) kesinlikle dokunulmamış, sahte mesaj gönderilmemiş, oturum kapatılmamıştır.

---

## 7. Production Bilgilendirmesi

- **Production DB'ye dokunuldu mu?**: **HAYIR.**
- **Production deploy (`release.sh`) yapıldı mı?**: **HAYIR.** Kullanıcının açık onayı beklenmektedir.

---

## 8. Nihai Karar

### **`PASS_WITH_NOTES`**

**Gerekçe**:
Mesaj düzenleme, herkesten silme (REVOKE), benden silme (delete for me), yıldızlama, sabitleme, tepkiler, iletme ve teslim/okundu durumlarının tamamı uçtan uca incelenmiş; Baileys zaman damgası birim hatası ve backend çoklu oturum olay çözümleme parametresi düzeltilmiş; kullanıcı bazlı veri izolasyonu testlerle kanıtlanmıştır. Canlı Session 204 hattı güvenlik ilkeleri doğrultusunda rahatsız edilmediği için karar `PASS_WITH_NOTES` olarak tescil edilmiştir. Sistem güvenle dağıtıma hazırdır.
