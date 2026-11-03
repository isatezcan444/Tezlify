# AŞAMA 4.10 — BACKEND-ONLY RELEASE DALI HAZIRLIĞI VE SON PREFLIGHT

**Tarih:** 2026-10-31 (Europe/Istanbul)
**Kapsam:** `release/backend-only-4.7` dalının kesilmesi, 4.7 kapsamının izolasyonu, K-7 LID
yeniden analizi, L-C1 kapsam kararı, tam preflight, guard çalıştırmaları, rollback'in yalnızca
inceleme yoluyla doğrulanması.
**Yetki durumu:** `NOT AUTHORIZED — NO COMMIT / NO PUSH / NO DEPLOY`

---

## A. Kapsam, kısıtlar ve bu aşamada YAPILMAYANLAR

| Kısıt | Durum |
| --- | --- |
| `git commit` | **YAPILMADI** (release dalı 4.10 başında zaten kesilmişti; bu aşamada yeni commit yok) |
| `git push` | **YAPILMADI** |
| Deploy / `run_release.sh` | **ÇALIŞTIRILMADI** — yalnızca guard'ın ÜRETTİĞİ komut metni raporlandı |
| Container restart/recreate | **YAPILMADI** |
| Üretim DB INSERT/UPDATE/DELETE | **YAPILMADI** — yalnızca `SELECT` |
| `--rollback-to` | **ÇALIŞTIRILMADI** — rollback yalnızca betik okumasıyla doğrulandı |
| Kullanıcının çalışma ağacı | **DEĞİŞTİRİLMEDİ** (HEAD `7afb540`, 20 değişik dosya aynen duruyor) |

İzole çalışma ağacı: `/tmp/tz410-release` (kullanıcının ağacı değil).

---

## B. Ölçülen başlangıç durumu (kabul edilen varsayım değil, ölçüm)

| Öğe | Değer | Kaynak |
| --- | --- | --- |
| Yayındaki commit | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` | `/opt/tezlify/.deployed-commit` |
| Release etiketi | `backend-only 3.8.7`, `released_at 2026-10-29T21:48:07Z` | `backups/releases/<TS>/release.json` |
| Dal | `release/backend-only-3.8.7` — **`main`'in atası DEĞİL** | `git merge-base --is-ancestor` |
| Yerel HEAD = `origin/main` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` | `git rev-parse` |
| Host `/opt/tezlify` HEAD | `5cd3eae` (host'a özel commit, yerel repoda yok) | host `git rev-parse` |
| Gateway dondurulmuş nokta | `b5715fe`, imaj `a1ba2572`, container `5b867095d376` | `docker inspect` |

**Neden önemli:** release commit'leri ayrı backend-only dallarında kesildiği için "`main`'de yok"
normaldir. Karşılaştırma **dosya blob'ları** üzerinden yapılır, soy ağacı üzerinden değil.

---

## C. Release dalının kesilmesi ve manifest

```
dal      : release/backend-only-4.7
commit   : 17ccbc91843490f7c256b1324e22d11e0a02ac3f
parent   : cbe4f509f4bcc5babb12cc85e0ad422cb13ba739
subject  : release: backend-only 4.7 (memory persistence core safety fix)
yazar    : release-preflight <release-preflight@local>  Sat Oct 31 11:13:59 2026 +0300
ağaç     : /tmp/tz410-release (izole worktree)
```

`git diff --shortstat cbe4f509 17ccbc9` → **10 dosya, +1785 / −61**. Gateway altında değişen
dosya: **0**.

| Blob (SHA1, 12) | Dosya | +/− |
| --- | --- | --- |
| `bbd99ca0b283` | `backend/app/main.py` | +2 / −0 |
| `e12c030bd239` | `backend/app/services/whatsapp/memory_persistence.py` | +196 / −45 |
| `213f736e976f` | `backend/app/services/whatsapp/orchestration/sync.py` | +133 / −11 |
| `2f44be2058c2` | `backend/app/services/whatsapp_gateway.py` | +11 / −0 |
| `db60486e05f3` | `backend/tests/test_whatsapp_memory_persistence.py` | +1 / −1 |
| `4b6314a3f762` | `backend/tests/test_whatsapp_memory_persistence_hardening.py` | +4 / −4 |
| `bab8dec13bde` | `backend/tests/test_whatsapp_pagination_contract.py` | +545 / −0 |
| `2848509a18a8` | `scripts/pg_audit_tests/test_tz44_missing.py` | +415 / −0 |
| `29e189c3bf47` | `scripts/pg_audit_tests/test_tz46_audit.py` | +440 / −0 |
| `e1dccfeeb3bf` | `scripts/pg_audit_tests/tz44_pgplugin.py` | +38 / −0 |

Dağılım: **7 backend dosyası + 3 audit betiği**, 0 gateway, 0 frontend, 0 escrow, 0 docs,
0 `.workbuddy-ai/memory`.

> Hash disiplini: bu tablodaki değerler **blob-SHA1**'dir (`git rev-parse <c>:<path>`).
> 4.8 raporundaki `shasum -a 256` değerleri **içerik-SHA256**'dır ve bu tabloyla
> karşılaştırılamaz. Dosya kopyalama anında 10/10 dosyanın SHA256'sı kaynakla birebir
> eşleşmişti; burada yayın kimliği için SHA1 kullanılıyor.

---

## D. Gateway byte-identity (yayın tabanına karşı)

`git hash-object <dosya>` (çalışma ağacı) ↔ `git rev-parse cbe4f509:<dosya>`:

| Dosya | Sonuç |
| --- | --- |
| `whatsapp-gateway/package.json` | IDENTICAL |
| `whatsapp-gateway/src/index.js` | IDENTICAL |
| `whatsapp-gateway/Dockerfile` | IDENTICAL |
| `whatsapp-gateway/package-lock.json` | IDENTICAL |
| `whatsapp-gateway/README.md` | IDENTICAL |

**5/5 birebir.** `git diff cbe4f509 17ccbc9 -- whatsapp-gateway/` → boş.

> Ölçüm sırasında bir tuzak gerçekten ateşlendi: `npm install` (test bağımlılıkları için)
> `whatsapp-gateway/package-lock.json`'u **yeniden yazdı** ve ağacı kirletti. `git checkout --`
> ile geri alındı, ardından 5/5 kontrolü **tekrar** koşuldu. Bu satır olmasa guard
> `gateway/compose : 1 dosya degismis` verip exit 1 ile reddedecekti — yani hata sessiz değil,
> ama gerçekti.

---

## E. K-7 — LID anahtarlaması yeniden analizi (salt okuma)

### E.1 İddia ve ölçüm

`_load_conversation_index`, `whatsapp_private.lid_mappings`'i `WHERE session_id = :sid` ile ve
`str(gateway_id)` parametresiyle sorguluyor (`memory_persistence.py:260-268`). K-7'nin sorusu:
tablodaki `session_id` **integer `whatsapp_sessions.id`** mi, yoksa **gateway UUID** mi?

**Cevap: gateway UUID.** Üç bağımsız kanıt:

1. **DDL** (`migrations.py:2142-2151`):
   `session_id TEXT NOT NULL REFERENCES whatsapp_private.gateway_sessions(session_id) ON DELETE CASCADE`,
   `PRIMARY KEY (session_id, lid_jid)` — FK hedefi `gateway_sessions.session_id`, yani TEXT UUID.
2. **Repository sözleşmesi** (`repositories/lid_mappings.py:1-30`): "*`session_id` is the
   **gateway** session UUID (TEXT) — not the integer `public.whatsapp_sessions.id`*" ve
   tenant çözüm zinciri `lid_mappings → gateway_sessions → whatsapp_sessions.gateway_id → user_id`.
3. **Canlı ölçüm** (üretim, salt okuma):

   | Ölçüm | Değer |
   | --- | --- |
   | `whatsapp_sessions` satırı | **1** (id `201`, gateway `1bd78836-c084-…`, `CONNECTED`) |
   | `gateway_sessions` satırı | 20 (tarihsel) |
   | `lid_mappings` toplam satır | 4320 |
   | **Aktif oturumun satırı** | **217** |

   Yani sorgu sessizce boş dönmüyor: aktif hat 217 köprü satırına sahip. Anahtar yanlış olsaydı
   bu sayı **0** olurdu.

### E.2 Yanlış sohbete yazma riski

- Sorgu **yalnızca bu gateway oturumunun** satırlarını okur; oturum tek bir kiracıya aittir
  (`whatsapp_sessions.gateway_id` UNIQUE).
- Takma ad, `conv_by_jid` içinde **zaten var olan** bir jid'e bağlanır; `conv_by_jid` ise
  `get_user_filter(Conversation.user_id, user_id)` ile kiracıya filtrelenmiştir. Yani köprü
  **yeni bir sohbet icat edemez**, yalnızca mevcut bir sohbete ikinci bir jid ekleyebilir.
- Üzerine yazma koruması var: `if target is not None and lid_str not in conv_by_jid` — mevcut
  bir jid eşlemesi **asla** başka bir sohbete yönlendirilmez (`memory_persistence.py:270-276`).

### E.3 Artık (rezidüel) riskler — hepsi 4.7 ÖNCESİNDEN var

| Risk | Durum | Üretimde ölçüm |
| --- | --- | --- |
| `conv_by_jid` sözlüğünde son-yazan-kazanır; `conversations (user_id, contact_id, session_id)` üzerinde UNIQUE yok | Yapısal, LID'e özel değil | **`dup_jid = 0`** |
| Eski `session_id IS NULL` sohbetleri her hatta dahil edilir | Kabul edilmiş eski davranış | **`conv_null_session = 0`** |
| `lid_mappings` 20 tarihsel oturum boyunca birikir (4320 satır), yalnızca aktifi okunur | Depolama niteliği | 217 aktif / 4320 toplam |

**K-7 sonucu: kusur YOK.** Anahtarlama doğru, izolasyon fail-closed, üzerine yazma korumalı.
4.7 bu bölgeyi **hiç değiştirmiyor**: `git diff cbe4f509 17ccbc9 -- memory_persistence.py`
hunk'ları satır 99/123/139/293/299/316/332/343/371/403/422/428/496/507/521/538'de; LID bloğu
(207-278) arada ve **dokunulmamış**. Dolayısıyla bu bulgu 4.7'ye kod olarak **eklenmedi**.

### E.4 Yan gözlem (deploy için iyi haber, kayıt için)

Üretimde `jid:218107046027315@lid` anahtarlı **tek** kişi var: id `23776`, 1 sohbet,
**9 mesaj**, `lid_mappings`'te karşılığı **yok**. 3.8.7 sınıflandırıcısı bunu
`bridge_unknown_has_messages` olarak işaretler (`migrations.py:1395-1405`) ve **silmez**,
karantinaya yazar. `whatsapp_identity_quarantine` şu an **boş** — çünkü süpürme yalnızca
**boot'ta** çalışır ve backend 34 saattir ayakta. Yani 4.7 deploy'u bu satırı **silmeyecek**;
bir sonraki açılışta karantinaya alacak. 3.8.7 sözleşmesi canlı bir hayalet üzerinde doğrulandı.

---

## F. L-C1 — kayıp tz47 testlerinin eşlenmesi ve kapsam kararı

4.8'in "36 passed" iddiası **kullanılmadı** (`/tmp/tz47tests` kayboldu, depoda kopyası yok).
Aşağıdaki eşleme yalnızca **depoda duran** testlere dayanıyor.

| # | Davranış | Test | Dosya |
| --- | --- | --- | --- |
| 1 | Keyset (seq) sayfalama, imleç değerle ilerler | `test_new_gateway_seq_response_is_parsed_and_cursor_advances_by_value` | `test_whatsapp_pagination_contract.py` |
| 2 | Front-trim: offset modunda atlar, seq modunda atlamaz | `test_front_trim_skips_messages_in_offset_mode`, `test_front_trim_does_not_skip_messages_in_seq_mode` | aynı |
| 3 | Epoch değişimi → güvenli yeniden tarama | `test_epoch_change_triggers_a_safe_rescan_and_is_counted` | aynı |
| 4 | Legacy offset fallback + başlangıç imlecinin korunması | `test_legacy_gateway_without_pagination_falls_back_to_offset`, `test_offset_fallback_preserves_the_starting_cursor` | aynı |
| 5 | Sayfalama takıldı → sonsuz döngü yok | `test_stalled_seq_cursor_is_reported_instead_of_looping_forever` | aynı |
| 6 | `next_after_seq` eksik → sözleşme hatası | `test_missing_next_after_seq_is_a_contract_error` | aynı |
| 7 | Zehirli satır / SAVEPOINT izolasyonu | **YOKTU** → `test_client_message_id_collision_is_isolated_per_row`, `test_poison_row_leaves_the_outer_transaction_usable` | **YENİ** |
| 8 | Kısıt adı çıkarımı (`orig.__cause__.diag`) | **YOKTU** → 3 test | **YENİ** |
| 9 | `/health` gateway UUID sızdırmaz | `test_health_payload_never_leaks_a_gateway_uuid`, `test_health_status_never_contains_cursor_keys` | pagination + hardening |

### F.1 Ölçülen boşluk

`grep -rn "_insert_messages_one_by_one\|one_by_one" backend/tests/` → **0 sonuç**.
Yani 4.7'nin *çekirdek* güvenlik iddiası — "tek zehirli satır 500 satırlık sayfayı öldürmez" —
hiçbir test tarafından sürülmüyordu. Mutlu yol (`on_conflict_do_nothing`) test ediliyordu, ama
o yolda çakışma **hata atmaz**; hata atan yol (arbiter olmayan `uq_msg_conv_client_message_id`)
tamamen karanlıktı.

### F.2 Kapatma

Yeni dosya: `backend/tests/test_whatsapp_message_insert_isolation.py` — **5 test, 5 passed**.

- `test_client_message_id_collision_is_isolated_per_row` — 3 satır, 1 zehirli → 2 yazılır,
  1 dead-letter, sayfa kaybolmaz.
- `test_poison_row_leaves_the_outer_transaction_usable` — izolasyondan sonra aynı oturumda
  yazma yapılabilir (3.8.7'deki `InFailedSQLTransactionError` sınıfının geri dönmediğinin pini).
- `test_constraint_name_reads_asyncpg_diag_from_the_cause` — `orig.diag` boşken
  `orig.__cause__.diag.constraint_name` okunur.
- `test_constraint_name_prefers_a_direct_diag` — psycopg2 şekli.
- `test_constraint_name_falls_back_to_sqlstate_without_lying` — ad yoksa `23505`, `None` değil.

**Boş test değil:** `dead_letter["count"]` yalnızca `_insert_messages_one_by_one` içinde artar;
`assert dead["count"] == 1` geçtiğine göre satır-satır izolasyon yolu **gerçekten** koştu.
`_integrity_constraint_name`'den `__cause__` yürüyüşü çıkarılsaydı 3. test `23505` döner ve
kırmızı olurdu.

### F.3 Karar

**`COVERAGE_GAP_REQUIRES_TEST`** — boşluk gerçekti, test yazıldı ve yeşil; **ancak commit
edilmedi**. Dosya şu an `/tmp/tz410-release` içinde **untracked**:

```
?? backend/tests/test_whatsapp_message_insert_isolation.py
```

Kalıcı kopya: `scripts/prepared_tests/test_whatsapp_message_insert_isolation.py` (depoda,
pytest tarafından `backend/tests` dışında olduğu için kendiliğinden toplanmaz).
**Neden commit edilmedi:** 4.10 sonunda commit yasak; ayrıca bu dosyayı `17ccbc9`'a eklemek
release manifest'ini 10 → 11 dosyaya çıkarır ve D bölümündeki byte-identity kanıtını
geçersiz kılar. Karar operatöre ait: ya release commit'ine eklenir (yeni commit + guard'ın
tekrar koşulması), ya da ayrı bir `test(...)` commit'i olarak `main`'e gider.

---

## G. Preflight kapıları (izole worktree üzerinde)

| # | Kapı | Sonuç |
| --- | --- | --- |
| 1 | Python derleme (`compileall backend/app backend/tests`) | **EXIT 0** |
| 2 | Import sağlamlığı (`main`, `memory_persistence`, `orchestration.sync`, `whatsapp_gateway`, `core.migrations`) | **5/5 OK** |
| 3 | Hedefli parti (persistence+hardening 25, pagination 9, tz44 8, tz46 10) | **52 passed** (PostgreSQL `tezlify_test_410`) |
| 4 | Backend tam suite (SQLite, taze provision) | **2065 passed, 4 skipped, 1 failed** — exit 1 |
| 5 | Secret taraması (diff, +satırlar) | **0 eşleşme** |
| 6 | PII/log taraması (eklenen `logger.*` satırları) | **0 PII taşıyan satır** |
| 7 | `print()` (üretim kodu) | 0 — yalnızca `scripts/pg_audit_tests/tz44_pgplugin.py` (stderr tanılama) |
| 8 | Release manifest | 10 dosya / +1785−61 / 0 gateway — **doğrulandı** |

### G.1 Tek kırmızı ve neden 4.7'nin suçu değil

```
FAILED backend/tests/test_admin_ops_security.py::test_http_probe_distinguishes_unreachable_from_unhealthy
E  AssertionError: typing.Optional[bool]
   assert ('bool' in 'typing.Optional[bool]' and 'None' in 'typing.Optional[bool]')
```

Bu test, dönüş tipinin **string** gösteriminde `"None"` arıyor. `Optional[bool]`'un gösterimi
`typing.Optional[bool]`'tur ve `"None"` içermez — yani iddia kırılgan, ürün doğru
(`ops_service.py:1162` → `-> Optional[bool]`, gövdede `return None` var; "kontrol edilemedi"
ile "bozuk" ayrımı korunuyor).

**4.7 öncesinden var olduğu kanıtı (iddia değil, ölçüm):**
- `git show cbe4f509:backend/app/services/admin/ops_service.py:1162` → `-> Optional[bool]`
- `git show cbe4f509:backend/tests/test_admin_ops_security.py:331` → aynı `return_annotation` iddiası
- `cbe4f509` üzerinde ayrı worktree'de **çalıştırıldı**: `1 failed` — yani yayındaki tabanda da kırmızı.

Düzeltme (iddianın `Optional[bool]`'u kabul etmesi) **4.7 release'ine konmadı**; ayrı bir
test commit'i işidir.

### G.2 Önceki koşudaki 2 ERROR — ortam, ürün değil

İlk tam koşuda `test_whatsapp_phase2_a_gateway_behavior.py` içinde 2 ERROR:
`ERR_MODULE_NOT_FOUND: Cannot find package 'uuid'`. Neden: worktree'de `node_modules` yok.
`npm ci` **başarısız** oldu (`EUSAGE`) çünkü depo kökü bir npm **workspace** kökü
(`package.json` → `workspaces: [frontend, whatsapp-gateway]`) ve kökte `package-lock.json` yok.
`npm install --workspaces=false` (213 paket) ile çözüldü → **2 passed**.
`node_modules` untracked olduğu için ağaç temiz kaldı; `package-lock.json` yeniden yazıldığı
için **geri alındı** (bkz. D bölümü).

### G.3 Sayıların mutabakatı

| Koşu | Toplanan | Sonuç |
| --- | --- | --- |
| 1. tam koşu (node deps yok) | 2065 | 2058 passed + 1 failed + 2 error + 4 skipped |
| 2. tam koşu (+5 yeni test, node deps var) | **2070** | **2065 passed + 1 failed + 4 skipped** |

2065 + 5 = 2070 ✓. 4.9 raporundaki "2174 passed" bu komutla **yeniden üretilemiyor**: `main`
tabana göre yalnızca 2 test dosyası fazla (`test_escrow_physical.py` 28 + `test_hourly_snapshot.py`
51 = 79) ve 2065 + 79 = 2144 ≠ 2178. Aradaki fark kapanmadığı için **4.9'un bu sayısı burada
referans alınmıyor**; 4.10'un ölçülen değeri yukarıdaki 2070/2065'tir.

---

## H. Guard çalıştırmaları — `scripts/deploy/backend_only_release.py`

### RUN A — `--backend-from origin/main`

```
SONUC: GUVENLI DEGIL — deploy etme.        (exit 1)
gateway/compose : 0 dosya degismis (0 olmali)
backend vs main : 9 dosya farkli (0 olmali)
backend vs base : 7 dosya degismis (>0 olmali)
```

9 farkın ayrıştırması: **7'si kapsam içi** (4.7 backend dosyaları), **2'si `main`'e özel test
dosyası** (`test_escrow_physical.py`, `test_hourly_snapshot.py`). İkisi de `scripts/backup/*`
import ediyor; o dizin `cbe4f509`'da **yok**. Yani bu iki dosya 4.7 kapsamına giremez —
girseydi tabanda var olmayan bir modüle bağlanan testler release'e girerdi.

**Sonuç:** `main`'in backend'i tabandan yalnızca **bu 2 test dosyası** kadar ayrışıyor;
üretim kodu farkı **sıfır**. Bu, "backend-only release `main`'i taşımıyor" uyarısının
4.7 için maddi karşılığı olmadığını gösterir.

### RUN B — `--backend-from release/backend-only-4.7` (kendisi)

```
SONUC: GUVENLI — bu ref `--no-gateway` muhafizindan gececek.   (exit 0)
gateway/compose : 0 dosya degismis
backend vs main : 0 dosya farkli
backend vs base : 7 dosya degismis
host-release.sh : f2b7a9aeb5c4 (hedefteki blob)
run_release.sh  : 9284245fa56c (hedefteki blob)
```

Üretilen (ÇALIŞTIRILMAYAN) komut:

```
bash scripts/deploy/run_release.sh \
  --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
  release/backend-only-4.7 --no-gateway --health-timeout 180
```

**Blob kimliği netleşti:** `--expected-self-blob` = `run_release.sh`'in blob'u
(`9284245fa56c…`). Kill-switch'in karşılaştırdığı `host-release.sh` ise `f2b7a9aeb5c4…` ve bu
değer **tabanda ve hedefte aynı** ⇒ 3.8.5'ten beri süren "exit 9" tuzağı bu release'te
ateşlenmez.

---

## I. Rollback doğrulaması — yalnızca inceleme (çalıştırma yok)

`scripts/deploy/host-release.sh` (hedefteki blob `f2b7a9aeb5c4`, tabanla birebir):

| Satır | Davranış | Sonuç |
| --- | --- | --- |
| `83-99` | `--rollback-to <TS>`: `tezlify-backend:pre-$REL` ve `tezlify-gateway:pre-$REL` → `latest`, sonra `docker compose up -d backend gateway` | **Gateway'i YENİDEN OLUŞTURUR ⇒ RAM deposu kaybı (A6)** |
| `739-741` | `docker tag "$PREV_BACKEND_IMAGE" tezlify-backend:pre-$TS` + gateway etiketi — build'den **önce**, koşulsuz | `--no-gateway` altında bile **iki etiket de** oluşur ⇒ backend-only geri dönüş mümkün |
| `551-570` | `--no-gateway` muhafızı: `.deployed-commit` gerekir; `git diff --quiet $PREV_DEPLOYED $TARGET -- whatsapp-gateway/ <compose>` boş olmalı | `cbe4f509..17ccbc9` için gateway farkı **0** ⇒ muhafız geçer |
| `548` | Betik sürüm muhafızı: `SELF_BLOB` = hedefteki blob | `f2b7a9ae` = `f2b7a9ae` ⇒ geçer |

**Backend-only geri dönüş (RAM'i koruyan yol — bu aşamada ÇALIŞTIRILMADI):**

```
docker tag tezlify-backend:pre-<TS> tezlify-backend:latest
docker compose up -d --no-deps backend
```

`--no-deps` gateway'e dokunmaz; `--rollback-to` ise **dokunur**. Bu ayrım, geri dönüş
prosedürünün yazılı olması gereken tek satırıdır.

---

## J. Açık koşullar (deploy'u bloke etmez, ama yazılı olmalı)

1. **L-C1 testi commit edilmedi.** `test_whatsapp_message_insert_isolation.py` yeşil ama
   untracked. Release'e girecekse manifest 10 → 11 dosya olur ve guard yeniden koşmalıdır.
2. **`test_admin_ops_security.py` iddiası kırık** — 4.7 öncesinden, tabanda da kırmızı.
   Ürün doğru, test kırılgan. Ayrı commit.
3. **P0-1 (front-trim skip) backend-only ile KAPANMAZ.** Yayındaki gateway rotası
   (`index.js:563`) yalnızca `{limit, offset, since, perChatLimit, jids}` okuyor; `afterSeq`
   **hiç okunmuyor** ve `listAllMessages` `pagination` anahtarı döndürmüyor. Yeni backend
   `""` görüp offset moduna düşüyor (imleç sıfırlanmadan). Sessiz-güvenli, ama **düzeltilmiş
   değil**.
4. **§6 RAM kapısı bu aşamada YENİDEN ÖLÇÜLMEDİ.** 4.9'daki `RAM_ONLY = 0` ölçümü
   **deploy anına taşınamaz**: o günden beri mesaj sayısı 9206 → **9208** oldu. Kapı, deploy
   sabahı yeniden koşmalıdır (`RAM_ONLY = 0` + snapshot/DB/kimlik kontrolleri).
5. **`lid_mappings` 20 tarihsel oturum boyunca birikiyor** (4320 satır, yalnızca 217'si aktif).
   İşlevsel etkisi yok; budama ayrı bir iş.

---

## K. VERDICT

### Release paketi: **READY WITH CONDITIONS**

- Dal `release/backend-only-4.7` = `17ccbc9`, taban `cbe4f509`, **10 dosya / +1785−61**.
- Gateway **5/5 byte-identical**; frontend, escrow, docs, memory **tamamen dışarıda**.
- `origin/main`'in gateway sapması (`b5f7605`, `9754143`, `0d909ab`) release'e **taşınmadı**.
- Guard RUN B **exit 0**; `--no-gateway` muhafızı ve betik sürüm muhafızı geçiyor.
- Tam suite: **2065 passed / 4 skipped / 1 pre-existing failure**; hedefli parti **52 passed**.
- K-7: **kusur yok** (DDL + sözleşme + canlı 217 satır). L-C1: boşluk gerçekti, **kapatıldı
  ama commit edilmedi**.

### Üretim deploy'u: **NOT AUTHORIZED — NO COMMIT / NO PUSH / NO DEPLOY**

Bu aşamada commit, push, deploy, container restart/recreate ve üretim DB yazımı yapılmadı.
Deploy, kullanıcının açık onayına ve §J.4'teki RAM kapısının deploy anında yeniden
ölçülmesine bağlıdır.
