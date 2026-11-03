# Aşama 4.26 — Kontrollü Backend + Gateway Production Deployment

**Tarih:** 2026-11-01 00:57–01:07 +0300 (deploy penceresi: **2026-10-31T21:57:24Z → 21:59:50Z**, doğrulama: **21:59–22:06Z**)
**Mod:** **DEPLOYMENT** (kullanıcı açık onay verdi). Yalnızca `de1f1ad…` dağıtıldı.
**Sonuç:** ✅ **DEPLOYMENT SUCCESS — BACKEND 4.7 + GATEWAY 4.17 VERIFIED**

> **Tek cümle:** Deploy **`DEPLOY_RC=0`** ile 2 dk 27 sn'de tamamlandı; `.deployed-commit` = `de1f1ad…`, her iki imaj da beklenen digest'te, beş kritik dosyanın **tam SHA256**'sı hedef commit'le birebir, **RAM_ONLY = 0**, ve **filigran altındaki 9487 mesajın tamamı korundu** (`count(id ≤ 168741) = 9487`). Rollback **tetiklenmedi**.

---

## 0. Karar özeti

| Kriter | Beklenen | Gerçek | Sonuç |
| --- | --- | --- | --- |
| K1 · RAM_ONLY | **0** | **0** | ✅ |
| K2 · Outbox PENDING / IN_FLIGHT | 0 / 0 | 0 / 0 | ✅ |
| K3 · Oturum + servisler | bağlı, healthy | 1 CONNECTED, 4/4 healthy | ✅ |
| K4 · Persistence | kapalı | `config_enabled=false`, `runs=0` | ✅ |
| Dry-run | RC=0 | RC=0 (4. denemede) | ✅ |
| Gerçek deploy | RC=0 | **RC=0**, 2 dk 27 sn | ✅ |
| `.deployed-commit` | `de1f1ad…` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` | ✅ |
| İmaj digest'leri | yeni backend + yeni gateway | `2c5990…` + `7905b3…` | ✅ |
| 5 dosya SHA256 | hedef = canlı | **5/5 birebir** | ✅ |
| DB bütünlüğü | 0 null / 0 orphan / 0 dup | 0 / 0 / 0 | ✅ |
| Mesaj kaybı | yok | **0** (filigran kanıtı) | ✅ |
| Rollback | gerekmedi | **tetiklenmedi** | ✅ |

**→ DEPLOYMENT SUCCESS — BACKEND 4.7 + GATEWAY 4.17 VERIFIED**

---

## 1. Deploy öncesi kapı (K1) — RAM / DB

Ölçüm **deploy anında yeniden** yapıldı (4.25'in 9168/9464 değeri **kullanılmadı**).

| Metrik | Değer |
| --- | --- |
| Gateway RAM (tekil `conversation_id｜wa_message_id`) | **9168** / 100 sohbet |
| DB mesaj | **9487** |
| **RAM_ONLY** | **0** |
| DB_ONLY | 319 (sohbet 38289: 229 · 38291: 90) |
| `wa_message_id IS NULL` | 0 |
| Orphan | 0 |
| Duplicate `(conversation_id, wa_message_id)` | 0 |
| `whatsapp_data_audit.failed` | 0 |
| Filigran | `max(id) = 168741` |
| Sayımlar `messages｜conversations｜contacts` | `9487｜126｜1538` |

**Kapı açıldı:** RAM_ONLY = 0 → deploy'a izin var. DB_ONLY 319, 2000/sohbet tavanı taşmasıdır (kayıp değil, RAM'de olmayan fazlalık).

---

## 2. Deploy öncesi kapı (K2) — Outbox / DB

| Öğe | Değer |
| --- | --- |
| `event_outbox` toplam | 1163 |
| DELIVERED | 1163 |
| **PENDING** | **0** |
| **IN_FLIGHT** | **0** |
| DEAD_LETTER | 0 |
| `max(attempts)` | 1 |
| `processed_events` | 3900+ (en yenisi saniyeler önce) |

**Kapı açıldı:** uçuşta olay yok → recreate sırasında teslim edilmemiş olay kaybı riski yok.

---

## 3. Dry-run

Tam SHA ile, yasak bayraklar **olmadan**:

```
bash scripts/deploy/run_release.sh --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
     de1f1ad34f123a304f6b6432cd22a546ccafac36 --dry-run
```

**Sonuç: `DRYRUN_RC=0`.** Plan çıktısı:

| Öğe | Değer |
| --- | --- |
| Cutover servisleri | `backend gateway` |
| Frontend | yok |
| migration-guard | **temiz** |
| `--no-gateway` | kullanılmadı (kullanılamaz — §10/F2) |
| `--allow-migrations` / `--frontend-tar` / `--rollback-to` | kullanılmadı |

### 3.1 Dry-run'a giden yol (operasyonel not — 3 başarısız deneme)

| # | Sonuç | Neden | Düzeltme |
| --- | --- | --- | --- |
| 1 | `RC=2` | Host hedef commit'i tanımıyordu (`HATA: hedef commit cozulemedi`) | Host'ta salt-okunur `git fetch origin --prune` |
| 2 | `RC=2` | `bilinmeyen secenek: --expected-self-blob` — **ref önce, opsiyon sonra** yazılmıştı | Opsiyonlar ref'ten **önce** |
| 3 | `RC=9` | `baslatici pinlenen surum degil (self=9284245f beklenen=f2b7a9ae)` | `--expected-self-blob` **`run_release.sh`**'in blob'udur, `host-release.sh`'in değil |
| 4 | **`RC=0`** | — | ✅ |

> **Ders:** `f2b7a9ae…` (direktifte "beklenen script blob") `host-release.sh`'in blob'udur; `--expected-self-blob` ise **başlatıcıyı** (`run_release.sh`, `9284245f…`) pinler. `host-release.sh`'in `f2b7a9ae…` eşitliği ayrıca betiğin **kendi** script-version-guard'ı tarafından doğrulandı (`script_matches_target self=f2b7a9ae target=f2b7a9ae`).

---

## 4. Gerçek deployment

```
bash scripts/deploy/run_release.sh --expected-self-blob 9284245fa56c… \
     de1f1ad34f123a304f6b6432cd22a546ccafac36
```

| Öğe | Değer |
| --- | --- |
| **`DEPLOY_RC`** | **0** |
| Süre | **2 dk 27 sn** (21:57:24Z → 21:59:50Z) |
| Release TS | `20261031T215724Z` |
| Rollback | **tetiklenmedi** |
| Kayıt | `/opt/tezlify/backups/releases/20261031T215724Z/release.json` |

### 4.1 Betik içi muhafızlar (hepsi geçti)

| Muhafız | Log satırı | Sonuç |
| --- | --- | --- |
| script-version-guard | `IZINLI (script_matches_target) self=f2b7a9ae target=f2b7a9ae` | ✅ |
| migration-guard | `migration-guard: temiz` · `approval: clean` | ✅ |
| Aday sağlığı | `adacik SAGLIKLI` · `candidate_health: ok` | ✅ |
| **İzolasyon kanıtı** | `adacik penceresinde uretim satir sayisi degismedi: 126｜9492｜1538 (izolasyon kaniti)` | ✅ |
| Persistence guard | `IZINLI (flag_explicitly_false)` → `IZINLI (flag_absent_defaults_off)` | ✅ |
| Cutover imaj kimliği | `backend=sha256:2c599 gateway=sha256:7905b` | ✅ |
| Şema parmak izi | `35f90bc7674f → 35f90bc7674f` (`schema_changed: false`) | ✅ |
| Satır sayısı korundu | `cutover sonrasi satir sayisi degismedi: 126｜9496｜1538` | ✅ |
| Betik içi hash | `events.py`, `reactions.py`, `session-manager.js` → `hash OK` | ✅ |
| Frontend | `frontend: null` (dağıtılmadı), edge `200` | ✅ |

### 4.2 Migration penceresi (silme kanıtı)

Aday container izole klon DB'de (`tezlify_cand_20261031T215724Z`) **25 migration satırı** koştu. Üretim satır sayıları pencerede **değişmedi**:

| An | `messages｜conversations｜contacts` |
| --- | --- |
| `counts_before` | `126｜9489｜1538` |
| `counts_after_candidate` | `126｜9492｜1538` |
| `counts_after_cutover` | `126｜9496｜1538` |
| `dropped_during_candidate` | **false** |
| `dropped_during_cutover` | **false** |

Artışlar tek yönlü (+3, +4) — canlı trafik. **Hiçbir düşüş yok.**

---

## 5. A — `.deployed-commit` ve imaj digest'leri

```
$ cat /opt/tezlify/.deployed-commit
de1f1ad34f123a304f6b6432cd22a546ccafac36
```

| Servis | Canlı imaj | `release.json` | Sonuç |
| --- | --- | --- | --- |
| backend | `sha256:2c59909993e5c2095080466e3a1c666f17cb06400c1bd835d0760e85ae1036c7` | aynı | ✅ |
| gateway | `sha256:7905b32df9e19c0c22e7bee7ccaebd63623082491f477fcc1cf8ab0a1028b56d` | aynı | ✅ |

Önceki backend imajı (rollback hedefi): `sha256:06ce4fe12874d9e694e03e2f53e74f6d95fef5e3339b4dfde7c8554ec9ddb21a`
Rollback etiketleri: `tezlify-backend:pre-20261031T215724Z` · `tezlify-gateway:pre-20261031T215724Z`

`release.json` alanları: `sha`, `sha_short`, `subject`, `released_at`, `backend_image`, `gateway_image`, `live_backend_image`, `live_gateway_image`, `previous_backend_image`, `gateway_touched: true`, `deploy_script.blob = f2b7a9aeb5c46247bae73dfc226d8a83dfeea587`, `frontend: null`.

---

## 6. B — Backend 4.7 doğrulaması (`GET /metrics`)

```
METRICS_KEYS ['generated_at','service','version','whatsapp_identity_sweep','whatsapp_memory_persistence']
```

`whatsapp_memory_persistence` anahtarı **var** → **Backend 4.7 canlı.**

| Alan | Değer |
| --- | --- |
| `config_enabled` | **false** |
| `task_running` | **false** |
| `runs` | **0** |
| `cursor_count` | 0 |
| `cursor_modes` | `{}` |
| `dead_letter_total` | 0 |
| `epoch_resets_total` | 0 |
| `stalled_pages_total` | 0 |
| `persistence_lag_seconds` | null |

> 4.25'te düzeltildiği üzere 4.7 sinyali **`GET /metrics`**'tir (`main.py:958`); `/metrics/check` **404**'tür. Bu raporda da `/metrics` kullanıldı.

Genel edge üzerinden de doğrulandı: `https://api.130.162.247.20.sslip.io/metrics` → HTTP 200, aynı 5 anahtar, `config_enabled=False runs=0`.

---

## 7. C — Gateway 4.17 doğrulaması (`/health.capacity`)

`capacity` nesnesi **mevcut** → **Gateway 4.17 canlı.**

```json
{"sessions":1,"sessions_with_store":1,"ram_messages_total":25,"ram_chats_total":2,
 "ram_chats_at_cap":0,"ram_chat_max_utilization":0.012,"ram_raw_store_total":1166,
 "ram_raw_store_utilization":0.1166,"evictions_total":1,
 "evictions_by_chat":{"affected_chats":0,"max_per_chat":0,"total":1},
 "evictions_by_reason":{"raw_chat_cap":1},"last_eviction_at":"2026-10-31T22:00:42.684Z",
 "limits":{"per_chat":2000,"chats":300,"raw_store":10000}}
```

| Alan | Değer | Yorum |
| --- | --- | --- |
| `sessions` / `connected` | 1 / 1 | tek hat bağlı |
| `pending_qr` | 0 | QR beklenmiyor |
| `orphaned_sessions` | 0 | yetim oturum yok |
| `database` | `connected` | gateway→PG sağlıklı |
| `limits.per_chat` | 2000 | `MESSAGES_PER_CHAT_MAX` (değişmedi) |
| `ram_raw_store_total` | 1166 | %11.66 — tavan 10000 |
| `ram_chats_at_cap` | 0 | tavana dayanan sohbet yok |

### 7.1 RAM ↔ DB yeniden ölçümü

Recreate sonrası RAM **boşaltıldı ve yeniden doluyor** (bu beklenen davranış; kalıcılık DB'dedir).

| Metrik | Değer |
| --- | --- |
| Gateway RAM tekil anahtar | **25** |
| DB mesaj | **9521** |
| **RAM_ONLY** | **0** |
| DB_ONLY | 9496 (beklenen — RAM artık kısmi bir önbellek) |

> **Dürüst yorum:** Recreate sonrası RAM 25 mesaja düştüğü için `RAM_ONLY = 0` **trivial olarak** sağlanır — bu ölçüm tek başına güçlü bir kanıt değildir. Asıl kanıt §11'deki **filigran karşılaştırmasıdır** (DB'de kayıp yok). RAM düşüşü veri kaybı **değildir**: geçmiş DB'den okunur (bkz. `4.14`: RAM_ONLY 0, DB tek doğruluk kaynağı).

### 7.2 P0-1'in runtime kanıtı (seq sayfalama)

Gateway'in **yeni** yarısının gerçekten çalıştığının doğrudan kanıtı:

```
afterSeq=0&seqEpoch=probe426 →
  {"total":19,"pagination":"seq","seq_epoch":"477927f7-73f6-44e1-896d-e419af3e7aeb",
   "max_seq":19,"after_seq":0,"next_after_seq":5,"reached_end":false,
   "epoch_reset":true,"eligible_total":19}

afterSeq=5&seqEpoch=477927f7… →
  {"pagination":"seq","after_seq":5,"next_after_seq":10,"epoch_reset":false,"eligible_total":14}

OVERLAP = 0
```

| Gözlem | Anlamı |
| --- | --- |
| `pagination: "seq"` | 4.25'te `afterSeq` **sessizce yok sayılıyordu**, `pagination` anahtarı **yoktu** → artık var |
| `seq_epoch` (UUID) | süreç nesli; recreate'te imleç sıfırlanır |
| `epoch_reset: true` (ilk çağrı) | uyuşmayan epoch → güvenli yeniden tarama (`after = 0`) |
| `after_seq=5` → `next_after_seq=10`, `epoch_reset:false` | değer tabanlı imleç ilerliyor |
| **`OVERLAP = 0`** | sayfa sınırında **tekrar yok** — P0-1'in kapattığı hata sınıfı |
| `offset=0` (parametresiz) → `pagination: "offset"` | geriye dönük uyumluluk korundu |

---

## 8. D — Beş kritik dosyanın **tam SHA256** doğrulaması

Hedef `de1f1ad` ağacından hesaplanan değer ile **container içindeki canlı dosya** karşılaştırıldı.

| Dosya | Tam SHA256 | Sonuç |
| --- | --- | --- |
| `backend/app/services/whatsapp/memory_persistence.py` | `070fda0397f76577b14be63a699db26bb9ad1a98d36e358d2fe972ae6a323172` | ✅ |
| `backend/app/services/whatsapp/orchestration/sync.py` | `edb7e9d2921c769913f53396e6b6e719dc7a5279ae2cdf705e109287e5c14eb6` | ✅ |
| `whatsapp-gateway/src/index.js` | `641b106241bc28f582ae32dc702bec90370529c8f425dc282e751cde7ebfd7a0` | ✅ |
| `whatsapp-gateway/src/messages/message-store.js` | `cc4414f2f96207b280f144860e0882c68d03091b0217386d7d3bca02135aa9bd` | ✅ |
| `whatsapp-gateway/src/socket/socket-events.js` | `f441cb942bf1abd993629b4fedd1fa4131f893a8487d51183117b2b4942a9668` | ✅ |

**Ek (6.) — `whatsapp-gateway/src/session-manager.js`:**
`0818cc85bb11ac5db8f05160c4c1b0059836b4bd8c048f210d63d199614d6041` → ✅
(betik içi guard da `hash OK` verdi; bu hash **hedefin** hash'idir — `cbe4f509`'daki değeri `c42355ec…`'dir, yani dosya gerçekten değişti.)

Backend dosyaları container içinde **iki** yolda da aynı: `/app/backend/...` (runtime) ve `/opt/tezlify/deploy/backend/...` (deploy kaynağı) → ikisi de yukarıdaki hash'ler.

> **Hash disiplini:** git blob = **SHA1**, dosya içeriği = **SHA256**. Bu bölümdeki tüm değerler **içerik SHA256**'dır ve `de1f1ad`'dan yeniden hesaplanmıştır (kısaltılmış önek yok).

---

## 9. E — DB ve WhatsApp işlevselliği

### 9.1 Bütünlük

| Kontrol | Sonuç |
| --- | --- |
| `wa_message_id IS NULL` | **0** |
| Orphan (conversation'ı olmayan mesaj) | **0** |
| Duplicate `(conversation_id, wa_message_id)` | **0** |
| `whatsapp_data_audit.failed` | **0** |
| `duplicate_skipped` | 0 |

### 9.2 Sayımlar

| Tablo | Değer |
| --- | --- |
| messages | **9521** |
| conversations | 126 |
| contacts | 1538 |

### 9.3 Outbox (cutover sonrası)

| Durum | Adet |
| --- | --- |
| DELIVERED | 1256 |
| **PENDING** | **0** |
| **IN_FLIGHT** | **0** |
| DEAD_LETTER | 0 |
| `max(attempts)` | 1 |

`processed_events` = 3919, en yenisi `2026-10-31 22:02:33Z` → tüketim **canlı**.

Gateway logu aktif teslimat gösteriyor (`event_outbox_batch_sent` serisi, `first_sequence` 268640 → 268651) → **yeni PENDING/IN_FLIGHT birikmesi yok**.

### 9.4 Oturum ve köprü

| Öğe | Değer |
| --- | --- |
| `whatsapp_sessions.status` | **CONNECTED** (1) |
| `gateway_bridge.connected` | **true** |
| `gateway_bridge.last_connected_at` | `2026-10-31T21:59:46Z` |
| `gateway_bridge.last_event_at` | canlı (22:04:35Z) |
| `gateway_bridge.last_pong_at` | canlı (22:04:26Z) |
| `gateway_bridge.reconnect_count` | 1 (deploy sonrası ilk bağlantı) |
| `sessions.pending_qr` | 0 |
| `orphaned_sessions` | 0 |

### 9.5 Container sağlığı

| Container | Durum | Health | RestartCount | Başladı |
| --- | --- | --- | --- | --- |
| tezlify-backend | running | **healthy** | **0** | 21:59:37Z |
| tezlify-gateway | running | **healthy** | **0** | 21:59:44Z |
| tezlify-db | running | **healthy** | **0** | 2026-10-01 |
| tezlify-caddy | running | **healthy** | **0** | 2026-10-12 |

**DB ve Caddy recreate edilmedi** (yalnızca `backend gateway` cutover edildi) — DB kesintisi yok.

### 9.6 Edge

`https://api.130.162.247.20.sslip.io/health` → **HTTP 200**, `T=0.052s`, `status: healthy`.

### 9.7 Temizlik

Aday klon DB (`tezlify_cand_20261031T215724Z`) **düşürüldü**: `pg_database` üzerinde `tezlify%` yalnızca **`tezlify`** döndürüyor. Sızıntı yok.

---

## 10. F — Veri kaybı kontrolü (filigran)

**Deploy öncesi filigran:** `max(id) = 168741`, toplam **9487** mesaj.

**Deploy sonrası:**

| Ölçüm | Değer |
| --- | --- |
| `count(*) WHERE id <= 168741` | **9487** |
| Deploy öncesi toplam | **9487** |
| **Fark** | **0** |
| Deploy sonrası toplam | 9521 |
| Deploy sonrası `max(id)` | 168775 |

**Sonuç:** Filigranın **altındaki her mesaj yerinde** (9487 = 9487). Filigran üstünde **34 yeni** mesaj var (9521 − 9487), hepsi `id > 168741` → **kayıp değil, birikim**.

Betik içi sayaçlar da tek yönlü: `9489 → 9492 → 9496` — hiçbir adımda düşüş yok (`dropped_during_candidate: false`, `dropped_during_cutover: false`).

> **Neden bu kanıt güçlü:** Recreate RAM'i sıfırladığı için "RAM_ONLY = 0" bu ölçümde zayıftır (§7.1). Kaybın olmadığını söyleyen şey, **DB'de filigran altındaki satır sayısının birebir korunmasıdır** — bu, RAM'den bağımsızdır.

---

## 11. Persistence loop kapalı — kanıt

| Katman | Kanıt |
| --- | --- |
| Betik (aday env) | `persistence-flag-guard: IZINLI (flag_explicitly_false)` |
| Betik (cutover öncesi `.env.production`) | `persistence-flag-guard: IZINLI (flag_absent_defaults_off)` |
| Betik (cutover sonrası `/health`) | `cutover dogrulandi: kalicilastirma ETKIN olarak kapali (/health)` |
| Backend log | `[MEMORY-PERSIST] kapalı (flag yok veya false; fail-closed)` |
| `/metrics` | `config_enabled=false`, `task_running=false`, `runs=0`, `cursor_count=0`, `cursor_modes={}` |

**Loop bu aşamada açılmadı ve açılmayacak.** Flag değiştirilmedi.

---

## 12. Hatalar / uyarılar / rollback durumu

| Öğe | Durum |
| --- | --- |
| Rollback tetiklendi mi? | **Hayır** (`on_error` hiç çalışmadı) |
| Backend `ERROR/CRITICAL/Traceback` (son 15 dk) | **0 satır** |
| Gateway `ERROR/FATAL/Uncaught` (son 15 dk) | **0 satır** |
| Deploy betiği uyarısı | 1 adet, **kozmetik**: `docker-compose.prod.yml: the attribute version is obsolete` |
| Manuel müdahale | **Yok** (RAM temizleme, ikinci recreate, DB yazma, loop açma, otomatik düzeltme — hiçbiri) |

---

## 13. Bulgular

### F1 — Deploy betiğinde gateway RAM muhafızı **yok** (4.25'ten devam)
`host-release.sh` içinde `messagesByChat` / `capacity` için hiçbir kontrol yok (`grep` = 0 eşleşme). Recreate güvenliği **tamamen operatörün deploy öncesi ölçümüne** bağlıdır. Bu aşamada K1 elle yapıldı ve RAM_ONLY=0 çıktı; ama bu bir **süreç** garantisidir, **kod** garantisi değil.

### F2 — `--no-gateway` bu release için **yapısal olarak imkânsız**
`de1f1ad`, `cbe4f509`'a göre `whatsapp-gateway/` altında **7 dosya** değiştiriyor. Betiğin muhafızı (`git diff --quiet … -- whatsapp-gateway/ …`) bu yüzden reddeder. Doğru davranış: "gateway sessizce gönderilmedi" kazası imkânsız.

### F3 — `--rollback-to` **ikinci** bir recreate yapar
`pre-<TS>` etiketleri **önceki** imajları tutar; rollback ikinci kez RAM'i sıfırlar. Bu deploy'da kullanılmadı.

### F4 — Cutover sonrası mesaj kaybı yalnızca `UYARI`
Cutover öncesi kayıp `die` eder, sonrası yalnızca uyarır. Bu deploy'da hiçbir aşamada kayıp görülmedi.

### F5 — `verify_blob` yalnızca **3** dosyayı hash'ler
`events.py`, `reactions.py`, `session-manager.js`. Bu deploy'da **5 kritik dosyanın tamamı** ayrıca elle doğrulandı (§8) — betiğin kapsamı yetersiz, telafi edildi.

### F6 — **P0-1'in backend yarısı bu deploy'da uykuda** (yeni, önemli)
- `memory_persistence.py` seq yolunu **içeriyor** (satır 404–444: `after_seq`/`seq_epoch`, `mode == "seq"`), ama bu kod **persistence loop'unda** yaşar ve loop **kapalı**.
- **Initial sync** (`orchestration/sync.py`) hâlâ **yalnızca offset** kullanıyor (satır 1703–1718: `limit=…, offset=offset, since=…, per_chat_limit=50, jids=…`). Canlı log bunu doğruluyor:
  `GET …/messages/bulk?limit=1000&offset=0&since=1793483653&perChatLimit=50`
- **Sonuç:** P0-1'in *gateway* yarısı **canlı ve doğru** (§7.2). *Backend* yarısı **dağıtıldı ama çalışmıyor** — flag açılana kadar. Initial-sync yolu, front-trim/3.6b maruziyeti bakımından **değişmedi**.

> Bu bir deployment hatası **değil**, kapsam gerçeğidir. Ama "P0-1 production'da çözüldü" cümlesi **loop açılmadan doğru değildir**; doğru cümle: *"P0-1 gateway'de canlı, backend'de hazır ve kapalı."*

### F7 — Yeni karantina satırı (beklenen, güvenli)
Deploy sonrası `whatsapp_identity_quarantine` **0 → 1**. Otomatik düzeltme **yapılmadı**; incelendi:

| Alan | Değer |
| --- | --- |
| `created_at` | 2026-10-31 21:59:41Z (backend startup, cutover'dan 4 sn sonra) |
| `contact_id` / `conversation_id` | 23776 / 38415 |
| `reason` | `bridge_unknown_has_messages` |
| `status` | `QUARANTINED` |
| `message_count` | 9 |

Startup logu bunu **açıkça** doğruluyor:

```
purge_raw_jid_identity_data: 0 ad nötrlendi, 0 mesaj adı nötrlendi,
1 hayalet karantinaya alındı (0 köprü-bekleyen, 1 mesajlı), 9 mesaj korunuyor,
SİLİNEN: 0 contact / 0 sohbet / 0 mesaj.
```

Sohbet 38415'in mesajları **yerinde**: 9 satır (id 161406–161414). Yani bu, 3.8.7'nin **silme yerine karantinaya yaz** sözleşmesinin (`deleted_* == 0`) ilk boot'ta çalışmasıdır — **hata değil, tasarım**.

---

## 14. Kapsam dışı bırakılanlar (bilinçli)

- Frontend deploy **yok** (`frontend: null`, `--frontend-tar` kullanılmadı).
- Migration **onayı** verilmedi (`--allow-migrations` yok); startup migration'lar betiğin kendi guard'ı altında koştu.
- Flag/loop değişikliği **yok**.
- Baileys/QR sıfırlama **yok**.
- Mesaj silme **yok**.
- Commit/push/merge **yok** — bu aşamada yalnızca dağıtım yapıldı.
- Aşama 5'e **geçilmedi**; Aşama 4.27 için **işlem başlatılmadı**.

---

## 15. Nihai karar

✅ **DEPLOYMENT SUCCESS — BACKEND 4.7 + GATEWAY 4.17 VERIFIED**

Gerekçe, tek tek:

1. `DEPLOY_RC = 0`, 2 dk 27 sn, rollback **tetiklenmedi**.
2. `.deployed-commit` = `de1f1ad34f123a304f6b6432cd22a546ccafac36` — hedefin **tamamı**.
3. Backend imajı `2c5990…`, gateway imajı `7905b3…` — `release.json` ile birebir.
4. **5/5** kritik dosya **tam SHA256** ile hedef commit'e eşit (ek olarak `session-manager.js` = 6/6).
5. Backend 4.7 sinyali `GET /metrics.whatsapp_memory_persistence` **mevcut**.
6. Gateway 4.17 sinyali `/health.capacity` **mevcut**; ayrıca `afterSeq` → `pagination: "seq"`, `epoch_reset` ve **sıfır örtüşme** ile runtime'da kanıtlandı.
7. **RAM_ONLY = 0**; DB bütünlüğü 0/0/0; outbox'ta uçuşta olay yok.
8. **Filigran altındaki 9487 mesajın tamamı korundu** (fark 0) — asıl veri kaybı kanıtı.
9. Persistence loop **kapalı** (üç katmanda ayrı ayrı doğrulandı).
10. 4/4 container healthy, RestartCount 0, oturum CONNECTED, köprü canlı.

**Açık konular (deploy'u engellemez, kayda geçer):** F1 (betikte RAM muhafızı yok), F4 (`verify_blob` kapsamı 3 dosya), **F6 (P0-1 backend yarısı flag kapalı olduğu için uykuda; initial sync hâlâ offset)**.

**Bu rapordan sonra duruldu.** Loop açılmadı, yeni release başlatılmadı, Stage 5'e geçilmedi.
