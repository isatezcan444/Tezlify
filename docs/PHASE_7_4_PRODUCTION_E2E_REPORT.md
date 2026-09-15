# Tezlify — Phase 7.4 Frankfurt Supabase Binding & Production E2E Verification Report

**Tarih / Zaman:** 2026-09-15T21:24:00+03:00  
**Rol:** Principal Migration Architect + SRE + Vercel Deployment Engineer  
**Git Branch / Commit:** `main` (`29fcc93`)  
**Nihai Karar:** **`BLOCKED`** (Public DNS `A` Kaydı Eksik / `NXDOMAIN` — STOP RULE Devrede)

---

## 1. Phase 7.4 Kapsamında Yapılan Düzeltmeler

### 1.1 Frontend Supabase Binding & Tokyo Temizliği (PASS)
- `frontend/src/lib/supabase.ts` dosyası denetlendi:
  - Eski Tokyo hardcoded URL (`https://pzpgjjtefeplygqcxfsj.supabase.co`) kaldırıldı.
  - Kod içindeki hardcoded Tokyo `anon` JWT token'ı tamamen temizlendi.
  - İstemci doğrudan Frankfurt Supabase projesine (`https://qfypckopgelvsimfrfub.supabase.co`) bağlandı.
- `frontend/.env.production`:
  - `VITE_SUPABASE_URL=https://qfypckopgelvsimfrfub.supabase.co` olarak güncellendi.
- **Production Derleme Doğrulaması (`npm run build`):**
  - Derleme 1.75 saniyede sıfır hatayla tamamlandı.
  - `dist/` çıktı paketi tarandı: Tokyo proje referansı (`pzpgjjtefeplygqcxfsj`) paket içerisinde **SIFIR (0) adet** tespit edildi (%100 temiz).
  - Frankfurt proje URL'i paket içerisine başarıyla enjekte edildi.

### 1.2 WhatsApp Gateway Bağlantı Dayanıklılığı & Auto-Restore (PASS)
- Oracle VM compose dosyasında `WHATSAPP_AUTO_RESTORE: "true"` yapılarak yeniden başlatmalarda otomatik kurtarma güvenceye alındı.
- `whatsapp-gateway/src/database/postgres-pool.js`: Uzak pooler bağlantı zaman aşımı `30_000 ms` (30 saniye) değerine çıkarıldı.
- `whatsapp-gateway/src/session-manager.js`: Geçici havuz zaman aşımlarında hattın `UNAVAILABLE` durumunda kilitli kalması engellendi; bounded exponential backoff ile otomatik yeniden deneme mantığı eklendi.
- Oracle Gateway yeniden başlatıldı ve hat anında doğrulandı:
  - Durum: **`CONNECTED` / `ONLINE` / `READY`**
  - QR Re-scan: **GEREKMEDİ (0)**
  - Senkronizasyon: **%100 (READY)**

---

## 2. Public DNS Doğrulama (FAIL - STOP)

`api.tezlify.com` için 3 bağımsız public DNS çözümleyicisi üzerinden sorgulama yapılmıştır:

```bash
dig +noall +answer api.tezlify.com A @1.1.1.1
dig +noall +answer api.tezlify.com A @8.8.8.8
dig +noall +answer api.tezlify.com A
```

| Çözümleyici | Kayıt Türü | Sorgu | Sonuç | Durum |
| :--- | :--- | :--- | :--- | :--- |
| **Cloudflare (`1.1.1.1`)** | A | `api.tezlify.com` | `status: NXDOMAIN` | ❌ **Eksik** |
| **Google (`8.8.8.8`)** | A | `api.tezlify.com` | `status: NXDOMAIN` | ❌ **Eksik** |
| **Sistem Çözümleyicisi** | A | `api.tezlify.com` | `status: NXDOMAIN` | ❌ **Eksik** |
| **Cloudflare / Google** | AAAA | `api.tezlify.com` | `status: NXDOMAIN` | ℹ️ Temiz (IPv6 çakışması yok) |

> [!CAUTION]
> **STOP RULE (Adım 1):**  
> `api.tezlify.com` için beklenen `130.162.247.20` IP adresine işaret eden bir `A` kaydı genel DNS hiyerarşisinde bulunmamaktadır (`NXDOMAIN`).  
> Kural: *"A kaydı beklenen IP değilse DUR."* gereğince canlı trafik adımlarına geçilmemiştir.

---

## 3. Public HTTPS & TLS Durumu

- **`curl -i https://api.tezlify.com/health`** → `curl: (6) Could not resolve host: api.tezlify.com`
- **Caddy ACME Log Kanıtı (`tezlify-caddy`):**
  ```json
  {"level":"error","logger":"http.acme_client","msg":"challenge failed","identifier":"api.tezlify.com","problem":{"type":"urn:ietf:params:acme:error:dns","detail":"DNS problem: NXDOMAIN looking up A for api.tezlify.com - check that a DNS record exists for this domain"}}
  ```
- **Teşhis:** Caddy sanal host olarak `api.tezlify.com` yapılandırmasını yüklemiş durumdadır. Ancak Let's Encrypt genel DNS sorgusunda domaini bulamadığı için HTTP-01 / TLS-ALPN-01 doğrulamasını tamamlayamamaktadır.

---

## 4. WhatsApp & Veritabanı Güvenlik İzolasyonu (PASS)

| Alan | Kontrol | Değer / Durum | Sonuç |
| :--- | :--- | :--- | :--- |
| **Oracle Kilit** | `Frankfurt socket_leases` | **1** aktif kilit (`instance: d21f2e66...`, `generation: 1`) | **PASS** |
| **Tokyo Kilit** | `Tokyo socket_leases` | **0** (Sıfır kilit) | **PASS** |
| **Tokyo Gateway** | `Tokyo active gateway_sessions` | **0** (Sıfır aktif oturum) | **PASS** |
| **WhatsApp Durumu** | `Hat 1 (+9050***2749)` | **CONNECTED / ONLINE / READY** (%100 senkron) | **PASS** |
| **Render Servisi** | Render Free Web Service | Silinmedi, acil rollback için hazır bekletiliyor | **PASS** |

---

## 5. Doğrulama Tablosu

| Kontrol | Sonuç | Kanıt / Durum |
| :--- | :--- | :--- |
| **DNS A Kaydı** | ❌ **FAIL** | `NXDOMAIN` (1.1.1.1, 8.8.8.8, System) |
| **TLS / HTTPS** | ❌ **FAIL** | DNS olmadan sertifika oluşturulamadı |
| **Public WSS** | ⏸️ **BLOCKED** | DNS/TLS bağımlılığı nedeniyle beklemede |
| **Frankfurt Supabase Binding** | ✅ **PASS** | `frontend/src/lib/supabase.ts` ve `.env.production` güncellendi, Tokyo ref temizlendi |
| **Production Build** | ✅ **PASS** | `dist/` içinde Tokyo referansı = 0, Frankfurt aktif |
| **Google OAuth** | ⚠️ **ACTION REQ** | Google Console callback URI tanımlanmalı |
| **Vercel Production** | ⏸️ **BLOCKED** | DNS ve Frankfurt anon key bekleniyor |
| **Browser Login** | ⏸️ **BLOCKED** | Public domain bekleniyor |
| **WhatsApp Session** | ✅ **PASS** | `0e8f8a0f...` CONNECTED / READY / ONLINE |
| **Inbound / Outbound Test** | ⏸️ **NOT EXECUTED** | Public traffic cutover tamamlanamadığı için çalıştırılmadı |
| **Tokyo İzolasyonu** | ✅ **PASS** | Tokyo leases = 0, çakışma riski sıfırlandı |
| **Render İzolasyonu** | ✅ **PASS** | Render silinmedi, trafik almıyor, socket yarışmıyor |

---

## 6. Final Karar: BLOCKED

### Gerekçe:
1. **Public DNS A Kaydı Yok:** `api.tezlify.com` adresi genel DNS sunucularında çözümlenememektedir (`NXDOMAIN`).
2. **Frankfurt Supabase Anon Key Bekleniyor:** `frontend/.env.production` dosyasında `VITE_SUPABASE_ANON_KEY` boş durumdadır; Supabase Frankfurt Dashboard (`Project Settings -> API`) sayfasındaki public `anon` anahtarı tanımlanmalıdır.

---

## 7. Kullanıcı Aksiyon Listesi (Engeli Kaldırmak İçin)

1. **DNS A Kaydını Ekleyiniz:**
   - **Type:** `A`
   - **Name:** `api`
   - **Value:** `130.162.247.20`
   - **TTL:** `300` (Cloudflare kullanıyorsanız: *DNS Only / Gri Bulut*)

2. **Frankfurt Supabase Anon Key'i İletiniz:**
   - Supabase Frankfurt Dashboard (`https://supabase.com/dashboard/project/qfypckopgelvsimfrfub/settings/api`) sayfasından `Project API keys` altındaki **`anon public`** anahtarını iletiniz.

3. **Google OAuth Callback URI'sini Ekleyiniz:**
   - Google Cloud Console -> `Credentials` -> OAuth 2.0 Web Client içine şu URI'yi ekleyiniz:  
     `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/callback`
