# AŞAMA 3.8.8 — IDENTITY QUARANTINE BACKEND-ONLY RELEASE HAZIRLIĞI

**Tarih:** 2026-10-29T21:42Z  
**Hazırlayan:** deploy guard + test kapısı  
**Amaç:** 3.8.7 karantina düzeltmesini üretime taşıyacak `release/backend-only-3.8.7` ref'inin kesimi, doğrulanması ve push'u.

## 1. Repo durumu

| | SHA |
|---|---|
| `HEAD` (yerel) | `a1ca60f` |
| `feat/3.8.7-identity-quarantine` | `a1ca60f` = `origin/feat/3.8.7-identity-quarantine` |
| `main` (yerel) | `a1ca60f` (origin/main `848c172` önünde 9 commit) |
| `release/backend-only-3.8.5` | `38fe087` = deployed |
| **Yeni `release/backend-only-3.8.7`** | **`cbe4f50`** = `origin/release/backend-only-3.8.7` |

Çalışma ağacı temiz. `main` push edilmedi.

## 2. Silme riskinin kapandığına dair kanıt

### 2.1 `purge_raw_jid_identity_data` — 0 DELETE

```
grep -c "DELETE FROM" migrations.py              -> 10 (tüm dosya)
grep -c "DELETE FROM" (purge fonksiyonu içinde)  -> 0
```

Fonksiyon `whatsapp_identity_quarantine` defterine **INSERT/UPDATE** yapar:
- `bridge_known_deferred` — köprüsü bilinen hayalet (ertelenir)
- `bridge_unknown_has_messages` — köprüsüz ama mesajı var (korunur)
- `bridge_unknown_empty` — köprüsüz ve boş (güvenle izlenebilir)

`report["deleted_contacts"]` / `report["deleted_conversations"]` / `report["deleted_messages"]` her zaman **0** (sözleşme; test edilir).

### 2.2 Karantina defteri özellikleri

- **Idempotent:** aynı `contact_id` üzerine yazmaz, mevcut satırı günceller.
- **Tenant izolasyonu:** `user_id` taşır; sorgular kiracıya göre filtrelenebilir.
- **Operator kararı dokunulmaz:** `status = 'RELEASED'` olan satır **ezilmez** (`WHERE status != 'RELEASED'`).
- **RELEASED tek başına yazma başlatmaz:** defter yalnızca kayıt tutar; mesaj taşıma/onarım ayrı bir operatör kararıdır.

### 2.3 Lifespan zincirindeki diğer silme yolları

Aşağıdaki fonksiyonlar da startup'ta DELETE içerir; hepsi **önceden var olan** ve farklı kapsamlı:

| Fonksiyon | DELETE sayısı | Kapsam | Risk değerlendirmesi |
|---|---|---|---|
| `purge_degenerate_phone_contacts` | 3 | `phone_e164 LIKE '+0%'` + `_is_degenerate_phone` | E.164 `+0` ile başlayamaz; yalnızca geçici artefakt |
| `purge_empty_ghost_conversations` | 1 | `channel='WHATSAPP'`, `last_message_at IS NULL`, mesaj yok | Gerçekten boş sohbet; mesaj korunur |
| `purge_synthetic_preview_messages` | 1 | `wa_message_id LIKE 'preview%'` | Eski sürümün uydurduğu mesajlar |
| `ensure_contacts_unique_phone` | 2 | Yinelenen `(user_id, phone_e164)` birleştirme | Veri kaybetmeden dedup; mesajlar taşınır |
| `ensure_verified_commercial_leads` | 1 | `message_logs WHERE campaign_id=6 AND status='FAILED'` | Log temizliği, mesaj değil |

**Bu release'i blokleyecek yeni bir silme yolu yok.** 3.8.6'daki olayın nedeni olan `purge_raw_jid_identity_data` artık silmiyor.

### 2.4 `whatsapp_identity_quarantine` tablosu

Üretimde henüz **yok** (`to_regclass` = null). Tablo `ensure_whatsapp_identity_quarantine_table` ile idempotent oluşturulur; yoksa yazma düşer (güvenli). Deploy sonrası ilk boot'ta tablo oluşur, purge yazma yapar, silme yapmaz.

## 3. Release ref'i

### 3.1 Kesim yöntemi

Git plumbing (`read-tree --prefix`) ile:
- `a1ca60f`'nin tüm ağacı alındı
- `whatsapp-gateway/` kaldırılıp `38fe087:whatsapp-gateway` ile değiştirildi
- Yeni commit `cbe4f50`, tree `a51e61af`

### 3.2 Parite kanıtları

| Ağaç | Ref blob | Kaynak blob | Eşleşme |
|---|---|---|---|
| `whatsapp-gateway` | `339aa79…` | `38fe087:whatsapp-gateway` = `339aa79…` | **Evet** |
| `backend` | `9067d4e…` | `a1ca60f:backend` = `9067d4e…` | **Evet** |
| `scripts/deploy` | `844d399…` | `a1ca60f:scripts` = `844d399…` | **Evet** |
| `docker-compose.prod.yml` | `0efa3e1…` | base = target = `0efa3e1…` | **Evet** |
| `docker-compose.yml` | `dd0aed7…` | base = target = `dd0aed7…` | **Evet** |

Gateway/compose diff `base..ref`: **0 dosya**.

### 3.3 Preflight

```
base            : 38fe0879ed05 (38fe087)
target          : cbe4f509f4bc (release/backend-only-3.8.7)
backend kaynagi : a1ca60fcfd24 (a1ca60f)
gateway/compose : 0 dosya degismis (0 olmali)
backend vs main : 0 dosya farkli (0 olmali)
backend vs base : 7 dosya degismis (>0 olmali)
host-release.sh : f2b7a9aeb5c4 (hedefteki blob)
run_release.sh  : 9284245fa56c (hedefteki blob)
SONUC: GUVENLI — bu ref `--no-gateway` muhafizindan gececek.
EXIT=0
```

### 3.4 Launcher doğrulaması

```bash
bash scripts/deploy/run_release.sh --verify-only cbe4f50
# exit 0 — betik blob eşitliği + zorunlu işaretler geçti
```

Pin değerleri:
- Launcher blob: `9284245fa56c8e66c881aa8a0e9b6fd430e391c8`
- `host-release.sh` blob: `f2b7a9aeb5c46247bae73dfc226d8a83dfeea587`

## 4. Test kapıları

| Kapı | Sonuç |
|---|---|
| Hedefli (quarantine + purge-defer + faz7 + boot-merge + forensic-g3 + split-repair) | **78 passed, exit 0** |
| Backend tam paket, rastgele sıra | **2052 passed, 4 skipped, exit 0** (149,80 s) |
| Backend tam paket, sabit sıra | **2052 passed, 4 skipped, exit 0** (167,33 s) |
| Gateway `npm test` | **exit 0**, 60 PASS |
| Frontend build | **exit 0**, 8,64 s |
| i18n-keys | **exit 0**, 2425↔3208/3208 |
| older-page-lock | **exit 0** |
| message-timeout-budget | **exit 0** |
| `git diff --check` | **exit 0** |
| `py_compile` (Python dosyaları) | **exit 0** |
| `bash -n` (host-release.sh + run_release.sh) | **exit 0** ×2 |
| Gizli bilgi taraması | **0 isabet** |

**Not:** `py_compile`'e shell betikleri dahil edilmemelidir; `run_release.sh`'nin Python parser'ı tarafından reddedilmesi beklenen bir artefakt.

## 5. Üretim değişmezliği

| | Başlangıç (21:35Z) | Bitiş (21:42Z) |
|---|---|---|
| backend ID / StartedAt | `3f6a66f68bc8` / 10-29T18:37 | **aynı** |
| gateway ID / StartedAt | `5b867095d376` / 10-27T17:25 | **aynı** |
| db ID / StartedAt | `f6d79c4a1f8b` / 10-01T17:45 | **aynı** |
| caddy ID / StartedAt | `ee66a5cab371` / 10-12T13:12 | **aynı** |
| `.deployed-commit` | `38fe087` | **aynı** |
| conversations | 125 | **125** |
| messages | 2150 | **2150→2164** (canlı ingest) |
| contacts | 1537 | **1537** |
| session 201 | `CONNECTED` | `CONNECTED` |
| RAM snapshot'lar | 5 dosya, `600` | **aynı** |
| persistence `/health` | `config_enabled=false, runs=0, inserted=0` | **aynı** |

**Üretim DB yazımı: 0. Deploy: 0. Gateway restart: 0. Sweep: 0.**

## 6. Bir sonraki aşama için kesin komut

Deploy yalnızca aşağıdaki komutla ve aşağıdaki pin değeriyle yapılmalı:

```bash
# Üretim host'ta (/opt/tezlify)
git fetch origin --prune
git show cbe4f509f4bcc5babb12cc85e0ad422cb13ba739:scripts/deploy/run_release.sh \
  > /tmp/rr387.sh && chmod 700 /tmp/rr387.sh
HOST_RELEASE_REPO=/opt/tezlify bash /tmp/rr387.sh \
  --expected-self-blob 9284245fa56c8e66c881aa8a0e9b6fd430e391c8 \
  cbe4f509f4bcc5babb12cc85e0ad422cb13ba739 \
  --no-gateway --health-timeout 180
```

## 7. Kabul kriterleri

| Kriter | Durum |
|---|---|
| 3.8.7 karantina kodu backend-only release olarak hazır | **Geçti** (`cbe4f50`) |
| Gateway/compose farkı sıfır | **Geçti** (0 dosya) |
| Preflight exit 0 | **Geçti** |
| Launcher verify-only exit 0 | **Geçti** |
| Testler temiz, izole DB | **Geçti** (2052×2) |
| `purge_raw_jid_identity_data` 0 DELETE | **Geçti** |
| Karantina defteri idempotent ve tenant-izole | **Geçti** (test + kod) |
| `RELEASED` kararı otomatik yazma başlatmaz | **Geçti** (yalnızca kayıt) |
| Üretim DB yazımı 0 | **Geçti** |
| Deploy yapılmadı | **Geçti** |
| Gateway restart 0 | **Geçti** |
| `main` push edilmedi | **Geçti** |

**Bu aşamada deploy yapılmadı.** Deploy için ayrı kullanıcı onayı gereklidir.
