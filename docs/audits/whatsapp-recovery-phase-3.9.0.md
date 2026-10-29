# AŞAMA 3.9.0 — WHATSAPP MESAJ KURTARMA VE VERİ BÜTÜNLÜĞÜ DENETİMİ

**Tarih:** 2026-10-29T21:53Z  
**Çalışma türü:** Salt okunur inceleme — kodlama, DB yazımı ve deploy YOK.  
**Hedef:** 9 silinmiş mesajın mevcut durumunu kanıtlarla sınıflandırmak ve güvenli kurtarma kararı hazırlamak.

---

## 1. Yönetici özeti

Aşama 3.8.6 deploy'unda `purge_raw_jid_identity_data` 1 LID contact + 1 sohbet + 9 mesaj **sildi**. Bu aşamada (3.9.0) o 9 mesajı ve ilişkili kayıtları üç bağımsız kaynak üzerinden iz sürdük:

1. **PostgreSQL DB** — 9 mesajın DB'de **hiçbir izi kalmamış**; conversation `38412` silinmiş, `contacts` içinde `jid:%@lid` patterni **0**.
2. **Gateway RAM** — 9 LID mesajı + 1 PN mesajı **hâlen RAM'de** (`CLASS_unmapped_jid`), snapshot tarafından **10/10 kapsanıyor**.
3. **LID köprüsü** — `lid_mappings` tablosunda bu LID için **köprü yok**; bu, mesajların doğru hedef sohbetine **güvenilir biçimde eşlenemeyeceği** anlamına gelir.

**Sınıflandırma:** 10 kaydın tamamı **B — Kanıt bekliyor** (kaynakta mevcut ama hedef sohbet kanıtlanamıyor). Kurtarma, LID→PN köprüsü oluşmadan veya manuel eşleme doğrulanmadan **D sınıfına düşme riski taşır** (yanlış sohbete yazma / yinelenme).

---

## 2. Production başlangıç/bitiş kanıtları

### 2.1 Başlangıç (21:46Z — deploy sonrası)

| Ölçüm | Değer |
|---|---|
| `.deployed-commit` | `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` |
| backend ID / StartedAt | `ce2e901b6619` / 2026-10-29T21:47 |
| gateway ID / StartedAt | `5b867095d376` / 2026-10-27T17:25 (değişmedi) |
| db ID / StartedAt | `f6d79c4a1f8b` / 2026-10-01T17:45 (değişmedi) |
| caddy ID / StartedAt | `ee66a5cab371` / 2026-10-12T13:12 (değişmedi) |
| conversations | 125 |
| messages | 2151 |
| contacts | 1537 |
| session 201 | `CONNECTED` |
| `whatsapp_identity_quarantine` | tablo var, **0 satır** |
| persistence | `config_enabled=false, runs=0, inserted=0` |

### 2.2 Bitiş (21:53Z — bu inceleme sonunda)

Tüm değerler başlangıçla **aynı** (inceleme salt okunurdu). `messages` canlı ingest nedeniyle 2151→2152 olabilir; bu beklenen davranış.

---

## 3. 9 mesaj için anonimleştirilmiş envanter

### 3.1 Silme olayının özeti (3.8.6 deploy)

Kaynak: `backups/releases/20261029T183544Z/migration-summary.txt`

```
purge_raw_jid_identity_data: 1 hayalet LID contact + 1 sohbet + 9 mesaj silindi,
0 köprüsü bilinen hayalet onarıma bırakıldı.
```

Release artifacts:
- `cutover-data-drop.txt`: `conversations:126→125, messages:2077→2068, contacts:1538→1537`
- `cutover-messages-lost.txt`: `messages:2077→2068 (id<=161322)`
- `db-counts-before.txt`: `126|2077|1538`
- `db-counts-after.txt`: `125|2068|1537`

### 3.2 DB izi (incelenen kaynaklar)

| Kaynak | Bulgu |
|---|---|
| `conversations` tablosu | `id=38412` **yok** (gap doğrulandı) |
| `contacts` (`jid:%@lid`) | **0 satır** (tüm hayaletler silinmiş) |
| `messages` (timestamp 2026-10-09 16:40) | **0 satır** (9 mesaj DB'ye asla yazılmamış veya silinmiş) |
| `messages` (`conversation_id=38412`) | **0 satır** |
| `messages` (`conversation_id IS NULL`) | **0 satır** (orphaned mesaj yok) |
| `whatsapp_private.lid_mappings` | 4320 satır; ilgili LID hash için **0 eşleşme** |
| `message_logs` | 4 satır (kampanya çıkışı); ilgili timeframe'de **0** |
| `whatsapp_data_audit` | 8 satır; silme olayına dair **kayıt yok** (tablo purge'dan önce hazır değildi) |

### 3.3 Gateway RAM izi

| Ölçüm | Değer |
|---|---|
| Toplam sohbet | 100 |
| Toplam RAM kayıt | 9139 |
| Eşlenemeyen (unmapped) | **10** (LID: 9, PN: 1) |
| Eşlenemeyen LID `jid_hash` | `2453b8a70004b2a5` (tüm 9 mesaj aynı sohbete ait) |
| Zaman aralığı | 2026-10-09T16:40:32 → 16:41:25 |

**Önemli:** 9 LID mesajının `jid_hash`'i aynı (`2453b8a70004b2a5`) — bu, aynı sohbetten geldiklerini gösterir. Ama `lid_mappings`'te bu hash için köprü **yok**.

### 3.4 Snapshot izi

| Dosya | Durum |
|---|---|
| `tezlify-ram-20261029T210007Z.rsnap` | 9139 kayıt, 100 sohbet, `ok:true` |
| Eşlenemeyen kapsamı | **COVERED 10 / MISSING 0** |
| Kimlik kökü | `743f5959b03a479d` |

Tüm 10 eşlenemeyen kayıt en son snapshot'ta mevcut.

---

## 4. Snapshot ve RAM inceleme sonuçları

### 4.1 Kaynak karşılaştırması

| Kaynak | 9 LID mesajı | 1 PN mesajı | Yorum |
|---|---|---|---|
| PostgreSQL `messages` | **Yok** | **Yok** | Silindi veya hiç yazılmadı |
| Gateway RAM (`/messages/bulk`) | **Var** (9) | **Var** (1) | `CLASS_unmapped_jid` |
| Snapshot (20261029T210007Z) | **Var** (9) | **Var** (1) | `--verify` geçti |
| `lid_mappings` köprüsü | **Yok** | N/A | LID→PN eşleşmesi yok |

### 4.2 İkinci gap: `conversation_id=38316`

`generate_series` taraması iki gap buldu: `38316` ve `38412`.

- `38412`: 3.8.6 deploy'ında silindi (migration summary'de "1 sohbet").
- `38316`: Komşu sohbetler (`38314, 38315, 38317, 38318`) 2026-10-27T20:32'de oluşturulmuş. Bu, 38316'nın 3.8.6'dan **önce** silindiğini gösterir. Büyük olasılıkla önceki bir `purge_empty_ghost_conversations` veya `purge_raw_jid_identity_data` çalışmasından.

Bu ayrık gap, 9 mesajla **doğrudan ilişkili değil**; ancak aynı sistematik riskin daha önce de gerçekleştiğini gösterir.

---

## 5. Otomatik başlangıç mutasyonları risk matrisi

Deployed kod (`cbe4f50`) içinde incelenen fonksiyonlar:

| Fonksiyon | DELETE sayısı | Kapsam | 3.8.9'da çalıştı mı? | Kalan risk |
|---|---|---|---|---|
| `purge_raw_jid_identity_data` | **0** *(değişti)* | LID hayaletler | Evet (bulunamadı) | **DÜŞÜK** — artık silmiyor |
| `purge_degenerate_phone_contacts` | 3 | `phone_e164 LIKE '+0%'` | Evet | Düşük — E.164 `+0` geçersiz |
| `purge_empty_ghost_conversations` | 1 | Boş sohbetler (mesaj yok) | Evet | Düşük — yalnızca gerçekten boş |
| `purge_synthetic_preview_messages` | 1 | `wa_message_id LIKE 'preview%'` | Evet | Düşük — uydurulmuş mesajlar |
| `ensure_contacts_unique_phone` | 2 | Yinelenen `(user_id, phone)` dedup | Evet | Orta — mesajları taşır, sonra siler |
| `ensure_verified_commercial_leads` | 1 | `message_logs` temizliği | Evet | Düşük — log değil mesaj |

**Kritik değişiklik:** `purge_raw_jid_identity_data` artık **0 DELETE**. 3.8.9 deploy'ında migration summary'de bu fonksiyona dair **hiçbir satır yok** (çünkü çalıştı ama işlem yapacak hayalet bulamadı).

---

## 6. Kurtarılabilir, belirsiz ve bulunamayan kayıtlar

### 6.1 Sınıflandırma tanımları

- **A — Kurtarmaya aday:** Benzersiz kimlik ve doğru hedef sohbeti güvenilir biçimde kanıtlanabiliyor.
- **B — Kanıt bekliyor:** Kaynakta mevcut, ancak hedef sohbet veya kimlik eşlemesi kesin değil.
- **C — Bulunamadı:** İncelenen kaynaklarda tespit edilemiyor.
- **D — Yinelenme riski:** DB'de zaten bulunması veya tekrar işlenmesi ihtimali var.

### 6.2 10 kaydın sınıflandırması

| Kaynak | LID (9 mesaj) | PN (1 mesaj) | Sınıf | Gerekçe |
|---|---|---|---|---|
| DB `messages` | Yok | Yok | **C** | Silinmiş veya hiç yazılmamış |
| Gateway RAM | Var | Var | **B** | Mevcut ama `conversation_id` yok |
| Snapshot | Var | Var | **B** | Mevcut ama hedef sohbet kanıtlanamıyor |
| `lid_mappings` | Yok | N/A | — | Köprü yok = hedef bilinmiyor |

**Toplam:**
- **A:** 0
- **B:** 10 (9 LID + 1 PN)
- **C:** 9 (DB açısından; snapshot'ta B)
- **D:** 0

### 6.3 Neden A değil?

Bir mesajı kurtarmaya aday (A) ilan etmek için şu koşulların hepsi gerekli:
1. ✅ Mesajın kendisi mevcut (snapshot/RAM)
2. ❌ LID→PN köprüsü mevcut **değil**
3. ❌ Hedef `contact_id` + `conversation_id` kesin **değil**
4. ❌ Tenant sahipliği (`user_id`) kesin **değil**

Köprü olmadan, aynı LID farklı bir kullanıcıya ait olabilir veya farklı bir sohbete yönlendirilebilir. Yanlış sohbete yazmak (D riski), yazmamaktan daha kötüdür.

---

## 7. Güvenli kurtarma için önerilen sonraki aşama

### 7.1 Önkoşullar (hepsi sağlanmadan kurtarma başlatılmamalı)

1. **LID köprüsünün oluşması:**
   - WhatsApp Web client'ı bu LID'yi tekrar görmeli ve `lid_mappings`'e `phone_jid` ile kaydetmeli.
   - Veya operatör manuel olarak doğru `phone_e164` ve `user_id`'yi doğrulamalı.

2. **Hedef sohbetin doğrulanması:**
   - `contact_id` ve `conversation_id`'nin mevcut olduğu kanıtlanmalı.
   - Aynı `wa_message_id`'ye sahip mesajın DB'de olmadığı teyit edilmeli (yinelenme kontrolü).

3. **Karantina defterinin kullanımı:**
   - Mesajlar `whatsapp_identity_quarantine`'a `bridge_unknown_has_messages` olarak kaydedilmeli.
   - Operatör `RELEASED` kararı vermeden fiziksel yazma yapılmamalı.

4. **Snapshot'tan geri yükleme testi:**
   - `:memory:` SQLite üzerinden kimlik eşleşmesi tekrar doğrulanmalı.
   - `verify_snapshot` + `restore_to_sqlite` + `identity_set_equal` çalıştırılmalı.

### 7.2 Kurtarma adımları (öneri, henüz onaylı değil)

1. Gateway RAM'inden veya snapshot'tan 10 kaydın kimlik setini çıkar.
2. Her `wa_message_id`'yi DB'de `SELECT` ile ara; eşleşen yoksa yinelenme riski düşük.
3. `lid_mappings`'te LID hash `2453b8a70004b2a5` için köprü ara.
   - Köprü varsa: hedef `contact_id`/`conversation_id` belirle.
   - Köprü yoksa: karantinaya al, kurtarmayı ertele.
4. Doğrulanmış hedeflere `INSERT INTO messages` yap (tenant filtresiyle).
5. `whatsapp_identity_quarantine`'ı `RELEASED` olarak güncelle.

### 7.3 Persistence açılması

`WHATSAPP_MEMORY_PERSIST_ENABLED=true` **yalnızca** şu koşullarda güvenlidir:
- Tüm mevcut RAM mesajlarının DB'de olup olmadığı doğrulanmış.
- `audit_memory_gap.py` ile `RAM_ONLY = 0` kanıtlanmış.
- Sweep dry-run çalıştırılmış ve beklenmeyen silme/çakışma yok.

**Bu aşamada persistence açılmadı.**

---

## 8. Test sonuçları ve çıkış kodları

Bu aşamada yalnızca salt okunur sorgular çalıştırıldı; test paketi çalıştırılmadı.

| İşlem | Çıkış kodu |
|---|---|
| Üretim DB sorguları | 0 (tümü başarılı) |
| Gateway RAM probe | 0 |
| Snapshot `--verify` | 0 (`ok:true`) |
| Snapshot coverage probe | 0 (`COVERED 10 / MISSING 0`) |
| Container log taraması | 0 |

---

## 9. Açık riskler ve engeller

| Risk | Önem | Açıklama |
|---|---|---|
| LID köprüsü yok | **YÜKSEK** | 9 mesajın hedef sohbeti kesin değil; kurtarma D riski taşır |
| İkinci gap (38316) | Orta | Başka bir silinmiş sohbet var; geçmişte de aynı risk gerçekleşmiş |
| Data audit eksikliği | Orta | 3.8.6 silme olayı `whatsapp_data_audit`'e yansımadı; geçmiş olaylar izlenemiyor |
| Gateway recreate riski | **YÜKSEK** | RAM'deki 10 kayıt gateway restart'ında kaybolur; snapshot tek kopya |
| Persistence açılmadı | Bilinen | RAM'deki diğer 7062 mesaj hâlen DB'ye aktarılmadı |

---

## 10. Sonuç

9 silinmiş mesajın **hiçbiri** PostgreSQL'de bulunamadı. **Hepsi** gateway RAM'inde ve şifreli snapshot'ta mevcut. Ancak **hiçbirinin** LID→PN köprüsü olmadığı için doğru hedef sohbetine güvenilir biçimde eşlenemiyorlar.

**Kurtarma kararı:** Henüz verilemez. LID köprüsü oluşana veya manuel eşleme doğrulanana kadar **B — Kanıt bekliyor** durumunda kalırlar. Snapshot'lar korunmalı ve gateway recreate'ten kaçınılmalı.

**Bu aşamada üretim DB'sine yazma yapılmadı.**
