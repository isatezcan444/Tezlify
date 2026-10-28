# TEZLIFY WHATSAPP — AŞAMA 3.6 DEVİR NOTU

**Tarih:** 2026-10-28 (akşam güncellemesi)
**Devreden commit:** `0d909ab` + imleç commit'i (HEAD = origin/main)
**Üretimde çalışan:** `b5715fe90d0ff05ef497dcccbc87652efa10ccd1`
**Deploy:** YAPILMADI — sıradaki oturumun **ilk kararı** bu.

> Bu not, 3.6b denetim turundan sonra **düzeltilmiş sayılarla** yeniden yazıldı.
> Önceki sürümdeki "7080 mesaj / 16 sohbet" rakamları **yanlıştı** (bkz. §4).

---

## 1. Tek cümlelik durum

Kalıcılık boşluğu **kod ve test düzeyinde kapandı** (7337 RAM-only mesajın DB'ye yazılması artık
mümkün ve kuyruk erişilebilir), PDO timeout'un **sohbet bazlı** olduğu **kanıtlandı**, ama teşhis
izleri **deploy edilmediği için** nedeni hâlâ ölçülemiyor.

---

## 2. Sıradaki oturumun İLK işi: deploy sırası

> **Gateway backend'den ÖNCE deploy edilirse bugün RAM'deki 7337 mesaj kalıcı olarak kaybolur.**

Doğru sıra:

1. **Backend-only deploy** (`scripts/deploy/host-release.sh … --no-gateway`).
   - `--no-gateway` bu commit aralığında **gateway değişikliği olduğu için exit 1 ile REDDEDER**.
   - Backend-only deploy için ya (a) gateway değişikliğini ayrı tutup backend commit'ini deploy
     etmek, ya da (b) deploy script'ine onaylı bir istisna eklemek gerekir. **Karar kullanıcıya ait.**
2. **`WHATSAPP_MEMORY_PERSIST_ENABLED=false` ile deploy et.** Varsayılan **açık**; flag verilmezse
   ilk tur açılıştan ~90 sn sonra kendiliğinden başlar.
3. `dry_run` tek tur → beklenen ≈ **7337** mi doğrula → flag'i aç.
4. Gerçek turu izle: `last_inserted ≈ 7337`, `last_scanned ≈ 9122`, `last_pages ≈ 19`,
   `max_cursor_offset` (0 = tur sonuna ulaştı).
5. `messages` sayısı **1785 → ~9122** olmalı. `conv 38346` **4'te kalır** (bu doğrudur, hata değildir).
6. Ancak bundan **sonra** gateway deploy'u → bellek kaybı artık veri kaybı değil.
7. Gateway deploy'u `pdo_sent` / `CHUNK_RECEIVED` / `failure_class` izlerini açar.

---

## 3. Değişmezler — dokunma

| Kural | Neden burada önemli |
|---|---|
| Gateway'i yeniden oluşturma | A6: `messagesByChat` geri yüklenmez; 7337 mesaj gider |
| Oturumu logout/re-pair etme | QR/auth yeniden gerekir; kullanıcı erişimi kesilir |
| `db` konteynerine dokunma | Hiçbir compose dosyasında yok; `--remove-orphans` veritabanını siler |
| Migration guard'ı zayıflatma | Bu oturumda migration **yok**, guard'a ihtiyaç da yok |
| Watermark'ı atlama | Tek gerçek kayıp ölçüsü: `conversations/messages/max(id)` |

---

## 4. Doğrulanmış gerçekler (tekrar ölçmeye gerek yok)

| Gerçek | Seviye |
|---|---|
| Gateway RAM **9122** mesaj, **7337**'si DB'de yok, **40** sohbet | [P] |
| DB'deki **1785** mesajın **tamamı** RAM'de ve **doğru** sohbette (DB ⊆ RAM) | [P] |
| RAM'de **0** kopya kimlik, **0** kimliksiz satır, **0** eşlenemeyen JID | [P] |
| Eksik kayıtların **tamamında** geçerli zaman damgası + gönderici var | [P] |
| `conv 38346`: RAM == DB == 4 mesaj → kalıcılık kaybı **değil** | [P] |
| PDO arızası **sohbet bazlı**: aynı socket'te 2 sohbet 1.8/2.2 s'de OK, 3 sohbet TIMEOUT | [P] |
| `38346` PN anahtarlı → LID waiter yarışı **elendi** | [P][K] |
| TIMEOUT satırları `provider_exhausted=f`, `has_more=t` | [P] |
| Backend testleri 4×**1799** passed / 4 skipped (fixed, 424242, 777, 900913) | [T] |

> **DÜZELTME:** önceki notta "RAM 9098 / 7080 RAM-only / 16 sohbet" yazıyordu. O ölçüm gateway'e
> `per_chat_limit=50` ile sorulduğu için sohbet başına son 50 mesajı görüyordu — "DB'de yok" değil,
> "bu pencerede görünmüyor" sayısıydı. Doğru sayı **7337 / 40 sohbet**.

---

## 5. Faz 3.5 raporundaki iki düzeltme

1. **"Mevcut `1bd78836` için `history_sync_states` satırı yok"** → artık **var** (4 satır: 2 HAS_MORE,
   2 TIMEOUT). `conv 38346` için hâlâ yok.
2. **"Testler temiz DB'de koşuyor"** → koşmuyordu. `TEST_DB_PATH` tek başına yetmiyordu; `DATABASE_URL`
   de verilmeli. Artık `conftest` uyuşmazlıkta **RuntimeError** atıyor (fail-closed, 10 errors/0.54 s).

---

## 6. Test koşum komutu (kopyala-çalıştır)

```bash
cd /Users/isatezcan/Documents/Github/Tezlify
source venv/bin/activate && export PYTHONPATH=.
export TEST_DB_PATH=/tmp/tezlify_clean.db
export DATABASE_URL="sqlite+aiosqlite:////tmp/tezlify_clean.db"
for spec in fixed 424242 777 900913; do
  rm -f /tmp/tezlify_clean.db
  python scripts/provision_test_db.py
  if [ "$spec" = "fixed" ]; then
    pytest backend/tests/ -q -p no:randomly
  else
    pytest backend/tests/ -q -p randomly --randomly-seed=$spec
  fi
done
```

> `DATABASE_URL` **şart**. Unutulursa artık sessizce eski `tezlify.db`'ye koşmaz — patlar.

Beklenen: her koşumda **1799 passed, 4 skipped**.

---

## 7. Açık uçlar (öncelik sırası)

1. **Backend deploy onayı** (yukarıdaki sıra sorunu çözülmeli).
2. **Gateway deploy onayı** — ancak backend turu tamamlandıktan sonra.
3. **`conv 38346` geçmişi** — kurtarılmadı. Telefonun eski geçmişi hiç göndermediği en tutarlı
   açıklama; **kanıtlanmadı**. Kanıt için gateway izleri gerekli.
4. **Gerçek cihaz E2E** — yetkili test hesabı/cihazı yok, **BLOCKED**.
5. **Süpürme ilk turunun yükü** — 7337 insert / ~19 sayfa; sayfa başına commit var ama ilk tur izlenmeli.

---

## 8. Bu oturumda YAPILMAYANLAR (yanlışlıkla "yapıldı" sanılmasın)

- Gateway deploy **yok**, backend deploy **yok**.
- Üretimde migration, veri temizliği, outbox replay, oturum logout/re-pair **yok**.
- Telefonun döndürmediği hiçbir geçmiş **yazılmadı** (uydurma veri yok).
- Gerçek cihaz E2E **yok**.
- PDO timeout'un nedeni **kesinleşmedi** — yalnızca sohbet bazlı olduğu kanıtlandı.
- Gateway konteyneri **yeniden oluşturulmadı**; `StartedAt` değişmedi.
