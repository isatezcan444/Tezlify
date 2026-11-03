# AŞAMA 5.4.13 — Campaign Media Bağımsız Release Denetimi

**Tarih:** 2026-11-03
**Denetim türü:** Yalnızca bağımsız, salt-okunur denetim
**Kapsam:** 5.4.12'de PASS_WITH_NOTES olarak raporlanan F-1, F-2, F-3, F-4 ve R-1
**Çalışma worktree'si:** `/private/tmp/tz429-release`

---

## 0. Yönetici Özeti ve Karar

**Karar: RELEASE_BLOCKED**

F-1, F-2 ve F-4'ün **yeni yazma/GET/dispatch yolları** kod ve test düzeyinde
kapatılmıştır. Ancak F-3'ün legacy veri yolu kapatılmamıştır: sidecar'ı
bulunmayan bir dosyada tek bir kanonik DB referansı, gerçek yükleyeni
kanıtlamaz. Fix öncesi kod bu referansları doğrulamadan ve kimlik
denetlemeden kabul ettiği için, mevcut veride saldırgan tarafından yazılmış
bir kanonik referans gerçek sahibin referansından ayırt edilemez.

Bu bir "teorik veri belirsizliği" değildir. İzole SQLite probe'unda:

- B tenant'ının tek kanonik referansı olan sidecar'sız dosyada B,
  `GET` ile **200** ve dispatch için **base64** aldı (S2).
- A ve B birlikte referans verirken ikisi de reddediliyordu; A kendi
  referansını silince veya kampanyasından çıkarınca B **tek başına sahip
  oldu** ve dosyaya erişti (S3, update-away probe).
- Aynı maruziyet sequence-step referansında da vardır (S9).

Dolayısıyla mevcut kodla yanlış tenant'ın dosyaya erişmesi, tarif edilen
legacy veri durumunda **mümkündür**. Üretim/PostgreSQL verisi bu denetimde
incelenmediği için bu durumun üretimde kaç dosyada oluştuğu ölçülmemiştir;
bu ölçümün yokluğu güvenli release'in kanıtlanmasını engeller.

Karar kategorisi **RELEASE_BLOCKED**'dır: kod testleri geçse bile mevcut
legacy veri güvenilir biçimde ayrıştırılamıyor. Legacy durumda gözlenen
etki, dar anlamda FAIL kriterine (yanlış tenant erişimi) karşılık gelir;
ancak engel yeni kod yolunun regresyonu değil, veri kökeninin
kanıtlanamamasıdır.

**Kanıt özeti**

| Alan | Sonuç |
|---|---|
| F-1 kanonik referans doğrulaması | PASS |
| F-2 yeni yazmanın sahiplik üretmemesi | PASS (yeni create/update) |
| F-3 legacy sahipliği / takeover | **FAIL (legacy canonical ref)** |
| F-4 GET/dispatch reddi ve yan etkisizlik | PASS (reddedilen çağıran için) |
| R-1 tek kanonik DB referansı | **Güvenilir sahiplik kanıtı değil** |
| Testler | 74/74 medya, 107/107 campaign-outreach, 2206 passed + 2 env error |
| PostgreSQL | ÇALIŞTIRILMADI — kanıt yok |
| L4 gerçek WhatsApp E2E | ÇALIŞTIRILMADI — kanıt yok |

---

## 1. Başlangıç ve Bitiş Git Durumu

### 1.1 Başlangıç

- Denetim worktree'si: `/private/tmp/tz429-release`
- Branch: `release/backend-only-seq-safety`
- HEAD: `978ddf56877cd7aad7d2f30b095b6232e34802d2`
- HEAD mesajı: `fix(whatsapp): use portable timeout return type`

İlk `pwd` kabuk ana worktree'yi (`/Users/isatezcan/Documents/Github/Tezlify`)
gösterdi. Denetimdeki tüm git ve test komutları `git -C
/private/tmp/tz429-release` veya `dir_path=/private/tmp/tz429-release` ile
release worktree'sine yönlendirildi. Ana worktree'ye yazma yapılmadı.

Başlangıç `git status --short`: **14 modified + 18 untracked = 32 giriş**.

Modified:

```text
backend/app/api/v1/endpoints/campaigns.py
backend/app/api/v1/endpoints/whatsapp.py
backend/app/services/campaign_media_service.py
backend/app/services/campaign_runner.py
backend/app/services/link_preview/service.py
backend/app/services/outreach_manager.py
backend/app/services/whatsapp/orchestration/messaging.py
backend/app/services/whatsapp_gateway.py
backend/tests/test_campaign_media.py
backend/tests/test_whatsapp_live.py
whatsapp-gateway/package.json
whatsapp-gateway/src/index.js
whatsapp-gateway/src/media/media-store.js
whatsapp-gateway/src/session-manager.js
```

Untracked:

```text
backend/tests/test_campaign_media_auth.py
backend/tests/test_campaign_media_dispatch_auth.py
backend/tests/test_campaign_media_ownership_hardening_5412.py
backend/tests/test_link_preview_media_tenant_isolation.py
backend/tests/test_whatsapp_media_tenant_isolation.py
reports/
whatsapp-gateway/src/media/media-routes.js
whatsapp-gateway/tests/media-test-loader-atomic.mjs
whatsapp-gateway/tests/media-test-loader.mjs
whatsapp-gateway/tests/media-test-register-atomic.mjs
whatsapp-gateway/tests/media-test-register.mjs
whatsapp-gateway/tests/stubs/
whatsapp-gateway/tests/test-media-ingestion-atomicity-545.mjs
whatsapp-gateway/tests/test-media-routes-543.mjs
whatsapp-gateway/tests/test-media-routes-545.mjs
whatsapp-gateway/tests/test-media-session-dedupe-547.mjs
whatsapp-gateway/tests/test-media-store-543.mjs
whatsapp-gateway/tests/test-media-store-integrity.mjs
```

### 1.2 5.4.12 Öncesi/Sonrası Değişiklik Kapsamı

5.4.12'nin bu denetimde doğrulanan kapsamı:

- `backend/app/services/campaign_media_service.py` — kanonik parser, sidecar
  okuma, merkezî yetkilendirme, legacy referans sahipleri, yetkili base64.
- `backend/app/api/v1/endpoints/campaigns.py` — create/update medya
  doğrulaması ve GET yetkilendirmesi.
- `backend/tests/test_campaign_media_ownership_hardening_5412.py` — yeni test.
- `reports/whatsapp-phase-5.4.12-campaign-media-release-blocker-fix.md` — rapor.

5.4.12 dışındaki 5.4.2–5.4.11 birikmiş değişiklikler korunmuştur. 5.4.13'te
hiçbir uygulama, test, yapılandırma veya bağımlılık dosyası değiştirilmedi.

### 1.3 Bitiş

Denetim sonunda `git status --short` yine **32 giriş**tir. Başlangıca göre
tek fark, zaten untracked olan `reports/` dizini içine bu raporun
eklenmesidir; `git status` bu dizini tek satırda (`?? reports/`) gösterdiği
için giriş sayısı değişmez. Probe/testlerin oluşturduğu medya dosyaları
probe tarafından temizlenmiş, `uploads/campaign_media` boş kalmıştır.

Yerel `tezlify.db` dosyası 0 byte olduğu için yerel legacy veri örneği
incelenememiştir.

---

## 2. İncelenen Gerçek Kod Noktaları

### 2.1 Mevcut (5.4.12 sonrası) kod

| Dosya | Satır | İşlev |
|---|---|---|
| `backend/app/services/campaign_media_service.py` | 50 | `FILE_ID_PATTERN = ^camp_[a-f0-9]{16}$` |
| aynı | 57–59 | `CANONICAL_LOCAL_MEDIA_URL_PATTERN` — tek kabul edilen tam kanonik biçim |
| aynı | 76–87 | `extract_local_file_id` — yalnızca `fullmatch` |
| aynı | 90–107 | `looks_like_local_media_reference` — tek `unquote` + marker/embedded ID |
| aynı | 219–241 | `read_media_ownership` — `owner` / `legacy` / `corrupt` |
| aynı | 254–322 | `save_uploaded_media` — sidecar yazımı; yazılamazsa dosya silinir + 500 |
| aynı | 325–351 | `get_media_file_info` — baytları okur, MIME'ı baytlardan yeniden türetir |
| aynı | 354–387 | `authorize_media_reference` — sidecar önceliği, legacy tek-tenant kuralı |
| aynı | 390–409 | `_campaign_references_file_exactly` — yalnızca ana/sequence `media_url` tam parse |
| aynı | 412–454 | `_legacy_reference_owners` — SQL ön filtre + Python tam parse |
| aynı | 457–478 | `get_authorized_campaign_media_base64` — yetki önce, bayt sonra |
| `backend/app/api/v1/endpoints/campaigns.py` | 105–112 | `create_campaign` → `_validate_campaign_media_references` |
| aynı | 142–158 | `update_campaign` → aynı doğrulama |
| aynı | 373–383 | `_collect_campaign_media_references` (ana + sequence step) |
| aynı | 386–426 | `_validate_campaign_media_references` |
| aynı | 429–439 | `_authorize_campaign_media` |
| aynı | 442–485 | `get_campaign_media`; yetki **470**, bayt okuma **473** |
| `backend/app/services/outreach_manager.py` | 157–177 | Dispatch medya yetkisi; reddedilirse gönderim yok |
| aynı | 193–201 | `start_conversation` yalnızca yetkiden sonra |
| aynı | 203–216 | `MessageLog` yalnızca gönderimden sonra |
| `backend/app/services/campaign_runner.py` | 306–333 | Sequence adımı medya yetkisi; reddedilirse FAILED, gönderim yok |
| aynı | 343–352 | Sequence `start_conversation` |
| aynı | 358–374 | Başarı sonrası `sent_count` ve `MessageLog` |
| aynı | 693–699 | Kota tüketimi yalnızca `success` sonrası |

### 2.2 HEAD (üretim tipi) karşılaştırması

HEAD `978ddf5` üzerinde bu güvenlik modeli **yoktur**:

- `git show HEAD:backend/app/api/v1/endpoints/campaigns.py` satır 105–119:
  `create_campaign` medya referansını doğrulamadan `Campaign(**campaign_dict)`
  oluşturuyor.
- Aynı dosya satır 139–146: `update_campaign` medya referansını doğrulamıyor.
- Aynı dosya satır 365–388: `get_campaign_media(file_id)` **kimlik doğrulama
  bağımlılığı olmadan** doğrudan `get_media_file_info(file_id)` çağırıyor.
- `git show HEAD:backend/app/services/campaign_media_service.py` satır 124–176:
  `save_uploaded_media` dosyayı yazıyor ancak **owner sidecar yazmıyor**.
  Satır 178–210'da yetkisiz `get_media_file_info` / `get_campaign_media_base64`
  bulunuyor.

Bu fark, R-1'in neden gerçek olduğunun temelidir: release öncesi üretimde
oluşmuş tüm medya dosyaları sidecar'sızdır ve release öncesi create/update
yolları herhangi bir tenant'ın herhangi bir kanonik referansı yazmasına izin
veriyordu.

### 2.3 Alternatif yazma yolları

- `Campaign` satırı yalnızca `create_campaign` ve `update_campaign` üzerinden
  medya referansı alıyor; başka bir create/update/import/duplicate endpoint'i
  yok.
- `core/seed.py` demo kampanyası `media_url` yazmıyor; ayrıca
  `SEED_DEMO_DATA` varsayılanı `False`.
- `campaign_runner.py` ve `outreach_manager.py` yalnızca `MessageLog.media_url`
  yazıyor; `Campaign.media_url` yazmıyor.
- `upload_campaign_media` yalnızca dosya + sidecar üretiyor; kampanya satırı
  oluşturmuyor.

---

## 3. F-1 — Kanonik Referans Doğrulaması

**Sonuç: PASS**

### 3.1 Yalnızca tam kanonik biçim

`extract_local_file_id` (`campaign_media_service.py:76–87`) yalnızca
`CANONICAL_LOCAL_MEDIA_URL_PATTERN.fullmatch` ile eşleşen
`/api/v1/campaigns/media/camp_<16 lowercase hex>` biçimini kabul eder.
Şunların hiçbiri sahiplik üretmez:

- host içeren mutlak URL (`https://evil.example/api/v1/campaigns/media/...`),
- şemasız yol (`campaigns/media/...`),
- `..` veya `%2e%2e` traversal,
- `%2F` / çift kodlama,
- query (`?x=1`) veya fragment (`#frag`),
- baştaki/sondaki boşluk,
- büyük/küçük harf varyantı,
- çıplak `camp_...` kimliği,
- URL'nin herhangi bir yerinde geçen kimlik (substring).

`looks_like_local_media_reference` (`:90–107`) tek `unquote` sonrası
`/campaigns/media/` marker'ını veya `camp_<16 hex>` desenini arar. Kanonik
olmayan ama yerel depoyu hedeflemeye çalışan her referans yazma anında 400
ile reddedilir (`campaigns.py:386–426`). Bu depoyu hedeflemeyen sıradan
harici URL'ler serbesttir ve sahiplik **sayılmaz**.

### 3.2 Create ve update aynı doğrulamayı uygular

- `create_campaign` (`campaigns.py:105–112`) `campaign_in.media_url` ve
  `campaign_in.sequence_steps` için doğrulama çağırır.
- `update_campaign` (`:142–158`) `update_data` üzerinden aynı doğrulamayı
  çağırır; doğrulama başarısızsa `setattr` çalışmaz ve satır değişmez.

### 3.3 Sequence step'leri atlanmaz

`_collect_campaign_media_references` (`:373–383`) ana `media_url` yanında her
dict step'in `media_url` alanını toplar. `_campaign_references_file_exactly`
(`campaign_media_service.py:390–409`) de yalnızca ana `media_url` ve
`sequence_steps[*]["media_url"]` alanlarını tam parse eder; `message_template`
gibi serbest metin sahiplik üretmez.

### 3.4 Alternatif endpoint / bypass

Yukarıdaki 2.3 envanterine göre kampanya medya referansı yazan başka bir
endpoint yoktur. `get_media_file_info` doğrudan çağrısı yalnızca GET
(`campaigns.py:473`) ve yetkili base64 çözümleyici
(`campaign_media_service.py:474`) içinde, yetki kontrolünden sonra yapılır.

### 3.5 Kanıt

- 5.4.12 testleri: 9 parametreli kanonik olmayan biçim + 2 birim testi
  (`test_campaign_media_ownership_hardening_5412.py:191, 211, 372–418`).
- Probe S8: A kanonik, B harici URL → B reddedildi, A erişti.
- Probe S10: referanssız dosyaya B'nin yeni create'i → 400.
- Probe S11: A sidecar'lı dosyaya B'nin yeni create'i → 400.
- Probe S12: A'nın tek kanonik legacy referansıyla yeni create → 201
  (meşru legacy davranışı korunuyor).

### 3.6 Artık gözlem

`looks_like_local_media_reference`, `camp_<16 hex>` içeren sıradan harici bir
URL'yi de reddedebilir (yanlış pozitif). Bu bir güvenlik açığı değil,
muhafazakâr fail-closed davranıştır; yalnızca işlevsel bir katılıktır.

---

## 4. F-2 — Yeni Yazmanın Sahiplik Üretmemesi

**Sonuç: PASS (yeni create/update yolları)**

### 4.1 Davranış

- Sidecar varsa tek kanıt sidecar'dır; DB referansları sidecar'ı ezemez
  (`authorize_media_reference`, `campaign_media_service.py:378–387`).
- Sidecar yoksa yalnızca DB'de **önceden var olan** tam kanonik referanslar
  değerlendirilir. Yeni isteğin kendi referansı bu kümeye eklenmez; doğrulama
  isteğin yazılmasından önce yapılır.
- 0 sahipli, çok tenantlı veya NULL sahipli dosya fail-closed'dur.
- Bozuk sidecar legacy'ye düşmez (`:381–382`).

### 4.2 Kanıt

- Probe S10: sidecar'sız ve referanssız dosyaya B create → **400**.
- Probe S11: A sidecar'lı dosyaya B create → **400**.
- Probe S4: A ve B kanonik referanslı dosyada her iki taraf da **reddedildi**.
- Probe S7: bozuk sidecar + B kanonik referans → her iki taraf da **reddedildi**.
- 5.4.12 testleri: foreign sidecar create/update, sequence foreign step,
  non-canonical formlar, corrupt sidecar (`test_campaign_media_ownership_hardening_5412.py:419, 442, 466`).

### 4.3 Önemli nüans

B daha önce tek kanonik legacy referans sahibi ise, yeni create'i **201**
alır (probe S13). Bu, yeni isteğin sıfırdan sahiplik üretmesi değildir;
mevcut (ve R-1 nedeniyle güvenilmez olabilecek) iddiayı genişletir. F-2
lafzen korunur, ancak R-1'in etkisini ortadan kaldırmaz.

---

## 5. F-3 ve R-1 — Legacy Sahipliği

**Sonuç: F-3 legacy yolu FAIL; R-1 gerçek erişim yolu**

### 5.1 Yedi senaryo

Aşağıdaki tablo, izole SQLite probe'unda (`/tmp/tz5413_r1_probe.py` ve
`/tmp/tz5413_update_probe.py`) doğrudan gözlenen davranıştır. A = gerçek
yükleyen, B = saldırgan/başka tenant.

| # | Senaryo | Gözlenen davranış | Sonuç |
|---|---|---|---|
| 1 | A'nın eski kanonik referansı (sidecar yok) | A yetkili, B reddedildi; GET A=200, B=404 | Meşru legacy çalışıyor |
| 2 | B'nin fix öncesi kanonik referansı; A referansı yok | B yetkili, A reddedildi; GET A=404, B=200; B base64 aldı | **Yanlış tenant erişimi** |
| 3 | B'nin tek başına kalan kanonik referansı (A sildi) | A+B iken ikisi de reddedildi; A silince B yetkili, GET B=200 | **Sahiplik devri** |
| 4 | A ve B aynı dosyaya kanonik referans | İkisi de reddedildi | Fail-closed; A da erişemiyor |
| 5 | Sahipsiz orphan, hiç referans yok | İkisi de reddedildi | Fail-closed |
| 6 | A kampanyasını siler / referansı güncelle-away yapar | B kanonik referansı kalıyorsa B yetkili; B referansı kanonik değilse 0 sahip → herkes reddedilir | **Kanonik B varsa devir** |
| 7 | Sidecar var / yok | Sidecar A ise A yetkili, B reddedildi; bozuk sidecar legacy'ye düşmez; sidecar yoksa DB referansı belirler | Sidecar güvenli; sidecar'sız R-1 |

Probe çıktıları (özet; tam satırlar probe log'undadır):

```text
S1_legit_A_sole_ref: AUTH_A=True AUTH_B=False GET_A=200 GET_B=404 DISPATCH_A=BASE64:36 DISPATCH_B=DENIED
S2_B_sole_ref_no_A_ref: AUTH_A=False AUTH_B=True GET_A=404 GET_B=200 DISPATCH_A=DENIED DISPATCH_B=BASE64:36
S3_A_and_B_before_delete: AUTH_A=False AUTH_B=False GET_A=404 GET_B=404
S3_A_deleted_B_remains: AUTH_A=False AUTH_B=True GET_A=404 GET_B=200 DISPATCH_B=BASE64:36
S4_two_tenants: AUTH_A=False AUTH_B=False GET_A=404 GET_B=404
S5_orphan_no_refs: AUTH_A=False AUTH_B=False GET_A=404 GET_B=404
S6_sidecar_A_db_B: AUTH_A=True AUTH_B=False GET_A=200 GET_B=404
S7_corrupt_sidecar_B_ref: AUTH_A=False AUTH_B=False GET_A=404 GET_B=404
S8_A_canonical_B_external: AUTH_A=True AUTH_B=False GET_A=200 GET_B=404
S9_B_sequence_step_only: AUTH_A=False AUTH_B=True GET_A=404 GET_B=200 DISPATCH_B=BASE64:36
S10_create_no_refs_as_B: 400
S11_create_foreign_sidecar_as_B: 400
S12_create_legit_legacy_as_A: 201
S13_create_as_B_on_B_sole_ref: 201
```

Update-away probe (A referansını kaldırır, B kanonik referansı kalır):

```text
BEFORE_A=False BEFORE_B=False AFTER_A=False AFTER_B=True GET_A=404 GET_B=200 DISPATCH_B=BASE64:44
```

### 5.2 Tek kanonik DB referansı güvenilir sahiplik kanıtı mı?

**Hayır.** Sidecar'sız bir dosyada tek kanonik DB referansı yalnızca bir
**iddia**dır; yükleyen kimliğinin kanıtı değildir. Nedenleri:

1. Fix öncesi `create_campaign` ve `update_campaign` medya referansını
   doğrulamıyordu (HEAD satır 105–119, 139–146). Herhangi bir kimliği
   doğrulanmış tenant, herhangi bir dosya kimliği için kanonik bir referans
   yazabiliyordu.
2. Fix öncesi `GET /api/v1/campaigns/media/{file_id}` kimlik doğrulaması
   olmadan çalışıyordu (HEAD satır 365–388). Dosya kimliğini bilen/elde eden
   bir taraf, release öncesi dosyayı okuyabiliyordu.
3. Fix öncesi `save_uploaded_media` owner sidecar yazmıyordu (HEAD satır
   124–176). Bu nedenle release öncesi yüklenen **her** dosya, 5.4.12
   açısından `legacy` durumundadır.
4. Veri modelinde yükleme zamanı, yükleyen kimliği veya referans yazılma
   zamanı gibi bir köken kanıtı yoktur. `Campaign.user_id` yalnızca o
   kampanyayı oluşturan tenant'ı söyler; dosyayı yükleyeni söylemez.
5. Bir dosya kimliği 64-bit rastgele olsa da, sistemin kendi kuralı "kimliği
   bilmek erişim hakkı doğurmaz"dır (`FILE_ID_PATTERN` yorumu). Tek kanonik
   referansı güvenilir saymak, bu ilkeyi legacy dosyalarda tersine çevirir.

### 5.3 Mevcut veritabanı kayıtları

- Yerel `tezlify.db` 0 byte olduğu için incelenebilir yerel kayıt yoktu.
- Üretim/PostgreSQL verisi bu aşamada **incelenmedi** (aşama sınırı gereği
  yasak). Bu nedenle "üretimde şu kadar dosya etkilendi" veya "üretimde
  saldırgan referansı var" denemez.
- Ancak HEAD kodu, böyle bir kaydın oluşmasına izin veriyordu. Kanıt
  yükünün yokluğu, riskin yokluğu değildir; güvenli release iddiası için
  üretim envanteri gerekir.

### 5.4 Teorik mi, gerçek mi?

**Gerçek bir erişim yolu.** Probe, kodun tarif edilen legacy veri durumunda
B'ye baytları okuma ve gönderme yetkisi verdiğini gösteriyor. Bu, yalnızca
"hangi satır gerçek sahibin" belirsizliği değil; B'nin **fiilen** GET 200 ve
base64 almasıdır. Önkoşul:

- B dosya kimliğini biliyor (URL sızıntısı, paylaşılan bağlantı, eski
  kimlik doğrulamasız GET, log/referrer vb.),
- B fix öncesi kanonik bir referans yazmış,
- A'nın o dosyaya kanonik bir referansı yok veya A silmiş/update-away yapmış.

Üçüncü koşul normal kullanımda oluşabilir: kullanıcı kampanyasını siler,
medyayı değiştirir veya hiç kampanyaya bağlamadan dosyayı yükler. Bu nedenle
senaryo yalnızca teorik değildir. Bununla birlikte üretimde bu durumun
prevalansı bu denetimde ölçülmemiştir; bu ölçüm release öncesi zorunludur.

### 5.5 Hangi dosyalar fail-closed olmalı?

Mevcut kodun aksine, **sidecar'sız tüm legacy dosyalar**, bağımsız ve
güvenilir bir sahiplik kaydı (operatör doğrulamalı eşleme, güvenilir yükleme
audit'i veya kullanıcı sahiplenme akışı) olmadıkça GET, dispatch ve yeni
referans doğrulamasında fail-closed olmalıdır. Yalnızca 0/>1 sahip durumunu
fail-closed yapmak yetmez; tek sahip durumu da kanıt değildir.

Bu, meşru legacy kullanıcıların erişimini kaybetmesi anlamına gelir. Bu
nedenle karar bir mühendislik tercihi değil, veri sahibi/operasyon onayı
gerektiren bir release kapısıdır.

### 5.6 Migration/backfill olmadan güvenli release mümkün mü?

**Mevcut 5.4.12 kuralıyla hayır.** Seçenekler:

1. **Tüm legacy dosyaları fail-closed yap** (kod değişikliği; migration
   gerekmez). Güvenli olur, ancak meşru legacy erişimi kaybolur.
2. **Operatör doğrulamalı migration/backfill veya sahiplenme akışı** yap
   (yükleme audit'i, destek kaydı, kullanıcı kanıtı). Güvenli olabilir,
   ancak veri çalışması gerektirir.
3. **Üretimde sidecar'sız dosya olmadığını kanıtla.** Bu denetimde
   kanıtlanmadı; HEAD'in sidecar yazmaması nedeniyle beklenen durum değildir.

5.4.12 mevcut haliyle hiçbirini yapmıyor; tek kanonik referansı güveniyor.
Bu nedenle güvenli release kanıtlanamaz.

### 5.7 5.4.12 testlerindeki kapsam boşluğu

5.4.12'nin "sahip silme" ve "update-away" senaryoları, B'nin referansını
**kanonik olmayan** biçimde kuruyor:

- `test_owner_delete_does_not_transfer_legacy_ownership` (`test_campaign_media_ownership_hardening_5412.py:524`),
  B için `https://evil.example/{file_id}` kullanıyor (satır 527–532).
- `test_owner_update_away_does_not_transfer_legacy_ownership` (`:575`),
  B için `evil.example/{file_id}` kullanıyor (satır 578–581).

Fix öncesi saldırgan kanonik URL yazabildiği için bu fixture gerçek saldırı
biçimini temsil etmiyor. Bu nedenle testler "A silince 0 sahip kalır" alt
durumunu doğruluyor, "B'nin kanonik referansı tek başına kalır" alt durumunu
değil. Probe S3 ve update-away probe bu boşluğu kapatıyor.

---

## 6. F-4 — GET ve Dispatch Güvenliği

**Sonuç: PASS (reddedilen çağıran için)**

### 6.1 GET yetkilendirmesi baytlardan önce

`get_campaign_media` (`campaigns.py:442–485`):

- Satır 470: `_authorize_campaign_media(...)` → `authorize_media_reference`.
- Satır 473: yalnızca yetki başarılıysa `get_media_file_info(file_id)`.
- Yetkisiz çağırana 404 döner; dosyanın varlığı sızdırılmaz.

Test `test_unauthorized_get_does_not_read_bytes` (`:644`) `get_media_file_info`
fonksiyonunu patlatıp B için çağrılmadığını doğrular. PASS.

### 6.2 Dispatch yetkilendirmesi base64/baytlardan önce

- `OutreachManager` (`outreach_manager.py:157–177`):
  `get_authorized_campaign_media_base64` → yetki → bayt; reddedilirse
  `(False, "Medya sahipliği doğrulanamadı; gönderim durduruldu.", None)`.
  `start_conversation` (`:193`) ve `MessageLog` (`:203`) bu noktadan sonra.
- Sequence (`campaign_runner.py:306–333`): aynı sıra; reddedilirse
  `SequenceLeadStatus.FAILED`, `stop_reason="MEDIA_UNAUTHORIZED"`,
  `next_step_at=None`; `start_conversation` (`:344`) çağrılmaz.
- `get_authorized_campaign_media_base64` (`campaign_media_service.py:457–478`):
  yetki başarısızsa `CampaignMediaAccessDenied`; `get_media_file_info` (474)
  çalışmaz.

### 6.3 Yan etkiler

- `MessageLog` yalnızca gönderim başarısından sonra yazılır
  (`outreach_manager.py:203–216`).
- `campaign.sent_count` yalnızca başarı sonrası artar
  (`outreach_manager.py:220`; sequence `campaign_runner.py:358–362`).
- Kota tüketimi yalnızca `success` sonrası `QuotaGuardService.consume_whatsapp_quota`
  ile yapılır (`campaign_runner.py:693–699`).
- Test `test_unauthorized_dispatch_has_no_send_log_or_counter_side_effects`
  (`:722`) gönderim yok, log yok, `lead.status` NEW, `sent_count`/`failed_count`
  0/None olduğunu doğrular. PASS.
- Sequence reddi `FAILED` durumunu yazar; bu bir gönderim/log/kota yan etkisi
  değil, akışı durduran zorunlu durum kaydıdır.

### 6.4 Sidecar/DB çelişkisi ve bozuk sidecar

- Sidecar sahibi A, DB'de B referansı olsa bile A yetkili, B reddedilir
  (probe S6; test `test_owner_sidecar_overrides_conflicting_db_reference`).
- Bozuk sidecar legacy'ye düşmez; B kanonik referansı olsa bile herkes
  reddedilir (probe S7; test `test_corrupt_sidecar_does_not_fall_back_to_legacy`).

### 6.5 Sınır

F-4, **reddedilen** çağıranın bayt okumadığını ve yan etki üretmediğini
kanıtlar. R-1 durumunda B "yetkili" sayıldığı için F-4'ün reddetme yolu
tetiklenmez; B baytları okur ve gönderir. Bu bir F-4 regresyonu değil,
F-2/F-3'ün legacy sahiplik kararının sonucudur.

---

## 7. Testler ve Kanıt

### 7.1 Seviye sınıflandırması

| Seviye | Ne çalıştı | Sonuç |
|---|---|---|
| L1 statik | `py_compile` (4 dosya) + `git diff --check` | Exit 0 |
| L2 birim | 2 parser/detector testi (5.4.12 dosyası) | PASS |
| L3 SQLite/mock | 4 medya dosyası, 2 farklı seed | 74/74 PASS |
| L3 SQLite/mock | campaign + outreach regresyonları | 107/107 PASS |
| L3 SQLite/mock | tam backend paketi | 2206 passed, 4 skipped, 2 error |
| L4 gerçek WhatsApp | — | **ÇALIŞTIRILMADI** |
| PostgreSQL | — | **ÇALIŞTIRILMADI** |

### 7.2 Medya paketleri (tek tek)

Temiz SQLite DB (`/tmp/tezlify_5413_audit_f.db`, 34 tablo) üzerinde:

```text
test_campaign_media_ownership_hardening_5412.py   26 passed
test_campaign_media_auth.py                       10 passed
test_campaign_media_dispatch_auth.py              25 passed
test_campaign_media.py                            13 passed
```

Toplam **74 passed**. Toplu koşumda da 74/74.

### 7.3 Sıra bağımlılığı

İki farklı `pytest-randomly` seed'i ile toplu koşum:

- seed `5413`: **74 passed**
- seed `20251103`: **74 passed**

`--collect-only` çıktısında ilk testler farklıdır; yani gerçekten farklı
sıralar denenmiştir. 5.4.12 testleri her senaryoda kendi fixture'ını kurup
`finally` içinde temizler; testler arası DB/file artığına bağımlılık
gözlenmemiştir. Bu, tüm olası sıraların tükenmez bir kanıtı değildir; iki
farklı sırada hata görülmemiştir.

### 7.4 Campaign/outreach regresyonları

Ayrı temiz SQLite DB (`/tmp/tezlify_5413_audit_c.db`) üzerinde:

```text
backend/tests/test_campaign_*.py
backend/tests/test_smart_outreach_api.py
backend/tests/test_email_outreach.py
```

Sonuç: **107 passed, 1 warning** (datetime.utcnow deprecation).

### 7.5 Tam backend paketi

Temiz SQLite DB (`/tmp/tezlify_5413_audit_e.db`) üzerinde:

```text
2206 passed, 4 skipped, 470 warnings, 2 errors in 133.54s
EXIT=1
```

İki error:

```text
test_whatsapp_phase2_a_gateway_behavior.py::test_hydrated_group_persists_via_real_ingestion
test_whatsapp_phase2_a_gateway_behavior.py::test_hydrated_group_broadcast_reaches_frontend
```

Neden: `ERR_MODULE_NOT_FOUND: Cannot find package 'uuid' imported from
/private/tmp/tz429-release/whatsapp-gateway/src/session-manager.js`.
Node bağımlılığı eksikliğinden kaynaklanan **environment-blocked** hatalardır;
başarı sayılmamıştır ve 5.4.12/5.4.13 kampanya medya değişikliğiyle ilgili
değildir.

### 7.6 R-1 probe

- `/tmp/tz5413_r1_probe.py`: 13 senaryo (S1–S13) + temizlik.
- `/tmp/tz5413_update_probe.py`: update-away senaryosu.
- İzole SQLite DB `/tmp/tezlify_5413_audit_d.db`.
- Test auth başlığı yalnızca tenant kimliği seçmek için kullanıldı; üretim
  kimlik doğrulamasını taklit etmez. `authorize_media_reference` çağrıları
  doğrudan yapıldı.
- Sidecar'sız dosya doğrudan bayt olarak oluşturuldu; bu, HEAD'in sidecar
  yazmayan `save_uploaded_media` davranışını temsil eder. Güncel upload
  endpoint'i kullanılsaydı sidecar yazılır ve B reddedilirdi; probe bu
  nedenle legacy durumu bilinçli olarak doğrudan kurmuştur.
- Kampanya satırları da doğrudan DB'ye seed edildi; bu, fix öncesi
  create/update yollarının doğrulamasız yazabildiği referansları temsil eder.
  Güncel create endpoint'i B'nin sıfırdan referans yazmasını reddeder.
- Probe'un oluşturduğu dosya ve satırlar kendisi tarafından temizlendi;
  `uploads/campaign_media` boş.

### 7.7 PostgreSQL ve L4 açıklaması

- PostgreSQL **çalıştırılmadı**. `_legacy_reference_owners`
  (`campaign_media_service.py:412–454`) `cast(sequence_steps, Text)` ve
  `contains(autoescape=True)` kullanır; SQLAlchemy düzeyinde taşınabilir
  görünse de PostgreSQL davranışı bu denetimde doğrulanmamıştır.
- Gerçek WhatsApp/gateway E2E **çalıştırılmadı**. Testlerde
  `whatsapp_service.start_conversation` mock'lanmıştır. L4 başarı iddiası
  yoktur.
- SQLite sonuçları PostgreSQL sonucu olarak sunulmamıştır.

---

## 8. Nihai Release Kararı

**RELEASE_BLOCKED**

### 8.1 Gerekçe

- **F-1 PASS:** Yeni create/update/sequence referansları yalnızca tam
  kanonik biçimde kabul ediliyor; kanıtlanmış bir bypass yok.
- **F-2 PASS:** Yeni create/update tek başına legacy sahiplik üretemiyor;
  referanssız/yabancı sidecar'lı dosya 400 alıyor.
- **F-3 FAIL (legacy):** Sidecar'sız dosyada B'nin tek kanonik referansı
  sahiplik sayılıyor; A silince/update-away yapınca B tek başına sahip oluyor.
- **F-4 PASS:** Reddedilen çağıran bayt okumuyor; gönderim, log, sayaç ve
  kota yan etkisi yok. Ancak R-1 durumunda B reddedilmiyor.
- **R-1:** Tek kanonik DB referansı güvenilir sahiplik kanıtı değildir;
  fix öncesi tüm dosyalar sidecar'sız olduğu için bu, mevcut verinin büyük
  bölümünü ilgilendirir. Üretim envanteri olmadan güvenli release
  kanıtlanamaz.

### 8.2 Neden PASS_WITH_NOTES değil?

PASS_WITH_NOTES, "güvenlik açığı kapandı; yalnızca kabul edilebilir
sınırlamalar var" demektir. Burada sınırlama kabul edilebilir değildir:
legacy durumda B, A'nın baytlarını okuyabiliyor ve gönderebiliyor. A'nın
normal bir kampanya silme işlemi bu durumu tetikleyebiliyor. Bu, not
düzeyinde bir kısıtlama değil, kiracı izolasyonunun mevcut dosyalar için
fiilen delinebilmesidir.

### 8.3 Neden RELEASE_BLOCKED, neden FAIL değil?

Yeni kod yolları (create/update/GET/dispatch) testleri geçiyor; engel,
mevcut legacy verinin güvenilir biçimde ayrıştırılamamasıdır. Legacy veri
durumunda gözlenen etki FAIL seviyesindedir; ancak release kararı
kategorisi, kodun yeni yolları değil veri kökeni güvenli release'i
engellediği için RELEASE_BLOCKED'dır. Bu ayrım, düzeltmenin yanlış
olduğunu değil, veri çalışması olmadan release'in kanıtlanamadığını
gösterir.

### 8.4 Release öncesi zorunlu kapılar (bu aşamada uygulanmadı)

1. Üretimdeki sidecar'sız dosya envanteri ve her dosya için kanonik referans
   sahiplerinin sayımı.
2. Sidecar'sız tüm dosyalar için fail-closed politikası veya operatör
   doğrulamalı sahiplik eşlemesi/backfill/claim akışı.
3. PostgreSQL üzerinde `_legacy_reference_owners` ve yetkilendirme
   sorgularının doğrulanması.
4. Gerçek gateway ile L4 E2E (en az yetkili sahip GET/dispatch ve yabancı
   tenant reddi).
5. Veri sahibi/operasyon onayı: meşru legacy erişiminin kaybı kabul edilecek
   mi, yoksa sahiplik geri kazanım akışı mı uygulanacak?

Bu kapılar kapatılmadan release güvenli kabul edilmemelidir.

---

## 9. Açık Kalan Riskler

| ID | Risk | Durum / release etkisi |
|---|---|---|
| R-1 | Sidecar'sız dosyada tek kanonik DB referansı güvenilir sahiplik kanıtı değil; fix öncesi saldırgan referansı gerçek sahibinkinden ayırt edilemiyor. | **Release blocker.** Probe S2/S3/S9 ile erişim gösterildi. |
| R-1a | A'nın kampanya silmesi/update-away'i B'nin kanonik referansını tek sahip bırakıyor. | **Release blocker.** Probe S3 + update-away. |
| R-1b | Sequence-step kanonik referansı aynı maruziyeti taşıyor. | **Release blocker.** Probe S9. |
| R-2 | A+B kanonik referansında fail-closed, meşru A'yı da reddediyor. | Kabul edilebilir güvenlik yönü; erişilebilirlik kaybı. |
| R-3 | PostgreSQL kanıtı yok; `cast(JSON, Text)` + `contains` davranışı doğrulanmadı. | Release öncesi kapatılmalı. |
| R-4 | Gerçek WhatsApp E2E (L4) yok; `start_conversation` mock. | Release öncesi kapatılmalı. |
| R-5 | Fix öncesi GET kimlik doğrulamasızdı; bilinen dosya kimlikleri release öncesi okunabiliyordu. | Mevcut sızıntı varsayımını güçlendirir; envanter gerekir. |
| R-6 | `looks_like_local_media_reference` harici URL'lerde yanlış pozitif verebilir. | Fail-closed; güvenlik açığı değil. |
| R-7 | Tam pakette 2 gateway testi `uuid` npm bağımlılığı eksikliğinden error veriyor. | Environment-blocked; başarı sayılmadı, 5.4.13 ile ilgisiz. |
| R-8 | `_normalize_tenant_id` tireleri kaldırıp küçük harfe çeviriyor; UUID dışı kimliklerde çakışma teorik olarak mümkün. | UUID kullanımıyla düşük risk; ayrıca incelenmedi. |

---

## 10. Aşama Sınırları ve Yapılmayanlar

- Uygulama, test, yapılandırma veya bağımlılık dosyası **değiştirilmedi**.
- Migration, backfill, veri temizliği, orphan cleanup veya kullanıcı verisi
  silme **yapılmadı**.
- `git reset`, `clean`, `stash`, `checkout`, `switch`, `rebase`, `merge`,
  `git add`, commit, push veya deploy **çalıştırılmadı**.
- PostgreSQL, production veya gerçek WhatsApp bağlantısı **kullanılmadı**.
- Yeni dosya yalnızca bu rapordur. Probe script'leri `/tmp` altındadır;
  repo'ya eklenmemiştir. Probe'un oluşturduğu geçici medya dosyaları yine
  probe tarafından temizlenmiştir.
- Başlangıç ve bitiş `git status` giriş sayısı aynıdır: **32**.

---

## 11. Sonuç

5.4.12'nin yeni yazma/GET/dispatch sertleştirmesi başarılıdır; F-1, F-2 ve
F-4 kanıtlanmıştır. Ancak F-3'ün legacy yolu ve R-1 kapatılmamıştır. Mevcut
veri modeli, sidecar'sız bir dosyanın gerçek yükleyenini kanıtlayamadığı için
tek kanonik DB referansı güvenilir sahiplik kanıtı olarak kullanılamaz.
Probe, bu durumda yanlış tenant'ın dosyaya erişebildiğini göstermiştir.

**Nihai karar: RELEASE_BLOCKED.**

Bu aşama yalnızca denetimdir. Kod düzeltmesi, yeni test, commit, push veya
deploy yapılmamıştır. Onay beklenmektedir.
