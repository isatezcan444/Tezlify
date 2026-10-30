# TEZLIFY WHATSAPP — TAM KURTARMA ve GUVENLIK DENETIMI OZETI

> **Amaç:** Bu belge, başka bir AI ajanına bu zamana kadar yapılan tüm WhatsApp kurtarma, güvenlik denetimi ve altyapı çalışmalarını tek bir kaynak olarak aktarmak için yazılmıştır.
> **Tarih:** 2026-10-30
> **Son güncellenen üretim durumu:** 3.9.6 sonrası
> **Üretim commit'i:** `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739` (deployed)
> **Gateway container:** `5b867095d376` (2026-10-27T17:25:57Z, DOKUNULMADI)

---

## 1. YÖNETICI ÖZETI

Bu proje, **7337 mesajın yalnızca WhatsApp gateway RAM'inde** durduğunu fark edip, bunları güvenli biçimde PostgreSQL'e kalıcılaştırmayı ve bu süreçte ortaya çıkan veri kayıplarını önlemeyi/iyileştirmeyi hedefledi. 22 aşamalık bir çalışma sonucunda:

1. **RAM-only mesaj sayısı** 7337 (40 sohbet) olarak ölçüldü.
2. **Kalıcılık süpürme modülü** (`memory_persistence.py`) geliştirildi ve test edildi.
3. **Backend-only deploy yolu** güvenli hale getirildi (`--no-gateway` muhafızı).
4. **Bir deploy sırasında 9 mesaj silindi** (3.8.6); bu mesajlar gateway RAM'inden **kurtarıldı ve şifreli snapshot'ta saklandı**.
5. **Silme davranışı** "fail-closed" karantina defterine dönüştürüldü (artık hiçbir mesaj silinmiyor).
6. **RAM snapshot altyapısı** (AES-256-GCM şifreli) kuruldu ve doğrulandı.
7. **Şifreleme anahtarı** kaynağı izlendi, escrow oluşturuldu, Git geçmişi temizlendi.
8. **Off-site backup mimarisi** tasarlandı (henüz aktarılmadı).

---

## 2. ÜRETIMIN MEVCUT DURUMU (HATIRLATMA)

| Öğe | Değer |
|---|---|
| `.deployed-commit` | `cbe4f50` |
| Backend container | `ce2e901b6619` (2026-10-29T21:47) |
| Gateway container | `5b867095d376` (2026-10-27T17:25) — **DOKUNULMADI** |
| DB container | `f6d79c4a1f8b` (2026-10-01T17:45) |
| Caddy container | `ee66a5cab371` (2026-10-12T13:12) |
| Session 201 | `CONNECTED`, `is_active=true` |
| Conversations | 125 |
| Messages | ~2151 (canlı ingest artıyor) |
| Contacts | 1537 |
| Persistence | `config_enabled=false`, `runs=0`, `inserted=0` |
| `whatsapp_identity_quarantine` | Tablo var, **0 satır** |

---

## 3. FAZLARIN KRONOLOJIK ÖZETI

### Aşama 3.6 — Mesaj Geçmişi Kurtarma ve PDO Teşhisi (2026-10-28)
- **7080** mesajın DB'de olmadığı fark edildi (sonradan **7337** olarak düzeltildi).
- `memory_persistence.py` modülü yazıldı: gateway RAM'indeki mesajları DB'ye yazar.
- On-demand PDO (Peer Data Operation) timeout analizi yapıldı; arıza **sohbet bazlı** kanıtlandı.
- **Kill-switch:** `WHATSAPP_MEMORY_PERSIST_ENABLED` (varsayılan `True`).
- **Deploy yapılmadı** — gateway değişikliği var, ayrı onay gerekiyor.

### Aşama 3.6b — Kalıcılık Sertleştirme (2026-10-28)
- **6 gerçek kusur** bulunup düzeltildi (kimliksiz kayıt çoğalması, sayfa içi hata, kill-switch yalnızca lifespan'de, devre dışı hat yazma, `/health` hata sayacı, imleç yokluğu).
- **22 regresyon testi** eklendi.
- **Imleç (cursor)** eklendi: 10.000 mesaj tavanının ötesindeki kuyruk erişilebilir oldu.
- **Test DB izolasyonu** sertleştirildi (`DATABASE_URL` uyuşmazlığı = `RuntimeError`).
- PDO teşhis izleri: `NO_CHUNK` / `WAITER_MISMATCH` / `PDO_NOT_SENT` ayrımı kodlandı.
- **Deploy yapılmadı**.

### Aşama 3.7 — Backend-Only Release Yolu (2026-10-28)
- `host-release.sh` muhafızı zayıflatılmadı; onun yerine **koşulu gerçekten sağlayan release ref'i** üretildi.
- `backend_only_release.py` ön-kontrol betiği yazıldı (18 test).
- `release/backend-only-3.7` ref'i oluşturuldu: `main`'in backend ağacı + yayındaki gateway ağacı.
- Kontrollü ilk tur **runbook** hazırlandı (dry_run → gerçek tur → kimlikle doğrulama).
- **Deploy yapılmadı**.

### Aşama 3.8.1 — Sohbet Başı 2000 Mesaj Tavanı (2026-10-29)
- Gateway'de **5 farklı yazma yolunda** `splice(0, list.length - 2000)` bulundu.
- Tavan **yalnızca en eski** kayıtları atar. DB'ye yazılmayan kayıt atılırsa **geri getirilemez**.
- **Ölçülen:** 2 sohbet tam 2000'de (`38289` ve `38291`); bir sonraki mesaj en eskiyi atar.
- **Metrik tasarımı** yapıldı (eviction sayacı) ama gateway'e dokunulmadı.

### Aşama 3.8.2 — RAM Mesajlarını Koruma Tasarımı (2026-10-29)
- Gateway `/messages/bulk` endpoint'i zaten mevcut ve **kimlik bazlı** toplama yapıyor.
- **Offset pagination kullanılamaz** — canlı trafik araya girerse kayma olur.
- Kimlik kümesi üzerinden toplama + `stable` bayrağı + `shortfall` tasarımı yapıldı.
- `ram_snapshot.py` tasarlandı (şifreli yedek).

### Aşama 3.8.3 — Onaylı Şifreli RAM Yedeği (2026-10-29)
- **İlk şifreli snapshot** alındı: `tezlify-ram-20261029T125755Z.rsnap`
- 9137 kayıt / 99 sohbet / ~7 MB / AES-256-GCM (`GATEWAY_ENCRYPTION_KEY`)
- `--verify` ile bütünlük doğrulandı; bozulma testi yapıldı (tek bayt değiştirildi → reddedildi).
- `:memory:` SQLite'a geri yüklendi; kimlik kökü **birebir eşleşti**.
- **Deploy yapılmadı**.

### Aşama 3.8.4 — Backend-Only Release Hazırlığı (2026-10-29)
- Eski `release/backend-only-3.8.1` ref'i `main`'den sapmıştı (1 test dosyası farklı).
- Yeni `release/backend-only-3.8.4` ref'i oluşturuldu (`3d3fc79`).
- Kalıcılık **fail-closed** doğrulandı: `true`/`1` dışındaki her değer kapalı.
- 1974 test PASS; preflight exit 0.
- **Deploy yapılmadı**.

### Aşama 3.8.5 — Deploy Güvenlik Muhafızı (2026-10-29)
- **En kritik bulgu:** eski betik yeni hedefi **sessizce** kabul ediyordu; yeni betik eski hedefi **reddediyor**.
- Üç katmanlı muhafız:
  - Katman A: `script_version_guard.py` — blob eşitliği
  - Katman B: `host-release.sh` — kendini kanıtlar + kill-switch muhafızı
  - Katman C: `run_release.sh` — hash pinli başlatıcı
- Kill-switch allowlist daraltıldı: `yes`/`on`/`y`/`t` artık **KAPALI**.
- `release/backend-only-3.8.5` = `38fe087` oluşturuldu.
- **Deploy yapılmadı** (dry-run yapıldı).

### Aşama 3.8.6 — Kontrollü Backend-Only Deploy (2026-10-29)
- **DEPLOY YAPILDI** (`38fe087`).
- Kalıcılık kanıtlanmış biçimde **KAPALI**.
- **Ama 9 mesaj silindi!** `purge_raw_jid_identity_data` 1 hayalet LID contact + 1 sohbet + 9 mesaj sildi.
- Bu release'in kodu değil; `migrations.py` base ile bayt-bayt aynıydı. Fark: hayalet sohbet son boot'tan sonra oluşmuştu.
- Snapshot'lar bütünlüğünü korudu.

### Aşama 3.8.7 — Acil Mesaj Koruma ve Karantina (2026-10-29)
- **9 silinmiş mesaj RAM'de kanıtlandı** (`CLASS_unmapped_jid`: LID 9 + PN 1).
- Yeni snapshot alındı (`20261029T210007Z.rsnap`): 9139 kayıt / 100 sohbet; 9/9 kapsanıyor.
- `purge_raw_jid_identity_data` **0 DELETE** hale getirildi; yerine `whatsapp_identity_quarantine` defteri.
- **Fail-closed:** köprü tablosu okunamadığında "hepsini sil" yerine "hepsini tut".
- 78 test PASS; **deploy yapılmadı**.

### Aşama 3.8.8 — Karantina Release Hazırlığı (2026-10-29)
- `release/backend-only-3.8.7` = `cbe4f50` ref'i kesildi.
- Preflight exit 0; gateway/compose farkı 0; testler 2052 PASS.
- `purge_raw_jid_identity_data` içinde 0 DELETE doğrulandı.
- **Deploy yapılmadı**.

### Aşama 3.8.9 — Karantina Deploy (2026-10-29)
- **DEPLOY YAPILDI** (`cbe4f50`).
- Backend yenilendi; gateway, DB, caddy **dokunulmadı**.
- `whatsapp_identity_quarantine` tablosu oluştu, 0 satır (boş başlama kanıtı).
- **0 mesaj silindi** (3.8.6'daki olay tekrarlanmadı).
- Persistence kapalı kaldı.

---

### Aşama 3.9.0 — 9 Mesajın Sınıflandırılması (2026-10-29)
- **Salt okunur** inceleme; DB yazımı yok.
- 9 LID mesajı + 1 PN mesajı üç kaynak üzerinden izlendi:
  - PostgreSQL: **0 iz** (silinmiş veya hiç yazılmamış)
  - Gateway RAM: **10 kayıt** (`CLASS_unmapped_jid`)
  - `lid_mappings`: **köprü yok**
- **Sınıflandırma: B — Kanıt bekliyor.** LID→PN köprüsü olmadan güvenli kurtarma mümkün değil.
- Otomatik başlangıç mutation risk matrisi çıkarıldı; `purge_raw_jid_identity_data` artık 0 DELETE.

### Aşama 3.9.1 — RAM Data Preservation (2026-10-29)
- **Yeni snapshot** alındı: `tezlify-ram-20261029T220302Z.rsnap` (9139 kayıt / 100 sohbet).
- Bütünlük doğrulandı (`ok: True`, 0 problem).
- 10 eşlenemeyen kayıt kapsandı (`COVERED 10 / MISSING 0`).
- **İkinci güvenli kopya yok** — tek fiziksel konum.
- Üretim değişmedi.

### Aşama 3.9.2 — Encryption Key Escrow (2026-10-29)
- `GATEWAY_ENCRYPTION_KEY` bağımlılığı incelendi.
- `.key-escrow` dosyası oluşturuldu (`600`, repo dışında).
- Anahtar hiçbir koşulda ekrana basılmadı.
- `.gitignore`'a `.env.production` eklendi (commit `5cd3eae`).
- Off-site backup için hedef bilgisi operatörden bekleniyor.

### Aşama 3.9.3 — Security Forensics ve Escrow Doğrulama (2026-10-29)
- Git geçmişi `GATEWAY_ENCRYPTION_KEY` açısından tarandı.
- **Kritik hata:** `.key-escrow` (v1) **yanlış anahtar** içeriyordu (`cut` komutu tırnakları da almıştı).
- Doğru anahtar içeren `.key-escrow-v2` oluşturuldu; **tüm 4 snapshot başarıyla çözüldü**.
- `production-ops.md`'deki secret iddiası sonradan **düzeltildi** (boş değer çıktı).
- Key rotation planı hazırlandı; history rewrite planı hazırlandı.

### Aşama 3.9.4 — Secret Containment ve Canonical Key Source (2026-10-30)
- **Git geçmişi temizlendi:** Hiçbir tracked dosyada gerçek production secret yok.
- `production-ops.md`'de `value_length=0` doğrulandı.
- `.env.production` dosyası **container env ile eşleşmiyor** gibi göründü — ama bu shell quoting yanılgısıydı.
- Docker Compose v2'nin tırnakları çıkardığı kanıtlandı.
- Recreate riski analiz edildi.

### Aşama 3.9.5 — Canonical Gateway Encryption Key Source (2026-10-30)
- **3.9.3 ve 3.9.4'teki "anahtar uyumsuzluğu" iddiası YANLIŞ çıktı.**
- Python ile doğrudan karşılaştırma: `.env.production`, `.env`, container env, v2 escrow **tümü aynı anahtar** (64 karakter).
- **Gerçek production compose dosyası:** `docker-compose.prod.yml` (root `docker-compose.yml` değil).
- Her iki servis (gateway + backend) `env_file: .env.production`'dan aynı anahtarı alıyor.
- Canonical source **zaten mevcut**: `/opt/tezlify/.env.production`.
- Yedekler oluşturuldu (`.env.backup-*`, `.env.production.backup-*`).
- Recreate riski **düşük** — aynı anahtar kullanılır.

### Aşama 3.9.6 — Off-Site Backup Tasarımı (2026-10-30)
- 4 snapshot + 2 escrow dosyasının envanteri çıkarıldı.
- Tüm snapshot'lar V2 escrow ile verify edildi (4/4 `ok=True`).
- **Off-site hedef seçenekleri** karşılaştırıldı: OCI Object Storage, S3/Wasabi, SFTP/sunucu.
- **Güvenli backup mimarisi** tasarlandı:
  - Snapshot ve escrow **AYRI** konumlarda tutulmalı.
  - SHA-256 doğrulama zorunlu.
  - TLS üzerinden aktarım.
  - Fail-closed: aktarım hatası = kaynak korunur.
- **Aktarım yapılmadı** — operatörden hedef bilgisi bekleniyor.

---

## 4. KRITIK HATALAR ve DÜZELTMELER

| Faz | Hata/Düzeltme | Açıklama |
|---|---|---|
| 3.6b | **6 kusur** bulundu ve düzeltildi | Kimliksiz kayıt çoğalması, sayfa hatası, kill-switch, devre dışı hat, health sayacı, imleç yokluğu |
| 3.6b | **Test DB izolasyonu** | `DATABASE_URL` unutulursa eski DB'ye koşuyordu; `RuntimeError` ile fail-closed yapıldı |
| 3.6b | **`pdo_sent` gölgelemesi** | Promise executor'da iç `pdoSent` dıştakini gölgeliyordu; `TIMEOUT` logu her zaman `false` yazıyordu |
| 3.8.3 | **Boş dosya artefaktı** | Script yokken `0 bayt` dosya oluşturuldu; boyut kontrolü (`[ ! -s ]`) eklendi |
| 3.8.5 | **Betik sürümü çelişkisi** | Eski betik yeni hedefi sessizce kabul ediyordu; blob eşitliği muhafızı eklendi |
| 3.8.6 | **9 mesaj silindi** | `purge_raw_jid_identity_data` startup'ta 1 sohbet + 9 mesaj sildi; mesajlar RAM'den kurtarıldı |
| 3.8.7 | **`/health` PII sızıntısı** | `last_error` SQL parametrelerini taşıyordu; `_safe_error()` yalnızca tür+SQLSTATE döndürür hale getirildi |
| 3.9.3 | **Escrow v1 yanlış anahtar** | `grep \| cut` tırnakları da aldı; v2 container env'den doğru alındı |
| 3.9.3 | **`production-ops.md` secret iddiası** | `cut` satırın geri kalanını aldı; Python ile `value_length=0` doğrulandı |
| 3.9.3 | **`.env.production` farklı anahtar** | Shell `sha256sum` tırnaklı/tırnaksız string'i farklı hash'e çevirdi; Python ile aynı çıktı |
| 3.9.5 | **Root compose dosyası yanlış** | `docker-compose.yml` değil, `docker-compose.prod.yml` kullanılıyor |

---

## 5. SNAPSHOT ENvanteri

| Dosya | Boyut | SHA-256 | Durum |
|---|---|---|---|
| `tezlify-ram-20261029T125657Z.rsnap` | 7.100.080 B | `2a150698…` | Eski (3.8.3) |
| `tezlify-ram-20261029T125755Z.rsnap` | 7.100.080 B | `00f657b1…` | Eski (3.8.3) |
| `tezlify-ram-20261029T210007Z.rsnap` | 7.135.835 B | `fdafdb7b…` | 3.8.7 |
| `tezlify-ram-20261029T220302Z.rsnap` | 7.147.070 B | `158794ed…` | **Güncel (3.9.1)** |

**Konum:** `/var/backups/tezlify-ram/` (`700`, `ubuntu:ubuntu`)
**Anahtar escrow:** `.key-escrow-v2` (doğru anahtar, `600`)
**Toplam boyut:** ~28 MB

---

## 6. AÇIK RISKLER

| Risk | Önem | Açıklama |
|---|---|---|
| **Tek fiziksel konum** | **KRITIK** | Snapshot + escrow aynı VM diskinde. Disk arızası = toplam kayıp. |
| **Off-site backup yok** | **KRITIK** | Henüz yapılandırılmadı; operatörden hedef bilgisi bekleniyor. |
| **9 LID mesajı kurtarılamadı** | Yüksek | RAM'de ve snapshot'ta var ama LID→PN köprüsü yok; güvenli hedef sohbeti kanıtlanamıyor. |
| **Medya baytları yedeklenmiyor** | Yüksek | Snapshot yalnızca metadata; resim/video/voice ayrı yedeklenmeli. |
| **Persistence kapalı** | Bilinen | RAM'deki ~7062 mesaj hâlen DB'ye aktarılmadı. Gateway recreate = kayıp. |
| **2 sohbet tavanda (2000)** | Orta | `38289` ve `38291`; her yeni mesaj en eskiyi atar. Snapshot zamanla değersizleşir. |
| **V1 escrow hâlâ var** | Düşük | Yanlış anahtar; operatör kafasını karıştırabilir. |
| **Gateway recreate yasağı** | Yüksek | 9 mesaj + diğer RAM-only mesajlar yalnızca RAM + snapshot'ta. |

---

## 7. SONRAKI ADIMLAR (Ayrı Onay Gerektirir)

1. **Off-site backup kurulumu (3.9.7):**
   - Operatörden hedef seçimi (OCI / S3 / Wasabi / SFTP)
   - `rclone` veya `oci cli` kurulumu
   - İlk aktarım + SHA-256 doğrulama
   - Escrow'u ayrı konuma aktarma
   - Otomasyon (cron/systemd timer)

2. **9 LID mesajı kurtarma:**
   - `lid_mappings`'te `2453b8a70004b2a5` için köprü oluşmasını bekle
   - Veya operatör manuel eşleme doğrulaması yap
   - `whatsapp_identity_quarantine`'a `bridge_unknown_has_messages` olarak kaydet
   - `RELEASED` kararı verilmeden fiziksel yazma yapma

3. **Persistence aktivasyonu:**
   - `WHATSAPP_MEMORY_PERSIST_ENABLED=true`
   - Önce `dry_run` → kimlikle doğrulama → gerçek tur
   - `audit_memory_gap.py --compare` ile `RAM_ONLY = 0` kanıtla

4. **Gateway recreate testi:**
   - Test ortamında `.env.production` ile recreate yap
   - Snapshot'ların yeni container'da çözülebildiğini doğrula

5. **V1 escrow silme:**
   - `.key-escrow` (yanlış anahtar) silinmeli

6. **`.env` dosyası temizliği:**
   - `.env` ve `.env.production` aynı içerik; biri kaldırılabilir

---

## 8. AI AJANI İÇIN HIZLI REFERANS

### 8.1 Dosyalar ve Konumlar

| Dosya/Path | Amaç |
|---|---|
| `/opt/tezlify/.env.production` | **Canonical key source** (`GATEWAY_ENCRYPTION_KEY`) |
| `/opt/tezlify/docker-compose.prod.yml` | Gerçek production compose |
| `/var/backups/tezlify-ram/*.rsnap` | Şifreli RAM snapshot'ları |
| `/var/backups/tezlify-ram/.key-escrow-v2` | Doğru anahtar escrow'u |
| `scripts/diagnostics/ram_snapshot.py` | Snapshot alma/doğrulama/geri yükleme |
| `scripts/diagnostics/audit_memory_gap.py` | RAM/DB fark analizi |
| `scripts/deploy/host-release.sh` | Deploy betiği (blob eşitliği muhafızı) |
| `scripts/deploy/run_release.sh` | Hash pinli başlatıcı |
| `scripts/deploy/backend_only_release.py` | Preflight kontrolü |
| `backend/app/services/whatsapp/memory_persistence.py` | Kalıcılık süpürme modülü |
| `backend/app/core/migrations.py` | Startup migration'ları (artık 0 DELETE) |

### 8.2 Kritik Kısıtlar

- **Gateway restart/recreate YASAK** (RAM-only mesajlar kaybolur).
- **Persistence açma** yalnızca `dry_run` + kimlik doğrulama sonrası.
- **Snapshot alma** güvenli (salt okunur) ama medya baytlarını kapsamaz.
- **Escrow v2** kullan; v1 yanlış anahtar.
- **Deploy sırası:** backend önce, gateway sonra.

### 8.3 Test Komutları

```bash
# Snapshot verify
python scripts/diagnostics/ram_snapshot.py \
  --verify /var/backups/tezlify-ram/tezlify-ram-20261029T220302Z.rsnap \
  --encrypt-key-env GATEWAY_ENCRYPTION_KEY

# RAM/DB fark analizi
python scripts/diagnostics/audit_memory_gap.py

# Preflight
python scripts/deploy/backend_only_release.py \
  --base $(cat /opt/tezlify/.deployed-commit) \
  --target release/backend-only-3.8.7
```

---

*Bu özet, `docs/audits/whatsapp-phase3.*.md` ve `whatsapp-recovery-phase-3.9.*.md` dosyalarından derlenmiştir. Detaylar orijinal raporlarda mevcuttur.*
*Hazırlayan: WorkBuddy AI Agent*
*Son güncelleme: 2026-10-30*
