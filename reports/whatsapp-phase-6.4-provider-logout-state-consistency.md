# AŞAMA 6.4 — Provider Logout Hatasında Orphan CONNECTED Oturumu

**Kapsam:** 6.0 audit P1-2 — provider logout başarısız/zaman aşımına uğradığında oturumun
yanlış biçimde `CONNECTED` kalması.
**Sonuç:** Düzeltildi; testler A–G ve ek temizlik-hatası senaryosu geçti.
**Karar:** `PASS_WITH_NOTES`.

---

## 1. Başlangıç ve bitiş Git durumu

| | Başlangıç | Bitiş |
|---|---|---|
| Worktree | `/private/tmp/tz429-release` | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` | `release/backend-only-seq-safety` |
| HEAD | `978ddf56877cd7aad7d2f30b095b6232e34802d2` | `978ddf56877cd7aad7d2f30b095b6232e34802d2` |
| Modified + untracked giriş | 24 modified + 26 untracked = 50 | 25 modified + 28 untracked = 53 |

- 6.1/6.2/6.3 dahil tüm mevcut dirty/untracked dosyalar korundu.
- `git reset`, `git clean`, `git stash`, `git checkout`, `git switch`, `git rebase`,
  `git merge`, `git add .`, `git add -A` **kullanılmadı**.
- Commit / push / deploy yapılmadı.
- Bağımlılık kurulmadı/güncellenmedi.
- Production DB'ye veya gerçek WhatsApp oturumuna bağlanılmadı.
- Ana repository / başka worktree üzerinde işlem yapılmadı.

Bitişte artan 3 giriş 6.4'e aittir:

- `backend/app/services/whatsapp/orchestration/sessions.py` (modified — başlangıçta dirty değildi)
- `backend/tests/test_whatsapp_logout_state_64.py` (untracked, yeni)
- `whatsapp-gateway/tests/test-logout-state-consistency-64.mjs` (untracked, yeni)

Bu rapor `reports/` dizini zaten untracked olduğu için status satır sayısını değiştirmez.

---

## 2. Kök neden ve baseline reproducer

### Kök neden

Eski `logoutSession` akışı:

1. `session.lifecycle.invalidate()` + lease release,
2. `await session.sock.logout()` — **ilk await sağlayıcı çağrısıydı**,
3. sağlayıcı reddederse `providerError` yakalanıyor ve `!force` ise
   **yerel durum yazılmadan** hata fırlatılıyordu,
4. `session.status = 'DISCONNECTED'`, auth temizliği, session dizini silme ve
   `session_disconnected` yayını bu noktadan **sonra** geliyordu.

Sonuç: `sock.logout()` reddeder veya asılı kalırsa oturum `CONNECTED`,
`is_active=true`, socket hâlâ bağlı kalıyordu. Backend 5xx alıp satırı
`CONNECTED` bırakıyor, UI "bağlı ama ölü" bir oturum gösteriyordu.

### Baseline reproducer (düzeltme öncesi, bu oturumda ölçüldü)

`/tmp/tz64-baseline-probe.mjs` — gerçek `createSessionManager`, sahte provider
socket'i, sahte auth boundary'si:

```json
{"probe":"provider_reject","threw":"WhatsApp provider logout failed: provider down","status":"CONNECTED","is_active":true,"socket_present":true,"logout_calls":1,"end_calls":0,"clear_auth_calls":0,"set_active":[]}
{"probe":"provider_timeout_250ms","settled":"pending","status":"CONNECTED","socket_present":true,"logout_calls":1,"end_calls":0,"clear_auth_calls":0}
{"probe":"concurrent_logout","settled":["rejected","rejected"],"status":"CONNECTED","logout_calls":2,"clear_auth_calls_delta":0}
```

Üç bulgu: (a) reddedilen logout `CONNECTED` bırakıyor ve hiç yerel temizlik
yapmıyor, (b) asılı logout 250 ms'de hâlâ `CONNECTED`/socket bağlı, (c) eşzamanlı
iki logout iki kez provider çağrısı yapıyor.

### Düzeltme sonrası aynı probe

```json
{"probe":"provider_reject","threw":"WhatsApp provider logout failed: provider down","status":"DISCONNECTED","is_active":false,"socket_present":false,"logout_calls":1,"end_calls":1,"clear_auth_calls":1,"set_active":[["tz64-probe-reject",false]]}
{"probe":"provider_timeout_250ms","settled":"pending","status":"DISCONNECTED","socket_present":false,"logout_calls":1,"end_calls":0,"clear_auth_calls":1}
{"probe":"concurrent_logout","settled":["rejected","rejected"],"status":"DISCONNECTED","logout_calls":1,"clear_auth_calls_delta":1}
```

Timeout probe'unda `end_calls: 0` beklenen sonuçtur: `sock.end()` ancak bounded
provider beklemesi (varsayılan 10 s) bittikten sonra çalışır; oturumun kendisi
ise ilk anda `DISCONNECTED`'a çekilip socket referansı koparılır. Yani 250 ms'de
"bağlı görünen" bir oturum yoktur.

---

## 3. Değişen dosyalar (6.4)

| Dosya | Değişiklik |
|---|---|
| `whatsapp-gateway/src/session-manager.js:462-511` | `PROVIDER_LOGOUT_TIMEOUT_MS` (10 s), `logoutProviderWithTimeout`, `buildLogoutError` (`logoutReason` = `provider`/`cleanup`, `localStatus`, `providerError`, `cleanupErrors`) |
| `whatsapp-gateway/src/session-manager.js:895-1057` | `logoutSession` coalescing wrapper + `_logoutSessionOnce`: durum ilk anda `DISCONNECTED`, bounded provider çağrısı, her durumda eski socket teardown, generation-guard'lı yerel temizlik, provider/cleanup hatalarının ayrı raporlanması, tamamlanmış logout işareti |
| `whatsapp-gateway/src/session-manager.js:4959-4962` | Yeni bağlantı denemesi (`_connectSocket` → `beginAttempt`) `_logoutCompleted`/`_logoutProviderError` işaretlerini sıfırlar; yeni oturumda logout yeniden gerçek teardown yapar |
| `whatsapp-gateway/src/index.js:351-367` | Logout 500 gövdesine `local_status` ve `reason` eklendi; `local_status`/`reason` `error`'dan **önce** yazılır (backend gövdeyi 300 karakterde kesiyor) |
| `backend/app/services/whatsapp/gateway/errors.py:15-36` | `gateway_logout_local_status(exc)` — 5xx gövdesindeki `local_status`'u güvenli biçimde okur; hatayı başarıya çevirmez |
| `backend/app/services/whatsapp/gateway/__init__.py:9` | Yeni helper export'u |
| `backend/app/services/whatsapp/orchestration/sessions.py:1150-1190` | `logout_session`: sağlayıcı hatası + `local_status == "DISCONNECTED"` ise satır kalıcı olarak DISCONNECTED yapılır ve hata **yeniden fırlatılır**; bilgi yoksa satır ellenmez (fail-closed) |
| `whatsapp-gateway/tests/test-logout-state-consistency-64.mjs` | Yeni A–G + cleanup-hatası harness'ı (510 satır) |
| `backend/tests/test_whatsapp_logout_state_64.py` | Yeni backend sözleşme + gerçek yerel DB testleri (250 satır) |
| `whatsapp-gateway/package.json` | 6.4 testi `npm test` zincirine kaydedildi |

6.3 credential write kuyruğuna dokunulmadı. Logout yolu kuyruğu okumaz/yazmaz;
`shutdown()` üzerindeki mevcut flush entegrasyonu da değiştirilmedi.

---

## 4. Başarı / başarısızlık logout durum akışları

### 4.1 Sağlayıcı logout başarılı

1. Generation invalidate edilir, socket referansı koparılır.
2. `status=DISCONNECTED`, `is_active=false`, `is_phone_online=false` **senkron** yazılır.
3. Lease release edilir.
4. `sock.logout()` bounded çağrı ile tamamlanır.
5. Eski socket listener'ları kaldırılır, `end()` çağrılır.
6. Pending LID, contact cache, retry cache, history fetch'leri temizlenir; auth
   temizlenir, `session_active=false`, session dizini silinir.
7. Tek `session_disconnected` yayını yapılır.
8. `getSession(id)` döner (HTTP 200 `{success:true,...}`).

Bu davranış 6.4 öncesiyle aynıdır (mevcut API kontratı korunur).

### 4.2 Sağlayıcı logout reddeder

1–3 ve 5–7 aynı şekilde çalışır; hata yalnızca 4. adımda yakalanır.
8. Gateway HTTP 500 döner:
   `{"success":false,"local_status":"DISCONNECTED","reason":"provider","error":"..."}`.
9. Backend gövdedeki `local_status`'u görür: satırı DISCONNECTED yapar, commit
   eder ve hatayı **yeniden fırlatır** → endpoint 502 döner. Başarı raporlanmaz.
10. `session_disconnected` yayını backend'e gittiği için diğer sekmeler kopuşu
    yine öğrenir; yalnızca isteği yapan istemci hata görür.

### 4.3 Sağlayıcı logout zaman aşımı

- 10 s (çağrı bazında `providerLogoutTimeoutMs` ile değiştirilebilir) sonunda
  `PROVIDER_LOGOUT_TIMEOUT` üretilir; yerel teardown aynen tamamlanır.
- Oturum ilk await'ten önce `DISCONNECTED` olduğundan bekleme sırasında bile
  "bağlı" görünmez. Geç dönen provider promise'i durumu değiştiremez.

### 4.4 Yerel temizlik hatası

- Örn. `clearAuth` patlarsa `logoutReason="cleanup"`, `localStatus="DISCONNECTED"`.
- Mesaj hem provider hem cleanup hatasını içerebilir; `providerError` ve
  `cleanupErrors` ayrı alanlardır.
- Temizlik hatası `force` ile bile gizlenmez (coalescing wrapper yalnızca
  `reason=provider` + `localStatus=DISCONNECTED` durumunu force ile geçirir).

### 4.5 Logout sırasında yeni bağlantı (superseded)

- Provider çağrısı sürerken `beginAttempt()` ile yeni generation başlarsa,
  logout'un yerel temizliği **atlanır**: yeni socket kapatılmaz, yeni
  credential'lar/session dizini silinmez, `session_disconnected` yayınlanmaz.
- Eski socket'in teardown'u yine yapılır; yalnızca eski socket kapanır.

### 4.6 Idempotency

- Eşzamanlı çağrılar tek in-flight promise'i paylaşır (tek provider çağrısı,
  tek temizlik, tek event).
- Tamamlanmış logout tekrar çağrılırsa yeni teardown/event üretmez.
- Provider hatasıyla tamamlanmış logout `force` olmadan tekrar çağrılırsa aynı
  provider hatası yeniden raporlanır (yanlış başarı üretilmez); `force=true`
  açık kabul anlamına gelir ve başarı döner.
- Yeni bağlantı denemesi işaretleri sıfırladığı için sıradaki logout yeni
  socket'e karşı gerçek teardown yapar.

---

## 5. Yarış / durum testleri

Dosya: `whatsapp-gateway/tests/test-logout-state-consistency-64.mjs`
Komut:

```bash
node --import ./tests/lid-durability-test-register.mjs \
     tests/test-logout-state-consistency-64.mjs
```

Sonuç: **8/8 pass**.

| Test | Doğrulanan |
|---|---|
| A — başarılı logout | `DISCONNECTED`, `is_active/is_phone_online=false`, socket `end` 1, `clearAuth` 1, `setSessionActive(false)` 1, dizin silindi, tek event, tekrar çağrı idempotent |
| B — provider reddi | Hata fırlar, `reason=provider`, `localStatus=DISCONNECTED`; yerel temizlik tamam; tekrar çağrı aynı hatayı verir, provider tekrar çağrılmaz; `force` başarı döner |
| C — provider timeout | 40 ms bound ile <2 s'de döner; `timed out` mesajı; `DISCONNECTED`; socket ended; auth/dizin temiz; geç resolve durumu bozmaz |
| D — logout sırasında socket close | **Gerçek `bindSocketEvents` close handler'ı** 401 close event'i alır; generation stale olduğu için yok sayılır: ikinci `clearAuth`/`end` yok, reconnect timer yok, tek event |
| E — logout/reconnect yarışı | Yeni generation'ın socket'i bağlı kalır, `end` edilmez, credential'lar/session dizini korunur, `_logoutCompleted` işaretlenmez, eski socket kapanır |
| F — eşzamanlı logout | İki çağrı tek promise'i paylaşır: provider 1, `clearAuth` 1, event 1, iki çağrı da aynı oturum nesnesini döner |
| G — oturum izolasyonu | A'nın provider hatası B'yi etkilemez (B `CONNECTED`, socket/auth dokunulmaz); B sonra normal logout olur |
| cleanup hatası | `reason=cleanup`, `providerError=null`, oturum DISCONNECTED, işaretlenmez; retry temizliği tamamlayıp başarı döner |

---

## 6. Mock testleri vs gerçek yerel storage/DB doğrulaması

### Mock sınırlar (L3)

- Gateway testleri: sahte provider socket'i (`logout/end/ev`), sahte
  `authRepository`, boş sonuç dönen sahte pool. Gerçek `session-manager` ve
  gerçek `bindSocketEvents` kodu çalışır.
- Backend birim testleri (5 adet): `AsyncMock` DB; yalnızca orchestration
  sözleşmesi (persist et + re-raise / fail-closed).

### Gerçek yerel DB

| Test | Ortam | Sonuç |
|---|---|---|
| `test_real_db_persists_reconciled_state_and_isolates_sessions` | Gerçek SQLite dosyası `/tmp/tz63_regression.db` (provision edilmiş) | PASS |
| Aynı test | Gerçek yerel **PostgreSQL 17.11**, izole `tezlify_62_isolated` (`postgresql+asyncpg://isatezcan@localhost:5432/tezlify_62_isolated`) | PASS |
| Backend dosyası toplamı | SQLite: 6/6, PostgreSQL: 6/6 | PASS |

Gerçek DB testi iki satır oluşturur; yalnızca A'ya provider-failure gövdesi
uygular; A'nın `DISCONNECTED/is_active=False/is_phone_online=False`, B'nin
`CONNECTED` kaldığını **yeniden bağlanıp SELECT ederek** doğrular. Test sonunda
satırlar silinir.

Not: PostgreSQL koşumunda `AsyncSessionLocal`'ın başka event loop'a bağlı
pooled bağlantıları karıştırmaması için test kendi loop-local `NullPool`
engine'ini kurar; bu yalnızca test altyapısıdır, üretim kodunu değiştirmez.

### L4 iddiası yok

Gerçek bir WhatsApp hesabına/provider'a bağlanılmadı. Provider davranışı
tamamen sahte socket ile simüle edildi; bu nedenle **L4 kanıtı iddia
edilmemektedir.**

---

## 7. Regresyon sonuçları (6.1–6.3 + komşu suite'ler)

| Suite | Komut / ortam | Sonuç |
|---|---|---|
| 6.1 pending LID | `node --import ./tests/lid-durability-test-register.mjs tests/test-lid-pending-durability-61.mjs` | **19/19 pass** |
| 6.3 credential write | `TZ63_PG_MODULE_URL=... TZ63_PG_URL=... node --import ./tests/credential-write-test-register.mjs tests/test-credential-write-durability-63.mjs` (gerçek PG17) | **13/13 pass** |
| 6.2 reconciliation + WhatsApp orchestration | pytest: `test_whatsapp_session_scoped_lid_reconciliation_62.py`, `test_whatsapp_orchestration_sessions.py`, `test_whatsapp_session_delete_lifecycle.py`, `test_whatsapp_gateway_boundary.py`, `test_whatsapp_relink_required.py`, `test_whatsapp_logout_state_64.py` (SQLite) | **71 passed** |
| Media stub suite'leri | `test-media-store-integrity`, `test-media-routes-543`, `test-media-ingestion-atomicity-545`, `test-media-session-dedupe-547` | 65 + 40 + 39 + 50 assertion, hepsi geçti |
| History resilience | `node --import ./tests/lid-durability-test-register.mjs tests/test-history-resilience.mjs` | **5/5 pass** |
| Backend tam suite | `pytest backend/tests/ -q` (SQLite) | **2223 passed, 4 skipped, 2 error** |

Tam suite'teki 2 error, bilinen worktree baseline'ıdır:
`test_whatsapp_phase2_a_gateway_behavior.py` gateway harness'ı Node ile
`ERR_MODULE_NOT_FOUND: Cannot find package 'uuid'` alır çünkü bu worktree'de
`node_modules` yoktur. Kod regresyonu değildir; 6.3'te de aynı sınıftaydı.

6.3 credential write kuyruğu ve shutdown flush testleri (`G2`, `socket:saveCreds`
dahil) 13/13 içinde geçti; 6.4 logout değişikliği kuyruğa dokunmadı.

---

## 8. Çalıştırılmayan testler ve nedenleri

1. **Gerçek Baileys script'leri** (`scripts/test-post-qr-sync-state-machine.mjs`,
   `scripts/test-orphan-session.mjs`, `scripts/test-quoted-message-extraction.mjs`,
   `scripts/test-view-once-extraction.mjs` ve `npm test` zincirinin tamamı):
   worktree'de `node_modules` yok; brief gereği bağımlılık kurulmadı. Hepsi
   `ERR_MODULE_NOT_FOUND` ile durur. (Stub tabanlı testler çalıştırıldı.)
2. **Gateway logout HTTP route'unun uçtan uca testi**: `src/index.js` import
   edildiğinde Express app + DB başlatma yan etkileri vardır ve worktree'de
   express/pg yok. Gövde alanları (`local_status`, `reason`) ve backend
   parser'ı ayrı ayrı test edildi; alan adları kod incelemesiyle eşleştirildi.
3. **Gerçek WhatsApp provider bağlantısı**: kapsam dışı ve yasak; L4 yok.

---

## 9. Bilinen limitasyonlar / notlar

1. **Timeout'ta provider unlink sonucu bilinmez.** 10 s'de dönmeyen
   `sock.logout()` için cihazın telefondan kaldırılıp kaldırılmadığı
   doğrulanamaz; yerel oturum güvenle kapatılır ve hata görünür kalır.
2. **Tekrarlanan non-force logout provider hatasını yeniden raporlar.** Bu,
   "başarısız logout başarı olarak bildirilmez" kuralının bilinçli sonucudur;
   `force=true` veya yeni bağlantı denemesi bu durumu temizler.
3. **`force` semantiği korundu**: provider hatasını açıkça kabul edip başarı
   döner; yerel temizlik hatasını asla gizlemez.
4. **HTTP durum kodu değişmedi**: gateway 500, backend 502 (mevcut kontrat).
5. **Gövde 300 karakterde kesiliyor**: `local_status`/`reason` `error`'dan önce
   yazılarak uzun provider mesajlarının reconciled durumu gizlemesi engellendi.
6. **10 s sabiti** modül içindedir; çağrı bazında `providerLogoutTimeoutMs`
   ile override edilebilir, fakat ortam değişkeniyle yapılandırılamaz (gereksiz
   yeni yapılandırma eklenmedi).
7. **`deleteSession` değiştirilmedi**: silme yolu zaten provider hatasında
   yerel teardown'a devam edip satırı siliyordu; kapsam dışı bırakıldı.
8. **Baileys 440 / reconnect mantığı, credential write mekanizması, backend
   restart sync job, LID reconciliation, frontend ve kampanya/outreach**
   değiştirilmedi.

---

## 10. Karar

`PASS_WITH_NOTES`

Gerekçe: P1-2'nin üç belirtisi (reddedilen logout'da `CONNECTED`, asılı
logout'da `CONNECTED`, eşzamanlı çift teardown) deterministik olarak
giderildi; sağlayıcı hatası ile yerel temizlik hatası ayrıştırıldı; backend
reconciled durumu gerçek SQLite ve gerçek izole PostgreSQL 17 üzerinde kalıcı
kıldı ve hatayı başarıya çevirmedi. Notlar: gerçek provider bağlantısı
kullanılmadığı için L4 iddia edilmiyor; worktree'de `node_modules` olmadığından
bazı gerçek-Baileys script'leri ve gateway route uçtan uca testi çalıştırılamadı;
timeout'ta provider unlink sonucu doğası gereği bilinmez.
