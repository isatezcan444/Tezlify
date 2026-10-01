"""Telefon ölçüm aracının HÜKÜM mantığı yanlış olamaz.

Bu araç, "rozet düştü / sohbet telefondan gitti" iddialarının kanıtını yazan
şeydir. Hüküm mantığı yanlış olursa, ölçüm sessizce yalan söyler — bu yüzden
mantık saf tutuldu ve burada çivilendi:

- azalma **0'a** inmeli (azalma tek başına rozetin temizlendiğini göstermez),
- değişmemek ve ARtmak KALDI'dır (artan sayaç bir okuma değildir),
- gateway kanıtı okunamadıysa hüküm KANIT-EKSIK'tir: "başarısız" ile "iddia
  doğrulanamadı" ayrı şeylerdir ve karıştırılmaları ölçümü değersiz kılar,
- silme ölçümünde satırın yok olması beklenen sonuçtur,
- log kanıtı VERİLMEZSE hüküm KANIT-EKSIK'tir: ölçümün yarısı toplanmadan
  "geçti" denmez (log kanıtı zorunlu ama kendi başına yeterli değil).
"""
import json
import subprocess

from scripts.diagnostics.whatsapp_handset_measure import capture_logs, diff_snapshots


def _logs(*, gw_delete_error=0, gw_warn=0, gw_read_error=0, backend_true=0, backend_false=0, persist=0):
    """Ölçüm penceresinin log kanıtı (gerçek `--capture-logs` çıktısının şekli)."""
    def _m(count):
        return {"count": count, "samples": []}

    return {
        "mode": "logs",
        "sources": {
            "gateway": {
                "available": True,
                "matches": {
                    "delete_provider_error": _m(gw_delete_error),
                    "chat_update_parse_warning": _m(gw_warn),
                    "read_error": _m(gw_read_error),
                },
            },
            "backend": {
                "available": True,
                "matches": {
                    "delete_reported_remote_true": _m(backend_true),
                    "delete_reported_remote_false": _m(backend_false),
                    "event_persist_failure": _m(persist),
                },
            },
        },
    }


def _snap(*, unread=3, count=10, gw=3, exists=True, measurement="badge", logs=None):
    return {
        "mode": "snapshot",
        "measurement": measurement,
        "exists": exists,
        "unread_count": unread,
        "message_count": count,
        "gateway_cache": {"unread_count": gw},
        "logs": logs if logs is not None else _logs(),
    }


def _by_name(result):
    return {c["check"]: c["passed"] for c in result["checks"]}


def test_a_phone_read_reaching_zero_is_the_pass():
    result = diff_snapshots(_snap(unread=3, gw=3), _snap(unread=0, gw=0))
    assert result["verdict"] == "GECTI"
    assert _by_name(result)["db_unread_dropped"] is True
    assert _by_name(result)["db_unread_reached_zero"] is True


def test_without_log_evidence_the_claim_is_not_confirmed():
    """DB düştü ama log kanıtı toplanmadı: "geçti" değil, "doğrulanamadı"."""
    before = _snap(unread=3, gw=3, logs={})
    after = _snap(unread=0, gw=0, logs={})
    before["logs"] = None
    after["logs"] = None
    result = diff_snapshots(before, after)
    assert result["verdict"] == "KANIT-EKSIK"
    assert _by_name(result)["log_evidence"] is None


def test_a_gateway_parse_warning_fails_the_badge_measurement():
    """Okuma yolunda ayrıştırma uyarısı varken rozet ölçümü geçemez."""
    logs = _logs(gw_warn=2)
    result = diff_snapshots(
        _snap(unread=3, logs=logs), _snap(unread=0, logs=logs)
    )
    assert result["verdict"] == "KALDI"
    assert _by_name(result)["gateway_unread_warning_absent"] is False


def test_a_read_error_alone_also_fails_the_badge_measurement():
    logs = _logs(gw_read_error=1)
    result = diff_snapshots(_snap(unread=3, logs=logs), _snap(unread=0, logs=logs))
    assert result["verdict"] == "KALDI"
    assert _by_name(result)["gateway_unread_warning_absent"] is False


def test_a_deleted_chat_needs_backends_own_remote_true_report():
    result = diff_snapshots(
        _snap(measurement="delete", logs=_logs(backend_true=1)),
        _snap(exists=False, measurement="delete", logs=_logs(backend_true=1)),
    )
    assert result["verdict"] == "GECTI"
    assert _by_name(result)["backend_reported_remote_true"] is True
    assert _by_name(result)["gateway_delete_error_absent"] is True


def test_a_delete_that_whatsapp_refused_is_not_a_pass():
    """Yerel satır yok ama sağlayıcı reddetti: `remote=False` yakalanmalı."""
    result = diff_snapshots(
        _snap(measurement="delete", logs=_logs(backend_false=1, gw_delete_error=1)),
        _snap(exists=False, measurement="delete", logs=_logs(backend_false=1, gw_delete_error=1)),
    )
    assert result["verdict"] == "KALDI"
    assert _by_name(result)["backend_reported_remote_true"] is False
    assert _by_name(result)["gateway_delete_error_absent"] is False


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
    result = diff_snapshots(
        _snap(measurement="delete", logs=_logs(backend_true=1)),
        _snap(exists=False, measurement="delete", logs=_logs(backend_true=1)),
    )
    assert result["verdict"] == "GECTI"
    assert _by_name(result)["conversation_removed"] is True


def test_capture_logs_structures_the_window_and_keeps_samples(monkeypatch):
    """Log satırları yapılandırılmış kanıta çevrilir; örnek satır saklanır."""
    def _fake_run(cmd, **_kw):
        if "tezlify-gateway" in cmd:
            out = (
                '{"level":30,"msg":"Delete conversation provider error"}\n'
                '{"level":30,"msg":"chats.update lastMessage sentezlenemedi"}\n'
                "{\"level\":30,\"msg\":\"unrelated line\"}\n"
            )
        else:
            out = (
                "Sohbet silindi (conv=42, messages=3, reactions=0, remote=True)\n"
                "Sohbet uzaktan silinemedi (conv=43): NO_REMOTE_IDENTITY\n"
            )
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")

    monkeypatch.setattr(subprocess, "run", _fake_run)

    logs = capture_logs(since="15m")

    gw = logs["sources"]["gateway"]["matches"]
    be = logs["sources"]["backend"]["matches"]
    assert gw["delete_provider_error"]["count"] == 1
    assert "provider error" in gw["delete_provider_error"]["samples"][0]
    assert gw["chat_update_parse_warning"]["count"] == 1
    assert gw["read_error"]["count"] == 0
    assert be["delete_reported_remote_true"]["count"] == 1
    assert be["delete_reported_remote_false"]["count"] == 0
    assert be["delete_remote_failed"]["count"] == 1


def test_capture_logs_never_invents_evidence_when_docker_is_missing(monkeypatch):
    def _boom(cmd, **_kw):
        raise FileNotFoundError("docker yok")

    monkeypatch.setattr(subprocess, "run", _boom)

    logs = capture_logs(since="15m")

    for source in ("gateway", "backend"):
        entry = logs["sources"][source]
        assert entry["available"] is False
        assert "docker yok" in entry["error"]
        assert entry["matches"] == {}
    assert json.loads(json.dumps(logs))["mode"] == "logs"


def test_messages_must_not_change_when_a_chat_is_read():
    result = diff_snapshots(_snap(count=10), _snap(count=9))
    assert result["verdict"] == "KALDI"
    assert _by_name(result)["message_count_unchanged"] is False


def test_without_a_before_snapshot_no_verdict_is_claimed():
    result = diff_snapshots(_snap(exists=False), _snap())
    assert result["verdict"] == "KANIT-EKSIK"
    assert result["checks"] == []
