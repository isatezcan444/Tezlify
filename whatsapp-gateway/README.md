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
| GET | `/contacts` | Senkronize edilmiş kişiler |
| GET | `/conversations?search=&limit=&offset=` | Sohbet listesi |
| GET | `/conversations/:jid/messages?limit=&before=` | Sohbet mesajları |
| POST | `/conversations/:jid/messages` | Metin gönder (`{ "body": "..." }`) |
| POST | `/conversations/:jid/media` | Medya gönder |
| POST | `/conversations/:jid/read` | Okundu işaretle |
| GET | `/media/:mediaId` | Medyayı indir |

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