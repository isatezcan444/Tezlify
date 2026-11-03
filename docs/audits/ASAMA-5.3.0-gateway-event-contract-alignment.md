# AŞAMA 5.3.0 — GATEWAY EVENT SÖZLEŞMESİ VE TABAN HİZALAMA DENETİMİ

**Tarih:** 2026-11-01 21:30–22:05 (+03)
**Tip:** Salt okunur denetim. Üretim kodu değiştirilmedi; yalnız bu rapor oluşturuldu.
**Başlangıç HEAD:** `e7f1077a489d94bc6b0f0afef6b575e48922162e` (aşama boyunca değişmedi)
**Branch:** `main` · **Stage:** 0 · **Dirty:** 84 → 85 (yalnız bu rapor)

---

## 0. Yöntem ve kanıt sınırı

Her iddia üç kaynaktan birine dayanır ve metinde işaretlenmiştir:

| İşaret | Anlamı |
| --- | --- |
| **[G]** | `git grep` / `git show <ref>:<path>` ile doğrudan kod kanıtı |
| **[B]** | Baileys `v7.0.0-rc14` kaynak tip tanımı (repoda pinli sürüm; GitHub'dan okundu) |
| **[Ç]** | Çıkarım — kod kanıtı var ama davranış çalıştırılarak doğrulanmadı |

**Doğrulanamayan:** hiçbir test koşulmadı (aşama salt okunur), hiçbir gateway/backend çalıştırılmadı, üretim DB'sine bağlanılmadı. `node_modules` repoda yok; Baileys tipleri **sürüm etiketinden** okundu, kurulu paketten değil.

---

## 1. Baseline ve taban ilişkileri

| Öğe | Değer |
| --- | --- |
| Branch | `main` |
| HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` |
| Stage | 0 |
| Dirty | 24 `M` + 60 `??` = 84 |
| `20c88bb` (production gateway) | `20c88bb9fd1f4dabb73e0d2538dbbe219d9816e6` |
| `0b795ea` (production backend) | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` |

| İlişki | Sonuç |
| --- | --- |
| `20c88bb` → `0b795ea` atası mı? | **EVET** |
| `0b795ea` → `main` atası mı? | **HAYIR** |
| `20c88bb` → `main` atası mı? | **HAYIR** |

5.2.14'teki ilişkiler **yeniden doğrulandı, değişmedi**.

---

## 2. Event yüzeyi karşılaştırması — Main vs production gateway

### 2.1 Baileys listener'ları

`whatsapp-gateway/src/socket/socket-events.js` içindeki `sock.ev.on(...)` çağrıları **[G]**:

| Baileys event'i | `20c88bb` satır | `main` satır | Aynı mı? |
| --- | --- | --- | --- |
| `creds.update` | 133 | 191 | ✔ |
| `connection.update` | 149 | 207 | ✔ |
| `messages.upsert` | 550 | 608 | ✔ |
| `chats.delete` | 584 | 647 | ✔ |
| `messages.delete` | 609 | 672 | ✔ |
| `contacts.update` | 647 | 710 | ✔ |
| `contacts.upsert` | 653 | 716 | ✔ |
| `chats.phoneNumberShare` | 701 | 764 | ✔ |
| `chats.update` | 707 | 770 | ✔ |
| `messaging-history.set` | 842 | 905 | ✔ (main'de 3 ek alan destructure) |
| `groups.update` | 1140 | 1229 | ✔ |
| `presence.update` | 1171 | 1260 | ✔ |
| `messages.update` | 1224 | 1313 | ✔ |
| `message-receipt.update` | 1247 | 1336 | ✔ |
| **`group-participants.update`** | **YOK** | **YOK** | — |
| **`groups.upsert`** | **YOK** | **YOK** | — |
| **`chats.upsert`** | **YOK** | **YOK** | — |

**Listener kümesi iki tabanda birebir aynı.** 4.17 ve 5.2, dinlenen event kümesini değiştirmemiş.

### 2.2 Gateway'in backend'e gönderdiği event adları

`event: '<ad>'` literalleri, iki ref için `sort -u` ile çıkarıldı **[G]**:

```
connection_error            message_new                 session_connected
contact_synced              message_pinned              session_connecting
conversation_deleted        message_reaction            session_disconnected
conversation_read           message_receipt_updated     session_notifications_received
conversation_updated        message_status_updated      session_pairing_code_updated
gateway_connected           messages_deleted            session_qr_updated
history_sync_completed      presence_updated            session_sync_completed
lid_mapped                                              session_sync_progress
                                                        session_sync_started
```

`diff <(20c88bb) <(main)` → **fark yok**. 24 event adı, iki tabanda özdeş.

**Bu, 4.17'nin dışa vuran sözleşmeyi değiştirmediğini kanıtlar.** Pagination bir *okuma* yolu; event yüzeyine dokunmuyor.

### 2.3 Backend dispatch zinciri

`events.py` — `evt ==` dalları **[G]**:

| Gateway event adı | Backend handler | Satır (main) |
| --- | --- | --- |
| `message_new` | `ingest_message` | 2847 |
| `conversation_updated`, `chat_update`, `conversation_read`, `message_status_updated`, `presence_updated` | `map_conversation_event` | 2850 |
| `contact_synced` | `ingest_contact_synced` | 2854 |
| `conversation_deleted` | `ingest_conversation_deleted` | 2856 |
| `messages_deleted` | `_ingest_messages_deleted` | 2858 |
| `message_reaction` | `_ingest_message_reaction` | 2860 |
| `message_pinned` | `_ingest_message_pinned` | 2862 |
| `message_receipt_updated` | `_ingest_message_receipt_updated` | 2864 |
| `lid_mapped` | `_ingest_lid_mapped` | 2866 |
| `connection_error`, `session_*` | `map_session_event` | 2868 |
| `history_sync_completed` | `passthrough_event` (`_PASSTHROUGH_EVENTS`) | 2870 |
| `gateway_connected` | `_acknowledge_without_broadcast` (`_ACKNOWLEDGED_IGNORE_EVENTS`) | 2872 — **yalnız main** |
| *(diğer)* | `logger.error(...)` + `return None` → NACK, yayın yok | 2877 |

**Kritik tasarım kuralı:** bilinmeyen event adı **fail-closed** — ERROR loglanır, yayınlanmaz, `persisted is None` → NACK (`permanent: False`). Yani gateway'de yeni bir event adı üretmek, backend'e handler eklenmeden **hiçbir işe yaramaz ve outbox'ı yeniden teslim döngüsüne sokar** **[G]** (`main.py:733-750`).

### 2.4 Frontend zinciri

| Halka | Konum **[G]** |
| --- | --- |
| WS mesajı → CustomEvent | `App.tsx:216` — `window.dispatchEvent(new CustomEvent('tezlify:ws_event', {detail: eventData}))` |
| İkinci dispatch noktası | `whatsappRepository.ts:42` |
| Tüketiciler | `WhatsAppHubPage.tsx:3349/3446`, `useWhatsAppConversation.ts:476`, `useWhatsAppLoadingGate.ts:127`, `WhatsAppQrConnectModal.tsx:717`, `whatsappApi.ts:588/1368/1378` |
| Canlı oturum seti | `whatsappApi.ts` `LIVE_SESSION_EVENTS` = `session_connected`, `session_disconnected`, `session_deleted`, `session_qr_updated`, `session_sync_completed` (5 üye; `gateway_connected` main'de **çıkarıldı**) |

**Frontend'in fiilen dinlediği event adları** (dosya bazında) **[G]**:

| Event | Dinleyen dosyalar |
| --- | --- |
| `message_new` | `App.tsx`, `whatsappApi.ts`, `useWhatsAppConversation.ts`, `WhatsAppHubPage.tsx` |
| `conversation_updated` | `WhatsAppHubPage.tsx` |
| `contact_synced` | `WhatsAppHubPage.tsx` |
| `message_reaction` | `WhatsAppHubPage.tsx` |
| `message_pinned` | `WhatsAppHubPage.tsx` |
| `message_status_updated` | `useWhatsAppConversation.ts`, `WhatsAppHubPage.tsx` |
| `presence_updated` | `WhatsAppHubPage.tsx` |
| `conversation_deleted` | `WhatsAppHubPage.tsx` |
| **`messages_deleted`** | **YOK** |
| **`message_receipt_updated`** | **YOK** |
| **`history_sync_completed`** | **YOK** |
| **`lid_mapped`** | **YOK** |
| `link_preview_updated` | `useWhatsAppConversation.ts`, `WhatsAppHubPage.tsx` — **üreticisi gateway değil**, backend `link_preview/service.py` |

---

## 3. Dokuz event'in uçtan uca durumu

Her satırda **[G]** kod kanıtı, **[B]** Baileys tip kanıtı, **[Ç]** çıkarım.

### 3.1 `messages.upsert`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `{ messages: WAMessage[], type: MessageUpsertType, requestId?: string }`; `type` = `'notify' \| 'append'` |
| Gateway listener **[G]** | `socket-events.js:550` (20c88bb) / `:608` (main) |
| Gateway normalizasyonu | `_ingestUpsertMessage(msg, sock, id)`; main: `{ upsertType: type }` — **20c88bb `type`'ı geçirmiyor** |
| Gateway event adı | `message_new` (+`upsert_type` yalnız main) |
| Backend handler | `ingest_message` |
| Persistence | **EVET** — `Message` satırı + `Conversation.last_message_*` + `unread_count` |
| Broadcast | EVET; main'de `append` → `_no_broadcast`: persist + ACK, yayın **yok** |
| Frontend handler | `WhatsAppHubPage:2495`, `useWhatsAppConversation:435`, `App.tsx` (toast/ses) |
| UI etkisi | önizleme, unread, `message_count`, rozet, toast, ses, thread'e balon ekleme |
| Test | 20c88bb: `test-faz10-p3-fromme.mjs`, `test-unread-count-progression.mjs`. main ek: `test-upsert-notify-append.mjs`, `test_whatsapp_upsert_append.py`, `test_whatsapp_pg_integrity_race.py`, gerçek Chrome E2E |
| **Eksik** | **Üretimde (20c88bb) notify/append ayrımı YOK** — `type` yalnız hata tanılamasında kullanılıyor (`:559`), `_ingestUpsertMessage`'a geçmiyor. Geçmiş mesaj canlı mesaj gibi rozet/önizleme/yayın üretiyor. |

### 3.2 `messages.update`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `WAMessageUpdate[]` = `{ key: WAMessageKey, update: Partial<WAMessage> }` |
| Gateway listener **[G]** | `:1224` (20c88bb) / `:1313` (main) |
| Gateway normalizasyonu | `update.status` → `_applyMessageAck`; `update.message` → `_ingestUpsertMessage(msg, sock, id)` — **`upsertType` verilmiyor** |
| Gateway event adı | `message_status_updated` (ack) ve `message_new` (retry/edit) |
| Backend handler | `map_conversation_event` / `ingest_message` |
| Persistence | EVET |
| Broadcast | EVET |
| Frontend handler | `useWhatsAppConversation.ts`, `WhatsAppHubPage.tsx` |
| UI etkisi | teslim/okundu durumu, düzenlenmiş mesaj gövdesi |
| Test | **0** (hiçbir gateway testi `messages.update` içermiyor) |
| **Eksik** | Düzenlenen/retry edilen bir mesaj **`notify` varsayılanıyla** yeniden işleniyor. Bu, `append` ayrımının kapatmadığı **bilinen bir boşluk** (5.2'de "pre-existing" olarak not edilmişti). Testi de yok. |

### 3.3 `messages.delete`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `{ keys: WAMessageKey[] } \| { jid: string, all: true }` |
| Gateway listener **[G]** | `:609` / `:672` |
| Gateway normalizasyonu | RAM store'dan siler; `all:true` → `messages_deleted{all, cleared}`; aksi hâlde sohbet başına `wa_message_ids[]` |
| Gateway event adı | `messages_deleted` |
| Backend handler | `_ingest_messages_deleted` |
| Persistence | **EVET — `DELETE FROM messages` + `DELETE FROM message_reactions`, `db.commit()`** **[G]** (`events.py` ~2065-2150) |
| Broadcast | EVET (persist sonrası `ws_manager.broadcast`) |
| Frontend handler | **YOK** — `messages_deleted` frontend'de yalnız REST yanıt alanı olarak geçiyor (`whatsappApi.ts:747`, `WhatsAppHubPage:1740`) |
| UI etkisi | **Canlı yok.** Telefondan silinen mesaj DB'den gidiyor, açık sekme kendiliğinden güncellenmiyor |
| Test | **0** |
| **Eksik** | Sözleşmenin **backend tarafı tam, frontend tarafı kopuk**. Veri kaybı riski yok (DB doğru), ama çok sekemeli tutarlılık açığı var. |

### 3.4 `group-participants.update`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `{ id: string; author: string; authorPn?: string; authorUsername?: string; participants: GroupParticipant[]; action: ParticipantAction }`; `ParticipantAction = 'add' \| 'remove' \| 'promote' \| 'demote' \| 'modify'`; `GroupParticipant = Contact & { isAdmin?, isSuperAdmin?, admin?: 'admin' \| 'superadmin' \| null }` |
| Gateway listener **[G]** | **YOK** (iki tabanda da) |
| Gateway normalizasyonu | **YOK** |
| Gateway event adı | **YOK** |
| Backend handler | **YOK** |
| Persistence | **YOK** |
| Broadcast | **YOK** |
| Frontend handler | **YOK** |
| UI etkisi | **YOK** — gruptan çıkarılan/eklenen üye arayüzde hiç güncellenmiyor |
| Test | **0** |
| **Eksik** | **Uçtan uca yok.** Stage 5.3'ün 1. önceliği. |

### 3.5 `groups.upsert`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `GroupMetadata[]` — `{ id, subject, participants: GroupParticipant[], owner?, addressingMode?, size?, creation?, desc?, ... }` |
| Gateway listener **[G]** | **YOK** |
| Gateway event adı | **YOK** |
| Backend / Frontend / Persistence / Broadcast | **YOK** |
| Test | **0** |
| **Eksik** | **Uçtan uca yok.** Grup sohbetleri yalnız `messaging-history.set` ve `chats.update` üzerinden dolaylı öğreniliyor; canlı oluşturulan grup yakalanmıyor. |

### 3.6 `groups.update`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `Partial<GroupMetadata>[]` |
| Gateway listener **[G]** | `:1140` / `:1229` |
| Gateway normalizasyonu | Yalnız `subject` değişimi işleniyor; `@g.us` değilse veya subject boşsa `continue`; `mergeContactName(..., 'group_subject')` |
| Gateway event adı | `conversation_updated` ve/veya `contact_synced` |
| Backend handler | `map_conversation_event` / `ingest_contact_synced` |
| Persistence | EVET |
| Broadcast | EVET |
| Frontend handler | `WhatsAppHubPage.tsx` (her ikisi) |
| UI etkisi | grup adı listede/başlıkta güncellenir |
| Test | `test-post-qr-sync-state-machine.mjs` (dolaylı) |
| **Eksik** | `participants`, `announce`, `restrict`, `desc`, `ephemeralDuration` gibi alanlar **hiç işlenmiyor**. Sadece isim. |

### 3.7 `chats.upsert`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `Chat[]` = `proto.IConversation & { lastMessageRecvTimestamp?: number }` |
| Gateway listener **[G]** | **YOK** |
| Gateway event adı | **YOK** |
| Backend / Frontend / Persistence / Broadcast | **YOK** |
| Test | **0** |
| **Eksik** | **Uçtan uca yok.** Yeni sohbetler yalnız `messaging-history.set` (toplu) ve `chats.update` (var olan) üzerinden geliyor; **hiç mesajı olmayan yeni sohbet** (ör. yeni grup, arşivden çıkan sohbet) canlı yakalanmıyor. |

### 3.8 `chats.update`

| Alan | Durum |
| --- | --- |
| Baileys kaynağı **[B]** | `ChatUpdate[]` = `Partial<Chat & { conditional, timestamp }>` |
| Gateway listener **[G]** | `:707` / `:770` |
| Gateway normalizasyonu | broadcast-only/dejenere jid filtresi → `normalizeJid` → LID hold → `lastMessage`'dan `updPreview`/`updTs` → medya varsa yer tutucu **üretmez** (`messages.upsert` beklenir) → aksi hâlde `historyMessageToRecord` + `stampMessageSeq` + `trimChatMessages` |
| Gateway event adı | `conversation_updated`, `message_new` |
| Backend handler | `map_conversation_event` / `ingest_message` |
| Persistence | EVET |
| Broadcast | EVET |
| Frontend handler | `WhatsAppHubPage.tsx` |
| UI etkisi | sohbet önizlemesi, sıralama, arşiv/sabitleme, unread |
| Test | `test-post-qr-sync-state-machine.mjs`, `test-unread-count-progression.mjs`, `tests/phase2a-group-hydration.test.mjs` |
| **Eksik** | **`stampMessageSeq` çağrısı 20c88bb'de var, main'de YOK** (main'de fonksiyon hiç yok). Bu, 5.3 için taban seçiminin en somut gerekçesidir — bkz. §5. |

### 3.9 `gateway_connected`

| Alan | Durum |
| --- | --- |
| Kaynak **[G]** | Baileys değil; gateway `events.js:398` `attachClient(socket)` → `socket.send({event:'gateway_connected', sessions_count})` |
| Envelope | `event_id` **YOK**, `gateway_session_id` **YOK**; outbox'tan **geçmiyor** (doğrudan `socket.send`) |
| Backend handler | 20c88bb: **yok** → ERROR + NACK. main: `_ACKNOWLEDGED_IGNORE_EVENTS` → ACK, yayın yok, ERROR yok |
| Persistence | HAYIR (kasıtlı) |
| Broadcast | **HAYIR** (fail-closed: `broadcast()` hedef yoksa reddeder; `sessions_count` tüm tenant'ların toplamı) |
| Frontend | main: `LIVE_SESSION_EVENTS`'ten çıkarıldı. 20c88bb: hâlâ listede (ölü tetikleyici) |
| Test | `test_whatsapp_event_contract_parity.py` (main) |
| **Eksik** | **Üretimde her köprü bağlantısında ERROR + NACK.** NACK `permanent:false` → outbox yeniden dener. `event_id` olmadığı için pratikte ACK/NACK yolu tetiklenmiyor **[Ç]**, ama ERROR logu gerçek. |

### 3.10 Özet matris

| Event | Gateway listener | Backend handler | Persistence | Broadcast | Frontend | Test | Durum |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `messages.upsert` | ✔ | ✔ | ✔ | ✔ | ✔ | 2+ | **Tam** (üretimde append ayrımı yok) |
| `messages.update` | ✔ | ✔ | ✔ | ✔ | ✔ | **0** | **Tam, testsiz** + notify varsayılanı |
| `messages.delete` | ✔ | ✔ | ✔ | ✔ | **✘** | **0** | **Frontend kopuk** |
| `group-participants.update` | **✘** | **✘** | **✘** | **✘** | **✘** | **0** | **Yok** |
| `groups.upsert` | **✘** | **✘** | **✘** | **✘** | **✘** | **0** | **Yok** |
| `groups.update` | ✔ | ✔ | ✔ | ✔ | ✔ | 1 | **Kısmi** (yalnız subject) |
| `chats.upsert` | **✘** | **✘** | **✘** | **✘** | **✘** | **0** | **Yok** |
| `chats.update` | ✔ | ✔ | ✔ | ✔ | ✔ | 3 | **Tam** |
| `gateway_connected` | ✔ (gateway üretir) | main ✔ / prod **✘** | ✘ (kasıtlı) | ✘ (kasıtlı) | main ✔ / prod ölü | 1 | **Prod'da ERROR** |

---

## 4. Production pagination koruması (`20c88bb`)

### 4.1 Bileşenlerin tam konumu

| Davranış | Dosya:satır **[G]** | Ne yapıyor |
| --- | --- | --- |
| `_seq` üretimi | `message-store.js:151` `nextMessageSeq()` | `store._messageSeq++` |
| `_seq` damgalama | `message-store.js:162` `stampMessageSeq()` | `Object.defineProperty(record,'_seq',{enumerable:false})` — **sayılamaz**, JSON'a sızmaz |
| Okuma anında tamamlama | `message-store.js:196` `ensureMessageSeq()` | damgasız kayda en yüksek sırayı verir ⇒ "sessiz atlama" değil "aynı turda geç ziyaret" |
| Epoch üretimi | `message-store.js:221` `storeSeqEpoch()` + `:326` `_seqEpoch: randomUUID()` | store yaratılışında yeni UUID |
| `afterSeq` sorgulama | `session-manager.js:1236` (imza), `:1256` (`seqMode`), `:1294-1305` | `seq > after` filtresi, seq'e göre sıralama, `limit` dilimi |
| `seqEpoch` kontrolü | `session-manager.js:1294` | `epochReset = Boolean(seqEpoch) && String(seqEpoch) !== String(epoch)` |
| Epoch reset (gateway) | `session-manager.js:1295` | `after = epochReset ? 0 : max(0, afterSeq)` |
| Epoch reset (backend) | `0b795ea memory_persistence.py:438-460` | `page.epoch_reset` görülünce yerel imleç **sıfırlanır**; yoksa `next_after <= after_seq` muhafızı sahte `PaginationStalled` üretir |
| Bulk history pagination | `session-manager.js:1229` `listAllMessages()`; `index.js:568-585` `/messages/bulk` | `perChatLimit` seq modunda **uygulanmaz** (imleçle çakışır) |
| Backend chunking | `0b795ea sync.py:103` `_SYNC_BULK_PAGE_SIZE=1000`, `:110` `_bulk_chunks()` | jid listesini `page_size // per_chat_limit` parçalara böler ⇒ sayfalar arası offset **fiziksel olarak imkânsız** |
| Backend parametre geçişi | `0b795ea whatsapp_gateway.py:373-404` | `after_seq` → `afterSeq`, `seq_epoch` → `seqEpoch` |

### 4.2 RAM store ↔ DB ilişkisi ve restart devamlılığı

- Mesajlar **RAM'de** (`messagesByChat`); `_seq` de RAM'de, kayıt nesnesinin sayılamaz özelliği olarak.
- Gateway restart → store yeniden yaratılır → `_seqEpoch` **yeni UUID**, `_messageSeq` **0'dan** başlar **[G]** (`message-store.js:326`).
- Backend eski `(epoch, after_seq)` çiftini gönderir → gateway `epoch_reset: true` döner → backend imleci sıfırlar → **güvenli yeniden tarama** (veri kaybı değil) **[G]**.
- **Ama RAM içeriği restart'ta kaybolur** (A6). Epoch reset yalnız *imleci* kurtarır; *veriyi* kurtarmaz. Veriyi kurtaran şey persistence loop'udur — ve o **hâlâ KAPALI**.
- `_seq` DB'ye **yazılmıyor**; DB sırası `created_at`/`id` üzerinden. Yani epoch/seq mekanizması **yalnız RAM→DB kopyalama turunun** doğruluğunu garanti eder, DB'nin kendi sırasını değil.

### 4.3 Main ile karşılaştırma

| Sembol | `20c88bb` | `main` |
| --- | --- | --- |
| `stampMessageSeq` | `message-store.js:162` + 6 çağrı yeri | **YOK** |
| `nextMessageSeq` / `_messageSeq` | var | **YOK** |
| `storeSeqEpoch` / `_seqEpoch` | var | **YOK** |
| `ensureMessageSeq` | var | **YOK** |
| `afterSeq` / `seqEpoch` (gateway) | `index.js:568`, `session-manager.js:1236` | **YOK** |
| `afterSeq` / `seq_epoch` (backend istemci) | `whatsapp_gateway.py:373-404` | **YOK** |
| `_bulk_chunks` | `sync.py:110` | **YOK** |
| `epoch_reset` (backend) | `memory_persistence.py:388-441` | **YOK** |
| `pagination: 'seq'` yanıt modu | var | **YOK** |

**Sonuç:** main'in gateway'i, `messagesByChat`'e yazan **her** yolda `stampMessageSeq` çağırmıyor — çünkü fonksiyon yok. 5.3'te yeni bir yazma yolu eklenirse, main tabanında bu çağrının **eksikliği fark edilmez** (derleme hatası yok, test yok). `20c88bb` tabanında ise eksiklik, `ensureMessageSeq` sayesinde "geç ziyaret"e düşer — yani **güvenli başarısızlık**.

### 4.4 5.3'ün koruması gereken dosya ve fonksiyonlar

Yeni event'ler eklenirken **dokunulmaması** gerekenler:

| Dosya | Korunacak |
| --- | --- |
| `whatsapp-gateway/src/messages/message-store.js` | `nextMessageSeq`, `stampMessageSeq`, `messageSeqOf`, `ensureMessageSeq`, `storeSeqEpoch`, `createSessionStore` içindeki `_seqEpoch: randomUUID()` ve `_messageSeq` alanları |
| `whatsapp-gateway/src/session-manager.js` | `listAllMessages()`'in `seqMode` dalı (1230-1330), `_touchChat()` imzası, `trimChatMessages` çağrıları |
| `whatsapp-gateway/src/index.js` | `/messages/bulk` parametre ayrıştırması (568-585) |
| `whatsapp-gateway/src/socket/socket-events.js` | `chats.update` (707-760) ve `messaging-history.set` (842+) içindeki `stampMessageSeq` çağrıları |
| `backend/.../whatsapp_gateway.py` | `list_all_messages(..., after_seq, seq_epoch)` imzası ve parametre eşlemesi |
| `backend/.../memory_persistence.py` | `epoch_reset` işleme ve imleç sıfırlama |
| `backend/.../sync.py` | `_bulk_chunks`, `_SYNC_BULK_PAGE_SIZE`, `_SYNC_PER_CHAT_LIMIT` |

**Kural:** 5.3 yeni event'leri **mesaj yazmıyorsa** (yalnız sohbet/üye meta verisi), yukarıdakilere hiç dokunmaz. **Mesaj yazıyorsa** (ör. "X gruba eklendi" sistem mesajı), `stampMessageSeq` zorunludur ve bu fonksiyon **yalnız `20c88bb` tabanında vardır**.

---

## 5. 5.3 geliştirme tabanı kararı

### 5.1 Seçenek A — Main üzerinde geliştirme

| | |
| --- | --- |
| **Avantaj** | Tek ağaç: 5.2 notify/append, 36 commit'lik 3.9.x backup/escrow zinciri, tüm testler ve raporlar burada. Sıfır Git işlemi. |
| **Risk** | Gateway kodu **4.17'siz** bir tabana yazılır. Yeni yazma yolu `stampMessageSeq` çağırmaz → 4.17 tabanına taşındığında **sessiz atlama** riski (projenin tekrar eden kusur sınıfı). `afterSeq`/`seqEpoch` yok ⇒ pagination davranışı üzerine test yazılamaz. |
| **Etkilenen dosyalar** | `socket-events.js` (main sürümü), `session-manager.js` (main sürümü) |
| **4.17 koruması** | **YOK** — tabanda bulunmuyor |
| **5.2 düzeltmeleri** | **VAR** |
| **Gelecekteki merge maliyeti** | Zaten ödenmiş olan 11 dosyalık gateway farkı **+ 5.3'ün eklediği kod**. Toplam merge maliyeti 4.17 delta'sından **büyük değil**, ama merge sırasında 5.3 kodunun seq/stamp açısından **yeniden denetlenmesi** gerekir. |

### 5.2 Seçenek B — `20c88bb` tabanlı ayrı branch/worktree

| | |
| --- | --- |
| **Avantaj** | 4.17 **fiziksel olarak** yerinde; `stampMessageSeq` mevcut; yazılan kod üretim tabanıyla birebir aynı dosyalarda. |
| **Risk** | 5.2 notify/append düzeltmesi bu tabanda **yok** ⇒ yeni event'lerin append etkileşimi test edilemez. 5.2'nin tüm testleri (pytest + gerçek Chrome E2E) bu tabanda **kırmızı**. İki yönlü bakım: 5.3 kodu ile 5.2 kodu farklı ağaçlarda. |
| **Etkilenen dosyalar** | `socket-events.js` (20c88bb sürümü), `session-manager.js` (20c88bb sürümü) |
| **4.17 koruması** | **VAR** |
| **5.2 düzeltmeleri** | **YOK** |
| **Gelecekteki merge maliyeti** | A ile aynı büyüklükte delta, **ters yönde**; ayrıca 5.2'nin geri taşınması gerekir. |

### 5.3 Seçenek C — Kontrollü entegrasyon tabanı

**Tanım:** `release/backend-only-seq-safety` (`0b795ea`) tabanından yeni bir dal; bu taban **zaten `20c88bb`'yi içeriyor** (`--is-ancestor` = EVET). Üzerine main'in **5.2 deltası** dar kapsamda yeniden uygulanır:

| Dosya | main'deki 5.2 değişikliği | Satır |
| --- | --- | --- |
| `whatsapp-gateway/src/socket/socket-events.js` | `type` → `_ingestUpsertMessage(..., {upsertType: type})` | +7/−2 |
| `whatsapp-gateway/src/session-manager.js` | `_ingestUpsertMessage` imzası, `isAppend`, `_touchChat({append})`, rozet/önizleme bastırma | +41/−11 |
| `backend/app/main.py` | `_no_broadcast` ACK dalı | +17 |
| `backend/app/services/whatsapp/orchestration/events.py` | `upsert_type` normalizasyonu, `_no_broadcast` üç dönüş yolu, webhook bastırma, `_ACKNOWLEDGED_IGNORE_EVENTS` | +92/−11 |

| | |
| --- | --- |
| **Avantaj** | **Tek ağaçta hem 4.17 hem 5.2.** 5.3'ün yazacağı her yol, `stampMessageSeq`'in var olduğu dosyalarda yazılır. Mevcut testlerin tamamı (4.27/4.28/4.17 testleri + 5.1/5.2 testleri) bu tabanda **anlamlı**. Deploy yolu da bu tabandan geçtiği için ayrı bir "release'e taşıma" adımı kalmaz. |
| **Risk** | 4 dosyada **yeniden uygulama** işi; `session-manager.js`'te 4.17 ile 5.2 hunileri aynı fonksiyonlara değiyor ⇒ elle birleştirme ve **tam regresyon** gerekir. Yeni dal = yeni SHA'lar ⇒ 5.2 kanıt hash'leri bu dalda yeniden üretilmeli. |
| **Etkilenen dosyalar** | Yukarıdaki 4 dosya + yeni dal |
| **4.17 koruması** | **VAR** (tabanda) |
| **5.2 düzeltmeleri** | **VAR** (yeniden uygulanmış) |
| **Gelecekteki merge maliyeti** | **En düşük.** 5.3 kodu doğru tabanda doğar; `main` ile yakınsama ayrı ve bilinçli bir iş olarak kalır. |

### 5.4 Öneri

> **Seçenek C öneriliyor.**

**Gerekçe (tek cümle):** 5.3'ün ekleyeceği event'lerin en az biri (`chats.upsert`) ve muhtemelen `group-participants.update` (sistem mesajı üretirse) `messagesByChat`'e **yazar**; `stampMessageSeq` yalnız `20c88bb` tabanında bulunduğu için, main tabanında yazılan kod bu çağrıyı **sessizce atlar** ve 4.17'ye taşındığında tam olarak projenin tekrar tekrar düştüğü "sessiz atlama" kusurunu üretir. Buna karşılık B, 5.2'nin tüm testlerini kırmızı bırakır. Yalnız C her iki korumayı aynı ağaçta tutar.

**A'nın tek geçerli olduğu durum:** 5.3 kapsamı **mesaj store'a hiç yazmayacak** şekilde daraltılırsa (yalnız `groups.update` benzeri meta veri event'leri). Bu, `chats.upsert` ve `group-participants.update` hedefleriyle çelişir.

**Bu aşamada yapılmayan:** hiçbir branch/worktree oluşturulmadı, hiçbir dosya kopyalanmadı, hiçbir cherry-pick yapılmadı.

---

## 6. 5.3 event sözleşmesi tasarımı

Aşağıdaki payload'lar **Baileys `v7.0.0-rc14` tip tanımlarından** alınmıştır **[B]**; gateway tarafındaki alan adları **mevcut kodun kendi sözleşmesine** göre önerilmiştir **[Ç]**. Hiçbiri uygulanmadı.

Ortak zarf (mevcut `_emit` davranışı) **[G]**: `{ gateway_session_id, event, ...payload }`. Outbox'tan geçen olaylara `event_id` (`crypto.randomUUID()`) eklenir (`postgres-event-outbox.js:126-128`); `_internal_only` ve `session_sync_progress`/`_ephemeral` **outbox'a girmez** ⇒ `event_id` **yok**.

`sanitizeOutboundEvent()` yeni event adları için `default: return event` dalına düşer ⇒ **ek alanlar soyulmaz, allowlist güncellemesi gerekmez** **[G]**.

### 6.1 `group-participants.update` → `group_participants_updated`

**Baileys girdisi [B]:**
```
{ id: string, author: string, authorPn?: string, authorUsername?: string,
  participants: GroupParticipant[], action: ParticipantAction }
GroupParticipant = Contact & { isAdmin?, isSuperAdmin?, admin?: 'admin'|'superadmin'|null }
ParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'modify'
```

**Önerilen gateway payload [Ç]:**

| Alan | Zorunlu | Tip | Not |
| --- | --- | --- | --- |
| `event` | ✔ | `'group_participants_updated'` | yeni ad |
| `gateway_session_id` | ✔ | string | `_emit` tarafından eklenir |
| `conversation_id` | ✔ | string | `normalizeJid(id)` — `@g.us` doğrulanmalı |
| `action` | ✔ | enum | `add\|remove\|promote\|demote\|modify`; bilinmeyen değer → **olay düşürülür**, `notify` gibi davranılmaz |
| `author` | ✔ | string | ham JID; **kimlik çözümlemesi backend'de** |
| `author_phone` | ✖ | string \| null | `jidToPhone(author)` — LID ise `null` |
| `participants` | ✔ | array | aşağıdaki nesneler |
| `participants[].jid` | ✔ | string | `Contact.id` (LID veya PN olabilir) |
| `participants[].phone` | ✖ | string \| null | `jidToPhone()`; `@lid`/`@g.us` için **`null`** |
| `participants[].role` | ✖ | `'admin'\|'superadmin'\|null` | `admin` alanından |
| `occurred_at` | ✔ | ISO string | **gateway'in kendi saati**; Baileys bu event'te timestamp **vermiyor** |

**Kimlik/LID [G]:** Mevcut `resolveJidKey`/`jidToPhone` yardımcıları kullanılmalı. `@lid` katılımcılar için `phone` **uydurulmamalı** — `null` bırakılmalı (A14/T kuralı: LID köprüsü **bağlantıya** bağlıdır, kişiye değil).

**Dedup/idempotency:** Baileys bu event'te mesaj kimliği vermez ⇒ doğal anahtar `(conversation_id, action, participants[].jid, occurred_at)`. `event_id` outbox'tan gelir; backend `processed_events` tablosu bunu zaten kullanıyor **[G]**.

**Timestamp [Ç]:** Baileys payload'ında zaman yok. Gateway `new Date().toISOString()` üretmeli. **Geçmiş senkron sırasında gelen bu event "eski" olabilir** — bu yüzden backend'de `append` semantiği (önizleme/rozet oynatmama) **uygulanmamalı**, çünkü bu event bir mesaj değil.

**ACK/NACK [G]:** Bilinmeyen ad → ERROR + NACK (`permanent:false`) ⇒ outbox yeniden dener. **Bu yüzden backend handler'ı gateway değişikliğiyle AYNI anda merge edilmeli.**

**Persistence [Ç]:** Grup üyeliği için bugün ayrı tablo **yok**. Öneri: **önce yalnız `contact_synced` benzeri kişi kaydı + sohbet meta verisi**, üye listesi tablosu **sonraki** aşama. Üye tablosu eklemek migration gerektirir ve `migrations.py`'de `delete(` taraması zorunludur.

**Broadcast [Ç]:** `ws_manager.broadcast(persisted)` — hedef tenant `gateway_session_id`'den çözülür, mevcut mekanizma aynı.

**Frontend [Ç]:** Yeni bir listener gerekir (`WhatsAppHubPage`). Bugün `group_participants_updated` dinleyen **hiçbir kod yok**; eklenmezse olay backend'de işlenir, UI'da görünmez (bkz. `messages_deleted` — aynı hata sınıfı, canlı örnek).

### 6.2 `groups.upsert` → `group_upserted`

**Baileys girdisi [B]:** `GroupMetadata[]`; alanlar: `id`, `subject`, `participants`, `owner?`, `addressingMode?`, `size?`, `creation?`, `desc?`, `descOwner?`, `restrict?`, `announce?`, `memberAddMode?`, `joinApprovalMode?`, `isCommunity?`, `isCommunityAnnounce?`, `linkedParent?`, `ephemeralDuration?`, `subjectTime?`, `subjectOwner?`, `author?`…

**Önerilen gateway payload [Ç]:** her eleman için `group_upserted`:

| Alan | Zorunlu | Not |
| --- | --- | --- |
| `conversation_id` | ✔ | `normalizeJid(group.id)`; `@g.us` değilse **atla** |
| `subject` | ✔ | boşsa `null` (boş string değil) |
| `participants[]` | ✖ | **5.3.0'da gönderilmemesi öneriliyor** — `size` yeterli; tam liste `group-participants.update` ve `messaging-history.set` ile gelir |
| `size` | ✖ | `participants.length` |
| `is_community` | ✖ | `isCommunity` |
| `linked_parent` | ✖ | `linkedParent` — topluluk JID'i |
| `announce` / `restrict` | ✖ | bool |
| `occurred_at` | ✔ | gateway saati; `subjectTime`/`creation` **varsa** onlar kullanılmalı |

**Idempotency:** anahtar `conversation_id` (upsert semantiği). `subject` değişmediyse **yayın üretilmemeli** — mevcut `groups.update` bunu zaten yapıyor (`merged.name !== chat.name` kontrolü) **[G]**.

**Persistence [Ç]:** `ensure_conversation_race_safe` yolu yeniden kullanılabilir; yeni tablo gerekmez.

**Dikkat [Ç]:** `groups.upsert` **mesaj içermez** ⇒ `stampMessageSeq` gerekmez, `last_message_at` **oynatılmamalı**. Sohbet listesi sıralaması (A4: mutlak son mesaj) bozulmamalı.

### 6.3 `chats.upsert` → `conversation_upserted`

**Baileys girdisi [B]:** `Chat[]` = `proto.IConversation & { lastMessageRecvTimestamp?: number }`. `IConversation` proto tarafından tanımlı; repoda kullanılan alanlar `id`, `name`, `unreadCount`, `conversationTimestamp`, `archived`, `pinned`, `muteEndTime`, `lastMessage` **[G]** (`chats.update` işleyicisi bunları okuyor).

**Önerilen gateway payload [Ç]:**

| Alan | Zorunlu | Not |
| --- | --- | --- |
| `conversation_id` | ✔ | `normalizeJid(chat.id)`; broadcast-only/dejenere jid **atla** (mevcut filtreler) |
| `name` | ✖ | `chat.name`; `mergeContactName` ile birleştirilmeli, ham kimlik adı **yayınlanmamalı** |
| `is_group` | ✔ | `@g.us` |
| `unread_count` | ✖ | `chat.unreadCount`; **append/geçmiş kaynaklıysa 0** |
| `last_message_at` | ✖ | `conversationTimestamp`; **`null` bırakılabilir** |
| `last_message_preview` | ✖ | `summarizeWaMessage(lastMessage)` → `normalizePreviewText`; **medya ise yer tutucu üretme** (mevcut `chats.update` kuralı) |
| `archived` / `pinned` | ✖ | `archivedPatch()` yardımcısı kullanılmalı (bilinmeyeni **ezmez**) |
| `occurred_at` | ✔ | gateway saati |

**En kritik kural [G]:** `lastMessage` varsa ve mesaj store'a yazılacaksa **`stampMessageSeq(store, record)` zorunlu**. Bu fonksiyon **`20c88bb` tabanında var, `main`'de yok** ⇒ §5'teki taban kararının doğrudan sonucu.

**Idempotency:** `conversation_id` anahtarı; mevcut sohbet varsa `ensure_conversation_race_safe` ile yarış-güvenli upsert.

**Broadcast [Ç]:** sohbet yaratma **`conversation_updated`** olarak yayınlanmalı (yeni bir ad yerine mevcut adı yeniden kullanmak, frontend'de ek listener ihtiyacını ortadan kaldırır). Yeni ad kullanılırsa frontend listener'ı **aynı aşamada** eklenmelidir.

### 6.4 Ortak zorunluluklar (üç event için)

| Konu | Kural | Kanıt |
| --- | --- | --- |
| Backend handler | Yeni ad eklenmezse `logger.error` + NACK → outbox yeniden dener | **[G]** `events.py:2877`, `main.py:733` |
| Parity testi | `test_whatsapp_event_contract_parity.py` gateway/backend/frontend kümelerini karşılaştırır; yeni ad **üçünde birden** yoksa test kırmızı olur | **[G]** |
| Sanitizer | Yeni adlar `default` dalına düşer, alanlar korunur | **[G]** `whatsapp-formatting.js:121` |
| Tenant izolasyonu | `gateway_session_id` yoksa yayın **fail-closed** reddedilir | **[G]** |
| `_internal_only` | Backend'e **hiç gönderilmez** — yeni event'ler için **kullanılmamalı** | **[G]** `events.js:337` |
| `_skip` | Yalnız `db.commit()` postgres+event_id varsa çağrılır ⇒ SQLite/test yolunda persist commit'siz kalır | **[G]** — bilinen tuzak |
| `_no_broadcast` | Commit'ten **sonra** okunur, ACK eder, yayın yapmaz | **[G]** `main.py:771` |

---

## 7. Sonraki mikro-aşama

Taban **belirlendi** (Seçenek C) ama **mevcut değil**. Bu yüzden §7'nin "aksi durumda önce taban hizalama" koşulu devreye giriyor.

### Önerilen: **5.3.1 — Kontrollü Entegrasyon Tabanı (taban hizalama)**

**Kapsam (kod yazımı minimum, Git işlemi onaya bağlı):**

1. `release/backend-only-seq-safety` (`0b795ea`) tabanından yeni dal; `20c88bb`'nin bu tabanda **zaten** bulunduğunu `--is-ancestor` ile yeniden doğrula.
2. Main'in 5.2 deltasını **4 dosyada** dar kapsamda uygula (§5.3 tablosu). `session-manager.js`'te 4.17 hunileriyle çakışma **elle** çözülür; hiçbir hunk körlemesine alınmaz.
3. **Doğrulama (asıl iş):** yeni tabanda sırayla
   - `pytest backend/tests/test_whatsapp_initial_sync_chunking.py` (4.28 korunmuş mu)
   - `pytest backend/tests/test_whatsapp_pagination_contract.py` (4.27/4.17 korunmuş mu)
   - `pytest backend/tests/test_whatsapp_upsert_append.py` (5.2 taşınmış mı)
   - `pytest backend/tests/test_whatsapp_event_contract_parity.py` (sözleşme hâlâ tutarlı mı)
   - `node scripts/test-bulk-seq-pagination-guarantees.mjs` (gateway 4.17)
   - `node scripts/test-upsert-notify-append.mjs` (gateway 5.2)
4. **Durma koşulu:** altı testten biri kırmızıysa dal **atılır**, 5.3.2'ye geçilmez. Sonuç ne olursa olsun raporlanır.

**Neden 5.3.1 = "Group Participants Event Contract" değil:** `group-participants.update` işleyicisi grup üyeliği meta verisi yazacak; `chats.upsert` ise mesaj store'a dokunacak. İkisi de `stampMessageSeq`'in bulunduğu tabanda yazılmalı. Yanlış tabanda yazılan kod, 4.17'ye taşındığında **sessiz atlama** üretir — bu projenin ölçülmüş kusur sınıfı.

**5.3.2 (bundan sonra):** `Group Participants Event Contract` — §6.1 sözleşmesiyle, üç katmanda birden.

---

## 8. Açık riskler

| # | Risk | Durum | Etki |
| --- | --- | --- | --- |
| E1 | **`messages_deleted` frontend'de dinlenmiyor** | Doğrulandı (0 dosya) | Telefondan silinen mesaj DB'den gidiyor, açık sekme güncellenmiyor. 5.3'ten bağımsız, **mevcut açık**. |
| E2 | **`messages.update` notify varsayılanı** | Doğrulandı (kod) | Düzenlenen/retry mesaj `append` ayrımından geçmiyor. 5.2'nin kapatmadığı boşluk. |
| E3 | **`messages.update` / `messages.delete` testi yok** | Doğrulandı (0 dosya) | Bu iki yolun hiçbir regresyon ağı yok. |
| E4 | **Üretimde `gateway_connected` ERROR + NACK** | Kod kanıtı | Her köprü bağlantısında gürültü; gerçek hataları gizleyebilir. |
| E5 | **Üretimde append canlı davranıyor** | Kod kanıtı (`:549` vs `:613`) | Rozet/önizleme yanlış; kullanıcıya görünür. |
| E6 | **4.17 ile 5.2'nin `session-manager.js` çakışması** | **Ölçülmedi** — birleştirme denenmedi (yasak) | Seçenek C'nin maliyeti bilinmiyor; 41 vs 390 satır aynı dosyada. |
| E7 | **`chats.upsert` seq damgası** | Tasarım gereği | Main tabanında yazılırsa `stampMessageSeq` sessizce atlanır. |
| E8 | **Parity testi frontend'i yalnız `LIVE_SESSION_EVENTS` üzerinden görüyor** | Doğrulandı | `message_new`, `conversation_updated`, `messages_deleted` gibi adlar parity kontrolünün **dışında**. Yeni event eklendiğinde frontend listener'ı eklenmese bile test **yeşil kalabilir**. |
| E9 | **`groups.upsert` / `chats.upsert` Baileys'te gerçekten tetikleniyor mu?** | **Doğrulanamadı** | Tip tanımı var; hangi koşulda emit edildiği Baileys iç kodunda. Repoda bu event'ler için hiç dinleyici olmadığı için **sahada gözlemlenmiş örnek yok**. |
| E10 | **`proto.IConversation` alan kümesi** | Kısmen doğrulandı | `Chat` tipi proto'ya referans veriyor; repoda kullanılan alt küme doğrulandı, tam liste **değil**. |
| E11 | **`_seq` DB'de yok** | Doğrulandı | Epoch/seq yalnız RAM→DB kopyalama turunu korur. Persistence loop **kapalı** olduğu için bu koruma şu an **etkisiz**. |
| E12 | **Persistence loop OFF** | Değişmedi | 4.27 dormant. Açmak ayrı onay ve ayrı risk analizi gerektirir. |

---

## 9. Tamamlama kontrolü

| Öğe | Değer |
| --- | --- |
| HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` — **değişmedi** |
| Branch | `main` — **değişmedi** |
| Stage | **0** |
| Commit | **0** |
| Push | **0** |
| Deploy | **0** |
| Merge / cherry-pick / rebase | **0** |
| Branch / worktree oluşturma | **0** |
| Production işlemi | **0** |
| DB işlemi | **0** |
| Persistence loop | **OFF** |
| Dirty | 84 → **85** (yalnız bu rapor) |
| Kullanıcı değişiklikleri | Korundu (24 `M` + 60 `??`) |

**Değişen tek şey bu rapor dosyasıdır.** Hiçbir kaynak dosya okuma dışında ele alınmadı.
