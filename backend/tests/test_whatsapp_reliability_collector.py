import pytest
from scripts.whatsapp_reliability_collector import evaluate_invariants


def test_evaluate_invariants_all_green():
    containers = {
        "backend": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 110.0},
        "gateway": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 85.0},
        "caddy": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 20.0},
        "db": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 590.0},
    }
    gateway = {"status": "ok", "sessions": {"total": 0, "connected": 0, "pending_qr": 0}}
    backend = {"status": "healthy", "gateway_bridge": {"connected": True, "reconnect_count": 1}}
    db_metrics = {
        "whatsapp_sessions": {"total": 2, "connected": 0, "scan_qr": 1, "relink_required": 1},
        "active_socket_leases": 0,
        "outbox": {"total": 35557, "pending": 0, "in_flight": 0, "delivered": 35448, "dead_letter": 109, "retry_messages": 0},
        "db_connections": {"total": 10, "active": 1, "idle": 4, "max": 100},
    }

    invs = evaluate_invariants(containers, gateway, backend, db_metrics)
    assert all(invs.values()), f"Expected all invariants to pass, got: {invs}"


def test_evaluate_invariants_detects_dead_letter_growth():
    containers = {
        "backend": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 110.0},
        "gateway": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 85.0},
        "caddy": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 20.0},
        "db": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 590.0},
    }
    gateway = {"status": "ok"}
    backend = {"status": "healthy", "gateway_bridge": {"connected": True, "reconnect_count": 1}}
    db_metrics = {
        "whatsapp_sessions": {"connected": 0},
        "active_socket_leases": 0,
        "outbox": {"pending": 0, "dead_letter": 115, "retry_messages": 0},
        "db_connections": {"total": 10},
    }

    invs = evaluate_invariants(containers, gateway, backend, db_metrics)
    assert invs["R9_dead_letters_stable"] is False


def test_evaluate_invariants_detects_gateway_bridge_disconnect():
    containers = {
        "backend": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 110.0},
        "gateway": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 85.0},
        "caddy": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 20.0},
        "db": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 590.0},
    }
    gateway = {"status": "ok"}
    backend = {"status": "healthy", "gateway_bridge": {"connected": False, "reconnect_count": 5}}
    db_metrics = {
        "whatsapp_sessions": {"connected": 0},
        "active_socket_leases": 0,
        "outbox": {"pending": 0, "dead_letter": 109, "retry_messages": 0},
        "db_connections": {"total": 10},
    }

    invs = evaluate_invariants(containers, gateway, backend, db_metrics)
    assert invs["R4_gateway_bridge_connected"] is False


def test_evaluate_invariants_detects_stale_lease_when_disconnected():
    containers = {
        "backend": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 110.0},
        "gateway": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 85.0},
        "caddy": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 20.0},
        "db": {"status": "running", "restarts": 0, "oom_killed": False, "rss_mb": 590.0},
    }
    gateway = {"status": "ok"}
    backend = {"status": "healthy", "gateway_bridge": {"connected": True, "reconnect_count": 1}}
    db_metrics = {
        "whatsapp_sessions": {"connected": 0},
        "active_socket_leases": 1,  # 1 lease but 0 connected
        "outbox": {"pending": 0, "dead_letter": 109, "retry_messages": 0},
        "db_connections": {"total": 10},
    }

    invs = evaluate_invariants(containers, gateway, backend, db_metrics)
    assert invs["R6_no_stale_leases"] is False
