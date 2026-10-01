# WhatsApp senkronizasyon teşhisi (5 bildirim)

Kaynak: kod okuması + üretim kanıtı (`ubuntu@130.162.247.20`, sürüm `fdbe997`, oturum
`73155bba-c2db-454a-9274-b169ff88ba0e`, hat `+905413749073`, 118 sohbet / 563 mesaj).
Bu doküman varsayım içermez; her madde ölçülmüş bir kanıta dayanır.

## Özet tablo

| # | Bildirim | Kök neden | Kanıt |
|---|---|---|---|
| 2 | Telefondan silinen sohbet Tezlify'a yansımıyor | `chats.delete` hiç dinlenmiyor **ve** sohbet seviyesi app-state (`regular_low`) donmuş | `BaileysEventMap`'te `chats.delete: string[]` var; gateway kaynağında adı hiç geçmiyor. `regular_low` mtime 1790841766000'da dondu |
| 3 | Telefondan okunan sohbetin rozeti düşmüyor | `markChatAsReadAction` sohbet seviyesi koleksiyonda → `regular_low` donmuş olduğu için hiç uygulanmıyor | `regular_high` 1790842042000'de ilerlerken `regular_low` 1790841766000'da sabit |
| 4 | Tezlify'dan silince WhatsApp'ta silinmiyor | Silme yalnızca yerel (toplu DELETE); gateway çağrısı yok | `chatModify` mevcut ve `{delete: true, lastMessages}` destekliyor (`Types/Chat.d.ts:94`) ama hiç çağrılmıyor |
| 5 | Cihaz kaldırılınca telefonda çıkış olmuyor | Arayüzün çöp kutusu `DELETE /sessions/{id}` → gateway `deleteSession()`; bu yol **`sock.logout()` çağırmıyor** | `logout()` yalnızca "Bağlantıyı Kes" düğmesinin gittiği `POST /sessions/{id}/logout` yolunda |
| 1 | Syafira görünmüyor / telefondan yazılan düşmüyor | **Şu anki veride mesaj kaybı YOK**; sohbet `is_archived=true` olduğu için ALL sekmesinden gizli. Ayrıca gerçek kayıp yolları mevcut (aşağıda) | Syafira gateway'de (`6282245414751@s.whatsapp.net`, unread=2) ve DB'de (sohbet 17844, 9 mesaj, iki yönlü) |

## Kök neden 1 — App-state senkronu KISMEN ölü (sohbet seviyesi koleksiyon donmuş)

> **Düzeltme (ölçüm sonrası).** İlk okumada "beş koleksiyon da park etti, app-state
> tamamen ölü" demiştim. Sürüm dosyalarının mtime'ları bu genellemeyi çürüttü:
>
> | koleksiyon | mtime_ms | durum |
> |---|---|---|
> | `regular` | 1790841767000 | bağlantı anında yazıldı |
> | `critical_block` | 1790841767000 | bağlantı anında yazıldı |
> | `critical_unblock_low` | 1790841767000 | bağlantı anında yazıldı |
> | **`regular_high`** | **1790842042000** | **4.5 dk SONRA ilerledi → bu koleksiyon yaşıyor** |
> | **`regular_low`** | **1790841766000** | **park anında dondu, bir daha ilerlemedi** |
>
> Yani app-state tamamen ölü değil: `regular_high` ilerliyor, ama sohbet seviyesi
> eylemleri taşıyan `regular_low` donmuş. `_resolveArchivedJids`'in arşiv durumunu
> `app-state-sync-version-regular_low.json` içindeki `indexValueMap` üzerinden
> yeniden türetmesi de bununla tutarlı: arşiv "çalışıyor" görünürken canlı
> okundu/silme akmıyor.

Üretim logu, canlı oturumda başlangıçta **beş koleksiyonun da** park edildiğini gösteriyor:
`critical_block`, `critical_unblock_low`, `regular`, `regular_high`, `regular_low`.
Park, `blockedCollections` kümesine ekleme yapar; bu küme **normal senkron yolunu
engellemez**, yalnızca "anahtar gelince yeniden dene" notudur. Bu yüzden tek başına
park, ölüm kanıtı değildir — asıl kanıt sürüm dosyasının ilerlememesidir.

Zaman çizelgesi (epoch ms):

```
park  regular       1790841765871
park  regular_low   1790841765872
yazım app-state-sync-key-AAAAAPAM.json   1790841766000   <- park'tan SONRA
ayrıca app-state-sync-version-regular.json 1790841767000
```

Yani bağlantı anındaki ilk `resyncAppState` çalışırken anahtarlar henüz çözülebilir
değil; 129 ms sonra anahtarlar yazılıyor — ama park bir daha açılmıyor.

Baileys `Socket/chats.js:1115-1127` parkı yalnızca tek bir olayda açıyor:

```js
ev.on('creds.update', ({ myAppStateKeyId }) => {
    if (!myAppStateKeyId || blockedCollections.size === 0) return;
    ...
});
```

`creds.json` içinde `myAppStateKeyId` zaten kayıtlı (`AAAAAO+9`) — dolayısıyla bu alanı
taşıyan `creds.update` hiç ateşlenmiyor ve park süreç ömrü boyunca sürüyor.

Gateway'in kendi yaması `_scheduleAppStateRearm` doğru fikirdir ama yanlış kapıya bağlı:

```js
// session-manager.js (~167)
if (store.chats && store.chats.size > 0) return false;   // <- yeniden denemeyi durdurur
```

History sync sohbetleri saniyeler içinde doldurduğu için yeniden deneme pratikte hiç
çalışmıyor.

**Sonuç:** sohbet seviyesi app-state mutasyonları (okundu/okunmadı, arşiv/açma, silme)
uygulanmıyor. Madde 3 bunu doğrudan, madde 2 ise ikinci bir kopuklukla birlikte yaşıyor.

**Düzeltilen yama:** mevcut geri kazanım `store.chats.size === 0` koşuluna bağlıydı —
sohbet dolduğu anda yeniden denemeyi bırakıyordu, yani tam da `regular_low`'u
kurtaracak denemeyi iptal ediyordu (üretimde ölçülen arıza: 118 sohbet dolu, koleksiyon
donmuş). Yeni sözleşme: geri kazanım **app-state sağlığına** bakar (bir resync'in sürüm
dosyasını ilerletmesi = pozitif kanıt), sohbet sayısına değil, ve **beş koleksiyonun
tamamını** ister. Kanıt: kapı eski hâline döndürüldüğünde
`test-appstate-rearm.mjs` C kontrolü kırmızı oluyor.

## Kök neden 2 — `chats.delete` / `messages.delete` dinlenmiyor

`BaileysEventMap` (7.0.0-rc14, çalışan imajdan okundu) şunları sunuyor:

```ts
'chats.delete': string[];
'messages.delete': { keys: WAMessageKey[] } | { jid: string; all: true };
'messages.reaction': { key; reaction }[];
'message-receipt.update': MessageUserReceiptUpdate[];
'lid-mapping.update': LIDMapping;
```

Gateway'in abonelik listesinde (`socket/socket-events.js`) bunların hiçbiri yok.
Madde 2'nin app-state'ten bağımsız **ikinci** kopukluğu budur.

## Kök neden 3 — Okunmamış sayacı iki yerde bağımsız

- Gateway `_ingestUpsertMessage`: `chat.unread_count += 1` yapıyor ama `_touchChat`
  sonrası `conversation_updated` **yaymıyor** → artış backend'e hiç gitmiyor.
- Backend `_ingest_message` kendi sayacını artırıyor (`events.py:752`).

Ölçülen drift: Syafira gateway'de `unread=2`, DB'de `1`.

Ayrıca backend düşüşü kabul edecek şekilde **zaten düzeltilmiş**
(`should_apply_unread_count` — "gateway verbatim bildirir, düşüş de kabul edilir").
Yani madde 3'ün kopukluğu backend'de değil, app-state'in ölü olmasında.

## Kök neden 4 — LID eşlemesi eksik öğreniliyor, tutulan mesaj yayınlanmıyor

`WAMessageKey` `remoteJidAlt` / `participantAlt` taşıyor (doğrulandı), ama gateway
yalnızca `senderLid/senderPn/participantLid/participantPn` okuyor.

Eşleme öğrenilmezse `resolveJidKey` LID anahtarını döndürür, `lidHold` true olur ve
`_ingestUpsertMessage` **`message_new` yaymaz** (`session-manager.js:1366`). Mesaj gateway
belleğinde kalır; eşleme hiç gelmezse backend'e asla ulaşmaz.

## Kök neden 5 — Sahipsiz ve geçici olaylar kalıcı değil

Üretim logu (backend):

```
WARNING - Gateway olayi sahibi cozulemedi, atlandi (event=lid_mapped):
Bilinmeyen gateway oturumu (session_id=73155bba-c2db-454a-9274-b169ff88ba0e, jid=905413749073@s.whatsapp.net)
```

`_log_orphan_event` yalnızca logluyor — kuyruk, yeniden oynatma yok. Ayrıca gateway
`events.js publish()` içinde:

```js
const skipDurable = Boolean(session?.ephemeral);
// QR penceresinde kalıcı outbox ATLANIR → yalnızca "en iyi çaba" teslim
```

Yani QR eşleşmesi sırasında üretilen olaylar, backend oturumun sahibini çözemediği sürece
kaybolur. Madde 1'in gerçek kayıp yolu budur.

## Madde 1 hakkında dürüst düzeltme

Syafira kayıp değil. Kanıt:

```
contact 13315 | +6282245414751 | Syafira
conv 17844 | session 115 | unread=1 | is_archived=t | preview='sağol' | last_message_at=2026-10-01 08:14:12
messages: 9 (2026-10-01 08:02:54 → 08:14:12), iki yönlü:
  OUTBOUND 'Syafira' / INBOUND 'efendim' / OUTBOUND 'Nasılsın' / INBOUND 'iyiyim, sen'
  OUTBOUND 'ım good' / OUTBOUND 'what are u doing' / INBOUND 'working'
  OUTBOUND 'Hmm kolay gelsin' / INBOUND 'sağol'
```

"Listede görünmüyor" açıklaması: `ConversationList.tsx:361`
`if (currentFilter === 'ALL' && archivedLike) return false;` — arşivli sohbetler ALL
sekmesinden gizlenir, yalnızca "Arşiv" sekmesinde görünür.

**Doğrulanması gereken (bu makineden bakılamaz):** telefonda Syafira gerçekten arşivli mi?
Arşiv durumu iki kaynaktan geliyor: history-sync `chat.archived` ve `_resolveArchivedJids`
HMAC sezgisi. İkincisi yanlış pozitif üretebilir; gateway'de 6 sohbet `archived=true`.

## Alınan ürün kararları

1. **Telefonda silinen sohbet Tezlify'dan tamamen silinir** (mesajlar dahil, geri alınamaz).
2. **Tezlify'dan silme WhatsApp'a da iletilir** (`chatModify({ delete: true, lastMessages })`),
   kullanıcı onayından sonra.

Uygulama notu — üç ayrı Baileys olayı karıştırılmamalı:

| Olay | Anlamı | Bizde karşılığı |
|---|---|---|
| `chats.delete: string[]` | Sohbet silindi | Sohbeti + mesajlarını sil |
| `messages.delete: {jid, all: true}` | Sohbet **temizlendi** | Bu sohbetin mesajlarını sil, **sohbet kalsın** |
| `messages.delete: {keys}` | Tek mesaj silindi | Yalnız o mesajı sil |

Karar 1 geri alınamaz olduğu için, silinen satırların kimliği (sohbet/jid + mesaj sayısı +
zaman) denetim izi olarak loglanır; verinin kendisi tutulmaz.

## Uygulama durumu

| Faz | Ne | Durum | Kapı (ve falsifikasyon) |
|---|---|---|---|
| 1 | App-state geri kazanımı sohbet sayısına değil sağlığa bağlı | **bitti** | `whatsapp-gateway/scripts/test-appstate-rearm.mjs` 10/10; eski kapıya döndürülünce kırmızı |
| 2 (gelen) | `chats.delete` + `messages.delete` abonelikleri ve backend işleyicileri | **bitti** | `backend/tests/test_whatsapp_remote_deletions.py` 7/7; dispatch kapatılınca kırmızı |
| 3 | Cihaz kaldırma gerçek `sock.logout()` çağırır | **bitti** | mevcut oturum kapıları |
| 2 (giden) | Tezlify'dan silme WhatsApp'a da iletilir (`deleteChatAction`) | **bitti** | `backend/tests/test_whatsapp_outbound_delete_sync.py` 5/5 **ve** `whatsapp-gateway/scripts/test-delete-chat-contract.mjs` 12/12; ikisi de falsifiye edildi |
| 4 | LID kimliği ingest anında `remoteJidAlt`'ten çözülür | **bitti** | `whatsapp-gateway/scripts/test-lid-alt-resolution.mjs` 12/12; çift falsifiye (kaynak devre dışı → B1/B3/B5 kırmızı, kontrol B4 yeşil) |
| 5 | Sahipsiz olaylar sınırlı/TTL'li kuyruğa alınır ve yeniden oynanır | **bitti** | `backend/tests/test_whatsapp_orphan_replay.py` 6/6; eski "at" davranışı geri konunca 6/6 kırmızı |
| 6 | Okunmamış sayacı yalnızca **yayınlanan** mesajı sayar | **bitti** | `whatsapp-gateway/scripts/test-unread-count-authority.mjs` 6/6; eski sıralama geri konunca A1 kırmızı, rozet kontrolleri yeşil |

### Faz 5 — asıl kayıp "sahipsiz"di, "kimlik" değil

Ölçüm bu turda yönümü değiştirdi. Backend'de **zaten tam bir LID kimlik onarım makinesi vardı**:
`_heal_lid_contact_identity` (LID anahtarlı kişiyi yeniden anahtarlar) +
`reconcile_legacy_split_conversation` (LID sohbetini telefon sohbetine **birleştirir**). Yani
tasarım eksik değildi; makine **hiç beslenmemişti**.

`resolve_event_owner_and_session` oturumu `gateway_id` ile buluyor ve QR eşleşmesi sırasında
`whatsapp_sessions` satırı **henüz yok** — bu yüzden `EventOwnerUnresolved` fırlıyor, dispatch onu
yakalayıp olayı **atıyordu**. `lid_mapped` ise o onarımın **tek çağıranı**. Bir olayın düşmesi, kullanıcı
için "sohbet bölünmüş ve mesajlarım hiç gelmemiş" demek.

Artık olay tutuluyor: sınırlı (max 500), TTL'li (300 sn) ve **aynı gateway oturumu için sonraki bir
olay sahip çözebildiği anda** yeniden oynanıyor — çünkü o çözüm, engelin kalktığının kanıtıdır.
Taşma ve TTL tahliyeleri **sayılır** (`orphan_queue_stats`), çünkü sessizce atan bir kuyruk aynı
hatayı bir katman aşağı taşımak olurdu. Yeniden oynama hâlâ çözemezse olay geri konur, yerinde
denenmez (re-entrancy kilidi) — kalıcı olarak sahipsiz bir olay döngü kuramaz.

### Faz 4 — "QR sırasında yazdı" semptomunun mekanizması

`_ingestUpsertMessage` LID adresli bir mesajı `lidHold` ile **saklıyor ama hiç yayınlamıyor**;
yayın, ancak bir eşleme olayı **sonradan** gelirse oluyor. İlk eşleşmede hiçbir eşleme öğrenilmemiş
olduğu için, kullanıcının telefonunda **gördüğü** mesajlar tam da tutulanlardı.

Baileys cevabı anahtarın üstünde taşıyor: `WAMessageKey.remoteJidAlt` / `participantAlt`. Artık ingest
anında okunuyor, yani mesaj LID olarak tutulmak yerine **telefon kimliğiyle** dosyalanıyor. Katılık
yük taşıyor: `asPn` içinde `@` geçen her şeyi geçirdiği için grup jid'i "telefon" sanılıp
`lidToJid`'e LID→grup eşlemesi yazılabilirdi; katı bir telefon-tarafı doğrulaması bunu reddediyor.

### Faz 6 — sayaç yalnızca yayınlananı sayar

`_ingestUpsertMessage` RAM'deki `unread_count`'u **her** gelen mesaj için artırıyordu — hiç
yayınlanmayan tutulmuş LID mesajları dahil. Yani sayaç, sistemin geri kalanının göremediği bir
mesajı içeriyordu; üretimde ölçülen "gateway 2 / DB 1" farkı tam olarak buydu. Artık artış yalnızca
yayın dalının içinde.

**Bilinçli olarak YAPILMADI:** gateway'in artışı bir `conversation_updated` ile yayınlanmadı.
Okunmamış sayacının kim sahibi olduğu bir ürün kararı; onu tek taraflı değiştirmek, düşüş yönünde
çalışan `should_apply_unread_count` kapısını da yeniden tasarlamayı gerektirirdi. Bu tur yalnızca
**yanlış olanı** düzeltti (yayınlanmamışı saymak), sahipliği değiştirmedi.

Ayrıca QR penceresinde olayların kalıcı outbox'ı atlaması **hata değil**: outbox'ta `gateway_sessions`
FK'si var ve Efemeral oturumun satırı tasarım gereği yok (PG 23503, günde 24 kez loglanmış).
Güvenilir tampon, o pencere için ayrı bir mekanizma gerektirir; yapılmadı ve burada kayıtlı.

### Giden silme (Faz 2) — çalışırken ölçülen yeni gerçek

`chatModify({ delete: true, lastMessages })` yamasının yazıldığı koleksiyon **`regular_high`**
(`Utils/chat-utils.js`, `apiVersion: 6`), okundu/arşivin yazıldığı koleksiyon ise `regular_low`.
Yani giden silme, donmuş `regular_low` durumundan **bağımsız** çalışır — bu işin Faz 1'i
beklemesi gerekmedi.

`lastMessages` sözleşmesi katıdır ve Baileys **fırlatır**, sessizce yutmaz: her öğede
`key.remoteJid`, `key.id` ve sayısal `messageTimestamp` zorunlu; grupta `fromMe:false` bir öğede
`participant` zorunlu. Bu yüzden yalnızca iki alanı da taşıyan kayıtlar gönderilir ve liste
**tek elemanlıdır** (en yeni mesaj) — çok elemanlı listede `lastMessageTimestamp` son elemandan
okunur ve sıralama yönü tartışmalı olduğundan tek eleman o belirsizliği kaldırır.

Yerel önbellek (`chats`, `messagesByChat`, `rawMessagesByChat`) silme başarılıysa **boşaltılır**:
bırakılsaydı sonraki sohbet keşfi silinen sohbeti yeniden üretir, yani silme kendini geri alırdı.
Başarısızsa **boşaltılmaz** — silemediğimiz bir sohbet kendi görünümümüzden de kaybolmamalıdır.

### Faz 2'nin dürüstlük sözleşmesi

Yerel silme, uzaktan silmeden **bağımsızdır**: gateway kapalı olsa bile sohbet silinir, çünkü
kullanıcı silme kararını verdi. Ama sonuç raporlanır (`remote_deleted` / `remote_error`) ve
gateway'in `success: false` dönüşü başarı sayılmaz — çünkü 2xx, WhatsApp'ın kabul ettiğinin
kanıtı değildir. Arayüz `remote_deleted=false` gördüğünde uyarı toast'i gösterir; susmak
kullanıcıya telefonun da temizlendiğini sanmasına yol açardı.

**Hâlâ doğrulanmamış (canlı test gerekir):** rozetin telefon okumasıyla düşmesi (Faz 1) ve
gerçek cihazda sohbetin telefondan silinmesi (Faz 2 giden). İkisi de yayın sonrası
ölçülmelidir; kod ve kapı tarafı hazırdır.
