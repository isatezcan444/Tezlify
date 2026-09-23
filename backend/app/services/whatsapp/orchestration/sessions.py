"""WhatsApp Session Orchestration Service (Phase 11.9).

Handles WhatsApp tenant session lifecycle:
- Session creation, listing, status synchronization with gateway
- QR code retrieval and refresh
- Pairing code requests
- Logout and session termination
- Durable relink detection and self-healing
- Cascading data purge on session deletion
"""
from datetime import datetime
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
import uuid

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.websocket import ws_manager
from backend.app.core.auth import get_user_filter
from backend.app.services.whatsapp.identity import SYSTEM_USER_ID
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp.exceptions import (
    NoWhatsAppSession,
    WhatsAppRelinkRequired,
)
from backend.app.services.whatsapp.gateway import (
    extract_live_session_fields,
    extract_pairing_code,
    extract_session_id,
    is_gateway_session_missing,
)
from backend.app.services.whatsapp.orchestration import pairing_registry
from backend.app.services.whatsapp.orchestration.relink import (
    RelinkCandidateAmbiguous,
    RelinkCandidateNotFound,
    find_existing_session_for_phone,
    perform_atomic_relink,
)
from backend.app.services.whatsapp.repositories.sessions import (
    get_session_by_id as _get_session_or_404,
)
from backend.app.services.whatsapp.status_policy import (
    parse_session_status as _parse_status,
)

logger = logging.getLogger(__name__)

_GATEWAY_SESSION_MISSING = "session not found"


async def fetch_held_lease_gateway_ids(db: AsyncSession) -> Optional[set]:
    """Return the set of `gateway_id`s whose socket lease is currently held,
    or `None` if the DB read itself failed.

    Contract (Phase 1.1 closure — distinct from the pre-closure behaviour):

      return set()  → query SUCCEEDED, zero valid leases exist.
                       Consumer MUST treat this as truthful "no lease held"
                       and may demote CONNECTED rows that match it.

      return None   → query FAILED (DB unreachable, schema missing,
                       timeout, permission, etc.).
                       Consumer MUST NOT interpret this as "no lease held";
                       it must skip the lease-truthfulness demote for this
                       call and let the next successful read do the work.

    Conflating these two cases is the Phase 1.1 closure bug: a transient
    DB hiccup would mass-demote every healthy CONNECTED row to
    WHATSAPP_LEASE_LOST and broadcast DISCONNECTED to every UI.
    """
    try:
        from sqlalchemy import text
        result = await db.execute(
            text("SELECT session_id FROM whatsapp_private.socket_leases WHERE expires_at > NOW()")
        )
        return {str(row[0]) for row in result.fetchall() if row and row[0] is not None}
    except Exception as exc:  # noqa: BLE001
        # The private schema may not exist in test/legacy environments, or
        # the DB may be temporarily unreachable. The lease-truthfulness
        # check is DEFERRED in this case — NOT silently answered as "no
        # lease held". The list call still returns the session rows so the
        # UI does not lose the rest of the page.
        logger.warning(
            "[WhatsApp] fetch_held_lease_gateway_ids failed; lease "
            "truthfulness demote is deferred until the next successful read: %s",
            exc,
        )
        return None


def _session_dict(row: WhatsAppSession) -> Dict[str, Any]:
    """Serializes WhatsAppSession ORM entity to API dictionary."""
    return {
        "id": row.id,
        "session_name": row.session_name,
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "phone_number": row.phone_number,
        "is_active": row.is_active,
        "is_phone_online": row.is_phone_online,
        "battery_level": row.battery_level,
        "qr_code": row.qr_code,
        "error_message": row.error_message,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _apply_gateway_live(row: WhatsAppSession, data: Dict[str, Any]) -> None:
    """Applies live gateway status fields to session row entity in-memory."""
    fields = extract_live_session_fields(data)
    if fields["status"]:
        row.status = _parse_status(fields["status"])
    if fields["phone"]:
        row.phone_number = fields["phone"]
    if fields["error_message"] is not None:
        row.error_message = fields["error_message"]
    if fields["status"] in ("CONNECTED", "SCAN_QR"):
        row.error_message = None
    row.updated_at = datetime.utcnow()


async def _gateway_op_or_mark_relink(
    db: AsyncSession,
    row: WhatsAppSession,
    op: Callable[[str], Awaitable[Dict[str, Any]]],
) -> Dict[str, Any]:
    """Runs a gateway operation without replacing the logical session line id.
    
    If the gateway returns 'session not found' (404 / missing session memory),
    marks row as RELINK_REQUIRED, commits, broadcasts via WebSocket, and raises
    WhatsAppRelinkRequired so UI guides user to scan QR. All other gateway errors
    propagate fail-closed.
    """
    try:
        return await op(row.gateway_id)
    except gw.WhatsAppGatewayError as exc:
        if not is_gateway_session_missing(exc):
            raise
        row.status = SessionStatus.RELINK_REQUIRED
        row.is_phone_online = False
        row.qr_code = None
        row.error_message = "WHATSAPP_AUTH_RELINK_REQUIRED"
        row.updated_at = datetime.utcnow()
        await db.commit()
        logger.warning(
            "[WhatsApp] Durable session is not available in gateway (db_id=%s, gw_id=%s); relink required",
            row.id,
            row.gateway_id,
        )
        try:
            # `ws_manager.broadcast(message, target_user_id=...)` — parametre
            # adi `tenant_id` DEGIL. Yanlis kwarg TypeError firlatiyor ve
            # asagidaki except tarafindan yutuluyordu; sonuc: relink gerektiren
            # hattin durumu UI'a HIC bildirilmiyordu.
            await ws_manager.broadcast(
                {
                    "event": "session_updated",
                    "user_id": str(row.user_id),
                    "session": {
                        "id": row.id,
                        "session_id": row.id,
                        "status": SessionStatus.RELINK_REQUIRED.value,
                        "phone_number": row.phone_number,
                        "is_active": row.is_active,
                        "is_phone_online": False,
                        "error_message": "WHATSAPP_AUTH_RELINK_REQUIRED",
                    },
                },
                target_user_id=str(row.user_id),
            )
        except Exception as ws_err:
            logger.warning("[WhatsApp] Relink broadcast ws error: %s", ws_err)
        raise WhatsAppRelinkRequired(
            "WhatsApp bağlantısı geri yüklenemedi. Aynı hattı yeniden eşleştirin."
        ) from exc


# Public alias for inter-orchestrator usage
gateway_op_or_mark_relink = _gateway_op_or_mark_relink


async def _list_sessions_internal(

    db: AsyncSession, user_id: str
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Oturum listesi + (varsa) gateway erisim hatasi."""
    stmt = select(WhatsAppSession).where(get_user_filter(WhatsAppSession.user_id, user_id))
    res = await db.execute(stmt)
    rows = res.scalars().all()
    gw_sync: Dict[str, Any] = {}
    gateway_error: Optional[str] = None
    try:
        gw_sessions = {s["id"]: s for s in await gw.list_sessions()}
        # Phase 1.1: source-of-truth for "is this session's socket currently
        # held by SOME gateway instance?" is the DB row in
        # `whatsapp_private.socket_leases`. A row whose `gateway_id` is
        # present in the held-lease set IS actively bound; a row whose
        # `gateway_id` is NOT in the set has lost its right to the socket
        # (TTL expired, lost to a contending instance, or never acquired).
        #
        # We deliberately do NOT call this per-row; the DB read happens once
        # per list call and feeds every row's lease check in O(1) per row.
        #
        # Phase 1.1 CLOSURE: a DB read failure is NOT interpreted as "no
        # lease held". `None` means "lease truth unknown for this call";
        # `set()` means "query succeeded, no lease held". Only the latter
        # is allowed to trigger the demote below.
        held_lease_gateway_ids: Optional[set] = await fetch_held_lease_gateway_ids(db)
        for row in rows:
            live = gw_sessions.get(row.gateway_id)
            if live:
                fields = extract_live_session_fields(live)
                gw_sync[row.id] = fields["sync"]
                if fields["status"] and fields["status"] != row.status.value:
                    row.status = _parse_status(fields["status"])
                    row.is_phone_online = bool(
                        fields["is_phone_online"]
                        if fields["is_phone_online"] is not None
                        else row.is_phone_online
                    )
                    row.battery_level = (
                        fields["battery_level"]
                        if fields["battery_level"] is not None
                        else row.battery_level
                    )
                    row.phone_number = (
                        fields["phone"] if fields["phone"] is not None else row.phone_number
                    )
                live_qr = fields["qr_code"]
                if live_qr:
                    row.qr_code = live_qr
                elif fields["status"] == "CONNECTED":
                    row.qr_code = None
                if fields["status"] in ("CONNECTED", "SCAN_QR"):
                    row.error_message = None
                # Phase 1.1 §4: lease truthfulness check. After the
                # gateway-status update above has settled, the row MUST NOT
                # remain CONNECTED if no gateway instance holds the lease
                # for its `gateway_id`. The DB is the source of truth; the
                # gateway's in-memory `_leaseValidUntil` is a cache that
                # can be wrong after a TTL expiry, a contending acquire, or
                # a process restart.
                #
                # We ONLY apply this check when the gateway currently
                # reports the session as CONNECTED. A transient reconnect
                # (E/F — 500ms or backoff) keeps the lease for the duration
                # of the in-flight socket replacement; the gateway reports
                # CONNECTING during that window and we must NOT demote the
                # row to RELINK_REQUIRED. A RESTORING or DISCONNECTED
                # gateway report also exempts the check — the existing
                # status update above already moved the row to that state.
                #
                # Phase 1.1 CLOSURE: `held_lease_gateway_ids is None`
                # means the DB read itself failed; in that case we cannot
                # answer the lease-truthfulness question and we MUST NOT
                # demote. The reconciliation is deferred to the next
                # successful read.
                if (
                    held_lease_gateway_ids is not None
                    and row.status == SessionStatus.CONNECTED
                    and fields["status"] == "CONNECTED"
                    and row.gateway_id not in held_lease_gateway_ids
                ):
                    logger.warning(
                        "[WhatsApp] Verified lease-missing CONNECTED row "
                        "(DB read succeeded, gateway_id not in socket_leases); "
                        "demoting to DISCONNECTED (db_id=%s, gateway_id=%s)",
                        row.id,
                        row.gateway_id,
                    )
                    row.status = SessionStatus.DISCONNECTED
                    row.is_active = False
                    row.is_phone_online = False
                    row.qr_code = None
                    row.error_message = "WHATSAPP_LEASE_LOST"
                    row.error_reason = "LEASE_LOST"
                    row.updated_at = datetime.utcnow()
                    try:
                        await ws_manager.broadcast(
                            {
                                "event": "session_updated",
                                "user_id": str(row.user_id),
                                "session": {
                                    "id": row.id,
                                    "session_id": row.id,
                                    "status": SessionStatus.DISCONNECTED.value,
                                    "phone_number": row.phone_number,
                                    "is_active": False,
                                    "is_phone_online": False,
                                    "error_message": "WHATSAPP_LEASE_LOST",
                                    "error_reason": "LEASE_LOST",
                                },
                            },
                            target_user_id=str(row.user_id),
                        )
                    except Exception as ws_err:
                        logger.warning("[WhatsApp] lease-lost broadcast ws error: %s", ws_err)
            else:
                # Phase 1 §13: a `status=CONNECTED` row whose gateway_id is
                # absent from the gateway's session list is stale. This
                # happens after a gateway restart when
                # `WHATSAPP_AUTO_RESTORE=false` (so `restoreSessions` was NOT
                # called) or when the gateway has not yet been told about the
                # durable row. We must NOT keep reporting `CONNECTED` for a
                # session that has no live socket and no live lease — the
                # UI will believe the line is healthy, fail to deliver, and
                # silently drop events. Demote to RELINK_REQUIRED so the UI
                # can re-pair, and broadcast so connected UIs learn
                # immediately rather than at the next poll.
                if row.status == SessionStatus.CONNECTED:
                    logger.warning(
                        "[WhatsApp] Stale CONNECTED row detected (no live gateway session); demoting to RELINK_REQUIRED (db_id=%s, gateway_id=%s)",
                        row.id,
                        row.gateway_id,
                    )
                    row.status = SessionStatus.RELINK_REQUIRED
                    row.is_active = False
                    row.is_phone_online = False
                    row.qr_code = None
                    row.error_message = "WHATSAPP_GATEWAY_SESSION_MISSING"
                    row.updated_at = datetime.utcnow()
                    try:
                        await ws_manager.broadcast(
                            {
                                "event": "session_updated",
                                "user_id": str(row.user_id),
                                "session": {
                                    "id": row.id,
                                    "session_id": row.id,
                                    "status": SessionStatus.RELINK_REQUIRED.value,
                                    "phone_number": row.phone_number,
                                    "is_active": False,
                                    "is_phone_online": False,
                                    "error_message": "WHATSAPP_GATEWAY_SESSION_MISSING",
                                },
                            },
                            target_user_id=str(row.user_id),
                        )
                    except Exception as ws_err:
                        logger.warning("[WhatsApp] Stale-session broadcast ws error: %s", ws_err)
        await db.commit()
    except Exception as exc:
        gateway_error = str(exc)[:300]
        logger.warning("Gateway canli durum tazelenemedi: %s", exc)
    out: List[Dict[str, Any]] = []
    for r in rows:
        d = _session_dict(r)
        d["sync"] = gw_sync.get(r.id, {"phase": "idle", "progress": 0})
        out.append(d)
    return out, gateway_error


async def list_sessions(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """Returns list of sessions for user, refreshed with gateway live status."""
    sessions, _ = await _list_sessions_internal(db, user_id)
    return sessions


async def create_session(db: AsyncSession, user_id: str, name: str) -> Dict[str, Any]:
    """Creates a new WhatsApp session via gateway and persists row in database."""
    gw_session = await gw.create_session(name)
    gateway_id = extract_session_id(gw_session)
    if not gateway_id:
        raise gw.WhatsAppGatewayError("Gateway oturum kimligi dondurmedi.")
    row = WhatsAppSession(
        user_id=user_id,
        gateway_id=gateway_id,
        session_name=gw_session.get("session_name") or name,
        status=_parse_status(gw_session.get("status")),
        phone_number=gw_session.get("phone_number"),
        is_phone_online=bool(gw_session.get("is_phone_online", False)),
        battery_level=gw_session.get("battery_level"),
        qr_code=gw_session.get("qr_code"),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("[WhatsApp] Yeni gateway oturumu: %s (%s)", row.session_name, gateway_id)
    return _session_dict(row)


# ---------------------------------------------------------------------------
# Ephemeral Pairing (No-Create QR Lifecycle)
# ---------------------------------------------------------------------------
_ephemeral_pairings: Dict[str, Dict[str, Any]] = {}
_logical_to_ephemeral: Dict[int, str] = {}


def find_ephemeral_pairing_by_gateway_id(gateway_id: str) -> Optional[Dict[str, Any]]:
    """Lookup ephemeral pairing metadata by its gateway UUID."""
    for token, data in list(_ephemeral_pairings.items()):
        if data.get("gateway_id") == str(gateway_id):
            return data
    return None


def remove_ephemeral_pairing_by_gateway_id(gateway_id: str) -> None:
    """Clean up ephemeral pairing metadata by gateway UUID."""
    for token, data in list(_ephemeral_pairings.items()):
        if data.get("gateway_id") == str(gateway_id):
            log_id = data.get("logical_session_id")
            if log_id and _logical_to_ephemeral.get(log_id) == token:
                _logical_to_ephemeral.pop(log_id, None)
            _ephemeral_pairings.pop(token, None)


async def start_pairing_session(
    user_id: str,
    name: Optional[str] = None,
    logical_session_id: Optional[int] = None,
    db: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Starts an ephemeral pairing session in gateway without persisting any row in public.whatsapp_sessions.
    Guarantees ZERO persistent database rows until the QR code is truly scanned and connected.

    Phase 6.8: the pairing is ALSO written to the durable `ephemeral_pairings`
    record (tenant-scoped, in the private/application schema — NOT
    `public.whatsapp_sessions`, so the No-Create QR invariant is untouched).
    That record is what lets a later `session_connected` resolve the owner even
    if this process loses `_ephemeral_pairings` (restart, cancel, popped token).
    """
    line_name = name or f"Hat {datetime.utcnow().strftime('%H:%M')}"
    gw_session = await gw.create_session(line_name, ephemeral=True)
    gateway_id = extract_session_id(gw_session)
    if not gateway_id:
        raise gw.WhatsAppGatewayError("Gateway oturum kimligi dondurmedi.")
    pair_token = str(uuid.uuid4())
    _ephemeral_pairings[pair_token] = {
        "user_id": str(user_id),
        "gateway_id": gateway_id,
        "session_name": gw_session.get("session_name") or line_name,
        "logical_session_id": logical_session_id,
        "created_at": datetime.utcnow(),
        # P6-9: keep the token on the record so the event resolver can hand it
        # back to the owner's UI for correlation.
        "pair_token": pair_token,
    }
    if logical_session_id:
        _logical_to_ephemeral[logical_session_id] = pair_token
    if db is not None:
        await pairing_registry.record_pairing(
            db,
            pair_token=pair_token,
            gateway_session_id=gateway_id,
            user_id=str(user_id),
            session_name=gw_session.get("session_name") or line_name,
            logical_session_id=logical_session_id,
        )
    return {
        "pair_token": pair_token,
        "gateway_id": gateway_id,
        "session_name": gw_session.get("session_name") or line_name,
        "status": "SCAN_QR",
        "qr_code": gw_session.get("qr_code"),
    }


async def get_pairing_qr(db: AsyncSession, user_id: str, pair_token: str) -> Dict[str, Any]:
    """Fetches QR code for an active ephemeral pairing session.

    When the user scans the QR and a CONNECTED status is returned from gateway:

    Scenario A (RELINK): An existing RELINK_REQUIRED session with the same
        user_id + phone_number (or specified logical_session_id) is found. Its gateway_id
        is atomically updated and unverified history_sync_states are migrated.
        Logical session identity (public.whatsapp_sessions.id) is preserved. No new row is created.

    Scenario A-new (FIRST QR): No RELINK_REQUIRED candidate exists for this
        phone (first-time pairing). A new WhatsAppSession row is created.

    In both cases returns the stable logical session id.
    """
    pairing = _ephemeral_pairings.get(pair_token)
    if not pairing or pairing["user_id"] != str(user_id):
        raise LookupError("Eşleşme oturumu bulunamadı veya süresi doldu.")

    gateway_id = pairing["gateway_id"]
    try:
        data = await gw.get_session_qr(gateway_id)
    except gw.WhatsAppGatewayError as exc:
        if exc.status_code == 404:
            log_id = pairing.get("logical_session_id")
            if log_id and _logical_to_ephemeral.get(log_id) == pair_token:
                _logical_to_ephemeral.pop(log_id, None)
            _ephemeral_pairings.pop(pair_token, None)
            raise LookupError("Gateway oturumu bulunamadı.") from exc
        raise

    status_val = data.get("status")
    if status_val == "CONNECTED":
        phone = (data.get("phone") or data.get("phone_number") or "").strip()
        log_id = pairing.get("logical_session_id")

        def _consume_pairing() -> None:
            # Pairing is consumed ONLY after a terminal success (relink OK,
            # existing-row reuse, or new-row insert). If a later step raises,
            # the token stays intact so the user can retry instead of getting
            # "Eşleşme oturumu bulunamadı" while the phone is still connected
            # on the gateway.
            if log_id and _logical_to_ephemeral.get(log_id) == pair_token:
                _logical_to_ephemeral.pop(log_id, None)
            _ephemeral_pairings.pop(pair_token, None)

        # --- Scenario A: try to bind to existing RELINK_REQUIRED logical session ---
        try:
            result = await perform_atomic_relink(
                db,
                user_id=str(user_id),
                phone=phone,
                new_gateway_id=str(gateway_id),
                session_name=pairing["session_name"],
            )
            logger.info(
                "[WhatsApp] Relink Scenario A: session=%s gateway %s→%s (%d history rows migrated)",
                result.session_id,
                result.old_gateway_id,
                result.new_gateway_id,
                result.history_rows_migrated,
            )
            _consume_pairing()
            return {
                "status": "CONNECTED",
                "session_id": result.session_id,
                "phone": result.phone_number,
                "qr_code": None,
                "error_message": None,
            }
        except RelinkCandidateAmbiguous as exc:
            # Fail closed — multiple matching sessions, cannot safely bind.
            logger.error("[WhatsApp] Relink failed — ambiguous candidate: %s", exc)
            raise ValueError(str(exc)) from exc
        except RelinkCandidateNotFound:
            if log_id:
                # If pairing was targeted at a specific logical session, fail closed
                logger.error(
                    "[WhatsApp] Targeted relink failed for logical_session_id=%s, phone=%s",
                    log_id,
                    phone,
                )
                raise ValueError("Eşleşme tamamlandı ancak hedef oturum doğrulanamadı.")

        # --- Scenario A-new: create new logical session (first QR for this phone) ---
        # S-4: never mint a SECOND row for a phone that already has one.
        # `phone_number` has no DB uniqueness constraint, so recheck transaction-safely
        # right before the INSERT and rebind the existing row instead. This closes the
        # duplicate-session window that a `skip_locked` candidate miss used to open
        # (and also covers re-pairing a number whose session is already CONNECTED,
        # which Scenario A does not match because it requires RELINK_REQUIRED).
        existing = await find_existing_session_for_phone(
            db, user_id=str(user_id), phone=phone, exclude_gateway_id=str(gateway_id)
        )
        if existing is not None:
            existing.gateway_id = str(gateway_id)
            existing.status = SessionStatus.CONNECTED
            existing.is_active = True
            existing.is_phone_online = True
            existing.qr_code = None
            existing.error_message = None
            existing.updated_at = datetime.utcnow()
            if pairing.get("session_name"):
                existing.session_name = pairing["session_name"]
            await db.commit()
            await db.refresh(existing)
            logger.info(
                "[WhatsApp] Reused existing session id=%s for phone=%s instead of creating a duplicate.",
                existing.id,
                phone,
            )
            _consume_pairing()
            return {
                "status": "CONNECTED",
                "session_id": existing.id,
                "phone": existing.phone_number,
                "qr_code": None,
                "error_message": None,
            }

        row = WhatsAppSession(
            user_id=user_id,
            gateway_id=gateway_id,
            session_name=pairing["session_name"],
            status=SessionStatus.CONNECTED,
            phone_number=phone or None,
            is_active=True,
            is_phone_online=True,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        logger.info(
            "[WhatsApp] First-time QR pairing — new session created: id=%s (%s)",
            row.id,
            gateway_id,
        )
        _consume_pairing()
        return {
            "status": "CONNECTED",
            "session_id": row.id,
            "phone": row.phone_number,
            "qr_code": None,
            "error_message": None,
        }

    return {
        "status": status_val or "SCAN_QR",
        "qr_code": data.get("qr_code"),
        "phone": data.get("phone"),
        "error_message": data.get("error_message"),
    }


async def cancel_pairing_session(
    user_id: str, pair_token: str, db: Optional[AsyncSession] = None
) -> Dict[str, Any]:
    """Cancels an ephemeral pairing attempt that is STILL WAITING for a scan.

    Phase 6.8 — this used to be the last link in the production defect chain.
    `WhatsAppQrConnectModal` auto-closes 1.5 s after the `session_connected`
    event (and its lifecycle-effect cleanup fires on any re-render), and every
    one of those paths called this endpoint. It then unconditionally ran
    `gw.delete_session(gateway_id)` — destroying the socket that `connection.open`
    had *just* promoted, ~1.8 s after the real phone connected. The durable
    session then never existed, so every later event was rejected as an
    "unknown gateway session" (2 904 dropped in 60 s in production).

    A user closing the QR UI is allowed to cancel a pairing that is genuinely
    still waiting for pairing. It must NOT destroy an already-promoted or
    promotion-in-progress session. So the gateway's own status decides:

    * status `CONNECTED` -> the pairing already succeeded. Finalise it
      (idempotent promotion) and return WITHOUT deleting the socket.
    * anything else -> a genuine cancel: terminate the ephemeral socket.

    The operation is idempotent: the second call finds neither an in-memory
    entry nor an unconsumed durable record and does nothing at all.
    """
    pairing: Optional[Dict[str, Any]] = _ephemeral_pairings.pop(pair_token, None)
    if pairing is None:
        # Already cancelled/consumed in this process, or the in-memory map was
        # lost (restart). The durable record is the fallback — and if it is gone
        # or already consumed, this call is a no-op rather than a second delete.
        if db is None:
            return {"success": True, "cancelled": False}
        pairing = await pairing_registry.resolve_open_pairing_by_token(db, pair_token)
        if pairing is None:
            return {"success": True, "cancelled": False}

    log_id = pairing.get("logical_session_id")
    if log_id and _logical_to_ephemeral.get(log_id) == pair_token:
        _logical_to_ephemeral.pop(log_id, None)

    gateway_id = str(pairing.get("gateway_id") or "")
    if not gateway_id or str(pairing.get("user_id")) != str(user_id):
        return {"success": True, "cancelled": False}

    # --- PROMOTION-AWARE (Phase 6.8) -------------------------------------
    gateway_data: Dict[str, Any] = {}
    try:
        data = await gw.get_session_qr(gateway_id)
        if isinstance(data, dict):
            gateway_data = data
    except Exception as exc:  # noqa: BLE001 - a missing socket is still cancellable
        logger.warning("[WhatsApp] Ephemeral oturum durumu okunamadi (%s): %s", gateway_id, exc)

    if str(gateway_data.get("status") or "").upper() == "CONNECTED":
        phone = str(
            gateway_data.get("phone") or gateway_data.get("phone_number") or ""
        ).strip()
        promoted = False
        if db is not None:
            # Lazy import: `promotion` pulls in the relink layer, and this module
            # is imported very early (endpoint -> whatsapp_service -> sessions).
            from backend.app.services.whatsapp.orchestration.promotion import (
                promote_ephemeral_pairing,
            )

            row = await promote_ephemeral_pairing(
                db,
                gateway_session_id=gateway_id,
                user_id=str(user_id),
                phone=phone or None,
                session_name=pairing.get("session_name"),
                in_memory_pairing=pairing,
            )
            promoted = row is not None
        else:
            # No session to promote with — but the socket is provably connected,
            # so it must still not be destroyed by a UI lifecycle event.
            promoted = True

        if db is not None:
            await pairing_registry.consume_pairing(db, gateway_id)
        logger.info(
            "[WhatsApp] Cancel saw an already-CONNECTED pairing for gateway=%s "
            "(promoted=%s); gateway socket preserved.",
            gateway_id,
            promoted,
        )
        return {"success": True, "cancelled": False, "promoted": promoted}

    try:
        await gw.delete_session(gateway_id)
    except Exception as exc:
        logger.warning("[WhatsApp] Ephemeral gateway oturumu silinirken hata: %s", exc)
    if db is not None:
        await pairing_registry.consume_pairing(db, gateway_id)
    return {"success": True, "cancelled": True}


async def refresh_contact_avatar(db: AsyncSession, user_id: str, phone: str) -> Dict[str, Any]:
    """Refreshes contact avatar URL directly from WhatsApp via connected gateway session."""
    stmt = (
        select(WhatsAppSession)
        .where(
            get_user_filter(WhatsAppSession.user_id, user_id),
            WhatsAppSession.status == SessionStatus.CONNECTED,
            WhatsAppSession.is_active.is_(True),
        )
        .order_by(WhatsAppSession.id.desc())
    )
    sess = await db.scalar(stmt)
    if not sess:
        return {"success": False, "phone": phone, "error": "Aktif WhatsApp oturumu bulunamadı"}

    gateway_id = sess.gateway_id
    from backend.app.services.whatsapp.repositories.contacts import set_contact_avatar
    from backend.app.services.whatsapp.identity import strip_jid_prefix

    clean_phone = strip_jid_prefix(phone)
    jid = clean_phone if ("@" in clean_phone) else f"{clean_phone.lstrip('+')}@s.whatsapp.net"
    try:
        res = await gw.refresh_avatar(gateway_id, jid)
        new_url = res.get("avatar_url") if isinstance(res, dict) else None

        # Update contact in DB if exists
        contact = await db.scalar(
            select(Contact).where(
                get_user_filter(Contact.user_id, user_id),
                or_(
                    Contact.phone_e164 == phone,
                    Contact.phone_e164 == clean_phone,
                    Contact.phone_e164 == f"jid:{clean_phone}",
                ),
            )
        )
        if contact and new_url:
            set_contact_avatar(contact, new_url)
            await db.commit()

        return {"success": True, "phone": phone, "avatar_url": new_url}
    except Exception as exc:
        logger.warning("[WhatsApp] Avatar yenileme hatası (%s): %s", phone, exc)
        return {"success": False, "phone": phone, "error": str(exc)}


async def get_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    """Fetches QR code for session from gateway.

    If the logical session is in RELINK_REQUIRED state and its gateway session is
    missing/unavailable:
    - Does NOT terminate flow with WhatsAppRelinkRequired / 409.
    - Creates or reuses an ephemeral pairing session in the gateway.
    - Returns status='SCAN_QR' with the active ephemeral QR code.
    - When CONNECTED, perform_atomic_relink preserves logical session ID and migrates history states.
    """
    row = await _get_session_or_404(db, user_id, session_id)
    if row.status == SessionStatus.RELINK_REQUIRED:
        gw_missing = False
        data = None
        try:
            data = await gw.get_session_qr(row.gateway_id)
        except gw.WhatsAppGatewayError as exc:
            if is_gateway_session_missing(exc):
                gw_missing = True
            else:
                raise

        if gw_missing:
            pair_token = _logical_to_ephemeral.get(row.id)
            pairing = _ephemeral_pairings.get(pair_token) if pair_token else None
            eph_data = None
            if pairing:
                try:
                    eph_data = await gw.get_session_qr(pairing["gateway_id"])
                except gw.WhatsAppGatewayError as eph_exc:
                    if is_gateway_session_missing(eph_exc):
                        pairing = None
                    else:
                        raise

            if not pairing or not eph_data:
                line_name = row.session_name or f"Hat {datetime.utcnow().strftime('%H:%M')}"
                gw_session = await gw.create_session(line_name, ephemeral=True)
                ephemeral_gid = extract_session_id(gw_session)
                if not ephemeral_gid:
                    raise gw.WhatsAppGatewayError("Gateway oturum kimligi dondurmedi.")
                pair_token = str(uuid.uuid4())
                _ephemeral_pairings[pair_token] = {
                    "user_id": str(user_id),
                    "gateway_id": ephemeral_gid,
                    "session_name": line_name,
                    "logical_session_id": row.id,
                    "phone": row.phone_number,
                    "created_at": datetime.utcnow(),
                }
                _logical_to_ephemeral[row.id] = pair_token
                return {
                    "status": "SCAN_QR",
                    "qr_code": gw_session.get("qr_code"),
                    "phone": row.phone_number,
                    "error_message": None,
                }

            ephemeral_gid = pairing["gateway_id"]
            if eph_data.get("status") == "CONNECTED":
                phone = (
                    eph_data.get("phone")
                    or eph_data.get("phone_number")
                    or row.phone_number
                    or ""
                ).strip()
                # Pairing is consumed ONLY after relink succeeds. On failure the
                # token stays intact so the user can retry (the phone is already
                # connected on the gateway — losing the pairing would leave the
                # session stranded with "Eşleşme oturumu bulunamadı").
                relink_result = await perform_atomic_relink(
                    db,
                    user_id=str(user_id),
                    phone=phone,
                    new_gateway_id=ephemeral_gid,
                    session_name=row.session_name,
                )
                _ephemeral_pairings.pop(pair_token, None)
                _logical_to_ephemeral.pop(row.id, None)
                return {
                    "status": "CONNECTED",
                    "session_id": relink_result.session_id,
                    "phone": relink_result.phone_number,
                    "qr_code": None,
                    "error_message": None,
                }
            return {
                "status": eph_data.get("status") or "SCAN_QR",
                "qr_code": eph_data.get("qr_code"),
                "phone": row.phone_number,
                "error_message": eph_data.get("error_message"),
            }

        # If gateway session actually exists on gateway
        _apply_gateway_live(row, data)
        await db.commit()
        return {
            "status": row.status.value if hasattr(row.status, "value") else str(row.status),
            "qr_code": data.get("qr_code") or row.qr_code,
            "phone": data.get("phone") or row.phone_number,
            "error_message": data.get("error_message") or row.error_message,
        }

    data = await _gateway_op_or_mark_relink(db, row, gw.get_session_qr)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "phone": data.get("phone") or row.phone_number,
        "error_message": data.get("error_message") or row.error_message,
    }


async def refresh_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    """Refreshes QR code for session via gateway."""
    row = await _get_session_or_404(db, user_id, session_id)
    if row.status == SessionStatus.RELINK_REQUIRED:
        pair_token = _logical_to_ephemeral.get(row.id)
        pairing = _ephemeral_pairings.get(pair_token) if pair_token else None
        if pairing:
            try:
                ref_data = await gw.refresh_session_qr(pairing["gateway_id"])
                return {
                    "status": ref_data.get("status") or "SCAN_QR",
                    "qr_code": ref_data.get("qr_code"),
                    "error_message": ref_data.get("error_message"),
                }
            except Exception as exc:
                logger.warning("[WhatsApp] Ephemeral refresh failed: %s", exc)
        return await get_session_qr(db, user_id, session_id)

    data = await _gateway_op_or_mark_relink(db, row, gw.refresh_session_qr)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "error_message": data.get("error_message") or row.error_message,
    }


async def request_pairing_code(
    db: AsyncSession, user_id: str, session_id: int, phone: str
) -> Dict[str, Any]:
    """'Telefon numarası ile bağlan' — gateway'den 8 haneli pairing kodu ister.

    S-2: the phone is only a CANDIDATE at this point. Persisting it into
    `whatsapp_sessions.phone_number` here made the session look like it already
    belonged to that number before pairing had succeeded, which then fed every
    `phone_number`-keyed guard (`_isRegistered`, self-identity reconciliation,
    relink candidate matching). If the user cancelled, or completed pairing with a
    DIFFERENT number, the row kept a false canonical phone.

    Canonical persistence belongs to the success path — `session_connected` sets
    `row.phone_number` from the number the provider actually reports. The
    candidate is returned to the caller (and the ephemeral pairing registry
    already carries it for owner resolution).
    """
    row = await _get_session_or_404(db, user_id, session_id)
    data = await _gateway_op_or_mark_relink(
        db, row, lambda gid: gw.request_pairing_code(gid, phone)
    )
    pairing_code = extract_pairing_code(data)
    if not pairing_code:
        raise gw.WhatsAppGatewayError("Gateway pairing kodu döndürmedi.")
    candidate_phone = data.get("phone")
    return {
        "success": True,
        "pairing_code": str(pairing_code),
        # NOT persisted: this is the requested number, not a verified one.
        "phone": candidate_phone or row.phone_number,
        "phone_pending": bool(candidate_phone),
    }


async def request_pairing_code_for_token(
    user_id: str, pair_token: str, phone: str
) -> Dict[str, Any]:
    """'Telefon numarası ile bağlan' for a NEW (ephemeral) pairing (P6-8).

    A first-time pairing has a `pair_token` but NO numeric session id — that is
    the entire point of the ephemeral lifecycle (zero rows until connected). The
    old UI path needed `session_id`, could never obtain one, and silently did
    nothing. This is the same gateway call, addressed by the ephemeral gateway
    session instead.

    S-2 still applies: the number is a CANDIDATE. It is recorded only in the
    in-memory ephemeral registry (where owner resolution can use it) and is
    never written to `whatsapp_sessions.phone_number`. Canonical persistence
    stays on the success path (`session_connected`), so a failed or cancelled
    attempt cannot leave a false canonical phone behind.
    """
    pairing = _ephemeral_pairings.get(pair_token)
    if not pairing or pairing["user_id"] != str(user_id):
        raise LookupError("Eşleşme oturumu bulunamadı veya süresi doldu.")

    data = await gw.request_pairing_code(pairing["gateway_id"], phone)
    pairing_code = extract_pairing_code(data)
    if not pairing_code:
        raise gw.WhatsAppGatewayError("Gateway pairing kodu döndürmedi.")

    candidate = (data.get("phone") or "").strip() or None
    pairing["phone"] = candidate
    return {
        "success": True,
        "pairing_code": str(pairing_code),
        # NOT persisted: requested number, not a verified one.
        "phone": candidate,
        "phone_pending": bool(candidate),
    }


async def logout_session(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    """Disconnects session in gateway and marks DISCONNECTED in DB."""
    row = await _get_session_or_404(db, user_id, session_id)
    try:
        await gw.logout_session(row.gateway_id)
    except gw.WhatsAppGatewayError as exc:
        if not is_gateway_session_missing(exc):
            raise
        logger.warning(
            "[WhatsApp] Gateway oturumu zaten yok (DB id=%s gateway_id=%s): %s",
            row.id,
            row.gateway_id,
            exc,
        )
    row.status = SessionStatus.DISCONNECTED
    row.is_active = False
    row.is_phone_online = False
    row.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "status": "DISCONNECTED"}


async def purge_whatsapp_data(
    db: AsyncSession, user_id: str, session_id: Optional[int] = None
) -> Dict[str, int]:
    """Purges WhatsApp messages, conversations, and orphaned contacts for session."""
    purged = {"messages": 0, "conversations": 0, "contacts": 0}

    other_sessions = await db.execute(
        select(func.count())
        .select_from(WhatsAppSession)
        .where(
            get_user_filter(WhatsAppSession.user_id, user_id),
            WhatsAppSession.id != session_id if session_id is not None else True,
        )
    )
    has_other_session = (other_sessions.scalar_one() or 0) > 0

    conv_ids: List[int] = []
    for owner in (str(user_id), SYSTEM_USER_ID):
        stmt = select(Conversation.id).where(
            get_user_filter(Conversation.user_id, owner),
            Conversation.channel == "WHATSAPP",
        )
        if session_id is not None:
            if has_other_session:
                stmt = stmt.where(Conversation.session_id == session_id)
            else:
                stmt = stmt.where(
                    or_(
                        Conversation.session_id == session_id,
                        Conversation.session_id.is_(None),
                    )
                )
        res = await db.execute(stmt)
        conv_ids.extend(int(r[0]) for r in res.all())

    if not conv_ids:
        return purged

    msg_res = await db.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))
    purged["messages"] = msg_res.rowcount or 0

    con_res = await db.execute(
        select(Conversation.contact_id).where(Conversation.id.in_(conv_ids))
    )
    contact_ids = [int(r[0]) for r in con_res.all() if r[0] is not None]

    conv_res = await db.execute(delete(Conversation).where(Conversation.id.in_(conv_ids)))
    purged["conversations"] = conv_res.rowcount or 0

    if contact_ids:
        remaining = select(Conversation.contact_id).where(Conversation.contact_id.isnot(None))
        ct_res = await db.execute(
            delete(Contact).where(
                Contact.id.in_(contact_ids),
                Contact.id.notin_(remaining),
            )
        )
        purged["contacts"] = ct_res.rowcount or 0

    return purged


async def delete_session(
    db: AsyncSession,
    user_id: str,
    session_id: int,
    on_cancel_sync: Optional[Callable[[str], Any]] = None,
) -> Dict[str, Any]:
    """Deletes session in gateway, purges its local conversation data, and deletes DB row."""
    row = await _get_session_or_404(db, user_id, session_id)
    if on_cancel_sync:
        on_cancel_sync(user_id)
    gateway_ok = True
    gateway_error: Optional[str] = None
    try:
        await gw.delete_session(row.gateway_id)
    except Exception as exc:
        gateway_ok = False
        gateway_error = str(exc)[:300]
        logger.warning(
            "Gateway oturum silinemedi; yerel veri temizlenecek (user=%s session=%s gateway=%s): %s",
            user_id,
            session_id,
            row.gateway_id,
            exc,
        )
    purged = await purge_whatsapp_data(db, user_id, session_id=row.id)
    await db.delete(row)
    await db.commit()
    logger.info(
        "WhatsApp oturumu silindi (user=%s session=%s): %s eşitleme temizlendi",
        user_id,
        session_id,
        purged,
    )
    result: Dict[str, Any] = {"success": gateway_ok, "purged": purged}
    if gateway_error:
        result["error"] = gateway_error
    return result


class WhatsAppSessionOrchestrator:
    """Orchestrator class for WhatsApp session operations."""

    def __init__(self, service: Optional[Any] = None) -> None:
        self.service = service

    def session_dict(self, row: WhatsAppSession) -> Dict[str, Any]:
        return _session_dict(row)

    async def list_sessions(self, db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
        return await list_sessions(db, user_id)

    async def create_session(
        self, db: AsyncSession, user_id: str, session_name: str = "default"
    ) -> Dict[str, Any]:
        # D4: the module-level create_session(db, user_id, name) takes exactly
        # 3 params; passing a 4th (phone_number) raised TypeError whenever this
        # class method was invoked.
        return await create_session(db, user_id, session_name)

    async def get_session_qr(self, db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
        return await get_session_qr(db, user_id, session_id)

    async def refresh_session_qr(self, db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
        return await refresh_session_qr(db, user_id, session_id)

    async def request_pairing_code(
        self, db: AsyncSession, user_id: str, session_id: int, phone_number: str
    ) -> Dict[str, Any]:
        return await request_pairing_code(db, user_id, session_id, phone_number)

    async def logout_session(self, db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
        return await logout_session(db, user_id, session_id)

    async def purge_whatsapp_data(
        self, db: AsyncSession, user_id: str, session_id: Optional[int] = None
    ) -> Dict[str, int]:
        return await purge_whatsapp_data(db, user_id, session_id)

    async def delete_session(
        self, db: AsyncSession, user_id: str, session_id: int, on_cancel_sync: Optional[Callable[[str], Any]] = None
    ) -> Dict[str, Any]:
        return await delete_session(db, user_id, session_id, on_cancel_sync)

