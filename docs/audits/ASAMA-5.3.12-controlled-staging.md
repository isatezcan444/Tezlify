# AŞAMA 5.3.12 — KONTROLLÜ COMMIT HAZIRLIĞI VE ALLOWLIST STAGE

**Hüküm: PASS**
**Kodlama:** HAYIR (üretim/test kodu yazılmadı) · **Altyapı:** HAYIR (deploy / SSH / Docker / servis / ağ yok)
**Worktree:** `/private/tmp/tz429-release` · **Branch:** `release/backend-only-seq-safety`
**Başlangıç HEAD:** `3ac26a9ffdd1a4738de915be255ee65c6b5be314` · **Bitiş HEAD:** `3ac26a9ffdd1a4738de915be255ee65c6b5be314` (değişmedi)

**COMMIT YAPILMADI. PUSH YAPILMADI. DEPLOY YAPILMADI.**

---

## 1. Özet

5.3.9 / 5.3.10 / 5.3.11'den devralınan 21 dosyalık allowlist tek tek doğrulandı.
**Hiçbiri eksik değil.** 20 dosya stage edildi; 21. dosya (`test-upsert-notify-append.mjs`)
zaten tracked ve **değişmemiş** olduğu için stage edilmedi.

Kritik bulgu: worktree'deki **20 kirli girdinin tamamı** allowlist içinde. Allowlist dışında
kirli dosya **yok** — yani yanlışlıkla stage edilebilecek kapsam dışı bir dosya hiç yoktu.
Bu, "kapsam dışı hiçbir dosya stage edilmedi" iddiasını *tesadüfe* değil **envanter eşitliğine**
dayandırıyor: `allowlist kirli kümesi == worktree kirli kümesi`.

---

## 2. Başlangıç envanteri (ölçüldü)

| Ölçüm | Değer |
| --- | --- |
| `pwd` | `/private/tmp/tz429-release` |
| `git branch --show-current` | `release/backend-only-seq-safety` |
| `git rev-parse HEAD` | `3ac26a9ffdd1a4738de915be255ee65c6b5be314` |
| Beklenen HEAD ile eşleşme | **MATCH** |
| Staged alan | **BOŞ** (`git diff --cached --name-only` → 0) |
| Modified (tracked) | **6** |
| Untracked | **14** |
| `git status --short` satırı | **20** |
| `git diff --stat` | 6 dosya · **120 ekleme / 24 silme** |

**`main`:** branch `main` · HEAD `e7f1077a489d94bc6b0f0afef6b575e48922162e` · dirty **87**

**Diğer worktree'ler:**

| Yol | HEAD | Durum |
| --- | --- | --- |
| `/Users/isatezcan/Documents/Github/Tezlify` | `e7f1077` `[main]` | dirty 87 |
| `/private/tmp/tz429-release` | `3ac26a9` `[release/backend-only-seq-safety]` | bu aşamanın alanı |
| `…/kilo/worktree-pool/tezlify-09592e68251d/tan-open` | `4465e3b` (detached) | **dirty 0** — dokunulmadı |

---

## 3. İncelenen allowlist (21 dosya) — hiçbiri eksik değil

Her satır: dosya var mı, tracked/untracked, hangi aşamadan geldiği, stage durumu.

### A. Üretim kaynak değişiklikleri (5) — hepsi tracked + modified

| Dosya | Durum | Kaynak | Diff kapsamı |
| --- | --- | --- | --- |
| `backend/app/services/whatsapp/orchestration/events.py` | tracked `M` | 5.3.9 | `replace`/`update` kabulü, `is_update`, `content_changed`, no-op replace → `_no_broadcast`, zamansız update önizlemeyi oynatmaz, rozet artmaz |
| `backend/app/services/whatsapp/orchestration/sessions.py` | tracked `M` | 5.3.9 | `gw_id` `db.delete` öncesi yakalanır; commit **sonrası** `session_disconnected{reason:"DELETED"}` tenant-scoped broadcast |
| `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` | tracked `M` | 5.3.9 + 5.3.10-F1 | `isReplace` + yerinde birleştirme + `created_at`/`external_timestamp` koruma guard'ı |
| `whatsapp-gateway/src/session-manager.js` | tracked `M` | 5.3.9 | `isReplace`, `Date.now()` düşüşü yerine `existingRecord.created_at` korunur, replace eski kaydı media'dan bağımsız siler, rozet artmaz |
| `whatsapp-gateway/src/socket/socket-events.js` | tracked `M` | 5.3.9 | `messageTimestamp ?? undefined` (artık `Date.now()` fallback yok) + açık `upsertType:'replace'` |

**Diff incelemesi sonucu:** beş dosyanın tamamı 5.3.9/5.3.10'da raporlanan davranışla
**tutarlı**. Önceki aşama raporlarıyla çelişki **yok**.

Ek olarak doğrulanan bir sıralama riski: `session-manager.js`'te `existingRecord` satır **2446**'da
tanımlanıyor, yeni `existingTsMs` hesabı satır **2534**'te kullanıyor — TDZ/`undefined` tuzağı yok.

### B. Backend testleri ve runner (4) — hepsi untracked

| Dosya | Boyut | Test fn | Kaynak |
| --- | --- | --- | --- |
| `backend/tests/test_whatsapp_4_34_e2e_regressions.py` | 311 satır / 11.543 B | 6 | 4.34 — **bayt-bayt** kurtarma (`da9a2641…`) |
| `backend/tests/test_whatsapp_message_update_semantics.py` | 335 satır / 12.819 B | 9 | 5.3.9 |
| `backend/tests/test_whatsapp_session_delete_lifecycle.py` | 239 satır / 9.476 B | 6 | 5.3.9 |
| `backend/scripts/run_whatsapp_regression.py` | 166 satır / 6.283 B | — (runner) | 5.3.7 kurtarma + 5.3.11 `MANDATORY_TESTS` 8→10 |

### C. Gateway testleri (4) — 3 untracked + 1 tracked-clean

| Dosya | Durum | Kaynak |
| --- | --- | --- |
| `whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs` | **untracked** · 300 satır / 10.756 B | 4.28 — **bayt-bayt** kurtarma (`5f053cb5…`) |
| `whatsapp-gateway/scripts/test-ingest-write-order.mjs` | **untracked** · 297 satır / 11.436 B | 5.3.7 kurtarma |
| `whatsapp-gateway/scripts/test-message-update-semantics.mjs` | **untracked** · 216 satır / 9.785 B | 5.3.9 |
| `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` | **tracked · CLEAN** · 156 satır / 6.325 B | 5.2 — **stage edilmedi** |

`test-upsert-notify-append.mjs` beklendiği gibi HEAD'de tracked; `git status` onu **listelemiyor**
⇒ içerik HEAD ile aynı, stage edilecek bir değişiklik yok. Stage etmeye çalışılmadı.

### D. Frontend doğrulama betikleri (3) — hepsi untracked

| Dosya | Boyut | Kaynak |
| --- | --- | --- |
| `frontend/scripts/verify-live-mode-ws-connected.mjs` | 307 satır / 12.363 B | 5.3.7 kurtarma |
| `frontend/scripts/verify-conversation-replace-semantics.mjs` | 475 satır / 20.217 B | 5.3.10 |
| `frontend/scripts/verify-session-deleted-multitab.mjs` | 344 satır / 15.658 B | 5.3.10 |

### E. Gateway test zinciri (1) — tracked modified

| Dosya | Diff | Doğrulama |
| --- | --- | --- |
| `whatsapp-gateway/package.json` | `1 1` (tek satır) | `scripts.test` **36 → 40** halka; HEAD'in 36 halkası **birebir ve aynı sırada**; eklenen 4: tz428 → upsert-notify-append → ingest-write-order → message-update-semantics |

### F. Aşama raporları (4) — hepsi untracked, hepsi mevcut

| Dosya | Boyut | Başlık |
| --- | --- | --- |
| `docs/audits/ASAMA-5.3.8-event-contract-analysis.md` | 589 satır / 37.185 B | "AŞAMA 5.3.8 — WHATSAPP EVENT CONTRACT VE UPDATE SEMANTİĞİ DENETİMİ" |
| `docs/audits/ASAMA-5.3.9-update-semantics-session-lifecycle.md` | 295 satır / 17.154 B | "AŞAMA 5.3.9 — WHATSAPP UPDATE SEMANTİĞİ VE SESSION LIFECYCLE…" |
| `docs/audits/ASAMA-5.3.10-regression-recovery-frontend-e2e.md` | 456 satır / 26.402 B | "AŞAMA 5.3.10 — REGRESYON KURTARMA VE FRONTEND UPDATE E2E" |
| `docs/audits/ASAMA-5.3.11-regression-chain-integration.md` | 438 satır / 19.960 B | "AŞAMA 5.3.11 — REGRESSION TEST CHAIN INTEGRATION" |

**§4F çelişkisi çözüldü.** "5.3.10 raporu önceki final envanterde görünmüyordu" notu
doğrulanamadı: dosya **mevcut** (26.402 B, 456 satır, doğru başlık, untracked). 5.3.11'in
`git status` envanterinde de listelenmişti. Yok sayılmadı, yeniden üretilmedi, başka bir
dosyayla ikame edilmedi.

**Eksik dosya: 0.**

---

## 4. Stage öncesi kontrol kapısı (§6)

| Kapı | Sonuç |
| --- | --- |
| 1. Aday dosyaların tam listesi | 21 dosya (yukarıda) |
| 2. Eksik / beklenmeyen dosya | **eksik 0** · **beklenmeyen 0** |
| 3. Tracked / untracked ayrımı | 6 modified + 1 tracked-clean + 14 untracked |
| 4. `git diff --check` | **CLEAN** |
| 5. Boyut + SHA-256 kaydı | 21/21 dosya kaydedildi (aşağıda) |
| 6. Başlangıç staged alanı boş mu | **BOŞ** |

**Kapsam eşitliği kanıtı:** stage adayı küme (`git status` modified + `git ls-files --others`)
ile allowlist karşılaştırıldı → `comm -23` **boş** (allowlist dışı aday yok).

### Stage öncesi SHA-256 manifesti (kısaltılmış; tam hali koşu çıktısında)

| Dosya | SHA-256 (ilk 16) |
| --- | --- |
| `events.py` | `880162745b60e747` |
| `sessions.py` | `bc5c6610a42a3ca1` |
| `useWhatsAppConversation.ts` | `15e8c8f770f20629` |
| `session-manager.js` | `27a3c80e76d25eab` |
| `socket-events.js` | `a2f7281ffee20892` |
| `test_whatsapp_4_34_e2e_regressions.py` | `da9a26413755268c` |
| `test_whatsapp_message_update_semantics.py` | `c1ffe58ddb830b36` |
| `test_whatsapp_session_delete_lifecycle.py` | `d2221dc2f0654381` |
| `run_whatsapp_regression.py` | `b2dc87ef29430bad` |
| `test-tz428-initial-sync-front-trim.mjs` | `5f053cb504071912` |
| `test-ingest-write-order.mjs` | `588f3d35f1439151` |
| `test-message-update-semantics.mjs` | `48000c6cb35a72b2` |
| `test-upsert-notify-append.mjs` | `f2770bac4e96d515` |
| `verify-live-mode-ws-connected.mjs` | `6866e73ac185cd6e` |
| `verify-conversation-replace-semantics.mjs` | `1ec31c62df141e4f` |
| `verify-session-deleted-multitab.mjs` | `9125e42c07747fd8` |
| `whatsapp-gateway/package.json` | `1b9682dd9b63d318` |
| `ASAMA-5.3.8-…md` | `efd4bc0bb14837b1` |
| `ASAMA-5.3.9-…md` | `d3d63b01d6e87413` |
| `ASAMA-5.3.10-…md` | `7dcb6e03a239a37c` |
| `ASAMA-5.3.11-…md` | `55bd66d3a7680602` |

Beş üretim dosyasının hash'i 5.3.11'in bitiş kaydıyla **aynı** — devirde sessiz değişiklik yok.

---

## 5. Stage işlemi

Yöntem: **yalnızca** `git add -- <tam-yol>`, her dosya için tek tek, doğrulanmış 20 satırlık
liste üzerinden. `git add .`, `git add -A`, `git add -f` **kullanılmadı**. Glob yok.
Eksik dosya oluşturulmadı, içerik değiştirilmedi.

### Stage edilen 20 dosya

| # | Durum | Dosya |
| --- | --- | --- |
| 1 | `M` | `backend/app/services/whatsapp/orchestration/events.py` |
| 2 | `M` | `backend/app/services/whatsapp/orchestration/sessions.py` |
| 3 | `A` | `backend/scripts/run_whatsapp_regression.py` |
| 4 | `A` | `backend/tests/test_whatsapp_4_34_e2e_regressions.py` |
| 5 | `A` | `backend/tests/test_whatsapp_message_update_semantics.py` |
| 6 | `A` | `backend/tests/test_whatsapp_session_delete_lifecycle.py` |
| 7 | `A` | `docs/audits/ASAMA-5.3.8-event-contract-analysis.md` |
| 8 | `A` | `docs/audits/ASAMA-5.3.9-update-semantics-session-lifecycle.md` |
| 9 | `A` | `docs/audits/ASAMA-5.3.10-regression-recovery-frontend-e2e.md` |
| 10 | `A` | `docs/audits/ASAMA-5.3.11-regression-chain-integration.md` |
| 11 | `A` | `frontend/scripts/verify-conversation-replace-semantics.mjs` |
| 12 | `A` | `frontend/scripts/verify-live-mode-ws-connected.mjs` |
| 13 | `A` | `frontend/scripts/verify-session-deleted-multitab.mjs` |
| 14 | `M` | `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` |
| 15 | `M` | `whatsapp-gateway/package.json` |
| 16 | `A` | `whatsapp-gateway/scripts/test-ingest-write-order.mjs` |
| 17 | `A` | `whatsapp-gateway/scripts/test-message-update-semantics.mjs` |
| 18 | `A` | `whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs` |
| 19 | `M` | `whatsapp-gateway/src/session-manager.js` |
| 20 | `M` | `whatsapp-gateway/src/socket/socket-events.js` |

### Stage EDİLMEYEN dosyalar ve gerekçeleri

| Dosya | Gerekçe |
| --- | --- |
| `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` | Allowlist'te **var**, ama **tracked ve CLEAN** (içerik HEAD ile aynı) ⇒ stage edilecek değişiklik yok. Gereksiz `git add` yapılmadı. |
| `.workbuddy-ai/memory/*` (14 dosya, HEAD'de tracked) | Kapsam dışı. Worktree kopyası **temiz**; hiç stage edilmedi. |
| `frontend/dist/` | Kapsam dışı build çıktısı, `.gitignore:31` ile ignore — zaten untracked listesinde görünmüyor. |
| `node_modules` (3 symlink) | 5.3.11 sonunda kaldırıldı; mevcut değil. |
| `__pycache__`, `__mut*.mjs`, `__tmp_runner_probe.py` | 5.3.11 sonunda silindi; mevcut değil. |
| `main` worktree'nin 87 kirli dosyası | Farklı worktree; bu indeksle ilgisi yok, dokunulmadı. |

**Kapsam dışı stage edilen dosya: 0.**

---

## 6. Staged diff özeti

```
20 files changed, 4888 insertions(+), 24 deletions(-)
```

| Grup | Dosya | Ekleme/Silme |
| --- | --- | --- |
| Üretim (5) | `events.py` 47 · `sessions.py` 23 · `useWhatsAppConversation.ts` 28 · `session-manager.js` 35 · `socket-events.js` 9 | **119 / 23** |
| Manifest (1) | `whatsapp-gateway/package.json` | 1 / 1 |
| Backend test+runner (4) | 311 + 335 + 239 + 166 satır | 1.051 / 0 |
| Gateway testleri (3) | 300 + 297 + 216 satır | 813 / 0 |
| Frontend betikleri (3) | 475 + 307 + 344 satır | 1.126 / 0 |
| Raporlar (4) | 589 + 295 + 456 + 438 satır | 1.778 / 0 |

Üretim kısmı `119 / 23` — 5.3.10 ve 5.3.11'in kaydettiği değerle **tam aynı**.
`whatsapp-gateway/package.json` `1 / 1` — tek satır.

`git diff --cached --check`: **CLEAN** (boşluk hatası yok).

---

## 7. Stage sonrası doğrulama (§8)

| # | Kanıt | Sonuç |
| --- | --- | --- |
| P1 | Staged dosyaların tamamı allowlist içinde (`comm -23` boş) | **PASS** |
| P2 | Allowlist dışı staged dosya yok | **PASS** (0) |
| P3 | Stage edilen içerik incelenen içerikle aynı — 20/20 `git show :path \| sha256` == stage öncesi manifest | **PASS** |
| P4 | Stage edilmemiş kullanıcı değişikliği korundu — 20/20 worktree dosyası hash'i değişmedi; `git diff --name-status` boş | **PASS** |
| P5 | `.workbuddy-ai/memory/*` staged değil (0) ve içeriği değişmedi (dirt 0) | **PASS** |
| P6 | HEAD hâlâ `3ac26a9ffdd1a4738de915be255ee65c6b5be314` | **PASS** |
| P7 | Branch hâlâ `release/backend-only-seq-safety` | **PASS** |
| P8 | `main` HEAD `e7f1077a…` ve dirty **87** — değişmedi | **PASS** |

### `.workbuddy-ai/memory/*` koruma kanıtı

- Worktree'de `.workbuddy-ai/memory/` altında HEAD'in izlediği **14 dosya** var; `find` çıktısı
  `git ls-tree -r HEAD -- .workbuddy-ai` ile **birebir aynı**.
- `git status --porcelain -- .workbuddy-ai` → **0 satır** (temiz, değişmemiş).
- `git diff --cached --name-only -- .workbuddy-ai` → **0** (stage edilmedi).
- 5.3.11'de yazılan `2026-11-02.md` bu worktree'de **hiç yok** (yalnızca `main` worktree'sinde,
  o da bu indeksin dışında). Dolayısıyla bu aşamada memory'ye dokunma riski oluşmadı.

### `main` değişmezlik kanıtı

| Ölçüm | Başlangıç | Bitiş |
| --- | --- | --- |
| Branch | `main` | `main` |
| HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | `e7f1077a489d94bc6b0f0afef6b575e48922162e` |
| Dirty | 87 | **87** |

`main` üzerinde checkout / merge / rebase / reset / fetch / pull **yapılmadı**.

---

## 8. Güvenlik kapıları

| Kural | Durum |
| --- | --- |
| 1. Çalışma alanı doğru mu | **EVET** — `pwd` = `/private/tmp/tz429-release` |
| 2. HEAD beklenen değerle eşleşiyor mu | **EVET** — `3ac26a9…` MATCH |
| 3. Branch adı doğru mu | **EVET** — `release/backend-only-seq-safety` |
| 4. `main`'e checkout/merge/rebase/reset | **YAPILMADI** |
| 5. `git add .` / `-A` / `-f` | **KULLANILMADI** (yalnız `git add -- <dosya>`) |
| 6. `git clean` / `reset --hard` / `checkout --` / `restore` / silme | **KULLANILMADI** |
| 7. Kullanıcı değişikliklerini düzeltme/formatlama/yeniden yazma | **YAPILMADI** (20/20 hash sabit) |
| 8. `.workbuddy-ai/memory/*` ve kapsam dışı kirli dosyalar | **DOKUNULMADI** |
| 9. Belirsiz içerikte tahmin | **YOK** — 21/21 dosya açıldı/okundu |
| 10. Stage öncesi/sonrası envanter karşılaştırması | **YAPILDI** (§4, §7) |
| 11. Stage sırasında beklenmeyen dosya | **YOK** — 20/20 önceden listelenmiş |
| 12. Commit / push / deploy | **YAPILMADI** |

Ek olarak: `amend`, `fetch`, SSH, Docker, servis işlemi, production DB bağlantısı, QR/WhatsApp
oturumu — **hiçbiri** yapılmadı.

---

## 9. §9 raporunun kendisinin stage edilmesi

Bu rapor (`docs/audits/ASAMA-5.3.12-controlled-staging.md`) §9 gereği ayrıca stage edilir.
Allowlist'te adı geçmediği için **21. dosya** olarak, §9'un açık yetkisiyle eklenir; bu
genişletme raporun §5 tablosunda "stage edilen 20" olarak değil, burada ayrıca beyan edilir.

Stage sonrası beklenen nihai durum: **21 staged dosya**, allowlist 21 + bu rapor.

---

## 10. Açık maddeler (devralınan)

| # | Konu | Durum |
| --- | --- | --- |
| R1 | `frontend/scripts/verify-*.mjs` betikleri hâlâ **hiçbir npm zincirinde değil** — elle koşuluyor | 5.3.11 kapsamı dışı bıraktı; açık |
| R2 | 7 frontend betiği **önceden kırmızı** (`Avatar.tsx` / `ChatBubble.tsx` — 5.3.10'da HEAD'e karşı kanıtlandı) | Değişmedi |
| R3 | 4.34 canlı E2E kabulü koşulmadı; persistence döngüsü kapalı | Açık |
| R4 | `whatsapp-gateway/package.json` + runner değişikliği commit edilene kadar release dalında staged | Bu aşamanın normal sonucu |

---

## 11. Hüküm

Tüm kapılar geçti, hiçbir kural ihlal edilmedi, hiçbir kapsam dışı dosya stage edilmedi.

**AŞAMA 5.3.12 HÜKMÜ: PASS**

**COMMIT DURUMU: YAPILMADI — AYRI KULLANICI ONAYI BEKLENİYOR**

Bu aşama yalnızca kontrollü staging hazırlığıdır. **Commit izni değildir.**
