"""Phase 6.1 — cross-layer scenario execution (DB / backend / WebSocket).

The question this module answers is NOT "is function X correct?" (Phase 5 did
that) but:

    when events arrive from different sources at the same time or in an
    unfavourable order, do the DATABASE, the BACKEND event state and the
    WEBSOCKET payload all converge on the same correct final state?

Everything here runs the REAL ingest path (`ingest_gateway_event`) against the
real schema. The WebSocket layer is not mocked: `main.py:319` broadcasts exactly
the dict that `ingest_gateway_event` returns, so the returned value IS the wire
payload. Comparing it against the DB row is therefore a genuine DB <-> WS
consistency assertion.

The fourth layer (React) is covered by `frontend/scripts/verify-whatsapp-logic.mjs`,
which applies the shipped frontend mappers to payload fixtures generated from this
module's real backend runs (see `frontend/scripts/fixtures/phase6-ws-payloads.json`).

Known test-infrastructure limitation
------------------------------------
`ingest_gateway_event` only consults `whatsapp_private.processed_events` when the
dialect is PostgreSQL, so replaying the SAME `event_id` on SQLite is NOT
deduplicated at the event layer. Deduplication on SQLite therefore has to come
from the entity layer (`wa_message_id` / `client_message_id`), which is what the
scenarios below assert. Replayed-event scenarios are tagged TEST INFRASTRUCTURE
where this matters.
"""

import asyncio
import json
import pathlib
import uuid
from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp_service import ingest_gateway_event

P6_USER = "abcd1234-0000-0000-0000-000000006e01"
P6_USER_HEX = "abcd1234000000000000000000006e01"
P6_GW = "gw-p6-scenarios"
P6_PHONE = "+905550000601"
P6_JID = "905550000601@s.whatsapp.net"
P6_PHONE_2 = "+905550000602"
P6_JID_2 = "905550000602@s.whatsapp.net"
P6_GROUP_JID = "120363222222222222@g.us"
P6_LID = "900000000006601@lid"

T0 = "2026-09-18T10:00:00.000Z"
T1 = "2026-09-18T10:01:00.000Z"
T2 = "2026-09-18T10:02:00.000Z"
T3 = "2026-09-18T10:03:00.000Z"
T4 = "2026-09-18T10:04:00.000Z"
T5 = "2026-09-18T10:05:00.000Z"


def _ts(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).replace(tzinfo=None)


async def _wipe() -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM messages WHERE user_id IN (:h, :s)"),
            {"h": P6_USER_HEX, "s": P6_USER},
        )
        await db.execute(
            text("DELETE FROM conversations WHERE user_id IN (:h, :s)"),
            {"h": P6_USER_HEX, "s": P6_USER},
        )
        await db.execute(
            text("DELETE FROM contacts WHERE user_id IN (:h, :s)"),
            {"h": P6_USER_HEX, "s": P6_USER},
        )
        await db.execute(
            text("DELETE FROM whatsapp_sessions WHERE user_id IN (:h, :s)"),
            {"h": P6_USER_HEX, "s": P6_USER},
        )
        await db.commit()


@pytest_asyncio.fixture(autouse=True)
async def _isolated_tenant():
    await _wipe()
    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=P6_USER,
                gateway_id=P6_GW,
                session_name="P6 Hat",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
        )
        await db.commit()
    yield
    await _wipe()


# ---------------------------------------------------------------------------
# Event builders
# ---------------------------------------------------------------------------


def _message_new(
    wa_id: str,
    *,
    jid: str = P6_JID,
    client_id: str | None = None,
    status: str | None = None,
    direction: str = "INBOUND",
    body: str = "mesaj",
    created_at: str = T1,
    sender_name: str | None = None,
) -> dict:
    msg = {
        "conversation_id": jid,
        "wa_message_id": wa_id,
        "direction": direction,
        "message_type": "TEXT",
        "body": body,
        "created_at": created_at,
    }
    if client_id:
        msg["client_message_id"] = client_id
    if status:
        msg["status"] = status
    if sender_name:
        msg["sender_name"] = sender_name
    return {
        "event": "message_new",
        "event_id": str(uuid.uuid4()),
        "gateway_session_id": P6_GW,
        "message": msg,
    }


def _conv_updated(
    jid: str = P6_JID,
    *,
    last_message_at: str | None = None,
    last_message_preview: str | None = None,
    unread_count: int | None = None,
    name: str | None = None,
    is_group: bool | None = None,
    archived: bool | None = None,
) -> dict:
    conv: dict = {}
    if last_message_at is not None:
        conv["last_message_at"] = last_message_at
    if last_message_preview is not None:
        conv["last_message_preview"] = last_message_preview
    if unread_count is not None:
        conv["unread_count"] = unread_count
    if name is not None:
        conv["name"] = name
    if is_group is not None:
        conv["is_group"] = is_group
    if archived is not None:
        conv["archived"] = archived
    return {
        "event": "conversation_updated",
        "event_id": str(uuid.uuid4()),
        "gateway_session_id": P6_GW,
        "conversation_id": jid,
        "conversation": conv,
    }


def _status_updated(
    wa_id: str,
    status: str,
    *,
    jid: str = P6_JID,
    client_id: str | None = None,
) -> dict:
    ev = {
        "event": "message_status_updated",
        "event_id": str(uuid.uuid4()),
        "gateway_session_id": P6_GW,
        "conversation_id": jid,
        "wa_message_id": wa_id,
        "status": status,
    }
    if client_id:
        ev["client_message_id"] = client_id
    return ev


def _lid_mapped(lid: str, phone_jid: str) -> dict:
    return {
        "event": "lid_mapped",
        "event_id": str(uuid.uuid4()),
        "gateway_session_id": P6_GW,
        "lid_jid": lid,
        "phone_jid": phone_jid,
    }


# ---------------------------------------------------------------------------
# Layer readers + the §21 consistency helper
# ---------------------------------------------------------------------------


async def _db_conversation(conv_id: int) -> Conversation | None:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(Conversation).where(Conversation.id == conv_id))
        ).scalars().first()


async def _db_conv_by_jid(jid: str) -> Conversation | None:
    async with AsyncSessionLocal() as db:
        contacts = (
            await db.execute(
                select(Contact).where(
                    Contact.user_id == P6_USER,
                    Contact.phone_e164.in_(_phone_candidates(jid)),
                )
            )
        ).scalars().all()
        if not contacts:
            return None
        return (
            await db.execute(
                select(Conversation)
                .where(Conversation.contact_id.in_([c.id for c in contacts]))
                .order_by(Conversation.id.asc())
            )
        ).scalars().first()


def _phone_candidates(jid: str) -> list[str]:
    """Every `phone_e164` form the identity layer may have stored for a JID.

    A phone JID is stored as E.164; an unresolved LID / group JID is stored
    behind the `jid:` sentinel (identity.contact_phone_for_jid).
    """
    user = jid.split("@")[0]
    return [f"+{user}", f"jid:{jid}", jid]


async def _messages(conv_id: int) -> list[Message]:
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == conv_id)
                .order_by(Message.id.asc())
            )
        ).scalars().all()
        return list(rows)


def _ws_conversation(payload: dict | None) -> dict:
    """The canonical conversation object inside a WS payload."""
    assert payload is not None, "event was dropped (no WS payload emitted)"
    conv = payload.get("conversation")
    assert isinstance(conv, dict), f"WS payload carries no conversation object: {payload}"
    return conv


async def assert_conversation_consistency(
    conv_id: int,
    ws_payload: dict | None,
    *,
    check_preview: bool = True,
) -> dict:
    """§21 — DB and WebSocket must describe the SAME conversation state.

    `main.py:319` broadcasts the dict returned by `ingest_gateway_event`, and for
    `conversation_updated` that dict is rebuilt from the PERSISTED row, so any
    divergence here is a real cross-layer bug: the UI would receive a state the
    database does not hold (or vice versa).

    Returns the WS conversation object for further assertions.
    """
    conv = await _db_conversation(conv_id)
    assert conv is not None, f"conversation {conv_id} missing from DB"
    ws = _ws_conversation(ws_payload)

    assert ws.get("id") == conv.id, "WS id != DB id"
    assert ws.get("unread_count") == conv.unread_count, (
        f"WS unread {ws.get('unread_count')} != DB unread {conv.unread_count}"
    )
    db_at = conv.last_message_at.isoformat() if conv.last_message_at else None
    assert ws.get("last_message_at") == db_at, (
        f"WS last_message_at {ws.get('last_message_at')!r} != DB {db_at!r}"
    )
    if check_preview:
        assert ws.get("last_message_preview") == conv.last_message_preview, (
            f"WS preview {ws.get('last_message_preview')!r} != "
            f"DB preview {conv.last_message_preview!r}"
        )
    return ws


async def _top_conversation_id() -> int | None:
    """Ordering as the API serves it: newest activity first."""
    from backend.app.services.whatsapp_service import list_conversations

    async with AsyncSessionLocal() as db:
        rows = await list_conversations(db, P6_USER)
    if isinstance(rows, tuple):  # (items, total) shape
        rows = rows[0]
    if not rows:
        return None
    first = rows[0]
    return first.get("id") if isinstance(first, dict) else getattr(first, "id", None)


# ===========================================================================
# SCENARIO A — initial sync snapshot arrives AFTER a newer realtime event
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_a_old_snapshot_after_new_realtime_does_not_win():
    """1. snapshot starts  2. conv has T1  3. live inbound T2  5. old snapshot finishes.

    The stale snapshot must not move `last_message_at` back to T1, must not
    replace the preview, and the live message must stay persisted exactly once.
    DB, backend state and the WS payload must all agree on T2.
    """
    await ingest_gateway_event(_message_new("W-A-1", body="T1", created_at=T1))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    assert conv.last_message_at == _ts(T1)

    # 3/4. live inbound T2 (newer) is persisted
    await ingest_gateway_event(_message_new("W-A-2", body="T2", created_at=T2))

    # 5. the OLD initial snapshot finishes afterwards
    ws = await ingest_gateway_event(
        _conv_updated(P6_JID, last_message_at=T1, last_message_preview="T1")
    )

    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.last_message_at == _ts(T2), (
        f"stale snapshot moved last_message_at back to {conv.last_message_at}"
    )
    assert conv.last_message_preview == "T2", (
        f"stale snapshot replaced the preview with {conv.last_message_preview!r}"
    )
    await assert_conversation_consistency(conv.id, ws)

    # live message persisted exactly once
    assert await _count_messages(conv.id) == 2
    assert await _count_messages(conv.id, "W-A-2") == 1


async def _count_messages(conv_id: int, wa_id: str | None = None) -> int:
    async with AsyncSessionLocal() as db:
        stmt = (
            select(func.count()).select_from(Message).where(Message.conversation_id == conv_id)
        )
        if wa_id is not None:
            stmt = stmt.where(Message.wa_message_id == wa_id)
        return int((await db.execute(stmt)).scalar_one())


# ===========================================================================
# SCENARIO B — snapshot start, live M1..M3, snapshot finish
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_b_live_messages_survive_the_snapshot():
    """M1/M2/M3 must all persist, deduplicated, ordered, with M3 as the preview."""
    await ingest_gateway_event(_message_new("W-B-1", body="M1", created_at=T1))
    await ingest_gateway_event(_message_new("W-B-2", body="M2", created_at=T2))
    await ingest_gateway_event(_message_new("W-B-3", body="M3", created_at=T3))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None

    # snapshot finishes afterwards, describing only up to M1
    ws = await ingest_gateway_event(
        _conv_updated(P6_JID, last_message_at=T1, last_message_preview="M1")
    )
    conv = await _db_conversation(conv.id)
    assert conv is not None

    msgs = await _messages(conv.id)
    assert len(msgs) == 3, f"expected 3 messages, got {len(msgs)}"
    bodies = [m.body for m in msgs]
    assert bodies == ["M1", "M2", "M3"], f"ordering wrong: {bodies}"
    assert conv.last_message_preview == "M3"
    assert conv.last_message_at == _ts(T3)
    await assert_conversation_consistency(conv.id, ws)
    assert await _top_conversation_id() == conv.id


@pytest.mark.asyncio
async def test_scenario_b_two_messages_with_the_same_timestamp():
    """Equal timestamps must not dedupe into one row nor flip the preview."""
    await ingest_gateway_event(_message_new("W-BS-1", body="S1", created_at=T2))
    await ingest_gateway_event(_message_new("W-BS-2", body="S2", created_at=T2))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    msgs = await _messages(conv.id)
    assert len(msgs) == 2, f"same-timestamp messages collapsed: {len(msgs)}"
    assert {m.wa_message_id for m in msgs} == {"W-BS-1", "W-BS-2"}
    # The second arrival is the newest known activity; it must not be rejected
    # just because its timestamp equals the previous one.
    assert conv.last_message_at == _ts(T2)


# ===========================================================================
# SCENARIO C — history merge vs a newer live inbound (HIGH PRIORITY)
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_c_older_history_does_not_overwrite_newer_live_state():
    """Older history pages must merge under the live message, never over it.

    Asserts the four failure modes from the directive: the inbound is not lost,
    the merge does not overwrite it, no duplicate appears, and neither
    `last_message_at` nor the preview regress to the older page.
    """
    await ingest_gateway_event(_message_new("W-C-LIVE", body="canli", created_at=T4))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    assert conv.last_message_at == _ts(T4)
    assert conv.last_message_preview == "canli"

    # The delayed history response now lands: three OLDER messages.
    for wa, ts in (("W-C-H1", T1), ("W-C-H2", T2), ("W-C-H3", T3)):
        await ingest_gateway_event(_message_new(wa, body=f"gecmis-{wa}", created_at=ts))

    conv = await _db_conversation(conv.id)
    assert conv is not None
    msgs = await _messages(conv.id)
    assert len(msgs) == 4, f"expected live + 3 history rows, got {len(msgs)}"

    live = [m for m in msgs if m.wa_message_id == "W-C-LIVE"]
    assert len(live) == 1, "the live inbound was lost or duplicated"

    assert conv.last_message_at == _ts(T4), (
        f"history merge rewound last_message_at to {conv.last_message_at}"
    )
    assert conv.last_message_preview == "canli", (
        f"history merge rewound the preview to {conv.last_message_preview!r}"
    )


@pytest.mark.asyncio
async def test_scenario_c_delayed_provider_with_live_inbound_in_flight(monkeypatch):
    """The real interleaving: a history request is in flight (provider delayed)
    when a newer live inbound arrives.

    Only the network boundary is stubbed — `_hydrate_messages_on_demand` is
    replaced with a delayed version that delivers its older page through the
    REAL ingest path. Everything below that (persistence, dedup, preview and
    ordering policy) is the shipped code.

    Expected: older history AND the live message coexist, nothing is lost or
    duplicated, and `last_message_at` / preview stay on the LIVE message.
    """
    from backend.app.services import whatsapp_service as ws

    await ingest_gateway_event(_message_new("W-C2-SEED", body="tohum", created_at=T0))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    conv_id = conv.id

    async def slow_hydrate(*args, **kwargs):
        """Provider answer arrives late, as an OLDER page."""
        await asyncio.sleep(0.05)
        for wa, ts in (("W-C2-H1", T1), ("W-C2-H2", T2)):
            await ingest_gateway_event(_message_new(wa, body=f"gecmis-{wa}", created_at=ts))
        return []

    monkeypatch.setattr(ws, "_hydrate_messages_on_demand", slow_hydrate)

    async def history_request():
        async with AsyncSessionLocal() as db:
            return await ws.get_messages(db, P6_USER, conv_id, limit=20)

    async def live_inbound():
        await asyncio.sleep(0.01)  # lands while the provider call is still open
        return await ingest_gateway_event(
            _message_new("W-C2-LIVE", body="canli", created_at=T4)
        )

    await asyncio.gather(history_request(), live_inbound())

    conv = await _db_conversation(conv_id)
    assert conv is not None
    wids = [m.wa_message_id for m in await _messages(conv_id)]
    for wa in ("W-C2-SEED", "W-C2-H1", "W-C2-H2", "W-C2-LIVE"):
        assert wids.count(wa) == 1, f"{wa} lost or duplicated: {wids}"
    assert conv.last_message_at == _ts(T4), (
        f"live inbound lost the race to history: last_message_at={conv.last_message_at}"
    )
    assert conv.last_message_preview == "canli", (
        f"preview regressed to {conv.last_message_preview!r}"
    )


@pytest.mark.asyncio
async def test_scenario_n_previously_loaded_pages_survive_new_activity():
    """Backend half of Scenario N: pages already loaded must not disappear when
    new activity arrives and the list is refreshed."""
    await ingest_gateway_event(_message_new("W-N-1", body="yeni1", created_at=T3))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    conv_id = conv.id
    # page 2: older messages loaded by scrolling up
    for wa, ts in (("W-N-OLD1", T1), ("W-N-OLD2", T2)):
        await ingest_gateway_event(_message_new(wa, body=f"eski-{wa}", created_at=ts))
    loaded = {m.wa_message_id for m in await _messages(conv_id)}
    assert loaded == {"W-N-1", "W-N-OLD1", "W-N-OLD2"}

    # new activity + list refresh
    await ingest_gateway_event(_message_new("W-N-2", body="yeni2", created_at=T4))
    from backend.app.services.whatsapp_service import list_conversations

    async with AsyncSessionLocal() as db:
        rows = await list_conversations(db, P6_USER)
    if isinstance(rows, tuple):
        rows = rows[0]

    after = {m.wa_message_id for m in await _messages(conv_id)}
    assert loaded.issubset(after), f"loaded pages vanished: {loaded - after}"
    assert "W-N-2" in after
    assert await _count_conversations() == 1, "refresh duplicated the conversation"
    assert await _top_conversation_id() == conv_id, "new activity did not stay on top"


@pytest.mark.asyncio
async def test_scenario_c_history_page_replayed_is_not_duplicated():
    """The same history page delivered twice yields one row per message."""
    await ingest_gateway_event(_message_new("W-C-R1", body="tekrar", created_at=T1))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    # Second delivery of the same provider page (different event_id, same wa ids).
    await ingest_gateway_event(_message_new("W-C-R1", body="tekrar", created_at=T1))
    assert await _count_messages(conv.id, "W-C-R1") == 1


# ===========================================================================
# SCENARIO D — history and realtime return the SAME wa_message_id
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_d_same_wa_message_id_from_two_sources_is_one_row():
    """C-4 + application reconciliation must collapse overlapping sources."""
    await ingest_gateway_event(_message_new("W-D-1", body="ayni", created_at=T2))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None

    # The same message now also arrives through the history path.
    await ingest_gateway_event(_message_new("W-D-1", body="ayni", created_at=T2))

    assert await _count_messages(conv.id) == 1, "DB must hold exactly one row"
    assert await _count_messages(conv.id, "W-D-1") == 1
    # WS/UI reads one message.
    msgs = await _messages(conv.id)
    assert len(msgs) == 1


# ===========================================================================
# SCENARIO E — outbound PENDING + reconnect + self echo + ACK
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_e_optimistic_row_reconciles_with_the_provider_echo():
    """One logical message: the optimistic row and the echo are the same row."""
    await ingest_gateway_event(_message_new("W-E-SEED", body="selam", created_at=T0))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None

    client_id = str(uuid.uuid4())
    # 2. optimistic row created while the provider call is in flight
    await _add_outbound_row(
        conv.id, client_id, status=ConversationMessageStatus.PENDING,
        body="giden", ts=_ts(T1),
    )
    assert await _count_messages(conv.id) == 2

    # 7. self echo arrives with the provider's wa_message_id
    await ingest_gateway_event(
        _message_new(
            "W-E-ECHO",
            client_id=client_id,
            direction="OUTBOUND",
            status="SENT",
            body="giden",
            created_at=T1,
        )
    )
    # 8. ACK
    await ingest_gateway_event(_status_updated("W-E-ECHO", "DELIVERED"))

    msgs = await _messages(conv.id)
    outbound = [m for m in msgs if m.direction == MessageDirection.OUTBOUND]
    assert len(outbound) == 1, f"echo created a duplicate bubble: {len(outbound)}"
    assert outbound[0].wa_message_id == "W-E-ECHO"
    assert outbound[0].client_message_id == client_id
    assert outbound[0].status == ConversationMessageStatus.DELIVERED

    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.last_message_preview == "giden"
    assert conv.last_message_at == _ts(T1)


# ===========================================================================
# SCENARIO F — outbound PENDING -> FAILED -> retry -> SENT -> echo
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_f_failed_then_successful_retry_advances_to_sent():
    """Product semantics (status_policy.DELIVERY_STATUS_RANKS):
    PENDING=0, FAILED=0, SENT=1, DELIVERED=2, READ=3 and a status only advances
    on a STRICTLY higher rank. So FAILED (0) -> SENT (1) is a legitimate
    forward transition for a retried send, while SENT -> FAILED is not.
    """
    await ingest_gateway_event(_message_new("W-F-SEED", body="selam", created_at=T0))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None

    client_id = str(uuid.uuid4())
    await _add_outbound_row(
        conv.id, client_id, status=ConversationMessageStatus.FAILED,
        body="gidemedi", ts=_ts(T1),
    )
    row = await _get_by_client(conv.id, client_id)
    assert row is not None
    assert row.status == ConversationMessageStatus.FAILED

    # retry succeeds
    await ingest_gateway_event(
        _message_new(
            "W-F-RETRY",
            client_id=client_id,
            direction="OUTBOUND",
            status="SENT",
            body="gidemedi",
            created_at=T1,
        )
    )
    row = await _get_by_client(conv.id, client_id)
    assert row is not None
    assert row.status == ConversationMessageStatus.SENT, (
        "a successful retry must move FAILED forward to SENT"
    )
    # still one bubble
    outbound = [m for m in await _messages(conv.id) if m.direction == MessageDirection.OUTBOUND]
    assert len(outbound) == 1, f"retry created a duplicate: {len(outbound)}"

    # a late FAILED echo for the now-sent message must not downgrade it
    await ingest_gateway_event(_status_updated("W-F-RETRY", "FAILED"))
    row = await _get_by_client(conv.id, client_id)
    assert row is not None
    assert row.status == ConversationMessageStatus.SENT


async def _add_outbound_row(
    conv_id: int, client_id: str, *, status, body: str, ts: datetime
) -> None:
    """Mirror the API send path (`messaging.send_text_message`).

    That path (a) commits the optimistic row WITHOUT a `wa_message_id`,
    carrying only the client_message_id, and (b) refreshes the conversation
    preview/last_message_at through the shared `apply_conversation_last_message`
    helper (messaging.py:171-177). Both halves are reproduced here so the
    scenario starts from the state production would really be in.
    """
    from backend.app.services.whatsapp.repositories.conversations import (
        apply_conversation_last_message,
    )

    async with AsyncSessionLocal() as db:
        db.add(
            Message(
                user_id=P6_USER,
                conversation_id=conv_id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body=body,
                wa_message_id=None,
                client_message_id=client_id,
                sender_phone="ME",
                recipient_phone=P6_PHONE,
                status=status,
                external_timestamp=ts,
            )
        )
        await db.flush()
        conv = await db.get(Conversation, conv_id)
        if conv is not None:
            apply_conversation_last_message(conv, ts, body)
        await db.commit()


async def _get_by_client(conv_id: int, client_id: str) -> Message | None:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conv_id,
                    Message.client_message_id == client_id,
                )
            )
        ).scalars().first()


# ===========================================================================
# SCENARIO H — inactive chat + inbound (and the same event replayed)
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_h_inactive_inbound_raises_unread_and_preview():
    await ingest_gateway_event(_message_new("W-H-1", body="yeni", created_at=T2))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None

    ws = await ingest_gateway_event(_conv_updated(P6_JID, unread_count=7, last_message_at=T2))
    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.unread_count == 7
    await assert_conversation_consistency(conv.id, ws)
    assert await _top_conversation_id() == conv.id


@pytest.mark.asyncio
async def test_scenario_h_replayed_message_does_not_double_count_unread():
    """The same inbound message delivered twice must not increment unread twice.

    NOTE (test infrastructure): `processed_events` dedup only runs on
    PostgreSQL, so on SQLite the second delivery reaches the entity layer —
    which is exactly where the `wa_message_id` guard has to hold.
    """
    await ingest_gateway_event(_message_new("W-H-2", body="yeni", created_at=T2))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    await ingest_gateway_event(_conv_updated(P6_JID, unread_count=1, last_message_at=T2))

    # replay of the SAME message
    await ingest_gateway_event(_message_new("W-H-2", body="yeni", created_at=T2))
    await ingest_gateway_event(_conv_updated(P6_JID, unread_count=1, last_message_at=T2))

    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert await _count_messages(conv.id, "W-H-2") == 1
    # unread is authoritative from the gateway, not accumulated per delivery
    assert conv.unread_count == 1, f"unread double-counted to {conv.unread_count}"


# ===========================================================================
# SCENARIO I — external read / unread DECREASE, then a stale snapshot
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_i_external_read_decreases_then_stale_snapshot_cannot_raise():
    """unread 8 -> gateway says 0 -> DB/WS must be 0; an old snapshot saying 8
    must NOT bring the badge back."""
    await ingest_gateway_event(_message_new("W-I-1", body="sekiz", created_at=T4))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    async with AsyncSessionLocal() as db:
        c = await db.get(Conversation, conv.id)
        c.unread_count = 8
        await db.commit()

    # external read: gateway reports 0 with a current timestamp
    ws = await ingest_gateway_event(
        _conv_updated(P6_JID, unread_count=0, last_message_at=T4)
    )
    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.unread_count == 0, "external read did not clear the badge"
    ws_conv = await assert_conversation_consistency(conv.id, ws)
    assert ws_conv["unread_count"] == 0

    # a stale snapshot (older than our newest message) still claiming 8
    ws2 = await ingest_gateway_event(
        _conv_updated(P6_JID, unread_count=8, last_message_at=T1)
    )
    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.unread_count == 0, f"stale snapshot resurrected unread to {conv.unread_count}"
    await assert_conversation_consistency(conv.id, ws2)


# ===========================================================================
# SCENARIO J — read failure then success
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_j_failed_mark_read_then_success():
    """A failed provider read must not claim success; a later success must clear."""
    from unittest.mock import AsyncMock, patch

    from backend.app.services.whatsapp.orchestration.messaging import mark_conversation_read

    await ingest_gateway_event(_message_new("W-J-1", body="oku", created_at=T2))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    async with AsyncSessionLocal() as db:
        c = await db.get(Conversation, conv.id)
        c.unread_count = 4
        await db.commit()

    # provider fails
    with patch(
        "backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink",
        new=AsyncMock(side_effect=RuntimeError("gateway down")),
    ):
        res = await mark_conversation_read(AsyncSessionLocal(), P6_USER, conv.id)
    assert res["success"] is False
    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.unread_count == 4, "a failed read silently cleared the badge"

    # provider recovers
    with patch(
        "backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink",
        new=AsyncMock(return_value={"success": True}),
    ):
        res = await mark_conversation_read(AsyncSessionLocal(), P6_USER, conv.id)
    assert res["success"] is True
    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.unread_count == 0


# ===========================================================================
# SCENARIO K — contact save transition (unsaved -> named)
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_k_unsaved_number_to_saved_contact_keeps_identity_stable():
    """The display name changes, but conversation id / messages / order do not."""
    await ingest_gateway_event(_message_new("W-K-1", body="ilk", created_at=T1))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    conv_id = conv.id
    before = [m.id for m in await _messages(conv_id)]

    # contact is saved in the address book
    ws = await ingest_gateway_event(
        _conv_updated(P6_JID, name="Ahmet Yilmaz", last_message_at=T1)
    )
    conv = await _db_conversation(conv_id)
    assert conv is not None
    assert conv.id == conv_id, "contact save must not re-create the conversation"
    after = [m.id for m in await _messages(conv_id)]
    assert before == after, "contact save must not touch message rows"

    async with AsyncSessionLocal() as db:
        contact = await db.get(Contact, conv.contact_id)
    assert contact is not None
    assert contact.display_name == "Ahmet Yilmaz"
    assert await _count_conversations() == 1
    await assert_conversation_consistency(conv_id, ws)


# ===========================================================================
# SCENARIO L — LID first, mapping later
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_l_lid_then_mapping_keeps_one_conversation():
    """An unresolved LID identity must resolve in place: same conversation,
    same messages, same order, same preview."""
    await ingest_gateway_event(_message_new("W-L-1", body="lid mesaj", created_at=T1, jid=P6_LID))
    conv = await _db_conv_by_jid(P6_LID)
    assert conv is not None
    conv_id = conv.id
    msgs_before = [m.id for m in await _messages(conv_id)]
    preview_before = conv.last_message_preview

    await ingest_gateway_event(_lid_mapped(P6_LID, P6_JID))
    await ingest_gateway_event(_message_new("W-L-2", body="sonra", created_at=T2, jid=P6_LID))

    conv = await _db_conversation(conv_id)
    assert conv is not None
    assert conv.id == conv_id
    msgs_after = [m.id for m in await _messages(conv_id)]
    assert msgs_before[0] in msgs_after, "mapping lost or moved existing messages"
    assert len(msgs_after) == 2
    assert conv.last_message_preview == "sonra"
    # the first message's preview text is untouched
    first = [m for m in await _messages(conv_id) if m.wa_message_id == "W-L-1"][0]
    assert first.body == "lid mesaj"
    assert preview_before == "lid mesaj"
    assert await _count_conversations() == 1


# ===========================================================================
# SCENARIO M — group message before group metadata
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_m_group_subject_arrival_does_not_disturb_the_message():
    await ingest_gateway_event(
        _message_new("W-M-1", body="grup mesaji", created_at=T3, jid=P6_GROUP_JID)
    )
    conv = await _db_conv_by_jid(P6_GROUP_JID)
    assert conv is not None
    conv_id = conv.id
    at_before = conv.last_message_at
    preview_before = conv.last_message_preview

    # subject/metadata arrives afterwards
    ws = await ingest_gateway_event(
        _conv_updated(P6_GROUP_JID, name="Proje Ekibi", is_group=True)
    )
    conv = await _db_conversation(conv_id)
    assert conv is not None
    assert conv.id == conv_id
    assert conv.is_group is True
    assert conv.last_message_at == at_before, "metadata moved last_message_at"
    assert conv.last_message_preview == preview_before, "metadata replaced the preview"
    assert await _count_conversations() == 1
    assert await _count_messages(conv_id, "W-M-1") == 1
    await assert_conversation_consistency(conv_id, ws)


# ===========================================================================
# SCENARIO O — rapid event burst on one conversation
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_o_burst_converges_to_one_canonical_state():
    """message_new / conversation_updated / message_new / conversation_read /
    conversation_updated / message_new fired back-to-back with yields in
    between must reduce to a single canonical state shared by DB and WS."""
    await ingest_gateway_event(_message_new("W-O-1", body="b1", created_at=T1))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    conv_id = conv.id

    await asyncio.sleep(0)
    await ingest_gateway_event(_conv_updated(P6_JID, unread_count=1, last_message_at=T1))
    await asyncio.sleep(0)
    await ingest_gateway_event(_message_new("W-O-2", body="b2", created_at=T2))
    await asyncio.sleep(0)
    await ingest_gateway_event(_conv_updated(P6_JID, unread_count=0, last_message_at=T2))
    await asyncio.sleep(0)
    await ingest_gateway_event(_conv_updated(P6_JID, last_message_at=T2, last_message_preview="b2"))
    await asyncio.sleep(0)
    ws = await ingest_gateway_event(_message_new("W-O-3", body="b3", created_at=T3))

    conv = await _db_conversation(conv_id)
    assert conv is not None
    assert conv.last_message_at == _ts(T3)
    assert conv.last_message_preview == "b3"
    assert await _count_messages(conv_id) == 3
    assert await _count_conversations() == 1

    # canonical comparison against a fresh conversation_updated
    ws = await ingest_gateway_event(_conv_updated(P6_JID, last_message_at=T3))
    await assert_conversation_consistency(conv_id, ws)


# ===========================================================================
# SCENARIO P — reconnect + live events during reconcile
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_p_live_events_during_reconcile_are_not_lost():
    """Live inbound, an outbound ACK and a history event landing while the
    reconnect sync is running must all survive, deduplicated and ordered."""
    await ingest_gateway_event(_message_new("W-P-1", body="p1", created_at=T1))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    conv_id = conv.id

    client_id = str(uuid.uuid4())
    await ingest_gateway_event(
        _message_new(
            None, client_id=client_id, direction="OUTBOUND", status="PENDING",
            body="giden", created_at=T2,
        )
    )
    await ingest_gateway_event(_message_new("W-P-2", body="p2", created_at=T3))
    await ingest_gateway_event(
        _message_new("W-P-ECHO", client_id=client_id, direction="OUTBOUND",
                     status="SENT", body="giden", created_at=T2)
    )
    await ingest_gateway_event(_status_updated("W-P-ECHO", "DELIVERED"))
    # "history" page containing an already-known id plus a new older one
    await ingest_gateway_event(_message_new("W-P-2", body="p2", created_at=T3))
    await ingest_gateway_event(_message_new("W-P-OLD", body="eski", created_at=T0))

    conv = await _db_conversation(conv_id)
    assert conv is not None
    msgs = await _messages(conv_id)
    ids = [m.wa_message_id for m in msgs]
    for wa in ("W-P-1", "W-P-2", "W-P-ECHO", "W-P-OLD"):
        assert ids.count(wa) == 1, f"{wa} duplicated or lost: {ids}"
    outbound = [m for m in msgs if m.direction == MessageDirection.OUTBOUND]
    assert len(outbound) == 1, f"ACK/echo duplicated the bubble: {len(outbound)}"
    assert outbound[0].status == ConversationMessageStatus.DELIVERED
    assert conv.last_message_preview == "p2"
    assert conv.last_message_at == _ts(T3)


# ===========================================================================
# SCENARIO Q — concurrent history loads + scroll + new message + mark read
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_q_concurrent_ui_actions_keep_state_consistent():
    await ingest_gateway_event(_message_new("W-Q-1", body="q1", created_at=T2))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    conv_id = conv.id

    # two overlapping "load older" attempts for the same anchor + a new
    # inbound + a read, all interleaved
    await asyncio.gather(
        ingest_gateway_event(_message_new("W-Q-OLD", body="eski", created_at=T1)),
        ingest_gateway_event(_message_new("W-Q-OLD", body="eski", created_at=T1)),
        return_exceptions=True,
    )
    await ingest_gateway_event(_message_new("W-Q-2", body="q2", created_at=T3))
    await ingest_gateway_event(_conv_updated(P6_JID, unread_count=0, last_message_at=T3))

    conv = await _db_conversation(conv_id)
    assert conv is not None
    assert await _count_messages(conv_id, "W-Q-OLD") == 1, "concurrent load duplicated history"
    assert await _count_conversations() == 1
    assert conv.last_message_at == _ts(T3)
    assert conv.last_message_preview == "q2"
    assert conv.unread_count == 0


async def _count_conversations() -> int:
    async with AsyncSessionLocal() as db:
        return int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(Conversation)
                    .where(Conversation.user_id == P6_USER)
                )
            ).scalar_one()
        )


# ===========================================================================
# §22 — order independence for the Phase 6 module
# ===========================================================================


@pytest.mark.asyncio
async def test_scenario_a_rerun_after_other_scenarios_is_stable():
    """Re-running scenario A's sequence late in the module must give the same
    answer — guards against module-global leakage between scenarios."""
    await ingest_gateway_event(_message_new("W-Z-1", body="T1", created_at=T1))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    await ingest_gateway_event(_message_new("W-Z-2", body="T2", created_at=T2))
    ws = await ingest_gateway_event(
        _conv_updated(P6_JID, last_message_at=T1, last_message_preview="T1")
    )
    conv = await _db_conversation(conv.id)
    assert conv is not None
    assert conv.last_message_at == _ts(T2)
    assert conv.last_message_preview == "T2"
    await assert_conversation_consistency(conv.id, ws)


@pytest.mark.asyncio
async def test_scenario_i_external_read_survives_same_timestamp_snapshot():
    """P6-2: a pre-read snapshot that carries the SAME `last_message_at`.

    Reading on the phone changes neither `last_message_at` (no new message)
    nor `last_read_at` (we did not perform the read). A snapshot produced
    before the read is therefore indistinguishable from the current state by
    timestamp EQUALITY alone — the strictly-older guard does not fire. A raise
    must require strictly NEWER activity evidence.
    """
    await ingest_gateway_event(_message_new("W-I-2", body="sekiz", created_at=T4))
    conv = await _db_conv_by_jid(P6_JID)
    assert conv is not None
    async with AsyncSessionLocal() as db:
        c = await db.get(Conversation, conv.id)
        c.unread_count = 8
        await db.commit()

    # external read -> 0, same activity timestamp (no new message)
    ws = await ingest_gateway_event(
        _conv_updated(P6_JID, unread_count=0, last_message_at=T4)
    )
    conv = await _db_conversation(conv.id)
    assert conv.unread_count == 0, "external read did not clear the badge"
    await assert_conversation_consistency(conv.id, ws)

    # a pre-read snapshot carrying the SAME timestamp must not resurrect it
    ws2 = await ingest_gateway_event(
        _conv_updated(P6_JID, unread_count=8, last_message_at=T4)
    )
    conv = await _db_conversation(conv.id)
    assert conv.unread_count == 0, (
        f"same-timestamp stale snapshot resurrected unread to {conv.unread_count}"
    )
    ws_conv = await assert_conversation_consistency(conv.id, ws2)
    assert ws_conv["unread_count"] == 0

    # ...but a genuinely NEW message still raises the badge afterwards.
    await ingest_gateway_event(_message_new("W-I-3", body="yeni", created_at=T5))
    ws3 = await ingest_gateway_event(
        _conv_updated(P6_JID, unread_count=1, last_message_at=T5)
    )
    conv = await _db_conversation(conv.id)
    assert conv.unread_count == 1, (
        f"a genuine new message must still raise the badge, got {conv.unread_count}"
    )
    await assert_conversation_consistency(conv.id, ws3)


@pytest.mark.asyncio
async def test_scenario_i_legitimate_equal_timestamp_increase_still_applies():
    """P6-2 / §9 case 2: the read guard must not become a blanket ban on raises.

    P6-2 stamps `last_read_at` when an authoritative drop to 0 is applied, and
    the read guard then rejects any increase whose activity timestamp is at or
    before that stamp. That is exactly what stops a pre-read snapshot from
    resurrecting the badge (scenario I above).

    It must NOT generalise into "equal timestamps can never raise". With no read
    evidence on record, a snapshot legitimately reporting the full count at an
    unchanged `last_message_at` is the normal case (0 -> 5, 1 -> 7) and must be
    applied verbatim.

    The discriminator is READ EVIDENCE, not the value: at one identical
    timestamp, "8" is a stale pre-read echo and "5" is a legitimate report only
    because nothing was read. This test pins the no-read-evidence direction.
    """
    await ingest_gateway_event(_message_new("W-I2-1", jid=P6_JID_2, body="bir", created_at=T4))
    conv = await _db_conv_by_jid(P6_JID_2)
    assert conv is not None

    # Clean slate: nothing unread, and crucially nothing READ.
    async with AsyncSessionLocal() as db:
        c = await db.get(Conversation, conv.id)
        c.unread_count = 0
        c.last_read_at = None
        await db.commit()

    ws = await ingest_gateway_event(_conv_updated(P6_JID_2, unread_count=5, last_message_at=T4))
    conv = await _db_conversation(conv.id)
    assert conv.unread_count == 5, (
        f"a legitimate equal-timestamp increase must be applied, got {conv.unread_count}"
    )
    ws_conv = await assert_conversation_consistency(conv.id, ws)
    assert ws_conv["unread_count"] == 5
