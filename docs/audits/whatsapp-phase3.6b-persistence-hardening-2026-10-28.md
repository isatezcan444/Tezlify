# TEZLIFY WHATSAPP — AŞAMA 3.6b: MESAJ KALICILIĞI VE GÜVENLİ DOĞRULAMA KAPISI

**Tarih:** 2026-10-28 (19:00–20:10 GMT+3)
**Mod:** KODLAMA + ALTYAPI
**Öncelik:** P0 — mesaj sürekliliği ve veri kaybını önleme
**Deploy:** YAPILMADI (bu aşamada yasak)
**Gateway restart/recreate:** YAPILMADI
**Üretim verisine yazma:** YAPILMADI

Bu rapor, `whatsapp-phase3.6-message-recovery-pdo-diagnosis-2026-10-28.md` (ilk 3.6 turu) üzerine
yapılan **denetim + sertleştirme** turudur. İlk raporun iddiaları burada düzeltilmiş hâlleriyle
geçerlidir; çelişki varsa **bu rapor** esastır.

---

## §0 — KANIT SEVİYESİ LEJANDI

Her iddia tek bir seviyeye etiketlenir. Bir seviyeyi diğeri gibi sunmak yasak.

| Etiket | Anlamı |
| --- | --- |
| **[K]** | **Kod doğrulaması** — kaynak okundu, satır düzeyinde gösterildi. Çalıştırılmadı. |
| **[T]** | **İzole test doğrulaması** — temiz test DB'sinde gerçekten koşturuldu, çıktı kayıtlı. |
| **[P]** | **Üretim salt-okunur gözlemi** — canlı sistemden okundu, hiçbir yazma yapılmadı. |
| **[D]** | **Gerçek cihaz E2E** — gerçek telefon + gerçek WhatsApp hesabı ile uçtan uca. |
| **[B]** | **BLOCKED** — kanıt yok; tahmin de yok. |

**Bu turda [D] seviyesinde hiçbir kanıt üretilmedi.** Yetkili test cihazı/hesabı yok.

---

## §1 — BAŞLANGIÇ VE BİTİŞ DURUMU

### 1.1 Repo [K]

| Öğe | Başlangıç | Bitiş |
| --- | --- | --- |
| Branch | `main` | `main` |
| `HEAD` | `8ad74ac` | `0d909ab` (+ bu raporun commit'i) |
| `origin/main` | `8ad74ac` | `0d909ab` (+ bu raporun commit'i) |
| Çalışma ağacı | temiz | temiz |
| Üretimde çalışan commit | `b5715fe90d0ff05ef497dcccbc87652efa10ccd1` | **aynı** |

**Üretim commit'i değişmedi.** `b5715fe` ile `HEAD` arasında 12 commit var; hiçbiri deploy edilmedi.

### 1.2 Bu turda eklenen commit'ler [K]

```
9ec13b6  fix(whatsapp): kalicilik supurmesini denetim bulgularina gore sertlestir
0d909ab  fix(gateway): PDO zaman asimini NO_CHUNK / WAITER_MISMATCH / PDO_NOT_SENT diye ayir
```

### 1.3 Denetlenen önceki tur dosyaları [K]

`memory_persistence.py`, `config.py`, `main.py` (lifespan + `/health`), `sync.py` (`request_id`),
`whatsapp_gateway.py`, gateway `session-manager.js` / `socket-events.js` / `index.js` /
`whatsapp-identity.js`, `test-history-diagnostics.mjs`, `conftest.py`, iki test dosyası.
**Hiçbiri deploy edilmedi**, dolayısıyla üretimde bu kodun hiçbir etkisi yok.

---

## §2 — 7.080 MESAJLIK FARK: KESİNLEŞTİRME

### 2.1 Önceki sayı neden yanlıştı [P]

İlk turda "7080 RAM-only" sayısı, gateway'e **`per_chat_limit=50`** ile sorularak ölçülmüştü.
Gateway `listAllMessages` içinde `group.slice(-perChat)` uyguluyor, yani **sohbet başına yalnızca son
50 mesaj görünür** oluyor. Bu, "DB'de olmayan" değil, "bu pencerede görünmeyen" sayısıydı — iki farklı
şey. Ayrıca etkilenen sohbet sayısı 16 değil, pencerenin gizlediği sohbetler dahil **40**.

### 2.2 Doğru ölçüm — altı ayrım [P]

Üretim host'unda, `tezlify-backend` konteyneri **içinde** çalışan salt-okunur betik
(yalnızca `SELECT` + gateway `GET`; çıktı yalnızca toplu sayı, mesaj içeriği yok).
`per_chat_limit=2000` (gateway'in kendi tavanı) ile tam RAM görünümü:

| Ölçüm | Değer |
| --- | --- |
| Oturum | `201`, gateway `1bd78836` |
| DB toplam mesaj | **1785** |
| DB'de `wa_message_id IS NULL` | **0** |
| DB sohbet | 125 |
| Erişilebilir JID anahtarı (PN + LID takma adı) | **237** |
| Gateway RAM toplam (dönen = bildirilen) | **9122** |
| RAM geçerli kimlikli | **9122** (%100) |
| RAM benzersiz kimlik | **9122** → **0 kopya** |
| RAM kimliksiz satır | **0** |

Altı ayrım:

| Sınıf | Sayı | Yorum |
| --- | --- | --- |
| **Doğru sohbette DB'de var** | **1785** | DB'deki *her* mesaj RAM'de, *doğru* sohbet altında. DB ⊆ RAM. |
| Başka sohbette DB'de var | **0** | Yanlış eşleştirme yok. |
| Başka kiracıda var | **0** | Kiracı sızıntısı yok. |
| JID eşlenemedi | **0** | LID/PN eşlemesi RAM'deki **tüm** sohbetleri kapsıyor. |
| **Gerçekten DB'de yok** | **7337** | 40 sohbette. |
| Eklenirse çakışacak | **0** | "Gerçekten yok" tanımı gereği çakışma yapısal olarak imkânsız. |

Eksik kayıtların **tamamında** geçerli zaman damgası ve gönderici meta verisi var
(`missing_without_timestamp = 0`, `missing_without_sender_meta = 0`), yani hiçbiri "bozuk veri"
diye elenmiyor.

En çok etkilenen sohbetler: `38291` (1688), `38289` (1264), `38329` (1205), `38296` (694),
`38292` (686), `38356` (372), `38306` (181), `38327` (178).

### 2.3 Düzeltmenin dürüst ifadesi

**7080 → 7337 bir veri değişimi değil, ölçüm derinliği düzeltmesidir.** DB 1747 → 1785 (+38 canlı
trafik). Aradaki fark, ilk ölçümün sohbet başına 50 ile kırpılmasından geliyor. Bu turda doğru sayı
**7337**.

### 2.4 Önce / Sonra (üretim)

| | Önce (ilk tur ölçümü) | Bu tur (doğru ölçüm) | Kod değişikliği sonrası üretim |
| --- | --- | --- | --- |
| RAM | 9098 (50/sohbet penceresi) | 9122 (tam) | **9122** (deploy yok) |
| DB | 1747 | 1785 | **1785** (deploy yok) |
| RAM-only | 7080 (yanlış) | **7337** | **7337** |
| Etkilenen sohbet | 16 (yanlış) | **40** | **40** |

Kod değişikliği üretime **girmediği için** fark kapanmadı. Bu beklenen ve doğru durumdur.

---

## §3 — YENİ MODÜL: DAVRANIŞ, SINIRLAR, DÜZELTİLEN KUSURLAR

### 3.1 Modül ne yapar [K]

`backend/app/services/whatsapp/memory_persistence.py`

Gateway'in belleğindeki mesajları **mevcut ingest yolundan** DB'ye yazar:
`build_message_from_gateway()` + `_insert_messages_resilient()`. Yeni bir paralel yazıcı yok.
`fetch_provider` **hiç çağrılmaz** — WhatsApp'a soru sorulmaz, telefonun döndürmediği geçmiş
**uydurulmaz**.

- Tekillik: `(conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL` aynen korunur.
- Canlı akış ile geçmiş **aynı** fonksiyondan geçer → aynı mesaj iki yoldan gelse tek satır.
- `apply_conversation_last_message` yalnızca ileri gider: eski mesaj sohbet sırasını geri almaz.

### 3.2 Sınırlar ve feature flag [K]

| Ayar | Varsayılan | Not |
| --- | --- | --- |
| `WHATSAPP_MEMORY_PERSIST_ENABLED` | **`True`** | Kill-switch. Artık **işin kendisinde** de okunuyor. |
| `..._INTERVAL_SECONDS` | 300 | Döngü aralığı (alt sınır 30 sn zorlanır). |
| `..._INITIAL_DELAY_SECONDS` | 90 | Uygulama açılışında ilk tur gecikmesi. |
| `..._PAGE_SIZE` | 500 | Sayfa başına mesaj. |
| `..._MAX_PAGES` | 20 | Tur başına azami sayfa (⇒ 10.000 mesaj tavanı). |
| `..._PER_CHAT_LIMIT` | 2000 | Gateway'in kendi sohbet tavanı. |

Sayfa başına `commit()`; tek dev transaction ve uzun sohbet kilidi yok.

**İmleç (cursor).** Tur başına tavan `max_pages × page_size` = **10.000** mesaj. Üretimde RAM
**9122** olduğu için pay yalnızca **878** mesajdı. İmleç olmadan her tur `offset = 0`'dan başlar; ilk
N sayfa zaten DB'de olduğu için **0 satır** eklenir ve offset hiç ilerlemez ⇒ liste 10.000'i aştığında
**kuyruk hiçbir turda yazılamaz**. Bu, sessiz bir veri kaybı sınıfıdır. `_STATE["cursors"]` (gateway
başına) tur sonuna ulaşılana kadar kaldığı yeri taşır; tur sonuna ulaşılınca 0'a döner. `dry_run`
imleci **ilerletmez**. `/health`'e oturum UUID'si sızmaz — yalnızca `cursor_count` ve
`max_cursor_offset` yayınlanır.

**Üretimde bu değişkenlerin hiçbiri tanımlı değil** [P] — yani varsayılanlar geçerli. Modül deploy
edilmediği için şu an **hiç çalışmıyor**; ama deploy edildiği anda varsayılan **açık** olduğu için
ilk tur açılıştan ~90 sn sonra kendiliğinden başlar. Bu, deploy kararının parçası olmalıdır
(bkz. §10.2).

### 3.3 Denetimde bulunan ve düzeltilen 6 gerçek kusur [T]

Denetim maddelerinin bir kısmı modülde **fiilen yoktu**. Her biri önce **kırmızı testle** gösterildi,
sonra düzeltildi. Falsifikasyon iki turda yapıldı (modül geçici olarak düzeltme öncesi hâline
döndürülüp testler koşturuldu, sonra geri yüklendi).

**1. tur — `8ad74ac` hâline karşı:**

```
FAILED ...::test_inactive_line_is_skipped                        assert 3 == 0
FAILED ...::test_partial_db_error_then_safe_retry                assert 4 == 1
FAILED ...::test_message_without_wa_id_is_never_duplicated       assert 3 == 0
FAILED ...::test_feature_flag_off_writes_nothing
4 failed, 5 passed in 0.60s
```

**2. tur — imleç düzeltmesi öncesi hâle karşı:**

```
E  TypeError: drain_gateway_memory_once() got an unexpected keyword argument 'start_offset'
E  AssertionError: ikinci tur kuyruğu yazmalı
2 failed, 1 passed
```

`test_dry_run_does_not_advance_the_cursor` düzeltme öncesinde **geçiyordu** (imleç hiç yoktu, dolayısıyla
ilerletmesi de mümkün değildi). Yani o test bir *kusur kanıtı* değil, imlecin getirebileceği yeni bir
regresyona karşı **bekçidir** — bunu kusur gibi sunmuyorum.

| # | Kusur | Kanıt | Düzeltme |
| --- | --- | --- | --- |
| 1 | **Kimliksiz kayıt yazılıyordu.** `wa_message_id IS NULL` tekillik indeksini atlar (kısmi indeks), yani her turda bir kopya daha üretir. | `assert 3 == 0` — 3 kopya | `_wa_id_of()`: `None`/boş/whitespace kimlik sayılmaz; kayıt RAM'de kalır, canlı akışta gerçek kimlikle gelirse yazılır (`skipped_no_id`). |
| 2 | **Sayfa içi INSERT hatası bütün turu zehirliyordu.** `rollback()` yoktu; "failed transaction" sonraki hatlara yayılırdı. | `assert 4 == 1` — kısmi hata 4 satır yazdı | Tek INSERT olduğu için yarım sayfa yok; hata yakalanıyor, `await db.rollback()`, tur `error` ile bitiyor. |
| 3 | **Kill-switch yalnızca lifespan'de okunuyordu.** `ENABLED=false` iken elle/CLI ile çağrılan tur yazmaya devam ederdi. | test kırmızı | Kontrol `run_memory_persistence_once` içine taşındı. |
| 4 | **`status == CONNECTED` yeterli değildi.** Devre dışı bırakılmış hattın geçmişini geri doldurmak, kullanıcı o hattı kapattıktan sonra veri yazmak olurdu. | `assert 3 == 0` | `is_active IS TRUE` eklendi. |
| 5 | **Sayfa içi hata `/health`'e yansımıyordu.** #2'nin *doğrudan sonucu*: hata artık dışarı fırlamadığı için eski `except` sayacı da artırmıyordu ⇒ durum "sorun yok" derken tur yarım kalırdı. | kod [K] | `stats["error"]` → `errors_total` + `last_error`. |
| 6 | **Listenin kuyruğu erişilemezdi.** Tur tavanı (10.000) toplam mesaj sayısının altında kaldığında her tur `offset 0`'dan başlıyor, ilk N sayfa zaten DB'de olduğu için 0 satır ekleniyor ve offset **hiç ilerlemiyordu**. | `AssertionError: ikinci tur kuyruğu yazmalı` + `TypeError: unexpected keyword argument 'start_offset'` | Gateway başına imleç: `start_offset` / `next_offset`; tur sonunda 0'a döner, `dry_run` ilerletmez. |

> #5 hakkında dürüst not: düzeltmeden **önce** sayaç zaten artıyordu (hata dışarı fırlıyordu).
> Sayaç #2 yüzünden **sessizleşecekti**; artırma bu yüzden eklendi. Yani #5, #2'nin önkoşuludur,
> bağımsız bir eski kusur değildir.
>
> #6 hakkında dürüst not: bu kusur **bugün üretimde hasara yol açmıyor**, çünkü modül deploy
> edilmedi. Ama deploy edilseydi ve RAM 10.000'i aştığında kuyruk sessizce yazılmazdı — P0 bir
> veri-kaybı önleme özelliğinde kabul edilemez bir ölçek sınırı.

---

## §4 — İZOLE TEST ORTAMI VE REGRESYON TESTLERİ

### 4.1 Test DB'sinin gerçekten izole olduğunun kanıtı [T]

Bu, ilk turda **gerçek bir kapı arızasıydı** ve bu turda kapatıldı.

**Arıza:** `scripts/provision_test_db.py` taze bir SQLite dosyası üretir, ama pytest **ayrı bir
süreçtir** ve `settings.DATABASE_URL` neyi gösteriyorsa ona bağlanır. Yalnızca `TEST_DB_PATH`
export edilince `DATABASE_URL` varsayılanı (`sqlite+aiosqlite:///./tezlify.db`) geçerli kalıyor ve
testler **depodaki eski** DB'ye koşuyordu. Sonuç: önceki turların artıkları (aynı telefonlu lead'ler)
rastgele sırada yüzeye çıkıp alakasız testleri düşürüyordu —
`UNIQUE constraint failed: leads.phone_e164`.

**Kapanış (iki katmanlı):**

1. Her koşumda **iki** değişken birlikte verildi:
   `TEST_DB_PATH=/tmp/tezlify_clean.db` **ve** `DATABASE_URL=sqlite+aiosqlite:////tmp/tezlify_clean.db`
2. `conftest.assert_test_db_matches_requested_path()` — uyuşmazlık artık **fail-closed**:

```
>   raise RuntimeError(
        "Testler, provision edilen dosyaya baglanmiyor: "
        f"TEST_DB_PATH={requested!r} ama DATABASE_URL={url!r}. "
        "Provision ile pytest AYNI dosyayi kullanmalidir; ..."
10 errors in 0.54s
```

Yani sessiz yanlışlık gürültülü hataya çevrildi: yanlış DB'ye koşan bir test **artık geçemez**.

**Ek kanıt:** dört pytest logunda `postgresql`, `130.162`, `tezlify-db` referansı sayısı **0**.
Provision logu her koşumda `provisioned /tmp/tezlify_clean.db: 33 tables` yazıyor (dosya her turda
`rm -f` + yeniden üretim).

### 4.2 Zorunlu 14 senaryonun karşılanması [T]

| # | Zorunlu senaryo | Test | Sonuç |
| --- | --- | --- | --- |
| 1 | 50'den eski mesajların batch hâlinde eklenmesi | `test_drains_history_beyond_per_chat_cap` | PASS |
| 2 | Aynı batch'in iki kez çalıştırılması | `test_repeated_drain_is_idempotent` | PASS |
| 3 | Kısmi DB hatası + güvenli tekrar | `test_partial_db_error_then_safe_retry` | PASS |
| 4 | Kiracılar arasında aynı telefon/JID | `test_other_tenant_jid_is_not_written` | PASS |
| 5 | LID↔PN + farklı bağlantı UUID'leri | `test_unmapped_lid_chat_is_skipped` + `test_phase_17_history_evidence::test_10` (oturumlar arası izolasyon) | PASS |
| 6 | Eksik/bozuk WhatsApp kimliği | `test_message_without_wa_id_is_never_duplicated` | PASS |
| 7 | Aynı mesajın farklı batch'lerde gelmesi | `test_live_and_history_same_id_single_row` | PASS |
| 8 | Eski mesajların sırayı geri almaması | `test_older_messages_do_not_rewind_last_message_at` | PASS |
| 9 | Büyük sohbetlerde batch/memory sınırı | `test_max_pages_bounds_the_run` | PASS |
| 10 | Görev iptali ve uygulama kapanışı | `test_cancellation_propagates_and_leaves_no_half_written_page`, `test_loop_cancellation_exits_cleanly` | PASS |
| 11 | Flag kapalıyken hiç yazmama | `test_feature_flag_off_writes_nothing` | PASS |
| 12 | Eşzamanlı iki worker | `test_two_concurrent_workers_do_not_duplicate` | PASS |
| 13 | DB kesintisinde RAM'in korunması | `test_db_outage_never_touches_gateway_memory` | PASS |
| 14 | Reconnect sonrası tekrarın çoğaltmaması | `test_reconnect_rerun_does_not_duplicate` | PASS |

Ek kapsam: `test_inactive_line_is_skipped`, `test_dry_run_writes_nothing`,
`test_missing_created_at_falls_back_to_timestamp_s`, `test_loop_survives_a_failing_run`,
`test_drains_history_beyond_per_chat_cap`, `test_tail_is_reachable_when_max_pages_is_below_total`,
`test_run_once_advances_cursor_across_turns`, `test_dry_run_does_not_advance_the_cursor`.

**Toplam: 22 test (10 ilk tur + 12 sertleştirme), hepsi PASS.** Hiçbir assertion kaldırılmadı,
hiçbir test skip edilmedi, hiçbir kapsam daraltılmadı. `fake_gateway` yardımcısı artık istenen
`offset`'e saygı duyuyor (çağrı sırasına göre sayfa döndürseydi imleç testi kendi kendini
doğrulardı); kullanılmayan `fail_on_page` parametresi ve `paged()` yardımcısı kaldırıldı.

### 4.3 Test dosyalarının sayısal kanıtı

`1787 passed` (ilk tur sonu) → `1796 passed` (5 kusur düzeltmesi, +9 test) → **`1799 passed`**
(imleç düzeltmesi, +3 test). Her adımda artış tam olarak eklenen test sayısı kadar. Sapma yok.

---

## §5 — KAPI SONUÇLARI (gerçek exit code'lar) [T]

### 5.1 Backend — dört tam koşum, her biri taze DB

Her koşumdan **önce**: `rm -f /tmp/tezlify_clean.db && python scripts/provision_test_db.py`.
Komut: `pytest backend/tests/ -q` (+ `-p no:randomly` veya `-p randomly --randomly-seed=<seed>`).

| Koşum | Komut eki | Sonuç | Süre | Exit |
| --- | --- | --- | --- | --- |
| Sabit sıra | `-p no:randomly` | **1799 passed, 4 skipped** | 164.04 s | **0** |
| Seed `424242` | `-p randomly --randomly-seed=424242` | **1799 passed, 4 skipped** | 135.10 s | **0** |
| Seed `777` | `-p randomly --randomly-seed=777` | **1799 passed, 4 skipped** | 145.80 s | **0** |
| Seed `900913` | `-p randomly --randomly-seed=900913` | **1799 passed, 4 skipped** | 135.93 s | **0** |

**Seed'lerin gerçekten uygulandığının kanıtı** — `-q` başlığı bastırdığı için toplama sırası
karşılaştırıldı (üç seed, üç **farklı** sıra):

```
seed 424242 → hardening::test_feature_flag_off_writes_nothing, hardening::test_inactive_line_is_skipped, ...
seed 777    → phase_17::test_11_initial_sync..., phase_17::test_05_provider_timeout, ...
seed 900913 → phase_17::test_11_initial_sync..., phase_17::test_12_manual_history..., ...
```

### 5.2 Gateway

`npm test` → **exit 0**, logda **0 `FAIL`**. Zincirin sonu:

```
[test-history-diagnostics] PASS
  ok: jidKind PN/LID/GROUP/OTHER
  ok: socket yokken SOCKET_UNAVAILABLE
  ok: PDO gönderildi, waiter request_id taşıdı, TIMEOUT/NO_CHUNK döndü
  ok: TIMEOUT logu pdo_sent:true + failure_class:NO_CHUNK taşıyor
  ok: chunk geldi/eşleşmedi → WAITER_MISMATCH (NO_CHUNK değil)
  ok: gönderim tamamlanmadı → PDO_NOT_SENT
  ok: chunk eşleşti, OK döndü, logda PII yok
  ok: başka sohbetin chunk'ı waiter'ı çözmedi
  ok: waiter yokken scan güvenli
```

### 5.3 Frontend ve doğrulama scriptleri

| Kapı | Sonuç | Exit |
| --- | --- | --- |
| `npm run build` | `✓ built in 8.18s` | **0** |
| `verify:i18n-keys` | `PASS: her t('...') cagrisi her dilde cozumleniyor` | **0** |
| `verify:older-page-lock` | `9 checks passed` | **0** |
| `verify:older-page-state` | `6 checks passed` | **0** |
| `verify:message-timeout-budget` | `3 checks passed` | **0** |

### 5.4 Lint / type / syntax / diff / secret

| Kontrol | Sonuç |
| --- | --- |
| `python -m py_compile` (8 dosya) | OK |
| `node --check` (5 dosya) | OK |
| `git diff --check` | OK (whitespace hatası yok) |
| Secret taraması (eklenen satırlar) | `NO_SECRETS` — `ogBuK5ha…`, private key, `api_key=`, `password=`, host IP yok |
| Yeni test dosyası PII taraması | yalnızca `+905551112233` (sentetik, `555` aralığı) |

---

## §6 — PDO TEŞHİSİ: `NO_CHUNK` / `WAITER_MISMATCH` AYRIMI

### 6.1 Bulunan kritik kusur: `pdo_sent` gölgelemesi [K][T]

`requestOlderHistory` içinde promise executor'ında `let pdoSent = false;` **tekrar** tanımlanmıştı ve
dıştaki değişkeni **gölgeliyordu**. Sonuç: PDO gerçekten gitmiş olsa bile `TIMEOUT` logu
**her zaman** `pdo_sent: false` yazıyordu. Yani teşhisin çekirdeği sessizce yalan söylüyordu — bu
hata bulunmasaydı "PDO hiç gönderilmiyor" gibi tamamen yanlış bir sonuca varılacaktı.

İç tanım kaldırıldı; `pdoSent` tek yerde, dış kapsamda, `.then()` içinde `true` yapılıyor.
Regresyon testi bunu kilitliyor: `TIMEOUT logu pdo_sent:true taşıyor`.

### 6.2 Üç sınıflandırma [T]

Timeout anında artık tek bir `TIMEOUT` etiketi yok:

| `failure_class` | Anlamı | Arızanın yeri |
| --- | --- | --- |
| `PDO_NOT_SENT` | Gönderim sözü bekleme penceresinde çözülmedi | Gateway → socket katmanı |
| `WAITER_MISMATCH` | Chunk **geldi** ama bekleyen istekle eşleşmedi | Anahtar/normalizasyon katmanı |
| `NO_CHUNK` | PDO çıktı, hiç chunk gelmedi | Telefon / sağlayıcı tarafı |

Ayrim, oturum üzerindeki `_historyChunkSeq` sayacından geliyor (`noteHistoryChunk`). Sayaç
chunk'ın **hangi sohbete** ait olduğundan bağımsızdır — "eşleşmedi" hükmü tam olarak bunu gerektirir.
Log'a `failure_class` ve `chunks_during_wait` eklendi; dönen nesne de `failure_class` taşıyor.

**Önceki turlarda bu ayrım yoktu**, yani `38346` için "telefon geçmiş döndürmedi" iddiası
`WAITER_MISMATCH` ihtimalini **dışlamıyordu**. Bu turda ayrım kodlandı ama **deploy edilmedi**.

### 6.3 Hâlâ kanıtlanmamış olan [B]

Aşağıdakilerin hiçbiri bu turda kanıtlanmadı ve **hiçbiri elenmedi**:

- Telefonda o mesajların gerçekten bulunup bulunmadığı,
- Anchor'ın cihazda olup olmadığı,
- Sohbet bazlı sağlayıcı tarafı hız sınırı,
- Chunk'ın başka bir anahtar altında düşmesi.

Bunları ayırt edecek tek araç §6.2'deki izlerdir ve **üretimde çalışmıyorlar** (deploy yok).
Yani bugün bu dört hipotez için **sıfır üretim değeri** var. Bu, bilinçli bir tercih: gateway
recreate, RAM'deki 7337 mesajı kalıcı olarak silerdi.

### 6.4 Kanıt durum makinesi [K][T]

- `TIMEOUT` ve `PROVIDER_ERROR` **kalıcı exhaustion üretmez**: `provider_exhausted=FALSE`,
  `has_more=TRUE` korunur.
- Eski bağlantı UUID'leri altındaki kayıtlar yeni oturumu **bloklamaz** — anahtar
  `(session_id, jid)` ve `test_phase_17_history_evidence::test_10` bunu doğruluyor.
- Bu turda **hiçbir migration eklenmedi**, hiçbir eski kanıt satırı silinmedi/değiştirilmedi.
  Geri alınabilirlik: kod geri alınır, şema aynı kalır.

---

## §7 — ÜRETİM DEĞİŞMEDİ: ÖNCE / SONRA [P]

| Öğe | Önce | Sonra | Durum |
| --- | --- | --- | --- |
| `.deployed-commit` | `b5715fe9…` | `b5715fe9…` | **aynı** |
| backend | `579085f13268` @ `2026-10-27T22:25:45Z` | `579085f13268` @ `2026-10-27T22:25:45Z` | **aynı** |
| gateway | `5b867095d376` @ `2026-10-27T17:25:57Z` | `5b867095d376` @ `2026-10-27T17:25:57Z` | **aynı** |
| db | `f6d79c4a1f8b` @ `2026-10-01T17:45:08Z` | aynı | **aynı** |
| caddy | `ee66a5cab371` @ `2026-10-12T13:12:45Z` | aynı | **aynı** |
| Oturum | `201 CONNECTED`, `is_active=t`, `is_phone_online=t`, `gateway_id=1bd78836` | aynı | **aynı** |
| QR / auth | dokunulmadı | dokunulmadı | — |
| Sohbet / mesaj / max ID | 124 / 1751 / 160996 | **125 / 1785 / 161030** | +1 sohbet, +34 mesaj |
| `contacts` | 1536 | **1537** | +1 |
| `conv 38346` mesaj | 4 | **4** | **değişmedi** |
| `event_outbox` | hepsi `DELIVERED` | `DELIVERED: 4031` | dead-letter yok |

**Sayaç artışları canlı trafiktir**, test yazımı veya veri kaybı değil: hiçbir test üretim DB'sine
bağlanmadı (§4.1), oturum `CONNECTED` kaldı ve `38346` sabit. Ayrıca `125.` sohbet ve `+1` kişi,
gelen yeni bir yazışmanın işaretidir — silme/geri alma yok (`messages` sayısı yalnızca arttı).

---

## §8 — KABUL TABLOSU

| # | Kriter | Durum | Kanıt |
| --- | --- | --- | --- |
| 1 | Gateway belleği kaybolsa da DB'deki mesajlar erişilebilir kalır | **PASS** | Kalıcılık DB'de; modül RAM'i DB'ye yazar, tersini yapmaz. `test_db_outage_never_touches_gateway_memory` [T] |
| 2 | Geçmiş kalıcılığı idempotent ve kiracı-güvenli | **PASS** | 22 test; kiracı izolasyonu + tekillik [T] |
| 3 | Yeni ve eski mesajlar **aynı** kalıcılık yolundan geçer | **PASS** | `build_message_from_gateway` + `_insert_messages_resilient` [K]; `test_live_and_history_same_id_single_row` [T] |
| 4 | Tekrarlanan chunk kopya üretmez | **PASS** | `test_repeated_drain_is_idempotent`, `test_message_without_wa_id_is_never_duplicated` [T] |
| 5 | Mevcut API sayfalama / `has_more` bozulmadı | **PASS** | `verify:older-page-lock` 9, `verify:older-page-state` 6, `verify:message-timeout-budget` 3, exit 0 |
| 6 | PDO timeout için ölçülebilir kanıt **veya** ayrıştırılmış hipotezler | **PARTIAL** | Üç sınıflandırma kodlandı ve test edildi [T]; **deploy edilmedi** ⇒ üretimde ölçüm yok [B] |
| 7 | Geçici sağlayıcı hataları kalıcı exhaustion yaratmaz | **PASS** | `test_phase_17_history_evidence` (20 test) [T] |
| 8 | Temiz izole testler geçer | **PASS** | 4 × 1799 passed / 4 skipped, exit 0 [T] |
| 9 | Canlı oturum ve üretim verisi korundu | **PASS** | §7 [P] |
| 10 | Deploy durumu dürüst raporlandı | **PASS** | Deploy **yapılmadı**, üretim `b5715fe` [P] |
| 11 | Telefonun döndürmediği geçmiş uydurulmadı | **PASS** | `fetch_provider` çağrısı yok [K] |
| 12 | Gerçek cihaz E2E | **BLOCKED** | Yetkili test cihazı/hesabı yok [B] |

**Özet: 9 PASS, 1 PARTIAL, 0 FAIL, 1 BLOCKED.**

---

## §9 — COMMIT / PUSH

| Commit | İçerik |
| --- | --- |
| `9ec13b6` | Backend sertleştirme: 5 kusur + 9 test |
| `0d909ab` | Gateway: `pdo_sent` gölgeleme düzeltmesi + üç sınıflandırma + test genişletmesi |
| *(imleç)* | Backend: erişilemeyen kuyruk düzeltmesi + 3 test |
| *(bu rapor)* | `docs/audits/` raporu + devir notu |

`origin/main`'e push edildi. Çalışma ağacı temiz. **Deploy / release / gateway restart / feature flag
açma yapılmadı.**

---

## §10 — KALAN RİSKLER VE SONRAKİ AŞAMA

### 10.1 Kalan riskler

1. **Deploy sırası hâlâ tek ölümcül risk.** Gateway backend'den **önce** deploy edilirse RAM'deki
   **7337** mesaj kalıcı olarak gider (A6: gateway store'u yeniden kurulmaz). Sıra:
   **backend → `last_inserted ≈ 7337` doğrula → gateway.**
2. **Feature flag varsayılanı `True`.** Backend deploy edildiği anda süpürme ~90 sn sonra
   kendiliğinden başlar. Kontrollü bir ilk tur isteniyorsa deploy öncesi
   `WHATSAPP_MEMORY_PERSIST_ENABLED=false` verilip elle tek tur (`dry_run` → gerçek) yapılmalı.
3. **`--no-gateway` şu an reddediyor** (commit aralığında `whatsapp-gateway/` değişikliği var,
   exit 1). Backend-only deploy ayrı bir karar gerektiriyor.
4. **PDO teşhis izleri üretimde yok.** Dört hipotez hâlâ ayrıştırılmadı (§6.3).
5. **`conv 38346` kurtarılmadı.** Gateway RAM'i ile DB **birebir aynı 4 mesaj**; eksik geçmiş
   kalıcılık kaybı değil, telefon o mesajları hiç göndermemiş. **Kurtarıldı diye raporlanmıyor.**
6. **Test DB kapısı yeni.** `DATABASE_URL` unutulursa artık gürültülü hata veriyor — ama bu
   `conftest`'e bağlı; farklı bir test runner kullanılırsa koruma devre dışı kalır.

### 10.2 Sonraki aşama önerisi

1. **Backend-only deploy** (ayrı onay): `WHATSAPP_MEMORY_PERSIST_ENABLED=false` ile başlat →
   `dry_run` tek tur → beklenen sayı ≈ **7337** mi doğrula → flag'i aç →
   `last_inserted ≈ 7337`, `last_scanned ≈ 9122`, `last_pages ≈ 19` izle →
   `/health.whatsapp_memory_persistence` temiz mi bak. `messages` sayısı **1785 → ~9122** olmalı;
   `conv 38346` **4'te kalır** (bu doğrudur, hata değildir).
2. **Ancak ondan sonra** gateway deploy'u (ayrı onay). O noktada RAM'deki veri DB'de olduğu için
   recreate maliyeti sıfıra iner.
3. Gateway deploy edildikten sonra `38346` için tek bir PDO denemesi: log'dan
   `failure_class` oku. `NO_CHUNK` çıkarsa "telefon döndürmüyor" **kanıtlanmış** olur;
   `WAITER_MISMATCH` çıkarsa arıza anahtar normalizasyonundadır.
4. Gerçek cihaz E2E için **yetkili test hesabı/cihazı** tahsisi — şu an tek BLOCKED madde.

---

## §11 — GERÇEK CİHAZ E2E İÇİN GEREKEN

- Yetkili bir test WhatsApp hesabı (üretim hattından **ayrı**),
- Telefonda 50'den fazla mesaj içeren en az bir sohbet,
- On-demand geçmiş isteğini tetikleyecek kadar eski bir anchor,
- Gateway loglarına erişim (deploy sonrası `failure_class` okumak için).

Bunlar sağlanmadan hiçbir iddia [D] seviyesine yükseltilmeyecek.
