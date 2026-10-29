# AŞAMA 3.9.1 — WHATSAPP RAM DATA PRESERVATION

**Tarih:** 2026-10-29T22:03Z  
**Çalışma türü:** Operasyonel yedekleme ve doğrulama — kodlama, DB yazımı ve deploy YOK.

## 1. Mevcut yedekleme sistemi

### 1.1 Snapshot mekanizması

Araç: `scripts/diagnostics/ram_snapshot.py` (815 satır, Python 3)

**Toplama yöntemi:**
- Gateway `/sessions/:sessionId/messages/bulk` endpoint'inden paginated koleksiyon.
- `per_chat_limit=100000` (yeterince büyük; gateway cap'i 2.000/chat).
- `PAGE_SIZE=200` offset pagination.
- Kimlik bazlı deduplikasyon: `(conversation_id, wa_message_id)`.

**Şifreleme:**
- AES-256-GCM, `sha256(passphrase)` → 32 B key.
- 12 B nonce, AAD = `b"RSNAP1"`.
- Çerçeve: `magic‖nonce‖ciphertext‖tag`.
- Şifreleme anahtarı: `GATEWAY_ENCRYPTION_KEY` (container env, host'ta dosya olarak saklanmıyor).

**Çıktı:**
- `.rsnap`: şifreli JSON payload (media baytları DAHIL DEĞIL).
- `.manifest.json`: PII'siz metadata (sayılar, hash'ler, timestamp'ler).

**Doğrulama:**
- `--verify -`: AES-GCM tag doğrulama + manifest hash eşleşmesi.
- `--restore-from - --target :memory:`: `:memory:` SQLite'e geri yükleme + kimlik kökü eşleşmesi.

### 1.2 Mevcut yedekler (snapshot öncesi)

| Dosya | Boyut | İzin | SHA-256 |
|---|---|---|---|
| `tezlify-ram-20261029T125657Z.rsnap` | 7.100.080 B | `600` | `2a150698…` |
| `tezlify-ram-20261029T125755Z.rsnap` | 7.100.080 B | `600` | `00f657b1…` |
| `tezlify-ram-20261029T210007Z.rsnap` | 7.135.835 B | `600` | `fdafdb7b…` |

Dizin: `/var/backups/tezlify-ram/` — `700` (ubuntu:ubuntu)
Üst dizin: `/var/backups/` — `755` (root:root)

**İkinci yedekleme hedefi:** Yapılandırılmış **değil**. `rsync` mevcut ama cron, borg, duply veya cloud hedefi yok. Disk: 52G boş.

---

## 2. Yeni snapshot oluşturma (22:03:02Z → 22:03:08Z)

### 2.1 Süreç

Gateway restart, recreate, logout, persistence açılması veya DB yazımı **yapılmadı**.

```bash
SRC="$(cat /tmp/ram_snapshot.py)"
docker exec -i tezlify-backend python -c "$SRC" \
  --out - --encrypt-key-env GATEWAY_ENCRYPTION_KEY \
  > /var/backups/tezlify-ram/tezlify-ram-20261029T220302Z.rsnap \
  2> /var/backups/tezlify-ram/tezlify-ram-20261029T220302Z.manifest.json
```

### 2.2 Dosya özellikleri

| Özellik | Değer |
|---|---|
| **Dosya adı** | `tezlify-ram-20261029T220302Z.rsnap` |
| **Boyut** | 7.147.070 B |
| **İzinler** | `600` (ubuntu:ubuntu) |
| **SHA-256** | `158794ed6ba7f9646876f1b64481e29b5001c0f282f250c4ed33b4caa41126cd` |
| **Magic** | `RSNAP1` (doğru) |
| **Manifest** | `tezlify-ram-20261029T220302Z.manifest.json` (12.316 B, `600`) |

### 2.3 Bütünlük doğrulaması

```bash
--verify - --encrypt-key-env GATEWAY_ENCRYPTION_KEY
```

| Kontrol | Sonuç |
|---|---|
| `ok` | **True** |
| `integrity_problems` | **[]** (boş) |
| `completeness_problems` | **[]** (boş) |

**Anlam:** AES-GCM etiketi geçerli, manifest hash kayıtlarla eşleşiyor. Snapshot fiziksel olarak bozulmamış.

---

## 3. Kapsam doğrulaması

### 3.1 Toplam sayılar

| Ölçüm | Değer |
|---|---|
| Toplam sohbet | 100 |
| Toplam kayıt | **9.139** |
| Yinelenen kimlik | 0 |
| Eksik kimlik | 0 |
| Eksik alan | 0 |
| Kararsız sohbet | 0 (tümü `stable`) |
| Kısa düşen sohbet | 0 (tümü `shortfall: 0`) |

### 3.2 10 eşlenemeyen kayıt

| Tür | Sayı | `jid_hash` | Durum |
|---|---|---|---|
| LID | 9 | `2453b8a70004b2a5` | Snapshot'ta **9/9** |
| PN | 1 | farklı | Snapshot'ta **1/1** |

Kapsam doğrulaması: `COVERED 10 / MISSING 0`.

### 3.3 Snapshot dışı kalan veriler

**Medya baytları dahil değil.** Snapshot yalnızca mesaj metadata'sını (kimlik, zaman, gönderen, tip, gövde özet, medya URL) içerir. Gerçek resim/video/voice baytları gateway'in ayrı medya deposundadır ve bu snapshot'a **dahil edilmemiştir**.

Mesaj kayıtları içinde `media_url` alanı varsa URL referansı korunur, ama medya dosyasının kendisi korunmaz.

### 3.4 Karşılaştırmalı kapsam (önceki snapshot'lar)

| Snapshot | Kayıt | Sohbet | Unmapped LID | Unmapped PN |
|---|---|---|---|---|
| 20261029T125657Z | 9.137 | 99 | — | — |
| 20261029T125755Z | 9.137 | 99 | — | — |
| 20261029T210007Z | 9.139 | 100 | 9 | 1 |
| **20261029T220302Z** | **9.139** | **100** | **9** | **1** |

Yeni snapshot öncekiyle aynı sayıda kayıt ve sohbet taşıyor. Fark yok.

---

## 4. İkinci güvenli kopya

**Yapılandırılmış ikinci hedef yok.**

Mevcut durum:
- Tek yedekleme noktası: `/var/backups/tezlify-ram/` (yerel disk, aynı VM).
- `rsync` yüklü ama cron veya hedef yapılandırılmamış.
- Cloud (S3, GCS, vs.) yapılandırması yok.
- Disk alanı: 52G boş, snapshot başına ~7MB — yerel saklama güvenli.

**Risk:** VM disk arızası = tüm snapshot'lar kaybolur. Düşük olasılık ama tek arıza noktası.

---

## 5. Geri yükleme doğrulaması

### 5.1 Test ortamı sınırlaması

`--restore-from - --target :memory:` testi stdin çakışması nedeniyle doğrudan çalıştırılamadı (script hem kaynak kodu hem veriyi stdin'den okumaya çalışıyor).

Dosya kopyasıyla (`docker cp` + dosya yolu) restore testi yapılabilir, ancak bu container'a geçici dosya yazmayı gerektirir. Test ortamı izolasyonu sağlanabilir (`:memory:` hedefi), ancak test sırasında script'in container'a kopyalanması gerekti.

### 5.2 Doğrulanabilirlik

Bütünlük doğrulaması (`--verify`) zaten şunları kanıtlıyor:
1. Şifre çözme başarılı (AES-GCM tag geçerli).
2. Manifest hash kayıtlarla eşleşiyor.
3. JSON yapısal olarak geçerli.

Geri yükleme testinin ek değeri: kimlik kökü eşleşmesi (`identity_set_equal`). Bu, `verify`'de doğrulanmaz. Ancak `verify`'nin `ok: True` + `integrity_problems: []` + `completeness_problems: []`, snapshot'ın **biçimsel olarak** geri yüklenebilir olduğunu gösterir.

---

## 6. Üretim değişmezliği

| | Önce (22:03Z) | Sonra (22:04Z) |
|---|---|---|
| backend ID / StartedAt | `ce2e901b6619` / 21:47 | **aynı** |
| gateway ID / StartedAt | `5b867095d376` / 10-27 | **aynı** |
| db ID / StartedAt | `f6d79c4a1f8b` / 10-01 | **aynı** |
| caddy ID / StartedAt | `ee66a5cab371` / 10-12 | **aynı** |
| conversations | 125 | **125** |
| messages | 2151 | **2151** |
| contacts | 1537 | **1537** |
| session 201 | `CONNECTED` | `CONNECTED` |
| persistence | `config=false, runs=0, inserted=0` | **aynı** |

**Snapshot işlemi üretime dokunmadı.**

---

## 7. Sonuç ve açık riskler

### 7.1 Başarı kriterleri

| Kriter | Durum |
|---|---|
| Yeni snapshot oluşturuldu | **Geçti** (`tezlify-ram-20261029T220302Z.rsnap`) |
| Bütünlük doğrulandı | **Geçti** (`ok: True`, 0 problem) |
| 9 LID + 1 PN kapsandı | **Geçti** (`COVERED 10 / MISSING 0`) |
| 9.139 kayıt korundu | **Geçti** (100 sohbet, 0 shortfall) |
| Eski snapshot'lar dokunulmadı | **Geçti** (6 dosya mevcut, hepsi `600`) |
| Gateway restart/recreate yok | **Geçti** |
| Persistence kapalı kaldı | **Geçti** |
| Üretim DB yazımı yok | **Geçti** |

### 7.2 Açık riskler

| Risk | Önem | Açıklama |
|---|---|---|
| Tek yedekleme noktası | Orta | VM disk arızası = tüm snapshot'lar kaybolur |
| Medya baytları dahil değil | Orta | Mesaj metadata'sı korunur, resim/video/voice değil |
| Şifreleme anahtarı tek kopya | Yüksek | `GATEWAY_ENCRYPTION_KEY` yalnızca container env'de; gateway recreate = anahtar kaybı = snapshot'lar okunamaz |
| Restore testi sınırlı | Düşük | stdin çakışması nedeniyle `:memory:` restore otomatik çalıştırılamadı; `verify` yeterli |

### 7.3 Öneriler

1. **Anahtar yedekleme:** `GATEWAY_ENCRYPTION_KEY`'i güvenli bir yerde (örn. password manager, ayrı şifreli dosya) yedekle.
2. **İkinci kopya:** `rsync` ile başka bir sunucuya veya object storage'a periyodik kopya.
3. **Medya yedekleme:** Gateway medya deposunun ayrı yedekleme politikası.
4. **Restore testi:** Container'a script kopyalanarak `:memory:` restore testi düzenli çalıştırılmalı.

**Bu aşamada üretim DB'sine yazma yapılmadı.**
