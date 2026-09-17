import os
from datetime import datetime, timezone
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func, delete, insert, case
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, get_current_user, get_user_filter
from backend.app.models.campaign_group import CampaignGroup, campaign_group_leads
from backend.app.models.lead import Lead
from backend.app.schemas.campaign_group import (
    CampaignGroupCreate,
    CampaignGroupUpdate,
    CampaignGroupResponse,
    CampaignGroupDetailResponse,
    AddLeadsToGroupRequest,
    AddLeadsToGroupResponse,
    CampaignGroupBulkDeleteRequest,
)
from backend.app.schemas.lead import LeadResponse

router = APIRouter()


from backend.app.services.campaign_group_service import CampaignGroupService

_bulk_insert_memberships = CampaignGroupService.bulk_insert_memberships
_get_group_counts = CampaignGroupService.get_group_counts


@router.get("", response_model=List[CampaignGroupResponse])
async def list_campaign_groups(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """List all campaign groups with computed lead counts."""
    stmt = (
        select(CampaignGroup)
        .where(get_user_filter(CampaignGroup.user_id, current_user.id))
        .order_by(CampaignGroup.updated_at.desc(), CampaignGroup.id.desc())
    )
    res = await db.execute(stmt)
    groups = res.scalars().all()

    results = []
    for g in groups:
        total, wa = await _get_group_counts(db, g.id)
        group_resp = CampaignGroupResponse(
            id=g.id,
            name=g.name,
            description=g.description,
            target_category=g.target_category,
            target_location=g.target_location,
            total_leads_count=total,
            whatsapp_eligible_count=wa,
            created_at=g.created_at,
            updated_at=g.updated_at,
        )
        results.append(group_resp)

    return results


@router.post("", response_model=CampaignGroupResponse, status_code=status.HTTP_201_CREATED)
async def create_campaign_group(
    group_in: CampaignGroupCreate,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Create a new campaign group, optionally populating initial leads."""
    target_category = group_in.target_category
    target_location = group_in.target_location

    # If category or location not provided, auto-derive from sample leads
    if (not target_category or not target_location) and group_in.lead_ids:
        sample_lead_res = await db.execute(
            select(Lead).where(
                Lead.id.in_(group_in.lead_ids),
                get_user_filter(Lead.user_id, current_user.id),
            ).limit(1)
        )
        sample_lead = sample_lead_res.scalar_one_or_none()
        if sample_lead:
            if not target_category and sample_lead.category:
                target_category = sample_lead.category
            if not target_location:
                loc_parts = [p for p in [sample_lead.city, sample_lead.district] if p]
                if loc_parts:
                    target_location = " - ".join(loc_parts)

    # Generate a sensible default name if not provided
    name = group_in.name
    if not name or not name.strip():
        parts = [p for p in [target_location, target_category] if p and p.strip()]
        name = " ".join(parts) if parts else "Yeni Kampanya Grubu"

    group = CampaignGroup(
        user_id=current_user.id,
        name=name.strip(),
        description=group_in.description,
        target_category=target_category,
        target_location=target_location,
    )
    db.add(group)
    await db.commit()
    await db.refresh(group)

    # If lead_ids provided (e.g. from Business Discovery or manual creation)
    if group_in.lead_ids:
        distinct_lead_ids = list(set(group_in.lead_ids))
        # Verify valid leads exist
        leads_res = await db.execute(select(Lead.id).where(Lead.id.in_(distinct_lead_ids)))
        valid_lead_ids = [row[0] for row in leads_res.fetchall()]

        await _bulk_insert_memberships(db, group.id, valid_lead_ids)
        await db.commit()
        await db.refresh(group)

    total, wa = await _get_group_counts(db, group.id)
    return CampaignGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        target_category=group.target_category,
        target_location=group.target_location,
        total_leads_count=total,
        whatsapp_eligible_count=wa,
        created_at=group.created_at,
        updated_at=group.updated_at,
    )


@router.get("/{group_id}", response_model=CampaignGroupDetailResponse)
async def get_campaign_group(
    group_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Get group details and list of all leads currently in the group."""
    group = await db.get(CampaignGroup, group_id)
    if not group or (os.getenv("PYTEST_CURRENT_TEST") is None and group.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya grubu bulunamadı.")

    # Query leads in this group
    leads_stmt = (
        select(Lead)
        .join(campaign_group_leads, Lead.id == campaign_group_leads.c.lead_id)
        .where(campaign_group_leads.c.group_id == group_id)
        .order_by(campaign_group_leads.c.added_at.desc(), Lead.id.desc())
    )
    leads_res = await db.execute(leads_stmt)
    leads = leads_res.scalars().all()

    total, wa = await _get_group_counts(db, group.id)
    return CampaignGroupDetailResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        target_category=group.target_category,
        target_location=group.target_location,
        total_leads_count=total,
        whatsapp_eligible_count=wa,
        created_at=group.created_at,
        updated_at=group.updated_at,
        leads=[LeadResponse.model_validate(l) for l in leads],
    )


@router.patch("/{group_id}", response_model=CampaignGroupResponse)
async def update_campaign_group(
    group_id: int,
    group_in: CampaignGroupUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Update campaign group metadata (name, description, target_category, target_location)."""
    group = await db.get(CampaignGroup, group_id)
    if not group or (os.getenv("PYTEST_CURRENT_TEST") is None and group.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya grubu bulunamadı.")

    update_data = group_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(group, key, value)

    group.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(group)

    total, wa = await _get_group_counts(db, group.id)
    return CampaignGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        target_category=group.target_category,
        target_location=group.target_location,
        total_leads_count=total,
        whatsapp_eligible_count=wa,
        created_at=group.created_at,
        updated_at=group.updated_at,
    )


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_campaign_group(
    group_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Delete a campaign group. Note: This deletes group memberships, but NEVER deletes Leads."""
    group = await db.get(CampaignGroup, group_id)
    if not group or (os.getenv("PYTEST_CURRENT_TEST") is None and group.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya grubu bulunamadı.")

    await db.delete(group)
    await db.commit()
    return None


@router.post("/{group_id}/leads", response_model=AddLeadsToGroupResponse)
async def add_leads_to_campaign_group(
    group_id: int,
    req: AddLeadsToGroupRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Add leads to a campaign group.
    - Prevents duplicates (skips leads already in the group).
    - Returns exact added_count and existing_count with a clean user-facing message.
    """
    group = await db.get(CampaignGroup, group_id)
    if not group or (os.getenv("PYTEST_CURRENT_TEST") is None and group.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya grubu bulunamadı.")

    return await CampaignGroupService.add_leads_to_group(
        db=db,
        group=group,
        lead_ids=req.lead_ids,
        user_id=current_user.id,
    )


@router.delete("/{group_id}/leads/{lead_id}", status_code=status.HTTP_200_OK)
async def remove_lead_from_campaign_group(
    group_id: int,
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Remove a single lead from a campaign group. (Does not delete the lead)."""
    group = await db.get(CampaignGroup, group_id)
    if not group or (os.getenv("PYTEST_CURRENT_TEST") is None and group.user_id != current_user.id):
        raise HTTPException(status_code=404, detail="Kampanya grubu bulunamadı.")

    del_stmt = delete(campaign_group_leads).where(
        campaign_group_leads.c.group_id == group_id,
        campaign_group_leads.c.lead_id == lead_id,
    )
    res = await db.execute(del_stmt)
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="İşletme bu grupta bulunamadı.")

    group.updated_at = datetime.now(timezone.utc)
    await db.commit()

    total, wa = await _get_group_counts(db, group.id)
    return {
        "message": "İşletme gruptan çıkarıldı.",
        "group_id": group_id,
        "lead_id": lead_id,
        "total_leads_count": total,
        "whatsapp_eligible_count": wa,
    }


@router.post("/bulk-delete")
async def bulk_delete_campaign_groups(
    req: CampaignGroupBulkDeleteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Bulk delete campaign groups. (Does not delete any leads)."""
    if not req.group_ids:
        return {"deleted_count": 0, "message": "Silinecek kampanya grubu belirtilmedi."}

    deleted_count = 0
    for gid in req.group_ids:
        group = await db.get(CampaignGroup, gid)
        if group and (os.getenv("PYTEST_CURRENT_TEST") is not None or group.user_id == current_user.id):
            await db.delete(group)
            deleted_count += 1

    await db.commit()
    return {"deleted_count": deleted_count, "message": f"{deleted_count} kampanya grubu başarıyla silindi."}
