"""Test paketinin UZAK bir veritabanina baglanmasini engelleyen muhafiz.

`backend/tests/conftest.py` icindeki `run_db_migrations` fixture'i autouse ve
session kapsamlidir: `settings.DATABASE_URL` neyi gosteriyorsa ona karsi
migration calistirir. Yerelde bu bir SQLite dosyasidir. Ama kabukta kalmis bir
`DATABASE_URL=postgresql+asyncpg://...@uretim/...` ile `pytest` calistirmak
sessizce URETIM semasina migration uygulardi.

Bu dosya o kuralin kagitta degil kodda oldugunu pinler. Testler yalnizca saf
fonksiyonu cagirir; hicbir veritabanina baglanmaz.
"""

import importlib.util
import pathlib

import pytest

_CONFTEST = pathlib.Path(__file__).resolve().parent / "conftest.py"


def _load_conftest():
    spec = importlib.util.spec_from_file_location(
        "tezlify_tests_conftest_probe", _CONFTEST
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_local_sqlite_is_allowed() -> None:
    guard = _load_conftest().assert_test_db_is_not_remote
    guard("sqlite+aiosqlite:///./tezlify.db")
    guard("sqlite+aiosqlite:///:memory:")
    guard("")


def test_localhost_postgres_is_allowed() -> None:
    """Yerel bir Postgres'e karsi kosmak mesru olabilir — engellenmez."""
    guard = _load_conftest().assert_test_db_is_not_remote
    guard("postgresql+asyncpg://tezlify:secret@localhost:5432/tezlify_test")
    guard("postgresql+asyncpg://tezlify:secret@127.0.0.1:5432/tezlify_test")


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+asyncpg://tezlify:secret@130.162.247.20:5432/tezlify",
        "postgresql+asyncpg://tezlify:secret@db.internal:5432/tezlify",
        "mysql+aiomysql://user:pw@prod-db.example.com/app",
    ],
)
def test_remote_database_is_refused(url: str) -> None:
    guard = _load_conftest().assert_test_db_is_not_remote
    with pytest.raises(RuntimeError) as excinfo:
        guard(url)
    assert "uzak bir veritabanina" in str(excinfo.value)


def test_remote_database_can_be_allowed_explicitly(monkeypatch) -> None:
    """Kacis yolu tek ve ACIK olmali; kazara degil, bilincli."""
    monkeypatch.setenv("TEZLIFY_TEST_DB_REMOTE_OK", "1")
    guard = _load_conftest().assert_test_db_is_not_remote
    guard("postgresql+asyncpg://tezlify:secret@130.162.247.20:5432/tezlify")


def test_the_guard_runs_before_any_connection_is_made() -> None:
    """Fixture govdesinde muhafiz, `engine` import'undan ONCE cagrilmali."""
    source = _CONFTEST.read_text(encoding="utf-8")
    fixture_at = source.find("def run_db_migrations():")
    assert fixture_at != -1
    guard_at = source.find("assert_test_db_is_not_remote(settings.DATABASE_URL)", fixture_at)
    engine_at = source.find("from backend.app.core.database import engine", fixture_at)
    assert guard_at != -1, "session fixture'i hedef DB'yi hic dogrulamiyor"
    assert engine_at != -1
    assert guard_at < engine_at, (
        "muhafiz engine kurulduktan SONRA cagriliyor; baglanti onceden acilmis olabilir"
    )
