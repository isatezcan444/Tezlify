# TEZLIFY WHATSAPP — AŞAMA 3.6 DEVİR NOTU

**Tarih:** 2026-10-28
**Devreden commit:** `9754143` (HEAD = origin/main)
**Üretimde çalışan:** `b5715fe`
**Deploy:** YAPILMADI — sıradaki oturumun **ilk kararı** bu.

---

## 1. Tek cümlelik durum

Kalıcılık boşluğu **kod ve test düzeyinde kapandı** (7080 RAM-only mesajın DB'ye yazılması artık mümkün), PDO timeout'un **sohbet bazlı** olduğu **kanıtlandı**, ama teşhis izleri **deploy edilmediği için** nedeni hâlâ ölçülemiyor.

---

## 2. Sıradaki oturumun İLK işi: deploy sırası

> **Gateway backend'den ÖNCE deploy edilirse bugün RAM'deki 7080 mesaj kalıcı olarak kaybolur.**

Doğru sıra:

1. **Backend-only deploy** (`scripts/deploy/host-release.sh … --no-gateway`).
   - `--no-gateway` bu commit'te **gateway değişikliği olduğu için exit 1 ile REDDEDER**.
   - Bu yüzden backend-only deploy için ya (a) gateway değişikliğini geçici olarak ayrı bir commit'te tutup backend commit'ini deploy etmek, ya da (b) deploy script'ine onaylı bir istisna eklemek gerekir. **Karar kullanıcıya ait.**
2. Deploy sonrası **ilk turu izle**: `/health.whatsapp_memory_persistence` → `last_inserted` ≈ 7080, `last_pages` ≈ 19, `last_duration_ms`.
3. `messages` sayısı 1747 → ~8800'e çıkmalı. `conv 38346` **4'te kalır** (bu doğrudur, hata değildir).
4. Ancak bundan **sonra** gateway deploy'u → bellek kaybı artık veri kaybı değil.
5. Gateway deploy'u `pdo_sent` / `CHUNK_RECEIVED` izlerini açar.

---

## 3. Değişmezler — dokunma

| Kural | Neden burada önemli |
|---|---|
| Gateway'i yeniden oluşturma | A6: `messagesByChat` geri yüklenmez; 7080 mesaj gider |
| Oturumu logout/re-pair etme | QR/auth yeniden gerekir; kullanıcı erişimi kesilir |
| `db` konteynerine dokunma | Hiçbir compose dosyasında yok; `--remove-orphans` veritabanını siler |
| Migration guard'ı zayıflatma | Bu oturumda migration **yok**, guard'a ihtiyaç da yok |
| Watermark'ı atlama | Tek gerçek kayıp ölçüsü: `conversations/messages/max(id)` |

---

## 4. Doğrulanmış gerçekler (tekrar ölçmeye gerek yok)

| Gerçek | Seviye |
|---|---|
| Gateway RAM 9098 mesaj, 7080'i DB'de yok, 16 sohbet | [P] |
| `conv 38346`: RAM == DB == 4 mesaj → kalıcılık kaybı **değil** | [P] |
| PDO arızası **sohbet bazlı**: aynı socket'te 2 sohbet 1.8/2.2 s'de OK, 3 sohbet TIMEOUT | [P] |
| `38346` PN anahtarlı → LID waiter yarışı **elendi** | [P][K] |
| TIMEOUT satırları `provider_exhausted=f`, `has_more=t` | [P] |
| 124/124 sohbetin `phone_e164`'sü dolu → eşleme %100 | [P] |
| Backend testleri 4×1787 passed / 4 skipped (fixed, 424242, 777, 900913) | [T] |

---

## 5. Faz 3.5 raporundaki iki düzeltme

1. **"Mevcut `1bd78836` için `history_sync_states` satırı yok"** → artık **var** (4 satır: 2 HAS_MORE, 2 TIMEOUT; `10-27 20:33` ve `10-28 11:30`). `conv 38346` için hâlâ yok.
2. **"Testler temiz DB'de koşuyor"** → koşmuyordu. `TEST_DB_PATH` tek başına yetmiyordu; `DATABASE_URL` de verilmeli. Artık `conftest` uyuşmazlıkta **RuntimeError** atıyor.

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

Beklenen: her koşumda **1787 passed, 4 skipped**.

---

## 7. Açık uçlar (öncelik sırası)

1. **Backend deploy onayı** (yukarıdaki sıra sorunu çözülmeli).
2. **Gateway deploy onayı** — ancak backend turu tamamlandıktan sonra.
3. **`conv 38346` geçmişi** — kurtarılmadı. Telefonun eski geçmişi hiç göndermediği en tutarlı açıklama; kanıtlanmadı. Kanıt için gateway izleri gerekli.
4. **Gerçek cihaz E2E** — yetkili test hesabı/cihazı yok, BLOCKED.
5. **Süpürme ilk turunun yükü** — 7080 insert; sayfa başına commit var ama ilk tur izlenmeli.

---

## 8. Bu oturumda YAPILMAYANLAR (yanlışlıkla "yapıldı" sanılmasın)

- Gateway deploy **yok**, backend deploy **yok**.
- Üretimde migration, veri temizliği, outbox replay, oturum logout/re-pair **yok**.
- Telefonun döndürmediği hiçbir geçmiş **yazılmadı** (uydurma veri yok).
- Gerçek cihaz E2E **yok**.
- PDO timeout'un nedeni **kesinleşmedi** — yalnızca sohbet bazlı olduğu kanıtlandı.
