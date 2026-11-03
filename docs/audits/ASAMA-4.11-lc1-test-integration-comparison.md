# AŞAMA 4.11 — L-C1 TEST ENTEGRASYONU VE RELEASE ADAYI KARŞILAŞTIRMASI

**Tarih:** 2026-10-31 (Europe/Istanbul)
**Kapsam:** `release/backend-only-4.7` (`17ccbc9`) sabit tutularak, L-C1 kapsam testlerinin release'e
alınmasının güvenli olup olmadığının iki ayrı aday üzerinde kanıtla karşılaştırılması.
**Sonuç:** **AŞAMA 4.11 TAMAMLANDI — KARAR: B**
**Yetki durumu:** `NOT AUTHORIZED — NO COMMIT / NO PUSH / NO DEPLOY`

---

## 1. Kesin sınırlar ve bu aşamada yapılmayanlar

| Kısıt | Durum |
| --- | --- |
| `main` değiştirme | **YAPILMADI** — HEAD `7afb540`, staged 0 |
| `release/backend-only-4.7` değiştirme | **YAPILMADI** — `17ccbc9`, aşağıda tekrar kanıtlandı |
| `17ccbc9` amend/reset | **YAPILMADI** |
| Yeni commit | **Branch'e YAPILMADI.** Guard'ın `^{commit}` şartı için yalnızca izole worktree'de, geçici
  `refs/tz411/candidate-b` altında bir commit nesnesi üretildi ve **silindi** (§6.2'de açıklandı) |
| Push / deploy / release scripti | **YAPILMADI** |
| Container restart/recreate | **YAPILMADI** |
| Üretim DB yazımı | **YAPILMADI** — yalnızca `SELECT` |
| Gateway kaynağı | **DOKUNULMADI** — 5/5 byte-identical |
| RAM persistence loop | **ETKİNLEŞTİRİLMEDİ** |
| `git add -A` / `clean` / `reset --hard` / `stash` | **KULLANILMADI** |
| Kullanıcının çalışma ağacı | **KOD OLARAK DEĞİŞTİRİLMEDİ** (yalnızca bu rapor + hafıza günlüğü eklendi) |
| Lockfile değişikliği | **YOK** — `package-lock.json` blob'u `2ec913a07a3b` her iki tarafta aynı |

İzole worktree'ler: `/tmp/tz410-release` (Aday A, 4.10'dan), `/tmp/tz411-candB` (Aday B, bu aşamada).

---

## 2. Mevcut release'in sabitlendiğinin kanıtı

Aşama başında **ve** sonunda ölçüldü; ikisi de aynı:

```
$ git rev-parse --abbrev-ref HEAD   -> release/backend-only-4.7
$ git rev-parse HEAD                -> 17ccbc91843490f7c256b1324e22d11e0a02ac3f
$ git rev-parse HEAD^               -> cbe4f509f4bcc5babb12cc85e0ad422cb13ba739
$ git diff --shortstat cbe4f509 HEAD-> 10 files changed, 1785 insertions(+), 61 deletions(-)
$ git diff --name-only cbe4f509 HEAD -- whatsapp-gateway/ | wc -l -> 0
```

Beklenen değerlerin **hepsi** tuttu; durma koşulu oluşmadı.

---

## 3. L-C1 test dosyası incelemesi

### 3.1 İki kopya birebir mi?

| Kaynak | SHA256 | Boyut |
| --- | --- | --- |
| `scripts/prepared_tests/test_whatsapp_message_insert_isolation.py` | `b74df9ff4dfbc192c23b73bd286580332e1a01bf185b2f1cd8b0eca17e231f27` | 8 862 B |
| `/tmp/tz410-release/backend/tests/…` | `b74df9ff4dfbc192c23b73bd286580332e1a01bf185b2f1cd8b0eca17e231f27` | 8 862 B |

`diff -q` → **IDENTICAL**. (Aşağıda görüleceği gibi bu, "doğru" olduğu anlamına gelmiyor.)

### 3.2 Beş test gerçekten ürün koduna bağlı mı?

Testler `backend.app.services.whatsapp.orchestration.sync` modülünden **gerçek**
`_insert_messages_resilient` ve `_integrity_constraint_name` fonksiyonlarını import ediyor.
Dosyada `patch`/`Mock` **kullanımı sıfır** — `from unittest.mock import patch` satırı import edilmiş ama
hiç çağrılmamıştı (aday B'de kaldırıldı). Yani sahte başarı üretme yolu yok.

Bunu iddia olarak bırakmadım; **mutasyon testi** ile ölçtüm (hepsi gerçek PostgreSQL 17.11 üzerinde):

| Mutasyon | Ne bozuldu | Sonuç |
| --- | --- | --- |
| ~~M0~~ | "fallback dialect" dalındaki `dead_letter["count"]` artışı | **5 passed — HAYATTA KALDI** |
| **A** | `_insert_messages_one_by_one` içindeki gerçek `dead_letter["count"]` artışı | `test_client_message_id_collision_is_isolated_per_row` **FAILED** |
| **B** | `_integrity_constraint_name`'de `__cause__` adayları (`candidates = (orig,)`) | test 3 **ve** test 1 **FAILED** |
| **C** | Satır başına `db.begin_nested()` yerine SAVEPOINT'siz `AsyncExitStack` | test 2 **ve** test 1 **FAILED** |

**M0'ın hayatta kalması bir bulgudur, önemsiz değil:** ilk denemem yanlış yeri (PG/SQLite'ta hiç
koşmayan `for row in rows:` fallback dalını) mutasyona uğratmıştı. Mutasyonun "öldürmesi" için
**çalışan** yolu vurması gerekir. Doğru sayaç (A) vurulunca test kırmızı oldu.

Her mutasyondan sonra kaynak `cp` ile geri yüklendi ve SHA256 doğrulandı:
`sync.py` = `edb7e9d2921c7699…` (üç mutasyonda da aynı).

### 3.3 Ölçülen kritik kusur: dosya PostgreSQL'de kırılıyordu

Dosya 4.10'da yalnızca **SQLite** üzerinde koşulmuştu. PostgreSQL 17.11'de ilk koşu:

```
1 failed, 1 passed, 3 errors        (tz44_pgplugin YÜKLENMEDEN)
2 failed, 3 passed                  (tz44_pgplugin ile — gerçek tablo)
```

Kök neden (ürün değil, **fixture**):

```
asyncpg: invalid input for query argument $29:
  datetime(2026, 8, 1, 10, 0, tzinfo=utc)
  (can't subtract offset-naive and offset-aware datetimes)
```

`messages.created_at` = `TIMESTAMP WITHOUT TIME ZONE`; asyncpg tz-aware değeri reddeder. Ürün naive
üretir (`utc_now_naive`). Yani **v1 yalnızca SQLite'ta geçerliydi**; üretim diyalekti olan PostgreSQL'de
5 testin 2'si kırmızıydı.

> 3 ERROR ayrı bir sınıftı ve ürünle ilgisi yok: asyncpg pool/event-loop uyuşmazlığı
> (`got Future attached to a different loop`, `connection was closed in the middle of operation`).
> PG koşuları için yazılmış `scripts/pg_audit_tests/tz44_pgplugin.py` yüklenmediğinde ortaya çıkıyor.
> Plugin ile 3 test geçti, kalan 2'si yukarıdaki gerçek hatayı verdi.

### 3.4 Düzeltme (v2)

Aday B'de üç değişiklik yapıldı:

1. `row()` içindeki `created_at` **naive** üretiliyor (ürünün `utc_now_naive` sözleşmesine uygun).
2. `dead_letter["constraint"]` iddiası **dialect'e göre** pinlendi:
   PostgreSQL'de `"uq_msg_conv_client_message_id"`, SQLite'ta `None`.
   Bu, 8 numaralı davranışı sentetik taklit yerine **gerçek indeks adıyla** doğrular.
3. Kullanılmayan `patch` ve `timezone` import'ları kaldırıldı; docstring'e PG notu eklendi.

| Sürüm | SHA256 | Boyut | SQLite | PostgreSQL 17.11 |
| --- | --- | --- | --- | --- |
| **v1** (4.10'da teslim) | `b74df9ff…e231f27` | 8 862 B | 5/5 | **2 failed / 3 passed** |
| **v2** (aday B) | `ec7fed85963dba90d59d9ba8944764961d158eee880bed8eae5f08a269036e96` | 9 737 B | 5/5 | **5/5** |

v2 blob (aday B ağacında): `36be990173065820fde00f051d64e3f87d6db611`

---

## 4. İki aday

| | **Aday A** | **Aday B** |
| --- | --- | --- |
| Ref | `release/backend-only-4.7` = `17ccbc9` | `17ccbc9` + 1 dosya (commit YOK) |
| Worktree | `/tmp/tz410-release` | `/tmp/tz411-candB` (detached) |
| Dosya sayısı (base'e göre) | **10** | **11** |
| Kapsam | +1785 / −61 | +1785 / −61 **+** test dosyası |
| L-C1 testi | manifest'te **yok** | **var** (v2, `ec7fed85…`) |
| Üretim kodu farkı | — | **0** (yalnızca `backend/tests/`) |
| Gateway dosyası | 0 | 0 |

Aday B'de manifest dışı dosya **yok** — `git status` tek satır:

```
?? backend/tests/test_whatsapp_message_insert_isolation.py
```

`git diff` (tracked) **boş**; 11 dosyalık liste `backend/` 7 + `scripts/pg_audit_tests/` 3 + yeni test 1.

---

## 5. Test ve regresyon kapıları

### 5.1 PostgreSQL 17.11 üzerinde (üretim diyalekti)

| Parti | Sonuç |
| --- | --- |
| L-C1 (5) | **5 passed** |
| persistence + hardening (25) | dahil |
| pagination contract (9) | dahil |
| tz44 audit (8) | dahil |
| tz46 audit (10) | dahil |
| **Birleşik parti** | **57 passed** (`-p tz44_pgplugin`) |

PG sürümü hem test örneğinde hem üretimde **17.11** (`show server_version`) — yani kanıt temsili.

### 5.2 Tam backend suite (SQLite, Aday B)

| Koşu | Toplanan | Sonuç |
| --- | --- | --- |
| node deps yok | 2070 | 2063 passed + 1 failed + 2 error + 4 skipped |
| node deps var (symlink) | 2070 | **2065 passed + 1 failed + 4 skipped** |

Aday A'nın karşılığı (4.10'da ölçüldü): **2065 toplanan → 2060 passed + 1 failed + 4 skipped**.
`--collect-only` ile doğrulandı: A = **2065**, B = **2070**. Fark **tam olarak +5**, hepsi yeşil.

### 5.3 `test_admin_ops_security.py::test_http_probe_distinguishes_unreachable_from_unhealthy`

Bu aşamada **takip edildi, düzeltilmedi** (kapsam dışı):

- Her iki adayda da kırmızı; 4.10'da `cbe4f509` üzerinde ayrı worktree'de de kırmızı olduğu **koşularak** kanıtlandı.
- Neden: test `str(return_annotation)` içinde `"None"` arıyor; `Optional[bool]` gösterimi
  `typing.Optional[bool]` olup `"None"` içermiyor. Ürün doğru (`ops_service.py:1162` → `-> Optional[bool]`,
  gövdede `return None`).
- **4.7 regresyonu değil**, A/B kararını etkilemiyor.

### 5.4 Diğer kapılar

| Kapı | Sonuç |
| --- | --- |
| `compileall` (test dosyası) | EXIT 0 |
| Import (`backend.app.main`, `orchestration.sync`) | OK |
| Secret taraması (eklenen dosya) | 0 gerçek sır |
| PII taraması | 1 eşleşme: `+905551112233` — **uydurma** test numarası (555-111-22-33 deseni) |
| Gateway byte-identity (5 dosya) | **5/5 IDENTICAL** |
| Manifest dışı dosya | 0 |

---

## 6. Guard karşılaştırması — `scripts/deploy/backend_only_release.py`

### 6.1 Dört koşu, gerçek exit code'lar

Exit code'lar `| tail` üzerinden değil, komutun hemen ardından `echo EXIT=$?` ile alındı.

| Koşu | `--target` | `--backend-from` | **exit** | gateway/compose | backend vs main | backend vs base |
| --- | --- | --- | --- | --- | --- | --- |
| A-self | `17ccbc9` | `17ccbc9` | **0** | 0 | 0 | 7 |
| A-main | `17ccbc9` | `origin/main` | **1** | 0 | 9 | 7 |
| B-self | `refs/tz411/candidate-b` | kendisi | **0** | 0 | 0 | **8** |
| B-main | `refs/tz411/candidate-b` | `origin/main` | **1** | 0 | **10** | **8** |

`--no-gateway` koruması: **iki adayda da geçiyor** (gateway/compose farkı 0).
`--expected-self-blob` doğrulaması: iki adayda da `9284245fa56c8e66c881aa8a0e9b6fd430e391c8`
(`run_release.sh` blob'u); `host-release.sh` = `f2b7a9aeb5c4`, taban ve hedefte **aynı** ⇒ exit-9 riski yok.

Aday B'nin ürettiği (çalıştırılmayan) komut:

```
bash scripts/deploy/run_release.sh \
  --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
  refs/tz411/candidate-b --no-gateway --health-timeout 180
```

`backend vs base` sayısı A'da 7, B'de 8 — fark tam olarak yeni test dosyası. **A'nın 7'si `backend/`
altındaki dosyalardır; 3 audit betiği bu sayaca girmez.**

### 6.2 Geçici ref — açık beyan

Guard `^{commit}` istediği için bir worktree yoluyla çalışmıyor. Bu yüzden **yalnızca izole aday
worktree'de**, geçici bir index ile:

```
GIT_INDEX_FILE=/tmp/tz411_candB.idx
git read-tree 17ccbc9
git add backend/tests/test_whatsapp_message_insert_isolation.py
git write-tree                                  -> 4a2c37de85f8c981ef5659299d993a7081cedbbe
git commit-tree <tree> -p 17ccbc9               -> b349cc98709e7989a6b2a9678cd475d3e4e470f0
git update-ref refs/tz411/candidate-b <commit>
... guard koşuları ...
git update-ref -d refs/tz411/candidate-b
```

Sonuç doğrulaması: `git show-ref | grep tz411` → **boş**; worktree HEAD hâlâ `17ccbc9`;
hiçbir branch/tag/remote etkilenmedi. Geriye yalnızca **dangling commit nesnesi** kaldı (zararsız,
`git gc` ile temizlenir). Bu, §1'deki "yeni commit yasak" kuralının tek istisnasıdır ve §6'nın
"gerekiyorsa geçici ref kullan, raporla" hükmüne dayanır — **hiçbir branch'e commit atılmadı.**

---

## 7. Git worktree izolasyonu ve değişmezlik kanıtı

| Nesne | Durum |
| --- | --- |
| `/tmp/tz410-release` (Aday A) | `release/backend-only-4.7` @ `17ccbc9`, tracked diff boş, yalnızca 1 untracked test |
| `/tmp/tz411-candB` (Aday B) | detached `17ccbc9`, tracked diff boş, yalnızca 1 untracked test |
| Kullanıcının ağacı | HEAD `7afb540`, staged **0**, kod dosyalarında değişiklik **yok** |
| `main` | değişmedi |

Mutasyon denemelerinde `sync.py` üç kez geçici olarak bozuldu ve her seferinde birebir geri yüklendi
(SHA256 `edb7e9d2921c7699…` üç koşuda da aynı). Bu, **yalnızca aday worktree'de** yapıldı; kullanıcı
ağacındaki `sync.py` hiç açılmadı.

---

## 8. Açık riskler

1. **İki sürüm de depoda duruyor:** v1 = `scripts/prepared_tests/test_whatsapp_message_insert_isolation.py`
   (`b74df9ff…`, SQLite-only), v2 = `scripts/prepared_tests/ASAMA-4.11-candidate-B/…` (`ec7fed85…`, PG'de yeşil).
   Onaylanırsa **v2** kullanılmalı; v1 yalnızca "teslim edilen sürüm" kanıtı olarak saklanıyor.
2. **B yeni bir commit gerektirir.** `17ccbc9` amend edilmemeli; yeni commit sonrası guard, PG partisi ve
   tam suite **tekrar** koşmalı (manifest 10 → 11 olduğu için 4.10'un 10-dosya kanıtı B'ye taşınamaz).
3. **SQLite'ta yeşil olmak PG'de yeşil olmak değildir** — bu aşamanın en pahalı dersi. PG'siz bir CI,
   bu sınıf hatayı (tz-aware fixture) sonsuza kadar saklar.
4. **`test_admin_ops_security.py` kırmızı** — tabandan geliyor, ayrı commit işi.
5. **P0-1 backend-only ile kapanmıyor** (yayındaki gateway `afterSeq` okumuyor).
6. **RAM kapısı deploy anında yeniden ölçülmeli** — 4.9'un `RAM_ONLY = 0` değeri taşınamaz.
7. **Dangling commit nesnesi** (b349cc98…) repoda duruyor; işlevsel etkisi yok.

---

## 9. Karar: **B — 11 dosyalı aday tercih edilmeli**

### Gerekçe

- **Üretim kodu riski artmıyor:** B'nin A'ya göre tek farkı `backend/tests/` altında bir dosya.
  `backend/app/**` içinde **tek satır** değişmiyor (guard: `backend vs base` 7 → 8, gateway 0).
- **Kapsam boşluğu gerçekti:** 4.7'nin çekirdek güvenlik iddiası — "tek zehirli satır 500 satırlık
  sayfayı öldürmez" — **hiçbir** testle korunmuyordu. A, düzeltmeyi testsiz yayınlar.
- **Kanıt üretim diyalektinde:** 5/5 PostgreSQL 17.11'de; üstelik 3 mutasyon testi, testlerin
  SAVEPOINT/fallback davranışına gerçekten bağlı olduğunu gösteriyor.
- **Guard sonucu aynı:** iki aday da `--no-gateway`'den geçiyor (exit 0, gateway 0).
- **Maliyet düşük ve ölçülmüş:** manifest 10 → 11; tam suite farkı tam olarak +5 test.

### Neden A değil

A, savunulabilir bir "minimum diff" tercihidir; ancak bu release'in **tek değeri** olan güvenlik
davranışını testsiz bırakır. Bu aşamada kanıtlandı ki test dosyası SQLite'ta yeşil, PostgreSQL'de
kırmızı olabiliyor — yani "testler zaten geçiyor" güvencesi PG koşulmadan geçersiz.

### Uygulama koşulları (bu aşamada YAPILMADI)

1. `scripts/prepared_tests/ASAMA-4.11-candidate-B/test_whatsapp_message_insert_isolation.py` (**v2**,
   `ec7fed85…`) release'e alınsın; v1 (`b74df9ff…`) arşivde kalsın.
2. `17ccbc9` **amend edilmesin**; yeni bir commit olarak kesilsin (11 dosya).
3. Yeni commit sonrası: guard (A-self/B-self), PG 17 birleşik parti (57), tam suite (2070) tekrar koşsun.
4. **Test kapsamı artışı deploy onayı değildir.** Deploy ayrı bir karardır ve RAM kapısı deploy anında
   yeniden ölçülmelidir.

---

## 10. Nihai yetki durumu

```
AŞAMA 4.11 TAMAMLANDI — KARAR: B
ÜRETİM DURUMU: NOT AUTHORIZED — NO COMMIT / NO PUSH / NO DEPLOY
```

Commit (branch'e), push, deploy, container restart/recreate, üretim DB yazımı, gateway değişikliği ve
persistence loop aktivasyonu **yapılmadı**. `release/backend-only-4.7` = `17ccbc9` **değişmedi**.
