# WhatsApp — sohbet başına 2.000 mesaj tavanı (Faz 3.8.1)

**Tarih:** 2026-10-29
**Durum:** TASARIM — kod değişikliği YOK, sınır değişikliği YOK
**Kapsam:** `whatsapp-gateway/` bilinçli olarak değiştirilmedi (bkz. §5)

---

## 1. Bulgu: tavan tek bir yerde değil, BEŞ yazma yolunda

Faz 3.8'de yalnızca iki `splice()` bildirilmişti. Denetimde beş tane bulundu ve
**hepsi yayındaki `b5715fe` içinde de var** (parantez içi = yayındaki satır):

| # | Dosya | Fonksiyon | Yol | Yayın satırı |
|---|-------|-----------|-----|--------------|
| 1 | `socket/socket-events.js` | `chats.update` işleyicisi | canlı gelen (medya dışı sentez) | 762 |
| 2 | `socket/socket-events.js` | `messaging-history.set` | geçmiş senkronu | 914 |
| 3 | `session-manager.js` | `_ingestUpsertMessage` | canlı `messages.upsert` | 2406 |
| 4 | `session-manager.js` | `_recordOutbound` | giden mesaj kaydı | 2534 |
| 5 | `session-manager.js` | `_applyLidMapping` | LID→PN sohbet birleştirme | 2791 |

Hepsi aynı kalıp: `if (list.length > 2000) list.splice(0, list.length - 2000)`.
Yani bu bir "geçmiş senkronu" ayrıntısı değil, **sohbet başına küresel saklama
(Retention) politikasıdır** — gelen, giden, geçmiş ve kimlik birleştirme
yollarının tamamında uygulanır.

Yakın ama ilgisiz: `_failedMediaCache.size > 2000` (medya indirme hata önbelleği;
mesaj kaydı değil). Tavanla karıştırılmamalı.

## 2. Sınırın gerçekten neyi yok ettiği

Tavan yalnızca **en eski** kayıtları atar. Canlı gelen her yeni mesaj backend
tarafından `/ws/gateway` üzerinden zaten DB'ye yazılır. Dolayısıyla atılan kayıt,
tanım gereği **yalnızca RAM'de duran eski birikimdir**.

Bunun kritik sonucu şudur:

> Tavan, **RAM-only birikim var olduğu sürece** yıkıcıdır. Birikim bir kez DB'ye
> yazıldıktan sonra eviction zararsızdır: mesaj zaten DB'de olduğu için RAM'den
> düşmesi veri kaybı değildir.

Bu yüzden doğru sıra "önce tavanı yükselt" değil, **"önce birikimi kalıcılaştır"**dır.
Tavanı yükseltmek kaybı yalnızca geciktirir; birikimi yazmak kaybı bitirir.

Ölçülen kanıt (2026-10-29, salt okunur): `conv 38291` 2.000'de sabitken 36 saatte
28 gelen mesaj aldı; RAM net yalnızca +8 büyüdü. Yani ~28 eski kayıt atıldı ve
o sohbette 2.000'in 1.655'i DB'de olmadığı için atılanlar geri getirilemez.

## 3. Restart etkisi

`createSessionStore` yalnızca `contacts` (contactCache) ve `rawMediaCache`
geri yükler; `messagesByChat`, `chats` ve LID haritaları **geri yüklenmez** (A6).
Geçmiş senkronu sohbetleri yeniden doldurur ama sohbet başına en fazla 2.000
kayıt tutar. Sonuç:

* Restart, RAM-only birikimi **kalıcı olarak** yok eder (bu zaten bilinen A6).
* Restart sonrası geçmiş senkronu 2.000'i aşan geçmişi **hiçbir zaman** geri
  getiremez — tavan senkron sırasında da uygulanıyor (#2).
* Bu yüzden gateway restart'ı, birikim DB'ye yazılıp **kimlik üzerinden**
  doğrulanmadan yapılmamalıdır.

## 4. Metrik tasarımı — içerik ve kişisel veri YOK

Amaç: "kaç mesaj kalıcılaştırılmadan atıldı" sorusunu sayıyla cevaplamak.
Tasarım yalnızca **sayar**; gövde, telefon, JID veya mesaj kimliği loglamaz.

Her `splice()` çağrısının hemen öncesinde (tek bir yardımcı fonksiyon üzerinden):

```
recordEviction(store, { reason: 'live' | 'history' | 'upsert' | 'outbound' | 'lid_merge',
                        evicted: <atılan kayıt sayısı> })
```

Tutulacak alanlar (süreç belleği, restart'ta sıfırlanır — bu bilinmeli):

| Alan | Anlam |
|------|-------|
| `evicted_total` | Süreç ömrü boyunca atılan toplam kayıt |
| `evicted_by_reason` | Yukarıdaki 5 nedene göre dağılım |
| `chats_at_cap` | Şu an tam 2.000'de duran sohbet sayısı (kimlik yok) |
| `last_eviction_at` | Son atmanın zaman damgası |

Yayın: mevcut `diagnostic()` hattı + gateway `/health` altında
`messages_evicted: { total, by_reason, chats_at_cap }`.

**Neden kimlik yok:** atılan kaydın kimliğini loglamak, "hangi mesaj kayboldu"
sorusunu cevaplardı — ama mesaj kimliği DB'ye yazılamayacak bir kaydı işaret
ettiği için operasyonel değeri yok ve dosyayı kişisel veriye yaklaştırır.
Sayı, kararı vermeye yeter: `evicted_total` artıyorsa birikim hâlâ yok ediliyor
demektir.

**Uyarı — metrik tek başına yeterli değil:** `evicted_total` sıfır olsa bile
birikim yok edilmiyor anlamına gelmez (restart öncesi atmalar sayılmaz).
Asıl doğrulama `audit_memory_gap.py --snapshot/--compare` ile kimlik bazlıdır.

## 5. Neden bu aşamada gateway kodu değiştirilmedi

1. Gateway değişikliği **deploy gerektirir**; bu aşamada gateway restart/recreate
   yetkisi yok ve her recreate RAM-only birikimi yok eder (A6).
2. `release/backend-only-3.7` ref'i, `whatsapp-gateway/` ağacını yayındaki
   commit'te dondurarak `--no-gateway` muhafızından geçiyor. Gateway'e
   dokunmak bu ref'i geçersiz kılar ve backend-only yolu kapatır.
3. Ölçüm, kod değişikliği olmadan da yapılabiliyor (bkz. §2 kanıtı).

Bu nedenle metrik **tasarlanmış**, uygulanmamıştır.

## 6. Geri alınabilir çözüm planı (sırayla, her adım bağımsız geri alınabilir)

**Adım 0 — birikimi kalıcılaştır (ön koşul, tavan değişikliği değil).**
Backend-only deploy + `dry_run` + gerçek tur; `audit_memory_gap.py --snapshot`
ile kimlik doğrulaması. Bu adım tamamlanmadan aşağıdaki adımlar **anlamsızdır**:
birikim hâlâ RAM'deyken tavanı büyütmek yalnızca kaybı geciktirir.

**Adım 1 — ölç (davranış değişikliği yok).**
§4 metriğini ekle. Geri alma: commit revert. Risk: yok (yalnızca sayaç).

**Adım 2 — tavanı yapılandırılabilir yap.**
`MESSAGES_PER_CHAT_CAP` (varsayılan **2000** = mevcut davranış). Değişiklik
yalnızca sabiti okumak. Geri alma: env değişkenini sil → 2000'e döner.
Bellek etkisi doğrusal: 125 sohbet × tavan.

**Adım 3 — yükseltmeyi yalnızca kanıtla yap.**
Yükseltme kararı `chats_at_cap > 0` **ve** `evicted_total` artıyor **ve**
`audit_memory_gap.py` `RAM_ONLY` sıfıra yakın ölçüyorsa verilir. Aksi halde
yükseltme, çözülmüş bir sorunu gizler.

**Geri dönüş planı (her adım için):** `git revert <sha>` + gateway'i yeniden
oluştur. **DİKKAT:** gateway recreate RAM-only birikimi yok eder; geri dönüş
kararı da Adım 0 doğrulandıktan sonra verilmelidir.

## 7. Açık risk

Tavan, `_applyLidMapping` (#5) içinde de uygulanıyor. LID→PN birleştirmesi iki
listeyi birleştirdiğinde sonuç 2.000'i aşarsa en eskiler atılır — yani bir
kimlik onarımı, kendi birikimini kısaltabilir. Bu, kimlik onarımı ile saklama
politikasının aynı fonksiyonda kesiştiği tek yerdir ve Adım 2'de ayrıca
değerlendirilmelidir.
