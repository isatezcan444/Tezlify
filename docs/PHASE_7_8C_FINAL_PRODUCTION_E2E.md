# PHASE 7.8C — POST-SUPABASE-RECOVERY AUTH & REAL LOGIN VALIDATION REPORT

**Tarih / UTC Timestamp:** 2026-09-15 21:18:00 UTC (16 Eylül 2026 00:18:00 TSİ)  
**Mühendislik Rolü:** Principal Production SRE + Identity & Realtime Systems Engineer  
**Frontend Production URL:** `https://tezlify-woad.vercel.app`  
**Public API URL:** `https://api.130.162.247.20.sslip.io`  
**Oracle VM:** `130.162.247.20`  
**Production DB:** Oracle Local PostgreSQL 17 (`tezlify-db` — **100% İZOLASYON KORUNDU**)  
**Supabase Frankfurt:** `qfypckopgelvsimfrfub`  
**Nihai Karar:** **`PRODUCTION E2E PARTIAL / ACTION REQUIRED`**

---

## 1. Supabase Auth Health ve Settings İncelemesi

Gerçek `anon` anahtarı ile Supabase Frankfurt Auth servisinin sağlık durumu test edilmiştir:

| Uç Nokta | Metot | HTTP Durumu | Yanıt Detayı | Durum |
|---|---|---|---|---|
| `/auth/v1/health` | GET | **503 Service Unavailable** | `upstream connect error or disconnect/reset before headers... transport failure reason: delayed connect error: 111` | 🔴 Kapalı |
| `/auth/v1/settings` | GET | **503 Service Unavailable** | `upstream connect error or disconnect/reset before headers... transport failure reason: delayed connect error: 111` | 🔴 Kapalı |
| `/auth/v1/authorize?provider=google...` | GET | **503 Service Unavailable** | `upstream connect error or disconnect/reset before headers... transport failure reason: delayed connect error: 111` | 🔴 Kapalı |

### Adli Teşhis:
Supabase Envoy ingress katmanı, backend GoTrue/Auth konteynerine bağlanırken bağlantı reddi (`111 Connection refused`) almaktadır. Proje, Free plan Egress kotası aşımı (**8.69 GB / 5 GB — %174**) nedeniyle Supabase altyapısı tarafından askıda tutulmaya devam etmektedir.

---

## 2. Google Provider ve Callback Yapılandırması

- **Google Provider:** Kod ve konfigürasyonda `provider: 'google'` olarak tanımlı.
- **Callback URL:** `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/callback`
- **Frontend Redirect:** `https://tezlify-woad.vercel.app`
- **Durum:** Supabase Auth servisi 503 döndürdüğü için Google OAuth yönlendirmesi GoTrue tarafından üretilememektedir.

---

## 3. Vercel Üretim Ortamı (Environment) Doğrulaması

Phase 7.8B'de gerçekleştirilen düzeltme teyit edilmiştir:
- **`VITE_SUPABASE_URL`**: `https://qfypckopgelvsimfrfub.supabase.co`
- **`VITE_SUPABASE_ANON_KEY`**: Mevcut, dolu, Frankfurt ref'e (`qfypckopgelvsimfrfub`) ait, `role: anon`.
- **Canlı Bundle:** `https://tezlify-woad.vercel.app/assets/index-Bm9fQsIb.js`
- **Konsol Doğrulaması:** `[Supabase] VITE_SUPABASE_ANON_KEY is not defined` uyarısı **%100 çözülmüştür**.

---

## 4. Gerçek Tarayıcı Login Testi (Real Browser Login)

Gerçek Chromium tarayıcısı (Playwright) ile `https://tezlify-woad.vercel.app` açılarak "Continue with Google" akışı icra edilmiştir:

1. Tarayıcı `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/authorize?provider=google...` adresine yöneldi.
2. Supabase Cloudflare/Envoy katmanından `HTTP 503: upstream connect error (error: 111)` döndü.
3. Kural gereği: *"Google MFA / account chooser nedeniyle otomasyon duruyorsa: NOT EXECUTED — INTERACTIVE GOOGLE LOGIN REQUIRED yaz. Fake PASS verme."*  
   **Sonuç:** **`NOT EXECUTED — INTERACTIVE GOOGLE LOGIN REQUIRED (BLOCKED BY SUPABASE 503 SERVICE UNAVAILABLE)`**.

---

## 5. Authenticated Dashboard & Uygulama Sayfaları

- AuthGate koruması gereği oturum açılmadan Dashboard'a erişilmez.
- `GET /api/v1/whatsapp/sessions` uç noktası fail-closed prensibiyle `HTTP 401 UNAUTHORIZED` dönerek güvenliği teyit etmiştir.
- **Sonuç:** **`NOT EXECUTED — REQUIRES ACTIVE AUTHENTICATED SESSION`**.

---

## 6. Harici Canlı WhatsApp Inbound & Outbound Mesajlaşma

- Harici fiziksel test cihazı veya test telefonu sağlanmadığından dış numaralara gerçek mesaj gönderimi ve fiziksel teslim takibi (SENT -> DELIVERED -> READ) icra edilmemiştir.
- **Inbound Sonucu:** **`NOT EXECUTED`**.
- **Outbound Sonucu:** **`NOT EXECUTED`**.
- **Delivery Status:** **`NOT EXECUTED`**.

---

## 7. Oracle Üretim Altyapısı Sağlık Durumu (Final Health)

Oracle Cloud Frankfurt VM üzerindeki tüm servisler eksiksiz çalışmaktadır:

| Bileşen | Metot / Metrik | Gözlemlenen Durum |
|---|---|---|
| **Local PostgreSQL** | `SELECT 1;` | `ping: 1`, 0.33 ms gecikme, **14,897 toplam mesaj** |
| **Baileys Gateway** | `http://gateway:8787/health` | `status: ok`, `total: 2`, `connected: 1`, `pending_qr: 0` |
| **WhatsApp Oturumu** | `http://gateway:8787/sessions` | `Hat 1 (+905076382749)`: `CONNECTED`, `online: true`, `sync: ready` |
| **Socket Lease** | `whatsapp_private.socket_leases` | **Tam 1 aktif kilit** (`generation: 1`, `is_active: t`) |
| **Gateway Güvenliği** | Gateway logları | **0 conflict, 0 Stream Errored, 0 QR generated, 0 lease loss** |
| **Tokyo İzolasyonu** | Tokyo DB bağlantı denemesi | `FATAL: tenant not found` (Tokyo silinmiş, 0 lease) |

---

## 8. Nihai Karar

# **`PRODUCTION E2E PARTIAL / ACTION REQUIRED`**

**Açıklama:**  
Oracle VM üzerindeki yerel veritabanı, FastAPI backend, Caddy ters vekil sunucusu ve Baileys WhatsApp Gateway %100 kusursuz ve kararlı şekilde çalışmaktadır. Vercel frontend bundle'ındaki anon key entegrasyonu tamamlanmıştır. Ancak Supabase Frankfurt Auth projesinin Free plan Egress kotası (%174) nedeniyle askıda olması, Google OAuth login yönlendirmesini engellemektedir.

**Gereken Kullanıcı Kararı:**
1. **Seçenek A:** Supabase Dashboard üzerinden mevcut `ISA` organizasyonunu **Pro Plan**'a yükseltmek ($25/ay) -> Kısıtlama < 2 dakikada anında kalkar, kod ve ayar değişikliği gerekmez, kullanıcı UUID'leri aynen korunur.
2. **Seçenek B:** Yeni bir ücretsiz Supabase organizasyonu ve Frankfurt Auth projesi açmak ($0/ay) -> Google callback ve Vercel env güncellenir, yeni Google login UUID'leri için veritabanında profil mapping yapılır.
