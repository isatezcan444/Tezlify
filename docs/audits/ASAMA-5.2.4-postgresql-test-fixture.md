# AŞAMA 5.2.4 — PostgreSQL test fixture ortaklaştırma

**Referans commit:** `a4f12d7bcbc407a5288e65658d8287c4e1063044`
**Tarih:** 2026-11-01
**Kapsam:** AŞAMA 5.2.3'te doğrulanan `_fresh_pool` yaklaşımının ortak `conftest.py`'ye taşınması
**Sonuç:** `FIXTURE SHARED SAFELY`

---

## 0. Özet

`_fresh_pool` fixture'ı `backend/tests/conftest.py`'ye **tek bir ortak fixture**
olarak taşındı (`postgres_fresh_pool`). Fixture, `engine.dialect.name`'e bakarak
yalnız PostgreSQL'de etkin; SQLite'ta gövdesi ilk satırda `yield`'e düşer ve
**hiçbir şeye dokunmaz**.

Sonuç, tek satırlık bir değişiklikle ölçüldü:

| Koşu | Önce (5.2.3 sonu) | Sonra (5.2.4) |
|---|---|---|
| `test_whatsapp_upsert_append.py` **PostgreSQL'de** | **10 failed / 7 passed** | **17 passed** |
| `test_whatsapp_pg_integrity_race.py` PostgreSQL'de | 3 passed | **4 passed** (kanıt testi eklendi) |
| `test_whatsapp_upsert_append.py` SQLite'ta | 17 passed | 17 passed |
| Tam WhatsApp suite (SQLite) | 943 passed / 7 skipped | **943 passed / 8 skipped** |
| İlgili dedup/contract testleri | 59 passed | **90 passed** (genişletildi) |

943 **passed** sayısı değişmedi; skip 7 → 8 çünkü PG dosyasına bir test eklendi.
Aritmetik kapanıyor.

Üretim kodu: **0 değişiklik**. Commit/push/deploy: **yok**.

---

## 1. Baseline

| Kalem | Değer |
|---|---|
| Branch | `main` |
| HEAD | `a4f12d7bcbc407a5288e65658d8287c4e1063044` ✅ |
| Staged | 0 |
| Dirty | 80 = 78 kullanıcı + 2 (5.2.3 test dosyası + rapor) |
| `conftest.py` durumu | **temiz** (kullanıcı hunk'ı yok) |

`conftest.py`'nin temiz olması kritikti: düzenleme, kullanıcıya ait hiçbir
hunk'a karışmadı. Diff tek ve tamamen eklemeli bir hunk'tır (`@@ -128,0 +129,55 @@`).

---

## 2. Fixture mimarisi — önce / sonra

### 2.1 Önce (5.2.3)

```
backend/tests/
├── conftest.py                          ← ortak fixture'lar (havuz tazeleme YOK)
├── test_whatsapp_upsert_append.py       ← PG'de koşamıyordu
└── test_whatsapp_pg_integrity_race.py   ← kendi `_fresh_pool`'unu taşıyordu
```

Yerel fixture yalnız o dosyayı kurtarıyordu. `test_whatsapp_upsert_append.py`
PG'ye karşı çalıştırıldığında 10 test düşüyordu (hepsi loop artefaktı, 0
assertion hatası). Yani "PG'de koşan test dosyası" sayısı 1'di.

### 2.2 Sonra (5.2.4)

```
backend/tests/
├── conftest.py                          ← postgres_fresh_pool (autouse, dialect-guard'lı)
├── test_whatsapp_upsert_append.py       ← DEĞİŞMEDİ, artık PG'de 17/17
└── test_whatsapp_pg_integrity_race.py   ← yerel kopya KALDIRILDI, ortak fixture'a bağlı
```

- Ortak fixture **tek**: `postgres_fresh_pool`.
- `test_whatsapp_upsert_append.py`'ye **hiç dokunulmadı** (commit edilmiş dosya).
- `test_whatsapp_pg_integrity_race.py`'den yerel `_fresh_pool` kaldırıldı; iki kez
  dispose etmek zararsız ama yanıltıcı olurdu ("bu dosya özel" izlenimi).
- Kullanılmayan `engine` import'u temizlendi.

### 2.3 Fixture'ın kendisi

```python
@pytest.fixture(autouse=True)
def postgres_fresh_pool():
    from backend.app.core.database import engine

    if engine.dialect.name != "postgresql":
        yield
        return

    engine.sync_engine.dispose(close=False)
    yield
    engine.sync_engine.dispose(close=False)
```

---

## 3. Event-loop sorununun kök nedeni

Üç gerçek aynı noktada kesişiyor:

1. **`engine` modül düzeyinde ve süreç boyunca yaşıyor** (`database.py:37`).
   Havuzu (`AsyncAdaptedQueuePool`, `pool_size=10`, `max_overflow=20`) süreç
   belleğinde durur.
2. **pytest-asyncio her test için ayrı bir event loop açıyor.** pytest yapılandırma
   dosyası yok (`pytest.ini`/`setup.cfg`/`pyproject` yok), bu yüzden plugin
   varsayılanı geçerli:
   `asyncio: mode=Mode.STRICT, asyncio_default_test_loop_scope=function`.
3. **asyncpg bağlantıları loop'a bağlıdır.** Bir `Connection`, onu oluşturan
   loop'un `Future`'larına bağlıdır; başka bir loop'ta await edilemez.

Kesişim: `conftest.run_db_migrations` **session** kapsamlı olduğu için ilk
bağlantıları session loop'unda açar. Havuz bunları saklar. Sonra ilk test kendi
loop'unda koşar, havuzdan **eski loop'un bağlantısını** alır ve:

```
RuntimeError: Task … got Future <Future pending> attached to a different loop
```

SQLite/aiosqlite bu hatayı **göstermez**: bağlantı thread tabanlıdır, loop'a
bağlı `Future` taşımaz. Bu yüzden hata yalnız PostgreSQL koşularında ortaya
çıkar ve "testlerim SQLite'ta geçiyor" bilgisi bunu gizler.

Hata testin **teardown**'ında da ikinci kez patlar
(`_terminate_graceful_close` → `Event loop is closed`), bu yüzden tablo
"10 failed" gibi görünür ama tek kök neden vardır.

---

## 4. Neden `close=False`

`engine.dispose(close=True)` (varsayılan) havuzdaki bağlantıları **kapatmaya**
çalışır. asyncpg'de kapatma `await protocol.close()` demektir. Bu, bağlantının
ait olduğu — yani artık ölü — loop'ta yapılmaya çalışılır ve düzeltmeye
çalıştığımız hatanın aynısını üretir:

```
RuntimeError: Task <…_terminate_graceful_close()…> got Future … attached to a different loop
```

`close=False` havuzu **bağlantıları kapatmadan değiştirir**. Sonraki `checkout`
yeni bağlantıyı içinde bulunduğu loop'ta açar. Eski bağlantılar referanssız
kalır ve asyncpg tarafından toplanır.

**Sızıntı ölçümü** (bu iddia ölçüldü, varsayılmadı): 5 ardışık PG koşusundan
sonra `pg_stat_activity`'de bu veritabanına ait **1** bağlantı vardı — o da
sayımı yapan `psql`'in kendisi. Yani sunucu tarafında birikme yok.

```
5 koşu sonrası: select count(*) from pg_stat_activity where datname='tezlify_race_523' → 1
```

---

## 5. Neden `engine.dialect.name`, neden `settings.DATABASE_URL` değil

`settings` çalışma zamanında değiştirilebilir (testler `monkeypatch.setattr(settings, …)`
kullanıyor). `settings.DATABASE_URL`'e bakan bir guard, engine'in gerçekte neye
bağlı olduğunu değil, o an ne **yazdığını** söyler.

`engine.dialect.name` ise engine kurulurken seçilen lehçeyi söyler: asyncpg →
`"postgresql"`, aiosqlite → `"sqlite"`. Guard bu yüzden yanıltılamaz.

---

## 6. Neden autouse (opt-in yerine)

Görev "yalnızca gerekli PostgreSQL testlerinde etkinleştir" diyor. Bunu iki
şekilde okumak mümkündü:

- **(a) opt-in**: her PG testi fixture'ı parametre olarak istesin.
- **(b) dialect-guard'lı autouse**: yalnız engine PostgreSQL ise çalışsın.

**(b) seçildi**, çünkü:

1. **SQLite için davranış gerçekten sıfır.** Guard sağlanmadığında gövde ilk
   satırda `yield`'e düşer — ne havuz değişir, ne bağlantı açılır. Bu, "davranış
   değişmedi" iddiasının kod düzeyinde kanıtıdır.
2. **PostgreSQL'e karşı koşan HER test bu tazelemeye ihtiyaç duyar.** opt-in
   olsaydı, ileride eklenecek bir PG testinin bunu hatırlaması gerekirdi;
   hatırlamadığında hata "test altyapısı" gibi değil "test kırıldı" gibi görünür.
3. **Commit edilmiş `test_whatsapp_upsert_append.py`'ye dokunmadan** 17 testi
   PG'de çalışır hâle getirir — 17 testte fixture istemek yerine tek satır.

**No-op iddiası ölçüldü.** Geçici bir probe (koşudan sonra silindi) havuz
nesnesinin kimliğini iki test arasında karşılaştırdı:

```
SQLite     : [PROBE] dialect=sqlite     once=4522567600 sonra=4522567600 ayni=True
PostgreSQL : [PROBE] dialect=postgresql once=4496540688 sonra=4485883472 ayni=False
```

İki taraflı kanıt: SQLite'ta havuz **aynı** (fixture hiçbir şey yapmadı),
PostgreSQL'de **farklı** (fixture gerçekten çalıştı). Tek taraflı bir test bunu
gösteremezdi — "havuz değişmedi" iddiası, fixture hiç çağrılmadığında da doğru
olurdu.

---

## 7. Çakışma riski analizi

| Risk | Değerlendirme |
|---|---|
| **`:memory:` SQLite** | **Gerçek risk, guard ile kapatıldı.** Havuzu değiştirmek `:memory:` veritabanını uçurur. Guard sayesinde SQLite'ta dispose hiç çağrılmıyor. (10+ test dosyası `:memory:` kullanıyor; hepsi kendi engine'ini kuruyor, uygulama engine'ine dokunmuyor.) |
| **Kendi engine'ini kuran testler** | Etkilenmez — fixture yalnız uygulama `engine`'ini tazeler. |
| **Session kapsamlı fixture'lar** | `conftest.py`'de tek session fixture var (`run_db_migrations`) ve bağlantı **tutmuyor**, sadece migration çalıştırıp bırakıyor. Gelecekte bağlantı tutan bir session fixture eklenirse bu autouse onu bozar — kayıtlı risk (G-1). |
| **Fixture sırası** | `run_db_migrations` session kapsamlı, bu fonksiyon kapsamlı ⇒ her zaman sonra çalışır. İlk testte migration'ların açtığı bağlantılar tazelenir; zararsız. |
| **Bağlantı sızıntısı** | Ölçüldü: 5 koşu sonrası 1 bağlantı. Yok. |
| **SQLite performansı** | Guard sayesinde ek yük yok; tam suite süresi 94.63 s (5.2.3'te 95.89 s — fark gürültü). |
| **Fixture adı çakışması** | `postgres_fresh_pool` yeni bir ad; mevcut fixture adları ve kapsamları değiştirilmedi. |

---

## 8. Yapılan dosya değişiklikleri

| Dosya | Değişiklik |
|---|---|
| `backend/tests/conftest.py` | **+55 satır, 1 hunk, tamamen eklemeli.** `postgres_fresh_pool` fixture'ı + gerekçe docstring'i. Mevcut fixture'lara dokunulmadı. |
| `backend/tests/test_whatsapp_pg_integrity_race.py` | Yerel `_fresh_pool` kaldırıldı (ortak fixture'a bağlandı), kullanılmayan `engine` import'u silindi, **gerçek PG bağlantısını kanıtlayan test eklendi** (`test_engine_is_really_postgresql`). |
| `docs/audits/ASAMA-5.2.4-postgresql-test-fixture.md` | Bu rapor. |

`backend/tests/test_whatsapp_upsert_append.py`: **değişmedi** (git'te temiz).
Üretim kodu (`backend/app/`, `whatsapp-gateway/src/`, `frontend/src/`):
**değişmedi** — 22 girdi, aşama başındaki kullanıcı değişiklikleriyle aynı.

---

## 9. Test sonuçları

### 9.1 PostgreSQL — 5.2 test dosyası (17 test)

```
$ DATABASE_URL="postgresql+asyncpg://isatezcan@127.0.0.1:5432/tezlify_race_523" \
  PYTHONPATH=. ./venv/bin/python -m pytest backend/tests/test_whatsapp_upsert_append.py \
  -p no:randomly -q
17 passed in 1.59s
```

5.2.3'te aynı komut: `10 failed, 7 passed`. Tek değişiklik conftest fixture'ı.

### 9.2 PostgreSQL — yarış dosyası (4 test)

```
$ ... pytest backend/tests/test_whatsapp_pg_integrity_race.py -p no:randomly -v -s
[KANIT] gerçek PG bağlantısı: db=tezlify_race_523 addr=127.0.0.1 pid=95812
        version=PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0
[KANIT] B kilitli: pid=95731 Lock/transactionid query='INSERT INTO messages …'
[KANIT] PostgreSQL hata metni: UniqueViolationError: duplicate key value violates
        unique constraint "uq_msg_conv_wa_message_id"
[KANIT] yarış kuruldu: kazanan satır id=134, A sonucu id=134, B sonucu id=134
[KANIT] IntegrityError dalı=1 kez · broadcast=0 · NACK=0
[KANIT] rozet 1->1 · önizleme korundu=True · ts korundu=True · webhook=0
[KANIT] notify yarışı: IntegrityError=1 · broadcast=2 · rozet 1->2 · webhook=2
4 passed in 1.41s
```

### 9.3 PostgreSQL — ikisi birlikte, determinizm

```
21 passed in 3.16s
21 passed in 3.25s      ← 4/4 ardışık koşu, aynı sonuç
21 passed in 3.15s
21 passed in 3.39s
```

### 9.4 SQLite — davranış değişmedi

```
$ ... pytest backend/tests/test_whatsapp_upsert_append.py \
      backend/tests/test_whatsapp_pg_integrity_race.py -p no:randomly -q -rs
17 passed, 4 skipped in 0.93s
```

Skip gerekçeleri açıkça raporlanıyor (`-rs`):

```
SKIPPED [4] backend/tests/test_whatsapp_pg_integrity_race.py:
  Bu test gerçek PostgreSQL unique index davranışını ölçer; SQLite yazma kilidi
  yarışı serileştirdiği için yol tetiklenemez.
```

### 9.5 Tam WhatsApp suite (SQLite)

```
$ ... pytest backend/tests/ -k whatsapp -p no:randomly -q
943 passed, 8 skipped, 1260 deselected, 218 warnings in 94.63s
EXIT=0
```

5.2.3'te: `943 passed, 7 skipped`. **passed aynı**, skip 7 → 8 = eklenen
`test_engine_is_really_postgresql`. 4 eski skip + 4 yeni PG skip = 8. Aritmetik
kapanıyor ⇒ SQLite davranışı değişmedi.

### 9.6 İlgili dedup / transaction / event contract

```
$ ... pytest test_whatsapp_event_idempotency.py test_whatsapp_idempotency_delivery.py \
      test_whatsapp_event_contract_parity.py test_whatsapp_gateway_ack.py \
      test_whatsapp_forensic_fixes.py test_whatsapp_gateway_boundary.py -q
90 passed in 1.54s
```

---

## 10. Skip veya fallback var mı?

**Hayır.** Üç bağımsız kanıt:

1. **Pozitif bağlantı kanıtı.** `test_engine_is_really_postgresql` sunucuya
   soruyor: `engine.dialect.name == "postgresql"`, `select version()` →
   `PostgreSQL 17.11 …`, `host(inet_server_addr())` → `127.0.0.1`,
   `current_database()` → `tezlify_race_523`. SQLite'ta `select version()` diye
   bir şey yoktur — bu test SQLite'a düşse **düşerdi**, geçemezdi.
2. **Hiç skip yok.** PG koşusunda `-v` çıktısı 21 satırın tamamında `PASSED`;
   `s`/`SKIPPED` yok. (Bu testler SQLite'ta 4 `SKIPPED` olarak görünür — yani
   skip ile pass ayırt edilebilir durumda.)
3. **SQLite dosyasına düşüş yok.** PG koşusu sırasında `./tezlify.db`'nin
   mtime'ı **değişmedi**:

```
ONCE : 1793541803 Nov  1 17:03:23 2026 12410880
SONRA: 1793541803 Nov  1 17:03:23 2026 12410880
degisti mi: HAYIR
```

Ayrıca PG koşularında veriler `tezlify_race_523` içinde oluştu ve orada
temizlendi (bkz. §11) — başka bir yere yazılmadı.

---

## 11. Test DB temizliği

### 11.1 Yeni yarış dosyası: tam temiz

Test içinde doğrulanıyor (`assert await _message_count(wa_id) == 0` vb.):

```
[KANIT] temizlik: mesaj=0, konuşma=yok, processed_events=0
```

### 11.2 Bulgu F-2 — 5.2 dosyası grup satırını bırakıyor

Tüm PG koşularından sonra veritabanında **9 artık** bulundu; hepsi grup
sohbetiydi:

```
jid:120362127620177430@g.us | conv 35 | 1 mesaj
jid:120368221626272053@g.us | conv 40 | 1 mesaj
… (9 satır)
```

**Kök neden ölçüldü:**

```
jid_to_phone('120362127620177430@g.us') = None
saklanan phone_e164                     = 'jid:120362127620177430@g.us'
eşleşir mi                             : False
```

`_purge` (`test_whatsapp_upsert_append.py:105`) satırları
`DELETE … WHERE phone_e164 = :p` ile siliyor ve `:p = jid_to_phone(jid)`. Grup
JID'i için bu değer **None**; `WHERE phone_e164 = NULL` hiçbir satırı eşleştirmez.
Dolayısıyla `test_group_message_behaviour_unchanged` her koşuda bir grup
konuşması bırakır.

**Ölçüm:** 4 PG koşusu → **4** grup satırı (**1/koşu**), grup dışı artık **0**.
Yani sızıntı tam olarak o tek testten ve tam olarak koşu başına bir satır.

**Neden şimdi göründü:** dosya PG'de daha önce hiç koşmuyordu (§2.1). SQLite'ta
artıklar paylaşılan dosyada birikiyordu ama görünmüyordu.

**Neden düzeltilmedi:** düzeltme commit edilmiş `test_whatsapp_upsert_append.py`
içinde `_purge`'ü değiştirmek demek. Bu aşamanın kapsamı fixture ortaklaştırma;
kapsamı büyütmemek için yalnız raporlandı. Önerilen tek satırlık düzeltme:

```python
# _purge içinde, telefon anahtarına ek olarak jid anahtarı:
await db.execute(text("DELETE FROM contacts WHERE phone_e164 IN (:p, :j)"),
                 {"p": jid_to_phone(jid), "j": f"jid:{jid}"})
```

### 11.3 Son durum

Artıklar elle temizlendi ve doğrulandı:

```
messages=0  conversations=0  contacts=0  whatsapp_sessions=0  processed_events=0
```

Veritabanı `tezlify_race_523` şemasıyla bırakıldı (28 public tablo +
`whatsapp_private`), sonraki koşular için hazır.

---

## 12. Kullanıcı dirty değişikliklerinin korunma kanıtı

| Kalem | Aşama başı | Aşama sonu |
|---|---|---|
| HEAD | `a4f12d7` | `a4f12d7` (değişmedi) |
| Branch | `main` | `main` |
| Staged | 0 | **0** |
| Dirty | 80 | **82** |
| **Kullanıcı girdileri** | **78** | **78** |

82 = 78 kullanıcı + `conftest.py` (M) + `test_whatsapp_pg_integrity_race.py` (??)
+ `ASAMA-5.2.3-…md` (??) + `ASAMA-5.2.4-…md` (??). Benim dışımdaki her şey
filtrelendiğinde **tam 78**.

`conftest.py` aşama başında **temizdi**; yani eklediğim 55 satır hiçbir kullanıcı
hunk'ına karışmadı. Diff tek hunk: `@@ -128,0 +129,55 @@` — saf ekleme, silme
yok, mevcut fixture'ların adı/kapsamı değişmedi.

`test_whatsapp_upsert_append.py` git'te **temiz** (dokunulmadı).

---

## 13. Riskler

**G-1 — Gelecekteki session kapsamlı bağlantı tutan fixture.** Autouse fixture
her testten önce havuzu değiştirir. Bir gün session kapsamlı bir fixture açık
bağlantı tutarsa, o bağlantı ilk testte düşer. Bugün böyle bir fixture yok
(`run_db_migrations` bağlantı tutmuyor). Gerekirse o fixture `postgres_fresh_pool`'a
bağımlı yazılmalı veya `scope="function"`'a çekilmeli.

**G-2 — `:memory:` SQLite'ın korunması guard'a bağlı.** Guard kaldırılırsa
(yalnız `autouse=True` bırakılırsa) `:memory:` kullanan testler şemayı
kaybederdi. Guard, fixture'ın **anlamının** parçasıdır; yorumda bu yazılı.

**G-3 — F-2 (grup satırı sızıntısı).** §11.2. Ürün davranışı değil, test
temizliği. PG'de biriken satırlar, konuşma kimliği varsayan testler için
zamanla yan etki üretebilir.

---

## 14. Karar

```
FIXTURE SHARED SAFELY
```

Gerekçe: fixture tek bir ortak tanıma taşındı; SQLite'ta **ölçülmüş** bir no-op
(havuz kimliği aynı kaldı), PostgreSQL'de **ölçülmüş** biçimde etkin (havuz
kimliği değişti, 21/21 test geçti, 4/4 koşu deterministik). SQLite tam suite
`943 passed` ile **birebir aynı** kaldı; skip artışı yalnızca eklenen testten.
Üretim kodu değişmedi, kullanıcıya ait 78 girdi korundu, test veritabanı temiz.
Gerçek PG bağlantısı pozitif olarak kanıtlandı (skip/fallback yok).

`FIXTURE MUST REMAIN LOCAL` **değil**: ortaklaştırma 5.2 dosyasını 10
başarısızlıktan 17/17'ye taşıdı ve SQLite'ta hiçbir maliyet üretmedi.

`TEST INFRASTRUCTURE BLOCKED` **değil**: hem PG hem SQLite koşuları tamamlandı.
