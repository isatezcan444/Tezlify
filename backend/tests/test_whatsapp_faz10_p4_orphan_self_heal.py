"""Faz 10 P4 — Redeploy sonrası YETİM gateway oturumu self-heal regresyonu.

Kök neden (canli probe ile kanitlandi, 2026-09-11): Render redeploy'da
gateway'in bellekteki `sessions` Map'i sifirlaniyor; DB `whatsapp_sessions`
satirlari bayat `gateway_id` UUID'leri ile kaliyor. QR cekme / QR yenileme /
pairing kodu cagrilari gateway'de "Session not found" -> 500 -> backend 502
"WhatsApp gateway'e ulasilamadi" uretiyordu. Kullanici bildirimi:
"qr baglanti kismina kod ile baglanti kurulmuyor".

Bu testler self-heal'i kanitlar:
1. pair: ilk cagri "Session not found" -> create_session ile yeniden kur +
   gateway_id guncellenir + retry gercek kodu donerür (testte mock gercek kod).
2. qr fetch: ayni akis QR icin.
3. qr refresh: ayni akis yenileme icin.
4. FAIL-CLOSED regresyon: "Session not found" DIŞINDAKI gateway hatalari
   yutulmaz, create_session hic cagrilmaz, hata aynen yukselir.
5. logout: gateway'de oturum zaten yoksa hata degil DISCONNECTED ile biter;
   yeniden oturum KURULMAZ (gereksiz soket acilir mi kontrolu).
6. Endpoint seviyesi: POST /sessions/{id}/pair HTTP 200 + pairing_code doner
   (eskiden 502 idi) — HTTP yuzeyinde kanit.
"""
import base64
import json
import uuid as _uuid
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.main import app
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_gateway as gw
from backend.app.services import whatsapp_service as ws

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
SYS_USER_HEX = "00000000000000000000000000000000"
STALE_GW_ID = "aaaaaaaa-1111-2222-3333-444444444444"
PHONE = "+905321002030"

# Gateway'in gercek 500 govdesi (index.js: res.status(500).json({error})) ve
# QR route'unun gercek 404 govdesi — client bunlari WhatsAppGatewayError
# icine sarar. Self-heal tetikleyicisi tam olarak bu metindir.
NOT_FOUND_500 = gw.WhatsAppGatewayError('Gateway hatası 500: {"error":"Session not found"}')
NOT_FOUND_404 = gw.WhatsAppGatewayError('Gateway hatası 404: {"error":"Session not found"}')


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:h1, :h2)"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def _seed_orphan_session(status: SessionStatus = SessionStatus.SCAN_QR) -> int:
    """Bayat gateway_id'li DB satiri tohumlar (redeploy sonrasi gercek durum)."""
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=TEST_USER, gateway_id=STALE_GW_ID, session_name="Hat 1",
            status=status, is_active=True,
        )
        db.add(row)
        await db.commit()
        return int(row.id)


def _created_gw_session(new_id: str) -> dict:
    return {
        "id": new_id, "session_name": "Hat 1", "status": "SCAN_QR",
        "qr_code": "data:image/png;base64,NEWQR==", "phone_number": None,
        "is_phone_online": False, "battery_level": None,
    }


async def _get_row(session_pk: int) -> WhatsAppSession:
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(WhatsAppSession).where(WhatsAppSession.id == session_pk))
        return res.scalar_one()


# ---------------------------------------------------------------------------
# 1. Pairing kodu — kullanicinin bildirdigi kirik akis, artik self-heal
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pairing_code_self_heals_orphaned_gateway_session():
    session_pk = await _seed_orphan_session()
    new_gw_id = str(_uuid.uuid4())
    pair_calls = []

    async def fake_pair(gid: str, phone: str):
        pair_calls.append(gid)
        if len(pair_calls) == 1:
            raise NOT_FOUND_500
        return {"success": True, "pairing_code": "H3K9M2PQ", "phone": PHONE}

    with patch("backend.app.services.whatsapp_service.gw.request_pairing_code", new_callable=AsyncMock, side_effect=fake_pair), \
         patch("backend.app.services.whatsapp_service.gw.create_session", new_callable=AsyncMock,
               return_value=_created_gw_session(new_gw_id)) as create_mock:
        result = await _call_pair(session_pk, PHONE)

    assert result["success"] is True
    assert result["pairing_code"] == "H3K9M2PQ"
    # Gateway'e once bayat id ile gidildi, self-heal sonrasi taze id ile retry edildi.
    assert pair_calls == [STALE_GW_ID, new_gw_id]
    create_mock.assert_awaited_once_with("Hat 1")
    row = await _get_row(session_pk)
    assert row.gateway_id == new_gw_id
    assert row.status == SessionStatus.SCAN_QR
    assert row.error_message is None


async def _call_pair(session_pk: int, phone: str) -> dict:
    async with AsyncSessionLocal() as db:
        return await ws.request_pairing_code(db, TEST_USER, session_pk, phone)


# ---------------------------------------------------------------------------
# 2. QR cekme — modal acilirken ayni yetimlik 502 uretiyordu
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_session_qr_self_heals_orphaned_gateway_session():
    session_pk = await _seed_orphan_session()
    new_gw_id = str(_uuid.uuid4())
    qr_calls = []

    async def fake_qr(gid: str):
        qr_calls.append(gid)
        if len(qr_calls) == 1:
            raise NOT_FOUND_404
        return {"status": "SCAN_QR", "qr_code": "data:image/png;base64,HEALED==", "phone": None}

    with patch("backend.app.services.whatsapp_service.gw.get_session_qr", new_callable=AsyncMock, side_effect=fake_qr), \
         patch("backend.app.services.whatsapp_service.gw.create_session", new_callable=AsyncMock,
               return_value=_created_gw_session(new_gw_id)):
        async with AsyncSessionLocal() as db:
            result = await ws.get_session_qr(db, TEST_USER, session_pk)

    assert qr_calls == [STALE_GW_ID, new_gw_id]
    assert result["qr_code"] == "data:image/png;base64,HEALED=="
    assert result["status"] == "SCAN_QR"
    row = await _get_row(session_pk)
    assert row.gateway_id == new_gw_id


# ---------------------------------------------------------------------------
# 3. QR yenileme
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_refresh_session_qr_self_heals_orphaned_gateway_session():
    session_pk = await _seed_orphan_session()
    new_gw_id = str(_uuid.uuid4())
    calls = []

    async def fake_refresh(gid: str):
        calls.append(gid)
        if len(calls) == 1:
            raise NOT_FOUND_500
        return {"status": "SCAN_QR", "qr_code": "data:image/png;base64,REFRESHED=="}

    with patch("backend.app.services.whatsapp_service.gw.refresh_session_qr", new_callable=AsyncMock, side_effect=fake_refresh), \
         patch("backend.app.services.whatsapp_service.gw.create_session", new_callable=AsyncMock,
               return_value=_created_gw_session(new_gw_id)):
        async with AsyncSessionLocal() as db:
            result = await ws.refresh_session_qr(db, TEST_USER, session_pk)

    assert calls == [STALE_GW_ID, new_gw_id]
    assert result["qr_code"] == "data:image/png;base64,REFRESHED=="


# ---------------------------------------------------------------------------
# 4. FAIL-CLOSED regresyon — "Session not found" dışındaki hata YUTULMAZ
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_non_missing_session_error_is_not_healed_fail_closed():
    session_pk = await _seed_orphan_session(status=SessionStatus.CONNECTING)
    with patch("backend.app.services.whatsapp_service.gw.request_pairing_code", new_callable=AsyncMock,
               side_effect=gw.WhatsAppGatewayError("Gateway hatası 500: {\"error\":\"WhatsApp soketi hazırlanamadı\"}")), \
         patch("backend.app.services.whatsapp_service.gw.create_session", new_callable=AsyncMock) as create_mock:
        with pytest.raises(gw.WhatsAppGatewayError) as exc_info:
            await _call_pair(session_pk, PHONE)

    assert "soketi hazırlanamadı" in str(exc_info.value)
    create_mock.assert_not_awaited()
    row = await _get_row(session_pk)
    assert row.gateway_id == STALE_GW_ID  # bayat id korunur, durum maskelenmez
    assert row.status == SessionStatus.CONNECTING


@pytest.mark.asyncio
async def test_recreate_failure_propagates_fail_closed():
    """Gateway'e hic ulasilamiyorsa self-heal de patlar — sahte basari yok."""
    session_pk = await _seed_orphan_session()
    with patch("backend.app.services.whatsapp_service.gw.request_pairing_code", new_callable=AsyncMock,
               side_effect=NOT_FOUND_500), \
         patch("backend.app.services.whatsapp_service.gw.create_session", new_callable=AsyncMock,
               side_effect=gw.WhatsAppGatewayError("Gateway'e ulaşılamadı (http://127.0.0.1:8787): connect error")):
        with pytest.raises(gw.WhatsAppGatewayError) as exc_info:
            await _call_pair(session_pk, PHONE)

    assert "ulaşılamadı" in str(exc_info.value)
    row = await _get_row(session_pk)
    assert row.gateway_id == STALE_GW_ID


# ---------------------------------------------------------------------------
# 5. Logout — oturum zaten yoksa hedef durum saglanmistir, yeniden KURULMAZ
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_logout_tolerates_missing_gateway_session_without_recreate():
    session_pk = await _seed_orphan_session(status=SessionStatus.CONNECTED)
    with patch("backend.app.services.whatsapp_service.gw.logout_session", new_callable=AsyncMock,
               side_effect=NOT_FOUND_500), \
         patch("backend.app.services.whatsapp_service.gw.create_session", new_callable=AsyncMock) as create_mock:
        async with AsyncSessionLocal() as db:
            result = await ws.logout_session(db, TEST_USER, session_pk)

    assert result == {"success": True, "status": "DISCONNECTED"}
    create_mock.assert_not_awaited()
    row = await _get_row(session_pk)
    assert row.status == SessionStatus.DISCONNECTED
    assert row.is_active is False


@pytest.mark.asyncio
async def test_logout_other_gateway_error_still_raises():
    session_pk = await _seed_orphan_session(status=SessionStatus.CONNECTED)
    with patch("backend.app.services.whatsapp_service.gw.logout_session", new_callable=AsyncMock,
               side_effect=gw.WhatsAppGatewayError("Gateway hatası 500: boom")):
        async with AsyncSessionLocal() as db:
            with pytest.raises(gw.WhatsAppGatewayError):
                await ws.logout_session(db, TEST_USER, session_pk)
    row = await _get_row(session_pk)
    assert row.status == SessionStatus.CONNECTED  # basarisiz logout durumu degistirmez


# ---------------------------------------------------------------------------
# 6. Endpoint seviyesi kanit — kirik akista 502 donen POST /pair artik 200
# ---------------------------------------------------------------------------

def _make_jwt(user_id: str = TEST_USER) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id, "email": "wa-test@tezlify.com",
        "user_metadata": {"full_name": "WA Test User"},
    }).encode()).decode().rstrip("=")
    return f"{header}.{payload}.mock_sig"


@pytest.mark.asyncio
async def test_pair_endpoint_returns_200_after_self_heal():
    session_pk = await _seed_orphan_session()
    new_gw_id = str(_uuid.uuid4())
    calls = []

    async def fake_pair(gid: str, phone: str):
        calls.append(gid)
        if len(calls) == 1:
            raise NOT_FOUND_500
        return {"success": True, "pairing_code": "ZZ88QQ11", "phone": PHONE}

    headers = {"Authorization": f"Bearer {_make_jwt()}"}
    with patch("backend.app.services.whatsapp_service.gw.request_pairing_code", new_callable=AsyncMock, side_effect=fake_pair), \
         patch("backend.app.services.whatsapp_service.gw.create_session", new_callable=AsyncMock,
               return_value=_created_gw_session(new_gw_id)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/whatsapp/sessions/{session_pk}/pair",
                json={"phone": PHONE}, headers=headers,
            )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    assert body["pairing_code"] == "ZZ88QQ11"
    assert calls == [STALE_GW_ID, new_gw_id]
