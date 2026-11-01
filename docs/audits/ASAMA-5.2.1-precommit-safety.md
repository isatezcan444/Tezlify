# AŞAMA 5.2.1 — COMMIT ÖNCESİ GÜVENLİK VE SÖZLEŞME DENETİMİ

**Tür:** Denetim (kodlama yok — kanıtlanmış kritik kusur bulunmadı)
**Branch:** `main`
**Başlangıç commit:** `3bf17bf`
**Denetim kapsamı:** AŞAMA 5.2 çalışma ağacı değişiklikleri
**Durum:** Commit/push/deploy YAPILMADI. `git add` kullanılmadı.

---

## 0. Baseline

| Alan | Değer |
| --- | --- |
| HEAD | `3bf17bf` (değişmedi) |
| Branch | `main` |
| Dirty | **82** (başlangıç 78 + 4) |
| Staged | **0** |
| `origin/main` | `3bf17bf` (ahead 1) |
| Probe/geçici dosya repoda | **0** (tümü `/tmp`'de) |

---

## 1. `_no_broadcast` alanını üreten ve tüketen bütün kod yolları

Tam repo taraması (`grep -rn "_no_broadcast"`), yorumlar ve testler hariç:

### Üreticiler — 3

| Yer | Yol | Ne zaman |
| --- | --- | --- |
| `events.py:1008` | Pre-flight duplicate (`return event  # dedup`) | `append` + satır zaten var |
| `events.py:1107` | `IntegrityError` kurtarma (`recovered[...]`) | `append` + yarış kaybedildi |
| `events.py:1203` | Normal persist (fonksiyon sonu) | `append` + yeni satır |

Üçü de `if is_append:` koşulu altında. `notify` hiçbir yolda bu alanı **üretmiyor** — doğrulandı (`test_notify_is_persisted_and_broadcastable`, `test_outbound_notify_behaviour_unchanged`).

### Tüketiciler — 2

| Yer | Davranış |
| --- | --- |
| `main.py:771` | `_skip`/`_duplicate` dalından **sonra**, `ws_manager.broadcast`'ten **önce**: ACK gönderir, `counters["skipped"] += 1`, `logger.debug`, `return` |
| `events.py:2957` | Dış webhook koşuluna `and not result.get("_no_broadcast")` — `whatsapp.message_received` append için tetiklenmez |

**Başka üretici veya tüketici yok.** Frontend, gateway, başka bir servis bu alanı okumuyor (okuması da gerekmiyor: alan backend içinde tüketilip yayına hiç çıkmıyor).

### Sıra güvenliği

`main.py`'deki kontrol sırası:

```
persisted is None            → NACK (veya _skip varsa ACK)
_duplicate / _skip           → ACK, broadcast yok
_no_broadcast                → ACK, broadcast yok        ← 5.2
ws_manager.broadcast         → yayın
```

Bir olay hem `_duplicate` hem `_no_broadcast` taşırsa **`_duplicate` dalı kazanır** ve sonuç aynıdır (ACK, yayın yok). Çakışma zararsız.

---

## 2. Append: DB'ye yazılıyor + ACK alıyor + broadcast edilmiyor

| İddia | Kanıt |
| --- | --- |
| DB'ye yazılıyor | `test_append_is_persisted` — `_message_row(wa_id)` satırı buluyor, `body == "Merhaba"` |
| ACK alıyor | `test_bridge_acks_append_without_broadcast` — `socket.sent == [{"type": "gateway_event_ack", ...}]` |
| Broadcast edilmiyor | aynı test — `broadcast.assert_not_awaited()` |
| `notify` hâlâ yayınlanıyor | `test_bridge_still_broadcasts_notify` — `broadcast.assert_awaited_once()` |

Bu testler **gerçek** `gateway_websocket_endpoint`'i çalıştırıyor (`FakeGatewaySocket` + gerçek `_ingest_and_publish`), mock'lanmış bir kopyasını değil.

---

## 3. Üç dönüş yolu — ayrı ayrı

### 3.1 Normal persist — **DOĞRULANDI**

`test_append_is_persisted`, `test_append_is_marked_not_to_broadcast`.
Yol: yeni satır → `apply_last_message` (guard'lı) → `db.commit()` → `_no_broadcast` → ACK.

### 3.2 Pre-flight duplicate — **DOĞRULANDI**

`test_notify_then_append_does_not_duplicate` (`_no_broadcast is True`).
Ek olarak **canlı deney** (`/tmp/probe_dedup_append.py`, repoya dahil değil): `notify` ile Mart 2025 mesajı → aynı `wa_id` ile `created_at` **taşımayan** `append`:

```
ONCE  preview='ICERIK-notify'  at=2025-03-01 12:00:00
append sonucu: _no_broadcast=True
SONRA preview='ICERIK-notify'  at=2025-03-01 12:00:00
>>> Onizleme korundu (beklenen davranis)
```

**Denetim sırasında şüphelendiğim bir kusur bu deneyle ÇÜRÜTÜLDÜ.** Pre-flight dedup yolunda (`events.py:999`) `apply_last_message` çağrısı append guard'ı taşımıyor; `msg_dt` fallback'i `utc_now_naive()` olsaydı geçmiş mesaj önizlemeyi en üste taşırdı. Ama gerçek fallback zinciri `... or canonical.external_timestamp or canonical.created_at or utc_now_naive()` ve `canonical.external_timestamp` mevcut satırın kendi damgasına eşit olduğu için `should_apply_last_message` `ts <= cur` → **False** dönüyor. Kusur yok; guard gereksiz.

### 3.3 `IntegrityError` kurtarma — **DOĞRULANAMADI (ortam kısıtı)**

Kod yolu mevcut (hunk `+1104,4`): `if is_append: recovered["_no_broadcast"] = True`.

Deneysel zorlama denendi (`/tmp/probe_integrity_race.py`, repoya dahil değil): 6 tekrar, her birinde aynı `(jid, wa_message_id)` için iki **eşzamanlı** `append` ingest'i (`asyncio.gather`), `logger.info("... concurrent ingest race ...")` yakalanarak yol ayırt edildi.

```
tekrar=6  yaris_yakalandi=0  no_broadcast_dogru=0  eksik=0
>>> IntegrityError yolu bu ortamda TETIKLENEMEDI (SQLite yazma kilidi serilestiriyor)
```

**Neden tetiklenemedi:** SQLite tek yazıcıya izin veriyor; iki `AsyncSessionLocal` yazma kilidinde serileşiyor ve ikinci istek pre-flight'ta kazanan satırı **görüyor**, yani `IntegrityError` hiç oluşmuyor. Pre-flight'ı yapay olarak atlatmak da gerçek senaryoyu temsil etmiyor (pre-flight hem `wa_id` hem `client_message_id` ile `or_` filtresi kullanıyor, `events.py:943-955`).

**Sonuç:** Bu yol **davranışsal olarak doğrulanmamış** kabul edilmelidir. Doğru doğrulama ortamı PostgreSQL'dir (gerçek eşzamanlı yazma). Bu bir kod kusuru değil, test ortamı kısıtıdır; commit'i engellemez ama raporda açık kalır.

---

## 4. Webhook ve diğer event tüketicileri

`message_new` üreten/tüketen tüm yollar tarandı:

| Tüketici | Append'ten etkileniyor mu |
| --- | --- |
| `main.py:771` `ws_manager.broadcast` | ✅ Susturuldu (`_no_broadcast`) |
| `events.py:2961` `WebhookDispatcher.emit("whatsapp.message_received")` | ✅ Susturuldu (koşulda `not result.get("_no_broadcast")`) |
| `events.py:2899` `_connect_metrics.record_stage_once(STAGE_FIRST_MESSAGE)` | ⚠️ **Append de "ilk mesaj" sayılır** — aşağıdaki gözlem |
| `events.py:2966` `schedule_initial_sync` | ❌ Yalnızca `session_sync_completed`/`session_connected` |
| Frontend `WhatsAppHubPage.tsx:2495`, `useWhatsAppConversation.ts:435`, `App.tsx:227`, `whatsappApi.ts:1359` | ✅ Yayın gelmediği için hiç tetiklenmez |
| REST `GET /messages` | ✅ Mesaj DB'de olduğu için görünür — istenen davranış |

`whatsapp.message_received` olayının **tek** üreticisi `events.py:2963`'tür; başka bir yerden emit edilmiyor (tam repo taraması).

### Gözlem G-1 (düşük öncelik)

`_connect_metrics.record_stage_once(STAGE_FIRST_MESSAGE)` append olayında da çalışır. Yani bağlantı kurulduktan sonra gelen ilk şey bir `append` ise, "ilk mesaj" aşaması ölçümü canlı mesajdan önce dolar. Etkisi **yalnızca telemetri**; veri veya kullanıcı davranışı etkilenmez. Commit'i engellemez.

### Gözlem G-2 (düşük öncelik)

`main.py`'de `_no_broadcast` dalı `counters["skipped"]` sayacını artırıyor. Log formatı değişmedi (bilinçli tercih), ama operatör `/health` çıktısında "skipped" görünce olayın **düştüğünü** sanabilir. Oysa olay persist edildi, yalnızca yayınlanmadı. Ayrı bir sayaç (`suppressed`) daha doğru olurdu; log formatını değiştirmemek için 5.2'de tercih edilmedi.

---

## 5. Bilinmeyen upsert type davranışı

| Katman | Davranış | Kanıt |
| --- | --- | --- |
| Gateway | `normalizedUpsertType` bilinmeyen değeri **olduğu gibi** `upsert_type` alanına yazar; `isAppend=false` | `test-upsert-notify-append.mjs`: "unknown type is not treated as append" + "unknown type increments unread (notify fallback)" |
| Backend | `notify` olarak işler **ve** `logger.warning` basar — sessiz yutma yok | `test_unknown_upsert_type_falls_back_to_notify` |

Sessiz kabul **yok**: her iki katmanda da değer görünür kalıyor (gateway `upsert_type` alanında, backend WARNING log'unda).

---

## 6. `messages.update` yolu — kapsam dışı, değiştirilmedi

`socket-events.js:1322`:

```js
await manager._ingestUpsertMessage(msg, sock, id);
```

`opts` verilmediği için varsayılan `upsertType = 'notify'` devreye giriyor. Yani **retry / decrypt / edit** ile gelen bir mesaj canlı sayılır ve rozeti artırabilir.

**Bu 5.2'nin getirdiği bir davranış değil** — 5.2 öncesinde de aynıydı (o zaman `type` hiç okunmuyordu, dolayısıyla her şey `notify` gibiydi). 5.2 bu yolu **bilinçli olarak değiştirmedi**; kapsam `messages.upsert` idi ve genişletmek "mevcut çalışan davranışı gereksiz refactor" yasağına girerdi.

**Karar:** dokunulmadı. Ayrı bir aşama konusu olarak kaydedildi (retry/edit gerçekten rozet artırmalı mı? — ürün kararı gerekir).

---

## 7. Gateway test script'inin otomatik zincire eklenmesi — değerlendirme

### Mevcut durum

`whatsapp-gateway/package.json` **kullanıcı değişikliği taşıyor**. Diff:

```
"test": "... node scripts/test-bulk-jids-scope.mjs && node scripts/test-bulk-seq-pagination.mjs &&
         node scripts/test-bulk-seq-pagination-guarantees.mjs && node scripts/test-realtime-history-identity.mjs ..."
```

Yani kullanıcı `test` zincirine **iki pagination script'i eklemiş**. Dosya zaten "test zincirine script ekleme" amacıyla kullanılıyor.

### Eklenebilir mi?

**Teknik olarak evet, güvenli:**

- Değişiklik tek satırın sonuna ` && node scripts/test-upsert-notify-append.mjs` eklemekten ibaret.
- Kullanıcının eklediği iki script adı **korunur** (satır içinde kalır).
- Zincir 38 → 39 komut olur; sıra korunur.
- Script `npm test` içinde **hiç çalıştırılmadı** — yani eklenmesi mevcut 38 script'in davranışını etkilemez.

### Yapıldı mı?

**Hayır.** Talimat "`package.json` kullanıcı değişikliği taşıdığı için izinsiz değiştirme" diyor. Değiştirilmedi.

### Sonuç ve risk

Yeni test şu anda **otomatik koruma sağlamıyor**. Birisi `append` plumbing'ini bozarsa `npm test` bunu yakalamaz; yalnızca elle `node scripts/test-upsert-notify-append.mjs` çalıştırılırsa yakalanır.

**Öneri (onay gerekir):** commit sonrası ayrı bir adımda tek satırlık ekleme yapılabilir. Bu, 5.2 commit'inin kapsamını `package.json`'a genişletmek anlamına gelir ve kullanıcı dosyasına dokunur — bu yüzden açık onay ister.

---

## 8. Gerçek tarayıcı E2E eksikliği — açıkça

**5.2'nin frontend iddiaları ölçülmedi, türetildi.**

| İddia | Durum |
| --- | --- |
| `append` toast üretmez | **Türetilmiş** — backend broadcast etmiyor, dolayısıyla `WhatsAppHubPage.tsx:2495` işleyicisi hiç çalışmıyor |
| `append` ses çalmaz | **Türetilmiş** — aynı sebep |
| `append` rozeti artırmaz | **Kısmen ölçüldü** — DB `unread_count` test edildi; tarayıcıdaki görsel rozet değil |
| `append` mesajı sohbette görünür | **Türetilmiş** — DB'de satır var, `GET /messages` döndürür; tarayıcıda doğrulanmadı |

**Yapılan:** `tsc --noEmit` EXIT=0, `npm run build` EXIT=0. Bunlar tip ve derleme doğrulamasıdır; **davranış doğrulaması değildir**.

**Yapılmayan:** Gerçek bir tarayıcı oturumunda `append` içeren bir gateway akışı tetiklenip toast/ses/rozet/preview gözlemlenmedi. Böyle bir test için canlı WhatsApp bağlantısı veya gateway'in `messages.upsert type=append` üretmesini sağlayan bir harness gerekir.

Bu eksiklik commit'i engellemez (backend sözleşmesi ve gateway davranışı ayrı ayrı test edildi), ama **"uçtan uca doğrulandı" iddiasında bulunulamaz.**

---

## 9. 5.2 değişen satırlarının kullanıcı diff'lerinden ayrıştırılması

`git diff -U0` hunk başlıkları kullanılarak kesin ayrım yapıldı. 5.2'nin dokunduğu her hunk biliniyor; kullanıcının hunk'ları ayrı.

### Hunk sayıları

| Dosya | Toplam hunk | 5.2 | Kullanıcı |
| --- | --- | --- | --- |
| `backend/app/main.py` | 3 | 1 (`+771,17`) | 2 (`metrics_check`) |
| `backend/app/services/whatsapp/orchestration/events.py` | 6 | **6** | 0 |
| `whatsapp-gateway/src/session-manager.js` | 22 | 9 | 13 |
| `whatsapp-gateway/src/socket/socket-events.js` | 5 | 1 (`613`) | 4 |
| **Toplam** | **36** | **17** | **19** |

### 5.2'nin dokunduğu hunk'lar (tam liste)

**`main.py`**
- `@@ -770,0 +771,17 @@` — `_no_broadcast` dalı

**`events.py`** (tamamı 5.2)
- `@@ -893,0 +894,12 @@` — `upsert_type` tespiti + WARNING
- `@@ -991,0 +1004,5 @@` — pre-flight dedup `_no_broadcast`
- `@@ -1086,0 +1104,4 @@` — IntegrityError kurtarma `_no_broadcast`
- `@@ -1096,2 +1117,11 @@` — önizleme + rozet guard'ları
- `@@ -1167,0 +1198,6 @@` — normal persist `_no_broadcast`
- `@@ -2917 +2953,6 @@` — webhook koşulu

**`session-manager.js`**
- `@@ -2322 +2468 @@` — `_ingestUpsertMessage` imzası
- `@@ -2328,0 +2475,15 @@` — `upsertType` normalizasyonu
- `@@ -2563,4 +2724,2 @@` — `_touchChat` çağrısı + rozet guard'ı
- `@@ -2574 +2733 @@` — `record.unread_count`
- `@@ -2584 +2743,4 @@` — `emitEvent` + `upsert_type`
- `@@ -2943,0 +3105,5 @@` — `_touchChat` yorum
- `@@ -2949 +3115 @@` — `_touchChat` imzası
- `@@ -2962 +3128 @@` — `nextPreview`
- `@@ -2971,2 +3137,10 @@` — `nextTs`

**`socket-events.js`**
- `@@ -613 +613,6 @@` — `{ upsertType: type }`

### Sayısal ayrım

| Dosya | Ekleme | Silme | 5.2'nin sildiği |
| --- | --- | --- | --- |
| `main.py` | 19 | 0 | 0 |
| `events.py` | 44 | 3 | 3 (hepsi 5.2) |
| `session-manager.js` | 196 | 22 | **7** |
| `socket-events.js` | 11 | 6 | **1** |
| **Toplam** | **270** | **31** | **11** |

5.2'nin sildiği 11 satırın tamamı kendi değiştirdiği blokların içinde:

- `session-manager.js`: `_ingestUpsertMessage(msg, sock, sessionId) {`, `this._touchChat(session, key, chatPreview, record.created_at);`, `if (chat && !fromMe) {`, `record.unread_count = chat?.unread_count ?? (fromMe ? 0 : 1);`, `_touchChat(session, jid, preview, timestamp) {`, `const nextPreview = ...`, `const nextTs = ...`
- `socket-events.js`: `await manager._ingestUpsertMessage(msg, sock, id);`

Geriye kalan 20 silme satırı (`listAllMessages`, `chatMsgs.push(record)`, `2000` sınırları, `outList`, `import { createSessionStore, ... }`, vb.) **kullanıcının** kendi değişikliklerine aittir ve 5.2 tarafından dokunulmamıştır.

---

## 10. Başlangıçtaki 78 kullanıcı dirty girdisinin korunması

| Ölçüm | Değer |
| --- | --- |
| Başlangıç dirty | 78 |
| Şimdiki dirty | **82** |
| Fark | +4 |
| Farkın kaynağı | `events.py` (5.1 commit'inden sonra temizdi, 5.2 ile dirty oldu) + `test_whatsapp_upsert_append.py` + `test-upsert-notify-append.mjs` + `ASAMA-5.2.1` raporu |

Kullanıcının 78 girdisi **hiçbiri silinmedi**. Üç dosyada (`main.py`, `session-manager.js`, `socket-events.js`) kullanıcı değişiklikleri zaten mevcuttu ve üzerine eklendi; §9'daki hunk analizi bunların korunduğunu gösteriyor.

Yapılmayanlar: `git add`, `git add -A`, `git add .`, stash, reset, checkout, rebase, commit, push, deploy, branch değişikliği, production DB/container işlemi, persistence loop aktivasyonu.

---

## Denetim testleri

| Komut | Sonuç |
| --- | --- |
| `pytest backend/tests/test_whatsapp_upsert_append.py` | **17 passed** (1.30 s) |
| `pytest ... test_whatsapp_upsert_append.py test_whatsapp_event_contract_parity.py` | **29 passed** (1.74 s) |
| `node scripts/test-upsert-notify-append.mjs` | **13/13 PASS**, exit 0 |
| `python /tmp/probe_dedup_append.py` | Önizleme korundu — şüpheli kusur **çürütüldü** |
| `python /tmp/probe_integrity_race.py` | 6 tekrar, yarış **tetiklenemedi** (SQLite) |

DB: `backend.app.core.database.AsyncSessionLocal` (`./tezlify.db`), conftest `run_db_migrations` ile aynı dosya. Her test kendi benzersiz jid'ini kullanır ve kendi satırlarını siler.

---

## Bulgular özeti

| # | Bulgu | Önem | Commit'i engeller mi |
| --- | --- | --- | --- |
| B-1 | `IntegrityError` kurtarma yolu davranışsal olarak doğrulanamadı (SQLite serileştiriyor) | Orta | **Hayır** — kod yolu mevcut ve okunabilir; PostgreSQL'de doğrulanmalı |
| B-2 | Gateway test script'i `npm test` zincirinde değil | Orta | **Hayır** — elle çalıştırıldı, 13/13 geçti |
| B-3 | Gerçek tarayıcı E2E yok; toast/ses iddiaları türetilmiş | Orta | **Hayır** — backend/gateway ayrı ayrı doğrulandı |
| G-1 | `STAGE_FIRST_MESSAGE` append ile de tetikleniyor | Düşük | Hayır — yalnızca telemetri |
| G-2 | `_no_broadcast` `counters["skipped"]` kullanıyor (operatör "düştü" sanabilir) | Düşük | Hayır — log formatı korunmak istendi |
| G-3 | `messages.update` yolu `notify` varsayılanı kullanıyor (retry/edit rozeti artırır) | Düşük | Hayır — **pre-existing**, kapsam dışı |
| G-4 | Pre-flight dedup yolunda `apply_last_message` append guard'ı taşımıyor | **Yok** | Hayır — `canonical.external_timestamp` fallback'i sayesinde davranış doğru; deneyle çürütüldü |

**Kanıtlanmış kritik kusur: YOK.** Denetim sırasında bir kusur şüphesi (G-4) doğdu ve canlı deneyle çürütüldü; kod değişikliği yapılmadı.

---

## KARAR

# **COMMIT'E HAZIR**

**Gerekçe:**
- `_no_broadcast` sözleşmesinin tüm üretici (3) ve tüketici (2) yolları biliniyor; başka okuyan yok.
- Append: DB'ye yazılıyor, ACK alıyor, broadcast edilmiyor — gerçek köprü endpoint'i üzerinden test edildi.
- Normal persist ve pre-flight duplicate yolları doğrulandı; IntegrityError yolu ortam kısıtı nedeniyle doğrulanamadı ve bu **açıkça kaydedildi**.
- Webhook ve frontend tüketicileri append'i canlı mesaj olarak işlemiyor.
- Bilinmeyen type sessizce yutulmuyor.
- `messages.update` kapsam dışı bırakıldı, değiştirilmedi.
- Kullanıcının 78 dirty girdisi ve 19 hunk'ı korundu; 5.2'nin 17 hunk'ı ayrıştırıldı.
- 17 backend + 13 gateway assertion + 12 sözleşme testi geçiyor.

**Commit sonrası önerilen ayrı adımlar (onay gerekir):**
1. `package.json` `test` zincirine `node scripts/test-upsert-notify-append.mjs` ekle (B-2).
2. PostgreSQL üzerinde `IntegrityError` yarış testi (B-1).
3. Gerçek tarayıcı E2E ile toast/ses/rozet doğrulaması (B-3).
4. `messages.update` retry/edit davranışı için ürün kararı (G-3).

**Duruldu. Commit/push/deploy için ayrı onay bekleniyor.**
