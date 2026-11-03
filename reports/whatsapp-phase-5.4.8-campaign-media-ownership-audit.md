# AŞAMA 5.4.8 — Campaign Medya Sahipliği: Referans Kapsamı ve Legacy Uyumluluk Denetimi

**Tarih:** 2026-11-03 (TRT)
**Kapsam:** 5.4.7 owner sidecar yetkilendirmesinin campaign sistemindeki TÜM medya referanslarını kapsayıp kapsamadığı
**Tür:** READ-ONLY AUDIT — ürün kodu, test, package veya konfigürasyonda değişiklik yok
**Çalışma alanı:** `/private/tmp/tz429-release`
**Sonuç:** **PASS_WITH_NOTES** (denetim tamamlandı; 5.4.7 modeli tüm referansları kapsamıyor — 2 MEDIUM, 3 LOW/operasyonel bulgu)

---

## 1. Yönetici Özeti

5.4.7 owner sidecar modeli, **HTTP GET** uç noktasını (`GET /api/v1/campaigns/media/{file_id}`)
güvenli biçimde korumaktadır: yeni yüklemelerde sahiplik yan dosyadan okunur, yetkisiz/bozuk
durumda fail-closed 404 döner, dosya açılmaz. Ancak model **bütün campaign medya kullanım
noktalarını kapsamamaktadır**:

1. **Gönderim/yeniden kullanım yolu sahiplik kontrolü yapmaz.** `get_campaign_media_base64`
   (`campaign_media_service.py:276-289`) yalnızca `media_url` alır ve diskten okur; `user_id`
   parametresi veya sahiplik doğrulaması yoktur. `OutreachManager` (`outreach_manager.py:162-171`)
   ve `CampaignRunner` (`campaign_runner.py:308-318`) bu yardımcıyı kullanır. Kampanya
   oluşturma/güncelleme (`campaigns.py:105-123`, `:139-155`) `media_url` değerini doğrulamadığı
   için, başka bir tenant'ın `camp_*` file ID'sini bilen bir kullanıcı bu dosyayı kendi
   kampanyasının medyası yapıp gönderebilir (bayt sızıntısı).
2. **Legacy fallback "referansla sahiplenilebilir".** Yan dosyası olmayan eski dosyalarda yetki,
   `Campaign.media_url` referansına dayanır (`campaigns.py:397-405`). `media_url` yazımda
   doğrulanmadığından, file ID'yi bilen bir tenant dosyayı kendi kampanyasına referanslayarak
   tek referans sahibi olabilir (eski sahibin kampanyası silinmişse **çapraz tenant okuma**) veya
   mevcut sahibin erişimini bozabilir (çok-tenant → fail-closed → **DoS**). Yeni (sidecar'lı)
   dosyalar bu iki saldırıdan etkilenmez.
3. **R-1 doğrulandı, ancak etkisi sınırlı:** Legacy yetkilendirme yalnızca `Campaign.media_url`
   alanını tarar; `Campaign.sequence_steps[].media_url` taranmaz (`campaigns.py:397-405`). Mevcut
   frontend step 1 medyasını campaign medyasıyla aynı yazar, takip adımlarına medya koymaz
   (`CampaignCreateWizard.tsx:724-756`); bu yüzden mevcut UI verisinde etki düşüktür. API/eski
   veri step-only medya içerebilir; production verisi incelenmedi → yaygınlık **UNKNOWN**.
4. **R-2 doğrulandı:** Yazma ve sidecar yazımı atomik değildir (`campaign_media_service.py:224`,
   `:228-235`). Crash pencerelerinde yetim dosya/sidecar oluşabilir; ancak hiçbir pencerede çapraz
   tenant sunumu veya ulaşılabilir yanlış sunum yolu yoktur. Retry yeni `uuid4` file ID üretir.
5. **Operasyonel:** Kampanya silme medya dosyalarını/sidecar'ları temizlemez (`campaigns.py:159-174`,
   `:177-201`); uygulama yedeği `/app/media` (gateway) alır, campaign yüklemeleri `/app/uploads`
   yedek kapsamı dışındadır (`backups_admin_service.py:293-302`). Production'da `/app/uploads`
   kalıcı volume'dur (`docker-compose.prod.yml:68-69`), staging'de değildir.

**Net cevap:** 5.4.7 owner sidecar modeli campaign medya referanslarının **tamamını güvenli ve
geriye dönük uyumlu biçimde KAPSAMIYOR.** HTTP GET korunuyor; dispatch/reuse ve legacy-referans
yolları korunmuyor.

---

## 2. Başlangıç Git Durumu

| Alan | Değer |
|---|---|
| `pwd` | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Staged | 0 |
| Modified | 12 |
| Untracked giriş | 16 (biri `reports/` klasörü) |

**Modified (12):** `campaigns.py`, `whatsapp.py`, `campaign_media_service.py`, `link_preview/service.py`,
`messaging.py`, `whatsapp_gateway.py`, `test_campaign_media.py`, `test_whatsapp_live.py`,
`package.json`, `index.js`, `media-store.js`, `session-manager.js`.

**Untracked:** `reports/`, `test_campaign_media_auth.py`, `test_link_preview_media_tenant_isolation.py`,
`test_whatsapp_media_tenant_isolation.py`, `media-routes.js`, 4 test loader/register, `tests/stubs/`,
5 medya test süiti, `test-media-session-dedupe-547.mjs`.

Bu denetimde yalnızca okuma yapıldı; `git add/commit/push/deploy`, `reset/clean/stash/checkout/
rebase/merge` kullanılmadı; dependency kurulmadı; production/PostgreSQL/gerçek WhatsApp/gerçek
medya klasörü kullanılmadı; test çalıştırılmadı (yeni artefakt üretmemek için).

---

## 3. Campaign Medya Referans Envanteri

| # | Referans türü | DB konumu | Owner alanı | File ID çözümü | Sidecar? | Fallback | Yetki doğrulaması | 5.4.7 GET kapsıyor mu? |
|---|---|---|---|---|---|---|---|---|
| R1 | Campaign ana medyası | `campaigns.media_url` (`campaign.py:49`), `media_type`, `media_filename` | `campaigns.user_id` (`campaign.py:22`) | URL içinden `camp_{16hex}` regex (`campaign_media_service.py:281`) | Yeni yüklemelerde var; eski yok | Legacy: `Campaign.media_url.contains(file_id)` tek-tenant (`campaigns.py:397-405`) | HTTP GET: `_authorize_campaign_media`; dispatch: **YOK** | **Evet** |
| R2 | Sequence step medyası | `campaigns.sequence_steps` JSON (`campaign.py:55`), her adımda `media_url` (`schemas/campaign.py:12`) | `campaigns.user_id` (adım ayrı owner taşımaz) | Aynı regex (`get_campaign_media_base64`) | Yeni yüklemelerde var; eski yok | **YOK** (legacy tarama yalnız `Campaign.media_url`) | HTTP GET: yalnız campaign.media_url eşleşirse; dispatch: **YOK** | **Kısmi / R-1** |
| R3 | Campaign template/mesaj içeriği | `campaigns.message_template` (Text) | `campaigns.user_id` | Medya referansı yok (yalnız metin) | — | — | — | N/A |
| R4 | Upload çıktısı | HTTP yanıtı (`file_id`, `media_url`) `campaign_media_service.py:237-244` | Sidecar `{"user_id"}` (`:166-168`) | Doğrudan `file_id` | Var | — | Yükleme `get_current_user` (`campaigns.py:352-361`) | **Evet** (yeni dosyalar) |
| R5 | Medyayı okuyan HTTP uç noktası | — | — | `get_media_file_info` (`campaign_media_service.py:247-273`) | Okuma sırasında doğrulanmaz | — | Yalnız çağıran endpoint'te | **Evet** (yalnız GET) |
| R6 | Medyayı gönderen servisler | — | Campaign'ten `user_id` | `get_campaign_media_base64` (`:276-289`) | **Kontrol yok** | — | **YOK** | **Hayır** |
| R7 | Mesaj geçmişi | `message_logs.media_url` (`message_log.py:38`) | `message_logs.user_id` | Yalnız tarihsel string; byte servisi değil | — | — | Analytics `get_user_filter` (`analytics.py:25`) | N/A (erişim yolu değil) |
| R8 | Temizleme/silme | — | — | **Akış yok.** Campaign delete yalnız DB satırlarını siler (`campaigns.py:159-174`, `:177-201`) | — | — | — | N/A |
| R9 | Harici URL medyası | `campaigns.media_url` / step `media_url` http(s) | `campaigns.user_id` | Backend base64 üretmez; gateway'e URL geçer (`session-manager.js:1505-1566`, `message-classifier.js:501-505`) | — | — | Tenant sahipliği yok (harici kaynak) | N/A (kapsam dışı, INFO) |

**Kanıt notları:**
- Mevcut frontend tek bir medya yükler ve `media_url`'yi hem kampanyaya hem step 1'e yazar;
  takip adımlarında medya alanı yoktur (`CampaignCreateWizard.tsx:724-756`).
- `CampaignResponse`, `media_url`'yi yalnız kendi tenant'ına döner (liste `get_user_filter`,
  `campaigns.py:95-101`); frontend bunu yalnız rozet olarak gösterir (`CampaignCard.tsx:115-125`),
  doğrudan `<img src>`/`href` ile indirmez → 5.4.7 auth eklenmesi mevcut UI önizlemesini bozmaz.
- `message_logs.media_url` yalnız analitik/liste yanıtlarında görünür; byte sunmaz.

---

## 4. R-1 — Legacy Medya Erişim Kaybı (Ayrıntılı)

**Mekanizma.** `_authorize_campaign_media` (`campaigns.py:374-413`) sidecar yoksa `legacy` kabul
eder ve yalnız şu sorguyu çalıştırır:

```python
select(Campaign.user_id).where(
    Campaign.media_url.isnot(None),
    Campaign.media_url.contains(file_id),
)
```

`sequence_steps` bu sorguda yoktur. Dolayısıyla bir dosya yalnız bir sequence adımının
`media_url`'sinde geçiyorsa (campaign.media_url boş), `rows` boş döner → `False` → **404**.

**Sorulara yanıtlar:**

| Soru | Yanıt | Kanıt |
|---|---|---|
| Bu dosyalar gerçekten kullanımda mı? | Mevcut UI üretmiyor (step 1 = campaign medyası; takip adımları medyasız). API/eski/migre veri üretebilir. Production verisi incelenmedi → **UNKNOWN** | `CampaignCreateWizard.tsx:724-756`; `schemas/campaign.py:12` |
| Hangi servisler okuyor? | `CampaignRunner` step medyasını `get_campaign_media_base64` ile okur ve gönderir | `campaign_runner.py:268, 308-318` |
| 5.4.7 hangi durumda 404 döndürür? | Sidecar yok + `Campaign.media_url` referansı yok → legacy sorgu boş → 404 | `campaigns.py:390-410` |
| Aynı dosyaya birden fazla tenant referans verebilir mi? | Evet: create/update `media_url`'yi doğrulamaz; herhangi bir tenant URL'yi kopyalayabilir | `campaigns.py:105-123, 139-155`; `test_campaign_media.py:105-124` |
| Sequence kaydı üzerinden güvenilir sahiplik kurulabilir mi? | Tek başına hayır; sequence satırı `user_id` taşır ama medya sahipliğinin kanıtı değildir ve referans yine istemci yazımıdır | `campaign_sequence_lead.py:27` |
| Campaign–sequence ilişkileri yeterince güvenilir mi? | Kampanya sahipliği güvenilir (`check_entity_ownership`); fakat medya referansının o kampanyaya ait olduğu doğrulanmıyor | `auth.py:234-247` |
| Güvenli backfill mümkün mü? | Evet, ama yalnız tek-tenant ve doğrulanmış referanslarda; belirsizlik fail-closed kalmalı. Backfill'in kendisi istemci yazımı referanslara dayanacağı için operatör onayı gerekir | §8 Seçenek B |

**Etki:** Yalnız **kullanılabilirlik** (doğru sahibin 404 alması). Tenant izolasyonunu gevşetmek
yasak olduğundan öneri, sequence referanslarını **sahiplik çözümlemesine eklemek**, fallback'i
gevşetmek değildir.

**Severity: LOW–MEDIUM** (mevcut UI verisinde düşük; API/migre veride orta; yaygınlık UNKNOWN).

---

## 5. R-2 — Owner Sidecar Yazımı ve Crash Güvenliği

**Sıra:** içerik doğrulama → `target_path.write_bytes(content)` (`campaign_media_service.py:224`)
→ `_write_media_ownership` (`:229`) → yanıt (`:237-244`). Atomik temp+rename veya `fsync` yoktur.

| # | Crash noktası | Dosya kalır? | Sidecar kalır? | Yetkiliye sunulur? | Başka tenant'a? | Retry | Temizlik |
|---|---|---|---|---|---|---|---|
| 1 | Dosya yazılmadan önce | Hayır | Hayır | — | — | Yeni `uuid4` ID | — |
| 2 | Dosya yazımı sırasında | **Kısmi** | Hayır | Hayır (referans yok) | Hayır (legacy sorgu boş) | Yeni ID | **Yok** (ENOSPC/istisna dosyayı silmez) |
| 3 | Dosya bitti, sidecar yok | Evet | Hayır | Hayır (client ID'yi bilmez) | Hayır (legacy sorgu boş) | Yeni ID → yetim | Yok |
| 4 | Sidecar yazımı sırasında | Evet | **Kısmi/bozuk** | Hayır (`corrupt` → fail-closed) | Hayır | Yeni ID → yetim | Yok |
| 5 | Sidecar bitti, yanıt öncesi | Evet | Evet (sahip doğru) | Yalnız ID bilinirse | Hayır | Yeni ID → mükerrer | Yok |
| 6 | Yanıt gönderilmeden | = 5 | = 5 | = 5 | = 5 | = 5 | = 5 |

**Değerlendirme:**
- `read_media_ownership` bozuk/eksik ayrımını doğru yapar: eksik → `legacy`, bozuk → `corrupt`
  (`campaign_media_service.py:141-163`); bozuk sidecar asla legacy sayılmaz.
- **Çapraz tenant sunumu yok:** Sidecar'sız dosyanın campaign referansı da yoktur (yanıt
  dönmediği için client `file_id` bilmez); legacy sorgu boş → 404.
- **Yetim birikimi var:** Crash (özellikle #2–#6) ve ENOSPC sonrası dosya kalır; startup süpürme
  yoktur. `write_bytes` istisnası yalnız sidecar hatasında (`:228-235`) dosyayı siler, yazma
  hatasında silmez.
- **Retry aynı ID'yi üretmez:** `file_id = camp_{uuid4().hex[:16]}` (`:219`) her denemede yenidir;
  aynı-ID çakışması pratikte imkânsızdır (mükerrer dosya oluşur).
- **Temizlik kapsamı:** Tek `unlink(target_path)`; başka dosyalara dokunmaz (`:231`).

**Severity: LOW** (çapraz tenant riski yok; disk birikimi + latent legacy kabulü).
Not: A-3 (crash/legacy kabulü) bu fazda çözülmedi; 5.4.5/5.4.3 bütünlük testleri etkilenmediğini
gösteriyor (önceki faz kanıtı).

---

## 6. Tenant İzolasyonu Değerlendirmesi

| Yol | Durum | Gerekçe |
|---|---|---|
| GET, yeni (sidecar'lı) dosya | **GÜÇLÜ** | Sidecar sahibi eşleşmezse 404; bozuk sidecar fail-closed; dosya açılmaz |
| GET, legacy dosya (tek referans) | **KOŞULLU** | Referans istemci yazımıdır; file ID bilen tenant referans ekleyerek sahiplenebilir/poison edebilir |
| GET, legacy dosya (çok referans/NULL) | **GÜVENLİ (fail-closed)** | Herkes için 404 |
| Dispatch/reuse (`get_campaign_media_base64`) | **ZAYIF** | Sahiplik kontrolü yok; bilinen file ID ile çapraz tenant bayt okuma/gönderme |
| Campaign create/update referans girişi | **DOĞRULANMAMIŞ** | `media_url`/`sequence_steps` serbest string/JSON |
| Upload | **GÜÇLÜ** | Auth + sidecar; sidecar yazılamazsa dosya silinir |
| Mesaj geçmişi (`message_logs.media_url`) | **N/A** | Byte servis yolu değil; sorgular `get_user_filter` ile kapsamlı |

**Sonuç:** Yeni dosyalar için HTTP yüzeyi güçlüdür; ancak tenant izolasyonu, **file ID gizliliğine**
dayanan dolaylı yollar (dispatch + legacy claim) nedeniyle uçtan uca garanti edilmez.

---

## 7. Mevcut Test Kapsamı ve Eksikler

**Mevcut kapsam:**

| Test | Kapsadığı | Kanıt |
|---|---|---|
| `test_campaign_media_auth.py` (10 test) | Auth yok/geçersiz/boş kullanıcı; sahip erişimi; diğer tenant 404 + dosya açılmadı; bilinmeyen 404; legacy tek-tenant; legacy çok-tenant; bozuk sidecar; sidecar sahip kaydı | `pytest` (5.4.7'de 23 passed) |
| `test_campaign_media.py` | Upload/GET/base64; MIME sniff; legacy XSS; create ile keyfi `media_url` kabulü | `:39-124`, `:192-239` |
| `test_campaign_sequence_drip.py` | Sequence yaşam döngüsü — **medya yok** | `:23-60` |
| Gateway medya süitleri | Store/route/atomicity/dedupe — campaign sahipliği ile ilgisiz | 5.4.3–5.4.7 |

**Eksik senaryolar (denetim bulgusu):**

| # | Senaryo | Kapsanıyor mu? | Not |
|---|---|---|---|
| T1 | Sequence medyasına yetkili tenant erişimi | **Hayır** | GET, campaign.media_url eşleşmesine bağlı |
| T2 | Başka tenant'ın sequence medyasına erişimi | **Hayır** | Legacy claim senaryosu test edilmiyor |
| T3 | Aynı dosyaya birden fazla tenant referansı (yeni/dosya sidecar'lı) | Kısmi | Legacy çok-tenant var; sidecar'lı çok-referans GET'i yok |
| T4 | Sidecar'sız eski sequence medyası | **Hayır** | R-1 |
| T5 | Bozuk owner sidecar | **Evet** | `test_campaign_media_auth.py:234-245` |
| T6 | Upload sırasında crash / kısmi dosya | **Hayır** | R-2 |
| T7 | Sidecar öncesi crash | **Hayır** | R-2 |
| T8 | Retry / aynı file ID çakışması | **Hayır** | `uuid4` nedeniyle aynı-ID pratikte yok; mükerrer dosya testi yok |
| T9 | Yetkisiz istekte dosyanın açılmaması | **Evet** | `get_media_file_info` spy |
| T10 | Kampanya create/update'te yabancı `media_url` reddi | **Hayır** | Mevcut test keyfi ID'yi 201 ile kabul ediyor (`test_campaign_media.py:105-124`) |
| T11 | Dispatch'in yabancı medyayı göndermemesi | **Hayır** | `get_campaign_media_base64` sahiplik parametresi almıyor |
| T12 | Legacy referans poisoning / claim | **Hayır** | R-1/R-2 dışı, AUD-2 |

---

## 8. Çözüm Seçenekleri (uygulanmadı — yalnız değerlendirme)

### Seçenek A — Sahiplik zorlamasını tüm çözümleme noktalarına yay + referans girişini doğrula

- `get_campaign_media_base64` yerine `user_id` alan yetkili bir çözümleyici; dispatch yolları
  (`outreach_manager.py:163`, `campaign_runner.py:310`) campaign sahibiyle çağırır; yerel `camp_*`
  dosyası sahibe ait değilse gönderim fail-closed (metne sessiz düşüş yok).
- `CampaignCreate/Update` ve `sequence_steps` için `media_url` doğrulaması: yalnız http(s) veya
  çağıranın sahip olduğu/legacy olarak çözülebilen yerel `camp_*` URL'si.
- Legacy fallback'e `sequence_steps[].media_url` taraması eklenir (R-1).
- **Güvenlik:** Yüksek (dispatch + claim kapanır). **Legacy uyum:** Orta-yüksek.
  **Veri kaybı:** Yok. **Geriye uyum:** Yüksek. **Migration:** Yok. **Test:** T1–T4, T10–T12.
  **Karmaşıklık:** Orta. **Risk:** Legacy medya için yanlış-negatif (fail-closed) olabilir.

### Seçenek B — Güvenilir DB ilişkilerinden kontrollü ownership backfill

- Sidecar'sız dosyalar için `Campaign.media_url` + `sequence_steps` taranır; **tek** tenant
  referansı varsa owner sidecar yazılır; çok-tenant/NULL → legacy kalır (fail-closed).
- **Güvenlik:** Orta (legacy claim/ambiguity azalır) — ancak referanslar istemci yazımı olduğu
  için backfill öncesi saldırgan claim'i mümkündür; operatör onayı/audit log gerekir.
  **Legacy uyum:** Yüksek. **Veri kaybı:** Yok. **Geriye uyum:** Yüksek.
  **Migration:** **Evet** (tek seferlik script/job, idempotent). **Test:** idempotency, ambiguity,
  dry-run. **Karmaşıklık:** Orta-yüksek (SQLite JSON1 / PostgreSQL JSONB farkı).

### Seçenek C — Crash-safe publish sırası + yetim süpürme

- Temp dosya + `fsync` → sidecar (temp+`fsync`) → atomik `rename` → dizin `fsync`; açılışta
  yetim/yarım dosya süpürmesi; ENOSPC'de dosya temizliği; isteğe bağlı campaign-delete medya
  temizliği/retention.
- **Güvenlik:** Nötr-pozitif (mevcut çapraz tenant yolu yok; bütünlük dayanıklılığı artar).
  **Legacy uyum:** Yüksek. **Veri kaybı:** Düşük. **Geriye uyum:** Yüksek.
  **Migration:** Yok. **Test:** T6–T8 crash simülasyonu. **Karmaşıklık:** Orta.

### Karşılaştırma

| Kriter | A | B | C |
|---|---|---|---|
| Çapraz tenant dispatch açığını kapatır | **Evet** | Kısmi | Hayır |
| Legacy claim/poison'ı kapatır | **Evet** | Kısmi | Hayır |
| R-1 legacy sequence uyumluluğu | **Evet** | **Evet** | Hayır |
| Migration gerekir | Hayır | **Evet** | Hayır |
| Uygulama karmaşıklığı | Orta | Orta-yüksek | Orta |
| Önerilen sıra | **1** | 2 (operatör onaylı) | 1 (paralel) |

---

## 9. Önerilen Sonraki Kodlama Aşamasının Kapsamı

1. **A (zorunlu):** `get_campaign_media_base64` → `user_id` alan yetkili çözümleyici; dispatch
   yollarında sahiplik zorlaması; yerel dosya sahibi değilse fail-closed.
2. **A (zorunlu):** `CampaignCreate/Update` + `sequence_steps` için `media_url` sahiplik/format
   doğrulaması (http(s) veya çağıranın yerel dosyası).
3. **A (R-1):** Legacy fallback'e sequence adım referanslarını ekle; belirsizlikte fail-closed kal.
4. **C (önerilen):** Atomik yayın (temp+fsync+rename), ENOSPC temizliği, açılış yetim süpürmesi.
5. **B (ayrı, operatör onaylı):** Tek seferlik backfill; dry-run + audit log + idempotency.
6. **Testler:** T1–T4, T6–T8, T10–T12.

**Kapsam dışı bırakılmalı:** çoklu-instance dağıtık kilit, harici URL SSRF sertleştirmesi (ayrı
güvenlik işi), genel auth mimarisi, WhatsApp geçmiş senkronizasyonu.

---

## 10. Açık Riskler

| ID | Risk | Severity | Etki | Kanıt |
|---|---|---|---|---|
| **AUD-1** | Dispatch/reuse sahiplik kontrolü yok; bilinen file ID ile çapraz tenant bayt sızıntısı | **MEDIUM** | 5.4.7 GET koruması atlanır; medya WhatsApp ile saldırganın alıcısına gidebilir | `campaign_media_service.py:276-289`; `outreach_manager.py:162-171`; `campaign_runner.py:308-318`; `campaigns.py:105-123,139-155` |
| **AUD-2** | Legacy fallback referansla sahiplenilebilir/poison edilebilir | **MEDIUM** | Eski sahibin kampanyası silinmişse çapraz tenant okuma; aksi halde sahibine 404 (DoS) | `campaigns.py:374-413`; `campaigns.py:159-174` (silme dosyayı bırakır) |
| **AUD-3 (R-1)** | Sequence-step-only legacy medya yetkilendirilmez | **LOW–MEDIUM** | Doğru sahibe 404; mevcut UI verisinde düşük, API/migre veride orta; yaygınlık UNKNOWN | `campaigns.py:397-405`; `CampaignCreateWizard.tsx:724-756` |
| **AUD-4 (R-2)** | Atomik olmayan yazma, crash/ENOSPC yetimleri, süpürme yok | **LOW** | Disk birikimi; çapraz tenant yolu yok | `campaign_media_service.py:219-235` |
| **AUD-5** | Campaign delete medya temizlemez; backup `/app/uploads`'u kapsamaz; staging'de uploads volume yok | **LOW** (DR'ye göre MEDIUM) | Yetim birikimi; felaket kurtarmada medya/sidecar kaybı | `campaigns.py:159-201`; `backups_admin_service.py:293-302`; `docker-compose.prod.yml:68-69`; `docker-compose.staging.yml` |
| **INFO-1** | Harici `media_url` gateway/Baileys tarafından fetch edilir (SSRF yüzeyi) | INFO | Kapsam dışı, önceden var; sahiplik modeliyle ilgisiz | `session-manager.js:1505-1566`; `message-classifier.js:501-505` |
| **INFO-2** | 5.4.7 sidecar'ı mesaj geçmişi/analitik ile ilişkili değil | INFO | Erişim yolu değil | `message_log.py:38`; `analytics.py:25` |

**Not:** Bu denetimde gerçek production verisi, PostgreSQL veya gerçek WhatsApp hesabı
kullanılmadı; legacy medya yaygınlığı ve gerçek kampanya kayıtları doğrulanmadı. Bu nedenle
AUD-3'ün sahadaki etkisi **UNKNOWN** olarak bırakılmıştır.

---

## 11. Bitiş Git Durumu

| Alan | Başlangıç | Bitiş | Durum |
|---|---|---|---|
| `pwd` | `/private/tmp/tz429-release` | `/private/tmp/tz429-release` | Aynı |
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` | Aynı |
| HEAD | `978ddf5...` | `978ddf5...` | **Aynı** |
| Staged | 0 | 0 | Aynı |
| Modified | 12 | 12 | Aynı |
| Untracked giriş | 16 | 16 (yalnız `reports/` içine bu rapor eklendi) | Aynı |

Ürün kodunda, testlerde, package dosyalarında ve konfigürasyonda **değişiklik yoktur**. Yeni
oluşturulan tek dosya bu rapordur. Commit/push/deploy yapılmadı; sonraki aşamaya geçilmedi.

---

## 12. Sonuç

Denetim tamamlandı. 5.4.7 owner sidecar modeli HTTP GET yüzeyinde güçlüdür, ancak campaign medya
referanslarının tamamını güvenli ve geriye dönük uyumlu biçimde kapsamamaktadır: dispatch/reuse
yolu sahiplik doğrulamaz (AUD-1), legacy fallback referansla sahiplenilebilir (AUD-2), sequence
referansları legacy çözümlemede yoktur (AUD-3), yazma atomik değildir (AUD-4) ve medya yaşam
döngüsü/backup kapsamı eksiktir (AUD-5). Bunların hiçbiri BLOCKER değildir; AUD-1 ve AUD-2
MEDIUM'dur ve file ID bilgisi ön koşuluna bağlıdır.

**NİHAİ KARAR: PASS_WITH_NOTES**
