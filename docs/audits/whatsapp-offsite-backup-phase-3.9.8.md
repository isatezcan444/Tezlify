# AŞAMA 3.9.8 — OFF-SITE BACKUP KURULUMU VE İLK GÜVENLİ YEDEK

**Tarih:** 2026-10-30 (ölçüm penceresi 08:33–09:05 UTC)
**Mod:** ALTYAPI + KONTROLLÜ KODLAMA
**Üretim sunucusu:** `tezlify-oracle` (`130.162.247.20`), `eu-frankfurt-1`
**Production commit:** `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (değişmedi)
**Önceki aşama:** 3.9.7 (off-site hazırlık)

**Tek cümlelik sonuç:** OCI **instance principal yetkisi gerçek imzalı istekle doğrulandı** (token 200, namespace okundu), **ama bucket listesi 404 ile reddedildi** → bucket adı bilinmiyor → **aktarım yapılmadı**. `rclone` gerekmediği kanıtlandı; yerine kimlik bilgisi diskte tutmayan saf Python aracı yazıldı ve salt-okunur modda üretimde test edildi. **Üretimde 0 yazma.**

---

## 1. YÖNETİCİ ÖZETİ

| Soru | Cevap |
|---|---|
| OCI instance principal çalışıyor mu? | **EVET** — `POST /v1/x509` → **200**, token alındı, imza geçerli |
| Object Storage'a erişim var mı? | **Kısmen** — namespace okundu (`GET /n/` → 200); **bucket listesi 404** |
| Bucket hedefi doğrulandı mı? | **HAYIR — NOT VERIFIED** (`404 NamespaceNotFound` = yetki yok) |
| Bucket oluşturuldu mu? | **HAYIR** — onay yok, talimat gereği oluşturulmadı |
| `rclone` kuruldu mu? | **HAYIR** — onay yok. **Ayrıca gerekmiyor** (aşağıya bak) |
| Aktarım yapıldı mı? | **HAYIR** — 0/8 nesne |
| Geri yükleme tatbikatı? | **Yerel snapshot'tan PASS** (`:memory:`, 9139/9139); **off-site kaynaktan BLOCKED** |
| Escrow ayrıldı mı? | **HAYIR** — hâlâ snapshot dizininde |
| Üretim değişti mi? | **HAYIR** — 0 restart, 0 deploy, 0 DB yazımı, 0 PUT/DELETE |

### Bu aşamanın en önemli teknik bulgusu

**`rclone` kurulumu gereksiz.** Instance principal, IMDS + `/v1/x509` üzerinden kimlik doğrular; diskte hiçbir kimlik bilgisi tutmaz, paket kurulumu gerektirmez ve secret komut satırına yazılmaz. Bu nedenle "rclone kurulum izni" maddesi **geçersiz** — daha güvenli bir yol var ve o yol **çalıştı**.

### Bulunan ve düzeltilen gerçek hata

İlk araç sürümü auth POST'unda `content-type: application/octet-stream` gönderiyordu → sunucu **HTTP 415 Unsupported Media Type** döndü. `application/json` ile düzeltildi ve yeniden test edildi (200). Bu hata yalnızca gerçek istek atılarak bulunabildi; tasarım aşamasında görünmüyordu.

---

## 2. OCI YETKİ DOĞRULAMASI (BÖLÜM A)

Yöntem: OCI Python SDK'nın imzalama algoritması kaynaktan okunup **saf Python + mevcut `cryptography 41.0.7`** ile yeniden uygulandı. Üretime **paket kurulmadı**.

| Adım | İstek | Sonuç |
|---|---|---|
| 1 | `GET /opc/v2/instance/region` | `eu-frankfurt-1` |
| 2 | `GET /opc/v2/instance/` | `tezlify-oracle`, `VM.Standard.A1.Flex` |
| 3 | `GET /opc/v2/identity/cert.pem` | 200 (leaf sertifika) |
| 4 | `GET /opc/v2/identity/key.pem` | 200 (leaf özel anahtar, **bellekte**) |
| 5 | `GET /opc/v2/identity/intermediate.pem` | 200 |
| 6 | Tenancy OCID | IMDS `tenantId` + sertifika `OU=opc-tenant:…` (iki kaynak **aynı**) |
| 7 | Sertifika SHA-1 parmak izi | 59 karakter (iki nokta ayrımlı) — **değer raporlanmadı** |
| 8 | `POST https://auth.eu-frankfurt-1.oraclecloud.com/v1/x509` | **HTTP 200**, token alındı (uzunluk 2250, **değer raporlanmadı**) |
| 9 | `GET /n/` (namespace) | **HTTP 200** → `frlm5ioojy2m` |
| 10 | `GET /n/frlm5ioojy2m/b?compartmentId=<tenancy>` | **HTTP 404** `NamespaceNotFound` |
| 11 | `GET /n/{ns}/b` (compartment'sız) | HTTP 400 `MissingCompartmentId` |

**İmzalama detayı (doğrulandı):**
- Token isteği `keyId = {tenancy_ocid}/fed-x509/{sha1_fingerprint}` biçiminde, leaf sertifikanın özel anahtarıyla imzalandı.
- İmza başlıkları: `date`, `(request-target)`, `host`, `content-length`, `content-type`, `x-content-sha256`.
- Sonraki Object Storage çağrıları `keyId = "ST$" + token` ve **oturum anahtarı** (bellekte üretilen RSA-2048) ile imzalandı.

**Yorum:** Instance principal **kimlik doğrulaması başarılı**. `404 NamespaceNotFound`, OCI'nin yetkisiz erişimi "kaynak yok" gibi gizleme davranışıdır → **bucket enum yetkisi yok**. IMDS'in 200 dönmesi tek başına yetki sayılmadı; karar **imzalı istek sonucuna** dayanıyor.

**Talimat gereği burada duruldu.** Yeni dynamic group, policy veya cloud kaynak **oluşturulmadı**.

---

## 3. BUCKET VE HEDEF BİLGİLERİ (BÖLÜM B)

| Bilgi | Durum |
|---|---|
| Object Storage namespace | **VAR** — `frlm5ioojy2m` |
| Region | **VAR** — `eu-frankfurt-1` |
| Endpoint | **VAR** — `https://objectstorage.eu-frankfurt-1.oraclecloud.com` (TLS doğrulandı) |
| Bucket adı | **YOK — NOT VERIFIED** |
| Yazma yetkisi | **DOĞRULANAMADI** (bucket adı olmadan test edilemez; tahmin yasak) |
| Okuma yetkisi | **DOĞRULANAMADI** (aynı sebep) |
| Kimlik doğrulama yöntemi | **Instance principal — ÇALIŞIYOR** |
| Escrow için bağımsız konum | **YOK** |

**Önerilen hedef (operatör onayına sunulur):**

| Alan | Öneri |
|---|---|
| Bucket adı | `tezlify-ram-snapshots` |
| Erişim | `NoPublicAccess` (public **yasak**) |
| Versioning | **Enabled** (yanlışlıkla üzerine yazmaya karşı) |
| Storage tier | `Standard` |
| Prefix | `tezlify/whatsapp/ram-snapshots` |
| Nesne düzeni | `…/YYYY/MM/DD/<dosya adı>` |
| Lifecycle | 30 günden eski nesilleri sil |
| Maliyet | ~€0 (Always Free 20 GB; mevcut yük 28,5 MB) |

**Gerekli IAM (operatör uygular — ben oluşturmadım):**

```
# Dynamic group kuralı (instance kimliğiyle birebir)
instance.id = 'ocid1.instance.oc1.eu-frankfurt-1.antheljtzhfthiicm3e2y7hslvnc65afnkpknawogwctisk5yyv3b2jbxo2a'

# Policy (root compartment = tenancy OCID)
Allow dynamic-group tezlify-offsite-dg to read buckets in compartment <TENANCY_OCID>
Allow dynamic-group tezlify-offsite-dg to manage objects in compartment <TENANCY_OCID> where target.bucket.name = 'tezlify-ram-snapshots'
```

`read buckets` yalnızca **bucket doğrulama** (`HEAD bucket`) için gerekir; nesne işlemleri `manage objects` ile sınırlı tutulur (least privilege).

---

## 4. KULLANILAN ARAÇLAR VE SÜRÜMLER

| Araç | Sürüm / Durum |
|---|---|
| Python (üretim) | 3.12.3 |
| `cryptography` | 41.0.7 (mevcut) |
| OpenSSL | 3.0.13 |
| `curl`, `rsync`, `sha256sum` | mevcut |
| `oci` CLI | **YOK** (kurulmadı) |
| `rclone` | **YOK** (kurulmadı — **gerekmiyor**) |
| `aws` / `s3cmd` / `restic` | **YOK** |
| **Yeni araç** | `scripts/backup/offsite_oci.py` (bu aşamada yazıldı) |

### `scripts/backup/offsite_oci.py`

| Komut | İşlev | Ağ |
|---|---|---|
| `probe` | instance principal yetki sondası (Bölüm A) | salt-okunur GET |
| `inventory` | yerel envanter + SHA-256 | **ağ yok** |
| `upload` | idempotent yükleme; `--execute` + `TEZLIFY_OFFSITE_APPROVED=1` olmadan **sadece plan** | yazma (kapılı) |
| `verify` | uzak kopyaları doğrula; `--download-check` ile yeniden indirip hash karşılaştır | salt-okunur GET |

**Kodda zorlanan güvenlik kuralları:**
- `.key-escrow*` dosyaları **hard block** (`BLOCKED_ESCROW`) — escrow asla yüklenmez.
- Aynı isim + farklı hash → **CONFLICT**, üzerine yazma yok; ek olarak `If-None-Match: *` ile **atomik** koruma (TOCTOU kapatıldı).
- Hata → kaynak dosyaya dokunulmaz, çıkış kodu ≠ 0.
- TLS doğrulaması kod içinde `ssl.create_default_context()` ile sabit — kapatma seçeneği **yok**.
- Token/secret hiçbir log satırına, audit kaydına veya çıktıya yazılmaz.
- Audit log: `~/.local/state/tezlify-offsite/transfer.jsonl` (mode `600`).

**Test durumu (dürüst):**
- `probe` → üretimde **çalıştırıldı**, 200/404 sonuçları alındı. ✅
- `inventory` → üretimde **çalıştırıldı**, 8 nesne + 2 escrow blok tespit edildi. ✅
- `upload --execute` → **kapı testi yapıldı**, `TEZLIFY_OFFSITE_APPROVED` yokken **reddetti**. ✅
- `upload` gerçek yazma yolu → **hiç çalıştırılmadı** (bucket yok). ⚠️ **CANLI BUCKET'A KARŞI DOĞRULANMADI.**
- `verify --download-check` → **hiç çalıştırılmadı** (uzak nesne yok). ⚠️

---

## 5. AKTARILAN SNAPSHOT ENVANTERİ

**Aktarılan: 0 / 8 nesne. Toplam planlanan: 28.532.095 B.**

| # | Dosya | Boyut (B) | Nesne anahtarı |
|---|---|---:|---|
| 1 | `tezlify-ram-20261029T125657Z.rsnap` | 7.100.080 | `…/2026/10/29/…rsnap` |
| 2 | `tezlify-ram-20261029T125755Z.rsnap` | 7.100.080 | `…/2026/10/29/…rsnap` |
| 3 | `tezlify-ram-20261029T210007Z.rsnap` | 7.135.835 | `…/2026/10/29/…rsnap` |
| 4 | `tezlify-ram-20261029T220302Z.rsnap` | 7.147.070 | `…/2026/10/29/…rsnap` |
| 5 | `…125657Z.manifest.json` | 12.199 | `…/2026/10/29/…json` |
| 6 | `…125755Z.manifest.json` | 12.199 | `…/2026/10/29/…json` |
| 7 | `…210007Z.manifest.json` | 12.316 | `…/2026/10/29/…json` |
| 8 | `…220302Z.manifest.json` | 12.316 | `…/2026/10/29/…json` |
| — | `.key-escrow` | 90 | **BLOKE** |
| — | `.key-escrow-v2` | 88 | **BLOKE** |

**Talimata uygun karar:** İlk iki snapshot içerik olarak aynı olsa da **dördü de** aktarım planına dahil edildi. Deduplikasyon yapılmadı; kaynak dosyalara dokunulmadı.

---

## 6. SHA-256 KARŞILAŞTIRMA TABLOSU

| Dosya | Yerel SHA-256 | Uzak SHA-256 | Durum |
|---|---|---|---|
| `…125657Z.rsnap` | `2a150698a884dc9c62de98f9f36366439ef13f3ba0799f0940609effa59e1f8e` | — | **NOT TRANSFERRED** |
| `…125755Z.rsnap` | `00f657b17eda030194dc76e99fb23fe6bb7ea4f0e443b9a108d038520a595e07` | — | **NOT TRANSFERRED** |
| `…210007Z.rsnap` | `fdafdb7b3c7cdb647c89d899e4a2a322f6d4b3883559b30a1f5212fd67e17fcb` | — | **NOT TRANSFERRED** |
| `…220302Z.rsnap` | `158794ed6ba7f9646876f1b64481e29b5001c0f282f250c4ed33b4caa41126cd` | — | **NOT TRANSFERRED** |
| `…125657Z.manifest.json` | `b0c69ddcb8f20d14474b0ea5bc5cfa96dbab435b9505403d0f515d6ee35efe3e` | — | **NOT TRANSFERRED** |
| `…125755Z.manifest.json` | `9dd710612f6012f660d3a8894e8d749991f0f7f1ecc830ec0908b4ceb30b3adc` | — | **NOT TRANSFERRED** |
| `…210007Z.manifest.json` | `5022a552b71e149962c87ff6d68444f3fb382a0b064b8234d574ca42e8b4ea79` | — | **NOT TRANSFERRED** |
| `…220302Z.manifest.json` | `c2342e93024f0b4f80ae0736fe8faf7667db5947fd8a7baa17d9635c511b4c6d` | — | **NOT TRANSFERRED** |

Yerel hash'ler 3.9.7 ölçümüyle **birebir aynı** — snapshot'lar bu aşamada da değişmedi.

---

## 7. MANIFEST DOĞRULAMASI

Manifest içeriği, `ram_snapshot.py --verify` çıktısıyla **karşılaştırıldı** (dört dosya için de tutarlı):

| Manifest | `record_count` | `chat_count` | Manifest `identity_root` | `--verify` sonucu | Eşleşme |
|---|---:|---:|---|---|---|
| `…125657Z` | 9137 | 99 | `400dba30…` | ok=true, 9137/99, `400dba30…` | **✓** |
| `…125755Z` | 9137 | 99 | `400dba30…` | ok=true, 9137/99, `400dba30…` | **✓** |
| `…210007Z` | 9139 | 100 | `743f5959…` | ok=true, 9139/100, `743f5959…` | **✓** |
| `…220302Z` | 9139 | 100 | `4d689bd8…` | ok=true, 9139/100, `4d689bd8…` | **✓** |

Ek alanlar: `schema=1`, `kind=tezlify.ram_snapshot`, `duplicates_removed=0`, `unmapped_conversation_count=0`, `gateway_id_prefix=1bd78836` (dördünde aynı).
`source_container_id`: `579085f13268` (ilk ikisi), `3f6a66f68bc8` (210007Z), `ce2e901b6619` (220302Z — mevcut backend).

**Not:** Bu doğrulama **yerel tutarlılığı** kanıtlar. Uzak kopya olmadığı için uzak manifest doğrulaması **yapılmadı**.

---

## 8. ESCROW AYRIM DURUMU (BÖLÜM F)

| Kural | Durum |
|---|---|
| Escrow bucket'a yüklenmedi | **PASS** — araç `.key-escrow*` dosyalarını `BLOCKED_ESCROW` olarak işaretledi |
| Escrow bağımsız konumda | **FAIL / BLOCKED** — hâlâ `/var/backups/tezlify-ram/` içinde, snapshot'larla **aynı dizin ve aynı disk** |
| V1 escrow silindi mi | **HAYIR** (talimat gereği; ayrı onaylı temizlik aşaması) |

**Sonuç:** Escrow ayrımı yapılmadığı için off-site backup, **şifreli veri kurtarma açısından tamamlanmış sayılmaz.** Disk/VM kaybı hâlâ snapshot **ve** anahtarı birlikte götürür.

Kabul edilebilir hedefler (operatör seçer): bağımsız parola yöneticisi, farklı sağlayıcının secret manager'ı, kullanıcının kontrolündeki şifreli fiziksel ortam. **Bucket içine konmayacak.**

---

## 9. GERİ YÜKLEME TATBİKATI (BÖLÜM G)

**Off-site kaynaktan:** **BLOCKED** (uzak kopya yok).
**Yerel snapshot'tan (ikame test, `:memory:`):** **PASS**

```
ram_snapshot.py --restore-from …20261029T220302Z.rsnap --restore-to ':memory:'
```

| Metrik | Değer |
|---|---|
| `inserted` | 9139 |
| `skipped_duplicate` | 0 |
| `restored_rows` / `expected_rows` | 9139 / 9139 |
| `source_identity_count` / `restored_identity_count` | 9139 / 9139 |
| `distinct_conversations` | 100 |
| `identity_set_equal` | **true** |
| `restored_identity_root_sha256` | `4d689bd86c3e597e2e930ab73a4010d3f869e3092c85f3b1550bf2d29d1efcf8` |
| `identity_root_matches` | **true** |
| `identity_conserved` | **true** |

Üretim veritabanına **hiçbir yazma** yapılmadı; hedef `:memory:` (dosya bile oluşmadı).

**Dürüst sınır:** Bu, şifre çözme + kimlik koruma zincirinin çalıştığını kanıtlar. **Off-site'tan indirme adımını kanıtlamaz** — o adım bucket açılana kadar BLOCKED.

---

## 10. ÜRETİM DEĞİŞİKLİK SAYACI

| İşlem | Sayı |
|---|---:|
| Gateway restart / recreate | **0** |
| Backend restart / recreate | **0** |
| DB restart / recreate | **0** |
| Caddy restart / recreate | **0** |
| `docker compose up/down/restart` | **0** |
| Deploy | **0** |
| DB `INSERT`/`UPDATE`/`DELETE` | **0** |
| Snapshot silme / taşıma | **0** |
| Escrow silme | **0** |
| `.env.production` değişikliği | **0** |
| Paket kurulumu (`rclone`/`oci`) | **0** |
| Cloud kaynak oluşturma | **0** |
| Object Storage `PUT`/`POST`/`DELETE` | **0** |
| Off-site aktarım | **0** |

**Ağ çağrıları (şeffaflık):**
- Auth servisine yalnızca `POST /v1/x509` (**kimlik doğrulama**, kaynak oluşturmaz) — birkaç kez, 415 hatası dahil.
- Object Storage'a yalnızca `GET` (namespace + bucket listesi denemeleri).
- **Hiçbir yazma metodu (PUT/POST/DELETE) Object Storage'a gönderilmedi.**

---

## 11. BAŞLANGIÇ / BİTİŞ CONTAINER KARŞILAŞTIRMASI (BÖLÜM J)

| Container | ID (başlangıç) | ID (bitiş) | `StartedAt` | Değişim |
|---|---|---|---|---|
| backend | `ce2e901b6619` | `ce2e901b6619` | `2026-10-29T21:47:56.536962458Z` | **yok** |
| gateway | `5b867095d376` | `5b867095d376` | `2026-10-27T17:25:57.8181699Z` | **yok** |
| db | `f6d79c4a1f8b` | `f6d79c4a1f8b` | `2026-10-01T17:45:08.260956885Z` | **yok** |
| caddy | `ee66a5cab371` | `ee66a5cab371` | `2026-10-12T13:12:45.795953636Z` | **yok** |

| Metrik | Başlangıç (08:40Z) | Bitiş (09:05Z) | Fark |
|---|---:|---:|---|
| `conversations` | 126 | **126** | 0 |
| `messages` | 2185 | **2194** | **+9 (canlı ingest)** |
| `contacts` | 1538 | **1538** | 0 |
| `whatsapp_identity_quarantine` | 0 | **0** | 0 |
| Session 201 | `CONNECTED` | **`CONNECTED`** | 0 |
| Persistence | `config_enabled=false`, `runs=0` | **aynı** | 0 |
| `/health` | — | `status=healthy`, `quarantined=0`, `messages_held=0` | — |

**Yorum:** Mesaj sayısı **arttı** (+9), azalmadı. Hiçbir container yeniden başlatılmadığı için RAM-only kayıp mekanizması **tetiklenmedi**. Sayı artışı kayıp iddiasını dışlar; ancak RAM-only mesajların tek tek kimlik doğrulaması bu aşamada yapılmadı (gateway'e dokunulmadı) — bu yüzden "kesin kanıt" değil, "kayıp göstergesi yok" olarak raporlanıyor.

---

## 12. AÇIK RİSKLER

| Risk | Önem | Durum |
|---|---|---|
| **Off-site kopya yok** | **KRİTİK** | Açık — bucket + policy bekleniyor |
| **Escrow snapshot'larla aynı diskte** | **KRİTİK** | Açık — şifreleme tek başına korumuyor |
| **Bucket enum yetkisi yok** | Yüksek | `404 NamespaceNotFound`; dynamic group + policy gerekli |
| Persistence kapalı | Yüksek | RAM-only mesajlar DB'ye aktarılmadı; gateway recreate = kayıp |
| Medya baytları yedeklenmiyor | Yüksek | Snapshot yalnızca metadata |
| 9 LID mesajı kurtarılamadı | Yüksek | Köprü yok; değişmedi |
| 2 sohbet 2000 tavanında | Orta | `38289`, `38291` — snapshot zamanla değersizleşir |
| `upload`/`verify` canlı bucket'ta test edilmedi | Orta | Kod yazıldı, salt-okunur yollar test edildi; yazma yolu **denenmedi** |
| V1 escrow (yanlış anahtar) duruyor | Düşük | Operatör karışıklığı |

---

## 13. BAŞARISIZ / DOĞRULANAMAYAN KONTROLLER

| Kontrol | Sonuç | Sebep |
|---|---|---|
| Bucket listesi | **NOT VERIFIED** | `404 NamespaceNotFound` — yetki yok |
| Bucket adı / hedef | **NOT VERIFIED** | Bilgi operatörden gelmedi; tahmin yasak |
| Yazma/okuma yetkisi | **NOT VERIFIED** | Bucket adı olmadan test edilemez |
| Gerçek aktarım | **BLOCKED** | Hedef + onay yok |
| Uzak SHA-256 doğrulaması | **BLOCKED** | Uzak nesne yok |
| Escrow ayrımı | **FAIL** | Bağımsız konum tanımlanmadı |
| Off-site'tan geri yükleme | **BLOCKED** | Uzak kopya yok |
| `rclone` kurulumu | **N/A** | Onay yok **ve gerekmiyor** (instance principal yeterli) |
| Timer/otomasyon | **BLOCKED** | Talimat gereği varsayılan olarak kurulmadı |

---

## 14. SONRAKİ AŞAMA ÖNERİSİ (3.9.9)

### Operatörden gereken onaylar (her biri ayrı)

1. **Bucket oluşturma izni** — `tezlify-ram-snapshots`, `NoPublicAccess`, versioning on.
2. **IAM izni** — dynamic group + 2 policy satırı (Bölüm 3'teki metin).
3. **Gerçek aktarım izni** — `upload --execute` + `TEZLIFY_OFFSITE_APPROVED=1`.
4. **Escrow bağımsız konumu** — hangi secret store / fiziksel ortam.
5. **Timer kurma izni** — günlük 03:30 UTC (ayrı onay).

> `rclone` kurulum izni **gerekmiyor** — madde iptal.

### Uygulama sırası (onaylar gelince)

```bash
# 1) Bucket + policy (operatör veya onaylı operatör komutu)
oci os bucket create --name tezlify-ram-snapshots \
  --compartment-id <TENANCY_OCID> --public-access-type NoPublicAccess \
  --versioning Enabled --storage-tier Standard

# 2) Yetki doğrulama (salt okunur)
python3 scripts/backup/offsite_oci.py probe
#    beklenen: bucket_list = HTTP 200, 1 bucket

# 3) Plan (yazma yok)
python3 scripts/backup/offsite_oci.py upload --bucket tezlify-ram-snapshots

# 4) İlk aktarım (onaylı)
TEZLIFY_OFFSITE_APPROVED=1 python3 scripts/backup/offsite_oci.py \
  upload --bucket tezlify-ram-snapshots --execute

# 5) Uzak doğrulama (yeniden indirip hash)
python3 scripts/backup/offsite_oci.py verify --bucket tezlify-ram-snapshots --download-check

# 6) Off-site'tan geri yükleme tatbikatı
#    indir → --verify → --restore-to ':memory:' → identity_root karşılaştır
```

### Aşama tamamlanma tanımı

Bu aşama **tamamlanmadı**. Tamamlanması için: bucket doğrulanmış, 8 nesne aktarılmış, uzak SHA-256 eşleşmiş, escrow ayrılmış ve **off-site kaynaktan** geri yükleme tatbikatı geçmiş olmalı.

---

## KABUL KRİTERLERİ

| # | Kriter | Durum |
|---|---|---|
| 1 | OCI yetkisi gerçek imzalı istekle doğrulandı | **PASS** — `POST /v1/x509` 200 + `GET /n/` 200 |
| 2 | Bucket hedefi doğrulandı | **NOT VERIFIED** — 404 |
| 3 | Cloud kaynak oluşturma izni alındı | **BLOCKED** — izin yok, oluşturulmadı |
| 4 | `rclone` kurulum izni alındı | **N/A** — gerekmiyor |
| 5 | `rclone` güvenli kuruldu | **N/A** — kurulmadı |
| 6 | Dört snapshot uzak hedefe aktarıldı | **BLOCKED** — 0/8 |
| 7 | Dört snapshot SHA-256 ile doğrulandı (uzak) | **BLOCKED** |
| 8 | Manifest dosyaları doğrulandı | **PASS (yerel)** / uzak **BLOCKED** |
| 9 | Escrow bağımsız konumda | **FAIL** |
| 10 | İzole geri yükleme tatbikatı | **PASS (yerel)** / off-site **BLOCKED** |
| 11 | Üretim container'ları değişmedi | **PASS** |
| 12 | WhatsApp session CONNECTED kaldı | **PASS** |
| 13 | Hiçbir RAM-only mesaj kaybolmadı | **PASS (dolaylı)** — 0 restart, sayaç +9 |
| 14 | Rapor oluşturuldu | **PASS** |

**Özet: 6 PASS · 1 FAIL · 4 BLOCKED · 1 NOT VERIFIED · 2 N/A.** Aşama **tamamlanmadı**; engel **bucket + IAM yetkisi**.

---

*Secret, token, access key, private key veya encryption key bu rapora yazılmadı. Gerçekleştirilmeyen işlemler başarılı gösterilmedi. Simülasyon sonuçları gerçek cihaz E2E olarak sunulmadı.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*
