# 🚀 Tezlify - B2B Lead Generation & Automated WhatsApp Outreach Platform

**Tezlify**, B2B işletmelerin (Ajanslar, Yazılım Şirketleri, Danışmanlar, Satış Ekipleri) Google Maps ve web dizinlerinden otomatik olarak müşteri adayı (Lead) toplamalarını, telefon numaralarını uluslararası E.164 standartlarında doğrulayıp WhatsApp uyumluluklarını filtrelemelerini ve **ban riski oluşturmadan (Anti-Ban Kalkanı)** Spintax ile kişiselleştirilmiş otomatik WhatsApp mesajları göndermelerini sağlayan modern bir SaaS platformudur.

---

## 🌟 Temel Özellikler

- 🔍 **Google Maps & B2B Lead Scraper**: Sektör (Örn: *Diş Klinikleri*) ve Lokasyon (Örn: *İstanbul Ümraniye*) girilerek işletme adı, telefon, adres, Google puanı, yorum sayısı ve web sitelerini otomatik tarar.
- 📱 **Akıllı Telefon Normalizasyonu (E.164)**: Tüm telefon numaralarını uluslararası formata (`+90532...`) dönüştürür, sabit hatları ayırt eder ve WhatsApp mobile uygunluğunu doğrular.
- 🛡️ **Anti-Ban Koruma Kalkanı (Anti-Spam Engine)**:
  - **Humanized Gaussian Jitter:** Her mesaj arasına 45 ile 120 saniye arasında rastgele değişen insansı gecikme ekler.
  - **Typing & Online Simülasyonu:** Mesaj iletilmeden hemen önce 3-7 saniye boyunca WhatsApp'ta *"Yazıyor..."* ve *"Çevrimiçi"* durumu simüle edilir.
  - **Kademeli Isınma (Warm-up Schedule):** Yeni bağlanan hatlarda günlük limitler kademeli artırılır (Gün 1: 15 mesaj, Gün 3: 35 mesaj, Gün 5: 60 mesaj).
  - **Çoklu Hat / Oturum Rotasyonu:** Kuyruktaki mesajlar panele eklenen WhatsApp hatları arasında dengelenir (Round-Robin).
  - **Mesai Saatleri Kilidi:** Sadece 09:30 - 18:30 saatleri arasında gönderim yapılır.
- ✨ **Spintax Studio & Dinamik Şablonlar**:
  - `{Merhaba|Selamlar|İyi günler} {name} Yetkilisi, {city} bölgesindeki {category} profilinizi gördüm...` formatında sınırsız varyasyon üretimi.
  - Anlık kombinasyon sayısı hesaplama ve canlı 4 farklı varyasyon önizlemesi.
- ⚡ **Gelen Yanıt & Kara Liste (Opt-Out) Algoritması**:
  - Müşteri adayı WhatsApp'tan yanıt verdiğinde lead durumu anında `REPLIED` olarak güncellenir ve o lead için otomatik kampanya durdurulur.
  - *"İstemiyorum / Silin"* yanıtlarında otomatik Kara Liste (Blacklist) devreye girer.
- 📊 **Canlı Dönüşüm Hunisi & Dashboard**: Taranan Lead -> WhatsApp Uyumlu -> Mesaj İletilen -> Yanıt Veren metrikleri ve anlık WebSocket olay akışı.
- 📥 **CSV ve Excel (.xlsx) Dışa Aktarma**: Filtrelenmiş lead veritabanını tek tıkla Excel/CSV formatında indirme.

---

## 🏗️ Mimari & Teknoloji Yığını

```
Tezlify/
├── backend/                  # FastAPI Core (Python 3.11+)
│   ├── app/
│   │   ├── api/v1/          # REST & WebSocket Gateway
│   │   ├── core/            # Config, Database (SQLAlchemy 2.0 Async)
│   │   ├── models/          # Lead, Campaign, WhatsAppSession, MessageLog, Blacklist
│   │   ├── schemas/         # Pydantic v2 DTO Şemaları
│   │   ├── services/        # Spintax, Phone E.164 Normalizer, OutreachManager, Exporter
│   │   ├── scrapers/        # Google Maps & Directory Scrapers
│   │   └── main.py          # FastAPI Lifespan & Seed Initializer
│   └── requirements.txt
├── wa-gateway/               # WhatsApp Socket/Session Servisi (Node.js Express / Baileys)
│   ├── src/index.js         # QR Auth, Session Manager, Message Dispatcher
│   └── package.json
├── frontend/                 # React 18 + Vite + TailwindCSS Admin Dashboard
│   ├── src/
│   │   ├── components/      # Sidebar, TopHeader, UI Elements
│   │   ├── pages/           # Dashboard, LeadFinder, LeadCRM, Campaigns, WhatsAppHub, Blacklist, Settings
│   │   ├── api/client.ts    # REST API & WebSocket Client Wrapper
│   │   └── types/           # TypeScript Types
│   └── package.json
└── docker-compose.yml        # PostgreSQL, Redis, Backend, Gateway & Frontend Orchestration
```

---

## 🚀 Hızlı Başlangıç & Kurulum

### Gereksinimler
- Python 3.10+
- Node.js 18+ & npm
- (Opsiyonel) Docker & Docker Compose

---

### 1. Backend Servisini Başlatma (FastAPI)

```bash
# Proje ana dizininde sanal ortamı aktif edin
source venv/bin/activate

# Bağımlılıkları yükleyin (İlk kurulumda)
pip install -r backend/requirements.txt

# Backend sunucusunu başlatın (Port: 8000)
PYTHONPATH=. uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
```

* Swagger API Dokümantasyonu: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
* Health Check: [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)

---

### 2. WhatsApp Gateway Servisini Başlatma (Node.js)

```bash
cd wa-gateway
npm install
node src/index.js
```
* Gateway URL: `http://localhost:3001`

---

### 3. Frontend Admin Dashboard'u Başlatma (React + Vite)

```bash
cd frontend
npm install
npm run dev
```

* Web Paneli: [http://localhost:5173](http://localhost:5173)

---

## 🧪 Testleri Çalıştırma

```bash
source venv/bin/activate
PYTHONPATH=. pytest backend/tests
```

---

## 🛡️ Anti-Ban Stratejisi Özeti

| Kural | Açıklama |
| :--- | :--- |
| **Gaussian Jitter** | Mesajlar 45-120 saniye arasında değişen doğal bir eğriyle gönderilir. |
| **Typing Simülasyonu** | Gönderim öncesinde 3-7 saniye WhatsApp'ta "yazıyor..." durumu üretilir. |
| **Spintax Varyasyonları** | Her mesajın hash ve kelime kombinasyonu tekilleştirilir. |
| **Warm-up Kotaları** | Yeni hatlar 15 mesaj/gün ile başlar, 60-80 mesaj/gün seviyesine kademeli çıkar. |
| **Mesai Kilidi** | Gece saatlerinde gönderim otomatik kilitlenir. |
| **Auto-Stop on Reply** | Müşteri yanıt verdiğinde o numara için tüm otomatik akış durur. |

---

## 📄 Lisans
Bu proje MIT lisansı altında geliştirilmiştir.
