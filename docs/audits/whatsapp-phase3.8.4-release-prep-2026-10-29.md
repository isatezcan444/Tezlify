# AŞAMA 3.8.4 — BACKEND-ONLY RELEASE HAZIRLIĞI VE KALICILIK ÖNCESİ GÜVENLİK KAPISI

**Tarih:** 2026-10-29 (15:13–15:25Z)
**Tür:** Release hazırlığı + doğrulama. **Deploy yok, üretim DB yazımı yok, sweep yok, gateway'e dokunulmadı.**
**Sonuç:** Yeni `release/backend-only-3.8.4` ref'i oluşturuldu ve preflight'tan **exit 0** ile geçti.

---

## 1. Başlangıç / bitiş

| | Değer |
|---|---|
| Branch | `main` (temiz ağaç, 0 değişiklik) |
| `HEAD` = `origin/main` | `848c1722ea11bbe306a89e0d561673aed463cca5` |
| Üretimde yayında (`.deployed-commit`) | `b5715fe90d0ff05ef497dcccbc87652efa10ccd1` |
| Eski release ref `release/backend-only-3.8.1` | `68ca4130ac7893e0a86fd48a77bf2ee2063bdfe6` (tree `6cca1da`) |
| **Yeni** `release/backend-only-3.8.4` | **`3d3fc7988dff1ade603b7e7c2bb41201e4f828eb`** (tree `37bd2f1`) |
| Bitiş `main` | `848c172` — **değişmedi**, push edilmedi |

---

## 2. Üretimde yayınlanan commit ve container değişmezliği

Başlangıç (15:13:53Z) ve bitiş (15:22:00Z) ölçümleri **birebir aynı**:

| Container | StartedAt | RestartCount | Durum | ID (kısa) |
|---|---|---|---|---|
| tezlify-backend | 2026-10-27T22:25:45Z | **0** | running | `579085f13268` |
| tezlify-gateway | 2026-10-27T17:25:57Z | **0** | running | `5b867095d376` |
| tezlify-caddy | 2026-10-12T13:12:45Z | **0** | running | `ee66a5cab371` |
| tezlify-db | 2026-10-01T17:45:08Z | **0** | running | `f6d79c4a1f8b` |

`.deployed-commit` = `b5715fe` (değişmedi). Oturum 201 = `CONNECTED` / `is_active=true`.
DB `messages=2033`, `conversations=125` — başlangıç ve bitiş aynı.
RAM **9.138 mesaj / 99 sohbet** — başlangıç ve bitiş aynı.

> Not: 13:02Z'deki 1.982'den 15:13Z'deki 2.033'e artış **benim işlemim değil**; sweep yayında yok
> (bkz. §3.5) ve erişim yalnızca `SELECT`/`GET`. 15:13–15:22 aralığında hiçbir sayı değişmedi.

3.8.3 yedeği değişmedi: `/var/backups/tezlify-ram/` içinde 4 dosya, `0600`, dizin `0700`,
`…T125755Z.rsnap` = 7.100.080 B (mtime 12:58 — dokunulmadı).

---

## 3. Eski release ref'i neden yetersizdi

`backend_only_release.py` sözleşmesi (kaynak koddan okundu, tahmin değil):

```
gateway_changes  = diff(base, target, [whatsapp-gateway/, docker-compose.prod.yml, docker-compose.yml])
backend_vs_main  = diff(target, --backend-from(=origin/main), [backend/])
backend_vs_base  = diff(base, target, [backend/])

gateway_changes BOŞ olmalı · backend_vs_main BOŞ olmalı · backend_vs_base BOŞ OLMAMALI
```

`host-release.sh:494-500` muhafızı aynı üç yolu (`whatsapp-gateway/`, `$COMPOSE_FILE`,
`docker-compose.yml`) `PREV_DEPLOYED..TARGET_FULL` üzerinde kontrol eder; ihlalde `die`.
**`docker-compose.staging.yml` muhafızda yok** (kapsam dışı, ayrıca doğrulandı).

Eski ref `68ca413` `main@59f8114`'ten kesilmişti. `main` ilerledikçe backend ağacı `main`'den
**bir dosya** saptı:

```
IHLAL: release ref'i main'in backend agacini tasimiyor (1 dosya farkli):
       backend/tests/test_ram_snapshot.py
backend vs main : 1 dosya farkli   → PREFLIGHT_EXIT=1
```

Bu dosya **yalnızca bir test**; çalışma zamanı davranışı yok. Ama sözleşme `backend/` ağacını
**bütün olarak** karşılaştırır, test/çalışma zamanı ayrımı yapmaz. Muhafızı gevşetmek yerine
sözleşmenin istediği koşulu gerçekten sağlayan ref üretildi.

**Ölçülen alt-ağaç kimlikleri (kanıt):**

| Alt-ağaç | eski ref 3.8.1 | yeni ref 3.8.4 | base `b5715fe` | `main` |
|---|---|---|---|---|
| `whatsapp-gateway/` | `339aa791d51c` | `339aa791d51c` | `339aa791d51c` | `e19157a8d232` |
| `backend/` | `5c7361ad6384` (**bayat**) | `b2da7fd2cf2b` | — | `b2da7fd2cf2b` |

Yani yeni ref **tam olarak** "`main`'in ağacı + `whatsapp-gateway/` yayındaki hâliyle".
`backend/` dışı ve `whatsapp-gateway/` dışı fark `main`'e göre **0 dosya**.

---

## 4. Release kapsamı — üç grup

### 4.1 Zorunlu backend çalışma zamanı (5 dosya)

| Dosya | Δ | Ne çözüyor | Aşama |
|---|---|---|---|
| `backend/app/core/config.py` | +58 | `WHATSAPP_MEMORY_PERSIST_ENABLED` varsayılanı `False` + fail-closed doğrulayıcı | 3.8.1 |
| `backend/app/main.py` | +76 | lifespan kapısı (satır 406), kapanışta iptal, `/health` alanı (satır 877) | 3.6 + 3.8.1 |
| `backend/app/services/whatsapp/memory_persistence.py` | **+581 (yeni)** | süpürmenin kendisi: sayfalama, imleç, idempotent yazma, kill-switch | 3.6 / 3.8.1 |
| `backend/app/services/whatsapp/orchestration/sync.py` | +19/−1 | sync yoluna `request_id` + log korelasyonu | 3.6 (`ba39e56`) |
| `backend/app/services/whatsapp_gateway.py` | +6 | `request_id` iletimi | 3.6 |

**Migration gerekmez.** Tekillik mevcut kısmi indeksten gelir:
`(conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL`.

### 4.2 Testler, tanılama, dokümantasyon (release'e giren, çalışma zamanı olmayan)

`backend/tests/conftest.py` (+39, fail-closed test DB muhafızı) ve 8 test dosyası
(`test_deploy_backend_only_release`, `test_deploy_persistence_flag_guard`,
`test_diagnostics_audit_memory_gap`, `test_memory_persist_fail_closed`, `test_ram_snapshot`,
`test_whatsapp_memory_persistence`, `…_hardening`), `scripts/deploy/backend_only_release.py`,
`scripts/deploy/persistence_flag_guard.py`, `scripts/diagnostics/audit_memory_gap.py`,
`scripts/diagnostics/ram_snapshot.py`, `scripts/deploy/host-release.sh` (+79),
`docs/audits/*.md`, `WHATSAPP_PHASE3_*.md`, `.workbuddy-ai/memory/*`, `.gitignore`.

**Neden testler ref'te:** sözleşme `backend/` ağacını bütün olarak karşılaştırır; testleri dışarıda
bırakmak `backend_vs_main ≠ 0` yapar ve preflight'ı **exit 1**'e düşürür. Testler çalışma zamanında
yüklenmez.

**`scripts/deploy/host-release.sh` neden ref'te:** kalıcılık muhafızı bu betiğin içinde (+79 satır,
`PERSIST_GUARD_PY`, `persist_flag_effective`, `-e …=false` zorlaması, cutover öncesi/sonrası
kontroller). Ref'te 16 referans var; **yayındaki `b5715fe` sürümünde 0** (bkz. §7 risk 1).

### 4.3 Release dışı (gateway/frontend/compose/caddy)

`whatsapp-gateway/` altında `main`'de 8 dosya değişmiş (`package.json`, `src/index.js`,
`src/messages/message-store.js`, `src/session-manager.js`, `src/socket/socket-events.js`,
`src/utils/whatsapp-identity.js`, 2 test betiği) — **hepsi ref dışında**, yayındaki hâliyle.
Frontend, Caddy, compose dosyalarında `main`'de değişiklik **yok**.

**Kontrat kontrolü (yayındaki gateway ile uyum):**

| Parametre | Yayındaki `b5715fe` gateway | Sonuç |
|---|---|---|
| `perChatLimit` | **var** (3 referans) | süpürme sohbet başına 2.000 isteyebilir — kritik olan bu |
| `request_id` | **yok** (0 referans) | bilinmeyen query paramı yok sayılır ⇒ zararsız ama korelasyon özelliği gateway deploy'una kadar **etkisiz** |

---

## 5. Kalıcılık güvenlik kapısı — kod ve test kanıtı

### 5.1 Çalışma zamanında ölçüldü (gerçek `Settings` + lifespan predicate)

| Ortam | `Settings` değeri | Süpürme |
|---|---|---|
| değişken **yok** | `False` | **KAPALI** |
| `""` (boş) | `False` | **KAPALI** |
| `false` | `False` | **KAPALI** |
| `0` | `False` | **KAPALI** |
| `banana` (çözülemez) | `False` + uyarı | **KAPALI** |
| `ture` (yazım hatası) | `False` + uyarı | **KAPALI** |
| `true` | `True` | AÇIK |
| `1` | `True` | AÇIK |

> **Sapma (dürüstçe):** doğrulayıcının "açan" kümesi `{1,true,yes,on,y,t}` — istenen "yalnızca
> true/1"den **geniş**. Hâlâ bir *allowlist*: belirsiz hiçbir değer açmıyor (`enable`, `evet`,
> `2`, `truely` → kapalı). Testler bu kümeyi pinliyor (`test_explicit_true_enables`).
> Daraltmak davranış değişikliğidir ve bu aşamanın kapsamı dışıdır; ayrı karar olarak öneriliyor.

### 5.2 İki bağımsız kapı

- **Lifespan** (`main.py:406`): `getattr(settings, "…_ENABLED", False)` → görev hiç oluşturulmaz.
- **Turun içi** (`memory_persistence.py:456`): aynı kontrol tekrar edilir; CLI/elle çağrı da
  kapalıyken yazmaz. `test_run_once_is_a_noop_when_flag_is_off` bunu pinler.

### 5.3 Davranış matrisi (hepsi testle pinli)

| Gereksinim | Test | Sonuç |
|---|---|---|
| Inactive/disconnected hat süpürülmez | `test_inactive_line_is_skipped` | `status=='CONNECTED' AND is_active` |
| Dry-run satır yazmaz | `test_dry_run_writes_nothing` | commit yok, `inserted` yalnızca sayım |
| Dry-run imleci ilerletmez | `test_dry_run_does_not_advance_the_cursor` | `if not dry_run: cursors[...]` |
| Hata → rollback + görünür durum | `test_partial_db_error_then_safe_retry` | `db.rollback()`, `errors_total`, `last_error` |
| Tenant sınırı | `test_other_tenant_jid_is_not_written` | `get_user_filter` |
| Bilinmeyen LID köprüsü atlanır | `test_unmapped_lid_chat_is_skipped` | tahmin yok (A14/T) |
| Kimliksiz kayıt çoğalmaz | `test_message_without_wa_id_is_never_duplicated` | yazılmaz, sayılır |
| Preview geri sarmaz | `test_older_messages_do_not_rewind_last_message_at` | `apply_conversation_last_message` **hiç çağrılmıyor** (kaynakta 0 referans) |
| `/health` sır/PII sızdırmaz | `test_safe_error_strips_sql_and_bound_parameters`, `test_health_status_never_contains_cursor_keys`, `test_health_payload_carries_the_flag_without_leaking` | `_safe_error` yalnızca tür+SQLSTATE; imleçler toplu |
| Kesinti yarım sayfa bırakmaz | `test_cancellation_propagates_and_leaves_no_half_written_page` | sayfa başına tek INSERT |

### 5.4 Gerçek üretim env kaynaklarına karşı guard (salt okunur)

| Kaynak | Satır | Varsayılan mod | `--require-explicit-false` |
|---|---|---|---|
| Canlı backend container env (**adayın kaynağı**) | 37 | `IZINLI (flag_absent_defaults_off)` exit 0 | **RED** exit 1 |
| `/opt/tezlify/.env.production` (**cutover kaynağı**) | 38 | — | **RED** exit 1 |
| Sabitlenmiş örnek (`…=false`) | 1 | — | `IZINLI` exit 0 |

Flag **hiçbir** üretim kaynağında tanımlı değil (`.env.production` 0, canlı container 0, üç compose
dosyası 0). Yani `-e WHATSAPP_MEMORY_PERSIST_ENABLED=false` zorlaması **taşıyıcı**; süs değil.

---

## 6. Testler

Tüm koşular **taze provision edilmiş, izole** SQLite üzerinde; `TEST_DB_PATH == DATABASE_URL`
(uyuşmazlık fail-closed: `RuntimeError`, **exit 1**, 0,47 s — yeniden doğrulandı).
Üretim DSN'i hiçbir test sürecine verilmedi.

| Kapı | Komut | Sonuç |
|---|---|---|
| Tam backend paketi (rastgele sıra, seed `1101641911`) | `pytest backend/tests/ -q` | **1.974 passed, 4 skipped**, exit **0** (165,3 s) |
| Tam backend paketi (sabit sıra) | `… -p no:randomly` | **1.974 passed, 4 skipped**, exit **0** (164,4 s) |
| Hedefli grup (7 dosya, 2 koşu) | persistence + snapshot + release guard | **197 passed** ×2, exit **0** |
| Test DB uyuşmazlığı | `TEST_DB_PATH≠DATABASE_URL` | **exit 1**, `RuntimeError` |
| Gateway | `npm test` (repo kodu, üretim gateway'i başlatılmadı) | exit **0**, 0 FAIL |
| Frontend build | `npm run build` | exit **0**, 8,71 s |
| i18n | `verify:i18n-keys` | 2.425 çağrı / en=tr=3.208, exit **0** |
| Older-page lock / state | `verify:older-page-lock` / `-state` | 9 / 6 kontrol, exit **0** |
| Timeout bütçesi | `verify:message-timeout-budget` | 3 kontrol, exit **0** |
| `git diff --check` | — | temiz, exit **0** |
| Python derleme | `py_compile` (9 değişen dosya) | exit **0** |
| Gizli bilgi taraması | release diff üzerinde | 1 isabet: `test_restore_refuses_production_database` içindeki **sahte** DSN `postgresql://u:p@db:5432/tezlify` — gerçek sır değil |

---

## 7. Preflight ve deployment planı

```
$ python3 scripts/deploy/backend_only_release.py \
    --base b5715fe90d0ff05ef497dcccbc87652efa10ccd1 \
    --target release/backend-only-3.8.4

base            : b5715fe90d0f
target          : 3d3fc7988dff
backend kaynagi : 848c1722ea11 (origin/main)
gateway/compose : 0 dosya degismis (0 olmali)
backend vs main : 0 dosya farkli (0 olmali)
backend vs base : 13 dosya degismis (>0 olmali)
SONUC: GUVENLI — bu ref `--no-gateway` muhafizindan gececek.
PREFLIGHT_384_EXIT=0
```

Karşılaştırma: eski ref aynı tabanla **exit 1** (`backend vs main: 1 dosya`) — muhafızın hâlâ
fail-closed olduğunun kanıtı, gevşetilmedi.

Bağımsız sınır kontrolü (betiğe güvenmeden):

```
git diff --quiet b5715fe release/backend-only-3.8.4 \
    -- whatsapp-gateway/ docker-compose.prod.yml docker-compose.yml docker-compose.staging.yml
→ EXIT=0
```

**Çalıştırılacak komut (bu aşamada ÇALIŞTIRILMADI):**

```
bash scripts/deploy/host-release.sh release/backend-only-3.8.4 --no-gateway --health-timeout 180
```

---

## 8. Release dışında kalanlar ve kapsam daraltma

Ref "`main` + gateway dondurulmuş" olduğu için `main`'deki doküman/memory/test dosyaları da ref'te.
Bunlar çalışma zamanında yüklenmez. **Kasıtlı tercih:** ref'i elle seçilmiş bir alt kümeye indirmek,
hiçbir muhafızın doğrulamadığı bir kapsam iddiası üretirdi — bu aşamanın kaldırmaya çalıştığı şeyin
ta kendisi.

Gerçek anlamda daraltılabilecek tek şey `sync.py` + `whatsapp_gateway.py` (25 satır, `request_id`):
yayındaki gateway bu parametreyi tanımıyor, yani bugün **etkisiz**. Ama sözleşme backend ağacını
bütün olarak karşılaştırdığı için ref'ten çıkarmak preflight'ı düşürür. **Öneri (uygulanmadı):**
`request_id` yeteneği gateway deploy'uyla birlikte gelsin; o zamana kadar backend-only ref'te kalması
zararsız.

---

## 9. Kalan riskler ve engeller

1. **`host-release.sh` sürümü kritik.** Kalıcılık muhafızı ref'in betiğinde (+79 satır) var,
   yayındaki `b5715fe` betiğinde **yok**. Deploy sırasında çalışan betik her zaman *checkout'taki*
   sürümdür ⇒ operatör **hedef commit'in kopyasını** çalıştırmalı:
   `git show 3d3fc79:scripts/deploy/host-release.sh > /tmp/hr.sh; bash /tmp/hr.sh …`.
   Aksi hâlde kod varsayılanı (`False`) hâlâ korur, ama `-e …=false` zorlaması ve cutover sonrası
   `/health` doğrulaması **çalışmaz**.
2. **`yes/on/y/t` de açıyor** (§5.1 sapması). Fail-closed ruhu korunuyor; harfiyen "true/1" değil.
3. **Sweep üretimde hiç çalıştırılmadı**, `dry_run` dahil. İlk turun yerinde davranışı ölçülmedi.
4. **RAM'deki 9.138 mesaj hâlâ korunmasız** ve tavandaki 2 sohbet her yeni mesajda en eskisini atıyor.
   3.8.3 yedeği **zamanla değersizleşir**.
5. **Yedek anahtarı** oturum kimlik bilgileriyle aynı (`GATEWAY_ENCRYPTION_KEY`) ⇒ dağıtım sırrına
   erişen arşivi çözer.
6. **Medya ve daha önce atılmış mesajlar** kapsam dışı (3.8.3 raporu).
7. Ref `main`'i birebir yansıttığı için `docs/`, `.workbuddy-ai/memory/` gibi dosyalar da host
   checkout'una iner; işlevsiz ama diff gürültüsü.

---

## 10. Ayrı onay gerektiren sonraki işlemler

1. **Deploy** (`host-release.sh release/backend-only-3.8.4 --no-gateway`) — hedef commit'in betik
   kopyasıyla, backend-önce sırası korunarak.
2. **`WHATSAPP_MEMORY_PERSIST_ENABLED=true`** — yalnızca deploy sonrası, `/health` ile kapalı
   olduğu doğrulandıktan ve `dry_run` turu gözlendikten sonra.
3. **Taze RAM snapshot** (3.8.3 yedeği eskiyor).
4. **`yes/on/y/t` allowlist'ini daraltmak** (davranış değişikliği, ayrı test güncellemesi ister).
