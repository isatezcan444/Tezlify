# AŞAMA 5.2.14 — COMMIT SONRASI ENTEGRASYON VE RELEASE HAZIRLIK DENETİMİ

**Tarih:** 2026-11-01 20:27–20:45 (+03)
**Tip:** Salt okunur denetim. Kod yazılmadı, dosya değiştirilmedi, commit/push/deploy/merge/rebase/branch işlemi yapılmadı.
**Başlangıç ve bitiş HEAD:** `e7f1077a489d94bc6b0f0afef6b575e48922162e` (değişmedi)
**Stage:** 0 · **Dirty:** 83 (24 `M` + 59 `??`) — dokunulmadı
**Persistence loop:** OFF (kontrol edilmedi, değiştirilmedi)

---

## 1. Git baseline

| Öğe | Değer |
| --- | --- |
| Branch | `main` |
| HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` |
| origin/main | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` |
| `origin/main...main` | **0 behind / 4 ahead** |
| Remote | `https://github.com/isatezcan444/Tezlify.git` (tek remote) |
| Upstream | `main` → `origin/main`, `[ahead 4]` |
| Stage | 0 |
| Dirty | 24 `M` + 59 `??` = 83 |

Beklenen başlangıçla **birebir uyuşuyor**. Uyuşmazlık yok.

**Worktree notu:** 13 kayıtlı worktree var; 6'sı `prunable` (dizinleri silinmiş). `main` ana worktree'de, `/private/tmp/tz429-release` → `release/backend-only-seq-safety`, `/private/tmp/tz410-release` → `release/backend-only-4.7`, `/private/tmp/tz4241-combined` → `release/whatsapp-combined-…`. Bu geçici dizinler deploy hazırlık kopyalarıdır; hiçbirine dokunulmadı.

---

## 2. Son dört commit'in tam listesi

`git log --oneline origin/main..main` (yeniden eskiye):

| # | SHA | Zaman (+03) | Parent | Mesaj |
| --- | --- | --- | --- | --- |
| 4 | `e7f1077` | 20:17:17 | `6cb0f5c` | `test(whatsapp): harden notify append browser verification` |
| 3 | `6cb0f5c` | 17:33:29 | `a4f12d7` | `test(whatsapp): verify PostgreSQL race handling and test isolation` |
| 2 | `a4f12d7` | 16:41:29 | `3bf17bf` | `feat(whatsapp): distinguish notify and append message upserts` |
| 1 | `3bf17bf` | 15:29:18 | `7afb540` | `feat(whatsapp): acknowledge gateway_connected instead of dropping it as unknown` |

**Zincir doğrusal**, dallanma yok: `7afb540 → 3bf17bf → a4f12d7 → 6cb0f5c → e7f1077`. Her commit'in parent'ı bir öncekinin SHA'sı.

**Toplam:** `origin/main...main` = 26 dosya, **+6584 / −39**.

**Bağımlılık analizi:**

| Commit | Bağımsız mı? | Gerekçe |
| --- | --- | --- |
| `3bf17bf` | **Evet** | Tek başına `7afb540` üzerine uygulanabilir. |
| `a4f12d7` | **Metinsel** | `events.py`'de `3bf17bf`'in eklediği bloğun hemen altına yazıyor (`_skip`/`_no_broadcast` bölgesi). Semantik bağımlılık yok, ama `3bf17bf` olmadan cherry-pick çakışır. |
| `6cb0f5c` | **Hayır** | `test_whatsapp_upsert_append.py`'yi (a4f12d7 ürünü) düzeltiyor ⇒ `a4f12d7` olmadan anlamsız. |
| `e7f1077` | **Evet** | Yalnız `frontend/scripts/` + doküman. `3bf17bf`/`a4f12d7` çalışma zamanı davranışına bağlı değil (backend'i kendisi modelliyor). |

---

## 3. Commit bazında değişiklik sınıflandırması

Kategoriler: (1) Test altyapısı · (2) Dokümantasyon/denetim · (3) Backend üretim kodu · (4) Gateway üretim kodu · (5) Frontend üretim kodu · (6) Altyapı/deploy.

### 3.1 `3bf17bf` — "acknowledge gateway_connected" · 6 dosya, +786/−9

| Kategori | Dosyalar | Δ |
| --- | --- | --- |
| **(3) Backend üretim** | `backend/app/services/whatsapp/orchestration/events.py` | +45 |
| **(3) Backend üretim** | `backend/app/services/whatsapp_service.py` | +14/−2 (yalnız yorum) |
| **(5) Frontend üretim** | `frontend/src/features/whatsapp/api/whatsappApi.ts` | +11/−5 |
| (1) Test | `backend/tests/test_whatsapp_event_contract_parity.py` | +352 (yeni) |
| (2) Doküman | `docs/audits/ASAMA-5.1-event-contract-parity.md`, `WHATSAPP_BASELINE_CONTRACT.md` | +368 |

**İçerik:** `_ACKNOWLEDGED_IGNORE_EVENTS = {"gateway_connected"}` + `_acknowledge_without_broadcast()` eklendi. Event artık "bilinmeyen olay" dalına düşmüyor; `_skip` işaretiyle ACK edilip yayınlanmıyor. Frontend `LIVE_SESSION_EVENTS`'ten `gateway_connected` **çıkarıldı**.

**Gerçek etki:** Yalnız yorum değil — `whatsappApi.ts` davranışsal bir set değişikliği. Ancak bu olay backend tarafından zaten hiç yayınlanmadığı için (fail-closed broadcast + `gateway_session_id` yok) tarayıcıda **hiç ateşlenmeyen** bir tetikleyiciydi ⇒ davranış değişmez, ölü kod kalkar.

### 3.2 `a4f12d7` — "distinguish notify and append" · 8 dosya, +1533/−11

| Kategori | Dosyalar | Δ |
| --- | --- | --- |
| **(3) Backend üretim** | `backend/app/main.py` | +17 |
| **(3) Backend üretim** | `backend/app/services/whatsapp/orchestration/events.py` | +47/−11 |
| **(4) Gateway üretim** | `whatsapp-gateway/src/session-manager.js` | +41/−11 |
| **(4) Gateway üretim** | `whatsapp-gateway/src/socket/socket-events.js` | +7/−2 |
| (1) Test | `backend/tests/test_whatsapp_upsert_append.py` (+574), `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` (+156) | +730 |
| (2) Doküman | `docs/audits/ASAMA-5.2-…`, `ASAMA-5.2.1-…` | +702 |

**İçerik:** `messages.upsert`'in `type` alanı (`notify`/`append`) artık uçtan uca taşınıyor:
- gateway `_ingestUpsertMessage(..., { upsertType })` → `message_new` payload'ına `upsert_type`;
- append'de rozet artmıyor, `_touchChat` önizleme/zaman damgasını oynatmıyor;
- backend `_no_broadcast` işaretini okur, commit'ten **sonra** yayını kapatır ama ACK eder (`main.py:771` bölgesi);
- dedup dönüşü ve `IntegrityError` kurtarma yolu da `_no_broadcast` alır (üç dönüş yolu kapatılmış);
- dış webhook tetikleyicisi `_no_broadcast` görürse susar.

**Bu commit üretim kodudur ve üç katmanı birden değiştirir.** Test altyapısı değildir.

### 3.3 `6cb0f5c` — "verify PostgreSQL race handling" · 6 dosya, +2123/−17

| Kategori | Dosyalar | Δ |
| --- | --- | --- |
| (1) Test | `backend/tests/conftest.py` (+55, `postgres_fresh_pool` autouse fixture) | +55 |
| (1) Test | `backend/tests/test_whatsapp_pg_integrity_race.py` | +714 (yeni) |
| (1) Test | `backend/tests/test_whatsapp_upsert_append.py` | +41/−17 |
| (2) Doküman | `ASAMA-5.2.3`, `5.2.4`, `5.2.5` | +1330 |

**Tamamen test + doküman.** Üretim kodu yok, `package.json` yok.

### 3.4 `e7f1077` — "harden notify append browser verification" · 8 dosya, +2159/−19

| Kategori | Dosyalar | Δ |
| --- | --- | --- |
| (1) Test | `frontend/scripts/verify-whatsapp-browser.mjs` (+65/−10), `verify-whatsapp-dom.mjs` (+34/−19), `verify-whatsapp-notify-append-browser.mjs` (+718, yeni) | +817 |
| (1) Test (kanıt) | `docs/audits/evidence/5.2.8/notify-append-results.json` | +43 |
| (2) Doküman | `ASAMA-5.2.8/5.2.9/5.2.10/5.2.11` | +1299 |

**Tamamen test + doküman.** Üretim kaynağına (`frontend/src`, `backend`, `whatsapp-gateway/src`) **tek satır** dokunmuyor. `package.json` yok, bağımlılık yok.

### 3.5 Özet

| Kategori | Commit'ler | Dosya sayısı |
| --- | --- | --- |
| (1) Test altyapısı | 3, 4 (ve 1–2'nin test dosyaları) | 9 |
| (2) Dokümantasyon | 1, 2, 3, 4 | 11 |
| (3) Backend üretim | **1, 2** | 4 |
| (4) Gateway üretim | **2** | 2 |
| (5) Frontend üretim | **1** | 1 |
| (6) Altyapı/deploy | — | 0 |

**Kritik:** 4 commit'in **2'si üretim kodu içeriyor**. "Main'deki dört commit test altyapısıdır" varsayımı **yanlıştır**.

---

## 4. Main / release branch karşılaştırması

### 4.1 Release branch'in kimliği

Git geçmişinden ve worktree kayıtlarından tespit edilen production hattı:

| Branch | Tip | Rol |
| --- | --- | --- |
| `release/backend-only-seq-safety` | `0b795ea` | **Deploy edilmiş backend ağacı** (en güncel, 2026-11-01 12:03) |
| `release/gateway-seq-pagination-4.17` | `20c88bb` | **Deploy edilmiş gateway ağacı** (2026-10-31 23:52) |
| `release/whatsapp-combined-backend-4.7-gateway-4.17` | `de1f1ad` | İkisinin birleşik atası (2026-11-01 00:39) |

Üretim = **backend ağacı `0b795ea` + gateway ağacı `20c88bb`**. Bu ikisinin birleşimi tek bir commit'te temsil edilmiyor: `0b795ea`, `de1f1ad`'ın üzerine yalnız backend dosyaları ekliyor (`memory_persistence.py`, `sync.py`, 3 test dosyası). `git merge-base --is-ancestor 20c88bb release/backend-only-seq-safety` → **EVET**, yani `0b795ea` gateway olarak `20c88bb`'yi taşıyor. Tek branch'te tutarlı.

`.deployed-commit` dosyası yerelde yok (sunucuda); deploy edilen SHA'lar bu nedenle **Git topolojisinden** çıkarıldı, geçmiş raporlardan değil.

### 4.2 Ortak ata ve uzaklık

Ortak ata (dört release dalı için de aynı): `a1ca60f` — `docs(memory): 3.8.7 — 9 mesaj iki yerde kanitli…`

| Karşılaştırma | main-only | release-only |
| --- | --- | --- |
| `main` ↔ `release/backend-only-seq-safety` | **36** commit | **6** commit |
| `main` ↔ `release/whatsapp-combined-…` | 36 | 5 |
| `main` ↔ `release/backend-only-4.7` | 36 | 3 |
| `main` ↔ `release/gateway-seq-pagination-4.17` | 36 | 2 |

`main` release'in **atası değil**, release de main'in atası değil. İki yön de `--is-ancestor` = NO.

### 4.3 Dosya bazlı farklar

| Karşılaştırma | Sonuç |
| --- | --- |
| `release/backend-only-seq-safety..main` (tam ağaç) | **82 dosya, +18935 / −3735** |
| `0b795ea` → `main` (yalnız `backend/`) | **18 dosya, +3017 / −1593** |
| `20c88bb` → `main` (yalnız `whatsapp-gateway/`) | **11 dosya, +816 / −1224** |
| `release..main` (yalnız `frontend/src/`) | **1 dosya, +11 / −5** (`whatsappApi.ts`) |

**Frontend üretim kodu neredeyse özdeş** (tek dosya, 16 satır). Fark backend ve gateway'de.

### 4.4 Release'te olup main'de OLMAYAN kritik korumalar

Bunlar **sembol düzeyinde doğrulandı** (`git grep -c`), rapor aktarımı değil:

| Koruma | `main` | `0b795ea` (deploy) | Kanıt |
| --- | --- | --- | --- |
| `_bulk_chunks` (4.28 jid parçalama) | **0** | `sync.py`×2, `test_whatsapp_initial_sync_chunking.py`×9 | main'de sembol **yok** |
| `epoch_reset` (4.27 seq sıfırlama) | **0** | `memory_persistence.py`×7, `session-manager.js`×1, 2 pagination testi | main'de sembol **yok** |
| `list_all_messages(after_seq, seq_epoch)` | **yok** | var | `whatsapp_gateway.py`: main'de 2 parametre ve 8 satır eksik |
| `_SYNC_BULK_PAGE_SIZE` | 3 (config'de tanımlı, kullanımı dar) | 4 + test | main'de chunking yolu yok |
| Gateway `afterSeq` desteği | **0** | `index.js`×3, `session-manager.js`×6 | main gateway'de **yok** |
| Gateway `seqEpoch` desteği | **0** | `index.js`×3, `message-store.js`×3, `session-manager.js`×2 | main gateway'de **yok** |
| Gateway `_seq` alanı | yalnız `events.js`×2 | `message-store.js`×9, `session-manager.js`×4, `events.js`×2 | main'de store seviyesinde **yok** |

**Sonuç:** `main`'in backend'i ve gateway'i, üretimde çalışan 4.27 (epoch-reset) + 4.28 (jid chunking) + 4.17 (epoch-aware keyset pagination) korumalarının **hiçbirini içermiyor**. Bu bir "eksik özellik" değil, **regresyon**: main'den deploy etmek bu korumaları geri alır.

`main`'in gateway'i ayrıca `whatsapp-gateway/package.json` `test` betiğinden `test-bulk-seq-pagination.mjs` ve `test-bulk-seq-pagination-guarantees.mjs`'i **çıkarmış** (dosyalar main'de yok), yerine `test-messages-cached-metric.mjs` + `test-history-diagnostics.mjs` eklemiş. Yani main'in gateway test paketi, deploy edilen pagination davranışını **hiç test etmiyor**.

### 4.5 Main'de olup release'te OLMAYAN

| Özellik | `main` | `0b795ea` |
| --- | --- | --- |
| `_no_broadcast` (append yayın bastırma) | `main.py`×1, `events.py`×5, 2 testte×21 | **0** |
| `upsert_type` (backend tarafı) | `events.py`×6 | **0** |
| `_ACKNOWLEDGED_IGNORE_EVENTS` / `_acknowledge_without_broadcast` | `events.py`×5 | **0** |
| Gateway `upsertType` aktarımı | `session-manager.js`×2, `socket-events.js`×1 | **0** (yalnız hata tanılamasında `upsert_type: type \|\| null`) |
| `postgres_fresh_pool` fixture | var (+55) | **0** |
| `test_whatsapp_event_contract_parity.py`, `test_whatsapp_pg_integrity_race.py`, `test_whatsapp_upsert_append.py` | var | **0** |
| `frontend/scripts/verify-whatsapp-notify-append-browser.mjs` | var | **0** |
| 3.9.x felaket kurtarma / escrow / snapshot altyapısı (`scripts/backup/`, `monitoring/systemd/`, 17 denetim raporu) | **var** | **0** |

**Dikkat:** Son satır ters yönlü bir asimetri. `main` 3.9.x backup/escrow/snapshot zincirini içeriyor, `0b795ea` içermiyor. Yani "release daha yeni, main daha eski" gibi tek yönlü bir ilişki **yok**; iki hat farklı eksenlerde birbirinden ileri.

### 4.6 Çakışma potansiyeli

Aynı dosyaya iki tarafta da dokunulmuş:

| Dosya | main tarafı | release tarafı | Çakışma |
| --- | --- | --- | --- |
| `backend/app/services/whatsapp/orchestration/events.py` | 5.1 + 5.2 | 4.x düzeltmeleri | **Yüksek** — aynı fonksiyon gövdesi |
| `backend/app/main.py` | `_no_broadcast` | 4.x değişiklikleri | Orta |
| `backend/app/services/whatsapp/memory_persistence.py` | **dokunulmamış** | 4.27 epoch-reset | Düşük (tek taraflı) |
| `backend/app/services/whatsapp/orchestration/sync.py` | **dokunulmamış** | 4.28 chunking | Düşük (tek taraflı) |
| `whatsapp-gateway/src/session-manager.js` | `upsertType`, `_touchChat` | 4.17 pagination | **Çok yüksek** — aynı dosyada 41 vs 390 satır |
| `whatsapp-gateway/src/socket/socket-events.js` | `upsertType` geçişi | 4.x | Orta |
| `whatsapp-gateway/package.json` | test listesi | test listesi | Orta |
| `frontend/src/features/whatsapp/api/whatsappApi.ts` | `gateway_connected` çıkarma | aynı dosya | Düşük |

En riskli ikili: **`session-manager.js`**. `main`'deki 41 satırlık append düzeltmesi, `20c88bb`'deki 390 satırlık pagination implementasyonunun üzerine değil, ondan **bağımsız bir tabana** yazıldı.

---

## 5. Üretim güvenlik riskleri

| # | Konu | Durum | Kanıt |
| --- | --- | --- | --- |
| R1 | **Epoch-reset koruması** | Yalnız release'te. `main`'de **yok**. | `epoch_reset` main=0, 0b795ea=8 |
| R2 | **`_bulk_chunks` desteği** | Yalnız release'te. `main`'de **yok**. | main=0, 0b795ea=11 |
| R3 | **Gateway deployed commit `20c88bb`** | `20c88bb` üç release dalının da atası; **`main`'in atası değil**. | `--is-ancestor`: 3×YES, main=NO |
| R4 | **Gateway RAM-only A6 cache riski** | Değişmedi. `main`'in gateway'i yeniden başlatılırsa RAM'deki mesajlar kaybolur; `main`'de bunu telafi eden chunking/keyset yolu **yok**. | R1+R2 ile birleşik |
| R5 | **Backend-only deploy / `--no-gateway`** | `main`'den **mümkün değil**: `main` gateway ağacı `20c88bb`'yi içermediği için gateway dosyaları da farklı ⇒ `gateway_changes ≠ 0`. | `20c88bb→main` gateway: 11 dosya |
| R6 | **Main/release ayrışması** | 36 ↔ 6 commit, 82 dosya, +18935/−3735. Ortak ata `a1ca60f` (3.8.7). | §4.2–4.3 |
| R7 | **`main`'den deploy = koruma kaybı** | R1+R2+R3 birlikte: main'den deploy, üretimde çalışan 3 korumayı geri alır. | §4.4 |
| R8 | **Append canlı mesaj gibi davranıyor (üretimde)** | `0b795ea`/`20c88bb`'de `type` yalnız hata tanılamasında kullanılıyor; `_ingestUpsertMessage`'a **geçirilmiyor** ⇒ üretimde geçmiş mesaj rozet/önizleme/canlı yayın üretiyor. | `socket-events.js:549` vs `:613` |
| R9 | **`gateway_connected` üretimde ERROR logluyor** | Üretim backend'inde `_ACKNOWLEDGED_IGNORE_EVENTS` yok ⇒ her köprü bağlantısında "bilinmeyen olay" dalı. | release=0 |
| R10 | **Test altyapısı hiçbir yerde otomatik koşmuyor** | `.github/workflows` **yok**; `frontend/package.json`'da `verify:notify-append` **yok**; yeni E2E yalnız elle `node …` ile çağrılıyor. | §6.3 |

**R8 ve R9 birer üretim kusurudur**, main'in getirdiği risk değil. main bunları düzeltiyor — ama düzeltmeyi taşıyan araç (gateway diff'i) mevcut release tabanıyla çakışıyor.

---

## 6. `e7f1077` commit'inin gerçek etkisi

### 6.1 Kapsam doğrulaması

| Soru | Cevap | Kanıt |
| --- | --- | --- |
| Yalnız test altyapısı + doküman mı? | **Evet** | 8/8 dosya `frontend/scripts/` veya `docs/audits/` |
| Frontend/backend/gateway üretim kaynağına etki? | **Hayır** | `git show --name-only` içinde `src/` yok; yasak-yol taraması 0 |
| `package.json` / bağımlılık değişikliği? | **Hayır** | `package.json`/lock dosyası 0 |
| Mevcut yapıyla uyum? | **Kısmen** | Dosya adlandırma ve `scripts/lib/` kullanımı tutarlı; **ama hiçbir npm script'ine bağlı değil** |

### 6.2 Ortam bağımlılıkları

| Bağımlılık | Değer | Risk |
| --- | --- | --- |
| Chrome yolu | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (sabit) | macOS'a kilitli. Yoksa `SKIP` + exit 0 ⇒ **sessiz atlama** |
| Port | `9335` (sabit; `verify-whatsapp-browser.mjs` = `9333`) | Port doluysa başlatma başarısız |
| Node modülleri | `esbuild`, `react`, `react-dom` | `frontend/` içinden koşulmalı |
| Çalışma dizini | `frontend/` (script içi `SRC` çözümlemesi) | Yanlış cwd'de bundle çözümlenemez |

`SKIP` davranışı dikkat çekici: Chrome yoksa test **başarısız olmuyor**, atlıyor ve exit 0 veriyor. Linux CI'da bu test hiçbir şey kanıtlamadan yeşil görünür.

### 6.3 Gerçek üretim akışını ne ölçüde temsil ediyor

**Gerçekten üretimden gelenler:**
- `I18nProvider`, `ThemeProvider`, `ToastProvider` — kopya değil, import;
- `ConversationList`, `ChatThread` — gerçek bileşenler;
- `buildChatPreview`, `shouldApplyPreview`, `mergeWhatsAppMessages`, `triggerInboundNotification` — **üretim fonksiyonları**, kopya değil;
- gerçek Chrome + CDP, gerçek layout (`scrollHeight`/`scrollTop` ölçümü);
- toast sayısı yapısal olarak (`data-testid` + metin) doğrulanıyor, sabit literalle değil;
- ses, `AudioContext` sınırında ölçülüyor (`FakeOsc.prototype.start` sayacı).

**Modellenen kısımlar:**
- `tezlify:ws_event` olayını test kendisi `window.dispatchEvent` ile üretiyor (tek dağıtım noktası olduğu için gerçek handler'lara gidiyor);
- **`unread_count` / `message_count` aritmetiği test harness'ında modelleniyor** (`:128-129`):
  `message_count: isReplay ? c.message_count : c.message_count + 1`,
  `unread_count: isReplay ? c.unread_count : (isSelected || isOutbound ? 0 : c.unread_count + 1)`.

**Bu son madde testin sınırıdır.** E2E, "backend doğru sayıları gönderirse frontend doğru davranır"ı kanıtlar. "Backend doğru sayıları gönderiyor"u **kanıtlamaz** — o iddia `backend/tests/test_whatsapp_upsert_append.py` (pytest) tarafındadır. İki kanıt birbirinin yerine geçmez.

Ayrıca E2E, `notify` ile `append` ayrımını **frontend'in gördüğü payload üzerinden** sınar; gateway'in `type`'ı gerçekten geçirdiğini sınamaz. Gateway tarafı `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` (a4f12d7) kapsamındadır.

### 6.4 R1 girinti belirsizliğinin commit içindeki gerçek etkisi

`verify-whatsapp-notify-append-browser.mjs` içindeki ~268 satırlık girinti bölgesi:
- dosya commit öncesi **untracked**'dı ⇒ hiçbir üretim kodunda karşılığı yok;
- dosya yalnız elle koşulan bir test betiği; hiçbir npm script'i, hiçbir CI onu çağırmıyor;
- dolayısıyla R1'in **üretim davranışına etkisi: sıfır**. Etki alanı yalnız "bu test dosyasındaki kod, 5.2.9'daki hâliyle anlamsal olarak aynı mı" sorusudur.
- Bu soru da tam kapatılamıyor (önceki blob yok), ama sınırlandı: `diff -w` sonrası senaryo/assert/dispatch satırlarında 0 fark; 8 senaryo adı/sırası/sonucu ve tüm kanıt dosyalarının hash'leri sürümler arası özdeş.

**R1 bu aşamada yeniden açılmıyor.** Kayda geçen hâli: kanıtlanamıyor, ama etki alanı üretim dışı.

### 6.5 "Geçmişte başarılı oldu" ≠ "release branch'te çalışır"

| Kanıt türü | Ne söyler | Ne söylemez |
| --- | --- | --- |
| 5.2.10'da 6/6 regresyon exit 0 | main ağacında, main'in bağımlılıklarıyla çalıştı | release ağacında çalışacağını |
| Kanıt hash'leri özdeş | deterministik | ortam taşınabilirliğini |
| `e7f1077` dosyaları release'te de var | taşıma **teknik olarak** mümkün | release'te **anlamlı** olduğunu |

Somut fark: `e7f1077`'nin değiştirdiği iki script (`verify-whatsapp-browser.mjs`, `verify-whatsapp-dom.mjs`) release branch'te **mevcut**, ve release'in `frontend/src`'i main'den yalnız **1 dosya / 16 satır** farklı. Yani bu iki script + yeni E2E release'e taşınabilir ve **orada da geçer**. Buna karşılık `test_whatsapp_upsert_append.py` ve `test_whatsapp_event_contract_parity.py` release'e taşınırsa **kırmızı olur** — çünkü sınadıkları üretim davranışı (`_no_broadcast`, `_ACKNOWLEDGED_IGNORE_EVENTS`) release'te yok.

Bu ayrım, §7'deki seçeneklerin temelidir.

---

## 7. Güvenli entegrasyon senaryoları

Hiçbiri uygulanmadı. Değerlendirme:

### A. Dört commit'in tamamını `origin/main`'e push etmek

| | |
| --- | --- |
| **Avantaj** | Yerel/uzak main eşitlenir; yedek uzakta durur; iş kaybı riski kalkar. |
| **Risk** | `origin/main` artık **deploy edilemez** bir ağaç içerir (4.27/4.28/4.17 yok). Bir sonraki operatör "main'den deploy" derse üretim korumaları geri alınır. Ayrıca `origin/main` ile release arasındaki uçurum kayda geçer ve normalleşir. |
| **Bağımlılık** | Yok. Tek `git push` (onay gerekir). |
| **Gerekli onay** | Push onayı. Deploy **ayrı** onay. |

### B. Yalnız test altyapısı commit'lerini ayrı bir test branch'ine taşımak

| | |
| --- | --- |
| **Avantaj** | Üretim kodu ile test kodu ayrışır; test branch'i istendiği yerde koşulur. |
| **Risk** | **Dört commit'in yalnız ikisi (%50) saf testtir.** `3bf17bf` ve `a4f12d7` üretim kodu içerir; ayrıştırmak için `git rebase -i` / parçalama gerekir — bu aşamada yasak ve riskli. Ayrıca testler, test ettikleri üretim davranışı olmadan branch'te **kırmızı** durur. |
| **Bağımlılık** | Commit parçalama (rewrite) ⇒ yeni SHA'lar, mevcut kanıt hash'leriyle bağ kopar. |
| **Gerekli onay** | Branch oluşturma + geçmişi yeniden yazma onayı. |

### C. Release branch'e yalnız gerekli test dosyalarını kontrollü entegre etmek

| | |
| --- | --- |
| **Avantaj** | En düşük riskli taşıma. `e7f1077`'nin tamamı (2 script + yeni E2E + kanıt json) release'te **dosya düzeyinde çakışmasız** uygulanabilir: iki hedef dosya release'te var, `frontend/src` farkı 16 satır, testler kendi harness'larıyla koşuyor. Üretim kodu taşınmaz ⇒ release deploy yolu **değişmez**. |
| **Risk** | Release branch'te testlerin koşacağı bir mekanizma yok (npm script, CI). Ayrıca "release'te test var, main'de yok" gibi ikinci bir asimetri doğar. `test_whatsapp_upsert_append.py` **taşınamaz** (kırmızı olur). |
| **Bağımlılık** | `git checkout <commit> -- <path>` benzeri dosya düzeyi işlem + release branch'e **commit** (deploy değil). |
| **Gerekli onay** | Release branch'e yazma onayı + ayrı commit onayı. Deploy **ayrı**. |

### D. Main üzerinde bırakıp Stage 5.3 geliştirmesine devam etmek

| | |
| --- | --- |
| **Avantaj** | Sıfır Git riski; mevcut kanıt ve rapor zinciri bozulmaz; 5.3 geliştirmesi main'de ilerler. Üretim hattı (`release/backend-only-seq-safety` + `20c88bb`) hiç dokunulmadan çalışmaya devam eder. |
| **Risk** | Ayrışma büyür (şu an 36 ↔ 6). 5.3'ün gateway değişiklikleri **yanlış tabana** (main'in gateway'i) yazılırsa, üretimdeki 4.17 pagination ile birleştirilmesi giderek pahalılaşır. Ayrıca R8/R9 üretim kusurları açık kalır. |
| **Bağımlılık** | 5.3 gateway işinin `20c88bb` sözleşmesine göre yazılması disiplini. |
| **Gerekli onay** | Yok (mevcut durumun sürdürülmesi). |

### 7.1 "Test kodunun release'te bulunması gerekli mi?"

**Zorunlu değil.** Gerekçe:
1. Release branch bir **deploy artefaktıdır**, geliştirme hattı değil. Amacı üretime giden ağacı dondurmak.
2. `e7f1077`'nin kanıtladığı şey **frontend davranışı**dır; bu davranış release'te de aynıdır (16 satırlık fark `whatsappApi.ts`'te ve E2E'nin sınadığı alanı etkilemiyor). Yani test release'te **yeni bir şey kanıtlamaz** — zaten main'de kanıtlandı.
3. Testleri release'e koymak, deploy edilen ağaca **çalışmayan bir doğrulama yükü** ekler: `npm test` benzeri bir giriş noktası olmadığı için kimse koşmaz, ama "testler var" yanılsaması yaratır.
4. Buna karşılık release'e konması **anlamlı olan tek şey** 4.27/4.28/4.17'nin kendi testleridir — ve onlar **zaten orada** (`test_whatsapp_initial_sync_chunking.py`, `test_whatsapp_pagination_contract.py`, `test-bulk-seq-pagination*.mjs`). Yani üretim hattının kendi regresyon ağı var; eksik olan main'inki değil.

**Sonuç:** Test altyapısını release'e taşımak **zorunluluk değil, tercih**tir ve tercih edilirse yalnız `e7f1077` kapsamı için savunulabilir.

---

## 8. Stage 5.3 için önerilen sonraki mikro-aşama

### 8.1 Mevcut durum (main, `e7f1077`)

| # | Öncelik | Durum | Kanıt |
| --- | --- | --- | --- |
| 1 | `group-participants.update` | **YOK** | gateway/src, backend/app, frontend/src → 0 referans |
| 2 | `groups.upsert` / `chats.upsert` | **YOK** | 0 / 0 referans |
| 3 | `messages.upsert` notify/append ayrımı | **VAR, uçtan uca** | gateway 3, backend 6 referans; frontend 0 (beklenen — append yayınlanmıyor) |
| 4 | `gateway_connected` lifecycle | **VAR** | gateway `events.js`×1, backend `events.py`×2 (ACK+düşür), frontend `whatsappApi.ts`×1 (yorum) |
| 5 | Frontend gerçek event aboneliği | **VAR** | `whatsappApi.ts::subscribe` tek `window` listener + `tezlify:ws_event` |
| 6 | Backend/gateway/frontend entegrasyon testleri | **KISMİ** | pytest + gateway mjs + gerçek Chrome E2E var; **hiçbiri otomatik koşmuyor** (CI yok) |

### 8.2 Önerilen mikro-aşama: **5.3.0 — Event sözleşmesi genişletme öncesi taban hizalama**

Gerekçe: 5.3'ün ilk iki maddesi (`group-participants.update`, `groups.upsert`/`chats.upsert`) **yeni gateway event'leri** eklemek demek. Ama main'in gateway'i üretimdeki gateway'den 11 dosya / +816/−1224 farklı ve 4.17'yi içermiyor. Yanlış tabana yazılan her yeni event, ileride 4.17 ile birleştirme maliyetini artırır.

Bu yüzden ilk mikro-aşama **kod yazmamalı**, tabanı sabitlemeli:

1. **Gateway sözleşme tabanını tespit et** (salt okunur): `20c88bb`'nin `socket-events.js` + `session-manager.js` event yüzeyi ile main'in aynı dosyalarının event yüzeyini yan yana koy; 5.3'ün ekleyeceği üç event'in **hangi tabana** yazılacağını yazılı karara bağla.
2. **`test_whatsapp_event_contract_parity.py`'yi genişlet** (henüz yeni event yok): gateway/backend/frontend üçlüsünün event adı kümelerini karşılaştıran mevcut testi, 5.3'te eklenecek event'ler için **allowlist iskeleti** ile hazırla. Böylece yeni event eklendiğinde sürüklenme anında yakalanır.
3. **Karar noktası:** 5.3 gateway işi main'de mi, yoksa `20c88bb` tabanlı yeni bir release dalında mı yürüyecek? Bu karar verilmeden `group-participants.update` yazılmamalı.

**Neden bu, neden şimdi:** 5.2'nin açık riski (R7: main deploy edilemez) 5.3'ün gateway işini doğrudan etkiliyor. Bu hizalanmadan atılan her adım, §4.6'daki "çok yüksek" çakışma satırını büyütür.

**Yazılmayacaklar:** `group-participants.update`, `groups.upsert`, `chats.upsert` implementasyonu bu mikro-aşamada **yazılmaz**.

---

## 9. Push/deploy öncesi gerekli ayrı onaylar

| İşlem | Kapsam | Ayrı onay | Not |
| --- | --- | --- | --- |
| `git push origin main` | 4 commit (`3bf17bf…e7f1077`) | **Gerekli** | `origin/main` deploy edilemez ağaç içerir (R7) |
| Release branch'e dosya ekleme (seçenek C) | `e7f1077` kapsamı | **Gerekli** | Ayrı commit; deploy değil |
| Yeni release dalı oluşturma | 4.27/4.28/4.17 yeniden uygulama | **Gerekli** | Deploy yolu değişir |
| `host-release.sh` ile deploy | — | **Gerekli, ayrı** | `--no-gateway` zorunluluğu main'de karşılanamıyor (R5) |
| Gateway restart | — | **Gerekli, ayrı** | A6: RAM store kaybı |
| Persistence loop açma | — | **Gerekli, ayrı** | 4.27 dormant; olduğu gibi açmak güvensiz |
| 4.34 canlı E2E kabulü | — | **Gerekli, ayrı** | Hâlâ koşulmadı |

Bu aşamada bunların **hiçbiri** yapılmadı.

---

## 10. Açık riskler ve doğrulanamayan noktalar

| # | Konu | Durum | Etki |
| --- | --- | --- | --- |
| A1 | **R1 girinti belirsizliği** | Kanıtlanamıyor (önceki blob yok, 3 tersine-çevirme denemesi hash oracle'ı tutmadı) | Üretim dışı; yalnız test dosyasının okunabilirliği. §6.4'te sınırlandı. |
| A2 | **`main`'in deploy edilebilirliği** | **Doğrulandı: edilemez.** 4.27/4.28/4.17 yok. | Release yolu tek deploy kaynağı olarak kalmalı. |
| A3 | **`20c88bb`'nin `main`'e birleştirilmesi** | **Denenmedi** (yasak). Çakışma tahmini §4.6'da; gerçek çakışma sayısı ölçülmedi. | Merge maliyeti bilinmiyor. |
| A4 | **`de1f1ad` ↔ `0b795ea` ilişkisi** | `0b795ea`'nın `de1f1ad`'ı içerdiği **doğrulandı** (`--is-ancestor`). Ama `0b795ea`'nın üretimde fiilen koştuğu **Git'ten kanıtlanamaz** (`.deployed-commit` sunucuda). | Deploy edilen SHA, geçmiş rapora dayanıyor; bağımsız doğrulanamadı. |
| A5 | **R8 (append canlı davranıyor)** | Üretimde **açık kusur**. Kod kanıtı: `socket-events.js:549` `type`'ı yalnız tanılamada kullanıyor. | Kullanıcıya görünen: geçmiş mesaj rozet/önizleme üretiyor. Düzeltme main'de, üretimde değil. |
| A6 | **R9 (`gateway_connected` ERROR)** | Üretimde **açık**. Her köprü bağlantısında ERROR satırı. | Log gürültüsü; gerçek hataları gizleyebilir. |
| A7 | **Test otomasyonu yok** | `.github/workflows` yok, yeni E2E hiçbir script'e bağlı değil. | "Yeşil" sonuçlar insan disiplinine bağlı. |
| A8 | **Chrome `SKIP` davranışı** | Chrome yoksa test exit 0 + `SKIP`. | Linux/CI'da sessizce hiçbir şey kanıtlamaz. |
| A9 | **`frontend/package.json` main = release** | **Doğrulandı** (boş diff). | Frontend bağımlılık yüzeyi iki hatta özdeş; bu bir risk değil, taşımayı kolaylaştıran olgu. |
| A10 | **`main`'in 3.9.x backup/escrow zinciri release'te yok** | `scripts/backup/`, `monitoring/systemd/`, 17 denetim raporu main'de var, `0b795ea`'da yok. | Ters yönlü asimetri: "release her şeyi içerir" varsayımı yanlış. Bu dosyaların üretimde kurulu olup olmadığı Git'ten kanıtlanamaz. |

### Doğrulanamayanlar (dürüst liste)

- Üretimde fiilen koşan SHA'lar (`.deployed-commit` yerelde yok; sunucuya bağlanmak bu aşamada yasak).
- `20c88bb` ile `main`'in gerçek merge çakışma sayısı (merge denemedi).
- `main`'deki 3.9.x backup/escrow dosyalarının üretimde kurulu olup olmadığı.
- R1'in byte düzeyinde ispatı.

---

## KARAR

# `CONDITIONAL`

**Gerekçe:** `main` üzerinde Stage 5.3 geliştirmesine devam etmek **güvenli** — üretim hattına dokunmuyor ve mevcut kanıt zinciri bozulmuyor. Ancak `main` **deploy edilemez** bir ağaçtır: üretimde çalışan 4.27 (epoch-reset), 4.28 (jid chunking) ve 4.17 (epoch-aware keyset pagination) korumalarının hiçbirini içermiyor. Bu nedenle karar koşulsuz "SAFE TO CONTINUE ON MAIN" değildir.

**Koşullar (hepsi sağlanmalı):**

1. **`main`'den deploy yapılmayacak.** Deploy kaynağı yalnız release hattı (`0b795ea` backend + `20c88bb` gateway) olarak kalacak.
2. **Stage 5.3'ün gateway işi yanlış tabana yazılmayacak.** `group-participants.update`, `groups.upsert`, `chats.upsert` yazılmadan önce §8.2'deki taban kararı verilecek.
3. **Push ve deploy ayrı ayrı onaylanacak** (§9). Push onayı deploy onayı **değildir**.
4. **R8 ve R9 açık kusur olarak kayıtta kalacak**; "5.2 tamamlandı" diye kapatılmayacak. Düzeltmeleri main'de, üretimde değil.
5. **Test altyapısı release'e taşınmayacak** — taşınacaksa yalnız `e7f1077` kapsamı için ve ayrı onayla (§7.1).

**Neden `BLOCKED` değil:** Hiçbir adım teknik olarak tıkanmış değil. Geliştirme ilerleyebilir; yalnız deploy yolu kapalı ve bu zaten bilinen/kabul edilen bir durum.

---

## Bu aşamada yapılmayanlar (doğrulama)

| İşlem | Sayı |
| --- | --- |
| Stage edilen dosya | 0 |
| Commit | 0 |
| Push | 0 |
| Deploy | 0 |
| Merge / cherry-pick / rebase | 0 |
| Branch değişikliği | 0 |
| Dosya düzenlemesi (bu rapor hariç) | 0 |
| Üretim DB / container / gateway işlemi | 0 |
| Persistence loop değişikliği | 0 |

HEAD `e7f1077` — aşama boyunca değişmedi. Kullanıcı değişiklikleri (24 `M` + 59 `??`) korundu.
