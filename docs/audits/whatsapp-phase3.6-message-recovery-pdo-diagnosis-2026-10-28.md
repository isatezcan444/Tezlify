# TEZLIFY WHATSAPP — AŞAMA 3.6: MESAJ GEÇMİŞİ KURTARMA VE PDO TEŞHİSİ

**Rapor tarihi:** 2026-10-28
**Mod:** KODLAMA + ALTYAPI (P0)
**Başlangıç commiti:** `640b785` (HEAD = origin/main, ağaç temiz)
**Bitiş commiti:** `9754143` (HEAD = origin/main, ağaç temiz)
**Üretimde çalışan commit:** `b5715fe` (`.deployed-commit`)
**Deploy:** **YAPILMADI** — gateway değişikliği var ve direktif §7 gereği ayrı onay istiyor.

---

## §0 — KANIT SEVİYESİ LEJANDI

Bu raporda her iddia hangi seviyede doğrulandığı ile etiketlenir. Bir seviye asla diğeri gibi sunulmaz:

| Etiket | Anlam |
|---|---|
| **[K]** | Kodla doğrulandı — kaynak okundu, çağrı yolu izlendi |
| **[T]** | İzole testle doğrulandı — temiz DB'de koşan test |
| **[P]** | Üretimde salt-okunur gözlemlendi — canlı veri/log okundu, hiçbir şey değiştirilmedi |
| **[E]** | Gerçek cihazda uçtan uca doğrulandı |
| **[B]** | Doğrulanamadı — BLOCKED |

**Bu oturumda [E] seviyesinde hiçbir kanıt üretilmedi.** Yetkili test cihazı yok.

---

## §1 — BAŞLANGIÇ DURUMU (bağımsız doğrulama)

### 1.1 Repo [K]
| Öğe | Değer |
|---|---|
| Branch | `main` |
| HEAD | `640b785` |
| origin/main | `640b785` |
| Çalışma ağacı | temiz |
| `.deployed-commit` (host) | `b5715fe90d0ff05ef497dcccbc87652efa10ccd1` |

> Faz 3.5'in raporu doğrulandı: `b5f7605` / `81e7b84` / `640b785` **deploy edilmedi**. Üretim hâlâ `b5715fe`.

### 1.2 Konteynerler — ÖNCE [P]
| Konteyner | ID | StartedAt |
|---|---|---|
| tezlify-backend | `579085f13268` | `2026-10-27T22:25:45Z` |
| tezlify-gateway | `5b867095d376` | `2026-10-27T17:25:57Z` |

### 1.3 Oturum ve sayaçlar — ÖNCE [P]
| Öğe | Değer |
|---|---|
| `whatsapp_sessions` | `201`, `CONNECTED`, `is_phone_online=t` |
| gateway_id | `1bd78836-c084-4cbf-b333-9386d44b7bd7` |
| conversation | 124 |
| message | 1747 (max id `160992`) |
| contact | 1536 |
| outbox | tümü `DELIVERED`, 0 `DEAD_LETTER` |

### 1.4 Kullanıcının örneği `conv 38346` — ÖNCE [P]
`+905414063102` / `144130562887745@lid`: **4 mesaj**, en eski `2026-08-16 17:05:25`. Kullanıcı ilk mesajı 15 Mayıs'ta gönderdiğini bildiriyor.

---

## §2 — P0-1: MESAJ SÜREKLİLİĞİ (KALICILIK BOŞLUĞU)

### 2.1 Boşluğun nicel ölçümü [P]

Gateway'in `GET /messages?per_chat_limit=…` çıktısı ile DB'deki `wa_message_id` kümeleri **tam kimlik karşılaştırması** ile kıyaslandı (`jid:` öneki ve `+telefon` biçimi normalize edilerek):

| Ölçüm | Değer |
|---|---|
| Gateway RAM'indeki mesaj | **9098** |
| DB'deki mesaj | 1747 |
| Üretim `per_chat_limit=50` ile erişilebilen | 1477 |
| **Yalnızca RAM'de olan (DB'de yok)** | **7080** |
| Etkilenen sohbet | **16** |

En kötü sohbetler: `905413749073-1589570212@g.us` 1688, `905442767554` 1298, `120363406556759828@g.us` 1205, `905076382749` 694, `905525372434` 686.

> Bu, Faz 3.5'te "risk" olarak tarif edilen şeyin **gerçek sayısıdır**: bugün 7080 mesaj yalnızca bellekte. Gateway bir kez yeniden oluşturulursa (A6: `messagesByChat` geri yüklenmez) bu mesajlar **DB'de olmadığı için kalıcı olarak erişilemez** hale gelir.

### 2.2 `conv 38346` yeniden çerçevelendi [P]

**Gateway RAM'inde `38346` için tam olarak DB'deki 4 mesaj var — fazlası yok.**

Yani bu sohbetin 16 Ağustos öncesi geçmişi **kalıcılık kaybı değildir**: gateway'e hiç gelmemiş. Telefon bu sohbet için o mesajları hiç göndermemiş. Dolayısıyla:

- P0-1 (kalıcılık) ile P0-2 (PDO timeout) **gerçekten ayrı iki problemdir**.
- `38346`'nın eski geçmişi bu oturumda **kurtarılmadı ve kurtarıldı diye raporlanmıyor**.

### 2.3 Önce / Sonra mimari

**ÖNCE**
```
telefon ──history sync──► gateway RAM (messagesByChat, sohbet başına 2000)
                                │
                                │ ilk senkron: _SYNC_PER_CHAT_LIMIT = 50
                                ▼
                          backend DB  ← 50'den eskisi HİÇ yazılmaz
```
- RAM: tüm chunk'lar (loglarda `storedMessages` 467 / 4952 / 4667 / 4922 / 4985 / 2208).
- DB: sohbet başına yalnızca en yeni 50.
- PDO telafi edemiyor: `38346` için 15.1 s TIMEOUT.

**SONRA**
```
telefon ──history sync──► gateway RAM ──┐
                                        │  yeni: memory_persistence (300 s)
                                        │  sayfa 500 × azami 20, sohbet başına 2000
                                        ▼
                                  MEVCUT ingest yolu
                        build_message_from_gateway + _insert_messages_resilient
                                        │
                                        ▼
                          backend DB (tekillik aynen korunur)
```
Kritik nokta: **yeni bir paralel yazıcı yok.** Canlı akış ile geçmiş aynı fonksiyonlardan geçer; `(conversation_id, wa_message_id) WHERE NOT NULL` tekilliği ve `processed_events` idempotency'si değişmedi.

### 2.4 Uygulanan değişiklik [K]

`backend/app/services/whatsapp/memory_persistence.py` (yeni, 429 satır):

| Fonksiyon | Görev |
|---|---|
| `_load_conversation_index` | `Conversation.id` + `Contact.phone_e164` seçer (ORM entity **değil**); telefon `+90…` → `phone_to_jid`, grup `jid:` öneki; LID takma adları **yalnızca** `whatsapp_private.lid_mappings WHERE session_id = :sid` |
| `_prefetch_existing_ids` | Sayfa başına mevcut `wa_message_id` kümesi (tek `IN` sorgusu) |
| `drain_gateway_memory_once` | Sayfalı çekme, eşleme, `_insert_messages_resilient`, **sayfa başına commit** |
| `run_memory_persistence_once` | `status='CONNECTED'` hatları gezer; `gateway_id`/`user_id` yoksa **yazar değil, atlar** |
| `memory_persistence_loop` | Tek tur patlarsa ölmez; `max(30, interval)` bekler |

Direktif §2'nin 10 maddesi ve karşılığı:

| # | Gereksinim | Nasıl karşılandı |
|---|---|---|
| 1 | 50 tavanı boşluğunu kapat | RAM'deki tüm mesajlar (sohbet başına 2000'e kadar) DB'ye yazılır |
| 2 | Mesaj başına DB sorgusu/outbox olayı yerine toplu upsert | Sayfa başına tek `IN` ön-sorgusu + tek `INSERT … ON CONFLICT DO NOTHING`; **outbox olayı üretilmez** |
| 3 | Tekillik + idempotency korunur | `on_conflict_do_nothing(index_elements=["conversation_id","wa_message_id"], index_where=wa_message_id IS NOT NULL)` aynen |
| 4 | Canlı + geçmiş aynı ID ile gelince çift olmaması | Ön-filtre (`have` kümesi) + DB tekilliği + `IntegrityError` yutan mevcut yol; `test_live_and_history_same_id_single_row` |
| 5 | Her adımda kiracı sahipliği; LID/PN ile başka kullanıcının mesajını taşımama | `user_id` sahipsizse **hiç yazma**; LID eşlemesi yalnızca o hattın `lid_mappings`'inden; `test_other_tenant_jid_is_not_written`, `test_unmapped_lid_chat_is_skipped` |
| 6 | Sıra/zaman/direction/medya bozulmaması | Satırlar `build_message_from_gateway` ile üretilir (canlı akışla **aynı** üretici); `created_at` yoksa `external_timestamp`/`sent_at`; `apply_conversation_last_message` yalnızca ileri gider → sohbet sırası geri alınamaz (`test_older_messages_do_not_rewind_last_message_at`) |
| 7 | Sınırsız bellek / dev transaction / uzun kilit yok | Sayfa 500, azami 20 sayfa (10 000 mesaj/tur), sayfa başına commit, sohbet başına 2000 |
| 8 | Dry-run + sınırlı çalışma + yeniden koşulabilirlik | `dry_run=True` yazmadan sayar (`test_dry_run_writes_nothing`); `max_pages` sınırı (`test_max_pages_bounds_the_run`); tur idempotent (`test_repeated_drain_is_idempotent`) |
| 9 | Toplu içe aktarma öncesi kaynak/ID/kiracı/çift risk kanıtı | Kaynak = gateway'in kendi RAM'i; kimlik = `wa_message_id`; kiracı = `user_id` + `session_id`; çift = tekillik + test. **Üretime toplu aktarım yapılmadı** (deploy yok) |
| 10 | Telefonun döndürmediği geçmişi uydurmama | `fetch_provider` **hiç çağrılmaz**; PDO yok; yalnızca elde olan yazılır |

**Kill-switch:** `WHATSAPP_MEMORY_PERSIST_ENABLED` (varsayılan `True`), `…_INTERVAL_SECONDS=300`, `…_INITIAL_DELAY_SECONDS=90`, `…_PAGE_SIZE=500`, `…_MAX_PAGES=20`, `…_PER_CHAT_LIMIT=2000`.

**Gözlemlenebilirlik:** `/health.whatsapp_memory_persistence` → `runs / last_started_at / last_finished_at / last_duration_ms / last_inserted / last_scanned / last_pages / inserted_total / skipped_no_session / errors_total / last_error / dry_run_last`. PII yok.

### 2.5 Eşleme kapsamı üretimde doğrulandı [P]

`conversations` JOIN `contacts`: **124/124** sohbetin `phone_e164`'sü dolu, `session_id IS NULL` legacy satır **0**. Yani jid→conversation indeksi sohbetlerin %100'ünü kapsar; canlıya açıldığında "eşlenmeyen sohbet" nedeniyle veri atlanmayacak.

---

## §3 — P0-2: ON-DEMAND PDO TIMEOUT TEŞHİSİ

### 3.1 Katman katman inceleme

| # | Katman | Durum | Kanıt |
|---|---|---|---|
| 1 | Frontend eski-sayfa çağrısı + anchor | **Sağlam** | `before`, `oldest_msg_id`, `oldest_msg_from_me`, `oldest_msg_timestamp_ms`, `timeout_ms` gönderiliyor [K]; `verify:older-page-lock` 9, `verify:older-page-state` 6 kontrol PASS [T] |
| 2 | Backend sayfalama / `before` / `oldest_*` | **Sağlam** | `_hydrate_messages_on_demand` parametreleri aynen iletir; `msg_time_col()` zaman ekseni [K] |
| 3 | Gateway istemcisi `timeout_ms` | **Sağlam** | 15000 ms geçiliyor, gateway `timeoutMs … : 15000` ile sınırlıyor [K]; `verify:message-timeout-budget` 3 kontrol PASS [T] |
| 4 | Gateway route + waiter oluşturma | **Sağlam** | `requestOlderHistory` anchor yoksa `NO_ANCHOR`, socket yoksa `SOCKET_UNAVAILABLE` döner [K] |
| 5 | Gerçek Baileys PDO gönderim noktası | **Kod sağlam, üretimde doğrulanamadı** | `fetchMessageHistory` → `sendPeerDataOperationMessage` → `relayMessage(meJid, category:'peer', push_priority:'high_force')` [K]. **PDO'nun gerçekten çıktığı üretimde kanıtlanmadı** — `pdo_sent` izi commit'lendi ama **deploy edilmedi** [B] |
| 6 | `messaging-history.set` / chunk handler | **Sağlam** | Chunk `isLatest`/`chunkOrder`/`peerDataRequestSessionId` ile yayınlanır; `syncType` Baileys tarafından **hiç yayınlanmaz** (bu bir filtre değil) [K] |
| 7 | Chunk JID normalizasyonu / LID-PN | **Sağlam** | `resolveJidKey` yalnızca LID→PN çevirir, PN'i olduğu gibi döndürür [K] |
| 8 | Waiter çözümü (doğru sohbet/anchor/oturum) | **Sağlam** | `resolveHistoryWaitersForChunk` chat anahtarı ile eşler; başka sohbetin chunk'ı çözmez [T] (`test-history-diagnostics.mjs`) |
| 9 | Timeout + `history_sync_states` kalıcılığı | **Sağlam** | `record_on_demand_provider_result(provider_status="TIMEOUT")` → `state=TIMEOUT`, `has_more=TRUE`, `provider_exhausted=FALSE` [K][P] |
| 10 | Timeout sonrası frontend | **Sağlam** | Durum `TIMEOUT` olarak yüzeye çıkar, "geçmiş bitti" denmez [K] |

### 3.2 Canlı probe sonuçları — arıza SOHBET BAZLI [P]

Aynı socket, aynı oturum, saniyeler içinde dört ayrı sohbet:

| Probe | Sohbet | Sonuç |
|---|---|---|
| C2 | `905064819694` (PN) | **chunk geldi, 1836 ms** |
| LID | `218107046027315@lid` | **chunk geldi, 2200 ms** |
| C1 | `905414063102` (conv 38346) | 8 s → **TIMEOUT**, 0 mesaj |
| C3 | `905525372434` | 8 s → **TIMEOUT**, 0 mesaj |
| C4 | `905315717004` | 8 s → **TIMEOUT**, 0 mesaj |

**Kanıtlanan:** mekanizma çalışıyor (aynı socket üzerinden iki farklı sohbet 1.8–2.2 s'de chunk aldı). Yani:

- **Elenen:** socket kopukluğu, global PDO gönderim hatası, LID↔PN anahtar normalizasyonunun **genel** başarısızlığı, `ON_DEMAND` filtresi, 5 s clamp.
- **Kesinleşen:** arıza **sohbet bazlı**, oturum geneli değil.

### 3.3 `conv 38346` için neden "LID waiter yarışı" DEĞİL [P]

`38346` **PN anahtarlı** bir sohbet (`905414063102@s.whatsapp.net`). `resolveJidKey` PN'i olduğu gibi döndürür → waiter ile chunk anahtarı aynı uzayda. Ayrıca bu oturum `144130562887745@lid ↔ 905414063102` eşlemesini **tutuyor**. Dolayısıyla bu sohbet için anahtar uyuşmazlığı hipotezi **elendi**.

> Not: RAM'de `@lid` anahtarlı **9 mesaj** var → LID anahtarlı sohbetler gerçekten mevcut. Anahtar yarışı hipotezi **yalnızca o sohbetler için** açık kalıyor (kanıtlanmadı).

### 3.4 En güçlü açıklama ve dürüst sınır [P]

`38346`'da gateway RAM'i ile DB **birebir aynı 4 mesaj**. Gateway, telefonun ilk senkron çubuklarını (467/4952/4667/4922/4985/2208) aldı — bu sohbet için **yalnızca 4'ünü**. Yani telefon bu sohbetin eski geçmişini **hiç göndermemiş**.

Bununla birlikte **"telefon geçmiş döndürmüyor" bir kanıt değil, en tutarlı hipotezdir.** Kalan ve elenmemiş hipotezler:

1. Mesajlar telefonda gerçekten yok (silinmiş / sohbet yeniden oluşmuş / farklı hesap).
2. Mesajlar var ama anchor (`3AAA33B14604BFC9A632`) cihazda bulunamıyor.
3. Sağlayıcı bu sohbet için oran sınırlaması uyguluyor (3 sohbet art arda TIMEOUT, 2 sohbet başarılı — zayıf ama elenmedi).
4. Chunk geliyor ama **başka bir oturum/anahtar** altına düşüyor (bu build'de ayırt edilemez — `CHUNK_RECEIVED` izi deploy edilmedi).

**"Uygulama teknik olarak denedi" ≠ "telefon gerçekten döndürdü".** Bu rapor ikincisini iddia etmiyor.

### 3.5 Yeni teşhis izlerinin durumu

Eklenen izler ([K][T] — commit `9754143`): `REQUESTED`, `NO_ANCHOR`, `SOCKET_UNAVAILABLE` (`has_sock`/`has_method`/`ws_ready_state`), `SEND_FAILED`, `SEND_THREW`, `TIMEOUT` (`waited_ms`, **`pdo_sent`**, `chunk_received:false`), `RESOLVED` (`waited_ms`, `chunk_received:true`, mesaj sayısı), `CHUNK_RECEIVED` (tip, adet, `chunkOrder`, `peerDataRequestSessionId` var mı), `CHUNK_MATCHED` / `CHUNK_WAITER_SCAN`.

**Bu izler üretimde SIFIR değer üretiyor — çünkü deploy edilmedi.** §3.4'teki dört hipotezi ayırt edecek tek araç bu izlerdir; ayrı onay olmadan üretimde çalışmayacaklar. Bu, oturumun en önemli kalan işidir.

Gizlilik: JID tipi (PN/LID/GROUP) açıkça yazılır, **tam numara yazılmaz** — JID yerine süreç ömrü sabit tuzlu `sha256`'nın ilk 8 hex'i (`jidTag`). Mesaj içeriği, auth bilgisi, token, payload **loglanmaz** [T] (`test-history-diagnostics.mjs` log üzerinde PII taraması yapıyor).

**Yeni endpoint eklenmedi.** Direktif "eklemek için endpoint ekleme" diyor; mevcut `/health` + gateway logları yeterli görüldü.

---

## §4 — KANIT DURUM MAKİNESİ (`history_sync_states`)

### 4.1 Faz 3.5'in bir iddiası düzeltildi [P]

Faz 3.5 "mevcut `1bd78836` için satır yok" diyordu. **Bugün var:** 4 satır (ikisi `10-27 20:33` ilk senkrondan, biri `10-28 11:30`).

| jid | state | provider_exhausted | has_more | returned |
|---|---|---|---|---|
| `905525372434@s.whatsapp.net` | TIMEOUT | **f** | t | 50 |
| `905413749073-1589570212@g.us` | HAS_MORE | f | t | 50 |
| `905064819694@s.whatsapp.net` | HAS_MORE | f | t | 50 |
| `905387844422@s.whatsapp.net` | TIMEOUT | **f** | t | 0 |

`conv 38346` için mevcut oturumda **kayıt yok**; yalnızca üç eski bağlantı UUID'sinde var (`0b72b1ab`, `8c4dd7ff` PROVIDER_ERROR; `7c73505f` TIMEOUT).

### 4.2 Doğrulanan davranışlar

| Gereksinim | Durum |
|---|---|
| Geçici hata kalıcı tükenme yazmıyor | **PASS** — TIMEOUT satırlarında `provider_exhausted=f`, `has_more=t` [P] |
| Eski bağlantı satırları yeni bağlantıyı engellemiyor | **PASS** — okuma `session_id` ile kapsamlı (`get_history_evidence` zorunlu parametre) [K]; çapraz oturum izolasyonu `test_phase_17_history_evidence::test_10` [T] |
| Aynı kullanıcının geçmiş LID eşlemeleri yeni oturumda yükleniyor | **PASS** — `loadLidMappingsFromDb` kapsamı `session_name`/`user_id` üzerinden tüm geçmiş UUID'leri kapsar [K]; `38346`'nın PN↔LID köprüsü bu oturumda mevcut [P] |
| Sınırsız tekrar / sonsuz geçmiş döngüsü yok | **PASS** — `timeout_count`/`error_count`/`stall_count` sayaçları + `has_more` semantiği [K] |
| Eski kanıt satırları toplu değiştirilmedi/silinmedi | **PASS** — hiçbir `UPDATE`/`DELETE` çalıştırılmadı [P] |

### 4.3 Reversibility

**Bu oturumda hiçbir migration eklenmedi** (`git log 640b785..9754143 --name-only` içinde `alembic`/`migration` yok). Şema değişmedi → geri alma **yalnızca kod** geri almadır.

---

## §5 — TESTLER

### 5.1 Yeni testler

**`backend/tests/test_whatsapp_memory_persistence.py` — 10 test [T]**

| Test | Doğruladığı |
|---|---|
| `test_drains_history_beyond_per_chat_cap` | 50 tavanı ötesindeki mesajlar DB'ye yazılıyor |
| `test_repeated_drain_is_idempotent` | İkinci tur çift satır üretmiyor |
| `test_live_and_history_same_id_single_row` | Canlı + geçmiş aynı `wa_message_id` → **tek satır** |
| `test_other_tenant_jid_is_not_written` | Başka kiracının JID'i yazılmıyor |
| `test_unmapped_lid_chat_is_skipped` | Eşlemesi olmayan LID sohbeti atlanıyor (tahmin yok) |
| `test_dry_run_writes_nothing` | `dry_run` hiçbir satır yazmıyor |
| `test_older_messages_do_not_rewind_last_message_at` | Eski mesaj sohbet sırasını geri almıyor |
| `test_max_pages_bounds_the_run` | `max_pages` sınırı uygulanıyor |
| `test_missing_created_at_falls_back_to_timestamp_s` | `created_at` yoksa `external_timestamp` (zaman ekseni) kullanılıyor |
| `test_loop_survives_a_failing_run` | Düşen tur döngüyü öldürmüyor |

**`whatsapp-gateway/scripts/test-history-diagnostics.mjs` — `npm test` zincirine eklendi [T]:** `jidKind`, `SOCKET_UNAVAILABLE`, PDO çıktı + waiter `requestId` taşıyor + `TIMEOUT`, chunk eşleşmesi → OK ve **logda PII yok**, başka sohbetin chunk'ı waiter'ı çözmüyor, waiter yokken güvenli tarama.

### 5.2 Kapı sonuçları

Her tam koşumdan **önce** `scripts/provision_test_db.py` ile `/tmp/tezlify_clean.db` yeniden üretildi.

| Koşum | Sonuç |
|---|---|
| Backend sabit sıra (`-p no:randomly`) | **1787 passed, 4 skipped** (164.19 s), EXIT=0 |
| Backend seed **424242** | **1787 passed, 4 skipped** (135.38 s), EXIT=0 |
| Backend seed **777** | **1787 passed, 4 skipped** (145.40 s), EXIT=0 |
| Backend seed **900913** | **1787 passed, 4 skipped** (135.52 s), EXIT=0 |
| Gateway `npm test` | **PASS** (zincirin sonu `test-history-diagnostics`) |
| Frontend `npm run build` | **EXIT=0**, `✓ built in 11.95s` |
| `verify:i18n-keys` | **PASS**, 2425 çağrı, en=3208 tr=3208 |
| `verify:older-page-lock` | **PASS**, 9 kontrol |
| `verify:older-page-state` | **PASS**, 6 kontrol |
| `verify:message-timeout-budget` | **PASS**, 3 kontrol |

**Baseline farkı:** Faz 3.5 de `1777 passed / 4 skipped` idi → **+10 test = tam olarak eklenen 10 test**. Test geçsin diye assertion kaldırılmadı, skip eklenmedi, kapsam daraltılmadı.

**İzolasyon kanıtı:** dört pytest logunda `postgresql` / `130.162` / `tezlify-db` referansı **0**. DB `/tmp/tezlify_clean.db` (SQLite, 921 600 bayt).

### 5.3 Test kapısında bulunan gerçek hata (ve düzeltmesi)

İlk dörtlü koşumda **3 test** `UNIQUE constraint failed: leads.phone_e164` ile düştü (`test_auth_multitenancy::test_multitenancy_lead_isolation_native_sessions`, `::test_multitenancy_campaign_groups_isolation`, `test_message_strategy::test_recommend_message_api_endpoint`).

Kök neden **test altyapısıydı, ürün kodu değil**: `settings.DATABASE_URL` = `sqlite+aiosqlite:///./tezlify.db`. Yalnızca `TEST_DB_PATH` export edilince pytest depodaki **eski** `tezlify.db`'ye koştu; birikmiş aynı telefonlu lead'ler rastgele sırada çakıştı. Taze DB'de global `phone_e164` tekilliği **yok** (yalnızca `uq_lead_user_phone … WHERE phone_e164 IS NOT NULL`).

Düzeltme iki katmanlı: (a) koşumda `DATABASE_URL` de aynı dosyaya verildi, (b) `conftest.assert_test_db_matches_requested_path` eklendi → uyuşmazlık artık **RuntimeError** (10 error ile doğrulandı). Sessiz yanlışlık gürültülü hataya çevrildi.

---

## §6 — DEĞİŞEN DOSYALAR

| Dosya | Neden |
|---|---|
| `backend/app/services/whatsapp/memory_persistence.py` **(yeni)** | P0-1 çözümü; mevcut ingest yolunu yeniden kullanan sınırlı süpürme |
| `backend/app/core/config.py` | 6 ayar + canlı ölçüm notu (9098 RAM / 7080 eksik) |
| `backend/app/main.py` | Loop başlatma (kill-switch'li), kapanışta `cancel()`, `/health` alanı |
| `backend/tests/test_whatsapp_memory_persistence.py` **(yeni)** | 10 regresyon testi |
| `backend/tests/conftest.py` | Provision edilen DB ile `DATABASE_URL` uyuşmazlığını sert hata yap |
| `backend/app/services/whatsapp_gateway.py` | `get_messages(..., request_id=)` |
| `backend/app/services/whatsapp/orchestration/sync.py` | `hist-<12hex>` üretimi + log korelasyonu |
| `whatsapp-gateway/src/utils/whatsapp-identity.js` | `jidKind()` (döngüsel import'tan kaçınmak için paylaşımlı) |
| `whatsapp-gateway/src/session-manager.js` | `jidTag`, `historyDiag`, waiter `requestId`, `pdo_sent`, `NO_ANCHOR`/`SOCKET_UNAVAILABLE`/`REQUESTED`/`TIMEOUT`/`RESOLVED`/`SEND_*` |
| `whatsapp-gateway/src/socket/socket-events.js` | `CHUNK_RECEIVED`, `CHUNK_MATCHED`, `CHUNK_WAITER_SCAN`; `resolveHistoryWaitersForChunk` → `{resolved, waiting}` |
| `whatsapp-gateway/src/index.js` | `request_id` parametresini ilet |
| `whatsapp-gateway/scripts/test-history-diagnostics.mjs` **(yeni)** | Teşhis izlerinin testi |
| `whatsapp-gateway/package.json` | Test zinciri |

**Migration yok. Şema değişikliği yok. Mevcut tablo/kolon değişmedi.**

---

## §7 — ÜRETİM DURUMU: ÖNCE / SONRA [P]

| Öğe | ÖNCE | SONRA |
|---|---|---|
| `.deployed-commit` | `b5715fe` | **`b5715fe`** (değişmedi) |
| tezlify-backend | `579085f13268` @ `2026-10-27T22:25:45Z` | **aynı** |
| tezlify-gateway | `5b867095d376` @ `2026-10-27T17:25:57Z` | **aynı** |
| Oturum | `201 CONNECTED`, `is_phone_online=t` | **aynı** |
| conversation | 124 | **124** |
| message | 1747 (max `160992`) | **1751** (max `160996`) |
| contact | 1536 | **1536** |
| `conv 38346` mesaj | 4 | **4** |
| outbox | tümü `DELIVERED`, 0 dead-letter | **tümü `DELIVERED`** (4351; 48 s retention temizliği) |

`+4` mesaj **meşru canlı trafiktir** (test mesajı gönderilmedi, sahte chunk üretilmedi, oturum açılıp kapatılmadı). `38346` 4'te kaldı — PDO hiçbir şey eklemedi.

**Hiçbir üretim yazma işlemi yapılmadı:** migration yok, veri temizliği yok, outbox replay yok, oturum logout/re-pair yok, konteyner restart/recreate yok.

---

## §8 — KABUL KRİTERLERİ

| # | Kriter | Sonuç | Seviye / Gerekçe |
|---|---|---|---|
| 1 | DB'ye yazılmış mesajlar gateway belleği kaybolsa da erişilebilir | **PASS** | [K][T] — DB'deki satır gateway'e bağımlı değil; `test_drains_history_beyond_per_chat_cap` |
| 2 | Yeni ve eski geçmiş mesajları **aynı** kalıcılık yolundan geçiyor | **PASS** | [K][T] — tek yol: `build_message_from_gateway` + `_insert_messages_resilient` |
| 3 | Tekrarlanan chunk'lar çift üretmiyor | **PASS** | [T] — `test_repeated_drain_is_idempotent`, `test_live_and_history_same_id_single_row` |
| 4 | Kiracı izolasyonu ve LID köprüsü testleri geçiyor | **PASS** | [T] — `test_other_tenant_jid_is_not_written`, `test_unmapped_lid_chat_is_skipped`, `test_phase_17_history_evidence` (20 test) |
| 5 | Mevcut mesaj API sayfalaması / `has_more` bozulmadı | **PASS** | [T] — `verify:older-page-lock` 9, `verify:older-page-state` 6, `verify:message-timeout-budget` 3 |
| 6 | Eski mesajların telefonda **gerçekten var olduğu** belirsizse kurtarma başarısı denmez | **PASS (dürüstlük)** | [P] — `38346` 4 mesajda kaldı; kurtarma **iddia edilmiyor** |
| 7 | PDO timeout'un nedeni ölçülebilir kanıtla gösterildi **veya** kalan hipotezler ayrıştırıldı | **PARTIAL** | [P] — arıza **sohbet bazlı** kanıtlandı; 4 hipotez ayrıştırıldı ama **elenmedi** (izler deploy edilmedi) |
| 8 | Geçici sağlayıcı hatası kalıcı tükenme yaratmıyor | **PASS** | [K][P] — TIMEOUT satırlarında `provider_exhausted=f`, `has_more=t` |
| 9 | Temiz izole testler geçiyor | **PASS** | [T] — 4×1787/4, gateway/frontend/i18n yeşil; üretim DB referansı 0 |
| 10 | Canlı oturum ve üretim verisi korundu | **PASS** | [P] — konteyner ID/StartedAt ve oturum durumu değişmedi |
| 11 | Deploy durumu dürüst raporlandı | **PASS** | Deploy **yapılmadı**, gerekçe §9 |
| 12 | Gerçek cihaz E2E | **BLOCKED** | [B] — yetkili test cihazı yok |
| 13 | Gateway belleği kaybı DB'deki mesajları erişilemez yapmıyor — **üretimde** | **PARTIAL** | Kod+test hazır [K][T] ama **deploy edilmedi** → üretimde henüz aktif değil |

**Özet: 8 PASS, 2 PARTIAL, 0 FAIL, 1 BLOCKED (+1 PARTIAL üretim aktivasyonu).**

> Faz 3.5'te kriter 5 **FAIL** idi (kalıcılık boşluğu). Bu oturumda kod ve test düzeyinde kapatıldı; üretimde etkin olması deploy onayına bağlı.

---

## §9 — DEPLOY: YAPILMADI, NEDEN

1. **Gateway değişikliği var** (`session-manager.js`, `socket-events.js`, `index.js`, `whatsapp-identity.js`). Direktif §7: gateway deploy'u **ayrı ve açık onay** ister; bu prompt otomatik deploy yetkisi değil.
2. Gateway'i yeniden oluşturmak **A6 belleğini kaybettirir**: bugün RAM'deki 7080 DB-dışı mesaj **geri getirilemez** hale gelir. Yani deploy'un kendisi, çözmeye çalıştığımız kaybı **tetikler**.
3. `--no-gateway` bu değişiklikle **reddeder** (exit 1) — doğrulandı.
4. Backend değişikliği teknik olarak gateway'siz deploy edilebilir; ancak **deploy kararı bu oturumda verilmedi** (kullanıcı §7: "dağıtım ayrı onaya bağlı").

**Önerilen sıra (ayrı onayla):**
1. Önce **backend-only** deploy → `memory_persistence` canlıda RAM'deki 7080 mesajı DB'ye yazar (tur başına 10 000 sınırı, `last_inserted` ile ölçülür).
2. DB'ye yazma tamamlandıktan **sonra** gateway deploy'u → bellek kaybı artık veri kaybı değil.
3. Gateway deploy'u ile `pdo_sent` / `CHUNK_RECEIVED` izleri açılır → §3.4'ün 4 hipotezi ölçülebilir hale gelir.

> Sıra önemlidir: **gateway önce deploy edilirse 7080 mesaj kaybolur.** Bu, raporun en kritik operasyonel uyarısıdır.

---

## §10 — GERİ ALMA PLANI

| Değişiklik | Geri alma | Risk |
|---|---|---|
| Backend süpürme | `WHATSAPP_MEMORY_PERSIST_ENABLED=false` + backend restart (kod revert gerekmez) | **Düşük** — yalnızca yazma durur, yazılmış satırlar kalır (silinmez) |
| Backend kodu | `git revert 9754143 ba39e56 bafe5b0` | Düşük — migration yok |
| Test kapısı | `git revert a64f405` | Yok — yalnızca test altyapısı |
| Gateway izleri | `git revert 9754143`; deploy edilmediği için **üretimde geri alınacak bir şey yok** | Yok |

**Şema geri alması gerekmez: migration eklenmedi.**

Yazılmış mesajların geri alınması **önerilmez**: `messages` silme işlemi geri dönüşsüzdür ve WhatsApp verisinin yedeği yoktur (`archive_mode=off`, slot yok, PITR yok).

---

## §11 — KALAN RİSKLER

1. **Deploy sırası riski (en yüksek).** Gateway backend'den önce deploy edilirse 7080 mesaj kalıcı kaybolur. Sıra: backend → doğrula → gateway.
2. **Teşhis izleri üretimde yok.** §3.4'ün 4 hipotezi, gateway deploy'u onaylanana kadar **ayrıştırılamaz**. `pdo_sent` alanı olmadan "PDO çıktı mı" sorusu cevapsız.
3. **`38346` geçmişi kurtarılmadı.** 4 mesajda. Telefonun eski geçmişi hiç göndermediği en tutarlı açıklama; kanıt değil.
4. **Süpürme yükü.** 9098 mesaj / 500 sayfa = ~19 sayfa, tur başına ~19 commit. İlk turda DB'ye ~7080 insert olacak. Sayfa başına commit bunu küçük tutuyor ama **ilk tur izlenmeli** (`/health.last_inserted`, `last_duration_ms`).
5. **Outbox'a olay üretilmiyor** — bilinçli. Bu mesajlar için WS bildirimi gitmez; frontend yeniden yüklemede görür. Tasarım gereği, ama not edilmeli.
6. **Gerçek cihaz E2E yok.** Oturum durumu ve chunk probe'ları ile yetinildi.
7. **48 s dead-letter penceresi** (Faz 3.5 bulgusu) değişmedi; replay aracı yok.

---

## §12 — GERÇEK CİHAZ E2E İÇİN GEREKEN

| Gereksinim | Durum |
|---|---|
| Yetkili test WhatsApp hesabı (`+90…`, üretim hattından **ayrı**) | **YOK** |
| O hesapta 30 günden eski, bilinen mesaj geçmişi olan sohbet | **YOK** |
| Cihazda WhatsApp kurulu ve eşleştirilebilir | **YOK** |
| Onaylı bakım penceresi (üretim hattına dokunmadan) | **YOK** |

Bu dört madde sağlanmadan "gerçek cihazda geçmiş geldi" **kanıtlanamaz** ve bu rapor bunu iddia etmiyor.

---

## §13 — COMMIT / PUSH

| Commit | İçerik |
|---|---|
| `a64f405` | `test(backend): temiz test DB'si gercekten kullanilsin` |
| `bafe5b0` | `feat(whatsapp): gateway belleğindeki mesajlar DB'ye kalıcılaştırılsın` |
| `ba39e56` | `feat(whatsapp): on-demand gecmis istegine request_id gecirilsin` |
| `9754143` | `feat(gateway): PDO/gecmis teshis izleri (PII'siz)` |

- Push: `640b785..9754143 → origin/main` ✅
- Çalışma ağacı: temiz
- **Deploy: YAPILMADI.** Üretim `b5715fe`'de kalıyor.
