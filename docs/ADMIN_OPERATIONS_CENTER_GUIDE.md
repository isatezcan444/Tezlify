# TEZLIFY — YÖNETİM VE OPERASYON MERKEZİ (ADMIN & OPERATIONS CENTER)
## Mimari, Güvenlik Sözleşmeleri, Kod Haritası ve Geliştirici Kılavuzu

> **Bu Belgenin Amacı:**  
> Tezlify Yönetim ve Operasyon Paneli; sunucu sağlığı, Docker konteyner filosu, WhatsApp gateway köprüsü, canlı log akışı, veri tabanı metrikleri ve üretim dağıtım (deploy) süreçlerini tek bir çatı altında yöneten kritik bir altyapıdır.  
> Bu belge, **ChatGPT veya gelecekteki geliştiricilerin** panelde yapılacak güncellemeleri, mimari kuralları, güvenlik sınırlarını ve kod akışını eksiksiz anlayıp hiçbir üretim invariant'ını bozmadan genişletme yapabilmesi için hazırlanmış kesin teknik referanstır.

---

## 1. YÜKSEK SEVİYE SİSTEM MİMARİSİ VE KONTROL DÜZLEMİ

Tezlify bir B2B Lead Generation ve WhatsApp platformudur. Oracle Linux (`130.162.247.20`) üzerinde Docker Compose mimarisiyle çalışır.

### Mimarî Akış Şeması (Control Plane vs. Data Plane)

```
       [ Tarayıcı / Yönetici Kullanıcı ]
                     │  (HTTPS / WSS - JWT / tezlify_session cookie)
                     ▼
             [ tezlify-caddy:443 ] (Ters Vekil / SSL / Güvenlik Başlıkları)
                     │
         ┌───────────┴───────────────────────┐
         │                                   │
         ▼                                   ▼
[ /assets/*, /* ] (SPA)               [ /api/*, /ws* ]
(Frontend Statik Dosyalar)           [ tezlify-backend:8000 ] (FastAPI + Uvicorn)
                                             │
                       ┌─────────────────────┼─────────────────────┐
                       │                     │                     │
                       ▼                     ▼                     ▼
          [ /api/v1/admin/* ]      [ /api/v1/admin/ops/* ]   [ Baileys Gateway ]
          (Salt-Okunur Telemetri)  (Operasyon & Komutlar)    (tezlify-gateway:8787)
                       │                     │                     │
                       │                     │ (/var/run/docker.sock)
                       │                     ▼                     ▼
              [ PostgreSQL 17 ]       [ Docker Daemon ]    [ WhatsApp Socket ]
            (tezlify_internal ağ)   (Konteyner Kontrolü)   (Meta / Baileys)
```

### Temel Güvenlik Ayrımı (Read-Only vs. Operations)

Sistem mimarisi **iki ayrı API router'ı** ve **iki ayrı risk sınıfı** üzerine inşa edilmiştir:

1. **Salt-Okunur İzleme Router'ı (`/api/v1/admin/*`)**  
   - Dosya: `backend/app/api/v1/endpoints/admin.py`
   - Servis: `backend/app/services/admin/*` (`overview_service.py`, `whatsapp_admin_service.py`, vb.)
   - Özellik: **Kesinlikle sıfır mutasyon (Zero Mutations)**. Sadece durum, metrik, disk kullanımı ve sağlık bilgisi toplar. Hiçbir servis yeniden başlatılamaz, hiçbir komut çalıştırılamaz.

2. **Operasyon ve Komut Merkezi Router'ı (`/api/v1/admin/ops/*`)**  
   - Dosya: `backend/app/api/v1/endpoints/ops_admin.py`
   - Servis: `backend/app/services/admin/ops_service.py`
   - Özellik: **Beyaz Liste (Allowlist) Esaslı Operasyonlar**. Konteyner yeniden başlatma, log okuma/temizleme, git durum sorgulama ve tekil güvenli deploy boru hattını yönetir.

---

## 2. DEĞİŞMEZ GÜVENLİK SÖZLEŞMELERİ (IRONCLAD INVARIANTS)

Panelde herhangi bir kod güncellenirken **ASLA çiğnenmemesi gereken 7 kural**:

### 1. Dinamik Komut Çalıştırma Yasağı (Anti-RCE Invariant)
- `ops_service.py` içinde hiçbir zaman istemciden (HTTP query, body, header) gelen bir metin doğrudan kabuğa (`bash`, `sh`, `subprocess.Popen(..., shell=True)`) verilemez!
- Tüm komutlar `OPERATIONS` sözlüğünde tanımlı **sabit argüman dizileri (`List[str]`, `shell=False`)** olarak tanımlanır.
- İstemci yalnızca operasyon **adını** (`name: "restart_backend"`) ve onay bayrağını (`confirm: true`) gönderebilir.

### 2. Docker Soketi ve Kök Yetki Riski
- `tezlify-backend` konteyneri host üzerindeki `/var/run/docker.sock` dosyasına erişir. Docker soketine erişim, sunucu üzerinde `root` yetkisine eşdeğerdir.
- Bu nedenle tüm rotalar `require_admin` bağımlılığı ile korunur (isimsiz istek -> `401 Unauthorized`, admin listesinde olmayan kullanıcı -> `403 Forbidden`).
- İzin verilen admin e-postaları `.env` içerisindeki `ADMIN_EMAILS` ile yönetilir (`backend/app/auth/api/dependencies.py`).

### 3. PostgreSQL Konteyneri Koruma Kuralı
- Operasyon Merkezi **`tezlify-db` (PostgreSQL) konteynerini ASLA yeniden başlatmaz veya durdurmaz**.
- İzin verilen servisler tuple'ı sabittir: `ALLOWED_SERVICES = ("backend", "gateway", "caddy")`.
- `restart_all` komutu bile `--no-deps` ile sadece bu üç servisi hedefler. DB'yi yeniden başlatmak canlı WhatsApp oturumlarının bağlantısını koparır ve veri kaybına yol açar.

### 4. Bounded Loglar ve Dosya Kırpma (Truncate) Kuralı
- Docker JSON log dosyaları sonsuza kadar büyümez; `docker-compose.prod.yml` içinde `max-size: "10m"`, `max-file: "3"` ile sınırlandırılmıştır.
- Log temizleme işlemi (`clear_service_logs`) dosya silmez (`unlink` yapmaz), dosyayı **yerinde sıfırlar (truncate: `open(path, 'w').truncate(0)`)**. Çünkü Docker daemon açık dosya tanıtıcısını (`inode`) tutar; silinirse disk alanı boşalmaz ve daemon yeni log yazamaz.
- Panel, log okurken `docker logs` CLI'ını DEĞİL, JSON log dosyasının son baytlarını doğrudan okur (`_tail_json_log`). Bu sayede dosya truncate edilse dahi panel bloklanmaz.

### 5. Hassas Bilgi Maskeleme (Secret Redaction)
- `redact()` fonksiyonu; şifreleri, JWT token'larını, WhatsApp anahtarlarını, private key'leri ve çerezleri UI'a gönderilmeden veya diske yazılmadan **önce** `[REDACTED]` ile maskeler.

### 6. Tekil ve Sıralı Dağıtım Boru Hattı (Cohesive Pipeline)
- Deploy işlemi parçalı butonlar (önce pull et, sonra build et, sonra restart et) şeklinde DEĞİLDİR. Operatör adımları unutmasın veya eski commit'i derlemesin diye `deploy_full` operasyonu sıralı ve fail-fast bir boru hattıdır:
  `git pull --ff-only` -> `docker compose build` -> `docker compose up -d --no-deps --force-recreate caddy backend gateway`.

### 7. Durum Kalıcılığı (Durable Ops State)
- Backend kendi kendini yeniden başlattığında hafızadaki state kaybolmasın diye operasyon geçmişi `deploy/.ops-state/operations.json` dosyasına yazılır.
- Yeniden başlama sonrasında `_recover_orphans()` fonksiyonu yarıda kalan operasyonları otomatik olarak `interrupted` olarak işaretler.

---

## 3. DOSYA VE DİZİN HARİTASI

### Frontend (React + TypeScript + Tailwind)
```
frontend/src/
├── pages/admin/
│   ├── AdminOverviewPage.tsx        # Sistem, RAM, CPU, Disk, Konteyner ve DB Özeti
│   ├── AdminOperationsPage.tsx      # Servis kontrolleri, canlı loglar, hata akışı, geçmiş
│   ├── AdminWhatsAppPage.tsx        # WhatsApp gateway çalışma zamanı, lease, outbox, ghost analiz
│   ├── AdminMonitoringPage.tsx      # R1-R13 sistem değişmezleri, telemetry audit
│   ├── AdminBackupsPage.tsx         # DB ve medya yedek dosyaları, disk tüketimi
│   ├── AdminDeploymentPage.tsx      # Git durumu, adacık (candidate) sürümleri, imaj hash'leri
│   └── AdminSecurityPage.tsx        # SSH, UFW, konteyner izolasyonu, Caddy başlıkları
├── components/admin/
│   ├── AdminShell.tsx               # Tüm sayfaları saran ortak kabuk (Header, refresh, i18n)
│   └── ops/
│       ├── ServiceStatusPanel.tsx   # Konteyner durum kartları (restart butonları)
│       ├── OpsLogsPanel.tsx         # Log izleyici (tail, seviye filtresi, temizleme, export)
│       ├── OpsHistoryPanel.tsx      # Operasyon geçmişi tablosu ve filtreleme
│       ├── ErrorFeed.tsx            # Hata akışı ve sınıflandırma paneli
│       ├── OverviewPanel.tsx        # Hızlı sağlık özeti kartları
│       ├── DeployPanel.tsx          # Dağıtım takip bileşeni
│       └── logLevel.ts              # Log seviye ayrıştırıcı (Pino, Caddy, Python, PG)
├── api/
│   └── admin.ts                     # AdminApi (salt-okunur) ve OpsApi (operasyonlar)
└── types/
    └── admin.ts                     # Backend DTO'larına birebir uyan TypeScript tipleri
```

### Backend (FastAPI + Python 3.12+ + SQLAlchemy)
```
backend/app/
├── api/v1/endpoints/
│   ├── admin.py                     # GET /overview, /whatsapp, /monitoring, /backups, /deployment, /security
│   └── ops_admin.py                 # GET/POST /ops/status, /ops/catalogue, /ops/logs, /ops/operations, /ops/health
├── services/admin/
│   ├── ops_service.py               # (48 KB) İzin verilen operasyonlar, log tailing, state persistence
│   ├── overview_service.py          # Host CPU/RAM/Disk + PG bağlantı havuzu metrikleri
│   ├── whatsapp_admin_service.py    # Gateway bridge, session lease, outbox metrikleri
│   ├── monitoring_admin_service.py  # R1-R13 invariant telemetrisi
│   ├── backups_admin_service.py     # Yedek dosyaları meta verileri
│   ├── deployment_admin_service.py  # Git ve docker imaj meta verileri
│   └── security_admin_service.py    # Sistem güvenlik sıkılaştırma denetimi
├── schemas/
│   ├── admin.py                     # Salt-okunur admin Pydantic modelleri
│   └── ops.py                       # Operasyon merkezi Pydantic modelleri
└── auth/api/dependencies.py         # require_admin yetkilendirme bağımlılığı
```

---

## 4. 7 ADMİN SAYFASININ DETAYLI İŞLEVLERİ

### 1. Genel Bakış (`AdminOverviewPage` / `admin-overview`)
- **Amaç:** Sunucunun anlık canlılık karnesi.
- **API:** `AdminApi.getOverview()` (`GET /api/v1/admin/overview`).
- **Bileşenler:**
  - Genel Sistem Durumu Rozeti (`OK`, `WARN`, `CRITICAL`) ve nedenleri.
  - CPU Yük Ortalaması (Load Average: 1m, 5m, 15m), Çekirdek Sayısı.
  - Bellek (RAM) Kullanımı (Toplam, Kullanılan, Boşta).
  - Disk Alanı (Toplam GB, Kullanılan GB, Yüzde).
  - PostgreSQL Bağlantı Havuzu (Aktif bağlantılar, Boştakiler, Veritabanı boyutu MB).
  - Konteyner Listesi (`tezlify-caddy`, `tezlify-backend`, `tezlify-gateway`) — durum, restart sayısı, OOM durumu, RSS MB.

### 2. Operasyon Merkezi (`AdminOperationsPage` / `admin-operations`)
- **Amaç:** Servisleri güvenle kontrol etme, canlı logları izleme, sistem hatalarını inceleme ve operasyon geçmişini denetleme.
- **5 Alt Sekme:**
  1. **Overview (`admin.ops.tabOverview`):** Hızlı operasyonel sağlık, çalışan aktif operasyon (in-flight spinner), son audit kayıtları.
  2. **System / Services (`admin.ops.tabSystem`):** `backend`, `gateway`, `caddy` servis kartları; CPU/bellek tüketimi, sağlık durumu, yeniden başlatma (`restart_*`) ve Caddy hot-reload butonları.
  3. **Errors (`admin.ops.tabErrors`):** Loglardan otomatik ayıklanan son hatalar, servis bazlı dağılım, stack trace incelemesi.
  4. **Logs (`admin.ops.tabLogs`):** Canlı log görüntüleyici. Servis seçimi (`backend`, `gateway`, `caddy`), satır sayısı seçimi (`50`, `100`, `200`, `500`), seviye filtresi (`ALL`, `ERROR`, `WARN`, `INFO`), otomatik kaydırma (auto-scroll), log indirme (`exportLogs`) ve log temizleme (`clearLogs`).
  5. **History (`admin.ops.tabHistory`):** Gerçekleştirilen tüm operasyonların geçmişi. Filtreler (`ALL`, `SUCCESS`, `FAILED`, `RUNNING`, `INTERRUPTED`), sayfalama (limit/offset), adım adım çıktı ve çıkış kodu (`exit_code`) modalı.

### 3. WhatsApp Operasyonları (`AdminWhatsAppPage` / `admin-whatsapp`)
- **Amaç:** WhatsApp servisinin iç organlarını inceleme. Salt-okunurdur; mesaj göndermez, oturum silmez.
- **API:** `AdminApi.getWhatsApp()` (`GET /api/v1/admin/whatsapp`).
- **Bileşenler:**
  - **Gateway Köprüsü:** WebSocket bağlantı durumu, reconnect sayısı, son event zamanı.
  - **Runtime & DB Senkronizasyonu:** Gateway'deki canlı oturumlar ile PostgreSQL `whatsapp_sessions` tablosu karşılaştırması.
  - **Hayalet Oturumlar (Ghost Sessions):** DB'de `CONNECTED` görünen ama gateway'de çalışmayan oturumların tespiti (`chats: 0` nedeni).
  - **Yetim Oturumlar (Orphan Sessions):** Gateway'de bağlı olan ama DB kaydı silinmiş oturumlar (veri kaybı uyarısı).
  - **Soket Kiralama (Lease):** Çoklu gateway çakışmasını önleyen Postgres lease durumları (aktif, mükerrer, bayat lease'ler).
  - **Event Outbox:** İletilmeyi bekleyen (`PENDING`, `IN_FLIGHT`) gateway event sayıları.

### 4. Sistem ve Güvenilirlik İzleme (`AdminMonitoringPage` / `admin-monitoring`)
- **Amaç:** Sistemdeki 13 temel değişmezin (R1–R13 Invariant Checks) otomatik kontrolü.
- **API:** `AdminApi.getMonitoring()` (`GET /api/v1/admin/monitoring`).
- **Bileşenler:**
  - Sistem Zamanlayıcı (System Monitor Timer) ve WhatsApp Gözlemcisi (Observer Timer) anlık canlılık durumu.
  - R1-R13 Güvenlik ve Bütünlük Kuralları (Örn: Veri tabanı havuz taşması olmaması, soket sızıntısı olmaması, yetim outbox kalmaması).
  - Telemetri geçmişi ve anomali tespiti.

### 5. Yedekleme ve Kurtarma (`AdminBackupsPage` / `admin-backups`)
- **Amaç:** Veri tabanı ve medya yedeklerinin diskteki varlığını ve boyutunu denetleme.
- **API:** `AdminApi.getBackups()` (`GET /api/v1/admin/backups`).
- **Bileşenler:**
  - PostgreSQL Dump Dosyaları (`.sql.gz` listesi, boyut, oluşturulma tarihi, SHA256).
  - Medya ve WhatsApp Görsel Yedekleri.
  - Konfigürasyon Dosyası Yedekleri.
  - Toplam Disk Tüketimi ve Eski Yedekleri Temizleme Bilgisi.
  - *Not:* İkili dosya indirme (binary download) güvenlik gereği kapalıdır; yalnızca meta veri denetlenir.

### 6. Dağıtım ve Altyapı (`AdminDeploymentPage` / `admin-deployment`)
- **Amaç:** Canlıdaki kodun hangi commit'te olduğunu ve dağıtım sağlığını doğrulama.
- **API:** `AdminApi.getDeployment()` (`GET /api/v1/admin/deployment`).
- **Bileşenler:**
  - Canlı Git Commit Hash'i, Branch adı, Değişiklik/Dirty durumu.
  - Çalışan Docker İmaj Digest'leri (Git commit'i ile derlenen imajın eşleşip eşleşmediğinin doğrulanması).
  - Frontend Sürüm Dizini (`releases/` altındaki varlık hash manifestosu).
  - Geçmiş Dağıtım Günlükleri ve Rollback Hedefleri (`host-release.sh --rollback-to <TS>`).

### 7. Güvenlik ve Sıkılaştırma (`AdminSecurityPage` / `admin-security`)
- **Amaç:** Sunucu saldırı yüzeyinin ve güvenlik ayarlarının denetimi.
- **API:** `AdminApi.getSecurity()` (`GET /api/v1/admin/security`).
- **Bileşenler:**
  - Güvenlik Skoru ve Uyarılar.
  - SSH Sıkılaştırması (Root login kapalı mı, Parola ile giriş kapalı mı, Port 22 durumu).
  - UFW Güvenlik Duvarı (Açık portlar: 80, 443; kapalı portlar: 5432, 8787).
  - Konteyner İzolasyon Denetimi (Host ağı yerine internal bridge kullanımı).
  - Caddy HTTP Güvenlik Başlıkları (`HSTS`, `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy`).

---

## 5. OPERASYON MERKEZİ MOTORU (`ops_service.py`) ÇALIŞMA MEKANİZMASI

Operasyonların nasıl başlatıldığı, çalıştırıldığı ve takip edildiği adım adım şöyledir:

### Yaşam Döngüsü (Operation Lifecycle)

```
[ POST /api/v1/admin/ops/operations ]
               │
               ▼
   [ 1. Güvenlik & Doğrulama ]
   - require_admin kontrolü (401/403)
   - Operasyon adı OPERATIONS sözlüğünde var mı?
   - Yıkıcı (destructive) ise confirm == True mu?
   - Aile kilidi (_inflight): Başka bir deploy veya restart çalışıyor mu?
   - Cooldown süresi doldu mu?
               │
               ▼
   [ 2. Operasyon Kaydı Oluşturma ]
   - UUID üretilir (id = op_uuid)
   - status = "running"
   - In-memory registry'ye ve .ops-state/operations.json'a yazılır.
   - Audit kaydı oluşturulur.
               │
               ▼
   [ 3. Asenkron Arka Plan Görevi (Background Task) ]
   - asyncio.create_task(_execute(op, spec, user_id))
   - HTTP yanıtı 200/202 ile derhal döner (istemci bloklanmaz).
               │
               ▼
   [ 4. Çalıştırma Adımları (_execute) ]
   - Çok adımlı ise (ör. deploy_full: pull -> build -> restart) sırayla koşar.
   - asyncio.create_subprocess_exec(*argv, shell=False)
   - stdout ve stderr satır satır okunur, redact() edilir ve op["logs"] listesine eklenir.
   - WebSocket / SSE event'i yayınlanır: tezlify:ws_event -> "ops_event".
               │
               ▼
   [ 5. Bitiş ve Sağlık Kontrolü ]
   - exit_code == 0 ise: status = "success", run_health_check() koşturulur.
   - exit_code != 0 ise: status = "failed", pipeline sonraki adımları durdurur.
   - In-memory registry ve .ops-state güncellenir, aile kilidi kaldırılır.
```

### Beyaz Listedeki Operasyonlar Kataloğu (`OPERATIONS`)

| Operasyon Adı | Açıklama | Yıkıcı mı? | Zaman Aşımı | Çalıştırılan Komut Dizisi |
|---|---|:---:|:---:|---|
| `restart_backend` | Backend konteynerini yeniden başlat | Evet | 300s | `docker compose -p tezlify -f ... up -d --no-deps --force-recreate backend` |
| `restart_gateway` | WhatsApp Gateway'i yeniden başlat | Evet | 300s | `docker compose -p tezlify -f ... up -d --no-deps --force-recreate gateway` |
| `restart_caddy` | Caddy vekil sunucusunu yeniden başlat | Evet | 300s | `docker compose -p tezlify -f ... up -d --no-deps --force-recreate caddy` |
| `reload_caddy` | Caddy'yi sıfır kesintiyle reload et | Evet | 30s | `docker exec tezlify-caddy caddy reload --config /etc/caddy/Caddyfile` |
| `docker_prune` | Boştaki docker imaj katmanlarını temizle | Evet | 120s | `docker image prune -f` |
| `restart_all` | Tüm servisleri güvenle yeniden başlat | Evet | 600s | `docker compose ... up -d --no-deps --force-recreate caddy backend gateway` *(DB hariç)* |
| `deploy_pull` | origin/main'den son commit'i çek | Evet | 300s | `git pull --ff-only origin main` |
| `deploy_build` | İmajları derle | Evet | 1800s | `docker compose ... build backend gateway caddy` |
| `deploy_full` | Tam Dağıtım (Pull + Build + Restart) | Evet | 1800s | Sıralı 3 adım: pull -> build -> restart |
| `git_status` | Sunucu git durumunu oku | Hayır | 30s | `git status --porcelain -b` |

---

## 6. LOG İZLEME VE TEMİZLEME MEKANİZMASI

### Logların Okunması (`_tail_json_log`)
1. Konteyner log yolu `docker inspect <container> --format {{.LogPath}}` ile hosttan alınır (Örn: `/var/lib/docker/containers/<id>/<id>-json.log`).
2. Log dosyasının tamamı belleğe okunmaz; dosya sonundan geriye doğru `fh.seek(size - window)` yapılarak 256 KB, 1 MB, 4 MB'lık pencerelerle okunur.
3. Her satır bir Docker JSON kaydıdır (`{"log": "...", "stream": "stdout", "time": "..."}`). İçerideki `log` alanı çıkarılır, satırlara bölünür ve son `tail` adet satır döner.

### Log Seviyelerinin Tespiti (`logLevel.ts` / `_classify_log_level`)
Panel, farklı log formatlarını otomatik olarak tanır:
- **Pino (WhatsApp Gateway):** Sayısal seviyeler (`10/20`: DEBUG, `30`: INFO, `40`: WARN, `50/60`: ERROR).
- **Caddy:** JSON formatındaki `"level": "error" | "warn" | "info"`.
- **Python / Uvicorn:** `[ERROR]`, `ERROR:`, `WARNING:`, `INFO:`.
- **PostgreSQL:** `ERROR:`, `FATAL:`, `PANIC:`, `LOG:`.

---

## 7. YENİ BİR ÖZELLİK VEYA GÜNCELLEME EKLERKEN GELİŞTİRİCİ KONTROL LİSTESİ

Gelecekte bu panele güncelleme yapacak ChatGPT veya mühendisin izlemesi gereken adımlar:

### Durum A: Yeni Bir Sunucu Operasyonu Eklemek İsterseniz
1. `backend/app/services/admin/ops_service.py` dosyasına gidin.
2. `OPERATIONS` sözlüğüne yeni `OperationSpec` ekleyin:
   - Asla kullanıcı girdisi almayın.
   - Sabit `List[str]` argüman listesi tanımlayın.
   - `destructive=True/False` bayrağını ve `cooldown` süresini belirleyin.
3. `backend/app/schemas/ops.py` şemalarını gerekiyorsa güncelleyin.
4. `frontend/src/locales/tr.ts` ve `frontend/src/locales/en.ts` dosyalarına operasyon etiketini ekleyin.
5. `npm --prefix frontend run test` veya ilgili doğrulama scriptini çalıştırın.

### Durum B: Yeni Bir Admin Sekmesi / Sayfası Eklemek İsterseniz
1. `backend/app/api/v1/endpoints/admin.py` içine yeni salt-okunur endpoint ekleyin (`require_admin` korumalı).
2. `backend/app/services/admin/<yeni_servis>.py` servisini yazın.
3. `frontend/src/types/admin.ts` içine DTO arayüzünü tanımlayın.
4. `frontend/src/api/admin.ts` içine `AdminApi.getNewSection()` metodunu ekleyin.
5. `frontend/src/pages/admin/AdminNewPage.tsx` sayfasını oluşturun (`AdminShell` bileşenini sarmalayacak şekilde).
6. `frontend/src/App.tsx` içinde `VALID_TABS` setine, tab switch-case'ine ve `Sidebar.tsx` menüsüne ekleyin.
7. Hem Türkçe hem İngilizce dil dosyalarına (`tr.ts`, `en.ts`) başlık ve metinleri senkronize ekleyin.

### Kesinlikle Yapılmaması Gerekenler (Don'ts)
❌ `psql` veya shell injection riskine yol açacak `f"docker exec {input}"` gibi string interpolation'lar yazmayın.  
❌ `tezlify-db` konteynerini restart listesine eklemeyin.  
❌ Log temizlemede `os.remove(path)` veya dosya silme yapmayın (mutlaka `truncate` kullanın).  
❌ Admin rotalarına `require_admin` koymayı unutmayın.  
❌ Hardcoded Türkçe veya İngilizce string JSX içine yazmayın; daima `useI18n()` / `t('...')` kullanın.  

---

> Bu belge, Tezlify projesinin `docs/ADMIN_OPERATIONS_CENTER_GUIDE.md` dosyasında kalıcı olarak saklanmaktadır. Gelecekte ChatGPT veya herhangi bir yapay zekaya *"Tezlify yönetim panelinde güncelleme yapacağız, bu kılavuzu baz al"* diyerek bu dosyayı doğrudan bağlam (context) olarak iletebilirsiniz.
