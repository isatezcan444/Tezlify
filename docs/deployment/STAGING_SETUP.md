# TEZLIFY — GÜVENLİ STAGING ORTAMI KURULUM VE OPERASYON REHBERİ (STAGING RUNBOOK)

- **Belge Sürümü:** 1.0 (Phase A.2)
- **Tarih:** 2026-10-11
- **Durum:** `ALTYAPI TASARIMI TAMAMLANDI — STAGING SUNUCUSU BEKLENİYOR`

---

## 1. Giriş ve Temel Güvenlik İlkeleri

Bu rehber, Tezlify B2B Lead & Outreach platformunun production ortamından (`130.162.247.20`) **fiziksel ve operasyonel olarak tamamen izole** bir staging ortamına kurulması ve yönetilmesi için standart işletim prosedürlerini (SOP) tanımlar.

> [!CAUTION]
> **SIFIR ÇAPRAZ BULAŞMA (ZERO CONTAMINATION) İLKESİ:**
> - Staging ortamı **ASLA** `130.162.247.20` sunucusunda barındırılamaz.
> - Staging ortamı **ASLA** canlı PostgreSQL veritabanına (`tezlify-db`) bağlanamaz.
> - Staging ortamı **ASLA** canlı WhatsApp oturumlarını (`whatsapp_sessions`) yükleyemez veya kullanamaz.

---

## 2. Production'dan Ayrılması Zorunlu Kaynaklar Envanteri

| Kaynak / Katman | Production Değeri | Staging Değeri (Zorunlu İzolasyon) |
| :--- | :--- | :--- |
| **Sunucu / Host** | `130.162.247.20` (Oracle Cloud VM) | **Ayrı VM / Sunucu** (Örn: `staging.tezlify.internal` veya ayrı IP) |
| **Docker Compose Projesi** | `tezlify` (varsayılan) | `name: tezlify-staging` |
| **Compose Dosyası** | `docker-compose.prod.yml` | `docker-compose.staging.yml` |
| **Konteyner İsimleri** | `tezlify-backend`, `tezlify-gateway`, `tezlify-caddy`, `tezlify-db` | `tezlify-backend-staging`, `tezlify-gateway-staging`, `tezlify-caddy-staging`, `tezlify-db-staging` |
| **Docker Köprü Ağı** | `tezlify_tezlify-internal` (Subnet `172.29.0.0/16`) | `tezlify-staging-internal` (Subnet `172.30.0.0/16`) |
| **Oturum Volume'ü** | `whatsapp_sessions` | `whatsapp_sessions_staging` |
| **Veritabanı** | Canlı `tezlify-db` (Port 5432 dahili) | Bağımsız `tezlify-db-staging` (Boş/Demo şemalı) |
| **Ortam Dosyası** | `.env.production` | `.env.staging` (Ayrı anahtarlar) |
| **Caddy Yapılandırması** | `Caddyfile` | `Caddyfile.staging` |
| **Erişim Alan Adı** | `app.130.162.247.20.sslip.io` | `staging.tezlify.io` veya Staging IP |

---

## 3. Gerekli Staging Environment Değişkenleri (`.env.staging`)

Staging sunucusunda `/opt/tezlify-staging/.env.staging` dosyası oluşturulmalıdır. Örnek şablon repository kökünde `.env.staging.example` olarak sunulmuştur:

```bash
ENVIRONMENT=staging
STAGING_DOMAIN=staging.tezlify.io

# İzole Staging Veritabanı (db konteynerine dahili ağdan bağlanır)
STAGING_DB_PASSWORD=<guclu_rastgele_staging_parolasi>
DATABASE_URL=postgresql+asyncpg://tezlify_staging:<guclu_rastgele_staging_parolasi>@db:5432/tezlify_staging

# Staging Güvenlik ve Şifreleme Anahtarları (Production ile ortak olamaz!)
JWT_SECRET=<en_az_32_karakter_benzersiz_staging_jwt_secret>
WHATSAPP_GATEWAY_SECRET=<en_az_32_karakter_benzersiz_gateway_secret>
GATEWAY_ENCRYPTION_KEY=<32_bayt_hex_veya_base64_aes_staging_key>

# İstemci ve CORS
BACKEND_CORS_ORIGINS=["https://staging.tezlify.io"]
ADMIN_DEFAULT_EMAIL=admin@staging.tezlify.local

# WhatsApp Güvenlik Kilidi (FAIL-SAFE DEĞERLER)
WHATSAPP_AUTO_RESTORE=false
WHATSAPP_GATEWAY_URL=http://gateway:8787
GATEWAY_RESTORE_CONCURRENCY=1
LOG_LEVEL=info

# Edge Proxy Portları
STAGING_HTTP_PORT=8080
STAGING_HTTPS_PORT=8443
```

---

## 4. WhatsApp Güvenliği ve Oturum İzolasyonu Prosedürü

Staging ortamında WhatsApp modülü test edilirken Meta anti-fraud politikalarına ve operasyonel güvenliğe dikkat edilmelidir:

1. **Varsayılan Davranış:**
   - `WHATSAPP_AUTO_RESTORE="false"` olmak zorundadır. Gateway açıldığında hiçbir oturumu otomatik olarak bağlamaya çalışmaz.
2. **Kalıcı Oturum Volume İzolasyonu:**
   - Staging gateway'i `/app/sessions` yolunu `whatsapp_sessions_staging` volume'üne bağlar. Canlı sunucunun auth anahtarlarına fiziksel erişimi yoktur.
3. **E2E Test Numarası Kuralı:**
   - Staging ortamında test amacıyla QR eşleştirmesi yapılacaksa:
     - Asla üretimde kullanılan canlı Hat 1 / Session 180 numarası kullanılmaz!
     - Operatör tarafından açıkça tahsis edilmiş ikinci bir test SIM kartı / sanal numara kullanılır.
     - Test tamamlandığında arayüzden oturum kapatılır (`logout`).

---

## 5. Dağıtım Öncesi Pre-Flight Kontrol Listesi

Staging sunucusuna ilk dağıtım yapılmadan önce şu kontroller tamamlanmalıdır:

- [ ] Staging VM'i oluşturuldu ve SSH erişimi doğrulandı (`ssh -i ~/.ssh/id_tezlify_staging ubuntu@<staging_ip>`).
- [ ] Staging sunucusunun IP'sinin `130.162.247.20` olmadığı doğrulandı.
- [ ] Staging sunucusunda Docker ve Docker Compose v2 yüklendi.
- [ ] `/opt/tezlify-staging` dizini oluşturuldu.
- [ ] `.env.staging` dosyası hazırlandı; `DATABASE_URL` içinde production IP'sinin geçmediği doğrulandı.
- [ ] `WHATSAPP_AUTO_RESTORE` değerinin `false` olduğu teyit edildi.

---

## 6. Staging Dağıtım Komutları

Geliştirici makinesinden dağıtım iki şekilde başlatılabilir:

### Yöntem A: Aday Dağıtım Planını Test Etme (Dry-Run — Önerilen İlk Adım)
```bash
# Sadece planı ve fail-closed kontrollerini doğrular, uzak sunucuya bağlanmaz:
STAGING_HOST="ubuntu@<staging_ip>" bash scripts/deploy/staging-release.sh --dry-run
```

### Yöntem B: Gerçek Staging Dağıtımı
```bash
# Staging sunucusuna artefaktları aktarır ve servisleri ayağa kaldırır:
STAGING_HOST="ubuntu@<staging_ip>" bash scripts/deploy/staging-release.sh
```

### Yöntem C: Standart Release Scripti Üzerinden Staging Delegasyonu
```bash
# release.sh üzerinden doğrudan staging çağrısı:
STAGING_HOST="ubuntu@<staging_ip>" bash scripts/deploy/release.sh --target staging --dry-run
```

---

## 7. Dağıtım Sonrası Sağlık Kontrolleri (Post-Deployment Verification)

Dağıtım tamamlandıktan sonra staging hostunda şu komutlarla sağlık durumu doğrulanır:

```bash
# 1. Konteyner durumlarını incele:
docker compose -f /opt/tezlify-staging/docker-compose.staging.yml ps

# Beklenen Çıktı:
# tezlify-db-staging        postgres:17-alpine   Up (healthy)
# tezlify-backend-staging   ...                  Up (healthy)
# tezlify-gateway-staging   ...                  Up (healthy)
# tezlify-caddy-staging     caddy:2-alpine       Up (healthy)

# 2. HTTP Sağlık Probu:
curl -fsS http://localhost:8080/health
# Beklenen Yanıt: {"status":"ok", ...}

# 3. Caddy Sağlık Probu:
curl -fsS http://localhost:8080/caddy-health
# Beklenen Yanıt: OK (STAGING)
```

---

## 8. Rollback (Geri Alma) Prosedürü

Staging dağıtımında bir sorun tespit edilirse:

```bash
# Servisleri durdur:
cd /opt/tezlify-staging && docker compose -f docker-compose.staging.yml down

# Önceki sürüme dönmek için compose'u önceki etiketle veya commit ile yeniden başlat:
docker compose -f docker-compose.staging.yml up -d
```

---

## 9. Staging'in Production'a Bağlanmadığını Kanıtlama Adımları

Staging sunucusu üzerinde periyodik güvenlik denetimi:

1. **Bağlantı Soketi Denetimi:**
   ```bash
   # Staging konteynerlerinin production IP'sine (130.162.247.20) açık soketi var mı?
   docker exec tezlify-backend-staging netstat -an | grep 130.162.247.20 || echo "TEMİZ: Sıfır Prod Bağlantısı"
   ```
2. **PostgreSQL Veritabanı Doğrulaması:**
   ```bash
   # Staging veritabanındaki tablo ve kayıt sayısının canlı müşteri verisi olmadığını doğrula:
   docker exec -it tezlify-db-staging psql -U tezlify_staging -d tezlify_staging -c "SELECT count(*) FROM leads;"
   # Beklenen: 0 veya demo kayıt sayısı.
   ```
