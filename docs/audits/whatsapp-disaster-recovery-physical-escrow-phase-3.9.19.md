# AŞAMA 3.9.19 — FİZİKSEL ESCROW VE BAĞIMSIZ FELAKET KURTARMA (A/B/C BİRLEŞİK)

**Tarih:** 2026-10-30 · A/B/C birleşik tamamlama denemesi
**Ölçüm anı:** 12:37 UTC
**Genel sonuç:** **PARTIAL — operatör eylemi bekliyor**

---

## GENEL SONUÇ — KISA

| İş | Durum | Neden |
|---|---|---|
| **A** — Fiziksel kopya A/B | **BLOCKED** | fiziksel insan eylemi; ajan yapamaz |
| **B** — Kâğıttan restore | **NOT RUN** | A tamamlanmadan çalıştırılamaz |
| **C** — Otomatik timer kanıtı | **NOT RUN** | ilk tetikleme 13:01:53 UTC, henüz gelmedi |

Bu raporda **hiçbir fiziksel işlem yapılmış gibi gösterilmedi** ve **hiçbir manuel koşum otomatik
sayılmadı**.

**Bu turda üretilen gerçek değer:** §2 tam durum denetimi, §11 kapasite analizi, §12 ikinci
off-site değerlendirmesi ve **§3.3'te runbook'taki kritik çelişkinin bulunup düzeltilmesi**.

---

## 1. ÖNCEKİ 3.9.19 DURUMUNUN ÖZETİ

Commit `e7f8f76` ile teslim edilen durum:

| Kanıt | Sonuç |
|---|---|
| Aktif anahtar ↔ `.key-escrow-v2` | **aynı** — `anchor8 = c25805a2` |
| `.key-escrow` (v1) | aynı anahtar, **tırnak içinde** (66 karakter) — rotasyon değil |
| Anchor doğrulaması | 3 bağımsız ölçüm + **gerçek snapshot deşifre edildi** |
| İzole restore | 9.154/9.154, `identity_set_equal=true`, `identity_root_matches=true` |
| PostgreSQL kapıları | 4 olumsuz yol da reddedildi |
| Fiziksel kopya A/B | **yok** |
| Otomatik timer koşumu | **kanıtlanmadı** |

---

## 2. PRODUCTION BAŞLANGIÇ DURUMU

12:37 UTC'de salt okunur ölçüm. **3.9.19 raporuyla birebir aynı — drift yok.**

| Ölçüm | Değer | Beklenen | Sonuç |
|---|---|---|---|
| Yerel `main` HEAD | `e7f8f76` | — | temiz ağaç |
| `/opt/tezlify` HEAD | `5cd3eae` | değişmemeli | **PASS** |
| `.deployed-commit` | `cbe4f509` | değişmemeli | **PASS** |
| Deploy drift | 3.9.17+ deploy edilmemiş | bilinen durum | değişmedi |
| `tezlify-gateway` | Up 2 days, healthy | healthy | **PASS** |
| `tezlify-backend` | Up 15 hours, healthy | healthy | **PASS** |
| `tezlify-db` | Up 4 weeks, healthy | healthy | **PASS** |
| `tezlify-caddy` | Up 2 weeks, healthy | healthy | **PASS** |
| Restart (gw/be/db/caddy) | **0/0/0/0** | değişmemeli | **PASS** |
| `whatsapp_memory_persistence.enabled` | **`None`** | kapalı | **PASS** |
| Timer | `enabled` + `active (waiting)` | — | **PASS** |
| Backup dizini | `0o700` | `0700` | **PASS** |
| `.key-escrow-v2` | `0o600`, 88 B | `0600` | **PASS** |
| `.key-escrow` | `0o600`, 90 B | `0600` | **PASS** |
| `snapshot.jsonl` | `0o600`, 1.839 B | `0600` | **PASS** |
| `.rsnap` izinleri | 10/10 `0600` | `0600` | **PASS** |
| Son snapshot bütünlüğü | `9154/100`, `shortfall=0`, `unstable=0` | — | **PASS** |
| Yerel `.rsnap` SHA | `2d1fbc85…` | OCI ile aynı | **PASS** |

**Sonuç: PASS** — production'da hiçbir değişiklik yok.

---

## 3. FİZİKSEL KOPYA A

**Durum: BLOCKED.**

Kopya A oluşturulmadı. Ajan fiziksel kâğıt kopyası üretemez ve ürettiğini iddia etmiyor.

### 3.3 Runbook'ta bulunan KRİTİK ÇELİŞKİ ve düzeltmesi

Önceki runbook'un 1. adımı şuydu:

```bash
# ESKI — ARTIK YASAK
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@<host> \
  'sed "s/.*=//" /var/backups/tezlify-ram/.key-escrow-v2' \
  | python3 scripts/backup/escrow_physical.py sheet --i-am-the-operator
```

Bu komut **anahtarı sunucudan SSH stdout ile yerel makineye taşıyor**. Bu turun kuralları bunu
açıkça yasaklıyor:

> "Anahtarı uzak SSH çıktısı olarak yerel makineye taşıma yasak."

Üstelik `escrow_physical.py` **production sunucusunda yok** (ölçüldü:
`/opt/tezlify/scripts/backup/` yalnızca `hourly_snapshot.py` ve `offsite_oci.py` içeriyor), yani
eski komut zaten yerel araca bağımlıydı.

**Düzeltilmiş prosedür — anahtar sunucudan çıkmaz.** Operatör kendi terminalinde sunucuya girer
ve biçimlendirmeyi **sunucuda** çalıştırır; kâğıda bakarak yazar:

```bash
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@<host>
# --- sunucuda, etkilesimli oturumda ---
python3 - <<'EOF'
import hashlib, re
k = open("/var/backups/tezlify-ram/.key-escrow-v2").read().strip()
k = k.split("=", 1)[1].strip().strip('"')
assert re.fullmatch(r"[0-9a-f]{64}", k), "beklenmeyen anahtar bicimi"
print("uzunluk =", len(k))
print("anchor8 =", hashlib.sha256(k.encode()).hexdigest()[:8])
for r in range(4):
    print("  " + "  ".join(f"{r*4+i+1:>2}:{k[(r*4+i)*4:(r*4+i)*4+4]}" for i in range(4)))
EOF
```

Ekranda `anchor8 = c25805a2` görünmeli. 16 grubu (4×4) sırayla kâğıda geçirin, sonra oturumu
kapatın ve terminal geçmişini temizleyin.

**Doğrulama — anahtar yerel makineye veri olarak geçmez.** Kâğıttan okuyup `getpass` ile yazın
(ekranda yankılanmaz):

```bash
python3 scripts/backup/escrow_physical.py verify --expect c25805a2
# → SONUC = MATCH   (rc=0)
```

Araç sözleşmesi sahte anahtarla doğrulandı: `anchor` anahtarı basmıyor, `verify` MATCH/MISMATCH
doğru, `sheet` onaysız `rc=2` ile reddediyor.

---

## 4. FİZİKSEL KOPYA B

**Durum: BLOCKED.**

Kopya B oluşturulmadı. Kopya A'dan **farklı fiziksel konumda** (farklı bina / bağımsız risk
alanı) saklanmalı ve aynı `verify --expect c25805a2 → MATCH` kontrolünden geçmeli.

Kopya A tamamlanmadan bu adıma geçilmedi.

| Kopya | Oluşturuldu | Doğrulama | Konum |
|---|---|---|---|
| A | **hayır** | — | — |
| B | **hayır** | — | — |

---

## 5. ANCHOR DOĞRULAMASI

**Durum: PASS** (3.9.19'da ölçüldü, bu turda değişmedi).

| Kanıt | Sonuç |
|---|---|
| Escrow dosyası `anchor8` | `c25805a2` |
| Aktif `GATEWAY_ENCRYPTION_KEY` `anchor8` | `c25805a2` |
| Runbook'taki 3.9.7 `fp8` | `c25805a2` |
| **Gerçek snapshot deşifre** | `ok=true`, iki problem listesi boş |

Deşifre kanıtı — anahtar yalnızca `env=` ile (argv'de **değil**):

```
verify_rc = 0        ok = True
record_count = 9154  chat_count = 100
identity_root_sha256 = 0deff9b5…   records_sha256 = e10d6fe9…
```

Dördü de manifest ile birebir. **Çapa, dosyanın varlığına değil, veriyi açabilme yeteneğine bağlı
olarak doğrulandı.**

---

## 6. KÂĞITTAN RESTORE TESTİ

**Durum: NOT RUN.**

Kural gereği bu test yalnızca fiziksel kopyalar hazırlanıp doğrulandıktan sonra çalıştırılabilir.
Kopyalar yok ⇒ test yapılmadı.

3.9.19'da yapılan restore testi **dijital escrow** ile yapıldığı için yalnızca **mekanik test**
sınıfındadır ve bağımsız fiziksel escrow kabulü olarak **sayılmaz**.

**Kopyalar hazır olduğunda çalıştırılacak test:** izole dizin (`0700`), `:memory:` hedef,
`DATABASE_URL` kaldırılmış, anahtar **kâğıttan `getpass` ile**, `restore_rc=0`,
`identity_set_equal=true`, `identity_root_matches=true`, `database_write_count=0`.

---

## 7. IDENTITY SET / ROOT SONUÇLARI

**Durum: PASS (mekanik test).**

| Ölçüm | Değer |
|---|---|
| `record_count` / `chat_count` | 9.154 / 100 |
| `identity_set_equal` | **true** |
| `identity_root_matches` | **true** |
| `identity_conserved` | **true** |
| `restored_identity_root_sha256` | `0deff9b5…` |
| `duplicate_identity` | 0 |
| `shortfall_sum` | 0 |
| `unstable_chats` | `[]` |

---

## 8. POSTGRESQL GÜVENLİK TESTLERİ

**Durum: PASS.**

| # | Senaryo | rc | Mesaj |
|---|---|---|---|
| 1 | `DATABASE_URL=postgresql://…` | **1** | `REDDEDILDI: DATABASE_URL postgres: uretim DB'sine geri yukleme reddedildi` |
| 2 | Yanlış anahtar (`0`×64) | **3** | geri yükleme başarısız |
| 3 | Bozuk snapshot (tek bayt XOR) | **3** | geri yükleme başarısız |
| 4 | Depo içi hedef | **1** | — |

Üretim DB'sine **gerçek yazma denemesi yapılmadı**. Yazma sayacı: `DB_ONCE = DB_SONRA =
2253|126|1538` ⇒ `database_write_count = 0`.

---

## 9. OTOMATİK TIMER KANITI

**Durum: NOT RUN.**

### Ölçüm

```
systemctl is-enabled  → enabled
systemctl is-active   → active (waiting)
Active since          → 2026-10-30 12:13:25 UTC
Trigger (NEXT)        → 2026-10-30 13:01:53 UTC   (ölçüm anında 23 dk kaldı)
LAST                  → -   (hiç çalışmadı)
```

### Journal — kesin kanıt

```
timer:   Oct 30 12:13:25 Started tezlify-ram-snapshot.timer
service: Oct 30 12:13:25 Starting tezlify-ram-snapshot.service
         Oct 30 12:13:36 Finished tezlify-ram-snapshot.service
```

Journal'daki **tek** service kaydı 12:13:25'teki **elle** `systemctl start`'tır (3.9.18'de
yapıldı). Timer'ın kendisi **hiç tetiklemedi** — `LAST = -` bunu doğruluyor.

### Sınıflandırma

Log'daki 5 satırın tamamı **manuel/systemd tetiklemeli**dir. Hiçbiri otomatik koşum **değildir**.
Bu raporda otomatik koşum olarak sayılmadı.

Timer elle tetiklenmedi, saati değiştirilmedi, sistem bekletilmedi.

### Doğal tetiklemeden SONRA çalıştırılacak salt-okunur kontroller

```bash
# 1) timer gercekten tetikledi mi
systemctl list-timers tezlify-ram-snapshot.timer --no-pager
journalctl -u tezlify-ram-snapshot.timer -n 5 --no-pager

# 2) service timer tarafindan mi baslatildi (elle degil)
journalctl -u tezlify-ram-snapshot.service -n 10 --no-pager

# 3) son kosum OK mu
tail -1 /var/backups/tezlify-ram/snapshot.jsonl

# 4) restart sayilari degismedi mi
for c in tezlify-gateway tezlify-backend tezlify-db tezlify-caddy; do
  printf "%s=%s " "$c" "$(docker inspect -f '{{.RestartCount}}' $c)"; done; echo
```

Beklenen: `LAST` dolu, journal'da timer tetiklemesi, `status=OK`, `remote_verified=true`,
restart 0/0/0/0.

---

## 10. SNAPSHOT SHA VE OCI DOĞRULAMASI

**Durum: PASS.**

| Ölçüm | Değer |
|---|---|
| Son snapshot | `tezlify-ram-20261030T121325Z` |
| Yerel `.rsnap` SHA-256 | `2d1fbc85…` |
| OCI kopyası SHA-256 | `2d1fbc85…` — **eşit** |
| Manifest SHA-256 | `c90d074a…` — eşit |
| Manifest | `kind=tezlify.ram_snapshot`, `schema=1` |
| Yerel dosya sayısı | 10 `.rsnap` / 10 manifest |
| OCI | **20 nesne / 71.752.571 B** |
| OCI tutarlılığı | 16 → 20 nesne, 57.339.163 + 2×(7.189.748+16.956) = **71.752.571** ✅ |
| `escrow_izi` | **YOK** |

---

## 11. DİSK / KAPASİTE ANALİZİ

**Durum: PASS (bilgi).** Retention veya otomatik silme **eklenmedi**.

### Ölçülen

| Ölçüm | Değer |
|---|---|
| Tek koşum | 7.189.748 B (`.rsnap`) + 16.956 B (manifest) = **7.206.704 B** |
| Disk | 96 G toplam · 45 G dolu · **52 G boş** · **%47** |
| Snapshot boyut aralığı | 7.100.080 – 7.189.748 B |
| OCI nesne / bayt | 20 / 71.752.571 B |
| **OCI kotası** | **ERİŞİLEMEDİ** |

### Projeksiyon — bugünkü boyutla

| Pencere | Toplam |
|---|---|
| Günlük (24 koşum) | 172.960.896 B = **164,9 MiB** = **0,161 GiB** |
| Haftalık (168) | 1.210.726.272 B = **1,13 GiB** |
| Aylık (720) | 5.188.826.880 B = **4,83 GiB** |

52 GiB boş alanla bugünkü hızda **~322 gün** yeter.

### Tavan senaryosu — 200.000 mesaj (785 B/mesaj)

| Pencere | Toplam |
|---|---|
| Tek koşum | 157.000.000 B ≈ **149,7 MiB** |
| Günlük | **3,51 GiB** |
| Aylık | **105,3 GiB** |

Tavan senaryosunda 52 GiB **~14,8 günde** dolar.

### OCI kotası

Kota bilgisine **erişilemedi** (instance-principal izni kota sorgusuna yetmiyor). **Tahmin
üretilmedi.** Bu açık bir risk olarak §14'te duruyor.

---

## 12. İKİNCİ OFF-SITE KOPYA DEĞERLENDİRMESİ

**Yeni sağlayıcı kurulmadı, kimlik bilgisi oluşturulmadı.** Yalnızca değerlendirme.

**Kritik çerçeve:** `.rsnap` zaten AES-256-GCM ile şifreli. Yani üçüncü taraf sağlayıcı yalnızca
**şifreli metin** görür — sağlayıcıya duyulan güven ihtiyacı düşüktür. Buna karşılık **üç seçenek
de aynı anahtara bağlıdır**; anahtar riskini yalnızca §3'teki fiziksel escrow kapatır.

### Karşılaştırma

| Kriter | (1) İkinci OCI bölgesi | (2) İkinci sağlayıcı (R2/B2/S3) | (3) Operatör offline kopya |
|---|---|---|---|
| **Bağımsızlık** | **ZAYIF** — aynı tenancy/hesap; hesap kapanırsa ikisi de gider | **GÜÇLÜ** — farklı şirket, farklı kimlik | **EN GÜÇLÜ** — air-gap, ağ yok |
| **Erişim güvenliği** | Aynı IAM; sızıntı ikisini de açar | Yeni secret = yeni saldırı yüzeyi, ama izole | Fiziksel kontrol; dijital saldırı yok |
| **Şifreleme** | Aynı anahtar (tek nokta) | Aynı anahtar; envelope opsiyonel | Aynı anahtar; ciphertext medyada |
| **Maliyet** | ~0,04 $/ay egress + ~0,12 $ depolama | R2 ~0,07 $/ay · B2 ~0,03 $/ay · S3 ~0,11 $/ay + egress | Tek seferlik medya (~20–50 $) |
| **Kurtarma süresi** | Dakikalar | Dakikalar | **Saatler–günler** (fiziksel erişim) |
| **Operasyonel karmaşıklık** | **Düşük** — aynı araç, bölge değişir | **Orta** — yeni uploader + doğrulama yolu | **Yüksek** — insan disiplini, medya rotasyonu |

### Değerlendirme

- **(1) tek başına yetersiz.** "Sunucu + OCI kaybı" senaryosunu **çözmez**, çünkü aynı hesap
  altındadır. Bölge arızasına karşı korur, hesap kaybına karşı korumaz.
- **(2) doğru otomatik çözüm.** Farklı şirket + farklı kimlik gerçek bağımsızlık verir. Maliyeti
  ihmal edilebilir. Riski: yeni bir secret yönetimi ve ikinci bir yükleme yolu — "ikinci yedekleme
  sistemi kurma" ilkesiyle çelişmemesi için **mevcut orkestratöre hedef eklemek** şeklinde
  tasarlanmalı, ayrı bir sistem değil.
- **(3) son savunma hattı.** Otomatik değil, yavaş, ama ağ ve kimlik gerektirmez. (2) ile
  **birlikte** anlamlıdır.

**Öneri:** (2) + (3) birlikte. (1) atlanmalı — bağımsızlık yanılsaması yaratır.
**Kurulum için ayrı onay gerekir** (yeni secret, yeni sağlayıcı hesabı).

---

## 13. SECRET TARAMA SONUÇLARI

| Denetim | Sonuç |
|---|---|
| Bu raporda 64-hex anahtar | **0** |
| OCID / IPv4 / Bearer / private key | **0** |
| Anahtar argv'ye geçti mi | **hayır** — yalnızca `env=` |
| Anahtar SSH stdout ile yerel makineye taşındı mı | **hayır** — prosedür düzeltildi (§3.3) |
| Anahtar log'a / manifest'e yazıldı mı | **hayır** — 0/10 manifest |
| Log'daki 64-hex'ler | 5 adet, **hepsi `rsnap_sha256`**; 0'ı anahtara eşit |
| Commit'e giren secret | **0** |

Raporda yalnızca **8 haneli genel çapa** (`c25805a2`) ve **özet önekleri** (ilk 8 hex) var.

---

## 14. AÇIK RİSKLER

| # | Risk | Ciddiyet | Durum |
|---|---|---|---|
| 1 | Fiziksel kopya A/B yok | **YÜKSEK** | BLOCKED — operatör eylemi |
| 2 | Kâğıttan restore yapılmadı | **YÜKSEK** | NOT RUN — A'ya bağlı |
| 3 | Otomatik timer koşumu kanıtlanmadı | **ORTA** | NOT RUN — 13:01:53 UTC sonrası |
| 4 | İkinci sağlayıcıda ciphertext yok | **YÜKSEK** | "sunucu+OCI kaybı" kurtarılamaz |
| 5 | OCI kota sınırı bilinmiyor | **ORTA** | erişilemedi; tahmin üretilmedi |
| 6 | Persistence kapalı (`enabled=None`) | **YÜKSEK** | `313380f` merge edilmedi |
| 7 | Retention yok — tavanda 52 GB ~14,8 gün | **ORTA** | ayrı onay bekliyor |
| 8 | Eski runbook komutu anahtarı SSH ile taşıyordu | **ORTA** | **düzeltildi** (§3.3) |

---

## 15. NİHAİ KABUL MATRİSİ

| # | Kriter | Durum | Kanıt |
|---|---|---|---|
| 1 | Aktif anahtar ↔ v2 escrow eşleşiyor | **PASS** | üç ölçüm `c25805a2` |
| 2 | Anchor `c25805a2` doğrulandı | **PASS** | deşifreleme ile |
| 3 | Fiziksel kopya A oluşturuldu | **BLOCKED** | — |
| 4 | Fiziksel kopya A `MATCH` | **NOT RUN** | — |
| 5 | Fiziksel kopya B oluşturuldu | **BLOCKED** | — |
| 6 | Fiziksel kopya B `MATCH` | **NOT RUN** | — |
| 7 | Kâğıttan anahtarla restore başarılı | **NOT RUN** | A'ya bağlı |
| 8 | Identity set eşit | **PASS** | mekanik test |
| 9 | Identity root eşit | **PASS** | mekanik test |
| 10 | Kayıt sayısı eksiksiz | **PASS** | 9.154/9.154 |
| 11 | Production DB yazımı sıfır | **PASS** | 2253\|126\|1538 → aynı |
| 12 | Yanlış anahtar reddedildi | **PASS** | rc=3 |
| 13 | Bozuk snapshot reddedildi | **PASS** | rc=3 |
| 14 | PostgreSQL hedefi reddedildi | **PASS** | rc=1 |
| 15 | Depo içi hedef reddedildi | **PASS** | rc=1 |
| 16 | Gerçek otomatik timer koşumu | **NOT RUN** | `LAST = -` |
| 17 | Remote verification başarılı | **PASS** | son 3 koşum `true` |
| 18 | Snapshot SHA eşleşti | **PASS** | `2d1fbc85…` |
| 19 | Secret sızıntısı yok | **PASS** | §13 |
| 20 | Production restart yok | **PASS** | 0/0/0/0 |
| 21 | Production deploy yok | **PASS** | `5cd3eae`/`cbe4f509` |
| 22 | Persistence kapalı | **PASS** | `enabled=None` |

**Skor: 15 PASS · 2 BLOCKED · 5 NOT RUN**

### Neden COMPLETE/PASS yazılmadı

Zorunlu üç kriter kanıtlanmadı:
- fiziksel kopya A ve B (operatör eylemi),
- kâğıttan restore (A'ya bağlı),
- gerçek otomatik timer koşumu (zamanı gelmedi).

**3.9.19 durumu: PARTIAL.** Bu üçü tamamlanmadan PASS verilemez.

---

## DURMA NOKTASI

Operatör eylemi bekleniyor. Bu aşamada yapılmayanlar:

- persistence aktivasyonu **yok**
- `313380f` merge **yok**
- RAM verisinin PostgreSQL'e aktarımı **yok**
- gateway davranış değişikliği **yok**
- yeni off-site sağlayıcı **yok**
- retention politikası **yok**
- deploy / restart / timer değişikliği **yok**

**Sonraki aşama:** AŞAMA 3.9.20 — persistence aktivasyonu öncesi son güvenlik ve veri bütünlüğü
denetimi. Ayrı prompt ve açık onay bekler.

---

*Bu raporda anahtar, token, private key veya credential değeri yoktur. Yalnızca 8 haneli genel
doğrulama çapası (`c25805a2`) ve özet önekleri yer alır. Yapılmayan işlemler yapılmış
gösterilmedi; manuel koşumlar otomatik sayılmadı.*
