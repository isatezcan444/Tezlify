"""Backend-only release ref'i dogrulamasinin testleri.

Baglam (Asama 3.7): `host-release.sh --no-gateway`, yayindaki commit ile hedef
arasinda gateway/compose degismisse deploy'u reddeder. `main` uzerinde gateway
degisikligi oldugu icin backend-only dagitim "imkansiz" gorunuyordu.

Cozum muhafizi zayiflatmak degil, muhafizin aradigi kosulu gercekten saglayan
bir release ref'i uretmek. Bu dosya, ref'i dogrulayan betigin o kosulu DOGRU
degerlendirdigini kanitlar — ve en onemlisi: gateway degisikligi tasiyan bir
ref'i **reddettigini**.

Hicbir test git deposuna yazmaz, veritabanina baglanmaz, aga cikmaz. `evaluate`
saf fonksiyondur; CLI testleri yalnizca gercek depoda `rev-parse`/`diff` okur.
"""

import importlib.util
import pathlib
import subprocess

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TOOL_PATH = _REPO_ROOT / "scripts" / "deploy" / "backend_only_release.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("deploy_backend_only_release", _TOOL_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = _load_tool()


# ---------------------------------------------------------------------------
# gateway_touching — host-release.sh muhafizinin kapsamiyla AYNI olmali
# ---------------------------------------------------------------------------
def test_gateway_prefix_is_detected():
    assert tool.gateway_touching(["whatsapp-gateway/src/index.js"]) == [
        "whatsapp-gateway/src/index.js"
    ]


def test_nested_gateway_file_is_detected():
    assert tool.gateway_touching(
        ["whatsapp-gateway/scripts/test-history-diagnostics.mjs"]
    ) == ["whatsapp-gateway/scripts/test-history-diagnostics.mjs"]


def test_compose_files_are_detected():
    got = tool.gateway_touching(["docker-compose.yml", "docker-compose.prod.yml"])
    assert got == ["docker-compose.prod.yml", "docker-compose.yml"]


def test_backend_and_docs_are_not_gateway():
    assert tool.gateway_touching(
        [
            "backend/app/services/whatsapp/memory_persistence.py",
            "docs/audits/x.md",
            "scripts/deploy/host-release.sh",
            ".workbuddy-ai/memory/MEMORY.md",
        ]
    ) == []


def test_lookalike_prefix_is_not_gateway():
    """`whatsapp-gateway-docs/` gibi bir yol gateway sayilmamali (prefix sinir)."""
    assert tool.gateway_touching(["whatsapp-gateway-docs/readme.md"]) == []


def test_empty_and_blank_paths_are_ignored():
    assert tool.gateway_touching(["", "   ", "\n"]) == []


# ---------------------------------------------------------------------------
# evaluate — karar mantigi
# ---------------------------------------------------------------------------
def test_clean_ref_is_approved():
    assert (
        tool.evaluate(
            gateway_changes=[],
            backend_vs_main=[],
            backend_vs_base=["backend/app/main.py"],
        )
        == []
    )


def test_gateway_change_is_rejected():
    problems = tool.evaluate(
        gateway_changes=["whatsapp-gateway/src/index.js"],
        backend_vs_main=[],
        backend_vs_base=["backend/app/main.py"],
    )
    assert len(problems) == 1
    assert "--no-gateway muhafizi REDDEDER" in problems[0]


def test_compose_change_is_rejected():
    problems = tool.evaluate(
        gateway_changes=["docker-compose.prod.yml"],
        backend_vs_main=[],
        backend_vs_base=["backend/app/main.py"],
    )
    assert problems and "REDDEDER" in problems[0]


def test_ref_missing_mains_backend_is_rejected():
    """Release ref'i main'deki duzeltmeyi tasimiyorsa sessiz gerileme olurdu."""
    problems = tool.evaluate(
        gateway_changes=[],
        backend_vs_main=["backend/app/services/whatsapp/memory_persistence.py"],
        backend_vs_base=["backend/app/main.py"],
    )
    assert len(problems) == 1
    assert "main'in backend agacini tasimiyor" in problems[0]


def test_empty_release_is_rejected():
    problems = tool.evaluate(
        gateway_changes=[],
        backend_vs_main=[],
        backend_vs_base=[],
    )
    assert len(problems) == 1
    assert "dagitilacak backend degisikligi yok" in problems[0]


def test_all_three_violations_are_reported_together():
    problems = tool.evaluate(
        gateway_changes=["whatsapp-gateway/src/session-manager.js"],
        backend_vs_main=["backend/app/main.py"],
        backend_vs_base=[],
    )
    assert len(problems) == 3


def test_release_command_uses_no_gateway():
    cmd = tool.release_command("abc1234", health_timeout=240)
    assert "--no-gateway" in cmd
    assert "abc1234" in cmd
    assert "--health-timeout 240" in cmd


# ---------------------------------------------------------------------------
# Yapisal pinler — bu betik bir bypass ARACI olmamali
# ---------------------------------------------------------------------------
def test_tool_does_not_import_database_or_network_clients():
    """Betik yalnizca `git` okur. DB/ag istemcisi import ederse sinir asilmis olur."""
    src = _TOOL_PATH.read_text(encoding="utf-8")
    forbidden = [
        "import psycopg",
        "import sqlalchemy",
        "from sqlalchemy",
        "import requests",
        "import httpx",
        "import asyncpg",
        "import socket",
        "docker ",
    ]
    for token in forbidden:
        assert token not in src, f"beklenmeyen bagimlilik: {token}"


def test_tool_never_edits_host_release_script():
    """Muhafiz zayiflatilmiyor: betik host-release.sh'i yazmaz/degistirmez."""
    src = _TOOL_PATH.read_text(encoding="utf-8")
    assert "host-release.sh" in src  # yalnizca komut metninde gecer
    for mutation in ["open(", ".write(", "shutil", "os.remove", "subprocess.run([\"bash\""]:
        assert mutation not in src, f"betik dosya/komut degistiriyor olabilir: {mutation}"


def test_host_release_guard_is_still_present_and_unchanged_in_shape():
    """`--no-gateway` muhafizi yerinde: kaldirilmadi, gevsetilmedi."""
    sh = (_REPO_ROOT / "scripts" / "deploy" / "host-release.sh").read_text(encoding="utf-8")
    assert "--no-gateway kullanilamaz: gateway/compose degismis" in sh
    assert "whatsapp-gateway/" in sh
    assert 'if [ "$NO_GATEWAY" = "1" ]; then' in sh


# ---------------------------------------------------------------------------
# Gercek depo uzerinde CLI davranisi (yalnizca okuma)
# ---------------------------------------------------------------------------
def _git(*args):
    return subprocess.run(
        ["git", *args], cwd=_REPO_ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()


def _has_ref(ref: str) -> bool:
    res = subprocess.run(
        ["git", "rev-parse", "--verify", f"{ref}^{{commit}}"],
        cwd=_REPO_ROOT, capture_output=True, text=True,
    )
    return res.returncode == 0


@pytest.mark.skipif(
    not _has_ref("b5715fe"), reason="karsilastirma tabani (b5715fe) bu checkout'ta yok"
)
def test_cli_rejects_main_because_it_touches_the_gateway(capsys):
    """`main` backend-only olarak dagitilamaz — muhafiz hakli olarak reddeder."""
    rc = tool.main(["--base", "b5715fe", "--target", "main", "--backend-from", "main"])
    out = capsys.readouterr()
    assert rc == 1
    assert "REDDEDER" in out.err


@pytest.mark.skipif(
    not _has_ref("b5715fe"), reason="karsilastirma tabani (b5715fe) bu checkout'ta yok"
)
def test_cli_reports_a_gateway_free_range_as_clean(capsys):
    """Gateway'e dokunmayan bir aralik (base..base) teknik olarak temiz sayilir.

    Bos release oldugu icin yine de reddedilir — ama sebep gateway DEGILDIR.
    Bu, iki ihlalin birbirine karismadigini gosterir.
    """
    rc = tool.main(["--base", "b5715fe", "--target", "b5715fe", "--backend-from", "b5715fe"])
    out = capsys.readouterr()
    assert rc == 1
    assert "REDDEDER" not in out.err
    assert "dagitilacak backend degisikligi yok" in out.err
