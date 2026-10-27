"""Yikici migration muhafizi — deploy'un veri kaybettirmedigini kanitlayan testler.

Baglam: adacik container cutover'dan once URETIM veritabanina karsi tum startup
migration setini calistiriyor ve 2026-10-27'de bir sohbet tam bu pencerede
kayboldu; hangi migration'in sildigi kanitlanamadi cunku adacigin logu
container'la birlikte silinmisti.

Bu dosya `scripts/deploy/migration_guard.py`'yi test eder. Hicbir test bir
veritabanina BAGLANMAZ: guard yalnizca metin (git diff / log) okur. Bu, testin
kendisinin uretim verisine dokunamayacaginin yapisal kanitidir (asagida
`test_guard_has_no_database_dependency` bunu ayrica pinler).
"""

import importlib.util
import pathlib

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_GUARD_PATH = _REPO_ROOT / "scripts" / "deploy" / "migration_guard.py"


def _load_guard():
    spec = importlib.util.spec_from_file_location("deploy_migration_guard", _GUARD_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = _load_guard()


def _diff(added: str, *, removed: str = "", file: str = "backend/app/core/migrations.py") -> str:
    """Kucuk, gercekci bir unified diff uret."""
    return (
        f"diff --git a/{file} b/{file}\n"
        f"index 1111111..2222222 100644\n"
        f"--- a/{file}\n"
        f"+++ b/{file}\n"
        "@@ -1,3 +1,4 @@\n"
        " async def ensure_something(engine):\n"
        "-    return None\n"
        f"{removed}"
        f"+{added}\n"
    )


# ---------------------------------------------------------------------------
# diff taramasi
# ---------------------------------------------------------------------------


def test_additive_migration_is_clean() -> None:
    """Yalnizca EKLEME yapan bir migration onay istememeli."""
    diff = _diff('    await conn.execute(text("CREATE TABLE IF NOT EXISTS foo (id INTEGER)"))')
    assert guard.scan_diff(diff) == []
    assert guard.has_blocking([]) is False


def test_added_delete_from_is_blocking() -> None:
    diff = _diff('    await conn.execute(text("DELETE FROM conversations WHERE id = :id"))')
    findings = guard.scan_diff(diff)
    assert len(findings) == 1
    assert findings[0]["severity"] == "delete"
    assert findings[0]["label"] == "DELETE FROM"
    assert findings[0]["file"] == "backend/app/core/migrations.py"
    assert guard.has_blocking(findings) is True


@pytest.mark.parametrize(
    "sql,label",
    [
        ("DELETE FROM messages WHERE conversation_id IN (1)", "DELETE FROM"),
        ("TRUNCATE TABLE messages", "TRUNCATE"),
        ("DROP TABLE leads", "DROP TABLE"),
        ("ALTER TABLE contacts DROP COLUMN whatsapp_profile_name", "DROP COLUMN"),
    ],
)
def test_every_row_loss_shape_is_blocking(sql: str, label: str) -> None:
    findings = guard.scan_diff(_diff(f'    await conn.execute(text("{sql}"))'))
    assert any(f["label"] == label and f["severity"] == "delete" for f in findings), findings


def test_removing_a_delete_statement_is_not_destructive() -> None:
    """Yikiciligi KALDIRAN bir degisiklik engellenmemeli.

    Bir `-` satirini da tarayan bir muhafiz, tam da guvenligi artiran commit'i
    reddederdi.
    """
    diff = _diff(
        '    return 0',
        removed='-    await conn.execute(text("DELETE FROM conversations"))\n',
    )
    assert guard.scan_diff(diff) == []


def test_context_lines_are_not_scanned() -> None:
    """Degismemis govdedeki DELETE her deploy'da alarm uretmemeli."""
    diff = (
        "diff --git a/backend/app/core/migrations.py b/backend/app/core/migrations.py\n"
        "--- a/backend/app/core/migrations.py\n"
        "+++ b/backend/app/core/migrations.py\n"
        "@@ -1,3 +1,3 @@\n"
        '     await conn.execute(text("DELETE FROM conversations WHERE x = 1"))\n'
        "-    logger.info('a')\n"
        "+    logger.info('b')\n"
    )
    assert guard.scan_diff(diff) == []


def test_update_is_reported_but_does_not_block() -> None:
    """`backfill_*` onarimlari her acilista calisir; engellemek muhafizi olu kilar."""
    findings = guard.scan_diff(_diff("    await conn.execute(text(\"UPDATE conversations SET last_message_preview = 'x'\"))"))
    assert len(findings) == 1
    assert findings[0]["severity"] == "transform"
    assert guard.has_blocking(findings) is False


def test_drop_index_is_out_of_scope() -> None:
    """`ensure_phase_10_7_indexes` rutin olarak indeks dusurur; bu veri kaybi degildir."""
    assert guard.scan_diff(_diff('    await conn.execute(text("DROP INDEX IF EXISTS idx_x"))')) == []


# ---------------------------------------------------------------------------
# log taramasi
# ---------------------------------------------------------------------------


def test_log_names_the_ghost_purge() -> None:
    log = (
        "2026-10-27 19:04:43,062 - backend.app.core.migrations - INFO - "
        "[MIGRATION] purge_empty_ghost_conversations: 1 aktivitesiz bos sohbet temizlendi.\n"
    )
    findings = guard.scan_log(log)
    assert [f["kind"] for f in findings] == ["ghost_purge"]


def test_log_names_a_contact_merge() -> None:
    log = "[MIGRATION] contacts tekillestirme: 2 mukerrer kisi birlestirildi, 1 fazla sohbet kapatildi.\n"
    kinds = {f["kind"] for f in guard.scan_log(log)}
    assert "contact_merge" in kinds


def test_clean_boot_log_has_no_findings() -> None:
    """Saglikli acilis 'verified' satirlarindan olusur; hicbiri silme degildir."""
    log = "\n".join(
        f"[MIGRATION] ensure_{name} verified" for name in ("contacts_table", "messages_media_columns")
    )
    log += "\n[MIGRATION] ensure_whatsapp_data_audit_table ALREADY_PRESENT\n"
    assert guard.scan_log(log) == []


# ---------------------------------------------------------------------------
# CLI ve yapisal garantiler
# ---------------------------------------------------------------------------


def test_cli_diff_on_an_identical_range_is_clean() -> None:
    """base == target -> bos diff -> exit 0 (gercek repo, salt okunur)."""
    head = _git_head()
    assert guard.main(["diff", "--repo", str(_REPO_ROOT), "--base", head, "--target", head]) == 0


def test_cli_diff_json_shape(capsys) -> None:
    head = _git_head()
    assert guard.main(
        ["diff", "--repo", str(_REPO_ROOT), "--base", head, "--target", head, "--json"]
    ) == 0
    payload = capsys.readouterr().out.strip()
    assert payload.startswith("{")
    assert '"findings": []' in payload.replace("  ", "")


def test_cli_log_missing_file_is_not_an_error(tmp_path) -> None:
    """Log yakalanamadi diye deploy durmamali — kanit eksikligi, engel degil."""
    assert guard.main(["log", "--file", str(tmp_path / "yok.log")]) == 0


def test_guard_has_no_database_dependency() -> None:
    """Yapisal kanit: muhafiz hicbir DB surucusune baglanamaz."""
    source = _GUARD_PATH.read_text(encoding="utf-8")
    for forbidden in ("sqlalchemy", "asyncpg", "aiosqlite", "psycopg", "DATABASE_URL"):
        assert forbidden not in source, f"guard {forbidden} referansi icermemeli"


def _git_head() -> str:
    import subprocess

    return subprocess.run(
        ["git", "-C", str(_REPO_ROOT), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
