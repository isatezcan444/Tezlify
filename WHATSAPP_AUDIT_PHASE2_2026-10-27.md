# TEZLIFY WHATSAPP — AŞAMA 2 RAPORU
## Gerçek cihaz doğrulaması, QR/sync ölçümü ve veri bütünlüğü

**Tarih:** 2026-10-27
**Başlangıç commit'i:** `6d76d9e` (`6d76d9e633cd3e0cd66b76a626e855ffd1e86bbd`)
**Yayına alınan commit:** `70c0741`
**Push edilen son commit:** `bfc218c`
**Deploy:** `DEPLOY_EXIT=0`, cutover yalnızca backend, gateway **yeniden oluşturulmadı**

---

## A. Özet — ne yapıldı, ne kanıtlandı

Üç hedef vardı. Sonuçlarını baştan söylüyorum, gerekçeleri aşağıdaki bölümlerde:

| Hedef | Sonuç |
|---|---|
| QR → ilk sohbet gecikmesini ölç, gereksiz gecikmeyi kaldır | **Ölçülemedi (BLOCKED).** Metrik altyapısı doğru çalışıyor ama production'da kapalı — `WHATSAPP_LATENCY_PROFILING` **set değil**. Bunu kanıtladım ve metrik sözleşmesini test altına aldım. Gerçek QR ölçümü için tek yol: bir sonraki planlı eşleştirmede bayrağı açmak. |
| Kişi/sohbet/grup/mesaj senkronizasyonunu gerçek cihaz davranışına göre doğrula | **Kısmen (PASS/BLOCKED karışık).** Okuma-taraflı doğrulamalar geçti; gerçek cihazla eşleştirme **yapılmadı** (canlı oturuma dokunmama talimatı gereği). |
| 124 → 123 düşüşünü açıklayabilecek kalıcı, güvenli, denetlenebilir kayıt | **Kuruldu ve canlıda (PASS).** Kök neden bu turda **kanıtlanamadı** — kanıt deploy'la birlikte yok olmuştu. Artık bir sonraki değişim satır bırakacak. |

**En önemli dürüstlük notu:** 124 → 123 değişiminin **nedenini bulamadım**. Veri kaybı olmadığını kanıtladım, ama değişimi bir operasyona atfedemedim. Bunu "çözüldü" diye yazmıyorum.

---

## B. `6d76d9e` sonrası gerçek durum (yeniden uygulamadan önce)

Tali­mat gereği Tur 6 işini körü körüne tekrar uygulamadım; önce **ağaçta gerçekten var mı** diye baktım.

- `6d76d9e` mevcut, `main` üzerinde ve `origin/main` ile aynı.
- Liveness kodu ağaçta **var**: `backend/app/main.py` içinde `_GW_PING_INTERVAL_S = 20.0`, `_GW_PONG_DEADLINE_S`, 1011 kapatma; `frontend/src/api/client.ts` içinde `lastPongAt`, `HEARTBEAT_DEADLINE_MS`, `forceReconnect`.
- Bu doğrulamayı yaparken kendi belleğimdeki tuzağa düştüm: `grep "a\|b"` bu makinede (BSD grep) **sessizce hiçbir şey eşleştirmiyor** ve exit 0 dönüyor. İlk turda "kod yok" sandım. `grep -cE` ile tekrar ölçtüm: `main.py` 12, `client.ts` 10 eşleşme. Ders: bu makinede `\|` ile grep yazılmaz.
- Sapma yok; Tur 6 işi olduğu gibi duruyor ve **yeniden uygulanmadı**.

---

## C. QR / sync ölçümü — neden sayı yok

Talimat "mevcut metriklerin doğru çalıştığını kanıtla" diyordu. Kanıtladım: **çalışıyorlar, ama kapalılar.**

**Kök neden (ölçüldü, tahmin değil):**

```
docker exec tezlify-gateway printenv | grep -iE 'LATENCY|PROFILING'   → NOT_SET
grep -iE 'LATENCY|PROFILING' /opt/tezlify/docker-compose.prod.yml     → NOT_IN_COMPOSE
```

`whatsapp-gateway/src/observability.js`:

```js
const latencyLogger = pino({
  level: process.env.WHATSAPP_LATENCY_PROFILING === 'true' ? 'info' : 'silent',
  ...
});
export function latency(metric, started, sessionId) {
  if (process.env.WHATSAPP_LATENCY_PROFILING !== 'true') return;
  ...
}
```

Yani üç metrik de — `socket_start_to_provider_qr_ms`, `qr_generation_ms`, `socket_start_to_ready_ms` — production'da **hiç yazılmıyor**. Bu bir arıza değil, bir yapılandırma; ama sonucu şu: "QR eşleştirmeyi ölç" görevi production'da **okuyacak sayı bulamaz**.

Ek olarak: frontend `whatsappLatency.ts` `import.meta.env.DEV && VITE_…` ile kapılı, yani tasarımı gereği yalnız dev. Son senkronizasyon süresi de production'da loglanmıyor (`docker logs --since 60m | grep -iE 'sync job|senkron|stage='` → boş).

**Ne yaptım:** metrik sözleşmesini test altına aldım — `whatsapp-gateway/scripts/test-latency-metrics.mjs`, `npm test`'e kayıtlı. Üç şeyi pinliyor:
1. bayrak kapalıyken **tek satır bile** yazılmıyor (production varsayılanı sessiz kalmalı),
2. bayrak açıkken metrik **belgelenen adıyla**, geçerli JSON olarak, `component: 'whatsapp-latency'` ile ve negatif olmayan `duration_ms` ile çıkıyor,
3. payload **opak 12 karakterlik `session_ref`** taşıyor; ham oturum UUID'si, QR, telefon veya JID sızmıyor.

Test her iki yönde de yanlışlanabilir olduğunu kanıtladı:

| Yanlışlama | Sonuç |
|---|---|
| `sessionRef` ham id döndürsün | 2 assertion kırmızı (sızıntı + şekil) |
| `latency()` hiç yazmasın (ölü enstrümantasyon) | 2 assertion kırmızı (ad + JSON) |
| Geri alındı | yeşil, `git diff` boş |

**Sınıflandırma: BLOCKED.** Gerçek QR→ilk-sohbet süresi ölçülmedi, çünkü ölçmek için ya bayrağı production'da açmak (yeni bir yapılandırma değişikliği) ya da canlı oturumu yeniden eşleştirmek (talimatla yasak) gerekir. Simülasyonu cihaz ölçümü diye sunmuyorum.

---

## D. Veri bütünlüğü — 124 → 123 (atfedilemedi)

### Ölçülen sayılar

| Zaman | Sohbet | Mesaj | Kişi |
|---|---|---|---|
| 12:03 | **124** | 676 | 1536 |
| 12:25 | **123** | 712 | 1535 |
| 12:45 (deploy öncesi) | 123 | 721 | 1535 |
| 12:59 (deploy sonrası) | 123 | 743 | 1535 |

**Hem sohbet hem kişi bir azaldı**, mesaj 36 arttı. Yani "mesaj kaybı" yok; aksine mesaj akışı sağlıklı.

### Veri kaybı elendi (hepsi production'da okundu)

- **Sahipsiz mesaj: 0.** `min(messages.conversation_id) = 38163 = min(conversations.id)`; `max` ikisinde de 38286. Yani mesajların işaret ettiği sohbetlerin hepsi duruyor.
- **Yinelenen `wa_message_id`: 0.**
- **`preview_%` sentetik satır: 0** (önizlemeden mesaj uydurulmamış).
- **Boot migration'ları silme yapmadı:** mevcut container'ın açılış loglarında 21 `[MIGRATION]` satırı var, **hepsi "verified"**, hiçbiri silme bildirmiyor.
- **`delete_conversation` kişiyi silmiyor:** `db.delete(conv)` reaksiyon + mesaj + sohbet gider, **kişi kalır**. Dolayısıyla gözlenen `-1 kişi` bu yolla açıklanamaz.
- **ORM üzerinden tek kişi silme yeri** oturum temizliği (`sessions.py:1154`) — o da oturum silmeyi gerektirir, oturum silinmedi.
- **Kısıtlar sağlam:** `uq_conv_user_session_contact_channel` ve `uq_contact_user_phone` mevcut, bugün 0 duplicate.
- **LID birleştirmesi sohbeti silmez, arşivler:** `archived_convs = 5`, `ghost_lid_contacts = 0`, `wa_merge_locks` boş.

### Neden atfedemedim — kanıt yok edilmişti

1. `docker logs`, deploy'un değiştirdiği container'la birlikte gitti.
2. Gateway outbox payload'ı tasarımı gereği **şifreli** (`whatsapp_private.event_outbox.ciphertext`), yani "hangi olay hangi sohbeti götürdü" okunamıyor.
3. `wa_merge_locks` kira tutuyor, tarihçe değil.
4. Sweep sayaçları `_SWEEP_STATE` adlı **modül globali**; restart'ta `merged_total` 0'a dönüyor ve hiçbir şey kanıtlamıyor.

**Sınıflandırma: FAIL (kanıtlanamadı) — veri kaybı değil.** "Çözüldü" demiyorum; "kanıt yok" diyorum. Bu boşluğu kapatmak için E bölümündeki kalıcı denetim yazıldı.

---

## E. Kalıcı veri denetimi (yeni — canlıda)

Yeni tablo `whatsapp_data_audit` (**additive**, `checkfirst=True`, hiçbir mevcut tabloya dokunmuyor):

`created_at, event, source, user_id, session_id, correlation_id, outcome, reason, conversation_ids, contact_ids, counts_before, counts_after, outbox_event_id, detail`

**Tasarım kararları:**

- **Commit'ten SONRA yazılır.** Yani satır "denendi" değil, "**bu commit edildi**" demek.
- **`counts_before` / `counts_after`** işin özü: bir `-1`'i tahmine değil, belirli bir operasyona bağlar.
- Kaydedilen yerler: sohbet silme (API + telefondan gelen ingest), kimlik birleştirme, sweep turu (**yalnızca gerçekten bir şey değiştiyse** — her 15 dakikada boş satır yazmak gürültü).
- Birleştirme satırı `legacy_archived_not_deleted: true` taşıyor. Bu tam olarak şunu kanıtlar: **LID birleştirmesi sohbet sayısını değiştirmez.** Böylece bir sonraki turda birleştirme "makul şüpheli" olmaktan kanıtla çıkar.
- **PII yok:** mesaj gövdesi, telefon, JID, QR, kimlik bilgisi **yazılmaz**. Yalnızca bu veritabanı dışında anlamsız surrogate id'ler. Bir test bunu pinliyor.
- `GET /api/v1/whatsapp/data-audit` — kiracı kapsamlı, filtrelenebilir, `limit` 1–200.

**Kendi kodumda bulduğum gerçek kusur (düzeltildi):** `record_data_event` "asla raise etmez" sözü veriyordu, ama `AsyncSessionLocal()` **try'ın dışındaydı**. Sweep bu fonksiyonu `db=None` ile çağırıyor; havuz tükendiğinde istisna dışarı kaçar ve **denetimin açıklamak için var olduğu onarım döngüsünü durdururdu**. Oturum edinimini try'ın içine aldım ve ayrı bir testle pinledim. Yanlışlama: düzeltmeyi geri alınca **tam olarak o test** kırmızı (`RuntimeError: pool exhausted` `db = AsyncSessionLocal()` satırından kaçıyor).

---

## F. 32 sıfır-mesajlı sohbet — sınıflandırma (silme yok, uydurma yok)

Production'da **salt okuma** ile ölçüldü:

- 32 sohbetin **hepsinde `last_message_at` var** → 26'sı bireysel/önizlemesiz, 5'i grup/önizlemesiz, 1'i bireysel/önizlemeli.
- Hepsi `status = ACTIVE`, hiçbiri `is_archived = false` dışında değil.

**Sonuç: 32/32 → `UNSYNCED` (çapa/geçmiş yok).** Hiçbiri "gerçekten boş" (`NO_MESSAGES`) değil, hiçbiri kalıcı hata durumunda değil, hiçbiri silinmiş/birleştirilmiş değil.

Bu, belgelenmiş Baileys sınırıyla tutarlı: `fetchMessageHistory` bir **çapa** ister (`NO_ANCHOR`); çapa yoksa o sohbetin geçmişi çekilemez ve mesaj satırı oluşmaz. Bu bir veri kaybı değil, **henüz çekilmemiş geçmiş**tir.

**Hiçbir satır silinmedi, hiçbir mesaj uydurulmadı.**

---

## G. Canlılık (liveness) yeniden doğrulaması

Talimat "normal yük altında ve half-open kurtarmada yeniden doğrula" diyordu.

**Test tarafı (hepsi yeşil):**

- `verify:ws-liveness` — 3 vaka: sessiz eş → istemci 1011 ile kapatıp yeniden bağlanıyor ve uygulamaya `false` bildiriliyor; cevap veren eş → **hiç kapatılmıyor** (8 aralık, sahte kopma yok); geç gelen pong → deadline'ı erteliyor.
- `verify:ws-lifecycle` — 12/12 (soket sızıntısı, StrictMode çift mount, idempotent close, paylaşılan tek soket).

**Production tarafı (ölçüldü):**

```
gateway_bridge: connected=true, last_pong_at=13:00:17, last_event_at=13:00:17
```

`last_pong_at` deploy sonrası da **ilerliyor** (12:21 → 12:50 → 13:00). Bu alan Tur 6'da eklendi ve önceki build'de yoktu; varlığı + ilerlemesi, pong'ların gerçekten sayıldığını gösteriyor.

**Uzlaştırma (reconciliation) çalışıyor:**

```
whatsapp_identity_sweep: runs=1, merged_total=0, deferred_total=0,
                         errors_total=0, last_duration_ms=10.55
```

Aralık 900 s, ilk gecikme 60 s; yeni build'de ilk tur 12:58:56'da koştu. Hata yok.

**Outbox ilerliyor:** 8660 `DELIVERED`, en son 12:38:04. `DEAD_LETTER` yalnızca **2 tane ve 2026-10-25'ten** — yani mevcut build'den önce, tekrarlamıyor (`created_at > 2026-10-26` → 0). O saatte `lid_mappings`'e 434 satır yazılmış olması, eşleme hattının o 2 ölü mektuba rağmen çalıştığını gösteriyor. **Not:** o 2 olayın hangi LID'yi taşıdığı **kanıtlanamaz** (payload şifreli) — bunu BLOCKED olarak işaretliyorum, çözüldü demiyorum.

---

## H. `verify:whatsapp-pairing` — harness arızası bulundu ve düzeltildi

Tur 6 raporunda bu harness "bağımsız olarak kırık" diye **AÇIK** bırakılmıştı (12 FAIL, `calls=0`). Bu turda kök nedeni buldum ve düzelttim.

**Kök neden: fixture kayması, ürün hatası değil.** Modal artık eşleştirmeye başlamadan **önce** gateway sağlığını soruyor (`GET /whatsapp/gateway/health`). Fixture'da bu route **yoktu**, dolayısıyla `500 unexpected` dönüyordu; modal "gateway Down" durumuna düşüyor, `startPairing` **hiç çağrılmıyordu**. Bu yüzden 12 kontrol `calls=0` ile yanlış-kırmızıydı: harness, test etmesi gereken koda **ulaşamıyordu**.

Route eklendi → **14/14 PASS**.

Yeşilin yük taşıdığını kanıtlamak için harness'ı yanlışladım: `cancelPairingIfStillWaiting` içindeki promotion korumasını devre dışı bıraktım → **tam olarak 2 kontrol** kırmızı, mesajları da tam olarak o üretim hatasını söylüyor ("closing the QR UI after the scan cancelled the pairing — this is the defect that lost real pairings"). Geri alındı → yeşil.

---

## I. Test kapıları (hepsi son ağaçta koştu)

| Kapı | Komut | Sonuç |
|---|---|---|
| Backend (tam) | `pytest backend/tests -p no:randomly` | **1650 passed, 4 skipped, exit 0** |
| Gateway | `npm test` (34 script) | **exit 0**, 0 FAIL |
| Frontend type-check | `tsc --noEmit` | **exit 0** |
| Frontend build | `npm run build` | **exit 0**, `✓ built in 9.16s` |
| Realtime | `verify:realtime` | **9/9** |
| Loading gate | `verify:loading-gate` | **PASS** |
| WS lifecycle | `verify:ws-lifecycle` | **12/12** |
| WS liveness | `verify:ws-liveness` | **PASS** (3 vaka) |
| Pairing | `verify:pairing` | **14/14** (önce 2/14) |

Notlar: backend suite'i **şema-only** bir kopyaya karşı koştu (`scripts/provision_test_db.py` → `/tmp/tezlify_clean.db`), dev DB'ye karşı **değil**. `-p no:randomly` zorunlu (pytest-randomly kurulu). Hiçbir assertion "yeşil olsun diye" gevşetilmedi; aksine 3 yeni assertion eklendi.

---

## J. Deployment kanıtları

**Ön koşul (deploy'dan ÖNCE ölçüldü):** `whatsapp_data_audit` tablosu **yok** (`information_schema` → 0). Deploy'dan sonra 1 olması, migration'ın gerçekten koştuğunun yanlışlanabilir kanıtı.

**Kuru koşu:** `gateway muhafızı GEÇTİ: 6d76d9e..70c0741 arasında gateway ağacı değişmedi` → `cutover servisleri: backend`.

**Gerçek koşu:**

```
DEPLOY_EXIT=0
yeni backend saglikli
cutover dogrulandi: backend=sha256:ed245 gateway=DEGISMEDI (sha256:f3583)
hash OK: backend/app/services/whatsapp/orchestration/events.py 0d53838b9391…
SURUM TAMAM: 70c0741
```

**Kapsam kanıtı — `StartedAt`:**

| Container | StartedAt | Yorum |
|---|---|---|
| tezlify-backend | 2026-10-27T12:57:52 | cutover (beklenen) |
| tezlify-gateway | **2026-10-27T11:39:38** | **değişmedi** — recreate yok, bellek içi depo korundu |
| tezlify-db | 2026-10-01T17:45 | dokunulmadı |
| tezlify-caddy | 2026-10-12T13:12 | dokunulmadı |

**Migration:** `ensure_whatsapp_data_audit_table verified` logda **1** kez. Tablo canlıda 15 kolonuyla mevcut.

**Route canlıda:** `/api/v1/whatsapp/data-audit` OpenAPI'de var; kimliksiz çağrı **401** (404 değil) → mount edilmiş ve korumalı.

**Çalışan kod = incelenen kod** (`verify_blob` yalnızca 3 sabit yolu hash'liyor, o yüzden kendim hash'ledim — 4/4 birebir):

| Dosya | Commit `70c0741` | Container `/app` |
|---|---|---|
| `services/whatsapp_service.py` | `9075557c…` | `9075557c…` |
| `services/whatsapp/reconciliation.py` | `e6785888…` | `e6785888…` |
| `services/whatsapp_data_audit.py` | `8e861f82…` | `8e861f82…` |
| `models/whatsapp_data_audit.py` | `422d748b…` | `422d748b…` |

**Deploy sonrası sağlık:** sohbet/kişi sayısı değişmedi (123/1535), mesaj 721→743. Backend loglarında `traceback`/`ERROR` **0**, `[DATA-AUDIT]` uyarısı **0**. Denetim tablosunda satır **0** — doğru, çünkü hiçbir veri şekli değişmedi.

---

## K. Kabul kriterleri

| # | Kriter | Durum | Kanıt |
|---|---|---|---|
| 1 | `6d76d9e` sonrası gerçek durum tespit edildi, iş körü körüne tekrarlanmadı | **PASS** | B bölümü, grep -cE sayımları |
| 2 | QR aşamaları için zaman damgası/metrik doğrulandı | **PASS** | test-latency-metrics.mjs, 2 yönlü yanlışlama |
| 3 | QR → ilk sohbet gecikmesi gerçekten ölçüldü | **BLOCKED** | `WHATSAPP_LATENCY_PROFILING` NOT_SET; canlı eşleştirme yasak |
| 4 | Gerçek cihazla eşleştirme/senkron doğrulaması | **BLOCKED** | Canlı oturuma dokunulmadı; izin/cihaz yok |
| 5 | Kişi/sohbet/grup/mesaj tutarlılığı (okuma tarafı) | **PASS** | 0 sahipsiz mesaj, 0 duplicate, kısıtlar sağlam |
| 6 | 32 sıfır-mesajlı sohbet sınıflandırıldı, silinmedi, uydurulmadı | **PASS** | 32/32 `UNSYNCED` |
| 7 | 124→123 değişiminin kök nedeni | **FAIL** | Atfedilemedi; kanıt deploy'la yok olmuş |
| 8 | Veri kaybı olmadığı kanıtı | **PASS** | 0 sahipsiz, mesaj sayısı arttı, 21 migration "verified" |
| 9 | Kalıcı, PII'siz, restart'a dayanan denetim kaydı | **PASS** | tablo + servis + endpoint, 5 test, canlıda |
| 10 | Denetim yazımı çağıranı asla bozmuyor | **PASS** | 2 test + 2 yanlışlama (yazma ve oturum edinme) |
| 11 | Liveness normal yükte ve half-open'da yeniden doğrulandı | **PASS** | ws-liveness 3 vaka + canlı `last_pong_at` |
| 12 | Uzlaştırma döngüsü çalışıyor | **PASS** | `runs=1, errors_total=0` |
| 13 | Outbox ilerliyor, kayıp/yineleme yok | **PASS** | 8660 DELIVERED, en son 12:38 |
| 14 | 2 ölü mektubun hangi LID'yi taşıdığı | **BLOCKED** | Payload şifreli |
| 15 | Tüm test kapıları yeşil | **PASS** | I bölümü |
| 16 | Assertion gevşetilmedi | **PASS** | 3 yeni assertion eklendi |
| 17 | Commit + push | **PASS** | `70c0741`, `bfc218c` |
| 18 | Güvenli deploy + canlı doğrulama | **PASS** | `DEPLOY_EXIT=0`, gateway StartedAt sabit, 4/4 hash |
| 19 | Rollback komutu | **PASS** | L bölümü |

**Özet: 15 PASS, 3 BLOCKED, 1 FAIL.** FAIL olan tek madde 7 — ve o "veri kaybı var" değil, "kanıt yok" demek.

---

## L. Rollback ve kalan riskler

### Rollback (tek komut, sunucuda `/opt/tezlify` içinde)

```bash
bash scripts/deploy/host-release.sh --rollback-to 20261027T125632Z
```

Etiketler: `tezlify-backend:pre-20261027T125632Z`. Kayıt: `/opt/tezlify/backups/releases/20261027T125632Z/release.json`.

**Rollback'in veri etkisi:** yok. Yeni tablo **additive**; geri dönüş onu düşürmez, eski kod da onu okumaz. Yani rollback sırasında yazılmış denetim satırları kaybolmaz — sadece bir sonraki sürüme kadar yeni satır eklenmez.

### Kalan riskler / açık noktalar

1. **QR ölçümü hâlâ kapalı.** Gerçek sayı isteniyorsa `WHATSAPP_LATENCY_PROFILING=true` bir sonraki planlı eşleştirmede açılmalı. Bunu production compose'a kalıcı yazmak log hacmini artırır; geçici açmak daha doğru.
2. **Denetim satırı henüz canlıda üretilmedi.** Üretmek için gerçek bir veri şekli değişimi (silme veya birleştirme) gerekir; ikisi de kullanıcı verisine dokunmadan tetiklenemez. Bu yüzden canlı **yazma** yolunu testlerle ve DDL ile kanıtladım, bir olayla değil. İlk gerçek olayda satır görünecek.
3. **`_SWEEP_STATE` hâlâ modül globali.** Denetim artık kalıcı özet bırakıyor ama `/health`'teki `merged_total` restart'ta hâlâ sıfırlanıyor. Kalıcı sayaç ayrı bir iş.
4. **`verify:pairing` düzeltmesi bir test fixture'ına ait**, ürüne değil. Ürün kodu değişmedi — bu, düzeltmenin üretim davranışını değiştirmediği anlamına gelir; iyi haber.
5. **Gateway test script'i bilinçli olarak deploy edilmedi.** `whatsapp-gateway/` altına dokunmak `--no-gateway` muhafızını reddettirir, gateway recreate de bellek içi depoyu (A6) kaybettirir. Bir test script'i için bu bedel ödenmez; `bfc218c` bir sonraki gateway sürümüyle gider.
6. **`host-release.sh --no-gateway` muhafızı yol tabanlı.** Bir gün biri gateway'e yalnızca test dosyası ekleyip "gateway değişmedi" sanabilir. Muhafız doğru davranıyor (reddediyor); yorum satırı bunu açıklıyor.
