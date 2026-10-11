"""Tests for Phase 20: Maximum performance & Baileys sync optimization.

Verifies:
1. `get_sync_watermark_epoch` can be scoped to a specific `session_id`, so older messages
   from other sessions do not poison new session watermarks.
2. Initial sync bypasses the watermark (`since_epoch = None`) so that history messages
   cached by Baileys are never excluded from ingestion.
3. Transient "no session" error during ephemeral pairing is healed in `get_loading_gate`
   when the session becomes CONNECTED.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp.repositories.messages import get_sync_watermark_epoch
from backend.app.services.whatsapp_service import get_loading_gate


@pytest.mark.asyncio
async def test_watermark_scoped_to_session():
    """Verify get_sync_watermark_epoch scopes to session_id when provided."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user_id = "test-user-p20"
    t1 = datetime(2026, 10, 10, 12, 0, 0, tzinfo=timezone.utc)
    t2 = datetime(2026, 10, 10, 15, 0, 0, tzinfo=timezone.utc)

    async with session_factory() as db:
        # Session 1 & Conv 1
        s1 = WhatsAppSession(
            id=1, user_id=user_id, gateway_id="gw-1", session_name="Hat 1", status=SessionStatus.CONNECTED
        )
        c1 = Conversation(
            id=10, user_id=user_id, session_id=1, channel="WHATSAPP", status=ConversationStatus.ACTIVE
        )
        m1 = Message(
            id=101,
            user_id=user_id,
            conversation_id=10,
            direction=MessageDirection.INBOUND,
            body="old message",
            message_type=MessageType.TEXT,
            recipient_phone="+905550001122",
            external_timestamp=t1,
            status=ConversationMessageStatus.RECEIVED,
        )

        # Session 2 & Conv 2
        s2 = WhatsAppSession(
            id=2, user_id=user_id, gateway_id="gw-2", session_name="Hat 2", status=SessionStatus.CONNECTED
        )
        c2 = Conversation(
            id=20, user_id=user_id, session_id=2, channel="WHATSAPP", status=ConversationStatus.ACTIVE
        )
        m2 = Message(
            id=102,
            user_id=user_id,
            conversation_id=20,
            direction=MessageDirection.INBOUND,
            body="newer message from session 2",
            message_type=MessageType.TEXT,
            recipient_phone="+905550001122",
            external_timestamp=t2,
            status=ConversationMessageStatus.RECEIVED,
        )

        db.add_all([s1, c1, m1, s2, c2, m2])
        await db.commit()

        # Global watermark (no session_id) returns newest message across all sessions
        global_wm = await get_sync_watermark_epoch(db, user_id)
        assert global_wm == int(t2.timestamp()) - 300

        # Scoped watermark for session 1 only considers session 1's messages
        s1_wm = await get_sync_watermark_epoch(db, user_id, session_id=1)
        assert s1_wm == int(t1.timestamp()) - 300

        # Scoped watermark for session 3 (no messages) returns None
        s3_wm = await get_sync_watermark_epoch(db, user_id, session_id=999)
        assert s3_wm is None


@pytest.mark.asyncio
async def test_initial_sync_bypasses_watermark():
    """Verify that an unsynced session (initial_sync_completed_at is None) requests since=None."""
    from backend.app.services.whatsapp.orchestration.sync import (
        SyncJob,
        WhatsAppSyncOrchestrator,
    )

    orch = WhatsAppSyncOrchestrator()
    job = SyncJob(user_id="user-p20-init", sync_id="sync-p20-1")

    # Fake db
    fake_db = MagicMock(spec=AsyncSession)
    fake_db.execute = AsyncMock(return_value=MagicMock(fetchall=MagicMock(return_value=[])))

    ws_session = MagicMock(spec=WhatsAppSession)
    ws_session.id = 172
    ws_session.gateway_id = "gw-uuid-172"
    ws_session.initial_sync_completed_at = None  # INITIAL SYNC!

    with patch(
        "backend.app.services.whatsapp.orchestration.sync.gw.list_all_messages",
        new=AsyncMock(return_value={"messages": [], "total": 0})
    ) as mock_list_all, patch(
        "backend.app.services.whatsapp.orchestration.sync._sync_watermark_epoch",
        new=AsyncMock(return_value=1791645000)
    ):
        # Run _run_bulk_message_sync
        await orch._run_bulk_message_sync(
            fake_db,
            job,
            jid_by_conv={1: "chat@s.whatsapp.net"},
            gateway_id="gw-uuid-172",
            ws_session=ws_session,
        )

        mock_list_all.assert_called_once()
        called_kwargs = mock_list_all.call_args[1]
        assert called_kwargs.get("since") is None, "Initial sync MUST use since=None to ingest Baileys history!"


@pytest.mark.asyncio
async def test_loading_gate_heals_transient_no_session_error():
    """Verify get_loading_gate recovers when session is CONNECTED but had a transient pre-promotion error."""
    fake_db = MagicMock(spec=AsyncSession)
    fake_user_id = "user-transient-test"

    fake_session = {
        "id": 172,
        "status": "CONNECTED",
        "sync": {"phase": "ready", "progress": 100},
        "initial_sync_completed": False,
    }

    fake_job_snap = {
        "state": "FAILED",
        "stage": "starting",
        "error": "Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin.",
    }

    def fake_get_sync_job(uid):
        return fake_job_snap

    def fake_schedule_initial_sync(uid):
        fake_job_snap["state"] = "SYNCING"
        fake_job_snap["error"] = None

    with patch("backend.app.services.whatsapp_service._list_sessions_internal", new=AsyncMock(return_value=([fake_session], None))), \
         patch("backend.app.services.whatsapp_service._sync_orchestrator.get_sync_job", side_effect=fake_get_sync_job), \
         patch("backend.app.services.whatsapp_service._sync_orchestrator._schedule_initial_sync", side_effect=fake_schedule_initial_sync) as mock_sched, \
         patch("backend.app.services.whatsapp_service.gw.request_avatar_backfill", new=AsyncMock(return_value={"missing": 0})):

        res = await get_loading_gate(fake_db, fake_user_id)

        # Assert initial sync was triggered
        mock_sched.assert_called_once_with(fake_user_id)

        # Assert error was healed and phase is not "error"
        assert res["phase"] != "error"
        assert res["error"] is None


@pytest.mark.asyncio
async def test_run_sync_job_discovers_session_via_session_key_wait():
    """Verify _run_sync_job waits for promotion commit when job.session_key is provided."""
    from backend.app.services.whatsapp.orchestration.sync import WhatsAppSyncOrchestrator, SyncJob
    from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus

    call_count = 0
    promoted_sess = WhatsAppSession(
        id=179,
        user_id="user-race-test",
        gateway_id="gw-race-uuid",
        status=SessionStatus.CONNECTED,
    )

    async def fake_user_sessions(db, owner, connected_only=True):
        nonlocal call_count
        call_count += 1
        # First call: uncommitted transaction -> empty
        if call_count == 1:
            return []
        # Subsequent call: transaction committed -> returns promoted session
        return [promoted_sess]

    mock_service = MagicMock()
    mock_service._broadcast_sync_event = AsyncMock()
    mock_service._user_sessions = fake_user_sessions
    mock_service._bulk_channel_available = AsyncMock(return_value=False)
    mock_service._sync_conversations_impl = AsyncMock()
    mock_service._persist_chat_snapshot = AsyncMock(return_value=([], {}))
    mock_service.sync_contacts = AsyncMock(return_value=[])
    mock_service._reapply_chat_names = AsyncMock()
    mock_service._gateway_op_or_mark_relink = AsyncMock(return_value={"items": []})
    mock_service.gateway_op_or_mark_relink = AsyncMock(return_value={"items": []})
    mock_service._schedule_metadata_enrichment = MagicMock()
    mock_service._run_background_history_expansion = AsyncMock()
    mock_service._repair_last_message_previews = AsyncMock()
    mock_service._repair_phone_sender_names = AsyncMock()
    mock_service.list_conversations = AsyncMock(return_value=([], 0))
    mock_service._sync_watermark_epoch = AsyncMock(return_value=None)
    mock_service._await_gateway_history_ready = AsyncMock(return_value="ready")

    gw_mock = MagicMock()
    gw_mock.list_conversations = AsyncMock(return_value={"items": []})
    gw_mock.list_all_messages = AsyncMock(return_value={"messages": [], "total": 0})
    gw_mock.request_avatar_backfill = AsyncMock(return_value={"missing": 0})
    mock_service.gw = gw_mock

    mock_session_ctx = MagicMock()
    mock_db = MagicMock(spec=AsyncSession)
    mock_db.rollback = AsyncMock()
    mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
    mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
    mock_service.AsyncSessionLocal = MagicMock(return_value=mock_session_ctx)

    orch = WhatsAppSyncOrchestrator(service=mock_service)
    mock_service._sync_event = orch._sync_event

    job = SyncJob(
        sync_id="race-test-job",
        user_id="user-race-test",
        session_key="gw-race-uuid",
    )

    # Should not raise NoWhatsAppSession because session_key triggers wait loop
    await orch._run_sync_job(job)

    assert job.state == "COMPLETED"
    assert job.error is None
    assert call_count >= 2


def test_get_sync_job_heals_stale_transient_no_session_error():
    """Verify get_sync_job heals a transient pre-promotion no-session error."""
    from backend.app.services.whatsapp_service import get_sync_job, _sync_orchestrator
    from backend.app.services.whatsapp.orchestration.sync import SyncJob

    stale_job = SyncJob(sync_id="stale-job", user_id="user-stale-test")
    stale_job.state = "FAILED"
    stale_job.error = "Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin."
    _sync_orchestrator._sync_jobs["user-stale-test"] = stale_job

    snap = get_sync_job("user-stale-test")
    assert snap is None, "Stale transient no-session error MUST be healed to None (IDLE)!"
