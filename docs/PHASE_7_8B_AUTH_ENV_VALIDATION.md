# PHASE 7.8B — VERCEL AUTH ENV + SUPABASE AUTH RECOVERY VALIDATION REPORT

**Tarih / UTC Timestamp:** 2026-09-15 21:15:00 UTC (16 Eylül 2026 00:15:00 TSİ)  
**Mühendislik Rolü:** Principal Production SRE + Frontend Build & Cloud Security Engineer  
**Git Commit:** `8631a84` (`fix(auth): bind Frankfurt Supabase anon key in production frontend environment`)  
**Frontend Canlı URL:** `https://tezlify-woad.vercel.app`  
**Canlı JS Bundle:** `https://tezlify-woad.vercel.app/assets/index-Bm9fQsIb.js`  
**Supabase Frankfurt Proje Ref:** `qfypckopgelvsimfrfub`  
**Oracle Local PostgreSQL:** `tezlify-db` (Uygulama Veritabanı — **%100 İZOLASYON KORUNDU**)  
**Sonuçlar:**  
1. **`VERCEL_AUTH_ENV_FIXED`** (Vercel ortam değişkeni ve bundle sorunu giderildi)  
2. **`AUTH_BLOCKED_BY_BILLING_QUOTA`** (Supabase Frankfurt projesi Free plan egress kotası nedeniyle askıda)

---

## 1. İki Problemin Kesin Ayrımı (Forensic Separation)

Phase 7.8A sonrasında kimlik doğrulama katmanındaki iki bağımsız problem birbirinden kesin olarak ayrılmıştır:

1. **Frontend / Vercel Build Problemi:**  
   `frontend/.env.production` dosyasındaki `VITE_SUPABASE_ANON_KEY` yerel olarak mevcuttu ancak git'e commit edilip GitHub'a pushlanmamıştı (`git diff` boş anahtarı gösteriyordu). Bu nedenle Vercel otomatik build'i anon key olmadan derlemiş ve tarayıcıda `[Supabase] VITE_SUPABASE_ANON_KEY is not defined in production environment` uyarısı üretilmişti.
2. **Supabase Frankfurt Altyapı Problemi:**  
   Supabase Free planında fatura döneminde Egress kotası aşılmış (**8.69 GB / 5 GB — %174**), bu sebeple Supabase Frankfurt `qfypckopgelvsimfrfub` projesinin origin compute servisleri durdurulmuştur (`delayed connect error: 111`).

---

## 2. Vercel Env Düzeltmesi ve Production Redeployment

1. **Commit ve Push:**  
   `frontend/.env.production` dosyası git'e eklenmiş ve `8631a84` commit'i ile `origin/main` dalına pushlanmıştır.
2. **Anon Key Doğrulaması:**
   - Mevcut: Evet (geçerli JWT)
   - Header Alg: `HS256`
   - Issuer (`iss`): `supabase`
   - Ref (`ref`): `qfypckopgelvsimfrfub` (Frankfurt projesi ile eşleşiyor)
   - Rol (`role`): `anon`
   - Geçerlilik (`exp`): `2105052693` (2036 yılına kadar geçerli)
3. **Vercel Otomatik Derlemesi:**  
   Vercel GitHub entegrasyonu commit'i algılayarak yeni production bundle'ını (`assets/index-Bm9fQsIb.js`) derlemiş ve canlıya almıştır.
4. **Gerçek Tarayıcı (Playwright Chromium) Kanıtı:**
   - `https://tezlify-woad.vercel.app` açıldı.
   - Sayfa HTTP 200 ile yüklendi.
   - **`[Supabase] VITE_SUPABASE_ANON_KEY is not defined` UYARISI %100 ORTADAN KALKTI.**
   - Konsolda 0 uyarı, 0 hata kaydedildi.

---

## 3. Supabase Frankfurt Auth Durumu

Yeni derlenen frontend ile canlı Vercel uygulamasında "Continue with Google" düğmesine tıklandı:

- **Hedef URL:** `https://qfypckopgelvsimfrfub.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Ftezlify-woad.vercel.app&access_type=offline&prompt=consent`
- **Uç Nokta Yanıtı:**  
  `HTTP 503 Service Unavailable` / `HTTP 521 Web server is down`
- **Ham Hata Gövdesi:**  
  `upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: 111`
- **Kök Neden:**  
  Supabase Envoy proxy'si backend konteynerine bağlanmaya çalışmakta ancak `111 Connection refused` almaktadır; çünkü compute örneği Egress kota aşımı nedeniyle Supabase tarafından durdurulmuştur.

---

## 4. Kullanıcı Aksiyon Seçenekleri ve Karşılaştırmalı Etki Analizi

Supabase Frankfurt projesinin Free plan kotası 27 Eylül 2026 tarihine kadar sıfırlanmayacağından, Google OAuth'un canlıda devreye alınması için aşağıdaki iki seçenekten biri seçilmelidir:

### Seçenek A: Mevcut Supabase Organizasyonunu Pro Plan'a Yükseltmek ($25/ay)
- **Yapılacak İşlem:**  
  Supabase Dashboard -> Organization `ISA` -> Settings -> Billing -> Upgrade to Pro Plan.
- **Teknik Etkileri:**
  - Kota derhal 250 GB Egress'e yükselir; kısıtlama anında kalkar.
  - `qfypckopgelvsimfrfub.supabase.co` compute konteynerleri derhal ayağa kalkar.
  - Google OAuth akışı **hiçbir kod, env veya redirect URL değişikliği olmadan hemen çalışır**.
- **Kullanıcı UUID Etkisi:** **Sıfır etki**. Mevcut `auth.users` ve `profiles` UUID eşleşmeleri (`f65642ab...`, `e512dd40...`, `3fa08111...`) aynen korunur; kullanıcı geçmiş sohbetlerini kesintisiz görür.
- **Süre:** < 2 dakika.

### Seçenek B: Yeni Ücretsiz Organizasyon + Yeni Frankfurt Auth Projesi ($0/ay)
- **Yapılacak İşlem:**
  1. Yeni bir Supabase hesabı/organizasyonu açılır (Free Plan).
  2. Frankfurt bölgesinde yeni bir proje oluşturulur.
  3. Yeni projenin Authentication -> Providers -> Google ayarlarına Google Client ID & Secret girilir.
  4. Google Cloud Console -> Authorized Redirect URIs listesine yeni callback URL (`https://<new-ref>.supabase.co/auth/v1/callback`) eklenir.
  5. `frontend/.env.production` içine yeni `VITE_SUPABASE_URL` ve `VITE_SUPABASE_ANON_KEY` girilir, commit & push yapılır.
  6. Oracle VM `/opt/tezlify/.env.production` dosyasında `SUPABASE_URL` ve `SUPABASE_JWT_SECRET` güncellenip backend yeniden başlatılır.
- **Kullanıcı UUID Etkisi & Risk:**  
  Google hesabı ile giriş yapıldığında yeni Supabase projesinde yeni bir UUID (`sub` claim) atanacaktır. Kullanıcının mevcut konuşmalarını görmeye devam edebilmesi için Oracle yerel PostgreSQL'deki `profiles.id` ve `conversations.user_id` yabancı anahtarlarının yeni UUID ile eşleştirilmesi gerekecektir.
- **Gelecek Kota Riski:** Sıfır. Çünkü uygulama veritabanı Oracle üzerinde çalıştığından, Supabase ayda yalnızca < 50 MB auth trafiği tüketecek ve 5 GB Free kotasını asla aşmayacaktır.
- **Süre:** ~15-20 dakika.

---

## 5. Oracle Üretim Altyapısı Sağlık ve İzolasyon Kanıtı

Supabase Auth kısıtlamasının Oracle VM ve uygulama veritabanına hiçbir etkisi olmadığı kanıtlanmıştır:

```bash
# 1. Yerel PostgreSQL Ping ve Gecikme
SELECT 1; # ping: 1, gecikme: 0.33 ms (NVMe SSD)

# 2. WhatsApp Gateway Durumu
curl -s http://gateway:8787/sessions
# {"id":"0e8f8a0f...","name":"Hat 1","phone":"+905076382749","status":"CONNECTED","online":true,"sync":"ready"}

# 3. Aktif Soket Kilidi
SELECT count(*) FROM whatsapp_private.socket_leases WHERE expires_at > now();
# oracle_active_leases: 1

# 4. Tokyo Durumu
# Tokyo DB: OperationalError tenant not found (deleted) -> 0 lease
```

---

## 6. Nihai Karar

1. **`VERCEL_AUTH_ENV_FIXED`** ✅  
   `VITE_SUPABASE_ANON_KEY` production build'ına başarıyla entegre edildi, konsol uyarısı kaldırıldı.
2. **`AUTH_BLOCKED_BY_BILLING_QUOTA`** ⚠️  
   Supabase Frankfurt Free plan kotası (%174) nedeniyle Auth servisi askıda; kullanıcının Seçenek A ($25 Pro upgrade) veya Seçenek B ($0 Yeni Free Auth projesi) arasında karar vermesi beklenmektedir.
