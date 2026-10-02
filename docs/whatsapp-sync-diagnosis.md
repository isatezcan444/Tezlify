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
| 5b | QR penceresindeki olaylar sınırlı bellekte tutulur, promosyonda kalıcı kuyruğa akar | **bitti** | `whatsapp-gateway/scripts/test-ephemeral-outbox-gate.mjs` (sözleşme güçlendirildi: `1 !== 2`); boşaltma devre dışı → kırmızı |
| 7 | Startup purge köprüsü bilinen bölünmeyi **silmez, erteler** | **bitti** | `backend/tests/test_whatsapp_purge_defers_known_bridge.py` 3/3; erteleme kapatılınca **2 kırmızı, kontrol yeşil** |
| 8 | Startup'ta ertelenen LID hayaleti **gerçekten birleştirilir** (tek uygulama) | **bitti** | `backend/tests/test_whatsapp_boot_lid_merge.py` 9/9; boot birleştirmesi kapatılınca **3 kırmızı, kontroller yeşil**; paylaşılan sembol atlanınca **2 kırmızı** |
| 9 | Aynı LID çiftinde **çapraz süreç kilidi** + sahipsiz mesaj**sız** doğrulama turu | **bitti** | aynı dosya 15/15; kilidi kapatınca **2 kırmızı**, doğrulama turunu tek tura indirince **1 kırmızı**, toplayıcıyı kapatınca **2 kırmızı** |
| 10 | **Periyodik** süpürme (boot sınırı + ertelemeler + yarış artığı) ve `/health` görünürlüğü | **bitti** | süpürme tek turu birleştirme+toplama yapıyor, durumu `/health` bloğunda; conftest süpürmeyi kapatıyor (zamanlama bağımlılığı yok) |

### Faz 7 — onarımı besleyen malzeme purge tarafından yok ediliyordu

Üretimde ölçtüğümde onarım `taranan=0` döndü. "0 sonuç" ile "bozuk sorgu" ayırt
edilemez, bu yüzden **keşfin her aşamasını tek tek ölçtüm**:

| Aşama | Üretimde |
|---|---|
| `lid_mappings` toplam / `@lid` olan | 17300 / 17288 |
| `whatsapp_sessions` JOIN sonrası (aşama 1) | **208** |
| hayalet LID kontak (`phone_e164='jid:…@lid'`) | **0** |
| hayalet LID sohbet | **0** |

Yani darboğaz sorgu değil, **malzemenin yokluğu**. Ve nedeni
`WHATSAPP_PRODUCTION_DEPLOY_REPORT.md`'de zaten kayıtlıydı: `conversations 449 → 447`,
`contacts 1848 → 1846`, **"pre-existing `purge_raw_jid_identity_data`"**.

Purge kendini *"çözülmemiş LID hayaletlerini temizler"* diye belgeliyordu ama sorgu
**köprüden bağımsız olarak her hayaleti** siliyordu:

```sql
SELECT id FROM contacts WHERE phone_e164 LIKE 'jid:%@lid'   -- köprü sorulmuyor
```

Köprü tam da satırı onarılabilir kılan şeydir: onarım mesajları canonical sohbete
**taşır**, purge hayaleti sohbetiyle ve mesajlarıyla **siler**. Sırayla koştuklarında
purge önce davranıp onarımın malzemesini yok ediyordu ve kayıp geri getirilemiyor.

Düzeltme yeni bir davranış eklemiyor; **koda kendi sözleşmesini uyguluyor**:

```sql
SELECT c.id FROM contacts c WHERE c.phone_e164 LIKE 'jid:%@lid'
  AND NOT EXISTS (SELECT 1 FROM whatsapp_private.lid_mappings lm
                  JOIN public.whatsapp_sessions ws ON ws.gateway_id = lm.session_id
                  WHERE lm.lid_jid = substr(c.phone_e164, 5)
                    AND lm.phone_jid IS NOT NULL AND lm.phone_jid <> '')
```

Üç mühendislik detayı yük taşıyor:

- **Tablo varlığı sorgulanmadan ölçülür.** `try/except` ile yoklamak Postgres'te
  işe yaramaz: patlayan bir ifade transaction'ı *aborted* durumuna düşürür ve
  sonraki her ifade de başarısız olur. Bu yüzden `to_regclass` / `sqlite_master`
  kullanılıyor — ikisi de tablo yokken hata değil NULL döner.
- **Tablo adı lehçeye göre seçilir** (PG: `whatsapp_private.lid_mappings`, SQLite:
  `lid_mappings`); startup sırası bunu güvenli kılıyor
  (`ensure_whatsapp_gateway_private_schema` satır 128, purge satır 136).
- **Sessizlik yok:** ertelenenler sayılır ve loglanır.

Canlı doğrulama (yayın sonrası, üretim Postgres'inde): erteleme sorgusu **hatasız
çalıştı** ve `to_regclass` **t** döndü — yani erteleme dalı gerçekten aktif, sessizce
eski "hepsini sil" davranışına düşmüyor.

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

## Yayın sonrası canlı doğrulama (ölçülen)

| Ne | Sonuç |
|---|---|
| yayındaki commit | `7c5cb2c…` — `/opt/tezlify/.deployed-commit` ile birebir |
| public `/health` | 200, `gateway_bridge.connected=true`, `last_event_at` canlı |
| container'lar | backend/gateway/caddy/db hepsi `healthy` |
| startup hatası | **0** traceback |
| gateway kodu | `deleteConversationRemote`, `conversations/:jid` (9 eşleşme), `pairingBuffers` (15), `remoteJidAlt` (3) |
| backend kodu | `delete_conversation_remote`, orphan kuyruğu (54), `remote_deleted` şema + endpoint |
| **dışa dönük silme rotası** | backend→gateway DELETE gerçek token'la: `route=/sessions/:session/conversations/:jid status=404 {"error":"Session not found"}` |
| **erteleme dalı** | üretim Postgres'inde sorgu hatasız çalıştı; `to_regclass(...) IS NOT NULL` = **t** |

### Yayın 3 (`27e2803`) — boot birleştirmesi canlıda

| Kanıt | Ölçüm |
|---|---|
| yayındaki commit | `27e2803…` — `/opt/tezlify/.deployed-commit` ve host `git rev-parse HEAD` ile **birebir** |
| container'da yeni kod | `/app/backend/app/services/whatsapp/reconciliation.py` var; `main.py:46` import, `main.py:142` çağrı, `events.py:1002` delegasyon |
| startup | **0** traceback; özel şema/lid_mappings doğrulandı |
| boot adımı canlı koşu | container içinde `merge_deferred_lid_ghosts(engine, limit=50)` → `{"scanned": 0, "merged": 0, "skipped": 0, "errors": 0, "remaining_at_least": 0}` |
| `--user-id` iki biçim | tireli UUID filtresiyle de hatasız koştu (PG'de SQL hatası yok) |
| onarım işi (paylaşılan uygulama) | container içinde PLAN: `taranan=0 birlestirilen=0 birlestirilecek=0 atlanan=0` |
| üretimde hayalet LID kontak / aktif sohbet | **0 / 0** |

Canlı koşuda `merged=0` **beklenen** sonuçtur: üretimde birleştirilecek hayalet (0/0)
yok. Yani bu tablo "birleştirme canlıda x satırı taşıdı" demiyor — **malzeme yokluğu**
nasıl ölçülür, onu gösteriyor. Gerçek bir birleştirmenin davranış kanıtı kapıdadır
(`test_whatsapp_boot_lid_merge.py` 9/9, 3 kırmızıya falsifiye edildi); üretimde kanıt
üretmek için sentetik satır yazmak **yapılmadı** — canlı veriyi doğrulama uğruna
kirletmek, ölçümün kendisinden daha pahalıdır.

İki satır özellikle önemli:

- Gateway tüm rotalara auth'tan **önce** 401 döndüğü için durum kodu rota varlığını
  ayırt etmiyor. Bu yüzden çağrı **backend'in kendi istemcisinden** gerçek token'la
  yapıldı: yanıt gövdesi `Session not found` — yani istek rota deseniyle **eşleşti**
  (Express'in `Cannot DELETE` varsayılanı değil) ve yalnızca oturum araması düştü.
- `to_regclass` = `t`, erteleme dalının üretimde **aktif** olduğunu kanıtlıyor;
  sessizce eski "hepsini sil" davranışına düşmüyor. (SQLite'ta geçen bir sorgu
  Postgres'te patlayabilirdi; bu ölçüm onu dışlıyor.)

### Faz 8 — ertelemeyi birleştirmeye çeviren adım

Faz 7'nin dürüst boşluğu şuydu: **erteleme birleştirme değildir.** Köprüsü bilinen hayalet
artık silinmiyordu ama boot'ta canonical sohbete de taşınmıyordu; operatör onarımı
çalıştırana kadar isimsiz bir sohbet olarak duruyordu. Enger, birleştirmenin
`reconcile_legacy_split_conversation` adlı bir orchestrator **metodu** olmasıydı: onu
`core/migrations.py`'den çağırmak servis katmanını startup migration'ına bağlar
(döngüsel import riski).

Çözüm, mantığı oradan **çıkarmak** oldu — `services/whatsapp/reconciliation.py`:

| Çağrı yeri | Nasıl |
|---|---|
| canlı yol (`lid_mapped`) | orchestrator metodu artık ince bir **delegasyon**; kendi mock'lanabilir `_upsert_contact` / `_ensure_conversation` / kilit yardımcılarını enjekte eder |
| **boot** | `main.py`, `purge_raw_jid_identity_data`'dan hemen sonra `merge_deferred_lid_ghosts(engine)` çağırır |
| onarım işi | `scripts/diagnostics/whatsapp_lid_split_repair.py` aynı fonksiyonu çağırır |

Üç yer de **aynı nesneyi** çağırır (kapı bunu `is` ile çiviler); bir kopya mantık zamanla
ayrışırdı. Modül servis katmanına bağlı değildir (yalnızca model + depo + saf kimlik
sabitleri); kilit zaten depo katmanındaki paylaşılan `get_conversation_lock`'tur.

İki sessiz tuzak kapatıldı:

- **İdempotans.** Birleştirme LID sohbetini arşivler ama silmez; aday sorgusu
  arşivlenmiş satırı **dışlar**. Onsuz her restart aynı çiftleri yeniden "birleştirilmiş"
  diye raporlar, `limit` yüzünden "kalan" sayısı hiç azalmazdı.
- **Sınır + dürüstlük.** Koşu `limit` (boot 200) ile sınırlıdır; artan iş
  `remaining_at_least` olarak söylenir. Hata boot'u **düşürmez** (fail-open, `error`
  alanıyla raporlanır) — kimlik birleştirmesi şema bütünlüğüne dokunmaz.
- **`--user-id` sessizce boş dönmez:** `user_id` sütunu `Uuid` olduğu için kayıt
  dash'siz olabilir; sorgu artık tireli ve dash'siz iki biçimi de kabul eder.

### Faz 9/10 — ertelemeyi güvenli kılan üç parça

Faz 8 birleştirmeyi servis katmanından çıkardı ama üç dürüstlük açığı kaldı:

1. **Aynı çifti iki süreç birleştirebiliyordu.** `get_conversation_lock` yalnızca
   TEK süreçte geçerli; canlı yol API'de, boot ve onarım işi ayrı süreçlerde koşar.
   İki birleştirme aynı mesaj kümesini okur, ikisi de "taşıdım" der: okunmamış sayı
   İKİ KEZ toplanır ve arada gelen bir mesaj arşivlenen sohbette **sahipsiz** kalır.
   Çözüm DB satırı olan bir **lease** (`wa_merge_locks`, TTL 120s): süreç ölürse
   lease kendiliğinden düşer, yani kilit asla kalıcı takılmaz. Alınamazsa
   birleştirme ERTELENİR — LID sohbeti arşivlenmediği için aday kalır ve bir
   sonraki süpürme onu birleştirir. Erteleme kayıp değil, sıradır; raporda da
   `merged` değil **`deferred`** olarak görünür.
   *Kritik ayrıntı:* lease anahtarı `user_id`nin yazımından bağımsız olmalı.
   `Uuid` sütunu dash'siz saklarken canlı yol tireli gönderir; anahtar normalize
   edilmezse iki süreç **farklı** kilitler alır ve kilit sessizce hiçbir şeyi
   korumaz — bu tam olarak bir testte yakalandı (kilit tutulurken birleştirme
   yine de oldu).
2. **Tek tur "taşıdım" demek yetmez.** Birleştirme sürerken canlı ingest eski
   sohbeti (henüz arşivlenmeden) çözmüş olabilir ve mesaj oraya yazılır. Bu
   yüzden taşıma **sınırlı (3) doğrulama turu** ile tekrarlanır ve arşivlemeden
   ÖNCE `stranded_unique` **ölçülür**; sıfır değilse `ERROR` loglanır ve raporda
   saklanmaz (`merge_passes` de kanıta girer: tek tur = kırmızı).
3. **Yarış artığı bir yerde toplanmalı.** Arşivlenmiş LID sohbeti aday
   listesinden çıktığı için, orada kalmış bir mesaj boot tarafından bir daha
   görülmezdi. Süpürmenin ikinci fazı (`collect_stranded_lid_messages`) tam o
   satırları bulur ve **aynı** birleştirmeyi kullanarak taşır. Sahte "bekleyen iş"
   üretmemek için ölü kopyalar (wa_message_id'si canonical tarafta zaten olanlar)
   aday sayılmaz — ikinci koşu `scanned=0` der.

Süpürme **periyodik**tir (varsayılan 15 dk, ilk tur 60 sn sonra; kill-switch
`WHATSAPP_IDENTITY_SWEEP_ENABLED`) ve durumu `/health` → `whatsapp_identity_sweep`
altında görünür (`runs`, `pending_at_least`, `last_deferred`, `still_stranded`,
son tur zamanları). Böylece "bekleyen iş var mı" sorusu kabuk komutu gerektirmez;
operatörün işi yalnızca ölçüm kaldığında telefonu eline almak olur.

### Yayın 4 (`6b35eaa`) — kilit, toplayıcı ve periyodik süpürme canlıda

| Kanıt | Ölçüm |
|---|---|
| yayındaki commit | `6b35eaa…` — `.deployed-commit` ve host HEAD birebir |
| container kodu | `main.py` süpürme başlangıcı + `health` bloğu; modülde `_merge_lease` / `collect_stranded_lid_messages` |
| startup | **0** traceback; süpürme kendi kendine başladı: `[SWEEP] … aralık=900s, ilk tur=60s, limit=200` |
| **periyodik tur gerçekten koştu** | `/health` → `runs=1`, `last_started_at 12:27:34` (başlangıçtan tam 60 sn sonra), `last_finished_at 12:27:34.94`, `pending_at_least=0`, `last_error=null` |
| **lease karşılıklı dışlama (üretim PG)** | aynı anda ikinci alma denemesi **False**; bırakma sonrası kalan lease satırı **0** |
| iki fazlı rapor şekli | `splits{scanned,merged,deferred,remaining_at_least}` + `stranded{scanned,merged,moved_unique_total,still_stranded}` üretimde hatasız koştu |
| log kanıtı (host, venv yok) | sunucuda `sqlalchemy` **yok** (lazy-import tasarımının kanıtı) ama `--capture-logs` koştu: 150 gateway + 119 backend satırı yapılandırılmış kanıta çevrildi, tüm kalıp sayıları `0` |

`merged=0` / `scanned=0` yine **beklenen**: üretimde birleştirilecek hayalet yok.
Kanıtlanan şey mekanizmaların **çalışır durumda ve görünür** olduğudur: periyodik tur,
karşılıklı dışlayan lease, iki fazlı rapor ve tek komutla log kanıtı.

## Kalan dürüstlük payı

**Boot adımı ölçülemediği yerde iddia etmez.** Üretimde hayalet LID kontak/sohbet
**0/0** olduğu için boot birleştirmesi orada **yapacak iş bulmaz** ve `merged=0` der —
bu, kapının kanıtladığı sözleşmenin (tohumlanmış bölünmeyi mesaj kaybetmeden taşıma)
yokluğu değil, **malzemenin yokluğudur**. Gerçekleşen bir birleştirmenin canlı kanıtı
için malzemeyi onarım işiyle üretmek gerekir.

**Gerçek telefon gerektiren iki doğrulama yapılmadı** — ve ölçülmüş gibi yapmıyorum.
Ölçümün kendisi artık elle tutulur bir kayda bağlandı: adım adım protokol
[`whatsapp-handset-measurement-protocol.md`](whatsapp-handset-measurement-protocol.md)
ve kanıt aracı `scripts/diagnostics/whatsapp_handset_measure.py` (önce/sonra
snapshot + `--diff` hükmü; hüküm satırı olmadan "ölçüldü" denmez).

1. **Rozetin telefon okumasıyla düşmesi** (Faz 1 + 6).
2. **Tezlify'dan silinen sohbetin telefondan da gitmesi** (Faz 2 giden).

Kapılar **sözleşmeyi** kanıtlıyor, WhatsApp sunucusunun kabul ettiğini değil. İkisi de
telefon elde, yayın sonrası ölçülmelidir. Yukarıdaki tabloda kanıtlanan şey hattın
**uçtan uca bağlı ve canlı** olduğudur; bu, sunucunun kabul edeceğinin kanıtı değildir.

## Yayın 5 (`3fec1e8` / `eb17f47` / `cdb8aac`) — metrikler, tıklanabilir onarım, canlı sentetik birleştirme

Üç iş birlikte yayınlandı: (1) süpürme/kilit gözlemlenebilirliği + **`/metrics`**,
(2) bekleyen bölünmeleri listeleyen ve **tek istekle birleştiren yönetim ucu** (+ arayüzde
"Birleştir" uyarısı), (3) `5c1c76d`'nin geri alınmasıyla eski-sayfa (§P) düzeltmesinin
geri getirilmesi. Yayın kaydı `20261002T131728Z`; geri dönüş
`bash scripts/deploy/host-release.sh --rollback-to 20261002T131728Z`.

### Gözlemlenebilirlik — `/metrics`

Süpürme turu süresi, iki fazın ayrı süresi ve **kilit bekleme dağılımı** (son 50 örnek:
last/avg/max/p50/p95 + toplam/deneme) süreç belleğinde örneklenir. `/metrics` tamamını,
`/health` kompakt özetini verir (`last_duration_ms`, `avg_duration_ms`, `lock_wait_avg_ms`,
`lock_contended_total`). Değerler **süreç-yereldir**: `process_local: true` ve `generated_at`
bunu açıkça söyler; yeniden başlatmada sıfırlanır ve "tüm zamanların metriği" sanılmamalıdır.

- **Caddy tuzağı (yakalandı):** backend'de var olan bir `/metrics`, edge'de yönlendirme
  tanımlı olmadığı için SPA fallback'ine düşüyor ve **HTML uygulama kabuğu** döndürüyordu —
  "uç nokta var ama görünmüyor". `Caddyfile`'a `/health` ile aynı `handle /metrics` bloğu
  eklendi (`eb17f47`) ve canlıda `curl .../metrics` → **JSON** doğrulandı.
- `/health` artık `duration_ms.count/avg/p50/p95` gibi **dağılım** alanlarını taşımaz
  (gövdeyi şişirmemek için); yalnızca özet skalerler kalır. Örnek listeleri süreç belleğinde,
  `/metrics`'te tam haliyle durur.

### Canlı ölçüm — sentetik bölünmüş çift, gerçek birleştirme, geri alma

Üretimde (PostgreSQL) iki sentetik çift tohumlandı (`99999900000000{1,2}@lid` →
`+1555000000{1,2}`), **gerçek birleştirme** uçtan uca ölçüldü, sonra tohum ve etkisi geri alındı.

**Çift 2 — operatör yolu (yönetim ucu), saniyeler içinde:**

| Adım | Kanıt |
|---|---|
| tohum | conv **18431** (3 mesaj, okunmamış 3) + conv **18432** (1 mesaj, okunmamış 1) + `lid_mappings` satırı |
| `GET /api/v1/whatsapp/lid-splits` | `items:[{lid_jid:"999999000000002@lid", message_count:3, unread_count:3}], total:1, truncated:false` |
| `POST /lid-splits/merge` (tek istek) | `requested:1, merged:1, deferred:0, errors:0` → `moved_unique:2, deduped_duplicates:1, stranded_after:0, canonical_unread_count:4` |
| DB (merge sonrası) | conv 18432: 3 mesaj (`SEED2-LID-2/3` + paylaşılan), okunmamış **4**; conv 18431: **arşivli**, okunmamış 0, ölü kopya 1 |
| liste (merge sonrası) | `{"items":[],"total":0}` |
| `/metrics` | kilit `attempts:1 acquired:1 contended:0`, bekleme `last=avg=max=p50=p95=43.561 ms`; tur `runs:1` |
| geri alma | 8 mesaj + 4 sohbet + 4 kişi + 2 eşleme silindi; artık `0|0|0|0|0`; sayımlar tabana döndü (contacts 1527 / conversations 122 / lid_mappings 18138) |
| auth hijyeni | geçici oturum satırı silindi; aynı token artık **401** — yeni uç noktalar fail-closed kimlik doğrulamalı |

**Çift 1 — boot yolu (sürüm adayı):** çift 1, yayın sırasında **aday container'ın boot
birleştirmesiyle** taşındı (kanıt: eski sohbet 13:17:32.799'da arşivlendi, mesajlar
13:17:32.79'da taşındı; canlı container'ın sonraki boot'u aday bulamadı). Bu, üretim kodunun
üretim DB'sinde gerçek bir birleştirmesidir; ama aday container'la birlikte **süreç-yerel
metrikleri** de yok oldu — o yüzden bu birleştirmenin kanıtı DB satırlarıdır, `/metrics` değil.

**Dürüstlük notu (ölçüldü, açıklanamadı):** çift 1'in canonical sohbetinin okunmamış sayısı
beklenen **4** değil **0**'dı; `updated_at` (13:13:43) merge anından (13:17:32) **önce**. Çift 2
aynı sürümle 4'ü doğru üretti. Yani aritmetik değil, merge'den önce her iki sentetik sohbeti de
etkileyen bir okuma/senkron olayı var; **kaynağı kanıtlanmadı** ve burada neden diye
yazılmadı.

### Canlıda yakalanan gerçek defekt — aday taraması ham satırları tarıyordu

İlk merge denemesi **`requested:0`** döndü; tohum DB'de duruyordu. Neden: `candidate_lid_split_pairs`
ham `lid_mappings` satırlarını `ORDER BY lid_jid LIMIT` ile tarayıp adayları Python'da eliyordu.
Üretimde **18 138** eşleme vardı ve tohumun `lid_jid`'i sıralamanın **sonundaydı** — yani sınır
yalnızca en küçük `lid_jid` penceresini kapsıyor, gerçek bölünme hiç görünmüyordu. Aynı körlük
periyodik süpürmeyi de kapsıyordu: `merged=0`, "aday yok" değil, **"ilk N ham satır dışına
bakılmadı"** demekti.

Düzeltme (`cdb8aac`): hayalet kişi ve sohbet koşulları SQL **JOIN**'ine taşındı; `LIMIT` artık
**gerçek adaylara** uygulanır, `remaining_at_least` gerçekten kalan işi söyler. Kapı
`test_candidate_scan_is_not_blinded_by_non_candidate_mappings`; falsifikasyon: eski ön-kesit
taramasi simüle edildi → `len(pairs) == 1` **`[]`** ile kırmızı, prob artığı 0.

## Açık kalanlar (bu yayınla değişmedi)

- `greenlet_spawn has not been called` (`sync.py` ilk senkron hidrasyonu) — `e8a86ee`'de de var.
- `conversation_deleted: sohbet zaten yok` 30 sn'lik döngü (aynı 8 `@lid`) — `e8a86ee`'de de var.
- Gerçek telefon gerektiren iki ölçüm (rozet düşüşü; silinen sohbetin telefondan gitmesi) hâlâ yapılmadı.
