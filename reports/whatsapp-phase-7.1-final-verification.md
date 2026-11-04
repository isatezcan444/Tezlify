# AŞAMA 7.1-F — Production Son Doğrulama ve Nihai Kanıt Raporu

**Tarih**: 2026-11-04  
**İşlem Türü**: Salt Okunur Doğrulama / Production Denetimi  
**Kod Değişikliği**: HAYIR (0 dosya)  
**Altyapı Değişikliği**: HAYIR (0 değişiklik)  
**Nihai Sonuç**: `PASS_WITH_NOTES`

---

## 1. YÖNETİCİ ÖZETİ VE 3 KRİTİK SORUNUN YANITI

AŞAMA 7.1 kapsamında geliştirilen ve production ortamına deploy edilen WhatsApp Identity Quarantine kurtarma mekanizmasının production sağlığı, veri bütünlüğü ve test ortamı durumu salt okunur yöntemlerle incelenmiştir.

Kullanıcının yönelttiği 3 temel soru ve kanıtlanmış yanıtları:

1. **9 Mesaj Kurtarıldı mı, Yoksa Güvenli Biçimde Karantinada mı?**
   - **Yanıt**: **Güvenli biçimde karantinada korunmaktadır.**
   - **Kanıt**: WhatsApp protokolü (Baileys), `218107046027315@lid` kimliği için gerçek telefon numarası eşleşmesini (`lid_mapped`) henüz backend'e iletmemiştir. Production `whatsapp_private.lid_mappings` tablosunda bu LID için 0 kayıt mevcuttur.
   - **Güvenlik Davranışı**: Tezlify'ın fail-closed anti-hallucination ilkesi gereğince numara tahmin edilmemiş, sahte eşleme yapılmamış ve 9 mesaj (`161406`–`161414`) karantina tablosunda (`status = 'QUARANTINED'`, `reason = 'bridge_unknown_has_messages'`) tam bütünlükle korunmuştur.
2. **Production Commit Hangi SHA?**
   - **Local `main` HEAD**: `13e71a6fc55e93cb0eccafb33c5f0d4ba0fdd50a`
   - **GitHub `origin/main`**: `13e71a6fc55e93cb0eccafb33c5f0d4ba0fdd50a`
   - **Production `/opt/tezlify` HEAD**: `6221ee8ec0c1aa745a4ce784ec9241f85e20a158`
   - **Production `.deployed-commit`**: `6221ee8ec0c1aa745a4ce784ec9241f85e20a158`
   - **Açıklama**: `6221ee8` ile `13e71a6` arasındaki tek fark dokümantasyon dosyasıdır (`reports/whatsapp-phase-7.1-quarantine-recovery.md`). Kod bazında production, GitHub `origin/main` ile %100 birebir aynıdır.
3. **Gerçek PostgreSQL Testi Yapıldı mı?**
   - **Yanıt**: **Birim testler SQLite üzerinde koşulmuştur (11/11 PASS); gerçek PostgreSQL 17 test koşumu harness uyumsuzluğu nedeniyle `BLOCKED` durumundadır.**
   - **Açıklama**: `backend/tests/test_whatsapp_quarantine_recovery.py` test harness'ındaki `_cleanup` fixture'ı SQLite için yazılmıştır (`CREATE TABLE lid_mappings`). Gerçek PostgreSQL 17 üzerinde çalıştırıldığında, `reconciliation.py` modülünün PostgreSQL'e özgü `whatsapp_private.lid_mappings` şemasına bakması ve `whatsapp_sessions` ID dizisi çakışması nedeniyle test harness düzeyinde hata alınmıştır (2 PASS, 9 FAIL). Bu aşamada kodlama yasağı (`KODLAMA: HAYIR`) bulunduğu için test fixture'ı değiştirilmemiş ve gerçek durum dürüstçe raporlanmıştır. Buna karşılık, deploy sürecinde (`release.sh`) PostgreSQL 17 üzerinde izole klon (`tezlify_cand_*`) ile şema migrasyonu ve backend açılışı başarıyla doğrulanmıştır.

---

## 2. GİT VE PRODUCTION COMMIT DOĞRULAMASI

| Ortam / Referans | SHA | Mesaj / Not |
| :--- | :--- | :--- |
| **Local `main`** | `13e71a6fc55e93cb0eccafb33c5f0d4ba0fdd50a` | `docs: add phase 7.1 quarantine recovery report` |
| **GitHub `origin/main`** | `13e71a6fc55e93cb0eccafb33c5f0d4ba0fdd50a` | Local ile tam senkron |
| **Production `/opt/tezlify`** | `6221ee8ec0c1aa745a4ce784ec9241f85e20a158` | `fix(whatsapp): recover quarantined identity messages` |
| **Production `.deployed-commit`** | `6221ee8ec0c1aa745a4ce784ec9241f85e20a158` | Production commit ile tam uyumlu |

**Fark Denetimi**:
```bash
git diff 6221ee8ec0c1aa745a4ce784ec9241f85e20a158..13e71a6fc55e93cb0eccafb33c5f0d4ba0fdd50a --stat
# Çıktı: reports/whatsapp-phase-7.1-quarantine-recovery.md | 210 ++++++++++++++++++++++
# 1 file changed, 210 insertions(+)
```
Sonuç: Çalışan kod dosyalarında (`backend/`, `whatsapp-gateway/`, `frontend/`) hiçbir fark yoktur.

---

## 3. PRODUCTION POSTGRESQL VERİ VE KARANTİNA DENETİMİ

Production veritabanında (`PostgreSQL 17.11 on aarch64-unknown-linux-musl`) yalnızca salt okunur `SELECT` sorguları çalıştırılmıştır:

### 3.1 Karantina Tablosu Durumu
```sql
SELECT id, contact_id, conversation_id, phone_e164, status, reason, message_count, created_at, resolved_at 
FROM whatsapp_identity_quarantine;
```
- **Kayıt**: 1 adet
- **ID**: `1`
- **Contact ID**: `23776`
- **Conversation ID**: `38415`
- **Phone / JID**: `jid:218107046027315@lid`
- **Status**: `QUARANTINED`
- **Reason**: `bridge_unknown_has_messages`
- **Message Count**: `9`
- **Resolved At**: `NULL`

### 3.2 Seyma Aden Kontak ve Sohbet Kayıtları
- **Kontak (ID: 23776)**:
  - `display_name`: `Seyma Aden`
  - `phone_e164`: `jid:218107046027315@lid`
  - `custom_attributes`: `{"name_source": "addressbook"}`
- **Sohbet (ID: 38415)**:
  - `session_id`: `201`
  - `contact_id`: `23776`
  - `channel`: `WHATSAPP`
  - `status`: `ACTIVE`
  - `is_archived`: `false`
  - `unread_count`: `0`

### 3.3 9 Adet Mesajın Bütünlük Kontrolü
```sql
SELECT id, conversation_id, direction, message_type, wa_message_id, timestamp, has_media, length(content) 
FROM messages WHERE conversation_id = 38415 ORDER BY id ASC;
```
| ID | Yön | Tip | Timestamp | wa_message_id | Medya | Boyut |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `161406` | INBOUND | TEXT | 2026-10-09 17:15:20 | `3EB0...` | Hayır | 31 bayt |
| `161407` | INBOUND | TEXT | 2026-10-09 17:15:35 | `3EB0...` | Hayır | 25 bayt |
| `161408` | OUTBOUND | TEXT | 2026-10-09 17:16:01 | `3EB0...` | Hayır | 48 bayt |
| `161409` | INBOUND | TEXT | 2026-10-09 17:16:22 | `3EB0...` | Hayır | 18 bayt |
| `161410` | INBOUND | TEXT | 2026-10-09 17:20:04 | `3EB0...` | Hayır | 42 bayt |
| `161411` | INBOUND | TEXT | 2026-10-09 17:21:15 | `3EB0...` | Hayır | 12 bayt |
| `161412` | INBOUND | TEXT | 2026-10-09 17:22:30 | `3EB0...` | Hayır | 55 bayt |
| `161413` | INBOUND | TEXT | 2026-10-09 17:25:11 | `3EB0...` | Hayır | 29 bayt |
| `161414` | INBOUND | TEXT | 2026-10-09 17:28:44 | `3EB0...` | Hayır | 34 bayt |

- **Bütünlük**: Mesaj ID'leri, içerikleri, zaman damgaları ve yönleri eksiksiz korunmaktadır. Hiçbir mesaj silinmemiş, taşınmamış veya değiştirilmemiştir.

### 3.4 Gateway LID Tablosu
```sql
SELECT * FROM whatsapp_private.lid_mappings WHERE lid_jid = '218107046027315@lid';
```
- **Kayıt**: 0 satır.
- WhatsApp protokolü bu numara için eşleşme bildirmediği sürece mesajların karantinada kalması kurala (%100) uygundur.

---

## 4. PRODUCTION SAĞLIK VE CANLI SERVİS DOĞRULAMASI

### 4.1 Konteyner Durumları
```text
NAMES             STATUS                    PORTS
tezlify-gateway   Up 15 minutes (healthy)   8787/tcp
tezlify-backend   Up 15 minutes (healthy)   8000/tcp
tezlify-caddy     Up 3 weeks (healthy)      0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
tezlify-db        Up 4 weeks (healthy)      5432/tcp
```

### 4.2 Caddy Edge ve Doğrudan Backend `/health` Yanıtı
Hem Caddy üzerinden (`https://tezlify.com/health`, `http://tezlify.com/health`) hem de doğrudan backend konteynerinden (`http://127.0.0.1:8000/health`) 200 OK yanıtı alınmıştır:
```json
{
  "status": "healthy",
  "service": "Tezlify Backend API",
  "version": "1.0.0",
  "gateway_bridge": {
    "connected": true,
    "last_connected_at": "2026-11-04T08:42:28.116434+00:00",
    "last_event_at": "2026-11-04T08:52:28.144607+00:00",
    "last_pong_at": "2026-11-04T08:52:28.144643+00:00",
    "reconnect_count": 1
  },
  "whatsapp_identity_sweep": {
    "runs": 1,
    "merged_total": 0,
    "deferred_total": 0,
    "quarantine_recovered_total": 0,
    "errors_total": 0,
    "last_duration_ms": 18.678,
    "lock_contended_total": 0
  },
  "whatsapp_identity_quarantine": {
    "available": true,
    "quarantined": 1,
    "with_messages": 1,
    "messages_held": 9,
    "by_reason": {
      "bridge_unknown_has_messages": 1
    }
  }
}
```

### 4.3 WhatsApp Oturum Durumu
```sql
SELECT id, session_name, phone_number, status, is_phone_online, updated_at 
FROM whatsapp_sessions WHERE id = 201;
```
- **ID**: `201` (`Hat 1`)
- **Telefon**: `+905413749073`
- **Durum**: `CONNECTED`
- **Telefon Çevrimiçi**: `true`

### 4.4 Konteyner Log Analizi
- **Backend**: `docker logs --tail 40 tezlify-backend` incelenmiş; 0 unhandled exception, 0 restart, düzenli `/health` 200 OK erişimleri kaydedilmiştir.
- **Gateway**: `docker logs --tail 40 tezlify-gateway` incelenmiş; Baileys app-state senkronizasyonu ve outbox event gönderimi (`event_outbox_batch_sent`) kesintisiz çalışmaktadır.

---

## 5. GERÇEK POSTGRESQL TEST KANITI DEĞERLENDİRMESİ

AŞAMA 7.1'de yazılan 11 adet kurtarma senaryo testi incelenmiştir:

1. **SQLite Durumu**:
   - `conftest.py` varsayılan SQLite üzerinde 11 testin tamamı geçmektedir (`11 passed in 1.45s`).
2. **PostgreSQL 17.11 Durumu**:
   - Yerel PostgreSQL 17.11 üzerindeki izole test veritabanında (`tezlify_test_isolated`) çalıştırılmıştır:
     ```bash
     DATABASE_URL="postgresql+asyncpg://...@localhost:5432/tezlify_test_isolated" pytest backend/tests/test_whatsapp_quarantine_recovery.py
     ```
   - **Sonuç**: 2 test PASSED (`test_10`, `test_11`), 9 test FAILED.
   - **Kök Neden**:
     1. Test dosyasındaki `_cleanup` fixture'ı SQLite varsayımıyla `CREATE TABLE IF NOT EXISTS lid_mappings` (şemasız) çalıştırmaktadır. Ancak PostgreSQL üzerinde `reconciliation.py` modülü `whatsapp_private.lid_mappings` özel şemasına sorgu atmaktadır (`relation "whatsapp_private.lid_mappings" does not exist`).
     2. PostgreSQL'deki `whatsapp_sessions` otomatik artan ID dizisi (`sequence`), test öncesi temizlenmediği için `duplicate key value violates unique constraint "whatsapp_sessions_pkey"` hatası üretmiştir.
3. **Kural ve Sınır Koruması**:
   - AŞAMA 7.1-F kapsamında **KODLAMA: HAYIR** kuralı geçerlidir.
   - Test harness'ı veya kaynak kod değiştirilmemiştir.
   - SQLite sonuçları kesinlikle PostgreSQL sonucu gibi yanıltıcı şekilde sunulmamıştır (`Truthfulness` kuralı).
   - Bu durum dürüstçe `BLOCKED (Harness Dialect Mismatch)` olarak kayda geçirilmiştir.

---

## 6. KOD ÇAĞRI ZİNCİRİ VE GÜVENLİK MEKANİZMASI DOĞRULAMASI

1. **Canlı Yol (`lid_mapped` Olayı)**:
   - Baileys gateway bir LID için telefon numarasını öğrendiğinde WebSocket `/ws/gateway` üzerinden `lid_mapped` eventi yayar.
   - `WhatsAppEventOrchestrator._handle_lid_mapped_event()` eventi karşılar.
   - `recover_quarantined_identities(db, session_id, lid_jid, phone_jid)` fonksiyonunu çağırır.
   - İlgili kayıt `RECOVERED` durumuna geçirilir, mesajlar yeni sohbete bağlanır, işlem audit tablosuna kaydedilir.
2. **15 Dakikalık Periyodik Süpürme (Periodic Sweep)**:
   - Arka planda koşan `run_identity_sweep_once()` periyodik olarak `candidate_quarantine_recovery_pairs()` fonksiyonunu çalıştırır.
   - Henüz canlı yoldan kurtarılamamış ancak veritabanına sonradan eklenmiş eşlemeleri tarar ve topluca çözer.
3. **Açılış Kurtarması (Startup Sweep)**:
   - Backend başladığında ilk süpürme 30 saniye sonra otomatik tetiklenir. Health metric'lerinde `whatsapp_identity_sweep.runs = 1` ve `duration = 18.67ms` olarak başarıyla kaydedilmiştir.
4. **Çok Kiracılı ve Oturum Yalıtımı (Tenant/Session Isolation)**:
   - Sorgular kesin olarak `user_id` ve `session_id` ile filtrelenmektedir. Farklı bir kullanıcının veya oturumun LID eşlemesi Seyma Aden'in karantinasını açamaz.
5. **Belirsizlikte Güvenli Kapanma (Fail-Closed Ambiguity)**:
   - Birden fazla telefon numarası adayı çıkarsa kurtarma işlemi durdurulur ve karantina korunur.

---

## 7. NİHAİ DEĞERLENDİRME VE KLASİFİKASYON

| Kriter | Durum | Açıklama |
| :--- | :---: | :--- |
| Production Commit Bütünlüğü | **TAM** | Kod `origin/main` ile bit düzeyinde aynı (`6221ee8`) |
| Karantinadaki Mesaj Bütünlüğü | **TAM** | Seyma Aden'e ait 9 mesaj kayıpsız ve güvenle karantinada |
| Canlı Sistem ve Session Sağlığı | **TAM** | Caddy, Backend, Gateway, PostgreSQL ve Session 201 UP & HEALTHY |
| Fail-Closed Güvenlik Kuralı | **TAM** | Tahmini eşleme yapılmadı, WhatsApp protokolü bekleniyor |
| PostgreSQL Test Harness Uyumsuzluğu | **NOT** | Test fixture'ı SQLite şema adlandırması kullandığı için izole PG test koşumu harness düzeyinde engellendi |

**Nihai Karar**: `PASS_WITH_NOTES`

