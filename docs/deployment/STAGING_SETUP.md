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
| **Sunucu / Host** | `130.162.247.20` (Oracle Cloud VM) | **Ayrı VM / Sunucu** (Örn: `staging.tezlify.internal` veya bağımsız IP) |
| **Docker Daemon & Socket** | Production Docker Daemon (`/var/run/docker.sock`) | **Fiziksel/Sanal Olarak Ayrı Docker Daemon** (Root erişim izolasyonu) |
| **Docker Compose Projesi** | `tezlify` (varsayılan) | `name: tezlify-staging` |
| **Compose Dosyası** | `docker-compose.prod.yml` | `docker-compose.staging.yml` |
| **Konteyner İsimleri** | `tezlify-backend`, `tezlify-gateway`, `tezlify-caddy`, `tezlify-db` | `tezlify-backend-staging`, `tezlify-gateway-staging`, `tezlify-caddy-staging`, `tezlify-db-staging` |
| **Docker Köprü Ağı** | `tezlify_tezlify-internal` (Subnet `172.29.0.0/16`) | `tezlify-staging-internal` (Subnet `172.30.0.0/16`) |
| **Oturum Volume'ü** | `whatsapp_sessions` | `whatsapp_sessions_staging` |
| **Veritabanı** | Canlı `tezlify-db` (Port 5432 dahili) | Bağımsız `tezlify-db-staging` (Boş/Demo şemalı) |
| **Ortam Dosyası** | `.env.production` | `.env.staging` (Ayrı anahtarlar, yerelde hazırlanıp scp ile aktarılır) |
| **Caddy Yapılandırması** | `Caddyfile` | `Caddyfile.staging` |
| **Erişim Alan Adı** | `app.130.162.247.20.sslip.io` | `staging.tezlify.io` veya Staging IP |

> [!WARNING]
> **DOCKER SOCKET VE DAEMON İZOLASYONU GEREKSİNİMİ:**
> `docker-compose.staging.yml` içerisinde `backend` servisine `/var/run/docker.sock` bağlanmaktadır. Bu soket, Yönetim & Operasyon Merkezi'nin konteyner metriklerini okuması ve yeniden başlatma yapabilmesi için gereklidir. Ancak Docker socket erişimi, host üzerindeki Docker daemon'a **root düzeyinde tam erişim** anlamına gelir.
> Eğer staging konteynerleri canlı sunucu (`130.162.247.20`) üzerinde çalıştırılırsa, staging backend'i bu soket üzerinden canlı `tezlify-backend` veya `tezlify-gateway` konteynerlerini durdurabilir veya silebilir. Bu nedenle **staging ortamının production ile aynı Docker daemon'ı paylaşması kesinlikle yasaktır; ayrı bir VM zorunludur.**

---

## 3. Bağımsız Staging Ortam Dosyasının Hazırlanması (`.env.staging`)

Dağıtım betiği (`staging-release.sh`) geliştirici makinesinde çalışır ve yerel ortam dosyasını denetleyip güvenliğini onayladıktan sonra `scp` ile staging sunucusuna (`/opt/tezlify-staging/.env.staging`) aktarır.

### 3.1 Yerel Ortam Dosyasını Hazırlama
Repository kökünde `.env.staging.example` şablonu kopyalanarak `.env.staging` oluşturulmalıdır:

```bash
cp .env.staging.example .env.staging
```

### 3.2 Zorunlu Bağımsız Değişkenler ve Sırlar
`.env.staging` dosyasında aşağıdaki bağımsız değişkenler tanımlanmalıdır (asla production değerleri kopyalanamaz):

```bash
ENVIRONMENT=staging
STAGING_DOMAIN=staging.tezlify.io

# İzole Staging Veritabanı (db konteynerine dahili ağdan bağlanır - PROD IP ASLA YAZILAMAZ)
STAGING_DB_PASSWORD=<guclu_rastgele_staging_parolasi>
DATABASE_URL=postgresql+asyncpg://tezlify_staging:<guclu_rastgele_staging_parolasi>@db:5432/tezlify_staging

# Staging Güvenlik ve Şifreleme Anahtarları (Production ile ortak olamaz!)
SECRET_KEY=<en_az_32_karakter_benzersiz_staging_secret_key>
JWT_SECRET=<en_az_32_karakter_benzersiz_staging_jwt_secret>
WHATSAPP_GATEWAY_SECRET=<en_az_32_karakter_benzersiz_gateway_secret>
GATEWAY_ENCRYPTION_KEY=<32_bayt_hex_veya_base64_aes_staging_key>

# İstemci ve CORS
BACKEND_CORS_ORIGINS=["https://staging.tezlify.io","http://localhost:8080"]
ADMIN_EMAILS=["staging-admin@tezlify.local"]
ADMIN_DEFAULT_EMAIL=staging-admin@tezlify.local

# Operations Center Staging Ayarları
TEZLIFY_COMPOSE_PROJECT=tezlify-staging
TEZLIFY_CONTAINER_SUFFIX=-staging

# WhatsApp Güvenlik Kilidi (FAIL-SAFE DEĞERLER: true olamaz!)
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

- [ ] **Staging VM Ön Koşulu:** Ayrı bir VM sağlandı (Production IP `130.162.247.20` kesinlikle kullanılmamaktadır).
- [ ] **Host & SSH Gereksinimi:** Staging SSH anahtarı (`~/.ssh/id_tezlify_staging`) hazır ve `StrictHostKeyChecking=yes` doğrulaması tamamlandı (`ssh -i ~/.ssh/id_tezlify_staging ubuntu@<staging_ip>`).
- [ ] **Docker Kurulumu:** Staging sunucusunda Docker ve Docker Compose v2 yüklendi, daemon çalışıyor.
- [ ] **Uzak Dizin:** Staging sunucusunda `/opt/tezlify-staging` dizini oluşturuldu ve deployment kullanıcısına yazma yetkisi verildi.
- [ ] **Yerel Ortam Dosyası:** Yerel repository kökünde `.env.staging` hazırlandı; `DATABASE_URL` içinde production IP'sinin geçmediği doğrulandı.
- [ ] **WhatsApp Koruması:** `WHATSAPP_AUTO_RESTORE` değerinin `false` olduğu teyit edildi.
- [ ] **Ağ Portları:** Staging VM üzerinde 8080 (HTTP) ve 8443 (HTTPS) portlarının erişilebilir olduğu doğrulandı.

---

## 6. CLI Sözleşmesi ve Dağıtım Komutları

### 6.1 Desteklenen CLI Seçenekleri

| Betik | Seçenek / Parametre | Açıklama |
| :--- | :--- | :--- |
| `staging-release.sh` | `--staging-host <HOST>` / `--host <HOST>` | Staging SSH hedefi (örn: `ubuntu@<staging_ip>`). Zorunludur. |
| `staging-release.sh` | `--staging-env <PATH>` / `--env <PATH>` | Yerel staging env dosyası (varsayılan: `.env.staging`). |
| `staging-release.sh` | `--dry-run` / `--plan` | Uzak komut çalıştırmaz; planı ve fail-closed kurallarını yerelde doğrular. |
| `staging-release.sh` | `--skip-build` | Frontend Vite derleme adımını atlar. |
| `staging-release.sh` | `--no-frontend` | Frontend dağıtımını hariç tutar. |
| `staging-release.sh` | `[sha]` | Hedef Git commit SHA (varsayılan: `HEAD`). |
| `release.sh` | `--target staging` / `--target=staging` | Çağrıyı `staging-release.sh` betiğine yönlendirir, diğer tüm argümanları korur. |
| `release.sh` | `--target production` / `--target=production` | Canlı sunucuya dağıtım yolunu çalıştırır (varsayılan). |

> [!NOTE]
> `--target staging` seçeneği `release.sh` üzerinde tanımlıdır ve yürütmeyi `staging-release.sh` betiğine devreder. `staging-release.sh` doğrudan çalıştırıldığında `--target` argümanı kabul edilmez (fail-closed exit 2 döner).

### 6.2 Güvenli Plan / Dry-Run Komutları (Önerilen İlk Adım)

Uzak sunucuya bağlanmadan önce planı ve izolasyon kurallarını yerel olarak doğrulamak için:

```bash
# Yöntem 1: staging-release.sh doğrudan CLI bayrağı ile:
bash scripts/deploy/staging-release.sh --staging-host ubuntu@<staging_ip> --dry-run

# Yöntem 1b: Alternatif alias'lar ile:
bash scripts/deploy/staging-release.sh --host=ubuntu@<staging_ip> --plan

# Yöntem 2: release.sh üzerinden staging delegasyonu ile:
bash scripts/deploy/release.sh --target staging --staging-host ubuntu@<staging_ip> --dry-run
```

### 6.3 Gerçek Staging Dağıtım Komutu

Staging VM hazır olduğunda ve yerel `.env.staging` oluşturulduğunda gerçek dağıtım başlatılır:

```bash
# Yöntem 1: Doğrudan staging betiği ile:
bash scripts/deploy/staging-release.sh --staging-host ubuntu@<staging_ip>

# Yöntem 2: release.sh delegasyonu ile:
bash scripts/deploy/release.sh --target staging --staging-host ubuntu@<staging_ip>
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

# 4. Ops Center API Kontrolü:
curl -fsS http://localhost:8080/api/v1/admin/operations/status
```

---

## 8. Güvenli Geri Dönüş Prosedürü (Rollback)

Staging dağıtımında bir sorun tespit edilirse:

```bash
# 1. Staging servislerini durdur:
cd /opt/tezlify-staging && docker compose -f docker-compose.staging.yml down

# 2. Önceki bilinen kararlı commit SHA'sına geri dönerek yeniden dağıt:
bash scripts/deploy/staging-release.sh <onceki_kararli_sha> --staging-host ubuntu@<staging_ip>

# 3. Veya staging sunucusunda servisleri yeniden başlat:
docker compose -f /opt/tezlify-staging/docker-compose.staging.yml up -d
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

---

## 10. Production'a Geçiş İçin Ayrı Onay ve Kabul Kriterleri (Production Gate)

Staging ortamında doğrulanmamış hiçbir kod canlı sunucuya (`130.162.247.20`) dağıtılamaz. Canlıya geçiş öncesinde aşağıdaki kabul kriterlerinin tamamı eksiksiz karşılanmalıdır:

1. **Staging Servis Sağlığı (100% Yeşil):**
   - Tüm staging konteynerleri (`tezlify-db-staging`, `tezlify-backend-staging`, `tezlify-gateway-staging`, `tezlify-caddy-staging`) en az 1 saat kesintisiz ve sağlıklı (`healthy`) çalışmalıdır.
2. **Operasyon Merkezi Fonksiyonel Doğrulaması:**
   - Staging Yönetim & Operasyon Merkezi (`/admin/operations`) üzerinden `reload_caddy`, `clear_logs` ve `restart_backend` operasyonları denenmeli ve sıfır hata ile tamamlanmalıdır.
   - `test_restart_all_never_touches_postgres` kuralının canlıda da korunduğu, veritabanının yeniden başlatılmadığı teyit edilmelidir.
3. **WhatsApp Oturum & İzolasyon Doğrulaması:**
   - Yalnızca operatör tarafından tahsis edilmiş ikincil bir test SIM numarası ile staging QR bağlantısı test edilmelidir. Canlı Hat 1 / Session 180 numarası kesinlikle kullanılmamalıdır.
   - Test bitiminde oturum arayüzden sonlandırılmalı (`logout`) ve `whatsapp_sessions_staging` volume'ünün canlı oturumlarla hiçbir fiziksel teması olmadığı teyit edilmelidir.
4. **Veritabanı İzolasyonu Teyidi:**
   - Staging veritabanında canlı verilerin bulunmadığı ve production veritabanına hiçbir ağ bağlantısı açılmadığı Bölüm 9'daki adımlarla kanıtlanmalıdır.
5. **SRE / Lead Engineer İmzalı Onayı:**
   - Staging kabul formu teknik ekip tarafından imzalanmadan production dağıtım süreci başlatılamaz.
6. **Müstakil Production Release:**
   - Kabul kriterleri sağlandıktan sonra, yalnızca onaylı komutla canlı sunucu dağıtımı yürütülür:
     ```bash
     bash scripts/deploy/release.sh
     ```
