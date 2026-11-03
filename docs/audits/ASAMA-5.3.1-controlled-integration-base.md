# AŞAMA 5.3.1 — KONTROLLÜ ENTEGRASYON TABANI VE 4.17 + 5.2 BİRLEŞTİRME

**Tarih:** 2026-11-01 22:17–22:40 (+03)
**Worktree:** `/private/tmp/tz531-integration`
**Branch:** `integration/whatsapp-5.3-seq-safe`
**Taban:** `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae`
**Commit:** **0** (bu aşamada commit yapılmadı — yasak)

---

## 1. Başlangıç ve bitiş SHA'ları

| Öğe | Başlangıç | Bitiş | Değişti mi? |
| --- | --- | --- | --- |
| `main` branch | `main` | `main` | **HAYIR** |
| `main` HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | **HAYIR** |
| `main` staged | 0 | 0 | **HAYIR** |
| `main` dirty | 85 (24 `M` + 61 `??`) | 85 (24 `M` + 61 `??`) | **HAYIR** |
| Yeni worktree HEAD | `0b795ea…` | `0b795ea…` | **HAYIR** (çalışma ağacı değişti, HEAD değil) |
| Yeni branch | — | `integration/whatsapp-5.3-seq-safe` | oluşturuldu |

**Zorunlu ön koşul:** `git merge-base --is-ancestor 20c88bb 0b795ea` → **EVET**. Sağlandı, entegrasyona başlandı.

---

## 2. Main çalışma alanının değişmediğine dair kanıt

Her Git işleminden önce ve sonra kaydedildi. Karşılaştırma:

| Kontrol | Önce | Sonra | Sonuç |
| --- | --- | --- | --- |
| `git branch --show-current` | `main` | `main` | ✔ |
| `git rev-parse HEAD` | `e7f1077…` | `e7f1077…` | ✔ |
| `git status --porcelain \| wc -l` | 85 | 85 | ✔ |
| `M` sayısı | 24 | 24 | ✔ |
| `??` sayısı | 61 | 61 | ✔ |
| `git diff --cached` | 0 | 0 | ✔ |

`git worktree add` yalnız `.git/worktrees/` altına meta veri yazar; main'in çalışma ağacına ve indeksine dokunmaz. Hiçbir kullanıcı dosyası yeni dala taşınmadı — worktree `0b795ea`'dan **temiz** checkout ile doğdu (`git status --short` boş).

**Yasaklı işlemler:** `reset --hard` 0 · `clean` 0 · `checkout --` 0 · `restore` 0 · `stash` 0 · `add -A` 0 · `merge` 0 · `rebase` 0 · `cherry-pick` 0 · `commit` 0 · `push` 0 · deploy 0.

---

## 3. Yeni worktree ve branch

```
$ git worktree add -b integration/whatsapp-5.3-seq-safe \
      /private/tmp/tz531-integration 0b795ea692cd1fa2d1e78563bff5a1f91b7820ae
Preparing worktree (new branch 'integration/whatsapp-5.3-seq-safe')
HEAD is now at 0b795ea fix(whatsapp): chunk initial sync by jids and reset seq cursor on epoch change
```

| Doğrulama | Beklenen | Ölçülen |
| --- | --- | --- |
| Dizin main dışında mı | evet | `/private/tmp/tz531-integration` ✔ |
| Dizin önceden var mıydı | hayır | `YOK` (kontrol edildi, hiçbir klasör silinmedi) ✔ |
| Branch adı önceden var mıydı | hayır | `branch yok` ✔ |
| HEAD | `0b795ea…` | `0b795ea…` ✔ |
| Branch | `integration/whatsapp-5.3-seq-safe` | aynı ✔ |
| Başlangıç temizliği | temiz | `git status --short` boş ✔ |

---

## 4. 4.17 korumalarının doğrulanması

Worktree'de `git grep -c` ile ölçüldü — **14/14 sembol mevcut**:

| Sembol | Konum |
| --- | --- |
| `nextMessageSeq` | `message-store.js`×3 |
| `stampMessageSeq` | `message-store.js`×2, `session-manager.js`×5, `socket-events.js`×3 |
| `messageSeqOf` | `message-store.js`×2, `session-manager.js`×4 |
| `ensureMessageSeq` | `message-store.js`×2, `session-manager.js`×2 |
| `storeSeqEpoch` | `message-store.js`×1, `session-manager.js`×2 |
| `_seqEpoch` | `message-store.js`×3 |
| `_messageSeq` | `message-store.js`×4, `session-manager.js`×1 |
| `afterSeq` | `index.js`×3, `session-manager.js`×6 |
| `seqEpoch` | `index.js`×3, `message-store.js`×3, `session-manager.js`×2 |
| `epochReset` | `session-manager.js`×3 |
| `epoch_reset` | `memory_persistence.py`×7 |
| `_bulk_chunks` | `orchestration/sync.py`×2 |
| `_SYNC_BULK_PAGE_SIZE` | `orchestration/sync.py`×4 |
| `_SYNC_PER_CHAT_LIMIT` | `config.py`×2, `main.py`×1, `memory_persistence.py`×1, `orchestration/sync.py`×6, `whatsapp_service.py`×1 |

**Yol düzeltmesi (raporlanması zorunlu):** aşama metninde geçen iki yol repoda farklı:

| Metindeki yol | Gerçek yol |
| --- | --- |
| `backend/app/services/whatsapp/whatsapp_gateway.py` | `backend/app/services/whatsapp_gateway.py` |
| `backend/app/services/whatsapp/sync.py` | `backend/app/services/whatsapp/orchestration/sync.py` |

Benzer isimli başka dosya seçilmedi; gerçek dosyalar kullanıldı. Her ikisi de **değiştirilmedi**.

---

## 5. Dört dosyadaki 5.2 yeniden uygulama özeti

Toplam: **4 dosya, +146 / −11**. Main'in kendi 5.2 deltasıyla satır satır aynı.

### 5.1 `whatsapp-gateway/src/socket/socket-events.js` (+7/−2)

Tek hunk. `messages.upsert` dinleyicisi `type`'ı zaten destructure ediyordu (yalnız hata tanılamasında kullanıyordu). Artık `_ingestUpsertMessage`'a geçiriyor:

```js
await manager._ingestUpsertMessage(msg, sock, id, { upsertType: type });
```

`messages.update` işleyicisi (`_ingestUpsertMessage(msg, sock, id)` — 3 argüman) **bilinçli olarak değiştirilmedi**; `upsertType` varsayılanı `'notify'`.

### 5.2 `whatsapp-gateway/src/session-manager.js` (+41/−11)

Dört hunk:

1. **İmza + normalizasyon:** `_ingestUpsertMessage(msg, sock, sessionId, { upsertType = 'notify' } = {})`; `normalizedUpsertType` (lowercase), `isAppend`, bilinmeyen türde `logger.debug`.
2. **`_touchChat` çağrısı:** `{ append: isAppend }` eklendi. Yalnız **gelen** çağrı (satır ~2575); giden yoldaki ikinci çağrı (~2695) 4 argümanla kalıyor ⇒ `append=false` varsayılanı.
3. **Unread bloğu:** `if (chat && !fromMe && !isAppend)`; `record.unread_count = chat?.unread_count ?? (fromMe || isAppend ? 0 : 1)`; `emitEvent`'e `upsert_type: normalizedUpsertType`.
4. **`_touchChat` tanımı:** `{ append = false } = {}`; `nextPreview`/`nextTs` append'te mevcut değeri korur (sohbet hiç yoksa `newTs` ile oluşturulur).

### 5.3 `backend/app/main.py` (+17)

`_no_broadcast` dalı `_duplicate`/`_skip` dalından **sonra**, `ws_manager.broadcast`'ten **önce**: persist edilmiş olay ACK edilir (`counters["acked"]`), `counters["skipped"]` artar, `logger.debug`, `return`. Normal akış (broadcast + ACK) **tek satır değişmedi**.

**Uygulanmayan hunk (kritik):** `git diff 0b795ea main -- backend/app/main.py` **iki** hunk içeriyor. İkincisi `metrics_check()`'ten `whatsapp_memory_persistence` alanını **siliyor** — bu 5.2'ye ait değil, 4.x gözlemlenebilirliğinin geri alınması. **Uygulanmadı.** Dosya bütün olarak kopyalansaydı `/metrics`'ten persistence durumu sessizce kaybolacaktı.

### 5.4 `backend/app/services/whatsapp/orchestration/events.py` (+92/−11)

Dokuz hunk, tamamı 5.1 + 5.2 kapsamında (yabancı hunk yok):

| # | İçerik | Kaynak |
| --- | --- | --- |
| 1 | `_ACKNOWLEDGED_IGNORE_EVENTS = {"gateway_connected"}` + gerekçe bloğu | 5.1 |
| 2 | `_acknowledge_without_broadcast()` (`_skip` işaretini yeniden kullanır) | 5.1 |
| 3 | `upsert_type` normalizasyonu; bilinmeyen tür → `logger.warning` + `notify` | 5.2 |
| 4 | Duplicate append → `event["_no_broadcast"] = True` | 5.2 |
| 5 | IntegrityError kurtarma → `recovered["_no_broadcast"] = True` | 5.2 |
| 6 | `apply_last_message` yalnız `not (is_append and not created_at)`; unread yalnız `INBOUND and not is_append` | 5.2 |
| 7 | Normal dönüş → `event["_no_broadcast"] = True` | 5.2 |
| 8 | Dispatch zincirine `_ACKNOWLEDGED_IGNORE_EVENTS` dalı | 5.1 |
| 9 | Webhook tetikleyicisine `and not result.get("_no_broadcast")` | 5.2 |

**Neden temiz uygulandı:** `0b795ea`'nın `events.py` blob'u (`4aa267f`) tam olarak main'in 5.1 öncesi hâli. Yani bu dosyada release ile main **aynı tabanı** paylaşıyor; delta çakışmasız.

---

## 6. 4.17 / 5.2 çakışmalarının gerçek diff analizi

### 6.1 `session-manager.js` — metinsel çakışma YOK, anlamsal tuzak VAR

İki sürümün `_ingestUpsertMessage` gövdesi **aynı fonksiyonda** farklı satırlarda ayrışıyor:

| Bölge | `0b795ea` (4.17) | `main` (4.17 öncesi) |
| --- | --- | --- |
| Mesajı store'a yazma | `chatMsgs.push(stampMessageSeq(store, record));`<br>`trimChatMessages(store, key, chatMsgs);`<br>`boundMessagesByChat(store, key);` | `chatMsgs.push(record);`<br>`if (chatMsgs.length > 2000) { chatMsgs.splice(0, chatMsgs.length - 2000); }`<br>`boundMessagesByChat(store, key);` |
| Giden mesaj yolu | `stampMessageSeq` + `trimChatMessages` + `bound` | `if (outList.length > 2000) …` + `bound` |
| Tarih senkron yolu | `stampMessageSeq` + `trimChatMessages` | `if (phoneMsgs.length > 2000) …` |
| Import | `stampMessageSeq`, `trimChatMessages` var | **ikisi de yok** |

**Sonuç:** 5.2'nin dört hunk'ı bu satırlara **değmiyor** ⇒ metinsel çakışma yok, `git apply` temiz geçti. Ama main'in aynı fonksiyonu 4.17'yi **içermiyor**; fonksiyon bütün olarak main'den kopyalansaydı `stampMessageSeq` ve `trimChatMessages` **sessizce silinirdi** ve hiçbir test bunu yakalamazdı (main'de bu testler yok). Bu yüzden birleştirme hunk düzeyinde yapıldı, fonksiyon düzeyinde değil.

**Doğrulama:** `git diff -U0 -- session-manager.js | grep -E "stampMessageSeq|trimChatMessages|boundMessagesByChat|listAllMessages|seqMode|afterSeq|seqEpoch|epochReset"` → **hiçbir satır**. 4.17'nin tamamı yerinde.

### 6.2 `events.py` — çakışma yok

Blob eşitliği nedeniyle delta birebir uygulandı. Doğrulama: worktree'deki sembol sayıları main ile aynı.

### 6.3 `main.py` — **istemsiz ikinci hunk reddedildi**

Yukarıda §5.3. Bu, aşamanın en somut "körlemesine uygulama" tuzağıydı.

### 6.4 Dokunulmaması gereken beş dosya

| Dosya | Durum |
| --- | --- |
| `whatsapp-gateway/src/messages/message-store.js` | **DEĞİŞMEDİ** |
| `whatsapp-gateway/src/index.js` | **DEĞİŞMEDİ** |
| `backend/app/services/whatsapp_gateway.py` | **DEĞİŞMEDİ** |
| `backend/app/services/whatsapp/memory_persistence.py` | **DEĞİŞMEDİ** |
| `backend/app/services/whatsapp/orchestration/sync.py` | **DEĞİŞMEDİ** |

---

## 7. Altı testin sonuçları

### 7.1 Ortam hazırlığı (test öncesi, zorunlu)

`backend/tests/conftest.py` yalnız **artımlı migration** çalıştırıyor (`ensure_*`); `create_all` yok. Şema önceden provision edilmezse testler `no such table: messages` ile **setup aşamasında** düşüyor. İlk denemede tam olarak bu oldu (6/6 ERROR) — bu bir ürün hatası değil, **ortam eksikliğiydi**. Çözüm:

```
TEST_DB_PATH=/tmp/tz531_test.db PYTHONPATH=. python scripts/provision_test_db.py
# → provisioned /tmp/tz531_test.db: 34 tables

export DATABASE_URL="sqlite+aiosqlite:////tmp/tz531_test.db"
export TEST_DB_PATH=/tmp/tz531_test.db PYTHONPATH=.
```

`conftest.py` `DATABASE_URL` ile `TEST_DB_PATH`'in aynı dosyayı göstermesini zorunlu kılıyor; ikisi de verildi. Yerel SQLite; **production DB'ye hiç bağlanılmadı**.

**Eksik test dosyaları:** üç test `0b795ea`'da **yok** (main'de üretilmiş). BÖLÜM 5'in izin verdiği şekilde main'den alındı, uyarlanmadı:

| Dosya | Boyut |
| --- | --- |
| `backend/tests/test_whatsapp_upsert_append.py` | 22.446 B |
| `backend/tests/test_whatsapp_event_contract_parity.py` | 13.031 B |
| `whatsapp-gateway/scripts/test-upsert-notify-append.mjs` | 6.325 B |

### 7.2 Sonuçlar

| # | Test | Exit | Sonuç | Log |
| --- | --- | --- | --- | --- |
| 1 | `pytest backend/tests/test_whatsapp_initial_sync_chunking.py` | **0** | **6 passed**, 0 failed, 0 skipped (1,46 s) | `docs/audits/evidence/5.3.1/t1-initial-sync-chunking.log` |
| 2 | `pytest backend/tests/test_whatsapp_pagination_contract.py` | **0** | **10 passed**, 0 failed, 0 skipped (0,58 s) | `…/t2-pagination-contract.log` |
| 3 | `pytest backend/tests/test_whatsapp_upsert_append.py` | **0** | **17 passed**, 0 failed, 0 skipped (1,25 s) | `…/t3-upsert-append.log` |
| 4 | `pytest backend/tests/test_whatsapp_event_contract_parity.py` | **1** | **2 failed, 10 passed** (0,44 s) | `…/t4-parity-FAILED.log` |
| 5 | `node scripts/test-bulk-seq-pagination-guarantees.mjs` | — | **ÇALIŞTIRILMADI** (durma kuralı) | — |
| 6 | `node scripts/test-upsert-notify-append.mjs` | — | **ÇALIŞTIRILMADI** (durma kuralı) | — |

### 7.3 Test 4 hatasının sınıflandırması

**Ürün kodu hatası DEĞİL. Test fixture hatası DEĞİL. Ortam hatası DEĞİL. → Kapsam eksiği.**

Düşen iki test:

```
FAILED test_gateway_connected_is_not_awaited_by_the_frontend
FAILED test_every_frontend_expected_event_is_actually_forwarded
AssertionError: ... Fazla: ['gateway_connected'], eksik: []
  assert {'gateway_connected', 'session_connected', 'session_deleted',
          'session_disconnected', 'session_qr_updated', 'session_sync_completed'}
       == frozenset({'session_deleted'})
```

**Kök neden:** Test, `frontend/src/features/whatsapp/api/whatsappApi.ts` içindeki `LIVE_SESSION_EVENTS` kümesini okuyor. Bu dosya `0b795ea`'da hâlâ `gateway_connected` üyesini taşıyor. 5.1 (`3bf17bf`) bu satırı **frontend'de** kaldırıyordu; BÖLÜM 4 yalnız dört dosya saydığı ve BÖLÜM 5 "dört dosya dışındaki üretim kaynak dosyalarını değiştirme" dediği için bu satır **kapsam dışı** kaldı.

**Bu bir iç çelişki:** BÖLÜM 4/Dosya 4, `_ACKNOWLEDGED_IGNORE_EVENTS` içinde `gateway_connected`'ın **korunmasını** istiyor. Bu dal eklendiğinde, parity testi frontend'in aynı olayı **beklememesini** şart koşuyor. Yani 4. dosyayı doğru yapmak, 5. dosyayı (frontend) zorunlu kılıyor.

**Kanıt (tahmin değil):** Teslim worktree'sine **dokunmadan**, ayrı bir kopyada (`/tmp/tz531-probe`) yalnız şu satır kaldırıldı:

```diff
   'session_sync_completed',
-  'gateway_connected',
 ]);
```

Sonuç: **12 passed, exit 0** (`docs/audits/evidence/5.3.1/t4-parity-PROBE-one-line-fix.log`).

⇒ Entegrasyon tabanı **tek satır** dışında doğru. O satır bu aşamanın izin verdiği kapsamda olmadığı için **uygulanmadı**; teslim worktree'si kasıtlı olarak bu eksiği taşıyor.

### 7.4 Test 5 ve 6 neden çalıştırılmadı

BÖLÜM 6: "Bir test başarısız olursa: sonraki testlere geçme." Test 4 düştüğü için 5 ve 6 **çalıştırılmadı**. Bu, gateway tarafındaki 4.17+5.2 birleşmesinin **doğrulanmadığı** anlamına gelir — raporda gizlenmiyor.

**Not:** Gateway testleri `whatsapp-gateway/node_modules` gerektiriyor (repoda yok). Çalıştırma anında main deposundan geçici bir sembolik bağ kuruldu, iş bitince **kaldırıldı** (`.gitignore:30` `node_modules/` yalnız dizinleri yok saydığı için sembolik bağ `??` olarak görünüyordu; kirli bırakmamak için silindi). Yeniden kurmak için:

```
ln -s /Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/node_modules \
      /private/tmp/tz531-integration/whatsapp-gateway/node_modules
```

---

## 8. Ek koruma denetimi (kod üzerinden)

| # | Kontrol | Sonuç | Kanıt |
| --- | --- | --- | --- |
| 1 | `messages.upsert` notify → normal persist + broadcast | **KORUNDU** | `is_append=false` ⇒ `_no_broadcast` hiç set edilmiyor; `main.py` broadcast dalı değişmedi |
| 2 | `messages.upsert` append → persist + ACK, unread yok, broadcast yok | **KORUNDU** | `events.py:1203` `_no_broadcast`; `main.py` ACK dalı; `!is_append` unread; `!fromMe && !isAppend` rozet |
| 3 | Append timestamp yoksa preview/`last_message_at` korunuyor | **KORUNDU** | `if not (is_append and not msg.get("created_at")): apply_last_message(...)`; gateway `_touchChat` `append` dalı |
| 4 | Duplicate append → tek DB kaydı | **KORUNDU** | `events.py:1008` dedup dalında `_no_broadcast`; INSERT tekilliği değişmedi; test 3 (17 passed) bunu kapsıyor |
| 5 | `_no_broadcast` normal akışı etkilemiyor | **KORUNDU** | Dal yalnız `is True` iken; aksi hâlde akış aynı; test 3 yeşil |
| 6 | `gateway_connected` ACK, broadcast yok | **KORUNDU** | `_ACKNOWLEDGED_IGNORE_EVENTS`×3, dispatch dalı×1; 10 parity testi bunu doğruluyor |
| 7 | `messages.update` davranışı değişmedi | **KORUNDU** | `git diff -U0 socket-events.js \| grep "messages\.update"` → **0 satır**; çağrı hâlâ 3 argüman |
| 8 | `stampMessageSeq` çağrı noktaları korundu | **KORUNDU** | 6 çağrı yeri (session-manager ×5, socket-events ×3, message-store ×2) hiç dokunulmadı; `git diff -U0` taraması 0 eşleşme |
| 9 | `listAllMessages` imzası / `seqMode` değişmedi | **KORUNDU** | Dosya diff'i yok; `afterSeq`/`seqEpoch`/`epochReset` satırları değişmedi |
| 10 | `_bulk_chunks` / backend epoch reset değişmedi | **KORUNDU** | `sync.py` ve `memory_persistence.py` **DEĞİŞMEDİ**; test 1 ve 2 yeşil |

**Ek:** Sözdizimi doğrulaması — `node --check` iki gateway dosyası için **OK**, `python -m py_compile` iki backend dosyası için **OK**.

---

## 9. Değişen dosyaların tam listesi

### 9.1 Üretim kodu — 4 dosya (izin verilen kapsam)

| Dosya | Δ | İçerik |
| --- | --- | --- |
| `whatsapp-gateway/src/socket/socket-events.js` | +7/−2 | `upsertType` geçişi |
| `whatsapp-gateway/src/session-manager.js` | +41/−11 | `_ingestUpsertMessage` + `_touchChat` append semantiği |
| `backend/app/main.py` | +17 | `_no_broadcast` ACK dalı |
| `backend/app/services/whatsapp/orchestration/events.py` | +92/−11 | 5.1 + 5.2 (9 hunk) |
| **Toplam** | **+146/−11** | |

### 9.2 Test dosyaları — 3 yeni (BÖLÜM 5'in izin verdiği şekilde)

`backend/tests/test_whatsapp_upsert_append.py` · `backend/tests/test_whatsapp_event_contract_parity.py` · `whatsapp-gateway/scripts/test-upsert-notify-append.mjs`

### 9.3 Bu rapor + kanıt

`docs/audits/ASAMA-5.3.1-controlled-integration-base.md` · `docs/audits/evidence/5.3.1/*.log` (6 dosya)

> **Uyarı:** kanıt dosyaları `.log` uzantılı olduğu için `.gitignore:40` (`*.log`) kuralına takılır ⇒ `git status`'ta **görünmez** ve normal `git add` ile **eklenemez**. Bu, 5.2.12'de `notify-append-console.log` ile yaşanan durumun aynısı. Bilinçli olarak olduğu gibi bırakıldı; `git add -f` kullanılmadı.

### 9.4 Değişmeyenler

`message-store.js` · `index.js` · `whatsapp_gateway.py` · `memory_persistence.py` · `orchestration/sync.py` · `frontend/src/**` · tüm `package.json` · `.gitignore`

**`git status --short` (worktree, son hâl):**

```
 M backend/app/main.py
 M backend/app/services/whatsapp/orchestration/events.py
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js
?? backend/tests/test_whatsapp_event_contract_parity.py
?? backend/tests/test_whatsapp_upsert_append.py
?? whatsapp-gateway/scripts/test-upsert-notify-append.mjs
```

(+ bu rapor; `.log` kanıtları ignore nedeniyle görünmüyor)

---

## 10. Açık riskler ve doğrulanamayan noktalar

| # | Konu | Durum | Etki |
| --- | --- | --- | --- |
| F1 | **Frontend `gateway_connected` satırı kapsam dışı** | **Doğrulandı** — parity testi 2/12 kırmızı; probe'da tek satırla 12/12 yeşil | Taban tamamlanmadı. Tek satırlık düzeltme 5.3.1b'de yapılmalı |
| F2 | **Gateway testleri (5, 6) çalıştırılmadı** | Durma kuralı gereği | **Gateway tarafındaki 4.17+5.2 birleşmesi doğrulanmadı.** En büyük bilinmeyen |
| F3 | **`session-manager.js` anlamsal tuzağı** | Kod kanıtı | Fonksiyon bütünüyle main'den kopyalanırsa `stampMessageSeq`/`trimChatMessages` sessizce silinir; hiçbir mevcut test yakalamaz |
| F4 | **`main.py` ikinci hunk** | Kod kanıtı | Dosya bütünüyle alınırsa `/metrics`'ten `whatsapp_memory_persistence` kaybolur |
| F5 | **Test DB provision zorunluluğu** | Doğrulandı | Provision'sız koşum 6/6 ERROR verir; "test kırmızı" sanılabilir |
| F6 | **Kanıt `.log` dosyaları ignore'da** | Doğrulandı | Commit'e giremezler; ayrı karar gerekir |
| F7 | **`node_modules` sembolik bağı** | Kaldırıldı | Gateway testleri için her koşumda yeniden kurulmalı |
| F8 | **Worktree `/private/tmp` altında** | Bilinçli | Geçici dizin temizlenirse worktree `prunable` olur; dal `.git`'te durur |
| F9 | **Bu taban henüz hiçbir deploy yolunda değil** | Tasarım gereği | Commit/push/deploy yapılmadı; taban yalnız yerel |
| F10 | **`docs/audits/evidence/` altında başka aşamaların dosyaları** | — | Bu aşamada yalnız `5.3.1/` oluşturuldu |

**Doğrulanamayanlar (dürüst liste):**

- Gateway `stampMessageSeq`/`trimChatMessages` yolunun **çalışırken** doğru davrandığı — test 5 çalıştırılmadı.
- `test-upsert-notify-append.mjs`'in bu tabanda geçeceği — test 6 çalıştırılmadı.
- 4.17 ile 5.2'nin `_touchChat` üzerinden **birlikte** ürettiği davranış (append + trim aynı anda) — hiçbir test bunu doğrudan kapsamıyor.
- Commit/push/deploy edilebilirlik — bu aşamada yasak, denenmedi.

---

## 11. KARAR

# `CONDITIONAL`

**Gerekçe:**

- **4.17 korumaları korundu** — 14/14 sembol yerinde; korunması gereken beş dosya **hiç değişmedi**; `stampMessageSeq`/`trimChatMessages`/`listAllMessages`/`seqMode`/`afterSeq`/`seqEpoch`/`epochReset` satırlarına **dokunulmadı** (§6.1, §8).
- **5.2 davranışı dört dosyada doğru taşındı** — main ile sembol sayıları birebir; backend testleri (1, 2, 3) toplam **33 passed**, 0 failed.
- **Altı testin tamamı geçmedi** ⇒ PASS verilemez. Test 4 kapsam eksiği nedeniyle düştü; test 5 ve 6 durma kuralı gereği çalıştırılmadı.

**PASS için kalan iş (tek mikro-adım):**

1. `frontend/src/features/whatsapp/api/whatsappApi.ts` içinden `'gateway_connected',` satırını kaldır (5.1'in frontend yarısı; BÖLÜM 5 kapsamı bu satır için **genişletilmeli**).
2. `ln -s …/whatsapp-gateway/node_modules` ile gateway test bağımlılıklarını bağla.
3. Test 4'ü ve ardından **test 5 ile 6'yı** çalıştır.
4. Altısı da yeşilse PASS.

Bu adımlar **yapılmadı**; BÖLÜM 5'in açık yasağı ("dört dosya dışındaki üretim kaynak dosyalarını değiştirme") gereği duruldu.

**PASS çıkmadığı için commit/push/deploy izni doğmadı.** 5.3.2 event kodlamasına geçilmedi.

---

## Tamamlama kontrolü

| Öğe | Değer |
| --- | --- |
| `main` HEAD / branch / dirty | `e7f1077` / `main` / 85 — **değişmedi** |
| Yeni worktree HEAD | `0b795ea` — değişmedi (yalnız çalışma ağacı) |
| Stage (her iki ağaç) | **0** |
| Commit | **0** |
| Push / deploy / merge / rebase / cherry-pick | **0** |
| Production DB / sunucu / restart | **0** |
| Persistence loop | **OFF** |
| Kullanıcı değişiklikleri | Dokunulmadı, taşınmadı, silinmedi |
