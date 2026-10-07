"""Regression test for get_db commit exception propagation.

Verifies:
If session.commit() raises an exception during cleanup, get_db() does NOT swallow
the exception with 'pass', but rolls back and re-raises the error.
"""
import pytest
from unittest.mock import AsyncMock, patch

from backend.app.core.database import get_db


@pytest.mark.asyncio
async def test_get_db_raises_when_commit_fails():
    mock_session = AsyncMock()
    mock_session.is_active = True
    mock_session.commit.side_effect = RuntimeError("Database integrity violation on commit")
    mock_session.rollback = AsyncMock()
    mock_session.close = AsyncMock()
    mock_session.__aenter__.return_value = mock_session
    mock_session.__aexit__.return_value = None

    with patch("backend.app.core.database.AsyncSessionLocal", return_value=mock_session):
        gen = get_db()
        sess = await anext(gen)
        assert sess is mock_session

        with pytest.raises(RuntimeError, match="Database integrity violation on commit"):
            await anext(gen)

        mock_session.rollback.assert_awaited()
