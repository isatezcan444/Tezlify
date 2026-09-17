"""Unit and characterization tests for WhatsApp Session Orchestrator (Phase 11.9 Batch 1).

Tests session lifecycle operations, QR codes, pairing codes, relink detection, and data purges.
"""
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.exceptions import WhatsAppRelinkRequired
from backend.app.services.whatsapp.orchestration.sessions import (
    _apply_gateway_live,
    _gateway_op_or_mark_relink,
    _session_dict,
    create_session,
    delete_session,
    get_session_qr,
    list_sessions,
    logout_session,
    purge_whatsapp_data,
    refresh_session_qr,
    request_pairing_code,
)
from backend.app.services.whatsapp_gateway import WhatsAppGatewayError


class TestWhatsAppSessionOrchestrator:

    def test_session_dict_serialization(self):
        row = WhatsAppSession(
            id=10,
            user_id="u-123",
            gateway_id="gw-123",
            session_name="Primary",
            status=SessionStatus.CONNECTED,
            phone_number="+905551112233",
            is_active=True,
            is_phone_online=True,
            battery_level=90,
            qr_code=None,
            error_message=None,
            created_at=datetime(2026, 1, 1),
            updated_at=datetime(2026, 1, 2),
        )
        d = _session_dict(row)
        assert d["id"] == 10
        assert d["session_name"] == "Primary"
        assert d["status"] == "CONNECTED"
        assert d["phone_number"] == "+905551112233"
        assert d["is_active"] is True
        assert d["is_phone_online"] is True
        assert d["battery_level"] == 90

    def test_apply_gateway_live_clears_error_on_connected(self):
        row = WhatsAppSession(
            id=10,
            status=SessionStatus.DISCONNECTED,
            error_message="Stream dropped",
        )
        data = {
            "status": "CONNECTED",
            "phone": "+905559998877",
            "error_message": "Some transient log",
        }
        _apply_gateway_live(row, data)
        assert row.status == SessionStatus.CONNECTED
        assert row.phone_number == "+905559998877"
        assert row.error_message is None

    def test_apply_gateway_live_keeps_error_on_connecting(self):
        row = WhatsAppSession(
            id=10,
            status=SessionStatus.DISCONNECTED,
        )
        data = {
            "status": "CONNECTING",
            "error_message": "Connection attempt 2/5",
        }
        _apply_gateway_live(row, data)
        assert row.status == SessionStatus.CONNECTING
        assert row.error_message == "Connection attempt 2/5"

    @pytest.mark.asyncio
    async def test_gateway_op_or_mark_relink_success(self):
        db = AsyncMock()
        row = WhatsAppSession(id=1, gateway_id="gw-1", status=SessionStatus.SCAN_QR)
        op = AsyncMock(return_value={"qr": "test-qr"})

        res = await _gateway_op_or_mark_relink(db, row, op)
        assert res == {"qr": "test-qr"}
        db.commit.assert_not_called()

    @pytest.mark.asyncio
    async def test_gateway_op_or_mark_relink_triggers_relink_on_missing_session(self):
        db = AsyncMock()
        row = WhatsAppSession(
            id=1,
            user_id="user-42",
            gateway_id="gw-orphan",
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
        )
        op = AsyncMock(side_effect=WhatsAppGatewayError("Not found", status_code=404))

        with patch("backend.app.api.v1.websocket.ws_manager.broadcast", new_callable=AsyncMock) as mock_ws:
            with pytest.raises(WhatsAppRelinkRequired):
                await _gateway_op_or_mark_relink(db, row, op)

        assert row.status == SessionStatus.RELINK_REQUIRED
        assert row.is_phone_online is False
        assert row.error_message == "WHATSAPP_AUTH_RELINK_REQUIRED"
        db.commit.assert_awaited_once()
        mock_ws.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_gateway_op_or_mark_relink_propagates_other_errors(self):
        db = AsyncMock()
        row = WhatsAppSession(id=1, gateway_id="gw-1", status=SessionStatus.CONNECTED)
        op = AsyncMock(side_effect=WhatsAppGatewayError("Internal 500", status_code=500))

        with pytest.raises(WhatsAppGatewayError):
            await _gateway_op_or_mark_relink(db, row, op)

        assert row.status == SessionStatus.CONNECTED
        db.commit.assert_not_called()

    @pytest.mark.asyncio
    async def test_create_session(self):
        db = AsyncMock()
        gw_res = {
            "id": "gw-uuid-10",
            "session_name": "Test Line",
            "status": "SCAN_QR",
        }
        with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=gw_res):
            res = await create_session(db, "u-1", "Test Line")

        assert res["session_name"] == "Test Line"
        assert res["status"] == "SCAN_QR"
        db.add.assert_called_once()
        db.commit.assert_awaited_once()
        db.refresh.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_get_session_qr(self):
        db = AsyncMock()
        row = WhatsAppSession(id=5, gateway_id="gw-5", status=SessionStatus.SCAN_QR)
        with patch("backend.app.services.whatsapp.orchestration.sessions._get_session_or_404", new_callable=AsyncMock, return_value=row), \
             patch("backend.app.services.whatsapp_gateway.get_session_qr", new_callable=AsyncMock, return_value={"qr_code": "data:image/png..."}):
            res = await get_session_qr(db, "u-1", 5)

        assert res["status"] == "SCAN_QR"
        assert res["qr_code"] == "data:image/png..."
        db.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_request_pairing_code(self):
        db = AsyncMock()
        row = WhatsAppSession(id=5, gateway_id="gw-5", status=SessionStatus.SCAN_QR)
        with patch("backend.app.services.whatsapp.orchestration.sessions._get_session_or_404", new_callable=AsyncMock, return_value=row), \
             patch("backend.app.services.whatsapp_gateway.request_pairing_code", new_callable=AsyncMock, return_value={"code": "1234-5678", "phone": "+905551234567"}):
            res = await request_pairing_code(db, "u-1", 5, "+905551234567")

        assert res["success"] is True
        assert res["pairing_code"] == "1234-5678"
        assert res["phone"] == "+905551234567"
        assert row.phone_number == "+905551234567"
        db.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_logout_session(self):
        db = AsyncMock()
        row = WhatsAppSession(id=5, gateway_id="gw-5", status=SessionStatus.CONNECTED, is_active=True, is_phone_online=True)
        with patch("backend.app.services.whatsapp.orchestration.sessions._get_session_or_404", new_callable=AsyncMock, return_value=row), \
             patch("backend.app.services.whatsapp_gateway.logout_session", new_callable=AsyncMock, return_value={"success": True}):
            res = await logout_session(db, "u-1", 5)

        assert res["success"] is True
        assert res["status"] == "DISCONNECTED"
        assert row.status == SessionStatus.DISCONNECTED
        assert row.is_active is False
        assert row.is_phone_online is False
        db.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_delete_session_calls_cancel_and_purge(self):
        db = AsyncMock()
        row = WhatsAppSession(id=5, gateway_id="gw-5")
        cancel_sync_mock = MagicMock()
        with patch("backend.app.services.whatsapp.orchestration.sessions._get_session_or_404", new_callable=AsyncMock, return_value=row), \
             patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}), \
             patch("backend.app.services.whatsapp.orchestration.sessions.purge_whatsapp_data", new_callable=AsyncMock, return_value={"messages": 5, "conversations": 1, "contacts": 0}):
            res = await delete_session(db, "u-1", 5, on_cancel_sync=cancel_sync_mock)

        assert res["success"] is True
        assert res["purged"] == {"messages": 5, "conversations": 1, "contacts": 0}
        cancel_sync_mock.assert_called_once_with("u-1")
        db.delete.assert_awaited_once_with(row)
        db.commit.assert_awaited_once()
