"""Real SQLite costs with synthetic provider data, never a live E2E claim."""
import json
import time
import uuid
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp_profiling import Profile, active_profile, install


@pytest.mark.asyncio
@pytest.mark.parametrize('chat_count,message_count', [(1, 5500), (500, 5500)])
async def test_bulk_cost_and_bounded_chat_open(tmp_path, monkeypatch, chat_count, message_count):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/profile.db')
    install(engine.sync_engine)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    owner = str(uuid.uuid4())
    async with sessions() as db:
        conversations = [Conversation(user_id=owner) for _ in range(chat_count)]
        db.add_all(conversations)
        await db.commit()
        mapping = {c.id: f'{100000 + i}@s.whatsapp.net' for i, c in enumerate(conversations)}
    jids = list(mapping.values())
    messages = [{
        'conversation_id': jids[i % chat_count], 'wa_message_id': f'fixture-{i}',
        'direction': 'INBOUND', 'message_type': 'TEXT', 'body': 'fixture',
        'sender_phone': 'fixture', 'recipient_phone': 'ME',
        'created_at': f'2025-01-01T00:{i // 60 % 60:02d}:{i % 60:02d}Z',
    } for i in range(message_count)]

    async def bulk(gateway_id, limit=1000, offset=0, **kwargs):
        return {'messages': messages[offset:offset + limit], 'total': len(messages)}

    monkeypatch.setattr(ws.gw, 'list_all_messages', bulk)
    emitted = []
    started = time.perf_counter()

    async def broadcast(payload, owner):
        emitted.append((time.perf_counter() - started, payload))

    monkeypatch.setattr(ws, '_broadcast_sync_event', broadcast)
    job = ws.SyncJob(str(uuid.uuid4()), owner)
    profile = Profile('synthetic_bulk')
    token = active_profile.set(profile)
    try:
        async with sessions() as db:
            await ws._run_bulk_message_sync(db, job, mapping, 'fixture')
        measured = profile.snapshot()
    finally:
        active_profile.reset(token)
    async with sessions() as db:
        assert await db.scalar(select(func.count(Message.id))) == message_count
        conversation = await db.get(Conversation, next(iter(mapping)))
        monkeypatch.setattr(ws, '_get_conversation_or_404', AsyncMock(return_value=conversation))
        monkeypatch.setattr(ws, '_hydrate_messages_on_demand', AsyncMock(return_value=[]))
        opened = time.perf_counter()
        page = await ws.get_messages(db, owner, conversation.id, limit=50)
        open_ms = (time.perf_counter() - opened) * 1000
        assert len(page['messages']) <= 50
    assert measured['commits'] == 6
    assert measured['query_count'] < 60
    async with sessions() as db:
        replay = ws.SyncJob(str(uuid.uuid4()), owner)
        await ws._run_bulk_message_sync(db, replay, mapping, 'fixture')
        assert replay.messages_synced == 0
        assert await db.scalar(select(func.count(Message.id))) == message_count
    chunks = [pair for pair in emitted if pair[1]['event'] == 'whatsapp_sync_messages_chunk']
    assert chunks and all(len(payload['messages']) <= 100 for _, payload in chunks)
    measured.update(chats=chat_count, messages=message_count, chat_open_ms=open_ms,
                    first_chunk_ms=chunks[0][0] * 1000)
    print('WA_BENCHMARK ' + json.dumps(measured))
    await engine.dispose()


def test_profile_never_exports_sql_or_parameters():
    profile = Profile('fixture')
    assert 'parameters' not in profile.snapshot()
    assert profile.snapshot()['query_count'] == 0