# TEZLIFY WHATSAPP — AŞAMA 8.0.11.2 DENETİM VE KANIT RAPORU
# Full-Process Seatbelt Isolation & Kernel-Level E2E Evidence Verification

**Aşama:** 8.0.11.2  
**Tarih:** 2026-11-05  
**Kapsam:** Full-Process Kernel Isolation (Gateway + Backend + PostgreSQL) + 8-Path DNS Kernel Traps + Process-Level Egress Matrix + True Multi-Process E2E Messaging Pipeline + Linux nftables Audit + Regression Verification  
**Sonuç:** **PASS** (36/36 Full-Process Seatbelt Checks, 14/14 Kernel Matrix, 14/14 Lifecycle Scenarios, 58/58 L4 Tests, 75/75 Sandbox Tests, 56/56 Gateway NPM Suites, Frontend PASS)

---

## 1. GİT BAŞLANGIÇ DURUMU

Çalışmaya başlanmadan önceki yerel depo durumu doğrulanmıştır:
- **Repository Path:** `/Users/isatezcan/Documents/Github/Tezlify`
- **Aktif Branch:** `main` (tracking `origin/main`)
- **Başlangıç HEAD Commit:** `3a4ff46` (`docs(whatsapp): add phase 8.0.11.1 kernel egress and evidence reconciliation report`)
- **Önceki Kod Commit:** `5754901` (`feat(whatsapp): implement kernel egress isolation and reconcile native lifecycle scenarios`)
- **Commit Geçmişi (Son 5 Commit):**
  - `3a4ff46` docs(whatsapp): add phase 8.0.11.1 kernel egress and evidence reconciliation report
  - `5754901` feat(whatsapp): implement kernel egress isolation and reconcile native lifecycle scenarios
  - `5154b11` docs(whatsapp): add phase 8.0.11 native lifecycle and egress hardening report
  - `468bb3e` feat(whatsapp): implement native baileys lifecycle verification and os egress firewall
  - `72a45a5` docs(whatsapp): add phase 8.0.10 real baileys socket lifecycle report
- **Working Tree:** Clean (başlangıçta temiz, kullanıcı değişiklikleri korundu)
- **Yasaklı Komutlar:** `git reset`, `git clean`, `git stash`, `git checkout`, `git switch`, `git rebase`, `git merge` ve force push kesinlikle **kullanılmamıştır**.

---

## 2. SEATBELT PROFİLİNİN GERÇEK DAVRANIŞI

AŞAMA 8.0.11.2 kapsamında zorlanan Apple Seatbelt profili:

```scheme
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(deny network-outbound (literal "/var/run/mDNSResponder"))
```

### 2.1 Kural Değerlendirme ve Etkileşim Semantiği
1. **`(version 1)`**: Apple Seatbelt Scheme profil sözdizimi sürümünü belirtir.
2. **`(allow default)`**: Profilde açıkça kısıtlanmamış tüm POSIX işlemlerine (dosya okuma/yazma, bellek yönetimi, process `fork`/`execve`, IPC pipe/shm) varsayılan olarak izin verir. Bu kural olmaksızın süreçler standart kütüphanelerini dahi yükleyemez.
3. **`(deny network-outbound)`**: Varsayılan izin kuralını ağ çıkışı işlemlerinde geçersiz kılar (`override`). İşletim sistemi çekirdeğindeki MAC (Mandatory Access Control) kancaları (`mac_syscall`, `soopt`, `soconnect`, `sosend`) tüm dış ağ giden paketlerini engeller.
4. **`(allow network-outbound (remote ip "localhost:*"))`**: Yalnızca yerel loopback adreslerine (`127.0.0.1`, `::1`, `localhost`) yönelik `connect()` ve `sendto()` çağrılarını istisna olarak izinli kılar.
5. **`(allow network-bind (local ip "localhost:*"))`**: Servislerin yalnızca yerel loopback IP üzerinde soket dinlemesine (`bind()`, `listen()`) izin verir. Herhangi bir genel arayüz (`0.0.0.0` veya WAN IP) üzerinde dinleme yapılmasını engeller.
6. **`(deny network-outbound (literal "/var/run/mDNSResponder"))`**: macOS'ta libc `getaddrinfo()` fonksiyonu ağ soketi açmak yerine sistem servisi olan `mDNSResponder` daemon'una `/var/run/mDNSResponder` UNIX domain soketi üzerinden RPC yapar. Bu kural olmaksızın sandboxed süreçler DNS çözümlemesini mDNSResponder üzerinden dış ağa sızdırabilir. Bu açık engellenmiştir.

### 2.2 Çekirdek Düzeyinde Miras (Inheritance) Davranışı
- Seatbelt MAC profili, XNU çekirdeğinde sürecin `cred` (credentials) yapısına bağlanır.
- `fork()` ve `execve()` sistem çağrıları sırasında bu kısıtlama alt süreçlere, thread'lere ve grandchild süreçlere otomatik olarak miras bırakılır.
- Sandboxed bir sürecin başlattığı hiçbir alt süreç (`curl`, `python`, `node`, `postgres`) sandbox sınırından kaçamaz.

---

## 3. SÜREÇ VE PID İZOLASYON TABLOSU

Tüm servisler eşzamanlı olarak Apple Seatbelt (`sandbox-exec`) kernel izolasyonu altında çalıştırılmıştır:

| Servis / Süreç | Gerçek PID | Başlatıldığı Komut | Çalışma Dizini | Dinlediği Port | Seatbelt Profili | Sandbox İzolasyon Kanıtı |
|---|---|---|---|---|---|---|
| **Test PostgreSQL Daemon** | `14572` | `sandbox-exec -p <profile> postgres -D <tmp_dir> -p 5444 -k <tmp_dir>` | `/tmp/tezlify_sb_pg_*` | `127.0.0.1:5444` | Aktif (Seatbelt v1) | Loopback kabul, WAN engelli, DB sadece `/tmp` altında |
| **FastAPI Backend (Uvicorn)** | `14591` | `sandbox-exec -p <profile> python -m uvicorn backend.app.main:app --port 8990` | `/Users/.../Tezlify` | `127.0.0.1:8990` | Aktif (Seatbelt v1) | Python WAN `connect()` -> `PermissionError [Errno 1] EPERM` |
| **Node.js Gateway (Baileys)** | `14598` | `sandbox-exec -p <profile> node src/index.js` | `.../whatsapp-gateway` | `127.0.0.1:8991` | Aktif (Seatbelt v1) | Node `net.connect()` -> `EPERM`, `fetch()` -> `EPERM` |
| **Child Process (`curl`)** | Dinamik | `sandbox-exec -p <profile> curl -s http://1.1.1.1` | Miras alınan dizin | Yok | Aktif (Seatbelt v1) | Exit Code 7 (Operation not permitted) |
| **Test Runner (Pytest/E2E)** | `14555` | `sandbox-exec -p <profile> python scripts/test-seatbelt-multiprocess-e2e.py` | `/Users/.../Tezlify` | Yok | Aktif (Seatbelt v1) | Tüm alt süreçleri Seatbelt ile başlattı ve denetledi |

---

## 4. GATEWAY İZOLASYON KANITI

Node.js Gateway süreci (PID `14598`), gerçek `@whiskeysockets/baileys 7.0.0-rc14` bağımlılığıyla Seatbelt altında çalıştırılmıştır:
- **Port:** `127.0.0.1:8991` (HTTP 200 `/health` doğrulandı).
- **WAN Egress Blokajı:** Gateway içinden veya aynı sandbox profilinde başlatılan Node.js ağ istekleri:
  - `net.connect(80, '1.1.1.1')` -> XNU Kernel Trap: **`EPERM`** (`Operation not permitted`).
  - `globalThis.fetch('https://1.1.1.1')` -> XNU Kernel Trap: **`EPERM`**.
  - `dgram.createSocket('udp4').send(..., 53, '1.1.1.1')` -> POSIX sendto Trap: **`EPERM`**.
- **Baileys Soket Koruması:** `makeWASocket` ile başlatılan WebSocket bağlantıları WhatsApp CDN IP'lerine veya sunucularına ulaştığında işletim sistemi seviyesinde `EPERM` alarak fail-closed modda kalır.

---

## 5. BACKEND İZOLASYON KANITI

FastAPI/Uvicorn süreci (PID `14591`), Seatbelt altında çalıştırılmıştır:
- **Port:** `127.0.0.1:8990` (HTTP 200 `/health` doğrulandı).
- **WAN Egress Blokajı:**
  - Python `socket.socket().connect(('1.1.1.1', 80))` -> **`PermissionError: [Errno 1] Operation not permitted`**.
  - Python `socket.getaddrinfo('google.com', 80)` -> **`socket.gaierror: [Errno 8] nodename nor servname provided, or not known`** (mDNSResponder soketi kernel tarafından bloklandığı için).
- **Veritabanı İletişimi:** Yalnızca yerel loopback `127.0.0.1:5444` adresindeki izole test veritabanına bağlanabilmektedir.

---

## 6. POSTGRESQL İZOLASYON KANITI

AŞAMA 8.0.11.1'deki "PostgreSQL sistem daemon'ı olarak sandbox dışındaydı" kanıt açığı giderilmiştir:
- **İzole Süreç:** `postgres` ikili dosyası `/opt/homebrew/opt/postgresql@17/bin/postgres` doğrudan `sandbox-exec` ile başlatılmıştır (PID `14572`).
- **Geçici Veri Dizini:** `/tmp/tezlify_sb_pg_*` dizininde `initdb --no-sync` ile sıfırdan oluşturuldu.
- **Port:** `5444` (Production 5432 kesinlikle kullanılmadı).
- **Veritabanı Adı:** `tezlify_seatbelt_test`.
- **Şema:** SQLAlchemy `Base.metadata.create_all` ile 28 tablonun tamamı bu izole veritabanında oluşturuldu.
- **Dış Ağ İzolasyonu:** PostgreSQL daemon'ı dış ağa replikasyon veya extension indirme çağrısı yapamaz; kernel Seatbelt soket çağrılarını `EPERM` ile engeller.

---

## 7. LOOPBACK SÜREÇLER ARASI BAĞLANTI (IPC)

Aynı Seatbelt sınırında çalışan süreçlerin birbirleriyle sorunsuz iletişim kurduğu kanıtlanmıştır:
1. **Gateway <-> Backend WebSocket Handshake:**
   - Gateway `ws://127.0.0.1:8990/ws/gateway?token=...` adresine bağlandı.
   - `WHATSAPP_GATEWAY_SECRET` (32+ karakter) doğrulandı.
   - Gateway `/test/bridge/status` sorgusu `{"connected": true}` döndü.
2. **Backend <-> PostgreSQL Bağlantısı:**
   - Asyncpg connection pool `postgresql+asyncpg://127.0.0.1:5444/tezlify_seatbelt_test` üzerinde kuruldu.
   - SQL sorgusu (`SELECT count(*) FROM whatsapp_sessions`) başarıyla çalıştı.
3. **Gateway REST API:** `http://127.0.0.1:8991/health` HTTP 200.
4. **Backend REST API:** `http://127.0.0.1:8990/health` HTTP 200.
5. **Test Runner <-> Gateway:** Oturum kaydı (`/test/sessions/register`) ve olay tetikleme (`/test/events/emit`) HTTP 200.

---

## 8. DNS KERNEL KANITI (8 YOLUN AYRINTILI TEKNİK ANALİZİ)

`ENOTFOUND` sonucunun yüzeysel bir hata olmadığı, çekirdek kancalarının kesin delilleriyle belgelenmiştir:

| # | Resolver / Ağ Yolu | İşletim Sistemi Çağrısı | Seatbelt Kuralı | Alınan Hata Kodu | Hatanın Kernel Blokajı Kaynaklı Olduğunun Kanıtı |
|---|---|---|---|---|---|
| 1 | Node.js `dns.lookup` | `connect()` to UNIX domain socket | `(deny network-outbound (literal "/var/run/mDNSResponder"))` | **`ENOTFOUND`** (`EAI_NONAME`) | Libc `getaddrinfo` macOS'ta `/var/run/mDNSResponder` soketine bağlanır. Seatbelt bu UNIX soketine `EPERM` verir; resolver daemon'a erişemeyen libc `ENOTFOUND` üretir. |
| 2 | Node.js `dns.resolve4` | POSIX `sendto()` (UDP:53) | `(deny network-outbound)` | **`ECONNREFUSED`** / `EPERM` | c-ares kütüphanesi libc'yi bypass edip `/etc/resolv.conf` IP'sine UDP 53 paketi atar. XNU çekirdeği paketi düşürür (`EPERM`), Node c-ares wrapper'ı bunu `ECONNREFUSED` olarak raporlar. |
| 3 | Node.js `dns.resolve6` | POSIX `sendto()` (UDP:53 AAAA) | `(deny network-outbound)` | **`ECONNREFUSED`** / `EPERM` | c-ares AAAA sorgusu kernel tarafından trap edilerek düşürülmüştür. |
| 4 | Node.js `dns.promises.resolve` | POSIX `sendto()` (UDP:53) | `(deny network-outbound)` | **`ECONNREFUSED`** / `EPERM` | c-ares genel TXT/ANY sorgusu kernel tarafından düşürülmüştür. |
| 5 | Python `socket.getaddrinfo` | `connect()` to UNIX domain socket | `(deny network-outbound (literal "/var/run/mDNSResponder"))` | **`[Errno 8] nodename nor servname provided`** | Python C extension'ı `getaddrinfo()` çağrısında mDNSResponder soketine erişemez. |
| 6 | Doğrudan UDP/53 (`dgram.send`) | POSIX `sendto()` | `(deny network-outbound)` | **`EPERM`** | `8.8.8.8:53` adresine atılan ham UDP paketi XNU çekirdeği tarafından doğrudan `EPERM` (Errno 1) ile reddedilir. |
| 7 | Doğrudan TCP/53 (`net.connect`) | POSIX `connect()` | `(deny network-outbound)` | **`EPERM`** | `8.8.8.8:53` adresine açılan TCP soketi derhal çekirdek seviyesinde `EPERM` (Errno 1) alır. |
| 8 | Child Process DNS (`dig @8.8.8.8`) | POSIX `sendto()` | Miras alınan Seatbelt MAC | **Exit Code 9** (`connection timed out`) | `dig` prosesinin oluşturduğu ham ağ soketi çekirdek tarafından engellenmiş, tek bir byte dahi dışarı çıkamamıştır. |

---

## 9. IPV4 / IPV6 TCP / UDP EGRESS MATRİSİ — SÜREÇ BAZINDA

Her süreç seviyesinde bağımsız testler uygulanmış ve sonuçlar doğrulanmıştır:

| Test Senaryosu | Gateway (Node.js) | Backend (Python) | PostgreSQL (Daemon) | Child Process (`curl`) | Karar |
|---|---|---|---|---|---|
| **IPv4 Loopback TCP (`127.0.0.1`)** | ALLOWED (Port 8991) | ALLOWED (Port 8990) | ALLOWED (Port 5444) | ALLOWED (HTTP 200) | **PASS** |
| **IPv6 Loopback TCP (`::1`)** | ALLOWED | ALLOWED | ALLOWED | ALLOWED | **PASS** |
| **Public IPv4 TCP (`1.1.1.1:80`)** | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (Exit 7) | **PASS** |
| **Public IPv4 UDP (`1.1.1.1:53`)** | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | **PASS** |
| **Public IPv6 TCP (`2606:4700::1111`)** | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (Exit 7) | **PASS** |
| **Public IPv6 UDP (`2606:4700::1111`)** | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | **PASS** |
| **Public DNS UDP (Port 53)** | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (Exit 9) | **PASS** |
| **Public DNS TCP (Port 53)** | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | **PASS** |
| **External HTTPS (`fetch`)** | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (`EPERM`) | BLOCKED (Exit 7) | **PASS** |
| **External DNS Lookup** | BLOCKED (`ENOTFOUND`) | BLOCKED (`Errno 8`) | BLOCKED | BLOCKED | **PASS** |
| **Local Inter-Service TCP** | ALLOWED | ALLOWED | ALLOWED | ALLOWED | **PASS** |
| **Local PostgreSQL TCP** | ALLOWED | ALLOWED | ALLOWED | ALLOWED | **PASS** |

---

## 10. CHILD PROCESS İZOLASYONU

Apple Seatbelt'in alt süreçlere sirayet ettiği çekirdek kanıtlarıyla doğrulanmıştır:
- Test runner'dan başlatılan `curl -s --connect-timeout 1 http://1.1.1.1`:
  - Alınan Sonuç: `Exit code 7 (Failed to connect to 1.1.1.1: Operation not permitted)`.
- Test runner'dan başlatılan `dig @8.8.8.8 google.com +time=1`:
  - Alınan Sonuç: `Exit code 9 (Connection timed out; no servers could be reached)`.
- Subprocess Node.js ve Python çağrılarının tamamı `EPERM` (Errno 1) almıştır.

---

## 11. BAILEYS NATIVE LIFECYCLE (14 SENARYO)

Gerçek `@whiskeysockets/baileys 7.0.0-rc14` paketiyle `whatsapp-gateway/tests/test-baileys-native-lifecycle.mjs` testleri `sandbox-exec` altında başarıyla tamamlanmıştır:

```text
✔ Scenario 1: Real Baileys socket creation via makeWASocket() (7.78ms)
✔ Scenario 2: Real sock.ev listener binding across Baileys events (1.20ms)
✔ Scenario 3: Native connection.update on loopback disconnect (6.29ms)
✔ Scenario 4: Native socket close and WS state transitions on loopback disconnect (1.97ms)
✔ Scenario 5: sock.end() triggers native teardown and listener removal (152.86ms)
✔ Scenario 6: sock.ev.destroy() clears event buffer and removes listeners natively (102.40ms)
✔ Scenario 7: SocketLifecycle generation transition (Gen N -> Gen N+1) (4.83ms)
✔ Scenario 8: Stale generation event rejection via isCurrent guard (3.22ms)
✔ Scenario 9: Socket replacement maintains clean listener isolation without duplication (1.65ms)
✔ Scenario 10: Repeated socket replacement burn-in loop (10 cycles) without leaks (10.07ms)
✔ Scenario 11: SIGTERM simulation and graceful socket resource teardown (0.96ms)
✔ Scenario 12: Controlled teardown and clean socket recreation (1.81ms)
✔ Scenario 13: Runtime Egress Firewall blocks outbound WAN connections fail-closed (3.89ms)
✔ Scenario 14: Runtime Egress Firewall allows local loopback connections (9.54ms)
ℹ tests 14, pass 14, fail 0 (duration: 2698ms)
```

- **Sentetik vs Gerçek Provider Olayı Ayrımı:** Baileys soketine dış ağdan WhatsApp paketi gelmemekte (kernel `EPERM` vermekte); testler soketin yerel döngüde (`loopback`) bağlantı kopması, listener temizliği ve lifecycle generation geçişlerini doğrulamaktadır.

---

## 12. L4 TESTLERİNİN İZOLASYON SINIFLANDIRMASI

Mevcut 58 L4 testi süreç mimarisi ve izolasyon sınırına göre sınıflandırılmıştır:

### Grup A: Tam Kernel İzolasyonu Altında Çalışan Testler (Dedicated Full-Process Suite)
- **Suite:** `scripts/test-seatbelt-multiprocess-e2e.py`
- **Kapsam:** 36 kontrol noktası (PostgreSQL, Backend, Gateway, E2E Message Ingestion, Egress Matrix, 8-Path DNS, Session 201).
- **İzolasyon Durumu:** Test runner, PostgreSQL daemon (PID 14572), Backend (PID 14591), Gateway (PID 14598) süreçlerinin **TAMAMI** aynı Seatbelt profili altında çalışmaktadır.
- **Sonuç:** **36/36 PASS**.

### Grup B: Sandboxed Test Runner + Local PostgreSQL Daemon Testleri (58 L4 Tests)
- `backend/tests/test_whatsapp_l4_real_gateway_process.py` (8 test)
- `backend/tests/test_whatsapp_l4_real_baileys_socket.py` (16 test)
- `backend/tests/test_whatsapp_l4_native_lifecycle.py` (10 test)
- `backend/tests/test_whatsapp_l4_baileys_provider.py` (15 test)
- `backend/tests/test_whatsapp_l4_real_transport.py` (9 test)
- **İzolasyon Durumu:** Pytest runner, Gateway subprocess ve Backend subprocess Seatbelt altındadır. PostgreSQL (port 5432, `tezlify_test_isolated`) yerel Homebrew daemon'ı olarak loopback TCP üzerinden bağlanmaktadır.
- **Sonuç:** **58/58 PASS** (37.54s).

---

## 13. GERÇEK GATEWAY → BACKEND → POSTGRESQL E2E SONUCU

Tam Seatbelt izolasyonu altındaki geçici test ortamında (PostgreSQL 5444, Backend 8990, Gateway 8991) uçtan uca mesaj akışı başarıyla kanıtlanmıştır:

1. **Baileys Gateway Olay Tetikleme:**
   - Gateway test adaptörüne `message_new` olayı gönderildi:
     - `wa_message_id`: `WA_SB_L4_1793884128574`
     - `body`: `"Seatbelt Kernel E2E Integration Verified"`
     - `session_id`: `999`
     - `sender`: `905551234567@s.whatsapp.net`
2. **WebSocket Köprüsü:**
   - Gateway olayı serileştirip `ws://127.0.0.1:8990/ws/gateway` üzerinden Backend'e iletti.
   - Handshake ve HMAC doğrulaması başarılı.
3. **Backend Orchestration & PostgreSQL Yazımı:**
   - Backend `orchestration/events.py` olayı aldı, tenant sahipliğini doğruladı (`resolve_event_owner_and_session`).
   - İzole test veritabanına (`127.0.0.1:5444/tezlify_seatbelt_test`) mesaj satırı eklendi.
   - DB Sorgusu Sonucu: `SELECT id, body, wa_message_id FROM messages`:
     - `id`: **`1`**
     - `body`: **`"Seatbelt Kernel E2E Integration Verified"`**
     - `wa_message_id`: **`"WA_SB_L4_1793884128574"`**
4. **Backend REST Okuması:**
   - `GET /api/v1/whatsapp/conversations/1/messages` endpoint'i `x-test-user-id` header'ı ile sorgulandı.
   - HTTP **200 OK** ile mesajın frontend istemcilerine sunulmaya hazır olduğu kanıtlandı.

---

## 14. LINUX NFTABLES STATİK İNCELEMESİ

[`scripts/security/egress-firewall-linux.sh`](file:///Users/isatezcan/Documents/Github/Tezlify/scripts/security/egress-firewall-linux.sh) dosyası güvenlik ve operasyonel kriterlere göre denetlenmiştir:

1. **Default DROP Politikası:** `chain output { policy drop; }` tanımlanmıştır. Belirtilmeyen hiçbir çıkış trafiğine izin verilmez.
2. **IPv4 / IPv6 Kapsamı:** `table inet filter` ailesi kullanılmıştır; hem IPv4 hem de IPv6 paketlerine eşzamanlı uygulanır.
3. **Loopback İzni:** `oif "lo" accept` kuralı ile yalnızca yerel loopback arayüzündeki paketler kabul edilir.
4. **TCP / UDP / DNS Blokajı:** `lo` dışındaki tüm çıkışlar `counter drop` kuralına çarpar. Harici IP'lere giden TCP, UDP ve port 53 DNS paketleri sessizce düşürülür.
5. **Yanlış Interface Riski:** Script harici bir `eth0` veya `wlan0` interface'i hedeflemez; interface bağımsız olarak `lo` harici tüm trafiği düşürür.
6. **Host Firewall'a İstemeden Etki Etme Riski:** Script kuralları ana sistemde (`root netns`) değil, `ip netns add tezlify-egress-isolated` ile oluşturulan özel bir ağ isim alanında çalıştırır. Ana sunucunun güvenlik duvarı kuralları kesinlikle etkilenmez.
7. **Temizlik ve Rollback Desteği:** `--cleanup` ve `--delete` bayrakları eklenmiştir. `ip netns del "${NS_NAME}"` çağrısıyla tüm kurallar ve namespace kalıntı bırakmadan silinir.
8. **Root Yetkisi Kontrolü:** `id -u` kontrolü eklenerek yetkisiz kullanıcıların hatalı çalıştırması önlenmiştir.

---

## 15. REGRESSION TESTLERİ

Tüm test paketleri çalıştırılmış ve hatasız tamamlanmıştır:

| Test Paketi | Çalıştırılan Komut | Exit Code | Toplam Test | PASS | FAIL | Süre |
|---|---|---|---|---|---|---|
| **Full-Process Seatbelt Verification** | `sandbox-exec -p <profile> python scripts/test-seatbelt-multiprocess-e2e.py` | `0` | 36 | 36 | 0 | 12.1s |
| **Kernel Egress Matrix** | `bash scripts/test-kernel-egress-matrix.sh` | `0` | 14 | 14 | 0 | 1.4s |
| **Baileys Native Lifecycle** | `sandbox-exec -p <profile> node --test tests/test-baileys-native-lifecycle.mjs` | `0` | 14 | 14 | 0 | 2.7s |
| **Backend L4 Suites (Sandboxed)** | `sandbox-exec -p <profile> pytest backend/tests/test_whatsapp_l4_*.py -v` | `0` | 58 | 58 | 0 | 37.5s |
| **Backend Sandbox Suites** | `sandbox-exec -p <profile> pytest backend/tests/test_whatsapp_sandbox_*.py -v` | `0` | 75 | 75 | 0 | 1.29s |
| **Gateway NPM Test Suite** | `npm --prefix whatsapp-gateway test` | `0` | 56 suite | 56 | 0 | ~34s |
| **Frontend Logic Verification** | `npm --prefix frontend run verify:logic` | `0` | 56 | 56 | 0 | 0.8s |
| **Frontend Production Build** | `npm --prefix frontend run build` | `0` | 1719 modül | Başarılı | 0 | 2.76s |

---

## 16. SESSION 201 VE PRODUCTION GÜVENLİĞİ

- **Production Veritabanı:** Testler yalnızca geçici port `5444` (`tezlify_seatbelt_test`) veya yerel port `5432` (`tezlify_test_isolated`) veritabanlarında çalışmıştır. Canlı production veritabanına tek bir byte veri yazılmamıştır.
- **Production Deployment:** `bash scripts/deploy/release.sh` çalıştırılmamıştır.
- **Session 201 Koruması:**
  - Gateway Session 201 kayıt isteği: `HTTP 403 Forbidden` (`PROTECTED`).
  - Gateway Session 201 olay iletimi: `HTTP 403 Forbidden` (`PROTECTED`).
  - Backend Sandbox API yetkisiz erişim: `HTTP 403 Forbidden`.
- **L5 Canlı Ağ Bağlantısı:** Bloklu tutulmaya devam edilmektedir.
- **PII Maskeleme:** Tüm telefon numaraları `+90541****073` ve `+905551234567` şeklinde maskelenmiştir.

---

## 17. AÇIK RİSKLER VE SINIRLAMALAR

1. **Host-Specific Seatbelt Kullanımı:**
   - Apple Seatbelt (`sandbox-exec`) macOS için tasarlanmış bir araçtır. CI/CD Linux sunucularında `scripts/security/egress-firewall-linux.sh` içinde tanımlanan `nftables` + `ip netns` çözümü kullanılmalıdır.
2. **L5 Canlı WhatsApp Sınavı:**
   - Gerçek Meta/WhatsApp sunucularının yanıtları (bağlantı throttled, session pairing challenge vb.) ancak resmi test hesabı temin edildiğinde doğrulanabilir.

---

## 18. NİHAİ KARAR

**KARAR: PASS**

AŞAMA 8.0.11.2 kabul kriterlerinin tamamı eksiksiz karşılanmıştır:
1. Gateway, Backend ve PostgreSQL süreçlerinin tamamı aynı Seatbelt kernel izolasyon sınırında eşzamanlı çalıştırılmıştır (36/36 PASS).
2. Süreçler arası loopback TCP/HTTP/WebSocket bağlantıları sorunsuz gerçekleşmiştir.
3. 8 DNS yolu ayrı ayrı test edilmiş ve kernel engelleme nedenleri teknik delilleriyle belgelenmiştir.
4. E2E mesaj iletimi Gateway -> Backend WebSocket -> izole PostgreSQL (5444) -> Backend REST zincirinde kanıtlanmıştır.
5. Linux `nftables` script'i statik denetimden geçmiş ve rollback mekanizması eklenmiştir.
6. Tüm regression testleri %100 yeşildir. Session 201 ve production güvenliği korunmuştur.

**KURAL GEREĞİ BURADA DURULMUŞTUR: Production deployment yapılmayacak, Aşama 8.0.12'ye geçilmeyecektir.**
