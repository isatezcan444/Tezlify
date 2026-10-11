# TEZLIFY — DEPLOYMENT MİMARİSİ VE STAGING İZOLASYON DENETİMİ (PHASE A.2)

- **Tarih:** 2026-10-11
- **Denetim Referans Commit:** `a1d3f24b855b22e9ecb56a8bb6a330914adabf96`
- **Hedef:** Mevcut deployment akışının analizi, production-staging izolasyon açıklarının belirlenmesi ve güvenli staging altyapı gereksinimlerinin saptanması.
- **Kural:** Bu denetim salt-okunur (read-only) yapılmıştır. Canlı sunucuya (`130.162.247.20`) hiçbir deploy, restart veya komut gönderilmemiştir.

---

## 1. Git ve Çalışma Ağacı Durumu

- `git branch --show-current`: `main`
- `git rev-parse HEAD`: `a1d3f24b855b22e9ecb56a8bb6a330914adabf96`
- `git rev-parse origin/main`: `a1d3f24b855b22e9ecb56a8bb6a330914adabf96`
- `git status --short`: Temiz (untracked/uncommitted dosya yok).

---

## 2. Mevcut Production Deployment Mimarisi Haritası

Mevcut sistemde CI/CD aracı (GitHub Actions vb.) bulunmamaktadır. Tüm dağıtım operatörün yerel makinesinden `scripts/deploy/release.sh` betiği üzerinden yönetilmektedir:

```
[Geliştirici / Operatör Makinesi]
       │
       │  1. Hermetik Vite build (yerel tarball üretimi)
       │  2. scp /tmp/tezlify-frontend-<sha>.tgz -> 130.162.247.20:/tmp/
       │  3. ssh ubuntu@130.162.247.20 "bash /opt/tezlify/scripts/deploy/host-release.sh <sha>"
       ▼
[Production Sunucusu (130.162.247.20)]
       │
       ├── /opt/tezlify (Git checkout, docker-compose.prod.yml, .env.production)
       ├── Docker Daemon (/var/run/docker.sock)
       │     ├── tezlify-caddy (Port 80/443, /etc/caddy/Caddyfile)
       │     ├── tezlify-backend (Port 8000 dahili, /var/run/docker.sock mount'lu)
       │     ├── tezlify-gateway (Port 8787 dahili, Baileys motoru)
       │     └── tezlify-db (PostgreSQL 17, tezlify-internal bridge ağında)
       └── Docker Volumes:
             ├── caddy_data, caddy_config
             ├── whatsapp_sessions (Hat 1 / Session 180 şifreli auth dosyaları)
             └── whatsapp_media (Medya ekleri)
```

### Detaylı Bileşen Envanteri:

| Bileşen | Mevcut Production Yapılandırması | Çakışma / İzolasyon Riski |
| :--- | :--- | :--- |
| **Hedef Host** | `HOST="ubuntu@130.162.247.20"` (`release.sh:19`) | Sabit IP. Ortam parametresi yok. `release.sh` çalıştırıldığında **doğrudan canlı sisteme** gider. |
| **SSH Anahtarı** | `~/.ssh/id_tezlify_oracle` | Yalnızca production sunucusuna yetkili olabilir veya staging'e de erişebilir (ayrılmalı). |
| **Proje Dizini** | `/opt/tezlify` (`host-release.sh:38`) | Sunucu üstünde sabit yol. Staging aynı sunucuya konursa path collision oluşur. |
| **Compose Dosyası** | `/opt/tezlify/docker-compose.prod.yml` | Sabit servis ve konteyner isimleri içerir. |
| **Konteyner İsimleri** | `tezlify-caddy`, `tezlify-backend`, `tezlify-gateway`, `tezlify-db` | Standart isimler; aynı Docker daemon üzerinde çift çalıştırılamaz. |
| **Docker Ağı** | `tezlify_tezlify-internal` (172.29.0.0/16) | Sabit subnet. Başka bir projeyle subnet çakışması üretir. |
| **Volume İsimleri** | `whatsapp_sessions`, `whatsapp_media`, `caddy_data`, `caddy_config` | Varsayılan volume'ler. Staging'e bağlanırsa canlı WhatsApp oturumu bozulur. |
| **Env Dosyası** | `.env.production` | Canlı JWT secret, canlı WhatsApp şifreleme anahtarları, canlı DB şifreleri. |
| **Veritabanı** | `postgresql+asyncpg://...:5432/tezlify` (`tezlify-db`) | Tek canlı veritabanı. Staging bağlanırsa müşteri verisi kirlenir/ezilir. |
| **Caddy Alan Adları** | `app.130.162.247.20.sslip.io`, `api.130.162.247.20.sslip.io` | Sabit production domainleri. |

---

## 3. İzolasyon Tehditleri ve Çapraz Bulaşma Riskleri (Forensic Threat Model)

1. **Hedef Çakışması (Accidental Target Collision):**
   - Mevcut `release.sh` hedef ortam seçeneği sunmaz. Operatör `bash scripts/deploy/release.sh` yazdığı anda hedef **130.162.247.20** olur.
2. **WhatsApp Oturumunun Sabotajı (Session Hijack & Banning):**
   - WhatsApp Baileys protokolü tekil bir soket bağlantısı gerektirir. Staging ortamı aynı `whatsapp_sessions` volume'ünü veya aynı WhatsApp numarasını bağlamaya kalkarsa:
     - Canlı oturum derhal kopar (`440 connection replaced` veya `401 logged out`).
     - Meta anti-spam algoritmaları aynı anda iki farklı IP'den el sıkışan hesabı kalıcı olarak banlar (`banned`).
3. **Müşteri Verisi ve Gizlilik İhlali (Database Contamination):**
   - Staging ortamının canlı PostgreSQL servisine (`tezlify-db`) veya canlı backup dump'larına bağlanması KVKK/GDPR ve veri güvenliği ihlalidir.
4. **Docker Daemon Yetki Sıçraması (Socket Privilege Escalation):**
   - `tezlify-backend`, Operasyon Merkezi panelinden restart yapabilmek için `/var/run/docker.sock` mount etmektedir. Staging backend'i production Docker socket'ine erişirse, staging operatörü production servislerini yeniden başlatabilir veya silebilir.

---

## 4. Gerekli İzolasyon İlkeleri

Staging ortamının güvenle var olabilmesi için aşağıdaki "Sıfır Çakışma" (Zero-Collision) garantileri zorunludur:

1. **Ayrı Host / VM:** Staging kesinlikle `130.162.247.20` üzerinde değil, ayrı bir staging IP/sunucusunda barınmalıdır.
2. **Ayrı Docker Namespace:** Farklı Docker daemon ve farklı compose proje adı (`tezlify-staging`).
3. **Ayrı ve Boş Veritabanı:** Canlı veriden tamamen arındırılmış, bağımsız bir staging PostgreSQL instance'ı.
4. **Devre Dışı / Mock WhatsApp:** Staging'de `WHATSAPP_AUTO_RESTORE="false"` olmalı; gerçek hat bağlanmamalı, sahte gateway modu veya mock test hattı kullanılmalıdır.
5. **Fail-Closed Dağıtım Koruması:** Dağıtım aracı, staging hedefi verildiğinde host'un production IP'si olmadığını, env dosyasının production olmadığını ve veritabanı adresinin canlı sistem olmadığını doğrulamadan tek bir bayt dahi göndermemelidir.
