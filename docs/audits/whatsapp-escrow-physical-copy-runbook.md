# ESCROW FİZİKSEL KOPYA — OPERATÖR RUNBOOK'U

**Tarih:** 2026-10-30
**Durum:** **HAZIRLIK TAMAM — KOPYA HENÜZ YOK.** Bu belge bir prosedürdür, bir tamamlama kaydı değildir.
**Neden var:** 3.9.11'in tek gerçek engeli `ESCROW_SEPARATION_BLOCKED`. Operatör **Seçenek B (fiziksel/offline kopya)** seçti.

---

## 0. NEDEN BU ADIMI AJAN YAPAMIYOR

Anahtarın kâğıda geçirilmesi **fiziksel** bir eylemdir. Ajan:
- anahtarı okuyamaz (okusa terminal çıktısına, yani transkripte düşer),
- yazdıramaz, kâğıda geçiremez, kasaya koyamaz,
- ve anahtarı hiçbir çıktıya/rapora/log'a yazmamak bu programın baştan beri değişmez kuralıdır.

Bu yüzden bu adımda üretilen şey **kopyanın kendisi değil, kopyanın doğruluğunu kanıtlayan araçtır.**

---

## 1. GENEL DOĞRULAMA ÇAPASI — `c25805a2`

Anahtarın kendisi değil, **SHA-256'sının ilk 8 hex'i**. 64 karakter = 256 bit entropi olduğu için bu 8 hane anahtar hakkında kullanılabilir bilgi vermez; yalnızca "elle yazarken hata yaptım mı" sorusunu yanıtlar.

| Ölçüm | Değer |
|---|---|
| `anchor8` = `sha256(64 karakterlik anahtar)` ilk 8 hex | **`c25805a2`** |
| Dosyanın tamamının SHA-256'sının ilk 8 hex'i | `d03ed27a` |
| 3.9.7'de kaydedilen `fp8` | **`c25805a2`** — birebir aynı ✅ |

Yani çapa, bu programda zaten kullanılan parmak izi şemasıyla **aynı**; yeni bir tanım uydurulmadı.

**Escrow dosyasının yapısı (içerik okunmadan, yalnızca biçim ölçüldü):**

| Özellik | Ölçülen |
|---|---|
| Yol | `/var/backups/tezlify-ram/.key-escrow-v2` |
| Boyut / izin / sahip | 88 B · `600` · `ubuntu` |
| Satır | 1 satır, 87 karakter (+ satır sonu) |
| Biçim | `<22 karakter önek>=<64 karakter anahtar>` |
| `=` konumu | 23 |
| Anahtar kısmı | **64 karakter, küçük-hex, doğrulandı** |
| Büyük harf (anahtar kısmında) | 0 |

→ Kâğıda yazılacak olan **`=` işaretinden sonraki 64 karakterdir.** Önek yazılmaz.

---

## 2. OPERATÖR ADIMLARI

> Aşağıdaki komutları **kendi terminalinizde** çalıştırın. Çıktıyı hiçbir sohbete, ajana, ekran görüntüsüne veya bulut notuna yapıştırmayın.

### Adım 1 — Kartı **sunucuda** üret (anahtar sunucudan ÇIKMAZ)

> **3.9.19-A'da düzeltildi.** Bu adımın eski hâli anahtarı `ssh … | python3 …` ile **SSH
> çıktısı olarak yerel makineye** taşıyordu. Bu artık **yasaktır**: *"Anahtarı uzak SSH çıktısı
> olarak yerel makineye taşıma yasak."* Ayrıca `escrow_physical.py` production sunucusunda
> bulunmaz, yani eski komut zaten yerel araca bağımlıydı.

Önce sunucuya **etkileşimli** girilir:

```bash
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@<host>
```

Sonra biçimlendirme **sunucunun kendi python'u ile** çalıştırılır — anahtar ağ üzerinden veri
olarak taşınmaz, yalnızca ekranda görünür ve elle kâğıda geçirilir:

```bash
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

Ekranda `uzunluk = 64` ve `anchor8 = c25805a2` görünmeli. 16 grubu (4 satır × 4 grup) sırayla
kâğıda geçirin. Bitince oturumu kapatın ve terminal geçmişini temizleyin (`history -c` ya da
terminali kapatın).

### Adım 2 — Kâğıttan geri yaz ve doğrula

```bash
python3 scripts/backup/escrow_physical.py verify --expect c25805a2
```

Anahtarı yapıştırıp Enter. Terminal ise girdi **gizli** okunur (`getpass`), ekranda yankılanmaz.

- `SONUC = MATCH` → kopya doğru.
- `SONUC = MISMATCH` → tek karakter hatası çapayı tamamen değiştirir; Adım 1–2'yi tekrarlayın.

Çıkış kodları sözleşmedir: `0` eşleşti · `1` eşleşmedi · `2` geçersiz girdi.

### Adım 3 — İki kopya, iki konum

En az **iki** fiziksel kopya, **iki ayrı** fiziksel konumda. Snapshot'ların (OCI) tutulduğu ortamdan bağımsız yerlerde.

### Adım 4 — Kaydı buraya işle

Kopya oluşturulduğunda bu belgeye **yalnızca şunu** ekleyin — anahtar değil:

```
Tarih / saat:
Kopya sayısı:       2
Konumlar:           <fiziksel konum 1>, <fiziksel konum 2>
Doğrulama:          verify --expect c25805a2 → MATCH
Doğrulayan:         <isim>
```

---

## 3. BU ADIMDA NE YAPILDI / NE YAPILMADI

| Yapıldı | Yapılmadı |
|---|---|
| Escrow dosyasının **biçimi** ölçüldü (içerik okunmadı) | Anahtar okunmadı / yazdırılmadı / kopyalanmadı |
| Genel çapa `c25805a2` hesaplandı ve 3.9.7 ile eşleştiği doğrulandı | Anahtar hiçbir dosyaya/rapora/log'a yazılmadı |
| `escrow_physical.py` yazıldı ve **sahte anahtarla** test edildi | Üretimde hiçbir dosya değiştirilmedi |
| Kâğıt kopya prosedürü yazıldı | Kâğıt kopya **oluşturulmadı** (fiziksel eylem) |
| | Escrow taşınmadı, silinmedi, `.env.production` değişmedi |

Üretimde 0 restart, 0 deploy, 0 DB yazımı, 0 dosya değişikliği.

---

## 4. BU KOPYA NEYİ KORUR, NEYİ KORUMAZ

| Senaryo | Fiziksel kopya var mı? | Sonuç |
|---|---|---|
| VM diski bozuldu, OCI'daki `.rsnap` sağlam | **Evet** | ✅ Kurtarılır — asıl hedef bu |
| VM tamamen kayboldu, tenancy sağlam | **Evet** | ✅ Kurtarılır |
| OCI hesabı/tenancy ele geçirildi veya kapatıldı | Evet | ⚠️ Anahtar var, **şifreli dosya yok** → kurtarılamaz |
| Kâğıt kopya kayboldu, VM sağlam | — | ✅ Etkisiz (anahtar hâlâ diskte) |
| Kâğıt kopya kayboldu, VM de gitti | — | ❌ Kurtarılamaz |

**Sonuç:** fiziksel kopya *anahtar* riskini kapatır, *kopya sayısı* riskini kapatmaz. İkinci sağlayıcıya ikinci kopya hâlâ açık bir iştir (3.9.11 §10).

**Ayrıca:** kâğıt kopya tek başına hiçbir veriyi açmaz — OCI'deki `.rsnap` dosyaları olmadan anlamsızdır. Yani kâğıdın çalınması tek başına veri sızıntısı değildir; yine de kasada/güvenli yerde saklanmalı.

---

## 5. BUNUN ARDINDAN "TAM PASS" NASIL KANITLANIR

Kâğıt kopya doğrulandıktan sonra yapılacak test — **3.9.13**:

1. Anahtar **yalnızca kâğıttan** okunur (dosyadan değil, `.env.production`'dan değil).
2. Anahtar geçici bir ortam değişkenine alınır, `ram_snapshot.py --restore-from <off-site .rsnap> --restore-to ':memory:'` çalıştırılır.
3. Beklenen: `9139/9139`, `identity_set_equal=true`, `identity_root_matches=true` (3.9.11'de ölçülen değerlerin aynısı).
4. Geçici dosya/ortam değişkeni temizlenir, doğrulanır.

Bu test geçerse zincir **kâğıttan veriye** kadar kanıtlanmış olur ve 3.9.11'in `PARTIAL` olan 8. ve 9. kriterleri **PASS**'a döner. O ana kadar "off-site recovery COMPLETE" **denemez**.

---

*Bu belgede anahtar, token, private key veya credential değeri yoktur. Yalnızca 8 haneli genel doğrulama çapası (`c25805a2`) ve dosya biçimi ölçümleri yer alır. Gerçekleştirilmeyen işlemler tamamlanmış gösterilmedi.*
*Hazırlayan: WorkBuddy AI Agent — 2026-10-30*

---

## 6. EK — `.key-escrow` (v1) ile `.key-escrow-v2` AYNI ANAHTARDIR (3.9.19'da ölçüldü)

Operatörün aklına gelebilecek soruyu kapatır: **"İki farklı anahtar mı var, hangisini yazacağım?"**

| Dosya | Boyut | Önek | Anahtar kısmı | `anchor8` |
|---|---|---|---|---|
| `.key-escrow` | 90 B | 22 | **66** — `"…"` tırnak içinde | tırnaklar soyulunca **`c25805a2`** |
| `.key-escrow-v2` | 88 B | 22 | **64** — çıplak küçük-hex | **`c25805a2`** |

Yani v1 → v2 geçişi bir **anahtar döndürmesi değil**, yalnızca **tırnak temizliğidir**. İkisi de
aynı anahtarı taşır; aktif `GATEWAY_ENCRYPTION_KEY` de aynı çapayı verir.

**Kâğıda yazılacak olan:** `.key-escrow-v2` içindeki `=` işaretinden **sonraki 64 karakter**.
v1'i kullanmayın — tırnakları yanlışlıkla kâğıda geçirme riski var.

### Ek kanıt (3.9.19)

Escrow anahtarı yalnızca ortam değişkeni üzerinden verilerek **gerçek bir üretim snapshot'ı**
deşifre edildi: `ok=true`, bütünlük ve tamlık problem listeleri boş, `record_count=9154`,
`identity_root_sha256` ve `records_sha256` manifest ile birebir. Yani çapa, dosyanın varlığına
değil, **veriyi açabilme yeteneğine** bağlı olarak doğrulandı.

**Fiziksel kopyalar hâlâ oluşturulmadı** — bu belge bir prosedürdür, tamamlama kaydı değildir.
