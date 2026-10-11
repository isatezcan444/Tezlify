# TEZLIFY — ADMIN & OPERATIONS CENTER AUDIT (PHASE A0)
## Mevcut Durum Denetimi, Baseline Sonuçları ve İnsan Odaklı Dönüşüm Planı

- **Tarih:** 2026-10-11
- **Denetim Türü:** Salt-okunur Mimari, Kod ve Güvenlik Denetimi (Read-Only Forensic Audit)
- **Başlangıç Commit:** `ce27472ab148e982c8c311f58d9c8d158e5ba5b5`
- **Çalışma Ağacı:** Temiz (Clean)

---

## 1. YÜRÜTME ÖZETİ VE BASELINE TEST SONUÇLARI

Mevcut Tezlify Yönetim ve Operasyon Merkezi; güçlü bir güvenlik modeline, allowlist tabanlı operasyon motoruna (`ops_service.py`) ve zengin telemetri altyapısına sahiptir. Ancak bu altyapı **teknik bir SRE mühendisi gözüyle** tasarlanmış olup, teknik olmayan bir yöneticinin (executive / operations manager) sistem sağlığını bir bakışta anlamasını, sorunları doğru önceliklendirmesini ve güvenli aksiyon almasını zorlaştıran ciddi bilgi mimarisi ve gürültü (noise) problemleri barındırmaktadır.

### Baseline Test Koşum Sonuçları

| Test Paketi | Kapsam | Sonuç | Notlar |
|---|---|:---:|---|
| **Backend Admin Ops API** | `pytest backend/tests/test_admin_ops_api.py` | **23/23 PASSED** | Log tailing, allowlist, 409 kilit, truncate testleri tam |
| **Backend Admin Ops Security** | `pytest backend/tests/test_admin_ops_security.py` | **26/26 PASSED** | RCE engelleme, redaction, cooldown, non-root DB testleri tam |
| **Backend Admin Security Leakage**| `pytest backend/tests/test_admin_security_leakage.py` | **3/3 PASSED** | Maskeleme, phone masking, zero token leak |
| **Backend Frontend Admin Scenarios**| `pytest backend/tests/test_frontend_admin_scenarios.py`| **6/6 PASSED** | Tüm salt-okunur DTO sözleşmeleri |
| **Backend Admin Endpoints & Infra**| `pytest backend/tests/test_admin_endpoints.py ...` | **26/26 PASSED** | Degraded DB, mock data, disk parser |
| **Backend Admin Auth** | `pytest backend/tests/test_admin_auth.py` | **5/5 PASSED** | `require_admin` 401/403 fail-closed |
| **TOPLAM BACKEND ADMİN** | **7 Dosya** | **89/89 PASSED** | **100% Başarılı (3.30s)** |
| **Frontend Ops DOM Testi** | `npm run verify:ops-dom` | **13/13 PASSED** | Servis durumları, buton kilitleri, realtime rozet |
| **Frontend Admin i18n & Motion** | `npm run audit:admin-i18n` | **PASSED** | 1740 anahtar senkronize, font & keyframe OK |
| **Frontend Build** | `npm run build` | **PASSED** | `tsc && vite build` sıfır hata (2.0s) |
| **Frontend Ops Client Testi** | `npm run verify:ops-client` | **23/24 PASSED (1 FAIL)** | Check 24: `Caddyfile` `(backend_proxy_https)` snippet import ayrımı nedeniyle beklenti uyuşmazlığı |

---

## 2. MEVCUT SİSTEMİN BULGU VE TESPİTLERİ (TAGGED FINDINGS)

### A. Navigasyon ve Bilgi Mimarisi
1. **[CONFIRMED]** Navigasyon 7 ayrı dağınık sekmeye bölünmüştür (`admin-overview`, `admin-whatsapp`, `admin-monitoring`, `admin-backups`, `admin-operations`, `admin-deployment`, `admin-security`).
   - *Kanıt:* `Sidebar.tsx:81-87` ve `App.tsx:78-84`.
   - *Etki:* Bir yönetici WhatsApp'ın sağlıklı olup olmadığını anlamak için `admin-whatsapp`'a; konteynerin çalışıp çalışmadığını görmek için `admin-operations` -> `System`'e; hata olup olmadığını görmek için `admin-operations` -> `Errors`'a; lease kuralının ihlal edilip edilmediğini görmek için ise `admin-monitoring`'e gitmek zorundadır.
2. **[CONFIRMED]** URL sekme yönetimi `readTabFromUrl` ile korunmakta ve `VALID_TABS` seti ile doğrulanmaktadır (`App.tsx:70-95`). Eski sekmelerin kırılmaması geriye uyumluluk için şarttır.

### B. Hata Logları, Olay Yönetimi ve Gürültü
3. **[CONFIRMED]** Backend tarafında olay gruplama (incident aggregation), kök neden (root cause) çıkarımı, fingerprinting veya severity politikası **BULUNMAMAKTADIR**.
   - *Kanıt:* `backend/app/services/admin/` dizininde yalnızca ham log satırlarını okuyan `get_service_logs` mevcuttur.
4. **[CONFIRMED]** `ErrorFeed` ham log satırlarını tek tek bir diziye dökmekte ve hiçbir tekilleştirme (deduplication) yapmamaktadır.
   - *Kanıt:* `frontend/src/components/admin/ops/ErrorFeed.tsx:42-53` (`buildErrorFeed` fonksiyonu her `ERROR` ve `WARN` satırını ayrı birer eleman olarak `out.push` eder).
   - *Etki:* 50 kez tekrarlanan bir geçici bağlantı denemesi ekranda 50 adet korkutucu kırmızı hata kartı oluşturarak panik yaratmakta ve gerçek sorunları gölgelemektedir.
5. **[CONFIRMED - BUG]** `AdminOperationsPage` ilk yüklendiğinde **yalnızca gateway logunu** çekmektedir (`fetchLogs('gateway')`).
   - *Kanıt:* `frontend/src/pages/admin/AdminOperationsPage.tsx:233-236`. `setLogsByService` sadece seçili servis için çağrılmaktadır.
   - *Etki:* Kullanıcı "Logs" sekmesine gidip `backend` veya `caddy` butonuna basana kadar "Errors" sekmesinde backend ve caddy hataları **HİÇ GÖRÜNMEMEKTEDİR**.
6. **[CONFIRMED]** Ham log maskeleme (`redact()`) backend tarafında sıkı bir şekilde uygulanmaktadır (`ops_service.py:70-78`). Şifreler, auth anahtarları ve token'lar UI'a asla sızmamaktadır.

### C. Servis Sağlığı ve Operasyon Motoru
7. **[CONFIRMED]** Operasyon motoru (`ops_service.py`) katı bir Anti-RCE beyaz liste (`OPERATIONS`) modeline sahiptir (`ops_service.py:146-220`). Serbest kabuk komutu çalıştırma imkânı sıfırdır.
8. **[CONFIRMED]** Aile bazlı kilit (`_inflight`) ile eşzamanlı çakışan operasyonlar `409 Conflict` ile engellenmektedir (`ops_service.py:230`).
9. **[CONFIRMED]** Yıkıcı (destructive) operasyonlar için 30 saniye `cooldown` ve `confirm: true` zorunludur.
10. **[CONFIRMED]** Kalıcı durum (`.ops-state/operations.json`) sayesinde backend kendini restart ettiğinde operasyon kaydı kaybolmamakta, `_recover_orphans()` ile `interrupted` olarak kurtarılmaktadır.
11. **[CONFIRMED]** PostgreSQL konteyneri (`tezlify-db`) beyaz listede yer almamaktadır ve panelden restart edilemez (`ALLOWED_SERVICES = ("backend", "gateway", "caddy")`).
12. **[CONFIRMED]** Log temizleme işlemi dosyayı yerinde `truncate` eder (`ops_service.py:947-980`). Konteyner yeniden başlatılmaz, canlı WhatsApp soketi kopmaz.
13. **[LIKELY]** Bir operasyon bittiğinde (`exit_code == 0`), arayüzde doğrudan "Başarılı" denmektedir; ancak servisin HTTP katmanında gerçekten `/health` 200 verip vermediği kart üzerinde ayrık bir doğrulama adımı olarak vurgulanmamaktadır.

### D. Telemetri, Polling ve Realtime Akış
14. **[CONFIRMED]** `AdminOperationsPage`, WebSocket üzerinden `tezlify:ws_event` (`ops_event`) dinlemekte ve realtime çalışmaktadır (`useOpsEvents.ts`).
15. **[CONFIRMED]** WebSocket bağlıyken HTTP polling süresi 60 saniyeye düşürülmekte; bağlantı yokken 15 saniyede bir polling yapılmaktadır (`AdminOperationsPage.tsx:151-156`).
16. **[CONFIRMED]** Sekme arka plana geçtiğinde (`document.visibilityState === 'hidden'`) polling durdurularak gereksiz sunucu yükü önlenmektedir.
17. **[LIKELY]** Telemetri bağlantısı koptuğunda veya sunucu 502/hata verdiğinde arayüz bazen eski (stale) veriyi canlı gibi gösterebilmektedir.

---

## 3. VERİ AKIŞI VE BAĞIMLILIK HARİTASI

```
[ TARAYICI (Admin) ]
   ├── AdminShell.tsx (Header, son güncelleme, anında yenile butonu, i18n)
   │
   ├── AdminOverviewPage (admin-overview)
   │     └── GET /api/v1/admin/overview ──► overview_service.py (CPU, RAM, Disk, DB Pool)
   │
   ├── AdminOperationsPage (admin-operations)
   │     ├── GET /api/v1/admin/ops/status ──► ops_service.py (Konteyner durumları, aktif operasyon, audit)
   │     ├── GET /api/v1/admin/ops/logs ────► ops_service.py (Doğrudan docker json-file okuma)
   │     ├── POST /api/v1/admin/ops/operations ──► ops_service.py (Allowlist komut başlatma)
   │     ├── POST /api/v1/admin/ops/logs/clear ──► ops_service.py (Yerinde log truncate)
   │     └── WS /ws (tezlify:ws_event) ─────► ws_manager (Realtime operasyon durumu)
   │
   ├── AdminWhatsAppPage (admin-whatsapp)
   │     └── GET /api/v1/admin/whatsapp ──► whatsapp_admin_service.py (Runtime, lease, outbox, ghost)
   │
   ├── AdminMonitoringPage (admin-monitoring)
   │     └── GET /api/v1/admin/monitoring ──► monitoring_admin_service.py (R1-R13 Invariants)
   │
   ├── AdminBackupsPage (admin-backups)
   │     └── GET /api/v1/admin/backups ────► backups_admin_service.py (Postgres & media dumps)
   │
   ├── AdminDeploymentPage (admin-deployment)
   │     └── GET /api/v1/admin/deployment ──► deployment_admin_service.py (Git SHA, releases, digests)
   │
   └── AdminSecurityPage (admin-security)
         └── GET /api/v1/admin/security ──► security_admin_service.py (SSH, UFW, headers audit)
```

---

## 4. KULLANICI DENEYİMİ (UX) PROBLEMLERİ VE GÜVENLİK RİSKLERİ

### Kullanıcı Deneyimi Problemleri (Executive & Operator Perspective)
1. **Bilişsel Aşırı Yükleme:** Yönetici panele girdiğinde 7 sekme, onlarca teknik metrik ve RSS değerleri görmektedir. "Şu anda acil bir sorun var mı?" sorusunun yanıtı tek bir merkezde özetlenmemektedir.
2. **Hata ve Olay Ayrımının Olmaması:** Logdaki her teknik uyarı veya hata aynı ağırlıkta kırmızı kart olarak basılmaktadır. Geçici bir 10 saniyelik ağ timeout'u ile veritabanı kilitlenmesi görsel olarak farksızdır.
3. **Eksik Hata Kapsamı (Seeding Defect):** Sadece gateway logları önceden yüklendiği için backend ve caddy çökmeleri ilk bakışta Hatalar sekmesine yansımamaktadır.
4. **Rehbersiz Aksiyon:** Yönetici bir hata gördüğünde "Ne yapmalıyım? Restart edersem müşteriler etkilenir mi?" sorularının yanıtını bulamamaktadır.

### Güvenlik ve Operasyonel Riskler
1. **Docker Soket Yetkisi:** Backend üzerindeki `/var/run/docker.sock` root eşdeğeridir. `require_admin` koruması ve sabit `List[str]` argüman kuralı tavizsiz sürdürülmelidir.
2. **Kör Restart Riski:** Bir hata görüldüğünde operatörün panikle konteyner restart butonuna basması, o sırada aktif devam eden WhatsApp mesaj gönderimlerini ve socket oturumlarını kesintiye uğratabilir. Her aksiyon risk seviyesi ve beklenen etki ile açıklanmalıdır.
3. **PostgreSQL Güvenliği:** DB konteynerinin operasyon merkezinden izole kalması hayati önemdedir.

---

## 5. EN YÜKSEK DEĞERLİ İYİLEŞTİRMELER VE UYGULAMA PLANI

| Aşama | Başlık | Yapılacak İyileştirme | Regresyon Riski |
|:---:|---|---|:---:|
| **A1** | **Bilgi Mimarisi ve Yönetici Özeti** | Eski sekmeleri kırmadan ana operasyon merkezinde üstte "Sistem Sağlığı Özeti", "Aktif Olaylar", "WhatsApp Canlı Durumu" ve "Tavsiye Edilen Eylemler" kartlarını konumlandırma. | Çok Düşük (Salt UI/gruplama) |
| **A2** | **Olay (Incident) Modeli & Gruplama** | Ham logları deterministik parmak izi (fingerprint), servis, hata sınıfı ve zaman penceresiyle gruplayan; tekrar sayısını (`count`), ilk/son görülmeyi, insan dilinde "Ne oldu? / Etki / Öneri" alanlarını üreten olay motoru geliştirme. Tüm servislerin loglarını eksiksiz tarama. | Düşük (Yeni utility / servis) |
| **A3** | **Güvenli Operasyon UX** | İşlem butonlarına "Beklenen Etki", "Olası Kesinti Riski", "Geri Alınabilirlik" açıklamaları ekleme; başarılı komut sonrası gerçek `/health` sonucunu gösterme. | Çok Düşük |
| **A4** | **İşlem Geçmişi ve Teşhis** | Operasyon geçmişini adım adım zaman çizelgesi, insan dostu özet ve açılır ham stdout/stderr modalı ile anlaşılır kılma. | Çok Düşük |
| **A5** | **Responsive & Erişilebilirlik** | Dar ekranlarda tablo taşmalarını önleme, klavye ile gezinme ve Türkçe/İngilizce dil anahtarlarını tamamlama. | Yok |
| **A6** | **Regresyon, Build ve Test** | Yeni olay motoru ve UI bileşenleri için kapsamlı testler çalıştırma, test assertion uyumsuzluklarını giderme. | Yok |

---

## 6. SONUÇ VE BİR SONRAKİ ADIM

Aşama 0 denetimi başarıyla tamamlanmıştır. Mevcut backend mantığı ve güvenlik sözleşmeleri korunarak, teknik karmaşıklığı ortadan kaldıracak insan odaklı dönüşüm A1 aşaması ile başlatılmaya hazırdır.
