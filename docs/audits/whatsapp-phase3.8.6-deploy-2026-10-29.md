# AŞAMA 3.8.6 — KONTROLLÜ BACKEND-ONLY DEPLOY VE KAPALI KALICILIK DOĞRULAMASI

**Tarih:** 2026-10-29 (18:33–18:40Z)
**Tür:** Üretim deploy'u (backend-only). Gateway/Caddy/DB yeniden oluşturulmadı, sweep çalışmadı,
RAM yedeği değişmedi, `main` push edilmedi.
**Sonuç:** **DEPLOY YAPILDI** — `38fe087` yayında, kalıcılık kanıtlanmış biçimde KAPALI.
**Ancak temiz bir başarı değil:** deploy'un tetiklediği *mevcut* startup migration'ı üretimde
**1 hayalet sohbet + 9 mesaj** sildi (§8). Bu, release'in getirdiği kod değil, 3.8.5'te de aynı
olan `purge_raw_jid_identity_data`'dır.

---

## 1. Başlangıç / bitiş SHA'ları

| | Başlangıç | Bitiş |
|---|---|---|
| `main` (yerel) | `2a74b3a053563d94bfec72c762cac386f04a120a` | **aynı** (commit yok) |
| `origin/main` | `848c1722ea11bbe306a89e0d561673aed463cca5` | **aynı — push edilmedi** |
| `release/backend-only-3.8.5` | `38fe0879ed05da4a0944eb9f98f57a8fa20de431` | **aynı** (yerel+uzak) |
| `.deployed-commit` | `b5715fe90d0ff05ef497dcccbc87652efa10ccd1` | **`38fe0879ed05da4a0944eb9f98f57a8fa20de431`** |
| `/opt/tezlify` HEAD | `b5715fe` | **`38fe087`** (dirty=0) |
| Çalışma ağacı (yerel) | temiz | temiz |

---

## 2. Çalıştırılan komut ve betik kimliği

Sunucuda `/opt/tezlify` **b5715fe**'deyken `run_release.sh` yoktur; bu yüzden başlatıcı hedef
commit'ten çıkarıldı ve kendini pinledi (bootstrap, 3.8.5 §"bootstrap dürüstlüğü"):

```
git show 38fe0879ed05:scripts/deploy/run_release.sh > /tmp/rr385.sh   # blob 9284245fa56c…
HOST_RELEASE_REPO=/opt/tezlify bash /tmp/rr385.sh \
  --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
  38fe0879ed05 --no-gateway --health-timeout 180
```

| Nesne | Blob |
|---|---|
| `run_release.sh` (başlatıcı, `--expected-self-blob` ile pinlenen) | `9284245fa56c8e66c881aa8a0e9b6fd430e391c8` |
| `host-release.sh` (hedef commit'ten çıkarılan, çalışan) | `f2b7a9aeb5c46247bae73dfc226d8a83dfeea587` |
| Yayındaki eski `host-release.sh` (b5715fe) | `69da7b3c2e962fffcd420e6f49706baf378a174c` |
| `script_version_guard.py` | `a90805a38f1cceb939e27415c1aeae2757cc9260` |
| `persistence_flag_guard.py` | `b69dd6a8f8a032d57d5886d37bbcf9b48c2459b0` |

**Pin'in kime ait olduğu (netleştirme):** `--expected-self-blob 9284245…` **başlatıcının kendi**
blob'udur, `host-release.sh`'in değil. `host-release.sh` ayrıca doğrulanır: başlatıcı onu hedef
commit'ten çıkarır, blob'unu `git rev-parse 38fe087:…` ile karşılaştırır ve `HOST_RELEASE_EXPECTED_BLOB`
ile alt sürece devreder. Kanıt (üretimde, hiçbir şey çalıştırmadan):

| Durum | Sonuç |
|---|---|
| doğru pin + `--verify-only` | **exit 0** — `script-version-guard: IZINLI (script_matches_target) self=f2b7a9ae target=f2b7a9ae` |
| **yanlış pin** + `--verify-only` | **exit 9** — `baslatici pinlenen surum degil` |

---

## 3. Release preflight (yeniden çalıştırıldı)

```
base            : b5715fe90d0f (b5715fe)
target          : 38fe0879ed05 (release/backend-only-3.8.5)
gateway/compose : 0 dosya degismis (0 olmali)
backend vs main : 0 dosya farkli (0 olmali)
backend vs base : 15 dosya degismis (>0 olmali)
SONUC: GUVENLI                                    PREFLIGHT_EXIT=0
```

Alt-ağaç kimlikleri: gateway `339aa79` = `b5715fe:whatsapp-gateway` ile birebir; backend `0b251c6` =
`main:backend` ile birebir.

**Migration dosyası yok:** `b5715fe..38fe087` aralığında `*.sql` / `alembic` / `migration` dosyası
**0**. `backend/Dockerfile` → `CMD python3 start.py`; `start.py` içinde `alembic` referansı **yok**.
Yani deploy şema migration'ı çalıştırmaz — ama **startup'ta koşan uygulama-içi migration'lar** vardır
(§8'deki olayın kaynağı budur; bu, deploy öncesi doğrulamada gözden kaçan noktadır).

---

## 4. Deploy sonucu

`DEPLOY_EXIT=0`, 1 dk 44 sn.

| Adım | Sonuç |
|---|---|
| yeni backend imajı | `sha256:a5c3549296b9…` |
| gateway imajı | `sha256:a1ba2572c409…` — **DOKUNULMADI** |
| adacık env | canlıdan kopyalandı (36 değişken) |
| adacık DB | `tezlify_cand_20261029T183544Z` (41 tablo, `tezlify` kopyası), sonra **düşürüldü** |
| adacık kill-switch | `persistence-flag-guard: IZINLI (flag_explicitly_false)` |
| adacık sağlık | SAĞLIKLI |
| cutover servisleri | **`backend`** (yalnızca) |
| cutover sonrası etkin flag | `false` (`/health`) |
| imaj kimliği | backend yeni, **gateway DEĞİŞMEDİ** |
| şema parmak izi | `82e6003b1b9f` — **değişmedi** |
| `.deployed-commit` | `38fe0879ed05da4a0944eb9f98f57a8fa20de431` |

**Aday container'a bayrak AÇIKÇA aktarıldı (kanıt):** env dosyasındaki flag satırı silinip
`WHATSAPP_MEMORY_PERSIST_ENABLED=false` olarak yeniden yazıldı, `--require-explicit-false` ile
doğrulandı, ayrıca `docker run … -e WHATSAPP_MEMORY_PERSIST_ENABLED=false` verildi. Adacık env
dosyasında anahtar **mevcut ve set** (`WHATSAPP_MEMORY_PERSIST_ENABLED=<set>`).

---

## 5. Kalıcılık bayrağı — üç ayrı ölçüm

| Kaynak | Değer |
|---|---|
| `config.py` varsayılanı | `False` |
| `.env.production` | anahtar **YOK** |
| Çalışan container env | anahtar **YOK** |
| `/health.whatsapp_memory_persistence.config_enabled` | **`false`** |
| `/health…task_running` / `runs` / `inserted_total` | `false` / `0` / `0` |
| Startup logu | `[MEMORY-PERSIST] kapalı (flag yok veya false; fail-closed)` — **tek satır** |

**Dürüstlük notu:** §4.4 "gerçek container env'inde `=false`" harfiyen **karşılanmadı** — değişken
orada *yok*, `false` yazılı değil. Etkin değer `false`'tur ve bu, çalışan sürecin kendi `/health`
çıktısıyla kanıtlanmıştır (fail-closed varsayılan). Açıkça yazmak `.env.production` düzenlemesi +
ikinci bir backend recreate gerektirir; bu aşamada yapılmadı (ayrı onay).

---

## 6. Dört container — önce/sonra

| Container | ID (önce → sonra) | `StartedAt` | `RestartCount` | Yorum |
|---|---|---|---|---|
| backend | `579085f13268` → **`3f6a66f68bc8`** | `2026-10-27T22:25:45Z` → **`2026-10-29T18:37:12Z`** | `0` → `0` | **beklenen tek değişiklik** (deploy) |
| gateway | `5b867095d376` → **aynı** | `2026-10-27T17:25:57Z` → **aynı** | `0` → `0` | dokunulmadı |
| db | `f6d79c4a1f8b` → **aynı** | `2026-10-01T17:45:08Z` → **aynı** | `0` → `0` | dokunulmadı |
| caddy | `ee66a5cab371` → **aynı** | `2026-10-12T13:12:45Z` → **aynı** | `0` → `0` | dokunulmadı |

Oturum **201 = `CONNECTED`** (deploy öncesi ve sonrası). QR / yeniden eşleştirme yok.

---

## 7. Mesaj kimliği ve RAM-only farkı (salt okunur, yeniden ölçüldü)

`audit_memory_gap.py` — 18:38:30Z:

| Ölçüm | Değer |
|---|---|
| `ram_total` / `ram_distinct_ids` | 9139 / 9139 |
| `db_total_messages` / `db_conversations` | 2068 / 125 |
| `CLASS_present_correct_conv` (IDENTITY_MATCH) | 2067 |
| `CLASS_genuinely_missing` (RAM_ONLY) | **7062** (40 sohbet) |
| `CLASS_unmapped_jid` | **10** (LID 9, PN 1) |
| `CHAT_MISMATCH` / `TENANT_MISMATCH` / `DUPLICATE_IDENTITY` / `DB_ONLY` | 0 / 0 / 0 / 0 |

Kimlik kümesi tutarlı: çakışan kimlik yok, başka sohbete kaymış mesaj yok, DB'de RAM'de olmayan
fazladan mesaj yok. **Fark kapatılmadı** — bu aşamada hiçbir veri yazılmadı.

---

## 8. ÜRETİM VERİ KAYBI — deploy'un tetiklediği startup migration

Cutover anında:

```
UYARI: cutover sonrasi ONCEDEN VAR OLAN mesaj kayboldu:
    messages:2077->2068 (id<=161322)
UYARI: cutover sonrasi satir sayisi dustu:
    conversations:126->125  messages:2077->2068  contacts:1538->1537
```

Sebep, adacık logunda açıkça yazıyor:

```
[MIGRATION] purge_raw_jid_identity_data: 0 ad nötrlendi, 0 mesaj adı nötrlendi,
            1 hayalet LID contact + 1 sohbet + 9 mesaj silindi,
            0 köprüsü bilinen hayalet onarıma bırakıldı.
```

**Bu release'in kodu değil.** `backend/app/core/migrations.py` base (`b5715fe`) ile hedef
(`38fe087`) arasında **bayt-bayt aynı** (`sha256 2cc14e83…`). Aynı silme, eski imajla yapılan
herhangi bir backend restart'ında da olurdu. Fark: son boot `2026-10-27T22:25Z` idi; hayalet sohbet
ondan **sonra** oluştu, dolayısıyla hiçbir önceki boot onu görmedi.

**Hangi sohbet:** `conversations` id aralığı `38288..38414`, 125 satır → eksik id'ler `38316` ve
`38412`. `38316` bu deploy'dan **önce** (10-27 olayı) silinmişti; bugünkü olay **`38412`**
(komşuları: `38413` = 10-28 15:12, `38414` = 10-29 18:15). 9 mesaj, `id<=161322`.

**Kurtarılabilirlik (ölçüldü):** silinen 9 mesaj **şu an gateway RAM'inde** — `CLASS_unmapped_jid`
içinde `LID: 9`. Ama artık bağlı oldukları bir sohbet satırı **yok**, yani:

* kalıcılaştırma açılsa bile bu 9 kayıt **yazılmaz** (sweep eşlenemeyen jid'i atlar),
* gateway yeniden oluşturulursa **kalıcı olarak kaybolurlar** (A6).

Migration'ın kendi docstring'i bu hatayı ve panzehirini anlatıyor: köprüsü *bilinen* hayaletler
ertelenir (`lid_mappings.lid_jid`). Log `0 … onarıma bırakıldı` dediği için bu hayaletin köprüsü
**yoktu** — tasarım gereği silindi, ama "tasarım gereği" veri kaybını geri getirmiyor.

---

## 9. RAM yedeği — değişmedi ve bütünlüğü doğrulandı

| | Değer |
|---|---|
| Dosya sayısı | 4 (2 × `.rsnap` + 2 × `.manifest.json`) |
| İzin / sahip | `600` `ubuntu:ubuntu` (deploy öncesi ve sonrası aynı, mtime aynı) |
| `sha256` (öncesi = sonrası) | `2a150698…1f8e` ve `00f657b1…5e07` |
| Bütünlük (`--verify -`, AES-GCM açıldı) | **exit 0** — 9137 kayıt / 99 sohbet, `duplicate 0`, `records_sha256 e035fd80…`, `identity_root 400dba30…` (3.8.3 kaydıyla birebir) |

Anahtar host'ta saklanmaz; doğrulama container'ın kendi `GATEWAY_ENCRYPTION_KEY`'i ile yapıldı,
dosya container'a kopyalanmadı (stdin).

---

## 10. Yazma / sweep / restart denetimi

| Soru | Cevap |
|---|---|
| Üretim DB'ye **manuel** INSERT/UPDATE/DELETE/migration/backfill | **yok** |
| Üretim DB'ye **otomatik** silme | **VAR — 1 sohbet + 9 mesaj + 1 contact** (§8) |
| Sweep / dry-run çalıştı mı | **hayır** — `runs:0`, `inserted_total:0`, `task_running:false`, tek "kapalı" logu |
| Gateway restart/recreate | **hayır** — aynı ID, aynı `StartedAt`, restart 0 |
| Caddy / DB restart | **hayır** |
| `main` push | **hayır** |
| RAM yedeği değişti mi | **hayır** (hash + izin + mtime aynı) |
| Adacık DB kaldı mı | **hayır** (`tezlify_cand%` sorgusu boş) |

**Log sızıntısı taraması:** backend loglarında JID `0`, telefon-benzeri `0`, SQL `0`; "secret"
deseni 1 isabet → yalnızca migration adı `ensure_api_keys_and_webhooks_tables` (**yanlış pozitif**).
Release dizininde JID yok.

**Yan bulgu (P2, sömürülebilir değil):** `backups/releases/*/candidate-env` dosyaları `664` ve canlı
sırları taşıyor (`GATEWAY_ENCRYPTION_KEY`, `SECRET_KEY`, `DB_PASSWORD`, DSN). Üst dizin
`/opt/tezlify/backups` **`700`** olduğu için diğer kullanıcılar erişemez; `ubuntu` zaten docker
(=root) yetkisine sahip. 282 eski release dizininde aynı durum var. Savunma derinliği için `600`
önerilir.

---

## 11. Kabul kriterleri

| # | Kriter | Sonuç |
|---|---|---|
| 1 | `.deployed-commit` tam olarak hedef | **GEÇTİ** `38fe087` |
| 2 | `/health.whatsapp_memory_persistence` artık `null` değil | **GEÇTİ** |
| 3 | Sağlıkta kalıcılık açıkça `false` | **GEÇTİ** `config_enabled:false` |
| 4 | Container env'inde `=false` | **KISMİ** — değişken yok, etkin değer `false` (§5) |
| 5 | Gateway ID/StartedAt/RestartCount değişmedi | **GEÇTİ** |
| 6 | Caddy + DB değişmedi | **GEÇTİ** |
| 7 | Oturum 201 `CONNECTED` | **GEÇTİ** |
| 8 | Mevcut mesajlar silinmedi / kimliği kaybolmadı | **BAŞARISIZ** — 9 mesaj silindi (§8); kimlik çakışması yok |
| 9 | RAM-only fark yeniden ölçüldü, yazma yok | **GEÇTİ** |
| 10 | Snapshot sayısı/hash/izin değişmedi | **GEÇTİ** |
| 11 | Loglarda SQL/PII/anahtar sızıntısı yok | **GEÇTİ** (1 yanlış pozitif) |
| 12 | Sweep'in çalışmadığına dair kanıt | **GEÇTİ** |
| — | **Üretim DB'sine DELETE yapılmamalı (§1)** | **BAŞARISIZ** — otomatik migration sildi (§8) |

**Başarı ölçütü** ("yeni backend çalışır, kalıcılık kesinlikle kapalı, gateway ve oturum değişmemiş,
hiçbir RAM mesajı DB'ye aktarılmamış") — üçü sağlandı; **dördüncüsü sağlandı**, ama §8'deki silme
bu aşamanın temiz başarı ilan edilmesini engelliyor.

---

## 12. Bir sonraki aşama için gereken ayrı onaylar

1. **`purge_raw_jid_identity_data` üretimde tekrar koşmadan önce** durdurulmalı/onarılmalı: köprüsü
   olmayan hayaletleri silmek yerine karantinaya almak (soft-delete) veya silmeyi tamamen kaldırmak.
   Aksi halde her backend restart'ı aynı kaybı tekrar üretebilir.
2. **9 mesajı kurtarma:** gateway RAM'inde duruyorlar ama sohbetsizler. Gateway restart'ından ÖNCE
   karar verilmeli. Herhangi bir yazma işlemi ayrı onay ister.
3. `WHATSAPP_MEMORY_PERSIST_ENABLED=true` — ayrı onay. (Bu 9 kaydı kurtarmaz; eşlenemeyen jid atlanır.)
4. `.env.production`'a bayrağı açıkça `false` yazmak (kriter 4'ü harfiyen kapatmak için) — ikinci bir
   backend recreate gerektirir.
5. `candidate-env` dosyalarını `600`'e çekmek (P2).
6. `main` push (yerel `2a74b3a`, `origin/main` `848c172`).

**Rollback notu:** `--rollback-to 20261029T183544Z` mekanizması mevcut, ancak **silinen 9 mesajı geri
getirmez** (imaj geri alma veri geri alma değildir). Bu yüzden rollback bu olay için çözüm değildir.
