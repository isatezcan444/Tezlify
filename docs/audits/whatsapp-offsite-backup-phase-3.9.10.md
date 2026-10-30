# AŞAMA 3.9.10 — OCI IAM VE PRIVATE OBJECT STORAGE BUCKET KURULUMU

**Tarih:** 2026-10-30 (09:05–09:20 UTC)
**Çalışma türü:** ALTYAPI + KODLAMA
**Yetki:** Kullanıcı tarafından açıkça onaylandı (3 kaynak)
**Production commit:** `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (değişmedi)

**Sonuç: PASS (10/10 kriter).** Dynamic group, policy ve private bucket oluşturuldu; instance principal artık bucket listesini ve metadata'yı **HTTP 200** ile okuyor. **Üretim VM'inde 0 değişiklik** — gateway `5b867095d376` dokunulmadı, session `CONNECTED`, veri sayıları sabit.

> **Uyarı:** Bu aşamanın PASS olması off-site backup'ın tamamlandığı anlamına **gelmez**. Snapshot aktarımı, uzak SHA-256 doğrulaması, escrow ayrımı ve off-site restore testi **ayrı onaylı** aşamalardır (3.9.11+).

---

## 1. ÖNCEKİ VE SONRAKİ KAYNAK ENVANTERİ

### Önce (3.9.10 başlangıcı, user principal ile okundu)

| Kaynak | Durum |
|---|---|
| Dynamic group `tezlify-offsite-dg` | **YOK** |
| Policy `tezlify-offsite-policy` | **YOK** |
| Bucket `tezlify-ram-snapshots` | **YOK** |
| Namespace | `frlm5ioojy2m` (mevcut) |

> **3.9.9 belirsizliği çözüldü.** Önceki aşamada "dynamic group yok / policy yok / policy koşulu uyuşmuyor" üçlüsü ayırt edilememişti (instance principal IAM okuyamıyordu). User principal ile yapılan bu okuma kesin cevabı verdi: **hiçbiri yoktu**. Yani 3.9.9'daki 3 ve 4 numaralı hipotezler **ikisi birden doğruydu**.

### Sonra

| Kaynak | Durum | Kimlik |
|---|---|---|
| Dynamic group | **VAR** | `ocid1.dynamicgroup.oc1..aaaaaaaaup5m5ioxh3hkfnxyqk52caaiggszdcshwonefd3d7konl3qcmpca` |
| Policy | **VAR** (1 obje, 2 statement) | `ocid1.policy.oc1..aaaaaaaajzvxo4wu7zndbhqgfwcwofr4tuvzjtkx3h2akss5iknb57k2jo4q` |
| Bucket | **VAR** | `ocid1.bucket.oc1.eu-frankfurt-1.aaaaaaaa7stxnee7nul72aqs3omzp5e3iq6wskcbpom4mpbnpy2antwedreq` |

---

## 2. DYNAMIC GROUP — PASS

| Alan | Değer |
|---|---|
| Ad | `tezlify-offsite-dg` |
| OCID | `ocid1.dynamicgroup.oc1..aaaaaaaaup5m5ioxh3hkfnxyqk52caaiggszdcshwonefd3d7konl3qcmpca` |
| Compartment | tenancy kökü |
| Matching rule | `instance.id = 'ocid1.instance.oc1.eu-frankfurt-1.antheljtzhfthiicm3e2y7hslvnc65afnkpknawogwctisk5yyv3b2jbxo2a'` |
| Kural hedefle birebir mi | **EVET** (`rule_matches=True`, tek-kaynak GET ile okundu) |

**Kural yalnızca bu instance'ı eşliyor** — compartment veya tenancy genişletmesi **yok**. Mevcut grup bulunmadığı için güncelleme yapılmadı, sıfırdan oluşturuldu.

**Ölçülen tuzak:** `GET /dynamicGroups` (liste) yanıtı **`matchingRule` alanını döndürmüyor**. Kuralı doğrulamak için tek-kaynak `GET /dynamicGroups/{id}` şart. Bu bulunmasaydı idempotency kontrolü her çalıştırmada "kural farklı" diyip yanlış CONFLICT üretecekti.

---

## 3. POLICY — PASS

Tek policy objesi, **iki statement** (OCI'da policy = statement grubu; iki ayrı obje gereksiz tekrar olurdu).

**OCID:** `ocid1.policy.oc1..aaaaaaaajzvxo4wu7zndbhqgfwcwofr4tuvzjtkx3h2akss5iknb57k2jo4q`
**Compartment:** tenancy kökü (`ocid1.tenancy.oc1..aaaaaaaauvyjjnzy7z74yqu3bkohjoxoaniba7a7o2oxzz4qynmttbxw5pzq`)

**Statement 1 — okuma:**
```
Allow dynamic-group tezlify-offsite-dg to read buckets in compartment id ocid1.tenancy.oc1..aaaaaaaauvyjjnzy7z74yqu3bkohjoxoaniba7a7o2oxzz4qynmttbxw5pzq
```

**Statement 2 — nesne yazma (bucket'a koşullu):**
```
Allow dynamic-group tezlify-offsite-dg to manage objects in compartment id ocid1.tenancy.oc1..aaaaaaaauvyjjnzy7z74yqu3bkohjoxoaniba7a7o2oxzz4qynmttbxw5pzq where target.bucket.name = 'tezlify-ram-snapshots'
```

**Doğrulama:** policy API'den **geri okundu**; iki statement da yukarıdakiyle **birebir** (`statements_match=True`).

**Verilmeyenler (en az yetki):** `manage buckets` · `manage all-resources` · `use keys` · `manage vaults` · `inspect compartments` genişletmesi — **hiçbiri verilmedi**. Sonuç: principal bucket **oluşturamaz/silemez**, yalnızca tek bucket'a nesne yazabilir.

---

## 4. BUCKET — PASS

| Alan | Beklenen | **Ölçülen** |
|---|---|---|
| Ad | `tezlify-ram-snapshots` | **`tezlify-ram-snapshots`** |
| OCID | — | `ocid1.bucket.oc1.eu-frankfurt-1.aaaaaaaa7stxnee7nul72aqs3omzp5e3iq6wskcbpom4mpbnpy2antwedreq` |
| Namespace | `frlm5ioojy2m` | **`frlm5ioojy2m`** |
| Region | `eu-frankfurt-1` | **`eu-frankfurt-1`** |
| Compartment | tenancy kökü | **tenancy kökü** (OCID eşleşti) |
| `publicAccessType` | `NoPublicAccess` | **`NoPublicAccess`** |
| `versioning` | `Enabled` | **`Enabled`** |
| `storageTier` | `Standard` | **`Standard`** |
| Oluşturulma | — | `2026-10-30T09:08:17.111Z` |

Nesne prefix'i (`tezlify/whatsapp/ram-snapshots`) **yükleme anında** uygulanır; bucket ayarı değildir. Henüz nesne yok.

---

## 5. INSTANCE PRINCIPAL ERİŞİM DOĞRULAMASI — PASS

Üretim VM'inden (`tezlify-oracle`), saf Python aracıyla, **yalnızca instance principal** kullanılarak:

| # | Kontrol | HTTP | Sonuç |
|---|---|---|---|
| 1 | Token alınabiliyor mu (`POST /v1/x509`) | **200** | PASS |
| 2 | Namespace `GET /n/` | **200** | `frlm5ioojy2m` |
| 3 | Bucket listesi `GET /n/{ns}/b?compartmentId=<tenancy>` | **200** | **1 bucket** |
| 4 | Bucket HEAD `HEAD /n/{ns}/b/tezlify-ram-snapshots` | **200** | PASS |
| 5 | Bucket metadata `GET /n/{ns}/b/tezlify-ram-snapshots` | **200** | `NoPublicAccess` / `Enabled` / `Standard` |
| 6 | DG + policy gerçekten oluştu mu | — | user principal ile geri okundu (Bölüm 2–3) |
| 7 | Policy koşulu doğru bucket adıyla eşleşiyor mu | — | statement metni birebir |

**Önce/sonra karşılaştırması (aynı istek, aynı kimlik):**

| İstek | 3.9.9 | **3.9.10** |
|---|---|---|
| `GET /n/{ns}/b?compartmentId=<tenancy>` | **404** `NamespaceNotFound` | **200** |
| `HEAD /b/tezlify-ram-snapshots` | **404** | **200** |
| `GET /b/tezlify-ram-snapshots` | — | **200** |

Bu, 3.9.9'daki `404`'ün **gerçekten yetki maskesi** olduğunu kesinleştirir: kod değişmedi, kimlik değişmedi, yalnızca IAM değişti → yanıt 200 oldu.

---

## 6. IAM PROPAGATION

| Aşama | Deneme | Sonuç |
|---|---|---|
| Bucket listesi | **1. deneme** | **200** (anında) |
| Bucket metadata | **2. deneme** (~15 sn sonra) | **200** |
| Bucket HEAD | 1. deneme | **200** |

**Toplam bekleme:** ~15–30 sn. Maksimum 5 deneme sınırı **aşılmadı**; sonsuz polling veya timer **kurulmadı**.

İlk metadata denemesinin 404 dönmesi **yetki değil**, yeni oluşturulan bucket için **eventual consistency** idi — 15 sn sonra aynı istek 200 döndü.

---

## 7. HER API ÇAĞRISININ HTTP SONUCU

**Yönetim (user principal, yerel makineden):**

| İşlem | HTTP |
|---|---|
| `GET /n/` | 200 |
| `GET /20160918/dynamicGroups?compartmentId=<tenancy>` | 200 (0 kayıt) |
| `POST /20160918/dynamicGroups` | **200** (DG oluştu) |
| `GET /20160918/policies?compartmentId=<tenancy>` | 200 (0 kayıt) |
| `POST /20160918/policies` | **200** (policy oluştu) |
| `GET /n/{ns}/b/tezlify-ram-snapshots` | 404 (yok) |
| `POST /n/{ns}/b` | **200** (bucket oluştu) |
| Yeniden `GET` (3 kaynak) | 200 / 200 / 200 (kalıcı) |
| İkinci `apply --execute` | 200 — **3 SKIP** (idempotent, yazma yok) |

**Doğrulama (instance principal, üretimden):**

| İşlem | HTTP |
|---|---|
| `POST /v1/x509` | 200 |
| `GET /n/` | 200 |
| `GET /n/{ns}/b?compartmentId=<tenancy>` | 200 |
| `GET /n/{ns}/b/tezlify-ram-snapshots` | 200 |
| `HEAD /n/{ns}/b/tezlify-ram-snapshots` | 200 |

**Object Storage'a hiçbir nesne işlemi (PUT/GET/DELETE) yapılmadı.** Yalnızca bucket yönetimi.

---

## 8. BAŞARILI / BAŞARISIZ KONTROLLER

**Başarılı (10):** DG oluşturma · DG kuralı birebir · policy oluşturma · 2 statement birebir · bucket oluşturma · `NoPublicAccess` · versioning `Enabled` · bucket listesi 200 · bucket HEAD 200 · metadata eşleşmesi.

**Başarısız (0).**

**Test edilmeyen (bilinçli):**
- `manage objects` koşulunun **başka bucket'ı reddettiği** yazma testiyle **doğrulanmadı** — bu bir PUT denemesi gerektirirdi ve yasak. Koşul yalnızca **statement metni** üzerinden doğrulandı.
- Nesne yazma/okuma yolu canlı bucket'ta denenmedi (aktarım yasak).

---

## 9. ÜRETİM DEĞİŞİKLİK SAYACI

| Kategori | Sayı |
|---|---:|
| **Bulut kaynağı oluşturma (onaylı)** | **3** (1 DG + 1 policy + 1 bucket) |
| Bulut kaynağı silme/değiştirme | **0** |
| Object Storage nesne işlemi (PUT/GET/DELETE) | **0** |
| Snapshot upload / download | **0** |
| Gateway restart / recreate | **0** |
| Backend restart / recreate | **0** |
| DB restart | **0** |
| Caddy restart | **0** |
| Deploy / production kod değişikliği | **0** |
| DB `INSERT`/`UPDATE`/`DELETE` | **0** |
| Persistence aktivasyonu | **0** |
| `.env.production` / escrow / snapshot dosya değişikliği | **0** |
| Timer / cron | **0** |
| Git push | **0** |

**Not:** Bu aşamada **tek gerçek değişiklik bulut tarafındadır** (3 kaynak). Üretim VM'i, container'lar, veritabanı ve dosya sistemi **hiç değişmedi**.

**Yetki kaynağı:** IAM kaynaklarını **instance principal oluşturamaz** (3.9.9'da `policies`/`dynamicGroups` okumakta bile 404 alıyordu). Bu nedenle kurulum **yerel makinedeki user principal** (`~/.oci/config`, tenancy admin) ile yapıldı. Anahtar üretim VM'ine **kopyalanmadı**.

---

## 10. BAŞLANGIÇ / BİTİŞ KARŞILAŞTIRMASI

| Container | ID (başlangıç) | ID (bitiş) | `StartedAt` | Değişim |
|---|---|---|---|---|
| backend | `ce2e901b6619` | `ce2e901b6619` | `2026-10-29T21:47:56.536962458Z` | **yok** |
| gateway | `5b867095d376` | `5b867095d376` | `2026-10-27T17:25:57.8181699Z` | **yok** |
| db | `f6d79c4a1f8b` | `f6d79c4a1f8b` | `2026-10-01T17:45:08.260956885Z` | **yok** |
| caddy | `ee66a5cab371` | `ee66a5cab371` | `2026-10-12T13:12:45.795953636Z` | **yok** |

| Metrik | Başlangıç | Bitiş | Fark |
|---|---:|---:|---|
| conversations | 126 | **126** | 0 |
| messages | 2194 | **2194** | 0 |
| contacts | 1538 | **1538** | 0 |
| quarantine | 0 | **0** | 0 |
| Session 201 | `CONNECTED` | **`CONNECTED`** | 0 |
| Persistence | `config_enabled=false`, `runs=0` | **aynı** | 0 |
| `/health` | — | `healthy` | — |

**Dosya sistemi (değişmedi):**

| Yol | Mode | Sahip | Boyut |
|---|---|---|---|
| `/var/backups/tezlify-ram` | `700` | ubuntu:ubuntu | 4096 |
| `.key-escrow` | `600` | ubuntu:ubuntu | 90 |
| `.key-escrow-v2` | `600` | ubuntu:ubuntu | 88 |
| `…125657Z.rsnap` | `600` | ubuntu:ubuntu | 7.100.080 |
| `…125755Z.rsnap` | `600` | ubuntu:ubuntu | 7.100.080 |
| `…210007Z.rsnap` | `600` | ubuntu:ubuntu | 7.135.835 |
| `…220302Z.rsnap` | `600` | ubuntu:ubuntu | 7.147.070 |

**Snapshot SHA-256 (4 dosya, değişmedi):** `2a150698…` · `00f657b1…` · `fdafdb7b…` · `158794ed…`

---

## 11. AÇIK KALAN RİSKLER

| Risk | Önem | Durum |
|---|---|---|
| **Escrow hâlâ snapshot'larla aynı diskte** | **KRİTİK** | Açık — şifreli kurtarma tamam sayılmaz |
| **Off-site kopya yok** | **KRİTİK** | Açık — 0 nesne yüklendi |
| `manage objects` nesne **silmeye** de izin verir | Yüksek | Azaltıldı: versioning `Enabled` (silme kalıcı değil) + yükleme aracında `If-None-Match`. Tam çözüm: ayrı onaylı aşamada bucket policy/retention lock |
| Nesne yazma yolu canlıda test edilmedi | Orta | 3.9.11'de ilk yükleme ile test edilecek |
| Bucket'ta lifecycle/retention yok | Düşük | Onay kapsamı dışı; 27 MB için acil değil |
| User principal anahtarı geliştirici makinesinde (tenancy admin) | Orta | Üretimde **yok** (iyi); yine de yüksek değerli kimlik — ayrı ele alınmalı |
| 9 LID mesajı hâlâ kurtarılamadı | Yüksek | Değişmedi |
| Persistence kapalı | Yüksek | Değişmedi |

---

## 12. SONRAKİ AŞAMA ÖNERİSİ — 3.9.11

Sıra **aktarım**ta; ama ayrı onay gerektirir.

1. `upload --dry-run` → 8 nesne planı (4 `.rsnap` + 4 manifest), escrow bloklarının hâlâ bloke olduğunu doğrula
2. **Tek dosya** ile küçük kapsamlı deneme → uzaktan indir → SHA-256 karşılaştır
3. Başarılıysa kalan 7 nesne → her biri `VERIFIED`
4. `verify --download-check` → 8/8 eşleşme
5. Bucket'ın public erişime kapalı kaldığını tekrar doğrula
6. **Escrow ayrımı** — ayrı ve bağımsız konum (bucket **değil**)
7. Off-site'tan `:memory:` restore tatbikatı → `identity_root` eşleşmesi
8. Timer/otomasyon **ayrı onay** (bu aşamada kurulmayacak)

---

## TAMAMLANMA KRİTERLERİ

| # | Kriter | Durum | Kanıt |
|---|---|---|---|
| 1 | DG mevcut ve yalnızca hedef instance ile eşleşiyor | **PASS** | rule birebir, tek-kaynak GET |
| 2 | İki policy doğru root compartment'ta | **PASS** | policy geri okundu, 2 statement |
| 3 | `manage objects` yalnızca hedef bucket ile sınırlı | **PASS** | `where target.bucket.name='tezlify-ram-snapshots'` |
| 4 | Bucket mevcut | **PASS** | OCID alındı |
| 5 | `NoPublicAccess` | **PASS** | metadata |
| 6 | Versioning `Enabled` | **PASS** | metadata |
| 7 | Instance principal bucket listesi **200** | **PASS** | 1. deneme |
| 8 | Bucket HEAD **200** | **PASS** | — |
| 9 | Bucket OCID ve metadata beklenenle eşleşiyor | **PASS** | 6 alan karşılaştırıldı |
| 10 | Üretim WhatsApp oturumu ve RAM-only veriler korunmuş | **PASS** | 4 container sabit, session CONNECTED, sayaçlar sabit |

**Aşama sonucu: PASS (10/10).**

*Bu, off-site backup'ın tamamlandığı anlamına gelmez. Aktarım, uzak doğrulama, escrow ayrımı ve off-site restore sonraki onaylı aşamalardır.*

---

*Secret, token, private key, encryption key veya credential değerleri bu rapora yazılmadı. Gerçekleştirilmeyen işlemler başarılı gösterilmedi.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*
