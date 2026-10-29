# AŞAMA 3.9.6 — OFF-SITE BACKUP VE WHATSAPP RAM SNAPSHOT KORUMA

**Çalışma türü:** ALTYAPI + TASARIM  
**Başlangıç:** 2026-10-30T02:17Z  
**Bitiş:** 2026-10-30T02:25Z  
**Üretim yazımı:** 0

---

## 1. Yönetici Özeti

Bu aşamada:

1. Production durumu yeniden doğrulandı.
2. 4 snapshot ve 2 escrow dosyasının envanteri çıkarıldı.
3. Tüm snapshot'lar V2 escrow ile verify edildi (`ok=True`, 0 problem).
4. Off-site backup seçenekleri karşılaştırıldı.
5. Güvenli backup/restore mimarisi tasarlandı.
6. Aktarım yapılmadı — hedef bilgisi operatörden bekleniyor.

---

## 2. Production Mevcut Durum

### 2.1. Container'lar

| Container | ID | Başlangıç | Restart |
|---|---|---|---|
| tezlify-backend | `ce2e901b6619` | 2026-10-29T21:47:56Z | 0 |
| tezlify-gateway | `5b867095d376` | 2026-10-27T17:25:57Z | 0 |
| tezlify-db | `f6d79c4a1f8b` | 2026-10-01T17:45:08Z | 0 |
| tezlify-caddy | `ee66a5cab371` | 2026-10-12T13:12:45Z | 0 |

### 2.2. DB ve persistence

- Conversations: 125
- Messages: 2.151
- Contacts: 1.537
- Persistence: `config=False`, `runs=0`
- WhatsApp session `201`: `CONNECTED`

### 2.3. Canonical key source

- Dosya: `/opt/tezlify/.env.production`
- İzin: `600`
- Git: NOT tracked
- Compose: `docker-compose.prod.yml` (`env_file`)
- Container env ile eşleşme: ✅ Doğrulandı (3.9.5)

---

## 3. Snapshot Envanteri

### 3.1. Dosyalar

| Dosya | Boyut | SHA-256 | İzin |
|---|---|---|---|
| `tezlify-ram-20261029T125657Z.rsnap` | 7.100.080 B | `2a150698a884dc9c62de98f9f36366439ef13f3ba0799f0940609effa59e1f8e` | 600 |
| `tezlify-ram-20261029T125755Z.rsnap` | 7.100.080 B | `00f657b17eda030194dc76e99fb23fe6bb7ea4f0e443b9a108d038520a595e07` | 600 |
| `tezlify-ram-20261029T210007Z.rsnap` | 7.135.835 B | `fdafdb7b3c7cdb647c89d899e4a2a322f6d4b3883559b30a1f5212fd67e17fcb` | 600 |
| `tezlify-ram-20261029T220302Z.rsnap` | 7.147.070 B | `158794ed6ba7f9646876f1b64481e29b5001c0f282f250c4ed33b4caa41126cd` | 600 |

### 3.2. Manifest dosyaları

| Dosya | Boyut | SHA-256 | İzin |
|---|---|---|---|
| `tezlify-ram-20261029T125657Z.manifest.json` | 12.199 B | `b0c69ddcb8f20d14474b0ea5bc5cfa96dbab435b9505403d0f515d6ee35efe3e` | 600 |
| `tezlify-ram-20261029T125755Z.manifest.json` | 12.199 B | `9dd710612f6012f660d3a8894e8d749991f0f7f1ecc830ec0908b4ceb30b3adc` | 600 |
| `tezlify-ram-20261029T210007Z.manifest.json` | 12.316 B | `5022a552b71e149962c87ff6d68444f3fb382a0b064b8234d574ca42e8b4ea79` | 600 |
| `tezlify-ram-20261029T220302Z.manifest.json` | 12.316 B | `c2342e93024f0b4f80ae0736fe8faf7667db5947fd8a7baa17d9635c511b4c6d` | 600 |

### 3.3. Escrow dosyaları

| Dosya | Boyut | SHA-256 | İzin | Durum |
|---|---|---|---|---|
| `.key-escrow` | 90 B | `fa44c2ee...` | 600 | V1 (yanlış anahtar — 3.9.3 öncesi) |
| `.key-escrow-v2` | 88 B | `d03ed27a...` | 600 | V2 (doğru anahtar) |

### 3.4. Toplam

- Snapshot dizini: `/var/backups/tezlify-ram/`
- Dizin izni: `700`
- Toplam boyut: ~28 MB
- Toplam dosya: 10 (4 rsnap + 4 manifest + 2 escrow)

### 3.5. Verify sonuçları

| Snapshot | V2 Escrow ile Verify | Integrity | Completeness |
|---|---|---|---|
| `20261029T125657Z` | `ok=True` | 0 | 0 |
| `20261029T125755Z` | `ok=True` | 0 | 0 |
| `20261029T210007Z` | `ok=True` | 0 | 0 |
| `20261029T220302Z` | `ok=True` | 0 | 0 |

### 3.6. Medya kapsamı

Snapshot formatı **medya baytlarını kapsamıyor**. Yalnızca:
- Mesaj metadata'sı (gönderen, alıcı, zaman, tip)
- Sohbet listesi ve sıralama bilgisi
- Kimlik eşlemeleri
- Gateway durum bilgisi

Medya dosyaları (`whatsapp_media` volume) ayrı olarak yedeklenmeli.

---

## 4. Off-Site Hedef Seçenekleri

### 4.1. Oracle Cloud Object Storage (OCI)

| Özellik | Değerlendirme |
|---|---|
| Encryption | ✅ Sunucu-taraflı (AES-256) + istemci-taraflı mümkün |
| TLS | ✅ Zorunlu |
| Versioning | ✅ Destekleniyor |
| Lifecycle | ✅ Retention kuralları tanımlanabilir |
| Maliyet | Düşük (standart: ~$0.025/GB/ay) |
| Geri yükleme | API/CLI ile doğrudan erişim |
| Tek VM arızasına karşı | ✅ Oracle Cloud altyapısı ayrı bölgede replike edebilir |
| Entegrasyon | `oci` CLI zaten Oracle Cloud VM'de kurulu olabilir |

### 4.2. S3-uyumlu Object Storage (AWS S3, Wasabi, Backblaze B2, MinIO)

| Özellik | Değerlendirme |
|---|---|
| Encryption | ✅ SSE-S3/SSE-KMS + istemci-taraflı |
| TLS | ✅ Zorunlu |
| Versioning | ✅ Destekleniyor (S3, Wasabi) |
| Lifecycle | ✅ S3 Lifecycle kuralları |
| Maliyet | Değişken (AWS: ~$0.023/GB/ay, Wasabi: düz $7/TB/ay) |
| Geri yükleme | API/CLI/sdk |
| Tek VM arızasına karşı | ✅ Tamamen bağımsız servis |
| Entegrasyon | `awscli`, `rclone`, `s3cmd` |

### 4.3. SFTP/SCP üzerinden bağımsız sunucu

| Özellik | Değerlendirme |
|---|---|
| Encryption | ⚠️ Transit: SSH. Rest: dosya sistemi şifrelemesi gerekli |
| TLS | ✅ SSH (22/tcp) |
| Versioning | ❌ Dosya seviyesinde manuel veya `rsync --backup` |
| Lifecycle | ❌ Manuel veya cron ile temizlik |
| Maliyet | Ek sunucu maliyeti |
| Geri yükleme | `scp`/`rsync` ile doğrudan |
| Tek VM arızasına karşı | ✅ Farklı fiziksel konum |
| Entegrasyon | `rsync`, `scp` — standart araçlar |

### 4.4. Karşılaştırma Özeti

| Kriter | OCI Object Storage | S3/Wasabi | SFTP/Sunucu |
|---|---|---|---|
| Kurulum kolaylığı | Yüksek (VM zaten OCI'da) | Orta | Orta |
| Maliyet (28 MB) | ~$0.001/ay | ~$0.001/ay | Sunucu maliyeti |
| Güvenlik | Yüksek | Yüksek | Orta (konfigürasyona bağlı) |
| Otomasyon | Yüksek | Yüksek | Düşük |
| Versioning | Native | Native | Manuel |
| İki ayrı bölge | OCI'nin sunduğu | Evet | Evet |
| Anahtar yönetimi | OCI Vault | AWS KMS/SSE | Manuel |

**Öneri:** Oracle Cloud Object Storage (aynı cloud provider, farklı bölge/availability domain) veya Wasabi (düşük maliyet, S3-uyumlu, versioning). Eğer operatörün zaten AWS/OCI hesabı varsa o hesap tercih edilmeli.

---

## 5. Backup Mimarisi

### 5.1. Hedef mimari

```
┌─────────────────────────────────────────────┐
│  PRODUCTION VM (Oracle Cloud)               │
│  /var/backups/tezlify-ram/                  │
│  ├── *.rsnap (şifreli snapshot)             │
│  ├── *.manifest.json                        │
│  └── .key-escrow-v2 (şifreleme anahtarı)    │
└─────────────────────────────────────────────┘
                    │
                    │ rsync / rclone / oci cli
                    │ (TLS üzerinden)
                    ▼
┌─────────────────────────────────────────────┐
│  OFF-SITE TARGET (farklı bölge/provider)    │
│  tezlify-backup/snapshots/                  │
│  ├── *.rsnap                                │
│  ├── *.manifest.json                        │
│  └── .key-escrow-v2 (AYRI konumda)          │
└─────────────────────────────────────────────┘
```

### 5.2. Anahtar ayrımı (kritik)

**Snapshot ve escrow aynı off-site konumda tutulmamalı.**

| Varlık | Off-site Konum 1 | Off-site Konum 2 |
|---|---|---|
| `*.rsnap` + `*.manifest.json` | ✅ Bucket: `tezlify-backup/snapshots/` | — |
| `.key-escrow-v2` | — | ✅ Ayrı bucket veya farklı erişim kimlikleri |

**Neden:** Snapshot şifreli ama escrow anahtarını ele geçiren herkes snapshot'ları çözebilir. Ayrım, "her iki konumun aynı anda compromise olması" koşulunu zorunlu kılar.

### 5.3. Aktarım prosedürü

1. **Snapshot seç:** En yeni `*.rsnap` + eşleşen `*.manifest.json`
2. **SHA-256 hesapla:** Kaynak dosyaların hash'lerini kaydet
3. **Aktar:** `rclone copy` veya `oci os object put` ile off-site'e gönder
4. **SHA-256 doğrula:** Hedefteki dosyaların hash'lerini yeniden hesapla
5. **Karşılaştır:** Kaynak == Hedef hash
6. **Audit log:** `/var/log/tezlify-backup.log` veya benzeri bir dosyaya kaydet
7. **Escrow aktar:** Ayrı hedefe, ayrı erişim kimlikleriyle gönder

### 5.4. Idempotency

- Aynı dosya tekrar aktarılırsa: S3/OCI versioning üzerine yazar veya `Content-MD5` eşleşmesiyle atlar
- `rclone --checksum` ile mükerrer aktarım önlenir
- Snapshot dosya adı timestamp içerdiği için benzersiz

### 5.5. Fail-closed davranış

- Aktarım başarısız olursa: kaynak snapshot asla silinmez
- Hash eşleşmezse: hedefteki dosya silinir, hata raporlanır
- Escrow aktarımı başarısız olursa: snapshot aktarımı da rollback edilir (tam tutarlılık)

---

## 6. Restore Test Planı

### 6.1. İzole test ortamı

Production'a dokunmadan:

```bash
# 1. Snapshot kopyasını al
mkdir -p /tmp/tezlify-restore-test
cp /var/backups/tezlify-ram/tezlify-ram-20261029T220302Z.rsnap /tmp/tezlify-restore-test/
cp /var/backups/tezlify-ram/.key-escrow-v2 /tmp/tezlify-restore-test/

# 2. SHA-256 doğrula
cd /tmp/tezlify-restore-test
sha256sum *.rsnap

# 3. Ayrı key escrow ile çözümle
KEY=$(cat .key-escrow-v2 | cut -d= -f2-)
cat *.rsnap | docker run --rm -i -e TEST_KEY="$KEY" \
  tezlify-backend python3 -c "<ram_snapshot.py>" \
  --verify - --encrypt-key-env TEST_KEY

# 4. Kayıt sayısını doğrula
# (verify çıktısı record_count, chat_count döndürür)

# 5. Cleanup
rm -rf /tmp/tezlify-restore-test
```

### 6.2. Production dışı test kuralları

- `/tmp` dizini kullan (RAM veya ephemeral)
- Production container'larına `docker exec` yapma
- Production DB'ye bağlanma
- Key değerini loglara yazma

---

## 7. Güvenlik Tehdit Modeli

### 7.1. Tehditler ve karşı önlemler

| Tehdit | Olasılık | Etki | Karşı Önlem |
|---|---|---|---|
| VM disk arızası | Düşük | Yüksek | Off-site backup |
| Oracle Cloud hesap compromise | Düşük | Yüksek | Farklı provider/hesap |
| Snapshot şifrelemesi kırılması | Çok düşük | Yüksek | AES-256-GCM, güçlü anahtar |
| Anahtar escrow sızdırılması | Düşük | Yüksek | Ayrı konum, 600 izin |
| Aktarım sırasında man-in-the-middle | Düşük | Orta | TLS zorunlu |
| Operatör hatası (yanlış dosya silme) | Orta | Orta | Versioning, audit log |
| Backup aracı hatası | Düşük | Orta | SHA-256 doğrulama |

### 7.2. Güvenlik prensipleri

1. **Defense in depth:** Snapshot şifreli + ayrı anahtar + ayrı konum
2. **Fail-closed:** Aktarım hatası = kaynak korunur
3. **Audit:** Her aktarım loglanır
4. **Minimization:** Yalnızca gerekli veri aktarılır
5. **Separation:** Anahtar ve veri farklı konumlarda

---

## 8. Gerekli Operatör Bilgileri

Off-site backup kurulumu için operatörden beklenen:

1. **Hedef seçimi:** OCI Object Storage / S3 / Wasabi / SFTP sunucu / Diğer
2. **Hedef bağlantı bilgileri:**
   - S3/OCI: Endpoint, bucket adı, access key / secret key
   - SFTP: Host, port, kullanıcı adı, SSH key veya parola
3. **Bölge/availability domain:** Production VM'den farklı olmalı
4. **Erişim kimlikleri:** Snapshot ve escrow için ayrı IAM kullanıcıları/politikalar
5. **Retention politikası:** Snapshot'ların ne kadar süre saklanacağı (örn. 30 gün)
6. **Otomasyon sıklığı:** Günlük / haftalık / manuel

---

## 9. Uygulama İçin Sonraki Aşama Planı

### Aşama 3.9.7 (önerilen): Off-site Backup Kurulumu

1. Operatörden hedef bilgilerini al
2. `rclone` veya `oci cli` kurulumunu yap
3. Bağlantı ve erişim testi yap
4. İlk aktarımı gerçekleştir
5. SHA-256 doğrulaması yap
6. Audit log'u başlat
7. Otomasyon (cron/systemd timer) kur

### Aşama 3.9.8 (önerilen): Restore Testi

1. İzole ortamda off-site'den indirme testi
2. SHA-256 doğrulaması
3. Snapshot çözme testi
4. Kayıt sayısı ve bütünlük kontrolü

---

## 10. Production Değişikliği

**Hiçbir production değişikliği yapılmadı.**

- Container'lar aynı ID'lerle çalışıyor
- DB sayıları değişmedi
- Snapshot dizini dokunulmadı
- Yalnızca salt okunur inceleme yapıldı

---

## 11. Açık Riskler

| Risk | Şiddet | Açıklama |
|---|---|---|
| Tek fiziksel konum | **KRİTİK** | Tüm veri aynı VM diskinde. Arıza = toplam kayıp. |
| Off-site backup yok | **KRİTİK** | Henüz yapılandırılmadı. |
| Medya baytları yedeklenmiyor | Yüksek | Snapshot yalnızca metadata. Medya ayrı yedeklenmeli. |
| V1 escrow hâlâ var | Düşük | Yanlış anahtar; karışıklık riski. |

---

*Rapor hazırlayan: WorkBuddy AI Agent*  
*Üretim yazımı: 0*  
*Salt okunur garantisi: Sağlandı*
