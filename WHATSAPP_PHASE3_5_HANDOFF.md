# TEZLIFY WHATSAPP — AŞAMA 3.5 DEVİR TESLİMİ (HANDOFF)

**Tarih:** 2026-10-28
**Repo:** `/Users/isatezcan/Documents/Github/Tezlify`
**Üretim host:** `ubuntu@130.162.247.20` (anahtar `~/.ssh/id_tezlify_oracle`)
**Bu dosyanın amacı:** başka bir AI/engineer'in kaldığı yerden devam edebilmesi için durum, kanıt, komut ve açık sorular.

---

## 0. TEK BAKIŞTA DURUM

| Öğe | Değer |
|-----|-------|
| Local HEAD = origin/main | `4d49701` (ağaç temiz) |
| Üretimde çalışan commit (`.deployed-commit`) | `b5715fe` |
| `b5715fe..4d49701` farkı | **yalnızca docs/memory** (kod farkı yok) |
| Backend container | `579085f13268`, StartedAt `2026-10-27T22:25:45Z`, healthy |
| Gateway container | `5b867095d376`, StartedAt `2026-10-27T17:25:57Z`, image built `2026-10-27T17:24:11Z`, healthy |
| DB / Caddy | `f6d79c4a1f8b` / `ee66a5cab371` — değişmedi |
| Canlı oturum | DB row `201`, gateway_id `1bd78836-c084-4cbf-b333-9386d44b7bd7`, `CONNECTED`, `+905413749073` |
| Bridge | `gateway_bridge.connected=true`, `last_event_at` ilerliyor |
| Sayaçlar (baz) | 124 conversation, 1657 message, max id 160902, 1536 contact |
| UNSYNCED sohbet | **27** (last_message_at var, 0 mesaj) |
| Mesajı olan sohbet | 97 |
| Deploy | **YAPILMADI** (gateway değişikliği kapılı; backend değişikliği yok) |

> **ÖNEMLİ:** `cfc20cf` ve `4d49701` üretime deploy edilmedi. Üretim `b5715fe`.
> Gateway container'ı `--no-gateway` deploy'ları yüzünden 17:25Z'den beri aynı.
> **Gateway'i yeniden başlatma/oluşturma** — bellek içi `messagesByChat` kaybolur (A6).

---

## 1. BU OTURUMDA KANITLANANLAR

### 1.1 Gateway bellek yaşam döngüsü (kod kanıtı)
`whatsapp-gateway/src/messages/message-store.js::createSessionStore` yalnızca şunları geri yükler:
- `contacts` → `contactCache.load(...)` (diskten)
- `rawMediaCache` → `rawMediaCache.load(store)` (diskten)

**Geri yüklenmeyenler:** `messagesByChat`, `chats`, `lidToJid`, `jidToLid`, `rawMessagesByChat`.
Bunlar süreç yeniden başlayınca boşalır; `chats`/`contacts` Baileys history sync ile yeniden dolar, **mesajlar dolmaz** (A6).

### 1.2 Mesaj kalıcılığı iki katmanlı ve asimetrik
- Gateway belleği: tüm history sync chunk'ları (`History sync ingested` logları: 467 / 4952 / 4667 / 4922 / 4985 / 2208).
- Backend DB: `_SYNC_PER_CHAT_LIMIT = 50` (`backend/app/services/whatsapp/orchestration/sync.py:107`) — **sohbet başına yalnızca en yeni 50**.
- Sonuç: 50'den eski mesajlar **yalnızca gateway belleğinde**; gateway restart'ında erişilemez hale gelir. Bu, "bellek kaybı → kalıcı veri kaybı" riskinin somut yoludur.

### 1.3 On-demand geçmiş çekme CANLI olarak yeniden üretildi (kritik)
Örnek sohbet: `conv 38346`, `+905414063102` ("Ömer Özcan Türkoğlu"), DB'de **4 mesaj** (2026-08-16 17:05:25 → 2026-08-17 05:45:23). Kullanıcı ilk mesajı 15 Mayıs'ta gönderdiğini söylüyor → 4'ten eski hiçbir şey yok.

Çalıştırılan (salt-okunur; mesaj GÖNDERMEZ, yalnızca telefondan geçmiş ister):
```
GET /sessions/1bd78836-.../conversations/905414063102@s.whatsapp.net/messages
    ?limit=50&fetch_provider=true
    &before=<2026-08-16T17:05:25Z ms>
    &oldest_msg_id=3AAA33B14604BFC9A632
    &oldest_msg_from_me=true
    &oldest_msg_timestamp_ms=<aynı ms>
    &timeout_ms=15000
```
Sonuç: **`STATUS 200`, `elapsed_ms 15100`, `provider_status: TIMEOUT`, `messages: []`**.
Gateway logu: yalnızca `Older history request timed out waiting for provider chunk` — **hiç `History sync ingested` yok**, yani telefon chunk döndürmedi.

### 1.4 Bu oturumdaki örnek sohbet kanıtı eski bağlantılara ait
`whatsapp_private.history_sync_states` (anahtar `(session_id, jid)`; `session_id` = **bağlantı UUID'si**):
| session_id | state | last_error | returned |
|---|---|---|---|
| `8c4dd7ff-…` | PROVIDER_ERROR | `Provider history error: SOCKET_UNAVAILABLE` | 0 |
| `0b72b1ab-…` | PROVIDER_ERROR | `Provider history error: SOCKET_UNAVAILABLE` | 0 |
| `7c73505f-…` | TIMEOUT | Gateway timeout | 4 |

**Mevcut `1bd78836` için satır yok** → bu bağlantıda o sohbet için hiç deneme yapılmamış.
Dağılım (25 satır): TIMEOUT 13, PROVIDER_ERROR 9, HAS_MORE 3.

### 1.5 Deployed gateway ZATEN düzeltilmiş sürümü çalıştırıyor
Container içindeki `/app/src/session-manager.js` okundu:
- `providerFetchNeeded = fetchProvider && Boolean(targetAnchorId) && (isPagingOlder || list.length < limit)` (satır 1121)
- `sockUsable = ... && isSocketReady(session.sock)` (satır 1123)
- `timeoutMs: timeoutMs ? Number(timeoutMs) : 15000` (satır 1136)

Yani daha önceki `SOCKET_UNAVAILABLE` ve "5 sn clamp" hipotezleri **üretimde zaten giderilmiş** (`8e06bad`, `8a8ae49`; `b5715fe`'nin atası). Bu yüzden onları yeniden "düzeltmeye" kalkma.

### 1.6 DEAD_LETTER: iki eski satır ARTIK YOK
`whatsapp_private.event_outbox` kolonları: `sequence, event_id, session_id, event_type, ciphertext, nonce, auth_tag, key_version, state, attempts, next_attempt_at, created_at, delivered_at`.
- Şu an: **0 DEAD_LETTER**, 5848 satır hepsi `DELIVERED` (4619 × attempts=1, 1229 × attempts=2).
- Eski `247738` / `247865` **silinmiş**. Sebep: `postgres-event-outbox.js::cleanup()` satır 232:
  `(state = 'DEAD_LETTER' AND created_at < NOW() - INTERVAL '48 hours')`.
- Yani **48 saatlik DEAD_LETTER saklama penceresi** var; replay edilmedi, retention sildi. Operatör replay'i ancak 48 saat içinde mümkün.

---

## 2. BU OTURUMDA YAPILAN KOD DEĞİŞİKLİĞİ

**Tek konu:** `messages_cached` sağlık metriği yalan söylüyordu.

- Eski: `Math.max(store?.messages ? store.messages.size : 0, sync.messages_cached || 0)`
- `createSessionStore` **`store.messages` tanımlamıyor** → ilk operand hep 0.
- `connection.open` (`socket-events.js:425-428`) `session.sync`'i `messages_cached` anahtarı **olmayan** yeni bir nesneyle değiştiriyor → reconnect sonrası metrik **0** (bellekte binlerce mesaj varken).
- Yeni: `countCachedMessages(store)` (`messages/message-store.js`) → `messagesByChat` toplamı; iki serializer'da da kullanılıyor (`session-manager.js:519`, `index.js:251`).

**Dosyalar:**
- `whatsapp-gateway/src/messages/message-store.js` (+ helper)
- `whatsapp-gateway/src/session-manager.js` (import + kullanım)
- `whatsapp-gateway/src/index.js` (import + kullanım)
- `whatsapp-gateway/scripts/test-messages-cached-metric.mjs` (yeni test)
- `whatsapp-gateway/package.json` (test zincirine eklendi)

**Not:** Bu bir **gateway** değişikliğidir. Direktif gereği deploy **kapılı**. Commit/push güvenli; deploy için ayrı onay gerekir.

---

## 3. AÇIK SORU (sıradaki en yüksek risk)

**Telefon, `HISTORY_SYNC_ON_DEMAND` PDO'suna bu sohbet için neden cevap vermiyor?**

Kanıtlananlar:
- PDO doğru gönderiliyor: `sendPeerDataOperationMessage` → `relayMessage(meJid, …)` (Baileys `messages-send.js:342-367`), `category: 'peer'`, `push_priority: 'high_force'`.
- `ON_DEMAND` `PROCESSABLE_HISTORY_TYPES` içinde (`Defaults/index.js:38`) → filtre değil.
- Aynı oturumda bazı sohbetler **HAS_MORE 50** ile başarılı oldu → mekanizma çalışıyor.
- Bu sohbette 15 sn boyunca **hiç chunk yok**.

Elenecekler / sıradaki adımlar:
1. **Telefon gerçekten online mı?** `is_phone_online` yalnızca `connection.open`'da true yapılan yerel bir bayrak; telefonun presence'ı değil. Telefonun WhatsApp'ı kapalı/uykuda olabilir.
2. **Anchor telefonun elinde mi?** `3AAA33B14604BFC9A632` OUTBOUND, 2026-08-16. Telefonun o mesajı tuttuğu doğrulanmalı (ör. telefondan aynı sohbette yukarı kaydırma).
3. **LID ekseni:** `905414063102 ↔ 144130562887745@lid`, `905525372434 ↔ 97418884436079@lid` eşlemeleri `whatsapp_private.lid_mappings`'te var. `resolveJidKey` PN'i **olduğu gibi** döndürür (yalnızca LID→PN çevirir). Gelen chunk LID ile gelirse `normalizeJid` onu PN'e çevirebilir; bu ancak `store.lidToJid` dolduysa olur. `loadLidMappingsFromDb` kapsamı `session_name='Hat 1'` üzerinden tüm geçmiş UUID'leri kapsıyor (doğrulandı), yani eşleme yüklenmiş olmalı — ama chunk hiç gelmediği için bu henüz test edilemedi.
4. **Doğrudan ölçüm:** gateway'e geçici bir teşhis (örn. `GET /sessions/:id/debug/socket` → `sock` var mı, `ws.readyState`, `messagesByChat` anahtar sayısı) eklemek en hızlı yol. Gateway deploy kapılı olduğu için önce onay al.

---

## 4. YENİDEN ÜRETME / DOĞRULAMA KOMUTLARI

```bash
# Baz
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 \
  'cat /opt/tezlify/.deployed-commit; docker ps --format "{{.Names}}|{{.ID}}|{{.Status}}|{{.RunningFor}}"'

# Sağlık (host'ta port publish yok; container içinden)
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 \
  'docker exec tezlify-gateway node -e "fetch(\"http://127.0.0.1:8787/health\").then(r=>r.text()).then(console.log)"'

# Socket canlı mı? (404 "Session not connected" => session.sock null)
SID=1bd78836-c084-4cbf-b333-9386d44b7bd7
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 "docker exec tezlify-gateway node -e '
const s=process.env.WHATSAPP_GATEWAY_SECRET;
fetch(\"http://127.0.0.1:8787/sessions/$SID/contacts/905414063102@s.whatsapp.net/status\",{headers:{Authorization:\"Bearer \"+s}}).then(async r=>console.log(r.status,await r.text()))'"

# On-demand PDO (YUKARIDA §1.3)
# DB: sayaçlar
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 \
  'docker exec tezlify-db psql -U tezlify -d tezlify -Atc "select (select count(*) from conversations),(select count(*) from messages),(select max(id) from messages);"'

# Test kapıları
cd /Users/isatezcan/Documents/Github/Tezlify
source venv/bin/activate && export PYTHONPATH=. TEST_DB_PATH=/tmp/tezlify_clean.db
rm -f /tmp/tezlify_clean.db && python scripts/provision_test_db.py
pytest backend/tests/ -q -p no:randomly
cd whatsapp-gateway && npm test
cd ../frontend && npm run build && npm run verify:i18n-keys
```

---

## 5. DOKUNULMAMASI GEREKENLER (invariant özeti)

- **Gateway'i yeniden başlatma/oluşturma** — `messagesByChat` kaybolur (A6). Deploy gerekiyorsa `--no-gateway` kullan; gateway değişikliği varsa `--no-gateway` **REDDEDER** (exit 1).
- **Deploy yalnızca `scripts/deploy/host-release.sh`** ile; çalışan script **hedef commit'in kopyası** olmalı (`git show <sha>:scripts/deploy/host-release.sh > /tmp/hr.sh`).
- **`db` hiçbir compose dosyasında yok** → `up -d --remove-orphans` **asla**.
- **`DELETE /sessions/{id}`** cascade ile o hattın tüm konuşma+mesajlarını siler.
- **pytest'i dev DB'de çalıştırma**; `conftest` non-localhost `DATABASE_URL`'i reddeder.
- `pytest-randomly` kurulu → yeni modül-global cache / hata fırlatan cleanup sıra bağımlılığı yaratır.
- **Gerçek cihaz E2E** bu oturumda yapılmadı → BLOCKED.

---

## 6. SIRADAKİ ADIMLAR (öncelik sırası)

1. `messages_cached` fix'ini commit + push et (gateway deploy **kapılı**).
2. Gateway teşhis endpoint'i (socket/store durumu) ekle → PDO'nun neden cevapsız kaldığını ölç. Deploy için onay al.
3. Telefonun o sohbette 15 Mayıs mesajını gerçekten tuttuğunu doğrula (kullanıcıyla).
4. `_SYNC_PER_CHAT_LIMIT=50` politikasını gözden geçir: 50'den eski mesajlar yalnızca bellekte. Alternatif: ilk senkron limitini artırmak **veya** history chunk'larını sınırlı biçimde DB'ye yazmak (outbox flooding'e dikkat — `6918b3b`).
5. DEAD_LETTER 48 saat penceresi için idempotent operatör replay aracı tasarla (yalnızca kanıtlanmış tenant/idempotency ile).
