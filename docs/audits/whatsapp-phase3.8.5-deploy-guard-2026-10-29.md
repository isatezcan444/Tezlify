# AŞAMA 3.8.5 — DEPLOY GÜVENLİK MUHAFIZI SERTLEŞTİRME

**Tarih:** 2026-10-29 (16:34–16:58Z)
**Tür:** Kod + test + release ref hazırlığı. **Deploy yok, üretim DB yazımı yok, sweep/dry-run
başlatılmadı, gateway'e dokunulmadı, migration çalıştırılmadı, RAM yedeği değiştirilmedi.**
**Sonuç:** `release/backend-only-3.8.5` = `38fe087` oluşturuldu, preflight **exit 0**. Çalışan betik
artık hedef commit'in betiği olmak zorunda; eski betik kapıları atlayamıyor (**gerçek üretim
kanıtı**, §7).

---

## 1. Başlangıç / bitiş SHA'ları

| | Başlangıç | Bitiş |
|---|---|---|
| `main` (yerel) | `848c1722ea11bbe306a89e0d561673aed463cca5` | **`84e3f38af22566e7a3f3c956fa8cb97f082c19d2`** |
| `origin/main` | `848c1722…` | **`848c1722…` — değişmedi, push edilmedi** |
| `release/backend-only-3.8.4` | `3d3fc7988dff1ade603b7e7c2bb41201e4f828eb` | değişmedi (yerel+uzak) |
| **`release/backend-only-3.8.5`** | — | **`38fe0879ed05da4a0944eb9f98f57a8fa20de431`** (tree `641a677`) |
| Üretimde yayında (`.deployed-commit`) | `b5715fe90d0ff05ef497dcccbc87652efa10ccd1` | **aynı** |
| Çalışma ağacı | 2 dosya kirli (3.8.4 artığı: `M` günlük, `??` denetim) | **temiz** (`git status` boş) |

Yeni commit'ler (hepsi `main` üzerinde, geçmiş yeniden yazılmadı):

| SHA | Ne |
|---|---|
| `7682a89` | 3.8.4 denetim dokümanı + günlük (önceki aşamadan devreden, commit edilmemişti) |
| `a59ac79` | 3.8.5 kod + testler |
| `84e3f38` | preflight işaret düzeltmesi + bash/python liste paritesi testi |

> `main` **push edilmedi**: madde 6 "push yalnızca yeni release ref'i için" diyor. `origin/main`
> `848c172`'de kaldı; yeni commit'ler yalnızca `release/backend-only-3.8.5` üzerinden uzakta.

---

## 2. Başlangıç durumu (salt okunur, hiçbir dosya değiştirilmeden)

| Öğe | Değer |
|---|---|
| Backend-only preflight (mevcut ref, mevcut kod) | `3d3fc79` için `gateway 0 / backend-vs-main 0 / backend-vs-base 13` → **exit 0** |
| `host-release.sh` base (`b5715fe`) | 1.008 satır, `persistence_flag_guard` **0** referans |
| `host-release.sh` target (`3d3fc79`) | 1.087 satır, aynı dosyada **6** referans |
| RAM yedeği | `…T125755Z.rsnap` 7.100.080 B, `0600`, `ubuntu:ubuntu`, dizin `0700` — dokunulmadı |

### 2.1 Flag'in gerçek kaynakları (ölçüldü, tahmin değil)

```
.env.production          -> WHATSAPP_MEMORY_PERSIST_ENABLED  YOK (satır yok)
canlı container env'i    -> WHATSAPP_MEMORY_PERSIST_ENABLED  YOK
```

Bu, §4'teki daraltmanın **operasyonel bir engel üretmediğini** kanıtlar: cutover öncesi kapı
`--env-file .env.production` (strict değil) "yokluk = kapalı" ile geçer; adacık yolunda ise betik
değeri açıkça `false` yazar.

---

## 3. Çözülen çelişki: betik sürümü karışıklığı

3.8.4'ün bıraktığı en önemli risk şuydu: muhafız **hedef release'te** var, ama deploy'u çalıştıran
dosya **eski checkout'tan** geliyor olabilir. `host-release.sh` checkout'un içinden koşar ve
`git reset --hard` adımı **3. adımdan sonra** gelir; yani eski betik koşarken yeni kapılar hiç
devreye girmez.

Ölçüm (üretimde, salt okunur — §7'deki Case C):

| Çalışan betik | Hedef | Sonuç |
|---|---|---|
| `b5715fe` sürümü (blob `69da7b3c`, **0** muhafız referansı) | `38fe087` | **exit 0**, plan yazıldı — hiçbir sürüm kontrolü yok |
| `38fe087` sürümü (blob `f2b7a9ae`) | `b5715fe` | **exit 9**, "çalışan betik hedef commit'in betiği DEĞİL" |
| `38fe087` sürümü (blob `f2b7a9ae`) | `38fe087` | **exit 0**, üç muhafız da "GEÇTİ" |

Yani eski betik yeni hedefi **sessizce** kabul ediyordu; yeni betik eski hedefi **gürültülü**
reddediyor. Fark tam olarak buydu.

---

## 4. Fail-closed tasarım — üç katman

### Katman A — `scripts/deploy/script_version_guard.py` (yeni, saf mantık + CLI)

```
self_blob   = git hash-object <çalışan dosya>
target_blob = git rev-parse <hedef>:scripts/deploy/host-release.sh
```

| Durum | Gerekçe | Sonuç |
|---|---|---|
| eşit | `script_matches_target` | **İZİNLİ** |
| farklı | `script_is_not_target_version` | RED |
| hedefte dosya yok | `script_absent_in_target` | RED |
| kendi blob'u okunamadı | `script_blob_unreadable` | RED |
| `--pin-blob` uyuşmuyor | `script_pin_mismatch` | RED |
| `--pin-commit` ≠ hedef | `script_pin_commit_mismatch` | RED |
| güvenlik işaretleri eksik | `script_missing_security_checks` | RED |

Blob eşitliği **"çalışan = hedef"** der, **"hedef muhafızı taşıyor"** demez: eski bir commit hedef
gösterilirse ikisi de tutar. Bu yüzden üç kablolama işareti ayrıca aranır
(`persistence_flag_guard.py`, `--require-explicit-false`, `persist_flag_effective`). Bash'teki
`for marker in …` döngüsü ile bu Python listesi arasında **parite testi** var — iki kopya sessizce
ayrışamaz.

Yan fayda: kontrol, bash'in **artımlı okuma** riskini de kaldırır. `git reset --hard` betiği
değiştirseydi, çalışan betik okuduğu konumdan **başka** bir dosyayı okumaya devam ederdi; blob
eşitliği bunu imkânsız kılar (baytlar aynı ⇒ okunan konum aynı anlama gelir).

### Katman B — `host-release.sh` (hedefteki betik kendini kanıtlar)

- `die_code <n>` eklendi; `die` artık `die_code 1`e devrediyor (izole DB temizliği tek yerde,
  çıkış kodu çağırana ait). Mevcut `on_error` temizliği korunuyor — bkz. `test_cleanup_runs_on_both_error_paths`.
- Kendi blob'u ≠ hedef blob'u ⇒ **exit 9**, hiçbir container kalkmadan, `git reset`ten önce.
- `run_release.sh`in bıraktığı `HOST_RELEASE_EXPECTED_BLOB` / `HOST_RELEASE_SOURCE_COMMIT` pinleri
  doğrulanır.
- Üç güvenlik işareti yoksa ⇒ exit 9 (eski bir commit hedef gösterilemez).
- **Kill-switch muhafızı artık yalnızca HEDEF commit'ten** okunur; "çalışma ağacındaki kopya
  kullanılıyor" yedeği **kaldırıldı** (o kopya denetlenen kod değildir). Ek olarak çıkarılan
  dosyanın blob'u hedefteki blob ile karşılaştırılır.
- `.env.production` yoksa artık **`die`** (eskiden yalnızca UYARI'ydı ve deploy devam ediyordu).
  Dosya yoksa compose zaten kalkmaz; "kontrol edildi" saymak olmayan bir kanıtı kanıt yerine
  koymak olurdu.
- `release.json`'a `deploy_script: {path, blob, commit}` yazılır: hangi betiğin dağıttığı kayda geçer.

### Katman C — `scripts/deploy/run_release.sh` (yeni, hash pinli başlatıcı)

```
bash run_release.sh --expected-self-blob <blob> <sha|ref> --no-gateway …
```

1. kendi blob'unu `--expected-self-blob` ile pinler (uymazsa exit 9),
2. hedef commit'ten `host-release.sh` **ve** `script_version_guard.py` dosyalarını çıkarır,
3. ikisinin blob'unu commit'teki kimlikle karşılaştırır,
4. karar kapısını çalıştırır,
5. **doğrulanmış kopyayı** `exec` eder (`HOST_RELEASE_SOURCE_COMMIT` + `HOST_RELEASE_EXPECTED_BLOB`).

`--verify-only` hiçbir şey çalıştırmaz (test: hedef betiğin `touch`'u **oluşmuyor**).

**Bootstrap dürüstlüğü:** bu muhafız ancak kendisini **taşıyan** deploy'dan itibaren kendini
uygular; onu içermeyen eski bir betik onu çalıştıramaz. İlk geçiş bu yüzden `run_release.sh` ile
yapılmalıdır — o da hedef commit'ten çıkarılır ve kendi blob'unu pinler. Bugünkü haliyle:

```
git -C /opt/tezlify fetch origin --prune
git -C /opt/tezlify show 38fe087:scripts/deploy/run_release.sh > /tmp/run_release.sh
HOST_RELEASE_REPO=/opt/tezlify bash /tmp/run_release.sh \
  --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
  release/backend-only-3.8.5 --no-gateway
```

`--expected-self-blob`, preflight'in yazdırdığı değerdir: eski/yanlış bir başlatıcı **kendini**
reddeder.

---

## 5. Kill-switch allowlist'i daraltıldı

| Değer | Önce (`config.py`) | Şimdi | Kapi (`persistence_flag_guard.py`) |
|---|---|---|---|
| yokluk | KAPALI | KAPALI | İZİNLİ (`flag_absent_defaults_off`) / adacıkta RED |
| `true`, `1` | AÇIK | **AÇIK** | RED (`flag_true_not_allowed`), `--allow-enabled` ile İZİNLİ |
| `false`, `0`, `no`, `off`, `n`, `f` | KAPALI | KAPALI | İZİNLİ (`flag_explicitly_false`) |
| `yes`, `on`, `y`, `t` | **AÇIK** | **KAPALI** + uyarı | RED (`flag_legacy_truthy_not_enabling`) |
| `banana`, `truely`, `evet`, `2`, boş | KAPALI | KAPALI + uyarı | RED (`flag_unparseable`) |

İki tarafın yönü bilerek farklı: **uygulama** servisi ayakta tutar ve süpürmeyi kapatır; **kapı**
deploy'u durdurur. İkisi de fail-closed, ama teşhis tek: "bu yazım yetki vermiyor". `yes` yazan bir
operatörün işi yarım kalmaz — süpürme açılmaz ve nedeni sessiz geçmez.

`yes`/`on`/`y`/`t` kapıda **eskiden de** RED alıyordu (`flag_true_not_allowed`); yani kapı
gevşetilmedi, gerekçe etiketi ayrıştırıldı. Uygulama tarafındaki daralma ise gerçek bir sıkılaşma.

Örnek env dokümantasyonu (`.env.example`) tek açık yolu ve yasak yazımları yazıyor.

---

## 6. Testler — gerçek çıkış kodları

| Kapı | Sonuç |
|---|---|
| Backend tam paket, `--randomly-seed=385` | **2040 passed / 4 skipped / exit 0** (137,9 s) |
| Backend tam paket, `-p no:randomly` | **2040 passed / 4 skipped / exit 0** (166,5 s) |
| Hedefli 7 dosya (script-guard, flag-guard, fail-closed, preflight, adacık izolasyonu, RAM snapshot, persistence) | **241 passed / exit 0** (3,8 s) |
| Gateway `npm test` | **exit 0** (PDO/TIMEOUT/WAITER_MISMATCH/NO_CHUNK senaryoları dâhil) |
| Frontend `npm run build` | **exit 0**, `✓ built in 8,71 s` (yalnızca bilinen >500 kB uyarısı) |
| `verify:i18n-keys` | **exit 0** — 2.425 tüketici çağrısı, en=3208 / tr=3208 |
| `verify:older-page-lock` / `verify:message-timeout-budget` | **exit 0** / **exit 0** |
| `git diff --check b5715fe..ref` | **exit 0** |
| `py_compile` (deploy betikleri + değişen testler) | **exit 0** |
| `bash -n host-release.sh` / `run_release.sh` | **exit 0** / **exit 0** |
| Gizli bilgi taraması (değişen dosyalar) | 2 isabet, **ikisi de sahte/şablon**: `.env.example` `your-secure-password` ve 3.8.4 dokümanının kendi sahte DSN açıklaması |

Test DB'si izole: `TEST_DB_PATH=/tmp/tezlify_385.db`, `DATABASE_URL` aynı dosyaya işaret ediyor,
`scripts/provision_test_db.py` ile 33 tablo kuruldu. Uyuşmazlık koruması
(`assert_test_db_matches_requested_path`) yerinde; hiçbir test üretim DB'sine dokunmadı.

### 6.1 Yeni testlerin gerçekten yük taşıdığının kanıtı

- `test_run_release_verify_only_passes_for_a_compliant_target` — sentetik depo, **exit 0**.
- `test_run_release_verify_only_rejects_a_target_without_the_guard` — **exit 9** +
  `script_missing_security_checks` gerekçesi.
- `test_run_release_rejects_a_target_without_the_version_guard_file` — **exit 9**.
- `test_run_release_rejects_a_doctored_launcher` — yanlış `--expected-self-blob` ⇒ **exit 9**.
- `test_run_release_never_runs_the_target_script_in_verify_only` — hedef betiğin yan etkisi
  (`touch`) **oluşmuyor**.
- `test_cli_allows_the_targets_own_script_but_denies_its_missing_markers` — gerçek `b5715fe`
  betiği: kimlik **eşit**, işaret **yok** ⇒ RED; `--no-marker-check` ile aynı dosya geçiyor. İki
  kontrolün neden ayrı gerektiğinin doğrudan kanıtı.

---

## 7. Üretimde uçtan uca kanıt (salt okunur dry-run)

Üretimde yalnızca `--dry-run` koştu; dry-run bloğu `mkdir`/container/DB problarından **önce**
çıkar, `git fetch` adımı da `run` sarmalayıcısı yüzünden **atlanır** (`[dry-run] git fetch …`).
Yani hiçbir yazma, hiçbir DB sorgusu olmadı.

```
CASE A  yeni betik (f2b7a9ae) + ESKİ hedef b5715fe   -> exit 9
        "calisan betik hedef commit'in betigi DEGIL (self=f2b7a9ae hedef=69da7b3c); deploy baslatilmadi"
CASE B  yeni betik (f2b7a9ae) + HEDEF 38fe087        -> exit 0
        "betik surum muhafizi GECTI: self=f2b7a9ae = hedef commit 38fe087"
        "gateway muhafizi GECTI: b5715fe..38fe087 arasinda gateway agaci degismedi"
        "[migration-guard] temiz: yikici migration satiri yok"
CASE C  YAYINDAKİ betik (69da7b3c, 0 muhafız) + HEDEF -> exit 0, plan yazıldı
        (hiçbir sürüm kontrolü yok — çelişkinin kendisi)
```

Üretimdeki `git fetch origin --prune` yalnızca uzak ref'leri ekledi; `HEAD` `b5715fe`, çalışma
ağacı **0 değişiklik**, `.deployed-commit` değişmedi.

---

## 8. Release ref

`release/backend-only-3.8.4` **sessizce değiştirilmedi**; sözleşme yeni bir ref gerektirdi çünkü
3.8.4 hedefi `script_version_guard.py`/`run_release.sh` taşımıyor ve preflight onu **haklı olarak**
reddetti (`IHLAL: hedef commit'te … yok`, exit 1).

Yeni ref plumbing ile üretildi (`read-tree` + `rm --cached` + `read-tree --prefix` + `write-tree` +
`commit-tree` + `update-ref`; çalışma ağacı hiç dokunulmadı):

| | Değer |
|---|---|
| Commit | **`38fe0879ed05da4a0944eb9f98f57a8fa20de431`** |
| Tree | `641a677b40c7e9d450b472d9c63a08acdd4f171c` |
| Ebeveyn | `84e3f38` |
| `whatsapp-gateway/` subtree | `339aa79…` = **`b5715fe` ile birebir** |
| `backend/` subtree | `0b251c6…` = **`main` ile birebir** |
| `scripts/` subtree | `336872c…` = **`main` ile birebir** |
| compose dosyaları | `docker-compose.prod.yml` `0efa3e1`, `docker-compose.yml` `dd0aed7` — base = main = ref |

Preflight (yerel ref **ve** `origin/release/backend-only-3.8.5`, ikisi de):

```
gateway/compose : 0 dosya degismis
backend vs main : 0 dosya farkli
backend vs base : 15 dosya degismis
host-release.sh : f2b7a9aeb5c4
run_release.sh  : 9284245fa56c
SONUC: GUVENLI                                                            exit 0
```

`run_release.sh --verify-only release/backend-only-3.8.5` → **exit 0** (`script_matches_target`);
aynı komut `3d3fc79` ve `b5715fe` için **exit 9** (muhafız dosyası hedefte yok).

Push **yalnızca** yeni ref için yapıldı: `PUSH_EXIT=0`, `origin` üzerinde
`refs/heads/release/backend-only-3.8.5 = 38fe087`, `refs/heads/main` hâlâ `848c172`. Force-push yok.

---

## 9. Üretim değişmezliği (§7) — başlangıç 16:34:56Z / bitiş 16:53:03Z

| Container | ID | StartedAt | RestartCount |
|---|---|---|---|
| tezlify-backend | `579085f13268` | 2026-10-27T22:25:45.511359648Z | **0** |
| tezlify-gateway | `5b867095d376` | 2026-10-27T17:25:57.8181699Z | **0** |
| tezlify-caddy | `ee66a5cab371` | 2026-10-12T13:12:45.795953636Z | **0** |
| tezlify-db | `f6d79c4a1f8b` | 2026-10-01T17:45:08.260956885Z | **0** |

Dört container da **birebir aynı** ID ve `StartedAt`; restart sayacı 0. `.deployed-commit` =
`b5715fe`, `HEAD` = `b5715fe`, `git status --porcelain` **0 satır**.

| Ölçüm | Başlangıç | Bitiş | Yorum |
|---|---|---|---|
| `conversations` | 125 | 125 | aynı |
| `messages` | 2046 | **2054** | +8 — **canlı ingest** (13:02→15:13 arasında da +51 olmuştu); sweep yayında yok |
| `contacts` | 1537 | 1537 | aynı |
| Oturum 201 | `CONNECTED` | `CONNECTED` | aynı |
| RAM yedeği (4 dosya) | `0600`, 7.100.080 B | aynı | dokunulmadı |

`/health` üzerinde `whatsapp_memory_persistence` alanı **`null`** — yayındaki `b5715fe` bu alanı
hiç içermiyor (3.8.1'den önceki kod). Bu iki şeyi kanıtlar: (a) yayındaki kodda süpürme yok,
(b) cutover sonrası `persist_flag_effective` kontrolü ancak **yeni** backend ayağa kalkınca
anlamlı olur — alan yoksa değer `unknown` döner ve kapı **durur** (fail-closed).

---

## 10. Bu aşamada YAPILMAYANLAR

- Deploy **yok** (`host-release.sh` yalnızca `--dry-run` ile, hiçbir container/DB yazımı olmadan).
- `WHATSAPP_MEMORY_PERSIST_ENABLED=true` **yapılmadı**; flag hiçbir yerde yazılmadı.
- Sweep/dry-run **başlatılmadı**; üretim DB'sine **hiç yazılmadı** (yalnızca `SELECT`).
- Gateway restart/recreate/logout/QR **yok**; gateway imajı ve belleği dokunulmadı.
- Migration **çalıştırılmadı**; RAM yedeği **değiştirilmedi/silinmedi**.
- Preflight, release guard veya testler **atlatılmadı**; hiçbir muhafız gevşetilmedi.

## 11. Açık kalanlar (ayrı onay gerektirir)

1. **Deploy** — `release/backend-only-3.8.5`, `run_release.sh` + blob pini ile.
2. **`main`in push edilmesi** — şu an yerelde 3 commit ileride (madde 6 gereği push edilmedi).
3. **`WHATSAPP_MEMORY_PERSIST_ENABLED=true`** — yalnızca deploy sonrası, `/health` ile kapalı
   olduğu doğrulandıktan sonra.
4. **`release/backend-only-3.8.4`** artık preflight'tan geçmiyor (bilinçli: yeni muhafızları
   taşımıyor). Kullanılmamalı.
5. Eski (3.8.1 öncesi) bir commit'i hedef göstermek **artık mümkün değil** — geri dönüş
   `--rollback-to <TS>` imaj etiketleriyle yapılır, SHA deploy'u ile değil.
