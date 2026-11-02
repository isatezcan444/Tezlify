# AŞAMA 5.3.8 — WHATSAPP EVENT CONTRACT VE UPDATE SEMANTİĞİ DENETİMİ

**Tarih:** 2026-11-02
**Çalışma türü:** SALT OKUNUR TEKNİK DENETİM
**HEAD:** `3ac26a9ffdd1a4738de915be255ee65c6b5be314`
**Branch:** `release/backend-only-seq-safety`
**Önceki aşama:** 5.3.7 — PASS

---

## 1. Başlangıç branch/HEAD/status

| Alan | Değer |
|---|---|
| Worktree | `/private/tmp/tz429-release` (yeniden oluşturuldu — önceki worktree geçici dizin temizliği sırasında silinmiş) |
| Branch | `release/backend-only-seq-safety` |
| HEAD | `3ac26a9ffdd1a4738de915be255ee65c6b5be314` |
| `git status --short` | 0 satır (temiz) |
| Main worktree HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` |
| Main dirty count | 85 |

Not: `/private/tmp/tz429-release` worktree'si önceki oturumdan sonra `/private/tmp` temizliği nedeniyle silinmişti. `git worktree prune` + `git worktree add` ile aynı branch ve commit'te yeniden oluşturuldu. HEAD ve branch değeri değişmedi.

---

## 2. Gateway `messages.update` üretim zinciri

### 2.1 Baileys event kaynağı

Baileys `sock.ev.on('messages.update', ...)` olayı, mevcut mesajların durum/metadata değişiklikleri için üretilir. Üç tip güncelleme taşır:

1. **Status güncellemesi** (`update.status`): SENT → DELIVERED → READ gibi ACK durumu ilerlemeleri.
2. **Message içeriği** (`update.message`): Retry decryption, edit, veya protokol mesajları.
3. **Push name** (`update.pushName`): Gönderen adı güncellemesi.

### 2.2 Gateway event listener

**Dosya:** `whatsapp-gateway/src/socket/socket-events.js:1229-1249`

```javascript
sock.ev.on('messages.update', async (updates) => {
    if (ignoreStaleSocketEvent('messages.update')) return;
    for (const { key, update } of updates || []) {
      if (update?.status) {
        manager._applyMessageAck(id, key, update);       // ← status yolu
      }
      if (update?.message) {
        try {
          const msg = {
            key,
            message: update.message,
            messageTimestamp: update.messageTimestamp || Math.floor(Date.now() / 1000),
            pushName: update.pushName,
          };
          await manager._ingestUpsertMessage(msg, sock, id);  // ← İÇERİK yolu — upsertType YOK
        } catch (uErr) {
          logger.debug({ uErr, key }, 'Failed to ingest updated message on retry/edit');
        }
      }
    }
  });
```

### 2.3 İki ayrı kol

`messages.update` olayı gateway'de **iki ayrı işleme koluna** ayrılır:

| Kol | Tetiklenme | Çağrılan metod | Event üretimi |
|---|---|---|---|
| **Status kol** | `update.status` var | `_applyMessageAck` (session-manager.js:2763) | `message_status_updated` event |
| **İçerik kol** | `update.message` var | `_ingestUpsertMessage` (session-manager.js:2310) | `message_new` event |

**Kritik bulgu:** İçerik kolundaki `_ingestUpsertMessage` çağrısı `upsertType` parametresi **vermeden** çağrılır (satır 1243). Bu, metodun imzasındaki varsayılan değere düşer:

```javascript
async _ingestUpsertMessage(msg, sock, sessionId, { upsertType = 'notify' } = {}) {
```

**Sonuç:** `messages.update` içeriği her zaman `notify` gibi işlenir. `append` (geçmiş/senkron) veya `replace` semantiği uygulanmaz.

### 2.4 `_ingestUpsertMessage` içinde upsertType etkisi

**Dosya:** `whatsapp-gateway/src/session-manager.js:2310-2603`

`upsertType` parametresi şu davranışları etkiler:

| Davranış | `notify` | `append` | Varsayılan (verilmezse) |
|---|---|---|---|
| `isAppend` değişkeni | `false` | `true` | `false` (notify varsayılır) |
| `_touchChat`'te `append` bayrağı | `false` — preview/timestamp güncellenir | `true` — preview/timestamp OYNATILMAZ | `false` — notify gibi |
| Unread count artışı | INBOUND + `!fromMe` → artırılır | ARTIRILMAZ | ARTIRILIR (notify gibi) |
| `emitEvent` payload | `upsert_type: 'notify'` | `upsert_type: 'append'` | `upsert_type: 'notify'` |

### 2.5 Status kolunun ayrışı

`_applyMessageAck` (session-manager.js:2763-2801) **tamamen ayrı** bir yoldur:
- Mevcut mesaj kaydını `wa_message_id` ile bulur.
- `ACK_RANK` ve `ACK_ORDER` ile monotonik status ilerlemesi sağlar.
- `FAILED` terminal durumunu özel olarak ele alır.
- `message_status_updated` event üretir — `message_new` DEĞİL.
- Yeni mesaj satırı oluşturmaz, unread count'a dokunmaz, preview'e dokunmaz.

**Bu ayrışma doğrudur ve tasarım gereğidir.**

---

## 3. Backend `messages.update` tüketim zinciri

### 3.1 Event dispatch

Backend, gateway'den gelen event'leri `events.py:2847-2882` aralığındaki dispatch tablosuna göre yönlendirir:

```python
if evt == "message_new":
    result = await ingest_message(db, event)
elif evt in ("conversation_updated", "chat_update", "conversation_read",
             "message_status_updated", "presence_updated"):
    result = await map_conversation_event(db, event)
```

**Status kol** → `message_status_updated` → `map_conversation_event` (events.py:2017, 2174)
**İçerik kol** → `message_new` → `ingest_message` (events.py:893)

### 3.2 `message_new` işleyicisinde upsert_type kullanımı

**Dosya:** `backend/app/services/whatsapp/orchestration/events.py:893-1204`

Backend, gateway'den gelen `upsert_type` alanını okur:

```python
upsert_type = str(event.get("upsert_type") or "notify").strip().lower()
if upsert_type not in ("notify", "append"):
    logger.warning(...)
    upsert_type = "notify"
is_append = upsert_type == "append"
```

`is_append` aşağıdaki davranışları kontrol eder:

| Nokta | Satır | `is_append=True` davranışı |
|---|---|---|
| Dedup (mevcut kayıt) | 1007-1008 | `_no_broadcast = True` — yeniden yayın yapılmaz |
| IntegrityError kurtarma | 1106-1107 | `_no_broadcast = True` — kazanan satır yayınlanmaz |
| `apply_last_message` | 1122-1123 | Zaman damgası YOKSA preview'e dokunulmaz |
| Unread count | 1124 | ARTIRILMAZ |
| Yeni kayıt (non-dedup) | 1202-1203 | `_no_broadcast = True` — persist edilir ama yayınlanmaz |

### 3.3 `message_status_updated` işleyicisi

**Dosya:** `events.py:2174-2263`

Bu kol tamamen ayrıdır:
- `wa_message_id` ile mevcut mesajı bulur.
- `advance_message_status` ile monotonik güncelleme yapar.
- `FAILED` özel kol.
- Kayıt yoksa ACK defer edilir (`defer_status_update`).
- `message_new` üretmez, unread count'a dokunmaz, preview'e dokunmaz.
- Campaign/MessageLog sync yapar.

### 3.4 Cevap: "Bir mesajın status/metadata güncellemesi geldiğinde sistem bunu yeni mesaj gibi mi işliyor?"

**Kısmen evet — içerik kolunda.**

`messages.update` olayı `update.message` taşıdığında (retry decryption, edit), gateway bu içeriği `_ingestUpsertMessage`'a **`upsertType` vermeden** gönderir. Bu, `notify` (canlı yeni mesaj) semantiği ile işlenir.

Ancak **idempotency korunur**:
- `_ingestUpsertMessage` satır 2442-2456'da `wa_message_id` ile mevcut kayıt arar.
- Aynı `wa_message_id` bulunduğunda, içerik değişikliği yoksa `return null` (satır 2456).
- İçerik değişikliği varsa (retry decryption, edit), **mevcut kayıt güncellenir** (satır 970-999).
- Backend'de de aynı `wa_message_id` ile dedup yapılır (satır 946-1009).

**Fakat şu yan etkiler oluşur:**
1. **Unread count artışı:** `isAppend = false` olduğu için, INBOUND mesajlarda unread count artırılır (satır 2588-2592 gateway, satır 1124-1132 backend). Oysa bu bir GÜNCELLEME, yeni mesaj değil.
2. **Preview/timestamp güncellemesi:** `_touchChat` `append = false` ile çağrılır, yani preview ve `last_message_at` güncellenir. Bu, daha eski bir mesajın retry decryption'ı geldiğinde sohbeti en üste taşıyabilir — ancak `should_apply_last_message` (preview_normalization.py:174-191) `ts <= cur` durumunu reddettiği için, zaman damgası daha eskiyse preview güncellenmez.
3. **Live broadcast:** `message_new` event'i üretilir ve `_no_broadcast` işaretlenmez. Frontend bu mesajı canlı bildirim olarak alır — oysa bu bir güncelleme.

**Status kolunda sorun yok:** `update.status` taşıyan güncellemeler `_applyMessageAck` → `message_status_updated` yolundan gider, hiçbir zaman yeni mesaj gibi işlenmez.

---

## 4. Notify/append semantik karşılaştırması

| Özellik | `notify` (canlı) | `append` (geçmiş) | `messages.update` içeriği |
|---|---|---|---|
| Gateway `_ingestUpsertMessage` çağrısı | `{ upsertType: type }` (socket-events.js:560) | `{ upsertType: type }` (socket-events.js:560) | `upsertType` YOK (socket-events.js:1243) → varsayılan `notify` |
| Gateway `isAppend` | `false` | `true` | `false` (notify varsayılır) |
| Gateway unread count | Artırılır | Artırılmaz | **Artırılır** (yan etki) |
| Gateway `_touchChat` | Preview + ts güncellenir | Preview + ts OYNATILMAZ | **Preview + ts güncellenir** (yan etki) |
| Gateway event payload | `upsert_type: 'notify'` | `upsert_type: 'append'` | `upsert_type: 'notify'` (varsayılan) |
| Backend `is_append` | `false` | `true` | `false` |
| Backend unread count | Artırılır | Artırılmaz | **Artırılır** (yan etki) |
| Backend `apply_last_message` | Çağrılır | `ts` yoksa çağrılmaz | **Çağrılır** (yan etki — ama `should_apply_last_message` eski ts'i reddeder) |
| Backend broadcast | Yapılır | `_no_broadcast` | **Yapılır** (yan etki) |

---

## 5. Senaryo matrisi

| # | Senaryo | Gerçek kod yolu | Mevcut davranış | Beklenen | Fark | Risk | Kanıt |
|---|---|---|---|---|---|---|---|
| S1 | İlk gelen mesaj | `messages.upsert` → `_ingestUpsertMessage(..., { upsertType: 'notify' })` → `message_new` → DB INSERT | Yeni mesaj olarak kaydedilir, unread artar, preview güncellenir, broadcast edilir | Aynısı | Yok | Yok | socket-events.js:550-560; events.py:893-1204 |
| S2 | Eski mesajın status güncellemesi | `messages.update` → `update.status` → `_applyMessageAck` → `message_status_updated` | Mevcut kaydın status'u monotonik olarak güncellenir, yeni satır oluşmaz, unread/preview dokunulmaz | Aynısı | Yok | Yok | socket-events.js:1232-1233; session-manager.js:2763-2801; events.py:2174-2263 |
| S3 | Mesaj edit/retry decryption | `messages.update` → `update.message` → `_ingestUpsertMessage(msg, sock, id)` (upsertType yok) → `message_new` | Mevcut kayıt bulunur (wa_message_id dedup), içeriği güncellenir, **unread artırılır**, **preview güncellenmeye çalışılır**, **broadcast edilir** | Mevcut kayıt güncellenir, unread ARTIRILMAMALI, preview eskiyse OYNATILMAMALI, broadcast KISMEN gerekli (içerik değişti) | Unread artışı yanlış; broadcast gereksiz olabilir | P2 | socket-events.js:1235-1243; session-manager.js:2310, 2442-2456, 2575, 2588-2592; events.py:898, 1124, 1202 |
| S4 | Mesaj revoke/delete | `messages.update` → `update.message` → `_ingestUpsertMessage` → `protocolMessage.type === 0` | Hedef mesaj `is_deleted = true`, `body = ''` olarak işaretlenir, `return null` — event üretmez | Aynısı | Yok | Yok | session-manager.js:2384-2396 |
| S5 | Duplicate update | `messages.update` → `update.message` → `_ingestUpsertMessage` → mevcut kayıt, içerik değişikliği yok → `return null` | İkinci kez yeni mesaj oluşturmaz | Aynısı | Yok | Yok | session-manager.js:2446-2456 |
| S6 | Offline iken gelen update | Bağlantı kopması → reconnect → history sync → `messages.upsert` type `append` | Append olarak işlenir, unread/preview/broadcast yapılmaz | Aynısı | Yok | Yok | socket-events.js:550-560; events.py:1007-1008, 1122-1124, 1202-1203 |
| S7 | Append history | `messages.upsert` type `append` | Unread ve preview değerlerini artırmaz | Aynısı | Yok | Yok | socket-events.js:560; session-manager.js:2324, 2588; events.py:1007, 1122, 1124, 1202 |
| S8 | Notify (canlı) | `messages.upsert` type `notify` | Gerçek yeni mesaj davranışı korunur | Aynısı | Yok | Yok | socket-events.js:560; events.py:893-1204 |

---

## 6. `session_deleted` gateway üreticisi

### 6.1 Üretici araması

Gateway kaynak kodunda `session_deleted` event literal'i **üretici olarak hiç bulunamadı**.

Aranan desen: `event: 'session_deleted'` veya `event: "session_deleted"` — sıfır sonuç.

Bulunan referanslar yalnızca **tüketici/koruma** amaçlı:

| Dosya | Satır | Bağlam | Tür |
|---|---|---|---|
| `session-manager.js` | 464 | `_emit` içinde: session map'te yoksa event düşürülür, AMA `session_deleted` prefix'i istisna olarak bırakılır | Koruma (gelecek için) |
| `events.js` | 313 | `publish` içinde: session map'te yoksa olay düşürülür, AMA `isDelete` kontrolü ile `session_deleted` prefix istisna | Koruma (gelecek için) |
| `socket-events.js` | 270 | `diagnostic('open_ignored_session_deleted', ...)` — sadece log | Diagnostik |
| `socket-events.js` | 347 | `diagnostic('open_committed_aborted_session_deleted', ...)` — sadece log | Diagnostik |

### 6.2 Gateway'in ürettiği session olayları

Gateway şu session olaylarını üretir:

| Event adı | Üretim yeri | Koşul |
|---|---|---|
| `session_connecting` | socket-events.js:245 | QR eşleştirme başladığında |
| `session_connected` | socket-events.js:386 | `connection.open` |
| `session_disconnected` | socket-events.js:503 | `isLoggedOut \|\| isBanned` — `reason: 'BANNED' \|\| 'LOGGED_OUT'` taşır |
| `session_disconnected` | session-manager.js:821 | `logoutSession` çağrıldığında |
| `session_qr_updated` | socket-events.js:213 | QR yenilendiğinde |
| `session_pairing_code_updated` | socket-events.js:227, 235 | Pairing code üretildiğinde |
| `session_sync_started` | socket-events.js:446 | History sync başladığında |
| `session_sync_progress` | socket-events.js:1112 | Her history chunk |
| `session_sync_completed` | socket-events.js:118, 430 | History sync tamamlandığında |
| `session_notifications_received` | socket-events.js:178 | Bildirim alındığında |

### 6.3 `deleteSession` metodu

**Dosya:** `session-manager.js:825-889`

`deleteSession` metodu:
1. `session._deleted = true` işaretler
2. `lifecycle.invalidate()` çağırır
3. `leaseCoordinator.releaseLease(session)` çağırır
4. `sock.logout()` — WhatsApp tarafından companion device'ı kaldırır (best-effort)
5. Tüm listener'ları kaldırır
6. Socket'i kapatır (`sock.end()`)
7. Timer'ları temizler
8. `authRepository.clearAuth(id)` + `setSessionActive(id, false)`
9. `sessions.delete(id)` — session'ı map'ten kaldırır
10. `mediaStore.clearSessionMedia(id)`
11. Auth dizinini siler (`fs.rmSync`)

**Hiçbir event üretmez.** `session_disconnected` bile üretmez (logoutSession üretir ama deleteSession üretmez).

### 6.4 `logoutSession` metodu

**Dosya:** `session-manager.js:772-823`

`logoutSession` metodu `session_disconnected` event üretir (satır 821):
```javascript
this._emit({ event: 'session_disconnected', session_id: id, session_name: session.session_name });
```

Ancak `deleteSession` bu event'i üretmez.

---

## 7. `session_deleted` backend tüketicisi

### 7.1 Backend event dispatch

Backend dispatch tablosu (events.py:2847-2882):

```python
if evt == "message_new":
    result = await ingest_message(db, event)
elif evt in ("conversation_updated", "chat_update", "conversation_read",
             "message_status_updated", "presence_updated"):
    result = await map_conversation_event(db, event)
elif evt == "contact_synced":
    ...
elif evt == "connection_error" or str(evt).startswith("session_"):
    result = await map_session_event(db, event)
```

**Eğer `session_deleted` event'i üretilseydi**, `str(evt).startswith("session_")` kuralı nedeniyle `map_session_event`'e düşerdi.

### 7.2 `map_session_event` içinde `session_deleted` işleyişi

**Dosya:** events.py:2266-2486

`map_session_event` içindeki event işleme dalları:

```python
if evt == "connection_error" and err:     # 2445
elif evt == "session_connecting":         # 2450
elif evt == "session_connected":          # 2454
elif evt == "session_disconnected":       # 2470
elif evt == "session_sync_started":       # 2487
elif evt == "session_sync_completed":     # 2487
```

**`session_deleted` için dal YOK.** Eğer bu event üretilseydi, `map_session_event` içine girerdi ama hiçbir dal eşleşmezdi. Event owner ve session row çözülürdü (2441-2443), ama sonra herhangi bir DB değişikliği yapılmadan `return event` ile geri dönerdi — bu, event'in broadcast edilmesi anlamına gelir, ama session row'unun durumu değişmezdi.

### 7.3 Backend'de session silme

Backend'de session silme **REST API** üzerinden yapılır:

**Dosya:** `backend/app/api/v1/endpoints/whatsapp.py:367-386`
```python
@router.delete("/sessions/{session_id}")
async def delete_session(...):
    result = await whatsapp_service.delete_session(db, current_user.id, session_id)
```

**Dosya:** `orchestration/sessions.py:1265-1301`
```python
async def delete_session(db, user_id, session_id, on_cancel_sync):
    row = await _get_session_or_404(db, user_id, session_id)
    await gw.delete_session(row.gateway_id)   # gateway'e REST DELETE
    purged = await purge_whatsapp_data(db, user_id, session_id=row.id)
    await db.delete(row)
    await db.commit()
```

Silme işlemi:
1. Gateway'e HTTP DELETE gönderir → gateway `deleteSession` çağrılır (event üretmez)
2. Backend `purge_whatsapp_data` ile mesajları, sohbetleri ve orphan contact'ları siler
3. Session row'unu siler
4. Commit eder

**Hiçbir WebSocket event üretilmez.** Frontend, silme işleminin tamamlandığını yalnızca REST API yanıtından bilir.

### 7.4 Parity testindeki kayıt

**Dosya:** `backend/tests/test_whatsapp_event_contract_parity.py:71-78`

```python
# Frontend expectations with no producer anywhere in the system.
# `session_deleted` has no emitter in the gateway and no handler in the backend.
# WHATSAPP_FORENSIC_AUDIT.md records this as S-3 WITHDRAWN: the backend owns
# deletion (`sessions.delete_session` -> gateway `delete_session` ->
# `purge_whatsapp_data`), so emitting the event would only produce an
# "unknown event" error. The frontend entry is therefore vestigial, not a bug —
# it is listed here so the gap is visible rather than silently tolerated.
FRONTEND_UNPRODUCED_EVENTS = frozenset({"session_deleted"})
```

---

## 8. Session yaşam döngüsü analizi

| # | Senaryo | Gateway davranışı | Backend DB | Frontend state | Tutarlılık |
|---|---|---|---|---|---|
| L1 | Normal logout (Bağlantıyı Kes) | `logoutSession` → `session_disconnected` event | `map_session_event` → row.status = DISCONNECTED, is_phone_online = false | `session_disconnected` event alır, `fetchSessions(true)` çağrılır | Tutarlı |
| L2 | Session silme (Oturumu Sil) | `deleteSession` → event ÜRETMEZ | REST DELETE → `gw.delete_session` → `purge_whatsapp_data` → `db.delete(row)` | REST yanıt alır, `setSessions(prev => prev.filter(...))` ile yerel state günceller | **Kısmen tutarlı** — REST yanıtı gecikirse veya frontend yeniden bağlanırsa stale state görülebilir |
| L3 | Baileys auth state silinmesi | `sock.logout()` → `connection.update` → `isLoggedOut` → `session_disconnected` | `map_session_event` → DISCONNECTED | `session_disconnected` event alır | Tutarlı |
| L4 | Gateway process kapanması | Socket kapanır, event üretilemez | Gateway reconnect bekler | WebSocket kopar, `tezlify:ws_connected` ile reconnect | Tutarlı (eventual) |
| L5 | Beklenmedik bağlantı kopması | `connection.update` → `isLoggedOut=false` → retry attempts | Timeout sonrası session DISCONNECTED kalır | `session_disconnected` (eğer event gelirse) veya reconnect ile refresh | Tutarlı (eventual) |
| L6 | Yeniden QR eşleştirme | Yeni session oluşturulur, eski session `session_disconnected` alır | Eski row DISCONNECTED, yeni row oluşturulur | `session_disconnected` → `session_connecting` → `session_connected` | Tutarlı |
| L7 | Aynı kullanıcıya yeni session | `createSession` → yeni gateway_id | Yeni `WhatsAppSession` row | Yeni session listede görünür | Tutarlı |
| L8 | Eski session'dan geç gelen event | `_emit` içinde `sessions.has(gwSid)` kontrolü → session yoksa event düşürülür (`session_deleted` prefix hariç) | Event gelirse `map_session_event` → row bulunamazsa `EventOwnerUnresolved` → orphan queue | Event görülmez | **Risk yok** — eski session event'leri düşürülür |

---

## 9. Event contract tablosu

| Event | Üretici | Payload | Backend handler | DB etkisi | Frontend etkisi | Durum |
|---|---|---|---|---|---|---|
| `messages.upsert` (type=notify) | Baileys → socket-events.js:550-560 | `{ messages, type: 'notify' }` → `_ingestUpsertMessage(..., { upsertType: 'notify' })` | `message_new` → `ingest_message` (events.py:893) | INSERT Message, update Conversation preview/unread | Canlı bildirim, chat-list güncelleme | ÇALIŞIYOR |
| `messages.upsert` (type=append) | Baileys → socket-events.js:550-560 | `{ messages, type: 'append' }` → `_ingestUpsertMessage(..., { upsertType: 'append' })` | `message_new` → `ingest_message` (events.py:893) | INSERT/upsert Message, `_no_broadcast=True` | Yayınlanmaz (ACK edilir) | ÇALIŞIYOR |
| `messages.update` (status) | Baileys → socket-events.js:1232-1233 | `{ key, update: { status } }` → `_applyMessageAck` | `message_status_updated` → `map_conversation_event` (events.py:2174) | UPDATE Message.status (monotonik) | Status badge güncelleme | ÇALIŞIYOR |
| `messages.update` (message) | Baileys → socket-events.js:1235-1243 | `{ key, update: { message } }` → `_ingestUpsertMessage(...)` — **upsertType yok** | `message_new` → `ingest_message` (events.py:893) — **is_append=false** | Upsert Message, unread artırılır, preview güncellenir, broadcast | Canlı bildirim (güncelleme gibi değil) | **DESIGN GAP** |
| `session_connected` | socket-events.js:386 | `{ event, session_id, session_name, phone, self_jid, self_lid }` | `map_session_event` (events.py:2454) | UPDATE WhatsAppSession.status = CONNECTED | `fetchSessions`, banner güncelleme | ÇALIŞIYOR |
| `session_disconnected` | socket-events.js:503, session-manager.js:821 | `{ event, session_id, session_name, reason: 'BANNED'\|\|'LOGGED_OUT' }` | `map_session_event` (events.py:2470) | UPDATE WhatsAppSession.status = DISCONNECTED | `fetchSessions`, modal state | ÇALIŞIYOR |
| `session_deleted` | **ÜRETİCİ YOK** | — | `map_session_event` (events.py:2868 — `session_` prefix) — **dal yok** | — | `LIVE_SESSION_EVENTS` set'te var ama asla tetiklenmez | **VESTIGIAL** |
| `message_status_updated` | `_applyMessageAck` (session-manager.js:2792) | `{ event, conversation_id, wa_message_id, status, timestamp }` | `map_conversation_event` (events.py:2174) | UPDATE Message.status + Campaign/MessageLog sync | Status badge güncelleme | ÇALIŞIYOR |
| `gateway_connected` | events.js (gateway) | `{ event, sessions_count }` — tenant yok | `_ACKNOWLEDGED_IGNORE_EVENTS` (events.py:131) | Yok | Yok (frontend'de değil) | ÇALIŞIYOR (bilinçli yutma) |

---

## 10. Test ve kanıt matrisi

| Alan | Dosya | Test adı | Test edilen davranış | Test edilmeyen kritik davranış | Bağlantı seviyesi |
|---|---|---|---|---|---|
| `messages.update` → `upsertType` | — | — | **TEST YOK** | `messages.update` içeriğinin `notify` gibi işlenmesi ve yan etkileri (unread, preview, broadcast) | **YOK** |
| Notify/append parity | `test-upsert-notify-append.mjs` | 4 kontrol | `append` rozet artırmaz, preview oynatmaz; `notify` artırır; bilinmeyen tip notify'a düşer | `messages.update` yolundan gelen içerik için aynı parity | Kısmi — `messages.upsert` yoluyla sınırlı |
| Notify/append parity (backend) | `test_whatsapp_upsert_append.py` | 14 test | append dedup, append broadcast yok, append unread yok, append preview yok, notify broadcast var, notify unread var, bilinmeyen tip notify | `messages.update` içeriğinden gelen `message_new` event'inde `upsert_type` alanının `notify` olması ve yan etkileri | Kısmi — `messages.upsert` yolundan gelen event'lerle sınırlı |
| Message idempotency | `test-phase2-fixes.mjs:227-249` | 2 kontrol | Aynı `wa_message_id` ile ikinci `_ingestUpsertMessage` kayıt oluşturmaz | `messages.update` içeriğinden gelen dedup davranışı | Kısmi |
| Message status update | `test_whatsapp_live.py:1120` | 1 test | `message_status_updated` status'u ilerletir | Status kolunun içerik kolundan ayrışması | İyi |
| Message status update (phase6) | `test_whatsapp_phase6_scenarios.py` | 3 test | SENT→DELIVERED, FAILED terminal, DELIVERED→READ | — | İyi |
| Edit/revoke | `test-message-reactions.mjs:85` | 1 kontrol | Revoke mesajı `is_deleted=true` işaretler | Edit mesajının yan etkileri (unread, preview, broadcast) | Kısmi |
| `session_deleted` producer | `test_whatsapp_event_contract_parity.py` | 5 test | Gateway→backend→frontend event set parity; `session_deleted` frontend'de var ama gateway'de üretici yok | — | İyi — statik analiz |
| Backend event dispatch | `test_whatsapp_event_contract_parity.py` | 3 test | Gateway event'lerinin backend'de karşılığı var; backend'in kabul ettikleri gateway'de var; frontend'in bekledikleri iletiliyor | — | İyi — statik analiz |
| Session DB deletion | — | — | **TEST YOK** | `delete_session` sonrası DB row silinmesi, purge verileri, frontend state | **YOK** |
| Frontend stale session cleanup | — | — | **TEST YOK** | Silme sonrası frontend'in stale session göstermemesi | **YOK** |
| Reconnect sonrası eski event | `test_whatsapp_event_contract_parity.py:283` | 1 test | Bilinmeyen event fail-closed ERROR üretir | Eski session event'lerinin düşürülmesi | Kısmi |

---

## 11. Risk sınıflandırması

### R-1: `messages.update` içeriği `notify` gibi işlenir — DESIGN GAP

**Sınıf:** P2
**Dosya:** `whatsapp-gateway/src/socket/socket-events.js:1243`
**Tetiklenme:** Bir mesajın retry decryption, edit veya benzeri metadata güncellemesi geldiğinde.
**Etkilenen davranış:**
- Unread count yanlış artabilir (INBOUND mesaj için).
- Preview/`last_message_at` güncellenmeye çalışılır (ama `should_apply_last_message` eski ts'i reddeder).
- Live broadcast üretilir — frontend güncellemeyi yeni mesaj gibi gösterir.

**Etki alanı:** Mesaj bütünlüğü, unread sayaç, chat preview.
**Mevcut koruma:**
- `wa_message_id` dedup mevcut kaydı bulur ve günceller (yeni satır oluşturmaz).
- `should_apply_last_message` eski zaman damgalı güncellemelerin preview'i ezmesini engeller.
- Duplicate (içerik değişikliği yok) `return null` ile düşürülür.
- Backend IntegrityError kurtarma mekanizması çift kaydı engeller.

**Kanıt:** socket-events.js:1243 `upsertType` vermeden çağrır; session-manager.js:2310 varsayılan `notify`; events.py:898 `upsert_type` varsayılan `notify`.
**Güven seviyesi:** Yüksek — kod yolu doğrudan izlendi, varsayılan değer kanıtlandı.

**Azaltıcı faktörler:**
- `messages.update` içeriği taşıyan olaylar nadirdir (retry decryption, edit).
- `should_apply_last_message` zaman damgası kontrolü en kritik yan etkiyi (preview ezmesi) engeller.
- `wa_message_id` dedup çift kayıt riskini ortadan kaldırır.
- Unread count artışı yalnızca INBOUND + `!fromMe` durumunda olur.

### R-2: `session_deleted` event'inin üreticisi yok — VESTIGIAL

**Sınıf:** P3
**Dosya:** `frontend/src/features/whatsapp/api/whatsappApi.ts:566` (LIVE_SESSION_EVENTS set'inde)
**Tetiklenme:** Asla — event üretilmez.
**Etkilenen davranış:** Frontend `session_deleted` için listener kaydeder ama asla tetiklenmez.
**Etki alanı:** Yok (ölü kod).
**Mevcut koruma:**
- Parity testi (`test_whatsapp_event_contract_parity.py`) bu boşluğu açıkça `FRONTEND_UNPRODUCED_EVENTS` altında listeler ve izler.
- Frontend comment (whatsappApi.ts:558-562) durumu belgeler.
- Backend `session_` prefix kuralı event gelirse `map_session_event`'e yönlendirir ama dal yok — sessizce broadcast edilir.

**Kanıt:** `git grep "event.*session_deleted"` gateway src'de sıfır üretici; parity testi 78. satırda kayıtlı.
**Güven seviyesi:** Yüksek.

### R-3: `deleteSession` event üretmez — DESIGN GAP

**Sınıf:** P2
**Dosya:** `whatsapp-gateway/src/session-manager.js:825-889`
**Tetiklenme:** Kullanıcı "Oturumu Sil" butonuna tıkladığında.
**Etkilenen davranış:** Gateway session'ı siler ama backend'e veya frontend'e WebSocket üzerinden haber vermez. Backend REST API yanıtı ile frontend'e bildirir.
**Etki alanı:** Session tutarlılığı, frontend state.
**Mevcut koruma:**
- Backend `delete_session` REST endpoint'i hem gateway'i siler hem DB row'u siler hem `purge_whatsapp_data` çağırır.
- Frontend REST yanıt alınca `setSessions(prev => prev.filter(...))` ile yerel state günceller.
- Frontend `setConversations([])`, `setMessagesMap({})` ile sohbetleri temizler.
- `loadConversations(true, true)` ile server'dan yeniden yükler.

**Risk:** REST çağrısı ile WebSocket event arasında yarış varsa, veya frontend bağlantısı kopmuşsa, silme sonrası stale session görülebilir. Ancak frontend REST yanıtına güveniyor, WebSocket event'ine değil — bu nedenle risk düşük.

**Kanıt:** session-manager.js:882 `sessions.delete(id)` event üretmez; whatsapp.py:367 REST endpoint; WhatsAppHubPage.tsx:3497-3505 frontend handling.
**Güven seviyesi:** Yüksek.

### R-4: `deleteSession` `session_disconnected` üretmez — DESIGN GAP (alt-bulgu)

**Sınıf:** P3
**Dosya:** `whatsapp-gateway/src/session-manager.js:825-889`
**Tetiklenme:** `deleteSession` çağrıldığında.
**Etkilenen davranış:** `logoutSession` `session_disconnected` üretir ama `deleteSession` üretmez. Backend `gw.delete_session(row.gateway_id)` çağrısı sırasında gateway socket'i zaten kapanmıştır ve hiçbir event gelmez.
**Etki alanı:** Diğer bağlı frontend istemcileri (multi-tab) session'ın silindiğini WebSocket üzerinden öğrenemez.
**Mevcut koruma:** Frontend REST yanıtta `setSessions` günceller, ama diğer tab'lar güncellenmez.
**Kanıt:** session-manager.js:821 (`logoutSession` üretir) vs 882 (`deleteSession` üretmez).
**Güven seviyesi:** Yüksek.

---

## 12. Sonraki aşama için uygulama planları

### A. `messages.update` içeriği

#### Mevcut semantiği korumak için gerekli değişiklik:

**Değişiklik önerilmez (mevcut davranış kabul edilebilir).** Neden:

1. **`wa_message_id` dedup zaten çift kayıt riskini ortadan kaldırır.** Mevcut kayıt bulunur, içeriği güncellenir.
2. **`should_apply_last_message` eski zaman damgalı güncellemelerin preview'i ezmesini engeller.** En kritik yan etki (chat-list sıralaması bozulması) zaten korunuyor.
3. **Unread count artışı P2 düzeyinde** — retry decryption nadiren INBOUND mesaj için gelir ve unread artışı kullanıcı tarafından "okundu" olarak işaretlendiğinde sıfırlanır.
4. **Broadcast aslında yararlı** — retry decryption başarılı olduğunda mesaj içeriği değişir ve frontend'in güncellemeyi görmesi gerekir.

#### Eğer iyileştirme istenirse:

- **Gateway tarafında:** `socket-events.js:1243` çağrısına `upsertType: 'replace'` (veya `'update'`) parametresi eklenebilir. `_ingestUpsertMessage` içinde yeni bir semantik: dedup mevcut kaydı günceller, unread ARTIRMAZ, `_touchChat`'te `append` bayrağı gibi davranır (preview'i yalnızca daha yeni ise günceller), ama broadcast YAPAR (içerik değiştiği için).
- **Backend tarafında:** `events.py:898`'de `upsert_type` değerini okurken `'replace'`/`'update'` değerini de kabul et. `is_append` yerine `is_update` bayrağı: unread artırmaz, `apply_last_message` çağrılır (ama `should_apply_last_message` zaten eski ts'i reddeder), broadcast yapılır.
- **Testler:** `messages.update` içeriği için yeni bir test: unread artmaz, preview eskiyse oynamaz, broadcast gelir, mevcut kayıt güncellenir.

#### Veri migration: Gerekmez.
#### Geriye dönük uyumluluk: Risk yok — yalnızca gateway iç çağrısına parametre eklenir, backend zaten bilinmeyen tipleri `notify`'a düşürür.

### B. `session_deleted`

#### Backend handler gerekli mi?

**Hayır — mevcut tasarım kabul edilebilir.** Backend silme işlemini REST API üzerinden yapar ve frontend de REST yanıtına güvenir. WebSocket event'i gerekli değil.

#### Eğer iyileştirme istenirse:

- **Gateway tarafında:** `deleteSession` metoduna `session_disconnected` event üretimi eklenebilir (logoutSession'daki gibi). Bu, diğer bağlı istemcilere (multi-tab) session'ın kapandığını bildirir.
- **`session_deleted` event'i üretmek anlamlı değil** — backend zaten `delete_session` REST çağrısı ile session'ı siler ve `purge_whatsapp_data` ile verileri temizler. Gateway'den tekrar event gelmesi çift silme riski yaratır.
- **Frontend tarafında:** `session_deleted` entry'si `LIVE_SESSION_EVENTS` set'inden kaldırılabilir (vestigial kod temizliği). Parity testi `FRONTEND_UNPRODUCED_EVENTS`'ten de kaldırılır.
- **Multi-tab senkronizasyon için:** `session_disconnected` event'i yeterlidir — `deleteSession` bu event'i üretirse, diğer tab'lar `fetchSessions(true)` ile güncellenir.

#### Stale event riski:
- `_emit` içindeki `sessions.has(gwSid)` kontrolü (session-manager.js:464) zaten eski session event'lerini düşürür.
- Backend `map_session_event` → row bulunamazsa `EventOwnerUnresolved` → orphan queue.
- Eski session'dan gelen event yeni session'ı etkilemez: `gateway_id` ile eşleşme yapılır, yeni session farklı `gateway_id`'ye sahiptir.

#### Regresyon testleri:
- `deleteSession` sonrası `session_disconnected` event üretildiğini doğrulayan test (eğer eklenirse).
- `deleteSession` sonrası session map'ten kaldırıldığını doğrulayan test.
- `deleteSession` sonrası DB row'unun silindiğini doğrulayan test.
- Multi-tab senkronizasyon testi (eğer `session_disconnected` eklenirse).

---

## 13. Açık sorular ve kanıt eksikleri

| # | Soru | Durum |
|---|---|---|
| Q1 | `messages.update` içeriğinin `notify` gibi işlenmesi üretimde kaç kullanıcıyı etkiliyor? | Kanıt yok — üretim log erişimi yok. Kod analizi nadir olduğunu gösteriyor. |
| Q2 | Retry decryption sonrası unread count artışı kullanıcılar tarafından raporlandı mı? | Kanıt yok — üretim feedback erişimi yok. |
| Q3 | Multi-tab senaryosunda session silme sonrası stale state görüldü mü? | Kanıt yok — frontend test altyapısında multi-tab test yok. |
| Q4 | Baileys `messages.update` içeriği ne sıklıkla taşır? | Baileys dokümantasyon ve kaynak kodu erişimi yok. Gateway comment'i (socket-events.js:1228 "retries/decryptions/edits") bunların nadir olaylar olduğunu ima ediyor. |

---

## 14. Son karar

### KONU A — `messages.update` `upsertType` semantiği

**Karar: DESIGN GAP**

`messages.update` içeriği `_ingestUpsertMessage`'a `upsertType` vermeden ulaşır ve `notify` varsayılanına düşer. Bu, mesaj güncellemesinin canlı yeni mesaj gibi işlenmesine neden olur. Ancak:
- `wa_message_id` dedup çift kayıt riskini engeller.
- `should_apply_last_message` eski zaman damgalı preview ezmesini engeller.
- En kritik yan etki (unread count artışı) yalnızca INBOUND mesaj için ve nadir bir senaryoda oluşur.

Bu bir **doğrulanmış bug değil**, bir tasarım boşluğudur. Mevcut korumalar en kritik riskleri karşılar. İyileştirme ayrı bir kodlama aşamasında yapılmalı.

### KONU B — `session_deleted` event sözleşmesi

**Karar: NO ISSUE FOUND (vestigial)**

`session_deleted` event'inin gateway'de üreticisi yok ve backend'de handler'ı yok. Frontend `LIVE_SESSION_EVENTS` set'inde vestigial olarak duruyor. Parity testi bunu açıkça listeliyor ve izliyor. Backend silme işlemini REST API üzerinden yapıyor — WebSocket event'ine ihtiyaç yok.

Alt-bulgu olarak `deleteSession`'ın `session_disconnected` üretmemesi bir DESIGN GAP'tir (P3), ancak REST API yanıtı frontend'i güncellediği için risk düşüktür.

### Genel karar

**5.3.8 ANALYSIS PASS**

Analiz her iki konuyu da uçtan uca inceledi, gerçek kod yollarını kanıtladı, senaryo matrisi hazırladı, risk sınıflandırması yaptı ve sonraki aşama için uygulama planı önerdi. Kod değişikliği yapılmadı, üretim kodu değişmedi.

---

## 15. Son değişmezlik denetimi

| Alan | Başlangıç | Bitiş | Değişim |
|---|---|---|---|
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` | Yok |
| HEAD | `3ac26a9ffdd1a4738de915be255ee65c6b5be314` | `3ac26a9ffdd1a4738de915be255ee65c6b5be314` | Yok |
| Staged sayısı | 0 | 0 | Yok |
| Dirty/untracked | 0 | 0 (+1 yeni rapor) | Yalnızca yeni analiz raporu |
| Main HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | Yok |
| Main dirty | 85 | 85 | Yok |
| Üretim kodu | — | — | Değişiklik yok |
| Test kodu | — | — | Değişiklik yok |
| Manifest/lockfile | — | — | Değişiklik yok |

**Yeni dosya:** `docs/audits/ASAMA-5.3.8-event-contract-analysis.md` (yalnızca bu rapor)

Üretim kodu, test kodu, manifest ve lockfile üzerinde hiçbir değişiklik yapılmadı.
