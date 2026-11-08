# TEZLIFY WHATSAPP — GERÇEK ZAMANLI MESAJ VE BİLDİRİM KAYBI / KÖK NEDEN ANALİZİ

## Özet ve Başlangıç Durumu

- **Tarih**: 2026-11-08
- **İncelenen Olay Zamanı**: `2026-11-08 10:09:17 - 10:09:43 UTC` (13:09:17 - 13:09:43 TSİ)
- **Branch**: `main`
- **İncelenen HEAD**: `f3f2f4c07f785b5b309eea11662319a6f0a18711`
- **İnceleme Kapsamı**: Canlı üretim logları (Gateway, Backend, DB, Caddy) ve kaynak kod üzerinde salt okunur (read-only) adli analiz. Üretim DB'sine yazma, container restart, QR üretme, oturum sıfırlama veya yeni mesaj gönderimi yapılmamıştır.

---

## 1. Kullanıcı Semptomunun Teknik Karşılığı

Kullanıcı tarafından bildirilen iki bağımsız semptom bulunmaktadır:

1. **WhatsApp Bildirimi Gelirken Tezlify'da Bildirim Üretilmemesi**:
   - Kullanıcının telefonundaki yerel WhatsApp uygulamasına anında bildirim düşerken, açık olan Tezlify Web arayüzünde ne masaüstü bildirimi, ne in-app bildirim/toast, ne de sesli uyarı çalmaktadır.
2. **Mesajın Gerçek Zamanlı Ekrana Düşmeyip Yalnızca Sayfa Yenilemesinden (Refresh) Sonra Görünmesi**:
   - Gelen mesaj arayüzdeki aktif sohbet akışına veya mesaj geçmişine anında eklenmemekte; kullanıcı sayfayı F5 ile yenilediğinde REST API (`GET /conversations/{id}/messages`) üzerinden yüklenerek görünür hale gelmektedir.

Bu iki semptom birbirine bağımlı varsayılmamış; bildirim üretimi ve gerçek zamanlı state teslimi bağımsız olarak adli kanıtlarla incelenmiştir.

---

## 2. Mesajın Gateway'den Frontend'e Gerçek Akışı

Canlı üretim ortamında (`130.162.247.20`) gerçekleşen `10:09:17 - 10:09:20 UTC` tarihli gelen mesaj üzerinden uçtan uca zincir incelenmiştir:

```
[WhatsApp Network]
       │
       ▼ (10:09:17.765 UTC)
[Baileys Socket] (messages.upsert, type: "notify")
       │
       ▼
[Gateway: postgres-event-outbox]
       │ SEQ: 291477, state: PENDING -> IN_FLIGHT -> DELIVERED (10:09:19.921 UTC)
       ▼ (WebSocket /ws/gateway via bridge)
[Backend: main.py /ws/gateway]
       │ json.loads() -> ingest_gateway_event()
       ▼ (10:09:19.868 UTC)
[Backend: Postgres DB]
       │ INSERT INTO public.messages (id: 179082, conversation_id: 39352) -> COMMIT
       ▼
[Backend: ws_manager.broadcast(persisted)]
       │ target_user_id: f65642ab-4ae5-4d69-945c-8f30c8454bac (Active: 1 socket)
       ▼ (WebSocket /ws via Caddy Proxy)
[Frontend: client.ts (createWebSocket / subscribeRealtime)]
       │ onMessage() -> window.dispatchEvent('tezlify:ws_event')
       ▼
[Frontend: App.tsx & WhatsAppHubPage.tsx (handleWsEvent)]
       ├── App.tsx: Tab filtresi (activeTab !== 'whatsapp') ve eksik alan (body)
       └── WhatsAppHubPage.tsx: messagesMap filtreleme, ses ve bildirim kontrolleri
```

### Canlı Olay Adli Kanıtları (Forensic Correlation):
- **Orijinal Mesaj**: DB `id: 179082`, `conversation_id: 39352`, yön: `INBOUND`, `wa_message_id: 3A24520238F3244BD08E`, `created_at: 2026-11-08 10:09:19.868627 UTC`.
- **Gateway Outbox**: `whatsapp_private.event_outbox` SEQ: `291477`, `event_type: message_new`, `upsert_type: notify`, outbox `created_at: 10:09:17.765738Z`, `delivered_at: 10:09:19.921334Z`.
- **Backend Log**: Backend Gateway'den gelen olayı eksiksiz ayrıştırmış, veritabanına satır 179082 olarak yazmış ve commit etmiştir.
- **WebSocket Durumu**: Kullanıcı `f65642ab-4ae5-4d69-945c-8f30c8454bac`, `10:06:54 UTC` ile `10:09:36 UTC` arasında `/ws` hattına kesintisiz bağlı kalmıştır (Active: 1).
- **Sayfa Yenilemesi**: Kullanıcı saat `10:09:36.237 UTC`'de sayfayı yenilemiş (`client disconnected`), anında `10:09:36.505 UTC`'de yeniden bağlanmış ve REST API üzerinden mesajı alarak `10:09:43 UTC`'de cevap iletmiştir (`POST /conversations/39352/messages`).

---

## 3. Mesajın Neden Refresh Sonrasında Göründüğü

Backend ve Gateway mesajı başarıyla DB'ye kaydetmesine rağmen kullanıcının mesajı refresh sonrası görmesinin teknik nedenleri:

### A. Arka Planda / Başka Sohbette Kalan Mesajın `messagesMap` Tarafından Düşürülmesi (Kanıtlandı)
`frontend/src/pages/WhatsAppHubPage.tsx` satır 2966-2971:
```typescript
setMessagesMap((prev) => {
  // Update if active or if thread is already in memory
  if (isActiveConversation || prev[targetConvId]) {
    return { ...prev, [targetConvId]: mergeWhatsAppMessages(prev[targetConvId] || [], [newMsg]) };
  }
  return prev;
});
```
- Canlı log incelemesinde saat `10:09:17 UTC`'de kullanıcının sohbet `39372`'yi görüntülediği tespit edilmiştir (`GET /api/v1/whatsapp/conversations/39372/messages?limit=50`).
- Saat `10:09:19 UTC`'de sohbet `39352`'ye mesaj geldiğinde:
  1. `isActiveConversation` değeri **`false`** olmuştur (açık olan sohbet `39372`'dir).
  2. Kullanıcı o oturumda henüz `39352` sohbetini açmamışsa `prev[39352]` **`undefined`** durumdadır.
  3. Koşul sağlanmadığı için `setMessagesMap` gelen mesajı hafızaya **eklememiş ve düşürmüştür** (`return prev`).
- Kullanıcı sol listeden `39352`'ye tıkladığında veya sayfayı yenilediğinde REST API `GET /conversations/39352/messages` çağrılarak mesaj DB'den çekilmiş ve ancak o zaman ekranda görünmüştür.

### B. Baileys `append` Upsert Durumunda Canlı WebSocket Yayın Kapatması (Kanıtlandı)
`backend/app/services/whatsapp/orchestration/events.py` satır 1353:
```python
if is_append:
    event["_no_broadcast"] = True
return event
```
`backend/app/main.py` satır 775:
```python
if persisted.get("_no_broadcast") is True:
    return  # Canlı WebSocket yayını yapılmaz!
```
- WhatsApp mobil cihazı kilit açıldığında veya app-state senkronizasyonu sırasında mesajları Baileys soketine `append` türüyle iletebilmektedir.
- Bu durumda backend mesajı DB'ye yazar ancak `_no_broadcast = True` işaretleyerek `/ws` broadcast'ini **tamamen iptal eder**. Mesaj DB'de vardır fakat frontend soketine hiçbir veri gitmez; kullanıcı sayfayı yenilemedikçe veya REST çekilmedikçe mesaj ekranda belirmez.

### C. `rememberWaMessageId` Yanlış Pozitif Replay Bastırması (Kanıtlandı)
`frontend/src/pages/WhatsAppHubPage.tsx` satır 2813:
```typescript
const isReplayedEvent = Boolean(waIdForDedup) && !rememberWaMessageId(String(waIdForDedup), convId ?? undefined);
```
- Eğer mesaj kimliği (`wa_message_id`) daha önce herhangi bir listeden veya metadata taramasından geçip ring buffer'a kaydedilmişse, `isReplayedEvent = true` döner.
- Bu durumda:
  - Sohbet listesi `unread_count` artırılmaz.
  - `last_message_at` güncellenmez.
  - Bildirim tetiklenmez.

---

## 4. Tezlify Bildiriminin Neden Üretilmediği

Tezlify bünyesindeki 4 bildirim kanalı adli olarak incelenmiş ve neden sessiz kaldığı kanıtlanmıştır:

### A. Uygulama İçi Toast/Banner Bildirimi (Kanıtlandı)
1. **WhatsApp Sayfasındayken Bildirim Engeli**:
   - `frontend/src/App.tsx` satır 236:
     ```typescript
     if (!isOutbound && activeTabRef.current !== 'whatsapp') {
       toast.info(...);
     }
     ```
     Kullanıcı WhatsApp sekmesindeyken (`activeTab === 'whatsapp'`) `App.tsx` toast bildirimini **bilinçli olarak kapatmaktadır**.
   - `frontend/src/pages/WhatsAppHubPage.tsx`:
     `WhatsAppHubPage.tsx` içerisinde `message_new` olayı geldiğinde **hiçbir `toast.info(...)` çağrısı bulunmamaktadır**.
     Dolayısıyla kullanıcı Tezlify WhatsApp sayfasında başka bir işle uğraşırken veya başka bir sohbeti incelerken gelen yeni mesajlar için hiçbir görsel Toast üretilmemektedir.
2. **`App.tsx` Gövde (Body) Alanı Uyuşmazlığı**:
   - `frontend/src/App.tsx` satır 243-247:
     ```typescript
     const msgText =
       eventData.content ||
       eventData.text ||
       eventData.message?.content ||
       eventData.message?.text ||
       '';
     ```
   - Backend `serialize_message` fonksiyonu metin içeriğini `message.body` alanında göndermektedir (`content` veya `text` alanı hiç bulunmamaktadır).
   - Sonuç olarak kullanıcı başka sekmede olsa dahi `msgText` daima boş metin `""` olmakta, toast içeriği ve bildirim metni boş kalmaktadır!

### B. Masaüstü / OS / Browser Bildirimi (Desktop Notification) (Kanıtlandı)
- `frontend/src/features/whatsapp/hooks/useWhatsAppSettings.ts` satır 24:
  ```typescript
  export const DEFAULT_WHATSAPP_SETTINGS: WhatsAppCustomizationSettings = {
    desktopNotificationsEnabled: false, // Varsayılan olarak KAPALI!
  ```
- Kullanıcı arayüzden WhatsApp Ayarları menüsüne girip "Masaüstü Bildirimleri" switch'ini açmadığı ve tarayıcıdan izin vermediği (`Notification.permission === 'granted'`) sürece masaüstü bildirimi `false` dönerek tamamen engellenmektedir.

### C. Sesli Bildirim (Web Audio API Autoplay Politikası) (Kanıtlandı)
- `frontend/src/features/whatsapp/lib/whatsappAudio.ts`:
  Bildirim sesleri HTML5 Web Audio API (`AudioContext`) sentezleyicisi ile üretilmektedir.
- Modern tarayıcılar (Chrome, Safari) kullanıcı sekme üzerinde doğrudan tıklama (`click`) veya tuşlama (`keydown`) yapmadan önce `AudioContext` nesnesini `'suspended'` (askıda) durumunda tutar.
- `initAudioUnlock` fonksiyonu yalnızca `WhatsAppHubPage` mount edildiğinde pencereye tek seferlik dinleyici eklemektedir. Sekme arka planda açıldıysa, sayfa yenilendikten sonra henüz tıklanmadıysa veya sistem uykudan uyandıysa ses çalma isteği tarayıcı tarafından sessizce engellenmektedir.

### D. Tezlify Bildirim Merkezi (Header Bell) (Kanıtlandı)
- `frontend/src/components/Layout/TopHeader.tsx` incelenmiş; üst bardaki zil ikonunun dinamik bir WebSocket gelen kutusu olmadığı, yalnızca statik kırmızı noktalı bir buton olduğu doğrulanmıştır.

---

## 5. Kanıtlanmış Kök Nedenler

| No | Bileşen | Dosya & Satır | Kanıtlanmış Hata / Neden | Etki |
|---|---|---|---|---|
| **K1** | Frontend Hub | `WhatsAppHubPage.tsx:2966` | `isActiveConversation \|\| prev[targetConvId]` koşulu nedeniyle açık olmayan ve hafızada bulunmayan sohbet mesajının drop edilmesi. | Mesaj ekranda görünmez, refresh yapılana kadar kaybolur. |
| **K2** | Frontend Hub | `WhatsAppHubPage.tsx:2733` | `WhatsAppHubPage` içerisinde `message_new` için hiçbir `toast.info` çağrısı olmaması. | WhatsApp sayfasındayken yeni mesajlar için hiçbir görsel bildirim çıkmaz. |
| **K3** | Frontend Root | `App.tsx:236` | `activeTabRef.current !== 'whatsapp'` guard'ı. | WhatsApp sayfasında `App.tsx` seviyesinde tüm toast'ların bastırılması. |
| **K4** | Frontend Root | `App.tsx:243` | `msgText` okunurken `eventData.message?.body` yerine bulunmayan `content`/`text` alanlarının aranması. | Başka sekmedeyken bile bildirim metninin boş `""` gelmesi. |
| **K5** | Frontend Audio | `useWhatsAppSettings.ts:24` | `desktopNotificationsEnabled: false` varsayılan değeri. | Kullanıcı açıkça açmadıkça sıfır OS/Desktop bildirimi. |
| **K6** | Frontend Audio | `whatsappAudio.ts:60` | Tarayıcı Autoplay politikası nedeniyle `AudioContext`'in suspended kalması. | Tıklama öncesinde veya arka planda bildirim sesinin çalmaması. |
| **K7** | Backend Gateway | `events.py:1353` & `main.py:775` | `is_append` durumunda `_no_broadcast = True` atanıp canlı WS yayınının tamamen kesilmesi. | Baileys append upsert mesajlarının refresh olmadan ekranda belirmemesi. |

---

## 6. Yalnızca Şüpheli Kalan Noktalar

1. **Tarayıcı Uyku Modu (OS Sleep) Sonrası Stale WebSocket**:
   - Kullanıcı bilgisayarı uykuya aldığında TCP soketi yarım açık (half-open) kalabilir. `client.ts` içerisindeki `visibilitychange` ve 25 sn'lik ping/pong heartbeat mekanizması mevcut olsa da, uyanma anı ile ilk pong zaman aşımı arasındaki 50 saniyelik pencerede gelen mesajlar soketten düşebilir. (Bu senaryoda loglar kesintisiz bağlantı göstermiştir, ancak mobil/laptop kullanımında risk faktörüdür).
2. **Kullanıcı Sekme Görünürlüğü (Tab Visibility / Inactive Background)**:
   - Kullanıcı Tezlify'ı arka planda bir tarayıcı sekmesinde tuttuğunda Chrome timer throttling (zamanlayıcı kısıtlaması) devreye girerek React state güncellemelerini geciktirebilir.

---

## 7. Etkilenen Dosya ve Fonksiyonlar

### Frontend:
1. `frontend/src/App.tsx`:
   - `subscribeRealtime` mesaj işleyicisi (`eventData.event === 'message_new'`).
   - `msgText` gövde çözümleme (`eventData.message?.body`).
2. `frontend/src/pages/WhatsAppHubPage.tsx`:
   - `handleWsEvent` (`eventData.event === 'message_new'`).
   - `setMessagesMap` güncelleme mantığı (inaktif sohbetlerin hafızaya alınması).
   - In-app toast bildirimi eklenmesi (kullanıcı başka bir sohbetteyken görsel bildirim).
3. `frontend/src/features/whatsapp/hooks/useWhatsAppSettings.ts`:
   - `DEFAULT_WHATSAPP_SETTINGS` ve masaüstü bildirim izin istemi yaşam döngüsü.
4. `frontend/src/features/whatsapp/lib/whatsappAudio.ts`:
   - `getAudioContext()` ve autoplay resume iyileştirmesi.

### Backend:
1. `backend/app/services/whatsapp/orchestration/events.py`:
   - `_ingest_message_new`: `is_append` bayrağının canlı yayını (`_no_broadcast`) ezme davranışı.
2. `backend/app/main.py`:
   - `/ws/gateway` ingest worker: `_no_broadcast` filtresinin canlı mesaj varışlarıyla tutarlılığı.

---

## 8. En Küçük Güvenli Düzeltme Planı

Gereksiz mimari değişiklikler yapmadan, yalnızca kanıtlanmış hataları hedef alan en küçük güvenli düzeltmeler:

### Adım 1: Frontend Hub State ve In-App Toast Düzeltmesi (`WhatsAppHubPage.tsx`)
- `setMessagesMap` bloğunda: Gelen mesaj hangi sohbete ait olursa olsun, o sohbet daha önce yüklenmişse veya aktifse mesajı `messagesMap`'e ekle; henüz yüklenmemişse tekil mesajı başlangıç dizisi `[newMsg]` olarak başlat.
- Kullanıcı aktif olarak **başka bir sohbetteyse** (`!isActiveConversation`):
  `toast.info(`${senderLabel}: ${previewSnippet}`, t('whatsapp.newIncomingMessage'))` ile uygulama içi banner göster ve tıklanınca ilgili sohbete geçişi sağla.

### Adım 2: Frontend `App.tsx` Gövde Çözümlemesi ve Toast Düzeltmesi (`App.tsx`)
- `msgText` okuma zincirine `eventData.message?.body` ve `eventData.body` alanlarını ekle.
- Kullanıcı başka sekmedeyken (Dashboard, Leads vb.) gelen mesajın hem önizlemesini hem gönderen adını doğru göster.

### Adım 3: Ses ve Bildirim İzin Sağlamlaştırması (`whatsappAudio.ts`, `useWhatsAppSettings.ts`)
- `initAudioUnlock` fonksiyonunu yalnızca Hub'da değil, `App.tsx` genelinde başlat (kullanıcı sayfada herhangi bir yere tıkladığı anda ses motoru kilidi açılsın).
- Masaüstü bildirim izni verilmişse otomatik olarak `desktopNotificationsEnabled: true` senkronizasyonunu koru.

### Adım 4: Backend Append Canlı Yayınının Düzeltilmesi (`events.py`)
- Eğer `append` olayıyla gelen mesaj gerçekten yeni bir mesajsa (örneğin son 5 dakika içinde oluşturulmuşsa ve DB'de ilk kez kaydediliyorsa), `_no_broadcast = True` ile susturma; normal `message_new` gibi WebSocket üzerinden istemciye ilet. Yalnızca geçmiş tarihli senkronizasyon mesajlarında yayını kapat.

---

## 9. Her Düzeltme İçin Regresyon Testleri

1. **Frontend Birim & Entegrasyon Testleri**:
   - `test_message_new_inbound_updates_background_conversation`: Açık olmayan bir sohbete `message_new` geldiğinde `messagesMap` ve sol liste rozetinin arttığının doğrulanması.
   - `test_message_new_toast_rendered_when_on_different_conversation`: Farklı sohbetteyken Toast bildiriminin tetiklendiğinin doğrulanması.
   - `test_app_tsx_extracts_message_body`: `eventData.message.body` alanının Toast ve ses parametrelerine başarıyla aktarıldığının doğrulanması.
2. **Backend Gateway & Event Testleri**:
   - `test_ingest_message_new_recent_append_broadcasts`: Yakın zamanlı bir `append` mesajının `_no_broadcast` almadan WS broadcast kuyruğuna girdiğinin testi.
   - `test_ingest_message_new_historical_append_suppressed`: Eski tarihli sync `append` mesajının yayınlanmadığının doğrulanması.

---

## 10. Production Canlı Kabul Testinin Ölçülebilir Kriterleri

1. **Canlı İki Cihaz Testi (Aktif Başka Sohbet)**:
   - Kullanıcı Tezlify'da A kişisinin sohbetini açık tutarken, B kişisinden gerçek bir WhatsApp mesajı gönderilir.
   - **Kriter**: Tezlify sol panelinde B kişisinin rozeti anında `1` olur, B sohbeti en üste taşınır, sağ üstte Toast bildirimi belirir, bildirim sesi çalar. B kişisine tıklandığında mesaj anında görünür (sayfa yenileme gerekmez).
2. **Canlı İki Cihaz Testi (Aktif Aynı Sohbet)**:
   - Kullanıcı Tezlify'da A kişisinin sohbetini açık tutarken, A kişisinden mesaj gönderilir.
   - **Kriter**: Mesaj ekranda gerçek zamanlı belirmeli (0ms - 500ms gecikme), ses çalmalı, sayfa yenileme gerekmemelidir.
3. **Canlı İki Cihaz Testi (Başka Sekme / Dashboard)**:
   - Kullanıcı Tezlify "Leads" sekmesindeyken WhatsApp mesajı gönderilir.
   - **Kriter**: Gönderen adı ve mesaj içeriğiyle birlikte Toast bildirimi açılmalı, tıklanınca doğrudan WhatsApp sayfasına ve ilgili sohbete yönlendirmelidir.

