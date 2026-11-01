# Kanıt Dizini — AŞAMA 5.3.1b / 5.3.2

Bu dosya, `.gitignore:40` (`*.log`) nedeniyle commit'e giremeyen test loglarının
**birebir alıntılarını** taşır. Amacı kanıtı gizlemek değil, tersine kalıcı hâle
getirmek: loglar silinmedi, olduğu gibi yerelde duruyor; burada yalnız okunabilir
özetleri ve doğrulama hash'leri var.

## Neden bu dosya var

```
$ git check-ignore -v docs/audits/evidence/5.3.1b/t1-initial-sync-chunking.log
.gitignore:40:*.log	docs/audits/evidence/5.3.1b/t1-initial-sync-chunking.log
```

`.gitignore` değiştirilmedi ve `git add -f` kullanılmadı. Bu yüzden `.log`
dosyaları commit dışında kalıyor. Projenin kendi kuralı da bunu destekliyor:

> `# Evidence that must be durable belongs in docs/audits/, not here.`
> — `.gitignore:60`

Yani kalıcı kanıtın `docs/audits/` altında, metin biçiminde durması bekleniyor.

## Doğrulama tablosu

Loglar yerelde şu yollarda duruyor; hash'ler alıntıların hangi dosyaya ait
olduğunu doğrular.

| Dosya | Bayt | sha256 (ilk 16) | Exit |
| --- | --- | --- | --- |
| `provision.log` | 513 | `98e3aca736301a3e` | 0 |
| `t1-initial-sync-chunking.log` | 1653 | `2533273903e89737` | 0 |
| `t2-pagination-contract.log` | 1664 | `b48085e9478e6fc8` | 0 |
| `t3-upsert-append.log` | 1627 | `1c28e8afda9432ea` | 0 |
| `t4-parity.log` | 1797 | `8040e4eef6f9e24b` | 0 |
| `t5-bulk-seq-pagination-guarantees.log` | 4641 | `c2e68da2a364d2c8` | 0 |
| `t6-upsert-notify-append.log` | 1262 | `4de9429e47748529` | 0 |
| `t7-frontend-build.log` | 3753 | `9e503faf97c9955d` | 0 |
| `t8-parity-recheck.log` | 1466 | `7536b5a48afbddeb` | 0 |
| `t0-frontend-one-line.diff` | 521 | `861a700b11e50242` | — |

`t0-frontend-one-line.diff` **ignore edilmiyor** (`git check-ignore` boş döner),
bu yüzden commit'e doğrudan girebilir ve burada tekrarlanmadı.

## Ortam (tüm testlerde aynı)

```
DATABASE_URL = sqlite+aiosqlite:////tmp/tz531_test.db
TEST_DB_PATH = /tmp/tz531_test.db
PYTHONPATH   = .
PYTHONDONTWRITEBYTECODE = 1
```

Python bağımlılıkları ağa çıkmadan, uv önbelleğinden kuruldu:

```
uv run --offline --python 3.13 \
  --with-requirements backend/requirements.txt \
  --with pytest --with pytest-asyncio \
  python -m pytest <test>
```

---

## 1. Veritabanı provision

`provision.log` — birebir alıntı:

```
### CMD: uv run --offline --python 3.13 --with-requirements backend/requirements.txt --with pytest --with pytest-asyncio python scripts/provision_test_db.py
### CWD: /private/tmp/tz531-integration
### DATABASE_URL=sqlite+aiosqlite:////tmp/tz531_test.db
### TEST_DB_PATH=/tmp/tz531_test.db
### PYTHONPATH=.
### START: 2026-11-01T19:32:47Z
provisioned /tmp/tz531_test.db: 34 tables
  history_sync_states: True
  lid_mappings: True
  initial_sync_completed_at: True
### END: 2026-11-01T19:32:49Z
### EXIT: 0
```

## 2. Test 1 — initial sync chunking

`t1-initial-sync-chunking.log` — özet satırı birebir:

```
......                                                                   [100%]
6 passed, 1 warning in 2.24s
### EXIT: 0
```

## 3. Test 2 — pagination contract

`t2-pagination-contract.log`:

```
..........                                                               [100%]
10 passed, 1 warning in 1.15s
### EXIT: 0
```

## 4. Test 3 — upsert append (backend)

`t3-upsert-append.log`:

```
.................                                                        [100%]
17 passed, 1 warning in 10.12s
### EXIT: 0
```

## 5. Test 4 — event contract parity (5.3.1b)

`t4-parity.log`:

```
======================== 12 passed, 1 warning in 1.12s =========================
### EXIT: 0
```

> Karşılaştırma: 5.3.1'de aynı test `2 failed, 10 passed` idi
> (`evidence/5.3.1/t4-parity-FAILED.log`, yerelde). Tek satırlık düzeltmeden
> sonra 12/12.

## 6. Test 5 — bulk seq pagination guarantees (4.17)

`t5-bulk-seq-pagination-guarantees.log` — 32 kontrolün tamamı `ok`, kapanış:

```
  ok - 15a. perChatLimit does NOT truncate a seq page (no silent skip)
  ok - 15b. perChatLimit still truncates in offset mode (legacy behaviour intact)
  ok - R1. concurrent ingest+trim during a drain never duplicates or rewinds
Bulk seq pagination guarantees: PASS (32 checks)
### EXIT: 0
```

## 7. Test 6 — upsert notify/append (gateway)

`t6-upsert-notify-append.log` — 13 kontrolün tamamı `PASS`:

```
  PASS  notify emits message_new with upsert_type=notify
  PASS  notify increments unread
  PASS  append still emits message_new (backend must persist it)
  PASS  append does NOT increment unread
  PASS  append reports the unchanged badge (not a bump)
  PASS  append does not move last_message_preview
  PASS  append does not move last_message_at
  PASS  unknown type is not treated as append
  PASS  unknown type increments unread (notify fallback)
  PASS  socket-events forwards upsert type=append
  PASS  socket-events append does not increment unread
  PASS  socket-events forwards upsert type=notify
  PASS  socket-events notify increments unread
[test-upsert-notify-append] All checks passed
### EXIT: 0
```

## 8. Frontend build (5.3.2)

`t7-frontend-build.log` — projenin kendi komutu (`package.json` → `"build": "tsc && vite build"`):

```
### CMD: npm run build   (package.json: "build": "tsc && vite build")
### CWD: /private/tmp/tz531-integration/frontend
### START: 2026-11-01T19:49:24Z
> tezlify-frontend@1.0.0 build
> tsc && vite build
✓ 1718 modules transformed.
✓ built in 12.43s
### END: 2026-11-01T19:49:48Z
### EXIT: 0
```

`tsc` adımı çıktı üretmeden geçti (hata yok) ve ardından `vite build` başladı;
bu, tip kontrolünün başarılı olduğunu gösterir.

## 9. Parity yeniden kontrolü (5.3.2)

`t8-parity-recheck.log` — yorum düzeltmesinden sonra:

```
### CMD: pytest backend/tests/test_whatsapp_event_contract_parity.py -q --no-header -p no:cacheprovider
### CWD: /private/tmp/tz531-integration
### DATABASE_URL=sqlite+aiosqlite:////tmp/tz531_test.db
### START: 2026-11-01T19:50:02Z
............                                                             [100%]
12 passed, 1 warning in 1.09s
### EXIT: 0
```

> Not: Bu logun `### CMD` satırı yalnız pytest kısmını kaydediyor. Gerçek
> çağrı, §"Ortam" bölümündeki `uv run --offline ... python -m pytest ...`
> sarmalayıcısıyla yapıldı. Log sonradan düzenlenmedi; fark burada açıkça
> yazıldı.

---

## Yerelde kalan (commit dışı) kanıtlar

| Yol | Neden commit dışı |
| --- | --- |
| `docs/audits/evidence/5.3.1/*.log` (6 dosya) | `.gitignore:40` — sonuçları `ASAMA-5.3.1` raporunun §7.2 tablosunda zaten yazılı |
| `docs/audits/evidence/5.3.1b/*.log` (9 dosya) | `.gitignore:40` — özetleri bu dosyada |

Bu dosyalar **silinmedi**. Yerelde kalıcı olarak duruyor; hash'leri yukarıda.
