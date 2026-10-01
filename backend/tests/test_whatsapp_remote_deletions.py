"""Phone-side deletion sync (remote delete) contract.

PRODUCTION SYMPTOM (2026-10-01, reported as "mobilden Sevda'nın sohbetini
sildim, Tezlify'a yansımadı"): a chat deleted on the phone stayed in the CRM.

Root cause, read from the running Baileys 7.0.0-rc14 typings rather than
guessed: `BaileysEventMap` declares `chats.delete: string[]` and
`messages.delete: { keys } | { jid, all: true }`, and the gateway subscribed to
NEITHER — the names appeared nowhere in its source. The gateway now subscribes
and emits `conversation_deleted` / `messages_deleted`.

These checks pin the backend half of that contract:

- `conversation_deleted` is ROUTED (an unrouted event is dropped as "unknown"
  by the dispatcher, which is exactly the shape the bug had),
- it answers with the NUMERIC conversation id the UI already understands,
- a replay for an already-deleted conversation is an idempotent skip,
- `messages.deleted { all: true }` clears messages WITHOUT deleting the chat —
  collapsing the two shapes would delete a chat the user only cleared,
- a malformed jid never reaches the database.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator


class _Rows:
    def __init__(self, rowcount=0):
        self.rowcount = rowcount

    def scalar_one(self):
        return 0


class _Db:
    """Minimal AsyncSession stand-in: records statements, returns rowcounts."""

    bind = None

    def __init__(self, rowcounts=None):
        self.statements = []
        self.orm_deletes = []
        self.commits = 0
        self._rowcounts = list(rowcounts or [])

    async def execute(self, stmt):
        self.statements.append(str(stmt))
        return _Rows(self._rowcounts.pop(0) if self._rowcounts else 1)

    async def delete(self, obj):
        self.orm_deletes.append(obj)

    async def commit(self):
        self.commits += 1


class _Factory:
    def __init__(self, db):
        self._db = db

    def __call__(self):
        return self

    async def __aenter__(self):
        return self._db

    async def __aexit__(self, *exc):
        return False


def _orchestrator(db, *, owner="user-1", session_id=7, conv=MagicMock(id=42)):
    service = MagicMock()
    service._resolve_event_owner_and_session = AsyncMock(return_value=(owner, session_id))
    service._find_whatsapp_conversation = AsyncMock(return_value=conv)
    service.AsyncSessionLocal = _Factory(db)
    return WhatsAppEventOrchestrator(service=service)


@pytest.mark.asyncio
async def test_conversation_deleted_is_routed_and_reports_numeric_id():
    db = _Db(rowcounts=[3, 9])
    orch = _orchestrator(db)

    res = await orch.ingest_gateway_event(
        {"event": "conversation_deleted", "conversation_id": "905300000000@s.whatsapp.net"}
    )

    # An unrouted event name returns None ("Bilinmeyen gateway olayi"), so a
    # payload here is the proof that the dispatcher knows the event.
    assert res is not None, "conversation_deleted must be routed, not dropped as unknown"
    assert res["conversation_id"] == 42, "the UI keys off the NUMERIC conversation id"
    assert res["deleted"] is True
    assert res["messages_deleted"] == 9
    assert db.orm_deletes, "the conversation row itself must be removed"


@pytest.mark.asyncio
async def test_conversation_deleted_for_missing_chat_is_an_idempotent_skip():
    db = _Db()
    orch = _orchestrator(db, conv=None)

    res = await orch.ingest_gateway_event(
        {"event": "conversation_deleted", "conversation_id": "905300000000@s.whatsapp.net"}
    )

    # The same delete can arrive twice (durable outbox replay + live socket).
    assert res is None
    assert not db.orm_deletes, "nothing may be deleted when the chat is already gone"


@pytest.mark.asyncio
async def test_messages_deleted_all_clears_messages_but_keeps_the_chat():
    conv = MagicMock(id=42)
    db = _Db(rowcounts=[5])
    orch = _orchestrator(db, conv=conv)

    res = await orch.ingest_gateway_event(
        {
            "event": "messages_deleted",
            "conversation_id": "905300000000@s.whatsapp.net",
            "all": True,
        }
    )

    assert res is not None
    assert res["all"] is True
    assert res["messages_deleted"] == 5
    assert not db.orm_deletes, "clearing a chat must NOT delete the conversation"
    # Nothing is left, so a preview pointing at a deleted message would lie.
    assert conv.last_message_preview is None
    assert conv.unread_count == 0


@pytest.mark.asyncio
async def test_messages_deleted_specific_ids_keeps_the_chat():
    conv = MagicMock(id=42)
    db = _Db(rowcounts=[2])
    orch = _orchestrator(db, conv=conv)

    res = await orch.ingest_gateway_event(
        {
            "event": "messages_deleted",
            "conversation_id": "905300000000@s.whatsapp.net",
            "wa_message_ids": ["A1", "B2"],
        }
    )

    assert res is not None
    assert res["wa_message_ids"] == ["A1", "B2"]
    assert res["messages_deleted"] == 2
    assert not db.orm_deletes, "deleting a message must not delete its chat"


@pytest.mark.asyncio
async def test_messages_deleted_without_a_shape_is_skipped_not_guessed():
    db = _Db()
    orch = _orchestrator(db)

    res = await orch.ingest_gateway_event(
        {"event": "messages_deleted", "conversation_id": "905300000000@s.whatsapp.net"}
    )

    # No `all` and no ids: refusing beats guessing a scope the user never asked
    # for. A wrong guess here deletes a chat.
    assert res is None
    assert not db.orm_deletes


@pytest.mark.asyncio
async def test_malformed_jids_never_reach_the_database():
    db = _Db()
    orch = _orchestrator(db)

    # `not-a-jid` / `""` are caught by the `"@" in jid` guard, and
    # `status@broadcast` by the broadcast guard — both BEFORE any lookup.
    for bad in ["status@broadcast", "not-a-jid", ""]:
        res = await orch.ingest_gateway_event(
            {"event": "conversation_deleted", "conversation_id": bad}
        )
        assert res is None, f"{bad} must be skipped"

    assert not db.statements, "an invalid jid must not issue a single query"


@pytest.mark.asyncio
async def test_unresolvable_jid_deletes_nothing():
    # MEASURED, not assumed: the Python `is_degenerate_jid` accepts an empty
    # local part (`@s.whatsapp.net`) — it is weaker than the JS one. The event
    # therefore does reach the lookup. The safety property that actually holds
    # is that no conversation matches such a jid, so nothing is deleted.
    db = _Db()
    orch = _orchestrator(db, conv=None)

    res = await orch.ingest_gateway_event(
        {"event": "conversation_deleted", "conversation_id": "@s.whatsapp.net"}
    )

    assert res is None
    assert not db.orm_deletes, "a jid that matches no chat must delete nothing"
