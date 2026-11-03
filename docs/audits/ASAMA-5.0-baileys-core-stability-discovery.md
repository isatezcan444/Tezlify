# AŞAMA 5.0 — BAILEYS CORE STABILITY & WHATSAPP WEB BEHAVIORAL PARITY
## Kapsam Keşfi, Mimari Analiz ve Uygulama Planı

**Durum:** Analiz tamamlandı. **Kod değiştirilmedi.**
**Tarih:** 2026-11-01
**Kapsam:** `whatsapp-gateway/` (Baileys 7.0.0-rc14) + `backend/app/services/whatsapp/` + `frontend/src/features/whatsapp/`
**Yöntem:** Yalnızca read-only kod okuma, `git grep`, listener envanteri, sabit doğrulama. Hiçbir container'a dokunulmadı, hiçbir DB sorgusu yazma yapmadı.

> **Bu raporun kanıt kuralı:** Kodda görülmeyen davranış "yok" olarak yazılmadı; **kanıtlanamayan** her şey `UNVERIFIED` olarak işaretlendi. Bir davranışın var olduğunu iddia etmek için dosya:satır kanıtı verildi.

---

## 1. Yönetici Özeti

Gateway, Baileys üzerinde **14 socket olayını** dinliyor ve **24 farklı olay adı** yayınlıyor. Backend bu 24 olaydan **23'ünü** yönlendiriyor; **1 tanesi (`gateway_connected`) karşılıksız** ve her köprü bağlantısında `ERROR` seviyesinde log üretiyor. Frontend bu olayı dinliyor — yani **ölü bir tetikleyici** var.

Core stability tarafında en güçlü yapı **socket nesli (generation) koruması** ve **lease koordinasyonu**; en zayıf nokta **grup katılımcı değişikliklerinin hiç dinlenmemesi** ve **`messages.upsert` tip ayrımının yapılmaması**.

Üç ayrı kod ağacı birbirinden farklı (bkz. §2.1) — bu, raporun en önemli metodolojik uyarısı.

| Başlık | Sonuç |
| --- | --- |
| Dinlenen socket olayı | **14** (deployed ağaçta doğrulandı) |
| Yayınlanan olay adı | **24** |
| Backend'de karşılığı olmayan olay | **1** (`gateway_connected`) |
| P0 risk | **2** |
| P1 risk | **5** |
| P2 risk | **6** |
| P3 risk | **4** |
| Gateway test script'i | **38** (npm `test` zinciri) |
| Backend WhatsApp test dosyası | **76** / 157 toplam |
| Frontend test dosyası | **0** |
| Parite: `IMPLEMENTED` | **11** / 28 |
| Parite: `PARTIAL` | **7** / 28 |
| Parite: `MISSING` | **10** / 28 |

---

## 2. Baseline Durum Doğrulaması (read-only)

### 2.1 Üç ayrı ağaç — kritik metodolojik uyarı

Bu aşamada **en önemli bulgu**, analiz edilen kodun production ile birebir aynı olmamasıdır:

| Ağaç | Referans | Gateway durumu |
| --- | --- | --- |
| `main` HEAD | `7afb540` | seq/epoch kodu **yok** |
| Çalışma ağacı (dirty) | `7afb540` + 77 değişiklik | seq/epoch kodu **var** (commit edilmemiş) |
| **Deployed** | `0b795ea` (gateway @ `20c88bb`) | production'da çalışan |

`git merge-base --is-ancestor 20c88bb HEAD` → **NOT_ANCESTOR**. Yani deploy edilen gateway commit'i `main`'in atası **değil**; ayrı bir hat.

`git diff --stat 0b795ea HEAD -- whatsapp-gateway/` → **10 dosya, 620 ekleme / 1216 silme.** `main`'de deploy edilen koda göre `message-store.js` (−291), `session-manager.js` (349 fark), `socket-events.js` (100 fark) ve **753 satırlık iki seq-pagination test script'i eksik**.

**Bu raporun konumu:** Aşağıdaki tüm satır numaraları **çalışma ağacına** aittir (Read tool çalışma ağacını okur). Çalışma ağacı deployed'a `main`'den daha yakın ama **birebir aynı değil** (deployed'a göre +604/−766).

**Taşıyıcı doğrulama:** Parite matrisinin dayanağı olan **listener seti üç ağaçta da aynı**. Deployed ağaçta doğrudan sayıldı:

```
git grep -cE "sock\.ev\.on\('" 0b795ea -- whatsapp-gateway/src/socket/socket-events.js
→ 14
```

Ve `git diff 0b795ea HEAD -- socket-events.js` çıktısında **eklenen/silinen tek bir `sock.ev.on` satırı yok**. Dolayısıyla "hangi olay dinleniyor" sorusunun cevabı production için geçerlidir.

### 2.2 Deployed referanslar

| Öğe | Değer | Kaynak |
| --- | --- | --- |
| Deployed commit | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` | release branch |
| Gateway commit | `20c88bb` — "implement epoch-aware sequence pagination" | `git log 0b795ea -- whatsapp-gateway/` |
| Baileys | `7.0.0-rc14` | `whatsapp-gateway/package.json` |
| Gateway kaynak | 26 dosya / **11 503** satır | `wc -l src/**/*.js` |
| En büyük dosya | `session-manager.js` **4 530** satır | — |

### 2.3 Gateway kaynak dağılımı (ilk 10)

| Dosya | Satır |
| --- | --- |
| `src/session-manager.js` | 4 530 |
| `src/socket/socket-events.js` | 1 341 |
| `src/index.js` | 868 |
| `src/messages/message-classifier.js` | 559 |
| `src/messages/message-store.js` | 529 |
| `src/events.js` | 416 |
| `src/auth/postgres-auth-repository.js` | 384 |
| `src/media/media-store.js` | 327 |
| `src/socket/socket-connector.js` | 320 |
| `src/utils/whatsapp-identity.js` | 279 |

---

## 3. Runtime Mimari Haritası — 20 Alan

Her alan için: **dosya:satır**, veri akışı, hata yönetimi, retry, idempotency, persistence, mevcut test, tespit edilen boşluk.

### 3.1 Bağlantı yaşam döngüsü (socket lifecycle)

**Dosya:** `session-manager.js:4320-4526`, `socket/socket-events.js:207-608`, `domain/socket-lifecycle.js` (58 satır)

**Akış:** `_startSocket(id)` → `_connectSocket(id)` → `lifecycle.beginAttempt()` (monoton `_generation`) → `leaseCoordinator.acquireLease()` → `createSocketForSession()` → `lifecycle.attach(generation, sock)` → `bindSocketEvents()`.

**Nesil koruması (en güçlü yapı):** Her async sınırından sonra `lifecycle.isCurrent(generation, sock)` kontrol edilir. Bayat soket `attach` edilirse `removeAllListeners()` + `end()` ile öldürülür (`4431-4464`). `_connectSocket` içinde `_reconnectTimer !== null` ise **ikinci bağlantı açılmaz** (`4357-4360`).

**Hata yönetimi:** `_startSocket` catch → `status='UNAVAILABLE'`, `error_message='WHATSAPP_AUTH_STORE_UNAVAILABLE'`, retry `min(15_000, 2_000 * 2^min(failures,3))` (`4337`).

**Lease:** `acquireLease` contended ise callback 5–6 s sonra tekrar dener; callback **canlı session'ı yeniden okur** ve nesil eşleşmezse çıkar (`4368-4385`). `loseLease` da aynı çift kontrolü yapar (`4469-4495`).

**Boşluk:** Lease kaybı `error_reason` alanını set etmiyor (`error_message` set ediliyor) — `session_disconnected` olayı yayınlanmıyor, sadece `diagnostic()`. UI bu durumu **göremez**. → **R-11 (P2)**

**Test:** `test-orphan-session.mjs`, `test-appstate-rearm.mjs`, backend `test_whatsapp_phase1_1_lease_truthfulness.py`. Reconnect/backoff için **doğrudan test yok**.

---

### 3.2 QR eşleştirme

**Dosya:** `socket-events.js` `connection.update` içinde `qr` dalı; `session_qr_updated` olayı.

**Akış:** Baileys `qr` → gateway `session.qr_code` + `session_qr_updated` olayı → backend `_map_session_event` → `row.status = SCAN_QR`, `row.qr_code`.

**Önemli tasarım:** Ephemeral pairing'de **DB satırı yoktur**; QR kalıcı yazılmaz, UI doğrudan socket'ten gösterir (`events.py:2359-2362` yorumu).

**Retry:** Pairing sırasında QR görülmeden bağlantı 3 kez kesilirse (`maxAttempts = 3`, `socket-events.js:566`) `error_reason='WA_CONNECTION_TERMINATED'` + `connection_error` olayı.

**Test:** `test_whatsapp_phase6_4_pairing.py`, `test_whatsapp_phase6_5_qr_live_seam.py`, `test_whatsapp_pairing_tombstone.py`, `test_whatsapp_phase6_8_promotion.py`.

**Boşluk:** QR'ın **süre sonu** (expiry) yönetimi yok; Baileys yeni QR üretir, gateway eskisini geçersiz kılmaz. → **R-13 (P2)**

---

### 3.3 Kimlik doğrulama ve creds kalıcılığı

**Dosya:** `auth/postgres-auth-repository.js` (384), `auth/encrypted-codec.js` (55), `socket-connector.js` `state.keys.set` intercept.

**Akış:** `creds.update` (`socket-events.js:191`) → `saveCreds()` → PG `whatsapp_private` şeması, AES ile şifreli. Signal anahtarları (`state.keys.set`) hem dosyaya hem PG'ye yazılır.

**LID yakalama:** `state.keys.set` içinde `lid-mapping` girdileri yakalanıp `applyDiscoveredLidMapping` çağrılıyor (`socket-connector.js`). Bu, LID↔PN köprüsünün **birincil** kaynağı.

**Persistence:** `session.ephemeral` ise DB yazımı atlanır (FK yok).

**Test:** `test-gateway-auth.mjs`, backend `test_whatsapp_phase6_*`.

**Boşluk:** Anahtar yazımı başarısız olursa **sessizce** devam ediliyor (`catch {}` desenleri). Bozuk bir creds set'i ancak sonraki bağlantıda `badSession` olarak ortaya çıkar. → **R-08 (P1)**

---

### 3.4 Şifre çözme ve retry

**Dosya:** `socket-connector.js` — `msgRetryCounterCache`, `getMessage: key => lookupRawMessage(store, key)`.

**Akış:** Baileys mesajı çözemezse `getMessage` ile ham mesajı ister (retry receipt akışı) → `lookupRawMessage` RAM'deki `rawMessagesByChat`'ten döner (chat başına **500** ham mesaj, `message-store.js`).

**Kritik bağımlılık:** Retry yalnızca **RAM'de** çalışır. Gateway yeniden başlarsa ham mesajlar kaybolur ve o mesajlar **kalıcı olarak çözülemez**. Bu A6 invariantının doğrudan sonucu.

**Boşluk:** `rawMessagesByChat` chat başına 500 ile sınırlı; yoğun bir grupta retry penceresi 500 mesajdan sonrasını kapsamaz. → **R-05 (P1)**

---

### 3.5 `messages.upsert`

**Dosya:** `socket-events.js:608-630` → `session-manager.js:2468-2743`

**Kritik bulgu:** Handler **`type` alanına göre dallanmıyor**:

```js
sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
  for (const msg of newMessages || []) {
    await manager._ingestUpsertMessage(msg, sock, id);   // type kullanılmıyor
```

`type` yalnızca hata teşhisinde (`615-621`) okunuyor. Sonuç: Baileys'in `append` tipiyle gönderdiği **çevrimdışı birikmiş mesajlar** de canlı `message_new` gibi işleniyor ve `message_new` olayı yayınlanıyor. WhatsApp Web bunları "yeni mesaj" olarak göstermez, geçmişe ekler. → **R-02 (P0)**

**İdempotency:** `wa_message_id` üzerinden mevcut kayıt aranır (`2585-2587`). Duplicate ise "içerik değişikliği var mı" kontrolü yapılır: placeholder / `hasContentChange` / `hasMediaUpgrade` yoksa **düşürülür** (`2593-2599`). Bu doğru bir tasarım.

**Placeholder yükseltme:** Medyasız placeholder varsa `splice` ile silinip gerçek kayıt ekleniyor (`2703-2708`) — tek `wa_message_id` garantisi korunuyor.

**Sıra:** `stampMessageSeq` + `trimChatMessages` + `boundMessagesByChat` (`2709-2711`).

**LID hold:** `lidHold` true ise mesaj **hiç yayınlanmaz** ve unread sayacı artmaz (`2726-2741`). Yorum, production'da gateway `unread_count=2` ↔ backend `1` uyuşmazlığının nedenini belgeliyor.

**Boşluk:** `lidHold` mesajı RAM'e yazılıyor ama olay yayınlanmıyor; LID eşlemesi **hiç gelmezse** mesaj kalıcı olarak sessiz kalır. TTL / fallback yok. → **R-03 (P0)**

---

### 3.6 Mesaj deposu ve kapasite

**Dosya:** `messages/message-store.js` (529)

| Sabit | Değer | Satır |
| --- | --- | --- |
| `RAW_MESSAGE_STORE_MAX` | 10 000 | — |
| `MESSAGES_BY_CHAT_MAX_CHATS` | 300 | — |
| `MESSAGES_PER_CHAT_MAX` | 2 000 | — |
| Chat başına ham mesaj | 500 | — |

**`_seq` modeli:** `stampMessageSeq` monoton ekleme sırası verir, `enumerable: false` → **JSON API/WS payload'ına sızmaz**. `storeSeqEpoch` süreç başına UUID döner; backend epoch değişiminde `after_seq = 0` yapar → güvenli yeniden tarama, veri kaybı değil.

**Eviction:** `recordEviction()` PII içermez (chat key/JID loglanmaz).

**Boşluk:** Kapasite aşımı **sessizdir** (yalnızca diagnostic). Kullanıcı "eski mesajlar kayboldu" der ama sistem bunu olay olarak bildirmez. → **R-06 (P2)**

**Test:** `test-bounded-messages-by-chat.mjs`, `test-bounded-cache.mjs`, `test-bulk-seq-pagination*.mjs` (deployed'da var, main'de yok).

---

### 3.7 Presence ve bildirim koruması

**Dosya:** `socket-connector.js` — `markOnlineOnConnect: false`, `sock.sendNode` intercept, `setCompanionActive()` (`303`)

**Invariant:** Birincil telefonun push bildirimleri korunmak için presence **zorla `unavailable`** yapılır. `sendNode` sarmalanarak `presence` stanza'ları `unavailable`'a çevrilir.

**Keepalive:** 60 s'de bir `unavailable` yeniden beyan edilir + `<iq xmlns="passive"><active/></iq>` gönderilir (`socket-events.js:465-473`). Yorum: `<passive/>` gerçek zamanlı akışı **durduracağı** için `<active/>` kullanılıyor.

**Abonelik:** `_ensurePresenceSubscribed` (`session-manager.js:1860-1870`) — chat başına 5 dk TTL'li set, `presenceSubscribe` best-effort.

**Test:** `test-phone-notifications-presence.mjs` (13 assertion) — `sendNode` intercept'ini doğruluyor.

**Boşluk:** Keepalive `setInterval`'ının temizlenmesi `connection.update` close dalında; **nesil kontrolü yok**. Bayat soketin interval'i yeni sokete `setCompanionActive` gönderebilir. → **R-09 (P2)**

---

### 3.8 Kişiler (contacts)

**Dosya:** `session-manager.js:2745-2789` (`_ingestContactUpdates`), `socket-events.js:705-765`

**Akış:** `contacts.update` / `contacts.upsert` → `mergeContactName` öncelik zinciri (`addressbook` > `verified` > `push`) → `contact_synced` olayı.

**LID:** `lidHold` true ise `contact_synced` yayınlanmaz (LID kişisi sızdırılmaz).

**Avatar:** `imgUrl === 'changed'` → `_enqueueAvatarQuery(priority: 'high', force: true)`.

**Test:** `test-contact-cache.mjs`, `test-contact-hydration.mjs`, `test-whatsapp-avatar-*`, backend `test_whatsapp_faz8_names.py`.

---

### 3.9 Sohbetler ve sıralama

**Dosya:** `session-manager.js:3109-3149` (`_touchChat`), `socket-events.js:765` (`chats.update`), `message-store.js` `resolveChatActivitySeconds`

**Invariant (A4):** Sohbet listesi sırası = **mutlak** son mesaj, "son alınan" değil. `resolveChatActivitySeconds` önceliği: `conversationTimestamp` → `lastMsgTimestamp` → `newest.timestamp_s` → `lastMessageRecvTimestamp`.

**Monotonluk:** `_touchChat` içinde `tsOlder` ise `last_message_at` **geri çekilmez** (`3117-3119`). Aynı kural history sync'te de var (`socket-events.js:1102-1104`).

**Arşiv:** `archivedPatch()` — bilinmiyorsa anahtar **hiç gönderilmez** (`3113`, `3130`).

**Boşluk:** `_touchChat` `unread_count: existing.unread_count || 0` yazıyor (`3133`) — `|| 0` **0'ı falsy sayar**, ama burada 0 doğru değer olduğu için sonuç aynı. Yine de `??` yerine `||` kullanımı ileride tuzak. → **R-16 (P3)**

**Test:** `test-chat-activity-order.mjs`, `test-archive-state-contract.mjs`, `test-unread-count-*.mjs`, backend `test_whatsapp_chat_discovery_parity.py`.

---

### 3.10 Gruplar — **EN BÜYÜK BOŞLUK**

**Dosya:** `socket-events.js:1224-1253` (`groups.update`), `session-manager.js:4070` (`groupParticipantsUpdate` — yalnızca **giden** API)

**Dinlenen:** `groups.update` — **yalnızca `subject`** işleniyor:

```js
const subject = typeof update?.subject === 'string' ? update.subject.trim() : '';
if (!jid || !jid.includes('@g.us') || !subject) continue;   // subject yoksa TAMAMEN atlanır
```

**Dinlenmeyen (deployed ağaçta doğrulandı, 14 listener içinde yok):**

| Olay | Durum | Sonuç |
| --- | --- | --- |
| `group-participants.update` | **YOK** | Telefondan biri gruba eklendiğinde/çıktığında CRM'e **hiç yansımaz** |
| `groups.upsert` | **YOK** | Yeni grup yalnızca ilk mesajla veya `_pendingGroupJids` fallback'iyle keşfedilir |
| `chats.upsert` | **YOK** | Mesajsız yeni sohbet keşfedilmez |

**Kanıt:**
```
git grep -cE "sock\.ev\.on\('" 0b795ea -- whatsapp-gateway/src/socket/socket-events.js → 14
Liste: chats.delete, chats.phoneNumberShare, chats.update, connection.update,
       contacts.update, contacts.upsert, creds.update, groups.update,
       message-receipt.update, messages.delete, messages.update, messages.upsert,
       messaging-history.set, presence.update
```
`group-participants`, `groups.upsert`, `chats.upsert` **listede yok**.

**Fallback:** `_touchChat` içinde `session._pendingGroupJids` set'i (`3143-3147`) — grup metadata'sı gelmemiş `@g.us` jid'lerini toplar, `_ensureGroupSubjects` bunları `groupMetadata` ile çeker. Bu **isim** sorununu çözer, **katılımcı listesi** sorununu çözmez.

→ **R-01 (P0)**

**Test:** `test-group-avatar-fetch.mjs`, `tests/phase2a-group-hydration.test.mjs`, backend `test_whatsapp_phase2_1_a_group_hydration.py`, `test_whatsapp_faz9_group_phone_banner.py`. **Katılımcı değişikliği için test yok.**

---

### 3.11 Geçmiş senkronizasyonu (history sync)

**Dosya:** `socket-events.js:900-1221`

**Akış:** `messaging-history.set` → LID haritaları → kişiler → mesajlar → reaksiyonlar (ikinci geçiş) → READ yükseltmesi → sohbetler → `history_sync_completed`.

**Sıra koruması:** `list.sort((a, b) => (a.id || 0) - (b.id || 0))` (`971`) — kronolojik.

**PDO teşhisi:** `noteHistoryChunk(session)` (`1135`) sayaç artırır; `requestOlderHistory` timeout'unda bu sayacın artışına bakılarak `NO_CHUNK` ile `WAITER_MISMATCH` ayrılır. Bu, "hepsi TIMEOUT" etiketi altında kaybolan iki farklı arızayı ayırıyor — iyi tasarım.

**Waiter eşleştirme:** `resolveHistoryWaitersForChunk` **yalnızca chunk'ın adlandırdığı** sohbetlerin waiter'ını çözer (`1149-1164` yorumu). Önceki hata: her waiter çözülüyordu, A sohbetinin chunk'ı B'yi boş sonuçla bitiriyordu.

**Sessiz dönem:** `HISTORY_QUIET_PERIOD_MS` (3 000 ms), pending notifications varsa 1 500 ms'ye iner (`1203-1205`).

**Medya:** History'de **toplu indirme yok** (`1066-1067` yorumu) — soket kilitlenmesi ve CDN 404'leri nedeniyle on-demand'a bırakılmış.

**Test:** `tests/test-history-resilience.mjs`, `test-history-orchestration.mjs`, `test-post-qr-sync-state-machine.mjs`, `test-realtime-history-identity.mjs`, `test-history-diagnostics.mjs`, backend `test_whatsapp_history_completeness_p15.py`, `test_whatsapp_sync_job.py`.

**Boşluk:** `sync.py`'de seq/epoch cursor **yok** — yalnızca `memory_persistence.py` `afterSeq`/`seqEpoch` tüketiyor. İki mekanizma arasında ortak bir "nerede kaldım" anlayışı yok. → **R-04 (P0)**

---

### 3.12 Çevrimdışı / bekleyen bildirimler

**Dosya:** `session._receivedPendingNotifications`, `test-pending-notifications-sync.mjs`

**Akış:** Bağlantı kurulduğunda bekleyen bildirimler tamamlanınca `_receivedPendingNotifications = true` → sessiz dönem 1 500 ms'ye iner → daha hızlı finalize.

**Test:** `test-pending-notifications-sync.mjs`.

**Boşluk:** Bu bayrak **nesil başına** sıfırlanıyor mu? `_qrSeenForAttempt` sıfırlanıyor (`566`), `_receivedPendingNotifications` için eşdeğer sıfırlama **görülmedi**. → **R-14 (P3, UNVERIFIED)**

---

### 3.13 LID kimlik köprüsü

**Dosya:** `session-manager.js:2988-3100` (`_applyLidMapping`), `lid/lid-repository.js` (228), `utils/whatsapp-identity.js` (279)

**Akış:** `rememberLidPair` (guard) → `persistLidMappingToDb` → kişi/sohbet/mesaj **taşıma** → `lid_mapped` olayı.

**Invariant (A14/T):** Köprü **kişiye değil BAĞLANTIYA** anahtarlanır. `ws.gateway_id` eşleşmesi production'da 4/4107 — yani LID tek başına ertelenir.

**Taşıma detayı:** LID mesajları PN altına taşınırken `seen` set'i ile `wa_message_id` çakışması önlenir (`3073-3077`).

**`rememberLidPair` guard'ı:** `_connectSocket` içinde cache önceden doldurulursa guard `false` döner ve **tüm yan etkiler atlanır** — bu yorumla belgelenmiş (`4416-4419`).

**Test:** `test-lid-alt-resolution.mjs`, backend `test_whatsapp_lid_split_repair.py`, `test_whatsapp_lid_tenant_isolation.py`, `test_whatsapp_boot_lid_merge.py`, `test_whatsapp_identity_quarantine.py`.

**Boşluk:** LID hold edilen mesaj için **zaman aşımı yok** (bkz. R-03).

---

### 3.14 Medya

**Dosya:** `media/media-store.js` (327), `media/audio-transcoder.js` (94), `messages/raw-media-cache.js` (148)

**Akış:** `storeIncomingMedia` → `downloadMediaMessage` (`media-store.js:246`, `reuploadRequest: sock?.updateMediaMessage`) → başarısızsa `downloadContentFromMessage` fallback (`256`) → **10 s timeout** (`272`) → thumbnail kontrolü (`281`).

**Görünüm:** `isViewOnce` ise medya **indirilmez** (`session-manager.js:2603`), yerine `[VIEW_ONCE_PHOTO]` / `[VIEW_ONCE_VIDEO]` / `[VIEW_ONCE_AUDIO]` marker'ı.

**İn-flight tekilleştirme:** `_inFlightMediaDownloads` map'i (`2301-2305`) aynı anahtar için tek indirme garantisi veriyor.

**Test:** `test-raw-media-cache.mjs`, `test-view-once-extraction.mjs`, `test-avatar-priority-media-hydration.mjs`, `test_whatsapp_media*`.

**Boşluk:** 10 s timeout sabit; yavaş CDN'de **sessiz başarısızlık**. Retry yok, kullanıcıya bildirim yok. → **R-07 (P2)**

---

### 3.15 Giden mesaj gönderimi

**Dosya:** `session-manager.js:2791-2900` (`_recordOutbound`, `_confirmOutboundSent`, `_failOutbound`)

**Akış:** `_recordOutbound` (status `PENDING`, `client_message_id` ile dedup) → gönderim → `_confirmOutboundSent` (`SENT`) veya `_failOutbound` (`FAILED`).

**İdempotency:** `wa_message_id` **veya** `client_message_id` ile mevcut kayıt aranır (`2799-2801`); bulunursa alanlar `||=` ile birleştirilir, durum yalnızca **ileri** taşınır (`2809-2811`).

**Boşluk:** Gönderim **retry'ı yok**. `FAILED` terminal. Ağ hatasında kullanıcı elle tekrar göndermek zorunda. WhatsApp Web otomatik yeniden dener. → **R-10 (P2)**

**Test:** `test-outbound-races.mjs`, backend `test_whatsapp_orchestration_messaging.py`, `test_whatsapp_outbound_delete_sync.py`.

---

### 3.16 ACK ve makbuzlar

**Dosya:** `session-manager.js:2902-2977`

**`_applyMessageAck`:** `ACK_RANK` / `ACK_ORDER` monotonluk guard'ı. **Kritik özel durum:** `FAILED` terminal ve **her zaman kazanır** — monotonluk guard'ından **önce** kontrol edilir (`2908-2928`). Yorum: FAILED'i `PENDING` (0) ile aynı sıraya koymak, reddedilen mesajı `SENT` sonrası sessizce düşürüyordu.

**`_applyMessageReceipt`:** Grup üyeleri için `user_receipts` map'i (`2949-2962`) — `receipt_timestamp`, `read_timestamp`, `played_timestamp` ayrı ayrı saklanır. WhatsApp Web'in grup "kim okudu" görünümünün temeli.

**Test:** `test-message-reactions.mjs`, backend `test_whatsapp_gateway_ack.py`, `test_whatsapp_message_info.py`, `test_whatsapp_pure_status_policy.py`.

---

### 3.17 Olay köprüsü ve outbox

**Dosya:** `events.js` (416), `outbox/postgres-event-outbox.js` (265)

**Backoff:** `nextBackoffMs()` = `min(3000 * 2^(attempt-1), 30000) * (0.8 + rand*0.4)` — %20 jitter.

**`publish()` sırası:** flushPairingBuffer → `_internal_only` → ephemeral/progress → durable enqueue → pairing buffer → best-effort.

**Durable outbox:** `claimPending(50)`, açılışta `requeueInflight()`, 10 s retry pump, 10 dk cleanup. Fallback buffer: 500 olay; pairing buffer: 2 000 olay / 20 oturum.

**`gateway_connected`:** `attachClient(socket)` içinde **yalnızca doğrudan gateway'e bağlanan** istemciye gönderilir (`events.js:398-404`). Backend de bir istemci olduğu için bu olayı **alır** ama karşılığı yok (bkz. §3.18).

**Test:** `test-ephemeral-outbox-gate.mjs`, `test-orphan-session.mjs`.

---

### 3.18 Backend ingest (`/ws/gateway`)

**Dosya:** `backend/app/services/whatsapp/orchestration/events.py:2723-2905`

**Seri işleme:** Tek `_ingest_worker` — **bilinçli** olarak sıra dışı commit'i engeller.

**Dağıtım tablosu (kanıt: `2774-2801`):**

| Olay | Handler |
| --- | --- |
| `message_new` | `_ingest_message` |
| `conversation_updated`, `chat_update`, `conversation_read`, `message_status_updated`, `presence_updated` | `_map_conversation_event` |
| `contact_synced` | `_ingest_contact_synced` |
| `conversation_deleted` | `_ingest_conversation_deleted` |
| `messages_deleted` | `_ingest_messages_deleted` |
| `message_reaction` | `_ingest_message_reaction` |
| `message_pinned` | `_ingest_message_pinned` |
| `message_receipt_updated` | `_ingest_message_receipt_updated` |
| `lid_mapped` | `_ingest_lid_mapped` |
| `connection_error` veya `session_*` | `_map_session_event` |
| `history_sync_completed` | `_passthrough_event` |
| **diğer** | `logger.error("Bilinmeyen gateway olayi yayinlanmadi")` + `return None` |

**24 olay adı → 23'ü yönlendiriliyor. Karşılıksız tek olay: `gateway_connected`.**

**Sonuç zinciri:**
1. Gateway köprü soketine `gateway_connected` gönderir (`events.js:401`).
2. Backend bilinmeyen dala düşer → `ERROR` log + `return None` (`2799-2801`).
3. Olay UI'a **hiç yayınlanmaz**.
4. Frontend `LIVE_SESSION_EVENTS` içinde `'gateway_connected'` var (`whatsappApi.ts:553`) → **ölü tetikleyici**.

**Etki:** Frontend, backend↔gateway köprüsü yeniden kurulduğunda oturum listesini yeniden çekmiyor. Frontend↔backend WS'i koptuysa kendi `onopen`'ında zaten yeniden çekiyor; ama **yalnızca köprü** koptuysa UI eski durumda kalır. Ayrıca her köprü bağlantısında **1 hatalı ERROR logu**.

**Not:** `whatsapp_service.py:2193-2195` yorumu `gateway_connected`'ın "backend köprüsünden HİÇ geçmediğini" söylüyor. **Bu yorum yanlış** — `attachClient` her istemci soketine gönderir, backend de istemcidir. Kod ile yorum çelişiyor. → **R-12 (P2)**

**Idempotency:** İki katmanlı — 10 000'lik LRU + `whatsapp_private.processed_events` tablosu (`2757-2773`).

**Yetim olay kuyruğu:** 500 / 300 s TTL; `_drain_orphan_queue` sahip çözülünce tekrar dener.

**Test:** `test_whatsapp_event_idempotency.py`, `test_whatsapp_orphan_replay.py`, `test_whatsapp_gateway_boundary.py`, `test_whatsapp_orchestration_events.py`.

---

### 3.19 Seq / epoch sayfalama

**Dosya:** `message-store.js` (seq), `memory_persistence.py:452` (epoch reset → `after_seq = 0`), `sync.py` (bulk)

**Model:** Gateway süreç başına UUID epoch üretir; backend epoch değişimini görünce `after_seq = 0` yapar → **güvenli yeniden tarama**, veri kaybı değil.

**Front-trim tehlikesi:** `perChatLimit` okuma anında yeniden uygulanıyor (`slice(-N)`), global diziyi sola kaydırıyor → offset sayfalaması kayıt **atlıyor**. 4.28 düzeltmesi: `_bulk_chunks` jid'leri `page_size // per_chat_limit` (=20) parçaya böler, böylece her istek 1. sayfada tamamlanır.

**Kritik:** `_bulk_chunks` **yalnızca deployed release branch'te** var:
```
git grep -n "_bulk_chunks" 0b795ea -- backend/ → sync.py:110, sync.py:1733
git grep -n "_bulk_chunks" HEAD -- .            → (hiç sonuç yok)
```
`main`'de bu fonksiyon **yok**. Bu, §11'deki patch uyumluluk analizinin temeli.

**Test:** `test-bulk-seq-pagination.mjs` (216), `test-bulk-seq-pagination-guarantees.mjs` (537) — **deployed'da var, main'de yok**. Backend `test_whatsapp_initial_sync_chunking.py` (deployed'da).

---

### 3.20 Multi-device ve app-state

**Dosya:** `session-manager.js:243-330` (app-state rearm), `socket-connector.js` (setCompanionActive)

**App-state rearm:**
- Koleksiyonlar: `critical_block`, `critical_unblock_low`, `regular`, `regular_low`, `regular_high` (`243-249`)
- Max deneme: **6** (`250`)
- Gecikmeler: `[5s, 15s, 30s, 60s, 120s, 300s]` (`251`)
- **Durdurma kuralı:** pozitif kanıt — `store.appStateHealthy === true`. "Sohbet listesi dolu" **kanıt değil** (`273-279` yorumu). Doğru tasarım: dolu store history sync'in çalıştığını kanıtlar, app-state'i kanıtlamaz.
- İlerleme ölçümü: `readAppStateProgress(sessionDir)` önce/sonra karşılaştırması (`300-322`).

**Cihaz aktivasyonu:** `<iq xmlns="passive"><active/></iq>` — `<passive/>` gerçek zamanlı akışı **durdurur** (yorumla belgelenmiş).

**Test:** `test-appstate-rearm.mjs`, `test-appstate-delete-selfheal.mjs`.

**Boşluk:** `appStateHealthy` **store başına**; yeni socket aynı store'u kullanıyorsa bayrak `true` kalır ve yeniden bağlanmada rearm **atlanır** — app-state bozulsa bile. → **R-15 (P3, UNVERIFIED)**

---

## 4. WhatsApp Web Davranış Paritesi Matrisi — 28 Alan

Durum kodları: `IMPLEMENTED` / `PARTIAL` / `MISSING` / `UNVERIFIED` / `NOT_SUPPORTED_BY_BAILEYS`

> İstenen 16 alan bu tablonun çekirdeğidir; kapsamı daraltmak yerine gözlemlenebilir her davranış ayrı satıra yazıldı. Aynı davranışın iki farklı yönü (ör. kişi okundu bilgisi vs. grup "kim okudu") ayrı satırdır çünkü kodları ayrı.

| # | Davranış | Durum | Kanıt / Gerekçe |
| --- | --- | --- | --- |
| 1 | Mesaj gönderme/alma | **IMPLEMENTED** | `_recordOutbound` / `_ingestUpsertMessage`; ACK zinciri tam |
| 2 | Medya gönderme/alma | **PARTIAL** | İndirme var (`media-store.js:246`), 10 s timeout, retry yok; toplu geçmiş medyası bilinçli ertelenmiş |
| 3 | Alıntı/yanıt (quote) | **IMPLEMENTED** | `extractQuotedMessageMetadata` + medya/sender_name zenginleştirme (`2652-2665`) |
| 4 | İletme (forward) | **IMPLEMENTED** | `extractForwardedMetadata` (`2685`) |
| 5 | Reaksiyonlar | **IMPLEMENTED** | `_ingestReactionMessage` (`2360-2428`); `text === ''` = geri çekme; doğru anahtar ayrımı |
| 6 | Mesaj düzenleme (edit) | **PARTIAL** | `messages.update` → `update.message` (`1230-1242`) ile içerik güncelleniyor; ayrı "düzenlendi" işareti/geçmişi **yok** |
| 7 | Herkesten sil (revoke) | **PARTIAL** | `protocolMessage` type 0 → `is_deleted = true`, `body = ''` (`2527-2540`); backend'e **olay yayınlanmıyor** — yalnızca RAM güncelleniyor |
| 8 | Sadece benden sil | **MISSING** | `messages.delete` yalnızca gateway cache'ini temizliyor; "benim için sil" ayrımı yok |
| 9 | Sabitleme (pin) | **IMPLEMENTED** | `_ingestPinMessage` (`2430-2466`), `pinned_until` ile süre |
| 10 | Yıldızlama (star) | **MISSING** | Repoda `starMessage` / `updateMessagesStar` **yok** |
| 11 | Arşivleme | **IMPLEMENTED** | `archivedPatch()`, `_applyArchivedState`, `test-archive-state-contract.mjs` |
| 12 | Sessize alma (mute) | **MISSING** | `mute` için tek bir referans **yok** |
| 13 | Okundu bilgisi (kişi) | **IMPLEMENTED** | `_applyMessageReceipt` → `user_receipts` |
| 14 | Grup "kim okudu" | **IMPLEMENTED** | Üye başına `receipt/read/played` timestamp (`2949-2962`) |
| 15 | Yazıyor… / çevrimiçi | **PARTIAL** | `presence.update` + `presence_updated` var; **kendi** presence'ı bilinçli `unavailable` (bildirim koruması) — WhatsApp Web paritesi **kasıtlı olarak** farklı |
| 16 | Kaybolan mesajlar (disappearing) | **MISSING** | `ephemeralSetting` / `disappearing` referansı **yok** |
| 17 | Anket oyları | **PARTIAL** | `pollUpdateMessage` yalnızca `'OTHER'` olarak sınıflandırılıyor (`message-classifier.js:114`); oy sayımı yok |
| 18 | Arama geçmişi | **MISSING** | `'call'` listener **yok** |
| 19 | Engelleme (block) | **MISSING** | `updateBlockStatus` / `fetchBlocklist` **yok** |
| 20 | Etiketler (labels) | **MISSING** | `labels.` referansı **yok** |
| 21 | Kanallar (channels) | **MISSING** | `newsletterMetadata` **yok** |
| 22 | Topluluklar (communities) | **MISSING** | `community` referansı **yok** |
| 23 | Tek seferlik görüntüleme | **IMPLEMENTED** | `isViewOnceMessage`, medya indirilmez, marker üretilir |
| 24 | Grup katılımcı yönetimi | **MISSING** | `group-participants.update` **dinlenmiyor** (§3.10) → **R-01** |
| 25 | Grup konu/ad değişimi | **IMPLEMENTED** | `groups.update` → `subject` (`1224-1253`) |
| 26 | Sohbet listesi sırası | **IMPLEMENTED** | A4 mutlak-son-mesaj kuralı + monotonluk guard'ı |
| 27 | Çoklu cihaz senkronu | **PARTIAL** | App-state rearm var; `appStateHealthy` bayrağı store ömrü boyunca yaşıyor (§3.20) |
| 28 | Çevrimdışı birikmiş mesajlar | **PARTIAL** | `messages.upsert` `type` ayrımı yapmıyor → **R-02** |

**Özet:** **11 `IMPLEMENTED`** (1,3,4,5,9,11,13,14,23,25,26) · **7 `PARTIAL`** (2,6,7,15,17,27,28) · **10 `MISSING`** (8,10,12,16,18,19,20,21,22,24) = **28 satır**.

Hiçbir alan `NOT_SUPPORTED_BY_BAILEYS` olarak işaretlenmedi — çünkü Baileys'in ilgili API'sinin **var olmadığını** kanıtlayacak inceleme yapılmadı; bu alanlar `MISSING` (bizde yok) olarak kaydedildi, `NOT_SUPPORTED` (Baileys'te yok) olarak değil. Aradaki fark, Stage 5 kapsamını belirler: `MISSING` bir alan bizim yazacağımız kodla kapanabilir, `NOT_SUPPORTED` kapanamaz.

---

## 5. Mimari Risk Envanteri — P0–P3

Her risk için: kanıt, etki, olasılık, mevcut koruma.

### P0 — Veri kaybı veya yanlış veri

| ID | Risk | Kanıt | Etki |
| --- | --- | --- | --- |
| **R-01** | Grup katılımcı değişiklikleri hiç dinlenmiyor | Deployed'da 14 listener; `group-participants.update` yok; `groupParticipantsUpdate` yalnızca giden API (`session-manager.js:4070`) | Telefondan eklenen/çıkan üye CRM'e yansımaz. Yanlış kişiye gönderim riski (grup üyeliği varsayımı) |
| **R-02** | `messages.upsert` `type` ayrımı yapmıyor | `socket-events.js:608-613` — `type` yalnızca teşhiste kullanılıyor | Çevrimdışı birikmiş mesajlar canlı `message_new` gibi yayınlanır: yanlış bildirim, yanlış sıralama, yanlış unread |

### P1 — Sessiz veri eksikliği

| ID | Risk | Kanıt | Etki |
| --- | --- | --- | --- |
| **R-03** | LID hold edilen mesajın TTL/fallback'i yok | `session-manager.js:2726-2741` — `lidHold` ise yayın yok, sayaç artmaz | LID eşlemesi gelmezse mesaj **kalıcı olarak** görünmez. Sessiz |
| **R-04** | `sync.py`'de seq/epoch cursor yok | Yalnızca `memory_persistence.py` `afterSeq`/`seqEpoch` tüketiyor | İki senkron mekanizması arasında ortak konum yok; yeniden başlatmada kapsam belirsiz |
| **R-05** | Retry penceresi RAM ile sınırlı (500/chat) | `message-store.js` ham mesaj cap 500; `getMessage` RAM'den | Yoğun grupta çözülemeyen mesaj kalıcı kaybolur; gateway restart sonrası tüm retry imkânsız |
| **R-08** | Creds yazım hatası sessizce yutuluyor | `catch {}` desenleri (auth yolu) | Bozuk creds ancak sonraki bağlantıda `badSession` olarak ortaya çıkar |
| **R-12** | `gateway_connected` backend'de karşılıksız + yanlış yorum | `events.py:2799-2801` (bilinmeyen dal), `whatsapp_service.py:2193-2195` (yanlış yorum), `whatsappApi.ts:553` (ölü tetikleyici) | Köprü yeniden kurulduğunda UI tazelenmez; her bağlantıda hatalı ERROR logu |

### P2 — Gözlemlenebilirlik / davranış boşluğu

| ID | Risk | Kanıt | Etki |
| --- | --- | --- | --- |
| **R-06** | Kapasite eviction'ı sessiz | `recordEviction()` yalnızca diagnostic | Kullanıcı "mesaj kayboldu" der, sistem bildirmez |
| **R-07** | Medya indirme 10 s timeout, retry yok | `media-store.js:272` | Yavaş CDN'de sessiz başarısızlık |
| **R-09** | Presence keepalive interval'i nesil kontrolsüz | `socket-events.js:465-473` | Bayat soket interval'i yeni sokete stanza gönderebilir |
| **R-10** | Giden mesaj retry'ı yok | `_failOutbound` terminal | Ağ hatasında elle tekrar gerekir |
| **R-11** | Lease kaybı UI'a bildirilmiyor | `4469-4495` — yalnızca `diagnostic()` | Kullanıcı oturumun düştüğünü göremez |
| **R-13** | QR süre sonu yönetimi yok | `session_qr_updated` yeni QR'ı yazar, eskisini geçersiz kılmaz | Kullanıcı süresi geçmiş QR'ı okutabilir |

### P3 — Düşük etki / ileride tuzak

| ID | Risk | Kanıt | Etki |
| --- | --- | --- | --- |
| **R-14** | `_receivedPendingNotifications` nesil başına sıfırlanmıyor olabilir | `_qrSeenForAttempt` sıfırlanıyor (`566`), bu bayrak için eşdeğer **görülmedi** | **UNVERIFIED** — yanlış hızlı finalize |
| **R-15** | `appStateHealthy` store ömrü boyunca `true` kalıyor | `session-manager.js:285` | Yeniden bağlanmada rearm atlanabilir — **UNVERIFIED** |
| **R-16** | `_touchChat` `unread_count` için `\|\| 0` | `session-manager.js:3133` | Şu an doğru sonuç; `??` olmalı (ileride tuzak) |
| **R-17** | `main` ile production gateway ayrı hatlar | `20c88bb` main'in atası değil | Her deploy'da "hangi kod çalışıyor" belirsizliği; analiz/deploy drift'i |

**P0: 2 · P1: 5 · P2: 6 · P3: 4 = 17**

---

## 6. Test Kapsamı Envanteri

### 6.1 Gateway — 38 script (npm `test` zinciri)

**Kapsanan:** avatar (4), auth (1), outbound race (1), bounded cache/messages (3), contact cache/hydration (2), chat sırası (1), system preview (1), reaksiyon (1), grup avatar (1), arşiv (1), bulk jids/seq pagination (3), realtime history (1), diagnostics (2), appstate (2), orphan (1), ephemeral outbox (1), delete chat (1), LID (1), unread (2), postgres pool (1), presence (1), history (5), pending notifications (1), post-QR state machine (1), media (2), latency/messages-cached (2).

**Kapsanmayan (kod var, test yok):**

| Alan | Not |
| --- | --- |
| Reconnect / backoff / 515 | `socket-events.js:529-601` hiç test edilmiyor |
| `SocketLifecycle` nesil guard'ı | 58 satır, doğrudan test yok |
| Lease koordinasyonu | `lease/` 154 satır, gateway tarafında test yok (backend'de var) |
| Grup katılımcı değişikliği | Kod da yok |
| Medya timeout/fallback | `media-store.js:246-281` |
| Outbox claim/requeue | `postgres-event-outbox.js` |
| Şifreleme codec | `encrypted-codec.js` |

### 6.2 Backend — 76 WhatsApp test dosyası / 157 toplam

Güçlü: idempotency, orphan replay, tenant isolation, LID, pairing, sync, ack, pagination, races, pure functions.

Zayıf: gateway'in **davranışsal** çıktısını taklit eden testler sınırlı; `gateway_connected` gibi "karşılıksız olay" için test yok.

### 6.3 Frontend — **0 test dosyası**

`frontend/src/features/whatsapp/` için hiç test yok. `LIVE_SESSION_EVENTS` gibi sözleşmeler yalnızca yorumla korunuyor.

### 6.4 Kapsam boşluğu tablosu

| Davranış | Gateway | Backend | Frontend |
| --- | --- | --- | --- |
| Reconnect/backoff | ✗ | — | — |
| Nesil guard | ✗ | — | — |
| Lease | ✗ | ✓ | — |
| `messages.upsert` type ayrımı | ✗ | ✗ | — |
| Grup katılımcı | ✗ | ✗ | ✗ |
| Presence intercept | ✓ | — | — |
| Media timeout | ✗ | ✗ | — |
| Outbox claim/requeue | ✗ | — | — |
| Olay sözleşmesi (24 ad) | ✗ | ✗ | ✗ |

**Sonuç:** En kritik boşluk **olay sözleşmesi testi**. 24 olay adının 24'ünün backend'de karşılığı olduğunu doğrulayan tek bir test yok — `gateway_connected` tam bu yüzden fark edilmedi.

---

## 7. Gözlemlenebilirlik Kapsamı

**Mevcut:**

| Araç | Dosya | Kapsam |
| --- | --- | --- |
| `diagnostic()` | `observability.js` (79) | Nesil, lease, stale socket, reconnect nedeni |
| `latency()` | aynı | `socket_initialization_ms` |
| `recordEviction()` | `message-store.js` | PII'siz kapasite kaydı |
| `noteHistoryChunk()` | `socket-events.js` | `NO_CHUNK` vs `WAITER_MISMATCH` ayrımı |
| `readAppStateProgress()` | `session-manager.js` | App-state ilerleme kanıtı |
| `_connect_metrics` | `events.py:2851-2869` | `STAGE_FIRST_MESSAGE/CONVERSATION/CONTACT` |
| `ramCapacitySnapshot()` | `message-store.js` | RAM kapasite anlık görüntüsü |

**Eksik:**

1. **Olay karşılıksızlığı metriği yok** — bilinmeyen olay `ERROR` loglanıyor ama **sayılmıyor**; alerting kurulamaz.
2. **Lease kaybı sayacı yok** — `diagnostic()` var, metrik yok.
3. **LID hold süresi ölçülmüyor** — bir mesaj ne kadar held kaldı bilinmiyor (R-03'ün anahtarı).
4. **Eviction sayısı metrik değil** — yalnızca log.
5. **Frontend'e hiç metrik akmıyor** — "kaç olay düştü" görünmüyor.

---

## 8. Eksik Testler ve Reprodüksiyon Senaryoları

Her satır: testin adı, neyi kanıtlayacağı, nasıl reprodüksiyon edileceği.

| # | Test | Kanıtlayacağı | Reprodüksiyon |
| --- | --- | --- | --- |
| T-01 | `test_event_contract_parity` | Gateway'in yayınladığı **her** olay adının backend'de karşılığı var | Gateway kaynağından `event: '...'` listesini çıkar, backend dağıtım tablosuyla **küme** olarak karşılaştır. `gateway_connected` bu testle yakalanır |
| T-02 | `test_upsert_append_is_not_live` | `type='append'` mesaj `message_new` yayınlamaz | Sahte `messages.upsert` emit: `{type:'append'}` → assert yayın **yok**; `{type:'notify'}` → assert yayın **var** |
| T-03 | `test_group_participant_change_emits` | `group-participants.update` → olay | Sahte emit → assert `conversation_updated` veya yeni olay. **Şu an FAIL eder** (kod yok) |
| T-04 | `test_lid_hold_has_deadline` | Held mesaj N saniye sonra fallback ile yayınlanır | LID jid'li mesaj emit, eşleme gönderme, süre ilerlet → assert yayın |
| T-05 | `test_reconnect_backoff_sequence` | 515 → 500 ms; transient → 1/2/4/8/16/30 s + jitter | `_connFailures` 1..7 için `delayMs` hesapla, jitter'ı sabitle (`Math.random` stub) |
| T-06 | `test_stale_socket_cannot_attach` | Eski nesil socket `attach` edilemez | `beginAttempt()` iki kez, ilk nesille `attach` → assert red + `end()` çağrıldı |
| T-07 | `test_presence_keepalive_stops_on_close` | Close sonrası keepalive durur | Close emit → timer'ı ilerlet → assert `setCompanionActive` çağrı **yok** |
| T-08 | `test_media_timeout_is_observable` | 10 s timeout diagnostic üretir | `downloadMediaMessage` hiç resolve olmasın → 10 s sonra assert diagnostic |
| T-09 | `test_outbox_requeue_on_open` | Açılışta `requeueInflight` çağrılır | Inflight kayıt bırak, aç → assert requeue |
| T-10 | `test_frontend_live_events_have_producers` | Her `LIVE_SESSION_EVENTS` üyesinin backend üreticisi var | Frontend set'ini backend olay listesiyle karşılaştır — `gateway_connected` yakalanır |

**Not:** T-03 ve T-10 **şu an FAIL edecek** — bu bilinçli: testler mevcut boşluğu kanıtlar, Stage 5'te yeşile döner.

---

## 9. Stage 5 Uygulama Fazları

Her faz: amaç, kapsam, dosyalar, beklenen davranış, test planı, kabul kriteri, rollback, production riski, gateway restart ihtiyacı, deploy ihtiyacı.

### Stage 5.1 — Olay Sözleşmesi Paritesi ve `gateway_connected`

| Alan | İçerik |
| --- | --- |
| **Amaç** | Gateway'in yayınladığı her olayın backend'de karşılığı olsun; ölü tetikleyici kalmasın |
| **Kapsam** | `gateway_connected` için backend dalı (broadcast-only, DB yazımı yok) **veya** gateway'den bu olayı köprüye göndermeyi bırakma + frontend set'inden çıkarma. `whatsapp_service.py:2193-2195` yanlış yorumunun düzeltilmesi |
| **Dosyalar** | `backend/app/services/whatsapp/orchestration/events.py`, `backend/app/services/whatsapp_service.py`, `frontend/src/features/whatsapp/api/whatsappApi.ts` |
| **Beklenen davranış** | Bilinmeyen olay sayısı **0**; her köprü bağlantısında ERROR logu **yok**; UI köprü yeniden kurulduğunda tazelenir |
| **Test** | T-01, T-10 |
| **Kabul** | Küme farkı boş; `ERROR` logu yok; T-01/T-10 yeşil |
| **Rollback** | Tek dosya revert; DB şeması değişmiyor |
| **Production riski** | **Çok düşük** — yalnızca broadcast, veri yazımı yok |
| **Gateway restart** | **Hayır** (backend-only) |
| **Deploy** | **Evet** — `--no-gateway` |

### Stage 5.2 — `messages.upsert` tip ayrımı (R-02)

| Alan | İçerik |
| --- | --- |
| **Amaç** | `append` (çevrimdışı birikmiş) mesajlar canlı `message_new` gibi davranmasın |
| **Kapsam** | `type === 'notify'` canlı; `append` sessiz ingest (RAM'e yaz, olay yayınlama, unread artırma); `notify`+`append` çakışmasında idempotency mevcut `wa_message_id` guard'ı ile |
| **Dosyalar** | `whatsapp-gateway/src/socket/socket-events.js:608-630`, `session-manager.js:2468-2743` |
| **Beklenen davranış** | Çevrimdışı birikmiş mesaj geçmişe eklenir, bildirim üretmez, unread'i şişirmez |
| **Test** | T-02 + mevcut `test-unread-count-progression.mjs` regresyonu |
| **Kabul** | T-02 yeşil; mevcut 38 script'in tamamı yeşil |
| **Rollback** | Tek fonksiyon revert; RAM davranışı geri döner |
| **Production riski** | **Orta** — canlı mesaj akışının kalbi; yanlış ayrım mesaj **kaybettirebilir** |
| **Gateway restart** | **Evet** — gateway kodu değişiyor |
| **Deploy** | **Evet** — gateway image değişir (A6: restart RAM kaybı) |

> **Uyarı:** Bu faz gateway restart gerektirdiği için RAM deposundaki mesajları kaybeder (invariant A6). Deploy **yalnızca** backend persistence doğrulandıktan sonra ve `/health.whatsapp_memory_persistence` kontrolüyle yapılmalı.

### Stage 5.3 — Grup katılımcı değişiklikleri (R-01)

| Alan | İçerik |
| --- | --- |
| **Amaç** | `group-participants.update` dinlensin; üye ekleme/çıkarma CRM'e yansısın |
| **Kapsam** | Yeni listener; `group_participants_updated` olayı; backend handler; grup üye tablosu (varsa) veya sohbet meta'sı |
| **Dosyalar** | `socket-events.js` (yeni listener), `session-manager.js` (ingest), `events.py` (yeni dal), gerekirse migration |
| **Beklenen davranış** | Telefondan eklenen üye UI'da görünür; çıkan üye işaretlenir |
| **Test** | T-03 + yeni backend testi |
| **Kabul** | T-03 yeşil; üye değişikliği uçtan uca görünür |
| **Rollback** | Listener kaldır; olay yayınlanmaz (mevcut davranış) |
| **Production riski** | **Düşük** — yalnızca ek olay |
| **Gateway restart** | **Evet** |
| **Deploy** | **Evet** (gateway + backend) |

### Stage 5.4 — LID hold sonlandırma (R-03)

| Alan | İçerik |
| --- | --- |
| **Amaç** | Eşlemesi gelmeyen LID mesajı sonsuza kadar sessiz kalmasın |
| **Kapsam** | Hold süresi + TTL; süre dolunca "LID olarak" yayınla (isim çözülmemiş, ama mesaj görünür) |
| **Dosyalar** | `session-manager.js:2726-2741`, `message-store.js` (hold kuyruğu) |
| **Beklenen davranış** | Mesaj en geç N saniye içinde görünür; isim sonradan zenginleşir |
| **Test** | T-04 |
| **Kabul** | T-04 yeşil; held mesaj süre sonunda yayınlanır |
| **Rollback** | TTL kaldır |
| **Production riski** | **Orta** — LID kişileri UI'a sızabilir; isim çözümü geriye döner |
| **Gateway restart** | **Evet** |
| **Deploy** | **Evet** |

### Stage 5.5 — Yeniden bağlanma ve lease gözlemlenebilirliği (R-09, R-11)

| Alan | İçerik |
| --- | --- |
| **Amaç** | Reconnect/lease olayları görünür ve test edilebilir olsun |
| **Kapsam** | Keepalive'a nesil kontrolü; lease kaybında `session_disconnected` + `error_reason`; metrik sayaçları |
| **Dosyalar** | `socket-events.js:465-473`, `session-manager.js:4469-4495`, `observability.js` |
| **Beklenen davranış** | Bayat interval stanza göndermez; lease kaybı UI'da görünür |
| **Test** | T-05, T-06, T-07 |
| **Kabul** | Üç test yeşil; mevcut davranış bozulmamış |
| **Rollback** | Nesil kontrolü kaldır (davranış eskiye döner) |
| **Production riski** | **Düşük** |
| **Gateway restart** | **Evet** |
| **Deploy** | **Evet** |

### Stage 5.6 — Medya dayanıklılığı (R-07)

| Alan | İçerik |
| --- | --- |
| **Amaç** | Medya indirme sessiz başarısız olmasın |
| **Kapsam** | Timeout diagnostic + sınırlı retry (2 deneme, artan gecikme); kullanıcıya `media_unavailable` durumu |
| **Dosyalar** | `media/media-store.js:246-281` |
| **Beklenen davranış** | Geçici CDN hatası kendini toparlar; kalıcı hatada UI bilgilendirilir |
| **Test** | T-08 |
| **Kabul** | T-08 yeşil; retry sayısı gözlemlenebilir |
| **Rollback** | Retry kaldır |
| **Production riski** | **Düşük-orta** — soket yükü artabilir |
| **Gateway restart** | **Evet** |
| **Deploy** | **Evet** |

### Stage 5.7 — WhatsApp Web parite genişletmesi (MISSING alanlar)

| Alan | İçerik |
| --- | --- |
| **Amaç** | `MISSING` 11 alanın önceliklendirilmesi ve uygulanması |
| **Kapsam** | Öncelik sırası: (1) sadece-benden-sil, (2) kaybolan mesajlar, (3) anket oyları, (4) yıldızlama, (5) sessize alma, (6) engelleme, (7) arama geçmişi, (8) etiketler, (9) kanallar, (10) topluluklar, (11) `groups.upsert`/`chats.upsert` |
| **Dosyalar** | Her alan için gateway listener + backend handler + UI |
| **Beklenen davranış** | Alan alanı WhatsApp Web paritesi |
| **Test** | Her alan için birim + sözleşme testi |
| **Kabul** | Alan bazlı; her alan ayrı deploy edilebilir |
| **Rollback** | Alan bazlı listener kaldırma |
| **Production riski** | **Alan bazlı** |
| **Gateway restart** | **Evet** (her alan) |
| **Deploy** | **Evet** |

> **Not:** Bu faz **tek seferde yapılmamalı**. Her alan kendi deploy'unu hak eder; aksi halde tek bir hata tüm parite işini geri alır.

### Faz bağımlılık grafiği

```
5.1 (backend-only, risk ~0)
  └─> 5.2 (gateway restart) ──> 5.3 ──> 5.4
                                   └──> 5.5 ──> 5.6 ──> 5.7
```

**5.1 tek başına yapılabilir** ve hiçbir gateway restart'ı gerektirmez — bu yüzden ilk öneri.

---

## 10. Stage 5 için Yeni Test Stratejisi

**İlke:** "Yeşil test ölü guard'ı saklayabilir." Her yeni guard için **mutasyon kanıtı** zorunlu: guard'ı geçici boz, tam olarak beklenen testin kırmızıya döndüğünü gör, bayt-bayt aynı geri yükle, `git status` temiz doğrula.

**Üç katman:**

1. **Sözleşme testleri (yeni):** Gateway'in yayınladığı olay kümesi ↔ backend dağıtım tablosu ↔ frontend `LIVE_SESSION_EVENTS`. Küme karşılaştırması — sayı değil.
2. **Davranış testleri (mevcut 38'e ek):** Reconnect, nesil, lease, presence, media, outbox.
3. **Uçtan uca (canlı):** Yalnızca onaylı test hesabıyla; production DB'ye yazmadan.

**Yasak:** Gerçek müşteriye test mesajı; QR/session reset; persistence loop açma; feature flag değiştirme.

---

## 11. 4.34 Test Patch — `main` Uyumluluk Analizi

**Patch:** `docs/audits/ASAMA-4.34-regression-tests.patch` (317 satır, 6 test)

### 11.1 `_bulk_chunks` bağımlılığı

**Bulgu:** `_bulk_chunks` **yalnızca deployed release branch'te** var:

```
git grep -n "_bulk_chunks" 0b795ea -- backend/ 
→ backend/app/services/whatsapp/orchestration/sync.py:110  (tanım)
→ backend/app/services/whatsapp/orchestration/sync.py:1733 (kullanım)
→ backend/tests/test_whatsapp_initial_sync_chunking.py   (testler)

git grep -n "_bulk_chunks" HEAD -- .
→ (hiç sonuç yok)
```

Yani `main`'de bu fonksiyon **tanımlı değil**. Patch'in `test_only_conv_ids_full_set_still_chunks` ve `test_only_conv_ids_narrows_the_request_before_chunking` testleri chunking davranışını doğruluyor; `sync.py` chunking yapmıyorsa bu testler **anlamsız** (veya import hatası verir).

### 11.2 Branch uyumluluğu

| Kriter | Sonuç |
| --- | --- |
| Patch hangi branch'e yazıldı | `release/backend-only-seq-safety` (`0b795ea`) |
| `main`'de `_bulk_chunks` var mı | **Hayır** |
| `main`'de `only_conv_ids` var mı | **UNVERIFIED** — ayrıca doğrulanmalı |
| Patch `main`'e doğrudan uygulanabilir mi | **Hayır** |

### 11.3 Öneri

**Patch `main`'e doğrudan uygulanmamalı.** Üç seçenek:

1. **Önce `main`'e chunking'i taşı** (4.28 fix'i), sonra patch'i uygula. Doğru sıra ama ek iş.
2. **Patch'i release branch'te tut**, `main`'e merge ederken testleri de taşı. Deploy hattıyla tutarlı.
3. **Testleri `main`'de bağımsız yaz** — `TrimAwareGateway` harness'ı zaten gateway semantiğini taklit ediyor, `_bulk_chunks`'a doğrudan bağımlılık kaldırılabilir.

**Önerim: seçenek 2.** Çünkü production'daki kod release branch'te ve testler o kodun davranışını kanıtlıyor; `main`'e taşımak "test edilen kod = deploy edilen kod" bağını koparır.

---

## 12. Sonuç, Kısıtlar ve Stage 5.1 Önerisi

### 12.1 Sonuç

Gateway'in **core stability** temeli sağlam: nesil koruması, lease koordinasyonu, ACK monotonluğu, idempotency katmanları, app-state pozitif-kanıt kuralı — hepsi doğru tasarlanmış ve çoğu test edilmiş.

Zayıflık **davranışsal paritede**: 28 incelenen WhatsApp Web davranışından 11'i `MISSING`, 8'i `PARTIAL`. Ve iki P0 riski doğrudan **veri doğruluğunu** etkiliyor: grup katılımcı değişikliklerinin hiç dinlenmemesi (R-01) ve `messages.upsert` tip ayrımının olmaması (R-02).

### 12.2 Kısıtlar (dürüstçe)

1. **Üç ağaç farkı.** Analiz çalışma ağacında yapıldı; production `20c88bb` gateway'ini çalıştırıyor. Listener seti ve metot seti üç ağaçta aynı doğrulandı, ama **gövde farkları** (seq/epoch) bazı satır numaralarını ve iç detayları production'da farklı kılar.
2. **`NOT_SUPPORTED_BY_BAILEYS` kullanılmadı.** Baileys 7.0.0-rc14 API'sinin hangi özellikleri desteklemediği **incelenmedi**. 11 `MISSING` alan "bizde yok" demek, "Baileys'te yok" demek değil.
3. **R-14 ve R-15 `UNVERIFIED`.** Kanıt yetersiz; Stage 5'te ölçülmeli.
4. **Canlı test yapılmadı.** Bu aşama kod okuma aşamasıydı; hiçbir container'a, DB'ye veya sokete dokunulmadı.
5. **Frontend 0 test.** Parite iddiaları frontend tarafında yalnızca kod okumayla doğrulandı.

### 12.3 Stage 5.1 Önerisi

**Stage 5.1 — Olay Sözleşmesi Paritesi** ile başlanmasını öneriyorum. Gerekçe:

| Kriter | Değerlendirme |
| --- | --- |
| Risk | **En düşük** — backend-only, DB yazımı yok, broadcast-only |
| Gateway restart | **Gerekmiyor** — RAM deposu korunur (A6 ihlal edilmez) |
| Deploy | `--no-gateway` ile |
| Somut kazanç | Ölü tetikleyici kalkar, her bağlantıdaki hatalı ERROR logu biter, yanlış kod yorumu düzelir |
| Test | T-01 + T-10 — **yeniden kullanılabilir sözleşme testi altyapısı** kurar; sonraki tüm fazlar bunu kullanır |
| Bağımlılık | Hiçbir faza bağımlı değil; 5.2–5.7'nin **önkoşulu** değil ama **zeminini** hazırlar |

**5.1'in kapsamı (kesin):**
1. `gateway_connected` için backend'de broadcast dalı ekle **veya** olayı köprüden çıkar + frontend set'inden sil. (Karar Stage 5.1 başında verilmeli; ikisi de savunulabilir. Ben **broadcast dalı eklemeyi** öneriyorum: frontend zaten bekliyor ve köprü yeniden kurulduğunda UI tazelemesi gerçek bir ihtiyaç.)
2. `whatsapp_service.py:2193-2195` yanlış yorumunu düzelt.
3. T-01 sözleşme testini ekle (küme karşılaştırması, sayı değil).

**5.1'in kapsamı DIŞINDA:** `messages.upsert` tip ayrımı (5.2), grup katılımcı (5.3), LID TTL (5.4). Bunlar gateway restart gerektirir ve ayrı deploy hak eder.

---

**Rapor sonu. Kod değiştirilmedi, commit/push/deploy yapılmadı, container'a dokunulmadı.**

**Onay bekleniyor:** Stage 5.1'e geçilsin mi, yoksa farklı bir faz mı önceliklendirilsin?
