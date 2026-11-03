# AŞAMA 6.1 — LID PENDING MESSAGE DURABILITY

**Eşlemesi Bilinmeyen LID Mesajlarının Kalıcılaştırılması**

| Alan | Değer |
|---|---|
| Kapsam | P0-1: yalnızca eşlemesi bilinmeyen LID mesajının RAM'de kaybolması |
| Çalışma dizini | `/private/tmp/tz429-release` |
| İşlem türü | Dar kapsamlı WhatsApp core bug fix + gerekli DB kalıcılığı/migration |
| Rapor tarihi | 2026-11-03 |

---

## 1. Başlangıç Git / Worktree Durumu

Aşama 6.0 audit'inin bitiş durumu, 6.1'in başlangıç durumudur (6.0 yalnızca kendi raporunu oluşturdu; `reports/` zaten untracked olduğu için durum değişmedi).

| Alan | Değer |
|---|---|
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| `git status --short` | 32 satır |
| `git diff --stat` | 14 dosya, +1440 / -161 |
| `git diff --check` | temiz |
| `uploads/campaign_media` | 0 dosya |
| Commit / push / deploy | Yapılmadı |

Başlangıçta mevcut olan değişiklikler (5.3.40 / 5.4.x birikimi) korundu; hiçbiri geri alınmadı, üzerine yazılmadı. 6.1 yalnızca kendi dosyalarını ekledi.

---

## 2. Gerçek Kök Neden

Eşlemesi bilinmeyen bir LID mesajı (`@lid` JID'si henüz bir telefon JID'sine çözülemiyor) `_ingestUpsertMessage` içinde `lidHold = true` olarak işaretleniyor ve **yalnızca** `session.store.messagesByChat` (RAM) içine yazılıyordu. `message_new` yayınlanmıyordu; bu doğruydu (yanlış kimlikle yayın yapılmamalı). Ancak:

1. Mesajın **kalıcı bir kopyası yoktu**. Gateway yeniden başladığında `messagesByChat` boşalıyor, `lid_mappings` DB'den yeniden yükleniyor ama bekleyen mesajlar kayboluyordu.
2. `boundMessagesByChat` per-chat RAM limiti, bekleyen kaydı sessizce düşürebiliyordu.
3. Eşleme öğrenildiğinde yeniden işlenecek bir kayıt kalmadığı için mesaj hiçbir zaman doğru kişiye/konuşmaya aktarılamıyordu.

Bu, phase 6.0'da P0-1 olarak kanıtlanmıştı: RAM-only tutma + restart/trim sırasında kalıcı kayıt olmaması. 6.1 bu boşluğu, RAM'e yazmadan **önce** şifreli ve oturum-kapsamlı bir PostgreSQL satırı oluşturarak kapatır.

---

## 3. Değişen Dosyalar

| Dosya | Tür | 6.1 katkısı |
|---|---|---|
| `whatsapp-gateway/src/lid/pending-lid-repository.js` | **Yeni** (228 satır) | Şifreli pending-LID deposu: persist / index / list / mark-processed; deterministik event id; FK-orphan raporlama |
| `whatsapp-gateway/src/session-manager.js` | Değişti | Persist-before-RAM, restart yüklemesi, release sweep, claim/retry, durable emission, `_emit` allSettled düzeltmesi |
| `whatsapp-gateway/src/events.js` | Değişti (+25/−8) | `publish()` artık `{ durable: true }` sözleşmesi döndürür; listener promise'i iletir |
| `whatsapp-gateway/src/socket/socket-events.js` | Değişti (+11) | `connection === 'open'` sonrası bekleyen LID release sweep tetiklenir |
| `backend/app/core/migrations.py` | Değişti (+40) | PostgreSQL ve SQLite `lid_pending_messages` DDL + indeks |
| `whatsapp-gateway/package.json` | Değişti | `test` zincirinin sonuna yalnızca 6.1 suite'i eklendi (media satırları önceki aşamalardan) |
| `whatsapp-gateway/tests/test-lid-pending-durability-61.mjs` | **Yeni** (713 satır) | 19 zorunlu/regresyon testi |
| `whatsapp-gateway/tests/lid-durability-test-loader.mjs` | **Yeni** (21 satır) | Baileys/pg/pino/uuid/ws çözümleme kancası |
| `whatsapp-gateway/tests/lid-durability-test-register.mjs` | **Yeni** (3 satır) | Loader'ı `module.register` ile kurar |
| `whatsapp-gateway/tests/stubs/` | Yeni/güncellenen dosyalar | `pino`, `qrcode`, `whatsapp-rust-bridge`, `baileys-crypto`, `baileys-lid`, `ws`; `pg` kontrollü hata enjeksiyonu için uyarlandı |

`session-manager.js` diff'i 552 satırdır; bunun bir kısmı 5.4.x'ten gelen mevcut uncommitted değişikliklerdir. 6.1'e ait noktalar aşağıda satır referanslarıyla verilmiştir.

---

## 4. Kalıcılık Mimarisi

### 4.1 Şema (PostgreSQL, `whatsapp_private`)

`backend/app/core/migrations.py:2177-2193`:

```sql
CREATE TABLE IF NOT EXISTS whatsapp_private.lid_pending_messages (
    session_id     TEXT NOT NULL REFERENCES whatsapp_private.gateway_sessions(session_id) ON DELETE CASCADE,
    lid_jid        VARCHAR(100) NOT NULL,
    wa_message_id  VARCHAR(255) NOT NULL,
    event_id       UUID NOT NULL,
    upsert_type    VARCHAR(20) NOT NULL DEFAULT 'notify',
    ciphertext     BYTEA NOT NULL,
    nonce          BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
    auth_tag       BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
    key_version    SMALLINT NOT NULL CHECK (key_version > 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, lid_jid, wa_message_id)
);
CREATE INDEX IF NOT EXISTS ix_wa_lid_pending_created
    ON whatsapp_private.lid_pending_messages (session_id, created_at);
```

SQLite (dev/test) karşılığı `migrations.py:2110-2148` — şema/foreign key olmadan aynı kolonlar, PK ve indeks.

### 4.2 Şifreleme

- Mevcut `createEncryptedCodec` (AES-256-GCM) kullanılır.
- AAD bağlamı mesajı oturuma ve kimliğe bağlar: `tezlify-wa-v1:lid-pending:${sessionId}:${lidJid}:${waMessageId}`.
- `nonce` 12, `auth_tag` 16 bayt; `key_version` saklanır.
- Payload: Baileys mesajının tamamı (medya anahtarları/thumbnail Buffers dahil). `messageTimestamp` protobuf `Long`/`{low,high}` biçiminden epoch saniyeye normalize edilir; okurken Buffer'lar geri canlandırılır (`pending-lid-repository.js:53-82`).

### 4.3 Depo API'si (`pending-lid-repository.js:84-228`)

| Metot | Davranış |
|---|---|
| `persistPendingMessage` | `INSERT ... ON CONFLICT (session_id,lid_jid,wa_message_id) DO NOTHING`; FK ihlali → orphan raporu + `{persisted:false, reason:'orphaned'}`; diğer hatalar fırlatılır (çağıran retry kuyruğuna alır) |
| `listPendingIndex` | Yalnız `lid_jid, wa_message_id, event_id`; restart'ta şifre çözmeden indeks |
| `listPendingMessages` | Oturum kapsamlı, şifre çözer; çözülemeyen satır **silinmez**, loglanır |
| `markPendingMessageProcessed` | Yalnız kanıtlı teslimden sonra `DELETE` |

### 4.4 Yaşam döngüsü

1. **Ingest:** `lidHold` ise RAM'e push'tan önce `_persistPendingLidMessage` çağrılır (`session-manager.js:2560-2576`).
2. **RAM kaydı:** yalnız `message_new` yayınlanmadan `messagesByChat`'e eklenir; `_lid_pending_event_id` işaretlenir (`:2796-2801`).
3. **Restart:** `createSession` içinde, socket açılmadan önce `listPendingIndex` yüklenir (`:700-723`). Okuma hatası "bekleyen yok" sayılmaz; satırlar kalıcı kalır.
4. **Release:** eşleme öğrenildiğinde veya socket `open` olduğunda sweep çalışır (`:3313-3378`, `socket-events.js:396-403`).

---

## 5. Transaction ve Idempotency

| Mekanizma | Kanıt |
|---|---|
| Doğal birincil anahtar | `(session_id, lid_jid, wa_message_id)` — aynı mesaj ikinci kez kaydedilemez |
| Tekrarlı insert | `ON CONFLICT ... DO NOTHING`; PG'de rowCount 0 |
| Deterministik event id | `${PENDING_SCOPE}:event:${sessionId}:${lidJid}:${waMessageId}` SHA-256 → UUID v5 biçimi (`pending-lid-repository.js:35-45`) |
| Durable emission kontrolü | `events.publish()` yalnız `eventOutbox.enqueue` başarılıysa `{durable:true}` döner (`events.js:360`) |
| Satır silme koşulu | Yalnız `_awaitDurableEmission` `durable === true` ise `_markPendingLidProcessed` (`session-manager.js:2776-2794`) |
| Outbox idempotency | `event_outbox` `ON CONFLICT (event_id) DO NOTHING` |
| Backend idempotency | `/ws/gateway` → `processed_events` dedupe |
| Canlı teslim / release yarışı | Mesaj id'si başına claim + `try/finally` release (`:2405`, `:3052-3091`); 60 sn unref timer |

### Crash pencereleri

| Crash noktası | Sonuç |
|---|---|
| INSERT'ten önce | RAM'de tutulur; retry kuyruğu (5 sn → 5 dk, unref) |
| INSERT sonrası, emit öncesi | Satır kalıcı; restart/release aynı event id ile yeniden dener |
| Emit sırasında, outbox commit öncesi | Satır kalıcı; aynı id ile replay |
| Outbox commit sonrası, DELETE öncesi | Replay aynı id'yi taşır; outbox ve `processed_events` tekilleştirir |
| DELETE sonrası | Replay yok; mesaj zaten teslim edilmiştir |

`_emit` daha önce `Promise.all` (değerler) döndürüyordu; `_awaitDurableEmission` `Promise.allSettled` (`{status,value}`) beklediği için kontrol her zaman `false` kalıyordu. Bu, "emit edildi ama satır silinmedi → tekrar emit" hatasına yol açıyordu. 6.1'de `_emit` `Promise.allSettled` döndürür; ayrıca duplicate dalı `!lidHold` ile korunur, böylece ham LID altında `message_new` yayınlanmaz.

---

## 6. Gateway Restart Davranışı

| Senaryo | Davranış | Test |
|---|---|---|
| A. Gateway restart | Satır DB'de; `createSession` indeksi socket'ten önce yükler; eşleme biliniyorsa `open` sweep'i release eder | `pending message survives a gateway restart` |
| A'. Tekrarlı restart | `ON CONFLICT DO NOTHING`; satır sayısı artmaz | `pending message survives repeated restarts with no duplicate row` |
| B. Mapping-persist / mesaj-işleme yarışı | Mapping yazımı başarısız olsa bile eşleme RAM'de öğrenilir; release kanıtlı teslimden sonra satırı siler | `pending row remains when the mapping write fails and is released once delivery is durable` |
| C. Tekrarlı mesaj idempotency | Aynı `wa_message_id` için tek satır; canlı duplicate ham LID altında emit etmez | `duplicate delivery while held is idempotent and does not emit under the LID` |
| D. Eşleme hiç bulunamaz | `message_new` yayınlanmaz; satır DB'de bekler; yanlış kimliğe teslim yok | `pending message is not emitted before mapping and is released after mapping` |

---

## 7. Eşleme Sonrası Aktarım

- `_applyLidMapping` eşlemeyi `rememberLidPair` ile öğrenir; eşleme zaten biliniyorsa ve bu LID için bekleyen varsa sweep tetiklenir (`session-manager.js:3386-3392`).
- Yeni eşleme kalıcılaştırıldıktan sonra `void this._releasePendingLidMessages(session)` çağrılır (`:3515-3516`). Eşleme DB yazımı başarısız olsa da RAM'de öğrenildiği için release çalışır; satır ancak teslim kanıtlanınca silinir.
- Sweep oturum başına serileştirilir; çalışırken gelen ikinci tetik tek ek geçişe birleştirilir (`_pendingLidReleaseInFlight` / `_pendingLidReleaseAgain`).
- Her satır için: hâlâ çözülemeyen LID atlanır; claim alınamazsa atlanır; konuşmada aynı `wa_message_id` varsa ve `_lid_pending_emitted !== true` ise **aynı satır event id'siyle** bir kez emit edilir; `true` ise satır silinir; kayıt yoksa `pendingEventId` ile normal ingest zincirine sokulur.
- Hata durumunda satır korunur (`rows remain durable`); bir sonraki sweep/restart devam eder.
- Ham LID altında hiçbir yolda `message_new` yayınlanmaz: duplicate dalı `!lidHold` koşuluna bağlıdır (`:2592-2607`).

---

## 8. Eklenen Testler

`whatsapp-gateway/tests/test-lid-pending-durability-61.mjs` (19 test):

1. `persists before returning and does not emit an unknown-LID message`
2. `pending message survives a gateway restart`
3. `pending message survives repeated restarts with no duplicate row`
4. `pending message is not emitted before mapping and is released after mapping`
5. `released message is emitted exactly once`
6. `duplicate delivery while held is idempotent and does not emit under the LID`
7. `pending row remains after event delivery failure and resumes with the same id`
8. `pending row remains when the mapping write fails and is released once delivery is durable`
9. `durable write failure leaves the message held in RAM and schedules a retry`
10. `pending messages are isolated by session`
11. `pending messages are isolated by tenant (session-scoped queries only)`
12. `released record retains the original wa_message_id and timestamp`
13. `not lost when the RAM store limit drops the held record`
14. `regression: normal PN message still emits immediately`
15. `regression: already-mapped LID message emits under the phone JID`
16. `regression: group message uses the group conversation and participant`
17. `regression: outbound recording still emits message_new`
18. `regression: append (history sync) does not raise the unread badge`
19. `deterministic event id is stable, session-scoped and UUID-shaped`

Testler kontrollü hata enjeksiyonu kullanır: `FakePool.failNext/failures.{insert,select,delete,mappingInsert}`, event listener'ın `message_new` için promise reddi. Gerçek DB/ağ/WhatsApp yoktur.

---

## 9. Gerçek Test Sonuçları

| Koşum | Komut | Sonuç |
|---|---|---|
| Yeni 6.1 suite | `node --import ./tests/lid-durability-test-register.mjs tests/test-lid-pending-durability-61.mjs` | **19/19 pass**, 0 fail (145.7 ms) |
| Backend odaklı WhatsApp alt kümesi | `pytest` 12 dosya (migration, startup order, event idempotency, ACK, upsert/append, LID tenant/split/boot, tenant isolation, update semantics, event contract) | **164 passed** |
| Backend tam WhatsApp suite | `pytest -q backend/tests/test_whatsapp_*.py` (temiz SQLite `/tmp/tz61_clean.db`) | **978 passed, 4 skipped, 2 error** (85.07 s) |
| Gateway regresyon (15 script) | `scripts/test-upsert-notify-append`, `test-lid-alt-resolution`, `test-ingest-write-order`, `test-message-update-semantics`, `test-unread-count-progression`, `test-unread-count-authority`, `test-outbound-races`, `test-message-reactions`, `tests/test-history-resilience`, `scripts/test-event-outbox`, `scripts/test-g3-lid-tenant-scope`, `scripts/test-bounded-messages-by-chat`, `scripts/test-tz428-initial-sync-front-trim`, `scripts/test-faz10-p3-fromme`, `tests/test-media-session-dedupe-547` | **Tümü exit 0**; media testi `[test-media-session-dedupe-547] 50 assertions passed` |
| Bilinen baseline testi | `node --import ./tests/lid-durability-test-register.mjs scripts/test-phase2-fixes.mjs` | H-4'te `NOT_REQUESTED !== SOCKET_UNAVAILABLE`; **6.1 öncesi baseline'da aynı** (`/tmp/tz61-baseline`, `git archive HEAD`) |

### 2 backend error'un açıklaması

`test_whatsapp_phase2_a_gateway_behavior.py` iki testi şu nedenle ERROR verdi:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'uuid'
  imported from .../whatsapp-gateway/src/session-manager.js
```

- `uuid` importu HEAD'de zaten vardır (`git show HEAD:.../session-manager.js` satır 11).
- Worktree'de `node_modules` yoktur; bağımlılık kurmak bu aşamada yasaktır.
- `/tmp/tz61-baseline/whatsapp-gateway` (temiz HEAD arşivi) üzerinde aynı harness aynı `ERR_MODULE_NOT_FOUND` ile düşer.
- Sonuç: 6.1 kaynaklı değil, ortam/bağımlılık eksiği. Test sayısına "geçti" olarak yazılmamıştır.

`npm test` çalıştırılamadı (node_modules yok); testler tek tek, kendi loader'larıyla koşuldu.

---

## 10. SQLite / PostgreSQL / L4 Kanıt Ayrımı

| Katman | Ne kanıtlandı | Durum |
|---|---|---|
| **L3 — sözleşme (fake pool, gerçek session-manager)** | 19/19 durability + idempotency + izolasyon + restart + regresyon davranışı | Çalıştırıldı |
| **L3 — SQLite** | `provision_test_db.py` temiz DB üretti; `lid_pending_messages` kolonları ve PK'sı oluştu; 978 backend testi bu DB'de geçti | Çalıştırıldı |
| **L4 — gerçek PostgreSQL 17.11 (yerel `/tmp:5432`, üretim değil)** | Migration iki kez çalıştırıldı (idempotent); 10 kolon, `UUID`/`BYTEA`/`SMALLINT` tipleri, PK `(session_id,lid_jid,wa_message_id)`, FK `gateway_sessions ON DELETE CASCADE`, `ix_wa_lid_pending_created`; duplicate insert 1 satır; nonce/auth_tag/key_version CHECK'leri reddetti; oturum silme cascade etti | **12/12 kontrol PASS** |
| **L4 — gerçek PG, repository SQL sözleşmesi** | `INSERT ... ON CONFLICT DO NOTHING` (2. insert 0 satır), `SELECT ... WHERE session_id=$1 ORDER BY created_at`, natural-key `DELETE` (1 satır), aynı mesaj id'sinin farklı oturumda ayrı satır olması, cascade | Çalıştırıldı (psql, `ON_ERROR_STOP=1`, exit 0) |
| **L4 — Node repository + gerçek PG** | Çalıştırılmadı: worktree'de `node_modules`/`pg` yok, bağımlılık kurmak yasak | **Kanıt yok — iddia edilmiyor** |
| **L4 — gerçek gateway restart + gerçek WhatsApp** | Çalıştırılmadı (gerçek hesaba bağlanma yasağı) | **Kanıt yok — iddia edilmiyor** |

PG rehearsal veritabanı (`tz61_lid_rehearsal`) iş sonunda **drop** edildi; üretim DB'sine hiç bağlanılmadı.

---

## 11. Kalan Riskler

1. **Node repository gerçek PostgreSQL'e karşı koşulmadı.** L4 kanıtı DDL + SQL sözleşmesi düzeyindedir; `pg` Pool üzerinden uçtan uca repository entegrasyonu kanıtlanmamıştır.
2. **Süresiz birikme:** Eşlemesi hiç öğrenilmeyen satırlar için TTL/retention veya metrik yoktur. Tablo büyüyebilir; operasyonel izleme eklenmelidir.
3. **`wa_message_id` yoksa kalıcılaştırma yapılamaz.** Kimliği olmayan mesaj yalnız RAM'de tutulur (kaçınılmaz; kimlik anahtarın parçasıdır).
4. **Durability devre dışı olabilir:** PostgreSQL pool veya şifreleme anahtarı yoksa yalnız yüksek sesli uyarı verilir ve mesaj RAM-only kalır. Prod'da ikisi de mevcuttur, ancak konfigürasyon kaybı sessiz veri kaybına dönüşebilir.
5. **Ephemeral (No-Create) pairing:** `gateway_sessions` satırı oluşana kadar FK nedeniyle yazılamaz; retry kuyruğu promotion sonrası dener. Promotion hiç olmazsa mesaj RAM-only kalır (mevcut mimari sınırı).
6. **Claim/lease süreç içidir.** Aynı oturum için birden fazla gateway süreci çalıştırma senaryosu desteklenmez (6.1 öncesinden gelen mimari kısıt).
7. **Şifre çözme hatası satırı korur** (veri kaybı yerine birikme tercih edildi); anahtar rotasyonu/bozulması operatör müdahalesi gerektirir.
8. **`durable:true` = outbox'a commit edildi**, backend'e işlendi değil. Backend `processed_events` ve outbox idempotency'si replay'i güvenli kılar; yine de teslim gecikmesi olabilir.
9. **Release tetikleyicileri** socket `open` ve `_applyLidMapping`'dir. Gelecekte eşlemenin öğrenildiği yeni bir yol eklenirse sweep açıkça çağrılmalıdır.
10. P0-2 (cross-line reconciliation) ve P1/P2 bulguları **kapsam dışıdır**; düzeltilmedi.

---

## 12. Bitiş Git / Worktree Durumu

| Alan | Değer |
|---|---|
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` (değişmedi) |
| `git status --short` | 39 satır (başlangıç 32; 6.1'in 7 yeni girdisi: 3 modified + 4 untracked dosya; `tests/stubs/` satırı zaten vardı) |
| `git diff --stat` | 17 dosya, +2026 / −174 |
| `git diff --check` | temiz |
| Commit / push / deploy | **Yapılmadı** |
| Bağımlılık kurulumu/güncellemesi | **Yapılmadı** |
| Production DB / gerçek WhatsApp bağlantısı | **Yapılmadı** (yalnız yerel `/tmp:5432` throwaway DB) |
| `uploads/campaign_media` | 0 dosya |
| Kampanya medyası / outreach / reklam dosyaları | 6.1'de **dokunulmadı**; başlangıçtaki uncommitted değişiklikler aynen korundu |
| Yeni/değişen tek rapor | `reports/whatsapp-phase-6.1-lid-pending-message-durability.md` |

`git reset`, `git clean`, `git stash`, `git checkout`, `git switch`, `git rebase`, `git merge`, `git add .`, `git add -A` kullanılmadı.

---

## Karar

**PASS_WITH_NOTES**

Gerekçe: P0-1'in zorunlu mekanizmaları (persist-before-RAM, restart dayanıklılığı, eşleme sonrası doğru aktarım, tek seferlik teslim, duplicate idempotency, hata sonrası satır koruma, oturum/tenant izolasyonu, RAM trim dayanıklılığı) L3 sözleşme testleriyle 19/19 kanıtlandı; migration gerçek PostgreSQL 17 üzerinde 12/12 yapısal/davranışsal kontrolle doğrulandı; backend ve gateway regresyonları geçti. Notlar: Node repository'nin gerçek PostgreSQL'e karşı uçtan uca koşulmamış olması, süresiz birikme için retention/izleme bulunmaması, iki backend testinin ortamda `uuid` bağımlılığı olmadığı için koşulamaması ve bilinen baseline `test-phase2-fixes` H-4 hatasının 6.1'den bağımsız olması.

Bu aşama burada durur; commit/push/deploy yapılmamıştır.
