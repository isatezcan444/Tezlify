# AŞAMA 4.14 — RELEASE PUSH ÖNCESİ ÜRETİM GÜVENLİK VE UYUMLULUK DENETİMİ

**Tarih:** 2026-10-31 (UTC 09:17–09:30) · **Hedef commit:** `2236caebd4281b108b835f16f4c80d3d2e2f1d05`
**Mod:** salt okunur denetim. Push / fetch / merge / rebase / commit / deploy / restart / DB yazımı / snapshot
üretimi **yapılmadı**.
**Nihai verdict:** **`READY WITH CONDITIONS`** — push için ayrıca **açık kullanıcı onayı** gerekir.

---

## 0. YÖNTEM VE YAPILMAYANLAR

| İşlem | Durum |
| --- | --- |
| `git push` / `pull` / `fetch` / merge / rebase / commit / amend | **YAPILMADI** |
| Remote durumu | `git ls-remote --heads origin` (salt okunur; yerel ref **değişmez**) |
| Üretim DB yazımı | **YAPILMADI** — yalnızca `SELECT` / `information_schema` / `SHOW` |
| Container restart / recreate / deploy scripti | **YAPILMADI** |
| Snapshot üretimi / silme / kopyalama | **YAPILMADI** — yalnızca mevcut dosyaların `sha256sum` + manifest okuması |
| Persistence loop aktivasyonu | **YAPILMADI** |
| Testler production DB üzerinde | **ÇALIŞTIRILMADI** (bkz. §7 — 4.13 kanıtı yeniden kullanıldı) |
| Üretimde çalıştırılan kod | Konteyner içinde `grep` + `node` (loopback HTTP, GET) + `python -` (stdin betik, yalnızca okuma) |

Üretimde çalıştırılan tek "kod" iki salt-okunur sonda oldu: gateway'e loopback `GET` atan bir Node betiği ve
backend `/health` okuyan bir Python betiği. İkisi de stdin'den beslendi (`docker exec -i … node` / `python -`),
konteynere **dosya yazılmadı**.

---

## 1. GIT DURUMU

| Ölçüm | Değer |
| --- | --- |
| `release/backend-only-4.7` HEAD | **`2236caebd4281b108b835f16f4c80d3d2e2f1d05`** |
| Parent | **`17ccbc91843490f7c256b1324e22d11e0a02ac3f`** |
| Commit ağacı | **`4a2c37de85f8c981ef5659299d993a7081cedbbe`** |
| `cbe4f509..2236cae` | **11 dosya, +2038 / −61** |
| `whatsapp-gateway/` farkı | **0 satır** |
| Commit'te `.workbuddy-ai/` veya `docs/` | **yok** (0 dosya) |
| `--points-at 2236cae` | yalnız `refs/heads/release/backend-only-4.7` (tag yok) |
| Worktree | `/private/tmp/tz410-release` → `2236cae [release/backend-only-4.7]`, çalışma ağacı **temiz** |

11 dosya (durum + satır):

```
M  backend/app/main.py                                   |   2 +
M  backend/app/services/whatsapp/memory_persistence.py   | 241 ++++--
M  backend/app/services/whatsapp/orchestration/sync.py   | 144 ++++-
M  backend/app/services/whatsapp_gateway.py              |  11 +
M  backend/tests/test_whatsapp_memory_persistence.py     |   2 +-
M  backend/tests/test_whatsapp_memory_persistence_hardening.py | 8 +-
A  backend/tests/test_whatsapp_message_insert_isolation.py | 253 +++++
A  backend/tests/test_whatsapp_pagination_contract.py    | 545 ++++++++++
A  scripts/pg_audit_tests/test_tz44_missing.py           | 415 ++++++++
A  scripts/pg_audit_tests/test_tz46_audit.py             | 440 ++++++++
A  scripts/pg_audit_tests/tz44_pgplugin.py               |  38 ++
```

Worktree envanteri (5 adet): ana ağaç `7afb540 [main]`, `/tmp/tz410-base` (`cbe4f50`, detached),
`/tmp/tz410-release` (`2236cae`), `/tmp/tz411-candB` (`17ccbc9`, detached), kilo worktree-pool (`4465e3b`).
**Ana kullanıcı çalışma ağacına dokunulmadı**; branch pointer'ı elle oynatılmadı.

---

## 2. REMOTE BRANCH KARŞILAŞTIRMASI

`git ls-remote --heads origin` (fetch **yapılmadı**, yerel ref değişmedi):

| Remote ref | SHA | Yerel karşılık |
| --- | --- | --- |
| `refs/heads/main` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` | `origin/main` = `7afb540` ✓ |
| `refs/heads/release/backend-only-3.7` | `21346e3` | aynı ✓ |
| `refs/heads/release/backend-only-3.8.1` | `68ca413` | aynı ✓ |
| `refs/heads/release/backend-only-3.8.4` | `3d3fc79` | aynı ✓ |
| `refs/heads/release/backend-only-3.8.5` | `38fe087` | aynı ✓ |
| `refs/heads/release/backend-only-3.8.7` | `cbe4f509` | aynı ✓ |
| `refs/heads/release/backend-only-4.7` | **YOK** | yerelde var |
| `feat/3.8.7-identity-quarantine` | `a1ca60f` | — |
| `backup-before-revert-899f32f` | `899f32f` | — |

**Sonuç: geride/ileride olma durumu yok — remote'da karşılık hiç yok.** İlk push bir *branch creation*
olacak; fast-forward/force tartışması doğmayacak. Önceki beş release branch'inin hepsi remote'da yereliyle
**birebir aynı** ⇒ "release branch'leri push edilir" konvansiyonu tutarlı; 4.7 tek istisna.

`origin/main` ile ilişki: `rev-list --left-right --count origin/main...2236cae` = **32 / 3**.
3 commit (`cbe4f509`, `17ccbc9`, `2236cae`) main'de yok; `2236cae` **main'in atası değil**. Bu, backend-only
release kesme yönteminin normal sonucudur — soy değil **blob** karşılaştırılır. `origin/main` ve diğer
release branch'lerine dokunulmadı.

---

## 3. P0-1 — FRONT-TRIM VE GATEWAY UYUMLULUĞU

### 3.1 Yayındaki gateway `afterSeq` okuyor mu? — **HAYIR (kaynak + canlı kanıt)**

Konteyner içindeki gerçek kaynak (`docker exec tezlify-gateway`):

```
grep -c afterSeq   /app/src/index.js          → 0
grep -c seqEpoch   /app/src/session-manager.js → 0
/app/src/index.js:564:  const { limit, offset, since, perChatLimit, jids } = req.query;
/app/src/session-manager.js:1156: listAllMessages(sessionId, { limit = 1000, offset = 0,
                                     since = null, perChatLimit = null, jids = null } = {})
```

`git show cbe4f509:whatsapp-gateway/src/index.js` aynı satırı (563) aynı içerikle veriyor ⇒ konteynerdeki
kod, dağıtılan commit'in kodu.

Canlı sonda (`/sessions/1bd78836-…/messages/bulk`, loopback, salt okunur):

| İstek | HTTP | `total` | İlk `wa_message_id` | Yanıt anahtarları | `pagination` |
| --- | --- | --- | --- | --- | --- |
| `?limit=1` | 200 | 9163 | `3A919D7140AAB7FC5EF7` | `limit, messages, offset, total` | **yok** |
| `?limit=1&afterSeq=1&seqEpoch=probe` | 200 | 9163 | `3A919D7140AAB7FC5EF7` | `limit, messages, offset, total` | **yok** |

İki yanıt **birebir aynı** ⇒ parametre yok sayılıyor (`after_seq_ignored = true`). Ayrıca mesaj yükünde
`_seq`/`seq` alanı **yok** (`sample_has_seq = false`) ⇒ yayındaki gateway'de değer-tabanlı imleç **hiç
üretilmiyor**.

### 3.2 Backend'in fallback davranışı — sessiz ve güvenli, ama **düzeltme değil**

`backend/app/services/whatsapp/memory_persistence.py` (`2236cae`), satır 434–451:

```python
reported_mode = str(page.get("pagination") or "")      # yayındaki gateway: "" (anahtar yok)
if reported_mode == "seq":
    ...
else:
    if mode == "seq":
        mode = "offset"            # sessiz düşüş
        offset = int(start_offset or 0)   # imleç SIFIRLANMAZ (bilinçli)
```

- Hata üretilmez, istisna atılmaz, tur düşmez ⇒ **silent-safe**.
- İlk sayfa `after_seq` ile istenir; yayındaki gateway onu yok sayıp offset-0 sayfasını döndürdüğü için fazladan
  istek de doğmaz.
- Ancak `mode="offset"` **eski kayma riskini aynen korur**: liste başından eviction olduğunda `offset` sabit
  kalır ve hiç görülmemiş kayıtlar kalıcı olarak atlanır.

### 3.3 Backend-only 4.7 front-trim'i çözüyor mu? — **HAYIR**

Release'in kendi sözleşme testi bunu açıkça yazıyor
(`backend/tests/test_whatsapp_pagination_contract.py`):

- `test_front_trim_skips_messages_in_offset_mode` (C6) — offset modunda **atlıyor**.
- `test_front_trim_does_not_skip_messages_in_seq_mode` — yalnızca seq modunda atlamıyor.
- `test_legacy_gateway_without_pagination_falls_back_to_offset` (C2) — `LegacyGateway` sınıfı **`cbe4f509`
  davranışını** modelliyor.

Yani test dosyası P0-1'in kapandığını değil, **kapalı olmadığını** kanıtlıyor. Bu testler gerçek bir gateway'e
hiç bağlanmıyor (`SeqGateway` / `LegacyGateway` sahte sınıfları), bu yüzden "yeni gateway var" varsayımını
doğrulayamazlar — yalnızca backend'in iki sözleşmeye de doğru tepki verdiğini gösterirler.

### 3.4 **KRİTİK BULGU — P0-1'in gateway yarısı hiçbir commit'te yok**

`main` çalışma ağacında gateway'de `afterSeq`/`seqEpoch`/`_seq` kodu **var**, ama:

```
git log --all --oneline -S'afterSeq' -- whatsapp-gateway/src/session-manager.js   → (boş)
git show HEAD:whatsapp-gateway/src/session-manager.js | grep -c afterSeq          → 0
git show HEAD:whatsapp-gateway/src/index.js          | grep -c afterSeq          → 0
git status --short whatsapp-gateway/
 M whatsapp-gateway/package.json
 M whatsapp-gateway/src/index.js
 M whatsapp-gateway/src/messages/message-store.js
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js
?? whatsapp-gateway/scripts/test-bulk-seq-pagination.mjs
git diff --stat -- whatsapp-gateway/  →  5 dosya, +448 / −22
```

Kod yalnızca **commit edilmemiş çalışma ağacı değişikliği** olarak duruyor. Sonuçları:

1. `host-release.sh` hedef ref'in **ağacından** build ettiği için bu kod **hiçbir deploy ile üretime gidemez** —
   yalnızca backend-only 4.7 değil, `main`'den yapılacak **tam** bir deploy da afterSeq'i taşımaz.
2. "Gateway ve backend birlikte yükseltilmeli" ifadesi doğru ama **eksik**: önce gateway yarısının
   *versiyonlanması* gerekiyor. Bugün o adım hiçbir ref'te mevcut değil.
3. Release'in `test_whatsapp_pagination_contract.py` dosyası, hiçbir commit'te bulunmayan bir gateway
   sözleşmesini doğruluyor ⇒ yeşil olması P0-1'in kapandığı anlamına **gelmez**.

### 3.5 Soy karşılaştırma tuzağı (kayda değer)

`git log cbe4f509..origin/main -- whatsapp-gateway/` **boş** dönerken `git diff cbe4f509 origin/main --
whatsapp-gateway/` **8 dosya / +604 / −13** veriyor. Sebep: `b5f7605`, `9754143`, `0d909ab` `cbe4f509`'un
**atası** (üçü de `merge-base --is-ancestor` ile YES), ama `cbe4f509`'un ağacında gateway dizini geri
alınmış. Yani "log boş ⇒ gateway farkı yok" çıkarımı **yanlıştır**; fark yalnızca blob karşılaştırmasında
görünür.

**Sınıflandırma: P0-1 = BLOCKER** (deploy kapsamı için). Commit'e değil, *dağıtım iddiasına* engeldir: 4.7
push edilebilir, ancak "front-trim kapandı" gerekçesiyle deploy edilemez.

---

## 4. RAM / DB RECONCILIATION (salt okunur, canlı)

Ölçüm: gateway API'si tam tarandı (`limit=1000`, `perChatLimit=1000000`, 10 sayfa, 9163 benzersiz kimlik) ve
DB'nin tüm `wa_message_id` kümesiyle kimlik farkı alındı.

| Metrik | Değer |
| --- | --- |
| Gateway RAM (API görünür toplam) | **9163** |
| RAM benzersiz kimlik | **9163** (sayfa sınırı yok, kesme yok) |
| DB `messages` | **9246** |
| Kesişim | 9163 |
| **RAM_ONLY** | **0** |
| **DB_ONLY** | **83** |
| Aritmetik kontrol | `db−ram = 83` = `dbOnly−ramOnly = 83` ✓ |

**DB_ONLY = 83 tam olarak tavana bağlı ve kapanıyor:**

| conversation_id | DB mesaj | 2000 tavanı üstü |
| --- | --- | --- |
| 38289 | 2051 | 51 |
| 38291 | 2032 | 32 |
| **toplam** | | **83** |

### 4.1 Tavan uyarısı — 9163 "RAM'deki tüm mesajlar" DEĞİLDİR

Snapshot manifestinden sohbet dağılımı (`chats[].collected`): 100 sohbet, **max = 2000**, min = 1,
**tam 2000'de 2 sohbet**, `shortfall_total = 0`, `unstable = 0`. Yani gateway **2000 mesaj/sohbet** tavanıyla
kırpılıyor. Bu yüzden:

- 9163 sayısı **tavan altında ölçülmüş** bir sayıdır; mutlak RAM büyüklüğü olarak alıntılanamaz.
- `RAM_ONLY = 0` sonucu, **tavan içinde görünen küme** için geçerlidir ve bu kümede doğrudur.
- Tavanın ötesindeki kuyruk RAM'de **yok**; dolayısıyla bir recreate onu "kaybetmez" — ama DB'de de yoksa
  daha önce kaybedilmiş demektir. Bu, recreate riski değil, önceden var olan kapsam sınırıdır.

### 4.2 Recreate riski açısından okunuşu

`RAM_ONLY = 0` ⇒ **gateway RAM'inde DB'de karşılığı olmayan tek bir mesaj yok.** 2026-10-30'daki 6960
"RAM-only" tablosunun aksine, bu nesilde RAM artık mesajların tek kopyası değil. Bu, mesaj verisi açısından
gateway recreate riskini **niteliksel olarak düşürür** — ancak aşağıdaki iki sınırla:

1. Ölçüm anı ile recreate anı arasındaki trafik kapsanmaz (60 dakikada 38 yeni satır) ⇒ recreate öncesi
   **taze, uzaktan doğrulanmış** snapshot zorunlu.
2. Bu, yalnızca **mesaj** kümesi için kanıtlanmıştır; gateway'in app-state/contact koleksiyonları bu ölçümün
   dışındadır.

### 4.3 Diğer canlı metrikler

| Metrik | Değer |
| --- | --- |
| Gateway oturumları | **1 toplam / 1 bağlı / 0 pending_qr**, `orphaned_sessions=0`, `auto_restore=true` |
| Canlı hat | `1bd78836-c084-4cbf-b333-9386d44b7bd7` |
| `whatsapp_sessions` / `whatsapp_private.gateway_sessions` | 1 / 20 (20 tarihsel gateway kimliği) |
| `whatsapp_private.lid_mappings` | **4320** (canlı oturum 217; iki eski oturum 216+216) |
| DB boyutu | 76 MB · host disk 51 GB boş |
| Gateway/backend container | `restarts=0`, ikisi de healthy (gateway 2026-10-27'den, backend 2026-10-29'dan) |

---

## 5. DB BÜTÜNLÜĞÜ (salt okunur)

| Kontrol | Sonuç |
| --- | --- |
| `(conversation_id, wa_message_id)` çift kopya | **0** |
| `wa_message_id IS NULL` | **0** |
| Yetim mesaj (conversation satırı yok) | **0** |
| Mesajsız sohbet | 26 (yapısal, bozulma değil) |
| `contacts.phone_e164 LIKE 'jid:%@lid'` (hayalet LID) | **1** |
| `whatsapp_identity_quarantine` satırı | **0** |
| `processed_events` / `outbox` | **TABLO YOK** (`to_regclass` → NULL) |
| Bağlantı havuzu | 5 / 100 (`active=1, idle=4`); backend 3, gateway 1, yerel psql 1 |
| `messages.created_at` tipi | `timestamp without time zone` |

**İki not, ikisi de yanlış okumaya açık:**

1. `processed_events` ve `outbox` bu şemada **hiç yok**. "0 satır" değil, "tablo yok" — raporda "temiz"
   diye yazılamaz; ilgili bütünlük iddiası **N/A**.
2. 1 hayalet LID kontağı var, karantina defteri boş. Bu bir tutarsızlık değil: süpürme **boot'ta** çalışır,
   backend 2026-10-29'da açıldı ve o tarihten sonra doğan satır taranmadı. Sıradaki boot'ta 3.8.7 davranışı
   gereği **silinmeyecek**, `whatsapp_identity_quarantine`'e `bridge_unknown_has_messages` olarak yazılacak.
   Yani deploy bu satırı **korumalı** biçimde ele alacak; veri kaybı beklenmiyor.

`messages.created_at`'in naive olması, 4.11'de v1 test dosyasının PG'de 2/5 kırmasına yol açan mekanizmanın
hâlâ yerinde olduğunu doğrular (v2 `ec7fed85…` bu yüzden zorunluydu).

---

## 6. SNAPSHOT DOĞRULAMASI

### 6.1 Adı geçen snapshot — `tezlify-ram-20261031T070158Z`

| Alan | Değer |
| --- | --- |
| Varlık | `/var/backups/tezlify-ram/…070158Z.rsnap` (7.216.260 B) + `.manifest.json` (16.956 B) |
| `.rsnap` SHA256 (host'ta yeniden hesaplandı) | **`fa01aa3ba9e8ecdb83d77edb1a6af9ec482ef57f7d8cba53a12a0fa8de049bdf`** |
| `snapshot.jsonl`'daki `rsnap_sha256` | **aynı** ✓ |
| Manifest SHA256 | `7ebff873aebbf0e0d3cbf175ee33de2c91a6b48af38c1bf1592ef412a9489d10` |
| `record_count` / `chat_count` | **9163** / **100** |
| `records_sha256` | `139a8a18a81574259e645acfba22268f62a5d23a374c424e28a8cbf8478d8680` |
| `identity_root_sha256` | `51b322a302418e7e7901f0625bdada75c784b0ca57b0aadfb4a4796167cd6225` |
| `duplicates_removed` / `rejected_*` / `late_arrival_count` | 0 / 0 / 0 / 0 |
| `source_container_id` | `ce2e901b6619` |
| `remote_verified` | **true** |
| `upload_status` / `status` / `exit_code` | **UPLOADED** / OK / 0 |
| Süre | 13,1 s |

**İki tuzak, ikisi de bu dosyada canlı doğrulandı:**

1. **`remote_verified` manifestte YOK.** `grep -E "remote_verified|offsite|uploaded"` manifestte **hiçbir şey**
   bulmaz. Doğruluk kaynağı `/var/backups/tezlify-ram/snapshot.jsonl` (her tur için tek JSON satırı). Manifesti
   tarayıp "uzaktan doğrulanmamış" demek yanlış olur.
2. **`source_container_id` gateway'i değil, backend'i gösterir.** `ce2e901b6619` = **backend** konteynerinin
   kimliği (canlı backend `ce2e901b6619636afe…` ile eşleşiyor). Snapshot backend konteynerinden çalıştırılıp
   gateway'e HTTP ile gidiyor; alan "hangi gateway" sorusunu yanıtlamaz. Canlı gateway kimliği ayrı:
   `5b867095d376…` (`restarts=0`, 2026-10-27'den beri aynı süreç).

### 6.2 Snapshot güncel mi? — Hayır, ve zaten daha yenileri var

Saatlik timer **kurulu ve çalışıyor** (`tezlify-ram-snapshot.timer`, son çalışma 09:00:40Z, sıradaki
10:01:05Z). Dizin: **32 `.rsnap` + 32 manifest** (+ `.key-escrow`, `.key-escrow-v2`, `.snapshot.lock`,
`snapshot.jsonl`, `.incoming/`), toplam **221 MB**; en eskisi `2026-10-29T125657Z`. En yenisi:

| Snapshot | `.rsnap` SHA256 | Kayıt | `remote_verified` | `upload_status` |
| --- | --- | --- | --- | --- |
| `…T090040Z` (09:00:40Z, **18 dk önce**) | `7a9ff7e35ea54db4d081463e7a3ef233160623429d3ec362ff2562f36fd19c41` | 9163 | **true** | UPLOADED |
| `…T080048Z` | `02fd1ab3d62eddac2b797f4fa91807426a3fb20b3f7c79b0f4c87c49765fa8fc` | 9163 | true | UPLOADED |
| `…T070158Z` (adı geçen) | `fa01aa3b…` | 9163 | true | UPLOADED |

Adı geçen 07:01 snapshot'ı **2 saat geride**; yalnızca geçmiş kanıt olarak değerlendirildi. **Bu aşamada yeni
snapshot üretilmedi, dosya kopyalanmadı.** Snapshot'lar da 2000/sohbet tavanıyla sınırlıdır — tavandan fazlası
snapshot'tan da geri getirilemez.

**Kural (rapora yazılması zorunlu):** gateway recreate gerektiren **her** plan, recreate'ten hemen önce
**yeni** ve `remote_verified=true` bir snapshot zorunlu kılar. Mevcut en taze snapshot 18 dakikalık; recreate
kararı o snapshot'ın yaşıyla verilemez.

---

## 7. PERSISTENCE LOOP VE DB GÜVENLİĞİ

| Kanıt | Değer |
| --- | --- |
| `WHATSAPP_MEMORY_PERSIST_ENABLED` (konteyner env) | **tanımsız** |
| `docker-compose.prod.yml` içinde bildirim | **yok** |
| Kod varsayılanı (`config.py:211`, hem `cbe4f509` hem `2236cae`) | `False` |
| Doğrulayıcı | `_memory_persist_fail_closed` — yalnızca `true`/`1` açar, çözülemeyen değer **KAPALI** |
| `/health.whatsapp_memory_persistence` | `enabled: null`, `runs: **0**`, `inserted_total: 0`, `config_enabled: **false**`, `task_running: **false**`, `cursor_count: 0`, `errors_total: 0` |

**Loop etkin değil — üç bağımsız kanıtla:** (a) env'de yok, (b) compose'da yok, (c) canlı `/health`
`config_enabled=false` + `task_running=false` + `runs=0`. Yani hiç çalışmamış, çalışmıyor ve env değişikliği +
restart olmadan çalışamaz. **Aktivasyon yapılmadı.**

**Dolaylı ama önemli sonuç:** `RAM_ONLY = 0` bu loop'un ürünü **değil** (runs=0). Mesajlar canlı ingest
yolundan senkron yazılıyor; RAM artık önbellek konumunda. Bu, "RAM tek kopya" döneminin bu nesilde kapandığını
gösterir — ama loop kapalıyken ingest yolundaki herhangi bir arıza bu dengeyi sessizce bozabilir.

Diğer sağlık göstergeleri: `whatsapp_identity_sweep` 142 tur / 0 hata / `pending_at_least=0`;
`whatsapp_data_audit` `table_ready=true`; `gateway_bridge.connected=true`, son olay 09:18:44Z (canlı trafik).

---

## 8. ROLLBACK DENETİMİ (yalnızca analiz — komutlar çalıştırılmadı)

### A. Genel `--rollback-to <TS>` — **RAM kaybı riski: YÜKSEK, bu ortamda faydası: SIFIR**

`scripts/deploy/host-release.sh` (dağıtılan sürüm `cbe4f509`, blob `f2b7a9ae…`), satır 83–99:

```bash
docker tag "tezlify-backend:pre-$REL" tezlify-backend:latest
docker tag "tezlify-gateway:pre-$REL"  tezlify-gateway:latest
...
docker compose -f "$COMPOSE_FILE" up -d backend gateway     # ← İKİ servis de recreate
```

- Backend **ve** gateway birlikte recreate edilir ⇒ gateway RAM store'u sıfırlanır, WhatsApp hattı
  `auto_restore=true` ile yeniden bağlanır (QR yok), WS bridge yeniden kurulur.
- **Ölçülen ve kritik olan:** `tezlify-gateway:pre-20261029T214629Z` = `sha256:a1ba2572…` = **canlı gateway
  imajının aynısı**. Yani bu etiketle yapılacak bir rollback, gateway'i **aynı imajla** yeniden yaratır:
  kazanç sıfır, RAM kaybı gerçek. `release.json` bunu zaten söylüyor: `gateway_touched: false`.
- `pre-<TS>` etiketleri **her iki imaj için koşulsuz** üretilir (`:739-740`), `--no-gateway` altında bile ⇒
  "gateway pre-tag var" olgusu gateway'e dokunulduğunu **kanıtlamaz**. Tek yetkili alan
  `release.json.gateway_touched`.

### B. Backend-only rollback — **uygulanabilir, gateway'e dokunmaz**

```bash
docker tag tezlify-backend:pre-20261029T214629Z tezlify-backend:latest
docker compose -f docker-compose.prod.yml up -d --no-deps backend
```

- Hedef gerçek: `tezlify-backend:pre-20261029T214629Z` = `sha256:a5c35492…` ≠ canlı backend
  `sha256:06ce4fe1…` ✓ (yani etiket boşa değil).
- `--no-deps` yalnızca backend'i yeniden yaratır; gateway konteyneri ve RAM store'u **korunur**.
- Beklenen yan etki: WS bridge kopar/yeniden bağlanır (`reconnect_count` artar), kısa bir mesaj akışı kesintisi.
- Risk: imaj rollback'i **veri rollback'i değildir**; yeni backend'in yazdığı satırlar geri alınmaz ve şema
  değişmişse eski imaj yeni şemayla çalışmak zorunda kalır.

**Öneri:** 4.7 deploy'u backend-only olacağı için geri dönüş yolu da **yalnızca B** olmalı. A yolu bu
ortamda gateway'e hiçbir şey kazandırmadan RAM'i riske atar.

---

## 9. TEST VE COMMIT KANITI (yeniden çalıştırılmadı)

Commit içeriği 4.13'ten bu yana değişmedi (`2236cae` ağacı `4a2c37de…` sabit, çalışma ağacı temiz), bu yüzden
4.13 kanıtı **commit SHA'sına bağlanarak** kullanıldı:

| Kapı | Sonuç | Bağlı SHA |
| --- | --- | --- |
| PostgreSQL 17.11 (birleşik) | **57 passed** | `2236cae` |
| Backend suite | 2070 toplandı → **2065 passed / 1 failed / 4 skipped** | `2236cae` |
| Bilinen kırmızı | `test_admin_ops_security.py::…http_probe…` — **baseline'da da kırmızı** (test defekti; `_http_probe` `cbe4f509`'da birebir aynı) | `cbe4f509` |
| `compileall` | exit 0 | `2236cae` |
| Import kontrolü | 5/5 | `2236cae` |
| Gateway byte identity | **5/5 IDENTICAL** | `cbe4f509` ↔ `2236cae` |
| Release guard (self) | **exit 0** (gateway 0, vs main 0, vs base 8) | `2236cae` |
| Release guard (`main`) | exit 1 (vs main 10) | — |

Kaynak: `docs/audits/ASAMA-4.13-approved-commit-verification.md` (§13 bölümü, verdict
`COMMIT CREATED — POST-COMMIT VERIFICATION PASS`).

---

## 10. AÇIK RİSKLER — SINIFLANDIRMA

| # | Risk | Sınıf | Kanıt / gerekçe |
| --- | --- | --- | --- |
| R1 | **P0-1 front-trim açık.** Yayındaki gateway `afterSeq`'i yok sayıyor; backend sessizce offset moduna düşüyor, eviction kayması sürüyor. | **BLOCKER** (deploy kapsamı) | §3.1 canlı sonda (`after_seq_ignored=true`), §3.2 fallback, §3.3 C6 testi |
| R2 | **P0-1'in gateway yarısı hiçbir commit'te yok** — yalnız çalışma ağacında (+448/−22, 1 untracked test). Hiçbir ref'ten deploy edilemez. | **BLOCKER** (P0-1'i kapatma planı için) | §3.4 `git log --all -S'afterSeq'` boş, `HEAD:` sayımı 0 |
| R3 | Gateway recreate, RAM store'unu sıfırlar; snapshot yaşı recreate kararına yetmez (en taze 18 dk, adı geçen 2 sa). | **HIGH** | §6.2, §8A |
| R4 | `--rollback-to` gateway'i **aynı imajla** recreate eder (pre-tag == live) ⇒ faydasız RAM kaybı. | **HIGH** | §8A imaj kimlikleri |
| R5 | RAM sayısı 2000/sohbet tavanıyla kırpılıyor; 9163 "tüm RAM" sanılırsa hem reconciliation hem snapshot kapsamı yanlış okunur. | **MEDIUM** | §4.1 `max=2000`, 2 sohbet tavanda |
| R6 | 1 hayalet LID kontağı + boş karantina defteri; sıradaki boot'ta karantinaya yazılacak (silme değil). | **LOW** | §5 |
| R7 | `processed_events` / `outbox` tabloları yok ⇒ bu iki bütünlük iddiası **doğrulanamaz**, "temiz" sayılamaz. | **LOW** (kapsam boşluğu) | §5 `to_regclass` → NULL |
| R8 | Baseline'da kırmızı `http_probe` testi suite'i 1 kırmızıyla bırakıyor; yeni bir kırmızıyı maskeleyebilir. | **LOW** | §9 |
| R9 | Branch remote'da yok; push ilk kez olacak, önceki release branch'lerinden farklı olarak **uzak yedek yok**. | **LOW** | §2 |
| R10 | Release branch `origin/main`'in 32 commit gerisinde; ileride merge edilirse çakışma yüzeyi büyük. | **LOW** | §2 |
| R11 | Commit içeriği (11 dosya, +2038/−61), gateway farkı 0, memory/docs dışlanmış, ağaç `4a2c37de…` doğrulandı. | **CLOSED** | §1 |
| R12 | RAM_ONLY = 0 — RAM'de DB'de olmayan mesaj yok. | **CLOSED** (kapsam: mesajlar, tavan içi) | §4 |
| R13 | Persistence loop kapalı ve hiç çalışmamış. | **CLOSED** | §7 |
| R14 | DB bütünlüğü: çift kopya 0, NULL kimlik 0, yetim 0. | **CLOSED** | §5 |
| R15 | Mevcut snapshot'lar `remote_verified=true`, SHA256 yeniden hesaplanarak doğrulandı. | **CLOSED** | §6.1 |
| R16 | Snapshot dizininde **retention yok**: 2 günde 32 çift / 221 MB birikti (~7,2 MB/saat ≈ 173 MB/gün). Disk 51 GB boş ⇒ ~300 gün; acil değil. | **LOW** | §6.2 |

---

## 11. PUSH ÖNCESİ GEREKLİ İŞLEMLER

1. **Push ayrı onay ister.** Bu aşama yalnızca rapor üretti; `git push` çalıştırılmadı.
2. Push edilecek tam komut (onay sonrası, tek seferlik branch creation):
   `git push -u origin release/backend-only-4.7` — remote'da karşılık yok, force gerekmez.
3. **Deploy, push'tan bağımsız bir karardır** ve bugün P0-1 gerekçesiyle yapılamaz (R1, R2).
4. Deploy planlanırsa sırasıyla: (a) gateway yarısını **commit'le**, (b) backend-only ref'i yeniden kes,
   (c) `backend_only_release.py --base cbe4f509 --target <ref>` exit 0, (d) `--no-gateway` ile ilerle,
   (e) herhangi bir recreate'ten önce **taze + `remote_verified`** snapshot.
5. Push sonrası ilk iş: `git ls-remote --heads origin | grep backend-only-4.7` ile SHA eşleşmesini doğrula.
6. Bellek dosyaları (`MEMORY.md`, `2026-10-30.md`, `2026-10-31.md`) hâlâ tracked ve dirty — **commit'e dahil
   edilmedi**; `git add -A` kullanılmamalı.

---

## 12. NİHAİ VERDICT

```
READY WITH CONDITIONS
```

**Gerekçe:** Commit'in kendisi push için güvenli — 11 dosya sabit, gateway farkı 0, ağaç `4a2c37de…`
doğrulanmış, memory/docs dışlanmış, remote'da çakışma yok, test kanıtı commit SHA'sına bağlı. Ancak iki
koşul bağlayıcıdır:

- **C1 — P0-1 kapanmış sayılamaz.** Yayındaki gateway `afterSeq`'i yok sayıyor (canlı kanıt: aynı yanıt);
  4.7 yalnızca sessiz-safe fallback sağlar. Deploy, "front-trim çözüldü" gerekçesiyle yapılamaz.
- **C2 — P0-1'in gateway yarısı versiyonlanmamış.** `git log --all -S'afterSeq'` boş; kod yalnızca commit
  edilmemiş çalışma ağacında. Hiçbir ref'ten deploy edilemez; önce commit edilmelidir.

**Üretim durumu: `NOT AUTHORIZED — NO PUSH / NO DEPLOY`.** Push ve deploy için kullanıcıdan açık onay
gerekiyor. Bu aşamada üretim sistemi değiştirilmedi.
