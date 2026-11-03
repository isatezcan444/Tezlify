# Tezlify — Proje Elden Çıkarma (Handoff) Dosyası

> **Amaç:** Bu dosya, Tezlify projesinde bugüne kadar yapılan çalışmaların tek ve öz-yeterli
> (self-contained) özetidir. Başka bir yapay zekaya verildiğinde, projeyi, kritik yasakları,
> değişmezleri (invariants), aşamaları ve mevcut durumu anlayabilmesini sağlamak için yazılmıştır.
> Detaylar referans dosyalarında; burada en kritik bilgiler gömülüdür.

---

## English abstract (for any AI)

**Tezlify** is a WhatsApp-CRM + disaster-recovery system (Python/FastAPI backend, Node.js WhatsApp
gateway, React/TS frontend). The work to date has been a long **safety/integrity hardening** effort
after a near-total production WhatsApp-message loss.

**Hard rules — never violate:**
1. Deleting a WhatsApp *line* (`DELETE /sessions/{id}`) cascades and is **permanent data loss**.
2. **No backup covers WhatsApp messages** (`archive_mode=off`, no PITR). Rollback = restore to a scratch DB
   and *count rows*; dump size proves nothing.
3. **Deploy only via `scripts/deploy/host-release.sh`** (run the *target's* copy with
   `--expected-self-blob <blob> <ref> --no-gateway`); never hand-reset `/opt/tezlify`. `.deployed-commit`
   is the authority. **Push ≠ deploy.**
4. Every deploy runs **startup migrations that can DELETE rows** (`migrations.py`), even with 0 SQL/alembic
   files. The script warns (`ONCEDEN VAR OLAN mesaj kayboldu`) and still exits 0.
5. **Gateway recreate = loss of its RAM store** (messages that exist nowhere else). Recreate only
   backend-first, then verify persistence, then gateway.
6. Persistence kill-switch opens **only** on `true`/`1`. Never enable it permanently. Never print the
   encryption key.
7. **Never run pytest against the dev/prod DB.** Use the isolated PostgreSQL 17 harness; export BOTH
   `DATABASE_URL` and `TEST_DB_PATH`.

**Current state (2026-10-31):** AŞAMA **4.8** (production baseline reconciliation) is complete and
**stopped before 4.9** — no commit/push/deploy/restart/loop.

**Measured facts that supersede earlier assumptions:**
- Real deployed commit is **`cbe4f509`** (release `backend-only 3.8.7`), **not** `b5715fe`. Verified by
  hashing the four backend files *inside the running container* (4/4 match `cbe4f509`).
- `memory_persistence.py` **is deployed**. It was introduced at **`bafe5b0`** (2026-10-28 16:23) and the path
  is genuinely absent at `b5715fe` — not a defect, `b5715fe` (10-28 01:13) is simply **older**. Production
  runs `cbe4f509` from branch `release/backend-only-3.8.7`, which contains `bafe5b0`. 4.7 is an *update*,
  not a first deploy.
- The gateway is **frozen** at `b5715fe`-era content (`a1ba2572` image, started 2026-10-27T17:25:57Z)
  and does **not** emit `pagination` (live `/messages/bulk` → `pagination=YOK`).
- **RAM-only messages = 0** (RAM 9163 / DB 9196 / DB-only 33) ⇒ a gateway recreate would currently
  lose nothing. Re-measure immediately before any gateway deploy.
- The 33 `contacts.py:101` failures **do not reproduce**; the full backend suite is 2174 passed.
- 4.7's authoritative suite is **36 passed**; backend 2174 passed at fixed order + seeds
  424242/777/900913; PG audit (tz44+tz46, updated) **18 passed**; gateway/frontend gates green.

**Verdict: READY WITH CONDITIONS.** See `docs/audits/ASAMA-4.8-production-baseline-reconciliation.md`.
The worktree still carries **untouched 3.9.19 escrow pollution** (15 files, zero overlap with 4.7's 12).

---

## 0. Bu dosya nasıl kullanılır

- **Yeni bir oturuma başlarken** bu dosyayı oku → sonra referans dosyalarına (§12) in.
- **Üretime dokunmadan önce** mutlaka §2 (Yıkılmaz Kurallar) ve §5 (Ops) bölümlerini oku.
- **Dağıtım yapacaksan** §9 (mevcut worktree) ve §10 (nasıl devam edilir) bölümlerini oku.
- Tüm iddiaların arkasında bir ölçüm vardır; detay `reference/` ve günlük (YYYY-MM-DD.md) dosyalarındadır.

---

## 1. Proje nedir (Tezlify)

- **WhatsApp CRM + felaket kurtarma (disaster recovery)** sistemi.
- **Backend:** Python / FastAPI (`backend/`), PostgreSQL (prod), SQLite (test fallback).
- **Gateway:** Node.js (`whatsapp-gateway/`) — WhatsApp Web protokolü üzerinden mesaj alır, RAM'de tutar,
  backend'e "memory persistence" yoluyla kalıcılaştırır. Gateway port **8787**; container'da `curl` yok,
  probe `node` ile yapılır.
- **Frontend:** React/TS (`frontend/`), kullanıcı arayüzü + admin.
- **Çekirdek risk:** Üretimde WhatsApp mesajları **yalnızca gateway RAM'i + backend DB'de**; şifreli
  off-site escrow ve RAM snapshot'ları felaket kurtarma içindir, günlük işletim yedeği değildir.
- **Dağıtım:** Oracle `130.162.247.20`, `/opt/tezlify`, user `ubuntu`, SSH `~/.ssh/id_tezlify_oracle`.
  Compose `docker-compose.prod.yml` yalnız `backend`, `gateway`, `caddy` bildirir; **`db` compose'da DEĞİL**.

---

## 2. YIKILMAZ KURALLAR — harekete geçmeden ÖNCE OKU

Bu maddeler ihlal edilirse **geri alınamaz veri kaybı** olur. (Kaynak: `MEMORY.md` "Irreversible damage".)

- **Bir hattı silmek = veri kaybı, "bağlantıyı kesmek" değil.** `DELETE /sessions/{id}` o hattın
  konuşmalarını + mesajlarını kaskat (cascade) siler ve gateway auth dizinini düşürür. Her konuşma bir
  hatta bağlı ⇒ tek bağlı hattı silmek her şeyi siler.
- **WhatsApp mesajlarını hiçbir yedek kapsamaz** (`archive_mode=off`, slot yok, PITR yok). Geri alma
  vaat etmek için scratch DB'ye restore et ve **satır say** — dump boyutu bir şey kanıtlamaz.
- **Yalnız `scripts/deploy/host-release.sh` ile dağıt; asla `/opt/tezlify`'i elle resetleme.**
  `.deployed-commit` otoritedir. **Push = deploy değildir.** Script, `--skip-build` ile bile
  backend+gateway'i force-recreate eder ⇒ **`--no-gateway`** kullan (gateway/compose değişmişse exit 1
  ile REDDEDER). Gateway recreate RAM store'ını kaybettirir (A6).
  **Çalışan script daima ES Kİ (OLD) olanıdır** — 3.8.5'ten beri `host-release.sh` kendi `git hash-object`'ını
  `<target>:…/host-release.sh` ile kıyaslar ve uyumsuzsa **exit 9** verir. Hedefin kopyasını çalıştır:
  `bash scripts/deploy/run_release.sh --expected-self-blob <blob> <ref> --no-gateway`.
- **Reddeden bir guard = engel değil; istediği ref'i build et.** `--no-gateway`, `deployed..TARGET`'i
  kıyaslar; `main` gateway değişiklikleri taşırken backend-only imkânsızdır. Asla zayıflatma:
  `release/backend-only-*` = `main` ağacı, `whatsapp-gateway/` deployed commite revert edilmiş. Preflight:
  `python scripts/deploy/backend_only_release.py --base <deployed> --target <ref>`. **CONTRACT'ı kontrol et:**
  deployed gateway, yeni backend'in gönderdiği her parametreyi destekliyor mu? Bilinmeyen parametreler
  yok sayılır ⇒ sessiz başarısızlık.
- **Dağıtım, satır SİLEN başlangıç migrasyonlarını çalıştırır** (3.8.6, ölçüldü). 3.8.5→3.8.6'da 0
  `*.sql`/alembic dosyası vardı, ama `backend/app/core/migrations.py` her boot'ta çalışır ve **1 ghost LID
  contact + 1 conversation + 9 mesaj** sildi. Script `ONCEDEN VAR OLAN mesaj kayboldu` uyarısını basar ve
  **exit 0** ile çıkar; uyarı bir kapı değildir. Silinen satırlar yalnız gateway RAM'inde
  `CLASS_unmapped_jid` olarak kalır, persistence onları atlar ⇒ gateway recreate kaybı kalıcılaştırır.
  Image rollback = data rollback değildir.
- **Persistence kill-switch yalnız `true`/`1` ile açılır** (3.8.5). `yes`/`on`/`y`/`t` kapalıdır;
  yokluk/boşluk/yazım hatası kapalı ve reddedilir.
- **"LID bridge yok" bir ghost kanıtı değildir — startup asla bunun üzerinden silmemeli** (3.8.7). Eski
  `purge_raw_jid_identity_data` her `phone_e164 LIKE 'jid:%@lid'` satırını (bridge tablosunda karşılık
  yoksa) silerdi ve **failed OPEN**'dı. Şimdi hiçbir şey silmez; `whatsapp_identity_quarantine` yazar ve
  `deleted_* == 0` döner (test edilmiş sözleşme).
- **Asla dev DB'de pytest çalıştırma**; `conftest` localhost olmayan `DATABASE_URL`'i reddeder.
  `TEST_DB_PATH` tek başına yetmez — `settings.DATABASE_URL` pytest'in bağlandığı şeydir; İKİSİNİ DE export et.
- **Dağıtım SIRASI kendisi yıkılmaz hasardır (3.6):** gateway RAM'i başka hiçbir yerde olmayan mesajlar
  tutar. Daima: backend persistence → `messages` / `/health.whatsapp_memory_persistence` doğrula → gateway.
- **Cursor'suz sınırlı bir tur kuyruğu sessizce kaybeder** (3.6b): 10.000 cap'e karşı 9.122 RAM mesajı,
  her tur `offset 0`'dan → kuyruk hiç yazılamaz, hata yok, `/health` yeşil.

---

## 3. Davranışsal değişmezler (Invariants A–T)

Tam liste `reference/whatsapp-subsystem-invariants.md`. En yüksek değerli "tells":

- **A4:** Sohbet listesi sırası = mutlak son mesaj, son *alınan* değil; uint64'e zorla (coerce).
- **A8:** `GET /sessions/{sid}/contacts` bir store sağlık kontrolü DEĞİLDİR.
- **A11:** Boş önizleme (preview) asla `last_message_at`'ı kapamamalı — tell asimetridir.
- **A12:** Metinsiz içerik `[MARKER]` preview body alır, yeni `message_type` değil; **üç etiket tablosu
  (gateway / backend / frontend+locales) parity'de kalmalı**.
- **A14 / T:** LID bridge CONNECTION'a anahtarlanır, kişiye değil — `ws.gateway_id` join'i 4107'de 4 eşleşti;
  yalnız `lid_jid` üzerinden ertele, sahipliği `contacts.user_id`'den al, asla tahmin etme.
- **3.6:** On-demand PDO hatası per-CHAT'tir, per-session değil. "PDO attempted" ≠ "phone returned" —
  `pdo_sent` ile `chunk_received` ayır. **RAM tam olarak DB'deki gibi ise açık yukarıdadır (upstream).**
- **P:** "Sayfada satır var"a göre anahtarlanan bir guard, yapı gereği boş bir sayfa için ÖLÜDÜR — çağıranın
  ne tuttuğunu sor. P'nin fix'i REVERT edildi (`5c1c76d`), canlı `e8a86ee`'de.
- **Q:** Filtrelemeden ÖNCE uygulanan `LIMIT` sabit bir prefix tarar, işi değil.
- **R:** Eksik bir MESSAGE ROW "mesaj yok" iddiasına dönüşmemeli (`UNSYNCED`).
- **S:** PREVIEW bir özet string'idir, mesaj değil — ondan asla satır sentezleme.
- **K:** Archive state "unknown" asla `false` olarak yazılmamalı.

---

## 4. Çapraz kesit mühendislik kuralları (X1–X4)

Tam liste `reference/cross-cutting-rules.md`.

- **X1:** Serializer'ın emit ettiği ama `response_model`'in DECLARE etmediği anahtar cliğe ulaşmaz
  (Pydantic v2 `extra="ignore"`). İki kardeş alan farklı davranıyorsa fark model deklarasyonudur.
- **X2:** Bir kod fix'i pozitif bir cache üzerinde geriye dönük değildir — compute-path fix'ini cache
  invalidation ile eşleştir.
- **X3:** Servis edilen tip BYTE'lardan gelmeli, isimden/client iddiasından değil. Upload'da ve serve'de
  magic-byte sniff; `inline` yalnız jpeg/png/webp, gerisi `attachment` + `X-Content-Type-Options: nosniff`.
  `text/plain`'in magic byte'ı yoktur → `inline` için asla güvenilmez.
- **X4:** Nullable identity kolonunda GLOBAL `unique=True` tenant-isolation bug'ıdır. Doğru şekil:
  kısmi composite index `(user_id, col) WHERE col IS NOT NULL` + her dedup tenant'a göre scope'lu.

---

## 5. Operasyonel hızlı notlar (Ops quick hits)

Tam detay `reference/production-ops.md`.

- **DB erişimi:** `docker exec tezlify-db psql -U tezlify -d tezlify`. Repo kökündeki `tezlify.db` eskidir.
  Gateway container'ında `curl` yok → probe `node` ile (`process.env.WHATSAPP_GATEWAY_SECRET`); API probe'larını
  **üretim konaktan** çalıştır. Gateway REST auth = `Authorization: Bearer <secret>` (NOT `X-Gateway-Secret`).
- **`db` hiçbir compose dosyasında DEĞİL** ⇒ asla `up -d --remove-orphans` (veritabanını siler).
- **`pytest-randomly` yüklü** ⇒ yeni bir module-global cache veya raise edebilen cleanup helper
  sıra-bağımlılığı yeniden getirir. `-p no:randomly` ve dosyayı tek başına tekrar kontrol et.
- **Initial sync yalnız en yeni 50/chat'i kalıcılaştırır** (`_SYNC_PER_CHAT_LIMIT`); eski geçmiş yalnız
  gateway RAM'inde (A6) ⇒ restart, on-demand PDO yanıt vermedikçe ulaşılamaz kılar.
- **Admin ops log temizleme container log dosyasını yerinde TRUNCATE eder** (silmez); inode hayatta kalır.
- **`WHATSAPP_AUTO_RESTORE` üretimde `true`** (2026-10-02 düzeldi). Gateway recreate, her iki
  `gateway_sessions` ve `whatsapp_sessions`'da aktif oturumu `listRestorableSessions()` döndürdükçe
  QR'sız geri yükler. Varsayılma, doğrula.
- Host shell'de `grep "a\|b"` alternation artifact'ı nedeniyle boş döner → Grep aracını veya tekil kalıp kullan.

---

## 6. Test & dağıtım mekaniği (Test & deploy mechanics)

### Test ortamı (yalıtılmış)
- İzole **PostgreSQL 17** (`tezlify_test_47`, genelde port `55434`, cluster `/tmp/tz46-pg/data`). Uzak/prod
  DB'lere bağlanmayı reddeder.
- `conftest.py`: session-scoped autouse `run_db_migrations` (17 `ensure_*` migrasyon),
  `disable_identity_sweep_in_tests`, `reset_whatsapp_module_globals`. `tz44_pgplugin` engine pool'unu
  `NullPool`'a çevirir (asyncpg "different loop" hatasını önler).
- Çalıştırma örneği:
  ```bash
  env -u TEST_DB_PATH \
    DATABASE_URL="postgresql+asyncpg://tezlify@127.0.0.1:55434/tezlify_test_47" \
    PYTHONPATH=/tmp/tz44:. ./venv/bin/python -m pytest \
    /tmp/tz47tests/test_tz47_fixes.py \
    backend/tests/test_whatsapp_memory_persistence.py \
    backend/tests/test_whatsapp_memory_persistence_hardening.py \
    -p tz44_pgplugin -q \
    -o asyncio_default_fixture_loop_scope=session -o asyncio_default_test_loop_scope=session
  ```
- Tabloyu temizleme (gerekirse): `TRUNCATE TABLE <virgülle 32 tablo> RESTART IDENTITY CASCADE;`
  (tablo listesini `pg_tables`ten `paste -sd,` ile al).
- **Production memory-persistence testleri** `_clean_state` fixture'ı yalnız kendi U1/U2 kullanıcılarını
  siler; hardening testlerinin U3 verisi paylaşılan DB'de kalıcı olabilir → kombine koşumlar pollution
  yaratabilir, TRUNCATE ile sıfırla.

### Dağıtım (deploy)
- **Yalnız `scripts/deploy/host-release.sh`** (bkz. §2). Hedefin kopyasını çalıştır:
  `bash scripts/deploy/run_release.sh --expected-self-blob <blob> <ref> --no-gateway`.
- Backend-only gerekiyorsa: `python scripts/deploy/backend_only_release.py --base <deployed> --target <ref>`
  ile `release/backend-only-*` dalı kes, CONTRACT kontrolü yap.
- Dağıtım öncesi: adayın `migration-summary.txt`/`candidate.log`'unu oku ve `migrations.py` içinde `delete(`
  ara (§2).

---

## 7. Aşama geçmişi (Phase history — condensed, measured)

| Aşama | Ne yapıldı | Kanıt / not |
| --- | --- | --- |
| **3.6** | Mesaj kurtarma PDO; deploy sırası felaketi | Gateway RAM 7337 mesaj (başka yerde yok); gateway-before-backend = kalıcı kayıp (A6) |
| **3.8.x** (3.8.1–3.8.9) | Eviction + kill-switch + RAM snapshot + encrypted RAM backup + deploy guard | 3.8.5 guard: script kendi blob'unu kıyaslar, uyumsuzsa exit 9. 3.8.6: 0 SQL ama `migrations.py` 11 satır sildi |
| **3.9.x** (3.9.2–3.9.19) | **Felaket kurtarma / escrow / off-site backup**: canonical key source, OCI instance-principal, fiziksel escrow kopya, saatlik snapshot | Çok sayıda salt-okunur doğrulama; "404 maskesi", "anahtar tırnak temizliği", "deşifreleme ile anchor kanıtı" gibi gerçek hatalar bulundu. **Fiziksel kopya (C) tamamlanmadı** — zamanı gelmedi |
| **4.2** | Acil RAM koruma snapshot'ı (yeni kurtarma noktası) | Üretimde yeni snapshot alındı |
| **4.4** | Dry-run + son güvenlik kapısı (izole PG testleri) | |
| **4.5** | Kontrollü tek seferlik production backfill | YAPILDI |
| **4.6** | Memory persistence safety audit (salt-okunur) | Deploy ≠ HEAD tekrar kanıtlandı (prod `cbe4f509`, host `5cd3eae`, HEAD `7afb540`). Asimetri: canlı yol savepoint'li, toplu yol savepoint'siz. 99/99 PASS (izole PG) |
| **4.7** | **Memory Persistence Core Safety Fix** (bu tur) | 4 kusur kalıcı düzeltildi; 36 yetkili test PASS; worktree'de, dağıtılmadı, 4.8'e geçilmedi |

> Not: 3.9.19 escrow çalışması devam eden bir yan hatadır; 4.7 worktree'inde **kirletme (pollution)** olarak
> mevcuttur (bkz. §9) ama 4.7 kapsamı dışındadır.

---

## 8. Mevcut durum (Current state — 2026-10-31)

- **AŞAMA 4.7 TAMAM** (kod) ama **commit/push/deploy/restart/loop YAPILMADI**. Yerel worktree'de, dağıtıma
  hazır (ama dağıtılmamış).
- **4.7 testleri:** yetkili **36 passed** (11 yeni `test_tz47_fixes.py` + 25 prod
  `test_whatsapp_memory_persistence*.py`). Downstream dokunulan modüller **119 passed**; 33 başarısız =
  önceden-var `contacts.py:101` `dict(custom_attributes)` kusuru (4.7 ile ilgisiz, `git stash` ile kanıtlı).
  tz44(4)+tz46(2) başarısızlık = **eski davranış iddiaları**, 4.7'in düzelttiği hatalı davranışları kodlar →
  superseded, regresyon değil.
- **Durdurma koşulu sağlandı:** 4.8'e kendiliğinden geçilmedi.
- **3.9.19 escrow pollution dokunulmadı** (bkz. §9).

---

## 9. Çalışma ağacı içeriği (What's in the worktree)

`git status` (özet): 4.7 üretim dosyaları **modified**; 3.9.19 escrow dosyaları **untracked/modified**
(kirletme); `2026-10-31.md` memory log **modified**.

**4.7 dosyaları (modified, commit EDİLMEMELİ henüz):**
- `whatsapp-gateway/src/messages/message-store.js` — `_seq`/`seqEpoch`, `ramCapacitySnapshot`, eviction
- `whatsapp-gateway/src/socket/socket-events.js` — `trimChatMessages` + `stampMessageSeq`
- `whatsapp-gateway/src/session-manager.js` — `listAllMessages` seq-modu, `ramCapacitySummary`
- `whatsapp-gateway/src/index.js` — `/health` `capacity`, bulk `afterSeq`/`seqEpoch`
- `backend/app/services/whatsapp/memory_persistence.py` — keyset drain, metrikler, dead_letter
- `backend/app/services/whatsapp/orchestration/sync.py` — `_insert_messages_resilient` + `_insert_messages_one_by_one` (savepoint izolasyonu)
- `backend/app/services/whatsapp_gateway.py` — `list_all_messages` `after_seq`/`seq_epoch`
- `backend/app/main.py` — `/metrics` `whatsapp_memory_persistence`
- `backend/tests/test_whatsapp_memory_persistence.py`, `..._hardening.py` — mock `**kwargs` (test desteği)
- **Delta:** 8 üretim dosyası **+759 / −77** satır.

**Blob ilişkileri (gerçek deployed `cbe4f509` / HEAD `7afb540` / worktree):** Bkz.
`docs/audits/ASAMA-4.7-...-report.md` D bölümü ve `docs/audits/ASAMA-4.8-...-reconciliation.md` A–B bölümü.

> **DÜZELTME (4.8 ölçümü).** Bu bölümün eski hâli "`memory_persistence.py` deployed `b5715fe`'de **ABSENT** —
> `bafe5b0`'da eklenmiş, yani kayıtlı deployed commit persistence alt sisteminden ÖNCE" diyordu. İki yarım doğru,
> tek yanlış sonuç:
> 1. **Doğru olan:** dosya `b5715fe`'de gerçekten yok ve gerçekten `bafe5b0`'da eklenmiş
>    (`2026-10-28 16:23 +03:00`). `b5715fe` (`2026-10-28 01:13 +03:00`) `bafe5b0`'dan **önce** olduğu için bu
>    normaldir, kusur değildir.
> 2. **Yanlış olan:** "kayıtlı deployed commit"in `b5715fe` olduğu varsayımı. `.deployed-commit` `b5715fe`
>    **değil**, **`cbe4f509`** okuyor (`od -c` ile 41 bayt doğrulandı; release kaydı `backend-only 3.8.7`,
>    `released_at 2026-10-29T21:48:07Z`). `cbe4f509`, `bafe5b0`'ı **içerir** ⇒ dosya canlıda.
> 3. **Yanlış kanıt yöntemi:** yokluk `git show b5715fe:<yol> | shasum -a 256` ile `e3b0c442…` (boş string'in
>    sha256'sı) olarak okundu; hata stderr'e gittiği için "0 baytlık dosya" gibi göründü. Doğru araç
>    `git cat-file -e`. (Blob: `bafe5b0` → `f848d120`, `38fe087`/`cbe4f509`/`7afb540` → `794e4481`, 24 767 bayt.)
>
> **Kanıt (etiket değil, container içi hash):** çalışan `tezlify-backend` konteynerinde
> `/app/backend/app/services/whatsapp/memory_persistence.py` → sha256 `6a1e5860…`, yani
> `git show cbe4f509:<yol> | shasum -a 256` ile **birebir aynı**. Dört backend dosyası da 4/4 `cbe4f509` ile
> eşleşiyor; gateway dört dosyası da `b5715fe` = `38fe087` = `cbe4f509` ile eşleşiyor (gateway gerçekten donmuş).
>
> **Neden `cbe4f509`, `main`'in atası değil:** release commit'leri ayrı dal olarak kesiliyor;
> `cbe4f509` → `release/backend-only-3.8.7` (yerel + origin). `git merge-base --is-ancestor cbe4f509 7afb540`
> **false** döner, ama dört backend dosyası `7afb540`'da **aynı blob** (`794e4481`) olduğu için container hash
> karşılaştırması yine de anlamlıdır. Bu, 4.8 raporundaki Bulgu A-1'in (konak checkout `5cd3eae`) kardeşidir.
>
> **Sonuç:** persistence alt sistemi **zaten canlıda**. 4.7 bir *ilk dağıtım* değil, **güncelleme**; ek bağımlılık
> yok (bkz. 4.8 raporu §9.5). "Deployed commit persistence'tan önce" riski **kapanmıştır**.

**3.9.19 escrow pollution (4.7 DIŞI — dokunma / commit etme):**
`escrow.py`, `schemas/escrow.py`, `services/admin/escrow_service.py`, `api/v1/endpoints/escrow.py`,
`test_admin_escrow_api.py`, `frontend/src/pages/admin/AdminEscrowPage.tsx`, `admin.ts`, `Sidebar.tsx`,
`App.tsx`, `locales/*`, `types/admin.ts`, `auth/*`, `config.py`, ve `docs/audits/*3.9.19*` dosyaları.

---

## 10. Nasıl devam edilir (How to continue — 4.9 and beyond)

4.7 **durduruldu** ve 4.8 onu **doğruladı ama dağıtmadı**. Aşağıdaki liste 4.8'in devraldığı maddelerdir;
her biri artık ya **kapalı** ya da **4.9'a devredilmiş** olarak işaretli:

1. **Loop'u canlı aktifleştir + uçtan uca canlı persistence doğrulaması.** → **4.9'a devredildi**
   (§2/§12 gereği 4.8'de loop **kapalı** bırakıldı: `config_enabled=False`, `task_running=False`, `runs=0`).
2. ~~**Canlı deployed hash teyidi** ve olası birlikte dağıtım planı (`memory_persistence.py` deployed değilse
   backend ile birlikte gitmeli).~~ **4.8'de YAPILDI ve kapatıldı:** deployed commit `cbe4f509`, dört backend
   dosyası container içi hash ile 4/4 doğrulandı, `memory_persistence.py` **canlıda** (`6a1e5860…`). "Birlikte
   dağıtım" gerekmiyor — 4.7 güncelleme. Kalan iş: `--no-gateway`'in 4.7'yi taşıyamaması (gateway dosyaları
   değişti) ⇒ `release/backend-only-*` ref'i kesilip `backend_only_release.py` ön kontrolünden geçirilmeli.
3. **`contacts.py:101` `custom_attributes` deserialize kusurunun** kök neden analizi + düzeltmesi.
   **4.8 bulgusu:** iddia edilen "33 testi düşürüyor" **reprodükte edilmiyor** (tam suite 2174 passed, 4 skipped).
   Üretim verisi de tetiklemiyor: `custom_attributes` dağılımı **1534 `object` / 4 `null`**, sıfır string, sıfır
   array. `contacts.py` deployed `cbe4f509` ile **bayt-bayt aynı** ⇒ 4.7'den bağımsız. Öneri: ayrı 4.9 kapsamı
   olarak savunmacı `_as_dict()` yardımcısı + kendi test dosyası (bkz. 4.8 raporu §6).
4. ~~**tz44/tz46 eski-davranış testlerini** 4.7 yeni sözleşmesine güncelle/emeklilik.~~ **4.8'de YAPILDI:** altı
   test yeniden yazıldı, **hiçbiri silinmedi/etkisizleştirilmedi**; tehdit modeli korunup yalnız sonuç tersine
   çevrildi. `tz44 4 failed/4 passed → 8 passed`, `tz46 2 failed/8 passed → 10 passed`, birleşik **18/18**.
   `/tmp`'ten `scripts/pg_audit_tests/`'e taşındı (reboot'ta kaybolmaz, release kapısı olarak kullanılabilir).
5. **Üretim yalnızca-okuma doğrulama kontrol listesi** (sandbox'tan çalıştırılamaz, üretim konakta elle)
   → **AÇIK (4.9)**:
   - canlı deployed commit ↔ **4.8 raporu A–B bölümü** blob tablosu (`cbe4f509`; `b5715fe` tablosu değil)
   - `SELECT indexname FROM pg_indexes WHERE tablename='messages'` → iki partial unique index var mı
   - `GET /health` → `capacity` + `whatsapp_memory_persistence` mevcut
   - `GET /metrics` → `whatsapp_memory_persistence` bloğu (dead_letter_total, epoch_resets_total, …)
   - loop davranışı değişmeden korunuyor (yalnız sayfalama/izolasyon/metrik iyileşti)

**Açık riskler:** ~~deployed `b5715fe` persistence alt sisteminden önce~~ → **kapatıldı** (deployed `cbe4f509`,
persistence canlıda); `contacts.py:101` önceden-var kusur (üretim verisinde tetiklenmiyor: 1534 object / 4 null);
tz44/tz46 eski testler → **4.8'de güncellendi, 18/18 yeşil**. Güncel açık risk listesi (K1–K9) 4.8 raporunda.

---

## 11. Hızlı referans komutları (Quick reference)

```bash
# İzole PG 17 kontrol
/opt/homebrew/bin/pg_isready -h 127.0.0.1 -p 55434

# 4.7 yetkili test koşumu (örnek, bkz. §6)
env -u TEST_DB_PATH DATABASE_URL="postgresql+asyncpg://tezlify@127.0.0.1:55434/tezlify_test_47" \
  PYTHONPATH=/tmp/tz44:. ./venv/bin/python -m pytest /tmp/tz47tests/test_tz47_fixes.py \
  backend/tests/test_whatsapp_memory_persistence.py backend/tests/test_whatsapp_memory_persistence_hardening.py \
  -p tz44_pgplugin -q -o asyncio_default_fixture_loop_scope=session -o asyncio_default_test_loop_scope=session

# Gateway JS syntax
node --check whatsapp-gateway/src/session-manager.js

# Üretim DB (yalnızca-okunur kullan)
docker exec tezlify-db psql -U tezlify -d tezlify -c "SELECT ..."

# Deploy (YALNIZ script, hedefin kopyası)
bash scripts/deploy/run_release.sh --expected-self-blob <blob> <ref> --no-gateway
```

---

## 12. Kaynaklar (Sources — detay burada)

- `docs/audits/ASAMA-4.7-memory-persistence-core-safety-fix-report.md` — 4.7 A–L raporu (blob tablosu, test, prod kontrol listesi, durdurma).
- `.workbuddy-ai/memory/MEMORY.md` — proje indeksi (yıkılmaz kurallar, invariant tells, çapraz kesit, ops).
- `.workbuddy-ai/memory/reference/whatsapp-subsystem-invariants.md` — Invariants **A–T** (tam).
- `.workbuddy-ai/memory/reference/production-ops.md` — topoloji, deploy state, release mechanics, 3.8.x anlatıları.
- `.workbuddy-ai/memory/reference/cross-cutting-rules.md` — Defect patterns **X1–X4**.
- `.workbuddy-ai/memory/2026-10-30.md`, `2026-10-31.md` — son oturum anlatıları (4.5/4.6/4.7).
- `docs/audits/TEZLIFY-HANDOFF-3.9.19.md`, `whatsapp-disaster-recovery-final-3.9.md` — 3.9.x escrow/DR hikâyesi.
```

> **Son söz:** Tezlify'da "iyi niyetli bir düzeltme" geri alınamaz veri kaybına yol açabilir. Üretime
> dokunmadan önce §2 ve §5'i oku, §6'daki izole PG ile kanıtla, dağıtımı yalnız §6'daki script ile yap.
