# AŞAMA 3.3 — GERÇEK SENKRONİZASYON VE E2E GÜVENİLİRLİK

**Tarih:** 2026-10-27
**Dağıtılan sürüm:** `7b510c78162cd3cd1f2b8af84b56bdfd3e68249e` (release `20261027T210112Z`, `RELEASE_EXIT=0`)
**Önceki sürüm:** `978c1fe9ba479bbea46f8c324d7b4a21968f87cf`
**Ortam:** Oracle `130.162.247.20`, `/opt/tezlify`, PostgreSQL (docker `tezlify-db`)

---

## 1. Özet

Konsolda görünen üç belirti de (i18n eksik anahtarı, `uq_wa_connect_stage` yinelenen
anahtar hataları, hayalet kolon hataları) tek tek ölçüldü. **İkisi gerçek kusurdu ve
düzeltildi; biri tarihseldi.** Ölçüm sırasında, hiçbir belirtide görünmeyen **üçüncü ve
en ağır kusur** bulundu: LID köprüsü sorgusu bağlantı kimliğine bağlıydı ve her yeniden
bağlanmadan sonra köprü tablosunun **%99,9'unu** göremez hale geliyordu. Bu kusur, ilk
denemede dağıtımı durduran veri kaybının da doğrudan sebebiydi.

Bu turda **hiçbir mesaj, sohbet, kişi veya oturum silinmedi**; gateway container'ı
yeniden oluşturulmadı (`StartedAt` değişmedi), QR/eşleştirme akışına dokunulmadı.

---

## 2. Baz durum (güvenli ölçüm)

Dağıtımdan **önce**, hiçbir yazma yapılmadan alınan değerler:

| Ölçüm | Değer |
| --- | --- |
| `conversations / messages / contacts` | `123 / 753 / 1535` |
| `max(messages.id)` | `159998` |
| Gateway container | `5b867095d376…`, `StartedAt=2026-10-27T17:25:57.8181699Z`, `restarts=0` |
| WhatsApp oturumu | `id=201`, `CONNECTED`, `+905413749073` |
| `whatsapp_private.processed_events` | `20273` |
| `event_outbox` | `DELIVERED=5687`, `DEAD_LETTER=2` (2026-10-25, bu çalışmadan önce) |
| `lid_mappings` | `4107` satır, **20** farklı `session_id` |

---

## 3. Tam senkronizasyon zinciri (§2)

### 3.1 Baileys → gateway

`whatsapp-gateway/src/socket/socket-events.js` içindeki dinleyiciler:

| Baileys olayı | Satır | Gateway'deki karşılığı |
| --- | --- | --- |
| `creds.update` | 133 | kimlik bilgisi kalıcılaştırma |
| `connection.update` | 149 | bağlantı durumu → `connection_status` |
| `messages.upsert` | 550 | gelen/yeni mesaj → ingest |
| `chats.delete` | 584 | sohbet silme |
| `messages.delete` | 609 | mesaj silme (revoke) |
| `contacts.update` / `contacts.upsert` | 647 / 653 | kişi adı ve kimliği |
| `chats.phoneNumberShare` | 701 | **LID ↔ telefon köprüsü** |
| `chats.update` | 707 | sohbet meta verisi |
| `messaging-history.set` | 842 | geçmiş senkronu (`phoneNumberToLidMappings` dâhil) |
| `groups.update` | 1140 | grup konusu |
| `presence.update` | 1171 | çevrimiçi durumu |
| `messages.update` | 1224 | durum (delivered/read) |
| `message-receipt.update` | 1247 | okundu bilgisi |

### 3.2 Gateway → backend

- Gateway olayı `whatsapp_private.event_outbox`'a yazar, backend `/ws/gateway`
  köprüsünden alır. Köprü sağlığı `/health` içinde `gateway_bridge` bloğu olarak yayınlanır.
- **LID köprüsü ayrı yazılır**: `whatsapp-gateway/src/lid/lid-repository.js:70-84`
  `lid_mappings`'e `(session_id, lid_jid, phone_jid)` yazar. `session_id` **bağlantının**
  UUID'sidir; her soket açılışında `gateway_sessions`'a yeni satır düşer. Bu, bu turun
  ana bulgusunun kaynağıdır.

### 3.3 Backend → DB → outbox → frontend

1. Ingest (`backend/app/services/whatsapp/orchestration/events.py`) olayı işler.
2. Tekilleştirme: `whatsapp_private.processed_events` (idempotentlik defteri).
3. Yazma: `conversations` / `messages` / `contacts`; mesaj tekilliği
   `(conversation_id, wa_message_id)` (`uq_msg_conv_wa_message_id`).
4. Yayın: `event_outbox` → `/ws/gateway` → frontend aboneliği.
5. Frontend: `WhatsAppHubPage` hydrate eder, sohbet listesi **mutlak son mesaja** göre
   sıralanır.

### 3.4 Konsoldaki belirtilerin kaynağı

| Belirti | Kaynak | Durum |
| --- | --- | --- |
| `whatsapp.loadOlderMessages` ham anahtar | `ChatThread.tsx:1134` `t('whatsapp.loadOlderMessages')`; anahtar yalnızca `leads` altında vardı | **düzeltildi** (`be23e4c`) |
| `uq_wa_connect_stage` | `record_stage` QR **poll** yolundan çağrılıyor (`sessions.py:661`), insert+catch+rollback | **düzeltildi** (`6b2be1d`) |
| `wa_chat_id`, `id ambiguous`, `last_message_state`, `ct.phone`, `gateway_session_id` | Mevcut kaynakta **yok** (grep temiz) | **tarihsel**, aşılmış |

---

## 4. Tespit edilen kusurlar

### 4.1 [AĞIR] LID köprüsü bağlantı kimliğine bağlıydı — veri kaybı

**Kanıt (üretim, salt-okunur):**

```
whatsapp_sessions.gateway_id (oturum 201) = 1bd78836-c084-4cbf-b333-9386d44b7bd7
lid_mappings.session_id örnekleri         = 0b72b1ab…, 3b544ca8…, 47187db7… (20 adet)
```

| Birleştirme anahtarı | Eşleşen satır |
| --- | --- |
| Mevcut kod: `whatsapp_sessions.gateway_id = lid_mappings.session_id` | **4 / 4107 (%0,1)** |
| Doğru anahtar: `gateway_sessions.session_id = lid_mappings.session_id` | **4107 / 4107** |

`lid_mappings.session_id` bir **gateway bağlantısının** UUID'sidir ve her yeniden
bağlanmada yenisi üretilir (`lid-repository.js:70-84`); `whatsapp_sessions.gateway_id`
ise yalnızca **o anki** bağlantıyı gösterir. Sonuç:

- `purge_raw_jid_identity_data` erteleme koşulu köprüyü göremediği için **her yeniden
  bağlanmadan sonraki ilk boot'ta** köprüsü bilinen hayaleti "köprüsüz" sayıp
  **mesajlarıyla birlikte sildi**.
- `merge_deferred_lid_ghosts` aynı anahtarı kullandığı için bölünmeyi **hiç aday
  saymadı** — onarım sessizce "yapılacak iş yok" dedi.

**Canlı sonuç:** 2026-10-27 ~20:48Z'deki adacık penceresinde
`1 hayalet LID contact + 1 sohbet + 9 mesaj silindi`. Bu satırlar bu turdan **önce**
gitti ve geri getirilemez; bu turda yalnızca **tekrarı engellendi**.

### 4.2 [ORTA] Deploy kapısı yeni gelen mesajları göremiyordu

Kapı yalnızca **toplam** mesaj sayısına bakıyordu. Canlı hatta pencere boyunca yeni mesaj
gelir; 9 mesaj silinip 9 yeni mesaj gelirse toplam **değişmez** ve kayıp görünmez. Bu turda
ölçüldü: baz `729` → dağıtım öncesi `753` (24 yeni mesaj) — yani senaryo gerçekti.

### 4.3 [HAFİF] Test fixture'ı 4.1'i yapısal olarak göremezdi

`_seed_split` oturumu `gateway_id=GW_ID`, eşlemeyi `session_id=GW_ID` ile tohumluyor —
yani iki kimlik **inşa gereği aynı**. Kusur bu yüzden hiçbir testte görünmedi
(`fixture-limitation-masks-bug` deseni).

---

## 5. Yapılan kod değişiklikleri

| Dosya | Değişiklik |
| --- | --- |
| `backend/app/core/migrations.py` | Erteleme koşulundan `whatsapp_sessions` birleşimi kaldırıldı; köprü **yalnızca `lid_jid`** üzerinden bakılıyor. Yön güvenli: bu koşul sadece silmeyi **engeller**. |
| `backend/app/services/whatsapp/reconciliation.py` | Aday sorgusundan `ws` birleşimi kaldırıldı; sahip `contacts.user_id`'den okunuyor (kiracı yalıtımı korunur). Kullanılmaz hale gelen `_sessions_table` silindi. |
| `backend/tests/test_whatsapp_boot_lid_merge.py` | `mapping_session_id` parametresi + **2 yeni kapı** (dönen bağlantı kimliği). |
| `scripts/deploy/host-release.sh` | Mesaj **kimlik filigranı** (`db_message_watermark`, `db_messages_upto`, `messages_lost_since`); adacık ve cutover pencerelerinde kontrol. |

**Değiştirilmeyenler (bilinçli):** şema, tablo, oturum/auth akışı, gateway kodu,
compose dosyaları, `merge_deferred_lid_ghosts`'un birleştirme mantığı (yalnızca aday
sorgusunun sahip kaynağı), hiçbir veri satırı.

---

## 6. Testler

### 6.1 A — Otomatik

| Koşum | Sonuç |
| --- | --- |
| Backend, `-p no:randomly` | **1711 passed, 4 skipped** (`PYTEST_EXIT=0`) |
| Backend, rastgele sıra | **1711 passed, 4 skipped** (`RANDOM_EXIT=0`) |
| Baz | `1709` → `+2` yeni = `1711` ✔ |
| Gateway `npm test` | `GATEWAY_EXIT=0` |
| Frontend `npm run build` | `BUILD_EXIT=0` |
| `verify:i18n-keys` | `I18N_EXIT=0` (2425 çağrı yeri, en=3208 / tr=3208) |
| `verify:dom` | `exit 1` — **önceden var** (4 değişen dosya stash'lenip doğrulandı) |
| Statik migration muhafızı | `978c1fe..7b510c7` → `temiz`, `GUARD_EXIT=0` |

**Yeni kapılar önce KIRMIZI doğrulandı** (kaynak dosyalar stash'lenip çalıştırıldı):

```
FAILED test_a_bridge_from_a_previous_connection_still_defers_the_purge
FAILED test_a_bridge_from_a_previous_connection_is_still_merged
AssertionError: geçmiş bağlantıdaki köprü de birleştirmeli — assert 0 == 1
2 failed, 24 deselected
```

Düzeltme geri konunca: `2 passed`. Yani kapılar gerçekten kusuru yakalıyor.

### 6.2 B — Kontrollü yarış / idempotentlik

- **Yinelenen bağlantı aşaması**: `ON CONFLICT DO NOTHING`; test SQL metninde `ON CONFLICT`
  varlığını `before_cursor_execute` ile çiviliyor ve kardeş yazmanın (`qr_served`)
  rollback ile silinmediğini doğruluyor (2 kapı, önce kırmızı).
- **Birleştirme kilidi**: `test_a_merge_lease_held_elsewhere_defers_instead_of_racing` —
  ikinci süreç yarışmıyor, **erteliyor**.
- **Erteleme idempotentliği**: üretimde purge hiçbir satır silmedi ve hiçbir satır
  bırakmadı (log satırı **yok**), `identity_sweep merged=0 deferred=0 errors=0`.

### 6.3 C — Gerçek cihaz E2E

**BLOCKED** — gerçek cihaz E2E için ayrı test hesabı/cihazı gerekiyor. Üretim hattı
(`+905413749073`, oturum 201) kullanıcının canlı hattıdır; üzerinde yapay mesaj
gönderimi/QR/eşleştirme **yapılmadı**.

---

## 7. Deploy

| Adım | Sonuç |
| --- | --- |
| Dry-run | `DRY_RUN_EXIT=0`; gateway muhafızı **GEÇTİ**, migration muhafızı **GEÇTİ** |
| Cutover servisleri | `backend` (yalnızca) |
| Gerçek dağıtım | `RELEASE_EXIT=0`, `SÜRÜM TAMAM: 7b510c7` |
| Süre | ~96 s |

**Not (bootstrap tuzağı):** dağıtılan betik her zaman **eski** betiktir; bu yüzden hedef
commit'in kopyası `/tmp/hr.sh` olarak çıkarılıp çalıştırıldı. sha256 hem yerelde hem
host'ta `5bfaa9f9f3b2515a67789912c59361d7ce0e53321eb17edc613d1bee19233671`.

---

## 8. Üretim doğrulaması

| Kontrol | Sonuç |
| --- | --- |
| `.deployed-commit` | `7b510c78162cd3cd1f2b8af84b56bdfd3e68249e` ✔ |
| Canlı `migrations.py` sha256 | `2cc14e83…` == `git show 7b510c7:…` ✔ |
| Canlı `reconciliation.py` sha256 | `1f82fd9d…` == `git show 7b510c7:…` ✔ |
| Sayımlar (3 kontrol noktası) | `123\|753\|1535` → `123\|753\|1535` → `123\|753\|1535` ✔ |
| Filigran | `159998\|753` → `id<=159998` için **753** (kayıp yok) ✔ |
| Kayıp dosyaları | `candidate-data-drop.txt` / `candidate-messages-lost.txt` / `cutover-messages-lost.txt` **yok** ✔ |
| Gateway container | `5b867095d376…`, `StartedAt=17:25:57.8181699Z`, `restarts=0` — **değişmedi** ✔ |
| Oturum | `201 CONNECTED +905413749073` ✔ |
| `/health` | `status=healthy`, `gateway_bridge.connected=true`, `reconnect_count=1`, pong `21:04:19Z` ✔ |
| Kimlik süpürmesi | `runs=1, merged=0, deferred=0, stranded=0, errors=0` ✔ |
| Denetim tablosu | `table_status=ALREADY_PRESENT`, `table_ready=true` ✔ |
| Frontend | `index-BqAbSSRi.js` servis ediliyor; içinde `Daha Eski Mesajları Yükle` **var** ✔ |
| `uq_wa_connect_stage` | son 12 dk: **0** ✔ |

**Frontend yol notu:** `/opt/tezlify/frontend/dist` 15 Eylül'den kalma **kullanılmayan**
bir dizindir; servis edilen kök `frontend_candidate`'tir. İlk kontrolde yanlış dizine
bakıldı, sunucudan doğrulanarak düzeltildi (yanlış pozitif raporlanmadı).

---

## 9. Üretim veri bütünlüğü (salt-okunur, `2026-10-27T21:04:01Z`, `7b510c7`)

| Kontrol | Sonuç |
| --- | --- |
| `orphan_messages` | 0 |
| `dup_wa_msg` (sohbet içi) | 0 |
| `conv_contact_missing` / `conv_session_missing` | 0 / 0 |
| `conv_null_user` / `msg_null_user` / `contact_null_user` | 0 / 0 / 0 |
| `conv_lead_missing` | 0 |
| `msgs_no_wa_id` | 0 |
| `unread_negative` | 0 |
| `lid_ghosts` (`jid:%@lid`) | 0 |
| `dup_contact_phone` | **149** — hepsi **farklı kullanıcılar** arasında (aynı numara iki kiracıda); **aynı kullanıcı içinde 0** |
| `processed_events` | `20273` (baz `20190`, +83 — hat canlı) |

> `dup_contact_phone=149` bir bütünlük kusuru değildir: çok kiracılı yapıda aynı telefon
> numarası birden çok kullanıcının rehberinde bulunur. Önceki "0" değeri kullanıcı
> kapsamlı bir tanımdan geliyordu; doğru ölçüt **aynı kullanıcı içinde** tekilliktir ve
> o da 0'dır.

---

## 10. Kabul ölçütleri

| # | Ölçüt | Sonuç |
| --- | --- | --- |
| 1 | Baz durum güvenli (yazmasız) alındı | **PASS** |
| 2 | Senkron zinciri kod referanslarıyla belgelendi | **PASS** |
| 3 | Konsoldaki her hata sınıflandırıldı (gerçek/tarihsel) | **PASS** |
| 4 | Kanıtlanmış kusurlar düzeltildi | **PASS** |
| 5 | Yeni kapılar önce kırmızı, sonra yeşil | **PASS** |
| 6 | Tam test paketi yeşil (iki sırada) | **PASS** |
| 7 | Gateway/oturum korundu (yeniden oluşturma yok) | **PASS** |
| 8 | Dağıtım öncesi dry-run + muhafızlar | **PASS** |
| 9 | Dağıtım sonrası sayım/filigran kaybı yok | **PASS** |
| 10 | Frontend düzeltmesi gerçekten servis ediliyor | **PASS** |
| 11 | Gerçek cihaz E2E | **BLOCKED** (ayrı test hesabı/cihazı gerekli) |

---

## 11. Açık riskler ve sonraki adımlar

1. **Adacık container hâlâ üretim veritabanına migration uyguluyor.** Kapı bunu
   *sonradan* tespit ediyor (bu turda olduğu gibi), *önlemiyor*. Kalıcı çözüm: adacığı
   üretimin **şema kopyası** üzerinde çalıştırmak. Bu, deploy betiğinde yapısal bir
   değişikliktir; bu turda risk alınmadı, öneri olarak bırakıldı.
2. **Meşru bir birleştirme sohbet sayısını düşürür** (mesajlar taşınır, hayalet sohbet
   kapanır). Kapı `conversations` düşüşünde de durur — güvenli yönde (fail-closed) ama
   gürültülü. Mesaj filigranı eklendiği için artık "mesaj kaybı" ile "yapısal birleştirme"
   ayrılabiliyor; kapı politikası ayrı bir karar olarak bırakıldı.
3. **Silinen 9 mesaj geri getirilemez.** Yedek yok (`archive_mode=off`); bu turda
   onarım **denenmedi** (uydurma veri üretmek daha kötü olurdu).
4. **`event_outbox` `DEAD_LETTER=2`** (2026-10-25) — bu çalışmadan önce; incelenmedi.
