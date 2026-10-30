# AŞAMA 3.9.17 — OTOMATİK SAATLİK WHATSAPP RAM SNAPSHOT SİSTEMİ

**Tarih:** 2026-10-30
**Kapsam:** altyapı + kod + test + kurulum planı
**Production deploy:** yapılmadı
**Production timer:** **kurulmadı, etkinleştirilmedi**
**Persistence:** **kapalı** (değişmedi)

---

## GENEL SONUÇ

Saatlik şifreli snapshot sistemi **hazır**, test edilmiş ve kuruluma hazır — **ama production'da çalışmıyor**.
Timer birimleri repoda duruyor, hiçbir systemd birimi kurulmadı, hiçbir konteynere dokunulmadı.

| Soru | Cevap |
|---|---|
| Yeni bir yedekleme biçimi icat edildi mi? | **Hayır** — mevcut `.rsnap` + manifest + AES-256-GCM zarfı aynen kullanılıyor |
| Kaç yeni dosya? | 2 kod/birim + 1 test + 1 rapor |
| Mevcut araçlar değişti mi? | **Hayır** — `ram_snapshot.py` ve `offsite_oci.py` **hiç değişmedi** |
| Production'da ne değişti? | **Hiçbir şey** (Bölüm 9) |
| Testler | **43 yeni test**, 2 mutasyonla doğrulandı |
| Tam suite | **2123 passed / 4 skipped / 0 failed** (3.9.15–3.9.16 baseline'ı 2080 + 43) |
| Timer'ı açmak için ne gerekiyor? | **Ayrı onay** (Bölüm 8) |

---

## 1. MEVCUT SİSTEM — NE VARDI, NE YENİDEN KULLANILDI

İkinci bir yedekleme sistemi kurmamak için önce mevcut bileşenler ölçüldü:

| Bileşen | Ne yapıyor | Bu aşamada |
|---|---|---|
| `scripts/diagnostics/ram_snapshot.py` (815 satır) | Gateway RAM'ini **salt okunur** toplar, kimlik kümesi üzerinden sayfalar, manifest üretir, AES-256-GCM ile şifreler, doğrular, `:memory:`'e geri yükler | **değişmedi**, çağrılıyor |
| `scripts/backup/offsite_oci.py` (550 satır) | Instance principal ile OCI imzalama, `If-None-Match: *`, CONFLICT, `--download-check` ile SHA doğrulama | **değişmedi**, çağrılıyor |
| `.rsnap` biçimi | `RSNAP1` + 12 bayt nonce + AES-256-GCM, AAD `tezlify.ram-snapshot:v1` | **aynı** |
| Manifest | İçerik taşımaz; sayı + hash (`records_sha256`, `identity_root_sha256`) | **aynı** |
| Object key | `<prefix>/<yıl>/<ay>/<gün>/<dosya>` | **aynı** |

**Ölçülen mevcut durum (production, salt okunur):**

| Öğe | Değer |
|---|---|
| `/var/backups/tezlify-ram` | **5** `.rsnap` + **5** manifest + 2 escrow dosyası, **35 MB**, dizin izni `0700` |
| `.rsnap` boyutları | 7.100.080 – 7.181.099 B (ortalama **7.132.832 B**) |
| Manifest boyutu | ortalama **13.197 B** |
| Bucket | **`tezlify-ram-snapshots`** · `eu-frankfurt-1` · tek bucket · `publicAccessType=None` |
| Mevcut zamanlanmış işler | `tezlify-monitor.timer` (3 dk) · `tezlify-wa-observer.timer` (5 dk) — **ikisi de `enabled`** |
| Snapshot timer'ı var mıydı? | **Yok** (ölçüldü: `systemctl list-timers` çıktısında yok) |
| Host disk | 96 GB, **52 GB boş** (%47 dolu) |
| `ubuntu` docker grubunda mı? | **Evet** (gid 988) → `sudo` gerekmez |

> Mevcut iki timer da **salt okunur gözlemci**; ikisi de snapshot almıyor. Yani bu aşama **yeni** bir iş ekliyor, var olanı kopyalamıyor.

---

## 2. MİMARİ TASARIM

```
┌──────────────────────────────────────────────────────────────────┐
│ systemd timer  (SAATLİK, :00 + 0-120 sn rastgele gecikme)        │
│   tezlify-ram-snapshot.timer  →  tezlify-ram-snapshot.service    │
└───────────────────────────────┬──────────────────────────────────┘
                                │  Type=oneshot, User=ubuntu
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ HOST: scripts/backup/hourly_snapshot.py        (YENİ, 943 satır)│
│                                                                  │
│  1. flock(.snapshot.lock)  ──── alınamazsa DUR (exit 5)          │
│  2. docker exec -i tezlify-backend python -c <ram_snapshot.py>   │
│       --out - --encrypt-key-env GATEWAY_ENCRYPTION_KEY           │
│       stdout → ŞİFRELİ BLOB     stderr son JSON → MANIFEST        │
│  3. AYNI yol, stdin = blob:  --verify -                          │
│       ok=false  → YAYINLAMA, YÜKLEME (exit 3)                    │
│  4. ATOMİK YAYIN: .incoming/<ad>.partial → os.replace → <ad>      │
│       hedef varsa → CONFLICT (exit 6), üzerine YAZMA             │
│  5. yerel SHA-256 (disk ↔ bellek)                                │
│  6. offsite_oci.py upload  (DRY-RUN, --execute YOK)              │
│  7. offsite_oci.py upload --execute   (retry: 2, 5s/15s)         │
│  8. offsite_oci.py verify --download-check  (geri indir + SHA)   │
│  9. JSON satır log (beyaz liste + scrub)                         │
└───────────────────────────────┬──────────────────────────────────┘
                                │
        ┌───────────────────────┴────────────────────────┐
        ▼                                                ▼
┌───────────────────────┐                    ┌────────────────────────┐
│ /var/backups/…        │                    │ OCI Object Storage     │
│ tezlify-ram-<ts>.rsnap│                    │ tezlify-ram-snapshots/ │
│ …manifest.json        │                    │ <yıl>/<ay>/<gün>/…     │
│ 0600, şifreli         │                    │ If-None-Match: *       │
└───────────────────────┘                    └────────────────────────┘
```

### Neden anahtar host'a hiç gelmiyor

Şifreleme **konteynerin içinde** yapılır; anahtar oradan `GATEWAY_ENCRYPTION_KEY`
ortam değişkeniyle okunur. Orkestratör anahtarı **okumaz, argüman olarak almaz, log'a yazmaz**.
Host'ta anahtar diye bir şey yoktur → "anahtar sızdı mı" sorusu bu bileşende **oluşamaz**.

### Neden `python -c` (ve neden `python -` DEĞİL)

İmajda `ram_snapshot.py` **yok** (ölçüldü: `/app/scripts/diagnostics/…` boş), konteynere dosya
yazmak da yasak. `python -` (betiği stdin'den oku) toplama için çalışır ama **doğrulamada
çakışır**: hem betik hem blob aynı stdin'i ister, biri boş okur. `python -c` ile betik argv'ye
taşınır, **stdin serbest kalır**:

| Adım | Betik nerede | stdin | stdout |
|---|---|---|---|
| toplama | `-c` (argv) | boş | şifreli blob |
| doğrulama | `-c` (argv) | **blob** | doğrulama JSON'u |

Bu mekanizma **gerçek konteynerde** doğrulandı: 32.142 baytlık kaynak `python -c` ile verildi,
argparse `--help`'i doğru gördü, `RC=0`, hiçbir veri okunmadı (Bölüm 7).

---

## 3. SNAPSHOT AKIŞI — ADIM ADIM

| # | Adım | Başarısız olursa |
|---|---|---|
| 1 | `flock` ile tekil çalışma kilidi | `ALREADY_RUNNING` (exit 5), **hiçbir şey yapılmaz** |
| 2 | Gateway'den salt okunur toplama (kimlik kümesi sayfalaması) | `COLLECT_FAILED` (exit 2), **tekrar denenmez** |
| 3 | Manifest ayrıştırma (stderr'in son geçerli JSON satırı) | `COLLECT_FAILED` |
| 4 | Bütünlük + tamlık doğrulaması (`--verify`) | `REJECTED` (exit 3), yayınlanmaz, yüklenmez |
| 5 | `.partial` yazımı + `fsync` | `REJECTED` |
| 6 | Disk ↔ bellek SHA-256 | `REJECTED` |
| 7 | `os.replace` ile atomik yayın (0600) | `CONFLICT` (exit 6) |
| 8 | Upload **dry-run** (plan) | `DEGRADED_LOCAL_ONLY` (exit 4) |
| 9 | Upload `--execute` (retry 2×, 5s/15s) | `DEGRADED_LOCAL_ONLY` |
| 10 | Uzaktan geri indir + SHA-256 | `DEGRADED_LOCAL_ONLY` |
| 11 | JSON satır log | — |

**Sıra keyfi değil:** yayın (7) yüklemeden (9) **önce**. Böylece OCI'ye ulaşılamadığında bile
yerel şifreli kopya **çoktan** diskte olur.

---

## 4. ÇAKIŞMA VE HATA KORUMASI

| Kural | Nasıl zorlanıyor | Test |
|---|---|---|
| Aynı anda tek görev | `fcntl.flock(LOCK_EX\|LOCK_NB)` — kilit dosyada değil, açık dosya tanımlayıcısında; süreç ölse de çekirdek bırakır, **bayat kilit olmaz** | `test_second_job_is_refused_while_lock_is_held` |
| Önceki bitmeden yenisi başlamaz | systemd `Type=oneshot` aynı birimi ikinci kez başlatmaz **+** flock (iki katman) | aynı test |
| Gateway yanıt vermezse güvenli duruş | `CollectFailed` → exit 2, **retry yok** (ikinci toplama farklı bir anın görüntüsüdür) | `test_gateway_error_stops_safely_and_is_not_retried` |
| Eksik sayfalama başarı sayılmaz | `verify_snapshot` `shortfall>0` / `stable=false` görürse `ok=False` | `test_missing_page_is_rejected_and_never_uploaded` |
| SHA uyuşmazlığında upload kabul edilmez | Yerel SHA (adım 6) + uzak `--download-check` (adım 10) | `test_sha_mismatch_on_download_check_is_degraded` |
| OCI yoksa yerel kopya korunur | Yayın yüklemeden önce; hata yalnızca `DEGRADED` üretir, **silme yok** | `test_oci_error_keeps_local_encrypted_snapshot` |
| Kontrollü retry | Yalnızca upload/verify; **CONFLICT asla tekrarlanmaz** | `test_conflict_is_not_retried` |
| Log'da içerik/anahtar/token yok | Beyaz liste (`LOG_FIELDS`) + `scrub()` (uzun hex/base64, `Bearer`, `Signature` maskelenir) | `test_log_never_contains_key_or_token` |
| Gateway yeniden başlatılmaz | Yalnızca `docker exec`; `restart`/`rm`/`compose` **hiç yok** | kod denetimi |
| Session/mesaj belleği değişmez | Toplama yolu salt okunur HTTP GET | 3.9.16'da ölçüldü (RAM 9154 → 9154) |

**Çıkış kodları (sözleşme):**

| Kod | Anlam |
|---|---|
| 0 | Başarılı (veya bilinçli `DRY_RUN`) |
| 1 | Kullanım/yapılandırma hatası |
| 2 | Toplama başarısız — güvenli durdu |
| 3 | Snapshot **reddedildi** (bütünlük/tamlık) |
| 4 | Upload/uzak doğrulama başarısız — **yerel kopya korundu** |
| 5 | Zaten çalışan bir görev var |
| 6 | Uzakta aynı anahtar farklı içerikle var (CONFLICT) |

---

## 5. DEPOLAMA TAHMİNİ — ÖLÇÜMDEN

**Otomatik silme veya retention temizliği YOK.** Bu aşamada hiçbir dosya silinmez.
Aşağıdaki hesap, gerçek snapshot'ların ölçülen boyutlarından türetildi
(`estimate` komutu, `/var/backups/tezlify-ram` üzerinde çalıştırıldı):

| Ölçüm | Değer |
|---|---|
| Ortalama `.rsnap` | **7.132.832 B** |
| Ortalama manifest | **13.197 B** |
| **Çalışma başına** | **7.146.029 B** (~6,8 MiB) |
| Mesaj başına maliyet | **779 B/mesaj** (9.154 mesajdan türetildi) |

### Bugünkü boyutla

| Pencere | Snapshot | Bayt | İnsan okuru |
|---|---:|---:|---|
| 24 saat | 24 | 171.504.696 | **163,6 MiB** |
| 7 gün | 168 | 1.200.532.872 | **1,118 GiB** |
| 30 gün | 720 | 5.145.140.880 | **4,792 GiB** |

Disk: günde **0,160 GiB** → 52 GB boş alan **~326 günde** dolar. Sorun değil.

### En kötü durum — sohbet başına 2.000 tavanına dayanırsa

RAM tavanı `100 sohbet × 2.000 mesaj = 200.000 mesaj`. Ölçülen 779 B/mesaj ile:

| Pencere | Snapshot | Boyut |
|---|---:|---|
| Tek snapshot | — | **148,6 MiB** |
| 24 saat | 24 | **3,48 GiB** |
| 7 gün | 168 | **24,39 GiB** |
| 30 gün | 720 | **104,51 GiB** |

> **KRİTİK:** tavan durumunda günde **3,48 GiB** yazılır → 52 GB boş alan **~15 günde** dolar.
> 30 günlük birikim (104,5 GiB) bugünkü diskten **büyüktür**. Bu yüzden retention **ayrı onay**
> gerektiren bir tasarımdır ve bu aşamada **bilinçli olarak yazılmadı**.
> Off-site kotası da operatör tarafından doğrulanmalıdır (bugünkü boyutla 30 gün 4,79 GiB,
> tavan durumunda 104,5 GiB).

---

## 6. TEST SONUÇLARI

### Bu aşamanın testleri — `backend/tests/test_hourly_snapshot.py` (**43 test**)

İstenen 10 senaryonun tamamı + gizlilik/CLI/kilit sözleşmesi:

| Senaryo | Test |
|---|---|
| Normal snapshot | `test_normal_snapshot_publishes_encrypted_files`, `…_uploads_both_files_and_verifies_remotely` |
| Eksik sayfa | `test_missing_page_is_rejected_and_never_uploaded` |
| Gateway bağlantı hatası | `test_gateway_error_stops_safely_and_is_not_retried` |
| OCI bağlantı hatası | `test_oci_error_keeps_local_encrypted_snapshot` |
| Aynı anda iki görev | `test_second_job_is_refused_while_lock_is_held` |
| Yarım kalan upload | `test_partial_upload_is_degraded` |
| SHA uyuşmazlığı | `test_sha_mismatch_on_download_check_is_degraded` |
| Aynı object key ile tekrar | `test_same_object_key_upload_is_idempotent`, `test_conflict_is_not_retried` |
| Encryption/decryption | `test_encrypt_decrypt_roundtrip_preserves_bytes`, `test_wrong_key_cannot_decrypt`, `test_encrypted_blob_does_not_leak_plaintext` |
| Restore + identity root | `test_restore_preserves_identity_root`, `test_published_snapshot_is_restorable_end_to_end` |

Ek olarak: log beyaz listesi, `scrub()` maskesi, 0600 izinleri, üzerine yazmama, atomik yayın
artığı kalmaması, kilit bırakılması, `--execute` kapıları, `python -c`/stdin sözleşmesi,
manifest ayrıştırma, depolama hesabı.

### Testlerin gerçekten koruduğunun kanıtı — 2 mutasyon

Testlerin "yeşil ama boş" olmadığını göstermek için koruma kaldırıldı ve testin **düştüğü** görüldü:

| Mutasyon | Beklenen | Ölçülen |
|---|---|---|
| `fcntl.flock(...)` → `pass` | kilit testleri düşmeli | **1 failed** (`test_second_job_is_refused_while_lock_is_held`) |
| `if not check.get("ok")` → `if False` | reddetme testleri düşmeli | **2 failed** (`…_missing_page_…`, `…_keeps_previous_snapshot_intact`) |

Dosya mutasyon sonrası **birebir geri alındı** (`grep MUTASYON` → 0).

### Tam suite

```
scripts/provision_test_db.py            # ÖNCE bu (bkz. 3.9.16 raporu Bölüm 12)
pytest backend/tests -q
→ 2123 passed, 4 skipped, 0 failed
```

| Baseline | Bu aşama | Fark |
|---|---|---|
| 2080 passed / 4 skipped (3.9.15–3.9.16) | **2123 passed / 4 skipped** | **+43** = yeni test sayısı |

### Canlı uçtan uca test — **YAPILMADI** (bilinçli)

Prompt "testleri production Gateway'i kullanmadan" diyor. Bu yüzden:

| Doğrulanan | Nasıl | Durum |
|---|---|---|
| Orkestrasyon mantığı (11 adım) | enjekte edilmiş sahte `collect`/`verify`/`uploader` ile **aynı kod yolu** | **PASS** (43 test) |
| `python -c` + stdin mekanizması | **gerçek konteynerde** `--help` (32.142 B kaynak, veri okunmadı) | **PASS** (RC=0) |
| `estimate` gerçek dizinde | `/var/backups/tezlify-ram` üzerinde salt okunur | **PASS** |
| systemd birim sözdizimi | `systemd-analyze verify` (production'da, `/tmp`'den) | **PASS** (RC=0) |
| `OnCalendar=hourly` | `systemd-analyze calendar hourly` → `*-*-* *:00:00` | **PASS** |
| **Gerçek gateway'den gerçek snapshot** | **yapılmadı** — prompt yasaklıyor | **NOT RUN** |

> **Dürüst uyarı:** sistemin ilk gerçek çalışması, timer ilk kez başlatıldığında olacak.
> Bu yüzden kurulum adımlarında ilk turun **elle ve izlenerek** çalıştırılması zorunlu tutuldu (Bölüm 8).

---

## 7. GÜVENLİK DOĞRULAMALARI

| Kontrol | Sonuç |
|---|---|
| Anahtar host'a geliyor mu? | **Hayır** — yalnızca konteyner ortamında, adıyla referans edilir |
| Anahtar argv'de mi? | **Hayır** |
| Anahtar log'da mı? | **Hayır** — `scrub()` + beyaz liste; testle kanıtlı |
| Mesaj içeriği log'da mı? | **Hayır** — log yalnızca sayı/hash/durum |
| Escrow yüklenebilir mi? | **Hayır** — `offsite_oci.py` `ESCROW_RE` ile hard block (değişmedi) |
| TLS kapatılabilir mi? | **Hayır** — `ssl.create_default_context()` (değişmedi) |
| Üzerine yazma | **Yok** — `If-None-Match: *` + yerel `CONFLICT` |
| Silme | **Yok** — kodda hiçbir `unlink`/`rmtree` yok (yalnızca kendi `.partial`'ı `os.replace` ile taşınır) |
| Konteyner değişikliği | **Yok** — yalnızca `docker exec` (read-only komut) |
| Dosya izinleri | `.rsnap`, manifest, kilit, log → **0600**; yedek dizini **0700** |

---

## 8. PRODUCTION'A UYGULANACAK KURULUM ADIMLARI (onay sonrası)

> **Bu adımlar bu aşamada ÇALIŞTIRILMADI.** Timer'ı etkinleştirmek için ayrı onay gerekiyor.

### Ön koşullar

1. Bu commit `main`'e push edilmiş ve production'a **normal release akışıyla** alınmış olmalı
   (`scripts/deploy/host-release.sh`; **elle `/opt/tezlify` sıfırlama yok**).
2. `/opt/tezlify/scripts/backup/hourly_snapshot.py` yerinde olmalı.
3. Off-site yükleme için `TEZLIFY_OFFSITE_APPROVED=1` **birim dosyasında** tanımlı olmalı
   (betik bu değişkeni kendisi set etmez).

### Adım 1 — Ön kontrol (hiçbir şey değiştirmez)

```bash
cd /opt/tezlify/monitoring/systemd
./install-ram-snapshot-timer.sh
```

Beklenen: `SONUÇ: on kontrol temiz. Hiçbir şey değiştirilmedi.`
Kontrol ettikleri: betik var mı + host python3 derliyor mu, git ile tutarlı mı, docker var mı,
`tezlify-backend` çalışıyor mu, `GATEWAY_ENCRYPTION_KEY` konteynerde tanımlı mı (değer okunmaz),
yedek dizini 0700 mü, boş alan yeterli mi, çakışan timer var mı.

### Adım 2 — İlk turu ELLE çalıştır ve izle (timer'sız)

```bash
sudo systemctl daemon-reload          # birimler henüz kurulmadıysa atla
sudo -u ubuntu /usr/bin/python3 /opt/tezlify/scripts/backup/hourly_snapshot.py run \
    --execute --bucket tezlify-ram-snapshots \
    --log /var/backups/tezlify-ram/snapshot.jsonl
```

Beklenen çıktı: `{"status": "OK", …}` ve `exit_code: 0`.

Doğrulama (üç ayrı kanıt):

```bash
# 1) yerel dosya oluştu mu, izni 0600 mü
ls -l /var/backups/tezlify-ram/ | tail -3
# 2) log satırı OK mu
tail -1 /var/backups/tezlify-ram/snapshot.jsonl
# 3) uzak kopya gerçekten indirilip doğrulandı mı (log'da remote_verified=true)
python3 -c "import json;print(json.loads(open('/var/backups/tezlify-ram/snapshot.jsonl').readlines()[-1])['remote_verified'])"
```

> `status=OK` **ve** `remote_verified=true` görülmeden 3. adıma geçilmemeli.

### Adım 3 — Birimleri kur (timer **başlamaz**)

```bash
cd /opt/tezlify/monitoring/systemd
sudo ./install-ram-snapshot-timer.sh --apply
```

### Adım 4 — Timer'ı başlat (AYRI ONAY)

```bash
sudo systemctl enable --now tezlify-ram-snapshot.timer
systemctl list-timers --no-pager tezlify-ram-snapshot.timer
```

### Adım 5 — İlk saatlik turu doğrula

```bash
journalctl -u tezlify-ram-snapshot.service -n 30 --no-pager
tail -3 /var/backups/tezlify-ram/snapshot.jsonl
```

---

## 9. ÜRETİM DEĞİŞİKLİKLERİ — 0

| İşlem | Sayı |
|---|---:|
| Konteyner oluşturma / yeniden başlatma / değiştirme | **0** |
| Gateway restart | **0** |
| Production deploy | **0** |
| systemd birimi kurma / timer etkinleştirme | **0** |
| Cron / timer oluşturma | **0** |
| DB `INSERT`/`UPDATE`/`DELETE` | **0** |
| Persistence aktivasyonu | **0** |
| IAM / OCI policy / bucket değişikliği | **0** |
| Yeni OCI kaynağı | **0** |
| Mesaj silme | **0** |
| `.env.production` değişikliği | **0** |
| Production'a yazılan kalıcı dosya | **0** (geçici araçlar `/tmp`'den silindi) |

**Başlangıç / bitiş (salt okunur ölçüm):**

| Metrik | Başlangıç | Bitiş | Fark |
|---|---:|---:|---:|
| Container ID (4 adet) | `5b867095d376` / `ce2e901b6619` / `f6d79c4a1f8b` / `ee66a5cab371` | **aynı** | 0 |
| Restart sayacı | 0 / 0 / 0 / 0 | **0 / 0 / 0 / 0** | 0 |
| Oturum | 1 / 1 `CONNECTED` | **1 / 1 `CONNECTED`** | 0 |
| RAM toplamı | 9154 | **9154** | 0 |
| contacts / conversations / messages | 1538 / 126 / 2196 | **1538 / 126 / 2238** | +42 (canlı trafik) |
| Karantina | 0 | **0** | 0 |
| Persistence | kapalı (`WHATSAPP_MEMORY_PERSIST_ENABLED` tanımsız) | **kapalı** | 0 |
| `.rsnap` / manifest dosyası | 5 / 5 | **5 / 5** | 0 |
| Escrow | 2 dosya | **2 dosya** | 0 |
| `/var/backups/tezlify-ram` toplam | 35.730.329 B | **35.730.329 B** | 0 |
| Bucket nesne sayısı | 10 | **10** | 0 |
| `tezlify-ram-snapshot` timer'ı | yok | **yok** | 0 |

> **+42 mesaj notu:** bu aşama boyunca DB'ye 42 mesaj eklendi (2196 → 2238). Bu **canlı WhatsApp
> trafiğidir**, bu aşamanın yazımı değildir: aşama boyunca hiçbir yazma yolu tetiklenmedi ve
> persistence kapalı. Ayrıca bu sayı, 3.9.16'da ölçülen **1,7 mesaj/saatlik tahliye** hızıyla
> çelişmez — ikisi farklı şeydir: DB'ye **giren** trafik (~42/saat) ile RAM'den **tahliye edilen**
> mesaj (yalnızca 2 sohbet tavanda olduğu için ~1,7/saat).

> **Not — production `/tmp`'de eski aşamalardan kalan dosyalar:** bu aşamada oluşturduğum geçici
> araçların hepsi silindi (`hs_probe.py`, `offsite_probe.py`, `.rs.py` → **0 artık**). `/tmp`'de
> görülen `tezlify-migration-guard-*`, `tezlify-persist-flag-guard-*`, `tezlify-script-version-guard-*`,
> `tezlify_observe.py`, `unmapped_probe.py` gibi dosyalar **önceki aşamalardan** kalmadır; bu aşamada
> oluşturulmadı ve **silinmedi** (kapsam dışı, sahibi bu aşama değil).

---

## 10. GERİ ALMA PLANI

Sistem **eklemeli** çalışır: hiçbir mevcut veriyi değiştirmez, yalnızca yeni dosya üretir.
Bu yüzden geri alma "eski hâle döndürme" değil, "yeni işi durdurma"dır.

| Seviye | İşlem | Etki |
|---|---|---|
| 1 — Timer'ı durdur | `sudo systemctl disable --now tezlify-ram-snapshot.timer` | Yeni snapshot alınmaz; **mevcut snapshot'lar kalır** |
| 2 — Birimleri kaldır | `sudo rm -f /etc/systemd/system/tezlify-ram-snapshot.{service,timer} && sudo systemctl daemon-reload` | Sistem tamamen eski hâle döner |
| 3 — Off-site yüklemeyi kapat | Birim dosyasından `Environment=TEZLIFY_OFFSITE_APPROVED=1` satırını sil | Görev yerel-only çalışır, **uzak kopya oluşmaz** |
| 4 — Tek turu atla | `sudo systemctl stop tezlify-ram-snapshot.service` | Süren tur iptal; `.partial` kalır, **yayınlanmış snapshot bozulmaz** |

**Geri almanın geri alamayacağı şey yok** — çünkü bu aşama hiçbir şeyi silmedi veya değiştirmedi.
Tek dikkat: 4. seviyede yarıda kalan tur `.incoming/*.partial` bırakır; bunlar **yayınlanmamıştır**
ve bir sonraki tur onları kullanmaz.

---

## 11. AÇIK RİSKLER

| Risk | Önem | Durum |
|---|---|---|
| **Canlı uçtan uca test yapılmadı** — ilk gerçek tur, timer açıldığında olacak | **YÜKSEK** | Kabul edildi; kurulumda elle+izlenerek ilk tur zorunlu |
| **Retention yok** — tavan durumunda disk ~15 günde dolar | **YÜKSEK** | Bilinçli; ayrı tasarım + onay |
| Off-site kotası doğrulanmadı (tavan durumunda 30 gün 104,5 GiB) | **YÜKSEK** | Operatör doğrulaması gerekli |
| Saatlik granülerlik → en fazla **60 dk** kayıp penceresi | Orta | Ölçülen hız ~1,7 mesaj/saat ⇒ tur başına ~1–2 mesaj |
| Snapshot anlık görüntüdür; iki tur arasında düşen mesaj yine kaybolur | Orta | Sadece persistence kapatır |
| Escrow hâlâ snapshot'larla aynı diskte | **YÜKSEK** | 3.9.12'den devir, BLOCKED (operatör kâğıt kopyası) |
| Medya baytları yedeklenmiyor (yalnızca metadata) | Orta | Bilinen sınır |
| `os.replace` iki adımlı (rsnap, sonra manifest) — ikincisi düşerse öksüz `.rsnap` kalır | Düşük | Aynı dosya sisteminde gerçekleşmesi pratikte imkânsız; upload yine fail-closed |
| `Persistent=true` → host kapalıyken kaçan turlar açılışta **bir kez** telafi edilir | Düşük | Bilinçli; birikmiş turlar üst üste koşmaz |
| Log rotasyonu eklenmedi | Düşük | Hacim ~200 B/saat; yılda ~1,7 MB |
| Kill-switch yaması (`313380f`) hâlâ ayrı dalda, merge/deploy edilmedi | Orta | Ayrı onay |

---

## 12. SONUÇ VE SONRAKİ ADIM

**Sistem hazır, production'da çalışmıyor.**

Bu aşamanın hedefi "otomatik saatlik snapshot sistemini hazırla" idi; "çalıştır" değildi.
Hazır olan: orkestrasyon kodu (**943 satır**, yalnızca stdlib), **43 test**, 2 systemd birimi, kurulum aracı,
depolama projeksiyonu ve bu rapor.

**Timer'ı etkinleştirmek için ayrı onay bekleniyor.** Onay geldiğinde sıra:
Bölüm 8'deki 5 adım — önce ön kontrol, sonra **elle tek tur**, sonra timer.

**Ölçülen kazanç (onaylanırsa):** kayıp hızı bugün ~1,7 mesaj/saat (≈41/gün). Saatlik snapshot
bunu tur başına en fazla 60 dakikalık pencereye indirir; yani yedeklenmemiş en kötü durum
~41 mesaj/gün yerine ~1–2 mesaj/saat olur. **Kaybı sıfırlamaz** — onu yalnızca persistence
aktivasyonu yapar.

---

*Anahtar, token, private key veya credential değerleri bu rapora yazılmadı; yalnızca boyut,
sayı, hash ve durum bilgisi yer alır. Gerçekleştirilmeyen işlemler başarılı gösterilmedi:
timer kurulmadı, deploy yapılmadı, persistence açılmadı, canlı uçtan uca test yapılmadı.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*
