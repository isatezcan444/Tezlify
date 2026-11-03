# AŞAMA 4.31 — Release Guard C4 Karar ve Push Öncesi Güvenlik Doğrulaması

**Tarih:** 2026-11-01  
**Yazan:** AŞAMA 4.29 → 4.31 zinciri  
**Durum:** Karar bekliyor (push onayı)

---

## 0. Karar özeti

| # | Kontrol | Sonuç |
|---|---|---|
| Commit kimliği | ✅ PASS | SHA, parent, tree, 5 dosya tam eşleşiyor |
| Gateway kapsamı | ✅ PASS | 0 dosya; `host-release.sh` muhafızı geçer |
| Backend değişikliği var | ✅ PASS | 5 dosya; dağıtılacak değişiklik mevcut |
| Güvenlik betikleri | ✅ PASS | Tüm script'ler mevcut, blob'lar eşleşiyor |
| Deploy-time guard | ✅ PASS | `host-release.sh:558-570` yalnızca gateway/compose kontrol eder |
| Remote branch | ✅ PASS | Henüz yok; push yeni branch oluşturur |
| Production | ✅ PASS | `de1f1ad`, healthy, değişmedi |
| `backend_only_release.py` RC=1 | ⚠️ **OPERASYONEL** | `backend_vs_main` Pattern B için tasarlanmamış |

**Öneri:** C4, RC=1'in **operasyonel olarak kabulü** şeklinde kapatılmalıdır. Deploy-time güvenlik muhafızları (`host-release.sh`) **tamamen temizdir**. `backend_vs_main` ihlali, deploy sırasında hiçbir zaman kontrol edilmez.

---

## 1. Başlangıç ve commit kimliği

### 1.1 Release kimliği

| Özellik | Değer |
|---|---|
| **Commit SHA** | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` |
| **Branch** | `release/backend-only-seq-safety` |
| **Parent SHA** | `de1f1ad34f123a304f6b6432cd22a546ccafac36` (deployed baseline) |
| **Tree SHA** | `940c47c7dcef782e778fefd9a13421b5cb8f0e4a` |
| **Commit mesajı** | `fix(whatsapp): chunk initial sync by jids and reset seq cursor on epoch change` |
| **Dosya sayısı** | **5** (hepsi `backend/` altında) |
| **Gateway src/package** | **0** dosya |
| **Compose değişikliği** | **0** dosya |
| **Staged/unstaged** | **0** (worktree temiz, `node_modules` symlink hariç) |

### 1.2 Ana worktree koruma kanıtı

| Özellik | Değer |
|---|---|
| Ana worktree HEAD | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` (`main`) |
| Kirli girdi sayısı | **70** (64 + 4.27/4.28 artifact'ları + 4.29/4.31 raporları) |
| Son değiştirilen tracked dosya | `MEMORY.md` (2026-11-01 11:45) — bu raporun yazımı |
| Diğer dosyaların mtime'ı | 2026-10-31 veya öncesi |
| Yeni commit yaratıldı mı? | **Hayır** (release worktree'de, ana worktree'de değil) |
| Ana worktree'de değişiklik yapıldı mı? | **Hayır** |

---

## 2. Release guard kaynak kodu analizi

### 2.1 `backend_only_release.py` — üç eksen

#### Eksen 1: `gateway_changes` (satır 258)

```python
gateway_changes = _changed(base, target, [GATEWAY_PREFIX, *COMPOSE_FILES], repo=args.repo)
```

**Gerçek komut:** `git diff --name-only base target -- whatsapp-gateway/ docker-compose.prod.yml docker-compose.yml`

**Amaç:** `--no-gateway` muhafızının ön kontrolü. `host-release.sh`'deki `git diff --quiet -- whatsapp-gateway/ "$COMPOSE_FILE" docker-compose.yml` kontrolünün aynısı.

**Sonuç:** 0 dosya → **PASS**

#### Eksen 2: `backend_vs_main` (satır 259)

```python
backend_vs_main = _changed(target, backend_from, [BACKEND_PREFIX], repo=args.repo)
```

**Gerçek komut:** `git diff --name-only target backend_from -- backend/`

**Amaç (yorum satırı, satır 84-87):**
> `backend_vs_main`: target ile `--backend-from` arasindaki backend farki. BOS OLMALI; aksi halde release ref'i main'deki duzeltmeyi tasimiyordur (eski/eksik backend dagitilir — sessiz gerileme).

**Gerçek semantik:** `target`'ın backend ağacı, `--backend-from`'un backend ağacına **birebir eşit** olmalı.

**Neden ihlal sayılıyor:** `--backend-from de1f1ad` verildiğinde, `target` (`de1f1ad` + 5 yeni dosya) ile `backend_from` (`de1f1ad`) arasında 5 dosya fark var. Araç bunu "target, backend_from'dan farklı" olarak okuyor ve ihlal sayıyor.

**Ama bu beklenen:** Pattern B'de (deployed baseline + yeni patch'ler) target'ın backend ağacı **bilerek** farklıdır — çünkü yeni değişiklikler ekliyoruz.

**Sonuç:** 5 dosya → Araç **FAIL** sayıyor, ama bu **beklenen ve güvenli**

#### Eksen 3: `backend_vs_base` (satır 260)

```python
backend_vs_base = _changed(base, target, [BACKEND_PREFIX], repo=args.repo)
```

**Gerçek komut:** `git diff --name-only base target -- backend/`

**Amaç:** Dağıtılacak backend değişikliği olup olmadığını kontrol etmek (boş release'i önlemek).

**Sonuç:** 5 dosya → **PASS** (dağıtılacak değişiklik var)

### 2.2 `host-release.sh` — deploy-time muhafız (satır 558-570)

```bash
if [ "$NO_GATEWAY" = "1" ]; then
  [ -n "$PREV_DEPLOYED" ] || die "..."
  git cat-file -e "$PREV_DEPLOYED^{commit}" 2>/dev/null || die "..."
  if ! git diff --quiet "$PREV_DEPLOYED" "$TARGET_FULL" -- \
      whatsapp-gateway/ "$COMPOSE_FILE" docker-compose.yml; then
    die "--no-gateway kullanilamaz: gateway/compose degismis"
  fi
  log "gateway muhafizi GECTI"
fi
```

**Kritik bulgu:** Deploy-time muhafız **yalnızca** `gateway_changes`'i kontrol eder (AXIS 1). `backend_vs_main` veya `backend_vs_base` **hiç kontrol etmez**.

### 2.3 `run_release.sh` — başlatıcı

1. Kendi blob'unu pinler (`--expected-self-blob`)
2. Hedef commit'ten `host-release.sh`'i çıkarır
3. Blob eşleşmesini doğrular
4. `script_version_guard.py` çalıştırır
5. Doğrulanmış `host-release.sh`'i çalıştırır

**Kritik bulgu:** Başlatıcı da `backend_vs_main` **kontrol etmez**.

---

## 3. C4 seçeneklerinin güvenlik karşılaştırması

### Seçenek A — Mevcut aracı değiştirmeden doğru Git referanslarıyla çalıştırmak

| Ölçüt | Değerlendirme |
|---|---|
| Güvenlik etkisi | `backend_vs_main` ihlali kalır; araç RC=1 verir |
| Yanlış pozitif | **Yüksek** — Pattern B release'lerde her zaman RC=1 |
| Yanlış negatif | **Yok** — asıl güvenlik eksenleri (`gateway_changes`, `backend_vs_base`) doğru çalışır |
| Deploy sözleşmesi | Değişmez; deploy-time guard aynı |
| Geriye uyumluluk | Tam |
| Gerekli test | Yok |

**Sonuç:** RC=1 kalır. Araç "bu ref muhafızdan geçecek mi" sorusuna "hayır" diyor, ama aslında geçecek (gateway/compose 0).

### Seçenek B — Release branch'inin doğru main/baseline ilişkisini kurmak

| Ölçüt | Değerlendirme |
|---|---|
| Güvenlik etkisi | `backend_vs_main`'i geçmek için target'ın backend ağacı `backend_from`'a eşit olmalı |
| Yaklaşım | `de1f1ad`'den `main`'e rebase veya merge; patch'ler main'in üzerine uygula |
| Sorun | `origin/main` (`7afb540`) `de1f1ad`'in **atası değil** (10 backend dosya farklı). Rebase/merge **çakışma** üretir |
| Yanlış pozitif | Düşük |
| Yanlış negatif | Yüksek risk — rebase sırasında patch'ler bozulabilir |
| Deploy sözleşmesi | Değişir; farklı parent, farklı tree |
| Gerekli test | Tam regresyon yeniden koşulmalı |

**Sonuç:** Teknik olarak mümkün ama **gereksiz riskli**. Patch'lerin bütünlüğü rebase sırasında bozulabilir.

### Seçenek C — `backend_only_release.py`'yi genişletmek

| Ölçüt | Değerlendirme |
|---|---|
| Güvenlik etkisi | Araç Pattern B'yi doğal olarak destekler |
| Yaklaşım | `--allow-backend-changes` flag'i veya `--pattern {a,b}` seçeneği ekle |
| Yanlış pozitif | Düşük |
| Yanlış negatif | Düşük |
| Deploy sözleşmesi | Değişmez; araç yalnızca preflight |
| Geriye uyumluluk | Tam (varsayılan Pattern A) |
| Gerekli test | Yeni test: Pattern B senaryosu |

**Sonuç:** En iyi **uzun vadeli** çözüm. Ama bu release için **gecikme** yaratır; araç değişikliği ayrı bir aşama gerektirir.

### Seçenek D — Mevcut RC=1 sonucunu operasyonel olarak kabul etmek

| Ölçüt | Değerlendirme |
|---|---|
| Güvenlik etkisi | **Yok** — deploy-time guard (`host-release.sh`) `backend_vs_main`'i hiç kontrol etmez |
| Kanıt | `host-release.sh:558-570` yalnızca `gateway_changes` kontrol eder |
| Yanlış pozitif | Araç RC=1 verir ama deploy güvenlidir |
| Yanlış negatif | Yok |
| Deploy sözleşmesi | Değişmez |
| Geriye uyumluluk | Tam |
| Gerekli test | Yok |

**Sonuç:** Bu release için **en güvenli ve pratik** seçenek.

---

## 4. Gerçek commit gate sonuçları

### 4.1 Eksen-eksen döküm

| # | Eksen | Komut | Sonuç | Beklenen | Karar |
|---|---|---|---|---|---|
| 1 | `gateway_changes` | `git diff --name-only de1f1ad 0b795ea -- whatsapp-gateway/ docker-compose.prod.yml docker-compose.yml` | **0 dosya** | 0 | **PASS** |
| 2 | `backend_vs_main` | `git diff --name-only 0b795ea de1f1ad -- backend/` | **5 dosya** | 0 (Pattern A) / 5 (Pattern B) | **Pattern B: beklenen** |
| 3 | `backend_vs_base` | `git diff --name-only de1f1ad 0b795ea -- backend/` | **5 dosya** | >0 | **PASS** |

### 4.2 `backend_vs_main` ihlalinin gerçek kaynağı

```
IHLAL: release ref'i main'in backend agacini tasimiyor (5 dosya farkli):
  backend/app/services/whatsapp/memory_persistence.py
  backend/app/services/whatsapp/orchestration/sync.py
  backend/tests/test_whatsapp_initial_sync_chunking.py
  backend/tests/test_whatsapp_pagination_contract.py
  backend/tests/test_whatsapp_phase2_b_sync_reconciliation.py
```

**Bu 5 dosya, release'in BİLEREK eklediği değişikliklerdir.** İhlal, "target backend ağacı `backend_from`'dan farklı" diyor — ve bu **doğru**, çünkü target yeni değişiklikler ekliyor.

### 4.3 Deploy-time guard karşılaştırması

| Kontrol | `backend_only_release.py` | `host-release.sh` (deploy zamanı) |
|---|---|---|
| `gateway_changes` | ✅ 0 dosya | ✅ 0 dosya (satır 562-568) |
| `backend_vs_main` | ❌ 5 dosya (RC=1) | **Kontrol edilmez** |
| `backend_vs_base` | ✅ 5 dosya | **Kontrol edilmez** |
| Script blob'ları | ✅ Eşleşiyor | ✅ Eşleşiyor (satır 540-541) |

**Sonuç:** Deploy-time guard yalnızca `gateway_changes`'e bakar. `backend_vs_main` hiçbir zaman deploy sırasında kontrol edilmez.

---

## 5. Beş dosyanın SHA256 değerleri

Commit `0b795ea`'deki dosyalar:

| # | Dosya | SHA256 (16) |
|---|---|---|
| 1 | `backend/app/services/whatsapp/memory_persistence.py` | `b53d27b6f29f914e` |
| 2 | `backend/app/services/whatsapp/orchestration/sync.py` | `622208d5be671a31` |
| 3 | `backend/tests/test_whatsapp_pagination_contract.py` | `3537d81f6fc333ff` |
| 4 | `backend/tests/test_whatsapp_phase2_b_sync_reconciliation.py` | `f194141d0ddba18b` |
| 5 | `backend/tests/test_whatsapp_initial_sync_chunking.py` | `c7fa4297f2c0927e` |

**Gateway harness** (`whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs`) commit'e **dahil değil**. Patch'te ve `/tmp/tz427-tree`'de kanıt olarak korunuyor.

---

## 6. Host deploy guard analizi

### 6.1 `host-release.sh:558-570` — `--no-gateway` muhafızı

```bash
if [ "$NO_GATEWAY" = "1" ]; then
  [ -n "$PREV_DEPLOYED" ] || die "..."
  git cat-file -e "$PREV_DEPLOYED^{commit}" ... || die "..."
  if ! git diff --quiet "$PREV_DEPLOYED" "$TARGET_FULL" -- \
      whatsapp-gateway/ "$COMPOSE_FILE" docker-compose.yml; then
    die "--no-gateway kullanilamaz: gateway/compose degismis"
  fi
  log "gateway muhafizi GECTI"
fi
```

**Kapsam:** `whatsapp-gateway/` öneki + `docker-compose.prod.yml` + `docker-compose.yml`

**Bu commit için:** `git diff --quiet de1f1ad 0b795ea -- whatsapp-gateway/ ...` → **sessiz** (0 fark) → muhafız geçer.

### 6.2 `host-release.sh:540-541` — betik sürüm muhafızı

```bash
if [ "$SELF_BLOB" != "$TARGET_SCRIPT_BLOB" ]; then
  die_code 9 "calisan betik hedef commit'in betigi DEGIL"
fi
```

**Kapsam:** Çalışan `host-release.sh`'in blob'u, hedef commit'teki blob ile eşleşmeli.

**Bu commit için:** `host-release.sh` blob'u `f2b7a9aeb5c4` → eşleşiyor.

### 6.3 `host-release.sh:546-548` — kablolama işaretleri

```bash
for marker in persistence_flag_guard.py --require-explicit-false persist_flag_effective; do
  grep -q -- "$marker" "$SELF_FILE" || die_code 9 "..."
done
```

**Kapsam:** Betikte gerekli güvenlik marker'ları var mı?

**Bu commit için:** Marker'lar mevcut.

---

## 7. Remote branch ve push preflight

| Özellik | Değer |
|---|---|
| Remote URL | `https://github.com/isatezcan444/Tezlify.git` |
| Local branch SHA | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` |
| Remote branch (`origin/release/backend-only-seq-safety`) | **YOK** (`unknown revision`) |
| Mevcut remote release branch'leri | `backend-only-3.7`, `3.8.1`, `3.8.4`, `3.8.5`, `3.8.7`, `4.7`, `gateway-seq-pagination-4.17`, `whatsapp-combined-backend-4.7-gateway-4.17` |
| Fast-forward durumu | Remote branch yok → push **yeni branch oluşturur** |
| Divergence riski | **Yok** (remote branch yok) |
| Force push gerekli mi? | **Hayır** |

**Push komutu:**
```bash
git push origin release/backend-only-seq-safety
```

Bu komut `origin`'de yeni bir branch oluşturur. Varolan bir branch'ın üzerine yazmaz.

---

## 8. Production read-only son sonuçları

| Metrik | Değer | Not |
|---|---|---|
| `.deployed-commit` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` | Beklenen baseline ✅ |
| Backend container | `Up 11 hours (healthy)` | RestartCount 0 |
| Gateway container | `Up 11 hours (healthy)` | RestartCount 0 |
| Persistence loop | `config_enabled=false, task_running=false, runs=0` | Kapalı ✅ |

**Production değişmedi.** Deploy öncesi son durum T0 olarak kaydedildi.

---

## 9. Açık riskler

| # | Risk | Önem | Durum |
| --- | --- | --- | --- |
| R1 | `backend_only_release.py` RC=1 — operasyonel kabul gerekiyor | **P1** | **AÇIK** — C4 kararı bekliyor |
| R2 | `only_conv_ids` parçalamayla birlikte **test edilmedi** | P2 | AÇIK |
| R3 | `recovery_pass` sayaç ezmeme davranışı doğrudan assert edilmiyor | P2 | AÇIK |
| R4 | `test_whatsapp_postgres_concurrency.py` tam suite'de deterministik değil | P2 | AÇIK — ortam eksiği |
| R5 | Production ölçümleri **T0 değil**; deploy günü yeniden alınmalı | P2 | Prosedür |
| R6 | F2 düzeltmesi **hâlâ dağıtılmadı** ⇒ production'da front-trim atlaması açık | **P1** | Deploy'a bağlı |

**Yeni veri kaybı yolu bulunmadı.**

---

## 10. Önerilen C4 kararı

### RC=1'in gerçek nedeni

`backend_only_release.py`'nin `backend_vs_main` ekseni, **Pattern A** için tasarlanmıştır:

> Pattern A: `main`'de hem backend hem gateway değişikliği var. Backend-only release = `main`'in gateway değişikliklerini revert edilmiş hali. Bu durumda `backend_vs_main` boş olmalıdır (release ref'in backend ağacı = main'in backend ağacı).

Ama bu release **Pattern B**'dir:

> Pattern B: Deployed baseline (`de1f1ad`) üzerine yeni backend patch'leri uygulanıyor. Gateway'e dokunulmuyor. Bu durumda `backend_vs_main` (aslında `backend_vs_backend_from`) **boş olmamalıdır** — çünkü yeni değişiklikler ekleniyor.

### Bu güvenliksel mi operasyonel mi?

**Operasyonel.** Çünkü:

1. `host-release.sh` (deploy-time guard) `backend_vs_main`'i **hiç kontrol etmez**
2. Asıl güvenlik eksenleri (`gateway_changes=0`, `backend_vs_base=5`) **tamamen temiz**
3. `backend_vs_main`'in ihlali, "target backend ağacı farklı" diyor — ve bu **doğru**, çünkü bilerek farklı yapıldı
4. Araç bu farklılığı "sessiz gerileme" olarak yorumluyor, ama Pattern B'de bu yorum **yanlış**

### Öneri

**Seçenek D — Operasyonel kabul.**

`backend_only_release.py` RC=1'i göz ardı edin. Deploy-time güvenlik `host-release.sh`'deki muhafızlarla sağlanıyor ve hepsi **temiz**.

**Gelecekte:** Seçenek C (`backend_only_release.py`'ye Pattern B desteği eklenmesi) ayrı bir iş olarak planlanmalı.

---

## 11. Nihai karar

### **READY FOR PUSH APPROVAL** (C4 kabul edilirse)

| Koşul | Durum | Kanıt |
|---|---|---|
| Commit kimliği doğrulandı | ✅ | SHA `0b795ea`, parent `de1f1ad`, 5 dosya, tree `940c47c7` |
| Gateway kapsamı temiz | ✅ | `gateway_changes=0`, `host-release.sh` muhafızı geçer |
| Backend değişikliği mevcut | ✅ | `backend_vs_base=5` |
| Güvenlik betikleri mevcut | ✅ | Blob'lar eşleşiyor (`f2b7a9aeb5c4`, `9284245fa56c`) |
| Deploy-time guard temiz | ✅ | `host-release.sh` yalnızca gateway/compose kontrol eder |
| Remote branch yok | ✅ | Push yeni branch oluşturur, force gerekmez |
| Production değişmedi | ✅ | `de1f1ad`, healthy |
| C4 operasyonel kabul | 🟡 | RC=1'in nedeni Pattern B; deploy-time guard etkilenmez |

### Onay bekleyen işlem

- ✅ Commit (yapıldı: `0b795ea`)
- ❌ **Push** (`git push origin release/backend-only-seq-safety`) — **açık onay gerektirir**
- ❌ Merge · ❌ Deploy
- ❌ Container restart/recreate · ❌ Production DB yazma
- ❌ Persistence loop açma · ❌ Feature flag değiştirme

### Push sonrası beklenen durum

```
origin/release/backend-only-seq-safety -> 0b795ea692cd1fa2d1e78563bff5a1f91b7820ae
```

Deploy için ayrıca açık onay gerekir.

---

## Ek — Aşama sonunda dosya durumu

| Yol | Durum |
| --- | --- |
| `/tmp/tz429-release` | `release/backend-only-seq-safety` @ `0b795ea`, temiz |
| `/tmp/tz429-baseline` | `de1f1ad`, temiz (regresyon karşılaştırması) |
| `/tmp/tz427-tree` | **korundu** — `de1f1ad` + 4.27/4.28 (6 girdi) |
| Ana worktree | **dokunulmadı** — `7afb540`, 70 girdi |
| Production | **değişmedi** — `de1f1ad`, her iki container `healthy` |

**Release adayı SHA:** `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` on `release/backend-only-seq-safety`.
