# TEZLIFY WHATSAPP — DENETİM VE DÜZELTME RAPORU (2026-10-27, Tur 6)

Kapsam: uçtan uca WhatsApp zinciri (Baileys → Gateway → Backend → DB → API/WS → Frontend) + production
doğrulaması. Bu tur, aynı gün yapılan 5 turun (`acc468a` … `8a8ae49`) üzerine yapılmıştır; onları
tekrarlamaz, kalan gerçek kusuru hedefler.

---

## A. Özet ve gerçek production durumu

**Bulunan ve düzeltilen tek P1: iki uçta da WebSocket canlılığı hiç doğrulanmıyordu.**

`start.py`, uvicorn'a `ws_ping_interval=None, ws_ping_timeout=None` veriyor — yani **hiçbir** WebSocket
ucunda protokol seviyesinde ping yok. Geriye tek canlılık sinyali uygulama seviyesindeki
`{"type":"ping"}` / `{"type":"pong"}` kalıyor. Her iki uç da ping'i **gönderiyor**, pong'u **atıyordu**:

- backend: `main.py` `if event_data.get("type") == "pong": continue` (yalnızca yutuyor)
- frontend: `client.ts` `if (data.type === 'pong') return` (yalnızca yutuyor)

Sonuç, tam olarak "arayüz bağlıymış gibi davranıyor" hatası: yarım açık TCP eşi (dizüstü uyku, Wi-Fi
değişimi, NAT rebind, FIN göndermeyen proxy restart) `readyState === OPEN` kalır. `send()` boşluğa
yazar, `onclose` hiç tetiklenmez, yeniden bağlanma planlanmaz, mutabakat çalışmaz. Backend tarafında
aynı şey `receive_text()`'in sonsuza kadar bloklanması demekti: `finally` hiç koşmadı, gateway
yetim kaldığını öğrenmedi ve **outbox durdu** — olaylar ancak restart sonrası boşaldı. `/health`
boyunca `gateway_bridge.connected: true` dedi, çünkü `connected` yalnızca receive döngüsü tarafından
çevriliyor: **varlık ile canlılık aynı sayıydı.**

Production durumu (deploy sonrası, ölçüldü):

| Ölçüm | Değer |
| --- | --- |
| `.deployed-commit` | `6d76d9e633cd3e0cd66b76a626e855ffd1e86bbd` |
| container'lar | backend/gateway/caddy/db — hepsi healthy |
| `gateway_bridge` | `connected: true`, `last_pong_at` 20 sn'de bir ilerliyor |
| conversation / message | 123 / 712 |
| 0 satırlı sohbet | 32 (5 grup) — `UNSYNCED`, uydurma yok |
| `wa_message_id` NULL / duplicate / yetim satır | 0 / 0 / 0 |
| backend ERROR (deploy sonrası 6 dk) | 0 |

## B. Git

| | Commit |
| --- | --- |
| Başlangıç | `8a8ae4961a3af1751ffc075c134ae2d52846b4bc` (temiz ağaç, `origin/main` ile aynı) |
| Ara (docs) | `602ef2a` — hafıza indeksi taşındı |
| Bitiş | `6d76d9e` — asıl düzeltme |
| Push | `8a8ae49..6d76d9e  main -> main` (exit 0) |

## C. Test sonuçları

| | Başlangıç | Son |
| --- | --- | --- |
| backend (`-p no:randomly`, provisioned DB) | **1643 passed, 4 skipped, 0 failed** | **1645 passed, 4 skipped, 0 failed** |
| gateway (`npm test`) | exit 0, tüm assertion'lar PASS | exit 0 |
| frontend build | exit 0 | exit 0 (`✓ built in 14.38s`) |
| `verify:ws-lifecycle` | 12/12 | 12/12 |
| `verify:realtime` | 9/9 | 9/9 |
| `verify:loading-gate` | ok | ok |
| `verify:ws-liveness` (yeni) | **kırmızı** (kusur yeniden üretildi) | **yeşil** |

Delta = +2 test, ikisi de yeni. Regresyon yok.

## D. Bulgular

### P1 — WebSocket canlılığı iki uçta da doğrulanmıyor (DÜZELTİLDİ)

- **Kanıt (kod):** `start.py:25-26` keepalive'i kapatıyor; `main.py` pong'u yutuyor; `client.ts` pong'u
  yutuyor. Üçü birlikte: hiçbir mekanizma "sessizlik" ölçmüyor.
- **Kanıt (yeniden üretim):** frontend harness düzeltme öncesi `closeCalls=0, pings=3`, durum `[true]`,
  soket sayısı 1 — üç ping boşluğa gitti, hiçbir şey olmadı.
- **Etki:** gerçek zamanlı mesaj akışı sessizce durur; kullanıcı "bağlı" görür. Backend tarafında
  gateway olayları outbox'ta birikir, restart'a kadar teslim edilmez.
- **Kök neden:** pong bir *kanıt* olarak değil, *gürültü* olarak ele alınmış. `connected` bayrağı yalnızca
  receive döngüsünde değiştiği için varlık ile canlılık ayrımı hiç yapılmamış.

### P2 — Bir deploy, satır sayısı değişimini atfetmeye yarayan kanıtı yok ediyor (AÇIK)

Doğrulama sırasında conversation sayısı 12:03'te **124**, 12:25'te **123** okundu. Veri kaybı şekli
**dışlandı**: 0 yetim mesaj, `min(messages.conversation_id)` canlı id aralığının içinde, mesaj sayısı
676 → **712** (azalmadı), 6 saatte outbox'ta `conversation_deleted` yok. Ama **atfedilemedi**:
`docker logs` eski container ile birlikte gitti, outbox payload'ı şifreli (`ciphertext`), `wa_merge_locks`
boş, identity-sweep sayaçları bellek içi olduğu için restart'ta sıfırlandı (`merged_total: 0` restart
sonrası hiçbir şey kanıtlamaz).

### P2 — `/health` varlık ile canlılığı ayırmıyordu (DÜZELTİLDİ)

`last_pong_at` eklendi. Artık `connected: true` iken pong yaşı ölçülebilir; bayat köprü, kapatılmadan
önce görülür.

### P3 — `verify:whatsapp-pairing` harness'ı bağımsız olarak kırık (AÇIK, bu değişiklikle ilgisiz)

Bilinen durum; bu turda dokunulmadı, kanıt olarak da kullanılmadı.

## E. Değiştirilen dosyalar

| Dosya | Amaç |
| --- | --- |
| `backend/app/main.py` | keepalive sessizlik ölçümü + 1011 kapatma, `last_pong_at`, `pongs`/`pong_timeouts` sayaçları |
| `frontend/src/api/client.ts` | pong kaydı, heartbeat watchdog, `forceReconnect`, `visibilitychange` kontrolü |
| `backend/tests/test_whatsapp_gateway_liveness.py` | yeni: sessiz eş kapatılır, cevap veren eş kapatılmaz |
| `frontend/scripts/verify-whatsapp-ws-liveness.mjs` | yeni: sanal saatle gerçek `createWebSocket` |
| `frontend/package.json` | `verify:ws-liveness` script'i |
| `.workbuddy-ai/memory/*` | indeks 10.838 → 9.450 karakter (taşma onarımı, silme yok) |

Hassas dosya (auth state, credentials, `.env`) commit'e **girmedi** — `git status` ile doğrulandı.

## F. Zincir bazında düzeltmeler

- **Baileys → Gateway:** değişiklik yok. Gateway zaten `{"type":"ping"}`'e `{"type":"pong"}` dönüyor
  (`events.js:147-148`) — düzeltmenin ön koşulu buydu ve **canlıda doğrulandı**.
- **Gateway → Backend:** keepalive artık `loop.time() - last_pong` ölçüyor; 2 aralık (40 sn) aşılırsa
  `close(1011)`. Gateway `on('close')` → `scheduleReconnect()`, `on('open')` → `requeueInflight()`.
  Yani bayat köprüyü kapatmak **outbox'ı da kurtarıyor**; önceki davranış onu süresiz durduruyordu.
- **Backend → DB:** değişiklik yok; ingest sırası (tek seri worker) korundu.
- **Backend → Frontend WS:** yeni backend pong'u kaydediyor; frontend 2 aralık sessizlikte soketi
  zorla kapatıyor. `forceReconnect` bilinçli olarak `onclose`'u atlar (çift reconnect olmasın diye) ve
  `ws`'i **önce** null'lar (yoksa `connect()`'in OPEN/CONNECTING koruması yeni soketi reddederdi).
- **Frontend state:** yeniden bağlanma `tezlify:ws_connected` yayınlıyor → hub ve loading gate
  mutabakatı **artık gerçekten tetikleniyor** (öncesinde hiç reconnect olmadığı için hiç tetiklenmiyordu).

## G. QR ve sync ölçümleri

- **QR: ölçülmedi.** 48 saatlik gateway logunda tek bir QR üretimi yok (kalıcı oturum). Ölçmek için
  canlı hattı yeniden eşleştirmek gerekirdi — bu yıkıcı bir işlem olduğu için **yapılmadı**.
  `socket_start_to_provider_qr_ms` / `qr_generation_ms` metrikleri kodda mevcut ve çalışır durumda.
- **History sync: bu pencerede hiç koşmadı.** Gateway 11:39'da yeniden başladı ve WhatsApp mevcut oturum
  için geçmiş göndermiyor (§A6). Bu bir kusur değil, protokol sınırı; kalıcı damga
  (`initial_sync_completed_at = 11:57:47`) arayüzü açık tutan şey.
- **Keepalive turu: ölçüldü.** `last_pong_at` 12:21:16 → 12:21:36, tam 20 sn — döngü çalışıyor ve
  gateway her ping'i yanıtlıyor. Bu alan önceki build'de **yok**, yani yeni backend'in kanıtı.

## H. Kişi, sohbet, grup, LID/JID ve history doğrulaması

| Kontrol | Sonuç |
| --- | --- |
| conversation / message | 123 / 712 |
| mesajı olan / olmayan sohbet | 91 / 32 (32'nin 5'i grup) |
| `last_message_at IS NULL` | 0 |
| `wa_message_id` NULL | 0 |
| `external_timestamp` NULL | 0 |
| `(conversation_id, wa_message_id)` duplicate | 0 |
| `preview_%` uydurma satır | 0 |
| yetim mesaj | 0 |
| aynı kişiye iki sohbet (LID/PN bölünmesi) | 0 |
| contacts | 1536 |

## I. Çalıştırılan testler

Yukarıdaki C tablosu. **Çalıştırılamayanlar:** gerçek WhatsApp cihazıyla uçtan uca eşleştirme (canlı
hattı riske atar), `verify:whatsapp-pairing` (bilinen harness arızası), Chrome/CDP smoke
(`verify-production-whatsapp.mjs` Chrome 154 ile asılıyor — bilinen durum).

## J. Deployment kanıtları

| Kanıt | Değer |
| --- | --- |
| deploy çıkışı | `DEPLOY_EXIT=0`, `SÜRÜM TAMAM: 6d76d9e` |
| `.deployed-commit` | `6d76d9e…` |
| kapsam | backend `StartedAt` 12:20:51 · gateway **11:39:38 (değişmedi)** · db/caddy sabit |
| `/health` | 200, `status: healthy` |
| yeni alan | `gateway_bridge.last_pong_at` canlıda mevcut |
| frontend hash | yerel `24581fba…` = yayın `24581fba…` → **MATCH** |
| backend log | 0 ERROR / Traceback (deploy sonrası) |
| veri | 0 yetim, 0 NULL, 0 duplicate |

`--no-gateway` kullanıldı: gateway'e dokunulmadı, bellek içi deposu korundu (§A6).

## K. Kabul kriterleri

| # | Kriter | Durum |
| --- | --- | --- |
| 1 | QR akışı durum makinesine uygun | **BLOCKED** — canlı eşleştirme yapılmadı (yıkıcı olurdu) |
| 2 | connection open ↔ sync completion ayrı | PASS — `resolve_gate_phase` + `test_post_qr_sync_state_machine` |
| 3 | Baileys auth state güvenli | PASS — AES-256 at-rest, repoda sır yok, commit'te auth dosyası yok |
| 4 | Duplicate socket/listener yok | PASS — `verify:ws-lifecycle` 12/12, lifecycle generation guard |
| 5 | Gateway↔backend reconnect toparlanıyor | PASS — canlı `reconnect_count: 1`, köprü bağlı, outbox akıyor |
| 6 | Heartbeat iki uçta sözleşmeye uygun | PASS — **bu turda düzeltildi ve canlı ölçüldü** |
| 7 | Kişi/sohbet olayları DB'ye yansıyor | PASS — 1536 contact, 0 NULL, outbox `contact_synced`/`conversation_updated` |
| 8 | Grup hydration idempotent | PASS — `phase2a-group-hydration` + 12 grup sohbeti |
| 9 | LID/JID yanlış eşleştirmiyor | PASS — aynı kişiye iki sohbet: 0 |
| 10 | REST ve WS tutarlı | PASS — `verify:realtime` 9/9 (T8: liste ve thread aynı fikirde) |
| 11 | Pagination atlama/duplicate yok | PASS — keyset (`timestamp, id`) + tie-break |
| 12 | DB commit hatası sessiz başarıya dönüşmüyor | PASS — persist hatası → NACK + yayın yok |
| 13 | History sync ile canlı olay çakışmıyor | PASS — tek seri ingest worker, sıra korunur |
| 14 | Loading gate gerçek durumu yansıtıyor | PASS — `verify:loading-gate`; kalıcı damga tek açıcı |
| 15 | Açık sohbete gelen mesaj doğru güncelleniyor | PASS — `verify:realtime` 9/9 |
| 16 | Reconnect sonrası reconciliation | PASS — `tezlify:ws_connected` → hub + gate tazeleme (artık gerçekten tetikleniyor) |
| 17 | Tenant izolasyonu | PASS — kiracı filtreli sorgular; blacklist `user_id` zorunlu |
| 18 | Gateway/backend/frontend testleri başarılı | PASS — 1645/4/0, gateway exit 0, build exit 0 |
| 19 | Production health + smoke başarılı | PASS — /health 200, hash MATCH, 4 container healthy |
| 20 | Deployment gerçek kanıtla doğrulandı | PASS — `.deployed-commit`, `StartedAt` kapsamı, hash, `last_pong_at` |

**Gerçek cihazla doğrulanmayan hiçbir madde PASS işaretlenmedi** (bkz. #1).

## L. Kalan riskler ve protokol sınırları

1. **Yeniden bağlanma fırtınası (düşük).** Gateway event loop'u 40 sn'den uzun bloklanırsa backend
   köprüyü kapatır. Kayıp yok (outbox + `requeueInflight`), ama gereksiz reconnect olur. 2 aralık
   tolerans bunu normal yük altında imkânsız kılıyor.
2. **En kötü durum tespit süresi ~60 sn** (2 × 20 sn), ardından gateway backoff'u (≤30 sn). Toplam
   ~90 sn'lik sessizlik penceresi. WhatsApp Web'de bu süre daha kısa; kısaltmak agresif kapatma riski
   taşıyor, bu yüzden bilinçli olarak muhafazakâr seçildi.
3. **Baileys sınırı:** mevcut oturum için geçmiş göndermiyor → 32 sohbet kalıcı olarak `UNSYNCED`
   (`fetchMessageHistory` çapa ister, çapası olmayan sohbet için `NO_ANCHOR`). Uydurma ile
   kapatılmadı; doğru etiket bu.
4. **Arşiv durumu** yalnızca app-state ile gelebilir (§K); ürün kararı bekliyor.
5. **P2 atıf boşluğu** (D bölümü) — yeniden olursa kalıcı sayaç gerekir.

## M. Rollback

```bash
bash scripts/deploy/host-release.sh --rollback-to 20261027T121932Z
```

Etiketler: `tezlify-backend:pre-20261027T121932Z`; frontend önceki dizinden geri yazılır. Kayıt:
`/opt/tezlify/backups/releases/20261027T121932Z/release.json`.

**Dikkat:** rollback backend'i yeniden oluşturur. Bu değişiklik için veri riski yok (şema/migration yok);
ama `--no-gateway` ile korunan gateway deposu, `--rollback-to` gateway'i de yeniden oluşturduğu için
kaybolur (§A6). Bu yüzden rollback son tercih olmalı.

## N. Çözülemeyenler

1. **Conversation 124 → 123 (atfedilemedi).** Veri kaybı dışlandı, nedeni kanıtlanamadı; kanıt
   container recreate ile yok oldu. Kalıcı sweep/merge sayacı eklenmeden bu tür bir değişim bir daha
   açıklanamaz.
2. **QR hızı ölçülmedi** — canlı hattı yeniden eşleştirmeden ölçülemez; bu turda yapılmadı.
3. **Yeni 1011 kapatma yolu production'da henüz tetiklenmedi** (yarım açık soket oluşmadı). Kanıt
   birim testinden geliyor, canlı gözlemden değil — bu ayrım korunmalı.
