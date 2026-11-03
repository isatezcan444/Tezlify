# Aşama 4.15 — WhatsApp Gateway Front-Trim Fix: Kod Denetimi, Güvenli Düzeltme ve İzole Release Adayı

**Tarih:** 2026-10-31
**Mod:** CODE=YES (gateway), INFRA=YES (gerekmez), PRIORITY=P0 BLOCKER
**Başlangıç backend commit:** `2236caebd4281b108b835f16f4c80d3d2e2f1d05`
**Üretim (production) baseline:** `cbe4f509` (`release/backend-only-3.8.7`, gateway `38fe087` ile dondurulmuş)
**Yasaklar:** DEPLOY=YASAK, PUSH=YASAK, restart/DB-write/RAM-wipe/persistence/prod-test YOK.
**Değiştirilmeyecek commitler:** `2236cae`, `17ccbc9`, `cbe4f509` (amend/reset/clean/stash yasak).
**Silinmeyecek:** gateway worktree değişiklikleri.

---

## 0. Özet (Executive Summary)

P0-1 (gateway front-trim) hatasının **gateway yarısı hiçbir release commit'ine girmedi**. Üretimdeki
`/app/src/index.js:564` yalnızca `{limit, offset, since, perChatLimit, jids}` okur; `afterSeq`/`seqEpoch`/`_seq`
**hiçbir commit'te yok** (`git log --all -S'afterSeq'` boş). Canlı `?afterSeq=1` probe'ı, `pagination` anahtarı
olmayan **byte-idenik** bir sayfa döndürür → backend offset moduna düşer, imleç (cursor) sıfırlanmaz → sessiz
atlama devam eder.

Bu Aşama, düzeltmeyi **üretim soyuna (`cbe4f509`) temiz şekilde port edilmiş** bir izole adayda uygular ve
doğrular. Aday: 7 dosya, `+1210 / -23`, **yalnızca `whatsapp-gateway/`** altında; backend ve frontend
**hariç tutulur**. Tüm test kapıları yeşildir (`npm test` exit 0; seq sözleşmesi 8/8; garanti 32/32).

**Verdict: ✅ READY FOR EXPLICIT GATEWAY COMMIT APPROVAL** — koşullarla (bkz. §10).

---

## §3. Baseline Donması (Frozen Baseline)

| Nesne | Değer | Kaynak |
| --- | --- | --- |
| Üretim deployed commit | `cbe4f509` | `.deployed-commit` (otorite) |
| Gateway dondurma | `38fe087` | `release/backend-only-3.8.7` ağacı |
| Yerel HEAD / origin/main | `7afb540` | (main, adayın temeli DEĞİL) |
| 4.7 release branch | `release/backend-only-4.7` = `17ccbc9` → `2236cae` | tree `4a2c37de`, worktree `/tmp/tz410-release` |
| Aday worktree | `/tmp/tz415-gw` | **detached @ `cbe4f509`** |

Üretim bu oturumda **dokunulmadı**: deploy/push/restart yok; `.deployed-commit` değişmedi (değiştirmek için
`scripts/deploy/host-release.sh` gerekir, yasak). Baseline, inşası gereği donmuş sayılır.

**Hash alanı notu:** `git hash-object` / `git rev-parse` = **SHA1**; `shasum -a 256` = **SHA256**. Aday
manifest'inde yalnızca git blob SHA1 kullanılır (aşağıda).

---

## §4. Sözleşmenin Çözülmesi (Decode Contract) — 10 Soru

**Q1. Üretim `index.js:564` ne okur?**
Yalnızca `{limit, offset, since, perChatLimit, jids}`. `afterSeq`/`seqEpoch` yok. (Kaynak: canlı ağaç + `cbe4f509`.)

**Q2. Canlı `?afterSeq=1` probe'ı ne döndürür?**
`pagination` anahtarı **olmayan** byte-idenik bir sayfa → backend seq modunu algılayamaz.

**Q3. `afterSeq`/`seqEpoch`/`_seq` herhangi bir commit'te var mı?**
Yok. `git log --all -S'afterSeq'` boş; `HEAD:` (tüm dallar dahil) içinde 0 referans. Düzeltme yalnızca
**çalışma ağacında** yaşıyordu (+448/−22, 1 untracked test) → `host-release.sh` ref ağacından build aldığı için
**hiçbir ref'ten deploy bu kodu taşıyamaz**.

**Q4. Backend neden offset moduna düşer ve imleci sıfırlar mı?**
Dönen yanıtta `pagination` alanı yok → backend `mode="offset"`, `offset = start_offset` yapar; cursor reset
**yapılmaz**. Bu, "sessiz güvenli" (silent-safe) bir fallback'tir: hata vermez ama P0-1'i **düzeltmez**.

**Q5. `_seq` nedir, ne zaman atanır?**
Mesaj RAM'e yazılırken (`stampMessageSeq`) atanan, **benzersiz ve kesin artan** bir tamsayı değer. `id` alanı
keyset olarak kullanılamaz (gelen `id`=gönderim ms, giden `id`=`Date.now()` → ne benzersiz ne artan). `_seq`
bir **değer**dir; konum (offset) değil → liste başından eviction imleci kaydırmaz.

**Q6. `seqEpoch` ne işe yarar?**
İmleç `(epoch, seq)` çiftidir. Süreç/session yeniden kurulursa `_messageSeq` sıfırdan başlar; eski epoch'a ait
yüksek bir `seq`, yeni depoda **hiçbir kaydı eşleştirmez** (hepsi `seq > after` filtresinden düşer). Epoch
uyuşmazlığı backend'i imleci sıfırlamaya yönlendirir → kayıp imleç güvenli bir yeniden taramaya dönüşür.

**Q7. `afterSeq` semantiği nedir?**
Kesin `> lastSeq` (strict greater). `afterSeq` bir konum değil, bir değerdir; bu yüzden eviction'dan etkilenmez.

**Q8. `afterSeq` verildiğinde `perChatLimit` trim yapmamalı — neden?**
`perChatLimit` "en yeni N" kırpmasıdır. İmleçle birlikte uygulanırsa, imlecin henüz görmediği eski kayıtları
eler → **düzeltmeye çalıştığımız sessiz atlamayı geri getirir**. Bu yüzden `if (!seqMode && perChat !== null)`
şeklinde, seq modunda trim **atlanır**.

**Q9. Aday neden `cbe4f509` soyuna port edildi, `main`'e değil?**
`main`'in gateway içeriği `cbe4f509` ağacında **revert** edilmiş durumda (backend-only release mekaniği). `main`
gateway'ine yazmak, üretimin çalıştığı soydan sapar. Düzeltme `cbe4f509` soyuna temiz port edildi; `main`-only
sürüklenebilirlik (`jidKind`, `countCachedMessages`, `test-history-diagnostics`, `test-messages-cached-metric`)
**hariç tutuldu** (drift kontrolü temiz, §9).

**Q10. Bu aday tek başına deploy edilebilir mi?**
Hayır — bu oturumda DEPLOY ve PUSH **yasak**. Aday yalnızca **gateway** değişikliklerini içerir; doğru yoldan
geçirilmiş bir **gateway-only release commit**'i olarak el ile oluşturulmayı bekler (§10).

---

## §5. Minimal Back-Compat Düzeltme — Zorunlu Davranışlar

Tüm zorunlu davranışlar adayda mevcut ve testlerle kanıtlı:

| # | Davranış | Uygulama | Kanıt |
| --- | --- | --- | --- |
| 1 | `afterSeq` gerçekten okunur | `index.js:568,584` destructure + `parseInt` | test H |
| 2 | `seqEpoch` doğrulanır | `session-manager.js:1294` `String(seqEpoch) !== String(epoch)` | test F / 11c |
| 3 | `_seq` kesin artan | `nextMessageSeq` `store._messageSeq++` | test 10 / D |
| 4 | Bayat epoch güvenli | `epochReset` → `after=0`, tam resync | test 11c/11d / F |
| 5 | cursor/offset önceliği açık | `seqMode` önce; değilse offset | test 5 / C |
| 6 | Eski istemciler korunur | seq yoksa offset dalı **aynen** | test B1–B5 / C |
| 7 | Determinizm | `eligible.sort` by `_seq`; offset `sort` by `id` | test 1–3 |
| 8 | Dedup | `_seq` benzersiz; `seq > after` filtresi | test 9 / R1 |
| 9 | 2000-cap kanıtı | `MESSAGES_PER_CHAT_MAX`; `chats[].collected` | test 6a/6b / L1 |
| 10 | RAM büyümesi kontrollü | `trimChatMessages` + cap; seq RAM'a yazılmaz (non-enumerable) | test 7a/7b / L3 |
| 11 | trim/cursor yarış-güvenli | `ensureMessageSeq` okuma anında tamamlar; cursor `>=` | test 8 / 12a / R1 |

**Anahtar kod parçaları (adaydan):**

`src/index.js:567-586` — route artık `afterSeq`/`seqEpoch` okur ve `sessionManager.listAllMessages`'a iletir.
`src/session-manager.js:1256-1318` — seq modu bloğu:
```js
const seqMode = afterSeq !== null && afterSeq !== undefined && afterSeq !== ''
  && Number.isFinite(Number(afterSeq));
// ...
if (!seqMode && perChat !== null && group.length > perChat) {
  group = [...group].sort((a, b) => (a.id || 0) - (b.id || 0)).slice(-perChat); // seq modunda ATLA
}
// ...
if (seqMode) {
  const epoch = storeSeqEpoch(store);
  for (const m of all) ensureMessageSeq(store, m);
  const epochReset = Boolean(seqEpoch) && String(seqEpoch) !== String(epoch);
  const after = epochReset ? 0 : Math.max(0, Number(afterSeq) || 0);
  const eligible = [];
  for (const m of all) {
    const seq = messageSeqOf(m);
    if (seq !== null && seq > after) eligible.push(m);   // strict greater
  }
  eligible.sort((a, b) => (messageSeqOf(a) || 0) - (messageSeqOf(b) || 0));
  const page = eligible.slice(0, limit);
  const lastSeq = page.length ? messageSeqOf(page[page.length - 1]) : null;
  const nextAfter = lastSeq === null ? after : lastSeq;
  return { /* pagination:'seq', seq_epoch, max_seq, after_seq, next_after_seq,
            reached_end, epoch_reset, eligible_total */ };
}
```
`src/messages/message-store.js:149-224` — `nextMessageSeq` / `stampMessageSeq` / `messageSeqOf` /
`ensureMessageSeq` / `storeSeqEpoch`. `_seq` `enumerable:false` → **hiçbir API/WS yanıtına sızmaz** (test S1).

---

## §6. 15 Test Senaryosu (Örtük Olarak Karşılandı)

`scripts/test-bulk-seq-pagination-guarantees.mjs` (32 kontrol) ve `scripts/test-bulk-seq-pagination.mjs` (8
kontrol) aşağıdaki 15 davranışı + geri-uyumluluk/öteleme/yarış kapsamını doğrular:

1. `afterSeq=N` yalnızca `seq > N` kayıtları döndürür.
2. (determinizm) seq sıralaması kesin ve tekrarlanabilir.
3. `afterSeq` bir sonrakı sayfayı imlecin **tam sonrasından** açar.
4. Eşleşen `seqEpoch` imleci **sıfırlamaz**.
5. Cursor, offset'e göre **önce gelir**; offset yok sayılır ve `0` rapor edilir.
6. (a/b) `MESSAGES_PER_CHAT_MAX` (2000) tamıyla sığar, eviction'sız; dolu cap'li sohbet seq imleciyle tamamen
   erişilebilir.
7. (a/b) 2001. mesaj en eskiyi evict eder ve sayılır; evict edilmiş kaydı geçmiş bir cursor temiz ilerler.
8. Trim edilmiş bir kayda işaret eden cursor, ilk sağ kalandan devam eder.
9. İki kayıt **asla** aynı `_seq`'i paylaşmaz.
10. `_seq` ekleme sırasına göre kesin artar.
11. (b/c/d) iki store epoch paylaşmaz; bayat epoch yeniden tarar; reset sonrası sıradaki çağrı yeni epoch
    imleçinden devam eder.
12. (a) sayfalar arasında mesaj eklenmesi en eskiyi trim eder, cursor'ı kaydırmaz.
13. (a/b) jid filtresiz her iki sohbet tek global cursor ile; jid filtresi kümeyi daraltır, cursor bozulmaz.
14. Mesajı olmayan filtreli sohbet boş ve "bitti" sayfası verir.
15. (a/b) `perChatLimit` seq sayfasında **trim yapmaz** (sessiz atlama yok); offset modunda eski davranışı
    **aynen** korur.

**Ek kapsam:** S1 (`_seq` serileşmez), S2 (`since` seq modunda onurlandırılır), L1–L3 (5000-msg öteleme: RAM
yalnızca cap kadar; tam sağ kalan küme erişilir), B1–B5 (geri-uyum: seq'siz istemci legacy offset; `since`
only; perChatLimit only; `afterSeq` epochsız ilk sayfa), R1 (eşzamanlı ingest+trim'da duplicate/rewind yok).

---

## §7. Geri-Uyumluluk (Back-Compat)

- **Seq'siz istemci** → `seqMode=false` → offset dalı **değişmeden** çalışır (test B1/B2/C).
- **`since`-only istemci** → seq işine karışmaz (test B3/S2).
- **`perChatLimit`-only istemci** → offset modunda "en yeni N" sözleşmesi korunur (test 15b/B5).
- **`afterSeq` epochsız** → ilk sayfa servis edilir (test B4).
- **Bozuk `afterSeq`** (NaN) → `seqMode=false`, offset'e düşer; sessiz seq modu yok (test G).

`package.json` test zinciri: dağıtılan (deployed) zincire yalnızca iki seq test script'i **eklendi**; `main`-only
scriptler dahil edilmedi (drift yok).

---

## §8. Kapılar (Gates) — Gerçek Çıkış Kodları

| Kapı | Komut | Sonuç | Çıkış |
| --- | --- | --- | --- |
| Birim/entegrasyon (tam suite) | `npm test` | TÜM YEŞİL (43 script) | **0** |
| Seq sözleşme testi | `node scripts/test-bulk-seq-pagination.mjs` | 8/8 PASS | **0** |
| Seq garanti testi | `node scripts/test-bulk-seq-pagination-guarantees.mjs` | 32/32 PASS | **0** |
| Drift kontrolü | `grep -E 'jidKind|countCachedMessages|test-history-diagnostics|test-messages-cached-metric'` | TEMİZ | — |
| Kapsam kontrolü | `git diff --cached --name-only | grep -v '^whatsapp-gateway/'` | yalnızca gateway | — |
| Backend sözleşme (köprü) | `backend/tests/test_tz415_gateway_backend_bridge.py` | legacy 14 RAM mesajdan 3'ünü atlar; fixed 14/14 | — (önceden doğrulandı) |

> Not: `npm test` çıkışı 0'dır. Log'daki "FAIL"/"provider failure"/"event_bridge_connection_failed" dizgileri
> test **adları/yapay senaryolardır**, gerçek başarısızlık değildir.

---

## §9. İzole Release Adayı (Isolated Candidate)

**Worktree:** `/tmp/tz415-gw` (detached @ `cbe4f509`)
**Kapsam:** **yalnızca `whatsapp-gateway/`** — backend ve frontend **hariç**.

**Staged dosyalar (7) — diff stat `+1210 / -23`:**
```
 whatsapp-gateway/package.json                    |   2 +-
 whatsapp-gateway/scripts/test-bulk-seq-pagination-guarantees.mjs | 537 +++
 whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs            | 216 +++
 whatsapp-gateway/src/index.js                    |  13 +-
 whatsapp-gateway/src/messages/message-store.js   | 278 +++-
 whatsapp-gateway/src/session-manager.js          | 177 +++-
 whatsapp-gateway/src/socket/socket-events.js     |  10 +-
```
Untracked: yalnızca `whatsapp-gateway/node_modules` (adayın dışında, hariç tutulur).

**Manifest (git blob SHA1):**
| Dosya | Blob SHA1 |
| --- | --- |
| package.json | `53a9a1ef90cdd44e94daecbe753bbeaee6bf5a30` |
| src/index.js | `128b0bbb7679fcce391bf2012d7343d2cea1965b` |
| src/messages/message-store.js | `c5bef759693a4dc575dde9e7f9999543be1c8d1b` |
| src/session-manager.js | `b8676998a1ca8ae1083649007b7376d548dc7718` |
| src/socket/socket-events.js | `cd3a21cc497c66d4bfe2a50629c7aee7243763d9` |
| scripts/test-bulk-seq-pagination.mjs | `761ff7a92bdd01aef49d8a817d7413fc1d4ea95b` |
| scripts/test-bulk-seq-pagination-guarantees.mjs | `a93bf0614720028c8d83475f82f71b80ebad4e02` |

**Write-tree:** `8746115ac8dd738a466e69e9547dc0a2844e655c`

**Önerilen commit mesajı:**
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

---

## §10. Verdict

### ✅ READY FOR EXPLICIT GATEWAY COMMIT APPROVAL

**Koşullar (Conditions):**
1. Aday **gateway-only** bir release commit'i olarak el ile oluşturulmalıdır (backend/frontend commit'leri
   değiştirilmez). Doğru hedef: 4.7'nin gateway yarısı için ayrı bir gateway release dalı, veya mevcut
   `release/backend-only-*` desenine uygun yeni bir dal.
2. Commit **bu oturumda push/edilemez** (DEPLOY=YASAK, PUSH=YASAK). Normal `host-release.sh` kapısından
   geçirilmelidir; `--no-gateway` guard'ı backend değişmediği için **tetiklenmez** (bu bir gateway release'dir).
3. Deploy öncesi backend↔gateway sözleşmesi kontrol edilmeli: yeni backend `afterSeq`/`seqEpoch` gönderiyor
   mu? (Köprü testi B4: epochsız `afterSeq` ilk sayfayı servis eder — geriye dönük uyumlu.)
4. Üretim `.deployed-commit` hâlâ `cbe4f509`; deploy sonrası `messages` / `/health.whatsapp_memory_persistence`
   doğrulanmalı (backend → verify → gateway sırası; gateway RAM yeniden kurulacağı için backend kalıcılığı
   önce teyit edilmeli).

**Neden BLOCKED / NOT READY değil:** Tüm kapılar yeşil; aday izole, üretime dokunmadı, drift yok, geri-uyum
korundu. Engel yalnızca süreçsel (yasaklı push/deploy) — kod açısından onaylamaya hazır.

---

## Ek: Üretim Durumu (Değişmedi)

- `.deployed-commit` = `cbe4f509` (oturumda değiştirilmedi).
- RAM 9163 / DB 9246 / RAM_ONLY 0 / DB_ONLY 83 (4.14 ölçümü; bu oturumda yeni ölçüm alınmadı).
- Hiçbir container restart, DB-write, RAM-wipe, persistence-enable, prod-test veya re-pair yapılmadı.
