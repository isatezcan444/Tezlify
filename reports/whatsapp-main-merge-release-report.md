# AŞAMA 6.4-M — Main Birleştirme ve Release Senkronizasyonu Raporu

**Tarih:** 2026-11-03
**Repository:** `isatezcan444/Tezlify` (`/Users/isatezcan/Documents/Github/Tezlify`)
**Kapsam:** Branch envanteri, `e34e3ff` → `main` birleştirme denemesi, production doğrulaması
**KODLAMA:** Hayır · **ALTYAPI:** Evet

**Karar: `BLOCKED` — merge YAPILMADI, push YAPILMADI, deploy YAPILMADI**

`e34e3ff` (6.1–6.4) `main` içinde **değildir** ve güvenli biçimde birleştirilemedi.
Hem tek-commit cherry-pick hem tam branch merge denemesi **semantik çakışma** verdi.
Brif gereği ("Conflict varsa otomatik ve tahmini çözüm yapma; raporla") hiçbir çakışma
tahminle çözülmedi; `main`, `origin/main` ve production **değiştirilmedi**.

---

## 1. Yönetici Özeti

| Soru | Yanıt |
|---|---|
| `e34e3ff` main içinde mi? | **Hayır** (ne `main` ne `origin/main` atası) |
| Merge yapıldı mı? | **Hayır** — 2 (cherry-pick) / 3 (full merge) çakışma |
| Çakışmalar mekanik mi? | **Hayır** — mesaj upsert semantiği ve 6.1 durable-emit |
| `main` değişti mi? | Hayır (`e7f1077`, 89 dirty giriş aynen duruyor) |
| `origin/main` değişti mi? | Hayır (`7afb540`) |
| Production değişti mi? | Hayır — `e34e3ff`, sağlıklı, restart yok |
| Campaign Media 5.4 dışarıda mı? | **Evet** — ne `e34e3ff`'te ne `main`'de |
| PR oluşturuldu mu? | Hayır — `gh` CLI bu makinede yok; ayrıca merge bloklu |

---

## 2. Branch Envanteri

**Merge-base (`main` ↔ release):** `a1ca60fcfd24fddf258b675e5730a5d784efd902`
**`main`:** `e7f1077a489d94bc6b0f0afef6b575e48922162e` (yerel), `origin/main` = `7afb5406c29736bb914b27fa90e85a618ae9ce0e`
→ yerel `main`, `origin/main`'in **4 commit önünde** (push edilmemiş).

| Branch | Tip | main'e göre (main-only / branch-only) | main'de | release'te | Karar |
|---|---|---|---|---|---|
| `main` | `e7f1077` | 0 / 0 | — | hayır | Kanonik ana hat; 4 commit push edilmedi |
| `release/backend-only-seq-safety` | `e34e3ff` | 36 / 11 | hayır | — | **Release branch'te kalmalı** (production'da çalışan hat) |
| `feat/tzdbk1-crypt` | `e7f1077` | 0 / 0 | evet | hayır | **Başka bir işle ilişkili** (tzdbk1); worktree "prunable" |
| `feat/3.8.7-identity-quarantine` | `a1ca60f` | 36 / 0 | evet | evet | Zaten birleşik; **silinmesi güvenli değil** |
| `integration/whatsapp-5.3-seq-safe` | `3ac26a9` | 36 / 7 | hayır | evet | Release hattına **zaten entegre**; main'e alınmaz |
| `release/backend-only-3.8.7` | `cbe4f50` | 36 / 1 | hayır | evet | Tarihsel release; **release branch'te kalmalı** |
| `release/backend-only-4.7` | `2236cae` | 36 / 3 | hayır | evet | Tarihsel release; **release branch'te kalmalı** |
| `release/gateway-seq-pagination-4.17` | `20c88bb` | 36 / 2 | hayır | evet | Tarihsel release; **release branch'te kalmalı** |
| `release/whatsapp-combined-backend-4.7-gateway-4.17` | `de1f1ad` | 36 / 5 | hayır | evet | Tarihsel release; **release branch'te kalmalı** |
| `release/backend-only-3.7` | `21346e3` | 52 / 1 | hayır | hayır | Eski release hattı; **birleştirilmemeli** |
| `release/backend-only-3.8.1` | `68ca413` | 50 / 1 | hayır | hayır | Eski release hattı; **birleştirilmemeli** |
| `release/backend-only-3.8.4` | `3d3fc79` | 45 / 1 | hayır | hayır | Eski release hattı; **birleştirilmemeli** |
| `release/backend-only-3.8.5` | `38fe087` | 42 / 1 | hayır | hayır | Eski release hattı; **birleştirilmemeli** |
| `fix/persist-killswitch-drain-3.9.16` | `313380f` | 11 / 1 | hayır | hayır | **Tamamlanmamış / başka iş** (3.9.16 ops); main'e alınmadı |
| `backup-before-revert-899f32f` | `899f32f` | 314 / 3 | hayır | hayır | Yedek branch; **silinmesi güvenli değil** |
| `backup-before-revert-to-c8aff1f` | `63f9b5b` | 304 / 7 | hayır | hayır | Yedek branch; **silinmesi güvenli değil** |

**Hiçbir branch silinmedi** (kullanıcı onayı yok).
`main` dışındaki hiçbir branch `main`'e taşınmadı.

### 2.1 Commit farkları

| Yön | Commit sayısı | Dosya farkı (three-dot) |
|---|---|---|
| `main`..release (release'e özel) | **11** | 80 dosya, +16.118 / −857 |
| release..`main` (main'e özel) | **36** | 62 dosya, +18.232 / −39 |

Release'e özel 11 commit:

```text
e34e3ff fix(whatsapp): consolidate core reliability fixes          <- 6.1–6.4
978ddf5 fix(whatsapp): use portable timeout return type
6b413f3 test(admin): assert http probe optional bool contract
5f29d9e feat(whatsapp): harden update semantics and integrate regression contracts
3ac26a9 feat(whatsapp): integrate notify append event contract on seq-safe release base
0b795ea fix(whatsapp): chunk initial sync by jids and reset seq cursor on epoch change
de1f1ad release: combined backend 4.7 + gateway 4.17 (epoch-aware keyset pagination)
20c88bb fix(whatsapp-gateway): implement epoch-aware sequence pagination
2236cae test(whatsapp): cover poison-row savepoint isolation and constraint-name extraction
17ccbc9 release: backend-only 4.7 (memory persistence core safety fix)
cbe4f50 release: backend-only 3.8.7 (whatsapp-gateway frozen at 38fe087)
```

Main'e özel 36 commit iki gruba ayrılır:

- **3.8.8–3.9.19 ops/backup/docs** (32 commit): escrow, off-site yedek, RAM snapshot, audit raporları. WhatsApp release senkronizasyonuyla ilgisiz.
- **AŞAMA 5.2 notify/append** (4 commit, push edilmemiş): `3bf17bf`, `a4f12d7`, `6cb0f5c`, `e7f1077` — 26 dosya, +6.584 / −39. Bu, release'teki `3ac26a9`/`5f29d9e` ile **paralel bir implementasyondur** ve çakışmanın kaynağıdır.

---

## 3. `e34e3ff` Main İçinde mi?

```text
git merge-base --is-ancestor e34e3ff main        -> HAYIR
git merge-base --is-ancestor e34e3ff origin/main -> HAYIR
git merge-base main release/backend-only-seq-safety -> a1ca60f
```

`e34e3ff` yalnızca `release/backend-only-seq-safety` hattında ve production'da bulunuyor.

---

## 4. Merge Denemeleri ve Çakışmalar (izole worktree, `main` dokunulmadı)

Her iki deneme de `git worktree add --detach /tmp/tzm-* main` ile **ayrı worktree**'de
yapıldı; deneme sonunda worktree'ler kaldırıldı (`git worktree remove --force`),
`main` checkout'u hiç değişmedi.

### 4.1 Deneme A — yalnızca 6.1–6.4 (`git cherry-pick -n e34e3ff`)

**Sonuç:** 33 dosyanın 31'i otomatik birleşti, **2 çakışma**:

| Dosya | Çakışma |
|---|---|
| `whatsapp-gateway/package.json` | `test` zinciri: main = kendi 5.2 testleri; release = bulk-seq-pagination + 6.1/6.3/6.4 testleri. Release tarafı main'de **bulunmayan** script'leri (`test-bulk-seq-pagination*.mjs`, `test-tz428-initial-sync-front-trim.mjs`, `test-message-update-semantics.mjs`) referans ediyor. |
| `whatsapp-gateway/src/session-manager.js` | main: `(fromMe \|\| isAppend ? 0 : 1)` + `emitEvent({...})`; release: `(fromMe \|\| isAppend \|\| isReplace ? 0 : 1)` + `const emission = emitEvent({...})` (6.1 durable emit). |

### 4.2 Deneme B — tam branch (`git merge --no-ff release/backend-only-seq-safety`)

**Sonuç:** **3 çakışma** (daha geniş kapsamlı):

| Dosya | Çakışma |
|---|---|
| `backend/app/services/whatsapp/orchestration/events.py` | main: `upsert_type not in ("notify","append")`; release: `("notify","append","replace","update")` + `is_update` / `_no_broadcast` / `last_message` kuralları. |
| `frontend/src/features/whatsapp/api/whatsappApi.ts` | Oturum olay listesi ve `gateway_connected` yorum/semantiği iki tarafta farklı yazılmış. |
| `whatsapp-gateway/src/session-manager.js` | main: `_ingestUpsertMessage(msg, sock, sessionId, { upsertType })`; release: 6.1 pending-LID claim wrapper + `_ingestUpsertMessageInner` (yeni imza ve `_claimPendingLid`/`_releasePendingLidClaim`). |

### 4.3 Çakışmalar neden otomatik çözülemez

1. **İki paralel mesaj-upsert modeli var.** Release hattı `notify`/`append` yanında
   `replace`/`update` upsert tiplerini ve "içerik değişmediyse yayınlama" kuralını
   getiriyor (`5f29d9e`). `main` ise kendi 5.2 implementasyonunda yalnızca
   `notify`/`append` üzerine kurulu. `main`'de `isReplace` **0**, release'te **6** kez geçiyor.
2. **6.1 bu semantiğin üstüne oturuyor.** Pending-LID claim wrapper'ı `_ingestUpsertMessage`
   imzasını değiştiriyor; hangi imzanın doğru olduğu, mesajın kaç kez işlendiğine ve
   unread sayacına doğrudan etki eder.
3. **Durable emit (6.1) main'de yok.** `const emission = emitEvent(...)` main'de **0** kez
   geçiyor; release'te 6.1 ile geliyor. Hangi emit sözleşmesinin korunacağı bir domain kararı.
4. **Frontend olay listesi** iki tarafta farklı gerekçelerle yazılmış; birleştirme
   hangi olayın yeniden bağlanmayı tetikleyeceğini değiştirir.

Bu nedenle çakışma "satır seçimi" değil, **davranış seçimi**dir. Brif uyarınca tahminle
çözülmedi.

### 4.4 `main`'de eksik olan release ön koşulları

```text
MISSING main:whatsapp-gateway/src/lid/pending-lid-repository.js
MISSING main:whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs
MISSING main:whatsapp-gateway/scripts/test-message-update-semantics.mjs
main migrations.py içinde lid_pending_messages: 0
main session-manager.js içinde isReplace: 0
```

Yani `e34e3ff`'in bazı parçaları, release hattında daha önce gelen commit'lere
(`3ac26a9`, `5f29d9e`, `0b795ea`) yaslanıyor; `main` bu tabana sahip değil.

---

## 5. Production Durumu

Production **değiştirilmedi**; 6.4-R deploy'undan sonraki durum korunuyor.

| Kontrol | Değer |
|---|---|
| `.deployed-commit` | `e34e3ff5cf01dd201b92697edd77ee3fb9c174e0` |
| Backend | `healthy`, `gateway_bridge.connected=true` |
| Gateway | `ok`, `sessions={total:1, connected:1, pending_qr:0}`, `orphaned=0` |
| Konteynerler | backend/gateway/caddy `running`, `restarts=0` |
| Restart / redeploy | **Yapılmadı** (gereksiz restart yok) |
| Release kaydı | `/opt/tezlify/backups/releases/20261103T184732Z/release.json` |

`main`'e merge production'ı değiştirmez; merge bloklu olduğu için deploy da gerekmedi.
Production'ın çalıştırdığı ağaç, doğrulanmış `e34e3ff` ağacıdır.

---

## 6. Campaign Media 5.4 Durumu

- 5.4.2–5.4.13 çalışması hiçbir zaman commit edilmedi; yalnızca
  `/private/tmp/tz429-release` çalışma ağacında duruyor (14 modified + 19 untracked).
- `e34e3ff` içinde yok; `main` içinde yok; production imajlarında yok
  (6.4-R'de `media-routes.js` / `registerMediaRoutes` / `authorize_media_reference`
  sıfır olarak doğrulandı).
- **5.4.13 = RELEASE_BLOCKED**; birleştirilmedi ve birleştirilmemeli.

---

## 7. Son Kontroller (brif §5)

| Soru | Yanıt |
|---|---|
| GitHub `main` güncel mi? | **Hayır.** `origin/main=7afb540`; yerel `main` 4 commit önde (`3bf17bf`, `a4f12d7`, `6cb0f5c`, `e7f1077`) ve bu 4 commit **push edilmedi**. |
| 6.1–6.4 `main` içinde mi? | **Hayır.** |
| Release branch ile main farkı? | `a1ca60f` merge-base; release 11 commit önde, main 36 commit önde; 80 vs 62 dosya. |
| Production hangi commit'te? | `e34e3ff` — doğru ve sağlıklı. |
| Tamamlanmış ama birleştirilmemiş başka WhatsApp işi var mı? | Evet: (a) `main`'deki 5.2 notify/append 4 commit'i push edilmemiş ve production'da yok; (b) `fix/persist-killswitch-drain-3.9.16` 1 commit main'de değil; (c) release hattındaki 3.8.7–4.17 release commit'leri main'de değil. |
| Campaign Media 5.4 dışarıda mı? | **Evet.** |
| Test / health durumu? | Production health yeşil (yukarıda). Bu aşamada kod üretilmediği/merge yapılmadığı için yeni test koşumu yapılmadı; önceki 6.4-R sonuçları geçerli. |

**Not:** `gh` CLI bu makinede kurulu değil (`command not found: gh`), bu yüzden PR
oluşturulamadı. Zaten merge çakışmaları nedeniyle PR açılması da doğru olmazdı.

---

## 8. Operatör İçin Seçenekler (uygulanmadı)

1. **Semantik karar + tek commit'lik birleştirme:** Hangi upsert modelinin kanonik olduğu
   (main'in 5.2 `notify`/`append` mi, release'in `replace`/`update` eklemeli modeli mi)
   kararlaştırılır; `e34e3ff` cherry-pick edilir, `session-manager.js`, `events.py`,
   `whatsappApi.ts`, `package.json` çakışmaları bu karara göre çözülür ve tam test matrisi
   (gateway + backend + PG) koşulur.
2. **Entegrasyon branch'i:** `main` tabanlı yeni bir branch'te 6.1–6.4 port edilir, 5.2
   semantiği korunur; iki implementasyonun aynı dosyada birlikte yaşaması test edilir.
3. **Hat ayrımını koru:** Production `e34e3ff` üzerinde kalır; `main` 5.2 hattını taşımaya
   devam eder; 6.1–6.4 main'e alınmadan önce ayrı bir birleştirme aşaması açılır.

Ayrıca `origin/main`'in 4 commit geride olması ayrı bir karar gerektirir: bu 4 commit
(AŞAMA 5.2 notify/append) push edilirse GitHub main güncellenir, ancak bunlar production'da
**yoktur** ve bu aşamada doğrulanmadı. Bu nedenle push yapılmadı.

---

## 9. Sınır Kontrolü

- Yalnızca `/Users/isatezcan/Documents/Github/Tezlify` (salt-okunur envanter) ve geçici
  worktree'ler (`/tmp/tzm-main`, `/tmp/tzm-main2` — ikisi de kaldırıldı) kullanıldı.
- `main` checkout'u ve 89 dirty girişi **değişmedi**; hiçbir dosya stage/commit edilmedi.
- `git reset`, `git clean`, `git stash`, `git checkout`, `git switch`, `git rebase`,
  `git merge` **ana worktree'de kullanılmadı**; merge denemeleri ayrı worktree'de yapıldı
  ve geri alındı (`merge --abort` + `worktree remove`).
- Push, force push, branch silme, PR oluşturma **yapılmadı**.
- Production'a yeni deploy/restart **yapılmadı**.
- `/private/tmp/tz429-release` çalışma ağacındaki 5.4 değişiklikleri korunuyor.

---

## 10. Karar

**`BLOCKED`**

6.1–6.4 değişiklikleri `main` içinde değildir ve bu aşamada güvenli biçimde
birleştirilemedi: iki deneme de `session-manager.js` üzerinde, tam merge ayrıca
`events.py` ve `whatsappApi.ts` üzerinde semantik çakışma verdi. Brifin "tahmini çözüm
yapma" kuralı gereği hiçbir çakışma elle çözülmedi; `main`, `origin/main` ve production
değiştirilmedi. Production doğru ve doğrulanmış sürümde (`e34e3ff`) çalışmaya devam ediyor;
Campaign Media 5.4 hiçbir hatta dahil edilmedi.

**Yeni aşamaya geçilmedi.**
