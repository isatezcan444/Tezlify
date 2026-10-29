"""`persistence_flag_guard.py` — kalicilastirma kill-switch karar kapisi testleri.

Baglam (Asama 3.8 / 3.8.1): adacik container'in environment'i CANLI
container'dan kopyalaniyor, `.env.production`dan degil. Flag canlida yoksa ve
kodun varsayilani `True` ise adacik, izole DB uzerinde dahi otomatik
kalicilastirmayi baslatiyordu. Cozum dokumantasyon degil, test edilebilir bir
kapidir.

Bu dosya kapiyi UC ayri duzlemde dogrular:

  1. `parse_flag`  — hangi yazimlarin hangi degere cozuldugu,
  2. `evaluate`    — hangi durumun IZIN/RED oldugu (fail-closed yonu),
  3. CLI           — gercek cikis kodlari ve "deger sizdirmama" sozu.

Hicbir test aga cikmaz, DB'ye baglanmaz, uretim dosyasini okumaz.
"""

import importlib.util
import pathlib

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TOOL_PATH = _REPO_ROOT / "scripts" / "deploy" / "persistence_flag_guard.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location(
        "deploy_persistence_flag_guard", _TOOL_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = _load_tool()
FLAG = tool.FLAG


# ---------------------------------------------------------------------------
# parse_flag — yazim cesitliligi
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("raw", ["true", "TRUE", "True", "1", "yes", "on", "y", "t", " true "])
def test_parse_true_variants(raw):
    assert tool.parse_flag(raw) is True


@pytest.mark.parametrize("raw", ["false", "FALSE", "False", "0", "no", "off", "n", "f", "false "])
def test_parse_false_variants(raw):
    assert tool.parse_flag(raw) is False


def test_parse_strips_quotes():
    """`.env.production` tirnakli deger icerebilir; compose tirnagi soyar."""
    assert tool.parse_flag('"true"') is True
    assert tool.parse_flag("'false'") is False


def test_parse_bool_passthrough():
    assert tool.parse_flag(True) is True
    assert tool.parse_flag(False) is False


@pytest.mark.parametrize("raw", ["truely", "evet", "2", "", "   ", "enable", "yep", None])
def test_parse_unparseable_is_none(raw):
    """Cozulemeyen deger `None` donmeli — `False` degil.

    `None` "bilinmiyor" demektir ve cagiran onu RED olarak yorumlar. Burada
    `False` dondurmek, `truely` gibi bir yazimi sessizce "kapali" saymak olurdu.
    """
    assert tool.parse_flag(raw) is None


# ---------------------------------------------------------------------------
# evaluate — fail-closed yonu
# ---------------------------------------------------------------------------
def test_absent_flag_is_allowed_by_default():
    """Yokluk = kapali: kodun varsayilani artik `False`."""
    allowed, reason = tool.evaluate({})
    assert allowed is True
    assert reason == "flag_absent_defaults_off"


def test_absent_flag_is_denied_when_explicit_false_required():
    """Adacikta 'yokluk' yetmez: kapali oldugu ACIKCA yazilmali."""
    allowed, reason = tool.evaluate({}, require_explicit_false=True)
    assert allowed is False
    assert reason == "flag_absent_but_explicit_false_required"


def test_explicit_false_is_allowed():
    allowed, reason = tool.evaluate({FLAG: "false"})
    assert allowed is True
    assert reason == "flag_explicitly_false"


def test_explicit_false_satisfies_candidate_requirement():
    allowed, _ = tool.evaluate({FLAG: "false"}, require_explicit_false=True)
    assert allowed is True


def test_explicit_true_is_denied():
    allowed, reason = tool.evaluate({FLAG: "true"})
    assert allowed is False
    assert reason == "flag_true_not_allowed"


def test_explicit_true_is_allowed_only_with_opt_in():
    allowed, reason = tool.evaluate({FLAG: "true"}, allow_enabled=True)
    assert allowed is True
    assert reason == "flag_true_explicitly_allowed"


def test_unparseable_is_denied():
    """Cozulemeyen deger 'belki acik' sayilir; otomatik yazma baslatilmaz."""
    allowed, reason = tool.evaluate({FLAG: "truely"})
    assert allowed is False
    assert reason == "flag_unparseable"


def test_unparseable_is_denied_even_with_opt_in():
    """`--allow-enabled` yalnizca ACIK `true` icindir, cop deger icin degil."""
    allowed, _ = tool.evaluate({FLAG: "evet"}, allow_enabled=True)
    assert allowed is False


def test_empty_value_is_denied():
    allowed, _ = tool.evaluate({FLAG: ""})
    assert allowed is False


# ---------------------------------------------------------------------------
# read_env_file — ayristirma
# ---------------------------------------------------------------------------
def test_read_env_file_parses_comments_quotes_and_export(tmp_path):
    p = tmp_path / "env"
    p.write_text(
        "\n".join(
            [
                "# yorum satiri",
                "OTHER=deger",
                f'{FLAG}="false"',
                "export ANOTHER=1",
                "BOZUK_SATIR",
            ]
        ),
        encoding="utf-8",
    )
    env = tool.read_env_file(str(p))
    assert env[FLAG] == '"false"'
    assert env["OTHER"] == "deger"
    assert env["ANOTHER"] == "1"
    assert "BOZUK_SATIR" not in env
    # Deger okunurken tirnak soyulur.
    assert tool.parse_flag(env[FLAG]) is False


def test_read_env_file_last_wins(tmp_path):
    """Ayni anahtar iki kez yazilirsa SON satir gecerli olmali (compose gibi)."""
    p = tmp_path / "env"
    p.write_text(f"{FLAG}=true\n{FLAG}=false\n", encoding="utf-8")
    assert tool.parse_flag(tool.read_env_file(str(p))[FLAG]) is False


# ---------------------------------------------------------------------------
# CLI — gercek cikis kodlari
# ---------------------------------------------------------------------------
def _write(tmp_path, content):
    p = tmp_path / "env"
    p.write_text(content, encoding="utf-8")
    return str(p)


def test_cli_returns_zero_for_absent_flag(tmp_path, capsys):
    assert tool.main(["--env-file", _write(tmp_path, "OTHER=1\n")]) == 0
    out = capsys.readouterr().out
    assert "IZINLI" in out


def test_cli_returns_one_for_true(tmp_path, capsys):
    assert tool.main(["--env-file", _write(tmp_path, f"{FLAG}=true\n")]) == 1
    assert "RED" in capsys.readouterr().out


def test_cli_returns_one_for_unparseable(tmp_path):
    assert tool.main(["--env-file", _write(tmp_path, f"{FLAG}=evet\n")]) == 1


def test_cli_require_explicit_false_rejects_absent(tmp_path):
    assert (
        tool.main(
            ["--env-file", _write(tmp_path, "OTHER=1\n"), "--require-explicit-false"]
        )
        == 1
    )


def test_cli_returns_two_for_missing_file(tmp_path):
    assert tool.main(["--env-file", str(tmp_path / "yok")]) == 2


def test_cli_never_prints_other_values(tmp_path, capsys):
    """Sizinti sozu: cikti yalnizca karar + sabit gerekce olmali."""
    secret = "super-gizli-deger-123"
    tool.main(["--env-file", _write(tmp_path, f"DATABASE_URL={secret}\n{FLAG}=false\n")])
    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err


# ---------------------------------------------------------------------------
# host-release.sh kablolamasi — kapi betikte GERCEKTEN cagriliyor mu?
# ---------------------------------------------------------------------------
# Bir guvenlik kapisinin en tehlikeli hali, var olup cagrilmamasidir. Bu
# yapisal pinler, kablolamanin sessizce kaldirilmasini engeller. Betigi
# CALISTIRMAZLAR; yalnizca metnini okurlar.
_HOST_RELEASE = _REPO_ROOT / "scripts" / "deploy" / "host-release.sh"


def _host_src() -> str:
    return _HOST_RELEASE.read_text(encoding="utf-8")


def test_host_release_forces_candidate_flag_off_explicitly():
    src = _host_src()
    assert "-e WHATSAPP_MEMORY_PERSIST_ENABLED=false" in src, (
        "adacik container'a flag acikca false verilmeli; env'i canlidan devraliyor"
    )
    assert "--require-explicit-false" in src, (
        "adacikta 'yokluk' yetmez; acikca false aranmali"
    )


def test_host_release_gate_runs_before_candidate_start():
    """Kapi, `docker run`dan ONCE kosmali — sonra kosarsa container zaten acilmis olur."""
    src = _host_src()
    gate = src.index("--require-explicit-false")
    start = src.index('docker run -d --name "$CANDIDATE_NAME"')
    assert gate < start, "kill-switch kontrolu adacik baslamadan once kosmali"


def test_host_release_refuses_when_guard_is_missing():
    """Muhafiz yoksa 'atla' degil, 'deploy etme' demeli."""
    src = _host_src()
    assert "persistence_flag_guard.py bulunamadi" in src
    marker = src.index("persistence_flag_guard.py bulunamadi")
    # Ayni satirda `die` olmali: uyari verip devam eden bir dal kabul edilmez.
    line_start = src.rfind("\n", 0, marker) + 1
    line_end = src.find("\n", marker)
    assert "die" in src[line_start:line_end]


def test_host_release_checks_effective_value_after_cutover():
    """Sozlesme dosyaya degil, CALISAN surece dayanmali."""
    src = _host_src()
    assert "persist_flag_effective" in src
    assert '"$EFFECTIVE_PERSIST" != "false"' in src


def test_host_release_checks_production_env_before_cutover():
    """Cutover'dan ONCE .env.production kontrol edilmeli."""
    src = _host_src()
    env_check = src.index('--env-file "$ENV_PROD_FILE"')
    cutover = src.index('log "cutover: compose up -d --force-recreate')
    assert env_check < cutover, "uretim env kontrolu cutover'dan once kosmali"
