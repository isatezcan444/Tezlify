# AŞAMA 5.3.11 — REGRESSION TEST CHAIN INTEGRATION

**Hüküm: PASS** (8/8 kriter — §9)
**Kodlama:** yalnızca test zinciri entegrasyonu · **Altyapı:** HAYIR (deploy / servis / Docker / ağ yok)
**Worktree:** `/private/tmp/tz429-release` · **Branch:** `release/backend-only-seq-safety`
**Başlangıç HEAD:** `3ac26a9` · **Bitiş HEAD:** `3ac26a9` (değişmedi)

---

## 1. Özet

5.3.10 beş kayıp test dosyasını kurtardı ve iki yeni doğrulama betiği üretti, ama hiçbiri
**otomatik koşmuyordu**. Bu aşama onları zincire bağladı. Bağlanan her betik, bağlanmadan
önce tek tek yeşil olduğu **ve** başarısız olduğunda zinciri gerçekten düşürdüğü **ölçülerek**
kanıtlandı.

İki dosya değişti:

| Dosya | Değişiklik | Kanıt |
| --- | --- | --- |
| `whatsapp-gateway/package.json` | `test` zinciri **36 → 40** halka (+4) | HEAD'in 36 halkası **birebir ve aynı sırada** korundu; `git diff --numstat` = `1 1` |
| `backend/scripts/run_whatsapp_regression.py` | `MANDATORY_TESTS` **8 → 10** (+2 satır) | İki satır çıkarılınca geri kalan **bayt-bayt** 5.3.10'un kaydettiği `a81270ab0fb33aa2…` hash'ine dönüyor |

Üretim kaynak dosyalarında **tek bayt** değişmedi: 5 üretim dosyasının sha256'sı 5.3.11
başlangıç anındaki değerlerle aynı (§6).

### Yol boyunca çıkan üç bulgu

**B1 — Zincire bağlanan 4 betikten biri zaten commit'lenmişti ama hiç koşmuyordu.**
`whatsapp-gateway/scripts/test-upsert-notify-append.mjs` HEAD'de **tracked**; `HEAD:package.json`
zincirinde ise **0** kez geçiyor. Yani 5.3.7'de yazılan ve commit'lenen bir test, o günden beri
hiçbir otomatik koşuda yer almadı. Bu, `run_whatsapp_regression.py`'nin kendi docstring'inde
yazdığı kuralın ("bir testi koşan bir komut yoksa o test yoktur") commit'lenmiş dosyalar için de
geçerli olduğunu gösteriyor: **tracked ≠ koşuyor.**

**B2 — `test-tz428-initial-sync-front-trim.mjs` hiç `process.exit` çağırmıyor.**
Diğer üç betik `failures` sayacı + `process.exit(1)` kullanıyor; bu betik `check()` içinde
`throw` ediyor. ESM'de yakalanmayan throw süreci 1 ile sonlandırdığı için exit kodu **doğru**,
ama bu "doğruluk" koda bakarak değil **ölçülerek** gösterildi (§5.3): iki ayrı mutasyon,
iki ayrı yol (yardımcı fonksiyon içi → yakalanmamış throw; `check()` içi → `FAIL -` + throw),
her ikisi de rc=1.

**B3 — Runner ilk hatada durmuyor, koşmaya devam ediyor.**
Bu bir hata değil, tasarım: tüm dosyalar koşar, özet sonunda verilir, çıkış kodu 1 olur.
Ölçüldü (§5.4 Probe B). Bunun bir sonucu: 10 dosyalık sette tek bir kırık dosya, kalan 9'un
sonucunu **gizlemez**.

---

## 2. Başlangıç durumu (ölçüldü)

| Ölçüm | Değer |
| --- | --- |
| Worktree HEAD | `3ac26a9` (`release/backend-only-seq-safety`) |
| Staged | 0 |
| Modified (tracked) | 5 (hepsi 5.3.9 / 5.3.10 üretim dosyası) |
| Untracked | 13 |
| Toplam `git status` satırı | **18** |
| `main` HEAD | `e7f1077` · dirty **87** |
| Üretim dosyası sha256 (ilk 16) | `events.py 880162745b60e747` · `sessions.py bc5c6610a42a3ca1` · `useWhatsAppConversation.ts 15e8c8f770f20629` · `session-manager.js 27a3c80e76d25eab` · `socket-events.js a2f7281ffee20892` |

Worktree **tertemiz değil** — 5.3.9/5.3.10'ın üretim diff'leri ve 8 test dosyası zaten
üstünde duruyor. Bu yüzden "üretim kodu değişmedi" iddiası "worktree temiz" ile değil,
**hash yeniden ölçümü + diff kapsamı aritmetiği** ile kanıtlandı (§6).

---

## 3. GÖREV 2 — Gateway test zinciri

### 3.1 Bağlanmadan önceki durum

`whatsapp-gateway/package.json` → `scripts.test`, **36 halka**, tek satır, `&&` ile bağlı.

| Betik | Zincirde | Dosya HEAD'de |
| --- | --- | --- |
| `test-bulk-seq-pagination.mjs` | **VAR** (halka 14) | tracked |
| `test-bulk-seq-pagination-guarantees.mjs` | **VAR** (halka 15) | tracked |
| `test-tz428-initial-sync-front-trim.mjs` | **YOK** | untracked |
| `test-upsert-notify-append.mjs` | **YOK** | **tracked** (B1) |
| `test-ingest-write-order.mjs` | **YOK** | untracked |
| `test-message-update-semantics.mjs` | **YOK** | untracked |

### 3.2 Yapılan değişiklik

Mevcut biçime uyularak zincirin **sonuna** dört halka eklendi (mevcut halkaların sırası
korundu, hiçbiri silinmedi, hiçbiri yeniden sıralanmadı):

```
… && node scripts/test-history-orchestration.mjs
   && node scripts/test-latency-metrics.mjs
   && node scripts/test-tz428-initial-sync-front-trim.mjs
   && node scripts/test-upsert-notify-append.mjs
   && node scripts/test-ingest-write-order.mjs
   && node scripts/test-message-update-semantics.mjs
```

Sıra kronolojiktir: 4.28 (tz428) → 5.3.7 (upsert-notify-append) → 5.3.8 (ingest-write-order)
→ 5.3.9 (message-update-semantics).

### 3.3 Zincir bütünlüğü (mekanik doğrulama)

| Kontrol | Sonuç |
| --- | --- |
| Halka sayısı | 36 → **40** |
| Yinelenen halka | **yok** |
| HEAD'in 36 halkası birebir ve aynı sırada mı | **evet** (`links[:36] == hlinks`) |
| Değişen tek anahtar | `scripts.test` (top-level `scripts` dışında fark yok) |
| `git diff --numstat` | `1 1` — tek satır, tek satırlık değişiklik |
| `package-lock.json` | **değişmedi** (`8e341a8d2961410d`, HEAD ile aynı) |

Script eklemek lockfile'ı etkilemez; ölçüldü, dokunulmadı.

---

## 4. GÖREV 3 — Backend zorunlu set

`backend/scripts/run_whatsapp_regression.py` → `MANDATORY_TESTS`, **8 → 10**:

```python
    "test_whatsapp_message_update_semantics.py",  # 5.3.9 replace semantiği (5.3.11'de eklendi)
    "test_whatsapp_session_delete_lifecycle.py",  # 5.3.9 oturum silme yaşam döngüsü (5.3.11'de eklendi)
```

`--list` çıktısı 10 dosyayı ve doğru sırayı veriyor. Girdiler **çıplak dosya adı**;
runner `backend/tests/` önekini kendisi ekliyor (mevcut sözleşme korundu).

**Neden bu iki test:** 5.3.9'un `replace` semantiği ve oturum silme yaşam döngüsü, 5.3.10'un
bulduğu `5.3.10-F1` kusurunun (kısmi `replace` payload'ının `created_at`'i silmesi) yaşadığı
iki sözleşme. Bu iki dosya sette olmadan, o kusurun geri gelmesi hiçbir otomatik koşuda
yakalanmazdı — 5.3.10 raporunun **R3** açık maddesi tam olarak buydu.

---

## 5. GÖREV 4 — Doğrulama koşuları

### 5.1 Gateway: `npm test` (tam zincir)

| Ölçüm | Değer |
| --- | --- |
| Çıkış kodu | **0** |
| Süre | 1 dk 35 sn |
| Log satırı | 461 |
| Toplam `PASS` / `ok -` satırı | **202** |
| `FAIL` / `Error` / `ERR_MODULE` / `npm ERR` | **0** |
| Zincirin bittiği betik | `test-message-update-semantics.mjs` → `All checks passed` |

**"Gerçekten koştu" kanıtı** — her yeni betiğin kendine özgü çıktı işareti logda **tam 1 kez**:

| Betik | İşaret | Adet |
| --- | --- | --- |
| `test-tz428-initial-sync-front-trim` | `Initial sync front-trim proof: PASS` | 1 |
| `test-upsert-notify-append` | `[test-upsert-notify-append] All checks passed` | 1 |
| `test-ingest-write-order` | `[test-ingest-write-order] …` | 2 (iki ayrı bölüm başlığı; betik 1 kez koştu) |
| `test-message-update-semantics` | `[test-message-update-semantics] …` | 2 (banner + kapanış) |

Yeşil çıkış kodu tek başına kanıt değildir; bu yüzden "koştu" iddiası çıktı işaretiyle
eşlendi. Çift koşu olmadığının mekanik kanıtı §3.3'teki yinelenen-halka kontrolü (0).

### 5.2 Altı gateway betiği — tek tek (kontrol sayıları)

Hepsi `whatsapp-gateway/` içinden `node scripts/<ad>.mjs` ile, zincirden bağımsız:

| Betik | rc | Kontrol |
| --- | --- | --- |
| `test-bulk-seq-pagination.mjs` | 0 | **8** |
| `test-bulk-seq-pagination-guarantees.mjs` | 0 | **32** |
| `test-tz428-initial-sync-front-trim.mjs` | 0 | **7** (`ok -` biçimi) |
| `test-upsert-notify-append.mjs` | 0 | **13** |
| `test-ingest-write-order.mjs` | 0 | **9** |
| `test-message-update-semantics.mjs` | 0 | **12** |
| **Toplam** | | **81** |

`test-tz428…` diğerlerinden farklı bir çıktı biçimi kullanıyor (`ok - …` + özet satırı
`PASS (N checks)`); `PASS` öneki arayan bir sayaç bu dosyada **0** verir. Bu yüzden sayım
biçime göre yapıldı — sayacın kendisi bir yanlış-negatif kaynağıydı.

### 5.3 Exit-code yayılımı — mutasyonla (dört yeni betik)

Her betiğin bir kopyası alındı, ilk gerçek assertion'ı ters çevrildi, koşuldu, silindi:

| Betik | Mutasyon | rc | Çıktı |
| --- | --- | --- | --- |
| `test-tz428…` | `assert.ok(` → `assert.ok(false && (` (satır 158, **yardımcı fonksiyon içi**) | **1** | yakalanmamış throw |
| `test-tz428…` (2.) | `assert.equal(page.total, 1)` → `99` (satır 295, **`check()` içi**) | **1** | `FAIL - D. …` + `check()` rethrow; özet satırı **basılmadı** (fail-fast) |
| `test-upsert-notify-append` | `assert.ok(e1, …)` → `assert.ok(false && …)` | **1** | `FAIL … message_new yayinlanmali` + `FAILED (1 assertion)` |
| `test-ingest-write-order` | `assert.equal(typeof …)` → `assert.notEqual(…)` | **1** | `FAIL … (_seq pozitif tamsayı)` |
| `test-message-update-semantics` | `assert.ok(rec, …)` → `assert.ok(false && …)` | **1** | `FAIL 1. content change …` + `FAILED (1 assertion)` |

Beş mutant, beş rc=1. Kopyalar silindi (`__mut*` kalıntısı yok).

### 5.4 Backend zorunlu set — gerçek koşu

```
uv run --offline --python 3.13 --with-requirements backend/requirements.txt \
    --with pytest --with pytest-asyncio python backend/scripts/run_whatsapp_regression.py
```

| # | Dosya | Sonuç |
| --- | --- | --- |
| 1 | `test_whatsapp_memory_persistence.py` | PASS · 10 |
| 2 | `test_whatsapp_memory_persistence_hardening.py` | PASS · 15 |
| 3 | `test_whatsapp_pagination_contract.py` | PASS · 10 |
| 4 | `test_whatsapp_sync_job.py` | PASS · 47 |
| 5 | `test_memory_persist_fail_closed.py` | PASS · 32 |
| 6 | `test_whatsapp_4_34_e2e_regressions.py` | PASS · 6 |
| 7 | `test_whatsapp_event_contract_parity.py` | PASS · 12 |
| 8 | `test_whatsapp_upsert_append.py` | PASS · 17 |
| 9 | **`test_whatsapp_message_update_semantics.py`** | **PASS · 9** |
| 10 | **`test_whatsapp_session_delete_lifecycle.py`** | **PASS · 6** |

**10/10 PASS · exit 0 · 164 test · 40 sn.** 9 ve 10 numaralı satırlar bu aşamada eklendi ve
**runner üzerinden** koştu — dosyalar tek başına değil, zorunlu setin parçası olarak.

### 5.5 Runner davranış probları

Gerçek runner'a dokunmamak için `backend/scripts/__tmp_runner_probe.py` kopyası üretildi,
`MANDATORY_TESTS` değiştirildi, koşuldu, silindi.

**Probe A — zorunlu dosya yok (PASS sayılmamalı):**

```
PASS  test_whatsapp_upsert_append.py           (exit=0)  17 passed
FAIL  test_zzz_does_not_exist.py               (exit=4)
PASS  test_whatsapp_event_contract_parity.py   (exit=0)  12 passed
1 dosya BAŞARISIZ, 2 geçti.        rc = 1
```

Eksik dosya `exit=4` ile **FAIL** olarak raporlandı, PASS'a düşmedi; koşu durmadı.

**Probe B — ortada düşen test (ilk hatada duruyor mu):**

```
PASS  test_whatsapp_upsert_append.py           (exit=0)  17 passed
FAIL  test___tmp_always_fail.py                (exit=1)  1 failed
PASS  test_whatsapp_event_contract_parity.py   (exit=0)  12 passed
1 dosya BAŞARISIZ, 2 geçti.        rc = 1
```

Durmuyor, devam ediyor (B3), ama çıkış kodu 1. Üçüncü dosya gerçekten koştu.

**Probe C — dosya başına taze DB (`--keep-db`):**

```
test_whatsapp_pagination_contract.db            954368 B
test_whatsapp_session_delete_lifecycle.db       954368 B
test_whatsapp_upsert_append.db                  954368 B
```

Üç ayrı yol, üç ayrı dosya. (Aynı boyut beklenen: şema aynı `provision_test_db.py` ile
üretiliyor; ayrı olan **yol** ve dolayısıyla **veri**.)

**Probe D — uzak DB fail-closed:**

```
rc = 2
RED: TEZLIFY_TEST_DB_REMOTE_OK=1 ayarlı. Bu betik uzak bir DB'ye karşı koşmayı kabul etmez…
```

Hiçbir test koşmadı, hiçbir DB açılmadı. `TEZLIFY_TEST_DB_REMOTE_OK` her alt süreçte
`env.pop` ile siliniyor (`run_whatsapp_regression.py:100`).

**Sessiz atlama yok:** her probda özet sayısı `len(MANDATORY_TESTS)`'e eşit
(3/3, 3/3) ve gerçek koşuda `Tümü geçti (10/10)`.

### 5.6 Frontend

| Komut | Sonuç |
| --- | --- |
| `node scripts/verify-conversation-replace-semantics.mjs` | **12/12** · rc=0 |
| `node scripts/verify-session-deleted-multitab.mjs` | **8/8** · rc=0 |
| `npm run build` (= `tsc && vite build`) | **rc=0** · `✓ built in 9.35s` |
| `npx tsc -b` (ayrıca) | **rc=0** |

`npm run build` zaten `tsc` ile başlıyor; tip denetimi build'in içinde geçti, ayrıca
bağımsız olarak da doğrulandı. Üretim kodunda değişiklik yok (§6).

---

## 6. GÖREV 5 — Değişmezlik kanıtı

Worktree temiz olmadığı için "üretim kodu değişmedi" üç ayrı ölçümle gösterildi.

### 6.1 Üretim dosyalarının hash'i — başlangıç = bitiş

| Dosya | Başlangıç (5.3.11) | Bitiş | |
| --- | --- | --- | --- |
| `backend/…/orchestration/events.py` | `880162745b60e747` | `880162745b60e747` | aynı |
| `backend/…/orchestration/sessions.py` | `bc5c6610a42a3ca1` | `bc5c6610a42a3ca1` | aynı |
| `frontend/…/useWhatsAppConversation.ts` | `15e8c8f770f20629` | `15e8c8f770f20629` | aynı |
| `whatsapp-gateway/src/session-manager.js` | `27a3c80e76d25eab` | `27a3c80e76d25eab` | aynı |
| `whatsapp-gateway/src/socket/socket-events.js` | `a2f7281ffee20892` | `a2f7281ffee20892` | aynı |

### 6.2 Diff kapsamı — aritmetik olarak

```
6 files changed, 120 insertions(+), 24 deletions(-)
whatsapp-gateway/package.json   1  1
```

`120 − 1 = 119` · `24 − 1 = 23` → geriye kalan beş dosya, 5.3.10'un kaydettiği
**+119 / −23** ile **tam olarak** aynı. Yani bu aşamanın üretim dosyalarına katkısı sıfır.

### 6.3 Runner değişikliği — bayt-bayt cerrahi

5.3.10 raporu kurtarılan runner'ı `164 satır / 6.077 B / a81270ab0fb33aa2…` olarak kaydetmişti.
Eklenen **iki satır** çıkarılıp geri kalan yeniden hash'lendi:

```
removed lines: 2
recon size : 6077 B   (beklenen 6077)
recon lines: 164      (beklenen 164)
recon sha256: a81270ab0fb33aa2  (beklenen a81270ab0fb33aa2)
```

**Birebir eşleşme.** Yani runner'daki değişiklik *tam olarak* iki satır eklemekten ibaret;
başka hiçbir bayt değişmedi. (Şu an: 166 satır / 6.283 B.)

### 6.4 Depo durumu

| Ölçüm | Başlangıç | Bitiş |
| --- | --- | --- |
| HEAD | `3ac26a9` | **`3ac26a9`** |
| Staged | 0 | **0** |
| Modified | 5 | **6** (+`package.json`) |
| Untracked | 13 | **14** (13'ü aynı küme + bu rapor) |
| `git status` satırı | 18 | **20** |
| `main` HEAD | `e7f1077` | **`e7f1077`** |
| `main` dirty | 87 | **87** |

18 → 20 farkının tamamı iki kalemdir: `whatsapp-gateway/package.json` modified oldu (+1) ve
bu rapor untracked olarak eklendi (+1). Test dosyası kümesi değişmedi; **yeni test dosyası
eklenmedi**.

### 6.5 Kilit dosyaları

| Dosya | Durum |
| --- | --- |
| `whatsapp-gateway/package-lock.json` | **değişmedi** (`8e341a8d2961410d`) |
| `package.json` (kök) | değişmedi (`80ba3aed3fa121f6`) |
| `frontend/package.json` | değişmedi (`14c86656674aa7ff`) |
| `whatsapp-gateway/package.json` | **değişti** — amaçlanan tek manifest değişikliği |

### 6.6 Statik kapılar

| Kapı | Sonuç |
| --- | --- |
| `git diff --check` | temiz |
| `python3 -m py_compile backend/scripts/run_whatsapp_regression.py` | ok |
| `node -e JSON.parse(whatsapp-gateway/package.json)` | ok |
| `npx tsc -b` | rc=0 |
| `npm run build` | rc=0 |

### 6.7 Kalıntı temizliği

| Kalıntı | Durum |
| --- | --- |
| `node_modules` × 3 symlink (worktree kökü / gateway / frontend) | **silindi**; üç gerçek hedef dizin de sağlam doğrulandı |
| `backend/scripts/__pycache__` | silindi (`py_compile` üretti) |
| `backend/tests/__pycache__` | silindi (5.3.10'dan kalma) |
| `backend/scripts/__tmp_runner_probe.py` | silindi |
| `whatsapp-gateway/scripts/__mut*.mjs` (5 adet) | silindi |
| `backend/tests/test___tmp_always_fail.py` | silindi |
| `frontend/dist` | bırakıldı — `npm run build` çıktısı, `.gitignore:31` ile ignore |

Not: release worktree'sinde `node_modules` yok; üç symlink 5.3.10'da olduğu gibi geçici olarak
kuruldu ve aşama sonunda kaldırıldı. Bu bir ortam artefaktıdır, depo değişikliği değildir.

---

## 7. Değişen dosya listesi

**Bu aşamada değişen (2):**

| Dosya | Değişiklik |
| --- | --- |
| `whatsapp-gateway/package.json` | `scripts.test` 36 → 40 halka (+1/−1 satır) |
| `backend/scripts/run_whatsapp_regression.py` | `MANDATORY_TESTS` 8 → 10 (+2 satır, bayt-bayt kanıtlı) |

**Bu aşamada üretilen (1):**

| Dosya | Not |
| --- | --- |
| `docs/audits/ASAMA-5.3.11-regression-chain-integration.md` | bu rapor |

**Devralınan, dokunulmayan (5 modified + 12 untracked):** 5.3.9/5.3.10'un üretim diff'leri
(§6.1 hash'leri sabit) ve test dosyaları.

---

## 8. Açık maddeler

| # | Konu | Durum |
| --- | --- | --- |
| **R1** | Kurtarılan/üretilen 7 test dosyası hâlâ **untracked** — worktree yeniden kurulursa kaybolurlar | Açık; commit onayı bekliyor |
| **R2** | `frontend/scripts/verify-*.mjs` betiklerinin hiçbiri bir `npm` zincirine bağlı değil; `verify-conversation-replace-semantics` ve `verify-session-deleted-multitab` da hâlâ **elle** koşuluyor | **Bu aşamanın kapsamı dışı** (spec yalnızca gateway zinciri + backend runner'ı yetkilendirdi) |
| **R3** | 7 frontend betiği önceden kırmızı (`Avatar.tsx` / `ChatBubble.tsx` — 5.3.10'da HEAD'e karşı kanıtlandı) | Değişmedi, bu aşamanın konusu değil |
| **R4** | `whatsapp-gateway/package.json` değişikliği commit edilene kadar release dalında **uncommitted** | Onay bekliyor |
| **R5** | 4.34 canlı E2E kabulü hâlâ koşulmadı; persistence döngüsü kapalı | 5.3.10'dan devir |

`R2` bilinçli olarak yapılmadı: spec §5 "yalnızca gateway `package.json` ve backend regression
runner değişebilir" diyor. Frontend betiklerini bir zincire bağlamak üçüncü bir dosya
(`frontend/package.json`) değiştirmek olurdu.

---

## 9. PASS kriterleri

| # | Kriter | Sonuç | Kanıt |
| --- | --- | --- | --- |
| 1 | Altı gateway testi `npm test` üzerinden otomatik çalışıyor | **PASS** | 36→40 halka; `npm test` rc=0; dört yeni betiğin çıktı işareti logda 1 kez (§5.1) |
| 2 | Mevcut halkalar silinmedi / gereksiz yeniden sıralanmadı / çift koşu yok | **PASS** | `links[:36] == HEAD links`; yinelenen 0 (§3.3) |
| 3 | Bir test düşerse zincir düşüyor, exit code doğru yayılıyor | **PASS** | 5 mutant → 5 × rc=1 (§5.3); `npm test` rc=0 yeşil (§5.1) |
| 4 | İki yeni backend testi `MANDATORY_TESTS` içinde ve runner üzerinden koşuyor | **PASS** | 10/10 PASS, 164 test, exit 0; 9 ve 10. satırlar (§5.4) |
| 5 | Taze DB / fail-closed / sessiz atlama yok / eksik dosya PASS değil | **PASS** | Probe A–D (§5.5) |
| 6 | Frontend: üretim kodu değişmedi, iki betik yeşil, build geçiyor | **PASS** | 12/12 + 8/8 + build rc=0 (§5.6); hash sabit (§6.1) |
| 7 | Üretim kaynak dosyalarında diff yok; yalnızca 2 dosya değişti | **PASS** | 5 hash aynı; 120/24 − 1/1 = 119/23; runner bayt-bayt (§6.1–6.3) |
| 8 | Rapor yazıldı, HEAD/main değişmedi, kalıntı yok | **PASS** | Bu dosya; `3ac26a9`/`e7f1077`/87 (§6.4); temizlik (§6.7) |

**8/8 PASS.**

---

## 10. Kapanış

Bu aşamanın PASS olması **commit izni değildir**.

- Stage yapılmadı (`git add` çalıştırılmadı; staged = 0).
- Commit yapılmadı.
- Push yapılmadı.
- Deploy yapılmadı.

Değişiklikler `release/backend-only-seq-safety` üzerinde **uncommitted** olarak duruyor.
Ayrı kullanıcı onayı bekleniyor.

Onay verilirse commit kapsamı: `whatsapp-gateway/package.json`,
`backend/scripts/run_whatsapp_regression.py`, bu rapor — ve `R1` kapsamında hâlâ untracked
olan 7 test dosyası. `.workbuddy-ai/memory/*` tracked ve kirli; `git add -A` kullanılmamalı,
açık dosya listesiyle stage edilmeli.
