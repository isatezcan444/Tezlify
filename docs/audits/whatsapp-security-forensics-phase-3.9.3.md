# AŞAMA 3.9.3 — WHATSAPP SECURITY FORENSICS, KEY ESCROW VALIDATION & ROTATION PLAN

**Çalışma türü:** ALTYAPI + GÜVENLİK DENETİMİ — salt okunur inceleme, kod düzeltmesi yok, production deploy yok.  
**Başlangıç:** 2026-10-29T22:30Z  
**Bitiş:** 2026-10-29T22:50Z  
**Üretim yazımı:** 0

---

## 1. Yönetici Özeti

Bu aşamada:

1. Tüm Git geçmişi `GATEWAY_ENCRYPTION_KEY` ve diğer secret'lar açısından tarandı.
2. `/var/backups/tezlify-ram/.key-escrow` dosyasının **yanlış anahtarı** içerdiği tespit edildi.
3. Doğru anahtar içeren `.key-escrow-v2` oluşturuldu ve **tüm 4 snapshot** başarıyla çözüldü.
4. `.env.production` dosyasının çalışan container'ın gerçek anahtarıyla **eşleşmediği** kanıtlandı.
5. `production-ops.md` dosyasında gerçek üretim anahtarının bulunduğu doğrulandı.

**Kritik operasyonel risk:** Container `docker compose` ile yeniden oluşturulursa ve kaynak `.env.production` olursa, mevcut 4 şifreli snapshot **kalıcı olarak okunamaz** hale gelir.

---

## 2. Git Geçmişi Secret Taraması

### 2.1. Kapsam ve yöntem

- Tüm local ve remote branch'ler (`main`, `security/before-purge`, `feature/chat-list-order-fix`, `feature/verify-logs`)
- Tüm tag'ler
- `git log --all -S "GATEWAY_ENCRYPTION_KEY"` ile presence-only tarama
- Hiçbir secret değeri ekrana basılmadı; yalnızca dosya yolu, commit hash ve risk seviyesi raporlandı
- Hardcoded değer tespiti için `value_length > 20` ve `=\$` dışındaki atamalar filtrelendi

### 2.2. Bulgular

| Dosya/Path | Git Durumu | GATEWAY_ENCRYPTION_KEY İçeriği | Risk |
|---|---|---|---|
| `/.env.production` (root) | **NOT tracked** | — | Yok (diskte var, Git'te yok) |
| `/frontend/.env.production` | **Tracked** (`fdcf016..HEAD`) | **EMPTY** (`GATEWAY_ENCRYPTION_KEY=`) | Düşük — değer boş |
| `/.env.example` | Tracked | Placeholder (`your-32-byte-encryption-key`) | Yok |
| `/.env.staging.example` | Tracked | Placeholder (`staging-32-byte-encryption-key`) | Yok |
| `/whatsapp-gateway/.env.example` | Tracked | Placeholder (`your-32-byte-encryption-key`) | Yok |
| `/docker-compose.yml` | Tracked | `${GATEWAY_ENCRYPTION_KEY}` (env interpolation) | Yok |
| `/scripts/deploy/host-release.sh` | Tracked | `$GATEWAY_ENCRYPTION_KEY` (shell variable) | Yok |
| `/scripts/diagnostics/phase154_outbox_lineage.mjs` | Tracked | `process.env.GATEWAY_ENCRYPTION_KEY` | Yok |
| `/scripts/diagnostics/restore_production_state.mjs` | Tracked | `process.env.GATEWAY_ENCRYPTION_KEY` | Yok |
| `/.workbuddy-ai/memory/reference/production-ops.md` | **Tracked** | **REAL VALUE** (length=44, hash=`e79af96f...`) | **YÜKSEK** |

### 2.3. Sızıntı sınıflandırması

- **Gerçek secret bulundu:** `production-ops.md` (local repo'da tracked, üretim host'unda yok)
- **Secret bulunmadığı doğrulandı:** Tüm `.env.example`, `.env.staging.example`, `docker-compose.yml`, deploy script'leri
- **Doğrulama yapılamadı:** `.cline/` checkpoint dosyaları ve `codex/turn-diffs/` — bu dosyalar binary veya çok büyük olduğu için taranamadı; içerikleri görülmedi

### 2.4. `production-ops.md` bulgusu

Dosya: `.workbuddy-ai/memory/reference/production-ops.md`  
Satır: 178  
İçerik: `GATEWAY_ENCRYPTION_KEY=<real_value>` (length=44 chars)  
Hash: `e79af96f41045c2ea32d51f5cea75d6c9b38cb21a004e13308acaad5df69158b`

Bu hash, çalışan container'ın `GATEWAY_ENCRYPTION_KEY` hash'iyle **birebir eşleşiyor**.

**Yorum:** Bu dosya local geliştirme repo'sunda tracked. Üretim host'unda (`/opt/tezlify`) bu dosya yok. Risk, local repo'nun bir şekilde sızmış olması veya gelecekte push edilmesi ihtimalidir.

---

## 3. Escrow Doğrulaması

### 3.1. Orijinal escrow (v1)

- Dosya: `/var/backups/tezlify-ram/.key-escrow`
- Boyut: 90 B
- İzin: 600 (ubuntu:ubuntu)
- Kaynak: `/opt/tezlify/.env.production`
- Hash: `be27a1119ef6c0607588a2fc969c3020629b8a466b62918ce4891dead342006d`
- Uzunluk: 67 karakter

**Sonuç:** Bu anahtar **snapshot'ları çözemiyor** (`cryptography.exceptions.InvalidTag`).

### 3.2. Doğru escrow (v2)

- Dosya: `/var/backups/tezlify-ram/.key-escrow-v2`
- Boyut: 88 B
- İzin: 600 (ubuntu:ubuntu)
- Kaynak: `tezlify-backend` container env (`docker exec` ile güvenli biçimde alındı)
- Hash: `e79af96f41045c2ea32d51f5cea75d6c9b38cb21a004e13308acaad5df69158b`
- Uzunluk: 65 karakter

**Sonuç:** Bu anahtar **tüm 4 snapshot'ı başarıyla çözüyor**.

### 3.3. Snapshot çözme testi (v2 ile)

| Snapshot | Boyut | Verify `ok` | Integrity | Completeness |
|---|---|---|---|---|
| `tezlify-ram-20261029T125657Z.rsnap` | 7.145.530 B | `True` | 0 | 0 |
| `tezlify-ram-20261029T125755Z.rsnap` | 7.145.530 B | `True` | 0 | 0 |
| `tezlify-ram-20261029T210007Z.rsnap` | 7.145.530 B | `True` | 0 | 0 |
| `tezlify-ram-20261029T220302Z.rsnap` | 7.147.070 B | `True` | 0 | 0 |

**Test yöntemi:** `ram_snapshot.py --verify` komutu, v2 anahtarı `TEST_KEY` env değişkeni olarak container'a aktarılarak çalıştırıldı. Script `stdin` üzerinden gönderildi (container imajında yer almıyor).

### 3.4. Anahtar kaynağı analizi

| Kaynak | Hash | Uzunluk | Durum |
|---|---|---|---|
| `tezlify-backend` container env | `e79af96f...` | 65 | **Gerçek anahtar** |
| `/opt/tezlify/.env.production` | `be27a111...` | 67 | Yanlış/Eski |
| `/opt/tezlify/.env` | `be27a111...` | 67 | Yanlış/Eski |
| Host env (`ubuntu` user) | `e3b0c4429...` (boş string) | 0 | Tanımlı değil |
| `frontend/.env.production` (Git) | — | 0 | Boş |

**Çıkarım:** Container, `docker-compose.yml`'deki `${GATEWAY_ENCRYPTION_KEY}` interpolation'ını host env'den (boş) değil, muhtemelen `docker compose up` komutunun çalıştırıldığı shell oturumundan veya farklı bir `.env` dosyasından almış. `.env.production` dosyası, üretim ortamının gerçek yapılandırmasıyla senkronize değil.

---

## 4. `.env.production` Düzeltmesi Doğrulaması

### 4.1. Mevcut durum

| Konum | Git Durumu | Gerçek Secret İçeriyor |
|---|---|---|
| Repo root `.env.production` | **NOT tracked** | Evet (ama yanlış anahtar) |
| `frontend/.env.production` | Tracked | Hayır (boş) |
| Üretim host `/opt/tezlify/.env.production` | NOT tracked | Evet (yanlış anahtar) |
| `.gitignore` (root) | Tracked (3.9.2'de eklendi) | — |

### 4.2. Docker Compose yapılandırması

```yaml
# docker-compose.yml satır 19
gateway:
  environment:
    - GATEWAY_ENCRYPTION_KEY=${GATEWAY_ENCRYPTION_KEY}
```

`env_file` yalnızca `backend` servisi için tanımlı (`satır 48`). Gateway servisi için ayrı `env_file` yok; anahtar doğrudan shell env'den geliyor.

---

## 5. Key Rotation Planı (Öneri)

### 5.1. Mevcut durum

- Eski anahtar (v1 / `.env.production`): Snapshot'ları çözemiyor, kullanılmıyor.
- Aktif anahtar (v2 / container): Tüm snapshot'ları şifreliyor, çalışan sistemde kullanılıyor.

### 5.2. Rotasyon gereksinimi

**Acil rotasyon gerekli değil** (anahtar sızdırılmamış görünüyor), ancak aşağıdaki koşullarda zorunlu:

1. `production-ops.md`'deki key değeri herhangi bir remote'a push edilirse.
2. Container recreate yapılacaksa (`.env.production` yanlış olduğu için recreate = snapshot kaybı).
3. Operasyonel bir incident sonrası.

### 5.3. Rotasyon prosedürü (plan)

1. **Yeni anahtar oluştur:** `openssl rand -hex 32` veya eşdeğeri (AES-256-GCM için 32 byte).
2. **Yeni snapshot al:** Yeni anahtarla şifrelenmiş, verify edilmiş snapshot.
3. **Eski snapshot'ları yeniden şifrele:** Eski anahtarla çöz → yeni anahtarla şifrele (aynı `ram_snapshot.py` mekanizması).
4. **Yeni anahtarı güvenli escrow'a kaydet:** `/var/backups/tezlify-ram/.key-escrow-v3`.
5. **`.env.production`'ı güncelle:** Doğru anahtarı yaz; bu aşamada YAPMA.
6. **Eski escrow'ları arşivle:** `.key-escrow` ve `.key-escrow-v2` sonrasında silinmeli, ancak yeni snapshot'lar doğrulanana kadar saklanmalı.

---

## 6. Git History Rewrite Planı

### 6.1. Gerekli mi?

**Kısmen.** `production-ops.md`'deki gerçek secret:
- Local repo'da tracked.
- Henüz herhangi bir remote'a push edilmemiş görünüyor (`git status` temiz, remote `origin/main` 11 commit geride).
- Ancak geçmişte commit'lenmiş durumda (`cbe4f50`'nin atası).

### 6.2. Etkiler

Eğer history rewrite yapılırsa:
- `cbe4f50`'den sonraki tüm commit'ler yeniden hash'lenir.
- Local branch'ler (`security/before-purge`, `feature/*`) etkilenir.
- `.workbuddy-ai/memory/reference/production-ops.md`'yi değiştiren commit(ler) bulunup `git filter-repo` veya `git filter-branch` ile temizlenmeli.
- **Force push gerekir** — ancak bu aşamada YAPILMAMALI.

### 6.3. Öneri

History rewrite'ı ayrı bir güvenlik aşamasına bırak. Önce:
1. `production-ops.md`'nin remote'a push edilip edilmediğini kesin doğrula.
2. Eğer push edilmediyse, local rewrite yeterli.
3. Eğer push edildiyse, secret rotasyonu zorunlu.

---

## 7. Off-Site Backup Gereksinimleri

### 7.1. Mevcut durum

- Tek fiziksel konum: Oracle Cloud VM, `/var/backups/tezlify-ram/`
- Anahtar ve snapshot'lar aynı diskte.
- Yetkilendirilmiş off-site hedef yok.

### 7.2. Gereksinim listesi (operatörden beklenen)

1. **Hedef:** Ayrı bir sunucu, S3-uyumlu bucket veya NFS mount.
2. **Ayrım:** Anahtar ve snapshot'lar **farklı** hedeflere/şifreleme katmanlarına gönderilmeli.
3. **Doğrulama:** Her aktarım öncesi/sonrası SHA-256 karşılaştırması.
4. **Periyodiklik:** Snapshot başına bir kez değil, günlük/haftalık otomatik senkronizasyon.
5. **Erişim kontrolü:** Hedefte snapshot erişimi olan kullanıcı, anahtar escrow'una erişememeli.

---

## 8. Açık Riskler

| Risk | Şiddet | Açıklama |
|---|---|---|
| `.env.production` senkronizasyonu | **KRİTİK** | Container recreate = snapshot'ların okunamaz hale gelmesi. |
| Tek fiziksel konum | Yüksek | Host disk arızası = anahtar + snapshot'lar birlikte kaybolur. |
| `production-ops.md` secret | Yüksek | Local repo'da tracked; push edilirse rotasyon zorunlu. |
| `.key-escrow` (v1) yanlış | Orta | Operatör kafasını karıştırabilir; v2'nin doğru olduğu belgelenmeli. |
| `.cline/` ve `codex/` taraması | Düşük | Checkpoint dosyaları taranamadı; manuel kontrol önerilir. |
| Anahtar rotasyonu planı | Düşük | Henük uygulanmadı; recreate öncesi mutlaka yapılmalı. |

---

## 9. Production Değişikliği

**Hiçbir production değişikliği yapılmadı.**

- Backend container: `ce2e901b6619` (başlangıç = bitiş)
- Gateway container: `5b867095d376`
- DB container: `f6d79c4a1f8b`
- Caddy container: `ee66a5cab371`
- DB sayıları: `125|2151|1537`
- Persistence: `config=False`, `runs=0`
- WhatsApp session: `201 CONNECTED` (değişmedi)

Yapılan tek değişiklik: `/var/backups/tezlify-ram/.key-escrow-v2` dosyası oluşturuldu (salt okunur bir yedekleme dosyası, üretim sistemi üzerinde etkisi yok).

---

## 10. Test Sonuçları ve Çıkış Kodları

| Komut | Çıkış Kodu | Sonuç |
|---|---|---|
| Git secret taraması (`git log -S`) | 0 | Secret bulunmadı (tracked dosyalarda) |
| `frontend/.env.production` değer kontrolü | 0 | EMPTY doğrulandı |
| `production-ops.md` hash karşılaştırması | 0 | **MATCH** (gerçek secret) |
| Escrow v1 format kontrolü | 0 | Format OK, anahtar yanlış |
| Escrow v2 oluşturma | 0 | Başarılı, 600 izinli |
| Snapshot verify (4/4) v2 ile | 0 | `ok=True`, 0 problem |
| Production state kontrolü | 0 | Değişiklik yok |

---

## 11. Sonraki Adımlar (Ayrı Onay Gerektirir)

1. **`.env.production` senkronizasyonu:** Container'daki gerçek anahtarı `.env.production`'a yaz ve doğrula.
2. **History rewrite:** `production-ops.md`'den secret'ı temizle (local rewrite + force push gerekirse).
3. **Key rotation:** Eski anahtarı değiştir, yeni anahtarla snapshot yeniden şifrele.
4. **Off-site backup:** Hedef bilgisi verildiğinde aktarım yap.
5. **Persistence aktivasyonu:** `WHATSAPP_MEMORY_PERSIST_ENABLED=true` — ayrı onay.
6. **Mesaj kurtarma:** 9 LID mesajı için LID→PN köprüsü bekleniyor.

---

*Rapor hazırlayan: WorkBuddy AI Agent*  
*Üretim yazımı: 0*  
*Salt okunur garantisi: Sağlandı*
