"""
Lead Query Filtering & Condition Construction Service.

Encapsulates SQL filter generation for lead search, multi-district scoping,
multi-category filtering, and status/eligibility constraints.
"""
from typing import Any, List, Optional
from sqlalchemy import or_

from backend.app.core.search_utils import build_tr_search_filter
from backend.app.models.lead import Lead, LeadStatus


def build_lead_filter_conditions(
    search: Optional[str] = None,
    city: Optional[str] = None,
    district: Optional[str] = None,
    districts: Optional[List[str]] = None,
    category: Optional[str] = None,
    categories: Optional[List[str]] = None,
    status: Optional[LeadStatus] = None,
    whatsapp_eligible_only: bool = False,
) -> List[Any]:
    """Constructs SQLAlchemy WHERE clauses from search criteria, honoring
    Turkish case-folding and multi-valued filter parameters."""
    conditions = []

    if search and search.strip():
        search_filter = build_tr_search_filter(
            [Lead.name, Lead.phone, Lead.phone_e164, Lead.district, Lead.category, Lead.city],
            search.strip(),
        )
        if search_filter is not None:
            conditions.append(search_filter)

    if city and city.strip():
        city_filter = build_tr_search_filter([Lead.city], city.strip())
        if city_filter is not None:
            conditions.append(city_filter)

    # Multi-district support (takes priority over single district)
    if districts and len(districts) > 0:
        clean_districts = [d.strip() for d in districts if d and d.strip()]
        if clean_districts:
            district_clauses = []
            for d in clean_districts:
                f = build_tr_search_filter([Lead.district], d)
                if f is not None:
                    district_clauses.append(f)
            if district_clauses:
                conditions.append(or_(*district_clauses))
    elif district and district.strip():
        dist_filter = build_tr_search_filter([Lead.district], district.strip())
        if dist_filter is not None:
            conditions.append(dist_filter)

    # Multi-category support (takes priority over single category)
    if categories and len(categories) > 0:
        clean_categories = [c.strip() for c in categories if c and c.strip()]
        if clean_categories:
            category_clauses = []
            for c in clean_categories:
                f = build_tr_search_filter([Lead.category], c)
                if f is not None:
                    category_clauses.append(f)
            if category_clauses:
                conditions.append(or_(*category_clauses))
    elif category and category.strip():
        cat_filter = build_tr_search_filter([Lead.category], category.strip())
        if cat_filter is not None:
            conditions.append(cat_filter)

    if status:
        conditions.append(Lead.status == status)
    if whatsapp_eligible_only:
        conditions.append(Lead.is_whatsapp_eligible == True)

    return conditions


__all__ = ["build_lead_filter_conditions"]
