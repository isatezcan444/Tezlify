"""
Campaign Group Domain Service.

Coordinates campaign group membership operations, bulk lead insertions,
integrity conflict handling, and lead count aggregations.
"""
from datetime import datetime, timezone
from typing import List, Optional, Tuple
from sqlalchemy import select, func, insert, case
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.models.campaign_group import CampaignGroup, campaign_group_leads
from backend.app.models.lead import Lead
from backend.app.schemas.campaign_group import AddLeadsToGroupResponse


class CampaignGroupService:
    @staticmethod
    async def bulk_insert_memberships(
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
        now = datetime.now(timezone.utc)
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
                            added_at=datetime.now(timezone.utc),
                        )
                    )
                added += 1
            except IntegrityError:
                # Pair already present (pre-existing or concurrent race) — skip.
                pass
        return added

    @staticmethod
    async def get_group_counts(db: AsyncSession, group_id: int) -> Tuple[int, int]:
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

    @classmethod
    async def add_leads_to_group(
        cls,
        db: AsyncSession,
        group: CampaignGroup,
        lead_ids: List[int],
        user_id: Optional[str] = None,
    ) -> AddLeadsToGroupResponse:
        """Add leads to a campaign group, enforcing tenant isolation, skipping duplicates,
        and returning user-facing feedback."""
        if not lead_ids:
            total, wa = await cls.get_group_counts(db, group.id)
            return AddLeadsToGroupResponse(
                group_id=group.id,
                group_name=group.name,
                added_count=0,
                existing_count=0,
                total_leads_count=total,
                whatsapp_eligible_count=wa,
                message="Eklenecek işletme seçilmedi.",
            )

        distinct_input_ids = list(set(lead_ids))

        # 1. Fetch valid leads from DB
        valid_leads_res = await db.execute(
            select(Lead.id).where(
                Lead.id.in_(distinct_input_ids),
                get_user_filter(Lead.user_id, user_id),
            )
        )
        valid_lead_ids = set(row[0] for row in valid_leads_res.fetchall())

        # 2. Fetch existing group members
        existing_members_res = await db.execute(
            select(campaign_group_leads.c.lead_id).where(
                campaign_group_leads.c.group_id == group.id
            )
        )
        existing_member_ids = set(row[0] for row in existing_members_res.fetchall())

        # 3. Calculate delta
        new_lead_ids = [lid for lid in valid_lead_ids if lid not in existing_member_ids]

        # 4. Bulk insert (single round-trip; per-row savepoint fallback on races)
        actually_added_count = await cls.bulk_insert_memberships(db, group.id, new_lead_ids)

        group.updated_at = datetime.now(timezone.utc)
        await db.commit()

        total, wa = await cls.get_group_counts(db, group.id)
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


__all__ = ["CampaignGroupService"]
