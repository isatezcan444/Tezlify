# AŞAMA 6.2 — SESSION-SCOPED LID RECONCILIATION

**P0-2: LID Eşleştirmesinin WhatsApp Oturumuna Kapsamlanması**

| Alan | Değer |
|---|---|
| Kapsam | P0-2: boot ve sweep LID birleştirmelerinin `session_id=None` ile farklı hatları karıştırması |
| Çalışma dizini | `/private/tmp/tz429-release` |
| İşlem türü | Mevcut WhatsApp kimlik eşleştirme davranışının dar kapsamlı düzeltilmesi |
| Rapor tarihi | 2026-11-03 |
| Sonuç | **PASS_WITH_NOTES** |

---

## 1. Başlangıç ve Bitiş Git / Worktree Durumu

### 1.1 Başlangıç

| Alan | Değer |
|---|---|
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Değişmiş tracked dosya | 17 |
| Untracked giriş | 22 (`reports/` dahil) |
| `git status --porcelain` | 39 satır |
| `git diff --stat` | 17 dosya, +2026 / −174 |
| `git diff --check` | temiz |
| Stage | boş |

AŞAMA 6.1'in tüm değişiklikleri (pending-LID deposu, migration, 19 gateway testi, rapor) bu başlangıç durumunda **uncommitted** olarak mevcuttu ve korundu. Hiçbir dosya geri alınmadı, üzerine yazılmadı.

### 1.2 Bitiş

| Alan | Değer |
|---|---|
| Branch | `release/backend-only-seq-safety` (değişmedi) |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` (değişmedi) |
| Değişmiş tracked dosya | 20 (6.2: +3) |
| Untracked giriş | 23 (6.2: +1 test dosyası) |
| `git diff --stat` | 20 dosya, +2118 / −197 |
| 6.2'nin tracked katkısı | 3 dosya, +92 / −23 |
| `git diff --check` | temiz |
| Stage | boş |
| Commit / push / deploy | **Yapılmadı** |
| Bağımlılık kurulumu/güncellemesi | **Yapılmadı** |
| Production DB / gerçek WhatsApp oturumu | **Bağlanılmadı** |

6.2 yalnızca aşağıdaki tracked dosyalara dokundu; kampanya medya, outreach, reklam ve frontend dosyaları değiştirilmedi:

| Dosya | Tür | 6.2 katkısı |
|---|---|---|
| `backend/app/services/whatsapp/reconciliation.py` | Değişti | +80 / −20 |
| `backend/app/services/whatsapp_service.py` | Değişti | +1 / −1 |
| `scripts/diagnostics/whatsapp_lid_split_repair.py` | Değişti | +11 / −2 |
| `backend/tests/test_whatsapp_session_scoped_lid_reconciliation_62.py` | **Yeni** (767 satır, 11 test) | P0-2 kanıtı |
| `reports/whatsapp-phase-6.2-session-scoped-lid-reconciliation.md` | **Yeni** | Bu rapor |

---

## 2. P0-2 Kök Nedeni

LID kimliği (`jid:<lid>@lid`) ile telefon kimliği (`+90...`) arasındaki köprü `lid_mappings` tablosundadır. Aynı kişinin sohbeti iki WhatsApp hattında bölündüğünde, `contacts` kullanıcı düzeyinde olduğu için **tek bir hayalet kişi** ve tek bir kanonik kişi oluşur; fakat bu kişilerin `conversations` satırları **hat başına ayrıdır** (`conversations.session_id`).

Eski kod üç yerde birleştirmeyi oturumdan bağımsız çağırıyordu:

1. `merge_deferred_lid_ghosts` (boot) → `merge_split_conversation(..., session_id=None)` (eski satır 904).
2. `collect_stranded_lid_messages` (sweep artık toplama) → aynı şekilde `session_id=None` (eski satır 1111).
3. `whatsapp_service.merge_lid_splits` (manuel admin onarımı) → `session_id=None`.
4. `scripts/diagnostics/whatsapp_lid_split_repair.py` → `session_id=None` ve kanonik sohbeti oturum filtresi olmadan ölçüyordu.

Buna ek olarak aday sorgusu yalnızca `(lid_jid, phone_jid, user_id)` ile gruplandığı için:

- `MIN(cv.id)` herhangi bir hattın sohbetini seçebiliyordu,
- `_merge_under_lease` içinde `convs = {c.contact_id: c for c in rows}` **sırasız** olduğundan, aynı kişinin A hattındaki hayaleti ile B hattındaki kanonik sohbeti eşleşebiliyordu,
- okunmamış sayıları hatlar arasında toplanıyordu,
- `_canonical_conversation_id` oturum filtresi taşımadığı için sahipsiz mesaj toplama, mesajı başka hattın kanonik sohbetine taşıyabiliyordu.

Sonuç: **A hattına gelen bir mesaj B hattının sohbetine taşınıyor, A'nın hayaleti arşivleniyor ve kullanıcı mesajını yanlış hatta görüyordu.** Bu, 6.0 audit'inde P0-2 olarak işaretlenen ve 6.2'nin kapattığı kusurdur.

---

## 3. Eski Davranışı Üreten Test (Reproducer)

`/tmp/tz62-baseline` dizini, düzeltme öncesi HEAD `978ddf5...`'in `git archive` kopyasıdır. Yeni test dosyası bu arşive kopyalanıp çalıştırıldı:

- `test_h_candidate_pairs_carry_their_own_session` → **FAIL** (adaylarda oturum yok)
- `test_e_ambiguous_scope_called_with_none_moves_nothing` → **FAIL**
- `test_c_boot_reconciliation_processes_each_session_in_its_scope` → **FAIL**

Ek olarak `/tmp/tz62-baseline/probe_old_cross_session.py` ile A/B iki hatlı senaryo doğrudan ölçüldü (düzeltme öncesi kod):

```
OLD merged -> 4
ghost_a    id=2 session=1 archived=True  messages=[]
canon_b    id=4 session=2                messages=['a-lid-1']
```

Yani A hattının `a-lid-1` mesajı B hattının kanonik sohbetine taşındı; A'nın hayaleti arşivlendi. Bu, P0-2'nin gerçek veri kaybı/yanlış hat etkisidir. Düzeltme sonrası aynı senaryo `session_id=None` ile çağrıldığında birleştirme **yapılmaz**, `skipped_reason="ambiguous_session_scope"` döner ve hiçbir satır değişmez (test E).

---

## 4. Uygulanan Düzeltme

### 4.1 Adaylar kendi oturumlarını taşır

`reconciliation.py:351-456` — `candidate_lid_split_pairs`:

- `SELECT ... cv.session_id AS conversation_session_id`,
- `GROUP BY lm.lid_jid, lm.phone_jid, c.user_id, cv.session_id`,
- `ORDER BY lm.lid_jid, cv.session_id`,
- her adaya `"session_id": conversation_session_id` eklenir.

Aynı kişinin iki hattaki bölünmesi artık **iki ayrı adaydır**. `NULL` oturum tek başına bir kapsamdır ve başka oturuma genişlemez.

### 4.2 Birleştirme oturumla sınırlanır ve belirsizlikte fail-closed davranır

`reconciliation.py:633-696` — `_merge_under_lease`:

```python
if session_id is not None:
    scope_filters.append(Conversation.session_id == session_id)
...
if session_id is not None:
    effective_session_id = session_id
else:
    scopes = {conv.session_id for conv in conv_rows}
    if len(scopes) > 1:
        result_info["skipped_reason"] = "ambiguous_session_scope"
        return None
    effective_session_id = next(iter(scopes), None)
```

- Sohbet satırları `id.asc()` ile deterministik sıralanır; aynı kişi+oturum için anomali varsa en küçük id seçilir.
- `ensure_conversation(..., session_id=effective_session_id)` çağrısının ardından **post-ensure guard** vardır (`reconciliation.py:681-696`): sağlayıcı oturum filtresini yok sayıp başka hattın sohbetini döndürürse taşıma yapılmaz, iş ertelenir.
- Audit kaydı `session_id=effective_session_id` ile yazılır (`reconciliation.py:821`).

### 4.3 Boot, sweep, artık toplama ve manuel yollar tek kapsamı kullanır

| Çağrı yolu | Değişiklik | Satır |
|---|---|---|
| Boot (`merge_deferred_lid_ghosts`) | `session_id=pair.get("session_id")` | `reconciliation.py:907` |
| Artık toplama (`collect_stranded_lid_messages`) | `session_id=pair.get("session_id")` | `reconciliation.py:1114` |
| Kanonik sohbet arama (`_canonical_conversation_id`) | `session_filter` (`IS NULL` veya `== session_id`) | `reconciliation.py:987-1013` |
| Artık adayları (`candidate_stranded_lid_conversations`) | `session_id=pair.get("session_id")` | `reconciliation.py:1048` |
| Admin onarımı (`merge_lid_splits`) | `session_id=pair.get("session_id")` | `whatsapp_service.py:2339` |
| Diagnostik onarım | `session_id=pair_session_id` + oturum kapsamlı kanıt ölçümü | `whatsapp_lid_split_repair.py:130-157` |

Canlı ingest yolu (`_ingest_lid_mapped` → `reconcile_legacy_split_conversation(session_id=ws_session_id)`) zaten oturum taşıyordu; çözülemeyen oturumda `None` geçtiğinde yeni fail-closed davranışı devreye girer ve yanlış hatta yazmak yerine erteler.

**Şema/migration değişikliği yoktur.**

---

## 5. Oturum ve Tenant Yalıtımı Sonuçları

Yeni test dosyası: `backend/tests/test_whatsapp_session_scoped_lid_reconciliation_62.py` (11 test).

| Test | Ne kanıtlıyor | Sonuç |
|---|---|---|
| `test_h_candidate_pairs_carry_their_own_session` | Adaylar kendi `session_id`'leriyle döner; iki hat = iki aday | PASS |
| `test_a_merging_one_session_leaves_the_other_session_untouched` | A hattı birleşince B hattı satır satır **byte-identical** kalır | PASS |
| `test_b_same_lid_and_phone_in_two_tenants_never_cross_tenants` | Aynı LID+telefon iki kiracıda: 12 satır, her mesajın `user_id`'si sohbet sahibiyle aynı | PASS |
| `test_c_boot_reconciliation_processes_each_session_in_its_scope` | Boot her hattı kendi kapsamında birleştirir: `merged=2`, doğru gövde dağılımı, iki arşiv, unread=3 | PASS |
| `test_d_periodic_sweep_is_session_scoped_and_idempotent` | Sweep oturum kapsamlı; ikinci tur `scanned=0`, snapshot değişmez | PASS |
| `test_e_ambiguous_scope_called_with_none_moves_nothing` | `session_id=None` + iki oturum → `None`, `ambiguous_session_scope`, hiçbir satır değişmez | PASS |
| `test_e2_boot_never_moves_a_session_less_record_into_a_line` | `NULL` oturumlu hayalet A hattına taşınmaz; boot `merged=0`, `skipped=1` | PASS |
| `test_g_single_session_lid_merge_still_works` | Tek hat: `merged=1`, unread 1+2=3 | PASS |
| `test_g2_normal_pn_conversations_are_never_touched` | Normal PN/JID sohbetleri dokunulmaz | PASS |
| `test_g3_post_mapping_message_lands_on_the_same_lines_canonical_chat` | Eşleme sonrası gerçek `ingest_gateway_event` mesajı aynı hattın kanonik sohbetine düşer; diğer hat değişmez | PASS |
| `test_i_diagnostic_repair_merges_each_session_independently` | Diagnostik onarım `scanned=2`, `merged=2`; kanıt kanonik id'leri doğru | PASS |

Zorunlu akış eşlemesi:

1. İlk boot → C
2. Restart recovery → C + boot suite'indeki ikinci-boot idempotans testi
3. Periyodik sweep → D
4. Yeni eşleme sonrası canlı birleştirme → G3
5. Tek tenant'ta çok oturum → A, H
6. Farklı tenant'lar → B
7. Oturumu eksik/belirsiz eski kayıtlar → E, E2

**Tenant izolasyonu korundu:** B testi, aynı LID ve aynı telefonun iki kiracıda bulunduğu gerçekçi senaryoda hiçbir mesajın sahibinden farklı kiracının sohbetine düşmediğini satır düzeyinde doğrular.

---

## 6. AŞAMA 6.1 Regresyonu

6.1'in bekleyen LID mesajı akışı bozulmadı:

| Kontrol | Sonuç |
|---|---|
| Gateway 6.1 LID durability suite (`test-lid-pending-durability-61.mjs`) | **19 pass / 0 fail** |
| Eşleme sonrası mesajın doğru hatta düşmesi (G3, gerçek ingest) | **PASS** |
| 6.1 dosyaları (`pending-lid-repository.js`, `session-manager.js`, migration) | Değiştirilmedi |

6.2 hiçbir gateway dosyasına dokunmadı; 6.1 çalışma zamanı yolu aynen duruyor.

---

## 7. Test Matrisi ve Kanıt Sınıflandırması

### 7.1 SQLite (L3 — gerçek SQLAlchemy oturumları, mock yok)

```
pytest backend/tests/test_whatsapp_session_scoped_lid_reconciliation_62.py \
       backend/tests/test_whatsapp_boot_lid_merge.py \
       backend/tests/test_whatsapp_lid_tenant_isolation.py \
       backend/tests/test_whatsapp_lid_split_repair.py -q
→ 47 passed in 6.82s
```

### 7.2 PostgreSQL 17.11 (L4 — yerel izole veritabanı, mock yok)

```
DATABASE_URL=postgresql+asyncpg://isatezcan@localhost:5432/tezlify_62_isolated \
PYTHONPATH=.:scripts/pg_audit_tests \
pytest backend/tests/test_whatsapp_session_scoped_lid_reconciliation_62.py -q -p tz44_pgplugin
→ 11 passed in 4.20s
```

PostgreSQL'e özgü olarak test fixture'ı:

- `lid_mappings`'i `whatsapp_private.lid_mappings` üzerinden okur/yazar,
- FK için `whatsapp_private.gateway_sessions` satırı ekler (`ON CONFLICT DO NOTHING`),
- `NullPool` harness (`tz44_pgplugin`) ile event-loop'lar arası asyncpg bağlantı sorununu önler.

Bu DB **production değildir**; yerel `tezlify_62_isolated` veritabanıdır ve yalnızca test verisi içerir.

### 7.3 Tam WhatsApp backend regresyonu

```
pytest backend/tests/ -k "whatsapp" -q
→ 998 passed, 4 skipped, 1219 deselected, 2 errors in 88.62s
```

İki hata:

- `test_whatsapp_phase2_a_gateway_behavior.py::test_hydrated_group_broadcast_reaches_frontend`
- `test_whatsapp_phase2_a_gateway_behavior.py::test_hydrated_group_persists_via_real_ingestion`

Her ikisi de **düzeltme öncesi baseline HEAD arşivinde birebir aynı** şekilde hata verir. Neden: worktree'de `node_modules` yok ve Node testi `session-manager.js`'in `uuid` importunu çözemiyor (`ERR_MODULE_NOT_FOUND: Cannot find package 'uuid'`). 6.2'nin neden olduğu bir hata değildir.

### 7.4 Gateway

- 6.1 durability suite: **19 pass / 0 fail** (loader/stub tabanlı).
- `scripts/test-lid-alt-resolution.mjs` ve `scripts/test-bulk-jids-scope.mjs` gibi doğrudan `src/` yükleyen script'ler aynı `uuid` eksikliği nedeniyle çalıştırılamadı.

### 7.5 Mock / gerçek DB ayrımı

| Kanıt | Sınıf |
|---|---|
| 11 oturum-kapsam testi (SQLite) | Gerçek DB, gerçek ORM, mock yok |
| 11 oturum-kapsam testi (PostgreSQL 17.11) | Gerçek DB, gerçek ORM, mock yok |
| Boot/sweep/tenant/diagnostik regresyonu | Gerçek DB, mock yok |
| Gateway 6.1 suite | Node loader stub'ları (Baileys/pg/pino/uuid) — 6.1 davranışı için tasarlanmış harness |

Mock sonuçları PostgreSQL kanıtı olarak sunulmamıştır.

---

## 8. Çalıştırılamayan Testler ve Nedenleri

| Test | Neden |
|---|---|
| `scripts/test-lid-alt-resolution.mjs`, `scripts/test-bulk-jids-scope.mjs` ve `node_modules` gerektiren diğer gateway script'leri | Worktree'de `node_modules` yok; `uuid` çözümlenemiyor. Ortam sınırlaması; 6.2 kapsamı dışı ve düzeltmeden önce de aynı. |
| `test_whatsapp_phase2_a_gateway_behavior.py` (2 test) | Aynı `uuid` eksikliği; baseline HEAD'de de hata. |
| Frontend build/test | 6.2 frontend'e dokunmadı; gerekmiyor. |

---

## 9. Bilinen Sınırlamalar ve Notlar

1. **Canlı yol zamanlaması:** `reconcile_legacy_split_conversation` çözülemeyen `ws_session_id` ile (`None`) çağrıldığında, iki oturum görünüyorsa artık birleştirme yapılmaz; iş periyodik sweep'e ertelenir. Doğru davranıştır (yanlış hatta yazmaktan iyidir), ancak birleşme anı boot/sweep'e kayar.
2. **`lid_mappings` tenant kolonu taşımıyor:** sahiplik hâlâ `contacts.user_id` üzerinden okunur. Tasarım 6.2'de değiştirilmedi; B testi yalıtımı bu tanımla civilliyor.
3. **Belirsizlik tespiti çiftin görünen sohbetleriyle sınırlıdır:** bir hattın sohbet satırı hiç yoksa "iki oturum" tespit edilemez; ancak o durumda taşınacak çapraz-hat satırı da yoktur.
4. **`LIMIT` anlamı:** `candidate_lid_split_pairs` limiti oturum başına gruplamadan sonra uygular; `remaining_at_least` kalan işi dürüstçe raporlar (mevcut davranış).
5. **Şema değişikliği yok:** 6.2 için migration gerekmez; 6.1'in `lid_pending_messages` tablosu aynen korunur.
6. **Production verisi:** hiçbir production DB'sine veya gerçek WhatsApp oturumuna bağlanılmadı; ölçümler yerel SQLite ve yerel PostgreSQL 17.11 üzerindedir.

---

## 10. Kabul Kriterleri Kontrolü

| Kriter | Durum |
|---|---|
| Boot reconciliation oturum kapsamlı | **PASS** (C) |
| Periyodik sweep oturum kapsamlı | **PASS** (D) |
| Tenant izolasyonu korunuyor | **PASS** (B) |
| Eksik oturum çapraz birleşmeye yol açmıyor | **PASS** (E, E2) |
| Aynı oturum içi LID davranışı korunuyor | **PASS** (G, boot suite) |
| 6.1 pending akışı bozulmadı | **PASS** (19/19 + G3) |
| Yeni testler P0-2'yi üretiyor ve düzeltmeyi kanıtlıyor | **PASS** (baseline FAIL → düzeltme PASS) |
| İlgili regresyonlar geçiyor | **PASS** (998 passed; 2 hata baseline'da da var) |
| Dirty/untracked dosyalar korundu | **PASS** |
| Commit / push / deploy yok | **PASS** |

---

## 11. Sonuç

**PASS_WITH_NOTES**

P0-2 kök nedeni kapatıldı: LID birleştirmesi artık yalnızca ait olduğu WhatsApp oturumu ve tenant kapsamındaki kimlik kayıtlarını etkiler; belirsiz kapsamda fail-closed davranır; boot, sweep, artık toplama, admin ve diagnostik yolları aynı kapsam kuralını kullanır. Aynı oturum içi davranış, tenant izolasyonu ve 6.1 pending akışı korunmuştur.

Notlar yalnızca ortam/baseline sınırlamaları (worktree'de `node_modules` yokluğu ve buna bağlı iki mevcut gateway test hatası) ile canlı yolun belirsiz oturumda birleşmeyi sweep'e ertelemesi davranışıdır; kabul kriterlerini etkilemez.

Rapor tamamlanmıştır. Sonraki aşamaya geçilmedi; commit, push veya deploy yapılmadı.
