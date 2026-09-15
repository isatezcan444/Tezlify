# PHASE 7.8A — AUTH RECOVERY & FORENSIC REPORT

**Tarih / UTC Timestamp:** 2026-09-15 21:12:00 UTC (16 Eylül 2026 00:12:00 TSİ)  
**Mühendislik Rolü:** Principal Production SRE + Cloud Security & Identity Engineer  
**Supabase Frankfurt Proje Ref:** `qfypckopgelvsimfrfub` (Bölge: AWS eu-central-1)  
**Uygulama Veritabanı:** Oracle Frankfurt Yerel PostgreSQL 17 (`tezlify-db` — İZOLASYON KORUNDU)  
**Nihai Karar:** **`AUTH RECOVERY BLOCKED`**  
**Gereken Eylem:** **`USER ACTION REQUIRED`**

---

## 1. Güncel Supabase Auth Uç Nokta Durumu

Gerçek anon anahtarı ile Supabase Frankfurt projesinin kimlik doğrulama uç noktaları test edilmiştir:

| Uç Nokta | Metot | HTTP Kodu | Gözlemlenen Yanıt | Durum |
|---|---|---|---|---|
| `/auth/v1/health` | GET | **521** | `error code: 521` (Cloudflare) | 🔴 Web server is down |
| `/auth/v1/settings` | GET | **521** | `error code: 521` (Cloudflare) | 🔴 Web server is down |
| `/auth/v1/authorize?provider=google...` | GET | **521** | `error code: 521` (Cloudflare) | 🔴 Web server is down |

### Adli Bulgular:
1. Cloudflare edge katmanı bağlantıyı kabul etmekte ancak Supabase Frankfurt `qfypckopgelvsimfrfub` origin sunucusu TCP bağlantısını reddetmektedir (HTTP 521).
2. Supabase Free Plan politikası uyarınca kota aşımı yaşayan organizasyonlarda compute servisleri (Kong, GoTrue Auth, PostgREST) durdurulmuştur.

---

## 2. Dashboard ve Kota Durumu

Phase 7.5A'da teyit edilen ve geçerliliği süren durum:
- **Organizasyon:** `ISA`
- **Plan:** `Free Plan`
- **Fatura Dönemi:** `27 Ağustos 2026 – 27 Eylül 2026`
- **Durum:** **RESTRICTED**
- **Egress Kullanımı:** **8.69 GB / 5 GB (%174)** — 3.69 GB kota aşımı.
- **Sıfırlanma Tarihi:** `27 Eylül 2026` (Kota yenilenmesine 11-12 gün bulunmaktadır).

---

## 3. Google Provider & URL Yapılandırması

Mevcut frontend ve kimlik doğrulama yapılandırması incelenmiştir:

- **Google Provider:** Kod ve OAuth akışında `provider: 'google'` tanımlı.
- **Site URL:** `https://tezlify-woad.vercel.app`
- **Redirect URL:** `https://tezlify-woad.vercel.app/**`
- **Google OAuth Callback URL:** `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/callback`
- **Client ID & Client Secret:** Frontend koduna sızdırılmamış; güvenli bir şekilde Supabase Dashboard backend vault'unda saklanmaktadır.

---

## 4. Vercel Ortam Değişkenleri İncelemesi

`frontend/.env.production` dosyasındaki ve build yapılandırmasındaki anon anahtarı incelenmiştir:

- **URL:** `VITE_SUPABASE_URL=https://qfypckopgelvsimfrfub.supabase.co`
- **Anon Key Doğrulaması:**
  - Mevcut ve dolu.
  - JWT Başlık: `alg: HS256, typ: JWT`
  - Issuer (`iss`): `supabase`
  - Ref (`ref`): `qfypckopgelvsimfrfub` (Frankfurt projesine ait)
  - Rol (`role`): `anon`
  - Son Geçerlilik (`exp`): `2105052693` (2036 yılına kadar geçerli)
- **Vercel Build Notu:** Vercel Dashboard üzerinde proje ortam değişkenlerine `VITE_SUPABASE_ANON_KEY` eklenmelidir; aksi halde Vite derlemesi sırasında `import.meta.env.VITE_SUPABASE_ANON_KEY` boş kalmaktadır.

---

## 5. Gerçek Tarayıcı Auth Testi

Gerçek Chromium tarayıcısı ile `https://tezlify-woad.vercel.app` açılmış ve "Continue with Google" akışı tetiklenmiştir:

- **Tarayıcı Yönlendirmesi:** `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Ftezlify-woad.vercel.app...`
- **Tarayıcı Sonucu:** Cloudflare Error 521 sayfası yüklendi.
- **Sınıflandırma:** **`AUTH_PROJECT_RESTRICTED`**
- **Otomasyon Notu:** Supabase Auth servisi çalışmadığından ve insan etkileşimi (Google 2FA / hesap seçici) gerektiğinden **`NOT EXECUTED — INTERACTIVE GOOGLE LOGIN REQUIRED`**.

---

## 6. Mimari Bütünlük ve İzolasyon Doğrulaması

Uygulama veritabanının Oracle Frankfurt yerel PostgreSQL 17 (`tezlify-db`) üzerinde izole ve bağımsız çalıştığı teyit edilmiştir:

```bash
docker exec tezlify-db psql -U tezlify -d tezlify -c 'SELECT 1 AS ping, count(*) FROM messages;'
# ping: 1 | total_messages: 13,279
```

- **Uygulama Veritabanı Etkilenme Durumu:** **%0 (SIFIR ETKİ)**.
- WhatsApp gateway, FastAPI backend ve Caddy proxy Supabase kesintisinden tamamen bağımsız çalışmaktadır.
- Supabase Frankfurt yalnızca Auth katmanı olarak konumlandırılmıştır.

---

## 7. Mevcut Kullanıcı Verisi Güvenliği

Oracle yerel PostgreSQL veritabanındaki `profiles` tablosu kontrol edilmiştir:

- Toplam 3 kayıtlı kullanıcı profili (`e512dd40...`, `3fa08111...`, `f65642ab...`) eksiksiz korunmaktadır.
- Hiçbir `DELETE`, `UPDATE` veya `INSERT` mutasyonu yapılmamıştır.

---

## 8. Kullanıcı Kararı ve Çözüm Seçenekleri Analizi

Supabase Frankfurt projesinin kotası fatura dönemi (27 Eylül 2026) gelmeden otomatik olarak sıfırlanmayacağından **USER ACTION REQUIRED** bulunmaktadır:

| Kriter | Seçenek A: Mevcut Projeyi Pro'ya Yükseltmek | Seçenek B: Yeni Free Proje Açmak |
|---|---|---|
| **Maliyet** | $25 / ay | **$0 / ay (Ücretsiz)** |
| **Kurtarma Süresi** | **Anında (< 2 dakika)** | ~15-20 dakika konfigürasyon |
| **Ayar Değişikliği** | **Sıfır değişiklik** (URL ve key'ler aynı kalır) | Google OAuth Callback, Vercel ENV ve Backend env güncellenir |
| **Kullanıcı ID (sub) Riski** | **Sıfır risk** (Mevcut UUID'ler korunur) | Yeni Google login yeni UUID üretebilir (Profile mapping gerekebilir) |
| **Gelecek Egress Riski** | 250 GB kota (Limit aşımı imkansız) | Supabase artık DB olarak kullanılmadığı için <50 MB/ay (Limit aşılmaz) |

---

## 9. Nihai Karar

# **`AUTH RECOVERY BLOCKED`**

**Kesin Blocker:**  
Supabase Frankfurt projesi `qfypckopgelvsimfrfub` Free plan Egress kotasını (%174 — 8.69 GB / 5 GB) aştığı için Supabase tarafından Cloudflare 521 (Web server is down) modunda askıya alınmıştır. Google OAuth yönlendirmesinin çalışması için kullanıcının Seçenek A (Pro yükseltmesi) veya Seçenek B (Yeni ücretsiz Auth projesi) yönünde karar vermesi gerekmektedir.
