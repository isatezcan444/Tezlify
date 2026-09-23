"""Phase 2.A closure — end-to-end falsification for 3Hacker-class discovery.

Two layers, with an explicit real/mocked boundary:

Layer 1 (gateway, behavioural): the plain-Node harness
`whatsapp-gateway/tests/phase2a-group-hydration.test.mjs` drives the REAL
`createSessionManager` factory with a mock Baileys socket and proves:
  - TEST A: absent group + successful targeted groupMetadata → chat SEEDED
            with subject (fail-first: pre-fix code fails this assertion).
  - TEST D: no subsequent `chats.update` / `_touchChat` injection required —
            the group is visible through `listConversations` immediately.
  - TEST E: jid present in `_pendingGroupJids` + `extraJids` (twice) →
            exactly one `groupMetadata` call, exactly one chat record.
  - TEST F: one failing `groupMetadata` does not cascade to other jids.

Layer 2 (backend, real integration): this module executes the harness, reads
the REAL `conversation_updated` payload it emitted, and feeds that exact
payload through the REAL production ingestion path
(`whatsapp_service.ingest_gateway_event` → `_map_conversation_event` →
`_ensure_conversation_race_safe` → DB commit) and then broadcasts it exactly
like the `/ws/gateway` receiver in `backend/app/main.py` does
(`ws_manager.broadcast(persisted)`).

Real vs mocked, explicitly:
  REAL   — gateway session-manager factory, targeted fallback, seeding,
           event emission + outbound sanitization; backend ingestion, owner
           resolution, conversation + contact persistence, DB commit,
           ws_manager tenant-scoped broadcast.
  MOCKED — Baileys socket (groupFetchAllParticipating / groupMetadata) and
           the frontend WebSocket transport (minimal in-memory fake, same
           technique as test_whatsapp_tenant_isolation.py).
"""
import json
import subprocess
import uuid as _uuid
from pathlib import Path
from typing import Any, Dict, List

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.api.v1.websocket import ws_manager
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.conversation import Conversation
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_service as ws

GATEWAY_HARNESS = (
    Path(__file__).resolve().parents[2] / "whatsapp-gateway" / "tests" / "phase2a-group-hydration.test.mjs"
)

# Isolated tenant for this module (unique vs other test files).
U1 = "44444444-4444-4444-4444-444444444444"
U1_HEX = U1.replace("-", "")


class _FakeWS:
    """Minimal frontend WebSocket fake — records broadcast payloads."""

    def __init__(self) -> None:
        self.sent: List[str] = []

    async def accept(self) -> None:  # pragma: no cover - transport detail
        return None

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)


@pytest_asyncio.fixture(autouse=True)
async def _clean_state():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"),
                    {"u": U1_HEX},
                )
            await db.commit()

    for sock in list(ws_manager.active_connections):
        ws_manager.disconnect(sock)
    ws_manager.active_connections.clear()
    ws_manager.user_connections.clear()
    ws_manager.socket_user_map.clear()

    await _wipe()
    yield
    await _wipe()
    for sock in list(ws_manager.active_connections):
        ws_manager.disconnect(sock)
    ws_manager.active_connections.clear()
    ws_manager.user_connections.clear()
    ws_manager.socket_user_map.clear()


async def _add_session(gateway_id: str) -> None:
    async with AsyncSessionLocal() as db:
        db.add(
            WhatsAppSession(
                user_id=U1,
                gateway_id=gateway_id,
                session_name=f"s-{gateway_id[:8]}",
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
        )
        await db.commit()


@pytest.fixture(scope="module")
def hydration_event(tmp_path_factory) -> Dict[str, Any]:
    """Run the gateway behavioural harness; return the conversation_updated
    payload it REALLY emitted during SCENARIO A (absent zero-message group →
    metadata success → chat seeded). The jid and subject are RANDOM per run
    (genericity contract) — read them from the artefact, never hardcode."""
    out = tmp_path_factory.mktemp("phase2a") / "hydration-event.json"
    proc = subprocess.run(
        ["node", str(GATEWAY_HARNESS), str(out)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(GATEWAY_HARNESS.parent),
    )
    assert proc.returncode == 0, (
        "Gateway behavioural harness FAILED — Phase 2.1.A falsification gate "
        f"(scenarios A/B, tests E/G/H/F/I/J/K):\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    )
    return json.loads(out.read_text())


@pytest.fixture(scope="module")
def target_jid(hydration_event) -> str:
    jid = str((hydration_event.get("conversation") or {}).get("jid") or "")
    assert jid.endswith("@g.us"), f"artefact jid must be a group jid, got {jid!r}"
    return jid


@pytest.fixture(scope="module")
def target_subject(hydration_event) -> str:
    subject = str((hydration_event.get("conversation") or {}).get("name") or "")
    assert subject, "artefact must carry the resolved group subject"
    return subject


# ---------------------------------------------------------------------------
# TEST B — absent group → REAL persistence
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_hydrated_group_persists_via_real_ingestion(hydration_event, target_jid, target_subject):
    """The gateway-emitted conversation_updated payload for the hydrated
    group must create a REAL public.conversations row through the real
    ingestion path — not just mutate gateway memory."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    await _add_session(gw_id)

    event = dict(hydration_event)
    # Route the REAL payload to THIS test's session row (owner resolution is
    # keyed on gateway_session_id). The conversation payload itself is the
    # untouched gateway artefact.
    event["gateway_session_id"] = gw_id

    persisted = await ws.ingest_gateway_event(event)
    assert persisted is not None, (
        "conversation_updated for the hydrated group must be ingested "
        "(owner resolvable, not skipped)"
    )
    assert persisted.get("user_id"), "persisted event must carry the resolved owner"
    assert persisted.get("conversation_id"), "persisted event must carry the conversation id"

    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Conversation).where(Conversation.user_id == U1)
        )
        convs = list(res.scalars().all())
        assert len(convs) == 1, "exactly one conversation must exist for the hydrated group"
        conv = convs[0]
        assert conv.is_group is True, "hydrated group must persist as a group conversation"
        assert conv.channel is not None
        # The display name must come from the seeded subject via the contact.
        from backend.app.models.contact import Contact

        c = await db.get(Contact, conv.contact_id)
        assert c is not None, "a contact row must back the conversation"
        assert c.display_name == target_subject, (
            f"contact display_name must be the resolved group subject ({target_subject!r}), got {c.display_name!r}"
        )


# ---------------------------------------------------------------------------
# TEST C — absent group → frontend visibility
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_hydrated_group_broadcast_reaches_frontend(hydration_event, target_jid, target_subject):
    """After real ingestion, the broadcast call used by the production
    /ws/gateway receiver (`ws_manager.broadcast(persisted)`, main.py) must
    deliver a conversation_updated payload for the hydrated group to the
    owner's frontend socket."""
    gw_id = f"gw-{_uuid.uuid4().hex}"
    await _add_session(gw_id)

    fake = _FakeWS()
    await ws_manager.connect(fake, user_id=U1)

    event = dict(hydration_event)
    event["gateway_session_id"] = gw_id

    persisted = await ws.ingest_gateway_event(event)
    assert persisted is not None

    # The EXACT production broadcast call (backend/app/main.py, /ws/gateway).
    sent = await ws_manager.broadcast(persisted)
    assert sent >= 1, "broadcast must reach at least the owner's socket"
    assert fake.sent, "frontend socket must have received the broadcast"

    # The socket may also receive unrelated bootstrap broadcasts; the
    # hydrated group's conversation_updated must be among them.
    conv_payloads = [
        json.loads(p)
        for p in fake.sent
        if json.loads(p).get("event") == "conversation_updated"
    ]
    assert conv_payloads, (
        f"frontend must receive a conversation_updated broadcast; got events: "
        f"{[json.loads(p).get('event') for p in fake.sent]}"
    )
    payload = conv_payloads[0]
    assert payload.get("user_id") in (U1, U1_HEX), "broadcast payload must stay tenant-scoped"
    conv_payload = payload.get("conversation") or {}
    # Canonical REST/WebSocket conversation shape (single authority):
    # `phone` carries the group jid (with the documented `jid:` sentinel
    # prefix used by the backend contact store), `name` the resolved subject.
    phone = str(conv_payload.get("phone") or "")
    if phone.startswith("jid:"):
        phone = phone[4:]
    assert phone == target_jid, (
        f"frontend payload must identify the hydrated group ({target_jid})"
    )
    assert conv_payload.get("name") == target_subject, (
        "frontend payload must carry the resolved group subject"
    )
    assert conv_payload.get("is_group") is True
