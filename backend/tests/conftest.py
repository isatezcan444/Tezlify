import pytest
from backend.app.core.config import settings

@pytest.fixture(scope="session", autouse=True)
def run_db_migrations():
    import asyncio
    from backend.app.core.database import engine
    from backend.app.core.migrations import ensure_campaigns_columns, ensure_quick_replies_table
    async def _run():
        await ensure_campaigns_columns(engine)
        await ensure_quick_replies_table(engine)

    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    if loop.is_running():
        # already running loop
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            pool.submit(lambda: asyncio.run(_run())).result()
    else:
        loop.run_until_complete(_run())

@pytest.fixture(autouse=True)
def enable_history_expansion_in_tests():
    old = getattr(settings, "WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED", False)
    settings.WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED = True
    yield
    settings.WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED = old


@pytest.fixture(autouse=True)
def disable_identity_sweep_in_tests():
    """Testlerde periyodik LID süpürmesi KAPALI.

    Açık kalsaydı arka plan görevi, kendi kapısı olan testlerin tohumladığı
    satırları testin ortasında birleştirir ve "birleştirilecek=1" bekleyen bir
    iddiayı zamanlamaya bağlı hale getirirdi. Süpürmeyi ölçen test kendi
    çağrısını yapar (`run_identity_sweep_once`).
    """
    from backend.app.core.config import settings
    from backend.app.services.whatsapp import reconciliation as reconciliation_mod

    old = getattr(settings, "WHATSAPP_IDENTITY_SWEEP_ENABLED", True)
    settings.WHATSAPP_IDENTITY_SWEEP_ENABLED = False
    reset_sweep_state = getattr(reconciliation_mod, "reset_sweep_state", None)
    if callable(reset_sweep_state):
        reset_sweep_state()
    yield
    settings.WHATSAPP_IDENTITY_SWEEP_ENABLED = old
    if callable(reset_sweep_state):
        reset_sweep_state()


@pytest.fixture(autouse=True)
def reset_whatsapp_module_globals():
    """Clear process-global WhatsApp state between tests.

    Several WhatsApp coordinators keep module-level mutable state keyed by a
    DB id: the on-demand provider budget `(owner, conversation_id)`, the
    in-flight history-fetch map, the conversation locks, and the history
    JID cooldown/attempt counters.

    These keys are unique in production — a conversation id is never reused —
    so the state is correctly scoped there. In the test suite, though, every
    module wipes the tables, so SQLite hands out the SAME ids again. Distinct
    conversations then share one budget: once 6 provider round-trips land
    inside the 10s window for `(owner, 1)`, a later, unrelated test whose
    conversation also got id 1 is silently denied a provider call.

    That produced an order- and timing-dependent failure
    (`test_38_lazy_hydration_older_history_keyset_ordering` saw the budget
    exhausted and therefore never observed `get_messages` being called).

    Resetting between tests restores the production assumption that a
    conversation id identifies exactly one conversation.
    """
    from backend.app.services import whatsapp_service as ws
    from backend.app.services.whatsapp.orchestration import events as events_mod
    from backend.app.services.whatsapp.orchestration import sync as sync_mod

    # The owner-unresolved replay queue is process-global and holds EVENTS, not
    # just counters. Left alone between tests, a held `message_new` from one
    # test would be replayed inside an unrelated one and could make a failing
    # assertion pass — a false green. It is reset with the rest.
    reset_orphan_queue = getattr(events_mod, "reset_orphan_queue", None)
    if callable(reset_orphan_queue):
        reset_orphan_queue()

    for d in (
        getattr(sync_mod, "_on_demand_provider_calls", None),
        getattr(sync_mod, "_history_jid_cooldown", None),
        getattr(sync_mod, "_history_jid_attempts", None),
        getattr(ws, "_in_flight_history_fetches", None),
    ):
        if isinstance(d, dict):
            d.clear()

    yield

    for d in (
        getattr(sync_mod, "_on_demand_provider_calls", None),
        getattr(sync_mod, "_history_jid_cooldown", None),
        getattr(sync_mod, "_history_jid_attempts", None),
        getattr(ws, "_in_flight_history_fetches", None),
    ):
        if isinstance(d, dict):
            d.clear()

    if callable(reset_orphan_queue):
        reset_orphan_queue()
