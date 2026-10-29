# Aşama 3.8.2 — RAM mesajlarını koruma ve güvenli yedek doğrulaması

**Tarih:** 2026-10-29 · **Mod:** kodlama + altyapı · **Deploy:** yok · **Gerçek export:** yok
**Gateway restart/recreate:** yok · **Üretim DB yazımı:** yok · **Sweep:** çalıştırılmadı

Bu aşamanın tek amacı, RAM'de duran mesajları **kaybetmeden** korumanın mümkün
olduğunu kanıtlamak. Hiçbir üretim yazımı yapılmadı; gerçek payload export'u
ayrı bir onaya bırakıldı.

---

## 1. RAM'den tam payload çıkabiliyor mu — EVET (mevcut, salt okunur yol)

Yeni bir uç nokta açmak **gerekmedi**. Mevcut `GET /sessions/:sid/messages/bulk`
(`index.js:564`) zaten `messagesByChat` içeriğini olduğu gibi döndürüyor:
`session-manager.js:1340` `for (const m of group) all.push(m)` — yani
serileştirilmiş DTO değil, **depodaki kaydın kendisi**.

Kayıt şeması (`_ingestUpsertMessage`, `session-manager.js:2523-2553`):

`id`, `timestamp_s`, `conversation_id` (gateway anahtarı = jid), `direction`,
`message_type`, `status`, `body`, `media_id`, `media_mime_type`,
`media_filename`, `media_caption`, `native_link_preview`, `quoted_message`,
`is_forwarded`, `is_pinned`/`pinned_at`/`pinned_until`, `is_view_once`,
`wa_message_id`, `client_message_id`, `sender_phone`, `recipient_phone`,
`sender_name`, `sender_name_source`, `participant_jid`, `participant_name`,
`created_at`.

Yani §2'nin istediği "kimlik, konuşma eşlemesi, zaman damgası, yön, gönderen,
metadata" **tam olarak** alınabiliyor.

### Sınırlar (dürüst)

| Depo | Tavan | Anlamı |
| --- | --- | --- |
| `messagesByChat` | **2.000 / sohbet** (`splice`, 5 nokta) | Export yalnızca RAM'de **hâlâ** duranı alır |
| `messagesByChat` | **300 sohbet** (`MESSAGES_BY_CHAT_MAX_CHATS`) | 301. sohbet girerse en eski sohbetin TAMAMI düşer |
| `rawMessagesByChat` | 500 / sohbet, 10.000 toplam | Ham proto export'u **tam değil** |
| `rawMediaCache` | 5.000, **diskte** (`raw-media-cache.json`) | Restart'a dayanır |

Ölçülen: **99 sohbet** (300 tavanına 201 pay), 9.133 mesaj.

## 2. Medya

Medya **RAM'de değil**. `/app/media` → 2,2 GB / 1.334 dosya, her biri
`.meta.json` yan dosyasıyla diskte. Mesaj kaydı yalnızca `media_id` + mime +
dosya adı + caption taşır. Ham proto (indirme için gereken `mediaKey`,
`directPath`) 5.000 kayıtla session dizininde kalıcı.

⇒ Snapshot **medya baytlarını içermez**; "tam yedek" olarak adlandırılamaz.
Adı: **"RAM mesaj kayıtları yedeği"**.

## 3. Tutarlılık — canlı trafik sürerken

Naif `offset` sayfalaması **kullanılamaz**: `listAllMessages` her istekte
listeyi yeniden sıralar, araya giren mesaj tüm offset'leri kaydırır.
Falsifiye edildi (aynı senaryo, 5 kayıt):

| Yöntem | Toplanan | Eksik |
| --- | --- | --- |
| Naif offset | `A0,A1,A1,A2,A3` | **`NEW`** (ayrıca `A1` iki kez) |
| Kimlik kümesi | `A0,A1,A2,A3,NEW` | — |

Bu, 3.6b'deki "sınırlı tur + cursor yok" hatasının aynı sınıfıdır. Bu yüzden
toplama **kimlik kümesi** üzerinden yapılır ve sohbet başına `stable` bayrağı
taşınır; `total`a ulaşılamazsa `shortfall` yazılır, "tamam" denmez.

## 4. Yinelenen ve yanlış tenant

* Kimlik = `(conversation_id, wa_message_id)` — DB'deki tekillik indeksiyle aynı.
* Tekilleştirme ilk geleni korur, **kaç tane atıldığını sayar** (sessizce düşürmez).
* Kimliksiz kayıt ayrı sayılır (`rejected_missing_identity`), yutulmaz.
* Snapshot tek bir `session_id` taşır; `verify_snapshot` yinelenen kimliği
  **bozuk dosya** sayıp reddeder.
* Geri yükleme hedefi `DATABASE_URL` postgres ise **reddedilir**.

## 5. İki sınırdaki sohbet (ölçüldü, salt okunur)

| Sohbet | Tür | RAM kayıt | Kimlikli | En eski | En yeni | Tavanda |
| --- | --- | --- | --- | --- | --- | --- |
| 38289 | kişi | 2.000 | 2.000 | 2026-10-24T15:06:50Z | 2026-10-29T07:31:08Z | **evet** |
| 38291 | **grup** | 2.000 | 2.000 | 2026-10-12T19:59:14Z | 2026-10-28T22:25:02Z | **evet** |

Her ikisinde de 0 kimliksiz kayıt. **Bir sonraki gelen mesaj en eskisini atar.**

### Bu ölçümde bulunan tuzak

Grup sohbetinin `contacts.phone_e164` alanı `jid:<...>@g.us` taşır. "Sadece
rakam" normalizasyonu onu var olmayan bir sohbete çevirir; ilk probum tam bu
yüzden 38291 için **0 kayıt** döndürdü ve "sohbet boş" gibi göründü. Export
sohbet listesini DB'den değil **gateway'in kendisinden** aldığı için bu tuzağa
düşmez; ama DB'den jid türeten her araç düşer. `audit_memory_gap.py` bunu
`jid:` dalıyla doğru yapıyor.

## 6. Snapshot tasarımı

`scripts/diagnostics/ram_snapshot.py` — yalnızca `SELECT` ve gateway `GET`.

**Kapsam:** 99 sohbet / 9.133 kayıt, ~6,22 MB (ort. 714 B, en büyük 53 KB).
**Biçim:** tek JSON: `header` + `records` + `manifest`.

**Güvenlik:**
* Varsayılan çıktı stdout; dosyaya yazmak için `--allow-plaintext` VEYA
  `--encrypt-key-env` zorunlu.
* Depo içindeki bir yola düz metin yazımı **reddedilir** (PII Git'e girmesin).
* Şifreleme repo'nun mevcut şeması: `sha256(key) → 32 B`, AES-256-GCM,
  12 B nonce, AAD `tezlify.ram-snapshot:v1` (`encrypted-codec.js` ile aynı).
  Anahtar argv'den okunmaz (`ps` görmez), dosyaya yazılmaz.
* **Anahtar yoksa şifreleme varmış gibi davranılmaz** — betik reddeder.
* Hedef: `/var/backups/tezlify-ram/` (0700). `/opt/tezlify` **kullanılmaz**:
  orası bir git checkout'u, `git clean` snapshot'ı siler. Boş alan 52 GB.

**Bütünlük:** `records_sha256` (içeriğin kendisi), `identity_root_sha256`
(sıralı kimlik etiketleri), sohbet başına sayı/`stable`/`shortfall`.
Manifest **içerik taşımaz** → Git'e konabilir, sızıntı değildir.

**Eksikler (adı konarak):** medya baytları yok; 2.000 üstü geçmiş zaten
kayıp; `rawMessagesByChat` 500/sohbet sınırı export'a dahil edilmedi.

## 7. Testler — `backend/tests/test_ram_snapshot.py`

**34 passed, exit 0.** Kapsanan §4 koşulları: kimlik korunumu, sohbet/tenant
eşlemesi, yinelenen tespiti, eksik payload ve bozuk snapshot reddi, bütünlük
doğrulaması, export'un DB'ye yazmaması (yapısal pin), snapshot/test verisinin
Git'e girmemesi. Ayrıca offset kayması ve `shortfall` senaryoları.

**Üretimde yalnızca toplu sayı üretildi** (payload yazılmadı, dosya
oluşturulmadı, konteynere dosya bırakılmadı): 9.133/9.133 kayıt, 0 yinelenen,
0 kimliksiz, 0 kararsız sohbet.

## 8. Release kapsamı — `b5715fe` → `release/backend-only-3.8.1`

12 backend dosyası, +2.868/−1.

| Dosya | Δ | Ne çözüyor | Mesaj/DB/sync/session | Ait olduğu aşama |
| --- | --- | --- | --- | --- |
| `core/config.py` | +58 | süpürme ayarları + fail-closed doğrulayıcı | yalnızca yapılandırma | 3.6 + 3.8.1 |
| `main.py` | +76 | lifespan kapısı, kapanış iptali, `/health` durumu | süpürmeyi **başlatan** yer | 3.6 + 3.8.1 |
| `services/whatsapp/memory_persistence.py` | +581 (yeni) | süpürmenin kendisi | **EVET — DB'ye mesaj yazar** | 3.6 / 3.8.1 |
| `orchestration/sync.py` | +19/−1 | on-demand PDO için `request_id` korelasyonu | sync yoluna dokunur (parametre + log) | 3.6 (`ba39e56`) |
| `services/whatsapp_gateway.py` | +6 | `request_id` iletimi | aynı | 3.6 (`ba39e56`) |
| `tests/conftest.py` | +39 | test DB yolunun gerçekten kullanılması | hayır (test) | önceki |
| 7 test dosyası | +2.100 | yukarıdakilerin testleri | hayır | karışık |

**Migration gerekmez.** Süpürme mevcut `(conversation_id, wa_message_id)`
kısmi tekillik indeksini kullanır; yeni tablo/kolon yok.

**Kontrat notu:** yayındaki gateway (`b5715fe`) `request_id` parametresini
**tanımıyor** (doğrulandı: `index.js`'te yok). Bilinmeyen parametre yok
sayıldığı için zararsız — ama korelasyon özelliği gateway deploy'una kadar
**etkisiz**. Aynı şekilde `perChatLimit` yayında **var** (kritik olan bu).

**Kapsam daraltma önerisi (uygulanmadı):** asgari kalıcılık değişikliği
`config.py` + `main.py` + `memory_persistence.py` (3 dosya). `sync.py` +
`whatsapp_gateway.py` (25 satır) yalnızca teşhis korelasyonu sağlar ve yayında
etkisizdir; istenirse ref'ten çıkarılabilir. Test dosyaları kodla birlikte
gitmelidir. **Ref değiştirilmedi.**

## 9. Onay gerektiren adım

Gerçek snapshot üretimi bu prompt kapsamında **yapılmadı**. Yapılması için:

1. Hedef dizin `/var/backups/tezlify-ram/` (0700) oluşturulacak,
2. Anahtar operatör tarafından sağlanacak (host dışında saklanacak),
3. `docker exec -i tezlify-backend python - --out - --encrypt-key-env … < ram_snapshot.py`
   çıktısı şifreli akış olarak host'a yazılacak,
4. Ardından `--verify` ve geçici SQLite'a `--restore-to` ile kimlik korunumu
   doğrulanacak.

## 10. Sonraki güvenli adım

**Adım 0 (ön koşul):** onaylı snapshot + `--restore-to` doğrulaması.
Bu tamamlanmadan tavan değişikliği veya gateway recreate **anlamsızdır**: 2.000
sınırındaki iki sohbet, bir sonraki mesajda en eskisini atmaya devam eder.
