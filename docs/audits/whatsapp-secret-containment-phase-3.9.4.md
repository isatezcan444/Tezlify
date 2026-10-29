# AŞAMA 3.9.4 — PRODUCTION SECRET CONTAINMENT & CANONICAL KEY SOURCE

**Çalışma türü:** ALTYAPI + GÜVENLİK DENETİMİ  
**Başlangıç:** 2026-10-30T01:52Z  
**Bitiş:** 2026-10-30T02:00Z  
**Üretim yazımı:** 0

---

## 1. Yönetici Özeti

Bu aşamada:

1. Tüm Git geçmişi ve çalışma ağacı `GATEWAY_ENCRYPTION_KEY` açısından tarandı.
2. **Local repo'da hiçbir tracked dosyada gerçek production secret bulunmadığı** doğrulandı.
3. `production-ops.md`'deki `GATEWAY_ENCRYPTION_KEY=` ifadesinin **boş değer** içerdiği kanıtlandı (value_length=0).
4. Gateway container'ının gerçek encryption key kaynağı izlendi.
5. **Kritik bulgu:** Container env anahtarı, `.env` ve `.env.production` dosyalarındaki anahtarla **eşleşmiyor**.
6. **Compose recreate = snapshot okunamazlık riski** tespit edildi.

---

## 2. Git Geçmişi Secret Taraması — Sonuç

### 2.1. Kapsam

- Tüm local branch'ler: `main`, `feat/3.8.7-identity-quarantine`, `release/backend-only-*`, `backup-before-revert-*`
- Tüm remote branch'ler: `origin/main`, `origin/feat/3.8.7-identity-quarantine`, `origin/release/backend-only-*`, `origin/backup-before-revert-*`
- Tüm tag'ler (yok)
- Tüm commit geçmişi (`git log --all`)
- `production-ops.md`'nin tüm değiştirilme geçmişi (`git log --all --follow`)

### 2.2. `production-ops.md` Analizi

| Commit | Branch Kapsamı | `GATEWAY_ENCRYPTION_KEY` Değeri |
|---|---|---|
| `cfc20cf` … `fac1e42` (toplam 24 commit) | **Tüm branch'ler** (local + remote) | **BOŞ** (`value_length=0`) |

**Önemli düzeltme (3.9.3 raporundan):**  
3.9.3 raporunda "`production-ops.md` tracked ve GERÇEK secret içeriyor" ifadesi **yanlıştı**. Yeniden analiz sonucu: satır 178'deki ifade `` `GATEWAY_ENCRYPTION_KEY=` `` Markdown inline code içinde **boş değer** olarak belgeleniyor. Python ile `value_length=0` doğrulandı. Hash karşılaştırması, `cut -d= -f2-`'nin satırın geri kalanını (`), `SKIP_JOB_RECOVERY=true`...`) almasından kaynaklanan bir yanılgıydı.

### 2.3. Diğer Dosyalar

| Dosya | Git Durumu | Değer | Risk |
|---|---|---|---|
| `frontend/.env.production` | Tracked | `GATEWAY_ENCRYPTION_KEY=` (EMPTY) | Yok |
| `docs/deployment/STAGING_SETUP.md` | Tracked | `GATEWAY_ENCRYPTION_KEY=<32_bayt_hex_veya_base64_aes_staging_key>` (placeholder) | Yok |
| `/.env.example` | Tracked | `GATEWAY_ENCRYPTION_KEY=your-32-byte-encryption-key` (placeholder) | Yok |
| `/.env.staging.example` | Tracked | `GATEWAY_ENCRYPTION_KEY=staging-32-byte-encryption-key` (placeholder) | Yok |
| `whatsapp-gateway/.env.example` | Tracked | `GATEWAY_ENCRYPTION_KEY=your-32-byte-encryption-key` (placeholder) | Yok |
| `docker-compose.yml` | Tracked | `${GATEWAY_ENCRYPTION_KEY}` (interpolation) | Yok |
| `scripts/deploy/host-release.sh` | Tracked | `$GATEWAY_ENCRYPTION_KEY` (shell variable) | Yok |
| Root `/.env.production` | **NOT tracked** | — | N/A (diskte var) |

### 2.4. Remote Push Durumu

**Secret içeren commit YOK.** Tüm commit'lerdeki `GATEWAY_ENCRYPTION_KEY` değerleri ya boş, ya placeholder, ya da shell/env interpolation.  
`origin/main` remote'a push edilmiş commit'lerin hiçbiri gerçek production secret içermiyor.

**Sonuç:** History rewrite **gerekli değil.**

---

## 3. Çalışma Ağacı Durumu

`git status --porcelain`: **temiz** (hiçbir değişiklik yok).

`production-ops.md`'de gerçek secret olmadığı için "temizleme" işlemi yapılmadı. Belgelerdeki boş değerler ve placeholder'lar operasyonel olarak güvenli.

---

## 4. Gateway Encryption Key Kaynağı

### 4.1. Mevcut durum

| Kaynak | Hash | Uzunluk | Durum |
|---|---|---|---|
| `tezlify-gateway` container env | `e79af96f...` | 65 | **Gerçek anahtar** (tüm snapshot'ları çözüyor) |
| `/opt/tezlify/.env` | `be27a111...` | 67 | Yanlış anahtar |
| `/opt/tezlify/.env.production` | `be27a111...` | 67 | Yanlış anahtar (`.env` ile aynı) |
| Host env (`ubuntu` user) | `e3b0c4429...` | 0 | Boş string (tanımlı değil) |

### 4.2. Container oluşturma mekanizması

**`docker-compose.yml` (satır 19):**
```yaml
gateway:
  environment:
    - GATEWAY_ENCRYPTION_KEY=${GATEWAY_ENCRYPTION_KEY}
```

- `env_file` tanımı **yok** gateway servisi için (sadece backend için var, satır 48).
- Host env boş olduğunda Docker Compose, aynı dizindeki `.env` dosyasını otomatik okur.
- Ama container env (65 karakter) `.env` dosyasındaki değerden (67 karakter) **farklı**.

### 4.3. Neden farklı?

**Timeline:**
- `.env` son değiştirilme: `2026-10-03 09:08:16Z`
- `.env.production` son değiştirilme: `2026-09-26 14:12:33Z`
- Container oluşturulma: `2026-10-27 17:25:42Z`
- Container başlatma: `2026-10-27 17:25:57Z`

Container, `.env` dosyası değiştirildikten **24 gün sonra** oluşturuldu. Ama container env `.env`'den farklı.

**Olası açıklamalar:**
1. Container oluşturulurken host env'de farklı bir değer vardı; sonradan host env temizlendi.
2. `docker compose up` farklı bir dizinde çalıştırıldı ve oradaki `.env` farklıydı.
3. Container `docker run` ile oluşturuldu ve `--env` ile farklı bir değer verildi.
4. Container bir önceki container'dan env kopyalanarak oluşturuldu (deploy script mantığı).

### 4.4. Deploy script davranışı

`scripts/deploy/host-release.sh`:
- **Satır 766-769:** "Adacigin ortami CANLI container'dan kopyalanir, `.env.production`dan DEGIL"
- **Satır 839-844:** Candidate container `docker run` ile oluşturulurken `GATEWAY_ENCRYPTION_KEY=` **boş** veriliyor (gateway kapalı).
- **Satır 957:** Backend container'ı `env_file: .env.production` ile oluşturuluyor.
- Cutover sırasında: `compose up -d backend gateway` çalıştırılıyor.

**Sonuç:** Gateway container'ı `docker compose up -d gateway` ile oluşturulduğunda, eğer zaten çalışıyorsa env değişmez. Ancak **recreate** (örneğin host reboot veya `--force-recreate`) yapılırsa, yeni container `.env`'deki yanlış anahtarı alır.

---

## 5. Canonical Source Önerisi

### 5.1. Mevcut mimari sorunları

1. **İki farklı anahtar:** Container env vs `.env` — senkronizasyon yok.
2. **Gizli kaynak:** Container'ın gerçek anahtarı nereden geldiği belirsiz.
3. **Recreate riski:** `.env`'deki yanlış anahtar, recreate sonrası snapshot okunamazlığına yol açar.
4. **Tek kopya:** Anahtar yalnızca container env'de ve v2 escrow'da var.

### 5.2. Hedef mimari

```
┌─────────────────────────────────────────────┐
│  CANONICAL SOURCE: /opt/tezlify/.env        │
│  (dosya izni: 600, sahip: ubuntu:ubuntu)    │
└─────────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
   docker compose up      ram_snapshot.py
   (gateway service)      (snapshot create/verify)
        │                       │
   container env           escrow (v2)
```

### 5.3. Gerekli düzeltmeler (sonraki aşamalar)

| Adım | İşlem | Onay Gerekir |
|---|---|---|
| 1 | `/opt/tezlify/.env`'i container'daki gerçek anahtarla güncelle | Evet (3.9.5 veya sonrası) |
| 2 | `docker-compose.yml`'de gateway servisi için explicit `env_file` tanımı ekle | Evet (kod değişikliği) |
| 3 | `.env.production`'ı `.env` ile senkronize et veya kaldır | Evet |
| 4 | V2 escrow'u koru; v1 escrow'u sil (yanlış anahtar) | Evet |
| 5 | Container recreate testi yap (test ortamında) | Evet |

---

## 6. Compose Recreate Güvenliği

### 6.1. Mevcut risk

Eğer şu anda `docker compose up -d --force-recreate gateway` çalıştırılırsa:

1. Yeni container `.env`'deki `be27a111...` anahtarını alır.
2. Mevcut 4 snapshot (`tezlify-ram-*.rsnap`) **çözülemez** (`InvalidTag`).
3. Gateway RAM'indeki ~9.000 mesaj kaybolur (persistence kapalı).
4. Yalnızca snapshot'taki veriler kalır, ama snapshot da okunamaz.

**Risk seviyesi: KRİTİK**

### 6.2. Risk azaltma (acil)

1. **V2 escrow'u asla silme** (`/var/backups/tezlify-ram/.key-escrow-v2`).
2. **`.env`'i güncellemeden container recreate YAPMA.**
3. Eğer recreate zorunluysa, önce `.env`'i v2 escrow'daki anahtarla güncelle.

---

## 7. Snapshot Uyumluluğu

| Snapshot | V2 Escrow ile Verify | Durum |
|---|---|---|
| `tezlify-ram-20261029T125657Z.rsnap` | `ok=True`, 0 problem | ✅ Uyumlu |
| `tezlify-ram-20261029T125755Z.rsnap` | `ok=True`, 0 problem | ✅ Uyumlu |
| `tezlify-ram-20261029T210007Z.rsnap` | `ok=True`, 0 problem | ✅ Uyumlu |
| `tezlify-ram-20261029T220302Z.rsnap` | `ok=True`, 0 problem | ✅ Uyumlu |

V2 escrow, container env anahtarıyla eşleşiyor ve tüm snapshot'lar başarıyla çözülüyor.

---

## 8. Açık Riskler

| Risk | Şiddet | Açıklama |
|---|---|---|
| `.env` senkronizasyonu | **KRİTİK** | Container recreate = snapshot okunamazlık. |
| Anahtar kaynağı belirsizliği | Yüksek | Container env nereden geldiği bilinmiyor. |
| Tek fiziksel konum | Yüksek | Anahtar + snapshot'lar aynı VM. |
| Off-site backup yok | Orta | VM disk arızası = toplam kayıp. |
| `.key-escrow` (v1) var | Düşük | Yanlış anahtar; operatör kafasını karıştırabilir. |

---

## 9. Production Değişikliği

**Hiçbir production değişikliği yapılmadı.**

- Backend container: `ce2e901b6619`
- Gateway container: `5b867095d376`
- DB container: `f6d79c4a1f8b`
- Caddy container: `ee66a5cab371`
- DB sayıları: `125|2151|1537`
- Persistence: `config=False`, `runs=0`

Yapılan tek işlem: salt okunur inceleme ve analiz.

---

## 10. Sonraki Adımlar (Ayrı Onay Gerektirir)

1. **`.env` senkronizasyonu:** Container'daki gerçek anahtarı `.env`'e yaz.
2. **`docker-compose.yml` düzeltmesi:** Gateway servisi için `env_file` tanımı ekle.
3. **V1 escrow'u sil:** Yanlış anahtar içeriyor.
4. **Container recreate testi:** Test ortamında `.env` güncellemesinden sonra recreate yap.
5. **Off-site backup:** Hedef bilgisi verildiğinde aktarım yap.
6. **Persistence aktivasyonu:** `WHATSAPP_MEMORY_PERSIST_ENABLED=true`.
7. **9 LID mesaj kurtarma:** LID→PN köprüsü bekleniyor.

---

*Rapor hazırlayan: WorkBuddy AI Agent*  
*Üretim yazımı: 0*  
*Salt okunur garantisi: Sağlandı*
