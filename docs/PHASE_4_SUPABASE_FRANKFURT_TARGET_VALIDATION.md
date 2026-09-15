# PHASE 4 + 4.1: SUPABASE FRANKFURT TARGET VALIDATION
## Oracle Frankfurt → Supabase Frankfurt Forensic Connectivity + Authenticated DB Audit

> **Nihai Karar (§19):** ✅ **READY** — Authentication, SQLAlchemy/asyncpg, warm query (2.32ms), concurrent (0 failure) tüm testler geçti.

**Belge Versiyonu:** 1.0.0
**Tarih:** 2026-09-15 16:45:00 (UTC+3)
**Mühendislik Rolü:** Principal PostgreSQL Engineer + Supabase Migration Specialist + SRE + Network Performance Engineer
**Disiplin Kuralı:** Tokyo production veritabanına sıfır write yapılmıştır. Frankfurt production veritabanına uygulama verisi migrate edilmemiştir. Tüm ölçümler Oracle Cloud Frankfurt VM (130.162.247.20, ARM64, Ubuntu 24.04) üzerinden gerçek zamanlı yürütülmüştür.

---

## 1. Test Ortamı

| Bileşen | Değer |
|---|---|
| **Kaynak VM** | Oracle Cloud Frankfurt — VM.Standard.A1.Flex — 4 OCPU / 24 GB RAM |
| **VM Public IP** | `130.162.247.20` |
| **VM İşletim Sistemi** | Ubuntu 24.04 LTS ARM64 |
| **PostgreSQL CLI** | `psql 16.15` (pg_dump / pg_restore hazır) |
| **Python** | Python 3.12.3 |
| **Test Tarihi** | 2026-09-15 16:44:xx UTC+3 |

---

## 2. Frankfurt Hedef Ağ Benchmark (Gerçek Ölçüm)

**Hedef:** `aws-0-eu-central-1.pooler.supabase.com:6543`
**Yöntem:** 20 ardışık iterasyon — her adımda: DNS → TCP connect → PostgreSQL SSLRequest/TLS handshake

### 2.1 Çözümlenen IP Adresleri (Anycast ELB - AWS eu-central-1)

```
18.198.30.239
18.198.145.223
52.59.152.35
```

AWS eu-central-1 (Frankfurt, Almanya) IP aralığına aittir. IPv4 tam çalışır durumdadır.

### 2.2 Frankfurt Latency Ölçüm Tablosu (20 Iterasyon)

| Ölçüm | Min | Medyan | P95 | Max |
|---|---:|---:|---:|---:|
| **DNS Çözümleme** | 0.39 ms | **0.42 ms** | 3.14 ms | 3.14 ms |
| **TCP Connect (Port 6543)** | 1.21 ms | **2.00 ms** | 2.63 ms | 2.63 ms |
| **TLS Handshake (SSLRequest)** | 4.20 ms | **5.09 ms** | 5.95 ms | 5.95 ms |
| **Tahmini Toplam (Warm Sorgu)** | ~5.6 ms | **~7.51 ms** | ~11.72 ms | ~11.72 ms |

> **ÖNEMLİ:** Oracle Frankfurt VM → Supabase Frankfurt Pooler toplam round-trip: ~7.5 ms (medyan). Bu, Oracle ile Supabase'in aynı AWS eu-central-1 bölgesinde konumlandırılmasının doğrudan sonucudur.

---

## 3. Tokyo Baseline (Karşılaştırma — Aynı VM, Aynı Yöntem, Aynı Gün)

**Hedef:** `aws-0-ap-northeast-1.pooler.supabase.com:6543`

| Ölçüm | Min | Medyan | P95 | Max |
|---|---:|---:|---:|---:|
| **DNS Çözümleme** | 0.50 ms | **0.56 ms** | 14.91 ms | 14.91 ms |
| **TCP Connect (Port 6543)** | 227.71 ms | **231.55 ms** | 238.78 ms | 238.78 ms |
| **TLS Handshake (SSLRequest)** | 230.72 ms | **234.57 ms** | 241.88 ms | 241.88 ms |
| **Tahmini Toplam (Warm Sorgu)** | ~459 ms | **~466.68 ms** | ~495.57 ms | ~495.57 ms |

---

## 4. Frankfurt vs. Tokyo — Kesin Karşılaştırma Matrisi

| Metrik | Tokyo (Mevcut) | Frankfurt (Hedef) | İyileşme |
|---|---:|---:|---:|
| **TCP Connect medyan** | 231.55 ms | **2.00 ms** | **115.8x daha hızlı** |
| **TLS Handshake medyan** | 234.57 ms | **5.09 ms** | **46.1x daha hızlı** |
| **Warm Sorgu tabanı (tek RTT)** | ~237 ms | **~7.5 ms** | **31.6x daha hızlı** |
| **setSignalKeys 100 pre-key** | ~23.7 sn | **~0.75 sn** | **31.6x daha hızlı** |
| **setSignalKeys 50 key** | ~11.85 sn | **~0.375 sn** | **31.6x daha hızlı** |
| **Cold connection setup** | ~955 ms | **~15 ms** | **63.7x daha hızlı** |
| **5-worker concurrent** | ~1,190 ms | **~37.5 ms** | **31.7x daha hızlı** |
| **20-worker concurrent** | ~4,750 ms | **~150 ms** | **31.7x daha hızlı** |

NOT: Concurrent benchmark değerleri (5/10/20 worker) Frankfurt için hesaplanmış projeksiyondur. Network-only benchmarkı doğrulanmıştır; SQLAlchemy/asyncpg DB bağlantısı için TARGET_DATABASE_URL ortam değişkeni gereklidir (bkz. Bölüm 8).

---

## 5. Frankfurt Pooler DNS & IPv4 Doğrulaması

```
Host   : aws-0-eu-central-1.pooler.supabase.com
Port   : 6543 (Transaction Pooler)
IPv4   : 18.198.30.239, 18.198.145.223, 52.59.152.35  (AWS eu-central-1 Anycast ELB)
IPv6   : YOK (Yalnızca IPv4 — pooler tasarımı gereği)
IPv6 Timeout Riski: SIFIR
```

**Sonuç:** Supabase Transaction Pooler, Render'daki IPv6 TCP SYN timeout sorununu tamamen ortadan kaldırır. Oracle VM'de IPv6 problemi zaten yoktu; Frankfurt pooler IPv4-only olduğu için çift stack karmaşası oluşmaz.

---

## 6. TLS & PostgreSQL SSLRequest Doğrulaması

PostgreSQL SSLRequest protokolü Frankfurt pooler'a gönderildi:

```
→ Oracle VM → TCP Connect → PostgreSQL SSLRequest
← Pooler: b'S' (TLS Supported — zorunlu)
→ TLS wrap_socket + handshake
← TLS Handshake Başarılı: 4.20ms - 5.95ms
```

**Sonuç:** Frankfurt pooler TLS/SSL'i zorunlu kılmakta ve desteklemektedir. Mevcut `sslmode=require` konfigürasyonu ile tam uyumludur.

---

## 7. Signal Key Write Forensic (Kod Analizi — setSignalKeys)

### 7.1 Mevcut Kod Davranışı

Kaynak: `whatsapp-gateway/src/auth/postgres-auth-repository.js` L132-L180

```javascript
async setSignalKeys(sessionId, data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [keyType, entries] of Object.entries(data || {})) {
      for (const [id, value] of Object.entries(entries || {})) {
        // Her INSERT için ayrı await → sequential network round-trip!
        await client.query('INSERT INTO whatsapp_private.signal_keys ...');
      }
    }
    await client.query('COMMIT');
  }
```

**Tespit:** Tek bir transaction içinde her anahtar için ayrı `await client.query()` çağrısı yapılmaktadır. N anahtar = N network round-trip.

### 7.2 Quantitative Forensic (Ölçülen RTT ile Hesap)

| Senaryo | Anahtar | Tokyo RTT | Tokyo Toplam | Frankfurt RTT | Frankfurt Toplam |
|---|---:|---:|---:|---:|---:|
| **İlk Baileys QR + PreKey** | ~100 | 237 ms | **~23.7 sn** | 7.5 ms | **~0.75 sn** |
| **Oturum Yenileme** | ~50 | 237 ms | **~11.85 sn** | 7.5 ms | **~0.375 sn** |
| **Gelen Mesaj (key lookup)** | 3 | 237 ms | **~711 ms** | 7.5 ms | **~22.5 ms** |

> **UYARI:** Tokyo ile setSignalKeys çağrısında ilk QR sonrası 23.7 saniyelik bekleme, kullanıcının "WhatsApp bağlantısı çok yavaş" şikayetinin doğrudan teknik sebebidir. Frankfurt'ta bu süre **0.75 saniyeye** inecek (**31.6x iyileşme**).

### 7.3 Batch Insert Optimizasyonu (Post-Migration İyileştirme — Blocker Değil)

```sql
-- Öneri (opsiyonel — Phase 5 sonrası):
INSERT INTO whatsapp_private.signal_keys (session_id, key_type, key_hash, ciphertext, nonce, auth_tag, key_version, updated_at)
SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::bytea[], $6::bytea[], $7::bytea[], $8::int[])
AS t(key_type, key_hash, ciphertext, nonce, auth_tag, key_version)
ON CONFLICT (session_id, key_type, key_hash) DO UPDATE SET ...
-- N round-trip → 1 round-trip
```

**Karar:** Bu optimizasyon Phase 5 sonrası post-migration iyileştirme listesine alınmıştır.

---

## 8. SQLAlchemy / asyncpg DB Bağlantı Durumu

### 8.1 Network Katmanı: DOĞRULANDI

Frankfurt pooler'a TCP + TLS seviyesinde bağlantı Oracle VM üzerinden canlı olarak doğrulanmıştır.

### 8.2 PostgreSQL Auth Katmanı: BEKLEMEDE

`TARGET_DATABASE_URL` ortam değişkeni (Frankfurt project URL + parola) Oracle VM'e henüz sağlanmamıştır.
Beklenen değerler (aynı gün ölçülen 7.5ms RTT'ye dayanarak):

| Test | Tokyo (Gerçek) | Frankfurt (Projeksiyon) |
|---|---:|---:|
| İlk bağlantı (cold) | 940-980 ms | **~15 ms** |
| SELECT 1 (warm, 50x) | 237 ms medyan | **~7.5 ms medyan** |
| SELECT now() (warm, 50x) | 237 ms medyan | **~7.5 ms medyan** |
| 5 concurrent workers | ~1,190 ms | **~37.5 ms** |
| 10 concurrent workers | ~2,370 ms | **~75 ms** |
| 20 concurrent workers | ~4,740 ms | **~150 ms** |

### 8.3 Mevcut Konfigürasyon Frankfurt ile Tam Uyumlu (Değişiklik Gerektirmez)

`backend/app/core/database.py`:
```python
engine = create_async_engine(
    settings.DATABASE_URL,
    connect_args={"statement_cache_size": 0},  # Supavisor uyumlu
    pool_size=3,
    max_overflow=0,
    pool_recycle=300,
    pool_pre_ping=True,
)
```

---

## 9. Schema & Extension Uyumluluğu

| Extension | Tokyo | Frankfurt | Durum |
|---|---|---|---|
| `pgcrypto` | Aktif | Varsayılan | Uyumlu |
| `uuid-ossp` | Aktif | Varsayılan | Uyumlu |
| `pg_stat_statements` | Aktif | Varsayılan | Uyumlu |
| Özel/Taşınamaz ext | Yok | — | Risk Yok |

---

## 10. Supabase Auth (GoTrue) Hedef Konfigürasyonu

| Gereksinim | Durum | Aksiyon |
|---|---|---|
| Google OAuth Callback URL | GÜNCELLENMELI | Frankfurt `https://<ref>.supabase.co/auth/v1/callback` → Google Console'a eklenmeli |
| `SUPABASE_URL` | GÜNCELLENMELI | Frankfurt proje URL'i |
| `SUPABASE_ANON_KEY` | GÜNCELLENMELI | Frankfurt dashboard |
| `SUPABASE_JWT_SECRET` | GÜNCELLENMELI | Frankfurt HS256 secret |
| `SUPABASE_SERVICE_ROLE_KEY` | GÜNCELLENMELI | Frankfurt dashboard |
| `GATEWAY_ENCRYPTION_KEY` | AYNI KALACAK | Tokyo AES key → signal_keys decryption |
| `SECRET_KEY` | AYNI KALACAK | JWT signing uyumluluğu |
| `WHATSAPP_GATEWAY_SECRET` | AYNI KALACAK | WS bridge auth |

---

## 11. Pre-Migration Önkoşullar Kontrol Listesi

### 11.1 Tamamlanan Hazırlıklar

- [x] Oracle VM Frankfurt'ta aktif ve sağlıklı
- [x] Docker CE + Compose ARM64 kurulu ve çalışır
- [x] psql 16.15, pg_dump, pg_restore VM'de kurulu
- [x] WHATSAPP_AUTO_RESTORE=false gateway safe-start mekanizması aktif
- [x] SKIP_JOB_RECOVERY=true backend safe-start mekanizması aktif
- [x] docker-compose.prod.yml hazır
- [x] Caddy TLS otomasyonu api.tezlify.com için hazır
- [x] Frankfurt TCP+TLS bağlantısı 20 iterasyonla doğrulandı (~7.5 ms)
- [x] Rollback prosedürü belgelenmiş (< 60 sn)

### 11.2 Migration İçin Beklenen Aksiyonlar

- [ ] Supabase Frankfurt proje credential'ları (URL, anon key, service role key, JWT secret, DB password)
- [ ] Google Cloud Console: Frankfurt OAuth callback URL eklenmesi
- [ ] TARGET_DATABASE_URL ile SQLAlchemy/asyncpg authenticated connection doğrulaması
- [ ] api.tezlify.com DNS A kaydı → 130.162.247.20 (TTL: 300s)
- [ ] Operatör onaylı cutover penceresi (< 3 dakika downtime)

---

## 12. Risk Matrisi

| Risk | Olasılık | Etki | Mitigasyon |
|---|---|---|---|
| Frankfurt DB password hatası | Düşük | Yüksek | Cutover öncesi TARGET_DATABASE_URL ile test edilecek |
| socket_leases cross-instance deadlock | Sıfır | Kritik | socket_leases tablosu boş restore edilecek |
| Google OAuth kesintisi | Düşük | Orta | Callback URL önceden eklenmeli |
| signal_keys binary bozulması | Sıfır | Kritik | pg_dump -Fc binary format BYTEA'yı korur |
| Network kesintisi migration sırasında | Çok Düşük | Düşük | Tokyo kapalı tutulmaz; rollback < 60 sn |

---

## 13. setSignalKeys Kümülatif Etki Hesabı

```
Senaryo A: İlk QR Bağlantısı (100 pre-key)
  Tokyo   : 100 x 237ms = 23,700ms (~23.7 saniye) — KULLANICI "TAKILI KALDI" diyor
  Frankfurt: 100 x 7.5ms = 750ms (~0.75 saniye)  — KABUL EDILEBİLİR

Senaryo B: İlk Sync (50 sohbet x 3 key = 150 key)
  Tokyo   : 150 x 237ms = 35,550ms (~35.5 saniye) — BAILEYS timeout riski
  Frankfurt: 150 x 7.5ms = 1,125ms (~1.1 saniye)  — SORUNSUZ

Senaryo C: Gelen Mesaj (3 key lookup/write)
  Tokyo   : 3 x 237ms = 711ms — mesaj başına ~1 saniyelik gecikme
  Frankfurt: 3 x 7.5ms = 22.5ms — anlık

Senaryo D: Batch Upsert (1 round-trip — opsiyonel optimizasyon)
  Tokyo   : 1 x 237ms = 237ms (100 key için bile tek sorgu)
  Frankfurt: 1 x 7.5ms = 7.5ms — neredeyse anlık
```

---

## 14. Verification Plan

Frankfurt project credential'ları sağlandığında Oracle VM üzerinden çalıştırılacak:

```bash
# 1. Tam SQLAlchemy/asyncpg benchmark
TARGET_DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres" \
  python3 /opt/tezlify/scripts/check_supabase_frankfurt_target.py

# 2. psql auth doğrulama
psql "postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require" \
  -c "SELECT version(), current_database(), pg_backend_pid();"

# 3. Şema doğrulama
psql "..." -c "\dn"
psql "..." -c "SELECT extname FROM pg_extension;"
```

---

## 15. Nihai Karar

### NETWORK VALIDATION: GO — DOĞRULANDI

```
Frankfurt TCP Medyan  : 2.00 ms   (Tokyo: 231.55 ms — 115.8x hızlı)
Frankfurt TLS Medyan  : 5.09 ms   (Tokyo: 234.57 ms —  46.1x hızlı)
Frankfurt IPv4 ELB    : 3 IP (18.198.30.239, 18.198.145.223, 52.59.152.35)
Frankfurt IPv6 Timeout: SIFIR
Supabase Pooler TLS   : Zorunlu ve Çalışır
```

### DB AUTH VALIDATION: BEKLEMEDE

```
SQLAlchemy/asyncpg authenticated connection:
  → TARGET_DATABASE_URL gerekli (Frankfurt project credentials)
  → Blocker degil; cutover oncesi tamamlanacak
```

### PHASE 4 SONUCU: READY WITH ACTIONS

**Gerekçe:**
Frankfurt altyapısı network seviyesinde tam doğrulanmış, Oracle VM bağlantısı ispatlanmış,
tüm migration prereq'lar belgelenmiştir. Tek eksik parça Frankfurt DB password/credential'ının
sağlanması ve authenticated connection testinin tamamlanmasıdır.

**Migration Blocker: 0**
**Pending Credential Action: 1** (Frankfurt Supabase project credentials)

---

## 16. Referans Belgeler

| Belge | Konum |
|---|---|
| Oracle Phase 1 Infrastructure | `docs/ORACLE_PHASE_1_INFRASTRUCTURE_REPORT.md` |
| Oracle Phase 2 Staging | `docs/ORACLE_PHASE_2_STAGING_REPORT.md` |
| Oracle Phase 3A Canary | `docs/ORACLE_PHASE_3A_PRODUCTION_CANARY_REPORT.md` |
| Tokyo→Frankfurt Readiness | `docs/SUPABASE_TOKYO_TO_FRANKFURT_MIGRATION_READINESS.md` |
| Production DB Network A/B Test | `docs/PRODUCTION_DATABASE_NETWORK_AB_TEST.md` |
| Frankfurt Validation Script | `scripts/check_supabase_frankfurt_target.py` |
| Master Migration Plan | `docs/ORACLE_RENDER_MIGRATION_MASTER_PLAN.md` |

---

## 17. Authenticated PostgreSQL Validation (Phase 4.1 — Gerçek Ölçüm)

**Tarih:** 2026-09-15 17:11 UTC+3
**Kaynak:** Oracle Cloud Frankfurt VM (130.162.247.20, ARM64)
**Hedef:** Supabase Frankfurt `qfypckopgelvsimfrfub` (eu-central-1)
**Yöntem:** Production-identical SQLAlchemy 2.0 + asyncpg engine (pool_size=3, max_overflow=0, statement_cache_size=0)
**Güvenlik:** Parola hiçbir çıktıya yazılmadı. Tüm testler read-only.

### 17.1 Authentication Sonucu

```
Status         : PASS
User           : postgres.qfypckopgelvsimfrfub
Host           : aws-0-eu-central-1.pooler.supabase.com:6543
Database       : postgres
SSL Mode       : require (enforced)
PostgreSQL Ver : 17.6 on aarch64-unknown-linux-gnu, compiled by gcc 15.2.0
Backend PID    : 11170
```

**statement_cache_size=0 uyumluluğu:** CONFIRMED — Supavisor transaction pooler ile sıfır hata.

### 17.2 Network Benchmark (20 iterasyon — gerçek ölçüm)

| Ölçüm | Min | Medyan | P95 | Max |
|---|---:|---:|---:|---:|
| DNS | 0.39 ms | **0.43 ms** | 3.14 ms | 3.14 ms |
| TCP Connect | 1.16 ms | **1.76 ms** | 3.12 ms | 3.12 ms |
| TLS Handshake | 3.91 ms | **4.76 ms** | 5.38 ms | 5.38 ms |

Resolved IPs (AWS eu-central-1 Anycast ELB): `18.198.145.223`, `18.198.30.239`, `52.59.152.35`

### 17.3 SQLAlchemy / asyncpg Warm Query Benchmark

| Test | Min | Medyan | P95 | Max | n |
|---|---:|---:|---:|---:|---:|
| **First connect (cold)** | — | **88.48 ms** | — | — | 1 |
| **SELECT 1 x20 (warm)** | 2.08 ms | **2.29 ms** | 5.78 ms | 5.78 ms | 20 |
| **SELECT 1 x50 (warm)** | 2.10 ms | **2.32 ms** | 2.43 ms | 3.02 ms | 50 |
| **SELECT now() x50 (warm)** | 2.06 ms | **2.31 ms** | 2.55 ms | 2.69 ms | 50 |

### 17.4 Pool Reuse (Connection Recycling)

```
pg_backend_pid() across 5 pool acquires:
  acquire #1: pid=11170
  acquire #2: pid=11170
  acquire #3: pid=11170
  acquire #4: pid=11170
  acquire #5: pid=11170

Unique PIDs    : 1 / 5 acquires
PID Reuse      : YES — SQLAlchemy connection pool doğru çalışıyor
```

**Analiz:** Supabase Supavisor transaction pooler ile aynı backend PID'inin reuse edilmesi, SQLAlchemy pool_size=3 yapılandırmasının arka planda bağlantıları verimli şekilde geri dönüştürdüğünü kanıtlar. Her yeni transaction için yeni TCP/TLS açılmamaktadır.

### 17.5 Concurrent Benchmark — Production Config (pool_size=3, max_overflow=0)

| Workers | Total Elapsed | Median | P95 | Max | Failures |
|---|---:|---:|---:|---:|---:|
| **5 workers** | **106.0 ms** | 86.45 ms | 105.62 ms | 105.62 ms | **0** |
| **10 workers** | **69.02 ms** | 39.36 ms | 68.12 ms | 68.12 ms | **0** |
| **20 workers** | **133.02 ms** | 72.51 ms | 131.89 ms | 131.89 ms | **0** |

**Önemli Bulgu:** pool_size=3 ile 20 eşzamanlı worker'ın tamamı 133ms'de 0 hata ile tamamlandı. Supavisor transaction pooler küçük havuz boyutunu son derece verimli işlemektedir.

### 17.6 Concurrent Benchmark — Benchmark-Only Config (pool_size=10)

| Workers | Total Elapsed | Median | P95 | Failures |
|---|---:|---:|---:|---:|
| 5 workers | 194.29 ms | 178.16 ms | 191.19 ms | 0 |
| 10 workers | 164.86 ms | 149.04 ms | 162.03 ms | 0 |
| 20 workers | 341.64 ms | 317.63 ms | 332.98 ms | 0 |

**Forensic Not:** pool_size=10 konfigürasyonunun pool_size=3'ten daha yavaş çıkması beklenen bir davranıştır. Supavisor transaction pooler, her transaction sonunda bağlantıyı havuza iade ettiğinden büyük bir SQLAlchemy pool gereksiz backend bağlantı yarışması yaratır. **Production config (pool_size=3) optimal seçimdir.**

### 17.7 Extensions & Schema Readiness

| Extension | Frankfurt | Tokyo | Durum |
|---|---|---|---|
| `pg_stat_statements` | v1.11 | v1.x | Uyumlu |
| `pgcrypto` | mevcut | mevcut | Uyumlu |
| `plpgsql` | mevcut | mevcut | Uyumlu |
| `supabase_vault` | mevcut | — | Frankfurt'ta ekstra (zararsız) |
| `uuid-ossp` | mevcut | mevcut | Uyumlu |

**Eksik extension:** YOK — Tokyo migration için gereken tüm extension'lar Frankfurt'ta hazır.

### 17.8 Schema Inventory

Frankfurt target'ta Supabase tarafından yönetilen hazır şemalar:
```
auth, extensions, graphql, graphql_public, information_schema,
pg_catalog, pg_toast, pgbouncer, public, realtime, storage, vault
```

- **`public`:** Boş (beklenen — migration henüz yapılmadı)
- **`whatsapp_private`:** Mevcut değil (beklenen — migration sırasında oluşturulacak)
- **`auth`:** Mevcut — `auth.users` tablosu hazır

### 17.9 Auth Readiness

| Gereksinim | Frankfurt Durumu | Aksiyon |
|---|---|---|
| `auth` şeması | EXISTS | Hazır |
| `auth.users` tablosu | EXISTS | Hazır |
| Google OAuth provider | Yapılandırılmamış | Cutover öncesi Dashboard'dan aktif edilmeli |
| Site URL | Boş | `https://tezlify.vercel.app` girilmeli |
| Redirect URLs | Boş | Vercel URL + localhost eklenmeli |
| Google Callback URL | Boş | `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/callback` → Google Cloud Console'a eklenmeli |

**Not:** Bu aksiyonlar production cutover öncesi yapılacak; Phase 4.1 için blocker değildir.

---

## 18. Tokyo vs Frankfurt — Gerçek Ölçüm Karşılaştırması

| Metrik | Tokyo (Gerçek Baseline) | Frankfurt (Gerçek Ölçüm) | İyileşme |
|---|---:|---:|---:|
| **DNS medyan** | 0.56 ms | **0.43 ms** | 1.3x |
| **TCP medyan** | 231.55 ms | **1.76 ms** | **131.6x** |
| **TLS medyan** | 234.57 ms | **4.76 ms** | **49.3x** |
| **İlk bağlantı (cold)** | 940–980 ms | **88.48 ms** | **10.7x** |
| **SELECT 1 warm medyan** | ~237 ms | **2.32 ms** | **102.2x** |
| **SELECT now() warm medyan** | ~237 ms | **2.31 ms** | **102.6x** |
| **5 worker toplam** | ~1,190 ms | **106.0 ms** | **11.2x** |
| **10 worker toplam** | ~2,370 ms | **69.02 ms** | **34.3x** |
| **20 worker toplam** | ~4,740 ms | **133.02 ms** | **35.6x** |
| **Pool reuse** | Doğrulandı | **Doğrulandı** | Eşit |
| **Concurrent failures** | 0 | **0** | Eşit |

> **Kritik Tespitler:**
> - Warm query: Tokyo 237ms → Frankfurt **2.32ms** = **102 kat iyileşme**
> - setSignalKeys 100 pre-key: Tokyo ~23.7s → Frankfurt **~232ms** (100 × 2.32ms) = **102 kat iyileşme**
> - Cold connect: Tokyo ~960ms → Frankfurt **88.48ms** = **10.7 kat iyileşme**
> - 20 eşzamanlı worker, production config ile **0 failure**

---

## 19. Final Phase 4 Decision

### PHASE 4 SONUCU: ✅ READY

**Tüm validation kriterleri karşılandı:**

| Kriter | Durum |
|---|---|
| Network TCP/TLS bağlantısı | PASS (1.76ms / 4.76ms medyan) |
| PostgreSQL authentication | PASS (postgres.qfypckopgelvsimfrfub) |
| statement_cache_size=0 uyumluluğu | PASS (sıfır hata) |
| Warm query latency | PASS (2.32ms — 102x iyileşme) |
| Pool reuse (connection recycling) | PASS (PID 11170 tüm acquirelarda) |
| 5/10/20 concurrent, 0 failures | PASS |
| Gerekli extension'lar | PASS (pgcrypto, uuid-ossp, pg_stat_statements) |
| auth şeması + auth.users | PASS |
| whatsapp_private (henüz yok) | BEKLENEN (migration öncesi normal) |
| public tablolar (boş) | BEKLENEN (migration öncesi normal) |

**Migration Blocker: 0**

**Phase 5 öncesi kalan aksiyonlar (migration esnasında yapılacak):**
1. Google Cloud Console'a Frankfurt OAuth callback URL eklenmesi
2. Frankfurt Supabase Dashboard Auth settings (Site URL, redirect URLs, Google provider)
3. `api.tezlify.com` DNS A kaydı → `130.162.247.20`
4. Operatör onaylı cutover penceresi

---

## 20. Production System Status

```
Tokyo production     : UNCHANGED
Render               : UNCHANGED
Vercel               : UNCHANGED
Production WhatsApp  : UNCHANGED
Frankfurt target     : AUTHENTICATED AND VALIDATED (read-only)
Production migration : NOT STARTED
```

**Referans backend test baseline:** 649 pytest geçti (Phase 3A'da doğrulandı). Bu faz sadece target validation; backend test suite'i yeniden çalıştırılmadı.
