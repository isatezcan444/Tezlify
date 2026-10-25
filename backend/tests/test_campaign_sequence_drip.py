import pytest
from datetime import datetime, timedelta
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign_sequence_lead import CampaignSequenceLead, SequenceLeadStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.campaign_runner import CampaignRunner
from backend.app.core.datetime_utils import utc_now_naive
from unittest.mock import patch, AsyncMock


@pytest.mark.asyncio
async def test_campaign_sequence_full_drip_lifecycle():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Create a sequence campaign with 3 steps
        create_payload = {
            "name": "Drip Sequence E2E Test",
            "message_template": "Adım 1: Merhaba {name}, ilk teklifimiz...",
            "min_delay_seconds": 1,
            "max_delay_seconds": 2,
            "typing_delay_seconds": 1,
            "working_hours_enabled": False,
            "sequence_enabled": True,
            "auto_stop_on_reply": True,
            "sequence_steps": [
                {
                    "step_number": 1,
                    "delay_days": 0,
                    "delay_hours": 0,
                    "message_template": "Adım 1: Merhaba {name}, ilk teklifimiz...",
                },
                {
                    "step_number": 2,
                    "delay_days": 2,
                    "delay_hours": 0,
                    "message_template": "Adım 2: {name}, geçen günkü teklifimizi inceleme fırsatınız oldu mu?",
                },
                {
                    "step_number": 3,
                    "delay_days": 5,
                    "delay_hours": 0,
                    "message_template": "Adım 3: {name}, bu ayki özel %25 kontenjanımız dolmak üzere.",
                },
            ],
        }
        res = await ac.post("/api/v1/campaigns", json=create_payload)
        assert res.status_code == 201
        camp_data = res.json()
        campaign_id = camp_data["id"]
        assert camp_data["sequence_enabled"] is True
        assert len(camp_data["sequence_steps"]) == 3
        assert camp_data["auto_stop_on_reply"] is True

        # 2. Seed a lead and a whatsapp session in DB
        async with AsyncSessionLocal() as db:
            import uuid
            u = uuid.uuid4().hex[:6]
            phone1 = f"+90555{u[:4]}11"
            phone2 = f"+90555{u[:4]}22"
            gw_id = f"gw-seq-{u}"

            lead1 = Lead(
                user_id="00000000-0000-0000-0000-000000000001",
                name="Test Hedef Firma 1",
                phone=phone1,
                phone_e164=phone1,
                status=LeadStatus.NEW,
                is_whatsapp_eligible=True,
            )
            lead2 = Lead(
                user_id="00000000-0000-0000-0000-000000000001",
                name="Test Hedef Firma 2",
                phone=phone2,
                phone_e164=phone2,
                status=LeadStatus.NEW,
                is_whatsapp_eligible=True,
            )
            session = WhatsAppSession(
                user_id="00000000-0000-0000-0000-000000000001",
                gateway_id=gw_id,
                session_name="Test Hat Drip",
                phone_number=f"+90541{u[:4]}99",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
            db.add_all([lead1, lead2, session])
            await db.commit()
            await db.refresh(lead1)
            await db.refresh(lead2)
            await db.refresh(session)
            lead1_id = lead1.id
            lead2_id = lead2.id
            session_id = session.id

        # 3. Launch campaign with mock WhatsApp delivery
        with patch("backend.app.services.whatsapp_service.start_conversation", new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {"id": "wamid.HBgLMTEyMg==", "status": "SENT"}

            launch_res = await ac.post(f"/api/v1/campaigns/{campaign_id}/launch", json={
                "lead_ids": [lead1_id, lead2_id],
                "session_id": session_id,
            })
            assert launch_res.status_code == 200

            # Wait briefly for worker task
            import asyncio
            for _ in range(20):
                await asyncio.sleep(0.1)
                async with AsyncSessionLocal() as db:
                    seq_leads = (await db.execute(
                        select(CampaignSequenceLead).where(CampaignSequenceLead.campaign_id == campaign_id)
                    )).scalars().all()
                    if len(seq_leads) >= 2:
                        break

            # 4. Verify CampaignSequenceLead records created for both leads
            async with AsyncSessionLocal() as db:
                seq_leads = (await db.execute(
                    select(CampaignSequenceLead).where(CampaignSequenceLead.campaign_id == campaign_id)
                )).scalars().all()
                assert len(seq_leads) == 2
                for sl in seq_leads:
                    assert sl.current_step == 1
                    assert sl.total_steps == 3
                    assert sl.status == SequenceLeadStatus.ACTIVE
                    assert sl.next_step_at is not None
                    assert sl.last_step_sent_at is not None
                    # Campaign must remain ACTIVE since sequence follow-ups are pending!
                    camp = await db.get(Campaign, campaign_id)
                    assert camp.status == CampaignStatus.ACTIVE

        # 5. Query Sequence Leads Endpoint
        seq_res = await ac.get(f"/api/v1/campaigns/{campaign_id}/sequence-leads")
        assert seq_res.status_code == 200
        items = seq_res.json()
        assert len(items) == 2
        assert items[0]["current_step"] == 1
        assert items[0]["total_steps"] == 3
        seq_lead1 = next(it for it in items if it["lead_id"] == lead1_id)
        seq_lead2 = next(it for it in items if it["lead_id"] == lead2_id)

        # 6. Auto-Stop on Reply Hook Simulation:
        # Lead 1 sends an inbound reply
        from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
        async with AsyncSessionLocal() as db:
            await WhatsAppEventOrchestrator.handle_auto_stop_on_reply(db, lead1_id)

        # Verify Lead 1 sequence is STOPPED_ON_REPLY
        async with AsyncSessionLocal() as db:
            sl1 = await db.get(CampaignSequenceLead, seq_lead1["id"])
            assert sl1.status == SequenceLeadStatus.STOPPED_ON_REPLY
            assert sl1.stop_reason == "REPLIED"
            assert sl1.next_step_at is None

            sl2 = await db.get(CampaignSequenceLead, seq_lead2["id"])
            assert sl2.status == SequenceLeadStatus.ACTIVE  # Lead 2 is still active!

        # 7. Scheduled Follow-up Execution:
        # Fast-forward next_step_at of Lead 2 to the past so it becomes due
        async with AsyncSessionLocal() as db:
            sl2 = await db.get(CampaignSequenceLead, seq_lead2["id"])
            sl2.next_step_at = utc_now_naive() - timedelta(hours=1)
            await db.commit()

        # Run process_due_sequence_followups with mocked working hours & send
        with patch("backend.app.services.whatsapp_service.start_conversation", new_callable=AsyncMock) as mock_send2, \
             patch("backend.app.services.antiban_policy.AntibanPolicy.is_within_working_hours", return_value=True):
            mock_send2.return_value = {"id": "wamid.STEP2_SENT", "status": "SENT"}
            processed = await CampaignRunner.process_due_sequence_followups()
            assert processed >= 1

        # Verify Lead 2 advanced to Step 2
        async with AsyncSessionLocal() as db:
            sl2 = await db.get(CampaignSequenceLead, seq_lead2["id"])
            assert sl2.current_step == 2
            assert sl2.status == SequenceLeadStatus.ACTIVE
            assert sl2.next_step_at is not None

        # 8. Manual Stop endpoint for Lead 2
        stop_res = await ac.post(f"/api/v1/campaigns/{campaign_id}/sequence-leads/{seq_lead2['id']}/stop")
        assert stop_res.status_code == 200
        stopped_data = stop_res.json()
        assert stopped_data["status"] == "STOPPED_MANUAL"
        assert stopped_data["stop_reason"] == "MANUAL"
        assert stopped_data["next_step_at"] is None
