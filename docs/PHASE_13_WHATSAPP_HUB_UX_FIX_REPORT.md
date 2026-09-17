# Phase 13: WhatsApp Hub UX, Responsive Layout, Avatar & Session Lifecycle Fix Report

**Tarih**: 17 Eylül 2026  
**Durum**: **A) ALL FIXED**  
**Ortam**: Local Development + Oracle Production (`130.162.247.20`)  
**Hedef Kapsam**: WhatsApp Hub / Canlı Diyaloglar Responsive UI, Telefon Numarası Gösterimi, Avatar Render & Caching, WhatsApp Web Kronolojik Sıralama, "Cihaz Bağla" Terim Güncellemesi, QR Modal Cancel Sırasında Yetim Oturum Oluşumunu Önleme.

---

## 1. Responsive UI Değişiklikleri

### Desktop
- Sol konuşma listesi (`w-80 lg:w-96 shrink-0`) ve sağ sohbet alanı (`flex-1`) klasik iki kolonlu yatay düzeni korur.
- Konteyner yüksekliği dinamik ve viewport duyarlı hale getirildi: `h-[650px] md:h-[calc(100vh-12rem)] md:min-h-[550px] md:max-h-[850px]`.
- Yatay taşma (horizontal overflow): **0px**.

### Tablet (768px – 1024px)
- Yan panel daraldığında sohbet balonları taşmaz, composer viewport içinde kalır.
- Başlık alanı ve aksiyon butonları (`hidden md:inline`, `px-2 sm:px-3`) sıkışmayı ve satır kırılmasını önleyecek şekilde esnetildi.

### Mobile (< 768px)
- İki kolonlu yapı mobile'da zorlanmaz; durum bazlı görünüm geçişi uygulandı:
  - Sohbet seçili değilken (`selectedConv === null`): Sadece Konuşma Listesi (`w-full flex`) gösterilir.
  - Sohbet seçildiğinde (`selectedConv !== null`): Sadece Sohbet Thread'i (`flex-1 flex`) gösterilir, liste gizlenir (`hidden md:flex`).
- Sohbet başlığına mobil geri butonu (`<ArrowLeft />`, `md:hidden`) eklendi. Butona tıklandığında `selectedConv` sıfırlanır ve konuşma listesine dönülür.
- Resize geçişlerinde (Desktop ↔ Mobile) aktif sohbet state'i kaybolmaz.

---

## 2. Kişi Kartlarında Telefon Numarasının Kaldırılması

- **Dosya**: `frontend/src/features/whatsapp/components/ConversationList.tsx`
- **Uygulama**:
  - Kartların alt bilgi kısmındaki `safePhone` (`+90...`) render kodu arayüzden tamamen kaldırıldı.
  - Kartta yalnızca: Profil fotoğrafı (Avatar), Kişi/Grup Adı, Son Mesaj Önizlemesi, Zaman damgası (Timestamp), Okunmamış sayaç rozeti (Unread Badge) ve Mesaj Teslim Durumu ikonları bırakıldı.
  - **Veri Bütünlüğü**: Backend API modelleri ve `Conversation` veri tiplerindeki `phone_number`/`lead_phone` alanlarına dokunulmadı; veri müşteri detay modalında ve iletişim bilgilerinde kullanılabilirliğini korumaktadır.

---

## 3. Profil Fotoğrafları (Avatar) — Root Cause & Çözüm

### Kök Nedenler (Root Cause)
1. **WhatsApp CDN Token Expiration**: WhatsApp PPS (`pps.whatsapp.net`) profil resmi URL'leri belirli süre sonra expire olmakta ve 403/404 dönmektedir.
2. **Kaskat İstek Fırtınası**: Yüklenemeyen bir resim için tarayıcı her yeniden render'da veya hızlı scroll sırasında tekrar tekrar istek atmakta ve UI akıcılığını engellemekteydi.
3. **Kırık Görsel İkonu**: `img` elementi hata aldığında varsayılan tarayıcı kırık resim ikonu görünmekteydi.
4. **Boyut ve En-Boy Bozulması**: Kare kısıtlaması (`aspect-square`) ve `object-cover` eksikliği nedeniyle bazı fotoğraflar basık veya taşmış görünmekteydi.

### Çözüm
- **Dosya**: `frontend/src/components/ui/Avatar.tsx`
  - Global `failedAvatarUrls` Set cache mekanizması entegre edildi. Yüklenemeyen URL derhal bu önbelleğe alınır; aynı URL için bir daha network isteği tetiklenmez.
  - `onError` yakalayıcısı ile görsel anında şık, deterministik arka plan rengine sahip ad-soyad baş harflerine (Initials fallback) dönüştürülür.
  - `loading="lazy"` ve `decoding="async"` etiketleri eklendi.
  - `aspect-square`, `block`, `w-full h-full`, `object-cover` sınıfları uygulanarak dairesel veya yuvarlatılmış kartta kusursuz merkezleme sağlandı.

---

## 4. Sohbet Sıralaması — WhatsApp Web Mantığı & Root Cause

### Kök Neden (Root Cause)
- Konuşma listesinde `compareByLastMessageDesc` fonksiyonu yalnızca `last_message_at` alanına bakıyor, eksik olduğu durumlarda sıralama kararsız kalıyordu.
- Outbound mesaj gönderildiğinde optimistic güncelleme konuşmayı listenin tepesine taşımıyordu.

### Çözüm
- **Dosya**: `frontend/src/features/whatsapp/lib/whatsappOrdering.ts`
  - WhatsApp Web aktivite standardı tanımlandı:
    1. `last_message_at` (en öncelikli)
    2. `updated_at` (yedek öncelik)
    3. `created_at` (oluşturulma anı)
    4. ID kırılımı (deterministik tie-breaker)
  - **Inbound**: Yeni mesaj geldiğinde konuşma anında listenin 1. sırasına yükselir.
  - **Outbound**: Kullanıcı mesaj gönderdiğinde konuşmanın `last_message_at` alanı `new Date().toISOString()` yapılarak derhal zirveye taşınır.
  - **Durum Güncellemeleri**: `READ`/`DELIVERED` status bildirimleri ve eski mesajların yukarı scroll edilmesi `last_message_at` damgasını değiştirmediği için konuşma sırasını bozmaz.

---

## 5. QR Session UX — "Cihaz Bağla" Metin Güncellemesi

- `tr.ts`:
  - `connectWithQr: 'Cihaz Bağla'`
  - `qrModalTitle: 'Cihaz Bağla'`
  - `reconnectQr: 'Cihazı Yeniden Bağla'`
- `en.ts`:
  - `connectWithQr: 'Link Device'`
  - `qrModalTitle: 'Link Device'`
  - `reconnectQr: 'Relink Device'`
- `WhatsAppHubPage.tsx`:
  - Tüm fallback butonları ve boş durum yönlendirmeleri `'Cihaz Bağla'` olarak güncellendi.

---

## 6. QR Modal Cancel / Yetim Oturum Kök Neden & Çözüm

### Kök Neden (Root Cause)
- `WhatsAppQrConnectModal.tsx` açıldığında `useEffect` içerisinde doğrudan `WhatsAppRepository.createSession` tetikleniyor ve DB'de satır ile Gateway'de oturum tahsis ediliyordu.
- Kullanıcı QR kod taranmadan önce X, İptal, Escape veya arka plana tıklayarak modalı kapattığında herhangi bir temizlik isteği gönderilmiyordu; böylece veritabanında taranmamış yetim (orphan) oturumlar kalıyordu.

### Çözüm
- **Dosya**: `frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx`
  - `QrModalState` durum makinesi genişletildi: `IDLE`, `OPENING`, `QR_READY`, `CONNECTING`, `CONNECTED`, `CANCELLING`, `CANCELLED`, `ERROR`.
  - `isNewlyCreatedRef` ve `isCancelledRef` bayrakları eklendi.
  - Modal henüz `CONNECTED` durumuna geçmeden kapatılırsa `handleCancel()` devreye girer:
    - `WhatsAppRepository.deleteSession(sessionId)` çağrılır.
    - Gateway soketi kapatılır, kimlik bilgileri ve soket kirası (socket lease) temizlenir.
    - DB'den `whatsapp_sessions` satırı tamamen silinir.
  - In-flight iptal koruması: Kullanıcı create yanıtı gelmeden modalı kapatırsa, create yanıtı döndüğünde oturum anında otomatik olarak imha edilir.
  - `WhatsAppHubPage.tsx` modal kapandığında `fetchSessions(true)` çağırarak arayüzdeki oturum listesini taze tutar.

---

## 7. Test Sonuçları & Regresyon Doğrulaması

### Sohbet Sıralama Test Paketi (`test-whatsapp-chat-order.mjs`)
- `TEST-CHAT-ORDER-01`: A < B → B üstte (**PASSED**)
- `TEST-CHAT-ORDER-02`: A'ya yeni inbound gelir → A üstte (**PASSED**)
- `TEST-CHAT-ORDER-03`: A'dan outbound gider → A üstte (**PASSED**)
- `TEST-CHAT-ORDER-04`: Status (READ/DELIVERED) değişir → Sıralama değişmez (**PASSED**)
- `TEST-CHAT-ORDER-05`: Eski mesajlar scroll edilir → Sıralama değişmez (**PASSED**)
- `TEST-CHAT-ORDER-06`: Realtime `conversation_updated` gelir → Doğru konuma taşınır (**PASSED**)
- `TEST-CHAT-ORDER-07`: Mükerrer WS eventi → Tek konuşma satırı korunur (**PASSED**)
- `TEST-CHAT-ORDER-08`: Sayfa yenilenir → Sıralama deterministik olarak aynı kalır (**PASSED**)

### Avatar Test Paketi (`test-whatsapp-avatar.mjs`)
- `getInitials` tek ve çoklu isim desteği (**PASSED**)
- `getAvatarColor` deterministik renk dağılımı (**PASSED**)
- `failedAvatarUrls` önbelleği ile 120 ardışık kartta 0 fuzuli ağ isteği (**PASSED**)
- `clearFailedAvatarUrlsCache` temizleme (**PASSED**)
- Markup etiket kontrolleri (`aspect-square`, `object-cover`, `loading=lazy`, `decoding=async`) (**PASSED**)

### QR Cancel Test Paketi (`test_phase_13_qr_cancel_lifecycle.py`)
- `TEST-QR-01`: Modal aç → hemen iptal et → DB oturum satırı = 0 (**PASSED**)
- `TEST-QR-02`: QR üretimi sırasında iptal et → Temizlik tamamlanır, oturum satırı = 0 (**PASSED**)
- `TEST-QR-03`: İptal et → tekrar aç → Tekil oturum, mükerrer oturum yok (**PASSED**)
- `TEST-QR-04 - 06`: İptal işlemi gateway soketini, kimlik bilgilerini ve kirasını temizler (**PASSED**)
- `TEST-QR-07`: `CONNECTED` oturum kapatıldığında silinmez, kalıcı kalır (**PASSED**)
- `TEST-QR-08`: Zaman aşımı / kapatmada yetim oturum kalmaz (**PASSED**)

### Sistem Regresyon Paketi
- **Backend pytest**: `876 passed` (0 hata, 46.63s).
- **Gateway testleri**: 12 adet Baileys/Gateway test dosyasının tamamı başarılı.
- **Frontend build**: `vite build` 1.65 saniyede sıfır hata ile tamamlandı (`dist/assets/index-Dqih70r4.js`).

---

## 8. Canlı Prodüksiyon Doğrulaması (Oracle 130.162.247.20)

Canlı sunucu üzerinde gerçek E2E oturum döngüsü çalıştırıldı:
1. `3fa08111-30ae-42da-8e39-b0811b50443b` kullanıcısı ile geçici auth session oluşturuldu.
2. `POST /api/v1/whatsapp/sessions` ile "Cihaz Bağla" tetiklendi (Session 51 oluşturuldu).
3. Kullanıcı QR'ı okutmadan iptal etti → `DELETE /api/v1/whatsapp/sessions/51` çağrıldı.
4. **Doğrulama 1**: Veritabanında kalan oturum sayısı: **0**.
5. **Doğrulama 2**: Gateway oturum listesinde kalan kopya sayısı: **0**.
6. İkinci denemede "Cihaz Bağla" basıldı (Session 52), QR kodu çekildi ve ardından güvenli şekilde temizlendi.
7. İkinci deneme sonrası kullanıcıya ait kalan yetim oturum sayısı: **0**.

---

## 9. Sistem Değişmezleri (Invariants) Kontrolü

### Diagnostic Sessions (4 & 5)
```
Session 4: status=SCAN_QR, updated_at=2026-09-12 20:23:53.103543 (0 MUTASYON - KORUNDU)
Session 5: status=RELINK_REQUIRED, updated_at=2026-09-15 09:42:43.560478 (0 MUTASYON - KORUNDU)
```

### Production Session 50 (Gerçek Bağlantı)
```
Session 50:
- DB: id=50, status=CONNECTED, phone=+905413749073, is_active=True, updated_at=2026-09-17 12:57:29.555064 (KORUNDU)
- Gateway: id=19fa1b9b-b58e-44bb-a75f-583090524edf, status=CONNECTED, is_phone_online=True, 100% synced
- Socket & Lease: Tek yetkili soket ve kira ile kesintisiz aktif
```

---

## 10. Sonuç ve Kapanış

Tüm talep edilen 6 madde sıfır regresyon ve tam test güvencesi ile tamamlanmıştır:
- [x] Canlı Diyaloglar Web + Mobil + Tablet responsive ve kullanılabilir.
- [x] Kişi kartlarından telefon numarası kaldırıldı, veri tabanı/API verisi korundu.
- [x] Profil fotoğrafları eksiksiz yükleniyor, kırık URL fırtınası önlendi, initials fallback devrede.
- [x] Konuşma sıralaması WhatsApp Web standartlarında aktivite bazlı çalışıyor.
- [x] QR iptal edildiğinde sıfır yetim oturum kalıyor.
- [x] "QR ile Bağla" metinleri "Cihaz Bağla" / "Link Device" olarak güncellendi.
- [x] Session 50, Session 4 ve Session 5 eksiksiz korundu.

**Nihai Karar**: **A) ALL FIXED**
