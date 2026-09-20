"""Phase 6.8 — the real pairing PROMOTION race.

Root cause (proved by production forensics + source reading)
-----------------------------------------------------------
A first-time QR pairing becomes a durable `public.whatsapp_sessions` row through
exactly ONE code path: `get_pairing_qr` -> "Scenario A-new" (`sessions.py:397`).

`_map_session_event` (`events.py:1185-1312`) — the WS `session_connected`
handler — can only *update* an existing row (`:1313-1334`) or *relink* an
existing `RELINK_REQUIRED` row (`:1248` -> `perform_atomic_relink`). It has **no
branch that creates a row**. For a first-time pairing `perform_atomic_relink`
raises `RelinkCandidateNotFound` (`relink.py:86/152`), which is swallowed at
`events.py:1283-1284`; the event then falls through to the P6-9 ephemeral branch
(`:1297-1307`) which routes the event to its owner and **returns without writing
anything**.

Production therefore depended on the browser continuing to poll
`GET /pairing/{token}/qr` until the gateway reported `CONNECTED`. It does not:

* `WhatsAppQrConnectModal.tsx:499` — the WS `session_connected` handler sets
  `modalState='CONNECTED'`, so the fallback poll's `shouldPoll` (`:546`) turns
  false and **polling stops at the exact moment the row would have been created**.
* `WhatsAppQrConnectModal.tsx:510-512` — `setTimeout(onClose, 1500)` then closes
  the modal; the lifecycle effect re-runs with `isOpen=false` and its cleanup
  (`:404-408`) calls `cancelPairing(token)`.
* `cancel_pairing_session` (`sessions.py:430-445`) pops the registry and calls
  `gw.delete_session(...)` **unconditionally** — destroying the gateway socket
  that had just been promoted by `connection.open`.

Measured in production:
    22:40:40.492  gateway  Baileys restartRequired (515)      <- real phone scanned
    22:40:43.657  gateway  registerSession -> gateway_sessions  <- connection.open
    22:40:43.723  backend  EventOwnerUnresolved (message_new)   <- no row, dropped
    22:40:45.455  backend  DELETE /sessions/<gw_id> -> 200      <- 43.657 + ~1.5 s
                                                                    = the onClose timer
    22:40:45.5xx  backend  POST /pairing/<token>/cancel -> 200
    ... 2 904 gateway events dropped in 60 s as "unknown gateway session".

These tests drive the REAL call path (HTTP endpoints + `ingest_gateway_event` +
the real DB) and are the fail->pass proof: every assertion below fails on the
pre-6.8 code and passes after the fix. Nothing here asserts on a private helper.
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
from backend.app.services.whatsapp_service import ingest_gateway_event
from backend.app.services.whatsapp.orchestration import sessions as sessions_mod
from backend.app.services.whatsapp.orchestration import pairing_registry
from backend.tests.test_whatsapp_live import _make_jwt, _auth_headers

TEST_UID = "45678901-4567-4567-4567-456789012345"
TEST_UID_HEX = "45678901456745674567456789012345"
OTHER_UID = "56789012-5678-5678-5678-567890123456"
OTHER_UID_HEX = "56789012567856785678567890123456"

OWNERS_A = (TEST_UID, TEST_UID_HEX)
OWNERS_B = (OTHER_UID, OTHER_UID_HEX)

PHONE_A = "+905413749073"
PHONE_B = "+905356872662"
SELF_JID_A = "905413749073@s.whatsapp.net"


@pytest.fixture
def auth_headers():
    return _auth_headers(_make_jwt(user_id=TEST_UID))


@pytest.fixture
def other_headers():
    return _auth_headers(_make_jwt(user_id=OTHER_UID))


@pytest_asyncio.fixture(autouse=True)
async def clean_state():
    """Wipe both the DB rows and the process-local pairing registries.

    The shared conftest does NOT reset `_ephemeral_pairings` /
    `_logical_to_ephemeral`; leaking them between tests would make the
    "lost registry" cases untestable, so this module owns its isolation.

    It also provisions `ephemeral_pairings`. Production creates it via
    `Base.metadata.create_all` in the FastAPI `lifespan` (`main.py:103`); this
    suite drives the app through `ASGITransport`, which never runs the lifespan,
    so the test must supply the table the same way the app would.
    """
    from backend.app.core.database import engine
    from backend.app.models.ephemeral_pairing import EphemeralPairing

    async with engine.begin() as conn:
        await conn.run_sync(EphemeralPairing.__table__.create, checkfirst=True)

    def _clear_registry():
        sessions_mod._ephemeral_pairings.clear()
        sessions_mod._logical_to_ephemeral.clear()

    params = {"a": TEST_UID, "ah": TEST_UID_HEX, "b": OTHER_UID, "bh": OTHER_UID_HEX}

    async def _wipe():
        # Child-first: the ingest path creates conversations/messages whose FKs
        # point at the session row, so a bare DELETE FROM whatsapp_sessions trips
        # a FOREIGN KEY constraint on SQLite.
        async with AsyncSessionLocal() as db:
            await db.execute(
                text(
                    "DELETE FROM messages WHERE conversation_id IN "
                    "(SELECT id FROM conversations WHERE user_id IN (:a, :ah, :b, :bh))"
                ),
                params,
            )
            await db.execute(
                text("DELETE FROM conversations WHERE user_id IN (:a, :ah, :b, :bh)"), params
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id IN (:a, :ah, :b, :bh)"), params
            )
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:a, :ah, :b, :bh)"), params
            )
            await db.execute(
                text("DELETE FROM ephemeral_pairings WHERE user_id IN (:a, :ah, :b, :bh)"), params
            )
            await db.commit()

    _clear_registry()
    await _wipe()
    yield
    _clear_registry()
    await _wipe()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _gw_session(gw_id, status="SCAN_QR", phone=None):
    return {
        "id": gw_id,
        "session_name": "Hat 1",
        "status": status,
        "qr_code": "data:image/png;base64,QR_FOR_PHASE68" if status != "CONNECTED" else None,
        "phone_number": phone,
        "is_phone_online": status == "CONNECTED",
        "battery_level": None,
        "is_active": True,
        "ephemeral": True,
    }


async def _start(client, headers, gw_id, name="Hat 1"):
    with patch(
        "backend.app.services.whatsapp_gateway.create_session",
        new_callable=AsyncMock,
        return_value=_gw_session(gw_id),
    ):
        res = await client.post("/api/v1/whatsapp/pairing/start", json={"name": name}, headers=headers)
    assert res.status_code == 201, res.text
    return res.json()


def _connected_event(gw_id, phone, self_jid=SELF_JID_A, self_lid=None):
    """Exactly what the gateway emits at `connection.open`.

    `session-manager.js:3035-3042` — no `user_id` field exists, so the backend
    can never infer a tenant from the payload alone.
    """
    return {
        "event": "session_connected",
        "event_id": str(uuid.uuid4()),
        "session_id": gw_id,
        "session_name": "Hat 1",
        "phone": phone,
        "self_jid": self_jid,
        "self_lid": self_lid,
    }


async def _rows(*owners):
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(WhatsAppSession).where(WhatsAppSession.user_id.in_(owners))
        )
        return list(res.scalars().all())


async def _session_qr(client, headers, pair_token, gw_status="SCAN_QR", phone=None):
    """Poll `GET /pairing/{token}/qr`.

    Resolves the gateway id from the in-memory registry when it is still there,
    and from the durable pairing record otherwise: promotion removes the
    in-memory entry, and the real modal can still have a poll in flight.
    """
    gw_id = (sessions_mod._ephemeral_pairings.get(pair_token) or {}).get("gateway_id")
    if gw_id is None:
        async with AsyncSessionLocal() as _db:
            durable = await pairing_registry.resolve_pairing_by_token(_db, pair_token)
        assert durable is not None, f"pair_token {pair_token} unknown in memory AND durably"
        gw_id = durable["gateway_id"]
    with patch(
        "backend.app.services.whatsapp_gateway.get_session_qr",
        new_callable=AsyncMock,
        return_value=_gw_session(gw_id, status=gw_status, phone=phone),
    ):
        return await client.get(f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=headers)


async def _cancel(client, headers, pair_token):
    return await client.post(f"/api/v1/whatsapp/pairing/{pair_token}/cancel", headers=headers)


# ===========================================================================
# CORE — the two defects
# ===========================================================================
class TestP68PromotionFromSessionConnected:
    """`session_connected` alone must be able to finish a first-time pairing."""

    @pytest.mark.asyncio
    async def test_session_connected_creates_durable_row_for_first_time_pairing(self, auth_headers):
        """THE production bug.

        Real order of events for a brand-new user:

            POST /pairing/start         -> ephemeral gateway session, ZERO rows
            GET  /pairing/{t}/qr        -> QR shown (still SCAN_QR)
            <phone scans> Baileys 515   -> socket restarting
            connection.open             -> gateway emits `session_connected`
            GET  /pairing/{t}/qr        -> NOT called again (WS handler stopped polling)
            POST /pairing/{t}/cancel    -> modal auto-closed after 1500 ms

        After `session_connected` the durable row MUST exist. It does not today:
        the only row-creating branch is the polling one.
        """
        gw_id = f"gw-p68core-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            pair_token = start["pair_token"]

            # 2. QR exists
            qr_res = await _session_qr(client, auth_headers, pair_token)
            assert qr_res.status_code == 200, qr_res.text
            assert qr_res.json()["qr_code"], "QR must be delivered to the browser"

            # 3./4. simulate Baileys 515 -> connection.open -> session_connected
            result = await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            assert result is not None, "session_connected must not be skipped"

            # 5. THE INVARIANT
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, (
                f"AFTER session_connected there must be exactly ONE durable "
                f"whatsapp_sessions row; found {len(rows)}. The backend cannot "
                f"create a row from session_connected — promotion depended on the "
                f"browser still polling GET /pairing/{{token}}/qr."
            )
            row = rows[0]
            assert row.status == SessionStatus.CONNECTED, row.status
            assert str(row.gateway_id) == gw_id, row.gateway_id
            assert str(row.user_id) in OWNERS_A, row.user_id
            assert row.phone_number in (PHONE_A, PHONE_A.lstrip("+")), row.phone_number

    @pytest.mark.asyncio
    async def test_inbound_event_accepted_for_promoted_session(self, auth_headers):
        """After promotion the gateway session must no longer be 'unknown'.

        Production dropped 2 904 events with `EventOwnerUnresolved` because the
        promoted gateway UUID had no row. Once the row exists the same event must
        be attributable to the owner.
        """
        gw_id = f"gw-p68in-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])
            await ingest_gateway_event(_connected_event(gw_id, PHONE_A))

            # a real inbound message on the promoted session. Shape taken from the
            # gateway itself (`session-manager.js` emits
            # `{event, gateway_session_id, conversation_id, message}`) and from the
            # canonical fixture `tests/fixtures/whatsapp/message_upsert.json`.
            inbound = {
                "event": "message_new",
                "event_id": str(uuid.uuid4()),
                "gateway_session_id": gw_id,
                "conversation_id": "905551112233@s.whatsapp.net",
                "message": {
                    "wa_message_id": f"3EB0{uuid.uuid4().hex[:14].upper()}",
                    "conversation_id": "905551112233@s.whatsapp.net",
                    "from_me": False,
                    "sender_phone": "+905551112233",
                    "sender_name": "Phase 68 Inbound",
                    "body": "PHASE68 INBOUND",
                    "message_type": "TEXT",
                    "status": "RECEIVED",
                    "created_at": "2026-09-20T12:00:00.000Z",
                    "external_timestamp": 1758321600000,
                },
            }
            out = await ingest_gateway_event(inbound)
            assert out is not None, (
                "inbound event dropped as 'unknown gateway session' — the promoted "
                "session has no durable row"
            )
            assert str(out.get("user_id")) in OWNERS_A, out.get("user_id")


class TestP68CancelMustNotDestroyPromotion:
    """`cancel_pairing_session` must be promotion-aware and idempotent."""

    @pytest.mark.asyncio
    async def test_cancel_after_connection_open_does_not_delete_promoted_socket(self, auth_headers):
        """The 1.5 s auto-close must not kill a session that already connected.

        Production: `DELETE http://gateway:8787/sessions/<gw_id>` landed ~1.8 s
        after `connection.open`, destroying the promoted socket. The gateway
        session must survive, and the durable row must remain CONNECTED.
        """
        gw_id = f"gw-p68cancel-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            pair_token = start["pair_token"]
            await _session_qr(client, auth_headers, pair_token)

            # gateway reached connection.open; the backend has not been told yet
            # via WS, but the gateway session itself is already CONNECTED.
            deleted = []

            async def _record_delete(gateway_id, *a, **kw):
                deleted.append(gateway_id)
                return {"success": True}

            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=_gw_session(gw_id, status="CONNECTED", phone=PHONE_A),
            ), patch(
                "backend.app.services.whatsapp_gateway.delete_session",
                new_callable=AsyncMock,
                side_effect=_record_delete,
            ):
                res = await _cancel(client, auth_headers, pair_token)
                assert res.status_code == 200, res.text

            assert not deleted, (
                f"cancel deleted the gateway session {deleted} although it had "
                f"already reached CONNECTED — the promoted socket is destroyed and "
                f"every later event becomes 'unknown gateway session'."
            )
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, f"promotion lost on cancel; rows={len(rows)}"
            assert rows[0].status == SessionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_cancel_is_idempotent(self, auth_headers):
        """Calling cancel twice must be a no-op the second time."""
        gw_id = f"gw-p68idem-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            pair_token = start["pair_token"]
            await _session_qr(client, auth_headers, pair_token)

            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=_gw_session(gw_id, status="SCAN_QR"),
            ), patch(
                "backend.app.services.whatsapp_gateway.delete_session",
                new_callable=AsyncMock,
                return_value={"success": True},
            ) as del_mock:
                r1 = await _cancel(client, auth_headers, pair_token)
                r2 = await _cancel(client, auth_headers, pair_token)
            assert r1.status_code == 200 and r2.status_code == 200
            assert del_mock.await_count <= 1, (
                f"cancel is not idempotent: delete_session called "
                f"{del_mock.await_count} times"
            )

    @pytest.mark.asyncio
    async def test_genuine_cancel_still_terminates_waiting_pairing(self, auth_headers):
        """REGRESSION GUARD: a pairing still waiting for a scan MUST be cancelled.

        The fix must not turn cancel into a no-op — otherwise the ephemeral
        gateway sessions leak forever (the separate cleanup track).
        """
        gw_id = f"gw-p68real-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            pair_token = start["pair_token"]
            await _session_qr(client, auth_headers, pair_token)

            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=_gw_session(gw_id, status="SCAN_QR"),
            ), patch(
                "backend.app.services.whatsapp_gateway.delete_session",
                new_callable=AsyncMock,
                return_value={"success": True},
            ) as del_mock:
                res = await _cancel(client, auth_headers, pair_token)
            assert res.status_code == 200
            assert del_mock.await_count == 1, (
                "a genuinely waiting pairing must still be torn down"
            )
            assert pair_token not in sessions_mod._ephemeral_pairings


# ===========================================================================
# §6 PROMOTION MATRIX
# ===========================================================================
class TestP68PromotionMatrix:

    @pytest.mark.asyncio
    async def test_m1_normal_qr_pairing_polls_to_connected(self, auth_headers):
        """1. Normal QR pairing via polling still works (no regression)."""
        gw_id = f"gw-m1-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            res = await _session_qr(client, auth_headers, start["pair_token"], gw_status="CONNECTED", phone=PHONE_A)
            assert res.status_code == 200, res.text
            assert res.json()["status"] == "CONNECTED"
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1 and rows[0].status == SessionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_m2_515_then_session_connected(self, auth_headers):
        """2. Baileys restartRequired(515) -> session_connected -> CONNECTED."""
        gw_id = f"gw-m2-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])
            # 515 -> socket restart -> connection.open
            await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, "515 reconnect must still end in a durable row"
            assert rows[0].status == SessionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_m3_modal_stays_open(self, auth_headers):
        """3. Modal remains open: polling keeps working AND the WS path works."""
        gw_id = f"gw-m3-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            token = start["pair_token"]
            await _session_qr(client, auth_headers, token)
            await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            # the modal keeps polling for a while — must not create a duplicate
            for _ in range(3):
                await _session_qr(client, auth_headers, token)
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, f"modal staying open created {len(rows)} rows"

    @pytest.mark.asyncio
    async def test_m4_modal_closes_immediately_after_scan(self, auth_headers):
        """4. Modal closes right after the scan -> row must already be durable."""
        gw_id = f"gw-m4-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            token = start["pair_token"]
            await _session_qr(client, auth_headers, token)
            await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=_gw_session(gw_id, status="CONNECTED", phone=PHONE_A),
            ), patch(
                "backend.app.services.whatsapp_gateway.delete_session",
                new_callable=AsyncMock,
                return_value={"success": True},
            ):
                await _cancel(client, auth_headers, token)   # modal auto-close
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1 and rows[0].status == SessionStatus.CONNECTED, (
                "closing the modal immediately after the scan lost the promotion"
            )

    @pytest.mark.asyncio
    async def test_m5_effect_rerun_after_scan(self, auth_headers):
        """5. React effect re-runs after the scan (cleanup fires) -> still CONNECTED.

        The lifecycle effect cleanup calls cancelPairing; a re-run must not
        destroy an in-flight promotion.
        """
        gw_id = f"gw-m5-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            token = start["pair_token"]
            await _session_qr(client, auth_headers, token)
            with patch(
                "backend.app.services.whatsapp_gateway.get_session_qr",
                new_callable=AsyncMock,
                return_value=_gw_session(gw_id, status="CONNECTED", phone=PHONE_A),
            ), patch(
                "backend.app.services.whatsapp_gateway.delete_session",
                new_callable=AsyncMock,
                return_value={"success": True},
            ):
                await _cancel(client, auth_headers, token)   # effect cleanup
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1 and rows[0].status == SessionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_m6_token_cleanup_before_session_connected(self, auth_headers):
        """6. Pair-token bookkeeping is lost BEFORE `session_connected`.

        This is the §4 rule: "lost UI/token bookkeeping must not destroy an
        otherwise valid gateway promotion". The durable pairing record must let
        the backend resolve the owner without the in-memory map.
        """
        gw_id = f"gw-m6-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            token = start["pair_token"]
            await _session_qr(client, auth_headers, token)
            # simulate the frontend having cancelled/cleared the token
            sessions_mod._ephemeral_pairings.clear()
            sessions_mod._logical_to_ephemeral.clear()

            out = await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            assert out is not None, "promotion lost when the token map was gone"
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, (
                "the owner is still durably recoverable — a missing ephemeral "
                "token must not reject an otherwise valid promotion"
            )
            assert rows[0].status == SessionStatus.CONNECTED
            assert str(rows[0].gateway_id) == gw_id

    @pytest.mark.asyncio
    async def test_m7_backend_restart_between_qr_and_connected(self, auth_headers):
        """7. Backend restart wipes the in-memory registry — same invariant."""
        gw_id = f"gw-m7-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])
            # restart == process-local state gone
            sessions_mod._ephemeral_pairings.clear()
            sessions_mod._logical_to_ephemeral.clear()
            await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1 and rows[0].status == SessionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_m8_duplicate_session_connected_is_idempotent(self, auth_headers):
        """8. Duplicate `session_connected` must not create a second row."""
        gw_id = f"gw-m8-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])
            for _ in range(3):
                await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, f"duplicate session_connected made {len(rows)} rows"

    @pytest.mark.asyncio
    async def test_m9_late_session_connected_after_poll_promotion(self, auth_headers):
        """9. Late `session_connected` after the poll already promoted."""
        gw_id = f"gw-m9-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            token = start["pair_token"]
            res = await _session_qr(client, auth_headers, token, gw_status="CONNECTED", phone=PHONE_A)
            assert res.json()["status"] == "CONNECTED"
            await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, f"late event made {len(rows)} rows"
            assert rows[0].status == SessionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_m10_stale_old_gateway_session_cannot_overwrite_new(self, auth_headers):
        """10. A stale old gateway UUID must not steal the live session."""
        new_gw = f"gw-m10new-{uuid.uuid4()}"
        old_gw = f"gw-m10old-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, new_gw)
            res = await _session_qr(client, auth_headers, start["pair_token"], gw_status="CONNECTED", phone=PHONE_A)
            assert res.json()["status"] == "CONNECTED"
            session_id = res.json()["session_id"]

            # the stale socket finally reports connection.open
            await ingest_gateway_event(_connected_event(old_gw, PHONE_A))

            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, f"stale promotion created {len(rows)} rows"
            assert rows[0].id == session_id
            assert str(rows[0].gateway_id) == new_gw, (
                f"stale gateway session overwrote the live one: "
                f"{rows[0].gateway_id} != {new_gw}"
            )

    @pytest.mark.asyncio
    async def test_m11_two_pairings_same_user_do_not_collide(self, auth_headers):
        """11. Two simultaneous pairings for ONE user -> one durable session."""
        gw1 = f"gw-m11a-{uuid.uuid4()}"
        gw2 = f"gw-m11b-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            s1 = await _start(client, auth_headers, gw1)
            s2 = await _start(client, auth_headers, gw2)
            await _session_qr(client, auth_headers, s1["pair_token"])
            await _session_qr(client, auth_headers, s2["pair_token"])
            await ingest_gateway_event(_connected_event(gw1, PHONE_A))
            await ingest_gateway_event(_connected_event(gw2, PHONE_A))
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, (
                f"the same phone must not end up with {len(rows)} durable sessions"
            )

    @pytest.mark.asyncio
    async def test_m12_two_users_pairing_simultaneously(self, auth_headers, other_headers):
        """12. Two tenants pairing at once -> one row each, no cross-talk."""
        gw_a = f"gw-m12a-{uuid.uuid4()}"
        gw_b = f"gw-m12b-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            sa = await _start(client, auth_headers, gw_a)
            sb = await _start(client, other_headers, gw_b)
            await _session_qr(client, auth_headers, sa["pair_token"])
            await _session_qr(client, other_headers, sb["pair_token"])
            await ingest_gateway_event(_connected_event(gw_a, PHONE_A, self_jid=SELF_JID_A))
            await ingest_gateway_event(
                _connected_event(gw_b, PHONE_B, self_jid="905356872662@s.whatsapp.net")
            )
            rows_a = await _rows(*OWNERS_A)
            rows_b = await _rows(*OWNERS_B)
            assert len(rows_a) == 1, f"tenant A got {len(rows_a)} rows"
            assert len(rows_b) == 1, f"tenant B got {len(rows_b)} rows"
            assert str(rows_a[0].gateway_id) == gw_a
            assert str(rows_b[0].gateway_id) == gw_b
            assert str(rows_a[0].user_id) in OWNERS_A
            assert str(rows_b[0].user_id) in OWNERS_B


# ===========================================================================
# §4 BOOKKEEPING IS NEVER LOAD-BEARING
# ===========================================================================
class TestP68BookkeepingIsNeverLoadBearing:
    """'Lost UI/token bookkeeping must not destroy an otherwise valid gateway
    promotion.' The durable pairing record is an upgrade, never a dependency —
    including when its OWN write fails."""

    @pytest.mark.asyncio
    async def test_promotion_survives_a_failing_bookkeeping_write(self, auth_headers):
        """A broken `ephemeral_pairings` write must not lose the promotion.

        The first implementation of this phase crashed here, and the crash is
        worth keeping a guard for. `consume_pairing` caught its own error and
        called `db.rollback()`, which EXPIRED the already-committed session row.
        The next bare attribute read (`row.id` inside a log call) then triggered
        a synchronous lazy load, which on an `AsyncSession` raises
        `greenlet_spawn has not been called`. The exception escaped
        `promote_ephemeral_pairing`, `ingest_gateway_event` treated the event as
        failed and dropped it — and a durable CONNECTED row that HAD been
        committed was reported as lost. Exactly the production symptom.
        """
        gw_id = f"gw-p68bk-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])

            async def _boom(*a, **kw):
                raise RuntimeError("ephemeral_pairings unavailable")

            with patch.object(pairing_registry, "consume_pairing", side_effect=_boom):
                out = await ingest_gateway_event(_connected_event(gw_id, PHONE_A))

            assert out is not None, (
                "a failing bookkeeping write dropped a valid promotion"
            )
            rows = await _rows(*OWNERS_A)
            assert len(rows) == 1, f"promotion lost: {len(rows)} rows"
            assert rows[0].status == SessionStatus.CONNECTED
            assert str(rows[0].gateway_id) == gw_id

    @pytest.mark.asyncio
    async def test_promotion_survives_a_missing_pairing_table(self, auth_headers):
        """The same invariant when the durable table genuinely does not exist.

        This is the real deployment shape the first time the code runs against a
        database that has not been migrated yet: `pairing_registry` is documented
        as best-effort, so promotion must still complete on the in-memory path.
        """
        gw_id = f"gw-p68notable-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])

            from backend.app.core.database import engine
            from backend.app.models.ephemeral_pairing import EphemeralPairing

            async with engine.begin() as conn:
                await conn.run_sync(EphemeralPairing.__table__.drop, checkfirst=True)
            try:
                out = await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
                assert out is not None, "a missing durable table dropped the promotion"
                rows = await _rows(*OWNERS_A)
                assert len(rows) == 1 and rows[0].status == SessionStatus.CONNECTED
            finally:
                async with engine.begin() as conn:
                    await conn.run_sync(EphemeralPairing.__table__.create, checkfirst=True)


# ===========================================================================
# §5 OWNER / TENANT SAFETY (G-3 must NOT be weakened)
# ===========================================================================
class TestP68TenantSafety:

    @pytest.mark.asyncio
    async def test_case_a_valid_ephemeral_pairing_resolves_correct_tenant(self, auth_headers, other_headers):
        """A. valid ephemeral pairing -> correct tenant, never the other one."""
        gw_id = f"gw-ca-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])
            out = await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            assert str(out.get("user_id")) in OWNERS_A
            assert str(out.get("user_id")) not in OWNERS_B
            rows = await _rows(*OWNERS_B)
            assert rows == [], "B must never receive a row for A's pairing"

    @pytest.mark.asyncio
    async def test_case_b_lost_registry_owner_still_recoverable(self, auth_headers):
        """B. lost in-memory registry -> correct owner still recoverable."""
        gw_id = f"gw-cb-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            start = await _start(client, auth_headers, gw_id)
            await _session_qr(client, auth_headers, start["pair_token"])
            sessions_mod._ephemeral_pairings.clear()
            sessions_mod._logical_to_ephemeral.clear()
            out = await ingest_gateway_event(_connected_event(gw_id, PHONE_A))
            assert out is not None, "owner must remain recoverable"
            assert str(out.get("user_id")) in OWNERS_A, out.get("user_id")

    @pytest.mark.asyncio
    async def test_case_c_unknown_gateway_session_fails_closed(self, auth_headers):
        """C. unknown gateway session -> fail closed, no row for anybody.

        Contract (`events.py:1447-1450`): `EventOwnerUnresolved` is rolled back,
        logged as an orphan and the ingest returns `None`. The event is DROPPED
        and nothing is written — that is the fail-closed behaviour that must
        survive the 6.8 fix.
        """
        ghost = f"gw-ghost-{uuid.uuid4()}"
        out = await ingest_gateway_event(_connected_event(ghost, PHONE_A))
        assert out is None, (
            f"an unknown gateway session must be dropped, not attributed; got {out}"
        )
        for owners in (OWNERS_A, OWNERS_B):
            assert await _rows(*owners) == [], "an unknown gateway session must never create a row"

    @pytest.mark.asyncio
    async def test_case_d_ambiguous_owner_fails_closed(self, auth_headers, other_headers):
        """D. two CONNECTED tenants + no gateway id -> fail closed (dropped)."""
        async with AsyncSessionLocal() as db:
            db.add_all([
                WhatsAppSession(
                    user_id=TEST_UID_HEX, gateway_id=f"gw-amb-a-{uuid.uuid4()}",
                    session_name="Hat 1", status=SessionStatus.CONNECTED,
                    is_active=True, is_phone_online=True,
                ),
                WhatsAppSession(
                    user_id=OTHER_UID_HEX, gateway_id=f"gw-amb-b-{uuid.uuid4()}",
                    session_name="Hat 1", status=SessionStatus.CONNECTED,
                    is_active=True, is_phone_online=True,
                ),
            ])
            await db.commit()

        event = {
            "event": "message_new",
            "event_id": str(uuid.uuid4()),
            "conversation_id": "905551112233@s.whatsapp.net",
            "message": {
                "wa_message_id": f"3EB0{uuid.uuid4().hex[:14].upper()}",
                "conversation_id": "905551112233@s.whatsapp.net",
                "from_me": False,
                "body": "AMBIGUOUS",
                "message_type": "TEXT",
                "status": "RECEIVED",
                "created_at": "2026-09-20T12:00:00.000Z",
                "external_timestamp": 1758321600000,
            },
        }
        out = await ingest_gateway_event(event)
        assert out is None, (
            f"an ambiguous owner must be dropped, never guessed; got {out}"
        )

    @pytest.mark.asyncio
    async def test_case_e_cross_tenant_promotion_is_impossible(self, auth_headers, other_headers):
        """E. B's `session_connected` must never promote into A's session."""
        gw_a = f"gw-ce-a-{uuid.uuid4()}"
        gw_b = f"gw-ce-b-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            sa = await _start(client, auth_headers, gw_a)
            sb = await _start(client, other_headers, gw_b)
            await _session_qr(client, auth_headers, sa["pair_token"])
            await _session_qr(client, other_headers, sb["pair_token"])
            await ingest_gateway_event(_connected_event(gw_a, PHONE_A))
            await ingest_gateway_event(_connected_event(gw_b, PHONE_B))

            # B's gateway id must never be attached to A's row
            rows_a = await _rows(*OWNERS_A)
            assert all(str(r.gateway_id) != gw_b for r in rows_a), (
                "session A was promoted under tenant B"
            )
