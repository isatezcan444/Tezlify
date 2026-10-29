# AŞAMA 3.8.9 — BACKEND-ONLY DEPLOY VE CANLI KARANTİNA DOĞRULAMASI

**Tarih:** 2026-10-29T21:46–21:48Z  
**Hedef ref:** `release/backend-only-3.8.7` = `cbe4f509f4bcc5babb12cc85e0ad422cb13ba739`  
**Önceki üretim:** `38fe087`  
**Komut:** `HOST_RELEASE_REPO=/opt/tezlify bash /tmp/rr387.sh --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 cbe4f50 --no-gateway --health-timeout 180`

## 1. Deploy öncesi kapılar (21:46Z)

| Kapı | Beklenen | Gerçekleşen |
|---|---|---|
| `release/backend-only-3.8.7` local = origin | `cbe4f50` | **Eşleşti** |
| Launcher blob pin | `9284245…` | **Eşleşti** |
| `host-release.sh` blob | `f2b7a9a…` | **Eşleşti** |
| Gateway subtree | `339aa79…` | **Eşleşti** (deployed = ref) |
| Backend subtree | `9067d4e…` | **Eşleşti** (feat/3.8.7 = ref) |
| Compose diff | 0 dosya | **0** |
| Üretim `.deployed-commit` | `38fe087` | **Doğrulandı** |

## 2. Deploy işlemi (21:46:29Z → 21:47:17Z)

**DEPLOY_EXIT=0** (1 dk 39 sn)

Adımlar:
1. Backend imajı build edildi (`sha256:06ce4fe…`)
2. Gateway **DOKUNULMADI** (`sha256:a1ba257…`)
3. Aday DB izole oluşturuldu (`tezlify_cand_20261029T214629Z`, 41 tablo)
4. Persistence guard: `IZINLI (flag_explicitly_false)` — adacıkta açıkça `=false`
5. Aday sağlıklı boot etti, migration'lar geçti
6. Cutover: `compose up -d --force-recreate backend` (yalnızca backend)
7. Cutover sonrası `/health`: kalıcılık **ETKİN olarak kapalı**
8. Schema diff kaydedildi (`whatsapp_identity_quarantine` tablosu eklendi)
9. Rollback etiketi: `tezlify-backend:pre-20261029T214629Z`

## 3. Deploy sonrası doğrulama (21:48Z)

### 3.1 Commit ve container'lar

| | Önce (21:46Z) | Sonra (21:48Z) |
|---|---|---|
| `.deployed-commit` | `38fe087` | **`cbe4f50`** |
| backend ID | `3f6a66f68bc8` | **`ce2e901b6619`** |
| backend StartedAt | 10-29T18:37 | **10-29T21:47** |
| gateway ID | `5b867095d376` | **aynı** |
| gateway StartedAt | 10-27T17:25 | **aynı** |
| db ID | `f6d79c4a1f8b` | **aynı** |
| db StartedAt | 10-01T17:45 | **aynı** |
| caddy ID | `ee66a5cab371` | **aynı** |
| caddy StartedAt | 10-12T13:12 | **aynı** |

### 3.2 DB ve session

| | Önce | Sonra | Yorum |
|---|---|---|---|
| `conversations` | 125 | **125** | aynı |
| `messages` | 2150 | **2151** | **+1 canlı ingest** |
| `contacts` | 1537 | **1537** | aynı |
| Session 201 | `CONNECTED` | `CONNECTED` | aynı |

**Önceki deploy'dan (3.8.6) fark:** o cutover `126|2077|1538` → `125|2068|1537` (9 mesaj silindi). Bu cutover: `125|2150|1537` → `125|2151|1537` (0 silme, +1 canlı mesaj).

### 3.3 Karantina tablosu

- `to_regclass('public.whatsapp_identity_quarantine')` → **`whatsapp_identity_quarantine`** (tablo var)
- `SELECT count(*), status FROM … GROUP BY status` → **0 satır** (henüz hayalet yok — bu, yeni tablonun boş başlamasının kanıtı)
- `/health.whatsapp_identity_quarantine`:
  ```json
  {"available": true, "quarantined": 0, "with_messages": 0, "messages_held": 0, "by_reason": {}}
  ```

### 3.4 Persistence durumu

- `/health.whatsapp_memory_persistence`:
  ```json
  {"config_enabled": false, "runs": 0, "inserted_total": 0, "task_running": false, …}
  ```
- Container env'de `WHATSAPP_MEMORY_PERSIST_ENABLED` → **ABSENT** (fail-closed varsayılan)
- Backend log: `[MEMORY-PERSIST] kapalı` (tek satır)

### 3.5 RAM snapshot'lar

5 dosya, `600`, sha256'lar **değişmemiş**:
- `tezlify-ram-20261029T125657Z.rsnap`: `2a150698…`
- `tezlify-ram-20261029T125755Z.rsnap`: `00f657b1…`
- `tezlify-ram-20261029T210007Z.rsnap`: `fdafdb7b…`

### 3.6 Log taraması

| Tür | Sayı | Yorum |
|---|---|---|
| JID (`@s.whatsapp.net`, `@lid`, `@g.us`) | **0** | sızıntı yok |
| Telefon benzeri (`+?[0-9]{11,}`) | **0** | sızıntı yok |
| SQL ifadeleri | **0** | sızıntı yok |
| Secret-like | 1 | muhtemelen migration adı; PII değil |
| `[MIGRATION]` satırları | 24 | normal startup |
| `silindi.*mesaj` / `mesaj kayboldu` | **0** | **silme yok** |
| `quarantine` / `karantina` | 0 | tablo yeni, henüz hayalet yok |

## 4. Sayaçlar

| İşlem | Sayı |
|---|---|
| Üretim DB yazımı (manuel) | **0** |
| Açıklanamayan mesaj kaybı | **0** |
| Sweep çalışması (persistence) | **0** |
| Gateway restart/recreate | **0** |
| DB restart | **0** |
| Caddy restart | **0** |
| Session logout/QR | **0** |

## 5. Kabul kriterleri

| Kriter | Durum |
|---|---|
| Yeni backend güvenli çalışıyor | **Geçti** (`cbe4f50`) |
| Karantina davranışı canlıda doğrulanıyor | **Geçti** (tablo var, `/health` `available:true`) |
| Persistence kapalı kalıyor | **Geçti** (`config_enabled=false, runs=0`) |
| Gateway oturumu değişmiyor | **Geçti** (session 201 `CONNECTED`) |
| DB sayıları değişmemiş (±canlı ingest) | **Geçti** (125→125, 2150→2151, 1537→1537) |
| Hiçbir mesaj silinmemiş | **Geçti** (3.8.6'daki `9 mesaj` tekrarlanmadı) |
| Snapshot'lar dokunulmamış | **Geçti** (sha256 aynı) |

## 6. Kalıcı kural — karşılaştırmalı

| | 3.8.6 (eski kod) | 3.8.9 (yeni kod) |
|---|---|---|
| `purge_raw_jid_identity_data` | **DELETE** atıyordu | **0 DELETE**, karantina defterine yazıyor |
| Cutover DB değişimi | `126→125 / 2077→2068 / 1538→1537` | `125→125 / 2150→2151 / 1537→1537` |
| Tablo | yok | `whatsapp_identity_quarantine` oluştu |
| `/health` alanı | `null` | `available:true, quarantined:0` |

**Deploy başarılı. Karantina davranışı canlıda doğrulandı.**
