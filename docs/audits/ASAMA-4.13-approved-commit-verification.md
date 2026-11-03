# AŞAMA 4.13 — ONAYLI 11 DOSYALI RELEASE COMMIT'İ VE SONRASI DOĞRULAMA

**Tarih:** 2026-10-31 12:04:57 +0300 (commit), doğrulama 12:05–12:15
**Kapsam:** 4.12'de `READY FOR EXPLICIT COMMIT APPROVAL` ile onaylanan Aday B'nin tek bir commit olarak
oluşturulması ve commit sonrası tam doğrulama.
**Nihai verdict:** **`COMMIT CREATED — POST-COMMIT VERIFICATION PASS`**
**Yetki:** `NOT AUTHORIZED — NO PUSH / NO DEPLOY`

---

## 1. Kullanılan worktree ve branch

`release/backend-only-4.7` dalı **`/tmp/tz410-release`** worktree'sinde checkout edilmiş durumdaydı
(`git worktree list --porcelain`). Branch pointer'ını elle oynatmak veya `git branch -f` ile git'in
"bu branch başka worktree'de checkout edilmiş" korumasını aşmak **yapılmadı**. Commit, dalın doğal olarak
checkout edildiği worktree'de oluşturuldu.

| Worktree | HEAD | Branch |
| --- | --- | --- |
| `/Users/isatezcan/Documents/Github/Tezlify` | `7afb540` | `main` |
| `/tmp/tz410-release` (**commit burada atıldı**) | `17ccbc9` → **`2236cae`** | `release/backend-only-4.7` |
| `/tmp/tz411-candB` (aday, dokunulmadı) | `17ccbc9` (detached) | — |
| `/tmp/tz410-base` (4.10'dan kalma, dokunulmadı) | `cbe4f509` (detached) | — |

Commit öncesi bu worktree'nin tek kirli öğesi, **v1** sürümünü taşıyan untracked test dosyasıydı;
v2 ile değiştirildi (bkz. §5). Başka hiçbir dosya değiştirilmedi.

---

## 2. Commit kimliği

```
$ git log -1 --format='%H%n%P%n%s%n%an <%ae>%n%ad'
2236caebd4281b108b835f16f4c80d3d2e2f1d05
17ccbc91843490f7c256b1324e22d11e0a02ac3f
test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction
isatezcan444 <isatezcan444@gmail.com>
Sat Oct 31 12:04:57 2026 +0300
```

| Öğe | Değer |
| --- | --- |
| Commit SHA | `2236caebd4281b108b835f16f4c80d3d2e2f1d05` |
| **Parent** | `17ccbc91843490f7c256b1324e22d11e0a02ac3f` ✓ |
| Mesaj | `test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction` ✓ (tam eşleşme) |
| Ağaç | `4a2c37de85f8c981ef5659299d993a7081cedbbe` |
| Yazar | `isatezcan444 <isatezcan444@gmail.com>` (deponun yapılandırılmış kimliği) |

**Amend / reset / rebase uygulanmadı.** `17ccbc9` tarihsel olarak yerinde duruyor ve yeni commit'in
doğrudan ebeveyni.

> Not: `17ccbc9`'un yazarı `release-preflight <release-preflight@local>` (sentetik), bu commit'in yazarı
> deponun gerçek kimliği. Fark bilinçlidir ve burada kayıtlıdır; geçmişi taklit etmek için kimlik
> uydurulmadı.

---

## 3. 11 dosyanın tam manifesti

Kümülatif olarak (`cbe4f509..2236cae`) 11 dosya. Blob kimlikleri commit ağacından okundu.

| # | Dosya | Blob (SHA1, 12) | Tür |
| --- | --- | --- | --- |
| 1 | `backend/app/main.py` | `bbd99ca0b283` | modified (17ccbc9'da) |
| 2 | `backend/app/services/whatsapp/memory_persistence.py` | `e12c030bd239` | modified (17ccbc9'da) |
| 3 | `backend/app/services/whatsapp/orchestration/sync.py` | `213f736e976f` | modified (17ccbc9'da) |
| 4 | `backend/app/services/whatsapp_gateway.py` | `2f44be2058c2` | modified (17ccbc9'da) |
| 5 | `backend/tests/test_whatsapp_memory_persistence.py` | `db60486e05f3` | modified (17ccbc9'da) |
| 6 | `backend/tests/test_whatsapp_memory_persistence_hardening.py` | `4b6314a3f762` | modified (17ccbc9'da) |
| 7 | `backend/tests/test_whatsapp_pagination_contract.py` | `bab8dec13bde` | modified (17ccbc9'da) |
| 8 | `scripts/pg_audit_tests/test_tz44_missing.py` | `2848509a18a8` | modified (17ccbc9'da) |
| 9 | `scripts/pg_audit_tests/test_tz46_audit.py` | `29e189c3bf47` | modified (17ccbc9'da) |
| 10 | `scripts/pg_audit_tests/tz44_pgplugin.py` | `e1dccfeeb3bf` | modified (17ccbc9'da) |
| 11 | `backend/tests/test_whatsapp_message_insert_isolation.py` | `36be99017306` | **added (bu commit'te)** |

Manifest dışı dosya: **0**. `git status --short` commit sonrası **tamamen temiz**.

---

## 4. Gerçek commit diff istatistikleri

İki farklı ölçüm vardır ve karıştırılmamalıdır:

| Ölçüm | Komut | Sonuç |
| --- | --- | --- |
| **Bu commit'in kendi katkısı** (parent'a göre) | `git diff --cached` / `git show --stat` | **1 dosya, +253 / −0** |
| **Kümülatif release farkı** (yayın tabanına göre) | `git diff --shortstat cbe4f509 HEAD` | **11 dosya, +2038 / −61** |

`git diff --cached --name-only` (HEAD = `17ccbc9`'a göre) 1 dosya listeler, çünkü diğer 10 dosyanın
değişikliği **zaten `17ccbc9` commit'inde** bulunuyor; bu commit onların üzerine yalnızca test dosyasını
ekliyor. 4.12'de beklenen `+2038 / −61` değeri **kümülatif** değerdir ve birebir tuttu.

**Bağımsız kanıt:** commit öncesi staged index'in ağacı `git write-tree` ile
`4a2c37de85f8c981ef5659299d993a7081cedbbe` çıktı — bu, 4.11 ve 4.12'de doğrulanan **Aday B ağacının
aynısı**. Commit sonrası `git rev-parse HEAD^{tree}` de aynı değeri verdi. Yani commit'in içeriği,
onaylanan adayla **byte düzeyinde** aynıdır.

---

## 5. Yeni test dosyasının SHA256 doğrulaması

| Aşama | Dosya | SHA256 |
| --- | --- | --- |
| Kaynak (tek geçerli) | `scripts/prepared_tests/ASAMA-4.11-candidate-B/test_whatsapp_message_insert_isolation.py` | `ec7fed85963dba90d59d9ba8944764961d158eee880bed8eae5f08a269036e96` |
| Kopya **öncesi** hedef (v1 idi) | `backend/tests/test_whatsapp_message_insert_isolation.py` | `b74df9ff4dfbc192c23b73bd286580332e1a01bf185b2f1cd8b0eca17e231f27` |
| Kopya **sonrası** hedef | aynı | `ec7fed85963dba90d59d9ba8944764961d158eee880bed8eae5f08a269036e96` ✓ |
| Satır sayısı | — | **253** ✓ |

v1 dosyası `scripts/prepared_tests/test_whatsapp_message_insert_isolation.py` altında **silinmedi,
değiştirilmedi** (`b74df9ff…` hâlâ orada) ve commit'e **girmedi**.

---

## 6. PostgreSQL 17.11 test sonuçları (commit sonrası, yeni HEAD üzerinde)

Komut `-p tz44_pgplugin` ile koşuldu (asyncpg pool/event-loop uyuşmazlığını önleyen harness eklentisi).

| Parti | Sonuç |
| --- | --- |
| L-C1 | **5 passed** |
| Persistence | **10 passed** |
| Hardening | **15 passed** |
| Pagination | **9 passed** |
| TZ44 | **8 passed** |
| TZ46 | **10 passed** |
| **Birleşik** | **57 passed** (beklenen 57) ✓ |

---

## 7. Tam backend suite (commit sonrası)

| Ölçüm | Değer |
| --- | --- |
| Toplanan | **2070** |
| Sonuç | **2065 passed / 1 failed / 4 skipped** |
| Exit | 1 |

Beklenen değerlerle **birebir** aynı. Tek kırmızı:

```
FAILED backend/tests/test_admin_ops_security.py::test_http_probe_distinguishes_unreachable_from_unhealthy
```

**Sınıflandırma: tabandan gelen bilinen kırmızı** — 4.10'da `cbe4f509` üzerinde ayrı worktree'de
koşularak kanıtlandı. Test `str(Optional[bool])` içinde `"None"` arıyor; ürün doğru
(`ops_service.py:1162` → `-> Optional[bool]`, gövdede `return None`). Bu commit'le ilgisi yok,
kapsam dışı bırakıldı. **Yeni veya farklı hata yok.**

---

## 8. Compile / import

| Kapı | Sonuç |
| --- | --- |
| `compileall backend/app backend/tests scripts/pg_audit_tests` | **EXIT 0** |
| Import: `main`, `memory_persistence`, `orchestration.sync`, `whatsapp_gateway`, `core.migrations` | **5/5 OK** |

---

## 9. Gateway byte-identity

`git hash-object <dosya>` ↔ `git rev-parse cbe4f509:<dosya>`:

| Dosya | Sonuç |
| --- | --- |
| `whatsapp-gateway/package.json` | **IDENTICAL** (`588c92f03494`) |
| `whatsapp-gateway/src/index.js` | **IDENTICAL** (`c492617df92b`) |
| `whatsapp-gateway/Dockerfile` | **IDENTICAL** (`1940cef6e0f9`) |
| `whatsapp-gateway/package-lock.json` | **IDENTICAL** (`2ec913a07a3b`) |
| `whatsapp-gateway/README.md` | **IDENTICAL** (`068254960508`) |

**5/5 IDENTICAL.** `git diff --name-only cbe4f509 HEAD -- whatsapp-gateway/` → **0 dosya**.

---

## 10. Release guard — gerçek exit code'lar (pipe kullanılmadı)

| Koşu | `--target` | `--backend-from` | **exit** | gateway/compose | vs main | vs base |
| --- | --- | --- | --- | --- | --- | --- |
| Self | `HEAD` (`2236cae`) | `HEAD` | **0** | 0 | 0 | **8** |
| Main | `HEAD` (`2236cae`) | `origin/main` | **1** | 0 | **10** | 8 |

- Gateway/compose farkı **0** ✓
- Backend vs base **8** ✓ (7 backend dosyası + yeni test)
- `--no-gateway` muhafızı **geçiyor**
- `--expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8` ✓
- `run_release.sh` = `9284245fa56c` ✓ · `host-release.sh` = `f2b7a9aeb5c4` ✓ (taban = hedef)

Guard'ın ürettiği komut (**ÇALIŞTIRILMADI**):

```
bash scripts/deploy/run_release.sh \
  --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
  HEAD --no-gateway --health-timeout 180
```

`--main` koşusunun exit 1 vermesi **beklenen** davranıştır: `main` (7afb540) 4.7'yi taşımıyor; backend-only
bir ref'in `main`'in backend ağacını taşımadığı durumda guard'ın sessiz gerilemeyi engellemesi doğrudur.

---

## 11. Ana kullanıcı çalışma ağacının korunma durumu

| Öğe | Değer |
| --- | --- |
| HEAD | `7afb540` (değişmedi) |
| Branch | `main` |
| Staged | **0** |
| Değişik dosya | **23** (hepsi aşama öncesinden; 21'i kod/doküman, 2'si `.workbuddy-ai/memory/*`) |
| Bu aşamada yapılan yazma | Yalnızca `.workbuddy-ai/memory/2026-10-31.md` (append) ve `docs/audits/ASAMA-4.13-*.md` (yeni, untracked) |

Ana ağaçta **hiçbir kod dosyası açılmadı/değiştirilmedi**; `git add`, `reset`, `clean`, `stash`
kullanılmadı. Kullanıcının 23 değişik dosyası aynen korundu.

---

## 12. Push / deploy / üretim beyanı

**Bu aşamada aşağıdakilerin hiçbiri yapılmadı:**

- ❌ `git push` — **kanıt:** `refs/remotes/origin` altında `release/backend-only-4.7` **yok**
  (`git rev-parse origin/release/backend-only-4.7` başarısız); uzak ref listesi değişmedi.
- ❌ `scripts/deploy/run_release.sh` / `release.sh` / `host-release.sh` — **çalıştırılmadı**
- ❌ `docker compose up/down/restart`, container restart/recreate — **yapılmadı**
- ❌ Üretim DB INSERT/UPDATE/DELETE — **yapılmadı** (bu aşamada üretime hiç bağlanılmadı)
- ❌ Gateway deploy/restart — **yapılmadı**
- ❌ Persistence loop aktivasyonu — **yapılmadı**
- ❌ Rollback denemesi — **yapılmadı**

`/opt/tezlify/.deployed-commit` hâlâ `cbe4f509…`; yayındaki sürüm değişmedi.

**Commit oluşturulması deploy izni değildir.**

---

## 13. Kalan riskler (hiçbiri kapatılmadı)

| # | Risk | Durum |
| --- | --- | --- |
| 1 | **P0-1 front-trim** | **AÇIK** — backend-only release çözmez; yayındaki gateway `afterSeq` okumuyor (`index.js:563`). Gateway + backend birlikte yenilenmeli. |
| 2 | **RAM_ONLY** | **AÇIK** — deploy anında yeniden ölçülmeli; 4.9'un `RAM_ONLY = 0` değeri taşınamaz. |
| 3 | **Snapshot zorunluluğu** | **AÇIK** — gateway recreate'ten önce taze + `remote_verified: true` snapshot şart (RAM'in tek yedeği). |
| 4 | **Persistence loop** | **AÇIK / KAPALI KALMALI** — deploy sırasında etkinleştirilmemeli; kill-switch yalnız `true`/`1`. |
| 5 | **Rollback** | **AÇIK** — `--rollback-to` gateway'i de recreate eder (RAM kaybı). Backend-only yol ayrı: `docker tag tezlify-backend:pre-<TS> latest && docker compose up -d --no-deps backend`. |
| 6 | **`http_probe` testi** | **AÇIK (tabandan)** — ayrı test commit'i; bu release'in kapsamı dışı. |
| 7 | **LID (K-7)** | **İZLENEN** — kusur yok; 4.7 LID bloğunu değiştirmiyor. |
| 8 | **Dal uzakta yok** | **AÇIK** — `release/backend-only-4.7` yalnızca yerelde; push edilmedi (bu aşamada yasak). Deploy edilecekse ref'in erişilebilir olması ayrıca planlanmalı. |

### Temizlik notu (kapsam dışı, bilgi)

`/tmp/tz410-base` (4.10'dan, detached `cbe4f509`) ve `/tmp/tz411-candB` (detached `17ccbc9`) worktree'leri
yerinde bırakıldı — hiçbir branch'i etkilemiyorlar. İstenirse `git worktree remove` ile temizlenebilir.

---

## 14. VERDICT

```
COMMIT CREATED — POST-COMMIT VERIFICATION PASS
NOT AUTHORIZED — NO PUSH / NO DEPLOY
```

Onaylanan 11 dosyalı Aday B, `17ccbc9`'un üzerine **tek bir commit** olarak oluşturuldu
(`2236cae`), içeriği onaylanan ağaçla byte düzeyinde aynı, tüm commit-sonrası kapılar geçti.
Üretim durumu değişmedi; push ve deploy için ayrı ve açık onay gerekir.
