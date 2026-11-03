# AŞAMA 5.4.10 — Kampanya Medyası Tenant Güvenliği Bağımsız Kabul Denetimi

**Çalışma türü:** Salt okunur bağımsız güvenlik denetimi (kod düzeltmesi YOK)
**Öncelik:** HIGH — Güvenlik kabul kapısı
**Denetlenen aşama:** 5.4.9 — Campaign Media Dispatch Tenant Security
**Denetim tarihi:** 2026-11-03
**Karar:** **FAIL**

---

## 1. Başlangıç Git / Worktree Durumu

| Öğe | Değer |
|---|---|
| `pwd` | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD (başlangıç ve bitiş) | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Başlangıç: staged / modified / untracked | `0 / 14 / 17` |
| Bitiş: staged / modified / untracked | `0 / 14 / 17` (+ yalnızca bu rapor) |
| `git diff --check` | exit `0` (boşluk hatası yok) |
| Commit / push / deploy | **YAPILMADI** |

Başlangıç durumu 5.4.9 bitiş durumuyla birebir aynıdır: 12 baseline modified +
`campaign_runner.py` / `outreach_manager.py`; 16 baseline untracked + 5.4.9 test
dosyası. Denetim sırasında uygulama koduna, test koduna, yapılandırmaya veya
bağımlılıklara dokunulmadı. Probe'lar yalnızca `/tmp/tz410_*.db` geçici SQLite
dosyalarında ve `uploads/campaign_media` altında benzersiz `camp_...` kimlikli,
sonradan silinen geçici dosyalarla çalıştırıldı.

> Not: `git ls-files --others --exclude-standard` dizin içindeki dosyaları tek tek
> saydığı için 24 verir; `git status --short` ile ölçülen **untracked girdi sayısı
> 17'dir** ve başlangıçla aynıdır.

---

## 2. İncelenen Dosyalar ve Fonksiyonlar

### 2.1 Yetkilendirme çekirdeği

`backend/app/services/campaign_media_service.py`
- `OWNER_META_SUFFIX`, `FILE_ID_PATTERN`, `LOCAL_MEDIA_URL_PATTERN` (satır 45–50)
- `CampaignMediaAccessDenied` (55)
- `extract_local_file_id` (63–68)
- `_normalize_tenant_id` / `_same_tenant` (71–82)
- `read_media_ownership` (180–202): yan dosya yok → `legacy`; bozuk/geçersiz → `corrupt`
- `save_uploaded_media` (214–283): blank kullanıcı → 401; yan dosya yazılamazsa dosya silinir → 500
- `get_media_file_info` (286–312): regex, glob, containment, bayt yeniden koklama; **tek disk okuma noktası** (307)
- `authorize_media_reference` (315–359): sidecar varsa tek kanıt; yoksa DB referans türetimi
- `get_authorized_campaign_media_base64` (362–383): yetki → bayt okuma sırası; bağlamsız eski okuyucu kaldırılmış

### 2.2 HTTP yüzeyi

`backend/app/api/v1/endpoints/campaigns.py`
- `create_campaign` (104–126), yazma doğrulaması (110–112)
- `update_campaign` (141–164), yazma doğrulaması (152–158), `setattr` (159–160)
- `delete_campaign` (167–183)
- `_collect_campaign_media_references` (373–383)
- `_validate_campaign_media_references` (386–415)
- `_authorize_campaign_media` (418–428)
- `get_campaign_media` GET `/media/{file_id}` (431–474): yetki (459) → bayt okuma (462)

### 2.3 Dispatch yolları

- `backend/app/services/outreach_manager.py:153–190` — ana kampanya medyası; `campaign.user_id`; yetkisizse `start_conversation` (193) ve `MessageLog` (204) **önce** döner.
- `backend/app/services/campaign_runner.py:306–333` — sekans adım medyası; `campaign.user_id`; yetkisizse `FAILED` / `MEDIA_UNAUTHORIZED` / `next_step_at=None`.
- `backend/app/services/campaign_runner.py:683–803` — ana worker; başarısızlıkta `message_failed`, bir sonraki lead'e ilerler; `consume_whatsapp_quota` yalnızca `success` dalında (693–699).
- `backend/app/models/campaign.py:49–55, 69–70` — `media_url`, `sequence_steps`; yalnız kampanya düzeyinde `created_at/updated_at`; referans başına sahiplik/zaman yok.
- `backend/app/schemas/campaign.py:31–35, 41–62` — `media_url` ve `sequence_steps` için alan doğrulayıcı yok.
- `backend/app/core/database.py:42–47` — SQLite `PRAGMA foreign_keys=ON`.
- `backend/app/core/auth.py:68–110` — dev/test bağlamında `X-Test-User-Id`.

### 2.4 Kapsam dışı ama kontrol edilen

- `read_bytes()` yalnızca `campaign_media_service.py:307`'de. Başka kampanya medyası disk okuyucusu yok.
- `get_campaign_media_base64` (bağlamsız eski okuyucu) kod tabanında **yok**; grep ile doğrulandı.
- `/api/v1/whatsapp/media/...` ayrı WhatsApp konuşma medyası alt sistemi (5.4.2 kapsamı); kampanya medyası değil.
- `process_single_outreach` üretimde tek çağıran: `campaign_runner.py:683`. Testler de nesneyi geçiyor.

---

## 3. Bulgular ve Önem Dereceleri

### F-1 — HIGH (KANITLANDI): Yazma doğrulaması ile okuma yetkilendirmesi farklı referans semantiği kullanıyor

**Kök neden:**
- Yazma doğrulaması yalnızca `/campaigns/media/<camp_id>` biçimine uyan dizeleri çıkarır
  (`extract_local_file_id`, `campaign_media_service.py:63–68`;
  `_validate_campaign_media_references`, `campaigns.py:405–408`) ve yalnızca
  `sequence_steps[*].media_url` alanını tarar (`_collect_campaign_media_references`,
  `campaigns.py:373–383`).
- Okuma yetkilendirmesi ise **serbest alt dize** arar:
  `Campaign.media_url.contains(file_id)` **veya** `cast(Campaign.sequence_steps, Text).contains(file_id)`
  (`campaign_media_service.py:340–352`).

Sonuç: dosya kimliğini taşıyan ama yerel desene uymayan her `media_url`
(bare harici URL, şemasız göreli yol, `media/../camp_id`, adım `message_template`
metni) yazma doğrulamasından **geçer**; ardından yetkilendirme sorgusunda
**sahiplik referansı** sayılır. "Yeni referans sahiplik üretmez" iddiası bu
şekillerde çürür.

**Ampirik kanıt (izole SQLite, geçici DB):**

| Girdi şekli | Create | Aynı tenant GET |
|---|---|---|
| `https://evil.example/<id>` | **201** | **200** (bayt sızdı) |
| `evil.example/<id>` (şemasız) | **201** | **200** |
| `/api/v1/campaigns/media/../<id>` | **201** | **200** |
| `https://evil.example/api/v1/campaigns/media/<id>` | 400 (yakalandı) | — |
| `/api/v1/campaigns/media/<id>?x=1` | 400 (yakalandı) | — |
| `  /api/v1/campaigns/media/<id>  ` | 400 (yakalandı) | — |

**Dosya:** `campaign_media_service.py:340–352`; `campaigns.py:373–383, 405–408`.

---

### F-2 — HIGH (KANITLANDI): Referans kendi kendini kanıtlıyor; PATCH ile yabancı legacy dosya "meşru" yerel referansa dönüştürülebiliyor

`authorize_media_reference` legacy dosyada çağıranın **kendi kampanya satırını**
kanıt olarak kabul ediyor. İki adımlı saldırı:

1. B, `media_url = "https://evil.example/<A'nın legacy id>"` ile kampanya oluşturur
   → doğrulama atlanır, **201**.
2. B, aynı kampanyayı `PATCH {"media_url": "/api/v1/campaigns/media/<id>"}` ile
   günceller. Doğrulama sırasında B'nin satırı hâlâ kimliği taşıdığı için
   `owners={B}` çıkar → **200**; satır artık kanonik yerel referans taşır.
3. B, dosyayı GET eder → **200**.

Yani doğrudan yerel referans (tek adım) reddedilirken, **iki adımlı yazma**
kabul ediliyor. Bu, A-2'nin ("yeni referans sahiplik üretemez") doğrudan
çürütülmesidir.

**Dosya:** `authorize_media_reference` `campaign_media_service.py:315–359`;
`update_campaign` doğrulama-sonra-`setattr` sırası `campaigns.py:152–160`.

---

### F-3 — HIGH (KANITLANDI): Legacy sahiplik yalnızca "mevcut referans durumu"; silme/güncelleme yorumu değiştiriyor

AUDIT-1'in beş adımlı senaryosu birebir çalıştırıldı (taze orphan legacy dosya,
yan dosya yok):

| Adım | İşlem | Sonuç |
|---|---|---|
| 0 | A'nın tarihsel kampanyası dosyayı yerel URL ile referanslıyor | A GET **200**; B `authorize` **false** |
| 1 | B aynı kimliği kendi kampanyasına harici URL ile ekliyor | create **201** |
| 2 | A ve B aynı anda referans veriyor | A GET **404**, B GET **404** (belirsizlik fail-closed) |
| 3 | A kendi kampanyasını siliyor | DELETE **204** |
| 4 | Geriye yalnızca B'nin referansı kalıyor | B GET **200**; B `authorize` **true**; A GET **404** |

**Yanıtlar:**
- Tek DB referansı **gerçek sahipliği kanıtlamıyor**; yalnızca o anki referans
  durumunu gösteriyor.
- Referansın oluşturulma zamanı veya geçmiş sahipliği **tutulmuyor**
  (`campaign.py:69–70` yalnız kampanya düzeyinde zaman damgası).
- Sidecar olmayan dosyada ilk yükleyen tenant **tespit edilemiyor**.
- Kampanya silme/güncelleme legacy sahiplik yorumunu **değiştirebiliyor**
  (ampirik olarak gösterildi).
- Dolayısıyla tek tenant referansı **güvenilir sahiplik kanıtı değil**.

**Dosya:** `campaign_media_service.py:315–359`; `campaigns.py:167–183`.

---

### F-4 — MEDIUM/HIGH (KANITLANDI): Cross-tenant availability DoS — gerçek sahibin gönderimi durdurulabiliyor

Gerçek legacy sahibi A için:
- Saldırı öncesi: GET **200**, dispatch çözümleyici **resolved**.
- B, kimliği taşıyan harici URL'li tek bir kampanya oluşturduktan sonra:
  A GET **404**, A'nın `get_authorized_campaign_media_base64` çağrısı
  **`CampaignMediaAccessDenied`** → `OutreachManager` gönderimi durdurur
  (`outreach_manager.py:170–177`), sekans adımı `FAILED` olur
  (`campaign_runner.py:320–333`).

Sistem yanlış başarı raporlamıyor (truthfulness korunuyor), ancak saldırgan
kimliği bilerek bir tenant'ın **aktif kampanya gönderimini durdurabiliyor** ve
medya erişimini kapatabiliyor. Bu, tek başına referans eklemenin bedelsiz
olmaması gerektiği ilkesini ihlal ediyor.

**Dosya:** `campaign_media_service.py:356–359`; `outreach_manager.py:167–177`;
`campaign_runner.py:317–333`.

---

### F-5 — MEDIUM (TEST KANITI BOŞLUĞU): Bulunan sınıfların hiçbiri test edilmiyor

Mevcut 48 medya testi şunları kapsıyor: sahipli sidecar, yabancı yerel referans,
bilinmeyen kimlik, orphan legacy, tek/çok tenant legacy, bozuk sidecar, ana/sekans
ayrımı, dispatch öncesi yetki, yetkisiz dispatch yan etkisi. **Kapsamayanlar:**

- Harici/şemasız/traversal biçimli `media_url` içinde gömülü dosya kimliği (F-1)
- `sequence_steps[*].message_template` içinde gömülü dosya kimliği (F-1; probe'da
  create **201**, GET **200**)
- İki adımlı PATCH dönüşümü (F-2)
- Kampanya silme sonrası legacy sahiplik devri (F-3)
- Çok tenant referansıyla sahibin erişiminin kesilmesi (F-4)

`test_create_with_external_media_url_is_still_accepted`
(`test_campaign_media_dispatch_auth.py:871–890`) harici URL'nin kabulünü doğru
şekilde test ediyor **ama kimlik taşıyan harici URL varyantını test etmiyor**;
bu test tek başına F-1'i gizliyor.

**Dosya:** `backend/tests/test_campaign_media_dispatch_auth.py:871–890` (ve
genel olarak 25 testlik dosya).

---

### F-6 — LOW (KANIT TUTARSIZLIĞI): 5.4.9'un "2180 passed" iddiası yeniden üretilemiyor

Bağımsız tam suite (taze geçici SQLite):

```text
1 failed, 2179 passed, 4 skipped, 473 warnings, 2 errors in 157.08s → exit 1
```

Tek hata: `backend/tests/test_campaign_runner.py::test_campaign_runner_pauses_on_daily_limit_reached`.
Neden: test `MessageLog(lead_id=1)` ekliyor; `PRAGMA foreign_keys=ON`
(`database.py:46`) altında `leads.id=1` yoksa `FOREIGN KEY constraint failed`.
Test, **kendisinden önce çalışan bir testin Lead id=1 bırakmasına** bağımlı.
`pytest-randomly` (`Using --randomly-seed=...`) sıralamayı değiştirdiği için
186'lık matriste tesadüfen geçiyor, tam suite'te düşüyor. Bu **5.4.9 kodundan
bağımsız, önceden var olan bir test izolasyon kusurudur**; ancak "tam suite
yeşil" kanıtını deterministik olmaktan çıkarır. 5.4.9 raporundaki sayı
düzeltilmelidir.

- 4 skip: `test_whatsapp_phase6_5_qr_live_seam.py` (4 test) —
  `WHATSAPP_LIVE_GATEWAY_URL` yok.
- 2 error: `test_whatsapp_phase2_a_gateway_behavior.py` — Node harness,
  `ERR_MODULE_NOT_FOUND: Cannot find package 'uuid'`; `whatsapp-gateway/node_modules`
  yok. Bağımlılık kurmak bu aşamada yasak olduğu için **başarı sayılmadı**.

---

### F-7 — LOW (SAVUNMA DERİNLİĞİ): `process_single_outreach` kampanyayı tenant'sız yükleyebiliyor

`campaign is None` olduğunda `db.get(Campaign, campaign_id)` ile tenant filtresi
olmadan yüklüyor (`outreach_manager.py:125–129`). Üretimde tek çağıran nesneyi
geçtiği için şu an sömürülebilir bir yol yok; yine de iç API'nin yanlış
kullanıma açık olması not edilmelidir.

**Dosya:** `backend/app/services/outreach_manager.py:125–129`.

---

### F-8 — INFO: Silme medya dosyasını/sidecar'ı temizlemiyor

`delete_campaign` yalnız sekans lead'lerini ve kampanya satırını siliyor
(`campaigns.py:180–182`). Dosya diskte kalıyor; F-3 ile birleşince silme,
legacy sahiplik yorumunu değiştiren birincil araçtır. Tek başına zafiyet değil,
F-3'ün etkisini artıran koşuldur.

---

### 5.4.9'un Doğru Yaptıkları (bağımsız olarak doğrulandı)

- GET ve iki dispatch yolunda **bayt okumadan önce** yetkilendirme
  (`campaigns.py:459→462`; `campaign_media_service.py:375→379`).
- Bağlamsız eski okuyucu kaldırılmış; başka çağıran yok.
- Blank/NULL/boşluk `user_id` fail-closed (`campaign_media_service.py:331–332`).
- Sidecar tek kanıt; yeni yüklemeler zehirlenmeye karşı bağışık (probe: 404).
- Bozuk sidecar legacy'ye düşmüyor (`read_media_ownership:186–202`).
- Yetkisiz dispatch: gönderim yok, `MessageLog` yok, kota tüketimi yok,
  sahte başarı yok; sekans lead'i `FAILED` + `next_step_at=None`.
- Ana worker başarısızlıkta retry döngüsü kurmuyor; sonraki lead'e geçiyor.

---

## 4. Saldırı Senaryoları (özet)

| # | Senaryo | Beklenen | Gerçek | Kanıt |
|---|---|---|---|---|
| A-1 | B, A'nın legacy kimliğini harici URL ile kendi kampanyasına yazar | 400 / erişim yok | create 201, GET 200 | probe s2 |
| A-2 | B, kimliği `sequence_steps[*].message_template` içine gömer | 400 / erişim yok | create 201, GET 200 | probe s3 |
| A-3 | B, zehir satırını PATCH ile yerel URL'ye çevirir | 400 | 200, kalıcı yerel referans | probe s2 |
| A-4 | B, A'nın gerçek legacy referansına ikinci referans ekler | A erişimini korur | A GET 404, dispatch DENIED | probe s4 |
| A-5 | A kampanyasını siler; B tek referans olarak kalır | belirsiz → red | B sahip sayılır (200/true) | probe s4 (AUDIT-1) |
| A-6 | Bilinmeyen/uydurma kimlik | red | yerel ref 400; dosya yoksa GET 404 | test + kod |
| A-7 | Bozuk sidecar | fail-closed | red | `test_corrupt_owner_metadata_fails_closed` |
| A-8 | Çok tenant aynı kimlik | fail-closed | 404 (ama DoS) | `test_ambiguous_legacy_references_are_rejected` |
| A-9 | Path traversal benzeri girdi | red | create 201 + GET 200 (F-1) | probe shape |
| A-10 | Sidecar sahibi ≠ kampanya sahibi | sidecar kazanır | doğru | `test_owner_sidecar_overrides_conflicting_db_reference` |
| A-11 | Yeni sidecar'lı yükleme + zehir | erişim yok | 404 | probe s5 |

**Gerçek saldırı koşulları (F-1/F-2/F-3/F-4):**
- Saldırgan **kimliği doğrulanmış bir tenant** olmalı.
- Hedef dosya **yan dosyasız legacy** olmalı (5.4.7 öncesi yüklemeler).
- Saldırgan **dosya kimliğini bilmeli** (64 bit rastgele; normalde yalnız
  yükleyiciye görünür, ancak URL/log/ekran görüntüsü/paylaşılan şablon ile
  sızabilir). Projenin kendi modeli "dosya kimliği tek başına yetki kanıtı
  değildir" dediği için bu bilgi erişim hakkı doğurmamalıdır; doğuruyor.
- Sidecar'lı yeni yüklemeler ve harici (bu depoya ait olmayan) URL'ler etkilenmez.

**Önem derecesi:** F-1/F-2/F-3 **HIGH** (koşullu), F-4 **MEDIUM/HIGH**.
Gizlilik ihlali (legacy belge okuma), bütünlük/yanlış atıf (başka tenant'ın
medyasını kendi kampanyasından gönderme) ve kullanılabilirlik ihlali (gerçek
sahibin gönderimini durdurma) birlikte değerlendirildiğinde kabul kapısını
geçemez.

---

## 5. Test Kanıtları (bağımsız)

Tümü taze geçici SQLite (`scripts/provision_test_db.py`, 34 tablo) üzerinde,
`DATABASE_URL` + `TEST_DB_PATH` sözleşmesiyle çalıştırıldı.

| Koşum | Komut kapsamı | Sonuç |
|---|---|---|
| Medya testleri | 3 dosya (25 + 13 + 10) | **48 passed** |
| Regresyon matrisi | 5.4.9'daki 14 dosya | **186 passed** (random seed'e bağımlı) |
| Tam suite | `backend/tests/` | **2179 passed, 1 failed, 4 skipped, 2 errors** |
| Tek başına runner testi | `-p no:randomly`, taze DB | **1 failed** (FK; önceden var) |
| PostgreSQL concurrency | mevcut yerel izole PG | **10 passed** (kampanya medyası değil) |

**Testlerin gerçek zinciri çağırdığı doğrulandı:**
- Route testleri `ASGITransport` ile gerçek FastAPI uç noktalarını çağırıyor.
- `send` çağrısı `AsyncMock` (zorunlu; gerçek WhatsApp yasak).
- `get_media_file_info` yalnızca 2 testte **"çağrılmamalı" tripwire'ı** olarak
  monkeypatch edilmiş; yetkilendirme zinciri gerçek.
- `authorize_media_reference` hiçbir testte mock'lanmamış.
- **Mock-only sayılan test yok.** Ancak F-5'te listelenen saldırı sınıfları için
  **test yok**.

---

## 6. Güvenlik Kabul Matrisi

| # | Kontrol | Beklenen | Sonuç | Kanıt / Not |
|---|---|---|---|---|
| 1 | HTTP GET tenant yetkilendirmesi | Sahip okur, yabancı okuyamaz | **KISMİ** | Sidecar'lı yeni yükleme PASS; legacy'de F-1/F-3 ile FAIL |
| 2 | Dispatch tenant yetkilendirmesi | Yabancı medya gönderilmez | **KISMİ** | Yetki-önce-okuma doğru; legacy'de ele geçirme/DoS (F-1/F-4) |
| 3 | Kampanya create doğrulaması | Her yerel referans doğrulanır | **FAIL** | Harici/şemasız/traversal şekiller atlanıyor (probe) |
| 4 | Kampanya update doğrulaması | Yabancıya geçiş reddedilir | **FAIL** | PATCH dönüşümü 200 (F-2) |
| 5 | Sekans medya doğrulaması | Tüm adım medyası doğrulanır | **FAIL** | Yalnız `step.media_url`; `message_template` alt dizesi yetki üretiyor |
| 6 | Legacy tek referans sahipliği | Güvenilir kanıt | **FAIL** | Yalnız mevcut referans durumu; silme ile devrediliyor (F-3) |
| 7 | Legacy çok tenant belirsizliği | Fail-closed | **PASS** | `test_ambiguous_legacy_references_are_rejected`; ancak DoS (F-4) |
| 8 | Eksik/bozuk sidecar | Fail-closed | **PASS** | Eksik → legacy yolu (zafiyetli); bozuk → doğrudan red |
| 9 | Yetkisiz okumada diske erişmeme | Bayt okunmaz | **PASS** | GET 459→462; dispatch 375→379; tripwire testleri |
| 10 | Başarısız dispatch yan etkileri | Gönderim/kota/log/sahte başarı yok | **PASS** | `outreach_manager.py:170–177`; `campaign_runner.py:320–333, 693–699` |
| 11 | Kampanya silme / legacy sahiplik | Sahiplik değişmemeli | **FAIL** | Ampirik AUDIT-1 merdiveni (200 → 404 → 200 el değiştirme) |

---

## 7. PostgreSQL / L4 Sınırlamaları

- **PostgreSQL başlatılmadı.** Kampanya medyası testleri yalnızca **geçici SQLite**
  üzerinde çalıştırıldı; bu, PostgreSQL davranışını kanıtlamaz.
- Ortamda zaten erişilebilir bir yerel izole PostgreSQL (`tezlify_test_isolated`)
  bulunduğu için tam suite içindeki 10 WhatsApp concurrency testi çalıştı ve
  geçti. Bu **kampanya medyası** için kanıt değildir; kampanya medyası
  yetkilendirmesi PostgreSQL'de çalıştırılmadı.
- F-1, uygulama düzeyinde bir **çıkarım/doğrulama uyumsuzluğudur**; `LIKE` /
  `CAST(json AS TEXT)` alt dize semantiği PostgreSQL'de de aynı yönde çalışır
  (varsayılan olarak büyük/küçük harf duyarlı). Ancak bu **ampirik olarak
  doğrulanmadı**.
- **Transaction/concurrency:** Eşzamanlı create/PATCH/GET yarışı, PostgreSQL
  READ COMMITTED altında referans görünürlüğü ve TOCTOU test edilmedi. İki tenant
  aynı anda referans yazarsa hangi satırların yetki sorgusunda görüleceği
  kanıtlanmadı.
- **Constraint:** `campaigns.media_url` üzerinde referans bütünlüğü kısıtı yok;
  `sequence_steps` JSON içeriği şema düzeyinde doğrulanmıyor.
- **L4 (gerçek WhatsApp E2E): KOŞULMADI.** Gerçek hesap/gateway/production
  kullanımı bu aşamada yasak.

---

## 8. Nihai Karar

# FAIL

**Gerekçe:** 5.4.9'un A-1 (dispatch öncesi yetki) ve A-3 (sekans medyası ayrı
doğrulama) mekanizmaları büyük ölçüde doğrudur ve yeni sidecar'lı yüklemeler
korunur. Ancak **A-2'nin çekirdek iddiası — "yeni bir referans sahiplik
üretmez" — ampirik olarak çürütülmüştür.** Yazma doğrulaması ile okuma
yetkilendirmesi farklı referans semantiği kullandığı için, kimliği doğrulanmış
bir tenant legacy bir dosyanın kimliğini bilerek (a) okuyabilir, (b) kendi
kampanyasına kalıcı yerel referans olarak dönüştürebilir, (c) gerçek sahibin
erişimini ve aktif gönderimini durdurabilir. Yetkilendirme modeli tüm erişim
yollarında tutarlı değildir; bu nedenle 5.4.9 pre-production güvenlik kabulünü
geçemez.

**Kodun mevcut olması ve 48 + 186 testin geçmesi PASS gerekçesi değildir**;
testler bulunan saldırı sınıflarını kapsamamaktadır.

### Denetim sorularının yanıtları

1. **5.4.9 yeni yüklemeler ve dispatch için tenant izolasyonunu kanıtlıyor mu?**
   Yeni (sidecar'lı) yüklemeler için **evet**. Dispatch'te yetki-önce-okuma
   doğru, ancak **legacy dosyalarda hayır**: ele geçirme ve DoS mümkün.
2. **Yan dosyasız legacy medyada gerçek sahiplik kanıtlanabiliyor mu?**
   **Hayır.** Yalnız o anki referans durumu biliniyor; ilk yükleyen ve geçmiş
   sahiplik kayıtlı değil.
3. **Tek tenant referansını sahiplik kanıtı saymak güvenli mi?**
   **Hayır.** Referans kendi kendini kanıtlıyor ve değiştirilebiliyor; silme
   sahipliği el değiştiriyor. Bu bir sezgisel yöntemdir, kanıt değildir.
4. **Legacy veri için migration veya karantina gerekli mi?**
   **Evet.** Öneri: (a) güvenilir bir kaynaktan sidecar backfill, (b) yan dosyasız
   tüm legacy dosyaları **karantinaya alıp erişimi reddet**, (c) en azından
   DB-referansına dayalı legacy sahiplik yolunu tamamen kaldır ve açık yönetici
   yeniden-atfı zorunlu kıl.
5. **5.4.9 pre-production güvenlik kabulünü geçebilir mi?**
   **Hayır — FAIL.** A-1/A-3 doğru; A-2 yanlış ve model tutarsız.
6. **Sonraki aşama kodlama mı, altyapı mı, yoksa yeni bir salt okunur denetim mi?**
   **Önce kodlama (5.4.11 güvenlik düzeltmesi).** Zafiyet kanıtlanmış durumda;
   yeni bir denetim, düzeltme yapılmadan aynı sonucu verir. Düzeltmeden sonra
   PostgreSQL ve L4 kanıtı içeren **yeni bir salt okunur kabul denetimi
   (5.4.12)** yapılmalıdır. Legacy veri karantinası/backfill bir altyapı
   operasyonu olarak ayrıca planlanmalıdır.

---

## 9. Önerilen Sonraki Aşama

**AŞAMA 5.4.11 — Campaign Media Legacy Ownership Hardening (kodlama):**

1. **Tek referans çıkarımı:** Yazma ve okuma için aynı kanonik çıkarımı kullan;
   yalnız yapısal alanlardaki (`media_url`, `step.media_url`) **tam eşleşen**
   yerel URL'leri referans say. Serbest alt dize taramasını (özellikle
   `sequence_steps` JSON metni) kaldır.
2. **Kendi kendini kanıtlama yasağı:** Yetki sorgusundan işlemdeki kampanya
   satırını hariç tut veya sahipliği yalnız yükleme anındaki sunucu kaydına
   dayandır. Bir tenant'ın yeni yazdığı referans asla sahiplik üretmesin.
3. **Legacy politikası:** Yan dosyasız dosyalar için DB-referansı fallback'ini
   kaldır; varsayılan olarak reddet/karantinaya al. Sidecar backfill yalnız
   güvenilir bir kaynaktan yapılsın.
4. **Zorunlu testler:** Harici/şemasız/traversal URL, `sequence_steps`
   `message_template` gömüsü, iki adımlı PATCH dönüşümü, silme sonrası sahiplik
   devri, çok tenant DoS, eşzamanlı PG yarışı.
5. **Doğrulama:** Taze SQLite + izole PostgreSQL; ardından L4 olmadan 5.4.12
   salt okunur kabul denetimi.

**Bu aşamada DURULDU.** Kod düzeltmesi, commit, push, deploy veya sonraki aşamaya
otomatik geçiş yapılmadı. Tek artefakt bu rapordur.
