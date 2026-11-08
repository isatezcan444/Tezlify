# TEZLIFY WHATSAPP — GERÇEK ZAMANLI MESAJ VE BİLDİRİM DÜZELTME RAPORU (AŞAMA 1, 1.1 & 1.2)

**Tarih:** 2026-11-08  
**Aşama:** Aşama 1.2 — Append Sınıflandırması, Deduplication ve Güvenlik Doğrulaması (Kapanış)  
**Karar:** `PASS — READY FOR COMMIT AUTHORIZATION`  
**Referans Kök Neden Raporu:** `reports/whatsapp-realtime-message-notification-root-cause.md`  

---

## 1. Başlangıç HEAD ve Çalışma Ağacı Durumu

- **Git Branch:** `main`
- **Başlangıç HEAD Commit:** `f3f2f4c07f785b5b309eea11662319a6f0a18711` (`fix(whatsapp): resolve view once and revoke ingestion edge cases`)
- **Çalışma Ağacı Durumu:** Yalnızca bu görevin kapsamında yer alan 7 kaynak dosya, 1 frontend test scripti ve analiz raporları mevcuttur. Önceki View Once ve Revoke düzeltmelerinin tamamı korunmuştur.
- **Git Diff Kontrolü:** `git diff --check` çalıştırılmış ve temiz (0 hata, 0 whitespace uyarısı) doğrulanmıştır.

---

## 2. Değiştirilen Dosyalar ve Değişiklik Gerekçeleri

| Dosya | Yapılan Değişiklik | Değişiklik Gerekçesi |
|---|---|---|
| `backend/app/services/whatsapp/orchestration/events.py` | (1) `_is_historical_sync_message()` fonksiyonundaki 15 dakika ve 24 saatlik keyfi yapay zaman eşikleri tamamen kaldırıldı; protokol ve açık metadata tabanlı kesin modele geçildi.<br/>(2) `SyncJob` eşleşmesi kesin `sync_id` eşitliği ve `not active_job.done.is_set()` kontrolüyle izole edildi.<br/>(3) Dedup aşamasında `canonical is not None` iken değişen içerik (`content_changed`) canlı yayınlanacak, değişmeyen tekrarlar (`content_changed = False`) ise `_no_broadcast = True` ile susturulacak şekilde ayrıştırıldı. | Gecikmeli gelen (telefon kapalı, uçak modunda veya çekim yokken biriken) gerçek mesajların susturulmasını engellemek; arka planda bağımsız SyncJob çalışırken canlı mesaj akışını korumak; Baileys retry decrypt sonrası güncellenen içeriklerin UI'a yansımasını sağlamak. |
| `backend/tests/test_whatsapp_upsert_append.py` | Aşama 1.1 ve 1.2 için toplam 11 yeni test eklendi (toplam test sayısı 17'den 28'e çıkarıldı). SyncJob izolasyonu, gecikmeli mesajlar, içerik değişimi yayını, duplicate susturma ve DB commit failure enjeksiyonu doğrulandı. | Backend mesaj ayrımı, dedup mantığı ve hata anında fail-closed NACK/broadcast izolasyonunun uçtan uca doğrulanması. |
| `frontend/src/features/whatsapp/hooks/useWhatsAppSettings.ts` | `getStoredSettings()` içindeki `desktopNotificationsEnabled` mantığı düzeltildi; `requestNotificationPermission()` ve `notifyInbound()` fonksiyonları güncellendi. | Tarayıcıda `Notification.permission === 'granted'` olsa bile kullanıcının `desktopNotificationsEnabled: false` tercihinin çiğnenmesini önlemek; `denied` durumunda gereksiz izin sorma döngüsünü engellemek. |
| `frontend/src/features/whatsapp/lib/whatsappAudio.ts` | `initAudioUnlock()` referans sayaçlı hale getirildi (`activeUnlockSubscribers`); `click`, `pointerdown`, `keydown`, `touchstart` dinleyicileri bağlandı; `soundEnabled: false` iken Web Audio çağrısı engellendi. | Web Audio API AudioContext'in ilk yüklemede askıda (`suspended`) kalmasını kullanıcı etkileşimiyle global olarak güvenle açmak ve ses kapalıyken sessizliği garantilemek. |
| `frontend/src/context/ToastContext.tsx` | `ToastItem`, `toast.show` ve `toast.info` fonksiyonlarına opsiyonel `onClick?: () => void` parametresi eklendi; toast gövdesine tıklama desteği sağlandı. | Başka sekmedeyken veya başka sohbetteyken gelen toast bildirimine tıklandığında kullanıcının doğrudan ilgili WhatsApp sohbetine gitmesini sağlamak. |
| `frontend/src/App.tsx` | Global seviyede `initAudioUnlock()` bağlandı; `message_new` handler'ında mesaj gövdesi (`message.body`, `media_caption`, medya emojileri) zenginleştirildi; `activeTab !== 'whatsapp'` iken toast ve ses üretildi; toast tıklandığında `tezlify:select_conversation` olayı tetiklendi. | Kullanıcı Leads, Campaigns, Dashboard gibi diğer sekmelerdeyken WhatsApp mesajının eksiksiz önizleme metniyle toast olarak bildirilmesi ve tıklamayla sohbete geçilmesi. |
| `frontend/src/pages/WhatsAppHubPage.tsx` | `setMessagesMap` içinde `prev[targetConvId]` şartı kaldırılarak açılmamış sohbet mesajlarının da state'te unconditionally birleştirilmesi sağlandı; `tezlify:select_conversation` dinleyicisi eklendi; kullanıcı WhatsApp sekmesinde ama farklı bir sohbetteyken in-app toast gösterildi. | Aktif olmayan ve henüz açılmamış sohbetlere gelen mesajların kaybolmasını engellemek; WhatsApp içindeyken farklı sohbet mesajını toast ile bildirmek. |
| `frontend/scripts/verify-realtime-message-notification.mjs` | Frontend için esbuild ile gerçek modülleri derleyip JSDOM üzerinde çalıştıran otomatik test paketi oluşturuldu. | Arka plan sohbet mesaj saklama, REST hydration dedup, AudioContext kilit açma, toast onClick ve ayar bütünlüğünü doğrulamak. |

---

## 3. Aşama 1.2 — Hedefli Güvenlik ve Doğrulama Kanıtları

### 3.1. Zaman Eşiği Kurallarının (15 Dakika ve 24 Saat) Kaldırılması
- **Protokol Kanıtı:** Baileys protokolünde ve WhatsApp Web mimarisinde gelen bir mesajın `append` türünde olması, o mesajın eski veya önemsiz bir geçmiş senkronizasyonu olduğunu kanıtlamaz.
- **Canlı Senaryo:** Kullanıcının telefonu şarjı bittiğinde, uçak modundayken veya kapsama alanı dışındayken kapalı kalabilir. Telefon açıldığında veya ağa bağlandığında biriken mesajlar Baileys soketine topluca `append` olarak akar. Bu mesajlar Tezlify veri tabanına ilk kez girmektedir ve kullanıcının mutlaka görüp yanıtlaması gereken gerçek mesajlardır.
- **Kaldırılma Gerekçesi:** 15 dakikalık veya 24 saatlik yapay bir zaman damgası kuralı, gecikmeli teslim edilen bu gerçek canlı mesajların "tarihsel" sayılarak UI'da susturulmasına yol açıyordu. DB'ye ilk kez giren bir mesajın sırf timestamp yaşı büyük veya eksik diye susturulması canlı mesaj kaybı riski oluşturduğu için kaldırılmıştır.
- **Uygulanan Kesin Kural:** Yalnızca açık senkronizasyon metadata'sı (`is_sync`, `history_sync`, `source="history"`) taşıyan veya aktif `SyncJob`'a ait geçerli `sync_id` içeren mesajlar tarihsel sayılır. Bunun dışındaki her yeni varış canlı yayınlanır.

### 3.2. Gateway Event Payload Sözleşmesi ve SyncJob Kapsam İzolasyonu
- **Gateway Sözleşmesi (`whatsapp-gateway/src/session-manager.js:3728`):**
  Gateway `messages.upsert` olayını şu şekilde yayınlar:
  ```json
  {
    "event": "message_new",
    "conversation_id": "905xxxxxxxxx@s.whatsapp.net",
    "message": { "wa_message_id": "...", "body": "...", "direction": "INBOUND" },
    "unread_count": 1,
    "upsert_type": "append",
    "event_id": "uuid"
  }
  ```
  Gateway normal upsert olaylarında `sync_id` veya `is_sync` alanı **üretmez**.
- **SyncJob Mimarisi:** `SyncJob`, Backend'in HTTP üzerinden başlattığı bir geçmiş mesaj çekme işlemidir (`_sync_jobs`).
- **Kapsam İzolasyonu:**
  - Eğer event `sync_id` taşımıyorsa, arka planda bir `SyncJob` yürüyor olsa bile gelen mesaj canlı kabul edilir ve yayınlanır (`test_live_append_not_suppressed_by_active_sync_job`).
  - Eğer event açıkça bir `sync_id` taşıyorsa, yalnızca kullanıcının aktif yürüyen işiyle (`state == "SYNCING"` ve `not active_job.done.is_set()`) birebir eşleştiğinde susturulur (`test_syncjob_matching_sync_id_suppressed`).
  - Mismatched (başka işe ait), bayat (tamamlanmış) veya geçersiz `sync_id` taşıyan mesajlar asla susturulmaz (`test_syncjob_mismatched_sync_id_not_suppressed`, `test_invalid_or_stale_sync_id_does_not_suppress_live_message`).

### 3.3. Deduplication ve Değişen İçerik (Changed Content) Ayrımı
Backend `_handle_message_new` içinde `canonical is not None` (mesaj zaten DB'de var) durumunda iki farklı yol işletilir:
1. **İçerik Değiştiyse (`content_changed = True`):**
   - Baileys retry decrypt sonrasında boş/yer tutucu gövdenin gerçek metinle güncellenmesi veya View Once yer tutucusunun medya başlığıyla güncellenmesi senaryolarında:
   - Mesaj tarihsel bir senkronizasyon değilse, güncellenen yeni içerik **WebSocket üzerinden yayınlanır** (`_no_broadcast` atanmaz). Böylece kullanıcının ekranındaki yer tutucu anında gerçek mesaja dönüşür (`test_duplicate_same_wa_id_changed_content_is_broadcast`).
2. **İçerik Değişmediyse (`content_changed = False`):**
   - Aynı `wa_message_id` ile gelen mükerrer varışlarda veya sadece teslimat durumu (`status=DELIVERED`) güncellemelerinde:
   - `event["_no_broadcast"] = True` atanarak ikinci kez bildirim, toast veya ses üretilmesi kesin olarak engellenir (`test_duplicate_live_append_suppresses_second_broadcast`, `test_status_only_update_does_not_re_broadcast`).

### 3.4. DB Commit Başarısızlığı ve Broadcast Sıralaması
- **Mimari Güvence (`backend/app/main.py:770-802`):**
  Gateway'den gelen her olay önce `persisted = await whatsapp_service.ingest_gateway_event(event_data)` ile veri tabanına işlenir ve commit edilir.
  Yalnızca `persisted` başarıyla tamamlandıktan ve `not persisted.get("_no_broadcast")` doğrulandıktan sonra `ws_manager.broadcast()` çağrılır.
- **Hata Enjeksiyonu Testi (`test_db_commit_failure_prevents_broadcast_and_nacks`):**
  - DB commit aşamasında `SQLAlchemyError("DB connection dropped")` fırlatıldığında:
  - `ws_manager.broadcast()` **ASLA çağrılmamıştır** (`broadcast_mock.assert_not_awaited()`).
  - Gateway soketine kalıcı hata bildiren NACK mesajı iletilmiştir (`{"type": "gateway_event_nack", "event_id": ..., "permanent": True}`).
  - Hata temizlendikten sonraki yeniden denemede mesaj başarıyla işlenmiş ve tekil satır olarak veri tabanına kaydedilmiştir.

---

## 4. Frontend Davranış Kontrolleri

1. **Henüz Açılmamış Sohbet Mesajları:** `WhatsAppHubPage.tsx` içinde `setMessagesMap((prev) => ({ ...prev, [targetConvId]: mergeWhatsAppMessages(prev[targetConvId] || [], [newMsg]) }))` ile henüz kullanıcının tıklamadığı sohbetlerin mesajları da state'te eksiksiz saklanır.
2. **REST Hydration Dedup:** Kullanıcı ilgili sohbeti açtığında REST'ten gelen mesajlar `mergeWhatsAppMessages` tarafından `wa_message_id` anahtarıyla eşleştirilir; duplicate satır oluşmaz, sıralama korunur.
3. **Tekil Toast Bildirimi:**
   - WhatsApp sekmesi dışındayken: Sorumlu `App.tsx`'tir. Tek bir toast çıkar.
   - WhatsApp sekmesindeyken: Kullanıcı o sohbetteyse 0 toast (balon canlı akar). Başka sohbetteyse sorumlu `WhatsAppHubPage.tsx`'tir ve tek bir in-app toast çıkar.
4. **Toast Tıklama Navigasyonu:** Toast tıklandığında `handleNavigate('whatsapp', { conversationId })` çağrılır ve `tezlify:select_conversation` özel olayı fırlatılarak ilgili konuşma anında açılır.
5. **ToastContext onClick:** `onClick?: () => void` parametresi tamamen opsiyoneldir; diğer sayfalardaki mevcut toast çağrılarını hiçbir şekilde etkilemez.
6. **Audio Unlock Referans Sayacı:** `initAudioUnlock()` referans sayaçlıdır. Sayfa yaşam döngüsünde birden fazla bileşen bağlansa bile dinleyiciler (`click`, `pointerdown`, `keydown`, `touchstart`) çoğalmaz ve erken temizlenmez.
7. **Desktop Notification Tercihi:** `desktopNotificationsEnabled: false` tercihi tarayıcı izninden bağımsızdır. Tarayıcıda izin verilmiş olsa dahi kullanıcı tercihi kapalıysa masaüstü bildirimi tetiklenmez. İzin reddedilmişse (`denied`), tekrar tekrar izin isteme döngüsüne girilmez.

---

## 5. Doğrulanan Senaryolar ve Test Matrisi

Aşağıdaki tabloda uçtan uca doğrulanan tüm senaryolar ve test sonuçları listelenmiştir:

| No | Hedef Senaryo | Doğrulandığı Test / Mekanizma | Exit Code | Durum |
|:---:|---|---|:---:|:---:|
| 1 | Farklı sohbete gelen yeni mesaj state'e eklenir | `verify-realtime-message-notification.mjs` (Scenario 1) | `0` | **PASS** |
| 2 | REST hydration aynı mesajı tekrar eklemez | `verify-realtime-message-notification.mjs` (Scenario 2) & `verify:merge` | `0` | **PASS** |
| 3 | Duplicate WebSocket event ikinci toast üretmez | `verify-realtime-message-notification.mjs` (Scenario 3) & `rememberWaMessageId` | `0` | **PASS** |
| 4 | Toast tıklaması doğru sohbeti seçer | `verify-realtime-message-notification.mjs` (Scenario 4) & `tezlify:select_conversation` | `0` | **PASS** |
| 5 | desktopNotificationsEnabled=false iken browser izni granted olsa bile masaüstü bildirimi çıkmaz | `verify-realtime-message-notification.mjs` (Scenario 5) | `0` | **PASS** |
| 6 | AudioContext kilit açma referans sayacı dinleyicileri çoğaltmaz | `verify-realtime-message-notification.mjs` (Audio unlock ref count) | `0` | **PASS** |
| 7 | `append` ile gelen gerçek canlı yeni mesaj yayınlanır | `backend/tests/test_whatsapp_upsert_append.py::test_recent_live_append_is_broadcastable` | `0` | **PASS** |
| 8 | Gecikmeli teslim edilen (> 2 saat) canlı append mesajı yayınlanır | `backend/tests/test_whatsapp_upsert_append.py::test_delayed_delivery_append_is_broadcastable` | `0` | **PASS** |
| 9 | Açık senkronizasyon bayrağı taşıyan mesaj susturulur | `backend/tests/test_whatsapp_upsert_append.py::test_sync_flag_append_suppresses_broadcast` | `0` | **PASS** |
| 10 | Aktif SyncJob ile eşleşen sync_id susturulur | `backend/tests/test_whatsapp_upsert_append.py::test_syncjob_matching_sync_id_suppressed` | `0` | **PASS** |
| 11 | Farklı / eşleşmeyen sync_id canlı mesajı susturmaz | `backend/tests/test_whatsapp_upsert_append.py::test_syncjob_mismatched_sync_id_not_suppressed` | `0` | **PASS** |
| 12 | Geçersiz veya tamamlanmış sync_id canlı mesajı susturmaz | `backend/tests/test_whatsapp_upsert_append.py::test_invalid_or_stale_sync_id_does_not_suppress_live_message` | `0` | **PASS** |
| 13 | SyncJob aktifken gelen bağlantısız canlı append mesajı yayınlanır | `backend/tests/test_whatsapp_upsert_append.py::test_live_append_not_suppressed_by_active_sync_job` | `0` | **PASS** |
| 14 | Aynı wa_message_id ile içerik değiştiğinde (retry decrypt) broadcast edilir | `backend/tests/test_whatsapp_upsert_append.py::test_duplicate_same_wa_id_changed_content_is_broadcast` | `0` | **PASS** |
| 15 | Aynı wa_message_id ve aynı içerikte duplicate varış susturulur | `backend/tests/test_whatsapp_upsert_append.py::test_duplicate_live_append_suppresses_second_broadcast` | `0` | **PASS** |
| 16 | Status-only duplicate varış ikinci kez broadcast edilmez | `backend/tests/test_whatsapp_upsert_append.py::test_status_only_update_does_not_re_broadcast` | `0` | **PASS** |
| 17 | DB commit hatası enjekte edildiğinde broadcast yapılmaz ve kalıcı NACK gönderilir | `backend/tests/test_whatsapp_upsert_append.py::test_db_commit_failure_prevents_broadcast_and_nacks` | `0` | **PASS** |
| 18 | View Once ve Revoke regresyon koruması | `test_view_once_reply_quote.py` & `test_view_once_revoke_tombstone.py` (10 test) | `0` | **PASS** |
| 19 | Frontend TypeScript ve üretim paketi derlemesi | `cd frontend && npm run build` (tsc && vite build) | `0` | **PASS** |
| 20 | Git diff sözdizimi, whitespace ve çakışma temizliği | `git diff --check` | `0` | **PASS** |

---

## 6. Test Komutları ve Gerçek Çıktı Özeti

| Test Paketi / Komut | Kapsam | Exit Code | Gerçek Sonuç |
|---|---|:---:|:---:|
| `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_upsert_append.py -v` | Backend append/notify, sync, SyncJob izolasyonu, dedup ve DB failure testleri | `0` | **28 passed in 1.55s** |
| `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_view_once_reply_quote.py backend/tests/test_view_once_revoke_tombstone.py -v` | View Once ve Revoke regresyon koruması | `0` | **10 passed in 0.47s** |
| `node frontend/scripts/verify-realtime-message-notification.mjs` | Frontend ayarlar, ses, toast ve state birleştirme runtime doğrulaması | `0` | **8 checks passed** |
| `cd frontend && npm run build` | Frontend TypeScript derlemesi ve Vite production bundle üretimi | `0` | **✓ built in 3.17s (0 hata)** |
| `git diff --check` | Git diff sözdizimi, whitespace ve çakışma kontrolü | `0` | **Temiz (0 uyarı/hata)** |

---

## 7. Kalan Dışsal Riskler ve Değerlendirmeler

1. **İşletim Sistemi ve Tarayıcı Arka Plan Uyku Modu (Tab Sleep / Resource Throttling):**  
   Bir sekme işletim sistemi tarafından arka planda uyutulduğunda (`hibernation`), tarayıcı WebSocket timer ve ses işlemlerini geçici olarak askıya alabilir. Sekme tekrar odaklandığında frontend'in mevcut WebSocket liveness bekçisi soketi anında yenileyip eksik mesajları REST üzerinden tamamlar.
2. **Kullanıcı Etkileşimi Öncesi Autoplay Kısıtlaması:**  
   Kullanıcı Tezlify sayfasını açıp henüz hiçbir yere tıklamamışken gelen ilk mesajda Web Audio API ses çalmayabilir (tarayıcı güvenlik standardı). Kullanıcının sayfadaki ilk tıklaması veya tuş basımı ile AudioContext kilidi kalıcı olarak açılmaktadır.

---

## 8. Nihai Karar

### **`PASS — READY FOR COMMIT AUTHORIZATION`**

Aşama 1, 1.1 ve 1.2 kapsamındaki tüm kök neden düzeltmeleri, yapay eşiklerin kaldırılması, SyncJob kapsam izolasyonu, duplicate vs içerik değişimi ayrımı, fail-closed DB commit güvencesi ve frontend bildirim/ses entegrasyonu başarıyla tamamlanmıştır.

Tüm testler yeşildir (`Exit code: 0`). Sistem commit, GitHub'a push ve production deploy işlemleri için hazırdır ve kullanıcıdan açık onay beklenmektedir.
