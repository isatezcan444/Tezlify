# Aşama 3.8.7 — Acil mesaj koruma, LID kurtarma analizi, destructive migration kapısı

**Tarih:** 2026-10-29 (20:59–21:20Z)
**Üretim:** backend `38fe087`, gateway `5b867095d376` (2026-10-27T17:25:57Z, **dokunulmadı**)
**Sonuç:** 9 mesaj RAM'de **ve** şifreli snapshot'ta kimlik bazında kanıtlandı. Silme davranışı
kod düzeyinde **fail-closed** hâle getirildi. **Deploy yapılmadı, üretim DB'sine yazılmadı.**

---

## 1. Başlangıç durumu (salt okunur, 20:59:23Z)

| Container | ID | StartedAt | Restart |
|---|---|---|---|
| tezlify-backend | `3f6a66f68bc8` | 2026-10-29T18:37:12Z | 0 |
| tezlify-gateway | `5b867095d376` | **2026-10-27T17:25:57Z** | 0 |
| tezlify-db | `f6d79c4a1f8b` | 2026-10-01T17:45:08Z | 0 |
| tezlify-caddy | `ee66a5cab371` | 2026-10-12T13:12:45Z | 0 |

`.deployed-commit` = `HEAD` = `38fe087`, ağaç temiz. Oturum **201 = CONNECTED**.
DB: `conversations 125 | messages 2095 | contacts 1537`. Persistence: `config_enabled:false`,
`runs:0`, `inserted_total:0`.

---

## 2. BÖLÜM A — 9 mesajın korunması

### 2.1 Kimlik tespiti (içerik/JID yazdırılmadı)

Salt okunur bir sonda (`/tmp/unmapped_probe.py`, konteynerde çalışır, DB'ye yazmaz) gateway
RAM'ini sohbet bazında topladı ve `conversations.phone_e164` üzerinden eşledi:

| Ölçüm | Değer |
|---|---|
| Gateway sohbet sayısı | 100 |
| DB'deki WhatsApp sohbeti | 125 |
| RAM kaydı (toplandı) | **9139** |
| Kısa düşen sohbet | **0** |
| Eşlenemeyen kayıt | **10** = LID **9** + PN **1** |
| Eşlenemeyen kimlik kökü | `8fa3806b3f2c7b82…` |

9 LID kaydı **tek bir jid_hash** (`2453b8a70004b2a5`) altında, hepsi gövdeli, medyasız,
zaman damgaları **2026-10-09T16:40:32Z – 18:21:41Z**. Bu, 3.8.6'da `purge_raw_jid_identity_data`
tarafından silinen sohbetin (`conversation_id=38412`) mesajlarıdır.

1 PN kaydı ayrı bir jid_hash (`90c4a2fda1ceb2fd`), **2026-10-29T18:15:56Z** — cutover'dan
(18:35:44Z) ~20 dk önce, snapshot'tan sonra. Purge ile ilgisi yok; ayrı bir eşlenemeyen jid.

### 2.2 Eski snapshot'ın kapsamı (varsayılmadı, ölçüldü)

`tezlify-ram-20261029T125755Z.rsnap` şifresi çözülüp kimlik kümeleri karşılaştırıldı:

| | Sonuç |
|---|---|
| Snapshot kayıt | 9137 |
| Kimlik kökü | `400dba3017b3bd7b…` (= 3.8.3 kaydı) |
| 9 LID mesajı kapsanıyor mu | **EVET — 9/9** |
| Kapsanmayan | 1 (yukarıdaki yeni PN) |

⇒ **9 mesaj zaten doğrulanmış 3.8.3 yedeğinde vardı.** Bu, 3.8.6'daki kaybın "telafisiz"
olmadığını gösteren en önemli bulgudur.

### 2.3 Yeni snapshot (istenen adım)

| Alan | Değer |
|---|---|
| Dosya | `/var/backups/tezlify-ram/tezlify-ram-**20261029T210007Z**.rsnap` |
| Boyut | **7 135 835 B** |
| İzin / sahip | **600** / `ubuntu:ubuntu` (dizin 700) |
| SHA-256 | `fdafdb7b3c7cdb647c89d899e4a2a322f6d4b3883559b30a1f5212fd67e17fcb` |
| Magic | `RSNAP1` (AES-256-GCM, AAD `tezlify.ram-snapshot:v1`) |
| Manifest | `tezlify-ram-20261029T210007Z.manifest.json`, 600, 12 316 B |
| Kayıt / sohbet | **9139 / 100** |
| `duplicates_removed` | 0 |
| `rejected_missing_identity` | 0 |
| `unstable_chats` | **[]** (hepsi `stable`, `shortfall: 0`) |
| `late_arrival_count` | 0 |
| `identity_root_sha256` | `743f5959b03a479d…` |
| `records_sha256` | `09f637b80f45f223…` |

**Bağımsız doğrulama** (`--verify -`, konteynerde, dosya konteynere yazılmadı):

```
ok: true
integrity_problems: []   completeness_problems: []
record_count 9139 · chat_count 100 · duplicate_identity 0
identity_root_sha256 743f5959… (manifest ile aynı)
```

**Kapsam kanıtı:** aynı sonda yeni snapshot'la tekrar çalıştırıldı →
`COVERED 10 / MISSING 0`. Yani 9 LID + 1 PN mesajının tamamı yeni dosyada, kimlik bazında.

### 2.4 Bir hata ve düzeltmesi (kayda değer)

İlk denemede `/tmp/ram_snapshot.py` konakta **yoktu** (3.8.6 temizliği silmiş), `python -c ""`
sessizce çalıştı ve **0 baytlık** iki dosya oluşturdu; `SNAP_EXIT=0` görünüyordu. Boyut
kontrolü olmasaydı "yedek alındı" diye raporlanacaktı. Boş dosyalar silindi, betik yeniden
yüklendi, üretim `[ ! -s ]` kapılarıyla tekrarlandı.

---

## 3. BÖLÜM B — Silme işleminin gerçek nedeni

### 3.1 Çağrı noktaları

| Konum | Tür |
|---|---|
| `backend/app/main.py:307` (lifespan) | **tek üretim çağrısı** — her boot |
| `backend/tests/test_whatsapp_{purge_defers_known_bridge,boot_lid_merge,faz7_identity_sync}.py` | testler |
| `scripts/diagnostics/whatsapp_lid_split_repair.py`, `scripts/deploy/migration_guard.py` | yalnızca docstring referansı |

`start.py` → `uvicorn.run(app)` → lifespan. **Ayrı bir migration adımı yok**; `*.sql`/alembic
dosyası yok. Silme, uygulama içi startup migration'ının içinde.

### 3.2 Silme koşulları (eski kod)

```
1) UPDATE contacts SET display_name = NULL      (ham jid/lid görünen ad)
2) UPDATE messages SET sender_name  = NULL      (ham jid/lid gönderen adı)
3) ghost_ids = SELECT c.id FROM contacts c
               WHERE c.phone_e164 LIKE 'jid:%@lid'
                 AND NOT EXISTS (SELECT 1 FROM lid_mappings lm
                                 WHERE lm.lid_jid = substr(c.phone_e164,5)
                                   AND lm.phone_jid IS NOT NULL AND lm.phone_jid <> '')
   → DELETE FROM messages      WHERE conversation_id IN (ghost sohbetleri)
   → DELETE FROM conversations WHERE id IN (…)
   → DELETE FROM contacts      WHERE id IN (ghost_ids)
```

**Üç ayrı kusur:**

1. **Tenant filtresi yok.** `WHERE phone_e164 LIKE 'jid:%@lid'` tüm kullanıcıları kapsar;
   bir kiracının boot'u başka kiracının satırlarını silebilir.
2. **"Köprü yok" = "kimse yok" varsayımı.** LID gizlilik modunda telefon JID'i hiç açığa
   çıkmayabilir. Köprü satırının yokluğu, kişinin yokluğunun kanıtı değildir.
3. **FAIL-OPEN.** `_lid_bridge_table_available` hata dönerse `defer_clause = ""` olur ve
   **her** hayalet silinir. Yani köprü tablosu okunamadığında davranış "hiçbirini silme"
   değil, "hepsini sil" oluyordu. En tehlikeli dal tam olarak en az bilgi olan daldı.

### 3.3 Git geçmişi (kanıtlanmış tarihler)

| Commit | Tarih | Etki |
|---|---|---|
| `9647b73` | 2026-09-12 | Faz 7: hayalet LID temizliği + `DELETE FROM messages` + `main.py` çağrısı **ilk kez** |
| `291ea01` | 2026-09-12 | Faz 9: aynı silme bloğu yeniden düzenlendi |
| `7c5cb2c` | 2026-10-01 | "köprüsü bilinen" ertelemesi eklendi (yanlış join: `ws.gateway_id`) |
| `7b510c7` | 2026-10-28 | erteleme `lid_jid`'e taşındı (doğru); silme yolu **yine açık** |

Silme davranışı **2026-09-12'den beri** kodda. 2026-10-29'daki kayıp yeni kod değil, o günden
beri süren davranışın ilk kez tetiklenmesiydi (`migrations.py` base ile bayt-bayt aynıydı).

### 3.4 Mesajlar neden RAM'de kaldı, DB ilişkisi neden korunmadı

Gateway `messagesByChat` deposu jid anahtarlıdır ve DB'den **bağımsızdır**; purge yalnızca DB
satırlarını sildi. Bu yüzden 9 mesaj RAM'de duruyor ama **sohbetsiz** kaldı
(`CLASS_unmapped_jid`). Kalıcılaştırma sweep'i eşlenemeyen jid'i atlar (yazacak sohbet yok) ⇒
**gateway recreate = kalıcı kayıp**. Snapshot bu yüzden kritikti.

---

## 4. BÖLÜM C — Fail-closed tasarım

### 4.1 Yeni sözleşme

`purge_raw_jid_identity_data` artık **hiçbir satırı silmez**. Sınıflandırır ve deftere yazar:

| Sınıf | Anlam | Eski davranış |
|---|---|---|
| `bridge_known_deferred` | köprü var; `merge_deferred_lid_ghosts` aynı boot'ta birleştirir | ertelenirdi |
| `bridge_unknown_has_messages` | köprü yok, **mesaj var** | **SİLİNİRDİ** ← 9 mesajın sınıfı |
| `bridge_unknown_empty` | köprü yok, mesaj yok | **SİLİNİRDİ** |

Ek olarak `report["deleted_contacts|conversations|messages"]` **her zaman 0** döner; böylece
"silmeyi bıraktı" ile "silmeyi unuttu" ayırt edilebilir.

### 4.2 Karantina defteri

Yeni tablo `whatsapp_identity_quarantine` (`backend/app/models/whatsapp_identity_quarantine.py`):
`contact_id` (tekil), `conversation_id`, `user_id`, `phone_e164` (sentinel), `reason`,
`status` (`QUARANTINED|RELEASED|RESOLVED`), `message_count`, `detail` (PII'siz JSON).

- **Yalnızca EKLEME:** yeni tablo, mevcut hiçbir tabloya `ALTER` yok.
- **Idempotent:** `contact_id` başına tek satır; ikinci boot `UPDATE` eder, satır eklemez.
- **Operatör kararı korunur:** startup `RELEASED`/`RESOLVED` durumunu **ezmez**.
- **Tenant sahipliği** defterde taşınır (`user_id`) — birleştirme kiracı sınırını aşamaz.

### 4.3 Fail-closed yönü

| Durum | Eski | Yeni |
|---|---|---|
| Köprü tablosu okunamıyor | **hepsini sil** (fail-open) | `bridge_unknown_*` ⇒ **hepsini tut** |
| Köprü yok, mesaj var | sil | tut + defter |
| Köprü yok, mesaj yok | sil | tut + defter |
| Defter yazılamıyor | — | silme yok; yalnızca görünürlük kaybı + `ERROR` logu |

### 4.4 Health

`/health.whatsapp_identity_quarantine` = `{available, quarantined, with_messages,
messages_held, by_reason}`. **Yalnızca sayım**; gövde/telefon/JID yok. `/health` **DB turu
atmaz** — özet boot'ta `quarantine_counts` ile tazelenir, uç senkron okur (yavaş DB'nin sağlık
probunu yavaşlatıp asıl arızayı gizlemesini önlemek için).

### 4.5 Değişen dosyalar

| Dosya | Değişiklik |
|---|---|
| `backend/app/models/whatsapp_identity_quarantine.py` | **yeni** model + gerekçe docstring'i |
| `backend/app/models/__init__.py` | kayıt (+2) |
| `backend/app/core/migrations.py` | purge yeniden yazıldı (**DELETE yok**), `ensure_whatsapp_identity_quarantine_table`, `quarantine_counts`, `quarantine_status` |
| `backend/app/main.py` | ensure → purge → sayaç tazeleme sırası; `/health` alanı |
| `backend/tests/test_whatsapp_purge_defers_known_bridge.py` | sözleşme tersine çevrildi (silme → karantina) |
| `backend/tests/test_whatsapp_faz7_identity_sync.py` | hayaletin korunduğu doğrulanıyor |
| `backend/tests/test_whatsapp_identity_quarantine.py` | **yeni**, 11 test |

---

## 5. BÖLÜM D — Testler ve Git

İzole DB: `TEST_DB_PATH=DATABASE_URL=/tmp/tezlify_387.db` (34 tablo; karantina tablosu dahil).
`conftest` fail-closed kapıları test edilir (uzak DB ve yol uyuşmazlığı `RuntimeError`).

| Kapı | Sonuç |
|---|---|
| Hedefli: quarantine + purge-defer + faz7 + boot-merge + forensic-g3 + split-repair | **78 passed, exit 0** |
| Backend tam paket, sabit sıra (`-p no:randomly`) | **2052 passed, 4 skipped, exit 0** |
| Backend tam paket, rastgele `--randomly-seed=387` | **2052 passed, 4 skipped, exit 0** |
| Backend tam paket, rastgele (ilk, seedsiz) | 2051 passed, **1 failed** → aşağıdaki flake |

### Bilinen, önceden var olan flake

`test_campaign_runner_pauses_on_daily_limit_reached` rastgele sırada bir kez düştü
(`campaign_paused` yayını yok). **Benim değişikliğimle ilgisi yok** — kanıt: aynı test
**temiz DB'de tek başına** ve **base commit `c4de0ac` worktree'sinde** de düşüyor
(`git worktree add /tmp/wt_base387 HEAD`). Test kendi lead'ini kurmuyor; başka testlerin
bıraktığı duruma bağlı. Düzeltmesi bu aşamanın kapsamı dışında; rapora açık risk olarak yazıldı.

### Yeni testlerin kapsadığı senaryolar (istenen 7)

1. Köprüsüz LID + mesajlar **korunur** (3.8.6 kaybının birebir yeniden üretimi)
2. Köprüsü doğrulanmış kayıt `bridge_known_deferred` olarak sınıflanır, `user_id` taşınır
3. İki startup → tek defter satırı, 0 silme, veri aynı
4. Başka kiracının köprüsü bu hayaleti "çözülmüş" göstermez (fail-closed)
5. Silme adayı (`bridge_unknown_empty`) bile **fiziksel olarak silinmez**
6. `TEST_DB_PATH`/`DATABASE_URL` uyuşmazlığı ve uzak DB ⇒ `RuntimeError` (fail-closed)
7. Eski şema (tablo yok) ⇒ `available:false`, asla patlamaz; `ensure` idempotent

Ek: operatörün `RELEASED` kararı sonraki boot'ta ezilmez.

---

## 6. Üretim değişmezliği (20:59:23Z → 21:08:20Z)

| Ölçüm | Başlangıç | Bitiş | Yorum |
|---|---|---|---|
| 4 container ID / StartedAt | — | **aynı** | gateway `5b867095d376` / 10-27T17:25 |
| `RestartCount` | 0 | **0** | — |
| `.deployed-commit` | `38fe087` | **`38fe087`** | yeni deploy yok |
| Oturum 201 | CONNECTED | **CONNECTED** | QR/relink yok |
| `conversations` / `contacts` | 125 / 1537 | **125 / 1537** | sabit |
| `messages` | 2095 | **2116** | +21 canlı ingest (hata değil) |
| Snapshot dosyaları | 2 çift, 600 | **3 çift, 600** | eskiler byte-aynı, sha256 değişmedi |
| `whatsapp_identity_quarantine` (prod) | yok | **yok** (`to_regclass` = NULL) | üretim DB'sine yazılmadı |

**Üretim DB yazımı: 0. Gateway restart/recreate: 0. Sweep: çalışmadı (`runs:0`). Yeni deploy: yok.**

---

## 7. Kurtarma için sonraki adım

9 mesaj artık **iki** bağımsız yerde kimlik bazında kanıtlı: gateway RAM'i ve
`tezlify-ram-20261029T210007Z.rsnap`. Ama **hiçbiri DB'de bir sohbete bağlı değil**; sweep
onları atlar. Gerçek kurtarma için:

1. Bu 9 mesajın ait olduğu LID için **güvenilir bir köprü** gerekiyor. Köprü yoksa
   (`lid_mappings`'te bu `lid_jid` için `phone_jid` boş) hangi kişiye ait olduğu **kanıtlanamaz**.
2. Köprü varsa: `merge_deferred_lid_ghosts` / `whatsapp_lid_split_repair.py` canonical sohbete
   taşır — **üretim yazımı gerektirir, ayrı onay ister**.
3. Köprü yoksa: sohbeti yeniden oluşturup mesajları yerleştirmek **üretim INSERT'i** demektir;
   ayrı onay + doğrulanmış geri dönüş planı olmadan yapılmamalı.

**Kritik kural (uygulandı):** 9 mesajın güvenli biçimde yeniden ilişkilendirilebileceği
kanıtlanmadan DB'ye **hiçbir şey yazılmadı**.

---

## 8. Açık riskler / ayrı onay gerektirenler

1. **`purge_raw_jid_identity_data` hâlâ üretimde eski sürümü çalıştırıyor** (`38fe087`). Bir
   sonraki boot yine silebilir. Düzeltme yalnızca repo'da; **deploy ayrı onay** ister.
2. **Gateway recreate yasağı sürüyor:** 9 mesaj hâlâ yalnızca RAM + snapshot'ta.
3. 9 mesajın kurtarılması (köprü kanıtı + üretim yazımı) — ayrı onay.
4. `test_campaign_runner_pauses_on_daily_limit_reached` flake'i (önceden var, kapsam dışı).
5. `main` push edilmedi (bu aşamada istenmedi); yalnızca geliştirme branch'ine push edilecek.
6. `backups/releases/*/candidate-env` 664 → 600 önerisi (3.8.6'dan devir, P2).

---

## 9. Kabul kriterleri

| Kriter | Durum |
|---|---|
| 9 mesaj RAM'de kimlik bazında kanıtlı | ✅ 9/9, `jid_hash 2453b8a7…` |
| Yeni snapshot'ta kapsanıyor | ✅ COVERED 10 / MISSING 0 |
| Snapshot bütünlüğü | ✅ `ok:true`, 0 integrity/completeness problemi |
| Silme fonksiyonunun tüm çağrı noktaları | ✅ 1 üretim (`main.py:307`) |
| Fail-closed tasarım + 7 senaryo testi | ✅ 78 passed |
| Backend test paketi | ✅ 2052 passed / 4 skipped (sabit sıra) |
| Üretim DB yazımı 0 | ✅ tablo prod'da yok |
| Gateway restart/recreate 0 | ✅ aynı ID + StartedAt |
| Sweep çalışmadı | ✅ `runs:0` |
| Yeni deploy yok | ✅ `.deployed-commit` = `38fe087` |
