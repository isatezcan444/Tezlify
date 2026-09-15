# TEZLIFY ORACLE CLOUD MIGRATION MASTER PLAN
## Render Free → Oracle Cloud Frankfurt (Always Free) Production Migration

**Doküman Versiyonu:** 1.0.0  
**Tarih:** 2026-09-15 14:35:00 (UTC+3)  
**Mimari Ekip Rolü:** Architecture Lead + Cloud Migration Architect + SRE + DevOps + Realtime Systems Engineer  
**Disiplin Kuralı:** Yalnızca planlama ve mimari keşif; bu aşamada kod değişikliği, altyapı oluşturma, DNS yönlendirmesi veya canlı ortam restart'ı yapılmamıştır.

---

## 1. Executive Summary (Yönetici Özeti)

Tezlify'nin mevcut üretim altyapısında yaşanan WhatsApp ve veri tabanı gecikmelerinin adli analizi sonucunda iki temel darboğaz tespit edilmiştir:
1. **Render Free Kısıtları:** 0.1 vCPU paylaşımlı işlemci, 512 MB bellek yetersizliği, 15 dakika boşta kalınca uykuya geçme ve **72.5 saniyelik cold-start uyanma gecikmesi**.
2. **Coğrafi ve Ağ Uyuşmazlığı:** Render'ın Oregon'da (GCP us-west1), Supabase PostgreSQL veritabanının Tokyo'da (AWS ap-northeast-1) bulunması; transpasifik fiber gecikmesi (250 ms RTT) ve doğrudan IPv6 bağlantısındaki 10 saniyelik TCP SYN zaman aşımı.

Bu master plan; Render Free üzerinde çalışan tüm iş yüklerini (**FastAPI Backend, Baileys WhatsApp Gateway, WebSocket ve Background İşlemleri**), Oracle Cloud Infrastructure (OCI) **Frankfurt (`eu-frankfurt-1`)** bölgesindeki **Always Free (4 OCPU, 24 GB RAM, 200 GB SSD)** altyapısına sıfır kesinti riskiyle (zero-downtime / low-downtime) taşımak için hazırlanmıştır.

Supabase production veritabanı Faz 1'de **olduğu gibi korunacaktır**. Böylece veritabanı taşıma riski alınmadan, sunucu kaynaklı 72.5s uyku ve 0.1 vCPU boğulması tamamen ortadan kaldırılacaktır.

---

## 2. Current Render Architecture (Mevcut Durum Envanteri)

```
[ Tarayıcı / Kullanıcı (TR) ]
              │
       (1) HTTPS (Vite SPA)
              ▼
   [ Vercel CDN Edge ] (~10ms)
              │
       (2) API & WSS (/api/v1, /ws)
              ▼
 [ Cloudflare Edge (FRA) ] ──(140ms transatlantik)──► [ Render Free Container (Oregon, ABD) ]
                                                       ┌─────────────────────────────────────┐
                                                       │ 0.1 vCPU, 512MB RAM (Tek Container) │
                                                       │  ├── FastAPI / Uvicorn (Port 10000) │
                                                       │  └── Baileys Gateway (Port 8787)    │
                                                       └──────────────────┬──────────────────┘
                                                                          │
                                                                 (250ms transpasifik)
                                                                          ▼
                                                            [ Supabase DB (Tokyo, Japonya) ]
```

- **Container İçi Sidecar:** `docker-entrypoint.sh` içinde FastAPI ve Node.js aynı Linux container'ında çalışır.
- **Paylaşımlı 0.1 vCPU:** Baileys WhatsApp kriptografik işlemleri (Curve25519/AES-GCM) yaparken Node event loop'u tıkanır, Python API yanıtları gecikir.
- **Ephemeral Dosya Sistemi:** Disk geçici olduğundan container uyuyup uyandığında disk silinir; Baileys Signal anahtarları Supabase Tokyo'daki `whatsapp_private` şemasına tek tek yazılmak zorundadır.

---

## 3. Target Oracle Architecture (Hedef Frankfurt Mimarisi)

```
[ Tarayıcı / Kullanıcı (TR) ]
              │
       (1) HTTPS (Vite SPA)
              ▼
   [ Vercel CDN Edge ] (~10ms)
              │
       (2) API & WSS (api.tezlify.com / wss://api.tezlify.com/ws)
              │ ~35-45ms Avrupa içi fiber
              ▼
 [ Oracle Cloud Infrastructure (Frankfurt eu-frankfurt-1) ]
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ OCI Virtual Cloud Network (VCN) - tezlify-vcn (10.0.0.0/16)                 │
 │ Public Subnet (10.0.1.0/24) + Internet Gateway                              │
 │                                                                             │
 │  ┌───────────────────────────────────────────────────────────────────────┐  │
 │  │ VM.Standard.A1.Flex (4 OCPU ARM64, 24 GB RAM, 100 GB Boot Volume)     │  │
 │  │ OCI Balanced Block Storage (NVMe-oF, 10 VPUs/GB, ~6,000 IOPS)         │  │
 │  │ Statik Rezerve Public IPv4 (Örn: 130.61.x.x)                          │  │
 │  │                                                                       │  │
 │  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
 │  │  │ Caddy Reverse Proxy (Container)                                 │  │  │
 │  │  │  ├── Port 80 (HTTP-01 ACME)                                      │  │  │
 │  │  │  ├── Port 443 (Otomatik TLS / Let's Encrypt / ZeroSSL)          │  │  │
 │  │  │  ├── api.tezlify.com/api/* ──► backend:8000 (Internal Bridge)   │  │  │
 │  │  │  └── api.tezlify.com/ws    ──► backend:8000 (WSS Passthrough)   │  │  │
 │  │  └────────────────────────────────┬────────────────────────────────┘  │  │
 │  │                                   │ Docker Internal Network (tezlify) │  │
 │  │         ┌─────────────────────────┴──────────────────────────┐        │  │
 │  │         ▼                                                    ▼        │  │
 │  │  ┌──────────────────────────────┐     ┌────────────────────────────┐  │  │
 │  │  │ tezlify-backend (Container)  │     │ tezlify-gateway (Container)│  │  │
 │  │  │ FastAPI / Python 3.12        │◄───►│ Node.js 20 / Baileys       │  │  │
 │  │  │ (1.5 OCPU, 4 GB RAM Limiti)  │     │ (1.5 OCPU, 4 GB RAM Limiti)│  │  │
 │  │  │ Port 8000 (Sadece Internal)  │     │ Port 8787 (Sadece Internal)│  │  │
 │  │  └──────────────┬───────────────┘     └──────────────┬─────────────┘  │  │
 │  │                 │                                    │                │  │
 │  │                 │                                    │ Kalıcı Disk    │  │
 │  │                 │                                    ▼                │  │
 │  │                 │                 [ Persistent Volume: wa_sessions ]  │  │
 │  │                 │                 [ Persistent Volume: wa_media ]     │  │
 │  └─────────────────┼─────────────────────────────────────────────────────┘  │
 └────────────────────┼────────────────────────────────────────────────────────┘
                      │
            (3) asyncpg Pooler (6543)
                      ▼
        [ Supabase DB (Tokyo, Japonya) ] (Faz 1'de Korunur)
        [ Supabase DB (Frankfurt, Almanya) ] (Faz 2 Gelecek Hedefi)
```

---

## 4. OCI Account & Quota (Hesap ve Kota Doğrulaması)

Canlı OCI Python SDK ve OCI Limits API sorgusu ile **15 Eylül 2026 14:26** itibarıyla doğrulanmış gerçek veriler:

| Kaynak / Servis | OCI Servis Adı | Tespit Edilen Kota / Durum | Kullanılan | Kalan / Uygun |
|---|---|---|---|---|
| **Tenancy Adı** | Identity | `isatezcan444` | - | Aktif |
| **Home Region** | Identity | `FRA` (`eu-frankfurt-1`) | - | Doğrulandı |
| **Availability Domains** | Identity | 3 AD (`AD-1`, `AD-2`, `AD-3`) | 0 | 3 Bölge de Müsait |
| **A1 OCPU Limiti** | `compute` | `standard-a1-core-count`: **41 OCPU/AD** | 0 OCPU | **4 OCPU (Always Free)** |
| **A1 RAM Limiti** | `compute` | `standard-a1-memory-count`: **277 GB/AD** | 0 GB | **24 GB (Always Free)** |
| **Ücretsiz Blok Depolama** | `block-storage` | `total-free-storage-gb`: **200 GB** | 0 GB | **200 GB Boş (Balanced 10 VPUs)** |
| **Rezerve Public IPv4** | `virtual-network`| `reserved-public-ip-count`: **6 IP** | 0 IP | **6 Statik IP Hakkı (1 Ücretsiz)** |
| **VCN Limiti** | `virtual-network`| `vcn-count`: **50 VCN** | 0 VCN | **50 VCN Hakkı** |
| **Internet Gateway** | `virtual-network`| `internet-gateway-count`: **1 / VCN** | 0 | Müsait |

> [!TIP]
> **Kota Özeti:** Hesapta Always Free sınırlarının tamamı (4 OCPU, 24 GB RAM, 200 GB SSD) boştadır. `VM.Standard.A1.Flex` Frankfurt AD'lerinde kapasite engeli olmadan hemen tahsis edilebilir durumdadır.

---

## 5. Region Strategy (Bölge Stratejisi)

- **Mevcut Yol:** Türkiye (İstemci) → Oregon (Render) → Tokyo (Supabase) [Dünya etrafında çift tur].
- **Faz 1 (Bu Migration):** Türkiye → Frankfurt (Oracle VM) → Tokyo (Supabase).
  - Kullanıcı ↔ Sunucu gecikmesi 165 ms'den **~35-45 ms'ye** düşer.
  - Render'ın 72.5 saniyelik uyku süresi **0 saniyeye** iner.
  - Baileys kripto işlemleri 0.1 vCPU yerine 4 OCPU'da **< 5 ms'de** tamamlanır.
- **Faz 2 (Veritabanı Taşıma):** Türkiye → Frankfurt (Oracle VM) → Frankfurt (Supabase / Managed DB).
  - Veritabanı gecikmesi 250 ms'den **< 2 ms'ye** düşer.

---

## 6. Network Architecture (Oracle VCN Tasarımı)

Tek bir güçlü sanal makine üzerinde Docker çalıştırılacağı için gereksiz çok katmanlı karmaşıklık yerine **minimum saldırı yüzeyine sahip sade ve güvenli** bir VCN kurulacaktır:

1. **VCN Tanımı:**
   - Ad: `tezlify-vcn`
   - IPv4 CIDR: `10.0.0.0/16`
   - DNS Domain: `tezlifyvcn.oraclevcn.com`
2. **Internet Gateway:**
   - Ad: `tezlify-igw` (Tüm internet çıkış ve girişleri için)
3. **Route Table:**
   - Ad: `tezlify-public-rt`
   - Kural: `0.0.0.0/0` -> Hedef: `tezlify-igw`
4. **Subnet:**
   - Ad: `tezlify-public-subnet` (Bölgesel / Regional)
   - CIDR: `10.0.1.0/24`
   - Public IP Tahsisi: Açık (Rezerve Statik Public IP atanacak)
5. **Security List / Güvenlik Kuralları:**
   - **Giriş (Ingress):**
     - Port 22 (SSH): Kaynak `0.0.0.0/0` (yalnızca SSH anahtarı ile şifresiz; istenirse geliştirici IP'sine kısıtlanabilir).
     - Port 80 (HTTP): `0.0.0.0/0` (Let's Encrypt sertifika yenileme ve HTTPS yönlendirme).
     - Port 443 (HTTPS): `0.0.0.0/0` (API ve WebSocket trafiği).
     - **DİĞER TÜM PORTLAR (8000, 8787, 5432) DIŞARIYA KESİNLİKLE KAPALI.**
   - **Çıkış (Egress):**
     - `0.0.0.0/0` (Tüm portlar serbest - Supabase DB, WhatsApp Meta sunucuları ve paket güncellemeleri için).

---

## 7. Compute Architecture (Hesaplama ve Sunucu Tasarımı)

- **Shape:** `VM.Standard.A1.Flex` (Ampere Altra ARM64 Neoverse-N1)
- **OCPU Sayısı:** **4 OCPU** (Always Free maksimum)
- **Bellek (RAM):** **24 GB RAM** (Always Free maksimum)
- **İşletim Sistemi İmajı:** `Canonical-Ubuntu-24.04-aarch64-2026.08.25-0`
- **İmaj OCID:** `ocid1.image.oc1.eu-frankfurt-1.aaaaaaaatnudwzlqzctpx5rrxohiionypan5fngceqdbybtw6ve7oyhmnnqq`
- **Boot Volume:** **100 GB** OCI Balanced Block Storage (NVMe-oF, 10 VPUs/GB, ~6,000 IOPS - Always Free 200 GB kotasından).
- **Public IP:** 1 Adet Rezerve Statik IPv4 (IP adresi rebootlarda değişmez).
- **SSH Erişimi:** Yalnızca SSH Public Key (`~/.ssh/id_rsa.pub` veya `id_ed25519.pub`); şifreli oturum açma (`PasswordAuthentication no`) devre dışı.

---

## 8. Docker & Container Architecture (Konteyner Mimarisi)

Mevcut Render mimarisindeki "tek container içinde iki proses" modeli sonlandırılacaktır. `docker-compose.yml` ile 3 bağımsız servis çalıştırılacaktır:

```yaml
version: "3.8"

networks:
  tezlify-internal:
    driver: bridge

volumes:
  caddy_data:
  caddy_config:
  whatsapp_sessions:
  whatsapp_media:

services:
  caddy:
    image: caddy:2-alpine
    container_name: tezlify-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - tezlify-internal
    depends_on:
      - backend

  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    container_name: tezlify-backend
    restart: unless-stopped
    expose:
      - "8000"
    env_file:
      - .env.production
    environment:
      - PORT=8000
      - WHATSAPP_GATEWAY_URL=http://gateway:8787
      - WHATSAPP_GATEWAY_SECRET=${WHATSAPP_GATEWAY_SECRET}
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 6G
    healthcheck:
      test: ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]
      interval: 15s
      timeout: 5s
      retries: 3
    networks:
      - tezlify-internal
    depends_on:
      - gateway

  gateway:
    build:
      context: ./whatsapp-gateway
      dockerfile: Dockerfile
    container_name: tezlify-gateway
    restart: unless-stopped
    expose:
      - "8787"
    env_file:
      - .env.production
    environment:
      - GATEWAY_PORT=8787
      - GATEWAY_HOST=0.0.0.0
      - BACKEND_WS_URL=ws://backend:8000/ws/gateway
      - GATEWAY_ENCRYPTION_KEY=${GATEWAY_ENCRYPTION_KEY}
      - REQUIRE_DURABLE_AUTH=true
    volumes:
      - whatsapp_sessions:/app/sessions
      - whatsapp_media:/app/media
    deploy:
      resources:
        limits:
          cpus: "1.5"
          memory: 4G
    healthcheck:
      test: ["CMD", "node", "-e", "require('node:http').get('http://127.0.0.1:8787/health', r => process.exit(r.statusCode===200?0:1))"]
      interval: 15s
      timeout: 5s
      retries: 3
    networks:
      - tezlify-internal
```

---

## 9. ARM64 (aarch64) Compatibility Matrix

Oracle A1 Flex ARM64 mimarisinde çalışacak tüm bağımlılıklar incelenmiştir:

| Bağımlılık / Paket | Türü | ARM64 Desteği | Not / Risk Durumu |
|---|---|---|---|
| **Python 3.12 (Base Image)** | Docker Base | **SUPPORTED** | `python:3.12-slim` resmi `linux/arm64` imajı var. |
| **Node.js 20 (Base Image)** | Docker Base | **SUPPORTED** | `node:20-alpine` resmi `linux/arm64` imajı var. |
| **FastAPI / Pydantic / pydantic-core** | Python C-Extension | **SUPPORTED** | PyPI'da hazır `manylinux_2_17_aarch64` wheel'ları mevcut. |
| **asyncpg / psycopg2-binary** | Python C-Extension | **SUPPORTED** | PyPI'da hazır `aarch64` wheel'ları mevcut. |
| **cryptography / pyjwt** | Python C-Extension | **SUPPORTED** | OpenSSL 3.x ve ARM64 wheel'ları tam uyumlu. |
| **pandas / openpyxl** | Python C-Extension | **SUPPORTED** | Resmi pre-built `aarch64` wheel'ları mevcut. |
| **@whiskeysockets/baileys** | Node.js Paket | **SUPPORTED** | Saf JavaScript ve WebAssembly / Node kripto motoru kullanır. |
| **express, ws, pg, pino** | Node.js Paket | **SUPPORTED** | Tamamen saf JavaScript modüllerdir, derleme gerektirmez. |
| **Caddy v2** | Go Binary | **SUPPORTED** | Resmi Alpine ARM64 imajı mevcuttur. |
| **Playwright (Chromium)** | Native Binary | **KULLANILMIYOR** | Dockerfile'da açıkça belirtildiği üzere varsayılan `HTTP` motoru kullanılmaktadır; Chromium indirilmez. |

---

## 10. Runtime Responsibility Inventory (Görev Dağılımı)

| Sorumluluk / Bileşen | Mevcut Render Yeri | Hedef Oracle Yeri | Değişim Tipi |
|---|---|---|---|
| **FastAPI Core API** | In-container process | `tezlify-backend` container | İzolasyon sağlandı |
| **Uvicorn Lifespan & Migrations** | Startup script (`start.py`) | `tezlify-backend` entrypoint | Bağımsız çalışır |
| **Baileys Process** | In-container background child | `tezlify-gateway` container | Kendi container'ında |
| **Baileys Auth Storage** | Supabase `whatsapp_private` | Yerel NVMe Volume + Supabase | Çift katmanlı koruma |
| **WebSocket Inbound Bridge** | Render internal localhost | Docker bridge (`ws://backend:8000/ws/gateway`)| Özel ağ izolasyonu |
| **WebSocket İstemci Uç Noktası** | `wss://tezlify.onrender.com/ws` | `wss://api.tezlify.com/ws` (Caddy proxy) | Caddy passthrough |
| **Initial Sync Worker** | FastAPI background asyncio task | `tezlify-backend` task | 2 vCPU ile hızlı |
| **Scraper HTTP Engine** | FastAPI process | `tezlify-backend` process | Aynen korunur |
| **Medya & Oturum Dosyaları** | Ephemeral `/tmp` (silinir) | Docker Volume (Kalıcı NVMe SSD) | Asla kaybolmaz |
| **Reverse Proxy & SSL** | Render Cloudflare Edge | Caddy Container (Let's Encrypt) | Doğrudan kontrol |

---

## 11. Domain, DNS & Frontend Rewrites Stratejisi

- **Mevcut Frontend:** `https://tezlify-woad.vercel.app` (veya `app.tezlify.com`) Vercel üzerinde kalacaktır.
- **Kritik Pre-Flight Bulgusu (Vercel Rewrites):**
  - `frontend/src/api/client.ts` içinde `isVercel` kontrolü nedeniyle `*.vercel.app` üzerinden gelen API çağrıları doğrudan göreli `/api/v1` rotasına yönlendirilir.
  - `vercel.json` ve `frontend/vercel.json` dosyalarındaki `source: "/api/:path*"` kuralı ise sert kodlanmış olarak `https://tezlify.onrender.com/api/:path*` hedefine rewrite yapmaktadır!
  - Bu sebeple production cutover anında:
    1. `vercel.json` rewrite hedefi `https://api.tezlify.com/api/:path*` olarak güncellenecektir.
    2. WebSocket bağlantısı (`wss://`) Vercel tarafından proxy'lenemediği için `VITE_WS_URL=wss://api.tezlify.com/ws` olarak ayarlanıp doğrudan Caddy'ye bağlanacaktır.
- **Hedef Backend API Domaini:** `api.tezlify.com`
  - DNS Kaydı: `A` kaydı -> Oracle Rezerve Public IPv4 adresi.
  - TTL Değeri: Başlangıçta 300 saniye (5 dakika) olarak ayarlanacak (hızlı rollback için).
- **Hedef WebSocket URL:** `wss://api.tezlify.com/ws`
- **Geçiş Aşamasında Staging URL:** `staging-api.tezlify.com` (veya doğrudan Oracle IP'si) ile ön doğrulama yapılacak, production DNS ve `vercel.json`'a ancak tüm testler geçince dokunulacaktır.

---

## 12. TLS & Reverse Proxy Mimarisi (Caddy)

Nginx yerine **Caddy 2** tercih edilmiştir:
1. **Otomatik SSL (Zero Maintenance):** Domain yönlendirildiği anda Let's Encrypt sertifikasını otomatik alır ve yeniler.
2. **Yerleşik WebSocket Desteği:** Özel `upgrade` header konfigürasyonuna gerek kalmadan WebSocket trafiğini varsayılan olarak destekler.
3. **Caddyfile Tasarımı:**
   ```caddy
   api.tezlify.com {
       # Güvenlik başlıkları
       header {
           Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
           X-Content-Type-Options "nosniff"
           X-Frame-Options "DENY"
       }

       # WebSocket uç noktası (uzun süreli bağlantı)
       @websockets {
           header Connection *Upgrade*
           header Upgrade websocket
       }
       reverse_proxy @websockets backend:8000

       # REST API yönlendirmesi
       reverse_proxy backend:8000 {
           header_up X-Forwarded-Proto https
           header_up X-Real-IP {remote_host}
       }
   }
   ```

---

## 13. Database Strategy (Supabase Faz 1 Bağlantı Optimizasyonu)

- **Faz 1 Kuralı:** Supabase PostgreSQL veritabanı **Tokyo'da kalmaya devam edecektir**. Veritabanına dokunulmayacaktır.
- **Bağlantı Optimizasyonu:**
  - Render'daki 10 saniyelik doğrudan IPv6 timeout probleminden kaçınmak için Oracle VM'deki `DATABASE_URL` Supabase **Transaction Pooler (IPv4)** adresine ayarlanacaktır:
    `postgresql+asyncpg://postgres.pzpgjjtefeplygqcxfsj:[PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`
  - `statement_cache_size: 0` kuralı korunacaktır.
  - Havuz ayarları (`DATABASE_POOL_SIZE = 5`, `DATABASE_MAX_OVERFLOW = 2`) Oracle'ın 24 GB RAM kapasitesine göre güvenle genişletilecektir.

---

## 14. Data Persistence & Baileys Session Continuity

- **Render'da Sorun Neydi?** Render ephemeral diske sahip olduğu için container her uyuduğunda disk sıfırlanıyordu.
- **Oracle'da Çözüm:**
  - `whatsapp_sessions` ve `whatsapp_media` Docker Named Volume olarak kalıcı NVMe diskte tutulacaktır.
  - `PostgresAuthRepository` Supabase üzerinde kalmaya devam edecek; gateway yeniden başladığında hem yerel diskten hem Supabase'den oturumu geri yükleyebilecektir.
- **Sıfır Yeniden Eşleşme (No Relink Needed):**
  - Render'daki Baileys oturum kimlikleri (`session_credentials`) zaten Supabase'de şifreli saklandığı için, Oracle'daki gateway aynı `GATEWAY_ENCRYPTION_KEY` ile başlatıldığında **mevcut oturumları QR okutmaya gerek kalmadan otomatik restore edecektir**.

---

## 15. Process Management & Failure Scenarios (SRE Bakış Açısı)

| Arıza / Senaryo | Tespit Mekanizması | Otomatik Kurtarma | Kullanıcı Etkisi |
|---|---|---|---|
| **Backend Crash** | Docker Healthcheck (15s) | `restart: unless-stopped` (3 sn içinde kalkar) | O anki HTTP isteği 502 döner, anında düzelir. |
| **Gateway Crash** | Docker Healthcheck (15s) | `restart: unless-stopped` (5 sn içinde restore) | WebSocket 3 sn kopar, arayüz otomatik yeniden bağlanır. |
| **VM Reboot** | Systemd Docker Service | Tüm container'lar boot anında otomatik başlar | ~20 saniye kesinti (yılda belki 1 kez). |
| **Supabase Kesintisi** | `WhatsAppGatewayError` | Fail-closed koruması, sahte veri basılmaz | Kullanıcıya açık bağlantı uyarısı gösterilir. |
| **Disk Dolması** | Docker Log Rotation (`max-size: 50m`) | Loglar 50MB ile sınırlı, otomatik silinir | Disk asla dolmaz. |

---

## 16. Güvenlik ve Sıkılaştırma (Security Hardening)

1. **OCI API Anahtarı:** `~/.oci/` altında ve `chmod 600` ile kalacak; hiçbir zaman Git reposuna veya Docker imajına girmeyecektir.
2. **SSH Güvenliği:**
   - Şifre ile giriş tamamen kapatılacak (`PasswordAuthentication no`).
   - SSH portu güvenlik listesinde yalnızca geliştirici IP bloğuna sınırlandırılacaktır.
3. **Container İzolasyonu:**
   - Baileys Gateway portu (`8787`) internete açılmayacaktır (yalnızca Docker iç ağında `backend` erişebilir).
   - Backend doğrudan port açmayacak; yalnızca Caddy üzerinden TLS ile konuşacaktır.
4. **Secrets Yönetimi:**
   - `.env.production` dosyası sunucuda `/opt/tezlify/.env` altında `chmod 600` ile tutulacak, Git'e kesinlikle atılmayacaktır.

---

## 17. CI/CD Dağıtım Boru Hattı (GitHub Actions)

Mevcut Git workflow'unu bozmadan en sade ve güvenli CI/CD modeli:

```
[ Git Push (main) ]
        │
        ▼
[ GitHub Actions Runner ]
        │ (1) SSH ile Oracle VM'e bağlan
        ▼
[ Oracle VM (/opt/tezlify) ]
        ├── git pull origin main
        ├── docker compose build --pull
        ├── docker compose up -d --remove-orphans
        └── curl -f http://127.0.0.1:8000/health || exit 1
```
- Başarısız build durumunda eski çalışan container'lar devrede kalır (sıfır kesinti).

---

## 18. Environment Variables Matrix (Ortam Değişkenleri)

| Değişken Adı | Mevcut Render | Hedef Oracle VM | Frontend Vercel |
|---|---|---|---|
| `DATABASE_URL` | Render Dashboard | `/opt/tezlify/.env` (Pooler 6543) | İhtiyaç yok |
| `GATEWAY_DATABASE_URL`| Render Dashboard | `/opt/tezlify/.env` (Pooler 6543) | İhtiyaç yok |
| `GATEWAY_ENCRYPTION_KEY`| Render Dashboard | `/opt/tezlify/.env` (Aynı Key!) | İhtiyaç yok |
| `WHATSAPP_GATEWAY_SECRET`| Render Dashboard | `/opt/tezlify/.env` (Aynı Secret) | İhtiyaç yok |
| `SECRET_KEY` | Render Dashboard | `/opt/tezlify/.env` | İhtiyaç yok |
| `SUPABASE_JWT_SECRET` | Render Dashboard | `/opt/tezlify/.env` | İhtiyaç yok |
| `WHATSAPP_GATEWAY_URL`| `http://127.0.0.1:8787` | `http://gateway:8787` | İhtiyaç yok |
| `VITE_API_URL` | `https://tezlify.onrender.com` | `https://api.tezlify.com` | Vercel Project Settings |
| `VITE_WS_URL` | `wss://tezlify.onrender.com/ws` | `wss://api.tezlify.com/ws` | Vercel Project Settings |

---

## 19. WhatsApp Session Continuity & Distributed Socket Lease

> [!CAUTION]
> **En Kritik WhatsApp Kuralı:** İki farklı Baileys gateway prosesi aynı telefon numarasına/oturumuna AYNI ANDA bağlanırsa, WhatsApp güvenlik protokolü oturumu kalıcı olarak kapatır (`Conflict / 409 Logout`).

### Kod Bazındaki Mevcut Güvence:
`whatsapp-gateway/src/lease/postgres-session-lease.js` içinde `whatsapp_private.socket_leases` tablosu üzerinden çalışan **Distributed Socket Lease** mekanizması halihazırda mevcuttur:
- Her gateway instance'ı socket açmadan önce `acquire(sessionId, instanceId, generation)` çalıştırır.
- Başka bir gateway'in aktif lease'i varsa (`expires_at > NOW()`), yeni gateway socket açmaz (`socket_lease_contended` döner).

### Doğrulanmış Sıralı Geçiş Protokolü:
1. **Adım 1:** Oracle VM staging ortamında yeni geçici bir test oturumu (`session_id = test-999`) ile QR ve mesajlaşma test edilir.
2. **Adım 2:** Production cutover anında, Render Web Service askıya alınır (`Suspend Web Service`).
3. **Adım 3:** Render Gateway kapanırken `release(sessionId, instanceId)` çağrısıyla DB'deki socket lease'ini siler.
4. **Adım 4:** Supabase DB sorgusuyla lease'in silindiği doğrulanır: `SELECT * FROM whatsapp_private.socket_leases WHERE session_id = '...'`.
5. **Adım 5:** Oracle'daki `tezlify-gateway` başlatılır; boşalan lease'i anında alır.
6. **Adım 6:** Oracle Gateway, Supabase'deki `session_credentials` ve `signal_keys` tablolarından mevcut oturumu okur ve Meta sunucusuna bağlanır.
7. **Adım 7:** Kullanıcı telefonuna herhangi bir bildirim veya yeniden QR düşmeden oturum `CONNECTED / READY` durumuna geçer.

---

## 20. Performans Karşılaştırma Projeksiyonu

| Metrik | Render Free (Ölçülen) | Oracle Frankfurt (Hedef) | İyileşme Oranı |
|---|---|---|---|
| **Cold Start (Uyku)** | **72.5 saniye** | **0 saniye (Always-On)** | **Sonsuz kat hızlı** |
| **CPU Gücü** | 0.1 vCPU paylaşımlı | **4 OCPU (8 Threads) Dedicated** | **40 kat güçlü** |
| **Bellek (RAM)** | 512 MB (OOM riski) | **24 GB RAM** | **48 kat geniş** |
| **TR ↔ Sunucu RTT** | 165 ms | **35 - 45 ms** | **4 kat daha yakın** |
| **Tekil DB İstek Süresi** | ~10 - 12 saniye | **~1.1 saniye (Faz 1) / < 15ms (Faz 2)**| **10 kat - 800 kat** |
| **WhatsApp Mesaj İletimi**| ~11 - 21 saniye | **< 400 ms** | **WhatsApp Web seviyesi** |

---

## 21. Phase Plan (11 Aşamalı Güvenli Yol Haritası)

```
[ FAZ 0: Pre-Flight ] ──► [ FAZ 1: OCI Network ] ──► [ FAZ 2: VM Kurulumu ]
                                                            │
[ FAZ 5: DB Testi ] ◄── [ FAZ 4: Staging Deploy ] ◄── [ FAZ 3: Docker Hazırlık ]
       │
       ▼
[ FAZ 6: Test WA Oturumu ] ──► [ FAZ 7: Session Devir ] ──► [ FAZ 8: DNS & Vercel Cutover ]
                                                                     │
                                [ FAZ 10: Decommission ] ◄── [ FAZ 9: 48h Gözlem ]
```

- **FAZ 0: Pre-Flight İnceleme (TAMAMLANDI):** OCI kotaları, storage tipi, ARM64 paketleri, socket lease ve vercel rewrites doğrulandı.
- **FAZ 1: OCI Ağ Altyapısı (10 Dk):** tezlify-vcn (10.0.0.0/16), IGW, route table, security list ve 1 adet Rezerve Statik IPv4 açılacak.
- **FAZ 2: OCI Compute (5 Dk):** Ubuntu 24.04 ARM64, 4 OCPU, 24 GB RAM, 100 GB Boot Volume ile VM başlatılacak.
- **FAZ 3: Docker & Sunucu Hazırlığı (10 Dk):** Docker Engine, Compose kurulacak; /opt/tezlify dizini açılacak.
- **FAZ 4: Staging Dağıtımı (15 Dk):** Caddyfile, docker-compose.yml, .env.production sunucuya yerleştirilip docker compose up -d çalıştırılacak.
- **FAZ 5: Supabase Bağlantı & Benchmark Testi (15 Dk):** Transaction Pooler (Port 6543) üzerinden DB connect ve query latency ölçülecek.
- **FAZ 6: İzole Test WhatsApp Oturumu (15 Dk):** Geçici test-999 oturumuyla QR üretimi, mesaj gönderimi ve realtime event testi yapılacak.
- **FAZ 7: Canlı WhatsApp Oturumu Devri (5 Dk):** Render durdurulacak, lease serbest bırakılacak, Oracle gateway canlı oturumu Supabase'den restore edecek.
- **FAZ 8: DNS & Vercel Cutover (5 Dk):** api.tezlify.com DNS kaydı ve vercel.json rewrites güncellenecek.
- **FAZ 9: 48 Saatlik Gözlem Periyodu:** 6 kabul kriteri (sıfır reconnect anomalisi, sıfır mesaj kaybı, stabil WebSocket) izlenecek.
- **FAZ 10: Render Decommission:** Başarı kriterleri sağlandığında Render Free servisi tamamen silinecektir.

---

## 22. Dosya ve Kod Etki Haritası

| Dosya Yolu | İşlem | Açıklama |
|---|---|---|
| `docker-compose.yml` | **MODIFY** | Tek container'lı sidecar yerine Caddy + Backend + Gateway yapısına güncellenecek. |
| `Caddyfile` | **CREATE** | Otomatik TLS ve WebSocket proxy kurallarını barındıran yeni dosya. |
| `backend/Dockerfile` | **CREATE** | Backend için Node.js içermeyen saf Python 3.12 hafif ARM64 Dockerfile. |
| `whatsapp-gateway/Dockerfile`| **KEEP** | Mevcut Node 20 Alpine Dockerfile ARM64 ile %100 uyumludur, aynen korunur. |
| `docker-entrypoint.sh` | **DELETE (Oracle)**| Render için yazılmış iki prosesli bekleme script'i Oracle'da gereksizdir. |
| `frontend/.env.production` | **MODIFY** | `VITE_API_URL=https://api.tezlify.com` ve `VITE_WS_URL=wss://api.tezlify.com/ws` olacak. |
| `.github/workflows/deploy.yml`| **CREATE** | Oracle VM'e otomatik deployment yapan GitHub Actions workflow'u. |

---

## 23. Rollback Planı (Geri Dönüş Güvencesi)

Geçiş sırasında veya hemen sonrasında beklenmeyen bir problem çıkarsa:
1. Vercel ortam değişkenleri eski haline getirilir:  
   `VITE_API_URL=https://tezlify.onrender.com`  
   `VITE_WS_URL=wss://tezlify.onrender.com/ws`
2. Vercel redeploy edilir (30 saniye).
3. Oracle Gateway durdurulur (`docker compose stop gateway`).
4. Render Web Service yeniden başlatılır (`Resume Web Service`).
5. **Geri Dönüş Süresi: < 3 Dakika.** Supabase veritabanı taşınmadığı için hiçbir veri kaybı riski yoktur.

---

## 24. Karar Tablosu (Decision Table)

| Bileşen | Karar | Yeni Konum | Gerekçe / Notlar |
|---|---|---|---|
| **Vercel Frontend** | **KEEP** | Vercel Edge | CDN mükemmel çalışıyor, taşımaya gerek yok. |
| **FastAPI Backend** | **MOVE** | Oracle VM Container | 0.1 vCPU'dan kurtulup 2 OCPU gücüne geçiyor. |
| **Baileys Gateway** | **MOVE** | Oracle VM Container | Ayrı container'da kalıcı disk ile 7/24 çalışacak. |
| **WebSocket** | **MOVE** | Oracle Caddy Proxy | Caddy üzerinden kesintisiz WSS passthrough. |
| **Background Worker** | **MOVE** | Oracle Backend Container | 24 GB RAM ile OOM riski olmadan eşitleme yapacak. |
| **Supabase DB** | **KEEP (Faz 1)**| AWS Tokyo | Faz 1'de risk almamak için DB taşınmayacak. |
| **DNS / Domain** | **REBUILD** | `api.tezlify.com` | Statik Oracle IP'sine yönlendirilecek. |
| **TLS** | **REBUILD** | Caddy Otomatik SSL | Let's Encrypt / ZeroSSL otomatik yenileme. |
| **CI/CD** | **CREATE** | GitHub Actions | Otomatik SSH ve Docker Compose dağıtımı. |
| **Render Free** | **DECOMMISSION**| Kapatılacak | 48 saatlik stabilite testinden sonra silinecek. |

---

## 25. Kritik Mimari Kararlar ve Kesin Cevaplar

1. **"Render üzerinde çalışan TÜM gerekli workload'ları Oracle Frankfurt Always Free üzerinde güvenli şekilde çalıştırabilir miyiz?"**  
   👉 **YES (EVET).**  
   *Neden:* Oracle A1 Flex shape'i 4 OCPU ve 24 GB RAM sağlar. Render Free'nin sağladığı 0.1 vCPU ve 512MB RAM'in tam 40 katı işlemci, 48 katı bellek gücüdür. 100 GB NVMe disk ile tüm oturumlar kalıcı hale gelir.

2. **"Supabase Tokyo şimdilik korunmalı mı?"**  
   👉 **YES (EVET).**  
   *Neden:* Migration karmaşıklığını ve veri kaybı riskini izole etmek için önce sunucu katmanı taşınmalıdır. Tek bilinmeyenli denklem prensibi: Önce Render problemi çözülür, stabilite doğrulanır.

3. **"Supabase Frankfurt migration ikinci faz olmalı mı?"**  
   👉 **YES (EVET).**  
   *Neden:* Oracle sunucusu zaten Frankfurt'ta olacağından, ikinci aşamada Supabase projesi Frankfurt'a taşındığında veya Oracle içine yerel PostgreSQL açıldığında sistem içi gecikme 250 ms'den < 0.5 ms'ye inecektir.

4. **"FastAPI ve Baileys aynı VM'de ama ayrı container olmalı mı?"**  
   👉 **YES (EVET).**  
   *Neden:* Render'ın aksine Oracle'da Docker ağ izolasyonu vardır. İki prosesin birbirinin bellek veya event loop'unu kilitlememesi için ayrı container'lar şarttır. Gateway internete kapalı kalıp yalnızca internal ağdan çağrılacaktır.

5. **"WebSocket doğrudan Oracle üzerinden mi servis edilmeli?"**  
   👉 **YES (EVET).**  
   *Neden:* Caddy reverse proxy üzerinden `wss://api.tezlify.com/ws` şeklinde şeffafça sunulacak; Render'ın bağlantı koparma sınırları ortadan kalkacaktır.

6. **"Render ne zaman kapatılabilir?"**  
   👉 Oracle üzerinde DNS geçişi yapıldıktan ve sistem **48 saat boyunca sıfır hata ve kesintisiz WhatsApp oturumu** ile çalıştıktan sonra Render tamamen kapatılabilir.

---

## 26. Sonuç ve Eylem Onayı

Bu doküman Tezlify projesinin production altyapısını dünya standartlarında, uykusuz, yüksek performanslı ve tamamen ücretsiz bir mimariye taşımak için hazırlanmış eksiksiz bir yol haritasıdır.

Kural gereği bu aşamada **hiçbir canlı kaynağa veya koda dokunulmamıştır**. Onay vermeniz halinde **Faz 1 (Oracle VCN ve Güvenlik Altyapısı)** ile uygulama adımına geçilebilir.
