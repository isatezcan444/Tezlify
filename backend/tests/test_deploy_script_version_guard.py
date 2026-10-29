"""Asama 3.8.5 — DEPLOY BETIGI SURUM MUHAFIZI testleri.

NEDEN BU DOSYA VAR
------------------
3.8.4'un en onemli bulgusu bir celiskiydi: kalicilastirma kill-switch muhafizi
HEDEF release'te vardi, ama deploy'u calistiran betik ESKI checkout'tan
geliyor olabilirdi. Olculen hal:

    yayindaki b5715fe : host-release.sh icinde persistence_flag_guard -> 0
    hedef     3d3fc79 : ayni dosyada ayni referans                    -> 6

Eski betik kosarsa adaciga `-e ...=false` zorlamasi da, cutover sonrasi
`/health` etkin-deger kontrolu de HIC calismaz; deploy "basarili" gorunur.
Bu dosya o kapinin (a) mantigini, (b) gercek CLI davranisini ve (c) bash
kablolamasini pinler.

Testler aga cikmaz, DB'ye baglanmaz, deploy YAPMAZ. Sentetik depo testleri
`tmp_path` icinde kendi git deposunu kurar; gercek depo testleri yalnizca
`git rev-parse`/`git show` okur.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import shutil
import subprocess

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_DEPLOY_DIR = _REPO_ROOT / "scripts" / "deploy"
_TOOL_PATH = _DEPLOY_DIR / "script_version_guard.py"
_RUN_RELEASE = _DEPLOY_DIR / "run_release.sh"
_HOST_RELEASE = _DEPLOY_DIR / "host-release.sh"

# Yayindaki commit'in betigi — degismez gecmis, karsilastirma tabani.
_DEPLOYED = "b5715fe"
_DEPLOYED_SCRIPT_BLOB = "69da7b3c2e962fffcd420e6f49706baf378a174c"


def _load_tool():
    spec = importlib.util.spec_from_file_location("deploy_script_version_guard", _TOOL_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = _load_tool()


def _git(*args, cwd=None):
    return subprocess.run(
        ["git", *args], cwd=cwd or _REPO_ROOT, capture_output=True, text=True
    )


def _has_commit(ref: str) -> bool:
    return _git("rev-parse", "--verify", f"{ref}^{{commit}}").returncode == 0


# ---------------------------------------------------------------------------
# evaluate — saf karar mantigi
# ---------------------------------------------------------------------------
def test_matching_blob_is_allowed():
    allowed, reason = tool.evaluate(self_blob="aaa", target_blob="aaa")
    assert allowed is True
    assert reason == "script_matches_target"


def test_mismatched_blob_is_denied():
    """Eski betik + yeni hedef (ya da tersi): deploy baslamadan reddedilir."""
    allowed, reason = tool.evaluate(self_blob="aaa", target_blob="bbb")
    assert allowed is False
    assert reason == "script_is_not_target_version"


def test_unreadable_self_is_denied():
    allowed, reason = tool.evaluate(self_blob=None, target_blob="bbb")
    assert allowed is False
    assert reason == "script_blob_unreadable"


def test_script_absent_in_target_is_denied():
    allowed, reason = tool.evaluate(self_blob="aaa", target_blob=None)
    assert allowed is False
    assert reason == "script_absent_in_target"


def test_pin_blob_mismatch_is_denied():
    """`run_release.sh`in pinledigi blob tutmuyorsa: degistirilmis baslatici."""
    allowed, reason = tool.evaluate(
        self_blob="aaa", target_blob="aaa", pinned_blob="ccc"
    )
    assert allowed is False
    assert reason == "script_pin_mismatch"


def test_pin_blob_match_is_allowed():
    allowed, reason = tool.evaluate(
        self_blob="aaa", target_blob="aaa", pinned_blob="aaa"
    )
    assert allowed is True


def test_pin_commit_mismatch_is_denied():
    """Betik baska bir commit icin cikarilmissa hedef commit'e uygulanmaz."""
    allowed, reason = tool.evaluate(
        self_blob="aaa",
        target_blob="aaa",
        pinned_commit="111",
        expected_commit="222",
    )
    assert allowed is False
    assert reason == "script_pin_commit_mismatch"


def test_missing_markers_are_detected():
    assert tool.missing_markers("hicbir sey yok") == tool.REQUIRED_MARKERS
    full = " ".join(tool.REQUIRED_MARKERS)
    assert tool.missing_markers(full) == ()


def test_script_without_security_checks_is_denied():
    """Blob esitligi 'calisan = hedef' der; 'hedef muhafizi tasiyor' DEMEZ."""
    allowed, reason = tool.evaluate(
        self_blob="aaa", target_blob="aaa", script_text="# eski betik, muhafiz yok"
    )
    assert allowed is False
    assert reason == "script_missing_security_checks"


def test_script_with_security_checks_is_allowed():
    allowed, reason = tool.evaluate(
        self_blob="aaa",
        target_blob="aaa",
        script_text=" ".join(tool.REQUIRED_MARKERS),
    )
    assert allowed is True


def test_required_markers_cover_both_kill_switch_calls():
    """Uc isaret, uc ayri kapinin kablo ucudur; biri dusurulurse test patlar."""
    assert "persistence_flag_guard.py" in tool.REQUIRED_MARKERS
    assert "--require-explicit-false" in tool.REQUIRED_MARKERS
    assert "persist_flag_effective" in tool.REQUIRED_MARKERS


# ---------------------------------------------------------------------------
# git yardimcilari — gercek depo, salt okunur
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not _has_commit(_DEPLOYED), reason="b5715fe bu checkout'ta yok")
def test_target_blob_matches_recorded_history():
    """Gecmis bir commit'in blob'u degismez: kontrolun tabani gercekten sabit."""
    assert tool.target_blob(str(_REPO_ROOT), _DEPLOYED) == _DEPLOYED_SCRIPT_BLOB


@pytest.mark.skipif(not _has_commit(_DEPLOYED), reason="b5715fe bu checkout'ta yok")
def test_target_blob_is_none_for_missing_path():
    assert tool.target_blob(str(_REPO_ROOT), _DEPLOYED, "scripts/deploy/yok.py") is None


def test_blob_of_file_matches_git_hash_object(tmp_path):
    p = tmp_path / "x.sh"
    p.write_text("#!/usr/bin/env bash\necho hi\n", encoding="utf-8")
    assert tool.blob_of_file(str(p)) == _git("hash-object", "--", str(p)).stdout.strip()


# ---------------------------------------------------------------------------
# CLI — gercek cikis kodlari
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not _has_commit(_DEPLOYED), reason="b5715fe bu checkout'ta yok")
def test_cli_denies_working_tree_script_for_old_target(tmp_path, capsys):
    """Calisma agacindaki (yeni) betik, eski hedefe karsi REDDEDILIR."""
    rc = tool.main(
        [
            "--repo",
            str(_REPO_ROOT),
            "--self",
            str(_HOST_RELEASE),
            "--target-commit",
            _DEPLOYED,
        ]
    )
    assert rc == 1
    assert "script_is_not_target_version" in capsys.readouterr().out


@pytest.mark.skipif(not _has_commit(_DEPLOYED), reason="b5715fe bu checkout'ta yok")
def test_cli_allows_the_targets_own_script_but_denies_its_missing_markers(tmp_path, capsys):
    """Hedefin KENDI betigi blob olarak esit — ama muhafizlari tasimiyor.

    Bu, iki kontrolun neden AYRI gerektigini gosterir: kimlik dogru olsa bile
    eski bir surum guvenlik kapilarini tasimaz.
    """
    extracted = tmp_path / "host-release.sh"
    blob = _git("show", f"{_DEPLOYED}:scripts/deploy/host-release.sh").stdout
    extracted.write_text(blob, encoding="utf-8")

    rc = tool.main(
        [
            "--repo",
            str(_REPO_ROOT),
            "--self",
            str(extracted),
            "--target-commit",
            _DEPLOYED,
        ]
    )
    assert rc == 1
    assert "script_missing_security_checks" in capsys.readouterr().out

    # Ayni dosya, isaret kontrolu kapatilinca kimlik olarak GECER.
    rc2 = tool.main(
        [
            "--repo",
            str(_REPO_ROOT),
            "--self",
            str(extracted),
            "--target-commit",
            _DEPLOYED,
            "--no-marker-check",
        ]
    )
    assert rc2 == 0


def test_cli_returns_two_for_unresolvable_commit(capsys):
    rc = tool.main(
        [
            "--repo",
            str(_REPO_ROOT),
            "--self",
            str(_HOST_RELEASE),
            "--target-commit",
            "0" * 40,
        ]
    )
    assert rc == 2
    assert "target_commit_unresolved" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# run_release.sh — sentetik depo uzerinde GERCEK davranis
# ---------------------------------------------------------------------------
def _init_repo(tmp_path: pathlib.Path) -> pathlib.Path:
    repo = tmp_path / "repo"
    (repo / "scripts" / "deploy").mkdir(parents=True)
    _git("init", "-q", cwd=repo)
    return repo


def _commit_all(repo: pathlib.Path, message: str) -> str:
    _git("add", "-A", cwd=repo)
    _git(
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        message,
        cwd=repo,
    )
    return _git("rev-parse", "HEAD", cwd=repo).stdout.strip()


def _write_security_scripts(repo: pathlib.Path, *, with_markers: bool) -> None:
    deploy = repo / "scripts" / "deploy"
    shutil.copy2(_TOOL_PATH, deploy / "script_version_guard.py")
    body = "#!/usr/bin/env bash\necho release\n"
    if with_markers:
        body += " ".join(tool.REQUIRED_MARKERS) + " script_version_guard.py\n"
    (deploy / "host-release.sh").write_text(body, encoding="utf-8")


def _run_release(repo: pathlib.Path, *args: str):
    launcher = repo / "scripts" / "deploy" / "run_release.sh"
    env = dict(os.environ)
    env["HOST_RELEASE_REPO"] = str(repo)
    return subprocess.run(
        ["bash", str(launcher), *args],
        cwd=repo,
        capture_output=True,
        text=True,
        env=env,
    )


def test_run_release_verify_only_passes_for_a_compliant_target(tmp_path):
    repo = _init_repo(tmp_path)
    _write_security_scripts(repo, with_markers=True)
    shutil.copy2(_RUN_RELEASE, repo / "scripts" / "deploy" / "run_release.sh")
    _commit_all(repo, "compliant")

    res = _run_release(repo, "--verify-only", "HEAD")
    assert res.returncode == 0, res.stderr + res.stdout
    assert "dogrulama GECTI" in res.stdout


def test_run_release_verify_only_rejects_a_target_without_the_guard(tmp_path):
    """Muhafizi tasimayan surum dagitilamaz — 'atla' degil, 'dur'."""
    repo = _init_repo(tmp_path)
    _write_security_scripts(repo, with_markers=False)
    shutil.copy2(_RUN_RELEASE, repo / "scripts" / "deploy" / "run_release.sh")
    _commit_all(repo, "no guard")

    res = _run_release(repo, "--verify-only", "HEAD")
    assert res.returncode == 9, res.stderr + res.stdout
    assert "script_missing_security_checks" in res.stdout


def test_run_release_rejects_a_target_without_the_version_guard_file(tmp_path):
    repo = _init_repo(tmp_path)
    deploy = repo / "scripts" / "deploy"
    (deploy / "host-release.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    shutil.copy2(_RUN_RELEASE, deploy / "run_release.sh")
    _commit_all(repo, "guard file missing")

    res = _run_release(repo, "--verify-only", "HEAD")
    assert res.returncode == 9
    assert "script_version_guard.py YOK" in res.stderr


def test_run_release_rejects_a_doctored_launcher(tmp_path):
    """Preflight'in yazdirdigi blob pinlenir; eski baslatici kendini reddeder."""
    repo = _init_repo(tmp_path)
    _write_security_scripts(repo, with_markers=True)
    shutil.copy2(_RUN_RELEASE, repo / "scripts" / "deploy" / "run_release.sh")
    _commit_all(repo, "compliant")

    res = _run_release(repo, "--expected-self-blob", "0" * 40, "--verify-only", "HEAD")
    assert res.returncode == 9
    assert "baslatici pinlenen surum degil" in res.stderr


def test_run_release_never_runs_the_target_script_in_verify_only(tmp_path):
    """`--verify-only` hicbir sey CALISTIRMAMALI (deploy yok)."""
    repo = _init_repo(tmp_path)
    deploy = repo / "scripts" / "deploy"
    shutil.copy2(_TOOL_PATH, deploy / "script_version_guard.py")
    marker_file = tmp_path / "RAN"
    (deploy / "host-release.sh").write_text(
        "#!/usr/bin/env bash\n"
        + " ".join(tool.REQUIRED_MARKERS)
        + f"\ntouch {marker_file}\n",
        encoding="utf-8",
    )
    shutil.copy2(_RUN_RELEASE, deploy / "run_release.sh")
    _commit_all(repo, "side effect")

    res = _run_release(repo, "--verify-only", "HEAD")
    assert res.returncode == 0, res.stderr + res.stdout
    assert not marker_file.exists(), "--verify-only hedef betigi calistirmamali"


# ---------------------------------------------------------------------------
# host-release.sh kablolamasi — kapi betikte GERCEKTEN ve DOGRU YERDE mi?
# ---------------------------------------------------------------------------
def _host_src() -> str:
    return _HOST_RELEASE.read_text(encoding="utf-8")


def test_host_release_verifies_its_own_blob_against_target():
    src = _host_src()
    assert "git hash-object -- \"$SELF_FILE\"" in src
    assert '"$TARGET_FULL:$HOST_RELEASE_REL"' in src
    assert '"$SELF_BLOB" != "$TARGET_SCRIPT_BLOB"' in src


def test_host_release_script_guard_runs_before_any_mutation():
    """Surum kontrolu cutover'dan, adaciktan ve reset'ten ONCE kosmali."""
    src = _host_src()
    guard = src.index('"$SELF_BLOB" != "$TARGET_SCRIPT_BLOB"')
    assert guard < src.index('git reset --hard "$TARGET_FULL"')
    assert guard < src.index('docker run -d --name "$CANDIDATE_NAME"')
    assert guard < src.index('log "cutover: compose up -d --force-recreate')


def test_host_release_script_guard_exits_nonzero():
    """Uyusmazlik 'uyari' degil, sifir OLMAYAN cikis kodu olmali."""
    src = _host_src()
    marker = src.index('if [ "$SELF_BLOB" != "$TARGET_SCRIPT_BLOB" ]; then')
    body = src[marker:].split("\n")[1]
    assert "die_code 9" in body


def test_host_release_requires_security_markers_in_itself():
    src = _host_src()
    assert 'for marker in persistence_flag_guard.py --require-explicit-false persist_flag_effective' in src
    assert 'grep -q -- "$marker" "$SELF_FILE"' in src


def test_host_release_records_script_identity_in_release_json():
    src = _host_src()
    assert '"deploy_script": {"path": "$HOST_RELEASE_REL", "blob": "$SELF_BLOB"' in src


def test_host_release_has_no_working_tree_fallback_for_the_persistence_guard():
    """Calisma agacindaki kopya denetlenen kod DEGILDIR: yedek yol kaldirildi."""
    src = _host_src()
    assert "persistence_flag_guard.py hedef commit'te yok; calisma agacindaki kopya kullaniliyor" not in src
    assert "PERSIST_GUARD_BLOB" in src
