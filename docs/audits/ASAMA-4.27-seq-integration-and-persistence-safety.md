# Aşama 4.27 — Seq Entegrasyonu ve Persistence Güvenlik Denetimi

**Tarih:** 2026-11-01 10:29–11:05 +0300
**Mod:** Analiz + izole kodlama. Production **read-only**.
**Hedef:** Backend 4.7 + Gateway 4.17 (`de1f1ad34f123a304f6b6432cd22a546ccafac36`)

> **Tek cümle:** Gateway seq sözleşmesi **PASS**, backend seq zinciri **PARTIAL** — çünkü epoch reset'te backend **sahte bir `PaginationStalled`** üretip imleci *yeni epoch + eski değer* olarak kaydediyordu (P1, kanıtlandı, izole düzeltildi, regresyon testi eklendi); initial sync ise **hâlâ offset** ve front-trim'de sessiz atlama riski **taşımaya devam ediyor** (P1, düzeltilmedi — tasarım kararı gerektiriyor).

---

## 0. Karar özeti

| Katman | Durum | Kanıt |
| --- | --- | --- |
| Gateway 4.17 seq sözleşmesi | ✅ **PASS** | 8/8 contract + 32/32 guarantees |
| Backend seq entegrasyonu | ⚠️ **PARTIAL → düzeltildi** | P1/F1, A/B test |
| Initial sync | ⚠️ **OFFSET** (değişmedi) | P1/F2, mevcut test kanıtı |
| Cursor/epoch güvenliği | ✅ fix sonrası | §6 |
| DB transaction / idempotency | ✅ PASS | §7 |
| Eş zamanlı worker | ✅ N/A (tek süreç) | §8 |
| Testler | ✅ 920 passed / 4 skipped | §9 |
| Production | ✅ loop kapalı, 0 hata | §11 |

**Nihai karar:** **B — KODLAMA GEREKLİ (tamamlandı)** + **C — AKTİVASYON KARARI GEREKLİ** (bu prompt yetki vermiyor).
Kombinasyon ayrı raporlanır: *gateway PASS · backend PARTIAL→düzeltildi · initial sync OFFSET.*

---

## 1. Başlangıç commit ve çalışma ağacı durumu

| Öğe | Değer |
| --- | --- |
| Yerel `HEAD` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` (`main`) |
| Çalışma ağacı | **kirli — 64 girdi** (dokunulmadı) |
| Dağıtılan commit | `de1f1ad34f123a304f6b6432cd22a546ccafac36` |
| `main` bu kodu içeriyor mu? | **Hayır** — `git diff HEAD de1f1ad` → `memory_persistence.py` +241, `sync.py` +144, `whatsapp_gateway.py` +11 |

**Metodolojik sonuç:** `main` seq kodunu **içermediği** için testler `main` üzerinde koşulamaz. Denetim, `de1f1ad`'e **detached geçici worktree** (`/tmp/tz427-tree`, `git status` temiz) üzerinde yapıldı. Ana çalışma ağacına **hiç yazılmadı**.

> Not: İlk denemede `main`'de koşulan testler `no such table: messages` verdi; ardından `git diff HEAD de1f1ad` ile dosyaların `main`'de **olmadığı** doğrulandı. "Testler geçti" demek için önce **hangi ağaçta** koştuğunu kanıtlamak gerekiyordu.

---

## 2. Gateway seq sözleşmesi

### 2.1 Uçtan uca yol

| Katman | Dosya | Satır |
| --- | --- | --- |
| Route + query parse | `whatsapp-gateway/src/index.js` | **567–588** |
| `listAllMessages` | `whatsapp-gateway/src/session-manager.js` | **1230–1330** |
| `seqMode` tespiti | aynı | **1256–1258** |
| `perChatLimit` atlaması | aynı | **1272** |
| epoch / reset | aynı | **1286–1296** |
| yanıt gövdesi | aynı | **1305–1320** |

`index.js:568` → `const { limit, offset, since, perChatLimit, jids, afterSeq, seqEpoch } = req.query;`
`index.js:584-585` → `afterSeq` **int**, `seqEpoch` **String** olarak normalize edilir.

### 2.2 Yanıt sözleşmesi (snake_case)

```json
{"messages":[...], "total":19, "offset":0, "limit":5,
 "pagination":"seq", "seq_epoch":"<uuid>", "max_seq":19,
 "after_seq":0, "next_after_seq":5, "reached_end":false,
 "epoch_reset":true, "eligible_total":19}
```

| Alan | Tip | Anlam |
| --- | --- | --- |
| `pagination` | `"seq"` \| `"offset"` | **mod ayırt edici** (4.17'de eklendi) |
| `seq_epoch` | string (UUID) | depo/süreç nesli |
| `after_seq` | int | gateway'in **gerçekten kullandığı** taban (reset'te 0) |
| `next_after_seq` | int | sonraki isteğin imleci |
| `reached_end` | bool | `page.length < limit` |
| `epoch_reset` | bool | `Boolean(seqEpoch) && seqEpoch !== epoch` |
| `eligible_total` | int | `seq > after` kalan kayıt |

### 2.3 Kritik gateway davranışları

1. **`seqMode` yalnızca `afterSeq` sonlu sayıysa açılır** (1256). Yoksa offset — geriye uyum.
2. **`perChatLimit` seq modunda UYGULANMAZ** (1272: `if (!seqMode && perChat !== null …)`). Bu bilinçli: "en yeni N" kırpması imleçle birlikte eski kayıtları eler.
3. **`epochReset` yalnızca `seqEpoch` GÖNDERİLDİĞİNDE** tetiklenir (1294: `Boolean(seqEpoch) && …`). Epoch gönderilmezse reset yok — bkz. F4.
4. **Damgasız kayıt okuma anında damgalanır** (`ensureMessageSeq`) ve **en yüksek** sırayı alır → imlecin gerisinde kalmaz, atlanmaz.
5. **`total` = depo boyu**, `eligible_total` = imleç sonrası. İkisi farklı; backend `total`'ı seq modunda kontrol akışında **kullanmıyor**.

### 2.4 Gateway testleri (izole)

```
Bulk seq pagination contract: PASS (8 checks)
  ok - F. an epoch mismatch resets the cursor instead of losing records
  ok - G. a malformed afterSeq falls back to offset (no silent seq mode)
  ok - H. the bulk route forwards afterSeq/seqEpoch
Bulk seq pagination guarantees: PASS (32 checks)
  ok - L1. 5000 ingests leave exactly MESSAGES_PER_CHAT_MAX records in RAM
  ok - L2. a full 5000-record drain reaches every surviving record exactly once
  ok - L3. 5000 records under a perChatLimit still yields the full surviving set
  ok - R1. concurrent ingest+trim during a drain never duplicates or rewinds
```

**Gateway seq: PASS.**

---

## 3. Backend seq entegrasyon zinciri

### 3.1 Zincir

```
index.js:567  GET /sessions/:id/messages/bulk
   ↓ afterSeq / seqEpoch (index.js:584-585)
session-manager.js:1230  listAllMessages
   ↓ yanıt (1305-1320)
whatsapp_gateway.py:369  list_all_messages(after_seq=, seq_epoch=)
   ↓ params["afterSeq"], params["seqEpoch"]
memory_persistence.py:341  drain_gateway_memory_once
   ↓ 435-450 mod tespiti + epoch
   ↓ 528-556 imleç ilerletme (commit SONRASI)
memory_persistence.py:644  cursors[gateway_id] = {mode, after_seq, offset, epoch}
```

`whatsapp_gateway.py:399` → `params: Dict[str, Any] = {"limit": limit, "offset": offset}` — **`offset` her zaman gönderilir**, seq modunda gateway onu yok sayar (`offset: 0` döner). Canlı logdaki `offset=0` bunun kanıtı, hata değil.

### 3.2 On iki sorunun cevabı

| # | Soru | Cevap | Kanıt |
| --- | --- | --- | --- |
| 1 | `afterSeq` gerçekten gönderiliyor mu? | **Evet**, `mode == "seq"` iken | `memory_persistence.py:417` |
| 2 | `seq_epoch` doğru isim/tiple okunuyor mu? | **Evet**, `page.get("seq_epoch")`, string | `:437` |
| 3 | snake_case alanlar eşleşiyor mu? | **Evet** — `pagination`, `seq_epoch`, `next_after_seq`, `epoch_reset`, `reached_end` | `:434-450, :536-556` |
| 4 | `epoch_reset=true` → cursor nasıl sıfırlanıyor? | **Hatalıydı**: gateway 0'dan tarar ama backend yerel `after_seq`'i sıfırlamıyordu ⇒ **F1** | `:438-442` vs `:540` |
| 5 | Epoch değişimi ile restart ayırt ediliyor mu? | **Evet** — her yeni depo yeni UUID üretir | `session-manager.js:1286` |
| 6 | Eski epoch imleci tekrar kullanılabilir mi? | **Hayır** — epoch uyuşmazsa gateway 0'dan başlar. Epoch *gönderilmezse* korunur (**F4**) | `:1294` |
| 7 | Sayfa DB'ye yazılmadan imleç ilerleyebilir mi? | **Hayır** — commit `:528`, imleç `:546`. Sıra doğru | `:520-556` |
| 8 | DB hatasında aynı sayfa güvenle tekrar işlenir mi? | **Evet** — `rollback` + `break`, imleç değişmez | `:518-526` |
| 9 | Duplicate koruması gerçek kimlikten mi? | **Evet** — `ON CONFLICT (conversation_id, wa_message_id)` + SAVEPOINT | `sync.py:158-212` |
| 10 | Tamamlanma koşulu doğru mu? | **Evet** — `reached_end` veya boş sayfa | `:461-464, :556-558` |
| 11 | Boş/kısmi/timeout? | Boş→`reached_end`; kısmi→`reached_end`; timeout→exception, imleç sabit | `:461, :496-503` |
| 12 | Eski gateway uyumu var mı? | **Evet** — `pagination != "seq"` → offset, `start_offset` korunur | `:443-451` + test C2/C3 |

---

## 4. Initial sync offset analizi

### 4.1 Canlı isteğin kaynağı

`limit=1000&offset=0&since=…&perChatLimit=50` isteği **`sync.py:1703-1721`** tarafından üretilir:

```python
offset = 0                                   # :1696
while True:
    page = await gateway_client.list_all_messages(
        gid, limit=_SYNC_BULK_PAGE_SIZE,     # :103  → 1000
        offset=offset,                       # :1706
        since=since_epoch,                   # :1682
        per_chat_limit=_SYNC_PER_CHAT_LIMIT, # :107  → 50
        jids=request_jids,
    )
    ...
    offset += len(msgs)                      # :1924
    if offset >= total: break                # :1925
```

`sync.py` içinde **`after_seq` / `seq_epoch` hiç geçmiyor** (`grep` = 0 eşleşme).

### 4.2 Soruların cevabı

| Soru | Cevap |
| --- | --- |
| Neden offset? | Initial sync'in amacı **sınırlı hidrasyon**: `perChatLimit=50` ile sohbet başına en yeni 50. `perChatLimit` **seq modunda uygulanmıyor** (gateway 1272) ⇒ seq'e geçmek tüm RAM deposunu (9168 mesaj) çekmek demek. Tasarım bilinçli. |
| Seq teknik olarak uygun mu? | **Evet, ama farklı bir maliyetle.** Ya (a) `perChatLimit` feda edilir → tam tarama, ya (b) `perChatLimit` seq'e taşınır → imleç semantiği bozulur. İkisi de "en küçük güvenli değişiklik" değil. |
| `since` + `afterSeq` birlikte? | **Semantik değişir ama tutarlı**: gateway `since`'i **önce** uygular (`session-manager.js:1263-1269`), sonra `seq > after`. Sonuç = kesişim. `seq` monoton olduğu için `since` ilerlese de **atlama olmaz**. Garanti testi: `S2. since is still honoured in seq mode`. |
| Offset + seq aynı anda? | `seqMode` yalnız `afterSeq` varken açılır; ikisi aynı istekte **aynı anda etkin olmaz**. `offset` seq modunda yok sayılır. |
| Initial sync ve loop aynı mesajları farklı cursorlarla işler mi? | **Evet, işleyebilir** — biri offset (50/chat), diğeri seq (tam). Ama yazma yolu **idempotent** (F/§7) ⇒ çift satır oluşmaz. |
| RAM limiti dolunca eski mesajlara erişim? | **Gateway üzerinden erişilemez.** 2000/chat tavanı aşılan kayıt RAM'den atılır (`trimChatMessages`); gateway yalnız RAM'i servis eder. Tarihçe **DB'den** okunur. ⇒ Atılmadan önce DB'ye yazılmamış mesaj **kalıcı olarak kayıp**. |
| Checkpoint neye dayanıyor? | **Mesaj imlecine değil, sohbet listesine.** `initial_sync_completed_at` `:2145` (erken) ve `:2248` (geç) damgalanır; koşul `len(conv_out) > 0 or gw_ready_phase != "syncing"`. Yani **"sohbet listesi hazır"**, "geçmiş tam" değil — **F3**. |
| Restart sırasında tekrar başlarsa atlama? | **Evet, offset yüzünden mümkün** — bkz. §5 / F2. |

### 4.3 Ayrım (vurgu)

Seq entegrasyonunun **yalnız** persistence loop'a eklenmiş olması, initial sync'in de düzeldiği anlamına **gelmez**. Bu iki akış:

| | Initial sync | Persistence loop |
| --- | --- | --- |
| Amaç | Sohbet listesini ve son 50'yi hızlı göster | RAM'deki **tüm** kayıtları kayıpsız boşalt |
| Sayfalama | **offset** + `perChatLimit=50` | **seq** (değer imleci) |
| Durum | **Değişmedi** | Hazır, **kapalı** |

---

## 5. Front-trim ve 2000 mesaj limiti

`MESSAGES_PER_CHAT_MAX = 2000` (`message-store.js`). Gateway testi **L1** bunu kanıtlıyor: *5000 ingest → RAM'de tam 2000*.

| # | Senaryo | Atlama? | Tekrar? | DB'den silme? | İmleç kayması? | Reconciliation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2500 mesaj, son 2000 RAM'de | **seq: hayır** · offset: **evet** | Hayır | **Hayır** | seq: hayır | seq tam |
| 2 | DB 2500, RAM 2000 | Hayır (DB doğruluk kaynağı) | — | **Hayır** | — | DB üstün |
| 3 | Initial sync offset ilerlerken front-trim | **EVET (P1/F2)** | — | Hayır | **evet** | **eksik kalır** |
| 4 | Yeni mesaj gelirken eski sayfa | seq: hayır (L2/R1) | Hayır | Hayır | seq: hayır | tam |
| 5 | Restart → epoch değişir | **hayır** (fix sonrası) | Evet (yeniden tarama) | Hayır | düzeltildi | tam |
| 6 | İki worker aynı sohbet | **N/A** — tek süreç (§8) | — | Hayır | — | — |
| 7 | Aynı mesaj iki akışta | Hayır | **Evet, zararsız** (unique index) | Hayır | — | tam |

### 5.1 Front-trim kanıtı (mevcut testler)

`test_front_trim_skips_messages_in_offset_mode` — **offset modu, sessiz kayıp**:

```
İlk tur: page_size=3 → T0,T1,T2 yazıldı, next_offset=3
Front-trim: en eski 2 kayıt RAM'den atıldı → [T2,T3,T4,T5]
İkinci tur: offset=3 → [T2,T3,T4,T5][3:] = [T5]
Sonuç: got = ["T0","T1","T2","T5"]   ⇒  T3 ve T4 HİÇBİR turda yazılmadı
```

`test_front_trim_does_not_skip_messages_in_seq_mode` — **seq modu, aynı trim**:

```
got = ["Q0","Q1","Q2","Q3","Q4","Q5"]   ⇒ hiçbir kayıt atlanmadı
```

> **P0 eşiği:** Veri **silinmiyor**; ama offset yolunda mesaj **sessizce atlanıyor**. Atlanan mesaj RAM'den de düşmüşse **geri getirilemez**. Bu yüzden F2 **P1** (initial sync'in sınırlı hidrasyon penceresinde), loop tarafı ise **PASS**.

---

## 6. Cursor ve epoch güvenliği

### 6.1 Cursor nerede yaşıyor?

`memory_persistence.py:87` → `_STATE["cursors"]` — **süreç içi RAM**, DB'de değil.
`memory_persistence.py:644` → `cursors[gateway_id] = {mode, after_seq, offset, epoch}`.

**Sonuç:** Süreç yeniden başlarsa imleç kaybolur → tur **0'dan** başlar. Bu **güvenli** (idempotent yazma) ama her deploy'da tam yeniden tarama demek. `page_size × max_pages = 500 × 20 = 10 000` ≥ 9168 ⇒ tek turda kapsanır.

### 6.2 F1 — Epoch reset'te sahte stall (P1, **kanıtlandı ve düzeltildi**)

**Dosya:** `backend/app/services/whatsapp/memory_persistence.py`
**Fonksiyon:** `drain_gateway_memory_once`
**Satır:** epoch bloğu **438–442**, stall muhafızı **540–545**, imleç yazımı **644–650**

Mevcut kod:

```python
if page.get("epoch_reset"):
    stats["epoch_reset"] = True
    _STATE["epoch_resets_total"] += 1
    # ← burada yerel after_seq SIFIRLANMIYOR
...
if next_after <= after_seq:          # :540  ESKİ epoch değeriyle karşılaştırma
    stats["error"] = "PaginationStalled"   # :541
    break
after_seq = next_after               # :546  (buraya hiç gelinmiyor)
```

Gateway reset'te `after=0` kullanıp ilk sayfayı döner; `next_after_seq` = sayfanın son seq'i (küçük). Eski imleç büyükse `next_after <= after_seq` **her zaman** doğru olur.

**Ampirik kanıt (regresyon testi, fix ÖNCESİ):**

```
PROBE_STATS {'pages':1, 'scanned':2, 'inserted':2, 'next_offset':99,
             'next_after_seq':99, 'pagination_mode':'seq',
             'seq_epoch':'ep-2', 'epoch_reset':True, 'error':'PaginationStalled'}
FAILED
```

**Etki:**
1. Her gateway restart'ında **sahte hata** (`errors_total++`, `stalled_pages_total++`, `last_error`).
2. İmleç **tutarsız** kaydedilir: `(epoch = ep-2, after_seq = 99)` — yeni nesil + eski değer.
3. Toparlanma **2 boşa tur** alır (tur 2: boş sayfa → `reached_end` → 0; tur 3: yeniden tarama).
4. Dar atlama penceresi: yeni depo eski imleçten **büyükse**, tur 2 eski değerden devam eder ve aradaki kayıtlar yalnızca eski epoch'ta yazıldıysa kurtulur.

**Neden testler yakalamadı:** `test_epoch_change_triggers_a_safe_rescan_and_is_counted` yalnız `inserted == 3` ve `ids_of` doğruluyor. Insert **stall kontrolünden önce** gerçekleştiği için test **yeşil kalırken** `error="PaginationStalled"` üretiliyordu. Klasik "yeşil paket, ölü muhafız" deseni.

**Düzeltme (1 satır kod + gerekçe):**

```python
if page.get("epoch_reset"):
    stats["epoch_reset"] = True
    _STATE["epoch_resets_total"] = int(...) + 1
    after_seq = 0        # ← eklendi
```

**A/B kanıtı:**

| | `error` | `next_after_seq` | Test |
| --- | --- | --- | --- |
| Fix **önce** | `PaginationStalled` | **99** (eski epoch) | ❌ FAIL |
| Fix **sonra** | *yok* | **2** (yeni epoch) | ✅ PASS |

### 6.3 F4 — Epoch gönderilmezse reset yok (P2)

`session-manager.js:1294` → `Boolean(seqEpoch) && String(seqEpoch) !== String(epoch)`.

`seqEpoch` **gönderilmezse** reset tetiklenmez ve `afterSeq` olduğu gibi kullanılır. Backend ilk turda `after_seq=0, epoch=None` gönderir (güvenli). Sonraki turlarda epoch her zaman dolu. **Teorik risk:** epoch'u kaybedip `afterSeq` gönderen bir istemci, yeni depoda eski değerden başlar → boş sayfa → `reached_end` → imleç 0. **Kendini onarır**, veri kaybı yok. Kayıt altına alındı, düzeltme gerekmedi.

---

## 7. DB transaction ve idempotency

| Özellik | Uygulama | Satır |
| --- | --- | --- |
| Sayfa başına commit | `await db.commit()` | `:528` |
| Hata → rollback | `await db.rollback()` + `break` | `:518-526` |
| İmleç yalnız commit sonrası | `after_seq = next_after` | `:546` |
| Duplicate koruması | `ON CONFLICT (conversation_id, wa_message_id) DO NOTHING` | `sync.py:195-198` |
| Savepoint izolasyonu | `db.begin_nested()` + satır satır fallback | `sync.py:202-212` |
| Dead-letter | `{count, constraint}`, PII yok | `sync.py:158-180` |
| Ön-filtre | `_prefetch_existing_ids` | `:330-338` |

**Sıra kanıtı:** insert → commit (`:528`) → `"error" in stats` kontrolü (`:531`) → imleç (`:546`). İmleç, commit'ten **sonra** ilerler; commit başarısızsa `stats["error"]` set edilir ve imleç **hiç** değişmez.

**Idempotency:** aynı sayfa iki kez işlense de ikinci kez satır üretmez. `test_whatsapp_message_insert_isolation.py` (5 test) bunu yarış koşullarıyla doğruluyor.

---

## 8. Eş zamanlı worker analizi

| Öğe | Değer |
| --- | --- |
| Production süreç sayısı | **1** — `/proc` taraması: `python3 start.py` |
| Cursor deposu | `_STATE["cursors"]` (süreç içi) |
| Çoklu worker riski | **Yok** — tek süreç, tek imleç haritası |

**Gelecek riski:** Birden fazla uvicorn worker'a geçilirse her worker **kendi** imleç haritasını tutar; ikisi de aynı gateway'i boşaltır. **Veri bozulmaz** (unique index) ama boşa iş ve `errors_total` gürültüsü olur. Bu bir *ölçekleme* kararıdır, mevcut hata değil.

---

## 9. Test sonuçları

**Ortam:** `de1f1ad` detached worktree, `sqlite+aiosqlite:////tmp/tz427.db`, 34 tablo, `TEST_DB_PATH` **ve** `DATABASE_URL` birlikte. Production DB'sine **dokunulmadı**.

| Paket | Sonuç |
| --- | --- |
| `test_whatsapp_pagination_contract.py` + `test_whatsapp_message_insert_isolation.py` (baseline) | **14 passed** |
| Aynı 4 dosya (fix sonrası, +1 yeni test) | **40 passed** |
| `-k whatsapp` tüm backend (fix sonrası) | **920 passed, 4 skipped** |
| `-p no:randomly` ve dosya-tek başına | **40 / 10 passed** (sıra bağımsız) |
| Gateway `test-bulk-seq-pagination.mjs` | **PASS (8 checks)** |
| Gateway `test-bulk-seq-pagination-guarantees.mjs` | **PASS (32 checks)** |

Baseline karşılaştırma: 4.21'de `919 passed / 4 skipped` → şimdi **920 / 4** = **+1** (yeni regresyon testi). **Regresyon yok.**

> **Ortam tuzağı (kayda değer):** Worktree'de `test_whatsapp_phase2_a_gateway_behavior.py` 2 test **setup'ta** patladı (`ERR_MODULE_NOT_FOUND: uuid`). Kök neden: harness bare specifier'ı **repo kökündeki** `node_modules`'ten çözüyor, worktree'de o dizin yok. Fix geri alınınca da aynı 2 hata çıktı ⇒ **kodla ilgisiz**. Kök `node_modules` bağlanınca **2 passed**.

### 9.1 Kapsanan senaryolar

| Senaryo | Test |
| --- | --- |
| Seq ilk sayfa | `test_new_gateway_seq_response_is_parsed_and_cursor_advances_by_value` |
| Seq sonraki sayfa | aynı + `test_tz427_*` |
| `seq_epoch` eşleşmesi | `test_epoch_change_*` |
| `epoch_reset=true` | `test_epoch_change_*` + **`test_tz427_epoch_reset_must_not_be_reported_as_a_stall`** (yeni) |
| Gateway restart | `test_epoch_change_*` |
| Boş sayfa / kısmi sayfa | `test_missing_next_after_seq_is_a_contract_error`, drain `:461` |
| Sayfa sınırında overlap | Gateway `test-bulk-seq-pagination` (overlap 0) |
| Duplicate mesaj | `test_whatsapp_message_insert_isolation.py` (5) |
| DB transaction rollback | isolation testleri |
| DB yazımı sonrası cursor | `test_tz427_*` (`next_after_seq == 2`) |
| Network timeout / bağlantı kopması | `:496-503` (exception → break, imleç sabit) |
| İki sync worker | §8 — N/A (tek süreç) |
| Front-trim | `test_front_trim_skips_messages_in_offset_mode` / `…_in_seq_mode` |
| Initial sync offset/seq uyumu | `test_legacy_gateway_without_pagination_falls_back_to_offset` |
| Eski gateway fallback | `test_offset_fallback_preserves_the_starting_cursor` |
| Kısmi başarısızlık sonrası recovery | `PaginationStalled` testi + fix |

---

## 10. Kod değişiklikleri

**Tek dosya, tek davranış.** `backend/app/services/whatsapp/memory_persistence.py`, `drain_gateway_memory_once`, epoch bloğu (**438–442**): `after_seq = 0` eklendi (+1 kod satırı, +10 gerekçe satırı).

**Regresyon testi:** `backend/tests/test_whatsapp_pagination_contract.py` sonuna `test_tz427_epoch_reset_must_not_be_reported_as_a_stall`.

**Yapılmayanlar (bilinçli):**
- Initial sync **değiştirilmedi** (F2) — seq'e geçmek `perChatLimit`'i feda eder, tasarım kararı gerektirir.
- Yeni background task / loop **eklenmedi**.
- Flag **değiştirilmedi**.
- Mesaj silme/temizleme mantığı **eklenmedi**.
- Gateway kodu **değiştirilmedi** (sözleşme zaten doğru).
- Geniş refactor **yapılmadı**.

**Durum:** Değişiklik **commit edilmedi**. `de1f1ad` detached worktree'de (`/tmp/tz427-tree`) uygulanmış ve test edilmiş halde duruyor. Tam yama + test: **`docs/audits/ASAMA-4.27-epoch-reset-cursor.patch`**.

---

## 11. Production read-only gözlem

**An:** 2026-11-01T07:37:45Z. **Yalnızca** `/health`, `/metrics`, `docker ps/inspect`, tek `SELECT` kullanıldı. **Yazma yok, restart yok, deploy yok.**

| Öğe | Değer |
| --- | --- |
| `.deployed-commit` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` (değişmedi) |
| Container'lar | 4/4 **healthy**, "Up 10 hours" |
| `config_enabled` | **false** |
| `task_running` | **false** |
| `runs` | **0** |
| `cursor_count` | **0** |
| `cursor_modes` | `{}` |
| `stalled_pages_total` | **0** |
| `epoch_resets_total` | **0** |
| `dead_letter_total` | 0 |
| `errors_total` | 0 |
| Bridge | `connected: true`, `reconnect_count: 1` |
| DB (read-only) | 9582 mesaj · `max(id)=168836` · karantina 1 |

**Yorum:** Loop hiç çalışmadığı için **F1 production'da hiç tetiklenmedi** — hata **latent**. Aktivasyon, düzeltme dağıtılmadan yapılırsa **ilk gateway restart'ında** tetiklenir.

---

## 12. Persistence loop aktivasyon kararı

| Soru | Cevap | Dayanak |
| --- | --- | --- |
| Hangi veri kaybı riskini çözüyor? | **RAM'de doğan, DB'ye hiç yazılmamış** mesajlar. 2000/chat tavanı aşıldığında gateway onları atar ve **bir daha sunamaz** | `message-store.js` trim; L1 testi |
| Initial sync'ten bağımsız neyi garanti ediyor? | **Tam** boşaltma. Initial sync yalnız **son 50/chat** hidrasyonu yapar ve offset'e maruz | §4 |
| Seq kodunun loop kapalıyken çalışan kısmı? | **Hiçbiri.** `run_memory_persistence_once` flag kapalıyken erken döner; `drain_gateway_memory_once` hiç çağrılmaz | `:583-589` |
| Loop açılırsa aynı mesaj iki akıştan işlenir mi? | **Evet, mümkün** — ama **idempotent**: unique index + `ON CONFLICT DO NOTHING` | §7 |
| Cursor/epoch yönetimi güvenli mi? | **Fix ÖNCESİ hayır** (F1). **Fix SONRASI evet** | §6.2 |
| Retry/recovery kanıtlandı mı? | **Evet** — commit→imleç sırası, hata→rollback→imleç sabit, yeniden okuma idempotent | §7, §9 |
| Kaynak tüketimi / uzun süreli davranış ölçüldü mü? | **HAYIR.** Loop production'da hiç koşmadı (`runs: 0`). `page_size×max_pages=10 000`/tur, tur arası ≥30 s | §11 |
| Loop kapalıyken hangi kabul testleri yapılabilir? | Sözleşme, front-trim, idempotency, dry-run ölçümü, epoch reset — **hepsi** yapıldı | §9 |

### Karar

**Loop AÇILMAMALIDIR — bu aşamada.** Gerekçe:

1. **F1 düzeltmesi dağıtılmadı.** Loop bugün açılırsa ilk gateway restart'ında sahte stall + tutarsız imleç üretir.
2. **Uzun süreli davranış hiç ölçülmedi** (`runs: 0`). Kaynak tüketimi, tur süresi, DB yükü bilinmiyor.
3. **F2 (initial sync offset) açık.** Loop bunu telafi eder ama *garanti etmez* — loop da bir backstop, tamlık kanıtı değil.

**Aktivasyon için ön koşullar (ayrı aşama):** (a) F1 fix'i dağıtılmış olmalı; (b) en az bir kez `dry_run=True` turu production'da koşup `scanned/inserted/next_after_seq` ölçülmeli; (c) `errors_total` ve `stalled_pages_total` 0 kalmalı; (d) tur süresi ve DB yükü kaydedilmeli.

---

## 13. Açık riskler

| # | Öncelik | Bulgu | Dosya / satır | Etki | Durum |
| --- | --- | --- | --- | --- | --- |
| **F1** | **P1** | Epoch reset'te sahte `PaginationStalled` + tutarsız `(epoch, after_seq)` | `memory_persistence.py:438-442, 540-546` | Her restart'ta sahte hata, 2 boşa tur, dar atlama penceresi | ✅ **Düzeltildi** (worktree) |
| **F2** | **P1** | Initial sync offset + `perChatLimit` → front-trim'de **sessiz atlama** | `sync.py:1696-1925` | Sınırlı hidrasyon penceresinde mesaj atlanır; RAM'den düşmüşse kalıcı | ❌ **Açık** — tasarım kararı gerekli |
| **F3** | P2 | `initial_sync_completed_at` sohbet-listesi sezgiseli, mesaj imleci değil | `sync.py:2145, 2248` | "Sync tamam" ≠ "geçmiş tam"; UI kapısı mesajlar gelirken açılır | ❌ Açık (davranış, hata değil) |
| **F4** | P2 | `seqEpoch` gönderilmezse reset yok | `session-manager.js:1294` | Epoch'suz istemci eski imleçle başlar; boş sayfa → 0, kendini onarır | ❌ Açık (düşük) |
| **F5** | P2 | İmleç yalnız süreç RAM'inde | `memory_persistence.py:87, 644` | Her süreç restart'ında tam yeniden tarama | Kabul (idempotent) |
| **F6** | P2 | Çok worker'a geçilirse çift boşaltma | §8 | Boşa iş + gürültü; veri bozulmaz | Gelecek riski |
| **F7** | P2 | `test_epoch_change_*` hatayı **assert etmiyor** | `test_whatsapp_pagination_contract.py:365-392` | Yeşil paket, ölü muhafız | ✅ Yeni test eklendi |

---

## 14. Stage 4.28'e geçiş koşulları

1. **F1 fix'i bir release ref'ine alınmalı** (şu an yalnız worktree + `.patch`). Commit/push bu aşamada **yapılmadı**.
2. **F2 için karar verilmeli:** initial sync offset'te kalacak mı (kabul, belgelenmiş risk), yoksa seq'e mi taşınacak (maliyet değişir: `perChatLimit` kaybı)?
3. **Loop aktivasyonu ayrı onay** gerektirir; §12'deki (a)–(d) ön koşulları sağlanmalı.
4. **`dry_run` ölçümü** production'da en az bir kez alınmalı (yazma yok, `runs` sayacı artar — bu **flag açmak değildir**, ayrı onay ister).
5. Gateway sözleşmesi **değişmemeli**; değişirse `test-bulk-seq-pagination*` yeniden koşmalı.

---

## 15. Nihai karar

**B — KODLAMA GEREKLİ** ✅ *tamamlandı*
Backend seq entegrasyonunda **kanıtlanmış** bir hata vardı (F1). İzole düzeltme + regresyon testi yapıldı. Testler: 40 passed (4 dosya), 920 passed (`-k whatsapp`), 0 regresyon.

**C — AKTİVASYON KARARI GEREKLİ** ⏸
Kod (fix sonrası) hazır; ancak loop'un etkinleştirilmesi **ayrı değerlendirme** ister. Bu prompt aktivasyon yetkisi vermiyor. Loop **kapalı** bırakıldı.

**D — KRİTİK RİSK** ❌ *oluşmadı*
Veri kaybı **kanıtlanmadı**: loop hiç çalışmadı (`runs: 0`), F1 latent kaldı, DB'de silme yok. Ancak **F2 açık** olduğu için "tam kayıpsız" iddiası initial sync için **kurulamaz**.

**Katman bazında:**

| Katman | Karar |
| --- | --- |
| Gateway seq | ✅ **PASS** |
| Backend seq | ⚠️ **PARTIAL** → fix sonrası **PASS** (dağıtım bekliyor) |
| Initial sync | ⚠️ **OFFSET** — değişmedi, P1 açık |

> **4.27'nin amacı kodun varlığı değil, mesajların uçtan uca kaybolmadan ve yinelenmeden taşındığını kanıtlamaktı.** Loop tarafı bunu **kanıtladı** (overlap 0, L2 "exactly once", R1 "never duplicates or rewinds", idempotent yazma). Initial sync tarafı ise **kanıtlayamadı** — offset yolu aynı trim altında T3/T4'ü kaybediyor.

---

**Rapor tamamlandı. Duruldu.** Production loop **kapalı**. Commit/push/deploy **yapılmadı**. Stage 5'e **geçilmedi**. 4.28 **başlatılmadı**.
