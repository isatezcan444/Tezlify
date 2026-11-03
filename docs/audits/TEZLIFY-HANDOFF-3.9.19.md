# TEZLIFY — 3.9.19 / 3.9.19-B HANDOFF (BAĞLAM DEVRETME)

> **Bu dosyanın amacı:** 3.9.19 aşaması boyunca yapılan işi, ulaşılan sonuçları, takılan noktayı ve
> bir sonraki adımı tek başına özetlemektir. Bu dosyayı okuyan yeni bir AI, Tezlify WhatsApp
> kurtarma programının mevcut durumunu doğrudan anlamalıdır.
>
> **GÜVENLIK:** Bu dosya **anahtar, token, private key veya credential değeri içermez.** Yalnızca
> 8 haneli genel doğrulama çapası (`c25805a2`) ve özet (SHA) önekleri yer alır.

---

## 0. BÖLÜM DİZİNİ

1. Proje Bağlamı (Tezlify / WhatsApp)
2. Çalışma Belleği — Kritik Invariantlar (ASLA İHLAL EDİLMEYECEK)
3. 3.9.19 Güvenlik Kuralları (Yapılmayacaklar)
4. 3.9.19 Aşaması Özeti (A/B/C birleşik + kapanış)
5. 3.9.19-B InvalidTag Kök Neden Analizi
6. **MEVCUT DURUM — TAKILAN NOKTA**
7. Restore Runner Detayı (`/tmp/tz3919b/restore_from_paper.py`)
8. Güvenli Sabitler (ANCAK anahtar DEĞİL)
9. Operatör Eylemi — Sonraki Adım (tam komutlar)
10. 3.9.19-B Kabul Kriterleri
11. Git / Deploy Durumu
12. Açık Riskler
13. Yeni AI'nın Okuması Gereken Dosyalar

---

## 1. PROJE BAĞLAMI

**Tezlify**, bir WhatsApp entegrasyonu içeren bir üründür. WhatsApp mesaj verisi **yalnızca
gateway RAM'inde** tutulur (production'da `archive_mode=off`, PITR/slot yok). Bu veri, hiçbir
yedekleme olmadan kaybolabilir. 3.9.x programının amacı: bu RAM verisini **off-site, şifreli ve
kurtarılabilir** hâle getirmektir — ama **persistence (RAM→PostgreSQL) asla açılmadan**.

Son teslim edilen yapı (3.9.18 sonrası üretimde):
- `scripts/backup/hourly_snapshot.py` → gateway RAM'ini okur, AES-256-GCM ile şifreler, `.rsnap` + `.manifest.json` üretir.
- `scripts/backup/offsite_oci.py` → `.rsnap` dosyasını OCI'ye yazar.
- `scripts/diagnostics/ram_snapshot.py` → şifreleme/çözme + `restore_to_sqlite()` (yalnızca `:memory:` veya izin verilen hedefe).
- `scripts/backup/escrow_physical.py` → anahtarı 4×4 grup hâlinde kağıda geçirme / `verify --expect <anchor8>` aracı.
- `systemd` timer `tezlify-ram-snapshot.{timer,service}` → her saat başı snapshot alır (`RandomizedDelaySec=120`).

**Versiyonlar:** Yerel venv `cryptography 50.0.1`, `sqlite3 3.50.4`. Üretim `cryptography 41.0.7`.
Yerel restore, üretimden tamamen bağımsız bir makinede yapılır (bu, "bağımsız kurtarma" testini
gerçek kılar).

---

## 2. ÇALIŞMA BELLEĞİ — KRİTİK INVARIANTLAR

Bu projede herhangi bir eylem **önce bu invariantları** gözetmelidir. Detay:
`.workbuddy-ai/memory/MEMORY.md` ve `reference/` altındaki dosyalar.

En yüksek riskliler (özet):

- **Bir satırı silmek = veri kaybıdır, "bağlantı kesme" değildir.** `DELETE /sessions/{id}` o
  satırın konuşmalarını + mesajlarını ve gateway auth dizinini cascade siler.
- **Hiçbir yedek WhatsApp konuşma/mesajını kapsamaz.** Bir "rollback" vaadi ancak scratch DB'ye
  restore edilip **satır sayısı sayılarak** kanıtlanabilir. Dump boyutu bir şey ispat etmez.
- **Deploy yalnızca `scripts/deploy/host-release.sh` ile.** Elle `/opt/tezlify` resetlenmez.
  `.deployed-commit` otoritedir. "Push = deploy" **değildir.**
- **Deploy sırası geri alınamaz hasar verir:** gateway RAM'i üretim DB'sinde başka hiçbir yerde
  olmayan 7000+ mesaj tutuyordu. Her zaman: backend persistence → `/health.whatsapp_memory_persistence`
  doğrula → gateway. Gateway önce backend = veri kalıcı gider.
- **Bir deploy, satır silen startup migration'ları çalıştırabilir** — "migration dosyası yok" ≠
  "veri değişmedi". Deploy öncesi adayın `migrations.py`'sinde `delete(` ara.
- **`db` hiçbir compose dosyasında değildir** → asla `docker compose up -d --remove-orphans`
  yapılmaz (veritabanı silinir).
- **Asla pytest dev DB'de çalıştırılmaz.** `conftest` localhost olmayan `DATABASE_URL`'i reddeder.
  `TEST_DB_PATH` yeterli değildir; `settings.DATABASE_URL`'i de export et.
- **Çağrılmayan/hiç çağrılmamış bir guard = ölü guard.** Güvenmeden önce çağrı yerini grep et.

---

## 3. 3.9.19 GÜVENLIK KURALLARI (YAPILMAYACAKLAR)

3.9.19-B prompt'undan verbatim on iki kural:

1. Anahtarı hiçbir log/rapor/dosya/argv'ye yazma.
2. Anahtarı `getpass` ile al; terminal echo kapalı.
3. **Anahtarı environment variable olarak saklama** (bu, 3.9.18/19'daki `env=` kalıbından DAHA katı).
4. Production DB'ye bağlanma.
5. `DATABASE_URL`'i ortamdan çıkar.
6. SQLite `:memory:` hedefi kullan.
7. Restore yalnızca izole geçici ortamda.
8. Geçici dizin izni `0700`.
9. Production dosyalarına dokunma.
10. Konteyner restart / deploy / commit / push yapma.
11. Persistence aktivasyonu yapma.
12. Başarısızlıkta otomatik düzeltme veya production müdahalesi yapma.

**Ayrıca (3.9.19-B kök neden prompt'undan):** anahtarı SSH stdout üzerinden yerel makineye taşıma
yasak. Anahtarı benden isteme. Escrow dosyalarını yeniden üretme / üzerine yazma. Anahtar
rotasyonu yapma.

---

## 4. 3.9.19 AŞAMASI ÖZETİ

**Hedef:** Fiziksel escrow + bağımsız felaket kurtarma (disaster recovery) testi.

### 4.1 Yapılanlar ve sonuçlar

| İş | Durum | Kanıt |
|---|---|---|
| **C — Otomatik timer** | **PASS** | Timer 13:02:18 UTC'de **kendiliğinden** tetikledi (`LAST` dolu; `RandomizedDelaySec=120` ile +25s tutarlı; journal'da yalnız timer tetiklemesi). Üretilen snapshot `tezlify-ram-20261030T130218Z`. |
| **Snapshot bütünlüğü** | **PASS** | 9.154 kayıt / 100 sohbet, `shortfall=0`, `unstable_chats=0`, `.rsnap`/`manifest` izin `0600`. |
| **Remote verification** | **PASS** | `--download-check`: yerel SHA = log SHA = indirilen SHA = `229e3351…`. OCI 20→22 nesne, `71.752.571 + 7.194.728 + 16.956 = 78.964.255 B` tam eşleşme. |
| **Production sağlığı** | **PASS** | Tüm konteynerlar healthy, restart `0/0/0/0`, disk %46. |
| **Persistence** | **DISABLED** | `whatsapp_memory_persistence.enabled = None`. `313380f` merge edilmedi. |
| **Database writes** | **0** | Production DB'ye restore denemesi yapılmadı. |
| **A — Fiziksel escrow** | **BLOCKED** | Kopya A/B **oluşturulmadı** (insan eylemi; ajan üretemez). |
| **B — Paper-key restore** | **NOT RUN** | A tamamlanmadan çalıştırılamaz. |

**3.9.19 kapanış sonucu:** `PARTIAL — OPERATÖR EYLEMİ GEREKLİ`. C→PASS yükseldi; A ve B operatöre
bağlı olduğu için `COMPLETE` verilmedi.

### 4.2 Anchor doğrulaması (3.9.19 mekanik testi)

| Kanıt | Sonuç |
|---|---|
| `.key-escrow-v2` `anchor8` | `c25805a2` |
| Aktif `GATEWAY_ENCRYPTION_KEY` `anchor8` | `c25805a2` |
| Runbook 3.9.7 `fp8` | `c25805a2` |
| **Gerçek snapshot deşifre** (env ile) | `ok=true`, `record_count=9154`, `identity_root=0deff9b5…` |

Dört bağımsız PostgreSQL güvenlik yolu da reddedildi (postgres hedefi rc=1, yanlış anahtar rc=3,
bozuk blob rc=3, repo içi hedef rc=1).

**Detaylı raporlar:**
- `docs/audits/whatsapp-disaster-recovery-physical-escrow-phase-3.9.19.md` (15 bölüm, 15 PASS / 2 BLOCKED / 5 NOT RUN)
- `docs/audits/whatsapp-disaster-recovery-phase-3.9.19-closing.md` (kapanış; **untracked**, commit edilmedi)
- `docs/audits/whatsapp-escrow-physical-copy-runbook.md` (operatör prosedürü; §3.3 DÜZELTİLDİ)

---

## 5. 3.9.19-B INVALIDTAG KÖK NEDEN ANALİZİ

### 5.1 Olay

Operatör (kullanıcı), 3.9.19-B'nin başlangıç ön koşulunu ("fiziksel kopyalar oluşturuldu, yerel
doğrulama MATCH") **teyit etti**. Üretimden kopyalanan snapshot yerel makineye alındı, SHA
`229e3351…` ile doğrulandı. Runner hazırlandı. Operatör runner'ı kendi terminalinde çalıştırdı ve
kâğıttan anahtarı `getpass` ile girdi.

**Sonuç:**
```
anahtar uzunlugu  = 64
beklenen anchor8  = c25805a2
olculen anchor8    = d8921990
desifreleme       = InvalidTag
restore           = NOT RUN
```

### 5.2 Kök neden

**Fiziksel kopya (kâğıt) hiç oluşturulmadı.**

Operatör daha sonra açıkça belirti: *"fiziksel kurtarma anahtarını kendisinin oluşturmadığını"* ve
*"ben bu anahtarı nerden alcam bana ver"*. Yani 3.9.19-B başındaki "MATCH" teyidi, **gerçek fiziksel
kopyalara dayanmıyordu**. Operatör, doğru anahtarı hiçbir zaman kâğıda geçirmediği için, runner'a
ya rastgele bir değer ya da yanlış bir kaynaktan gelen bir anahtar girdi.

### 5.3 İspat (ölçülmüş)

Üretim sunucusunda, **yalnızca güvenli veri** (uzunluk, boolean, 8-hex) üreten probe çalıştırıldı:

| Kaynak | Uzunluk | `a8_core_raw` | v2 ile eşit mi? |
|---|---|---|---|
| Aktif gateway env | 64 | `c25805a2` | ✅ |
| Backend env | 64 | `c25805a2` | ✅ |
| `.key-escrow-v2` | 64 | `c25805a2` | ✅ |
| `.key-escrow-v1` (tırnaklı) | 66 | `c44e0261` | ❌ |
| v1 tırnaklar atıldıktan sonra | 64 | `c25805a2` | ✅ |
| Kâğıttan girilen anahtar | 64 | `d8921990` | ❌ |

**21 farklı** okuma sırası / normalizasyon / permütasyon test edildi (satır-satır, kolon-kolon,
ters, yılan, karakter-düzeyi kolon, büyük/küçük harf, tırnak, newline, v1/v2 varyantları). Hiçbiri
`d8921990` vermedi. Bu, `d8921990`'ın **sistematik bir düzen hatası değil, bilinmeyen/yanlış bir
kaynaktan gelen değer** olduğunu kanıtlar.

### 5.4 Escrow format uyumluluğu

- `escrow_physical.py sheet` → 4 satır × 4 grup, `1:xxxx … 16:xxxx`, sıralama korunur.
- `normalize()` = prefix at, tırnak at, küçük harfe çevir, `^[0-9a-f]{64}$` regex.
- `ram_snapshot.py` `decrypt_bytes(blob, secret)` → ham string, `derive_key = sha256(secret)`.
- **Format uyumsuzluğu YOK.** Sorun formatta değil; doğru anahtarın hiç var olmamasında.

### 5.5 Yapılan kod değişikliği (yalnızca runner)

`/tmp/tz3919b/restore_from_paper.py` dosyasına:

- `EXPECTED_ANCHOR = "c25805a2"` sabiti eklendi.
- `=== ANAHTAR KAPISI ===` bloğu eklendi: girilen anahtarın `anchor8`'i `c25805a2` ile eşleşmezse
  **restore yapılmadan** reddedilir (çıkış kodu `3`). Bu, `InvalidTag`'in anlamını ayırır: kapı
  öncesi = transkripsiyon/yanlış anahtar; kapı sonrası = bozuk blob.
- `InvalidTag` mesajı `"yanlis anahtar veya bozuk dosya"` → `"bozuk dosya"` olarak daraltıldı
  (yanlış anahtar artık kapıda yakalanıyor).
- **Üretim dosyalarına dokunulmadı.** Runner yalnızca `/tmp/tz3919b/`'de.

### 5.6 Sentetik testler (gerçek anahtar kullanılmadan)

| Test | Beklenen | Sonuç |
|---|---|---|
| Doğru anahtar + doğru snapshot | `gate_open=True`, decrypt OK, restore 3/2/True | ✅ |
| Yanlış anahtar + doğru snapshot | `gate_open=False`, `InvalidTag` | ✅ |
| Bozuk blob + doğru anahtar | `gate_open=True`, `InvalidTag` | ✅ |

---

## 6. MEVCUT DURUM — TAKILAN NOKTA

**BLOKE EDEN ŞEY: Fiziksel escrow kopyaları A ve B hiç oluşturulmadı.**

- 3.9.19-B başındaki "MATCH" teyidi gerçek fiziksel kopyalara dayanmıyordu.
- Operatör doğru anahtara sahip değil (kâğıt yok).
- Bu nedenle paper-key restore **gerçek anahtarla hiç çalıştırılamadı**; `PAPER-KEY RESTORE = FAIL`.
- 3.9.19 `COMPLETE` ilan edilmedi. 3.9.20'ye geçilmedi.

**Bu noktada yapılmaması gerekenler:** anahtarı üretip operatöre vermek (yasak + mümkün değil),
persistence açmak, deploy/restart, commit/push, yeni escrow dosyası üretmek, anahtar rotasyonu.

---

## 7. RESTORE RUNNER DETAYI

**Dosya:** `/tmp/tz3919b/restore_from_paper.py` (yerel makinede, izole)

**Neden CLI kullanılmadı:** `ram_snapshot.py`'nin `--restore-from` yolu anahtarı **yalnızca
`os.environ`'dan** okur (`secret = os.environ.get(key_env)`). Bu, kural 3'ü (env var yasak) ihlal
eder. Bu yüzden runner modülü import edip `decrypt_bytes(blob, secret)` + `restore_to_sqlite(":memory:", payload)`
doğrudan çağırır; anahtar sadece yerel değişkende durur, `finally` içinde `del` ile düşürülür.

**Kritik sabitler (runner içinde):**
```python
NAME = "tezlify-ram-20261030T130218Z"
EXPECTED_SHA = "229e3351fd67682c564f79b288ae3ca39ace4a523c2b1ced40756430721cb5cb"
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
EXPECTED_ANCHOR = "c25805a2"
```

**Çalışma mantığı:**
1. Ortam: `hedef = :memory:`, dizin `0700`, `DATABASE_URL` ortamdan çıkarılır.
2. Blob SHA-256 ile doğrulanır (`EXPECTED_SHA` ile eşleşmezse reddedilir).
3. `getpass` ile anahtar alınır (echo kapalı, argv'de yok, dosyaya yazılmaz).
4. `anchor8` hesaplanır; `EXPECTED_ANCHOR` ile eşleşmezse **restore yapılmadan** `REDDEDILDI` (rc=3).
5. Eşleşirse `decrypt_bytes` → `restore_to_sqlite(":memory:", payload)`.
6. Sonuçlar manifest ile karşılaştırılır; `PAPER-KEY RESTORE = PASS|FAIL`.

**Önemli:** Çıktı anahtar içermez (yalnızca uzunluk + `anchor8` + restore alanları). Operatör
çıktının tamamını yapıştırabilir.

---

## 8. GÜVENLI SABITLER (ANCAK ANAHTAR DEĞIL)

| Alan | Değer |
|---|---|
| Snapshot adı | `tezlify-ram-20261030T130218Z` |
| `.rsnap` SHA-256 | `229e3351fd67682c564f79b288ae3ca39ace4a523c2b1ced40756430721cb5cb` |
| `.rsnap` boyut | 7.194.728 B |
| `.manifest.json` SHA-256 | `14776f66c4b26e154aa2ad2897ffe22e53e5a8d9faae9750a4dbf32ddf87cded` |
| Anahtar `anchor8` (doğrulama çapası) | `c25805a2` |
| Manifest `record_count` | 9.154 |
| Manifest `chat_count` | 100 |
| Manifest `identity_root_sha256` | `e41f621b…` (13:02:18 snapshot'ı — runner bunu manifest dosyasından dinamik okur) |
| Manifest `shortfall` (toplam) | 0 |
| Manifest `unstable_chats` | `[]` |
| Üretim DB satırları (messages\|conversations\|contacts) | `2253\|126\|1538` (değişmedi) |
| Üretim persistence | `enabled: None` (kapalı) |
| Üretim restart | `0/0/0/0` (gw/be/db/caddy) |
| Üretim timer | `LAST 13:02:18 UTC`, `NEXT 14:00:18 UTC` |

> **Not:** Daha erken bir mekanik test (`tezlify-ram-20261030T121325Z`) için `identity_root_sha256`
> `0deff9b5…` olarak ölçülmüştü. Bu, **farklı bir snapshot** içindir. 3.9.19-B runner'ı her zaman
> yerel `tezlify-ram-20261030T130218Z.manifest.json` dosyasındaki değeri kullanır; karıştırma.

**Üretim erişim bilgileri (mevcut raporlarda zaten var):**
- Host: `130.162.247.20` · User: `ubuntu` · SSH key: `~/.ssh/id_tezlify_oracle`
- Escrow dosyası: `/var/backups/tezlify-ram/.key-escrow-v2` (sunucuda, `0600`, 88 B)
- Anahtar **sunucudan hiçbir şekilde çıkmaz** (SSH stdout'a veri olarak taşınmaz).

---

## 9. OPERATÖR EYLEMI — SONRAKI ADIM

> Bu adımları **AI değil, operatör** yapar. Anahtar hiçbir çıktıya, log'a, sohbete girmez.

### Adım 1 — Sunucuya etkileşimli gir (kayıt kapalı oturum)

```bash
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20
```
> Uyarı: SSH `script`/`tee` ile oturum kaydı AÇIK olmamalı; terminal scrollback temizlenmeli;
> ekran kaydı kapalı; `bash -o history` zorlaması yok.

### Adım 2 — Anahtarı yalnızca sunucu terminalinde görüntüle

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
Ekranda `anchor8 = c25805a2` görünmeli. 16 grubu (4×4) sırayla **kâğıda** geçir.

### Adım 3 — İki ayrı kâğıda, iki farklı fiziksel risk bölgesinde sakla

Kopya A ve B. Her ikisine de `anchor8 = c25805a2` not et.

### Adım 4 — Oturumu kapat, geçmişi/scrollback'i temizle

### Adım 5 — Yerel makinede kâğıttan restore'ı çalıştır

```bash
cd /tmp/tz3919b && /Users/isatezcan/Documents/Github/Tezlify/venv/bin/python restore_from_paper.py
```
`getpass` isteminde **A kopyasından** anahtarı yaz (echo kapalı, geçmişe yazılmaz).

- `KAPI DURUMU = ACILDI` görürsen restore başlar.
- `KAPI DURUMU = REDDEDILDI` görürsen kâğıdı kontrol et (1-2 karakter hatası anchor'ı tamamen
  değiştirir). Özellikle `6↔b`, `c↔e`, `d↔b`, `0↔8`, `a↔e` çiftlerine dikkat.

### Adım 6 — Çıktıyı AI'ya yapıştır

Çıktı anahtar içermez. AI, sekiz kabul kriterini karşılaştırıp `# 3.9.19-B Paper-Key Restore
Raporu`'nu yazar.

---

## 10. 3.9.19-B KABUL KRİTERLERİ

Raporda yalnızca **kanıtlanan** alanlara PASS verilir. Zorunlu sekiz kriter:

- `restore_rc = 0`
- `identity_set_equal = true`
- `identity_root_matches = true`
- `identity_conserved = true`
- `duplicate_identity = 0`
- `shortfall = 0`
- `unstable_chats = []`
- `database_write_count = 0`

Ve manifest karşılaştırması: `restored_rows == 9154`, `distinct_conversations == 100`,
`restored_identity_root_sha256 == manifest_identity_root_sha256`, `shortfall == 0`,
`unstable_chats == []`.

**Tümü sağlanırsa** 3.9.19 `COMPLETE` raporlanır. Aksi halde `PAPER-KEY RESTORE = FAIL` kalır.

**Kapanış kısıtı (3.9.19-B):** Bu yalnızca felaket kurtarma kabul testidir. 3.9.20'ye geçme,
persistence aktivasyonu yapma, yeni aşama başlatma.

---

## 11. GIT / DEPLOY DURUMU

| İşlem | Durum |
|---|---|
| Yerel `main` HEAD | `7afb540` (temiz) |
| `/opt/tezlify` HEAD | `5cd3eae` (değişmedi) |
| `.deployed-commit` | `cbe4f509` (değişmedi) |
| Kod değişikliği (3.9.19-B) | **yalnızca** `/tmp/tz3919b/restore_from_paper.py` (repo dışı) |
| Commit | **yapılmadı** (talimat gereği) |
| Push | **yapılmadı** |
| Deploy | **NOT PERFORMED** |
| Container restart | **0** |
| Persistence aktivasyonu | **yok** |
| Untracked dosya | `docs/audits/whatsapp-disaster-recovery-phase-3.9.19-closing.md` (kasıtlı bırakıldı) |

---

## 12. AÇIK RİSKLER

| # | Risk | Ciddiyet |
|---|---|---|
| 1 | Fiziksel kopya A/B yok | **YÜKSEK** |
| 2 | Kâğıttan restore yapılmadı | **YÜKSEK** |
| 3 | İkinci sağlayıcıda ciphertext yok — "sunucu+OCI kaybı" kurtarılamaz | **YÜKSEK** |
| 4 | Persistence kapalı (`313380f` merge edilmedi) | **YÜKSEK** |
| 5 | OCI kota sınırı bilinmiyor | **ORTA** |
| 6 | Retention yok — tavanda 52 GB ~14,8 gün (tavan senaryo) | **ORTA** |
| 7 | "MATCH" teyidi gerçek fiziksel kopyaya dayanmıyordu | **YÜKSEK** (süreç dersi) |

---

## 13. YENI AI'NIN OKUMASI GEREKEN DOSYALAR

1. `docs/audits/whatsapp-disaster-recovery-physical-escrow-phase-3.9.19.md` — 15 bölümlük kabul matrisi.
2. `docs/audits/whatsapp-disaster-recovery-phase-3.9.19-closing.md` — kapanış; timer PASS kanıtı.
3. `docs/audits/whatsapp-escrow-physical-copy-runbook.md` — operatör prosedürü (§3.3 DÜZELTİLDİ: anahtar SSH ile taşınmaz).
4. `.workbuddy-ai/memory/MEMORY.md` + `reference/` — invariantlar (A–T) ve irreversible damage notları.
5. `scripts/diagnostics/ram_snapshot.py` — `decrypt_bytes`, `restore_to_sqlite`, `assert_restore_target_is_safe` (read-only, değiştirme).
6. `scripts/backup/escrow_physical.py` — `sheet` / `verify --expect <anchor8>` aracı.
7. `/tmp/tz3919b/restore_from_paper.py` — 3.9.19-B runner (anchor8 kapısı eklenmiş).
8. `/tmp/tz3919b/tezlify-ram-20261030T130218Z.rsnap` + `.manifest.json` — yerel kopya (SHA `229e3351…`).

---

*Bu handoff dosyasında anahtar, token, private key veya credential değeri yoktur. Yalnızca 8 haneli
genel doğrulama çapası (`c25805a2`) ve özet (SHA) önekleri yer alır. Yapılmayan işlemler yapılmış
gösterilmedi.*
