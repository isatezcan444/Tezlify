# AŞAMA 5.4.12 — Kampanya Medyası Release Blocker Düzeltmesi

**Tarih:** 2026-11-03
**Worktree:** `/private/tmp/tz429-release`
**Kapsam:** Yalnızca 5.4.10'da kanıtlanan F-1, F-2, F-3 ve F-4.
**Karar:** **PASS_WITH_NOTES** (Bölüm 11)

---

## 1. Başlangıç Git / Worktree Durumu

| Alan | Değer |
|---|---|
| `pwd` | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Modified | 14 dosya (5.4.2–5.4.9 birikimi) |
| Untracked | 17 giriş (önceki testler + raporlar + gateway testleri) |

Başlangıçta modified dosyalar:

- `backend/app/api/v1/endpoints/campaigns.py`
- `backend/app/api/v1/endpoints/whatsapp.py`
- `backend/app/services/campaign_media_service.py`
- `backend/app/services/campaign_runner.py`
- `backend/app/services/link_preview/service.py`
- `backend/app/services/outreach_manager.py`
- `backend/app/services/whatsapp/orchestration/messaging.py`
- `backend/app/services/whatsapp_gateway.py`
- `backend/tests/test_campaign_media.py`
- `backend/tests/test_whatsapp_live.py`
- `whatsapp-gateway/package.json`
- `whatsapp-gateway/src/index.js`
- `whatsapp-gateway/src/media/media-store.js`
- `whatsapp-gateway/src/session-manager.js`

Bu birikim korunarak yalnızca aşağıdaki dosyalar değiştirildi. `git reset`,
`git clean`, `git stash`, `git checkout`, `git switch`, `git rebase`,
`git merge`, `git add .`, `git add -A`, commit, push ve deploy
**kullanılmadı/çalıştırılmadı**.

---

## 2. Değişen Dosyalar ve Gerekçeleri

| Dosya | Tür | Gerekçe |
|---|---|---|
| `backend/app/services/campaign_media_service.py` | Değişti | F-1: tek kanonik parser + yerel-medya sezici. F-2/F-3: legacy sahipliği yalnızca tam kanonik DB referanslarından, fail-closed hesaplama. |
| `backend/app/api/v1/endpoints/campaigns.py` | Değişti | F-1/F-2/F-4: create/update yazma doğrulaması kanonik olmayan "yerel görünümlü" referansları reddeder; ana medya ve sekans aynı merkezî modeli kullanır. |
| `backend/tests/test_campaign_media_ownership_hardening_5412.py` | Yeni | 16 zorunlu senaryo + 2 L2 birim testi; bağımsız fixture, iki farklı sırada koşum. |
| `reports/whatsapp-phase-5.4.12-campaign-media-release-blocker-fix.md` | Yeni | Bu rapor. |

Başka hiçbir uygulama, gateway, frontend, WhatsApp çekirdek veya test dosyası
bu aşamada değiştirilmedi.

---

## 3. Düzeltme Modeli

### 3.1 Tek kanonik parser (F-1)

[`campaign_media_service.py:57`](file:///private/tmp/tz429-release/backend/app/services/campaign_media_service.py#L57)
tek kabul edilen biçimi tanımlar:

```python
CANONICAL_LOCAL_MEDIA_URL_PATTERN = re.compile(
    r"^/api/v1/campaigns/media/(camp_[a-f0-9]{16})$"
)
```

[`extract_local_file_id`](file:///private/tmp/tz429-release/backend/app/services/campaign_media_service.py#L76)
artık `search` değil **`fullmatch`** kullanır ve yalnızca `str` girdi kabul eder.
Sonuç:

- host'lu mutlak URL → `None`
- şemasız yol → `None`
- `..` / `%2e%2e` / `%2f` kodlama → `None`
- query / fragment → `None`
- baştaki/sondaki boşluk → `None`
- büyük harfli kimlik veya farklı path → `None`
- çıplak kimlik → `None`

[`looks_like_local_media_reference`](file:///private/tmp/tz429-release/backend/app/services/campaign_media_service.py#L90)
bu deposu **hedeflemeye çalışan** ama kanonik olmayan biçimleri (percent-decode
sonrası `/campaigns/media/` işareti veya `camp_<16 hex>` kimliği) yakalar.
Bilinmeyen şemalar (`javascript:`, `ftp:` vb.) bu depoyu hedefliyorsa yazmada
reddedilir; hedeflemiyorsa hiçbir sahiplik kanıtı üretmez ve dispatch'te etkisiz
kalır. Sıradan harici `http(s)` URL'ler (`https://example.com/katalog.pdf`)
serbest kalır; bunlar sahiplik kanıtı sayılmaz.

### 3.2 Yazma anında merkezî doğrulama (F-1 / F-2 / F-4)

[`_validate_campaign_media_references`](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/campaigns.py#L386)
create ve update'te aynı döngüyü kullanır:

1. Referans tam kanonik ise `authorize_media_reference` ile sahiplik aranır;
   yoksa **400**.
2. Referans kanonik değil ama yerel medyaya benziyorsa **400** (fail-closed).
3. Aksi hâlde sıradan harici URL kabul edilir; sahiplik üretmez.

Ana medya (`media_url`) ve sekans adımları (`sequence_steps[*].media_url`)
[`_collect_campaign_media_references`](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/campaigns.py#L373)
üzerinden aynı modele girer. `message_template` gibi serbest metin taranmaz.

### 3.3 Legacy sahiplik: yalnızca kanonik, yalnızca önceden var olan (F-2 / F-3)

[`_legacy_reference_owners`](file:///private/tmp/tz429-release/backend/app/services/campaign_media_service.py#L412):

- SQL `contains(file_id)` yalnızca **aday daraltma** için kullanılır.
- Sahiplik kararı Python'da
  [`_campaign_references_file_exactly`](file:///private/tmp/tz429-release/backend/app/services/campaign_media_service.py#L390)
  ile verilir: yalnızca `Campaign.media_url` ve
  `sequence_steps[*]["media_url"]` alanlarının **tam kanonik** eşleşmesi sayılır.
- `message_template`, JSON içinde rastgele eşleşme, URL'nin herhangi bir
  yerindeki kimlik **sayılmaz**.
- Kanonik referansı olan tenant kümesi tam olarak 1 değilse (0, >1 veya NULL
  sahipli satır) sonuç **fail-closed** reddedilir.
- Yazma doğrulaması DB'ye yazmadan ÖNCE çalıştığı için create isteği kendi
  satırını kanıt olarak göremez; update'te de `setattr` doğrulamadan sonradır.

### 3.4 Sidecar önceliği ve bayt okuma sınırı

[`authorize_media_reference`](file:///private/tmp/tz429-release/backend/app/services/campaign_media_service.py#L354)
sırası değişmedi:

1. Sidecar varsa **tek kanıt** odur; DB referansları ezemez.
2. Sidecar yoksa yukarıdaki kanonik legacy hesabı.
3. Bozuk/geçersiz sidecar legacy'ye düşmez; doğrudan reddedilir.

GET [`get_campaign_media`](file:///private/tmp/tz429-release/backend/app/api/v1/endpoints/campaigns.py#L443)
ve dispatch
[`get_authorized_campaign_media_base64`](file:///private/tmp/tz429-release/backend/app/services/campaign_media_service.py#L457)
yetkilendirmeyi **medya baytları okunmadan önce** yapar. Yetkisiz yolda
`get_media_file_info` hiç çağrılmaz.

---

## 4. F-1 / F-2 / F-3 / F-4 — Önce / Sonra

### F-1 — Serbest metin / substring / gömülü kimlik sahiplik üretiyordu

| Girdi biçimi | Önce (5.4.10 kanıtı) | Sonra (5.4.12) |
|---|---|---|
| `https://evil.example/<id>` | Create **201**, aynı tenant GET **200** (bayt sızdı) | Create **400**; eski satır DB'de kalsa bile sahiplik sayılmaz |
| `evil.example/<id>` (şemasız) | **201** / **200** | **400**; eski satır yok sayılır |
| `/api/v1/campaigns/media/../<id>` | **201** / **200** | **400**; eski satır yok sayılır |
| `https://evil.example/api/v1/campaigns/media/<id>` | Create 400 ama substring sahiplik sayılıyordu | **400**; eski satır yok sayılır |
| `/api/v1/campaigns/media/<id>?x=1` | Create 400, substring riski | **400**; eski satır yok sayılır |
| `  /api/v1/campaigns/media/<id>  ` | Create 400, substring riski | **400**; eski satır yok sayılır |
| Kanonik `/api/v1/campaigns/media/<id>` | Kabul | **Kabul** (biçim korundu) |

Kök neden: `LOCAL_MEDIA_URL_PATTERN.search` + `contains(file_id)` serbest alt
dize araması. Düzeltme: `fullmatch` + Python tam parse.

### F-2 — İstek referansı kendi kendini kanıtlıyordu

**Önce:** B `https://evil.example/<A'nın id>` ile kampanya oluşturur (201),
sonra `PATCH {"media_url": "/api/v1/campaigns/media/<id>"}` yapar; B'nin satırı
kimliği taşıdığı için `owners={B}` çıkar, PATCH 200 olur, B dosyayı GET eder.

**Sonra:**

1. Adım 1 create → **400** (yerel görünümlü, kanonik değil).
2. Adım 2 hiç oluşamaz. Yine de eski bir satır üzerinden denense bile
   `_legacy_reference_owners` eski satırdaki kanonik olmayan URL'yi yok sayar;
   A tek kanonik sahipse `owners={A}` → B **400**.
3. Kanıt yoksa (0 sahip) veya belirsizse (>1) **fail-closed**.

### F-3 — Silme/güncelleme sahipliği devredebiliyordu

**Önce (5.4.10):** A siler → geriye B'nin referansı kalır → B GET 200.

**Sonra:** 5.4.10'daki saldırı zinciri (B'nin harici URL ile referans eklemesi)
artık **400** ile durur. Testte B'nin eski (fix öncesi) harici referansı
doğrudan DB'ye tohumlanır:

- A silmeden önce: A GET **200**, B GET **404**.
- A kendi kampanyasını siler: B GET **404**; `authorize(B)` **false**.
- A'nın da referansı kalmadığı için dosya sahipsiz/fail-closed kalır; B'ye
  otomatik devir yoktur.

### F-4 — Yabancı referans gerçek sahibin erişimini bozuyordu

**Önce:** B'nin tek bir harici referansı, A'nın legacy dosyasını belirsiz hâle
getiriyor; A GET 404, dispatch `CampaignMediaAccessDenied`.

**Sonra:**

- B'nin yeni referans eklemesi **400** ile reddedilir.
- B'nin fix öncesi harici (kanonik olmayan) referansı sahiplik hesabına
  **girmez**; A tek kanonik sahip olarak GET/dispatch'e devam eder.
- Yetkisiz dispatch: gönderim yok, `MessageLog` yok, lead/campaign sayaçları
  değişmez. Kota/kontör tüketimi `start_conversation` içinde gerçekleşir ve bu
  yol hiç çağrılmaz.

---

## 5. 16 Zorunlu Test Senaryosu ve Sonuçları

Dosya:
`backend/tests/test_campaign_media_ownership_hardening_5412.py`
**26 passed** (16 senaryo + 8 parametre varyantı + 2 L2 birim testi).

| # | Test | Çalışan fonksiyon / sınır | Sonuç |
|---|---|---|---|
| 1 | `test_sidecar_owner_denies_other_tenant` | `read_media_ownership` + `authorize_media_reference` + GET pre-read guard | PASS |
| 2 | `test_external_url_cannot_prove_legacy_ownership` | `_legacy_reference_owners` / `_campaign_references_file_exactly`; bayt okunmadı | PASS |
| 3 | `test_schemeless_url_cannot_prove_legacy_ownership` | aynı legacy hesabı; şemasız URL yok sayılır | PASS |
| 4 | `test_embedded_id_substring_cannot_prove_legacy_ownership` | serbest metin/JSON substring sahiplik üretmez | PASS |
| 5 | `test_noncanonical_local_media_forms_are_rejected_on_create` (9 varyant) | `extract_local_file_id` + `looks_like_local_media_reference` + yazma doğrulaması | PASS |
| 6 | `test_create_rejects_foreign_sidecar_media` | create doğrulaması, sidecar sahipliği | PASS |
| 7 | `test_update_rejects_foreign_media_without_changing_row` | update doğrulaması; `setattr` sonrası değişiklik yok | PASS |
| 8 | `test_sequence_step_foreign_media_is_rejected` | sekans adımı aynı merkezî validator; kanonik + gizlenmiş biçim | PASS |
| 9 | `test_owner_delete_does_not_transfer_legacy_ownership` | DB'den sahip hesabı; silme sonrası 0 sahip → fail-closed | PASS |
| 10 | `test_owner_update_away_does_not_transfer_legacy_ownership` | update-away sonrası B'nin attach denemesi 400 | PASS |
| 11 | `test_sidecar_is_not_overridden_by_conflicting_db_reference` | sidecar önceliği | PASS |
| 12 | `test_unauthorized_get_does_not_read_bytes` | GET auth → `get_media_file_info` çağrılmadı | PASS |
| 13 | `test_unauthorized_dispatch_does_not_read_bytes` | dispatch auth → bayt okunmadı, send yok | PASS |
| 14 | `test_unauthorized_dispatch_has_no_send_log_or_counter_side_effects` | send/log/lead/campaign sayaçları değişmedi | PASS |
| 15 | `test_valid_sidecar_owner_get_and_dispatch_still_work` | geçerli sahip GET 200 + dispatch base64 | PASS |
| 16 | `test_unprovable_legacy_file_fails_closed_for_everyone` | orphan legacy: GET 404, create 400, resolver `CampaignMediaAccessDenied` | PASS |

L2 birim testleri:

- `test_canonical_parser_accepts_only_full_canonical_form`
- `test_local_media_detector_flags_disguised_forms`

**Order-dependency kontrolü (taze DB, iki farklı sıra):**

| Koşum | Komut özeti | Sonuç |
|---|---|---|
| A | Yeni dosya + 3 mevcut dosya, `--randomly-seed=5412` | **74 passed** |
| B | 3 mevcut dosya (ters sıra) + yeni dosya, `--randomly-seed=12945` | **74 passed** |

Her test kendi dosyasını/kampanyasını/lead'ini kurar ve `finally` içinde
temizler; hiçbir test önceki testin DB satırına veya sırasına bağlı değildir.

---

## 6. Test Seviyeleri

### L1 — Statik

| Komut | Sonuç |
|---|---|
| `python -m py_compile backend/app/services/campaign_media_service.py backend/app/api/v1/endpoints/campaigns.py` | OK |
| `python -m py_compile backend/tests/test_campaign_media_ownership_hardening_5412.py` | OK |
| `git diff --check` | Temiz |

### L2 — Birim

| Komut | Sonuç |
|---|---|
| Parser/sezici birim testleri (yukarıdaki 2 test) | 2 passed |

### L3 — İzole entegrasyon / mock / SQLite

| Komut | Sonuç |
|---|---|
| Yeni 5.4.12 suite'i | **26 passed** |
| `test_campaign_media.py` + `test_campaign_media_auth.py` + `test_campaign_media_dispatch_auth.py` | **48 passed** |
| İlgili kampanya/outreach regresyonları (delete, groups, message generation, runner, scheduling, sequence drip, status sync, email outreach, smart outreach API) | **33 passed**, 1 uyarı |
| Tam backend paketi (`backend/tests/`, taze SQLite) | **2204 passed, 4 skipped, 2 errors** |

**Tam paket hataları (başarı sayılmadı):**
`test_whatsapp_phase2_a_gateway_behavior.py` içindeki iki modül fixture'ı,
`whatsapp-gateway/src/session-manager.js` için `uuid` npm paketini bulamıyor
(`ERR_MODULE_NOT_FOUND: uuid`). Bu, gateway `node_modules` kurulumu olmayan
ortamın dependency eksikliğidir; 5.4.12 değişikliğiyle ilgili değildir ve
başarı olarak raporlanmamıştır. Backend testlerinin tamamı SQLite üzerinde
koşmuştur; **PostgreSQL kanıtı değildir**.

### L4 — Gerçek WhatsApp E2E

**ÇALIŞTIRILMADI.** Gerçek WhatsApp hesabı, gateway bağlantısı, production
veya PostgreSQL kullanılmadı. L4 başarı iddiası yoktur.

---

## 7. Legacy Kayıtlar İçin Karar

- **Sidecar varsa:** normal davranış; sidecar tek sahiplik kanıtı.
- **Sidecar yoksa:** yalnızca DB'de **tam kanonik** biçimde referans veren
  kampanyalar değerlendirilir.
  - Tam olarak **1 tenant** ve çağıran o tenant → erişim değerlendirilir
    ("kanıtlanabilir legacy").
  - **0**, **>1** veya **NULL sahipli** → fail-closed.
  - Kanonik olmayan referanslar (harici URL, substring, serbest metin) hiç
    sayılmaz.
- Yan dosyası olmayan ve gerçek yükleyeni mevcut veriden belirlenemeyen dosya
  otomatik olarak hiçbir tenant'a atanmaz.
- **Migration, backfill, veri temizliği, orphan cleanup, retention veya dosya/
  kampanya toplu değişikliği yapılmadı.** Kullanıcı verisi silinmedi.

---

## 8. Kapsam Dışına Dokunulmadığının Doğrulaması

- Bu aşamada değiştirilen uygulama dosyaları yalnızca
  `campaign_media_service.py` ve `campaigns.py`.
- Yeni dosyalar yalnızca bir test dosyası ve bu rapor.
- `whatsapp-gateway/`, `frontend/`, WhatsApp QR/bağlantı, Baileys session,
  kişi/sohbet senkronizasyonu, LID/JID, bireysel mesaj alım/gönderimi,
  WebSocket, link-preview ve WhatsApp medya altyapısı **değiştirilmedi**.
- Başlangıçtaki 14 modified + 17 untracked dosya korundu; `git status` yalnızca
  yeni test ve rapor girişi kadar büyüdü.
- Commit, push, deploy, dependency kurulumu ve gerçek WhatsApp bağlantısı
  yapılmadı.

---

## 9. Bitiş Git Durumu

Bitiş `git status --short` bu raporun yazılmasından sonra doğrulandı; başlangıç
durumuna göre tek fark yeni test dosyası ve bu rapordur:

- Yeni: `backend/tests/test_campaign_media_ownership_hardening_5412.py`
- Yeni: `reports/whatsapp-phase-5.4.12-campaign-media-release-blocker-fix.md`
- Diğer tüm modified/untracked girişler başlangıçtaki hâliyle korunmuştur.

---

## 10. Açık Kalan Gerçek Riskler

| ID | Risk | Durum |
|---|---|---|
| R-1 | Fix öncesi DB'de **zaten yazılmış** kanonik referanslar geçmişteki saldırıyı ayırt edemez. Tek kanonik referans "kanıtlanabilir legacy" sayıldığı için, yalnızca saldırganın kanonik satırı kalmışsa sahiplik yanlış yorumlanabilir. | Bilinçli kabul; geçmiş zaman damgası/sahiplik kaydı yok. Migration/backfill yasak. |
| R-2 | Fix öncesi iki tenant'a ait kanonik referans varsa belirsizlik fail-closed olur; gerçek sahip de erişemez. | Fail-closed tasarım gereği; otomatik onarım yok. |
| R-3 | Tüm DB kanıtı SQLite'tir; PostgreSQL davranışı bu aşamada koşulmadı. | Sorgular taşınabilir SQLAlchemy kullanır, ancak PG kanıtı yoktur. |
| R-4 | Gerçek WhatsApp E2E (L4) koşulmadı. | Bu aşamada yasak; başarı iddiası yok. |
| R-5 | Harici `http(s)` URL'ler kabul edilir ama sahiplik üretmez; `http(s)` dışı şemalar depolanabilir ve dispatch'te metne düşer. | Sahiplik güvenliği açısından fail-closed; işlevsel olarak inert. |
| R-6 | `looks_like_local_media_reference`, `camp_<16 hex>` içeren sıradan harici URL'leri de reddedebilir (yanlış pozitif). | Bilinçli muhafazakâr davranış. |
| R-7 | Tam pakette 2 gateway testi `uuid` npm paketi eksikliği nedeniyle error verdi. | Dependency-blocked; başarı sayılmadı, 5.4.12 ile ilgisiz. |

---

## 11. Karar

**PASS_WITH_NOTES**

Gerekçe:

- 5.4.10'da kanıtlanan F-1, F-2, F-3 ve F-4'ün **yeni create/update/dispatch/
  GET yolları** kapatıldı.
- Kanonik olmayan tüm referans biçimleri yazmada reddediliyor; DB'de kalmış
  kanonik olmayan eski satırlar sahiplik üretmiyor.
- Sidecar önceliği korunuyor; kanıtlanamayan legacy fail-closed.
- 16 zorunlu senaryo + 2 birim testi, iki farklı sırada 74/74 PASS.
- Bayt okuma ve yan etki yokluğu ayrı testlerle doğrulandı.

Notlar: R-1/R-2 (fix öncesi kanonik kontaminasyonun geçmişten ayırt edilememesi),
R-3 (PostgreSQL kanıtı yok) ve R-4 (L4 koşulmadı). Bunlar bu aşamanın izin
verilen araçlarıyla (migration/veri değişikliği yasak) kapatılamaz; release
kararı verilirken bilinmelidir.

Commit, push ve deploy yapılmadı. Bir sonraki aşamaya geçilmedi; onay bekleniyor.
