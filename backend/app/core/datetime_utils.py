"""
Centralized UTC datetime helpers for Tezlify.
Replaces deprecated `datetime.utcnow()` with Python 3.12+ compliant timezone-aware and naive UTC generators.
"""

from datetime import datetime, timezone
from typing import Optional


def utc_now() -> datetime:
    """Returns a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def utc_now_naive() -> datetime:
    """Returns a naive UTC datetime for database columns defined as TIMESTAMP WITHOUT TIME ZONE.
    
    Prevents Python 3.12+ DeprecationWarning while maintaining complete compatibility
    with existing SQLite and PostgreSQL timestamp without time zone columns.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def as_naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Normalizes an optional datetime (aware or naive) into a naive UTC datetime."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt
