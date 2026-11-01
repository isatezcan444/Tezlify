# AŞAMA 5.2.8 — GERÇEK BROWSER E2E TEST ALTYAPISININ ONARILMASI

**Tarih:** 2026-11-01
**Kapsam:** Yalnızca test altyapısı (`frontend/scripts/**`). Üretim kodu değişmedi.
**Durum:** Tamamlandı — 4 doğrulama paketinin tamamı yeşil, tip kontrolü ve production build temiz.
**Durdurma:** Rapor yazıldıktan sonra duruldu. Commit / push / deploy / sonraki aşama **yapılmadı**.

---

## 1. Başlangıç Git durumu

| Öğe | Değer |
| --- | --- |
| Beklenen baseline | `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6` |
| Ölçülen HEAD | `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6` ✅ eşleşiyor |
| Branch | `main` |
| Değişiklik kapsamı | Sadece `frontend/scripts/**` + `docs/audits/**` |

Worktree başlangıçta **temiz değildi** ve bu aşama tarafından yaratılmadı. Devralınan kirli durum:

- **Takip edilen 26 dosya değişik** — 4.7 memory-persistence çalışması (backend 6 dosya, gateway 6 dosya) + 3.9.19 escrow birikintisi (`frontend/src/App.tsx`, `api/admin.ts`, `types/admin.ts`, `locales/{en,tr}.ts`, `Sidebar.tsx`).
- **Untracked** — escrow backend dosyaları, `docs/audits/ASAMA-4.10…4.13`, `docs/TEZLIFY-HANDOFF-CONTEXT.md`, `frontend/scripts/verify-whatsapp-notify-append.mjs` (5.2.7 jsdom paketi).

> Bu aşamada `git add -A`, `git clean`, `git reset --hard`, stash veya kullanıcı değişikliği silme **kullanılmadı**. Mevcut kirli durum korunarak çalışıldı.

---

## 2. İki hatanın kök nedeni

### 2.1 `useToast must be used within a ToastProvider`

**Belirti:** `verify-whatsapp-browser.mjs` daha ilk render'da patlıyordu (10 senaryodan 6'sı düşüyordu).

**Kök neden — gerçek bir altyapı sapması, üretim hatası değil:**
Harness yalnızca `I18nProvider` ile sarmalıyordu. Oysa üretimde `ChatBubble` **`useToast()`** çağırıyor ve `ToastContext` yoksa `useToast` bilinçli olarak fırlatıyor:

```
frontend/src/context/ToastContext.tsx:345-351
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
```

`useTheme()` bu açıdan farklıdır: context yoksa `document.documentElement`'ten türetilmiş güvenli bir fallback döner. Yani eksik provider **sadece** toast tarafında ölümcüldü — bu yüzden hata mesajı tam olarak `useToast` diyordu.

**Neden mock'lanmadı:** Direktif gereği `useToast` mock'lanmadı. Test edilen şey gerçek toast davranışı olduğu için sahte bir provider, hatayı susturup kanıtı yok ederdi. Gerçek provider ağacı kuruldu.

### 2.2 `mount should auto-scroll once (0 !== 1)`

**Belirti:** `verify-whatsapp-dom.mjs` mount sonrası `scrollIntoView` çağrı sayısını `1` bekliyordu, `0` ölçüyordu.

**Kök neden — bayat metrik, üretim hatası değil:**
Bileşen mount'ta `scrollIntoView` **kullanmıyor**. Gerçek mekanizma `scrollTop` pinidir:

```
frontend/src/features/whatsapp/components/ChatThread.tsx:891,905,919,952,988
  cont.scrollTop = cont.scrollHeight;          // anlık, animasyonsuz
:961-965  // "Double pin via requestAnimationFrame"
  requestAnimationFrame(() => { ... scrollTop = scrollHeight; });
```

`scrollIntoView` yalnızca **jump-to-message** yolunda var (`:1000-1001`, `activeMessageId` etkisi). Yani test, var olmayan bir mekanizmayı sayıyordu: 0 doğru cevaptı.

**Neden üretim değiştirilmedi:** Direktif "test geçsin diye production auto-scroll değiştirilmez" diyor. Üretim aynen bırakıldı; **ölçüm** gerçek gözlemlenebilir davranışa çevrildi.

---

## 3. Altyapı değişiklikleri

### 3.1 `verify-whatsapp-browser.mjs` (+55 / −10)

| # | Değişiklik | Gerekçe |
| --- | --- | --- |
| 1 | `ThemeProvider` + `ToastProvider` importu ve gerçek iç içe sarmalama | §2.1 |
| 2 | `input[type="text"]` → `textarea` (`HTMLTextAreaElement` value setter) | Gerçek `ChatComposer` girişi `<textarea>` (`ChatComposer.tsx:1339`); `input[type="text"]` sadece koşullu alt panellerde var |
| 3 | `.bottom-4.right-4` → `[data-testid="new-message-pill"]` | `ToastProvider` portalı da `fixed bottom-4 right-4` sınıflarını taşıyor → seçici **iki** elemanı da yakalıyordu |
| 4 | J senaryosu: `fitOverflow(px)` + `clearOlderRequests()` | §3.2 |
| 5 | H senaryosu: `document.querySelectorAll('textarea').length` | #2 ile tutarlılık |

**Değişiklik #3'ün önemi:** Gerçek `ToastProvider` eklendiğinde A/C/E senaryoları aynı anda `pill true !== false` ile düştü. Sebep, portalın sınıflarının test seçicisiyle çakışmasıydı — tek bir kök neden, üç görünür arıza. `data-testid` ile ayrıştırıldı.

### 3.2 J senaryosunun fixture sapması

J, "maksimum `scrollTop` tetikleme bölgesinin (<60px) içinde olan bir sohbeti açmak istek üretmemeli" senaryosudur. Fixture **4 mesajın <60px taşacağını varsayıyordu**; gerçek Tailwind'de 4 satır **1528px** taşıyor.

Guard doğru davrandı: ön koşulu reddetti, sahte geçiş üretmedi. Guard **zayıflatılmadı**; tahmin yerine ölçüm konuldu:

```js
async fitOverflow(px) {          // içerik yüksekliğini ölç, viewport'u boyutlandır
  const overflow = el.scrollHeight - el.clientHeight;
  const next = Math.round(outer.getBoundingClientRect().height + (overflow - px));
  outer.style.height = next + 'px';  rootEl.style.height = next + 'px';
  ...
}
```

Ardından sohbet **yeniden açılır** (`select(1)` → `select(2)`) ki gerçek "sohbete tıkla" yolu ölçülen geometriyle çalışsın. Ön koşul hâlâ `0 < maxScrollTop < 60` doğrular ve artık ölçülen değeri de raporlar.

**Not (kendi hatam):** İlk denemede `await settle()` çağrısını Node tarafına yazdım; `settle` yalnızca sayfa bağlamında tanımlı olduğu için `settle is not defined` aldım. Kısa bir bekleme ile düzeltildi.

### 3.3 `verify-whatsapp-dom.mjs` (+16 / −5)

4 `scrollIntoViewCalls` iddiası **silinmedi**, gerçek gözlemlenebilir sonuca çevrildi:

```js
assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight, 'mount should auto-scroll to the bottom');
```

Ek olarak `mount()` deterministik hale getirildi:

```js
// mount sonrası rAF double-pin'in oturmasını bekle
await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
```

**Neden gerekliydi:** Mount sonrası ertelenmiş pin, hemen `scrollTop`'u değiştiren senaryoyla yarışıyor ve viewport'u sessizce dibe geri çekiyordu. Bu bir **harness nondeterminism**'i, bileşen kusuru değil.

Ayrıca G-bottom iddiası manuel konumlandırmadan **önce** taşındı — böylece "zaten dipteydi" maskesi imkânsız hale geldi.

### 3.4 Yeni dosya: `verify-whatsapp-notify-append-browser.mjs` (682 satır)

Bkz. §4–§10.

---

## 4. Gerçek Chrome test mimarisi

```
esbuild (entry.tsx → bundle.js)
   ↓
Node http server (127.0.0.1:0)  ──  index.html + bundle + gerçek dist CSS
   ↓
spawn Chrome --headless=new --remote-debugging-port=9335 --user-data-dir=<tmp>
   ↓
/json/list → page target → WebSocket → CDP
   ↓
Runtime.enable / Page.enable / Log.enable
Runtime.evaluate { awaitPromise: true, returnByValue: true }
   ↓
cleanup: Chrome SIGKILL → server.close → tmp rm
```

**Gerçek olan nedir:**

- Gerçek `ConversationList`, gerçek `ChatThread`, gerçek `ChatBubble`, gerçek `ToastProvider` portalı.
- Gerçek layout: `scrollHeight`, `clientHeight`, `scrollTop` tarayıcı motorundan.
- Gerçek `dist/assets/*.css` yüklenir (yoksa minimal shim).
- Gerçek event yolu: `window.dispatchEvent(new CustomEvent('tezlify:ws_event', { detail }))`. `WhatsAppApi.subscribe` sadece bir `window` dinleyicisi eklediği için **tek** dispatch noktası tüm gerçek handler'ları sürer.

**Üretimden import edilen fonksiyonlar (kopya değil):**

```js
import { buildChatPreview, shouldApplyPreview } from '.../lib/whatsappPreview';
import { mergeWhatsAppMessages } from '.../lib/whatsappMessageMerge';
import { triggerInboundNotification } from '.../lib/whatsappAudio';
```

Sadece unread/`message_count` aritmetiği minimal bir sarmalayıcıdır (direktif §4'ün izin verdiği kadarı).

**Ses ölçümü — üretim modülü stub'lanmadı:** `window.AudioContext` sahne tarafında sahte bir sınıfla değiştirilir; `createOscillator().start()` çağrılarını sayar. Böylece gerçek `playSoundPreset` çalışır ve tarayıcı sınırında gözlemlenir.

```js
FakeOsc.prototype.start = function () { window.__soundOsc += 1; };
```

600 ms throttle (`THROTTLE_WINDOW_MS`, modül-global `lastPlayedAt`) nedeniyle senaryolar arasında `wait(700)` ve `soundReset()` kullanılır.

---

## 5. Provider ağacı

Harness, `App.tsx` ile **birebir** aynı sırayı kurar:

```
ThemeProvider
└── I18nProvider
    └── ToastProvider          ← useI18n() çağırdığı için I18n'in İÇİNDE olmak zorunda
        └── Harness
            ├── ConversationList
            └── ChatThread → ChatBubble (useToast + useI18n)
```

`ToastProvider` iç içe olması zorunlu: `ToastContext.tsx:101` içinde `const { t } = useI18n();` var. Sıra ters çevrilirse farklı bir hata alınır.

`ThemeProvider` da eklendi çünkü `ChatThread` `useTheme()` kullanıyor; fallback'i olsa da üretim sadakati için gerçek provider tercih edildi.

---

## 6. Auto-scroll doğrulaması

**Gerçek mekanizma (ölçülen):** mount'ta `cont.scrollTop = cont.scrollHeight` (anlık) + `requestAnimationFrame` ile ikinci pin.

**Doğrulanan gözlemlenebilir:** `el.scrollTop === el.scrollHeight - el.clientHeight` — yani "en yeni mesaj görünür ve viewport dipte".

`verify-whatsapp-dom.mjs` sonucu: **PASS (22 checks)**.

`verify-whatsapp-browser.mjs` A senaryosu gerçek Chrome'da aynı sonucu doğrular: sohbet değişiminde yeni sohbetin en yeni mesajına inilir (`scrollTop === scrollHeight − clientHeight`).

---

## 7. Notify sonuçları (gerçek Chrome)

Sözleşme (`WhatsAppHubPage.tsx`): inbound + replay-değil → `notifyInboundRef.current(...)` (ses + masaüstü); unread `+1` **yalnızca** `!(isCurrentSelected || isOutbound)`; `message_count +1` replay değilse; önizleme yalnızca `shouldApplyPreview(msgTime, last_message_at)` doğruysa.

| Senaryo | Doğrulanan | Sonuç |
| --- | --- | --- |
| **A** notify(açık sohbet) | balon DOM'da render edildi · preview `Yeni mesaj` · timestamp `12:00` · count +1 · **unread 0** · badge yok · ses > 0 | ✅ |
| **B** notify(kapalı sohbet) | unread +1 · `data-testid="conv-unread-badge-2"` = `1` · preview + count güncel | ✅ |
| **C** outbound | unread 0 · ses **0** · toast yok | ✅ |
| **D** replay (aynı `wa_message_id`) | count/unread/preview değişmez · ikinci ses **0** · ilk teslimatta ses > 0 | ✅ |

---

## 8. Append sonuçları

**Append tanımı:** REST geçmiş sayfası gelir, canlı yayın **yoktur**. Sadece balonlar birleşir; preview/unread/ses/toast'a dokunmamalıdır.

| Senaryo | Doğrulanan | Sonuç |
| --- | --- | --- |
| **E** eski mesaj append | balon DOM'da (`Eski mesaj`) · preview **gerilemez** · timestamp **geri gitmez** · unread değişmez · ses **0** | ✅ |
| **G** preview sıralaması | daha yeni kazanır · daha eski yok sayılır · eşit timestamp uygulanır | ✅ |

---

## 9. Dedup sonuçları

**Senaryo F — aynı mesaj önce geçmişten, sonra canlıdan:**

1. Konuşma 2 **kapalı** tutulur (`select(1)`).
2. `appendHistory(2, { wa_message_id: 'W205', body: 'Canli' })` — REST yolu, yayın yok.
3. Aynı `wa_message_id` ile canlı `message_set` yayını.

Doğrulanan:
- unread tam **+1** (kapalı sohbet),
- `message_count` tam **+1**,
- preview canlı mesajın,
- **gerçek DOM'da balon sayısı tam 1** (`threadText.match(/Canli/g).length === 1`).

Bu son madde `mergeWhatsAppMessages`'ın `wa:<wa_message_id>` kimliğiyle tekilleştirdiğinin tarayıcı kanıtıdır.

> **Dürüst not:** F ilk koşuda `0 !== 1` ile düştü. Sebep üretim değil, **benim test modelimdi**: senaryo konuşma 2'yi `select(2)` ile **açık** seçiyordu, dolayısıyla üretim doğru davranıp unread'i 0 tutuyordu. Beklenti yanlıştı; düzeltme beklentiyi üretime uydurmak değil, **senaryoyu doğru kurmak** oldu (sohbet kapalı bırakıldı + dedup kanıtı DOM'a taşındı). İddia gevşetilmedi, **güçlendirildi**.

---

## 10. Toast / ses ölçümleri

**Ses:** `FakeAudioContext.createOscillator().start()` sayacı (`window.__soundOsc`). Üretim ses modülü stub'lanmadı; `triggerInboundNotification` gerçekten çalıştı.

**Toast (Senaryo H):**

| Faz | Koşul | Ölçüm | Sonuç |
| --- | --- | --- | --- |
| 1 | sekme `dashboard` | `toastCount === 1` · metin `Arka plan` içerir | ✅ |
| ara | toast süresi 4500 ms doldu | `toastCount === 0` (temiz başlangıç kanıtı) | ✅ |
| 2 | sekme `whatsapp` | `toastCount === 0` · **ama** balon DOM'da (`Sekmede`) · ses > 0 | ✅ |

**Ölçüm neden yapısal sayaca çevrildi:**

1. `reset()` toast yığınını temizlemiyor ve toast 4500 ms yaşıyor. İlk fazın toast'ı ikinci fazda hâlâ portaldaydı → "toast yok" iddiası **ölçülemezdi**. İki faz arasına 5200 ms bekleme ve `toastCount === 0` ara kanıtı eklendi.
2. Daha ciddi bulgu: harness kendi uydurduğu başlıkla (`'Yeni WhatsApp Mesaji'`) toast atıp yine aynı sabite karşı assert ediyordu — **kendi kendini doğrulayan** bir iddia. Üretim başlığı `t('whatsapp.newIncomingMessage')` (en: `New WhatsApp Message`, tr: `Yeni WhatsApp Mesajı`) ve `App.tsx:260-263` gövde kırpması (`>60` karakterde `...`) de birebir kopyalandı. Ölçüm artık locale-bağımsız: yapısal `toastCount` + gerçek mesaj gövdesi.

**İkinci fazın boş olmaması:** `toastCount === 0` **ve** balon DOM'da **ve** ses > 0 birlikte doğrulanır — yani "notify çalışmadı" ile "notify çalıştı ama toast kapılı" ayırt edilir. İddia boş değil.

---

## 11. Screenshot + log kanıtı

`docs/audits/evidence/5.2.8/`:

| Dosya | İçerik |
| --- | --- |
| `notify-append-final.png` | Son senaryonun gerçek Chrome görüntüsü |
| `notify-append-console.log` | Sayfa konsolu + yakalanan istisnalar |
| `notify-append-results.json` | `passed/failed`, her senaryonun sonucu, `pageErrors` |

Ekran görüntüsünde gerçek UI görünür: filtre çipleri (`All / Active / Groups / Unread / Archived / Closed`), konuşma satırları (`Ahmet` — önizleme `Sekmede`; `Grup Test` — `onizleme-2`), tarih ayırıcı (`January 15, 2026`) ve iki mesaj balonu (`ilk mesaj` 12:00, `Sekmede` 17:10). Yani harness boş sayfa değil, gerçek React + Tailwind çıktısı üretiyor.

`pageErrors: []` — sayfa tarafında yakalanmamış istisna yok. Konsolda yalnızca React DevTools bilgisi ve bir favicon 404'ü var.

Herhangi bir senaryo düşerse `check()` otomatik olarak `fail-<Harf>.png` yazar (bu koşuda üretilmedi — hepsi geçti).

---

## 12. Sonuç matrisi

| # | Doğrulama | Komut | Sonuç |
| --- | --- | --- | --- |
| 1 | Gerçek Chrome, sohbet UI | `node scripts/verify-whatsapp-browser.mjs` | **10 / 10 geçti** |
| 2 | jsdom layout modeli | `node scripts/verify-whatsapp-dom.mjs` | **PASS (22 checks)** |
| 3 | jsdom notify/append (5.2.7) | `node scripts/verify-whatsapp-notify-append.mjs` | **28 passed / 0 failed** |
| 4 | Gerçek Chrome notify/append/dedup | `node scripts/verify-whatsapp-notify-append-browser.mjs` | **8 / 8 geçti** |
| 5 | Tip kontrolü | `npx tsc --noEmit` | **exit 0** |
| 6 | Production build | `npx vite build` | **✓ built in 10.89s** |

**Paket 1'in ilerlemesi:** 4/10 → 6/10 (textarea) → 9/10 (pill seçici) → 10/10 (J fixture).
**Paket 4'ün ilerlemesi:** 6/8 → 8/8 (F modeli + H toast ölçümü).

Paket 3'ün 28 testi **korundu** — sayı düşürülmedi, test silinmedi.

---

## 13. Önceki regresyonlarla karşılaştırma

| Konu | Önceki durum | Bu aşama |
| --- | --- | --- |
| `useToast` hatası | Paket 1 hiç koşamıyordu (6/10 kırık) | Gerçek provider ağacı; 10/10 |
| Auto-scroll iddiası | `scrollIntoView` sayısı (var olmayan mekanizma) | `scrollTop === scrollHeight − clientHeight` (gerçek) |
| Pill seçici | Portal ile çakışan sınıf seçici | `data-testid` |
| Composer girişi | `input[type="text"]` (bayat) | `textarea` |
| J fixture | "4 mesaj <60px taşar" tahmini | İçerik ölçülür, viewport boyutlandırılır |
| Toast iddiası | Kendi sabitine karşı (self-fulfilling) | Üretim başlığı + yapısal sayaç |
| Notify/append kanıtı | Yalnızca jsdom (kopyalanmış saf fonksiyonlar) | Gerçek Chrome + üretimden import |

**Ortak desen:** Dört arızanın hepsi *testin ölçtüğü şeyin üretimden sapması*. Üçü bayat varsayım (seçici, mekanizma, layout), biri eksik provider. Hiçbiri üretim kusuru değildi ve hiçbiri üretim değiştirilerek "çözülmedi".

---

## 14. Değişen dosyalar

| Dosya | Durum | Δ |
| --- | --- | --- |
| `frontend/scripts/verify-whatsapp-browser.mjs` | değişti | +55 / −10 |
| `frontend/scripts/verify-whatsapp-dom.mjs` | değişti | +16 / −5 |
| `frontend/scripts/verify-whatsapp-notify-append-browser.mjs` | **yeni** | 682 satır |
| `docs/audits/evidence/5.2.8/*` | **yeni** | 3 dosya (png + log + json) |
| `docs/audits/ASAMA-5.2.8-browser-e2e-infrastructure.md` | **yeni** | bu rapor |

**Üretim kodu değişmedi.** `frontend/src/**` altındaki değişiklikler bu aşamadan önce vardı (3.9.19 escrow: `App.tsx`, `admin.ts`, `types/admin.ts`, `locales/{en,tr}.ts`, `Sidebar.tsx`; toplam +227 satır, silme yok). `package.json` değişmedi.

---

## 15. Kalan riskler

1. **Paket 4 gerçek sayfa değil, gerçek bileşen ağacı render ediyor.** `WhatsAppHubPage`'in kendi state yönetimi, `useWhatsAppConversation` hook'u ve `WhatsAppApi.subscribe` bağlantısı harness'ta minimal bir dinleyiciyle temsil ediliyor. Yani "gerçek bileşenler + gerçek DOM + gerçek üretim fonksiyonları" kanıtlandı; "gerçek sayfa" değil. Tam sayfa E2E ayrı bir aşamadır.
2. **`message_count` / `unread` aritmetiği harness'ta minimal sarmalayıcı.** `WhatsAppHubPage.tsx:2440-2740` içindeki gerçek reducer'ın birebir kopyası değil. Sözleşme koşulları (seçili/açık, outbound, replay) elle modellendi.
3. **Ses ölçümü sentetik `AudioContext`.** Gerçek ses çıkışı duyulmuyor; osilatör başlatma sayısı ölçülüyor. Ses *zincirinin* çağrıldığını kanıtlar, sesin *duyulduğunu* değil.
4. **Toast süresi testte bekleniyor (5200 ms).** Süre `ToastContext` içinde 4500 ms sabit; değişirse H senaryosu kırılır (ve bu doğru davranış olur — sessizce geçmez).
5. **`fitOverflow` viewport'u büyütüyor.** Chrome penceresi 900×760; J'de element ~1800px'e çıkıyor. Scroll matematiği geçerli ama görsel yerleşim pencereden taşar. Senaryo yalnızca `scrollTop`/`scrollHeight`/`clientHeight` ölçtüğü için sonucu etkilemez.
6. **5.2.7 jsdom paketi hâlâ paralel çalışıyor.** İki paket aynı sözleşmeyi farklı sadakatle doğruluyor; çelişki olursa **tarayıcı sonucu esastır** (paket 1'in kendi kuralı).
7. **`docs/audits/evidence/` yeni bir dizin.** Depoda önceden kanıt dizini konvansiyonu yoktu; bu aşama `5.2.8/` altında başlattı.

---

## 16. Push / deploy / commit yapılmadığı teyidi

- `git commit` — **yapılmadı**
- `git push` — **yapılmadı**
- `git add -A` / `git add .` — **yapılmadı** (hiçbir şey stage edilmedi)
- `git clean` / `git reset --hard` / `git stash` — **yapılmadı**
- Deploy / container restart / gateway restart — **yapılmadı**
- Production DB'ye yazma — **yapılmadı**
- Persistence kill-switch — **açılmadı**
- `package.json` — **değişmedi**
- Branch değişimi — **yapılmadı** (`main` üzerinde kalındı)
- Sonraki aşamaya geçiş — **yapılmadı** (burada duruldu)

---

## 17. Nihai Git durumu

| Öğe | Değer |
| --- | --- |
| HEAD | `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6` (değişmedi) |
| Branch | `main` |
| Stage | boş (hiçbir dosya `git add` edilmedi) |
| Yeni untracked | `frontend/scripts/verify-whatsapp-notify-append-browser.mjs`, `docs/audits/evidence/`, `docs/audits/ASAMA-5.2.8-browser-e2e-infrastructure.md` |
| Yeni değişen | `frontend/scripts/verify-whatsapp-browser.mjs`, `frontend/scripts/verify-whatsapp-dom.mjs` |

Bu aşama dışındaki kirli dosyalar (§1'de listelenen 4.7 + 3.9.19 birikintisi) **aynen korundu**; hiçbirine dokunulmadı, hiçbiri geri alınmadı.

---

## TAMAMLANMA KRİTERİ — karşılama durumu

| Kriter | Durum |
| --- | --- |
| İki hata gerçek kök nedenden düzeltildi (mock'suz) | ✅ |
| `useToast` mock'lanmadı, gerçek `ToastProvider` kullanıldı | ✅ |
| Auto-scroll gerçek mekanizmayla doğrulandı, üretim değişmedi | ✅ |
| Assertion silinmedi / keyfi sayı değiştirilmedi / `setTimeout` ile zorlanmadı | ✅ |
| Notify davranışı gerçek tarayıcı DOM'unda kanıtlandı | ✅ (A, B, C, D) |
| Append davranışı gerçek tarayıcı DOM'unda kanıtlandı | ✅ (E, G) |
| Dedup gerçek tarayıcı DOM'unda kanıtlandı | ✅ (F) |
| Toast tetiklemesi doğrudan ölçüldü | ✅ (H — yapısal sayaç) |
| Ses tetiklemesi doğrudan ölçüldü | ✅ (A, D, H — osilatör sayacı) |
| `package.json` değişmedi | ✅ |
| Commit / push / deploy yok | ✅ |
| Rapor 17 bölümle yazıldı | ✅ |

**AŞAMA 5.2.8 tamamlandı. Duruldu.**
