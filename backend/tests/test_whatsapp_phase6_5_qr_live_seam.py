"""Phase 6.5 — QR pairing seam test against a REAL running gateway.

Phase 6.4 proved each half of the QR chain in isolation, but never the SEAM:

  * the gateway tests drove the real `SessionManager` and asserted
    `session_qr_updated` was emitted — but never went through the backend;
  * the backend tests mocked `whatsapp_gateway.create_session` and
    `get_session_qr` — so the real HTTP client, the real route, and the real
    response shape were never exercised together;
  * the frontend tests stubbed `fetch` entirely.

Nothing therefore covered "the real gateway's QR actually reaches the browser
through the real backend route". This file does exactly that, with only the
WhatsApp/Baileys network boundary faked.

Enable by pointing at a running gateway:

    WHATSAPP_LIVE_GATEWAY_URL=http://127.0.0.1:8791 pytest \
        backend/tests/test_whatsapp_phase6_5_qr_live_seam.py -q

Without the variable the tests SKIP, so the default suite stays hermetic.
"""
import os
import uuid

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp_service import ingest_gateway_event
from backend.tests.test_whatsapp_live import _make_jwt, _auth_headers

LIVE_URL = os.getenv("WHATSAPP_LIVE_GATEWAY_URL", "").strip()
TEST_UID = "67890123-6789-6789-6789-678901234567"
TEST_UID_HEX = "67890123678967896789678901234567"

pytestmark = pytest.mark.skipif(
    not LIVE_URL,
    reason="set WHATSAPP_LIVE_GATEWAY_URL to run the live QR seam test",
)


@pytest.fixture
def auth_headers():
    return _auth_headers(_make_jwt(user_id=TEST_UID))


@pytest.fixture(autouse=True)
def point_at_live_gateway(monkeypatch):
    monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_URL", LIVE_URL, raising=False)


@pytest_asyncio.fixture(autouse=True)
async def cleanup_test_sessions():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:a, :a_hex)"),
                {"a": TEST_UID, "a_hex": TEST_UID_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


def _checkpoints():
    return {}


class TestPhase65QrLiveSeam:

    @pytest.mark.asyncio
    async def test_qr_reaches_backend_from_a_real_gateway(self, auth_headers):
        """Q1..Q12: the QR the gateway really encodes must survive the trip.

        A mock could never catch a response-shape drift between
        `session-manager.js` and `whatsapp_gateway.get_session_qr`, which is
        precisely the class of bug this seam test exists for.
        """
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test", timeout=30.0) as client:
            # Q3/Q4: start an ephemeral pairing -> pair_token, zero DB rows.
            start = await client.post(
                "/api/v1/whatsapp/pairing/start",
                json={"name": "QR Live Seam"},
                headers=auth_headers,
            )
            assert start.status_code == 201, start.text
            body = start.json()
            pair_token = body["pair_token"]
            assert pair_token, body
            assert body.get("session_id") is None, "ephemeral pairing must not mint a row yet"

            # Q5/Q6: the REAL gateway really created a socket for it.
            gw_session = await gw.get_session_status(body["gateway_id"])
            assert gw_session["id"] == body["gateway_id"]

            # Q7..Q11: poll the REAL backend route until the gateway has a QR.
            qr = None
            last = None
            for _ in range(40):
                res = await client.get(
                    f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=auth_headers
                )
                assert res.status_code == 200, res.text
                last = res.json()
                if last.get("qr_code"):
                    qr = last["qr_code"]
                    break
                import asyncio

                await asyncio.sleep(0.25)

            assert qr, f"the real QR never reached the backend; last payload={last}"
            assert qr.startswith("data:image/png;base64,"), (
                f"the gateway data URI must be forwarded verbatim, got {qr[:60]!r}"
            )
            # A real QR PNG is a few KB; a stub or an empty string is not.
            assert len(qr) > 1000, f"QR payload looks empty/truncated: {len(qr)} chars"

            # Q12: it must actually decode as a PNG.
            import base64

            raw = base64.b64decode(qr.split(",", 1)[1])
            assert raw[:8] == b"\x89PNG\r\n\x1a\n", "the forwarded payload is not a PNG"

            # S-2: still zero persisted rows — the pairing has not connected.
            from sqlalchemy import func, select

            from backend.app.models.whatsapp_session import WhatsAppSession

            async with AsyncSessionLocal() as db:
                count = await db.scalar(
                    select(func.count(WhatsAppSession.id)).where(
                        WhatsAppSession.user_id == TEST_UID_HEX
                    )
                )
                assert count == 0, "a QR-only pairing must never create a session row"

    @pytest.mark.asyncio
    async def test_qr_owner_scoping_survives_the_live_route(self, auth_headers):
        """§7: the live route must stay owner-scoped, never a global read."""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test", timeout=30.0) as client:
            start = await client.post(
                "/api/v1/whatsapp/pairing/start",
                json={"name": "QR Owner"},
                headers=auth_headers,
            )
            assert start.status_code == 201, start.text
            pair_token = start.json()["pair_token"]

            other = _auth_headers(_make_jwt(user_id="78901234-7890-7890-7890-789012345678"))
            res = await client.get(
                f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=other
            )
            assert res.status_code == 404, (
                f"another tenant must not read this pairing's QR: {res.status_code}"
            )

    @pytest.mark.asyncio
    async def test_real_gateway_event_payload_resolves_to_its_owner(self, auth_headers):
        """Q8..Q11 over the EVENT path, using the gateway's verbatim payload.

        `backend/tests/fixtures/real_gateway_qr_events.json` holds payloads
        captured on the real `/ws/gateway` socket from a running gateway (only
        the Baileys boundary faked). Asserting on the REAL shape matters: a
        hand-written fixture would happily omit `gateway_session_id`, which is
        exactly the field the resolver falls back to.
        """
        import json
        import pathlib

        fixture_path = pathlib.Path(__file__).parent / "fixtures" / "real_gateway_qr_events.json"
        fixture = json.loads(fixture_path.read_text())
        qr_event = next(e for e in fixture["events"] if e["event"] == "session_qr_updated")

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test", timeout=30.0) as client:
            start = await client.post(
                "/api/v1/whatsapp/pairing/start",
                json={"name": "Real Event Shape"},
                headers=auth_headers,
            )
            assert start.status_code == 201, start.text
            gateway_id = start.json()["gateway_id"]

            # The payload the gateway really sends, addressed to this pairing.
            event = dict(qr_event)
            event["session_id"] = gateway_id
            event["gateway_session_id"] = gateway_id
            event["event_id"] = str(uuid.uuid4())

            result = await ingest_gateway_event(dict(event))

            assert result is not None, (
                "the backend dropped the gateway's real session_qr_updated payload "
                "(main.py would count it `skipped` and never broadcast it)"
            )
            assert result.get("event") == "session_qr_updated"
            assert str(result.get("user_id")) in (TEST_UID, TEST_UID_HEX), result
            assert result.get("qr_code") == qr_event["qr_code"], "the QR must survive ingest verbatim"
            # `session_name` is absent from the real QR payload; the resolver
            # fills it from the ephemeral registry so the UI can correlate.
            assert result.get("session_name"), "session_name must be recovered for correlation"

    @pytest.mark.asyncio
    async def test_unknown_token_is_404_not_500(self, auth_headers):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test", timeout=30.0) as client:
            res = await client.get(
                f"/api/v1/whatsapp/pairing/{uuid.uuid4()}/qr", headers=auth_headers
            )
            assert res.status_code == 404, res.text
