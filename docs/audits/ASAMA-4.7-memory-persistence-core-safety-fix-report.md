# AŞAMA 4.7 — Memory Persistence Core Safety Fix — A–L Raporu

**Tarih:** 2026-10-31
**Dal (branch):** `main` (yerel worktree, dağıtılmamış / uncommitted)
**HEAD:** `7afb5406c29736bb914b27fa90e85a618ae9ce0e`
**Kayıtlı deployed commit:** `b5715fe90d0ff05ef497dcccbc87652efa10ccd1` (2026-10-28)
**Test DB:** yalıtılmış PostgreSQL 17 (`tezlify_test_47`, port 55434, cluster `/tmp/tz46-pg/data`) — uzak/prod DB'lere bağlanmayı reddeder.

---

## A. GÖREV VE YETKİ (Task & Authorization)

AŞAMA 4.7 yalnızca **yerel kod değişiklikleri** ile şu dört kusuru kalıcı olarak düzeltmeyi yetkilendirir:

- **P0-1:** Gateway RAM listesinde offset tabanlı sayfalamanın ön-trim (front-trim) nedeniyle mesaj atlaması.
- **P0-2:** İkinci unique index (`uq_msg_conv_client_message_id`) tek bir "zehirli" satır yüzünden tüm sayfayı bloke etmesi.
- **P2-1:** Gateway RAM kapasite / tahliye (eviction) metriklerinin eksikliği.
- **P2-2:** Backend persistence metriklerinin eksikliği.

**Yasaklar (önceki fazlardan devreden, bu turda da yürürlükte):**
- commit / push / deploy / restart / recreate / loop aktifleştirme — **YOK**.
- Üretim DB'sine herhangi bir yazma (INSERT/UPDATE/DELETE/DDL) — **YOK**.
- Persistence kill-switch'i kalıcı olarak açma, QR/session/auth değişikliği, şifreleme anahtarına dokunma, anahtarı loglama — **YOK**.
- Yeni bağımlılık, ortam/config değişikliği, mevcut health/API sözleşmesini bozma — **YOK**.
- 4.8'e kendiliğinden geçiş — **YOK** (bu rapor sonrası durulur).

---

## B. KAPSAM (Scope)

| Kimlik | Sorun | Düzeltme yeri |
| --- | --- | --- |
| P0-1 | Offset sayfalama ön-trim'de indeksleri sola kaydırır → mesaj atlanır | Gateway: `message-store.js`, `socket-events.js`, `session-manager.js`, `index.js`; Backend: `whatsapp_gateway.py`, `memory_persistence.py` |
| P0-2 | Tek zehirli satır tüm bulk insert'i `IntegrityError` ile düşürür | Backend: `orchestration/sync.py` (`_insert_messages_resilient` + yeni `_insert_messages_one_by_one`) |
| P2-1 | RAM kapasite/tahliye metriği yok | Gateway: `message-store.js`, `session-manager.js`, `index.js` (`/health` `capacity`) |
| P2-2 | Persistence metriği yok | Backend: `memory_persistence.py` (`memory_persistence_status`), `main.py` (`/metrics`) |

**Şema notu:** 4.7, `uq_msg_conv_client_message_id` index'ini **düşürmez/alter etmez**. Düzeltme INSERT yolu (direnç) seviyesindedir; migration gerekmedi. (PostgreSQL, tek bir `ON CONFLICT` arbiter'ına izin verir — bu kısıt saygıyla korundu, etrafından dolaşılmadı.)

---

## C. UYGULANAN DEĞİŞİKLİKLER (Neler değişti)

### P0-1 — Keyset (monotonic `_seq`) sayfalama
- `message-store.js`: `Object.defineProperty` ile her önbelleklenmiş mesaja **non-enumerable** `_seq` atanır; `storeSeqEpoch(store)` her store için bir UUID üretir. `nextMessageSeq` / `stampMessageSeq` / `ensureMessageSeq` eklenir (okuma anında eksik damga tamamlanır).
- `session-manager.js` `listAllMessages`: artık `afterSeq` / `seqEpoch` kabul eder. `seqMode`'da `all` listesi `_seq > after` olarak filtrelenir; epoch sıfırlanmışsa `after=0` (güvenli yeniden tarama). Dönüş: `pagination:'seq'`, `seq_epoch`, `max_seq`, `after_seq`, `next_after_seq`, `reached_end`, `epoch_reset`, `eligible_total`.
- `socket-events.js` ve `session-manager.js` içindeki 4 yazma yolu (live upsert, outbox, LID→phone迁移, `historyMessageToRecord`): eski `list.splice(0, list.length-2000)` ön-trim'i yerine `trimChatMessages(store, key, list)` + `stampMessageSeq` kullanır. Böylece ön-trim indeksleri sola kaydırsa bile, backend `after_seq` **değerine** göre yürür, konuma göre değil → kuyruk atlanmaz.
- `whatsapp_gateway.py` `list_all_messages`: `after_seq` / `seq_epoch` parametreleri `afterSeq` / `seqEpoch` query'si olarak iletilir.

### P0-2 — Satır seviyesinde savepoint izolasyonu
- `orchestration/sync.py` `_insert_messages_resilient`: bulk `pg_insert`/`sqlite_insert` + `on_conflict_do_nothing`, artık `async with db.begin_nested():` içinde. `IntegrityError` (arbiter *dışı* kısıt, ör. `client_message_id`) yakalanınca `_insert_messages_one_by_one`'a düşer.
- `_insert_messages_one_by_one` (yeni): her değeri kendi savepoint'inde izole eder; geçerli satırları yazar, reddedilenleri `dead_letter` sözlüğüne sayar (`count` + `constraint`). `_integrity_constraint_name(exc)` yalnızca `orig.diag.constraint_name` veya SQLSTATE (ör. `23505`) döndürür — **hiçbir PII (id/body/phone/jid) loglanmaz**. Fallback dialect yolu da `dead_letter`'ı artırır.

### P2-1 — Gateway RAM metrikleri
- `message-store.js`: `MESSAGES_PER_CHAT_MAX = 2000`; `ramCapacitySnapshot(store)` → `ram_messages_total`, `ram_chats_total`, `ram_chats_at_cap`, `ram_chat_max_utilization`, `ram_raw_store_total`, `ram_raw_store_utilization`, `evictions_total`, `evictions_by_chat` (PII'siz özet), `evictions_by_reason`, `last_eviction_at`, `limits`. `recordEviction` **tek** yapılandırılmış `logger.warn` yayar — yalnızca reason/limit/count/size; id/body/phone/jid **yok**.
- `session-manager.js` `ramCapacitySummary()`: oturumlar arası toplar.
- `index.js` `/health`: artık `capacity: sessionManager.ramCapacitySummary()` döner; `/sessions/:sessionId/messages/bulk` `afterSeq`/`seqEpoch` query'lerini iletir.

### P2-2 — Backend persistence metrikleri
- `memory_persistence.py` `_STATE`: `dead_letter_total`, `dead_letter_last_constraint`, `epoch_resets_total`, `stalled_pages_total`, `consecutive_page_errors`, `last_error_page_key`, `skipped_unmapped_total`, `skipped_no_id_total`, `pages_total`, `scanned_total` eklendi; `cursors` değerleri artık `dict {"mode","after_seq","offset","epoch"}`. `memory_persistence_status()` yeni alanları (`max_cursor_after_seq`, `cursor_modes`, `persistence_lag_seconds`, `dead_letter_total`, `dead_letter_last_constraint`, `epoch_resets_total`, `stalled_pages_total`, `consecutive_page_errors`) döner.
- `drain_gateway_memory_once`: `start_after_seq=0`, `start_epoch=None` parametreleri; varsayılan `mode="seq"`; `pagination` alanını okur (gateway offset dönerse offset'e düşer — **ve imleci sıfırlamaz**, `offset = int(start_offset or 0)`); `epoch_reset` / `PaginationStalled` / `MissingNextAfterSeq` tespiti; `dead_letter` sayımı; ardışık hata sayacı.
- `main.py` `/metrics`: `"whatsapp_memory_persistence": _memory_persistence_status()` eklenir.

---

## D. DOSYA BLOB İLİŞKİLERİ (deployed / HEAD / working-tree)

Kayıtlı deployed commit = `b5715fe`. Çalışma ağacı (working-tree), HEAD üzerine eklenen **henüz commit edilmemiş** 4.7 değişikliklerini taşır.

| Dosya | DEPLOYED (`b5715fe`) | HEAD (`7afb540`) | WORKTREE (şimdi) | HEAD→WT (*diff*) |
| --- | --- | --- | --- | --- |
| `whatsapp-gateway/src/messages/message-store.js` | `51efb47` | `ceb3b05` | `4975ae96afc7` | +278 / −(mod) |
| `whatsapp-gateway/src/socket/socket-events.js` | `11cd81f` | `e0429a1` | `5cf5150dbc30` | +10 |
| `whatsapp-gateway/src/session-manager.js` | `2764f9c` | `7486ecf` | `bbbee4311406` | +167 / −(mod) |
| `whatsapp-gateway/src/index.js` | `c492617` | `5bce2c7` | `1102bbcfc2b7` | +13 / −(mod) |
| `backend/app/services/whatsapp/memory_persistence.py` | **ABSENT** | `794e448` | `d1154a23cee5` | +233 / −(mod) |
| `backend/app/services/whatsapp/orchestration/sync.py` | `88ebbcc` | `e49ebe1` | `74313bddd3be` | +122 / −(mod) |
| `backend/app/services/whatsapp_gateway.py` | `f98f0e8` | `99fcaeb` | `2f44be2058c2` | +11 |
| `backend/app/main.py` | `9adc33b` | `d85b456` | `bbd99ca0b283` | +2 |
| `backend/tests/test_whatsapp_memory_persistence.py` (test desteği) | ABSENT | `232f26b` | `db60486e05f3` | +2 / −(mock `**kwargs`) |
| `backend/tests/test_whatsapp_memory_persistence_hardening.py` (test desteği) | ABSENT | `9d1e92a` | `4b6314a3f762` | +8 / −(mock `**kwargs`) |

**Toplam 4.7 üretim delta:** 8 dosya, **+759 / −77 satır**.

### Kritik gözlem — `memory_persistence.py` deployed'da ABSENT
`memory_persistence.py`, deployed `b5715fe` ağacında **yoktur**; `git log --diff-filter=A` ile `bafe5b0` ("feat(whatsapp): gateway belleğindeki mesajlar DB'ye kalıcılaştırılsın") commit'inde eklenmiştir. Yani **kayıtlı deployed commit, persistence alt sisteminin tanıtılmasından öncedir.** Bu nedenle bu dosya için "deployed vs HEAD" bir *drift* değil, "henüz dağıtılmamış özellik"tir. Canlı deployed commit hash'i üretim konaklarındaki `.deployed-commit` otoritesinden teyit edilmelidir (bkz. G).

---

## E. TEST SONUÇLARI (Test Results)

Yalıtılmış PostgreSQL 17 (`tezlify_test_47`) üzerinde, `tz44_pgplugin` (engine pool → `NullPool`) ile çalıştırıldı. Tüm tablolar rapor öncesi `TRUNCATE ... RESTART IDENTITY CASCADE` ile temizlendi.

| Paket | Sonuç | Not |
| --- | --- | --- |
| `/tmp/tz47tests/test_tz47_fixes.py` (**YENİ, yetkili**) | **11 passed** | P0-1, P0-2, P2-2 kapsar; her test `uuid4()` kullanıcı ile tam izole |
| `backend/tests/test_whatsapp_memory_persistence.py` | **25 passed** (2 dosya toplamı) | mock `_fake` → `**kwargs` (yeni seq-mode imzası) |
| `backend/tests/test_whatsapp_memory_persistence_hardening.py` | (yukarıda dahil) | `_flaky`/`_boom` yeni kwarg'ı kabul eder |
| **4.7 yetkili yeşil toplamı** | **36 passed** | |
| Downstream dokunulan modüller (`orchestration_sync`, `sync_job`, `memory_persist_fail_closed`, `diagnostics_audit_memory_gap`, `gateway_health`, `gateway_liveness`, `connect_metrics`) | **119 passed / 33 failed** | 33 başarısızlık **tamamen önceden var olan** `contacts.py:101` `dict(contact.custom_attributes or {})` kusurudur (4.7 dokunmadı; `git stash` ile kanıtlandı) |
| `/tmp/tz44tests/test_tz44_missing.py` | 4 failed / 4 passed | 4 başarısız = **eski davranış iddiaları** (tüm sayfa abort, cursor stall, rollback-then-rerun, collision'da `error` var) — 4.7'in düzelttiği davranışların ta kendisi; **superseded**, regression değil |
| `/tmp/tz46tests/test_tz46_audit.py` | 2 failed / 8 passed | 2 başarısız = eski manuel izolasyon sözleşmesi (çağıran `IntegrityError` yakalar, satır satır izole eder); 4.7 izolasyonu `_insert_messages_resilient` **içine** taşıdı → çağıran tarafında `dead==1` artık geçerli değil; **superseded**, regression değil |

### tz47 kapsamı (11 test, hepsi geçti)
- `test_p02_bulk_insert_happy_path`
- `test_p02_wa_duplicate_absorbed`
- `test_p02_client_only_conflict_isolates` (temiz satır yazılır + `dead_letter["count"]==1`, kısıt boş-olmayan string, PII yok)
- `test_p02_multiple_poisons_one_page`
- `test_p02_idempotency_second_turn`
- `test_p01_front_trim_does_not_skip` (seq `[4,5,6]` atlanmaz)
- `test_p01_append_does_not_skip` (13 kaydın tümü ziyaret edilir)
- `test_p01_epoch_reset_restarts_from_zero`
- `test_p01_cursor_reset_safe_rescan`
- `test_p22_status_shape` (P2-2 anahtarları mevcut)
- `test_drain_seq_mode_full` (seq drain 10 yazar, ikinci tur 0)

---

## F. DOĞRULAMA YAPILANLAR (Verification Performed)

- [x] 4 gateway JS dosyası `node --check` → hepsi OK.
- [x] 4 backend modülü import sanity (`memory_persistence`, `orchestration.sync`, `whatsapp_gateway`, `main`) → hepsi OK.
- [x] Yalıtılmış PG 17 üzerinde 4.7 yetkili paketi → **36 passed**.
- [x] Downstream dokunulan modüller → 119 passed; 33 başarısızlığın `contacts.py:101` önceden-var kusur olduğu `git stash` deneyiyle kanıtlandı (4.7 öncesi de aynı şekilde patlıyordu).
- [x] tz44/tz46 başarısızlıklarının eski davranış iddiaları olduğu, 4.7'in düzelttiği davranışları kodladığı tespit edildi (regression değil).
- [x] Per-file blob hash tablosu üretildi (D bölümü).
- [x] `git status`: 4.7 dışı değişiklikler (3.9.19 escrow pollution) **dokunulmadan bırakıldı** (bkz. I).

---

## G. ÜRETİM (PROD) YALNIZCA-OKUMA DOĞRULAMA KONTROL LİSTESİ (Sandbox'tan çalıştırılmadı)

Sandbox'ın üretime rotası/yetkisi yoktur; aşağıdaki adımlar **yalnızca-okuma** olup dağıtım öncesi üretim konakta elle yapılmalıdır. Hiçbiri veri değiştirmez.

1. **Canlı deployed commit teyidi:**
   `cat /opt/tezlify/.deployed-commit` → D bölümündeki `b5715fe` ile karşılaştır. Farklıysa, blob tablosunu canlı deployed hash ile yeniden üret.
2. **İkinci unique index var mı?** (schema değişmez, ama mevcut poison satırları 4.7 ile izole edilir):
   ```sql
   SELECT indexname FROM pg_indexes
   WHERE tablename='messages'
     AND indexname IN ('uq_msg_conv_wa_message_id','uq_msg_conv_client_message_id');
   ```
   İkincisi varsa ve ihlal eden satırlar mevcutsa, 4.7'in satır-seviyesi izolasyonu onları `dead_letter`'a düşürür; toplu insert artık tüm sayfayı düşürmez.
3. **`/health` kontrolü:** yanıtta `capacity` anahtarı (RAM mesaj/chat sayıları, `ram_chats_at_cap`, eviction özeti) ve `whatsapp_memory_persistence` bloğu mevcut olmalı.
4. **`/metrics` kontrolü:** `whatsapp_memory_persistence` bloğu `dead_letter_total`, `epoch_resets_total`, `stalled_pages_total`, `max_cursor_after_seq` vb. içermeli.
5. **Deployed-vs-local hash karşılaştırması:** D bölümündeki tabloyu canlı konaktaki dosya hash'leriyle eşle (dağıtım sonrası worktree hash'leri ile).
6. **Loop aktif mi?** 4.7 aktifleştirme yapmaz; mevcut loop davranışı değişmeden korunur (sadece sayfalama/izolasyon/metrik iyileşti).

---

## H. RİSK VE DAĞITIM HAZIRLIĞI (Risk & Deploy Readiness)

- **Düşük risk:** Tüm değişiklikler mevcut health/API sözleşmesini **genişletir** (yeni opsiyonel query param'lar, yeni `/health` ve `/metrics` alt anahtarları); mevcut alanları bozmaz.
- **PII güvenliği:** Tahliye ve dead-letter logları yalnızca reason/limit/count/constraint (SQLSTATE) içerir; mesaj id/body/phone/jid **loglanmaz**.
- **Geri alınabilirlik:** Değişiklikler koddadır, şema/migration yoktur. Geri alma = dosyaları önceki blob'a döndür (deployed→HEAD farkı bir drift değil, bkz. D).
- **Dağıtım sırası:** Eğer persistence alt sistemi (#D, `memory_persistence.py` bafe5b0'da tanıtıldı) henüz deployed değilse, 4.7'nin backend kısmı onunla birlikte dağıtılmalıdır; gateway ve backend değişiklikleri birlikte geçmeli (frontend sözleşmesi etkilenmez).
- **Açık nokta:** Kayıtlı deployed `b5715fe`, persistence alt sisteminden **önce**; canlı deployed hash'inin üretim konaktan teyidi (G.1) dağıtımdan önce zorunludur.

---

## I. YAPILMAMIŞ OLANLAR (What Was NOT Done)

- **Commit / push / deploy / restart / recreate / loop aktifleştirme yapılmadı.** Tüm 4.7 değişiklikleri worktree'de uncommitted durumda.
- **3.9.19 escrow pollution dokunulmadı:** Worktree'de `escrow.py`, `schemas/escrow.py`, `services/admin/escrow_service.py`, `api/v1/endpoints/escrow.py`, `test_admin_escrow_api.py`, admin frontend (`AdminEscrowPage.tsx`, `admin.ts`, `Sidebar.tsx`, `App.tsx`, `locales/*`, `types/admin.ts`), `auth/*`, `config.py` vb. değişiklikler mevcuttur. Bunlar 4.7 **kapsamı dışıdır** ve bu direktif altında commit edilmemeli / dağıtılmamalıdır.
- **`contacts.py:101` kusuru düzeltilmedi:** 4.7 kapsamı dışı; önceden var olan, 33 testi düşüren bağımsız bir hatadır.
- **Prod DB'ye hiçbir yazma yapılmadı** (SELECT/GET dışında).

---

## J. 4.8'E ERTELENENLER (Deferred to 4.8)

- Loop'un canlı aktifleştirilmesi ve uçtan uca canlı persistence doğrulaması.
- Canlı deployed hash teyidi + olası birlikte dağıtım planı (`memory_persistence.py` deployed değilse).
- `contacts.py:101` `custom_attributes` deserialize kusurunun kök neden analizi ve düzeltmesi.
- tz44/tz46 eski-davranış testlerinin 4.7 yeni sözleşmesine güncellenmesi (veya emekli edilmesi) — bu testler artık 4.7 davranışını yanlış iddia ediyor.

---

## K. KABUL SENARYOLARI (Acceptance Scenarios Covered)

| Senaryo | Durum |
| --- | --- |
| P0-1: ön-trim sırasında kuyruk atlanmaz | ✅ `test_p01_front_trim_does_not_skip`, `test_p01_append_does_not_skip` |
| P0-1: epoch sıfırlamada güvenli yeniden tarama | ✅ `test_p01_epoch_reset_restarts_from_zero`, `test_p01_cursor_reset_safe_rescan` |
| P0-2: tek zehirli `client_message_id` tüm sayfayı düşürmez; temiz satır yazılır | ✅ `test_p02_client_only_conflict_isolates`, `test_p02_multiple_poisons_one_page` |
| P0-2: `wa_message_id` çifti emilmeye devam eder (idempotent) | ✅ `test_p02_wa_duplicate_absorbed`, `test_p02_idempotency_second_turn` |
| P2-1: RAM kapasite/tahliye metriği mevcut, PII yok | ✅ `ramCapacitySnapshot`/`ramCapacitySummary`, `/health` `capacity` |
| P2-2: persistence metriği mevcut | ✅ `test_p22_status_shape`, `/metrics` `whatsapp_memory_persistence` |
| Sözleşme korunur (health/metrics genişler, bozulmaz) | ✅ import sanity + diff incelemesi |

---

## L. DURUŞ KOŞULU (Stop Condition) — DOĞRULANDI

Tüm 4.7 testleri ve doğrulamalar tamamlandı. **AŞAMA 4.8'e kendiliğinden geçilmedi.** Loop açılmadı, commit/push/deploy/restart yapılmadı. 4.7 değişiklikleri yerel worktree'de, dağıtıma hazır (ama dağıtılmamış) durumdadır.

**Özet sayılar:**
- 4.7 yetkili yeşil: **36 passed** (tz47 11 + prod memory-persistence 25).
- Downstream: **119 passed**; 33 önceden-var (`contacts.py`) başarısız — 4.7 ile ilgisiz.
- Superseded (eski davranış): tz44 4 + tz46 2 = **6** — regression değil.
- Delta: **+759 / −77** satır, 8 üretim dosyası + 2 test destek dosyası.
