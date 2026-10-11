# TEZLIFY — ADMIN & OPERATIONS CENTER STAGING ACCEPTANCE & BASELINE REGRESSION REPORT (PHASE A.1)

- **Date:** 2026-10-11
- **Auditor Role:** Staff Software Engineer, SRE, Application Security Engineer & QA Lead
- **Starting Reference Commit:** `9d2560b85bb199f9fd596b0bbb94e482e7101e56`
- **Branch:** `main` (synchronized with `origin/main`)
- **Nihai Karar (Final Gate Decision):** `STAGING BLOCKED — ENVIRONMENT OR EVIDENCE MISSING`

---

## 1. Git & Değişiklik Bütünlüğü Doğrulaması (PHASE 1)

Mevcut Git durumu kaynak kod düzeyinde kontrol edildi:
- `git branch --show-current`: `main`
- `git rev-parse HEAD`: `9d2560b85bb199f9fd596b0bbb94e482e7101e56`
- `git rev-parse origin/main`: `9d2560b85bb199f9fd596b0bbb94e482e7101e56`
- `git status --short`: Boş (çalışma ağacı tamamen temiz, uncommitted değişiklik yok).
- Son 5 commit:
  - `9d2560b` test(admin): adversarial incident hardening, unmeasured duration remediation, and release gate verification
  - `2dc5b5b` feat(admin): human-centric operations center with incident engine and executive summary (Phase A)
  - `ce27472` docs: add comprehensive admin and operations center engineering guide
  - `c791b31` test(whatsapp): expand postgresql concurrency tests with existing wa_id and post-recovery retry safety
  - `e9b6a56` test(whatsapp): persist postgresql multi-process concurrency and crash-recovery test suite

---

## 2. İki Başarısız WhatsApp Testinin Kök Neden Analizi (PHASE 2)

Tam backend test paketinde (`pytest backend/tests/ -v`) görülen 2 test hatası bağımsız olarak analiz edildi:

### Test 1: `test_22_snapshot_shape_matches_job_response_schema`
- **Dosya:** `backend/tests/test_whatsapp_sync_job.py:791-800`
- **Çalıştırma:** `pytest backend/tests/test_whatsapp_sync_job.py -k test_22_snapshot_shape_matches_job_response_schema -v`
- **Hata:**
  ```text
  AssertionError: assert {'backfill_done', ..., 'session_key', 'user_id'} == {'backfill_done', ...}
  Extra items in the left set:
  'session_key'
  'user_id'
  ```
- **Kök Neden & Tarihçe:**
  - `SyncJob.snapshot()` metoduna `session_key` ve `user_id` alanları **10 Ekim 2026** tarihli `ec08eba` (`feat(whatsapp): optimize baileys history sync, pairing promotion and watermark scoping`) commit'inde eklendi.
  - `schemas/whatsapp.py` içindeki `WhatsAppSyncJobResponse` Pydantic şemasında bu iki alan model fields listesine dahil edilmediği için, testteki katı `set(snap.keys()) == set(WhatsAppSyncJobResponse.model_fields.keys())` assertion'ı başarısız oldu.
- **Sınıflandırma:** `PRE-EXISTING` (Phase A öncesinden mevcut). Admin paneli ile ilişkisiz.

### Test 2: `test_15_outbound_ack_echo_race`
- **Dosya:** `backend/tests/test_whatsapp_history_orchestration.py:738-780`
- **Çalıştırma:** `pytest backend/tests/test_whatsapp_history_orchestration.py -k test_15_outbound_ack_echo_race -v`
- **Hata:**
  ```text
  AssertionError: assert 'SENT' == 'PENDING'
  - PENDING
  + SENT
  ```
- **Kök Neden & Tarihçe:**
  - **18 Eylül 2026** tarihli `d29c227` (`fix(whatsapp): advance group and outbound messages to SENT immediately upon successful dispatch`) commit'inde, `send_text_message` metodu başarılı ağ kabulü ve `wa_message_id` alındığında mesaj durumunu derhal `SENT` durumuna ilerletecek şekilde değiştirildi (`if target_status in (None, "PENDING"): target_status = ConversationMessageStatus.SENT.value`).
  - Eski `test_15` testi bu commit öncesi yazılmış olup `res["status"] == "PENDING"` beklentisinde kalmıştı.
- **Sınıflandırma:** `PRE-EXISTING` (Phase A öncesinden mevcut). Admin paneli ile ilişkisiz.

---

## 3. Baseline Karşılaştırması (PHASE 3)

Phase A değişiklikleri öncesindeki son commit olan `c791b31` üzerinde geçici izole bir Git worktree (`scratch/baseline-worktree`) oluşturularak aynı testler birebir çalıştırıldı:

| Test | Mevcut Commit (`9d2560b`) | Baseline Commit (`c791b31`) | Durum Sınıflandırması |
| :--- | :--- | :--- | :--- |
| `test_22_snapshot_shape_matches_job_response_schema` | **FAILED** (Extra: `session_key`, `user_id`) | **FAILED** (Extra: `session_key`, `user_id`) | **PRE-EXISTING** |
| `test_15_outbound_ack_echo_race` | **FAILED** (`'SENT' == 'PENDING'`) | **FAILED** (`'SENT' == 'PENDING'`) | **PRE-EXISTING** |
| `test_admin_*.py` (84 test) | **84 PASSED** (100%) | **84 PASSED** (100%) | **PASS (Regresyonsuz)** |

Her iki başarısızlığın da Phase A öncesinde kesin olarak var olduğu kanıtlanmıştır. Admin paneli değişiklikleri hiçbir yeni regresyona neden olmamıştır.

---

## 4. Staging Ortamı İzolasyon Denetimi (PHASE 4)

Repository dokümantasyonu, scriptleri ve dağıtım dosyaları incelendi:

1. **Ayrı Staging Hostu/Clusterı Var mı?**
   - **HAYIR.** Projede ayrı bir staging sunucusu, staging container kümesi veya staging IP'si tanımlı değildir.
2. **Dağıtım Scripti (`scripts/deploy/release.sh`) Hedefi:**
   - `HOST="ubuntu@130.162.247.20"` (Doğrudan **CANLI PRODUCTION** sunucusudur).
   - `API_HEALTH_URL="https://api.130.162.247.20.sslip.io/health"` (Canlı API).
3. **Staging Adlandırmasının Kökeni:**
   - Kod tabanındaki "staging" ifadeleri; PostgreSQL içindeki `auth_staging_users` / `auth_staging_sessions` tablolarından ve sunucuda canlı release cutover'ı öncesi oluşturulan geçici `frontend_next` / `candidate` adacığından ibarettir.
4. **İzolasyon Riski:**
   - Mevcut `release.sh` veya `host-release.sh` komutlarını "staging doğrulaması" amacıyla çalıştırmak, **doğrudan canlı production sunucusunda (`130.162.247.20`) servisleri ve Docker container'larını güncelleyecektir.**
   - Bu durum "Production'a deploy etme" kırmızı çizgisine aykırıdır.

**Sonuç:** Gerçek ve izole bir staging sunucusu bulunmadığı için staging dağıtımı **STRICTLY BLOCKED** statüsündedir.

---

## 5. Staging Kabul Kriterleri Doğrulama Tablosu (PHASE 5)

Yerel hermetik ortamda ve sözleşme testlerinde (jsdom, Python 3.14 venv, in-memory ve mock katmanında) doğrulanabilen kriterler:

| Senaryo # | Kabul Kriteri | Doğrulama Türü | Sonuç |
| :--- | :--- | :--- | :--- |
| **1** | Admin olmayan kullanıcı yönetim alanına erişemez (403 Fail-Closed) | Pytest API Testi (`test_admin_auth.py`) | **PASS** |
| **2** | Overview sayfası telemetri hatasında `unavailable` gösterir | Node / Unit (`test-incident-engine.mjs`) | **PASS** |
| **3** | Gateway, Backend ve Caddy logları ayrı servisler olarak görünür | jsdom / DOM (`verify-admin-ops-dom.mjs`) | **PASS** |
| **4** | Log çekme hatası oluştuğunda uygun hata durumu üretilir | React Component (`AdminOperationsPage.tsx`) | **PASS** |
| **5** | Tekrarlanan hatalar dedup edilir; farklı servisler ve HTTP kodları ayrılır | Node / Unit (`test-incident-engine.mjs`) | **PASS** |
| **6** | Token, Bearer ve parolalar log parmak izi ve başlıklardan temizlenir | Node / Adversarial (`test-incident-engine.mjs`) | **PASS** |
| **7** | Olay görünümü ile ham log görünümü arasında geçiş yapılır | React Component (`ErrorFeed.tsx`) | **PASS** |
| **8** | İşlem geçmişinde `exit_code` ile post-op health-check ayrıştırılır | jsdom / DOM (`OpsHistoryPanel.tsx`) | **PASS** |
| **9** | Onay pencereleri (`toast.confirm`) yıkıcı işlemler öncesi tetiklenir | React Hook / Logic (`AdminOperationsPage.tsx`) | **PASS** |
| **10** | Türkçe ve İngilizce dil dosyalarında eksik/taşan anahtar yoktur | Static AST (`audit-admin-i18n.mjs` - 1868 anahtar) | **PASS** |
| **11** | Mobil ve masaüstü arayüz düzenleri duyarlıdır (responsive grid) | CSS / Tailwind Grid (`OverviewPanel.tsx`) | **PASS** |
| **12** | Gerçek İzole Staging Sunucu Dağıtımı | Host Altyapısı | **BLOCKED** (İzole staging sunucusu yok) |

---

## 6. Güvenli Staging Ortamı Kurulumu İçin Gereksinimler

Projede production'dan bağımsız bir staging ortamı oluşturulmak istenirse şu adımlar gereklidir:
1. **İzole Host:** Production IP'sinden (`130.162.247.20`) bağımsız ayrı bir VM veya staging alt alanı (`staging.tezlify.io`).
2. **İzole Veritabanı:** Canlı müşteri ve WhatsApp verilerini içermeyen, boş şemalı staging PostgreSQL veritabanı.
3. **Bağımsız Docker Socket:** Staging backend'inin production Docker daemon'una erişimi olmamalı (`/var/run/docker.sock` staging VM'inde izole olmalı).
4. **Dağıtım Scripti Ayrımı:** `scripts/deploy/release.sh` scriptine `--staging` bayrağı ve `STAGING_HOST` desteği eklenmeli.

---

## 7. Nihai Yayın Kararı

### Karar: **`STAGING BLOCKED — ENVIRONMENT OR EVIDENCE MISSING`**

**Gerekçe:**
- Admin & Operations Center kaynak kodu, arayüz zekası, lokalizasyon ve güvenlik testleri yerel ortamda **%100 doğrulanmış ve yeşildir**.
- Tam backend paketindeki 2 WhatsApp test başarısızlığının **Phase A ile hiçbir ilgisi olmadığı ve Phase A öncesinden beri var olduğu (PRE-EXISTING)** kanıtlanmıştır.
- Ancak projede bağımsız bir staging sunucusu bulunmadığı ve mevcut dağıtım scriptinin doğrudan canlı production sunucusunu hedeflediği kanıtlandığından; staging testi tamamlanmış sayılamaz. Canlı ortama müdahale etmemek adına staging dağıtımı fail-closed olarak durdurulmuştur.
