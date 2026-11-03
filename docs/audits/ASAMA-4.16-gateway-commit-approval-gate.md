# Aşama 4.16 — WhatsApp Gateway Release Commit Approval Gate

**Tarih:** 2026-10-31
**Mod:** DOĞRULAMA (read-only). COMMIT=YASAK, PUSH=YASAK, DEPLOY=YASAK.
**Amaç:** 4.15 adayını son kez kanıtla doğrulamak ve commit için açık onay talebi sunmak.
**Sonuç:** ✅ **READY FOR EXPLICIT COMMIT APPROVAL** (1 koşul ile)

---

## 0. Özet

`/tmp/tz415-gw` adayı, 4.15'te raporlanan haliyle **bit-bit aynı** durumda. 12 zorunlu kontrolün
11'i PASS, 1'i **koşullu PASS** (aşağıda §3, D1). Hiçbir commit/push/deploy/restart/DB-write yapılmadı;
üretim `.deployed-commit` hâlâ `cbe4f509`.

> Not: Aday için **commit SHA'sı henüz yok** — bu aşama commit üretmez. Kimlik iki çapayla sabittir:
> **base `cbe4f509`** + **write-tree `8746115ac8dd738a466e69e9547dc0a2844e655c`**. Commit atıldığında
> SHA bu ikisinden deterministik olarak türeyecektir; onay bu iki değere verilir.

---

## 1. Kontrol Tablosu (12 zorunlu kontrol)

| # | Kontrol | Sonuç | Kanıt |
| --- | --- | --- | --- |
| 1 | `/tmp/tz415-gw` mevcut | **PASS** | Gerçek yol `/private/tmp/tz415-gw`; `git worktree list` içinde kayıtlı |
| 2 | HEAD = `cbe4f509` | **PASS** | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| 3 | Detached HEAD raporlandı | **PASS** | `git symbolic-ref -q HEAD` → rc=1; `branch --show-current` boş; hiçbir branch'e bağlı değil |
| 4 | Staged dosya = 7 | **PASS** | `git diff --cached --name-only \| wc -l` → 7 |
| 5 | Hepsi `whatsapp-gateway/` altında | **PASS** | `git diff --cached --name-only \| grep -v '^whatsapp-gateway/'` → boş (rc=1) |
| 6 | write-tree = `8746115a…` | **PASS** | `git write-tree` → `8746115ac8dd738a466e69e9547dc0a2844e655c` |
| 7 | Diff stat `+1210 / -23` | **PASS** | `7 files changed, 1210 insertions(+), 23 deletions(-)` |
| 8 | backend/frontend/docs/MEMORY kapsam dışı | **PASS** | `grep -E '^(backend/\|frontend/\|docs/\|\.workbuddy-ai/)\|MEMORY\.md'` → boş (rc=1) |
| 9 | `node_modules` / geçici dosya kapsam dışı | **KOŞULLU PASS** | Stage'de 0 kayıt (`grep -c node_modules` → 0). **Ama** bkz. D1: `git add -A` bunu ekler |
| 10 | 4.15 test kanıtı + rapor | **PASS** | `docs/audits/ASAMA-4.15-gateway-front-trim-remediation.md` okundu; testler **izole adayda** yeniden koşuldu (§4) |
| 11 | `2236cae`/`17ccbc9`/`cbe4f509` dokunulmadı | **PASS** | Üçü de `git cat-file -t` → `commit`; SHA'lar 4.15 ile aynı; `release/backend-only-4.7` → `2236cae` |
| 12 | Üretim `.deployed-commit` değişmedi | **PASS** | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (salt-okunur `cat`) |

---

## 2. Aday Kimliği

| Alan | Değer |
| --- | --- |
| Worktree | `/tmp/tz415-gw` → `/private/tmp/tz415-gw` |
| HEAD (base) | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| Durum | **detached HEAD** (branch yok) |
| Write-tree | `8746115ac8dd738a466e69e9547dc0a2844e655c` |
| Kapsam | yalnızca `whatsapp-gateway/` |
| Diff stat | `7 files changed, 1210 insertions(+), 23 deletions(-)` |
| Unstaged değişiklik | **yok** (porcelain ikinci kolonu boş) |

### Staged dosyalar (tam liste) + blob SHA1

| # | Dosya | Durum | Blob SHA1 |
| --- | --- | --- | --- |
| 1 | `whatsapp-gateway/package.json` | M | `53a9a1ef90cdd44e94daecbe753bbeaee6bf5a30` |
| 2 | `whatsapp-gateway/scripts/test-bulk-seq-pagination-guarantees.mjs` | A | `a93bf0614720028c8d83475f82f71b80ebad4e02` |
| 3 | `whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs` | A | `761ff7a92bdd01aef49d8a817d7413fc1d4ea95b` |
| 4 | `whatsapp-gateway/src/index.js` | M | `128b0bbb7679fcce391bf2012d7343d2cea1965b` |
| 5 | `whatsapp-gateway/src/messages/message-store.js` | M | `c5bef759693a4dc575dde9e7f9999543be1c8d1b` |
| 6 | `whatsapp-gateway/src/session-manager.js` | M | `b8676998a1ca8ae1083649007b7376d548dc7718` |
| 7 | `whatsapp-gateway/src/socket/socket-events.js` | M | `cd3a21cc497c66d4bfe2a50629c7aee7243763d9` |

> Blob SHA1'ler `git ls-tree -r 8746115a…` ile **write-tree'den** okundu (çalışma ağacından değil) ve
> 4.15 §9 manifestosuyla **7/7 birebir** eşleşiyor. Yani ağaç, raporun tarif ettiği ağaçtır.
> Hash alanı: burada **git blob SHA1** kullanılır (`shasum -a 256` = SHA256, karıştırılmamalı).

### Diff stat (dosya bazında)

```
 whatsapp-gateway/package.json                      |   2 +-
 .../test-bulk-seq-pagination-guarantees.mjs        | 537 +++++++++++++++++++++
 .../scripts/test-bulk-seq-pagination.mjs           | 216 +++++++++
 whatsapp-gateway/src/index.js                      |  13 +-
 whatsapp-gateway/src/messages/message-store.js     | 278 ++++++++++-
 whatsapp-gateway/src/session-manager.js            | 177 +++++++-
 whatsapp-gateway/src/socket/socket-events.js       |  10 +-
 7 files changed, 1210 insertions(+), 23 deletions(-)
```

**Küçük diff'lerin içerik doğrulaması:**
- `package.json` → yalnızca `test` zincirine iki seq script'i **eklendi**; başka hiçbir değişiklik yok
  (main-only scriptler eklenmedi → drift yok).
- `src/index.js` → `/health`'e `capacity: sessionManager.ramCapacitySummary()` (yalnızca sayımlar, PII yok)
  ve `/messages/bulk` destructure'ına `afterSeq, seqEpoch` + `parseInt`/`String` normalizasyonu. Eski
  parametreler ve varsayılanlar **aynen** korunmuş.

---

## 3. Tespit Edilen Sapmalar

### D1 — `whatsapp-gateway/node_modules` bir **symlink** ve `.gitignore` onu yakalamıyor (KOŞULLU PASS'ın nedeni)

```
lrwxr-xr-x  whatsapp-gateway/node_modules -> /tmp/tz410-release/whatsapp-gateway/node_modules
git check-ignore -v whatsapp-gateway/node_modules  → rc=1 (eşleşme YOK)
.gitignore:30  node_modules/                        → yalnızca DİZİN eşler, symlink'i eşlemez
git add -An --dry-run → add 'whatsapp-gateway/node_modules'
```

**Anlamı:** Aday şu anda temiz (stage'de node_modules yok), ancak commit anında `git add -A` veya
`git add .` çalıştırılırsa **symlink commit'e girer** — üstelik hedefi `/tmp/tz410-release/...` gibi
makineye özgü bir yol olur. Bu, release commit'ine sızabilecek gerçek bir tuzaktır.

**Koşul:** Commit **yalnızca açık dosya listesiyle** stage edilmelidir (aşağıdaki §6 komutu). `git add -A`
kullanılmamalıdır. İsterseniz ayrı bir küçük commit'te `.gitignore`'a `node_modules` (eğik çizgisiz) veya
`whatsapp-gateway/node_modules` eklenebilir — **bu commit'e dahil edilmemeli**, kapsam gateway fix'idir.

### D2 — 4.15 raporundaki "43 script" ifadesi ile gerçek zincir (36 giriş) uyuşmuyor (dokümantasyon)

`package.json` `test` zinciri `&&` ile bölündüğünde **36** giriş veriyor; 4.15 §8 "43 script" yazıyor.
Kod açısından fark yok (hepsi exit 0), yalnızca rapor metnindeki sayı hatalı. Onayı etkilemez; 4.16
kanıtı olarak **36 giriş / 0 hata / exit 0** esas alınmalıdır.

### D3 — Yol takma adı (bilgi)

`/tmp` → `/private/tmp` symlink'i nedeniyle `git worktree list` yolu `/private/tmp/tz415-gw` gösterir.
Aynı worktree'dir; sapma değil, kayıt notu.

**Başka sapma yok.** Backend, frontend, `docs/`, `.workbuddy-ai/memory`, `MEMORY.md`, `node_modules`
stage'de **hiç yok**; unstaged değişiklik **hiç yok**.

---

## 4. Test Kanıtları (bu oturumda, izole adayda yeniden koşuldu)

Yalnızca `/tmp/tz415-gw/whatsapp-gateway` içinde çalıştırıldı; üretime hiçbir çağrı yapılmadı.

| Kapı | Komut | Sonuç | Çıkış |
| --- | --- | --- | --- |
| Seq sözleşme | `node scripts/test-bulk-seq-pagination.mjs` | **8/8 PASS** (A–H) | **0** |
| Seq garanti | `node scripts/test-bulk-seq-pagination-guarantees.mjs` | **32/32 PASS** | **0** |
| Tam suite | `npm test` (36 giriş) | tüm zincir yeşil, 1m47s | **0** |

Ek doğrulama: `grep -cE "not ok|AssertionError|UnhandledPromiseRejection"` → **0**.
Log'daki "FAIL"/"provider failure" dizgileri test **adlarıdır**, gerçek başarısızlık değildir (4.15 §8 notu).

Kod tarafı teyitleri:
- `_seq` `enumerable: false` olarak tanımlı (`message-store.js:168,200`) → API/WS yanıtına sızmaz.
- Staged diff'te `GATEWAY_ENCRYPTION_KEY|password|secret|token|PRIVATE KEY|api_key` taraması → **eşleşme yok**.

---

## 5. Üretim Baseline Durumu (değişmedi)

| Nesne | Değer | Nasıl okundu |
| --- | --- | --- |
| `.deployed-commit` | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` | `ssh ubuntu@… 'cat /opt/tezlify/.deployed-commit'` (salt-okunur) |
| Deploy/push/restart | **yapılmadı** | — |
| DB write / RAM wipe / persistence enable | **yapılmadı** | — |
| `2236cae` / `17ccbc9` / `cbe4f509` | değişmedi | `git rev-parse` + `git log -1` |

Bu oturumda hiçbir yazma komutu çalıştırılmadı; `git add` dahi `-n` (dry-run) ile yapıldı.

---

## 6. Onaylanacak İşlem (tam olarak bu)

**Hedef:** gateway-only release commit'i. Backend/frontend commit'lerine dokunulmaz.

**Stage komutu (açık liste — `git add -A` YASAK):**
```bash
cd /tmp/tz415-gw
git add -- \
  whatsapp-gateway/package.json \
  whatsapp-gateway/scripts/test-bulk-seq-pagination-guarantees.mjs \
  whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs \
  whatsapp-gateway/src/index.js \
  whatsapp-gateway/src/messages/message-store.js \
  whatsapp-gateway/src/session-manager.js \
  whatsapp-gateway/src/socket/socket-events.js
git write-tree   # 8746115ac8dd738a466e69e9547dc0a2844e655c ÇIKMALI
```

**Commit mesajı (önerilen):**
```
fix(whatsapp-gateway): implement epoch-aware sequence pagination

P0-1 gateway half was never committed: deployed index.js reads only
limit/offset/since/perChatLimit/jids; a live ?afterSeq probe returns a
byte-identical page with no `pagination` key, so the backend silently
falls back to offset mode and the cursor is never reset — front-trim
silently drops unseen records.

Introduce `_seq` (insert-time, strictly increasing, non-enumerable) and
`seqEpoch` so the bulk endpoint supports keyset pagination: afterSeq is a
value, not a position, so head eviction cannot shift the cursor.
perChatLimit no longer trims in seq mode (was the silent skip). Offset
path and all legacy clients are untouched. Tests: 8 + 32 checks green,
full `npm test` green.
```

**Ayrı yetkilendirmeler (bu onay kapsamında DEĞİL):**
1. **PUSH** — commit'ten sonra ayrı onay.
2. **DEPLOY** — `scripts/deploy/host-release.sh` ile, ayrı onay. Deploy sırası: backend kalıcılığı
   doğrula → `messages` / `/health.whatsapp_memory_persistence` → gateway (gateway RAM store'u yeniden
   kurulur, A6).

---

## 7. Nihai Karar

### ✅ READY FOR EXPLICIT COMMIT APPROVAL

**Gerekçe:** 12 kontrolün 11'i tam PASS; 1'i (node_modules) stage'de temiz olduğu için PASS, ancak
`git add -A` tuzağı nedeniyle **koşullu**. Kod, kapsam, write-tree, testler ve üretim baseline'ı
4.15 ile birebir tutarlı; hiçbir yeni sapma yok.

**Onay koşulu (tek):** Commit **yalnızca §6'daki açık dosya listesiyle** stage edilsin; `git add -A`
kullanılmasın. Stage sonrası `git write-tree` → `8746115a…` doğrulanmalı.

**NOT:** Bu aşama commit aşaması değildir. Yukarıdaki 7 dosya + mesaj için **açık onay bekleniyor**.
Commit, push ve deploy üç ayrı yetkilendirmedir.
