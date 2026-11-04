# TEZLIFY WHATSAPP — AŞAMA 8.0.2
# Sandbox Security, Event Isolation & Multi-Worker Reliability Audit

**Aşama Türü:** READ-ONLY SECURITY & ARCHITECTURE AUDIT  
**Tarih:** 2026-11-04  
**Denetçi:** Antigravity AI  
**Durum:** TAMAMLANDI (Salt Okunur Denetim Raporu)  
**Genel Değerlendirme:** **CONDITIONAL_PASS / CRITICAL FINDINGS IDENTIFIED (1x P0, 3x P1, 2x P2, 1x P3)**

---

## 1. GIT VE PRODUCTION COMMIT DOĞRULAMASI

Denetim öncesinde yerel Git çalışma alanı ve Oracle Cloud üretim sunucusundaki durum bağımsız olarak doğrulanmıştır:

| Parametre | Beklenen Değer | Ölçülen Değer | Durum |
|---|---|---|---|
| **Local HEAD SHA** | `9a4a07d` | `9a4a07db98f0653d9e4a3cb02ef2fa2ad5687053` | DOĞRULANDI |
| **Origin/main SHA** | `9a4a07d` | `9a4a07db98f0653d9e4a3cb02ef2fa2ad5687053` | DOĞRULANDI |
| **Son Kod Commit SHA** | `bc4cd30` | `bc4cd309651d1eebeb063fdb05d1597d26109112` | DOĞRULANDI |
| **Production `/opt/tezlify` Git SHA** | `bc4cd30` | `bc4cd309651d1eebeb063fdb05d1597d26109112` | DOĞRULANDI |
| **Production `.deployed-commit`** | `bc4cd30` | `bc4cd309651d1eebeb063fdb05d1597d26109112` | DOĞRULANDI |
| **Production Release ID** | `20261104T204956Z` | `20261104T204956Z` | DOĞRULANDI |
| **Production Containers** | 4 container healthy | `tezlify-backend`, `tezlify-gateway`, `tezlify-db`, `tezlify-caddy` hepsi Up (healthy) | DOĞRULANDI |
| **WhatsApp Session 201** | `CONNECTED` (`Hat 1`) | `+905413749073`, `status=CONNECTED`, `is_active=t` | DOĞRULANDI |

---

## 2. İNCELENEN DOSYALAR VE MİMARİ BİLEŞENLER

Aşağıdaki kaynak kodları satır satır denetlenmiştir:
- `backend/app/services/whatsapp/sandbox.py` (Sandbox mantığı, koordinasyon, bellek yapıları)
- `backend/app/api/v1/endpoints/whatsapp_sandbox.py` (HTTP uç noktaları, yetkilendirme, hata yönetimi)
- `backend/app/schemas/whatsapp_sandbox.py` (Pydantic şemaları)
- `backend/app/core/config.py` (Ortam değişkenleri ve doğrulayıcılar)
- `backend/app/services/whatsapp/orchestration/events.py` (Gateway event outbox / websocket dinleyicisi ve DB ingest hattı)
- `backend/app/core/auth.py` & `backend/app/auth/api/dependencies.py` (Authentication & RBAC katmanı)
- `start.py` & `Dockerfile` & `docker-compose.prod.yml` (Uvicorn çalışma modeli ve worker topolojisi)
- `backend/tests/test_whatsapp_sandbox_*.py` (Aşama 8.0.1 test süitleri)

---

## 3. ENDPOINT AUTHORIZATION DENETİMİ

Sandbox API uç noktalarının kimlik doğrulama ve rol yetkilendirme matrisi:

| Uç Nokta | Metot | Kimlik Doğrulama | Rol Denetimi (RBAC) | Güvenlik Değerlendirmesi |
|---|---|---|---|---|
| `/api/v1/whatsapp/sandbox/status` | `GET` | `Depends(get_current_user)` | **YOK** (Herhangi bir AuthUser) | **AÇIK (P1):** Normal bir kiracı, altyapının dahili sandbox durumunu, oturum ID'sini ve maskeli hedef numaralarını sorgulayabilir. |
| `/api/v1/whatsapp/sandbox/ping` | `POST` | `Depends(get_current_user)` | **YOK** (Herhangi bir AuthUser) | **AÇIK (P1):** `require_admin` bağımlılığı bulunmamaktadır. Normal kiracı hesabı (kendi oturumuna bağlıysa veya oturum `user_id`'sizse) ping tetikleyebilir. |
| `/api/v1/whatsapp/sandbox/results` | `GET` | `Depends(get_current_user)` | **YOK** (Herhangi bir AuthUser) | **AÇIK (P1):** Sonuçlar kiracı bazında filtrelenmemektedir. Tenant B, Tenant A'nın test sonuçlarını görebilir. |

### Detaylı Değerlendirmeler:
1. **Anonim Erişim:** Bütün uç noktalar `401 Unauthorized` ile anonim isteklere kapalıdır (üretimde `curl` ile doğrulandı).
2. **Operatör / Admin Yetkisi:** `require_admin` kontrolü bu uç noktalara bağlanmamıştır. Sandbox altyapısı bir operasyonel test aracı olduğu için yalnızca sistem yöneticilerine açık olmalıdır.
3. **Cross-Tenant Veri Sızıntısı:** `GET /results` uç noktası doğrudan `sandbox_service.get_results_history()` belleğindeki listeyi döndürmektedir. Kiracı kimliği (`user_id`) kayıtta tutulmadığı için izolasyon sağlanamamaktadır.

---

## 4. TENANT VE SESSION İZOLASYONU

| Senaryo | Davranış | Sonuç |
|---|---|---|
| **Tenant A, Tenant B'nin session'ını kullanma girişimi** | `sess_row.user_id != current_user.id` kontrolü devreye girer ve `403 Forbidden` (`Tenant isolation error`) döner. | **GÜVENLİ (PASS)** |
| **Session 201'i sandbox olarak kullanma girişimi** | `session_id in PROTECTED_PRODUCTION_SESSION_IDS` kuralı anında `403 Forbidden` (`BLOCKED: PRODUCTION SESSION PROTECTED`) fırlatır. | **GÜVENLİ (PASS)** |
| **`user_id` değeri `NULL` olan sahipsiz/sistem oturumu** | Kodda `if sess_row.user_id and str(sess_row.user_id) != str(current_user.id):` yazıldığı için `user_id is None` olduğunda kontrol **BYPASS** edilir. | **AÇIK (P1):** Sahipsiz oturumlara her kiracı erişebilir. |
| **Yeni üretim oturumları (Örn: Session 202)** | Yalnızca `201` ID'si hardcoded engellenmiştir. Gelecekte eklenecek bir üretim oturumu (Session 202) bu kurala takılmaz. | **RİSK (P2):** Statik blacklist kırılganlığı. |

---

## 5. WORKER VE EVENT MİMARİSİ (MULTI-WORKER ANALİZİ)

### 5.1 Mevcut Üretim Çalışma Modeli
- Üretim sunucusunda `tezlify-backend` container'ı içinde `start.py` yürütülmektedir.
- `docker top tezlify-backend` çıktısı:
  ```text
  UID       PID       PPID      CMD
  root      2529911   2529887   python3 start.py
  ```
- `uvicorn.run(app, ...)` çağrısında `workers` parametresi belirtilmediğinden, üretim **tek bir worker process (single-process event loop)** olarak çalışmaktadır.
- Gateway `/ws/gateway` WebSocket bağlantısını bu tek sürece kurar.
- Dolayısıyla **mevcut üretim ortamında bellek içi koordinasyon deterministik olarak çalışmaktadır.**

### 5.2 Çoklu Worker / Yatay Büyüme Senaryoları
Sistem ileride çoklu worker (`uvicorn --workers N`) veya çoklu container arkasında çalıştırılırsa:

1. **Ping Worker A'da başlar, PONG Worker B'ye gelirse:**
   - Gateway `/ws/gateway` soketi Worker B'ye bağlıdır.
   - PONG Worker B'ye ulaştığında, Worker B'nin `_active_tests` sözlüğü boştur (`[AUDIT] Unmatched or expired sandbox PONG` loglanır).
   - Worker A'daki HTTP isteği 15 saniye bekleyip `TIMEOUT` ile sonuçlanır.
2. **Delivery Receipt farklı worker'a ulaşırsa:**
   - Worker B `_wa_id_to_corr` eşleşmesini bulamaz; Worker A teslimat durumunu `PENDING` görür.
3. **Backend restart sırasında:**
   - Aktif test bellekte kaybolur. Veritabanına hiçbir şey yazılmadığı için artık çöp veri oluşmaz, ancak HTTP isteği kesilir.
4. **Çoklu worker'da mükerrer correlation ID:**
   - `_seen_correlation_ids` her worker'ın kendi heap'inde olduğu için worker'lar arası mükerrerlik denetlenemez.
5. **Kalıcı Mekanizma İhtiyacı:**
   - Redis gereksiz bir ek bağımlılık ve operasyonel yüktür.
   - Çoklu worker koordinasyonu gerektiğinde, mevcut PostgreSQL altyapısı üzerinden **`LISTEN / NOTIFY` (`pg_notify('whatsapp_sandbox_events', ...)`**) ile sıfır ek altyapı maliyetiyle tam güvenilirlik sağlanabilir.

---

## 6. EVENT ISOLATION VE INGEST HATTI DENETİMİ

Bu denetimin en kritik bölümüdür. `backend/app/services/whatsapp/orchestration/events.py` satır 945–950 incelenmiştir:

```python
        # Phase 8.0.1: Sandbox ping/pong mesajı production DB'sine yazılmaz
        from backend.app.services.whatsapp.sandbox import sandbox_service
        msg_body = msg.get("body")
        if sandbox_service.is_sandbox_message(msg_body):
            sandbox_service.handle_inbound_message(msg_body, jid_to_phone(jid_str) or jid_str)
            return _skip_event(event, f"message_new: sandbox ping/pong handled without db mutation ({jid_str})")
```

### Kritik Güvenlik Zafiyeti Analizi (P0):
1. **Koşulsuz Atlama (Unconditional Drop):**
   `is_sandbox_message(msg_body)` fonksiyonu yalnızca `str(body).strip().startswith("TEZLIFY_SANDBOX")` kontrolü yapmaktadır.
2. **Eşleşme ve Durum Kontrolünün Yapılmaması:**
   - `sandbox_service.is_enabled` kontrolü **YOKTUR**. (Sandbox kapalıyken bile çalışır!)
   - `handle_inbound_message` fonksiyonunun `True` (başarılı eşleşme) dönüp dönmediği kontrol **EDİLMEMEKTEDİR**.
   - Session ID veya hedef telefon kontrolü **YOKTUR**.
3. **Gerçek Müşteri Mesajı Kaybı / Hizmet Engelleme (DoS):**
   - Canlı üretim hattına (`Hat 1`, Session 201) bir müşteri veya kötü niyetli bir kullanıcı `TEZLIFY_SANDBOX: ...` ile başlayan bir mesaj gönderirse:
     1. Kod `is_sandbox_message -> True` değerlendirir.
     2. `handle_inbound_message` eşleşen test bulamaz ve `False` döner.
     3. Kod buna rağmen **`return _skip_event(...)`** çalıştırarak DB yazımını ve UI broadcast'ini iptal eder!
     4. Müşterinin mesajı **TAMAMEN KAYBOLUR**, DB'ye kaydedilmez, operatör panelinde görünmez!

Bu durum Python çalışma ortamında test edilmiş ve doğrulanmıştır:
```text
Girdi: "TEZLIFY_SANDBOX: merhaba, teklif almak istiyorum"
Sonuç: _skip: True ("message_new: sandbox ping/pong handled without db mutation")
DB execute / commit call count: 0 (Mesaj veritabanına yazılmadan SİLİNDİ)
```

---

## 7. PRODUCTION GÜVENLİĞİ DENETİMİ

Üretim ortamında salt okunur denetimler yapılmıştır:

1. **Konfigürasyon Durumu:**
   - `WHATSAPP_SANDBOX_ENABLED`: `False` (Doğrulandı)
   - `WHATSAPP_SANDBOX_SESSION_ID`: `None` (Doğrulandı)
   - `WHATSAPP_SANDBOX_ALLOWED_TARGETS`: `[]` (Boş allowlist, fail-closed)
2. **Üretim Oturumu:**
   - Session 201 (`Hat 1`): `CONNECTED`, `+905413749073`.
3. **Endpoint Güvenliği:**
   - Anonim isteklere `401 Unauthorized` döner.
   - Authenticated isteklere fail-closed: `403 Forbidden` (`BLOCKED: SANDBOX DISABLED`).
4. **Veritabanı Durumu:**
   - `conversations` (129), `messages` (10,944), `contacts` (1,540) tabloları eksiksiz ve korunmuştur.

---

## 8. TEST EKSİKLİKLERİ

Aşama 8.0.1 testlerinde bulunmayan ve Aşama 8.0.3'te eklenmesi gereken test senaryoları:

1. **Spoofed Prefix Mesaj Kaybı Testi:** `TEZLIFY_SANDBOX: merhaba` gibi aktif correlation ID taşımayan veya sandbox kapalıyken gelen mesajların normal mesaj akışında DB'ye yazıldığının kanıtlanması.
2. **Admin/Operator RBAC Testi:** Normal kullanıcı token'ı ile çağrılan `/ping` ve `/status` uç noktalarının 403 ile reddedildiğinin testi.
3. **Cross-Tenant Results İzolasyon Testi:** Tenant B'nin `GET /results` çağırdığında Tenant A'nın test kayıtlarını kesinlikle görmediğinin testi.
4. **Sahipsiz Session (`user_id=None`) Testi:** Sahipsiz oturumlara normal kiracıların erişemediğinin testi.
5. **Timeout vs PONG Yarış Koşulu Testi:** Timeout tetiklenirken eşzamanlı gelen PONG durumunda `error_code` ve `pong_status` tutarlılığı.

---

## 9. BULGU VE RİSK SINIFLANDIRMASI

### [P0] Kötü Niyetli veya Rastlantısal Prefix ile Müşteri Mesajı Kaybı (Silent Message Drop)
- **Dosya / Satır:** [`backend/app/services/whatsapp/orchestration/events.py#L946-L950`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp/orchestration/events.py#L946-L950)
- **Teknik Neden:** `is_sandbox_message` kontrolü sandbox açık/kapalı durumuna, oturuma ve `handle_inbound_message` sonucuna bakmaksızın olayı `_skip_event` ile düşürmektedir.
- **Etki:** Canlı üretim hattına `"TEZLIFY_SANDBOX"` ile başlayan herhangi bir metin geldiğinde mesaj veritabanına yazılmaz, arayüzde görünmez ve kalıcı olarak kaybolur.
- **Yeniden Üretim:** `events.py` `_ingest_message` metoduna `body="TEZLIFY_SANDBOX: teklif"` içeren bir event gönderildiğinde `_skip: True` döndüğü kanıtlanmıştır.
- **Önerilen Düzeltme:**
  1. `if sandbox_service.is_enabled and ...` koşulu eklenmeli.
  2. Gateway session ID ile sandbox session ID eşleşmesi aranmalı.
  3. `sandbox_service.handle_inbound_message` çağrısı **yalnızca `True` döndüğünde** `_skip_event` yapılmalı; `False` dönerse mesaj normal müşteri akışında DB'ye kaydedilmelidir.

---

### [P1] Sandbox Kontrol Uç Noktalarında RBAC (Operator/Admin) Yetkisi Eksikliği
- **Dosya / Satır:** [`backend/app/api/v1/endpoints/whatsapp_sandbox.py#L32-L108`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/api/v1/endpoints/whatsapp_sandbox.py#L32-L108)
- **Teknik Neden:** Uç noktalar `require_admin` yerine `get_current_user` kullanmaktadır.
- **Etki:** Standart herhangi bir kiracı kullanıcısı sistemin sandbox durumunu sorgulayabilir, ping tetikleyebilir ve test sonuçlarını listeleyebilir.
- **Önerilen Düzeltme:** `/status`, `/ping` ve `/results` uç noktalarına `current_user: AuthUser = Depends(require_admin)` bağımlılığı eklenmelidir.

---

### [P1] `GET /results` Uç Noktasında Kiracı İzolasyonu Yokluğu
- **Dosya / Satır:** [`backend/app/api/v1/endpoints/whatsapp_sandbox.py#L103-L108`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/api/v1/endpoints/whatsapp_sandbox.py#L103-L108) ve [`backend/app/services/whatsapp/sandbox.py#L368-L370`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp/sandbox.py#L368-L370)
- **Teknik Neden:** Test geçmişi küresel paylaşımlı bir `deque` içinde tutulmakta ve filtre uygulanmadan dönülmektedir.
- **Etki:** Kiracı A'nın test sonuçları Kiracı B tarafından görüntülenebilmektedir (bilgi sızıntısı).
- **Önerilen Düzeltme:** `SandboxTestRecord` içine `user_id` eklenmeli, `get_results_history` metoduna `user_id` filtresi konulmalı veya uç nokta yalnızca `require_admin` yetkisine bağlanmalıdır.

---

### [P1] `user_id` Değeri NULL Olan Oturumlarda Kiracı İzolasyonu Bypass Riski
- **Dosya / Satır:** [`backend/app/api/v1/endpoints/whatsapp_sandbox.py#L75-L79`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/api/v1/endpoints/whatsapp_sandbox.py#L75-L79)
- **Teknik Neden:** `if sess_row.user_id and str(sess_row.user_id) != str(current_user.id):` ifadesi `sess_row.user_id is None` olduğunda `False` üretir.
- **Etki:** Sahipsiz veya sistem düzeyinde açılmış bir sandbox oturumunu herhangi bir kiracı kullanabilir.
- **Önerilen Düzeltme:** `if not sess_row.user_id or str(sess_row.user_id) != str(current_user.id):` kontrolü uygulanmalı; sahipsiz oturumlar yalnızca admin tarafından kullanılabilmelidir.

---

### [P2] Hardcoded Oturum Engeli Kırılganlığı (`PROTECTED_PRODUCTION_SESSION_IDS = {201}`)
- **Dosya / Satır:** [`backend/app/services/whatsapp/sandbox.py#L22`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp/sandbox.py#L22)
- **Teknik Neden:** Korumalı oturum listesi statik olarak yalnızca `{201}` içermektedir.
- **Etki:** Gelecekte eklenecek üretim oturumları (örneğin Session 202) otomatik korunmaz; konfigürasyon hatasıyla sandbox oturumu yapılabilir.
- **Önerilen Düzeltme:** Oturumun üretim mi sandbox mı olduğu veritabanı düzeyinde bir alan veya oturum adı kuralı (`session_name.startswith("Sandbox")` veya `is_sandbox: bool`) ile doğrulanmalıdır.

---

### [P2] Çoklu Worker / Yatay Büyümede Bellek İçi Koordinasyon Yetersizliği
- **Dosya / Satır:** [`backend/app/services/whatsapp/sandbox.py#L143-L151`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp/sandbox.py#L143-L151)
- **Teknik Neden:** `_active_tests`, `_wa_id_to_corr` ve `asyncio.Event` tek bir Python süreci heap'ine bağlıdır.
- **Etki:** Sistem gelecekte çoklu worker'a (`uvicorn --workers N`) geçirildiğinde, HTTP isteği ile WebSocket event'i farklı süreçlere düşeceği için testler 15 sn timeout'a düşecektir.
- **Önerilen Düzeltme:** Aşama 8.0.3+ kapsamında PostgreSQL `LISTEN / NOTIFY` köprüsü ile süreçler arası event yayını planlanmalıdır (Redis gereksinimi olmadan).

---

### [P3] Timeout ve PONG Eşzamanlılığında Durum Kodlaması Uyuşmazlığı
- **Dosya / Satır:** [`backend/app/services/whatsapp/sandbox.py#L471-L480`](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp/sandbox.py#L471-L480)
- **Teknik Neden:** Timeout fırlatıldığında `error_code = "TIMEOUT"` yazılmakta, ancak o milisaniyede PONG gelmişse `pong_status = "MATCHED"` kalabilmektedir.
- **Etki:** Raporlanan geçmişte `pong_status="MATCHED"` iken `error_code="TIMEOUT"` görünmesi.
- **Önerilen Düzeltme:** Lock altında `pong_status == "MATCHED"` ise `error_code` temizlenmelidir.

---

## 10. ÖNERİLEN DÜZELTME SIRASI

1. **ÖNCELİK 1 (P0):** `events.py` içindeki `_ingest_message` kancasının düzeltilmesi (`sandbox_service.is_enabled` şartı, session eşleşmesi ve `handle_inbound_message`'ın `True` dönmesi şartı). Böylece canlı müşteri mesajı kaybı riski tamamen kapatılır.
2. **ÖNCELİK 2 (P1):** `whatsapp_sandbox.py` uç noktalarına `require_admin` eklenmesi ve kiracı izolasyonunun sıkılaştırılması.
3. **ÖNCELİK 3 (P1):** `_results_history` içine `user_id` eklenmesi ve cross-tenant sızıntının önlenmesi.
4. **ÖNCELİK 4 (P2):** Statik `{201}` engeli yerine dinamik sandbox doğrulamasının tasarlanması.
5. **ÖNCELİK 5 (P3):** Timeout settle bloğundaki yarış koşulunun giderilmesi.

---

## 11. AŞAMA 8.0.3 İÇİN NET KAPSAM

AŞAMA 8.0.3 kapsamında yapılması gereken işler:
1. `events.py` P0 zafiyetinin düzeltilmesi (Safe Fallthrough Guard).
2. `whatsapp_sandbox.py` uç noktalarına `require_admin` RBAC uygulanması.
3. Cross-tenant test sonuçları izolasyonu.
4. Yeni güvenlik ve negatif test senaryolarının (`test_spoofed_prefix_not_dropped`, `test_admin_rbac_enforcement`, vb.) eklenmesi.
5. Regresyon testleri ve üretim doğrulaması.

---

**SONUÇ:** AŞAMA 8.0.2 salt okunur güvenlik ve mimari denetimi başarıyla tamamlanmıştır. Kod veya altyapı değişikliği yapılmamış, commit veya deploy tetiklenmemiştir. Talimat beklenmektedir.

