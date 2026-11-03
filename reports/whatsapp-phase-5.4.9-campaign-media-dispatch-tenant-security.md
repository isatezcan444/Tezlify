# AŞAMA 5.4.9 — Kampanya Medyası Uçtan Uca Tenant Güvenliği ve Dispatch Yetkilendirmesi

**Tarih:** 2026-11-03
**Çalışma alanı:** `/private/tmp/tz429-release`
**Tür:** KODLAMA: EVET · ALTYAPI: HAYIR · Öncelik: MEDIUM
**Kaynaklar:** 5.4.6, 5.4.7 ve 5.4.8 raporları (AUD-1, AUD-2, AUD-3)

## 1. Özet ve Karar

5.4.7 owner sidecar modeli yalnızca HTTP GET yüzeyini koruyordu. Bu aşamada model
uçtan uca uygulandı:

- **AUD-1 (dispatch):** Medya baytları okunmadan önce tenant sahipliği
  doğrulanıyor. `OutreachManager` ve `CampaignRunner` sekans döngüsü, yetki
  kanıtlanamazsa gönderimi durduruyor; dosya hiç açılmıyor.
- **AUD-2 (referans oluşturma):** `POST`/`PATCH /campaigns`, ana medya ve her
  sekans adımı referansını yazma anında doğruluyor. Başka tenant'ın dosya
  kimliğini kendi kampanyasına yazmak sahiplik **üretmiyor**.
- **AUD-3 (sekans):** `sequence_steps[].media_url` aynı modele bağlandı; legacy
  tarama sekans referanslarını da kapsıyor; ana medya ve adım medyası ayrı ayrı
  doğrulanıyor.

**Nihai karar: PASS_WITH_NOTES.** A-1/A-2/A-3 için test kanıtı vardır. Notlar:
PostgreSQL ve gerçek WhatsApp (L4) koşulmadı; 5.4.9 öncesinde oluşmuş zehirli
legacy referanslar güvenilir biçimde ayırt edilemez (göç yapılmadı, tahmin
edilmedi); crash-safe yükleme/orphan/backup/multi-process konuları kapsam dışı.

**5.4.7 owner sidecar modeli artık bütün kampanya medya referanslarını güvenli ve
geriye dönük uyumlu biçimde kapsıyor mu?**

- GET, dispatch ve yeni referans oluşturma: **Evet**, tek merkezî modelle.
- Yan dosyalı yüklemeler: **Evet** (sidecar tek kanıt, DB referansını ezer).
- Yan dosyasız legacy dosya + **tek** pre-existing tenant referansı (ana veya
  sekans): **Evet** (sahiplik korunur).
- Yan dosyasız legacy dosya + **hiç** referans (orphan): **Hayır** — fail-closed
  reddedilir; sahiplik kanıtı olmadığı için otomatik atama yapılmaz.
- 5.4.9 öncesi oluşmuş **çok tenantlı / yabancı** legacy referans: belirsizdir;
  çok tenant → fail-closed, tek yabancı referans ise mevcut kanıt olarak kabul
  edilir. Bu, yan dosyasız eski kayıtların doğasında olan bir sınırdır; göç
  önerilmez ve yapılmadı.

## 2. Ortam ve Başlangıç Durumu

| Öğe | Değer |
|---|---|
| `pwd` | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD (başlangıç ve bitiş) | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Başlangıç: staged / modified / untracked | `0 / 12 / 16` |
| Bitiş: staged / modified / untracked | `0 / 14 / 17` |

Değişiklik farkı beklenen kapsamdadır: 12 modified ve 16 untracked girdi
korundu; buna ek olarak `campaign_runner.py` ve `outreach_manager.py` (başlangıçta
temiz) 5.4.9 kapsamında değiştirildi ve yeni test dosyası eklendi. Hiçbir
kullanıcı değişikliği silinmedi/üzerine yazılmadı. `git reset`, `clean`,
`stash`, `checkout`, `rebase`, `merge`, `add .`, `add -A` kullanılmadı.
Commit/push/deploy yapılmadı. Dependency kurulmadı.

SQLite test veritabanları `scripts/provision_test_db.py` ile üretildi:

```
TEST_DB_PATH=/tmp/tz549_media.db PYTHONPATH=. python scripts/provision_test_db.py
→ provisioned /tmp/tz549_media.db: 34 tables (exit 0)

TEST_DB_PATH=/tmp/tz549_reg.db  PYTHONPATH=. python scripts/provision_test_db.py   (exit 0)
TEST_DB_PATH=/tmp/tz549_full.db PYTHONPATH=. python scripts/provision_test_db.py   (exit 0)
```

Python: proje venv'i (`/Users/isatezcan/Documents/Github/Tezlify/venv/bin/python`,
Python 3.14).

## 3. Kanıt Seviyeleri (L1–L4)

| Seviye | Kapsam | Durum |
|---|---|---|
| L1 — statik | `py_compile`, `git diff --check`, stale-caller grep | **KOŞULDU, PASS** |
| L2 — birim | Yeni 5.4.9 testleri + mevcut media testleri (48 test) | **KOŞULDU, PASS** |
| L3 — izole entegrasyon (SQLite) | Kampanya/tenant regresyon matrisi (186 test) + tam backend suite (2180 passed, 4 skipped, 2 env hatası) | **KOŞULDU** (SQLite); PostgreSQL **koşulmadı** |
| L4 — gerçek WhatsApp E2E | Gerçek hesap/gateway ile uçtan uca gönderim | **KOŞULMADI** |

## 4. AUD-1 — Dispatch Bayt Okumadan Önce Yetkilendirme

### Bulgu
`CampaignMediaService.get_campaign_media_base64(media_url)` yalnızca URL'den
`file_id` çıkarıp `get_media_file_info` ile diski okuyordu; tenant bağlamı yoktu.
Dosya kimliğini bilen/öğrenen herhangi bir kampanya sahibi, başka tenant'ın
medyasını kendi kampanyasına yazarak gönderebiliyordu.

### Uygulanan düzeltme
- Halka açık, bağlamsız `get_campaign_media_base64` **kaldırıldı** (ileride
  bypass oluşmasını önlemek için).
- [`campaign_media_service.py:362`](../../backend/app/services/campaign_media_service.py#L362)
  `get_authorized_campaign_media_base64(db, media_url, user_id)` eklendi:
  - yerel olmayan URL → `None` (harici URL davranışı çağıranda korunur);
  - yetki kanıtlanamaz → `CampaignMediaAccessDenied` — `get_media_file_info`
    **çağrılmaz**, bayt okunmaz;
  - yetkili ama dosya yok/bozuk → `None` (mevcut metne geri dönüş korunur);
  - yetkili → base64.
- Çağıranlar:
  - [`outreach_manager.py:167`](../../backend/app/services/outreach_manager.py#L167):
    tenant bağlamı `campaign.user_id`; `CampaignMediaAccessDenied` yakalanınca
    `(False, "Medya sahipliği doğrulanamadı; gönderim durduruldu.", None)` döner.
    `start_conversation` çağrılmaz, `MessageLog` yazılmaz, `sent_count` artmaz.
  - [`campaign_runner.py:317`](../../backend/app/services/campaign_runner.py#L317):
    tenant bağlamı `campaign.user_id`; reddedilirse `CampaignSequenceLead`
    `FAILED`, `stop_reason="MEDIA_UNAUTHORIZED"`, `next_step_at=None` yapılır ve
    adım gönderilmez.
- Bağlam eksik/boşsa fail-closed: `user_id=None` veya boş → reddedilir.
  `OutreachManager` ayrıca medya bloğundan önce `campaign.user_id` yoksa erken
  döner.

### Kanıt
- `test_dispatch_owner_media_is_authorized_and_sent` — sahip gönderir, base64
  baytları eşleşir.
- `test_dispatch_denies_foreign_media_before_reading_bytes` — yabancı kampanya
  reddedilir; `get_media_file_info` **hiç çağrılmaz**; send yok; `MessageLog`
  yok; `failed_count` artmaz.
- `test_dispatch_without_campaign_owner_fails_closed`
- `test_dispatch_authorized_but_missing_file_falls_back_to_text`
- `test_dispatch_external_media_url_is_unchanged`
- `test_authorized_resolver_requires_tenant_context` (`None`, `""`, `"   "`)

## 5. AUD-2 — Referans Oluşturma Sahiplik Üretmez

### Bulgu
`POST /campaigns` ve `PATCH /campaigns/{id}` gelen `media_url` değerini
doğrulamadan kaydediyordu. Legacy (yan dosyasız) dosyalarda sahiplik yalnızca
kampanya referanslarından çıkarıldığı için, yabancı tenant yeni bir referans
yazarak dosyayı "sahiplenebiliyor" veya en azından belirsizliğe sokabiliyordu.

### Uygulanan düzeltme
- Tek merkezî kural:
  [`campaign_media_service.py:315`](../../backend/app/services/campaign_media_service.py#L315)
  `authorize_media_reference(db, file_id, user_id)`.
  Öncelik:
  1. Geçerli sidecar → **tek kanıt**; DB referansları sahipliği değiştiremez.
  2. Sidecar yok (legacy) → `Campaign.media_url` **veya** `sequence_steps`
     (metin olarak) içinde dosyayı referanslayan kampanyalar taranır. Tenant
     kimlikleri normalize edilir; **tam olarak tek** tenant ve çağıran o tenant
     ise izin verilir. `NULL` sahipli veya çok tenantlı sonuç → red.
  3. Bozuk/geçersiz sidecar → legacy'ye **düşmez**, doğrudan red.
- GET uç noktası aynı kurala delege edildi:
  [`campaigns.py:418`](../../backend/app/api/v1/endpoints/campaigns.py#L418),
  [`campaigns.py:459`](../../backend/app/api/v1/endpoints/campaigns.py#L459).
- Yazma anı doğrulaması:
  [`campaigns.py:386`](../../backend/app/api/v1/endpoints/campaigns.py#L386)
  `_validate_campaign_media_references` ana medya + her sekans adımını ayrı
  denetler; başarısızlıkta **HTTP 400** ve jenerik mesaj ("Medya referansı
  doğrulanamadı veya bu hesaba ait değil.") döner. Yol, tenant veya dosya
  varlığı sızdırılmaz. Çağrılar:
  [`campaigns.py:110`](../../backend/app/api/v1/endpoints/campaigns.py#L110)
  (create) ve
  [`campaigns.py:153`](../../backend/app/api/v1/endpoints/campaigns.py#L153)
  (update, yalnız gönderilen alanlar — `exclude_unset`).
- Harici `http(s)` URL'ler bu depoya ait olmadığı için doğrulanmaz; mevcut
  davranış korunur.

### Eski/yeni kayıt ayrımı hakkında açık beyan
5.4.9 öncesinde veritabanına yazılmış referansların "meşru legacy" mi yoksa
"önceki bir istismar" mı olduğu **güvenilir biçimde ayırt edilemez**. Bu nedenle:

- Otomatik göç veya toplu yeniden atama **yapılmadı**.
- Yan dosyası olan dosyalar bu belirsizlikten etkilenmez (sidecar ezer).
- Yan dosyasız dosyada tek pre-existing tenant referansı kanıt sayılır; çok
  tenant → fail-closed.
- Yeni referanslar API üzerinden bu belirsizliği **büyütemez**: sahiplik
  üretmeyen yeni referans reddedilir.

### Kanıt
- Kabul: `test_create_with_own_upload_is_accepted`,
  `test_update_attaching_own_media_is_accepted`,
  `test_legacy_reference_is_accepted_only_for_existing_single_tenant` (A kabul,
  B red).
- Red: `test_create_with_foreign_upload_is_rejected`,
  `test_create_with_unknown_file_id_is_rejected`,
  `test_create_with_orphan_legacy_file_is_rejected`,
  `test_ambiguous_legacy_references_are_rejected`,
  `test_corrupt_sidecar_blocks_reference_creation`,
  `test_update_attaching_foreign_media_is_rejected_and_unchanged`.
- Öncelik/fail-closed: `test_owner_sidecar_overrides_conflicting_db_reference`,
  `test_corrupt_sidecar_does_not_fall_back_to_legacy`.

## 6. AUD-3 — Sekans Medyası

### Bulgu
`Campaign.sequence_steps[].media_url` dispatch'te aynı bağlamsız çözümleyiciyi
kullanıyordu; legacy sahiplik taraması sekans referanslarını görmüyordu; ana
medya ile adım medyası arasında ayrı doğrulama yoktu.

### Uygulanan düzeltme
- Legacy tarama artık hem `Campaign.media_url` hem
  `cast(Campaign.sequence_steps, Text)` üzerinde dosya kimliğini arar
  (`authorize_media_reference`).
- Sekans dispatch'i (`campaign_runner.py:317`) her adım için `campaign.user_id`
  ile yetkilendirir; reddedilirse adım gönderilmez ve sekans `MEDIA_UNAUTHORIZED`
  ile durur.
- Create/update doğrulaması her `sequence_steps[*].media_url` değerini ana
  medyadan **bağımsız** denetler; bir adımın yabancı olması tüm isteği 400 yapar.
- Veri formatı (`sequence_steps` dict şeması) ve frontend sözleşmesi
  **değiştirilmedi**; yalnız backend doğrulaması eklendi.

### Kanıt
- `test_create_sequence_with_own_media_is_accepted`
- `test_create_sequence_with_foreign_media_is_rejected`
- `test_sequence_with_one_foreign_step_is_rejected`
- `test_main_and_sequence_media_are_validated_separately` (ana geçerli/adım
  yabancı ve ana yabancı/adım geçerli — ikisi de 400)
- `test_sequence_dispatch_authorized_step_media_is_sent` (3 adımlı akışta adım 2
  medyası gönderilir, `current_step=2`, `ACTIVE`, `next_step_at` dolu)
- `test_sequence_dispatch_denies_foreign_step_media_before_reading_bytes`
  (FAILED/MEDIA_UNAUTHORIZED, dosya açılmadı, send yok, `MessageLog` yok)
- `test_legacy_sequence_reference_authorizes_only_owner`

## 7. Test Matrisi ve Komutlar

### L1 — Statik
```bash
python -m py_compile \
  backend/app/services/campaign_media_service.py \
  backend/app/api/v1/endpoints/campaigns.py \
  backend/app/services/outreach_manager.py \
  backend/app/services/campaign_runner.py \
  backend/tests/test_campaign_media.py \
  backend/tests/test_campaign_media_dispatch_auth.py
# exit 0

git diff --check
# exit 0

grep -rn "get_campaign_media_base64" backend --include="*.py"
# eşleşme yok (bağlamsız çözümleyici kaldırıldı)
```

### L2 — Birim / medya zinciri (izole SQLite)
```bash
PYTHONPATH=. DATABASE_URL="sqlite+aiosqlite:////tmp/tz549_media.db" \
TEST_DB_PATH=/tmp/tz549_media.db \
python -m pytest \
  backend/tests/test_campaign_media_dispatch_auth.py \
  backend/tests/test_campaign_media.py \
  backend/tests/test_campaign_media_auth.py -q
# 48 passed, exit 0
```
Dağılım: yeni dosya **25**, `test_campaign_media.py` **13**,
`test_campaign_media_auth.py` **10**.

### L3 — İzole entegrasyon (SQLite)
Kampanya/tenant regresyon matrisi:
```bash
PYTHONPATH=. DATABASE_URL="sqlite+aiosqlite:////tmp/tz549_reg.db" \
TEST_DB_PATH=/tmp/tz549_reg.db python -m pytest \
  backend/tests/test_campaign_media_dispatch_auth.py \
  backend/tests/test_campaign_media.py \
  backend/tests/test_campaign_media_auth.py \
  backend/tests/test_campaign_runner.py \
  backend/tests/test_campaign_sequence_drip.py \
  backend/tests/test_campaign_delete.py \
  backend/tests/test_campaign_scheduling.py \
  backend/tests/test_campaign_status_sync.py \
  backend/tests/test_campaign_groups.py \
  backend/tests/test_multi_session_pool.py \
  backend/tests/test_auth_multitenancy.py \
  backend/tests/test_link_preview.py \
  backend/tests/test_link_preview_media_tenant_isolation.py \
  backend/tests/test_phase_10_9_optimizations.py -q
# 186 passed, exit 0
```

Tam backend suite:
```bash
PYTHONPATH=. DATABASE_URL="sqlite+aiosqlite:////tmp/tz549_full.db" \
TEST_DB_PATH=/tmp/tz549_full.db python -m pytest backend/tests/ -q -p no:cacheprovider
# 2180 passed, 4 skipped, 470 warnings, 2 errors in 142.81s → exit 1
```
2 hata: `test_whatsapp_phase2_a_gateway_behavior.py` setup aşamasında Node
harness'ı çalıştırıyor ve
`ERR_MODULE_NOT_FOUND: Cannot find package 'uuid'` alıyor
(`whatsapp-gateway/node_modules` yok; dependency kurmak bu aşamada yasak).
Bu hatalar kampanya medyası kod yollarından önce, gateway ortamından
kaynaklanmaktadır; 5.4.9 regresyonu değildir. Kalan tüm testler geçti.
4 skipped mevcut ortam koşullu testlerdir (`-q` modunda neden listelenmedi).

### L4 — Gerçek WhatsApp E2E
**KOŞULMADI.** Gerçek hesap/production/gateway kullanımı bu aşamada yasak.
Bu nedenle 5.4.9 için gerçek gönderim iddiası yoktur.

## 8. Kapsam Dışı ve Kalan Riskler

1. **Crash-safe upload/sidecar atomikliği:** Dosya yazımı ile sidecar yazımı
   arasında çökme olursa yan dosyasız dosya oluşabilir; orphan temizliği ve
   atomic sidecar bu aşamada kapsam dışıdır (5.4.6/5.4.8'de de açıktı).
2. **Fiziksel silme / retention / backup:** Kampanya silinince dosya diskte
   kalır; backup `/app/uploads`'ı kapsamaz. Kapsam dışı, değişmedi.
3. **Multi-process / lock:** Çoklu backend süreci için dosya sistemi kilidi yok.
4. **5.4.9 öncesi zehirli legacy referanslar:** Ayırt edilemez; göç yapılmadı.
   Yan dosyasız dosyada tek pre-existing yabancı referans "kanıt" sayılır (mevcut
   legacy modelinin doğal sınırı). Yan dosyalı dosyalar etkilenmez.
5. **Referanssız orphan legacy dosyalar:** Sahiplik kanıtı olmadığı için hem GET
   hem dispatch hem yazma doğrulamasında reddedilir; elle/göçle atama gerekir.
6. **Legacy metin taraması:** `sequence_steps` JSON metninde dosya kimliği
   başka bir alanda geçerse yanlış-pozitif referans oluşabilir; sonuç ekstra
   tenant → **deny** (fail-closed, gizlilik değil erişilebilirlik etkisi).
   Yeni referanslar API üzerinden bu durumu üretemez.
7. **Kampanya seviyesi ön kontrol yok:** Aynı medya sorunu her lead için ayrı
   `message_failed` üretir; gönderim yapılmaz ama kampanya önceden durdurulmaz.
   `campaign.failed_count` pre-send kapılarıyla tutarlı olarak artmaz.
8. **Harici URL:** `http(s)` medya URL'leri bu depoda doğrulanmaz/indirilmez;
   5.4.8'deki SSRF INFO bulgusu kapsam dışı olarak durur.
9. **PostgreSQL:** SQLite üzerinde koşuldu. `cast(..., Text) + LIKE` taşınabilir
   olacak şekilde yazıldı ancak PostgreSQL'de **doğrulanmadı**.
10. **L4:** Koşulmadı.

## 9. Değişen Dosyalar ve Nihai Durum

Üretim kodu:
- `backend/app/services/campaign_media_service.py` — merkezî yetkilendirme,
  `CampaignMediaAccessDenied`, tenant-normalize yardımcıları, bağlamsız
  çözümleyicinin kaldırılması.
- `backend/app/api/v1/endpoints/campaigns.py` — create/update yazma doğrulaması,
  GET'in merkezî kurala delegasyonu.
- `backend/app/services/outreach_manager.py` — dispatch öncesi yetkilendirme ve
  fail-closed durdurma.
- `backend/app/services/campaign_runner.py` — sekans adımı yetkilendirmesi,
  `MEDIA_UNAUTHORIZED` durdurma.

Testler:
- `backend/tests/test_campaign_media.py` — yeni çözümleyiciye uyarlama + gerçek
  yüklemeli create senaryosu.
- `backend/tests/test_campaign_media_dispatch_auth.py` — **yeni**, 25 test.

Git durumu:
- Branch: `release/backend-only-seq-safety`
- HEAD: `978ddf56877cd7aad7d2f30b095b6232e34802d2` (değişmedi)
- staged: `0`
- modified: `14` (12 baseline + `campaign_runner.py`, `outreach_manager.py`)
- untracked: `17` (16 baseline + yeni test dosyası)
- Commit / push / deploy: **YAPILMADI**

**Karar: PASS_WITH_NOTES.**
