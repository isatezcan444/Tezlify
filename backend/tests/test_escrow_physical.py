"""`escrow_physical.py` — fiziksel escrow kopyasi guvenlik testleri.

Neden bu testler var: bu aracin tum degeri "anahtari gostermemesi" uzerine
kurulu. Bir dogrulama araci anahtari hata mesajina koyarsa, arac kendi amacini
yok eder. Bu yuzden burada islevsellik kadar **sizdirmama** da test edilir:

* anahtar `anchor`/`verify` ciktisinda GECMIYOR mu,
* hata mesajlari girdiyi yansitmiyor mu,
* `sheet` bayraksiz calisinca anahtar basmiyor mu,
* yanlis anahtar reddediliyor mu,
* buyuk/kucuk harf ve bosluk normalizasyonu beklendigi gibi mi,
* gecersiz uzunluk/karakter reddediliyor mu,
* cikis kodlari belgelenen sozlesmeyle uyumlu mu,
* dosyaya yazma yolu (`--out`) YOK mu.

Testler sentetiktir: gercek anahtar, gercek escrow dosyasi, ag veya DB yok.
"""
import importlib.util
import io
import pathlib

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TOOL_PATH = _REPO_ROOT / "scripts" / "backup" / "escrow_physical.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("backup_escrow_physical", _TOOL_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = _load_tool()

# Sentetik, gercek anahtarla ilgisi olmayan 64 karakterlik kucuk-hex.
KEY = "0123456789abcdef" * 4
KEY_OTHER = "0123456789abcdef" * 3 + "0123456789abcdee"


def run(argv, *, stdin_text=None, monkeypatch=None):
    """main()'i cagirir; (rc, stdout, stderr) dondurur."""
    out, err = io.StringIO(), io.StringIO()
    if stdin_text is not None:
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_text))
    monkeypatch.setattr("sys.stdout", out)
    monkeypatch.setattr("sys.stderr", err)
    try:
        rc = tool.main(argv)
    except SystemExit as exc:  # fail() bu yolu kullanir
        rc = exc.code if isinstance(exc.code, int) else 1
    return rc, out.getvalue(), err.getvalue()


def write_key(tmp_path, text):
    p = tmp_path / "k.txt"
    p.write_text(text, encoding="utf-8")
    return str(p)


# --------------------------------------------------------------- temel sozlesme
def test_exit_code_constants_are_documented():
    assert tool.EXIT_MISMATCH == 1
    assert tool.EXIT_BAD_INPUT == 2


def test_key_must_be_64_lowercase_hex():
    assert tool.normalize(KEY) == KEY
    assert len(tool.normalize(KEY)) == 64


def test_anchor_is_eight_hex_chars():
    a = tool.anchor8(KEY)
    assert len(a) == 8
    assert all(c in "0123456789abcdef" for c in a)


def test_anchor_is_stable():
    assert tool.anchor8(KEY) == tool.anchor8(KEY)


def test_different_keys_give_different_anchors():
    assert tool.anchor8(KEY) != tool.anchor8(KEY_OTHER)


# ------------------------------------------------------------- normalizasyon
def test_prefix_is_stripped():
    assert tool.normalize("TEZLIFY_KEY_V2=" + KEY) == KEY


def test_uppercase_is_normalised():
    assert tool.normalize(KEY.upper()) == KEY


def test_surrounding_whitespace_and_newlines_are_ignored():
    assert tool.normalize("  \n" + KEY + "\n\n  ") == KEY


def test_prefixed_uppercase_with_newline_normalises(tmp_path):
    text = "TEZLIFY_RAM_KEY_V2=" + KEY.upper() + "\n"
    assert tool.normalize(text) == KEY


def test_normalisation_does_not_accept_short_key():
    with pytest.raises(SystemExit) as exc:
        tool.normalize(KEY[:63])
    assert exc.value.code == tool.EXIT_BAD_INPUT


def test_normalisation_does_not_accept_long_key():
    with pytest.raises(SystemExit) as exc:
        tool.normalize(KEY + "ab")
    assert exc.value.code == tool.EXIT_BAD_INPUT


def test_normalisation_rejects_non_hex():
    bad = "z" * 64
    with pytest.raises(SystemExit) as exc:
        tool.normalize(bad)
    assert exc.value.code == tool.EXIT_BAD_INPUT


def test_normalisation_rejects_empty():
    with pytest.raises(SystemExit) as exc:
        tool.normalize("   \n  ")
    assert exc.value.code == tool.EXIT_BAD_INPUT


# ----------------------------------------------------- anahtar SIZDIRMIYOR mu
def test_anchor_output_does_not_contain_the_key(tmp_path, monkeypatch):
    rc, out, err = run(
        ["anchor", "--from-file", write_key(tmp_path, KEY)], monkeypatch=monkeypatch
    )
    assert rc == 0
    assert KEY not in out and KEY not in err
    assert tool.anchor8(KEY) in out


def test_verify_match_output_does_not_contain_the_key(tmp_path, monkeypatch):
    rc, out, err = run(
        ["verify", "--expect", tool.anchor8(KEY), "--from-file", write_key(tmp_path, KEY)],
        monkeypatch=monkeypatch,
    )
    assert rc == 0
    assert "MATCH" in out
    assert KEY not in out and KEY not in err


def test_verify_mismatch_output_does_not_contain_the_key(tmp_path, monkeypatch):
    rc, out, err = run(
        ["verify", "--expect", tool.anchor8(KEY_OTHER), "--from-file", write_key(tmp_path, KEY)],
        monkeypatch=monkeypatch,
    )
    assert rc == tool.EXIT_MISMATCH
    assert "MISMATCH" in out
    assert KEY not in out and KEY not in err


def test_wrong_key_is_rejected(tmp_path, monkeypatch):
    """Yanlis anahtar MATCH uretemez — capa farkli oldugu icin."""
    rc, out, _ = run(
        ["verify", "--expect", tool.anchor8(KEY), "--from-file", write_key(tmp_path, KEY_OTHER)],
        monkeypatch=monkeypatch,
    )
    assert rc == tool.EXIT_MISMATCH
    assert "SONUC    = MISMATCH" in out


def test_error_message_never_echoes_the_input(tmp_path, monkeypatch):
    """Gecersiz girdi reddedilirken girdinin kendisi basilMAMALI."""
    secret_looking = "s" * 64  # 64 karakter ama hex degil
    rc, out, err = run(
        ["anchor", "--from-file", write_key(tmp_path, secret_looking)],
        monkeypatch=monkeypatch,
    )
    assert rc == tool.EXIT_BAD_INPUT
    assert secret_looking not in out and secret_looking not in err
    # Yalnizca uzunluk raporlanir.
    assert "64" in err


def test_short_input_error_does_not_echo_input(tmp_path, monkeypatch):
    rc, out, err = run(
        ["anchor", "--from-file", write_key(tmp_path, "cok-kisa-ama-gizli")],
        monkeypatch=monkeypatch,
    )
    assert rc == tool.EXIT_BAD_INPUT
    assert "cok-kisa-ama-gizli" not in out and "cok-kisa-ama-gizli" not in err


# ------------------------------------------------------------------- sheet
def test_sheet_refuses_without_operator_flag(tmp_path, monkeypatch):
    rc, out, err = run(
        ["sheet", "--from-file", write_key(tmp_path, KEY)], monkeypatch=monkeypatch
    )
    assert rc == tool.EXIT_BAD_INPUT
    assert KEY not in out and KEY not in err
    assert "REDDEDILDI" in out


def test_sheet_with_flag_prints_key_grouped(tmp_path, monkeypatch):
    rc, out, _ = run(
        ["sheet", "--i-am-the-operator", "--from-file", write_key(tmp_path, KEY)],
        monkeypatch=monkeypatch,
    )
    assert rc == 0
    # 16 grup x 4 karakter, bosluksuz yeniden birlestirilebilir.
    assert "1:0123" in out and "16:cdef" in out
    assert tool.anchor8(KEY) in out
    assert "ANAHTAR" in out


def test_sheet_warns_about_leakage(tmp_path, monkeypatch):
    rc, out, _ = run(
        ["sheet", "--i-am-the-operator", "--from-file", write_key(tmp_path, KEY)],
        monkeypatch=monkeypatch,
    )
    assert rc == 0
    assert "anahtari ICERIR" in out


# --------------------------------------------------------------- stdin yolu
def test_stdin_source_works(monkeypatch):
    rc, out, _ = run(["anchor", "--stdin"], stdin_text=KEY, monkeypatch=monkeypatch)
    assert rc == 0
    assert tool.anchor8(KEY) in out
    assert KEY not in out


def test_stdin_prefix_form_works(monkeypatch):
    rc, out, _ = run(
        ["anchor", "--stdin"], stdin_text="ONEK=" + KEY.upper() + "\n", monkeypatch=monkeypatch
    )
    assert rc == 0
    assert tool.anchor8(KEY) in out


def test_missing_source_is_rejected(monkeypatch):
    rc, _, err = run(["anchor"], monkeypatch=monkeypatch)
    assert rc == tool.EXIT_BAD_INPUT
    assert "kaynak belirtilmedi" in err


# --------------------------------------------------------- yazma yolu YOK
def test_tool_accepts_no_out_argument(monkeypatch):
    """Anahtari dosyaya yazdiran bir yol BILEREK yok."""
    rc, _, err = run(["anchor", "--out", "/tmp/x"], stdin_text=KEY, monkeypatch=monkeypatch)
    assert rc != 0
    assert "unrecognized arguments" in err


def test_tool_module_exposes_no_file_writer():
    names = {n for n in dir(tool) if callable(getattr(tool, n))}
    assert "write_key" not in names
    assert "dump" not in names


def test_malformed_expect_is_rejected(tmp_path, monkeypatch):
    rc, _, err = run(
        ["verify", "--expect", "cok-uzun-bir-beklenti", "--from-file", write_key(tmp_path, KEY)],
        monkeypatch=monkeypatch,
    )
    assert rc == tool.EXIT_BAD_INPUT
    assert "8 haneli hex" in err
