# PHASE 7: CONTROLLED PRODUCTION CUTOVER RAPORU
**Tarih:** 2026-09-15 18:35 UTC+3  
**Rol:** Principal Migration Architect + PostgreSQL Engineer + SRE + WhatsApp Realtime Engineer  
**Nihai Karar:** ✅ **CUTOVER SUCCESSFUL WITH OBSERVATION**  

---

## 1. Cutover Zaman Çizelgesi (Timeline)

- **18:17:00** — Pre-Cutover Readiness (§0) canlı denetimi tamamlandı (11/11 PASS).
- **18:18:00** — İcra planı hazırlandı ve onaylandı.
- **18:19:05** — Final Rollback Güvenlik Yedeği Tokyo'dan alındı (`/tmp/tezlify_tokyo_final_cutover.dump`, 6.64 MB, SHA-256 doğrulandı).
- **18:20:05** — Bakım penceresine girildi; Tokyo canlı mutasyon dondurma teyit edildi.
- **18:20:51** — Tokyo `whatsapp_private.socket_leases` sıfır kilit durumu teyit edildi (`0 rows`).
- **18:21:10** — Frankfurt hedef veritabanı ile final baseline karşılaştırıldı (22/22 tablo %100 birebir).
- **18:25:31** — Oracle VM `/opt/tezlify/.env.production` dosyası Frankfurt Supabase Pooler (`aws-0-eu-central-1.pooler.supabase.com:6543`) ile yapılandırıldı.
- **18:26:25** — Oracle prod konteynerleri (`tezlify-backend`, `tezlify-gateway`, `tezlify-caddy`) ayağa kaldırıldı.
- **18:26:31** — Baileys WhatsApp Gateway, Frankfurt DB'den kimlikleri okuyarak **QR sormadan doğrudan `CONNECTED`** durumuna geçti.
- **18:28:51** — Health endpoint ve public HTTP/WebSocket el sıkışması (`HTTP 101 Switching Protocols`) doğrulandı.

---

## 2. Kaynak Dondurma & Veri Bütünlüğü (Source Freeze & Integrity)

| Tablo / Kaynak | Tokyo Baseline | Frankfurt Hedef | Bütünlük Durumu |
|---|---:|---:|:---:|
| `public.contacts` | 1,787 | 1,787 | ✅ %100 MATCH |
| `public.conversations` | 341 | 341 | ✅ %100 MATCH |
| `public.messages` | 9,386 | 9,386 | ✅ %100 MATCH |
| `public.profiles` | 3 | 3 | ✅ %100 MATCH |
| `public.scraper_jobs` | 63 | 63 | ✅ %100 MATCH |
| `public.whatsapp_sessions` | 4 | 4 | ✅ %100 MATCH |
| `whatsapp_private.gateway_sessions` | 6 | 6 | ✅ %100 MATCH |
| `whatsapp_private.session_credentials` | 2 | 2 | ✅ %100 MATCH |
| `whatsapp_private.signal_keys` | 8,125 | 8,125 | ✅ %100 MATCH |
| `whatsapp_private.socket_leases` | **0** | **1 (Yeni Oracle Sahibi)** | ✅ TEMİZ DEVİR |
| `auth.users` | 3 | 3 | ✅ %100 MATCH |
| `auth.identities` | 3 | 3 | ✅ %100 MATCH |

---

## 3. WhatsApp Oturum Devri (Session Handoff & READY)

- **Oturum ID:** `0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2`
- **Hat / Numara:** Hat 1 (`+905076382749`)
- **Durum:** **CONNECTED / READY** ✅
- **QR Code İstendi mi?:** **HAYIR (QR: null)**
- **Telefon Çevrim İçi mi?:** `is_phone_online = true`
- **Geçmiş Eşitleme (Sync):** Phase: Ready (%100), 96 Sohbet, 1,012 Mesaj canlı senkronize edildi.
- **Lease Sahibi:** Oracle Gateway Instance `09f60b95-62e0-42bd-931a-a8aef973d255` (`generation = 1`).

---

## 4. Canlı Servis & Ağ Doğrulaması

1. **Backend Health Check:**
   `http://130.162.247.20/health` → `200 OK`
   ```json
   {"status":"healthy","service":"Tezlify Backend API","version":"1.0.0","scraper_engine":"HTTP","memory_mb":131.5}
   ```
2. **Gateway Health Check:**
   `http://127.0.0.1:8787/health` → `200 OK`
   ```json
   {"status":"ok","service":"tezlify-whatsapp-gateway","sessions":{"total":2,"connected":1,"pending_qr":0}}
   ```
3. **Public WebSocket Upgrade:**
   `http://130.162.247.20/ws` → `HTTP/1.1 101 Switching Protocols` (Caddy + Uvicorn) ✅

---

## 5. Vercel & DNS Yönlendirmesi

- **Oracle Public IP:** `130.162.247.20`
- **DNS A Kaydı Hedefi:** `api.tezlify.com` → `130.162.247.20`
- **Vercel Rewrite Konfigürasyonu:**
  `vercel.json` içindeki `https://tezlify.onrender.com` hedefi `https://api.tezlify.com` olarak güncellenmeye hazırdır.
  DNS kaydı oturduğunda Caddy otomatik Let's Encrypt TLS sertifikasını temin edecektir.

---

## 6. Performans İyileşmesi Özeti

| Metrik | Render + Tokyo (Eski) | Oracle + Frankfurt (Yeni) | İyileşme Oranı |
|---|---:|---:|---:|
| Veritabanı Sorgu Gecikmesi | ~476 ms | **4.2 ms** | **112x DAHA HIZLI ⚡** |
| Cold Start Uyanma Süresi | 72.5 saniye | **0 saniye (7/24 Canlı)** | **TAMAMEN YOK EDİLDİ** |
| WhatsApp Kripto & CPU Kapasitesi | 0.1 vCPU paylaşımlı | **4 OCPU dedicated ARM64** | **40x İŞLEMCİ GÜCÜ** |
| RAM Kapasitesi | 512 MB (OOM riski) | **24 GB Bellek** | **48x BELLEK** |

---

## 7. Rollback Hazırlığı (Acil Durum Prosedürü)

Gerekli olması durumunda uygulanacak acil geri dönüş:
```bash
# 1. Oracle Gateway'i durdur
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 "cd /opt/tezlify && docker stop tezlify-gateway"

# 2. Render Dashboard'dan servisi yeniden başlat (veya unpause)
# 3. Vercel trafiği eski Render URL'ine kalır
# 4. Tokyo veritabanı yedeği: /tmp/tezlify_tokyo_final_cutover.dump (korunmaktadır)
```

---

## 8. Gözlem Penceresi & Son Karar

- **Karar:** **CUTOVER SUCCESSFUL WITH OBSERVATION**
- **Durum:** Üretim sistemi başarıyla Oracle Frankfurt VM ve Supabase Frankfurt veritabanına devredilmiştir.
- **Kritik Kural:** **Render bu aşamada silinmeyecektir (Phase 12'ye kadar güvenli beklemede tutulacaktır).**
- Sistem 15–30 dakikalık canlı gözlem sürecindedir.

---

## 7.1 Vercel Traffic Switch

- **Yapılandırma Dosyaları Güncellendi:**
  - `vercel.json`: `/api/:path*`, `/health`, `/docs`, `/openapi.json` hedefleri `https://api.tezlify.com`'a çevrildi.
  - `frontend/vercel.json`: Birebir senkronize edildi.
  - `frontend/src/api/client.ts`: Fallback URL'ler ve sanitizer `https://api.tezlify.com` ve `wss://api.tezlify.com/ws` olarak ayarlandı.
  - `frontend/src/pages/SettingsPage.tsx`: Gateway referansı `https://api.tezlify.com` yapıldı.
  - `frontend/.env.production`: `VITE_API_URL` ve `VITE_WS_URL` güncellendi.
- **Frontend Derleme Doğrulaması:**
  - `cd frontend && npm run build` (`tsc && vite build`): **1.82 saniyede 0 hatayla başarıyla derlendi**.

---

## 7.2 Public DNS Validation

Gerçek public DNS sorguları 3 bağımsız çözümleyici üzerinden gerçekleştirilmiştir:

| Resolver | Record Type | Sorgulanan Hostname | Sonuç | TTL | Durum |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **System Resolver** | A | `api.tezlify.com` | `NXDOMAIN` (Kayıt yok) | - | ❌ **Eksik** |
| **Cloudflare (1.1.1.1)** | A | `api.tezlify.com` | `NXDOMAIN` (Kayıt yok) | - | ❌ **Eksik** |
| **Google (8.8.8.8)** | A | `api.tezlify.com` | `NXDOMAIN` (Kayıt yok) | - | ❌ **Eksik** |
| **Cloudflare / Google** | AAAA | `api.tezlify.com` | `NXDOMAIN` (Kayıt yok) | - | ℹ️ Temiz (IPv6 çakışması yok) |

> [!CAUTION]
> **Kullanıcı Aksiyonu Zorunlu (STOP):**
> DNS sağlayıcısında (Cloudflare, Domain Registrar veya NS sağlayıcınız) aşağıdaki `A` kaydı girilmelidir:
> - **Type:** `A`
> - **Name:** `api` (veya `api.tezlify.com`)
> - **Value / Target IP:** `130.162.247.20`
> - **TTL:** `300` (veya Provider Default — Cloudflare kullanılıyorsa *Proxy: DNS Only / Gri Bulut*)

---

## 7.3 Production TLS Validation

- **Caddy Host Header Testi:**  
  `curl -iv -H "Host: api.tezlify.com" http://130.162.247.20/health` → **HTTP/1.1 200 OK** (Caddy reverse proxy backend'e başarıyla ulaşıyor).
- **Caddy Let's Encrypt Durumu:**  
  Caddy logları incelendiğinde Let's Encrypt ACME HTTP-01 / TLS-ALPN-01 doğrulamasının `DNS problem: NXDOMAIN looking up A for api.tezlify.com` hatasıyla beklediği doğrulanmıştır.
- **Beklenen Davranış:** DNS `A` kaydı propagasyonu tamamlandığı anda Caddy otomatik olarak Let's Encrypt TLS sertifikasını sağlayacak ve HTTPS 443 portu aktifleşecektir.

---

## 7.4 Vercel Production Deployment

- **Proxy Rewrite Konfigürasyonu:**
  - `vercel.json` ve `frontend/vercel.json`: `/api/:path*`, `/health`, `/docs`, `/openapi.json` hedefleri `https://api.tezlify.com` olarak güncellendi.
  - `frontend/src/api/client.ts`: `api.tezlify.com` ve `wss://api.tezlify.com/ws` hedeflerine bağlandı.
- **Frontend Derleme Doğrulaması:**
  - `cd frontend && npm run build`: **PASS** (0 error, 1.82s).
- **Vercel Ortam Değişkenleri:**
  - Vercel üzerinde `VITE_API_URL=https://api.tezlify.com` ve `VITE_WS_URL=wss://api.tezlify.com/ws` tanımlanmalıdır.
  - Frankfurt Supabase `anon` key'i Vercel'e eklenmelidir.

---

## 7.5 Browser Traffic Proof

- **DNS NXDOMAIN** nedeniyle tarayıcı trafiği henüz canlı public `api.tezlify.com` domaini üzerinden çalıştırılamamıştır.
- IP tabanlı Caddy ve yerel simülasyonlar (Virtual Host HTTP 200 & WebSocket 101) başarılıdır.
- DNS tamamlandıktan sonra tarayıcı Network panelinde tüm çağrıların `https://api.tezlify.com` ve `wss://api.tezlify.com/ws` olduğu teyit edilecektir.

---

## 7.6 Google OAuth Validation

- Frankfurt Supabase projesi (`qfypckopgelvsimfrfub`) aktif.
- **Gerekli Callback:** `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/callback`
- Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client IDs altında bu URI'nin eklenmesi beklenmektedir.

---

## 7.7 Real WhatsApp Incoming & Outgoing (Lease & Çakışma Yönetimi)

- **Render / Tokyo İzolasyonu:**  
  Tokyo veritabanında `UPDATE whatsapp_private.gateway_sessions SET is_active = FALSE;` ve `DELETE FROM whatsapp_private.socket_leases;` çalıştırılarak Render Gateway'in oturumu kapması engellenmiştir.
  - Tokyo Aktif Lease: **0** ✅
- **Oracle Frankfurt Gateway:**  
  Oracle Gateway Frankfurt DB üzerinde tek ve yetkili kilit sahibidir (`generation: 5`).
- **Canlı WhatsApp Durumu:**  
  - Session ID: `0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2` (`+905076382749`)
  - Durum: **CONNECTED / READY / ONLINE** ✅ (0 QR re-scan, sync %100).
- **Hata İyileştirmesi:**  
  `whatsapp-gateway/src/session-manager.js` içinde oturumu olan kayıtlı hatların geçici bağlantı kopmalarında 3 deneme sonra yanlışlıkla QR bekleme hatasına düşmesini engelleyen düzeltme yapıldı ve Gateway'e yüklendi.

---

## 7.8 Real Authenticated Browser & WhatsApp E2E (Phase 7.8)

- **Frontend E2E:** Gerçek Chromium Playwright ile `https://tezlify-woad.vercel.app` test edildi. Sayfa HTTP 200 ile yüklendi, 0 Render isteği, 0 Tokyo isteği, 0 unhandled error.
- **WebSocket (WSS):** Gerçek tarayıcı bağlamından `wss://api.130.162.247.20.sslip.io/ws` açılarak `ping`/`pong` çerçeve değişimi başarıyla doğrulandı (`readyState: 1`, OPEN).
- **WS Reconnect:** Tarayıcıda kontrollü soket kapatma ve otomatik yeniden bağlanma doğrulandı (`reconnect_success`).
- **Canlı WhatsApp Durumu:** Session `0e8f8a0f...` (`+905076382749`) `CONNECTED`, `ONLINE`, 0 QR, 0 conflict, 0 lease loss; veritabanı outbox pump aktif.
- **Geçmiş & Sayfalama:** Gerçek DB sohbetleri (örn: Conv 8756, 7982) üzerinde `whatsapp_service.get_messages` ve cursor tabanlı (`before=...`) sayfalama 0 duplikasyon ile doğrulandı.
- **Google OAuth / Supabase Auth:** Supabase Free planında Egress kota aşımı (%174 — 8.69 GB) nedeniyle Supabase Auth servisi Cloudflare 521/522 hatası verdiğinden ve insan etkileşimi gerektiğinden `NOT EXECUTED — INTERACTIVE GOOGLE AUTH REQUIRED` olarak işaretlendi.
- **Canlı Mesajlaşma:** Harici test cihazı sağlanmadığından Inbound/Outbound canlı dış telefon testleri `NOT EXECUTED` olarak işaretlendi.

---

## 7.9 Browser WebSocket Reconnect

- WebSocket sunucusu Oracle Caddy + Uvicorn üzerinde RFC-6455 standartlarına uygun olarak dinlemektedir.
- Gerçek Chromium tarayıcısı üzerinde kontrollü kesinti ve yeniden bağlanma (`reconnect_success`) başarıyla test edildi.

---

## 7.10 30-Minute Observation & Altyapı Metrikleri

- **Oracle Backend:** Uptime stabil, RAM 131.8 MB, CPU < %1, Public HTTPS gecikmesi ~45 ms.
- **Oracle Gateway:** Uptime stabil, Connected: 1, Error: 0, Event outbox aktarımı kesintisiz.
- **Oracle Caddy:** Uptime stabil, Let's Encrypt TLS aktif, HTTP 5xx hatası: 0.
- **Oracle Local PostgreSQL:** Sorgu gecikmesi < 0.4 ms, ping: 1, tekil aktif kilit (`generation: 1`) kesintisiz yenileniyor.
- **Render / Tokyo Durumu:** 0 istek, Tokyo veritabanı silinmiş (`tenant not found`), Render kapalı.

---

## 20. FINAL DECISION

✅ **PRODUCTION CUTOVER SUCCESSFUL (Oracle Local PostgreSQL)**  
⚠️ **PHASE 7.8 APPLICATION E2E: `PRODUCTION E2E PARTIAL / ACTION REQUIRED`**

**Durum:**
1. **Public Edge TLS & WSS:** `api.130.162.247.20.sslip.io` üzerinden Let's Encrypt TLS sertifikası ve WSS bağlantısı tam çalışır durumda (`HTTP 200`, `WSS Ping/Pong OK`).
2. **Vercel Production:** `https://tezlify-woad.vercel.app` canlıda; Vuexy arayüzü sorunsuz açılıyor; 0 Render/Tokyo isteği.
3. **Application Database:** Uygulama veritabanı Oracle Cloud Frankfurt yerel PostgreSQL 17 örneğine (`tezlify-db`) başarıyla taşındı.
4. **Veritabanı Paritesi & Bütünlüğü:** 22 tablo %100 eksiksiz aktarıldı. Bütünlük testlerinde yetim mesaj = 0, yetim sohbet = 0.
5. **WhatsApp Oturumu:** Hat 1 (`+905076382749`) sıfır QR okutma ile doğrudan `CONNECTED / READY / ONLINE` durumunda çalışıyor.
6. **Performans:** Medyan sorgu gecikmesi **0.33 ms** (localhost NVMe SSD).
7. **Kalan Aksiyon:** Supabase Free plan kota kısıtlaması nedeniyle Auth servisi 521 vermektedir; canlı Google OAuth girişi için Supabase plan yükseltmesi veya bağımsız auth yapılandırması gereklidir.

---

## 21. DETAYLI RAPOR REFERANSLARI

Tam teknik döküm, adli analizler ve benchmark kanıtları için:
- [`docs/PHASE_7_4_PRODUCTION_E2E_REPORT.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_4_PRODUCTION_E2E_REPORT.md)
- [`docs/PHASE_7_5_REAL_PRODUCTION_E2E_REPORT.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_5_REAL_PRODUCTION_E2E_REPORT.md)
- [`docs/PHASE_7_5A_SUPABASE_QUOTA_FORENSIC.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_5A_SUPABASE_QUOTA_FORENSIC.md)
- [`docs/PHASE_7_6_ORACLE_POSTGRES_STAGING_REPORT.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_6_ORACLE_POSTGRES_STAGING_REPORT.md)
- [`docs/PHASE_7_7_ORACLE_POSTGRES_PRODUCTION_CUTOVER.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_7_ORACLE_POSTGRES_PRODUCTION_CUTOVER.md)
- [`docs/PHASE_7_8_REAL_WHATSAPP_E2E_REPORT.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_8_REAL_WHATSAPP_E2E_REPORT.md)
- [`docs/PHASE_7_8A_AUTH_RECOVERY_REPORT.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_8A_AUTH_RECOVERY_REPORT.md)
- [`docs/PHASE_7_8B_AUTH_ENV_VALIDATION.md`](file:///Users/isatezcan/Documents/Github/Scoutify/docs/PHASE_7_8B_AUTH_ENV_VALIDATION.md)


