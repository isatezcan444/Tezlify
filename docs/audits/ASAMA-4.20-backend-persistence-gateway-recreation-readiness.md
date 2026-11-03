# Aşama 4.20 — Backend Persistence Readiness & Gateway Recreation Safety Audit

**Tarih:** 2026-11-01 00:05–00:30 +0300
**Mod:** SALT-OKUNUR denetim. Deploy YOK, restart YOK, DB yazma YOK, persistence loop açılmadı.
**Sonuç:** ⚠️ **READY WITH CONDITIONS**

---

## 0. Özet (Executive Summary)

Üretim `cbe4f509` üzerinde çalışıyor; gateway release adayı (`20c88bb`) **push edildi ama deploy edilmedi**.
Bu oturumda RAM ile DB bağımsız olarak ölçüldü:

- **RAM 9168 mesaj / 100 sohbet**, **DB 9464 mesaj / 126 sohbet**
- **RAM_ONLY = 0** → RAM'deki her mesaj DB'de var
- **DB_ONLY = 296** → ve bu 296'nın tamamı **2000/sohbet cap taşması** (206 + 90), açıklanamayan tek kayıt yok
- Sohbet kümeleri **birebir**: DB'de mesajı olan 100 sohbet = RAM'deki 100 sohbet

Yani **şu anda** gateway container'ı yeniden oluşturulsa RAM'deki hiçbir mesaj kaybolmaz; hepsi DB'de.
Durability'nin asıl taşıyıcısı RAM değil, gateway'in **Postgres event outbox**'ı: her kalıcı olay önce
`whatsapp_private.event_outbox`'a yazılıyor (1187 kayıt, **tamamı DELIVERED**, 0 PENDING/IN_FLIGHT,
max attempts 1).

**Neden READY değil:** iki yapısal boşluk var.
1. **Persistence loop KAPALI** (`config_enabled:false`, `runs:0`) → RAM→DB telafi mekanizması **hiç çalışmıyor**.
   Güvence "ölçüm anı + outbox" üzerine kurulu; "drain yakalar" güvencesi yok.
2. Deploy edilen kodda **toplu geçmiş insert'i savepoint'siz** (4.7'nin P0-2 düzeltmesi). Tek bir zehirli
   satır bütün bir geçmiş sayfasını düşürebilir. Canlı mesaj yolu korumalı, geçmiş backfill'i değil.

---

## 1. İncelenen Üretim Kimliği

| Nesne | Değer |
| --- | --- |
| `.deployed-commit` | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| Backend container | `tezlify-backend`, image `sha256:06ce4fe12874…`, **Up 47 saat (healthy)**, restart 0 |
| Gateway container | `tezlify-gateway`, image `sha256:a1ba2572c409…`, **Up 4 gün (healthy)**, restart 0 |
| DB | `postgres:17-alpine`, Up 4 hafta (healthy) |
| Gateway oturumu | `1bd78836-c084-4cbf-b333-9386d44b7bd7`, **CONNECTED**, `auto_restore: true` |

**Konteyner içeriği = deploy edilen commit (byte düzeyinde kanıt):** üç kritik dosyanın SHA-256'sı
konteynerde ve `cbe4f509` blob'unda **birebir** aynı:

| Dosya | Konteyner SHA-256 | cbe4f509 blob SHA-256 | Sonuç |
| --- | --- | --- | --- |
| `backend/.../memory_persistence.py` | `6a1e5860cb87…` | `6a1e5860cb87…` | **EŞLEŞTİ** |
| `backend/.../orchestration/sync.py` | `026cb479aecb…` | `026cb479aecb…` | **EŞLEŞTİ** |
| `whatsapp-gateway/src/index.js` | `4f2e435e18e9…` | `4f2e435e18e9…` | **EŞLEŞTİ** |

> Not: `shasum -a 256` = SHA256; git blob/rev-parse = SHA1. Burada bilinçli olarak **SHA256** kullanıldı.

---

## 2. Production ↔ 4.7 Candidate Farkı

`release/backend-only-4.7` = `2236cae` (parent `17ccbc9`). **Deploy edilmedi** — varsayılmadı, ölçüldü.

| Dosya | cbe4f509 (üretim) | 2236cae (4.7) | Durum |
| --- | --- | --- | --- |
| `backend/app/services/whatsapp/memory_persistence.py` | `794e44813812` | `e12c030bd239` | **FARKLI** |
| `backend/app/main.py` | `d85b456079c1` | `bbd99ca0b283` | **FARKLI** |
| `backend/app/api/v1/endpoints/whatsapp.py` | `dce9679057cb` | `dce9679057cb` | AYNI |

4.7'nin backend kapsamı: 8 dosya, **+1145 / −61** (memory_persistence +241, sync +144,
test_pagination_contract +545, test_message_insert_isolation +253, main +2, gateway_client +11).
Yani **P0-1 (seq cursor) ve P0-2 (zehirli satır izolasyonu) düzeltmelerinin ikisi de üretimde YOK.**

Gateway tarafı: `20c88bb` yalnızca `whatsapp-gateway/` değiştiriyor (7 dosya, +1210/−23).
Backend dosyaları `cbe4f509` ile **birebir aynı** — gateway deploy'u backend'i değiştirmez.

---

## 3. Persistence Mimarisi (üretimde gerçekten çalışan zincir)

```
WhatsApp ──► Baileys ──► session-manager._ingestUpsertMessage
                              │
                              ├─► RAM store (messagesByChat, sohbet başına 2000 cap)   ← CACHE
                              └─► _emit(event)
                                     │
                                     ▼
                          events.js publish()
                                     │
                    ┌────────────────┴─────────────────┐
                    │ eventOutbox.enqueue()  (await)   │  ← DURABLE, Postgres
                    │ whatsapp_private.event_outbox    │     (şifreli ciphertext+nonce+tag)
                    └────────────────┬─────────────────┘
                                     │ pumpOutbox()
                                     ▼
                        /ws/gateway  ──► backend ingest_gateway_event()
                                              │
                                              ├─► processed_events (idempotency)
                                              ├─► conversations / contacts upsert
                                              └─► messages INSERT (SAVEPOINT + uq_msg_conv_wa_message_id)
                                                     │
                                                     ▼
                                            backend ack → outbox DELIVERED
```

| # | İstenen inceleme | Bulgu | Dosya / fonksiyon | Üretimde? |
| --- | --- | --- | --- | --- |
| 1 | Gateway→backend ingestion | WebSocket `/ws/gateway`, `gateway_event_ack/nack` protokolü | `whatsapp-gateway/src/events.js` | **VAR** |
| 2 | Event processing + idempotency | `event_id` ile `ON CONFLICT DO NOTHING` (outbox) + backend'de unique constraint | `outbox/postgres-event-outbox.js:123`, `orchestration/events.py:1029` | **VAR** |
| 3 | `processed_events` | **`whatsapp_private.processed_events`** (public'te YOK — ilk sorgum bu yüzden boş döndü). 3802 satır. 7 günlük retention ile temizleniyor | `outbox/postgres-event-outbox.js:239` | **VAR** |
| 4 | `messages`'a kalıcı yazma | Savepoint + `IntegrityError` → kazanan satırı **adopt et** (`_recover_message_new_after_integrity_error`) | `events.py:1029-1050` | **VAR** |
| 5 | Conversation/contact korunması | `ensure_conversation_race_safe` + `upsert_contact`; 126 conversation / 1538 contact, 0 orphan | `events.py:879` | **VAR** |
| 6 | Transaction/commit hata yönetimi | Canlı yol: nested savepoint ✅. **Toplu geçmiş yolu: savepoint YOK** ❌ (bkz. R-P1-2) | `orchestration/sync.py:_insert_messages_resilient` | **VAR ama eksik** |
| 7 | Yeniden bağlanma sonrası geri kazanım | Outbox PENDING/IN_FLIGHT kuyruğu 10 sn'de bir `pumpOutbox`; `FOR UPDATE SKIP LOCKED` | `events.js:388-395` | **VAR** |
| 8 | Sequence cursor / `seqEpoch` / `_seq` | Üretimde **YOK**. `_seq` yalnızca `20c88bb`'de. Üretim drain'i offset tabanlı | — | **YOK** |
| 9 | RAM boşken geçmişi sunma | UI geçmişi **DB'den** okur: `get_messages` → `select(Message)` + timestamp keyset | `whatsapp_service.py:1149-1181` | **VAR** |
| 10 | Persistence loop / background job | **KAPALI**: `enabled=null, config_enabled=false, runs=0, task_running=false, cursor_count=0` | `/health.whatsapp_memory_persistence` | **KAPALI** |

**Kritik mimari sonuç:** Mesajın kalıcılığı RAM'e değil, **outbox'a** bağlı. RAM bir önbellek.
Bu yüzden RAM kaybı (gateway recreation) tek başına mesaj kaybı demek değil.

---

## 4. Runtime Health

### Backend `/health`
```json
"gateway_bridge": {"connected": true, "last_event_at": "2026-10-31T21:06:25.702784+00:00",
                   "last_pong_at": "2026-10-31T21:06:25.702820+00:00", "reconnect_count": 1}
"whatsapp_memory_persistence": {"enabled": null, "runs": 0, "inserted_total": 0,
                                "errors_total": 0, "last_error": null,
                                "cursor_count": 0, "max_cursor_offset": 0,
                                "config_enabled": false, "task_running": false}
"whatsapp_identity_quarantine": {"available": true, "quarantined": 0, "messages_held": 0}
```
- Alan **mevcut** (NOT EXPOSED değil). `config_enabled:false` = `WHATSAPP_MEMORY_PERSIST_ENABLED` **set edilmemiş**.
- Fail-closed doğru çalışıyor: yalnızca `true`/`1` açar; yoksa kapalı.
- Bridge canlı (son olay audit anında ~1 dk önce).

### Gateway `/health`
```json
{"status":"ok","database":"connected","pool":{"total":1,"idle":1,"waiting":0},
 "sessions":{"total":1,"connected":1,"pending_qr":0},"auto_restore":true,"orphaned_sessions":0}
```
- `capacity` alanı **YOK** — bu 4.15/4.17 eklentisidir, üretimde değil (beklenen).

### Outbox durumu (Postgres)
| Ölçüm | Değer |
| --- | --- |
| Toplam | 1187 |
| PENDING | **0** |
| IN_FLIGHT | **0** |
| DELIVERED | 1187 |
| Bekleyen en eski kayıt | 0 dk |
| Max attempts | **1** (hiç retry olmamış) |
| `processed_events` | 3802 |

### Loglar
- Gateway (son 400 satır): `event_outbox_batch_sent` normal akışta; **orphan / FK 23503 / outbox hatası: 0**
- Backend (son 400 satır): persistence ile ilgili satır: **0** (loop kapalı olduğu için beklenen)

---

## 5. DB / RAM Reconciliation (READ ONLY)

**Yöntem ve tutarlılık sınırı:** RAM envanteri gateway'in `/messages/bulk` ucundan **10 sayfa × 1000**
ile çekildi; DB envanteri aynı anda `SELECT wa_message_id FROM messages` ile alındı. Kimlik anahtarı
iki tarafta da **`wa_message_id`** (gateway `id` alanı ms-zaman damgasıdır ve sohbetler arası çakışır —
ilk denemede 215 yanlış "duplicate" bu yüzden çıktı, anahtar düzeltildi). Ölçümler arasında ~30–60 sn
var; bu pencerede gelen yeni mesajlar DB'de görünüp RAM'de görünmeyebilir (MAX_TS farkı: DB 25 sn ileri).

| Metrik | Değer |
| --- | --- |
| RAM toplam (`total` alanı) | **9168** |
| RAM benzersiz `wa_message_id` | **9168** (dup 0, null 0) |
| DB `messages` | **9464** |
| DB `wa_message_id` NOT NULL | 9464 (**null 0**) |
| **RAM_ONLY** | **0** ✅ |
| **DB_ONLY** | **296** |
| Kesişim | 9168 |
| Duplicate `wa_message_id` (DB) | **0** |
| Orphan mesaj (conversation yok) | **0** |
| `conversations` | 126 |
| `contacts` | 1538 |
| RAM sohbet sayısı | **100** |
| DB'de mesajı olan sohbet | **100** ✅ (birebir) |
| DB'de mesajsız conversation | 26 |
| 2000 cap'te olan RAM sohbeti | **2** |
| DB'de >2000 mesajlı sohbet | **2** |
| Tek sohbette max mesaj | **2206** |
| Mesaj zaman aralığı | 1720265876 (2024-07-06) → 1793479071 (2026-11-01) |

**DB_ONLY 296'nın tam açıklaması:**

| Sohbet (DB conv id) | DB | RAM | Fark |
| --- | --- | --- | --- |
| 38289 | 2206 | 2000 | **206** |
| 38291 | 2090 | 2000 | **90** |
| **Toplam** | | | **296** ✅ |

Yani 296 = 206 + 90. Cap taşması dışında **açıklanamayan tek kayıt yok**. Bu bir veri kaybı değil,
RAM'in sohbet başına 2000 ile sınırlı olmasının doğal sonucu — ve o mesajlar **DB'de duruyor**.

> Önceki oturumun 9163/9246/83 ölçümü **teyit edilmedi, yeniden ölçüldü**: bugün 9168/9464/0/296.
> Sayılar büyümüş (yeni mesajlar) ve DB_ONLY 83→296 çıkmış; ikisi de cap taşmasının büyümesiyle tutarlı.

---

## 6. Gateway Recreation Senaryosu

| Adım | Ne olur | Kanıt |
| --- | --- | --- |
| 1. Container yeniden oluşturulur | Yeni image, yeni process | — |
| 2. RAM store boş başlar | `messagesByChat` boş; sohbet başına 2000 cap yeniden dolar | RAM = cache |
| 3. Oturum otomatik geri gelir | `auto_restore: true`; QR gerekmez (auth state şifreli kalıcı) | gateway `/health` |
| 4. Outbox replay | `PENDING/IN_FLIGHT` ne varsa 10 sn'de bir pump edilir; **şu an 0** | 1187/1187 DELIVERED |
| 5. Geçmiş backfill | Gateway ilk senkronda sohbet başına en yeni ~50 mesajı olay olarak yayar → outbox → backend → DB (idempotent) | A6 invariant + kod |
| 6. Frontend yeniden senkronize olur | UI geçmişi **DB'den** okur (`get_messages`), gateway RAM'inden değil | `whatsapp_service.py:1149` |
| 7. Kullanıcı ne görür | Kayıp **yok** (RAM_ONLY=0), duplicate **yok** (unique + savepoint + adopt) | §5, §3 |

### Açık sorulara yanıtlar

**S1. RAM kaybolduğunda hangi veriler DB'den geri kurulabilir?**
Tamamı: 9464 mesaj, 126 conversation, 1538 contact, 100 sohbetin tüm geçmişi. UI DB'den okuduğu için
kullanıcı görünümü değişmez.

**S2. Hangi veriler yalnızca RAM'de?**
**Şu an hiçbiri** (RAM_ONLY = 0). Yapısal olarak RAM'de kalabilecek tek şey, outbox yazımı başarısız
olduğunda "best-effort" yola düşen olaydır (`events.js:358-368`) — bu durumda olay yalnızca canlı soketten
gider, backend almazsa kaybolur. Ölçümde böyle bir durum yok (0 enqueue hatası, max attempts 1).

**S3. DB_ONLY mesajlar yeniden hydrate edilebilir mi?**
Evet, gerek yok: zaten DB'de ve UI DB'den okuyor. Gateway'in `bulk` ucu onları **göstermez** (cap),
ama bu uç UI'nin kaynağı değil, yalnızca persistence drain'inin kaynağı (o da kapalı).

**S4. Sequence epoch değişimi doğru resync başlatır mı?**
Üretimde sequence yok → soru **uygulanamaz (N/A)**. `seqEpoch` yalnızca `20c88bb` gateway + 4.7 backend
birlikte deploy edildiğinde devreye girer. Bugün ne üretim gateway'i `afterSeq` gönderiyor ne de backend
gönderiyor.

**S5. Eski cursor + yeni epoch karşılaşırsa?**
Üretimde cursor yok (`cursor_count: 0`, loop kapalı) → N/A. 4.7 kodunda epoch uyuşmazlığı `after=0`'a
düşüp tam resync yapar (test F/11c ile kanıtlı, ama **deploy edilmemiş kod**).

**S6. Persistence mekanizması recreation sonrası yeterli mi?**
**Canlı mesajlar için evet** — çünkü kalıcılık RAM'e değil outbox'a bağlı. **Geçmiş backfill için kısmen**:
4.7'nin savepoint düzeltmesi yok (R-P1-2). **RAM→DB drain güvencesi için hayır** — loop kapalı (R-P1-1).

**S7. Deploy sırasında kayıp/duplicate riski var mı?**
- **Duplicate: yok.** Backend insert idempotent (`uq_msg_conv_wa_message_id` + savepoint + kazananı adopt);
  outbox `event_id` ile `ON CONFLICT DO NOTHING`.
- **Kayıp: yalnız outbox yazımı başarısız olursa** (best-effort fallback). Ölçülen: 0 hata.
- **Geçmiş backfill: riskli** (P1-2) — zehirli satır bir sayfayı düşürürse o sayfa DB'ye girmez.

---

## 7. Testler

Taze ve izole SQLite test DB'si (`/tmp/tz420_test.db`, 34 tablo) üzerinde, **deploy edilen backend kodu**
(`/tmp/tz415-gw`, backend ağacı `cbe4f509` ile birebir) çalıştırıldı. Üretime hiçbir test yazımı yapılmadı.

| Test dosyası | Kapsam | Sonuç |
| --- | --- | --- |
| `test_whatsapp_memory_persistence.py` | Drain, sayfalama, dedup, cursor | PASS |
| `test_whatsapp_memory_persistence_hardening.py` | 7 sertleştirme senaryosu | PASS |
| `test_memory_persist_fail_closed.py` | Flag fail-closed | PASS |
| `test_deploy_persistence_flag_guard.py` | Deploy kapısı | PASS |
| **Toplam** | `-p no:randomly` | **134 passed / 2.46 s** |

**Koşulmayanlar ve nedeni:**
- `test_whatsapp_pagination_contract.py` ve `test_whatsapp_message_insert_isolation.py` **yalnızca 4.7'de
  var** → deploy edilen kodda mevcut değil, çalıştırılamaz. (Bu iki dosya, üretimde eksik olan iki
  düzeltmenin testleridir.)
- Gateway seq testleri 4.15/4.17'de koşuldu (8/8 + 32/32); üretim gateway'inde `_seq` olmadığı için
  bu davranış üretimde **etkin değil**.

---

## 8. Risk Tablosu

| ID | Seviye | Bulgu | Kanıt | Bileşen | Kullanıcı etkisi | Recreation ilişkisi | Düzeltme | Prod yazma/deploy gerekir? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **R-P1-1** | **P1** | Persistence loop **kapalı** (`config_enabled:false, runs:0`). RAM→DB telafi mekanizması hiç çalışmıyor; güvence yalnızca outbox'a bağlı | `/health.whatsapp_memory_persistence`; backend loglarında 0 persistence satırı | Backend persistence | Bugün yok (RAM_ONLY=0). Outbox yazımı bir kez başarısız olursa o mesaj yalnız RAM'de kalır | Recreation o anda RAM'de kalan her şeyi siler | Ya loop'u **4.7 backend ile birlikte** aç, ya da outbox hatasını P0 alarmına bağla | **Evet** (env + deploy) |
| **R-P1-2** | **P1** | Toplu geçmiş insert'inde **savepoint yok** (4.7 P0-2). `wa_message_id` dışı bir unique çakışma bütün sayfayı düşürür | `sync.py:_insert_messages_resilient` (cbe4f509) vs 2236cae diff; test dosyası yalnız 4.7'de | Backend history sync | Geçmiş backfill sessizce eksik kalabilir (canlı mesajlar etkilenmez) | Recreation sonrası backfill bu yoldan geçer | Backend 4.7 deploy | **Evet** |
| **R-P2-1** | P2 | Gateway `20c88bb`'deki seq/epoch desteği, backend 4.7 olmadan **etkisiz** (backend `afterSeq` göndermiyor) | `_seq` yalnız 20c88bb'de; üretim backend `cbe4f509` | Gateway/backend sözleşmesi | Yok (zararsız, fayda da yok) | Dolaylı | Backend 4.7'yi de deploy et | **Evet** |
| **R-P2-2** | P2 | Üretim drain cursor'ı **offset tabanlı** (P0-1 gateway yarısı yok). Loop açılırsa front-trim kaymayla kayıt atlar | `memory_persistence.py` (cbe4f509) offset dalı | Backend persistence | Loop açılırsa sessiz atlama | Dolaylı | **Loop'u 4.7 olmadan AÇMA** | **Evet** |
| **R-P3-1** | P3 | RAM sohbet başına 2000 cap → `bulk` ucu toplamı eksik gösterir (9168 vs 9464) | 2 sohbet tam 2000; DB'de 2206/2090 | Gateway RAM | UI etkilenmez (DB'den okur); `bulk`'u envanter sanan her araç yanılır | Ölçüm doğruluğu | `bulk` yanıtına `truncated`/cap işareti ekle | Hayır (kod değişikliği) |
| **R-P3-2** | P3 | Gateway `/health`'te `capacity` alanı yok → eviction görünürlüğü sıfır | Canlı `/health` çıktısı | Gateway gözlemlenebilirlik | Yok | Kapasite planlaması | `20c88bb` deploy edilince gelir | Evet (deploy) |

**P0 bulgu yok.** Hiçbir bulgu, mevcut ölçümlerle "recreation mesaj kaybettirir" iddiasını desteklemiyor.

---

## 9. Çalıştırılmayan Kontroller

| Kontrol | Neden |
| --- | --- |
| Persistence loop'u çalıştırıp drain'i izlemek | **WRITE REQUIRED** — env değişikliği + restart gerekir |
| Gerçek gateway recreation denemesi | **WRITE REQUIRED** — container recreate + RAM kaybı; bu aşamada yasak |
| `restoreSessions` sonrası backfill ölçümü | Recreation olmadan gözlemlenemez |
| Backend 4.7 testleri (`pagination_contract`, `message_insert_isolation`) | Deploy edilen kodda bu dosyalar yok |
| Gateway seq davranışının üretimde doğrulanması | Üretim gateway'inde `_seq` yok |
| `pg_dump` / restore provası | Yazma (dosya) + PITR yok; bu aşamanın kapsamı dışı |

---

## 10. Açık Koşullar (READY WITH CONDITIONS gerekçesi)

1. **Recreation'dan hemen önce RAM_ONLY yeniden ölçülmeli.** Bu bir *zaman-noktası* özelliğidir:
   bugün 0, ama loop kapalı olduğu için yarın 0 kalacağının yapısal garantisi yok. Kapı:
   `RAM_ONLY = 0` **ve** `event_outbox` PENDING/IN_FLIGHT = 0.
2. **Persistence loop, backend 4.7 deploy edilmeden AÇILMAMALI.** Deployed cursor offset tabanlıdır;
   loop'u açmak P0-1'in sessiz atlama riskini geri getirir (R-P2-2).
3. **Gateway `20c88bb` tek başına deploy edilebilir** (backend dosyaları değişmiyor, `afterSeq`
   gönderilmediği için davranış aynı; `/health`'e yalnızca `capacity` eklenir). Fayda, backend 4.7
   gelene kadar **ertelenir** (R-P2-1).
4. **Backend 4.7 deploy edilmeden** geçmiş backfill'in zehirli satır yüzünden eksik kalma riski
   kabul edilmeli (R-P1-2). Kabul edilmiyorsa sıra: backend 4.7 → doğrulama → gateway.
5. Deploy sırası (A6): **backend kalıcılık doğrula → `messages` / `/health.whatsapp_memory_persistence`
   → gateway**. Gateway RAM store'u yeniden kurulur.

---

## 11. Nihai Karar

### ⚠️ READY WITH CONDITIONS

**Gerekçe:** Gateway recreation için **kritik veri kaybı kanıtı yok**:
RAM_ONLY = 0, RAM ⊆ DB, sohbet kümeleri birebir (100=100), DB_ONLY 296 tamamen cap taşmasıyla
açıklanıyor, outbox 1187/1187 DELIVERED ve 0 retry, canlı insert yolu savepoint'li ve kazananı adopt
ediyor, UI geçmişi DB'den okuyor. Bu, "healthy" demekten çok daha güçlü bir kanıt kümesi.

**Ama READY değil**, çünkü:
- **P1-1:** persistence loop kapalı → telafi mekanizması yok; güvence ölçüm anına bağlı.
- **P1-2:** toplu geçmiş insert'i savepoint'siz → backfill sessizce eksik kalabilir.

**NOT READY de değil:** hiçbir ölçüm mesaj kaybı, duplicate veya geri kazanılamayan veri göstermiyor.

**BLOCKED de değil:** gerekli tüm üretim verilerine salt-okunur erişildi.

**Duruldu.** Backend fix/commit/deploy yapılmadı, gateway deploy edilmedi, persistence loop açılmadı,
production DB veya RAM'e yazılmadı. Gateway deploy için ayrıca **açık onay** gerekiyor.

> Hijyen notu: analiz sırasında üretim host'unun `/tmp` dizinine yalnızca id listeleri yazıldı
> (`/tmp/tz420_*`); oturum sonunda **silindi**. Hiçbir sistem kaydı değiştirilmedi.
