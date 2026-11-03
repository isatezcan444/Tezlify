# Tezlify AŞAMA 5.2 — Tam Program Özeti ve El Değişimi

> **Oluşturma:** 2026-11-01  
> **Son commit:** `6cb0f5c` (`test(whatsapp): verify PostgreSQL race handling and test isolation`)  
> **Program:** Baileys `messages.upsert` olaylarını `notify` (canlı mesaj) ve `append` (geçmiş mesaj) olarak ayırma  
> **Durum:** 7 alt aşama tamamlandı. Commit yapıldı. Deploy BEKLEMEDE.

---

## 1. Git Durumu

```bash
cd /Users/isatezcan/Documents/Github/Tezlify
git branch --show-current   # main
git rev-parse --short HEAD  # 6cb0f5c
git diff --cached --stat    # (boş — staged 0)
git status --short | wc -l  # 81
```

| Öğe | Değer |
|---|---|
| Branch | `main` |
| HEAD | `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6` |
| Parent | `a4f12d7` (5.2) |
| origin/main | `7afb540` (değişmedi) |
| Ahead | **3** (push edilmedi) |
| Staged | **0** |
| Dirty | **81** (78 kullanıcı girdisi + 3 bu program artefaktı) |

**81 dirty girdinin kaynağı:**
- 78 kullanıcı değişikliği (korundu, hiçbirine dokunulmadı)
- 3 program artefaktı: `docs/audits/ASAMA-5.2.7-browser-e2e-verification.md`, `frontend/scripts/verify-whatsapp-notify-append.mjs`, `.workbuddy-ai/memory/2026-11-01.md` (günlük kayıtları)

---

## 2. Deploy Durumu

| Ref | Durum | Not |
|---|---|---|
| **Deployed** | `0b795ea6` | `release/backend-only-seq-safety`, 2026-11-01T11:01:27Z, `--no-gateway`, 5 backend dosyası |
| **main** | `6cb0f5c` | **Deploy edilmedi, push edilmedi**. `whatsapp-gateway/src/` değişikliği içeriyor ⇒ `--no-gateway` imkansız |
| Deploy yolu | `scripts/deploy/host-release.sh` | `.deployed-commit` yetkilidir; push ≠ deploy |

**Kritik:** `main` (`6cb0f5c`) deploy edilemez çünkü:
1. `whatsapp-gateway/src/` değişikliği var (`--no-gateway` reddeder).
2. `main`'de 4.27/4.28 yok; deployed gateway `20c88bb` ancestor değil.
3. 4 değişik dosyanın blob'ları `release/backend-only-seq-safety` ile birebir aynı ⇒ oraya re-apply daha ucuz.

---

## 3. Aşama Özetleri

| # | Aşama | Sonuç | Commit | Dosyalar |
|---|---|---|---|---|
| 5.2.1 | Precommit güvenlik | `SAFE TO COMMIT` | `a4f12d7` | 4 modifiye + 2 yeni |
| 5.2.2 | Kontrollü commit | `COMMITTED` | `a4f12d7` | 8 dosya, +1533/−11 |
| 5.2.3 | PostgreSQL IntegrityError yarış testi | `POSTGRESQL RACE VERIFIED` | — (5.2.6'da commitlendi) | `test_whatsapp_pg_integrity_race.py` |
| 5.2.4 | PostgreSQL test fixture ortaklaştırma | `FIXTURE SHARED SAFELY` | — (5.2.6'da commitlendi) | `conftest.py` +55 satır |
| 5.2.5 | PostgreSQL grup JID test temizliği | `GROUP CLEANUP VERIFIED` | — (5.2.6'da commitlendi) | `test_whatsapp_upsert_append.py` +24/−17 |
| 5.2.6 | Kontrollü test altyapısı commit'i | `COMMITTED` | `6cb0f5c` | 6 dosya, +2123/−17 |
| 5.2.7 | Notify/Append frontend E2E doğrulama | `28/28 PASS` | Yok (rapor + betik) | Rapor + `verify-whatsapp-notify-append.mjs` |

### 3.1 AŞAMA 5.2.1 — Precommit Güvenlik

**Ne yapıldı:** 8 dosyanın (4 modifiye + 4 yeni) hunk seviyesinde analizi. Kullanıcı değişiklikleriyle çakışma kontrolü.

**Karar:** `SAFE TO COMMIT`

**Dosyalar:**
- Modifiye: `backend/app/main.py`, `backend/app/services/whatsapp/orchestration/events.py`, `whatsapp-gateway/src/session-manager.js`, `whatsapp-gateway/src/socket/socket-events.js`
- Yeni: `backend/tests/test_whatsapp_upsert_append.py`, `whatsapp-gateway/scripts/test-upsert-notify-append.mjs`, `docs/audits/ASAMA-5.2-messages-upsert-notify-append.md`, `docs/audits/ASAMA-5.2.1-precommit-safety.md`

### 3.2 AŞAMA 5.2.2 — Kontrollü Commit

**Ne yapıldı:** Yalnızca 5.2'e ait 8 dosya stage edildi, kullanıcı değişiklikleri dışarıda bırakıldı.

**Commit:** `a4f12d7bcbc407a5288e65658d8287c4e1063044`
- Mesaj: `feat(whatsapp): distinguish notify and append message upserts`
- 8 dosya, +1533/−11
- Hunk-level partial staging kullanıldı (`git apply --cached`)
- `git add -A` / `git add .` **kullanılmadı**

### 3.3 AŞAMA 5.2.3 — PostgreSQL IntegrityError Yarış Testi

**Ne yapıldı:** Gerçek PostgreSQL'de deterministik yarış senaryosu: iki eşzamanlı `ingest_gateway_event` çağrısı, birinciyi INSERT ile commit öncesi beklet, ikinciyi başlat, `pg_stat_activity` Lock kanıtı, ikinci `IntegrityError` yolunu takip et.

**Karar:** `POSTGRESQL RACE VERIFIED`

**Test:** `backend/tests/test_whatsapp_pg_integrity_race.py` (714 satır, 4 test)
- `test_engine_is_really_postgresql` — PG 17.11, loopback, `tezlify_race_523`
- `test_raw_unique_violation_names_the_constraint` — `uq_msg_conv_wa_message_id`
- `test_append_race_takes_integrity_error_path` — 10 assertion, deterministik barrier
- `test_notify_race_still_broadcasts_the_winner` — kontrol grubu (broadcast=2)

**Kritik komut:**
```bash
DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_race_523" \
  ./venv/bin/python -m pytest backend/tests/test_whatsapp_pg_integrity_race.py -p no:randomly -q
```

**Rapor:** `docs/audits/ASAMA-5.2.3-postgresql-race-test.md`

### 3.4 AŞAMA 5.2.4 — PostgreSQL Test Fixture Ortaklaştırma

**Ne yapıldı:** `_fresh_pool` fixture'ı `conftest.py`'ye taşındı. SQLite davranışı değişmedi.

**Karar:** `FIXTURE SHARED SAFELY`

**Değişiklik:**
- `backend/tests/conftest.py` +55/−0 (`@@ -128,0 +129,55 @@`)
- Dialect guard: `engine.dialect.name != "postgresql"` → hiçbir şeye dokunma
- `engine.sync_engine.dispose(close=False)` — asyncpg loop binding sorununu çözer
- 5.2.3 yarış testindeki local fixture silindi (delegasyon yorumu bırakıldı)

**Test sonuçları:**
- PG 5.2 dosyası: **17 passed** (önce 10 failed)
- PG yarış dosyası: **4 passed**
- SQLite tam suite: **943 passed / 8 skipped** (taban çizgisiyle birebir)

**Rapor:** `docs/audits/ASAMA-5.2.4-postgresql-test-fixture.md`

### 3.5 AŞAMA 5.2.5 — PostgreSQL Grup JID Test Temizliği

**Ne yapıldı:** `test_whatsapp_upsert_append.py`'deki `_purge` fonksiyonu düzeltildi. Grup JID'lerinde `jid_to_phone()` `None` döndürüyordu; `contact_phone_for_jid()` tek kaynak olarak kullanıldı.

**Karar:** `GROUP CLEANUP VERIFIED`

**Kök neden:**
- `jid_to_phone('...@g.us')` = `None`
- DB'de `phone_e164 = 'jid:...@g.us'`
- `WHERE phone_e164 = NULL` hiçbir satırı eşleştirmez
- Test yine yeşil kalıyordu (ölü temizlik)

**İkinci katman:** `test_group_message_behaviour_unchanged` `_purge`'ü hiç çağırmıyordu; aynı mantığın satır içi kopyasını taşıyordu. Kopya da kaldırıldı, test `_purge`'e delege edildi.

**Değişiklik:** `backend/tests/test_whatsapp_upsert_append.py` +24/−17
- Import: `jid_to_phone` → `contact_phone_for_jid`
- `key = contact_phone_for_jid(jid)` (hem konuşma araması hem kişi silme)
- Satır içi kopya → `await _purge(group_jid, gw_id)`

**Test sonuçları (7 zorunlu koşu):**
| # | Koşu | Sonuç | msg | conv | contact | session | evt |
|---|---|---|---|---|---|---|---|
| 1 | PG grup testi | 1 passed | 0 | 0 | 0 | 0 | 0 |
| 2 | PG 5.2 dosyası | 17 passed | 0 | 0 | 0 | 0 | 0 |
| 3 | PG yarış dosyası | 4 passed | 0 | 0 | 0 | 0 | 0 |
| 4 | PG ikisi birlikte | 21 passed | 0 | 0 | 0 | 0 | 0 |
| 5 | PG 5 ardışık tekrar | 21 passed ×5 | 0 | 0 | 0 | 0 | 0 |
| 6 | SQLite 5.2 (taze DB) | 17 passed | 0 | 0 | 0 | 0 | n/a |
| 7 | SQLite tam suite | 943 passed / 8 skipped | 2 | 2 | 5 | 0 | n/a |

(Not: Tam suite'teki 5 kalan satır diğer test dosyalarına aittir, 5.2'ye değil.)

**Rapor:** `docs/audits/ASAMA-5.2.5-postgresql-group-cleanup.md`

### 3.6 AŞAMA 5.2.6 — Kontrollü Test Altyapısı Commit'i

**Ne yapıldı:** 5.2.3, 5.2.4 ve 5.2.5 ürünleri tek commit altında kalıcılaştırıldı.

**Commit:** `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6`
- Mesaj: `test(whatsapp): verify PostgreSQL race handling and test isolation`
- 6 dosya, +2123/−17
- Hunk sahipliği kanıtlandı (`conftest.py` silinen satır 0, `upsert_append.py` silinen 17 satırın hepsi 5.2.5'e ait)
- Kullanıcı değişiklikleri korundu (24 dosyanın diffstat'ı birebir aynı kaldı)

**Dosyalar:**
```
M  backend/tests/conftest.py                          |  55 +
A  backend/tests/test_whatsapp_pg_integrity_race.py   | 714 +++++++++++++
M  backend/tests/test_whatsapp_upsert_append.py       |  41 +-
A  docs/audits/ASAMA-5.2.3-postgresql-race-test.md    | 476 ++++++++++
A  docs/audits/ASAMA-5.2.4-postgresql-test-fixture.md | 450 +++++++++
A  docs/audits/ASAMA-5.2.5-postgresql-group-cleanup.md| 404 ++++++++
```

### 3.7 AŞAMA 5.2.7 — Notify/Append Frontend E2E Doğrulama

**Ne yapıldı:** Backend'deki notify/append ayrımının frontend'deki etkisi doğrulandı.

**Karar:** `28/28 passed`

**Kritik bulgu:** Frontend'de `append`/`notify` string araması **boş**. Frontend bu ayrımı bilmiyor; backend `_no_broadcast` ile append event'ini frontend'e **hiç göndermiyor**.

**Yeni betik:** `frontend/scripts/verify-whatsapp-notify-append.mjs`
- ESM Node.js, jsdom, bağımsız
- 4 saf fonksiyon kopyası (`shouldApplyPreview`, `buildChatPreview`, `mergeWhatsAppMessages`, `parseServerTime`)
- DOM testi: `WhatsAppHubPage:handleWsEvent` mantığının sadeleştirilmiş kopyası

**Test matrisi:**

| Test | Beklenen | Durum |
|---|---|---|
| Notify preview güncellenir | Yeni preview | **PASS** |
| Notify timestamp güncellenir | Yeni zaman | **PASS** |
| Notify unread (kapalı sohbet) | +1 | **PASS** |
| Notify unread (açık sohbet) | 0 | **PASS** |
| Notify message_count | +1 | **PASS** |
| Append broadcast | 0 | **PASS** (backend kod analizi) |
| Append preview korunur | Korunur | **PASS** (`shouldApplyPreview`) |
| Append timestamp korunur | Korunur | **PASS** (`shouldApplyPreview`) |
| Append → Notify dedup | Tek kayıt | **PASS** (`mergeWhatsAppMessages`) |
| Notify → Append dedup | Tek kayıt | **PASS** (`mergeWhatsAppMessages`) |
| Frontend replay dedup | Sayaclar artmaz | **PASS** (`rememberWaMessageId`) |
| Eski timestamp preview ezme | Ezmez | **PASS** |
| Outbound unread | 0 | **PASS** |
| Grup mesajı preview | "Ahmet: Selam" | **PASS** |
| Medya mesajı preview | "📷 Fotoğraf" | **PASS** |

**NOT TESTED:** Toast/ses izolasyonu (App komponenti mock'lanmadı), gerçek Chrome render (CDP betiği kırık), `messages.update` upsert type (pre-existing).

**Rapor:** `docs/audits/ASAMA-5.2.7-browser-e2e-verification.md`

---

## 4. Kritik Dosyalar ve Konumları

### 4.1 Üretim kodu (5.2 kapsamında değişen)

| Dosya | Commit | Değişiklik |
|---|---|---|
| `backend/app/main.py` | `a4f12d7` | `_no_broadcast` kontrolü (ACK without broadcast) |
| `backend/app/services/whatsapp/orchestration/events.py` | `a4f12d7` | 3 üretici + 2 tüketici `_no_broadcast`; `IntegrityError` kurtarma; pre-flight dedup |
| `whatsapp-gateway/src/session-manager.js` | `a4f12d7` | `_touchChat` notify/append ayrımı; `type` geçirimi |
| `whatsapp-gateway/src/socket/socket-events.js` | `a4f12d7` | `messages.upsert` type (`notify`/`append`) `_ingestUpsertMessage`'a geçirimi |

### 4.2 Test altyapısı

| Dosya | Commit | Açıklama |
|---|---|---|
| `backend/tests/conftest.py` | `6cb0f5c` | `postgres_fresh_pool` fixture (dialect guard + `dispose(close=False)`) |
| `backend/tests/test_whatsapp_pg_integrity_race.py` | `6cb0f5c` | 4 PG testi: PG kanıtı, constraint, append race, notify race |
| `backend/tests/test_whatsapp_upsert_append.py` | `6cb0f5c` | 17 test: upsert davranışı, grup JID temizliği, dedup |
| `frontend/scripts/verify-whatsapp-notify-append.mjs` | Dirty | 28 test: frontend fonksiyon + DOM davranış doğrulaması |

### 4.3 Denetim raporları

| Dosya | Satır | Kapsam |
|---|---|---|
| `docs/audits/ASAMA-5.2-messages-upsert-notify-append.md` | ~380 | 5.2 tasarım ve kararları |
| `docs/audits/ASAMA-5.2.1-precommit-safety.md` | ~380 | Precommit hunk analizi |
| `docs/audits/ASAMA-5.2.3-postgresql-race-test.md` | ~476 | PG yarış testi detayları |
| `docs/audits/ASAMA-5.2.4-postgresql-test-fixture.md` | ~450 | Fixture ortaklaştırma |
| `docs/audits/ASAMA-5.2.5-postgresql-group-cleanup.md` | ~404 | Grup JID temizliği |
| `docs/audits/ASAMA-5.2.7-browser-e2e-verification.md` | ~280 | Frontend E2E doğrulama |
| `docs/audits/TEZLIFY-5.2-PROGRAM-HANDOFF.md` | Bu dosya | Tam program özeti |

---

## 5. Test Altyapısı Durumu

### 5.1 PostgreSQL test DB

```
Host:     127.0.0.1:5432
Version:  PostgreSQL 17.11 (Homebrew)
Data dir: /opt/homebrew/var/postgresql@17
DB:       tezlify_race_523
User:     isatezcan (superuser)
Tables:   34 (28 public + private schema)
```

### 5.2 Python ortamı

```bash
# Tek pytest içeren interpreter
/Users/isatezcan/Documents/Github/Tezlify/venv/bin/python
# pytest 9.1.1, pytest-asyncio 1.4.0, asyncpg 0.31.0, SQLAlchemy 2.0.52
```

### 5.3 Çalışan test komutları

```bash
# SQLite tam suite (taban çizgisi)
TEST_DB_PATH=/tmp/tz_test.db DATABASE_URL="sqlite+aiosqlite:////tmp/tz_test.db" \
  ./venv/bin/python -m pytest backend/tests/ -k whatsapp -p no:randomly -q

# PG 5.2 dosyası
DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_race_523" \
  ./venv/bin/python -m pytest backend/tests/test_whatsapp_upsert_append.py -p no:randomly -q

# PG yarış testi
DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_race_523" \
  ./venv/bin/python -m pytest backend/tests/test_whatsapp_pg_integrity_race.py -p no:randomly -q

# İkisi birlikte
DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_race_523" \
  ./venv/bin/python -m pytest backend/tests/test_whatsapp_upsert_append.py \
  backend/tests/test_whatsapp_pg_integrity_race.py -p no:randomly -q

# Frontend notify/append doğrulama
cd frontend && node scripts/verify-whatsapp-notify-append.mjs
```

### 5.4 Kırık test altyapısı (pre-existing)

| Betik | Hata | Not |
|---|---|---|
| `frontend/scripts/verify-whatsapp-dom.mjs` | `mount should auto-scroll once` | ChatThread scroll davranışı kırık |
| `frontend/scripts/verify-whatsapp-browser.mjs` | `useToast must be used within a ToastProvider` | ToastProvider wrap eksik |

---

## 6. Açık Borçlar ve Riskler

| # | Borç | Önem | Not |
|---|---|---|---|
| 1 | **4.34 (live E2E acceptance)** | Yüksek | Persistence loop henüz etkinleştirilmedi. 4.27 gönderildi ama dormant. Etkinleştirmek ayrı bir faz. |
| 2 | **`messages.update` upsert type** | Orta | `messages.update` (`:1322`) hâlâ `notify` varsayılanı. Pre-existing, 5.2.7 raporunda not edildi. |
| 3 | **Diğer test dosyalarının DB artıkları** | Düşük | 5.2.5'te tespit edilen 5 satır (diğer test dosyalarından) temizlenmedi. Ayrı hijyen fazı. |
| 4 | **Frontend test altyapısı kırık** | Düşük | `verify-whatsapp-dom.mjs` ve `verify-whatsapp-browser.mjs` çalışmıyor. 5.2.7'den önce var. |
| 5 | **Deploy path** | Yüksek | `main` (`6cb0f5c`) deploy edilemez. `release/backend-only-seq-safety` (`0b795ea6`) üzerine re-apply veya birleşik release gerekir. |
| 6 | **`package.json` test zinciri** | Düşük | `node scripts/test-upsert-notify-append.mjs` henüz `package.json` test zincirine eklenmedi. |

---

## 7. Kritik Kurallar (Yasaklar ve Sınırlar)

### 7.1 Her zaman geçerli

- **PUSH YOK** (kullanıcı açıkça onaylamadan).
- **DEPLOY YOK** (kullanıcı açıkça onaylamadan).
- **Production DB'ye yazma/silme YOK**.
- **`git add -A` / `git add .` YOK** (hunk-level partial staging zorunlu).
- **`git reset --hard`, `git clean`, `git checkout --` YOK**.
- **Kullanıcı değişikliklerini silme/stash etme YOK**.
- **`package.json` değişikliği YOK** (kullanıcı açıkça onaylamadan).
- **Container/Gateway restart YOK** (kullanıcı açıkça onaylamadan).
- **Persistence loop etkinleştirme YOK** (4.34 tamamlanmadan).
- **Branch değiştirme/merge/rebase YOK**.

### 7.2 Commit kuralları

- Commit öncesi: branch, HEAD, staged, dirty, kullanıcı girdileri doğrulanmalı.
- Hunk sahipliği kanıtlanmalı (`git diff -U0`, `git diff --numstat`).
- Staged blob'lar `py_compile` / `node --check` ile doğrulanmalı.
- Hook'lar (`post-commit`, `post-checkout`) okunmalı.
- Commit sonrası: parent, dosya sayısı, dirty karşılaştırması doğrulanmalı.

### 7.3 Test kuralları

- PostgreSQL testleri gerçekten PostgreSQL'e bağlanmalı (`test_engine_is_really_postgresql`).
- Skip veya fallback ile başarılıymış gibi gösterme.
- Her koşudan sonra DB tabloları sayılmalı (`messages`, `conversations`, `contacts`, `sessions`, `processed_events`).
- Grup JID artıkları her koşuda sıfır olmalı.

---

## 8. Devam Etmek İçin

### 8.1 Hemen yapılabilecekler

1. **5.2.7 artefaktlarını commit et** (rapor + betik). Aynı 5.2.6 prosedürü: hunk analizi, açık dosya listesi, `test(whatsapp): ...` mesajı.
2. **`messages.update` upsert type düzeltmesi** — `socket-events.js:1322` `notify` yerine `append`/`update` ayrımı.
3. **Frontend test altyapısı onarımı** — `verify-whatsapp-dom.mjs` auto-scroll, `verify-whatsapp-browser.mjs` ToastProvider.
4. **Diğer test dosyalarının DB artıklarını temizle** — `test_whatsapp_forensic_phase4_g3.py`, `test_whatsapp_outbound_delete_sync.py`, `test_whatsapp_message_info.py`, `test_whatsapp_group_reaction_preview.py`.

### 8.2 Planlanması gerekenler

1. **4.34 — Live E2E acceptance** — Persistence loop etkinleştirme, gerçek WhatsApp hesabı ile canlı test.
2. **Deploy** — `main` deploy edilemez. Seçenekler:
   - `release/backend-only-seq-safety` üzerine 5.2 dosyalarını re-apply (`--no-gateway`).
   - Birleşik release ref'i oluştur (`release/whatsapp-combined-backend-4.7-gateway-4.17`, önceki çalışmada `de1f1ad` olarak hazırlandı).
3. **`package.json` test zincirine `node scripts/test-upsert-notify-append.mjs` ekle**.

---

## 9. Önemli Kod Referansları

### 9.1 `_no_broadcast` üretici ve tüketici

```python
# Üreticiler (events.py)
# 1008: pre-flight dedup
# 1107: IntegrityError recovery
# 1203: normal persist (append)

# Tüketiciler
# main.py:771 — ACK without broadcast
# events.py:2957 — webhook suppression
```

### 9.2 `contact_phone_for_jid` (tek kaynak)

```python
# backend/app/services/whatsapp/identity.py:164
def contact_phone_for_jid(jid: str) -> str:
    if "@g.us" in str(jid):
        return f"jid:{jid}"
    phone = jid_to_phone(jid)
    return phone or f"jid:{jid}"
```

### 9.3 `shouldApplyPreview` (frontend)

```typescript
// src/features/whatsapp/lib/whatsappPreview.ts:180
export function shouldApplyPreview(newTs, currentTs): boolean {
  if (!currentTs) return true;
  if (!newTs) return true;
  const n = typeof newTs === 'number' ? newTs : parseServerTime(newTs)?.getTime() || 0;
  const c = typeof currentTs === 'number' ? currentTs : parseServerTime(currentTs)?.getTime() || 0;
  if (Number.isNaN(n) || Number.isNaN(c) || n === 0 || c === 0) return true;
  return n >= c;
}
```

### 9.4 Frontend `message_new` handler

```typescript
// WhatsAppHubPage.tsx:2452
// - shouldApplyPreview + buildChatPreview (preview/timestamp)
// - rememberWaMessageId (replay dedup)
// - unread_count: 0 if isCurrentSelected || isOutbound
// - message_count: +1 unless replayed
```

---

## 10. Hafıza ve Kayıtlar

- **Günlük kayıtlar:** `.workbuddy-ai/memory/2026-11-01.md` (67 KB, 5.2.1–5.2.7 tüm detaylar)
- **Uzun vadeli notlar:** `.workbuddy-ai/memory/MEMORY.md` (6.6 KB, index + kurallar)
- **Detaylı reçeteler:** `.workbuddy-ai/memory/reference/testing-and-ops-recipes.md`
- **Üretim operasyonları:** `.workbuddy-ai/memory/reference/production-ops.md` (72 KB)
- **WhatsApp invariant'ları:** `.workbuddy-ai/memory/reference/whatsapp-subsystem-invariants.md` (60 KB)

---

*Bu dosya, bir sonraki AI agent'ın veya geliştiricinin Tezlify AŞAMA 5.2 programını anlaması ve devam etmesi için hazırlanmıştır. Güncel tutulması gerekir.*
