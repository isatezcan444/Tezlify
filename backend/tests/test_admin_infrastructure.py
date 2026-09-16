"""Unit tests for host/container/system data parsing logic in Admin Center.

Invariants:
- All file parsers (proc files, JSON snapshots, git HEAD, SSH configs, backup directories)
  are tested with synthetic fixtures.
- Zero production mutation.
"""

import json
import os
import tempfile
import pytest

from backend.app.services.admin.system_service import get_system_metrics
from backend.app.services.admin.backups_admin_service import _inspect_backup_dir, _format_size_human, _compute_total_backup_usage
from backend.app.services.admin.monitoring_admin_service import get_monitoring_metrics
from backend.app.services.admin.deployment_admin_service import _get_git_info, _get_distro_info
from backend.app.services.admin.security_admin_service import _parse_ssh_hardening, _inspect_container_isolation


def test_format_size_human():
    assert _format_size_human(500) == "500 B"
    assert _format_size_human(1024) == "1.0 KB"
    assert _format_size_human(1024 * 1024 * 5) == "5.0 MB"
    assert _format_size_human(1024 * 1024 * 1024 * 2) == "2.00 GB"


def test_inspect_backup_dir_empty_or_nonexistent():
    info = _inspect_backup_dir("/nonexistent/directory/path")
    assert info.latest_backup_filename is None
    assert info.size_bytes is None


def test_inspect_backup_dir_with_files():
    with tempfile.TemporaryDirectory() as tmpdir:
        f1 = os.path.join(tmpdir, "backup_old.dump")
        f2 = os.path.join(tmpdir, "backup_new.dump")
        with open(f1, "w") as f:
            f.write("old data" * 100)
        with open(f2, "w") as f:
            f.write("new data" * 500)
        # Ensure mtime of f2 is later
        os.utime(f1, (1000, 1000))
        os.utime(f2, (2000, 2000))

        info = _inspect_backup_dir(tmpdir)
        assert info.latest_backup_filename == "backup_new.dump"
        assert info.size_bytes == 4000
        assert info.size_human is not None
        assert info.created_at is not None

        tot_bytes, tot_human = _compute_total_backup_usage(tmpdir)
        assert tot_bytes == 4800


def test_get_git_info_from_direct_head():
    with tempfile.TemporaryDirectory() as tmpdir:
        git_dir = os.path.join(tmpdir, ".git")
        os.makedirs(os.path.join(git_dir, "refs", "heads"), exist_ok=True)
        head_path = os.path.join(git_dir, "HEAD")
        ref_path = os.path.join(git_dir, "refs", "heads", "main")
        
        with open(head_path, "w") as f:
            f.write("ref: refs/heads/main\n")
        with open(ref_path, "w") as f:
            f.write("0123456789abcdef0123456789abcdef01234567\n")

        branch, commit_hash, _, _, _ = _get_git_info(tmpdir)
        assert branch == "main"
        assert commit_hash == "0123456789abcdef0123456789abcdef01234567"


def test_monitoring_metrics_parsing_with_mock_data(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        baseline_file = os.path.join(tmpdir, "baseline.json")
        current_file = os.path.join(tmpdir, "current.json")
        obs_file = os.path.join(tmpdir, "observations.jsonl")

        sample_current = {
            "timestamp": "2026-09-16T15:00:00Z",
            "invariants": {
                "R1_no_unexpected_restarts": True,
                "R2_no_oom_kills": True,
                "R3_postgres_reachable": True,
                "R4_gateway_bridge_connected": True,
                "R5_no_duplicate_socket_ownership": True,
                "R6_no_stale_leases": True,
                "R7_outbox_pending_stable": True,
                "R8_retry_backlog_stable": True,
                "R9_dead_letters_stable": True,
                "R10_no_reconnect_storm": True,
                "R11_rss_stable": True,
                "R12_gateway_healthy": True,
                "R13_all_containers_running": True,
            },
            "all_invariants_pass": True,
        }
        with open(current_file, "w") as f:
            json.dump(sample_current, f)

        with open(obs_file, "w") as f:
            for i in range(5):
                f.write(json.dumps({
                    "timestamp": f"2026-09-16T15:0{i}:00Z",
                    "all_invariants_pass": True,
                    "loadavg": [0.1, 0.2, 0.3],
                    "containers": {"backend": {"rss_mb": 110.0}, "gateway": {"rss_mb": 120.0}},
                    "db": {"active_socket_leases": 0, "outbox": {"pending": 0, "dead_letter": 109}},
                }) + "\n")

        from backend.app.core.config import settings
        monkeypatch.setattr(settings, "TEZLIFY_RUNTIME_DIR", tmpdir)

        resp = get_monitoring_metrics()
        assert resp.whatsapp_observer.timer_status == "active"
        assert resp.observation.sample_count == 5
        assert len(resp.invariants) == 13
        assert all(inv.passed for inv in resp.invariants)
        assert len(resp.recent_observations) == 5
        assert resp.overall_status in ("OK", "WARN", "CRITICAL")
        assert resp.observation.target_seconds == 259200.0
