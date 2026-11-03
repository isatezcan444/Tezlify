# AŞAMA 4.8 — Production Baseline Reconciliation & Controlled Release Preparation

**Tarih:** 2026-10-31
**Mod:** PRE-DEPLOY AUDIT + RELEASE READINESS
**Sonuç:** **READY WITH CONDITIONS** (commit/push/deploy YAPILMADI — §12 duruş koşulu korundu)

> Bu aşamada hiçbir commit, push, deploy, container restart/recreate, production DB yazımı,
> environment değişikliği veya QR/session/auth müdahalesi yapılmadı. Production üzerinde
> yalnızca `SELECT`, dosya hash'i, Git metadata ve `/health`–`/metrics` GET çağrıları kullanıldı.
> Persistence loop **kapalı** ve kapalı olduğu **ölçüldü**.

---

## A. Gerçek production deployed commit

Prompt'ta verilen `b5715fe90d0ff05ef497dcccbc87652efa10ccd1` değeri **doğru değil**. Kayıtlı değer
otomatik kabul edilmedi; hem `.deployed-commit` hem release kayıtları hem de **çalışan container'ın
dosya içerikleri** okundu.

| Kaynak | Değer |
| --- | --- |
| `/opt/tezlify/.deployed-commit` | **`cbe4f509f4bcc5babb12cc85e0ad422cb13ba739`** (41 bayt, `od -c` ile teyit) |
| Release kaydı `backups/releases/20261029T214629Z/release.json` | `sha = cbe4f509…`, `released_at = 2026-10-29T21:48:07Z` |
| Release başlığı | `release: backend-only 3.8.7 (whatsapp-gateway frozen at 38fe087)` |
| Canlı backend imajı | `sha256:06ce4fe12874…` = `release.json.live_backend_image` ✔ |
| Canlı gateway imajı | `sha256:a1ba2572c409…` = `release.json.live_gateway_image` ✔ |
| Host checkout HEAD | `5cd3eae` — **`origin/main`'in atası DEĞİL** (host-yerel commit) |
| Yerel HEAD = `origin/main` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` |

**Sürüm zinciri (ölçülen — *commit* zamanları UTC):** `b5715fe` (2026-10-27T22:13Z) → `38fe087`
(2026-10-29T16:52Z) → **`cbe4f509`** (2026-10-29T21:36Z). Release *kayıt* zamanı commit'ten birkaç dakika
sonradır (`cbe4f509` için `released_at = 21:48:07Z`); ikisini karıştırmamak için burada commit zamanı verildi.

**Container durumu (salt okunur):**

| Container | ID | StartedAt | Restarts |
| --- | --- | --- | --- |
| tezlify-backend | `ce2e901b6619` | 2026-10-29T21:47:56Z | 0 |
| tezlify-gateway | `5b867095d376` | 2026-10-27T17:25:57Z | 0 |
| tezlify-db | `f6d79c4a1f8b` | 2026-10-01T17:45:08Z | 0 |
| tezlify-caddy | `ee66a5cab371` | 2026-10-12T13:12:45Z | 0 |

**Oturum:** `201 | CONNECTED | is_active=t | is_phone_online=t | "Hat 1"`.

### Bulgu A-1 — Host checkout `origin/main`'den ayrışmış
`5cd3eae` (`chore(gitignore): .env.production ekle`) yalnızca production konakta var ve
`origin/main`'in atası değil. Bu, deploy betiğinin `git fetch` + `git cat-file` akışını bozmuyor
(hedef SHA fetch ile geliyor) ama "host = main" varsayımını geçersiz kılıyor. **Risk düşük, ama
her deploy'da `.deployed-commit` ile birlikte host HEAD da kaydedilmeli.**

---

## B. Gateway / backend blob karşılaştırması

Yalnızca Git commit'i karşılaştırılmadı: **çalışan container'daki dosyaların `sha256`'sı** alındı ve
aday commit'lerin blob içerikleriyle birebir eşleştirildi.

### Backend (container yolu `/app/backend/app/…`)

| Dosya | Container | `cbe4f509` | `7afb540` | Worktree (4.7) |
| --- | --- | --- | --- | --- |
| `memory_persistence.py` | `6a1e5860` | `6a1e5860` ✔ | `6a1e5860` | `070fda03` |
| `orchestration/sync.py` | `026cb479` | `026cb479` ✔ | `026cb479` | `edb7e9d2` |
| `whatsapp_gateway.py` | `5bd6ed48` | `5bd6ed48` ✔ | `5bd6ed48` | `2e78ab7d` |
| `main.py` | `1eb78ae6` | `1eb78ae6` ✔ | `1eb78ae6` | `afdacc40` |

⇒ **Çalışan backend, `cbe4f509`'un kendisidir** (4/4 dosya). `38fe087` elenir: `main.py` orada
`49e5287b`'dir.

### Gateway (container yolu `/app/src/…`)

| Dosya | Container | `b5715fe` | `38fe087` | `cbe4f509` | `7afb540` | Worktree |
| --- | --- | --- | --- | --- | --- | --- |
| `messages/message-store.js` | `8648f728` | ✔ | ✔ | ✔ | `5b8df316` | `1d4533c8` |
| `socket/socket-events.js` | `9430f82a` | ✔ | ✔ | ✔ | `b713d6c8` | `973181a9` |
| `session-manager.js` | `c42355ec` | ✔ | ✔ | ✔ | `d0432f76` | `1732f8ff` |
| `index.js` | `4f2e435e` | ✔ | ✔ | ✔ | `79ce231a` | `1e96691e` |

⇒ Gateway **`b5715fe` döneminde donmuş** ve üç release boyunca hiç değişmemiş (imaj `a1ba2572c409`
üç release.json'da da aynı). `7afb540`'ta gateway dosyaları farklı — yani **main'de dağıtılmamış
gateway değişiklikleri var**.

### `memory_persistence.py` production commit'inde var mı?

**Var.** Dosya `bafe5b0`'da (`2026-10-28 16:23 +03:00`) eklenmiş; `b5715fe` (`2026-10-28 01:13 +03:00`) ondan
**önce** olduğu için yol orada **gerçekten yok** — kusur değil, sıralama. `cbe4f509` `bafe5b0`'ı içerir, yani
**canlıda var** ve çalışan container'daki sha256 ile birebir aynı (`6a1e5860`).

| Sorgu | Sonuç |
| --- | --- |
| `git cat-file -e b5715fe:<yol>` | **başarısız** — path absent |
| `git cat-file -e 38fe087:<yol>` / `cbe4f509` / `7afb540` | başarılı, hepsi aynı blob `794e4481` (24 767 bayt) |
| `git cat-file -e bafe5b0:<yol>` | başarılı, ilk blob `f848d120` |
| `git merge-base --is-ancestor bafe5b0 b5715fe` | **false** (b5715fe daha eski) |
| `git merge-base --is-ancestor bafe5b0 cbe4f509` | **true** |
| `git merge-base --is-ancestor cbe4f509 7afb540` | **false** — release dalı ayrı (`release/backend-only-3.8.7`) |

> **Ölçüm yöntemi düzeltmesi.** Bu bölümün ilk hâli yokluğu `git show b5715fe:<yol> | shasum -a 256` ile
> `e3b0c442…` olarak okuyordu. `e3b0c442` **boş string'in** sha256'sıdır; `git show` hata verdiğinde stderr'e
> yazıp stdout'a hiçbir şey basmadığı için boru hattı "0 baytlık dosya" üretir. Yokluk için doğru araç
> `git cat-file -e`'dir (yukarıdaki tablo). Sonuç değişmedi, ama kanıt zinciri artık doğru.

> **Handoff §9/§10'daki "deployed `b5715fe`, `memory_persistence.py` ABSENT" uyarısı artık geçersiz.**
> Modül `cbe4f509` ile zaten dağıtıldı. 4.7 bu modülün **ilk dağıtımı değil, güncellemesidir**;
> ek bağımlılık kurulumu gerekmiyor. Bağımlılık yüzeyi: `sqlalchemy`, `backend.app.core.{auth,config,
> database}`, `models.*`, `whatsapp_gateway`, `repositories.messages`, `orchestration.sync` —
> hepsi zaten imajda.

### Bulgu B-1 — Canlı gateway `/health` yeni sözleşmeyi taşımıyor (ölçüldü)
```
gateway /health anahtarları: status, service, database, pool, sessions, orphaned_sessions,
                             orphaned_detail, auto_restore, live_session_ids
capacity: null            <- 4.7'nin eklediği alan YOK
/messages/bulk yanıtı:    pagination = YOK(eski gateway)
```
Bu, §4'ün "eski gateway uyumluluğu" maddesinin **teorik değil, dağıtımın gerçek kombinasyonu**
olduğunu kanıtlar: backend-only dağıtımda yeni backend **eski** gateway ile konuşacak.

---

## C. 4.7 pagination contract doğrulaması

İki taraflı, **gerçek kod** üzerinde:

### Gateway tarafı — `whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs` (YENİ, 8 kontrol)
`createSessionManager()` ile **gerçek** `session-manager.js` yüklenir (taklit değil):

| # | Kontrol | Sonuç |
| --- | --- | --- |
| A | `afterSeq` verilince `pagination:'seq'`, `seq_epoch`, `next_after_seq`, `after_seq`, `epoch_reset`, `reached_end` döner | PASS |
| B | İkinci sayfa imlecin **kesinlikle sonrasından** devam eder | PASS |
| C | `afterSeq` verilmezse **eski offset şekli aynen** korunur (`pagination:'offset'`, seq alanları yok) | PASS |
| D | `_seq` değerleri benzersiz ve kesin artan | PASS |
| E | **Front-trim:** offset ATLAR, seq ATLAMAZ | PASS |
| F | Epoch uyuşmazlığı imleci 0'a çeker, tüm kayıtları yeniden tarar | PASS |
| G | Bozuk `afterSeq` seq moduna girmez, güvenli biçimde offset'e düşer | PASS |
| H | `/messages/bulk` rotası `afterSeq`/`seqEpoch`'u iletir | PASS |

### Backend tarafı — `backend/tests/test_whatsapp_pagination_contract.py` (YENİ, 9 test)
Eski ve yeni gateway'in **literal yanıt biçimleri** sabit olarak kodlandı ve aynı tüketiciden
(`drain_gateway_memory_once`) geçirildi:

| Test | Ne kanıtlıyor | Sonuç |
| --- | --- | --- |
| `test_new_gateway_seq_response_is_parsed_and_cursor_advances_by_value` | seq yanıtı parse edilir, imleç **değer** olarak ilerler | PASS |
| `test_legacy_gateway_without_pagination_falls_back_to_offset` | `pagination` yoksa offset'e düşer, **hata vermez** | PASS |
| `test_offset_fallback_preserves_the_starting_cursor` | düşerken imleç **sıfırlanmaz** (offset 4'ten başlar) | PASS |
| `test_epoch_change_triggers_a_safe_rescan_and_is_counted` | epoch değişimi güvenli yeniden tarama + sayaç | PASS |
| `test_front_trim_skips_messages_in_offset_mode` | offset modu T3,T4'ü **atlar** (eski hata) | PASS |
| `test_front_trim_does_not_skip_messages_in_seq_mode` | seq modu hiçbir kaydı atlamaz | PASS |
| `test_stalled_seq_cursor_is_reported_instead_of_looping_forever` | `PaginationStalled`, 1 çağrıda durur | PASS |
| `test_missing_next_after_seq_is_a_contract_error` | `MissingNextAfterSeq` | PASS |
| `test_health_payload_never_leaks_a_gateway_uuid` | §3 güvenlik: UUID sızmaz | **önce RED, düzeltmeden sonra PASS** |

### Front-trim kanıtı (asıl sayı)
Aynı 6 mesaj, `page_size=3`, ilk turdan sonra **en eski 2 mesaj RAM'den atılıyor**:

- **offset:** 1. tur `[T0,T1,T2]`; trim sonrası `offset=3` → `[T2,T3,T4,T5][3:] = [T5]` ⇒ DB: `T0,T1,T2,T5` — **T3 ve T4 sessizce kayıp**
- **seq:** 1. tur `[Q0,Q1,Q2]`, `after_seq=3`; trim sonrası `seq>3` → `[Q3,Q4,Q5]` ⇒ DB: `Q0…Q5` — **kayıp yok**

---

## D. Eski gateway / eski backend uyumluluğu

| # | Soru | Cevap | Kanıt |
| --- | --- | --- | --- |
| 1 | Gateway yeni sözleşmeyi döndürüyor mu? | **Evet (4.7 koduyla)** | Gateway testleri A–H |
| 2 | Backend yeni sözleşmeyi doğru parse ediyor mu? | **Evet** | `…seq_response_is_parsed…` |
| 3 | **Eski gateway ile yeni backend** çalışır mı? | **Evet** | `…legacy_gateway_without_pagination_falls_back…` + canlı `pagination=YOK` ölçümü |
| 4 | Offset fallback imleci sıfırlıyor mu? | **Hayır** — `start_offset` korunur | `…preserves_the_starting_cursor` |
| 5 | Epoch değişince güvenli yeniden tarama? | **Evet**, `after=0` + sayaç | `…safe_rescan…` + gateway F |
| 6 | Front-trim pagination sırasında mesaj atlatıyor mu? | **Offset'te evet, seq'te hayır** | C bölümü sayıları |
| 7 | Gateway restart sonrası epoch değişimi algılanıyor mu? | **Evet**, `epoch_reset:true` | gateway F + backend testi |

**Yeni gateway + eski backend:** eski backend `afterSeq` göndermediği için gateway offset dalında
kalır ve `pagination:'offset'` döner. Eski backend fazladan anahtarı yok sayar; davranış değişmez.
**Geriye dönük uyum iki yönde de kanıtlı.**

---

## E. Güncellenmiş tz44 / tz46 testleri

6 test eski davranışı kodluyordu; yeni sözleşmeye uyarlandı. **Hiçbir test silinmedi veya
etkisizleştirilmedi**; her biri için tehdit modeli korundu, yalnızca *sonuç* güncellendi.

| Test (dosya) | Eski beklenti | Yeni beklenti | Neden değişti | Yeni kanıt |
| --- | --- | --- | --- | --- |
| `t1_client_message_id_collision_aborts_the_whole_page` → `…isolates_the_poison_row` (tz44) | `error`=`IntegrityError`, `inserted=0`, DB=0 | `error` yok, `inserted=1`, `dead_letter=1`, DB=1 | 4.7 bulk INSERT'i SAVEPOINT'e aldı; ikinci unique index artık sayfayı öldürmüyor | `ids_of == ["WA-C1"]` |
| `t1b_collision_stalls_the_cursor_and_retries_forever` → `…no_longer_stalls_the_cursor` (tz44) | `pages=2`, imleç 2'de park, kuyruk (`NEVER`) ulaşılamaz | `pages=3`, `inserted=4`, `dead_letter=1`, `next_offset=0`, kuyruk **yazıldı** | Sayfa commit edildiği için imleç ilerliyor; kilitlenme ortadan kalktı | `ids_of == [NEVER,OK-1,OK-2,POISON-A]` |
| `t1c_collision_against_an_existing_row` (tz44) | `error`=`IntegrityError`, DB=1 | `error` yok, `dead_letter=1`, `inserted=0`, DB=1 | İzolasyon sayfa düzeyinden satır düzeyine indi | `ids_of == ["SEED"]` |
| `t2_page_rollback_then_clean_rerun_writes_everything` → `…partial_page_commits_and_rerun_is_idempotent` (tz44) | İlk tur `error`, DB=0; sonra 3 yazılır | İlk tur `inserted=4`, `dead_letter=1`, DB=4; tekrar `inserted=0` | Sayfa düzeyinde rollback yok; kısmi commit + idempotency var | `ids_of == [G0,G1,G2,P1]` |
| `a2_same_client_id_with_new_wa_id_is_not_absorbed` (tz46) | `pytest.raises(IntegrityError)`, çağıran `__cause__.constraint_name` okur | **fırlatmaz**, `[]` döner, `dead_letter=1`, `constraint` adı dolu | İzolasyon helper'ın **içine** taşındı | `ids_of == ["W-1"]` |
| `a4_row_level_savepoint_isolates_the_poison_row` (tz46) | Çağıran kendi `begin_nested()` döngüsünü kurar, `dead` testte sayılır | Çağıran yalnız `dead_letter` sink'i geçer; 4 yazılır, 1 ölür | Aynı dans artık `_insert_messages_resilient` içinde | `len(written)==4`, `dead["count"]==1`, `POISON` yok |

**Sonuç:** `tz44 4 failed / 4 passed` + `tz46 2 failed / 8 passed` → **18 passed / 0 failed**.

> Bu dosyalar `/tmp`'de yaşıyordu (yeniden başlatmada kaybolur). Release kapısı olabilmeleri için
> `scripts/pg_audit_tests/` altına **kalıcı** kopyalandı (commit edilmedi, §12).
> Çalıştırma:
> ```
> env -u TEST_DB_PATH DATABASE_URL="postgresql+asyncpg://tezlify@127.0.0.1:55434/tezlify_test_47" \
>   PYTHONPATH=scripts/pg_audit_tests:. ./venv/bin/python -m pytest scripts/pg_audit_tests \
>   -p tz44_pgplugin -q -o asyncio_default_fixture_loop_scope=session \
>   -o asyncio_default_test_loop_scope=session
> ```

---

## F. 4.7 test sonuçları

Her koşum **yeni provision edilmiş** DB ile yapıldı (`scripts/provision_test_db.py`).

| Kapı | Komut | Sonuç |
| --- | --- | --- |
| Backend sabit sıra | `pytest backend/tests -p no:randomly` | **2174 passed, 4 skipped** (EXIT 0) |
| Backend seed `424242` | `--randomly-seed=424242` | **2174 passed, 4 skipped** |
| Backend seed `777` | `--randomly-seed=777` | **2174 passed, 4 skipped** |
| Backend seed `900913` | `--randomly-seed=900913` | **2174 passed, 4 skipped** |
| 4.7 yetkili (izole PG17) | `tz47_fixes + memory_persistence + _hardening` | **36 passed** |
| PG audit (tz44+tz46) | `scripts/pg_audit_tests` | **18 passed** |
| Gateway | `npm test` | **EXIT 0**, 61 PASS satırı, **0 FAIL**; yeni seq testi paket içinde koştu |
| Frontend build | `npm run build` | **EXIT 0**, `✓ built in 18.08s` |
| i18n | `verify:i18n-keys` | **EXIT 0** — 2466 çağrı, `en=3250 tr=3250` |
| older-page-lock | `verify:older-page-lock` | **EXIT 0**, 9 kontrol |
| older-page-state | `verify:older-page-state` | **EXIT 0**, 6 kontrol |
| message-timeout-budget | `verify:message-timeout-budget` | **EXIT 0**, 3 kontrol |
| Backend import sanity | 5 modül | **OK** |
| Gateway syntax | `node --check` ×5 | **OK** |
| `git diff --check` | — | **temiz** |
| Secret taraması | 4.7 kapsamı + yeni dosyalar | **eşleşme yok** |

**Test DB production'ı reddediyor (kanıtlandı):** `DATABASE_URL=postgresql+asyncpg://…@130.162.247.20:5432/tezlify`
ile koşum `ERROR at setup` → `RuntimeError` (`assert_test_db_is_not_remote`), **bağlantı kurulmadan**;
EXIT=1.

### Bu aşamada bulunan ve düzeltilen 2 kusur

1. **`/health` ve `/metrics` gateway UUID'si sızdırıyordu** (§3'ün açık şartı).
   `memory_persistence_status()` `dict(_STATE)` kopyalıyor ve yalnızca `cursors`'u çıkarıyordu;
   `last_error_page_key = "<gateway_uuid>:<mode>:<cursor>"` yayında kalıyordu. Kimlik doğrulaması
   istemeyen iki uçtan altyapı kimliği sızıyordu. **Düzeltme:** alan snapshot'tan çıkarıldı;
   teşhis `consecutive_page_errors` (kaç tur) + `last_error` (tür/SQLSTATE) ile korunuyor.
   *Önce RED, sonra PASS.*

2. **`_integrity_constraint_name` kısıt ADI yerine SQLSTATE döndürüyordu.**
   SQLAlchemy'nin asyncpg sarmalayıcısı gerçek istisnayı `orig.__cause__`'da tutar; `orig.diag`
   boştur. Sonuç: `/health`'te `dead_letter_last_constraint=23505` — alan "constraint" diye
   adlandırıldığı için sessizce yanlış teşhis. **Düzeltme:** adaylar `orig → orig.__cause__ →
   exc.__cause__` sırasıyla denenir; ad yoksa SQLSTATE döner (eski davranış korunur).

**4.7 delta (düzeltmeler dahil):** 9 üretim dosyası, **+790 / −78**.

---

## G. `contacts.py:101` kök neden değerlendirmesi

**Dosya:** `backend/app/services/whatsapp/repositories/contacts.py:101` — `attrs = dict(contact.custom_attributes or {})`.

| Soru | Cevap | Kanıt |
| --- | --- | --- |
| Kök neden? | `dict()` bir **str** veya **list** üzerinde `ValueError: dictionary update sequence element #0 has length N; 2 is required` atar. `custom_attributes` beklenen şekilde dict/None değilse fonksiyon patlar. | `dict`, `None`, `{}` → OK; `'{"name_source":"push"}'` → **ValueError**; `["name_source"]` → **ValueError** |
| Production verisinden mi? | **HAYIR.** 1538 contact: `object`=1534, JSON `null`=2, SQL `NULL`=2, **str=0, array=0** | `jsonb_typeof(custom_attributes)` dağılımı (salt okunur) |
| 4.7'den bağımsız mı? | **Evet.** Dosya worktree'de **değişmemiş** ve deployed `cbe4f509` ile **bayt-bayt aynı** (`197fb868…`) | `git diff --quiet` + hash karşılaştırması |
| 33 test hatası tekrar üretiyor mu? | **Hayır.** Mevcut ağaçta tam backend paketi **2174 passed** — 33 hata görülmedi | F bölümü |
| Ayrı düzeltme gerekir mi? | **Evet, ama ayrı kapsamda.** Savunmacı normalizasyon önerilir (dict kabul; JSON str → `json.loads`; liste/çöp → `{}`), **kendi test dosyasıyla**. | — |

**Öneri (4.7 kapsamına SOKULMADI):** `contacts.py` içine `_as_dict(value)` yardımcısı +
`backend/tests/test_contacts_custom_attributes_robustness.py`. Gerekçe: üretimde tetiklenmiyor ama
tek bir bozuk satır `set_contact_name` üzerinden **tüm isim güncelleme yolunu** düşürür. Bu, ayrı
bir değişiklik olarak 4.9'da ele alınmalı.

---

## H. Escrow worktree koruma raporu

Worktree'de **iki ayrı kapsam** var ve **kesişimleri YOK** (programatik olarak doğrulandı).

### 3.9.19 escrow kapsamı — DOKUNULMADI (15 dosya)

| Dosya | Durum |
| --- | --- |
| `backend/app/api/v1/endpoints/escrow.py` | yeni |
| `backend/app/schemas/escrow.py` | yeni |
| `backend/app/services/admin/escrow_service.py` | yeni |
| `backend/tests/test_admin_escrow_api.py` | yeni |
| `frontend/src/pages/admin/AdminEscrowPage.tsx` | yeni |
| `backend/app/api/v1/api.py` | modified `+7` |
| `backend/app/auth/api/dependencies.py` | modified `+38` |
| `backend/app/auth/infrastructure/google_provider.py` | modified `+9 −2` |
| `backend/app/core/config.py` | modified `+81` |
| `frontend/src/App.tsx` | modified `+9` |
| `frontend/src/api/admin.ts` | modified `+70` |
| `frontend/src/components/Layout/Sidebar.tsx` | modified `+2` |
| `frontend/src/locales/en.ts` | modified `+49` |
| `frontend/src/locales/tr.ts` | modified `+49` |
| `frontend/src/types/admin.ts` | modified `+48` |

### 4.7 kapsamı — bu aşamada dokunulan (12 dosya)
`whatsapp-gateway/src/{messages/message-store.js, socket/socket-events.js, session-manager.js, index.js}`,
`whatsapp-gateway/package.json`, `backend/app/services/whatsapp/memory_persistence.py`,
`backend/app/services/whatsapp/orchestration/sync.py`, `backend/app/services/whatsapp_gateway.py`,
`backend/app/main.py`, `backend/tests/test_whatsapp_memory_persistence{,_hardening}.py`,
`backend/tests/test_whatsapp_pagination_contract.py` (yeni).

**Yeni, 4.7'ye ait ama henüz commit edilmemiş yardımcılar:** `whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs`,
`scripts/pg_audit_tests/*`.

### Yapılmayanlar (kurala uyuldu)
`git reset --hard` yok · `git clean` yok · `git checkout .` yok · `git stash` yok · tüm worktree'yi
tek commit altında toplama yok. Escrow dosyaları **okunmadı ve değiştirilmedi** (yalnızca
`git diff --numstat` ile sayıldı).

**Not:** Frontend build escrow değişiklikleri worktree'de **dururken** geçti (`BUILD_EXIT=0`) — yani
escrow kodu derlemeyi bozmuyor. Yine de 4.7 ile **aynı commit'e girmemeli**.

---

## I. Deployment sırası

4.7 hem backend hem gateway dosyalarına dokunuyor ⇒ **`--no-gateway` doğrudan kullanılamaz**
(`host-release.sh` `whatsapp-gateway/` farkı görüp exit 1 verir). Bu bir engel değil, muhafızın
istediği ref'in üretilmesi gerekiyor.

### Aşama 1 — Backend-only (loop KAPALI)

```bash
# 1) 4.9'da 4.7 commit'lendikten ve push edildikten SONRA:
python scripts/deploy/backend_only_release.py \
    --base "$(cat .deployed-commit)" \
    --target release/backend-only-3.8.8 \
    --backend-from origin/main
# exit 0 = ref muhafızdan geçecek; 1 = ihlal (gateway'e dokunuyor)

# 2) Hedefin KENDİ betiğini çalıştır (eski betik tuzağı):
git show <ref>:scripts/deploy/host-release.sh > /tmp/hr.sh
bash scripts/deploy/run_release.sh --expected-self-blob <blob> <ref> --no-gateway
```

- **Gateway container ID/StartedAt değişmemeli.** Betik bunu ayrıca doğrular
  (`--no-gateway` verildi ama gateway imajı değişti → `die`).
- Persistence flag: betik adacık env'inde flag'i **siler, `false` yazar, doğrular**
  (`persistence_flag_guard.py --require-explicit-false`), ayrıca `docker run -e …=false` geçer.
  Cutover sonrası `/health` → `config_enabled` okunur; `false` değilse **`die`**.
- **Beklenen kazanç:** yok. Yeni backend eski gateway ile konuşur → **offset fallback**.
  Kazanç yok ama regresyon da yok (D bölümü). Bu bilinçli bir "güvenli ilk adım"dır.

### Aşama 2 — Doğrulama (deploy'suz)
`/health` `config_enabled=false`, `task_running=false`; `messages` sayımı; `candidate-data-drop.txt`
**yok**; gateway container ID aynı; oturum `201 CONNECTED`.

### Aşama 3 — Gateway (AYRI ONAY, seq pagination'ı aktifleştirir)
Yalnızca şu iki koşul birlikte sağlanınca:
1. **RAM-only mesaj sayısı 0** (aşağıdaki ölçüm tekrarlanır), ve
2. persistence loop'un bir turu tamamlanmış (ayrı onay) **veya** RAM ⊆ DB ölçümü hâlâ geçerli.

> **Neden bu koşul:** gateway recreate RAM store'ını kaybettirir (A6). Sıra **daima** backend
> persistence → doğrulama → gateway'dir.

### Servisler arası geçici uyumsuzluk
| Kombinasyon | Sonuç |
| --- | --- |
| Yeni backend + eski gateway | **Güvenli** — offset fallback (kanıtlı) |
| Eski backend + yeni gateway | **Güvenli** — `afterSeq` gönderilmez, offset dalı; fazladan anahtar yok sayılır |
| Yeni backend + yeni gateway | seq pagination aktif (hedef) |

⇒ Aşama 1 ile Aşama 3 arasındaki pencere **veri kaybı üretmez**; yalnızca seq kazancı ertelenir.

---

## J. Rollback planı

### Mevcut mekanizma (varsayımsal değil, koddan)
- Her release cutover'dan **önce** mevcut imajları etiketler: `tezlify-backend:pre-<TS>`,
  `tezlify-gateway:pre-<TS>`; `release.json.rollback_tags`'e yazar.
- `host-release.sh --rollback-to <TS>`: iki etiketi `latest`e bağlar, frontend yedeğini geri yazar,
  `docker compose up -d backend gateway`.
- Cutover sonrası hata → `on_error()` otomatik `rollback()` çağırır ve `.deployed-commit`'i
  `deployed-commit.before`'dan geri yükler. Doğrulama geçtikten sonra (`VERIFIED=1`) **geri almaz**.

### Bu release için somut plan

| Alan | Değer |
| --- | --- |
| Önceki deployed commit | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| Önceki backend imajı | `sha256:06ce4fe12874d9e694e03e2f53e74f6d95fef5e3339b4dfde7c8554ec9ddb21a` |
| Önceki gateway imajı | `sha256:a1ba2572c40926fd3d71289b6e7eb20116915efc9024c7487631f24324eaa1cc` (değişmemeli) |
| Önceki dosya hash'leri | B bölümündeki tablo (backend 4 dosya) |
| Geri dönüş komutu | `bash scripts/deploy/host-release.sh --rollback-to <YENI_TS>` |
| Health doğrulaması | `/health` 200 + `whatsapp_memory_persistence.config_enabled=false` + `gateway_bridge.connected=true` |
| Session koruma | Gateway **recreate edilmemeli**; `docker inspect` ile `StartedAt` aynı kalmalı |

### **Bulgu J-1 — `--rollback-to` gateway'i de ayağa kaldırıyor**
Betik `docker compose up -d backend gateway` çalıştırıyor. **Bugün ölçülen durumda bu güvenli:**
`tezlify-gateway:pre-20261029T214629Z` ve `pre-20261029T183544Z` **ikisi de** canlı gateway imajıyla
aynı (`a1ba2572c409`) ⇒ yeniden etiketleme **no-op**, compose recreate etmez.

**Ama bu bir tesadüf değil, ölçüm:** gateway'in değiştiği bir release'ten sonra `--rollback-to`
gateway'i **eski imaja** çevirir ve RAM store'ı kaybeder. Backend-only bir release'in geri dönüşü
için daha güvenli biçim:

```bash
docker tag tezlify-backend:pre-<TS> tezlify-backend:latest
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate backend
```
(Bu, gateway'e hiç dokunmaz. Betiğe eklenmesi 4.9'da ayrı bir iyileştirme olarak önerilir.)

---

## K. Açık riskler

| # | Risk | Ağırlık | Durum / azaltma |
| --- | --- | --- | --- |
| K1 | **Host checkout `origin/main`'den ayrışmış** (`5cd3eae` host-yerel) | Düşük | Hedef SHA fetch ile geliyor; ama her deploy'da host HEAD kaydedilmeli |
| K2 | **Persistence loop hiç çalışmadı** (`runs=0`) ⇒ 4.7'nin düzelttiği hataların *faydası* henüz devrede değil | Orta | Loop açmak ayrı onay gerektiriyor; bu aşamada **kapalı kalmalı** |
| K3 | **`reached_end` kısa-sayfa sezgisidir** — toplam `page_size`'ın tam katıysa bir **fazla boş istek** gerekir | Çok düşük | Backend boş sayfada `reached_end` sayar; doğruluk etkilenmez, yalnızca 1 istek |
| K4 | **`memory_persistence` LID takma adı sorgusu `session_id = gateway_id`** kullanıyor (A14 şekli) ⇒ yeniden bağlanma sonrası LID anahtarlı mesajlar `skipped_unmapped` olur | Orta | **Fail-safe** (atlar, yanlış sohbete yazmaz). Kalıcılık tamlığı düşer; ayrı iş olarak ele alınmalı |
| K5 | **Gateway recreate RAM store'ını kaybettirir** | **Bugün 0** | Ölçüldü: RAM 9163, DB 9196, **RAM-only = 0**. Her gateway deploy'undan hemen önce **tekrarlanmalı** |
| K6 | `--rollback-to` gateway'i de recreate eder (J-1) | Orta | Backend-only geri dönüşte `--no-deps backend` kullanılmalı |
| K7 | `contacts.py:101` savunmasız (G) | Düşük | Üretimde tetiklenmiyor; ayrı düzeltme önerildi |
| K8 | Escrow değişiklikleri worktree'de; 4.7 ile karışma riski | Orta | Kesişim **yok** (H); ayrı commit zorunlu |
| K9 | Gerçek cihaz E2E yapılmadı | — | **BLOCKED** — yetkili test hesabı yok |

---

## L. Release readiness verdict

# READY WITH CONDITIONS

**Gerekçe (ölçülen):** Tüm kapılar yeşil — backend 4 koşumda 2174 passed (sabit sıra + 3 seed),
4.7 yetkili 36 passed, PG audit 18 passed, gateway EXIT 0, frontend build + 4 doğrulama EXIT 0,
import/syntax temiz, secret yok, test DB production'ı reddediyor. Sözleşme iki yönde kanıtlı ve
eski gateway uyumluluğu **canlı** olarak (`pagination=YOK`) teyit edildi.

**Koşullar:**

1. **4.7 tek başına commit edilmeli; escrow ayrı commit.** Kesişim yok (H), ama aynı commit'e
   girmemeli. Yeni dosyalar: `test_whatsapp_pagination_contract.py`, `test-bulk-seq-pagination.mjs`,
   `scripts/pg_audit_tests/`, `whatsapp-gateway/package.json` (test script satırı).
2. **`release/backend-only-*` ref'i kesilmeli** — 4.7 gateway dosyalarına dokunduğu için
   `--no-gateway` doğrudan reddeder. Preflight `backend_only_release.py` exit 0 vermeli.
3. **Gateway dağıtımı ayrı onay** ve öncesinde **RAM-only = 0** ölçümünün tekrarı (K5).
4. **Persistence loop kapalı kalmalı** — bu aşamada açmak yasak; açma ayrı aşama.
5. **Gerçek cihaz E2E BLOCKED** olarak kalır; PASS sayılmadı.

**NOT READY değil** çünkü: sözleşme, uyumluluk ve veri bütünlüğü kanıtlı; RAM-only kayıp 0;
hiçbir kapı kırmızı değil.
**READY değil** çünkü: commit/push/deploy bu aşamada yasak, release ref'i henüz kesilmedi,
ve gateway adımı için RAM ölçümünün deploy anında tekrarı gerekiyor.

---

## Duruş

- Commit: **yok**
- Push: **yok**
- Deploy: **yok**
- Container restart/recreate: **yok** (gateway `5b867095d376` @ 2026-10-27T17:25:57Z değişmedi)
- Production DB write: **yok** (yalnız `SELECT`)
- Environment değişikliği: **yok**
- QR/session/auth müdahalesi: **yok**
- Encryption key okuma/yazdırma: **yok**
- Persistence loop: **kapalı** (`config_enabled=False`, `task_running=False`, `runs=0`)

AŞAMA 4.9'a kendiliğinden geçilmedi.
