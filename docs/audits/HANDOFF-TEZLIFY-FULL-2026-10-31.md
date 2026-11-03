# TEZLIFY — TAM HANDOFF (3.4 → 4.15) — 2026-10-31

> **Amaç:** Tezlify WhatsApp alt sistemi üzerinde bugüne kadar yapılan tüm çalışmayı, ulaşılan sonuçları,
> üretim durumunu, kritik güvenlik kurallarını ve kalan işleri **tek başına anlaşılır** bir biçimde özetlemek.
> Bu dosyayı okuyan yeni bir AI, projenin mevcut durumunu ve bir sonraki adımı doğrudan kavramalıdır.
>
> **GÜVENLİK:** Bu dosya **anahtar, token, private key veya credential değeri içermez.** Yalnızca 8 haneli
> genel doğrulama çapası (`c25805a2`) ve özet (SHA) önekleri yer alır. Üretim anahtarı sunucudan hiçbir
> şekilde çıkmaz.

---

## 0. İÇİNDEKİLER

1. Proje Bağlamı
2. Kritik Invariantlar ve Geri Alınamaz Hasar Kuralları (ASLA İHLAL EDİLMEYECEK)
3. Güncel Git / Deploy Durumu (başlangıç çapaları)
4. Çalışma Zaman Çizelgesi (3.4 → 4.15)
5. P0-1 / 4.15 Hikâyesi (en güncel ve en kritik)
6. Üretim Ölçümleri (4.14, salt okunur)
7. MEVCUT DURUM — Kalan İşler
8. Yeni AI'nın Yapmaması Gerekenler
9. Yeni AI'nın Okuması Gereken Dosyalar

---

## 1. PROJE BAĞLAMI

**Tezlify**, WhatsApp entegrasyonu içeren bir üründür. WhatsApp mesaj verisi **büyük ölçüde gateway RAM'inde**
tutulur; üretimde `archive_mode=off`, PITR/slot yoktur. Bu veri, hiçbir yedekleme olmadan kaybolabilir
(son aşamalarda off-site şifreli snapshot sistemi kuruldu ama "RAM tek kopya" riski tam kapanmadı).

**Üretim topolojisi:**
- Oracle `130.162.247.20`, `/opt/tezlify`, user `ubuntu`, SSH key `~/.ssh/id_tezlify_oracle`.
- Compose (`docker-compose.prod.yml`) yalnızca `backend`, `gateway`, `caddy` bildirir — **`db` compose'da YOK**.
- Gateway `8787` dinler, konteynerde `curl` yok (sorgulamak için içeride `node` kullan). Gateway REST auth =
  `Authorization: Bearer <secret>` (X-Gateway-Secret DEĞİL — o inbound `/ws/gateway` tarafı).
- Üretim **PostgreSQL** (pg 17), `db:5432`; repo kökündeki `tezlify.db` bayat ve sqlite3 konakta yok.
- Yalnızca Caddy host port yayınlar (80/443). Backend (8000)/gateway (8787)/db (5432) konteyner-içi.
- `WHATSAPP_AUTO_RESTORE=true` üretimde — bir gateway recreate, hatırlanan kimliklerle **QR'suz** geri gelir.

**Sürümler:** Yerel venv `cryptography 50.0.1`. Üretim `cryptography 41.0.7`.

---

## 2. KRİTİK INVARIANTLAR ve GERİ ALINAMAZ HASAR KURALLARI

Bu projede herhangi bir eylem **önce** bu kuralları gözetmelidir. Tam liste:
`.workbuddy-ai/memory/MEMORY.md` ve `reference/` altındaki dosyalar.

**En yüksek riskliler:**
- **Bir satırı silmek = veri kaybıdır.** `DELETE /sessions/{id}` o satırın konuşmalarını + mesajlarını ve
  gateway auth dizinini cascade siler.
- **Hiçbir yedek WhatsApp konuşma/mesajını tam olarak kapsamaz.** "Rollback" vaadi ancak scratch DB'ye
  restore edilip **satır sayısı sayılarak** kanıtlanabilir. Dump boyutu bir şey ispat etmez.
- **Deploy yalnızca `scripts/deploy/host-release.sh` ile** (konak tarafında, SSH üzerinden). Elle reset YOK.
  `.deployed-commit` otoritedir. **"Push = deploy" DEĞİLDİR.**
- **Deploy sırası geri alınamaz hasar verir:** gateway RAM'i üretim DB'sinde başka hiçbir yerde olmayan
  mesajlar tutabilir. Her zaman: backend persistence → `/health.whatsapp_memory_persistence` doğrula → gateway.
- **Bir deploy, satır silen startup migration'ları çalıştırabilir** — "migration dosyası yok" ≠ "veri
  değişmedi". Deploy öncesi adayın `migrations.py`'sinde `delete(` ara.
- **`db` hiçbir compose dosyasında değildir** → asla `docker compose up -d --remove-orphans` yapılmaz.
- **Asla pytest dev DB'de / üretim DSN'i ile çalıştırılmaz.** `conftest` localhost olmayan `DATABASE_URL`'i
  reddeder. `TEST_DB_PATH` yeterli değildir; `settings.DATABASE_URL`'i de export et.
- **Çağrılmayan/hiç çağrılmamış bir guard = ölü guard.** Güvenmeden önce çağrı yerini grep et.
- **Deploy script'i her zaman ESKİ script'tir** (script kendi `git reset --hard`'ından sonra iner). Hedef
  commit'in script'ini çalıştırmak için: `git show <sha>:scripts/deploy/host-release.sh > /tmp/hr.sh && bash /tmp/hr.sh <sha> --no-gateway`.
- **`--no-gateway` zayıflatılmaz.** Gateway/compose değiştiyse reddeder (exit 1); o zaman "recreate et ya da
  deploy etme" seçeneği kalır. Backend-only bir ref, gateway'i `cbe4f509`'un ağacında **revert** edilmiş
  hâliyle taşır.
- **İki hash alanı KARIŞTIRILMAZ:** `git rev-parse`/`hash-object` = blob **SHA1**; `shasum -a 256` = **SHA256**.
- **Soy ile içerik ayrı sorulur:** `git log A..B -- <path>` boşken `git diff` fark gösterebilir (backend-only
  release mekaniği gereği). Blob karşılaştır.
- **`git show <c>:<path> | shasum -a 256` bir varlık testi DEĞİLDİR** — başarısız `git show` boş string hash'ler
  (`e3b0c442…`). `git cat-file -e` kullan.

---

## 3. GÜNCEL GİT / DEPLOY DURUMU (başlangıç çapaları)

| Varlık | Değer |
| --- | --- |
| **Üretim deployed** | `cbe4f509` (`release/backend-only-3.8.7`, gateway `38fe087` ile dondurulmuş) |
| 4.7 backend commit | `2236caebd4281b108b835f16f4c80d3d2e2f1d05` (parent `17ccbc9`, tree `4a2c37de`), **PUSH EDİLMEMİŞ** |
| 4.7 worktree | `/tmp/tz410-release` (`release/backend-only-4.7` orada checkout) |
| Yerel `main` HEAD | `7afb540` (temiz, staged 0) |
| 4.15 gateway adayı | `/tmp/tz415-gw` — **detached @ `cbe4f509`**, 7 dosya staged, write-tree `8746115ac8dd738a466e69e9547dc0a2844e655c` |
| `.deployed-commit` | `cbe4f509` (oturumda değişmedi) |
| Commit/Push/Deploy | **Yapılmadı** (yetki yok; yasak) |
| Container restart | **0** |

**Önemli:** `cbe4f509` `main`'in atası **DEĞİLDİR** — backend-only branch mekaniği. "main'de yok" normaldir;
**blob** karşılaştır. Üretim gateway'i `b5715fe`/`38fe087` ile donmuş; `main`'in gateway içeriği deploy edilen
ağaçta revert edilmiş.

---

## 4. ÇALIŞMA ZAMAN ÇİZELGESİ (3.4 → 4.15)

### 3.4 – 3.9: RAM kurtarma, felaket kurtarma, off-site yedekleme
- **3.6 / 3.6b:** Gateway RAM'i üretim DB'sinde başka yerde olmayan **7337+ mesaj** tutuyordu. "Bounded turn
  without cursor" kayıpları (offset 0, 10k cap vs 9122 RAM mesaj, `/health` yeşil). RAM → DB persistence yolu
  kuruldu.
- **3.7:** Backend-only release mekaniği tanımlandı (`release/backend-only-*` = main ağacı + gateway revert).
- **3.8.x:** Eviction (2000/chat), kill-switch (`WHATSAPP_MEMORY_PERSIST_ENABLED` yalnız `true`/`1`'de açılır),
  RAM snapshot (AES-256-GCM `.rsnap`), `deploy-guard` script'i, **3.8.7 quarantine** (hayalet LID süpürme
  tenant-filter'lı, fail-OPEN yerine "yaz, silme" — `whatsapp_identity_quarantine`, `deleted_*==0` sözleşmesi).
- **3.9.x:** Off-site OCI yedekleme (instance principal, eu-frankfurt-1, bucket `tezlify-ram-snapshots`,
  versioning), fiziksel key escrow (`anchor8 = c25805a2`), bağımsız kurtarma testi. **3.9.19 kapanış:**
  snapshot timer PASS, remote verify PASS, ama fiziksel kopya A/B **operatör eylemiyle** oluşturulmadı
  (paper-key restore gerçek anahtarla çalıştırılamadı) → `COMPLETE` verilmedi.
- **Kritik ders:** "RAM-only 9154" yanıltıcıydı; gerçek RAM-only = **6960** (toplam 9154 değil, DB'de karşılığı
  olmayanlar). İki bağımsız yöntem (kimlik farkı + dry-run `inserted`) aynı sonucu verdi.

### 4.7 – 4.13: İzole backend-only release (4.7) ve onaylı commit
- **4.7 kapsamı:** 11 dosya (+2038/−61), base `cbe4f509`. Gateway 5/5 identical; backend product code farkı
  yalnız 2 main-only test (`scripts/backup/*`).
- **4.8:** Üretim baseline reconciliation — deploy≠HEAD tekrar kanıtlandı (`cbe4f509` vs host `5cd3eae` vs
  local `7afb540`). Gateway dosyaları deployed == `38fe087` == konteyner baytları.
- **4.9:** İzole release + deployment safety gate. Kapsam: 4.7 = 16 dosya; escrow 15, kesişim boş; `.md`
  dışında kaçak kod yok. Tuzak: `.workbuddy-ai/memory/*` tracked+modified → `git add -A` release'e sokardı
  (açık liste şart). Verdict: **READY WITH CONDITIONS**.
- **4.10:** Backend-only release branch + final preflight. RAM_ONLY=0 ✅ (9163 RAM / 9206 DB; DB-only 43 =
  2000 tavanındaki 2 sohbette evicted). Snapshot `tezlify-ram-20261031T070158Z` (record_count 9163).
- **4.11 – 4.12:** 11 dosyalık aday sabitlendi (v2 `ec7fed85`, tek kaynak doğrulandı), manifest kesin,
  guard'lar (pipe'sız gerçek exit'ler) koşuldu. Commit onay paketi hazır.
- **4.13:** **Commit oluşturuldu** `2236caebd4281b108b835f16f4c80d3d2e2f1d05` (parent `17ccbc9`), `/tmp/tz410-release`
  worktree'sinde, **amend/reset/rebase yok**. `git write-tree` = `4a2c37de…` = doğrulanmış aday ağacı.
  Commit sonrası PG 57 passed, tam suite 2065 passed/1 failed/4 skipped (taban kırmızısı `http_probe`),
  gateway 5/5 identical. **Push edilmedi**, `.deployed-commit` hâlâ `cbe4f509`.
  Verdict: `COMMIT CREATED — POST-COMMIT VERIFICATION PASS`, `NOT AUTHORIZED — NO PUSH / NO DEPLOY`.

### 4.14: Push öncesi üretim güvenlik denetimi (salt okunur)
- **En pahalı bulgu — P0-1'in gateway yarısı HİÇBİR commit'te yok.** `git log --all -S'afterSeq'` boş; kod
  yalnızca çalışma ağacında (+448/−22, 1 untracked test). `host-release.sh` ref ağacından build ettiği için
  bu kod **hiçbir deploy ile üretime gidemez**.
- Canlı kanıt: konteyner `grep -c afterSeq /app/src/index.js` → **0**; `?afterSeq=1` probe'ı `pagination`
  anahtarı olmayan byte-idenik sayfa döndürür → backend offset moduna düşer, imleç sıfırlanmaz.
- RAM/DB reconciliation: RAM 9163 · DB 9246 · kesişim 9163 · **RAM_ONLY 0** · **DB_ONLY 83** (tavan kaynaklı).
- Persistence **kapalı** (`runs=0`, fail-closed); RAM artık önbellek, loop ürünü değil.
- Verdict: `READY WITH CONDITIONS` (C1: P0-1 kapanmadı; C2: gateway yarısı versiyonlanmadı).

### 4.15: Gateway front-trim düzeltmesi — izole aday (bu oturum)
Detaylar §5'te. **Verdict: `READY FOR EXPLICIT GATEWAY COMMIT APPROVAL`** (push/deploy yasak).
Rapor: `docs/audits/ASAMA-4.15-gateway-front-trim-remediation.md`.

---

## 5. P0-1 / 4.15 HİKÂYESİ (en güncel, en kritik)

### 5.1 Sorun
`listAllMessages` (`session-manager.js`) offset tabanlı sayfalar. Gateway RAM liste **başından** eviction
yapar (2000/chat cap). Offset sabit kaldığı için eviction sonrası indeksler sola kayar → imleç görmeden
satırlar **sessizce atlanır** (test: 10 kayıtta 3 kayıp). Backend, düzeltme için `afterSeq`/`seqEpoch`
göndermeye çalışır ama **üretim gateway'i bunları okumaz** → silent-safe fallback, P0-1 açık kalır.

### 5.2 Düzeltme (izole aday, `cbe4f509` soyuna port edildi — `main`'e değil)
- `_seq`: mesaj RAM'e yazılırken atanan, **benzersiz ve kesin artan** tamsayı (`nextMessageSeq`, `stampMessageSeq`).
  `enumerable:false` → **hiçbir API/WS yanıtına sızmaz** (test S1).
- `seqEpoch`: imleç `(epoch, seq)` çiftidir; süreç/session yeniden kurulursa eski epoch'taki yüksek seq hiçbir
  kaydı eşlemez → backend imleci sıfırlar (güvenli yeniden tarama).
- `afterSeq` bir **değer**, konum (offset) değil → baştan eviction imleci kaydıramaz.
- `if (!seqMode && perChat !== null)` ile **seq modunda `perChatLimit` trim atlanır** (sessiz atlama giderildi);
  offset modunda eski davranış aynen korunur.
- Eski istemciler ve `since`-only / `perChatLimit`-only istemciler geri-uyumlu (test B1–B5).

### 5.3 Aday (7 dosya, +1210/−23, yalnız `whatsapp-gateway/`)
```
 whatsapp-gateway/package.json                    |   2 +-
 whatsapp-gateway/scripts/test-bulk-seq-pagination-guarantees.mjs | 537 +++
 whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs            | 216 +++
 whatsapp-gateway/src/index.js                    |  13 +-
 whatsapp-gateway/src/messages/message-store.js   | 278 +++-
 whatsapp-gateway/src/session-manager.js          | 177 +++-
 whatsapp-gateway/src/socket/socket-events.js     |  10 +-
```
- Write-tree `8746115ac8dd738a466e69e9547dc0a2844e655c`. Untracked = yalnız `node_modules`.
- Drift kontrolü TEMİZ (`jidKind`/`countCachedMessages`/`test-history-diagnostics`/`test-messages-cached-metric`
  yok — `main`-only sürüklenebilirlik hariç tutuldu).

### 5.4 Kapılar (gerçek exit kodları)
| Kapı | Sonuç |
| --- | --- |
| `npm test` (43 script) | **EXIT 0** (tamamen yeşil) |
| `node scripts/test-bulk-seq-pagination.mjs` | 8/8 PASS |
| `node scripts/test-bulk-seq-pagination-guarantees.mjs` | 32/32 PASS |
| Drift kontrolü | TEMİZ |
| Kapsam (yalnız gateway) | 7 dosya |

### 5.5 Önerilen commit mesajı (henüz commit edilmedi)
```
fix(whatsapp-gateway): implement epoch-aware sequence pagination
```
Bu bir **gateway-only** release commit'i olmalı (backend/frontend dokunulmaz).

---

## 6. ÜRETİM ÖLÇÜMLERİ (4.14, salt okunur)

| Metrik | Değer |
| --- | --- |
| RAM (API görünür) | 9163 (10 sayfa × 1000, `perChatLimit=1000000`, 9163 benzersiz kimlik) |
| DB `messages` | 9246 · sohbet 126 · kontak 1538 |
| Kesişim / **RAM_ONLY** / **DB_ONLY** | 9163 / **0** / **83** |
| DB_ONLY açıklaması | conv 38289 = 2051 (+51), conv 38291 = 2032 (+32) → 83 ✓ (2000/chat tavanı) |
| Persistence | **kapalı** (`WHATSAPP_MEMORY_PERSIST_ENABLED` tanımsız, varsayılan `False`, fail-closed) |
| Snapshot | `…T090040Z` en taze; timer kurulu; 32 `.rsnap` + 32 manifest, 221 MB, retention yok |
| Rollback | `tezlify-gateway:pre-20261029T214629Z` = canlı imaj (`a1ba2572`) ⇒ `--rollback-to` gateway için faydasız RAM kaybı |
| DB bütünlüğü | çift kopya 0; hayalet LID kontağı 1 (`whatsapp_identity_quarantine` 0); `processed_events`/`outbox` tablo YOK (N/A) |

---

## 7. MEVCUT DURUM — KALAN İŞLER

1. **P0-1 gateway düzeltmesini versiyonla + deploy et.** 4.15 adayı (`/tmp/tz415-gw`) bir gateway-only release
   commit'i olarak el ile oluşturulmalı. Sonra `scripts/deploy/host-release.sh` kapısından geçirilmeli
   (gateway değiştiği için `--no-gateway` **tetiklenmez** — bu bir gateway release). **Push/deploy açık onay
   gerektirir** (bu oturumda yasak).
2. **4.7 backend commit'ini push et + deploy et** (`2236cae`, PUSH EDİLMEMİŞ). İstemci onayı gerekir.
3. **Fiziksel escrow kopya A/B** hâlâ operatör eylemiyle oluşturulmadı (3.9.19'dan kalan). Paper-key restore
   gerçek anahtarla test edilmedi.
4. **Retention** snapshot sisteminde yazılmadı (52 GB ≈ 15 günde dolar, 2000/chat tavanında).
5. **`processed_events`/`outbox` tabloları üretimde YOK** — bazı "temiz" iddiaları N/A.

---

## 8. YENİ AI'NIN YAPMAMASI GEREKENLER

- Anahtarı/token'ı log/rapor/dosyaya yazma; SSH stdout üzerinden taşıma.
- Production DB'ye bağlanıp yazma; pytest'i üretim DSN'i ile çalıştırma.
- `docker compose up -d --remove-orphans` (db silinir).
- Elle `git reset --hard` / `deploy` / container restart / push.
- Persistence aktivasyonu (`WHATSAPP_MEMORY_PERSIST_ENABLED=true` dışında bir şey).
- `git add -A` (`.workbuddy-ai/memory/*` tracked; release commit'ine sokar).
- `amend`/`rebase` `cbe4f509`, `17ccbc9`, `2236cae`.
- Gateway worktree (`/tmp/tz415-gw`) değişikliklerini silme.
- "main'de yok" diyerek bir şeyi eksik sanma — blob karşılaştır, soy farklı.
- Bir düzeltmenin "commit'te var" olduğunu `grep` ile değil `git log -S` ile doğrula.

---

## 9. YENİ AI'NIN OKUMASI GEREKEN DOSYALAR

1. `.workbuddy-ai/memory/MEMORY.md` — invariantlar (A–T), irreversible damage, release scope.
2. `.workbuddy-ai/memory/reference/production-ops.md` — topoloji, deploy mekaniği, tuzaklar (EN ÖNEMLİ).
3. `.workbuddy-ai/memory/reference/whatsapp-subsystem-invariants.md` — A–T invariantları.
4. `.workbuddy-ai/memory/reference/cross-cutting-rules.md` — kusur desenleri X1–X4.
5. `docs/audits/ASAMA-4.15-gateway-front-trim-remediation.md` — en güncel, P0-1 düzeltme + aday + kapılar.
6. `docs/audits/ASAMA-4.14-pre-push-production-safety-gate.md` — üretim ölçümleri, P0-1 kanıtı.
7. `docs/audits/ASAMA-4.13-approved-commit-verification.md` — 4.7 commit kanıtı.
8. `docs/audits/TEZLIFY-HANDOFF-3.9.19.md` — erken dönem (DR/off-site/escrow) bağlamı.
9. `/tmp/tz415-gw` — 4.15 gateway adayı (detached @ `cbe4f509`, 7 staged dosya).
10. `/tmp/tz410-release` — 4.7 backend commit worktree (`release/backend-only-4.7`).

---

*Bu handoff dosyasında anahtar, token, private key veya credential değeri yoktur. Yalnızca 8 haneli genel
doğrulama çapası (`c25805a2`) ve özet (SHA) önekleri yer alır. Yapılmayan işlemler yapılmış gösterilmedi.*
