# AŞAMA 5.3.23-A — İstemci Tarafı Şifreleme ve Yedekleme Güvenlik Hazırlığı

> **Tür:** Salt okunur altyapı incelemesi ve planlama  
> **Tarih:** 2026-11-02, ölçüm penceresi ~13:40–13:55 UTC  
> **Kapsam:** PostgreSQL dump'ının OCI'ya yüklenmeden önce istemci tarafında şifrelenmesi, anahtarın dump'tan ve bucket'tan ayrılması, anahtar saklama/kurtarma seçenekleri, bucket stratejisi ve doğrulama test planı  
> **Sonuç:** **PLAN HAZIR — ÜRETİM YEDEĞİ İÇİN ONAY, ANAHTAR ESCROW'U VE AYRI BUCKET BEKLİYOR**

> **Bu turda yapılmayanlar:** `pg_dump`/dump oluşturma/kopyalama **0**, OCI upload **0**, anahtar üretimi veya kalıcı anahtar saklama **0**, DB/gateway/backend yazma **0**, servis restart/recreate **0**, kod değişikliği/commit/push/deploy **0**.  
> **Gizlilik:** Bu raporda anahtar, parola, token, private key veya hassas ortam değişkeni değeri **yoktur**; yalnızca değişken adları, dosya yolları, boyutlar ve HTTP durum kodları yer alır.

---

## 0. Yönetici Özeti

1. **Şifreleme altyapısının çekirdeği zaten var.** `scripts/diagnostics/ram_snapshot.py` AES-256-GCM kullanıyor: `sha256(secret)` → 32 bayt anahtar, 12 bayt nonce, 16 bayt auth tag, `RSNAP1` magic ve `tezlify.ram-snapshot:v1` AAD. Ancak bu format **anahtar kimliği (key ID) taşımıyor**, tüm dosyayı belleğe alıyor ve RAM snapshot'a özgü.
2. **DB backup anahtarı henüz yok.** Production'da `GATEWAY_ENCRYPTION_KEY=set`, `TEZLIFY_DB_BACKUP_KEY=unset`. Gateway anahtarı DB dump'ları için **kullanılmamalıdır**; iki farklı tehlike alanını (WhatsApp oturum anahtarı ile tüm veritabanı yedeği) birbirine bağlar.
3. **OCI Vault/KMS bugün kullanılamıyor.** Instance principal yalnızca bucket okuma ve `tezlify-ram-snapshots` içinde nesne yönetme yetkisine sahip. IAM'de Vault/KMS/keys içeren **0 statement** var; `ListVaults` ve `ListKeys` salt okunur sorguları **HTTP 404 `NotAuthorizedOrNotFound`** döndü. 3.9.11'de 0 vault raporlanmıştı; bu turda da kullanılabilir bir Vault/KMS kanıtı yok.
4. **Mevcut anahtar escrow'u yedekleme güvenliği için yeterli değil.** `.key-escrow` ve `.key-escrow-v2` production sunucusunun aynı diskinde (`0600`, `ubuntu:ubuntu`). 3.9.19'da fiziksel A/B escrow **BLOCKED** kaldı. DB backup anahtarı için bu model tekrarlanmamalıdır.
5. **RAM snapshot bucket'ı DB yedekleri için uygun değil.** Bucket'ta 166 nesne / 319.562.718 bayt (~304,76 MiB) var; DB dump'ı veya anahtar materyali yok. Bucket `NoPublicAccess`, versioning `Enabled`, KMS yok, lifecycle yok. Aynı bucket'a DB dump'ı koymak erişim, retention ve veri ayrıştırma sınırlarını birleştirir; **ayrı bucket** önerilir.
6. **Mevcut DB yedekleri güncel veriyi içermiyor.** En yeni dump `2026-10-17 19:30:10Z` (2.392.226 bayt); DB'deki en eski mesaj `2026-10-27 20:32:33Z`. Ölçüm anında **10.006/10.006 mesaj** dump tarihinden yeni. DB backup otomasyonu yok; yalnızca RAM snapshot timer'ı çalışıyor.
7. **Önerilen hedef:** Yeni, sürümlü, chunked **AES-256-GCM v1** zarfı; anahtar kimliği (key ID) taşıyan header; `pg_dump -Fc` çıktısının doğrudan şifreleme sürecine akıtılması; şifreleme servisinin **ağ erişimi olmaması**, upload servisinin **anahtarı hiç görmemesi**; anahtarın dump, repo, bucket ve aynı dizinden ayrı tutulması; iki bağımsız offline escrow kopyası.
8. **Karar:** Plan uygulanabilir; ancak production dump/upload için önce (a) anahtar yönetim modeli, (b) bağımsız escrow, (c) ayrı bucket/IAM ve (d) sentetik test + izole restore provası onaylanmalıdır. Bu aşama raporla durur.

---

## 1. İnceleme Yöntemi ve Kaynaklar

### 1.1 Yapılan inceleme

- Projedeki tüm `.md` dosyalarının başlık/envanter taraması yapıldı (`node_modules`, `venv`, `.git` hariç).
- Yedekleme, şifreleme, anahtar escrow'u ve OCI erişimiyle ilgili 25+ belge tam okundu:
  - `docs/audits/whatsapp-key-escrow-phase-3.9.2.md`
  - `docs/audits/whatsapp-security-forensics-phase-3.9.3.md`
  - `docs/audits/whatsapp-canonical-key-source-phase-3.9.5.md`
  - `docs/audits/whatsapp-offsite-backup-phase-3.9.6` … `3.9.11`
  - `docs/audits/whatsapp-automatic-hourly-snapshot-phase-3.9.17.md`
  - `docs/audits/whatsapp-hourly-snapshot-production-activation-phase-3.9.18.md`
  - `docs/audits/whatsapp-disaster-recovery-phase-3.9.19-closing.md`
  - `docs/audits/whatsapp-disaster-recovery-physical-escrow-phase-3.9.19.md`
  - `docs/PHASE_10_1_BACKUP_DISASTER_RECOVERY.md`
  - `docs/PHASE_10_6_5_BACKUP_DR_CENTER_REPORT.md`
  - `.workbuddy-ai/memory/2026-11-02.md` (5.3.22 DB yedek/rollback bulguları)
- Kod tarafında `ram_snapshot.py`, `hourly_snapshot.py`, `offsite_oci.py`, `oci_provision.py`, `backups_admin_service.py` ve `docker-compose.prod.yml` incelendi.
- Production'da yalnızca **okuma** komutları çalıştırıldı: `docker ps`, `psql SELECT`, `pg_dump --version`, `ls`, `systemctl list-timers`, `free`, `df`, ortam değişkeni **varlık** kontrolü.
- OCI'da yalnızca `GET`/`HEAD` yapıldı: bucket listesi, bucket metadata, lifecycle, nesne listesi, IAM policy/compartment, Vault/KMS listeleme denemeleri.
- Şifreleme aracı yeteneği için yerel `openssl enc -aes-256-gcm` denemesi yapıldı; **hiçbir gerçek veri kullanılmadı**.

### 1.2 Ölçüm sınırı

Production canlıdır. İnceleme sırasında mesaj sayısı **10.005 → 10.006** olarak değişti; bu normal canlı trafiktir. Rapordaki sayılar ölçüm anına aittir, kalıcı bir envanter değildir.

---

## 2. Mevcut Durum (Ölçüldü)

### 2.1 PostgreSQL

| Alan | Ölçüm |
|---|---|
| Sürüm | PostgreSQL **17.11** (`pg_dump` ve `pg_restore` 17.11) |
| DB boyutu | **79.992.499 bayt** (~76 MiB) |
| Mesaj | **10.005 → 10.006** (canlı trafik) |
| Sohbet | **128** |
| Kişi | **1.538** |
| `whatsapp_sessions` | **1** |
| Mesaj zaman aralığı | `2026-10-27 20:32:33Z` → `2026-11-02 13:43:00Z` |
| Container | `tezlify-db`, `postgres:17-alpine`, healthy, 4 haftadır ayakta |

### 2.2 Mevcut DB yedekleri

`/opt/tezlify/backups/postgres` içinde 6 dump var; hepsi **şifresiz**, aynı host diskinde:

| Dump | Boyut | Not |
|---|---:|---|
| `tezlify_20260916_131540Z.dump` | 31.626.838 B | Eski |
| `tezlify_20260916_131737Z.dump` | 31.626.839 B | Eski |
| `tezlify_20261012_201248Z.dump` | 3.435.749 B | 12 Ekim |
| `tezlify_20261012_202730Z.dump` | 3.459.551 B | 12 Ekim |
| `tezlify_20261015_185003Z.dump` | 2.178.987 B | 15 Ekim |
| `tezlify_20261015_191248Z.dump` | 2.192.614 B | 15 Ekim |
| `tezlify_20261017_193010Z.dump` | 2.392.226 B | **En yeni**; 17 Ekim |

- En yeni dump, DB'deki **en eski mesajdan önce** alınmış. Ölçümde `created_at > 2026-10-17 19:30:10Z` olan mesaj sayısı **10.006/10.006**. Yani en yeni dump, mevcut mesaj verisinin **%0'ını** içeriyor.
- DB backup otomasyonu yok: `ubuntu` crontab boş; `tezlify-db-backup` benzeri timer yok. Yalnızca `tezlify-ram-snapshot.timer` var.
- Admin API `POST /api/v1/admin/backups/create` manuel `pg_dump -Fc` çalıştırıyor; çıktı `/opt/tezlify/backups/postgres` altında **düz metin** yazılıyor, retention yok. `certification_status` ve `off_host_status` sabit string; canlı doğrulama değil (`backups_admin_service.py:157-160`).

### 2.3 Mevcut şifreleme ve anahtar durumu

| Öğe | Ölçüm / kaynak |
|---|---|
| Algoritma | AES-256-GCM (`cryptography.hazmat.primitives.ciphers.aead.AESGCM`) |
| Anahtar türetme | `sha256(secret.encode("utf-8"))` → 32 bayt (`ram_snapshot.py:421-425`) |
| Nonce | 12 bayt `os.urandom(12)` (`ram_snapshot.py:428-434`) |
| AAD / magic | `b"tezlify.ram-snapshot:v1"` / `b"RSNAP1"` (`ram_snapshot.py:86-89`) |
| Format | `[MAGIC 6B][nonce 12B][ciphertext + 16B tag]` |
| Anahtar kaynağı | `GATEWAY_ENCRYPTION_KEY` (backend container env) |
| Anahtarın host'a gelmesi | Saatlik akışta gelmiyor; `docker exec` + `python -c` ile container içinde okunuyor (`hourly_snapshot.py:16-25`, `324-350`) |
| DB backup anahtarı | **Yok**; `TEZLIFY_DB_BACKUP_KEY=unset` |
| Gateway anahtarı | **Var**; `GATEWAY_ENCRYPTION_KEY=set` |
| Mevcut escrow | `/var/backups/tezlify-ram/.key-escrow` 90 B, `.key-escrow-v2` 88 B; `0600`, `ubuntu:ubuntu`, **aynı host diskinde** |
| Fiziksel escrow | 3.9.19'da **A/B BLOCKED**; bağımsız kopya yok |
| Host crypto | `cryptography` 41.0.7; OpenSSL 3.0.13 |
| Backend crypto | `cryptography` 50.0.2 |
| Host araçları | `gpg` var; `age`, `rclone`, `restic`, `borg`, `oci` yok |
| TPM / systemd credential | systemd 255 `+TPM2` derlenmiş, ancak `/dev/tpm*` yok; `systemd-creds has-tpm2` **partial**, `/var/lib/systemd/credential.secret` yok |

**Kritik ayrım:** `GATEWAY_ENCRYPTION_KEY`, WhatsApp oturum/auth state'ini korumak için kullanılıyor. DB dump'ları için aynı anahtarın kullanılması, gateway anahtarı sızdığında **tüm veritabanı yedeklerinin** de açılması anlamına gelir. DB backup anahtarı ayrı, yüksek entropili ve ayrı escrow'lu olmalıdır.

### 2.4 OCI bucket durumu

| Alan | Ölçüm |
|---|---|
| Bucket | `tezlify-ram-snapshots` |
| Namespace | `frlm5ioojy2m` |
| Region | `eu-frankfurt-1` |
| `publicAccessType` | `NoPublicAccess` |
| `versioning` | `Enabled` |
| `storageTier` | `Standard` |
| `kmsKeyId` | `None` |
| `objectEventsEnabled` | `False` |
| Lifecycle | **Yok** (`LifecyclePolicyNotFound`) |
| Prefix | `tezlify/whatsapp/ram-snapshots/YYYY/MM/DD/` |
| Nesne sayısı | **166** |
| Toplam boyut | **319.562.718 bayt** (~304,76 MiB) |
| DB dump nesnesi | **0** |
| Escrow/anahtar nesnesi | **0** (isim taraması: `escrow`, `key` eşleşmesi yok) |
| Ayrı DB bucket | `tezlify-db-backups` **yok** (`HEAD` 404); aynı ada yakın bucket'lar da yok |

Yerel RAM snapshot dizini: **84 `.rsnap`**, **313 MB**; `tezlify-ram-snapshot.timer` **enabled + active**. Retention/otomatik silme yok.

### 2.5 OCI IAM / Vault / KMS

| Kontrol | Sonuç |
|---|---|
| Dynamic group | `tezlify-offsite-dg`, yalnızca production instance OCID'sini eşliyor |
| Policy `tezlify-offsite-policy` | 2 statement: `read buckets` (tenancy) + `manage objects` **yalnızca** `tezlify-ram-snapshots` |
| Vault/KMS içeren policy statement | **0** |
| `GET /20180608/vaults?compartmentId=…` | **HTTP 404 `NotAuthorizedOrNotFound`** |
| `GET /20180608/keys?compartmentId=…` | **HTTP 404 `NotAuthorizedOrNotFound`** |
| Compartment | Yetkili alt compartment **0** (tenancy kökü) |
| Sonuç | **Kanıtlanmış kullanılabilir OCI Vault/KMS yok.** 404, “vault yok” ile “yetki yok”u tek başına ayırmaz; ancak instance principal'da Vault/KMS policy'si yok ve 3.9.11'de 0 vault ölçülmüştü. |

Vault/KMS'yi açmak **yazma** gerektirir: vault + master key + secret + dynamic-group policy. Bu aşamada yapılmadı ve ayrı onay ister.

---

## 3. İstemci Tarafı Şifreleme Mekanizması

### 3.1 Gereksinimler

- Şifreleme **OCI'ya yüklemeden önce**, istemci tarafında yapılmalı.
- Onaylanmış algoritma: **AES-256-GCM** (256-bit anahtar, 96-bit nonce, 128-bit tag).
- Dump plaintext'i diske **hiç yazılmamalı**; `pg_dump` çıktısı doğrudan şifreleme sürecine akıtılmalı.
- Anahtar dump'tan, bucket'tan, repo'dan ve aynı dizinden ayrı olmalı.
- Format sürümlenebilir olmalı; anahtar rotasyonunda eski yedekler açılabilmeli.
- Bozulma/kesilme/yanlış anahtar **fail-closed** olmalı; “kısmen başarılı” sayılmamalı.
- Bellek tüketimi sınırlı olmalı; DB büyüdüğünde tüm dosyayı RAM'e almak zorunlu olmamalı.

### 3.2 Seçenek karşılaştırması

| Seçenek | Durum | Değerlendirme |
|---|---|---|
| Mevcut `ram_snapshot.py` `encrypt_bytes()` | Var, test edilmiş | AES-256-GCM doğru; ancak **key ID yok**, **tüm blob bellekte**, magic/AAD RAM'e özgü. DB için olduğu gibi kullanılmamalı. |
| Yeni chunked AES-256-GCM v1 | Plan | **Önerilen.** Aynı `cryptography` primitifi; 1 MiB chunk, key ID, sürümlü header, streaming, bellek sınırlı. |
| OpenSSL CLI `enc -aes-256-gcm` | Denendi | **Kullanılamaz:** `enc: AEAD ciphers not supported`. OpenSSL CLI AES-GCM'i dosya şifreleme için sunmuyor. |
| GPG symmetric (`--cipher-algo AES256`) | Host'ta var | OpenPGP formatı; GCM değil (CFB/MDC veya OCB'ye bağlı). AES-256-GCM şartını birebir karşılamaz; fallback olabilir, birincil öneri değil. |
| `age` | Yok | ChaCha20-Poly1305 + X25519; iyi bir format ama AES-256-GCM şartına uymaz; kurulum gerekir. |
| OCI Vault/KMS ile doğrudan şifreleme | Kullanılamıyor | KMS `Encrypt` API'si toplu veri için uygun değil (küçük payload sınırı); envelope encryption ile veri anahtarı sarılabilir. Vault/KMS policy'si yok. |

### 3.3 Önerilen tasarım: `TZDBK1` — chunked AES-256-GCM v1

#### 3.3.1 Kriptografik parametreler

| Parametre | Değer |
|---|---|
| Algoritma | AES-256-GCM |
| Anahtar | 32 rastgele bayt (256 bit); operasyonel gösterim 64 hex karakter |
| Anahtar kaynağı | `TEZLIFY_DB_BACKUP_KEY` **değil**, tercihen OCI Vault secret veya systemd credential; env yalnızca son çare |
| Anahtar türetme | Anahtar zaten 256-bit ise doğrudan kullanılır; hex'ten decode edilir. Passphrase kullanılacaksa HKDF-SHA256 + domain separation. |
| Nonce | Her chunk için `nonce_prefix (8B rastgele) || chunk_index (4B BE)` = 12B |
| Tag | 16 bayt (tam, kısaltılmaz) |
| AAD | `header_bytes || chunk_index (4B BE) || final_flag (1B)` |
| Chunk boyu | 1 MiB plaintext (yapılandırılabilir; sert üst sınır 8 MiB) |
| Magic | `TZDBK1` (6B) |
| Format sürümü | `0x01` |
| Dosya adı | `tezlify-db-YYYYMMDDTHHMMSSZ.dump.enc` + `.manifest.json` |
| Object key | `db/postgres/YYYY/MM/DD/<dosya>` (ayrı bucket'ta) |

#### 3.3.2 Header ve chunk düzeni

Header **plaintext**'tir; her chunk'ın AAD'si ile kimlik doğrulanır. İçinde hassas veri yoktur:

```
magic            6B   "TZDBK1"
version          1B   0x01
key_id_len       1B
key_id           nB   ör. "dbk-20261102-a1b2c3d4" (gizli değil)
nonce_prefix     8B   her dosya için rastgele
chunk_size       4B   BE
plaintext_size   8B   BE
plaintext_sha256 32B  (şifreleme sırasında hesaplanır)
```

Her chunk:

```
ct_len   4B BE
ct       ct_len bayt = plaintext_chunk + 16B tag
```

Kurallar:

- Son chunk `final_flag=1` taşır; sonrasında veri olamaz.
- Header, `plaintext_size` ve `plaintext_sha256` her chunk'ın AAD'sine girer; header değiştirilirse GCM reddeder.
- Chunk sırası `chunk_index` ile bağlanır; chunk atlama, tekrar, sıra değiştirme veya son chunk'ı kesme **reddedilir**.
- Boş dosya bile tek bir boş final chunk olarak şifrelenir; “boş dosya” ile “kesilmiş dosya” ayrılır.
- Decryptor plaintext'i bellekte tutmaz; chunk chunk okur, hash'e ekler, çıktıya yazar. `plaintext_size` ve `plaintext_sha256` sonda doğrulanır.

#### 3.3.3 Pipeline

```bash
set -o pipefail

docker exec tezlify-db pg_dump -U tezlify -d tezlify -Fc \
  | /usr/bin/python3 /opt/tezlify/scripts/backup/db_backup_crypt.py encrypt \
      --key-credential "$CREDENTIALS_DIRECTORY/db-backup-key" \
      --out /var/backups/tezlify-db/tezlify-db-<ts>.dump.enc.partial
```

- `pg_dump` **DB container içinde** çalışır; DB parolası argv'de yoktur (yerel socket/auth; mevcut dump'lar bunun çalıştığını kanıtlıyor).
- `-Fc` çıktısı zaten sıkıştırılmıştır; **ek gzip yapılmaz** (çift sıkıştırma fayda sağlamaz, CPU harcar).
- Şifreleme **host'ta** yapılır; anahtar DB container'a veya backend'e girmez.
- `.partial` → `fsync` → atomik `rename`; hata/kesilme durumunda yayınlanmaz, `.partial` silinir.
- Dizin `0700`, dosya `0600`; plaintext hiçbir aşamada diske yazılmaz.
- `pg_dump` çıkış kodu `pipefail` ile kontrol edilir; dump başarısızsa şifreli dosya yayınlanmaz.
- Yayın öncesi doğrulama: `decrypt | docker exec -i tezlify-db pg_restore --list` (plaintext diske yazılmadan TOC kontrolü). Bu adım **okuma**dır; DB'ye yazmaz.

#### 3.3.4 Neden chunked?

DB bugün ~76 MiB; tüm dosyayı belleğe almak teknik olarak mümkün (host'ta 21 GiB boş RAM). Ancak:

- DB büyüdüğünde bellek tüketimi doğrusal artar.
- Streaming, `pg_dump` ile aynı boru hattında doğal çalışır.
- Chunk indeksi/final flag, kesilme ve yeniden sıralamayı tespit eder; tek büyük GCM bloğunda “son chunk eksik” ayrımı daha zayıftır.
- Format sürümlenebilir; ileride chunk boyu veya KDF değişse bile `version` ile ayrılır.

**Alternatif (daha küçük değişiklik):** Mevcut `encrypt_bytes()` semantiğini yeni `TZDBK1` magic/AAD ile kullanmak ve **512 MiB sert üst sınır** koymak. Bu, ilk sürüm için kabul edilebilir; ancak DB 256 MiB'ı geçmeden chunked v2'ye geçilmelidir. Bu raporun önerisi doğrudan chunked v1'dir.

### 3.4 Anahtar ayrımı ve servis ayrımı

Önerilen iki servis:

| Servis | Ağ | Anahtar | Docker socket | Görev |
|---|---|---|---|---|
| `tezlify-db-backup-encrypt.service` | **Yok** (yalnızca loopback/UNIX) | systemd credential / Vault'tan alınan anahtar | Evet (`docker exec pg_dump`) | Dump → şifrele → `.enc` + manifest; TOC doğrula |
| `tezlify-db-backup-upload.service` | OCI'ya çıkış | **Yok** | Hayır | Şifreli dosyayı ayrı bucket'a yükle; remote SHA doğrula |

Bu ayrım, “anahtarı olan süreç ağa çıkamaz; ağa çıkan süreç anahtarı görmez” kuralını uygular. Upload servisi yalnızca `.enc` ve `.manifest.json` görür; `.key-escrow`, anahtar dosyası veya plaintext görmez.

Ek korumalar:

- `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `ReadOnlyPaths=/var/backups/tezlify-db` (encrypt servisi için yazma istisnası), `RestrictAddressFamilies=AF_UNIX` (encrypt), `MemoryMax` ve `TimeoutStartSec`.
- `flock` ile tek eşzamanlı koşum; bayat kilit riski yok (mevcut `hourly_snapshot.py` deseni).
- Loglarda yalnızca `key_id`, boyut, SHA-256, süre ve durum; anahtar/parola/token asla.
- `TEZLIFY_DB_BACKUP_APPROVED=1` ve ayrı bir onay kapısı; upload `--execute` olmadan yalnızca plan.

---

## 4. Anahtarın Saklanması, Yedeklenmesi ve Kurtarılması

### 4.1 Seçenekler

| Seçenek | Anahtar nerede? | Host'tan bağımsız? | OCI'den bağımsız? | Otomasyon | Kurtarma | Değerlendirme |
|---|---|---|---|---|---|---|
| **A. OCI Vault secret** | Vault/HSM; runtime'da bellek | Evet | **Hayır** (aynı tenancy) | Evet (instance principal) | Tenancy erişimi varsa evet | Birincil otomasyon için uygun; **tek başına yeterli değil** |
| **B. Offline escrow A/B** | Kağıt/metal/offline medya, iki ayrı yer | Evet | Evet | Hayır | Evet | **Zorunlu kurtarma kopyası**; operatör eylemi |
| **C. systemd credential** | `/run/credentials/...` (tmpfs) veya root-only dosya | Hayır | Evet | Evet | Host/anahtar varsa | TPM yok; host compromise'a dayanıklı değil; **geçici çözüm** |
| **D. Host env / `.env.production`** | Host disk + container env | Hayır | Evet | Evet | Host varsa | DB backup için **kabul edilmez**; `/proc` ve compose sızıntısı |
| **E. macOS Keychain / password manager** | Operatör cihazı | Evet (cihaz güvenliyse) | Evet | Manuel | Cihaz/yedek varsa | İkinci kopya için iyi; otomasyon değil |
| **F. GPG/age dosyası** | Offline/passphrase | Evet | Evet | Manuel | Passphrase varsa | Alternatif; AES-256-GCM şartını birebir karşılamaz |

### 4.2 OCI Vault/KMS kullanılabilirliği (salt okunur sonuç)

- `ListVaults`: **404**; `ListKeys`: **404**; IAM'de Vault/KMS statement'i **0**.
- Instance principal'ın mevcut policy'si yalnızca bucket okuma + `tezlify-ram-snapshots` nesne yönetimi.
- Sonuç: **Bugün OCI Vault/KMS'ye güvenilemez.** Etkinleştirmek için ayrı bir IAM/altyapı fazında:
  1. Vault + master encryption key oluştur (HSM veya software; maliyet/uyum kararı).
  2. `tezlify-db-backup-key` secret'ını version'lu olarak oluştur.
  3. Dynamic group'a **en az yetki** ile `read secret-bundles` ve gerekiyorsa `use keys` ver; statement'ları OCI dokümanına göre doğrula.
  4. Backup servisine secret-bundle okuma ekle; anahtar yalnızca bellekte, log/argv/diskte değil.
  5. Yine de offline escrow A/B oluştur; Vault aynı tenancy'dedir, hesap compromise'ında ciphertext ve anahtar birlikte gider.

### 4.3 Önerilen model

**Birincil (otomasyon):** OCI Vault secret + instance principal; anahtar runtime'da bellekten okunur, diske yazılmaz.

**Zorunlu kurtarma:** İki offline escrow kopyası (A/B), iki ayrı fiziksel konum ve tercihen iki ayrı sorumlu. Her pakette:

- `key_id` (gizli değil)
- 64 hex anahtar değeri (yalnızca fiziksel/offline; rapora/log'a girmez)
- oluşturulma tarihi, rotasyon/saklama talimatı
- aynı anahtarla şifrelenmiş küçük bir **canary** blob'u (anahtar paketin içinde değil, ayrı zarfta)
- doğrulama talimatı: canary'yi çöz, `key_id` ve fingerprint'i eşleştir.

**Vault yoksa:** İki seçenek vardır:

1. **Manuel/yarı otomatik:** Operatör anahtarı escrow'dan alır, backup penceresinde `systemd-run` credential veya `getpass` ile servise verir; anahtar host'ta kalıcı değildir. Günlük otomasyon zor, haftalık manuel uygulanabilir.
2. **Host credential (risk kabulü):** Root-only `0400` dosya veya systemd credential; otomasyon çalışır ama host compromise anahtarı ele geçirir. TPM olmadığı için “şifrelenmiş credential” host key'e dayanır; bağımsız koruma sağlamaz.

**Karar:** Günlük otomatik backup hedefleniyorsa Vault (veya eşdeğer bağımsız secret manager) gerekir. Vault yokken günlük otomatik backup için düz env/file anahtarı **kabul edilmemelidir**; manuel/yarı otomatik model veya Vault kurulumu seçilmelidir. Offline escrow her iki modelde de zorunludur.

### 4.4 Anahtar rotasyonu ve kayıt defteri

- Her anahtarın `key_id`'si header'da taşınır; decryptor `key_id` → anahtar eşlemesi yapar.
- Rotasyon: 90 günde bir veya olay sonrası. Yeni backup'lar yeni anahtarla; eski backup'lar eski anahtarla açılmaya devam eder.
- Eski anahtarlar, o anahtarla şifrelenmiş **son yedek retention süresini dolana kadar** saklanır; sonra imha edilir.
- Vault secret version'ları + offline escrow kayıtları `key_id`, oluşturulma, son kullanım, imha tarihi ile tutulur.
- Anahtar imhası geri alınamaz; imha öncesi son yedeklerin yeni anahtarla yeniden şifrelenmesi veya eski anahtarın saklanması gerekir.

### 4.5 Kurtarma prosedürü (plaintext diske yazmadan)

1. Şifreli dosyanın header'ından `key_id`'yi oku (gizli değil).
2. `key_id` ile anahtarı offline escrow'dan veya Vault'tan al; fingerprint/canary ile doğrula.
3. Şifreli dosyayı ve manifesti **ayrı DB backup bucket'ından** indir.
4. Ciphertext SHA-256'yı manifest ve transfer log'u ile karşılaştır.
5. İzole bir host/container'da:

   ```bash
   set -o pipefail
   /usr/bin/python3 db_backup_crypt.py decrypt --key-credential ... --in backup.dump.enc \
     | docker exec -i tezlify-db-restore-test pg_restore -U tezlify -d tezlify_restore --no-owner --no-privileges
   ```

   Bu boru hattı plaintext dump dosyası oluşturmaz. `pg_restore` çıkış kodu açıkça kontrol edilir; `|| true` kullanılmaz.
6. Şema/TOC, tablo satır sayıları, kimlik kümeleri, `whatsapp_sessions`/`gateway_sessions` ve outbox tutarlılığını doğrula.
7. Uygulama smoke test'ini izole DB'ye karşı çalıştır; production DB'ye bağlanma.
8. Geçici container/volume ve indirilen ciphertext'i temizle; RTO/RPO ölçümünü kaydet.

**Anahtar kaybı = yedeklerin kalıcı kaybı.** Bunun teknik bir kurtarma yolu yoktur; bu yüzden escrow, ilk production dump'ından **önce** hazır olmalıdır.

---

## 5. Bucket Stratejisi ve RAM Snapshot Bucket'ını Kullanma Riskleri

### 5.1 Ölçülen mevcut bucket

Yukarıdaki §2.4: `tezlify-ram-snapshots`, 166 nesne, 319.562.718 B, `NoPublicAccess`, versioning `Enabled`, KMS yok, lifecycle yok. İçinde DB dump'ı veya anahtar materyali yok.

### 5.2 Aynı bucket'ı kullanma riskleri

| Risk | Önem | Açıklama |
|---|---|---|
| **Erişim birleşmesi** | Yüksek | Aynı dynamic group/policy hem RAM snapshot'ları hem DB dump'larını okur/yazar. DB dump'ı tüm tabloları (kullanıcı, oturum, lead, kampanya, mesaj) içerir; RAM snapshot'tan daha geniş hassasiyet. |
| **Veri ayrıştırma** | Yüksek | RAM snapshot (`rsnap`) ve DB dump (`dump.enc`) aynı prefix'te karışır; yanlış nesnenin silinmesi/üzerine yazılması riski artar. OCI policy koşulları nesne prefix'ine göre güvenilir ayrım sağlamaz; pratik sınır **bucket**tır. |
| **Retention çatışması** | Yüksek | RAM snapshot saatlik ve kısa retention; DB dump günlük/haftalık/aylık ve uzun retention. Aynı lifecycle ikisini de yanlış yönetir. |
| **Silme/bozulma yarıçapı** | Yüksek | `manage objects` yetkisi olan principal, aynı bucket'taki DB dump'larını da silebilir. Versioning tek başına yeterli değil; retention rule/object lock yok. |
| **Kod uyumsuzluğu** | Orta | `offsite_oci.py` yalnızca `tezlify-ram-<ts>.rsnap` / `.manifest.json` adlarını kabul ediyor (`SNAP_RE`, satır 48); DB dump adları `collect()` tarafından **sessizce atlanır**. Aynı bucket'a yazmak için yeni uploader/güvenli regex gerekir. |
| **Maliyet/disk** | Düşük–Orta | Bucket ~305 MiB; yerel snapshot dizini 313 MB; DB dump eklenince büyüme hızlanır. Ayrı lifecycle olmadan disk/kuota riski. |
| **Escrow sızıntısı** | Kritik | Anahtar/escrow asla bucket'a girmemeli. Aynı bucket'a yazma yetkisi, yanlışlıkla `.key-escrow` yükleme riskini artırır; mevcut `offsite_oci.py` escrow'u bloke ediyor ama yeni uploader'da da aynı guard şart. |

### 5.3 Öneri: ayrı bucket

**`tezlify-db-backups`** (küçük harf; OCI adlandırma) ayrı bucket'ı oluşturulmalı:

- Prefix: `db/postgres/YYYY/MM/DD/`
- `NoPublicAccess`, versioning `Enabled`, lifecycle/retention rule (onayla), mümkünse bucket KMS key (server-side ek katman; client-side şifrelemenin yerine geçmez).
- Ayrı dynamic group/policy; yazıcı principal yalnızca **bu bucket'a** nesne yazabilsin; okuyucu/restore operatörü ayrı olsun; silme yetkisi yazıcıda olmasın (mümkünse).
- Upload öncesi `.enc` + `.manifest.json` dışında dosya kabul edilmesin; `.key-escrow`, `*key*`, `*escrow*`, plaintext `.dump` **hard block**.
- Anahtar, escrow ve plaintext bucket'a **asla** yüklenmez; periyodik olarak nesne adı ve içerik taraması yapılır.

**Aynı bucket zorunluysa:** Ayrı prefix ve ayrı policy denenebilir; ancak OCI'da nesne prefix'ine göre güvenilir yetki ayrımı garanti değildir. Bu, **kabul edilmiş risk** olarak yazılmalı; önerilen çözüm değildir.

### 5.4 Retention önerisi (onay gerektirir)

| Sınıf | Öneri | Not |
|---|---|---|
| Günlük | 30 gün | RPO 24 saat |
| Haftalık | 12 hafta | Haftalık tam |
| Aylık | 12 ay | Uzun vadeli |
| RAM snapshot | 7 gün (mevcut saatlik) | Ayrı bucket/lifecycle |
| Noncurrent versions | 30 gün sonra expire | Versioning maliyetini sınırlar |

Retention **kod veya lifecycle** ile uygulanmalı; “dokümanda yazıyor” yeterli değil. Silme işlemi ayrı onay ve dry-run gerektirir. Mevcut bucket'ta lifecycle yok; bu tasarımda da otomatik silme bu aşamada eklenmedi.

---

## 6. Doğrulama ve Test Planı (Bu Aşamada Çalıştırılmadı)

> **Önemli:** Aşağıdaki testler **plan**dır. 5.3.23-A'da hiçbir `pg_dump`, dump dosyası, upload, anahtar üretimi veya restore çalıştırılmadı. Testler ayrı onaylı fazlarda, **sentetik veri** ve **izole DB** ile yapılacaktır.

### 6.1 Birim testleri (sentetik, production dışı)

1. AES-256-GCM known-answer test (NIST vektörü) — şifreleme/çözme birebir.
2. Round-trip: 0 B, 1 B, 1 MiB, 10 MiB, 1 GiB stream; plaintext SHA eşleşir.
3. Yanlış anahtar → `InvalidTag`; hiç plaintext üretilmez.
4. Ciphertext/tag'de 1 bit değişim → red.
5. Header tamper (`key_id`, `plaintext_size`, `plaintext_sha256`, `nonce_prefix`) → red.
6. Chunk reorder / drop / duplicate / truncate / final'dan sonra veri → red.
7. Nonce tekilliği: 10.000 dosya ve chunk sayacı; aynı anahtar altında tekrar yok.
8. `key_id` yönlendirme: v1/v2; bilinmeyen `key_id` → açık hata.
9. Bellek sınırı: 1 GiB stream, 1 MiB chunk; RSS üst sınırı (ör. <128 MiB).
10. Atomiklik: hata/kesilme → `.partial` yayınlanmaz; plaintext dosyası oluşmaz.
11. Log/argv taraması: anahtar, parola, token, 64-hex sır deseni yok.
12. Manifest: hassas veri yok; ciphertext SHA-256 doğru.

### 6.2 Entegrasyon testi (sentetik PostgreSQL 17)

1. İzole, boş PostgreSQL 17 container'ı; sentetik şema ve sentetik PII (gerçek müşteri verisi değil).
2. `pg_dump -Fc` yalnızca **fixture DB** üzerinde; production DB adı kullanılmaz.
3. Dump → encrypt → decrypt → `pg_restore --list` (TOC) → exit code 0.
4. Encrypt → test bucket/prefix'e upload → download → SHA-256 → decrypt → ikinci izole container'a restore.
5. Şema, tablo sayıları, satır sayıları, kimlik kümeleri ve checklist karşılaştırması.
6. Yanlış anahtar/bozuk dosya ile aynı pipeline → upload **yok**, açık hata.
7. OCI kesintisi simülasyonu → yerel şifreli kopya korunur; upload retry; veri kaybı yok.
8. Idempotency: aynı object key tekrar → üzerine yazma yok / CONFLICT.
9. Key rotation: v1 ile backup → v2'ye rotate → yeni backup v2, eski backup v1 ile açılır; v1 saklanır.

### 6.3 Escrow ve kurtarma tatbikatı

1. Operatör escrow A'dan anahtarı alır; canary'yi çözer; fingerprint doğrular.
2. Sentetik şifreli yedeği **ağsız/temiz** bir host'ta çözer ve izole DB'ye restore eder.
3. Aynı adımı escrow B ile tekrarlar; iki kopyanın bağımsız çalıştığını kanıtlar.
4. RTO ölçer; tarih, sorumlu, tanık ve sonuç kaydedilir; anahtar rapora/log'a yazılmaz.
5. Yıllık tatbikat takvimi; escrow paketlerinin fiziksel bütünlüğü kontrol edilir.

### 6.4 Negatif testler

- Anahtar yok / boş / yanlış uzunluk → fail-closed.
- `pg_dump` başarısız → şifreli dosya yayınlanmaz.
- Upload sırasında ağ kesilir → `.partial` kalmaz; yerel `.enc` kalır.
- Bucket'ta aynı ad farklı içerik → CONFLICT; üzerine yazma yok.
- Plaintext/escrow/anahtar dosyası bucket'a yüklenmeye çalışılır → hard block.
- Log'a 64-hex sır, `Bearer`, `PRIVATE KEY`, `password=` sızması → test başarısız.

### 6.5 Kabul kriterleri

| # | Kriter | Beklenen |
|---|---|---|
| 1 | Doğru anahtarla decrypt | Başarılı; plaintext SHA eşleşir |
| 2 | Yanlış anahtarla decrypt | 0 başarı; açık hata; plaintext yok |
| 3 | Bozulmuş/kesilmiş dosya | Red; kısmi çıktı yok |
| 4 | `pg_restore --list` | Exit 0; beklenen TOC |
| 5 | İzole restore | Exit 0; şema/satır/kimlik eşleşir |
| 6 | Upload + download | SHA-256 eşleşir; idempotent |
| 7 | Anahtar sızıntısı | Log/repo/bucket/argv'de 0 |
| 8 | Plaintext diski | Hiçbir aşamada 0 |
| 9 | Key rotation | Eski + yeni yedek açılır |
| 10 | Escrow A/B | İkisi de bağımsız çalışır |

---

## 7. Uygulama Fazları ve Gereken Onaylar

### 7.1 Fazlar

| Faz | İçerik | Tür | Durum |
|---|---|---|---|
| **5.3.23-A** | Bu rapor: mevcut durum, plan, riskler, test planı | Salt okunur | **TAMAM** |
| **5.3.23-B** | Anahtar yönetimi + ayrı bucket/IAM + escrow | Altyapı/yazma | Onay bekliyor |
| **5.3.23-C** | `db_backup_crypt.py`, uploader, systemd units, testler | Kodlama | Onay bekliyor |
| **5.3.23-D** | Sentetik entegrasyon + izole restore provası | Test | Onay bekliyor |
| **5.3.23-E** | İlk gerçek dump → encrypt → upload | Production yazma | Ayrı onay |
| **5.3.23-F** | İzole restore tatbikatı + RTO/RPO ölçümü | Test | Ayrı onay |

### 7.2 Onay tablosu

| # | Onay | Neden gerekli |
|---|---|---|
| 1 | AES-256-GCM chunked `TZDBK1` formatı | Şifreleme sözleşmesi; geri dönüşü zor format |
| 2 | Anahtar modeli: OCI Vault / systemd credential / manuel | Anahtarın nerede duracağını belirler |
| 3 | OCI Vault + secret + policy oluşturma | Yazma; IAM değişikliği |
| 4 | `tezlify-db-backups` bucket + policy | Yazma; erişim sınırı |
| 5 | Anahtar üretimi + offline escrow A/B | Operatör eylemi; kritik kurtarma |
| 6 | Kod değişiklikleri + testler | Ayrı release |
| 7 | Sentetik test DB ve test bucket kullanımı | Production dışı doğrulama |
| 8 | İlk gerçek dump/encrypt/upload | Production veri işleme |
| 9 | İzole restore tatbikatı | Kurtarma kanıtı |
| 10 | Retention/rotation politikası | Silme ve saklama kararı |

**Bu aşamada onay verilmeden hiçbir yazma yapılmayacaktır.**

---

## 8. Risk Kaydı

| Risk | Olasılık | Etki | Azaltma |
|---|---|---|---|
| Anahtar kaybı | Düşük | **Kritik** — yedekler açılamaz | Offline escrow A/B; Vault version; canary; yıllık tatbikat |
| Anahtar sızıntısı | Düşük–Orta | **Kritik** — tüm DB yedekleri açılır | Ayrı anahtar; Vault/credential; log/argv scrub; en az yetki; rotasyon |
| Nonce tekrarı | Çok düşük | **Kritik** | Rastgele 8B prefix + 4B sayaç; test; aynı anahtarla dosya başına yeni prefix |
| Plaintext'in diske sızması | Orta | Yüksek | Pipeline'da hiç plaintext dosya yok; `.partial` atomik; `pg_restore` pipe |
| Bozulma/kesilme | Orta | Yüksek | GCM tag + chunk index + final flag; `pg_restore --list`; remote SHA |
| Aynı bucket erişim/retention çakışması | Yüksek | Yüksek | Ayrı bucket/policy; ayrı lifecycle |
| OCI Vault/KMS yok | Yüksek (bugün) | Orta–Yüksek | Manuel/yarı otomatik + offline escrow; Vault ayrı faz |
| Host compromise | Orta | Yüksek | Encrypt servisi ağsız; anahtar memory-only; offline escrow runtime'ı kurtarmaz |
| Mevcut escrow aynı diskte | Yüksek | Yüksek | DB backup için tekrarlama; fiziksel A/B şart |
| DB dump'ının eski olması | **Kesin (bugün)** | **Kritik** | İlk onaylı dump; otomasyon; RPO |
| Restore provasının olmaması | **Kesin (bugün)** | **Kritik** | 5.3.23-D/F izole restore |
| Retention/disk tükenmesi | Orta | Orta | Lifecycle + kota; ayrı bucket |
| Admin backup durumunun sabit string olması | Yüksek | Orta | Canlı doğrulama; panelde “certified” göstergesine güvenme |
| `pg_dump`/`pg_restore` sürüm uyumsuzluğu | Düşük | Orta | 17.11/17.11; image tag sabit |
| Bucket principal'ın silme yetkisi | Orta | Yüksek | Ayrı principal; versioning; retention rule; mümkünse delete'siz policy |

---

## 9. Sonuç

### 9.1 Durum

- **İstemci tarafı AES-256-GCM mekanizması uygulanabilir.** Mevcut `cryptography` primitifi hem host'ta hem backend'de var; OpenSSL CLI AES-GCM'i desteklemiyor, bu yüzden Python/AESGCM yolu doğru.
- **DB backup anahtarı yok** (`TEZLIFY_DB_BACKUP_KEY=unset`); mevcut gateway anahtarı **kullanılmamalı**.
- **OCI Vault/KMS bugün kullanılamıyor**; IAM'de Vault/KMS statement'i yok, listeleme 404.
- **Ayrı DB backup bucket'ı yok**; RAM snapshot bucket'ı erişim/retention/veri ayrıştırma açısından uygun değil.
- **Bağımsız escrow yok**; mevcut escrow aynı host diskinde ve fiziksel A/B 3.9.19'da BLOCKED.
- **Mevcut DB yedekleri güncel değil**; en yeni dump 17 Ekim, mevcut mesajların tamamı daha yeni. DB backup otomasyonu ve restore provası yok.

### 9.2 Karar

**PLAN READY — APPROVAL REQUIRED.**  
Şifreleme ve kurtarma planı teknik olarak uygulanabilir; ancak production dump/upload'a geçmeden önce §7.2'deki onaylar, bağımsız escrow ve ayrı bucket/IAM tamamlanmalıdır. Bu aşama **raporla durur**; dump, upload, anahtar üretimi, kod değişikliği, commit/push/deploy yapılmamıştır.

### 9.3 Bir sonraki adım

1. Kullanıcı anahtar modelini seçer (Vault / manuel / host credential riski).
2. Ayrı bucket + IAM ve offline escrow A/B onaylanır ve operatör tarafından oluşturulur.
3. `db_backup_crypt.py` + uploader + systemd unit + testler ayrı release olarak hazırlanır.
4. Sentetik DB ile entegrasyon ve izole restore provası yapılır.
5. Ancak bundan sonra ilk gerçek production dump/encrypt/upload ayrı onayla alınır.

---

## Ek A — Kod ve Belge Referansları

| Konu | Referans |
|---|---|
| AES-GCM sabitleri | [`scripts/diagnostics/ram_snapshot.py:86-89`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/diagnostics/ram_snapshot.py#L86-L89) |
| Anahtar türetme / encrypt / decrypt | [`scripts/diagnostics/ram_snapshot.py:421-446`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/diagnostics/ram_snapshot.py#L421-L446) |
| Şifreleme anahtarı env kullanımı | [`scripts/diagnostics/ram_snapshot.py:764-772`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/diagnostics/ram_snapshot.py#L764-L772) |
| Saatlik snapshot anahtar modeli | [`scripts/backup/hourly_snapshot.py:16-25`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/backup/hourly_snapshot.py#L16-L25) |
| Container içi toplama/doğrulama | [`scripts/backup/hourly_snapshot.py:324-350`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/backup/hourly_snapshot.py#L324-L350) |
| RAM dosya adı regex / escrow block | [`scripts/backup/offsite_oci.py:47-48`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/backup/offsite_oci.py#L47-L48) |
| Upload planı ve onay kapısı | [`scripts/backup/offsite_oci.py:289-322`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/backup/offsite_oci.py#L289-L322) |
| OCI probe | [`scripts/backup/offsite_oci.py:424-450`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/backup/offsite_oci.py#L424-L450) |
| IAM DG/policy/bucket tanımı | [`scripts/backup/oci_provision.py:37-49`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/backup/oci_provision.py#L37-L49) |
| Admin backup `pg_dump` akışı | [`backend/app/services/admin/backups_admin_service.py:184-230`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/admin/backups_admin_service.py#L184-L230) |
| Sabit certification/off-host string'leri | [`backend/app/services/admin/backups_admin_service.py:157-160`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/admin/backups_admin_service.py#L157-L160) |
| Backend env/volume tanımı | [`docker-compose.prod.yml:61-72`](file:///Users/isatezcan/Documents/Github/Tezlify/docker-compose.prod.yml#L61-L72) |
| OCI bucket/IAM geçmişi | [`docs/audits/whatsapp-offsite-backup-phase-3.9.10.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/audits/whatsapp-offsite-backup-phase-3.9.10.md) |
| Vault 0 / off-site restore | [`docs/audits/whatsapp-offsite-backup-phase-3.9.11.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/audits/whatsapp-offsite-backup-phase-3.9.11.md) |
| Fiziksel escrow BLOCKED | [`docs/audits/whatsapp-disaster-recovery-phase-3.9.19-closing.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/audits/whatsapp-disaster-recovery-phase-3.9.19-closing.md) |
| DB backup/DR runbook | [`docs/PHASE_10_1_BACKUP_DISASTER_RECOVERY.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/PHASE_10_1_BACKUP_DISASTER_RECOVERY.md) |
| Admin Backup & DR Center | [`docs/PHASE_10_6_5_BACKUP_DR_CENTER_REPORT.md`](file:///Users/isatezcan/Documents/Github/Tezlify/docs/PHASE_10_6_5_BACKUP_DR_CENTER_REPORT.md) |

## Ek B — Bu Turda Çalıştırılan Salt Okunur Kontroller

- `docker ps`, `docker exec tezlify-db psql -Atc "SELECT …"`, `pg_dump --version`, `pg_restore --version`
- `ls -la /opt/tezlify/backups/postgres`, `find`/`du` (RAM snapshot dizini), `systemctl list-timers`, `crontab -l`
- `docker exec tezlify-backend sh -c 'test -n "$…" && echo set || echo unset'` (yalnızca **varlık**; değer okunmadı)
- `free -h`, `nproc`, `df -h`
- OCI `GET /n/…/b?compartmentId=…`, `GET /n/…/b/tezlify-ram-snapshots`, `GET …/l`, `GET …/o?prefix=…`
- OCI `GET /20180608/vaults`, `GET /20180608/keys`, `GET /20160918/policies`, `GET /20160918/compartments`
- Yerel `printf 'test' | openssl enc -aes-256-gcm …` (yalnızca yetenek testi; gerçek veri yok)

**Yazma işlemi:** 0. **Dump:** 0. **Upload:** 0. **Anahtar üretimi:** 0. **DB yazımı:** 0. **Restart/recreate:** 0. **Kod/commit/push/deploy:** 0.
