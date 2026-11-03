# Aşama 4.24.1 — Backend 4.7 + Gateway 4.17 Birleşik Release Ref Hazırlığı

**Tarih:** 2026-11-01 00:39–00:45 +0300
**Mod:** Kontrollü Git release hazırlığı. Üretime dokunulmadı: SSH/deploy/restart/rebuild/DB yazma/RAM müdahalesi **YOK**, persistence loop ve flag **kapalı**, **push YOK**, yeni remote ref **YOK**, mevcut ref silme/değiştirme **YOK**, amend/rebase/reset/squash/force **YOK**, `git add -A` **YOK**, uygulama kodunda değişiklik **YOK**.
**Sonuç:** ✅ **READY FOR EXPLICIT PUSH APPROVAL**

---

## 0. Özet

`2236cae` (backend 4.7) ile `20c88bb` (gateway 4.17) — ikisi de `cbe4f509`'un çocuğu, hiçbiri diğerini içermiyor — **tek bir birleşik commit'te** birleştirildi.

| Alan | Değer |
| --- | --- |
| **Ref** | `release/whatsapp-combined-backend-4.7-gateway-4.17` |
| **Commit** | `de1f1ad34f123a304f6b6432cd22a546ccafac36` |
| **Tree** | `9966f6065ac03a6c192a5aaff66c33cfc48c405d` |
| **Ebeveynler** | `2236caebd4281b108b835f16f4c80d3d2e2f1d05` (1.) · `20c88bb9fd1f4dabb73e0d2538dbbe219d9816e6` (2.) |
| **Ortak taban** | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| **Kapsam** | **18 dosya**, **+3248 / −84** (= 11 dosya/+2038−61 backend ⊕ 7 dosya/+1210−23 gateway) |
| **Çakışma** | **0** (dosya kümeleri ayrık) |
| **Silinen dosya** | **0** |

Birleştirme `git merge-tree --write-tree` ile **hiçbir çalışma ağacına dokunmadan** hesaplandı, sonra `git commit-tree` ile iki ebeveynli commit olarak mühürlendi. Hiçbir mevcut commit değiştirilmedi; yalnızca **yeni** bir commit ve **yeni** bir yerel branch oluşturuldu.

---

## 1. Ön doğrulamalar

### 1.1 Çalışma dizini / branch / HEAD

| Öğe | Değer |
| --- | --- |
| Dizin | `/Users/isatezcan/Documents/Github/Tezlify` |
| Branch | `main` |
| HEAD | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` |
| `git status` | **59 girdi** (geliştirme ağacı — release çalışmaları commit'lenmemiş halde duruyor) |

**Kritik karar:** Ana çalışma ağacı **kirli** ve orada release değişiklikleri (backend/gateway dosyaları + `.workbuddy-ai/memory/*`) commit edilmemiş halde duruyor. Bu ağaçta merge yapmak, `git add -A` yasağını ve "yalnız bu iki release'in değişikliklerini içer" kuralını ihlal riski taşırdı. Bu yüzden birleştirme **ana ağaca hiç dokunmadan** yapıldı:

1. `git merge-tree --write-tree 2236cae 20c88bb` → yalnız **tree** üretir, worktree/index/HEAD değişmez.
2. `git commit-tree <tree> -p 2236cae -p 20c88bb` → commit nesnesi.
3. `git branch <ref> <commit>` → branch işaretçisi.
4. Testler için **ayrı** geçici worktree (`/tmp/tz4241-combined`).

Ana ağacın `git status` sayısı işlem öncesi **59**, işlem sonrası **59** — değişmedi.

### 1.2 Üç SHA mevcut mu?

| SHA | Durum | Konu |
| --- | --- | --- |
| `2236caebd4281b108b835f16f4c80d3d2e2f1d05` | ✅ `git cat-file -e` OK | `test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction` |
| `20c88bb9fd1f4dabb73e0d2538dbbe219d9816e6` | ✅ OK | `fix(whatsapp-gateway): implement epoch-aware sequence pagination` |
| `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` | ✅ OK | `release: backend-only 3.8.7 (whatsapp-gateway frozen at 38fe…` |

### 1.3 Ortak taban ve dosya kümesi kesişimi

```
git merge-base 2236cae 20c88bb  → cbe4f509f4bcc5babb12cc85e0ad422cb13ba739
backend dosya kümesi : 11
gateway dosya kümesi :  7
kesişim (comm -12)   :  0
```

`git merge-base --is-ancestor` iki yönde de **NO** (kardeş commit'ler) — 4.24'ün yapısal bulgusu bu oturumda yeniden doğrulandı.

---

## 2. Birleştirme

```
$ git merge-tree --write-tree --name-only 2236cae 20c88bb
9966f6065ac03a6c192a5aaff66c33cfc48c405d
RC=0        (çakışma çıktısı YOK, stderr boş)

$ git commit-tree 9966f60… -p 2236cae -p 20c88bb -F /tmp/tz4241_commit_msg.txt
de1f1ad34f123a304f6b6432cd22a546ccafac36

$ git branch release/whatsapp-combined-backend-4.7-gateway-4.17 de1f1ad…
```

Commit nesnesi:

```
tree    9966f6065ac03a6c192a5aaff66c33cfc48c405d
parent  2236caebd4281b108b835f16f4c80d3d2e2f1d05
parent  20c88bb9fd1f4dabb73e0d2538dbbe219d9816e6
author  isatezcan444 <isatezcan444@gmail.com> 1793482786 +0300
committer isatezcan444 <isatezcan444@gmail.com> 1793482786 +0300

release: combined backend 4.7 + gateway 4.17 (epoch-aware keyset pagination)
```

Graf:

```
*   de1f1ad (release/whatsapp-combined-backend-4.7-gateway-4.17) release: combined backend 4.7 + gateway 4.17
|\
| * 20c88bb (origin/release/gateway-seq-pagination-4.17) fix(whatsapp-gateway): epoch-aware sequence pagination
* | 2236cae (origin/release/backend-only-4.7) test(whatsapp): poison-row savepoint isolation
* | 17ccbc9 release: backend-only 4.7 (memory persistence core safety fix)
|/
```

**Ancestry:** `2236cae`, `20c88bb` ve `cbe4f509` — üçü de `de1f1ad`'ın **ancestor'ı** (`git merge-base --is-ancestor` → YES ×3).

### 2.1 "Ağaç tam olarak birleşim mi?" — iki taraflı kanıt

| Karşılaştırma | Beklenen | Gerçek |
| --- | --- | --- |
| `git diff 2236cae de1f1ad` | yalnız **7 gateway dosyası**, +1210/−23 | **7 dosya, +1210/−23** ✅ |
| `git diff 20c88bb de1f1ad` | yalnız **11 backend dosyası**, +2038/−61 | **11 dosya, +2038/−61** ✅ |
| `git diff cbe4f509 de1f1ad` | **18 dosya**, +3248/−84 | **18 dosya, +3248/−84** ✅ |
| `git diff --diff-filter=D cbe4f509 de1f1ad` | silme yok | **0** ✅ |

Yani birleşik ağaç, iki release'in **tam birleşimi**; fazladan hiçbir dosya, eksik hiçbir dosya, hiçbir silme yok.

---

## 3. Değişen dosyaların tam listesi

### 3.1 Backend 4.7 tarafı (11 dosya) — `2236cae`'den

| Blob (git SHA1) | Dosya |
| --- | --- |
| `bbd99ca0b28307c6d0636d20411537952511dc29` | `backend/app/main.py` |
| `e12c030bd239c7b9099b7d0f4b02a6ab44a6aa7d` | `backend/app/services/whatsapp/memory_persistence.py` |
| `213f736e976ff5db0b27e86f09361623e4158ffd` | `backend/app/services/whatsapp/orchestration/sync.py` |
| `2f44be2058c2686c6b0f7f16d241ac79b69b36ad` | `backend/app/services/whatsapp_gateway.py` |
| `db60486e05f30e24731d0cb2a04d64b792f8c864` | `backend/tests/test_whatsapp_memory_persistence.py` |
| `4b6314a3f762655c4710895e4f428668d5d60b71` | `backend/tests/test_whatsapp_memory_persistence_hardening.py` |
| `36be990173065820fde00f051d64e3f87d6db611` | `backend/tests/test_whatsapp_message_insert_isolation.py` **(A)** |
| `bab8dec13bded2368cd7ca7ef7861a17e1a119a5` | `backend/tests/test_whatsapp_pagination_contract.py` **(A)** |
| `2848509a18a889376c46893e16c238954af98c19` | `scripts/pg_audit_tests/test_tz44_missing.py` **(A)** |
| `29e189c3bf47613447b64ac1b695f0b17b0445a0` | `scripts/pg_audit_tests/test_tz46_audit.py` **(A)** |
| `e1dccfeeb3bf65d7107618abf555ec778a661890` | `scripts/pg_audit_tests/tz44_pgplugin.py` **(A)** |

### 3.2 Gateway 4.17 tarafı (7 dosya) — `20c88bb`'den

| Blob (git SHA1) | Dosya |
| --- | --- |
| `53a9a1ef90cdd44e94daecbe753bbeaee6bf5a30` | `whatsapp-gateway/package.json` |
| `a93bf0614720028c8d83475f82f71b80ebad4e02` | `whatsapp-gateway/scripts/test-bulk-seq-pagination-guarantees.mjs` **(A)** |
| `761ff7a92bdd01aef49d8a817d7413fc1d4ea95b` | `whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs` **(A)** |
| `128b0bbb7679fcce391bf2012d7343d2cea1965b` | `whatsapp-gateway/src/index.js` |
| `c5bef759693a4dc575dde9e7f9999543be1c8d1b` | `whatsapp-gateway/src/messages/message-store.js` |
| `b8676998a1ca8ae1083649007b7376d548dc7718` | `whatsapp-gateway/src/session-manager.js` |
| `cd3a21cc497c66d4bfe2a50629c7aee7243763d9` | `whatsapp-gateway/src/socket/socket-events.js` |

**(A)** = yeni dosya.

### 3.3 İstenen blob eşitlikleri — tek tek doğrulandı

| İstenen | Sonuç |
| --- | --- |
| `memory_persistence.py` = 4.7 | ✅ `e12c030b…` (her iki ref'te aynı) |
| `sync.py` = 4.7 | ✅ `213f736e…` |
| `index.js` = 4.17 | ✅ `128b0bbb…` |
| `message-store.js` = 4.17 | ✅ `c5bef759…` |
| `session-manager.js` = 4.17 | ✅ `b8676998…` |
| `socket-events.js` = 4.17 | ✅ `cd3a21cc…` |

18 dosyanın **tamamı** kaynak ref'iyle birebir eşleşiyor (tek tek `git rev-parse <tree>:<path>` ↔ `<ref>:<path>` karşılaştırması: 18/18 OK).

**4.24 ile süreklilik (içerik SHA-256, blob SHA1 değil):**

| Dosya | SHA-256 (ilk 16) | 4.24'teki değer |
| --- | --- | --- |
| `memory_persistence.py` | `070fda0397f76577` | `070fda03…` (= 4.7) ✅ |
| `sync.py` | `edb7e9d2921c7699` | `edb7e9d2…` (= 4.7) ✅ |
| `config.py` | `9f847dba556d8a68` | `9f847dba…` (**değişmedi**) ✅ |
| `index.js` | `641b106241bc28f5` | `641b1062…` (= 4.17) ✅ |
| `session-manager.js` | `0818cc85bb11ac5d` | `0818cc85…` (= 4.17) ✅ |

> Not: iki hash ailesi karıştırılmadı — **git blob = SHA1**, içerik = **SHA256**.

---

## 4. Deploy betiği ve altyapı uyumluluğu

| Dosya | `cbe4f509` | `2236cae` | `20c88bb` | `de1f1ad` | Sonuç |
| --- | --- | --- | --- | --- | --- |
| `scripts/deploy/host-release.sh` | `f2b7a9ae…` | `f2b7a9ae…` | `f2b7a9ae…` | `f2b7a9ae…` | **SAME** ✅ |
| `scripts/deploy/run_release.sh` | `9284245f…` | `9284245f…` | `9284245f…` | `9284245f…` | **SAME** ✅ |
| `scripts/deploy/migration_guard.py` | `654c8dbe…` | = | = | = | **SAME** ✅ |
| `scripts/deploy/message_watermark.py` | `bb0a0f35…` | = | = | = | **SAME** ✅ |
| `scripts/deploy/persistence_flag_guard.py` | `b69dd6a8…` | = | = | = | **SAME** ✅ |
| `scripts/deploy/backend_only_release.py` | `b7f0f360…` | = | = | = | **SAME** ✅ |
| `scripts/deploy/candidate_db_url.py` | `5f93ca85…` | = | = | = | **SAME** ✅ |
| `docker-compose.yml` | `dd0aed79…` | = | = | = | **SAME** ✅ |
| `backend/Dockerfile` | `c73fa3b5…` | = | = | = | **SAME** ✅ |
| `whatsapp-gateway/Dockerfile` | `1940cef6…` | = | = | = | **SAME** ✅ |

**Beklenmeyen fark yok.** Birleşik ref, dört ref'te de byte-aynı olan deploy altyapısını **hiç değiştirmiyor**.

### 4.1 Operasyonel not — `--no-gateway` bu ref için REDDEDECEK

```
git diff --quiet cbe4f509 de1f1ad -- whatsapp-gateway/ docker-compose.yml  →  DEĞİL
```

`host-release.sh`'in `--no-gateway` muhafızı gateway ağacının değiştiğini görüp **duracak** (`die "--no-gateway kullanilamaz: gateway/compose degismis"`). Bu **doğru** davranıştır: birleşik ref **tam release** olarak deploy edilmelidir. Backend-only bir adım gerekirse o adım ayrı ref (`release/backend-only-4.7`) ile yapılır — o ref hâlâ yerinde ve değişmedi.

---

## 5. Test sonuçları

Testler geçici worktree'de (`/tmp/tz4241-combined`, HEAD = `de1f1ad`) ve **izole SQLite** üzerinde koştu. `DATABASE_URL` **ve** `TEST_DB_PATH` birlikte export edildi (`conftest.py` ikisinin ayrışmasını reddeder); `TEZLIFY_TEST_DB_REMOTE_OK` **verilmedi** — yani üretim DB'sine bağlanma yolu kapalıydı.

```
TEST_DB_PATH=/tmp/tz4241_test.db python scripts/provision_test_db.py
→ provisioned: 34 tables · history_sync_states ✓ · lid_mappings ✓ · initial_sync_completed_at ✓
```

### 5.1 Backend — hedefli dosyalar

```
pytest backend/tests/test_whatsapp_pagination_contract.py
       backend/tests/test_whatsapp_message_insert_isolation.py
       backend/tests/test_whatsapp_memory_persistence.py
       backend/tests/test_whatsapp_memory_persistence_hardening.py
→ 39 passed in 1.09s
```

| Dosya | Test |
| --- | --- |
| `test_whatsapp_pagination_contract.py` | **9** |
| `test_whatsapp_message_insert_isolation.py` | **5** |
| `test_whatsapp_memory_persistence.py` | **10** |
| `test_whatsapp_memory_persistence_hardening.py` | **15** |

### 5.2 Backend — tüm WhatsApp grubu (regresyon)

```
pytest backend/tests -k whatsapp -p no:randomly
→ 919 passed, 4 skipped, 1147 deselected, 218 warnings in 104.52s
```

**4.21'deki candidate sonucuyla birebir aynı: 919 / 4 skipped.** Birleştirme hiçbir testi bozmadı.

4 skip, 4.21'dekiyle aynı canlı seam testleri:
`test_whatsapp_phase6_5_qr_live_seam.py` ×4 — `set WHATSAPP_LIVE_GATEWAY_URL to run the live QR seam test`.

### 5.3 Gateway

```
node scripts/test-bulk-seq-pagination.mjs              → PASS (8 checks), RC=0
node scripts/test-bulk-seq-pagination-guarantees.mjs   → PASS (32 checks), RC=0
npm test                                               → NPM_RC=0  (195 `ok` assertion)
```

`npm test` zinciri son test `test-latency-metrics` ile temiz bitti (`All assertions passed`).

---

## 6. P0-1 kanıtları

### 6.1 Yapısal: iki yarı da aynı ağaçta ve **birbirine bağlı**

| # | Yer | Kanıt |
| --- | --- | --- |
| 1 | `backend/app/services/whatsapp_gateway.py:376` | `after_seq: Optional[int] = None,` — parametre var |
| 2 | `backend/app/services/whatsapp_gateway.py:412,414` | `params["afterSeq"] = int(after_seq)` · `params["seqEpoch"] = str(seq_epoch)` — **backend gönderiyor** |
| 3 | `backend/app/services/whatsapp/memory_persistence.py:417,418` | `after_seq=after_seq if mode == "seq" else None` · `seq_epoch=epoch if mode == "seq" else None` |
| 4 | `whatsapp-gateway/src/index.js:568` | `const { limit, offset, since, perChatLimit, jids, afterSeq, seqEpoch } = req.query;` — **gateway okuyor** |
| 5 | `whatsapp-gateway/src/index.js:584` | `afterSeq: … parseInt(afterSeq, 10) : null` |
| 6 | `whatsapp-gateway/src/session-manager.js:1310` | `pagination: 'seq',` — **gateway `seq` yanıtlıyor** |

Bu altı çapa **yalnızca birleşik ağaçta birlikte** bulunur: 4.24'te kanıtlandığı gibi `cbe4f509`'un `index.js:564`'ü `afterSeq`'i destructure **etmiyor**, `2236cae`'nin backend'i ise `afterSeq`'i zaten gönderiyor. Yani bu ref, P0-1'in **ilk kez** uçtan uca kapandığı ağaçtır.

### 6.2 Davranışsal: testler

**Backend sözleşme testleri (9/9 geçti):**

```
test_new_gateway_seq_response_is_parsed_and_cursor_advances_by_value
test_legacy_gateway_without_pagination_falls_back_to_offset
test_offset_fallback_preserves_the_starting_cursor
test_epoch_change_triggers_a_safe_rescan_and_is_counted
test_front_trim_skips_messages_in_offset_mode
test_front_trim_does_not_skip_messages_in_seq_mode
test_stalled_seq_cursor_is_reported_instead_of_looping_forever
test_missing_next_after_seq_is_a_contract_error
test_health_payload_never_leaks_a_gateway_uuid
```

**Gateway sözleşme testi (8/8):**

```
ok - A. seq mode returns pagination/seq_epoch/next_after_seq/reached_end
ok - B. a second seq page continues strictly after the cursor
ok - C. no afterSeq -> legacy offset shape is unchanged
ok - D. seq values are unique and strictly increasing
ok - E. front-trim skips in offset mode but not in seq mode
ok - F. an epoch mismatch resets the cursor instead of losing records
ok - G. a malformed afterSeq falls back to offset (no silent seq mode)
ok - H. the bulk route forwards afterSeq/seqEpoch        ← P0-1 gateway yarısı
```

**Gateway garantileri (32/32)** — öne çıkanlar:

```
15a. perChatLimit does NOT truncate a seq page (no silent skip)
15b. perChatLimit still truncates in offset mode (legacy behaviour intact)
6b.  a full-cap chat is fully reachable through the seq cursor
7b.  a cursor that already passed the evicted record still advances cleanly
12a. adding messages between pages trims the oldest without moving the cursor
11c. a stale epoch from the old process rescans instead of returning nothing
L1/L2/L3. 5000 ingest/drain — her hayatta kalan kayıt tam bir kez
B1–B5. afterSeq göndermeyen istemci eski offset sözleşmesini alır
R1.  eşzamanlı ingest+trim sırasında drain ne çoğaltır ne geri sarar
```

---

## 7. P0-2 kanıtları

`backend/tests/test_whatsapp_message_insert_isolation.py` — **5/5 geçti:**

```
test_client_message_id_collision_is_isolated_per_row
test_poison_row_leaves_the_outer_transaction_usable
test_constraint_name_reads_asyncpg_diag_from_the_cause
test_constraint_name_prefers_a_direct_diag
test_constraint_name_falls_back_to_sqlstate_without_lying
```

Kod tarafı (birleşik ağaçta `2236cae`'nin aynısı, blob `213f736e…`):
- bulk INSERT `begin_nested()` (SAVEPOINT) içinde; `IntegrityError` → `_insert_messages_one_by_one` her satır için ayrı SAVEPOINT,
- `on_conflict_do_nothing(index_elements=["conversation_id","wa_message_id"], index_where=text("wa_message_id IS NOT NULL"))`,
- `dead_letter{count, constraint}` raporlanır; `_integrity_constraint_name()` asyncpg sarmalayıcısında `orig.__cause__.diag`'ı okur (SQLSTATE yerine gerçek index adı).

Üretimde `uq_msg_conv_wa_message_id` unique index'i **mevcut** (4.24'te doğrulandı) ⇒ `ON CONFLICT` hedefi var, migration gerekmiyor.

---

## 8. Git çalışma ağacı durumu

| Ağaç | HEAD | `git status` |
| --- | --- | --- |
| Ana repo (`/Users/isatezcan/Documents/Github/Tezlify`) | `7afb540` (`main`) | **59** girdi — işlem öncesi 59, sonrası 59 (**değişmedi**) |
| Geçici worktree (`/tmp/tz4241-combined`) | `de1f1ad` | **0** — **temiz** |

Geçici worktree'de test için oluşturulan `whatsapp-gateway/node_modules` symlink'i **kaldırıldı** (bu ad `node_modules/` gitignore kuralına takılmaz — 4.16'nın D1 bulgusu), sonrasında `git status` **0**.

### 8.1 Ref durumu

| Ref | Değer | Değişti mi |
| --- | --- | --- |
| `main` | `7afb5406…` | ❌ değişmedi |
| `release/backend-only-4.7` | `2236caeb…` | ❌ |
| `release/gateway-seq-pagination-4.17` | `20c88bb9…` | ❌ |
| `release/backend-only-3.7 / 3.8.1 / 3.8.4 / 3.8.5 / 3.8.7` | `21346e3… / 68ca413… / 3d3fc79… / 38fe087… / cbe4f50…` | ❌ |
| **`release/whatsapp-combined-backend-4.7-gateway-4.17`** | **`de1f1ad3…`** | ✅ **yeni** |

**Remote:** `git ls-remote origin refs/heads/release/*` → 7 ref, hepsi eskisi gibi. **Yeni remote branch yok, push yapılmadı.**

---

## 9. Sapmalar ve riskler

| ID | Konu | Değerlendirme |
| --- | --- | --- |
| S1 | Birleştirme `git merge` yerine `merge-tree` + `commit-tree` ile yapıldı | **Kasıtlı sapma, risk yok.** Ana ağaç kirliydi; gerçek `git merge` orada çalıştırılamazdı. `merge-tree --write-tree` git'in kendi merge motorudur ve sonuç aynı iki-ebeveynli commit'tir. Sonuç ağacın doğruluğu iki taraflı diff ile kanıtlandı (§2.1). |
| S2 | Birleşik commit'in **tek bir release mesajı** var, iki ayrı commit yok | Bilinçli: squash **değil** — her iki kaynak commit de ebeveyn olarak korunuyor, geçmiş kaybolmuyor. |
| R1 | `--no-gateway` bu ref için reddeder | Beklenen. Birleşik ref **tam release** olarak deploy edilmeli (§4.1). |
| R2 | Birleşik ref `main`'in descendant'ı değil | Beklenen ve 4.24'te belgelenmiş durum: release ref'leri `cbe4f509` tabanlı. "main'de yok" bir hata değil, backend-only release modelinin normali. |
| R3 | Gateway recreate RAM deposunu sıfırlar (A6) | Deploy aşamasının riski, bu aşamanın değil. 4.24'te `RAM_ONLY = 0` ölçüldü; deploy öncesi **yeniden** ölçülmeli (C2). |
| R4 | `scripts/pg_audit_tests/` 3 dosyası birleşik ağaçta | 4.21'de kanıtlandı: `backend/Dockerfile` yalnız `backend/` + `start.py` kopyalar, `host-release.sh` pytest çalıştırmaz ⇒ imaja **girmez**, release kapısında **çalışmaz**. |
| R5 | Testler geçici worktree'de koştu, ana ağaçta değil | Ağaç `de1f1ad`'a birebir eşit (`git status` 0, blob'lar doğrulandı) ⇒ sonuçlar birleşik ref'i temsil ediyor. |

**Beklenmeyen dosya farkı, test başarısızlığı veya SHA uyuşmazlığı görülmedi.** Durdurma koşullarından hiçbiri tetiklenmedi.

---

## 10. Verdict

### ✅ READY FOR EXPLICIT PUSH APPROVAL

- Birleşik ref hazır: `release/whatsapp-combined-backend-4.7-gateway-4.17` → **`de1f1ad34f123a304f6b6432cd22a546ccafac36`**
- Ağaç, iki release'in **tam birleşimi**: 18 dosya, +3248/−84, silme 0, fazladan dosya 0.
- Tüm istenen blob eşitlikleri sağlandı (6/6 hedef dosya + 18/18 tam eşleşme).
- Deploy altyapısı (2 betik + 5 yardımcı + compose + 2 Dockerfile) dört ref'te de **byte-aynı**.
- Backend **919 passed / 4 skipped** (4.21 ile birebir), gateway **npm test RC=0** (195 assertion), seq sözleşmesi **8/8**, garantiler **32/32**.
- P0-1'in iki yarısı da aynı ağaçta ve **birbirine bağlı** (6 çapa + testler); P0-2 **5/5**.
- Mevcut hiçbir ref, commit veya çalışma ağacı değişmedi.

**Burada duruyorum.** Push, deploy, restart, rebuild veya persistence aktivasyonu **yapılmadı** ve bunlar için **ayrıca açık onay** gerekiyor.

**Push onayı verilirse çalıştırılacak komut (henüz çalıştırılmadı):**

```
git push -u origin release/whatsapp-combined-backend-4.7-gateway-4.17
```

`--force`, `--all`, `--mirror` **yok**; remote'da bu isimde branch **yok** (dolayısıyla force gerekmez).
