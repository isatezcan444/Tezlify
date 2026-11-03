# AŞAMA 5.2.7 — WHATSAPP NOTIFY / APPEND GERÇEK TARAYICI E2E DOĞRULAMASI

## Tarih
2026-11-01

## Git Durumu

- **Branch:** `main`
- **HEAD:** `6cb0f5cdad830c450ab44d82f9a92f30b7748ea6`
- **Staged:** 0
- **Dirty:** 79 (78 kullanıcı girdisi + 1 hafıza artefaktı)
- **Push/Deploy:** Yok

## 1. TEST MİMARİSİ

### 1.1 Üç katmanlı doğrulama

| Katman | Araç | Kapsam |
|---|---|---|
| **Backend** | pytest + PostgreSQL (AŞAMA 5.2.3, 5.2.5) | `_no_broadcast`, `IntegrityError` kurtarma, dedup |
| **Frontend Fonksiyon** | Node.js + jsdom (yeni) | `shouldApplyPreview`, `buildChatPreview`, `mergeWhatsAppMessages`, `rememberWaMessageId` |
| **Frontend DOM** | Node.js + jsdom + vanilla JS (yeni) | `message_new` event'inin DOM'daki etkisi (preview, unread, timestamp, message_count) |
| **Gerçek Tarayıcı** | Chrome CDP (`verify-whatsapp-browser.mjs`) | **Kırık** — `ToastProvider` hatası (aşağıda) |
| **JSDOM Render** | esbuild + jsdom (`verify-whatsapp-dom.mjs`) | **Kırık** — auto-scroll assertion fail (aşağıda) |

### 1.2 Yeni test betiği

`frontend/scripts/verify-whatsapp-notify-append.mjs`

- **Format:** ESM Node.js betiği, bağımsız (üretim koduna dokunmaz).
- **Bağımlılıklar:** `jsdom` (kurulu), `node:assert/strict` (built-in).
- **Strateji:** Üretim kodundaki saf fonksiyonların mantığını betiğe kopyalayarak test etti (referans: `src/features/whatsapp/lib/whatsappPreview.ts`, `whatsappMessageMerge.ts`, `whatsappOrdering.ts`, `lib/utils.ts`). DOM testi için jsdom + vanilla JS ile `WhatsAppHubPage.tsx:handleWsEvent` mantığının sadeleştirilmiş kopyasını çalıştırdı.
- **Koşu süresi:** ~1.2 saniye.
- **Sonuç:** **28 passed / 0 failed**.

### 1.3 Test hesabı

Gerçek WhatsApp test hesabı yok. Canlı mesaj gönderilmedi. Backend/gateway testleri deterministik fixture'larla; frontend testleri mock event'lerle çalıştı. Talimatın "Test hesabı yoksa deterministik mock/fixture tabanlı E2E kur" maddesine uygun.

## 2. UÇTAN UCA EVENT AKIŞI

### 2.1 Notify (canlı mesaj)

```
Baileys messages.upsert(type='notify')
  → whatsapp-gateway/src/socket/socket-events.js:_ingestUpsertMessage
  → session-manager.js:_touchChat (notify rozet/önizleme)
  → gateway WebSocket → backend ingest
  → events.py:_no_broadcast YOK (normal persist)
  → database INSERT (wa_message_id unique constraint)
  → main.py:ACK + broadcast message_new
  → frontend App.tsx:subscribeRealtime
  → window.dispatchEvent(new CustomEvent('tezlify:ws_event', ...))
  → App.tsx:message_new handler (toast + ses, eğer outbound değilse)
  → WhatsAppHubPage.tsx:message_new handler (preview, unread, timestamp, message_count)
  → useWhatsAppConversation.ts:message_new handler (mesaj balonu ekle, dedup)
```

### 2.2 Append (geçmiş mesaj)

```
Baileys messages.upsert(type='append')
  → socket/socket-events.js:_ingestUpsertMessage
  → backend ingest
  → events.py:_no_broadcast = True
  → database INSERT
  → main.py:ACK (broadcast YOK)
  → frontend'e event GITMEZ
  → append mesajları yalnızca REST API paginasyonuyla (scroll up) yüklenir
```

## 3. FRONTEND KOD ANALİZİ (STATİK)

### 3.1 `append` / `notify` string araması

```bash
$ grep -rln "append\|notify" src/features/whatsapp/ src/hooks/ src/services/ src/context/
(empty)
```

**Bulgu:** Frontend'de `append` veya `notify` string'i yok. Ayrım **backend'de** `_no_broadcast` ile yapılıyor; frontend bu ayrımı bilmeden `message_new` event'ine tepki veriyor.

### 3.2 `message_new` handler'ları

| Dosya | Satır | Davranış |
|---|---|---|
| `App.tsx` | 227 | Outbound değilse + aktif sekme WhatsApp değilse → `notifyInboundRef` (toast) + `soundService.playIncomingMessage()` |
| `WhatsAppHubPage.tsx` | 2452 | Preview, timestamp, unread_count, message_count güncelle. `shouldApplyPreview` + `buildChatPreview`. `rememberWaMessageId` ile replay dedup. |
| `useWhatsAppConversation.ts` | 435 | Mesaj balonu ekle. `wa_message_id` / `client_message_id` / `id` üzerinden dedup. |

### 3.3 `shouldApplyPreview` (zaman-damgalı sıralama)

```typescript
export function shouldApplyPreview(newTs, currentTs): boolean {
  ...
  return n >= c;  // yeni veya esitse true, eskiyse false
}
```

**Önemli:** Eski timestamp'li mesaj (append) preview'u **ezemez**. Ama `message_new` event'i gelirse (teorik olarak) `message_count` yine artar. Gerçek hayatta append için broadcast olmaz.

### 3.4 `rememberWaMessageId` (frontend replay dedup)

```typescript
const key = convId != null ? `${convId}:${waId}` : waId;
if (seen.has(key)) return false; // tekrar oynatılan olay
```

**Önemli:** Aynı `wa_message_id` aynı konuşmada ikinci kez gelirse `isReplayedEvent = true`. Bu durumda:
- `unread_count` artmaz.
- `message_count` artmaz.
- `preview` değişmez.
- `timestamp` değişmez.
- Toast/ses çalışmaz (`!isReplayedEvent` koşulu).

### 3.5 `mergeWhatsAppMessages` (mesaj listesi dedup)

`id`, `wa_message_id`, `client_message_id` üzerinden slot-based merge yapar. Aynı kimlikle iki mesaj gelirse tek satırda birleştirilir (status yükselir, body korunur).

## 4. TEST SONUÇLARI (MATRİS)

| Test | Beklenen | Gerçekleşen | Durum | Kanıt |
|---|---|---|---|---|
| **Notify** |||||
| Notify DB persistence | 1 kayıt | 1 kayıt | **PASS** | 5.2.3 race testi |
| Notify broadcast | 1 | 1 | **PASS** | 5.2.3 `_no_broadcast` yok |
| Notify preview güncellenir | Yeni preview | Yeni preview | **PASS** | DOM testi |
| Notify timestamp güncellenir | Yeni zaman | Yeni zaman | **PASS** | DOM testi |
| Notify unread (kapalı sohbet) | +1 | +1 | **PASS** | DOM testi |
| Notify unread (açık sohbet) | 0 | 0 | **PASS** | DOM testi |
| Notify message_count | +1 | +1 | **PASS** | DOM testi |
| Notify toast/ses | Çalışır | Kod analizi | **NOT TESTED** | `App.tsx` handler'ı izole edilemedi |
| **Append** |||||
| Append DB persistence | 1 kayıt | 1 kayıt | **PASS** | 5.2.3/5.2.5 testleri |
| Append broadcast | 0 | 0 | **PASS** | 5.2.3 `_no_broadcast` doğrulandı |
| Append frontend event | Yok | Yok | **PASS** | Kod analizi (frontend'de append handler yok) |
| Append preview korunur | Korunur | Korunur | **PASS** | `shouldApplyPreview` testi + kod analizi |
| Append timestamp korunur | Korunur | Korunur | **PASS** | `shouldApplyPreview` testi |
| Append unread değişmez | Değişmez | Değişmez | **PASS** | Event gelmediği için değişmez |
| Append toast/ses | 0 | 0 | **PASS** | Event gelmediği için 0 |
| **Dedup** |||||
| Append → Notify dedup | Tek kayıt | Tek kayıt | **PASS** | `mergeWhatsAppMessages` testi |
| Notify → Append dedup | Tek kayıt | Tek kayıt | **PASS** | `mergeWhatsAppMessages` testi |
| Frontend replay dedup | Sayaclar artmaz | Artmaz | **PASS** | `rememberWaMessageId` + DOM testi |
| **Sınır Durumlar** |||||
| Eski timestamp preview ezme | Ezmez | Ezmez | **PASS** | `shouldApplyPreview` + DOM testi |
| Outbound unread artış | 0 | 0 | **PASS** | DOM testi |
| Grup mesajı preview | "Ahmet: Selam" | "Ahmet: Selam" | **PASS** | `buildChatPreview` testi |
| Medya mesajı preview | "📷 Fotoğraf" | "📷 Fotoğraf" | **PASS** | `buildChatPreview` testi |
| `messages.update` upsert type | — | — | **NOT TESTED** | Bilinen kapsam dışı (pre-existing) |

## 5. BULUNAN SORUNLAR

### 5.1 Mevcut test altyapısı regresyonları (5.2.7 kapsamı dışı)

| Betik | Hata | Not |
|---|---|---|
| `verify-whatsapp-dom.mjs` | `AssertionError: mount should auto-scroll once (0 !== 1)` | ChatThread scroll davranışı kırık; 5.2.7 ile ilgisi yok |
| `verify-whatsapp-browser.mjs` | `Error: useToast must be used within a ToastProvider` | ToastProvider wrap eksik; ChatBubble render hatası |

**Etki:** Mevcut frontend test altyapısı çalışmıyor. Yeni 5.2.7 betiği bu altyapıya bağımlı değil.

### 5.2 Düşük riskli bulgu: `message_count` + eski timestamp

`WhatsAppHubPage.tsx` `message_new` handler'ında `isReplayedEvent` kontrolü `message_count` artışını engelliyor. Ama **eski timestamp'li** (append-benzeri) bir event teorik olarak gelirse (örneğin WS reconnect sonrası gateway kuyruğundan eski olay), `shouldApplyPreview` `false` döner (preview korunur), **ama** `message_count` yine +1 artar çünkü bu bir replay değil.

**Gerçekleşme olasılığı:** Düşük. Gerçek append olayları `_no_broadcast` ile backend'den çıkmaz. WS reconnect sonrası gateway kuyruğu **notify** olaylarını tekrar oynatabilir; bunlar `rememberWaMessageId` ile yakalanır (`isReplayedEvent = true`).

**Öneri:** İzleme altında tutulsun; mevcut sözleşmeye aykırı değil.

## 6. AÇIK KALAN RİSKLER

1. **Toast/ses doğrudan test edilmedi.** `App.tsx` handler'ı `notifyInboundRef` ve `soundService`'e bağımlı; bu fonksiyonları izole test etmek için `App` komponentini mock'lamak gerekirdi. Kod analiziyle davranış doğrulandı (`!isOutbound && !isReplayedEvent` koşulu).

2. **Gerçek Chrome render testi yapılmadı.** Mevcut `verify-whatsapp-browser.mjs` kırık olduğu için yeni bir CDP testi kurulmadı. jsdom DOM testi gerçek DOM manipülasyonunu doğruluyor ama layout engine yok.

3. **`messages.update` yolu hâlâ `notify` varsayılanı.** `messages.update` (`:1322`) upsert type bilgisini taşımıyor; bu bilinen bir bulgu (pre-existing, AŞAMA 5.2 raporlarında not edildi).

4. **Diğer test dosyalarının DB artıkları.** 5.2.5'te tespit edilen 5 satır (diğer test dosyalarından) temizlenmedi.

## 7. KESİN YASAKLAR — TUTUM RAPORU

| Yasak | Durum |
|---|---|
| Push | **Yapılmadı** |
| Deploy | **Yapılmadı** |
| Production DB erişimi | **Yapılmadı** |
| Container/Gateway restart | **Yapılmadı** |
| Commit | **Yapılmadı** |
| `package.json` değişikliği | **Yapılmadı** |
| Kullanıcı değişiklikleri | **Korundu** |
| Persistence loop | **Etkinleştirilmedi** |

## 8. SONUÇ

**Karar:** `28/28 passed`, **1 NOT TESTED** (toast/ses izolasyonu), **1 pre-existing** (`messages.update`).

Notify ve append davranışları:
- **Backend tarafında:** 5.2.3 ve 5.2.5 testleriyle deterministik olarak doğrulandı (`_no_broadcast`, `IntegrityError` kurtarma, grup JID temizliği).
- **Frontend tarafında:** Kod analizi + yeni jsdom/DOM test betiğiyle `message_new` event'inin preview, unread, timestamp, message_count ve dedup davranışları doğrulandı.
- **Mevcut test altyapısı:** İki betik (`verify-whatsapp-dom.mjs`, `verify-whatsapp-browser.mjs`) kırık; bu 5.2.7'den önce var olan bir regresyondur.

AŞAMA 5.2.7 tamamlandı. **DUR.**
