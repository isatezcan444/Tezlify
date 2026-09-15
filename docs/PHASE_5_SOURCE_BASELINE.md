# PHASE 5: TOKYO SOURCE DATABASE BASELINE AUDIT
**Tarih:** 2026-09-15 17:39 UTC+3  
**Source Project:** `pzpgjjtefeplygqcxfsj` (AWS ap-northeast-1, Tokyo)  
**Host:** `aws-0-ap-northeast-1.pooler.supabase.com:6543`  
**Engine:** PostgreSQL 17.6 on aarch64-unknown-linux-gnu  
**Bağlantı Modu:** Read-Only Snapshot  

---

## 1. Tablo ve Satır Sayıları (Public + WhatsApp Private)

| Şema | Tablo | Satır Sayısı | Boyut (Relation + Index) |
|---|---|---:|---:|
| `public` | `blacklist` | 0 | 40 kB |
| `public` | `campaign_group_leads` | 0 | 32 kB |
| `public` | `campaign_groups` | 0 | 96 kB |
| `public` | `campaigns` | 0 | 88 kB |
| `public` | `contacts` | 1,787 | 1,128 kB |
| `public` | `conversations` | 341 | 1,096 kB |
| `public` | `discovery_runs` | 0 | 64 kB |
| `public` | `leads` | 0 | 9,264 kB |
| `public` | `message_logs` | 0 | 88 kB |
| `public` | `messages` | 9,386 | 5,272 kB |
| `public` | `profiles` | 3 | 64 kB |
| `public` | `raw_candidates` | 0 | 104 kB |
| `public` | `scraper_jobs` | 63 | 144 kB |
| `public` | `system_settings` | 2 | 40 kB |
| `public` | `whatsapp_sessions` | 4 | 208 kB |
| `whatsapp_private` | `event_outbox` | 6,041 | 10,032 kB |
| `whatsapp_private` | `gateway_sessions` | 6 | 32 kB |
| `whatsapp_private` | `processed_events` | 3,584 | 512 kB |
| `whatsapp_private` | `retry_messages` | 0 | 24 kB |
| `whatsapp_private` | `session_credentials` | 2 | 240 kB |
| `whatsapp_private` | `signal_keys` | 8,125 | 5,752 kB |
| `whatsapp_private` | `socket_leases` | 0 | 64 kB |

---

## 2. WhatsApp Private Kriptografik BYTEA Bütünlük Hash'leri

| Tablo / Kolon | Satır Sayısı | Toplam Bayt | SHA-256 Checksum (Deterministic Ordinal) |
|---|---:|---:|---|
| `whatsapp_private.session_credentials.ciphertext` | 2 | 6,602 | `17b72c5c6adb5b8e5f376a77b0afc52e14053913a6eadec3a9cd92a31c924aec` |
| `whatsapp_private.signal_keys.ciphertext` | 8,125 | 1,094,104 | `56f299ed36dd7f2b3a92b6cedfd7915cee5195c65730841745b6295722a556de` |

---

## 3. PostgreSQL Sequence Değerleri

| Sequence | Last Value |
|---|---:|
| `public.blacklist_id_seq` | 1 |
| `public.campaign_groups_id_seq` | 4 |
| `public.discovery_runs_id_seq` | 1 |
| `public.leads_id_seq` | 7,623 |
| `public.raw_candidates_id_seq` | 1 |
| `public.scraper_jobs_id_seq` | 64 |
| `public.system_settings_id_seq` | 2 |
| `public.campaigns_id_seq` | 2 |
| `public.conversations_id_seq` | 8,939 |
| `public.message_logs_id_seq` | 1 |
| `public.messages_id_seq` | 43,688 |
| `public.contacts_id_seq` | 4,558 |
| `public.whatsapp_sessions_id_seq` | 42 |

---

## 4. ENUM Tipleri

- `public.campaignstatus`: `['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']`
- `public.conversationmessagestatus`: `['RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'PENDING']`
- `public.conversationstatus`: `['ACTIVE', 'ARCHIVED', 'CLOSED']`
- `public.discoveryrunstatus`: `['PENDING', 'RUNNING', 'PARTIAL', 'SATURATED', 'BENCHMARK_RECOVERED', 'BUDGET_EXHAUSTED', 'COMPLETED', 'FAILED', 'CANCELLED']`
- `public.leadstatus`: `['NEW', 'CONTACTED', 'REPLIED', 'INTERESTED', 'UNSUBSCRIBED', 'INVALID_NUMBER']`
- `public.messagedirection`: `['INBOUND', 'OUTBOUND']`
- `public.messagestatus`: `['PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'REPLIED', 'FAILED', 'CANCELLED']`
- `public.messagetype`: `['TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'TEMPLATE', 'OTHER', 'STICKER', 'LOCATION', 'CONTACT', 'UNKNOWN']`
- `public.scraperjobstatus`: `['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']`
- `public.sessionstatus`: `['SCAN_QR', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'BANNED', 'RESTORING', 'RELINK_REQUIRED', 'UNAVAILABLE', 'ERROR']`

---

## 5. Invariant Doğrulaması

- ✅ **Tokyo DB Write Yok:** Sorguların tamamı `SELECT` ile sınırlı read-only audit.
- ✅ **socket_leases:** Kaynak veritabanında aktif kilit/lease bulunmamaktadır (`count = 0`).
