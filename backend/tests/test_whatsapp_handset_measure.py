"""Telefon ölçüm aracının HÜKÜM mantığı yanlış olamaz.

Bu araç, "rozet düştü / sohbet telefondan gitti" iddialarının kanıtını yazan
şeydir. Hüküm mantığı yanlış olursa, ölçüm sessizce yalan söyler — bu yüzden
mantık saf tutuldu ve burada çivilendi:

- azalma **0'a** inmeli (azalma tek başına rozetin temizlendiğini göstermez),
- değişmemek ve ARtmak KALDI'dır (artan sayaç bir okuma değildir),
- gateway kanıtı okunamadıysa hüküm KANIT-EKSIK'tir: "başarısız" ile "iddia
  doğrulanamadı" ayrı şeylerdir ve karıştırılmaları ölçümü değersiz kılar,
- silme ölçümünde satırın yok olması beklenen sonuçtur.
"""
from scripts.diagnostics.whatsapp_handset_measure import diff_snapshots


def _snap(*, unread=3, count=10, gw=3, exists=True):
    return {
        "mode": "snapshot",
        "exists": exists,
        "unread_count": unread,
        "message_count": count,
        "gateway_cache": {"unread_count": gw},
    }


def _by_name(result):
    return {c["check"]: c["passed"] for c in result["checks"]}


def test_a_phone_read_reaching_zero_is_the_pass():
    result = diff_snapshots(_snap(unread=3, gw=3), _snap(unread=0, gw=0))
    assert result["verdict"] == "GECTI"
    assert _by_name(result)["db_unread_dropped"] is True
    assert _by_name(result)["db_unread_reached_zero"] is True


def test_a_partial_drop_is_not_a_pass():
    """3 → 1 rozeti temizlemez; ölçüm "düştü" diye geçemez."""
    result = diff_snapshots(_snap(unread=3), _snap(unread=1))
    assert result["verdict"] == "KALDI"
    assert _by_name(result)["db_unread_dropped"] is True
    assert _by_name(result)["db_unread_reached_zero"] is False


def test_an_unchanged_counter_reports_inaction_not_success():
    result = diff_snapshots(_snap(unread=2), _snap(unread=2))
    assert result["verdict"] == "KALDI"
    assert "değişmedi" in next(
        c["detail"] for c in result["checks"] if c["check"] == "db_unread_dropped"
    )


def test_a_rising_counter_is_a_failure_not_a_read():
    result = diff_snapshots(_snap(unread=1), _snap(unread=4))
    assert result["verdict"] == "KALDI"
    assert _by_name(result)["db_unread_dropped"] is False


def test_missing_gateway_evidence_is_not_a_failure_but_is_not_a_pass():
    before = _snap(unread=3)
    after = _snap(unread=0)
    before["gateway_cache"] = {"error": "erisilemedi"}
    after["gateway_cache"] = {"error": "erisilemedi"}
    result = diff_snapshots(before, after)
    assert result["verdict"] == "KANIT-EKSIK"
    assert _by_name(result)["db_unread_dropped"] is True


def test_a_deleted_conversation_is_the_expected_delete_outcome():
    result = diff_snapshots(_snap(), _snap(exists=False))
    assert result["verdict"] == "GECTI"
    assert _by_name(result)["conversation_removed"] is True


def test_messages_must_not_change_when_a_chat_is_read():
    result = diff_snapshots(_snap(count=10), _snap(count=9))
    assert result["verdict"] == "KALDI"
    assert _by_name(result)["message_count_unchanged"] is False


def test_without_a_before_snapshot_no_verdict_is_claimed():
    result = diff_snapshots(_snap(exists=False), _snap())
    assert result["verdict"] == "KANIT-EKSIK"
    assert result["checks"] == []
