"""Real persistence regression tests; no live provider is involved."""
import uuid
import asyncio
from datetime import datetime
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message, MessageDirection, ConversationMessageStatus
from backend.app.services import whatsapp_service as ws


@pytest.mark.asyncio
async def test_equal_timestamp_cursor_visits_all_1200_messages(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/cursor.db')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    owner = str(uuid.uuid4())
    try:
        async with sessions() as db:
            conv = Conversation(user_id=owner)
            db.add(conv)
            await db.flush()
            stamp = datetime(2026, 1, 1)
            db.add_all([Message(user_id=owner, conversation_id=conv.id,
                direction=MessageDirection.INBOUND, status=ConversationMessageStatus.RECEIVED,
                sender_phone='fixture', recipient_phone='ME', external_timestamp=stamp,
                wa_message_id=f'tie-{i}') for i in range(1200)])
            await db.commit()
            monkeypatch.setattr(ws, '_get_conversation_or_404', AsyncMock(return_value=conv))
            monkeypatch.setattr(ws, '_hydrate_messages_on_demand', AsyncMock(return_value=[]))
            cursor = None
            seen = set()
            for _ in range(25):
                page = await ws.get_messages(db, owner, conv.id, limit=50, before=cursor)
                ids = {m['id'] for m in page['messages']}
                assert not seen.intersection(ids)
                seen.update(ids)
                cursor = page['oldest_message_id']
                if not page['has_more']:
                    break
            assert len(seen) == 1200
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_snapshot_is_published_before_slow_group_enrichment(monkeypatch):
    """Exercise the real sync job; block metadata only after observing a snapshot."""
    from backend.app.models.whatsapp_session import WhatsAppSession

    owner = str(uuid.uuid4())
    session = WhatsAppSession(id=1, gateway_id='fixture', user_id=owner)
    context = AsyncMock()
    monkeypatch.setattr(ws, 'AsyncSessionLocal', lambda: context)
    monkeypatch.setattr(ws, '_user_sessions', AsyncMock(return_value=[session]))
    monkeypatch.setattr(ws, '_persist_chat_snapshot', AsyncMock(return_value=([{'id': 1}], {})))
    snapshot = asyncio.Event()
    metadata = asyncio.Event()
    release = asyncio.Event()

    async def broadcast(event, user_id):
        if event['event'] == 'whatsapp_sync_chats_snapshot':
            snapshot.set()

    async def groups(*args, **kwargs):
        assert snapshot.is_set()
        metadata.set()
        await release.wait()

    async def gateway(db, row, operation):
        return await operation('fixture')

    monkeypatch.setattr(ws, '_broadcast_sync_event', broadcast)
    monkeypatch.setattr(ws, '_gateway_op_or_mark_relink', gateway)
    monkeypatch.setattr(ws.gw, 'list_conversations', AsyncMock(return_value={'items': []}))
    monkeypatch.setattr(ws.gw, 'sync_group_subjects', groups)
    messages_reached = asyncio.Event()

    async def bulk(*args, **kwargs):
        messages_reached.set()

    monkeypatch.setattr(ws, 'sync_contacts', AsyncMock(return_value=[]))
    monkeypatch.setattr(ws, '_reapply_chat_names', AsyncMock())
    monkeypatch.setattr(ws, '_bulk_channel_available', AsyncMock(return_value=True))
    monkeypatch.setattr(ws, '_run_bulk_message_sync', bulk)
    monkeypatch.setattr(ws, '_repair_last_message_previews', AsyncMock())
    monkeypatch.setattr(ws, 'list_conversations', AsyncMock(return_value=([], 0)))
    job = await ws.request_sync(context, owner)
    try:
        await asyncio.wait_for(metadata.wait(), 2)
        assert snapshot.is_set()
        await asyncio.wait_for(messages_reached.wait(), 2)
        await asyncio.wait_for(job.done.wait(), 2)
        assert job.state == 'COMPLETED'
        assert not release.is_set()
    finally:
        ws._cancel_stale_sync_jobs(owner)
        release.set()
        task = ws._metadata_tasks.get('fixture')
        if task is not None:
            await asyncio.wait_for(task, 2)
        await asyncio.wait_for(job.done.wait(), 2)


@pytest.mark.asyncio
@pytest.mark.parametrize('media', [False, True])
async def test_pending_committed_before_provider_and_early_ack_survives(tmp_path, monkeypatch, media):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/race.db')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    owner = str(uuid.uuid4())
    client_id = str(uuid.uuid4())
    try:
        async with sessions() as db:
            conv = Conversation(user_id=owner)
            db.add(conv)
            await db.commit()
            monkeypatch.setattr(ws, '_resolve_jid', AsyncMock(return_value=(conv, '905551112233@s.whatsapp.net')))
            monkeypatch.setattr(ws, '_conversation_session', AsyncMock(return_value=object()))

            async def provider(*args):
                async with sessions() as other:
                    row = await other.scalar(select(Message).where(Message.client_message_id == client_id))
                    assert row is not None and row.status == ConversationMessageStatus.PENDING
                    row.wa_message_id = 'provider-id'
                    ws._advance_message_status(row, 'READ')
                    await other.commit()
                return {'wa_message_id': 'provider-id', 'status': 'PENDING'}

            call = AsyncMock(side_effect=provider)
            monkeypatch.setattr(ws, '_gateway_op_or_mark_relink', call)
            async def send():
                if media:
                    return await ws.send_media_message(db, owner, conv.id, {'client_message_id': client_id, 'media_type': 'image'})
                return await ws.send_text_message(db, owner, conv.id, 'body', client_id)
            result = await send()
            assert result['status'] == 'READ'
            assert result['client_message_id'] == client_id
            assert (await send())['id'] == result['id']
            assert call.await_count == 1
    finally:
        await engine.dispose()