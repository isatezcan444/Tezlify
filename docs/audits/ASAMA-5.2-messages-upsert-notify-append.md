# AŞAMA 5.2 — `messages.upsert` NOTIFY / APPEND DAVRANIŞ DOĞRULUĞU

**Tür:** Kodlama + test + rapor
**Hedef branch:** `main`
**Başlangıç commit:** `3bf17bf` (AŞAMA 5.1)
**Production release:** `0b795ea` (değişmedi)
**Durum:** Kodlama ve test tamam. **Commit/push/deploy YAPILMADI.**

---

## 1. Başlangıç commit ve branch

| Alan | Değer |
| --- | --- |
| Branch | `main` |
| HEAD | `3bf17bf` — `feat(whatsapp): acknowledge gateway_connected instead of dropping it as unknown` |
| `origin/main` | `3bf17bf` (ahead 1) |
| Çalışma başı dirty | **78** |
| Staged | 0 |

## 2. Başlangıç dirty dosya sayısı

**78** giriş (28 tracked `M` + 50 untracked `??`). Bunların **hiçbiri** 5.2 tarafından üretilmedi; tümü kullanıcının önceki çalışmalarından geliyordu.

## 3. Önceki kullanıcı değişikliklerinin korunma durumu

Korundu. Hiçbir temizleme, stash, reset, checkout veya toplu formatlama yapılmadı.

**Dikkat edilmesi gereken nokta:** 5.2'nin dokunduğu dört dosyadan **üçü zaten kullanıcı değişikliği taşıyordu**. Bu yüzden `git diff --stat` o dosyalarda 5.2'den büyük görünür:

| Dosya | Toplam diff | 5.2'nin payı | Kalan (kullanıcı) |
| --- | --- | --- | --- |
| `whatsapp-gateway/src/session-manager.js` | 218 satır | ~41 | ~177 |
| `whatsapp-gateway/src/socket/socket-events.js` | 17 satır | 7 | 10 |
| `backend/app/main.py` | 19 satır | 17 | 2 (`metrics_check`) |
| `backend/app/services/whatsapp/orchestration/events.py` | 47 satır | 47 | 0 (5.1 commit'inden sonra temizdi) |

Toplam dirty: **78 → 82** (+`events.py` 5.1 commit'inden sonra temizdi; +2 yeni test dosyası; +1 rapor. `main.py`, `session-manager.js` ve `socket-events.js` zaten dirty oldukları için sayı değişmedi).

## 4. Gerçek event akışı ve tespit edilen sorun

### 4.1 Uçtan uca zincir (dosya:satır)

| # | Aşama | Yer |
| --- | --- | --- |
| 1 | Baileys `messages.upsert` | `whatsapp-gateway/src/socket/socket-events.js:608` |
| 2 | Gateway listener (`{ messages, type }` destructure) | aynı yer |
| 3 | Payload üretimi (`record` nesnesi) | `session-manager.js:2669-2699` |
| 4 | Sohbet dokunuşu (`_touchChat`) | `session-manager.js:2718`, tanım `3109` |
| 5 | Rozet artışı + `message_new` emit | `session-manager.js:2726-2741` |
| 6 | `publish()` → durable outbox | `whatsapp-gateway/src/events.js:310-384` |
| 7 | Backend köprüsü | `backend/app/main.py:698 _ingest_and_publish` |
| 8 | Ingestion | `backend/app/services/whatsapp/orchestration/events.py:883 _ingest_message` |
| 9 | Preview + rozet | `events.py:1096` / `events.py:1097-1102` |
| 10 | Broadcast | `backend/app/main.py:771` |
| 11 | Frontend handler | `frontend/src/pages/WhatsAppHubPage.tsx:2456, 2495` |

### 4.2 Cevaplar

**`type` gateway'de korunuyor mu?** Hayır. `socket-events.js:608` onu destructure ediyordu ama **yalnızca hata tanılamasında** kullanıyordu (`upsert_type: type || null`, satır 617). `_ingestUpsertMessage(msg, sock, id)` çağrısı `type`'ı **hiç geçirmiyordu** (satır 613).

**Backend'e ulaşıyor mu?** Hayır — hiç üretilmiyordu. Bu yüzden backend `append` ile `notify`'ı ayırt edemiyordu.

**Nerede kayboluyor?** `socket-events.js:613`, `_ingestUpsertMessage` çağrısında.

**`notify` ve `append` aynı işleme yoluna mı giriyor?** Evet, tamamen. Üç yerde ayrım yoktu:

1. `session-manager.js:2726-2733` — `append` için de `chat.unread_count += 1`
2. `session-manager.js:2735` — `append` için de `message_new` emit (canlı yayın)
3. `events.py:1097-1102` — `append` için de `conv.unread_count` artışı

**Deduplication nasıl çalışıyor?** İki katman:
- **Pre-flight:** `wa_message_id` ile SELECT; bulunursa `return event  # dedup` (`events.py:1004`)
- **Yarış:** `uq_msg_conv_wa_message_id` + `db.begin_nested()` savepoint (`events.py:1066-1087`); kaybeden taraf `IntegrityError` alır, `_recover_message_new_after_integrity_error` kazanan satırı yeniden seçer

Her iki yolda da satır **tek** kalıyordu. Ancak **her iki yol da `_no_broadcast` eklemiyordu** — yani `append` duplicate olsa bile yayınlanabiliyordu. 5.2 bunu kapattı.

**Append mesajları konuşmanın son mesajını yanlışlıkla güncelliyor mu?** Kısmen korunuyordu:
- Backend: `should_apply_last_message` (`preview_normalization.py:174`) `ts <= cur` durumunu **reddediyor** — eski timestamp önizlemeyi ezmiyordu. **Ama** `msg_dt = ... or utc_now_naive()` (`events.py:1095`) zaman damgası olmayan bir append'i "şimdi" sayıyor ve geçmişi listenin en üstüne taşıyordu.
- Gateway: `_touchChat` (`session-manager.js:3117-3119`) aynı `tsOlder` korumasına sahipti, ama zaman damgası yoksa `new Date().toISOString()` kullanıyordu — aynı hata.

**Append olayları frontend'de canlı mesaj etkisi oluşturuyor mu?** Evet — çünkü backend `message_new` yayınlıyordu ve `WhatsAppHubPage.tsx:2495` bu olayı toast/ses/rozet/önizleme için işliyor. Gateway tarafında `append`'in susturulması yeterli değildi; **backend'in de yayını kapatması** gerekiyordu.

**Outbound / group / broadcast / reaction / revoke / history-sync etkileniyor mu?** Hayır:
- **Outbound** (`fromMe`): rozet zaten artmıyordu; `append` guard'ı bu davranışı değiştirmedi.
- **Group** (`@g.us`): jid çözümü ve katılımcı adı ayrı; `append` bu yolu etkilemez.
- **Broadcast** (`status@broadcast`): `is_broadcast_only_jid` erken dönüşü her iki type için de aynı.
- **Reaction**: `reactionMessage` → `_ingestReactionMessage` (`session-manager.js:2506-2509`), `append` muhasebesinden **önce** ayrılıyor.
- **Revoke**: `protocolMessage` (`session-manager.js:2527-2540`) aynı şekilde erken dönüş.
- **History-sync**: `messaging-history.set` (`socket-events.js:900`) **ayrı bir yol**; `_internal_only: true` (`events.js:337`) ile backend'e hiç gönderilmiyor, yalnızca `sendLocal`. `append` ile karışmıyor.

### 4.3 Kritik mimari bulgu: `_internal_only` append için KULLANILAMAZ

Gateway'de `_internal_only: true` bayrağı `publish()` içinde `sendLocal(event); return;` yapıyor (`events.js:337-340`) — yani **olay backend'e hiç gitmiyor**. History-sync olayları için doğru, ama `append` için **yanlış** olurdu: append mesajları DB'ye yazılmalı.

Bu yüzden 5.2, `_internal_only`'yi yeniden kullanmadı. Bunun yerine **"persist et, yayınla-ma"** için yeni bir işaret (`_no_broadcast`) eklendi. `_skip` de kullanılamazdı: `events.py:2851-2864` `db.commit()`'i yalnızca `postgres + event_id` varsa çağırıyor, yani SQLite/test yolunda persist commit'siz kalırdı. `_no_broadcast` ise **commit'ten sonra** okunuyor (`main.py:771` öncesi).

## 5. Yapılan kod değişiklikleri

### 5.1 Gateway — `socket-events.js:613`

`type` artık `_ingestUpsertMessage`'a geçiyor:

```js
await manager._ingestUpsertMessage(msg, sock, id, { upsertType: type });
```

`messages.update` yolu (`socket-events.js:1322`) **değiştirilmedi** — `opts` verilmediği için varsayılan `'notify'` devreye giriyor ve mevcut retry/edit davranışı korunuyor.

### 5.2 Gateway — `session-manager.js`

**a) İmza + normalizasyon (`_ingestUpsertMessage`)**

```js
async _ingestUpsertMessage(msg, sock, sessionId, { upsertType = 'notify' } = {}) {
  ...
  const normalizedUpsertType = String(upsertType || 'notify').toLowerCase();
  const isAppend = normalizedUpsertType === 'append';
  if (normalizedUpsertType !== 'notify' && !isAppend) {
    logger.debug(..., 'Bilinmeyen messages.upsert type; notify gibi islendi');
  }
```

**b) Rozet koruması**

```js
if (chat && !fromMe && !isAppend) { ... chat.unread_count += 1 ... }
record.unread_count = chat?.unread_count ?? (fromMe || isAppend ? 0 : 1);
```

**c) Event sözleşmesi** — `message_new` **adı değişmedi**, yalnızca bir alan eklendi:

```js
emitEvent({ event: 'message_new', conversation_id: key, message: record,
            unread_count: record.unread_count, upsert_type: normalizedUpsertType });
```

**d) `_touchChat` — önizleme/damga koruması**

```js
_touchChat(session, jid, preview, timestamp, { append = false } = {}) {
  ...
  const nextPreview = append
    ? (existing.last_message_preview || '')
    : (preview && !tsOlder ? preview : existing.last_message_preview || '');
  const nextTs = append
    ? (existing.last_message_at || newTs)
    : (tsOlder ? existing.last_message_at : newTs);
```

Sohbet bilinmiyorsa yine de oluşturuluyor (`existing.last_message_at || newTs`), böylece mesajın duracak yeri oluyor.

### 5.3 Backend — `events.py`

**a) `upsert_type` tespiti ve bilinmeyen değer**

```python
upsert_type = str(event.get("upsert_type") or "notify").strip().lower()
if upsert_type not in ("notify", "append"):
    logger.warning("Bilinmeyen messages.upsert type=%r; notify gibi islendi ...", upsert_type, ...)
    upsert_type = "notify"
is_append = upsert_type == "append"
```

Bilinmeyen değer **sessizce yutulmuyor**: WARNING log'lanıyor, davranış `notify` (mesaj kaybolmasın).

**b) Önizleme ve rozet**

```python
if not (is_append and not msg.get("created_at")):
    apply_last_message(conv, msg_dt, summary)
if direction == MessageDirection.INBOUND and not is_append:
    ... conv.unread_count artışı ...
```

**c) `_no_broadcast` — üç dönüş yolunda**

| Yol | Satır (yaklaşık) | Ne yapıldı |
| --- | --- | --- |
| Normal persist | `1163-1172` | `event["_no_broadcast"] = True` |
| Pre-flight duplicate (`return event  # dedup`) | `1002-1009` | aynı |
| `IntegrityError` kurtarma | `1081-1090` | `recovered["_no_broadcast"] = True` |

**d) Dış webhook** — `whatsapp.message_received` append için tetiklenmiyor:

```python
if (evt == "message_new" and isinstance(result, dict)
        and result.get("message") and not result.get("_no_broadcast")):
```

### 5.4 Backend — `main.py`

`_ingest_and_publish` içinde, `_skip`/`_duplicate` dalından **sonra** ve `ws_manager.broadcast`'ten **önce**:

```python
if persisted.get("_no_broadcast") is True:
    ... ACK ...
    counters["skipped"] += 1
    logger.debug("[WS-GATEWAY] Persist edildi, yayinlanmadi (append): event=%s", ...)
    return
```

**ACK, NACK değil**: olay başarıyla işlendi, yeniden teslim edilmemeli. `counters["skipped"]` mevcut sayaç kullanıldı — log formatı değişmedi.

## 6. Notify / append davranış matrisi

| Davranış | `notify` | `append` | Kanıt |
| --- | --- | --- | --- |
| DB'ye yazılır | ✅ | ✅ | `test_append_is_persisted` |
| Canlı WS yayını | ✅ | ❌ | `test_append_is_marked_not_to_broadcast`, `test_bridge_acks_append_without_broadcast` |
| Rozet (unread) artışı | ✅ +1 | ❌ | `test_append_does_not_increase_unread` |
| `last_message_preview` | ✅ | ❌ (korunur) | `test_append_does_not_move_conversation_preview` |
| `last_message_at` | ✅ | ❌ (korunur) | aynı |
| Zaman damgasız append | — | ❌ önizlemeye dokunmaz | `test_append_without_timestamp_does_not_touch_preview` |
| Frontend toast/ses | ✅ | ❌ (yayın yok) | türetilmiş — tarayıcı testi yok |
| Dedup (tek satır) | ✅ | ✅ | `test_append_then_notify_does_not_duplicate`, `test_notify_then_append_does_not_duplicate` |
| ACK | ✅ | ✅ (ACK, NACK değil) | `test_bridge_acks_append_without_broadcast` |
| Dış webhook `whatsapp.message_received` | ✅ | ❌ | kod: `not result.get("_no_broadcast")` |
| Outbound | ✅ değişmedi | ✅ değişmedi | `test_outbound_notify_behaviour_unchanged` |
| Grup | ✅ değişmedi | ✅ değişmedi | `test_group_message_behaviour_unchanged` |
| Reaction / revoke | ✅ değişmedi | — | `test_reaction_event_is_unaffected` |
| Bilinmeyen type | — | — | `notify` gibi + WARNING; `test_unknown_upsert_type_falls_back_to_notify` |

## 7. Eklenen testler ve sonuçları

### 7.1 Backend — `backend/tests/test_whatsapp_upsert_append.py` (17 test, **17 PASS**)

Gerçek ingestion zinciri (`ingest_gateway_event`) + gerçek köprü (`gateway_websocket_endpoint`).

| # | Test | Ne doğruluyor |
| --- | --- | --- |
| 1 | `test_notify_is_persisted_and_broadcastable` | notify: persist + yayın açık |
| 2 | `test_append_is_persisted` | append: DB'de satır var |
| 3 | `test_append_is_marked_not_to_broadcast` | append: `_no_broadcast` |
| 4 | `test_append_then_notify_does_not_duplicate` | append→notify: tek satır |
| 5 | `test_notify_then_append_does_not_duplicate` | notify→append: tek satır |
| 6 | `test_append_does_not_move_conversation_preview` | eski append önizlemeyi ezmiyor |
| 7 | `test_append_does_not_increase_unread` | rozet artmıyor |
| 8 | `test_append_without_timestamp_does_not_touch_preview` | zamansız append "şimdi" sayılmıyor |
| 9 | `test_outbound_notify_behaviour_unchanged` | outbound değişmedi |
| 10 | `test_group_message_behaviour_unchanged` | grup değişmedi |
| 11 | `test_reaction_event_is_unaffected` | reaction yolu `_no_broadcast` taşımıyor |
| 12 | `test_malformed_payload_is_skipped_safely` | bozuk jid → `None` (exception değil) |
| 13 | `test_unknown_upsert_type_falls_back_to_notify` | bilinmeyen type yutulmuyor |
| 14 | `test_skip_semantics_preserved_for_broadcast_jid` | broadcast jid hâlâ atlanıyor |
| 15 | `test_tenant_isolation_preserved` | iki tenant ayrı sohbetlerde |
| 16 | `test_bridge_acks_append_without_broadcast` | köprü: ACK var, broadcast yok |
| 17 | `test_bridge_still_broadcasts_notify` | köprü: notify yayını korunuyor |

### 7.2 Gateway — `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` (13 assertion, **13 PASS**, exit 0)

| # | Kontrol |
| --- | --- |
| 1 | `notify` → `message_new` + `upsert_type='notify'` |
| 2 | `notify` rozeti artırıyor |
| 3 | `append` de `message_new` üretiyor (backend persist edebilsin) |
| 4 | `append` rozeti **artırmıyor** |
| 5 | `append` mevcut rozeti raporluyor (artmamış değer) |
| 6 | `append` `last_message_preview`'i oynatmıyor |
| 7 | `append` `last_message_at`'i oynatmıyor |
| 8 | bilinmeyen type `append` sayılmıyor |
| 9 | bilinmeyen type rozeti artırıyor (notify fallback) |
| 10 | **uçtan uca:** `socket-events` `type=append`'i geçiriyor |
| 11 | **uçtan uca:** soket üzerinden append rozeti artırmıyor |
| 12 | **uçtan uca:** `socket-events` `type=notify`'i geçiriyor |
| 13 | **uçtan uca:** soket üzerinden notify rozeti artırıyor |

> **Not:** Bu script `package.json`'daki `test` zincirine **eklenmedi**, çünkü `whatsapp-gateway/package.json` kullanıcı değişikliği taşıyor ve o dosyaya dokunmak yasaktı. Süitte otomatik koşmaz; elle `node scripts/test-upsert-notify-append.mjs` ile çalıştırılır.

### 7.3 İlgili backend testleri — 124 PASS

`test_whatsapp_upsert_append.py`, `test_whatsapp_orchestration_events.py`, `test_whatsapp_gateway_ack.py`, `test_whatsapp_faz7_identity_sync.py`, `test_whatsapp_characterization.py`, `test_whatsapp_tenant_isolation.py`, `test_whatsapp_event_contract_parity.py`, `test_whatsapp_phase2_a_gateway_behavior.py` → **124 passed, 0 failed**.

## 8. Tam WhatsApp test sonucu

```
venv/bin/python -m pytest backend/tests/ -p no:randomly -q -k "whatsapp"
→ 943 passed, 4 skipped, 1260 deselected, 218 warnings in 103.34s
→ EXIT=0
```

**Regresyon yok — kanıt:** AŞAMA 5.1.2'de aynı komut `926 passed` vermişti. 926 + 17 (bu aşamada eklenen testler) = **943**. Tam eşleşme.

**DB ve fixture:** `backend.app.core.database.AsyncSessionLocal`, yani `./tezlify.db` (conftest'in `run_db_migrations` fixture'ı ile aynı dosya). Her yeni test kendi benzersiz jid'ini kullanır ve sonunda kendi satırlarını siler.

**Önceden var olan hatalar:** İlk koşuda `62 error` görüldü — **hiçbiri kod hatası değil**. Tamamı `FileExistsError: [Errno 17] EEXIST: mkdir '.../pytest-of-root'`, yani bilinen sandbox `tmp_path` artefaktı (sandbox'ın `mkdir` sarmalayıcısı `exist_ok=True`'yu onurlandırmıyor). `rm -rf "${TMPDIR}pytest-of-root" "${TMPDIR}pytest-of-unknown"` sonrası aynı komut **943 passed, 0 error** verdi. Bu, 5.2'nin nedeni değil; ortamın bilinen davranışı.

## 9. Frontend doğrulamaları

| Kontrol | Komut | Sonuç |
| --- | --- | --- |
| Tip kontrolü | `npx tsc --noEmit` | **EXIT=0**, 0 hata |
| Build | `npm run build` | **EXIT=0**, `✓ built in 10.13s` |

Frontend kodu **değişmedi**. `append` yayınlanmadığı için `WhatsAppHubPage.tsx:2495` işleyicisi hiç tetiklenmiyor; toast/ses/rozet yolu kendiliğinden susuyor.

## 10. Bilinen riskler ve açık kalan işler

1. **Gateway kodu değişti — deploy edilebilirlik daraldı.** 5.2'nin en büyük operasyonel sonucu bu (bkz. §11). `--no-gateway` ile deploy etmek artık **mümkün değil**, çünkü gateway ağacı farklı.
2. **`messages.update` yolu hâlâ `notify` varsayılanı kullanıyor** (`socket-events.js:1322`). Retry/decrypt/edit ile gelen bir mesaj rozeti artırabilir. Bu **pre-existing** bir davranış; 5.2 kapsamı dışında bırakıldı ama artık belgelenmiş durumda. Ayrı bir aşama konusu.
3. **Uçtan uca tarayıcı doğrulaması yok.** Toast/ses/preview davranışı yalnızca "yayın gelmiyor" üzerinden türetildi; gerçek bir tarayıcı oturumunda ölçülmedi. Bu iddia **doğrulanmış** değil, **türetilmiş** olarak işaretlenmelidir.
4. **`_no_broadcast` yeni bir sözleşme alanı.** Gelecekte `message_new`'i tüketen yeni bir yol (ör. yeni bir webhook, yeni bir WS istemcisi) bu alanı **onurlandırmalı**. `events.py` ve `main.py` dışında okuyan yok; kontrat testi (`test_whatsapp_event_contract_parity.py`) olay **adlarını** karşılaştırıyor, alanları değil — yani yeni bir tüketici sessizce eklenebilir.
5. **Gateway test script'i `npm test` zincirinde değil** (bkz. §7.2 notu). Otomatik koruma yok.
6. **`append` + sohbet yoksa** sohbet boş önizlemeyle oluşturuluyor. Kabul edilebilir (mesajın duracak yeri olmalı) ama ilk görünüm boş satır olabilir; history-sync `conversation_updated` ile doldurur.
7. **`unread_count` alanı append'te mevcut rozeti taşıyor** (artmamış değer). Backend append'te bu alanı hiç okumuyor (`if ... and not is_append`), yani zararsız; ama alanın semantiği "bu olayın rozete katkısı" değil "olay anındaki rozet".

## 11. Production deploy edilebilirlik değerlendirmesi

**Durum: 5.2 production'a taşınamaz — en az iki ayrı engel var.**

| Engel | Kanıt |
| --- | --- |
| **main ile release ayrışması** | `git diff --stat main..release/backend-only-seq-safety -- backend/ whatsapp-gateway/src/` = **17 dosya, +2049/−1516**. merge-base `a1ca60f`. main'de 32, release'te 6 ayrı commit. |
| **main'de 4.27 + 4.28 yok** | epoch-reset (`memory_persistence.py:452`) ve `_bulk_chunks` (`sync.py:110`) yalnızca release branch'te. |
| **5.2 gateway'i değiştirdi** | `--no-gateway` guard'ı `git diff $PREV_DEPLOYED $TARGET -- whatsapp-gateway/` sessiz olmalı. 5.2 `socket-events.js` + `session-manager.js` değiştiriyor ⇒ guard **reddeder**. |
| **Deploy edilen gateway commit'i** | `git merge-base --is-ancestor 20c88bb main` → **HAYIR** (ayrı ağaç). |

`--no-gateway` koruması **aşılmadı** ve aşılmaya çalışılmadı.

**Doğru taşıma yolu (öneri, bu aşamada yapılmadı):**
1. 5.2 değişikliklerini `release/backend-only-seq-safety` üzerine uygula.
2. Gateway **restart penceresi** planla: gateway image değişecek, yani A6 RAM deposu (`rawMessagesByChat` retry penceresi + sohbet başına mesaj geçmişi) **kaybolacak**. Bu, 4.20'deki "gateway recreation readiness" analizinin konusu.
3. Persistence loop **OFF** olduğu için (4.27 fix'i deploy edilmiş ama loop uyandırılmamış) RAM kaybı kalıcı veri kaybı **değil** — yalnızca retry penceresi ve gateway-side geçmiş kaybı.
4. Sıra: backend persistence → `/health.whatsapp_memory_persistence` doğrula → gateway (invariant 3.6).

## 12. Değiştirilen dosyaların tam listesi

### Değişen (4)

| Dosya | 5.2 payı | Ne |
| --- | --- | --- |
| `whatsapp-gateway/src/socket/socket-events.js` | +6/−1 | `messages.upsert` `type`'ı `_ingestUpsertMessage`'a geçiriyor |
| `whatsapp-gateway/src/session-manager.js` | ~+33/−8 | `upsertType` parametresi, rozet guard'ı, `upsert_type` alanı, `_touchChat` append koruması |
| `backend/app/services/whatsapp/orchestration/events.py` | +44/−3 | `upsert_type` tespiti, önizleme/rozet guard'ları, üç yolda `_no_broadcast`, webhook koşulu |
| `backend/app/main.py` | +17/−0 | `_ingest_and_publish` içinde `_no_broadcast` dalı (ACK, broadcast yok) |

### Yeni (3)

| Dosya | Satır | Ne |
| --- | --- | --- |
| `backend/tests/test_whatsapp_upsert_append.py` | 574 | 17 test: gerçek ingestion + köprü katmanı |
| `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` | 156 | 13 assertion: gateway + uçtan uca soket |
| `docs/audits/ASAMA-5.2-messages-upsert-notify-append.md` | bu dosya | Rapor |

### Dokunulmayanlar

`whatsapp-gateway/package.json` (kullanıcı değişikliği), `.workbuddy-ai/memory/*` (kullanıcı), kullanıcının diğer 74 dirty dosyası, DB şeması, Baileys sürümü, feature flag'ler, dedup anahtarları, event adları.

---

## Özet

`messages.upsert` `type` alanı gateway'de yalnızca log'a yazılıyordu; `append` (geçmiş) ile `notify` (canlı) tamamen aynı hattı paylaşıyordu. Sonuç: geçmiş mesajlar rozeti artırıyor, sohbet önizlemesini oynatıyor ve canlı yayın üretiyordu.

5.2 bu ayrımı üç katmanda kurdu: gateway `type`'ı geçiriyor ve append'te rozet/önizleme koruması uyguluyor; backend append'i **persist ediyor ama yayınlamıyor** (`_no_broadcast`, ACK-safe); köprü katmanı ACK verip broadcast'i atlıyor. Dedup, outbound, grup, reaction/revoke ve history-sync yolları değişmedi.

**Doğrulama:** 17 backend + 13 gateway assertion PASS · ilgili backend 124 PASS · tam WhatsApp paketi **943 passed / 0 failed / 0 error** (5.1.2'nin 926'sı + 17) · gateway süiti **170 ok / 0 not ok / exit 0** · `tsc` ve `build` EXIT=0.

**Production:** hiçbir işlem yapılmadı. 5.2 gateway kodunu değiştirdiği için `--no-gateway` ile taşınamaz; taşıma ayrı bir aşamada gateway restart penceresiyle planlanmalı.
