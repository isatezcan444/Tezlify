"""Mesaj kimlik filigrani: "eski kayit kayboldu mu?" — toplam sayim yetmez.

Kritik senaryo
--------------
Canli hatta deploy penceresi boyunca yeni mesaj gelir. 9 mesaj silinip 9 yeni
mesaj gelirse `count(*)` **degismez**. Toplam sayiya bakan bir kapi bunu
gormez; 2026-10-27'de baz 729 iken dagitim oncesi 753'tu, yani sismе gercekti.

Filigran `max(id)` esigini kullanir: yeni mesajlar esigin USTUNDE dogar ve
sayima girmez, silinen eski mesaj ise kesinlikle gorunur.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from scripts.deploy.message_watermark import loss_line, parse_count, parse_watermark

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "scripts" / "deploy" / "message_watermark.py"


class TestNoLoss:
    def test_all_old_messages_survive(self):
        # 753 mesaj vardi, hepsi duruyor.
        assert loss_line("159998|753", "753") is None

    def test_new_messages_arriving_do_not_register_as_loss(self):
        # 40 yeni mesaj geldi, eski 753'un tamami duruyor.
        assert loss_line("159998|753", "753") is None

    def test_survivors_exceeding_expected_is_not_loss(self):
        # Esik altinda fazla mesaj olmasi (or. id geri kullanimi) kayip degil.
        assert loss_line("159998|753", "760") is None


class TestLossDetection:
    def test_one_old_message_missing_is_detected(self):
        assert loss_line("159998|753", "752") == "messages:753->752 (id<=159998)"

    def test_the_netting_case_total_count_unchanged(self):
        """9 silindi + 9 geldi: toplam AYNI, ama kayip VAR.

        Bu, kapinin eski halinde gorunmeyen senaryodur. Filigran yakalar
        cunku esik altindaki sayi 753 -> 744 dustu.
        """
        before_total, after_total = 753, 753
        assert before_total == after_total, "senaryo geregi toplam degismedi"
        assert loss_line(f"159998|{before_total}", "744") == "messages:753->744 (id<=159998)"

    def test_the_netting_case_total_count_grows(self):
        """9 silindi + 40 geldi: TOPLAM 753 -> 784 (ARTTI), kayip yine gorunur.

        `after` parametresi TOPLAM degil, esik ALTINDA hayatta kalan sayidir.
        Toplam 784 olsa bile esik altinda 744 kaldi — toplam sayiya bakan kapi
        "her sey yolunda" derdi.
        """
        total_after = 784
        survivors = 744
        assert total_after > 753, "toplam sayim kaybi gizlerdi"
        assert loss_line("159998|753", str(survivors)) == "messages:753->744 (id<=159998)"

    def test_whole_conversation_wipe_is_detected(self):
        # 2026-10-27'de olan: 1 sohbet + 9 mesaj.
        assert loss_line("159998|753", "744") is not None


class TestNoDecision:
    @pytest.mark.parametrize("bad", ["unavailable", "", "abc", "1|2|3", "-1|5"])
    def test_unmeasurable_watermark_makes_no_decision(self, bad):
        # Olcum yoksa "kayip var" demek yanlis pozitif olurdu; sessizce gecilir.
        assert loss_line(bad, "100") is None

    @pytest.mark.parametrize("bad", ["unavailable", "", "x", "-3"])
    def test_unmeasurable_count_makes_no_decision(self, bad):
        assert loss_line("100|50", bad) is None


class TestParsing:
    def test_watermark_roundtrip(self):
        assert parse_watermark("159998|753") == (159998, 753)

    def test_count_roundtrip(self):
        assert parse_count("753") == 753

    def test_whitespace_is_tolerated(self):
        # psql `-t -A` ciktisi satir sonu tasir.
        assert parse_watermark(" 159998|753\n") == (159998, 753)
        assert parse_count(" 753\n") == 753


class TestCliContract:
    """Bash bu betigi cagirir: cikis kodlari sozlesmedir."""

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(CLI), *args], capture_output=True, text=True
        )

    def test_no_loss_exits_zero_with_empty_output(self):
        proc = self._run("159998|753", "753")
        assert proc.returncode == 0
        assert proc.stdout.strip() == ""

    def test_loss_exits_four_with_evidence_line(self):
        proc = self._run("159998|753", "744")
        assert proc.returncode == 4
        assert "messages:753->744 (id<=159998)" in proc.stdout

    def test_unavailable_is_silent_success(self):
        proc = self._run("unavailable", "unavailable")
        assert proc.returncode == 0
        assert proc.stdout.strip() == ""

    def test_malformed_input_is_not_silently_ignored(self):
        # "olcum yok" ile "bozuk girdi" ayri: ikincisi stderr'e yazilir.
        proc = self._run("1|2|3", "10")
        assert proc.returncode == 2
        assert "bozuk" in proc.stderr

    def test_wrong_arity_is_usage_error(self):
        assert self._run("159998|753").returncode == 2
