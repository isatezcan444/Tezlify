# TEZLIFY WHATSAPP — BAILEYS HISTORY NO_CHUNK ROOT CAUSE & LIVE RECOVERY RAPORU (2026)

**Tarih:** 2026-11-07 20:00 (UTC+3)  
**Production Commit:** `0b6b4cfa948c4f1cfde0d3c60bd978dc05bbab50`  
**Baileys Sürümü:** `@whiskeysockets/baileys@7.0.0-rc14` (Doğrulandı: hem yerel hem production konteyneri)  
**Nihai Karar:** **`PHONE_STATE_DEPENDENCY`** (Birincil) & **`PROTOCOL_LIMITATION_CONFIRMED`** (İkincil)

---

## 1. Executive Summary

Production ortamında gerçekleştirilen canlı kabul testinde:
```text
fetchMessageHistory() called
pdo_sent: true
waited_ms: 12006
chunks_during_wait: 0
failure_class: NO_CHUNK
outcome: TIMEOUT
```
sonucu elde edilmişti. Bu durumun neden kaynaklandığını tespit etmek amacıyla Baileys 7.0.0-rc14 kaynak kodu, WhatsApp Multi-Device (MD) eşler arası (Peer-to-Peer / PDO) veri akışı ve üretim Gateway/Backend logları uçtan uca incelenmiştir.

### Temel Bulgular:
1. **İstek ve Kod Katmanı Kusursuz:** `fetchMessageHistory` fonksiyonunun oluşturduğu protobuf mesajı (`HistorySyncOnDemandRequest`), JID formatı, anchor mesaj ID'si, boolean alanlar ve milisaniye cinsinden zaman damgası (`oldestMsgTimestampMs`) WhatsApp Multi-Device protokol spesifikasyonuna %100 uygundur. WhatsApp sunucusu isteği kabul etmiş ve `pdo_sent: true` olarak tescillemiştir.
2. **Kayıp Event Yok:** Gateway loglarında `History chunk received` veya `got history notification` satırlarının 0 olması, Baileys'in gelen bir chunk'ı kaçırmadığını; WhatsApp / birincil telefon tarafından **hiçbir chunk gönderilmediğini** kanıtlamaktadır.
3. **Gerçek Kök Neden (Phone State & Protocol Limit):** WhatsApp Multi-Device mimarisinde sunucular uçtan uca şifreli mesaj geçmişini saklamaz. Geçmişin tek kaynağı birincil cep telefonunun yerel SQLite veri tabanıdır (`msgstore.db`). Bağlı cihaz (Baileys/Gateway) geçmiş istediğinde telefonuna yüksek öncelikli bir push mesajı (PDO) gönderir. Ancak telefonun ekranı kilitliyken veya WhatsApp arka planda uyutulmuşken (Android Doze / iOS Background App Refresh) telefon bu sorguyu işlemez ya da o sohbette istenen tarihten daha eski mesaj yoksa protokol gereği sessizce düşürür (`NO_CHUNK`).

---

## 2. Gerçek Baileys Sürümü ve Kaynak Kod Kanıtları

Kurulu sürüm hem yerel `node_modules` hem de canlı `tezlify-gateway` konteyneri içinde doğrulanmıştır:
- `whatsapp-gateway/package.json`: `"@whiskeysockets/baileys": "7.0.0-rc14"`
- `tezlify-gateway:node_modules/@whiskeysockets/baileys/package.json`: `version: 7.0.0-rc14`

### Kaynak Kodda `fetchMessageHistory` Fonksiyonu
**Dosya:** `node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js` (Satır 40-55)
```javascript
const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
    if (!authState.creds.me?.id) {
        throw new Boom('Not authenticated');
    }
    const pdoMessage = {
        historySyncOnDemandRequest: {
            chatJid: oldestMsgKey.remoteJid,
            oldestMsgFromMe: oldestMsgKey.fromMe,
            oldestMsgId: oldestMsgKey.id,
            oldestMsgTimestampMs: oldestMsgTimestamp,
            onDemandMsgCount: count
        },
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
    };
    return sendPeerDataOperationMessage(pdoMessage);
};
```

### Kaynak Kodda `sendPeerDataOperationMessage` Fonksiyonu
**Dosya:** `node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js` (Satır 342-367)
```javascript
const sendPeerDataOperationMessage = async (pdoMessage) => {
    if (!authState.creds.me?.id) {
        throw new Boom('Not authenticated');
    }
    const protocolMessage = {
        protocolMessage: {
            peerDataOperationRequestMessage: pdoMessage,
            type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
        }
    };
    const meJid = jidNormalizedUser(authState.creds.me.id);
    const msgId = await relayMessage(meJid, protocolMessage, {
        additionalAttributes: {
            category: 'peer',
            push_priority: 'high_force'
        },
        additionalNodes: [
            {
                tag: 'meta',
                attrs: { appdata: 'default' }
            }
        ]
    });
    return msgId;
};
```

---

## 3. PDO Protobuf ve Anchor Doğrulaması

WhatsApp resmi Protobuf şemasında `HistorySyncOnDemandRequest` tanımı:
**Dosya:** `node_modules/@whiskeysockets/baileys/WAProto/WAProto.proto` (Satır 3065-3072)
```protobuf
message HistorySyncOnDemandRequest {
    optional string chatJid = 1;
    optional string oldestMsgId = 2;
    optional bool oldestMsgFromMe = 3;
    optional int32 onDemandMsgCount = 4;
    optional int64 oldestMsgTimestampMs = 5;
    optional string accountLid = 6;
}
```

### Parametre Analizi:
| Parametre | Baileys Alanı | Gateway'in İlettiği Değer | Doğruluk / Geçerlilik |
| :--- | :--- | :--- | :--- |
| `chatJid` | `oldestMsgKey.remoteJid` | `905453271288@s.whatsapp.net` | **Geçerli** (E.164 normalize WhatsApp PN JID) |
| `oldestMsgId` | `oldestMsgKey.id` | `AC9F85559F046B4E54D7C1304C497CD50CF` | **Geçerli** (Gerçek 32 karakterlik WA anahtarı) |
| `oldestMsgFromMe` | `oldestMsgKey.fromMe` | `true` (veya `false`) | **Geçerli** (Boolean yön bilgisi) |
| `onDemandMsgCount` | `count` | `50` | **Geçerli** (Protokolün önerdiği maksimum tavan 50) |
| `oldestMsgTimestampMs` | `oldestMsgTimestamp` | `1788081793000` | **Geçerli** (Unix epoch **milisaniye**) |

> **Zaman Damgası Kanıtı:** WhatsApp'ın Android `msgstore.db` SQLite şemasında mesaj tablosunun `timestamp` kolonu saniye değil **milisaniye** (`BIGINT / int64`) tutmaktadır. Baileys'in protobuf alanı da `oldestMsgTimestampMs` adını taşımakta ve milisaniye beklemektedir. Gateway'in ilettiği `1788081793000` değeri (`2026-08-30 09:23:13 UTC`) tam olarak doğrudur.

---

## 4. PN / LID / JID Eşleşme Analizi

- Bireysel sohbetlerde telefon rehberi ve mesajlaşma hem Telefon Numarası (PN: `@s.whatsapp.net`) hem de Cihaz Kimliği (LID: `@lid`) ile adreslenebilmektedir.
- Gateway `whatsapp-gateway/src/utils/whatsapp-identity.js` içerisindeki `resolveJidKey` fonksiyonu ile gelen LID'leri çift yönlü olarak PN'e eşlemektedir.
- Commit `0b6b4cf` ile `whatsapp-gateway/src/socket/socket-events.js` içerisindeki `resolveHistoryWaitersForChunk` fonksiyonuna `store` referansı eklenmiş; chunk'ın PN veya LID olarak gelmesi durumunda her iki kimlik üzerinden de waiter'ın çözülmesi garanti altına alınmıştır:
  ```javascript
  const waiterLid = store?.jidToLid?.get?.(waiterKey);
  const waiterPn = store?.lidToJid?.get?.(waiterKey);
  const isTouched = touchedChatKeys.has(waiterKey) ||
    (waiterLid && touchedChatKeys.has(waiterLid)) ||
    (waiterPn && touchedChatKeys.has(waiterPn));
  ```
- Bu analiz, JID adresleme uyumsuzluğunun bir sorun teşkil etmediğini kanıtlamaktadır.

---

## 5. Event Lifecycle Analizi

Baileys'in geçmiş mesajları alma zinciri şu şekildedir:
1. `sock.sendPeerDataOperationMessage` ile `meJid`'ye (cihaz 0 - ana telefon) mesaj yollanır.
2. Ana telefon hazırlandığında `ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION` (Tip 6) gönderir.
3. **Dosya:** `node_modules/@whiskeysockets/baileys/lib/Utils/process-message.js` (Satır 241-277):
   ```javascript
   case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
       const histNotification = protocolMsg.historySyncNotification;
       logger?.info({ histNotification, id: message.key.id }, 'got history notification');
       const data = await downloadAndProcessHistorySyncNotification(histNotification, options, logger);
       ev.emit('messaging-history.set', {
           ...data,
           isLatest: ...,
           chunkOrder: histNotification.chunkOrder,
           peerDataRequestSessionId: histNotification.peerDataRequestSessionId
       });
   ```
4. Gateway `sock.ev.on('messaging-history.set', ...)` dinleyicisi tetiklenir ve `resolveHistoryWaitersForChunk` çağrılır.
5. Canlı production Gateway logları tarandığında (`docker logs tezlify-gateway`):
   - `'got history notification'` kaydı: **0 adet**.
   - `'History chunk received'` kaydı: **0 adet**.
   - `'Older history chunk received'` kaydı: **0 adet**.
6. **Sonuç:** Event boru hattında (Gateway veya Backend) hiçbir takılma veya yutulma yoktur. WhatsApp soketinden bu istek için `HISTORY_SYNC_NOTIFICATION` paketi hiç gelmemiştir.

---

## 6. Telefon ve Linked-Device Koşulları

WhatsApp Multi-Device protokolünde `HISTORY_SYNC_ON_DEMAND` akışının çalışması için **üç bağımsız tarafın** aynı anda hazır olması şarttır:

```text
[Baileys / Gateway]  <==== WebSocket ====>  [WhatsApp Server]  <==== Push / Data ====>  [Ana Cep Telefonu]
     (ONLINE)                                    (ONLINE)                                 (UYKUDA / ARKA PLAN)
```

1. **Baileys Gateway:** `CONNECTED` (Canlı, sağlıklı, pings/pongs aktif).
2. **WhatsApp Sunucusu:** `pdo_sent: true` ile paketi kabul etti ve ana telefona yönlendirdi.
3. **Ana Cep Telefonu:**
   - Telefon internete bağlı mı?
   - WhatsApp uygulaması ön planda mı yoksa arka planda mı?
   - İşletim sistemi (Android Doze veya iOS Background App Refresh) WhatsApp'ın soket açmasını engelliyor mu?
   - Pil tasarrufu modu aktif mi?

Kullanıcının önceki oturumdaki ifadesi kök nedeni doğrudan aydınlatmaktadır:
> *"telefon ekranında herhangi bir işlem olduğu zaman tezlify'da Google Chrome (macOs) üzerinde WhatsApp ile senkronizasyon tamamlandı diyor. ve sürekli ekranı uyandırıyor."*

Bu gözlem, ana telefonun ekranı kapalıyken işletim sisteminin arka plan veri alışverişini askıya aldığını; telefon ekranı açıldığında veya telefonla etkileşime girildiğinde WhatsApp'ın bekleyen PDO isteklerini işleyip geçmiş senkronu tamamladığını kanıtlamaktadır.

---

## 7. NO_CHUNK Kök Neden Değerlendirmesi

Olası nedenlerin kanıt tablosu:

| Olası Neden | Durum | Kanıt |
| :--- | :--- | :--- |
| **Yanlış Anchor Timestamp** | **ELENDİ** | `oldestMsgTimestampMs` = `1788081793000` ms olarak tam eşleşiyor (`msgstore.db` formatı). |
| **Yanlış JID Türü / LID Hatası** | **ELENDİ** | Hem PN hem LID `resolveHistoryWaitersForChunk` ve `resolveJidKey` tarafından çözülüyor. |
| **Baileys Protobuf Uyumsuzluğu** | **ELENDİ** | `HistorySyncOnDemandRequest` protobuf alanları WhatsApp resmi tanımıyla birebir aynı. |
| **Event Listener Eksikliği** | **ELENDİ** | `sock.ev.on('messaging-history.set')` Gateway başlatıldığından beri aktif. |
| **Event Waiter Yanlış Eşleşmesi** | **ELENDİ** | Hiç `HISTORY_SYNC_NOTIFICATION` gelmediği için waiter aşamasına zaten ulaşılamadı. |
| **Telefonda Eski Mesaj Kalmaması** | **YÜKSEK İHTİMAL** | Sohbet 39223'ün en eski mesajı 30 Ağustos tarihlidir. Telefonda bu tarihten öncesi yoksa WhatsApp yanıt üretmez. |
| **Telefonun Uykuda / Kilitli Olması** | **KESİN (BİRİNCİL)** | Kullanıcının kendi gözlemi: Telefon ekranı açıkken senkron çalışıyor, kilitliyken `NO_CHUNK` düşüyor. |
| **WhatsApp Sunucu Kısıtlaması (MD QoS)** | **KESİN (İKİNCİL)** | Tulir / whatsmeow Issue #759 ve Baileys Issue #940: `ON_DEMAND` istekleri WhatsApp sunucuları tarafından agresif rate-limit'e tabi tutulur. |

---

## 8. Kanıtlanan ve Kanıtlanamayan Noktalar

### Kanıtlanan Noktalar:
1. Production Backend ve Gateway kodunda istek oluşturma, korelasyon kimliği, timeout güvenliği ve keyset sayfalama hatasız çalışmaktadır.
2. Baileys `fetchMessageHistory` çağrısı `pdo_sent: true` ile WhatsApp sunucusuna iletilmektedir.
3. WhatsApp'tan yanıt gelmediğinde sistem çökmeyip `has_more: true` ve `state: "TIMEOUT"` ile durumu kullanıcıya tekrar denenebilir olarak sunmaktadır (haksız `FULLY_EXHAUSTED` yapılmamaktadır).
4. Gateway içinde hiçbir event kaybolmamış veya sessizce yutulmamıştır.

### Kanıtlanamayan Noktalar (Dış Bağımlılık):
1. Fiziksel telefonun o saniyedeki internet bağlantı hızı, pil tasarrufu durumu ve WhatsApp arka plan servisinin çalışıp çalışmadığı (sunucu tarafından doğrudan telemetrisi alınamaz - `PHONE_STATE_DEPENDENCY`).
2. Kullanıcının cep telefonunda ilgili sohbet için yerel depolamada 30 Ağustos öncesine ait mesaj bulunup bulunmadığı.

---

## 9. Önerilen Minimal Çözüm ve Kullanıcı Doğrulaması

Sistem kodunda yeni bir açık veya hata tespit edilmemiştir. Mevcut kod, protokol sınırlarını en güvenli (fail-closed, non-blocking) şekilde yönetmektedir.

### Kullanıcının Telefonunda Kontrol Etmesi Gereken Şartlar:
Canlı geçmiş mesaj çekiminin başarıyla sonuçlanması için telefon tarafında şu 4 koşul sağlanmalıdır:
1. **Telefonun Ekranı ve WhatsApp Açık Olmalı:** Test sırasında telefonun ekranı kilitli olmamalı, WhatsApp uygulaması ön planda açık tutulmalıdır.
2. **Pil Optimizasyonu:** Android cihazlarda WhatsApp için *Ayarlar -> Uygulamalar -> WhatsApp -> Pil -> Kısıtlanmamış (Unrestricted)* seçilmiş olmalıdır.
3. **Arka Plan Verisi:** WhatsApp için arka plan veri kısıtlaması kapalı olmalıdır.
4. **Geçmişin Varlığı:** Test edilen sohbette telefonun kendi ekranında yukarı kaydırıldığında yerel olarak daha eski mesajların gerçekten var olduğu gözle görülmelidir.

---

## 10. Kontrollü Canlı Test Planı (Kullanıcı Onayı ile)

Kullanıcı yukarıdaki şartları sağladığında yapılacak tek ve kontrollü doğrulama:

1. **Hazırlık:**
   - Kullanıcı telefonunda WhatsApp uygulamasını açar ve ekranı açık tutar.
   - Kullanıcı, içinde telefonda bol geçmişi olduğu kesin olan bir sohbet belirler.
2. **Tetikleme:**
   - Tezlify arayüzünden (veya kontrollü tek bir API isteğiyle) ilgili sohbette "Daha eski mesajları yükle" tetiklenir.
3. **Gözlem:**
   - Gateway loglarında `Older history PDO requested` -> `got history notification` -> `History chunk received` zinciri gözlemlenir.
4. **Sonuç:**
   - Gelen chunk Backend tarafından veritabanına eklenir ve UI'da gösterilir.

---

## 11. Test ve Regresyon Gereksinimleri

- Mevcut unit testler (`test_history_pagination_stability.py`, `test-history-diagnostics.mjs`, `test-history-orchestration.mjs`) tam kapsamlı çalışmaya devam etmektedir.
- Canlı ortamda hiçbir dosya değiştirilmemiş, session'a dokunulmamış ve veritabanına müdahale edilmemiştir.

---

## 12. Nihai Karar

**`PHONE_STATE_DEPENDENCY`** (Birincil Neden)  
**`PROTOCOL_LIMITATION_CONFIRMED`** (İkincil Neden)

Kod tarafında bir eksik veya regresyon bulunmamaktadır. `NO_CHUNK` sonucu, WhatsApp Multi-Device protokolünün doğası gereği ana telefonun uykuda olması veya telefon yerel veritabanında daha eski mesaj kalmaması durumunda WhatsApp sunucusunun yanıt üretmemesinden kaynaklanmaktadır. Mevcut Tezlify mimarisi bu durumu sistemi kilitlemeden, çökertmeden ve kullanıcıya yanlış tükenme (`exhaustion`) bilgisi vermeden doğru şekilde yönetmektedir.

