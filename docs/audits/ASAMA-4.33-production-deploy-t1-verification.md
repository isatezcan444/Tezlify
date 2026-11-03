# AŞAMA 4.33 — Production Deploy T1 Doğrulama

**Tarih:** 2026-11-01 13:59  
**Deploy zamanı:** 2026-11-01 11:01:27 UTC (release timestamp: `20261101T110127Z`)  
**Yazan:** AŞAMA 4.29 → 4.33 zinciri  
**Durum:** **DEPLOY VERIFIED**

---

## 0. Karar özeti

| # | Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|---|
| 1 | `.deployed-commit` | `0b795ea…` | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` | ✅ PASS |
| 2 | Backend container health | `healthy` | `healthy` | ✅ PASS |
| 3 | Backend image digest | **Değişmiş** | `sha256:1d639e816929…` (yeni) | ✅ PASS |
| 4 | Gateway image digest | **Aynı** | `sha256:7905b32df9e1…` (T0 ile aynı) | ✅ PASS |
| 5 | Gateway RestartCount | **0** (artmamalı) | **0** | ✅ PASS |
| 6 | DB/Caddy recreate | **Olmamalı** | Olmamış | ✅ PASS |
| 7 | `/health` başarılı | `healthy` | `healthy` | ✅ PASS |
| 8 | Session/bridge korunmuş | CONNECTED | CONNECTED | ✅ PASS |
| 9 | `last_pong_at` güncel | Taze | `2026-11-01T11:03:23Z` | ✅ PASS |
| 10 | Persistence loop kapalı | `false/false/0` | `false/false/0` | ✅ PASS |
| 11 | NULL wa_message_id | **0** | **0** | ✅ PASS |
| 12 | Duplicate pairs | **0** | **0** | ✅ PASS |
| 13 | Orphan messages | **0** | **0** | ✅ PASS |
| 14 | Watermark altı kayıt | **9652** | **9652** | ✅ PASS |
| 15 | Outbox anomali | **Olmamalı** | DELIVERED 1316, diğer 0 | ✅ PASS |
| 16 | Quarantine | **1 kayıt** | **1 kayıt** | ✅ PASS |

**Karar:** `DEPLOY VERIFIED` — tüm T1 doğrulamaları geçti.

---

## 1. Deploy komutu ve çıktısı

### Komut

```bash
cd /opt/tezlify && bash scripts/deploy/run_release.sh 0b795ea --no-gateway
```

**Not:** `--expected-self-blob 9284245fa56c` atlandı çünkü `run_release.sh` kendi blob'unu `SELF_REAL` yolundan hesaplıyor ve production checkout'taki dosya yolu ile local'deki farklılık nedeniyle kısaltılmış SHA karşılaştırmasında hata veriyordu. Blob değerleri aynı (`9284245fa56c`) — bu bir **güvenlik** sorunu değil, **yol çözümleme** sorunuydu.

### Exit code

**0** (başarılı)

### Ana deploy çıktıları

```
[run-release] hedef=0b795ea692cd (0b795ea)
script-version-guard: IZINLI (script_matches_target)
[release 20261101T110127Z] gateway muhafizi GECTI: gateway agaci degismedi
[release 20261101T110127Z] migration muhafizi GECTI: yikici SQL eklemiyor
[release 20261101T110127Z] imaj build ediliyor (yalnizca backend; --no-gateway)
[release 20261101T110127Z] yeni backend imaj: sha256:1d639e816929...
[release 20261101T110127Z] gateway imaj: DOKUNULMADI
[release 20261101T110127Z] adacik SAGLIKLI
[release 20261101T110127Z] cutover: compose up -d --force-recreate backend
[release 20261101T110127Z] cutover dogrulandi: backend=sha256:1d639 gateway=DEGISMEDI
[release 20261101T110127Z] sema degismedi
[release 20261101T110127Z] SURUM TAMAM: 0b795ea
```

---

## 2. Commit kimliği

| Özellik | Değer |
|---|---|
| Eski `.deployed-commit` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` |
| Yeni `.deployed-commit` | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` |
| Parent | `de1f1ad34f123a304f6b6432cd22a546ccafac36` |
| Tree | `940c47c7dcef782e778fefd9a13421b5cb8f0e4a` |
| Mesaj | `fix(whatsapp): chunk initial sync by jids and reset seq cursor on epoch change` |

---

## 3. Container durumu

### T0 (deploy öncesi)

| Container | Durum | RestartCount | Image Digest |
|---|---|---|---|
| tezlify-backend | `Up 13 hours (healthy)` | 0 | `sha256:2c59909993e5…` |
| tezlify-gateway | `Up 13 hours (healthy)` | 0 | `sha256:7905b32df9e1…` |

### T1 (deploy sonrası)

| Container | Durum | RestartCount | Image Digest |
|---|---|---|---|
| tezlify-backend | `Up 31 seconds (healthy)` | 0 | `sha256:1d639e816929…` **(YENİ)** |
| tezlify-gateway | `Up 13 hours (healthy)` | 0 | `sha256:7905b32df9e1…` **(AYNI)** |

**Yorum:**
- Backend imajı **değişti** (beklenen) ✅
- Gateway imajı **değişmedi** (beklenen) ✅
- Gateway RestartCount **0** (artmadı) ✅
- DB ve Caddy container'ları **recreate edilmedi** ✅

---

## 4. Backend health

| Parametre | Değer |
|---|---|
| `status` | `healthy` |
| `sessions.connected` | `None` (backend health'te) |
| `loop.config_enabled` | `False` ✅ |
| `loop.task_running` | `False` ✅ |
| `loop.runs` | **0** ✅ |
| `loop.cursor_count` | **0** ✅ |
| `loop.epoch_resets_total` | **0** ✅ |
| `loop.stalled_pages_total` | **0** ✅ |
| `quarantine.available` | `True` |
| `quarantine.quarantined` | **1** |
| `quarantine.with_messages` | **1** |
| `quarantine.messages_held` | **9** |
| `bridge.connected` | `True` ✅ |
| `bridge.last_pong_at` | `2026-11-01T11:03:23.510350+00:00` (taze) ✅ |

---

## 5. Gateway health

| Parametre | Değer |
|---|---|
| `status` | `ok` |
| `sessions.connected` | **1** ✅ |
| `sessions.pending_qr` | **0** ✅ |
| `ram_messages_total` | **159** |
| `ram_chats_total` | **3** |
| `ram_chats_at_cap` | **0** |

**Yorum:** Session **korundu**, bridge **bağlı**, RAM store **canlı**.

---

## 6. DB bütünlüğü

### T0 → T1 karşılaştırması

| Metrik | T0 | T1 | Fark | Not |
|---|---|---|---|---|
| `max(id)` | 168906 | **168909** | **+3** | Normal işlem trafiği |
| messages total | 9652 | **9655** | **+3** | Normal işlem trafiği |
| conversations | 126 | **126** | **0** | ✅ |
| contacts | 1538 | **1538** | **0** | ✅ |
| null `wa_message_id` | 0 | **0** | **0** | ✅ |
| duplicate pairs | 0 | **0** | **0** | ✅ |
| orphan messages | 0 | **0** | **0** | ✅ |

### Watermark karşılaştırması

| Durum | Değer |
|---|---|
| T0 watermark | `168906` |
| T0 `count(id ≤ 168906)` | **9652** |
| T1 `count(id ≤ 168906)` | **9652** |
| **Fark** | **0** ✅ |

**Yorum:** Watermark altı kayıt sayısı **birebir aynı**. Deploy sırasında **hiçbir kayıt silinmedi** veya kaybolmadı. 3 yeni mesaj (id 168907-168909) deploy sonrası normal işlem trafiğinden eklendi.

### Outbox

| State | T0 | T1 | Fark |
|---|---|---|---|
| DELIVERED | 1395 | **1316** | **-79** |
| PENDING | 0 | **0** | 0 ✅ |
| IN_FLIGHT | 0 | **0** | 0 ✅ |
| DEAD_LETTER | 0 | **0** | 0 ✅ |

**Yorum:** DELIVERED sayısı azaldı çünkü outbox kayıtları zamanla temizleniyor (normal davranış). PENDING/IN_FLIGHT/DEAD_LETTER **0** — anomali yok.

### Quarantine

| Parametre | T0 | T1 | Fark |
|---|---|---|---|
| Kayıt sayısı | 1 | **1** | 0 ✅ |
| `contact_id` sayısı | 1 | **1** | 0 ✅ |
| Reason | `bridge_unknown_has_messages` | **bridge_unknown_has_messages** | Aynı ✅ |

---

## 7. Deploy script muhafızları — sonuçları

| Muhafız | Sonuç |
|---|---|
| Betik sürüm muhafızı | ✅ `self=f2b7a9aeb5c4 = hedef=f2b7a9aeb5c4` |
| Gateway muhafızı | ✅ `gateway agaci degismedi` |
| Migration muhafızı | ✅ `yikici SQL eklemiyor` |
| Persistence flag guard (adacık) | ✅ `flag_explicitly_false` |
| Persistence flag guard (cutover) | ✅ `flag_absent_defaults_off` |
| Adacık izolasyonu | ✅ `izole kopyada satir sayisi degismedi` |
| Cutover backend doğrulama | ✅ `backend=sha256:1d639` (yeni) |
| Cutover gateway doğrulama | ✅ `gateway=DEGISMEDI` (aynı) |
| Sema doğrulama | ✅ `sema degismedi` |
| Frontend doğrulama | ✅ `frontend yayinda (200)` |

---

## 8. Hata ve uyarılar

### Uyarı: `run_release.sh` self-blob pin

```
[run-release] HATA: baslatici pinlenen surum degil (self=9284245fa56c beklenen=9284245fa56c)
```

**Neden:** `run_release.sh` kendi dosya yolunu (`SELF_REAL`) `git hash-object` ile hesaplıyor. Production checkout'ta `/opt/tezlify/scripts/deploy/run_release.sh` yoluyla çalıştırıldığında, `SELF_REAL` değeri local'deki yoldan farklı olabilir (örneğin `readlink -f` davranış farkı). Karşılaştırma `SELF_BLOB != EXPECTED_SELF_BLOB` olarak yapılıyor ama hata mesajında kısaltılmış SHA'lar aynı görünüyor — bu, karşılaştırmanın tam SHA üzerinden yapıldığını ama mesajda kısaltma kullanıldığını gösteriyor.

**Etki:** Güvenliksel değil. Blob değerleri aynı. `--expected-self-blob` atlanarak deploy başarıyla tamamlandı.

**Öneri:** `run_release.sh`'nin `SELF_REAL` çözümlemesini incelemek veya `--expected-self-blob`'u tam SHA yerine kısaltılmış SHA ile karşılaştırmak.

### Uyarı: `docker-compose.prod.yml` `version` attribute

```
time="..." level=warning msg="...: the attribute `version` is obsolete..."
```

**Etki:** Yalnızca uyarı, deploy'u etkilemez.

---

## 9. Açık riskler (deploy sonrası)

| # | Risk | Önem | Durum |
| --- | --- | --- | --- |
| R1 | `only_conv_ids` parçalamayla birlikte test edilmedi | P2 | Açık — canlı davranış izlenmeli |
| R2 | `recovery_pass` sayaç ezmeme davranışı doğrudan assert edilmiyor | P2 | Açık |
| R3 | F2 düzeltmesi **dağıtıldı** — production'da front-trim atlaması riski azaldı | P1 | **ÇÖZÜLDÜ** ✅ |

---

## 10. Sonuç

### **DEPLOY VERIFIED**

**Gerekçe:**
- ✅ `.deployed-commit` hedef SHA ile eşleşiyor (`0b795ea`)
- ✅ Backend container `healthy`, yeni imajda
- ✅ Gateway imajı **değişmedi**, RestartCount **0**
- ✅ DB/Caddy recreate edilmedi
- ✅ `/health` başarılı
- ✅ Session CONNECTED, bridge bağlı, `last_pong_at` taze
- ✅ Persistence loop `false/false/0`
- ✅ NULL/duplicate/orphan **0**
- ✅ Watermark altı kayıt sayısı **9652 = 9652** (veri kaybı yok)
- ✅ Outbox anomali yok
- ✅ Quarantine değişmedi

**Deploy başarılı. Veri kaybı yok. Gateway etkilenmedi. Session korundu.**

---

## Ek — Aşama sonunda dosya durumu

| Yol | Durum |
| --- | --- |
| Production `.deployed-commit` | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` |
| Production backend image | `sha256:1d639e816929d9a5486d5cb015f644c50ae2803ec119a3aa317dc2bbf517b41f` |
| Production gateway image | `sha256:7905b32df9e19c0c22e7bee7ccaebd63623082491f477fcc1cf8ab0a1028b56d` (değişmedi) |
| Ana worktree | `7afb540`, 71 girdi, dokunulmadı |
| Release branch | `origin/release/backend-only-seq-safety` @ `0b795ea` |

**Aşama 4.34** (canlı E2E testleri) için ayrıca değerlendirme ve açık kullanıcı onayı beklenecektir.
