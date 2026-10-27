"""Adacik container'inin uretim DB'sinden IZOLE edildigini civileyen kapilar.

Neden gerekli (2026-10-27)
--------------------------
`host-release.sh`, "aday saglikli mi" diye boot ettigi container'a canli
container'in ortamini **oldugu gibi** veriyordu; `DATABASE_URL` uretim
veritabanini gosteriyordu. Yani her deploy, startup migration zincirinin
tamamini uretim verisi uzerinde kosuyordu ve kapilar bunu ancak SONRADAN
tespit ediyordu. O gun 1 sohbet + 9 mesaj tam olarak bu pencerede silindi.

Bu dosya iki seviyeyi ayri ayri civiLer:

1. **Birim** — `candidate_db_url.py` yalnizca veritabani adini degistirir;
   parola/host/port/sorgu/surucu oneki korunur. Parola icinde `/` veya `@`
   gecmesi (regex yaklasimini bozan durum) burada kapsanir.
2. **Betik sozlesmesi** — `host-release.sh` izolasyonu *kanitlayamazsa*
   deploy etmeyi REDDEDER; uretim adi env'de kalirsa `die` eder; `die` ve
   hata yolu izole DB'yi temizler.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from scripts.deploy.candidate_db_url import (
    InvalidDatabaseName,
    isolated_url,
    rewrite_env_file,
)

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "deploy" / "host-release.sh"

PROD = "postgresql+asyncpg://tezlify:s3cr3t@db:5432/tezlify"
CAND = "tezlify_cand_20261028T000000Z"


class TestUrlRewrite:
    def test_only_the_database_name_changes(self):
        out = isolated_url(PROD, CAND)
        assert out == "postgresql+asyncpg://tezlify:s3cr3t@db:5432/" + CAND

    def test_driver_prefix_survives(self):
        # `postgresql+asyncpg` kaybolursa SQLAlchemy senkron surucuye duser.
        assert isolated_url(PROD, CAND).startswith("postgresql+asyncpg://")

    def test_query_string_is_preserved(self):
        # `?ssl=require` gibi parametreler izolasyon kopyasinda da gecerli
        # olmali; dusurulseydi adacik baglanamaz ve "sagliksiz" gorunurdu.
        out = isolated_url(PROD + "?ssl=require&pool=5", CAND)
        assert out.endswith("/" + CAND + "?ssl=require&pool=5")

    def test_password_containing_at_sign_is_preserved(self):
        # `@` parolada yasal ve yaygin; ayristirici netloc'u SON `@`den boler.
        # Regex yaklasimi burada yanlis parcayi degistirebilirdi.
        url = "postgresql+asyncpg://tezlify:p@ss@db:5432/tezlify"
        out = isolated_url(url, CAND)
        assert out == "postgresql+asyncpg://tezlify:p@ss@db:5432/" + CAND
        assert "p@ss" in out

    def test_percent_encoded_password_survives(self):
        # `/` bir parolada ANCAK `%2F` olarak gecebilir (netloc'u `/` bitirir),
        # bu yuzden gercekci risk bu bicimdir: kodlanmis parola bozulmamali.
        url = "postgresql+asyncpg://tezlify:p%2Fss%40w@db:5432/tezlify"
        out = isolated_url(url, CAND)
        assert out == "postgresql+asyncpg://tezlify:p%2Fss%40w@db:5432/" + CAND

    def test_ipv6_host_is_preserved(self):
        url = "postgresql+asyncpg://tezlify:pw@[::1]:5432/tezlify"
        assert isolated_url(url, CAND) == "postgresql+asyncpg://tezlify:pw@[::1]:5432/" + CAND

    @pytest.mark.parametrize("bad", ["", "tezlify cand", "1abc", "a" * 64, "tezlify;drop"])
    def test_invalid_database_names_are_rejected(self, bad):
        # Ad, DROP/CREATE icinde kullaniliyor: tirnak/; kabul edilmemeli.
        with pytest.raises(InvalidDatabaseName):
            isolated_url(PROD, bad)


class TestEnvFileRewrite:
    def test_rewrites_in_place_and_leaves_other_lines_alone(self, tmp_path):
        env = tmp_path / "candidate-env"
        env.write_text(
            "PORT=8001\nDATABASE_URL=" + PROD + "\nSKIP_JOB_RECOVERY=true\n",
            encoding="utf-8",
        )
        rewrite_env_file(str(env), CAND)
        lines = env.read_text(encoding="utf-8").splitlines()
        assert "PORT=8001" in lines
        assert "SKIP_JOB_RECOVERY=true" in lines
        assert "DATABASE_URL=postgresql+asyncpg://tezlify:s3cr3t@db:5432/" + CAND in lines

    def test_quoted_values_are_unquoted_not_propagated(self, tmp_path):
        # `.env.production` tirnakli deger tasiyor; tirnak korunursa SQLAlchemy
        # URL'i parse edemez (2026-10-27'de bir kez yasandi).
        env = tmp_path / "candidate-env"
        env.write_text('DATABASE_URL="' + PROD + '"\n', encoding="utf-8")
        rewrite_env_file(str(env), CAND)
        value = env.read_text(encoding="utf-8").strip().split("=", 1)[1]
        assert not value.startswith('"')

    def test_missing_database_url_is_an_error_not_a_silent_pass(self, tmp_path):
        env = tmp_path / "candidate-env"
        env.write_text("PORT=8001\n", encoding="utf-8")
        with pytest.raises(KeyError):
            rewrite_env_file(str(env), CAND)

    def test_production_name_is_absent_after_rewrite(self, tmp_path):
        # "Uretim DB'sine yazma yetkisi yok" iddiasinin dogrudan kaniti.
        env = tmp_path / "candidate-env"
        env.write_text("DATABASE_URL=" + PROD + "\n", encoding="utf-8")
        rewrite_env_file(str(env), CAND)
        text = env.read_text(encoding="utf-8")
        assert re.search(r"/(tezlify)(\?|$)", text) is None
        assert "/" + CAND in text


@pytest.fixture(scope="module")
def script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


class TestScriptContract:
    """Betik metni uzerinden sozlesme — bash'i calistirmadan dogrulanabilir."""

    def test_script_is_syntactically_valid(self):
        proc = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
        assert proc.returncode == 0, proc.stderr

    def test_candidate_env_is_isolated_before_the_container_starts(self, script):
        # Sira onemli: env cevrilmeden `docker run` cagrilirsa adacik uretime
        # baglanir. Bu yuzden indeks karsilastirmasi yapiliyor.
        isolate_at = script.index("candidate_env_isolate \"$CANDIDATE_ENV_FILE\"")
        run_at = script.index('docker run -d --name "$CANDIDATE_NAME"')
        assert isolate_at < run_at

    def test_isolated_db_is_created_from_production_as_source(self, script):
        assert 'candidate_db_create "$CANDIDATE_DB" "$DB_NAME"' in script

    def test_deploy_is_refused_when_isolation_cannot_be_proven(self, script):
        assert "adacik izolasyonu KANITLANAMAZ" in script

    def test_production_url_left_in_env_is_fatal(self, script):
        assert 'grep -Eq "DATABASE_URL=.*/${DB_NAME}' in script

    def test_production_drop_is_fatal_even_with_allow_migrations(self, script):
        # Adacik izole oldugu icin uretimde dusus artik onaylanmis migration
        # degil, izolasyon ihlalidir: `--allow-migrations` bunu gecemez.
        block = script[script.index("if [ -n \"$CANDIDATE_DROPS\" ]"):]
        block = block[: block.index("\nfi\n")]
        assert "izolasyonu kanitlanamadi" in block
        assert "ALLOW_MIGRATIONS" not in block

    def test_cleanup_runs_on_both_error_paths(self, script):
        # `die` -> exit: ERR tuzagi tetiklenmez, bu yuzden die icinde de var.
        die_block = script[script.index("die() {"):]
        die_block = die_block[: die_block.index("\n}")]
        assert "candidate_db_drop" in die_block
        on_error_block = script[script.index("on_error() {"):]
        on_error_block = on_error_block[: on_error_block.index("\n}")]
        assert "candidate_db_drop" in on_error_block

    def test_clone_is_dropped_before_cutover(self, script):
        drop_at = script.index('candidate_db_drop "$CANDIDATE_DB"\nCANDIDATE_DB=""')
        cutover_at = script.index("# 4. CUTOVER")
        assert drop_at < cutover_at

    def test_existing_gates_are_still_present(self, script):
        # Bu degisiklik eski kapilari KALDIRMAMALI.
        for needle in (
            "counts_dropped",
            "messages_lost_since",
            "schema_fingerprint",
            "MIGRATION_GUARD_RESULT",
            '"counts_after_cutover"',
        ):
            assert needle in script, f"eski kapi kayboldu: {needle}"
