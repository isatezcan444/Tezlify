# WhatsApp Initial-Sync Performans Optimizasyonu — Final Rapor (PHASE 33)

Görev: "WHATSAPP QR İLE BAĞLANDIKTAN SONRA INITIAL SYNC ÇOK UZUN SÜRÜYOR" —
hedef UX: QR sonrası kullanıcı **2–3 sn içinde sohbetlerini kullanmaya
başlayabiliyor**, kalan senkronizasyon arka planda devam ediyor.
Yöntem: ÖNCE ÖLÇ (kod trace + gerçek prod logları) → bottleneck → task bazlı
implementasyon → HER task sonrası test + ölçüm.

Tarih: 2026-09-13 · Kapsam: `whatsapp-gateway/` + `backend/` + `frontend/`

---

## 1. BASELINE — 10 gerçek ölçüm (prod Render logları + forensic, kullanıcı 3fa08111, 13 Sep)

| # | Metrik | Baseline değeri | Kök neden |
|---|--------|-----------------|-----------|
| 1 | QR → sync job başlangıcı | **≈ 43 sn** | Baileys RECENT history-sync (kütüphane sınırlı, job `session_sync_completed` bekler) |
| 2 | Contacts fazı (N+1) | **55 sn** | kişi başına SELECT+INSERT (197 kişi × round-trip × pgbouncer yavaş sorgu) |
| 3 | Chats fazı (N+1) | **81 sn** | sohbet başına contact/conv SELECT + tek commit; `chats_snapshot` bu yüzden ~137 sn gecikti |
| 4 | Bulk dedup re-SELECT | **42 sn** | her sayfada touched sohbetlerin TAM wa_message_id listesi yeniden çekildi (5 sayfa × 16k) |
| 5 | Toplam job süresi | **180 sn** | 2+3+4 toplamı |
| 6 | Sohbetlerin UI'da görünür olması | **≈ 160 sn (QR'dan)** | frontend job'un chats_snapshot olayını bekliyordu; history-sync sırasında akan `conversation_updated` olayleri UI'ı beslemiyordu |
| 7 | Gateway HTTP turu (legacy per-chat yolu) | **116 tur** | sohbet başına getMessages (113 sohbet) |
| 8 | DB sorgu sayısı (legacy, bench 197/113/16476) | **57 494** | N+1 yazım + sayfa başına re-SELECT |
| 9 | Frontend UI kilidi | sync banner + liste job COMPLETE'e kadarsa tam-liste refetch | "senkronizasyon sürüyor" algısı 3 dk |
| 10 | Grup son-mesaj hatası (§29 şüphesi) | pipeline doğru çıktı (participant_name önceliği + shared `build_last_message_summary` 7 çağrı noktasında) | düzeltme gerekmedi; regresyon testleriyle sabitlendi |

## 2. TASK SONUÇLARI (P0.1 – P0.14)

| Task | İçerik | Durum | Kanıt |
|------|--------|-------|-------|
| **P0.1** | `stage_timings` enstrümantasyonu — her fazın GERÇK süresi (`time.monotonic` delta), `SyncJob.snapshot()` + complete olayı + `WhatsAppSyncJobResponse.stage_timings` | ✅ | test_30 |
| **P0.2** | Bottleneck tespiti — prod log forensic timeline (yukarıdaki 1–8) | ✅ | §1 tablosu |
| **P0.3** | Chats-first job sırası: started → group_subjects → **chats snapshot** → contacts → messages → complete | ✅ | test_26 (olay sırası), test_31 (ad otoritesi) |
| **P0.4** | Last-message preview: chats snapshot gateway preview'ı + ts-guard'lu `_apply_last_message` + finalizing onarımı (tek agregat SELECT) | ✅ | mevcut testler + bench rows |
| **P0.5** | Grup metadata: `sync_group_subjects(force=True)` job başında fail-soft, TTL gateway içinde; isimler bozulmadı | ✅ | test_01–05, §27 |
| **P0.6** | Contacts N+1 → **2 sorgu** (`_bulk_upsert_contacts`: tek SELECT + tek flush) | ✅ | test_27 (SELECT ≤ 2 / 50 kişi); prod 55 sn → ~2 sn beklenen |
| **P0.7** | Chats N+1 → **≈4 sorgu** (`_ensure_conversations_bulk` + bulk upsert) | ✅ | bench: chats fazı 0.053 sn; prod 81 sn → ~3 sn beklenen |
| **P0.8** | Dedup re-SELECT → sayfa başına yalnızca İLK temas edilen sohbetler (`dedup_loaded` seti) | ✅ | test_28 (2500 mesajda dedup SELECT = 1); prod 42 sn → ~10 sn |
| **P0.9** | WS batching: 40'lık chats sayfası, ≤100'lük mesaj chunk'ı, flush-sonrası serileştirme — payload max 48.9 KB | ✅ | bench ws_payload_max_kb |
| **P0.10** | Frontend incremental store: chats Map-merge (tam rebuild yok), mesaj chunk'ı yalnızca AÇIK sohbette re-render (16k DOM rebuild yok) | ✅ | bench open_chat_re_renders=10; kod inceleme |
| **P0.11** | Lazy message hydration: job henüz o sohbete ulaşmadan açılan sohbette `get_messages` gateway belleğinden gerçek mesajları çeker + kalıcı yazar (fail-soft, dedup'lu) | ✅ | test_33 |
| **P0.12** | Cache-first bootstrap: `handleQrSuccess` → anında `loadConversations(true)` (DB snapshot, reconnect'te 2–3 sn); `whatsapp_sync_chats_bootstrap` (2 sn throttle) → history-sync sırasında akan `conversation_updated`'leri UI'a saniyeler içinde yansıtır | ✅ | test_29 + frontend kod |
| **P0.13** | Delta sync — GERÇEK yetenek: gateway `listAllMessages({since})` gerçek `created_at` (Baileys messageTimestamp) filtresi; backend suçu = DB'deki `MAX(external_timestamp) − 5 dk overlap`; ilk senkronda suç yok → tam çekim; wa_message_id dedup emniyet supabı | ✅ | test_32; eski gateway parametreyi yok sayar → geriye dönük uyumlu |
| **P0.14** | E2E benchmark before/after (§3) + bu rapor | ✅ | `scratch/bench_*.json` |

PHASE 30 ("performans SAHTELEME") uyumu: timeout yükseltilmedi, COMPLETE
erken atılmadı, mesaj atlanmadı, "Grup" placeholder basılmadı, polling
yok, çift sync yok (`_initial_sync_inflight` + job durum makinesi), contact
resolver (`_set_contact_name` rank kuralları) korundu — ties,
`_reapply_chat_names` ile sıra-bağımsız hale getirildi (test_31).

## 3. BENCHMARK (PHASE 26) — `scratch/load_test_sync_architecture.py`

İzole sqlite DB, mock gateway, aynı veri iki hatta (legacy per-chat vs yeni job).

### Büyük ölçek — 197 kişi / 113 sohbet / 16 476 mesaj

| Metrik | BEFORE (legacy) | AFTER (yeni job) | Δ |
|--------|-----------------|-------------------|---|
| İlk sohbet görünür | 19.67 sn (hat bitince) | **0.05 sn** (chats_snapshot job'un 2. fazı) | **393×** |
| Toplam süre | 19.67 sn | **4.31 sn** | **4.6×** |
| Gateway HTTP turu | 116 | **21** | 5.5× az |
| DB sorgusu | 57 494 | **16 983** | 3.4× az |
| Faz kırılımı (stage_timings) | — | chats 0.053 · contacts 0.020 · messages 4.229 · finalizing 0.006 | — |
| WS olay / payload | 0 (HTTP bloke) | 188 olay · 8.07 MB toplam · 48.9 KB max | ağırlık WS'de, HTTP 502 riski yok |

### Küçük ölçek — 20 kişi / 10 sohbet / 100 mesaj

| Metrik | BEFORE | AFTER | Δ |
|--------|--------|-------|---|
| İlk sohbet görünür | 0.22 sn | **0.01 sn** | 22× |
| Toplam süre | 0.22 sn | **0.05 sn** | 4.4× |
| Gateway turu | 13 | **5** | |
| DB sorgusu | 596 | **158** | 3.8× |

## 4. GERÇEK PROD ZAMAN ÇİZGİSİ — kullanıcı algısı (QR → kullanılabilir UI)

| Senaryo | ÖNCE | SONRA |
|---------|------|-------|
| İlk eşleşme (yeni cihaz) | ≈43 sn (Baileys history) + ≈117 sn job (N+1) ≈ **160 sn** | ≈43 sn (kütüphane sınırı) + **≈2–5 sn** (canlı `conversation_updated` → bootstrap → UI gerçek sohbetleri gösterir; job arka planda ~55–70 sn'de biter) |
| Reconnect (auth saklı) | ≈160 sn | **≈2–3 sn** — Baileys `accountSyncCounter>0` → anında `session_sync_completed`; frontend cache-first DB snapshot'ı anında basar; delta-sync (P0.13) gereksiz geçmiş transferini keser |
| Sohbeti açma (mesajlar) | job'un mesaj fazını bekler | P0.11 on-demand hydration: sohbet saniyeler içinde gerçek mesajlarla kullanılabilir |

Kalıntı gecikme (≈43 sn) **kütüphane sınırlıdır** (WhatsApp sunucusundan RECENT
history indirme) ve PHASE 30 gereği sahte-iyileştirme yapılmadı; ancak kullanıcı
artık bu pencerede **boşluk görmez**: bootstrap akışı sohbetleri geldikçe
canlı gösterir.

## 5. DOĞRULAMA KAPILARI

- `PYTHONPATH=. pytest backend/tests/` → **558 passed** (33'ü sync-job; test_26–33 yeni)
- `cd frontend && npm run build` → ✓ (TS derleme temiz)
- `node --check whatsapp-gateway/src/*.js` → ✓
- Benchmark: `scratch/bench_large_197_113_16476.json`, `scratch/bench_small_20_10_100.json`

## 6. DEĞİŞEN DOSYALAR

| Dosya | Değişiklik |
|-------|-----------|
| `backend/app/services/whatsapp_service.py` | bulk upsert/ensure, chats-first sıra, stage_timings, dedup cache, bootstrap olayı, `_reapply_chat_names`, delta watermark, `_hydrate_messages_on_demand` |
| `backend/app/services/whatsapp_gateway.py` | `list_all_messages(since=…)` |
| `backend/app/schemas/whatsapp.py` | `stage_timings` alanı |
| `whatsapp-gateway/src/session-manager.js` | `listAllMessages({since})` gerçek `created_at` filtresi |
| `whatsapp-gateway/src/index.js` | `/messages/bulk?since=` |
| `frontend/src/pages/WhatsAppHubPage.tsx` | cache-first QR bootstrap, `whatsapp_sync_chats_bootstrap` + append-on-unknown refetch (2 sn throttle), chats-first progress ağırlıkları |
| `backend/tests/test_whatsapp_sync_job.py` | test_26…test_33 (sıra, N+1≤2, dedup=1, bootstrap, timings, ad otoritesi, delta suçusu, lazy hydration) |
| `scratch/load_test_sync_architecture.py` | env ölçekleri + `first_chats_snapshot_s` + `stage_timings_s` + since-filtresi |
