# AŞAMA 4.34 — WhatsApp Canlı E2E Kabul Testleri ve Stage 4 Kapanışı

**Tarih:** 2026-11-01
**Ölçüm anı:** 11:19–11:25 UTC
**Deployed commit:** `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae`
**Backend imajı:** `sha256:1d639e816929d9a5486d5cb015f644c50ae2803ec119a3aa317dc2bbf517b41f`
**Gateway imajı:** `sha256:7905b32df9e19c0c22e7bee7ccaebd63623082491f477fcc1cf8ab0a1028b56d`
**Mod:** Salt-okunur production + deterministik test. **Production'a hiçbir yazma, mesaj gönderme, restart, deploy, commit veya push yapılmadı.**

---

## 0. SONUÇ

**`STAGE 4 CONDITIONALLY CLOSED`**

Gerekçe kısa:
- 4.27 (epoch reset cursor) ve 4.28 (initial sync jid chunking) düzeltmeleri **deploy edilmiş kodda** deterministik olarak kanıtlandı: **57 test + 7 harness kontrolü yeşil**.
- Canlı production'da inbound/outbound zinciri **gerçek trafikle** çalışıyor (24 saatte 184 inbound / 181 outbound), veri bütünlüğü temiz (0 null / 0 duplicate / 0 orphan), bridge canlı, persistence kapalı.
- **Neden tam `CLOSED` değil:** 4.28'in açık senaryolarından **2 (5000 geçmiş)** ve **8 (DB rollback)** yapısal olarak test edilemez (RAM tavanı 2000/sohbet; diff transaction sınırlarına dokunmuyor). Ayrıca **kontrollü test hesabına outbound**, **zorlanmış reconnect** ve **gerçek gateway restart** testleri açık onay + test hesabı gerektirir ve bu turda **yapılmadı**. Bunlar PASS sayılmadı.

---

## 1. BAŞLANGIÇ DURUMU (doğrulandı)

| Öğe | Beklenen | Ölçülen | Sonuç |
| --- | --- | --- | --- |
| `.deployed-commit` | `0b795ea` | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` | ✅ |
| Backend imajı | `sha256:1d639e…` | `sha256:1d639e816929d9a5486d5cb015f644c50ae2803ec119a3aa317dc2bbf517b41f` | ✅ |
| Gateway imajı | `sha256:7905b3…` | `sha256:7905b32df9e19c0c22e7bee7ccaebd63623082491f477fcc1cf8ab0a1028b56d` | ✅ |
| Backend başlangıç | — | `2026-11-01T11:02:52Z` (deploy anı) | ✅ |
| Gateway başlangıç | — | `2026-10-31T21:59:44Z` (değişmedi) | ✅ |

---

## 2. UYULAN GÜVENLİK SINIRLARI

| Kural | Durum |
| --- | --- |
| Production DB'ye test verisi yazma/silme | **Yapılmadı** — yalnızca SELECT |
| Gerçek müşteriye test mesajı | **Yapılmadı** — hiç mesaj gönderilmedi |
| QR / session reset / yeniden eşleştirme | **Yapılmadı** |
| Gateway/backend restart veya recreate | **Yapılmadı** — restart `0/0/0/0` |
| Persistence loop açma | **Yapılmadı** — `enabled=None` |
| Feature flag değiştirme | **Yapılmadı** |
| Merge / push / deploy | **Yapılmadı** |
| Mevcut müşteri mesajlarını değiştirme | **Yapılmadı** |
| Test hesabı yoksa gerçek müşteri kullanma | **Uyuldu** — canlı outbound testi yapılmadı, yalnızca mevcut trafik okundu |

---

## 3. TEST STRATEJİSİ (istenen öncelik sırası)

1. **Mevcut otomatik testler + deterministik harness** → uygulandı (§4, §5).
2. **İzole staging/test ortamında gerçek Baileys E2E** → bu turda staging yok; production'da mesaj göndermek yasak olduğu için **atlandı**.
3. **Production üzerinde yalnızca read-only doğrulama** → uygulandı (§6).

Testler deploy edilmiş kodun bulunduğu izole worktree'de çalıştırıldı: `/tmp/tz429-release` @ `0b795ea`. Taze SQLite test DB'si `scripts/provision_test_db.py` ile üretildi (**34 tablo**, `history_sync_states` / `lid_mappings` / `initial_sync_completed_at` mevcut). `-p no:randomly` ile sıra bağımsız.

---

## 4. DETERMİNİSTİK TEST SONUÇLARI

### 4.1 Backend (57 test, hepsi PASS)

| Dosya | Test | Sonuç |
| --- | --- | --- |
| `test_whatsapp_initial_sync_chunking.py` | 6 | ✅ PASS |
| `test_whatsapp_pagination_contract.py` | 10 | ✅ PASS |
| `test_whatsapp_memory_persistence.py` | 10 | ✅ PASS |
| `test_whatsapp_memory_persistence_hardening.py` | 15 | ✅ PASS |
| `test_whatsapp_phase2_b_sync_reconciliation.py` | 10 | ✅ PASS |
| `test_whatsapp_4_34_e2e_regressions.py` (yeni) | 6 | ✅ PASS |
| **Toplam** | **57** | **57 passed, 0 failed** |

Kritik testler (isimle):
- `test_initial_sync_never_pages_with_a_cross_request_offset` — hiçbir istek `offset>0` ile başlamaz.
- `test_initial_sync_does_not_skip_a_windowed_message_during_front_trim` — front-trim sırasında pencere kaydı atlanmaz (`genuine=0`).
- `test_epoch_change_triggers_a_safe_rescan_and_is_counted` + `test_tz427_epoch_reset_must_not_be_reported_as_a_stall` — epoch reset `after_seq=0` ve sahte stall yok.
- `test_front_trim_does_not_skip_messages_in_seq_mode` — seq modu eviction'a rağmen atlamaz.
- `test_reconnect_rerun_does_not_duplicate` — reconnect sonrası yeniden sync duplicate üretmez.
- `test_partial_failure_survives_and_retry_dedups` — kısmi başarısızlık + retry dedup.
- `test_chunk_replay_is_idempotent`, `test_two_concurrent_workers_do_not_duplicate`, `test_message_without_wa_id_is_never_duplicated` — idempotency/duplicate.

### 4.2 Gateway front-trim harness (gerçek gateway kodu, sentetik depo)

`whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs` → **PASS (7 checks)**:

```
[A offset]  pages=3 delivered=250 window=250 missed=1 genuine=1
[B chunked] pages=3 delivered=250 window=250 missed=1 genuine=0
[C istek]   offset_pages=3 chunked_pages=3
```

Yorum: offset stratejisi penceredeki **1 gerçek kaydı atlar** (`genuine=1`); parçalı strateji **hiç atlamaz** (`genuine=0`); istek sayısı **artmaz** (3 = 3).

---

## 5. MUTASYON KANITI — testler canlı mı?

"Yeşil test ölü guard'ı gizleyebilir" ilkesi gereği iki yeni test **mutasyonla** doğrulandı. Kod geçici olarak bozuldu, test çalıştırıldı, sonra **birebir geri yüklendi** (`git status` diff **boş**).

| Mutasyon | Beklenen | Sonuç |
| --- | --- | --- |
| `only_conv_ids` daraltması yok sayıldı (`target_jids = tüm jid'ler`) | ilgili test düşmeli | **1 failed, 5 passed** — tam olarak `test_only_conv_ids_narrows_the_request_before_chunking` |
| `recovery_pass` sayaç guard'ı kaldırıldı (`if not recovery_pass:` silindi) | ilgili test düşmeli | **1 failed, 5 passed** — tam olarak `test_recovery_pass_does_not_overwrite_messages_total` (`30 == 424242` hata) |

Her iki mutasyon sonrası `sync.py` SHA'sı orijinaline döndü; `git status` o dosya için **boş**. Yani testler gerçekten davranışı koruyor, "boş yeşil" değil.

**Yeni test artifact'i:** `docs/audits/ASAMA-4.34-regression-tests.patch` (317 satır; `release/backend-only-seq-safety` ağacına uygulanabilir). Testler main worktree'ye **eklenmedi** çünkü main'de `_bulk_chunks` yok (4.28 fix yalnız release branch'te).

---

## 6. CANLI PRODUCTION READ-ONLY KANITI

### 6.1 Altyapı ve veri bütünlüğü

| Ölçüm | Değer | Sonuç |
| --- | --- | --- |
| Restart (gw/be/db/caddy) | `0/0/0/0` | ✅ |
| `max(id)` | 168912 | bilgi |
| `count(id ≤ 168906)` (watermark) | **9652** | ✅ T0/T1 ile aynı — veri kaybı yok |
| `messages` / `conversations` / `contacts` | 9658 / 126 / 1538 | bilgi |
| NULL `wa_message_id` | **0** | ✅ |
| Duplicate `(conversation_id, wa_message_id)` | **0** | ✅ |
| Orphan mesaj | **0** | ✅ |
| Karantina | 1 kayıt / 9 mesaj (değişmedi) | ✅ |

### 6.2 Bridge / WebSocket liveness

```
gateway_bridge.connected       = true
gateway_bridge.last_pong_at    = 2026-11-01T11:19:03Z   (ölçüm anında taze)
gateway_bridge.reconnect_count = 1
```

Ping/pong canlı; yarım kalmış soket yok. `reconnect_count=1` backend başlangıcından (11:02:52) bu yana bir kez yeniden bağlandığını, sonrasında kararlı olduğunu gösterir.

### 6.3 Gateway RAM durumu

```
sessions: total=1 connected=1 pending_qr=0 orphaned=0
ram_messages_total=162  ram_chats_total=3  ram_chats_at_cap=0
evictions_total=11 (raw_chat_cap)  last_eviction_at=11:12:10Z
```

Not: Canlı RAM deposu yalnızca son trafiği tutar (3 sohbet / 162 mesaj); geçmiş DB'de (9658). Bu, persistence loop kapalıyken beklenen durumdur.

### 6.4 Inbound / outbound zinciri (gerçek trafik, PII'siz)

| Ölçüm | Değer |
| --- | --- |
| Son 24 saat inbound | **184** |
| Son 24 saat outbound | **181** |
| Inbound durum dağılımı | `READ 38`, `RECEIVED 146` |
| Outbound durum dağılımı | `DELIVERED 178`, `READ 3` |
| Son 24 saat inbound `wa_message_id` eksik | **0** |
| Son 24 saatte mesaj olan sohbet | 5 |
| Son 10 mesaj | hepsi `has_wa=true`, en yenisi 11:21 |

Yorum: Mesajlar gateway → backend → DB zincirinde **gerçek zamanlı** akıyor; inbound `RECEIVED→READ`, outbound `DELIVERED→READ` durum geçişleri görülüyor. Bu, canlı müşteri trafiğinin **okunmasıyla** elde edildi; **hiçbir test mesajı gönderilmedi**.

### 6.5 Persistence

```
whatsapp_memory_persistence.enabled = null
config_enabled = false   runs = 0   task_running = false
```

Kill-switch **kapalı**; RAM verisi PostgreSQL'e aktarılmıyor.

---

## 7. SENARYO KAPSAM MATRİSİ

### 7.1 4.28'de açık kalan 5 senaryo (tanımlar değiştirilmedi)

| # | Senaryo (4.28 tanımı) | 4.28 | 4.34 sonucu | Kanıt / gerekçe |
| --- | --- | --- | --- | --- |
| **2** | 5000 geçmiş | KAPSAM DIŞI | **NOT TESTABLE** | Gateway RAM tavanı **2000/sohbet**; 5000 erişilemez. Yapısal sınır, hata değil. |
| **6** | Gateway restart + epoch değişimi | KAPSAM DIŞI | **PASS (epoch mantığı) / restart NOT PERFORMED** | `test_epoch_change_…` + `test_tz427_…` (after_seq=0, sahte stall yok). Gerçek restart RAM kaybı riski nedeniyle yapılmadı. |
| **8** | DB rollback | KAPSAM DIŞI | **NOT TESTABLE** | Diff transaction sınırlarına dokunmuyor; rollback senaryosu bu değişiklikle ilgisiz. |
| **10** | Reconnect sonrası yeniden sync | KAPSAM DIŞI | **PASS (idempotency) / reconnect NOT FORCED** | `test_reconnect_rerun_does_not_duplicate` + yeni `test_second_initial_sync_is_idempotent`. Gerçek soket reconnect zorlanmadı. |
| **11** | Büyük gruplar | KISMİ | **PASS** | Yeni `test_group_jid_is_treated_as_one_conversation_without_skipping` — grup jid'i tek sohbet, 60→50 pencere, atlama yok. |

### 7.2 İstenen 9 davranış

| # | Davranış | Sonuç | Kanıt |
| --- | --- | --- | --- |
| 1 | Inbound gateway→backend→DB→frontend | **PASS (veri katmanı) / PARTIAL (UI)** | 184 inbound, 0 eksik `wa_message_id`, RECEIVED→READ. UI hidrasyonu bu turda çalıştırılmadı. |
| 2 | Outbound kontrollü test hesabı + durum | **BLOCKED (kontrollü hesap) / PASS (yol gözlemi)** | Canlı outbound 181, DELIVERED/READ. Test hesabı verilmediği için **yeni test mesajı gönderilmedi**. |
| 3 | Initial sync JID chunking + sayfalama | **PASS (deterministik)** | 6 test + harness 7 kontrol; her istek `offset=0`, jids dolu, ≤20. |
| 4 | Idempotency / duplicate | **PASS** | 0 dup pair + `chunk_replay_idempotent` + concurrent + reconnect rerun. |
| 5 | Epoch değişiminde seq cursor reset | **PASS (deterministik)** | C5 + TZ427: `after_seq=0`, cursor `(yeni epoch, değer)`. |
| 6 | Kısmi başarısızlık retry/recovery | **PASS (deterministik)** | `test_partial_failure_survives_and_retry_dedups`, `test_partial_db_error_then_safe_retry`. |
| 7 | Gateway RAM ↔ DB tutarlılığı | **PARTIAL** | Persistence loop **kapalı** ⇒ uzlaştırma çalışmıyor. DB'de dup/orphan yok; tam tutarlılık loop açılmadan kanıtlanamaz. |
| 8 | WebSocket ping/pong + reconnect | **PASS (liveness)** | `last_pong_at` taze, `connected=true`, `reconnect_count=1`. |
| 9 | Front-trim kaynaklı atlamanın tekrarlamaması | **PASS (deterministik)** | Harness A/B (`genuine=1→0`) + chunking testi. |

---

## 8. İKİ P2 AÇIĞI — KAPATILDI

### 8.1 `only_conv_ids` + chunking kombinasyonu

4.28'de `request_jids` "tek daraltma kaynağı" olarak belirtilmiş ama parçalamayla birlikte test edilmemişti. Eklendi:

- `test_only_conv_ids_narrows_the_request_before_chunking` — 25 sohbetten 5'i seçilir → **tek istek, yalnız 5 jid**, hedef dışı sohbet yazılmaz.
- `test_only_conv_ids_full_set_still_chunks` — 25 sohbetin tamamı seçilir → **2 parça** (20+5), her istek `offset=0`, 1250 kayıt.

Mutasyonla doğrulandı (§5).

### 8.2 `recovery_pass` sayaç koruması

- `test_recovery_pass_does_not_overwrite_messages_total` — `messages_total=424242` iken recovery pass çalışır → sayaç **korunur**, veri yine yazılır.
- `test_normal_pass_does_overwrite_messages_total` — kontrol grubu: normal turda sayaç gerçek toplama (30) güncellenir.

Mutasyonla doğrulandı (§5).

---

## 9. KAPANIŞ KARARI

**`STAGE 4 CONDITIONALLY CLOSED`**

### 9.1 Karşılanan kriterler

| Kriter | Durum |
| --- | --- |
| 4.27/4.28 düzeltmeleri deploy edilmiş kodda deterministik | ✅ 57 test + 7 harness |
| Kritik inbound/outbound akışı (veri katmanı) | ✅ canlı trafikle |
| Initial sync + chunking | ✅ deterministik |
| Epoch reset + recovery | ✅ deterministik |
| Duplicate / veri bütünlüğü ihlali yok | ✅ 0/0/0 |
| WebSocket liveness | ✅ taze pong |
| Açık P1/P0 yok | ✅ |
| Production başlangıç güvenliği korundu | ✅ restart 0/0/0/0, persistence kapalı |
| Kalan P2 riskleri belgelendi | ✅ §10 |

### 9.2 Kapanışı koşullu yapan maddeler

1. **Senaryo 2 ve 8 yapısal olarak test edilemez** (RAM tavanı 2000/sohbet; diff transaction sınırlarına dokunmuyor). Bunlar PASS sayılmadı; "kapsam dışı, belgelendi" olarak kabul edilmeleri gerekir.
2. **Kontrollü test hesabına outbound E2E yapılmadı** — test hesabı/onay yok. Canlı outbound **yolu** mevcut trafikle doğrulandı, ancak "kontrollü hesap" senaryosu çalıştırılmadı.
3. **Zorlanmış reconnect ve gerçek gateway restart yapılmadı** — gateway restart RAM kaybı riski taşır (invariant A6). Epoch mantığı deterministik doğrulandı, canlı restart değil.

---

## 10. KALAN RİSKLER

| # | Risk | Önem | Durum |
| --- | --- | --- | --- |
| R1 | Kontrollü test hesabına outbound E2E yapılmadı | P2 | Açık onay + test hesabı bekliyor |
| R2 | Zorlanmış reconnect / gerçek gateway restart yapılmadı | P2 | RAM kaybı riski; deterministik kanıtla ikame edildi |
| R3 | Senaryo 2 (5000 geçmiş) ve 8 (DB rollback) test edilemez | P3 | Yapısal sınır, belgelendi |
| R4 | Gateway RAM ↔ DB tutarlılığı loop kapalıyken tam kanıtlanamaz | P2 | Persistence aktivasyonu ayrı iş |
| R5 | Persistence loop aktivasyonu | P1 (ayrı iş) | 4.27 fix deploy edildi; aktivasyon kendi güvenlik kapısını gerektirir |
| R6 | UI hidrasyonu (frontend) bu turda çalıştırılmadı | P3 | Veri katmanı doğrulandı; UI ayrı smoke test |

---

## 11. STAGE 5'E GEÇİŞ İÇİN TEKNİK HAZIR OLMA KARARI

**Koşullu EVET.**

Gerekçe:
- Veri güvenliğini ilgilendiren iki düzeltme (4.27 epoch reset, 4.28 jid chunking) **deploy edilmiş kodda** deterministik olarak kanıtlandı ve canlı production sağlıklı (watermark 9652 sabit, 0 duplicate/orphan, bridge canlı).
- Açık P1/P0 yok.
- Ancak Stage 5'e geçmeden önce şu iki koşulun kabul edilmesi/karara bağlanması gerekir:
  1. Senaryo 2/8'in "yapısal olarak test edilemez" kabulü.
  2. Persistence loop aktivasyonunun **ayrı bir aşama** olarak, kendi güvenlik kapısıyla ele alınması (bu aşamada açılmadı).

**Öneri:** Stage 5'e geçmeden önce (isteğe bağlı ama önerilir) kontrollü bir test hesabı sağlanırsa outbound E2E + zorlanmış reconnect çalıştırılıp `STAGE 4 CLOSED`'a yükseltilebilir. Bu, açık onay gerektirir.

---

## 12. BU TURDA YAPILMAYANLAR (bilinçli)

- ❌ Production DB'ye yazma · ❌ gerçek müşteriye test mesajı · ❌ QR/session reset
- ❌ gateway/backend restart/recreate · ❌ persistence açma · ❌ feature flag değiştirme
- ❌ merge / push / deploy · ❌ commit
- ❌ staging ortamı kurma (mevcut değil)

---

## 13. ARTIFACT'LER

| Dosya | Açıklama |
| --- | --- |
| `docs/audits/ASAMA-4.34-regression-tests.patch` | Yeni 6 deterministik regresyon testi (release branch'e uygulanabilir) |
| `/tmp/tz429-release/backend/tests/test_whatsapp_4_34_e2e_regressions.py` | Testlerin çalıştırıldığı izole kopya |
| `/tmp/tz434-test.db` | Taze provision edilmiş SQLite test DB'si (34 tablo) |
| `/tmp/tz434-probe/tests_all.log` | 57 testlik birleşik koşu logu |
| `/tmp/tz434-probe/mut1.log`, `mut2.log` | Mutasyon testi logları |

---

*Bu raporda anahtar, token, private key, JID, telefon numarası veya mesaj gövdesi yoktur. Yalnızca sayımlar, durum kodları ve özet metrikler yer alır. Yapılmayan işlemler yapılmış gösterilmedi; onay gerektiren canlı testler PASS sayılmadı.*
