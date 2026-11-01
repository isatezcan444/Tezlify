# AŞAMA 5.2.10 — E2E TEST DAYANIKLILIĞI VE SON TEMİZLİK

**Tarih:** 2026-11-01
**Kapsam:** Yalnızca test altyapısı — 2 script + bu rapor.
**Başlangıç HEAD:** `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6` ✅ (değişmedi)
**Branch:** `main`
**Sonuç:** F1, F2, F3 kapatıldı. Altı regresyon testi yeşil. **Stage 0, commit 0, push 0, deploy 0.**

---

## 1. F1 — Ölü değişken

### Önceki durum (5.2.9 bulgusu)

`frontend/scripts/verify-whatsapp-dom.mjs`, konuşma-değiştirme senaryosunda:

```js
const callsBefore = el[SIM].scrollIntoViewCalls;   // satır 682
await view.update(h(ChatThread, { ... conversationKey: 'B' }));
...
assert.ok(elB[SIM].scrollIntoViewCalls > callsBefore, 'the switch must re-run the scroll to newest');
```

5.2.8'de ikinci satır gerçek mekanizma iddiasıyla (`elB.scrollTop === elB.scrollHeight − elB.clientHeight`) değiştirildi, ancak `callsBefore` tanımı geride kaldı. Dosya genelinde tek geçiş noktası tanımın kendisiydi → **ölü değişken**.

### Düzeltme

Yalnızca tanım silindi:

```diff
-    const callsBefore = el[SIM].scrollIntoViewCalls;
     await view.update(
```

Başka hiçbir assertion veya davranış değişmedi. `SIM.scrollIntoViewCalls` sayacı **bilinçli olarak korundu**: senaryoya özel durum değil, paylaşılan `scrollIntoView` stub'ının enstrümantasyonudur (tanım `:140`, artırma `:156`). Kaldırmak stub'ı değiştirmek olurdu; direktif "yalnızca ilgili tanımı sil" diyor.

**Yan etki:** sayaç artık yazılıyor ama okunmuyor. Zararsız; ileride jump-to-message testi eklenirse hazır durur. Açık risk olarak §7'de listelendi.

---

## 2. F2 — Tekrarlayan assertion'lar

### 2.1 Kapsam içi çift (5.2.9'un işaret ettiği yer)

```js
// ÖNCE — aynı ifade iki kez, iki farklı mesajla
assert.equal(elB.scrollTop, elB.scrollHeight - elB.clientHeight,
  'switching conversations must land at the bottom, not inherit A\'s viewport');
assert.equal(elB.scrollTop, elB.scrollHeight - elB.clientHeight,
  'the switch must re-run the scroll to newest');
```

```js
// SONRA — tek assertion, iki davranışı da kapsayan mesaj
assert.equal(
  elB.scrollTop,
  elB.scrollHeight - elB.clientHeight,
  'switching conversations must re-run the scroll to newest and land at the bottom, not inherit A\'s viewport'
);
```

### 2.2 Aynı kusur sınıfından iki çift daha (kapsam genişletmesi — beyan)

Denetim sırasında **aynı senaryo bloğunda** (konuşma-değiştirme, `:719-740`) bitişik ve birebir aynı ifadeli **iki çift daha** bulundu. Bunlar da 5.2.8'in assertion değişiminin kalıntısıydı:

| Satır | Önce | Sonra |
| --- | --- | --- |
| 728–729 | `...'the chat must position itself when its content appears'` + `...'and show the newest message'` | tek assertion: `'...position itself when its content appears and show the newest message'` |
| 737–738 | `...'switching back must re-run the initial positioning'` + `...'switching back lands on A\'s newest message'` | tek assertion: `'...re-run the initial positioning and land on A\'s newest message'` |

**Neden dokunuldu:** bunlar F2'nin tam kendisidir (yinelenen `scrollTop` assertion'ı), farklı bir iyileştirme değil; aşamanın adı da "son temizlik". Yalnızca birini bırakmak, aynı dosyada aynı kusuru yarım düzeltmek olurdu. **Kapsam genişletmesi burada açıkça beyan ediliyor** — istenmezse geri alınabilir (tek satırlık, bağımsız iki değişiklik).

**Doğrulama gücü:** her üç birleştirmede de kalan assertion **aynı eşitlik ifadesidir** (`elX.scrollTop === elX.scrollHeight − elX.clientHeight`). Hiçbir koşul gevşetilmedi, hiçbir senaryo atlanmadı; yalnızca yinelenen *mesaj* metni tek mesaja katıldı.

**Tarama sonucu:** dosyada bitişik + birebir aynı ifadeli assertion çifti **0** (otomatik tarama ile doğrulandı).

---

## 3. F3 — E2E cleanup güvenliği

### Önceki durum

`frontend/scripts/verify-whatsapp-notify-append-browser.mjs` doğrusal akıştı:

```
spawn Chrome → waitForPageTarget → new WebSocket → CDP enable → probe
→ init → 8 senaryo → kanıt yazımı → cleanup() → ws.close() → özet
```

`cleanup()` yalnızca Chrome + HTTP server + tmp dizinini kapatıyordu ve **yalnızca mutlu yolun sonunda** çağrılıyordu. `check()` her senaryoyu yakaladığı için senaryo hataları güvenliydi; ama `init()`, CDP `send`, `mkdir`, `writeFile` gibi çağrılar beklenmedik şekilde fırlatırsa:

- headless Chrome **açık kalıyordu** (SIGKILL edilmiyordu),
- geçici profil dizini `/var/folders/.../T/wa-notify-*/` **silinmiyordu**,
- CDP soketi kapanmıyordu,
- `results.json` yazılmıyordu.

`process.on('exit')` kancası da yoktu.

### Düzeltme — tek, idempotent teardown

```js
let ws = null;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  try { if (ws && ws.readyState !== 3) ws.close(); } catch {}   // CDP soketi
  try { chrome.kill('SIGKILL'); } catch {}                       // Chrome child
  try { await new Promise((r) => server.close(r)); } catch {}    // HTTP server
  try { await rm(tmp, { recursive: true, force: true }); } catch {} // tmp profil
};
```

Karşılanan kurallar:

| Kural | Nasıl |
| --- | --- |
| Bir hata diğer kaynakların temizliğini engellememeli | Her adım **ayrı** `try/catch` içinde; biri patlarsa diğerleri yine çalışır |
| Chrome zaten kapalıysa tekrar kapatma hatası testi bozmamalı | `chrome.kill()` kendi `try/catch`'inde; `cleaned` latch'i ikinci çağrıyı tamamen atlar |
| Cleanup hatası asıl hatayı maskelememeli | `cleanup()` **hiç fırlatmaz**; `finally` içinde çağrılır, dönen hata yok |
| Normal test başarısızlıkları sonuç JSON'una yansımalı | `check()` `results`/`failed` sayacını günceller; JSON mutlu yolda da yazılır |
| Beklenmedik exception'da kanıt korunmalı | `catch` bloğu `fatal` alanlı `results.json` + `unexpected-failure.png` yazar |
| Başarılı testlerin davranışı değişmemeli | Çıktı ve kanıt **byte-identical** (§5.3) |
| Port 9335 ve Chrome yolu değişmemeli | Değişmedi |
| Yeni dependency yok | Yok; `mkdir` zaten import edilmişti |

### Yeni üst düzey yapı

```js
let fatal = null;
try {
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ...
  await call('window.__h.init()');
  ... 8 senaryo (her biri check() ile korumalı) ...
  await shot('notify-append-final.png');
  await writeFile(... console.log ...);
  await writeFile(... results.json ...);
} catch (e) {
  fatal = e;
  console.error(`\nUNEXPECTED FAILURE: ${e && e.stack ? e.stack : e}`);  // orijinal hata
  try { await mkdir(EV, { recursive: true }); } catch {}
  await shot('unexpected-failure.png');                                  // kanıt
  try { await writeFile(... { ..., fatal: String(e) } ...); } catch {}   // kanıt
} finally {
  await cleanup();                                                       // her yolda
}

console.log(`\nReal browser notify/append (Chrome): ${passed} passed, ${failed} failed`);
...
if (failed > 0 || fatal) process.exit(1);
```

### Cleanup yaşam döngüsü

| Aşama | Kaynak | Sahibi | Ne zaman kapanır |
| --- | --- | --- | --- |
| esbuild bundle | geçici dosya | `tmp` | `cleanup()` → `rm(tmp)` |
| HTTP server | `http.createServer` | `server` | `cleanup()` → `server.close()` |
| Chrome child | `spawn` | `chrome` | `cleanup()` → `kill('SIGKILL')` |
| Chrome profili | `tmp/profile` | `chrome --user-data-dir` | `cleanup()` → `rm(tmp)` |
| CDP soketi | `new WebSocket` | `ws` | `cleanup()` → `ws.close()` |

**Sıra bilinçli:** soket → Chrome → server → dosya sistemi. Soket önce kapanır (Chrome ölünce zaten kapanır, ama sıra deterministik olsun diye); dizin **en son** silinir, çünkü Chrome profili hâlâ açıkken silmek kilitli dosya bırakabilir.

**Erişilebilirlik:** paylaşılan durum (`passed`, `failed`, `results`, `pageErrors`, `consoleLines`, `msgId`, `pending`, `EV`, `send`, `evaluate`, `shot`) korumalı bloğun **dışına** taşındı; böylece `catch` bloğu tarayıcı öldükten sonra bile kanıt yazabiliyor.

---

## 4. Kontrollü hata testi (F3 doğrulaması)

**Yöntem:** Kalıcı davranışa **hiçbir şey eklenmedi**. Gerçek script'in geçici bir kopyası (`frontend/scripts/.f3-inject.tmp.mjs`) üretildi, `await call('window.__h.init()')` satırının hemen ardına bir `throw` ve bir ölçüm probu enjekte edildi, koşuldu, sonra dosya **silindi**.

```js
  await call('window.__h.init()');
  console.log('INJECT_PROBE port=' + server.address().port + ' profile=' + profile);
  throw new Error('F3 INJECTED: unexpected failure right after browser init');
```

### Ölçüm sonuçları

| Kontrol | Beklenen | Ölçülen | Sonuç |
| --- | --- | --- | --- |
| Exit code | 1 | **1** | ✅ |
| Orijinal hata korundu | `F3 INJECTED…` görünür | `UNEXPECTED FAILURE: Error: F3 INJECTED: unexpected failure right after browser init` | ✅ |
| Fatal özeti | yazdırılır | `Fatal: F3 INJECTED: unexpected failure right after browser init` | ✅ |
| Geçici profil dizini silindi | yok | `/var/folders/…/T/wa-notify-kGZmBV` → **SILINDI** | ✅ |
| Chrome süreci kalmadı | yok | `pgrep -f "user-data-dir=…"` → **YOK** | ✅ |
| HTTP server kapandı | port dinlemiyor | `lsof -iTCP:61053 -sTCP:LISTEN` → **boş** | ✅ |
| Kalan `wa-notify-*` dizini | 0 | **0** | ✅ |
| 9335'te asılı süreç | yok | **YOK** | ✅ |
| `results.json` fatal alanı | var | `"fatal": "Error: F3 INJECTED: …"`, `passed=0`, `failed=0` | ✅ |
| Ekran görüntüsü kanıtı | var | `unexpected-failure.png`, **23.863 B** | ✅ |

**Enjeksiyon artefaktları temizlendi:** `.f3-inject.tmp.mjs` silindi; tek seferlik `unexpected-failure.png` silindi (kanıt dizini 3 dosyada sabit kalsın diye — boyutu ve varlığı burada kayıtlı). Ardından normal E2E yeniden koşuldu ve kanıt **byte-identical** olarak geri geldi (§5.3).

**Not:** `process.exit(0)` içeren SKIP yolu (Chrome açılamazsa) korumalı bloktan **önce** çalışır ve `cleanup()`'ı kendisi çağırır; `finally`'ye ihtiyaç duymaz.

---

## 5. Regresyon testleri

### 5.1 Sonuçlar (nihai hâl üzerinden, sırayla)

| # | Komut | Exit | Ölçülen |
| --- | --- | --- | --- |
| 1 | `node scripts/verify-whatsapp-dom.mjs` | **0** | `WhatsApp DOM verification: PASS (22 checks)` |
| 2 | `node scripts/verify-whatsapp-notify-append-browser.mjs` | **0** | `Real browser notify/append (Chrome): 8 passed, 0 failed` |
| 3 | `node scripts/verify-whatsapp-browser.mjs` | **0** | `Real browser (Chrome Chrome/156.0.8078.74): 10 passed, 0 failed` |
| 4 | `node scripts/verify-whatsapp-notify-append.mjs` | **0** | `=== SONUC: 28 passed, 0 failed ===` |
| 5 | `npx tsc --noEmit -p tsconfig.json` | **0** | temiz (yalnızca `.npmrc` uyarısı) |
| 6 | `npx vite build` | **0** | `✓ built in 8.52s` |

**6/6 exit 0.** Sayılar 5.2.8/5.2.9 ile aynı: **22 · 8 · 10 · 28 · 0 · 0**. Hiçbir assertion silinmedi, gevşetilmedi; hiçbir senaryo atlanmadı.

### 5.2 DOM testinin negatif kontrolleri

`dom.mjs` üç `falsify()` kontrolü içeriyor (scroll-anchor yükseklik telafisi, pagination-render, composer-isolation). Bu koşuda üçü de çalıştı:

```
ok - scroll-anchor: rejecting `scrollTop = previousScrollTop` (no height compensation) (broken variant correctly rejected)
ok - pagination-render: rejecting `messages = incoming` (pages wiped) (broken variant correctly rejected)
ok - composer-isolation: an unkeyed composer really does leak the draft (broken variant correctly rejected)
```

Yani F1/F2 temizliği falsification harness'ını zayıflatmadı.

### 5.3 Determinizm kanıtı

E2E birden çok kez koşuldu (normal → enjekte → normal → normal). Kanıt dosyalarının SHA-256'sı **her normal koşuda aynı**:

| Dosya | Hash (16) |
| --- | --- |
| `notify-append-final.png` | `2bad13a0a1fdda0b` |
| `notify-append-console.log` | `30e4b87729e33bff` |
| `notify-append-results.json` | `f2b5ae6b77c6d669` |

Bu, F3 yeniden yapılandırmasının **gözlemlenebilir davranışı değiştirmediğinin** fonksiyonel kanıtıdır: `results.json` 8 senaryonun **tam adını ve sonucunu** gömüyor, `console.log` ise tüm çıktı satırlarını. Hash aynıysa metinler de aynıdır.

---

## 6. Git baseline ve son durum

| Öğe | Başlangıç | Bitiş |
| --- | --- | --- |
| `git rev-parse HEAD` | `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6` | **aynı** ✅ |
| `git branch --show-current` | `main` | `main` |
| `git diff --cached --stat` | boş | **boş** ✅ |
| `git status --porcelain \| wc -l` | 88 | **88** (bu rapor eklendiğinde 89) |

### Değişen dosyalar (5.2.10 kapsamı)

| Dosya | Durum | Δ | Hash (16) |
| --- | --- | --- | --- |
| `frontend/scripts/verify-whatsapp-dom.mjs` | `M` | **+25 / −9** | `64e4eed203cf7305` (5.2.9: `90845f18…`) |
| `frontend/scripts/verify-whatsapp-notify-append-browser.mjs` | `??` (yeni, 5.2.8'den) | 696 → **718** satır | `4882b8695351db42` (5.2.9: `e9a30319…`) |
| `docs/audits/ASAMA-5.2.10-e2e-cleanup-hardening.md` | `??` (bu rapor) | yeni | — |

**Başka hiçbir dosya değişmedi.** 5.2.10 penceresinde (19:30–19:40) mtime'ı değişen tek dosyalar yukarıdaki iki script'tir. `frontend/src/**`, `backend/**`, `whatsapp-gateway/**`, `package.json` ve lock dosyalarına **dokunulmadı**.

### Silinen geçici dosyalar

| Dosya | Neden |
| --- | --- |
| `frontend/scripts/.f3-inject.tmp.mjs` | Hata enjeksiyonu için üretilen geçici kopya; test sonrası silindi, `git status`'ta görünmüyor |
| `docs/audits/evidence/5.2.8/unexpected-failure.png` | Enjekte koşunun tek seferlik artefaktı; kanıt dizinini 3 dosyada tutmak için silindi |

---

## 7. Açık kalan riskler

**R1 — Diff gürültüsü (bilgi).** F3, çalışma gövdesini `try` içine aldığı için 269 satır 2 boşluk içeri girintilendi. Bu **saf biçimlendirme**dir; ancak dosya untracked olduğu ve 5.2.10 başında bir yedek kopya alınmadığı için bugünden sonra "whitespace-yok sayan" bir diff üretilemez. Telafi: §5.3'teki byte-identical kanıt (senaryo adları ve tüm çıktı metinleri değişmedi). **Öneri:** commit'ten sonra `git diff -w` ile doğrulanabilir hâle gelir.

**R2 — `scrollIntoViewCalls` artık yaz-only.** F1 sonrası sayaç artırılıyor ama okunmuyor. Bilinçli (paylaşılan stub). İleride jump-to-message senaryosu eklenirse doğal olarak okunur; eklenmezse ölü enstrümantasyon olarak kalır.

**R3 — Süreç `SIGKILL` alırsa cleanup çalışmaz.** `finally` normal çıkışta ve yakalanan hatalarda çalışır; dışarıdan `SIGKILL`/`SIGTERM` gelirse çalışmaz. Bu, `try/finally` yaklaşımının doğal sınırıdır. Gerekirse `process.on('SIGTERM')` eklenebilir — bu aşamada kapsam dışı bırakıldı.

**R4 — Sabit port 9335 ve macOS Chrome yolu.** Direktif gereği **değiştirilmedi**. İki E2E eşzamanlı koşarsa port çakışır; Chrome yoksa script `SKIP` + exit 0 verir (sessiz atlama riski). Bu, üç tarayıcı scriptinin ortak, önceden var olan sınırıdır.

**R5 — Test repo içine yazıyor.** Her koşu `docs/audits/evidence/5.2.8/` altını yeniden yazar; `git status` kirli görünebilir. Bilinçli (kanıt amaçlı), ama CI'da beklenmedik kirlilik yaratır.

**R6 — Model sadakati (5.2.8'den devam).** E2E'de `unread`/`message_count` aritmetiği minimal sarmalayıcıdır; `WhatsAppHubPage`'in gerçek reducer'ı import edilmiyor. Bu aşamada kapsam dışı.

**R7 — Kapsam genişletmesi (§2.2).** F2 kapsamında iki ek yinelenen çift temizlendi. Teknik olarak aynı kusur sınıfı ve aynı senaryo bloğu, ama direktifin verdiği satır aralığının biraz dışında. İstenmezse iki değişiklik bağımsız olarak geri alınabilir (her biri tek assertion).

---

## 8. Durdurma

- Stage — **YOK** (`git diff --cached` boş)
- Commit — **YOK**
- Push — **YOK**
- Deploy — **YOK**
- Branch değişikliği — **YOK** (`main`)
- Production / DB / container / gateway işlemi — **YOK**
- Persistence loop — **kapalı**, dokunulmadı
- `package.json` / lock — **değişmedi**
- Yeni dependency — **yok**

**Duruldu. Commit için kullanıcıdan açık onay bekleniyor.**
