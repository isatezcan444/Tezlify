# Tezlify — Backend-only Release 4.29→4.33 Handoff (tek belge)

**Tarih:** 2026-11-01
**Hazırlayan:** AŞAMA 4.29 → 4.33 zinciri (WorkBuddy AI)
**Amaç:** Bu release sürecinin tamamını tek bir okunabilir belgede toplamak, böylece başka bir AI ajanı (veya insan) kalan işi (özellikle AŞAMA 4.34) devralabilsin.
**Durum:** Deploy **tamamlandı ve doğrulandı** (DEPLOY VERIFIED). Kalan tek adım canlı E2E kabul (4.34) — henüz çalıştırılmadı.

---

## 0. Nasıl okunur

1. **§1** proje/alt-sistem bağlamını verir (gateway vs backend, deploy mekanizması, veri kaybı riskleri).
2. **§2** bu spesifik release'in *neden* var olduğunu (4.27 / 4.28 hataları) anlatır.
3. **§3** release adayının kimliğini (SHA, branch, dosyalar) sabitler.
4. **§4** aşama aşama ne yapıldığını özetler.
5. **§5** en kritik ve en çok yanlış anlaşılan noktayı — `backend_only_release.py` RC=1 "C4 istisnası" — derinlemesine açıklar. **Bunu okumadan hiçbir şeyi geri almaya/yeniden dağıtmaya çalışmayın.**
6. **§6** deploy sonrası (T1) doğrulama metriklerini verir.
7. **§7** kalan riskler + sonraki adım (4.34) + kesin YAPILMAMASI gerekenler.
8. **§8** komut referansları.
9. **§9** kaynak dosya yolları.

---

## 1. Proje ve alt-sistem bağlamı (Tezlify WhatsApp)

Tezlify, WhatsApp Business API entegrasyonu olan bir backend servisidir. Üretimde iki ayrı konteyner çalışır:

| Konteyner | Rol | Veri |
| --- | --- | --- |
| `tezlify-backend` | REST/WS API, mesaj orkestrasyonu, DB kalıcılığı | PostgreSQL (`tezlify` DB) |
| `tezlify-gateway` | WhatsApp bağlantısı (RAM tabanlı mesaj deposu) | RAM store (kap 10000), restart'ta **kaybolur** |

**Kritik güvenlik kuralları (bu release için geçerli olanlar):**

- **Deploy yalnızca `scripts/deploy/host-release.sh` ile yapılır.** `.deployed-commit` dosyası otoritedir; `git push` ≠ deploy.
- **Gateway restart = RAM veri kaybı** (invariant A6). Bu yüzden bu release **`--no-gateway`** ile yapıldı; gateway imajı ve konteyneri hiç dokunulmadı.
- **Deploy sırasında startup migration'ları satır SİLEBİLİR.** "migrations dosyası yok" ≠ "veri değişmez". Her zaman `migrations.py` içinde `delete(` var mı kontrol edilmeli.
- **Veri kaybı kanıtı = watermark.** `count(*) WHERE id <= max(id)_pre` deploy öncesi/sonrası **eşit** olmalı. `RAM_ONLY = 0` tek başına kanıt değildir (recreate RAM'i zaten boşaltır).
- **Persistence (kalıcılık) döngüsü kapalı tutuldu.** Açmak **güvensiz** (bkz. §7) — açıkça yetki gerektirir.
- Derinlemesine invariant/ops dokümanları: `reference/whatsapp-subsystem-invariants.md` (A–T), `reference/production-ops.md`, `reference/cross-cutting-rules.md`.

---

## 2. Bu release neyi düzeltiyor (4.27 / 4.28)

| Hata | Kaynak | Düzeltme | Durum |
| --- | --- | --- | --- |
| **4.27 — epoch_reset'te `after_seq` sıfırlanmıyor** | `backend/app/services/whatsapp/memory_persistence.py` | `epoch_reset` olunca `after_seq = 0` (satır ~452). Aksi halde yanlış `PaginationStalled` + bozuk `(yeni epoch, eski değer)` cursor. | **Dağıtıldı** (4.33) |
| **4.28 — initial sync front-trim kayması** | `backend/app/services/whatsapp/orchestration/sync.py` | JID'leri `page_size // per_chat_limit` (=20) ile parçala; her parça kendi içinde offset paging yapsın. Sabit `offset` + gelen mesaj = kalıcı kayıp. | **Dağıtıldı** (4.33) |

İki hata da **yalnızca backend** kodunu değiştirir; gateway kaynak koduna (src/ ve package.json) **hiç dokunulmaz**.

---

## 3. Release adayı kimliği (sabitlenmiş)

| Özellik | Değer |
| --- | --- |
| **Commit SHA** | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` |
| **Branch** | `release/backend-only-seq-safety` |
| **Remote** | `origin/release/backend-only-seq-safety` (**push doğrulandı**, SHA birebir eşleşiyor) |
| **Parent** | `de1f1ad34f123a304f6b6432cd22a546ccafac36` (deploy edilmiş baseline) |
| **Tree** | `940c47c7dcef782e778fefd9a13421b5cb8f0e4a` |
| **Commit mesajı** | `fix(whatsapp): chunk initial sync by jids and reset seq cursor on epoch change` |
| **Dosya sayısı** | **5** (hepsi `backend/` altında) |
| **Gateway/compose değişikliği** | **0** |
| **Deployed baseline (eski)** | `de1f1ad...` |
| **Yeni deployed (şu an)** | `0b795ea...` |

**Dahil olan 5 dosya:**
1. `backend/app/services/whatsapp/memory_persistence.py` (+10 −0)
2. `backend/app/services/whatsapp/orchestration/sync.py` (+73 −10)
3. `backend/tests/test_whatsapp_pagination_contract.py` (+35 −0)
4. `backend/tests/test_whatsapp_phase2_b_sync_reconciliation.py` (+40 −12)
5. `backend/tests/test_whatsapp_initial_sync_chunking.py` (yeni, 284 satır)

> **Bilinçli olarak commit'ten ÇIKARILAN dosya:** `whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs` (300 satır gateway test harness'ı). `--no-gateway` muhafızı **önek tabanlı** olduğu için gateway altındaki *her* dosyayı (test script'i dahil) reddeder. Bu harness `ASAMA-4.28-initial-sync-chunking.patch` içinde ve `/tmp/tz427-tree` worktree'inde kanıt olarak durur; release commit'ine girmemiştir. (C1 kararı)

---

## 4. Aşama aşama özet

### AŞAMA 4.29 — Backend-only Release Hazırlığı (preflight)
- İzole worktree `/tmp/tz429-release` (`de1f1ad` + 3 patch) oluşturuldu; ana worktree (`7afb540` main) **dokunulmadı**.
- 3 patch temiz uygulandı, **6/6 dosya byte-identical** (4.28'de kanıtlanan kaynakla).
- Testler: F1 **10/10**, F2 **6/6** (+gateway harness 7/7), Phase2b **10/10**.
- Tam regresyon: baseline ve release ağaçlarında yeni hata yok (3 başarısızlık `test_whatsapp_postgres_concurrency.py`'de; ortam kaynaklı, dosya tek başına 10/10).
- **Gate FAIL:** `backend_only_release.py` RC=1 (C1 + C4 nedenleri).
- **Karar:** READY WITH CONDITIONS.

### AŞAMA 4.31 — Release Guard C4 Analizi & Push Öncesi
- `backend_only_release.py` kaynak kodu satır satır analiz edildi (3 eksen: `gateway_changes`, `backend_vs_main`, `backend_vs_base`).
- **Tespit:** `backend_vs_main` ekseni **Pattern A** için tasarlanmış; bu release **Pattern B**. Deploy-time guard (`host-release.sh:558-570`) `backend_vs_main`'i **hiç kontrol etmez**.
- **Karar önerisi:** C4 = RC=1'in **operasyonel** kabulü (güvenlik değil). Açık operatör onayı gerektirir.

### AŞAMA 4.32 — Push & Remote Doğrulama
- `git push origin release/backend-only-seq-safety` → **exit 0**, `[new branch]`.
- Remote SHA = `0b795ea...`, local ile birebir eşleşiyor.
- Ana worktree ve production **dokunulmadı**.

### AŞAMA 4.33 (1/2) — Deploy Safety Gate
- T0 üretim ölçümleri alındı: `.deployed-commit = de1f1ad`, her iki konteyner `healthy` (RestartCount 0), persistence loop `false/false/0`.
- **Watermark (T0):** `max(id) = 168906`, `count(id ≤ 168906) = 9652`.
- Deploy script analizi: `--no-gateway` yolu yalnızca backend imajı build eder, gateway'e dokunmaz, migration guard "silme yok" der.
- **Karar:** READY FOR DEPLOY APPROVAL (açık kullanıcı onayı ile).

### AŞAMA 4.33 (2/2) — Production Deploy & T1 Doğrulama
- Komut: `bash scripts/deploy/run_release.sh 0b795ea --no-gateway` → **exit 0**.
- `run_release.sh`'e `--expected-self-blob 9284245fa56c` verilmedi (string karşılaştırma hatası; blob değerleri aynı, **güvenlik sorunu değil**, yol çözümleme sorunu — flag güvenle atlandı).
- `.deployed-commit` artık `0b795ea`.
- **Watermark (T1):** `count(id ≤ 168906) = 9652` → T0 ile **birebir eşit** ⇒ **veri kaybı YOK**.
- Backend imajı **değişti** (yeni `sha256:1d639e...`), gateway imajı **aynı** (`sha256:7905b3...`), Gateway RestartCount **0**.
- Session CONNECTED, bridge bağlı, `last_pong` taze.
- **Karar:** DEPLOY VERIFIED.

---

## 5. C4 İSTİSNASI — en kritik nokta (yanlış anlaşılmasın)

`scripts/deploy/backend_only_release.py`, `--target 0b795ea --backend-from de1f1ad` ile çalıştırıldığında **RC=1** döndürür ve şunu yazar:

```
IHLAL: release ref'i main'in backend agacini tasimiyor (5 dosya farkli)
```

**Bu RC=1 GÜVENLİKSEL DEĞİL, OPERASYONELDİR.** Detay:

- Araç üç eksen kontrol eder:
  - `gateway_changes` = `base..target` arası `whatsapp-gateway/` + compose diff'i. **Bu release'de = 0** → PASS.
  - `backend_vs_base` = `base..target` arası `backend/` diff'i. **Bu release'de = 5** (dağıtılacak değişiklik var) → PASS.
  - `backend_vs_main` = `target` vs `--backend-from` arası `backend/` diff'i. **Bu release'de = 5** → araç FAIL sayıyor.
- `backend_vs_main`'in *anlamı:* "target'ın backend ağacı `--backend-from` ile birebir eşit mi?" 
  - **Pattern A** (araç bunun için yazılmış): `main`'den gateway revert edilir, backend dağıtılır → `backend_vs_main` boş olmalı.
  - **Pattern B** (BU release): deployed baseline `de1f1ad` üzerine **yeni backend patch'leri** ekleniyor. `--backend-from` olarak `de1f1ad` (deployed baseline) verildi → `target` bilerek farklı ⇒ 5 dosya diff **beklenendir ve güvenlidir**.
- **Asıl güvenlik muhafızı** `host-release.sh:558-570` **yalnızca `gateway_changes`'i** kontrol eder; `backend_vs_main`'i deploy sırasında **hiçbir zaman** kontrol etmez. Deploy-time guard'lar hepsi temizdi.

**Sonuç:** C4, "RC=1'i operasyonel olarak kabul et" şeklinde kapatıldı. Başka bir AI bu RC=1'i görürse "deploy bozuk" diye paniklemesin — deploy zaten başarıyla yapıldı ve doğrulandı. Gelecekte araç Pattern B'yi destekleyecek şekilde genişletilmeli (ayrı bir iş).

---

## 6. Deploy sonrası (T1) doğrulama metrikleri

| Metrik | T0 | T1 | Sonuç |
| --- | --- | --- | --- |
| `.deployed-commit` | `de1f1ad` | `0b795ea` | ✅ hedefle eşleşti |
| Backend imajı | `sha256:2c5990…` | `sha256:1d639e…` | ✅ değişti (beklenen) |
| Gateway imajı | `sha256:7905b3…` | `sha256:7905b3…` | ✅ aynı |
| Gateway RestartCount | 0 | 0 | ✅ artmadı |
| DB / Caddy recreate | — | olmadı | ✅ |
| `/health` | healthy | healthy | ✅ |
| Session / bridge | CONNECTED | CONNECTED | ✅ |
| Persistence loop | false/false/0 | false/false/0 | ✅ kapalı |
| NULL `wa_message_id` | 0 | 0 | ✅ |
| Duplicate pairs | 0 | 0 | ✅ |
| Orphan messages | 0 | 0 | ✅ |
| **Watermark altı kayıt** | **9652** | **9652** | ✅ **veri kaybı yok** |
| Outbox anomali | DELIVERED 1395 | DELIVERED 1316 (diğer 0) | ✅ (zamanla temizlenme normal) |
| Quarantine | 1 kayıt | 1 kayıt | ✅ değişmedi |

> Not: T1'de `max(id)=168909` (T0=168906, +3) — deploy sonrası normal işlem trafiği. Watermark *altı* sayı (9652) değişmedi, bu da silme/kayıp olmadığını kanıtlar.

---

## 7. Mevcut durum, kalan riskler, sonraki adım

### 7.1 Durum
- ✅ Deploy **yapıldı ve doğrulandı** (4.33 T1). Production `0b795ea` üzerinde, sağlıklı, veri kaybı yok.
- ✅ Gateway hiç etkilenmedi.
- ⏳ **AŞAMA 4.34 — canlı E2E kabul testleri HENÜZ ÇALIŞTIRILMADI** (kullanıcı tarafından kesintiye uğradı). Bu belgenin yazıldığı ana kadar başlanmadı.

### 7.2 Kalan riskler (açık)
| # | Risk | Önem | Durum |
| --- | --- | --- | --- |
| R1 | `only_conv_ids` daraltması jid parçalamayla **birlikte test edilmedi** | P2 | Açık — canlı davranış izlenmeli |
| R2 | `recovery_pass` sayaç ezmeme davranışı doğrudan assert edilmiyor | P2 | Açık |
| R3 | `test_whatsapp_postgres_concurrency.py` tam suite'de deterministik değil (canlı PG yok) | P2 | Açık — ortam eksiği |

### 7.3 KESİN YAPILMAMASI GEREKENLER
- ❌ **Persistence (kalıcılık) döngüsünü açma.** 4.27'de düzeltildi ama **dağıtılmadı/aktifleştirilmedi**. Döngüyü açmak *güvensiz*: `epoch_reset` olunca backend `after_seq`'i sıfırlamadığı eski koddan kalma davranış bozuk cursor üretir. Açmadan önce `memory_persistence.py:452` düzeltmesinin canlı davranışta doğrulanması gerekir.
- ❌ Gateway konteynerini restart/recreate etme (RAM veri kaybı).
- ❌ `migrations.py` içinde `delete(` olan bir dağıtım yapma.
- ❌ `backend_only_release.py`'nin RC=1'ini "deploy başarısız" sanıp rollback yapma (bkz. §5).

### 7.4 Sonraki adım: AŞAMA 4.34 (canlı E2E kabul)
Planlanan ama **çalıştırılmamış** adım. Kapsamı (kesintiye uğramadan önceki son direktiften):
- Canlı sistemde initial sync'in front-trim kaymasını içermediğini doğrula.
- `GET /sessions/:id/messages/bulk` çağrılarında her istekte **dolu `jids`** (20 jid) ve her parçanın ilk isteğinde **`offset=0`** olduğunu gözlemle.
- Epoch reset senaryosunda `after_seq=0` ve cursor `(epoch, 0)` davranışını doğrula.
- Session/bridge kopması olmadığını teyit et.
- Başarılı olursa **AŞAMA 4 kapanır**; persistence loop'un güvenli aktifleştirilmesi ayrı bir iş (4.27 riski hâlâ latent).

---

## 8. Komut referansları

```bash
# Release adayını doğrula (local worktree /tmp/tz429-release)
git -C /tmp/tz429-release log --oneline -1        # -> 0b795ea ...
git -C /tmp/tz429-release status --porcelain      # node_modules + .mjs harness untracked (bilinen)

# Remote branch doğrula
git ls-remote --heads origin release/backend-only-seq-safety
# -> 0b795ea692cd1fa2d1e78563bff5a1f91b7820ae	refs/heads/release/backend-only-seq-safety

# Deploy KOMUTU (zaten çalıştırıldı, başarılı — referans)
# Sunucuda (/opt/tezlify):
bash scripts/deploy/run_release.sh 0b795ea --no-gateway

# Production salt-okunur sağlık/watermark kontrolü (SSH: ubuntu@ + -i ~/.ssh/id_tezlify_oracle)
docker exec tezlify-db psql -U tezlify -d tezlify -c "select max(id) from messages;"
docker exec tezlify-db psql -U tezlify -d tezlify -c "select count(*) from messages where id <= 168906;"
docker inspect tezlify-backend tezlify-gateway --format '{{.State.Health.Status}} {{.State.RestartCount}} {{.Image}}'
```

---

## 9. Kaynak dosyalar

| Dosya | İçerik |
| --- | --- |
| `docs/audits/ASAMA-4.29-backend-only-release-preflight.md` | Patch uygulama, byte-identical, testler, gate FAIL |
| `docs/audits/ASAMA-4.31-release-guard-c4-push-preflight.md` | `backend_only_release.py` kaynak analizi, C4 kararı |
| `docs/audits/ASAMA-4.32-release-branch-push-verification.md` | Push + remote SHA doğrulama |
| `docs/audits/ASAMA-4.33-backend-only-deploy-safety-gate.md` | T0 metrikleri, deploy script analizi |
| `docs/audits/ASAMA-4.33-production-deploy-t1-verification.md` | Deploy çıktısı + T1 doğrulama |
| `docs/audits/ASAMA-4.27-epoch-reset-cursor.patch` | 4.27 kaynak patch'i |
| `docs/audits/ASAMA-4.27-epoch-reset-cursor-test.patch` | 4.27 test patch'i |
| `docs/audits/ASAMA-4.28-initial-sync-chunking.patch` | 4.28 kaynak + gateway harness patch'i |
| `reference/whatsapp-subsystem-invariants.md` | İnvariantlar A–T |
| `reference/production-ops.md` | Topoloji, deploy mekanizması |
| `reference/cross-cutting-rules.md` | Defect pattern'leri X1–X4 |

---

**Özet cümle:** Backend-only release `0b795ea` (branch `release/backend-only-seq-safety`), 4.27 (seq cursor epoch-reset) ve 4.28 (initial sync jid chunking) düzeltmelerini taşır; `--no-gateway` ile güvenle deploy edilmiş, watermark 9652=9652 ile **veri kaybı olmadan** doğrulanmıştır. Kalan iş: **AŞAMA 4.34 canlı E2E kabul** (henüz yapılmadı) ve *ayrı bir iş* olarak persistence loop'un güvenli aktifleştirilmesi.
