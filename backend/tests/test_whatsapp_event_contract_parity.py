"""T-01 — Gateway → Backend → Frontend event contract parity.

Three independent sources are compared as SETS, never as counts:

1. **gateway**  — `event: '<name>'` literals under `whatsapp-gateway/src/**.js`
2. **backend**  — the dispatch chain in `orchestration/events.py`, its
                  frozensets, and its `session_` prefix rule
3. **frontend** — `LIVE_SESSION_EVENTS` in
                  `frontend/src/features/whatsapp/api/whatsappApi.ts`

A count comparison would pass while the sets disagree (two events swapped for
two others keeps the count), so every assertion below compares name sets.

Allowlists are explicit and are themselves asserted to be non-stale: an entry
that stops being needed fails the suite instead of rotting silently.

This file also pins the *behaviour* the contract depends on:

- `gateway_connected` is acknowledged, not broadcast, and not logged as an error.
- Unknown events keep their existing fail-closed behaviour (error + no broadcast).
- A broadcast reaches only the target tenant; a payload without a tenant is
  refused outright — which is exactly why `gateway_connected` cannot be
  forwarded to a user.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

import pytest

from backend.app.api.v1.websocket import ConnectionManager
from backend.app.services.whatsapp.orchestration.events import (
    WhatsAppEventOrchestrator,
    _ACKNOWLEDGED_IGNORE_EVENTS,
    _PASSTHROUGH_EVENTS,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
GATEWAY_SRC = REPO_ROOT / "whatsapp-gateway" / "src"
EVENTS_PY = (
    REPO_ROOT
    / "backend"
    / "app"
    / "services"
    / "whatsapp"
    / "orchestration"
    / "events.py"
)
FRONTEND_API_TS = (
    REPO_ROOT
    / "frontend"
    / "src"
    / "features"
    / "whatsapp"
    / "api"
    / "whatsappApi.ts"
)

# ---------------------------------------------------------------------------
# Explicit allowlists
# ---------------------------------------------------------------------------

# Backend branches that exist for a name the gateway never emits.
# `chat_update` is an accepted alias: the gateway emits `conversation_updated`,
# and the backend normalises `chat_update` into it for producers that still use
# the older name (events.py, dispatch chain).
BACKEND_ONLY_EVENTS = frozenset({"chat_update"})

# Frontend expectations with no producer anywhere in the system.
# `session_deleted` has no emitter in the gateway and no handler in the backend.
# WHATSAPP_FORENSIC_AUDIT.md records this as S-3 WITHDRAWN: the backend owns
# deletion (`sessions.delete_session` -> gateway `delete_session` ->
# `purge_whatsapp_data`), so emitting the event would only produce an
# "unknown event" error. The frontend entry is therefore vestigial, not a bug —
# it is listed here so the gap is visible rather than silently tolerated.
FRONTEND_UNPRODUCED_EVENTS = frozenset({"session_deleted"})

# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

_GATEWAY_EVENT_RE = re.compile(r"event\s*:\s*'([a-z][a-z0-9_]*)'")
_BACKEND_EQ_RE = re.compile(r'evt\s*==\s*"([a-z][a-z0-9_]*)"')
_BACKEND_IN_RE = re.compile(r"evt\s+in\s+\(([^)]*)\)")
_BACKEND_QUOTED_RE = re.compile(r'"([a-z][a-z0-9_]*)"')
_BACKEND_PREFIX_RE = re.compile(r'str\(evt\)\.startswith\("([a-z_]+)"\)')
# Frontend set members are single-quoted; backend tuples are double-quoted.
_FRONTEND_QUOTED_RE = re.compile(r"'([a-z][a-z0-9_]*)'")
_FRONTEND_SET_RE = re.compile(
    r"LIVE_SESSION_EVENTS\s*=\s*new\s+Set\(\[(.*?)\]\)", re.S
)


def _gateway_events() -> set[str]:
    names: set[str] = set()
    for path in GATEWAY_SRC.rglob("*.js"):
        names.update(_GATEWAY_EVENT_RE.findall(path.read_text(encoding="utf-8")))
    return names


def _backend_literals() -> set[str]:
    """Names the backend compares `evt` against, plus its frozenset members.

    Parsed from source on purpose: importing the dispatch chain would not expose
    which names it handles, and the point of this test is to keep the SOURCE
    honest, not a copy of it.
    """
    src = EVENTS_PY.read_text(encoding="utf-8")
    names: set[str] = set(_BACKEND_EQ_RE.findall(src))
    for group in _BACKEND_IN_RE.findall(src):
        names.update(_BACKEND_QUOTED_RE.findall(group))
    names.update(_PASSTHROUGH_EVENTS)
    names.update(_ACKNOWLEDGED_IGNORE_EVENTS)
    return names


def _backend_prefixes() -> set[str]:
    return set(_BACKEND_PREFIX_RE.findall(EVENTS_PY.read_text(encoding="utf-8")))


def _frontend_events() -> set[str]:
    match = _FRONTEND_SET_RE.search(FRONTEND_API_TS.read_text(encoding="utf-8"))
    assert match is not None, (
        "LIVE_SESSION_EVENTS literal not found in whatsappApi.ts — the parser is "
        "out of date, which would make this whole file vacuous."
    )
    return set(_FRONTEND_QUOTED_RE.findall(match.group(1)))


def _is_handled(name: str, literals: set[str], prefixes: set[str]) -> bool:
    return name in literals or any(name.startswith(p) for p in prefixes)


# ---------------------------------------------------------------------------
# Parser sanity — a dead parser must fail loudly, not pass silently
# ---------------------------------------------------------------------------


def test_parsers_found_the_expected_magnitude():
    """Guards against a refactor silently emptying a parser.

    Without this, every set-difference assertion below would pass on empty sets.
    """
    assert len(_gateway_events()) >= 20
    assert len(_backend_literals()) >= 10
    assert len(_backend_prefixes()) >= 1
    assert len(_frontend_events()) >= 3


# ---------------------------------------------------------------------------
# The three contract directions
# ---------------------------------------------------------------------------


def test_every_gateway_event_has_a_backend_home():
    """Direction 1: gateway → backend. Nothing the gateway emits is homeless."""
    gateway = _gateway_events()
    literals = _backend_literals()
    prefixes = _backend_prefixes()

    unhandled = {n for n in gateway if not _is_handled(n, literals, prefixes)}
    assert unhandled == set(), (
        "Gateway bu olaylari yayinliyor ama backend'de karsiligi yok "
        f"(bilinmeyen dala dusup ERROR loglanir): {sorted(unhandled)}"
    )


def test_backend_accepts_no_event_the_gateway_never_emits():
    """Direction 2: backend → gateway. Accepted aliases are enumerated."""
    gateway = _gateway_events()
    backend_only = _backend_literals() - gateway

    assert backend_only == BACKEND_ONLY_EVENTS, (
        "Backend'in kabul ettigi ama gateway'in hic uretmedigi olay kumesi "
        f"beklenenden farkli. Fazla: {sorted(backend_only - BACKEND_ONLY_EVENTS)}, "
        f"eksik: {sorted(BACKEND_ONLY_EVENTS - backend_only)}"
    )


def test_every_frontend_expected_event_is_actually_forwarded():
    """Direction 3: backend → frontend. No dead triggers in the browser."""
    gateway = _gateway_events()
    literals = _backend_literals()
    prefixes = _backend_prefixes()

    # An event reaches the browser only if the backend handles it AND does not
    # deliberately swallow it.
    forwarded = {
        n for n in gateway if _is_handled(n, literals, prefixes)
    } - _ACKNOWLEDGED_IGNORE_EVENTS

    missing = _frontend_events() - forwarded
    assert missing == FRONTEND_UNPRODUCED_EVENTS, (
        "Frontend'in bekledigi ama backend'in hic iletmedigi olaylar "
        f"beklenenden farkli. Fazla: {sorted(missing - FRONTEND_UNPRODUCED_EVENTS)}, "
        f"eksik: {sorted(FRONTEND_UNPRODUCED_EVENTS - missing)}"
    )


def test_gateway_connected_is_not_awaited_by_the_frontend():
    """The Stage 5.0 dead trigger must stay removed.

    `gateway_connected` carries no tenant identity (see
    `_ACKNOWLEDGED_IGNORE_EVENTS`), so it can never reach a browser socket.
    Re-adding it to `LIVE_SESSION_EVENTS` would restore a listener that waits
    forever.
    """
    assert "gateway_connected" not in _frontend_events()


def test_allowlists_are_not_stale():
    """An allowlist entry that is no longer needed must fail, not linger."""
    gateway = _gateway_events()
    backend_only = _backend_literals() - gateway
    assert BACKEND_ONLY_EVENTS <= backend_only, (
        "BACKEND_ONLY_EVENTS artik gereksiz: "
        f"{sorted(BACKEND_ONLY_EVENTS - backend_only)}"
    )

    forwarded = {
        n
        for n in gateway
        if _is_handled(n, _backend_literals(), _backend_prefixes())
    } - _ACKNOWLEDGED_IGNORE_EVENTS
    missing = _frontend_events() - forwarded
    assert FRONTEND_UNPRODUCED_EVENTS <= missing, (
        "FRONTEND_UNPRODUCED_EVENTS artik gereksiz: "
        f"{sorted(FRONTEND_UNPRODUCED_EVENTS - missing)}"
    )


def test_acknowledged_ignore_set_is_exactly_what_we_documented():
    assert _ACKNOWLEDGED_IGNORE_EVENTS == frozenset({"gateway_connected"})


# ---------------------------------------------------------------------------
# Behaviour: gateway_connected is acknowledged, not broadcast
# ---------------------------------------------------------------------------

_EVENTS_LOGGER = "backend.app.services.whatsapp.orchestration.events"


@pytest.fixture
def orchestrator():
    return WhatsAppEventOrchestrator()


@pytest.mark.asyncio
async def test_gateway_connected_is_acknowledged_not_broadcast(orchestrator, caplog):
    """Known event, no tenant identity: dropped on purpose, without an ERROR.

    Before this change it fell into the unknown branch, which logged
    "Bilinmeyen gateway olayi yayinlanmadi" on every bridge (re)connection.
    """
    event = {"event": "gateway_connected", "sessions_count": 4}

    with caplog.at_level(logging.DEBUG, logger=_EVENTS_LOGGER):
        result = await orchestrator.ingest_gateway_event(event)

    assert result is None, "gateway_connected yayinlanmamali"

    messages = [rec.getMessage() for rec in caplog.records]
    assert not any("Bilinmeyen gateway olayi" in m for m in messages), (
        f"gateway_connected hala bilinmeyen olay olarak loglaniyor: {messages}"
    )
    assert any("no_tenant_identity:gateway_connected" in m for m in messages), (
        "Bilincli yutma DEBUG seviyesinde gorunur olmali"
    )


@pytest.mark.asyncio
async def test_gateway_connected_carries_the_ack_safe_skip_marker(orchestrator):
    """`_skip` is what makes the bridge ACK instead of NACK if an id appears."""
    event = {"event": "gateway_connected", "sessions_count": 4}
    await orchestrator.ingest_gateway_event(event)

    assert event.get("_skip") == "no_tenant_identity:gateway_connected"


@pytest.mark.asyncio
async def test_unknown_event_keeps_fail_closed_error_behaviour(orchestrator, caplog):
    """Regression: the unknown branch must still error and must still not publish.

    The acknowledged-ignore branch is an allowlist, not a wildcard.
    """
    with caplog.at_level(logging.DEBUG, logger=_EVENTS_LOGGER):
        result = await orchestrator.ingest_gateway_event(
            {"event": "totally_unknown_custom_event"}
        )

    assert result is None
    messages = [rec.getMessage() for rec in caplog.records]
    assert any("Bilinmeyen gateway olayi" in m for m in messages), (
        "Bilinmeyen olay hala ERROR loglanmali"
    )


# ---------------------------------------------------------------------------
# Behaviour: broadcast is tenant-scoped (why gateway_connected cannot be sent)
# ---------------------------------------------------------------------------


class _FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent: list[str] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_broadcast_reaches_only_the_target_tenant():
    manager = ConnectionManager()
    socket_a = _FakeWebSocket()
    socket_b = _FakeWebSocket()
    await manager.connect(socket_a, "user-a")
    await manager.connect(socket_b, "user-b")

    sent = await manager.broadcast(
        {"event": "message_new", "user_id": "user-a"}, target_user_id="user-a"
    )

    assert sent == 1
    assert len(socket_a.sent) == 1
    assert socket_b.sent == [], "Baska tenant'in soketine tek bayt gitmemeli"


@pytest.mark.asyncio
async def test_broadcast_without_a_target_is_refused():
    """The exact reason `gateway_connected` is not forwarded.

    Its payload has no `user_id` and no `gateway_session_id`. This is the same
    call `_ingest_and_publish` makes, and it delivers to nobody.
    """
    manager = ConnectionManager()
    socket_a = _FakeWebSocket()
    await manager.connect(socket_a, "user-a")

    sent = await manager.broadcast(
        {"event": "gateway_connected", "sessions_count": 4}
    )

    assert sent == 0
    assert socket_a.sent == [], (
        "Hedefsiz olay genis yayina donusmemeli (cok kiracili izolasyon)"
    )
