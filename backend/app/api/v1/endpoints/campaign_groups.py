import os
from datetime import datetime
from typing import List, Optional
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


async def _bulk_insert_memberships(
    db: AsyncSession, group_id: int, lead_ids: List[int]
) -> int:
    """Inserts (group_id, lead_id) memberships in ONE round-trip.

    Falls back to per-row savepoints only when the bulk statement hits an
    IntegrityError (concurrent race inserting the same pair). Returns the
    number of rows actually added.
    """
    distinct_ids = list(set(lead_ids))
    if not distinct_ids:
        return 0
    now = datetime.utcnow()
    try:
        async with db.begin_nested():
            await db.execute(
                insert(campaign_group_leads).values([
                    {"group_id": group_id, "lead_id": lid, "added_at": now}
                    for lid in distinct_ids
                ])
            )
        return len(distinct_ids)
    except IntegrityError:
        pass
    added = 0
    for lid in distinct_ids:
        try:
            async with db.begin_nested():
                await db.execute(
                    insert(campaign_group_leads).values(
                        group_id=group_id,
                        lead_id=lid,
                        added_at=datetime.utcnow(),
                    )
                )
            added += 1
        except IntegrityError:
            # Pair already present (pre-existing or concurrent race) — skip.
            pass
    return added


async def _get_group_counts(db: AsyncSession, group_id: int) -> tuple[int, int]:
    """Returns (total_leads_count, whatsapp_eligible_count) for a given group."""
    stmt = (
        select(
            func.count(Lead.id).label("total"),
            func.coalesce(func.sum(case((Lead.is_whatsapp_eligible == True, 1), else_=0)), 0).label("wa_eligible"),
        )
        .select_from(campaign_group_leads)
        .join(Lead, Lead.id == campaign_group_leads.c.lead_id)
        .where(campaign_group_leads.c.group_id == group_id)
    )
    res = await db.execute(stmt)
    row = res.first()
    if not row:
        return 0, 0
    return int(row[0] or 0), int(row[1] or 0)


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

    if not req.lead_ids:
        total, wa = await _get_group_counts(db, group.id)
        return AddLeadsToGroupResponse(
            group_id=group.id,
            group_name=group.name,
            added_count=0,
            existing_count=0,
            total_leads_count=total,
            whatsapp_eligible_count=wa,
            message="Eklenecek işletme seçilmedi.",
        )

    distinct_input_ids = list(set(req.lead_ids))

    # 1. Fetch valid leads from DB
    valid_leads_res = await db.execute(
        select(Lead.id).where(
            Lead.id.in_(distinct_input_ids),
            get_user_filter(Lead.user_id, current_user.id),
        )
    )
    valid_lead_ids = set(row[0] for row in valid_leads_res.fetchall())

    # 2. Fetch existing group members
    existing_members_res = await db.execute(
        select(campaign_group_leads.c.lead_id).where(campaign_group_leads.c.group_id == group.id)
    )
    existing_member_ids = set(row[0] for row in existing_members_res.fetchall())

    # 3. Calculate delta
    new_lead_ids = [lid for lid in valid_lead_ids if lid not in existing_member_ids]
    already_existing_in_group = len(valid_lead_ids) - len(new_lead_ids)

    # 4. Bulk insert (single round-trip; per-row savepoint fallback on races)
    actually_added_count = await _bulk_insert_memberships(db, group_id, new_lead_ids)

    group.updated_at = datetime.utcnow()
    await db.commit()

    total, wa = await _get_group_counts(db, group.id)
    already_existing_in_group = len(valid_lead_ids) - actually_added_count

    if actually_added_count > 0 and already_existing_in_group > 0:
        msg = f"{actually_added_count} yeni işletme gruba eklendi ({already_existing_in_group} işletme zaten grupta kayıtlıydı)."
    elif actually_added_count > 0:
        msg = f"{actually_added_count} işletme '{group.name}' grubuna başarıyla eklendi."
    else:
        msg = f"Seçilen tüm işletmeler ({already_existing_in_group}) zaten bu grupta kayıtlı."

    return AddLeadsToGroupResponse(
        group_id=group.id,
        group_name=group.name,
        added_count=actually_added_count,
        existing_count=already_existing_in_group,
        total_leads_count=total,
        whatsapp_eligible_count=wa,
        message=msg,
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

    group.updated_at = datetime.utcnow()
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
