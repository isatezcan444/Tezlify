# AŞAMA 3.9.9 — OCI IAM YETKİLENDİRME VE BUCKET ERİŞİMİNİN DOĞRULANMASI

**Tarih:** 2026-10-30 (ölçüm penceresi 09:10–09:30 UTC)
**Çalışma türü:** ALTYAPI (salt-okunur tanılama)
**Üretim:** `tezlify-oracle` / `eu-frankfurt-1`
**Production commit:** `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (değişmedi)
**Önceki aşama:** 3.9.8

**Tek cümle:** `404 NamespaceNotFound` **körü körüne "yetki yok" sayılmadı** — yedi hipotez ayrı isteklerle sınandı; sonuç **yetki gizleme (authz mask) doğrulandı**, ama kalan üç hipotez (dynamic group eşleşmesi / policy yokluğu / policy koşul uyuşmazlığı) **birbirinden ayırt edilemedi** çünkü principal IAM okuma yetkisine sahip değil. **0 kaynak oluşturuldu, 0 yazma yapıldı.**

---

## 1. INSTANCE PRINCIPAL DOĞRULAMASI — **PASS**

`scripts/backup/offsite_oci.py probe` + tanılama betiği ile ölçüldü.

| Öğe | Değer |
|---|---|
| Region | `eu-frankfurt-1` |
| Instance adı | `tezlify-oracle` |
| Shape | `VM.Standard.A1.Flex` |
| Instance OCID | `ocid1.instance.oc1.eu-frankfurt-1.antheljtzhfthiicm3e2y7hslvnc65afnkpknawogwctisk5yyv3b2jbxo2a` |
| Tenancy OCID | `ocid1.tenancy.oc1..aaaaaaaauvyjjnzy7z74yqu3bkohjoxoaniba7a7o2oxzz4qynmttbxw5pzq` |
| IMDS compartment | aynı OCID → **`tenancy == compartment` = True** |
| Sertifika tabanlı auth | `POST /v1/x509` → **200** |
| Token | alındı (uzunluk 2250) — **değer raporlanmadı** |
| İmza doğrulaması (dolaylı kanıt) | IAM `GET /compartments` → **200**; imza geçersiz olsaydı 401 dönerdi |

**Sonuç:** Kimlik doğrulama zinciri (IMDS → sertifika → token → imzalı API çağrısı) **uçtan uca çalışıyor**. Sorun kimlik doğrulama değil, **yetkilendirme**.

---

## 2. NAMESPACE DOĞRULAMASI — **PASS**

| İstek | Sonuç |
|---|---|
| `GET /n/` | **HTTP 200** → namespace `frlm5ioojy2m` |

**Kritik çıkarım:** Namespace **kanıtlanmış biçimde var**. Dolayısıyla daha sonra alınan `NamespaceNotFound` yanıtı **harfiyen doğru olamaz** — bu, 4. bölümdeki ayırmanın temelidir.

---

## 3. BUCKET SORGUSU — **NOT VERIFIED**

| İstek | HTTP | Gövde (kısalt.) |
|---|---|---|
| `GET /n/{ns}/b?compartmentId=<tenancy>` | **404** | `NamespaceNotFound` |
| `GET /n/{ns}/b?compartmentId=<tenancy>&limit=1` | **404** | `NamespaceNotFound` |
| `HEAD /n/{ns}/b/tezlify-ram-snapshots` | **404** | (gövde yok) |

**Yorum:** `HEAD` 404'ü **bucket'ın yokluğunu da yetkisizliği de** temsil edebilir; OCI bu ikisini ayırt ettirmez. Bu nedenle:

- `tezlify-ram-snapshots` **var mı?** → **NOT VERIFIED**
- Bucket **yok** demek de yanlış olur; **var** demek de.

Bucket adı ve compartment bilgisi operatörden gelmeden tahmin **yapılmadı** (talimat gereği).

---

## 4. IAM HATA AYRIMI — **PASS (ayrım yapıldı)**

Her hipotez ayrı bir istekle sınandı. Hiçbiri tek bir "yetki yok" başlığı altında birleştirilmedi.

| # | Hipotez | Sınama | Gözlem | Karar |
|---|---|---|---|---|
| 1 | Yanlış / eksik compartment OCID | Geçersiz OCID (`ocid1.compartment.oc1..aaaa…`) ile aynı istek | **Birebir aynı 404 `NamespaceNotFound`** | **ELENDİ** — compartment doğruluğu yanıtı değiştirmiyor |
| 2 | Yanlış namespace | `GET /n/` | **200**, `frlm5ioojy2m` | **ELENDİ** — namespace geçerli |
| 3 | Dynamic group eşleşme hatası | `GET /20160918/dynamicGroups` | **404 `NotAuthorizedOrNotFound`** | **DOĞRULANAMADI** — okuma yetkisi yok |
| 4 | Policy bulunmaması | `GET /20160918/policies` | **404 `NotAuthorizedOrNotFound`** | **DOĞRULANAMADI** |
| 5 | Policy yanlış compartment kapsamında | `GET /20160918/compartments?compartmentId=<tenancy>` | **200, liste uzunluğu 0** | **ELENDİ (kapsam olarak)** — tenancy altında **hiç alt compartment yok**; policy konabilecek başka compartment mevcut değil |
| 6 | Principal policy kapsamına dahil değil | — | 3/4 ile aynı gözlem | **DOĞRULANAMADI** |
| 7 | Object Storage'ın yetki gizleme davranışı | (a) namespace'in varlığı kanıtlıyken `NamespaceNotFound`; (b) geçersiz compartment'ta **aynı** yanıt; (c) compartment'sız istekte **400 `MissingCompartmentId`** | (a)+(b)+(c) birlikte | **DOĞRULANDI** |

### 4.1 Neden 7 doğrulandı, 3/4/6 doğrulanamadı

**Doğrulanan kısım:**
- `GET /n/{ns}/b` **compartment'sız** çağrıldığında **400 `MissingCompartmentId`** dönüyor → uç nokta isteği **parse ediyor ve doğruluyor**. Yani 404, bozuk istekten gelmiyor.
- **Geçersiz** compartment OCID'i ile **geçerli** tenancy OCID'i **birebir aynı** yanıtı veriyor → 404, compartment'ın gerçekliğine bağlı değil.
- Namespace'in var olduğu `GET /n/` ile kanıtlı → `NamespaceNotFound` yanlış etiket.
- Aynı imzalı oturumla IAM `GET /compartments` **200** dönüyor → imza ve token sağlam.

Bu dördü birlikte, yanıtın **yetkilendirme maskesi** olduğunu kanıtlar. OCI, yetkisiz erişimi kaynak yokmuş gibi gizler (bilgi sızdırmamak için).

**Doğrulanamayan kısım:**
- `dynamicGroups`, `policies` uç noktaları principal'a **kapalı** (404 `NotAuthorizedOrNotFound`).
- Bu nedenle "dynamic group var mı / kuralı eşleşiyor mu", "policy var mı / koşulu ne" **ölçülemiyor**.
- Kalan üç hipotez (**3, 4, 6**) **gözlemlenebilir olarak birbirinin aynısı** → ayrım için IAM okuma yetkisi veya OCI Console gerekir.

### 4.2 Ek gözlem — maskeleme uç noktaya özgü

| Uç nokta | Eksik parametreye verilen yanıt |
|---|---|
| `GET /n/{ns}/b` | **400 `MissingCompartmentId`** |
| `GET /n/{ns}/` (namespace metadata) | **404 `CompartmentIdNotFound`** |

İki farklı uç nokta, aynı eksik parametreye **iki farklı maskelenmiş kod** döndürüyor. Bu, "kod adı = gerçek sebep" varsayımının bu API'de geçersiz olduğunu gösterir.

---

## 5. DYNAMIC GROUP DURUMU — **NOT VERIFIED**

| Kontrol | Sonuç |
|---|---|
| `GET /20160918/dynamicGroups?compartmentId=<tenancy>` | **404 `NotAuthorizedOrNotFound`** |
| `tezlify-offsite-dg` mevcut mu? | **Bilinmiyor** |
| Kural `instance.id = '<INSTANCE_OCID>'` eşleşiyor mu? | **Bilinmiyor** |

**Dolaylı kanıt (kanıt değil, işaret):** Principal, bucket okuma yetkisine sahip değil. Bu, "dynamic group yok" veya "var ama policy yok" ile tutarlıdır — ikisi de aynı gözlemi üretir. **Karar: NOT VERIFIED.**

**Oluşturulmadı / değiştirilmedi** (talimat gereği onay bekleniyor).

---

## 6. POLICY DURUMU — **NOT VERIFIED**

| Kontrol | Sonuç |
|---|---|
| `GET /20160918/policies?compartmentId=<tenancy>` | **404 `NotAuthorizedOrNotFound`** |
| Mevcut policy metinleri | **Okunamadı** |
| `read buckets` izni var mı? | **Dolaylı: YOK** (bucket listesi maskeli 404) |
| `manage objects` izni var mı? | **Bilinmiyor** (bucket adı olmadan test edilemez) |

---

## 7. COMPARTMENT DOĞRULAMASI — **PASS**

| Kontrol | Sonuç |
|---|---|
| Instance'ın compartment'ı (IMDS) | `ocid1.tenancy.oc1..aaaaaaaauvyjjnzy7z74yqu3bkohjoxoaniba7a7o2oxzz4qynmttbxw5pzq` |
| Sertifikadaki `opc-compartment` | **aynı OCID** |
| `GET /20160918/compartments?compartmentId=<tenancy>` | **200**, liste uzunluğu **0** |
| `GET /20160918/tenancies/<tenancy>` | **200** |
| Sonuç | **Compartment = tenancy kökü (root)**; alt compartment **yok** |

**Önemi:** Policy için "COMPARTMENT_NAME" tartışması kapanır — konabilecek tek yer **kök compartment**'tır. 5. hipotezin (yanlış compartment) elenmesi bu ölçüme dayanır.

---

## 8. BUCKET OLUŞTURMA ENGELİ — **BLOCKED**

| Gereksinim | Durum |
|---|---|
| Bucket oluşturma izni | **YOK** — kullanıcı onayı verilmedi |
| IAM değişikliği izni | **YOK** |
| Principal'ın bucket oluşturma yetkisi | **YOK** (yetki maskeli 404) |

**Yapılmayanlar (talimat gereği):** bucket oluşturma · mevcut bucket değiştirme · versioning değiştirme · lifecycle oluşturma · kaynak silme · IAM kaydı oluşturma.

### 8.1 Önerilen yapılandırma (onay bekliyor)

**Dynamic group:** `tezlify-offsite-dg`
```
instance.id = 'ocid1.instance.oc1.eu-frankfurt-1.antheljtzhfthiicm3e2y7hslvnc65afnkpknawogwctisk5yyv3b2jbxo2a'
```

**Policy (kök compartment):**
```
Allow dynamic-group tezlify-offsite-dg to read buckets in compartment <TENANCY_OCID>
Allow dynamic-group tezlify-offsite-dg to manage objects in compartment <TENANCY_OCID> where target.bucket.name = 'tezlify-ram-snapshots'
```

**En az yetki gerekçesi:**
- `read buckets` — yalnızca bucket doğrulama (`HEAD` / listeleme) için; nesne yazma vermez.
- `manage objects` — OCI'da nesne yazma için mevcut en dar verb; `where target.bucket.name=…` koşuluyla **tek bucket'a** kısıtlanır, tenancy'deki diğer bucket'lar kapsam dışı kalır.
- `manage buckets` **verilmiyor** → principal bucket **oluşturamaz/silemez**, yalnızca içine nesne yazar.

**Bucket (onay bekliyor):** `tezlify-ram-snapshots` · `NoPublicAccess` · versioning `Enabled` · tier `Standard` · prefix `tezlify/whatsapp/ram-snapshots`.

---

## 9. GÜVENLİK DEĞERLENDİRMESİ — **PASS**

| Konu | Durum |
|---|---|
| Secret / token / private key çıktıya yazıldı mı | **Hayır** — yalnızca uzunluk ve durum kodları |
| Anahtar değeri rapora girdi mi | **Hayır** |
| Object Storage'a yazma (PUT/POST/DELETE) | **0** |
| IAM kaynağı oluşturma/değiştirme | **0** |
| Cloud kaynak oluşturma/silme | **0** |
| TLS doğrulaması | Açık (`create_default_context`) |
| Principal yetkisi | **Daralmış durumda** — bucket yazma yetkisi henüz verilmedi (istenen durum) |
| Escrow | Bucket'a konmadı; araç kod seviyesinde bloke ediyor |

**Risk notu:** Önerilen `manage objects` policy'si verildiğinde principal **yalnızca o bucket'a** yazabilecek. `manage buckets` verilmediği için bucket silme/oluşturma mümkün olmayacak. Escrow yine **bucket dışında** tutulmalı.

---

## 10. ÜRETİM DEĞİŞİKLİK SAYACI — **PASS (0)**

| İşlem | Sayı |
|---|---:|
| Gateway restart / recreate | **0** |
| Backend restart / recreate | **0** |
| DB restart | **0** |
| Caddy restart | **0** |
| Deploy | **0** |
| DB `INSERT`/`UPDATE`/`DELETE` | **0** |
| Persistence aktivasyonu | **0** |
| Escrow taşıma / silme | **0** |
| Snapshot taşıma / silme | **0** |
| V1 escrow temizliği | **0** |
| Timer kurulumu | **0** |
| Bucket / IAM / cloud kaynak değişikliği | **0** |
| Snapshot upload / download | **0** |

**Ağ çağrıları:** yalnızca kimlik doğrulama POST'ları ve salt-okunur `GET`/`HEAD`. **Hiçbir `PUT`/`DELETE` yok.**

### Başlangıç / bitiş karşılaştırması

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
| `/health` | — | `status=healthy` | — |
| Snapshot SHA-256 (4 dosya) | `2a150698…`, `00f657b1…`, `fdafdb7b…`, `158794ed…` | **aynı** | 0 |

**Gateway aynı container, session `CONNECTED`, RAM-only mesajlara dokunulmadı.**

---

## 11. SONRAKİ ADIM — 3.9.10

### Operatör kararı gereken tek şey

Bu aşama **teknik olarak tıkandı**: kalan üç hipotezi ayırt etmek için ya IAM okuma yetkisi ya da doğrudan policy'nin verilmesi gerekiyor. İkisi de **onay** gerektirir.

**Seçenek A — IAM'i ben kurayım (önerilen):**
1. `tezlify-offsite-dg` dynamic group (kural yukarıda, instance OCID hazır)
2. İki policy satırı (kök compartment)
3. Bucket `tezlify-ram-snapshots` (`NoPublicAccess`, versioning on)
4. Doğrulama: `probe` → `bucket_list = 200` + `HEAD bucket = 200`

**Seçenek B — Sen kur, ben doğrularım:**
Sen Console'da oluşturursun; ben `probe` + `HEAD` + metadata ile doğrularım (salt-okunur).

**Seçenek C — Sadece bucket adını ver:**
Bucket zaten varsa, IAM'e dokunmadan `HEAD /b/<ad>` ile erişimi test ederim. 200 dönerse policy zaten doğru.

### 3.9.10 tamamlanma tanımı
- `probe` → `bucket_list = HTTP 200` **ve** beklenen bucket kimliği
- `HEAD bucket` → 200, `publicAccessType = NoPublicAccess`, versioning `Enabled`
- **Aktarım yine yapılmayacak** (o 3.9.11, ayrı onay)

---

## KABUL KRİTERLERİ

| # | Madde | Durum | Kanıt |
|---|---|---|---|
| 1 | Instance principal doğrulaması | **PASS** | token 200, IAM `/compartments` 200 |
| 2 | Namespace doğrulaması | **PASS** | `GET /n/` 200 → `frlm5ioojy2m` |
| 3 | Bucket sorgusu | **NOT VERIFIED** | 404 maskeli; varlık/yokluk ayırt edilemiyor |
| 4 | IAM hata ayrımı | **PASS** | 7 hipotez ayrı sınandı; 2 elendi, 1 doğrulandı, 3 ayırt edilemedi |
| 5 | Dynamic group durumu | **NOT VERIFIED** | `dynamicGroups` 404 |
| 6 | Policy durumu | **NOT VERIFIED** | `policies` 404 |
| 7 | Compartment doğrulaması | **PASS** | root = tenancy, 0 alt compartment |
| 8 | Bucket oluşturma | **BLOCKED** | izin yok |
| 9 | Güvenlik değerlendirmesi | **PASS** | 0 secret, 0 yazma |
| 10 | Üretim değişiklik sayacı | **PASS** | 0 |
| 11 | Sonraki adım | **PASS** | 3 seçenek sunuldu |

**Özet: 6 PASS · 3 NOT VERIFIED · 1 BLOCKED.** Aşama **tamamlanmadı** — engel **IAM onayı**, teknik belirsizlik değil.

---

*Secret, token, access key, private key veya encryption key bu rapora yazılmadı. Gerçekleştirilmeyen işlemler başarılı gösterilmedi. Snapshot aktarımı yapılmadı.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*
