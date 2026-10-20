import hashlib
import hmac
import json
import pytest
from httpx import AsyncClient, ASGITransport
from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.api_key import ApiKey
from backend.app.models.webhook import WebhookSubscription, WebhookDeliveryLog
from backend.app.models.lead import Lead


@pytest.fixture
def auth_headers():
    return {
        "x-test-user-id": "00000000-0000-0000-0000-000000000001",
        "x-test-user-email": "dev@tezlify.com",
    }


@pytest.fixture
def other_user_headers():
    return {
        "x-test-user-id": "00000000-0000-0000-0000-000000000002",
        "x-test-user-email": "other@tezlify.com",
    }


@pytest.mark.asyncio
async def test_api_key_lifecycle(auth_headers, other_user_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Create API Key
        res = await ac.post(
            "/api/v1/api-keys",
            json={"name": "Zapier Lead Form", "expires_in_days": 30},
            headers=auth_headers,
        )
        assert res.status_code == 201
        data = res.json()
        assert data["name"] == "Zapier Lead Form"
        assert data["raw_key"].startswith("tzf_live_")
        assert data["key_prefix"].startswith("tzf_live_")
        key_id = data["id"]
        raw_key = data["raw_key"]

        # 2. List API Keys (raw_key should NOT be in the list)
        list_res = await ac.get("/api/v1/api-keys", headers=auth_headers)
        assert list_res.status_code == 200
        list_data = list_res.json()
        assert any(k["id"] == key_id for k in list_data["items"])
        assert "raw_key" not in list_data["items"][0]

        # 3. Isolation: other user should NOT see this key
        other_list = await ac.get("/api/v1/api-keys", headers=other_user_headers)
        assert other_list.status_code == 200
        assert not any(k["id"] == key_id for k in other_list.json()["items"])

        # 4. Use API Key to ingest lead via Public API
        ingest_res = await ac.post(
            "/api/v1/public/leads",
            json={
                "name": "Acme Medya A.Ş.",
                "phone": "05321112233",
                "email": "info@acme.com",
                "city": "İstanbul",
                "district": "Kadıköy",
                "category": "Dijital Ajans",
            },
            headers={"X-API-Key": raw_key},
        )
        assert ingest_res.status_code == 201
        ingest_data = ingest_res.json()
        assert ingest_data["success"] is True
        assert ingest_data["phone_e164"] == "+905321112233"
        assert ingest_data["is_whatsapp_eligible"] is True
        lead_id = ingest_data["lead_id"]

        # 5. Verify Lead in DB is scoped to user_id
        async with AsyncSessionLocal() as db:
            lead = await db.get(Lead, lead_id)
            assert lead is not None
            assert str(lead.user_id) == auth_headers["x-test-user-id"]

        # 6. Test Inbound Webhook URL with key_prefix
        prefix = data["key_prefix"]
        webhook_res = await ac.post(
            f"/api/v1/public/inbound-webhook/{prefix}",
            json={
                "isim": "Test Şirket",
                "telefon": "05442223344",
                "sehir": "Ankara",
                "hizmet": "Yazılım",
            },
        )
        assert webhook_res.status_code == 201
        assert webhook_res.json()["success"] is True

        # 7. Toggle API Key status
        toggle_res = await ac.patch(f"/api/v1/api-keys/{key_id}/toggle", headers=auth_headers)
        assert toggle_res.status_code == 200
        assert toggle_res.json()["is_active"] is False

        # Attempt using disabled key -> 401
        disabled_res = await ac.post(
            "/api/v1/public/leads",
            json={"name": "Blocked Lead", "phone": "05551234567"},
            headers={"X-API-Key": raw_key},
        )
        assert disabled_res.status_code == 401

        # 8. Delete API Key
        del_res = await ac.delete(f"/api/v1/api-keys/{key_id}", headers=auth_headers)
        assert del_res.status_code == 200


@pytest.mark.asyncio
async def test_webhook_subscriptions_crud(auth_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Create Webhook Subscription
        res = await ac.post(
            "/api/v1/webhooks",
            json={
                "name": "Zapier CRM Sync",
                "target_url": "https://hooks.zapier.com/hooks/catch/123456/abcdef",
                "events": ["lead.created", "lead.status_updated"],
            },
            headers=auth_headers,
        )
        assert res.status_code == 201
        sub_data = res.json()
        assert sub_data["name"] == "Zapier CRM Sync"
        assert len(sub_data["secret"]) == 64
        sub_id = sub_data["id"]

        # 2. List Webhooks
        list_res = await ac.get("/api/v1/webhooks", headers=auth_headers)
        assert list_res.status_code == 200
        assert any(w["id"] == sub_id for w in list_res.json())

        # 3. Update Webhook
        patch_res = await ac.patch(
            f"/api/v1/webhooks/{sub_id}",
            json={"name": "Zapier CRM Sync v2", "events": ["lead.created"]},
            headers=auth_headers,
        )
        assert patch_res.status_code == 200
        assert patch_res.json()["name"] == "Zapier CRM Sync v2"

        # 4. Delete Webhook
        del_res = await ac.delete(f"/api/v1/webhooks/{sub_id}", headers=auth_headers)
        assert del_res.status_code == 200
