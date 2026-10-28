import os

import pytest
from backend.app.core.config import settings

# Uzak bir veritabanina karsi test kosmayi ENGELLE.
#
# Neden: asagidaki `run_db_migrations` fixture'i autouse ve SESSION kapsamlidir;
# `settings.DATABASE_URL` neyi gosteriyorsa ona karsi migration calistirir.
# Yerelde bu bir SQLite dosyasidir ve zararsizdir. Ama kabukta unutulmus bir
# `DATABASE_URL=postgresql+asyncpg://...@uretim-hostu/...` ile `pytest`
# calistirmak, hicbir uyari vermeden URETIM semasina migration uygulardi —
# "test kostum" sanilan islem veriyi degistirirdi. Kural kagitta degil, kodda.
#
# Kacis yolu bilincli olarak tek ve acik: `TEZLIFY_TEST_DB_REMOTE_OK=1`.
_LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal", ""}


def assert_test_db_is_not_remote(database_url: str) -> None:
    """Uzak (localhost olmayan) bir DB URL'i icin RuntimeError atar."""
    url = (database_url or "").strip()
    if not url or url.startswith("sqlite"):
        return
    if os.environ.get("TEZLIFY_TEST_DB_REMOTE_OK") == "1":
        return
    host = ""
    try:
        from sqlalchemy.engine import make_url

        host = (make_url(url).host or "").strip()
    except Exception:  # noqa: BLE001 - cozulemeyen URL de uzak sayilir
        host = ""
    if host.lower() in _LOCAL_DB_HOSTS:
        return
    raise RuntimeError(
        "Testler uzak bir veritabanina baglanmayi reddetti: host=%r. "
        "Bu fixture autouse ve session kapsamli oldugu icin hedef semaya "
        "migration uygular. Uretim DB'sine karsi test kosmak veriyi degistirir. "
        "Yerel SQLite kullanin veya bilincli olarak TEZLIFY_TEST_DB_REMOTE_OK=1 verin."
        % (host,)
    )


def assert_test_db_matches_requested_path(database_url: str) -> None:
    """`TEST_DB_PATH` verildiyse testler GERCEKTEN o dosyaya baglanmali.

    Neden: `scripts/provision_test_db.py` taze bir SQLite dosyasi uretir, ama
    pytest ayri bir surectir ve `settings.DATABASE_URL` neyi gosteriyorsa ona
    baglanir. Bu iki deger ayrisirsa (ornegin yalnizca `TEST_DB_PATH`
    export edilirse) testler sessizce depodaki ESKI `tezlify.db` dosyasina
    kosar: "temiz DB" iddiasi yanlis olur ve onceki kosumlarin artiklari
    (ayni telefonlu lead'ler, eski UNIQUE indeksler) rastgele sirada
    aciga cikip alakasiz testleri dusurur.

    Sessiz yanlisligi gurultulu hataya cevirmek icin burada duruyoruz.
    """
    requested = (os.environ.get("TEST_DB_PATH") or "").strip()
    if not requested:
        return
    url = (database_url or "").strip()
    if not url.startswith("sqlite"):
        return
    try:
        from sqlalchemy.engine import make_url

        db_path = make_url(url).database or ""
    except Exception:  # noqa: BLE001 - cozulemeyen URL zaten yukarida ele alinir
        return
    if not db_path or db_path == ":memory:":
        return
    if os.path.abspath(db_path) != os.path.abspath(requested):
        raise RuntimeError(
            "Testler, provision edilen dosyaya baglanmiyor: "
            f"TEST_DB_PATH={requested!r} ama DATABASE_URL={url!r}. "
            "Provision ile pytest AYNI dosyayi kullanmalidir; ornek:\n"
            '  DATABASE_URL="sqlite+aiosqlite:////tmp/tezlify_clean.db" \\\n'
            "  TEST_DB_PATH=/tmp/tezlify_clean.db pytest backend/tests/"
        )


@pytest.fixture(scope="session", autouse=True)
def run_db_migrations():
    # HERHANGI bir baglanti kurulmadan once: hedef gercekten yerel mi?
    assert_test_db_is_not_remote(settings.DATABASE_URL)
    # ... ve gercekten PROVISION EDILEN dosya mi?
    assert_test_db_matches_requested_path(settings.DATABASE_URL)

    import asyncio
    from backend.app.core.database import engine
    from backend.app.core.migrations import (
        ensure_campaigns_columns,
        ensure_quick_replies_table,
        ensure_whatsapp_data_audit_table,
        ensure_whatsapp_connect_stages_table,
        ensure_messages_media_columns,
        ensure_api_keys_and_webhooks_tables,
        ensure_subscription_and_quota_tables,
        ensure_task_queue_table,
        ensure_whatsapp_sessions_warmup_columns,
        ensure_system_settings_value_json,
        ensure_leads_enrichment_columns,
    )
    async def _run():
        await ensure_campaigns_columns(engine)
        await ensure_quick_replies_table(engine)
        await ensure_whatsapp_data_audit_table(engine)
        await ensure_whatsapp_connect_stages_table(engine)
        await ensure_messages_media_columns(engine)
        await ensure_api_keys_and_webhooks_tables(engine)
        await ensure_subscription_and_quota_tables(engine)
        await ensure_task_queue_table(engine)
        await ensure_whatsapp_sessions_warmup_columns(engine)
        await ensure_system_settings_value_json(engine)
        await ensure_leads_enrichment_columns(engine)

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
