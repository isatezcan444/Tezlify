"""
Demo/örnek başlangıç verisi.

Yalnızca `SEED_DEMO_DATA=True` iken ve veritabanı boşken çalışır.
Üretim kurulumunda SEED_DEMO_DATA=False yapılmalıdır.
"""
import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.lead import Lead, LeadStatus

logger = logging.getLogger(__name__)

SEED_LEADS = [
    {
        "name": "Özel DentaLine Ağız ve Diş Sağlığı",
        "category": "Diş Kliniği",
        "phone": "0532 987 65 43",
        "phone_e164": "+905329876543",
        "is_mobile": True,
        "is_whatsapp_eligible": True,
        "city": "İstanbul",
        "district": "Ümraniye",
        "address": "Atatürk Mah. Alemdağ Cad. No:142 Ümraniye / İstanbul",
        "rating": 4.9,
        "reviews_count": 184,
        "website": "https://www.dentaline.com.tr",
        "status": LeadStatus.REPLIED,
        "search_keyword": "diş klinikleri",
        "search_location": "İstanbul Ümraniye",
    },
    {
        "name": "Estetik Diş Dünyası Polikliniği",
        "category": "Diş Kliniği",
        "phone": "0544 123 45 67",
        "phone_e164": "+905441234567",
        "is_mobile": True,
        "is_whatsapp_eligible": True,
        "city": "İstanbul",
        "district": "Kadıköy",
        "address": "Moda Cad. No:55 Kadıköy / İstanbul",
        "rating": 4.8,
        "reviews_count": 92,
        "website": "https://www.estetikdisdunyasi.com",
        "status": LeadStatus.CONTACTED,
        "search_keyword": "diş klinikleri",
        "search_location": "İstanbul Kadıköy",
    },
    {
        "name": "Megadent Dental Hospital",
        "category": "Diş Hastanesi",
        "phone": "0533 555 88 99",
        "phone_e164": "+905335558899",
        "is_mobile": True,
        "is_whatsapp_eligible": True,
        "city": "İstanbul",
        "district": "Ataşehir",
        "address": "Barbaros Mah. Mor Sümbül Sok. Ataşehir / İstanbul",
        "rating": 4.7,
        "reviews_count": 310,
        "website": "https://www.megadent.com.tr",
        "status": LeadStatus.NEW,
        "search_keyword": "diş hastanesi",
        "search_location": "İstanbul Ataşehir",
    },
    {
        "name": "SmileArt Ortodonti & İmplant",
        "category": "Diş Kliniği",
        "phone": "0535 777 44 22",
        "phone_e164": "+905357774422",
        "is_mobile": True,
        "is_whatsapp_eligible": True,
        "city": "İstanbul",
        "district": "Beşiktaş",
        "address": "Nispetiye Cad. Levent / Beşiktaş",
        "rating": 5.0,
        "reviews_count": 64,
        "website": "https://www.smileartclinic.com",
        "status": LeadStatus.NEW,
        "search_keyword": "ortodonti kliniği",
        "search_location": "İstanbul Beşiktaş",
    },
]

SEED_CAMPAIGN_TEMPLATE = (
    "{Merhaba|Selamlar|İyi günler} {name} Yetkilisi,\n\n"
    "{city} {district} bölgesindeki {category} profilinizi inceledik. "
    "Google'daki {rating} yıldızlı puanınız çok başarılı! 🌟\n\n"
    "Klinikler için geliştirdiğimiz otomatik WhatsApp randevu ve hatırlatma "
    "sistemimizle hasta kaçırma oranını %40 azaltıyoruz. Size 2 dakikalık kısa "
    "bir demo sunabilir miyiz?\n\n{İyi çalışmalar dileriz|Saygılarımızla}."
)


async def should_seed_demo_data(db: AsyncSession) -> bool:
    """True only on a truly fresh database: no leads or campaigns.

    User data in ANY core table proves this is not a fresh install.
    """
    for model in (Lead, Campaign):
        count = await db.execute(select(func.count(model.id)))
        if count.scalar_one() > 0:
            return False
    return True


async def seed_demo_data_if_empty() -> None:
    """Veritabanı boşsa örnek kampanya + lead kayıtları oluşturur."""
    async with AsyncSessionLocal() as db:  # type: AsyncSession
        if not await should_seed_demo_data(db):
            return

        db.add(
            Campaign(
                name="Diş Klinikleri B2B Tanıtım",
                description=(
                    "İstanbul geneli diş kliniklerine yönelik randevu yazılımı tanıtım kampanyası"
                ),
                message_template=SEED_CAMPAIGN_TEMPLATE,
                status=CampaignStatus.ACTIVE,
                min_delay_seconds=45,
                max_delay_seconds=110,
                typing_delay_seconds=5,
                total_leads_target=25,
                sent_count=12,
                delivered_count=12,
                replied_count=3,
                failed_count=0,
            )
        )

        for lead_data in SEED_LEADS:
            db.add(Lead(**lead_data))

        await db.commit()
        logger.info("Seed demo data initialized successfully.")
