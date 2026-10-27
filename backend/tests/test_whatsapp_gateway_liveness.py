"""Gateway bridge keepalive — a silent socket must be DETECTED, not assumed alive.

`start.py` disables the protocol-level keepalive (`ws_ping_interval=None`,
`ws_ping_timeout=None`), so the ONLY liveness signal on the gateway bridge is
the application-level `{"type": "ping"}` / `{"type": "pong"}` exchange. The
backend has always SENT the ping; before this suite it discarded the pong and
never asserted anything, so a half-open TCP connection (NAT rebind, Wi-Fi
switch, proxy restart without a FIN) left `receive_text()` blocked forever:

  * no `WebSocketDisconnect`, so the `finally` never ran,
  * the gateway never learned it was orphaned, so it never reconnected,
  * every gateway event was silently lost while `/health` still reported
    `gateway_bridge.connected = true`.

These tests pin the two halves of the contract: an unanswered keepalive closes
the socket, and an answered one does not.
"""

import asyncio
import json

import pytest
from fastapi import WebSocketDisconnect

from backend.app import main as main_module
from backend.app.core.config import settings
from backend.app.main import gateway_websocket_endpoint

TEST_GATEWAY_SECRET = "b" * 32


class SilentGatewaySocket:
    """Half-open peer: accepts writes, never delivers a frame again."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.accepted = False
        self.closed_code: int | None = None
        self.closed_reason: str | None = None
        self._closed = asyncio.Event()

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed_code = code
        self.closed_reason = reason
        self._closed.set()

    async def receive_text(self) -> str:
        # Exactly what a dead TCP peer looks like: no data, no error, forever.
        await self._closed.wait()
        raise WebSocketDisconnect()

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class PongingGatewaySocket(SilentGatewaySocket):
    """Healthy peer: answers every keepalive with a pong."""

    async def receive_text(self) -> str:
        if self._closed.is_set():
            raise WebSocketDisconnect()
        await asyncio.sleep(0)
        return json.dumps({"type": "pong"})


@pytest.fixture(autouse=True)
def _configure_gateway_secret(monkeypatch):
    monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", TEST_GATEWAY_SECRET)
    # Compress the schedule so the test does not sleep for a minute.
    monkeypatch.setattr(main_module, "_GW_PING_INTERVAL_S", 0.01)
    monkeypatch.setattr(main_module, "_GW_PONG_DEADLINE_S", 0.03)


@pytest.mark.asyncio
async def test_silent_gateway_socket_is_closed_after_unanswered_keepalives() -> None:
    socket = SilentGatewaySocket()

    await asyncio.wait_for(
        gateway_websocket_endpoint(socket, token=TEST_GATEWAY_SECRET),
        timeout=5,
    )

    assert socket.accepted is True
    # The keepalive must have actually run before giving up.
    assert [p for p in socket.sent if p.get("type") == "ping"], socket.sent
    # 1011 = "going away": the peer is not answering, hand the job to a reconnect.
    assert socket.closed_code == 1011
    assert "keepalive" in (socket.closed_reason or "").lower()


@pytest.mark.asyncio
async def test_ponging_gateway_socket_is_left_open() -> None:
    socket = PongingGatewaySocket()

    with pytest.raises(asyncio.TimeoutError):
        # The endpoint must keep running: a peer that answers is never closed.
        await asyncio.wait_for(
            gateway_websocket_endpoint(socket, token=TEST_GATEWAY_SECRET),
            timeout=0.25,
        )

    assert socket.closed_code is None, (
        f"a ponging peer was closed with {socket.closed_code}: "
        f"{(socket.closed_reason or '')!r}"
    )
