# AŞAMA 6.4-R — WhatsApp 6.1–6.4 Release Hazırlığı, Commit, Push ve Production Deploy

**Tarih:** 2026-11-03
**Worktree:** `/private/tmp/tz429-release`
**Branch:** `release/backend-only-seq-safety`
**Başlangıç HEAD:** `978ddf56877cd7aad7d2f30b095b6232e34802d2`
**Bitiş HEAD (yerel = origin = production):** `e34e3ff5cf01dd201b92697edd77ee3fb9c174e0`

**Karar: `PASS_WITH_NOTES`**

6.1–6.4 kapsamındaki doğrulanmış değişiklikler tek commit'te ayrıştırıldı, test edildi,
push edildi ve resmi sunucu-taraflı süreçle production'a alındı. Campaign Media 5.4
zinciri (5.4.13 = RELEASE_BLOCKED) commit'e, push'a ve deploy'a **dahil edilmedi**;
çalışma ağacında korunuyor. Notlar: L4 gerçek WhatsApp E2E yapılmadı; gateway recreate
RAM geçmişini boşalttı; DB geri dönüşü yalnızca dump ile manueldir.

---

## 1. Başlangıç Durumu

| Öğe | Değer |
|---|---|
| Worktree | `/private/tmp/tz429-release` |
| Branch | `release/backend-only-seq-safety` |
| HEAD | `978ddf5` — `fix(whatsapp): use portable timeout return type` |
| Staged | 0 |
| Dirty/untracked | 14 modified + 18 untracked (`reports/` dahil) |
| Production sürümü | `978ddf5` (`.deployed-commit`) |
| Production backend imajı | `sha256:f48d062394c91b636e2b8349fff020ca824a8a2b49573b10999887bebace50c4` |
| Production gateway imajı | `sha256:123807e5b1ebfdc84365ea6d8320d7a4b74a9f1584e28e2923412bb59deaf2c6` |
| Production konteynerleri | backend/gateway "Up 26 hours (healthy)", caddy "Up 3 weeks (healthy)" |
| Production WhatsApp | 1 oturum, `connected=1`, `pending_qr=0`, `orphaned=0` |

Ana repo (`/Users/isatezcan/Documents/Github/Tezlify`), `/private/tmp/tz5324-tzdbk1` ve diğer
worktree'ler üzerinde hiçbir işlem yapılmadı.

---

## 2. Kapsamdaki Aşamalar

| Aşama | İçerik | Karar (kendi raporu) |
|---|---|---|
| 6.1 | LID pending mesajların kalıcı kuyruğa yazılması (durable LID pending) | PASS |
| 6.2 | Oturum kapsamlı (session-scoped) LID reconciliation | PASS |
| 6.3 | Credential write durability (await + FIFO + bounded retry + flush) | PASS_WITH_NOTES |
| 6.4 | Provider logout hatasında orphan `CONNECTED` oturumun düzeltilmesi | PASS_WITH_NOTES |

Kapsam dışı bırakılan ve **dahil edilmeyen** ana blok: Campaign Media 5.4.2–5.4.13.
5.4.13 denetimi `RELEASE_BLOCKED` vermiştir (legacy kanonik referans sahipliği, R-1).

---

## 3. Dahil Edilen Dosyalar (33 dosya, +4378 / −119)

### 3.1 Backend

| Dosya | Aşama | Değişiklik |
|---|---|---|
| `backend/app/core/migrations.py` | 6.1 | `lid_pending_messages` DDL (SQLite + `whatsapp_private` PG) |
| `backend/app/services/whatsapp/reconciliation.py` | 6.2 | Oturum kapsamlı reconciliation |
| `backend/app/services/whatsapp_service.py` | 6.2 | Reconciliation çağrı yolu |
| `backend/app/services/whatsapp/orchestration/sessions.py` | 6.4 | Logout sağlayıcı hatasında `local_status` ile satırı DISCONNECTED'a çekme, hatayı yeniden fırlatma |
| `backend/app/services/whatsapp/gateway/errors.py` | 6.4 | `gateway_logout_local_status` |
| `backend/app/services/whatsapp/gateway/__init__.py` | 6.4 | Helper export |
| `scripts/diagnostics/whatsapp_lid_split_repair.py` | 6.2 | Reconciliation uyumu |
| `backend/tests/test_whatsapp_session_scoped_lid_reconciliation_62.py` | 6.2 | Yeni test |
| `backend/tests/test_whatsapp_logout_state_64.py` | 6.4 | Yeni test |

### 3.2 Gateway

| Dosya | Aşama | Değişiklik |
|---|---|---|
| `whatsapp-gateway/src/lid/pending-lid-repository.js` | 6.1 | Yeni kalıcı kuyruk deposu |
| `whatsapp-gateway/src/events.js` | 6.1 | `{durable}` dönüşü, listener promise'i |
| `whatsapp-gateway/src/socket/socket-events.js` | 6.1 | Açılışta release sweep |
| `whatsapp-gateway/src/session-manager.js` | 6.1/6.3/6.4 | Pending-LID wiring, credential flush, logout coalescing/`_logoutSessionOnce` (yalnızca 6.x hunk'ları) |
| `whatsapp-gateway/src/auth/postgres-auth-repository.js` | 6.3 | Per-session FIFO yazım, bounded retry, flush |
| `whatsapp-gateway/src/socket/socket-connector.js` | 6.3 | `await` + throw + `session.saveCreds` ataması |
| `whatsapp-gateway/src/index.js` | 6.4 | Logout 500 gövdesinde `local_status`/`reason` (yalnızca bu hunk) |
| `whatsapp-gateway/package.json` | 6.1/6.3/6.4 | `test` zincirine yalnızca 6.x suite'leri |
| `whatsapp-gateway/tests/test-lid-pending-durability-61.mjs` | 6.1 | Yeni |
| `whatsapp-gateway/tests/test-credential-write-durability-63.mjs` | 6.3 | Yeni |
| `whatsapp-gateway/tests/test-logout-state-consistency-64.mjs` | 6.4 | Yeni |
| `whatsapp-gateway/tests/lid-durability-test-loader.mjs` / `-register.mjs` | 6.1 | Yeni |
| `whatsapp-gateway/tests/credential-write-test-loader.mjs` / `-register.mjs` | 6.3 | Yeni |
| `whatsapp-gateway/tests/stubs/baileys-lid.mjs`, `baileys-crypto.mjs`, `baileys-credential.mjs`, `pg.mjs`, `pino.mjs`, `qrcode.mjs`, `whatsapp-rust-bridge.mjs`, `ws.mjs`, `uuid.mjs` | 6.1/6.3 | Yeni test altyapısı (`node_modules` yok) |

`uuid.mjs` paylaşılan test altyapısıdır (6.1 ve 6.3 loader'ları kullanır); gerçek `node:crypto.randomUUID` sarmalayıcısıdır.

---

## 4. Hariç Tutulan Değişiklikler ve Ayrıştırma Kanıtı

### 4.1 Hariç tutulanlar (çalışma ağacında korunuyor)

- Backend: `api/v1/endpoints/campaigns.py`, `api/v1/endpoints/whatsapp.py`, `services/campaign_media_service.py`, `services/campaign_runner.py`, `services/link_preview/service.py`, `services/outreach_manager.py`, `services/whatsapp/orchestration/messaging.py`, `services/whatsapp_gateway.py`, `tests/test_campaign_media.py`, `tests/test_whatsapp_live.py` ve 5 yeni medya/kampanya test dosyası.
- Gateway: `src/media/media-store.js`, `src/media/media-routes.js` (yeni), medya test loader/register'ları, 6 medya test dosyası, `tests/stubs/baileys.mjs`, `tests/stubs/baileys-atomic.mjs`.
- `reports/` dizini (tüm raporlar) hiçbir zaman stage edilmedi.

### 4.2 Ayrıştırma yöntemi (ortak dosyalar)

- `session-manager.js`: `git diff -U3` 26 hunk'a ayrıldı; yalnızca 5.4 medya hunk'ları (14–17: `resolveMediaPath`, `verifyMediaIntegrity`, `openVerifiedMedia`, `mediaCapacitySummary`) düşürüldü. Kalan 6.x hunk'ları ayrı bir patch olarak `git apply --cached` ile stage edildi.
- `index.js`: 4 hunk'tan yalnızca logout catch hunk'u alındı (`registerMediaRoutes` importu, `/health media_capacity`, inline medya rotalarının değişimi dışarıda).
- `package.json`: `test` satırı deterministik olarak yeniden kuruldu — HEAD satırı + yalnızca 6.1/6.3/6.4 komutları; 6 medya testi eklenmedi; `json.loads` ile doğrulandı.

### 4.3 Kanıt

- Stage edilen ağaç (`git write-tree` → `git archive`) `/tmp`'ye çıkarıldı ve testler **o ağaçta** koşturuldu; artefakt içinde medya kodu/testi yok.
- Production imajlarında 5.4 yokluğu doğrudan ölçüldü:
  - `docker exec tezlify-gateway test -f /app/src/media/media-routes.js` → `NO`
  - `grep -c registerMediaRoutes /app/src/index.js` → `0`
  - backend `campaign_media_service.py` içinde `authorize_media_reference` → `0`
- `git diff --cached` commit öncesi ve sonrası denetlendi; medya dosyası stage edilmedi.

---

## 5. Test Sonuçları ve Ortamlar

Tüm sonuçlar commit'in **tam ağacı** üzerinde (working tree değil) alınmıştır.

| Suite | Ortam | Sonuç |
|---|---|---|
| 6.1 LID pending durability | Node + stub loader (gerçek `session-manager.js`), SQLite yok | **19/19 pass** |
| 6.3 credential write durability | Node + stub, **gerçek PostgreSQL 17.11** (`tezlify_62_isolated`) | **13/13 pass** |
| 6.4 logout state consistency | Node + stub, gerçek `bindSocketEvents` | **8/8 pass** (A–G + cleanup) |
| 6.4 backend sözleşme + gerçek DB | SQLite | **6/6 pass** |
| 6.4 backend sözleşme + gerçek DB | Gerçek PostgreSQL 17.11 | **6/6 pass** |
| 6.2 + 6.4 backend birlikte | SQLite | **17/17 pass** |
| 6.2 + 6.4 backend birlikte | Gerçek PostgreSQL 17.11 | **17/17 pass** |
| Tam WhatsApp backend regresyonu | SQLite | **1004 passed, 4 skipped, 2 error** |
| Gateway: `test-durable-auth.mjs` | stub loader | 12 assertion pass |
| Gateway: `test-post-qr-sync-state-machine.mjs` | stub loader | 18/18 PASS |
| Gateway: `test-appstate-rearm.mjs` | stub loader | 10 checks PASS |
| Gateway: `test-phone-notifications-presence.mjs` | stub loader | 3 checks PASS |
| Gateway: `test-orphan-session.mjs` | stub loader | 9 checks PASS |
| Gateway: `test-delete-chat-contract.mjs` | stub loader | 12/12 PASS |
| Gateway: `test-history-resilience.mjs` | stub loader | 5/5 PASS |

### 5.1 Bilinen iki hata (yeni regresyon değil)

`test_whatsapp_phase2_a_gateway_behavior.py` içindeki iki test:

- `test_hydrated_group_broadcast_reaches_frontend`
- `test_hydrated_group_persists_via_real_ingestion`

Her ikisi `ERR_MODULE_NOT_FOUND: Cannot find package 'uuid'` ile düşer. Nedeni worktree'de
`node_modules` olmamasıdır; aynı hata baseline `978ddf5` üzerinde de vardır. Brif gereği
bağımlılık kurulmadı/güncellenmedi.

### 5.2 Ortam sınırları

- Gerçek WhatsApp/QR/provider bağlantısı **kullanılmadı**; L4 iddia edilmiyor.
- Tam `npm test` zinciri worktree'de `node_modules` olmadığı için koşturulamadı; her 6.x suite'i kendi loader'ı ile çalıştırıldı.
- PostgreSQL doğrulamaları yerel izole `tezlify_62_isolated` üzerinde yapıldı; production DB'ye test yazımı yapılmadı.

---

## 6. Commit

| Alan | Değer |
|---|---|
| Hash | `e34e3ff5cf01dd201b92697edd77ee3fb9c174e0` |
| Tree | `8e5f14cb8dca538f14a43aee1d5b95d69ea84e00` |
| Mesaj | `fix(whatsapp): consolidate core reliability fixes` |
| Yazar / tarih | isatezcan444 — 2026-11-03 21:41:40 +0300 |
| Kapsam | 33 dosya, +4378 / −119 |
| Ebeveyn | `978ddf5` |

Commit sonrası `git diff --cached` boş; stage edilmemiş fark 14 dosya +1440/−161 (5.4
zinciri) olarak korundu.

---

## 7. Push

- `git push origin release/backend-only-seq-safety`
- Sonuç: **fast-forward `978ddf5..e34e3ff`**, force **kullanılmadı**
- `git ls-remote origin release/backend-only-seq-safety` → `e34e3ff5cf01dd201b92697edd77ee3fb9c174e0`
- Beklenmeyen uzak commit/çakışma yok.

---

## 8. Production Deploy

### 8.1 Süreç (resmi, sunucu tarafı)

`local release.sh` bu branch için kullanılamaz (SHA'nın `origin/main` atası olması ve temiz
worktree şartı). Resmi yol kullanıldı: sunucuda `run_release.sh` → hedef commit'in
`host-release.sh` dosyasını blob kimliğiyle doğrulayıp çalıştırır.

| Adım | Sonuç |
|---|---|
| `run_release.sh --verify-only` (`--expected-self-blob 9284245f…`) | **exit 0** — `script-version-guard: IZINLI`, self=target=`f2b7a9ae…` |
| `--dry-run` (fetch + migration guard + plan) | **exit 0** — cutover servisleri `backend gateway` |
| Migration guard (`978ddf5..e34e3ff`) | **temiz** — yıkıcı SQL yok, `--allow-migrations` gerekmedi |
| Deploy (`run_release.sh e34e3ff`) | **exit 0**, süre ~2 dk |

Deploy öncesi taze yedek:

- Dump: `/opt/tezlify/backups/postgres/tezlify_20261103T184717Z_p64r_pre.dump` (3,890,454 B)
- SHA-256: `e460c707728a29d5f8b072dcd666d1d109840bf3eeccb3db73178e7f25b03359`
- Off-host kopya: `~/.tezlify-recovery/postgres/` — **aynı SHA-256** doğrulandı

Deploy sırası (script çıktısından):

1. `/opt/tezlify` `e34e3ff`'e normalize edildi (sunucu checkout'unda tracked kirli dosya yoktu; `git reset --hard` resmi prosedürün parçasıdır, yalnızca sunucuda çalıştı).
2. Backend + gateway imajları canlı sistem çalışırken build edildi.
3. İzole aday DB (`tezlify_cand_20261103T184732Z`, 42 tablo) kuruldu; aday `PORT=8001`, gateway kapalı, `WHATSAPP_MEMORY_PERSIST_ENABLED=false` (açıkça doğrulandı) ile kaldırıldı → `/health` 200.
4. Aday penceresinde production sayımı değişmedi: `129|10571|1540` (izolasyon kanıtı); aday DB drop edildi.
5. Cutover: `compose up -d --force-recreate backend gateway` (gateway ağacı değiştiği için `--no-gateway` yasak).
6. Backend 180 s içinde healthy; etkin kalıcılaştırma kill-switch `false`.
7. İmaj kimliği, canlı dosya hash'leri ve public `/health` doğrulandı.
8. `release.json` ve `.deployed-commit` en son yazıldı.

### 8.2 Deploy kaydı

- Release dizini: `/opt/tezlify/backups/releases/20261103T184732Z/`
- `release.json`: `released_at=2026-11-03T18:50:03Z`, `gateway_touched=true`, `frontend=null`, `migrations.approval=clean`, `candidate_health=ok`, `schema_changed=false`
- Adayta koşan migration satırı: **25** (`migration-summary.txt`)

---

## 9. Deploy Edilen Sürüm

| Alan | Değer |
|---|---|
| Commit | `e34e3ff5cf01dd201b92697edd77ee3fb9c174e0` |
| `.deployed-commit` | `e34e3ff5cf01dd201b92697edd77ee3fb9c174e0` |
| `/opt/tezlify` HEAD | `e34e3ff fix(whatsapp): consolidate core reliability fixes` |
| Backend imajı | `sha256:7e304e1cbb2d203465972e745771e6ab74e35e0a427e89c94ba66c7bfd24d2a2` |
| Gateway imajı | `sha256:d1d92933e51f9230202b195c54c077560e42d1bd2dba3d30b11f4af63b84cba2` |
| Frontend | **değiştirilmedi** (6.x frontend'e dokunmuyor; tarball verilmedi) |

### 9.1 Canlı dosya kimliği

`host-release.sh` doğrulamaları: `events.py`, `reactions.py`, `whatsapp-gateway/src/session-manager.js` — hepsi git ile aynı.

Ek olarak elle doğrulanan 6.x dosyaları (canlı sha256 = `git show e34e3ff:<yol>` sha256):

```text
OK backend/app/core/migrations.py                              6b5d8eeeab2e
OK backend/app/services/whatsapp/orchestration/sessions.py     b4ba57d1aa69
OK backend/app/services/whatsapp/reconciliation.py              641998864dec
OK backend/app/services/whatsapp_service.py                     831e79947c22
OK whatsapp-gateway/src/socket/socket-connector.js              5095b1653ba8
OK whatsapp-gateway/src/auth/postgres-auth-repository.js        f0c02c34aa08
OK whatsapp-gateway/src/lid/pending-lid-repository.js           bab766fe76ba
OK whatsapp-gateway/src/index.js                                278267fa7349
```

---

## 10. Health Check Sonuçları

| Kontrol | Sonuç |
|---|---|
| Caddy | `healthy`, sertifika yenilemesi normal |
| Public `https://api.…sslip.io/health` | **200** |
| Public `https://app.…sslip.io/health` | **200** |
| Public `https://…sslip.io/` (frontend) | **200** |
| Backend `/health` | `healthy`; `gateway_bridge.connected=true` (18:49:59), `reconnect_count=1` |
| Gateway `/health` | `ok`, `database=connected`, `sessions.total=1`, `connected=1`, `pending_qr=0`, `orphaned=0`, `auto_restore=true` |
| Canlı oturum | `1bd78836-c084-4cbf-b333-9386d44b7bd7` — `CONNECTED`, `is_active=t`, `is_phone_online=t`, `updated_at=18:50:03Z` → **QR gerekmedi** |
| Credential kalıcılığı | `whatsapp_private.session_credentials`: `version=2308`, `updated_at=18:50:03Z` (restore sonrası yazım) |
| Satır sayıları (conversations/messages/contacts) | 129 / 10.571 / 1.540 — deploy öncesi/sonrası **aynı** |
| Konteynerler | backend/gateway/caddy/db `running`, `restarts=0` |
| Backend log taraması (cutover sonrası) | `error|traceback|critical` → **0** |
| Gateway log taraması (cutover sonrası) | `level>=50` → **0**; `session_registry_restored: discovered=1, restored=1`; app-state resync ve outbox akışı normal |
| Kararlılık (d+75 sn) | Oturum bağlı, QR yok, sayımlar aynı, restart yok |

---

## 11. Migration Durumu

- Deploy aralığında **tek yapısal değişiklik**: `whatsapp_private.lid_pending_messages` (6.1).
- Statik guard: yıkıcı satır (`DELETE`/`TRUNCATE`/`DROP`) **yok** → `--allow-migrations` verilmedi.
- Aday container izole kopyada 25 `[MIGRATION]` satırı koştu; kopyada satır sayısı düşmedi (`129|10571|1540`).
- Canlı doğrulama:

```text
to_regclass('whatsapp_private.lid_pending_messages') = whatsapp_private.lid_pending_messages
PK: (session_id, lid_jid, wa_message_id)
Index: ix_wa_lid_pending_created (session_id, created_at)
Check: auth_tag=16B, nonce=12B, key_version>0
Satır sayısı: 0   (yeni tablo)
```

- `schema_fingerprint` `35f90bc7674f` → `35f90bc7674f` **değişmedi**: parmak izi çekirdek
  public tabloları kapsıyor; yeni tablo `whatsapp_private` şemasında olduğu için ayrıca
  yukarıdaki doğrudan sorguyla kanıtlandı.
- Tablo yalnızca eklemelidir; mevcut tablolara/kolonlara dokunulmadı, veri silinmedi.

---

## 12. Bilinen Riskler ve L4 Boşluğu

1. **L4 yok.** Gerçek WhatsApp hesabıyla gönderim/alım/logout E2E yapılmadı. Kanıt düzeyi
   L3 (stub + gerçek `session-manager`/`bindSocketEvents`) + gerçek PostgreSQL/SQLite.
2. **Gateway recreate RAM geçmişini boşalttı** (invariant A6). Oturum otomatik geri yüklendi
   (`restored=1`, `pending_qr=0`), app-state resync koştu ve outbox akıyor; ancak gateway'in
   bellek içi sohbet/mesaj geçmişi kısmen yeniden doldurulacak. DB verisi etkilenmedi.
3. **DB geri dönüşü yok.** `--rollback-to` yalnızca imaj etiketlerini ve frontend dizinini
   geri alır. Veritabanı geri dönüşü dump'tan manuel restore gerektirir ve dump sonrası
   yazılanlar kaybolur.
4. **İki bilinen test hatası** (`uuid` modülü yok) baseline'da da vardır; yeni regresyon değildir.
5. **6.3 retry gecikmesi:** `creds.update` en kötü durumda ~400 ms ek gecikme yaşayabilir
   (bounded, oturum başına ayrı).
6. **6.4 timeout belirsizliği:** 10 s'de dönmeyen `sock.logout()` için cihazın telefondan
   kaldırılıp kaldırılmadığı doğrulanamaz; yerel oturum güvenle kapatılır ve hata görünür kalır.
7. **Campaign Media 5.4 hardening production'da YOK** — bilinçli: 5.4.13 `RELEASE_BLOCKED`.
   Bu, release'in kapsamı dışıdır; ayrı bir aşamada ele alınmalıdır.

---

## 13. Rollback Bilgileri

| Öğe | Değer |
|---|---|
| Etiketler | `tezlify-backend:pre-20261103T184732Z`, `tezlify-gateway:pre-20261103T184732Z` |
| Kod geri dönüşü | `bash /opt/tezlify/scripts/deploy/host-release.sh --rollback-to 20261103T184732Z` |
| Not | `run_release.sh` `--rollback-to` kabul etmez (ilk argümanı SHA sanar); geri dönüş doğrudan `host-release.sh` ile yapılır. Checkout artık `e34e3ff` olduğu için script blob'u hedefle aynıdır. |
| Önceki imajlar | backend `sha256:f48d0623…`, gateway `sha256:123807e5…` |
| Release kaydı | `/opt/tezlify/backups/releases/20261103T184732Z/release.json` |
| DB yedeği | `/opt/tezlify/backups/postgres/tezlify_20261103T184717Z_p64r_pre.dump` — SHA `e460c707728a29d5f8b072dcd666d1d109840bf3eeccb3db73178e7f25b03359` |
| Off-host kopya | `~/.tezlify-recovery/postgres/tezlify_20261103T184717Z_p64r_pre.dump` — aynı SHA |
| DB geri dönüşü | Manuel restore; kod geri dönüşüne **dahil değildir** |

Geri dönüş de gateway'i yeniden oluşturacağı için oturum tekrar RAM'den yüklenir; QR riski
kod deploy'undakiyle aynıdır.

---

## 14. Korunan Diğer Değişiklikler

- `/private/tmp/tz429-release`: 14 modified + 19 untracked (`reports/` tek satır), **staged 0**,
  stage edilmemiş fark 14 dosya +1440/−161 — Campaign Media 5.4.2–5.4.13 çalışması aynen duruyor.
- `/Users/isatezcan/Documents/Github/Tezlify` (ana worktree): **dokunulmadı**.
- `/private/tmp/tz5324-tzdbk1` ve diğer worktree'ler: **dokunulmadı**.
- Yasaklı komutlar (`git reset`, `git clean`, `git stash`, `git checkout`, `git switch`,
  `git rebase`, `git merge`, `git add .`, `git add -A`) release worktree'sinde **kullanılmadı**.
  Sunucudaki `git reset --hard` resmi `host-release.sh` prosedürünün parçasıdır ve yalnızca
  `/opt/tezlify` checkout'unda çalıştı; orada tracked kirli dosya yoktu.
- Bağımlılık kurulmadı/güncellenmedi; production DB'de test satırı oluşturulmadı; WhatsApp
  oturumu/credential/mesaj silinmedi.

---

## 15. Karar

**`PASS_WITH_NOTES`**

6.1–6.4 değişiklikleri güvenli biçimde ayrıştırıldı, tam ağaç üzerinde test edildi, tek
commit olarak push edildi ve resmi sunucu-taraflı süreçle production'a alındı. Migration
eklemeli, veri kaybı yok, oturum otomatik geri yüklendi ve tüm sağlık kontrolleri geçti.
Notlar: L4 gerçek WhatsApp E2E yapılmadı, gateway RAM geçmişi boşaldı, DB geri dönüşü manuel
dump'a bağlı, iki bilinen `uuid` test hatası baseline'da da mevcut ve Campaign Media 5.4
zinciri bilinçli olarak bu release'in dışında tutuldu.

**Sonraki aşamaya geçilmedi.**
