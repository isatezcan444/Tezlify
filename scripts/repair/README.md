# Repair Scripts

Bu klasör **disaster recovery ve üretim onarım araçlarını** içerir.

Bu araçların sonuçları **history completeness evidence** olarak kullanılamaz.
History audit raporlarında bu klasördeki scriptlere atıf yapılamaz.

## Araçlar

### `restore_production_state.mjs`
**Amaç**: Felaket kurtarma. Session credentials kaybedildiğinde veya conversation/message verisi kayıp olduğunda `event_outbox` kayıtlarından yeniden inşa eder.

**Kullanım koşulları**:
- Yalnızca production data tamamen kayıp olduğunda.
- Kullanmadan önce şu soruyu sor: "Bu araç PASS/FAIL kararını etkiliyor mu?" Evet ise kullanma.

**Bu araç şunlara ZOR etmez:**
- `history_sync_states` tablosuna veri yazamaz (bu bir repair script'i, audit değil).
- `FULLY_EXHAUSTED`, `HAS_MORE`, `NO_MESSAGES` — bunları üretme.

**Bu araç yalnızca şunları yapar:**
- `whatsapp_sessions` tablosunu yoksa oluşturur.
- `conversations` ve `messages` tablolarını `event_outbox` verisinden kurtarır.

---

> [!CAUTION]
> Bu klasördeki scriptlerin çalıştırılması bir `REPAIR` aşamasıdır.
> `REPAIR` aşamaları history evidence'dan **ayrı** olarak belgelenmeli
> ve hangi tabloların etkilendiği açıkça raporlanmalıdır.
