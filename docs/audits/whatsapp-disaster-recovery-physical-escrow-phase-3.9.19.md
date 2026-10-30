# AŞAMA 3.9.19 — FİZİKSEL ESCROW VE BAĞIMSIZ FELAKET KURTARMA TESTİ

**Tarih:** 2026-10-30 12:18–12:24 UTC
**Kapsam:** anahtar escrow doğrulaması, fiziksel kopya prosedürü, izole restore testi
**Genel sonuç:** **PARTIAL** — teknik zincir kanıtlandı, **fiziksel kopyalar henüz yok**

---

## GENEL SONUÇ

| Alan | Sonuç |
|---|---|
| Aktif anahtar ↔ escrow eşleşmesi | **PASS** — kriptografik olarak kanıtlandı |
| Anchor `c25805a2` doğruluğu | **PASS** — 3 bağımsız ölçüm + gerçek deşifreleme |
| İzole restore (`:memory:`) | **PASS** — 9.154/9.154, identity set/root eşit |
| PostgreSQL güvenlik kapısı | **PASS** — 4 olumsuz yol da reddedildi |
| Fiziksel kopya A | **BLOCKED** — kullanıcı henüz oluşturmadı |
| Fiziksel kopya B | **BLOCKED** — kullanıcı henüz oluşturmadı |
| Fiziksel escrow ile bağımsız restore | **NOT RUN** — kopya yok |

**Neden tam PASS değil:** §11 tamamlanma kriterleri "fiziksel kopya A ve B kullanıcı tarafından
oluşturuldu" diyor. Bunlar **fiziksel eylemlerdir**; ajan yapamaz ve yapmadı. Bu raporda
kopyaların var olduğu **iddia edilmiyor**.

**İkinci dürüstlük noktası:** saatlik timer **henüz hiç otomatik koşmadı**. Rapor anında
(12:18 UTC) ilk otomatik koşum 13:01:53 UTC'de, yani **43 dakika sonraydı**. Log'daki 5 satırın
hepsi 3.9.18'deki **elle/systemd tetiklemeli** koşumlardır.

---

## 1. BAŞLANGIÇ DURUMU

Aşama başında salt okunur ölçüm:

| Ölçüm | Değer |
|---|---|
| `/opt/tezlify` HEAD | `5cd3eae` |
| `.deployed-commit` | `cbe4f509` |
| Konteynerler | 4 ayakta, healthy |
| Restart (gw/be/db/caddy) | **0/0/0/0** |
| `whatsapp_memory_persistence.enabled` | **`None`** (kapalı) |
| Yerel snapshot | **10** `.rsnap` (7.100.080 – 7.189.748 B) |
| Backup dizini | `700 ubuntu:ubuntu` |
| Snapshot / manifest / log izinleri | **hepsi `600`** |
| Disk | 95 G toplam · **51 G boş** · %46 |
| Log | 5 satır, `600` |

---

## 2. TIMER VE SON SNAPSHOT DOĞRULAMASI

| # | Kontrol | Sonuç | Kanıt |
|---|---|---|---|
| 1 | `tezlify-ram-snapshot.timer` enabled + active | **PASS** | `is-enabled=enabled`, `is-active=active` |
| 2 | Son **otomatik** snapshot gerçekten çalıştı | **NOT RUN** | ilk otomatik koşum 13:01:53 UTC, henüz gelmedi |
| 3 | Son snapshot `status=OK` | **PASS** | `tezlify-ram-20261030T121325Z` |
| 4 | `remote_verified=true` | **PASS** | aynı satır |
| 5 | Yerel SHA ↔ OCI kopyası | **PASS** | `2d1fbc85…` her iki tarafta |
| 6 | Snapshot dosyaları `0600` | **PASS** | 10/10, `0600` olmayan **0** |
| 7 | Backup dizini `0700` | **PASS** | `0o700` |

### Tüm koşumlar

| Zaman (UTC) | Durum | rc | remote | upload |
|---|---|---|---|---|
| 11:54:08 | `DEGRADED_LOCAL_ONLY` | 4 | — | — |
| 11:55:24 | `DEGRADED_LOCAL_ONLY` | 4 | — | `UNKNOWN` |
| 11:56:56 | **OK** | 0 | **true** | `UPLOADED` |
| 12:12:54 | **OK** | 0 | **true** | `UPLOADED` |
| 12:13:25 | **OK** | 0 | **true** | `UPLOADED` |

İlk iki satır 3.9.18'de bulunan iki stdout ayrıştırma hatasının kanıtıdır (düzeltildi).

**Sonuç:** timer **kurulu ve çalışır durumda**, ama "otomatik koşum kanıtlandı" **denemez** —
bu ancak 13:01:53 UTC sonrası doğrulanabilir.

---

## 3. ESCROW SÜRÜM ANALİZİ

Biçim, **içerik okunmadan** ölçüldü.

| Özellik | `.key-escrow` (v1) | `.key-escrow-v2` |
|---|---|---|
| Boyut / izin | 90 B · `600` | 88 B · `600` |
| Önek uzunluğu | 22 | 22 |
| Anahtar kısmı uzunluğu | **66** | **64** |
| 64-hex mi? | **HAYIR** | **EVET** |
| Tırnak içinde mi? | **EVET** (`"…"`) | hayır |
| Tırnaklar soyulunca | 64 hex | — |
| `anchor8` | **`c25805a2`** (tırnak soyulduktan sonra) | **`c25805a2`** |

**Kritik bulgu:** v1 ile v2 **aynı anahtardır**. Fark bir anahtar döndürmesi (rotation) değil,
**tırnak temizliğidir** — v1 anahtarı `"…"` içinde saklıyordu, v2 çıplak 64-hex yazıyor.

### Aktif anahtar karşılaştırması

| Kaynak | Uzunluk | 64-hex | `anchor8` |
|---|---|---|---|
| `.key-escrow-v2` | 64 | ✅ | **`c25805a2`** |
| **Aktif** `GATEWAY_ENCRYPTION_KEY` (konteyner env) | 64 | ✅ | **`c25805a2`** |
| Runbook'ta belgelenen (3.9.7 `fp8`) | 64 | ✅ | **`c25805a2`** |

**Sonuç: PASS** — aktif şifreleme anahtarı `.key-escrow-v2` ile **aynıdır**. v1 de aynı anahtarı
taşır ama biçimi eski. **Fiziksel kopya için doğru kaynak v2'dir** (kâğıda `=` sonrası 64 karakter).

---

## 4. ANCHOR DOĞRULAMASI

İstenen: *"Sadece dosyanın mevcut olması yeterli değildir."* Bu yüzden üç ayrı kanıt üretildi.

### Kanıt 1 — Üç bağımsız ölçüm aynı çapayı verdi

Escrow dosyası, konteyner ortamı ve runbook'taki kayıt: **üçü de `c25805a2`**.

### Kanıt 2 — Gerçek snapshot deşifre edildi

Anahtar yalnızca `env=` üzerinden geçirildi (argv'de **yok**), `ram_snapshot.py --verify -`
çalıştırıldı:

```
verify_rc = 0
ok        = True
integrity_problems    = 0
completeness_problems = 0
```

Yani anahtar **gerçek bir üretim snapshot'ını açıyor**. Bu, "iki string eşit" demenin çok
ötesinde bir kanıttır: çapa, veriye **fonksiyonel** olarak bağlıdır.

### Kanıt 3 — Deşifre edilen içerik manifest ile birebir

| Alan | verify | manifest | Eşit |
|---|---|---|---|
| `record_count` | 9.154 | 9.154 | ✅ |
| `chat_count` | 100 | 100 | ✅ |
| `identity_root_sha256` | `0deff9b5…` | `0deff9b5…` | ✅ |
| `records_sha256` | `e10d6fe9…` | `e10d6fe9…` | ✅ |
| `duplicate_identity` | 0 | 0 | ✅ |

**Sonuç: PASS.**

---

## 5. FİZİKSEL KOPYA HAZIRLIK PROSEDÜRÜ

Mevcut altyapı **yeniden kullanıldı**, ikinci bir sistem kurulmadı:

| Bileşen | Durum |
|---|---|
| `scripts/backup/escrow_physical.py` | **zaten var** — güvenlik sözleşmesi test edildi |
| `docs/audits/whatsapp-escrow-physical-copy-runbook.md` | **zaten var** — operatör prosedürü |
| `anchor8 = c25805a2` | doğrulandı |

### Aracın sözleşmesi — sahte anahtarla kanıtlandı

Gerçek anahtar kullanılmadı; `'a'×64` sahte anahtarıyla:

| Komut | Beklenen | Ölçülen |
|---|---|---|
| `anchor` | yalnız uzunluk + çapa, **anahtar basılmaz** | `uzunluk=64`, `anchor8=ffe054fe` ✅ |
| `verify --expect <doğru>` | MATCH, rc=0 | **MATCH**, rc=0 ✅ |
| `verify --expect deadbeef` | MISMATCH, rc=1 | **MISMATCH**, rc=1 ✅ |
| `sheet` (onaysız) | REDDEDİLMELİ, rc=2 | **REDDEDİLDİ**, rc=2 ✅ |

Araç: dosyaya yazmıyor, ortam değişkenine koymuyor, ağa göndermiyor, `--out` parametresi
**bilerek yok**, clipboard'a dokunmuyor.

### Kopya A ve B prosedürü

| Adım | Kopya A | Kopya B |
|---|---|---|
| 1 | `escrow_physical.py sheet --i-am-the-operator` (operatörün kendi terminali) | aynı |
| 2 | Kâğıda 16×4 grubu elle geçir | aynı |
| 3 | `verify --expect c25805a2` → **MATCH** | aynı |
| 4 | Tarih + konum + doğrulayan kişi runbook'a işlenir | aynı |
| 5 | **Birinci** güvenli fiziksel konum | **Farklı** bina / risk alanı |

**Yasak:** fotoğraf, bulut notu, dijital mesaj, ekran görüntüsü.

---

## 6. FİZİKSEL KOPYALARIN KULLANICI TARAFINDAN DOĞRULANMA DURUMU

| Kriter | Durum |
|---|---|
| Kopya A oluşturuldu | **BLOCKED** — henüz yok |
| Kopya B oluşturuldu | **BLOCKED** — henüz yok |
| İki kopya da anchor kontrolünden geçti | **NOT RUN** |
| Kopya tarihi + tanımlayıcı kaydedildi | **NOT RUN** |

**Bu aşamada fiziksel kopya oluşturulmadı ve oluşturulduğu iddia edilmiyor.** Prosedür ve araç
hazır; eylem operatöre aittir.

**Operatör kopyaları oluşturduktan sonra** yalnızca şu doğrulama adımları çalıştırılmalı —
hiçbiri anahtarı yazdırmaz:

```bash
# 1) kâğıttan geri yaz, çapa ile karşılaştır (girdi gizli okunur)
python3 scripts/backup/escrow_physical.py verify --expect c25805a2
#    → SONUC = MATCH  (rc=0)

# 2) kâğıttan okunan anahtarla gerçek restore (anahtar env ile, argv'de değil)
python3 scripts/diagnostics/ram_snapshot.py \
  --restore-from <indirilen>.rsnap --restore-to ':memory:' \
  --encrypt-key-env ESCROW_KEY
#    → identity_set_equal=true, identity_root_matches=true
```

---

## 7. BAĞIMSIZ RESTORE TESTİ

**Ortam:** production host'unda `/tmp/tz3919` (mode `700`), `:memory:` SQLite, `DATABASE_URL`
**kaldırıldı**, production konteynerlerine müdahale **yok**.

| # | Adım | Sonuç |
|---|---|---|
| 1 | OCI'den snapshot + manifest indirildi | **PASS** — 7.189.748 B / 16.956 B |
| 2 | SHA-256 doğrulandı | **PASS** — `2d1fbc85…` / `c90d074a…`, `match=True` |
| 3 | Anahtar güvenli yolla alındı | **PASS** — `env=`, argv'de değil |
| 4 | `:memory:` üzerine restore | **PASS** — `rc=0` |
| 5 | PostgreSQL bağlantısı reddedildi | **PASS** — bkz. §9 |
| 6 | Kayıt sayısı | **PASS** — 9.154 |
| 7 | Sohbet sayısı | **PASS** — 100 |
| 8 | Identity set eşitliği | **PASS** — `true` |
| 9 | Identity root eşleşmesi | **PASS** — `true` |
| 10 | Mesaj kaybı yok | **PASS** — `expected_rows == restored_rows` |
| 11 | Üretim DB'sine yazılmadı | **PASS** — `database_write_count = 0` |

### Restore çıktısı

```
restore_rc              = 0
inserted                = 9154
skipped_duplicate       = 0
restored_rows           = 9154
expected_rows           = 9154
source_identity_count   = 9154
restored_identity_count = 9154
distinct_conversations  = 100
identity_set_equal      = True
identity_root_matches   = True
identity_conserved      = True
```

### Yazma kanıtı

```
DB_ONCE  = 2253|126|1538     (messages|conversations|contacts)
DB_SONRA = 2253|126|1538
```

**Birebir aynı ⇒ `database_write_count = 0`.** Restore yalnızca belleğe yazdı.

### ⚠️ Bu testin sınıfı

**MEKANİK TEST — bağımsız fiziksel escrow kabulü DEĞİL.** Anahtar dijital escrow dosyasından
okundu, kâğıttan değil. §6'daki kopyalar oluşmadan bu test "kâğıttan veriye" zincirini
kanıtlamaz. İstenen kabul için anahtarın **kâğıttan** girilmesi gerekir.

---

## 8. IDENTITY SET / ROOT SONUÇLARI

| Ölçüm | Değer |
|---|---|
| Kaynak kimlik sayısı | 9.154 |
| Geri yüklenen kimlik sayısı | 9.154 |
| `identity_set_equal` | **true** |
| `restored_identity_root_sha256` | `0deff9b5…` |
| Manifest `identity_root_sha256` | `0deff9b5…` |
| `identity_root_matches` | **true** |
| `identity_conserved` | **true** |
| `duplicate_identity` | 0 |
| `shortfall_sum` (manifest, sohbet toplamı) | **0** |
| `collected_sum` | 9.154 = `record_count` |
| `unstable_chats` | `[]` |
| `late_arrival_count` | 0 |
| `rejected_missing_identity` / `rejected_incomplete` | 0 / 0 |

Kimlik kümesi **birebir korundu**; kayıp veya fazlalık yok.

---

## 9. POSTGRESQL GÜVENLİK TESTİ

Dört olumsuz yol da **ampirik olarak** denendi — matris iddiaları varsayılmadı, ölçüldü.

| # | Senaryo | Beklenen | Ölçülen | Sonuç |
|---|---|---|---|---|
| 1 | `DATABASE_URL=postgresql://…` | reddet | `rc=1`, *"REDDEDILDI: DATABASE_URL postgres: uretim DB'sine geri yukleme reddedildi"* | **PASS** |
| 2 | Yanlış anahtar (64 sıfır) | AES-GCM reddet | `rc=3` | **PASS** |
| 3 | Bozuk snapshot (tek bayt XOR) | bütünlük reddet | `rc=3` | **PASS** |
| 4 | Depo içi hedef (`/opt/tezlify/tezlify.db`) | reddet | `rc=1` | **PASS** |

**Sonuç: PASS.** Güvenlik kapıları yalnızca kodda değil, **çalışırken** de doğrulandı.

---

## 10. FELAKET SENARYOSU MATRİSİ

| Senaryo | Kurtarma kaynağı | Ön koşul | Gerekli dosya/erişim | Kanıt durumu |
|---|---|---|---|---|
| **Gateway container kaybı** | Yerel snapshot | Container yeniden başlar, RAM dolu | `/var/backups/tezlify-ram/*.rsnap` + anahtar | **KANITLANDI** — restore testi |
| **Sunucu disk kaybı** | OCI snapshot + fiziksel escrow | Yeni sunucu + anahtar | OCI erişimi + **kâğıt anahtar** | **KISMİ** — OCI indirme ✅, kâğıt ❌ |
| **OCI erişim kaybı** | Yerel snapshot + fiziksel escrow | Sunucu sağlam | yerel `.rsnap` + kâğıt | **KISMİ** — yerel ✅, kâğıt ❌ |
| **Sunucu + OCI kaybı** | Fiziksel escrow + bağımsız snapshot kopyası | İkinci konumda `.rsnap` kopyası | kâğıt + ikinci kopya | **BLOCKED** — ikisi de yok |
| **Anahtar escrow kaybı** | İkinci fiziksel kopya | Kopya B | kâğıt B | **BLOCKED** — kopya yok |
| **Bozuk snapshot** | SHA/manifest doğrulaması | — | — | **KANITLANDI** — rc=3 |
| **Yanlış anahtar** | AES-GCM doğrulaması | — | — | **KANITLANDI** — rc=3 |
| **PostgreSQL hedefi** | Güvenlik kapısı | — | — | **KANITLANDI** — rc=1 |

**Kritik boşluk:** "Sunucu + OCI kaybı" senaryosu bugün **kurtarılamaz**. Kâğıt kopya *anahtar*
riskini kapatır; **ikinci snapshot kopyası** (ikinci sağlayıcı) hâlâ yoktur.

---

## 11. AÇIK RİSKLER

| # | Risk | Ciddiyet | Durum |
|---|---|---|---|
| 1 | Fiziksel kopya A/B yok | **YÜKSEK** | BLOCKED — operatör eylemi |
| 2 | İkinci sağlayıcıda snapshot kopyası yok | **YÜKSEK** | açık — "sunucu+OCI kaybı" kurtarılamaz |
| 3 | Otomatik koşum henüz kanıtlanmadı | **ORTA** | 13:01:53 UTC'de doğrulanacak |
| 4 | OCI kota sınırı bilinmiyor | **ORTA** | 3.9.18'den devir |
| 5 | Persistence hâlâ kapalı (`enabled=None`) | **YÜKSEK** | yama `313380f` merge edilmedi |
| 6 | Retention yok — tavan senaryosunda 52 GB ~15 gün | **ORTA** | ayrı onay bekliyor |
| 7 | Log'da 1. satırda `ram_total_reported` (eski kod) | **DÜŞÜK** | değeri `None`; yeni satırlarda yok |
| 8 | `.key-escrow` (v1) tırnaklı eski biçim | **DÜŞÜK** | aynı anahtar; v2 doğru kaynak |

---

## 12. SONRAKİ AŞAMA ÖNERİSİ

**AŞAMA 3.9.20 — PERSISTENCE AKTİVASYONU ÖNCESİ SON GÜVENLİK VE VERİ BÜTÜNLÜĞÜ DENETİMİ**

Ancak ondan **önce** kapatılması gereken iki fiziksel iş var:

1. **Kopya A ve B'nin operatör tarafından oluşturulması** — §5'teki prosedürle, `verify
   --expect c25805a2` → MATCH olana kadar.
2. **Kâğıttan restore testi** — anahtar kâğıttan girilerek §7 tekrarlanır; o zaman test
   "bağımsız fiziksel escrow" sınıfına yükselir.

Bu iki iş tamamlanmadan 3.9.19 **PASS'e çekilemez**.

**Bu aşamada yapılmayanlar:** persistence aktivasyonu yok · `313380f` merge yok · DB'ye RAM verisi
aktarımı yok · gateway davranış değişikliği yok · deploy yok · restart yok · timer değişikliği yok.

---

## SECRET TARAMASI

| Denetim | Sonuç |
|---|---|
| Bu raporda 64-hex anahtar | **0** |
| OCID / IPv4 / Bearer / private key | **0** |
| Log'da anahtara eşit 64-hex | **0** (5 adet 64-hex'in tamamı `rsnap_sha256`) |
| Manifest'lerde anahtar | **0** / 10 dosya |
| Anahtar argv'ye geçti mi | **hayır** — yalnızca `env=` |
| Anahtar sohbete/rapora/log'a yazıldı mı | **hayır** |

Raporda yalnızca **8 haneli genel çapa** (`c25805a2`) ve **özet önekleri** (ilk 8 hex) bulunur.

---

*Üretim güvenliği korundu: 0 restart, 0 deploy, 0 DB yazımı, 0 snapshot silme, 0 escrow
değişikliği, 0 IAM/bucket değişikliği. Timer'a dokunulmadı.*
