# Tezlify WhatsApp Gateway

Baileys tabanlı WhatsApp Web köprüsü. Telefonunuzdaki WhatsApp sohbetlerini
FastAPI backend'inize (ve dolayısıyla React frontend'inize) bağlar.

## Özellikler (Aşama 1: MVP)

- QR kod ile WhatsApp Web eşleştirme (multi-device, telefon çevrimiçi kalır)
- Oturum kalıcılığı (auth state diskte AES-256 ile şifrelenir)
- Sohbet / kişi / mesaj senkronizasyonu
- Metin ve medya (resim/belge/ses/video) gönderimi
- Gelen medyanın indirilmesi ve diskte saklanması
- Gerçek zamanlı olay akışı → FastAPI backend'e WebSocket ile iletimi
- REST API: oturumlar, sohbetler, mesajlar, medya

## Kurulum

```bash
cd whatsapp-gateway
npm install
cp .env.example .env
# .env içinde GATEWAY_ENCRYPTION_KEY değerini mutlaka değiştirin

npm run start
```

## Docker

```bash
# Gateway only
docker build -f whatsapp-gateway/Dockerfile -t tezlify-gateway .
docker run -p 8787:8787 --env-file whatsapp-gateway/.env tezlify-gateway

# Full stack
docker-compose up -d
```

## Production Deployment

| Açıklama | Port | Not |
|---|---|---|
| Gateway REST + WS | 8787 | `GATEWAY_HOST=0.0.0.0` yapın |
| Backend (FastAPI) | 8000 | `BACKEND_WS_URL` Gateway'in WS URL'ini gösterir |
| Frontend | 80/3000 | `VITE_API_URL` ile Backend'i hedef gösterin |

### Health Check

`GET /health` döndürür:
```json
{"status":"ok","service":"tezlify-whatsapp-gateway","sessions":{"total":1,"connected":1,"pending_qr":0}}
```
Docker `HEALTHCHECK` bu endpoint'i 30s aralıklarla kontrol eder.

## REST API Özeti

| Metod | Path | Açıklama |
|---|---|---|
| GET | `/health` | Sağlık kontrolü |
| GET | `/sessions` | Oturum listesi |
| POST | `/sessions` | Oturum oluştur (JSON body: `{ "name": "Hat 1" }`) |
| GET | `/sessions/:id/qr` | QR kod (data URI) |
| POST | `/sessions/:id/qr/refresh` | QR'ı yenile |
| POST | `/sessions/:id/logout` | Oturumu kapat |
| DELETE | `/sessions/:id` | Oturumu sil |
| GET | `/sessions/:sid/contacts` | Senkronize edilmiş kişiler |
| GET | `/sessions/:sid/conversations?search=&limit=&offset=` | Sohbet listesi |
| POST | `/sessions/:sid/conversations/sync-groups` | Grup başlıklarını toplu çöz |
| GET | `/sessions/:sid/messages/bulk?limit=&offset=&since=&perChatLimit=` | Toplu geçmiş |
| GET | `/sessions/:sid/conversations/:jid/messages?limit=&before=` | Sohbet mesajları |
| POST | `/sessions/:sid/conversations/:jid/messages` | Metin gönder (`{ "body": "..." }`) |
| POST | `/sessions/:sid/conversations/:jid/media` | Medya gönder |
| POST | `/sessions/:sid/conversations/:jid/typing` | "yazıyor…" gönder |
| POST | `/sessions/:sid/conversations/:jid/read` | Okundu işaretle |
| GET | `/sessions/:sid/media/:mediaId` | Medyayı indir |

> **Veri düzlemi oturum kapsamlıdır.** Bu uçlar eskiden oturumsuzdu
> (`/contacts`, `/conversations/:jid/...`) ve gateway "bağlı olan tek oturumu"
> seçiyordu. Çağıranın kimliği hiç sorulmadığı için bir kiracının isteği,
> bağlı olan **başka bir kiracının** hattından veri okuyabiliyor ve o hattan
> mesaj gönderebiliyordu. Artık kişiler/sohbetler/mesajlar her oturumun kendi
> belleğinde (`session.store`) tutulur ve her istek hangi hattı kastettiğini
> yolda açıkça belirtir. Backend, çağırmadan önce oturumun gerçekten o
> kullanıcıya ait olduğunu doğrular.

## WebSocket

- `GET /ws` — gerçek zamanlı olay akışı (backend bağlanır)
- Olaylar: `session_qr_updated`, `session_connected`, `session_disconnected`,
  `message_new`, `conversation_updated`, `contact_synced`, `presence_updated`,
  `message_status_updated`

## Güvenlik Notları

- Gateway varsayılan olarak yalnızca `127.0.0.1`'e bağlanır — backend ile aynı
  sunucuda çalıştırın veya özel ağda tutun.
- Baileys auth state AES-256 ile şifrelenerek saklanır.
- Üretimde medya sunumu mutlaka kimlik doğrulamalı bir proxy arkasında olmalıdır.