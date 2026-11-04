# AŞAMA 7.3 — Baileys Protocol Events, WhatsApp Entity Sync ve Session Conflict Recovery Raporu

**Tarih**: 2026-11-04  
**İşlem Türü**: Baileys Protokol Olayları, Varlık Sınıflandırması ve Oturum Çakışma Yönetimi  
**Durum**: TAMAMLANDI (Doğrulandı, Test Edildi, Main'e Push Edildi ve Production'a Deploy Edildi)

---

## 1. ÖZET VE HEDEFLER

AŞAMA 7.0 fonksiyonel denetiminde tespit edilen eksik Baileys protokol olayları, grup/topluluk/kanal ayrımı ve 440 connectionReplaced reconnect döngüsü sorunları AŞAMA 7.3 kapsamında uçtan uca çözülmüştür:

1. **Baileys Protokol Olayları Entegrasyonu**:
   - `chats.upsert`: WhatsApp Web ile gelen sohbetleri listeye ekler, mevcut sohbetleri ezmeden günceller.
   - `groups.upsert`: Topluluk (Community), Duyuru Grubu (Announcement) ve standart grupları ayrıştırır.
   - `groups.update`: Grup başlığı, açıklaması, katılımcı sayısı ve topluluk ebeveyn bağını (`parent_jid`) dinamik günceller.
   - `group-participants.update`: Katılımcı ekleme/çıkarma durumunda grup büyüklüğünü günceller ve frontend'e `group_participants_updated` olayı yayınlar.
   - `messaging-history.status`: Geçmiş senkronizasyon aşamalarını kaydeder ve WebSocket ile frontend'e iletir.
   - `lid-mapping.update`: Gelen canlı LID → PN eşleşmelerini gateway store ve veritabanı haritasına anında işler.
   - Newsletter/Kanal Olayları: `newsletter.reaction`, `newsletter.view`, `newsletter-participants.update`, `newsletter-settings.update` olayları dinlenir ve yayınlanır. `@newsletter` JID'leri artık durum yayınları (`status@broadcast`) ile karıştırılmayarak birinci sınıf kanal olarak ele alınır.
2. **WhatsApp Varlık Sınıflandırması ve Hiyerarşisi**:
   - Varlık türleri tanımlandı: `INDIVIDUAL`, `GROUP`, `COMMUNITY`, `ANNOUNCEMENT`, `CHANNEL`, `BROADCAST`.
   - Veritabanı modeli ve migrasyonu: `conversations` tablosuna `entity_type` (VARCHAR(30) DEFAULT 'INDIVIDUAL') ve `parent_jid` (VARCHAR(100)) kolonları, indeksleri ve mevcut gruplar için geriye dönük backfill eklendi.
   - UI Gösterimi: Sohbet listesinde ve açık sohbet başlığında varlık türüne göre özel rozet ve simgeler (`Topluluk`, `Duyuru Grubu`, `Kanal`, `Grup`, `Yayın Listesi`) entegre edildi.
3. **Session Conflict Recovery (440 connectionReplaced)**:
   - Baileys `DisconnectReason.connectionReplaced` (440) hatası transient ağ kopmalarından ayrıştırıldı.
   - Otomatik reconnect döngüsü durduruldu (`session.lifecycle.cancelReconnect()`), lease serbest bırakıldı.
   - Kimlik bilgileri (`auth_state`) silinmedi, oturum `DISCONNECTED` durumuna çekilerek `error_message = 'WHATSAPP_CONNECTION_REPLACED'` olarak işaretlendi.
   - Kullanıcıya açıklayıcı bildirim gösterildi ve "Yeniden Bağlan" seçeneği sunuldu.

---

## 2. COMMIT VE SÜRÜM DOĞRULAMASI

Tüm katmanlardaki değişiklikler doğrulanmış ve main branch'e push edilerek production'a deploy edilmiştir:

| Kaynak | Commit SHA | Açıklama |
|---|---|---|
| **Local HEAD** | `93c75c9ceeef24f5a47771c777f6656b946a5090` | `fix(whatsapp): complete baileys protocol event handling` |
| **origin/main** | `93c75c9ceeef24f5a47771c777f6656b946a5090` | GitHub senkronize |
| **Production HEAD** | `93c75c9ceeef24f5a47771c777f6656b946a5090` | `/opt/tezlify` repo HEAD |
| **Production .deployed-commit** | `93c75c9ceeef24f5a47771c777f6656b946a5090` | Canlı deploy artifact damgası |

---

## 3. PROTOKOL VE MİMARİ DEĞİŞİKLİKLERİ

### 3.1 WhatsApp Gateway (`whatsapp-gateway/`)
- `src/utils/whatsapp-identity.js`:
  - `isBroadcastOnlyJid(jid)` fonksiyonundan `isNewsletterJid` ayrıştırıldı. Yalnızca `status@broadcast` yayın filtresine tabi tutulur; kanallar artık sessizce çöpe atılmaz.
  - `classifyEntityType({ jid, isCommunity, isCommunityAnnounce, linkedParent })` fonksiyonu eklendi.
  - `jidToPhone` ve `_asPhoneSide` fonksiyonları kanal JID'lerini sahte telefon numaralarına dönüştürmeyecek şekilde (null dönerek) fail-closed kılındı.
- `src/session-manager.js`:
  - `seedGroupChat` ve `applySubject` fonksiyonları `entity_type`, `parent_jid`, `group_size`, `group_desc` alanlarını yönetecek şekilde güncellendi.
- `src/socket/socket-events.js`:
  - `DisconnectReason.connectionReplaced` (440): Yeniden bağlanma planlamasını iptal eder, auth verisini korur, oturum durumunu `DISCONNECTED` ve `error_reason: 'CONNECTION_REPLACED'` yapar.
  - `chats.upsert`: Chat haritasına yeni gelen sohbetleri varlık türleriyle ekler, `conversation_updated` yayını yapar.
  - `groups.upsert`: Topluluk, duyuru ve grup meta verilerini ayıklar, ebeveyn bağını kurar.
  - `groups.update`: Grup başlığı, açıklaması ve büyüklüğünü günceller.
  - `group-participants.update`: Katılımcı ekleme/çıkarmayı yakalar, grup sayacını günceller, `group_participants_updated` olayı yayınlar.
  - `messaging-history.status`: Tarihçe durumunu oturum nesnesinde saklar ve `session_history_status` olarak yayar.
  - `lid-mapping.update`: Canlı LID → PN haritalamasını anında bellek ve kalıcı katmana işler.
  - Newsletter olayları: `newsletter.reaction`, `newsletter.view`, `newsletter-participants.update`, `newsletter-settings.update` olayları dinlenir.

### 3.2 Backend (`backend/`)
- `app/models/conversation.py`:
  - `ConversationEntityType` (`INDIVIDUAL`, `GROUP`, `COMMUNITY`, `ANNOUNCEMENT`, `CHANNEL`, `BROADCAST`) enum'u eklendi.
  - `Conversation` modeline `entity_type` (VARCHAR(30)) ve `parent_jid` (VARCHAR(100)) kolonları eklendi.
- `app/core/migrations.py`:
  - `ensure_conversations_columns`: PostgreSQL ve SQLite üzerinde `entity_type` ve `parent_jid` kolonlarını, indekslerini (`ix_conversations_entity_type`, `ix_conversations_parent_jid`) ve `is_group=TRUE` satırları için `GROUP` backfill'ini idempotent şekilde çalıştırır.
- `app/services/whatsapp/identity.py`:
  - `is_newsletter_jid`, `is_group_jid`, `is_status_broadcast_jid` fonksiyonları eklendi. `is_broadcast_only_jid` yalnızca durum yayınlarına kısıtlandı.
- `app/services/whatsapp/orchestration/events.py`:
  - `_map_session_event`: `CONNECTION_REPLACED` nedenini yakalayarak `row.error_message = "WHATSAPP_CONNECTION_REPLACED"` olarak işaretler.
  - `_ensure_conversation` ve `_map_conversation_event`: `entity_type` ve `parent_jid` alanlarını veritabanına kalıcı yazar ve WebSocket payload'ına dahil eder.
  - `_ingest_group_participants_updated`: Sayısal `conversation_id` ve `user_id` çözümlemesi yaparak olayı frontend istemcilerine iletir.
  - Passthrough listesine `session_history_status` ve newsletter olayları eklendi.
- `app/services/whatsapp_service.py`:
  - `list_conversations`: `entity_type` ve `parent_jid` alanlarını REST yanıtında serileştirir.
- `app/schemas/whatsapp.py`:
  - `WhatsAppConversationItem`: `entity_type` ve `parent_jid` alanları şemaya eklendi.

### 3.3 Frontend (`frontend/`)
- `src/types/index.ts` & `src/features/whatsapp/api/whatsappApi.ts`:
  - `Conversation` ve `BackendConversation` modellerine `entity_type` ve `parent_jid` eklendi.
- `src/locales/tr.ts` ve `src/locales/en.ts`:
  - `community`, `announcement`, `channel`, `broadcast`, `connectionReplacedTitle`, `connectionReplacedDesc`, `reconnect` anahtarları eklendi. İki sözlük 3257 anahtar ile birebir senkronize tutuldu.
- `src/features/whatsapp/components/ConversationList.tsx`:
  - `ConversationRowProps` ve satır renderı varlık türüne göre `COMMUNITY` (yeşil), `ANNOUNCEMENT` (sarı), `CHANNEL` (mavi), `BROADCAST` (indigo), `GROUP` (mor) rozetlerini gösterecek şekilde güncellendi.
- `src/features/whatsapp/components/SessionCard.tsx`:
  - `WHATSAPP_CONNECTION_REPLACED` durumunda oturumun başka sekmede/tarayıcıda açıldığını açıklayan uyarı kartı ve "Yeniden Bağlan" butonu gösterildi.
- `src/pages/WhatsAppHubPage.tsx`:
  - Açık sohbet başlığında varlık türü rozetleri entegre edildi.
  - `group_participants_updated` olayı dinlenerek grup katılımcı listesi anında güncellendi.
  - `session_disconnected` olayı `CONNECTION_REPLACED` ile geldiğinde kullanıcıya uyarı toast'ı gösterildi.

---

## 4. TEST VE DOĞRULAMA KANITLARI

### 4.1 Gateway Testleri
- Yeni test paketi: `whatsapp-gateway/tests/test-baileys-protocol-events-73.mjs`
  - 9/9 test geçti (19 ms):
    1. `chats.upsert creates new chats and does not clobber existing ones`
    2. `groups.upsert classifies communities, announcement groups and regular groups`
    3. `groups.update refines subject, desc and community classification`
    4. `group-participants.update updates group size and emits event`
    5. `messaging-history.status records status and emits event`
    6. `lid-mapping.update maps LID to PN`
    7. `440 connectionReplaced disconnects without auto-reconnect or credential deletion`
    8. `Newsletter events and JID handling`
    9. `Stale socket events are completely ignored across generations`
- Tüm gateway testleri (`cd whatsapp-gateway && npm test`): **TÜM TESTLER BAŞARILI (0 hata)**.

### 4.2 Frontend Testleri ve Build
- `npm run verify:logic`: **53/53 test geçti**.
  - `en=3257 keys, tr=3257 keys` — tam sözlük senkronizasyonu.
  - `applyConversationEvent` ve `buildConversationUpdatedPayload` varlık ve kimlik doğrulamaları geçerli.
- `npm run build`: **Başarılı (tsc && vite build 0 hata)**.

### 4.3 Backend ve İzole PostgreSQL 17 Testleri
- Test paketi: `backend/tests/test_whatsapp_phase7_3_events.py`
  - Gerçek PostgreSQL 17 (`127.0.0.1:5432/tezlify_test_isolated`) üzerinde test edildi:
    - `test_real_postgres17_entity_type_migration_and_query`: PASSED
    - `test_ensure_conversations_columns_idempotency_sqlite`: PASSED
    - `TestSessionConflictRecoveryMapping::test_connection_replaced_error_mapping`: PASSED
    - `TestWhatsAppIdentityClassification::test_newsletter_classification`: PASSED
    - `TestWhatsAppIdentityClassification::test_group_classification`: PASSED
    - `TestWhatsAppIdentityClassification::test_status_broadcast_remains_broadcast_only`: PASSED
    - `TestListConversationsEntityTypeSerialization::test_list_conversations_serializes_entity_type`: PASSED
  - Sonuç: **7/7 PASSED**.
- `test_whatsapp_phase2_a_gateway_behavior.py`: **2/2 PASSED**.
- `test_whatsapp_quarantine_recovery.py`: **11/11 PASSED**.

---

## 5. PRODUCTION DOĞRULAMA KANITLARI

Release scripti (`scripts/deploy/release.sh`) ile production ortamına dağıtım yapılmış ve uzaktan doğrulanmıştır:

### 5.1 Docker Container Sağlığı
```
NAMES               STATUS                        IMAGE
tezlify-gateway     Up 56 seconds (healthy)       tezlify-gateway
tezlify-backend     Up About a minute (healthy)   tezlify-backend
tz5327-restore-pg   Up 44 hours                   postgres:17-alpine
tezlify-caddy       Up 3 weeks (healthy)          caddy:2-alpine
tezlify-db          Up 4 weeks (healthy)          postgres:17-alpine
```

### 5.2 WhatsApp Oturumu (Hat 1 / Session 201)
- Oturum ID: `201`
- Hat Adı: `Hat 1`
- Durum: `CONNECTED`
- Telefon Çevrimiçi: `True`
- Hata Mesajı: `None`
- Multi-device oturumu kesintisiz şekilde canlı gateway'e bağlı kalmıştır.

### 5.3 Production Veritabanı Şeması ve Backfill
Production veritabanında çalıştırılan sorgu çıktısı:
- Kolonlar:
  - `entity_type`: `character varying`, default `'INDIVIDUAL'`
  - `parent_jid`: `character varying`
- İndeksler:
  - `ix_conversations_entity_type`
  - `ix_conversations_parent_jid`
- Mevcut Veri Dağılımı:
  - `GROUP`: 13 adet (otomatik backfill uygulandı)
  - `INDIVIDUAL`: 116 adet

### 5.4 Production Smoke Test
`node frontend/scripts/verify-production-whatsapp.mjs` çıktısı:
```
ok - the deployed page serves a hashed bundle
ok - React mounted into #root
ok - the deployed bundle contains the loading-deadlock fix
ok - the deployed CSS carries a themed loading surface
ok - no console errors on load
ok - no transport-level request failure
6/6 checks passed
```

---

## 6. SONUÇ VE SONRAKİ AŞAMA ÖNERİSİ

AŞAMA 7.3 başarıyla tamamlanmıştır. Baileys protokol olayları kayıpsız işlenmekte, WhatsApp topluluk/duyuru/kanal/grup ayrımı doğru yapılmakta ve başka cihazda WhatsApp Web açıldığında sistem sonsuz reconnect döngüsüne girmeyerek güvenli şekilde oturumu durdurmaktadır.

Bir sonraki aşama (AŞAMA 7.4):
- QR sonrası otomatik sohbet listesi yenileme ve Loading Gate akışının optimize edilmesi.
- Mesaj geçmişi pagination sınırları ve provider timeout kurtarma mekanizmalarının iyileştirilmesi.
- Optimistic mesajların kronolojik sıralama ve ID mutabakatının güçlendirilmesi.
