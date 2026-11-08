# TEZLIFY WHATSAPP — GERÇEK ZAMANLI MESAJ VE BİLDİRİM DAĞITIM VE CANLI DOĞRULAMA RAPORU

**Tarih:** 2026-11-08  
**Aşama:** Aşama 2B — Push, Production Deploy ve Canlı Doğrulama  
**Durum:** `DEPLOYED & VERIFIED — READY FOR PHYSICAL DEVICE ACCEPTANCE`  

---

## 1. Commit ve Remote Push Özeti

- **Önceki Production Commit (HEAD~1):** `f3f2f4c07f785b5b309eea11662319a6f0a18711` (`fix(whatsapp): preserve view-once messages and revoke tombstones`)
- **Yeni Production Commit (HEAD):** `b24665bcbf6121ac8d7d4c67ced358b6039e420f` (`fix(whatsapp): restore realtime inbound messages and notifications`)
- **Target Branch:** `main`
- **Remote Push Komutu:** `git push origin main`
- **Remote Push Çıktısı:** `f3f2f4c..b24665b main -> main` (temiz, fast-forward)
- **Remote HEAD Doğrulaması (`git rev-parse origin/main`):** `b24665bcbf6121ac8d7d4c67ced358b6039e420f`

---

## 2. Dağıtım Bilgileri ve Orkestrasyon

- **Resmî Dağıtım Komutu:** `ALLOW_DIRTY=1 bash scripts/deploy/release.sh`
- **Release ID:** `20261108T124615Z`
- **Yedek Dizini (Sunucu):** `/opt/tezlify/backups/releases/20261108T124615Z`
- **Geri Dönüş (Rollback) Etiketleri:**
  - Backend: `tezlify-backend:pre-20261108T124615Z`
  - Gateway: `tezlify-gateway:pre-20261108T124615Z`
  - Rollback komutu: `bash scripts/deploy/host-release.sh --rollback-to 20261108T124615Z`
- **Oluşturulan Yeni Docker İmajları:**
  - Backend Image: `sha256:2d479a417f4623809d317194873f7c58547243306033da84f4581bcb49eb4f32`
  - Gateway Image: `sha256:42b604e9d1aef4c4bef1833f744b279112da90eb75af5faeb4abe68f49ca25d4`
- **Aday Sağlık Kapısı (Candidate Island Health):** Port 8001 üzerinde izole container ayağa kaldırılmış, `/health` 200 OK yanıtı alındıktan sonra canlı cutover yapılmıştır.

---

## 3. Production Doğrulama Sonuçları

### 3.1. `.deployed-commit` Doğrulaması
- **Sunucudaki Dosya (`/opt/tezlify/.deployed-commit`):**  
  `b24665bcbf6121ac8d7d4c67ced358b6039e420f`  
  *(Hedef commit hash'i ile birebir eşleşmektedir).*

### 3.2. Servis ve Konteyner Durumları (`docker ps`)
- `tezlify-backend`: **Up (healthy)** — Port 8000/tcp
- `tezlify-gateway`: **Up (healthy)** — Port 8787/tcp
- `tezlify-caddy`: **Up 3 weeks (healthy)** — Port 80/443
- `tezlify-db`: **Up 5 weeks (healthy)** — Port 5432/tcp

### 3.3. Backend Health ve Gateway Bridge Durumu (`GET /health`)
- **Genel Durum:** `{"status":"healthy","service":"Tezlify Backend API","version":"1.0.0"}`
- **Gateway Bridge:**
  - `connected`: `true`
  - `last_connected_at`: `2026-11-08T12:48:02.482841+00:00`
  - `last_event_at`: `2026-11-08T12:48:24.312956+00:00`
  - `last_pong_at`: `2026-11-08T12:48:22.484995+00:00`
  - `reconnect_count`: `1`

### 3.4. WhatsApp Gateway ve Oturum Durumu (`GET http://gateway:8787/health`)
- **Gateway Status:** `ok`
- **Database:** `connected`
- **Bağlı Oturum Sayısı:** `total: 1, connected: 1, pending_qr: 0`
- **Canlı Oturum ID:** `00815dc9-c0cb-40b1-8d41-a2cf64674ec4`
- **Oturum Kimliği:** `905413749073:97@s.whatsapp.net` / LID: `62771114836011:97@lid`
- **Oturum Korunumu:** Mevcut oturum kesintisiz olarak korunmuş, QR kodu bekleme veya oturum düşmesi yaşanmamıştır (`App-state collections healthy; recovery complete`).

### 3.5. Frontend Canlı Varlık (Asset) Doğrulaması
- **Vite Bundle Giriş Noktası:** `index-BxnHNJ_5.js`
- **Hash Bütünlüğü:** `deploy-hashes.json` içindeki 39 dosya hash'i ile sunucuda servis edilen varlıkların hash'leri birebir aynıdır (`[release] frontend hash'leri birebir ayni`).
- **Smoke Doğrulaması (`verify-production-whatsapp.mjs`):** 6/6 test başarıyla geçti.

### 3.6. Log ve Hata Karşılaştırması
- **Backend Logları:** Cutover sonrasında hiçbir `ERROR`, `CRITICAL` veya `Traceback` oluşmamıştır. Gelen istekler `200 OK` ile karşılanmaktadır.
- **Gateway Logları:** Baileys soketi başarıyla ayağa kalkmış (`socket_start_to_ready_ms: 3528ms`), outbox olayları backend'e akmaya devam etmektedir.

---

## 4. Başarısız veya Yapılamayan Kontroller

Güvenlik sınırları ve kurallar gereği aşağıdakiler salt okunur otomasyon kapsamı dışındadır:
- Production ortamına yapay/otomatik test mesajı gönderilmemiştir.
- Kullanıcı adına canlı WhatsApp mesajlaşması simüle edilmemiştir.

---

## 5. Gerçek Cihazda Kullanıcı Tarafından Test Edilmesi Gereken Noktalar

Kullanıcı kendi WhatsApp cihazından Tezlify hesabına gerçek bir mesaj göndererek aşağıdaki kabul kriterlerini doğrulayabilir:

1. **Aktif Olmayan Sohbete Mesaj Gelmesi:**
   - Tezlify'da A sohbeti açıkken veya Leads/Campaigns sekmesindeyken B kişisinden yeni mesaj gelmesi.
   - Ekranın sağ üst köşesinde toast bildirimi çıkması ve mesaj önizlemesinin (metin veya medya ikonu) görünmesi.
   - Toast bildirimi tıklandığında doğrudan B sohbetine yönlenilmesi.
2. **Aktif Sohbete Mesaj Gelmesi:**
   - Açık olan sohbete mesaj geldiğinde sayfa yenilenmeden mesaj balonunun gerçek zamanlı akması (mükerrer toast çıkmaması).
3. **Masaüstü Bildirimi ve Ses:**
   - Ayarlardan ses açıkken mesaj geldiğinde bildirim sesinin çalması.
   - Kullanıcı etkileşimi sonrasında Web Audio API AudioContext'in kilidinin açık kalması.
4. **View Once ve Revoke Bütünlüğü:**
   - Önceki düzeltmelerin (tek görüntülemelik fotoğraf ve herkesten silinen mesajlar) canlı ortamda sorunsuz çalışmaya devam etmesi.

---

## 6. Sonuç

Deploy işlemi ve deployment sonrası teknik doğrulamalar eksiksiz tamamlanmıştır.

- **Remote Commit:** `b24665bcbf6121ac8d7d4c67ced358b6039e420f`
- **Production Deployed Commit:** `b24665bcbf6121ac8d7d4c67ced358b6039e420f`
- **Servis / Gateway / WhatsApp Oturum Durumu:** `HEALTHY & CONNECTED`

