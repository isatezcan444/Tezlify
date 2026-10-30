# AŞAMA 3.9.11 — OFF-SITE SNAPSHOT AKTARIMI VE UZAKTAN BÜTÜNLÜK DOĞRULAMASI

**Tarih:** 2026-10-30 (09:10–09:25 UTC)
**Çalışma türü:** ALTYAPI + KODLAMA
**Önceki aşama:** 3.9.10 — PASS (10/10)
**Production commit:** `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (değişmedi)

## GENEL SONUÇ: **PARTIAL**

| Alan | Durum |
|---|---|
| Dry-run | **PASS** |
| Tek dosyalık upload | **PASS** |
| Kalan yedi nesne | **PASS** (7/7) |
| Remote download | **PASS** (8/8) |
| SHA-256 doğrulaması | **PASS** (8/8, birebir) |
| Bucket güvenlik metadata'sı | **PASS** |
| **Escrow bağımsızlaştırma** | **BLOCKED** (`ESCROW_SEPARATION_BLOCKED`) |
| Off-site restore | **PARTIAL** (teknik olarak başarılı; escrow bağımsız olmadığı için tam PASS sayılmaz) |
| Üretim güvenliği | **PASS** (0 değişiklik) |

**Neden PARTIAL:** 8/8 nesne aktarıldı ve uzaktan SHA-256 ile doğrulandı — yedek **kopyası** artık VM dışında. Ama **escrow anahtarı hâlâ aynı diskte**; disk/VM kaybında şifreli yedek açılamaz. Bu yüzden "off-site recovery COMPLETE" **denemez**.

---

## 1. BAŞLANGIÇ ENVANTERİ

**8 dosya — SHA-256, boyut, izin (hepsi `600`)**

| Dosya | Boyut (B) | SHA-256 |
|---|---:|---|
| `tezlify-ram-20261029T125657Z.rsnap` | 7.100.080 | `2a150698a884dc9c62de98f9f36366439ef13f3ba0799f0940609effa59e1f8e` |
| `tezlify-ram-20261029T125755Z.rsnap` | 7.100.080 | `00f657b17eda030194dc76e99fb23fe6bb7ea4f0e443b9a108d038520a595e07` |
| `tezlify-ram-20261029T210007Z.rsnap` | 7.135.835 | `fdafdb7b3c7cdb647c89d899e4a2a322f6d4b3883559b30a1f5212fd67e17fcb` |
| `tezlify-ram-20261029T220302Z.rsnap` | 7.147.070 | `158794ed6ba7f9646876f1b64481e29b5001c0f282f250c4ed33b4caa41126cd` |
| `…125657Z.manifest.json` | 12.199 | `b0c69ddcb8f20d14474b0ea5bc5cfa96dbab435b9505403d0f515d6ee35efe3e` |
| `…125755Z.manifest.json` | 12.199 | `9dd710612f6012f660d3a8894e8d749991f0f7f1ecc830ec0908b4ceb30b3adc` |
| `…210007Z.manifest.json` | 12.316 | `5022a552b71e149962c87ff6d68444f3fb382a0b064b8234d574ca42e8b4ea79` |
| `…220302Z.manifest.json` | 12.316 | `c2342e93024f0b4f80ae0736fe8faf7667db5947fd8a7baa17d9635c511b4c6d` |

**Toplam:** 28.532.095 B. **Önceki envanterle (3.9.7/3.9.8) birebir aynı** — sapma yok, otomatik durma gerekmedi.

**Manifest içerik taraması:** secret/token/private key/credential **yok**. Yalnızca `schema`, `kind`, zaman damgaları, `chat_count`, `record_count`, `records_sha256`, `identity_root_sha256`, sayaçlar ve `gateway_id_prefix` alanları var. Anahtar değeri **hiçbir manifestte geçmiyor**.

**Escrow (içerik okunmadı):** `.key-escrow` 90 B `600`, `.key-escrow-v2` 88 B `600` — ikisi de `/var/backups/tezlify-ram/` içinde, **dokunulmadı**.

**Başlangıç üretim durumu:** backend `ce2e901b6619` · gateway `5b867095d376` · db `f6d79c4a1f8b` · caddy `ee66a5cab371`; session 201 `CONNECTED`; `126 | 2194 | 1538`; karantina 0; persistence kapalı; **RAM-only 9154 mesaj**.

---

## 2. DRY-RUN — PASS

| Kontrol | Beklenen | Ölçülen |
|---|---|---|
| Nesne sayısı | 8 | **8** |
| Toplam boyut | envanterle uyumlu | **28.532.095 B** ✅ |
| Escrow | açıkça BLOCKED | `.key-escrow`, `.key-escrow-v2` → **BLOCKED_ESCROW** ✅ |
| Ağ yazımı | 0 | **0** (PUT/POST/DELETE yok) ✅ |

Nesne anahtarları beklenen prefix altında: `tezlify/whatsapp/ram-snapshots/2026/10/29/<dosya>`.

---

## 3. TEK DOSYALIK DENEME — PASS

Seçilen: `tezlify-ram-20261029T125657Z.rsnap` (en küçük snapshot, 7.100.080 B).

| Adım | Sonuç |
|---|---|
| Ön kontrol: uzak nesne var mı | **yok** (HEAD 404) |
| Upload | **HTTP 200**, 0.28 sn |
| Remote boyut | **7.100.080** = yerel ✅ |
| Remote `opc-meta-sha256` | `2a150698…` = yerel ✅ |
| İndirme | **7.100.080 B** |
| İndirilen SHA-256 | `2a150698a884dc9c62de98f9f36366439ef13f3ba0799f0940609effa59e1f8e` ✅ |
| Yerel SHA-256 | **aynı** ✅ |

Güvenlik koşulları: `--execute` + `TEZLIFY_OFFSITE_APPROVED=1` zorunlu kaldı, `If-None-Match: *` gönderildi, TLS doğrulaması açık, escrow engeli aktif.

---

## 4. KALAN YEDİ NESNE — PASS (7/7)

| Dosya | HTTP | Süre | Yerel B | Uzak B |
|---|---|---:|---:|---:|
| `…125657Z.manifest.json` | **200** | 0.18 s | 12.199 | 12.199 |
| `…125657Z.rsnap` | — | — | — | **ALREADY_PRESENT** (atlandı, üzerine yazılmadı) |
| `…125755Z.manifest.json` | **200** | 0.10 s | 12.199 | 12.199 |
| `…125755Z.rsnap` | **200** | 0.21 s | 7.100.080 | 7.100.080 |
| `…210007Z.manifest.json` | **200** | 0.12 s | 12.316 | 12.316 |
| `…210007Z.rsnap` | **200** | 0.22 s | 7.135.835 | 7.135.835 |
| `…220302Z.manifest.json` | **200** | 0.10 s | 12.316 | 12.316 |
| `…220302Z.rsnap` | **200** | 0.20 s | 7.147.070 | 7.147.070 |

**Doğrulanmış nesne tekrar yüklenmedi** → versioning gereksiz büyümedi. Hiçbir nesne üzerine yazılmadı.

---

## 5. 8/8 UZAKTAN DOĞRULAMA — PASS

`verify --download-check`: her nesne **yeniden indirildi** ve SHA-256 hesaplandı.

| # | Dosya | Yerel B | İndirilen B | Boyut | SHA-256 | Durum |
|---|---|---:|---:|---|---|---|
| 1 | `…125657Z.manifest.json` | 12.199 | 12.199 | ✅ | ✅ | **VERIFIED** |
| 2 | `…125657Z.rsnap` | 7.100.080 | 7.100.080 | ✅ | ✅ | **VERIFIED** |
| 3 | `…125755Z.manifest.json` | 12.199 | 12.199 | ✅ | ✅ | **VERIFIED** |
| 4 | `…125755Z.rsnap` | 7.100.080 | 7.100.080 | ✅ | ✅ | **VERIFIED** |
| 5 | `…210007Z.manifest.json` | 12.316 | 12.316 | ✅ | ✅ | **VERIFIED** |
| 6 | `…210007Z.rsnap` | 7.135.835 | 7.135.835 | ✅ | ✅ | **VERIFIED** |
| 7 | `…220302Z.manifest.json` | 12.316 | 12.316 | ✅ | ✅ | **VERIFIED** |
| 8 | `…220302Z.rsnap` | 7.147.070 | 7.147.070 | ✅ | ✅ | **VERIFIED** |

`all_verified = true` · **toplam indirilen 28.532.095 B** (= yerel toplam).

**Not:** Bu doğrulama **ETag değil**, indirilen içeriğin **SHA-256** değeridir. ETag hiçbir yerde SHA-256 yerine kullanılmadı.

**Bucket içerik listesi (bağımsız kontrol):** 8 nesne, toplam **28.532.095 B**, `escrow_izi = YOK`.

---

## 6. BUCKET GÜVENLİK METADATA'SI — PASS

| Alan | Beklenen | Ölçülen |
|---|---|---|
| `id` | — | `ocid1.bucket.oc1.eu-frankfurt-1.aaaaaaaa7stxnee7nul72aqs3omzp5e3iq6wskcbpom4mpbnpy2antwedreq` |
| `publicAccessType` | `NoPublicAccess` | **`NoPublicAccess`** ✅ |
| `versioning` | `Enabled` | **`Enabled`** ✅ |
| `storageTier` | `Standard` | **`Standard`** ✅ |
| `compartmentId` | tenancy kökü | **eşleşti** ✅ |
| `namespace` | `frlm5ioojy2m` | **eşleşti** ✅ |
| `HEAD` bucket | 200 | **200** ✅ |

---

## 7. ESCROW BAĞIMSIZLAŞTIRMA — **BLOCKED**

**Durum:** `ESCROW_SEPARATION_BLOCKED`

| Kontrol | Sonuç |
|---|---|
| Mevcut OCI Vault (KMS) | **0 adet** (`GET /20180608/vaults` → 200, boş liste) |
| Mevcut KMS anahtarı | yok (uç nokta 404) |
| Yerel parola yöneticisi CLI (`op`/`bw`/`keepassxc-cli`/`pass`/`gpg`) | **hiçbiri kurulu değil** |
| macOS Keychain CLI (`security`) | var — ama bu amaç için **yapılandırılmamış** |
| Escrow bucket'a yüklendi mi | **HAYIR** — araç kod seviyesinde bloke etti; bucket listesinde escrow izi **yok** |

**Yapılmayanlar (talimat gereği):** escrow taşıma/kopyalama · yeni Vault/KMS/bucket/IAM oluşturma · escrow silme · yerel dosya değiştirme · anahtarı rapora yazma.

**Gereken en küçük ek onay** — biri seçilmeli:

| Seçenek | Ne yapılır | Not |
|---|---|---|
| **A. macOS Keychain** | `security add-generic-password` ile kullanıcının anahtarlığına kayıt | Üretim diskinden **ve** OCI hesabından bağımsız → en güçlü ayrım |
| **B. Fiziksel/offline kopya** | Yazdırılmış, kilitli saklama | Ağdan tamamen kopuk |
| **C. OCI Vault** | Yeni vault + secret + policy | Aynı tenancy → hesap ele geçirilirse ikisi de gider; **en zayıf** seçenek |

**V1 escrow** (yanlış anahtar) kullanılmadı, silinmedi. **V2** geçerliliği 4/4 snapshot çözümüyle yeniden doğrulandı.

---

## 8. OFF-SITE RESTORE — **PARTIAL**

Off-site'tan indirilen dosya ile, üretim DB'sine **bağlanmadan**, izole `:memory:` hedefe:

```
download → /tmp/offsite_restore_test.rsnap  (7.147.070 B, sha 158794ed… = yerel ✅)
ram_snapshot.py --restore-from … --restore-to ':memory:'
```

| Metrik | Değer |
|---|---|
| `inserted` | 9139 |
| `restored_rows` / `expected_rows` | 9139 / 9139 |
| `source_identity_count` / `restored_identity_count` | 9139 / 9139 |
| `distinct_conversations` | 100 |
| `identity_set_equal` | **true** |
| `restored_identity_root_sha256` | `4d689bd86c3e597e2e930ab73a4010d3f869e3092c85f3b1550bf2d29d1efcf8` |
| Manifest `identity_root_sha256` | **aynı** ✅ |
| `identity_root_matches` | **true** |
| `identity_conserved` | **true** |

Geçici dosya `shred -u` ile **silindi** (doğrulandı: dosya yok). Üretim DB'sine **0 yazma**.

**Neden PARTIAL:** Anahtar hâlâ yerel escrow'dan (`.key-escrow-v2`) alındı — bağımsız konumdan değil. Zincir teknik olarak çalışıyor, ama **bağımsız escrow olmadan** bu test "felaket kurtarma" kanıtı sayılmaz.

---

## 9. ÜRETİM GÜVENLİĞİ — PASS

| İşlem | Sayı |
|---|---:|
| Gateway restart / recreate | **0** |
| Backend restart / recreate | **0** |
| DB restart | **0** |
| Caddy restart | **0** |
| Deploy / production kod değişikliği | **0** |
| DB `INSERT`/`UPDATE`/`DELETE` | **0** |
| Persistence aktivasyonu | **0** |
| Yerel snapshot değişikliği/silme | **0** |
| Escrow dosyası değişikliği/silme | **0** |
| `.env.production` değişikliği | **0** |
| Bucket public yapma | **0** |
| Yeni IAM policy / cloud kaynak | **0** |
| Timer / cron | **0** |
| Git push | **0** |
| Object Storage nesne silme | **0** |

**Başlangıç / bitiş karşılaştırması**

| Container | ID | `StartedAt` | Değişim |
|---|---|---|---|
| backend | `ce2e901b6619` | `2026-10-29T21:47:56.536962458Z` | **yok** |
| gateway | `5b867095d376` | `2026-10-27T17:25:57.8181699Z` | **yok** |
| db | `f6d79c4a1f8b` | `2026-10-01T17:45:08.260956885Z` | **yok** |
| caddy | `ee66a5cab371` | `2026-10-12T13:12:45.795953636Z` | **yok** |

| Metrik | Başlangıç | Bitiş | Fark |
|---|---:|---:|---|
| conversations | 126 | **126** | 0 |
| messages | 2194 | **2194** | 0 |
| contacts | 1538 | **1538** | 0 |
| quarantine | 0 | **0** | 0 |
| Session 201 | `CONNECTED` | **`CONNECTED`** | 0 |
| Persistence | `config_enabled=false`, `runs=0` | **aynı** | 0 |
| **RAM-only mesaj** | **9154** | **9154** | **0** |
| Yerel 8 dosya SHA-256 | — | **birebir aynı** | 0 |
| Dosya izinleri | `600` | **`600`** | 0 |

**Yerel dosyalar değişmedi** (8/8 SHA-256 başlangıçla aynı).

---

## 10. AÇIK RİSKLER

| Risk | Önem | Durum |
|---|---|---|
| **Escrow hâlâ snapshot'larla aynı diskte** | **KRİTİK** | BLOCKED — disk/VM kaybı yedeği açılamaz hâle getirir |
| Off-site kopya **tek** (ikinci sağlayıcı yok) | Orta | Aynı tenancy; hesap kaybı riski |
| `manage objects` nesne silmeye izin veriyor | Orta | Azaltıldı: versioning `Enabled`; tam çözüm retention lock (ayrı onay) |
| Medya baytları yedeklenmiyor | Yüksek | Snapshot yalnızca metadata |
| 9 LID mesajı kurtarılamadı | Yüksek | Değişmedi |
| Persistence kapalı; RAM-only 9154 mesaj | Yüksek | Değişmedi — gateway recreate hâlâ yasak |
| 2 sohbet 2000 tavanında | Orta | Snapshot zamanla değersizleşir |
| Timer yok → yedek elle alınıyor | Orta | Ayrı onay gerekiyor |
| V1 escrow (yanlış anahtar) duruyor | Düşük | Karışıklık riski |

---

## 11. ARAÇ DEĞİŞİKLİKLERİ (yalnızca ilgili dosya)

`scripts/backup/offsite_oci.py` — 4 ekleme, mevcut güvenlik davranışı **korundu**:

| Değişiklik | Gerekçe |
|---|---|
| `upload --only <dosya>` | tek dosyalık deneme zorunluluğu |
| `verify --only <dosya>` | tek nesne doğrulaması |
| Upload sonrası `HEAD` → `remote_bytes`, `remote_meta_sha256` | nesne bazlı kayıt tablosu |
| `ls` komutu | escrow'un bucket'ta **olmadığını** kanıtlamak |
| `download` komutu | off-site restore için SHA-256 doğrulamalı indirme |

Korunanlar: escrow hard-block · `If-None-Match: *` · TLS doğrulaması zorunlu · `--execute` + `TEZLIFY_OFFSITE_APPROVED=1` çift kapı · token loglanmaz.

---

## 12. TAMAMLANMA KRİTERLERİ

| # | Kriter | Durum |
|---|---|---|
| 1 | 8/8 nesne remote bucket'ta mevcut | **PASS** |
| 2 | 8/8 nesne indirilebiliyor | **PASS** |
| 3 | 8/8 SHA-256 birebir eşleşiyor | **PASS** |
| 4 | Bucket private + versioning açık | **PASS** |
| 5 | Yerel snapshot'lar değişmemiş | **PASS** |
| 6 | WhatsApp gateway ve session korunmuş | **PASS** |
| 7 | Üretim DB ve persistence değişmemiş | **PASS** |
| 8 | Escrow bağımsızlaştırma | **BLOCKED** |
| 9 | İzole off-site restore | **PARTIAL** (bağımsız escrow yok) |

**Aşama: PARTIAL (7/9 PASS, 1 BLOCKED, 1 PARTIAL).** Yedek **kopyası** artık VM dışında ve kriptografik olarak doğrulanmış; **kurtarılabilirlik** ise escrow ayrımına bağlı.

---

## 13. SONRAKİ ADIM — 3.9.12

1. **Escrow ayrımı** (tek gerçek engel) — Bölüm 7'deki üç seçenekten biri onaylanmalı
2. Bağımsız escrow'dan anahtar okunarak off-site restore'un **tam** PASS'a çevrilmesi
3. (Opsiyonel) ikinci sağlayıcıya ikinci kopya
4. (Ayrı onay) günlük timer + JSONL audit + hata bildirimi
5. (Ayrı onay) retention/immutability

---

*Secret, token, private key, encryption key veya credential değerleri bu rapora yazılmadı. Gerçekleştirilmeyen işlemler başarılı gösterilmedi. ETag, SHA-256 yerine kullanılmadı.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*
