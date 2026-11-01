# AŞAMA 5.1 — EVENT CONTRACT PARITY
## Gateway → Backend → Frontend Olay Sözleşmesi

**Çalışma türü:** Kodlama + test
**Tarih:** 2026-11-01
**Sonuç:** **PASS** (build/lint için ayrıntılı durum §7)
**Commit / push / deploy:** **YAPILMADI** — ayrı onay bekliyor

---

## 1. Başlangıç Branch / HEAD Bilgisi

| Öğe | Değer |
| --- | --- |
| Aktif branch | `main` |
| HEAD | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` |
| Başlangıçta dirty dosya sayısı | **78** |
| Bitirişte dirty dosya sayısı | **83** (+4 değişen, +1 yeni test) |
| Deploy edilen referans | `0b795ea` (gateway @ `20c88bb`) |

### 1.1 Kod ağacı ayrımı

Stage 5.0 raporundaki üç-ağaç uyarısı bu aşamada da geçerli:

- `main@7afb540` — seq/epoch kodu **yok**
- Çalışma ağacı — commit edilmemiş seq/epoch değişiklikleri **var**
- `release/backend-only-seq-safety@0b795ea` — production

**Bu aşamada analiz ve değişiklikler çalışma ağacında yapıldı.** Production'da deploy edilen kod doğrudan çalışma ağacı kabul edilmedi; `gateway_connected` akışı **deployed ağaçta ayrıca doğrulandı** (bkz. §4).

### 1.2 Değişiklik sınırı — kullanıcı değişiklikleri korundu

Önceden var olan 78 dirty dosyanın **hiçbirine** dokunulmadı. Stash / reset / checkout / silme **yapılmadı**. Değiştirdiğim dosyalar başlangıçta **temizdi**:

| Dosya | Başlangıç durumu |
| --- | --- |
| `backend/app/services/whatsapp/orchestration/events.py` | temiz |
| `backend/app/services/whatsapp_service.py` | temiz |
| `frontend/src/features/whatsapp/api/whatsappApi.ts` | temiz |
| `WHATSAPP_BASELINE_CONTRACT.md` | temiz |
| `backend/tests/test_whatsapp_event_contract_parity.py` | yeni dosya |

---

## 2. Değiştirilen Dosyalar ve Gerekçeleri

| # | Dosya | Değişiklik | Gerekçe |
| --- | --- | --- | --- |
| 1 | `backend/app/services/whatsapp/orchestration/events.py` | `_ACKNOWLEDGED_IGNORE_EVENTS` frozenset'i + `_acknowledge_without_broadcast()` yardımcısı + dispatch dalı (**+45 satır**) | `gateway_connected` bilinmeyen dala düşüp her köprü bağlantısında ERROR logluyordu |
| 2 | `backend/app/services/whatsapp_service.py` | Yorum düzeltmesi (**+14/−2**) | "Köprüden HİÇ geçmez" iddiası yanlıştı; gerçek akışı anlatıyor |
| 3 | `frontend/src/features/whatsapp/api/whatsappApi.ts` | `LIVE_SESSION_EVENTS`'ten `gateway_connected` çıkarıldı + yorum düzeltildi (**+16/−9**) | Tarayıcıya hiç ulaşmayan bir olayı bekleyen ölü tetikleyici |
| 4 | `WHATSAPP_BASELINE_CONTRACT.md` | Invariant satırı güncellendi (**+3/−1**) | Doküman artık kodla çelişiyordu |
| 5 | `backend/tests/test_whatsapp_event_contract_parity.py` | **Yeni dosya**, 12 test | T-01 sözleşme testi + davranış testleri |

**Gateway kodu değiştirilmedi. Baileys listener kaydı değiştirilmedi. DB şeması değiştirilmedi. Yeni DB yazımı yok.**

---

## 3. Önceki ve Sonraki Event Sözleşmesi

### 3.1 Ölçülen kümeler (kaynak ayrıştırmayla, sayımla değil)

| Kaynak | Önce | Sonra |
| --- | --- | --- |
| Gateway'in yayınladığı olay adları | **24** | **24** (dokunulmadı) |
| Backend'in karşıladığı adlar | **20** + `session_` öneki | **21** + `session_` öneki |
| Backend'de karşılıksız gateway olayı | **1** (`gateway_connected`) | **0** |
| Frontend `LIVE_SESSION_EVENTS` | **6** | **5** |
| Frontend'in beklediği ama üretilmeyen | **2** (`gateway_connected`, `session_deleted`) | **1** (`session_deleted`, bilinçli allowlist) |

### 3.2 Gateway → Backend

**Önce:**

```
gateway_connected → else → logger.error("Bilinmeyen gateway olayi yayinlanmadi")
                        → return None
                        → event_id yok ⇒ ACK yok, NACK yok
```

**Sonra:**

```
gateway_connected → evt in _ACKNOWLEDGED_IGNORE_EVENTS
                 → _acknowledge_without_broadcast(event, "no_tenant_identity:gateway_connected")
                 → logger.debug(...)  [ERROR değil]
                 → event["_skip"] = reason
                 → yayın YOK
                 → event_id varsa ACK (NACK değil)
```

`_skip` işaretçisi bilinçli olarak yeniden kullanıldı: `_ingest_and_publish` (`main.py`) `_skip` taşıyan olayı **ACK**'ler. Gateway bu olaya günün birinde `event_id` eklerse outbox, asla başarılı olamayacak bir olayı sonsuza kadar yeniden teslim etmez.

### 3.3 Neden yayın değil de "bilinçli yutma"?

Stage 5.0 önerisi "backend'de güvenli bir broadcast dalı" idi. Payload doğrulandı ve **yayının güvenli olmadığı** ortaya çıktı:

| Kontrol | Sonuç |
| --- | --- |
| Payload | `{event: 'gateway_connected', sessions_count: N}` |
| `gateway_session_id` var mı | **YOK** ⇒ sahip çözülemez |
| `user_id` var mı | **YOK** |
| `sessions_count` ne | `sessionManager.listSessions().length` = **TÜM tenant'ların** oturum sayısı |
| `broadcast()` hedefsiz çağrıda | **fail-closed**, `return 0`, hiçbir sokete gitmez (`websocket.py:46`) |

Tek bir tenant'a yollamak o tenant'a **kiracılar arası sayı** sızdırır. Herkese yollamak, `broadcast()`'in varlık nedeni olan fail-closed izolasyon sözleşmesini **deler**. Bu yüzden doğru çözüm yayın değil, **açık ve görünür şekilde yutmaktır** — ve frontend'in ölü beklentisini kaldırmaktır.

Bu, §3'teki mutlak kuralların ("olay yalnızca doğru kullanıcıya iletilmeli", "başka kullanıcıların session bilgileri sızmamalı") zorunlu sonucudur.

### 3.4 Frontend

**Önce (6 girdi):** `session_connected`, `session_disconnected`, `session_deleted`, `session_qr_updated`, `session_sync_completed`, **`gateway_connected`**

**Sonra (5 girdi):** `session_connected`, `session_disconnected`, `session_deleted`, `session_qr_updated`, `session_sync_completed`

**Davranış kaybı yok:** `App.tsx:286` kendi WS yeniden bağlanmasında `tezlify:ws_connected` yayınlıyor ve `whatsappApi.ts:583` bunu dinleyip `revalidate()` çağırıyor. Yani `gateway_connected`'ın kapatması gereken boşluk zaten kapalı.

`session_deleted` **kaldırılmadı**: `WHATSAPP_FORENSIC_AUDIT.md` bunu S-3 WITHDRAWN olarak kaydediyor (üreticisi yok, backend silmeyi kendisi yönetiyor). Kaldırmak davranış değiştirmezdi ama belgelenmiş bir baseline invariant'ını gerekçesiz bozardı. Onun yerine **allowlist'e alındı ve teste sabitlendi** — böylece sessizce tolere edilen bir boşluk değil, görünür ve kayıtlı bir istisna.

### 3.5 Allowlist'ler (açık, joker yok)

| Allowlist | İçerik | Gerekçe |
| --- | --- | --- |
| `BACKEND_ONLY_EVENTS` | `chat_update` | Gateway `conversation_updated` yayınlıyor; backend eski adı normalize ediyor |
| `FRONTEND_UNPRODUCED_EVENTS` | `session_deleted` | Üretici yok (S-3 WITHDRAWN); backend silmeyi yönetiyor |
| `_ACKNOWLEDGED_IGNORE_EVENTS` | `gateway_connected` | Tenant kimliği yok, yayınlanamaz |

**Genel wildcard yok.** "Bütün bilinmeyen olayları kabul et" gibi bir çözüm **üretilmedi**; bilinmeyen dal hâlâ ERROR loglayıp `None` dönüyor ve bu davranış ayrı bir testle kilitlendi.

---

## 4. `gateway_connected` Gerçek Veri Akışı

```
Baileys socket açılır
  └─ gateway/events.js  attachClient(socket)
       └─ socket.send({ event: 'gateway_connected', sessions_count: listSessions().length })
            │   ↑ HER istemciye — backend köprüsü de bir istemci
            ▼
  backend/main.py  /ws/gateway  receive_text
       └─ _ingest_and_publish → ingest_gateway_event
            ├─ ÖNCE: else → logger.error("Bilinmeyen gateway olayi")
            │        → return None → ACK/NACK yok (event_id yok) → yayın yok
            └─ SONRA: _ACKNOWLEDGED_IGNORE_EVENTS
                     → logger.debug("... no_tenant_identity:gateway_connected")
                     → event["_skip"] = ...  → return None
                     → yayın yok, ERROR yok, event_id varsa ACK
                          ▼
                    ws_manager.broadcast ÇAĞRILMAZ
                          ▼
                    Tarayıcıya ulaşmaz  ⇒  frontend beklentisi ölüydü
```

**Deployed ağaçta doğrulama:** `events.js` `attachClient` fonksiyonu `0b795ea`'da da aynı (bkz. §1.1); backend dispatch tablosu `main` ile deployed arasında bu dosyada fark içermiyor. Dolayısıyla akış production için de geçerlidir.

---

## 5. Test Sonuçları

### 5.1 Yeni sözleşme testi — 12 test, tamamı PASS

| Test | Neyi kanıtlıyor |
| --- | --- |
| `test_parsers_found_the_expected_magnitude` | Parser'lar boş küme döndürmüyor (ölü test koruması) |
| `test_every_gateway_event_has_a_backend_home` | Gateway'in 24 olayının tamamı karşılanıyor |
| `test_backend_accepts_no_event_the_gateway_never_emits` | Backend-only küme = `{chat_update}` |
| `test_every_frontend_expected_event_is_actually_forwarded` | Frontend beklentileri gerçekten iletiliyor |
| `test_gateway_connected_is_not_awaited_by_the_frontend` | Ölü tetikleyici geri gelmiyor |
| `test_allowlists_are_not_stale` | Allowlist çürümüyor olamaz |
| `test_acknowledged_ignore_set_is_exactly_what_we_documented` | Yutulan küme belgelenen ile aynı |
| `test_gateway_connected_is_acknowledged_not_broadcast` | Yayın yok + ERROR yok + DEBUG var |
| `test_gateway_connected_carries_the_ack_safe_skip_marker` | `_skip` işaretçisi doğru |
| `test_unknown_event_keeps_fail_closed_error_behaviour` | Bilinmeyen dal bozulmadı (regresyon) |
| `test_broadcast_reaches_only_the_target_tenant` | Tenant izolasyonu |
| `test_broadcast_without_a_target_is_refused` | Hedefsiz yayın reddediliyor (yutmanın gerekçesi) |

**Ölçülen kümeler (testin gördüğü gerçek değerler):**

```
gateway  : 24
backend  : 21   prefixes: {'session_'}
frontend : 5    ['session_connected','session_deleted','session_disconnected',
                 'session_qr_updated','session_sync_completed']
ack-ignore        : ['gateway_connected']
gateway unhandled : []                       ← hedef
backend-only      : ['chat_update']          ← allowlist
frontend unproduced: ['session_deleted']     ← allowlist
```

### 5.2 Mevcut backend testleri — regresyon yok

Tek tek:

| Dosya | Sonuç |
| --- | --- |
| `test_whatsapp_orchestration_events.py` | 15 passed |
| `test_whatsapp_event_idempotency.py` | 7 passed |
| `test_whatsapp_gateway_ack.py` | 7 passed |
| `test_whatsapp_gateway_boundary.py` | 31 passed |

Birlikte (10 dosya, DB durumu paylaşımlı — kirlilik kontrolü):

**178 passed**, 0 failed, 33.49 s.

### 5.3 Frontend doğrulaması

| Kontrol | Sonuç |
| --- | --- |
| `npm run verify:ws-lifecycle` | PASS — 12/12 |
| `npm run verify:ws-liveness` | PASS — tüm assertion'lar |
| `npm run verify:loading-gate` | PASS — backend tek kapı otoritesi |
| `tsc --noEmit` | **PASS** — 0 hata |
| `npm run build` (`tsc && vite build`) | **PASS** — 8.03 s |
| `eslint` (değişen dosya) | **10 hata — hepsi ÖNCEDEN VAR** (bkz. §7) |

Frontend'de test dosyası **yok** (`*.test.*` / `*.spec.*` = 0); proje standardı `verify:*` node script'leri. Bu aşamada yeni frontend testi eklenmedi çünkü değişiklik bir küme üyesinin silinmesi + yorum düzeltmesi; davranışsal karşılığı backend sözleşme testinde kilitli.

### 5.4 Gateway suite

Gateway kodu **değiştirilmedi**. Yine de Stage 4 regresyon kanıtı için `npm test` çalıştırıldı — sonuç §8'de.

---

## 6. Mutasyon Testinin Sonucu

İki mutasyon, her biri **tam olarak beklenen testleri** düşürdü, ardından bayt-bayt aynı geri yüklendi.

### Mutasyon 1 — `gateway_connected` dispatch dalı kaldırıldı

| Adım | Sonuç |
| --- | --- |
| Değişiklik | `elif evt in _ACKNOWLEDGED_IGNORE_EVENTS` bloğu silindi |
| Beklenen | `gateway_connected` testleri düşmeli |
| Gerçek | **2 failed, 10 passed** |
| Düşen testler | `test_gateway_connected_is_acknowledged_not_broadcast`, `test_gateway_connected_carries_the_ack_safe_skip_marker` |
| Hata mesajı | `AssertionError: gateway_connected hala bilinmeyen olay olarak loglaniyor: ['Bilinmeyen gateway olayi yayinlanmadi (event=gateway_connected)']` |
| Geri yükleme | `shasum -a 256 -c` → **OK** (üç dosya da) |

### Mutasyon 2 — `gateway_connected` frontend setine geri eklendi

| Adım | Sonuç |
| --- | --- |
| Beklenen | Frontend testleri düşmeli |
| Gerçek | **2 failed, 10 passed** |
| Düşen testler | `test_every_frontend_expected_event_is_actually_forwarded`, `test_gateway_connected_is_not_awaited_by_the_frontend` |
| Hata mesajı | `Fazla: ['gateway_connected'], eksik: []` |
| Geri yükleme | `shasum -a 256 -c` → **OK** |

### Geri yükleme kanıtı

```
$ shasum -a 256 -c /tmp/t51_before.sha
backend/app/services/whatsapp/orchestration/events.py: OK
frontend/src/features/whatsapp/api/whatsappApi.ts: OK
backend/app/services/whatsapp_service.py: OK
RESTORE_EXIT=0

$ pytest ... test_whatsapp_event_contract_parity.py
12 passed in 1.05s
```

**Mutasyon doğrulaması: PASS** (BLOCKED değil).

---

## 7. Build / Lint Sonucu

| Kontrol | Komut | Sonuç |
| --- | --- | --- |
| Python derleme | `py_compile` + `ast.parse` (3 dosya) | **PASS** |
| Frontend typecheck | `tsc --noEmit` | **PASS** — 0 hata |
| Frontend build | `npm run build` | **PASS** — 8.03 s |
| Backend lint | — | Projede lint yapılandırması **yok** (ruff/flake8/pyproject yok) |
| Frontend lint (değişen dosya) | `eslint ... --max-warnings 0` | **FAIL — 10 hata, hepsi ÖNCEDEN VAR** |

### 7.1 Lint hatası dürüst değerlendirmesi

`whatsappApi.ts` `--max-warnings 0` ile **10 `@typescript-eslint/no-explicit-any` hatası** veriyor. Bunlar benim değişikliğimden **kaynaklanmıyor**; kanıt:

```
HEAD sürümü (git show HEAD:...whatsappApi.ts | eslint --stdin ...)
→ 10 problems (10 errors, 0 warnings)
Değişmiş sürüm
→ 10 problems (10 errors, 0 warnings)
```

**Aynı 10 hata.** Hatalar `(e as CustomEvent<any>).detail` gibi önceden var olan satırlarda (517, 583, 1130, 1131, 1264, 1266, 1329, 1354, 1372, 1375). Değişikliğim **sıfır yeni lint hatası** ekliyor.

Bu yüzden lint için sonuç **"FAIL (pre-existing, değişiklikten bağımsız)"** — PASS olarak raporlanmıyor, BLOCKED da değil: kontrol çalıştı, sonuç ölçüldü, fark sıfır.

---

## 8. Stage 4 Regresyon Durumu

| Kontrol | Durum |
| --- | --- |
| Gateway kodu değişti mi | **Hayır** — 0 satır |
| Baileys listener kaydı değişti mi | **Hayır** — 14 listener aynı |
| Gateway container restart | **Yapılmadı** |
| DB şeması / production verisi | **Dokunulmadı** |
| 4.33 / 4.34 davranışı | Backend `events.py`'de yalnızca **yeni** bir dal eklendi; mevcut dallar, ACK/NACK, durable outbox, orphan replay **değişmedi** |
| Gateway suite (`npm test`) | §8.1 |

### 8.1 Gateway suite sonucu

```
$ npm --prefix whatsapp-gateway test
GATEWAY_SUITE_EXIT=0
38 script, 83 PASS/OK satırı, 0 FAIL/AssertionError
Son script: [test-history-diagnostics] PASS
```

**PASS.** Gateway'a hiç dokunulmadığı için bu, Stage 4 davranışının korunduğunun doğrudan kanıtıdır.

### 8.2 Neden 4.34 davranışı bozulmadı

- `_PASSTHROUGH_EVENTS`, `_skip_event`, `_defer_event`, `_ingest_and_publish`, orphan kuyruğu, `processed_events` idempotency — **hiçbirine dokunulmadı**.
- Yeni dal, mevcut `else`'in **önüne** konuldu ve yalnızca tek bir ada (`gateway_connected`) eşleşiyor.
- Bilinmeyen dalın davranışı ayrı testle kilitlendi (`test_unknown_event_keeps_fail_closed_error_behaviour`).
- `session_deleted`'a dokunulmadı (S-3 WITHDRAWN kararı korunuyor).

---

## 9. Bilinen Eksikler ve Riskler

| # | Konu | Durum | Not |
| --- | --- | --- | --- |
| 1 | `session_deleted` üreticisiz | **Açık, allowlist'te** | S-3 WITHDRAWN. Kaldırmak davranış değiştirmez; baseline invariant'ı gerekçesiz bozmamak için bırakıldı |
| 2 | Frontend'de test altyapısı yok | **Açık** | Proje standardı `verify:*` script'leri; sözleşme backend testinde kilitli |
| 3 | Lint pre-existing FAIL | **Açık, benden bağımsız** | 10 `no-explicit-any`; HEAD'de de aynı |
| 4 | Sözleşme testi kaynak ayrıştırıyor | **Kabul edilmiş** | Dispatch zinciri `if/elif` ise regex'e bağlı. `test_parsers_found_the_expected_magnitude` boş küme felaketini engelliyor; yine de dispatch bir dict'e refactor edilirse parser güncellenmeli |
| 5 | `gateway_connected` hâlâ gateway'den köprüye geliyor | **Tasarım gereği** | Gateway kodu bu aşamada yasak; backend onu sessizce yutuyor. İleride gateway'den yalnızca UI istemcilerine gönderilebilir (Stage 5.x) |
| 6 | Üç kod ağacı ayrımı sürüyor | **Açık** | `main` ≠ worktree ≠ deployed. Bu aşamada production'a hiçbir şey gitmedi |

**Yeni P0/P1 risk eklenmedi.** Stage 5.0'daki R-12 (P1) bu aşamada **kapatıldı**: ERROR logu bitti, yanlış yorum düzeltildi, ölü tetikleyici kaldırıldı, sözleşme teste bağlandı.

---

## 10. Commit / Push / Deploy için Hazır Olma Değerlendirmesi

| Kriter | Değerlendirme |
| --- | --- |
| Kod tamam | **Evet** |
| Testler geçiyor | **Evet** — 12 yeni + 178 ilgili |
| Mutasyon kanıtı | **Evet** — 2 mutasyon, ikisi de hedefli düştü, bayt-bayt geri yüklendi |
| Build | **Evet** |
| Typecheck | **Evet** |
| Lint | **Pre-existing FAIL** (fark sıfır) |
| Gateway dokunulmadı | **Evet** |
| Production değişikliği | **Yok** |
| Kullanıcı değişiklikleri korundu | **Evet** — 78 dosya dokunulmadı |

**Commit için hazır: EVET.** Ancak iki uyarı:

1. **Working tree çok kirli (83 girdi).** `git add -A` **kullanılmamalı** — kullanıcıya ait 78 dosya commit'e girer. Yalnızca şu 5 yol açıkça stage edilmeli:
   ```
   backend/app/services/whatsapp/orchestration/events.py
   backend/app/services/whatsapp_service.py
   frontend/src/features/whatsapp/api/whatsappApi.ts
   WHATSAPP_BASELINE_CONTRACT.md
   backend/tests/test_whatsapp_event_contract_parity.py
   ```
2. **Deploy `--no-gateway` olmalı.** Gateway kodu değişmedi; gateway'i yeniden oluşturmak RAM deposunu kaybettirir (invariant A6). Bu aşama backend-only bir değişikliktir.

**Push ve deploy için ayrı onay gerekiyor. Bu aşamada hiçbiri yapılmadı.**
