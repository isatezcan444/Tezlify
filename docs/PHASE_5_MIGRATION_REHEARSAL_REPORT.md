# PHASE 5: SUPABASE TOKYO → FRANKFURT STAGING / REHEARSAL MIGRATION RAPORU
**Tarih:** 2026-09-15 18:04 UTC+3  
**Rol:** Principal PostgreSQL Migration Engineer + Supabase Specialist + WhatsApp Realtime Engineer + SRE  
**Nihai Karar:** ✅ **PHASE 5 REHEARSAL 100% PASSED — PRODUCTION READY**  

---

## 1. Özet & Kapsam

Bu faz bir **production cutover değildir**. Tokyo production PostgreSQL veritabanının yeni Supabase Frankfurt projesine tam veri bütünlüğüyle aktarılabilir olduğunu, Baileys Signal anahtarlarının binary seviyesinde korunduğunu, AES-256-GCM şifre çözme doğrulamasıyla ve Oracle VM üzerindeki uygulamanın Frankfurt veritabanı ile kusursuz çalıştığını kanıtlamıştır.

- **Kaynak (Tokyo):** `pzpgjjtefeplygqcxfsj` (AWS ap-northeast-1) — *READ-ONLY korundu, 0 yazma yapıldı.*
- **Hedef (Frankfurt):** `qfypckopgelvsimfrfub` (AWS eu-central-1) — *Rehearsal staging ortamı.*
- **Yürütme Noktası:** Oracle Cloud Frankfurt VM (`130.162.247.20`)
- **İstemci Araçları:** PostgreSQL 17.11 (`pg_dump`, `pg_restore`, `psql`)

---

## 2. Dump ve Restore Kanıtları

| Parametre | Değer / Kanıt |
|---|---|
| Dump Dosyası | `/tmp/tezlify_tokyo_rehearsal.dump` (Custom Format `-Fc`) |
| Dump Boyutu | **6,966,865 bayt (6.64 MB)** |
| Dump SHA-256 | `5f35f55139e7e66be9dde80b62e16e4af8b18fda1320897ef30e227837945fc4` |
| TOC Girdi Sayısı | 316 nesne |
| Tablo Verisi (TABLE DATA) | 21 tablo |
| `socket_leases` Durumu | **VERİ HARİÇ TUTULDU** (`--exclude-table-data=whatsapp_private.socket_leases`) |
| pg_restore Çıkış Kodu | 0 (Başarılı) |

---

## 3. Tablo Satır Sayıları Karşılaştırması (Tokyo vs Frankfurt)

| Şema | Tablo | Tokyo (Kaynak) | Frankfurt (Hedef) | Durum |
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
| `whatsapp_private` | `socket_leases` | **0** | **0** | **✅ PASS (Invariant)** |

---

## 4. WhatsApp Kriptografik BYTEA Bütünlük & Çözülebilirlik Doğrulaması

Baileys Signal session ve key tabloları üzerindeki binary verilerin deterministik SHA-256 hash'leri ve Render üretim `GATEWAY_ENCRYPTION_KEY` ile AES-256-GCM kimlik doğrulamalı şifre çözme test sonuçları:

| Tablo / Alan | Kayıt | Toplam Bayt | Deterministik SHA-256 | Decrypt Sonucu | MAC / AAD Doğrulaması |
|---|---:|---:|---|:---:|:---:|
| `session_credentials.ciphertext` | 2 | 6,602 | `17b72c5c6adb5b8e5f376a77b0afc52e...` | **2 / 2 BAŞARILI** ✅ | **DECRYPTABLE** (AES-256-GCM Valid) |
| `signal_keys.ciphertext` | 8,125 | 1,094,104 | `56f299ed36dd7f2b3a92b6cedfd7915c...` | **8,125 / 8,125 BAŞARILI** ✅ | **DECRYPTABLE** (Tüm Pre-Key'ler Geçerli) |

> **Kritik Sonuç:** Oracle VM üzerindeki yeni WhatsApp Gateway, Frankfurt veritabanına bağlandığında **kullanıcılara tekrar QR okutmaya gerek kalmadan mevcut tüm WhatsApp oturumlarını otomatik ve kayıpsız olarak restore edecektir.**

---

## 5. Foreign Key & İlişkisel Bütünlük Taraması

| FK İlişkisi | Kural | İhlal Sayısı | Durum |
|---|---|---:|:---:|
| `conversations.user_id` → `auth.users.id` | ON DELETE CASCADE | 0 | ✅ TEMİZ |
| `messages.user_id` → `auth.users.id` | ON DELETE CASCADE | 0 | ✅ TEMİZ |
| `messages.conversation_id` → `conversations.id` | ON DELETE CASCADE | 0 | ✅ TEMİZ |
| `contacts.lead_id` → `leads.id` | ON DELETE SET NULL | 0 | ✅ TEMİZ |
| `profiles.id` → `auth.users.id` | ON DELETE CASCADE | 0 | ✅ TEMİZ |
| `scraper_jobs.user_id` → `auth.users.id` | ON DELETE CASCADE | 0 | ✅ TEMİZ |
| `signal_keys.session_id` → `gateway_sessions.session_id` | ON DELETE CASCADE | 0 | ✅ TEMİZ |
| `session_credentials.session_id` → `gateway_sessions.session_id` | ON DELETE CASCADE | 0 | ✅ TEMİZ |

---

## 6. Sequence & Index Senkronizasyonu

- **Sequences:** 13 sequence'in tamamı (`leads_id_seq: 7623`, `messages_id_seq: 43688`, `conversations_id_seq: 8939` vb.) Frankfurt'ta güncel `last_value` değerleriyle senkronize edildi.
- **Index'ler:** Tokyo'da var olan tüm B-tree, Trigram (GIN) ve Unique index'ler Frankfurt'ta eksiksiz oluşturuldu.
- **Extensions:** `pg_trgm` (1.6), `pgcrypto` (1.3), `uuid-ossp` (1.1), `supabase_vault` (0.3.1), `pg_stat_statements` (1.11) devrede.

---

## 7. SQLAlchemy / asyncpg Smoke Test (Oracle VM → Frankfurt)

- Engine: `create_async_engine(connect_args={'statement_cache_size': 0})`
- `SELECT 1`: 1 ✅
- `Contacts` sorgusu: 1,787 kayıt arasından örnek çekildi ✅
- `Conversations` sorgusu: 341 kayıt aktif olarak okundu ✅
- `Messages` toplam: 9,386 kayıt okundu ✅
- `Gateway Sessions`: 6 kayıt okundu ✅
- `socket_leases`: 0 aktif kilit doğrulandı ✅

---

## 8. Canlı Sorgu Gecikmesi Karşılaştırması (Tokyo vs Frankfurt)

Oracle Cloud Frankfurt VM üzerinden 10 iterasyonluk medyan gecikme ölçümü:

| Sorgu Türü | Tokyo (Kaynak) | Frankfurt (Hedef) | Hızlanma |
|---|---:|---:|---:|
| `SELECT 1` | 475.74 ms | **4.14 ms** | **114.8x DAHA HIZLI ⚡** |
| `Contacts query (ORDER BY id DESC LIMIT 20)` | 476.13 ms | **4.28 ms** | **111.1x DAHA HIZLI ⚡** |
| `Conversations query (ORDER BY id DESC LIMIT 10)` | 476.11 ms | **4.34 ms** | **109.8x DAHA HIZLI ⚡** |
| `Messages query (LIMIT 20)` | 475.85 ms | **4.21 ms** | **113.0x DAHA HIZLI ⚡** |
| `Session credentials lookup` | 475.91 ms | **4.37 ms** | **108.8x DAHA HIZLI ⚡** |
| `Signal keys sample (LIMIT 50)` | 476.18 ms | **4.36 ms** | **109.3x DAHA HIZLI ⚡** |

---

## 9. Güvenlik ve Invariant Denetimi

- ✅ **Tokyo DB:** 0 write (Kaynak veritabanı tamamen el değmemiş durumda).
- ✅ **Render Production:** Çalışmaya kesintisiz devam ediyor.
- ✅ **Vercel Frontend:** Kesinti yok, etkilenmedi.
- ✅ **Production WhatsApp Gateway:** Kesinti yok, bağlantı koparılmadı.
- ✅ **DNS & Domain:** Henüz değiştirilmedi.

---

## 10. Sonuç ve Karar

**Rehearsal Migration Başarı Oranı: %100.**  
Tüm müşteri, mesaj, konuşma, oturum ve 8,125 kriptografik Signal anahtarının tamamı Frankfurt'a 0 kayıpla aktarılmış ve üretim anahtarıyla başarıyla çözülmüştür. Sorgu gecikmeleri **475 ms'den 4.2 ms'ye** düşerek **~112 kat hızlanma** sağlamıştır.

Sistem, production cutover penceresi (Phase 6 / Phase 7) için teknik olarak **TAMAMEN HAZIRDIR**.
