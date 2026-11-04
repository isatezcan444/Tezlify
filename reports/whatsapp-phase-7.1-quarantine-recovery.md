# AŞAMA 7.1 — WhatsApp Identity Quarantine Kurtarma ve Veri Güvenliği Raporu

**Tarih**: 2026-11-04  
**İşlem Türü**: Geliştirme, Test, Dağıtım ve Canlı Doğrulama  
**Kapsam**: AŞAMA 7.1 — `whatsapp_identity_quarantine` P0 Güvenli Kurtarma Mekanizması  
**Sonuç**: `PASS`

---

## 1. Yürütücü Özeti ve Hedef

AŞAMA 7.0 genel denetiminde tespit edilen P0 seviyesindeki karantina mekanizması eksikliği giderilmiştir.

### Tespit Edilen Problem (Kök Neden)
`purge_raw_jid_identity_data` aşamasında telefon köprüsü henüz bilinmeyen LID kimlikleri silinmek yerine `whatsapp_identity_quarantine` tablosunda tutuluyordu. Ancak:
1. `models/whatsapp_identity_quarantine.py` tablosunda `QUARANTINED` -> `RESOLVED` geçişi belgelenmiş olmasına rağmen kod tabanında hiçbir fonksiyon bu kaydı `RESOLVED` durumuna geçirmiyordu.
2. `lid_mapped` olayı veya `lid_mappings` tablosundaki köprü bilgisi öğrenildiğinde mevcut karantina kayıtları değerlendirilmiyor ve kurtarılmıyordu.
3. Arka plan süpürme döngüsü (`run_identity_sweep_once`) ve startup adımı yalnızca `conversations.is_archived = false` olan sohbetleri birleştiriyor, karantina defterini incelemiyordu.

### AŞAMA 7.1 ile Getirilen Çözüm
1. **Güvenli Aday Seçimi (`candidate_quarantine_recovery_pairs`)**:
   - Yalnızca `status = 'QUARANTINED'` kayıtları taranır (`RESOLVED` ve `RELEASED` kayıtlar atlanır).
   - **Kiracı İzolasyonu**: Köprü eşleşmesi yalnızca kaydın sahibi olan `user_id` oturumundan gelebilir.
   - **Oturum Kapsamı**: Sohbet bir oturuma bağlıysa (`session_id`), eşleşme kesinlikle o oturumun `gateway_id` değerine ait olmalıdır.
   - **Belirsizlik Koruması (Ambiguity Guard)**: Bir LID için geçerli kapsamda birden çok farklı telefon numarası bulunursa otomatik birleştirme yapılmaz, kayıt karantinada tutulur ve loglanır.
2. **İşlem Güvenliği ve Mesaj Bütünlüğü (`recover_quarantined_record`)**:
   - `merge_split_conversation` motoru kullanılarak mesajlar kanonik sohbete taşınır.
   - Mesaj timestamp'leri, yönleri (INBOUND/OUTBOUND), gövdesi ve medya meta verileri eksiksiz korunur.
   - Mükerrer `wa_message_id` durumunda durum rütbesi yüksek olan korunur; yeni mesaj kopyaları tekilleşir.
   - Eski LID sohbeti silinmez, arşivlenir.
   - Karantina kaydı `status = 'RESOLVED'`, `updated_at = NOW()` ve detaylı audit JSON'u (`canonical_conversation_id`, `resolved_phone_jid`, `moved_unique`) ile güncellenir.
   - Hata durumunda işlem transaction düzeyinde `rollback` edilir; hiçbir mesaj kaybolmaz.
3. **Canlı Yol Entegrasyonu (`_ingest_lid_mapped`)**:
   - Canlı WebSocket üzerinden gateway'den `lid_mapped` olayı geldiğinde, ilgili kullanıcının karantinadaki kayıtları anında çözülür.
4. **Periyodik ve Boot Taraması (`run_identity_sweep_once` & `main.py`)**:
   - 15 dakikalık periyodik arka plan döngüsüne 3. faz olarak karantina kurtarma taraması eklendi.
   - Uygulama yeniden başlatıldığında (`lifespan`), köprüsü öğrenilmiş tüm karantina kayıtları otomatik taranıp kurtarılır.
5. **Operatör Teşhis ve Kontrollü Eşleme Aracı (`scripts/diagnostics/whatsapp_lid_split_repair.py`)**:
   - `--recover-quarantine` ve `--learn-bridge` parametreleri eklenerek kontrollü prosedür sağlandı.

---

## 2. Başlangıç Durumu Doğrulaması

İşleme başlamadan önce salt okunur olarak doğrulanan üretim durumu:

| Metrik / Bileşen | Başlangıç Değeri | Doğrulama Durumu |
| :--- | :--- | :--- |
| **Git Commit SHA** | `d755b4a82e57234e0b06a844f50639d3c462f8fc` | Local `HEAD`, `origin/main` ve prod birebir eşit |
| **İş Ağacı** | Clean (yalnızca denetim raporu untracked) | Doğrulandı |
| **Backend Container** | `tezlify-backend` (Up 12h, healthy) | Doğrulandı |
| **Gateway Container** | `tezlify-gateway` (Up 12h, healthy) | Doğrulandı |
| **PostgreSQL DB** | `tezlify-db` (Postgres 17, Up 4w, healthy) | Doğrulandı |
| **Caddy Proxy** | `tezlify-caddy` (Up 3w, healthy) | Doğrulandı |
| **Hedef Karantina Kaydı** | ID: 1, Contact: 23776 (`Seyma Aden`), Conv: 38415 | `QUARANTINED`, `bridge_unknown_has_messages`, 9 mesaj |
| **Aktif Oturum** | ID: 201, `Hat 1`, `+905413749073`, `CONNECTED` | Aktif ve çevrimiçi |

---

## 3. Kod Değişiklikleri ve Mimari Entegrasyon

### 3.1 `backend/app/services/whatsapp/reconciliation.py`
- `candidate_quarantine_recovery_pairs`: Karantinada bekleyen ve geçerli session/tenant kapsamında tekil köprüsü bulunan kayıtları çeker.
- `resolve_quarantine_row`: Tek bir karantina kaydını canlı yoldan veya teşhis betiğinden transaction güvenli biçimde `RESOLVED` durumuna geçirir.
- `recover_quarantined_record`: Karantina kaydını `merge_split_conversation` ile birleştirir, arşivler ve durumu günceller.
- `recover_quarantined_identities`: Bounded limit (`BOOT_MERGE_LIMIT = 200`) ile süpürme veya boot sırasında toplu kurtarma yürütür.
- `_SWEEP_STATE` & `run_identity_sweep_once`: Karantina kurtarma sayacı (`quarantine_recovered_total`) ve çalışma süresi eklendi.

### 3.2 `backend/app/services/whatsapp/orchestration/events.py`
- `_ingest_lid_mapped`: Canlı yolda `reconcile_legacy_split_conversation` tamamlandıktan hemen sonra `_resolve_quarantine_row` çağrılarak karantinadaki kaydın gecikmesiz `RESOLVED` yapılması sağlandı.

### 3.3 `backend/app/main.py`
- `lifespan` startup rutinine `await recover_quarantined_identities(engine)` ve ardından `await quarantine_counts(engine)` eklendi.

### 3.4 `scripts/diagnostics/whatsapp_lid_split_repair.py`
- `--recover-quarantine`: Karantina kurtarma taramasını doğrudan tetikler.
- `--learn-bridge`: Operatörün fiziksel olarak doğruladığı LID -> Telefon köprüsünü güvenle `lid_mappings` tablosuna yazar.
- `repair_lid_splits` içine `resolve_quarantine_row` entegre edildi.

---

## 4. Test Doğrulaması

### 4.1 AŞAMA 7.1 Özel Test Paketi (`backend/tests/test_whatsapp_quarantine_recovery.py`)
Belirtilen 10 senaryonun tamamı otomatik testlerle kanıtlanmıştır:

```
backend/tests/test_whatsapp_quarantine_recovery.py::test_01_unmapped_lid_message_stays_quarantined PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_02_learned_lid_mapping_recovers_quarantined_messages PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_03_wrong_session_mapping_does_not_recover PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_04_tenant_isolation_prevents_cross_tenant_recovery PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_05_ambiguous_mappings_prevent_recovery PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_06_recovery_is_idempotent PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_07_transaction_rollback_on_failure_preserves_data PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_08_restart_recovery_scans_and_recovers PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_09_message_timestamps_direction_and_content_preserved PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_10_already_resolved_or_released_records_ignored PASSED
backend/tests/test_whatsapp_quarantine_recovery.py::test_11_live_path_ingest_lid_mapped_resolves_quarantine PASSED

======================== 11 passed, 6 warnings in 0.73s ========================
```

### 4.2 WhatsApp Kimlik ve Birleştirme Regresyon Paketi (68 Test)
- `test_whatsapp_identity_quarantine.py`: 11 PASSED
- `test_whatsapp_boot_lid_merge.py`: 26 PASSED
- `test_whatsapp_session_scoped_lid_reconciliation_62.py`: 11 PASSED
- `test_whatsapp_lid_split_repair.py`: 5 PASSED
- `test_whatsapp_purge_defers_known_bridge.py`: 4 PASSED
- `test_whatsapp_quarantine_recovery.py`: 11 PASSED
**Toplam: 68 passed (0 failure) in 7.27s**

### 4.3 Genel Sistem Regresyon Paketi
- **Backend Test Suite**: `2354 passed, 8 skipped in 152.82s (0:02:32)`
- **Frontend Build**: `tsc && vite build` -> `built in 3.24s (0 errors)`
- **Gateway Test Suite**: `19 passed, 8 skipped, 8 suites passed (0 errors)`

---

## 5. Dağıtım ve Üretim Yaşam Döngüsü

1. **Pre-Deploy Veritabanı Yedeği**:
   - Sunucu üzerinde `/home/ubuntu/pre_phase_7_1_backup_20261104_083935.sql` (8.2 MB) oluşturuldu.
2. **Git Commit & Push**:
   - Commit SHA: `6221ee8ec0c1aa745a4ce784ec9241f85e20a158`
   - Mesaj: `fix(whatsapp): recover quarantined identity messages`
   - `origin/main` branch'ine başarıyla gönderildi.
3. **Hermetik Dağıtım (`scripts/deploy/release.sh`)**:
   - Dağıtım sürümü: `20261104T084034Z`
   - Migration guard: TEMİZ (yıkıcı migration satırı yok)
   - Adacık (canary) test: İzole DB (`tezlify_cand_20261104T084034Z`) üzerinde başarıyla test edildi. Üretim DB satır sayısı değişmedi: `129|10602|1540`.
   - Cutover: `docker compose up -d --force-recreate backend gateway` sorunsuz tamamlandı.
   - Frontend hash doğrulaması: Birebir eşleşti.

---

## 6. Canlı Üretim Doğrulaması

Dağıtım sonrasında canlı sistemde yapılan kontroller:

### 6.1 Konteyner Durumları
```
NAMES               STATUS                    PORTS
tezlify-gateway     Up (healthy)              8787/tcp
tezlify-backend     Up (healthy)              8000/tcp
tezlify-caddy       Up 3 weeks (healthy)      0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
tezlify-db          Up 4 weeks (healthy)      5432/tcp
```

### 6.2 Sistem Sağlık Yanıtı (`GET /health`)
```json
{
  "status": "healthy",
  "gateway_bridge": {
    "connected": true,
    "reconnect_count": 1
  },
  "whatsapp_identity_sweep": {
    "runs": 1,
    "merged_total": 0,
    "deferred_total": 0,
    "stranded_moved_total": 0,
    "still_stranded": 0,
    "quarantine_recovered_total": 0,
    "errors_total": 0,
    "duration_total_ms": 18.678
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

### 6.3 Seyma Aden Kaydının Durumu ve Veri Bütünlüğü
Canlı veritabanında sorgulandı:
- `whatsapp_identity_quarantine`: 1 kayıt (`id: 1`, `contact_id: 23776`, `conversation_id: 38415`, `phone_e164: 'jid:218107046027315@lid'`, `status: 'QUARANTINED'`, `message_count: 9`).
- `messages WHERE conversation_id = 38415`: Tam 9 mesaj (8 INBOUND, 1 OUTBOUND) orijinal timestamp ve gövdeleriyle güvenle korunmaktadır.
- WhatsApp oturumu (`Hat 1`, ID `201`): `status = CONNECTED`, `is_phone_online = true`.

### 6.4 Kontrollü Operatör Prosedürü
WhatsApp protokolü gereği Seyma Aden'in telefon numarası WhatsApp istemcisine henüz açıklanmadığı için (Senaryo 1 gereği) kayıt güvenle karantinada tutulmaktadır.
Operatör veya gateway tarafından bu numara öğrenildiğinde sistem:
- **Otomatik Canlı Yol**: Gateway'den `lid_mapped` olayı geldiğinde anında mesajları kanonik sohbete birleştirir ve karantina durumunu `RESOLVED` yapar.
- **Otomatik Arka Plan**: 15 dakikalık periyodik süpürme veya yeniden başlatmada `lid_mappings` tablosunu tarayarak otomatik kurtarır.
- **Manuel Kontrollü Prosedür**: Numara operatör tarafından teyit edildiğinde tek komutla kurtarılabilir:
  ```bash
  python3 scripts/diagnostics/whatsapp_lid_split_repair.py \
    --learn-bridge \
    --gateway-session-id 1bd78836-c084-4cbf-b333-9386d44b7bd7 \
    --lid 218107046027315@lid \
    --phone <telefon_numarası> \
    --recover-quarantine
  ```

---

## 7. Sonuç ve Sonraki Aşama Geçişi

AŞAMA 7.1 başarıyla tamamlanmıştır.
- Hiçbir veri kaybı yaşanmamıştır.
- Tüm testler (2354 backend + 68 WhatsApp identity + 11 quarantine recovery + gateway + frontend) %100 başarılıdır.
- Üretim ortamına hermetik olarak deploy edilmiş ve canlı sağlık probu doğrulanmıştır.
- Kurallar gereği AŞAMA 7.2'ye geçilmemiştir; kullanıcı talimatı beklenmektedir.

**Nihai Etiket**: `PASS`
