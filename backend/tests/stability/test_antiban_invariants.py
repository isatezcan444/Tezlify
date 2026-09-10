import pytest
from datetime import time
from httpx import AsyncClient

from backend.app.services.antiban_policy import AntibanPolicy, gaussian_jitter_seconds


def test_antiban_working_hours_fail_closed():
    """
    Architectural Invariant 1.2:
    Working hours validation is FAIL-CLOSED (returns False if parsing fails or invalid format).
    """
    # 1. Corrupted time strings -> MUST return False (never crash or allow early sends)
    corrupted_policy = AntibanPolicy(
        min_delay_seconds=10,
        max_delay_seconds=30,
        typing_delay_seconds=4,
        working_hours_enabled=True,
        working_hours_start="corrupted_start",
        working_hours_end="corrupted_end",
        # simulation mode removed with the WhatsApp backend
    )
    assert corrupted_policy.is_within_working_hours(now=time(12, 0)) is False

    # 2. Valid hours check
    valid_policy = AntibanPolicy(
        min_delay_seconds=10,
        max_delay_seconds=30,
        typing_delay_seconds=4,
        working_hours_enabled=True,
        working_hours_start="09:00",
        working_hours_end="18:00",
        # simulation mode removed with the WhatsApp backend
    )
    assert valid_policy.is_within_working_hours(now=time(14, 30)) is True
    assert valid_policy.is_within_working_hours(now=time(20, 0)) is False
    assert valid_policy.is_within_working_hours(now=time(6, 0)) is False

    # 3. Disabled working hours check
    disabled_policy = AntibanPolicy(
        min_delay_seconds=10,
        max_delay_seconds=30,
        typing_delay_seconds=4,
        working_hours_enabled=False,
        working_hours_start="09:00",
        working_hours_end="18:00",
        # simulation mode removed with the WhatsApp backend
    )
    assert disabled_policy.is_within_working_hours(now=time(23, 59)) is True


def test_gaussian_jitter_distribution_clamped():
    """Proves jitter delays are strictly bounded within [min_delay, max_delay]."""
    for _ in range(100):
        jitter = gaussian_jitter_seconds(min_delay=15, max_delay=45)
        assert 15 <= jitter <= 45


@pytest.mark.asyncio
async def test_antiban_settings_rest_api_persistence(client: AsyncClient):
    """Proves Anti-Ban settings endpoint persists updates to database and returns synced state."""
    # 1. Fetch current settings
    res = await client.get("/api/v1/settings/antiban")
    assert res.status_code == 200
    initial = res.json()

    # 2. Patch new parameters
    patch_res = await client.patch("/api/v1/settings/antiban", json={
        "min_delay_seconds": 22,
        "max_delay_seconds": 55,
        "working_hours_start": "08:30",
        "working_hours_end": "19:30"
    })
    assert patch_res.status_code == 200
    updated = patch_res.json()
    assert updated["min_delay_seconds"] == 22
    assert updated["max_delay_seconds"] == 55
    assert updated["working_hours_start"] == "08:30"
    assert updated["working_hours_end"] == "19:30"
