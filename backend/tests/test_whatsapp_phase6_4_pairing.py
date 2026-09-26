"""Phase 6.4 — P6-8: phone pairing code for a NEW (ephemeral) pairing.

Root cause
----------
`/sessions/{id}/pair` requires a NUMERIC session id. A first-time pairing has
none: the whole point of the ephemeral lifecycle is zero rows in
`public.whatsapp_sessions` until the pairing actually connects. The UI therefore
did `if (!targetSessionId) { await initSession(); if (!activeSessionIdRef.current)
return; }` and returned BEFORE setting any loading state — clicking "Kod Al" was
a silent no-op that additionally fired a second `startPairing`.

Fix
---
`POST /api/v1/whatsapp/pairing/{pair_token}/pair` — the same gateway
`requestPairingCode` call, addressed by the ephemeral pairing's gateway session,
on the same lifecycle as QR pairing (promotion still happens on
connection.open). No second session system is introduced.

These tests are the fail→pass proof: they fail before the endpoint exists and
pass after.
"""
import asyncio
import uuid
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text, select, func
from unittest.mock import AsyncMock, patch

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.contact import Contact
from backend.tests.test_whatsapp_live import _make_jwt, _auth_headers

TEST_UID = "45678901-4567-4567-4567-456789012345"
TEST_UID_HEX = "45678901456745674567456789012345"
OTHER_UID = "56789012-5678-5678-5678-567890123456"


@pytest.fixture
def auth_headers():
    return _auth_headers(_make_jwt(user_id=TEST_UID))


@pytest.fixture
def other_headers():
    return _auth_headers(_make_jwt(user_id=OTHER_UID))


@pytest_asyncio.fixture(autouse=True)
async def cleanup_test_sessions():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:a, :a_hex, :b)"),
                {"a": TEST_UID, "a_hex": TEST_UID_HEX, "b": OTHER_UID},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id IN (:a, :a_hex, :b)"),
                {"a": TEST_UID, "a_hex": TEST_UID_HEX, "b": OTHER_UID},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


def _mock_gw_session(gw_id, status="SCAN_QR"):
    return {
        "id": gw_id,
        "session_name": "Test Ephemeral Device",
        "status": status,
        "qr_code": "data:image/png;base64,MOCK_PAIRING_QR_P6_8",
        "phone_number": None if status != "CONNECTED" else "+905413749073",
        "is_phone_online": status == "CONNECTED",
        "battery_level": None,
        "is_active": True,
        "ephemeral": True,
    }


async def _start_pairing(client, headers, gw_id, name="Pairing Code Line"):
    with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_session(gw_id)):
        res = await client.post("/api/v1/whatsapp/pairing/start", json={"name": name}, headers=headers)
    assert res.status_code == 201, res.text
    return res.json()


class TestP68PhonePairingCode:

    @pytest.mark.asyncio
    async def test_p68_new_pairing_requests_code_by_pair_token(self, auth_headers):
        """THE ORIGINAL BUG: a new ephemeral pairing + "Kod Al" produced nothing.

        There is no numeric session id yet, so the only route that existed
        (`/sessions/{id}/pair`) was unreachable and the UI silently returned.
        The pair_token-addressed endpoint must return a code.
        """
        gw_id = f"gw-p68-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            pair_token = start["pair_token"]
            assert start.get("session_id") is None, "an ephemeral pairing must have no numeric id"

            with patch(
                "backend.app.services.whatsapp_gateway.request_pairing_code",
                new_callable=AsyncMock,
                return_value={"success": True, "pairing_code": "12345678", "phone": "+905413749073"},
            ) as mock_pair:
                res = await client.post(
                    f"/api/v1/whatsapp/pairing/{pair_token}/pair",
                    json={"phone": "905413749073"},
                    headers=auth_headers,
                )

            assert res.status_code == 200, res.text
            body = res.json()
            assert body["pairing_code"] == "12345678", body
            # The SAME gateway implementation must serve both flows.
            mock_pair.assert_awaited_once()
            assert mock_pair.await_args.args[0] == gw_id, (
                f"must use the ephemeral gateway session {gw_id}, got {mock_pair.await_args.args[0]}"
            )

    @pytest.mark.asyncio
    async def test_p68_code_flow_persists_no_phone_before_success(self, auth_headers):
        """S-2 must survive: requesting a code never writes the number to a row."""
        gw_id = f"gw-p68b-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            pair_token = start["pair_token"]

            with patch(
                "backend.app.services.whatsapp_gateway.request_pairing_code",
                new_callable=AsyncMock,
                return_value={"success": True, "pairing_code": "87654321", "phone": "+905413749073"},
            ):
                res = await client.post(
                    f"/api/v1/whatsapp/pairing/{pair_token}/pair",
                    json={"phone": "+905413749073"},
                    headers=auth_headers,
                )
            assert res.status_code == 200

            async with AsyncSessionLocal() as db:
                count = await db.scalar(
                    select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_UID_HEX)
                )
                assert count == 0, "requesting a pairing code must not create a session row"

    @pytest.mark.asyncio
    async def test_p68_existing_session_pairing_code_still_works(self, auth_headers):
        """Regression guard: the numeric-id route must keep working unchanged."""
        gw_id = f"gw-p68c-{uuid.uuid4()}"
        async with AsyncSessionLocal() as db:
            row = WhatsAppSession(
                user_id=TEST_UID_HEX,
                gateway_id=gw_id,
                session_name="Existing Line",
                status=SessionStatus.SCAN_QR,
                is_active=True,
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            session_id = row.id

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch(
                "backend.app.services.whatsapp_gateway.request_pairing_code",
                new_callable=AsyncMock,
                return_value={"success": True, "pairing_code": "11112222", "phone": "+905413749073"},
            ) as mock_pair:
                res = await client.post(
                    f"/api/v1/whatsapp/sessions/{session_id}/pair",
                    json={"phone": "905413749073"},
                    headers=auth_headers,
                )
            assert res.status_code == 200, res.text
            assert res.json()["pairing_code"] == "11112222"
            mock_pair.assert_awaited_once()
            assert mock_pair.await_args.args[0] == gw_id

    @pytest.mark.asyncio
    async def test_p68_pair_token_is_owner_scoped(self, auth_headers, other_headers):
        """Tenant safety: B must not obtain a code for A's pairing."""
        gw_id = f"gw-p68d-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            pair_token = start["pair_token"]

            with patch(
                "backend.app.services.whatsapp_gateway.request_pairing_code",
                new_callable=AsyncMock,
                return_value={"success": True, "pairing_code": "12345678", "phone": "+905413749073"},
            ) as mock_pair:
                res = await client.post(
                    f"/api/v1/whatsapp/pairing/{pair_token}/pair",
                    json={"phone": "905413749073"},
                    headers=other_headers,
                )
            assert res.status_code == 404, f"another tenant must not reach this pairing: {res.status_code}"
            mock_pair.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_p68_concurrent_code_requests_are_safe(self, auth_headers):
        """§12: concurrent callers must be answered correctly, never mixed up.

        Provider-side dedupe (one in-flight code request per session) lives in
        the GATEWAY, because that is where `sock.requestPairingCode` is called —
        proved against the real session manager in
        `whatsapp-gateway/scripts/test-pairing-lifecycle.mjs`. What THIS layer
        must guarantee is weaker but still load-bearing: under concurrency,
        every caller is answered, and every call is addressed to the caller's
        OWN ephemeral gateway session. A shared mutable pairing registry must
        not hand one tenant's gateway id to another request.
        """
        gw_id = f"gw-p68f-{uuid.uuid4()}"
        gate = asyncio.Event()

        async def slow_pair(session_ref, phone):
            # Held open so all three requests are genuinely in flight together.
            await gate.wait()
            return {"success": True, "pairing_code": "55556666", "phone": phone}

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            pair_token = start["pair_token"]

            with patch(
                "backend.app.services.whatsapp_gateway.request_pairing_code",
                new_callable=AsyncMock,
                side_effect=slow_pair,
            ) as mock_pair:
                tasks = [
                    asyncio.create_task(
                        client.post(
                            f"/api/v1/whatsapp/pairing/{pair_token}/pair",
                            json={"phone": "905413749073"},
                            headers=auth_headers,
                        )
                    )
                    for _ in range(3)
                ]
                # Let all three reach the provider before releasing it.
                await asyncio.sleep(0.05)
                gate.set()
                responses = await asyncio.gather(*tasks)

            assert all(r.status_code == 200 for r in responses), [r.status_code for r in responses]
            assert all(r.json()["pairing_code"] == "55556666" for r in responses), [r.text for r in responses]
            assert mock_pair.await_count == 3, f"no request may be lost, got {mock_pair.await_count}"
            for call in mock_pair.await_args_list:
                assert call.args[0] == gw_id, (
                    f"every concurrent call must address this pairing's own gateway session "
                    f"{gw_id}, got {call.args[0]}"
                )

    @pytest.mark.asyncio
    async def test_p68_promotion_happens_exactly_once(self, auth_headers):
        """pair_token -> connection.open -> ONE persistent row, no duplicate."""
        gw_id = f"gw-p68e-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            pair_token = start["pair_token"]

            connected = _mock_gw_session(gw_id, status="CONNECTED")
            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=connected,
            ):
                res = await client.get(f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=auth_headers)
                assert res.status_code == 200
                body = res.json()
                assert body["status"] == "CONNECTED"
                assert body["session_id"] is not None

                # Polling again must not promote a second time: the pairing is
                # already consumed, so the token no longer resolves.
                res2 = await client.get(f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=auth_headers)
                assert res2.status_code == 404

            async with AsyncSessionLocal() as db:
                count = await db.scalar(
                    select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_UID_HEX)
                )
                assert count == 1, f"exactly one persistent session expected, found {count}"

    @pytest.mark.asyncio
    async def test_p68_qr_poll_survives_concurrent_promotion(self, auth_headers):
        """REGRESSION — live 2026-09-26 11:43:56 UTC: the QR poll 502'd.

        `GET /pairing/{token}/qr` returned 502 with
        `UniqueViolationError: duplicate key value violates unique constraint
        "ix_whatsapp_sessions_gateway_id"` (Key (gateway_id)=(f157eca0-…) already
        exists) while `promote_ephemeral_pairing` committed session 87 for that
        very same gateway id 7 ms later.

        Two writers create the durable row for a freshly-connected gateway
        session: the event-driven promotion (triggered by the same
        `connection.open`) and this endpoint, which used to hand-roll the same
        relink / reuse / INSERT sequence. Both read "no row yet" and then wrote,
        so one lost on the unique index. The event path was race-tolerant; the
        endpoint's INSERT was not, and the loser's 502 reached the browser.

        Losing the race is NOT an error: the winner committed the row this
        gateway session is supposed to have. Simulate the winner by committing
        the row for this exact gateway id first, then poll — the endpoint must
        return 200 with THAT row and mint no duplicate.
        """
        gw_id = f"gw-p68race-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            pair_token = start["pair_token"]

            # The concurrent writer (event-driven promotion) already committed.
            async with AsyncSessionLocal() as db:
                winner = WhatsAppSession(
                    user_id=TEST_UID_HEX,
                    gateway_id=gw_id,
                    session_name="Hat 1",
                    status=SessionStatus.CONNECTED,
                    phone_number="+905413749073",
                    is_active=True,
                    is_phone_online=True,
                )
                db.add(winner)
                await db.commit()
                winner_id = winner.id

            connected = _mock_gw_session(gw_id, status="CONNECTED")
            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=connected,
            ):
                res = await client.get(
                    f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=auth_headers
                )

            assert res.status_code == 200, (
                "QR poll must adopt the concurrently-committed row for its own "
                f"gateway id, got {res.status_code}: {res.text}"
            )
            body = res.json()
            assert body["status"] == "CONNECTED"
            assert body["session_id"] == winner_id, (
                "the poll must report the row the winner committed, not a new one"
            )

            async with AsyncSessionLocal() as db:
                count = await db.scalar(
                    select(func.count(WhatsAppSession.id)).where(
                        WhatsAppSession.user_id == TEST_UID_HEX
                    )
                )
                assert count == 1, f"no duplicate row may be minted, found {count}"

    @pytest.mark.asyncio
    async def test_p68_qr_poll_refusal_is_409_not_502(self, auth_headers):
        """A promotion REFUSAL must not be reported as a gateway outage.

        `promote_ephemeral_pairing` returns None when it cannot prove the owner,
        when the phone belongs to another tenant, or when a live session is bound
        to a different gateway. None of those is a gateway failure, so the poll
        must answer 409 — a 502 ("WhatsApp gateway'e ulaşılamadı") would send the
        user to check a service that is perfectly healthy (AGENTS.md §1.1).
        """
        gw_id = f"gw-p68refuse-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            pair_token = start["pair_token"]

            connected = _mock_gw_session(gw_id, status="CONNECTED")
            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=connected,
            ), patch(
                "backend.app.services.whatsapp.orchestration.promotion.promote_ephemeral_pairing",
                new_callable=AsyncMock,
                return_value=None,
            ):
                res = await client.get(
                    f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=auth_headers
                )

            assert res.status_code == 409, (
                "a policy refusal is a conflict, not a gateway outage; got "
                f"{res.status_code}: {res.text}"
            )
            assert "gateway" not in res.json()["detail"].lower(), (
                "the detail must not blame the gateway for a policy refusal"
            )


# ---------------------------------------------------------------------------
# P6-9 — QR delivery for an ephemeral (new) pairing
#
# §5/§6: prove or DISPROVE that the backend drops `session_qr_updated` for a
# pairing that has no `whatsapp_sessions` row yet. This test observes the real
# ingest path end to end and distinguishes the four candidate cases.
# ---------------------------------------------------------------------------
from backend.app.services.whatsapp_service import ingest_gateway_event  # noqa: E402


class TestP69EphemeralQrDelivery:

    @pytest.mark.asyncio
    async def test_p69_qr_event_for_ephemeral_pairing_is_resolved(self, auth_headers):
        """A QR event for a brand-new pairing must reach the UI.

        The gateway emits `session_qr_updated` (proved separately with the real
        session manager). The backend must be able to attribute it to the owner
        who started the pairing — WITHOUT a `whatsapp_sessions` row, which by
        design does not exist until the QR is scanned.

        If this raises EventOwnerUnresolved, the event is dropped and never
        broadcast (main.py counts it as `failed`) — that is case A: gateway
        emitted, backend rejected.
        """
        gw_id = f"gw-p69-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)
            assert start["gateway_id"] == gw_id

            event = {
                "event": "session_qr_updated",
                # event_id MUST be a real UUID: the ingest path parses it and
                # drops the event outright otherwise.
                "event_id": str(uuid.uuid4()),
                "session_id": gw_id,
                "session_name": start["session_name"],
                "qr_code": "data:image/png;base64,REAL_QR_FROM_GATEWAY",
            }

            outcome = "raised"
            try:
                result = await ingest_gateway_event(dict(event))
                outcome = "ingested"
            except Exception as exc:  # noqa: BLE001 - the point is that it must not blow up
                pytest.fail(
                    f"P6-9 CASE A CONFIRMED: the backend REJECTED the QR event for an "
                    f"ephemeral pairing ({type(exc).__name__}: {exc}). The event is never "
                    f"broadcast, so a new pairing can only receive its QR by polling."
                )

            assert outcome == "ingested"
            assert result is not None, "QR event must not be skipped"
            assert result.get("event") == "session_qr_updated"
            # Owner must be the caller, not a global broadcast.
            assert str(result.get("user_id")) in (TEST_UID, TEST_UID_HEX), result

    @pytest.mark.asyncio
    async def test_p69_qr_event_for_ephemeral_pairing_is_owner_scoped(self, auth_headers, other_headers):
        """§8 TENANT SAFETY: B must never receive A's QR event.

        The fix routes the event through the ephemeral registry's recorded
        owner. It must NOT degrade into a global broadcast — otherwise every
        tenant would see every new pairing's QR.
        """
        gw_id = f"gw-p69b-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start_pairing(client, auth_headers, gw_id)

            event = {
                "event": "session_qr_updated",
                "event_id": str(uuid.uuid4()),
                "session_id": gw_id,
                "session_name": start["session_name"],
                "qr_code": "data:image/png;base64,TENANT_A_QR",
            }
            result = await ingest_gateway_event(dict(event))
            assert result is not None
            owner = str(result.get("user_id"))
            assert owner in (TEST_UID, TEST_UID_HEX), result
            assert owner not in (OTHER_UID,), "A's QR must not be attributed to B"

            # And B's own pairing resolves to B, independently.
            gw_b = f"gw-p69c-{uuid.uuid4()}"
            start_b = await _start_pairing(client, other_headers, gw_b)
            event_b = {
                "event": "session_qr_updated",
                "event_id": str(uuid.uuid4()),
                "session_id": gw_b,
                "session_name": start_b["session_name"],
                "qr_code": "data:image/png;base64,TENANT_B_QR",
            }
            result_b = await ingest_gateway_event(dict(event_b))
            assert result_b is not None
            assert str(result_b.get("user_id")) == OTHER_UID, result_b
            assert result_b.get("qr_code") == "data:image/png;base64,TENANT_B_QR"
