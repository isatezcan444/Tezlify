# Aşama 3.8.3 — Onaylı şifreli RAM mesaj yedeği ve restore doğrulaması

**Tarih:** 2026-10-29 (UTC 12:54 – 13:00)
**Mod:** KODLAMA + ALTYAPI, P0
**Sonuç:** Şifreli yedek alındı, bütünlüğü doğrulandı, geçici SQLite'a geri yükleme
kimlik kümesi bazında **birebir** eşleşti, üretim değişmedi.

Bu belge yalnızca **sayı, hash ve karar** içerir. Mesaj gövdesi, telefon numarası,
JID ve anahtar **yoktur**.

---

## 1. Ne yapıldı, ne yapılmadı

Yapıldı:

1. Gateway RAM'indeki mesaj kayıtları mevcut, doğrulanmış `messages/bulk`
   uç noktası üzerinden salt okunur alındı.
2. Kayıtlar AES-256-GCM ile şifrelenmiş tek bir dosyaya yazıldı.
3. Dosyanın bütünlüğü `--verify` ile doğrulandı; bozulmuş kopya reddedildi.
4. Geçici SQLite'a geri yüklendi ve kimlik kümeleri karşılaştırıldı.

Yapılmadı (ve yapılmayacak): üretim PostgreSQL'ine yazma, deploy, gateway
restart/recreate/logout/QR, `WHATSAPP_MEMORY_PERSIST_ENABLED` değişikliği,
kalıcılık sweep'i, gateway kodu veya canlı container dosya sistemi değişikliği.

---

## 2. Başlangıç durumu

| Öğe | Değer |
|---|---|
| Branch / HEAD | `main` / `bafe2b0` (temiz ağaç) |
| `origin/main` | `bafe2b0` |
| `release/backend-only-3.8.1` | `68ca413` (bu aşamada **değiştirilmedi**) |
| `.deployed-commit` | `b5715fe` |
| Oturum | 201, `CONNECTED`, `is_active=true` |

Container'lar (ID kısaltılmış, `StartedAt`, `RestartCount`):

| Container | ID | StartedAt | Restart |
|---|---|---|---|
| backend | `579085f13268` | 2026-10-27T22:25:45Z | 0 |
| gateway | `5b867095d376` | 2026-10-27T17:25:57Z | 0 |
| caddy | `ee66a5cab371` | 2026-10-12T13:12:45Z | 0 |
| db | `f6d79c4a1f8b` | 2026-10-01T17:45:08Z | 0 |

**Ölçülen (varsayılmayan) RAM durumu:** 9.137 mesaj / 99 sohbet.
3.8.2'deki 9.133 varsayılmadı; canlı trafik nedeniyle +4.

### Uç noktanın gerçekten doğru oturuma bağlı olduğunun kanıtı

- Canlı gateway dosyasında rota: `GET /sessions/:sessionId/messages/bulk`
  (`/app/src/index.js:563`), `withSession(...)` sarmalayıcısı ile.
- `jids` ve `perChatLimit` parametreleri **yayındaki** sürümde mevcut.
- Rastgele bir UUID ile aynı uç nokta çağrıldı → **404** (`WhatsAppGatewayError`,
  42 ms). Yani uç nokta oturum kapsamlıdır, "tüm mesajlar" döndürmez.

---

## 3. Anahtar kararı

Kullanılan anahtar: **`GATEWAY_ENCRYPTION_KEY`**, backend container'ının kendi
ortamında (64 karakter, ≥32). Şema repo'nun doğrulanmış codec'i ile birebir:

| Parametre | Codec (`encrypted-codec.js`) | Bu araç |
|---|---|---|
| Türetme | `sha256(passphrase)` → 32 bayt (`index.js:62`) | aynı |
| Şifre | AES-256-GCM | aynı |
| Nonce | 12 bayt, rastgele | aynı |
| AAD | UTF-8 bağlam dizesi | `tezlify.ram-snapshot:v1` |
| Düzen | `nonce ‖ ciphertext ‖ authTag` | `MAGIC ‖ nonce ‖ ct ‖ tag` |

**Neden bu anahtar:** Operatör tarafından dağıtım sırasında sağlanmış, doğrulanmış
mevcut mekanizma budur; yeni anahtar üretip güvenli saklamak bu ajanın
yapabileceği bir şey değildir ve öyle davranmak yasaktır. Anahtar hiçbir zaman
`argv`, shell geçmişi, log, rapor veya dosyaya girmedi: yalnızca container'ın
kendi ortam değişkeninden okundu, container içinde kaldı.

**Kalan risk (açıkça):** Bu, oturum kimlik bilgilerini koruyan anahtarın aynısıdır
⇒ dağıtım sırrına erişen herkes arşivi de çözebilir. Ayrı bir yedek anahtarı
istenirse bu ayrı bir karardır ve anahtarın operatör tarafından sağlanması
gerekir; bu aşamada yapılmadı.

AAD bağlamı bilinçli olarak farklıdır: aynı anahtarla üretilen bir oturum
şifreli metninin yedek dosyası gibi sunulmasını engeller. Dosya biçimi kendi
`MAGIC` (`RSNAP1`) ile ayrışır; JS codec ile tel-uyumlu olması amaçlanmadı.

---

## 4. Hedef dizin

| Kontrol | Sonuç |
|---|---|
| Yol | `/var/backups/tezlify-ram/` (yoktu, `sudo mkdir` ile oluşturuldu) |
| Sahip / izin | `ubuntu:ubuntu`, mode **700** |
| Git checkout mu? | **Hayır** (`/opt/tezlify` kullanılmadı: orası git checkout'u, `git clean` siler) |
| Dosya sistemi | `/dev/sda1`, 52 G boş |
| Çakışma | Dizin boştu; zaman damgalı, çakışmasız adlar kullanıldı |
| Dosya izinleri | Yedek ve manifest **600**, `umask 077` ile **oluşturulduğu anda** |

---

## 5. Export

| Öğe | Değer |
|---|---|
| Dosya | `/var/backups/tezlify-ram/tezlify-ram-20261029T125755Z.rsnap` |
| Boyut | **7.100.080 bayt** (~6,77 MiB) |
| İzin | `600` (`ubuntu:ubuntu`) |
| Pencere | `12:57:56Z` → `12:58:01Z` (5 s) |
| Kaynak container | `579085f13268` (backend) |
| Sohbet / kayıt | **99 / 9.137** |
| Duplicate | 0 |
| Kimliksiz kayıt | 0 |
| Eksik/bozuk kayıt | 0 |
| `shortfall>0` sohbet | 0 |
| Kararsız (`stable=false`) sohbet | 0 |
| Sohbet başına toplam | 9.137 (= `record_count`) |
| Tavanda (2.000) sohbet | 2 |
| `late_arrival` | 0 (**hesaplandı**, varsayılmadı) |
| `records_sha256` | `e035fd80…5cf180` |
| `identity_root_sha256` | `400dba30…6cfff2a` |

Export akışı: betik `docker exec -i` ile **stdin'den** konteynere verildi,
container dosya sistemine **hiçbir şey yazılmadı**; şifreli çıktı stdout'tan
host'taki dosyaya aktı.

> Aynı gün 12:56:57Z'de alınan bir önceki çift (`…T125657Z`) de dizinde duruyor.
> Veri kümesi aynıdır (checksum'lar birebir aynı: `e035fd80…` / `400dba30…`);
> farkı yalnızca pencerenin `started_at == ended_at` yazılmış olmasıydı. Bu
> artefakt **geçersiz değil, üstünü çizilmiş** sayılmalı; yetkili yedek
> `…T125755Z`'dir. Silinmedi: yedeği metadata kusuru yüzünden yok etmek yanlış olur.

---

## 6. Bütünlük doğrulaması

`--verify` **diskteki dosya** üzerinde çalıştırıldı (stdin'den okutularak):

```json
{ "ok": true, "integrity_problems": [], "completeness_problems": [],
  "checked": { "record_count": 9137, "chat_count": 99, "duplicate_identity": 0 } }
```

Exit **0**. Kontrol edilenler: AES-GCM auth tag, `MAGIC`/şema/`kind`, header ve
`header.session_id == manifest.session_id`, `records_sha256`,
`identity_root_sha256`, `(conversation_id, wa_message_id)` tekilliği,
`shortfall=0`, `stable`, kimliksiz kayıt = 0, raporlanan = serileştirilen.

**Bozulma testi:** dosyanın kopyasında tek bayt değiştirildi (offset 7.099.880,
212 → 43). `--verify` **exit 3** ile reddetti; kopya silindi; orijinal
dokunulmadı (aynı boyut, mode 600).

---

## 7. Restore doğrulaması

| Öğe | Değer |
|---|---|
| Hedef | `:memory:` (bellek içi SQLite) |
| `inserted` / `skipped_duplicate` | 9.137 / 0 |
| `restored_rows` / `expected_rows` | 9.137 / 9.137 |
| `source_identity_count` / `restored_identity_count` | 9.137 / 9.137 |
| `distinct_conversations` | 99 |
| `identity_set_equal` | **true** |
| `restored_identity_root_sha256` | `400dba30…6cfff2a` (= manifest) |
| `identity_root_matches` | **true** |
| `identity_conserved` | **true** |
| Exit | **0** |

`source identity set == restored identity set` sağlandı; satır sayısı tek başına
yeterli sayılmadı, küme eşitliği ve kök hash ayrıca karşılaştırıldı.

**Üretim DB bağlantısı restore sürecine aktarılmadı:** backend container'ının
`DATABASE_URL` şeması `postgresql`'dir; geri yükleme `-e DATABASE_URL=` ile
**boşaltılmış** bir süreçte çalıştırıldı ve süreçteki uzunluk **0** olarak
kanıtlandı. (Bu olmasaydı araç zaten `PermissionError` ile reddediyordu.)

### Neden dosya değil `:memory:` — §1 ile §6 çelişkisi

§6 "geçici bir SQLite **dosyası** oluştur ve silindiğini kanıtla" diyor; §1 ise
"canlı container dosya sistemini değiştirme" diyor. Gerçek veri için ikisi aynı
anda sağlanamaz: konteyner içinde dosya yazmak §1'i ihlal eder, host'ta yazmak
ise `cryptography` olmadığı için mümkün değil (host'ta yok; konteynerde var).
Bu yüzden gerçek veri **bellek içi** SQLite'a yüklendi: kimlik korunumu kanıtı
birebir aynıdır, hiçbir dosya oluşmaz (temizlenecek bir şey yoktur) ve canlı
container dosya sistemi değişmez. Dosya tabanlı yol (`--restore-to /yol.db`)
testlerde gerçek dosyalarla kapsanmıştır ve host'ta `cryptography` bulunan bir
ortamda tek komutla çalıştırılabilir.

**Temizlik kanıtı:** backend container'ının `/tmp` dizini boştur ve
`rsnap|snapshot|restore|tezlify-ram` desenine uyan **0** dosya vardır.

---

## 8. Bu aşamada araçta yapılan düzeltmeler

1. **`--verify -` / `--restore-from -` (stdin).** Dosya host'ta duruyor; konteynere
   dosya yazmadan doğrulama yapılabilmesi için tek yol buydu.
2. **Dürüst pencere.** `started_at` daha önce toplama **bittikten sonra**
   yazılıyordu ⇒ manifest sıfır uzunlukta bir aralık iddia ediyordu. Artık
   toplamadan önce açılıyor.
3. **`late_arrival_count` artık hesaplanıyor.** Önce hiç hesaplanmadığı hâlde `0`
   yazılıyordu; hesaplanamazsa `None` döner. Ölçülmemiş alanı 0 diye raporlamak,
   bu projede tekrar tekrar yakalanan hata sınıfının ta kendisidir.
4. **Tamlik kapısı.** `verify_snapshot` artık "bütün" ile "tam"ı ayırıyor:
   `integrity_problems` (checksum/şema/kimlik) ve `completeness_problems`
   (`shortfall>0`, `stable=false`, kimliksiz kayıt). İkisinden biri varsa
   `ok=false`. Böylece "checksum tutuyor" diye eksik yedeğe başarılı denemez.
5. **Kimlik kümesi karşılaştırması.** Geri yükleme artık satır sayısına ek olarak
   `identity_set_equal`, `restored_identity_root_sha256` ve
   `identity_root_matches` döndürüyor; hedefte **fazla** satır varsa satır sayısı
   tutsa bile `identity_conserved=false`.
6. **`:memory:` güvenli hedef sayılıyor** (hiçbir dosyaya dokunmaz).

Test sayısı: `test_ram_snapshot.py` **34 → 46** (12 yeni).

---

## 9. Üretimin değişmediğinin kanıtı

Dört container da bitişte **aynı ID, aynı `StartedAt`, `RestartCount=0`**,
`running`. `.deployed-commit` = `b5715fe`. Oturum 201 `CONNECTED`/aktif.

| Ölçüm | 09:28Z | 12:54Z | 12:59Z |
|---|---|---|---|
| `messages` | 1.890 | 1.965 | 1.977 |
| `conversations` | 125 | 125 | 125 |
| Gateway RAM | 9.133 | 9.137 | 9.137 |

`messages` sayısı **benim işlemim sırasında da** arttı. Bu, benim yazdığım anlamına
gelmez ve gelmemeli: artış 09:28→12:54 arasında da vardı (+75), yani canlı
WhatsApp trafiği normal ingest yoluyla yazıyor. Benim erişimim yalnızca `SELECT`
ve `GET`; yayındaki `b5715fe`'de sweep kodu **yok**; restore süreci
`DATABASE_URL` boşaltılmış olarak yalnızca `sqlite3` kullandı.

---

## 10. Kalan riskler

1. **Yedek yalnızca o an RAM'de olanı korur.** Daha önce tahliye edilmiş mesajlar
   geri getirilemez. Tavandaki iki sohbet her yeni mesajda en eskisini atmaya
   devam ediyor ⇒ bu yedek **zamanla değersizleşir**, tazelenmesi gerekir.
2. **Medya yok.** Kayıtlar yalnızca `media_id` taşır; medya baytları
   (`/app/media`, ~2,2 GB) bu yedeğin dışındadır. Bu bir "tam yedek" değil,
   **RAM mesaj kaydı yedeğidir**.
3. **Anahtar yeniden kullanımı** (§3): dağıtım sırrına erişen arşivi çözebilir.
4. **`:memory:` sapması** (§7): gerçek veri için dosya tabanlı restore yapılmadı.
5. **Yedek şifreli ama imzasız**: bütünlük anahtara bağlı; anahtar kaybolursa
   arşiv açılamaz, anahtar sızarsa gizlilik biter. Ayrı bir KMS yok.
6. **Manifest'te `late_arrival_count`** artık hesaplanıyor ama snapshot "o an"ı
   değil "o aralığı" temsil eder; export sırasında gelen mesajlar kısmen içeride
   kısmen dışarıda kalabilir.
7. 12:56:57Z çifti dizinde duruyor (§5) — yetkili olan `…T125755Z`'dir.

---

## 11. Sonraki güvenli adım

Yedek alındı; artık sıra **birikimi kalıcılaştırmaya** geldi. Sıra:

1. Onaylı bir backend deploy'u (release ref yeniden kesilmeli; `68ca413` artık
   `origin/main`'in gerisinde ve preflight bunu yakalıyor) — sweep'in üretimde
   ilk kez, kontrollü biçimde çalıştırılması.
2. Sweep çalıştıktan sonra `messages` sayısının yedeğe yaklaşması; **azalma**
   değil, artış beklenir.
3. Ancak ondan sonra 2.000 tavanı tartışılabilir; tavan yükseltmek tek başına
   hiçbir mesajı kurtarmaz.
