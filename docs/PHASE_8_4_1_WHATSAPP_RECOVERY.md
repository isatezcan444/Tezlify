# PHASE 8.4.1 — WHATSAPP GATEWAY RECOVERY + SESSION OWNERSHIP CONSISTENCY REPORT

**Tarih**: 2026-09-16T01:18:00+03:00  
**Ortam**: Production  
**Nihai Karar**: `WHATSAPP_E2E_PRECONDITION_BLOCKED`  

---

## 1. Orijinal 428 Olayı ve Kopma Nedeni Analizi

Gateway Docker logları (`tezlify-gateway`) adli delil seviyesinde incelenmiştir:

- **Kronoloji**:
  - `time: 1789505821` (İlk Başlatma): Session `0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2` (`040b662eec67`, `generation: 1`), `connection: open` (Sağlıklı bağlandı).
  - `time: 1789507536` (~28 dk sonra): WhatsApp sunucusu `statusCode: 503` (Service Unavailable) ile soketi kapattı. Gateway `generation: 2` ile otomatik yeniden bağlandı (`connection: open`).
  - `time: 1789508222`: WhatsApp sunucusu yeniden `statusCode: 503` döndü.
  - `time: 1789508223` (`generation: 3`): WhatsApp sunucusu bağlantıyı `statusCode: 428` (`Connection Closed`) ile reddetti.
  - `time: 1789508225` (`generation: 4`): Yeniden denendi; WhatsApp sunucusu tekrar `statusCode: 428` döndürdü.
  - `failure_count >= 3` eşiğine ulaşıldığı için otomatik yeniden bağlanma döngüsü durduruldu ve oturum bellekte `DISCONNECTED` durumuna geçti.
- **Kök Neden**:
  - Oturum kimlik bilgisi (credential/token) bozulması DEĞİLDİR (`401`, `badSession` veya `loggedOut` alınmamıştır).
  - Mükerrer bağlantı çakışması (`conflict`, `replaced`) DEĞİLDİR.
  - WhatsApp sunucu tarafı bağlantı reddidir (`statusCode: 428 - Precondition Required`). Birincil fiziksel telefonun (`+905076382749`) internet bağlantısının kesilmesi veya WhatsApp multidevice sunucularının geçici IP eşleşme kısıtlaması nedeniyle gerçekleşmiştir.

---

## 2. Oturum Envanteri (Session Inventory)

### Veritabanı (`public.whatsapp_sessions`):
| ID | User ID | Gateway ID | Hat Adı | Telefon No | Durum | is_active | is_online | has_qr |
|---|---|---|---|---|---|---|---|---|
| 4 | `00000000-0000-0000-0000-000000000001` | `2b2ed927-866c-4373-89d9-0ad8b35d63c8` | diag | `+905525372434` | SCAN_QR | t | f | f |
| 5 | `00000000-0000-0000-0000-000000000001` | `87cf30e9-91d7-40b8-aba4-5d36494192f9` | diag | `+905525372434` | RELINK_REQUIRED | t | f | f |
| 39 | `e512dd40-8466-4dea-ac5f-67a268fed000` | `0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2` | Hat 1 | `+905076382749` | CONNECTED | t | t | f |
| 42 | `f65642ab-4ae5-4d69-945c-8f30c8454bac` | `97f5c636-9fdf-4720-8127-1daa99ffe2c9` | Hat 1 | `+905413749073` | DISCONNECTED | t | f | f |

### Gateway Runtime (`GET /sessions`):
- `id: 0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2` -> `status: DISCONNECTED`, `phone: +905076382749`, `error: statusCode=428`
- `id: 97f5c636-9fdf-4720-8127-1daa99ffe2c9` -> `status: DISCONNECTED`, `phone: null`

### Socket Lease (`whatsapp_private.socket_leases`):
- `session_id`: `0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2`
- `generation`: 4
- `updated_at`: `2026-09-15 22:15:35 UTC` (Aktif heartbeat ile yenileniyor)

---

## 3. Kanonik Üretim Oturumu ve Sahiplik Eşleştirmesi

- **Kanonik Oturum**: DB ID `39` (`0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2`).
- **Telefon Numarası**: `+905076382749`.
- **Oturum Sahibi (Owner)**: `e512dd40-8466-4dea-ac5f-67a268fed000` (`cvtaydn53@gmail.com`).
- **Oturum 42 Durumu**: `f65642ab-4ae5-4d69-945c-8f30c8454bac` kullanıcısına ait olup henüz eşleştirilmemiştir (DB'de 0 adet credential mevcuttur).
- **Sahiplik İzolasyonu**: Çok kiracılı (multi-tenancy) mimari gereği her kullanıcı yalnızca kendi oturumuna erişebilir; oturum sahipliği kesinlikle suni şekilde birleştirilmemiş veya değiştirilmemiştir.

---

## 4. Kimlik Bilgileri ve Socket Durumu

- `whatsapp_private.session_credentials`: 1 kayıt (`0e8f8a0f-ba1d-48cb-9af7-92c5b96b37e2` için şifrelenmiş kimlik bilgisi sağlam).
- `whatsapp_private.signal_keys`: **5,250 adet** signal anahtarı eksiksiz korunmaktadır.
- **Kritik Ayrım**:
  - `LEASE_VALID`: **EVET** (PostgreSQL üzerinde tekil aktif lease mevcut ve yenileniyor).
  - `WHATSAPP_CONNECTED`: **HAYIR** (Baileys socket katmanı WhatsApp 428 reddi nedeniyle DISCONNECTED durumunda).

---

## 5. Güvenli Yeniden Bağlanma (Safe Reconnect) Değerlendirmesi

Oturumun yeniden bağlanması için:
1. Birincil fiziksel cihazın (`+905076382749`) açık, şarjlı ve internete bağlı olduğunun teyit edilmesi gerekmektedir.
2. WhatsApp sunucusunun geçici 428 bekleme süresi dolduktan sonra kontrollü olarak socket yeniden başlatılabilir.
3. Oturum kimlik bilgileri silinmemeli, yapay QR üretilmemeli ve var olan oturum kaydı bozulmamalıdır.

---

## 6. Auth Non-Regression Doğrulaması

Oracle Native Auth sistemi bu süreçten tamamen izoledir ve etkilenmemiştir:
- Aktif native session: 1 (`90bff502-6bfc-47f9-ba80-d61cfc6d360b`)
- Toplam auth kullanıcıları: 3
- Toplam oauth bağlantıları: 1
- `GET /api/v1/auth/me`: `HTTP 200 OK`

---

## 7. Regresyon Test Paketi & Frontend Build

```bash
pytest backend/tests/test_whatsapp_live.py backend/tests/test_whatsapp_relink_required.py backend/tests/test_oracle_native_auth.py backend/tests/test_auth_multitenancy.py -v
# Sonuç: 87 passed in 2.06s

npm run build
# Sonuç: built in 1.72s (0 error)
```

---

## 8. E2E Önkoşul Kararı (Final Health Gate)

| Kriter | Beklenen | Mevcut | Sonuç |
|---|---|---|---|
| Gateway Sağlığı | OK | OK (HTTP 200) | 🟢 PASS |
| Kanonik WhatsApp Oturumu | CONNECTED | DISCONNECTED (428) | 🔴 FAIL |
| is_phone_online | true | false | 🔴 FAIL |
| QR Kodu | null | null | 🟢 PASS |
| Socket Lease | 1 aktif lease | 1 aktif lease (gen=4) | 🟢 PASS |
| Sahiplik Tutarlılığı | Net ve açık | ID 39 (`e512dd40...`) | 🟢 PASS |
| Kalıcı 428 / Kopma Döngüsü | Yok | 428 Disconnect mevcut | 🔴 FAIL |

**Nihai Karar**: `WHATSAPP_E2E_PRECONDITION_BLOCKED`  
**Engel Nedeni**: Kanonik WhatsApp oturumu (`Hat 1`, `+905076382749`), WhatsApp sunucusunun `statusCode=428` vermesi sonucu geçici olarak `DISCONNECTED` durumundadır. Fiziksel cihazın aktif hale gelmesi ve bağlantının yeniden kurulması beklenmektedir.
