# TEZLIFY WHATSAPP — AŞAMA 3.1: ÜRETİM DAĞITIMI VE DOĞRULAMA RAPORU

**Tarih:** 2026-10-27, 19:04–19:18 UTC
**Yürütme:** Otonom (SSH üzerinden üretim konağında, `ubuntu@130.162.247.20` / `/opt/tezlify`)
**Hedef commit:** `8cd4223` → **dağıtıldı**, ardından tespit edilen kusur için `9a77206` dağıtıldı.

---

## 1. Sonuç

**`SUCCESS`** — dağıtım gerçekten tamamlandı, hedef commit doğrulandı, gateway ve WhatsApp oturumu
korundu, kritik sağlık kontrolleri geçti.

Tek `BLOCKED` kalem: **gerçek cihaz E2E** (ayrı test hesabı yok, canlı oturuma dokunulmadı).

> **Önemli ayrıntı:** İki ayrı dağıtım yapıldı. Önce istenen `8cd4223`, sonra onun içinde bulunan ve
> `ghost_purge` denetimini ölü koda çeviren kusurun düzeltmesi `9a77206`. Şu anda yayındaki commit
> `9a77206`'dır (ebeveyni `8cd4223`). Her ikisinin de ayrı sürüm kaydı ve geri dönüş etiketi var.

---

## 2. Dağıtım

| # | Commit | Release dizini | Backend imajı | Gateway | Süre | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `8cd4223` | `backups/releases/20261027T190404Z` | `sha256:7c20f3b…` | **değişmedi** (`a1ba2`) | 94 s | `0` |
| 2 | `9a77206` | `backups/releases/20261027T191541Z` | `sha256:3cfdd…` | **değişmedi** (`a1ba2`) | 90 s | `0` |

- Önceki yayın: `a46eb0e` (17:23–17:26 UTC). Yeni: `8cd4223` → `9a77206`.
- **Evet, gerçek dağıtım yapıldı** — script çıktısı `SÜRÜM TAMAM` ile bitti, `RELEASE_EXIT=0`.
- Strateji: `--no-gateway`. Kuru koşu (dry-run) her iki seferde de `DRY_RUN_EXIT=0` verdi ve muhafız
  `gateway muhafizi GECTI` dedi (`8cd4223` için `a46eb0e..8cd4223`, `9a77206` için `8cd4223..9a77206`
  aralığında `whatsapp-gateway/` ve compose dosyaları değişmedi — bağımsız `git diff --quiet` ile de
  doğrulandı).
- **Kuru koşu güvenli:** `--dry-run` yalnızca `.deployed-commit` okur ve `git diff` yapar; `mkdir`,
  `reset --hard`, `docker build`, adacık container, migration ve DB yazımı **hiç çalışmaz**
  (`run()` yardımcısı komutları yazdırır, çalıştırmaz; script 223–228. satırlarda çıkar). Tek eksik:
  `git fetch` de çalışmadığı için SHA'yı doğrulayamaz — bu yüzden fetch konakta **elle** yapıldı.
- Geri dönüş: `bash scripts/deploy/host-release.sh --rollback-to 20261027T191541Z`
  (etiketler `tezlify-backend:pre-20261027T191541Z` / `tezlify-gateway:pre-20261027T191541Z`).

---

## 3. Gateway / WhatsApp

| Ölçüm | Önce | Sonra |
| --- | --- | --- |
| Gateway container id | `5d37669a9671` | **`5d37669a9671`** |
| Gateway `StartedAt` | `2026-10-27T17:25:57.8181699Z` | **`2026-10-27T17:25:57.8181699Z`** |
| Gateway imajı | `sha256:a1ba2572c409…` | **aynı** |
| `gateway_touched` (release.json) | — | `false` (her iki kayıt) |
| Oturum | 200 / `CONNECTED` / `is_phone_online=t` | **200 / `CONNECTED` / `is_phone_online=t`** |
| Gateway `/health` | `{total:1, connected:1, pending_qr:0}` | **aynı**, `database=connected`, `auto_restore=true` |

- **Gateway yeniden oluşturulmadı.** İki dağıtımda da cutover yalnızca `backend` servisine uygulandı
  (`cutover dogrulandi: backend=… gateway=DEGISMEDI`). Bellek içi depo (chats / messagesByChat /
  contacts) **korundu** — §A6 maliyeti ödenmedi.
- **Oturum korundu. QR gerekmedi, yeni pairing başlatılmadı, logout/relink/auth dosyası silme yok.**
- `db` (`a1f8ba6141ec`, 2026-10-01) ve `caddy` (`ab37176c4344`, 2026-10-12) hiç dokunulmadı.

---

## 4. Veritabanı

| Ölçüm | 1. deploy öncesi | 1. deploy sonrası | 2. deploy öncesi | 2. deploy sonrası |
| --- | --- | --- | --- | --- |
| conversations | 123 | **123** | 123 | **123** |
| messages | 1050 | **1050** | 1050 | **1050** |
| contacts | 1535 | **1535** | 1535 | **1535** |
| whatsapp_data_audit | 1 | **1** | 1 | **1** |
| whatsapp_sessions | 1 | **1** | 1 | **1** |

**Fark: sıfır.** Önceki turlarda tekrar eden `124 → 123` düşüşü **bu kez gerçekleşmedi**.

- Üretimde **hiçbir** mesaj/sohbet/kişi/audit kaydı silinmedi veya değiştirilmedi.
  `purge_whatsapp_data` ve `purge_empty_ghost_conversations` **test amacıyla tetiklenmedi**.
- `purge_empty_ghost_conversations` yalnızca `deleted > 0` olduğunda loglar; canlı backend'in açılış
  logunda **böyle bir satır yok** → o çalıştırmada **0 satır sildi** (kullanılabilir negatif kanıt).
- Adacık (candidate) container yine üretim DB'sine karşı tüm migration setini çalıştırdı ve loguyla
  birlikte silindi; ama öncesi/sonrası sayımlar **birebir aynı** olduğu için bu pencerede **veri
  değişmedi** — sayım eşitliği, kayıp logun yerini tutan kanıttır.

---

## 5. Sağlık

| Kontrol | Sonuç |
| --- | --- |
| Backend `/health` (container içi) | `status: healthy` |
| Public `/health` (Caddy üzerinden) | **200**, 27.6 ms |
| `whatsapp_data_audit.failed` | **0** (`last_error: null`) |
| `GET /api/v1/whatsapp/data-audit` (kimliksiz) | **401** (doğru — route canlı ve korumalı) |
| OpenAPI'de route | `/api/v1/whatsapp/data-audit` mevcut |
| `gateway_bridge.connected` | `true` |
| WebSocket heartbeat / pong | `last_pong_at` **19:05:47 → 19:06:27 → 19:17:25** (ilerliyor, donmuş değil) |
| Gateway → backend WS | `[WS-GATEWAY] Baileys gateway bağlandı.` (19:05:27) |
| Backend açılış migration'ları | 23 satır, hepsi `verified` / `ALREADY_PRESENT` — yıkıcı işlem yok |
| Container durumları | 4/4 `running`, `restarts=0` |
| Açılış sonrası artık adacık container | 0 |

---

## 6. Testler

Test DB'si **schema-only** kopya (`/tmp/tz_test.db`, 35 tablo, 0 satır) — geliştirme `tezlify.db`
veritabanına **dokunulmadı** (global satır sayısı iddia eden testler yanlış kırmızı verirdi).

| Komut | Sonuç |
| --- | --- |
| `pytest backend/tests/ -p no:randomly -q` | **1677 passed, 4 skipped, 0 failed** (167 s) |
| `pytest backend/tests/ -q` (rastgele sıra) | **1677 passed, 4 skipped, exit 0** (137 s) |
| `pytest backend/tests/test_whatsapp_data_audit.py` | 16 passed |
| `pytest ... -k "ghost_purge or imported_local"` **fix geri alınmışken** | **3 failed** (yanlışlama) |

- Baseline `1673` + **4 yeni test** → `1677`, **iki sıralamada da**. Suite **sıra bağımsız**.
- Yanlışlama çıktısı, tahmin edilen offset'lerle **birebir**:
  `assert not {'AsyncSessionLocal': (1516, 2074)}`.
- Frontend değişmedi (`0` dosya) → `npm run build` / `tsc` gerekmedi; dağıtım `--frontend-tar`
  almadan yapıldı ve yayındaki bundle değişmedi.

### Dağıtımdan önce bulunan kusur (`8cd4223`)

`main.py` lifespan'ındaki yeni `ghost_purge` denetim bloğu, `AsyncSessionLocal` adını bağlayan
`from backend.app.core.database import AsyncSessionLocal` import'undan (aynı fonksiyonun ilerisindeki
retention bloğu, satır 276) **önce** kullanıyordu. Python'da fonksiyon içi bir import adı **tüm
fonksiyon** için yerel yapar; bu yüzden kullanım `LOAD_FAST_CHECK` (offset 1516) olarak derlendi ve
ilk `STORE_FAST` 2074'te kaldı → **`UnboundLocalError`**, etraftaki `except Exception` tarafından
yutuldu. Sonuç: `ghost_purge` denetim satırı **asla yazılamazdı** ve bunu loglayacak tek yol da
başarısız olan yoldu. (`NameError` değil — "eksik attribute" olarak okunmamalı.)

Düzeltme `9a77206`: blok, import'u **kendi içinde** taşıyan `_record_ghost_purge_audit(deleted)`
yardımcısına çıkarıldı. Davranış aynı: 0 silmede satır yazılmaz.

---

## 7. Açık riskler

1. **Gerçek cihaz E2E: `BLOCKED`.** Ayrı, yetkilendirilmiş bir test hesabı/cihazı yok. Canlı oturuma
   dokunulmadı, QR/pairing başlatılmadı.
2. **Yayındaki commit artık `9a77206`** (`8cd4223` değil). `8cd4223` gerçekten dağıtıldı ve
   doğrulandı (`20261027T190404Z`), ancak içindeki denetim kusuru nedeniyle hemen ardından düzeltmesi
   yayına alındı. `.deployed-commit` bu yüzden `9a77206` gösteriyor.
3. **Adacık container'ın logu hâlâ kayboluyor.** Yıkıcı bir migration bu pencerede çalışırsa
   atfedilemez. Bu kez sayımlar değişmediği için risk gerçekleşmedi; mekanizma aynı duruyor
   (bkz. `reference/production-ops.md` → "The candidate container runs migrations against PRODUCTION").
4. **`ghost_purge` yolu canlıda henüz gözlenmedi.** Canlı açılışta 0 satır silindiği için yeni kod
   yolu tetiklenmedi; doğruluğu testle + konteyner içi bytecode taramasıyla kanıtlandı, üretimde
   gerçek bir silme ile değil (üretimde silme tetiklemek yasak).
5. `whatsapp_data_audit` tablosu, `ghost_purge` bloğundan **sonra** oluşturuluyor
   (`ensure_whatsapp_data_audit_table`, satır ~299). Üretimde tablo zaten var (`ALREADY_PRESENT`),
   taze kurulumda ilk hayalet temizliği denetimsiz kalabilir. Düşük etki; düzeltilmedi.

---

## 8. Kanıt

- **Commit'ler:** `8cd4223` (hedef), `9a77206` (düzeltme, push edildi: `8cd4223..9a77206 main -> main`).
- **Sürüm kayıtları:** `backups/releases/20261027T190404Z/release.json`,
  `backups/releases/20261027T191541Z/release.json` — `live_backend_image` = derlenen imaj,
  `gateway_touched: false`, `frontend: null`.
- **`.deployed-commit`** = `9a772068d38bf5333a696efd198fc20794728c25`; konak checkout temiz
  (`dirty_tracked=0`), `HEAD` aynı SHA.
- **Dosya bütünlüğü (konteyner içi sha256 = git):** `migrations.py` `0c41cbcc8d37`,
  `main.py` `f47742b2…`, `sessions.py` `cf604f90ea54`, `whatsapp_data_audit.py` `cd1b7452dde5`.
  (`verify_blob` yalnız 2 sabit dosyayı kapsar; bu 4 dosya ayrıca hash'lendi.)
- **Canlı bytecode taraması (konteyner içinde):** `LIVE unbound-local offenders: NONE`,
  `helper present: True`.
- **Sağlık/log özetleri:** `status healthy`, `audit_failed 0`, `bridge connected true`,
  `pong 19:17:25`, `sessions {total:1,connected:1,pending_qr:0}`, `restarts=0`.
- Rapora hiçbir SSH anahtarı, token, parola veya `.env` değeri yazılmadı.

---

## 9. Sonraki adım

**Gerçekten gereken tek eylem:** yetkilendirilmiş ayrı bir test hesabı/cihazı sağlandığında gerçek
cihaz E2E'yi (QR eşleştirme + ilk senkron + gelen/giden mesaj) ayrı bir hat üzerinde çalıştırmak.
Canlı hat (oturum 200) buna dahil edilmemeli.

İsteğe bağlı, düşük öncelikli: `ensure_whatsapp_data_audit_table` çağrısını hayalet temizliğinden
önceye almak (madde 7.5).
