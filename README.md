# 🚀 Tezlify - B2B Lead Generation & Outreach Platform

**Tezlify**, B2B işletmelerin (Ajanslar, Yazılım Şirketleri, Danışmanlar, Satış Ekipleri) Google Maps ve web dizinlerinden otomatik olarak müşteri adayı (Lead) toplamalarını, telefon numaralarını uluslararası E.164 standartlarında doğrulayıp WhatsApp uyumluluklarını filtrelemelerini ve **Anti-Ban politikası** ile kişiselleştirilmiş Spintax mesaj kampanyaları yönetmelerini sağlayan modern bir SaaS platformudur.

> **Not:** Bu sürümde WhatsApp **frontend/UI katmanı** korunmuştur; WhatsApp **backend** altyapısı (gateway, Meta Cloud API, Baileys, webhook, oturum, gönderim işçileri) tamamen kaldırılmıştır. WhatsApp ekranları ön yüz veri katmanı (`frontend/src/data/whatsapp/`) üzerinden çalışır.

---

## 🌟 Temel Özellikler

- 🔍 **Google Maps & B2B Lead Scraper**: Sektör (Örn: *Diş Klinikleri*) ve Lokasyon (Örn: *İstanbul Ümraniye*) girilerek işletme adı, telefon, adres, Google puanı, yorum sayısı ve web sitelerini otomatik tarar.
- 📱 **Akıllı Telefon Normalizasyonu (E.164)**: Tüm telefon numaralarını uluslararası formata (`+90532...`) dönüştürür, sabit hatları ayırt eder ve WhatsApp mobile uygunluğunu doğrular.
- 🛡️ **Anti-Ban Koruma Politikası (UI + Ayarlar)**:
  - **Humanized Gaussian Jitter:** Mesajlar arası insansı gecikme politikası (45-120 saniye).
  - **Kademeli Isınma (Warm-up Schedule):** Günlük limit kademelendirme ayarları.
  - **Mesai Saatleri Kilidi:** 09:00 - 18:30 gönderim penceresi ayarları.
- ✨ **Spintax Studio & Dinamik Şablonlar**:
  - `{Merhaba|Selamlar|İyi günler} {name} Yetkilisi, {city} bölgesindeki {category} profilinizi gördüm...` formatında sınırsız varyasyon üretimi.
  - Anlık kombinasyon sayısı hesaplama ve canlı varyasyon önizlemesi.
- 🖥️ **WhatsApp Hub (Ön Yüz)**: Canlı Konuşmalar, Aktif Numaralar, QR bağlantı modalı, Yeni Sohbet, sohbet listesi, mesaj balonları, arama/filtreler ve test kutusu — tümü tasarımı korunarak frontend-only veri katmanıyla çalışır.
- 📊 **Canlı Dönüşüm Hunisi & Dashboard**: Taranan Lead -> WhatsApp Uyumlu -> İletişime Geçilen -> Yanıt Veren metrikleri ve WebSocket olay akışı.
- 📥 **CSV ve Excel (.xlsx) Dışa Aktarma**: Filtrelenmiş lead veritabanını tek tıkla Excel/CSV formatında indirme.

---

## 🏗️ Mimari & Teknoloji Yığını

```
Tezlify/
├── backend/                  # FastAPI Core (Python 3.11+)
│   ├── app/
│   │   ├── api/v1/          # REST & WebSocket
│   │   ├── core/            # Config, Database (SQLAlchemy 2.0 Async), Migrations
│   │   ├── models/          # Lead, Campaign, Conversation, Message, Contact, Blacklist
│   │   ├── schemas/         # Pydantic v2 DTO Şemaları
│   │   ├── services/        # Spintax, Phone E.164 Normalizer, OutreachManager, Exporter
│   │   ├── scrapers/        # Google Maps & Directory Scrapers
│   │   └── main.py          # FastAPI Lifespan & Seed Initializer
│   └── requirements.txt
├── frontend/                 # React 18 + Vite + TailwindCSS Admin Dashboard
│   ├── src/
│   │   ├── components/      # Sidebar, TopHeader, UI Elements, WhatsApp domain components
│   │   ├── pages/           # Dashboard, LeadFinder, LeadCRM, Campaigns, WhatsAppHub, Blacklist, Settings
│   │   ├── data/whatsapp/   # Frontend-only WhatsApp veri katmanı (repository + mock)
│   │   ├── api/client.ts    # REST API & WebSocket Client Wrapper
│   │   └── types/           # TypeScript Types
│   └── package.json
└── start.py                  # Uvicorn başlatıcı
```

---

## 🚀 Hızlı Başlangıç & Kurulum

### Gereksinimler
- Python 3.10+
- Node.js 18+ & npm

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

### 2. Frontend Admin Dashboard'u Başlatma (React + Vite)

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

```bash
cd frontend && npm run build
```

---

## 🛡️ Anti-Ban Stratejisi Özeti

| Kural | Açıklama |
| :--- | :--- |
| **Gaussian Jitter** | Mesajlar 45-120 saniye arasında değişen doğal bir eğriyle gönderilir. |
| **Spintax Varyasyonları** | Her mesajın hash ve kelime kombinasyonu tekilleştirilir. |
| **Warm-up Kotaları** | Yeni hatlar düşük günlük limitlerle başlar, kademeli artar. |
| **Mesai Kilidi** | Gece saatlerinde gönderim otomatik kilitlenir. |

---

## 📄 Lisans
Bu proje MIT lisansı altında geliştirilmiştir.