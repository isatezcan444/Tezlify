# Aşama 4.21 — Backend 4.7 Release Candidate Revalidation & Pre-Push Safety Gate

**Tarih:** 2026-11-01 00:15–00:45 +0300
**Mod:** SALT-OKUNUR Git + izole lokal test. Push YOK, fetch YOK, deploy YOK, dosya değişikliği YOK.
**Sonuç:** ✅ **READY FOR BACKEND PUSH PREFLIGHT**

---

## 0. Özet

Candidate kimliği **birebir doğrulandı** (SHA / parent / tree / tarih). 8-vs-11 dosya tutarsızlığı
**kesin olarak çözüldü**: iki sayı farklı kapsamlara ait, ikisi de doğru — **11 dosya** toplam release
diff'i, **8 dosya** yalnız `backend/` altındaki kısım. 4.20 raporundaki "8" ifadesi `-- backend/`
filtresiyle ölçüldüğü için eksik kapsamlıydı; release 11 dosyadır.

Testler: yeni iki test dosyası dahil 148 test geçti; tüm WhatsApp grubu candidate'da **919 passed /
4 skipped / 0 failed**, deploy edilen tabanda **905 passed / 4 skipped** → fark tam olarak eklenen
**+14 test**, hiçbir mevcut test bozulmadı.

---

## 1. Candidate Kimliği

| Alan | Beklenen | Gerçek | Sonuç |
| --- | --- | --- | --- |
| Branch | `release/backend-only-4.7` | `refs/heads/release/backend-only-4.7` mevcut | **PASS** |
| SHA | `2236caebd4281b108b835f16f4c80d3d2e2f1d05` | `2236caebd4281b108b835f16f4c80d3d2e2f1d05` | **PASS** |
| Parent | `17ccbc91843490f7c256b1324e22d11e0a02ac3f` | `17ccbc91843490f7c256b1324e22d11e0a02ac3f` | **PASS** |
| Tree | `4a2c37de85f8c981ef5659299d993a7081cedbbe` | `4a2c37de85f8c981ef5659299d993a7081cedbbe` | **PASS** |
| Tarih | — | `2026-10-31 12:04:57 +0300` | kayıt |
| Mesaj | — | `test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction` | kayıt |

**Commit zinciri (tek ebeveynli, doğrusal):**
```
2236cae  test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction   (1 dosya)
17ccbc9  release: backend-only 4.7 (memory persistence core safety fix)                        (10 dosya)
cbe4f509 release: backend-only 3.8.7 …                                                    ← ÜRETİM
```

**Worktree / HEAD durumu:**

| Worktree | HEAD | Durum |
| --- | --- | --- |
| `/private/tmp/tz410-release` | `2236cae` | **branch üzerinde** (`refs/heads/release/backend-only-4.7`) |
| `/private/tmp/tz415-bridge` | `2236cae` | detached (aynı commit) |

`/tmp/tz410-release` working tree: **tamamen temiz** — `git status --short` **0 satır**, staged **0**.

---

## 2. Dosya Kapsamı — 8 vs 11 Tutarsızlığının Kesin Çözümü

Üç farklı taban için ölçüm:

| Ölçüm | Komut | Sonuç |
| --- | --- | --- |
| Commit'in kendi diff'i | `git diff-tree --no-commit-id --name-status -r 2236cae` | **1 dosya** (`A backend/tests/test_whatsapp_message_insert_isolation.py`) |
| 4.7'nin ikinci commit'i | `git diff --stat 17ccbc9 2236cae` | **1 dosya, +253** |
| **Release toplamı** | `git diff --stat cbe4f509 2236cae` | **11 dosya, +2038 / −61** |
| Release toplamı (yalnız backend) | `… -- backend/` | **8 dosya, +1145 / −61** |

### 11 dosyanın tam listesi

| # | Dosya | Durum | Δ |
| --- | --- | --- | --- |
| 1 | `backend/app/main.py` | M | +2 |
| 2 | `backend/app/services/whatsapp/memory_persistence.py` | M | +241/−? |
| 3 | `backend/app/services/whatsapp/orchestration/sync.py` | M | +144 |
| 4 | `backend/app/services/whatsapp_gateway.py` | M | +11 |
| 5 | `backend/tests/test_whatsapp_memory_persistence.py` | M | 2 |
| 6 | `backend/tests/test_whatsapp_memory_persistence_hardening.py` | M | 8 |
| 7 | `backend/tests/test_whatsapp_message_insert_isolation.py` | **A** | +253 |
| 8 | `backend/tests/test_whatsapp_pagination_contract.py` | **A** | +545 |
| 9 | `scripts/pg_audit_tests/test_tz44_missing.py` | **A** | +415 |
| 10 | `scripts/pg_audit_tests/test_tz46_audit.py` | **A** | +440 |
| 11 | `scripts/pg_audit_tests/tz44_pgplugin.py` | **A** | +38 |

**Tutarsızlığın nedeni:** 4.20 raporunda `git diff --stat cbe4f509 2236cae -- backend/` çalıştırıldı;
`-- backend/` filtresi `scripts/pg_audit_tests/` altındaki 3 dosyayı (893 satır) dışarıda bıraktı.
11 dosyalık kayıt filtresiz toplam diff'tir. **İkisi de doğru; 4.20'nin ifadesi eksik kapsamlıydı.**

### Kapsam soruları

| Soru | Yanıt |
| --- | --- |
| Gerçek dosya sayısı | **11** |
| Gerçek eklenen/silinen | **+2038 / −61** |
| Backend dışı dosya var mı? | **VAR — 3 adet**, `scripts/pg_audit_tests/` altında |
| Gateway dosyası var mı? | **YOK** (0 dosya `whatsapp-gateway/` altında) |
| Test dosyaları candidate içinde mi? | **EVET — 4 test dosyası** (2 yeni, 2 güncellenmiş) |
| 4.20'deki "8 dosya" doğru mu? | **Backend kapsamı için doğru, release kapsamı için eksik** |

### `scripts/pg_audit_tests/` ne? (kapsam notu)

Üç dosyanın docstring'i açık: *"Not part of the repository. Runs only against a throwaway PostgreSQL
cluster."* — Aşama 4.4 ve 4.6'nın **denetim harness'ı**. Ürün kodu değil.

**Etki analizi (ölçüldü, varsayılmadı):**
- `backend/Dockerfile` yalnız `backend/requirements.txt`, `backend/`, `start.py` kopyalıyor →
  bu 3 dosya **imaja girmiyor**.
- `scripts/deploy/host-release.sh` içinde `pytest` çağrısı **yok** (`grep -n pytest` → boş) →
  release kapısını kıramazlar.
- Dolayısıyla **runtime ve deploy riski yok**; yalnız release commit'inin kapsamı temiz değil.

---

## 3. P0-1 Teknik İnceleme — Pagination Contract

### Backend tarafı (candidate)

**a) Gateway client sequence cursor gönderiyor** — `backend/app/services/whatsapp_gateway.py`:
```python
async def list_all_messages(..., after_seq: Optional[int] = None,
                            seq_epoch: Optional[str] = None) -> Dict[str, Any]:
    ...
    if after_seq is not None: params["afterSeq"] = int(after_seq)
    if seq_epoch is not None: params["seqEpoch"] = str(seq_epoch)
```

**b) Drain sözleşmeyi yanıttan çözüyor** — `memory_persistence.py:432-451`:
```python
reported_mode = str(page.get("pagination") or "")
if reported_mode == "seq":
    mode = "seq"; epoch = page.get("seq_epoch") or epoch
    if page.get("epoch_reset"): stats["epoch_reset"] = True; ...
else:
    if mode == "seq":
        mode = "offset"
        offset = int(start_offset or 0)   # imleç SIFIRLANMAZ
```

**c) İlerleme garantisi / kilitlenme koruması** — `:531-549`:
```python
if next_after <= after_seq:
    stats["error"] = "PaginationStalled"; _STATE["stalled_pages_total"] += 1; break
after_seq = next_after
if page.get("reached_end"): reached_end = True; break
```
Boş sayfa bu kontrolden **önce** yakalanıyor (`if not msgs: reached_end = True; break`) → yanlış
"stalled" alarmı yok.

**d) Cursor kalıcılığı** — `:644-649`:
```python
cursors[str(gateway_id)] = {"mode": ..., "after_seq": int(next_after_seq or 0),
                            "offset": int(next_offset or 0), "epoch": seq_epoch}
```
Eski **düz int** cursor biçimi de okunuyor (`:623-627`) → geriye dönük uyumlu.

### Gateway tarafı (`20c88bb`, `session-manager.js`)

```js
const epochReset = Boolean(seqEpoch) && String(seqEpoch) !== String(epoch);
const after = epochReset ? 0 : Math.max(0, Number(afterSeq) || 0);
...
if (seq !== null && seq > after) eligible.push(m);   // strict greater
eligible.sort(by _seq);
return { messages, total, offset: 0, limit, pagination: 'seq', seq_epoch: epoch,
         max_seq, after_seq, next_after_seq, reached_end: page.length < limit,
         epoch_reset: epochReset, eligible_total };
```

### Sözleşme anahtarları — birebir eşleşme

| Gateway gönderiyor | Backend okuyor | Sonuç |
| --- | --- | --- |
| `pagination: 'seq'` | `page.get("pagination")` | ✅ |
| `seq_epoch` | `page.get("seq_epoch")` | ✅ |
| `epoch_reset` | `page.get("epoch_reset")` | ✅ |
| `next_after_seq` | `page.get("next_after_seq")` | ✅ |
| `reached_end` | `page.get("reached_end")` | ✅ |
| `messages` / `total` | aynı | ✅ |

### İstenen 8 maddenin karşılığı

| # | Madde | Durum | Kanıt |
| --- | --- | --- | --- |
| 1 | Gateway bulk `afterSeq` desteği | ✅ (gateway `20c88bb`) | `session-manager.js` seq bloğu |
| 2 | `seqEpoch` eşleşmesi | ✅ | `epochReset` karşılaştırması |
| 3 | `_seq` alanı | ✅ (gateway, `enumerable:false`) | `message-store.js:168,200` |
| 4 | Backend client cursor gönderiyor | ✅ | `whatsapp_gateway.py:411-414` |
| 5 | Epoch uyuşmazlığında reset/resync | ✅ | `after = 0` + `epoch_reset` sayacı |
| 6 | Offset fallback | ✅ | `pagination` yoksa `mode='offset'`, imleç korunur |
| 7 | Eski backend/gateway uyumu | ✅ | `afterSeq` yoksa seq dalı hiç çalışmaz; eski int cursor okunur |
| 8 | Cursor ilerlemesi atlama yapmıyor | ✅ | `_seq` bir DEĞER; eviction imleci kaydırmaz + stall guard |

### ⚠️ Kritik dağıtım gerçeği

**P0-1'in düzeltilmesi iki yarıyı da gerektirir.** Backend 4.7 tek başına deploy edilirse, üretimdeki
gateway (`cbe4f509`) `afterSeq`'i yok sayar → yanıt `pagination` içermez → backend **offset moduna
düşer**. Yani:

| Gateway | Backend | Sonuç |
| --- | --- | --- |
| eski (üretim) | 4.7 | **offset modu** — P0-1 düzeltilmez, regresyon da yok |
| `20c88bb` | eski (üretim) | seq dalı hiç çağrılmaz — etkisiz |
| `20c88bb` | 4.7 | **seq modu — P0-1 düzeltilir** ✅ |

Bu davranış `test_whatsapp_pagination_contract.py`'de iki gateway kuşağı birebir kodlanarak test ediliyor.

---

## 4. P0-2 Teknik İnceleme — Message Insert Isolation

`sync.py:158-294`:

**a) Bulk insert savepoint içinde:**
```python
try:
    async with db.begin_nested():        # SAVEPOINT
        res = await db.scalars(stmt); inserted = list(res.all())
    ...
except IntegrityError as exc:
    return await _insert_messages_one_by_one(db, ins_cls, values, dead_letter=dead_letter)
```

**b) Satır satır izolasyon** (`_insert_messages_one_by_one`):
```python
for val in values:
    try:
        async with db.begin_nested():    # her satır kendi SAVEPOINT'inde
            ... .on_conflict_do_nothing(index_elements=["conversation_id","wa_message_id"], ...)
        inserted.extend(got)
    except IntegrityError as exc:
        dead_letter["count"] += 1
        dead_letter["constraint"] = _integrity_constraint_name(exc)
```

**c) Kısıt adı çıkarımı** — `_integrity_constraint_name` asyncpg tuzağını atlıyor: gerçek istisna
`orig.__cause__` altında; yalnız `orig`'e bakmak SQLSTATE (`23505`) döndürür ve operatör hangi indeksin
çakıştığını asla öğrenemez. Üç aday sırayla deneniyor, ad yoksa SQLSTATE'e düşülüyor.

### İstenen 6 iddia

| # | İddia | Durum | Kanıt |
| --- | --- | --- | --- |
| 1 | Her mesaj savepoint içinde izole | ✅ | `begin_nested()` per-row |
| 2 | Tek hatalı mesaj tüm batch'i düşürmüyor | ✅ | bulk savepoint → fallback |
| 3 | IntegrityError sonrası session kullanılabilir | ✅ | savepoint rollback, dış tx sağlam — test 2 |
| 4 | Duplicate yarışında kazanan satır adopt edilir | ✅ | canlı yolda `_recover_message_new_after_integrity_error` (`events.py:1044`), her iki ref'te mevcut |
| 5 | Geçerli mesajlar hatalı satır yüzünden kaybolmuyor | ✅ | test 1: diğer satırlar yazılır, yalnız çakışan `dead_letter` |
| 6 | Transaction/commit hata yönetimi | ✅ | `dead_letter` sayacı + `constraint` adı, PII yok |

---

## 5. Test Dosyaları ve Sonuçlar

**Test edilen commit: `2236caebd4281b108b835f16f4c80d3d2e2f1d05`** (`/tmp/tz410-release`, temiz worktree).
İzole SQLite test DB: `/tmp/tz421_test.db` (34 tablo, `provision_test_db.py` ile üretildi).
**Production DB'ye bağlanılmadı**, production verisine hiçbir test yazımı yapılmadı.

| Test dosyası | Candidate'da | Test sayısı | Sonuç |
| --- | --- | --- | --- |
| `test_whatsapp_pagination_contract.py` | **YENİ** (+545) | 9 | **9 passed** (tek başına da 9 passed) |
| `test_whatsapp_message_insert_isolation.py` | **YENİ** (+253) | 5 | **5 passed** (tek başına da 5 passed) |
| `test_whatsapp_memory_persistence.py` | M | — | passed |
| `test_whatsapp_memory_persistence_hardening.py` | M | — | passed |
| `test_memory_persist_fail_closed.py` | aynı | — | passed |
| `test_deploy_persistence_flag_guard.py` | aynı | — | passed |
| **6 dosya toplamı** | | **148** | **148 passed / 2.24 s** |
| 4 dosya, rastgele sıra (`pytest-randomly`) | | 39 | **39 passed** (sıra bağımsız) |

### Regresyon karşılaştırması (aynı komut, iki ağaç)

| Ağaç | Komut | Sonuç |
| --- | --- | --- |
| **cbe4f509** (üretim) | `pytest backend/tests/ -k whatsapp -p no:randomly` | **905 passed, 4 skipped, 0 failed** |
| **2236cae** (candidate) | aynı | **919 passed, 4 skipped, 0 failed** |
| **Fark** | | **+14 passed** = 9 (pagination) + 5 (isolation) → **hiçbir mevcut test bozulmadı** |

4 skip: `test_whatsapp_phase6_5_qr_live_seam.py` — `WHATSAPP_LIVE_GATEWAY_URL` istiyor (canlı gateway
seam testi). Beklenen skip, başarısızlık değil.

---

## 6. Regression ve Kapsam Denetimi

| Alan | Bulgu | Risk |
| --- | --- | --- |
| **API contract** | Yalnız **ekleme**: `/metrics` yanıtına `whatsapp_memory_persistence` anahtarı; `list_all_messages`'a opsiyonel `after_seq`/`seq_epoch`. Kaldırılan/değişen alan yok | **Yok** |
| **Gateway/backend protokolü** | Yeni parametreler opsiyonel; eski gateway bilinmeyen query param'ı yok sayar | **Yok** |
| **DB schema / migration** | `git diff --name-only cbe4f509 2236cae \| grep -c alembic\|migrations` → **0** | **Yok** |
| **Transaction davranışı** | Savepoint ekleniyor; dış transaction semantiği korunuyor | **Yok** |
| **Background task** | Loop kodu değişiyor ama **varsayılan kapalı** (`config.py:211 → False`; config.py diff'te **yok**) | **Yok** |
| **Feature flag** | `WHATSAPP_MEMORY_PERSIST_ENABLED` varsayılanı `False` — değişmedi; `config.py` candidate diff'inde yok | **Yok** |
| **Canlı ingestion** | `events.py` **değişmiyor** (11 dosyada yok) → canlı mesaj yolu bit-bit aynı | **Yok** |
| **Kimlik / idempotency** | `uq_msg_conv_wa_message_id` + `on_conflict_do_nothing` aynı; adopt mantığı `events.py`'de zaten var | **Yok** |

### Persistence loop'un kapalı kalması (özel doğrulama)

`backend/app/core/config.py:211` → `WHATSAPP_MEMORY_PERSIST_ENABLED: bool = False`.
`config.py` **candidate diff'inde yok** → deploy edilen dosyayla birebir aynı.
`main.py:421` → `if getattr(settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", False):` → yoksa loop başlamaz.

**Sonuç: backend 4.7 deploy edilse bile loop KAPALI kalır.** Loop'u açmak ayrı ve bilinçli bir
env değişikliği gerektirir — ve **gateway `20c88bb` deploy edilmeden açılmamalıdır** (offset modu →
P0-1 atlama riski geri gelir).

---

## 7. Remote Durumu (fetch yapılmadı)

```
git ls-remote --heads origin release/backend-only-4.7   →  (boş çıktı, rc=0)
```

**Remote'da `release/backend-only-4.7` YOK.** Candidate yalnız yerelde. `origin/main` =
`7afb5406c29736bb914b27fa90e85a618ae9ce0e` — değişmedi. Hiçbir remote ref'e yazılmadı.

---

## 8. Gateway `20c88bb` ile Uyumluluk

| Alan | Gateway `20c88bb` | Backend `2236cae` | Sonuç |
| --- | --- | --- | --- |
| `afterSeq` parametresi | okur (`parseInt`) | gönderir | ✅ |
| `seqEpoch` parametresi | okur, `String()` karşılaştırır | `str(seq_epoch)` gönderir | ✅ |
| Yanıt `pagination` | `'seq'` / `'offset'` | ikisini de işler | ✅ |
| `next_after_seq` | snake_case döner | snake_case okur | ✅ |
| `epoch_reset` | bool döner | `page.get("epoch_reset")` | ✅ |
| `reached_end` | `page.length < limit` | erken çıkış | ✅ |
| Mesaj kimliği | `wa_message_id` (bulk projeksiyonu) | `_wa_id_of(gm)` | ✅ |
| Batch yapısı | `{messages, total, offset, limit, …}` | aynı alanlar | ✅ |
| Resync | `epochReset → after=0` | `epoch_reset` sayacı + cursor epoch güncelleme | ✅ |

**Kod kanıtı yeterli; ayrıca `test_whatsapp_pagination_contract.py` her iki kuşağın gerçek yanıt
biçimini kodlayıp aynı tüketiciden geçiriyor (9 test).** İki candidate **birlikte uyumlu**.

---

## 9. Açık Riskler

| ID | Seviye | Risk | Etki | Azaltma |
| --- | --- | --- | --- | --- |
| R1 | P2 | Release commit'inde **3 adet `scripts/pg_audit_tests/`** denetim dosyası var (893 satır, ürün kodu değil) | İmaja girmiyor, deploy kapısını etkilemiyor; yalnız kapsam kirliliği | Push kapsamı operatör tarafından bilinçli kabul edilmeli; temizlik ayrı commit |
| R2 | P2 | **Backend 4.7 tek başına P0-1'i düzeltmez** (gateway `afterSeq` göndermiyor → offset fallback) | Düzeltme ertelenir, regresyon yok | Gateway `20c88bb` da deploy edilmeli |
| R3 | P2 | Loop 4.7 + **eski gateway** ile açılırsa offset modu → sessiz atlama geri gelir | Veri atlama | Loop, gateway deploy edilmeden **açılmamalı** (varsayılan zaten kapalı) |
| R4 | P3 | `_insert_messages_one_by_one` başarısız satırı **retry etmiyor**, yalnız `dead_letter` sayıyor | O satır DB'ye girmez; `/health.dead_letter_total` gösterir | Sayaç izlenmeli; kalıcı zehirli satır manuel inceleme |
| R5 | P3 | `dead_letter_last_constraint` SQLite'ta SQLSTATE, PG'de indeks adı dönebilir | Teşhis kalitesi dialect'e bağlı | PG'de ad gelir; test bunu pinliyor |

**P0 risk yok. P1 risk yok.** (P0-2'nin *düzeltilmesi* bu candidate'ın kendisidir; deployed kodda
eksik olduğu 4.20'de raporlandı.)

---

## 10. Production'a Dokunulmadığı Teyidi

| İşlem | Durum |
| --- | --- |
| `git push` | **YAPILMADI** |
| `git fetch` / `pull` | **YAPILMADI** (`refs/remotes/` değişmedi) |
| Commit / amend / rebase / merge / cherry-pick | **YAPILMADI** |
| `reset` / `clean` / `stash` / force | **KULLANILMADI** |
| `git add -A` | **KULLANILMADI** |
| Dosya değişikliği | **YOK** (yalnız `/tmp` altında test DB'si ve geçici çıktılar) |
| Production deploy / restart / rebuild | **YAPILMADI** |
| Production DB / RAM / persistence loop | **DOKUNULMADI** |
| `node_modules` symlink'leri | **DOKUNULMADI** |
| Üretim `.deployed-commit` | `cbe4f509` (değişmedi) |

---

## 11. Nihai Karar

### ✅ READY FOR BACKEND PUSH PREFLIGHT

**Gerekçe:**
- Kimlik **birebir**: SHA `2236cae`, parent `17ccbc9`, tree `4a2c37de…` — sapma yok.
- 8-vs-11 tutarsızlığı **çözüldü**; 11 dosya / +2038−61 kesin, 3 dosya denetim harness'ı (imaja girmiyor).
- P0-1 ve P0-2 kodda **kanıtlandı**; sözleşme anahtarları gateway `20c88bb` ile birebir eşleşiyor.
- Testler: yeni 14 test dahil **919 passed / 0 failed**; taban **905** → **regresyon yok**.
- Schema/migration yok, API yalnız ekleme, canlı ingestion dosyası değişmiyor, loop varsayılan **kapalı**.

**Push öncesi operatörün bilmesi gerekenler (bloklayıcı değil):**
1. Push **11 dosya** taşıyacak; 3'ü `scripts/pg_audit_tests/` denetim dosyasıdır (bilinçli kabul).
2. Backend 4.7 deploy edilirse **loop yine kapalı** kalır; açmak ayrı karar.
3. **P0-1'in gerçek düzeltmesi gateway `20c88bb` deploy'u ile tamamlanır**; backend tek başına
   yalnız P0-2'yi devreye alır.

**Duruldu.** Push yapılmadı. Backend push ayrı bir aşama ve ayrı açık onay gerektirir.
