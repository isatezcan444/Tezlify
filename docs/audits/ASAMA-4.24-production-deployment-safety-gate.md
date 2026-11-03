# Aşama 4.24 — Backend 4.7 + Gateway 4.17 Üretim Deployment Safety Gate

**Tarih:** 2026-10-31 21:25–22:10 UTC (ölçüm anı: **2026-10-31T21:30:06Z**)
**Mod:** SALT-OKUNUR. Üretimde hiçbir değişiklik yapılmadı: deploy YOK, restart/rebuild YOK, DB yazma YOK, RAM müdahalesi YOK, persistence loop açma YOK, feature flag değişikliği YOK, push YOK.
**Sonuç:** ⚠️ **READY WITH CONDITIONS**

> **Tek cümle:** İki release de tek başına güvenli ve geriye dönük uyumlu; ancak **P0-1'i düzelten tek bir ref yok** — `2236cae` ile `20c88bb`, `cbe4f509`'un kardeş çocukları ve hiçbiri diğerini içermiyor. P0-1'in tamamlanması için **birleşik bir release ref'i kesilmelidir**. Verdict'in koşulu budur.

---

## 0. Özet

| Soru | Cevap |
| --- | --- |
| Üretim hâlâ `cbe4f509` mı? | **Evet** — `.deployed-commit` = `cbe4f509…`, çalışan dosyalar byte-byte `cbe4f509` blob'ları |
| Backend 4.7 tek başına deploy edilebilir mi? | **Evet** — `--no-gateway` muhafızı geçiyor, P0-2 aktifleşir, P0-1 **aktifleşmez** (offset fallback), regresyon yok |
| Gateway 4.17 tek başına deploy edilebilir mi? | **Evet ama faydasız** — eski backend `afterSeq` göndermediği için seq dalı hiç çalışmaz; RAM deposu sıfırlanır (A6) |
| P0-1 için ikisi birlikte gerekli mi? | **Evet** — ve **şu an ikisini birden içeren bir ref yok** |
| Veri kaybı riski var mı? | **Hayır** — RAM ⊆ DB (`RAM_ONLY = 0`), outbox'ta bekleyen olay yok, startup migration silme koşulları **0 satır** eşliyor |
| Gateway recreate oturumu düşürür mü? | **Hayır** — `creds.json` adlandırılmış volume'da (`tezlify_whatsapp_sessions`) |
| Persistence loop açık mı? | **Hayır** — `config_enabled: false`, `runs: 0`, `task_running: false`; 4.7 bu varsayılanı **değiştirmiyor** (`config.py` blob'u aynı) |

---

## 1. Taze üretim baseline (4.20'ye körü körüne güvenilmedi)

4.20 raporundaki 9168 / 9464 sayıları **kanıt olarak kullanılmadı**; aşağıdaki her satır bu oturumda yeniden ölçüldü.

### 1.1 Kimlik ve süreç durumu

| # | Öğe | Ölçülen | Yöntem |
| --- | --- | --- | --- |
| 1 | `.deployed-commit` | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` | `cat /opt/tezlify/.deployed-commit` |
| 2 | Host repo HEAD | `5cd3eae4f4b1edc57c940a4d9e56ef0257199948` (`main`) | `git log -1` |
| 3 | HEAD ↔ deployed ilişkisi | `cbe4f509` **ancestor**; fark yalnız `.gitignore` +1 satır | `git merge-base --is-ancestor`, `git diff --stat` |
| 4 | Backend imajı | `sha256:06ce4fe12874d9e694e03e2f53e74f6d95fef5e3339b4dfde7c8554ec9ddb21a` | `docker inspect` |
| 5 | Gateway imajı | `sha256:a1ba2572c40926fd3d71289b6e7eb20116915efc9024c7487631f24324eaa1cc` | `docker inspect` |
| 6 | Backend uptime | **Up 2 days (healthy)**, created `2026-10-29 21:47:51Z` | `docker ps` |
| 7 | Gateway uptime | **Up 4 days (healthy)**, created `2026-10-27 17:25:42Z` | `docker ps` |
| 8 | Caddy / DB | Up 2 weeks / Up 4 weeks, ikisi de healthy | `docker ps` |
| 9 | Gateway oturumu | `1bd78836-c084-4cbf-b333-9386d44b7bd7`, `connected: 1`, `pending_qr: 0`, `orphaned: 0`, `auto_restore: true` | `/health` (container içi) |
| 10 | Backend köprüsü | `connected: true`, `reconnect_count: 1`, `last_connected_at 2026-10-29T21:48:01Z` | `/health` |

**Ölçüm notu (metodoloji):** Ne backend ne gateway host'a port publish etmiyor (`8000/tcp`, `8787/tcp` yalnız container ağında). `curl 127.0.0.1:8000` **boş döner** — bu "servis ölü" demek değildir. Sağlık ölçümleri container **içinden** yapıldı: backend `python -c urllib`, gateway `node -e fetch`. İlk denemede `3000` portu ve host'tan `curl` kullanıldı ve ikisi de yanlış negatif verdi; portlar `docker ps --format {{.Ports}}` ile doğrulanıp düzeltildi.

### 1.2 Çalışan kod = `cbe4f509` mi? (byte-byte)

Container içindeki dosyaların SHA-256'sı, `git show <ref>:<path> | shasum -a 256` ile karşılaştırıldı.

| Dosya | Çalışan container | `cbe4f509` | `2236cae` | `20c88bb` |
| --- | --- | --- | --- | --- |
| `backend/app/services/whatsapp/memory_persistence.py` | `6a1e5860…` | `6a1e5860…` ✅ | `070fda03…` | `6a1e5860…` |
| `backend/app/services/whatsapp/orchestration/sync.py` | `026cb479…` | `026cb479…` ✅ | `edb7e9d2…` | `026cb479…` |
| `backend/app/core/config.py` | `9f847dba…` | `9f847dba…` ✅ | `9f847dba…` **(aynı)** | `9f847dba…` |
| `backend/app/services/whatsapp_gateway.py` | `5bd6ed48…` | `5bd6ed48…` ✅ | `2e78ab7d…` | `5bd6ed48…` |
| `backend/app/main.py` | `1eb78ae6…` | `1eb78ae6…` ✅ | `afdacc40…` | `1eb78ae6…` |
| `whatsapp-gateway/src/index.js` | `4f2e435e…` | `4f2e435e…` ✅ | `4f2e435e…` | `641b1062…` |
| `whatsapp-gateway/src/session-manager.js` | `c42355ec…` | `c42355ec…` ✅ | `c42355ec…` | `0818cc85…` |

**Sonuç:** çalışan ağaç, `cbe4f509`'un bu 7 dosyada **birebir** aynısıdır. Ayrıca tablo iki release'in **dokunmadığı alanları** kanıtlar: backend release'i gateway'e, gateway release'i backend'e hiç dokunmuyor.

### 1.3 Release ref'leri (yerel = uzak)

| Ref | Yerel | Uzak (`git ls-remote origin`) |
| --- | --- | --- |
| `release/backend-only-4.7` | `2236caeb…` | `2236caeb…` ✅ |
| `release/gateway-seq-pagination-4.17` | `20c88bb9…` | `20c88bb9…` ✅ |

Diğer 5 release ref'i (`3.7`, `3.8.1`, `3.8.4`, `3.8.5`, `3.8.7`) değişmemiş.

---

## 2. Backend 4.7 denetimi (`2236caebd4281b108b835f16f4c80d3d2e2f1d05`)

### 2.1 Kapsam

```
M backend/app/main.py                                     +2
M backend/app/services/whatsapp/memory_persistence.py     +241/−? 
M backend/app/services/whatsapp/orchestration/sync.py     +144
M backend/app/services/whatsapp_gateway.py                +11
M backend/tests/test_whatsapp_memory_persistence.py
M backend/tests/test_whatsapp_memory_persistence_hardening.py
A backend/tests/test_whatsapp_message_insert_isolation.py  +253
A backend/tests/test_whatsapp_pagination_contract.py      +545
A scripts/pg_audit_tests/{test_tz44_missing.py,test_tz46_audit.py,tz44_pgplugin.py}  +893
11 files, +2038 / −61
```

`backend/Dockerfile` yalnız `backend/` + `start.py` kopyalıyor ⇒ `scripts/pg_audit_tests/` **imaja girmez**. `host-release.sh` içinde `pytest` yok ⇒ bu 3 dosya release kapısında da çalışmaz.

### 2.2 P0-1 (epoch-aware keyset pagination) — gerçek içerik

`memory_persistence.py` çağrı yeri:

```python
page = await gw.list_all_messages(
    gateway_id, limit=int(page_size), offset=offset,
    per_chat_limit=int(per_chat_limit),
    after_seq=after_seq if mode == "seq" else None,
    seq_epoch=epoch if mode == "seq" else None,
)
```

Mod çözümlemesi — **imleç asla sıfırlanmıyor**, sadece mod düşüyor:

```python
reported_mode = str(page.get("pagination") or "")
if reported_mode == "seq":
    mode = "seq"; epoch = page.get("seq_epoch") or epoch
    if page.get("epoch_reset"): stats["epoch_reset"] = True; _STATE["epoch_resets_total"] += 1
else:
    if mode == "seq":
        mode = "offset"; offset = int(start_offset or 0)
```

Stall koruması: `next_after <= after_seq` ⇒ `PaginationStalled`, tur kırılır (`stalled_pages_total`).
İmleç kalıcılığı: `{"mode","after_seq","offset","epoch"}`; eski düz-int imleç hâlâ okunuyor (geriye dönük uyum).

**Kritik:** P0-1 **iki yarımdan** oluşur. Backend yarısı `afterSeq` göndermek, gateway yarısı onu **değer** olarak yorumlamak. Gateway 4.17 deploy edilmezse `page.pagination` anahtarı hiç gelmez ⇒ `mode="offset"` ⇒ düzeltme **aktifleşmez, regresyon da olmaz**.

### 2.3 P0-2 (poison-row savepoint izolasyonu) — gerçek içerik

`sync.py`: bulk INSERT `begin_nested()` içinde; `IntegrityError` durumunda `_insert_messages_one_by_one` her satır için ayrı SAVEPOINT açar ve `on_conflict_do_nothing(index_elements=["conversation_id","wa_message_id"], index_where=text("wa_message_id IS NOT NULL"))` kullanır. `dead_letter{count, constraint}` raporlanır.

**Şema doğrulaması (bu oturumda üretimde ölçüldü):**

```
uq_msg_conv_wa_message_id | CREATE UNIQUE INDEX ... ON public.messages USING btree
                            (conversation_id, wa_message_id) WHERE (wa_message_id IS NOT NULL)
```

`ON CONFLICT` hedefi **mevcut**. Migration gerekmiyor; migration dosyası da değişmiyor.

### 2.4 Diğer başlıklar

| Başlık | Bulgu |
| --- | --- |
| API sözleşmesi | Hiçbir router/şema dosyası değişmiyor. `main.py` farkı yalnız `/metrics/check` yanıtına `whatsapp_memory_persistence` alanı **ekliyor** (okuma amaçlı). UI sözleşmesi değişmiyor. |
| Flag varsayılanı | `config.py` blob'u `cbe4f509` ile **aynı** (`9f847dba…`). `main.py:421` `if getattr(settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", False)` satırı **birebir aynı** ⇒ deploy sonrası loop yine KAPALI. |
| Migration | `backend/app/core/migrations.py` **değişmiyor**. Startup migration seti bugün çalışan container'ın 2026-10-29'da çalıştırdığı setin aynısı. |
| Startup/shutdown | `create_task` / `startup` / `shutdown` eklenmiyor (diff taraması: 0 eşleşme). |
| Async yaşam döngüsü | Yeni task yok; mevcut tur içinde sayfalama değişiyor. `AsyncSessionLocal` kullanımı mevcut desenle aynı; loop kapalı olduğu için **yeni bağlantı açılmıyor**. |
| Pool etkisi | `database.py` pool ayarları değişmiyor (`pool_size`/`max_overflow` config'ten). Ek eşzamanlı oturum yok. |
| Geri alma uyumluluğu | Şema değişikliği yok ⇒ rollback **kod-only**. 4.7'nin yazdığı satırlar 3.8.7 satırlarından ayırt edilemez; geri dönüşte veri migrasyonu gerekmez. |
| Yıkıcı DML | Runtime dosyalarında `DELETE FROM` / `DROP` / `ALTER`: **0**. Diff'te görünen 3 `DELETE FROM`, yalnız `scripts/pg_audit_tests/` içinde (imaja girmez). |

### 2.5 Startup migration silme koşulları — üretimde kaç satır eşliyor?

`migrations.py` (değişmiyor) içindeki üç veri-bağımlı silme yolu ve üretimdeki karşılığı:

| Migration | Koşul | Üretimde eşleşen |
| --- | --- | --- |
| `purge_degenerate_phone_contacts` | `phone_e164 ~ '^\+0+$'` | **0** |
| `purge_synthetic_preview_messages` | `wa_message_id LIKE 'preview%'` + `preview_<digits>_<digits>` | **0** |
| conversation dedupe | aynı `contact_id`+`channel` için >1 sohbet | **0** (null contact: 0) |

**Sonuç:** bugünkü veriyle bu üç yol da **no-op**. Üstelik deploy betiği bunu körü körüne varsaymıyor: `host-release.sh` **adacık (izole) container**'ı aynı migration setiyle klon DB üzerinde çalıştırıp `message_watermark.py` ile "eşik altında kaç eski mesaj duruyor" kontrolünü yapıyor (`id<=eşik` sayımı; toplam sayım yeni gelen mesajları gizlediği için kullanılmıyor). Yani deploy'un kendisi bir kanıt üretiyor.

---

## 3. Gateway 4.17 denetimi (`20c88bb9fd1f4dabb73e0d2538dbbe219d9816e6`)

```
M whatsapp-gateway/package.json                     +1/−1   (yalnız `test` zincirine 2 dosya eklendi)
A whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs            +216
A whatsapp-gateway/scripts/test-bulk-seq-pagination-guarantees.mjs +537
M whatsapp-gateway/src/index.js                     +13/−?
M whatsapp-gateway/src/messages/message-store.js    +278
M whatsapp-gateway/src/session-manager.js           +177
M whatsapp-gateway/src/socket/socket-events.js      +10/−?
7 files, +1210 / −23
```

### 3.1 Sözleşme

```js
const seqMode = afterSeq !== null && afterSeq !== undefined && afterSeq !== ''
  && Number.isFinite(Number(afterSeq));
...
if (!seqMode && perChat !== null && group.length > perChat) {
  group = [...group].sort((a,b) => (a.id||0)-(b.id||0)).slice(-perChat);   // offset modunda AYNEN
}
...
const epochReset = Boolean(seqEpoch) && String(seqEpoch) !== String(epoch);
const after = epochReset ? 0 : Math.max(0, Number(afterSeq) || 0);
for (const m of all) { const seq = messageSeqOf(m); if (seq !== null && seq > after) eligible.push(m); }
eligible.sort((a,b) => (messageSeqOf(a)||0) - (messageSeqOf(b)||0));
return { messages: page, total: all.length, offset: 0, limit, pagination: 'seq',
         seq_epoch: epoch, max_seq, after_seq: after, next_after_seq: nextAfter,
         reached_end: page.length < limit, epoch_reset: epochReset, eligible_total };
```

| Özellik | Durum |
| --- | --- |
| Katı `seq > after` | ✅ (eşitlik dışlanır — çift teslim yok) |
| Sıralama | ✅ `_seq` artan; offset modunda eski `id` sıralaması korunuyor |
| `_seq` atama | ✅ Ekleme anında (`stampMessageSeq`), `enumerable: false`; iki ingestion yolunda da (`socket-events.js` history-sync + canlı mesaj) |
| Damgasız kayıt | ✅ Okuma anında `ensureMessageSeq` → en yüksek sırayı alır, imlecin **gerisinde kalmaz** |
| Epoch reset | ✅ `seqEpoch` uyuşmazsa `after=0` → güvenli yeniden tarama, `epoch_reset: true` |
| Offset fallback | ✅ `afterSeq` yoksa **eski kod yolu birebir** (eski istemciler aynı sayfayı alır) |
| `perChatLimit` kırpması | ✅ Seq modunda **uygulanmıyor** (kırpma imleçten önce uygulanırsa sessiz atlama geri gelirdi); offset modunda aynen |
| Metadata | ✅ `pagination/seq_epoch/max_seq/after_seq/next_after_seq/reached_end/epoch_reset/eligible_total` |
| 2000 tavanı | ⚠️ **DEĞİŞMİYOR** — `MESSAGES_PER_CHAT_MAX = 2000` sabiti korunuyor; eklenen şey *görünürlük* (`recordEviction`, `/health.capacity`, `evictions_total`, `evictionsByReason`) |
| RAM deposu | ⚠️ Recreate'te **sıfırlanır** (A6) — 4.17 bunu değiştirmiyor |
| Yaşam döngüsü / reconnect | ✅ Değişmiyor; oturum `creds.json` üzerinden geri yükleniyor |
| Tek başına deploy | **Etkisiz** — eski backend `afterSeq` göndermiyor, seq dalı hiç çalışmaz; tek görünür fark `/health.capacity` |

### 3.2 Eski backend + yeni gateway (C senaryosu) neden güvenli?

Eski backend yanıttan yalnız iki anahtar okuyor:

```python
msgs  = page.get("messages", [])
total = int(page.get("total") or 0)
```

`pagination`, `seq_epoch`, `max_seq` gibi **fazladan anahtarlar zararsız**. Eski backend `afterSeq` göndermediği için `seqMode=false` ⇒ `perChatLimit` kırpması aynen uygulanır ⇒ **bugünküyle aynı sayfa**.

### 3.3 Yeni backend + eski gateway (B senaryosu) neden güvenli?

Deploy edilen handler:

```
index.js:564   const { limit, offset, since, perChatLimit, jids } = req.query;
```

`afterSeq`/`seqEpoch` **destructure edilmiyor ⇒ sessizce yok sayılıyor**. Yanıtta `pagination` anahtarı yok ⇒ backend `mode="offset"`'e düşer, imleci **sıfırlamaz**. Davranış bugünküyle aynı; P0-1 düzelmez.

---

## 4. A/B/C/D uyumluluk matrisi

| # | Backend | Gateway | Sayfalama | P0-1 | P0-2 | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | `cbe4f509` (mevcut) | `cbe4f509` (mevcut) | offset + `perChatLimit` | ❌ | ❌ | Bugünkü durum. Bilinen sessiz atlama riski sürer. |
| **B** | `2236cae` | `cbe4f509` | offset fallback (imleç sıfırlanmaz) | ❌ | ✅ | Güvenli, regresyon yok. Tek başına backend deploy'un sonucu. |
| **C** | `cbe4f509` | `20c88bb` | offset (seq dalı hiç çağrılmaz) | ❌ | ❌ | Güvenli ama **etkisiz**; maliyeti: gateway recreate + RAM reset. |
| **D** | `2236cae` | `20c88bb` | **seq (keyset)** | ✅ | ✅ | Hedef. **Bunu üreten bir ref yok.** |

### 4.1 Neden "tek ref yok" — kanıt

```
git merge-base 2236cae 20c88bb            → cbe4f509f4bcc5babb12cc85e0ad422cb13ba739
2236cae ancestor of 20c88bb               → NO
20c88bb ancestor of 2236cae               → NO
2236cae in main                           → NO
20c88bb in main                           → NO
git for-each-ref --contains 2236cae       → yalnız release/backend-only-4.7 (+origin)
git for-each-ref --contains 20c88bb       → yalnız release/gateway-seq-pagination-4.17 (+origin)
```

İki ref `cbe4f509`'un **kardeş** çocukları. `host-release.sh` hedef ref'in **ağacından** build ettiği için:
- `20c88bb`'den deploy → gateway 4.17 + backend **`cbe4f509`** (eski)
- `2236cae`'den deploy → backend 4.7 + gateway **`cbe4f509`** (eski)

### 4.2 Birleşik ref neden risksiz

| Ölçüm | Sonuç |
| --- | --- |
| Backend release dosya sayısı | 11 |
| Gateway release dosya sayısı | 7 |
| **Kesişim** | **0** |
| Ortak ata | `cbe4f509` |

Dosya kümeleri **ayrık** ⇒ birleştirme çakışmasız. Ayrıca deploy betikleri üç ref'te de byte-aynı:

| Betik | `cbe4f509` | `2236cae` | `20c88bb` |
| --- | --- | --- | --- |
| `scripts/deploy/host-release.sh` | `f2b7a9ae…` | `f2b7a9ae…` | `f2b7a9ae…` |
| `scripts/deploy/run_release.sh` | `9284245f…` | `9284245f…` | `9284245f…` |

⇒ Birleşik ref için script sürüm muhafızı (exit 9) ek bir iş çıkarmaz.

---

## 5. Veri güvenliği — bağımsız yeniden ölçüm

### 5.1 Yöntem

1. **Gateway RAM:** container içinden `GET /sessions/1bd78836…/messages/bulk?limit=200000&offset=0`, `Authorization: Bearer $WHATSAPP_GATEWAY_SECRET`. **Tek sayfa** (offset kayması yok). Kimlik anahtarı **`wa_message_id`** — mesaj `id`'si ms-timestamp'tir ve sohbetler arasında çakışır (4.20'de bu yüzden 215 sahte duplike çıkmıştı).
2. **DB:** `select conversation_id, wa_message_id from messages where wa_message_id is not null`.
3. Kümeler yerelde karşılaştırıldı; farklar sohbet bazında kırıldı.

> Not: endpoint auth istiyor (`{"error":"unauthorized"}`). Token container env'inden okunup **hiçbir yere yazılmadı**.

### 5.2 Sonuç

| Ölçüm | Değer |
| --- | --- |
| RAM mesaj (tekil `wa_message_id`) | **9168** |
| RAM sohbet | **100** |
| RAM `null wa_message_id` | **0** |
| RAM içi duplike | **0** |
| RAM `max created_at` | `2026-10-31T20:37:51.289Z` |
| DB mesaj | **9464** |
| DB sohbet (mesajlı) | **100** |
| DB `null wa_message_id` | **0** |
| DB global duplike `wa_message_id` | **0** |
| **RAM_ONLY** | **0** ✅ |
| **DB_ONLY** | **296** |
| Kesişim | 9168 |
| RAM sohbeti DB'ye eşlenemeyen | **0 / 100** |
| Yetim mesaj (conversation yok) | **0** |
| `FAILED` mesaj / `error_code` dolu | **0 / 0** |
| Durum dağılımı | RECEIVED 5254 · DELIVERED 3133 · READ 1054 · SENT 23 |

**`RAM_ONLY = 0` ⇒ gateway bugün yeniden oluşturulsa RAM'de DB'de olmayan tek bir mesaj bile yok.**

### 5.3 `DB_ONLY = 296` gerçekten tavan taşması mı? (4.20'nin iddiası test edildi)

| Sohbet | DB | RAM | Fark |
| --- | --- | --- | --- |
| 38289 | 2206 | 2000 | **206** |
| 38291 | 2090 | 2000 | **90** |
| **Toplam** | | | **296** ✅ |

Aritmetik tutuyor. Ama aritmetik tek başına kanıt değil — **alternatif hipotez** (mesajlar RAM'e hiç girmemiş) de aynı toplamı verebilir. Ayırt etmek için `DB_ONLY` satırlarının **mesaj zamanı** aralığı ölçüldü:

| Sohbet | `DB_ONLY` mesaj ts aralığı | Sohbetin tamamının ts min'i | Yorum |
| --- | --- | --- | --- |
| 38289 | `2026-10-25 15:45:08` → `23:02:53` | `2026-10-25 15:45:08` | **En eski dilim** |
| 38291 | `2026-10-13 19:46:05` → `2026-10-14 06:20:52` | `2026-10-13 19:46:05` | **En eski dilim** |

**Sonuç:** `DB_ONLY`, her iki sohbette de **tam olarak sohbetin en eski N mesajı**. Bu, baş-eksiltme (head eviction) hipotezinin öngördüğü tek desen. Diğer sohbetlerde **hiç** `DB_ONLY` yok (296'nın tamamı bu iki sohbette) — "RAM'e hiç girmemiş mesaj" hipotezi olsaydı dağınık olurdu.

**Dikkat edilmesi gereken tuzak:** bu satırların `created_at` (DB insert zamanı) değeri `2026-10-30 20:58:49–51` aralığında **kümelenmiş**; 38291'de 90 satırın `created_at`'i **birebir aynı**. `created_at` `now()` varsayılanlı olduğu için bu, tek bir toplu INSERT'in imzasıdır (eski geçmişin backfill'i) — **mesaj zamanı değil**. Yalnız `created_at`'e bakan bir analiz "bunlar tavan taşması değil" diye yanlış sonuca varır. Doğru ölçü `coalesce(external_timestamp, sent_at, created_at)`.

### 5.4 Kapasite

| Öğe | Değer |
| --- | --- |
| Sohbet başına tavan | 2000 (`MESSAGES_PER_CHAT_MAX`) |
| Tavana **tam oturan** sohbet | **2** (`905413749073-1589570212@g.us`, `905442767554@s.whatsapp.net`) |
| Kuramsal kapasite (100 sohbet) | 200 000 |
| Kullanım | 9168 / 200 000 = **%4.6** |

Tavan **dolmuyor**; ama iki sohbet zaten sürekli tavanda ⇒ o sohbetlerde DB büyümeye devam eder, RAM etmez. Bu bir kayıp değil (DB üst küme), bir **görünürlük** sorunudur ve 4.17 tam bunu görünür kılıyor (`/health.capacity`).

---

## 6. Outbox ve processed_events

| Öğe | Değer |
| --- | --- |
| `event_outbox` toplam | **1135** |
| Durum dağılımı | **DELIVERED 1135** — PENDING 0, IN_FLIGHT 0, DEAD_LETTER 0 |
| `max(attempts)` | **1** |
| `created_at` aralığı | `2026-10-30 21:35:17Z` → `2026-10-31 20:59:50Z` |
| `processed_events` | **3754** |

**Neden 4.20'de 1187 idi, şimdi 1135?** Kod okundu — `postgres-event-outbox.js` `cleanup()`:
`DELIVERED` + `delivered_at < NOW() - 24h` silinir (batch 1000), `DEAD_LETTER` 48h, `processed_events` 3 gün. Ölçülen `min(created_at)` ≈ **24 saat önce** ⇒ döner pencere. Sayı azalması **beklenen** davranış, veri kaybı değil: yalnız **teslim edilmiş** satırlar silinir.

**Deploy açısından kritik:** `PENDING = 0` ve `IN_FLIGHT = 0` ⇒ gateway recreate anında **uçuşta olan olay yok**. Durable outbox boş, dolayısıyla restart olay kaybı üretemez.

---

## 7. Persistence loop değerlendirmesi (açmadan)

| Kontrol | Ölçüm |
| --- | --- |
| `config_enabled` | **false** |
| `task_running` | **false** |
| `runs` | **0** |
| `cursor_count` | **0** |
| `last_error` | **null** |
| 4.7 sonrası varsayılan | **değişmiyor** (`config.py` blob aynı; `main.py:421` aynı) |

**Değerlendirme:**
- Loop **kapalıyken** deploy etmek, P0-1'in faydasını **göstermez** (sayfalama hiç çalışmaz) ama riskini de **getirmez**.
- Loop açıldığında: 4.7+4.17 kombinasyonunda seq modu devreye girer; gateway recreate olursa `seqEpoch` değişir, backend `after=0` ile **güvenli yeniden tarama** yapar (atlamaz, tekrar tarar; dedup `uq_msg_conv_wa_message_id` + `on_conflict_do_nothing` ile).
- **Loop açma ayrı bir karardır** ve bu aşamada **yapılmadı**. Açmadan önce: `WHATSAPP_MEMORY_PERSIST_ENABLED=true` (yalnız `true`/`1` kabul edilir; `yes`/`on` **kapalı** sayılır ve `persistence_flag_guard.py` RED verir) + `/health.whatsapp_memory_persistence` üzerinden `runs`, `inserted_total`, `pages_total`, `stalled_pages_total`, `epoch_resets_total`, `dead_letter_total` izlenmeli.

---

## 8. Deploy sırası önerisi

### 8.1 Önerilen: **tek birleşik ref, tek pencere**

```
1) 2236cae + 20c88bb birleşik ref'i kes (dosya kümeleri ayrık ⇒ çakışma yok)
2) push (ayrı onay)
3) bash scripts/deploy/host-release.sh <birleşik-ref>     # tam release, --no-gateway YOK
```

**Neden:** tek kesinti penceresi, tek rollback noktası, P0-1+P0-2 **birlikte** aktif, gateway **bir kez** yeniden oluşur (RAM reset maliyeti bir kez ödenir), arada "yarım düzeltme" durumu oluşmaz.

### 8.2 Alternatif: iki adım (istenirse)

```
1) bash scripts/deploy/host-release.sh 2236cae --no-gateway    # backend 4.7, gateway'e dokunmaz
2) bash scripts/deploy/host-release.sh <birleşik-ref>          # gateway 4.17 + backend 4.7
```

`--no-gateway` muhafızı `2236cae` için **geçiyor** (bu oturumda doğrulandı):
`git diff --quiet cbe4f509 2236cae -- whatsapp-gateway/ docker-compose.yml` → **temiz**.
Maliyeti: backend iki kez yeniden başlar (ikinci kez aynı kodla), gateway bir kez.

### 8.3 İkisi birlikte olmak **zorunda mı?**

**Hayır.** Her iki yarı da tek başına güvenli ve geriye dönük uyumlu (matris: B ve C). Zorunlu olan tek şey şu: **P0-1'in düzelmesi için ikisi de aynı ağaçta olmalı**. Gateway'i tek başına deploy etmek fayda getirmez, maliyet getirir (RAM reset); backend'i tek başına deploy etmek P0-2'yi düzeltir, P0-1'i düzeltmez.

### 8.4 Deploy penceresi sağlık kontrolleri

| Adım | Kontrol | Başarı ölçütü |
| --- | --- | --- |
| Önce | Mesaj filigranı | `max(id)` + eşik altı adet kaydedildi |
| Önce | RAM/DB küme farkı | `RAM_ONLY = 0` (bugün 0) |
| Önce | Outbox | `PENDING = 0`, `IN_FLIGHT = 0` (bugün 0) |
| Sırasında | Adacık migration + watermark | `messages:<önce>-><sonra>` **boş** olmalı (kayıp varsa exit 4) |
| Sonra | `.deployed-commit` | hedef ref'in tam SHA'sı |
| Sonra | Container dosya hash'leri | `index.js` = `641b1062…`, `session-manager.js` = `0818cc85…`, `memory_persistence.py` = `070fda03…`, `sync.py` = `edb7e9d2…` |
| Sonra | Gateway `/health` | `status ok`, `sessions.connected = 1`, `orphaned = 0`, **`capacity` anahtarı VAR** (4.17 işareti) |
| Sonra | Backend `/health` | `status healthy`, `gateway_bridge.connected = true`, `whatsapp_memory_persistence.config_enabled = false` |
| Sonra | `/metrics/check` | `whatsapp_memory_persistence` anahtarı **VAR** (4.7 işareti) |
| Sonra | Mesaj sayımı | filigran eşiğinin altında **kayıp yok**; `null wa_message_id = 0`; yetim = 0 |
| Sonra | Gateway RAM | sohbet sayısı = DB mesajlı sohbet sayısı (100) |

### 8.5 Başarısızlık ölçütleri (deploy geri alınır)

- Watermark `exit 4` (eşik altı mesaj kaybı) — **derhal rollback**
- `sessions.connected = 0` veya `pending_qr > 0` (oturum düştü) — rollback + QR incelemesi
- Backend `gateway_bridge.connected = false` 5 dakikadan uzun
- `null wa_message_id` > 0 veya yetim mesaj > 0
- Gateway RAM sohbet sayısı 100'ün altına düştü ve 15 dakikada toparlanmadı

---

## 9. Rollback planı

| Adım | Komut / kontrol |
| --- | --- |
| 1 | `bash scripts/deploy/host-release.sh cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (tam release; gateway de geri döner) |
| 2 | Watermark karşılaştırması: rollback **kayıp üretmemeli** (şema değişmedi) |
| 3 | `/health` iki tarafta yeşil; `capacity` anahtarı **kaybolur** (4.17 geri alındı) |
| 4 | Gateway RAM yeniden dolar (reconnect + lazy hydration); `RAM_ONLY = 0` olduğu için **kayıp yok** |

**Rollback maliyeti / riskleri:**
- Gateway **ikinci kez** yeniden oluşur ⇒ RAM deposu ikinci kez sıfırlanır (A6). Bugün `RAM_ONLY = 0` olduğu için veri kaybı yok; yalnız UI'de geçmiş yeniden hidrasyonu görülür.
- Backend startup migration seti **tekrar** çalışır. Bu oturumda üç silme yolunun da **0 satır** eşlediği doğrulandı; yine de watermark kontrolü zorunlu.
- `.deployed-commit` rollback sonrası `cbe4f509`'a döner — **bu dosya tek otoritedir**.
- `release/backend-only-3.8.7` ve `release/gateway-seq-pagination-4.17` ref'leri **silinmemeli**; rollback ve ileri-alma bunlara bağlı.

---

## 10. Risk matrisi

| ID | Risk | Olasılık | Şiddet | Çözüm koşulu |
| --- | --- | --- | --- | --- |
| R1 | **P0-1 tek ref'te yok** — "deploy ettim, düzeldi" sanılır ama offset modunda kalınır | **Kesin** (yapısal) | Yüksek (sessiz atlama sürer) | Birleşik ref kesilmeden deploy **edilmemeli**; deploy sonrası `/health` + `pagination: 'seq'` kanıtı |
| R2 | Gateway recreate RAM deposunu sıfırlar | Kesin | Düşük (bugün `RAM_ONLY = 0`) | Deploy öncesi `RAM_ONLY = 0` doğrulanmalı; recreate'ten önce outbox `PENDING = 0` |
| R3 | Startup migration satır siler | Düşük (3 yol da 0 satır eşliyor) | Çok yüksek (geri dönüşü yok) | `message_watermark.py` exit 0 + adacık klon kontrolü; migration dosyası değişmiyor |
| R4 | Gateway oturumu düşer (QR gerekir) | Düşük (`creds.json` volume'da) | Yüksek (hat kesintisi) | `sessions.connected = 1` deploy sonrası ilk 60 sn; volume `tezlify_whatsapp_sessions` doğrulandı |
| R5 | `afterSeq` sessizce yok sayılır (eski gateway) | B'de kesin, D'de 0 | Orta | D'de `/health.capacity` + `pagination:'seq'` ile kanıtlanmalı |
| R6 | 2000 tavanı yüzünden DB büyür, RAM büyümez | Kesin (2 sohbet) | Düşük (DB üst küme) | 4.17 `/health.capacity` ile görünür; tavan **değiştirilmiyor** |
| R7 | `perChatLimit` seq modunda kırpmayı geri getirir | Yok (kod `!seqMode` koşullu) | Yüksek (olsaydı) | Test: `test-bulk-seq-pagination-guarantees.mjs` 32/32 |
| R8 | Epoch uyuşmazlığında imleç takılır | Düşük | Orta | `epoch_reset` → `after=0`; `stalled_pages_total` izlenir |
| R9 | Outbox temizliği "kayıp" sanılır | Orta (yanlış alarm) | Düşük | 24h döner pencere bilinmeli; yalnız DELIVERED silinir |
| R10 | Backend iki kez restart (iki adımlı plan) | Orta | Düşük | Tek birleşik ref ile tek pencere |

---

## 11. Verdict

### ⚠️ READY WITH CONDITIONS

**Gerekçe:**
1. Her iki release de **tek başına** güvenli, geriye dönük uyumlu ve regresyonsuz (matris B/C).
2. Üretim verisi **güvende**: `RAM_ONLY = 0`, `DB_ONLY = 296` (tam olarak tavan taşması, en eski dilim olduğu kanıtlandı), outbox'ta uçuşta olay yok, `null wa_message_id = 0`, yetim 0, duplike 0.
3. Startup migration silme yolları bugünkü veriyle **0 satır** eşliyor; migration dosyası değişmiyor; deploy betiği adacık klon + watermark ile bunu ayrıca kanıtlıyor.
4. Gateway oturumu adlandırılmış volume'da ⇒ recreate oturumu düşürmüyor.
5. Persistence loop kapalı ve 4.7 bunu **değiştirmiyor**.

**Koşullar (deploy onayından önce yerine gelmeli):**
- **C1:** `2236cae` + `20c88bb` birleşik bir release ref'i kesilmeli (P0-1 için zorunlu; şu an yok).
- **C2:** Deploy öncesi anlık `RAM_ONLY = 0` ve `outbox PENDING/IN_FLIGHT = 0` yeniden doğrulanmalı (değişken ölçümler).
- **C3:** Deploy sonrası `pagination: 'seq'` ve `/health.capacity` ile **D senaryosunun gerçekten aktif olduğu** kanıtlanmalı; sadece "deploy başarılı" yeterli değil.
- **C4:** Persistence loop **ayrı bir onayla** açılmalı; bu deploy'un parçası değil.

**Yasaklar (bu aşamada uygulandı):** deploy yok, restart/rebuild yok, DB yazma yok, RAM müdahalesi yok, loop açma yok, flag değişikliği yok, force/reset/clean/stash/amend/rebase yok, `git add -A` yok, PR yok.

---

## 12. Bu oturumda üretimde yapılan **tek** şey

Salt-okunur sorgular ve container içi `sha256sum` / `find` / `ls` / `du` / `cat Caddyfile`. Üretimde **hiçbir dosya yazılmadı**; tek yazma işlemi gateway container'ının **dışında**, host'un `/tmp` dizinindeki geçici ölçüm çıktısıdır (`/tmp/tz424_ram_dump.txt`, `/tmp/tz424_ram_err.txt`) ve deployment ile ilgisi yoktur.
