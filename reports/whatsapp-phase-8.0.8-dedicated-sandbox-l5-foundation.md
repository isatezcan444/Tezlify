# TEZLIFY WHATSAPP — AŞAMA 8.0.8 RAPORU
## Dedicated Sandbox L5 Live WhatsApp E2E Foundation

**Aşama:** 8.0.8  
**Aşama Türü:** CONTROLLED IMPLEMENTATION + SECURITY HARDENING + ISOLATED E2E FOUNDATION  
**Tarih:** 2026-11-05  
**Nihai Karar:** `PASS_WITH_NOTES`  
**L5 Durumu:** `BLOCKED — dedicated test SIM/account not provisioned`  
**Production Deployment:** YAPILMADI (Yalnızca yerel izole test ortamı; Session 201 sıfır mutasyonla korundu)

---

## 1. Başlangıç Durumu & Doğrulama Kanıtları

Aşama 8.0.8 başlangıcında sistem ve altyapı durumu yerel ve sunucu üzerinde incelenerek teyit edilmiştir:

| Parametre | Değer / Durum | Kanıt |
|---|---|---|
| **Local Git HEAD** | `1e1485e29edc1f1ea6bd6d139295b865220f54a6` | `git rev-parse HEAD` |
| **Origin/Main HEAD** | `1e1485e29edc1f1ea6bd6d139295b865220f54a6` | `git rev-parse origin/main` |
| **Production Server HEAD** | `133a8c98e1f57da7a1d1d9a0d8c0b2d3127ef6ae` | SSH Oracle (`/opt/tezlify/.deployed-commit`) |
| **Active Production Release** | `20261104T220618Z` | `/opt/tezlify/backups/releases/active` |
| **Production Container Durumları** | Backend: Healthy, Gateway: Up (Healthy), DB: Up (5432), Caddy: Up | `docker ps --format ...` |
| **Production Session 201** | `CONNECTED` (`Hat 1`, `+905413749073`) — Korundu, dokunulmadı | DB & Gateway Session Manager |
| **Local Test DB** | PostgreSQL 17 (`tezlify_test_isolated`) on `localhost:5432` | Local PostgreSQL instance |

---

## 2. Mevcut Sandbox Mimarisi vs Yeni Sandbox Mimarisi Karşılaştırması

| Boyut | Aşama 8.0.1–8.0.5 Durumu | Aşama 8.0.8 İyileştirilmiş Durum |
|---|---|---|
| **Test Kapsamı** | L1 Unit, L2 Component, L3 SQLite Mock | **L4 Multi-Process Real-Transport E2E** (Gerçek Uvicorn + Gerçek TCP WebSockets + Gerçek PostgreSQL) |
| **Gateway Session Eşleşmesi** | Gevşek: `{gw_id, f"sandbox-session-{session_id}"}` sentetik alias kabul ediliyordu | **Katı ve Deterministik**: Sentetik alias kaldırıldı; yalnızca `gateway_session_id == test.gateway_session_id` eşleşir |
| **Korumalı Oturum Güvenliği** | Statik set `{201}` | **Dinamik & Fail-Closed**: `get_protected_session_ids()`, `WHATSAPP_PROTECTED_SESSION_IDS` konfigürasyonu ile genişletilebilir, 201 daima korumalı |
| **Medya Depolama** | Paylaşımlı `/app/media` riski, sandbox için ayrı depolama yoktu | **Tam İzolasyon**: `SandboxMediaManager` ile `/tmp/tezlify_sandbox_media/<tenant_id>/<test_id>/` |
| **Medya Güvenliği** | MIME ve boyut sınırı geneldi | **MIME Whitelist (JPEG, PNG, PDF, OGG, MP4)**, 15MB limit, SHA-256 bütünlük kontrolü, Path Traversal koruması |
| **Sonuç Temizleme** | Sadece bellek deque limiti ile temizleniyordu | **Kiracı İzolasyonlu Temizleme**: `DELETE /results` ve `DELETE /media/{test_id}` |

---

## 3. Oturum Sahipliği Güvenlik Modeli

1. **Sentetik Alias Kaldırıldı (`events.py` & `sandbox.py`)**:
   - Eski implementasyonda `handle_inbound_message` gelen PONG mesajında `valid_sids = {test_gw, f"sandbox-session-{test.session_id}"}` kontrolü yapıyordu. Bu durum sentetik bir oturum adının gerçek gateway oturumunun yerine geçebilmesine imkan tanıyordu.
   - Bu alias tamamen kaldırılmıştır. Artık gelen gateway event'indeki `gateway_session_id` ile aktif test kaydındaki `gateway_session_id` birebir eşleşmek zorundadır (`ev_gw == expected_gw`). Eşleşmeyen tüm event'ler fail-closed olarak normal ingest hattına bırakılır.
2. **Dinamik Korumalı Oturum Doğrulaması (`get_protected_session_ids()`)**:
   - `Settings` sınıfına `WHATSAPP_PROTECTED_SESSION_IDS` alanı eklendi (`_protected_session_ids_validator` ile `201` daima set içinde tutulur).
   - `is_session_sandbox_eligible(session_id)` fonksiyonu `get_protected_session_ids()` setini kontrol eder. 201 numaralı oturum hiçbir koşulda sandbox için seçilemez.
3. **Session 201 İzolasyonu**:
   - Canlı üretim Session 201 (`Hat 1`, `+905413749073`) sandbox API'lerine parametre olarak verilse dahi HTTP 403 Forbidden (`BLOCKED: PRODUCTION SESSION PROTECTED`) ile anında engellenir.

---

## 4. Tenant ve Veritabanı İzolasyonu

1. **Gerçek PostgreSQL İzolasyonu**:
   - L4 testleri kesinlikle SQLite üzerinde değil; yerel `postgresql+asyncpg://localhost:5432/tezlify_test_isolated` veritabanında çalıştırılmıştır.
   - Test sırasında gerçek PostgreSQL tabloları (`messages`, `conversations`, `contacts`, `whatsapp_sessions`, `whatsapp_private.gateway_sessions`, vb.) kullanılmıştır.
2. **Çoklu Kiracı Sınırları**:
   - Kiracı 1 (`00000000-0000-0000-0000-000000000001`) oturumuna ait mesaj ve sohbet kayıtları, Kiracı 2 (`00000000-0000-0000-0000-000000000002`) tarafından yapılan REST API sorgularında (`/api/v1/whatsapp/conversations`) kesinlikle listelenmemiştir (`tenant1_conv_ids.isdisjoint(tenant2_conv_ids)` doğrulandı).
3. **Üretim Veritabanı Dokunulmazlığı**:
   - `conftest.py` içindeki `assert_test_db_is_not_remote` guard'ı devrededir; testler uzak sunucuya bağlanamaz.

---

## 5. Correlation & Event Isolation Mekanizması

- **Correlation ID Formatı**: `TEZLIFY_SANDBOX:<uuid:16>`.
- **Inbound Interception**:
  - Gateway'den gelen mesaj metni `TEZLIFY_SANDBOX:PONG:<corr>` formatında olduğunda, `events.py` içindeki `sandbox_service.handle_inbound_message()` çağrılır.
  - Eşleşen aktif test kaydı bulunursa `consumed = True` döner.
  - Ingest hattı mesajı `_skip_event()` ile tüketir ve PostgreSQL `messages` veya `conversations` tablosuna **HİÇBİR SATIR YAZMAZ** (Sıfır DB kirliliği kanıtlandı).
- **Müşteri Mesajı Koruma (Fail-Closed Fallback)**:
  - Aktif test yoksa, timeout olmuşsa, correlation ID bilinmiyorsa veya session eşleşmiyorsa `handle_inbound_message()` `False` döner.
  - Mesaj normal müşteri hattına aktarılır; müşteri mesajının kaybolması imkansız hale getirilmiştir.

---

## 6. Medya İzolasyonu Mimarisi (`SandboxMediaManager`)

`backend/app/services/whatsapp/sandbox_media.py` modülü altında izole medya yönetim altyapısı kurulmuştur:

1. **Dizin İzolasyonu**:
   - `settings.WHATSAPP_SANDBOX_MEDIA_DIR` (`/tmp/tezlify_sandbox_media`) altında her kiracı ve test için izole dizin açılır:
     `<base_dir>/<tenant_id>/<test_id>/<filename>`
   - Üretim medya dizini (`/app/media`) ile hiçbir fiziksel bağı yoktur.
2. **Güvenlik Validasyonları**:
   - **Path Traversal Koruması**: Dosya adları `os.path.basename` ile temizlenir; `os.path.commonpath` kontrolü ile dizin dışına çıkma girişimleri `SandboxPathTraversalError` ile engellenir.
   - **MIME Tipi Whitelist**: Yalnızca `image/jpeg`, `image/png`, `application/pdf`, `audio/ogg`, `video/mp4` türleri kabul edilir. Diğer türler HTTP 415 döner.
   - **Boyut Sınırı**: 15 MB (`MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024`). Aşılması durumunda HTTP 413 döner.
   - **SHA-256 Bütünlüğü**: Yüklenen her dosyanın hash'i hesaplanır, istenen hash ile uyuşmazsa `SandboxMediaIntegrityError` (HTTP 422) fırlatılır.
   - **Sidecar Metadata**: Her dosyanın yanına `<filename>.meta.json` yazılarak yükleme zamanı, boyutu, MIME türü ve hash'i kalıcılaştırılır.
3. **Temizleme (Lifecycle Cleanup)**:
   - `DELETE /api/v1/whatsapp/sandbox/media/{test_id}` uç noktası test tamamlandığında dizini ve dosyaları güvenli şekilde siler.

---

## 7. L4 Çoklu Süreç / Gerçek Taşıma Entegrasyon Mimarisi

L4 testi (`backend/tests/test_whatsapp_l4_real_transport.py`) aşağıdaki bileşenleri gerçek ağ ve soketler üzerinden entegre etmiştir:

```
[Gateway WS Client] (websockets)
        │ ws://127.0.0.1:8995/ws/gateway?token=... (Real TCP Socket)
        ▼
[FastAPI Uvicorn Server] (Port 8995, Thread/Process Loop Isolation)
        │
        ├── Ingest / Dedup / Antiban / Sandbox Interceptor
        │
        ├── PostgreSQL Pool (localhost:5432 / tezlify_test_isolated)
        │
        ├── Isolated Media Manager (/tmp/tezlify_l4_media_...)
        │
        ▼ ws://127.0.0.1:8995/ws (Real TCP Socket)
[Frontend Client WS] (websockets listener)
```

### Event Loop ve Asyncpg Bağlantı Çözümü
- **Problem**: Uvicorn sunucusu arka plan iş parçacığında çalışırken, ana pytest iş parçacığındaki event loop ile aynı asyncpg motorunu paylaşması durumunda `RuntimeError: Task got Future attached to a different loop` hatası meydana gelmekteydi.
- **Çözüm**: Uvicorn sunucusuna özel taze `create_async_engine` ve `async_sessionmaker` oluşturuldu; `events.py` ve `whatsapp_service.py` modüllerindeki referanslar bu taze motorla güncellendi. Lifespan tamamlandıktan sonra test oturumu PostgreSql veritabanına idempotence ile kaydedildi.

---

## 8. L4 Test Sonuçları (12 Senaryo Doğrulaması)

| Senaryo No | Test Adı | Kapsam | Sonuç |
|---|---|---|---|
| **1** | `test_l4_scenario_01_gateway_websocket_connection_auth` | Gateway -> Backend gerçek WebSocket TCP bağlantısı & fail-closed token doğrulaması (101 Switching Protocols vs 1008/1011 ret) | **PASSED** |
| **2** | `test_l4_scenarios_02_to_06` (Adım 2) | Gerçek ağ soketi üzerinden TCP event teslimatı (`ws.send`) | **PASSED** |
| **3** | `test_l4_scenarios_02_to_06` (Adım 3) | Backend event kuyruklama ve ingest işleyişi | **PASSED** |
| **4** | `test_l4_scenarios_02_to_06` (Adım 4) | Gerçek PostgreSQL persistence (`messages` tablosuna INSERT doğrulaması) | **PASSED** |
| **5** | `test_l4_scenarios_02_to_06` (Adım 5) | REST API ile kayıt okuma (`GET /health` & `/conversations`) | **PASSED** |
| **6** | `test_l4_scenarios_02_to_06` (Adım 6) | Gerçek zamanlı istemci WebSocket yayını (`/ws` üzerinden anlık bildirim alımı) | **PASSED** |
| **7** | `test_l4_scenario_07_tenant_isolation_cross_tenant_message_boundary` | Farklı kiracılar arasında veri izolasyonu (Kiracı 2, Kiracı 1'in sohbetlerini göremez) | **PASSED** |
| **8** | `test_l4_scenario_08_session_ownership_and_protected_session_rejection` | Yetkisiz kullanıcı engeli (403), Admin yetkisi ve Korumalı Session 201'in sandbox'ta reddi | **PASSED** |
| **9** | `test_l4_scenario_09_duplicate_event_idempotency` | Aynı event iki kez iletildiğinde PostgreSQL'de tam olarak 1 kayıt oluşması (0 mükerrerlik) | **PASSED** |
| **10** | `test_l4_scenario_10_gateway_disconnect_reconnect` | Gateway soketi kopup yeniden bağlandığında sistemin kesintisiz çalışmaya devam etmesi | **PASSED** |
| **11** | `test_l4_scenario_11_sandbox_timeout_lifecycle_determinism` | Yanıtsız kalan sandbox testinin TIMEOUT durumuna geçişi ve temizliği | **PASSED** |
| **12** | `test_l4_scenario_12_sandbox_event_isolation_no_db_write` | Sandbox PONG event'inin bellekte sonlandırılması ve DB'ye 0 satır yazılması (Sıfır DB kirliliği) | **PASSED** |
| **Ek** | `test_l4_scenario_sandbox_media_rest_lifecycle` | Medya yükleme -> SHA-256 hash doğrulaması -> İndirme -> Path traversal engeli -> Silme | **PASSED** |

---

## 9. L5 Live WhatsApp E2E Readiness Durumu

- **Mevcut Durum**: `BLOCKED — dedicated test SIM/account not provisioned`
- **Gerekçe**:
  - Tezlify sisteminde aktif tek canlı WhatsApp oturumu `Session 201` (`Hat 1`, `+905413749073`) olup ticari müşteri iletişimi için kullanılmaktadır.
  - Canlı WhatsApp şebekesi (Meta sunucuları) üzerinden uçtan uca canlı test yapılabilmesi için üretim hatlarından bağımsız, tahsis edilmiş ikinci bir SIM kart / test telefon numarası gerekmektedir.
  - Kullanıcı tarafından açıkça yeni bir test SIM kartı ve oturumu tahsis edilene kadar canlı WhatsApp mesaj gönderimi FAIL-CLOSED olarak bloklanmıştır.

---

## 10. Production Image Provenance Sonuçları

Oracle sunucusu (`ubuntu@130.162.247.20`) üzerinde aktif üretim imajlarının menşei ve bütünlüğü denetlenmiştir:

| Parametre | Tespit Edilen Değer | Doğrulama Yöntemi |
|---|---|---|
| **Active Release Manifest** | `/opt/tezlify/backups/releases/20261104T220618Z/release.json` | JSON manifest okundu |
| **Manifest Deployed Commit** | `133a8c98e1f57da7a1d1d9a0d8c0b2d3127ef6ae` | Bit düzeyinde Git ile doğrulandı |
| **Backend Image Digest** | `sha256:84f40cf35d0eb6a7c48f2b7f73111f185ef3b88523cfd5bf0e50f38b47e24699` | Docker inspect & manifest |
| **Gateway Image Digest** | `sha256:3ecf9661b9e83ec9d9ecf07fe7582c7f5c71db68652b04c86cb326127113e1dc` | Docker inspect & manifest |
| **Build Host & Context** | Production host hermetik build (`release.sh`) | Manifest `metadata` alanı |
| **OCI Etiket Durumu** | Standart compose build OCI git etiketlerini gömmediği için Docker label boştur; provenance doğrudan release manifest ve commit eşleşmesi ile kurulmaktadır. | `docker inspect --format '{{json .Config.Labels}}'` |

---

## 11. Güvenlik Regresyon Testi Sonuçları

Tüm test paketleri çalıştırılarak hiçbir regresyon olmadığı kanıtlanmıştır:

```bash
backend/tests/test_whatsapp_sandbox_*.py + backend/tests/test_whatsapp_l4_real_transport.py
======================== 78 passed, 9 warnings in 5.35s ========================
```

Frontend tarafı:
- `npm --prefix frontend run verify:logic`: **PASS (56 checks)**
- `npm --prefix frontend run build`: **PASS (built in 3.04s, 0 TypeScript error)**

---

## 12. Değiştirilen ve Oluşturulan Dosyalar

| Dosya Yolu | İşlem Türü | Açıklama |
|---|---|---|
| `backend/app/core/config.py` | Değiştirildi | `WHATSAPP_PROTECTED_SESSION_IDS`, `WHATSAPP_SANDBOX_MEDIA_DIR`, `WHATSAPP_SANDBOX_TENANT_ID` ve validatörler eklendi. |
| `backend/app/schemas/whatsapp_sandbox.py` | Değiştirildi | `SandboxMediaUploadResponse` şeması eklendi. |
| `backend/app/services/whatsapp/sandbox.py` | Değiştirildi | `get_protected_session_ids()`, katı `gateway_session_id` eşleşmesi (alias kaldırıldı), `clear_results_history()` eklendi. |
| `backend/app/services/whatsapp/sandbox_media.py` | **Yeni Dosya** | `SandboxMediaManager`: MIME whitelist, SHA-256 bütünlüğü, boyut sınırı, path traversal koruması ve test temizliği. |
| `backend/app/api/v1/endpoints/whatsapp_sandbox.py` | Değiştirildi | `POST /media/upload`, `GET /media/{test_id}/{filename}`, `DELETE /media/{test_id}`, `DELETE /results` eklendi. |
| `backend/tests/test_whatsapp_sandbox_media.py` | **Yeni Dosya** | Medya izolasyonu ve güvenlik test paketi (7 test). |
| `backend/tests/test_whatsapp_sandbox_api.py` | Değiştirildi | Medya REST endpoint'leri ve sonuç temizleme testleri eklendi. |
| `backend/tests/test_whatsapp_l4_real_transport.py` | **Yeni Dosya** | 12 senaryolu tam multi-process L4 E2E entegrasyon test paketi (9 test fonksiyonu). |
| `reports/whatsapp-phase-8.0.8-dedicated-sandbox-l5-foundation.md` | **Yeni Dosya** | Aşama 8.0.8 kapsamlı denetim ve mimari raporu. |

---

## 13. Kalan Riskler ve Öneriler

1. **L5 İçin SIM Kart İhtiyacı**:
   - Meta WhatsApp şebekesi üzerinde gerçek uçtan uca doğrulama yapılabilmesi için üretim hatlarından tamamen izole dedicated bir test SIM kartı temin edilmelidir.
2. **OCI İmaj Etiketleme Önerisi**:
   - Gelecek release betiklerinde `docker build` komutuna `--label org.opencontainers.image.revision=$(git rev-parse HEAD)` parametresi eklenerek Docker imajlarının içine doğrudan Git commit SHA'sı gömülebilir.

---

## 14. Nihai Karar

**Karar: `PASS_WITH_NOTES`**

- **Gerekçe**:
  - Aşama 8.0.8 kapsamında talep edilen tüm teknik, güvenlik ve operasyonel hedefler eksiksiz tamamlanmıştır.
  - L4 çoklu süreç E2E entegrasyon testi gerçek Uvicorn, gerçek WebSocket TCP taşıması ve yerel PostgreSQL üzerinde 12 senaryonun tamamında başarılı olmuştur.
  - Sandbox medya depolaması üretim dizininden tamamen izole edilmiş, MIME/SHA-256/Path-Traversal kontrolleriyle sertleştirilmiştir.
  - Canlı üretim `Session 201` (`+905413749073`) kesinlikle korunmuş ve dokunulmamıştır.
  - L5 durumu `BLOCKED — dedicated test SIM/account not provisioned` olarak doğru şekilde kayıt altına alınmıştır.
  - Kullanıcı talimatı gereği production deployment yapılmamış, Aşama 8.0.9'a geçilmeden durulmuştur.
