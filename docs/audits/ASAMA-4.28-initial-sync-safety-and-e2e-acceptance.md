# Aşama 4.28 — Initial Sync Güvenliği ve Uçtan Uca Kabul Tasarımı

**Tarih:** 2026-11-01 11:05–11:45 +0300
**Mod:** Analiz + izole kodlama + izole test. Production **read-only**, hiçbir yazma yok.
**Hedef:** Backend 4.7 + Gateway 4.17 (`de1f1ad34f123a304f6b6432cd22a546ccafac36`)

> **Tek cümle:** F2'nin **mekanizması** (front-trim sırasında offset kayması) gerçek gateway kodu üzerinde **kanıtlandı ve kapatıldı** — offset stratejisi penceredeki bir kaydı atlıyor (`atlanan=['w-17-49']`, `genuine=1`), parçalı strateji atlamıyor (`genuine=0`) ve **istek sayısı artmıyor**; ancak bu düzeltme **henüz dağıtılmadı**, dolayısıyla production'da F2 **hâlâ açıktır**.

---

## 0. Karar özeti

| Katman | Durum | Kanıt |
| --- | --- | --- |
| F2 kök neden (offset + read-time trim) | ✅ **kanıtlandı** | §2, gerçek `listAllMessages` |
| Seçilen çözüm (jid parçalama) | ✅ **kanıtlandı** | §4, §5 — A/B |
| Gateway sözleşmesi | ✅ **değişmedi** | §4.3 |
| `perChatLimit=50` davranışı | ✅ **korundu** | §5.3 (`got.size == CHATS*50`) |
| İstek sayısı (latency) | ✅ **artmadı** | §5.4 (3 = 3) |
| Backend regresyon | ✅ **yeni hata yok** | §5.6 (2066 → 2072 = +6 yeni test) |
| 4.27 F1 patch | ✅ **byte-identical korundu** | §7 |
| Production'a dağıtım | ❌ **yapılmadı** | §9 |
| Uçtan uca kabul | ⚠️ **PARTIAL** | §8 |

**Nihai karar:** **B — KODLAMA GEREKLİ (yapıldı, izole)** · **C — AKTİVASYON KARARI GEREKLİ** (dağıtım için ayrı onay) · **D — KRİTİK RİSK oluşmadı** (yeni veri kaybı yolu bulunmadı).

Katman ayrımı ayrıca raporlanır: *gateway PASS · backend initial sync PASS (harness) / PROD'DA AÇIK · persistence loop DEĞİŞMEDİ (kapalı)*.

---

## 1. Başlangıç commit, worktree ve patch doğrulaması

### 1.1 Doğrulanan durum (hiçbir dosyanın üzerine yazılmadı)

| Öğe | Değer |
| --- | --- |
| Ana çalışma ağacı `HEAD` | `7afb5406c29736bb914b27fa90e85a618ae9ce0e` (`main`) |
| Ana çalışma ağacı durumu | **kirli — 64 girdi** (dokunulmadı) |
| Denetim worktree | `/tmp/tz427-tree` @ `de1f1ad…` (detached) |
| Baseline worktree (karşılaştırma) | `/tmp/tz428-base` @ `de1f1ad…` (bu aşamada oluşturuldu) |
| `.deployed-commit` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` |

`/tmp/tz427-tree` içinde 4.27'den devralınan **değişiklikler korundu**:

```
 M backend/app/services/whatsapp/memory_persistence.py        ← 4.27 F1
 M backend/tests/test_whatsapp_pagination_contract.py         ← 4.27 F1 regresyon testi
```

### 1.2 Patch envanteri (aşama sonunda)

| Dosya | Satır | SHA256 | Durum |
| --- | --- | --- | --- |
| `docs/audits/ASAMA-4.27-epoch-reset-cursor.patch` | 54 | `ce05e047…11f5eb` | **byte-identical korundu** |
| `docs/audits/ASAMA-4.27-epoch-reset-cursor-test.patch` | 43 | `0a60b387…2369cd` | **yeni** — eksik olan regresyon testi hunk'ı |
| `docs/audits/ASAMA-4.28-initial-sync-chunking.patch` | 808 | `4de4ab10…40fddd` | **yeni** — bu aşamanın tamamı |

### 1.3 Bulgu: 4.27 patch'i eksikti (P2, düzeltildi)

`ASAMA-4.27-epoch-reset-cursor.patch` **yalnızca kaynak düzeltmesini** içeriyor; 4.27 raporunda "fix + regresyon testi" olarak tanımlanan artifact'ın **test hunk'ı patch'in içinde değildi**.

**Kanıt:** patch pristine `de1f1ad`'e uygulandı →

```
git apply --check …ASAMA-4.27-epoch-reset-cursor.patch   → temiz
memory_persistence.py  → /tmp/tz427-tree ile BYTE-IDENTICAL ✅
test_whatsapp_pagination_contract.py → DIFFERS ❌ (yeni test yok)
```

**Neden önemli:** "Patch var" demek "regresyon testi korunuyor" demek değil. Patch tek başına uygulandığında düzeltme gelir, ama **onu koruyan test gelmez** — yani düzeltme sessizce geri alınabilir hâle gelir.

**Düzeltme:** Orijinal patch **değiştirilmedi** (byte-identical, SHA256 aynı). Eksik hunk ayrı bir artifact olarak yazıldı: `ASAMA-4.27-epoch-reset-cursor-test.patch` (43 satır). Böylece ikisi birlikte 4.27'yi tam olarak yeniden üretir; hiçbir şey kaybolmadı.

---

## 2. F2 kök neden analizi

### 2.1 Kod yolu

| Adım | Dosya | Satır |
| --- | --- | --- |
| Initial sync isteği (`offset`, `perChatLimit=50`) | `backend/app/services/whatsapp/orchestration/sync.py` | 1696–1720 (fix öncesi) |
| Gateway route → parametre normalizasyonu | `whatsapp-gateway/src/index.js` | 567–585 |
| `perChatLimit` **okuma anında** kırpma | `whatsapp-gateway/src/session-manager.js` | 1272–1273 |
| id'ye göre sıralama | `session-manager.js` | 1321–1325 |
| Dilim | `session-manager.js` | 1326 |

Kritik satır:

```js
// session-manager.js:1272-1273
if (!seqMode && perChat !== null && group.length > perChat) {
  group = [...group].sort((a, b) => (a.id || 0) - (b.id || 0)).slice(-perChat);
}
```

### 2.2 Mekanizma

`perChatLimit` **yalnızca ingest'te değil, her istekte yeniden** uygulanır. Sonuç:

1. İstek 1: her sohbetin son 50'si seçilir → global dizi `S₁` (uzunluk ≤ 50·N) → `[0, 1000)` dilimi döner.
2. Sayfalar arasında bir sohbete **yeni mesaj** gelir → o sohbetin penceresi **ilerler**, en eski kaydı düşer.
3. İstek 2: yeniden kırpılır → global dizi **SOLA kayar**. `S₂[i] = S₁[i+1]` (kayan bölgede).
4. `offset=1000` ile devam edilir → `S₂[1000] = S₁[1001]`. **`S₁[1000]` hiçbir sayfada dönmez.**

Bu bir **silme değil, atlamadır**: kayıt gateway RAM'inde durmaya devam eder, sadece initial sync onu hiç görmez. Kullanıcı için görünür sonuç: sohbetin en eski mesajı DB'ye hiç yazılmaz → **sessiz eksik geçmiş**.

### 2.3 Neden `since` bunu kurtarmaz

`since` yalnızca **hangi kayıtların uygun olduğunu** daraltır; dizinin kaymasını engellemez. Yeni mesajlar `since` filtresinden geçer ve yine pencereyi ilerletir.

### 2.4 Neden "atlanan kayıt sonraki turda yakalanır" savunması yetersiz

Initial sync tamamlandığında `initial_sync_completed_at` yazılır; sonraki turlar `since_epoch` ile **su watermark'ından sonrasını** ister. Atlanan kayıt watermark'ın **altında** kaldığı için bir daha istenmez. Yani atlama **kalıcıdır**.

---

## 3. Alternatif karşılaştırması (A–E × 10 eksen)

> Kısıt: *"Sohbet başına son 50 mesaj hızlı yüklenmeye devam etmeli; ancak offset pagination nedeniyle front-trim sırasında mesaj atlanmamalı."*
> Yani **hem** `perChatLimit=50` **hem** atlama yasağı aynı anda sağlanmalı.

| Eksen | **A** Gateway'de seq+`perChatLimit` | **B** Seq ile tümünü tara, backend'de 50 seç | **C** Sohbet başına seq cursor | **D** Snapshot/watermark | **E** Offset'i koru, yarışı başka yolla kaldır |
| --- | --- | --- | --- | --- | --- |
| 1. Veri bütünlüğü | İyi (dikkatli tanımlanırsa) | **Tam** | İyi | **Yetersiz** (tek başına kaymayı durdurmaz) | **Tam** (E2) |
| 2. Sıralama | seq = ekleme sırası | seq | sohbet içi seq | id | id (değişmez) |
| 3. Gateway RAM | Nötr | Tüm geçmiş servis edilmeli; 2000/sohbet tavanı aşılamaz | Nötr | Nötr | Nötr |
| 4. Gateway yükü | 1 tarama | 1 tarama, **çok daha büyük** yanıt | **N istek** (100 sohbet → 100) | 1 tarama | **Aynı** (5 = 5) |
| 5. Backend DB yükü | Aynı | Fazlalık yazılıp atılmalı → yeni "son 50 seç" adımı | Aynı | Aynı | **Aynı** |
| 6. İlk yükleme gecikmesi | Aynı | **Belirgin kötüleşir** | **Kötüleşir** (seri) | Aynı | **Aynı** |
| 7. Restart / reconnect | epoch reset zaten var | epoch reset → tam yeniden tarama | **Kalıcı cursor tablosu gerekir** | Snapshot yenilenir | Değişmez |
| 8. API uyumluluğu | ❌ **Sözleşme değişir** → gateway release şart | ✅ seq zaten var, ama initial sync'te bağlı değil | ❌ yeni durum deposu | ⚠️ gateway'de snapshot API yok | ✅ **Sözleşme değişmez** |
| 9. Karmaşıklık | Orta | Orta-yüksek | Yüksek | Orta | **Düşük** |
| 10. Regresyon riski | **Yüksek** — `if (!seqMode && …)` guard'ı 4.27'de kırılganlığı kanıtlanmış bölge | Orta-yüksek | Yüksek | Orta (ama etkisiz) | **Düşük** |

### 3.1 Neden A reddedildi

- `perChatLimit` seq modunda **bilinçli olarak atlanıyor** (`if (!seqMode && …)`). A, bu guard'ı tersine çevirir → seq modunda kırpma geri gelir → **epoch reset + trim** etkileşimi doğar; 4.27'de tam bu bölgede bir P1 bulundu.
- **Dağıtım zorunluluğu:** gateway kodu değişir → backend-only release **imkânsız**. Memory'deki `backend_only_release` kısıtı gereği bu, release kapsamını gateway'e genişletir.
- Kazanç (daha az veri) ölçülebilir değil: parçalama zaten aynı istek sayısını üretiyor.

### 3.2 Neden B tek başına reddedildi

- Tüm geçmişi indirmek **"son 50 hızlı yüklenmeli"** kısıtıyla çelişir; ilk yükleme yükü sohbet sayısıyla **doğrusal** büyür.
- Gateway RAM'i **2000/sohbet** ile sınırlı; tüm geçmiş zaten erişilebilir değil (A6: eski geçmiş yalnız gateway RAM'inde, ilk sync 50/sohbet kalıcılaştırır).
- Backend'e "fazlalığı yazıp sonra sil" adımı ekler → **silme yolu** açar; bu projede silme = geri dönüşsüz hasar.

### 3.3 Neden C reddedildi

- İstek sayısı sohbet sayısıyla **doğrusal** (production: 100 sohbet → 100 istek, 5 yerine) → latency regresyonu.
- Sohbet başına cursor **kalıcı durum** gerektirir (yeni tablo + yeni yazma yolu) → bu aşamanın kapsamı dışında ve idempotency riski taşır.

### 3.4 Neden D reddedildi

Watermark **hangi kayıtların uygun olduğunu** sınırlar, **pencerenin kaymasını** engellemez. Sayfa 1 ile 2 arasında gelen mesaj `since`'ten geçer ve pencereyi yine ilerletir → kayma aynen sürer. D, tek başına F2'yi **kapatmaz**.

### 3.5 E'nin iki varyantı

| Varyant | İçerik | Sonuç |
| --- | --- | --- |
| **E1** | Gateway'den "sabit pencere" iste (`upToId` / `beforeId`) | Sözleşme değişir → A ile aynı dağıtım yükü |
| **E2** | **İsteği jid parçalarına böl** → her istek tek sayfada biter | ✅ **Sözleşme değişmez**, kanıtlanabilir |

**Seçilen: E2** (+ parça içinde offset sayfalamasının korunması — bkz. §4.3).

---

## 4. Seçilen çözüm

### 4.1 Değişmez (invariant)

```
chunk = page_size // per_chat_limit        →  1000 // 50 = 20
```

Bir istek en fazla `chunk` sohbet içerir. Gateway her sohbeti en fazla `per_chat_limit` kayda kırptığı için:

```
total ≤ chunk × per_chat_limit = (page_size // per_chat_limit) × per_chat_limit ≤ page_size
```

`total ≤ limit` olduğundan **istek ilk sayfada biter** (`offset(0) + limit ≥ total`) → **sayfalar arası offset hiç oluşmaz** → kayma **fiziksel olarak imkânsız**.

### 4.2 İstek sayısı değişmez

```
ceil(sohbet / chunk) = ceil(sohbet × per_chat_limit / page_size) = offset stratejisinin istek sayısı
```

Production ölçeğinde (100 sohbet, 9168 RAM mesaj): `ceil(100/20) = 5` vs `ceil(5000/1000) = 5` → **eşit**. Harness bunu ölçtü: `offset_pages=3 chunked_pages=3`.

### 4.3 Neden parça içinde offset sayfalaması **korundu** (kritik tasarım kararı)

İlk denemede parça içindeki offset döngüsü **kaldırıldı**. Sonuç: **4 mevcut test kırıldı** — `test_06_bulk_paging_uses_offset_limit_and_total`, `test_28_bulk_dedup_select_once_per_conversation_across_pages` ve 2 performans testi.

Bu bir engel değil **sinyaldi**: `test_06` tek sohbet + 2500 mesajla, `perChatLimit`'i **yok sayan** bir gateway'i taklit ediyor. O durumda `total = 2500 > 1000` → tek istek **kesik** dönerdi. Yani parça içi sayfalama, `perChatLimit`'i uygulamayan gateway'ler için **gereklidir**.

**İki dal da güvenlidir:**

| Gateway `perChatLimit` uyguluyor mu? | `total` | Sayfalama | Kayma mümkün mü? |
| --- | --- | --- | --- |
| **Evet** | `≤ page_size` | Tek sayfa | ❌ Hayır — tek istek |
| **Hayır** | `> page_size` | Parça içinde offset | ❌ Hayır — kırpma yok ⇒ dizi kaymaz; yeni mesajlar **kuyruğa eklenir**, önceki indeksler kaymaz |

Yani yarışın tek kaynağı **kırpmadır**; kırpma yoksa offset güvenlidir. Çözüm her iki dalı da kapatır.

### 4.4 Korunan davranışlar

| Davranış | Nasıl korundu |
| --- | --- |
| `perChatLimit=50` | Değişmedi; her istekte aynı parametre |
| `job.messages_total` | Parça başına **bir kez** kümülatif toplanır → global toplam aynı |
| Geri doldurma turu (`recovery_pass`) | Sayaçları yine ezmez |
| `only_conv_ids` daraltması | `request_jids` hâlâ tek daraltma kaynağı |
| Boş/kısa sohbet | Boş sayfa → sonraki parçaya geçer (sonsuz döngü yok) |
| İptal (`cancel_requested`) | Aynı yerde kontrol edilir |

---

## 5. Test tasarımı ve sonuçları

### 5.1 Gateway seviyesi — gerçek kod, sentetik depo

`whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs` — **gerçek** `createSessionManager` / `listAllMessages` / `message-store` (`stampMessageSeq`, `trimChatMessages`, `boundMessagesByChat`). Ölçek üretimle **aynı oran**: `page_size=100`, `perChatLimit=50` → `chunk=2` (üretimde 1000/50 → 20).

```
[A offset]  pages=3 delivered=250 window=250 missed=1 genuine=1
[B chunked] pages=3 delivered=250 window=250 missed=1 genuine=0
[C istek]   offset_pages=3 chunked_pages=3
Initial sync front-trim proof: PASS (7 checks)
```

`genuine` = pencerede olup **hiç okunmayan** ve geç gelen olmayan kayıt. **A: 1 · B: 0.**

Kontroller: A atlar · atlanan kayıt depoda **hâlâ durur** (silme değil, atlama) · B hiç atlamaz · B'nin tek "kaybı" meşru geç-gelen mesajdır · B `50/sohbet` sınırını korur (`250 = 5×50`) · C istek sayısı artmaz · D boş sohbet parçayı bozmaz.

### 5.2 Backend seviyesi — gerçek `_run_bulk_message_sync`

`backend/tests/test_whatsapp_initial_sync_chunking.py` (6 test) — `TrimAwareGateway`, gateway'in offset dalını **birebir** taklit eder (jids filtresi → son-N kırpma → id sırala → dilim).

**A/B (aynı testler, aynı veri):**

| Test | Fix öncesi (`de1f1ad`) | Fix sonrası |
| --- | --- | --- |
| `test_initial_sync_never_pages_with_a_cross_request_offset` | ❌ `sayfalar arası offset kullanılmamalı: [0, 1000]` | ✅ |
| `test_initial_sync_does_not_skip_a_windowed_message_during_front_trim` | ❌ `atlanan=['w-17-49'] (delivered=1250, window=1250)` | ✅ |

> `delivered=1250, window=1250` — **sayı eşit ama küme farklı**. Atlama, sayım tabanlı hiçbir kontrolde görünmez. Bu, "toplam doğru" kontrolünün neden yetersiz olduğunun kanıtıdır.

**Fix öncesi test sayısı:** 3 saf `_bulk_chunks` testi + 1 kenar testi fix öncesi **tanımsızdır** (fonksiyon yok) — bunlar yeni davranışın sözleşmesidir, A/B'ye girmez.

### 5.3 Korunan davranış testleri (değiştirilmedi)

| Test | Sonuç | Ne kanıtlar |
| --- | --- | --- |
| `test_06_bulk_paging_uses_offset_limit_and_total` | ✅ `2 passed` | `perChatLimit`'i yok sayan gateway'de bile sayfalama doğru: `[(1000,0),(1000,1000),(1000,2000)]`, `messages_total=2500` |
| `test_28_bulk_dedup_select_once_per_conversation_across_pages` | ✅ | Sayfalar arası dedup tek SELECT |
| `test_whatsapp_phase2_b_sync_reconciliation.py` | ✅ (perf ile 13 passed) | Kısmi başarısızlık + retry dedup |

### 5.4 Uyarlanan test (zayıflatılmadı)

`test_partial_failure_survives_and_retry_dedups` — `chunk=20` olduğu için **tek sohbet tek istek** üretir; 2 istek gerektiren senaryo imkânsız hâle geldi. Test **21 sohbete** uyarlandı (2 parça). Davranış aynen korundu: parça 1 commit edilir, parça 2 hata atar, devam eden tur dedup eder, `messages_synced == 1`.

> Not: bu bir "testi gevşetme" değil, **senaryoyu yeni istek topolojisine taşımadır**. Eski hâli tek sohbetle 2 istek bekliyordu; yeni topolojide bu imkânsız.

### 5.5 Senaryo kapsam matrisi (istenen 14 senaryo)

| # | Senaryo | Durum | Nerede |
| --- | --- | --- | --- |
| 1 | 2000 mesajlık RAM deposu | ⚠️ **KISMİ** — 60/sohbet (kırpma 50'de tetikleniyor, tavan test edilmedi) | §5.1 |
| 2 | 5000 geçmiş | ❌ **KAPSAM DIŞI** — gateway RAM tavanı (2000) nedeniyle erişilemez | — |
| 3 | 50/sohbet seçimi | ✅ PASS | §5.1 `got.size == 250` |
| 4 | Sayfalama sırasında yeni mesaj | ✅ PASS | §5.1, §5.2 enjeksiyon |
| 5 | Front-trim sırasında kayma | ✅ PASS | §5.1 A/B, §5.2 A/B |
| 6 | Gateway restart + epoch değişimi | ❌ **KAPSAM DIŞI (4.28)** — initial sync offset tabanlı, epoch kullanmıyor; epoch reset 4.27 F1'de kapatıldı | 4.27 §6 |
| 7 | Aynı mesajı initial sync + loop görür | ✅ PASS (dolaylı) | `(conversation_id, wa_message_id)` dedup, `test_28` |
| 8 | DB rollback | ❌ **KAPSAM DIŞI** — bu diff transaction sınırlarına dokunmuyor | — |
| 9 | Kısmi / boş sayfa | ✅ PASS | §5.1 D, §5.2 boş sohbet |
| 10 | Reconnect sonrası yeniden sync | ❌ **KAPSAM DIŞI** — canlı oturum gerekir | 4.29 |
| 11 | Büyük gruplar | ⚠️ **KISMİ** — kod yolu aynı (grup jid'i sadece bir jid), ama grup özelinde test yok | — |
| 12 | Çok sayıda küçük sohbet | ✅ PASS | 25 sohbet / 2 parça |
| 13 | `since` filtresi | ⚠️ **KISMİ** — parametre her istekte aynen geçiliyor; filtre semantiği değişmedi, ama kayma+`since` kombinasyonu test edilmedi | — |
| 14 | Parça sınırında boş sayfa | ✅ PASS | §5.2 |

**Dürüst özet:** 7 senaryo PASS, 3 KISMİ, 4 KAPSAM DIŞI. F2'nin **mekanizması** kapatıldı; senaryo 2/6/8/10 zaten bu diff'in değiştirmediği alanlarda ve **canlı oturum/production** gerektirdiği için 4.29'a bırakıldı.

### 5.6 Tam regresyon (aynı DB anlık görüntüsünden iki koşu)

Karşılaştırmanın geçerli olması için **iki ayrı worktree, aynı DB kopyası** (`/tmp/tz427.db` → `dbA`/`dbB`), `-p no:randomly`:

| Koşu | Sonuç |
| --- | --- |
| `de1f1ad` (fix **yok**) | **2061 passed, 5 failed, 4 skipped** |
| `de1f1ad` + 4.28 (fix **var**) | **2068 passed, 4 failed, 4 skipped** |

**Muhasebe:** `2061 + 5 = 2066`; `2068 + 4 = 2072`; `2072 − 2066 = 6` = **tam olarak yeni testler**. Yeni hata **yok**.

Kalan 4–5 hata **her iki koşuda da** yalnızca `test_whatsapp_postgres_concurrency.py` içinde: bu dosya **canlı PostgreSQL** ister, ortamda yok. Sayının 4↔5 oynaması bu dosyanın PG'siz ortamda deterministik olmamasındandır — düzeltmeyle ilgisi yok.

> **Yöntem notu:** İlk tam koşu `test_whatsapp_boot_lid_merge.py` içinde 14 hata verdi. Dosya **tek başına 26 passed**. Sebep, o koşuda kullanılan DB dosyasının önceki oturumlardan **kirlenmiş** olmasıydı; temiz anlık görüntüyle tekrarlandığında hata **0**. "Tek başına geçiyor" bir açıklama değil, **araştırılması gereken bir sinyaldir** — bu yüzden karşılaştırma kontrollü yapıldı.

---

## 6. Kod değişiklikleri

### 6.1 `backend/app/services/whatsapp/orchestration/sync.py` — **+73 / −10**

| Bölge | Satır | İçerik |
| --- | --- | --- |
| `_bulk_chunks()` | 110–139 | Saf fonksiyon: jid listesini `page_size // per_chat_limit` boyutunda parçalara böler. `per_chat_limit` yoksa/sıfırsa **tek parça** (eski davranış). |
| Parça kurulumu | 1726–1750 | `target_jids` (yalnız `only_conv_ids` daraltması), `chunks`, `chunk_idx`, `chunk_total`, `_next_chunk()` |
| `chunk_jids` seçimi | 1753 | Döngü başında aktif parça |
| `job.messages_total` | 1779–1786 | Parça başına **bir kez** kümülatif toplama |
| Boş sayfa | 1787–1790 | `_next_chunk()` → parça yoksa `break` |
| Parça sonu | 1983–1990 | `offset >= total` → `_next_chunk()` → sonraki parça **kendi `offset=0`**'ıyla |

**Diff küçüklüğü bilinçli:** İlk uygulama iç içe döngü kullandı ve **479 satırlık** bir diff üretti (tamamı girinti). Gözden geçirilebilirlik için, döngü gövdesini **girintilemeyen** bir "parça ilerlet" yardımcısına çevirdim → diff **83 satıra** indi (net **+73 / −10**), davranış aynı kaldı (6/6 test tekrar geçti).

### 6.2 Yeni test dosyaları

| Dosya | İçerik |
| --- | --- |
| `whatsapp-gateway/scripts/test-tz428-initial-sync-front-trim.mjs` | 7 kontrol, **gerçek** gateway kodu |
| `backend/tests/test_whatsapp_initial_sync_chunking.py` | 6 test: 3 saf parça matematiği + 3 gerçek bulk sync |

### 6.3 Uyarlanan test

`backend/tests/test_whatsapp_phase2_b_sync_reconciliation.py` — `test_partial_failure_survives_and_retry_dedups`, 1 → 21 sohbet (§5.4).

### 6.4 Dokunulmayanlar

- Gateway kaynak kodu: **0 satır** (sözleşme değişmedi)
- `memory_persistence.py`: **0 satır** (4.27 F1 aynen duruyor)
- Hiçbir mesaj **silinmiyor/temizlenmiyor**; hiçbir migration yok
- Persistence loop: **kapalı** (`runs: 0`), flag değişmedi

---

## 7. 4.27 F1 patch bütünlüğü

| Kontrol | Sonuç |
| --- | --- |
| `memory_persistence.py` diff'i 4.27'den beri değişti mi? | **Hayır** — 10 satır, aynı içerik |
| `AŞAMA 4.27 (P1)` işareti | ✅ satır 443 |
| `after_seq = 0` | ✅ satır 452 |
| Pagination contract testleri | ✅ **10 passed** |
| Patch pristine `de1f1ad`'e uygulanıyor mu? | ✅ `git apply --check` temiz |
| Uygulanan sonuç worktree ile aynı mı? | ✅ **BYTE-IDENTICAL** |
| Patch dosyası değişti mi? | **Hayır** — SHA256 `ce05e047…11f5eb` |

**Sonuç:** 4.27 F1 düzeltmesi **korundu ve kanıtlandı**. Eksik olan regresyon testi hunk'ı ayrı artifact olarak eklendi (§1.3).

---

## 8. Uçtan uca kabul matrisi

> Bu matris **tasarım kabulüdür**: her katman için "bu aşamada kanıtlanabilir miydi" sorusuna verilen cevaptır. Production'a hiçbir yazma yapılmadı.

| # | Katman | Karar | Kanıt / Gerekçe |
| --- | --- | --- | --- |
| 1 | **Baileys → Gateway RAM** | ✅ **PASS** | 4.28 bu katmana dokunmadı. Ingest yolu (`stampMessageSeq` → `trimChatMessages` → `boundMessagesByChat`) harness'ta **gerçek kodla** çalıştırıldı; 2000/sohbet tavanı korunuyor. Production: `ram_chats_at_cap = 0` (4.26). |
| 2 | **Gateway RAM deposu** | ✅ **PASS** | Harness deposu 5×60 = 300 kayıt tuttu, okuma anında 50'ye kırptı — yani **kırpmanın okuma anında olduğu** doğrulandı (F2'nin kökü). |
| 3 | **Gateway seq API** | ✅ **PASS** | 4.27'de canlı doğrulandı: `?afterSeq=0` → `pagination:"seq"`, `seq_epoch` UUID, `epoch_reset:true`, sayfa 2 ile **OVERLAP 0**. 4.28 bu API'yi **değiştirmedi**. |
| 4 | **Backend initial sync** | ⚠️ **PASS (harness) / PROD'DA AÇIK** | Atlama mekanizması kanıtlandı ve kapatıldı (A: `genuine=1` → B: `genuine=0`). **Ancak kod dağıtılmadı** ⇒ production'da hâlâ offset akışı çalışıyor. |
| 5 | **Backend persistence loop** | ⚠️ **PARTIAL** | 4.27 F1 düzeltildi ama **loop kapalı** (`runs: 0`) ⇒ hiç çalışmıyor. Bu aşamada açılmadı. |
| 6 | **PostgreSQL** | ✅ **PASS** | Kimlik anahtarı `(conversation_id, wa_message_id)` değişmedi; dedup semantiği korundu (`test_28`). Tam suite: yeni hata 0 (§5.6). Hiçbir silme/DDL yok. |
| 7 | **Frontend hydration** | ⚠️ **PARTIAL** | `messages_total` artık parça başına kümülatif → **global toplam aynı** (2500 testi). Ama frontend bu aşamada **çalıştırılmadı**; WS olay şekli değişmedi. |

**Kritik ayrım:** Katman 4'ün "PASS"ı **test kanıtına** dayanır, **production gözlemine değil**. Bu raporda "F2 production'da çözüldü" **denmiyor** — "F2'nin mekanizması harness'ta kapatıldı, dağıtım bekliyor" deniyor.

### 8.1 Production'da F2 hâlâ neden açık

| Öğe | Değer |
| --- | --- |
| `.deployed-commit` | `de1f1ad…` (4.28 **yok**) |
| `sync.py` initial sync | hâlâ `offset` + `perChatLimit=50` |
| Etkilenen sohbet | **100** |
| RAM mesaj | **9168** |
| Maruz kalma | Her initial sync / reconnect'te, sayfa sınırında canlı trafik varsa **1+ kayıt atlanabilir** |

---

## 9. Açık riskler

| # | Risk | Önem | Durum |
| --- | --- | --- | --- |
| R1 | Düzeltme **dağıtılmadı** ⇒ production'da F2 açık | **P1** | 4.29 / release kararı bekliyor |
| R2 | Parça içi offset dalı (`perChatLimit` yok sayan gateway) yalnız `test_06`/`test_28` ile korunuyor; bu dal **canlı** doğrulanmadı | P2 | Kabul edilebilir — dal yalnız sözleşme dışı gateway'de devreye girer |
| R3 | `chunk = page_size // per_chat_limit` **tam sayı bölmesi**; `per_chat_limit > page_size` olursa `chunk = 1` → istek başına 1 sohbet (yavaşlar ama **doğru**) | P2 | Bilinçli güvenli taraf; sabitler `1000/50` |
| R4 | Senaryo 1 (2000 tavan) ve 11 (büyük grup) yalnız kısmen kapsandı | P2 | 4.29 |
| R5 | Senaryo 6/8/10 (epoch/rollback/reconnect) kapsam dışı | P2 | Canlı oturum gerektirir |
| R6 | 4.27 patch'i eksikti (test hunk'ı yoktu) | P2 | **Kapatıldı** (§1.3) |
| R7 | Full suite'te PG gerektiren 4–5 test ortam yüzünden düşüyor | P3 | Bilinen, ortam kaynaklı |

**Yeni veri kaybı yolu bulunmadı** → **D (KRİTİK RİSK) oluşmadı.**

---

## 10. Stage 4.29 geçiş koşulları

Bu aşama **durdu**. Loop kapalı, production'a yazma yok, commit/push/deploy yok, Stage 5 yok, otomatik 4.29 yok.

### 4.29'a girmeden önce karşılanması gerekenler

1. **Dağıtım kararı:** `ASAMA-4.28-initial-sync-chunking.patch` + `ASAMA-4.27-epoch-reset-cursor.patch` + `ASAMA-4.27-epoch-reset-cursor-test.patch` birlikte, **tek** bir backend-only release ref'inde toplanmalı. Gateway değişmediği için `--no-gateway` **uygun olabilir**; ancak `backend_only_release.py --base de1f1ad --target <ref>` ile **sözleşme kontrolü** yapılmalı (deployed gateway her parametreyi kabul etmeli — 4.28 **yeni parametre göndermiyor**, yalnız `jids`'i küçültüyor).
2. **F1 + F2 aynı release'te mi?** Ayrı tutulmaları hâlâ mümkün (farklı dosyalar, farklı testler), ama ikisi de aynı `sync/persistence` yüzeyine dokunuyor → **tek release** önerilir.
3. **Deploy öncesi zorunlu ölçümler:** `RAM_ONLY = 0` (yeniden ölçülmeli), outbox `PENDING/IN_FLIGHT = 0`, filigran `max(id)`, `messages|conversations|contacts` sayıları.
4. **Deploy sonrası veri kaybı kanıtı:** recreate `RAM_ONLY`'yi trivially sıfırlar → **filigran karşılaştırması** kullanılmalı (`count(id ≤ wm)` birebir).
5. **F2'nin production kanıtı:** dağıtımdan sonra, bir reconnect'te `list_all_messages` çağrılarının **hepsinin `offset=0`** ve `jids` dolu olduğu loglardan doğrulanmalı. Bu, harness kanıtının production karşılığıdır.
6. **Loop aktivasyonu ayrı bir aşamadır** — 4.29'un konusu değil; 4.27'deki aktivasyon planı (epoch reset düzeltmesi şartıyla) hâlâ geçerli.
7. **Açık senaryolar** (2, 6, 8, 10, 11) için canlı/staging test planı olmadan "uçtan uca kabul tamam" **denmemeli**.

### Bu aşamada yapılmayanlar (bilinçli)

- ❌ Production DB'ye yazma · ❌ restart/recreate · ❌ deploy
- ❌ QR / oturum etkisi · ❌ backfill / cleanup
- ❌ commit / push / merge · ❌ Stage 5 · ❌ 4.29'u otomatik başlatma
- ❌ Loop'u açma · ❌ flag değiştirme

---

## Ek — Artifact'ler

| Dosya | Amaç |
| --- | --- |
| `docs/audits/ASAMA-4.28-initial-sync-chunking.patch` | 4.28'in tamamı (sync.py + 3 test dosyası), pristine `de1f1ad`'e temiz uygulanır ve **birebir** aynı dosyaları üretir |
| `docs/audits/ASAMA-4.27-epoch-reset-cursor.patch` | 4.27 F1 kaynak düzeltmesi (değiştirilmedi) |
| `docs/audits/ASAMA-4.27-epoch-reset-cursor-test.patch` | 4.27 F1 regresyon testi (eksikti, eklendi) |

**Doğrulama:** `git apply --check` → temiz; uygulama sonrası dört dosya da `/tmp/tz427-tree` ile **byte-identical**.
