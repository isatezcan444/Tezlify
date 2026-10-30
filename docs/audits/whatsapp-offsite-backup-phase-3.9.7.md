# AŞAMA 3.9.7 — OFF-SITE BACKUP HAZIRLIĞI VE GÜVENLİ AKTARIM

**Tarih:** 2026-10-30 (ölçüm penceresi 08:33–08:42 UTC)
**Mod:** Altyapı + salt-okunur doğrulama (aktarım yapılmadı)
**Önceki aşama:** 3.9.6 — off-site mimari tasarımı
**Üretim commit'i:** `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (deployed, değişmedi)
**Ölçüm yeri:** `tezlify-oracle` (`130.162.247.20`), SSH üzerinden salt-okunur
**Sonuç:** Envanter ve kriptografik doğrulama **tamamlandı (4/4)**. Off-site hedefi **kurulamadı** — operatörden hedef + yetki bilgisi bekleniyor. **Hiçbir aktarım, silme, taşıma, restart veya cloud kaynak oluşturma yapılmadı.**

---

## 1. YÖNETİCİ ÖZETİ

| Soru | Cevap |
|---|---|
| Snapshot'lar sağlam mı? | **Evet** — 4/4 `ok: true`, 0 problem, 0 duplicate |
| Şifreleme anahtarı doğru mu? | **Evet** — `.key-escrow-v2` (64 karakter) 4/4 snapshot'ı açıyor |
| Off-site kopya var mı? | **Hayır** — tek fiziksel konum (`/var/backups`, `/dev/sda1`) |
| OCI Object Storage erişimi var mı? | **Hayır** — CLI yok, `~/.oci` yok, `.env.production`'da OCI değişkeni yok, uygulamada OCI kullanımı yok |
| Bucket mevcut mu? | **Uygulama tarafında yok.** Tenancy genelinde tarama **yetkisiz** (kimlik bilgisi yok) |
| Aktarım yapıldı mı? | **Hayır** — hedef ve onay yok (talimat gereği duruldu) |
| Üretim değişti mi? | **Hayır** — 0 restart, 0 write, 0 deploy, 0 cloud kaynak |

**Kritik bulgu:** Snapshot'lar ve escrow anahtarı **aynı diskte, aynı dizinde** (`/var/backups/tezlify-ram/`, `700`). Disk veya VM kaybı = şifreli veri **ve** anahtarın birlikte kaybı. Şifreleme bu kurulumda tek başına koruma sağlamıyor; **tek nokta arıza gerçek ve ölçülmüş.**

**İkincil bulgu:** 4 snapshot'ın **2'si içerik olarak birebir aynı** (`125657Z` ve `125755Z`: aynı `records_sha256`, aynı `identity_root_sha256`). Farklı dosya hash'i yalnızca rastgele nonce'tan geliyor. Off-site'a **3 benzersiz yük** taşınması yeterli.

---

## 2. ÖLÇÜM YÖNTEMİ VE KAPSAM

- Yerel makinede **Docker yok**; tüm üretim ölçümleri `ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20` üzerinden yapıldı.
- Kullanılan komutlar: `ls`, `stat`, `sha256sum`, `df`, `lsblk`, `crontab -l`, `systemctl list-timers`, `curl` (IMDS + TLS), `docker ps/inspect` (salt okunur), `psql SELECT`.
- **Hiçbir yazma işlemi yapılmadı:** `docker restart/recreate`, `INSERT/UPDATE/DELETE`, dosya silme/taşıma, `chmod`, paket kurulumu, cloud API çağrısı — hepsi **0**.
- Anahtar değeri hiçbir çıktıya veya bu rapora yazılmadı. Yalnızca **uzunluk** ve **SHA-256 ilk 8 karakter parmak izi** raporlandı.

---

## 3. SNAPSHOT ENVANTERİ

**Konum:** `/var/backups/tezlify-ram/` — `700 ubuntu:ubuntu`
**Birim:** `/dev/sda1` (96 GB, %47 dolu, 52 GB boş) — **tek disk**

| Dosya | Boyut (B) | SHA-256 (tam) | Mode |
|---|---:|---|---|
| `tezlify-ram-20261029T125657Z.rsnap` | 7.100.080 | `2a150698a884dc9c62de98f9f36366439ef13f3ba0799f0940609effa59e1f8e` | `600` |
| `tezlify-ram-20261029T125755Z.rsnap` | 7.100.080 | `00f657b17eda030194dc76e99fb23fe6bb7ea4f0e443b9a108d038520a595e07` | `600` |
| `tezlify-ram-20261029T210007Z.rsnap` | 7.135.835 | `fdafdb7b3c7cdb647c89d899e4a2a322f6d4b3883559b30a1f5212fd67e17fcb` | `600` |
| `tezlify-ram-20261029T220302Z.rsnap` | 7.147.070 | `158794ed6ba7f9646876f1b64481e29b5001c0f282f250c4ed33b4caa41126cd` | `600` |

**Toplam:** 4 `.rsnap` = **28.483.065 B (~27,2 MiB)** + 4 `.manifest.json` (12.199 / 12.199 / 12.316 / 12.316 B).

Bu değerler 3.9.6 raporundaki değerlerle **birebir aynı** — snapshot'lar 3.9.6'dan bu yana değişmemiş, bozulmamış.

---

## 4. SHA-256 VE BÜTÜNLÜK DOĞRULAMASI

`ram_snapshot.py --verify` ile, anahtar `.key-escrow-v2`'den ortam değişkenine alınarak (değer basılmadan) çalıştırıldı:

| Snapshot | `ok` | Kayıt | Sohbet | Duplicate | `records_sha256` (kısalt.) | `identity_root_sha256` (kısalt.) |
|---|---|---:|---:|---:|---|---|
| `…125657Z` | **true** | 9137 | 99 | 0 | `e035fd80…` | `400dba30…` |
| `…125755Z` | **true** | 9137 | 99 | 0 | `e035fd80…` | `400dba30…` |
| `…210007Z` | **true** | 9139 | 100 | 0 | `09f637b8…` | `743f5959…` |
| `…220302Z` | **true** | 9139 | 100 | 0 | `5a42a953…` | `4d689bd8…` |

- Her dört dosyada `problems: []`, `integrity_problems: []`, `completeness_problems: []`.
- **Son snapshot (`…220302Z`): 9139 kayıt / 100 sohbet** — 3.9.1'de alınan güncel snapshot.
- `125657Z` ile `125755Z` **aynı düz metni** taşıyor (aynı `records_sha256` + aynı `identity_root_sha256`); farklı dosya hash'i yalnızca AES-GCM nonce farkından. → **benzersiz yük sayısı 4 değil, 3.**

---

## 5. V2 ESCROW DOĞRULAMASI

Anahtar hiçbir yerde açık yazılmadı; yalnızca yapısal parmak izi ölçüldü.

| Kaynak | Yol | Ham bayt | Kırpılmış uzunluk | Değer uzunluğu | Tırnak | `fp8` |
|---|---|---:|---:|---:|---|---|
| Escrow v1 | `/var/backups/tezlify-ram/.key-escrow` | 90 | 89 | **66** | **var** | `c44e0261` |
| Escrow v2 | `/var/backups/tezlify-ram/.key-escrow-v2` | 88 | 87 | **64** | yok | `c25805a2` |
| Canonical | `/opt/tezlify/.env.production` (`600`, 1581 B) | — | — | **66** | **var** | `c44e0261` |

**Yorum:**
- `.env.production`'daki değer **tırnaklı** olduğu için 66 karakter; escrow v1 (`cut` ile alınmış) aynı 66 karakterlik tırnaklı diziyi saklıyor → **v1 yanlış anahtar** (3.9.3 bulgusu bu ölçümle **yeniden doğrulandı**).
- Docker Compose tırnakları çıkardığı için container'a giden **etkin** değer 64 karakterdir; `.key-escrow-v2` (64, `c25805a2`) bu değerdir.
- **Kanıt:** v2 anahtarıyla 4/4 snapshot `ok: true`. Yanlış anahtar AES-GCM'de auth tag hatası verir; 4/4 başarı = anahtar doğru.
- **v1 dosyası hâlâ duruyor** (yanlış anahtar, `600`). Operatör karışıklığı riski → silinmesi önerilir (bu aşamada **silinmedi**, talimat gereği).

---

## 6. OCI ERİŞİM DURUMU

| Kontrol | Sonuç |
|---|---|
| `oci` CLI | **YOK** |
| `~/.oci/config` | **YOK** |
| `rclone` / `aws` / `s3cmd` / `restic` | **Hiçbiri yok** |
| IMDS (`169.254.169.254/opc/v2/instance/`) | **HTTP 200** (instance principal teknik olarak mümkün) |
| Instance kimliği | `tezlify-oracle`, `VM.Standard.A1.Flex`, `eu-frankfurt-1`, AD-1 |
| Tenancy | `ocid1.tenancy.oc1..aaaaaaaauvyjjnzy7z74yqu3bkohjoxoaniba7a7o2oxzz4qynmttbxw5pzq` |
| Instance OCID | `ocid1.instance.oc1.eu-frankfurt-1.antheljtzhfthiicm3e2y7hslvnc65afnkpknawogwctisk5yyv3b2jbxo2a` |
| Dışa çıkış (TLS) | `https://objectstorage.eu-frankfurt-1.oraclecloud.com` → **HTTP 404**, `ssl_verify_result=0` (uç nokta canlı, sertifika geçerli) |
| Uygulamada OCI kullanımı | **Yok** — `backend/` ve `whatsapp-gateway/` içinde `objectstorage`/`oci_` izi yok |
| `.env.production` OCI değişkenleri | **Yok** — 25 anahtarın hiçbiri OCI/object storage değil |

**Sonuç:** Instance principal için gereken **dinamik grup + policy** tenancy'de tanımlı mı, bu oturumda **doğrulanamadı** (imzalı istek atabilmek için OCI SDK/CLI veya policy bilgisi gerekir; üretime paket kurmak "production değişmemeli" kısıtına aykırı olduğu için yapılmadı). IMDS'in açık olması yalnızca *potansiyeli* kanıtlar, *yetkiyi* kanıtlamaz.

---

## 7. BUCKET MEVCUT MU?

**Uygulama tarafında: HAYIR.** Kod tabanında ve `.env.production`'da hiçbir Object Storage referansı yok; Tezlify hiçbir bulut depolama kullanmıyor (medya dosyaları yerel `uploads/` + DB'de).

**Tenancy genelinde: DOĞRULANAMADI.** Kimlik bilgisi olmadığı için bucket listesi alınamadı. Bu bir *kusur* değil, *yetki yokluğu* — ve talimat gereği **bucket oluşturulmadı**.

→ Hedef seçimi tamamen operatöre bağlı. Bu raporun 8. ve 10. bölümleri karar için hazır.

---

## 8. ÖNERİLEN HEDEF

Gereksinim: **VM dışında**, TLS, düşük maliyet, 27 MiB + büyüme, geri yükleme denenebilir.

| Seçenek | Artı | Eksi | 27 MiB maliyet | Tavsiye |
|---|---|---|---|---|
| **A. OCI Object Storage** (eu-frankfurt-1) | Aynı tenancy, native, versiyonlama + lifecycle, Always Free 20 GB, ek araç yok | Aynı hesap = hesap ele geçirilirse snapshot'a da erişilir (escrow ayrıysa şifreli kalır) | **€0** (free tier) | **Birincil** |
| **B. S3-uyumlu** (Backblaze B2 / Cloudflare R2 / Wasabi) | Farklı sağlayıcı = bağımsız arıza alanı, S3 API, ucuz | Yeni hesap + yeni kimlik bilgisi; B2/R2 egress ücretsiz | **~€0** (min. fatura altı) | **İkincil / sağlayıcı bağımsızlığı** |
| **C. SFTP** (ikinci sunucu/VM) | En basit, araç zaten var (`rsync`/`scp`) | İkinci sunucu bakımı; "off-site" ancak farklı sağlayıcı/lokasyonsa gerçek | Sunucu maliyeti | Yedek plan |

**Öneri:** **A birincil + B ikincil.** A tek başına disk/VM kaybını çözer; B hesap düzeyi bağımsızlık ekler. İkisi de 27 MiB için pratikte ücretsiz.

**Kritik tasarım kuralı:** Escrow anahtarı **snapshot ile aynı yere konmaz.** Snapshot bucket'ta, escrow ayrı bir secret store'da (parola yöneticisi / basılı kopya / farklı sağlayıcı). Aksi halde şifreleme kâğıt üstünde kalır.

---

## 9. GÜVENLİ AKTARIM TASARIMI

### 9.1 Mimari

```
[tezlify-oracle]                                [Off-site]
/var/backups/tezlify-ram/*.rsnap  ──TLS──►  bucket: tezlify-ram-snapshots/
        (kaynak, salt-okunur)                └─ 2026/10/29/*.rsnap
                                             └─ *.manifest.json
/var/backups/tezlify-ram/.key-escrow-v2 ──►  AYRI secret store (bucket DEĞİL)
```

### 9.2 Aktarım akışı (idempotent, fail-closed)

1. **Ön kontrol:** hedef yapılandırması ve kimlik bilgisi mevcut mu? Değilse **exit 2**, hiçbir şey yapma.
2. **Yerel hash:** her `.rsnap` için `sha256sum` + boyut. Manifest de aynı şekilde.
3. **Uzak kontrol:** nesne anahtarı = dosya adı (içerik değişmez). Uzakta varsa ve `sha256` metadata'sı eşleşiyorsa → **atla (idempotent)**.
4. **Yükle:** TLS üzerinden, tek parça (<100 MB olduğu için multipart gerekmez).
5. **Doğrula:** uzaktan **tekrar indir** (veya `HEAD` + `x-amz-meta-sha256` ile karşılaştır; tercih: ilk aktarımda tam indirme) → `sha256` eşleşmezse **exit 1**.
6. **Audit log:** `~/.local/state/tezlify-offsite/transfer.jsonl` — `ts, file, bytes, sha256, target, action(skip|upload|verify), result`. **Anahtar/secret asla yazılmaz.**
7. **Hata durumu:** kaynak dosya **asla** silinmez/taşınmaz; kısmi uzak nesne silinir; çıkış kodu ≠ 0.
8. **Escrow ayrı iş:** snapshot aktarımından **bağımsız**, farklı hedefe, farklı kimlik bilgisiyle.

### 9.3 Araç seçimi

| Hedef | Araç | Gerekçe |
|---|---|---|
| OCI Object Storage | `rclone` (`s3` backend + S3-compatible endpoint) veya `oci os object put` | `rclone` tek araçla A+B'yi kapsar, `--checksum` ve `copy --immutable` destekler |
| S3-uyumlu | `rclone` | Aynı |
| SFTP | `rsync -a --checksum` + `ssh` | Ek kurulum yok |

**Not:** `rclone` şu an üretimde **yok**. Kurulum bir üretim değişikliğidir → **operatör onayı gerekir**. Onay gelmeden kurulmayacak.

### 9.4 Otomasyon

- `systemd` timer (cron'dan tercih edilir: log + failure durumu görünür).
- Öneri: **günlük 03:30 UTC** snapshot + aktarım; **haftalık** bütünlük doğrulaması (`--verify`).
- Saklama: son **14 günlük** snapshot off-site; yerelde son 7 (disk 52 GB boş, baskı yok).

---

## 10. GEREKLİ KULLANICI BİLGİLERİ

Aktarım için bunlar olmadan ilerlenemez:

1. **Hedef tipi:** OCI Object Storage / S3-uyumlu (B2, R2, Wasabi) / SFTP.
2. **Bucket adı + bölge + endpoint** (S3-uyumlu ise).
3. **Kimlik bilgisi:** erişim anahtarı + secret **veya** "instance principal kullan" onayı (bunu seçersen tenancy'de dinamik grup + policy tanımlaman gerekir; ben tanımlayamam).
4. **Cloud kaynak oluşturma onayı:** bucket'ı sen mi açacaksın, ben mi açayım? (Talimat gereği onaysız açılmadı.)
5. **Escrow'un nereye gideceği:** hangi secret store / fiziksel konum (bucket'tan **ayrı** olmalı).
6. **Saklama politikası:** kaç gün / kaç kopya.
7. **`rclone` kurulum onayı** (üretim VM'ine paket kurulumu).
8. **Zamanlama onayı:** günlük timer kurulsun mu, yoksa manuel mi çalışsın.

---

## 11. MALİYET VE GÜVENLİK DEĞERLENDİRMESİ

**Maliyet**

| Kalem | Tutar |
|---|---|
| Mevcut yük (27,2 MiB) | ~€0 |
| 14 günlük saklama (~7 MiB/gün × 14 ≈ 100 MiB) | ~€0 (OCI Always Free 20 GB; B2/R2 minimum fatura altı) |
| API istekleri (günlük ~10 istek) | ~€0 (free tier 50k/ay) |
| **Toplam ek maliyet** | **≈ €0/ay** |

**Güvenlik**

| Konu | Durum | Aksiyon |
|---|---|---|
| Aktarımda şifreleme | TLS 1.2+ (uç nokta doğrulandı) | Zorunlu, `--no-check-certificate` yasak |
| Durağan şifreleme | AES-256-GCM (snapshot seviyesinde) | Korunuyor |
| Anahtar ayrımı | **ŞU AN İHLAL** (snapshot + escrow aynı dizin) | Escrow ayrı konuma |
| Anahtar sızıntısı | Bu oturumda 0 (yalnızca uzunluk/fp) | Loglarda secret yasağı |
| Erişim | Bucket'a yalnızca yazma+okuma; public erişim **kapalı** | Bucket policy |
| Versiyonlama | Önerilir (yanlışlıkla üzerine yazma) | Bucket'ta aç |
| Faturalama koruması | Lifecycle: 30 günden eski nesilleri sil | Bucket lifecycle |
| Felaket senaryosu | VM+disk kaybı → snapshot yok | Off-site bunu çözer |

---

## 12. PRODUCTION DEĞİŞİKLİK SAYACI

| İşlem | Sayı |
|---|---:|
| Gateway restart / recreate | **0** |
| Backend restart / recreate | **0** |
| DB restart | **0** |
| Caddy restart | **0** |
| DB `INSERT`/`UPDATE`/`DELETE` | **0** |
| Deploy / `docker compose up` | **0** |
| Dosya silme / taşıma / `chmod` | **0** |
| Paket kurulumu | **0** |
| Cloud kaynak oluşturma | **0** |
| Off-site aktarım | **0** |
| **Toplam yazma işlemi** | **0** |

**Değişmediğinin kanıtı (oturum boyunca sabit):**

| Container | ID | `StartedAt` |
|---|---|---|
| backend | `ce2e901b6619` | `2026-10-29T21:47:56.536962458Z` |
| gateway | `5b867095d376` | `2026-10-27T17:25:57.8181699Z` |
| db | `f6d79c4a1f8b` | `2026-10-01T17:45:08.260956885Z` |
| caddy | `ee66a5cab371` | `2026-10-12T13:12:45.795953636Z` |

`.deployed-commit` = `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` — 3.8.9 ile aynı.

**Canlı baz ölçümü (yeni, salt-okunur):**

| Metrik | 3.8.9 raporu | **3.9.7 ölçümü** | Fark |
|---|---:|---:|---|
| `conversations` | 125 | **126** | +1 |
| `messages` | 2151 | **2185** | +34 |
| `contacts` | 1537 | **1538** | +1 |
| `whatsapp_sessions` (aktif) | 1 | **1** | 0 |
| `whatsapp_identity_quarantine` | 0 | **0** | 0 |
| Session 201 | `CONNECTED` | **`CONNECTED`** | 0 |

Fark **canlı ingest** kaynaklı (yeni bir sohbet + kişi mesaj attı). **Kayıp yok**; tüm sayımlar arttı veya sabit kaldı. Karantina defteri hâlâ boş — yeni hayalet oluşmamış.

---

## 13. KABUL KRİTERLERİ

| Kriter | Durum | Kanıt |
|---|---|---|
| Snapshot'lar doğrulanmış | **PASS** | 4/4 `ok:true`, 0 problem |
| Mevcut cloud erişimi incelenmiş | **PASS** | CLI/config/env/kod taraması — erişim yok |
| Hedef bucket durumu kesinleştirilmiş | **PASS (kısmi)** | Uygulama tarafında **yok**; tenancy taraması yetkisiz → hedef operatöre bağlı |
| Aktarım planı hazırlanmış | **PASS** | Bölüm 9 |
| Production değişmemiş | **PASS** | Bölüm 12 — 0 yazma, StartedAt sabit |
| Secret sızıntısı olmamış | **PASS** | Yalnızca uzunluk + `fp8`; değer basılmadı |
| Rapor oluşturulmuş | **PASS** | Bu dosya |

**Aktarım:** hedef + onay yok → **yapılmadı** (talimat gereği duruldu).

---

## 14. SONRAKİ AŞAMA PLANI (3.9.8)

Operatörden Bölüm 10 bilgileri geldiğinde:

1. **Hedef doğrula** — bucket erişimi `HEAD`/`ls` ile; yazma testi **tek küçük nesne** ile (snapshot değil).
2. **`rclone` kur** (onayla) — `~/.config/rclone/rclone.conf` `600`, kimlik bilgisi **komut satırına yazılmaz**.
3. **İlk aktarım** — 3 benzersiz `.rsnap` + manifest'ler; her biri SHA-256 ile iki yönlü doğrulanır.
4. **Geri yükleme tatbikatı** — uzaktan indir → `--verify` → `:memory:` geri yükleme → `identity_root_sha256` eşleşmesi.
5. **Escrow ayrımı** — `.key-escrow-v2` ayrı secret store'a; bucket'ta **asla** bulunmaz.
6. **Otomasyon** — systemd timer + JSONL audit log + `OnFailure` bildirimi.
7. **V1 escrow temizliği** — `.key-escrow` (yanlış anahtar) silinir (ayrı onay).
8. **Rapor** — `whatsapp-offsite-backup-phase-3.9.8.md`, gerçek transfer süreleri ve hash'lerle.

---

## 15. KALAN RİSKLER

| Risk | Önem | Durum |
|---|---|---|
| Snapshot + escrow aynı diskte | **KRİTİK** | Açık — 3.9.8'de çözülecek |
| Off-site kopya yok | **KRİTİK** | Açık — hedef bekleniyor |
| Medya baytları yedeklenmiyor | Yüksek | Açık — snapshot yalnızca metadata |
| Persistence kapalı (`config_enabled=false`) | Yüksek | Açık — gateway recreate = RAM-only kayıp |
| 2 sohbet 2000 tavanında (`38289`, `38291`) | Orta | Açık — her yeni mesaj en eskiyi atar |
| V1 escrow (yanlış anahtar) duruyor | Düşük | Açık — 3.9.8'de silinecek |
| Tenancy'de bucket varlığı doğrulanamadı | Düşük | Yetki yok; operatör bilgisi gerekli |
| 9 LID mesajı hâlâ kurtarılamadı | Yüksek | Değişmedi — köprü yok |

---

*Bu rapor salt-okunur ölçümlere dayanır. Hiçbir aktarım, silme veya üretim değişikliği yapılmamıştır. Simülasyon sonucu gerçek cihaz E2E olarak sunulmamıştır.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*
