from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, Response, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_, delete, insert
from sqlalchemy.exc import IntegrityError

from backend.app.core.database import get_db
from backend.app.core.search_utils import build_tr_search_filter, generate_tr_search_terms
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.blacklist import Blacklist
from backend.app.schemas.lead import (
    LeadResponse,
    LeadListResponse,
    LeadCreate,
    LeadUpdate,
    BulkDeleteRequest,
    BulkBlacklistRequest,
    ExportLeadsRequest
)
from backend.app.services.phone_service import PhoneService
from backend.app.services.export_service import ExportService

router = APIRouter()


def build_lead_filter_conditions(
    search: Optional[str] = None,
    city: Optional[str] = None,
    district: Optional[str] = None,
    districts: Optional[List[str]] = None,
    category: Optional[str] = None,
    categories: Optional[List[str]] = None,
    status: Optional[LeadStatus] = None,
    whatsapp_eligible_only: bool = False,
) -> list:
    """Builds a unified list of SQLAlchemy filter expressions for Lead queries with Turkish case-folding."""
    conditions = []
    if search:
        search_filter = build_tr_search_filter(
            [Lead.name, Lead.phone, Lead.phone_e164, Lead.category, Lead.address, Lead.notes],
            search
        )
        if search_filter is not None:
            conditions.append(search_filter)

    if city:
        city_filter = build_tr_search_filter([Lead.city], city)
        if city_filter is not None:
            conditions.append(city_filter)

    # Multi-district filtering
    all_districts = []
    if districts:
        for d in districts:
            if "," in d:
                all_districts.extend([x.strip() for x in d.split(",") if x.strip()])
            elif d.strip():
                all_districts.append(d.strip())
    if district and district.strip():
        all_districts.append(district.strip())

    if all_districts:
        district_clauses = []
        for d in set(all_districts):
            df = build_tr_search_filter([Lead.district], d)
            if df is not None:
                district_clauses.append(df)
        if district_clauses:
            conditions.append(or_(*district_clauses))

    # Multi-category filtering
    all_categories = []
    if categories:
        for c in categories:
            if "," in c:
                all_categories.extend([x.strip() for x in c.split(",") if x.strip()])
            elif c.strip():
                all_categories.append(c.strip())
    if category and category.strip():
        all_categories.append(category.strip())

    if all_categories:
        category_clauses = []
        for c in set(all_categories):
            cf = build_tr_search_filter([Lead.category], c)
            if cf is not None:
                category_clauses.append(cf)
        if category_clauses:
            conditions.append(or_(*category_clauses))

    if status:
        conditions.append(Lead.status == status)
    if whatsapp_eligible_only:
        conditions.append(Lead.is_whatsapp_eligible == True)

    return conditions


@router.get("", response_model=LeadListResponse)
async def list_leads(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    search: Optional[str] = None,
    city: Optional[str] = None,
    district: Optional[str] = None,
    districts: Optional[List[str]] = Query(None),
    category: Optional[str] = None,
    categories: Optional[List[str]] = Query(None),
    status: Optional[LeadStatus] = None,
    whatsapp_eligible_only: bool = False,
    db: AsyncSession = Depends(get_db)
):
    query = select(Lead)
    count_query = select(func.count(Lead.id))

    conditions = build_lead_filter_conditions(
        search=search,
        city=city,
        district=district,
        districts=districts,
        category=category,
        categories=categories,
        status=status,
        whatsapp_eligible_only=whatsapp_eligible_only
    )

    for c in conditions:
        query = query.where(c)
        count_query = count_query.where(c)

    total_res = await db.execute(count_query)
    total = total_res.scalar_one()

    offset = (page - 1) * size
    query = query.order_by(Lead.id.desc()).offset(offset).limit(size)

    res = await db.execute(query)
    items = res.scalars().all()

    pages = (total + size - 1) // size if total > 0 else 1

    return {
        "items": items,
        "total": total,
        "page": page,
        "size": size,
        "pages": pages
    }


@router.get("/categories", response_model=List[str])
async def get_distinct_categories(db: AsyncSession = Depends(get_db)):
    stmt = select(Lead.category).where(Lead.category.is_not(None)).distinct().order_by(Lead.category)
    res = await db.execute(stmt)
    raw_cats = [c.strip() for c in res.scalars().all() if c and isinstance(c, str)]
    clean_cats = []
    seen = set()
    for cat in raw_cats:
        # Reject multi-line, numbers, parens or overly long category strings
        if "\n" in cat or "\r" in cat or len(cat) > 35 or len(cat) < 2:
            continue
        if any(char.isdigit() for char in cat):
            continue
        if cat.lower() not in seen:
            seen.add(cat.lower())
            clean_cats.append(cat)
    return clean_cats


@router.get("/cities", response_model=List[str])
async def get_distinct_cities(db: AsyncSession = Depends(get_db)):
    stmt = select(Lead.city).where(Lead.city.is_not(None)).distinct().order_by(Lead.city)
    res = await db.execute(stmt)
    return [c for c in res.scalars().all() if c]


@router.post("", response_model=LeadResponse, status_code=201)
async def create_lead(lead_in: LeadCreate, db: AsyncSession = Depends(get_db)):
    phone_data = PhoneService.normalize_to_e164(lead_in.phone)
    if not phone_data or not phone_data["is_valid"]:
        raise HTTPException(status_code=400, detail="Geçersiz telefon numarası.")

    e164 = phone_data["e164"]

    bl_stmt = select(Blacklist).where(Blacklist.phone_e164 == e164)
    bl_res = await db.execute(bl_stmt)
    if bl_res.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Bu numara kara listede bulunmaktadır.")

    existing_stmt = select(Lead).where(Lead.phone_e164 == e164)
    existing_res = await db.execute(existing_stmt)
    if existing_res.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Bu numara ile kayıtlı bir müşteri adayı zaten mevcut.")

    lead = Lead(
        name=lead_in.name,
        category=lead_in.category,
        phone=lead_in.phone,
        phone_e164=e164,
        is_mobile=phone_data.get("is_mobile", False),
        is_whatsapp_eligible=phone_data.get("is_whatsapp_eligible", False),
        city=lead_in.city,
        district=lead_in.district,
        address=lead_in.address,
        website=lead_in.website,
        email=lead_in.email,
        rating=lead_in.rating,
        reviews_count=lead_in.reviews_count,
        search_keyword=lead_in.search_keyword,
        search_location=lead_in.search_location,
        notes=lead_in.notes,
        status=LeadStatus.NEW
    )
    db.add(lead)
    await db.commit()
    await db.refresh(lead)
    return lead


@router.get("/{lead_id}", response_model=LeadResponse)
async def get_lead(lead_id: int, db: AsyncSession = Depends(get_db)):
    lead = await db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Müşteri adayı bulunamadı")
    return lead


@router.patch("/{lead_id}", response_model=LeadResponse)
async def update_lead(lead_id: int, lead_in: LeadUpdate, db: AsyncSession = Depends(get_db)):
    lead = await db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Müşteri adayı bulunamadı")

    update_data = lead_in.model_dump(exclude_unset=True)
    if "phone" in update_data and update_data["phone"]:
        phone_data = PhoneService.normalize_to_e164(update_data["phone"])
        if phone_data and phone_data["is_valid"]:
            lead.phone_e164 = phone_data["e164"]
            lead.is_mobile = phone_data.get("is_mobile", False)
            lead.is_whatsapp_eligible = phone_data.get("is_whatsapp_eligible", False)
        else:
            # Fail-closed (mirrors the ingest guard): an unverifiable number
            # must not keep a stale e164 behind.
            lead.phone_e164 = None
            lead.is_mobile = False
            lead.is_whatsapp_eligible = False
        # The display number owns the validated fields: an explicitly passed
        # phone_e164 must not bypass validation.
        update_data.pop("phone_e164", None)

    for field, value in update_data.items():
        setattr(lead, field, value)

    await db.commit()
    await db.refresh(lead)
    return lead


@router.delete("/{lead_id}", status_code=204)
async def delete_lead(lead_id: int, db: AsyncSession = Depends(get_db)):
    lead = await db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Müşteri adayı bulunamadı")
    await db.delete(lead)
    await db.commit()
    return None


@router.post("/bulk-delete")
async def bulk_delete_leads(payload: BulkDeleteRequest, db: AsyncSession = Depends(get_db)):
    if payload.delete_all_matching:
        conditions = build_lead_filter_conditions(
            search=payload.search,
            city=payload.city,
            districts=payload.districts,
            categories=payload.categories,
            status=payload.status,
            whatsapp_eligible_only=payload.whatsapp_eligible_only or False
        )
        stmt = delete(Lead)
        for c in conditions:
            stmt = stmt.where(c)
        res = await db.execute(stmt)
        await db.commit()
        return {"deleted_count": res.rowcount if res.rowcount is not None and res.rowcount >= 0 else 0}

    elif payload.lead_ids:
        stmt = delete(Lead).where(Lead.id.in_(payload.lead_ids))
        res = await db.execute(stmt)
        await db.commit()
        return {"deleted_count": res.rowcount if res.rowcount is not None and res.rowcount >= 0 else 0}
    else:
        raise HTTPException(status_code=400, detail="Silinecek lead belirtilmedi")


@router.post("/bulk-blacklist")
async def bulk_blacklist_leads(payload: BulkBlacklistRequest, db: AsyncSession = Depends(get_db)):
    if payload.blacklist_all_matching:
        conditions = build_lead_filter_conditions(
            search=payload.search,
            city=payload.city,
            districts=payload.districts,
            categories=payload.categories,
            status=payload.status,
            whatsapp_eligible_only=payload.whatsapp_eligible_only or False
        )
        stmt = select(Lead)
        for c in conditions:
            stmt = stmt.where(c)
        res = await db.execute(stmt)
        leads = res.scalars().all()
    elif payload.lead_ids:
        stmt = select(Lead).where(Lead.id.in_(payload.lead_ids))
        res = await db.execute(stmt)
        leads = res.scalars().all()
    else:
        raise HTTPException(status_code=400, detail="Kara listeye eklenecek lead belirtilmedi")

    count = 0
    # Batched blacklist existence check (was N+1) + bulk insert.
    wanted = {lead.phone_e164 for lead in leads if lead.phone_e164}
    already: set = set()
    if wanted:
        already = set(
            (await db.execute(select(Blacklist.phone_e164).where(Blacklist.phone_e164.in_(wanted)))).scalars().all()
        )
    missing = sorted(wanted - already)
    if missing:
        reason = payload.reason or "Toplu kara listeye eklendi"
        try:
            async with db.begin_nested():
                await db.execute(
                    insert(Blacklist).values(
                        [{"phone_e164": e164, "reason": reason} for e164 in missing]
                    )
                )
            count = len(missing)
        except IntegrityError:
            # Concurrent race: fall back per row, skipping present pairs.
            for e164 in missing:
                try:
                    async with db.begin_nested():
                        await db.execute(
                            insert(Blacklist).values(phone_e164=e164, reason=reason)
                        )
                    count += 1
                except IntegrityError:
                    pass
    for lead in leads:
        lead.status = LeadStatus.UNSUBSCRIBED

    await db.commit()
    return {"blacklisted_count": count, "leads_updated": len(leads)}


def _lead_export_dict(l: Lead) -> dict:
    """Explicit export projection: never leak SQLAlchemy internals
    (_sa_instance_state) or unreviewed columns into customer files."""
    return {
        "id": l.id,
        "name": l.name,
        "category": l.category,
        "phone_e164": l.phone_e164,
        "phone": l.phone,
        "is_mobile": l.is_mobile,
        "is_whatsapp_eligible": l.is_whatsapp_eligible,
        "city": l.city,
        "district": l.district,
        "address": l.address,
        "rating": l.rating,
        "reviews_count": l.reviews_count,
        "website": l.website,
        "search_keyword": l.search_keyword,
        "status": l.status.value if hasattr(l.status, "value") else str(l.status),
        "created_at": l.created_at,
    }


@router.post("/export/csv")
async def export_leads_csv(
    payload: Optional[ExportLeadsRequest] = Body(None),
    search: Optional[str] = Query(None),
    city: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    status: Optional[LeadStatus] = Query(None),
    whatsapp_eligible_only: bool = Query(False),
    db: AsyncSession = Depends(get_db)
):
    # Support both JSON body and Query param requests
    req_search = payload.search if payload else search
    req_city = payload.city if payload else city
    req_districts = payload.districts if payload else None
    req_categories = payload.categories if payload else ([category] if category else None)
    req_status = payload.status if payload else status
    req_wa_only = payload.whatsapp_eligible_only if payload else whatsapp_eligible_only

    conditions = build_lead_filter_conditions(
        search=req_search,
        city=req_city,
        districts=req_districts,
        categories=req_categories,
        status=req_status,
        whatsapp_eligible_only=req_wa_only
    )

    query = select(Lead)
    for c in conditions:
        query = query.where(c)

    res = await db.execute(query.order_by(Lead.id.desc()))
    leads = res.scalars().all()

    leads_dicts = [_lead_export_dict(l) for l in leads]
    csv_bytes = ExportService.export_csv(leads_dicts)

    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=tezlify_leads.csv"}
    )


@router.post("/export/excel")
async def export_leads_excel(
    payload: Optional[ExportLeadsRequest] = Body(None),
    search: Optional[str] = Query(None),
    city: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    status: Optional[LeadStatus] = Query(None),
    whatsapp_eligible_only: bool = Query(False),
    db: AsyncSession = Depends(get_db)
):
    req_search = payload.search if payload else search
    req_city = payload.city if payload else city
    req_districts = payload.districts if payload else None
    req_categories = payload.categories if payload else ([category] if category else None)
    req_status = payload.status if payload else status
    req_wa_only = payload.whatsapp_eligible_only if payload else whatsapp_eligible_only

    conditions = build_lead_filter_conditions(
        search=req_search,
        city=req_city,
        districts=req_districts,
        categories=req_categories,
        status=req_status,
        whatsapp_eligible_only=req_wa_only
    )

    query = select(Lead)
    for c in conditions:
        query = query.where(c)

    res = await db.execute(query.order_by(Lead.id.desc()))
    leads = res.scalars().all()

    leads_dicts = [_lead_export_dict(l) for l in leads]
    excel_bytes = ExportService.export_excel(leads_dicts)

    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=tezlify_leads.xlsx"}
    )
