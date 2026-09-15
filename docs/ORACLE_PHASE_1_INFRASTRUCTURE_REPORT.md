# TEZLIFY ORACLE CLOUD MIGRATION: PHASE 1 INFRASTRUCTURE REPORT
## OCI Frankfurt Always Free Altyapı ve Sunucu Kurulum Raporu

**Rapor Tarihi:** 2026-09-15 15:16:00 (UTC+3)  
**Yürüten Rol:** Architecture Lead + Cloud Migration Architect + SRE + DevOps  
**Durum:** **BAŞARIYLA TAMAMLANDI (SUCCESS)**  
**Canlı Üretim Etkisi:** **SIFIR (Render, Vercel, Supabase ve WhatsApp Canlı Ortamı Aynen Korunmaktadır)**

---

## 1. OCI Account & Region
- **Tenancy:** `isatezcan444`
- **Bölge (Region):** `eu-frankfurt-1` (Frankfurt, Almanya)
- **Kullanılabilirlik Alanı (AD):** `dbef:EU-FRANKFURT-1-AD-1`
- **Hesap Durumu:** Doğrulandı, temiz tenancy.

---

## 2. Quota & Always Free Uyumluluk Denetimi
Canlı OCI Limits API denetim sonuçları:

| Kaynak | Kullanılan | Kalan | Always Free Üst Sınırı | Maliyet Durumu |
|---|---|---|---|---|
| **A1 OCPU** | **4 OCPU** | 37 OCPU | **4 OCPU** | **$0.00 (Tam Sınırda - Always Free)** |
| **A1 RAM** | **24 GB** | 253 GB | **24 GB** | **$0.00 (Tam Sınırda - Always Free)** |
| **Blok / Boot Depolama** | **100 GB** | 100 GB | **200 GB** | **$0.00 (Always Free Dahilinde)** |
| **Rezerve Statik IPv4** | **1 IP** | 5 IP | **1 IP** | **$0.00 (Always Free Dahilinde)** |
| **VCN Sayısı** | **1 VCN** | 49 VCN | 50 VCN | **$0.00 (Ücretsiz)** |
| **Toplam Ücretli Kaynak** | **0 Adet** | - | - | **$0.00 (KESİNLİKLE ÜCRETSİZ)** |

---

## 3. OCI Ağ Altyapısı (Virtual Cloud Network)

### 3.1 VCN
- **Adı:** `tezlify-vcn`
- **OCID:** `ocid1.vcn.oc1.eu-frankfurt-1.amaaaaaazhfthiia4eyn3fwiakjymjtcqua5i2sdn7tjq4dtht6d4udtrjoq`
- **IPv4 CIDR:** `10.0.0.0/16`
- **DNS Etiketi:** `tezlifyvcn`
- **Durum:** `AVAILABLE`

### 3.2 Internet Gateway
- **Adı:** `tezlify-igw`
- **OCID:** `ocid1.internetgateway.oc1.eu-frankfurt-1.aaaaaaaaqaevvdiz5ylztp426gs2s6qvntmn27ujr53vwq3itj23xyclwt5q`
- **Durum:** `AVAILABLE`

### 3.3 Route Table
- **Adı:** `tezlify-public-rt`
- **OCID:** `ocid1.routetable.oc1.eu-frankfurt-1.aaaaaaaah6i36tmh2vo2eh2be46l6jf4cfzszbzo6eb4vugvjpztgvufn3bq`
- **Kural:** `0.0.0.0/0` -> `tezlify-igw`
- **Durum:** `AVAILABLE`

### 3.4 Güvenlik Listesi (Security List)
- **Adı:** `tezlify-security-list`
- **OCID:** `ocid1.securitylist.oc1.eu-frankfurt-1.aaaaaaaahhgynllppp7vzuqnnutt2vqbxphfc67oahznln7tgfhdryhzzduq`
- **Giriş Kuralları (Ingress):**
  - Port 22/tcp (SSH): `0.0.0.0/0` (Yalnızca SSH Key ile korunur)
  - Port 80/tcp (HTTP): `0.0.0.0/0` (ACME / Let's Encrypt için)
  - Port 443/tcp (HTTPS): `0.0.0.0/0` (REST API & WebSocket için)
  - **Port 8000, 8787, 5432, 6543: KESİNLİKLE KAPALI (Dropping packets)**
- **Çıkış Kuralları (Egress):** `0.0.0.0/0` (Tüm portlar serbest)
- **Durum:** `AVAILABLE`

### 3.5 Regional Public Subnet
- **Adı:** `tezlify-public-subnet`
- **OCID:** `ocid1.subnet.oc1.eu-frankfurt-1.aaaaaaaaojgvney3dfrpdnm4wtbm3iywcjn3orxm35m4n2au3we2dptkihfq`
- **CIDR:** `10.0.1.0/24`
- **DNS Etiketi:** `public`
- **Durum:** `AVAILABLE`

---

## 4. Statik Rezerve Public IP
- **Adı:** `tezlify-oracle-reserved-ip`
- **OCID:** `ocid1.publicip.oc1.eu-frankfurt-1.amaaaaaazhfthiiafbctn5dpnolq7a2zg7yagdenzmjcmlkxzsc4g5nz62na`
- **Statik IPv4:** `130.162.247.20`
- **Bağlı Özel IP:** `10.0.1.204` (Primary VNIC: `tezlify-primary-vnic`)
- **Özellik:** Sunucu yeniden başlasa dahi IP adresi **asla değişmez**.

---

## 5. Compute Instance (VM.Standard.A1.Flex)
- **Sunucu Adı:** `tezlify-oracle`
- **OCID:** `ocid1.instance.oc1.eu-frankfurt-1.antheljtzhfthiicm3e2y7hslvnc65afnkpknawogwctisk5yyv3b2jbxo2a`
- **İşlemci (OCPU):** 4 OCPU (4 Cores / 4 Threads ARM Neoverse-N1)
- **Bellek (RAM):** 24 GB RAM
- **İşletim Sistemi:** Canonical Ubuntu 24.04 LTS (Kernel: `6.17.0-1020-oracle aarch64`)
- **Özel IP:** `10.0.1.204`
- **Genel IP:** `130.162.247.20`
- **SSH Kimlik Doğrulama:** Yalnızca ED25519 Public Key (`~/.ssh/id_tezlify_oracle.pub`)
- **Durum:** `RUNNING`

---

## 6. Depolama (Storage Verification)
- **Disk:** `/dev/sda1` (100 GB Boot Volume, OCI Balanced Block Storage 10 VPUs/GB)
- **Kullanım:**
  ```text
  Filesystem      Size  Used Avail Use% Mounted on
  /dev/sda1        96G  2.7G   94G   3% /
  ```
- **Kalan Boş Alan:** **94 GB** (Kalıcı Docker volumeleri ve loglar için tamamen hazır).

---

## 7. ARM64 (aarch64) & Docker Doğrulaması
- **Docker Sürümü:** Docker CE 29.8.0 / Docker Compose v5.5.1 (Official Docker noble arm64 repository)
- **ARM64 Çalışma Testi:**
  ```bash
  sudo docker run --rm arm64v8/alpine uname -m
  # Çıktı: aarch64
  ```
- Docker daemon ve systemd entegrasyonu başarıyla devreye alınmıştır.

---

## 8. Sunucu Güvenlik Sıkılaştırması (Hardening)
1. **UFW Güvenlik Duvarı:**
   - Varsayılan Giriş: `DENY`
   - Varsayılan Çıkış: `ALLOW`
   - İzin Verilen: `22/tcp`, `80/tcp`, `443/tcp`
2. **SSH Sıkılaştırması (`/etc/ssh/sshd_config.d/99-hardening.conf`):**
   - `PasswordAuthentication no` (Şifreli oturum açma kapatıldı)
   - `PermitRootLogin prohibit-password` (Root şifresiyle giriş kapatıldı)
   - `X11Forwarding no`
   - `MaxAuthTries 4`

---

## 9. Dış Dünya Port Doğrulama Testi (Local Machine -> Oracle VM)
Geliştirici bilgisayarından (TR) `130.162.247.20` hedefine yapılan canlı socket denetimleri:

| Port | Servis | Dış Dünyadan Durum | RTT Gecikmesi | Güvenlik Uygunluğu |
|---|---|---|---|---|
| **Port 22** | SSH | **OPEN / REACHABLE** | **43.9 ms** | **UYGUN (Key-Only)** |
| **Port 80** | HTTP | **REFUSED (Firewall açık, Caddy bekliyor)** | **39.3 ms** | **UYGUN** |
| **Port 443** | HTTPS | **REFUSED (Firewall açık, Caddy bekliyor)** | **38.0 ms** | **UYGUN** |
| **Port 8000** | FastAPI | **BLOCKED / FILTERED (Timeout)** | `> 2500 ms` | **MÜKEMMEL (İç Ağda İzole)** |
| **Port 8787** | Gateway | **BLOCKED / FILTERED (Timeout)** | `> 2500 ms` | **MÜKEMMEL (İç Ağda İzole)** |
| **Port 5432** | DB Direct | **BLOCKED / FILTERED (Timeout)** | `> 2500 ms` | **MÜKEMMEL (Kapalı)** |
| **Port 6543** | DB Pooler | **BLOCKED / FILTERED (Timeout)** | `> 2500 ms` | **MÜKEMMEL (Kapalı)** |

---

## 10. Dış Ağ ve Supabase Tokyo Bağlantı Testi (Oracle VM -> Internet)
Sunucu içinden yapılan çıkış testleri:

- **GitHub:** 200 OK (56 ms)
- **PyPI:** 200 OK (48 ms)
- **npm Registry:** 200 OK (48 ms)
- **Vercel Frontend (`tezlify-woad.vercel.app`):** 200 OK (67 ms)
- **Supabase Tokyo Transaction Pooler (`aws-0-ap-northeast-1.pooler.supabase.com:6543`):**
  - DNS Çözümlemesi: `52.68.3.1`, `54.64.190.72`, `35.79.125.133` (IPv4)
  - TCP Bağlantı Başarısı: **5/5 (%100 Başarı, Sıfır Timeout)**
  - Ölçülen TCP Connect Gecikmesi:
    - Min: **231.06 ms**
    - Max: **237.91 ms**
    - Ortalama: **235.03 ms**
    *(Render'ın doğrudan bağlantısındaki 10 saniyelik IPv6 timeout'u tamamen yok edilmiştir).*

---

## 11. Kaynak Tüketim Baseline (Idle)
- **İşlemci Yükü:** Load average: `0.13` (Sıfıra yakın boşta).
- **Bellek (RAM):** 23 GiB toplam / **21 GiB tamamen boş**.
- **Disk:** 96 GB / **94 GB tamamen boş**.

---

## 12. Çalışma Dizini
- `/opt/tezlify` dizini oluşturuldu, mülkiyeti `ubuntu:ubuntu` kullanıcısına verildi.
- Kod tabanı `https://github.com/isatezcan444/Tezlify.git` (commit `29fcc93`) çekildi.
- **Canlı Ortam Kuralı:** Hiçbir canlı secret veya container başlatılmamıştır.

---

## 13. Phase 1 Çıkış Kriterleri (Exit Criteria)

| Kriter | Hedef | Gerçekleşen | Sonuç |
|---|---|---|---|
| VCN ve Subnet Açıldı mı? | `tezlify-vcn` / `tezlify-public-subnet` | Oluşturuldu ve aktif | **BAŞARILI** |
| Statik Rezerve IP Atandı mı? | Değişmeyen Public IPv4 | `130.162.247.20` bağlandı | **BAŞARILI** |
| A1 Flex VM Aktif mi? | 4 OCPU / 24 GB RAM | Ubuntu 24.04 ARM64 çalışıyor | **BAŞARILI** |
| SSH Key-Only Çalışıyor mu? | Şifresiz, anahtar tabanlı | ED25519 doğrulandı | **BAŞARILI** |
| Docker ARM64 Doğrulandı mı? | `aarch64` container testi | Başarıyla koşuldu | **BAŞARILI** |
| Güvenlik Portları Doğru mu? | 8000/8787 kapalı, 80/443 açık | Socket testleriyle kanıtlandı | **BAŞARILI** |
| Supabase Pooler Bağlanıyor mu?| Port 6543 TCP erişimi | 235 ms ortalama ile 5/5 bağlandı | **BAŞARILI** |
| Maliyet Sıfır mı? | $0 Always Free | 4 OCPU, 24GB RAM, 100GB Disk ($0) | **BAŞARILI** |
| Canlı Ortam Korundu mu? | Render / Vercel / DB dokunulmadı | Sıfır müdahale | **BAŞARILI** |

---

## 14. Sonraki Adım İçin Bekleme

Phase 1 (Altyapı, Ağ, Sanal Makine, Docker ve Güvenlik Hazırlığı) %100 başarıyla tamamlanmıştır.

Kural gereği burada **DURULMUŞTUR**.  
Onayınızla birlikte **PHASE 2 (Staging Docker Stack Dağıtımı: Caddyfile, Backend & Gateway Konteynerlerinin ayağa kaldırılması ve izole testler)** adımına geçilebilir.
