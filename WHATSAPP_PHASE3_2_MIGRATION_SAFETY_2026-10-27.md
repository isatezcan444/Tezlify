# TEZLIFY WHATSAPP — AŞAMA 3.2 RAPORU

**Migration güvenliği ve veri bütünlüğü**

Tarih: 2026-10-27 · Kapanış commit'i: `978c1fe` · Yayındaki commit: `978c1fe`

> Bu rapordaki her sayı, süre, container kimliği ve commit gerçek komut çıktısından alınmıştır.
> Gözlemlenmeyen hiçbir sonuç başarı olarak yazılmadı; yapılamayan her şey "yapılmadı" olarak
> ve nedeniyle birlikte yazıldı.

---

## 1. Değişen dosyalar ve commit

| Ölçüm | Değer |
|---|---|
| Başlangıç HEAD | `623e1c6` (= `origin/main`) |
| Başlangıç worktree | 2 değişik + 3 yeni dosya (hepsi bu görevin); ilgisiz bir taslak (`WHATSAPP_AUDIT_PHASE3_2026-10-27.md`) **dokunulmadan bırakıldı** |
| Yayındaki commit (başlangıç) | `9a77206` |
| Kapanış HEAD | `978c1fe` (= `origin/main`, push edildi) |
| Yayındaki commit (kapanış) | `978c1fe` |

| Commit | Kapsam |
|---|---|
| `2cd63e8` | `fix(whatsapp): audit table hazir olmadan denetlenen adim kosmasin` |
| `978c1fe` | `feat(deploy): yikici migration'i HICBIR container kalkmadan durdur` |

| Dosya | Ne değişti |
|---|---|
| `backend/app/main.py` | `_ensure_audit_table_ready()` eklendi; `_record_ghost_purge_audit()` artık `bool` döner; `lifespan` sırası düzeltildi; `/health` `table_status` + `table_ready` yayınlar |
| `backend/tests/conftest.py` | `assert_test_db_is_not_remote()` — test paketi uzak bir veritabanına **bağlanmayı reddeder** |
| `scripts/deploy/host-release.sh` | `--allow-migrations` bayrağı, statik yıkıcı-migration kapısı, adacık log kurtarma, sayım/şema ölçümü, `release.json` `migrations` bloğu |
| `scripts/deploy/migration_guard.py` | **yeni** — veritabanı bağımlılığı olmayan yıkıcı-SQL tarayıcısı |
| `backend/tests/test_audit_table_startup_order.py` | **yeni** — 6 test |
| `backend/tests/test_deploy_migration_guard.py` | **yeni** — 17 test |
| `backend/tests/test_test_db_isolation_guard.py` | **yeni** — 7 test |

---

## 2. Aday (candidate) / migration akışı — önce ve sonra

### 2.1 Sorulan altı sorunun cevabı (kod kanıtıyla)

**(1) Aday container neden üretim veritabanına bağlanıp migration çalıştırıyor?**
Çünkü ortamı **canlı container'dan** kopyalanıyor (`docker inspect tezlify-backend --format
'{{range .Config.Env}}…'`), yani `DATABASE_URL` üretim PostgreSQL'ini (`db:5432/tezlify`) gösteriyor.
`backend/app/main.py`'nin `lifespan`'ı ise migration setini **koşulsuz** çalıştırıyor. Bu bilinçli bir
duman testi: "yeni imaj gerçek şemayla ayağa kalkıyor mu?". Bedeli şu: setin içindeki yıkıcı
fonksiyonlar cutover'dan **önce** üretim verisine dokunuyor.

**(2) Migration'lar cutover'dan önce mi çalışıyor?**
Evet. Sıra: normalize → build → **adacık boot (migration'lar burada)** → `/health` → cutover.
Yani "cutover'ı durduralım" kararı, yıkıcı bir migration fark edildiğinde **çok geç** verilmiş olur.
Bu yüzden tek etkili kapı, container hiç kalkmadan önce konan **statik** kapıdır (bkz. 2.2).

**(3) Başarısız aday logları neden kayboluyordu?**
Her iki dalda da (sağlıklı / sağlıksız) `docker rm -f "$CANDIDATE_NAME"` çağrılıyordu ve bu komut
container'ın json-file log dizinini de siliyor. Diske yazılan tek şey konsola basılan `--tail N`
satırlarıydı. 2026-10-27'de bir sohbet tam bu pencerede kayboldu ve "kim sildi" sorusu
**kanıtla birlikte** silindi.

**(4) Hangi migration'lar tablo/kolon/indeks/satır silebilir?**
`backend/app/core/migrations.py` içinde:

| Konum | Ne yapıyor | Sınıf |
|---|---|---|
| `purge_raw_jid_identity_data` (~1350) | ham JID kimlikli satırları siler | satır |
| `purge_degenerate_phone_contacts` (~1503) | dejenere telefon rehber kayıtlarını siler | satır |
| `ensure_contacts_unique_phone` (~1733/1736) | birleştirme dalında **fazla contact'ı siler** | satır |
| `purge_empty_ghost_conversations` (~2028) | mesajsız/zaman damgasız sohbetleri siler | satır |
| `ensure_verified_commercial_leads` (2540–2566) | doğrulanmamış lead'leri siler | satır |
| `purge_synthetic_preview_messages` (2608) | önizlemeden üretilmiş mesajları siler | satır |
| `ensure_messages_sender_phone_nullable` (322–324) | `DROP TABLE messages` + yeniden kurma | **tablo** |
| `ensure_conversations_columns` (423) | yinelenen `DELETE FROM conversations` | satır |
| `ensure_merchant_scoped_lead_uniqueness` (2667) | indeks düşürür | indeks (veri kaybı değil) |

**(5) Bir migration başarısız olursa canlı backend ve DB hangi durumda kalır?**
İki farklı davranış var ve fark kritik:
- `purge_*` fonksiyonları istisnayı **içeride yutar**, yalnızca `logger.warning` yazar
  (`purge_empty_ghost_conversations`, satır 2041–2042). Yani başarısız bir temizlik **adayı sağlıklı
  gösterir** ve cutover devam eder. Hata yalnızca logda görünür — bu yüzden logun saklanması şart.
- `ensure_*` çağrılarının çoğu `lifespan`'da doğrudan `await` edilir; ikisi (`ensure_messages_media_columns`,
  `ensure_messages_wa_message_id_unique`) açıkça `RuntimeError` atar. Bunlardan biri patlarsa adacık
  `/health` vermez, `die` çalışır, **cutover olmaz** ve canlı backend eski kodla çalışmaya devam eder.
  DB ise geri alınmaz: her migration kendi `engine.begin()` bloğunda atomiktir, ama **setin tamamı
  atomik değildir** — yani şema, eski koddan bir adım ileride kalabilir.

**(6) Deploy öncesi/sonrası şema nasıl doğrulanır?**
Önce doğrulanamıyordu. Artık: `information_schema.columns` + `pg_indexes` envanteri
(`schema-before.txt` / `schema-after.txt`), sha256 parmak izi ve fark varsa `schema.diff`.
Parmak izi satır **sayısı** değil **yapı** ölçer: migration'ın eklediği/düşürdüğü her şey görünür,
veri değişimi görünmez.

### 2.2 Uygulanan en küçük güvenli düzeltme

Öncelik sırasına göre: *migration'ı cutover'dan bağımsız, denetlenebilir bir adım yap* → **yapılamadı**
(nedeni §8'de). Uygulanabilen ilk madde, container hiç kalkmadan çalışan **statik kapı** oldu:

```
0.  .deployed-commit okunur (artık --no-gateway dalının dışında: iki muhafız da kullanıyor)
0.  --no-gateway muhafızı            (değişmedi)
0.  YIKICI MIGRATION MUHAFIZI         <-- YENİ: migration_guard.py diff
      exit 0 -> "clean" / exit 3 -> die "… --allow-migrations verin"
      exit 3 durumunda exit kodu KORUNUR (ölçüldü: 3)
0.  --dry-run çıkışı                 (kapı dry-run'da da değerlendirilir)
0b. db sayım + şema parmak izi       <-- YENİ: ilk container kalkmadan
1.  normalize
2.  build
3.  adacık boot -> /health
3.  adacık logu `docker rm -f` ÖNCE diske <-- YENİ
3b. sayım karşılaştırması; düştüyse cutover YOK <-- YENİ
4.  cutover
4b. sayım + şema karşılaştırması; otomatik "onarım" YOK <-- YENİ
```

`migration_guard.py` sınıflandırması:
- `DELETE FROM` / `TRUNCATE` / `DROP TABLE` / `DROP COLUMN` → **engeller** (onay ister)
- `UPDATE … SET` → yalnızca **raporlanır** (her açılışta koşan idempotent `backfill_*` onarımları)
- `DROP INDEX` → kapsam dışı (veri kaybı değil)
- Yalnızca **eklenen** satırlar taranır: kaldırılan bir `DELETE` yıkıcılığı azaltır, engellenmez.

**Bootstrap ayrıntısı (kendi ilk sürümümdeki hatayı bulup düzelttim):** muhafız betiği ilk kez
dağıtıldığında konakta henüz **yoktur** (ağaç hâlâ önceki commit'te, `git reset --hard` ise daha
ileride). Çalışma ağacından çağırmak ilk deploy'u "muhafız çalıştırılamadı" diye reddederdi. Bu yüzden
betik **hedef commit'ten** okunuyor (`git show "$TARGET_FULL:scripts/deploy/migration_guard.py"`),
bulunamazsa çalışma ağacına, o da yoksa `skipped_no_guard` durumuna düşüyor (release.json'a yazılır).

---

## 3. Audit tablosu açılış sırası ve yeni testler

**Kusur:** `ensure_whatsapp_data_audit_table` çağrısı `purge_empty_ghost_conversations`'tan **sonra**
geliyordu. Taze bir kurulumda ilk temizliğin denetim satırı "tablo yok" hatasıyla düşerdi; hata
yutulduğu için sistem "denetim çalışıyor" görünürdü. Üstelik `failed == 0`, tablo hiç oluşmamışken de
sıfırdır — yani sağlık göstergesi olarak yetersizdi.

**Düzeltme (canlı boot logunda doğrulandı):**

```
[TEZLIFY_BOOT] Starting initialization on port 8001...
...
line 14: [MIGRATION][AUDIT] whatsapp_data_audit hazir (status=ALREADY_PRESENT)
```

- `_ensure_audit_table_ready(engine)`: tabloyu denetlenen ilk adımdan önce hazırlar, durumu modül
  globalinde tutar, `BLOCKED`/`ERROR`'u **ERROR** seviyesinde loglar. Açılışı düşürmez (denetim satırı
  kaybetmek, API'yi ayağa kaldırmamaktan küçük bir kayıptır) — ama artık sessiz de değil.
- `_record_ghost_purge_audit` artık `bool` döner: tablo hazır değilse "bu silme kayıt altına
  alınamadı" der; istisnayı yutar ama **başarı saymaz**.
- `/health.whatsapp_data_audit` `table_status` + `table_ready` yayınlar. Canlı:
  `{"written":0,"staged":0,"duplicate_skipped":0,"failed":0,"table_status":"ALREADY_PRESENT","table_ready":true}`

**Yeni testler** (`test_audit_table_startup_order.py`, 6 test):

| Test | Neyi pinliyor |
|---|---|
| `test_audit_table_is_ensured_before_the_ghost_purge` | `lifespan` gövdesini AST ile ayrıştırır, `_ensure_audit_table_ready` çağrısının purge'ten **önce** geldiğini doğrular |
| `test_fresh_database_gets_the_table_before_anything_writes` | temiz DB'de tablo + `idempotency_key` + `uq_wa_data_audit_idempotency_key` |
| `test_existing_table_is_idempotent_and_keeps_its_rows` | ikinci açılış `ALREADY_PRESENT`, eski satır **korunur** |
| `test_blocked_table_is_not_reported_as_success` | `BLOCKED` → ERROR logu + `table_ready=false` + hiçbir satır silinmez |
| `test_health_reports_table_ready_after_a_successful_bootstrap` | `failed==0` tek başına yetmez |
| `test_ghost_purge_audit_reports_failure_instead_of_raising` | yazılamazsa `False`, açılış düşmez; `0` silmede `True` ve satır yazılmaz |

**Yanlışlanabilirlik kanıtı:** çağrı purge'ten sonraya taşındığında test kırmızı oldu
(`AssertionError: assert 2623 < 2573`), geri alındığında yeşil.

**Ek olarak (istenmemiş ama gerekli görüldü):** `conftest.run_db_migrations` autouse ve **session**
kapsamlı; `settings.DATABASE_URL` neyi gösteriyorsa ona migration uyguluyor. Kabukta kalmış bir
`DATABASE_URL=postgresql+asyncpg://…@üretim/…` ile `pytest` çalıştırmak **sessizce üretim şemasına
migration uygulardı**. Artık `assert_test_db_is_not_remote()` bunu reddediyor; kaçış yolu tek ve açık
(`TEZLIFY_TEST_DB_REMOTE_OK=1`). Yerelde `DATABASE_URL` `sqlite+aiosqlite:///./tezlify.db` olduğu için
davranış değişmiyor.

---

## 4. Test sonuçları

Yetkili kapı (`scripts/provision_test_db.py` ile şema-only DB, `DATABASE_URL=/tmp/tezlify_clean.db`):

| Koşu | Komut | Sonuç |
|---|---|---|
| Doğal sıra | `pytest backend/tests -q -p no:randomly` | **1707 passed, 4 skipped**, `PYTEST_EXIT=0` |
| Rastgele sıra | `pytest backend/tests -q` (`pytest-randomly`) | **1707 passed, 4 skipped**, `PYTEST_RANDOM_EXIT=0` |

**Fark ve açıklaması:** önceki taban `1677 passed, 4 skipped`. Fark **+30 test**, tamamı bu görevde
eklendi: 6 (audit sırası) + 17 (migration muhafızı) + 7 (DB izolasyonu). Kaybolan veya yeni kırılan
test yok; `4 skipped` değişmedi.

**Üretim DB'sine bağlanmadığının kanıtı (üç ayrı ölçüm):**
1. Etkin URL `sqlite+aiosqlite:///./tezlify.db` — host bileşeni yok.
2. Muhafız, **gerçek üretim DSN'i** ile çalıştırıldığında daha bağlantı kurulmadan reddetti:
   `RuntimeError: … host='130.162.247.20'`.
3. `test_guard_has_no_database_dependency` — `migration_guard.py` içinde `sqlalchemy`/`asyncpg`/
   `aiosqlite`/`psycopg`/`DATABASE_URL` referansı **yok**.

**Not (ortam tuzağı, ürün hatası değil):** ilk tam koşu `114 errors` verdi — hepsi fixture setup'ta
`PermissionError: EEXIST … mkdir '…/pytest-of-root'`. Sebep `tmp_path` fabrikasının sandbox `mkdir`
sarmalayıcısıyla çakışması; `--basetemp` veya `rm -rf "$TMPDIR"pytest-of-*` ile kayboldu. Kırmızıyı
"değişikliğim her şeyi bozdu" diye okumadım, kök nedeni ölçtüm.

**Gateway ve frontend:** bu değişikliklerde `whatsapp-gateway/` veya `frontend/` **değişmedi**
(`--no-gateway` muhafızı da bunu doğruladı), bu yüzden gateway testleri ve frontend build'i
çalıştırılmadı; gateway container'ı yeniden oluşturulmadı.

---

## 5. Üretim dağıtımı yapıldı mı

**Evet.** Dry-run sonra gerçek dağıtım.

| Adım | Sonuç |
|---|---|
| Konakta `git fetch` | `FETCH_EXIT=0`, hedef `978c1fe9ba479bbea46f8c324d7b4a21968f87cf` |
| Betiğin konaktaki kopyası | `e9d0f3c77058ed78447a2d3383ec55aa605c1f0c25176b0d8a13a137f4c57f11` — yerel ile **birebir aynı** |
| `--dry-run` | `DRY_RUN_EXIT=0`; gateway muhafızı **GEÇTİ**, migration muhafızı **GEÇTİ**, cutover servisleri `backend` |
| Gerçek dağıtım | `RELEASE_EXIT=0`, 94 s |
| Yeni backend imajı | `sha256:67906f5f71601574f3fc12524ca153c5e53c4be0a24a203cf002f910d140df5e` |
| Cutover doğrulaması | `backend=sha256:67906` / `gateway=DEGISMEDI (sha256:a1ba2)` |
| Yayındaki commit | `978c1fe9ba479bbea46f8c324d7b4a21968f87cf` (= HEAD, ağaç temiz) |

**Kapının gerçekten engellediğinin kanıtı (yanlışlama, canlı sistemde):**

| Senaryo | Beklenen | Ölçülen |
|---|---|---|
| Muhafız, bilinen yıkıcı geçmiş aralıkta (`407e8e4..3d50c1d`) | exit 3 | `HISTORICAL_DESTRUCTIVE_EXIT=3`, bulgu: `[delete] backend/app/core/migrations.py: "DELETE FROM conversations "` |
| Bu sürümün aralığı (`9a77206..978c1fe`) | exit 0 | `THIS_RELEASE_EXIT=0` — "yıkıcı SQL eklemiyor" |
| Betik kablolaması: muhafız exit 3, onay **yok** | durmalı, container kalkmamalı | `WIRE_EXIT_NO_APPROVAL=3`, "trafik HENUZ çevrilmedi; canlı sistem etkilenmedi", 4 container kimliği değişmedi |
| Aynı senaryo + `--allow-migrations` | devam | `WIRE_EXIT_WITH_APPROVAL=0` |

**Dağıtılan kodun incelenen kod olduğunun kanıtı:** `host-release.sh`'in `verify_blob` listesi sabit
ve `main.py`'yi kapsamıyor. Kendim hash'ledim: canlı
`/app/backend/app/main.py` = `18b26a9f32560c3b4ea24b4671882a57531a30620dfd4456c1fc81cb4b65fd7d`,
`git show 978c1fe:backend/app/main.py` ile **birebir aynı**.

---

## 6. Gateway ve WhatsApp oturumunun korunması

| Ölçüm | Önce | Sonra |
|---|---|---|
| Gateway container kimliği | `5b867095d376…` | **`5b867095d376…` (aynı)** |
| Gateway `StartedAt` | `2026-10-27T17:25:57.8181699Z` | **aynı** |
| Gateway `RestartCount` | 0 | **0** |
| Gateway imajı | `sha256:a1ba2572…` | **aynı** (`DOKUNULMADI`) |
| Gateway `/health` oturumları | total 1 / connected 1 / pending_qr 0 | **total 1 / connected 1 / pending_qr 0** |
| `auto_restore` | `true` | `true` |
| `whatsapp_sessions` satırı | `200 \| CONNECTED \| +905413749073` | **aynı satır, `updated_at` 19:52:13 değişmedi** |
| `db` / `caddy` container | `f6d79c4a1f8b` / `ee66a5cab371` | **aynı** |

Yalnızca backend container'ı yeniden oluşturuldu (`969a0c8f1774`, `20:24:01`). QR/pairing/auth
dizinine dokunulmadı; hiçbir oturum sıfırlanmadı, hiçbir hat yeniden eşleştirilmedi.

`gateway_bridge.last_connected_at` `20:24:05`'e kaydı — bu, **backend**'in gateway'e WebSocket
köprüsünü yeniden kurmasıdır (backend restart'ının zorunlu sonucu), WhatsApp oturumunun yeniden
kurulması değil. Gateway `StartedAt`'i değişmediği için hat hiç düşmedi.

---

## 7. Veri bütünlüğü bulguları

Salt okunur. Hiçbir kayıt silinmedi, düzeltilmedi, "onarılmadı".

**Zaman damgası:** `2026-10-27T20:25:08Z` · **Yayındaki commit:** `978c1fe`

| Sayım | Değer |
|---|---|
| conversations | 123 |
| messages | 1099 |
| contacts | 1535 |
| whatsapp_sessions | 1 |
| whatsapp_data_audit | 1 |

| Tutarlılık kontrolü | Sonuç |
|---|---|
| `orphan_messages` (conversation'ı olmayan mesaj) | **0** |
| `dup_wa_message_id` (`conversation_id, wa_message_id` yinelenen) | **0** |
| `conv_contact_missing` | **0** |
| `conv_session_missing` | **0** |
| `conv_null_user` / `msg_null_user` / `contact_null_user` | **0 / 0 / 0** |
| `dup_contact_phone` (`user_id, phone_e164`) | **0** |
| `dup_conv_key` (`user_id, lead_id, channel`) | **0** |
| `whatsapp_data_audit` `failed` | **0** |

Tek denetim satırı: `id=1, event=count_snapshot, source=sweep, outcome=observed,
reason=data_shape_changed, created_at=2026-10-27 17:26:55` — bu bir **gözlem** satırı, hata değil.
`ghost_purge` satırı **yok**, çünkü silinecek satır yoktu (`deleted=0` → satır yazılmaz; bu tasarım
gereği, `purge_empty_ghost_conversations` yalnızca `deleted > 0` iken loglar).

**Migration penceresi ölçümü (bu, 2026-10-27'de cevaplanamayan sorunun doğrudan cevabı):**

| Aşama | conversations \| messages \| contacts |
|---|---|---|
| Adacık kalkmadan önce | `123\|1096\|1535` |
| Adacık öldükten hemen sonra | `123\|1096\|1535` |
| Cutover sonrası | `123\|1096\|1535` |

Düşüş yok, `dropped_during_candidate=false`, `dropped_during_cutover=false`. Şema parmak izi
`82e6003b1b9f → 82e6003b1b9f`, `schema_changed=false`. Adacık logunda **24** migration satırı var ve
`candidate.log` içinde tek bir `WARNING`/`ERROR`/`Traceback` yok.

20:25'teki `1099`, cutover'dan sonra gelen **organik** mesajlardır (1096 → 1099); migration
penceresinde üretilmedi. Beklenmeyen hiçbir fark yok, bu yüzden hiçbir otomatik onarım tetiklenmedi.

---

## 8. Çözülemeyen riskler ve nedenleri

| Risk | Durum | Neden değiştirilmedi |
|---|---|---|
| **Adacık hâlâ üretim DB'sine karşı migration çalıştırıyor** | Açık | İzole bir test DB'sine taşımak, migration setinin *gerçek* şemaya karşı koştuğu duman testini ortadan kaldırırdı. Bu bir mimari karar; tek başıma "aday artık şu DB'ye bağlansın" demek, ilk çalıştırmada üretimden farklı bir şema yüzünden yanlış yeşil üretebilirdi. Yerine **telafi edici** üç muhafız kondu (statik kapı, sayım karşılaştırması, log/şema kaydı). |
| **Migration'lar cutover'dan bağımsız, denetlenebilir bir adım değil** | Açık | `lifespan`'ı iki faza ayırmak (şema hazırlığı / trafik açılışı) uygulama başlangıç sözleşmesini değiştirir: `start.py` + `lifespan` + testlerin tamamı bu sıraya bağlı. Bu, "en küçük güvenli düzeltme" sınırının dışında. |
| **Muhafız hedef commit'te yoksa kapı `skipped_no_guard`'a düşer** | Kabul edildi | Eski bir commit'e rollback'i imkânsız kılmamak için. Durum `release.json`'a yazılır ve logda UYARI olarak görünür — sessiz değil. |
| **`--dry-run` `git fetch` çalıştırmıyor** | Bilinen | `run()` yardımcısı yalnızca komutu yazar. Henüz fetch edilmemiş bir SHA dry-run'da "hedef SHA bu checkout'ta yok" ile düşer. Bu turda fetch elle yapıldı. |
| **`verify_blob` listesi sabit (2 dosya + gateway)** | Bilinen | Bu turda `main.py` ayrıca hash'lendi. Listeyi genişletmek ayrı bir iş. |
| **`whatsapp_data_audit` tablosunda tek satır var, `failed` sayacı 0** | Bilgi | `failed==0` artık `table_ready=true` ile birlikte okunmalı; asıl güvence bu. |

---

## 9. Sonraki adım

1. **Şema hazırlığını trafik açılışından ayır** — `lifespan`'ı iki faza böl (migration aşaması +
   serving aşaması) ve migration aşamasını `SKIP_MIGRATIONS=1` ile atlanabilir yap; adacık bunu
   kullanıp yalnızca boot testi yapsın. En yüksek değerli tek değişiklik bu.
2. **Adacık için izole şema** — üretim DB'sinde ayrı bir `search_path`/şema veya anlık şema kopyası;
   duman testinin değerini kaybetmeden veriyi korur.
3. `verify_blob` listesini deploy'un dokunduğu dosyalardan **türet**, sabit liste yerine.
4. `--dry-run` içinde `git fetch`'i gerçekten çalıştır (ya da dry-run'da fetch'i zorunlu kıl).
