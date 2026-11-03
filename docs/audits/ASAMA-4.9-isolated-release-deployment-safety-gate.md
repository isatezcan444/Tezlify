# AŞAMA 4.9 — ISOLATED RELEASE & DEPLOYMENT SAFETY GATE

**Tarih:** 2026-10-31
**Mod:** STRICT RELEASE PREPARATION — APPROVAL GATE
**Kapsam:** AŞAMA 4.7 Memory Persistence Core Safety Fix'in bağımsız release paketine dönüştürülmesi

> **Duruş:** Commit YOK · Push YOK · Deploy YOK · Restart YOK · Production DB yazma YOK ·
> Persistence loop KAPALI. AŞAMA 5'e geçilmedi.
> Tüm üretim erişimi salt-okunur (GET / SELECT / dosya okuma) olarak yapıldı.

---

## A. Gerçek worktree durumu (ölçüldü)

| Ölçüm | Değer |
| --- | --- |
| `HEAD` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` (`7afb540`, 2026-10-30 15:44 +03) |
| Modified (tracked) | **23** |
| Untracked | **16** |
| Deleted | **0** |
| Staged | **boş** (commit yok) |
| Dizinler dosyaya açıldığında toplam değişen dosya | **42** |

Değişen 42 dosyanın **tamamı** üç kovaya ayrıldı; kova dışında kalan **tek bir kod dosyası yok**:

| Kova | Dosya | İçerik |
| --- | --- | --- |
| 4.7 release kapsamı | **16** | 11 modified (tracked) + 5 yeni |
| 3.9.19 escrow kapsamı | **15** | 10 modified + 5 yeni |
| Dokümantasyon / hafıza | **11** | yalnız `.md` (handoff, audit, patch, `.workbuddy-ai/memory`) |

**Kritik ayrım:** `.workbuddy-ai/memory/{MEMORY.md,2026-10-30.md,2026-10-31.md}` **tracked ve modified**
durumdadır. `git add -A` bunları release'e sokardı. Bu yüzden release **açık dosya listesiyle** kurulacak.

---

## B. 4.7 release dosya manifesti

### B.1 — Değişen üretim dosyaları (8) + test desteği (3)

`git rev-parse HEAD:<yol>` (blob-SHA1) vs `git hash-object <yol>` (worktree blob-SHA1) vs `shasum -a 256`
(içerik, dağıtım sonrası doğrulama için).

| # | Dosya | HEAD blob | Worktree blob | Δ satır | sha256 (kısa) | 4.7 kapsam gerekçesi |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `whatsapp-gateway/src/messages/message-store.js` | `ceb3b051` | `4975ae96` | +277/−1 | `1d4533c8c18410fe` | **P0-1** `_seq`/`seqEpoch` değer imleci, `nextMessageSeq`, `recordEviction`; **P2-1** `ramCapacitySnapshot` |
| 2 | `whatsapp-gateway/src/socket/socket-events.js` | `e0429a1e` | `5cf5150d` | +5/−5 | `973181a9abc33520` | **P0-1** `stampMessageSeq` (ekleme anında damga) + `trimChatMessages` |
| 3 | `whatsapp-gateway/src/session-manager.js` | `7486ecf8` | `bbbee431` | +153/−14 | `1732f8ffd929c254` | **P0-1** `listAllMessages` seq modu, `ensureMessageSeq`, `storeSeqEpoch`; **P2-1** `ramCapacitySummary` |
| 4 | `whatsapp-gateway/src/index.js` | `5bce2c72` | `1102bbcf` | +12/−1 | `1e96691eedc99c8b` | **P0-1** bulk route `afterSeq`/`seqEpoch`; **P2-1** `/health` `capacity` |
| 5 | `whatsapp-gateway/package.json` | `b59573bb` | `2d20e95a` | +1/−1 | — | yeni seq sözleşme testini `npm test` zincirine kaydeder |
| 6 | `backend/app/services/whatsapp/memory_persistence.py` | `794e4481` | `e12c030b` | +196/−45 | `070fda0397f76577` | **P0-1** keyset drain, epoch reset; **P2-2** metrikler, `dead_letter`; 4.8 düzeltmesi: `last_error_page_key` sızdırmaz |
| 7 | `backend/app/services/whatsapp/orchestration/sync.py` | `e49ebe10` | `213f736e` | +133/−11 | `edb7e9d2921c7699` | **P0-2** `_insert_messages_resilient` savepoint izolasyonu + `_insert_messages_one_by_one`; 4.8 düzeltmesi: `_integrity_constraint_name` `orig.__cause__` yürüyüşü |
| 8 | `backend/app/services/whatsapp_gateway.py` | `99fcaebd` | `2f44be20` | +11/−0 | `2e78ab7d6d6bc87d` | **P0-1** `list_all_messages(after_seq, seq_epoch)` parametreleri |
| 9 | `backend/app/main.py` | `d85b4560` | `bbd99ca0` | +2/−0 | `afdacc403411e167` | **P2-2** `/metrics` `whatsapp_memory_persistence` bloğu |
| 10 | `backend/tests/test_whatsapp_memory_persistence.py` | `232f26b7` | `db60486e` | +1/−1 | — | mock imzası `**kwargs` (yeni parametreler) |
| 11 | `backend/tests/test_whatsapp_memory_persistence_hardening.py` | `9d1e92ad` | `4b6314a3` | +4/−4 | — | aynı |

**Tracked toplam:** 11 dosya, **+795 / −83**.

### B.2 — Yeni dosyalar (5)

| # | Dosya | Satır | Blob | Rol |
| --- | --- | --- | --- | --- |
| 12 | `backend/tests/test_whatsapp_pagination_contract.py` | 545 | `bab8dec1` | Backend sözleşme testleri (9): literal `legacy_offset` / `new_offset` / `new_seq` yanıt gövdeleri, front-trim A/B, epoch reset, `PaginationStalled`, `MissingNextAfterSeq`, `/health` UUID sızıntısı |
| 13 | `whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs` | 216 | `761ff7a9` | Gateway sözleşme testleri (8), **gerçek** `createSessionManager()` ile |
| 14 | `scripts/pg_audit_tests/test_tz44_missing.py` | 415 | `2848509a` | Güncellenmiş tz44 (eski-davranış iddiaları 4.7 sözleşmesine çevrildi) |
| 15 | `scripts/pg_audit_tests/test_tz46_audit.py` | 440 | `29e189c3` | Güncellenmiş tz46 (`dead_letter` constraint adı) |
| 16 | `scripts/pg_audit_tests/tz44_pgplugin.py` | 38 | `e1dccfee` | İzole PG harness eklentisi (NullPool) |

**Yeni toplam:** 1 654 satır.

> **Not:** 4.8'de bu testler `/tmp` altındaydı (reboot'ta kaybolur). `scripts/pg_audit_tests/` altına
> alınmaları release kapısını kalıcı kılar — bu, 4.9'un en somut kazançlarından biri.

### B.3 — Değişmeyenler (kanıt)

`contacts.py` (`repositories/contacts.py`) release kapsamında **değil**; deployed `cbe4f509` ile bayt-bayt aynı.
`frontend/` altında 4.7'ye ait **hiçbir** dosya yok (escrow dosyaları hariç).

---

## C. Escrow izolasyon kanıtı

Programatik küme karşılaştırması (`comm -12`):

```
4.7 files: 16        escrow files: 15
=== INTERSECTION ===
--- end intersection ---          ← BOŞ
```

Ek kanıtlar:

1. **Kova dışı kod yok:** 42 değişen dosyanın 11'i kova dışında ve **hepsi `.md`**. Yani yanlışlıkla
   değişmiş bir `.py`/`.ts`/`.js` yok.
2. **`git add -A` kullanılmadı**, kullanılmayacak: release `git add <açık liste>` ile kurulacak.
3. **Worktree tek commit'e dönüştürülmedi:** HEAD `7afb540`, staged boş, hiçbir `reset/clean/checkout/stash`
   çalıştırılmadı.
4. **Escrow dosyaları okunmadı/değiştirilmedi** (yalnız `git status`/`numstat` ile sayıldı).

**Kapsam çakışması bulunmadı** ⇒ §4'ün "çakışma varsa dur" koşulu tetiklenmedi.

---

## D. Gateway/backend uyumluluk matrisi

### D.1 — Yayındaki gateway'in GERÇEK sözleşmesi (kod + canlı ölçüm)

Deployed gateway (`cbe4f509`, donmuş `b5715fe` içeriği):

```js
// index.js:563 — route yalnız bunları okur:
const { limit, offset, since, perChatLimit, jids } = req.query;
// listAllMessages dönüşü:
return { messages: page, total: all.length, offset, limit };
```

- `afterSeq`/`seqEpoch` **hiç okunmuyor** ⇒ Express bilinmeyen query param'ı **sessizce yok sayar**.
- Yanıtta **`pagination` anahtarı yok**, `reached_end` yok.

Canlı doğrulama (`GET /sessions/{sid}/messages/bulk?limit=1`):

```
HTTP 200 · total=9163 · pagination=YOK · eligible_total=undefined
```

### D.2 — Yeni backend'in düşüş davranışı

`memory_persistence.drain_gateway_memory_once`:

```python
reported_mode = str(page.get("pagination") or "")
if reported_mode == "seq":
    mode = "seq"; ...
else:
    if mode == "seq":
        mode = "offset"
        offset = int(start_offset or 0)   # imleç SIFIRLANMAZ
```

Eski gateway `pagination` göndermediği için `reported_mode == ""` ⇒ **offset moduna düşer**.
Yani "sessiz seq" mümkün değil: backend yanıtın şekline bakar, niyetine değil.

### D.3 — Yeni gateway'in geriye uyumu

`listAllMessages` seq moduna **yalnız** `afterSeq` dolu ve sayısal ise girer; aksi hâlde offset dalı
aynen çalışır ve `pagination: 'offset'` döner. Eski backend bu fazladan anahtarı yok sayar.

### D.4 — Matris

| # | Gateway | Backend | Sayfalama modu | P0-1 (front-trim skip) | P0-2 (savepoint) | Veri kaybı riski |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **eski (canlı)** | eski (canlı) | offset | **AÇIK** (bugünkü durum) | AÇIK | mevcut risk, değişmedi |
| 2 | **eski (canlı)** | **yeni (4.7)** | offset (fallback) | **AÇIK** | **KAPALI** | mevcut risk, **artmadı** |
| 3 | **yeni (4.7)** | eski (canlı) | offset | AÇIK | AÇIK | değişmedi (nötr) |
| 4 | **yeni (4.7)** | **yeni (4.7)** | **seq** | **KAPALI** | **KAPALI** | **düzelir** |

### D.5 — §5'in altı sorusuna cevap

1. **Gateway değişiklikleri dağıtılmadan backend seq pagination güvenli çalışır mı?**
   Güvenli, ama **seq çalışmaz**. Satır 2: offset'e düşer, davranış bugünküyle aynı. "Güvenli" ≠ "düzeltilmiş".
2. **Eski gateway ile yeni backend offset fallback doğru çalışır mı?**
   Evet. `pagination` yokluğu offset'e eşleniyor; `offset = start_offset` korunuyor (sıfırlanmıyor).
   Kanıt: `test_legacy_gateway_without_pagination_falls_back_to_offset`,
   `test_offset_fallback_preserves_the_starting_cursor` — **ikisi de yeşil**.
3. **Yeni gateway ile eski backend çalışır mı?**
   Evet. Eski backend `afterSeq` göndermediği için seq modu hiç açılmaz; offset dalı aynı sözleşmeyi döner.
4. **Geçici sürüm uyumsuzluğu veri kaybına yol açar mı?**
   **Yeni kayıp yaratmaz.** Her iki çapraz kombinasyon offset moduna düşer = bugünkü davranış.
   Ancak P0-1'in *mevcut* kaybı sürer; üstelik **canlı olarak riskli**: RAM'de tam 2 sohbet 2 000 tavanında
   (bkz. F.3), yani eviction tur ortasında olursa offset kayması gerçek.
5. **Gateway değişikliği olmadan P0-1 tamamen çözülmüş olur mu?**
   **HAYIR.** `_seq` değer imleci gateway'de üretilir; backend tek başına üretemez.
6. **Backend-only release P0-2'yi çözerken P0-1'i açık bırakır mı?**
   **Evet, tam olarak bu.** Backend-only = P0-2 kapalı, P0-1 açık.

---

## E. Release stratejisi ve dağıtım sırası

### E.1 — Üç strateji

| Strateji | P0-2 | P0-1 | Gateway recreate (RAM riski) | Geri alma maliyeti |
| --- | --- | --- | --- | --- |
| **A. Backend-only** | ✅ | ❌ açık kalır | **Yok** | Düşük: imaj retag, RAM'e dokunmaz |
| **B. Koordineli (tek anda ikisi)** | ✅ | ✅ | **Var** | Yüksek: her iki servis + RAM |
| **C. Önce uyumlu gateway, sonra backend** | ✅ | ✅ | Var (ilk adımda) | Orta: gateway geri alma = **ikinci recreate** |

### E.2 — Seçilen sıra: **iki aşamalı, ÖNCE BACKEND**

**Aşama 1 — Backend-only release (gateway'e dokunulmaz).**
- `--no-gateway` yolu; gateway container'ı **yeniden oluşturulmaz** ⇒ **RAM riski sıfır**.
- P0-2 canlıda kapanır; P0-1 açık kalır ama **regresyon yok** (satır 2 = bugünkü davranış).
- Yeni backend'in fallback yolu **gerçek üretimde** doğrulanmış olur; Aşama 2 için zemin hazırlar.
- Geri alma: yalnız backend imajı; **RAM'e dokunmaz**.

**Aşama 2 — Gateway release (ayrı onay).**
- Öncesinde: `RAM_ONLY = 0` **yeniden ölçümü** + taze snapshot (bkz. G.3).
- Bu adımda `_seq` devreye girer, P0-1 kapanır.

**Neden gateway-first (Strateji C) değil?**
Gateway-first de uyumludur, ama geri alma simetrisi kötüdür: gateway'i geri almak **ikinci bir recreate**
demektir, yani RAM'i ikinci kez riske atar. Backend-first'te ilk adımın geri alınması RAM'e hiç dokunmaz.
Ayrıca backend-first, seq'i açmadan önce fallback'i üretimde kanıtlar.

### E.3 — `--no-gateway` bu worktree ile DOĞRUDAN kullanılamaz

Muhafız (`host-release.sh:551-570`) `deployed..TARGET` arasında `whatsapp-gateway/` + compose farkı
**sıfır** olmasını ister. İki engel var:

1. 4.7 worktree'sinde 4 gateway dosyası değişik (`+447/−21`).
2. **Daha önemlisi:** `main` (HEAD `7afb540`) gateway ağacı, yayındaki `cbe4f509` gateway ağacından
   **zaten farklı**. Release dalı gateway'i yayındaki hâline geri yazmadıkça muhafız geçmez.

**Yayında olmayan gateway commit'leri (main'de var, üretimde hiç çalışmadı):**

| Commit | Tarih | Konu |
| --- | --- | --- |
| `b5f7605` | 2026-10-28 13:01 | fix(gateway): report real cached message count after reconnect |
| `9754143` | 2026-10-28 16:23 | feat(gateway): PDO/gecmis teshis izleri (PII'siz) |
| `0d909ab` | 2026-10-28 20:00 | fix(gateway): PDO zaman asimini NO_CHUNK / WAITER_MISMATCH / PDO_NOT_SENT diye ayir |

Bu üç commit + 4.7'nin gateway katmanı birlikte gidecektir. **Aşama 2'nin kapsamı "sadece 4.7" değildir.**
Bu, ayrı bir inceleme gerektiren gerçek bir kapsam genişlemesidir (bkz. K-2).

### E.4 — Release dalı

```
release/backend-only-4.7  :=  main ağacı
                              + 4.7 backend değişiklikleri
                              + whatsapp-gateway/  ← cbe4f509 hâline geri yazılmış
```

Ön kontrol (henüz çalıştırılmadı, commit yok):

```bash
python scripts/deploy/backend_only_release.py \
    --base cbe4f509f4bcc5babb12cc85e0ad422cb13ba739 \
    --target release/backend-only-4.7 \
    --backend-from origin/main
```

> `backend_only_release.py` **yalnız doğrulayıcıdır** — ref'i üretmez. Ref'i operatör keser.

---

## F. RAM-only ve DB identity doğrulaması (§6 — KRİTİK KAPI)

Yöntem: gateway'den **tüm** RAM kimlikleri `(conversation_id, wa_message_id)` çekildi (9 163 satır),
DB'den aynı kimlikler persistence'ın kullandığı jid türetmesiyle üretildi (9 206 satır), kümeler karşılaştırıldı.

### F.1 — Sonuç

| Metrik | Değer | Durum |
| --- | --- | --- |
| RAM mesaj sayısı | **9 163** | — |
| DB mesaj sayısı | **9 206** | — |
| **RAM-ONLY kimlik** | **0** | ✅ **PASS** |
| DB-ONLY kimlik | 43 | açıklandı (F.3) |
| RAM `wa_message_id` NULL | 0 | ✅ |
| DB `wa_message_id` NULL | 0 | ✅ |
| RAM yinelenen kimlik | 0 | ✅ |
| DB yinelenen kimlik | 0 | ✅ |
| Tenant uyuşmazlığı (`m.user_id ≠ c.user_id`) | **0** | ✅ |
| `user_id` NULL mesaj | **0** | ✅ |
| Sohbet/session uyuşmazlığı | 0 (126 sohbet / 9 206 mesaj → **tek** session 201) | ✅ |

### F.2 — Görünen tek RAM-only, aslında jid normalizasyonu

Ham karşılaştırma 1 "RAM-only" verdi:

```
RAM : 1793297712@broadcast         wa=3A51021941AFAA6BFF97
DB  : 1793297712@s.whatsapp.net    wa=3A51021941AFAA6BFF97   ← AYNI mesaj
```

Aynı `wa_message_id`, farklı jid (durum/broadcast mesajı kişi jid'i altında saklanmış).
Eşleştirildikten sonra **RAM-ONLY = 0**. Bu bir kayıp değil, adlandırma farkıdır.

### F.3 — 43 DB-only neden kayıp değil

| Sohbet | DB-only | RAM'deki mesaj sayısı |
| --- | --- | --- |
| `905442767554@s.whatsapp.net` | 39 | **2 000** (tavan) |
| `905413749073-1589570212@g.us` | 4 | **2 000** (tavan) |

DB-only satırların **tamamı**, RAM'de 2 000 tavanına dayanmış **iki sohbetten**. Bunlar RAM'den
tahliye edilmiş *eski* mesajlar; DB'de güvende. Sayı farkı (9 206 − 9 163 = 43) tam olarak bunlardır.

### F.4 — Kapasite

- RAM'de **100 sohbet**, 9 163 mesaj.
- **2 sohbet tam 2 000** tavanında; üçüncü en büyük 1 255 (%63).
- 60 sohbet 10'un altında.
- **Sonuç:** tavan iki sohbette **aktif olarak baskı yapıyor**; P0-1'in offset kaybı bu iki sohbette
  teorik değil, canlı bir risktir. Bu, Aşama 2'nin (gateway) gerekçesini güçlendirir.

### F.5 — Kapı kararı

`RAM_ONLY = 0` **sağlandı**. Ancak §6'nın açıkça söylediği gibi bu **tek başına gateway restart yetkisi
değildir**; snapshot ve identity kontrollerinin tamamı ayrıca PASS olmalıdır — hepsi PASS (F.1, G).

---

## G. Snapshot ve felaket kurtarma durumu

### G.1 — Mekanizma

`tezlify-ram-snapshot.timer` → `tezlify-ram-snapshot.service`, **saatlik**, `--execute` ile:
yerel şifreli snapshot + **off-site yükleme + uzaktan geri indirip SHA-256 doğrulama**.

### G.2 — Son koşum (ölçüldü)

| Alan | Değer |
| --- | --- |
| Zaman | `2026-10-31T07:01:58Z` (bitiş 07:02:11Z) |
| Servis sonucu | `status=0/SUCCESS`, `Active: inactive (dead)` (oneshot) |
| Snapshot adı | `tezlify-ram-20261031T070158Z` |
| **record_count** | **9 163** ← RAM ölçümüyle **birebir** |
| chat_count | 100 |
| upload_status | `UPLOADED` |
| **remote_verified** | **true** |
| rsnap_sha256 | `fa01aa3ba9e8ecdb83d77edb1a6af9ec482ef57f7d8cba53a12a0fa8de049bdf` |
| Süre | 13.1 s |

### G.3 — Durum ve sınır

- Off-site doğrulama **PASS** (`remote_verified: true` = yeniden indirilip hash karşılaştırıldı).
- Snapshot 07:01:58Z, RAM ölçümü ~07:26Z. Arada RAM **9 163 → 9 163** (değişmedi), yani snapshot güncel.
- **Uyarı:** `archive_mode=off`, PITR yok. RAM snapshot'ı, gateway belleğindeki mesajların **tek** yedeğidir.
  Bu yüzden Aşama 2'de gateway recreate'ten **hemen önce** yeni bir snapshot alınmalı ve `remote_verified:true`
  görülmelidir. Snapshot olmadan recreate = geri dönüşü olmayan kayıp.

---

## H. Test sonuçları (§7 — release test kapısı)

İzole PostgreSQL **17.11** (`127.0.0.1:55434`, `tezlify_test_47`), `-p tz44_pgplugin` (NullPool),
`-o asyncio_default_{fixture,test}_loop_scope=session`. SQLite harness her koşumda yeniden provision edildi.

| # | Kapı | Sonuç |
| --- | --- | --- |
| 1 | 4.7 memory persistence + hardening (25) | **25 passed** |
| 2 | Pagination contract (yeni, 9) | **9 passed** |
| 3 | tz44 güncellenmiş (8) | **8 passed** |
| 4 | tz46 güncellenmiş (10) | **10 passed** |
| 5 | PG17 unique-index / iki-arbiter (tz44+tz46) | **18 passed** (aynı koşum) |
| 6 | Gateway `npm test` (37 betik) | **EXIT 0**, 0 FAIL |
| 7 | Gateway seq contract (suite içinde) | **8/8 PASS** (A,B,C,D,E,F,G,H) |
| 8 | Gateway legacy contract (check C) | PASS — `afterSeq` yokken offset şekli **değişmedi** |
| 9 | PII/log güvenliği | PASS — `test_safe_error_strips_sql_and_bound_parameters`, `test_health_payload_never_leaks_a_gateway_uuid`, gateway `test-latency-metrics` (JID/telefon/QR yok) |
| 10 | Tenant izolasyonu (7 dosya) | **121 passed** |
| 11 | Backend import sanity (5 modül) | **OK** |
| 12 | Gateway `node --check` (5 dosya) | **OK** |
| 13 | Backend tam suite | **2174 passed, 4 skipped**, EXIT 0 (170 s) |
| 14 | Frontend build | **EXIT 0** (11.35 s) |
| 15 | Test DB üretimi reddediyor mu? | **PASS** — `RuntimeError` (host `130.162.247.20`), bağlanmadan **önce** |

### H.1 — Ortam bulgusu (harness, ürün değil)

Taze `tezlify_test_47` üzerinde ilk koşum **34 error** verdi:

```
asyncpg.exceptions.UndefinedTableError: relation "whatsapp_sessions" does not exist
```

Kök neden: `backend/tests/conftest.py::run_db_migrations` yalnız `ensure_*` **artımlı** migration'ları çağırır;
**temel şemayı kurmaz**. Ayrıca çağırmadığı iki fonksiyon zorunlu:

- `ensure_whatsapp_gateway_private_schema` → `whatsapp_private` şeması
- `ensure_whatsapp_private_lid_and_history_tables` → `whatsapp_private.lid_mappings`

İkincisi yoksa `_load_conversation_index` içindeki
`SELECT lid_jid, phone_jid FROM whatsapp_private.lid_mappings` **işlemi iptal eder**, sonraki SELECT
`InFailedSQLTransactionError` alır. Bu, ürün kusuru değil **provisioning boşluğudur**; düzeltilmiş
provisioning ile 34 test yeşile döndü. (Bkz. K-4: conftest'e eklenmesi önerilir.)

### H.2 — Test kapsamı boşluğu (açıkça raporlanıyor)

4.8'in "4.7 yetkili 36 passed" sayısı **11 `tz47` testi** içeriyordu; o dosya `/tmp/tz47tests/` altındaydı ve
`/tmp` temizlenince **kayboldu**. Repo'da kopyası yok.

- Bu 11 test **yeniden üretilemedi**; "36" sayısı bugün **doğrulanamaz**.
- Aynı davranışların bir kısmı yeni `test_whatsapp_pagination_contract.py` (9) ile kapsanıyor, ama
  **denklik ölçülmedi** — bu yüzden "eşdeğerdir" denmiyor.
- Bu bir **koşul** olarak aşağıya yazıldı (L-C1), görmezden gelinmedi.

---

## I. Image/tag ve rollback planı

### I.1 — Mevcut üretim durumu (salt-okunur)

| Öğe | Değer |
| --- | --- |
| Deployed commit | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| Release | `backend-only 3.8.7`, `released_at 2026-10-29T21:48:07Z` |
| Backend image | `sha256:06ce4fe12874d9e694e03e2f53e74f6d95fef5e3339b4dfde7c8554ec9ddb21a` (container `ce2e901b6619`, up 34 h) |
| Gateway image | `sha256:a1ba2572c40926fd3d71289b6e7eb20116915efc9024c7487631f24324eaa1cc` (container `5b867095d376`, up 3 gün) |
| Önceki backend image | `sha256:a5c3549296b9aae338d2bcb426fce22e528e1f541d6e8d5227d105bcae9d9e2f` |
| Rollback tag'leri | `tezlify-backend:pre-20261029T214629Z`, `tezlify-gateway:pre-20261029T214629Z` |
| `gateway_touched` (son release) | `false` |

> **Ölçüm notu:** `docker images` bu konakta **20 s'de yanıt vermedi** (`timeout` → rc=124), bu yüzden tag
> listesi `backups/releases/<TS>/release.json` kaydından okundu — zaten otorite olan kayıt bu.

### I.2 — Deploy sırası (Aşama 1, backend-only)

1. `release/backend-only-4.7` ref'i kesilir (gateway `cbe4f509` hâline geri yazılmış).
2. `python scripts/deploy/backend_only_release.py --base cbe4f509… --target release/backend-only-4.7 --backend-from origin/main`
   → **exit 0** beklenir.
3. Hedefin **kendi** script kopyası çalıştırılır (self-blob muhafızı, exit 9):
   `bash scripts/deploy/run_release.sh --expected-self-blob <blob> <ref> --no-gateway`
4. Script candidate env'e `WHATSAPP_MEMORY_PERSIST_ENABLED=false` yazar, `persist_flag_effective` ile
   cutover'ı kapatır.
5. Cutover sonrası: `/health` + `/metrics` + mesaj sayıları + gateway imajının **değişmediği**.

**Health doğrulama (üretim konakta):**

```bash
cat /opt/tezlify/.deployed-commit                                   # yeni sha
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep tezlify-
docker exec tezlify-backend curl -s http://127.0.0.1:8000/health \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["whatsapp_memory_persistence"]["config_enabled"],d["whatsapp_memory_persistence"]["task_running"])'
docker exec tezlify-db psql -U tezlify -d tezlify -tAc "SELECT count(*) FROM messages;"
docker exec tezlify-gateway node -e 'fetch("http://127.0.0.1:8787/health").then(r=>r.json()).then(j=>console.log(j.sessions,j.status))'
```

Beklenen: `config_enabled=false`, `task_running=false`, gateway imaj ID'si **`5b867095d376` olarak kalır**
(recreate edilmedi ⇒ RAM korunur).

### I.3 — Rollback

**Backend-only rollback (ÖNERİLEN — gateway'e dokunmaz):**

```bash
ssh ubuntu@130.162.247.20
cd /opt/tezlify
docker tag tezlify-backend:pre-<YENI_TS> tezlify-backend:latest
docker compose -f docker-compose.prod.yml up -d --no-deps backend
```

`host-release.sh:739-741` her release'te **hem** backend **hem** gateway imajını `pre-<TS>` olarak etiketler;
yani `--no-gateway` deploy'unda bile backend rollback tag'i hazırdır. `--no-deps backend` gateway'i
**yeniden oluşturmaz** ⇒ RAM korunur.

**`--rollback-to` KULLANILMAMALI (backend-only senaryoda):**

```bash
# host-release.sh:88-95
docker tag "tezlify-backend:pre-$REL" tezlify-backend:latest
docker tag "tezlify-gateway:pre-$REL" tezlify-gateway:latest
docker compose -f "$COMPOSE_FILE" up -d backend gateway      # ← İKİSİNİ de yeniden oluşturur
```

Bu yol gateway'i recreate eder ⇒ **RAM kaybı**. RAM_ONLY=0 + doğrulanmış snapshot olsa bile, backend-only
bir geri almada gateway'e dokunmanın hiçbir gerekçesi yoktur. **(Bulgu I-1 / 4.8'deki J-1)**

**Aşama 2 (gateway) rollback'i:**
- Gateway imajı geri alınır ⇒ **ikinci recreate** ⇒ RAM ikinci kez sıfırlanır.
- Bu yüzden Aşama 2 geri dönüşü **ancak** recreate öncesi alınmış doğrulanmış snapshot'a dayanır.
- Geri alma sonrası `RAM_ONLY` **yeniden ölçülmelidir**; sıfır değilse veri kaybı gerçekleşmiştir ve
  snapshot'tan geri yükleme gerekir.

---

## J. Persistence loop güvenlik durumu (§9)

| Kontrol | Ölçülen |
| --- | --- |
| `WHATSAPP_MEMORY_PERSIST_ENABLED` | **boş / tanımsız** (kapalı) |
| `/health.whatsapp_memory_persistence.config_enabled` | **false** |
| `task_running` | **false** |
| `runs` | **0** |
| `inserted_total` / `errors_total` | 0 / 0 |
| `cursor_count` | 0 |
| Script'in flag zorlaması | `host-release.sh:824-843` — mevcut değeri **siler**, `=false` yazar, candidate'ı `-e` ile çalıştırır |
| Cutover kapısı | `:985 persist_flag_effective()` → `false` değilse `die` |
| Environment değişikliği | **yapılmadı** |

**4.7'nin dağıtılması loop'u açmaz.** Loop ayrı bir operatör kararıdır ve bu aşamada kilitli kalacaktır.

---

## K. Açık riskler

| # | Risk | Ağırlık | Durum |
| --- | --- | --- | --- |
| K-1 | **`tz47` 11 testi kayıp** — "36 passed" yeniden üretilemiyor | Orta | **Açık** (L-C1 koşulu) |
| K-2 | **Gateway drift:** `main`'de 3 commit (PDO teşhis, cached-count) üretimde hiç çalışmadı; Aşama 2 bunları da taşır | **Yüksek** | **Açık** — Aşama 2 ayrı inceleme ister |
| K-3 | P0-1 backend-only ile **kapanmaz**; 2 sohbet 2 000 tavanında, offset kaybı canlı risk | **Yüksek** | Bilinçli kabul (Aşama 1) |
| K-4 | `conftest` temel şemayı ve `whatsapp_private` şemasını kurmuyor ⇒ taze PG DB'de 34 error | Orta | Bulgu; düzeltme 4.9 kapsamı dışı |
| K-5 | `--rollback-to` gateway'i de recreate eder (RAM kaybı) | Orta | **Azaltıldı**: `--no-deps backend` prosedürü yazıldı |
| K-6 | `docker images` konakta yanıt vermiyor (rc=124) | Düşük | Release kayıtlarından okundu; not edildi |
| K-7 | `memory_persistence._load_conversation_index` LID sorgusu `session_id = gateway_id` ile anahtarlı (4.8 K4) | Orta | 4.9 kapsamı dışı; ayrı iş |
| K-8 | Off-site snapshot RAM'in **tek** yedeği (`archive_mode=off`, PITR yok) | **Yüksek** | Aşama 2 öncesi taze snapshot zorunlu |
| K-9 | RAM-only=0 ölçümü **anlıktır**; yeni mesaj geldikçe değişir | Orta | Her gateway adımından hemen önce yeniden ölç |

---

## L. RELEASE PACKAGE STATUS

### **READY WITH CONDITIONS**

**Gerekçe (ölçülmüş):**
- 16 dosyalık kapsam **kesin** ve escrow'dan **tamamen ayrık** (kesişim boş, kova dışı kod yok).
- 15 test kapısının **tamamı yeşil**; backend 2 174 passed, gateway 0 FAIL, frontend build 0.
- Rollback planı **ölçülmüş** etiketlere dayanıyor, varsayıma değil.
- P0-2 tamamen, P0-1 kısmen (Aşama 2'ye bağlı).

**Koşullar (release'i engellemez, ama yazılı kabul gerektirir):**

- **L-C1 — Test kapsamı boşluğu:** `tz47` 11 testi repo'da yok. Ya (a) bu davranışlar için kalıcı testler
  yazılıp `backend/tests/`e konur, ya da (b) kapsamın `test_whatsapp_pagination_contract.py` + persistence
  testleriyle yeterli olduğu **açıkça** kabul edilir. "36 passed" iddiası **kullanılmayacaktır**.
- **L-C2 — Aşama 2 ayrı onay:** gateway release'i bu paketin parçası değildir; K-2 (drift) ve K-8
  (snapshot) kapatılmadan planlanmaz.
- **L-C3 — Dokümantasyon commit'i ayrı:** 11 `.md` dosyası ve `.workbuddy-ai/memory` release commit'ine
  **girmez**.

---

## M. PRODUCTION DEPLOY STATUS

### Aşama 1 (backend-only): **READY FOR EXPLICIT APPROVAL**

- Bloke eden bir teknik engel **yok**.
- `RAM_ONLY = 0`, identity kontrolleri PASS, loop kapalı, rollback hazır.
- **Onay bekliyor.** Commit/push/deploy bu aşamada **yapılmadı**.

### Aşama 2 (gateway): **NOT AUTHORIZED**

- `RAM_ONLY = 0` sağlanmış olsa da, **K-2** (3 dağıtılmamış gateway commit'i) ve **K-8** (taze snapshot
  zorunluluğu) kapatılmadan yetki verilmez.
- Ayrıca §6 gereği `RAM_ONLY` ölçümü recreate'ten **hemen önce** tekrarlanmalıdır.

---

## Duruş beyanı

- `git commit` **yok** · `git push` **yok** · deploy **yok** · container restart/recreate **yok**
- Production DB yazma **yok** (yalnız `SELECT` / `GET` / dosya okuma)
- QR/session/encryption key müdahalesi **yok**
- Persistence loop **kapalı** (`config_enabled=false`, `task_running=false`, `runs=0`)
- Worktree korundu: `HEAD=7afb540`, staged boş, hiçbir `reset/clean/checkout/stash` çalıştırılmadı
- **AŞAMA 5'e geçilmedi.**

**Başarı kriteri karşılandı:** 4.7 değişiklikleri escrow'dan bağımsız, test edilmiş, rollback planı
hazırlanmış ve açık kullanıcı onayını bekleyen bir release paketi hâline getirildi.
