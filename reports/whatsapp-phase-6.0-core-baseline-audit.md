# AŞAMA 6.0 — WhatsApp Core Baseline Audit

**Üretim Öncesi Mevcut Durum ve Gerçek Sorunların Tespiti**

- Tarih: 2026-11-03
- İşlem türü: READ-ONLY / salt okunur denetim
- Kodlama: yapılmadı
- Altyapı / bağımlılık değişikliği: yapılmadı
- Kapsam dışı: kampanya medyası, outreach, reklam, pazarlama
- L4 (PostgreSQL + gerçek gateway + gerçek WhatsApp hesabı): çalıştırılmadı

---

## 1. Başlangıç Git / Worktree Durumu

| Alan | Değer |
|---|---|
| Çalışma dizini | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| `git status --short` | 32 satır |
| `git diff --stat` | 14 dosya, +1440 / -161 |
| `git diff --check` | temiz (exit 0) |
| `uploads/campaign_media` | 0 dosya |

Değişiklikler denetimden **önce** mevcuttu ve korundu. Denetim sırasında yalnızca bu rapor dosyası oluşturuldu; `reports/` zaten untracked olduğu için `git status` satır sayısı değişmedi.

```text
M backend/app/api/v1/endpoints/campaigns.py
M backend/app/api/v1/endpoints/whatsapp.py
M backend/app/services/campaign_media_service.py
M backend/app/services/campaign_runner.py
M backend/app/services/link_preview/service.py
M backend/app/services/outreach_manager.py
M backend/app/services/whatsapp/orchestration/messaging.py
M backend/app/services/whatsapp_gateway.py
M backend/tests/test_campaign_media.py
M backend/tests/test_whatsapp_live.py
M whatsapp-gateway/package.json
M whatsapp-gateway/src/index.js
M whatsapp-gateway/src/media/media-store.js
M whatsapp-gateway/src/session-manager.js
?? backend/tests/test_campaign_media_auth.py
?? backend/tests/test_campaign_media_dispatch_auth.py
?? backend/tests/test_campaign_media_ownership_hardening_5412.py
?? backend/tests/test_link_preview_media_tenant_isolation.py
?? backend/tests/test_whatsapp_media_tenant_isolation.py
?? reports/
?? whatsapp-gateway/src/media/media-routes.js
?? whatsapp-gateway/tests/media-test-loader-atomic.mjs
?? whatsapp-gateway/tests/media-test-loader.mjs
?? whatsapp-gateway/tests/media-test-register-atomic.mjs
?? whatsapp-gateway/tests/media-test-register.mjs
?? whatsapp-gateway/tests/stubs/
?? whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs
?? whatsapp-gateway/tests/test-media-routes-543.mjs
?? whatsapp-gateway/tests/test-media-routes-545.mjs
?? whatsapp-gateway/tests/test-media-session-dedupe-547.mjs
?? whatsapp-gateway/tests/test-media-store-543.mjs
?? whatsapp-gateway/tests/test-media-store-integrity.mjs
```

---

## 2. WhatsApp Sistem Mimarisi ve Event Akışı

Üç katmanlı yapı:

1. **Gateway** (`whatsapp-gateway/`): Node.js + Baileys. QR eşleştirme, oturum yaşam döngüsü, AES-256-GCM şifreli auth state, PostgreSQL session lease/fencing, event üretimi.
2. **Backend** (`backend/`): FastAPI. `/api/v1/whatsapp/*` REST proxy, `/ws/gateway` giriş köprüsü, `/ws` UI yayını, `WhatsAppSession` / `Conversation` / `Message` / `Contact` / `lid_mappings` / `processed_events` / `event_outbox` kalıcılığı.
3. **Frontend** (`frontend/`): React. `WhatsAppHubPage` + `WhatsAppQrConnectModal`, tek singleton `/ws` bağlantısı, `messagesMap` ile sohbet başına mesaj durumu.

Gerçek event akışı:

```text
Baileys (connection.update / messages.upsert / messages.update / receipts / history)
  → session-manager.js (kimlik normalizasyonu, LID eşleme, chat/message RAM store)
  → events.js publish()
      ├─ kalıcı oturum: event_outbox (PostgreSQL) → 10 sn'lik pump
      ├─ ephemeral pairing: best-effort / pairing buffer
      └─ session_sync_progress ve _ephemeral: outbox'suz
  → backend /ws/gateway
      → seri ingest worker
      → ingest_gateway_event(): processed_events dedupe + handler + DB commit
      → ws_manager.broadcast() (tenant-scoped)
      → gateway_event_ack
  → frontend /ws → tezlify:ws_event
      → message_new: sol liste + açık sohbet messagesMap
```

Yan kanallar:

- Gateway → backend REST (`/sessions`, `/sessions/:id/...`) üzerinden sync durumu ve geçmiş istekleri.
- Gateway, backend'e WebSocket ile bağlanır; backend restart'ında outbox `requeueInflight()` ile yeniden gönderir (`events.js:127-186`).
- Session lease/fencing: aynı gateway oturumunun iki süreçte aynı anda çalışmasını engeller; stale socket attach'i reddedilir (`session-manager.js:4259-4364`).

---

## 3. Baileys / Gateway İncelemesi

### 3.1 Bağlantı yaşam döngüsü

- `socket-events.js:247-455` (`connection === 'open'`): self identity hesaplanır, ephemeral ise promotion + auth/lease kalıcılaştırması yapılır, lifecycle yeniden doğrulanır, `CONNECTED` commit edilir, `session_connected` yayınlanır, presence keepalive ve sync phase başlatılır.
- `socket-events.js:456-546` (`connection === 'close'`):
  - `restartRequired` (515): 500 ms sonra yeniden bağlanır.
  - `loggedOut` (401): `DISCONNECTED`, lease release, persistent session deactivate.
  - `badSession` (500): `BANNED`, aynı temizlik.
  - Diğer: `CONNECTING`, üstel backoff `min(30s, 1s·2^(n-1))` + %20 jitter.
- **Bulgu:** `connectionReplaced` (440) için özel dal yok. `socket-events.js` içinde `connectionReplaced` veya `440` hiç geçmiyor; 440 genel "transient disconnect" dalına düşüyor.

### 3.2 QR üretimi / yenileme

- `socket-events.js:202-241`: her QR'da `session.status='SCAN_QR'`, `QRCode.toDataURL(qr)` await edilir, `session_qr_updated` yayınlanır. Baileys yeni QR ürettikçe bu blok tekrar çalışır; frontend modal `session_qr_updated` olayını dinler (`WhatsAppQrConnectModal.tsx:623`) ve periyodik `getPairingQr` ile yedekler.
- **Küçük yarış:** `qr_code` await'i tamamlanmadan `connection === 'open'` gerçekleşirse, geç gelen `session_qr_updated` CONNECTED durumundan sonra yayınlanabilir. Frontend'de monoton lifecycle guard'ı vardır (`WhatsAppQrConnectModal.tsx:179`), bu nedenle etki UI ile sınırlıdır (P2-2).

### 3.3 Auth state ve `creds.update`

- `socket-events.js:133-147`: `saveCreds()` await edilir, hata olursa diagnostic + log.
- `socket-connector.js:94-115`: Postgres auth repository varsa `saveCreds` yalnızca `authRepository.saveCredentials()` çağırır; hata **içeride yutulur** (yalnızca `logger.warn`). `diskSaveCreds()` da aynı `rawSaveCreds`'i çağırdığı için üretimde gerçek bir disk yedeği oluşmaz.
- Sonuç: PostgreSQL credential yazımı başarısız olursa auth state sessizce eski kalır; gateway restart'ında oturum sürdürülemeyebilir (P1-1).

### 3.4 `receivedPendingNotifications`

- `socket-events.js:174-200`: bayrak set edilir, `session_notifications_received` yayınlanır; sohbet varsa history quiet timer 1500 ms'ye çekilir.
- `socket-events.js:830` ve `1124-1127`: quiet timer/finalize kararında kullanılır.
- Backend bu olayı `session_*` dalında işler (`events.py:2887`), veri kaybı üretmez. Ancak bu davranışı doğrulayan çalıştırılabilir bir test bu worktree'de yok (gateway testleri dependency nedeniyle koşmadı).

### 3.5 Reconnect / restart / logout ayrımı

- 515 ve 401/500 ayrımı doğru yapılıyor.
- 440 ayrımı yok.
- `logoutSession` (`session-manager.js:772-823`): önce `lifecycle.invalidate()` ve `releaseLease`, sonra `sock.logout()`. Provider logout hata verirse ve `force=false` ise fonksiyon throw eder; `status` **CONNECTED kalır**, socket kapatılmaz, lease serbest bırakılmıştır. Backend logout endpoint'i `force` göndermez (`whatsapp.py:352-358`), servis de varsayılan `force=false` ile çağırır (`sessions.py:1149-1168`). Sonuç: hayalet "CONNECTED" satır + event'leri generation guard nedeniyle yok sayılan orphan socket (P1-2).

### 3.6 Gateway yeniden başlatma ve oturum sürdürme

- `session-manager.js:579-604` (`restoreSessions`): restorable kayıtlar için `autoStart:false` ile session oluşturup `_startSocket` çağırır.
- `index.js:141` ve `docker-compose.prod.yml:147`: üretimde `WHATSAPP_AUTO_RESTORE="true"`; oturumlar gerçekten restore edilir.
- `index.js:194-198` yorumu "production'da AUTO_RESTORE kapalı" diyor; bu **belge sapmasıdır**, kodun davranışı değildir.
- Restore, credential'ın kalıcı olduğunu varsayar; P1-1 bu varsayımı zayıflatır.

### 3.7 Aynı session'ın birden fazla kez başlatılması

- `_connectSocket` içinde in-flight connect guard yoktur; yalnızca `_reconnectTimer` kontrol edilir (`session-manager.js:4259-4275`).
- `beginAttempt()` generation'ı artırır; geç gelen socket `stale_socket_attach_rejected` ile reddedilir ve `attach()` önceki socket'i kapatır (`session-manager.js:4350-4370`). Bu nedenle **iki kalıcı socket** oluşmaz, ancak eşzamanlı başlatmalarda geçici çift socket/event churn ve gereksiz lease denemeleri olur (P2-9).
- Backend `create_session` her çağrıda yeni gateway oturumu ve yeni DB satırı üretir (`sessions.py:419-439`); mevcut canlı oturum kontrolü yoktur. `start_pairing_session` da her çağrıda yeni ephemeral oturum açar (`sessions.py:547-610`). Aynı kullanıcı için tekrar bağlantı senaryosunda çoklu QR/oturum oluşabilir (P2-3). Promotion aynı telefon için canlı CONNECTED oturumu ezmeyi reddeder (`promotion.py:340-361`), yani veri bozulması yerine fail-closed davranış vardır.

### 3.8 Event listener / socket yaşam döngüsü

- Her socket event'i `ignoreStaleSocketEvent` / `lifecycle.isCurrent(generation, sock)` ile korunur.
- `created.sock.ev.removeAllListeners()` + `end()` stale attach'te çağrılır.
- `_startSocket` hata yolunda session `UNAVAILABLE` işaretlenir ve kontrollü retry yapılır (`session-manager.js:4231-4257`).

### 3.9 Gateway → backend event aktarımı

- Kalıcı oturumlarda `event_outbox`; ephemeral oturumlarda best-effort (`events.js:310-384`).
- `attachClient` yalnızca `gateway_connected` + `sessions_count` gönderir (`events.js:398-404`); UI'a session snapshot/replay yoktur. UI, REST + sonraki event'lerle kendini toparlar.
- Outbox at-least-once çalışır: reconnect'te inflight requeue, ACK/NACK ile temizlik (`events.js:127-186`).
- `session_sync_progress` ve `_ephemeral` olayları bilinçli olarak outbox'suzdur; backend restart'ında kaybolabilir (veri kaybı değil, UI sinyali).

---

## 4. QR ve Session Yönetimi Senaryoları

| # | Senaryo | Kod davranışı | Durum |
|---|---|---|---|
| 1 | İlk QR oluşturma | `start_pairing_session` ephemeral gateway oturumu açar; QR `session_qr_updated` + `GET /pairing/{token}/qr` ile alınır | Destekleniyor |
| 2 | QR tarandıktan sonra bağlantı | `connection === 'open'` promotion, lease, `CONNECTED`, `session_connected` | Destekleniyor |
| 3 | İlk senkronizasyonun tamamlanması | `messaging-history.set` + progressive sync; backend ilk sync job'unu `session_connected` sonrası başlatır; erken `initial_sync_completed_at` damgası vardır | Kısmen (P2-5) |
| 4 | QR yenileme | Baileys yeni QR → `session_qr_updated`; modal monoton guard + polling | Destekleniyor (P2-2 küçük yarış) |
| 5 | Kullanıcının bağlantıyı kesmesi | Gateway logout; provider hatasında `force=false` ile throw → DB CONNECTED kalır | Kısmen (P1-2) |
| 6 | Gateway restart | `restoreSessions` + `WHATSAPP_AUTO_RESTORE=true`; credential PG'de ise devam | Kısmen (P1-1) |
| 7 | Backend restart | Durable outbox replay; `_sync_jobs` ve ephemeral progress kaybolur | Kısmen (P1-4) |
| 8 | Sunucunun tamamen restart'ı | 6 + 7 birlikte; auth PostgreSQL'de şifreli saklanır | Kanıtlanamadı (L4 yok) |
| 9 | İnternet kesintisi | Backoff reconnect; 440 özel işlenmez; offline mesajlar WhatsApp'ın offline/history teslimine bağlı | Kanıtlanamadı (L4 yok) + P1-3 |
| 10 | Aynı kullanıcı için tekrar bağlantı | Yeni oturum/QR açılabilir; aynı telefon için promotion fail-closed | Kısmen (P2-3) |

**Kodun desteklemediği / kanıtlanamayanlar:**

- 440 (`connectionReplaced`) için özel davranış yok.
- Gateway restart sonrası "eksik mesajları otomatik tara ve tamamla" mekanizması yok; WhatsApp'ın kendi offline/history teslimine ve kullanıcı isteğine bağlı `requestOlderHistory`'ye güvenilir.
- L4 gerçek cihazla hiçbir senaryo doğrulanmadı.

---

## 5. Contact / JID / LID İncelemesi

### 5.1 JID normalizasyonu

- `whatsapp-identity.js:246-260` (`resolveJidKey`): grup JID'lerini korur, `@c.us` → `@s.whatsapp.net`, LID'yi `store.lidToJid` üzerinden PN'ye çevirir, cihaz suffix'ini (`:12`) temizler.
- Backend `jid_to_phone` (`identity.py:33-56`): `@lid`, `@g.us` reddedilir; en az 5 hane ve tümü sıfır olmama şartı vardır.
- Broadcast (`status@broadcast`) ve newsletter JID'leri ingest'te elenir (`events.py` skip yolları; `session-manager.js` `isBroadcastOnlyJid`).

### 5.2 LID ↔ PN öğrenme

- Mesaj anahtarındaki `senderLid/senderPn`, `participantLid/participantPn` ve `remoteJidAlt/participantAlt` çiftleri `_applyLidMapping`'e verilir (`session-manager.js:2359-2374`).
- `lidPairsFromMessageKey` strict doğrulama kullanır (`whatsapp-identity.js:88-103`); `rememberLidPair` telefon tarafında yalnızca `@lid`'yi reddeder (`whatsapp-identity.js:225-244`), ancak girdiler strict kaynaklardan geldiği için pratikte grup/broadcast PN tarafına yazılmaz.
- `rememberLidPair` çift zaten biliniyorsa `false` döner ve `_applyLidMapping` erken çıkar. Bu, aynı çiftin daha önce öğrenildiği durumda yeni LID sohbet/mesajlarının migrasyonunu atlar; normal akışta anahtar `resolveJidKey` ile zaten PN'ye çözüldüğü için etki sınırlıdır, ancak store yeniden yüklenirken LID anahtarlı kayıt kalmışsa risk vardır.

### 5.3 LID mesajının doğru kişiye/sohbete bağlanması

- **Doğrudan LID sohbeti:** `_ingestUpsertMessage` önce eşlemeleri uygular, sonra `key = normalizeJid(jid)` hesaplar (`session-manager.js:2359-2378`). Eşleme bu mesajda öğrenildiyse anahtar PN'ye çözülür ve mesaj doğru sohbete gider.
- **Eşleme yoksa:** `lidHold = isLidJid(key)` true olur (`session-manager.js:2420`); mesaj RAM'de tutulur, `message_new` **yayınlanmaz** (`2625-2644`). Daha sonra `_applyLidMapping` çalışırsa LID sohbeti/mesajları PN anahtarına taşınır ve yayınlanır (`2891-3010`).
- **Risk:** Eşleme hiç öğrenilmeden gateway restart olursa, RAM'deki LID mesajı kalıcılaşmadan kaybolur (P0-1). Ayrıca RAM store trim limiti, çok sayıda tutulan LID mesajında en eski tutulanları düşürebilir.
- **Grup mesajları:** Grup anahtarı `@g.us` olduğu için `lidHold` false'dur; mesaj gruba doğru bağlanır. Ancak gönderen kimliği (`sender_phone`) LID kalabilir; `_applyLidMapping` yalnızca LID **sohbetinin** mesajlarını migrate eder, grup mesajlarını geriye dönük güncellemez (P2-1).
- **Aynı kişi iki hatta:** Backend reconciliation `session_id=None` ile çağrıldığında konuşmalar `contact_id` anahtarlı sözlükte çakışır (P0-2).

### 5.4 Eşleşme çakışmaları / yarışlar

- `persistLidMappingToDb` `ON CONFLICT (session_id, lid_jid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid` kullanır (`lid-repository.js:70-84`): son yazan kazanır, zaman damgası/versiyon kontrolü yoktur.
- `rememberLidPair` "refreshed mapping" kabul eder ve eski ters indeksleri temizler (`whatsapp-identity.js:225-244`). Telefon numarası değişikliği meşru olabilir; ancak gecikmiş/eski bir olay yeni eşlemenin üzerine yazabilir. Bu, sonraki LID mesajlarının yanlış PN'ye bağlanmasına yol açabilir (P1-6, koşullu P0 sonuç).
- Persist çağrısı `void lidRepository.persistLidMappingToDb(...)` ile fire-and-forget'tir (`session-manager.js:2900`); süreç hemen kapanırsa eşleme DB'ye yazılmamış olabilir (P1-6).

### 5.5 Tenant scoping

- `loadSessionOwners` (`lid-repository.js:32-61`) `public.whatsapp_sessions` ile `whatsapp_private.gateway_sessions` tablolarını `ws.gateway_id = gs.session_id` **veya** `ws.session_name = gs.session_name` üzerinden birleştirir.
- `WhatsAppSession.session_name` unique değildir (`whatsapp_session.py:36`; migration'da UNIQUE yok). Aynı isimli iki hat/tenant varsa gateway, başka tenant'ın LID eşlemelerini de belleğe yükleyebilir (P1-7). Kanıtlanmış bir yanlış mesaj teslimi yoktur; kimlik izolasyonu riskidir.
- `resolve_lid_phone` çağrısı `find_whatsapp_conversation` içinde `gateway_session_id` verilmeden yapılır (`conversations.py:127-133`); kullanıcının en yeni eşlemesi seçilir. LID→PN global bir olgu olduğu için normalde aynı sonucu verir; çakışan veri varsa hatalı olabilir (P2-8).

### 5.6 Telefon normalizasyonu

- `extract_clean_phone` (`identity.py:225-247`): 10 haneli ve `5` ile başlayan **her** numarayı `+90` ile başlatır; 11 haneli `05...` aynı şekilde.
- Bu fonksiyon yeni sohbet numarası çözümünde kullanılır (`whatsapp_service.py:1725`). Kullanıcı ülke kodu olmadan 10 haneli yabancı bir numara girerse (ör. ABD `5123456789`), numara `+905123456789` olarak yorumlanır: yanlış alıcıya gönderim veya teslim hatası (P1-8). UI ülke kodu ister; ülke koduyla girilen numaralar etkilenmez.

---

## 6. Chat ve Message Sync İncelemesi

### 6.1 Upsert / update / receipt / deletion

- `messages.upsert` tipleri: `notify`, `append`, `replace/update` (`session-manager.js:2325-2345`). `append` geçmiş mesajıdır; rozet artırmaz. `replace` içerik güncellemesidir; yeni varış sayılmaz.
- `messages.update` (`socket-events.js:1229-1252`): status update ve içerik update (retry decrypt / edit) ayrı işlenir; içerik `upsertType: 'replace'` ile aynı ingest yolundan geçer.
- Backend `message_new` handler `upsert_type` doğrular (`events.py:898-909`), `replace/update` için içerik günceller ve gereksiz yeniden yayını engeller (`978-1026`).
- Receipt'ler `message_receipt_updated`, silmeler `messages_deleted`, reaksiyonlar `message_reaction`, pinler `message_pinned` olarak işlenir (`events.py:2860-2887`).
- Bu yollar `test_whatsapp_message_update_semantics.py`, `test_whatsapp_remote_deletions.py`, `test_whatsapp_reactions.py`, `test_whatsapp_upsert_append.py` ile L3'te geçti.

### 6.2 Idempotency / duplicate

- Gateway outbox at-least-once; backend `processed_events` (PostgreSQL) + 10.000'lik LRU ile dedupe eder (`events.py:131-156`, `2858`, `2929-2937`).
- `messages` tablosunda `(conversation_id, wa_message_id)` kısmi unique indeksi vardır (`message.py:121-136`), `wa_message_id IS NOT NULL` için.
- Frontend `mergeWhatsAppMessages` `id`, `wa_message_id`, `client_message_id` ile birleştirir (`whatsappMessageMerge.ts:14-75`).
- **Sonuç:** Aynı mesajın iki kez kaydedilmesi normal yollarda engellenir. Farklı sohbetler arasında aynı `wa_message_id` meşru olabilir (LID→PN); bu durumda unique indeks korumaz, reconciliation `wa_message_id` bazlı dedupe yapar (`reconciliation.py:660-700`). Cross-line merge hatası bu korumayı aşabilir (P0-2).

### 6.3 Sıralama

- Backend `_apply_last_message` eski zaman damgasının yeni özeti ezmesini engeller; `test_whatsapp_tenant_isolation.py` içindeki `test_apply_last_message_*` testleri geçti.
- Frontend `compareMessagesChronological` ile sıralar (`whatsappMessageMerge.ts`).
- `replace` olayında `messageTimestamp` yoksa `Date.now()`'a düşürülmez (`socket-events.js:1237-1248`), böylece eski mesaj listenin tepesine taşınmaz.
- L3 kanıtı güçlü; L4'te gerçek cihaz sıralaması doğrulanmadı.

### 6.4 Bağlantı koptuğunda mesaj kaybı

- Normal (PN anahtarlı) mesajlar: gateway RAM'de tutulur, outbox'a yazılır; backend erişilemezse outbox yeniden gönderir. WhatsApp'ın offline teslimi ve history sync'i tamamlayıcıdır.
- **LID anahtarlı ve eşlemesi bilinmeyen mesajlar:** yalnızca RAM'de tutulur; gateway restart'ında kaybolur (P0-1). Bu, "bağlantı koptuğunda mesaj kaybolabilir mi?" sorusunun kanıtlanmış tek doğrudan evet yoludur.
- Backend restart: durable outbox korunur; frontend WS reconnect'te konuşma listesi + aktif sohbetin son 50 mesajı yeniden çekilir (`WhatsAppHubPage.tsx:3325-3347`). Kapalı sohbetler açıldığında REST'ten yüklenir.

### 6.5 Gateway restart sonrası eksik mesaj tamamlama

- `messaging-history.set` (`socket-events.js:847+`) ve `shouldSyncHistoryMessage: () => true`, `syncFullHistory: false` (`socket-connector.js:228-230`).
- Kullanıcı "daha eski" isterse `requestOlderHistory` → `fetchMessageHistory` (`session-manager.js:984-1090`).
- Otomatik "sync sonrası boşluk taraması" yoktur; eksik mesaj tamamlama WhatsApp'ın teslimine bağlıdır. L4 kanıtı yok.

### 6.6 İlk sync ve damga

- Backend `session_connected` sonrası ilk sync job'unu başlatır; `_await_gateway_history_ready` gateway `sync.phase` değerini bekler (`sync.py:732-800`).
- Sabit `_GATEWAY_HISTORY_READY_TIMEOUT_S = 8.0` (`sync.py:568`); üstündeki yorum 120 s diyor → belge sapması.
- Erken damga: sohbetler yazıldığında (`len(conv_out) > 0 or gw_ready_phase != "syncing"`) `initial_sync_completed_at` yazılır (`sync.py:2199-2213`); mesajlar hâlâ akıyor olabilir. Geç damga idempotenttir (`2298-2316`). UI "senkron tamam" görünümüne erken geçebilir (P2-5).

### 6.7 Son mesaj / mesaj listesi tutarlılığı

- Backend `conversation.last_message_at` ve preview'i zaman damgası guard'ı ile güncellenir.
- Frontend `message_new` hem sol listeyi hem açık sohbeti günceller (bkz. §8).
- LID hold edilen mesaj sol listede de yoktur; bu nedenle tutarlılık bozulmaz, ancak mesaj görünmez (P0-1).

### 6.8 Unread count

- Gateway yalnızca yayınlanan (`!lidHold`) ve yeni varış (`!append`, `!replace`) mesajlar için sayar (`session-manager.js:2625-2644`).
- Backend `should_apply_unread_count` ile düşüşü kabul eder, yalnızca kanıtlanabilir eski snapshot'ları reddeder (`events.py:2108-2120`).
- Testler geçti; L4 yok.

### 6.9 Grup metadata

- Grup JID'leri korunur; grup adı contact/conversation üzerinden çözülür.
- Grup mesajlarında gönderen LID'si geriye dönük güncellenmez (P2-1).

---

## 7. Backend / WebSocket İncelemesi

### 7.1 Event ingestion

- `/ws/gateway` (`main.py:609-860`): fail-closed secret (≥32 byte, `compare_digest`), accept, keepalive, seri ingest queue.
- `_ingest_and_publish`: önce `ingest_gateway_event` ile persist, sonra `ws_manager.broadcast`, sonra `gateway_event_ack` (`main.py:788-795`).
- Persist hatası kalıcı NACK; `_skip`/duplicate ACK; `_no_broadcast` ACK; owner çözülemezse transient NACK.
- `ingest_gateway_event` (`events.py:2815-2905`): event_id UUID doğrulaması, processed_events dedupe, handler dispatch, commit (`2937`), ardından ACK.

### 7.2 DB transaction / commit

- Handler ve processed_events aynı transaction içinde commit edilir (`events.py:2929-2937`). Crash durumunda rollback olur; event yeniden gelir.
- `test_whatsapp_event_idempotency.py`, `test_whatsapp_gateway_ack.py`, `test_whatsapp_p0_contract_fixes.py` geçti. Önceki "DB commit" düzeltmesi **DOĞRULANDI**.

### 7.3 Heartbeat / ping-pong

- Gateway köprüsü: backend 20 sn'de ping, 40 sn sessizlikte 1011 kapatır (`main.py:641-668`); gateway pong döner (`events.js:143-150`).
- UI `/ws` (`main.py:553-604`): backend yalnızca istemci ping'ine pong döner; sunucu-initiated ping **yok**. Frontend 25 sn ping / 50 sn timeout uygular (tek singleton WS). Backend tarafı testleri (`test_whatsapp_gateway_liveness.py`) geçti; UI E2E script'i koşmadı.
- Önceki heartbeat düzeltmesi backend/gateway için **DOĞRULANDI**, frontend E2E için **DOĞRULANAMADI**.

### 7.4 Broadcast ve head-of-line blocking

- `ws_manager.broadcast` tenant-scoped, fail-closed; hedef user_id yoksa 0 gönderir (`websocket.py:34-74`). Soketler sırayla `send_text` edilir.
- Broadcast, seri ingest worker içinde **await** edilir (`main.py:788`); yavaş bir UI soketi ACK'i geciktirir. Gateway outbox aynı event'i yeniden gönderebilir; backend dedupe eder. Etki: gecikme ve gereksiz trafik (P1-5).

### 7.5 Backend restart sonrası devamlılık

- Durable event'ler outbox'ta; gateway reconnect'te requeue (`events.js:127-140`).
- `_sync_jobs` bellek içi (`sync.py:540`, `809-838`); restart'ta job/progress kaybolur. `initial_sync_completed_at` DB'de kalır; yarıda kalan sync otomatik devam etmez (P1-4).
- `session_sync_progress` outbox'suz olduğu için restart'ta UI ilerlemesi kaybolur (P2-6).
- `_gateway_bridge` sayaçları ve `_RECENT_PROCESSED_EVENT_IDS` LRU'su sıfırlanır; PostgreSQL `processed_events` kalıcı olduğu için dedupe korunur.

### 7.6 Duplicate / kayıp event

- At-least-once + processed_events + unique index → duplicate DB satırı normalde yok.
- Kayıp: ephemeral/best-effort olaylar, UI kapalıyken kaçırılan event'ler (replay yok, REST telafisi var), LID hold (P0-1).

---

## 8. Frontend Canlı Güncelleme İncelemesi

### 8.1 QR ekranı ve bağlantı durumu

- `WhatsAppQrConnectModal` pairing lifecycle'ı monoton yürütür; `session_connected`, `session_qr_updated`, `session_disconnected` olaylarını işler (`WhatsAppQrConnectModal.tsx:179-200`, `623`).
- Polling yedek yolu vardır (`getPairingQr`, `getSessionQr`).
- QR yenileme desteklenir; geç gelen QR UI'ı CONNECTED'den geri çekmez.

### 8.2 Chat listesi ve gelen mesaj

- `message_new` handler (`WhatsAppHubPage.tsx:2495-2739`) conversation kimliğini çözer, sol listeyi `setConversations` ile günceller (`2591-2666`).
- **Açık sohbet:** aynı handler `setMessagesMap` ile aktif/ bellekteki sohbete mesajı ekler (`2724-2727`):

```tsx
setMessagesMap((prev) => {
  if (isActiveConversation || prev[targetConvId]) {
    return { ...prev, [targetConvId]: mergeWhatsAppMessages(prev[targetConvId] || [], [newMsg]) };
  }
  return prev;
});
```

**"Gelen mesaj sol listeyi güncelliyor, açık sohbet yenilenmiyor" sorunu kodda kapatılmıştır.** Kanıt: yukarıdaki dal + `mergeWhatsAppMessages` (`whatsappMessageMerge.ts:14-75`). Önceki tarayıcı testi (`verify-whatsapp-realtime-inbound.mjs`) bu worktree'de dependency yokluğu nedeniyle koşmadı; verdict L1 kod kanıtına dayanır (**DOĞRULANDI**, tarayıcı E2E **DOĞRULANAMADI**).

### 8.3 Gönderme / durum / okundu

- Optimistic mesaj + `client_message_id` eşleşmesi; `mergeDeliveryStatus` rank ile SENT/DELIVERED/READ ilerletir, FAILED'ı geri almaz (`whatsappMessageMerge.ts:4-11`).
- `message_status_updated` ve `message_receipt_updated` handler'ları vardır.
- Backend testleri geçti; tarayıcı testleri koşmadı.

### 8.4 Sohbet seçimi ve geçmiş

- Seçim `selectedConvRef` + conversationKey ile yönetilir; ChatThread tek instance kuralı korunur.
- Mesaj geçmişi REST ile sayfalanır; reconnect'te son 50 mesaj yeniden çekilir (`handleReconnect`, `3325-3347`).
- Eski mesaj isteme gateway `requestOlderHistory` yoluna bağlıdır; L4 yok.

### 8.5 Reconnect ve stale state

- `handleReconnect` (`3325-3347`): `loadConversations(true)` + aktif sohbetin son 50 mesajı; **session listesini yeniden çekmez**.
- `session_*` event'leri `fetchSessions(true)` tetikler (`3419-3445`), ancak WS kapalıyken kaçırılan `session_disconnected` reconnect'te telafi edilmez → stale "CONNECTED" rozeti (P2-4).
- Gateway WS attach'te snapshot/replay yok; kaçırılan event'ler REST refresh ile telafi edilir (kapalı sohbetler açıldığında).
- UI `/ws` koptuğunda frontend singleton backoff ile yeniden bağlanır; görsel banner/WS durumu tarayıcı testiyle doğrulanmadı.

### 8.6 Avatar

- Backend avatar persistence testi geçti (`test_whatsapp_avatar_persistence.py`); frontend avatar script'leri dependency yokluğu nedeniyle koşmadı. Görsel doğrulama **DOĞRULANAMADI**.

---

## 9. Önceki Düzeltmelerin Doğrulanma Durumu

| Önceki çalışma | Durum | Gerekçe / kanıt |
|---|---|---|
| WhatsApp baseline audit — "QR sonrası sohbetler eksik" (#10) | **DOĞRULANAMADI** | Kodda progressive sync + erken damga var; gerçek cihaz/L4 kanıtı yok. |
| Post-QR performance (21.6 s QR, LID scoping + lease) | **DOĞRULANAMADI** | LID scoping (`lid-repository.js:32-61`) ve lease kodu mevcut; latency ölçümü bu aşamada yapılmadı (browser/node deps yok). |
| `receivedPendingNotifications` düzeltmesi | **DOĞRULANAMADI** | Kod mevcut (`socket-events.js:174-200`, `830`, `1124-1127`); çalıştırılabilir test yok, gateway testleri dependency nedeniyle koşmadı. |
| WebSocket heartbeat | **DOĞRULANDI** (backend/gateway) | `main.py:641-668` ping/pong + 1011; `events.js:143-150` pong; `test_whatsapp_gateway_liveness.py` geçti. Frontend E2E **DOĞRULANAMADI**. |
| DB commit davranışı | **DOĞRULANDI** | persist→commit→ACK sırası (`main.py:788-795`, `events.py:2937`); idempotency/ACK/P0 contract testleri geçti. |
| Message selection | **DOĞRULANAMADI** | `test-whatsapp-message-selection.mjs` / `useChatSelectionAndForward` mevcut; frontend script dependency yokluğu nedeniyle koşmadı. |
| Quick replies | **DOĞRULANAMADI** | Backend `test_whatsapp_quick_replies.py` geçti; frontend `test-whatsapp-quick-replies.mjs` koşmadı (özellik UI ağırlıklı). |
| Context menu | **DOĞRULANAMADI** | `test-whatsapp-context-menu.mjs` / `verify-conversation-menu-dom.mjs` koşmadı. |
| Reactions | **DOĞRULANDI** (L3) | Backend `test_whatsapp_reactions.py`, `test_whatsapp_group_reaction_preview.py` geçti; frontend görsel test koşmadı. |
| Media coordination (kampanya medyası hariç) | **DOĞRULANAMADI** | Gateway medya `.mjs` testleri `uuid` yokluğu, frontend medya testleri `typescript` yokluğu nedeniyle koşmadı. |
| Drag & drop | **DOĞRULANAMADI** | `verify-chat-drag-drop-dom.mjs` koşmadı. |
| Reconnect ve session yönetimi | **AÇIK** | P1-1, P1-2, P1-3, P2-3, P2-4 kodda hâlâ mümkün. |
| WhatsApp gateway davranış testleri | **DOĞRULANAMADI** | `test_whatsapp_phase2_a_gateway_behavior.py` 2 test ERROR: `ERR_MODULE_NOT_FOUND: Cannot find package 'uuid' imported from whatsapp-gateway/src/session-manager.js`. |

---

## 10. Çalıştırılan Testler ve Sonuçları

### 10.1 Test ortamı

- Python: `/Users/isatezcan/Documents/Github/Tezlify/venv/bin/python` (3.14.7), FastAPI/SQLAlchemy/aiosqlite/pytest mevcut.
- Release worktree'de `venv` yok; mevcut venv **read-only** kullanıldı, bağımlılık kurulmadı.
- Test DB: `/tmp/tz60_whatsapp_audit.db`, `scripts/provision_test_db.py` ile 34 tablo + `history_sync_states`, `lid_mappings`, `initial_sync_completed_at` hazırlandı.
- Kullanıcı verisi / production DB değiştirilmedi; yalnızca `/tmp` altında geçici SQLite dosyası kullanıldı.

### 10.2 L1 — statik / derleme

- Kod okuma ve statik çapraz kontrol yapıldı.
- TypeScript derlemesi ve Node `.mjs` testleri **çalıştırılamadı**: release worktree'de `frontend/node_modules` ve `whatsapp-gateway/node_modules` yok; ana projede de `typescript`/`uuid` kurulu değil. Bağımlılık kurulmadı.

### 10.3 L2/L3 — birim + SQLite/izole entegrasyon

Komut (2026-11-03 ~17:45 +03):

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. \
DATABASE_URL="sqlite+aiosqlite:////tmp/tz60_whatsapp_audit.db" \
TEST_DB_PATH=/tmp/tz60_whatsapp_audit.db \
python -m pytest backend/tests/test_whatsapp_*.py \
  -q -p no:randomly -p no:cacheprovider
```

Sonuç:

```text
978 passed, 4 skipped, 2 errors in 91.70s
```

- **4 skipped:** `backend/tests/test_whatsapp_phase6_5_qr_live_seam.py` — `WHATSAPP_LIVE_GATEWAY_URL` verilmediği için (canlı gateway seam testi).
- **2 errors:** `backend/tests/test_whatsapp_phase2_a_gateway_behavior.py::test_hydrated_group_persists_via_real_ingestion` ve `::test_hydrated_group_broadcast_reaches_frontend` — Node harness `uuid` paketini bulamıyor. Ürün hatası değil, ortam/dependency engeli.
- Kapsanan önemli dosyalar: `test_whatsapp_message_update_semantics.py`, `test_whatsapp_remote_deletions.py`, `test_whatsapp_reactions.py`, `test_whatsapp_upsert_append.py`, `test_whatsapp_event_idempotency.py`, `test_whatsapp_gateway_ack.py`, `test_whatsapp_gateway_liveness.py`, `test_whatsapp_p0_contract_fixes.py`, `test_whatsapp_tenant_isolation.py`, `test_whatsapp_sync_job.py`, `test_whatsapp_initial_sync_chunking.py`, `test_whatsapp_pairing_tombstone.py`, `test_whatsapp_session_delete_lifecycle.py`, `test_whatsapp_avatar_persistence.py`, `test_whatsapp_quick_replies.py`.
- Not: İlk denemede `DATABASE_URL`/`TEST_DB_PATH` verilmeden koşulduğunda şema olmadığı için yanıltıcı `no such table` hataları alındı; doğru koşu yukarıdaki provision edilmiş DB ile yapıldı.

### 10.4 Gateway / frontend JS testleri

```text
whatsapp-gateway/tests/*.mjs  → ERR_MODULE_NOT_FOUND: 'uuid'
frontend/scripts/*.mjs        → ERR_MODULE_NOT_FOUND: 'typescript'
```

`NODE_PATH` ESM çözümlemesini düzeltmez; bağımlılık kurulmadı. Bu testler **PASS sayılmadı**.

### 10.5 L4

PostgreSQL + gerçek gateway + gerçek WhatsApp hesabı ile E2E **çalıştırılmadı** (aşama sınırı). Bu nedenle aşağıdaki konular kanıtsızdır:

- Gerçek QR → tarama → ilk sync süresi ve eksiksizliği.
- Gerçek cihazda LID/PN davranışı ve `remoteJidAlt` varlığı.
- Gateway/backend tam restart sonrası oturum sürdürme.
- İnternet kesintisi sonrası offline mesaj tamamlama.
- PostgreSQL üzerinde eşzamanlı LID mapping / processed_events yarışları.

---

## 11. P0 / P1 / P2 Sorun Listesi

| ID | Öncelik | Sorun | Kullanıcı etkisi |
|---|---|---|---|
| P0-1 | P0 | Eşlemesi bilinmeyen LID mesajı yalnızca RAM'de tutuluyor; gateway restart'ında kalıcılaşmadan kayboluyor | Mesaj/sohbet hiç görünmeyebilir |
| P0-2 | P0 | Boot/sweep LID birleştirmesi `session_id=None` ile çalışıyor; aynı kişinin iki hattaki sohbetleri çakışıyor | Mesajlar yanlış hattın sohbetine taşınır (kalıcı tutarsızlık) |
| P1-1 | P1 | Credential yazımı PostgreSQL'e bağımlı ve hata yutuluyor; gerçek disk yedeği yok | Gateway restart'ında oturum sürdürülemeyebilir |
| P1-2 | P1 | Provider logout hatasında DB `CONNECTED` kalıyor, socket orphan kalıyor | "Bağlı" görünen ama mesaj almayan oturum |
| P1-3 | P1 | 440 (`connectionReplaced`) özel işlenmiyor | Başka cihaz/oturum devraldığında reconnect döngüsü |
| P1-4 | P1 | Backend restart `_sync_jobs`'u kaybediyor; yarıda kalan ilk sync otomatik devam etmiyor | Eksik geçmiş, ilerleme kaybı |
| P1-5 | P1 | Broadcast, seri ingest worker içinde ACK'ten önce await ediliyor | Yavaş UI soketi tüm event akışını geciktirir; tekrar teslim |
| P1-6 | P1 | LID mapping persist fire-and-forget; DB upsert son-yazan-kazanır | Eşleme kaybı veya eski eşlemenin yeni üzerine yazması |
| P1-7 | P1 | LID scoping `session_name` eşitliğiyle tenant'ları karıştırabiliyor | Başka tenant'ın LID eşlemeleri belleğe yüklenir |
| P1-8 | P1 | 10 haneli `5...` numaralar zorla `+90` yapılıyor | Ülke kodu verilmeyen yabancı numarada yanlış alıcı |
| P2-1 | P2 | Grup mesajlarında LID gönderen kimliği geriye dönük güncellenmiyor | Grup içinde yanlış/eksik gönderen adı |
| P2-2 | P2 | QR `toDataURL` await'i sonrası lifecycle yeniden doğrulanmıyor | Geç QR event'i (UI guard'lı) |
| P2-3 | P2 | `create_session` / `start_pairing_session` canlı oturum kontrolü yapmıyor | Çoklu oturum/QR, kaynak israfı |
| P2-4 | P2 | Frontend reconnect session listesini yenilemiyor | Kaçırılan disconnect sonrası stale rozet |
| P2-5 | P2 | İlk sync erken damgalanıyor; readiness timeout 8 s (yorum 120 s) | "Senkron tamam" erken görünebilir |
| P2-6 | P2 | `session_sync_progress` outbox'suz; backend restart'ta kayboluyor | İlerleme göstergesi sıfırlanır |
| P2-7 | P2 | `conversation_updated` payload'ındaki `phone` / `identity_state` kullanılmıyor | Telefon yalnızca bu olayla öğrenildiyse REST refresh'e kadar gecikir |
| P2-8 | P2 | `find_whatsapp_conversation` LID çözümünde `gateway_session_id` vermiyor | Çakışan veride en yeni eşleme seçilir |
| P2-9 | P2 | `_connectSocket` in-flight guard yok (generation fence var) | Geçici çift socket/event churn |
| P2-10 | P2 | UI `/ws` sunucu-initiated ping yok | Donmuş sekmede soket sunucuda kalabilir (istemci ping'ine bağlı) |

---

## 12. Her Sorunun Dosya, Fonksiyon ve Kanıt Referansı

### P0-1 — LID mesajının RAM'de tutulup restart'ta kaybolması

- **Nerede:** `whatsapp-gateway/src/session-manager.js:2420` (`_ingestUpsertMessage`, `const lidHold = isLidJid(key)`), `:2625-2644` (`message_new` yalnızca `!lidHold` iken yayınlanıyor), `:2891-3010` (`_applyLidMapping` yalnızca eşleme öğrenilince migrate ediyor).
- **Koşul:** Gelen mesajın anahtarı `@lid`, stanza'da `senderPn` / `participantPn` / `remoteJidAlt` yok ve store'da önceden öğrenilmiş eşleme yok. Gateway bu mesaj yayınlanmadan yeniden başlıyor (veya RAM trim limiti devreye giriyor).
- **Etki:** Mesaj backend'e hiç ulaşmaz; sohbet/mesaj listede görünmez. WhatsApp'ta mesaj duruyorsa sonraki history sync ile gelebilir, ancak bu garanti değildir.
- **Test:** Gateway seviyesinde bu senaryoyu koşturan test yok; `whatsapp-gateway/tests/*.mjs` dependency nedeniyle koşmadı. Backend testleri gateway RAM davranışını kapsamaz.
- **Öncelik:** P0.

### P0-2 — Cross-line LID reconciliation

- **Nerede:** `backend/app/services/whatsapp/reconciliation.py:619-632` (`merge_split_conversation`, `convs = {c.contact_id: c ...}`), çağrılar `:853` (boot) ve `:1049` (sweep) `session_id=None`.
- **Koşul:** Aynı contact'ın iki farklı WhatsApp hattında (`session_id` farklı) conversation satırı var; LID ve PN sohbetleri birleştiriliyor.
- **Etki:** Dict aynı `contact_id` için son satırı tutar; `legacy_conv` ve `canonical_conv` farklı hatlara ait olabilir. `_do_reconciliation` mesajları `legacy_conv`'dan `canonical_conv`'a taşır (`:660-700`) → mesajlar yanlış hattın sohbetine geçer, unread/last-message o hatta yazılır. Kalıcı veri tutarsızlığı.
- **Test:** `test_whatsapp_boot_lid_merge.py`, `test_whatsapp_lid_split_repair.py` tek hat senaryolarını kapsar; çok hatlı çakışma için test yok.
- **Öncelik:** P0.

### P1-1 — Credential yazımının sessizce kaybolması

- **Nerede:** `whatsapp-gateway/src/socket-connector.js:94-115` (`createAuthState` + `saveCreds`), `whatsapp-gateway/src/socket/socket-events.js:133-147` (`creds.update`).
- **Koşul:** PostgreSQL credential/signal key yazımı hata verir (DB kesintisi, kilit, disk). `saveCredentials` exception'ı `saveCreds` içinde yutulur; `diskSaveCreds` de aynı PG fonksiyonunu çağırır, gerçek dosya yazmaz.
- **Etki:** Bellekteki `creds` güncellenir ama kalıcılaşmaz; gateway restart'ında eski credential ile bağlanılmaya çalışılır, oturum açılamayabilir. Kullanıcı yeniden QR/pairing yapmak zorunda kalır.
- **Test:** Yok. `test_whatsapp_session_delete_lifecycle.py` logout/delete kapsar, credential write failure'ı kapsamaz.
- **Öncelik:** P1.

### P1-2 — Logout hatasında orphan CONNECTED oturum

- **Nerede:** `whatsapp-gateway/src/session-manager.js:772-823` (`logoutSession`), `backend/app/api/v1/endpoints/whatsapp.py:352-358`, `backend/app/services/whatsapp/orchestration/sessions.py:1149-1168`.
- **Koşul:** `sock.logout()` exception fırlatır; çağrı `force=false` (API varsayılanı).
- **Etki:** Gateway `lifecycle.invalidate()` ve lease release yapar, ancak status `CONNECTED` kalır ve socket kapatılmaz. Event'ler generation guard nedeniyle atılır; backend DB'yi `DISCONNECTED` yapmaz çünkü gateway çağrısı hata döner. Kullanıcı "bağlı" görür ama mesaj alamaz; tekrar logout/delete gerekir.
- **Test:** `test_whatsapp_session_delete_lifecycle.py` normal yolu kapsar; provider logout hatası için test yok.
- **Öncelik:** P1.

### P1-3 — 440 connectionReplaced işlenmiyor

- **Nerede:** `whatsapp-gateway/src/socket/socket-events.js:456-546` (`connection === 'close'`). Dosyada `connectionReplaced` / `440` hiç geçmiyor.
- **Koşul:** Aynı WhatsApp hesabı başka bir cihaz/oturum tarafından devralınır (veya çift gateway oturumu oluşur) ve Baileys 440 döner.
- **Etki:** Genel transient dal devreye girer; üstel backoff ile yeniden bağlanma denenir. Devralan oturum varken tekrar tekrar bağlanma/atılma döngüsü ve gereksiz lease/socket trafiği oluşabilir.
- **Test:** Yok; gateway davranış testleri dependency nedeniyle koşmadı.
- **Öncelik:** P1.

### P1-4 — Backend restart'ta sync job kaybı

- **Nerede:** `backend/app/services/whatsapp/orchestration/sync.py:540` (`_sync_jobs`), `:809-838` (`request_sync` / `get_sync_job`), `:2199-2213` (erken damga), `:2298-2316` (geç damga).
- **Koşul:** İlk history sync sürerken backend yeniden başlar.
- **Etki:** `_sync_jobs` bellek içi olduğu için job/progress kaybolur; `initial_sync_completed_at` erken damgalanmışsa yeniden sync tetiklenmez. Kullanıcı eksik geçmişle kalabilir; ilerleme göstergesi kaybolur.
- **Test:** `test_whatsapp_sync_job.py`, `test_whatsapp_initial_sync_chunking.py` restart senaryosunu kapsamaz.
- **Öncelik:** P1.

### P1-5 — Inline broadcast nedeniyle ACK gecikmesi

- **Nerede:** `backend/app/main.py:676-795` (`_ingest_worker`, `await ws_manager.broadcast(persisted)` → `gateway_event_ack`), `backend/app/api/v1/websocket.py:34-74` (sıralı `send_text`).
- **Koşul:** Bir UI WebSocket istemcisi yavaşlar/backpressure uygular.
- **Etki:** Seri worker o sokete yazmayı beklerken ACK gecikir; gateway outbox aynı event'leri yeniden gönderebilir. Dedupe sayesinde DB'de duplicate olmaz, ancak tüm kullanıcıların event akışı gecikir.
- **Test:** Gateway ACK/idempotency testleri vardır; yavaş soket/head-of-line senaryosu test edilmemiştir.
- **Öncelik:** P1.

### P1-6 — LID mapping dayanıklılığı ve çakışma

- **Nerede:** `whatsapp-gateway/src/session-manager.js:2900` (`void lidRepository.persistLidMappingToDb(...)`), `whatsapp-gateway/src/lid/lid-repository.js:70-84` (`ON CONFLICT ... DO UPDATE SET phone_jid = EXCLUDED.phone_jid`), `whatsapp-gateway/src/utils/whatsapp-identity.js:225-244` (`rememberLidPair` refreshed mapping kabul eder).
- **Koşul:** Süreç mapping yazılmadan kapanır; veya gecikmiş/eski bir mapping olayı yeni eşlemenin üzerine yazar.
- **Etki:** Eşleme kalıcı olmaz (P0-1'i büyütür) veya sonraki LID mesajları yanlış PN'ye bağlanır.
- **Test:** `test_whatsapp_lid_tenant_isolation.py`, `test_whatsapp_lid_split_repair.py` temel yolları kapsar; fire-and-forget ve stale overwrite için test yok.
- **Öncelik:** P1.

### P1-7 — `session_name` üzerinden cross-tenant LID scoping

- **Nerede:** `whatsapp-gateway/src/lid/lid-repository.js:32-61` (`loadSessionOwners` JOIN), `backend/app/models/whatsapp_session.py:36` (`session_name` unique değil).
- **Koşul:** İki tenant/hat aynı `session_name` değerine sahip.
- **Etki:** Gateway, başka tenant'ın `lid_mappings` satırlarını scope'a dahil eder; LID→PN eşlemeleri belleğe yüklenir. Kanıtlanmış yanlış mesaj teslimi yok; kimlik izolasyonu ve çakışma riski.
- **Test:** `test_whatsapp_lid_tenant_isolation.py` backend tarafını kapsar; gateway SQL JOIN'i için test yok.
- **Öncelik:** P1.

### P1-8 — `5...` 10 haneli numaranın zorla `+90` yapılması

- **Nerede:** `backend/app/services/whatsapp/identity.py:243-246` (`extract_clean_phone`), kullanım `backend/app/services/whatsapp_service.py:1725` (yeni sohbet).
- **Koşul:** Kullanıcı ülke kodu olmadan 10 haneli, `5` ile başlayan yabancı bir numara girer.
- **Etki:** Numara `+90...` olarak yorumlanır; mesaj yanlış ülkedeki bir numaraya gidebilir veya teslim edilemez.
- **Test:** `test_whatsapp_pure_identity.py` Türkiye formatlarını kapsar; yabancı 10 haneli senaryo için test yok.
- **Öncelik:** P1.

### P2-1 — Grup LID gönderen kimliği

- **Nerede:** `whatsapp-gateway/src/session-manager.js:2891-3010` (`_applyLidMapping` yalnızca `messagesByChat.get(lidKey)` altındaki mesajları migrate eder), grup mesajları `@g.us` anahtarı altındadır.
- **Koşul:** Grup mesajı, gönderen LID'si PN'ye eşlenmeden önce gelir.
- **Etki:** Mesaj grupta doğru yere düşer, ancak `sender_phone`/`sender_name` LID olarak kalır; grup içinde gönderen adı eksik/yanlış görünebilir.
- **Test:** `test_whatsapp_phase2_1_a_group_hydration.py` geçti; LID→PN sonrası geri dönük güncelleme testi yok.
- **Öncelik:** P2.

### P2-2 — QR await yarışı

- **Nerede:** `whatsapp-gateway/src/socket/socket-events.js:205-214`, frontend guard `WhatsAppQrConnectModal.tsx:179`.
- **Koşul:** `QRCode.toDataURL` await'i sürerken `connection === 'open'` gerçekleşir.
- **Etki:** Geç `session_qr_updated` yayınlanır; frontend monoton lifecycle guard'ı sayesinde CONNECTED geri alınmaz, ancak gereksiz QR görüntüleme/flash olabilir.
- **Test:** Tarayıcı pairing testleri koşmadı.
- **Öncelik:** P2.

### P2-3 — Çoklu session/pairing oluşturma

- **Nerede:** `backend/app/services/whatsapp/orchestration/sessions.py:419-439` (`create_session`), `:547-610` (`start_pairing_session`).
- **Koşul:** Kullanıcı aynı hat için tekrar "bağlan" veya "QR" başlatır.
- **Etki:** Birden fazla gateway oturumu/QR token'ı, lease rekabeti ve kaynak israfı. Aynı telefon için promotion fail-closed olduğundan veri bozulması yerine bağlanma hatası görülebilir.
- **Test:** `test_whatsapp_pairing_tombstone.py`, `test_whatsapp_phase6_8_promotion.py` geçti; çoklu başlatma senaryosu test edilmedi.
- **Öncelik:** P2.

### P2-4 — Reconnect'te stale session rozeti

- **Nerede:** `frontend/src/pages/WhatsAppHubPage.tsx:3325-3347` (`handleReconnect`), `:3419-3445` (session event refresh).
- **Koşul:** WS kopukken `session_disconnected` kaçırılır.
- **Etki:** Reconnect'te konuşmalar ve aktif mesajlar tazelenir, ancak `sessions` listesi yenilenmez; kullanıcı hâlâ "CONNECTED" rozeti görebilir.
- **Test:** `verify-whatsapp-realtime-inbound.mjs` / `verify-whatsapp-ws-liveness.mjs` koşmadı.
- **Öncelik:** P2.

### P2-5 — Erken initial sync damgası

- **Nerede:** `backend/app/services/whatsapp/orchestration/sync.py:568` (8 s sabit), `:732-800` (readiness), `:2199-2213` (erken damga).
- **Koşul:** Sohbetler yazılır ama mesajlar hâlâ akıyordur.
- **Etki:** `initial_sync_completed_at` erken yazılır; UI "senkron tamam" gösterebilir, mesajlar arkadan gelmeye devam eder. Veri kaybı değil, yanıltıcı durum.
- **Test:** `test_whatsapp_initial_sync_chunking.py` geçti; erken damga/8 s timeout senaryosu L4'te doğrulanmadı.
- **Öncelik:** P2.

### P2-6 — `session_sync_progress` kaybı

- **Nerede:** `whatsapp-gateway/src/events.js:343-346` (`session_sync_progress` outbox'suz), backend `events.py` session_* handler.
- **Koşul:** Backend restart veya gateway→backend kopması sync sırasında olur.
- **Etki:** İlerleme göstergesi sıfırlanır; sync durumu REST ile yeniden alınana kadar UI eksik bilgi gösterir.
- **Test:** `test_whatsapp_sync_notifications.py` geçti; restart senaryosu yok.
- **Öncelik:** P2.

### P2-7 — `conversation_updated` phone/identity_state

- **Nerede:** `backend/app/services/whatsapp/orchestration/events.py:2076-2115` (`_map_conversation_event` payload işleme).
- **Koşul:** Telefon yalnızca `conversation_updated` payload'ındaki `phone` alanıyla öğrenilir.
- **Etki:** Backend bu alanı kullanmaz; telefon REST refresh'e kadar eksik kalır. JID genellikle PN olduğu için etki sınırlıdır.
- **Test:** Yok.
- **Öncelik:** P2.

### P2-8 — LID çözümünde session filtresi yok

- **Nerede:** `backend/app/services/whatsapp/repositories/conversations.py:116-135` (`find_whatsapp_conversation` → `resolve_lid_phone(..., user_id=user_id)`).
- **Koşul:** Aynı LID için kullanıcının farklı hatlarında farklı/yeni eşlemeler varsa.
- **Etki:** En yeni eşleme seçilir; çakışan veride yanlış telefon adayı. Normalde LID→PN global olduğu için etki düşüktür.
- **Test:** `test_whatsapp_lid_tenant_isolation.py` kapsam dışı bırakır.
- **Öncelik:** P2.

### P2-9 — In-flight connect guard yokluğu

- **Nerede:** `whatsapp-gateway/src/session-manager.js:4231-4370` (`_startSocket` / `_connectSocket`).
- **Koşul:** Aynı oturum için eşzamanlı iki `_startSocket` çağrısı (reconnect + manuel start).
- **Etki:** İki socket oluşturulur; generation fence eskiyi reddeder/kapatır. Kalıcı çift socket olmaz, ancak geçici event churn ve gereksiz lease denemesi olur.
- **Test:** `test_whatsapp_phase1_1_lease_truthfulness.py` geçti; eşzamanlı start testi yok.
- **Öncelik:** P2.

### P2-10 — UI `/ws` sunucu ping'i yok

- **Nerede:** `backend/app/main.py:553-604` (`websocket_endpoint`), frontend ping döngüsü.
- **Koşul:** İstemci donar/uyur ama TCP kapanmaz.
- **Etki:** Backend soketi açık tutar; frontend kendi 50 s timeout'u ile toparlanır. Sunucu tarafında kaynak tutulur.
- **Test:** `verify-whatsapp-ws-liveness.mjs` koşmadı.
- **Öncelik:** P2.

---

## 13. PostgreSQL ve L4 İçin Mevcut Kanıt Eksikleri

1. **PostgreSQL yok:** Tüm çalıştırılan testler SQLite (`aiosqlite`). `processed_events` dedupe, `ON CONFLICT` LID upsert, kısmi unique indeks ve lease yarışları PostgreSQL'de ölçülmedi.
2. **Gerçek gateway yok:** Gateway `.mjs` testleri dependency (`uuid`) nedeniyle koşmadı; `phase2_a_gateway_behavior` 2 ERROR. Gerçek Baileys socket davranışı (440, offline teslim, `remoteJidAlt`) kanıtsız.
3. **Gerçek WhatsApp hesabı yok:** QR → tarama → ilk sync → mesaj gönderme/alma zinciri uçtan uca doğrulanmadı. Live seam testleri `WHATSAPP_LIVE_GATEWAY_URL` yokluğundan skip.
4. **Frontend tarayıcı testleri yok:** `typescript` paketi yok; `verify-whatsapp-*` ve `test-whatsapp-*` script'leri koşmadı. Açık sohbet canlı güncelleme, reconnect, avatar ve WS davranışı yalnızca kod kanıtıyla değerlendirildi.
5. **Restart senaryoları yok:** Gateway/backend/tam sunucu restart'ı, internet kesintisi ve aynı kullanıcı için tekrar bağlantı L4'te çalıştırılmadı.
6. **Çok hatlı senaryo yok:** P0-2'nin tetiklenmesi için gereken aynı contact + iki `session_id` kombinasyonu test edilmedi.
7. **Credential failure enjeksiyonu yok:** P1-1'in gerçek etkisi (PG yazım hatası → restart) simüle edilmedi.

---

## 14. Bitiş Git / Worktree Durumu

Rapor oluşturulduktan sonra doğrulanan durum:

| Alan | Değer |
|---|---|
| Çalışma dizini | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| `git status --short` | 32 satır (değişmedi; `reports/` zaten untracked) |
| `git diff --stat` | 14 dosya, +1440 / -161 (değişmedi) |
| `git diff --check` | temiz |
| Yeni/değişen tek dosya | `reports/whatsapp-phase-6.0-core-baseline-audit.md` |
| `uploads/campaign_media` | 0 dosya |
| Commit / push / deploy | Yapılmadı |
| Bağımlılık kurulumu | Yapılmadı |
| Production / gerçek WhatsApp bağlantısı | Yapılmadı |

---

## 15. Bir Sonraki Aşama İçin Öneri

**Yalnızca en kritik ve doğrudan WhatsApp sorunu: P0-1 — eşlemesi bilinmeyen LID mesajının yalnızca RAM'de tutulması ve gateway restart'ında kalıcılaşmadan kaybolması.**

Gerekçe:

- Doğrudan **mesaj kaybı** üretir; kullanıcı WhatsApp'ta olan bir mesajı Tezlify'da hiç görmez.
- Diğer LID sorunlarının (P1-6 persist, P0-2 reconciliation) temelindedir: mesaj önce kalıcı ve doğru kimlikle sisteme girmelidir.
- Kod kanıtı nettir (`session-manager.js:2420`, `2625-2644`, `2891-3010`) ve mevcut test matrisi bu davranışı kapsamamaktadır.

Bir sonraki kodlama aşaması onaylanana kadar bu rapordaki hiçbir sorun düzeltilmeyecektir. Bu aşama burada durur.
