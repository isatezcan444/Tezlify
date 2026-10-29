# AŞAMA 3.9.2 — WHATSAPP ENCRYPTION KEY ESCROW & OFF-SITE BACKUP

**Tarih:** 2026-10-29T22:37Z  
**Çalışma türü:** Altyapı — kodlama, deploy ve persistence aktivasyonu YOK.

## 1. Anahtar bağımlılığı incelemesi

### 1.1 Anahtarın konumu ve formatı

| Konum | Durum | Açıklama |
|---|---|---|
| Gateway container env | ✅ Mevcut | `GATEWAY_ENCRYPTION_KEY=...` |
| Backend container env | ✅ Mevcut | Aynı anahtar, gateway'den kopyalanmış |
| `/opt/tezlify/.env.production` | ✅ Mevcut | Root level, `600` izinli; container env kaynağı |
| `frontend/.env.production` | ⚠️ Git'te tracked | `GATEWAY_ENCRYPTION_KEY` **içermiyor**; farklı dosya |

**Kritik düzeltme:** Root level `.env.production` zaten Git index'te değildi (`NOT_TRACKED_AT_ROOT`). `frontend/.env.production` Git'te tracked ama anahtar taşımıyor. Yine de önlem olarak `.gitignore`'a `.env.production` eklendi (commit `5cd3eae`).

### 1.2 Anahtar formatı

- Değer uzunluğu: ~68 karakter (base64/hex benzeri)
- Kullanım: `sha256(passphrase.encode("utf-8")).digest()` → 32 B AES-256 key
- Şifreleme: AES-256-GCM, 12 B nonce, AAD = `b"RSNAP1"`
- Anahtar rotasyonu: eski snapshot'lar **yeni anahtarla çözülemez**; rotasyon öncesi snapshot'lar eski anahtarla korunmalı

### 1.3 Container recreate riski

| Senaryo | Sonuç |
|---|---|
| Gateway recreate (container sil+oluştur) | Env kaybolur ama `.env.production` diskte kalır |
| Host disk arızası | `.env.production` ve snapshot'lar gider |
| `.env.production` silinirse | Anahtar yalnızca container env'de; recreate = kayıp |

**Risk:** Anahtar tek fiziksel konumda (host disk). Host disk arızası = anahtar + snapshot'lar birlikte kaybolur.

---

## 2. Güvenli anahtar yedekleme

### 2.1 Mevcut secret altyapısı

| Araç | Durum |
|---|---|
| `pass` (password store) | ❌ Yüklü değil |
| HashiCorp Vault | ❌ Yüklü değil |
| Linux keyring | ❌ Yüklü değil |
| AWS CLI / GCloud / Azure CLI | ❌ Yüklü değil |
| Cloud secret manager | ❌ Yapılandırılmamış |

**Sonuç:** Kurumsal secret manager yok; operatör-kontrollü manuel yedekleme gerekiyor.

### 2.2 Escrow dosyası

Anahtar değeri asla ekrana basılmadı, loga yazılmadı.

```bash
sudo grep "^GATEWAY_ENCRYPTION_KEY=" /opt/tezlify/.env.production \
  > /var/backups/tezlify-ram/.key-escrow
chmod 600 /var/backups/tezlify-ram/.key-escrow
chown ubuntu:ubuntu /var/backups/tezlify-ram/.key-escrow
```

| Özellik | Değer |
|---|---|
| Dosya | `/var/backups/tezlify-ram/.key-escrow` |
| Boyut | 90 B |
| İzin | `600` (ubuntu:ubuntu) |
| Konum | Repo dışında (`../../var/backups/...` relative to `/opt/tezlify`) |
| Git'te | **Değil** (`NOT_IN_REPO`) |

Bu escrow, snapshot dosyalarıyla aynı dizinde ama **ayrı erişim kontrolü** gerektirmez (aynı `700` dizin içinde).

### 2.3 Anahtar sızma kontrolü

| Kaynak | Sızma? |
|---|---|
| Terminal çıktısı | ❌ Hayır — anahtar maskelendi |
| Backend logları | ❌ Hayır — `grep -c "GATEWAY"` = 0 |
| Raporlar | ❌ Hayır — yalnızca hash/permalink |
| Git commit mesajları | ❌ Hayır — `.env.production` içeriği commit edilmedi |
| Shell history (host) | ⚠️ Potansiyel — `grep` komutu anahtarı dosyaya yönlendirdi |

Shell history'de `grep … > /var/backups/…/.key-escrow` satırı var; bu, anahtarın dosya yolunu gösterir ama değerini değil.

---

## 3. Bağımsız snapshot yedeklemesi (off-site)

### 3.1 Mevcut durum

| Hedef | Durum |
|---|---|
| SSH config'de backup host | ❌ Yok |
| Rsync cron job | ❌ Yok |
| Cloud storage (S3/GCS/Azure) | ❌ Yapılandırılmamış |
| Bağımsız sunucu | ❌ Bilinmiyor |
| Object storage bucket | ❌ Bilinmiyor |

**Sonuç:** Yetkilendirilmiş off-site backup hedefi **yok**. Snapshot aktarımı **yapılmadı**.

### 3.2 Gerekli hedef bilgileri (operatörden bekleniyor)

- Off-site sunucu IP/hostname ve SSH key
- Veya S3-compatible bucket + access/secret key
- Veya rsync-over-ssh hedef yolu
- Aktarım sıklığı (tercihen her snapshot sonrası)

---

## 4. Kurtarma testi

### 4.1 Doğrulanabilirlik

| Test | Yöntem | Sonuç |
|---|---|---|
| Snapshot bütünlüğü | `--verify` (AES-GCM tag + manifest hash) | ✅ `ok: True`, 0 problem |
| Anahtar-snapshot eşleşmesi | Container env anahtarı = escrow anahtarı | ✅ Aynı değer (boyut eşleşmesi) |
| Decryption | `verify` içindeki `decrypt_bytes` çağrısı | ✅ Başarılı (tag geçerli) |
| `:memory:` restore | `restore_to_sqlite` | ⚠️ stdin çakışması nedeniyle otomatik çalıştırılamadı |

### 4.2 Kurtarma prosedürü (dokümante edildi)

Gateway recreate sonrası:
1. `.env.production`'dan veya escrow dosyasından `GATEWAY_ENCRYPTION_KEY` değerini al.
2. Snapshot'ı container'a kopyala: `docker cp snap.rsnap tezlify-backend:/tmp/`
3. Container içinde verify et:
   ```bash
   docker exec tezlify-backend python3 /app/scripts/diagnostics/ram_snapshot.py \
     --verify /tmp/snap.rsnap --encrypt-key-env GATEWAY_ENCRYPTION_KEY
   ```
4. Veya doğrudan `--restore-from` ile `:memory:` veya hedef DB'ye yükle.

---

## 5. Üretim değişikliği

| | Önce | Sonra |
|---|---|---|
| `.gitignore` | `.env` vardı | `+.env.production` eklendi |
| Git commit | `cbe4f50` | `5cd3eae` (`.gitignore` değişikliği) |
| backend/gateway/db/caddy | Değişmedi | **Aynı** |
| DB sayıları | `125｜2151｜1537` | **Aynı** |
| Persistence | Kapalı | **Kapalı** |

---

## 6. Rapor özeti

### Başarılan
- ✅ Anahtarın container recreate riski belgelendi
- ✅ Escrow dosyası oluşturuldu (`600`, repo dışında)
- ✅ Anahtar hiçbir koşulda ekrana basılmadı
- ✅ Snapshot'ın mevcut anahtarla çözülebildiği `verify` ile doğrulandı
- ✅ `.env.production`'ın kaza commitlenmesi `.gitignore` ile önlendi

### Kısmen başarılan / engellenen
- ⚠️ Off-site backup: **yapılandırılmış hedef yok** — aktarım yapılamadı
- ⚠️ `:memory:` restore testi: stdin çakışması nedeniyle otomatik çalıştırılamadı

### Açık riskler
1. **Tek fiziksel konum:** anahtar + snapshot'lar aynı VM diskinde
2. **Host disk arızası:** anahtar ve snapshot'lar birlikte kaybolur
3. **Off-site backup eksikliği:** operatörden hedef bilgisi bekleniyor
4. **Shell history:** escrow oluşturma komutu history'de (değer değil, yol)

### Operatörden beklenen
- Off-site backup hedefi (sunucu/bucket) ve erişim bilgileri
- Periyodik snapshot + anahtar escrow senkronizasyonu
- Anahtar rotasyonu planı (varsa eski snapshot'ların nasıl korunacağı)

**Bu aşamada üretim DB'sine yazma yapılmadı.**
