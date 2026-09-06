"""
Deterministic Smart Matching Engine.
Evaluates B2B leads against user offer context and approved target categories,
producing explainable Fit Assessments (0-100 Fit Score, positive signals, and risk factors).
"""
import logging
from typing import List, Optional, Dict, Any, Tuple
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.lead import Lead, LeadStatus, EntityType, VerificationStatus
from backend.app.models.conversation import Conversation
from backend.app.core.search_utils import build_tr_search_filter
from backend.app.core.auth import get_user_filter
from backend.app.schemas.smart_outreach import (
    FitAssessment,
    CategoryFitLevel,
    CategorySource,
    BusinessGoal,
    SmartMatchedLead
)
from backend.app.data.turkey_locations import normalize_turkish

logger = logging.getLogger(__name__)


class SmartMatchingService:
    """
    Evaluates leads with deterministic, explainable multi-factor scoring.
    """

    @classmethod
    def evaluate_lead(
        cls,
        lead: Lead,
        offer_title: str,
        offer_description: Optional[str] = None,
        business_goal: BusinessGoal = BusinessGoal.DISCOVERY,
        approved_target_categories: Optional[List[str]] = None,
        target_city: Optional[str] = None,
    ) -> FitAssessment:
        """
        Computes 0-100 FitScore and explainable signals for a single lead.
        """
        positive_signals: List[str] = []
        risk_factors: List[str] = []
        score = 0

        norm_offer = normalize_turkish(f"{offer_title} {offer_description or ''}".lower())
        lead_category = lead.category or lead.canonical_category or ""
        norm_lead_cat = normalize_turkish(lead_category.lower())
        norm_lead_name = normalize_turkish(lead.name.lower())

        # =========================================================================
        # 1. CATEGORY & SECTOR FIT (Max 35 pts)
        # =========================================================================
        cat_matched = False
        if approved_target_categories:
            for target_cat in approved_target_categories:
                norm_target = normalize_turkish(target_cat.lower())
                if norm_target in norm_lead_cat or norm_target in norm_lead_name or norm_lead_cat in norm_target:
                    cat_matched = True
                    break

        # Check semantic keywords between offer and lead
        tokens = [t for t in norm_offer.split() if len(t) > 2]
        keyword_hits = sum(1 for t in tokens if t in norm_lead_cat or t in norm_lead_name)

        if cat_matched:
            score += 35
            positive_signals.append("✓ Onaylanmış hedef kategori tam eşleşmesi")
        elif keyword_hits >= 2:
            score += 30
            positive_signals.append("✓ Teklif sektörü anahtar kelime eşleşmesi")
        elif keyword_hits == 1:
            score += 18
            positive_signals.append("✓ İlgili sektörel iş kolu uyumu")
        else:
            # Unrelated to offer and not in approved target categories
            score += 0
            risk_factors.append("⚠ Kategori kullanıcının teklifi veya hedef kategorileriyle eşleşmiyor")

        # =========================================================================
        # 2. ENTITY RESOLUTION & BUSINESS TYPE (Max 25 pts)
        # =========================================================================
        entity_val = lead.entity_type or EntityType.BUSINESS.value
        if entity_val in {EntityType.BUSINESS.value, EntityType.CLINIC.value, EntityType.COMPANY.value}:
            if lead.website:
                score += 25
                positive_signals.append("✓ Doğrulanmış kurumsal işletme & aktif web sitesi")
            else:
                score += 18
                positive_signals.append("✓ Doğrulanmış ticari işletme kaydı")
        elif entity_val == EntityType.PERSON.value:
            score += 5
            risk_factors.append("⚠ Şahıs / bireysel profil kaydı (Kurumsal işletme değil)")
        else:
            score += 12

        # =========================================================================
        # 3. WHATSAPP & CONTACT READINESS (Max 25 pts)
        # =========================================================================
        if lead.phone_e164 and lead.is_whatsapp_eligible:
            score += 25
            positive_signals.append(f"✓ WhatsApp erişimi doğrulanmış ({lead.phone_e164})")
        elif lead.phone:
            score += 10
            risk_factors.append("⚠ Sabit hat veya WhatsApp doğrulaması bekleniyor")
        else:
            risk_factors.append("⚠ Telefon numarası bulunmuyor (İletişim kurulamaz)")

        # =========================================================================
        # 4. LOCATION & LOCAL CONTEXT (Max 10 pts)
        # =========================================================================
        if target_city and target_city.strip():
            norm_target_city = normalize_turkish(target_city.lower().strip())
            norm_lead_city = normalize_turkish((lead.city or "").lower().strip())
            if norm_target_city and norm_lead_city and (norm_target_city in norm_lead_city or norm_lead_city in norm_target_city):
                if lead.district:
                    score += 10
                    positive_signals.append(f"✓ Hedef lokasyon uyumu ({lead.city} / {lead.district})")
                else:
                    score += 7
                    positive_signals.append(f"✓ İl bazlı lokasyon uyumu ({lead.city})")
            else:
                score += 0
                risk_factors.append(f"⚠ Farklı şehir / lokasyon ({lead.city or 'Bilinmiyor'})")
        else:
            if lead.city and lead.district:
                score += 10
                positive_signals.append(f"✓ Hedef lokasyon uyumu ({lead.city} / {lead.district})")
            elif lead.city:
                score += 7
                positive_signals.append(f"✓ İl bazlı lokasyon uyumu ({lead.city})")
            else:
                score += 4

        # =========================================================================
        # 5. REPUTATION & ACTIVITY (Max 5 pts)
        # =========================================================================
        if (lead.rating or 0) >= 4.0 and (lead.reviews_count or 0) >= 5:
            score += 5
            positive_signals.append(f"✓ Yüksek müşteri puanı ({lead.rating} ★, {lead.reviews_count} yorum)")
        elif (lead.rating or 0) > 0:
            score += 3

        # =========================================================================
        # 6. LIFECYCLE & RECOMMENDED INTENT DETERMINATION
        # =========================================================================
        recommended_intent = business_goal
        if lead.status == LeadStatus.NEW:
            recommended_intent = BusinessGoal.DISCOVERY
            risk_factors.append("ℹ İlk temas — İhtiyaç keşfi önerilir")
        elif lead.status == LeadStatus.CONTACTED:
            recommended_intent = BusinessGoal.FOLLOW_UP
            positive_signals.append("✓ Daha önce temas kurulmuş — Takip mesajı uygun")
        elif lead.status in {LeadStatus.REPLIED, LeadStatus.INTERESTED}:
            recommended_intent = BusinessGoal.MEETING
            positive_signals.append("✓ Müşteri geri dönüş sağladı — Görüşme / Teklif aşaması")

        score = max(0, min(100, score))

        fit_level = (
            CategoryFitLevel.HIGH if score >= 75 else
            CategoryFitLevel.MEDIUM if score >= 50 else
            CategoryFitLevel.LOW
        )

        return FitAssessment(
            fit_score=score,
            fit_level=fit_level,
            target_category=lead.category or "Genel İşletme",
            category_approved_by_user=cat_matched,
            positive_signals=positive_signals,
            risk_factors=risk_factors,
            recommended_intent=recommended_intent,
            recommended_message_snippet=f"{lead.name} için {recommended_intent.value} stratejisi hazırlandı."
        )

    @classmethod
    async def match_and_rank_leads(
        cls,
        db: AsyncSession,
        offer_title: str,
        offer_description: Optional[str] = None,
        business_goal: BusinessGoal = BusinessGoal.DISCOVERY,
        approved_target_categories: Optional[List[str]] = None,
        lead_ids: Optional[List[int]] = None,
        city: Optional[str] = None,
        category_filter: Optional[str] = None,
        min_fit_score: int = 40,
        limit: int = 100,
        user_id: Optional[str] = None,
    ) -> List[SmartMatchedLead]:
        """
        Evaluates, filters, and ranks leads from database.
        """
        query = select(Lead)

        if user_id:
            query = query.where(get_user_filter(Lead.user_id, user_id))

        if lead_ids:
            query = query.where(Lead.id.in_(lead_ids))
        elif city and city.strip():
            city_filter = build_tr_search_filter([Lead.city], city.strip())
            if city_filter is not None:
                query = query.where(city_filter)
        if category_filter:
            query = query.where(Lead.category == category_filter)

        query = query.order_by(Lead.id.desc()).limit(limit * 2)
        result = await db.execute(query)
        leads = result.scalars().all()

        matched_leads: List[SmartMatchedLead] = []
        seen_lead_ids = set()

        for lead in leads:
            if lead.id in seen_lead_ids:
                continue
            seen_lead_ids.add(lead.id)

            assessment = cls.evaluate_lead(
                lead=lead,
                offer_title=offer_title,
                offer_description=offer_description,
                business_goal=business_goal,
                approved_target_categories=approved_target_categories,
                target_city=city
            )

            if assessment.fit_score >= min_fit_score:
                matched_leads.append(SmartMatchedLead(
                    lead_id=lead.id,
                    name=lead.name,
                    phone=lead.phone or "",
                    phone_e164=lead.phone_e164,
                    is_whatsapp_eligible=lead.is_whatsapp_eligible,
                    city=lead.city,
                    district=lead.district,
                    website=lead.website,
                    rating=lead.rating,
                    target_category=lead.category or "Genel",
                    category_source=CategorySource.DISCOVERED,
                    fit_assessment=assessment
                ))

        # Deterministic ranking: fit_score DESC, whatsapp DESC, id DESC
        matched_leads.sort(
            key=lambda x: (
                x.fit_assessment.fit_score,
                1 if x.is_whatsapp_eligible else 0,
                x.lead_id
            ),
            reverse=True
        )
        return matched_leads[:limit]

