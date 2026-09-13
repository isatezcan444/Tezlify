"""Gateway durable-outbox ACK contract."""

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect

from backend.app.main import gateway_websocket_endpoint, ws_manager
from backend.app.services import whatsapp_service


class FakeGatewaySocket:
    def __init__(self, event: dict) -> None:
        self._messages = [json.dumps(event)]
        self.sent: list[dict] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        if self._messages:
            return self._messages.pop(0)
        raise WebSocketDisconnect()

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_gateway_event_is_acked_only_after_persist_and_broadcast(monkeypatch) -> None:
    event_id = "cf7eb30d-f378-450b-92f0-11e7fdcc5c5a"
    socket = FakeGatewaySocket({"event": "session_connected", "event_id": event_id})
    ingest = AsyncMock(return_value={"event": "session_connected", "user_id": "owner"})
    broadcast = AsyncMock()
    monkeypatch.setattr(whatsapp_service, "ingest_gateway_event", ingest)
    monkeypatch.setattr(ws_manager, "broadcast", broadcast)

    await gateway_websocket_endpoint(socket, token=None)

    assert socket.accepted is True
    ingest.assert_awaited_once()
    broadcast.assert_awaited_once()
    assert socket.sent == [{"type": "gateway_event_ack", "event_id": event_id}]


@pytest.mark.asyncio
async def test_unpersisted_gateway_event_is_nacked_and_not_broadcast(monkeypatch) -> None:
    event_id = "96fe5c10-8ca3-4017-8bbc-f5ef04a12ae1"
    socket = FakeGatewaySocket({"event": "unknown", "event_id": event_id})
    monkeypatch.setattr(
        whatsapp_service,
        "ingest_gateway_event",
        AsyncMock(return_value=None),
    )
    broadcast = AsyncMock()
    monkeypatch.setattr(ws_manager, "broadcast", broadcast)

    await gateway_websocket_endpoint(socket, token=None)

    broadcast.assert_not_awaited()
    assert socket.sent == [{
        "type": "gateway_event_nack",
        "event_id": event_id,
        "permanent": False,
    }]
