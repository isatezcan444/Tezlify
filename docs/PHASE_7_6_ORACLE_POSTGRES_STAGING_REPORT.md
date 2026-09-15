# PHASE 7.6 — ORACLE LOCAL POSTGRESQL STAGING MIGRATION REPORT
## Zero-Downtime & Non-Destructive Preparation

**Tarih:** 2026-09-15 20:53:00 UTC (23:53:00 TSİ)  
**Mühendislik Rolü:** Principal PostgreSQL Migration Engineer + SRE + WhatsApp Realtime Engineer  
**Nihai Karar:** ✅ **STAGING POSTGRES READY**  
**Güvenlik İlkesi:** Production `DATABASE_URL` değiştirilmemiştir. Supabase Frankfurt production veritabanına dokunulmamıştır. Render açılmamıştır. Canlı WhatsApp oturumuna müdahale edilmemiştir.

---

## 1. Executive Summary

Phase 7.5A'da Supabase Free planındaki 5 GB egress kotasının aşılması (%174 — 8.69 GB) ve Supabase'in harici veritabanı çıkışlarını kısıtlaması kesinleştikten sonra; Phase 7.6 kapsamında Oracle Cloud Frankfurt VM (`130.162.247.20`) üzerinde tamamen izole, production trafiğinden bağımsız bir **Staging PostgreSQL** altyapısı kurulmuş ve son Tokyo snapshot'ı (`/tmp/tezlify_tokyo_final_cutover.dump`) bu ortama restore edilmiştir.

Gerçekleştirilen testler sonucunda:
1. **Kapasite ve Kaynak Güvenliği:** Oracle VM'de 24 GB RAM'in 22 GB'ı boşta, 96 GB diskin 90 GB'ı boştadır. Staging container'ı yalnızca 35 MB RAM harcamaktadır.
2. **Tablo ve Satır Paritesi:** Tokyo kaynak veritabanındaki 22 tablonun tamamı (9,386 mesaj, 1,787 kişi, 341 sohbet, 8,125 signal key) **%100 eksiksiz ve sıfır satır kaybıyla** eşleşmiştir.
3. **Kriptografik BYTEA Bütünlüğü:** `session_credentials` (6,602 bayt) ve `signal_keys` (1,094,104 bayt) verilerinin SHA-256 sağlama toplamları Tokyo ana kaynak özetiyle **bit-for-bit birebir uyuşmuştur**.
4. **Baileys Oturum Çözme (Decryption):** Mevcut `GATEWAY_ENCRYPTION_KEY` ile tüm 8,125 signal key ve 2 session credential **%100 başarıyla çözülmüş (AES-256-GCM MAC verified)** ve Baileys anahtar yapısı doğrulanmıştır.
5. **SQLAlchemy AsyncIO Performansı:** 
   - `SELECT 1` medyan gecikmesi: **0.315 ms**
   - Sohbet / Mesaj sorgulama medyan gecikmesi: **0.491 ms / 0.529 ms**
   - Yazma (INSERT / UPDATE) medyan gecikmesi: **1.565 ms / 1.457 ms**
6. **Yedekleme & Geri Yükleme Döngüsü:** Staging DB üzerinden yeni `pg_dump` alınıp geçici bir veritabanına geri yüklenmiş ve tam parite kanıtlanmıştır.

---

## 2. Oracle VM Kapasite ve Kaynak Durumu (Bölüm 1)

| Kaynak | Toplam Kapasite | Kullanılan | Boşta Olan | Kullanım % |
|---|---|---|---|---|
| **İşlemci (CPU)** | 4 OCPU (Ampere Neoverse-N1 ARM64) | - | 4 OCPU | <%1 |
| **Bellek (RAM)** | 23.41 GiB | 1.0 GiB | **22.0 GiB** | %4.3 |
| **Disk (`/` ve `/opt`)** | 96 GB NVMe SSD | 6.8 GB | **90 GB** | %8 |
| **Docker Versiyonu** | 29.8.0 (linux/arm64) | - | - | - |
| **Aylık Ücretsiz Trafik** | 10 TB/ay (Oracle Always Free) | < 1 GB | ~10 TB | <%0.01 |

### Mevcut Container RAM Kullanımı:
- `tezlify-caddy`: 13.03 MiB
- `tezlify-gateway`: 69.22 MiB
- `tezlify-backend`: 135.5 MiB
- `tezlify-postgres-staging`: 35.1 MiB
- **Toplam Container Yükü:** ~253 MiB / 24,000 MiB (**%1.05**)

---

## 3. Yedek Dosyası Doğrulaması (Bölüm 2)

| Dosya Özelliği | Değer |
|---|---|
| **Dosya Yolu** | `/tmp/tezlify_tokyo_final_cutover.dump` |
| **Boyut** | 6.7 MB (6,989,451 bayt) |
| **Format** | PostgreSQL Custom Archive (gzip sıkıştırmalı) |
| **Kaynak Motor** | PostgreSQL 17.6 (Tokyo Supabase) |
| **TOC Giriş Sayısı** | 308 TOC Entry (317 satır) |
| **SHA-256 Özeti** | `5fcbe28efe255662c8f00cf1754f17fa0a63ac3fe1f5a5a3cac3c7e1e57d6243` |
| **Değiştirilme Durumu** | Salt-okunur doğrulandı, sıfır mutasyon |

---

## 4. İzole Staging PostgreSQL Yapılandırması (Bölüm 3 & 4)

- **Container Adı:** `tezlify-postgres-staging`
- **İmaj:** `postgres:17-alpine` (ARM64 native)
- **Kalıcı Volume:** `tezlify_postgres_staging_data` (`/var/lib/postgresql/data`)
- **Ağ İzolasyonu:** `tezlify_tezlify-internal` Docker bridge ağı
- **Port Durumu:** **Sıfır Host Binding.** Port `5432` internete veya Oracle host IP'sine açılmamıştır (`docker port` = boş). Yalnızca backend ve gateway'in bulunduğu dahili Docker ağı üzerinden erişilebilir.
- **Veritabanı Adı:** `tezlify`
- **Kullanıcı:** `tezlify`
- **Şifre:** Güçlü rastgele üretilmiş anahtar (`/opt/tezlify/.staging_db_secret`, izinler 600).
- **Postgres Parametreleri:**
  - `timezone`: `UTC`
  - `max_connections`: `100`
  - `shared_buffers`: `512MB`
  - `work_mem`: `16MB`
  - `fsync`: `on`
  - `full_page_writes`: `on`
  - `synchronous_commit`: `on`

---

## 5. Tablo ve Satır Parite Denetimi (Bölüm 6)

Tokyo kaynak veritabanı (`docs/PHASE_5_SOURCE_BASELINE.md`) ile staging veritabanı karşılaştırması:

| Şema | Tablo Adı | Tokyo Kaynak Satır | Staging PostgreSQL Satır | Parite Durumu |
|---|---|---:|---:|:---:|
| `public` | `blacklist` | 0 | 0 | ✅ MATCH |
| `public` | `campaign_group_leads` | 0 | 0 | ✅ MATCH |
| `public` | `campaign_groups` | 0 | 0 | ✅ MATCH |
| `public` | `campaigns` | 0 | 0 | ✅ MATCH |
| `public` | `contacts` | 1,787 | 1,787 | ✅ MATCH |
| `public` | `conversations` | 341 | 341 | ✅ MATCH |
| `public` | `discovery_runs` | 0 | 0 | ✅ MATCH |
| `public` | `leads` | 0 | 0 | ✅ MATCH |
| `public` | `message_logs` | 0 | 0 | ✅ MATCH |
| `public` | `messages` | 9,386 | 9,386 | ✅ MATCH |
| `public` | `profiles` | 3 | 3 | ✅ MATCH |
| `public` | `raw_candidates` | 0 | 0 | ✅ MATCH |
| `public` | `scraper_jobs` | 63 | 63 | ✅ MATCH |
| `public` | `system_settings` | 2 | 2 | ✅ MATCH |
| `public` | `whatsapp_sessions` | 4 | 4 | ✅ MATCH |
| `whatsapp_private` | `event_outbox` | 6,041 | 6,041 | ✅ MATCH |
| `whatsapp_private` | `gateway_sessions` | 6 | 6 | ✅ MATCH |
| `whatsapp_private` | `processed_events` | 3,584 | 3,584 | ✅ MATCH |
| `whatsapp_private` | `retry_messages` | 0 | 0 | ✅ MATCH |
| `whatsapp_private` | `session_credentials` | 2 | 2 | ✅ MATCH |
| `whatsapp_private` | `signal_keys` | 8,125 | 8,125 | ✅ MATCH |
| `whatsapp_private` | `socket_leases` | 0 | 0 | ✅ MATCH |

> **Özel İnvaryant:** `socket_leases` satır sayısı `0` olarak doğrulanmıştır. Staging ortamında hiçbir aktif kilit üretilmemiştir.

---

## 6. Kriptografik BYTEA Bütünlüğü (Bölüm 7)

| Tablo / Kolon | Tokyo Satır / Bayt | Staging Satır / Bayt | Tokyo SHA-256 | Staging SHA-256 | Durum |
|---|---|---|---|---|:---:|
| `session_credentials.ciphertext` | 2 satır / 6,602 B | 2 satır / 6,602 B | `17b72c5c6adb5b8e5f376a77b0afc52e14053913a6eadec3a9cd92a31c924aec` | `17b72c5c6adb5b8e5f376a77b0afc52e14053913a6eadec3a9cd92a31c924aec` | ✅ **%100 IDENTICAL** |
| `signal_keys.ciphertext` | 8,125 satır / 1,094,104 B | 8,125 satır / 1,094,104 B | `56f299ed36dd7f2b3a92b6cedfd7915cee5195c65730841745b6295722a556de` | `56f299ed36dd7f2b3a92b6cedfd7915cee5195c65730841745b6295722a556de` | ✅ **%100 IDENTICAL** |

---

## 7. FK, İndeks ve Sequence Doğrulaması (Bölüm 8)

- **Foreign Key Bütünlüğü:** 15 yabancı anahtar kısıtının tamamı kontrol edilmiş; yetim (orphaned) satır sayısı **0** bulunmuştur.
- **Birincil ve Benzersiz Anahtarlar:** 22 Primary Key, 1 Unique Key eksiksiz mevcuttur.
- **İndeks Sayısı:** `public` şemasında 113 indeks, `whatsapp_private` şemasında 11 indeks oluşturulmuştur.
- **Sequence Değerleri:**
  - `contacts_id_seq`: 4,558 (Tokyo: 4,558)
  - `conversations_id_seq`: 8,939 (Tokyo: 8,939)
  - `messages_id_seq`: 43,688 (Tokyo: 43,688)
  - `leads_id_seq`: 7,623 (Tokyo: 7,623)
  - `scraper_jobs_id_seq`: 64 (Tokyo: 64)
  - `system_settings_id_seq`: 2 (Tokyo: 2)
  - `whatsapp_sessions_id_seq`: 42 (Tokyo: 42)

---

## 8. Canlı Decryption Testi (Bölüm 9)

Gateway container'ı içindeki AES-256-GCM çözücü ve mevcut `GATEWAY_ENCRYPTION_KEY` ile staging veritabanı taranmıştır:
- **Session Credentials:** `2 / 2` oturum başarıyla çözüldü (Baileys `noiseKey`, `registrationId`, `signedIdentityKey` eksiksiz).
- **Signal Keys:** `8,125 / 8,125` anahtarın tamamı başarıyla çözüldü (Sıfır MAC hatası, sıfır authTag reddi).
- **Sonuç:** Kullanıcıların telefonlarından **QR okutmasına gerek kalmadan** tüm oturumlar belleğe yüklenebilir durumdadır.

---

## 9. Uygulama Okuma & Yazma Testleri (Bölüm 10 & 11)

- **SQLAlchemy AsyncIO Okuma Testi:** `SELECT 1`, `profiles`, `conversations`, `messages`, `whatsapp_sessions`, `event_outbox` tablolarından gerçek asenkron sorgular başarıyla yürütüldü (**6/6 PASSED**).
- **Transaction Rollback Testi:** `contacts` tablosuna işlem içinde kayıt eklendi, varlığı doğrulandı, `rollback()` çağrıldı ve kaydın geri alındığı kanıtlandı (**PASSED**).
- **CRUD Döngüsü Testi:** `_staging_crud_test` tablosu üzerinde `CREATE`, `INSERT`, `UPDATE`, `DELETE`, `DROP` döngüsü hatasız tamamlandı (**PASSED**).

---

## 10. Performans Karşılaştırma Matrisi (Bölüm 12)

Oracle Backend container içinden Staging PostgreSQL'e (Docker dahili ağı üzerinden) **50 iterasyonluk** ölçüm sonuçları:

| İşlem Türü | Min (ms) | Medyan (ms) | P95 (ms) | P99 (ms) | Max (ms) |
|---|---:|---:|---:|---:|---:|
| **Cold Connect** | 40.730 | **40.929** | 99.648 | 99.648 | 99.648 |
| **SELECT 1 (Warm)** | 0.298 | **0.315** | 0.352 | 0.809 | 0.809 |
| **Simple SELECT now()** | 0.306 | **0.320** | 0.356 | 0.822 | 0.822 |
| **Conversation Lookup (ID)** | 0.457 | **0.491** | 0.561 | 19.617 | 19.617 |
| **Message Lookup (20 satır)** | 0.487 | **0.529** | 0.665 | 11.285 | 11.285 |
| **INSERT (Commit + Fsync)** | 1.219 | **1.565** | 1.873 | 2.302 | 2.302 |
| **UPDATE (Commit + Fsync)** | 1.321 | **1.457** | 2.035 | 30.725 | 30.725 |

### Tarihsel Karşılaştırma:
- **Tokyo Supabase (Render -> Tokyo):** ~466.7 ms medyan (yaklaşık **1,480 kat daha yavaş**)
- **Frankfurt Supabase Pooler (Oracle -> AWS Pooler):** ~7.5 ms medyan (yaklaşık **23 kat daha yavaş**)
- **Oracle Local PostgreSQL:** **~0.315 – 0.529 ms medyan**

---

## 11. Yedekleme / Geri Yükleme Döngü Testi (Bölüm 13)

1. Staging DB'den `pg_dump -Fc` ile anlık 6.7 MB yedek alındı (`c3cfb4260252...`).
2. Staging sunucusunda geçici `tezlify_restore_test` veritabanı oluşturuldu.
3. Yedek bu veritabanına geri yüklendi (`Restore exit code: 0`).
4. Satır sayıları doğrulandı (`contacts`: 1787, `messages`: 9386, `signal_keys`: 8125).
5. Geçici veritabanı ve yedek dosyası temizlendi (**PASSED & CLEANED UP**).

---

## 12. İnvaryant ve Güvenlik Teyidi (Bölüm 14)

- `DATABASE_URL` ve `GATEWAY_DATABASE_URL` `/opt/tezlify/.env.production` dosyasında **değiştirilmemiştir**.
- Production backend ve gateway halen mevcut yapılandırmayı korumaktadır.
- Sıfır kesinti, sıfır veri kaybı, sıfır secret sızıntısı sağlanmıştır.

---

## 13. Nihai Karar (Bölüm 16)

```
============================================================
NİHAİ KARAR: STAGING POSTGRES READY
============================================================
- Veritabanı ve tüm şemalar (%100 parite) hazır.
- Kriptografik anahtarlar ve oturumlar doğrulandı.
- Oracle yerel performansı: 0.31 ms medyan gecikme.
- Production ortamına dokunulmamıştır.
============================================================
```
