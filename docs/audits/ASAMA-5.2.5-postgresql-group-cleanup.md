# AŞAMA 5.2.5 — PostgreSQL grup JID test temizliği düzeltmesi

**Referans commit:** `a4f12d7bcbc407a5288e65658d8287c4e1063044`
**Tarih:** 2026-11-01
**Kapsam:** AŞAMA 5.2.4'te kaydedilen **F-2** bulgusunun düzeltilmesi — grup JID satırlarının test sonrası temizlenememesi
**Sonuç:** `GROUP CLEANUP VERIFIED`

---

## 0. Özet

F-2'nin kök nedeni tek bir yanlış anahtar seçimiydi: temizlik fonksiyonu
`jid_to_phone(jid)` kullanıyordu, oysa kişiyi **yazan** taraf
(`_upsert_contact`) `contact_phone_for_jid(jid)` kullanıyor. Grup JID'lerinde
(`...@g.us`) bu iki fonksiyon ayrışır:

| Girdi | `jid_to_phone` | `contact_phone_for_jid` | DB'de saklanan |
|---|---|---|---|
| `905321234567@s.whatsapp.net` | `+905321234567` | `+905321234567` | aynı ✅ |
| `120367063413400207@g.us` | **`None`** | `jid:120367063413400207@g.us` | **`jid:…@g.us`** ❌ |
| `abc123@lid` | **`None`** | `jid:abc123@lid` | `jid:abc123@lid` ❌ |

`WHERE phone_e164 = NULL` hiçbir satırı eşleştirmez — temizlik **sessizce hiçbir
şey silmez**, test yine de yeşil kalır. Düzeltme, anahtarı tek kaynağa
(`contact_phone_for_jid`) bağladı.

Düzeltme sırasında ikinci bir katman ortaya çıktı: grup testi `_purge`'ü **hiç
çağırmıyordu**; aynı mantığın satır içi bir kopyasını taşıyordu. Yalnız
`_purge` düzeltildiğinde sızıntı **devam etti** (ölçüldü). Satır içi kopya
kaldırıldı ve test `_purge`'e delege edildi.

Sonuç, yedi zorunlu koşunun tamamında **beş tabloda sıfır artık** ile ölçüldü:

| # | Koşu | Sonuç | msg | conv | contact | session | evt | `jid:…@g.us` |
|---|---|---|---|---|---|---|---|---|
| 1 | PG grup testi (yalnız) | 1 passed, 16 deselected | 0 | 0 | 0 | 0 | 0 | **0** |
| 2 | PG 5.2 dosyası (17 test) | 17 passed | 0 | 0 | 0 | 0 | 0 | **0** |
| 3 | PG yarış dosyası (4 test) | 4 passed | 0 | 0 | 0 | 0 | 0 | **0** |
| 4 | PG ikisi birlikte | 21 passed | 0 | 0 | 0 | 0 | 0 | **0** |
| 5 | PG 5 ardışık tekrar | 21 passed ×5 | 0 | 0 | 0 | 0 | 0 | **0** |
| 6 | SQLite 5.2 dosyası (taze DB) | 17 passed | 0 | 0 | 0 | 0 | n/a | **0** |
| 7 | SQLite tam WhatsApp suite | 943 passed / 8 skipped | 2 | 2 | 5 | 0 | n/a | **0** |

Ek olarak rastgele sıra ile iki tohum (`12345`, `777`): **21 passed ×2**,
sıfır artık. Sıra bağımlılığı yok.

Üretim kodu: **0 değişiklik**. Commit/push/deploy: **yok**.

---

## 1. Baseline

| Kalem | Değer |
|---|---|
| Branch | `main` |
| HEAD | `a4f12d7bcbc407a5288e65658d8287c4e1063044` ✅ |
| Staged | 0 ✅ |
| Dirty (başlangıç) | 82 = 78 kullanıcı + 4 (5.2.3/5.2.4 artefaktları) |
| Dirty (bitiş) | 83 = 78 kullanıcı + 5 (+1 = bu fazın düzelttiği test dosyası) |
| Hedef dosya durumu | **temiz** (`a4f12d7`'de commit'li, kullanıcı hunk'ı yok) |
| Test DB | PostgreSQL 17.11, `127.0.0.1:5432`, `tezlify_race_523` |
| DB rolü | `isatezcan` (yerel Homebrew; üretim değil) |

Dirty sayısının 82 → 83 olması beklenen aritmetiktir: bu fazda **tek** dosya
düzenlendi (`backend/tests/test_whatsapp_upsert_append.py`). Kullanıcıya ait 78
girdi değişmedi.

---

## 2. Kök neden — ölçüm

### 2.1 Anahtar ayrışması

```
raw jid          : 120367063413400207@g.us
jid_to_phone     : None
contact_phone_.. : 'jid:120367063413400207@g.us'
DB'de saklanan   : 'jid:120367063413400207@g.us'
ESLESIYOR MU     : True
```

Tek kaynak `backend/app/services/whatsapp/identity.py:164`:

```python
def contact_phone_for_jid(jid: str) -> str:
    if "@g.us" in str(jid):
        return f"jid:{jid}"
    phone = jid_to_phone(jid)
    return phone or f"jid:{jid}"
```

`contact_phone_for_jid`, `jid_to_phone`'un **üstüne** yazılmış bir sarmalayıcı
değil, kuralın kendisi: çevrilemeyen her JID `jid:` sentinel'ine düşer.

### 2.2 Normal JID'de davranış aynı kalıyor

```
905321234567@s.whatsapp.net  jid_to_phone=+905321234567  contact_phone_for_jid=+905321234567  ayni=True
120363000000000001@g.us      jid_to_phone=None          contact_phone_for_jid=jid:…@g.us     ayni=False
abc123@lid                   jid_to_phone=None          contact_phone_for_jid=jid:abc123@lid ayni=False
```

Bu, düzeltmenin **mevcut davranışı bozmadığının** kanıtı: telefon JID'lerinde
iki fonksiyon birebir aynı sonucu veriyor.

### 2.3 Yan bulgu — LID de etkileniyormuş

`abc123@lid` de `None` dönüyor. Yani eski `_purge` yalnız grupta değil,
**LID JID'lerinde de** sessizce hiçbir şey silmiyordu. 5.2 dosyası LID
kullanmadığı için bu yol tetiklenmiyordu; düzeltme onu da kapsıyor.

---

## 3. Sızıntının yeniden üretilmesi (düzeltme öncesi)

Düzeltme öncesi kodla:

```
1 passed
messages=1  conversations=1  contacts=1
artık: jid:120368458861488918@g.us
```

### 3.1 Yalnız `_purge` düzeltmek YETMEDİ

Talimata harfiyen uyup **sadece** `_purge` düzeltildiğinde:

```
1 passed
messages=1  conversations=1  contacts=1
artık: jid:120367063413400207@g.us
```

Sebep: `test_group_message_behaviour_unchanged` `_purge`'ü çağırmıyordu;
kendi **satır içi kopyasını** taşıyordu ve o kopya aynı hatalı anahtarı
kullanıyordu. İki kopya = kural düzeltildiğinde birinin geride kalması.

Bu, "yeşil test ölü bir temizliği gizler" dersinin ikinci katmanı: düzeltmeyi
uyguladıktan sonra **ölçmek** olmasaydı, F-2 kapandı sanılacaktı.

---

## 4. Düzeltme

Tek dosya: `backend/tests/test_whatsapp_upsert_append.py` — **+24 / −17**, üç hunk.

### 4.1 Import — tek kaynak

```diff
-from backend.app.services.whatsapp_service import ingest_gateway_event, jid_to_phone
+from backend.app.services.whatsapp.identity import contact_phone_for_jid
+from backend.app.services.whatsapp_service import ingest_gateway_event
```

`jid_to_phone` artık **çalıştırılabilir hiçbir yerde** kullanılmıyor; dosyada
kalan 3 metinsel anma yalnızca `_purge` docstring'indedir (neden yanlış
olduğunu açıklayan kısım).

### 4.2 `_purge` — anahtar tek kaynağa bağlandı

```diff
-            {"p": jid_to_phone(jid)},
+            {"p": key},
```

`key = contact_phone_for_jid(jid)` bir kez hesaplanıyor ve hem konuşma
arama sorgusunda hem kişi silmede kullanılıyor. Kapsam **genişletilmedi**:
silme hâlâ `phone_e164 = :p` ile tek kişiye, o kişinin konuşmalarına ve o
konuşmaların mesajlarına daraltılmış durumda. Başka tenant'a dokunulmuyor.

### 4.3 Satır içi kopya kaldırıldı

```diff
     finally:
-        async with AsyncSessionLocal() as db:
-            ... (aynı mantığın ikinci kopyası, aynı hatalı anahtarla)
+        # Temizlik `_purge`'e delege edilir. Burada satır içi bir kopya
+        # TUTULMAZ: aynı mantığın iki kopyası olması, anahtar kuralı
+        # düzeltildiğinde birinin geride kalmasına yol açıyordu — grup
+        # testinin artık bırakmasının nedeni tam olarak buydu (F-2).
+        await _purge(group_jid, gw_id)
```

Dosyada `DELETE FROM messages WHERE conversation_id` artık **tek** yerde
geçiyor (`_purge`'ün kendisi). İkinci kopya yok.

---

## 5. Temizliğin ölü olmadığının kanıtı

"Test geçti" tek başına yeterli değil — `_purge` gerçekten **var olan bir
satırı** siliyor mu? Geçici bir ölçüm eklentisi (üretim koduna ve test
dosyasına dokunmaz) `_purge`'ü sardı ve silme öncesi/sonrası saydı:

```
[PROBE] module=test_whatsapp_upsert_append
[PROBE] jid  = 120364835138959480@g.us
[PROBE] key  = jid:120364835138959480@g.us
[PROBE] ONCE  contacts=1 conversations=1 messages=1
[PROBE] SONRA contacts=0 conversations=0 messages=0
[PROBE] toplam _purge cagrisi = 1
```

Tam bir çağrı, doğru anahtar, 1/1/1 → 0/0/0. Temizlik canlı.

### 5.1 Ölçüm hatası — ve düzeltilmesi

İlk denemede PROBE çıktısı **hiç gelmedi** ve test 0.22 s'de bitti. Bu bir
başarısızlık değil, benim ölçüm hatamdı ve sessizce "temiz" saymadım:

`backend/tests/` altında `__init__.py` yok ⇒ pytest modülü **üst düzey**
`test_whatsapp_upsert_append` adıyla içe aktarıyor. Eklenti ise
`backend.tests.test_whatsapp_upsert_append` adını yamalıyordu — **başka bir
modül nesnesi**. Spy hiç çağrılmadı, test normal şekilde geçti.

Düzeltme: yamalama `pytest_collection_modifyitems` içindeki `item.module`
üzerinden yapıldı. Bu, "iki ayna arasındaki parite, ikisinde de eksik olanı
yakalayamaz" kuralının somut bir örneği.

---

## 6. Zorunlu koşular

Her koşudan sonra beş tablo sayıldı: `messages`, `conversations`, `contacts`,
`whatsapp_sessions`, `whatsapp_private.processed_events`.

### 6.1 Koşu 1 — PG grup testi, yalnız

```
1 passed, 16 deselected in 1.24s
messages 0 · conversations 0 · contacts 0 · whatsapp_sessions 0 · processed_events 0
jid:…@g.us 0
```

### 6.2 Koşu 2 — PG, 5.2 dosyasının tamamı

```
17 passed in 2.03s
beş tablo 0 · jid:…@g.us 0
```

Düzeltme öncesi aynı koşu **17 passed + 1 satır artık** veriyordu. Fark tam
olarak F-2.

### 6.3 Koşu 3 — PG yarış dosyası

```
4 passed in 1.53s
beş tablo 0
```

### 6.4 Koşu 4 — PG, iki dosya birlikte

```
21 passed in 2.57s
beş tablo 0 · jid:…@g.us 0
```

### 6.5 Koşu 5 — 5 ardışık tekrar

| Tekrar | Sonuç | msg | conv | contact | session | evt | grup JID |
|---|---|---|---|---|---|---|---|
| 1 | 21 passed (2.46 s) | 0 | 0 | 0 | 0 | 0 | 0 |
| 2 | 21 passed (2.30 s) | 0 | 0 | 0 | 0 | 0 | 0 |
| 3 | 21 passed (2.77 s) | 0 | 0 | 0 | 0 | 0 | 0 |
| 4 | 21 passed (3.40 s) | 0 | 0 | 0 | 0 | 0 | 0 |
| 5 | 21 passed (2.68 s) | 0 | 0 | 0 | 0 | 0 | 0 |

Her tekrarda grup JID'si farklı üretiliyor (`120368458861488918`,
`120367063413400207`, `120364835138959480`, …) — yani temizlik "eski artığı
yakalama" ile değil, her koşuda **yeni yazılanı silme** ile çalışıyor.

### 6.6 Koşu 6 — SQLite, 5.2 dosyası

Depodaki `tezlify.db` kirletilmesin diye taze provision edilmiş DB kullanıldı
(`scripts/provision_test_db.py`, 34 tablo):

```
17 passed in 0.88s
messages 0 · conversations 0 · contacts 0 · whatsapp_sessions 0 · jid:…@g.us 0
```

`processed_events` SQLite'ta yok (private şema PostgreSQL'e ait) — bu yüzden
sayılmadı, "0" diye raporlanmıyor.

### 6.7 Koşu 7 — SQLite, tam WhatsApp suite

```
943 passed, 8 skipped, 1260 deselected, 218 warnings in 97.48s
```

**Taban çizgisiyle birebir aynı** (5.2.4: 943 passed / 8 skipped). Kayıp veya
kazanılan test yok.

Tam suite sonrası taze DB'de kalanlar:

```
messages 2 · conversations 2 · contacts 5 · whatsapp_sessions 0
jid:…@g.us 0   (5.2'nin imzası)
asama52 önekli mesaj 0
```

### 6.8 Koşu 8 — rastgele sıra

Projede `pytest-randomly` yüklü; sıra bağımlılığı için iki açık tohum:

```
seed=12345 → 21 passed in 2.36s → beş tablo 0
seed=777   → 21 passed in 2.21s → beş tablo 0
```

---

## 7. Tam suite'te kalan 5 satırın sahiplendirilmesi

Tam suite sonrası 5 kişi kalıyor. Bunların **5.2 dosyasına ait olmadığını**
iddia etmek yetmez; her birini kaynağına bağladım.

| Kalan kayıt | Kaynak dosya | Kanıt |
|---|---|---|
| `+905321110001`, `+905321110003` | `test_whatsapp_forensic_phase4_g3.py` | Dosya **tek başına** taze DB'de koştu → 16 passed, bu iki satırı bıraktı |
| `+905321112233` | `test_whatsapp_outbound_delete_sync.py` / `test_whatsapp_message_info.py` | İkisi tek başına koştu → 8 passed, bu satırı bıraktı (`PHONE = "+905321112233"` sabiti) |
| `+905356872662` | `test_whatsapp_group_reaction_preview.py:73` | Sabit değer: `phone_e164="+905356872662"` |
| `120363028374928374@g.us` | aynı diğer dosyalar | `jid:` öneki **yok** — 5.2 bu biçimi hiç üretmiyor; 5.2 dışı koşuda da ortaya çıktı |

5.2 dosyasının imzası iki tanedir ve **ikisi de sıfır**:

- kişi anahtarı `jid:<group-jid>@g.us` biçiminde (önekli)
- mesaj kimliği `asama52…` önekli

Ayrıca 5.2 dosyası sabit telefon numarası kullanmıyor; her test
`_new_identity()` ile `+90` + 10 rastgele rakam üretiyor. Bu yüzden 5.2'den
kalan bir satır olsaydı **rastgele** bir `+90…` numarası olurdu — kalan üç
numara ise başka dosyaların sabitleri.

Bunlar bu fazın kapsamı dışında, **önceden var olan** test hijyeni borçlarıdır;
düzeltilmedi ve rapor dışında bırakılmadı.

---

## 8. Regresyon kontrolü

| İddia | Kanıt |
|---|---|
| Üretim kodu değişmedi | `backend/app` altındaki 11 değişiklik kullanıcının önceden var olan dosyaları; **mtime**'ları 2026-10-31 veya 15:34 — hepsi bu fazın düzenlemesinden (17:07) **önce** |
| `conftest.py` davranışı değişmedi | mtime 16:58:33 (5.2.4), 5.2.5'te **dokunulmadı** |
| PG fixture paylaşımlı kalıyor | `conftest.py` diff'i değişmedi → `postgres_fresh_pool` autouse + dialect guard aynen duruyor |
| SQLite davranışı değişmedi | Tam suite 943/8 **birebir aynı**; 5.2 dosyası SQLite'ta 17 passed |
| Başka testin verisi silinmiyor | Silme hâlâ tek `phone_e164` anahtarına dar; kapsam genişletilmedi |
| Kullanıcı dirty hunk'ları korundu | 78 girdi değişmedi; dirty 82 → 83 (+1 = bu test dosyası) |
| Commit / push / deploy yok | HEAD `a4f12d7` sabit, staged 0 |

### 8.1 mtime kanıtı

```
şimdi                                  2026-11-01 17:14:52
backend/tests/test_whatsapp_upsert_append.py   17:07:54   ← 5.2.5
backend/tests/conftest.py                      16:58:33   ← 5.2.4
backend/app/main.py                            15:34:41   ← kullanıcı
backend/app/core/config.py                2026-10-31 00:45:14
backend/app/services/whatsapp/memory_persistence.py  2026-10-31 01:05:12
backend/app/services/whatsapp/orchestration/sync.py  2026-10-31 01:07:51
```

---

## 9. Yapılan dosya değişiklikleri

| Dosya | Tür | Satır |
|---|---|---|
| `backend/tests/test_whatsapp_upsert_append.py` | düzenlendi | +24 / −17 |
| `docs/audits/ASAMA-5.2.5-postgresql-group-cleanup.md` | yeni | bu rapor |

Başka hiçbir dosya bu fazda değişmedi. `package.json`'a dokunulmadı.

---

## 10. Riskler

1. **`contact_phone_for_jid` test tarafında import ediliyor.** Bilinçli: anahtar
   kuralının tek kaynağı odur. Kural üretimde değişirse test onu otomatik takip
   eder — bu istenen davranış. Ama fonksiyonun imzası değişirse test kırılır;
   bu da doğru yerde kırılmadır.
2. **Diğer dosyaların artıkları sürüyor** (Bölüm 7). Bunlar 5.2.5 kapsamı
   dışında; temizlenmedi. Ayrı bir hijyen fazı gerektirir.
3. **`messages.update` yolu** hâlâ `notify` varsayılanını kullanıyor
   (5.2'den bilinen, bu fazla ilgisiz pre-existing durum).

---

## 11. Karar

```
GROUP CLEANUP VERIFIED
```

- Kök neden ölçüldü: `jid_to_phone` grup (ve LID) JID'inde `None` döndürüyor,
  DB'de `jid:` sentinel'i saklanıyor → `WHERE phone_e164 = NULL` hiçbir şey
  silmiyor.
- Düzeltme yalnız test dosyasındadır ve anahtarı tek kaynağa bağlar.
- Yedi zorunlu koşunun **her birinde** beş tablo sıfır, grup JID artığı sıfır.
- Temizliğin canlı olduğu bağımsız olarak ölçüldü (1/1/1 → 0/0/0).
- Tam suite 943/8 — taban çizgisiyle birebir aynı; regresyon yok.
- Üretim kodu, `conftest.py` ve kullanıcı değişiklikleri dokunulmadan korundu.
