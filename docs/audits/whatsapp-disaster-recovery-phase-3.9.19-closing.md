# 3.9.19 Kapanış Raporu

**Tarih:** 2026-10-30 · ölçüm anı 13:08 UTC
**Mevcut commit:** `7afb540`
**Kapsam:** A/B/C kapanış denetimi — üretim değişikliği yapılmadı

---

## SONUÇ TABLOSU

| Alan | Durum |
|---|---|
| **A — Physical Escrow** | **BLOCKED** |
| **B — Paper-Key Restore** | **NOT RUN** |
| **C — Automatic Timer** | **PASS** |
| **Snapshot Integrity** | **PASS** |
| **Remote Verification** | **PASS** |
| **Production Health** | **PASS** |
| **Persistence** | **DISABLED** |
| **Database Writes** | **0** |
| **Deploy** | **NOT PERFORMED** |

### Sonuç: `PARTIAL — OPERATOR ACTION REQUIRED`

C bu turda **NOT RUN → PASS** yükseldi (ilk otomatik koşum gerçekleşti ve kanıtlandı).
A ve B operatör eylemine bağlı olduğu için `COMPLETE` **verilmedi**.

---

## C — AUTOMATIC TIMER: **PASS**

Bu turun asıl kazanımı. Timer ilk kez **kendiliğinden** tetikledi.

### Kanıt 1 — Timer'ın kendi kaydı

```
NEXT  Fri 2026-10-30 14:00:18 UTC
LAST  Fri 2026-10-30 13:02:18 UTC    ← 5 dk önce
```

`LAST` alanı yalnızca **timer biriminin kendisi** servisi tetiklediğinde dolar. Manuel
`systemctl start` bu alanı **doldurmaz**.

### Kanıt 2 — Planlanan zamanla uyum

| Ölçüm | Değer |
|---|---|
| Önceki turda ölçülen `NEXT` | `13:01:53 UTC` |
| Gerçekleşen `LAST` | `13:02:18 UTC` |
| Fark | **+25 s** |

`RandomizedDelaySec=120` (0–120 s rastgele gecikme) ile **tam tutarlı**.

### Kanıt 3 — Journal

```
Oct 30 13:02:18  Starting tezlify-ram-snapshot.service …
Oct 30 13:02:30  Deactivated successfully.
Oct 30 13:02:30  Finished tezlify-ram-snapshot.service …
Oct 30 13:02:30  Consumed 2.952s CPU time.
```

Öncesinde **hiçbir manuel başlatma kaydı yok**. 13:02:18'de o saatte açık bir operatör oturumu
da yoktu; servisi başlatabilecek tek şey timer'dır.

### Kanıt 4 — Yeni snapshot, zaman damgası birebir

```
name = tezlify-ram-20261030T130218Z
ts   = 2026-10-30T13:02:18Z        ← timer LAST ile AYNI saniye
```

### Kanıt 5 — Koşum sonucu

| Alan | Değer |
|---|---|
| `status` / `exit_code` | **OK** / **0** |
| `remote_verified` | **true** |
| `upload_status` | **UPLOADED** |
| `record_count` / `chat_count` | 9.154 / 100 |
| `rsnap_bytes` / `manifest_bytes` | 7.194.728 B / 16.956 B |
| `seconds` | 12,44 |
| `rsnap_sha256` | `229e3351…` |

### Kanıt 6 — Restart sayıları değişmedi

```
tezlify-gateway=0 tezlify-backend=0 tezlify-db=0 tezlify-caddy=0
```

---

## SNAPSHOT INTEGRITY: **PASS**

Otomatik koşumun ürettiği snapshot'ın manifesti:

| Alan | Değer |
|---|---|
| `kind` / `schema` | `tezlify.ram_snapshot` / 1 |
| `record_count` / `chat_count` | 9.154 / 100 |
| `started_at` → `ended_at` | `13:02:18Z` → `13:02:24Z` |
| `identity_root_sha256` | `e41f621b…` |
| `records_sha256` | `b8516633…` |
| `shortfall_sum` | **0** |
| `collected_sum` | 9.154 = `record_count` ✅ |
| `unstable_chats` | **0** |
| `late_arrival_count` | 0 |
| `rejected_missing_identity` / `rejected_incomplete` | 0 / 0 |
| `duplicates_removed` | 0 |
| `.rsnap` / manifest izinleri | **0600** / **0600** |

**Eksik sayfalama yok, kararsız sohbet yok, kimliksiz kayıt yok.**

---

## REMOTE VERIFICATION: **PASS**

Bağımsız `--download-check`:

```
local_sha256      = 229e3351fd67682c564f79b288ae3ca39ace4a523c2b1ced40756430721cb5cb
local_bytes       = 7194728
downloaded_bytes  = 7194728
size_match        = true
all_verified      = true
```

Yerel SHA = log'daki SHA = indirilen kopyanın SHA. Üçü de aynı.

**OCI nesne tutarlılığı — birebir:**

| Ölçüm | Önce | Sonra |
|---|---|---|
| Nesne | 20 | **22** (+2) |
| Bayt | 71.752.571 | **78.964.255** |

Kontrol: `71.752.571 + 7.194.728 + 16.956 = 78.964.255` ✅ **tam eşleşme**.
`escrow_izi = YOK` (bucket'ta anahtar materyali yok).

---

## PRODUCTION HEALTH: **PASS**

| Ölçüm | Değer |
|---|---|
| `tezlify-gateway` | Up 2 days, **healthy** |
| `tezlify-backend` | Up 15 hours, **healthy** |
| `tezlify-db` | Up 4 weeks, **healthy** |
| `tezlify-caddy` | Up 2 weeks, **healthy** |
| Restart (gw/be/db/caddy) | **0/0/0/0** |
| `/opt/tezlify` HEAD | `5cd3eae` (değişmedi) |
| `.deployed-commit` | `cbe4f509` (değişmedi) |
| Disk | 95 G / **51 G boş** / %46 |
| Yerel snapshot | 11 `.rsnap` / 11 manifest |

---

## PERSISTENCE: **DISABLED**

```
whatsapp_memory_persistence.enabled = None
whatsapp_identity_quarantine.quarantined = 0
```

Kill-switch **kapalı**. `313380f` merge edilmedi. RAM verisi PostgreSQL'e aktarılmadı.

---

## DATABASE WRITES: **0**

Otomatik koşum yalnızca **okuma** yaptı (gateway RAM → şifreli dosya). Bu turda DB'ye hiçbir
INSERT/UPDATE/DELETE yapılmadı. Production DB'ye restore denemesi yapılmadı.

---

## A — PHYSICAL ESCROW: **BLOCKED**

Fiziksel kopya A ve B **oluşturulmadı**. Ajan fiziksel kâğıt kopyası üretemez; üretildiğini
iddia etmiyor.

| Kopya | Durum | Doğrulama |
|---|---|---|
| A | **yok** | — |
| B | **yok** | — |

### Anahtar-escrow parmak izi tutarlılığı — PASS (A'dan bağımsız)

| Ölçüm | Değer |
|---|---|
| `.key-escrow-v2` `anchor8` | `c25805a2` |
| Aktif `GATEWAY_ENCRYPTION_KEY` `anchor8` | `c25805a2` |
| Eşleşme | ✅ **aynı** — rotasyon yok |
| `.key-escrow` / `.key-escrow-v2` | 90 B / 88 B, **0600**, değişmedi |

### Operatör için adımlar (anahtar hiçbir çıktıya girmez)

**1. Kayıt tutmayan bir oturumda sunucuya bağlan**

```bash
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@<host>
```

> **Uyarı — kayıt riskleri:** SSH `script`/`tee` ile oturum kaydı **açık olmamalı**; terminal
> emülatörünün scrollback tamponu kapatılmalı veya sonunda temizlenmeli (`history -c`, tampon
> temizle, oturumu kapat); ekran kaydı / uzak masaüstü oturumu **kapalı** olmalı; `bash -o
> history` benzeri zorlamalar kullanılmamalı.

**2. Anahtarı yalnızca sunucu terminalinde görüntüle**

```bash
python3 - <<'EOF'
import hashlib, re
k = open("/var/backups/tezlify-ram/.key-escrow-v2").read().strip()
k = k.split("=", 1)[1].strip().strip('"')
assert re.fullmatch(r"[0-9a-f]{64}", k), "beklenmeyen anahtar bicimi"
print("anchor8 =", hashlib.sha256(k.encode()).hexdigest()[:8])
for r in range(4):
    print("  " + "  ".join(f"{r*4+i+1:>2}:{k[(r*4+i)*4:(r*4+i)*4+4]}" for i in range(4)))
EOF
```

Ekranda `anchor8 = c25805a2` görünmeli. Anahtar **sunucudan çıkmaz** — SSH stdout'a veri olarak
aktarılmaz, yerel araca pipe edilmez.

**3. İki ayrı kâğıda, 4 karakterlik gruplar hâlinde elle geçir**
16 grup, 4 satır × 4 grup. Her iki kâğıtta da `anchor8 = c25805a2` not edilmeli.

**4. İki kopyayı farklı fiziksel risk bölgelerinde sakla** (farklı bina / bağımsız alan).

**5. Oturumu kapat**, scrollback ve geçmişi temizle.

**6. Yapılmayacaklar:** fotoğraf, e-posta, bulut notu, mesajlaşma, ekran görüntüsü, panoya
kopyalama, yazıcı kuyruğu/bulut yazdırma.

**7. Kâğıttan doğrulama** (yerel makinede, anahtar yankılanmaz):

```bash
python3 scripts/backup/escrow_physical.py verify --expect c25805a2
# → SONUC = MATCH   (rc=0)
```

---

## B — PAPER-KEY RESTORE: **NOT RUN**

A tamamlanmadığı için çalıştırılmadı.

**Önceki dijital escrow restore testi fiziksel paper-key başarısı olarak
sınıflandırılmamıştır** — o test yalnızca **mekanik test**tir (anahtar dosyadan okundu).

Kopyalar hazır olduğunda çalıştırılacak test: izole dizin (`0700`), `:memory:`, `DATABASE_URL`
kaldırılmış, anahtar `getpass` ile kâğıttan, beklenen `restore_rc=0`, `identity_set_equal=true`,
`identity_root_matches=true`, `database_writes=0`.

---

## SECRET SCAN

| Denetim | Sonuç |
|---|---|
| Log'da WhatsApp JID / `wamid` | **0** / **0** |
| Log'da Bearer / private key / mesaj gövdesi | **0** / **0** / **0** |
| Log'daki 64-hex (6 adet) | **hepsi `rsnap_sha256`**; anahtara eşit **0** |
| Raporda anahtar | **0** |
| Anahtar SSH stdout ile taşındı mı | **hayır** |
| Git çalışma ağacı | **temiz** (`7afb540`) |

---

## GIT / DEPLOY

| İşlem | Durum |
|---|---|
| Kod değişikliği | **yok** |
| Commit | **yapılmadı** (talimat gereği) |
| Push | **yapılmadı** |
| Deploy | **NOT PERFORMED** |
| Container restart | **0** |
| Persistence aktivasyonu | **yok** |

---

## AÇIK RİSKLER

| # | Risk | Ciddiyet |
|---|---|---|
| 1 | Fiziksel kopya A/B yok | **YÜKSEK** |
| 2 | Kâğıttan restore yapılmadı | **YÜKSEK** |
| 3 | İkinci sağlayıcıda ciphertext yok — "sunucu+OCI kaybı" kurtarılamaz | **YÜKSEK** |
| 4 | Persistence kapalı (`313380f` merge edilmedi) | **YÜKSEK** |
| 5 | OCI kota sınırı bilinmiyor | **ORTA** |
| 6 | Retention yok — tavanda 52 GB ~14,8 gün | **ORTA** |

---

## SIRADAKİ ADIM

1. **Operatör:** yukarıdaki 7 adımı uygula, kopya A ve B'yi oluştur ve `verify → MATCH` al.
2. **Bildir:** "kopyalar hazır ve MATCH" teyidi ver (anahtarı göndermeden).
3. **Ajan:** B (kâğıttan restore) testini çalıştırır → A ve B **PASS**'e döner, 3.9.19
   **COMPLETE** olur.
4. **Sonra:** AŞAMA 3.9.20 — persistence aktivasyonu öncesi son güvenlik ve veri bütünlüğü
   denetimi (ayrı prompt + açık onay).

---

*Bu raporda anahtar, token, private key veya credential değeri yoktur. Yalnızca 8 haneli genel
doğrulama çapası (`c25805a2`) ve özet önekleri yer alır. Yapılmayan işlemler yapılmış
gösterilmedi; manuel koşum otomatik sayılmadı.*
