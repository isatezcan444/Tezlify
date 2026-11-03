# Aşama 4.22 — Backend 4.7 Push Approval Gate

**Tarih:** 2026-11-01 00:25 +0300
**Mod:** SALT-OKUNUR Git / release güvenlik denetimi. Push YOK, fetch YOK, deploy YOK, commit YOK, dosya değişikliği YOK.
**Sonuç:** ✅ **READY FOR EXPLICIT BACKEND PUSH APPROVAL**

> **Not (§6 sınırı):** Bu aşamada production'a **bağlanılmadı**. Production maddeleri son doğrulanmış
> kayıtlardan raporlanıyor; bu oturumda yeniden ölçülemeyenler açıkça **"bu aşamada doğrulanamadı"**
> olarak işaretlendi. Uydurma yok.

---

## 1. Candidate Kimliği

| Alan | Beklenen | Gerçek | Sonuç |
| --- | --- | --- | --- |
| Aktif worktree (gerçek yol) | — | `/private/tmp/tz410-release` | kayıt |
| Branch | `release/backend-only-4.7` | `release/backend-only-4.7` | **PASS** |
| HEAD SHA | `2236caebd4281b108b835f16f4c80d3d2e2f1d05` | `2236caebd4281b108b835f16f4c80d3d2e2f1d05` | **PASS** |
| Parent SHA | `17ccbc91843490f7c256b1324e22d11e0a02ac3f` | `17ccbc91843490f7c256b1324e22d11e0a02ac3f` | **PASS** |
| Tree SHA | `4a2c37de85f8c981ef5659299d993a7081cedbbe` | `4a2c37de85f8c981ef5659299d993a7081cedbbe` | **PASS** |
| Commit mesajı | — | `test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction` | kayıt |
| Commit tarihi | — | `2026-10-31 12:04:57 +0300` | kayıt |

**4.21 raporuyla birebir eşleşiyor.** Tek karakter farkı yok → DUR koşulu tetiklenmedi.

---

## 2. Worktree Temizliği

```
git status --short          →  (0 satır)
staged değişiklik           →  0
unstaged değişiklik         →  0
untracked dosya             →  0
```

`/private/tmp/tz410-release` **tamamen temiz**. Bu worktree'de `node_modules` symlink'i de yok —
dolayısıyla 4.16'da bulunan symlink tuzağı bu push için geçerli değil (push zaten çalışma ağacını
değil, ref'i gönderir; yine de kirlilik yok).

---

## 3. Release Kapsamı — `cbe4f509` → `2236cae`

```
git diff --stat cbe4f509f4bcc5babb12cc85e0ad422cb13ba739 HEAD

 backend/app/main.py                                |   2 +
 .../app/services/whatsapp/memory_persistence.py    | 241 +++++++--
 .../app/services/whatsapp/orchestration/sync.py    | 144 +++++-
 backend/app/services/whatsapp_gateway.py           |  11 +
 backend/tests/test_whatsapp_memory_persistence.py  |   2 +-
 .../test_whatsapp_memory_persistence_hardening.py  |   8 +-
 .../test_whatsapp_message_insert_isolation.py      | 253 ++++++++++
 backend/tests/test_whatsapp_pagination_contract.py | 545 +++++++++++++++++++++
 scripts/pg_audit_tests/test_tz44_missing.py        | 415 ++++++++++++++++
 scripts/pg_audit_tests/test_tz46_audit.py          | 440 +++++++++++++++++
 scripts/pg_audit_tests/tz44_pgplugin.py            |  38 ++
 11 files changed, 2038 insertions(+), 61 deletions(-)
```

| Ölçüm | Beklenen | Gerçek | Sonuç |
| --- | --- | --- | --- |
| Dosya sayısı | 11 | **11** | **PASS** |
| Satır | +2038 / −61 | **+2038 / −61** | **PASS** |
| `backend/` dosyası | 8 | **8** | **PASS** |
| `scripts/pg_audit_tests/` dosyası | 3 | **3** | **PASS** |
| `whatsapp-gateway/` dosyası | 0 | **0** | **PASS** |

**PUSH KAPSAMI: 11 DOSYA.** (8 backend + 3 denetim harness'ı; gateway dosyası yok.)

### Kapsamdaki 3 denetim dosyası — doğrulandı, dokunulmadı

| Dosya | Satır | Rolü |
| --- | --- | --- |
| `scripts/pg_audit_tests/test_tz44_missing.py` | +415 | Aşama 4.4 drain senaryoları (atılabilir PG kümesi) |
| `scripts/pg_audit_tests/test_tz46_audit.py` | +440 | Aşama 4.6 audit senaryoları (atılabilir PG kümesi) |
| `scripts/pg_audit_tests/tz44_pgplugin.py` | +38 | Test-only harness shim |

Üçü de **silinmedi, taşınmadı, stage edilmedi, değiştirilmedi**. `git status` 0 satır bunu doğruluyor.

**Etki (4.21'de ölçüldü, değişmedi):** `backend/Dockerfile` yalnız `backend/requirements.txt`,
`backend/`, `start.py` kopyalıyor → bu 3 dosya **imaja girmiyor**. `scripts/deploy/host-release.sh`
içinde `pytest` çağrısı yok → release kapısını kıramazlar. Runtime/deploy riski **yok**.

---

## 4. Remote Durumu (fetch yapılmadı)

```
git ls-remote --heads origin release/backend-only-4.7   →  (boş çıktı, rc=0)
```

**Remote'da `release/backend-only-4.7` YOK** → push yeni branch oluşturacak.

| Ref | SHA | Kaynak |
| --- | --- | --- |
| `origin/main` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` | **canlı `ls-remote`** (salt-okunur) |
| yerel `origin/main` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` | tracking ref — canlıyla **aynı** |
| `release/backend-only-4.7` (remote) | **yok** | — |

Hiçbir remote ref değiştirilmedi; fetch yapılmadı.

### Push edilecek commit'ler (tam liste)

`origin/release/backend-only-3.8.7` (= `cbe4f509`, zaten remote'da) tabanına göre **2 commit**:

```
2236cae  test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction
17ccbc9  release: backend-only 4.7 (memory persistence core safety fix)
```

Yanlışlıkla kapsama giren başka commit **yok**. `git branch -r --contains HEAD` → **boş** (commit
hiçbir remote branch'te değil → yeni branch, çakışma yok).

---

## 5. Push Hedefi ve Önerilen Komut (çalıştırılmadı)

**Hedef:** `HEAD:refs/heads/release/backend-only-4.7`

```bash
cd /tmp/tz410-release
git push -u origin release/backend-only-4.7
```

`-u` yalnız `origin/release/backend-only-4.7` tracking ref'ini kurar.

### Push öncesi güvenlik kontrolleri

| Kontrol | Sonuç |
| --- | --- |
| Remote adı `origin` mi? | **EVET** — `https://github.com/isatezcan444/Tezlify.git` (fetch ve push URL aynı) |
| Branch adı doğru mu? | **EVET** — `release/backend-only-4.7` |
| Candidate doğru branch üzerinde mi? | **EVET** — HEAD `refs/heads/release/backend-only-4.7` |
| HEAD beklenen SHA mı? | **EVET** — `2236cae` |
| Remote branch yok mu / güvenli mi? | **YOK** — yeni branch, üzerine yazma riski sıfır |
| Kapsama yanlış commit giriyor mu? | **HAYIR** — yalnız 2 commit, ikisi de 4.7 soyu |
| Force push gerekiyor mu? | **HAYIR** |
| Pre-push hook var mı? | **YOK** (`.git/hooks` boş, `core.hooksPath` tanımsız) |

**Force-push gereksinimi: YOK.** Remote'da aynı isimli ref bulunmadığı için `--force` /
`--force-with-lease` anlamsız ve **yasaktır**. Kullanılmayacak.

`git push --dry-run` de **çalıştırılmadı** (bu aşamada yasak).

---

## 6. Üretim Güvenliği

> Bu aşamada production'a bağlanmak yasak olduğu için aşağıdaki maddeler **son doğrulanmış kayıtlardan**
> raporlanıyor. Bu oturumda yeniden ölçülmeyenler açıkça işaretlendi.

| Madde | Durum | Kanıt |
| --- | --- | --- |
| `.deployed-commit` = `cbe4f509…` | **Bu aşamada doğrulanamadı** (bağlantı yasak). Son doğrulama **Aşama 4.20** (salt-okunur `cat`): `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` | 4.20 §6 |
| Production deploy yapılmadı | **Yapısal olarak kanıtlı** — 4.7 commit'leri **remote'da bile yok** (`ls-remote` boş); deploy `host-release.sh` bir ref'ten build alır, ref yoksa deploy edilemez | §4 |
| Backend 4.7 production'a alınmadı | **4.20'de ölçüldü** (bu aşamada yeniden doğrulanamadı): konteynerdeki `memory_persistence.py` SHA-256 = `6a1e5860…` = **cbe4f509 blob**; 4.7'nin blob'u `e12c030…` (farklı) | 4.20 §1–2 |
| Gateway `20c88bb` production'a alınmadı | **4.20'de ölçüldü**: konteynerdeki `index.js` SHA-256 = `4f2e435e…` = **cbe4f509 blob**; `20c88bb` bu commit'ten sonra push edildi (4.19) ve deploy edilmedi | 4.20 §1, 4.19 |
| `WHATSAPP_MEMORY_PERSIST_ENABLED` varsayılanı `False` | **Bu oturumda yerel kodla doğrulandı** — `backend/app/core/config.py:211` → `bool = False`; ayrıca `config.py` blob'u deployed ile **birebir aynı** (`9265fbfd888d…`) | yerel `git rev-parse` |
| Persistence loop aktivasyonu yapılmadı | **Bu aşamada doğrulanamadı** (bağlantı yasak). Son ölçüm **4.20**: `config_enabled:false, runs:0, task_running:false, cursor_count:0` | 4.20 §4 |
| Production DB / RAM / WhatsApp session | **Dokunulmadı** — bu aşamada hiçbir uzak komut çalıştırılmadı | — |

**Sonuç:** Push'un kendisi production'ı **etkilemez** — kod GitHub'a gider, sunucuya inmez.
Deploy ayrı ve açık onay gerektirir.

---

## 7. Persistence Loop Durumu

| Kanıt | Değer |
| --- | --- |
| `config.py:211` (candidate, yerel) | `WHATSAPP_MEMORY_PERSIST_ENABLED: bool = False` |
| `config.py` blob (deployed vs candidate) | **AYNI** (`9265fbfd888d6992403242456d32b19dd75b94cf`) |
| Candidate diff'inde `config.py` | **YOK** → varsayılan değişmiyor |
| Canlı durum (son ölçüm, 4.20) | `config_enabled:false`, `runs:0` → **KAPALI** |

**Push sonrası da loop kapalı kalır.** Açmak ayrı ve bilinçli bir env kararıdır — ve gateway
`20c88bb` deploy edilmeden **açılmamalıdır** (offset modu → P0-1 atlama riski geri gelir).

---

## 8. Test Sonuçlarının Kaynağı

**Bu aşamada testler yeniden çalıştırılmadı.** Sonuçlar **Aşama 4.21**'den devralındı
(aynı commit `2236cae`, aynı temiz worktree, izole SQLite `/tmp/tz421_test.db`):

| Ağaç | Sonuç | Kaynak |
| --- | --- | --- |
| **Candidate `2236cae`** | **919 passed / 4 skipped / 0 failed** | 4.21 §5 |
| **Baseline `cbe4f509`** | **905 passed / 4 skipped / 0 failed** | 4.21 §5 |
| **Fark** | **+14** (9 pagination + 5 isolation) | 4.21 §5 |
| 6 persistence/contract dosyası | 148 passed | 4.21 §5 |
| Yeni iki dosya tek başına | 9 + 5 passed | 4.21 §5 |
| Rastgele sıra (`pytest-randomly`) | 39 passed | 4.21 §5 |

4 skip = `test_whatsapp_phase6_5_qr_live_seam.py` (`WHATSAPP_LIVE_GATEWAY_URL` ister) — beklenen skip.

Candidate bu aşamada **değişmedi** (`HEAD` aynı SHA, worktree 0 satır kirli) → sonuçlar geçerliliğini
koruyor. Production DB'ye bağlanan hiçbir test çalıştırılmadı.

---

## 9. Açık Riskler

| ID | Seviye | Risk | Azaltma |
| --- | --- | --- | --- |
| R1 | P2 | Push **11 dosya** taşıyacak; 3'ü `scripts/pg_audit_tests/` denetim dosyası (ürün kodu değil) | İmaja girmiyor, deploy kapısını etkilemiyor; kapsam operatör tarafından bilinçli kabul edilmeli. Temizlik ayrı commit işi |
| R2 | P2 | **Backend 4.7 tek başına P0-1'i düzeltmez** — eski gateway `afterSeq`'i yok sayar, offset moduna düşer | Gateway `20c88bb` da deploy edilmeli; backend tek başına P0-2'yi devreye alır |
| R3 | P2 | Loop, backend 4.7 + **eski gateway** ile açılırsa sessiz atlama riski | Loop varsayılan kapalı; gateway deploy edilmeden açılmamalı |
| R4 | P3 | `dead_letter` satırı retry edilmiyor, yalnız sayılıyor | `/health.dead_letter_total` izlenmeli |
| R5 | P3 | Production maddelerinin bir kısmı bu aşamada ölçülmedi (bağlantı yasak) | Deploy öncesi aşamada salt-okunur yeniden doğrulanmalı |

**P0 / P1 açık risk yok.** Release'in kendisi (P0-1 + P0-2) bir düzeltme taşıyor.

---

## 10. Nihai Karar

### ✅ READY FOR EXPLICIT BACKEND PUSH APPROVAL

**Gerekçe:**
- Kimlik **birebir**: branch, HEAD `2236cae`, parent `17ccbc9`, tree `4a2c37de…` — 4.21 ile aynı.
- Worktree **tertemiz**: 0 staged / 0 unstaged / 0 untracked.
- Kapsam **beklenenle aynı**: **11 dosya**, +2038/−61, 8 backend + 3 denetim, 0 gateway.
- Remote'da branch **yok** → yeni branch, çakışma ve **force-push gereksinimi yok**.
- Push payload net: **yalnız 2 commit** (`17ccbc9`, `2236cae`); yabancı commit yok.
- Testler yeşil (devralınmış): 919 passed / 0 failed; baseline 905 → **regresyon yok**.
- Loop varsayılanı `False`, `config.py` deployed ile birebir aynı → push davranış değiştirmez.

**Push için kullanılacak tek komut (çalıştırılmadı):**
```bash
cd /tmp/tz410-release
git push -u origin release/backend-only-4.7
```

**Onay öncesi operatörün bilmesi gerekenler (bloklayıcı değil):**
1. Push **11 dosya** taşır; 3'ü denetim harness'ı.
2. Push **deploy değildir** — production `cbe4f509`'da kalır.
3. P0-1'in tam düzeltmesi gateway `20c88bb` deploy'unu da gerektirir.

**Duruldu.** Hiçbir commit, branch, remote veya production değişikliği yapılmadı.
Bir sonraki aşama (**4.23 — Backend 4.7 Release Branch Push**) yalnız açık onaydan sonra.
Push onayı deploy onayı **değildir**.
