import pytest
from httpx import AsyncClient, ASGITransport
from backend.app.main import app


@pytest.mark.asyncio
async def test_get_and_patch_antiban_settings():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # GET default settings
        res = await client.get("/api/v1/settings/antiban")
        assert res.status_code == 200
        data = res.json()
        assert "min_delay_seconds" in data
        assert "daily_message_limit" in data

        # PATCH update settings
        patch_payload = {
            "preset": "ultra_safe",
            "min_delay_seconds": 60,
            "max_delay_seconds": 150,
            "typing_delay_seconds": 5,
            "daily_message_limit": 35,
            "working_hours_enabled": True,
            "working_hours_start": "09:00",
            "working_hours_end": "18:00"
        }
        patch_res = await client.patch("/api/v1/settings/antiban", json=patch_payload)
        assert patch_res.status_code == 200
        updated = patch_res.json()
        assert updated["preset"] == "ultra_safe"
        assert updated["min_delay_seconds"] == 60
        assert updated["daily_message_limit"] == 35

        # Cleanup / Restore default standard_balanced
        restore_payload = {
            "preset": "standard_balanced",
            "min_delay_seconds": 45,
            "max_delay_seconds": 120,
            "typing_delay_seconds": 4,
            "daily_message_limit": 50,
            "working_hours_enabled": True,
            "working_hours_start": "09:00",
            "working_hours_end": "18:30"
        }
        restore_res = await client.patch("/api/v1/settings/antiban", json=restore_payload)
        assert restore_res.status_code == 200
        assert restore_res.json()["preset"] == "standard_balanced"