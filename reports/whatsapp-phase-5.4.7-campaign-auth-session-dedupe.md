# AŞAMA 5.4.7 — Campaign Medya Uç Noktası Yetkilendirmesi ve Çapraz Oturum Dedupe İzolasyonu

**Tarih:** 2026-11-03 (TRT)
**Kapsam:** AŞAMA 5.4.6 denetiminde bulunan iki MEDIUM bulgunun düzeltilmesi + regresyon testleri
**Tür:** KODLAMA — dar kapsamlı güvenlik düzeltmesi (altyapı/deploy/commit/push YOK)
**Çalışma alanı:** `/private/tmp/tz429-release`
**Sonuç:** **PASS_WITH_NOTES** (A-1 ve A-2 testleri geçti; residual riskler bölüm 9'da)

---

## 1. Başlangıç ve Bitiş Git Durumu

| Alan | Başlangıç | Bitiş | Durum |
|---|---|---|---|
| `pwd` | `/private/tmp/tz429-release` | `/private/tmp/tz429-release` | Aynı |
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` | Aynı |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | **Aynı** |
| Staged değişiklik | 0 | 0 | Aynı |
| Modified | 9 | 12 | +3 (yalnız A-1 dosyaları) |
| Untracked giriş | 14 | 16 | +2 (yalnız yeni testler) |

**Önceden var olan 9 modified dosya korundu.** Bunlardan 7'sine dokunulmadı; 2'si (`package.json`,
`media-store.js`) A-2 düzeltmesi için bilinçli olarak genişletildi.
**Önceden var olan 14 untracked giriş korundu.** Bunlara 2 yeni test dosyası eklendi
(`reports/` zaten untracked klasördü; bu rapor içine yazıldı).

---

## 2. Düzeltilen Bulgular

### A-1 — `GET /api/v1/campaigns/media/{file_id}` kimlik doğrulaması ve tenant sahipliği olmadan erişilebiliyordu

**Düzeltme:** Uç nokta artık `get_current_user` bağımlılığını kullanır ve SUNUCU tarafında
`_authorize_campaign_media()` ile sahiplik doğrular. Sahiplik, yükleme anında yazılan güvenilir
`<file_id>.owner.json` yan dosyasından okunur. Yan dosyası olmayan eski yüklemeler için tek güvenilir
sinyal `Campaign.media_url` referansıdır: yalnızca **tek bir** tenant referans veriyorsa ve bu tenant
çağıran ise izin verilir; NULL sahipli veya çok-tenantlı referans fail-closed reddedilir. Yetkisiz
durumda `get_media_file_info()` çağrılmaz (dosya açılmaz, indirme tetiklenmez, yol sızmaz) ve
varlık oracle'ı olmaması için **404** döner.

**Yetkilendirme matrisi (test_campaign_media_auth.py):**

| Senaryo | Beklenen | Gerçek | Durum |
|---|---|---|---|
| Auth header yok (prod bağlamı), GET | 401 | 401 | PASS |
| Auth header yok (prod bağlamı), upload | 401 | 401 | PASS |
| Geçersiz token | 401 | 401 | PASS |
| Boş user id, GET | 404 | 404 | PASS |
| Boş user id, upload | 401 | 401 | PASS |
| Sahip kendi yüklemesini okur | 200, doğru byte/MIME/attachment | 200 | PASS |
| Başka tenant'ın campaign media'sı | 404, `get_media_file_info` çağrılmaz | 404 | PASS |
| Başka tenant'ın media ID'si (B kampanyasına eklenmiş olsa bile) | 404 | 404 | PASS |
| Var olmayan campaign/media | 404, açma yok | 404 | PASS |
| Eski medya, tek tenant referansı (sahip) | 200 | 200 | PASS |
| Eski medya, tek tenant referansı (yabancı) | 404 | 404 | PASS |
| Eski medya, iki tenant referansı (belirsiz) | 404 (her iki taraf) | 404 | PASS |
| Bozuk owner metadata | 404 (fail-closed) | 404 | PASS |
| Owner metadata yükleyiciyi kaydeder | `user_id` doğru | doğru | PASS |

### A-2 — Aynı `waMessageId` ile sıralı çapraz oturum medya dedupe'ı oturumları birleştiriyordu

**Düzeltme:** Dedupe kimliği gerçek oturuma bağlandı. `findExistingMediaByWaId()` artık
`session.id`'den türetilen `scope` ile:
- RAM hızlı yolunda `entry.sessionId === scope` koşulunu,
- disk taramasında `findMetaByWaIdAsync(strId, scope)` filtresini,
- in-flight tarama anahtarında `scanKey = scope + "\0" + strId` ayrımını

kullanır. Aynı oturum + aynı ID teklik korunur; farklı oturumlar bağımsız kayıt üretir. Mevcut
process-local `ingestLocks` kilit mekanizması korunur; dağıtık/multi-process kilit eklenmedi.
Geçmiş/re-link uyumluluğu için oturumdan bağımsız global aramalar (`getMediaIdByWaId`,
`getMediaPath`, `resolveMediaPath`) bilinçli olarak değiştirilmedi — yalnızca **dedupe** kapsamlandı.

**Dedupe matrisi (test-media-session-dedupe-547.mjs, 50 assertion):**

| # | Senaryo | Doğrulanan | Sonuç |
|---|---|---|---|
| 1 | Aynı oturum + aynı ID, eşzamanlı | 1 indirme, tek kayıt | PASS |
| 2 | Aynı oturum + aynı ID, sıralı | yeniden kullanım | PASS |
| 3 | Farklı oturum, sıralı | 2 bağımsız kayıt | PASS |
| 4 | Farklı oturum, eşzamanlı | bağımsız ingestion | PASS |
| 5 | A başarısız / B başarılı | B etkilenmez | PASS |
| 6 | A retry / B mevcut | kayıtlar karışmaz | PASS |
| 7 | Aynı oturum + farklı ID | 2 bağımsız kayıt | PASS |

Her senaryoda `sessionId`, `waMessageId`, indirme sayısı ve medya ID'leri ayrı ayrı doğrulandı.

**A-2 öncesi/sonrası probe (aynı senaryo):**

| Ölçüm | Öncesi (5.4.6) | Sonrası (5.4.7) |
|---|---|---|
| downloads | 1 | **2** |
| same_media_id | true | **false** |
| sidecar oturumları | `sess-a` | `sess-a` + `sess-b` |
| dosya/sidecar | 1 / 1 | **2 / 2** |
| yol paylaşımı | paylaşımlı | **paylaşımsız** |

---

## 3. Değişen Dosyalar (tek tek)

| Dosya | Değişiklik | İlgili bulgu |
|---|---|---|
| `backend/app/api/v1/endpoints/campaigns.py` | `get_campaign_media`'ya `get_current_user` + `get_db`; `_authorize_campaign_media` ve `_same_tenant_id`; yetkisizde 404 | A-1 |
| `backend/app/services/campaign_media_service.py` | `MediaOwnership`; owner sidecar okuma/yazma; boş `user_id` → 401; sidecar yazılamazsa dosyayı silip 500 | A-1 |
| `backend/tests/test_campaign_media.py` | Eski (legacy) XSS testleri owner metadata yazacak şekilde güncellendi; cleanup genişletildi | A-1 (regresyon uyumu) |
| `backend/tests/test_campaign_media_auth.py` **(yeni)** | 10 testlik A-1 yetkilendirme matrisi; `get_media_file_info` spy ile "dosya açılmadı" kanıtı | A-1 |
| `whatsapp-gateway/src/media/media-store.js` | Dedupe RAM/disk/in-flight aramaları `session.id` kapsamına alındı; global aramalar korundu | A-2 |
| `whatsapp-gateway/tests/test-media-session-dedupe-547.mjs` **(yeni)** | 7 senaryo / 50 assertion A-2 matrisi | A-2 |
| `whatsapp-gateway/package.json` | Test zincirine yeni dedupe suite'i eklendi | A-2 |

**Dokunulmayan önceden-modified dosyalar (7):** `whatsapp.py`, `link_preview/service.py`,
`messaging.py`, `whatsapp_gateway.py`, `test_whatsapp_live.py`, `index.js`, `session-manager.js`.

---

## 4. Test Komutları, Exit Kodları ve Sonuç Sayıları

**Ortam:** Python 3.14 venv (`/Users/isatezcan/Documents/Github/Tezlify/venv/bin/python`), Node ESM;
backend testleri taze SQLite (`sqlite+aiosqlite`, `/tmp/tz547_*.db`) üzerinde. **SQLite, PostgreSQL
değildir.**

### Yeni testler

| Komut | Exit | Sonuç | Seviye |
|---|---|---|---|
| `pytest backend/tests/test_campaign_media_auth.py backend/tests/test_campaign_media.py -q` | 0 | **23 passed** (10 yeni + 13 mevcut) | L2/L3 (mock + SQLite) |
| `node --import ./tests/media-test-register-atomic.mjs tests/test-media-session-dedupe-547.mjs` | 0 | **50 assertions passed** | L2/L3 (stub + gerçek store, disk) |

### Regresyon

| Komut | Exit | Sonuç | Seviye |
|---|---|---|---|
| `node --import ./tests/media-test-register.mjs tests/test-media-store-integrity.mjs` | 0 | 65 assertions | L2/L3 |
| `node --import ./tests/media-test-register.mjs tests/test-media-store-543.mjs` | 0 | 59 assertions | L2/L3 |
| `node --import ./tests/media-test-register.mjs tests/test-media-routes-543.mjs` | 0 | 40 assertions | L2/L3 |
| `node --import ./tests/media-test-register-atomic.mjs tests/test-media-ingestion-atomicity-545.mjs` | 0 | 39 assertions | L2/L3 |
| `node --import ./tests/media-test-register.mjs tests/test-media-routes-545.mjs` | 0 | 61 assertions | L2/L3 |
| `node scripts/test-gateway-auth.mjs` | 0 | fail-closed REST/WS auth passed | L2/L3 |
| `pytest backend/tests/test_whatsapp_media_tenant_isolation.py -q` | 0 | 10 passed | L3 (SQLite) |
| `pytest backend/tests/test_whatsapp_live.py -q` | 0 | 61 passed | L3 (SQLite) |
| `pytest backend/tests/test_link_preview_media_tenant_isolation.py -q` | 0 | 11 passed | L3 (SQLite) |

### Statik / sözdizimi

| Komut | Exit | Sonuç | Seviye |
|---|---|---|---|
| `python -m py_compile` (4 dosya) | 0 | OK | L1 |
| `node --check media-store.js` | 0 | OK | L1 |
| `node --check test-media-session-dedupe-547.mjs` | 0 | OK | L1 |
| `node -e JSON.parse(package.json)` | 0 | OK | L1 |
| `git diff --check` | 0 | temiz | L1 |

### Kanıt seviyesi özeti

- **L1 (statik):** sözdizimi/JSON/diff temizliği — hepsi PASS.
- **L2 (birim):** gateway store/route/dedupe suite'leri — hepsi PASS.
- **L3 (izole entegrasyon / mock / SQLite):** backend endpoint ve tenant izolasyon testleri — hepsi PASS.
- **L4 (gerçek WhatsApp E2E):** **ÇALIŞTIRILMADI.** Gerçek WhatsApp hesabı, gerçek medya klasörü,
  PostgreSQL veya production kullanılmadı. Gerçek Express 4 E2E de çalıştırılmadı. L4 başarı iddiası yoktur.

---

## 5. Korunan Önceki Davranışlar

5.4.2–5.4.6 güvenlik davranışlarının tamamı regresyonla doğrulandı:

- Tenant izolasyonu (backend medya, link-preview ve WhatsApp canlı yolu) — PASS.
- Boş kullanıcı fail-closed — PASS.
- MIME doğrulaması FD açılmadan önce — PASS (test-media-store-integrity).
- Bozuk sidecar eski (legacy) sayılmaz — PASS.
- Hash uyuşmazlığı fail-closed — PASS.
- Aynı FD üzerinden doğrula/gönder (TOCTOU kapatma) — PASS (5.4.5 route suite).
- FD/stream temizliği, tek HTTP yanıtı, stale header temizliği — PASS (5.4.5 route suite).
- Yol geçişi (traversal) koruması — PASS.
- M-1 process-local ingestion kilidi — PASS (atomicity suite).
- M-2 Express 4 async hata yakalama — değiştirilmedi; ilgili route suite'leri PASS.

---

## 6. Kapsam Dışı ve A-3 Durumu

- **A-3 (crash orphan / legacy kabulü) çözülmedi.** 5.4.5 atomicity suite'i (39 assertion) ve
  integrity suite'i (65 assertion) A-3 davranışının **etkilenmediğini** doğruladı; dedupe değişikliği
  dosya yazma/rename/fsync akışına dokunmaz, yalnızca arama kapsamını değiştirir.
- Retention/fiziksel disk temizliği, multi-process/dağıtık kilit, WhatsApp geçmiş senkronizasyonu,
  reconnect/offline catch-up, LID/JID eşleme, frontend medya oynatıcıları, diğer kampanya mantığı ve
  genel auth mimarisi kapsam dışı bırakıldı; hiçbiri "çözüldü" olarak sunulmamıştır.

---

## 7. `git diff --check` ve Diff İncelemesi

- `git diff --check` → **exit 0**, whitespace hatası yok.
- Diff incelemesi: `campaigns.py` (auth + helper + 404), `campaign_media_service.py` (owner sidecar +
  401/500), `test_campaign_media.py` (legacy test uyumu), `media-store.js` (scope hunks),
  `package.json` (test zinciri) beklenen sınırlarda. Kapsam dışı değişiklik yok.
- `uploads/campaign_media` test sonrası **boş**; scratch (`/tmp/tz547_*`) silindi.

---

## 8. Başlangıç/Bitiş Git Karşılaştırması

| Kontrol | Sonuç |
|---|---|
| Branch/HEAD değişmedi | Evet |
| Önceden var olan 9 modified korundu | Evet (7 dokunulmadı, 2 genişletildi) |
| Önceden var olan 14 untracked korundu | Evet |
| Yeni modified | 3 (yalnız A-1 dosyaları) |
| Yeni untracked | 2 test dosyası (+ bu rapor, mevcut `reports/` altında) |
| Commit/push/deploy | **Yapılmadı** |

---

## 9. Kalan Riskler / Çözülmemiş Bulgular

| # | Risk | Şiddet | Etki | Kanıt | Gerekçe |
|---|---|---|---|---|---|
| R-1 | Owner sidecar'ı ve `Campaign.media_url` referansı olmayan eski medya (ör. yalnız kampanya sequence adımında kullanılan) artık 404 döner | LOW–MEDIUM | Eski medya için **kullanılabilirlik** kaybı; güvenlik açığı değil | `_authorize_campaign_media` legacy dalı `rows` boşsa `False` döner | DB migration yapılmadan güvenliği korumak için bilinçli fail-closed; backfill kapsam dışı |
| R-2 | Owner sidecar yazımı ile dosya yazımı arasında crash olursa yetim dosya oluşabilir; sidecar yoksa legacy mantığı uygulanır | LOW | Yeni yüklemede tenant sızması yok (yan dosyasız dosya yalnız tek-tenant referansıyla servis edilir, aksi halde reddedilir) | `save_uploaded_media` sırası: `write_bytes` → `_write_media_ownership`; hata dalında dosya silinir | A-3 kapsam dışı; crash-orphan kabulü bu fazda çözülmedi |
| R-3 | Dedupe kapsamı `session.id`'ye dayanır; `session.id` boşsa kapsam `''` olur ve teorik olarak oturumlar arası birleşme mümkündür | LOW | Normal akışta oturum nesnesinin id'si doludur; boş id beklenmez | `const scope = session?.id ? String(session.id) : ''` | Oturum kimliği güvenilir in-process kaynaktan gelir; boş id için ek fail-closed bu fazın kapsamı dışında |
| R-4 | Dedupe hâlâ process-local; iki gateway instance'ı aynı (session, ID) için ayrı indirme yapabilir | LOW (kapsam dışı) | Multi-instance ortamda fazladan indirme | `ingestLocks` ve `mediaByWaId` RAM içi | Dağıtık kilit altyapısı açıkça kapsam dışı |
| R-5 | L4 gerçek WhatsApp E2E ve gerçek Express 4 E2E çalıştırılmadı | Bilgi notu | Gerçek uçtan uca davranış bu fazda doğrulanmadı | Bölüm 4 | Gerçek hesap/production kullanımı yasak; L4 iddiası yok |

---

## 10. Sonuç

A-1 ve A-2 testleri geçti; 5.4.2–5.4.6 güvenlik davranışları regresyonsuz korundu; kapsam dışına
taşan değişiklik, commit, push veya deploy yoktur. Kalan riskler güvenlik açığı değil, belgelenmiş
kullanılabilirlik/kapsam notlarıdır.

**NİHAİ KARAR: PASS_WITH_NOTES**
