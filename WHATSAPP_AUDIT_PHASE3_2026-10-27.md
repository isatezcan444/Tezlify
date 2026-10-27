# TEZLIFY WHATSAPP — AŞAMA 3 RAPORU

**Üretim metrikleri, veri bütünlüğü ve gerçek cihaz E2E**
Tarih: 2026-10-27 · Kapanış commit'i: `a46eb0e` · Yayındaki commit: `a46eb0e`

> Bu rapordaki her sayı, süre ve commit gerçek komut çıktısından alınmıştır. Gözlemlenmeyen
> hiçbir sonuç başarı olarak yazılmadı; `BLOCKED` işaretlendi.

---

## A. Başlangıç commit'i ve git durumu

| Ölçüm | Değer |
|---|---|
| Başlangıç HEAD | `3741d68` (= `origin/main`) |
| Başlangıç worktree | **temiz** (korunacak kirli değişiklik yoktu) |
| Yayındaki commit (başlangıç) | `70c0741` |
| Kapanış HEAD | `a46eb0e` (= `origin/main`, push edildi) |
| Yayındaki commit (kapanış) | `a46eb0e` |

**Kod ile canlı arasındaki ayrım — ölçüldü, varsayılmadı:** `70c0741..3741d68` aralığı
`bfc218c` (`test(gateway): pin the QR/sync latency metric contract`) commit'ini içeriyordu ve bu
commit `whatsapp-gateway/` altına dokunuyor. Yani **push edilmiş ama deploy edilmemiş** bir gateway
değişikliği zaten duruyordu. Bu, deploy kararını doğrudan belirledi (bkz. J).

Faz 2 artefaktları koddan yeniden doğrulandı: `whatsapp_data_audit` modeli + servisi,
`/api/v1/whatsapp/data-audit` route'u, WS liveness kodu (`main.py` içinde 7 sembol).

---

## B. Kod değişiklikleri ve commit'ler

### `77f99b5` — backend + testler (deploy edildi)
20 dosya. İki bağımsız boşluk: **süreçten uzun yaşayan kanıt**.

**Bağlantı aşama ölçümü (`whatsapp_connect_stages`)**
- Yeni tablo, `(correlation_id, stage)` **unique** → yeniden teslim edilen bir aşama ikinci örnek
  olmuyor.
- Aşamalar: `pairing_requested`, `qr_received`, `qr_served`, `socket_open`, `first_contact`,
  `first_conversation`, `first_message_persisted`, `sync_completed`, `attempt_failed`.
- **`scan_*` aşaması bilinçli olarak YOK**: kullanıcının QR'ı taradığı an sunucu tarafından
  gözlemlenemez; kaydetmek uydurma olurdu.
- `correlation_id`, gateway oturum UUID'sinden **türetilir** (SHA-256, 32 karakter); gateway her
  eşleştirmede yeni UUID ürettiği için deneme kimliğinin bellekte taşınması gerekmiyor. UUID'nin
  kendisi **hiç saklanmaz**; `gateway_ref` 12 karakterlik hash tutar.
- `elapsed_ms`, **o denemenin** `pairing_requested` satırından ölçülür ve o denemenin başlangıcı
  gözlenmediyse **NULL**'dur (0 değil). Global "en erken başlangıç" araması denemeleri karıştırır.
- `stage_summary()` `MIN_SAMPLES_FOR_PERCENTILE=5` altında p50/p95 **üretmez**, ham değerleri
  döndürür.
- `GET /api/v1/whatsapp/connect-metrics` (auth, `days` 1–90, opsiyonel `correlation_id`).
- Saklama: `CONNECT_METRICS_RETENTION_DAYS=90`, açılışta budanır.

**Denetim atomikliği**
- `stage_data_event()` **çağıranın transaction'ı içinde** yazar; `db.add`'den önce idempotency
  anahtarını önceden kontrol eder, böylece aşamalanmış bir kopya çağıranın `commit()`'ini
  patlatamaz. `record_data_event()` kendi commit'ini korur (sweep rollback yolu için).
- `idempotency_key` üzerinde **kısmi unique index** (`WHERE NOT NULL`), iki lehçe için de.
- `delete_conversation` ve `_ingest_conversation_deleted` denetim satırını **commit'ten önce**
  aşamalar: geri alınan bir silme "başarılı" satır bırakamaz, commit olan bir silme satırını
  kaybedemez.
- `reconcile_self_identity`: `remaining_ref` sorgusundan önce eksik `db.flush()` eklendi.
  `AsyncSessionLocal` `autoflush=False` ile kurulu olduğu için SELECT silinmek üzere işaretlenmiş
  kişiyi hâlâ görüyordu ve **silme dalı ölü koddu**.
- `record_count_snapshot()` yalnızca sohbet/kişi **şekli** değiştiğinde yazar; mesaj trafiği tabloyu
  heartbeat'e çeviremez.
- Denetim hatası **asla yükselmez**; `stats()` `/health` içinde görünür.

**Migration** — `ensure_whatsapp_data_audit_table` gerçek tabloyu `ADD COLUMN IF NOT EXISTS` ile
ALTER eder, index'leri **isimle** yansıtır ve `CREATED/ALREADY_PRESENT/BLOCKED/ERROR` döndürür.
Kopya varsa **reddeder**, hiçbir satırı silmez.

### `a46eb0e` — gateway (deploy edildi)
- `WHATSAPP_LATENCY_PROFILING` varsayılanı **ON** (açık opt-out: `=false`). Üretimde bu değişken
  tanımlı değildi ve üç compose dosyasının hiçbirinde yoktu → üç metrik de sessizdi.
- `extra` yalnızca **skaler** kabul eder; iç içe nesne/dizi **serileştirilmez, düşürülür**. Filtre
  yapısaldır, güncellenmesi gereken bir anahtar kara listesi değildir.
- `test-latency-metrics.mjs` 4 vakayı **çocuk süreçlerde** sınar (pino seviyeyi modül yüklemesinde
  sabitler; süreç içi env değişimi hiçbir şeyi kanıtlamaz).

---

## C. QR / gecikme ölçüm mimarisi

**Ölçümün sahibi backend'dir, gateway değil.** Gerekçe §A6: gateway'in bellek içi deposu her
recreate'te kaybolur ve WhatsApp mevcut oturum için geçmiş göndermez. Ölçüm gateway recreate
gerektirseydi, "ölçmek" her seferinde bir geçmiş kaybı olayı olurdu.

**Frontend'deki dev-only ölçüm üretimde kullanılamaz — yapısal olarak.**
`frontend/src/features/whatsapp/lib/whatsappLatency.ts:2`:
`const enabled = import.meta.env.DEV && import.meta.env.VITE_WHATSAPP_LATENCY_PROFILING === 'true'`.
Bu bir yapılandırma eksiği değil, bilinçli bir kapıdır ve **değiştirilmedi**: tarayıcı tarafındaki
bir tamponun kalıcı bir hedefi yok, üstelik backend'in sahip olduğu ölçümü ikinci kez üretirdi.
Üretim ölçümü backend'de kalır.

**Gizlilik (kriter 3):** aşama tablosunda telefon, JID, LID, mesaj gövdesi, QR içeriği veya kimlik
bilgisi tutan **hiçbir kolon yok** (`id`, `correlation_id`, `stage`, `occurred_at`, `user_id`,
`session_id`, `gateway_ref`, `outcome`, `reason_code`, `elapsed_ms`, `detail`). `detail` yalnızca
sayı ve iç kayıt kimliği taşır. Gateway tarafında `session_ref` opak hash'tir.

---

## D. Gerçek üretim ölçümleri ve örnek sayısı

Oturum **restore** ile geldi (yeni eşleştirme yok), bu yüzden QR aşamaları gözlenmedi.

**Gateway (deploy sonrası, `session_ref=244d0d725095`):**

| Metrik | Süre | Zaman |
|---|---|---|
| `auth_state_load_ms` | **1807.17 ms** | 17:26:01.624 |
| `provider_version_lookup_ms` | **177.99 ms** | 17:26:01.804 |
| `socket_initialization_ms` | **2009.85 ms** | 17:26:01.821 |
| `socket_start_to_ready_ms` | **3581.82 ms** | 17:26:03.393 |

Deploy öncesi bu satırların sayısı **0**'dı (değişken tanımsız → sessiz).

**Backend (kalıcı, `correlation_id=6a78acddd61522772274ab0b1534913e`):**

| Aşama | `occurred_at` |
|---|---|
| `sync_completed` | 17:26:05.185876 |
| `first_conversation` | 17:26:05.195446 |

→ aradaki fark **9.57 ms**. `elapsed_ms` her ikisinde de **NULL**: bu denemenin `pairing_requested`
satırı yok, yani "başlangıç" bilinmiyor. 0 yazmak uydurma olurdu.

**Örnek sayısı: n = 1.** Bu yüzden **p50/p95 ALINTILANMAZ** — eşik 5. `stage_summary` gerçek veride
`{"attempts":1,"stages":{},"min_samples_for_percentile":5}` döndürdü: süre örneklemi olmadığı için
boş, ve bu doğru davranış.

**QR aşamaları (`qr_received`, `qr_served`) ve tarama anı: n = 0 → BLOCKED.** Gerçek bir eşleştirme
yapılmadı (bkz. G); tarama anı zaten sunucudan gözlemlenemez.

---

## E. Sohbet/kişi veri bütünlüğü ve tarihsel olayın atıf durumu

### Olay deploy penceresinde TEKRAR etti
Baseline (15:41 UTC): **124 / 973 / 1536**. Deploy sonrası (17:27): **123 / 1031 / 1535**.
Mesaj sayısı **+58** (normal trafik), buna karşılık bir sohbet ve bir kişi **eksildi**.

Silinen satır **`38287`** — id aralığının en **yeni** üyesi. Kalan tek boşluk `38190`
(Faz 2'den beri bilinen eski boşluk). `38287` artık yok; `max(id)=38286`.

### Test edilip ELENEN hipotezler
| Hipotez | Nasıl elendi |
|---|---|
| Telefondan silme (`deleteChatAction`) | `event_outbox`'ta 15:40 sonrası **hiç** `conversation_deleted` yok |
| Ingest silme yolu (`_ingest_conversation_deleted`) | "Telefondan silinen sohbet kaldirildi" logu **hiç yok** |
| Kimlik birleştirme (`reconcile_self_identity`) | "Self identity reconciled" logu **hiç yok** (tüm container logları) |
| Açılış hayalet temizliği (`purge_empty_ghost_conversations`) | Silme olduğunda **loglar**; log yok → o koşuda 0 sildi |
| Oturum temizliği (`purge_whatsapp_data`) | Tek oturum (id 200) **sağlam**, 123 sohbetin **tamamı** onda; purge hepsini silerdi |
| Denetim yazımının yutulmuş hatası | `/health` → `whatsapp_data_audit.failed = 0` |
| UI'dan silme | Faz 2 kodu commit sonrası denetim yazıyordu; tablo 4.5 saat **0 satır** kaldı |

### Kapanamayan boşluk — dürüstçe
Deploy script'i bir **adacık (candidate) container**'ı kaldırıp **aynı üretim veritabanına karşı tüm
migration setini** çalıştırıyor (17:24:55) ve cutover sonrası container'ı **loguyla birlikte siliyor**.
Bugün o log mevcut değil (`docker ps -a`'da container yok, log dizini yok). Yıkıcı bir migration
(`purge_raw_jid_identity_data`, `merge_deferred_lid_ghosts`, `DELETE FROM conversations`) tam bu
pencerede çalışmış olabilir ve **artık kanıtlanamaz**.

**Karar: `UNATTRIBUTED_HISTORICAL_EVENT`.** Neden uydurulmadı. Yukarıdaki 7 hipotez pozitif olarak
elendi; kalan tek aday gözlemlenemez durumda.

**Ama artık ölçülebilir:** sweep 17:26:55'te ilk baseline'ı yazdı
(`count_snapshot`, `has_baseline:false`, `{conversations:123, messages:1031, contacts:698}`). Bir
sonraki şekil değişimi `previous` alanıyla birlikte yazılacak → değişim **≤900 s** pencereye
hapsedilecek. Yani bu olay atfedilemedi, **bir sonraki atfedilecek**.

### Bütünlük kontrolleri (şu an)
- Yalnızca **1** oturum (id 200, CONNECTED), 123 sohbetin tamamı ona bağlı.
- **0** sahipsiz mesaj (`messages` → `conversations` bütünlüğü sağlam).
- 1412 kişi hiç sohbeti olmayan kayıt (rehber semantiği gereği meşru; veri kaybı değil).
- Sayımlar **global**; denetimdeki sayımlar **kiracı kapsamlı** (698 vs 1535) — bu bir tutarsızlık
  değil, `snapshot_counts(user_id)` kapsamının doğru çalışması.

---

## F. Kalıcı denetim mekanizması ve gizlilik değerlendirmesi

**Transaction tutarlılığı:** denetim satırı silme ile **aynı** transaction'da, `flush()` sonrası ve
`commit()` öncesi yazılır. Geri alma satırı da geri alır; commit satırı da commit eder. İki arıza
modu da (commit edilmiş silme + kayıp satır; geri alınmış silme + sahte satır) kapatıldı ve
**yanlışlandı** (bkz. I).

**Idempotency:** `idempotency_key` üzerinde kısmi unique index. `stage_data_event` `db.add`'den önce
ön kontrol yapar (böylece kopya çağıranın commit'ini patlatmaz), index eşzamanlılık için son
savunma olarak durur. `NULL` anahtarlar kısıtsız.

**Hata görünürlüğü:** `/health` → `"whatsapp_data_audit":{"written":1,"staged":0,"duplicate_skipped":0,"failed":0}`.
`failed:0` olması, "satır yok" durumunun yutulmuş bir hatadan kaynaklanmadığını **kanıtlar**.

**Gizlilik:** satırda telefon/JID/LID/mesaj gövdesi yok. `conversation_ids`/`contact_ids` **iç kayıt
kimlikleri** (rapor için gerekli, PII değil). `detail` yalnızca sayı taşır. Kiracı kapsamı
`snapshot_counts(user_id)` ile üç tabloda da aynı.

**Büyüme sınırı:** `AUDIT_RETENTION_DAYS=400`, açılışta budanır; `count_snapshot` yalnızca şekil
değişiminde yazılır.

**Kalan boşluk (kriter 5'i FAIL yapan):** `purge_whatsapp_data` (oturum silme) ve migration
temizlikleri **denetim yazmıyor**. Bunlar sayı değiştiren gerçek yollar.

---

## G. Gerçek cihaz E2E sonuçları

**`BLOCKED`.** Gerçek cihazla eşleştirme **yapılmadı**.

Gerekçe: (1) açık kullanıcı onayı istenmedi/verilmedi, (2) ayrı yetkili test hesabı yok, (3) üretim
QR'ını geçersiz kılmak, `logout`, oturum silmek veya auth klasörünü temizlemek yasak. Mevcut canlı
oturum riske atılmadı.

Bunun yerine **gözlemlenen** (kanıt türü: üretim logu + DB doğrulaması):
- Gateway 17:25:57'de yeniden oluştu ve oturumu **QR olmadan** kimlik bilgilerinden geri aldı
  (`WHATSAPP_AUTO_RESTORE=true`, `sessions:{total:1,connected:1,pending_qr:0}`).
- `session_connecting` → `session_connected` → `session_sync_completed` outbox olayları
  17:26:01–17:26:03 arasında yazıldı.
- `lid_mapped` ×2 17:26:00'da işlendi.
- `first_conversation` ve `sync_completed` kalıcı olarak kaydedildi.

**Gerçek cihazdan gelen mesaj, LID/PN eşlemesi, gönderim sonucu ve durum güncellemeleri
DOĞRULANMADI.** Mock/birim sonucu gerçek cihaz başarısı olarak sunulmadı.

---

## H. WS / gateway doğrulaması

| Kontrol | Sonuç |
|---|---|
| `last_pong_at` ilerlemesi | 17:30:19.824 → 17:30:39.824 = **tam 20.000 s** |
| `reconnect_count` | **1** (deploy sonrası tek reconnect; tekrar yok) |
| `gateway_bridge.connected` | `true` |
| `whatsapp_identity_sweep` | `runs=1`, `errors_total=0`, `merged_total=0`, `last_duration_ms=13.455` |
| Outbox (15:40 sonrası) | 5845 toplam, 5843 `DELIVERED`, 2 `DEAD_LETTER` (önceden var) |
| `requeueInflight()` | `postgres-event-outbox.js:219`, her socket `open`'ta çağrılıyor (`events.js:133`) |
| `verify:ws-lifecycle` | 12/12 |
| `verify:realtime` | 9/9 |
| `verify:ws-liveness` | tüm assertion'lar geçti |
| `verify:loading-gate` | OK |
| `verify:pairing` | PASS (14 kontrol) |

Canlı yarım-açık (half-open) testi **yapılmadı**; watchdog'ın 20 s ping / 40 s pong bütçesi kod ve
mevcut regresyon testleriyle doğrulandı, canlı zorlama ile değil.

---

## I. Test sonuçları ve yanlışlama kanıtı

**Backend (tam suite, `-p no:randomly`):** `1673 passed, 4 skipped, 463 warnings` — **exit 0**.
(Öncesi: 1666 passed / **6 failed** / 4 skipped → 6 kırmızı düzeltildi.)

**Gateway:** `npm test` → **exit 0**, `121 ok`, `0 not ok`, `0 FAIL`.
`test-latency-metrics.mjs` → **exit 0**, tüm assertion'lar geçti.

**Frontend:** `tsc` exit 0; `vite build` exit 0 (9.56 s). (Bu turda frontend dosyası değişmedi.)

**Yanlışlamalar — hepsi geri alındı, hiçbiri commit edilmedi:**

| Kırılan koşul | Beklenen | Sonuç |
|---|---|---|
| Gateway varsayılanı opt-in'e geri alındı | 2 kırmızı | 2 kırmızı ✓ |
| `extra` skaler filtresi kaldırıldı | sızıntı yakalanmalı | 1 kırmızı, log satırında `"body":"merhaba","jid":"905551112233@s…` ✓ |
| `reconcile_self_identity`'deki `flush()` kaldırıldı | 1 kırmızı | 1 kırmızı ✓ |
| Migration ALTER atlandı | 3 kırmızı | 3 kırmızı ✓ |
| Kopya reddi devre dışı | 1 kırmızı | 1 kırmızı ✓ |
| Metrikte deneme-bazlı başlangıç → global en erken | 2 kırmızı | **ilk turda 0** → testler güçlendirildi, sonra 2 ✓ |

Son satır bu turun en öğretici bulgusu: **düzeltme kaldırıldığında yeşil kalan test boş bir testtir.**
İki test, yabancı bir denemenin başlangıç satırını önce yazacak ve **büyüklük** iddia edecek şekilde
yeniden yazıldı (`150 ms aradan sonra < 100 ms`).

**Harness kusuru ürün hatasından ayrıldı:** `test_whatsapp_remote_deletions.py`'deki sahte oturumda
`flush()` eksikti (eksik double, yanlış test değil); `test_phase154_session_recovery.py`'deki
`assert not db.add.called` ise niyeti "yeni public oturum yok" iken "hiç add yok" diyordu — niyeti
koruyacak şekilde daraltıldı.

---

## J. Deploy, çalışan commit ve sağlık kanıtı

**Deploy guard'ın gerçek kararı (kuru koşu, üretim host'unda):**
```
gateway'i etkileyen degisiklikler:
     whatsapp-gateway/package.json                     |   2 +-
     whatsapp-gateway/scripts/test-latency-metrics.mjs | 189 ++++++++++++++++++++++
     whatsapp-gateway/src/observability.js             |  60 ++++++-
     3 files changed, 244 insertions(+), 7 deletions(-)
HATA: --no-gateway kullanilamaz: gateway/compose degismis (bayragi kaldirin)
NOGW_EXIT=1
```
Yani **`--no-gateway` bu aralık için imkânsızdı** — benim değişikliğimden bağımsız olarak, çünkü
`bfc218c` zaten aralıkta duruyordu. Seçenek "gateway recreate veya hiç deploy etmemek" idi.
Kullanıcı **açık onayla** gateway recreate'i seçti. Muhafız **atlatılmadı**, bayrak zorlanmadı.

**Release:** `bash scripts/deploy/host-release.sh a46eb0e` → **`RELEASE_EXIT=0`**, süre 2 dk 23 s.
```
cutover dogrulandi: backend=sha256:a6ca7 gateway=sha256:a1ba2
SURUM TAMAM: a46eb0e — feat(gateway): latency metrics ON by default, scalars-only detail
```

**Deploy sonrası doğrulama:**

| Kontrol | Sonuç |
|---|---|
| `.deployed-commit` | `a46eb0e214ed892f758b207cf16e4744ffc0065d` |
| `/health` | `healthy`, `gateway_bridge.connected=true` |
| `whatsapp_connect_stages` | tablo var, **2 gerçek satır** |
| `whatsapp_data_audit` | tablo var, **1 gerçek satır** (`count_snapshot`) |
| `uq_wa_data_audit_idempotency_key` | `... USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)` ✓ |
| `uq_wa_connect_stage` | `UNIQUE (correlation_id, stage)` ✓ |
| `/api/v1/whatsapp/connect-metrics` (kimliksiz) | **401** |
| Aynı route, yetkili veri katmanı | `stage_summary` ve `attempt_timeline` gerçek veride çalıştı |
| `whatsapp_data_audit` stats `/health`'te | `written:1, failed:0` ✓ |
| Gateway `StartedAt` | 11:39:38 → **17:25:57 (değişti — recreate)** |
| Sohbet/kişi | 124 → 123 / 1536 → 1535 (bkz. E) |

**Gateway recreate'ın bedeli — açıkça:** bellek içi `chats` / `messagesByChat` / `store.contacts`
kayboldu (§A6) ve geri kurulmaz. **Oturum korundu**: kimlik bilgilerinden QR olmadan geri geldi.
DB'ye dokunulmadı.

**Geri dönüş:**
```bash
bash scripts/deploy/host-release.sh --rollback-to 20261027T172340Z
```

---

## K. Kabul kriterleri — PASS / FAIL / BLOCKED

| # | Kriter | Sonuç | Kanıt |
|---|---|---|---|
| 1 | QR ve sync metrikleri üretimde gerçekten üretiliyor | **PASS** | 4 gateway metriği + 2 kalıcı backend aşaması, gerçek satırlar; öncesi 0 |
| 2 | İlk QR, bağlantı açılışı, ilk kayıt, ilk görünür sohbet ayrı ayrı ölçülebilir | **PASS** | Ayrı aşamalar, ayrı `occurred_at` (9.57 ms fark). **KAPSAM NOTU:** QR aşamaları n=0 (restore), bkz. #8 |
| 3 | Ölçümlerde PII / mesaj içeriği / QR içeriği / kimlik verisi yok | **PASS** | Şema + yapısal skaler filtre + 4 gerçek satırın denetimi + test |
| 4 | Metrikler bağlantı denemeleri arasında karışmıyor | **PASS** | Türetilmiş deneme kimliği, unique `(correlation_id, stage)`, başlangıç bilinmiyorsa NULL; yanlışlandı |
| 5 | Sohbet/kişi değişiklikleri kalıcı izlenebilir, sebep koduyla | **FAIL** *(düzeltme commit'lendi `8cd4223`, doğrulandı, deploy kalıyor)* | Mekanizma kuruldu ve çalışıyor; `purge_whatsapp_data` + `purge_empty_ghost_conversations` artık `stage_data_event` ile denetim yazıyor (bkz. L). Canlı değişim 38287 hâlâ `UNATTRIBUTED_HISTORICAL_EVENT` (atfedilemez geçmiş olay) — ama yol artık denetimli. **Üretim hâlâ `a46eb0e`; `8cd4223` deploy edilince kriter PASS'e geçer.** |
| 6 | Transaction hatası sahte "başarılı silme" satırı üretmiyor | **PASS** | `flush()`+`stage_data_event`+`commit()` sırası; rollback/commit yanlışlamaları |
| 7 | `124 → 123` için uydurma neden yok | **PASS** | `UNATTRIBUTED_HISTORICAL_EVENT`; 7 hipotez pozitif elendi, tahmin yazılmadı |
| 8 | Gerçek cihaz akışının her adımı kanıt türüyle | **BLOCKED** | Onay/test hesabı yok; eşleştirme yapılmadı |
| 9 | Kişi/sohbet/grup/mesaj ve LID/PN tutarlı | **PASS** | 0 sahipsiz mesaj, tek oturum, 27/27 sıfır-mesaj sohbet `NOT_CHECKED` (uydurma yok) |
| 10 | WS watchdog ve reconnect regresyonları geçiyor | **PASS** | pong tam 20.000 s, `reconnect_count=1`, lifecycle 12/12, realtime 9/9, liveness OK |
| 11 | Güvenli deploy sırasında gateway in-memory verisi korunur | **FAIL** | Recreate yapıldı (onaylı), bellek içi depo kayboldu. Oturum korundu, depo korunmadı |
| 12 | Test/build/deploy gerçek çıktıyla raporlandı | **PASS** | 1673/4, 121 ok/0 not ok, tsc+build 0, `RELEASE_EXIT=0` |

**Özet: 9 PASS · 2 FAIL · 1 BLOCKED**

---

## L. Kalan riskler ve sonraki en küçük güvenli adım

**Riskler**
1. **Adacık container'ın migration logu yok.** Deploy, aynı üretim DB'sine karşı tüm migration
   setini çalıştırıp container'ı loguyla siliyor. Yıkıcı bir migration geri iz bırakmadan çalışabilir.
   Bu, `124→123`'ün atfedilememesinin **doğrudan** nedenidir.
2. **İki sayı-değiştiren yol denetimsiz:** `purge_whatsapp_data` (oturum silme) ve migration
   temizlikleri (`purge_raw_jid_identity_data`, `merge_deferred_lid_ghosts`,
   `purge_empty_ghost_conversations`).
3. **`elapsed_ms` yalnızca taze eşleştirmede dolar.** Restore edilen oturumda yalnızca aşama
   varlığı kaydedilir, süre yok — bu doğru ama süre örneklemi birikirken kırılımı sınırlar.
4. **Süre örneklemi n=1.** p50/p95 için 5 örnek gerekli; şu an hiçbir gecikme iddiası yapılamaz.
5. **Gerçek cihaz E2E hâlâ yapılmadı** — LID/PN, gelen/giden mesaj, durum güncellemeleri.
6. **1412 sohbetsiz kişi** — rehber semantiği gereği meşru kabul edildi, ayrıca doğrulanmadı.

**L adımı TAMAMLANDI (commit `8cd4223`, doğrulandı):**
`purge_whatsapp_data` ve `purge_empty_ghost_conversations` artık `stage_data_event` /
`record_data_event` ile denetim yazıyor; `EVENT_SESSION_PURGED` sabiti eklendi. `migrations.py`
`purge_empty_ghost_conversations` dönüş tipi `int`'e çevrildi (silinen satır sayısı).

**Doğrulama (tekrar, tam backend suite, `-p no:randomly`):**
- `8cd4223` (zamanaşımı bayrağı OLMADAN): `1673 passed, 4 skipped, 0 failed, 0 error`, **exit 0**, 174.70 s.
- `a46eb0e` baseline (aynı komut): `1673 passed, 4 skipped, 0 failed, 0 error`, 182.80 s.
- **İki çalıştırma birebir aynı** → `8cd4223` ne takılma (hang) ne de regresyon getiriyor.
- Not: daha önceki "77%'de takılma" izlenimi, `--timeout=30` tanılama bayrağının mock kaynaklı
  ~30 s'lik bekleme döngüsünü (ve canlı-gateway kurulumunu) yarıda kesmesinden kaynaklanıyordu;
  bayraksız tam çalıştırmada takılma YOK.

**Deploy durumu:** `--no-gateway` muhafizi `a46eb0e..8cd4223` için **TEMİZ** (gateway/compose
değişmedi). Kalan tek eylem: `8cd4223`'yi üretim konakta `--no-gateway` ile deploy etmek.
**Uyarı:** bu oturumun sandbox'ında `docker` yok; deploy betiği canlı konakta (`docker` erişimi olan
ortamda) çalıştırılmalı. Komut:
`bash scripts/deploy/host-release.sh 8cd4223 --no-gateway` (öncelikle `--dry-run` ile).

Ardından, ayrı ve onay gerektiren adım: ayrı yetkili test hesabıyla gerçek cihaz E2E (kriter 8).
