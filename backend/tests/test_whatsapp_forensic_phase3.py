"""Phase 3 forensic regression tests — C-4 message concurrency dedup.

C-4 was the single real technical gap left open after Phase 2:
`messages.wa_message_id` was nullable and NOT unique at the DB level, so the
application-level dedup (`SELECT` then `INSERT`) was the ONLY guard. That guard
is correct for *sequential* re-delivery but cannot close a *concurrent*
SELECT-then-INSERT race.

Phase 3 closes it with a conversation-scoped PARTIAL unique index:
    UNIQUE (conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL

The tests below pin, independently of each other:
  * the migration creates exactly that index, and is idempotent
  * the migration reports BLOCKED (and destroys NOTHING) when duplicates exist
  * the migration skips cleanly when `messages` is absent
  * the model declaration and the migration agree (no schema drift)
  * the constraint really rejects a duplicate INSERT (the race backstop)
  * NULL `wa_message_id` stays unlimited, and the scope stays per-conversation
  * N parallel deliveries of the SAME provider message end with ONE row,
    no unhandled exception, and no duplicate event storm
"""

import asyncio
import copy
import re

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import AsyncSessionLocal, Base
from backend.app.core.migrations import (
    _WA_MSG_UNIQUE_INDEX,
    ensure_messages_wa_message_id_unique,
)
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.services.whatsapp.orchestration.events import (
    WhatsAppEventOrchestrator,
    ingest_gateway_event,
)

TEST_USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
GW_ID = "gw-phase3-0001"
PHONE = "+905321110077"
PHONE_JID = "905321110077@s.whatsapp.net"
RACE_WA_ID = "wa-c4-race-1"

# The exact predicate both the migration and the model must use.
_PARTIAL_PREDICATE = "wa_message_id is not null"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

async def _seed(*, with_message=False):
    """Seeds session + contact + conversation for TEST_USER. Returns ids."""
    from datetime import datetime

    from backend.app.models.contact import Contact
    from backend.app.models.conversation import Conversation, ConversationStatus
    from backend.app.models.message import MessageDirection, MessageType
    from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=GW_ID,
            session_name="Phase3 Hat",
            status=SessionStatus.CONNECTED,
            is_active=True,
            phone_number=PHONE,
        )
        db.add(sess)
        await db.flush()
        contact = Contact(user_id=TEST_USER, phone_e164=PHONE, display_name=None)
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=0,
        )
        db.add(conv)
        await db.flush()
        if with_message:
            db.add(
                Message(
                    user_id=TEST_USER,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body="anchor",
                    wa_message_id="wa-anchor-p3",
                    sender_phone=PHONE,
                    recipient_phone=PHONE,
                    external_timestamp=datetime(2026, 1, 1, 12, 0, 0),
                )
            )
        await db.commit()
        return sess.id, contact.id, conv.id


@pytest_asyncio.fixture(autouse=True)
async def _ensure_c4_index():
    """Install the C-4 index on the shared test DB before each test.

    The shared `tezlify.db` predates this migration, and `create_all` never
    alters an existing table — so without running the migration here the
    DB-level constraint would simply be ABSENT and every concurrency assertion
    in this module would be vacuously true.

    This is also precisely what happens in production: startup runs the
    migration, which is why the migration (not the model) is the authority for
    existing databases. A `BLOCKED` result is a hard failure here, because it
    would mean the test DB has duplicates that the migration refuses to clean.
    """
    from backend.app.core.database import engine as app_engine

    status = await ensure_messages_wa_message_id_unique(app_engine)
    assert status in ("CREATED", "ALREADY_PRESENT"), (
        f"the C-4 index must be installable on the test DB, got {status!r}"
    )
    yield


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    """Wipes the shared test DB rows this module touches, before and after."""
    from backend.app.models.conversation import Conversation
    from backend.app.models.message import Message

    async def _wipe():
        async with AsyncSessionLocal() as db:
            hex_id = TEST_USER.replace("-", "")
            await db.execute(
                text("DELETE FROM messages WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.execute(
                text("DELETE FROM conversations WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:h, :d)"),
                {"h": hex_id, "d": TEST_USER},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def _raw_messages_db(tmp_path, name="raw.db"):
    """A throwaway DB with a `messages` table that has NO unique index.

    This mirrors production's *pre-migration* shape, which is the only honest
    starting point for testing the migration itself.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    async with engine.begin() as conn:
        await conn.execute(text(
            "CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT)"
        ))
        await conn.execute(text(
            "CREATE TABLE messages ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " conversation_id INTEGER NOT NULL,"
            " wa_message_id VARCHAR(255),"
            " body TEXT"
            ")"
        ))
    return engine


async def _index_meta(engine, index_name):
    """Returns (exists, is_unique, is_partial, columns) for one index."""
    async with engine.connect() as conn:
        rows = (await conn.execute(text("PRAGMA index_list(messages)"))).fetchall()
        match = [r for r in rows if r[1] == index_name]
        if not match:
            return False, None, None, None
        row = match[0]
        is_unique = bool(row[2])
        # PRAGMA index_list row: (seq, name, unique, origin, partial)
        is_partial = bool(row[4]) if len(row) > 4 else None
        cols = [
            r[2]
            for r in (await conn.execute(text(f"PRAGMA index_info({index_name})"))).fetchall()
        ]
        return True, is_unique, is_partial, cols


async def _count(engine, sql, params=None):
    async with engine.connect() as conn:
        return (await conn.execute(text(sql), params or {})).scalar()


# ---------------------------------------------------------------------------
# C-4.1 — the migration creates the right index, and is idempotent
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_c4_migration_creates_conversation_scoped_partial_unique_index(tmp_path):
    """The migration must create a UNIQUE, PARTIAL index on (conversation_id, wa_message_id).

    "Partial" is load-bearing: locally-created rows have `wa_message_id IS NULL`
    until the provider acknowledges them, and many such rows must coexist in the
    same conversation. "Conversation-scoped" is equally load-bearing: the same
    WhatsApp message id may legitimately appear in a different conversation
    (LID -> PN re-keying), so a global unique index on `wa_message_id` would be
    wrong and would break `reconcile_legacy_split_conversation`.
    """
    engine = await _raw_messages_db(tmp_path, "create.db")
    try:
        status = await ensure_messages_wa_message_id_unique(engine)
        assert status == "CREATED", f"clean DB must yield CREATED, got {status!r}"

        exists, is_unique, is_partial, cols = await _index_meta(engine, _WA_MSG_UNIQUE_INDEX)
        assert exists, f"{_WA_MSG_UNIQUE_INDEX} must exist after the migration"
        assert is_unique is True, "the index must be UNIQUE"
        assert cols == ["conversation_id", "wa_message_id"], (
            f"the index must be conversation-scoped, got {cols}"
        )
        assert is_partial is True, (
            "the index must be PARTIAL, otherwise rows with a NULL "
            "wa_message_id would collide"
        )

        async with engine.connect() as conn:
            ddl = (await conn.execute(text(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=:n"
            ), {"n": _WA_MSG_UNIQUE_INDEX})).scalar()
        assert _PARTIAL_PREDICATE in (ddl or "").lower(), (
            f"the partial predicate must exclude NULLs, got: {ddl!r}"
        )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_c4_migration_is_idempotent(tmp_path):
    """A second run must be a no-op — startup runs this on every boot."""
    engine = await _raw_messages_db(tmp_path, "idem.db")
    try:
        first = await ensure_messages_wa_message_id_unique(engine)
        second = await ensure_messages_wa_message_id_unique(engine)
        assert first == "CREATED"
        assert second == "ALREADY_PRESENT", (
            f"re-running the migration must not redo work, got {second!r}"
        )
    finally:
        await engine.dispose()


# ---------------------------------------------------------------------------
# C-4.2 — BLOCKED on duplicates, with ZERO data loss
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_c4_migration_reports_blocked_on_duplicates_without_touching_data(tmp_path):
    """If duplicates exist the migration must report BLOCKED and delete NOTHING.

    `ensure_contacts_unique_phone` merges duplicates because there the canonical
    row is unambiguous (smallest id). For messages there is no safe answer to
    "which copy is the real one", so the migration must refuse and hand the
    decision to an operator. This test pins both halves: the refusal AND the
    absence of any destructive cleanup.
    """
    engine = await _raw_messages_db(tmp_path, "dupes.db")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("INSERT INTO conversations (id) VALUES (1)"))
            for body in ("a", "b", "c"):
                await conn.execute(text(
                    "INSERT INTO messages (conversation_id, wa_message_id, body) "
                    "VALUES (1, 'dup-id', :b)"
                ), {"b": body})
            await conn.execute(text(
                "INSERT INTO messages (conversation_id, wa_message_id, body) "
                "VALUES (1, 'unique-id', 'd')"
            ))

        status = await ensure_messages_wa_message_id_unique(engine)
        assert status == "BLOCKED", f"duplicates must block the migration, got {status!r}"

        exists, _, _, _ = await _index_meta(engine, _WA_MSG_UNIQUE_INDEX)
        assert exists is False, "no index may be created while duplicates exist"

        total = await _count(engine, "SELECT COUNT(*) FROM messages")
        kept = await _count(
            engine, "SELECT COUNT(*) FROM messages WHERE wa_message_id = 'dup-id'"
        )
        assert total == 4, f"no row may be deleted or merged (got {total} of 4)"
        assert kept == 3, f"all 3 duplicate rows must survive (got {kept})"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_c4_migration_skips_when_messages_table_is_absent(tmp_path):
    """`create_all` order must not matter: a missing table is a clean SKIP."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/empty.db")
    try:
        status = await ensure_messages_wa_message_id_unique(engine)
        assert status == "SKIPPED", f"missing table must yield SKIPPED, got {status!r}"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_c4_migration_does_not_raise_on_failure():
    """The migration is fail-soft: a broken DB must not take startup down.

    Every other migration in `migrations.py` logs a warning instead of raising,
    and startup must never be refused because of one optional index.
    """
    engine = create_async_engine("sqlite+aiosqlite:////nonexistent-c4-dir/boom.db")
    try:
        status = await ensure_messages_wa_message_id_unique(engine)
        assert status == "ERROR", (
            f"an internal failure must be reported as ERROR, not raised, got {status!r}"
        )
    finally:
        await engine.dispose()


# ---------------------------------------------------------------------------
# C-4.3 — the model and the migration must not drift
# ---------------------------------------------------------------------------

def _normalize_ddl(sql):
    """Lowercase, collapse whitespace, drop `IF NOT EXISTS` for comparison."""
    text_ = re.sub(r"\s+", " ", (sql or "")).strip().lower()
    return text_.replace("if not exists ", "")


@pytest.mark.asyncio
async def test_c4_model_declaration_matches_the_migration(tmp_path):
    """The ORM declaration and the migration are two halves of ONE schema fact.

    A fresh install gets the index from `create_all` (the model); an existing
    install gets it from the migration. If the two ever disagree — name, columns,
    uniqueness, or the partial predicate — the two kinds of install silently
    diverge, and the migration's existence check (which matches on NAME only)
    would happily skip a wrong index. That is exactly the drift class that
    produced the original C-4 gap.

    So this compares the DDL the migration actually emitted against the DDL
    SQLAlchemy compiles from the model, rather than pattern-matching source.
    """
    from sqlalchemy.dialects import postgresql as pg_dialect
    from sqlalchemy.dialects import sqlite as sqlite_dialect
    from sqlalchemy.schema import CreateIndex

    declared = {idx.name: idx for idx in Message.__table__.indexes}
    assert _WA_MSG_UNIQUE_INDEX in declared, (
        f"models/message.py must declare {_WA_MSG_UNIQUE_INDEX}; "
        f"declared: {sorted(declared)}"
    )
    idx = declared[_WA_MSG_UNIQUE_INDEX]
    assert idx.unique is True, "the model index must be unique"
    assert [c.name for c in idx.columns] == ["conversation_id", "wa_message_id"], (
        f"the model index must be conversation-scoped, got "
        f"{[c.name for c in idx.columns]}"
    )
    for dialect in ("sqlite", "postgresql"):
        predicate = idx.dialect_options[dialect].get("where")
        assert predicate is not None, (
            f"the model index needs a {dialect} partial predicate, otherwise "
            f"NULL wa_message_id rows would collide on that dialect"
        )
        assert _PARTIAL_PREDICATE in str(predicate).lower(), (
            f"the {dialect} predicate must exclude NULLs, got {predicate!r}"
        )

    # The migration must emit byte-equivalent DDL on SQLite.
    engine = await _raw_messages_db(tmp_path, "drift.db")
    try:
        assert await ensure_messages_wa_message_id_unique(engine) == "CREATED"
        async with engine.connect() as conn:
            migration_ddl = (await conn.execute(text(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=:n"
            ), {"n": _WA_MSG_UNIQUE_INDEX})).scalar()
    finally:
        await engine.dispose()

    model_ddl = str(CreateIndex(idx).compile(dialect=sqlite_dialect.dialect()))
    assert _normalize_ddl(migration_ddl) == _normalize_ddl(model_ddl), (
        "the migration and the model must create the SAME index.\n"
        f"  migration: {_normalize_ddl(migration_ddl)}\n"
        f"  model    : {_normalize_ddl(model_ddl)}"
    )

    # PostgreSQL: the migration uses one dialect-agnostic statement, so the
    # model's PG predicate must match its SQLite predicate.
    pg_predicate = str(idx.dialect_options["postgresql"].get("where")).lower()
    sqlite_predicate = str(idx.dialect_options["sqlite"].get("where")).lower()
    assert pg_predicate == sqlite_predicate, (
        "both dialects must use the same partial predicate, because the "
        "migration emits a single statement for both"
    )
    # ...and that single statement is valid PostgreSQL too.
    pg_ddl = str(CreateIndex(idx).compile(dialect=pg_dialect.dialect()))
    assert "where wa_message_id is not null" in pg_ddl.lower(), (
        f"the PG index must be partial, got: {pg_ddl!r}"
    )


# ---------------------------------------------------------------------------
# C-4.4 — the DB constraint is a real backstop
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_c4_db_constraint_rejects_a_duplicate_conversation_scoped_insert(tmp_path):
    """Bypass the application guard entirely and prove the DB refuses the row.

    This is the deterministic proof that the SELECT-then-INSERT race is closed.
    The application dedup stays as the fast path; this is the last line of
    defence when two requests both lose the race.
    """
    from sqlalchemy.exc import IntegrityError

    from backend.app.models.message import (
        ConversationMessageStatus,
        MessageDirection,
        MessageType,
    )

    def _msg(conv_id, wa_id, body):
        return Message(
            conversation_id=conv_id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body=body,
            wa_message_id=wa_id,
            sender_phone=PHONE,
            recipient_phone="ME",
            status=ConversationMessageStatus.RECEIVED,
        )

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/constraint.db")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        # Sanity: the model really did put the index on a fresh install.
        exists, is_unique, is_partial, cols = await _index_meta(engine, _WA_MSG_UNIQUE_INDEX)
        assert (exists, is_unique, is_partial) == (True, True, True), (
            "a fresh create_all install must get the unique partial index"
        )
        assert cols == ["conversation_id", "wa_message_id"]

        async with sessions() as db:
            db.add_all([
                Conversation(id=1, channel="WHATSAPP"),
                Conversation(id=2, channel="WHATSAPP"),
            ])
            db.add(_msg(1, "wa-x", "first"))
            await db.commit()

        # The duplicate — written straight through the ORM, so the application
        # dedup is completely out of the picture.
        with pytest.raises(IntegrityError):
            async with sessions() as db:
                db.add(_msg(1, "wa-x", "second"))
                await db.commit()

        # Many NULL wa_message_id rows must still coexist in one conversation.
        async with sessions() as db:
            for i in range(5):
                db.add(_msg(1, None, f"local-{i}"))
            await db.commit()

        # The SAME provider id in a DIFFERENT conversation is legitimate.
        async with sessions() as db:
            db.add(_msg(2, "wa-x", "other chat"))
            await db.commit()

        async with sessions() as db:
            per_conv = (
                await db.execute(text(
                    "SELECT conversation_id, COUNT(*) FROM messages "
                    "WHERE wa_message_id = 'wa-x' GROUP BY conversation_id"
                ))
            ).all()
            nulls = (
                await db.execute(text(
                    "SELECT COUNT(*) FROM messages WHERE wa_message_id IS NULL"
                ))
            ).scalar()
        assert dict(per_conv) == {1: 1, 2: 1}, (
            f"exactly one wa-x per conversation, got {per_conv}"
        )
        assert nulls == 5, f"NULL rows must stay unlimited, got {nulls}"
    finally:
        await engine.dispose()


# ---------------------------------------------------------------------------
# C-4.5 — N parallel deliveries of the SAME message
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_c4_parallel_inbound_delivery_persists_exactly_one_row():
    """The real concurrency regression: N simultaneous deliveries, ONE row.

    `ingest_gateway_event` is the production entry point (the gateway webhook
    calls it), so this drives the real path — real sessions, real commits — with
    N identical `message_new` events racing.

    A barrier is injected into owner resolution so the N deliveries overlap
    instead of degenerating into a sequential replay. The barrier sits before the
    dedup SELECT, which is the widest synchronisation point reachable without
    touching production code (there is no async hook between the SELECT and the
    INSERT).

    The overlap is real, not theoretical: with the C-4 index REMOVED, this exact
    test persisted FIVE duplicate rows for one provider message. With the index
    in place it persists one. `test_c4_db_constraint_rejects_a_duplicate_
    conversation_scoped_insert` proves the backstop deterministically; this test
    proves the end-to-end outcome under genuine contention:

      * exactly ONE row persists
      * NO exception escapes the ingest path
      * the unread counter advances exactly once (a rolled-back loser must not
        leave a half-applied increment behind)
      * every published delivery carries the SAME canonical message id, so a
        re-delivery is idempotent for the client rather than a duplicate storm
    """
    from sqlalchemy import select

    from backend.app.models.conversation import Conversation
    from backend.app.services.whatsapp.repositories.sessions import (
        resolve_event_owner_and_session,
    )

    _, _, conv_id = await _seed(with_message=False)
    n = 6
    barrier = asyncio.Barrier(n)

    class _OverlapService:
        """Stub service: every delivery clears a barrier before resolving.

        `_get_helper` prefers attributes on `self.service` and falls back to the
        module defaults for anything not defined here, so only owner resolution
        is overridden.
        """

        async def _resolve_event_owner_and_session(self, *args, **kwargs):
            await barrier.wait()
            return await resolve_event_owner_and_session(*args, **kwargs)

    orch = WhatsAppEventOrchestrator(service=_OverlapService())
    template = {
        "event": "message_new",
        "gateway_session_id": GW_ID,
        "message": {
            "conversation_id": PHONE_JID,
            "wa_message_id": RACE_WA_ID,
            "body": "hello",
            "message_type": "TEXT",
            "direction": "INBOUND",
            "sender_phone": PHONE,
        },
    }

    results = await asyncio.wait_for(
        asyncio.gather(
            *[orch.ingest_gateway_event(copy.deepcopy(template)) for _ in range(n)],
            return_exceptions=True,
        ),
        timeout=30,
    )

    escaped = [r for r in results if isinstance(r, BaseException)]
    assert not escaped, f"no exception may escape the ingest path (got {escaped!r})"

    published = [r for r in results if isinstance(r, dict)]
    assert published, "at least one delivery must be published"

    published_ids = {r.get("message", {}).get("id") for r in published}

    assert published_ids == {published[0].get("message", {}).get("id")}, (
        f"every published delivery must carry the SAME canonical message id "
        f"(got {published_ids}) — divergent ids would be a duplicate event storm"
    )

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conv_id,
                    Message.wa_message_id == RACE_WA_ID,
                )
            )
        ).scalars().all()
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == conv_id))
        ).scalars().first()

    assert len(rows) == 1, (
        f"the same wa_message_id must persist exactly once per conversation "
        f"under concurrency (got {len(rows)} rows)"
    )
    assert published_ids == {rows[0].id}, (
        "the published id must be the persisted row's id"
    )
    assert conv.unread_count == 1, (
        f"the unread counter must advance exactly once, got {conv.unread_count} "
        f"— a higher value means a losing transaction was not rolled back"
    )


@pytest.mark.asyncio
async def test_c4_parallel_delivery_of_distinct_messages_all_persist():
    """Control case: the constraint must not swallow genuinely distinct messages.

    Without this, a constraint that rejected everything would still pass the
    single-message test above.
    """
    from sqlalchemy import select

    _, _, conv_id = await _seed(with_message=False)
    n = 6

    results = await asyncio.gather(
        *[
            ingest_gateway_event({
                "event": "message_new",
                "gateway_session_id": GW_ID,
                "message": {
                    "conversation_id": PHONE_JID,
                    "wa_message_id": f"wa-c4-distinct-{i}",
                    "body": f"body-{i}",
                    "message_type": "TEXT",
                    "direction": "INBOUND",
                    "sender_phone": PHONE,
                },
            })
            for i in range(n)
        ],
        return_exceptions=True,
    )

    escaped = [r for r in results if isinstance(r, BaseException)]
    assert not escaped, f"no exception may escape (got {escaped!r})"

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conv_id,
                    Message.wa_message_id.like("wa-c4-distinct-%"),
                )
            )
        ).scalars().all()

    assert len(rows) == n, (
        f"all {n} distinct messages must persist (got {len(rows)})"
    )
    assert len({r.wa_message_id for r in rows}) == n


# ---------------------------------------------------------------------------
# C-4.6 — the private path degrades, it does not explode
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_c4_private_ingest_reuses_the_canonical_row_on_replay():
    """Sequential re-delivery via the private path must stay idempotent.

    This is the pre-existing guarantee Phase 2 pinned; it must survive the new
    constraint untouched — the constraint must never turn a clean dedup hit into
    an IntegrityError.
    """
    from sqlalchemy import select

    _, _, conv_id = await _seed(with_message=False)
    orch = WhatsAppEventOrchestrator()
    event = {
        "event": "message_new",
        "gateway_session_id": GW_ID,
        "message": {
            "conversation_id": PHONE_JID,
            "wa_message_id": RACE_WA_ID,
            "body": "hello",
            "message_type": "TEXT",
            "direction": "INBOUND",
            "sender_phone": PHONE,
        },
    }

    async with AsyncSessionLocal() as db:
        first = await orch._ingest_message(db, copy.deepcopy(event))
        await db.commit()
        second = await orch._ingest_message(db, copy.deepcopy(event))
        await db.commit()

        rows = (
            await db.execute(
                select(Message).where(
                    Message.conversation_id == conv_id,
                    Message.wa_message_id == RACE_WA_ID,
                )
            )
        ).scalars().all()

    assert len(rows) == 1, f"replay must not add a row (got {len(rows)})"
    assert first.get("message") is not None
    assert second.get("message") is not None, (
        "a replay must return the canonical row, not a skip"
    )
    assert first["message"]["id"] == second["message"]["id"], (
        "both deliveries must resolve to the SAME canonical row"
    )
