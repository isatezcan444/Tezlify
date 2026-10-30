# AŞAMA 3.9.18 — SAATLİK RAM SNAPSHOT SİSTEMİNİN KONTROLLÜ PRODUCTION DEVREYE ALINMASI

**Tarih:** 2026-10-30
**Kapsam:** ilk gerçek snapshot'ın production'dan alınması ve kanıtlanması
**Sonuç:** **ilk gerçek snapshot BAŞARILI** — `status=OK`, `exit_code=0`, `remote_verified=true`
**Timer durumu:** **KURULMADI, ETKİNLEŞTİRİLMEDİ** (onay bekliyor)
**Deploy:** yapılmadı · **Persistence:** kapalı (`enabled=null`) · **Gateway restart:** 0

---

## GENEL SONUÇ

Sistem ilk kez gerçek production verisiyle uçtan uca çalıştırıldı ve **çalıştı**: 9.154 RAM mesajı
şifrelenip yerel diske atomik olarak yayımlandı, OCI'ya yüklendi, geri indirilip SHA-256 ile
karşılaştırıldı. Kabul için şart koşulan iki koşul **birlikte** görüldü:

```
status = OK        remote_verified = true
```

Ama bu sonuca **tek koşumda** ulaşılmadı. İlk iki koşum `DEGRADED_LOCAL_ONLY` (exit 4) verdi ve
**iki gerçek hata** ortaya çıkardı — ikisi de `offsite_oci.py`'nin stdout biçimini yanlış
ayrıştırmaktan kaynaklanıyordu. Hatalar canlı koşumda bulundu, düzeltildi ve düzeltmeler
mutasyon testiyle kanıtlandı. Bu, 3.9.17'deki 43 testin neden bu hatayı yakalayamadığını da
açıklıyor: testler **sahte** bir uploader kullanıyordu.

Üç bağımsız engel de dürüstçe kaydedildi:

| # | Engel | Durum |
|---|---|---|
| 1 | Reçetede verilen ön kontrol yolu production'da **yok** (`RC=127`) | **BLOCKED** — 3.9.17 deploy edilmemiş |
| 2 | systemd biriminin `ExecStart` hedefi production'da **yok** | **BLOCKED** — timer şimdi kurulursa her saat düşer |
| 3 | OCI bucket kotası doğrulanamadı | **BLOCKED** — okuma izni yok, uydurulmadı |

---

## 1. GIT VE PRODUCTION — BAŞLANGIÇ VE BİTİŞ DEĞERLERİ

Aşamanın başında ve sonunda **salt okunur** ölçüm alındı. Hiçbir değer değişmedi.

### Yerel depo

| Ölçüm | Başlangıç | Bitiş |
|---|---|---|
| `main` HEAD | `5b7f76f` | `5b7f76f` (bu rapor commit'lenene kadar) |
| Çalışma ağacı | 2 dosya değişik (`hourly_snapshot.py`, `test_hourly_snapshot.py`) | aynı + bu rapor |
| `origin/main` | `5b7f76f` | `5b7f76f` |

### Production (`/opt/tezlify`)

| Ölçüm | Başlangıç | Bitiş |
|---|---|---|
| `git rev-parse --short HEAD` | `5cd3eae` | `5cd3eae` |
| `.deployed-commit` | `cbe4f509f` | `cbe4f509f` |
| `tezlify-gateway` | Up, healthy, restart **0** | aynı, restart **0** |
| `tezlify-backend` | Up, healthy, restart **0** | aynı, restart **0** |
| `tezlify-db` | Up, healthy, restart **0** | aynı, restart **0** |
| `tezlify-caddy` | Up, healthy, restart **0** | aynı, restart **0** |
| `ram-snapshot` timer sayısı | **0** | **0** |

**Kritik tespit:** `/opt/tezlify` HEAD `5cd3eae`, deploy edilen commit `cbe4f509`. Yani **3.9.17
production'a deploy EDİLMEMİŞ**. Bu, aşağıdaki iki engelin de kökeni.

---

## 2. ÖN KONTROL (PREFLIGHT) — 11 KONTROL

### Reçetedeki komut çalışmadı — ve bu gizlenmedi

Reçete şunu istiyordu:

```bash
cd /opt/tezlify/monitoring/systemd && ./install-ram-snapshot-timer.sh
```

Gerçek sonuç:

```
RC=127
./install-ram-snapshot-timer.sh: No such file or directory
```

Sebep: dosya production'da **yok**. `ls /opt/tezlify/monitoring/systemd/` yalnızca iki mevcut
birimi listeliyor — `tezlify-monitor.*` ve `tezlify-wa-observer.*`. `ram-snapshot` birimleri ve
kurulum betiği hiç orada değil.

Bu bir "beklenmedik hata" değil, **3.9.17'nin deploy edilmemesinin doğrudan sonucu**. Sonucu
uydurmak yerine **BLOCKED** olarak kaydediyorum.

### Ön kontrol nerede çalıştırıldı

Kapıları zayıflatmadan ilerlemek için betiğin **git'teki** hâli production'a SHA-256 ile
doğrulanarak geçici bir dizine alındı ve oradan çalıştırıldı. `/opt/tezlify` **hiç dokunulmadı**.

```
/tmp/tz3918/            (mode 700, ubuntu)
```

### 11 kontrolün sonucu

| # | Kontrol | Sonuç |
|---|---|---|
| 1 | Betik mevcut + host `python3 -m py_compile` | **PASS** |
| 2 | Git tutarlılığı | **PASS** |
| 3 | `docker` mevcut | **PASS** |
| 4 | `tezlify-backend` çalışıyor | **PASS** |
| 5 | `GATEWAY_ENCRYPTION_KEY` tanımlı (**değeri yazdırılmadan**) | **PASS** |
| 6 | Yedek dizini `0700` | **PASS** (`drwx------ ubuntu`) |
| 7 | Boş alan ≥ 6 GiB | **PASS** (52 G) |
| 8 | Çakışan timer yok | **PASS** |
| 9 | Birim dosyaları mevcut | **PASS** (geçici kopyada) |
| 10 | Mevcut `tezlify-ram-snapshot` timer'ı yok | **PASS** (0) |
| 11 | Hiçbir şey değiştirilmedi | **PASS** |

**Sınıflandırma: PARTIAL.** 11 kontrolün hepsi geçti, ama reçetedeki *yol* çalışmadı. Kapılar
gevşetilmedi; yalnızca aynı betik farklı bir dizinden koştu.

---

## 3. İLK GERÇEK SNAPSHOT — KONTROLLÜ ÇALIŞTIRMA

### CLI argümanları kaynaktan doğrulandı

Reçetedeki komut ile kaynak arasında fark olup olmadığı **tahmin edilmedi**, okundu. `run`
alt komutunun gerçek bayrakları: `--execute`, `--bucket`, `--prefix`, `--log`, `--source`,
`--container`, `--key-env`, `--no-upload`, `--retries`, `--timeout`. Reçetedeki komut kaynakla
uyumlu.

### Üç koşum gerekti — ilk ikisi temiz değildi

#### Koşum 1 — `tezlify-ram-20261030T115408Z`

```
status = DEGRADED_LOCAL_ONLY      exit_code = 4
error  = "dry-run: UploadFailed: offsite ciktisi JSON degil"
```

Snapshot **yerelde başarıyla yayımlandı** (9.154 kayıt / 100 sohbet / 7.186.048 B /
`c8578033…00cb`), ama yükleme adımı düştü.

**Kök neden:** `offsite_oci.py upload` stdout'a önce plan JSON'unu, **ardından**
`[DRY-RUN] ...` banner metnini basıyor. Eski kod `json.loads(text[start:])` çağırıyordu; sondaki
serbest metin yüzünden ayrıştırma patlıyordu.

**Neden 43 test yakalamadı:** testler `OffsiteUploader`'ı sahte bir nesneyle değiştiriyordu.
Gerçek stdout biçimini hiç görmüyorlardı. Bu, testin kendi kör noktasıydı — düzeltme sonrası
gerçek biçimi besleyen testler eklendi.

#### Koşum 2 — `tezlify-ram-20261030T115524Z`

```
status = DEGRADED_LOCAL_ONLY      exit_code = 4
upload_status = UNKNOWN
```

Ama bucket **gerçekten doldu**: 12 nesne / 42.933.155 B. Yani yükleme **başarılıydı**, rapor
yanlıştı.

**Kök neden:** `offsite_oci.py upload --execute` stdout'a **iki** JSON belgesi basıyor — önce
plan (`{"bucket":..,"plan":..}`), sonra sonuç (`{"results":[..]}`). `raw_decode` yalnızca
**ilk** değeri aldığı için `results` hep boş görünüyordu ve başarılı yükleme `UNKNOWN` diye
raporlanıyordu.

#### Düzeltme

`json.loads`/tek `raw_decode` yerine, metindeki **tüm** üst düzey JSON nesnelerini sırayla
çözen bir tarayıcı eklendi ve **son** nesne alındı:

```python
def _iter_json_objects(text: str) -> Iterable[Dict[str, Any]]:
    """Metindeki TUM ust duzey JSON nesnelerini sirayla dondurur."""
    decoder = json.JSONDecoder()
    idx, n = 0, len(text)
    while idx < n:
        start = text.find("{", idx)
        if start < 0:
            return
        try:
            obj, end = decoder.raw_decode(text, start)
        except ValueError:
            idx = start + 1
            continue
        if isinstance(obj, Mapping):
            yield dict(obj)
        idx = end
```

```python
docs = list(_iter_json_objects(text))
if not docs:
    raise UploadFailed(...)
# SON JSON nesnesi: once plan, sonra sonuc basilir.
return docs[-1]
```

Ek olarak, `build_manifest()` üretmediği için **her zaman `null`** yazacak olan
`ram_total_reported` alanı log şemasından çıkarıldı — kalıcı olarak boş bir alanı log'da tutmak
yanıltıcı olurdu.

#### Koşum 3 — `tezlify-ram-20261030T115656Z` ✅

```json
{"status": "OK", "name": "tezlify-ram-20261030T115656Z", "exit_code": 0,
 "detail": {"record_count": 9154, "chat_count": 100,
            "rsnap_bytes": 7186048, "manifest_bytes": 16956,
            "rsnap_sha256": "b5a6e9e2…234a",
            "upload_status": "UPLOADED", "remote_verified": true},
 "error": null}
```

`RC=0`, süre **11,59 s**. Kabulün iki koşulu birlikte sağlandı.

---

## 4. 14 KABUL KRİTERİ

`status=OK` **ve** `remote_verified=true` birlikte görülmeden kabul verilmedi.

| # | Kriter | Sonuç | Kanıt |
|---|---|---|---|
| 1 | Görev `status=OK` | **PASS** | `exit_code=0`, `error=null` |
| 2 | `remote_verified=true` | **PASS** | log satırı 3 |
| 3 | Yerel `.rsnap` var, izni `0600` | **PASS** | `-rw------- ubuntu` |
| 4 | Manifest var, izni `0600` | **PASS** | `-rw------- ubuntu` |
| 5 | Yerel SHA-256 yeniden hesaplandı, eşleşti | **PASS** | `b5a6e9e2…234a` |
| 6 | Manifest `kind`/`record_count`/`chat_count` doğru | **PASS** | `tezlify.ram_snapshot` / 9154 / 100 |
| 7 | `shortfall_sum=0` (eksik sayfalama yok) | **PASS** | 0, `collected_sum=9154` |
| 8 | `unstable_chats` boş, `late_arrival_count=0` | **PASS** | `[]`, 0 |
| 9 | `duplicates_removed=0`, `rejected_*=0` | **PASS** | 0 / 0 / 0 |
| 10 | Bağımsız konteyner içi `--verify` → `ok:true` | **PASS** | tüm problem listeleri boş, hash'ler eşleşti, `RC=0` |
| 11 | Geri yükleme kapısı postgres'i **reddetti** | **PASS** | `REDDEDILDI: DATABASE_URL postgres…`, `RC=1` |
| 12 | Belleğe geri yükleme kimliği korudu | **PASS** | 9154/9154, 100 sohbet, `identity_set_equal=true`, `identity_root_matches=true` |
| 13 | Uzak kopya geri indirilip SHA karşılaştırıldı | **PASS** | `--download-check` → **VERIFIED** (iki dosya) |
| 14 | Eski snapshot'lar bozulmadı | **PASS** | 5 orijinal, boyut+timestamp değişmedi |

**Koşum 1'in yetim kalan snapshot'ı** da sonradan yüklendi (200 / 0,08 s + 0,27 s) ve
`--download-check` ile **VERIFIED** döndü — yani ilk koşumun ürettiği veri de kaybolmadı.

**Bucket son durumu:** 16 nesne / 57.339.163 B / `escrow_izi = YOK`.

---

## 5. PRODUCTION SAĞLIK KONTROLÜ — ÖNCE / SONRA

| Ölçüm | Önce | Sonra | Değişim |
|---|---|---|---|
| Konteyner kimlikleri | 4 ayakta | **aynı 4** | yok |
| Restart sayacı (gw/be/db/caddy) | 0/0/0/0 | **0/0/0/0** | **0** |
| WhatsApp oturumu | 1/1 connected, `pending_qr=0` | **1/1 connected, `pending_qr=0`** | yok |
| Gateway RAM mesaj | 9.154 | **9.154** | **0** |
| DB `conversations/contacts/messages/quarantine` | 126/1538/2248/0 | **126/1538/2251/0** | +3 mesaj (canlı trafik) |
| `whatsapp_memory_persistence.enabled` | `null` | **`null`** | **kapalı** |
| Disk (`/`) | 45G dolu / 52G boş / %47 | **aynı** | yok |
| `ram-snapshot` timer | 0 | **0** | **yok** |

Mesaj sayısındaki **+3** bir yazma yolu değil, gelen canlı WhatsApp trafiğidir; RAM sayısı
değişmediği için snapshot'ın okuduğu küme de değişmedi (kapanış dry-run ölçümü de **9154**
verdi).

### Eski snapshot'lar — byte düzeyinde dokunulmadı

| Dosya | Boyut | Durum |
|---|---|---|
| `…20261029T125657Z.rsnap` | 7.100.080 | değişmedi |
| `…20261029T125755Z.rsnap` | 7.100.080 | değişmedi |
| `…20261029T210007Z.rsnap` | 7.135.835 | değişmedi |
| `…20261029T220302Z.rsnap` | 7.147.070 | değişmedi |
| `…20261030T094753Z.rsnap` | 7.181.099 | değişmedi |

Dizin son durumu: **8 `.rsnap` + 8 `.manifest.json`** + 2 anahtar-escrow dosyası
(`.key-escrow` 90 B, `.key-escrow-v2` 88 B). `.incoming/` boş, `.snapshot.lock` (29 B) duruyor —
**stale kilit değil**: `flock` dosya tanıtıcısı üzerindedir, süreç ölünce kernel bırakır.

---

## 6. LOG SIZINTI DENETİMİ

`/var/backups/tezlify-ram/snapshot.jsonl` — 3 satır, izin `600`, sahibi `ubuntu`.

| Denetim | Sonuç |
|---|---|
| Whitelist dışında alan | **0** |
| `@s.whatsapp.net` / `@g.us` / `wamid` / `@lid` / `@broadcast` | **0** |
| `bearer` / `signature=` / `BEGIN … PRIVATE` / `password` | **0** |
| Mesaj içeriği / anahtar / token | **0** |

Log alanları yalnızca: `ts, status, exit_code, name, record_count, chat_count, rsnap_bytes,
manifest_bytes, rsnap_sha256, upload_status, remote_verified, attempts, seconds, error`.

**Not:** `rsnap_sha256` bir **özet**tir, anahtar değil — snapshot'ın kendisini doğrulamak için
gereklidir ve tek başına veriyi geri getirmez.

---

## 7. TEST KAPISI

Zorunlu sıra uygulandı: **önce** `scripts/provision_test_db.py`, **sonra** pytest.

### Provizyon

```
provisioned /tmp/tezlify_clean.db: 34 tables
  history_sync_states: True
  lid_mappings: True
  initial_sync_completed_at: True
```

Bu adım atlanırsa `history_sync_states` testlerin içindeki `CREATE TABLE IF NOT EXISTS`
bloklarıyla kurulur ve **farklı kolon kümeleri** çakışır (`no such column: error_count`). 3.9.16'da
tam bu yaşandı; bu kez atlanmadı.

### Tam suite

```
2134 passed, 4 skipped, 470 warnings in 161.97s
```

Beklenti **2080 + 54 = 2134** idi; tam tuttu. Regresyon yok.

### Sıra bağımlılığı kontrolü

| Koşum | Sonuç |
|---|---|
| `test_hourly_snapshot.py` tek başına | **54 passed** |
| `-p no:randomly` ile | **54 passed** |

Yeni modül küresel önbellek veya sıra bağımlılığı getirmedi.

### Testler gerçekten koruyor mu — 2 mutasyon

Geçen seferki hatanın sebebi sahte uploader'dı. Bu kez **gerçek stdout biçimini** besleyen
testler eklendi ve mutasyonla kanıtlandı:

| Mutasyon | Sonuç |
|---|---|
| `return docs[-1]` → `return docs[0]` | **2 failed**, 52 passed |
| `_iter_json_objects` → eski `json.loads` | **3 failed**, 51 passed |

Mutasyonlar tam olarak arızayı tarif eden testleri düşürdü. Dosya geri yüklendi ve
**byte-identical** doğrulandı:

```
96fb274ab2c68760fcce567b95b2e2e50261ff8a6c84f95c965bdb8b5e8929c6  scripts/backup/hourly_snapshot.py
96fb274ab2c68760fcce567b95b2e2e50261ff8a6c84f95c965bdb8b5e8929c6  /tmp/tz3918_orig.py
```

`grep -c MUTASYON` → **0**.

---

## 8. SYSTEMD KURULUM PLANI — VE GERÇEK ENGEL

### 🔴 ENGEL: birimin hedefi production'da yok

```
$ ls -l /opt/tezlify/scripts/backup/hourly_snapshot.py
ls: cannot access '…': No such file or directory

$ ls -l /opt/tezlify/scripts/backup/offsite_oci.py
ls: cannot access '…': No such file or directory
```

Birim şu komutu çalıştırıyor:

```
ExecStart=/usr/bin/python3 /opt/tezlify/scripts/backup/hourly_snapshot.py run --execute …
```

Bu dosya **yok**. Timer bugün kurulursa **her saat başarısız** olur. Üstelik betik
`offsite_oci.py`'yi de çağırıyor, o da yok.

Bu yüzden **timer kurulmadı**. Kurmak, çalışmayan bir birimi production'a yerleştirmek olurdu.

**Çözüm iki yoldan biri — ikisi de ayrı onay ister:**

- **(A)** 3.9.17+ kodunu `/opt/tezlify`'a yerleştirmek. Bu bir **deploy**'dur ve bu aşamada
  yasak.
- **(B)** Yalnızca gerekli dosyaları (2 betik + 3 birim dosyası) dar kapsamlı, açıkça onaylanmış
  bir yerleştirme ile kopyalamak. Bu da production'ı değiştirir.

### Onay sonrası kurulum — 9 madde

| # | Madde | Değer |
|---|---|---|
| 1 | Servis dosyası | `tezlify-ram-snapshot.service` (oneshot, `User=ubuntu`, `Nice=10`, `TimeoutStartSec=1200`) |
| 2 | Timer dosyası | `tezlify-ram-snapshot.timer` |
| 3 | Takvim | `OnCalendar=hourly` → `*-*-* *:00:00`, `Persistent=true`, `RandomizedDelaySec=120` |
| 4 | İlk otomatik koşum | kurulumdan sonraki ilk tam saat + 0–120 s rastgele gecikme |
| 5 | Off-site davranışı | `Environment=TEZLIFY_OFFSITE_APPROVED=1` — **onayın tek yeri burası**; satır silinirse iş yerel-only olur |
| 6 | Disk projeksiyonu | bugünkü boyutla **~0,161 GiB/gün**, **~4,83 GiB/30 gün** (bkz. §9) |
| 7 | Log konumu | `/var/backups/tezlify-ram/snapshot.jsonl` (izin `600`) |
| 8 | Hata davranışı | exit 4/5/6'da yerel kopya **korunur**, uzak doğrulama `false` kalır; birim `failed` olur, sonraki saat yeniden dener |
| 9 | Geri alma | `systemctl disable --now tezlify-ram-snapshot.timer` + birim dosyalarını sil + `daemon-reload` |

**Timer kurulmadı, enable edilmedi, başlatılmadı.** `systemctl list-timers --all | grep -c
ram-snapshot` → **0**.

---

## 9. RETENTION — OTOMATİK SİLME YOK

**Hiçbir otomatik silme veya retention temizliği eklenmedi.** Ne kodda ne birimde. Bu bilinçli:
3.9.17'de ölçüldü ki tavan senaryosunda 52 GB **~15 günde** dolar; yanlış bir retention kuralı
veriyi sessizce yok edebilirdi.

### Bugünkü boyutla (ölçüldü)

Tek koşum: `7.186.048 B` (.rsnap) + `16.956 B` (manifest) = **7.203.004 B**

| Pencere | Koşum | Toplam |
|---|---|---|
| 24 saat | 24 | 172.872.096 B = **164,9 MiB** = **0,161 GiB** |
| 7 gün | 168 | 1.210.104.672 B = **1,13 GiB** |
| 30 gün | 720 | 5.186.162.880 B = **4,83 GiB** |

52 GB boş alanla bugünkü hızda **~326 gün** yeter.

### Teorik tavan — 200.000 mesaj

Ölçülen yoğunluk: `7.186.048 / 9.154` = **785 B/mesaj** (8 dosyalık ortalamada 779 B idi; bu
snapshot 785 B).

| Pencere | Toplam |
|---|---|
| Tek koşum | 200.000 × 785 = 157.000.000 B ≈ **149,7 MiB** |
| 24 saat | **3,51 GiB** |
| 7 gün | **24,6 GiB** |
| 30 gün | **105,3 GiB** |

52 GB boş alanla tavan senaryosunda **~14,8 gün**. Yani retention **tavan senaryosunda zorunlu
hale gelir**, bugünkü boyutta değil.

### 🔴 OCI kotası — doğrulanamadı

Bucket'ın nesne sayısı/boyut kotası **okunamadı**: mevcut instance-principal izniyle kota
sorgusu yapılamıyor. **Uydurmuyorum.** Bu bir açık risk olarak kalıyor (§13). Kotayı öğrenmenin
yolu ayrı bir IAM/okuma izni gerektirir ve bu aşamada **IAM değişikliği yasak**.

---

## 10. DİSK UYARI EŞİĞİ ÖNERİSİ

**Monitoring değiştirilmedi.** Yalnızca öneri:

| Eşik | Değer | Gerekçe |
|---|---|---|
| Birincil | `/var/backups/tezlify-ram` **> 10 GiB** | bugünkü hızda ~1.400 koşum (~58 gün); tavan senaryosunda ~68 koşum (~3 gün) |
| İkincil | dosya sistemi **> %80** | şu an %47; 52 G boş |
| Üçüncül | tek koşum **> 200 MiB** | beklenmeyen büyüme/sızıntı işareti |

Boyut tabanlı eşik, **sayı** tabanlıdan çok daha anlamlı: mesaj sayısı arttıkça koşum boyutu da
artıyor, sabit "N dosya" kuralı yanlış güven verir.

---

## 11. GIT / DEPLOY

- **Production deploy: yapılmadı.** `/opt/tezlify` HEAD `5cd3eae` — aşama boyunca değişmedi.
- **Uygulama kodu değişikliği: yok.** `backend/app/` ve `whatsapp-gateway/` dokunulmadı.
- **Değişen dosyalar (yalnızca ilgili olanlar):**
  - `scripts/backup/hourly_snapshot.py` — iki stdout ayrıştırma düzeltmesi + log alanı
  - `backend/tests/test_hourly_snapshot.py` — 11 yeni test (43 → 54)
  - `docs/audits/whatsapp-hourly-snapshot-production-activation-phase-3.9.18.md` — bu rapor
  - `.workbuddy-ai/memory/` — aşama kaydı

### Secret taraması (diff üzerinde)

| Desen | Eşleşme |
|---|---|
| `bearer ` / `BEGIN … PRIVATE` / `password=` / `secret=` / `api_key=` | **0** |
| `ocid1.` | **0** |
| IPv4 | **0** |
| 32+ karakter hex | **0** |

Diff 240 satır; commit'e giren içerikte anahtar, token, OCID veya IP **yok**.

---

## 12. GERİ ALMA PLANI

| Seviye | İşlem | Etki |
|---|---|---|
| 1 — Timer | `systemctl disable --now tezlify-ram-snapshot.timer` | otomatik koşum durur; veri etkilenmez |
| 2 — Birimler | dosyaları sil + `daemon-reload` | sistem 3.9.18 öncesi hâline döner |
| 3 — Kod | `git revert <commit>` | yalnızca orkestratör/test; çalışan veri yolu yok |
| 4 — Veri | **gerek yok** | snapshot'lar yalnızca **okur**; DB'ye hiç yazılmadı |

Snapshot dosyaları silinmedi, üzerine yazılmadı. Geri alma veri kaybı riski taşımıyor çünkü bu
aşamada **hiçbir yıkıcı işlem yapılmadı**.

---

## 13. AÇIK RİSKLER

| # | Risk | Ciddiyet | Durum |
|---|---|---|---|
| 1 | `ExecStart` hedefi production'da yok → timer şimdi kurulamaz | **YÜKSEK** | BLOCKED — §8 |
| 2 | OCI kota sınırı bilinmiyor | **ORTA** | doğrulanamadı; IAM değişikliği yasak |
| 3 | Tavan senaryosunda 52 GB ~15 günde dolar | **ORTA** | retention ayrı onay bekliyor |
| 4 | Tek sağlayıcı (OCI) — ikinci kopya yok | **ORTA** | fiziksel escrow hâlâ BLOCKED |
| 5 | Fiziksel escrow kopyası yok | **YÜKSEK** | operatör kağıt kopyası; `anchor8 = c25805a2` |
| 6 | Persistence hâlâ kapalı (`enabled=null`) | **YÜKSEK** | yama `313380f` merge edilmedi |
| 7 | `/tmp/tz3918` geçici kopyası | **DÜŞÜK** | aşama sonunda silindi |

---

## 14. BEKLEYEN ONAY

Timer **kurulmadı, enable edilmedi, başlatılmadı**. Aşağıdaki üç iş için **açık onay** bekliyorum:

1. **Kodu `/opt/tezlify`'a yerleştirme** — (A) deploy veya (B) dar kapsamlı dosya yerleştirme.
   Hangisi olduğu **açıkça** seçilmeli; ikisi farklı risk taşır.
2. **Birimleri kurma** (`--apply`, `daemon-reload`) — timer **başlamaz**.
3. **Timer'ı başlatma** (`enable --now`) — ilk otomatik koşum bu adımdan sonra.

Onay verilene kadar sistem **hazır ama çalışmıyor**: kod git'te, ilk gerçek snapshot alındı ve
kanıtlandı, timer yok.

---

**Üretim güvenliği, WhatsApp oturumu ve mevcut RAM verisi her şeyin üzerinde tutuldu:**
gateway restart **0**, oturum **1/1 connected**, RAM **9154** (değişmedi), persistence **kapalı**,
DB yazımı **0**, deploy **0**, IAM/bucket değişikliği **0**, snapshot silme/üzerine yazma **0**.
