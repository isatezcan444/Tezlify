# Telefon gerektiren iki senkron ölçümü — protokol (2026-10-01)

Bu belge, **telefon elde yapılmadan kanıtlanamayacak** iki davranışın nasıl
ölçüleceğini, ne beklemesi gerektiğini ve bir şey ters giderse nereye bakılacağını
yazar. Kapılar (`backend/tests/`, `whatsapp-gateway/scripts/`) **sözleşmeyi**
kanıtlar; WhatsApp sunucusunun yamayı kabul ettiğini YALNIZCA bu ölçüm gösterir.

| # | Ölçüm | Neyi kanıtlar | Neyi kanıtlamaz |
|---|---|---|---|
| A | Telefonda okunan sohbetin rozeti Tezlify'da düşer | Okundu bilgisi telefondan **başımıza** gelir ve `unread_count` aşağı iner | Başka cihazın okumasının engellendiğini |
| B | Tezlify'dan silinen sohbet telefondan da gider | Giden silme yaması telefon tarafında etkili olur | Karşı tarafın cihazındaki geçmişin silindiğini (WhatsApp semantiği: silinmez) |

Ölçümler **ayrı** yapılır ve arada başka bir test yapılmaz: aynı pencerede iki
değişiklik olursa "hangisi düşürdü" sorusu cevaplanamaz.

---

## 0. Ortak hazırlık

1. **Ölçüme uygun sohbet seç.** Araç bunu listeler (salt okuma):
   ```bash
   docker cp scripts/diagnostics/whatsapp_handset_measure.py tezlify-backend:/tmp/handset.py
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend \
     python /tmp/handset.py --list-candidates --limit 20
   ```
   `"measurable": true` olan bir satır seç. Bu alan üç şeyi birlikte arar:
   kanonik (hayalet olmayan) telefon kimliği, bir gateway oturumu ve o oturumun
   **CONNECTED** olması. Hayalet LID sohbeti (`jid:...@lid`) rozet ölçümü için
   uygun DEĞİLDİR — rozet kanonik sohbette düşmelidir.

2. **İş açısından önemsiz bir sohbet seç** (özellikle Ölçüm B için). Ölçüm B
   WhatsApp'ta gerçekten sohbet siler; herhangi bir müşteri sohbetinde yapmak
   geri alınamaz bir kayıp üretir.

3. **Aynı pencerede** Tezlify'ı açık tut (badge'in canlı güncellenmesini göreceksin)
   ve telefonu bu hatta bağlı **diğer** cihaz olarak kullan (aynı WhatsApp hesabı).

4. Ölçüm anındaki yayını not et:
   `ssh … 'cat /opt/tezlify/.deployed-commit'` → ölçüm kaydına yaz.

---

## 1. Ölçüm A — rozetin telefon okumasıyla düşmesi

**Mekanizma (kodda):** telefon sohbeti okuduğunda WhatsApp `chats.update` yayar;
gateway `unread_count`i **aynen** iletir
([socket-events.js:621](../whatsapp-gateway/src/socket/socket-events.js#L621) →
`conversation_updated`); backend kararı
[`should_apply_unread_count`](../backend/app/services/whatsapp/preview_normalization.py#L138)
verir ve sayaç aşağı inebilir. Eski davranış `max(yerel, gelen)` idi ve başka
cihazda yapılan okuma **kalıcı olarak görünmez** kalıyordu.

**Adımlar**

1. Seçtiğin sohbetin **okunmamışı olduğundan** emin ol (hiç yoksa kendine başka
   bir cihazdan mesaj at; en az 2 okunmamış olsun).
2. Önce/sonra kanıtını başlat:
   ```bash
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend \
     python /tmp/handset.py --snapshot --conversation <ID> --out /tmp/before.json
   ```
   (Yerelde de koşabilirsin; üretimde konteyner içinde koşmak Prod DB'sini okur.)
3. Tezlify'da o sohbetin rozetini **not et** (kaç?).
4. **Telefonda** sohbeti aç ve tüm mesajları oku; sonra telefonu kilitle.
5. **30 saniye bekle** (olay akışı + app-state turu). Tezlify'ı elle yenileme.
6. Sonra kanıtı al ve karşılaştır:
   ```bash
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend \
     python /tmp/handset.py --snapshot --conversation <ID> --out /tmp/after.json
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend \
     python /tmp/handset.py --diff /tmp/before.json /tmp/after.json
   ```
7. Log kanıtı (olayın gateway'e geldiğini göstermeden "düştü" demeyiz):
   ```bash
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend python /tmp/handset.py --logs
   ```

**Beklenen sonuç (hepsi birlikte)**

- `--diff` → `HUKUM: GECTI`; `db_unread_dropped` satırı `N → 0` der.
- `db_unread_reached_zero` geçer: sayaç **0**'a iner (azalma yetmez, sıfırlanmalı).
- `message_count_unchanged` geçer: okuma mesaj **üretmez/silmez**.
- `gateway_cache_unread` artmaz (gateway kendi sayacını da 0'a indirir).
- Tezlify rozeti **elle yenileme olmadan** düşer (WS `conversations_updated`).
- Logda `conversation_updated` / unread satırı ölçüm penceresinde görünür.

**Teşhis tablosu (kaldıysa)**

| Belirti | En olası neden | Bak | Yap |
|---|---|---|---|
| DB düştü, rozet düşmedi | İstemci WS olayını almadı/işlemedi | Tarayıcı konsolunda WS mesajları; `conversations_updated` gövdesinde `unread_count` | Sayfayı yenile; hâlâ ise frontend indirgemesi şüphelidir — WS gövdesini kaydet |
| DB hiç değişmedi, gateway önbellek 0 | Olay geldi ama DB'ye yazılmadı | backend logunda sohbet olayı; `should_apply_unread_count` kapısı | `last_message_at` > gelen aktivite zamanı ise kapı **doğru** reddetmiştir: gelen snapshot eski. Fresh okuma için tekrar ölç |
| DB hiç değişmedi, gateway önbellek de değişmedi | Telefon okuması `chats.update` üretmedi (bildirim/okuma senkronu kapalı olabilir) | gateway logunda `chats.update` yok | Telefonda bildirimleri/okuma makbuzlarını aç, tekrar ölç |
| Sayaç **arttı** | Bu bir okuma değil, gelen yeni mesaj | `message_count` ve `last_message_at` | Ölçümü bozan mesaj akışını durdur (uçak modu) ve tekrarla |
| `gateway_cache` okunamadı | Gateway erişimi/oturum eşleşmesi | `session_status`, `gateway_id` alanları | Ölçüm A için bu satır zorunlu değildir; diğerleri geçtiyse hüküm geçerlidir |

Not: **`regular_low` (okundu/arşiv) app-state koleksiyonu donmuş olabilir.** Bu
ölçüm ondan **bağımsız** olmalıdır: yön telefon→biz olduğu için veri
`chats.update` akışından gelir. Akış gelmiyorsa önce app-state'i yeniden kur
(`Scripts/test-appstate-rearm.mjs` kapsamı), sonra tekrar ölç.

---

## 2. Ölçüm B — Tezlify'dan silinen sohbetin telefondan gitmesi

**Mekanizma (kodda):** `DELETE /whatsapp/conversations/{id}` →
[`delete_conversation`](../backend/app/services/whatsapp_service.py#L1362) önce
uzaktan silmeyi dener (`delete_conversation_remote` → gateway
`DELETE /sessions/:session/conversations/:jid`), sonra **her durumda** yerel
satırları siler ve sonucu `remote_deleted` / `remote_error` olarak döndürür.
Gateway `chatModify({delete:true, lastMessages})` yazar
([session-manager.js:1272](../whatsapp-gateway/src/session-manager.js#L1272));
yama `regular_high` koleksiyonuna gider ve **yerel önbellek yalnızca sağlayıcı
kabul ederse** düşürülür (yoksa sonraki senkron silinen sohbeti geri getirirdi).

**Adımlar**

1. Ölçüm B için **önemsiz** bir sohbeti seç ve önce kanıtı al
   (`--snapshot --conversation <ID> --out /tmp/before_b.json`). Sohbetin
   **telefonda görünür** olduğunu da doğrula.
2. Tezlify'da sohbeti sil (onay penceresini geç).
3. Ekranda çıkan bildirimi **oku ve kaydet**:
   - uzaktan silme başarılıysa yalnızca "N mesaj silindi" mesajı gelir,
   - başarısızsa ek olarak şu uyarı gelir: *"Sohbet Tezlify'dan kaldırıldı ancak
     WhatsApp'a bildirilemedi. Telefonunuzda görünmeye devam edebilir ve bir
     sonraki senkronizasyonda geri gelebilir."*
4. Sonra kanıtı al ve karşılaştır:
   ```bash
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend \
     python /tmp/handset.py --snapshot --conversation <ID> --out /tmp/after_b.json
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend \
     python /tmp/handset.py --diff /tmp/before_b.json /tmp/after_b.json
   ```
   Satır yoksa `--diff` "sohbet yerel olarak silinmiş" der.
5. **Telefonda** WhatsApp'ı aç: sohbet listeden gitmiş olmalı (birkaç saniye–dakika).
6. **Geri gelme kontrolü** (asıl risk): Tezlify'da bir senkron tetikle
   (hat sayfasındaki "senkronize et" ya da `request_sync`), 2–3 dakika bekle ve
   sohbetin **geri gelmediğini** doğrula. Gateway önbelleği yalnızca sağlayıcı
   kabul ettiğinde düşürüldüğü için, geri gelme = yama reddedilmiş demektir.
7. Sağlayıcı kanıtı:
   ```bash
   docker exec -e PYTHONPATH=/app -w /app tezlify-backend python /tmp/handset.py --logs
   docker logs tezlify-backend --since 15m 2>&1 | grep -E "Sohbet silindi" | tail -3
   ```
   Beklenen: `Sohbet silindi (conv=<ID>, …, remote=True)` ve gateway logunda
   `Delete conversation`/hatasız `chatModify`.

**Beklenen sonuç (hepsi birlikte)**

- API yanıtı `remote_deleted: true`, `remote_error: null`.
- Ek uyarı bildirimi **çıkmaz**.
- Telefonda sohbet kaybolur ve senkron sonrası **geri gelmez**.
- Backend logu `remote=True` der; gateway tarafında sağlayıcı hatası yok.

**Teşhis tablosu (kaldıysa)**

| Belirti | En olası neden | Bak | Yap |
|---|---|---|---|
| `remote_deleted: false`, `remote_error: NO_REMOTE_IDENTITY` | Sohbetin WhatsApp kimliği yok (kişisiz satır) | `contact_phone` alanı; sohbetin LID/PN kimliği | Beklenen: bu sohbette uzaktan silme mümkün değil, yerel silme yapıldı |
| `remote_error: WHATSAPP_AUTH_RELINK_REQUIRED` | Hat yeniden bağlanmayı bekliyor | `/health`, oturum durumu | Hattı yeniden bağla, ölçümü tekrarla |
| `remote_error: Session not found` | Yanlış/eksik oturum eşleşmesi | `session_id`/`gateway_id` snapshot alanları | Hattı doğrula; bu bir kod hatasıysa eşleşmeyi `_conversation_session` tarafında ara |
| `remote_error` sağlayıcı hatası (ör. `Incomplete key`, `Missing timestamp`) | `lastMessages` sözleşmesi ihlali | gateway logunda hatanın tam metni | Gateway yerel önbelleğinde mesaj yoksa `lastMessages` boş gönderilir (bu geçerli); hata varsa ölçüm penceresindeki sohbeti/branch'i kaydet |
| Telefonda sohbet duruyor, Tezlify'da yok | Yama gönderildi ama telefon app-state'i almadı | telefon–web çok cihazlı senkron; `regular_high` erişimi | Telefonda WhatsApp'ı kapat/aç; durum sürerse yama sözleşmesini değil, hesabın çok cihaz durumunu sorgula |
| Silinen sohbet **geri geldi** | Sağlayıcı reddetti ya da yerel önbellek düşürülmedi | gateway logunda `Delete conversation provider error` | Bu gerçek bir kusurdur: hatayı ölçüm kaydına aynen kopyala |

---

## 3. Karşı yön kontrolü (isteğe bağlı, ucuz)

Aynı hatta **telefondan** bir sohbet sil → Tezlify listesinden de kaybolmalı
(`chats.delete` + `messages.delete` abonelikleri). Bu kontrol, Ölçüm B
başarısız olursa hatanın "bizim yazma yolumuzda mı yoksa telefon–web
senkronunda mı" olduğunu ayırmaya yarar. Beklenen: birkaç saniye içinde sohbet
Tezlify listesinden düşer ve geri gelmez.

---

## 4. Kayıt şablonu (ölçümü bitirince doldur)

```
Ölçüm: A / B
Zaman: <ISO>            Yayın SHA: <27e2803…>
Sohbet: ID=<…> kanal=WHATSAPP  telefon=<maskeli>
Tezlify rozeti: önce=<n> sonra=<n>       (A)
Telefon davranışı: <okundu | silindi>     (B)
--diff hükmü: <GECTI|KALDI|KANIT-EKSIK> + satır dökümü
Backend logu: <Sohbet silindi … remote=…> (B)
Gateway logu: <chatModify|conversation_updated|provider error satırı>
Beklenmeyen/gözlem: <varsa aynen yapıştır>
```

**Hüküm satırı olmadan "ölçüldü" denmez.** `--diff` çıktısı kaydın parçasıdır;
`KANIT-EKSIK`, "başarısız" değil "iddia doğrulanamadı" demektir ve öyle raporlanır.

---

## 5. Güvenlik ve geri dönüş

- Ölçüm B **geri alınamaz**: Tezlify'da silinen sohbetin yedeği yoktur. Önemsiz
  sohbet seç; müşteri sohbetinde ölçüm yapma.
- Ölçüm sırasında kod değiştirme. Kod kaynaklı bir kusur bulunduysa önce kaydı
  tamamla, sonra düzelt.
- Yayın sorunluysa: `bash scripts/deploy/host-release.sh --rollback-to <etiket>`
  (yayın çıktısı etiketi yazar; ör. `20261001T114205Z`).
