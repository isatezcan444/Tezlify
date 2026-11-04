# AŞAMA 7.2 — WhatsApp Unicode Identity, Multilingual Name Recognition ve RTL Desteği Raporu

**Tarih**: 2026-11-04  
**İşlem Türü**: Geliştirme, Kapsamlı Test (Birim, DOM, Gerçek Chrome Tarayıcı), Dağıtım ve Canlı Doğrulama  
**Kapsam**: AŞAMA 7.2 — Çok Dilli Kimlik Tanıma (Arapça, Çince, Kiril, Yunanca, Hint vb.) & RTL / İki Yönlü (BiDi) Sohbet Arayüzü  
**Sonuç**: `PASS`

---

## 1. Yürütücü Özeti ve Hedefler

AŞAMA 7.0 denetiminde tespit edilen ve kullanıcı deneyimini doğrudan etkileyen aşağıdaki temel sorunlar AŞAMA 7.2 kapsamında tamamen çözülmüştür:

1. **Çok Dilli İsimlerin Geçersiz Sayılması**:
   - Latin alfabesi ve Türkçe dışındaki alfabeler (Arapça, Çince, Japonca, Korece, Kiril, Yunanca, İbranice, Hint/Devanagari vb.) `whatsappIdentity.ts` içerisindeki ASCII/Türkçe regex sınırlaması (`/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/g`) nedeniyle "harfsiz" sayılıp eleniyor ve geçerli kişi/grup isimleri `isRealContactName()` tarafından `false` döndürülüyordu.
2. **Beş veya Daha Fazla Rakam İçeren İsimlerin Reddedilmesi**:
   - `digitsOnly.length >= 5` kuralı, içinde harf ve 5+ rakam barındıran isimleri (ör. `قناة الأخبار 12345`, `新闻频道 12345`, `Proje 20261`) otomatik olarak telefon numarası zannedip reddediyordu.
3. **RTL ve Karışık Metinlerin Yön/Noktalama Bozulmaları**:
   - WhatsApp sohbet balonlarında, alıntılarda, medya başlıklarında ve kişi/grup başlıklarında metin yönü (`dir="auto"`) ve iki yönlü algoritma izolasyonu (`<bdi>`) bulunmadığından Arapça ve İbranice metinlerde cümle sonu noktalamaları cümlenin başında çıkıyor, telefon numaraları (`+90...`) ve bağlantılar (`https://...`) ters dönüyordu.
4. **Jenerik Fallback ("Kişi" / "Grup") Etiketlerine Düşme**:
   - Çok dilli sohbet veya kişi adları geçersiz sayıldığı için arayüzde gerçek isim yerine `Kişi` veya `Grup` jenerik etiketleri gösteriliyordu.

---

## 2. Doğrulanan Git ve Dağıtım Durumu

| Metrik / Parametre | Değer | Durum |
| :--- | :--- | :--- |
| **Başlangıç Commit SHA** | `13e71a6208bb6f24300a7b453ec417a868f7d8c4` | Doğrulandı |
| **Tamamlanan Commit SHA** | `9d7458e3ba3f8e845df17321e8b3745493001bce` | Local `HEAD`, `origin/main` ve prod birebir eşit |
| **Commit Mesajı** | `fix(whatsapp): support multilingual identities and rtl messages` | Konvansiyonel standartta |
| **Dağıtım Betiği** | `scripts/deploy/release.sh` | Başarılı (Hermetik Vite derlemesi + Adacık testi) |
| **Release ID** | `20261104T091849Z` | Başarılı |
| **Production Sunucu** | `ubuntu@130.162.247.20` | Oracle Cloud Infrastructure |
| **Canlı Session 201** | `Hat 1` (`1bd78836-c084-4cbf-b333-9386d44b7bd7`) | `status: CONNECTED`, `is_phone_online: true` (Sıfır kesinti, QR yenilenmedi) |
| **Canlı /health Durumu** | `HTTP 200 OK`, `gateway_bridge: connected` | Aktif trafik (okundu/yazıyor istekleri 200 OK) |

---

## 3. Yapılan Değişiklikler ve Mimari Uygulama

### 3.1 `frontend/src/features/whatsapp/lib/whatsappIdentity.ts`
- **Unicode Harf ve Birleştirme İşaretleri Desteği**:
  - `lettersOnly` hesaplamasında kullanılan daraltıcı regex kaldırıldı. Yerine modern Unicode özellik kaçışları getirildi:
    ```typescript
    const lettersAndMarks = trimmed.match(/[\p{L}\p{M}]/gu) || [];
    ```
  - Bu sayede Arapça (`محمد`), Çince (`李伟`), Kiril (`Иван Петров`), Yunanca (`Γιώργος`), Hint/Devanagari (`राजेश`), Japonca, Korece, İbranice ve tüm aksanlı diller eksiksiz olarak gerçek isim kabul edildi.
- **Rakam + Çok Dilli İsim Kuralı**:
  - `digitsOnly.length >= 5` koşulu yalnızca **isimde hiç harf veya işaret yoksa** tetiklenecek şekilde güncellendi:
    ```typescript
    if (lettersAndMarks.length === 0 && digitsOnly.length >= 5) return false;
    ```
  - Bu sayede `قناة الأخبار 12345` veya `Market Şube 34001` gibi gerçek çok dilli isimler korunurken, `+905411234567` gibi salt telefon numarası veya teknik JID'ler elendi.
- **Teknik JID ve Sistem Fallback Filtreleri**:
  - `@newsletter`, `status@broadcast`, `@lid`, `@g.us` teknik dizgileri `isRealContactName()` tarafından kesin olarak filtrelendi.
  - `unknown`, `null`, `undefined`, `none`, `Hat \d+`, `Tezlify` gibi jenerik ve sistem adları elendi.
- **Grup ve Sohbet Başlık Mantığı (`getConversationDisplayName`)**:
  - Grup sohbetlerinde geçerli grup başlıklarının düşürülmemesi ve sistem placeholder'ları yerine doğru fallback zinciri garanti altına alındı.

### 3.2 Arayüz Bileşenlerinde RTL (`dir="auto"`) ve BiDi İzolasyonu (`<bdi>`)
1. **`ChatBubble.tsx`**:
   - Mesaj metin konteynerine `dir="auto"` eklendi: metnin ilk güçlü yön karakterine göre tarayıcı otomatik olarak RTL veya LTR düzenini seçer.
   - Balon hizalaması korundu: Gelen mesajlar her zaman solda (`items-start`), giden mesajlar her zaman sağda (`items-end`) kalır; metin yönü yalnızca balonun içindeki akışı belirler.
   - **Inline LTR İzolasyonu**: Arapça veya RTL mesaj içerisinde geçen URL'ler (`https://...`) ve telefon numaraları (`+90...`), `dir="ltr"` parametreli `<bdi>` etiketleriyle sarılarak eğik çizgi (`/`), artı (`+`) ve tire (`-`) işaretlerinin ters dönmesi engellendi.
   - **Unicode Mention Desteği**: `@kullanıcı` regex'i `/@[\p{L}\p{M}\p{N}_+]+/gu` olarak güncellendi ve etiketler `<bdi>` içerisine alındı.
   - Alıntı blokları (`> ...` ve `renderQuotedBlock`), gönderici isimleri ve medya başlıkları (`caption`) `dir="auto"` ve `<bdi>` ile donatıldı.
   - Grup gönderici etiketine test izlenebilirliği için `data-testid="msg-sender-${message.id}"` eklendi.
2. **`ConversationList.tsx`**:
   - Sol sohbet listesindeki başlık (`h4`) ve son mesaj önizleme metni (`p`) `dir="auto"` ve `<bdi>` ile korundu.
3. **`WhatsAppHubPage.tsx`**:
   - Açık sohbet üst barındaki başlık `dir="auto"` ve `<bdi>` ile, telefon numarası alt başlığı ise `dir="ltr"` ve `<bdi>` ile yapılandırıldı.
   - Grup katılımcı bilgisi ve "yazıyor..." bildirimi iki yönlü bozulmalara karşı korundu.
4. **`ChatInfoDrawer.tsx`**:
   - Sağ detay çekmecesindeki profil adı, yıldızlı mesaj gönderici ve gövdesi, katılımcı listesindeki isimler `dir="auto"` ve `<bdi>` ile sarıldı. Telefon numaraları `dir="ltr"` olarak izole edildi.
5. **`ChatMessageInfoDrawer.tsx`**:
   - Mesaj detay çekmecesindeki okundu/iletildi alıcı isimleri `dir="auto"` ve `<bdi>` ile korundu.

---

## 4. Test ve Doğrulama Kanıtları

### 4.1 Mantık Birim Testleri (`npm run verify:logic`)
`frontend/scripts/verify-whatsapp-logic.mjs` betiğine AŞAMA 7.2 için iki yeni kapsamlı süit eklendi:
- **Suite 5**: Multilingual Unicode Names and Mixed Digits
  - Arapça: `محمد` (PASS)
  - Çince: `李伟` (PASS)
  - Kiril: `Иван Петров` (PASS)
  - Yunanca: `Γιώργος Παπαδόπουλος` (PASS)
  - Devanagari: `राजेश कुमार` (PASS)
  - İbranice: `אברהם` (PASS)
  - Japonca / Korece: `田中太郎`, `김철수` (PASS)
  - Arapça + 5 rakam: `قناة الأخبار 12345` (PASS)
  - Çince + 5 rakam: `新闻频道 12345` (PASS)
  - Kiril + 5 rakam: `Новости 20261` (PASS)
  - Pure digits rejection: `1234567890` (PASS)
  - Pure punctuation: `...`, `---` (PASS)
  - JID/LID rejections: `218107046027315@lid`, `905413749073@s.whatsapp.net` (PASS)
- **Suite 6**: Turkish Identity and Existing Rules Regression Protection
  - Türkçe karakterli isimler (`Çağrı Şengül`, `Ömer İpek`, `Gülşah Çetin`) eksiksiz korundu.
  - Jenerik fallback'ler (`Kişi`, `Grup`, `Hat 1`, `Unknown`) reddedildi.
- **Sonuç**: **53/53 test BAŞARILI**.

### 4.2 DOM ve Arayüz Simülasyon Testleri (`npm run verify:unicode-rtl`)
`frontend/scripts/verify-whatsapp-unicode-rtl-dom.mjs` JSDOM tabanlı doğrulama aracıyla 8 senaryo test edildi:
1. `ChatBubble`: Arapça mesaj için `dir="auto"` uygulandı ve `align-self: flex-start` (gelen mesaj sola dayalı).
2. `ChatBubble`: Giden mesaj `align-self: flex-end` (sağa dayalı) kaldı.
3. `ChatBubble`: Karışık metindeki telefon numarası ve link `<bdi dir="ltr">` ile izole edildi.
4. `ChatBubble`: Unicode mention (`@محمد_2026`) `<bdi>` ile sarıldı.
5. `ChatBubble`: Grup gönderici etiketi `<bdi>` ile sarıldı.
6. `ChatBubble`: Alıntı mesaj ve medya başlıkları `dir="auto"` ve `<bdi>` içerir.
7. `ConversationList`: Başlık ve son mesaj önizlemesinde `dir="auto"` ve `<bdi>` doğrulandı.
8. `ChatInfoDrawer`: Profil adı ve katılımcı listesinde `dir="auto"` ve `<bdi>` doğrulandı.
- **Sonuç**: **8/8 senaryo BAŞARILI**.

### 4.3 Gerçek Chrome Tarayıcı Testleri (Google Chrome 157 via CDP)
Sistemde yüklü olan `/Applications/Google Chrome.app` (Chrome 157) Chrome DevTools Protocol (CDP) üzerinden WebSocket ile headless bağlanarak çalıştırıldı:
- Test betiği: `frontend/scripts/verify-whatsapp-browser.mjs`
- Test edilen unsurlar:
  - Computed style doğrulaması: `window.getComputedStyle(p).direction === 'rtl'` (Arapça metin tarayıcıda otomatik `rtl` olarak hesaplandı).
  - LTR metin için computed style: `ltr`.
  - Gelen mesaj balonu `justify-start`, giden mesaj balonu `justify-end` olarak yerleşti.
  - URL ve telefon numaraları computed style olarak `ltr` direction korudu.
  - Mention ve grup göndericisi `<bdi>` etiketleri tarayıcı DOM'unda eksiksiz işlendi.
- **Sonuç**: **10/10 kontrol BAŞARILI**.

### 4.4 Backend Pure Identity Testleri
`backend/tests/test_whatsapp_identity_pure.py` izole ortamda çalıştırıldı:
- **Sonuç**: **28/28 pytest BAŞARILI**.

### 4.5 Dağıtım Sonrası Üretim Doğrulaması
- `node frontend/scripts/verify-production-whatsapp.mjs`:
  - `ok - the deployed page serves a hashed bundle`
  - `ok - React mounted into #root`
  - `ok - the deployed bundle contains the loading-deadlock fix`
  - `ok - the deployed CSS carries a themed loading surface`
  - `ok - no console errors on load`
  - `ok - no transport-level request failure`
  - **Sonuç**: **6/6 kontrol BAŞARILI**.
- Canlı PostgreSQL 17 Sorgusu:
  - Oturum `id: 201`, `gateway_id: 1bd78836-c084-4cbf-b333-9386d44b7bd7`, `status: CONNECTED`, `is_phone_online: t`.
- Canlı Docker Durumu:
  - `tezlify-backend`: Up, Healthy.
  - `tezlify-gateway`: Up, Healthy.
  - `tezlify-db`: Up, Healthy.
  - `tezlify-caddy`: Up, Healthy.

---

## 5. Değiştirilen Dosyalar Listesi

1. `frontend/src/features/whatsapp/lib/whatsappIdentity.ts`
2. `frontend/src/features/whatsapp/components/ChatBubble.tsx`
3. `frontend/src/features/whatsapp/components/ConversationList.tsx`
4. `frontend/src/pages/WhatsAppHubPage.tsx`
5. `frontend/src/features/whatsapp/components/ChatInfoDrawer.tsx`
6. `frontend/src/features/whatsapp/components/ChatMessageInfoDrawer.tsx`
7. `frontend/scripts/verify-whatsapp-logic.mjs`
8. `frontend/scripts/verify-whatsapp-unicode-rtl-dom.mjs`
9. `frontend/scripts/verify-whatsapp-browser.mjs`
10. `frontend/package.json`

---

## 6. Sonuç ve Bir Sonraki Aşama

AŞAMA 7.2 hedefleri eksiksiz olarak tamamlanmış, tüm testler yerel ve gerçek tarayıcı ortamında doğrulanmış, değişiklikler commit edilip push edilmiş ve `scripts/deploy/release.sh` ile canlı sisteme sıfır kesintiyle dağıtılmıştır.

- **AŞAMA 7.2 Değerlendirmesi**: `PASS`
- **Bir Sonraki Aşama**: Kullanıcı talimatı doğrultusunda AŞAMA 7.3 planına geçilebilir.
