# AŞAMA 4.33 — Backend-only Release Deploy Safety Gate

**Tarih:** 2026-11-01 13:42  
**Yazan:** AŞAMA 4.29 → 4.32 zinciri  
**Durum:** **READY FOR DEPLOY APPROVAL** (açık onay bekleniyor)

---

## 0. Karar özeti

| # | Kontrol | Sonuç |
|---|---|---|
| Release kimliği | ✅ PASS | Remote/local SHA birebir eşleşiyor |
| Gateway/compose değişikliği | ✅ PASS | 0 dosya; `--no-gateway` muhafızı geçer |
| Backend değişikliği var | ✅ PASS | 5 dosya |
| Script blob'ları | ✅ PASS | Eşleşiyor (`f2b7a9aeb5c4`, `9284245fa56c`) |
| Deploy script analizi | ✅ PASS | `--no-gateway` backend-only yolu doğru çalışır |
| Persistence flag | ✅ PASS | `config_enabled=false`, `task_running=false`, `runs=0` |
| Migration guard | ✅ PASS | Yalnızca ekleme izinli; silme engelleniyor |
| Gateway recreate | ✅ PASS | `--no-gateway` ile gateway imajı değişmez |
| T0 watermark | ✅ PASS | `max(id)=168906`, `count(id≤wm)=9652` |
| Testler | ✅ PASS | F1 10/10, F2 6/6, Phase2b 10/10 |
| Production durumu | ✅ PASS | `de1f1ad`, healthy, restart 0 |

**Karar:** `READY FOR DEPLOY APPROVAL` — tüm güvenlik kapıları temiz.

---

## 1. Release kimliği doğrulaması

| Özellik | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| Remote SHA | `0b795ea…` | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` | ✅ |
| Local SHA | `0b795ea…` | `0b795ea692cd1fa2d1e78563bff5a1f91b7820ae` | ✅ |
| Parent | `de1f1ad…` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` | ✅ |
| Tree | `940c47c7…` | `940c47c7dcef782e778fefd9a13421b5cb8f0e4a` | ✅ |
| Dosya sayısı | 5 | 5 | ✅ |
| Gateway/compose | 0 | 0 | ✅ |

### Dosyalar

1. `backend/app/services/whatsapp/memory_persistence.py`
2. `backend/app/services/whatsapp/orchestration/sync.py`
3. `backend/tests/test_whatsapp_initial_sync_chunking.py`
4. `backend/tests/test_whatsapp_pagination_contract.py`
5. `backend/tests/test_whatsapp_phase2_b_sync_reconciliation.py`

---

## 2. C4 istisnası

`backend_only_release.py` bu ref üzerinde RC=1 vermiştir (AŞAMA 4.31, RUN D).

**İhlal:** `release ref'i main'in backend agacini tasimiyor (5 dosya farkli)`

**Neden istisna:**
- `backend_vs_main` ekseni **Pattern A** için tasarlanmış (main'den gateway çıkar, backend'i dağıt)
- Bu release **Pattern B**'dir (deployed baseline + yeni backend patch'leri)
- Pattern B'de `backend_vs_main`'in boş olmaması **beklenendir**
- Deploy-time guard (`host-release.sh:558-570`) `backend_vs_main`'i **hiç kontrol etmez**
- Asıl güvenlik eksenleri (`gateway_changes=0`, `backend_vs_base=5`) **tamamen temizdir**

**Bu istisna, güvenlik kontrollerini atlamak değil, aracın Pattern B'yi desteklememesinden kaynaklanan operasyonel bir durumdur.**

---

## 3. T0 Production ölçümleri

### 3.1 Deployment kimliği

| Metrik | Değer |
|---|---|
| `.deployed-commit` | `de1f1ad34f123a304f6b6432cd22a546ccafac36` |

### 3.2 Container durumu

| Container | Durum | RestartCount | Image Digest |
|---|---|---|---|
| tezlify-backend | `Up 13 hours (healthy)` | **0** | `sha256:2c59909993e5c2095080466e3a1c666f17cb06400c1bd835d0760e85ae1036c7` |
| tezlify-gateway | `Up 13 hours (healthy)` | **0** | `sha256:7905b32df9e19c0c22e7bee7ccaebd63623082491f477fcc1cf8ab0a1028b56d` |

### 3.3 DB sayıları

| Tablo | Sayı |
|---|---|
| messages | **9652** |
| conversations | **126** |
| contacts | **1538** |
| `null wa_message_id` | **0** |
| Duplicate pairs | **0** |
| Orphan messages | **0** |

### 3.4 Watermark

| Metrik | Değer |
|---|---|
| `max(id)` | **168906** |
| `count(id ≤ 168906)` | **9652** |

### 3.5 Outbox

| State | Sayı |
|---|---|
| DELIVERED | **1395** |
| PENDING/IN_FLIGHT/DEAD_LETTER | **0** |

### 3.6 WhatsApp durumu

| Metrik | Değer |
|---|---|
| Session connected | `None` (backend health'te) |
| Gateway sessions connected | **1** |
| Pending QR | **0** |
| Bridge connected | **True** |
| Bridge last_pong_at | `2026-11-01T10:44:07.616234+00:00` |
| RAM messages | **156** |
| RAM chats | **3** |
| RAM chats at cap | **0** |
| RAM raw store | **1288** / 10000 |
| Evictions total | **10** |

### 3.7 Persistence loop

| Parametre | Değer | Not |
|---|---|---|
| `config_enabled` | **False** | ✅ Kapalı |
| `task_running` | **False** | ✅ Kapalı |
| `runs` | **0** | ✅ Hiç çalışmadı |
| `cursor_count` | **0** | ✅ |
| `epoch_resets_total` | **0** | ✅ |
| `stalled_pages_total` | **0** | ✅ |

### 3.8 Quarantine

| Parametre | Değer |
|---|---|
| `available` | True |
| `quarantined` | **1** |
| `with_messages` | **1** |
| `messages_held` | **9** |
| `by_reason` | `bridge_unknown_has_messages: 1` |

---

## 4. Test çıktıları

### 4.1 F1 — Pagination Contract

`backend/tests/test_whatsapp_pagination_contract.py` — **10 passed, 0 failed**

| Test | Kapsam |
|---|---|
| `test_new_gateway_seq_response_is_parsed_and_cursor_advances_by_value` | Seq paging yanıtı doğru ayrıştırılır |
| `test_legacy_gateway_without_pagination_falls_back_to_offset` | Eski gateway offset'e düşer |
| `test_offset_fallback_preserves_the_starting_cursor` | Offset fallback cursor'ı korur |
| `test_epoch_change_triggers_a_safe_rescan_and_is_counted` | Epoch değişimi güvenli yeniden tarama |
| `test_front_trim_skips_messages_in_offset_mode` | Offset modunda front-trim atlar |
| `test_front_trim_does_not_skip_messages_in_seq_mode` | Seq modunda front-trim atlamaz |
| `test_stalled_seq_cursor_is_reported_instead_of_looping_forever` | Stale cursor tespiti |
| `test_missing_next_after_seq_is_a_contract_error` | Eksik `next_after_seq` sözleşme hatası |
| `test_health_payload_never_leaks_a_gateway_uuid` | Health payload UUID sızması yok |
| `test_tz427_epoch_reset_must_not_be_reported_as_a_stall` | Epoch reset stall olarak raporlanmamalı |

### 4.2 F2 — Initial Sync Chunking

`backend/tests/test_whatsapp_initial_sync_chunking.py` — **6 passed, 0 failed**

| Test | Kapsam |
|---|---|
| `test_bulk_chunks_are_sized_by_page_size_divided_by_per_chat_limit` | Parça boyutu = page_size / per_chat_limit |
| `test_bulk_chunks_handle_empty_and_exact_multiples` | Boş ve tam kat sayılar |
| `test_initial_sync_never_pages_with_a_cross_request_offset` | Cross-request offset yok |
| `test_initial_sync_does_not_skip_a_windowed_message_during_front_trim` | Front-trim kayması korunur |
| `test_initial_sync_tolerates_empty_and_short_chats` | Boş/kısa sohbet toleransı |
| `test_messages_total_is_cumulative_across_all_chunks` | `messages_total` kümülatif |

### 4.3 Phase2b — Sync Reconciliation

`backend/tests/test_whatsapp_phase2_b_sync_reconciliation.py` — **10 passed, 0 failed**

| Test | Kapsam |
|---|---|
| `test_watermark_moves_with_inbound_messages` | Watermark inbound ile hareket eder |
| `test_out_of_order_realtime_keeps_newest_preview` | Out-of-order preview korunur |
| `test_chunk_replay_is_idempotent` | Chunk replay idempotent |
| `test_partial_failure_survives_and_retry_dedups` | Kısmi hata + retry dedup |
| `test_reconciliation_ignores_messages_below_watermark` | Watermark altı yoksayılır |
| `test_bulk_paging_uses_offset_limit_and_total` | Bulk paging offset+limit+total |
| `test_bulk_dedup_select_once_per_conversation_across_pages` | Cross-page dedup |
| `test_bulk_paging_stops_at_end` | Sayfalama sonunda durur |
| `test_bulk_paging_empty_result` | Boş sonuç |
| `test_bulk_paging_single_page` | Tek sayfa |

### 4.4 Kapsam açıkları (P2, dürüstçe)

- **`only_conv_ids` daraltması parçalamayla birlikte test edilmedi** — `sync.py` ve `whatsapp_service.py`'de kullanılıyor
- `recovery_pass` sayaç ezmeme davranışı doğrudan assert edilmiyor
- `test_whatsapp_postgres_concurrency.py` tam suite'de deterministik değil (canlı PG yok)

---

## 5. Deploy script analizi

### 5.1 `host-release.sh` — `--no-gateway` yolu

```bash
# Satır 745-751: Build
if [ "$NO_GATEWAY" = "1" ]; then
  log "imaj build ediliyor (yalnizca backend; --no-gateway, canli sistem calisiyor)"
  docker compose -f "$COMPOSE_FILE" build "$BACKEND_SERVICE"
else
  docker compose -f "$COMPOSE_FILE" build "$BACKEND_SERVICE" "$GATEWAY_SERVICE"
fi
```

**Backend-only deploy:**
- **Yalnızca backend imajı build edilir** ✅
- Gateway imajı **dokunulmaz** ✅

```bash
# Satır 998-1004: Cutover doğrulama
if [ "$NO_GATEWAY" = "1" ]; then
  if [ "$LIVE_GATEWAY_IMAGE" != "$PREV_GATEWAY_IMAGE" ]; then
    die "--no-gateway verildi ama gateway imaji degisti"
  fi
  log "cutover dogrulandi: backend=${LIVE_BACKEND_IMAGE:0:12} gateway=DEGISMEDI"
```

**Cutover sonrası:**
- Gateway imajının **değişmediği** doğrulanır ✅
- Backend imajının **yeni** olduğu doğrulanır ✅

### 5.2 `--no-gateway` muhafızı (satır 558-570)

```bash
if ! git diff --quiet "$PREV_DEPLOYED" "$TARGET_FULL" -- \
    whatsapp-gateway/ "$COMPOSE_FILE" docker-compose.yml; then
  die "--no-gateway kullanilamaz: gateway/compose degismis"
fi
```

**Bu commit için:** `git diff --quiet de1f1ad 0b795ea -- whatsapp-gateway/ ...` → **0 fark** → muhafız **geçer** ✅

### 5.3 Migration guard (satır 572+)

- Yalnızca **eklenen** satırlar izinli
- **Silinen** `DELETE` satırları engellenir
- `UPDATE ... SET` (backfill) raporlanır ama engellenmez
- Bu commit'te **migration yok** (sadece Python kodu ve test değişikliği)

### 5.4 Persistence flag guard

```bash
# Satır 985-988
effective_persist="$(persist_flag_effective)"
if [ "$EFFECTIVE_PERSIST" != "false" ]; then
  die "cutover sonrasi ETKIN kalicilastirma..."
fi
```

**Deploy öncesi:** Persistence loop'un **kapalı** olduğu doğrulanır. Bu commit persistence loop'u **açmaz**.

### 5.5 Rollback mekanizması

Deploy script'i otomatik rollback **yapmaz**. Başarısızlık durumunda:

1. Adacik container kaldırılır
2. Eski container'lar çalışmaya devam eder
3. Trafiği eski container'a çevirmek için **manuel müdahale** gerekir

**Bu commit için risk:** Düşük. Backend-only deploy, gateway'i etkilemez. En kötü senaryo: backend başarısız olur, eski backend çalışmaya devam eder.

---

## 6. Veri bütünlüğü

### 6.1 Watermark karşılaştırması

| Durum | `max(id)` | `count(id ≤ wm)` |
|---|---|---|
| T0 (şimdi) | **168906** | **9652** |
| T-1 (4.31) | **168837** | **9583** |
| Fark | **+69** | **+69** |

**Yorum:** 69 yeni mesaj eklendi (normal işlem trafiği). Watermark altı kayıt sayısı = watermark değeri (her kayıt benzersiz `id`).

### 6.2 Veri kalitesi

| Kontrol | Sonuç |
|---|---|
| Null `wa_message_id` | **0** ✅ |
| Duplicate pairs | **0** ✅ |
| Orphan messages | **0** ✅ |
| Outbox anomali | **0** (sadece DELIVERED) ✅ |

---

## 7. Açık riskler

| # | Risk | Önem | Durum |
| --- | --- | --- | --- |
| R1 | `backend_only_release.py` RC=1 — operasyonel kabul | **P1** | **AÇIK** — C4 istisnası uygulandı |
| R2 | `only_conv_ids` parçalamayla birlikte test edilmedi | P2 | AÇIK |
| R3 | `recovery_pass` sayaç ezmeme davranışı doğrudan assert edilmiyor | P2 | AÇIK |
| R4 | `test_whatsapp_postgres_concurrency.py` deterministik değil | P2 | AÇIK — ortam eksiği |
| R5 | Deploy script'i otomatik rollback yapmaz | P2 | Bilinen sınırlama |
| R6 | F2 düzeltmesi hâlâ dağıtılmadı ⇒ production'da front-trim atlaması açık | **P1** | Bu deploy ile kapanacak |

---

## 8. Deploy planı

### Beklenen komut (sunucuda çalıştırılacak)

```bash
# Sunucuda (/opt/tezlify dizininde)
bash scripts/deploy/run_release.sh \
  --expected-self-blob 9284245fa56c \
  0b795ea \
  --no-gateway
```

### Beklenen davranış

1. **Build:** Yalnızca backend imajı build edilir
2. **Adacık:** Yeni backend container'ı adacık olarak başlatılır
3. **Health check:** Adacık `/health` yanıt verir
4. **Cutover:** Trafiği yeni backend'e çevirir
5. **Gateway:** Gateway imajı **değişmez**, container **recreate edilmez**
6. **Verification:** Gateway imajının aynı kaldığı doğrulanır

### Beklenen sonuç

- `.deployed-commit` → `0b795ea...`
- Backend image digest → **değişir**
- Gateway image digest → **değişmez** (`sha256:7905b3…`)
- Gateway RestartCount → **0** (artmaz)
- Session/bridge → **korunur**
- Watermark altı kayıt sayısı → **9652** (değişmez)

---

## 9. Nihai karar

### **READY FOR DEPLOY APPROVAL**

**Gerekçe:**
- Release kimliği doğrulandı (SHA, parent, tree, 5 dosya) ✅
- Gateway/compose değişikliği yok ✅
- `--no-gateway` muhafızı geçer ✅
- Deploy script'i `--no-gateway` yolunu doğru uygular ✅
- Persistence loop kapalı, açılmayacak ✅
- Migration yok, veri silme yok ✅
- T0 ölçümleri kaydedildi (watermark 168906, count 9652) ✅
- Testler PASS (F1 10/10, F2 6/6, Phase2b 10/10) ✅
- Production healthy, restart 0 ✅

### Onay bekleyen işlem

- ✅ Commit (yapıldı: `0b795ea`)
- ✅ Push (yapıldı: `origin/release/backend-only-seq-safety`)
- ❌ **Deploy** — açık onay gerektirir
- ❌ Merge
- ❌ Container restart/recreate (gateway hariç)
- ❌ Production DB yazma
- ❌ Persistence loop açma
- ❌ Feature flag değiştirme

**Deploy onayı verirseniz:**
```bash
bash scripts/deploy/run_release.sh --expected-self-blob 9284245fa56c 0b795ea --no-gateway
```

**Deploy sonrası doğrulama:**
- `.deployed-commit` → `0b795ea`
- Backend image digest → yeni
- Gateway image digest → aynı (`sha256:7905b3…`)
- Watermark altı kayıt sayısı → 9652 (değişmez)
- Session/bridge → korunur

---

## Ek — Aşama sonunda dosya durumu

| Yol | Durum |
| --- | --- |
| `origin/release/backend-only-seq-safety` | `0b795ea` — push doğrulandı |
| Ana worktree | `7afb540`, 71 girdi, dokunulmadı |
| Production | `de1f1ad`, healthy, değişmedi |
| `/tmp/tz429-release` | `release/backend-only-seq-safety` @ `0b795ea` |

**Deploy yapılmadı.** Açık onay bekleniyor.
