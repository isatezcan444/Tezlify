# AŞAMA 5.3.9 — WHATSAPP UPDATE SEMANTİĞİ VE SESSION LIFECYCLE GÜÇLENDİRME

**Tarih:** 2026-11-02
**Çalışma türü:** KODLAMA + TEST (izole)
**Altyapı:** HAYIR — Docker/SSH/deploy/gateway restart/production DB **yok**
**Önceki aşama:** 5.3.8 — ANALYSIS PASS

---

## 1. Başlangıç / bitiş durumu

| Alan | Başlangıç | Bitiş | Değişim |
|---|---|---|---|
| Worktree | `/private/tmp/tz429-release` | `/private/tmp/tz429-release` | Yok |
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` | Yok |
| HEAD | `3ac26a9ffdd1a4738de915be255ee65c6b5be314` | `3ac26a9ffdd1a4738de915be255ee65c6b5be314` | **Yok (commit edilmedi)** |
| Staged | 0 | 0 | Yok |
| Main worktree HEAD | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | Yok |
| Main dirty | 87 | 87 | **Yok** |
| Commit / push / deploy | — | — | **Yapılmadı** |

> Not: 5.3.8 raporu main dirty'yi 85 olarak kaydetmişti; bu oturumun başında ölçüm **87** idi ve oturum boyunca **87** kaldı (değişmezlik kanıtı §11).

---

## 2. Değiştirilen dosyalar

**Üretim kodu (5 dosya, +105 / −23):**

| Dosya | Değişim | Gerekçe |
|---|---|---|
| `whatsapp-gateway/src/socket/socket-events.js` | +9/−1 | `messages.update` içeriğini `upsertType:'replace'` ile geçir; `messageTimestamp`'ı `Date.now()`'a düşürme |
| `whatsapp-gateway/src/session-manager.js` | +35/−3 | `replace` semantiği: `isReplace`, zamansız güncellemede kaydın damgasını koru, yerinde değiştir, rozet artırma |
| `backend/app/services/whatsapp/orchestration/events.py` | +47/−13 | `replace`/`update` kabul et; açık içerik güncellemesi; no-op yayın bastırma; unread/önizleme koruması |
| `backend/app/services/whatsapp/orchestration/sessions.py` | +23 | Commit SONRASI tenant-scoped `session_disconnected` (reason=DELETED) yayını |
| `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` | +14/−2 | `replace` güncellemesini mevcut balona yerinde birleştir |

**Yeni testler (3 dosya):**

| Dosya | İçerik |
|---|---|
| `whatsapp-gateway/scripts/test-message-update-semantics.mjs` | 12 kontrol — `messages.update` semantiği |
| `backend/tests/test_whatsapp_message_update_semantics.py` | 9 test — backend replace semantiği |
| `backend/tests/test_whatsapp_session_delete_lifecycle.py` | 6 test — session silme yaşam döngüsü |

**Manifest / lockfile / `.gitignore` / `message-store.js` / `index.js` / `sync.py` / `memory_persistence.py`: DEĞİŞMEDİ.**

---

## 3. KONU A — `messages.update` semantiği

### 3.1 Kök neden (5.3.8'den doğrulanmış)

`socket-events.js` `messages.update` içeriğini `_ingestUpsertMessage(msg, sock, id)` çağırıyordu — `upsertType` YOK. Varsayılan `notify` olduğu için güncelleme canlı yeni mesaj gibi işleniyordu:
- `upsert_type: 'notify'` yayınlanıyordu,
- zaman damgası yoksa `Date.now()` ile sohbet listenin en üstüne taşınıyordu,
- rozet artışı `_unreadUpdatedForId` ile çoğu durumda zaten engelleniyordu ama açık bir garanti yoktu.

### 3.2 Uygulanan düzeltme

**Gateway:**
```js
// socket-events.js — messages.update (içerik kolu)
const msg = { key, message: update.message,
              messageTimestamp: update.messageTimestamp ?? undefined, pushName: update.pushName };
await manager._ingestUpsertMessage(msg, sock, id, { upsertType: 'replace' });
```
```js
// session-manager.js — _ingestUpsertMessage
const isReplace = normalizedUpsertType === 'replace' || normalizedUpsertType === 'update';
// zamansız replace: kaydın kendi created_at'i korunur (Date.now() DEĞİL)
const existingTsMs = isReplace && existingRecord?.created_at ? Date.parse(existingRecord.created_at) : NaN;
const ts = hasIncomingTs ? messageTimestampMs(...) : (Number.isFinite(existingTsMs) ? existingTsMs : ...);
// yerinde değiştir: aynı wa_message_id için TEK kayıt
if (isReplace && existingRecord) { const at = chatMsgs.indexOf(existingRecord); if (at !== -1) chatMsgs.splice(at, 1); }
// rozet: replace YENİ VARIS DEĞİL
if (chat && !fromMe && !isAppend && !isReplace) { ... }
record.unread_count = chat?.unread_count ?? (fromMe || isAppend || isReplace ? 0 : 1);
```

**Backend (`events.py`):**
```python
if upsert_type not in ("notify", "append", "replace", "update"): ... = "notify"
is_append = upsert_type == "append"
is_update = upsert_type in ("replace", "update")
...
if is_update and body_incoming:          # açık içerik güncellemesi (notify yalnız yer tutucu doldurur)
    canonical.body = msg.get("body")
...
content_changed = (canonical.body != body_before) or (canonical.media_id != media_before)
if is_append:            event["_no_broadcast"] = True
elif is_update and not content_changed: event["_no_broadcast"] = True   # no-op yayın yok
...
if direction == MessageDirection.INBOUND and not is_append and not is_update:  # rozet yok
```

**Frontend (`useWhatsAppConversation.ts`):** `message_new` + `upsert_type='replace'` geldiğinde mevcut balon `{...prev, ...incoming}` ile yerinde güncellenir; `notify`/`append` dedup davranışı aynen korunur.

### 3.3 Davranış tablosu

| Girdi | Kayıt | Yeni satır | Rozet | Önizleme | Yayın | `upsert_type` |
|---|---|---|---|---|---|---|
| `notify` (canlı) | eklenir | — | +1 (INBOUND) | güncellenir | var | `notify` |
| `append` (geçmiş) | eklenir | — | artmaz | yalnızca daha yeniyse | **yok** (`_no_broadcast`) | `append` |
| `replace` — içerik değişti | **güncellenir** | **yok** | **artmaz** | yalnızca daha yeniyse | **var** | `replace` |
| `replace` — içerik aynı | dokunulmaz | yok | artmaz | dokunulmaz | **yok** (`_no_broadcast`) | `replace` |
| `replace` — zamansız | güncellenir | yok | artmaz | **oynamaz** (kaydın damgası) | var | `replace` |
| `replace` — bilinmeyen mesaj | eklenir | — | **artmaz** | daha yeniyse | var | `replace` |
| `update.status` (ACK) | güncellenir | yok | dokunmaz | dokunmaz | `message_status_updated` | — |
| revoke (`protocolMessage.type=0`) | hedef `is_deleted` | yok | dokunmaz | dokunmaz | **yok** | — |

### 3.4 Event akış şeması

```
Gateway                                   Backend                         Frontend
───────                                   ───────                         ────────
Baileys messages.update
  ├─ update.status ──► _applyMessageAck ──► message_status_updated ──► status badge
  └─ update.message ─► _ingestUpsertMessage(upsertType:'replace')
                        │  (aynı wa_message_id → yerinde güncelle)
                        └─ message_new {upsert_type:'replace'} ──► ingest_message
                                                                    │ is_update=True
                                                                    ├─ gövde güncelle
                                                                    ├─ rozet YOK
                                                                    ├─ no-op ise _no_broadcast
                                                                    └─ broadcast ──► WS message_new
                                                                                       └─ useWhatsAppConversation
                                                                                          yerinde birleştir
```

---

## 4. KONU B — Session silme ve multi-tab tutarlılığı

### 4.1 Tasarım kararı

Gateway `deleteSession` hiçbir event üretmez ve zaten backend DB purge/commit'inden **önce** çalışır. Bu yüzden sinyalin doğru üretim noktası **backend commit'inden sonrasıdır**.

- **`session_deleted` YENİ bir üreticiyle eklenmedi** (spec kısıtı).
- Mevcut `session_disconnected` yaşam döngüsü sinyali yeniden kullanıldı, `reason="DELETED"` ile.
- Yayın `ws_manager.broadcast(..., target_user_id=user_id)` ile **tenant-scoped** (fail-closed).
- Frontend `WhatsAppHubPage` `session_disconnected` olayında `fetchSessions(true)` çağırır ⇒ diğer sekmeler silinen satırı düşürür.
- `reason="DELETED"`, `WhatsAppQrConnectModal`'ın LOGGED_OUT/BANNED UI'ını **tetiklemez**; normal logout davranışı bozulmaz.

### 4.2 Yaşam döngüsü akışı

```
Tab A (silen)                    Backend                                  Tab B (diğer)
─────────────                    ───────                                  ─────────────
DELETE /sessions/{id} ─────────► delete_session()
                                   ├─ gw.delete_session(gateway_id)
                                   ├─ purge_whatsapp_data()
                                   ├─ db.delete(row)
                                   ├─ db.commit()          ◄── BAŞARI NOKTASI
                                   ├─ ws_manager.broadcast(
                                   │     event=session_disconnected,
                                   │     reason=DELETED,
                                   │     session_id, gateway_session_id,
                                   │     target_user_id=owner)
                                   └─ return {success:...}
REST yanıtı ◄────────────────────┘
setSessions(filter)                                                    WS event ──► fetchSessions(true)
setConversations([])                                                               └─ satır listeden düşer
```

**Hata sınırı:** `purge`/`db.delete`/`commit` istisna atarsa yayın **hiç yapılmaz** (broadcast commit'ten sonra). Gateway silme hatası yerel silmeyi engellemez; satır silindiği için yayın yine doğrudur.

---

## 5. Çalıştırılan testler ve sonuçları

### 5.1 Yeni testler

| Test | Sonuç |
|---|---|
| `test-message-update-semantics.mjs` (12 kontrol) | **12/12 PASS** |
| `test_whatsapp_message_update_semantics.py` (9 test) | **9 passed** |
| `test_whatsapp_session_delete_lifecycle.py` (6 test) | **6 passed** |

**Mutation kanıtı (backend):** `is_update = False` mutasyonu 9 testten **3'ünü** düşürdü (gövde güncelleme, no-op yayın bastırma, bilinmeyen mesaj rozeti) ⇒ testler koda **bağlı**, ölü değil. Mutasyon geri alındı, 9/9 tekrar yeşil.

**Pre-fix kanıt (gateway):** düzeltme öncesi aynı test 2 gerçek hatayı yakaladı — (4) `upsert_type` `notify` dönüyordu, (7) zamansız güncelleme sohbeti en üste taşıyordu. Düzeltme sonrası 12/12.

### 5.2 Önceki regresyon seti (5.3.6)

Her backend dosyası **kendi taze DB'siyle** koştu (`provision_test_db.py` → 34 tablo).

| Backend dosyası | Beklenen | Sonuç |
|---|---|---|
| `test_whatsapp_memory_persistence.py` | 10 | **10 passed** |
| `test_whatsapp_memory_persistence_hardening.py` | 15 | **15 passed** |
| `test_whatsapp_sync_job.py` | 47 | **47 passed** |
| `test_memory_persist_fail_closed.py` | 32 | **32 passed** |
| `test_whatsapp_event_contract_parity.py` | 12 | **12 passed** |
| `test_whatsapp_upsert_append.py` | 17 | **17 passed** |
| **Ara toplam** | **133** | **133 passed** |
| `test_whatsapp_4_34_e2e_regressions.py` | 6 | **KOŞULAMADI — dosya yok (bkz. §9)** |
| `test_whatsapp_pagination_contract.py` (4.27) | — | **10 passed** |

| Gateway script | Beklenen | Sonuç |
|---|---|---|
| `test-bulk-seq-pagination.mjs` | 8 | **8 checks PASS** |
| `test-bulk-seq-pagination-guarantees.mjs` (4.17/4.28 seq-safe) | 32 | **32 checks PASS** |
| `test-upsert-notify-append.mjs` | 13 | **13 controls PASS** |
| `test-message-update-semantics.mjs` (yeni) | 12 | **12 controls PASS** |
| `test-tz428-initial-sync-front-trim.mjs` | 7 | **KOŞULAMADI — dosya yok (bkz. §9)** |
| **Tam gateway `npm test`** | 50+ script | **EXIT 0** |

| Frontend | Sonuç |
|---|---|
| `npm run build` (`tsc && vite build`) | **EXIT 0**, 11.31 s, `tsc` sessiz |

### 5.3 4.27 / sequence-safe doğrulaması

- `test_whatsapp_pagination_contract.py` → **10 passed** (epoch_reset, after_seq=0, stall yok).
- `test-bulk-seq-pagination-guarantees.mjs` → **32/32** (strict `>`, epoch reset, 2000 cap, trim/cursor yarışı, dedup).
- `message-store.js` ve `memory_persistence.py` **değişmedi**.

---

## 6. Main worktree değişmezlik kanıtı

| Ölçüm | Başlangıç | Bitiş |
|---|---|---|
| `git rev-parse HEAD` (main) | `e7f1077a489d94bc6b0f0afef6b575e48922162e` | `e7f1077a489d94bc6b0f0afef6b575e48922162e` |
| `git status --porcelain \| wc -l` | 87 | 87 |

Main worktree'de **hiçbir dosya** okunmadı/değiştirilmedi. Tüm çalışma `/private/tmp/tz429-release` içinde yapıldı. Geçici `node_modules` symlink'leri (gateway/frontend/kök) iş sonunda **kaldırıldı**.

---

## 7. Kapsam denetimi

`git status --short` (bitiş):
```
 M backend/app/services/whatsapp/orchestration/events.py
 M backend/app/services/whatsapp/orchestration/sessions.py
 M frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js
?? backend/tests/test_whatsapp_message_update_semantics.py
?? backend/tests/test_whatsapp_session_delete_lifecycle.py
?? docs/audits/ASAMA-5.3.8-event-contract-analysis.md   (5.3.8'den, dokunulmadı)
?? whatsapp-gateway/scripts/test-message-update-semantics.mjs
```
`git diff --check` → **temiz**. `package-lock.json`/`requirements` değişikliği **yok**. `message-store.js`, `index.js`, `sync.py`, `memory_persistence.py`, `.gitignore` **değişmedi**.

---

## 8. Açık riskler

| # | Risk | Sınıf | Not |
|---|---|---|---|
| R1 | `messages.update` içeriği nadir (retry decrypt / edit). Gerçek üretim frekansı ölçülmedi. | Düşük | Kod yolu doğrudan test edildi. |
| R2 | Frontend `replace` birleştirmesi yalnızca build + kod incelemesiyle doğrulandı; jsdom birim testi yok (5.3.7 harness'ı worktree yeniden kurulunca kayboldu). | Düşük | `tsc` + build geçti; mantık tek noktada. |
| R3 | Silme yayını `session_disconnected` adını kullanır (reason=DELETED). Semantik olarak "disconnect" değil "delete"tir; tüketiciler yalnızca `fetchSessions` yapar. | Düşük | `session_deleted` üretmemek spec kısıtıydı. |
| R4 | Gateway silme hatası + yerel silme başarısı: REST `success:false` der ama satır silinir ve yayın yapılır. | Bilinçli | Yerel gerçek (satır yok) yayınlanır; gateway hatası ayrı raporlanır. |
| R5 | `replace` bilinmeyen bir mesaj için gelirse yeni satır açar (rozet artırmadan). | Düşük | Spec "yanlış unread artışına yol açma" diyor; karşılandı. |

---

## 9. ÖNEMLİ BULGU — 5.3.6/5.3.7 regresyon dosyalarının bir kısmı KAYIP

`/private/tmp/tz429-release` worktree'si 5.3.8 öncesi **yeniden oluşturulmuş** (5.3.8 raporu §1). Worktree yeniden oluşturulurken **untracked** dosyalar korunmaz. Bu nedenle 5.3.6/5.3.7'de commit edilmemiş şu test dosyaları artık **yok**:

- `backend/tests/test_whatsapp_4_34_e2e_regressions.py` (6 test)
- `whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs` (7 kontrol)
- `whatsapp-gateway/scripts/test-ingest-write-order.mjs` (9 kontrol)
- `frontend/scripts/verify-live-mode-ws-connected.mjs` (9 kontrol)
- `backend/scripts/run_whatsapp_regression.py` (zorunlu runner)

**Etki:** 5.3.6'nın "139 backend / 28 gateway" rakamı bu worktree'de **tam yeniden üretilemiyor**. Mevcut 6 backend dosyası (133) + 2 gateway script'i (21) + 4.27 contract (10) + yeni testler koştu; hepsi yeşil. Kayıp dosyalar **5.3.9 değişikliklerinden bağımsız** (bu oturumda oluşturulmadı/silinmedi).

**Öneri:** Bu test dosyaları bir sonraki commit'te yeniden yazılıp **tracked** hale getirilmeli; aksi halde her worktree yeniden kurulumunda tekrar kaybolurlar.

---

## 10. Son karar

### ✅ PASS

**Gerekçe:**
- Yeni update semantiği gateway/backend arasında tutarlı (gateway `replace` üretir, backend `replace`/`update` kabul eder).
- Rozet update nedeniyle artmıyor (gateway + backend testleri).
- Gerçek içerik değişikliği frontend'e ulaşıyor (backend broadcast + frontend yerinde birleştirme + build).
- Notify/append mevcut davranışları korunuyor (regresyon testleri).
- Session silme multi-tab tutarlılığı güvenli (commit sonrası tenant-scoped yayın; hata sınırı test edildi).
- REST DELETE hata/başarı sınırları korunuyor (purge hatası → yayın yok, satır kalır).
- Tüm **koşulabilen** regresyon testleri geçiyor (133 backend + 10 contract + 21 gateway + 12 yeni + full `npm test` EXIT 0 + build EXIT 0).
- Main worktree değişmedi (87 → 87); production altyapısına dokunulmadı.
- Kod kapsamı yalnızca gerekli 5 üretim dosyası + 3 test dosyası.

**Koşul / kapsam notu:** §9'daki kayıp 4 test dosyası nedeniyle 5.3.6'nın tam rakamı (139/28) yeniden üretilemedi; mevcut tüm testler yeşil. Bu bir **altyapı boşluğu**dur, 5.3.9 kusuru değildir.

**Yapılmayanlar:** Commit YOK, amend YOK, push YOK, deploy YOK, production DB YOK, gateway restart YOK, QR YOK, gerçek WhatsApp mesajı YOK.
