"""Regression test for conversation lock cache bounding (Phase 11 / Memory hardening).

Verifies:
1. Same (user_id, conv_id) returns the identical lock instance.
2. The cache is bounded and prunes oldest unlocked locks when capacity is reached.
3. Active/acquired locks are never evicted while locked.
"""
import asyncio
import pytest

from backend.app.services.whatsapp.repositories.conversations import (
    _MAX_CONVERSATION_LOCKS,
    _conversation_locks,
    get_conversation_lock,
)


@pytest.mark.asyncio
async def test_conversation_lock_identity():
    lock1 = get_conversation_lock("user-1", 100)
    lock2 = get_conversation_lock("user-1", 100)
    assert lock1 is lock2


@pytest.mark.asyncio
async def test_conversation_lock_bounded_pruning():
    _conversation_locks.clear()

    # Fill up to max capacity + 10
    for i in range(_MAX_CONVERSATION_LOCKS + 10):
        get_conversation_lock("user-test", i)

    # Size should be bounded at _MAX_CONVERSATION_LOCKS
    assert len(_conversation_locks) <= _MAX_CONVERSATION_LOCKS
    # Oldest key (0) should have been pruned
    assert ("user-test", 0) not in _conversation_locks
    # Recent key should exist
    assert ("user-test", _MAX_CONVERSATION_LOCKS + 9) in _conversation_locks


@pytest.mark.asyncio
async def test_conversation_lock_never_prunes_locked_lock():
    _conversation_locks.clear()

    # Lock key 0
    locked_lock = get_conversation_lock("user-test", 0)
    await locked_lock.acquire()

    try:
        # Fill beyond capacity
        for i in range(1, _MAX_CONVERSATION_LOCKS + 5):
            get_conversation_lock("user-test", i)

        # Locked key 0 MUST still be present in the cache
        assert ("user-test", 0) in _conversation_locks
        assert _conversation_locks[("user-test", 0)] is locked_lock
    finally:
        locked_lock.release()
