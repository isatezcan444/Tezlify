"""
Final Failure Injection & Graceful Degradation Audit Suite.
Injects controlled infrastructure faults (corrupted policy config) and verifies
deterministic fail-closed error handling.

The WhatsApp gateway failure-injection test was removed together with the
WhatsApp backend (no gateway exists anymore).
"""
import pytest

from backend.app.services.antiban_policy import AntibanPolicy


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_failure_injection_antiban_corrupted_policy():
    """
    Injects completely corrupted, type-confused, and out-of-range configurations into AntibanPolicy.
    Verifies fail-closed behavior (returns False).
    """
    corrupt_configs = [
        {"start": "99:99", "end": "88:88"},
        {"start": "noon", "end": "midnight"},
        {"start": None, "end": None},
        {"start": 1234, "end": 5678},
        {"start": "", "end": ""},
    ]

    for cfg in corrupt_configs:
        policy = AntibanPolicy(
            min_delay_seconds=10,
            max_delay_seconds=30,
            typing_delay_seconds=3,
            working_hours_enabled=True,
            working_hours_start=cfg["start"],
            working_hours_end=cfg["end"],
            # simulation mode removed with the WhatsApp backend
        )
        assert policy.is_within_working_hours() is False, f"Corrupted config {cfg} failed open!"