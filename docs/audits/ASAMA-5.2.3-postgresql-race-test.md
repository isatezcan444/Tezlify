# AŞAMA 5.2.3 — PostgreSQL `IntegrityError` yarış testi

**Referans commit:** `a4f12d7bcbc407a5288e65658d8287c4e1063044`
**Tarih:** 2026-11-01
**Kapsam:** AŞAMA 5.2 (`messages.upsert` notify/append ayrımı) — `IntegrityError` kurtarma yolunun gerçek eşzamanlılık altında doğrulanması
**Sonuç:** `POSTGRESQL RACE VERIFIED`

---

## 0. Özet

AŞAMA 5.2.1 denetiminde `IntegrityError` kurtarma yolu **tetiklenemedi** ve bu
"doğrulanamadı (ortam kısıtı)" olarak kaydedildi — "geçti" diye değil. Bu aşama
o boşluğu kapatır.

Yarış, yerel izole PostgreSQL 17.11 üzerinde, **rastgele `sleep` kullanmadan**,
INSERT ile commit arasındaki gerçek bir `await` noktasında kurulan kontrollü
bekletmeyle deterministik hâle getirildi. Sonuç:

| Ölçüm | Değer |
|---|---|
| İhlal edilen kısıt | `uq_msg_conv_wa_message_id` (literal PG mesajından okundu) |
| `IntegrityError` dalı | **1 kez** çalıştı (log satırıyla kanıtlı) |
| DB satırı | **1** |
| Canlı yayın (append) | **0** |
| ACK / NACK | **2 / 0** |
| Rozet | **1 → 1** (artmadı) |
| Önizleme + zaman damgası | **korundu** |
| Dış webhook | **0** |
| Determinizm | **5/5 koşu, 3/3 test geçti** |

Üretim kodu **değiştirilmedi**. Yalnızca bir test dosyası eklendi:
`backend/tests/test_whatsapp_pg_integrity_race.py` (693 satır, 3 test).

---

## 1. Test veritabanı kimliği ve production OLMADIĞININ kanıtı

Bu bölüm, "yanlışlıkla üretime test yazma" riskini kapatmak için önce
kanıtlanmıştır; hiçbir sorgu bu kanıttan önce çalıştırılmadı.

### 1.1 Sunucu yerel

| Kontrol | Çıktı |
|---|---|
| `inet_server_addr()` / `inet_server_port()` | `127.0.0.1` / `5432` |
| `SHOW listen_addresses` | `localhost` |
| `SHOW data_directory` | `/opt/homebrew/var/postgresql@17` |
| `SHOW port` | `5432` |
| `version()` | `PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0` |
| `lsof -iTCP:5432` | yalnız `127.0.0.1:5432` ve `[::1]:5432` (loopback) |
| Container runtime | **yok** (`docker` bulunamadı) |

Üretim veritabanı uzak Oracle Cloud host'undadır ve oraya **yalnızca**
`ssh ubuntu@… -i ~/.ssh/id_tezlify_oracle` + `docker exec tezlify-db psql`
ile erişilir. Bu oturumda SSH açılmadı, tünel kurulmadı, `docker` çağrılmadı.
`listen_addresses=localhost` olan yerel bir sunucuya loopback üzerinden
bağlanmak, tanım gereği üretime bağlanmak değildir.

### 1.2 Ayrı ve boş veritabanı

Test için **yeni** bir veritabanı yaratıldı; mevcut hiçbir veritabanına
(`tezlify`, `tezlify_test_isolated`, `scoutify_perf`) dokunulmadı.

```
CREATE DATABASE tezlify_race_523;
→ tezlify_race_523 | 127.0.0.1 | 5432 | public tablo sayısı: 0
```

### 1.3 Uygulama tarafında ikinci savunma hattı

`backend/tests/conftest.py:19` zaten `assert_test_db_is_not_remote()` guard'ını
autouse session fixture'ında çalıştırıyor: localhost olmayan her host için
`RuntimeError` atar. Yani bu test yanlışlıkla uzak bir `DATABASE_URL` ile
koşulsaydı, tek bir bağlantı açılmadan önce dururdu.

Ek olarak test dosyası `settings.DATABASE_URL.startswith("postgresql")` değilse
kendini `skip` eder (SQLite'ta 3 skip — bkz. §6.1).

**Sonuç: production DB'ye bağlantı, sorgu, yazma, test verisi, transaction —
hiçbiri yok.**

---

## 2. Kullanılan kısıt

`messages` tablosunda **iki** kısmi unique indeks vardır
(`backend/app/models/message.py:112-137`):

```sql
CREATE UNIQUE INDEX uq_msg_conv_client_message_id
  ON public.messages USING btree (conversation_id, client_message_id)
  WHERE (client_message_id IS NOT NULL);

CREATE UNIQUE INDEX uq_msg_conv_wa_message_id
  ON public.messages USING btree (conversation_id, wa_message_id)
  WHERE (wa_message_id IS NOT NULL);
```

Yarışta kullanılan satırda `client_message_id` **NULL**'dur. Kısmi indeks
koşulu (`WHERE client_message_id IS NOT NULL`) sağlanmadığı için o indeks bu
satır için **tanım gereği devre dışıdır**. Dolayısıyla ihlal edilebilecek tek
kısıt `uq_msg_conv_wa_message_id`'dir.

Bu çıkarım tahmine bırakılmadı; PostgreSQL'in kendi hata metninden okundu
(bkz. §4.1). İndeks adı ayrıca `ensure_messages_wa_message_id_unique`
(`backend/app/core/migrations.py:1114`) tarafından da üretiliyor; provision
çıktısı `ALREADY_PRESENT` döndü (indeks `create_all` ile modelden gelmişti).

**Kritik ayrıntı:** kısıt `(conversation_id, wa_message_id)` bileşimidir, yalnız
`wa_message_id` değil. Aynı `wa_message_id` farklı bir sohbette meşrudur
(LID→PN anahtar değişimi); bu yüzden global tekillik yanlış olurdu.

---

## 3. Yarışın nasıl senkronize edildiği

### 3.1 Neden `sleep` yok

Rastgele gecikmeyle "yarış ummak" iki şekilde yalan söyler: ya iki işlem
gerçekten çakışmaz (test yeşil, yol ölü), ya da çakışır ama hangi dalın
çalıştığı bilinmez. Bunun yerine kodun **gerçek** bir askıya alma noktası
kullanıldı.

### 3.2 Askıya alma noktası

`_ingest_message` içindeki sıra:

```
pre-flight SELECT  →  INSERT (flush, savepoint)  →  …  →  commit (events.py:2918)
                                                    ↑
                                   `_preview_for_text_message`  (await, satır 1187)
```

`_preview_for_text_message`, INSERT başarıyla flush edildikten **sonra** ve
commit'ten **önce** çağrılan gerçek bir `await` noktasıdır. Test bu globali
`monkeypatch` ile sarar: ilk çağıranda (A) bir `asyncio.Event` set eder ve
ikinci bir `Event`'i bekler. Böylece A, satırı **yazmış ama commit etmemiş**
hâlde durur — unique indeks girdisi tutulmuş, transaction açık.

### 3.3 Determinist sıra

1. **A** başlatılır → pre-flight "yok" görür → INSERT eder → hook'ta durur.
2. Test `inserted` sinyalini bekler (A'nın satırı yazıldı, commit yok).
3. **B** başlatılır → pre-flight A'nın **commit edilmemiş** satırını görmez
   (READ COMMITTED) → INSERT'i A'nın tuttuğu indeks girdisinde **kilitlenir**.
4. Test `pg_stat_activity`'den B'nin gerçekten kilitlendiğini **doğrular**
   (aşağıda). Doğrulamadan A serbest bırakılmaz.
5. `release` set edilir → A döner ve commit eder.
6. B kilitten çıkar, `IntegrityError` alır, kurtarma yoluna girer.

3. adımdaki "pre-flight görmez" ile 5. adımdaki "commit" arasındaki sıra
**testin kontrolündedir**, zamanlamanın değil: A yalnızca B'nin kilitlendiği
gözlemlendikten sonra bırakılır.

### 3.4 Kilitlenmenin kanıtı

Bekleme, yarışı üretmez — yarış zaten kurulmuştur; yalnızca "şimdi bırakırsam B
gerçekten INSERT'in içinde" kanıtıdır. Sorgu:

```sql
SELECT pid, wait_event_type, wait_event, left(query,70)
FROM pg_stat_activity
WHERE wait_event_type = 'Lock' AND state = 'active'
  AND query ILIKE '%INSERT INTO messages%'
ORDER BY query_start LIMIT 1;
```

Gözlemlenen çıktı (her koşuda):

```
[KANIT] B kilitli: pid=93445 Lock/transactionid
        query='INSERT INTO messages (user_id, conversation_id, direction, message_typ'
```

`Lock/transactionid` tam olarak unique indeks çakışmasının tezahürüdür: B,
A'nın transaction kimliğinin bitmesini bekliyor. A bu sırada Python tarafında
beklediği için `idle in transaction`'dır ve filtreye girmez — eşleşme tekildir.
Kilitlenme gözlemlenmezse test **`AssertionError` ile düşer**; sessizce
"geçemez".

---

## 4. `IntegrityError` gerçekten tetiklendi mi?

### 4.1 Hangi kısıt, literal metin

Ham iki transaction ile (ürün kodundan bağımsız) PostgreSQL'in hükmü okundu:

```
[KANIT] PostgreSQL hata metni:
  <class 'asyncpg.exceptions.UniqueViolationError'>:
  duplicate key value violates unique constraint "uq_msg_conv_wa_message_id"
  DETAIL: Key (conversation_id, wa_message_id)=(11, a523-raw-86dd9ebe-…) already exists.
```

Bu, `except IntegrityError` dalının yakaladığı hatanın ta kendisidir
(`asyncpg.UniqueViolationError` → SQLAlchemy `IntegrityError`).

### 4.2 Ürün kodunda tetiklendiğinin kanıtı

`events.py:1087-1092`'deki log satırı **yalnızca** `except IntegrityError`
bloğunun içinde üretilir:

```
Duplicate WhatsApp message ignored (concurrent ingest race):
  conversation_id=%s wa_message_id=%s client_message_id=%s
```

Test bu kaydı `caplog` ile yakalar ve **tam olarak 1** adet olduğunu doğrular
(`len(race_logs) == 1`, `wa_id` eşleşmesiyle). Log satırı sayısı 0 olsaydı test
düşerdi; 2 olsaydı da düşerdi. Yani "yol çalıştı" iddiası, "yol çalışmadı"
ihtimaline karşı korumalıdır.

### 4.3 Kurtarma kazananı gerçekten okudu mu

`_recover_message_new_after_integrity_error` (`events.py:2495`) kazanan satırı
konuşma kapsamı **olmadan** yeniden seçer (LID→PN taşınması durumu için) ve
yayın için o satırı döndürür. Ölçüm:

```
[KANIT] kazanan satır id=33, A sonucu id=33, B sonucu id=33
```

Üç kimlik aynı: kaybeden B, kendi uydurduğu bir satırı değil **kazananın**
satırını döndürdü. Bu aynı zamanda "transaction/session kullanılabilir kaldı"
kanıtıdır — savepoint olmasaydı PostgreSQL `current transaction is aborted`
verir ve bu SELECT `InFailedSQLTransactionError` ile düşerdi.

---

## 5. Assertion sonuçları (tek tek)

Kaynak: `test_append_race_takes_integrity_error_path`

| # | İstenen | Ölçüm | Sonuç |
|---|---|---|---|
| 1 | Tek mesaj kaydı | `count(messages where wa_id)=1`, gövde kazananın | ✅ |
| 2 | İkinci işlem `IntegrityError` yoluna girdi | `race_logs == 1` | ✅ |
| 3 | İkinci işlem güvenli sonuç aldı | `_no_broadcast is True`, `_skip` yok | ✅ |
| 4 | NACK oluşmadı | `_nacks(sock_a)=[]`, `_nacks(sock_b)=[]` | ✅ |
| 5 | Append için ikinci broadcast yok | `broadcast.assert_not_awaited()` → **0** | ✅ |
| 6 | Unread artışı yok | `1 → 1` | ✅ |
| 7 | Preview/timestamp ileri taşınmadı | `preview` aynı, `last_message_at` aynı | ✅ |
| 8 | Webhook ikinci kez gönderilmedi | `_WebhookSpy.calls == []` → **0** | ✅ |
| 9 | Session/transaction kullanılabilir | kurtarma SELECT'i döndü; `idle in transaction = 0` | ✅ |
| 10 | Test sonunda veriler temizlendi | `messages=0`, konuşma yok, `processed_events=0` | ✅ |
| 11 | ACK var | `ACK(A)` ve `ACK(B)` tam olarak birer `gateway_event_ack` | ✅ |

Ek olarak doğrulanan sözleşme: her iki tarafın döndürdüğü sözlük `dict`,
`_skip` yok, `_no_broadcast is True`.

### 5.1 Deney tasarımının kendi kendini yalanlaması (kontrol grubu)

`test_notify_race_still_broadcasts_the_winner` **aynı yarışı** yalnızca tek
değişkeni (`upsert_type`: `append` → `notify`) değiştirerek kurar:

| Ölçüm | append | notify |
|---|---|---|
| `IntegrityError` dalı | 1 | 1 |
| Broadcast | **0** | **2** |
| Rozet | **1 → 1** | **1 → 2** |
| Dış webhook | **0** | **2** |

Aynı mekanizma, zıt sonuç. Bu, append assertion'larının **ölçülen bir şeye**
duyarlı olduğunu gösterir: kod append'i notify gibi işleseydi append testinin
`broadcast == 0`, `webhook == 0`, `rozet 1→1` iddiaları düşerdi. Kontrol grubu
olmadan "0 broadcast" iddiası, broadcast yolunun hiç kurulmadığını da
gösteremezdi.

---

## 6. Test çıktıları

### 6.1 PostgreSQL yarış dosyası

```
$ DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_race_523" \
  PYTHONPATH=. ./venv/bin/python -m pytest backend/tests/test_whatsapp_pg_integrity_race.py \
  -p no:randomly -v -s
```

```
test_raw_unique_violation_names_the_constraint
  [KANIT] B kilitli: pid=93442 Lock/transactionid query='INSERT INTO messages (user_id, conversation_id, direction, message_typ'
  [KANIT] PostgreSQL hata metni: UniqueViolationError: duplicate key value violates
          unique constraint "uq_msg_conv_wa_message_id"
          DETAIL: Key (conversation_id, wa_message_id)=(11, a523-raw-86dd9ebe-…) already exists.
  PASSED
test_append_race_takes_integrity_error_path
  [KANIT] B kilitli: pid=93445 Lock/transactionid query='INSERT INTO messages (user_id, conversation_id, direction, message_typ'
  [KANIT] yarış kuruldu: kazanan satır id=33, A sonucu id=33, B sonucu id=33
  [KANIT] IntegrityError dalı=1 kez · broadcast=0 · ACK(A)=[{...ack, ev_a}] ACK(B)=[{...ack, ev_b}] · NACK=0
  [KANIT] rozet 1->1 · önizleme korundu=True · ts korundu=True · webhook=0
  [KANIT] temizlik: mesaj=0, konuşma=yok, processed_events=0
  PASSED
test_notify_race_still_broadcasts_the_winner
  [KANIT] notify yarışı: IntegrityError=1 · broadcast=2 · rozet 1->2 · webhook=2
  PASSED

3 passed in 1.29s
```

**Determinizm — 5 ardışık koşu:**

```
3 passed in 1.54s
3 passed in 1.35s
3 passed in 1.44s
3 passed in 1.29s
3 passed in 1.69s
```

### 6.2 Non-regression (SQLite — varsayılan `DATABASE_URL`)

```
$ PYTHONPATH=. ./venv/bin/python -m pytest backend/tests/test_whatsapp_upsert_append.py \
    backend/tests/test_whatsapp_pg_integrity_race.py -p no:randomly -q
17 passed, 3 skipped in 1.23s          ← 3 skip = yeni PG testleri (beklenen)

$ ... test_whatsapp_event_idempotency.py test_whatsapp_idempotency_delivery.py \
      test_whatsapp_event_contract_parity.py test_whatsapp_gateway_ack.py \
      test_whatsapp_forensic_fixes.py
59 passed in 1.65s

$ ... backend/tests/ -k whatsapp -p no:randomly -q
943 passed, 7 skipped, 1260 deselected, 218 warnings in 95.89s
EXIT=0
```

`943 passed` — AŞAMA 5.2'deki sayıyla **aynı** (yeni testler SQLite'ta koşmadığı
için passed değişmedi). Skip 4 → **7**: fark tam olarak eklenen 3 PG testi.
Aritmetik kapanıyor: 4 + 3 = 7.

### 6.3 Bulgu F-1 — AŞAMA 5.2 test dosyası PostgreSQL'de koşmuyor

`test_whatsapp_upsert_append.py` PG'ye karşı çalıştırıldığında:

```
10 failed, 7 passed in 3.67s
```

Hataların **hiçbiri** assertion değil (`grep -c "^E +assert"` → **0**); 29 kayıt
şu artefaktı taşıyor:

```
RuntimeError: Task … got Future … attached to a different loop
RuntimeError: Event loop is closed
```

**Kök neden:** `engine` modül düzeyinde ve havuzu süreçler arası yaşar.
`conftest.run_db_migrations` session kapsamlı bir loop'ta bağlantı açar; her
test ise kendi fonksiyon kapsamlı loop'unda koşar. asyncpg bağlantıları loop'a
bağlıdır; havuzdan gelen eski bağlantı yeniden kullanılınca yukarıdaki hata
oluşur. SQLite/aiosqlite bu hatayı göstermez (bağlantı thread tabanlı), bu
yüzden 5.2 testleri SQLite'ta sorunsuz geçer.

**Ürün hatası değildir** — test altyapısı kısıtıdır. Yeni dosya bu yüzden kendi
`_fresh_pool` fixture'ını taşır (`engine.sync_engine.dispose(close=False)`).
`close=False` bilinçli: bağlantıyı kapatmak da ölü loop'ta await edildiği için
aynı hatayı fırlatırdı.

**Öneri (yapılmadı):** aynı fixture `conftest.py`'ye autouse olarak eklenirse
5.2 dosyası da PG'de koşar. Bu, commit edilmiş bir test dosyasını ve paylaşılan
conftest'i değiştirmek demektir; bu aşamanın yetkisi dışında bırakıldı.

---

## 7. Test sonrası DB temizliği

Her test kendi benzersiz telefonunu (`+90…`) kullanır ve sonunda **yalnızca
kendi** satırlarını siler (`_purge`), sonra temizliği **doğrular**:

```
messages=0
conversations=0
contacts=0
whatsapp_sessions=0
whatsapp_private.processed_events=0
```

`processed_events` ayrıca temizlenir çünkü `ingest_gateway_event` her
`event_id`'yi oraya yazar; silinmezse aynı `event_id` ile ikinci koşu
"duplicate" sayılırdı. Silme **yalnızca bu testin kimlikleriyle** yapılır —
tablo tümden boşaltılmaz (paylaşılan bir DB'de bu, başka bir koşunun
idempotency kaydını uçururdu).

`_purge` ayrıca `finally` bloğunda güvenlik ağı olarak tekrar çağrılır; test
ortada düşse bile iş verisi kalmaz.

Veritabanı `tezlify_race_523` sonraki koşular için şemasıyla bırakıldı (28
public tablo + `whatsapp_private` şeması). Yeni bir ortamda yeniden üretmek için
gereken üç adım: `Base.metadata.create_all` →
`ensure_whatsapp_gateway_private_schema` → `ensure_whatsapp_private_lid_and_history_tables`
(+ `ensure_messages_wa_message_id_unique`, burada `ALREADY_PRESENT`).

---

## 8. Git baseline ve dirty durumunun korunması

| Kalem | Aşama başı | Aşama sonu |
|---|---|---|
| Branch | `main` | `main` |
| HEAD | `a4f12d7` | `a4f12d7` (değişmedi) |
| Staged | 0 | **0** |
| Dirty | 78 | **79** |

79 − 78 = **1**: yalnızca bu aşamada yazılan yeni test dosyası
(`?? backend/tests/test_whatsapp_pg_integrity_race.py`). Yeni dosya hariç
tutulduğunda dirty **tam olarak 78** — yani kullanıcıya ait hiçbir girdi
değişmedi, silinmedi, stage edilmedi.

Yapılmayanlar: commit, push, deploy, branch değişikliği, merge/rebase,
`git add` / `git add -A`, `git reset --hard`, `git clean`, `git checkout --`,
stash, container restart, gateway restart, persistence loop, production DB
erişimi, `package.json` değişikliği, üretim kodu değişikliği.

---

## 9. Riskler ve gözlemler

**G-1 — READ COMMITTED bağımlılığı.** Kurtarma yolunun çalışması, kaybedenin
kendi transaction'ında kazananın **yeni commit edilmiş** satırını görmesine
bağlıdır. Ölçülen ayar `default_transaction_isolation = read committed` ve
`database.py` `isolation_level` **ayarlamıyor** (sunucu varsayılanı geçerli).
İzolasyon `REPEATABLE READ`'e çekilirse kurtarma SELECT'i kazananı **göremez**,
`recovered is None` olur ve olay `_skip` ile düşer — mesaj DB'de kalır ama
canlı yayın kaybolur. Bugün gözlenen bir kusur değil; gelecekteki bir yapılandırma
değişikliği için kayıtlı bir bağımlılıktır.

**G-2 — notify yarışında aynı satır iki kez yayınlanıyor (mevcut davranış).**
Kontrol grubunda `broadcast=2`, `webhook=2` ölçüldü: kaybeden de kurtarma
yoluyla **kazananın** satırını yeniden yayınlıyor (id=33, iki kez). Bu AŞAMA
5.2'den önce de böyleydi (kurtarma yolu "balon kaybolmasın" diye vardır) ve
frontend mesajları `id` ile birleştirdiği için kullanıcıya çift balon olarak
yansımaz. **5.2 bunu değiştirmedi.** Append tarafında ise 0 yayın — hedeflenen
davranış. Ürün kararı gerektirir; bu aşamada değiştirilmedi.

**G-3 — `lock_timeout = 10s`.** PG bağlantılarında `lock_timeout: 10000` var
(`database.py:28`). Bekletme bu süreyi aşarsa B `lock timeout` alır ve test
yanlış nedenden düşer. Test bekleme süresi ~20-100 ms; 10 s'lik tavan bilinçli
olarak rapor edilir, gözlenen bir sorun değildir.

**G-4 — `messages.update` yolu.** AŞAMA 5.2.1'de not edilen pre-existing durum
(`socket-events.js:1322` `notify` varsayılanı) bu aşamada da kapsam dışıdır ve
değiştirilmedi.

---

## 10. Karar

```
POSTGRESQL RACE VERIFIED
```

Gerekçe: `IntegrityError` kurtarma yolu **gerçek** bir PostgreSQL unique ihlali
üzerinde, deterministik ve tekrarlanabilir biçimde (5/5) tetiklendi; ihlal eden
kısıt literal PG mesajından okundu; append olayı ikinci kez yayınlanmadı, rozet
artmadı, önizleme/zaman damgası ilerlemedi, dış webhook üretilmedi, ACK verildi,
NACK oluşmadı, tek satır oluştu ve temizlik doğrulandı. Aynı yarışın `notify`
varyantı zıt sonucu vererek ölçümün duyarlı olduğunu kanıtladı.

`TEST INFRASTRUCTURE BLOCKED` **değil**: yarış kuruldu ve yol tetiklendi.
`BUG FOUND — FIX REQUIRED` **değil**: append sözleşmesi ihlal edilmedi; G-1/G-2
kayıtlı riskler ve mevcut davranışlardır.

---

## Ek — Değişen dosyalar

| Dosya | Durum |
|---|---|
| `backend/tests/test_whatsapp_pg_integrity_race.py` | **YENİ** (693 satır, 3 test) |
| `docs/audits/ASAMA-5.2.3-postgresql-race-test.md` | **YENİ** (bu rapor) |

Üretim kodu: **0 değişiklik**. Commit/push/deploy: **yok**.
