"""
Adversarial Anti-Ban & Working Hours Policy Tests.
Validates fail-closed security boundary on corrupt time formats and mathematical Gaussian jitter clamping.
"""
from datetime import time
from backend.app.services.antiban_policy import AntibanPolicy, gaussian_jitter_seconds


def test_adversarial_working_hours_fail_closed_on_corrupt_data():
    """
    CRITICAL SAFETY INVARIANT:
    Corrupted, empty, or unparseable working hours strings MUST FAIL CLOSED (return False).
    System must never allow outreach when time parsing fails.
    """
    corrupt_time_inputs = [
        ("invalid", "18:00"),
        ("09:00", "invalid"),
        ("", ""),
        ("   ", "18:00"),
        ("25:00", "18:00"),
        ("-01:00", "18:00"),
        ("09:65", "18:00"),
        (None, "18:00"),
        ("09:00", None),
        ("09:00:00:00", "18:00"),
    ]

    target_time = time(12, 0)  # Noon

    for start_str, end_str in corrupt_time_inputs:
        policy = AntibanPolicy(
            min_delay_seconds=10,
            max_delay_seconds=20,
            typing_delay_seconds=5,
            working_hours_enabled=True,
            working_hours_start=start_str,
            working_hours_end=end_str,
            # simulation mode removed with the WhatsApp backend
        )
        result = policy.is_within_working_hours(now=target_time)
        assert result is False, f"Fail-closed policy breached for ({start_str}, {end_str})! Returned: {result}"


def test_adversarial_working_hours_exact_boundaries():
    """
    Tests exact boundary timestamps:
    - 09:00:00 (Start) -> True
    - 18:00:00 (End) -> True
    - 08:59:59 (1 second before start) -> False
    - 18:00:01 (1 second after end) -> False
    """
    policy = AntibanPolicy(
        min_delay_seconds=10,
        max_delay_seconds=20,
        typing_delay_seconds=5,
        working_hours_enabled=True,
        working_hours_start="09:00",
        working_hours_end="18:00",
        # simulation mode removed with the WhatsApp backend
    )

    # Exact start
    assert policy.is_within_working_hours(now=time(9, 0, 0)) is True

    # Exact end
    assert policy.is_within_working_hours(now=time(18, 0, 0)) is True

    # 1 second before start
    assert policy.is_within_working_hours(now=time(8, 59, 59)) is False

    # 1 second after end
    assert policy.is_within_working_hours(now=time(18, 0, 1)) is False


def test_adversarial_jitter_distribution_clamping_1000_samples():
    """
    PROVED MATHEMATICAL INVARIANT:
    Computes 1,000 continuous delay calculations across varied min/max bounds.
    Every single sample MUST strictly obey: min_delay <= delay <= max_delay.
    """
    test_ranges = [
        (10, 20),
        (5, 5),     # Identical bounds
        (1, 100),   # Wide range
        (45, 90),   # Standard default
    ]

    for min_d, max_d in test_ranges:
        for _ in range(1000):
            delay = gaussian_jitter_seconds(min_d, max_d)
            assert min_d <= delay <= max_d, f"Jitter breach: delay {delay} not in [{min_d}, {max_d}]"
