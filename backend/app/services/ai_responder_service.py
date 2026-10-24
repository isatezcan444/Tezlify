import re
import logging
from typing import Dict, Any, List, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.core.auth import get_user_filter
from backend.app.models.conversation import Conversation
from backend.app.models.contact import Contact
from backend.app.models.lead import Lead
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.services.quick_reply_service import list_quick_replies

logger = logging.getLogger(__name__)

INTENT_RULES = [
    {
        "intent": "OBJECTION",
        "label": "İtiraz / İlgilenmeme",
        "keywords": [
            "ilgilenmiyorum", "ilgilenmiyoruz", "düşünmüyoruz", "dusunmuyoruz",
            "gerek yok", "istemiyorum", "istemiyoruz", "aramayın", "aramayin",
            "yazmayın", "yazmayin", "spam", "listeden çıkarın", "not interested",
            "no thanks", "stop", "unsubscribe",
        ],
    },
    {
        "intent": "POSITIVE_CONFIRM",
        "label": "Olumlu Onay & Anlaşma",
        "keywords": [
            "kabul ediyoruz", "kabul ediyorum", "kabul", "anlaştık", "anlastik",
            "başlayalım", "baslayalim", "olur başlayalım", "anlasma", "anlaşma",
            "evet", "tamam", "olur", "süper", "super", "harika", "uygundur",
            "ok", "okay", "sure", "great", "deal", "sounds good", "perfect",
        ],
    },
    {
        "intent": "MEETING_REQUEST",
        "label": "Randevu & Toplantı Talebi",
        "keywords": [
            "randevu", "görüşme", "gorusme", "toplantı", "toplanti", "ne zaman",
            "saat kaçta", "müsait", "musait", "arama", "konuşalım", "konusalim",
            "uğrayalım", "ugrayalim", "gelin", "gelin görüşelim", "meet", "meeting",
            "appointment", "schedule", "call", "available", "when",
        ],
    },
    {
        "intent": "CATALOG_REQUEST",
        "label": "Katalog & Bilgi Talebi",
        "keywords": [
            "katalog", "broşür", "brosur", "örnek", "ornek", "sunum", "detay",
            "bilgi", "pdf", "portföy", "portfoy", "doküman", "dokuman", "liste",
            "katalog var mı", "catalog", "brochure", "details", "info", "deck", "portfolio",
        ],
    },
    {
        "intent": "PRICE_INQUIRY",
        "label": "Fiyat & Maliyet Sorgusu",
        "keywords": [
            "fiyat", "fiyatı", "fiyatlar", "ücret", "ucret", "ne kadar", "tarife",
            "maliyet", "kaça", "kaca", "paket", "fiyatlandırma", "teklif",
            "price", "cost", "how much", "rate", "quote", "pricing",
        ],
    },
    {
        "intent": "LOCATION_HOURS",
        "label": "Konum & Çalışma Saatleri",
        "keywords": [
            "nerede", "neredesiniz", "adres", "adresiniz", "konum", "nerde",
            "çalışma saatleri", "calisma saatleri", "mesai", "açık mısınız",
            "location", "address", "where", "office", "working hours",
        ],
    },
]


class AiResponderService:
    """
    Intelligent context-aware assistant generating high-converting WhatsApp replies.
    Features heuristic multi-intent NLP, tone variations, lead context fusion,
    and automatic Quick Reply matching.
    """

    @classmethod
    def _normalize_text(cls, text: str) -> str:
        t = (text or "").lower()
        t = t.replace("ı", "i").replace("ğ", "g").replace("ü", "u").replace("ş", "s").replace("ö", "o").replace("ç", "c")
        return t

    @classmethod
    def classify_intent(cls, message_text: str) -> Tuple[str, str]:
        """Classifies message intent into actionable sales/support categories."""
        if not message_text or not message_text.strip():
            return "GENERAL_GREETING", "Genel İletişim & Selamlama"

        normalized = cls._normalize_text(message_text)
        for rule in INTENT_RULES:
            for kw in rule["keywords"]:
                norm_kw = cls._normalize_text(kw)
                if re.search(r"\b" + re.escape(norm_kw) + r"\b", normalized) or norm_kw in normalized:
                    return rule["intent"], rule["label"]

        return "GENERAL_GREETING", "Genel İletişim & Selamlama"

    @classmethod
    def generate_suggestions(
        cls,
        intent: str,
        name: str,
        category: Optional[str] = None,
        city: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """Generates 3 tone-varied responses (Professional, Persuasive, Call-to-Action)."""
        salutation = f"Merhaba {name}" if name and name.strip() else "Merhabalar"
        polite_name = f"{name} Bey/Hanım" if name and name.strip() else "Değerli Yetkili"
        cat_desc = f"{category} alanındaki" if category else "Sunduğumuz"

        if intent == "PRICE_INQUIRY":
            return [
                {
                    "id": "sug_price_1",
                    "title": "Hızlı Fiyat & İhtiyaç Analizi",
                    "text": f"{salutation}, {cat_desc.lower()} hizmetlerimizin fiyatlandırması işletmenizin hacmine ve özel gereksinimlerine göre şekillenmektedir. Size en uygun teklifi iletebilmemiz için ihtiyaçlarınızı kısaca öğrenebilir miyiz?",
                    "tone": "PROFESSIONAL",
                },
                {
                    "id": "sug_price_2",
                    "title": "Esnek Paketler & İndirim Avantajı",
                    "text": f"{salutation}, bütçenize uygun esnek ödeme planlarımız ve bu aya özel avantajlı paketlerimiz mevcuttur. Dilerseniz güncel fiyat listemizi ve detaylı teklif özetimizi hemen paylaşabilirim.",
                    "tone": "PERSUASIVE",
                },
                {
                    "id": "sug_price_3",
                    "title": "Kısa Telefon Görüşmesi Daveti",
                    "text": f"{polite_name} merhaba, doğrudan işletmenize en avantajlı fiyatı çıkarabilmemiz için bugün 5 dakikalık kısa bir telefon görüşmesi yapabilir miyiz? Hangi saat sizin için uygundur?",
                    "tone": "CALL_TO_ACTION",
                },
            ]

        if intent == "MEETING_REQUEST":
            return [
                {
                    "id": "sug_meet_1",
                    "title": "Müsaitlik Teyidi",
                    "text": f"{salutation}, görüşmekten büyük memnuniyet duyarız! Bugün veya yarın sizin için uygun olan bir saat aralığı var mıdır?",
                    "tone": "PROFESSIONAL",
                },
                {
                    "id": "sug_meet_2",
                    "title": "Kısa Online / Telefon Randevusu",
                    "text": f"{salutation}, {cat_desc.lower()} çözümlerimizi aktarmak üzere 15 dakikalık bir online toplantı (Google Meet / Zoom) veya telefon görüşmesi organize edebiliriz. Hangi kanal sizin için daha rahat olur?",
                    "tone": "PERSUASIVE",
                },
                {
                    "id": "sug_meet_3",
                    "title": "Doğrudan Saat Teklifi",
                    "text": f"{polite_name} merhaba, yarın saat 14:00 veya 16:30 sizin için uygun mudur? Uygunsa takvim davetini hemen oluşturabilirim.",
                    "tone": "CALL_TO_ACTION",
                },
            ]

        if intent == "CATALOG_REQUEST":
            return [
                {
                    "id": "sug_cat_1",
                    "title": "Katalog & Broşür Paylaşımı",
                    "text": f"{salutation}, güncel tanıtım kataloğumuzu ve hizmet detaylarımızı hemen buradan iletiyorum. İnceleyip dilediğiniz zaman sorularınızı yöneltebilirsiniz.",
                    "tone": "PROFESSIONAL",
                },
                {
                    "id": "sug_cat_2",
                    "title": "Özelleştirilmiş Çözüm Sunumu",
                    "text": f"{salutation}, dokümanımızı memnuniyetle iletiyorum. Özellikle işletmenizin öncelik verdiği bir ürün veya hizmet alanı varsa, onunla ilgili vaka analizlerini de ekleyebilirim.",
                    "tone": "PERSUASIVE",
                },
                {
                    "id": "sug_cat_3",
                    "title": "Katalog Sonrası İnceleme Randevusu",
                    "text": f"{polite_name} merhaba, kataloğumuzu iletiyorum. İncelemenizin ardından aklınıza takılanları netleştirmek üzere yarın kısa bir arama yapabilir miyiz?",
                    "tone": "CALL_TO_ACTION",
                },
            ]

        if intent == "OBJECTION":
            return [
                {
                    "id": "sug_obj_1",
                    "title": "Nazik Teşekkür & Kapatma",
                    "text": f"Geri bildiriminiz ve vaktiniz için teşekkür ederiz {name}. Rahatsızlık verdiysek özür diler, işlerinizde kolaylıklar dileriz.",
                    "tone": "PROFESSIONAL",
                },
                {
                    "id": "sug_obj_2",
                    "title": "Geleceğe Açık Kapı Bırakma",
                    "text": f"Anlayışla karşılıyoruz {name}. İleride {cat_desc.lower()} bir ihtiyacınız doğarsa iletişim bilgilerimiz burada, dilediğiniz zaman ulaşabilirsiniz. Başarılar dileriz!",
                    "tone": "PERSUASIVE",
                },
                {
                    "id": "sug_obj_3",
                    "title": "Kısa Hatırlatma Notu",
                    "text": f"Bilgilendirme için teşekkürler {polite_name}. Numaranızı not aldık; bir sonraki dönemde yeniden değerlendirmek isterseniz memnuniyetle yardımcı oluruz.",
                    "tone": "CALL_TO_ACTION",
                },
            ]

        if intent == "POSITIVE_CONFIRM":
            return [
                {
                    "id": "sug_pos_1",
                    "title": "Süreç Başlatma Adımları",
                    "text": f"Harika bir haber {name}! Süreci hemen başlatabilmemiz için gerekli adımları paylaşıyorum...",
                    "tone": "PROFESSIONAL",
                },
                {
                    "id": "sug_pos_2",
                    "title": "Hızlı İletişim Teyidi",
                    "text": f"Çok sevindik {name}! İlgili uzman ekip arkadaşımız operasyonel detayları netleştirmek için sizi arayacak, teyit için bu numaradan mı ulaşalım?",
                    "tone": "PERSUASIVE",
                },
                {
                    "id": "sug_pos_3",
                    "title": "Doğrudan Onay & Başlangıç",
                    "text": f"Teşekkürler {polite_name}. İşlemleri tamamlamak adına gerekli form ve başlangıç detaylarını iletiyorum.",
                    "tone": "CALL_TO_ACTION",
                },
            ]

        if intent == "LOCATION_HOURS":
            loc_text = f"{city} bölgesinde" if city else "merkezimizde"
            return [
                {
                    "id": "sug_loc_1",
                    "title": "Konum & Harita Bilgisi",
                    "text": f"{salutation}, ofisimiz {loc_text} yer almaktadır. Dilerseniz yol tarifi için canlı harita konumumuzu paylaşabilirim.",
                    "tone": "PROFESSIONAL",
                },
                {
                    "id": "sug_loc_2",
                    "title": "Mesai Saatleri & İletişim",
                    "text": f"{salutation}, hafta içi 09:00 - 18:00 saatleri arasında kesintisiz hizmet vermekteyiz. Bize dilediğiniz zaman bu hattan da yazabilirsiniz.",
                    "tone": "PERSUASIVE",
                },
                {
                    "id": "sug_loc_3",
                    "title": "Kahve & Ofis Daveti",
                    "text": f"{polite_name} merhaba, adresimizi iletiyorum. Gelmeden önce kısa bir haber verirseniz sizi kahve eşliğinde ağırlamaktan mutluluk duyarız.",
                    "tone": "CALL_TO_ACTION",
                },
            ]

        # GENERAL_GREETING fallback
        return [
            {
                "id": "sug_gen_1",
                "title": "Samimi Karşılama",
                "text": f"{salutation}, mesajınız için teşekkür ederiz! Size bugün nasıl yardımcı olabiliriz?",
                "tone": "PROFESSIONAL",
            },
            {
                "id": "sug_gen_2",
                "title": "Hizmet Tanıtımı & Destek",
                "text": f"{salutation}, {cat_desc.lower()} çözümlerimiz ve kurumsal fırsatlarımız hakkında aklınıza takılan her türlü soruyu memnuniyetle yanıtlayabilirim.",
                "tone": "PERSUASIVE",
            },
            {
                "id": "sug_gen_3",
                "title": "Hızlı İhtiyaç Tespiti",
                "text": f"{polite_name} merhaba, ihtiyacınızı kısaca paylaşabilirseniz sizi doğrudan ilgili uzmanımıza yönlendirebilirim.",
                "tone": "CALL_TO_ACTION",
            },
        ]

    @classmethod
    async def suggest_replies(
        cls,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
    ) -> Dict[str, Any]:
        from sqlalchemy.orm import selectinload

        stmt = (
            select(Conversation)
            .where(Conversation.id == conversation_id)
            .options(selectinload(Conversation.contact))
        )
        conv = (await db.execute(stmt)).scalar_one_or_none()
        if not conv or str(conv.user_id) != str(user_id):
            raise LookupError(f"Sohbet #{conversation_id} bulunamadı veya erişim yetkiniz yok.")

        contact_name = (conv.contact.display_name if conv.contact and conv.contact.display_name else "") or ""
        phone = conv.contact.phone_e164 if conv.contact else None

        # Fetch associated Lead if exists
        lead_category = None
        lead_city = None
        if conv.lead_id:
            lead = await db.get(Lead, conv.lead_id)
            if lead:
                lead_category = lead.category
                lead_city = lead.city
                if not contact_name:
                    contact_name = lead.name
        elif phone:
            lead = await db.scalar(
                select(Lead).where(
                    get_user_filter(Lead.user_id, user_id),
                    Lead.phone_e164 == phone,
                ).limit(1)
            )
            if lead:
                lead_category = lead.category
                lead_city = lead.city
                if not contact_name:
                    contact_name = lead.name

        # Fetch last 5 messages in this conversation
        msg_stmt = (
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                get_user_filter(Message.user_id, user_id),
            )
            .order_by(Message.id.desc())
            .limit(5)
        )
        recent_messages = (await db.execute(msg_stmt)).scalars().all()

        # Find latest customer inbound message
        latest_customer_message = None
        for m in recent_messages:
            if m.direction == MessageDirection.INBOUND and m.body and m.body.strip():
                latest_customer_message = m.body.strip()
                break

        if not latest_customer_message and recent_messages:
            latest_customer_message = (recent_messages[0].body or "").strip()

        intent, intent_label = cls.classify_intent(latest_customer_message or "")
        suggestions = cls.generate_suggestions(
            intent=intent,
            name=contact_name,
            category=lead_category,
            city=lead_city,
        )

        # Match user's Quick Replies
        all_qrs = await list_quick_replies(db, user_id)
        matched_qrs = []
        target_norm = cls._normalize_text(latest_customer_message or "")
        for qr in all_qrs:
            sc_norm = cls._normalize_text(qr.shortcut)
            title_norm = cls._normalize_text(qr.title)
            # Match if shortcut or title aligns with intent
            if (
                sc_norm.strip("/") in target_norm
                or title_norm in target_norm
                or (intent == "PRICE_INQUIRY" and any(k in sc_norm for k in ["fiyat", "ucret", "teklif"]))
                or (intent == "CATALOG_REQUEST" and any(k in sc_norm for k in ["katalog", "brosur", "sunum", "ornek"]))
                or (intent == "MEETING_REQUEST" and any(k in sc_norm for k in ["randevu", "toplanti", "gorusme"]))
                or (intent == "LOCATION_HOURS" and any(k in sc_norm for k in ["adres", "konum", "mesai"]))
            ):
                matched_qrs.append({
                    "id": qr.id,
                    "shortcut": qr.shortcut,
                    "title": qr.title,
                    "content": qr.content,
                    "category": qr.category,
                })

        return {
            "conversation_id": conversation_id,
            "contact_name": contact_name,
            "category": lead_category,
            "detected_intent": intent,
            "intent_label": intent_label,
            "latest_customer_message": latest_customer_message,
            "suggestions": suggestions,
            "matching_quick_replies": matched_qrs[:3],
        }
