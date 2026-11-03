# AŞAMA 5.3.1b — FRONTEND EVENT PARITY VE ENTEGRASYON TESTLERİNİN TAMAMLANMASI

**Tarih:** 2026-11-01
**Worktree:** `/private/tmp/tz531-integration`
**Branch:** `integration/whatsapp-5.3-seq-safe`
**HEAD:** `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` (değişmedi)
**Kapsam:** tek satır frontend düzeltmesi + altı zorunlu testin eksiksiz çalıştırılması
**Karar:** **PASS** (koşullu değil; aşağıdaki üç uyarı ürün davranışına ait değildir)

> **PASS, commit / push / deploy yetkisi VERMEZ.** Bu aşama yalnız "entegrasyon tabanı doğru" der. Yayına alma ayrı onay ister.

---

## 1. Başlangıç ve bitiş SHA'ları

| Öğe | Değer |
| --- | --- |
| Entegrasyon branch HEAD | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` |
| Bu aşamada oluşan commit | **yok** (commit yasak) |
| Main branch | `main` |
| Main HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` |

Worktree `0b795ea` üzerinde **sıfır commit** ile ilerledi; tüm iş commit'lenmemiş çalışma ağacında duruyor. Bu, aşamanın kuralıydı ve bilinçli bir sonuçtur.

---

## 2. Frontend tek satır değişikliği

### 2.1 Ne yapıldı

`frontend/src/features/whatsapp/api/whatsappApi.ts` içindeki `LIVE_SESSION_EVENTS` kümesinden **tek üye** çıkarıldı.

```diff
@@ -550,7 +550,6 @@ const LIVE_SESSION_EVENTS = new Set([
   'session_deleted',
   'session_qr_updated',
   'session_sync_completed',
-  'gateway_connected',
 ]);
```

### 2.2 Kanıt: gerçekten tek satır

| Kontrol | Komut | Sonuç |
| --- | --- | --- |
| Boşluk/hata denetimi | `git diff --check` | çıktı yok, **exit 0** |
| Eklenen satır | `git diff --numstat` | **0** |
| Silinen satır | `git diff --numstat` | **1** |
| Hunk sayısı | `git diff` | **1** (`@@ -550,7 +550,6 @@`) |
| Dokunulan dosya | `git diff --name-only` | **1** |

Diff'in tamamı `docs/audits/evidence/5.3.1b/t0-frontend-one-line.diff` (521 B) içinde saklı.

### 2.3 Neden bu satır, neden şimdi

5.1 (`3bf17bf`) bu satırı frontend'de kaldırıyordu; 5.3.1'in BÖLÜM 4'ü yalnız **dört** dosya saydığı için frontend kapsam dışında kalmıştı. Sonuç, 5.3.1 test 4'te ölçülen **iç çelişkiydi**:

- `events.py` `_ACKNOWLEDGED_IGNORE_EVENTS` içinde `gateway_connected` **korunmalı** (BÖLÜM 4 / Dosya 4).
- Parity testi, frontend'in aynı olayı **beklememesini** şart koşuyor.
- İkisi aynı anda ancak frontend satırı silinirse doğru olur.

### 2.4 Davranışsal karşılık: kaybedilen bir şey var mı?

**Hayır.** `gateway_connected` backend tarafından hiç yayınlanmıyor (`_ACKNOWLEDGED_IGNORE_EVENTS` → ACK, broadcast yok), yani tarayıcı soketine hiç ulaşmıyordu; kümedeki varlığı **ölü bir tetikleyiciydi**. Yeniden bağlanma tazelemesi zaten ayrı bir yoldan karşılanıyor:

```
frontend/src/App.tsx:284                      dispatchEvent('tezlify:ws_connected')
frontend/src/features/whatsapp/api/whatsappApi.ts:582   addEventListener('tezlify:ws_connected', handleWsConnected)
frontend/src/features/whatsapp/hooks/useWhatsAppLoadingGate.ts:88
frontend/src/pages/WhatsAppHubPage.tsx:3350
```

### 2.5 Bilinçli olarak DOKUNULMAYAN şey (dürüstlük notu)

`whatsappApi.ts:544-546` yorumu hâlâ `gateway_connected`'ı "gerçek sinyaller" listesinde anıyor:

```
// yaşam döngüsü zaten `/ws` üzerinden gerçek olaylarla akıyor
// (session_connected / session_disconnected / session_qr_updated /
// session_sync_completed / gateway_connected). Yoklama yalnızca bu GERÇEK
```

Bu artık **yanlış bir cümledir**. 5.1 commit'i bu yorumu da yeniden yazmıştı (11+/5−); bu aşamanın kapsamı **tek satır** olduğu için yoruma dokunulmadı. Testi etkilemez: parity testi kümeyi `_FRONTEND_SET_RE = r"LIVE_SESSION_EVENTS\s*=\s*new\s+Set\(\[(.*?)\]\)"` ile, yani yalnız `new Set([...])` gövdesinden okur. **Kozmetik borç olarak kayda geçti**, gizlenmiyor.

---

## 3. Sembolik bağ: §3'ün premisi yanlıştı, düzeltildi

### 3.1 Bulgu

Aşama talimatı bağı şu hedefe kurmamı istiyordu: main'in `whatsapp-gateway/node_modules`. Ölçüm:

```
$ ls -ld whatsapp-gateway/node_modules
drwxr-xr-x  2 isatezcan staff  64 2026-10-04 14:26 whatsapp-gateway/node_modules
$ ls -1A whatsapp-gateway/node_modules | wc -l
0
```

**Hedef boş bir dizin.** Bu hedefe kurulan bağ hiçbir şeyi çözmez — nitekim ilk denemede tam olarak bu oldu:

```
$ node -e "require.resolve('uuid')"          → ÇÖZÜLEMEDİ
$ node -e "require.resolve('whatsapp-rust-bridge')" → ÇÖZÜLEMEDİ
$ node -e "require.resolve('@whiskeysockets/baileys')" → ÇÖZÜLEMEDİ
$ node --input-type=module -e "import('uuid')"  → uuid FAIL: ERR_MODULE_NOT_FOUND
```

### 3.2 Gerçek bağımlılık kaynağı nerede

Repo **kökünde** dolu bir kurulum var:

```
/Users/isatezcan/Documents/Github/Tezlify/node_modules   → 302 girdi
```

Ve gateway bağımlılıkları **gerçek repoda** buradan çözülüyor — tahmin değil, ölçüm:

```
$ cd .../Tezlify/whatsapp-gateway
$ node --input-type=module -e "console.log(import.meta.resolve('uuid'))"
file:///Users/isatezcan/Documents/Github/Tezlify/node_modules/uuid/dist/esm/index.js
$ node --input-type=module -e "console.log(import.meta.resolve('whatsapp-rust-bridge'))"
file:///Users/isatezcan/Documents/Github/Tezlify/node_modules/whatsapp-rust-bridge/dist/index.js
$ node --input-type=module -e "console.log(import.meta.resolve('@whiskeysockets/baileys'))"
file:///Users/isatezcan/Documents/Github/Tezlify/node_modules/@whiskeysockets/baileys/lib/index.js
$ node --input-type=module -e "console.log(import.meta.resolve('@whiskeysockets/baileys/lib/Utils/crypto.js'))"
file:///Users/isatezcan/Documents/Github/Tezlify/node_modules/@whiskeysockets/baileys/lib/Utils/crypto.js
```

Sürümler `whatsapp-gateway/package.json` ile uyumlu:

| Paket | İstenen | Kurulu |
| --- | --- | --- |
| `@whiskeysockets/baileys` | `7.0.0-rc14` | **7.0.0-rc14** |
| `uuid` | `^11.0.3` | 11.1.1 |
| `express` | `^4.21.2` | 4.22.2 |
| `pg` | `^8.13.3` | 8.23.0 |
| `pino` | `^9.5.0` | 9.14.0 |
| `ws` | `^18.18.0` | 8.21.3 |
| `qrcode` | `^1.5.4` | 1.5.4 |
| `dotenv` | `^16.4.7` | 16.6.1 |
| `link-preview-js` | `^3.0.13` | 3.2.0 |

> Not: `whatsapp-rust-bridge` CJS `require.resolve` ile çözülmez (ESM/exports-map tabanlı); gateway ESM olduğu için **doğru prob** `import.meta.resolve` / dinamik `import`. Gerçek `import` denemesi de başarılı: 40 export, `expandAppStateKeys` dahil.

### 3.3 Yapılan düzeltme

**Konum korundu** (talimattaki yol), **hedef düzeltildi**:

```
ln -s /Users/isatezcan/Documents/Github/Tezlify/node_modules \
      /private/tmp/tz531-integration/whatsapp-gateway/node_modules
```

Doğrulama:

```
lrwxr-xr-x  whatsapp-gateway/node_modules -> /Users/isatezcan/Documents/Github/Tezlify/node_modules
readlink    : /Users/isatezcan/Documents/Github/Tezlify/node_modules
hedef girdi : 302
```

Worktree gateway kökünden dört prob da kökten çözüldü (yukarıdaki çıktıların aynısı).

### 3.4 Kural sınırlarına uyum

| Yasak | Durum |
| --- | --- |
| Paket kurma | **Yapılmadı** (node tarafında hiçbir kurulum yok) |
| Lockfile değiştirme | **Yapılmadı** (`package-lock.json` mtime `2026-11-01 22:17`, dokunulmadı) |
| Ağ üzerinden indirme | **Yapılmadı** |
| Main bağımlılıklarını değiştirme | **Yapılmadı** — yalnız okuma yolu |

### 3.5 Kaldırma ve kanıt

```
kaldırma öncesi : lrwxr-xr-x ... node_modules -> /Users/.../Tezlify/node_modules
rm exit         : 0
kaldırma sonrası: YOK — kaldırıldı
main hedefi     : kök girdi 302 (bağ kaldırmak hedefi etkilemez)
worktree durumu : node_modules ile ilgili ?? girdisi YOK
```

### 3.6 ÖNCEKİ RAPORDAKİ İFADE DÜZELTİLMESİ (erratum)

`docs/audits/ASAMA-5.3.1-controlled-integration-base.md` §7.4 şöyle diyordu:

> "Gateway testleri `whatsapp-gateway/node_modules` gerektiriyor (repoda yok). Çalıştırma anında main deposundan geçici bir sembolik bağ kuruldu, iş bitince kaldırıldı."

Bu ifade **yanıltıcıdır** ve düzeltilmesi gerekir:

1. Bağ **kurulmuştu** ama hedefi **boş bir dizindi**; dolayısıyla hiçbir bağımlılığı çözmedi.
2. 5.3.1'de test 5 ve 6 hiç çalıştırılmadığı için bu boşluk **fark edilmedi**. O raporda "bağ kuruldu" denmesi, "bağımlılıklar erişilebilirdi" anlamına gelmiyordu.
3. Doğru kaynak repo **kökündeki** `node_modules`'tür (302 girdi), gateway altındaki dizin değil.

Bu aşamada bağ gerçekten işlevsel hale getirildi ve **test 5 ile 6 fiilen çalıştırıldı** — 5.3.1'in en büyük doğrulama boşluğu böylece kapandı.

---

## 4. Test ortamı

### 4.1 Python yorumlayıcısı — sistemde pytest/sqlalchemy yok

İlk denemede `python scripts/provision_test_db.py` şu hatayı verdi:

```
ModuleNotFoundError: No module named 'sqlalchemy'
```

Sistemdeki hiçbir yorumlayıcıda (`python`, `python3`, `python3.12`, `python3.13`, `/usr/bin/python3`) `sqlalchemy` veya `pytest` **yok**; venv de yok. Diskte `sqlalchemy` dizini bulunamadı.

**Çözüm:** `uv` önbelleğinde (`~/.cache/uv`) `sqlalchemy`, `pytest`, `aiosqlite` mevcut. **Çevrimdışı** modda, ağa çıkmadan ortam kuruldu:

```
uv run --offline --python 3.13 \
  --with-requirements backend/requirements.txt \
  --with pytest --with pytest-asyncio \
  python -c "import sqlalchemy, aiosqlite, pytest; ..."
# → Installed 55 packages in 186ms
# → OK sqlalchemy 2.1.6 | pytest 9.2.0
```

`--offline` bayrağı ağ indirmesini **yapısal olarak** engeller; 186 ms'lik kurulum bunun önbellekten geldiğini doğrular. Worktree'ye `.venv` **konmadı**; ortam uv'nin kendi geçici arşivindedir.

### 4.2 Test veritabanı

Yalnız `/tmp/tz531_test.db` kullanıldı.

```
TEST_DB_PATH=/tmp/tz531_test.db PYTHONPATH=. python scripts/provision_test_db.py
# → provisioned /tmp/tz531_test.db: 34 tables
# → history_sync_states: True / lid_mappings: True / initial_sync_completed_at: True
```

Yerel SQLite olduğunun kanıtı (dosya başlığı):

```
0000000   S   Q   L   i   t   e       f   o   r   m   a   t       3  \0
```

Tablo doğrulaması: **34 tablo**; `messages`, `conversations`, `contacts` var.

> `backend/tests/conftest.py` yalnız **artımlı** migration çalıştırıyor (`ensure_*`), `create_all` yok. Provision atlanırsa testler `no such table: messages` ile setup'ta düşer. 5.3.1'de bu bir kez yaşandı; bu aşamada baştan provision edildi.

### 4.3 Ortam değişkenleri (her testte aynı, log başlığında kayıtlı)

```
DATABASE_URL = sqlite+aiosqlite:////tmp/tz531_test.db
TEST_DB_PATH = /tmp/tz531_test.db
PYTHONPATH   = .
PYTHONDONTWRITEBYTECODE = 1     # worktree'ye __pycache__ yazılmasın
pytest       : -q --no-header -p no:cacheprovider   # .pytest_cache yazılmasın
```

Production veritabanına **hiç bağlanılmadı**.

---

## 5. Altı testin sonuçları

Sıra korunarak, durma kuralı gözetilerek çalıştırıldı. **Altısı da exit 0.**

| # | Test | Komut | Exit | Sonuç | Süre | Log |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Initial sync chunking | `pytest backend/tests/test_whatsapp_initial_sync_chunking.py` | **0** | **6 passed**, 0 failed, 0 skipped | 2,24 s | `evidence/5.3.1b/t1-initial-sync-chunking.log` |
| 2 | Pagination contract | `pytest backend/tests/test_whatsapp_pagination_contract.py` | **0** | **10 passed**, 0 failed, 0 skipped | 1,15 s | `…/t2-pagination-contract.log` |
| 3 | Upsert notify/append (backend) | `pytest backend/tests/test_whatsapp_upsert_append.py` | **0** | **17 passed**, 0 failed, 0 skipped | 10,12 s | `…/t3-upsert-append.log` |
| 4 | Event contract parity | `pytest backend/tests/test_whatsapp_event_contract_parity.py` | **0** | **12 passed**, 0 failed, 0 skipped | 1,12 s | `…/t4-parity.log` |
| 5 | Bulk seq pagination guarantees | `node whatsapp-gateway/scripts/test-bulk-seq-pagination-guarantees.mjs` | **0** | **PASS (32 checks)** | — | `…/t5-bulk-seq-pagination-guarantees.log` |
| 6 | Upsert notify/append (gateway) | `node whatsapp-gateway/scripts/test-upsert-notify-append.mjs` | **0** | **13/13 PASS** | — | `…/t6-upsert-notify-append.log` |

**Toplam:** 45 pytest testi + 45 node kontrolü, **0 hata, 0 skip**.

### 5.1 Test 4 — bu aşamanın asıl hedefi

5.3.1'de `2 failed, 10 passed` idi. Aynı test, tek satırlık düzeltmeden sonra **gerçek entegrasyon worktree'sinde** yeniden çalıştırıldı (probe kopyası değil):

```
collected 12 items
backend/tests/test_whatsapp_event_contract_parity.py ............        [100%]
======================== 12 passed, 1 warning in 1.12s =========================
### EXIT: 0
```

Düşen iki test artık geçiyor:
- `test_gateway_connected_is_not_awaited_by_the_frontend`
- `test_every_frontend_expected_event_is_actually_forwarded`

5.3.1'deki `/tmp/tz531-probe` deneyi (12/12) bu aşamada **referans** olarak kaldı; yukarıdaki çıktı teslim worktree'sinin kendisinden alındı.

### 5.2 Test 5 — 4.17 garantilerinin tam listesi (32 kontrol)

Çıktıdan doğrulanan başlıklar:

| Alan | Kontroller |
| --- | --- |
| Epoch / imleç | `4.` eşleşen epoch imleci sıfırlamaz · `11b.` iki store epoch paylaşmaz · `11c.` eski süreçten kalan epoch yeniden tarar, boş dönmez · `11d.` reset sonrası sonraki çağrı yeni epoch'tan devam eder |
| Kapasite / tahliye | `6a.` tam `MESSAGES_PER_CHAT_MAX` kayıt tahliyesiz sığar · `6b.` dolu sohbet seq imleciyle tamamen erişilebilir · `7a.` 2001. mesaj en eskisini tahliye eder · `7b.` tahliye edilmiş kaydı geçmiş imleç temiz ilerler |
| Trim yarışı | `12a.` sayfalar arasında ekleme imleci oynatmadan en eskisini budar · `8.` budanmış kayda işaret eden imleç hayatta kalan ilk kayıtta devam eder |
| Tekillik | `9.` hiçbir iki kayıt aynı `_seq`'i paylaşmaz · `S1.` `_seq` serileştirilmiş payload'a **sızmaz** |
| Çok sohbet / filtre | `13a.` jid filtresi yokken tek global imleç · `13b.` jid filtresi kümeyi daraltır, imleci bozmaz · `14.` mesajsız filtrelenmiş sohbet boş ve bitmiş sayfa döner |
| `perChatLimit` | `15a.` seq sayfasını **kesmez** (sessiz atlama yok) · `15b.` offset modunda eski davranış korunur |
| Geriye uyum | `B1.` `afterSeq` göndermeyen istemci eski offset sözleşmesini alır · `B2.` offset sayfalama tüm store'u yürür · `B3.` yalnız `since` kullanan istemci seq işinden etkilenmez · `B4.` `seqEpoch` olmadan `afterSeq` ilk sayfayı verir · `B5.` yalnız `perChatLimit` kullanan istemci en-yeni-N sözleşmesini korur |
| Ölçek / yarış | `L1.` 5000 ingest sonrası RAM'de tam `MESSAGES_PER_CHAT_MAX` · `L2.` 5000 kayıtlık boşaltma her hayatta kalan kayda **tam bir kez** ulaşır · `L3.` `perChatLimit` altında 5000 kayıt yine tam kümeyi verir · `R1.` eşzamanlı ingest+trim çoğaltma veya geri sarma üretmez |
| `since` | `S2.` seq modunda `since` hâlâ onurlandırılır |

Bu testin 5.3.1'de **hiç çalıştırılmamış** olması, entegrasyon tabanının en büyük kanıt boşluğuydu. Kapandı.

### 5.3 Test 6 — notify/append sözleşmesi (13 kontrol)

```
PASS  notify emits message_new with upsert_type=notify
PASS  notify increments unread
PASS  append still emits message_new (backend must persist it)
PASS  append does NOT increment unread
PASS  append reports the unchanged badge (not a bump)
PASS  append does not move last_message_preview
PASS  append does not move last_message_at
PASS  unknown type is not treated as append
PASS  unknown type increments unread (notify fallback)
PASS  socket-events forwards upsert type=append
PASS  socket-events append does not increment unread
PASS  socket-events forwards upsert type=notify
PASS  socket-events notify increments unread
```

Son iki blok **uçtan uca**dır: `ev.emit('messages.upsert', {type})` → `socket-events` → `_ingestUpsertMessage`. Yani "type plumbing" gerçekten çalışıyor; yalnız iç fonksiyonu doğrudan çağıran bir test olsaydı bu kanıtlanmamış olurdu.

### 5.4 Uyarılar (hata değil)

| Uyarı | Kaynak | Değerlendirme |
| --- | --- | --- |
| `PytestDeprecationWarning: asyncio_default_fixture_loop_scope unset` | `pytest-asyncio` plugin | **Önceden var olan yapılandırma boşluğu.** `pytest.ini`/`pyproject` içinde açıkça ayarlanmamış. Gelecekteki pytest-asyncio sürümleri varsayılanı `function` yapacak. Test sonucunu etkilemiyor. |
| `DeprecationWarning: There is no current event loop` | `backend/tests/conftest.py:117` | Test altyapısına ait, ürün koduna ait değil. 5.3.1'de de aynıydı. |

---

## 6. 4.17 ve 5.2 koruma denetimi — sembol değil, kod yolu

Test sonuçları tek başına yeterli değil; korumaların **gerçekten yerinde** olduğu kod üzerinden de doğrulandı.

### 6.1 4.17 — dokunulmamış dosya

```
$ git status --porcelain -- whatsapp-gateway/src/messages/message-store.js
(boş)
```

`message-store.js` **hiç değişmedi**. 4.17'nin çekirdeği burada:

| Sembol | Satır sayısı | Rol |
| --- | --- | --- |
| `nextMessageSeq` | 3 | monoton sayaç |
| `stampMessageSeq` | 2 | `_seq`'i non-enumerable olarak damgalar |
| `ensureMessageSeq` | 2 | okuma anında damgalama ("geç ziyaret, sessiz atlama değil") |
| `storeSeqEpoch` | 1 | epoch saklama |
| `messageSeqOf` | 2 | okuma |
| `ramCapacitySnapshot` | 1 | kapasite gözlemi |

### 6.2 4.17 — yazma sırası bozulmadı

`session-manager.js` içinde üretim yazma yolunun sırası **aynen** duruyor:

```js
2566:      chatMsgs.push(stampMessageSeq(store, record));
2567:      trimChatMessages(store, key, chatMsgs);
2568:      boundMessagesByChat(store, key);
```

Bu üç satır 5.3.1'de de dokunulmamıştı; bu aşamada frontend dışında hiçbir üretim dosyası değişmediği için değişmedi.

### 6.3 4.17 — okuma yolu

| Sembol | `session-manager.js` |
| --- | --- |
| `epochReset` | 3 |
| `afterSeq` | 6 |
| `seqEpoch` | 2 |
| `stampMessageSeq` | 5 |
| `trimChatMessages` | 4 |
| `boundMessagesByChat` | 3 |
| `listAllMessages` | 1 |

### 6.4 5.2 — `_touchChat` yalnız GELEN yolda `append` alıyor

```
2575:  this._touchChat(session, key, chatPreview, record.created_at, { append: isAppend });   ← gelen
2699:  this._touchChat(session, key, buildChatPreview(...), msg.created_at);                   ← giden (4 arg)
```

Giden yolun `append` almaması **doğrudur**: giden mesaj bir "geçmiş eki" değil, kendi canlı olayıdır.

### 6.5 5.2 — `_touchChat` gövdesi: append önizlemeyi/damgayı oynatmaz

```js
2983:  const nextPreview = append
2984:    ? (existing.last_message_preview || '')
2985:    : (preview && !tsOlder ? preview : existing.last_message_preview || '');
2986:  const nextTs = append
2987:    ? (existing.last_message_at || newTs)
2988:    : (tsOlder ? existing.last_message_at : newTs);
```

Sohbet hiç bilinmiyorsa yine oluşturulur (`|| newTs`) — mesajın duracak bir yeri olmalı. Bu, test 6'nın `append does not move last_message_at` kontrolüyle birlikte doğrulandı.

### 6.6 5.2 — rozet mantığı

```js
2588:  if (chat && !fromMe && !isAppend) { ... chat.unread_count += 1 ... }
2594:  record.unread_count = chat?.unread_count ?? (fromMe || isAppend ? 0 : 1);
```

`append` rozeti **artırmaz**; mevcut değeri olduğu gibi raporlar. Test 6 bunu iki ayrı kontrolle sabitliyor (`does NOT increment` + `reports the unchanged badge`).

### 6.7 5.2 — `type` plumbing (tek geçiş noktası)

```
socket-events.js:560   await manager._ingestUpsertMessage(msg, sock, id, { upsertType: type });  ← messages.upsert
socket-events.js:1243  await manager._ingestUpsertMessage(msg, sock, id);                        ← messages.update (bilinçli 3 arg)
```

`messages.update`'in `notify` varsayılanında kalması bilinçlidir: o olay yeni mesaj değil, mevcut kaydın güncellemesidir.

### 6.8 5.2 — backend `_no_broadcast` üç dönüş yolu

| Yol | Satır | Ne zaman |
| --- | --- | --- |
| Dedup (`return event # dedup`) | `events.py:1008` | aynı mesaj ikinci kez geldi |
| `IntegrityError` kurtarma | `events.py:1107` | eşzamanlı yazıcı yarışı kaybetti, kaydı devraldı |
| Normal persist dönüşü | `events.py:1203` | mutlu yol |

Üçü de kapatılmış — biri eksik olsaydı append olayı o yolda canlı gibi yayınlanırdı. Tüketim tarafı:

```
main.py:771   if persisted.get("_no_broadcast") is True:  → ACK + return (broadcast yok)
```

`_no_broadcast` **commit'ten sonra** okunur; bu yüzden SQLite/test yolunda da persist gerçekten commit edilir (`_skip`'in bilinen tuzağı burada yok).

### 6.9 5.2 — `gateway_connected` ACK edilir, yayınlanmaz

```
events.py:131    _ACKNOWLEDGED_IGNORE_EVENTS: FrozenSet[str] = frozenset({"gateway_connected"})
events.py:304    def _acknowledge_without_broadcast(event, reason)
events.py:2872   elif evt in _ACKNOWLEDGED_IGNORE_EVENTS:
events.py:2957   and not result.get("_no_broadcast")     ← webhook kapısı
```

### 6.10 5.2 — `is_append` kapıları (backend)

| Satır | Kapı |
| --- | --- |
| 905 | `upsert_type` normalizasyonu |
| 1007 / 1106 / 1202 | üç `_no_broadcast` işaretlemesi |
| 1122 | `if not (is_append and not msg.get("created_at")): apply_last_message(...)` |
| 1124 | `if direction == INBOUND and not is_append:` |

1122'deki kapı özellikle önemli: `apply_last_message` içindeki `ts <= cur` reddi, `created_at` yoksa `utc_now_naive()` fallback'iyle zamansız geçmişi "şimdi" yapardı. Kapı, bu tuzağı yapısal olarak kapatıyor.

---

## 7. Main çalışma alanının değişmediğine dair kanıt

Başlangıç ve bitiş **birebir aynı**:

| Ölçüm | Başlangıç | Bitiş | Fark |
| --- | --- | --- | --- |
| branch | `main` | `main` | — |
| HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | — |
| staged | 0 | 0 | 0 |
| ` M` | 24 | 24 | 0 |
| `??` | 61 | 61 | 0 |
| dirty toplam | 85 | 85 | 0 |

Main bağımlılıkları da değişmedi:

```
kök node_modules girdi     : 302  (beklenen 302)
gateway node_modules girdi : 0    (beklenen 0)
gateway node_modules tipi  : drwxr-xr-x, mtime 2026-10-04 14:26  (aynı düz dizin)
git status | grep node_modules : girdi YOK
```

Sembolik bağ yalnız worktree tarafında oluşturuldu ve kaldırıldı; hedefe **yazma** hiç yapılmadı.

---

## 8. Değişen dosyaların tam listesi

### 8.1 Üretim kodu — bu aşamada 1 dosya

| Dosya | Değişim |
| --- | --- |
| `frontend/src/features/whatsapp/api/whatsappApi.ts` | **0 ekleme / 1 silme** |

### 8.2 Üretim kodu — 5.3.1'den devralınan 4 dosya (bu aşamada değişmedi)

| Dosya | Değişim (5.3.1) |
| --- | --- |
| `backend/app/main.py` | +17 |
| `backend/app/services/whatsapp/orchestration/events.py` | +92/−11 |
| `whatsapp-gateway/src/session-manager.js` | +41/−11 |
| `whatsapp-gateway/src/socket/socket-events.js` | +7/−2 |

### 8.3 Test dosyaları — 3 yeni (5.3.1'den, değişmedi)

| Dosya | Boyut |
| --- | --- |
| `backend/tests/test_whatsapp_event_contract_parity.py` | 13.031 B |
| `backend/tests/test_whatsapp_upsert_append.py` | 22.446 B |
| `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` | 6.325 B |

### 8.4 Rapor + kanıt

| Yol | İçerik |
| --- | --- |
| `docs/audits/ASAMA-5.3.1-controlled-integration-base.md` | 5.3.1 raporu (değişmedi; erratum bu raporda) |
| `docs/audits/ASAMA-5.3.1b-frontend-event-parity.md` | **bu rapor** |
| `docs/audits/evidence/5.3.1b/provision.log` | DB provision (513 B) |
| `…/t0-frontend-one-line.diff` | tek satır diff (521 B) |
| `…/t1-initial-sync-chunking.log` | 1.653 B |
| `…/t2-pagination-contract.log` | 1.664 B |
| `…/t3-upsert-append.log` | 1.627 B |
| `…/t4-parity.log` | 1.797 B |
| `…/t5-bulk-seq-pagination-guarantees.log` | 4.641 B |
| `…/t6-upsert-notify-append.log` | 1.262 B |

### 8.5 Worktree son durumu

```
 M backend/app/main.py
 M backend/app/services/whatsapp/orchestration/events.py
 M frontend/src/features/whatsapp/api/whatsappApi.ts
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js
?? backend/tests/test_whatsapp_event_contract_parity.py
?? backend/tests/test_whatsapp_upsert_append.py
?? docs/audits/ASAMA-5.3.1-controlled-integration-base.md
?? docs/audits/evidence/
?? whatsapp-gateway/scripts/test-upsert-notify-append.mjs

staged: 0    dirty: 10
```

`.gitignore` **değiştirilmedi**, `git add -f` **kullanılmadı**, hiçbir kanıt gizlenmedi. `__pycache__` ve `.pytest_cache` oluşmadı (`PYTHONDONTWRITEBYTECODE=1`, `-p no:cacheprovider`).

> Not: `docs/audits/evidence/` altındaki `.log` dosyaları `.gitignore:40` (`*.log`) nedeniyle **plain `git add` ile eklenemez**. Bu aşamada commit yasak olduğu için sorun değil; commit aşamasında kanıtın nasıl ele alınacağı ayrıca kararlaştırılmalı (force-add yasak).

---

## 9. Açık riskler ve doğrulanamayan noktalar

| # | Konu | Durum | Etki |
| --- | --- | --- | --- |
| R1 | `whatsappApi.ts:544-546` yorumu hâlâ `gateway_connected`'ı sayıyor | **Yanlış cümle**, bilinçli bırakıldı (kapsam = 1 satır) | Davranış yok; kozmetik. 5.3.2'de tek satırlık düzeltme adayı. |
| R2 | Testler 5 ve 6 yalnız sembolik bağ varken çalışır | Bağ kaldırıldı | Tekrarlanabilirlik için `ln -s /Users/.../Tezlify/node_modules whatsapp-gateway/node_modules` gerekir; komut §3.3'te. |
| R3 | Sistemde pytest/sqlalchemy yok; `uv --offline` önbelleğine bağımlı | Önbellek mevcut | Önbellek temizlenirse ağ gerekir. CI'da açık bağımlılık kurulumu şart. |
| R4 | `pytest-asyncio` `asyncio_default_fixture_loop_scope` ayarsız | Önceden var | Gelecek sürümlerde varsayılan değişir; sessiz davranış değişimi riski. |
| R5 | Test 4 ve 6 yalnız `notify`/`append` sözleşmesini kapsıyor | Kapsam sınırı | `messages.update` (1243) hâlâ `notify` varsayılanı — pre-existing, bu aşamada değişmedi. |
| R6 | Frontend değişikliği için `tsc`/build çalıştırılmadı | Yapılmadı | Değişiklik bir küme üyesi silmekten ibaret; parity testi kümeyi parse edip büyüklüğünü doğruladı (`test_parsers_found_the_expected_magnitude` geçti). Yine de tam build ayrı doğrulama ister. |
| R7 | Bu taban `main` değil `0b795ea` üzerine kurulu | Tasarım gereği | `main` 4.17'yi (`stampMessageSeq`, `epochReset`, `_bulk_chunks`) içermiyor; bu taban onları içeriyor. `main`'e geri birleştirme **ayrı** bir iştir. |
| R8 | Persistence döngüsü hâlâ KAPALI | Değişmedi | Bu aşama persistence'ı açmadı; 4.27 sahada uykuda. |

**Doğrulanamayan:** Gerçek bir WhatsApp bağlantısı üzerinden canlı `append` olayı bu aşamada üretilmedi (canlı E2E = 4.34, hâlâ yapılmadı). Testler sözleşmeyi ve kod yollarını doğrular; saha davranışını değil.

---

## 10. KARAR

# `PASS`

### 10.1 PASS ölçütlerinin tek tek karşılanması

| # | Ölçüt | Sonuç | Kanıt |
| --- | --- | --- | --- |
| 1 | Frontend değişikliği **tam olarak tek satır** | **EVET** | 0+/1−, tek hunk, `diff --check` temiz (§2.2) |
| 2 | Altı testin **tamamı exit 0** | **EVET** | 6/6, §5 tablosu |
| 3 | 4.17 regresyonu yok | **EVET** | test 1, 2, 5 yeşil; yazma sırası 2566-2568 yerinde; `message-store.js` dokunulmadı (§6.1–6.3) |
| 4 | 5.2 regresyonu yok | **EVET** | test 3, 6 yeşil; üç `_no_broadcast` yolu, rozet, önizleme, `type` plumbing yerinde (§6.4–6.10) |
| 5 | Main çalışma alanı değişmedi | **EVET** | branch/HEAD/staged/M/??/dirty birebir aynı; node_modules 302/0 (§7) |
| 6 | Sembolik bağ kaldırıldı | **EVET** | `rm` exit 0, sonrası "YOK", hedef 302 (§3.5) |
| 7 | Yasak Git/production işlemi yok | **EVET** | commit/push/deploy/merge/rebase/cherry-pick/branch değişimi/reset/checkout/clean/restore/stash **hiçbiri**; production DB'ye bağlanılmadı; servis yeniden başlatılmadı; persistence döngüsü açılmadı |
| 8 | Rapor + kanıt tam | **EVET** | 10 bölüm + 8 kanıt dosyası; `.gitignore` değişmedi, force-add yok, kanıt gizlenmedi |

### 10.2 Bu PASS neyi söyler, neyi söylemez

**Söyler:** `integration/whatsapp-5.3-seq-safe` tabanı, 4.17 pagination/epoch korumaları ile 5.2 notify/append davranışını **birlikte** taşıyor ve bu, altı bağımsız testle doğrulandı. 5.3.1'in iki açığı (frontend parity satırı, test 5/6'nın hiç çalıştırılmamış olması) kapandı.

**Söylemez:**
- Commit, push veya deploy izni **vermez**.
- `main`'e birleştirme izni **vermez** — bu taban `0b795ea` üzerinedir, `main` değildir.
- Canlı WhatsApp davranışının doğrulandığını **söylemez** (4.34 hâlâ yapılmadı).
- Persistence döngüsünün açılabileceğini **söylemez**.

### 10.3 Önerilen sonraki mikroadım

**AŞAMA 5.3.2 — `gateway_connected` yorumunun düzeltilmesi ve test tabanının commit'e hazırlanması.** Gerekçe: tek gerçek eksik, `whatsappApi.ts:544-546`'daki artık yanlış olan yorum cümlesidir; bu, bir sonraki commit'in içeriğini kirletmeden kapatılmalı. Ayrıca `.log` kanıtlarının commit'te nasıl ele alınacağı (force-add yasak olduğu için) bu aşamada kararlaştırılmalı.

**Alternatif (daha yüksek değer, daha yüksek risk):** doğrudan **4.34 canlı E2E kabul** aşamasına geçmek. Bu, sözleşme testlerinin kapsamadığı tek alanı (gerçek bağlantıda `append` akışı) kapatır; ancak persistence döngüsünün açılmasını gerektirdiği için ayrı ve daha sıkı bir güvenlik çerçevesi ister.

**Önerim:** 5.3.2 (küçük, düşük riskli, borcu kapatır) → ardından 4.34.

---

## Tamamlama kontrolü

- [x] §1 çalışma alanı ve güvenlik denetimi
- [x] §2 tek satır frontend düzeltmesi + diff kanıtı
- [x] §3 sembolik bağ: kurulum, hedef düzeltmesi, erişilebilirlik, kaldırma kanıtı
- [x] §4 test ortamı: yalnız `/tmp/tz531_test.db`, yerel SQLite, production DB yok
- [x] §5 altı test sırayla, durma kuralı gözetilerek, 6/6 exit 0
- [x] §6 4.17 ve 5.2 korumaları kod yolu + test sonucu üzerinden
- [x] §7 main durumu başlangıçla birebir aynı
- [x] §8 rapor + kanıt; `.gitignore` değişmedi, force-add yok
- [x] Yasak işlemlerin hiçbiri yapılmadı
- [x] 5.3.1 raporundaki yanıltıcı ifade düzeltildi (§3.6)
