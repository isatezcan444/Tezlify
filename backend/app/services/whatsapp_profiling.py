"""Opt-in, payload-free profiling; durations never subtract cross-host clocks."""
import hashlib
import json
import logging
import os
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Callable

from sqlalchemy import event

logger = logging.getLogger(__name__)


@dataclass
class Profile:
    operation: str
    started: float = field(default_factory=time.perf_counter)
    queries: dict[str, dict[str, Any]] = field(default_factory=dict)
    transactions: int = 0
    commits: int = 0
    rollbacks: int = 0

    def snapshot(self) -> dict[str, Any]:
        count = sum(q['count'] for q in self.queries.values())
        total = sum(q['total_ms'] for q in self.queries.values())
        return {
            'operation': self.operation,
            'duration_ms': round((time.perf_counter() - self.started) * 1000, 3),
            'query_count': count, 'db_total_ms': round(total, 3),
            'db_average_ms': round(total / count, 3) if count else 0,
            'transactions': self.transactions, 'commits': self.commits,
            'rollbacks': self.rollbacks,
            'queries': sorted(self.queries.values(), key=lambda q: q['total_ms'], reverse=True),
        }


active_profile: ContextVar[Profile | None] = ContextVar('wa_profile', default=None)


def enabled() -> bool:
    return os.environ.get('WHATSAPP_LATENCY_PROFILING', '').lower() == 'true'


def install(engine: Any) -> None:
    """Register once on the engine. SQL text/parameters are never exported."""
    if getattr(engine, '_wa_profiling_installed', False):
        return
    engine._wa_profiling_installed = True

    @event.listens_for(engine, 'before_cursor_execute')
    def before(conn: Any, cursor: Any, statement: str, parameters: Any,
               context: Any, executemany: bool) -> None:
        if active_profile.get() is not None:
            context._wa_query_started = time.perf_counter()

    @event.listens_for(engine, 'after_cursor_execute')
    def after(conn: Any, cursor: Any, statement: str, parameters: Any,
              context: Any, executemany: bool) -> None:
        profile = active_profile.get()
        started = getattr(context, '_wa_query_started', None)
        if profile is None or started is None:
            return
        fingerprint = hashlib.sha256(statement.encode()).hexdigest()[:16]
        entry = profile.queries.setdefault(fingerprint, {
            'fingerprint': fingerprint, 'verb': statement.split()[0].upper(),
            'count': 0, 'total_ms': 0.0,
        })
        entry['count'] += 1
        entry['total_ms'] += (time.perf_counter() - started) * 1000

    for name, attribute in [('begin', 'transactions'), ('commit', 'commits'), ('rollback', 'rollbacks')]:
        def record(conn: Any, attribute: str = attribute) -> None:
            profile = active_profile.get()
            if profile is not None:
                setattr(profile, attribute, getattr(profile, attribute) + 1)
        event.listen(engine, name, record)


def profiled(operation: str) -> Callable[..., Any]:
    def decorate(function: Callable[..., Any]) -> Callable[..., Any]:
        @wraps(function)
        async def wrapped(*args: Any, **kwargs: Any) -> Any:
            if not enabled() or active_profile.get() is not None:
                return await function(*args, **kwargs)
            profile = Profile(operation)
            token = active_profile.set(profile)
            try:
                return await function(*args, **kwargs)
            finally:
                active_profile.reset(token)
                logger.info('wa_latency %s', json.dumps(profile.snapshot()))
        return wrapped
    return decorate