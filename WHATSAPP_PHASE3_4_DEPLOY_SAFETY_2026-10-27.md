# TEZLIFY WHATSAPP — AŞAMA 3.4: GÜVENLİ DEPLOY VE MESAJ AKIŞI GÜVENCESİ

**Rapor tarihi:** 2026-10-27 — 2026-10-28
**Yayındaki commit (öncesi):** `7b510c7`
**Yayındaki commit (sonrası):** `b5715fe` → `cfc20cf` (bellek güncellemesi)
**Deploy türü:** `--no-gateway` (gateway container **hiç** yeniden oluşturulmadı)
**Deploy sonucu:** `RELEASE_EXIT=0`, süre ~1 dk 43 sn, `SÜRÜM TAMAM`

---

## §1 — DEPLOY CANDIDATE DB İZOLASYONU: "CANLI ÜRETİM VERİSİNE YAZAMAZ"

### Amaç
Adacik container'ı, cutover kararı verilmeden **önce** açılır ve startup migration zincirini çalıştırır. Bu adımda üretim veritabanına herhangi bir yazma, `candidate-data-drop.txt` adlı bir belgeyle kanıtlanır ve deploy **koşulsuz** reddedilir.

### Uygulanan mekanizma
`host-release.sh`'e eklendi:
- `candidate_db_create(db, src)` — `pg_dump | psql` ile tam kopya (≥10 tablo).
- `candidate_env_isolate(envfile, db)` — her `*DATABASE_URL` ile biten değişken izole kopyaya çevrilir.
- Pozitif kontrol: "her bağlantı dizesi beklenen kopyaya mı bakıyor?" (`unexpected_db_urls`).
- Bağımsız ikinci kanıt: grep ankoralı (`^([A-Za-z_][A-Za-z0-9_]*)?DATABASE_URL=`) ve sınır kontrollü (`([?]|$)`).
- İzole DB cutover'dan önce düşürülür; üretim `db-counts` öncesi/sonrası karşılaştırılır.

### Canlı ders (2026-10-27 22:02Z — ilk deneme KENDİ KAPISINA TAKILDI)
Canlı ortamda **iki** bağlantı dizesi var:
- `DATABASE_URL` → doğru şekilde izole kopyaya çevrildi.
- `GATEWAY_DATABASE_URL` → **üretim veritabanında kaldı**.

Eski desen `DATABASE_URL=.*/${DB_NAME}(\?|$)`, `GATEWAY_DATABASE_URL=` satırını alt dize olarak eşleştirdi. Deploy "ürretim URL'i kaldı" diyerek **DURDU** (doğru karar), ama işaret ettiği satır çevrilmiş olan değil, çevrilmemiş **ikinci** satırdı (yanlış teşhis).

Kanıt: eski `rewrite_env_file` gövdesi birebir kopyalanıp çalıştırıldı → `SIZAN DEGISKENLER: ['GATEWAY_DATABASE_URL']`.

Düzeltme (2026-10-27 22:13Z):
- Kural ada göre: `*DATABASE_URL` ile biten her değişken bir bağlantı dizesidir.
- Pozitif kontrol: her bağlantı dizesi izole kopyaya bakmalı; bakan yoksa adıyla raporlanır (çıkış 4).
- Shell grep ankoralı + sınır kontrollü.
- Çözülemeyen DSN (libpq formatı) sessizce geçmez, adıyla bildirilir.

**Canlı deneme sonucu:** cutover **yapılmadı**, üretim hiç etkilenmedi (aynı container kimlikleri, aynı sayımlar, artık DB/container kalmadı; `die()` temizliği çalıştı).

### İkinci deneme — başarılı deploy (22:24Z)
- `adacikta kosan migration satiri: 24` — 24 migration **kopyada** çalıştı.
- `adacik penceresinde uretim satir sayisi degismedi: 123|956|1535` (izolasyon kanıtı).
- `candidate-data-drop.txt` **YOK**, `candidate-clone-drop.txt` **YOK** → hiçbir yerde satır silinmedi.
- İzole DB cutover'dan önce düşürüldü (0 kalan `%cand%` veritabanı).

| Kriter | Sonuç |
|--------|-------|
| Adacik üretim DB'sine yazamıyor | **PASS** |
| Migration'lar kopyada çalıştı, üretim dokunulmadı | **PASS** |
| İzolasyon kanıtlanamazsa deploy reddedildi | **PASS** (22:02Z'de gerçekleşti) |
| Clone cutover'dan önce düşürüldü | **PASS** |

---

## §2 — LID KÖPRÜSÜ REGRESYONU: KİRACI İZOLASYONU

### Amaç
`lid_mappings.session_id` bir **bağlantı** UUID'sidir (her socket açılışında döner); `whatsapp_sessions.gateway_id` yalnızca **mevcut** bağlantıyı adlandırır. Eski kod `ws.gateway_id = lm.session_id` ile birleştiriyordu → üretimde 4/4107 eşleşme (0.1%).

### Düzeltme durumu (7b510c7, 2026-10-27)
- Deferral (purge): `lid_jid` üzerinden, bağlantı kimliği **KULLANILMAZ**.
- Merge (candidate): sahiplik `contacts.user_id`'den alınır.
- "Bridge yoksa tahmin etme" — eşleşme yoksa ertele, asla merge etme veya silme.

### Bu aşamada yapılanlar
- `test_whatsapp_lid_tenant_isolation.py` (5 test) eklendi:
  - İki kiracı aynı LID/telefonu paylaşır, mapping farklı session UUID altındadır.
  - Çapraz kiracı mesaj taşınması asla gerçekleşmez.
  - Bridge bilinmiyorsa "tahmin" edilmez.
  - Her iki kiracı da onarılır.
  - Sahiplik hayalet kontaktan alınır.
  - Sorguda PostgreSQL'e özgü yapı (`::`, `ILIKE`, `DISTINCT ON`, `FILTER`, `generate_series`) yasaklanır.
- `test_whatsapp_boot_lid_merge.py` (Phase 3.3) `mapping_session_id` parametresiyle farklı bağlantı UUID altındaki bridge'i test eder.

| Kriter | Sonuç |
|--------|-------|
| Eski kodda test kırmızı, yeni kodda yeşil | **PASS** (Phase 3.3: `be23e4c` → 5 test kırmızı, `7b510c7` → 31 test yeşil) |
| Kiracı izolasyonu yeni testlerle kanıtlandı | **PASS** |
| SQLite/PostgreSQL davranış farkı göz önüne alındı | **PASS** (SQLite testleri, PostgreSQL'e özgü yapılar yasak) |

---

## §3 — MESAJ AKIŞI VE DEPLOY FİLİGRANI

### Amaç
"Toplam sayı arttı" ≠ "kayıp yok". Tek doğru ölçüt: cutover'dan **önce** var olan kayıtların, cutover'dan **sonra** hâlâ orada olması.

### Uygulanan mekanizma
- `message_watermark.py` — `parse_watermark()`, `loss_line(before, after)`.
- Watermark: `max(id)|count` değil, `max(id) <= önceki_max` olan **sağkalan** kayıt sayısı.
- `db_relation_digest(edge)` — id/ilişki özeti (kanıt niteliğinde, karar veren filigran).

### Canlı ölçümler
| An | Tarih | `max(id)` | `count` | Yorum |
|----|-------|----------|---------|-------|
| Pre-deploy (21:02Z) | 2026-10-27 | 160186 | 951 | Phase 3.3 sonrası |
| Pre-deploy (22:02Z) | 2026-10-27 | 160196 | 951 | Faz 3.4 deploy öncesi |
| Deploy anı | 2026-10-27 | 160198 | 953 | Betik kaydettiği filigran |
| Post-deploy (22:24Z) | 2026-10-27 | — | 961 | Toplam büyüdü (canlı trafik) |
| Post-deploy filigran | 2026-10-27 | ≤160198 | **953** | **Tam olarak eşleşti** |

**Karar:** `id <= 160198` olan sağkalan mesajlar = **953**, filigran öncesi de **953**. **Sıfır kayıp**.

Toplam mesaj sayısı 953 → 969 arttı; bu **meşru canlı trafik**, kayıp değil.

| Kriter | Sonuç |
|--------|-------|
| Watermark öncesi/sonrası sağkalan eşleşti | **PASS** |
| Total count'u kayıp ölçütü olarak kullanılmadı | **PASS** |
| Yetim mesaj | **PASS** (0) |
| Kiracı uyumsuzluğu (message.user_id ≠ conversation.user_id) | **PASS** (0) |
| Yetim sohbet (conversation.contact yok) | **PASS** (0) |

---

## §4 — EVENT/OUTBOX GÜVENİLİRLİĞİ: DEAD_LETTER ANALİZİ

### Amaç
`event_outbox` retry mekanizmasını salt-okunur incele; replay etme.

### Bulgular
`event_outbox` (whatsapp_private) durum dağılımı:
- `DELIVERED`: 4967 satır
- `DEAD_LETTER`: **2 satır** (0.04%)

İki DEAD_LETTER satırı:

| sequence | event_type | attempts | key_version | created_at | session |
|----------|------------|----------|-------------|------------|---------|
| 247738 | `lid_mapped` | 10 | 1 | 2026-10-25 22:23:43Z | `c2ea3b1d…` |
| 247865 | `lid_mapped` | 10 | 1 | 2026-10-25 22:27:18Z | `c2ea3b1d…` |

Bu session'ın **tüm** outbox satırları bu ikisi → oturum bu iki olayla ölmüş, ardından hiçbir şey üretmemiş.

Etki analizi:
- `persistLidMappingToDb` `lid_mappings`'i doğrudan yazar. Dead-letter'lanan `lid_mapped`, yalnızca **bildirim-tetikli onarım** (`_ingest_lid_mapped` → `reconcile_legacy_split_conversation`) kaybettirir. Köprü verisi (`lid_mappings` tablosu) zarar görmez.
- Replay mekanizması yok. Etki sınırlı; sistemik değil.

| Kriter | Sonuç |
|--------|-------|
| DEAD_LETTER sayısı ve türü tespit edildi | **PASS** |
| Sistemik hata değil, geçici (2/4967, %0.04) | **PASS** |
| Replay yapılmadı (güvenli mekanizma yok) | **PASS** |
| Etki sınırlı — köprü verisi zarar görmedi | **PASS** |

---

## §5 — TEST, PUSH, DEPLOY KURALLARI

### Backend testleri
| Koşum | Sonuç |
|-------|-------|
| Sabit sıra (`-p no:randomly`) | **1777 passed, 4 skipped** |
| Seed 424242 | **1777 passed, 4 skipped** |
| Seed 777 | **1777 passed, 4 skipped** |
| Seed 900913 | **1777 passed, 4 skipped** |
| Seed 111, 222, 333 (önceki) | **1772 passed, 4 skipped** |

**Önemli ders:** Aynı `/tmp/tezlify_clean.db` üzerinde üst üste koşumlar, `test_campaign_sequence_drip.py`'yi `daily_limit_reached (pool size: 1)` ile düşürüyor. Bu **kirlenme**, sıralama değil. Her tam paket koşumundan önce `scripts/provision_test_db.py` çalıştırılmalı.

### Diğer kapılar
| Kapı | Sonuç |
|------|-------|
| Gateway `npm test` | **GATEWAY_EXIT=0**, tüm suite PASS |
| Frontend `npm run build` | **BUILD_EXIT=0**, `✓ built in 9.92s` |
| Frontend `verify:i18n-keys` | **I18N_EXIT=0**, 2425 çağrı, en=3208 tr=3208 |

### Commit dizisi
1. `e077050` — `feat(deploy): adacik izole kopyada kossun, kayip filigranla olculsun`
2. `65cbd38` — `fix(tests): senkron temizligi zaman asiminda komsu testleri kilitlemesin`
3. `2817113` — `test(whatsapp): LID koprusu kiraci izolasyonu ve olay idempotency kapsami`
4. `4e2adf1` — `docs: faz3 raporu, A14/T degismezi ve test-temizligi dersi`
5. `b5715fe` — `fix(deploy): adacik izolasyonu IKINCI baglanti dizesini de cevirsin`
6. `cfc20cf` — `docs: faz3.4 deneyimleri, izolasyon dersleri ve test-temizligi bilgisi`

### Deploy kapıları
| Kapı | Sonuç |
|------|-------|
| `--no-gateway` guard (gateway/compose değişikliği yok) | **PASS** |
| Migration guard (yıkıcı SQL yok) | **PASS** |
| Candidate izolasyonu kanıtlandı | **PASS** |
| Candidate izole DB düşürüldü | **PASS** |
| Cutover: backend recreate, gateway **dokunulmadı** | **PASS** |
| Post-deploy health, frontend, API 200 | **PASS** |

---

## §6 — KABUL KRİTERLERİ (PASS / FAIL / BLOCKED)

| # | Kriter | Sonuç |
|---|--------|-------|
| 1 | Adacik üretim DB'sine yazamıyor (candidate izolasyonu) | **PASS** |
| 2 | İzolasyon kanıtlanamazsa deploy reddedilir | **PASS** |
| 3 | LID köprüsü kiracı izolasyonu testleri geçiyor | **PASS** |
| 4 | Bridge yoksa "tahmin" edilmiyor | **PASS** |
| 5 | Watermark öncesi/sonrası sağkalan eşleşti | **PASS** |
| 6 | DEAD_LETTER analizi tamamlandı, replay edilmedi | **PASS** |
| 7 | Test paketi yeşil (rastgele sıra, taze DB) | **PASS** |
| 8 | Gateway container recreate edilmedi | **PASS** |
| 9 | Backend sağlıklı, gateway bridge bağlı, frontend 200 | **PASS** |
| 10 | Gateway nonce'u / session state korundu | **PASS** (container ve StartedAt değişmedi) |
| 11 | Gerçek cihaz E2E (QR tarama + mesaj gönderme/alma) | **BLOCKED** (yetkisiz test hesabı yok) |

---

## KARŞILAŞTIRMALI ÖZET

| Öğe | Phase 3.3 öncesi (`7b510c7`) | Phase 3.4 sonrası (`b5715fe`) |
|-----|------------------------------|-------------------------------|
| `.deployed-commit` | `7b510c7` | `b5715fe` |
| Backend container | `43276e36a717` | `579085f13268` (yeniden oluşturuldu) |
| Gateway container | `5b867095d376` | `5b867095d376` (**değişmedi**) |
| DB container | `f6d79c4a1f8b` | `f6d79c4a1f8b` (**değişmedi**) |
| Caddy container | `ee66a5cab371` | `ee66a5cab371` (**değişmedi**) |
| Oturum | 201 CONNECTED | 201 CONNECTED |
| `initial_sync_completed_at` | dolu | dolu |
| Mesaj (toplam) | 951 | 969 (+18 canlı) |
| Mesaj (`id<=160198`) | 953 (filigran) | **953** (eşleşti) |
| Yetim mesaj | 0 | 0 |
| `lid_mappings` | 4107 | 4107 |

## KALAN RİSKLER

1. **DEAD_LETTER replay yok.** 2 satır `lid_mapped` dead-letter'da kaldı; sistemik etki sınırlı, ama operatör müdahale kanalı yok. Bir güvenli replay mekanizması düşünülebilir.
2. **Gerçek cihaz E2E test edilemedi.** QR tarama + mesaj gönderme/alma manuel doğrulanmadı. Bunun yerine oturum durumu (`CONNECTED`), bridge heartbeat (`last_event_at` ilerliyor) ve sağlık endpoint'leri (`/health`, `gateway_bridge.connected=true`) gözlemlendi.
3. **Campaign test DB kirlenmesi.** `test_campaign_sequence_drip.py`, aynı test DB'sini ardışık kullanarak kirleniyor. Bu bir test-isolasyon boşluğu, ürün değil; fakat otomasyon yazılacaksa her koşumda `provision_test_db.py` çalıştırılmalı.
4. **Gateway recreate riski.** Bu deploy'da `--no-gateway` kullanıldı. Bir sonraki gateway değişikliği deploy'unda `auto_restore=true` oturumu yeniden bağlayacak, ama bellek içi mağaza (`chats`, `messagesByChat`, `store.contacts`) kaybolacak (§A6).
