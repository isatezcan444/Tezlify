# TEZLIFY WHATSAPP — AŞAMA 3.5: BAĞLANTI KURTARMA VE MESAJ SÜREKLİLİĞİ

**Rapor tarihi:** 2026-10-28
**Mod:** KODLAMA + ALTYAPI
**Başlangıç commiti:** `4d49701` (HEAD = origin/main, ağaç temiz)
**Bitiş commiti (kod):** `b5f7605`
**Üretimde çalışan commit:** `b5715fe` (`.deployed-commit`)
**Deploy:** **YAPILMADI** — gateway değişikliği direktif gereği kapılı; backend değişikliği yok.

---

## §0 — YÖNETİCİ ÖZETİ

Bu oturumda üç şey yapıldı:

1. **Canlı sistem salt-okunur ölçüldü** ve oturum/konteyner/auth durumunun korunduğu kanıtlandı.
2. **Kullanıcının bildirdiği "16 Ağustos öncesi yok" hatası canlı olarak yeniden üretildi**: on-demand geçmiş PDO'su **15.1 saniye** bekleyip **TIMEOUT** dönüyor, **0 mesaj** geliyor ve gateway logunda **hiç chunk yok**.
3. **Kanıtlanmış bir metrik hatası düzeltildi** (`messages_cached` reconnect sonrası 0 gösteriyordu) + regresyon testi eklendi. Tüm kapılar yeşil.

**En önemli dürüst tespit:** Mesaj geçmişinin 50'den eski kısmı **yalnızca gateway belleğinde** tutuluyor (`_SYNC_PER_CHAT_LIMIT = 50`). Gateway yeniden başlarsa bu kısım erişilemez hale gelir; PDO da bu sohbet için cevap vermediği için **"bellek kaybı → kalıcı erişilemezlik"** riski somuttur. Bu, tek satırlık bir düzeltme değildir ve bu oturumda kapatılmadı.

---

## §1 — CANLI VE REPO BAZ ÖLÇÜMÜ (salt okunur)

### 1.1 Repo
| Öğe | Değer |
|---|---|
| HEAD / origin/main | `4d49701` |
| Çalışma ağacı | temiz |
| `b5715fe..4d49701` | yalnızca `docs/` + `.workbuddy-ai/memory/` (kod farkı yok) |
| `.deployed-commit` (host) | `b5715fe` |

> `cfc20cf` ve `4d49701` **deploy edilmedi**. Üretim `b5715fe`.

### 1.2 Konteynerler (değişmedi)
| Konteyner | ID | StartedAt | Sağlık |
|---|---|---|---|
| tezlify-backend | `579085f13268` | `2026-10-27T22:25:45Z` | healthy |
| tezlify-gateway | `5b867095d376` | `2026-10-27T17:25:57Z` (image `17:24:11Z`) | healthy |
| tezlify-db | `f6d79c4a1f8b` | `2026-10-01T17:45:08Z` | healthy |
| tezlify-caddy | `ee66a5cab371` | `2026-10-12T13:12:45Z` | healthy |

> Gateway image `b5715fe`'nin atası olan `8a8ae49`/`8e06bad` düzeltmelerini **içeriyor** (container içindeki `/app/src/session-manager.js` satır 1121/1123/1136 okunarak doğrulandı: genişletilmiş `providerFetchNeeded`, `isSocketReady`, `timeoutMs … : 15000`). Yani eski `SOCKET_UNAVAILABLE` / "5 sn clamp" hipotezleri **üretimde zaten giderilmiş**.

### 1.3 Sağlık
- Backend: `{"status":"healthy", "gateway_bridge":{"connected":true,"last_event_at":"2026-10-28T09:38:31Z"}}`
- Gateway: `{"status":"ok","database":"connected","sessions":{"total":1,"connected":1},"live_session_ids":["1bd78836-c084-4cbf-b333-9386d44b7bd7"]}`

### 1.4 Oturum ve sayaçlar (baz)
| Öğe | Değer |
|---|---|
| `whatsapp_sessions` row | `201`, `CONNECTED`, `is_phone_online=t`, `+905413749073` |
| gateway_id | `1bd78836-c084-4cbf-b333-9386d44b7bd7` |
| `initial_sync_completed_at` | `2026-10-27 20:32:33Z` |
| conversation | **124** |
| message | **1657** (max id `160902`) |
| contact | **1536** |
| UNSYNCED sohbet (activity var, 0 mesaj) | **27** |
| Mesajı olan sohbet | **97** |

### 1.5 Kullanıcının örneği
`conv 38346`, `+905414063102` — "Ömer Özcan Türkoğlu", `last_message_at 2026-08-17 05:45:23`, **4 mesaj**:
`2026-08-16 17:05:25` (OUTBOUND, `3AAA33B14604BFC9A632`) → `2026-08-17 05:45:23`.
Kullanıcı ilk mesajı 15 Mayıs'ta gönderdiğini bildiriyor → **4'ten eski hiçbir satır yok**.

---

## §2 — GATEWAY BELLEK YAŞAM DÖNGÜSÜ (kod kanıtı)

`whatsapp-gateway/src/messages/message-store.js::createSessionStore` yalnızca şunları geri yükler:
- `contacts` → `contactCache.load(store, …)` (diskten, `lid-mapping-*.json` + contact cache)
- `rawMediaCache` → `rawMediaCache.load(store)` (diskten)

**Geri yüklenmeyenler:** `messagesByChat`, `chats`, `lidToJid`, `jidToLid`, `rawMessagesByChat`.

Sonuç (A6):
- Süreç yeniden başlarsa `messagesByChat` **boşalır**.
- `chats` / `contacts` Baileys history sync + disk cache ile yeniden dolar.
- **Mesajlar dolmaz**; yalnızca yeni gelen trafik ve yeni history chunk'ları eklenir.

### 2.1 Kalıcılık asimetrisi
- Gateway belleği: tüm history sync chunk'ları (log: `storedMessages` 467 / 4952 / 4667 / 4922 / 4985 / 2208; on-demand chunk'lar 50).
- Backend DB: `_SYNC_PER_CHAT_LIMIT = 50` (`backend/app/services/whatsapp/orchestration/sync.py:107`) — **sohbet başına yalnızca en yeni 50**.
- Sonuç: **50'den eski mesajlar yalnızca bellekte**. Gateway restart'ında erişilemez. PDO da cevap vermezse (aşağıda) kullanıcı için kalıcı görünür.

---

## §3 — MESAJ SÜREKLİLİĞİ: ON-DEMAND GEÇMİŞ ÇEKME (CANLI TEKRAR ÜRETİM)

### 3.1 Çalıştırılan istek (salt-okunur; mesaj göndermez)
```
GET /sessions/1bd78836-…/conversations/905414063102@s.whatsapp.net/messages
    ?limit=50&fetch_provider=true
    &before=<2026-08-16T17:05:25Z ms>
    &oldest_msg_id=3AAA33B14604BFC9A632
    &oldest_msg_from_me=true
    &oldest_msg_timestamp_ms=<aynı ms>
    &timeout_ms=15000
```

### 3.2 Sonuç
```
STATUS 200  elapsed_ms 15100  provider_status: TIMEOUT  messages: []
```
Gateway logu: yalnızca
`Older history request timed out waiting for provider chunk` — **`History sync ingested` yok**.

Yani: PDO gönderildi, telefon **15 saniye içinde hiçbir chunk döndürmedi**.

### 3.3 Bu oturumdaki kanıt eski bağlantılara ait
`whatsapp_private.history_sync_states` anahtarı `(session_id, jid)`; `session_id` = **bağlantı UUID'si**:

| session_id | state | last_error | returned |
|---|---|---|---|
| `8c4dd7ff-…` | PROVIDER_ERROR | `Provider history error: SOCKET_UNAVAILABLE` | 0 |
| `0b72b1ab-…` | PROVIDER_ERROR | `Provider history error: SOCKET_UNAVAILABLE` | 0 |
| `7c73505f-…` | TIMEOUT | Gateway timeout | 4 |

**Mevcut `1bd78836` için satır yok** → bu bağlantıda o sohbet için hiç deneme yapılmamış.
Dağılım (25 satır): **TIMEOUT 13, PROVIDER_ERROR 9, HAS_MORE 3**.

### 3.4 Neden cevap gelmiyor? (elenenler)
- `ON_DEMAND`, Baileys `PROCESSABLE_HISTORY_TYPES` içinde (`Defaults/index.js:38`) → **filtre değil**.
- PDO doğru gönderiliyor: `sendPeerDataOperationMessage` → `relayMessage(meJid, …)`, `category:'peer'`, `push_priority:'high_force'` (`messages-send.js:342-367`).
- Aynı oturumda bazı sohbetler **HAS_MORE 50** ile başarılı → **mekanizma çalışıyor**.
- Bu sohbette 15 sn boyunca **hiç chunk yok** → telefon cevap vermiyor.

Açık kalan üç olasılık: (a) telefon/WhatsApp o an erişilebilir değil (`is_phone_online` yerel bir bayrak, presence değil), (b) anchor telefonun elinde değil, (c) chunk LID anahtarıyla gelip waiter'ın PN anahtarıyla eşleşmiyor. **Üçü de bu oturumda kesinleştirilmedi** — sıradaki adım gateway'e teşhis endpoint'i eklemek.

### 3.5 LID eşlemeleri (kanıt)
`whatsapp_private.lid_mappings`:
- `144130562887745@lid ↔ 905414063102@s.whatsapp.net`
- `97418884436079@lid ↔ 905525372434@s.whatsapp.net`

`resolveJidKey` PN'i **olduğu gibi** döndürür (yalnızca LID→PN çevirir). `loadLidMappingsFromDb` kapsamı `session_name='Hat 1'` üzerinden **tüm geçmiş UUID'leri** kapsıyor (doğrulandı: `gateway_sessions` satırlarının hepsi aynı `session_name`, dolayısıyla aynı `user_id`). Yani eşleme yüklenmiş olmalı; ancak chunk hiç gelmediği için uçtan uca doğrulanamadı.

---

## §4 — EVENT_OUTBOX / DEAD_LETTER (salt-okunur)

Kolonlar: `sequence, event_id, session_id, event_type, ciphertext, nonce, auth_tag, key_version, state, attempts, next_attempt_at, created_at, delivered_at`. Payload **şifreli** (gizlilik korunuyor).

### 4.1 Güncel durum
- **0 DEAD_LETTER**.
- 5848 satır, hepsi `DELIVERED` (4619 × attempts=1, 1229 × attempts=2).
- Sequence aralığı `258079–263926`.

### 4.2 İki eski satır neden yok?
Phase 3.4 raporundaki `247738` / `247865` (`lid_mapped`, attempts=10, key_version=1, session `c2ea3b1d…`) **silinmiş**. Sebep `whatsapp-gateway/src/outbox/postgres-event-outbox.js::cleanup()` satır 232:
```sql
(state = 'DEAD_LETTER' AND created_at < NOW() - INTERVAL '48 hours')
```
Yani **48 saatlik DEAD_LETTER saklama penceresi** var; replay edilmedi, retention sildi.

### 4.3 Etki
- `persistLidMappingToDb` `lid_mappings`'i doğrudan yazar; dead-letter'lanan `lid_mapped` yalnızca **bildirim-tetikli onarımı** (`_ingest_lid_mapped` → `reconcile_legacy_split_conversation`) kaybettirir. Köprü verisi zarar görmez.
- **Replay yapılmadı** (güvenli idempotency/tenant kanıtı yok; satırlar zaten yok).

### 4.4 Operasyonel bulgu
48 saatlik pencere, operatör replay'inin **tek şansı**. Bir replay aracı yazılacaksa 48 saatten önce çalışmalı; aksi halde payload geri dönüşsüz silinir.

---

## §5 — LID VE MESAJ DOĞRULUĞU

- Aşama 3.3/3.4 düzeltmeleri korunuyor: deferral `lid_jid` üzerinden (bağlantı kimliği kullanılmaz), merge sahipliği `contacts.user_id`'den, "bridge yoksa tahmin etme".
- Bu oturumda **tenant sınırı ihlali gözlenmedi**: `history_sync_states` okumaları `session_id` ile kapsamlı (`get_history_evidence` `session_id` zorunlu).
- `lid_mappings` kapsamı tüm geçmiş UUID'leri kapsıyor; kişi bazlı eşleme korunuyor.
- **Ancak** uçtan uca "eski bağlantı kimliğiyle yazılmış eşleme yeni bağlantıda bulunuyor mu" testi, PDO chunk'ı gelmediği için **kanıtlanamadı** (bkz. §3.4).

---

## §6 — KESİNTİ SENARYOLARI

Direktif §3, ayrı test ortamında şunları ister: gateway↔backend WS kesintisi, backend restart, geçici DB kaybı, gecikmiş event, tekrar event, reconnect sırasında gelen mesaj.

**Bu oturumda çalıştırılmadı.** Gerekçe: (a) ayrı bir izole ortam bu oturumda kurulmadı, (b) üretimde kesinti simülasyonu yasak, (c) gateway restart yasak. Kod tarafında ilgili mekanizmalar incelendi:
- `processed_events` idempotency + `(conversation_id, wa_message_id) WHERE NOT NULL` tekilliği (D).
- Outbox `DELIVERED`/`DEAD_LETTER` + retry (`attempts`, `next_attempt_at`).
- Backend `_in_flight_history_fetches` + `_get_conversation_lock` (eşzamanlı sayfa istekleri).

Bu maddeler **BLOCKED** olarak işaretlendi; "PASS" denmedi.

---

## §7 — TEST İZOLASYONU VE KAPILAR

Her tam koşumdan **önce** `scripts/provision_test_db.py` ile `/tmp/tezlify_clean.db` yeniden oluşturuldu (`history_sync_states: True`, `lid_mappings: True`, `initial_sync_completed_at: True`).

| Koşum | Sonuç |
|---|---|
| Backend sabit sıra (`-p no:randomly`) | **1777 passed, 4 skipped** (180.69s), EXIT=0 |
| Backend seed 424242 | **1777 passed, 4 skipped** (144.36s), EXIT=0 |
| Backend seed 777 | **1777 passed, 4 skipped** (155.04s), EXIT=0 |
| Backend seed 900913 | **1777 passed, 4 skipped** (145.56s), EXIT=0 |
| Gateway `npm test` | **PASS** (zincirin sonu `test-latency-metrics` + yeni `test-messages-cached-metric`) |
| Frontend `npm run build` | **BUILD_EXIT=0**, `✓ built in 14.41s` |
| `verify:i18n-keys` | **PASS**, 2425 çağrı, en=3208 tr=3208 |
| `verify:older-page-lock` | **PASS**, 9 kontrol |
| `verify:older-page-state` | **PASS**, 6 kontrol |
| `verify:message-timeout-budget` | **PASS**, 3 kontrol |

**İzolasyon kanıtı:** dört pytest logunda `postgresql`, `130.162`, `tezlify-db` referansı **yok**; DB `/tmp/tezlify_clean.db` (SQLite, 921 KB).

**Baseline farkı:** Phase 3.4 de 1777 passed / 4 skipped idi → **test sayısı farkı yok**. Testler geçsin diye assertion kaldırılmadı/skip edilmedi.

---

## §8 — YAPILAN KOD DEĞİŞİKLİĞİ

**`messages_cached` sağlık metriği yalan söylüyordu.**

- Eski ifade: `Math.max(store?.messages ? store.messages.size : 0, sync.messages_cached || 0)`
- `createSessionStore` **`store.messages` tanımlamıyor** → ilk operand her zaman 0.
- `connection.open` (`socket-events.js:425-428`) `session.sync`'i `messages_cached` anahtarı **olmayan** yeni nesneyle değiştiriyor → reconnect sonrası metrik **0**, bellekte binlerce mesaj varken.
- Yeni: `countCachedMessages(store)` → `messagesByChat` toplamı; iki serializer'da kullanılıyor (`session-manager.js:519`, `index.js:251`).

**Dosyalar / commit `b5f7605`:**
- `whatsapp-gateway/src/messages/message-store.js` — `countCachedMessages`
- `whatsapp-gateway/src/session-manager.js` — import + kullanım
- `whatsapp-gateway/src/index.js` — import + kullanım
- `whatsapp-gateway/scripts/test-messages-cached-metric.mjs` — reconnect şekli + kenar durumlar
- `whatsapp-gateway/package.json` — test zinciri

> Bu bir **gateway** değişikliğidir. Direktif §1/§7 gereği **deploy edilmedi**.

---

## §9 — DEPLOY GÜVENLİĞİ

- Deploy **yapılmadı**. Gateway değişikliği var; `--no-gateway` bunu **reddeder** (exit 1) ve gateway'i yeniden oluşturmak A6 gereği bellek kaybı demektir.
- Candidate DB izolasyonu, migration guard ve cutover bu oturumda **çalıştırılmadı** (deploy yok).
- Watermark karşılaştırması yine de alındı:

| An | conversation | message | max(id) | example conv |
|---|---|---|---|---|
| Baz (10:0x) | 124 | 1657 | 160902 | 4 |
| Son (10:0x) | 124 | **1666** | **160911** | **4** |

`+9` mesaj **meşru canlı trafiktir** (test mesajı gönderilmedi). Örnek sohbet 4'te kaldı — PDO hiçbir şey eklemedi.

---

## §10 — KABUL KRİTERLERİ

| # | Kriter | Sonuç | Gerekçe |
|---|---|---|---|
| 1 | Gateway/backend kesintisi sonrası köprü otomatik toparlanıyor | **BLOCKED** | İzole ortamda kesinti simülasyonu çalıştırılmadı |
| 2 | Tekrar event çift mesaj üretmiyor | **BLOCKED** | `processed_events` + `(conversation_id, wa_message_id)` tekilliği mevcut; canlı yeniden üretim yapılmadı |
| 3 | Kesinti sırasında kalıcılaştırılmış eventler kaybolmuyor | **BLOCKED** | Simülasyon yok; outbox `DELIVERED`/retry yolu kodla doğrulandı |
| 4 | Reconnect sonrası sohbet/kişi/mesaj eşleşmeleri doğru | **PARTIAL** | contacts diskten geri yükleniyor, chats sync ile doluyor; **mesaj belleği dolmuyor** (A6) |
| 5 | Bellek deposunun kaybı kalıcı veri kaybına dönüşmüyor | **FAIL** | `_SYNC_PER_CHAT_LIMIT=50`; 50'den eski mesaj yalnız bellekte; PDO TIMEOUT → erişilemez |
| 6 | LID eşleştirmesi geçmiş bağlantı kimliklerinde çalışıyor, tenant sınırını koruyor | **PARTIAL** | Kapsam tüm geçmiş UUID'leri kapsıyor (doğrulandı); uçtan uca chunk gelmedi |
| 7 | DEAD_LETTER etkisi ve güvenli çözüm kanıtlandı; güvenli değilse replay yapılmadı | **PASS** | 0 DEAD_LETTER; eski 2 satır 48s retention ile silindi; replay yapılmadı |
| 8 | Tüm testler temiz ve izole DB'de geçiyor | **PASS** | 4×1777/4, gateway/frontend/i18n yeşil; prod DB referansı yok |
| 9 | Candidate DB izolasyonu kanıtlandı, watermark tutarlı | **BLOCKED / PASS(watermark)** | Deploy yok → candidate kapısı çalışmadı; watermark +9 canlı trafik, kayıp yok |
| 10 | Mevcut üretim WhatsApp oturumu ve QR/auth korundu | **PASS** | Konteyner ID/StartedAt değişmedi; oturum CONNECTED; gateway restart yok |
| 11 | Gerçek cihaz E2E | **BLOCKED** | Yetkili test cihazı yok; QR/mesaj gönderme/alma manuel doğrulanmadı |

**Özet: 3 PASS, 2 PARTIAL, 1 FAIL, 5 BLOCKED.** Hiçbir veri kaybı yaşanmadığı **kanıtlanamaz**; örnek sohbette 4'ten eski mesaj hâlâ yok.

---

## §11 — KALAN RİSKLER

1. **PDO cevapsızlığı (en yüksek).** Telefon bu sohbet için `HISTORY_SYNC_ON_DEMAND` chunk'ı döndürmüyor. Kod tarafında filtre/anchor hatası elenmedi; sıradaki adım gateway teşhis endpoint'i.
2. **50 mesajlık kalıcılık tavanı.** 50'den eski her mesaj yalnız bellekte. Gateway restart'ı bunu erişilemez yapar. İlk senkron limitini artırmak veya history chunk'larını sınırlı biçimde DB'ye yazmak gerekir (outbox flooding'e dikkat — `6918b3b`).
3. **DEAD_LETTER 48 saat penceresi.** Replay aracı yok; payload 48 saat sonra geri dönüşsüz siliniyor.
4. **Kesinti senaryoları test edilmedi.** Bu oturumda PASS denmedi.
5. **Gerçek cihaz E2E yok.** Oturum durumu ve bridge heartbeat ile yetinildi.
6. **Gateway deploy kapısı.** `messages_cached` fix'i commit'lendi ama deploy edilmedi; bir sonraki gateway deploy'u A6 belleğini kaybedecek (planlı).

---

## §12 — COMMIT / PUSH DURUMU

- `b5f7605` — `fix(gateway): report real cached message count after reconnect`
- Bu rapor + `WHATSAPP_PHASE3_5_HANDOFF.md` ayrı bir `docs(phase3.5)` commit'i ile push edilir.
- **Deploy yapılmadı** (gateway değişikliği kapılı).
