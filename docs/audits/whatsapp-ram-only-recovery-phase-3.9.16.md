# AŞAMA 3.9.16 — RAM-ONLY MESAJLARIN GÜVENLİ KURTARILMASI VE OFF-SITE YEDEKLENMESİ

**Tarih:** 2026-10-30 (09:46 – 09:56 UTC)
**Çalışma türü:** ALTYAPI + KODLAMA + TEST + OPERASYON
**Öncelik:** KRİTİK — VERİ KAYBINI ÖNLEME
**Production commit (deploy edilmiş):** `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` — **değişmedi**
**Önceki aşama:** 3.9.15 — PARTIAL (24 PASS / 1 PARTIAL / 1 BLOCKED / 2 NOT RUN)

---

## GENEL SONUÇ: **PASS (yedekleme + restore) — persistence KAPALI, escrow hâlâ BLOCKED**

| Alan | Durum |
|---|---|
| Canlı RAM'in eksiksiz, tutarlı snapshot'ı | **PASS** (9154/9154, shortfall 0) |
| Şifreleme + manifest + izinler | **PASS** |
| Yerel izole restore | **PASS** (9154/9154, identity root eşleşti) |
| Off-site upload (2 nesne) | **PASS** |
| Off-site yeniden indirme + SHA-256 | **PASS** (2/2) |
| Off-site kopyadan izole restore | **PASS** (yerel ile birebir) |
| Veri bütünlüğü (dup/NULL/orphan) | **PASS** (0/0/0) |
| LID istisnası | **PARTIAL** — 1 kayıt eşlenemiyor, kanıt yok, tahmin edilmedi |
| Persistence aktivasyonu | **BLOCKED** — bilerek yapılmadı |
| Kill-switch boşluğu | **PASS (yama hazır)** — ayrı dalda, deploy edilmedi |
| Escrow fiziksel kopya | **BLOCKED** — operatör eylemi bekliyor (3.9.12'den devir) |
| Üretim güvenliği | **PASS** (0 restart, 0 deploy, 0 DB yazımı) |

**Bu aşama 6.959 RAM-only mesajın güvenli, şifreli, off-site ve geri yüklenebilir bir kopyasının bulunduğunu kanıtlar.** Persistence hâlâ kapalıdır ve ayrı onay ister.

---

## 1. BAŞLANGIÇ DURUMU (ölçüldü, 09:46–09:47 UTC)

| Öğe | Değer |
|---|---|
| Git | `main` · `416462f` · çalışma ağacı **temiz** · `origin/main` ile 0/0 |
| Deploy edilmiş commit | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| Production checkout HEAD | `5cd3eae4f4b1edc57c940a4d9e56ef0257199948` |
| Backend | `ce2e901b6619` · `2026-10-29T21:47:56.536962458Z` · restarts **0** |
| Gateway | `5b867095d376` · `2026-10-27T17:25:57.8181699Z` · restarts **0** |
| PostgreSQL | `f6d79c4a1f8b` · `2026-10-01T17:45:08.260956885Z` · restarts **0** |
| Caddy | `ee66a5cab371` · `2026-10-12T13:12:45.795953636Z` · restarts **0** |
| Oturum | **201** · `CONNECTED` · gateway `1bd78836-c084-4cbf-b333-9386d44b7bd7` |
| **Gateway RAM toplamı** | **9154** |
| Ayrık `wa_message_id` | **9154** (kopya yok) |
| Ayrık sohbet | **100** |
| DB conversations / messages / contacts | **126 / 2195 / 1538** |
| Karantina defteri | **0** |
| RAM ∩ DB | **2195** → **DB ⊆ RAM** |
| DB'de olmayan RAM mesajı (RAM-only) | **6959** |
| DB'de olup RAM'de olmayan | **0** |
| Persistence | `config_enabled=false` · `runs=0` |

> **Canlı trafik notu:** 3.9.15'te DB 2194, RAM-only 6960 ölçülmüştü. Aradaki fark **1 mesajdır** ve canlı trafikten kaynaklanır (DB 2194→2195). Eşitlik bozulmadı: **6959 + 2195 = 9154**. Bu bir hata değil, ölçüm anı farkıdır; eşitliği zorlamak için hiçbir şey yapılmadı.

**Sayfalama (offset / kayıt / toplam):**

| Sayfa | offset | kayıt | toplam |
|---|---:|---:|---:|
| 1 | 0 | 2000 | 9154 |
| 2 | 2000 | 2000 | 9154 |
| 3 | 4000 | 2000 | 9154 |
| 4 | 6000 | 2000 | 9154 |
| 5 | 8000 | 1154 | 9154 |

**Sohbet boyutu dağılımı:** 1–9: 60 sohbet · 10–99: 28 · 100–499: 7 · 500–999: 2 · 1000–1999: 1 · **2000: 2**

---

## 2. YENİ ŞİFRELİ SNAPSHOT

| Öğe | Değer |
|---|---|
| Snapshot | **`tezlify-ram-20261030T094753Z.rsnap`** |
| Boyut | **7.181.099 B** |
| SHA-256 | **`d5a1e6d6792700716765917af1051803950b140d2a49f229b3ebd63760496c34`** |
| Manifest | `tezlify-ram-20261030T094753Z.manifest.json` · **16.957 B** |
| Manifest SHA-256 | **`e0dcce325f18ab6489eb71ec6a516718dc8b659494945a3a50e5459337678b42`** |
| İzinler | **`600`** (ikisi de) |
| Şifreleme | AES-256-GCM, mevcut `encrypted-codec` şeması (`RSNAP1` magic + 12 B nonce + AAD) |
| Toplama penceresi | `2026-10-30T09:47:54Z` → `2026-10-30T09:47:59Z` (**5 sn**) |
| Kaynak container | `ce2e901b6619` (backend) |
| Anahtar | `.key-escrow-v2`'den **yalnızca ortam değişkeniyle** verildi; argv'ye, dosyaya, loga yazılmadı |

**Manifest içeriği (anahtar/secret YOK):**

| Alan | Değer |
|---|---|
| `schema` / `kind` | `1` / `tezlify.ram_snapshot` |
| `record_count` | **9154** |
| `chat_count` | **100** |
| `records_sha256` | `4cac0edaba4cbae7f7c48666a927092a79f016bf3693d28ade9528282fcb4332` |
| `identity_root_sha256` | `7297476ee25594cc72a1384db63fa1b2537b11ac6f460e5efa4d4c7b992591be` |
| `duplicates_removed` | **0** |
| `late_arrival_count` | **0** |
| `unstable_chats` | **[]** |
| `rejected_missing_identity` / `rejected_incomplete` | **0 / 0** |
| `chats` satırı | **100** (`jid_hash`, `reported_total`, `collected`, `rounds`, `shortfall`, `stable`) |
| `stable=false` sohbet | **0** |
| `shortfall > 0` sohbet | **0** |
| `collected` toplamı = `reported_total` toplamı | **9154 = 9154** |
| Kullanılan maksimum tur | **1** |

→ **Tutarlılık kanıtı:** her sohbet için `collected == reported_total`, tek turda oturdu, hiçbir sohbette kısa düşme yok, `late_arrival=0`. Canlı trafik pencere boyunca devam etmesine rağmen eksik veriyle "başarılı" denmedi.

**Doğrulama (yeniden okuma):** `ok: true` · `problems: []` · `integrity_problems: []` · `completeness_problems: []` · `duplicate_identity: 0` · `checked.record_count: 9154` · `checked.chat_count: 100`

**Eski 9139 kayıtlı snapshot'tan farkı (kimlik kümesi karşılaştırması):**

| Ölçüm | Değer |
|---|---|
| Eski (`20261029T220302Z`) | 9139 kayıt · bitti `2026-10-29T22:03:08Z` |
| Yeni (`20261030T094753Z`) | **9154** kayıt · bitti `2026-10-30T09:47:59Z` |
| Ortak kimlik | **9119** |
| **Yeni eklenen** | **35** — hepsi eski snapshot bitişinden **sonra** (`04:56:52Z` … `09:43:22Z`) |
| **Yeni snapshot'ta OLMAYAN (RAM'den düşen)** | **20** — hepsi **eski** tarihli (`2026-10-13` … `2026-10-24`) |

Aritmetik tutuyor: `9139 − 20 = 9119`, `9119 + 35 = 9154`. Yani yeni snapshot **35 yeni mesajı kapsıyor** ve eski snapshot'ın 20 kaydını artık içermiyor — çünkü onlar gateway RAM'inden düşmüş (Bölüm 5).

**Sohbet türü dağılımı (snapshot içi, çözülmüş payload):** `s.whatsapp.net` **5687** · `g.us` **3457** · `lid` **9** · `broadcast` **1** = **9154** · ayrık sohbet **100** · ayrık `wa_message_id` **9154**

---

## 3. YEREL İZOLE RESTORE

`:memory:` hedefi, üretim DB'sine bağlanmadan:

| Metrik | Değer |
|---|---|
| `inserted` | **9154** |
| `skipped_duplicate` | **0** |
| `restored_rows` / `expected_rows` | **9154 / 9154** |
| `source_identity_count` / `restored_identity_count` | **9154 / 9154** |
| `distinct_conversations` | **100** |
| `identity_set_equal` | **true** |
| `restored_identity_root_sha256` | `7297476e…91be` |
| Manifest `identity_root_sha256` | **aynı** |
| `identity_root_matches` | **true** |
| `identity_conserved` | **true** |

Üretim DB'sine **0** yazım; `:memory:` hiçbir dosya oluşturmaz.

---

## 4. OFF-SITE YEDEKLEME

| Adım | Sonuç |
|---|---|
| Bucket metadata | `NoPublicAccess` · versioning **`Enabled`** · `Standard` · tenancy kökü · `HEAD 200` |
| Object key (snapshot) | `tezlify/whatsapp/ram-snapshots/**2026/10/30**/tezlify-ram-20261030T094753Z.rsnap` |
| Object key (manifest) | `tezlify/whatsapp/ram-snapshots/**2026/10/30**/tezlify-ram-20261030T094753Z.manifest.json` |
| Dry-run | 2 nesne · 7.198.056 B · **0 ağ yazımı** · escrow **BLOCKED** |
| Upload (manifest) | **HTTP 200** · 0.09 sn · 16.957 B · `opc-meta-sha256` = `e0dcce32…` ✅ |
| Upload (snapshot) | **HTTP 200** · 0.21 sn · 7.181.099 B · `opc-meta-sha256` = `d5a1e6d6…` ✅ |
| Üzerine yazma | **0** (`If-None-Match: *` korundu; yeni tarih klasörü ⇒ çakışma yok) |
| TLS doğrulaması | **açık** (kapatılamaz) |
| Escrow bucket'ta | **HAYIR** — kod seviyesinde bloklandı |
| Yeni IAM/bucket/Vault/policy | **0** |
| Onay kapısı | `TEZLIFY_OFFSITE_APPROVED=1` + `--execute` (çift anahtar) |

**Yeniden indirme doğrulaması (`--download-check`):**

| Nesne | İndirilen B | Yerel B | SHA-256 | Durum |
|---|---:|---:|---|---|
| `…094753Z.manifest.json` | 16.957 | 16.957 | `e0dcce32…` = yerel | **VERIFIED** |
| `…094753Z.rsnap` | 7.181.099 | 7.181.099 | `d5a1e6d6…` = yerel | **VERIFIED** |

`all_verified = true` · `size_match = true` (ikisi) · ETag SHA-256 yerine kullanılmadı.

**Bucket son durumu:** **10 nesne · 35.730.151 B · `escrow_izi = YOK`** (8 eski + 2 yeni).

---

## 5. 2.000 MESAJ SINIRI — ACİL RİSK (kaynak koddan + ölçümden)

### Kaynak koddaki kural (değiştirilmedi)

| Yer | Kural |
|---|---|
| `socket-events.js:820` (`chats.update` sentetik yol) | `if (next.length > 2000) next.splice(0, next.length - 2000)` |
| `socket-events.js:972` (`messaging-history.set` yolu) | `list.sort((a,b) => a.id - b.id)` **sonra** `if (list.length > 2000) list.splice(0, list.length - 2000)` |
| `message-store.js:19` `MESSAGES_BY_CHAT_MAX_CHATS = 300` | 300'den fazla **sohbet** olursa en eski sohbet **tamamen** atılır (LRU, `currentKey` korunur) |
| `message-store.js:18` `RAW_MESSAGE_STORE_MAX = 10000` | Ayrı ham-proto önbelleği (medya yeniden yükleme); mesaj listesi değil |

**Kesin cevap:** Yeni bir mesaj geldiğinde, o sohbet 2000'de ise **listenin başındaki tek kayıt** atılır. Liste `id`'ye göre artan sırada tutulduğu için bu, **en düşük yerel `id`** — yani **en erken yazılmış** kayıttır. Bu, "en eski mesaj" ile **her zaman aynı değildir**: `id` yerel bir sayaçtır, WhatsApp zaman damgası değildir. Sonradan geriye dönük doldurulan eski tarihli mesajlar daha yüksek `id` alır ve **en son** atılır.

**Global ve sohbet-başına limit ayrımı:**

| Limit | Değer | Kapsam | Bugün aktif mi |
|---|---|---|---|
| Sohbet başına mesaj | **2000** | tek sohbet | **EVET** — 2 sohbet tam sınırda |
| Toplam sohbet | **300** | tüm hat | Hayır (100 sohbet) |
| Ham proto önbelleği | 10000 | medya | Ayrı sayaç |

### Ölçülen kayıp — bu aşamanın en önemli bulgusu

İki snapshot arasındaki 11 saat 45 dakikada:

| Ölçüm | Değer |
|---|---|
| RAM'den düşen mesaj | **20** |
| Bunlardan DB'de bulunan | **0** |
| **Yalnızca eski snapshot'ta kalan** | **20** |
| Kayıp hızı | ~**1.7 mesaj/saat** (~41/gün) |

→ **Bu 20 mesaj artık gateway RAM'inde ve DB'de yok.** Tek kopyaları `tezlify-ram-20261029T220302Z.rsnap` içinde. Bu, snapshot zincirinin neden zorunlu olduğunun somut kanıtıdır — ve aynı zamanda **canlı, devam eden bir veri kaybıdır**.

**Sınırdaki iki sohbetin riski:**

| Sohbet | RAM | DB'de var | **DB'de yok** | En eski | En yeni |
|---|---:|---:|---:|---|---|
| Grup (conv `38291`) | 2000 | 489 | **1511** | 2026-10-13 | 2026-10-30T08:38 |
| Kişi (`@s.whatsapp.net`) | 2000 | 937 | **1063** | 2026-10-24 | 2026-10-30T09:43 |

→ Bu iki sohbette **2574** mesaj DB'de değil ve her yeni mesaj birini kalıcı olarak siliyor.

**Güvenli azaltma (mevcut gateway'e dokunmadan):** eviction yeni mesaj başına **1 kayıt** düşürdüğü için, snapshot sıklığı doğrudan kayıp üst sınırını belirler: `T` dakikada bir snapshot ⇒ sohbet başına en fazla `T` dakikada gelen mesaj sayısı kadar kayıp. Bugünkü hızla **saatlik snapshot ≈ 2 mesaj/saatlik kayıp**, günlük snapshot ≈ 41. Timer ayrı onay ister (bu aşamada **kurulmadı**). Kalıcı çözüm persistence'tır (ayrı onay).

---

## 6. LID İSTİSNASI — düzeltme ve analiz

**Önceki raporun düzeltmesi:** 3.9.15'te "20 karakterlik alan-adsız LID anahtarı" denmişti. **Yanlıştı.** Kayıt `@broadcast` adreslidir:

| Alan | Değer |
|---|---|
| Sohbet anahtarı türü | **`@broadcast`** (10 haneli sayısal yerel kısım) |
| Kayıt sayısı | **1** |
| `wa_message_id` | **var** |
| Yön / tür / durum | `INBOUND` / `TEXT` / `RECEIVED` |
| `created_at` | `2026-10-29T18:15:56.000Z` |
| `lid_mappings` satırı | **0** |
| `contacts` satırı | **0** |
| `whatsapp_identity_quarantine` satırı | **0** |
| Bu anahtarla DB mesajı | **0** |

**Karar:** Durum/`@broadcast` adresi bir kişi değildir; `contacts`/`conversations` kaydı yoktur ve **kanıtlanmış bir eşleme de yoktur**. Bu yüzden:
- **tahmini eşleştirme yapılmadı**,
- DB'ye yazılmadı (persistence bu kaydı `skipped_unmapped` olarak atlar),
- karantina defterine **yazılmadı** — defter `contact_id NOT NULL` ister; bunun için sahte bir kişi yaratmak **veri uydurmak** olurdu,
- **ama snapshot'ta aynen korunuyor** (payload'da `broadcast` domain'i altında 1 kayıt).

→ Kayıp yok; yalnızca kalıcılaştırılamıyor. Tek kopyası snapshot.

**Ayrıca 9 `@lid` mesajı** da snapshot'ta aynen duruyor (kanıtlı köprü olmadığı için persistence bunları da atlar). Yani "9 LID mesajı kurtarılamadı" ifadesi **DB için** doğru, **yedek için** yanlıştır: hepsi yedekte.

**Manifest alanı hakkında dürüst not:** `unmapped_conversation_count` **her zaman 0**'dır — `ram_snapshot.py:624` bu alanı sabit boş liste ile doldurur (`"unmapped_conversations": []`). Yani bu alan bir **ölçüm değildir**; kanıt olarak kullanılamaz. Gerçek eşlenemeyen sayısı yukarıdaki ayrı ölçümden gelir (**1**).

---

## 7. PERSISTENCE GÜVENLİK İNCELEMESİ — AKTİVASYON YOK

### Ölçülen tasarım garantileri (kod)

| Garanti | Kanıt |
|---|---|
| Idempotent | `INSERT … ON CONFLICT (conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING` + `RETURNING` |
| Duplicate koruması | `_prefetch_existing_ids` + `_wa_id_of` (boş/NULL kimlik yazılmaz) |
| Kısmi yazım yok | sayfa başına **tek** INSERT → commit; hata → `rollback` + tur durur |
| Rollback | `await db.rollback()`; sonraki tur aynı offset'ten yeniden dener |
| Tenant izolasyonu | `get_user_filter` + `Conversation.session_id` filtresi |
| LID güvenliği | yalnızca `whatsapp_private.lid_mappings` (bu oturum için kayıtlı köprü); tahmin yok |
| Sıralama/preview bozulmaz | eski satırlar `apply_conversation_last_message` çağrılmadan yazılır (A4/A11) |
| Sayfalama + kuyruk | `next_offset` imleci; tur tavanı < toplam olduğunda kuyruk erişilebilir |
| PII sızmaz | `_safe_error` yalnızca istisna türü + SQLSTATE |
| Kill-switch | `run_memory_persistence_once` içinde |

### Bulunan boşluk ve yama (ayrı dalda, **deploy edilmedi**)

**Boşluk:** `drain_gateway_memory_once` kill-switch'i denetlemiyordu. Doğrudan çağrıldığında (diagnostik betik, CLI, gelecekteki bir job) **kapalı** bir özellik yazabiliyordu — yani güvenlik kapısı çağıranın hangi fonksiyonu seçtiğine bağlıydı.

**Yama:** `backend/app/services/whatsapp/memory_persistence.py` içinde `drain_gateway_memory_once` başına kapi:

```
if not dry_run and not settings.WHATSAPP_MEMORY_PERSIST_ENABLED:
    stats["error"] = "PERSIST_DISABLED"; stats["blocked_by_killswitch"] = True; return stats
```

`dry_run=True` **bilerek serbest**: ölçüm turu hiçbir satır yazmaz ve "kaç satır yazılırdı" cevabı kapalıyken de alınabilmelidir. Kapı, gateway'e **hiç gitmeden** kapanır.

| Öğe | Değer |
|---|---|
| Dal | **`fix/persist-killswitch-drain-3.9.16`** |
| Commit | **`313380f`** |
| Değişen dosyalar | `memory_persistence.py` (+19), `test_memory_persist_killswitch_drain.py` (+247) |
| Yeni testler | **5** (kapalı+açık yazma reddi, kapalı+dry_run serbest, açık+açık yazma, iki kez çağrı, boş kimlik) |
| İlgili testler | **213 passed** |
| Tam suite (dalda) | **2085 passed, 4 skipped, 0 failed** |
| `main`'e merge | **HAYIR** |
| Push | **HAYIR** |
| Deploy | **HAYIR** |

### 6.959 mesaj için hazırlık (yazma yok)

| Öğe | Değer |
|---|---|
| Dry-run `inserted` (yazılacak) | **6959** |
| `conversations` | 40 |
| `skipped_unmapped` | **1** (`@broadcast`) |
| `skipped_no_id` | **0** |
| `next_offset` | **0** (tam tur) |
| Rollback planı | Tur başına commit + hata → `rollback`; tekrar çalıştırma idempotent (`ON CONFLICT DO NOTHING`) |
| Tek eşlenemeyen kayıt | Ayrı tutuldu; tahmini eşleme **yapılmayacak**; snapshot'ta korunuyor |

**Persistence durumu (bitiş):** `config_enabled = false` · `runs = 0` · `inserted_total = 0`. **KAPALI.**

---

## 8. OFF-SITE KOPYADAN İKİNCİ İZOLE RESTORE

| Adım | Sonuç |
|---|---|
| `download` (sha doğrulamalı) | 7.181.099 B · indirilen sha `d5a1e6d6…` = yerel ✅ |
| Geçici dosya | `/tmp` · `600` |
| `:memory:` restore | `inserted` **9154** · `restored_rows` **9154** · `expected_rows` **9154** |
| `source_identity` / `restored_identity` | 9154 / 9154 |
| `distinct_conversations` | **100** |
| `identity_set_equal` | **true** |
| `identity_root_matches` | **true** (`7297476e…91be`) |
| `identity_conserved` | **true** |
| **Yerel restore ile fark** | **YOK** — birebir aynı |
| Temizlik | `shred -u` → dosya **yok** (doğrulandı) |
| Geçici araç dizini | `/tmp/dr` oluşturuldu, iş sonunda **silindi** |

---

## 9. ÜRETİM DEĞİŞİKLİKLERİ — 0

| İşlem | Sayı |
|---|---:|
| Gateway restart / recreate | **0** |
| Backend / DB / Caddy restart | **0** |
| WhatsApp logout / reconnect / QR | **0** |
| Production deploy | **0** |
| DB `INSERT`/`UPDATE`/`DELETE` (bu aşamadan) | **0** |
| Persistence aktivasyonu | **0** |
| Mesaj silme / bellek budama | **0** |
| LID tahmini eşleştirme | **0** |
| Mevcut 4 snapshot değişikliği | **0** |
| Escrow değişikliği | **0** |
| `.env.production` değişikliği | **0** |
| Yeni OCI kaynağı / IAM / Vault | **0** |
| Gateway'e test mesajı | **0** |
| Timer / cron | **0** |

**Başlangıç / bitiş:**

| Metrik | Başlangıç | Bitiş | Fark |
|---|---:|---:|---:|
| Container ID + `StartedAt` (4 adet) | — | **birebir aynı** | 0 |
| Restart sayacı | 0 | **0** | 0 |
| Oturum 201 | `CONNECTED` | **`CONNECTED`** | 0 |
| conversations / contacts | 126 / 1538 | **126 / 1538** | 0 |
| messages | 2195 | **2195** | 0 |
| Karantina | 0 | **0** | 0 |
| **RAM toplamı** | **9154** | **9154** | **0** |
| Persistence | kapalı, `runs=0` | **kapalı, `runs=0`** | 0 |
| Yerel snapshot sayısı | 8 dosya | **10 dosya** (2 yeni) | +2 |
| Eski 8 dosya SHA-256 | — | **değişmedi** | 0 |

> DB'deki **+1** mesaj (2194→2195) bu aşamanın yazımı değil, **canlı WhatsApp trafiğidir** (normal ingest). Aşama boyunca hiçbir yazma yolu tetiklenmedi.

**Kapanış yeniden ölçümü (commit öncesi, 10:00–10:05Z, salt-okunur):**

| Kontrol | Değer | Yorum |
|---|---|---|
| Container ID + `StartedAt` (4/4) | **birebir aynı** (gateway `5b867095d376` 2026-10-27T17:25:57Z) | yeniden başlatma yok |
| Restart sayacı (4/4) | **0** | — |
| Oturum (gateway `1bd78836-…`) | `total 1 / connected 1 / pending_qr 0` | WhatsApp oturumu sağlam |
| contacts / conversations / messages | **1538 / 126 / 2196** | messages 2195→2196: yine canlı trafik |
| Karantina | **0** | defter hâlâ boş |
| **RAM toplamı** (`/messages/bulk?limit=1`) | **9154** | snapshot anındaki sayı ile aynı |
| Persistence kill-switch | **`WHATSAPP_MEMORY_PERSIST_ENABLED` tanımsız** | yalnızca `true`/`1` açar ⇒ **kapalı** |

> Eşitlik yine tutuyor: **6959 + 2196 = 9155**, RAM 9154 ⇒ RAM-only **6958**. Fark yine **canlı trafiktir**, kayıp değil. Bu ölçüm bir kez daha gösteriyor ki RAM-only sayısı zamanla **düşer**; tek korunaklı kopya snapshot zinciridir.

---

## 10. AÇIK RİSKLER

| Risk | Önem | Durum |
|---|---|---|
| **2 sohbette 2574 mesaj DB'de değil ve her yeni mesaj birini siliyor** | **KRİTİK** | Devam ediyor; persistence kapalı |
| **Son 11s45dk'da 20 mesaj yalnızca eski snapshot'ta kaldı** | **KRİTİK** | Snapshot zinciri tek koruma |
| **Escrow hâlâ snapshot'larla aynı diskte** | **KRİTİK** | BLOCKED (3.9.12'den devir) |
| Persistence kapalı | **KRİTİK** | Ayrı onay gerekir |
| Timer yok → yedek elle alınıyor | Yüksek | Ayrı onay |
| Off-site kopya tek sağlayıcıda | Orta | Tenancy kaybı riski |
| 1 `@broadcast` + 9 `@lid` kaydı kalıcılaştırılamıyor | Orta | Snapshot'ta korunuyor |
| Karantina defteri **boş** ama 1 eşlenmemiş `@lid` kişi var | Orta | Defter yazımı hiç çalışmamış olabilir |
| `unmapped_conversation_count` manifest alanı sabit 0 | Düşük | Ölü alan; kanıt sayılmamalı |
| `MESSAGES_BY_CHAT_MAX_CHATS = 300` | Düşük | Bugün 100 sohbet; 300'ü aşarsa **tüm sohbet** düşer |
| Medya baytları yedeklenmiyor | Yüksek | Snapshot yalnızca metadata |
| Kill-switch yaması deploy edilmedi | Orta | Ayrı onay + deploy |

---

## 11. KABUL KRİTERLERİ

| Kontrol | Beklenen | Durum |
|---|---|---|
| Gateway session | CONNECTED ve değişmemiş | **PASS** |
| Gateway restart | 0 | **PASS** |
| Production DB yazımı | 0 | **PASS** |
| RAM verisi | Kaynakta korunmuş | **PASS** (9154 → 9154) |
| Snapshot kapsamı | Tutarlı ve eksiksiz | **PASS** (shortfall 0, `stable=false` 0) |
| Snapshot SHA | Doğrulanmış | **PASS** |
| Manifest | Doğrulanmış | **PASS** |
| Yerel restore | PASS | **PASS** (9154/9154) |
| Off-site upload | Onay varsa PASS | **PASS** (2/2 HTTP 200) |
| Off-site download | PASS | **PASS** (2/2 VERIFIED) |
| Off-site restore | PASS | **PASS** (yerel ile birebir) |
| Identity set | Eşleşmiş | **PASS** |
| Identity root | Eşleşmiş | **PASS** |
| Duplicate | 0 | **PASS** |
| Orphan | 0 | **PASS** |
| LID eşleştirmesi | Kanıtlı veya açıkça istisna | **PARTIAL** (1 `@broadcast` + 9 `@lid`, kanıt yok, tahmin yok) |
| Persistence | KAPALI | **PASS** (kapalı) |
| Production deploy | 0 | **PASS** |

**Özet: 17 PASS · 1 PARTIAL · 0 FAIL.** Persistence aktivasyonu ve escrow fiziksel kopya bu tablonun dışında, **ayrı onay** bekleyen işlerdir.

---

## 12. TESTLER — `main` üzerinde tekrar üretildi

### Bu aşamanın kendi testleri

| Koşum | Sonuç |
|---|---|
| `backend/tests/test_escrow_physical.py` + `test_ram_snapshot.py` | **74 passed** |
| Dal `fix/persist-killswitch-drain-3.9.16` (yamayla birlikte) | **2085 passed, 4 skipped, 0 failed** |

### `main` tam suite — 2.080 passed

```
TEST_DB_PATH=/tmp/tezlify_prov_3916.db \
DATABASE_URL="sqlite+aiosqlite:////tmp/tezlify_prov_3916.db" \
PYTHONPATH=. venv/bin/python scripts/provision_test_db.py     # ← ÖNCE bu
...
venv/bin/python -m pytest backend/tests -q
→ 2080 passed, 4 skipped, 0 failed (158.05 s)
```

3.9.15'teki `2080 passed / 4 skipped / 0 failed` sonucu **birebir** yakalandı. `main` üzerindeki kod ağacı `7de31e0` ile aynıdır (`git diff 7de31e0..HEAD -- backend/app whatsapp-gateway` **boş**).

### Ölçülen tuzak — provizyon adımı atlanırsa suite yalancı kırmızı verir

Bu aşamada tam suite dört kez koşuldu ve **ilk üçü kırmızı** geldi. Sebep kod değil, test DB'sinin nasıl hazırlandığıydı:

| # | Test DB | Sonuç | Gerçek sebep |
|---|---|---|---|
| 1 | boş dosya, `pytest-of-root` zaten var | 9 failed / 1788 passed / **283 error** | sandbox `tmp_path` `EEXIST` — `rm -rf` sessizce engellendi |
| 2 | boş dosya, `-p no:randomly` | 126 failed / 1929 passed / 25 error | tablolar testlerin kendi DDL'inden geliyor, sıra şemayı belirliyor |
| 3 | boş dosya, taze TMPDIR | 49 failed / 1881 passed / 150 error | `history_sync_states` 10 kolonlu yaratıldı |
| 4 | **`provision_test_db.py`** | **0 failed / 2080 passed** | doğru prosedür |

**Kök neden:** `history_sync_states` ORM'de yok; `provision_test_db.py` çalışmazsa tabloyu testlerin içindeki `CREATE TABLE IF NOT EXISTS` blokları kurar. Bu bloklar **farklı kolon kümeleri** tanımlıyor (biri 10, `test_whatsapp_forensic_phase2.py` 21 kolon) ve `IF NOT EXISTS` yüzünden **ilk yazan kazanıyor**. Sonra `error_count` isteyen testler `no such column` ile düşüyor. Provizyon betiği tabloyu startup ile aynı **21 kolonlu** hâliyle önceden kurunca bütün `IF NOT EXISTS` blokları no-op oluyor ve suite yeşile dönüyor.

> **Kural:** bu repoda tam suite'i yorumlamadan önce `scripts/provision_test_db.py` çalıştırılmalıdır. Aksi hâlde üretimle ilgisi olmayan 6–126 arası "hata" görünür ve bunlar gerçek regresyon gibi okunur. Bu bir ürün kusuru değil, test izolasyonu kusurudur ve **bu aşamada düzeltilmedi** (kod değişikliği kapsam dışı).

---

## 13. SONUÇ VE SONRAKİ AŞAMA

Bu aşamanın hedefi olan **"6.959 RAM-only mesajın güvenli yedeği ve geri yüklenebilirliği"** kanıtlandı:

- Canlı RAM'in tamamı (9154) tek pencerede, kısa düşme olmadan, tek turda toplandı.
- Şifreli, `600` izinli, manifesti içeriksiz ve doğrulanmış.
- Yerel `:memory:` restore ve **off-site kopyadan** restore **birebir aynı** sonucu verdi.
- Off-site'ta 10 nesne / 35.730.151 B; escrow bucket'ta yok.

**Üç iş birbirinden ayrıdır ve yalnızca birincisi tamamlandı:**

| # | İş | Durum |
|---|---|---|
| **1** | RAM-only mesajların yedeklenmesi ve restore edilmesi | **TAMAMLANDI (bu aşama)** |
| **2** | Fiziksel escrow + bağımsız anahtarla restore kabul testi | **BLOCKED** — operatör kâğıt kopyası bekliyor (3.9.12 runbook) |
| **3** | Persistence aktivasyonu ve kalıcılaştırma | **YAPILMADI** — yama hazır (`313380f`), ayrı onay gerekir |

**3.9.x felaket kurtarma süreci tamamlanmış sayılmaz:** (2) ve (3) açık. Ayrıca Bölüm 5'teki kayıp **canlı olarak devam ediyor** — her saat ~1.7 mesaj yalnızca snapshot'ta kalıyor.

**Acil öneri (onay gerektirir, bu aşamada yapılmadı):**
1. Saatlik snapshot timer'ı (kayıp üst sınırını ~2 mesaj/saate indirir).
2. Escrow fiziksel kopyası → (2) kabul testi.
3. Persistence aktivasyonu → 6959 mesaj kalıcılaşır, 2000 sınırı etkisizleşir.

---

*Secret, token, private key, encryption key veya credential değerleri bu rapora yazılmadı; yalnızca SHA-256 özetleri ve 8 haneli genel doğrulama çapası yer alır. Mesaj içerikleri ve ham JID'ler rapora yazılmadı (yalnızca tür/uzunluk/sayı). Gerçekleştirilmeyen işlemler başarılı gösterilmedi; persistence aktive edilmedi, escrow PASS sayılmadı.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*
