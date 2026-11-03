# AŞAMA 4.12 — 11 DOSYALI RELEASE ADAYI SON SABİTLEME VE COMMIT ONAY KAPISI

**Tarih:** 2026-10-31 (Europe/Istanbul)
**Kapsam:** B kararı verilen 11 dosyalı adayın son doğrulaması, manifestin kesinleştirilmesi,
commit onay paketinin hazırlanması.
**Nihai verdict:** **`READY FOR EXPLICIT COMMIT APPROVAL`**
**Üretim yetki durumu:** `NOT AUTHORIZED — NO COMMIT / NO PUSH / NO DEPLOY`

---

## 1. Yetki sınırları ve yapılmayanlar

| Kısıt | Durum |
| --- | --- |
| `git commit` | **YAPILMADI** (guard için yalnızca geçici ref nesnesi — §6.3) |
| `git push` | **YAPILMADI** |
| Deploy / release scripti | **YAPILMADI** — yalnızca guard'ın ürettiği metin raporlandı |
| Container restart/recreate | **YAPILMADI** |
| Üretim DB yazımı | **YAPILMADI** |
| Gateway değişikliği | **YAPILMADI** — 5/5 byte-identical |
| Persistence loop | **ETKİNLEŞTİRİLMEDİ** |
| `17ccbc9` amend/reset | **YAPILMADI** |
| `git add -A` / `clean` / `reset --hard` / `stash` | **KULLANILMADI** |
| Kullanıcı çalışma ağacı | **DEĞİŞTİRİLMEDİ** — HEAD `7afb540`, staged 0 |

Çalışma alanı: `/tmp/tz411-candB` (izole, detached `17ccbc9`) ve `/tmp/tz410-release` (Aday A).

---

## 2. Mevcut durumun sabitlenmesi (aşama başı ve sonu)

| Öğe | Beklenen | Ölçülen (baş) | Ölçülen (son) |
| --- | --- | --- | --- |
| Dal | `release/backend-only-4.7` | ✓ | ✓ |
| Commit | `17ccbc91843490f7c256b1324e22d11e0a02ac3f` | ✓ | ✓ |
| Parent | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` | ✓ | ✓ |
| Aday A | 10 dosya, +1785 / −61 | ✓ | ✓ |
| Aday A gateway farkı | 0 | ✓ | ✓ |
| Kullanıcı ağacı HEAD | `7afb540` | ✓ | ✓ |
| Kullanıcı ağacı staged | 0 | ✓ | ✓ |

Beklenen değerlerin **hepsi** tuttu; durma koşulu oluşmadı.

---

## 3. v2 tek kaynak — ve v1'in karantinası

| Dosya | SHA256 | Beklenen | Sonuç |
| --- | --- | --- | --- |
| `scripts/prepared_tests/ASAMA-4.11-candidate-B/test_whatsapp_message_insert_isolation.py` (**v2**) | `ec7fed85963dba90d59d9ba8944764961d158eee880bed8eae5f08a269036e96` | aynı | **EŞLEŞTİ** |
| `/tmp/tz411-candB/backend/tests/test_whatsapp_message_insert_isolation.py` | `ec7fed85963dba90d59d9ba8944764961d158eee880bed8eae5f08a269036e96` | aynı | **EŞLEŞTİ** |
| `scripts/prepared_tests/test_whatsapp_message_insert_isolation.py` (**v1**) | `b74df9ff4dfbc192c23b73bd286580332e1a01bf185b2f1cd8b0eca17e231f27` | aynı | **dokunulmadı** |

v1 **silinmedi, değiştirilmedi** — yalnızca release'e alınmadı. Aday B worktree'sindeki dosya v2'dir;
v1 hiçbir aday ağacında bulunmuyor. (v1 PostgreSQL 17'de 2/5 kırmızıydı; bkz. 4.11 raporu §3.3.)

---

## 4. 11 dosyalık nihai manifest

Her satır: **kaynak SHA256** (Aday A'daki dosya) · **aday SHA256** (Aday B'deki dosya) · **git blob
(SHA1)** · **tür**. İlk 10 satırda A = B birebir.

| # | Dosya | Kaynak SHA256 | Aday SHA256 | Blob (SHA1, 12) | Tür |
| --- | --- | --- | --- | --- | --- |
| 1 | `backend/app/main.py` | `afdacc403411` | `afdacc403411` | `bbd99ca0b283` | modified |
| 2 | `backend/app/services/whatsapp/memory_persistence.py` | `070fda0397f7` | `070fda0397f7` | `e12c030bd239` | modified |
| 3 | `backend/app/services/whatsapp/orchestration/sync.py` | `edb7e9d2921c` | `edb7e9d2921c` | `213f736e976f` | modified |
| 4 | `backend/app/services/whatsapp_gateway.py` | `2e78ab7d6d6b` | `2e78ab7d6d6b` | `2f44be2058c2` | modified |
| 5 | `backend/tests/test_whatsapp_memory_persistence.py` | `d7bdaac5da93` | `d7bdaac5da93` | `db60486e05f3` | modified |
| 6 | `backend/tests/test_whatsapp_memory_persistence_hardening.py` | `ff008fcefc10` | `ff008fcefc10` | `4b6314a3f762` | modified |
| 7 | `backend/tests/test_whatsapp_pagination_contract.py` | `bc78bdae69d3` | `bc78bdae69d3` | `bab8dec13bde` | modified |
| 8 | `scripts/pg_audit_tests/test_tz44_missing.py` | `bd06f126e336` | `bd06f126e336` | `2848509a18a8` | modified |
| 9 | `scripts/pg_audit_tests/test_tz46_audit.py` | `0df3905f7f04` | `0df3905f7f04` | `29e189c3bf47` | modified |
| 10 | `scripts/pg_audit_tests/tz44_pgplugin.py` | `3db40aec8b48` | `3db40aec8b48` | `e1dccfeeb3bf` | modified |
| 11 | `backend/tests/test_whatsapp_message_insert_isolation.py` | — (yok) | `ec7fed85963d` | `36be99017306` | **added** |

> `sync.py`'nin SHA256'sı `edb7e9d2921c…`: 4.11'deki üç mutasyon denemesi sonrası birebir geri yüklendiği
> doğrulandı (mutasyon kalıntısı **yok**).

### 4.1 Dışlama kontrolleri

| Kontrol | Beklenen | Ölçülen |
| --- | --- | --- |
| `backend/app/**` Aday A'ya göre **yeni** fark | 0 | **0** |
| `whatsapp-gateway/**` farkı | 0 | **0** |
| `frontend/**` farkı | 0 | **0** |
| `escrow` içeren dosya | 0 | **0** |
| `docs/**` manifest'te | 0 | **0** |
| `.workbuddy-ai/memory/**` manifest'te | 0 | **0** |
| Lockfile değişikliği | 0 | **0** (`package-lock.json` blob `2ec913a07a3b`, taban = aday) |
| Manifest dışı dosya | 0 | **0** (`git status` tek satır: yalnızca #11) |

Manifest toplamı: **11 dosya** — `backend/` 7 + `scripts/pg_audit_tests/` 3 + yeni test 1.

---

## 5. Test kapıları (yeniden koşuldu)

### 5.1 PostgreSQL 17.11 — üretim diyalekti

PG komutu `-p tz44_pgplugin` ile koşuldu (asyncpg pool/event-loop uyuşmazlığını önleyen harness eklentisi).
Sürüm: test örneği **17.11**, üretim **17.11** (`show server_version`).

| Parti | Sonuç |
| --- | --- |
| L-C1 (`test_whatsapp_message_insert_isolation.py`) | **5 passed** |
| persistence (`test_whatsapp_memory_persistence.py`) | **10 passed** |
| hardening (`…_hardening.py`) | **15 passed** |
| pagination contract | **9 passed** |
| tz44 audit | **8 passed** |
| tz46 audit | **10 passed** |
| **Birleşik parti** | **57 passed** (beklenen 57) |

### 5.2 Tam backend suite (SQLite)

| Ölçüm | Değer |
| --- | --- |
| Toplanan | **2070** |
| Sonuç | **2065 passed / 1 failed / 4 skipped** |
| Exit | 1 |

Beklenen değerlerle **birebir** (4.11'deki 2065/1/4 ile aynı). Önceki kırmızı:

```
FAILED backend/tests/test_admin_ops_security.py::test_http_probe_distinguishes_unreachable_from_unhealthy
```

**Tabandan gelen kırmızı** (4.10'da `cbe4f509` üzerinde ayrı worktree'de koşularak kanıtlandı; test
`str(Optional[bool])` içinde `"None"` arıyor, ürün doğru). **Kapsam dışı — düzeltilmedi.**

### 5.3 Diğer kapılar

| Kapı | Sonuç |
| --- | --- |
| `compileall backend/app backend/tests scripts/pg_audit_tests` | **EXIT 0** |
| Import (5 modül: `main`, `memory_persistence`, `orchestration.sync`, `whatsapp_gateway`, `core.migrations`) | **5/5 OK** |
| Secret taraması — 10 dosyalık diff (+1795 satır) | **0 eşleşme** |
| Secret taraması — yeni test dosyası | **0 eşleşme** |
| PII taraması — yeni test dosyası | 1 eşleşme: `+905551112233` (**uydurma** placeholder, 555-111-22-33) |
| Yeni dosyada `logger.*` çağrısı | **0** (log üzerinden PII sızma yüzeyi yok) |
| Gateway byte-identity | **5/5 IDENTICAL** |

Gateway blob kimlikleri (taban = aday):

| Dosya | Blob |
| --- | --- |
| `whatsapp-gateway/package.json` | `588c92f03494` |
| `whatsapp-gateway/src/index.js` | `c492617df92b` |
| `whatsapp-gateway/Dockerfile` | `1940cef6e0f9` |
| `whatsapp-gateway/package-lock.json` | `2ec913a07a3b` |
| `whatsapp-gateway/README.md` | `068254960508` |

---

## 6. Guard son kontrolü

### 6.1 Dört koşu — gerçek exit code'lar (pipe kullanılmadı)

| Koşu | `--target` | `--backend-from` | **exit** | gateway/compose | backend vs main | backend vs base |
| --- | --- | --- | --- | --- | --- | --- |
| A-self | `17ccbc9` | `17ccbc9` | **0** | 0 | 0 | 7 |
| A-main | `17ccbc9` | `origin/main` | **1** | 0 | 9 | 7 |
| B-self | `refs/tz412/candidate-b` | kendisi | **0** | 0 | 0 | **8** |
| B-main | `refs/tz412/candidate-b` | `origin/main` | **1** | 0 | **10** | **8** |

- **Aday B backend vs base = 8** ✓ (7 backend dosyası + yeni test).
- **Aday B backend vs main = 10** ✓ (A'nın 9'u + yeni test). Değişmedi.
- `--no-gateway` muhafızı: iki adayda da **geçiyor** (gateway/compose 0).
- `--expected-self-blob`: iki adayda da `9284245fa56c8e66c881aa8a0e9b6fd430e391c8`.
- `run_release.sh` = `9284245fa56c` ✓ · `host-release.sh` = `f2b7a9aeb5c4` ✓ (taban ve hedefte **aynı**).

> Not: `IHLAL` satırı dosya listesini **8 adla sınırlıyor** (`", ".join(...[:8])`,
> `backend_only_release.py:103`); sayı (`len()`) otoritedir. "10 dosya farkli" doğru, listede 8 ad görünür.

Guard'ın ürettiği komut (**ÇALIŞTIRILMADI**):

```
bash scripts/deploy/run_release.sh \
  --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
  <yeni-commit> --no-gateway --health-timeout 180
```

### 6.2 Değişmezlik

`git show-ref | grep tz412` → **0**. Branch, tag ve remote ref **oluşturulmadı/değiştirilmedi**.

### 6.3 Geçici ref beyanı

Guard `^{commit}` istediği için, **yalnızca izole worktree'de**, geçici index ile:

```
GIT_INDEX_FILE=/tmp/tz412_candB.idx
git read-tree 17ccbc9 ; git add <test dosyası> ; git write-tree
  -> tree 4a2c37de85f8c981ef5659299d993a7081cedbbe   (4.11 ile aynı ağaç)
git commit-tree <tree> -p 17ccbc9
  -> 0a81e65e8fe3778f3001cb9af66739d0cc05bde6
git update-ref refs/tz412/candidate-b <commit>  ... koşular ...  git update-ref -d
```

Ağacın 4.11'dekiyle **aynı** olması (4a2c37de…), aday içeriğinin iki aşamada değişmediğinin bağımsız kanıtıdır.
Geriye yalnızca dangling commit nesnesi kaldı; hiçbir branch/tag/remote etkilenmedi.

---

## 7. Release riskleri — sınıflandırma (hiçbiri kapatılmadı)

| # | Risk | Durum | Kapatma koşulu |
| --- | --- | --- | --- |
| 1 | **P0-1 front-trim** | **AÇIK** | Backend-only release bunu çözmez; yayındaki gateway `afterSeq` okumuyor (`index.js:563`). Gateway + backend birlikte yenilenmeli. |
| 2 | **RAM_ONLY** | **AÇIK** | Deploy anında yeniden ölçülmeli; 4.9'un `RAM_ONLY = 0` değeri taşınamaz. |
| 3 | **Snapshot** | **AÇIK** | Gateway recreate'ten önce taze + `remote_verified: true` snapshot zorunlu (RAM'in tek yedeği). |
| 4 | **Persistence loop** | **AÇIK / KAPALI TUTULMALI** | Deploy sırasında etkinleştirilmemeli; kill-switch yalnızca `true`/`1` ile açılır. |
| 5 | **`http_probe` testi** | **AÇIK (tabandan)** | Ayrı test commit'i; 4.7/4.12 kapsamı dışı. |
| 6 | **Rollback** | **AÇIK** | `--rollback-to` gateway'i de recreate eder (RAM kaybı). Backend-only yol ayrı tutulmalı: `docker tag tezlify-backend:pre-<TS> latest && docker compose up -d --no-deps backend`. |
| 7 | **LID (K-7)** | **KAPALI DEĞİL — izlenen** | 4.11 kararı: kusur yok; 4.7 LID bloğunu değiştirmiyor; rezidüel `dup_jid = 0`, `conv_null_session = 0`. |
| 8 | **L-C1** | **ÇÖZÜM HAZIR** | v2 (`ec7fed85…`) release kapsamına alınmalı; alınmadan kapanmış sayılmaz. |

---

## 8. Commit onay paketi

### 8.1 Önerilen commit mesajı

```
test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction
```

Alternatif (daha kısa): `test(whatsapp): cover poison-row savepoint isolation` — kabul edilebilir, ancak
kısıt-adı çıkarımını (8 numaralı davranış) kapsamaz.

### 8.2 Commit'e girecek tam 11 dosya

```
backend/app/main.py
backend/app/services/whatsapp/memory_persistence.py
backend/app/services/whatsapp/orchestration/sync.py
backend/app/services/whatsapp_gateway.py
backend/tests/test_whatsapp_memory_persistence.py
backend/tests/test_whatsapp_memory_persistence_hardening.py
backend/tests/test_whatsapp_message_insert_isolation.py      <-- YENİ
backend/tests/test_whatsapp_pagination_contract.py
scripts/pg_audit_tests/test_tz44_missing.py
scripts/pg_audit_tests/test_tz46_audit.py
scripts/pg_audit_tests/tz44_pgplugin.py
```

`git add -A` **kullanılmamalı**: `.workbuddy-ai/memory/*` ve `docs/**` takip edilen/untracked kirli
dosyalar arasında; yukarıdaki açık liste stage edilmeli.

### 8.3 Beklenen toplam diff

| Bileşen | Değer |
| --- | --- |
| Mevcut 10 dosya | +1785 / −61 |
| Yeni test dosyası | +253 / −0 (253 satır, 9 737 B) |
| **Toplam** | **11 dosya, +2038 / −61** |

### 8.4 Aday B'nin son test sonuçları

- PostgreSQL 17.11: **57 passed** (L-C1 5 · persistence 10 · hardening 15 · pagination 9 · tz44 8 · tz46 10)
- Tam suite: **2070 toplanan → 2065 passed / 1 failed / 4 skipped** (kırmızı tabandan)

### 8.5 Guard sonuçları

B-self **exit 0**, gateway 0, vs base 8 · A-self **exit 0** · iki `--main` koşusu **exit 1** (beklenen:
`main` 4.7'yi taşımıyor) · `--expected-self-blob 9284245f` ✓.

### 8.6 Commit öncesi / sonrası beklenen kontroller

**Önce:**
1. `git status` → yalnızca 11. dosya untracked; başka değişiklik yok.
2. v2 SHA256 = `ec7fed85…`.
3. `git rev-parse HEAD` = `17ccbc9…` (amend edilmeyecek).

**Sonra:**
4. `git rev-parse HEAD^` = `17ccbc91843490f7c256b1324e22d11e0a02ac3f` (geçmiş korunmuş).
5. `git diff --shortstat cbe4f509 HEAD` = **11 files, +2038/−61**.
6. `backend_only_release.py --base cbe4f509 --target HEAD --backend-from HEAD` → **exit 0**, vs base **8**.
7. `git diff --name-only cbe4f509 HEAD -- whatsapp-gateway/` → **0**.
8. Tam suite **2070** ve PG partisi **57** yeniden koşmalı (commit sonrası ağaç aynı olsa da kanıt tazelenir).

### 8.7 Commit oluşturulursa değişecek Git nesneleri

| Nesne | Değişim |
| --- | --- |
| Yeni blob | `36be990173065820fde00f051d64e3f87d6db611` (test dosyası) |
| Yeni tree'ler | `backend/tests/`, `backend/`, kök ağaç |
| Yeni commit | parent = `17ccbc91843490f7c256b1324e22d11e0a02ac3f` |
| `release/backend-only-4.7` | pointer `17ccbc9` → yeni commit (geçmiş **yeniden yazılmaz**) |

### 8.8 Değişmeyecek ref'ler

| Ref / nesne | Değer |
| --- | --- |
| `cbe4f509` (yayındaki backend) | **değişmez** |
| `origin/main` / yerel `main` | `7afb540` — **değişmez** |
| `origin/release/backend-only-3.8.7` | **değişmez** |
| `/opt/tezlify/.deployed-commit` | `cbe4f509…` — **değişmez** (deploy yapılmıyor) |
| Gateway imajı / container | **değişmez** |

### 8.9 Onay gerekliliği

**Commit oluşturmak için kullanıcıdan açık onay gerekir.** Bu aşamada commit atılmadı; yalnızca yukarıdaki
paket hazırlandı. Onay verilse bile bu **deploy onayı değildir** — deploy ayrı bir karardır ve §7'deki
açık risklerin (özellikle RAM_ONLY ve snapshot) deploy anında kapatılmasını gerektirir.

---

## 9. Tamamlama kriterleri

| Kriter | Durum |
| --- | --- |
| 11 dosyalı manifest kesin | ✅ (11; dışlama kontrolleri 0) |
| v2 SHA256 eşleşiyor | ✅ `ec7fed85…` |
| PostgreSQL 17.11 birleşik testler | ✅ 57 passed |
| Tam suite yeniden ölçüldü | ✅ 2070 → 2065/1/4 |
| Gateway byte-identity korunmuş | ✅ 5/5 |
| Guard sonuçları doğrulanmış | ✅ A-self 0, B-self 0 (base 8), main 1/1 |
| Orijinal `17ccbc9` değişmemiş | ✅ |
| Kullanıcı çalışma ağacı korunmuş | ✅ `7afb540`, staged 0 |
| Commit / push / deploy yapılmamış | ✅ |

---

## 10. VERDICT

```
READY FOR EXPLICIT COMMIT APPROVAL
ÜRETİM: NOT AUTHORIZED — NO COMMIT / NO PUSH / NO DEPLOY
```

Aday B (11 dosya, v2 testi ile) commit için **teknik olarak hazır**: manifest kesin, testler üretim
diyalektinde yeşil, guard geçiyor, gateway dokunulmamış, üretim kodu farkı yalnızca 4.7 kapsamı.

**Commit için açık onay bekleniyor.** Onay verilene kadar hiçbir Git nesnesi kalıcı olarak değişmez.
