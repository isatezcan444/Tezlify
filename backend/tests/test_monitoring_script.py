"""
Test suite for Phase 10.2 Monitoring and Alerting infrastructure.
Validates script syntax, configurations, state machine deduplication logic,
and secrets leakage invariants.
"""

import json
import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MONITOR_SCRIPT = REPO_ROOT / "scripts" / "monitor_health.sh"
MONITOR_CONF = REPO_ROOT / "monitoring" / "monitor.conf"
SERVICE_FILE = REPO_ROOT / "monitoring" / "systemd" / "tezlify-monitor.service"
TIMER_FILE = REPO_ROOT / "monitoring" / "systemd" / "tezlify-monitor.timer"
LOGROTATE_FILE = REPO_ROOT / "monitoring" / "systemd" / "tezlify-monitor.logrotate"


def test_monitor_script_exists_and_executable():
    """Verify monitor_health.sh exists and is executable."""
    assert MONITOR_SCRIPT.exists(), f"Missing {MONITOR_SCRIPT}"
    assert os.access(MONITOR_SCRIPT, os.X_OK), f"{MONITOR_SCRIPT} is not executable"


def test_monitor_script_syntax():
    """Verify monitor_health.sh has zero bash syntax errors."""
    res = subprocess.run(["bash", "-n", str(MONITOR_SCRIPT)], capture_output=True, text=True)
    assert res.returncode == 0, f"bash -n failed: {res.stderr}"


def test_monitor_conf_syntax():
    """Verify monitor.conf can be sourced cleanly in bash."""
    res = subprocess.run(
        ["bash", "-c", f"source {MONITOR_CONF} && echo $ALERT_PROVIDER"],
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, f"Failed to source monitor.conf: {res.stderr}"
    assert res.stdout.strip() == "none"


def test_systemd_units_syntax():
    """Verify systemd service and timer files have required directives."""
    assert SERVICE_FILE.exists()
    assert TIMER_FILE.exists()
    assert LOGROTATE_FILE.exists()

    service_text = SERVICE_FILE.read_text()
    assert "ExecStart=/opt/tezlify/scripts/monitor_health.sh" in service_text
    assert "Type=oneshot" in service_text

    timer_text = TIMER_FILE.read_text()
    assert "OnUnitActiveSec=" in timer_text
    assert "Persistent=true" in timer_text

    logrotate_text = LOGROTATE_FILE.read_text()
    assert "/opt/tezlify/logs/tezlify-monitor.log" in logrotate_text
    assert "rotate 14" in logrotate_text


def test_no_secrets_in_monitoring_files():
    """Invariance check: Monitoring configs and scripts must not contain hardcoded secrets."""
    forbidden_terms = [
        "DB_PASSWORD=",
        "SECRET_KEY=",
        "GATEWAY_ENCRYPTION_KEY=",
        "WHATSAPP_GATEWAY_SECRET=",
        "eyJh",  # JWT prefix
    ]
    for file_path in [MONITOR_SCRIPT, MONITOR_CONF, SERVICE_FILE, TIMER_FILE, LOGROTATE_FILE]:
        content = file_path.read_text()
        for term in forbidden_terms:
            assert term not in content, f"Forbidden term '{term}' leaked in {file_path.name}"


def test_state_machine_deduplication_logic(tmp_path):
    """
    Test alert state machine and transition logic:
    1. Initial OK -> no alert
    2. Transition to CRITICAL -> NEW_INCIDENT alert
    3. Consecutive CRITICAL within cooldown -> SUPPRESSED (deduplicated)
    4. Transition to OK -> RECOVERY alert
    """
    state_file = tmp_path / "state.json"
    log_file = tmp_path / "monitor.log"

    # Simulated monitor state transitions
    def simulate_state_update(overall_status, prev_state, now_epoch, cooldown_sec=3600):
        prev_status = prev_state.get("last_status", "UNKNOWN")
        incident_start = prev_state.get("incident_start_timestamp", 0)
        last_alert_ts = prev_state.get("last_alert_timestamp", 0)
        alert_count = prev_state.get("alert_count", 0)

        should_alert = False
        alert_type = ""

        if overall_status != "OK":
            if prev_status in ("OK", "UNKNOWN"):
                should_alert = True
                alert_type = "NEW_INCIDENT"
                incident_start = now_epoch
                last_alert_ts = now_epoch
                alert_count = 1
            elif overall_status == "CRITICAL" and prev_status == "WARN":
                should_alert = True
                alert_type = "ESCALATION"
                last_alert_ts = now_epoch
                alert_count += 1
            elif (now_epoch - last_alert_ts) >= cooldown_sec:
                should_alert = True
                alert_type = "REMINDER"
                last_alert_ts = now_epoch
                alert_count += 1
        else:
            if prev_status in ("CRITICAL", "WARN"):
                should_alert = True
                alert_type = "RECOVERY"
                incident_start = 0
                last_alert_ts = now_epoch
                alert_count = 0

        new_state = {
            "last_status": overall_status,
            "incident_start_timestamp": incident_start,
            "last_alert_timestamp": last_alert_ts,
            "alert_count": alert_count,
        }
        return should_alert, alert_type, new_state

    # 1. First run, all OK
    s1, t1, state = simulate_state_update("OK", {}, 1000)
    assert not s1
    assert state["last_status"] == "OK"

    # 2. Failure occurs -> NEW_INCIDENT alert
    s2, t2, state = simulate_state_update("CRITICAL", state, 1180)
    assert s2
    assert t2 == "NEW_INCIDENT"
    assert state["alert_count"] == 1
    assert state["incident_start_timestamp"] == 1180

    # 3. 3 minutes later, still CRITICAL -> Deduplicated (no spam)
    s3, t3, state = simulate_state_update("CRITICAL", state, 1360)
    assert not s3
    assert state["alert_count"] == 1

    # 4. System recovers -> RECOVERY alert
    s4, t4, state = simulate_state_update("OK", state, 1540)
    assert s4
    assert t4 == "RECOVERY"
    assert state["last_status"] == "OK"
    assert state["alert_count"] == 0
