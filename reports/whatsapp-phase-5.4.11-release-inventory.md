# AŞAMA 5.4.11 — WHATSAPP RELEASE INVENTORY & DEPLOYMENT READINESS

**Tür:** Salt okunur release hazırlık denetimi  
**Kodlama:** YOK  
**Altyapı:** YOK  
**Çalışma alanı:** `/private/tmp/tz429-release`  
**Tarih:** 2026-11-03  
**Production / PostgreSQL / gerçek WhatsApp erişimi:** Kullanılmadı

> Bu aşamada uygulama kodu, test kodu, yapılandırma ve bağımlılıklar değiştirilmedi.
> Yalnızca bu rapor dosyası oluşturuldu. Commit, push ve deploy yapılmadı.

---

## 1. Başlangıç Git / Worktree Durumu

| Öğe | Değer |
|---|---|
| `pwd` | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| HEAD commit | `fix(whatsapp): use portable timeout return type` (2026-11-02 17:53:46 +0300) |
| Upstream | Yok (`no upstream`); `origin/release/backend-only-seq-safety` = `978ddf5` |
| `origin/main` ilişkisi | `git rev-list --left-right --count origin/main...HEAD` → `32 10`; HEAD, `origin/main`'in atası **değil** |
| Staged | 0 |
| Modified | 14 |
| Untracked (git girdisi) | 17 (açılımda 25 dosya: 7 rapor + 18 kod/test dosyası) |
| `git diff --check` | Temiz |
| Değişikliklerin birikim noktası | `978ddf5` üzerine **commit edilmemiş** 5.4.2–5.4.9 medya sertleştirme yığını |

`git status --short` (başlangıç ve bitiş aynı):

```
 M backend/app/api/v1/endpoints/campaigns.py
 M backend/app/api/v1/endpoints/whatsapp.py
 M backend/app/services/campaign_media_service.py
 M backend/app/services/campaign_runner.py
 M backend/app/services/link_preview/service.py
 M backend/app/services/outreach_manager.py
 M backend/app/services/whatsapp/orchestration/messaging.py
 M backend/app/services/whatsapp_gateway.py
 M backend/tests/test_campaign_media.py
 M backend/tests/test_whatsapp_live.py
 M whatsapp-gateway/package.json
 M whatsapp-gateway/src/index.js
 M whatsapp-gateway/src/media/media-store.js
 M whatsapp-gateway/src/session-manager.js
?? backend/tests/test_campaign_media_auth.py
?? backend/tests/test_campaign_media_dispatch_auth.py
?? backend/tests/test_link_preview_media_tenant_isolation.py
?? backend/tests/test_whatsapp_media_tenant_isolation.py
?? reports/
?? whatsapp-gateway/src/media/media-routes.js
?? whatsapp-gateway/tests/media-test-loader-atomic.mjs
?? whatsapp-gateway/tests/media-test-loader.mjs
?? whatsapp-gateway/tests/media-test-register-atomic.mjs
?? whatsapp-gateway/tests/media-test-register.mjs
?? whatsapp-gateway/tests/stubs/
?? whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs
?? whatsapp-gateway/tests/test-media-routes-543.mjs
?? whatsapp-gateway/tests/test-media-routes-545.mjs
?? whatsapp-gateway/tests/test-media-session-dedupe-547.mjs
?? whatsapp-gateway/tests/test-media-store-543.mjs
?? whatsapp-gateway/tests/test-media-store-integrity.mjs
```

Diff toplamı: **14 dosya, 1.335 ekleme / 162 silme**.

**Birikim geçmişi (raporlardan):** 5.4.2 (tenant medya), 5.4.3 (link-preview + TOCTOU), 5.4.5 (atomic ingestion + HTTP/FD), 5.4.7 (kampanya GET auth + session dedupe), 5.4.9 (kampanya dispatch/auth + write validation) ve 5.4.10 (salt okunur denetim). Hiçbiri commit edilmedi. 5.4.8, 5.4.10 ve bu rapor salt okunurdur.

---

## 2. Tam Değişiklik Envanteri ve Dosya Bazında Kategoriler

Kategoriler: **A** QR/session, **B** Baileys Gateway, **C** kişi/sohbet/LID-JID, **D** mesaj alım/gönderim/geçmiş senkronu, **E** medya/dosya aktarımı, **F** backend/PostgreSQL, **G** WebSocket/frontend, **H** kampanya medya gönderimi, **I** kapsam dışı.

### 2.1 Modified dosyalar (14)

| # | Dosya | Kategori | Amaç |
|---|---|---|---|
| 1 | `backend/app/api/v1/endpoints/campaigns.py` | **H** | Create/update yazma-zamanı medya doğrulaması; `GET /campaigns/media/{file_id}` için auth + sahiplik; referans toplama/doğrulama yardımcıları |
| 2 | `backend/app/api/v1/endpoints/whatsapp.py` | **E** | Gateway 422 bütünlük hatasını 422'ye eşleme; link-preview proxy'sine `current_user.id` geçirme |
| 3 | `backend/app/services/campaign_media_service.py` | **H** | `.owner.json` sidecar sahipliği; `authorize_media_reference`; `get_authorized_campaign_media_base64`; tenant'sız `get_campaign_media_base64` kaldırıldı; upload'da boş kullanıcı 401 |
| 4 | `backend/app/services/campaign_runner.py` | **H** | Sekans adımı medyasını yetkili çözücüyle okuma; reddedilirse `FAILED/MEDIA_UNAUTHORIZED` |
| 5 | `backend/app/services/link_preview/service.py` | **E** | `get_preview_image_bytes(db, digest, user_id)`; dahili WhatsApp medyası için `Message`+`Conversation` tenant doğrulaması |
| 6 | `backend/app/services/outreach_manager.py` | **H** | Ana kampanya medyasını yetkili çözücüyle okuma; reddedilirse gönderim yok |
| 7 | `backend/app/services/whatsapp/orchestration/messaging.py` | **E** | `get_media_bytes` tenant kontrolü; `fetch_media_unscoped` fallback'i kaldırıldı; sohbet sahipliği doğrulaması |
| 8 | `backend/app/services/whatsapp_gateway.py` | **E** | `fetch_media` / `fetch_media_unscoped` HTTP status ve yanıt gövdesini koruyarak hata fırlatıyor |
| 9 | `backend/tests/test_campaign_media.py` | **H** | Yetkili çözücüye uyarlama; create testi gerçek upload; legacy XSS testlerine sidecar |
| 10 | `backend/tests/test_whatsapp_live.py` | **E** | Status korunumu, 422→422, 5xx→502 testleri |
| 11 | `whatsapp-gateway/package.json` | **E** (B altyapı) | Altı medya testinin `--import` loader'larla test zincirine eklenmesi |
| 12 | `whatsapp-gateway/src/index.js` | **B/E** | Medya rotalarının ayrı modülden mount edilmesi; inline rotaların kaldırılması; `/health`'e `media_capacity` |
| 13 | `whatsapp-gateway/src/media/media-store.js` | **E** | SHA-256 sidecar, FD üzerinden doğrulama+gönderim, sınırlı RAM indeksi, lazy sidecar çözümü, dedupe, disk gözlemlenebilirliği |
| 14 | `whatsapp-gateway/src/session-manager.js` | **B/E** | `resolveMediaPath`, `verifyMediaIntegrity`, `openVerifiedMedia`, `mediaCapacitySummary`; çağrıların async çözücüye geçirilmesi |

### 2.2 Untracked dosyalar (25 dosya / 17 git girdisi)

| # | Dosya | Kategori | Amaç |
|---|---|---|---|
| 15 | `backend/tests/test_campaign_media_auth.py` | **H** | Kampanya medya GET auth/sahiplik testleri (10 test) |
| 16 | `backend/tests/test_campaign_media_dispatch_auth.py` | **H** | Dispatch/sequence/create/update sahiplik testleri (26 test) |
| 17 | `backend/tests/test_link_preview_media_tenant_isolation.py` | **E** | Link-preview tenant izolasyonu (9 test) |
| 18 | `backend/tests/test_whatsapp_media_tenant_isolation.py` | **E** | `get_media_bytes` tenant izolasyonu (8 test) |
| 19 | `whatsapp-gateway/src/media/media-routes.js` | **E** | Gerçek Express medya rotaları; FD sahipliği; HEAD/404/422/500 sözleşmesi |
| 20 | `whatsapp-gateway/tests/media-test-loader.mjs` | **E** | Baileys/uuid stub çözümleyici |
| 21 | `whatsapp-gateway/tests/media-test-loader-atomic.mjs` | **E** | Yapılandırılabilir indirme stub'ı |
| 22 | `whatsapp-gateway/tests/media-test-register.mjs` | **E** | Loader kaydı (3 satır) |
| 23 | `whatsapp-gateway/tests/media-test-register-atomic.mjs` | **E** | Atomic loader kaydı (3 satır) |
| 24 | `whatsapp-gateway/tests/stubs/baileys.mjs` | **E** | Bağımlılıksız test stub'ı |
| 25 | `whatsapp-gateway/tests/stubs/baileys-atomic.mjs` | **E** | İndirme sayacı olan stub |
| 26 | `whatsapp-gateway/tests/stubs/uuid.mjs` | **E** | `node:crypto.randomUUID` tabanlı stub |
| 27 | `whatsapp-gateway/tests/test-media-store-integrity.mjs` | **E** | Hash/bütünlük/legacy/eviction (337 satır) |
| 28 | `whatsapp-gateway/tests/test-media-store-543.mjs` | **E** | TOCTOU/legacy/corrupt/lazy çözüm (494 satır) |
| 29 | `whatsapp-gateway/tests/test-media-routes-543.mjs` | **E** | Rota seviyesi HTTP (395 satır) |
| 30 | `whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs` | **E** | Eşzamanlı ingestion kilidi (329 satır) |
| 31 | `whatsapp-gateway/tests/test-media-routes-545.mjs` | **E** | MIME/corrupt/FD/HTTP hata yolları (665 satır) |
| 32 | `whatsapp-gateway/tests/test-media-session-dedupe-547.mjs` | **E** | Oturum kapsamlı dedupe (254 satır) |
| 33–39 | `reports/whatsapp-phase-5.4.{4,5,6,7,8,9,10}-*.md` | **I** | Önceki aşama raporları (7 dosya; üretim kodu değil) |

### 2.3 Değişiklik olmayan kategoriler

| Kategori | Durum | Kanıt |
|---|---|---|
| **A — QR / session yönetimi** | Değişiklik yok | Auth state, QR, `whatsapp_sessions` şeması, session volume dokunulmadı |
| **C — Kişi/sohbet/LID-JID** | Değişiklik yok | `contacts`, `conversations`, LID haritaları, sync akışları değişmedi |
| **D — Mesaj alım/gönderim/geçmiş senkronu** | Değişiklik yok | `socket-events.js`, mesaj persist/sync yolları değişmedi; yalnız medya *okuma* yolu (E) değişti |
| **F — Backend/PostgreSQL** | Şema/migration yok | `backend/app/models/`, `backend/app/core/migrations.py`, `backend/alembic/versions/` temiz; tek baseline revision (`32def94876ce`) |
| **G — WebSocket/frontend** | Değişiklik yok | `frontend/` tamamen temiz; `/ws` ve `/ws/gateway` protokolü değişmedi |
| **I — Kapsam dışı** | Yalnız raporlar | `reports/` altındaki 7 belge |

**Önemli sonuç:** Bu yığın bir “release geneli” değişiklik değildir; **medya güvenliği/sertleştirmesi** kümesidir. QR, kişi/sohbet senkronu, mesaj gönderim çekirdeği ve frontend değişmemiştir.

---

## 3. WhatsApp Çekirdek Sistemine Ait Değişiklikler

Çekirdek küme 25 dosyadır ve iki deploy biriminden oluşur:

### 3.1 Gateway medya birimi (B/E)

| Dosya | Bağımlılık |
|---|---|
| `media-store.js` | `resolveMediaPath` (L610), `openVerifiedMedia` (L430), `verifyMediaIntegrity` (L369), `mediaCapacitySummary` (L985), session kapsamlı dedupe (L788) |
| `media-routes.js` | `sessionManager.resolveMediaPath/openVerifiedMedia`; rota imzaları `/sessions/:sessionId/media/:mediaId` ve `/media/:mediaId` (L159, L168) |
| `session-manager.js` | Yeni store metodlarını delege eder (L1989–L2003); indirme çağrıları async çözücüye geçti |
| `index.js` | Modülü mount eder (L759); inline rotaları kaldırır; `/health`'e `media_capacity` (L222) |
| `package.json` | Altı medya testini test zincirine ekler |

**Davranış değişiklikleri:**

1. Doğrulanan bayt ile gönderilen bayt **aynı açık FD** üzerinden gider (TOCTOU kapalı).
2. Sidecar'a SHA-256 yazılır; hash uyuşmazlığı/bozuk sidecar **422** döner, asla başarı sayılmaz.
3. Sidecar'sız eski dosyalar **legacy** kabul edilir (`X-Media-Integrity: legacy`), hash doğrulanmış gibi raporlanmaz.
4. RAM indeksi 5.000 girdiyle sınırlı; fiziksel dosya/sidecar **artık silinmiyor**; eski kayıtlar lazy sidecar taramasıyla çözülüyor.
5. Aynı `(session, wa_message_id)` için eşzamanlı ingestion tek indirme/yazmaya indirgeniyor; dedupe **oturum kapsamlı**.
6. `/health` yanıtına `media_capacity` (dosya/sidecar/bayt/boş alan) eklendi; silme kararı üretmez.

### 3.2 Backend çekirdek medya birimi (E)

| Dosya | Bağımlılık |
|---|---|
| `whatsapp.py` | `get_media_bytes` çağrısı; 422→422, diğer→502 (L1186–L1196); preview'e `current_user.id` (L1239) |
| `messaging.py` | `get_media_bytes` tenant filtresi + açık eşitlik + sohbet sahipliği (L1355–L1440); global fallback yok |
| `link_preview/service.py` | Dahili medya için `Message`/`Conversation` tenant doğrulaması (L320–L381) |
| `whatsapp_gateway.py` | Status/gövde korunumu (L617–L695) |

**Kritik uyum:** `whatsapp.py` 422 ayrımını ancak yeni gateway 422 döndürdüğünde ve `fetch_media` status'u koruduğunda yapabilir. Bu nedenle **gateway + backend birlikte** deploy edilmelidir (bkz. §6).

**Kapsam dışı bırakılan artık:** `fetch_media_unscoped` kodu hâlâ mevcut (L656) ancak uygulama kodunda çağıranı yok; yalnız “asla çağrılmamalı” testi referans veriyor. Kaldırılması bu aşamanın konusu değildir.

---

## 4. Kampanya Medya Değişiklikleri (H)

Çekirdek kümeden **dosya ve import düzeyinde ayrı** 7 dosya:

| Dosya | Değişiklik |
|---|---|
| `campaigns.py` | Create/update doğrulaması (L386), `_authorize_campaign_media` (L418), GET'te auth (L432) |
| `campaign_media_service.py` | `authorize_media_reference` (L315), `get_authorized_campaign_media_base64` (L362), `.owner.json` sidecar |
| `outreach_manager.py` | Ana medya için yetkili çözücü (L167); reddedilirse gönderim yok |
| `campaign_runner.py` | Sekans medyası için yetkili çözücü (L317); `FAILED/MEDIA_UNAUTHORIZED` |
| `test_campaign_media.py` | Yetkili çözücüye uyarlama |
| `test_campaign_media_auth.py` | GET auth/sahiplik (10 test) |
| `test_campaign_media_dispatch_auth.py` | Dispatch/create/update/sequence (26 test) |

**Kampanya kümesinin şu anki güvenlik durumu:** 5.4.10 bağımsız denetimi **FAIL** verdi. Yeni `.owner.json` sidecar'lı yüklemeler güvenli; **sidecar'sız legacy dosyalar** F-1..F-4 nedeniyle güvenli değil.

**Production'daki mevcut durum (kayıtlı baseline):** Son doğrulanmış deploy `0b795ea` (2026-11-02 kaydı; bu aşamada production'a erişilmedi). `0b795ea..HEAD` farkında kampanya medya dosyaları değişmediği için production'da:
- `GET /api/v1/campaigns/media/{file_id}` **kimlik doğrulaması olmadan** çalışıyor,
- dispatch çözücüsü tenant bağlamı taşımıyor.

Yani kampanya kümesini **deploy etmemek** yeni bir açık yaratmaz; mevcut açığı olduğu gibi bırakır. Bu, “hold” kararının gerekçesini ve aciliyetini birlikte tanımlar.

---

## 5. 5.4.10 FAIL Bulgularının Release Etkisi

### 5.1 Bulgu özeti

| Bulgu | Öz | Dosya |
|---|---|---|
| **F-1** | Yazma doğrulaması yalnız kanonik `/campaigns/media/<id>` ve yalnız `sequence_steps[*].media_url` tarar; okuma auth'u tüm `media_url` ve tüm `sequence_steps` JSON metninde **alt dize** arar. Harici/göreli/traversal URL ve `message_template` metni sahiplik referansı sayılır. | `campaign_media_service.py:340–352`, `campaigns.py:373–383, 405–408` |
| **F-2** | Referans kendi kendini kanıtlar; iki adımlı create+PATCH ile yabancı legacy dosya kanonik yerel referansa dönüştürülür. | `campaign_media_service.py:315–359`, `campaigns.py:152–160` |
| **F-3** | Legacy sahiplik yalnız “mevcut referans durumu”; oluşturulma zamanı/İlk yükleyen yok; kampanya silinince sahiplik devredilir. | `campaign_media_service.py:315–359`, `campaigns.py:167–183` |
| **F-4** | Saldırgan, kimliği taşıyan tek referans ekleyerek gerçek sahibin GET'ini 404'e ve dispatch'ini `CampaignMediaAccessDenied`'a düşürebilir (cross-tenant DoS). | `campaign_media_service.py:356–359`, `outreach_manager.py:167–177`, `campaign_runner.py:317–333` |

### 5.2 Etki ayrımı (risk gizlenmeden)

| Alan | F-1 | F-2 | F-3 | F-4 |
|---|---|---|---|---|
| **Normal QR bağlantısı** | Etki yok | Etki yok | Etki yok | Etki yok |
| **Kişi ve sohbet senkronizasyonu** | Etki yok | Etki yok | Etki yok | Etki yok |
| **Bireysel mesaj alım/gönderim** | Etki yok | Etki yok | Etki yok | Etki yok |
| **Bireysel mesaj medyası** (`/api/v1/whatsapp/media/*`) | Etki yok | Etki yok | Etki yok | Etki yok |
| **Kampanya medya GET** | **HIGH** — yabancı dosya okunabilir | **HIGH** — dönüşümle okunabilir | **HIGH** — silme sonrası devralınır | **MEDIUM/HIGH** — sahibin erişimi kesilir |
| **Kampanya medya gönderimi** | **HIGH** — tek referansla yabancı dosya gönderilebilir | **HIGH** — aynı | **HIGH** — aynı | **MEDIUM/HIGH** — sahibin aktif gönderimi durur |

**Koşul:** Saldırganın 64-bit `camp_<16 hex>` kimliğini bilmesi gerekir (tahmin edilemez; ancak sızıntı/önceki erişim varsa etkili). Yeni `.owner.json` sidecar'lı yüklemeler bu dört bulgudan **etkilenmez**.

**Neden çekirdeğe taşınmıyor:** F-1..F-4 yalnız `Campaign.media_url` / `sequence_steps` referans modeline bağlıdır. Bireysel mesaj medyası `Message.media_id` + `Conversation.user_id` üzerinden yetkilendirilir (`messaging.py:1375–1395`); bu yollar bu bulgulardan bağımsızdır. Buna rağmen kampanya medyası **production'a alınmamalıdır**.

---

## 6. Release Güvenlik Kontrolü

| Alan | Durum | Kanıt / etki |
|---|---|---|
| **Production konfigürasyonu** | Değişiklik yok | Yeni zorunlu env yok. `WHATSAPP_GATEWAY_SECRET` mevcut. `MEDIA_INDEX_MAX` iç sabit (5000), env'e bağlı değil. `docker-compose.prod.yml` volume/env tanımları değişmedi. |
| **Database migration** | Yok | `backend/alembic/versions/` tek baseline; model ve startup migration dosyaları temiz. Deploy'da schema adımı yok. |
| **Gateway API sözleşmesi** | **Değişti (geriye uyumlu genişleme + daralma)** | Yollar aynı. Yeni: 422 (`MEDIA_CORRUPTED` / `MEDIA_INVALID_METADATA`), `X-Media-Integrity`, `/health.media_capacity`. Kaybolan: express `sendFile`'ın otomatik **Range/ETag/Last-Modified** desteği; yeni akış yalnız HEAD + tam gövde. Backend proxy Range'i kendi uygular (`whatsapp.py:1209–1211`); frontend gateway'e doğrudan gitmiyor. |
| **Backend API sözleşmesi** | Genişledi | `/api/v1/whatsapp/media/{id}` artık gateway 422'sini 422 olarak döner; 5xx → 502. Frontend sözleşmesi değişmedi. |
| **Session saklama** | Değişiklik yok | `whatsapp_sessions` volume, şifreli auth state, QR akışı dokunulmadı. |
| **WebSocket protokolü** | Değişiklik yok | `/ws`, `/ws/gateway`, event şemaları değişmedi. |
| **Dosya/medya yolları** | Aynı kökler | Gateway `/app/media` (`whatsapp_media` volume); backend `/opt/tezlify/uploads:/app/uploads`. Yeni: campaign `.owner.json`; gateway sidecar'a `sha256`. Legacy sidecar'lar `sha256` taşımadığı için legacy kabul edilir. |
| **Kalıcılık/retention** | Davranış değişti | RAM eviction artık fiziksel dosya silmiyor; `/app/media` sınırsız büyür. `media_capacity` yalnız gözlem; otomatik silme yok. |

### 6.1 Birlikte deploy edilmesi zorunlu dosyalar

| Birlikte deploy birimi | Gerekçe |
|---|---|
| `media-store.js` + `media-routes.js` + `session-manager.js` + `index.js` | `index.js` modülü import eder; route'lar session-manager metodlarını çağırır; session-manager store metodlarını delege eder. Tek başına hiçbiri çalışmaz. |
| `whatsapp.py` + `whatsapp_gateway.py` + `messaging.py` + `link_preview/service.py` | 422 ayrımı status korunumuna; preview ve mesaj medyası `get_preview_image_bytes`/`get_media_bytes` imzalarına bağlı. |
| **Gateway medya birimi + backend medya birimi** | Bütünlük semantiği için: yeni gateway + eski backend → 422, 502 olarak raporlanır; eski gateway + yeni backend → bozuk bayt 200 olarak sunulur. Güvenlik iddiası ancak ikisi birlikte doğrudur. |
| `campaigns.py` + `campaign_media_service.py` + `outreach_manager.py` + `campaign_runner.py` | Aynı yetkilendirme modelinin yazma/okuma/gönderim yüzeyleri; parçalı deploy modeli tutarsız bırakır. |

### 6.2 Bağımsız deploy edilemeyecek olanlar

1. **Backend-only deploy (`--no-gateway`) bu release için imkânsızdır.** `host-release.sh` koruması, yayındaki commit ile hedef arasında `whatsapp-gateway/` veya compose değişmişse komutu reddeder (`host-release.sh:551–569`). `0b795ea..978ddf5` aralığında gateway ağacı zaten değişmiştir (session-manager, socket-events, testler). Dolayısıyla **gateway yeniden oluşturma zorunludur**.
2. **`release.sh` bu branch'i deploy edemez.** Kirli ağaç reddedilir (`release.sh:104`) ve SHA'nın `origin/main` atası olması istenir (`release.sh:107`); bu branch'in atası değildir.
3. **Kampanya kümesini “dosya geri alarak” ayırmak güvenli değildir.** `campaign_media_service.py` aynı dosyada hem sidecar auth'u hem legacy fallback'i barındırır; geri almak 5.4.7 öncesi **kimlik doğrulamasız** kampanya medya GET'ini geri getirir. Kısmi geri alma önerilmez.

---

## 7. Safe Separability Kanıtı (Çekirdek vs Kampanya)

| Kanıt | Sonuç |
|---|---|
| Değişen dosya kümeleri kesişiyor mu? | **Hayır.** 9 çekirdek modified + 16 çekirdek untracked; 5 kampanya modified + 2 kampanya untracked. Ortak dosya yok. |
| Çekirdek, kampanya sembollerini import ediyor mu? | **Hayır.** `whatsapp.py`/`messaging.py`/`link_preview` yalnız `Message`, `Conversation`, gateway client kullanır. |
| Kampanya, çekirdek değişikliklerine bağımlı mı? | **Hayır.** `CampaignMediaService` yerel disk okur; gateway medya rotasını kullanmaz. |
| Ortak şema/migration? | **Yok.** Hiçbir model/migration dosyası değişmedi. |
| Ortak config/env? | **Yok.** Yeni env yok. |
| Davranışsal kesişim? | Gateway medya rotaları **gelen WhatsApp medyası** içindir; kampanya medyası `/app/uploads` üzerinden sunulur. Kesişim yok. |

**Sonuç:** İki küme **yapısal olarak** ayrılabilir. Ancak bu, “şimdi iki ayrı commit/deploy yapılmalı” anlamına gelmez:
- Ayrık deploy, aynı gateway yeniden oluşturma/QR riskini iki kez tetikler.
- Kampanya kodunun FAIL durumu commit edilmeden çekirdek deploy etmek kirli ağaç nedeniyle mümkün değildir; commit edilirse FAIL kod branch ucunda durur ve bir sonraki deploy'da yanlışlıkla sevk edilebilir.
- Bu nedenle **önerilen sıra:** önce 5.4.12 kampanya düzeltmesi + 5.4.13 bağımsız denetim, sonra **tek seferde** çekirdek + düzeltilmiş kampanya deploy'u. Çekirdeği erken sevk etmek ancak operatörün açık kararıyla, iki commit ve tek gateway restart planıyla düşünülebilir.

---

## 8. Üç Deploy Kararı

### Karar 1 — WhatsApp çekirdek sistemi

**CONDITIONALLY_DEPLOYABLE (henüz deploy edilmemeli).**

- Teknik içerik: gateway medya sertleştirmesi + backend çekirdek medya tenant izolasyonu (25 dosya).
- Önkoşullar: commit + temiz ağaç; gateway zorunlu yeniden oluşturma; QR/yeniden eşleştirme hazırlığı; backend+gateway birlikte; migration yok.
- Gerekçe: 5.4.6 birleşik kabul **PASS_WITH_NOTES**; bu aşamada 314 gateway assertion + 88 backend testi taze olarak geçti. Core küme kampanya F-1..F-4'ten bağımsızdır.
- Neden “şimdi” değil: release süreci bu branch'i doğrudan desteklemiyor; gateway restart oturum sürekliliği riski taşıyor; kampanya düzeltmesiyle tek seferde sevk etmek daha güvenli.

### Karar 2 — Kampanya medya gönderimi

**HOLD (deploy edilmemeli).**

- 5.4.10 bağımsız denetim kararı **FAIL** (F-1/F-2/F-3 HIGH, F-4 MEDIUM/HIGH).
- Legacy dosyalar için sahiplik kanıtlanamıyor; saldırgan okuma, gönderme, devralma ve DoS yapabiliyor.
- Kısmi deploy (yalnız A-1) güvenli değil: F-2 aynı modeli deliyor; dosya içi geri alma kimlik doğrulamasız GET'i geri getirir.
- Yeni sidecar'lı yüklemeler güvenli olsa da mevcut production dosyaları sidecar'sız olduğundan model bütün olarak kabul edilemez.

### Karar 3 — Production öncesi zorunlu çözümler

1. **F-1..F-4 düzeltmesi** + bu sınıfları kapsayan testler (harici/şemasız/traversal URL içinde kimlik, `sequence_steps[*].message_template`, iki adımlı PATCH, silme sonrası devir, çok-tenant DoS).
2. **Legacy geçiş politikası:** mevcut sidecar'sız kampanya dosyaları için backfill veya “sahipsiz kabul et / erişimi kapat” kararı; operatör veri işlemi gerektirir.
3. **Release süreci:** bu branch `release.sh` ile deploy edilemez; sunucu tarafı `run_release.sh` yolu veya merge/ancestry kararı; kirli ağaçtan deploy yasak.
4. **Gateway yeniden oluşturma + QR planı:** `WHATSAPP_AUTO_RESTORE=true` olsa da oturum sürekliliği kanıtlanmış değil; operatör yeniden eşleştirmeye hazır olmalı.
5. **Co-deploy sözleşmesi:** yeni backend + yeni gateway birlikte; aksi halde 422/502 veya doğrulanmamış bayt riski.
6. **Disk/retention:** `/app/media` artık sınırsız büyür; `media_capacity` izlenmeli; `/app/uploads` yedek kapsamı ayrıca doğrulanmalı.
7. **Test kapısı:** tam backend suite'te bilinen siparişe bağlı FK hatası ve iki ortam hatası triyaj edilmeli (F-6).
8. **Production baseline doğrulaması:** bu aşamada production'a erişilmedi; cutover öncesi yayındaki SHA yeniden doğrulanmalı.

---

## 9. Production Riskleri

| # | Risk | Etki | Azaltım |
|---|---|---|---|
| R-1 | Gateway yeniden oluşturma Baileys RAM cache'ini uçurur | Geçmiş penceresi boşalabilir; oturum yeniden bağlanmazsa QR gerekir | Operatör QR hazırlığı; `AUTO_RESTORE` logları; cutover sonrası oturum doğrulama |
| R-2 | Gateway artık Range/ETag/Last-Modified üretmiyor | Doğrudan gateway tüketicisi 206 kaybeder | Uygulamada tek tüketici backend; backend Range'i kendi uygular. Frontend doğrudan gateway'e gitmiyor |
| R-3 | Bozuk/yanlış `sizeBytes` taşıyan legacy sidecar | Tek dosya 422 alır (medya görünmez) | Legacy kabul + yalnız boyut uyuşmazlığında ret; log/`X-Media-Integrity` ile ayırt |
| R-4 | Fiziksel medya artık otomatik silinmiyor | `/app/media` sınırsız büyür; disk dolabilir | `media_capacity` izleme; retention/backup operatör kararı |
| R-5 | 5.000 üstü dosyada lazy tam sidecar taraması | İstek gecikmesi artabilir | Batch=64, async; 5.000+ senaryosu test edildi; izleme |
| R-6 | Eski gateway + yeni backend | Bozuk bayt 200 olarak sunulur (bütünlük iddiası geçersiz) | **Birlikte deploy zorunlu** |
| R-7 | Yeni gateway + eski backend | 422, 502 olarak raporlanır | **Birlikte deploy zorunlu** |
| R-8 | Kampanya F-1..F-4 | Yabancı medya okuma/gönderme, devir, DoS | Kampanya kümesini **deploy etme**; 5.4.12 düzeltmesi |
| R-9 | Production'da mevcut kimlik doğrulamasız kampanya GET | Bilinen açık devam eder | Ayrı acil hotfix değerlendirmesi; bu aşamada kapsam dışı |
| R-10 | `release.sh` branch/ancestry uyumsuzluğu | Deploy komutu reddeder veya yanlış artefakt üretir | Sunucu tarafı `run_release.sh`; temiz ağaç; exact-SHA artefakt |

---

## 10. Test Kanıtları

### 10.1 Bu aşamada taze çalıştırılanlar (2026-11-03)

| Küme | Komut / ortam | Sonuç |
|---|---|---|
| Gateway medya store bütünlük | `node --import ./tests/media-test-register.mjs tests/test-media-store-integrity.mjs` (Node v24.15.0, bağımlılık yok, stub) | **65 assertion PASS** |
| Gateway store 5.4.3 | `... test-media-store-543.mjs` | **59 assertion PASS** |
| Gateway route 5.4.3 | `... test-media-routes-543.mjs` | **40 assertion PASS** |
| Gateway ingestion atomicity | `--import ./tests/media-test-register-atomic.mjs tests/test-media-ingestion-atomicity-545.mjs` | **39 assertion PASS** |
| Gateway route 5.4.5 | `... test-media-routes-545.mjs` | **61 assertion PASS** |
| Gateway session dedupe 5.4.7 | `... test-media-session-dedupe-547.mjs` | **50 assertion PASS** |
| **Gateway toplam** | 6 dosya | **314 assertion PASS** |
| Backend medya (kampanya + core) | Taze SQLite (34 tablo), `pytest -p no:randomly`; 5 dosya | **69 passed** |
| Backend WhatsApp live + orchestration | Aynı DB; `test_whatsapp_live.py`, `test_whatsapp_orchestration_messaging.py` | **88 passed** |

Testler `/tmp` altında oluşturulan geçici dizinde koşuldu; repo çalışma ağacına yazılmadı; geçici DB/dizin silindi. Çalıştırma sonrası `git status --short` başlangıçla **birebir aynı**, `git diff --check` temiz.

### 10.2 Önceki aşama kanıtı (yeniden üretilmedi)

- 5.4.10 tam backend suite: **2179 passed, 1 failed, 4 skipped, 2 errors**.
  - 1 failure: `test_campaign_runner_pauses_on_daily_limit_reached` — taze DB'de `MessageLog(lead_id=1)` FK ihlali; `pytest-randomly` sırasına bağlı, medya koduyla ilgisiz **önceden var olan test izolasyonu kusuru**.
  - 2 error: gateway `uuid` bağımlılığı eksikliği (ortam).
  - 4 skip: canlı QR dikişi.
- PostgreSQL çoklu süreç concurrency testleri (5.4.10): 10 test PASS; ancak kamera medya koduna değil, mesaj yarışına aittir.
- **PostgreSQL (L4) bu aşamada çalıştırılmadı.** SQLite sonuçları PostgreSQL transaction/concurrency/constraint/JSON davranışını kanıtlamaz.
- Gerçek WhatsApp/gateway E2E çalıştırılmadı.
- `frontend` derlemesi çalıştırılmadı: frontend değişikliği yok.

### 10.3 Test kanıtının sınırı

- Gateway testleri gerçek Baileys/Express yerine stub ve minimal host kullanır; canlı WhatsApp davranışını kanıtlamaz.
- Tam suite'in bilinen siparişe bağlı hatası, “tüm testler yeşil” iddiasını **geçersiz kılar**; release kapısı için triyaj gerekir.
- F-1..F-4 sınıfları mevcut testlerde **kapsanmıyor** (5.4.10 F-5).

---

## 11. Güvenli Release Önerisi

1. **Bu dirty worktree'den deploy yapma.** Önce commit; ağaç temiz olsun.
2. **Kampanya kümesini production'a alma.** 5.4.12'de F-1..F-4'ü düzelt, F-5 test boşluklarını kapat; 5.4.13'te bağımsız denetimle **PASS** al.
3. **Çekirdek kümeyi tek gateway restart ile sevk et.** Backend + gateway birlikte; QR operatörü hazır; cutover öncesi taze DB dump ve oturum planı.
4. **Mümkünse tek deploy:** düzeltilmiş kampanya + çekirdek aynı release'te. Ayrık deploy ancak operatörün açık kararı ve iki commit'lik ayrım kanıtıyla düşünülmeli; bu aşamada önerilmez.
5. **Deploy sonrası doğrulama:** `/health` (backend + gateway + `media_capacity`), WhatsApp oturum durumu, bir QR/oturum yeniden bağlanma senaryosu, medya GET (yeni + legacy), 422/404 davranışı, kampanya medya GET'in **kapalı kaldığı** (deploy edilmediği) doğrulaması.

---

## 12. Deploy Öncesi Eksikler

| # | Eksik | Durum |
|---|---|---|
| E-1 | Kampanya F-1..F-4 düzeltmesi | **AÇIK — zorunlu** |
| E-2 | F-1..F-4 regresyon testleri | **AÇIK — zorunlu** |
| E-3 | Legacy kampanya medya geçiş/backfill kararı | **AÇIK — operatör kararı** |
| E-4 | Commit + temiz ağaç + deploy edilebilir SHA | **AÇIK** |
| E-5 | `release.sh` branch/ancestry uyumsuzluğu | **AÇIK — süreç kararı** |
| E-6 | Gateway restart + QR/session süreklilik planı | **AÇIK** |
| E-7 | Tam suite siparişe bağlı failure/ortam hatalarının triyajı | **AÇIK** |
| E-8 | Production baseline SHA'nın cutover öncesi doğrulanması | **AÇIK** |
| E-9 | Medya disk kapasitesi/retention ve `/app/uploads` yedek kapsamı | **AÇIK — operasyon** |
| E-10 | PostgreSQL/L4 kanıtı | **ÇALIŞTIRILMADI** |
| E-11 | Gerçek WhatsApp E2E | **ÇALIŞTIRILMADI** |

---

## 13. Nihai Karar

**NİHAİ KARAR: RELEASE BLOCKED (tam yığın için).**

- **Çekirdek WhatsApp medya kümesi:** teknik olarak tutarlı, testleri geçen, migration/config gerektirmeyen **koşullu deploy adayı**; ancak bu aşamada deploy edilmemeli. Gateway zorunlu yeniden oluşturma ve QR riski nedeniyle operatör onayı ve planı gerekir.
- **Kampanya medya kümesi:** 5.4.10 **FAIL**; production'a alınmamalı. Legacy sahiplik modeli güvenli değil.
- **Uyumsuzluklar:** F-1..F-4, release süreci (dirty/ancestry), gateway-backend co-deploy, QR sürekliliği ve test kapısı çözülmeden production deploy'u yapılmamalı.
- **Önerilen sonraki aşama:** **5.4.12 — Kampanya medya legacy sahiplik ve referans semantiği düzeltmesi** (F-1..F-4 + testler), ardından **5.4.13 — bağımsız kabul denetimi**. Denetim PASS olduktan sonra tek seferde çekirdek + kampanya deploy'u değerlendirilir.

**Gerekçe özeti:** Çekirdek medya değişiklikleri QR/senkron/bireysel mesaj çekirdeğine dokunmuyor ve testleri geçiyor; ancak kampanya medya modeli aynı yığında FAIL durumda ve bu haliyle sevk edilemez. Worktree commit edilmemiş olduğundan hiçbir parça “deploy edilmiş” sayılamaz.

---

## 14. Kapanış Doğrulaması

| Kontrol | Sonuç |
|---|---|
| `pwd` | `/private/tmp/tz429-release` |
| Branch / HEAD | `release/backend-only-seq-safety` / `978ddf5` (değişmedi) |
| `git status --short` başlangıç = bitiş | **Evet** (14 modified, 17 untracked girdi) |
| `git diff --check` | **Temiz** |
| Bu aşamada oluşturulan dosya | Yalnızca bu rapor |
| Kod/test/config değişikliği | **Yok** |
| Commit / push / deploy | **Yapılmadı** |
| Production / PostgreSQL / gerçek WhatsApp | **Erişilmedi** |

**DUR.** Bu aşama tamamlandı. Bir sonraki işlem için onay bekleniyor.
