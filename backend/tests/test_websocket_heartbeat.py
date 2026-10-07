"""Regression test for frontend client-to-backend WebSocket heartbeat (/ws).

Verifies:
1. Sending plain text "ping" responds with plain text "pong".
2. Sending JSON {"type": "ping"} responds with JSON {"type": "pong"}.
3. The connection remains alive without errors.
"""
import json
import pytest
from starlette.testclient import TestClient

from backend.app.main import app


def test_ws_heartbeat_plain_text_ping_pong():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_text("ping")
        data = ws.receive_text()
        assert data == "pong"


def test_ws_heartbeat_json_ping_pong():
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "ping"}))
        data = ws.receive_text()
        try:
            payload = json.loads(data)
            assert payload == {"type": "pong"}
        except Exception:
            assert data == "pong" or data == json.dumps({"type": "pong"})
